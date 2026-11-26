// Simulación microscópica del tráfico sobre la red de network.ts.
//
// - Cada conductor sigue al de delante con el modelo IDM (mantiene la distancia de seguridad,
//   frena de forma progresiva) y frena antes de las curvas según su radio.
// - Cruces: solo entra en un movimiento cuando tiene paso («compromiso»): nadie más está
//   pisando o va a pisar un punto donde las trayectorias se cortan, quien tiene preferencia
//   llega con margen de sobra, hay sitio a la salida (no se queda en mitad del cruce) y, con
//   semáforo, está en verde. Mientras no lo tiene, la línea de detención es un obstáculo.
//   En los tramos compartidos (incorporaciones, rotondas) sigue al que va delante.
// - Cambios de carril (MOBIL): solo con hueco delante y detrás, para adelantar o para ponerse
//   en el carril del giro que va a hacer; si no lo consigue, cambia de ruta.
// - Entran por la frontera de la región, salen por ella; la cantidad depende de la clase de vía
//   y de la hora.
//
// Sin three.js ni DOM (worker y Node).

import { linkPose, type Cluster, type Lane, type Link, type Move, type Network, type Token, type Zone } from './network.ts'
import { carGap, carHalfWidth, type RailSim } from './rail.ts'

export interface VType {
  id: string
  len: number
  width: number
  height: number
  /** aceleración y frenada cómodas (m/s²), tiempo de seguridad (s), velocidad máxima (m/s) */
  a: number
  b: number
  T: number
  vmax: number
  /** largo del semirremolque (0 = rígido) */
  trailer: number
}

export const VTYPES: VType[] = [
  { id: 'car', len: 4.4, width: 1.8, height: 1.45, a: 1.6, b: 2.2, T: 1.3, vmax: 42, trailer: 0 },
  { id: 'hatch', len: 3.95, width: 1.75, height: 1.5, a: 1.5, b: 2.2, T: 1.3, vmax: 40, trailer: 0 },
  { id: 'suv', len: 4.65, width: 1.9, height: 1.7, a: 1.5, b: 2.2, T: 1.4, vmax: 40, trailer: 0 },
  { id: 'van', len: 5.3, width: 2.0, height: 2.45, a: 1.2, b: 2.0, T: 1.5, vmax: 35, trailer: 0 },
  { id: 'truck', len: 9.0, width: 2.5, height: 3.5, a: 0.9, b: 1.8, T: 1.7, vmax: 25, trailer: 0 },
  { id: 'bus', len: 12.0, width: 2.55, height: 3.2, a: 0.9, b: 1.8, T: 1.7, vmax: 25, trailer: 0 },
  { id: 'artic', len: 16.5, width: 2.55, height: 3.9, a: 0.6, b: 1.6, T: 1.9, vmax: 24, trailer: 13.6 },
]

/** reparto de tipos (car, hatch, suv, van, truck, bus, artic) según la clase de vía */
const MIX: number[][] = [
  [0.4, 0.3, 0.18, 0.09, 0.02, 0.01, 0],
  [0.4, 0.3, 0.18, 0.09, 0.02, 0.01, 0],
  [0.38, 0.28, 0.17, 0.1, 0.04, 0.02, 0.01],
  [0.37, 0.25, 0.17, 0.1, 0.05, 0.02, 0.04],
  [0.36, 0.22, 0.17, 0.1, 0.05, 0.02, 0.08],
  [0.36, 0.17, 0.16, 0.09, 0.06, 0.02, 0.14],
  [0.35, 0.16, 0.16, 0.08, 0.06, 0.02, 0.17],
]

export interface Veh {
  id: number
  type: number
  len: number
  width: number
  a: number
  b: number
  T: number
  s0: number
  /** factor de velocidad del conductor */
  vf: number
  vcap: number
  lane: Lane | null
  move: Move | null
  /** posición del frontal en el tramo actual (m) */
  s: number
  v: number
  acc: number
  /** cuentakilómetros (m) */
  odo: number
  /** salida elegida al final del enlace actual */
  next: { to: Link; byLane: Array<Move | null> } | null
  /** movimiento elegido (desde el carril actual) */
  plan: Move | null
  committed: boolean
  /** tiempo esperando parado ante la línea */
  waitT: number
  /** cuándo llegó a la línea (para el orden de llegada) */
  arrive: number
  /** cambio de carril: desplazamiento lateral pendiente (m) y tiempo que queda */
  lcOff: number
  lcT: number
  /** carril del que viene en un cambio de carril (aún lo pisa en parte) */
  lcFrom: Lane | null
  lcTimer: number
  /** tramos anteriores (para la parte de atrás del vehículo) */
  hist: Array<{ lane: Lane | null; move: Move | null; end: number; off: number }>
  color: number
  /** -1 intermitente izquierdo, 1 derecho, 0 nada */
  blink: number
  /** camión en un callejón sin salida: se quitará en cuanto no se vea */
  doomed: boolean
  stuck: number
  dead: boolean
  /** hueco mínimo con lo de delante en el último paso (m) */
  gap: number
  /** por qué no tiene paso y a quién espera (para depurar) */
  why: string
  blocker: Veh | null
}

/** generador pseudoaleatorio (mulberry32) */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** tráfico relativo a la hora punta según la hora local */
export function hourFactor(h: number): number {
  const prof = [0.12, 0.08, 0.06, 0.05, 0.06, 0.12, 0.35, 0.75, 1.0, 0.85, 0.72, 0.72, 0.78, 0.85, 0.8, 0.75, 0.78, 0.88, 0.95, 0.9, 0.65, 0.45, 0.3, 0.18]
  const i = Math.floor(((h % 24) + 24) % 24)
  const f = h - Math.floor(h)
  return prof[i] + (prof[(i + 1) % 24] - prof[i]) * f
}

export type Light = 'G' | 'A' | 'R'

export function lightState(c: Cluster, phase: number, t: number): Light {
  if (phase < 0 || c.cycle <= 0) return 'G'
  let tt = (((t + c.offset) % c.cycle) + c.cycle) % c.cycle
  for (let p = 0; p < c.greens.length; p++) {
    if (tt < c.greens[p]) return p === phase ? 'G' : 'R'
    tt -= c.greens[p]
    if (tt < 3) return p === phase ? 'A' : 'R'
    tt -= 5
    if (tt < 0) return 'R'
  }
  return 'R'
}

const LOOK = 160
/** vehículos largos (su cola barre más en las curvas) */
const LONG = 7
const P = { x: 0, z: 0, dx: 0, dz: 0 }

export interface Obstacle {
  x: number
  z: number
  r: number
}

export class TrafficSim {
  net: Network | null = null
  readonly vehs: Veh[] = []
  t = 0
  /** hora local (0–24) */
  hour = 12
  /** máximo de vehículos */
  cap = 1500
  /** multiplicador de densidad (1 = la de la tabla) */
  density = 1
  /** obstáculos en la calzada (el aparato en el suelo) */
  obstacles: Obstacle[] = []
  /** cámara (marco de la red): lo que se quita o se atasca, mejor lejos de ella; null = no hay */
  camera: { x: number; z: number } | null = null
  /** trenes (para los pasos a nivel) */
  rail: RailSim | null = null
  /** contadores para pruebas */
  readonly counters = { spawned: 0, exited: 0, removed: 0, replans: 0, laneChanges: 0, forcedStops: 0, safetyStops: 0 }
  /** cajas de los vehículos (red de seguridad física): rejilla de 16 m */
  private bodies = new Map<number, Body[]>()
  private bodyOf = new Map<Veh, Body[]>()
  private readonly rand: () => number
  private nextId = 1
  private scale = 1
  private spawnAcc = new Map<Lane, number>()

  constructor(seed = 1) {
    this.rand = rng(seed)
  }

  setNetwork(net: Network): void {
    for (const v of this.vehs) v.dead = true
    this.vehs.length = 0
    this.net = net
    this.spawnAcc.clear()
    this.updateScale()
  }

  /** Llena la red (o los enlaces que cumplan `only`) con el tráfico que le corresponde. */
  fill(only?: (l: Link) => boolean): void {
    const net = this.net
    if (!net) return
    this.buildBodyGrid()
    this.updateScale()
    const hf = hourFactor(this.hour) * this.density * this.scale
    for (const l of net.links) {
      const span = l.s1 - l.s0
      if (span < 6 || !l.live) continue
      if (only && !only(l)) continue
      for (const lane of l.lanes) {
        const want = (l.density * hf * span) / 1000
        let k = Math.floor(want) + (this.rand() < want - Math.floor(want) ? 1 : 0)
        const spots: number[] = []
        while (k-- > 0) spots.push(l.s0 + 3 + this.rand() * Math.max(0, span - 6))
        spots.sort((a, b) => a - b)
        let last = -Infinity
        const deadEnd = l.outs.length === 0 || l.outs.every((o) => o.turn === 'u')
        for (const s of spots) {
          let type = this.pickType(l.rank)
          if (deadEnd && VTYPES[type].len >= LONG) type = 0
          if (!l.heavy && VTYPES[type].trailer > 0) type = 4
          const T = VTYPES[type]
          if (s - T.len - 6 < last) continue
          if (s - T.len < l.s0) continue
          // sin pisar a nadie que ya esté (al rellenar solo una parte)
          const nb = neighbours(lane, s)
          if (nb.lead && nb.lead.s - nb.lead.len - s < 8) continue
          if (nb.follow && s - T.len - nb.follow.s < 8) continue
          // ni sobre un paso a nivel por el que se acerca un tren
          if (this.rail && lane.rail.some((c) => c.s1 > s - T.len - 2 && c.s0 < s + 2 && this.rail!.crossingClosed(c))) continue
          const v = this.newVeh(type)
          v.lane = lane
          v.s = s
          // ni encima de un vehículo de otra calzada pegada a esta
          const bs = this.boxesFor(v, 0)
          if (bs.some((b) => this.bodyHits(b, v))) continue
          for (const b of bs) this.gridAdd(b)
          v.v = Math.min(this.vlimAt(l, s), v.vcap) * 0.85
          v.odo = 0
          insertSorted(lane.vehs, v)
          this.vehs.push(v)
          this.choosePlan(v)
          last = s
        }
      }
    }
  }

