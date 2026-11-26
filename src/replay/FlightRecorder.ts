// Grabación continua del vuelo para la repetición (src/replay/Replay.ts) y la traza (trackExport.ts).
//
// - Aparato: una muestra cada 1/30 s (y en los cambios que importan: toma, despegue, accidente) en
//   bloques de 1 min que se reutilizan en anillo: se guardan los últimos 20 min (~9 MB como mucho).
//   La posición va en ECEF (Float64: sobrevive a los re-centrados del origen flotante, World.rebase)
//   y la orientación y los vectores, en ejes ECEF (Float32); lo demás, tal cual: mandos, vueltas,
//   cabeza del rotor, luces, instrumentos, motor, sonido.
// - Avisos del HUD: solo cuando cambian (pista de textos).
// - Sucesos: despegue, toma, accidente.
// - Accidente: la postura de cada pieza de los restos (src/aircraft/WreckModel.ts) y de cada cascote
//   de Rapier, solo cuando se mueve (las que están quietas no gastan), hasta que todo se para.
// - Efectos (polvo, terrones, chispas, fuego, surcos; chapoteos, rociones, espuma y estelas en el agua):
//   las llamadas a sus emisores, con sus argumentos, para volver a lanzarlas en la repetición sobre
//   unos efectos propios (`tapEmitters`). Igual los sonidos del accidente (golpes, roturas, fuego).

import { Matrix4, Quaternion, Vector3, type Color } from 'three'

/** muestras por segundo del aparato */
export const REC_RATE = 30
/** muestras por bloque (1 min) y bloques del anillo (20 min) */
const CHUNK = REC_RATE * 60
const MAX_CHUNKS = 20

/** Canales Float32 de cada muestra (orden fijo). */
export const C = {
  // orientación (ejes ECEF) y vectores en ejes ECEF
  qx: 0, qy: 1, qz: 2, qw: 3,
  vx: 4, vy: 5, vz: 6,
  nx: 7, ny: 8, nz: 9,
  wx: 10, wy: 11, wz: 12,
  // velocidad angular (ejes cuerpo)
  ox: 13, oy: 14, oz: 15,
  // rotor, cabeza, mandos de vuelo de la vista
  rotorOmega: 16, headPitch: 17, headRoll: 18, rudder: 19, noseSteer: 20, engineRpm: 21, gearPos: 22,
  cgx: 23, cgy: 24, cgz: 25, hbx: 26, hby: 27, hbz: 28,
  pitch: 29, roll: 30, yaw: 31, throttle: 32, brake: 33, trim: 34,
  // instrumentos (lo que pintó el HUD)
  ias: 35, altFt: 36, vsFpm: 37, agl: 38, gs: 39, g: 40, slip: 41, beta: 42, hdg: 43,
  windFrom: 44, windKt: 45, fuel: 46, fuelL: 47,
  // sonido
  power: 48, thrust: 49, tas: 50, rolling: 51, teeter: 52, rough: 53, firing: 54,
  flags: 55,
} as const
export const NF = 56
/** canales Float64: tiempo de grabación, fecha simulada (ms) y posición ECEF */
export const D = { t: 0, sim: 1, px: 2, py: 3, pz: 4 } as const
export const ND = 5

/** bits de `C.flags` */
export const FL = {
  ground: 1,
  prerot: 2,
  lights: 4,
  rotorBrake: 8,
  parkBrake: 16,
  engineOn: 32,
  fuelLow: 64,
  oilLow: 128,
  drill: 256,
  gearDown: 512,
  gearUp: 1024,
  /** ya son los restos del accidente */
  wreck: 2048,
  water: 4096,
  hasFuel: 8192,
  hasGear: 16384,
} as const

export type RecEventKind = 'takeoff' | 'touchdown' | 'crash'
export interface RecEvent {
  t: number
  kind: RecEventKind
  /** en la toma: velocidad vertical (ft/min) y respecto al suelo (km/h) */
  vs?: number
  gs?: number
  water?: boolean
}

interface TextCue {
  t: number
  warnings: string[]
  cautions: string[]
}

/** Trayectoria de un sólido de los restos (marco local del accidente: respecto a `origin`). */
export interface BodyTrack {
  t: number[]
  /** 7 por muestra: x, y, z, qx, qy, qz, qw */
  d: number[]
  born: number
  gone: number
  /** última vez que se vio sin moverse desde la última muestra guardada */
  stillT: number
  seen: number
  size?: Vector3
  color?: number
  glass?: boolean
}

export interface CrashRec {
  t0: number
  /** origen del marco del accidente (mundo) y marco del mundo de entonces */
  origin: Vector3
  epoch: number
  wind: Vector3
  parts: Map<string, BodyTrack>
  chunks: Map<object, BodyTrack>
  lastT: number
  frame: number
}

/**
 * Tipo de cada argumento de un emisor: punto, vector, color, altura (relativa al punto 0), distancia a la
 * cámara (en la repetición, la de su cámara) o tal cual.
 */
type ArgKind = 'p' | 'v' | 'c' | 'y' | 'd' | 'n'
export type FxTarget = 'crash' | 'water' | 'audio'
export interface FxEvent {
  t: number
  target: FxTarget
  fn: string
  args: unknown[]
  epoch: number
}

/** Emisores de CrashFx y WaterFx que se graban, con el tipo de sus argumentos. */
export const FX_EMITTERS: Record<FxTarget, Record<string, ArgKind[]>> = {
  crash: {
    dustBurst: ['p', 'v', 'n', 'c', 'v'],
    dirt: ['p', 'v', 'v', 'n', 'n', 'y'],
    leaves: ['p', 'v', 'n', 'n'],
    sparksAt: ['p', 'v', 'n'],
    explode: ['p'],
    burn: ['p', 'n', 'n', 'v'],
    scar: ['n', 'p', 'v', 'v', 'n', 'n', 'n'],
  },
  water: {
    foam: ['p', 'n', 'n', 'n', 'n', 'n'],
    splash: ['p', 'v', 'n', 'n'],
    spray: ['p', 'v', 'n', 'n'],
    wake: ['n', 'p', 'v', 'n'],
    bubbles: ['p', 'n', 'n'],
    downwash: ['p', 'n', 'n', 'n'],
  },
  audio: {
    crash: ['n', 'd'],
    explosion: ['d'],
    impact: ['n', 'n', 'd', 'n'],
    snap: ['n', 'd', 'n'],
    setScrape: ['n', 'n', 'd', 'n'],
    setTumble: ['n', 'd'],
    setFire: ['n', 'd'],
  },
}
/** sonidos continuos (se fijan cada fotograma): se guarda como mucho uno cada 1/20 s */
const CONTINUOUS = new Set(['setScrape', 'setTumble', 'setFire'])
/** argumento con el paso de tiempo (los emisores continuos: se juntan para no guardar uno por fotograma) */
const DT_ARG: Record<string, number> = { burn: 2, spray: 3, bubbles: 2, downwash: 3 }
/** como mucho, sucesos de efectos guardados (los más viejos se tiran) */
const MAX_FX = 60000

export class FlightRecorder {
  private f: Float32Array[] = []
  private d: Float64Array[] = []
  /** índices globales de la muestra más vieja y de la siguiente que se escriba */
  start = 0
  end = 0
  /** reloj de grabación (s): solo avanza mientras se graba */
  clock = 0
  private acc = 0
  readonly events: RecEvent[] = []
  readonly texts: TextCue[] = []
  readonly fx: FxEvent[] = []
  private pendingFx: FxEvent[] = []
  crash: CrashRec | null = null
  /** marcos del mundo (worldToECEF) en los que hay efectos o restos guardados */
  readonly epochs: Matrix4[] = []
  private epochKey = ''
  /** ya no se graba (todo parado tras el accidente) */
  frozen = false
  /** metros que el datum vertical del mundo está por encima del nivel del mar (Google: el geoide) */
  datumShift = 0
  // detección de despegue y toma
  private contact = false
  private contactT = 0
  private changeT = 0
  private airborneSince = 0
  private lastText = ''
  /** coste medio de grabar (ms por fotograma) */
  costMs = 0
  /** dentro de un emisor enganchado (lo que llame él, de cualquier sistema, no se graba aparte) */
  private tapDepth = 0
  private readonly wakeLast = new Map<string, { x: number; z: number; t: number }>()

  get count(): number {
    return this.end - this.start
  }
  get t0(): number {
    return this.count ? this.time(this.start) : 0
  }
  get t1(): number {
    return this.count ? this.time(this.end - 1) : 0
  }