  /**
   * Cambia a una red nueva (la región se ha movido) llevándose los vehículos: cada uno va al carril
   * o al movimiento de la red nueva que cae donde está y en su dirección (`map` pasa un punto del
   * marco viejo al nuevo). Los que no encuentran sitio (estaban en la frontera vieja) se quitan.
   */
  adopt(net: Network, map: (x: number, z: number, out: { x: number; z: number }) => void): { kept: number; lost: number } {
    const old = this.vehs.filter((v) => !v.dead)
    const pose = old.map((v) => {
      const F = { x: 0, z: 0 }
      const B = { x: 0, z: 0 }
      this.pointOf(v, 0, F)
      this.pointOf(v, 3, B)
      const f = { x: 0, z: 0 }
      const b = { x: 0, z: 0 }
      map(F.x, F.z, f)
      map(B.x, B.z, b)
      return { f, b }
    })
    this.net = net
    this.vehs.length = 0
    this.spawnAcc.clear()
    const side = net.side
    // rejillas de segmentos de enlaces y de muestras de movimientos (celdas de 10 m)
    const CELL = 10
    const key = (x: number, z: number) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`
    const lg = new Map<string, Array<[Link, number]>>()
    for (const l of net.links) {
      for (let i = 0; i + 1 < l.x.length; i++) {
        const k = new Set([key(l.x[i], l.z[i]), key(l.x[i + 1], l.z[i + 1]), key((l.x[i] + l.x[i + 1]) / 2, (l.z[i] + l.z[i + 1]) / 2)])
        for (const kk of k) {
          const arr = lg.get(kk)
          if (arr) arr.push([l, i])
          else lg.set(kk, [[l, i]])
        }
      }
    }
    const mg = new Map<string, Array<[Move, number]>>()
    for (const m of net.moves) {
      for (let q = 0; q < m.x.length; q++) {
        const kk = key(m.x[q], m.z[q])
        const arr = mg.get(kk)
        if (arr) arr.push([m, q])
        else mg.set(kk, [[m, q]])
      }
    }
    let kept = 0
    let lost = 0
    old.forEach((v, idx) => {
      const { f, b } = pose[idx]
      let hx = f.x - b.x
      let hz = f.z - b.z
      const hl = Math.hypot(hx, hz) || 1
      hx /= hl
      hz /= hl
      // carril
      let best: { lane: Lane; s: number; d: number } | null = null
      const cx = Math.floor(f.x / CELL)
      const cz = Math.floor(f.z / CELL)
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (const [l, i] of lg.get(`${cx + dx},${cz + dz}`) ?? []) {
            const ax = l.x[i]
            const az = l.z[i]
            let ux = l.x[i + 1] - ax
            let uz = l.z[i + 1] - az
            const L = Math.hypot(ux, uz)
            if (L < 1e-6) continue
            ux /= L
            uz /= L
            if (ux * hx + uz * hz < 0.8) continue
            const t = (f.x - ax) * ux + (f.z - az) * uz
            if (t < -0.5 || t > L + 0.5) continue
            const s = l.s[i] + Math.max(0, Math.min(L, t))
            if (s < l.s0 - 0.5 || s > l.s1 + 0.5) continue
            const lat = ((f.x - ax) * -uz + (f.z - az) * ux) * side
            for (let j = 0; j < l.n; j++) {
              const d = Math.abs(lat - l.off[j])
              if (d < 1.3 && (!best || d < best.d)) best = { lane: l.lanes[j], s: Math.max(l.s0, Math.min(l.s1 - 0.01, s)), d }
            }
          }
        }
      }
      v.lane = null
      v.move = null
      v.plan = null
      v.next = null
      v.committed = false
      v.hist = []
      v.lcT = 0
      v.lcOff = 0
      v.lcFrom = null
      if (best) {
        v.lane = best.lane
        v.s = best.s
      } else {
        // en un cruce: el movimiento que pasa por ahí
        let bm: { m: Move; q: number; d: number } | null = null
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            for (const [m, q] of mg.get(`${cx + dx},${cz + dz}`) ?? []) {
              const d = Math.hypot(m.x[q] - f.x, m.z[q] - f.z)
              if (d > 1.5) continue
              const a = Math.max(0, q - 1)
              const c = Math.min(m.x.length - 1, q + 1)
              const mx = m.x[c] - m.x[a]
              const mz = m.z[c] - m.z[a]
              const ml = Math.hypot(mx, mz) || 1
              if ((mx * hx + mz * hz) / ml < 0.8) continue
              if (!bm || d < bm.d) bm = { m, q, d }
            }
          }
        }
        if (bm) {
          v.move = bm.m
          v.s = bm.m.s[bm.q]
        }
      }
      if (!v.lane && !v.move) {
        v.dead = true
        lost++
        return
      }
      this.vehs.push(v)
      kept++
    })
    // colas ordenadas y sin solapes (si dos caen encima, se queda el de delante)
    for (const v of this.vehs) {
      if (v.lane) v.lane.vehs.push(v)
      else if (v.move) v.move.vehs.push(v)
    }
    const prune = (arr: Veh[]) => {
      arr.sort((p, q) => p.s - q.s)
      for (let i = arr.length - 2; i >= 0; i--) {
        if (arr[i + 1].s - arr[i + 1].len - arr[i].s < 0.5) {
          arr[i].dead = true
          arr.splice(i, 1)
          kept--
          lost++
        }
      }
    }
    for (const l of net.links) for (const lane of l.lanes) if (lane.vehs.length > 1) prune(lane.vehs)
    for (const m of net.moves) if (m.vehs.length > 1) prune(m.vehs)
    let w = 0
    for (const v of this.vehs) if (!v.dead) this.vehs[w++] = v
    this.vehs.length = w
    for (const v of this.vehs) if (v.lane) this.choosePlan(v)
    this.updateScale()
    return { kept, lost }
  }

  step(dt: number): void {
    const net = this.net
    if (!net || dt <= 0) return
    this.t += dt
    const vehs = this.vehs
    // 1) aceleraciones con las posiciones del principio del paso
    for (const v of vehs) v.acc = this.accel(v)
    // 2) avance
    this.buildBodyGrid()
    for (const v of vehs) {
      let nv = Math.max(0, v.v + v.acc * dt)
      let ds = v.acc < 0 && nv === 0 ? (v.v * v.v) / (2 * -v.acc) : ((v.v + nv) / 2) * dt
      ds = Math.max(0, ds)
      // red de seguridad: nunca más allá del hueco que había delante
      if (ds > v.gap - 0.2) {
        if (v.gap < 50) this.counters.forcedStops += ds > v.gap ? 1 : 0
        ds = Math.max(0, Math.min(ds, v.gap - 0.2))
      }
      // red de seguridad física: la caja en la posición siguiente no puede pisar la de otro (y si la
      // pisaría en ~0,8 s, frena ya); por si la lógica de cruces y carriles falla en un caso raro
      // (también al arrastrarse: de milímetro en milímetro se acaba metiendo en el otro)
      if (ds > 0) {
        const verdict = this.bodyCheck(v, ds, Math.max(ds, v.v * 0.8))
        if (verdict === 2) {
          ds = 0
          nv = 0
          this.counters.safetyStops++
        } else if (verdict === 1) nv = Math.max(0, v.v - v.b * 2 * dt)
      }
      if (ds > 0) this.moveBody(v, ds)
      v.s += ds
      v.odo += ds
      v.v = ds === 0 && nv > 0 && v.gap <= 0.2 ? 0 : nv
      if (v.lcT > 0) {
        // el paso de lado del cambio de carril tampoco se mete en un tranvía que pasa al lado
        const old = v.lcT
        const before = this.rail ? this.boxesFor(v, 0) : null
        v.lcT = Math.max(0, v.lcT - dt)
        if (before && this.trainBeside(v, before)) v.lcT = old
      } else if (v.lane && !v.committed) v.blink = 0
      if (v.v < 0.3) {
        v.stuck += dt
      } else v.stuck = 0
    }
    // 3) paso de un tramo a otro
    for (const v of vehs) this.advance(v)
    // 4) colas que ya han salido
    this.cleanTails()
    // 5) permisos para entrar en los cruces y cambios de carril
    for (const v of vehs) {
      if (v.dead) continue
      if (v.lane && v.plan && !v.committed) this.tryCommit(v, dt)
      v.lcTimer -= dt
      if (v.lane && v.lcTimer <= 0) {
        v.lcTimer = 0.6 + this.rand() * 0.6
        this.laneChange(v)
      }
    }
    // 6) fuera los que han salido, los que no tienen salida y los que llevan mucho atascados, si no se ven
    if (Math.floor(this.t) !== Math.floor(this.t - dt)) {
      for (const v of vehs) {
        if (v.dead) continue
        const atEnd = v.lane !== null && v.lane.link.s1 - v.s < 8 && v.v < 0.5
        if ((v.doomed && atEnd) || v.stuck > 90) {
          if (this.farFromCamera(v)) {
            this.remove(v)
            this.counters.removed++
          }
        }
      }
    }
    let w = 0
    for (const v of vehs) {
      if (v.dead) continue
      vehs[w++] = v
    }
    vehs.length = w
    // 7) entradas por la frontera
    this.spawn(dt)
  }

  // -------------------------------------------------------------------------
  // Red de seguridad física
  // -------------------------------------------------------------------------

  /** Cajas (una o dos: tractora y semirremolque) de un vehículo adelantado `ahead` metros. */
  private boxesFor(v: Veh, ahead: number): Body[] {
    const F = _bf
    const R = _br
    const T = VTYPES[v.type]
    const out: Body[] = []
    const mk = (back0: number, back1: number, len: number) => {
      // partida donde cambia el nivel: cada trozo con el suyo (la tractora ya en la rampa de un puente y
      // el remolque aún debajo de otro)
      const ps = this.pieces(v, back0 - ahead, back1 - ahead)
      for (const [p0, p1, lvl] of ps) {
        this.pointOf(v, p0, F)
        this.pointOf(v, p1, R)
        let ux = F.x - R.x
        let uz = F.z - R.z
        const l = Math.hypot(ux, uz) || 1
        ux /= l
        uz /= l
        const L = ps.length === 1 ? len : p1 - p0
        out.push({ v, cx: (F.x + R.x) / 2, cz: (F.z + R.z) / 2, ux, uz, hl: Math.max(0.05, L / 2 - 0.2), hw: v.width / 2 - 0.1, lvl })
      }
    }
    if (T.trailer > 0) {
      mk(0, 6, 6)
      mk(4.5, v.len, T.trailer - 1.5)
    } else mk(0, v.len, v.len)
    return out
  }

  private buildBodyGrid(): void {
    this.bodies.clear()
    this.bodyOf.clear()
    for (const v of this.vehs) {
      if (v.dead) continue
      const bs = this.boxesFor(v, 0)
      this.bodyOf.set(v, bs)
      for (const b of bs) this.gridAdd(b)
    }
    // los coches de tren (a nivel): nadie se mete debajo de un tren
    const rail = this.rail
    if (rail) {
      const F = _bf
      const R = _br
      for (const tr of rail.trains) {
        for (let k = 0; k < tr.cars; k++) {
          const f = k * (tr.carLen + carGap(tr.kind)) + 0.3
          const w = rail.where(tr, f + tr.carLen / 2)
          const tram = tr.kind === 'tram'
          if (w.tunnel || (w.bridge && !tram)) continue
          rail.pointOf(tr, f, F)
          rail.pointOf(tr, f + tr.carLen - 0.6, R)
          let ux = F.x - R.x
          let uz = F.z - R.z
          const l = Math.hypot(ux, uz) || 1
          ux /= l
          uz /= l
          const body: Body = { v: TRAIN, cx: (F.x + R.x) / 2, cz: (F.z + R.z) / 2, ux, uz, hl: tr.carLen / 2, hw: carHalfWidth(tr.kind), lvl: 0 }
          if (!tram) this.gridAdd(body)
          else {
            // el tranvía va por la calle: los coches de su puente (aunque OSM marque solo la calle o
            // solo la vía como puente) lo ven si van en paralelo
            for (const lvl of [0, 100, 101]) this.gridAdd({ ...body, lvl, par: lvl !== (w.bridge ? 101 : 0) })
          }
        }
      }
    }
  }

  /** ¿La caja del vehículo (ya movida de lado) pisa un coche de tren que antes no pisaba? */
  private trainBeside(v: Veh, before: Body[]): boolean {
    for (const b of this.boxesFor(v, 0)) {
      const cx = Math.floor(b.cx / 16)
      const cz = Math.floor(b.cz / 16)
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (const o of this.bodies.get((cx + dx) * 100003 + cz + dz) ?? []) {
            if (o.v !== TRAIN || !sameLevel(b, o)) continue
            if (obb(b, o) && !before.some((p) => obb(p, o))) return true
          }
        }
      }
    }
    return false
  }

  /** ¿Algún vehículo (no tren) a menos de `r` del punto? (los tranvías frenan por ellos) */
  occupied(x: number, z: number, r: number, ux = 0, uz = 0): boolean {
    const cx = Math.floor(x / 16)
    const cz = Math.floor(z / 16)
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const o of this.bodies.get((cx + dx) * 100003 + cz + dz) ?? []) {
          if (o.v === TRAIN || o.v.dead) continue
          // a nivel; o en un puente bajo, si va en paralelo (la calle y la vía del mismo puente)
          if (o.lvl !== 0 && (o.lvl < 100 || o.lvl > 101 || Math.abs(ux * o.ux + uz * o.uz) < 0.85)) continue
          const ex = x - o.cx
          const ez = z - o.cz
          const a = ex * o.ux + ez * o.uz
          const b = -ex * o.uz + ez * o.ux
          if (Math.abs(a) < o.hl + r && Math.abs(b) < o.hw + r) return true
        }
      }
    }
    return false
  }

  /** ¿Esa caja (de un coche de tranvía) pisa algún vehículo? */
  boxBlocked(cx: number, cz: number, ux: number, uz: number, hl: number, hw: number, tram = true): boolean {
    const b: Body = { v: TRAIN, cx, cz, ux, uz, hl, hw, lvl: 0 }
    const r = Math.ceil((hl + 12) / 16)
    const gx = Math.floor(cx / 16)
    const gz = Math.floor(cz / 16)
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        for (const o of this.bodies.get((gx + dx) * 100003 + gz + dz) ?? []) {
          if (o.v === TRAIN || o.v.dead) continue
          // (los de un puente bajo en paralelo, solo para el tranvía: un tren no va por la calle)
          if (o.lvl !== 0 && (!tram || o.lvl < 100 || o.lvl > 101 || Math.abs(ux * o.ux + uz * o.uz) < 0.85)) continue
          if (obb(b, o)) return true
        }
      }
    }
    return false
  }

  /** ¿La caja pisa la de algún otro vehículo de la rejilla? */
  private bodyHits(b: Body, v: Veh): boolean {
    const cx = Math.floor(b.cx / 16)
    const cz = Math.floor(b.cz / 16)
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const o of this.bodies.get((cx + dx) * 100003 + cz + dz) ?? []) {
          if (o.v === v || !sameLevel(b, o)) continue
          if (obb(b, o)) return true
        }
      }
    }
    return false
  }

  private gridAdd(b: Body): void {
    const k = Math.floor(b.cx / 16) * 100003 + Math.floor(b.cz / 16)
    const l = this.bodies.get(k)
    if (l) l.push(b)
    else this.bodies.set(k, [b])
  }

  private gridRemove(b: Body): void {
    const k = Math.floor(b.cx / 16) * 100003 + Math.floor(b.cz / 16)
    const l = this.bodies.get(k)
    if (!l) return
    const i = l.indexOf(b)
    if (i >= 0) l.splice(i, 1)
  }

  /** 0 = libre, 1 = pisaría a otro dentro de poco (frenar), 2 = lo pisaría ya (no moverse) */
  private bodyCheck(v: Veh, ds: number, look: number): number {
    if (v.dead) return 0
    const now = this.bodyOf.get(v) ?? []
    // primero, ¿hay alguien cerca? (si no, no hace falta calcular nada más); también los de su misma
    // fila: en una curva cerrada o con un frenazo el hueco de seguridad no basta para las cajas
    let near = false
    for (const b of now) {
      const cx = Math.floor(b.cx / 16)
      const cz = Math.floor(b.cz / 16)
      for (let dz = -1; dz <= 1 && !near; dz++) {
        for (let dx = -1; dx <= 1 && !near; dx++) {
          for (const o of this.bodies.get((cx + dx) * 100003 + cz + dz) ?? []) {
            // (de cualquier nivel: al bajar de un puente o salir de un túnel cambia el suyo)
            if (o.v === v || o.v.dead) continue
            if (Math.hypot(o.cx - b.cx, o.cz - b.cz) < o.hl + b.hl + look + 2) {
              near = true
              break
            }
          }
        }
      }
    }
    if (!near) return 0
    const hits = (bs: Body[]) => {
      for (const b of bs) {
        const cx = Math.floor(b.cx / 16)
        const cz = Math.floor(b.cz / 16)
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            for (const o of this.bodies.get((cx + dx) * 100003 + cz + dz) ?? []) {
              if (o.v === v || !sameLevel(b, o) || o.v.dead) continue
              if (Math.abs(o.cx - b.cx) > o.hl + b.hl + 1 || Math.abs(o.cz - b.cz) > o.hl + b.hl + 1) continue
              if (!obb(b, o)) continue
              // ya se pisaban (aparecido encima, por ejemplo): puede moverse si así se separan, pero
              // no meterse más (con un tren, nunca)
              // (en el mismo nivel: ir por un puente sobre el otro no es pisarlo)
              if (o.v !== TRAIN && now.some((n) => sameLevel(n, o) && obb(n, o))) {
                let before = -Infinity
                for (const n of now) if (sameLevel(n, o)) before = Math.max(before, depth(n, o))
                if (depth(b, o) <= before + 1e-4) continue
              }
              return true
            }
          }
        }
      }
      return false
    }
    if (hits(this.boxesFor(v, ds))) return 2
    if (look > ds + 0.5 && hits(this.boxesFor(v, look))) return 1
    return 0
  }

  private moveBody(v: Veh, ds: number): void {
    const old = this.bodyOf.get(v)
    if (old) for (const b of old) this.gridRemove(b)
    const nb = this.boxesFor(v, ds)
    this.bodyOf.set(v, nb)
    for (const b of nb) this.gridAdd(b)
  }

  // -------------------------------------------------------------------------
  // Aceleración
  // -------------------------------------------------------------------------

  private idm(v: Veh, v0: number, gap: number, vl: number): number {
    const sStar = v.s0 + Math.max(0, v.v * v.T + (v.v * (v.v - vl)) / (2 * Math.sqrt(v.a * v.b)))
    const g = Math.max(gap, 0.05)
    return v.a * (1 - Math.pow(v.v / Math.max(v0, 0.5), 4) - (sStar / g) * (sStar / g))
  }

  private free(v: Veh, v0: number): number {
    return v.a * (1 - Math.pow(v.v / Math.max(v0, 0.5), 4))
  }

  /** velocidad permitida en un punto de un enlace */
  private vlimAt(l: Link, s: number): number {
    const n = l.s.length
    let lo = 0
    let hi = n - 1
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1
      if (l.s[m] <= s) lo = m
      else hi = m
    }
    return Math.min(l.vmax[lo], l.vmax[hi])
  }

  private accel(v: Veh): number {
    let gap = Infinity
    let a = Infinity
    const consider = (g: number, vl: number, v0: number) => {
      if (g < gap) gap = g
      const x = this.idm(v, v0, g, vl)
      if (x < a) a = x
    }
    // velocidad deseada: la de aquí y la de lo que viene (curvas), frenando a ~1,5 m/s²
    let v0 = v.vcap
    let dist = 0
    const horizon = (v.v * v.v) / 3 + 20
    const lim = (d: number, vl: number) => {
      const allow = Math.sqrt(vl * vl * v.vf * v.vf + 3 * Math.max(0, d))
      if (allow < v0) v0 = allow
    }
    if (v.lane) {
      const l = v.lane.link
      for (let i = 0; i < l.s.length; i++) {
        if (l.s[i] < v.s - 2) continue
        const d = l.s[i] - v.s
        if (d > horizon) break
        lim(d, l.vmax[i])
      }
      dist = l.s1 - v.s
      const m = v.plan
      if (m && dist < horizon) for (let q = 0; q < m.x.length; q += 3) lim(dist + m.s[q], m.vmax[q])
    } else if (v.move) {
      const m = v.move
      for (let q = 0; q < m.x.length; q += 2) {
        const d = m.s[q] - v.s
        if (d < -2) continue
        if (d > horizon) break
        lim(d, m.vmax[q])
      }
      dist = m.len - v.s
      const to = m.to
      for (let i = 0; i < to.s.length; i++) {
        const d = dist + to.s[i] - to.s0
        if (d < 0) continue
        if (d > horizon) break
        lim(d, to.vmax[i])
      }
    }
    v0 = Math.max(v0, 1.5)

    if (v.lane) {
      const lane = v.lane
      const l = lane.link
      const idx = lane.vehs.indexOf(v)
      const lead = lane.vehs[idx + 1]
      // cambiando de carril: también el de delante en el carril que deja
      if (v.lcT > 1.2 && v.lcFrom && v.lcFrom.link === l) {
        const o = neighbours(v.lcFrom, v.s).lead
        if (o && o !== v) consider(o.s - o.len - v.s, o.v, v0)
      }
      // los que están saliendo de este carril hacia uno de al lado (aún lo pisan)
      for (const di of [-1, 1]) {
        const adj = l.lanes[lane.i + di]
        if (!adj) continue
        const arr = adj.vehs
        let k = neighbourIndex(adj, v.s)
        for (let c = 0; c < 3 && k < arr.length; c++, k++) {
          const u = arr[k]
          if (u.s - u.len - v.s > 60) break
          if (u !== v && u.lcFrom === lane && u.lcT > 1.2 && u.s > v.s) consider(u.s - u.len - v.s, u.v, v0)
        }
      }
      // pasos a nivel: cerrados si viene un tren; y no se entra sin sitio para salir de la vía
      for (const c of lane.rail) {
        if (c.s0 <= v.s - 0.5 || c.s0 - v.s > LOOK) continue
        let closed = this.rail ? this.rail.crossingClosed(c) : false
        if (!closed && lead && lead.s - lead.len < c.s1 + 1.5 && lead.v < 3) closed = true
        if (closed) consider(c.s0 - 2.5 - v.s, 0, v0)
      }
      // tramos que tocan el carril de otra calle: reserva (el primero que llega) y, además, no se
      // entra si hay alguien en el otro
      for (const z of lane.near) {
        const dist = z.s0 - v.s
        if (dist > LOOK || v.s - v.len - sweep(v) > z.s1) continue
        // en una curva cerrada solo cuentan los vehículos largos
        const short = z.wide && v.len < LONG
        if (!this.claim(z.tok, lane, dist, v, short)) consider(dist - 1, 0, v0)
        else if (dist > -0.5 && nearOccupied(z, v)) consider(dist - 1, 0, v0)
      }
      // movimientos de otros cruces que cruzan este carril por delante
      for (const z of lane.zones) {
        const dist = z.s0 - v.s
        if (dist > LOOK || v.s - v.len - sweep(v) > z.s1) continue
        if (!this.claim(z.tok, lane, dist, v, false)) consider(dist - 1, 0, v0)
        else if (dist > 0 && moveOccupies(z.move, z.a0, z.a1, v)) consider(dist - 1, 0, v0)
      }
      if (lead) consider(lead.s - lead.len - v.s, lead.v, v0)
      else {
        const toEnd = l.s1 - v.s
        // quien acaba de salir del carril y aún tiene la cola en él
        for (const t of lane.tails) if (t.v !== v) consider(toEnd + (t.v.odo - t.odo) - t.v.len, t.v.v, v0)
        if (l.to === null) {
          // hacia la frontera: nada más
        } else if (v.doomed) {
          if (toEnd < LOOK) consider(toEnd - 0.5, 0, v0)
        } else if (!v.committed || !v.plan) {
          if (toEnd < LOOK) consider(toEnd - 0.5, 0, v0)
        } else if (toEnd < LOOK) {
          this.aheadOnMove(v, v.plan, -toEnd, v0, consider)
        }
      }
    } else if (v.move) {
      this.aheadOnMove(v, v.move, v.s, v0, consider)
    }
    // el aparato (u otro obstáculo) en la calzada
    if (this.obstacles.length) {
      const g = this.obstacleGap(v)
      if (g < Infinity) consider(g, 0, v0)
    }
    v.gap = gap
    if (a === Infinity) a = this.free(v, v0)
    // frenada de emergencia como mucho de 9 m/s²
    return Math.max(-9, Math.min(v.a, a))
  }

  /** Lo que hay delante a partir de un movimiento (posición p en él; negativa = aún antes de entrar). */
  private aheadOnMove(v: Veh, m: Move, p: number, v0: number, consider: (g: number, vl: number, v0: number) => void): void {
    // en el propio movimiento
    let found = false
    for (const u of m.vehs) {
      if (u === v || u.s <= p) continue
      consider(u.s - u.len - p, u.v, v0)
      found = true
      break
    }
    if (!found) {
      for (const t of m.tails) {
        if (t.v === v) continue
        consider(m.len - p + (t.v.odo - t.odo) - t.v.len, t.v.v, v0)
        found = true
      }
    }
    // pasos a nivel dentro del cruce
    if (this.rail) for (const c of m.rail) if (c.s0 > p - 0.5 && c.s0 - p < LOOK && this.rail.crossingClosed(c)) consider(c.s0 - 2.5 - p, 0, v0)
    // carriles de otras calles que el movimiento pisa: reserva y, además, si hay alguien encima no se entra
    for (const z of m.laneZones) {
      const dist = z.a0 - p
      if (p - v.len - sweep(v) > z.a1) continue
      if (!this.claim(z.tok, m, dist, v, false)) consider(dist - 1, 0, v0)
      else if (dist > 0 && laneOccupied(z.lane, z.s0, z.s1, v)) consider(dist - 1, 0, v0)
    }
    // puntos de cruce ocupados por otro (red de seguridad: con paso o sin él, no se entra)
    for (const z of m.zones) {
      if (!z.cross || p >= z.a0) continue
      const B = z.other
      const inZone = (u: Veh, pu: number) => u !== v && pu > z.b0 - 1 && pu - u.len - sweep(u) < z.b1 && !(z.wide && v.len < LONG && u.len < LONG)
      let busy = false
      for (const u of B.vehs) if (inZone(u, u.s)) busy = true
      if (!busy) for (const t of B.tails) if (inZone(t.v, B.len + (t.v.odo - t.odo))) busy = true
      if (busy) consider(z.a0 - 1 - p, 0, v0)
    }
    // tramos compartidos con otros movimientos
    for (const z of m.zones) {
      if (z.cross) continue
      const B = z.other
      if (p > z.a1) continue
      const check = (u: Veh, pu: number) => {
        if (u === v) return
        if (z.wide && v.len < LONG && u.len < LONG) return
        const ua = mapToA(z, pu)
        if (ua <= p) return
        if (pu - u.len - sweep(u) > z.b1) return
        consider(ua - u.len - p, u.v, v0)
      }
      for (const u of B.vehs) check(u, u.s)
      for (const t of B.tails) check(t.v, B.len + (t.v.odo - t.odo))
      for (const u of B.committed) if (u.lane) check(u, -(u.lane.link.s1 - u.s))
    }
    // tramos reservables al principio del carril de llegada (curva cerrada, calle pegada, giro de
    // otro cruce): se piden antes de salir del cruce, no ya dentro
    {
      const T = m.to.lanes[m.toLane]
      const base = m.len - p - T.link.s0
      for (const z of T.near) {
        const dist = base + z.s0
        if (dist > LOOK || dist < -v.len) continue
        if (!this.claim(z.tok, T, dist, v, z.wide && v.len < LONG)) consider(dist - 1, 0, v0)
      }
      for (const z of T.zones) {
        const dist = base + z.s0
        if (dist > LOOK || dist < -v.len) continue
        if (!this.claim(z.tok, T, dist, v, false)) consider(dist - 1, 0, v0)
      }
    }
    // el carril de llegada
    if (!found) {
      const T = m.to.lanes[m.toLane]
      const toEnd = m.len - p
      if (toEnd < LOOK) {
        const last = T.vehs[0]
        if (last) consider(toEnd + (last.s - last.len - T.link.s0), last.v, v0)
        else {
          for (const t of T.tails) if (t.v !== v) consider(toEnd + (T.link.s1 - T.link.s0) + (t.v.odo - t.odo) - t.v.len, t.v.v, v0)
          // el final de ese enlace (otro cruce): se llega con cuidado
          if (T.link.to !== null) {
            const d = toEnd + (T.link.s1 - T.link.s0) - 0.5
            if (d < LOOK) consider(d, 0, v0)
          }
        }
      }
    }
  }

  private obstacleGap(v: Veh): number {
    let best = Infinity
    const seg = v.lane ? v.lane.link : null
    const pos = { x: 0, z: 0 }
    this.pointOf(v, 0, pos)
    for (const o of this.obstacles) {
      if (Math.hypot(o.x - pos.x, o.z - pos.z) > LOOK + o.r) continue
      // muestras por delante cada 2 m
      for (let d = 0; d < LOOK; d += 2) {
        if (!this.aheadPoint(v, d, pos)) break
        if (Math.hypot(o.x - pos.x, o.z - pos.z) < o.r + v.width / 2 + 0.6) {
          best = Math.min(best, d - 1)
          break
        }
      }
    }
    void seg
    return best
  }

  // -------------------------------------------------------------------------
  // Paso entre tramos
  // -------------------------------------------------------------------------

  private advance(v: Veh): void {
    for (let guard = 0; guard < 4 && !v.dead; guard++) {
      if (v.lane) {
        const lane = v.lane
        const l = lane.link
        if (v.s < l.s1) return
        if (l.to === null) {
          this.remove(v)
          this.counters.exited++
          return
        }
        const m = v.plan
        if (v.doomed && this.farFromCamera(v)) {
          this.remove(v)
          this.counters.removed++
          return
        }
        if (!v.committed || !m) {
          // no debería pasar (la línea es un obstáculo): se queda en ella
          v.s = l.s1 - 0.01
          v.v = 0
          return
        }
        removeFrom(lane.vehs, v)
        lane.tails.push({ v, odo: v.odo - (v.s - l.s1) })
        removeFrom(m.committed, v)
        v.hist.unshift({ lane, move: null, end: l.s1, off: lane.link.off[lane.i] })
        if (v.hist.length > 3) v.hist.length = 3
        v.s -= l.s1
        v.move = m
        v.lane = null
        v.lcT = 0
        v.lcOff = 0
        insertSorted(m.vehs, v)
      } else if (v.move) {
        const m = v.move
        if (v.s < m.len) return
        removeFrom(m.vehs, v)
        m.tails.push({ v, odo: v.odo - (v.s - m.len) })
        v.hist.unshift({ lane: null, move: m, end: m.len, off: 0 })
        if (v.hist.length > 3) v.hist.length = 3
        const T = m.to.lanes[m.toLane]
        v.s = T.link.s0 + (v.s - m.len)
        v.lane = T
        v.move = null
        v.committed = false
        v.plan = null
        v.waitT = 0
        v.arrive = 0
        insertSorted(T.vehs, v)
        this.choosePlan(v)
      } else return
    }
  }

  private cleanTails(): void {
    const net = this.net!
    const clean = (arr: Array<{ v: Veh; odo: number }>) => {
      let w = 0
      for (const t of arr) {
        if (t.v.dead || t.v.odo - t.odo > t.v.len + 0.5) continue
        arr[w++] = t
      }
      arr.length = w
    }
    for (const m of net.moves) if (m.tails.length) clean(m.tails)
    for (const l of net.links) for (const lane of l.lanes) if (lane.tails.length) clean(lane.tails)
  }

  // -------------------------------------------------------------------------
  // Rutas
  // -------------------------------------------------------------------------

  private choosePlan(v: Veh): void {
    v.next = null
    v.plan = null
    v.committed = false
    const lane = v.lane
    if (!lane) return
    const l = lane.link
    if (l.to === null) return
    if (l.outs.length === 0) {
      // calle sin salida (datos): se quitará en cuanto no se vea
      v.doomed = true
      return
    }
    let total = 0
    const w: number[] = []
    const anyLive = l.outs.some((o) => o.to.live)
    for (const o of l.outs) {
      let k = o.turn === 'straight' ? 3 : o.turn === 'u' ? 0.05 : 1
      if (!o.to.live) k *= anyLive ? 0 : 0.02
      if (v.len >= LONG && (o.turn === 'u' || o.to.outs.every((q) => q.turn === 'u'))) k *= 0.001
      // los tráileres, por vías de cierta entidad y sin curvas cerradas
      if (VTYPES[v.type].trailer > 0 && !o.to.heavy) k *= 0.01
      k *= 0.35 + 0.65 * Math.min(1, (o.to.rank + 1) / (l.rank + 1))
      if (o.byLane[lane.i]) k *= 1.6
      w.push(k)
      total += k
    }
    let r = this.rand() * total
    let pick = l.outs[l.outs.length - 1]
    for (let i = 0; i < l.outs.length; i++) {
      r -= w[i]
      if (r <= 0) {
        pick = l.outs[i]
        break
      }
    }
    // un camión o un autobús no da la vuelta en un callejón: si no tiene otra, se va (lejos de la cámara)
    if (v.len >= LONG && pick.turn === 'u') {
      v.next = null
      v.plan = null
      v.doomed = true
      return
    }
    v.next = pick
    v.plan = pick.byLane[lane.i]
  }

  // -------------------------------------------------------------------------
  // Permiso para entrar en el cruce
  // -------------------------------------------------------------------------

  private tryCommit(v: Veh, dt: number): void {
    const l = v.lane!.link
    const m = v.plan!
    const d = l.s1 - v.s
    const stopped = v.v < 0.5 && d < 4
    if (stopped) {
      v.waitT += dt
      if (v.arrive === 0) v.arrive = this.t
    }
    // a la distancia a la que empezaría a frenar ante la línea (así quien tiene paso no frena)
    const commitDist = Math.max(12, v.s0 + v.v * v.T + (v.v * v.v) / (2 * Math.sqrt(v.a * v.b)) + 10)
    if (d > commitDist) return
    // solo el primero de la fila (o quien va detrás de alguien que ya tiene paso)
    const lane = v.lane!
    const idx = lane.vehs.indexOf(v)
    const ahead = lane.vehs[idx + 1]
    if (ahead && !ahead.committed) {
      v.why = 'fila'
      v.blocker = ahead
      return
    }
    if (!this.canCommit(v, m, d)) return
    v.why = ''
    v.committed = true
    // intermitente: +1 derecha, -1 izquierda
    v.blink = m.turn === 'kerb' ? this.net!.side : m.turn === 'far' || m.turn === 'u' ? -this.net!.side : 0
    // el orden de llegada en la lista: por distancia a la línea
    m.committed.push(v)
  }

  private canCommit(v: Veh, m: Move, d: number): boolean {
    const c = m.cluster
    // paso a nivel cerrado en el cruce
    if (this.rail && m.rail.some((c) => this.rail!.crossingClosed(c))) return this.no(v, 'paso a nivel cerrado')
    // camino que se dobla sobre sí mismo: de uno en uno
    if (m.single && (m.vehs.length > 0 || m.tails.length > 0 || m.committed.some((u) => u !== v))) return this.no(v, 'camino doblado ocupado', m.vehs[0] ?? null)
    // semáforo
    if (m.phase >= 0) {
      const st = lightState(c, m.phase, this.t)
      if (st === 'R') return this.no(v, 'rojo')
      if (st === 'A' && d > (v.v * v.v) / 6 + 2) return this.no(v, 'ámbar')
    }
    // sitio a la salida
    const T = m.to.lanes[m.toLane]
    if (T.link.to !== null || T.link.s1 - T.link.s0 < 200) {
      const span = T.link.s1 - T.link.s0
      let free: number
      if (T.vehs.length) {
        free = T.vehs[0].s - T.vehs[0].len - T.link.s0
        if (T.vehs[0].v > 8) free += 8
      } else if (T.tails.length) {
        free = Infinity
        for (const t of T.tails) free = Math.min(free, span - (t.v.len - (t.v.odo - t.odo)))
      } else free = T.link.to === null ? 1e9 : Math.max(span, v.len + 2)
      let need = v.len + 2
      for (const mi of T.ins) {
        for (const u of mi.vehs) need += u.len + 2
        for (const u of mi.committed) if (u !== v) need += u.len + 2
      }
      if (free < need) return this.no(v, `salida llena (${free.toFixed(0)}<${need.toFixed(0)})`, T.vehs[0] ?? T.tails[0]?.v ?? null)
    }
    for (const z of m.laneZones) {
      if (laneOccupied(z.lane, z.s0, z.s1, v)) return this.no(v, 'carril ajeno ocupado')
      // los que se acercan por ese carril tienen preferencia
      const tClear = eta(v.v, v.a, d + z.a1 + v.len) + 1.5
      for (const u of z.lane.vehs) {
        if (u.s >= z.s0 || z.s0 - u.s > 150) continue
        if (u.v < 0.5 && z.s0 - u.s > 8) continue
        if (eta(u.v, u.a, z.s0 - u.s) < tClear) return this.no(v, `cede a ${u.id} (carril ajeno)`, u)
      }
    }
    const pV = -d
    const tVzone = (z: Zone) => eta(v.v, v.a, d + z.a0)
    for (const z of m.zones) {
      const B = z.other
      // los que ya tienen paso o están dentro
      const occ = (u: Veh, pu: number): boolean => {
        if (u === v) return true
        if (z.wide && v.len < LONG && u.len < LONG) return true
        if (pu - u.len - sweep(u) > z.b1 + 0.5) return true
        if (z.cross) {
          // ya dentro o a punto: habrá salido antes de que lleguemos?
          if (pu < z.b0 - 3) return false
          const tOut = eta(u.v, u.a, z.b1 + u.len + sweep(u) - pu) + 1.5
          return tOut < eta(v.v, v.a, d + z.a0)
        }
        const ua = mapToA(z, pu)
        if (ua > pV) return true // irá delante: se le sigue
        // iría detrás de nosotros: que le dé tiempo
        const tu = eta(u.v, u.a, Math.max(0, z.b0 - pu))
        return tu - tVzone(z) >= 2
      }
      for (const u of B.vehs) if (!occ(u, u.s)) return this.no(v, `${z.cross ? 'cruza' : 'comparte'} con ${u.id} dentro`, u)
      for (const t of B.tails) if (!occ(t.v, B.len + (t.v.odo - t.odo))) return this.no(v, `${z.cross ? 'cruza' : 'comparte'} con la cola de ${t.v.id}`, t.v)
      for (const u of B.committed) if (u.lane && !occ(u, -(u.lane.link.s1 - u.s))) return this.no(v, `${z.cross ? 'cruza' : 'comparte'} con ${u.id} que ya tiene paso${u.stuck > 30 ? ' (atascado)' : ''}`, u)
      if (c.kind === 'roundabout') continue
      // los que se acercan con preferencia (o llegaron antes, entre iguales)
      const src = B.from.lanes[B.lane]
      const bz = B.zones.find((q) => q.other === m)
      const theyYield = bz ? bz.yieldMe : false
      for (const u of src.vehs) {
        if (u === v || u.committed || u.plan !== B) continue
        if (z.wide && v.len < LONG && u.len < LONG) continue
        const du = B.from.s1 - u.s
        if (du > 150) continue
        // quien espera con la salida llena no va a pasar: no se le espera
        if (u.v < 0.5 && u.why.startsWith('salida')) continue
        if (z.yieldMe) {
          // atasco mutuo: si los dos están parados hace rato, pasa el que lleva más
          if (v.waitT > 8 && u.v < 0.5 && u.waitT < v.waitT) continue
          const tu = u.v < 0.5 && du < 4 ? 2.5 : eta(u.v, u.a, du + z.b0)
          if (z.cross) {
            const tClear = eta(v.v, v.a, d + z.a1 + v.len) + 0.5
            if (tu < tClear + 2) return this.no(v, `cede a ${u.id}`, u)
          } else if (tu < tVzone(z) + 2.5) return this.no(v, `cede a ${u.id} (incorporación)`, u)
        } else if (!theyYield) {
          // iguales: primero el que llegó antes a la línea
          if (u.arrive > 0 && (v.arrive === 0 || u.arrive < v.arrive) && !(v.waitT > 10 && u.waitT < v.waitT)) return this.no(v, `llegó antes ${u.id}`, u)
        }
      }
    }
    return true
  }

  /**
   * Reserva de un tramo exclusivo para una corriente (carril o movimiento): true si v puede entrar.
   * Se coge al llegar a la distancia de frenado (si está libre) y se mantiene mientras haya alguien
   * de esa corriente dentro o a punto de entrar; si nadie la renueva en 0,5 s queda libre. Los de la
   * misma corriente van en fila y se siguen. `respectOnly`: no la coge (solo respeta una ajena).
   */
  private claim(tok: Token, stream: object, dist: number, v: Veh, respectOnly: boolean): boolean {
    const now = this.t
    const dReq = (v.v * v.v) / 6 + 4
    // parado lejos de la entrada: no la retiene (que otro pueda pasar)
    const wants = dist < 0 || (dist <= dReq && !(v.v < 0.5 && dist > 3))
    if (tok.stream === stream) {
      if (wants && !respectOnly) tok.t = now
      return true
    }
    if (tok.stream && now - tok.t < 0.5) return false
    if (wants && !respectOnly) {
      tok.stream = stream
      tok.t = now
    }
    return true
  }

  private no(v: Veh, why: string, by: Veh | null = null): boolean {
    v.why = why
    v.blocker = by
    return false
  }

  // -------------------------------------------------------------------------
  // Cambios de carril
  // -------------------------------------------------------------------------

  private laneChange(v: Veh): void {
    const lane = v.lane!
    const l = lane.link
    if (l.n < 2 || v.committed || v.lcT > 0) return
    const toEnd = l.s1 - v.s
    const need = v.next !== null && !v.next.byLane[lane.i]
    if (v.s - v.len < l.s0 + 2) return
    if (!need && toEnd < 30) return
    // carriles desde los que sale la ruta elegida
    let dirNeed = 0
    if (need) {
      const ok = v.next!.byLane.map((m, i) => (m ? i : -1)).filter((i) => i >= 0)
      if (ok.length) dirNeed = ok[0] > lane.i ? 1 : -1
    }
    const cur = this.laneAccel(v, lane)
    let best: Lane | null = null
    let bestGain = 0.25
    for (const dir of [-1, 1]) {
      const ti = lane.i + dir
      if (ti < 0 || ti >= l.n) continue
      if (need && dir !== dirNeed) continue
      const target = l.lanes[ti]
      // no cambiarse a un tramo que toca otra calzada ocupada
      if (target.near.some((z) => z.s0 < v.s + 5 && z.s1 > v.s - v.len - 5 && nearOccupied(z, v))) continue
      const { lead, follow } = neighbours(target, v.s)
      // hueco físico (más con velocidad)
      if (lead && lead.s - lead.len - v.s < Math.max(2, v.v * 0.6)) continue
      if (follow && v.s - v.len - follow.s < Math.max(2, follow.v * 0.6)) continue
      const aNew = lead ? this.idm(v, v.vcap, lead.s - lead.len - v.s, lead.v) : this.free(v, v.vcap)
      let fGain = 0
      if (follow) {
        const fNew = this.idm(follow, follow.vcap, v.s - v.len - follow.s, v.v)
        if (fNew < (need ? -3.5 : -2.5)) continue
        const fOld = lead ? this.idm(follow, follow.vcap, lead.s - lead.len - follow.s, lead.v) : this.free(follow, follow.vcap)
        fGain = fNew - fOld
      }
      let gain = aNew - cur + 0.2 * fGain
      // por la derecha (o la izquierda) salvo para adelantar
      gain += dir < 0 ? 0.25 : -0.25
      if (need) gain += 2 + 40 / Math.max(toEnd, 5)
      if (gain > bestGain) {
        bestGain = gain
        best = target
      }
    }
    if (best && this.bodies.size > 0) {
      // la caja ya en el carril de destino (sin el desplazamiento de la maniobra)
      const keep = { lane: v.lane, lcT: v.lcT }
      v.lane = best
      v.lcT = 0
      const bs = this.boxesFor(v, 0)
      v.lane = keep.lane
      v.lcT = keep.lcT
      for (const b of bs) {
        const cx = Math.floor(b.cx / 16)
        const cz = Math.floor(b.cz / 16)
        for (let dz = -1; dz <= 1 && best; dz++) {
          for (let dx = -1; dx <= 1 && best; dx++) {
            for (const o of this.bodies.get((cx + dx) * 100003 + cz + dz) ?? []) {
              if (o.v === v || !sameLevel(b, o) || o.v.dead) continue
              if (obb(b, o)) {
                best = null
                break
              }
            }
          }
        }
      }
    }
    if (best) {
      removeFrom(lane.vehs, v)
      insertSorted(best.vehs, v)
      v.lcOff = l.off[lane.i] - l.off[best.i] + (v.lcT > 0 ? v.lcOff * (v.lcT / 3) : 0)
      v.lcT = 3
      v.lcFrom = lane
      v.blink = (best.i < lane.i ? 1 : -1) * this.net!.side
      v.lane = best
      v.plan = v.next ? v.next.byLane[best.i] : null
      this.counters.laneChanges++
      return
    }
    if (need && toEnd < 30) {
      // no ha podido ponerse en su carril: otra salida desde este
      const opts = l.outs.filter((o) => o.byLane[lane.i] && (o.to.live || !l.outs.some((q) => q.byLane[lane.i] && q.to.live)))
      if (opts.length) {
        const o = opts[Math.floor(this.rand() * opts.length)]
        v.next = o
        v.plan = o.byLane[lane.i]
        this.counters.replans++
      }
    }
  }

  private laneAccel(v: Veh, lane: Lane): number {
    const idx = lane.vehs.indexOf(v)
    const lead = lane.vehs[idx + 1]
    return lead ? this.idm(v, v.vcap, lead.s - lead.len - v.s, lead.v) : this.free(v, v.vcap)
  }

  // -------------------------------------------------------------------------
  // Entradas y salidas
  // -------------------------------------------------------------------------

  private updateScale(): void {
    const net = this.net
    if (!net) return
    let want = 0
    for (const l of net.links) if (l.live) want += (l.density * l.n * Math.max(0, l.s1 - l.s0)) / 1000
    want *= hourFactor(this.hour) * this.density
    this.scale = want > this.cap ? this.cap / want : 1
  }

  private spawn(dt: number): void {
    const net = this.net!
    if (Math.floor(this.t / 5) !== Math.floor((this.t - dt) / 5)) this.updateScale()
    if (this.vehs.length >= this.cap) return
    const hf = hourFactor(this.hour) * this.density * this.scale
    for (const l of net.entries) {
      if (!l.live) continue
      const v0 = l.vmax[0]
      for (const lane of l.lanes) {
        // flujo = densidad × velocidad (vehículos por segundo)
        const rate = (l.density * hf * v0 * 0.8) / 1000
        const acc = (this.spawnAcc.get(lane) ?? this.rand()) + rate * dt
        if (acc < 1) {
          this.spawnAcc.set(lane, acc)
          continue
        }
        const first = lane.vehs[0]
        let type = this.pickType(l.rank)
        if (!l.heavy && VTYPES[type].trailer > 0) type = 4
        // tramo de entrada más corto que el vehículo: no cabe (entrará por otro sitio)
        if (l.s1 < VTYPES[type].len + 8) {
          this.spawnAcc.set(lane, Math.min(acc, 1.5))
          continue
        }
        const T = VTYPES[type]
        if (first && first.s - first.len < T.len + 10) {
          this.spawnAcc.set(lane, Math.min(acc, 1.5))
          continue
        }
        // ni encima de otra calzada pegada a esta que esté ocupada
        const probe = { id: -1, s: 0, len: T.len, v: 0 } as unknown as Veh
        if (lane.near.some((z) => z.s0 < T.len + 5 && nearOccupied(z, probe))) {
          this.spawnAcc.set(lane, Math.min(acc, 1.5))
          continue
        }
        const v = this.newVeh(type)
        v.lane = lane
        v.s = T.len
        // ni encima de un tren o tranvía (ni de nadie) que pase por ahí
        const bs = this.boxesFor(v, 0)
        if (this.bodies.size > 0 && bs.some((b) => this.bodyHits(b, v))) {
          this.spawnAcc.set(lane, Math.min(acc, 1.5))
          continue
        }
        // ya en la rejilla: el tranvía que viene lo ve en su próximo paso
        this.bodyOf.set(v, bs)
        for (const b of bs) this.gridAdd(b)
        this.spawnAcc.set(lane, acc - 1)
        v.v = first ? Math.min(first.v, v0 * 0.8) : Math.min(v0, v.vcap) * 0.8
        lane.vehs.unshift(v)
        this.vehs.push(v)
        this.choosePlan(v)
        this.counters.spawned++
      }
    }
  }

  private pickType(rank: number): number {
    const mix = MIX[Math.max(0, Math.min(6, rank))]
    let r = this.rand()
    for (let i = 0; i < mix.length; i++) {
      r -= mix[i]
      if (r <= 0) return i
    }
    return 0
  }

  private newVeh(type: number): Veh {
    const T = VTYPES[type]
    const vf = 0.88 + this.rand() * 0.22
    return {
      id: this.nextId++,
      type,
      len: T.len,
      width: T.width,
      a: T.a * (0.85 + this.rand() * 0.3),
      b: T.b,
      T: T.T * (0.85 + this.rand() * 0.35),
      s0: 2,
      vf,
      vcap: T.vmax,
      lane: null,
      move: null,
      s: 0,
      v: 0,
      acc: 0,
      odo: 0,
      next: null,
      plan: null,
      committed: false,
      waitT: 0,
      arrive: 0,
      lcOff: 0,
      lcT: 0,
      lcFrom: null,
      lcTimer: this.rand(),
      hist: [],
      color: Math.floor(this.rand() * 1e6),
      blink: 0,
      doomed: false,
      stuck: 0,
      dead: false,
      gap: Infinity,
      why: '',
      blocker: null,
    }
  }

  /** a más de 600 m de la cámara (o sin cámara) */
  farFromCamera(v: Veh): boolean {
    const c = this.camera
    if (!c) return true
    const p = { x: 0, z: 0 }
    this.pointOf(v, 0, p)
    return Math.hypot(p.x - c.x, p.z - c.z) > 600
  }

  remove(v: Veh): void {
    if (v.dead) return
    v.dead = true
    if (v.lane) removeFrom(v.lane.vehs, v)
    if (v.move) removeFrom(v.move.vehs, v)
    if (v.plan) removeFrom(v.plan.committed, v)
  }

  // -------------------------------------------------------------------------
  // Posiciones
  // -------------------------------------------------------------------------

  /** Punto del eje del vehículo a `back` metros por detrás del frontal (x, z y altura). */
  pointOf(v: Veh, back: number, out: { x: number; z: number; y?: number }): boolean {
    const side = this.net!.side
    let s = v.s - back
    if (v.lane) {
      const l = v.lane.link
      const start = v.hist.length ? l.s0 : -Infinity
      if (s >= start) {
        const k = v.lcT > 0 ? smooth(v.lcT / 3) : 0
        linkPose(l, s, l.off[v.lane.i] + v.lcOff * k, side, P)
        out.x = P.x
        out.z = P.z
        out.y = linkY(l, s)
        return true
      }
      s -= start
    } else if (v.move) {
      if (s >= 0) {
        moveAt(v.move, s, out)
        return true
      }
    }
    // en tramos anteriores
    for (const h of v.hist) {
      const at = h.end + s
      if (h.move) {
        if (at >= 0 || h === v.hist[v.hist.length - 1]) {
          moveAt(h.move, Math.max(0, at), out)
          return true
        }
        s = at
      } else if (h.lane) {
        const l = h.lane.link
        if (at >= l.s0 || h === v.hist[v.hist.length - 1]) {
          linkPose(l, Math.max(0, at), h.off, side, P)
          out.x = P.x
          out.z = P.z
          out.y = linkY(l, at)
          return true
        }
        s = at - l.s0
      }
    }
    // sin historia (recién aparecido): prolonga hacia atrás el tramo actual
    if (v.lane) {
      const l = v.lane.link
      linkPose(l, Math.max(0, v.s - back), l.off[v.lane.i], side, P)
      out.x = P.x
      out.z = P.z
      out.y = linkY(l, v.s - back)
    } else if (v.move) moveAt(v.move, 0, out)
    return true
  }

  /** Punto a `d` metros por delante del frontal siguiendo la ruta prevista (false si no se sabe). */
  private aheadPoint(v: Veh, d: number, out: { x: number; z: number }): boolean {
    const side = this.net!.side
    if (v.lane) {
      const l = v.lane.link
      const at = v.s + d
      if (at <= l.s1) {
        linkPose(l, at, l.off[v.lane.i], side, P)
        out.x = P.x
        out.z = P.z
        return true
      }
      const m = v.plan
      if (!m) return false
      const q = at - l.s1
      if (q <= m.len) {
        moveAt(m, q, out)
        return true
      }
      const T = m.to
      linkPose(T, Math.min(T.len, T.s0 + q - m.len), T.off[m.toLane], side, P)
      out.x = P.x
      out.z = P.z
      return true
    }
    if (v.move) {
      const m = v.move
      const at = v.s + d
      if (at <= m.len) {
        moveAt(m, at, out)
        return true
      }
      const T = m.to
      linkPose(T, Math.min(T.len, T.s0 + at - m.len), T.off[m.toLane], side, P)
      out.x = P.x
      out.z = P.z
      return true
    }
    return false
  }

  /** ¿Va por un túnel (no se ve)? ¿Por un puente (y a qué capa)? */
  where(v: Veh): { tunnel: boolean; bridge: boolean; layer: number } {
    if (v.move) {
      // un cruce sobre un puente (enlace en paso elevado): el nivel de las calles que une
      const m = v.move
      const a = m.from.bri[m.from.bri.length - 1]
      const b = m.to.bri[0]
      const bridge = a === 1 || b === 1
      const layer = a === 1 ? m.from.layer[m.from.layer.length - 1] : b === 1 ? m.to.layer[0] : 0
      return { tunnel: m.hidden, bridge, layer }
    }
    if (!v.lane) return { tunnel: false, bridge: false, layer: 0 }
    const l = v.lane.link
    // por cualquiera de sus puntas (a medio subir a un puente ya está por encima de lo de debajo)
    let tunnel = 0
    let bridge = false
    let layer = 0
    for (const at of [v.s, v.s - v.len / 2, v.s - v.len]) {
      const i = segIndex(l, at)
      const b = l.bri[i]
      if (b === -1) tunnel++
      if (b === 1) bridge = true
      if (b !== 0 && Math.abs(l.layer[i]) > Math.abs(layer)) layer = l.layer[i]
    }
    return { tunnel: tunnel >= 2, bridge, layer }
  }

  /**
   * Un tramo del vehículo (de `back0` a `back1` m por detrás del frontal) partido donde cambia el nivel
   * de lo que pisa, siguiendo su camino (carril o cruce actual y los anteriores): [desde, hasta, nivel],
   * con nivel -1000 en un túnel, 0 a nivel y 100 + capa en un puente. Así la tractora puede ir ya por
   * la rampa de un puente o salir de la boca de un túnel con el remolque aún debajo de otra calle.
   */
  pieces(v: Veh, back0: number, back1: number): Array<[number, number, number]> {
    const out: Array<[number, number, number]> = []
    // trozo del camino [from, to] (en metros por detrás del frontal) con nivel lvl
    const emit = (from: number, to: number, lvl: number) => {
      const a = Math.max(from, back0)
      const c = Math.min(to, back1)
      if (c <= a) return
      const last = out[out.length - 1]
      if (last && last[2] === lvl) last[1] = c
      else out.push([a, c, lvl])
    }
    // un enlace recorrido hacia atrás desde sFront (que está a `back` del frontal) hasta sRear
    const walk = (l: Link, sFront: number, sRear: number, back: number) => {
      for (let i = segIndex(l, sFront); i >= 0; i--) {
        const top = Math.min(sFront, l.s[i + 1] ?? Infinity)
        const bot = i === 0 ? sRear : Math.max(sRear, l.s[i])
        if (top > bot) emit(back + sFront - top, back + sFront - bot, l.bri[i] === -1 ? -1000 : l.bri[i] === 1 ? 100 + l.layer[i] : 0)
        if (bot <= sRear || back + sFront - bot >= back1) break
      }
    }
    let back = 0
    if (v.lane) {
      const l = v.lane.link
      const start = v.hist.length ? l.s0 : -Infinity
      // (comprobando un avance, desde donde estará el frontal)
      const lead = Math.max(0, -back0)
      walk(l, v.s + lead, start, -lead)
      back = v.s - start
    } else if (v.move) {
      emit(0, v.hist.length ? v.s : Infinity, moveLevel(v.move))
      back = v.s
    }
    for (let k = 0; k < v.hist.length && back < back1; k++) {
      const h = v.hist[k]
      const lastH = k === v.hist.length - 1
      if (h.move) {
        const len = lastH ? Infinity : h.end
        emit(back, back + len, moveLevel(h.move))
        back += len
      } else if (h.lane) {
        const l = h.lane.link
        const bottom = lastH ? -Infinity : l.s0
        walk(l, h.end, bottom, back)
        back += h.end - bottom
      }
    }
    if (out.length === 0) out.push([back0, back1, 0])
    // lo que cae por delante del final del tramo actual (comprobando un avance) o por detrás de todo
    // lo recorrido: con el nivel del trozo más cercano
    out[0][0] = back0
    out[out.length - 1][1] = back1
    return out
  }
}

// ---------------------------------------------------------------------------

/** nivel de un cruce: el de las calles que une (-1000 si va por dentro de un túnel) */
function moveLevel(m: Move): number {
  if (m.hidden) return -1000
  const a = m.from.bri[m.from.bri.length - 1]
  const b = m.to.bri[0]
  if (a === 1) return 100 + m.from.layer[m.from.layer.length - 1]
  if (b === 1) return 100 + m.to.layer[0]
  return 0
}

function segIndex(l: Link, s: number): number {
  const n = l.s.length
  let lo = 0
  let hi = n - 1
  const a = Math.max(0, Math.min(l.len, s))
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1
    if (l.s[m] <= a) lo = m
    else hi = m
  }
  return Math.min(lo, l.bri.length - 1)
}

export function linkY(l: Link, s: number): number {
  const n = l.s.length
  let lo = 0
  let hi = n - 1
  const a = Math.max(0, Math.min(l.len, s))
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1
    if (l.s[m] <= a) lo = m
    else hi = m
  }
  const t = (a - l.s[lo]) / (l.s[hi] - l.s[lo] || 1)
  return l.y[lo] + (l.y[hi] - l.y[lo]) * t
}

export function moveAt(m: Move, s: number, out: { x: number; z: number; y?: number }): void {
  const k = m.s.length
  const a = Math.max(0, Math.min(m.len, s))
  // muestras cada ~1 m: índice directo
  let i = Math.min(k - 2, Math.floor((a / m.len) * (k - 1)))
  while (i > 0 && m.s[i] > a) i--
  while (i < k - 2 && m.s[i + 1] < a) i++
  const t = (a - m.s[i]) / (m.s[i + 1] - m.s[i] || 1)
  out.x = m.x[i] + (m.x[i + 1] - m.x[i]) * t
  out.z = m.z[i] + (m.z[i + 1] - m.z[i]) * t
  out.y = m.y[i] + (m.y[i + 1] - m.y[i]) * t
}

/** posición de otro movimiento (en un tramo compartido) pasada a este */
function mapToA(z: Zone, pb: number): number {
  if (pb <= z.b0 || z.mapB.length === 0) return z.a0 - (z.b0 - pb)
  if (pb >= z.b1) return z.a1 + (pb - z.b1)
  let best = 0
  let bd = Infinity
  for (let i = 0; i < z.mapB.length; i++) {
    const d = Math.abs(z.mapB[i] - pb)
    if (d < bd) {
      bd = d
      best = i
    }
  }
  return z.mapA[best] + (pb - z.mapB[best])
}

/** tiempo para recorrer d metros (acelerando si va despacio) */
function eta(v: number, a: number, d: number): number {
  if (d <= 0) return 0
  if (v > 3) return d / v
  return (Math.sqrt(v * v + 2 * a * d) - v) / a + (v < 0.5 ? 0.8 : 0)
}

/** ¿Está ocupado el tramo del otro carril (o va a entrar alguien en él antes que v)? */
function nearOccupied(z: { other: Lane; o0: number; o1: number; s0: number; wide: boolean }, v: Veh): boolean {
  for (const u of z.other.vehs) {
    if (u === v) continue
    if (z.wide && v.len < LONG && u.len < LONG) continue
    if (u.s > z.o0 && u.s - u.len - sweep(u) < z.o1) return true
    // los dos a punto de entrar: pasa el que está más cerca (y a igualdad, el de menor número)
    const du = z.o0 - u.s
    if (du > 0 && du < 4 + u.v * 1.5) {
      const dv = z.s0 - v.s
      if (du < dv || (du === dv && u.id < v.id)) return true
    }
  }
  return false
}

/** ¿Hay alguien (que no sea v) entre s0 y s1 del carril? */
function laneOccupied(lane: Lane, s0: number, s1: number, v: Veh): boolean {
  for (const u of lane.vehs) if (u !== v && u.s > s0 && u.s - u.len - sweep(u) < s1) return true
  return false
}

/** ¿Hay alguien (que no sea v) en el tramo a0..a1 del movimiento (o a punto de entrar)? */
function moveOccupies(m: Move, a0: number, a1: number, v: Veh): boolean {
  for (const u of m.vehs) if (u !== v && u.s > a0 && u.s - u.len - sweep(u) < a1) return true
  for (const t of m.tails) if (t.v !== v && m.len + (t.v.odo - t.odo) - t.v.len - sweep(t.v) < a1) return true
  for (const u of m.committed) if (u !== v && u.lane && u.lane.link.s1 - u.s < 6 && u.v > 1 && a0 < 3) return true
  return false
}

interface Body {
  v: Veh
  cx: number
  cz: number
  ux: number
  uz: number
  hl: number
  hw: number
  lvl: number
  /** copia de un tranvía en otro nivel: solo cuenta con lo que va en paralelo (el mismo puente) */
  par?: boolean
}

/** ¿esas dos cajas están en el mismo nivel? (las copias de los tranvías, solo en paralelo) */
function sameLevel(a: Body, o: Body): boolean {
  if (a.lvl !== o.lvl) return false
  if (!o.par && !a.par) return true
  return Math.abs(a.ux * o.ux + a.uz * o.uz) > 0.85
}
const _bf = { x: 0, z: 0, y: 0 }
/** marcador de «coche de tren» en la rejilla de seguridad */
const TRAIN = { lane: null, move: null, dead: false } as unknown as Veh
const _br = { x: 0, z: 0, y: 0 }

/** solape de dos cajas orientadas (planta) */
function obb(a: Body, b: Body): boolean {
  const dx = b.cx - a.cx
  const dz = b.cz - a.cz
  const axes = [a.ux, a.uz, -a.uz, a.ux, b.ux, b.uz, -b.uz, b.ux]
  for (let i = 0; i < 8; i += 2) {
    const x = axes[i]
    const z = axes[i + 1]
    const ra = a.hl * Math.abs(a.ux * x + a.uz * z) + a.hw * Math.abs(-a.uz * x + a.ux * z)
    const rb = b.hl * Math.abs(b.ux * x + b.uz * z) + b.hw * Math.abs(-b.uz * x + b.ux * z)
    if (Math.abs(dx * x + dz * z) > ra + rb) return false
  }
  return true
}

/** cuánto se meten dos cajas una en otra (m; negativo = separadas por esa distancia) */
function depth(a: Body, b: Body): number {
  const dx = b.cx - a.cx
  const dz = b.cz - a.cz
  const axes = [a.ux, a.uz, -a.uz, a.ux, b.ux, b.uz, -b.uz, b.ux]
  let d = Infinity
  for (let i = 0; i < 8; i += 2) {
    const x = axes[i]
    const z = axes[i + 1]
    const ra = a.hl * Math.abs(a.ux * x + a.uz * z) + a.hw * Math.abs(-a.uz * x + a.ux * z)
    const rb = b.hl * Math.abs(b.ux * x + b.uz * z) + b.hw * Math.abs(-b.uz * x + b.ux * z)
    d = Math.min(d, ra + rb - Math.abs(dx * x + dz * z))
  }
  return d
}

/** lo que barre de más la cola de un vehículo largo al salir de una curva (m) */
function sweep(u: Veh): number {
  return u.len >= LONG ? 4 : 0
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t)
}

function removeFrom<T>(arr: T[], x: T): void {
  const i = arr.indexOf(x)
  if (i >= 0) arr.splice(i, 1)
}

function insertSorted(arr: Veh[], v: Veh): void {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (arr[m].s < v.s) lo = m + 1
    else hi = m
  }
  arr.splice(lo, 0, v)
}

function neighbourIndex(lane: Lane, s: number): number {
  const arr = lane.vehs
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (arr[m].s < s) lo = m + 1
    else hi = m
  }
  return lo
}

function neighbours(lane: Lane, s: number): { lead: Veh | null; follow: Veh | null } {
  const arr = lane.vehs
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (arr[m].s < s) lo = m + 1
    else hi = m
  }
  return { lead: arr[lo] ?? null, follow: arr[lo - 1] ?? null }
}