  reset(): void {
    this.start = this.end = 0
    this.clock = 0
    this.acc = 0
    this.events.length = 0
    this.texts.length = 0
    this.fx.length = 0
    this.pendingFx.length = 0
    this.crash = null
    this.epochs.length = 0
    this.epochKey = ''
    this.frozen = false
    this.lastText = ''
    this.contactT = this.changeT = this.airborneSince = 0
    this.wakeLast.clear()
  }

  /** Memoria ocupada (bytes) por las muestras del aparato. */
  get bytes(): number {
    let b = 0
    for (const a of this.f) b += a.byteLength
    for (const a of this.d) b += a.byteLength
    return b
  }

  // ---------------------------------------------------------------------------
  // Acceso a las muestras
  // ---------------------------------------------------------------------------
  /** Canales Float32 de la muestra `i` (índice global) y su desplazamiento. */
  row(i: number): [Float32Array, number] {
    return [this.f[Math.floor(i / CHUNK) % MAX_CHUNKS], (i % CHUNK) * NF]
  }
  drow(i: number): [Float64Array, number] {
    return [this.d[Math.floor(i / CHUNK) % MAX_CHUNKS], (i % CHUNK) * ND]
  }
  time(i: number): number {
    const [a, o] = this.drow(i)
    return a[o]
  }
  /** Última muestra con t ≤ T (índice global), dentro de la grabación. */
  find(T: number): number {
    let lo = this.start
    let hi = this.end - 1
    if (hi < lo) return -1
    if (T <= this.time(lo)) return lo
    if (T >= this.time(hi)) return hi
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (this.time(mid) <= T) lo = mid
      else hi = mid
    }
    return lo
  }

  /** Índice de marco del mundo actual (para los efectos y los restos). */
  epochOf(worldToECEF: Matrix4): number {
    const e = worldToECEF.elements
    const key = `${e[12]}|${e[13]}|${e[14]}|${e[0]}|${e[2]}`
    if (key !== this.epochKey) {
      this.epochKey = key
      this.epochs.push(worldToECEF.clone())
    }
    return this.epochs.length - 1
  }

  // ---------------------------------------------------------------------------
  // Grabación
  // ---------------------------------------------------------------------------
  /**
   * Avanza el reloj y dice si toca guardar muestra este fotograma (`force`: un cambio que importa).
   * Los efectos lanzados en el fotograma se quedan con este instante.
   */
  tick(dt: number, force: boolean): boolean {
    this.clock += dt
    this.acc += dt
    for (const e of this.pendingFx) {
      e.t = this.clock
      this.fx.push(e)
    }
    this.pendingFx.length = 0
    if (this.fx.length > MAX_FX) this.fx.splice(0, this.fx.length - MAX_FX)
    const period = 1 / REC_RATE
    if (!force && this.acc < period - 1e-4 && this.count > 0) return false
    // (se guarda el sobrante: 30 muestras por segundo de media con cualquier ritmo de fotogramas)
    this.acc = Math.min(Math.max(0, this.acc - period), period)
    return true
  }

  /** Descarta los efectos del fotograma (no se grababa). */
  dropPending(): void {
    this.pendingFx.length = 0
  }

  /** Guarda una muestra: `row` (NF canales) y `drow` (ND canales; el tiempo lo pone aquí). */
  push(row: Float32Array, drow: Float64Array): void {
    const i = this.end
    const c = Math.floor(i / CHUNK) % MAX_CHUNKS
    const o = i % CHUNK
    if (o === 0) {
      if (!this.f[c]) {
        this.f[c] = new Float32Array(CHUNK * NF)
        this.d[c] = new Float64Array(CHUNK * ND)
      }
      // el bloque que se reutiliza tenía las muestras más viejas
      this.start = Math.max(this.start, i - MAX_CHUNKS * CHUNK + CHUNK)
    }
    drow[D.t] = this.clock
    this.f[c].set(row, o * NF)
    this.d[c].set(drow, o * ND)
    this.end = i + 1
    // lo que ya no está en la grabación
    const t0 = this.t0
    if (o === 0) {
      while (this.events.length && this.events[0].t < t0) this.events.shift()
      while (this.texts.length > 1 && this.texts[1].t <= t0) this.texts.shift()
      let k = 0
      while (k < this.fx.length && this.fx[k].t < t0) k++
      if (k) this.fx.splice(0, k)
    }
  }

  /** Despegues y tomas, a partir del contacto con el suelo o el agua (con histéresis). */
  contactUpdate(onSurface: boolean, water: boolean, vsFpm: number, gsKmh: number, crashed: boolean): void {
    const t = this.clock
    if (this.count === 0) {
      this.contact = onSurface
      this.changeT = t
      this.airborneSince = onSurface ? -1 : t
      this.contactT = onSurface ? t : -1
      return
    }
    if (crashed) return
    if (onSurface && !this.contact) {
      // toca: cuenta como toma si venía volando más de 3 s (los botes en la carrera no)
      this.contact = true
      this.contactT = t
      if (this.airborneSince >= 0 && t - this.airborneSince > 3) this.events.push({ t, kind: 'touchdown', vs: vsFpm, gs: gsKmh, water })
      this.airborneSince = -1
    } else if (!onSurface && this.contact) {
      this.contact = false
      this.changeT = t
    }
    // despegue: lleva 1,5 s en el aire seguidos
    if (!this.contact && this.airborneSince < 0 && t - this.changeT > 1.5) {
      this.airborneSince = this.changeT
      // (si había tocado hace poco y vuelve a irse, es un bote o un «toma y despega»)
      if (this.contactT >= 0) this.events.push({ t: this.changeT, kind: 'takeoff', water })
    }
  }

  /** Avisos del HUD (solo cuando cambian). */
  text(warnings: readonly string[], cautions: readonly string[]): void {
    const key = warnings.join('\n') + '\u0001' + cautions.join('\n')
    if (key === this.lastText) return
    this.lastText = key
    this.texts.push({ t: this.clock, warnings: [...warnings], cautions: [...cautions] })
  }
  textAt(T: number): TextCue | null {
    let out: TextCue | null = null
    for (const c of this.texts) {
      if (c.t > T) break
      out = c
    }
    return out
  }

  // ---------------------------------------------------------------------------
  // Accidente
  // ---------------------------------------------------------------------------
  beginCrash(origin: Vector3, worldToECEF: Matrix4, wind: Vector3): CrashRec {
    this.crash = {
      t0: this.clock,
      origin: origin.clone(),
      epoch: this.epochOf(worldToECEF),
      wind: wind.clone(),
      parts: new Map(),
      chunks: new Map(),
      lastT: -1,
      frame: 0,
    }
    return this.crash
  }

  /** Postura de un sólido de los restos (mundo); solo se guarda si se ha movido. */
  body(track: BodyTrack, t: number, pos: Vector3, quat: Quaternion, origin: Vector3, frame: number): void {
    track.seen = frame
    const n = track.t.length
    const x = pos.x - origin.x
    const y = pos.y - origin.y
    const z = pos.z - origin.z
    if (n) {
      const o = (n - 1) * 7
      const d = track.d
      const moved =
        Math.abs(d[o] - x) + Math.abs(d[o + 1] - y) + Math.abs(d[o + 2] - z) > 0.002 ||
        1 - Math.abs(d[o + 3] * quat.x + d[o + 4] * quat.y + d[o + 5] * quat.z + d[o + 6] * quat.w) > 2e-7
      if (!moved) {
        track.stillT = t
        return
      }
      // tras un rato quieto: la postura de reposo justo antes de moverse otra vez
      if (track.stillT > track.t[n - 1]) {
        track.t.push(track.stillT)
        for (let k = 0; k < 7; k++) track.d.push(d[o + k])
      }
    }
    track.t.push(t)
    track.d.push(x, y, z, quat.x, quat.y, quat.z, quat.w)
  }

  newTrack(t: number): BodyTrack {
    return { t: [], d: [], born: t, gone: Infinity, stillT: -1, seen: 0 }
  }

  // ---------------------------------------------------------------------------
  // Efectos
  // ---------------------------------------------------------------------------
  /**
   * Engancha los emisores de un sistema de efectos (CrashFx, WaterFx o CrashAudio) para grabar sus
   * llamadas. Solo cuenta la llamada de fuera: lo que un emisor llama dentro (otro emisor, o el ruido de
   * un chapoteo) sale solo al repetirla.
   * `active()`: si se está grabando; `epoch()`: marco del mundo actual.
   */
  tapEmitters(target: FxTarget, obj: object, active: () => boolean, epoch: () => number): void {
    const o = obj as Record<string, unknown>
    for (const [fn, kinds] of Object.entries(FX_EMITTERS[target])) {
      const orig = o[fn]
      if (typeof orig !== 'function') continue
      const call = (orig as (...a: unknown[]) => unknown).bind(obj)
      o[fn] = (...args: unknown[]) => {
        if (this.tapDepth === 0 && active()) this.noteFx(target, fn, args, kinds, epoch())
        this.tapDepth++
        try {
          return call(...args)
        } finally {
          this.tapDepth--
        }
      }
    }
  }

  private noteFx(target: FxTarget, fn: string, args: unknown[], kinds: ArgKind[], epoch: number): void {
    // estelas: se llaman cada fotograma por cada cosa que navega, pero la espuma sale cada medio metro o
    // más (WaterFx.wake): basta con guardar una llamada cada 0,3 m o 0,5 s por estela
    if (fn === 'wake') {
      const key = String(args[0])
      const p = args[1] as Vector3
      const last = this.wakeLast.get(key)
      if (last && Math.hypot(p.x - last.x, p.z - last.z) < 0.3 && this.clock - last.t < 0.5) return
      this.wakeLast.set(key, { x: p.x, z: p.z, t: this.clock })
      if (this.wakeLast.size > 200) this.wakeLast.clear()
    }
    if (CONTINUOUS.has(fn)) {
      for (const list of [this.pendingFx, this.fx]) {
        const e = list[list.length - 1]
        if (e && e.fn === fn && e.target === target && this.clock - e.t < 1 / 20) {
          e.args = cloneArgs(args, kinds)
          return
        }
      }
    }
    const dtArg = DT_ARG[fn]
    // emisores continuos (uno por fotograma y fuente): se juntan con el anterior de la misma fuente si
    // es de hace menos de 1/20 s; se queda la última posición y se suma el tiempo (salen las mismas
    // partículas)
    if (dtArg !== undefined) {
      for (const list of [this.pendingFx, this.fx]) {
        for (let k = list.length - 1; k >= Math.max(0, list.length - 8); k--) {
          const e = list[k]
          if (e.fn !== fn || e.target !== target || e.epoch !== epoch || this.clock - e.t > 1 / 20) continue
          const p = e.args[0] as number[]
          const q = args[0] as Vector3
          if (Math.abs(p[0] - q.x) + Math.abs(p[2] - q.z) > 1.5) continue
          const sum = (e.args[dtArg] as number) + (args[dtArg] as number)
          e.args = cloneArgs(args, kinds)
          e.args[dtArg] = sum
          return
        }
      }
    }
    this.pendingFx.push({ t: this.clock, target, fn, args: cloneArgs(args, kinds), epoch })
  }
}

/** Copia de los argumentos de un emisor: puntos y vectores como [x, y, z] (mundo del marco del suceso). */
function cloneArgs(args: unknown[], kinds: ArgKind[]): unknown[] {
  const out: unknown[] = []
  const p0 = args[kinds.indexOf('p')] as Vector3 | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const k = kinds[i] ?? 'n'
    if (k === 'p' || k === 'v') {
      const v = a as Vector3
      out.push([v.x, v.y, v.z])
    } else if (k === 'c') out.push((a as Color).clone())
    else if (k === 'y') out.push((a as number) - (p0?.y ?? 0))
    else out.push(a)
  }
  return out
}

/**
 * Argumentos de un suceso grabado listos para volver a llamar al emisor, en el mundo actual: `m` lleva
 * del marco del suceso al de ahora (identidad si no ha habido re-centrado).
 */
export function replayArgs(e: FxEvent, m: Matrix4, rot: Quaternion, dist = 0): unknown[] {
  const kinds = FX_EMITTERS[e.target][e.fn]
  const out: unknown[] = []
  let p0: Vector3 | null = null
  for (let i = 0; i < e.args.length; i++) {
    const a = e.args[i]
    const k = kinds[i] ?? 'n'
    if (k === 'p') {
      const v = a as number[]
      const p = new Vector3(v[0], v[1], v[2]).applyMatrix4(m)
      p0 ??= p
      out.push(p)
    } else if (k === 'v') {
      const v = a as number[]
      out.push(new Vector3(v[0], v[1], v[2]).applyQuaternion(rot))
    } else if (k === 'y') out.push((p0?.y ?? 0) + (a as number))
    else if (k === 'd') out.push(dist)
    else out.push(a)
  }
  return out
}
