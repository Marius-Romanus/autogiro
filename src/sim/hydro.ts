// El agua para el modelo de vuelo: lo que se mete en ella flota, frena y, a velocidad, planea.
//
// El aparato lleva un "casco" hecho de elementos sencillos (esferas y tramos de cilindro tumbado a lo
// largo del eje x del cuerpo), cada uno con su volumen, sus resistencias en los tres ejes del cuerpo
// y, si tiene fondo que planea, su superficie de planeo:
//
//  - la góndola de un autogiro de ruedas: unas esferas a lo largo de la quilla, entre el morro y el
//    motor, sacadas de los puntos de la célula (`morro`, `panza`, `costados`). Flota un rato y se va
//    llenando de agua (no es estanca: cabina abierta, huecos del tren, bajos del motor);
//  - las ruedas (neumáticos con aire: flotan un poco y frenan mucho; meten el morro en el agua y el
//    aparato vuelca hacia delante: lo que pasa de verdad en un amerizaje con tren fijo);
//  - la cola (estabilizador y derivas: placas que frenan mucho de canto);
//  - los flotadores de un hidroautogiro (`floats` en la ficha): cascos estancos en tramos, con fondo
//    que planea (la fuerza normal al fondo con el ángulo con que le llega el agua levanta el flotador
//    a velocidad: "subirse al redan") y timones de agua en la popa que van con los pedales.
//
// Por cada elemento mojado: empuje de Arquímedes (ρ·g·volumen sumergido) en su centro, resistencia
// ½ρ·CdA·|u|·u en ejes del cuerpo y planeo. La resistencia del agua es ~800 veces la del aire: cada
// fuerza se limita con lo que puede frenar en un paso sin invertir la velocidad del punto (implícito
// aproximado), o el integrador explícito explotaría.
//
// También detecta lo que acaba en accidente: entrar en el agua demasiado rápido (un flotador o la
// góndola que golpean a más de unos metros por segundo), una deceleración brutal (el tren clavándose
// a 80 km/h), o que el aparato se hunda. Y deja apuntados los chapoteos para los efectos.

import { Quaternion, Vector3 } from 'three'
import type { Airframe } from './airframes.ts'
import type { CrashInfo } from './autogyro.ts'
import { addStrings, partLabel, t } from '../i18n.ts'

export const RHO_WATER = 1000
const G = 9.80665

/** Agua bajo un punto: lo da el escenario (0 = tierra). La superficie es la altura del suelo ahí. */
export interface WaterGround {
  heightAt(x: number, z: number, outNormal: Vector3): number
  waterDepth?(x: number, z: number): number
}

/** Un flotador: casco estanco de la proa a la popa (modelo; x adelante, y arriba, z derecha). */
export interface FloatSpec {
  /** centro de la proa y de la popa (a la altura del eje del flotador) */
  bow: Vector3
  stern: Vector3
  /** radio (medio ancho) del flotador */
  radius: number
  /** nombre para los mensajes (p. ej. 'flotador izquierdo') */
  name: string
  /** superficie del timón de agua de la popa (m²); 0: sin timón */
  rudder?: number
  /**
   * x del redán (modelo). Detrás de él el agua se despega del fondo: esos tramos flotan y frenan, pero
   * no planean. Lo que planea queda delante y, con velocidad, el casco se pone morro arriba sobre el
   * redán (si falta, planea todo el flotador).
   */
  step?: number
  /**
   * Ángulo del fondo de delante del redán respecto al eje del flotador (rad): en un flotador de verdad la
   * quilla de proa sube un poco hacia delante, y sobre el redán planea con ese ángulo aunque el aparato
   * vaya nivelado (si falta, 0).
   */
  forebodyTrim?: number
}

export type HullKind = 'hull' | 'float' | 'gear' | 'part'

/** Elemento del casco. Coordenadas del modelo (como los puntos de `airframes.ts`). */
export interface HullElement {
  name: string
  kind: HullKind
  p: Vector3
  r: number
  /** 0: esfera; > 0: tramo de cilindro tumbado a lo largo de x de esta longitud */
  len: number
  /** resistencia (Cd·A, m²) totalmente sumergido, en ejes del cuerpo: x adelante, y arriba, z lado */
  cdA: Vector3
  /** superficie de fondo que planea (m²) con el elemento bien mojado; 0: nada */
  planing: number
  /** fracción del volumen que desplaza agua de verdad (casco estanco 1; góndola abierta menos) */
  tight: number
  /** segundos que tarda en llenarse de agua sumergido; Infinity: estanco */
  flood: number
  /** fracción de `tight` que sigue flotando ya llena (espuma, depósito, neumáticos) */
  residual: number
  /** velocidad (m/s) de entrada en el agua de abajo arriba que rompe la pieza; Infinity: no se comprueba */
  entry: number
  /** timón de agua (m²): placa vertical que gira con los pedales */
  rudder: number
  /** eslora del casco al que pertenece (m), para la resistencia de ola; 0: ninguna */
  lwl: number
  /**
   * Cuánto sube el fondo hacia proa en este tramo (rad): la curva de la proa de un flotador o del
   * morro. El agua le llega con ese ángulo de más y lo levanta en cuanto hay velocidad: es lo que pone
   * el casco morro arriba y lo sube al redan en vez de dejar que la proa se clave.
   */
  rake: number
  /** rueda anfibia que se recoge dentro del flotador (m que sube); no cuenta con el tren arriba */
  retract?: number
}

/** Chapoteo: una pieza que entra en el agua (para los efectos). Mundo. */
export interface SplashEvent {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  /** tamaño de lo que entra (m) */
  size: number
}

/** Lo que está mojado ahora mismo (para la espuma, la estela y los rociones). Mundo. */
export interface WetPoint {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  /** 0..1 cuánto está metido */
  wet: number
  size: number
  kind: HullKind
  /** elemento al que pertenece (los tramos de un flotador comparten nombre) y su x en el cuerpo */
  name: string
  along: number
}

export type HydroFailure = { kind: 'entry'; part: string; speed: number } | { kind: 'impact'; g: number; speed: number } | { kind: 'sunk' }

interface State {
  e: HullElement
  wasWet: boolean
  /** 0..1 lo que se ha llenado de agua */
  flooded: number
}

const _rb = new Vector3()
const _rw = new Vector3()
const _u = new Vector3()
const _vw = new Vector3()
const _fb = new Vector3()
const _fw = new Vector3()
const _n = new Vector3()
const _t = new Vector3()
const _dyn = new Vector3()
const _qInv = new Quaternion()

/**
 * Casco por defecto de un autogiro de ruedas: góndola (esferas a lo largo de la quilla), ruedas,
 * cola y lo que sobresale por debajo; más los flotadores de la ficha si los lleva.
 */
export function hullFor(af: Airframe): HullElement[] {
  if (af.hull) return af.hull.map((h) => ({ ...h, p: h.p.clone(), cdA: h.cdA.clone() }))
  const out: HullElement[] = []
  const base = (o: Partial<HullElement> & Pick<HullElement, 'name' | 'kind' | 'p' | 'r'>): HullElement => ({
    len: 0,
    cdA: new Vector3(0.05, 0.05, 0.05),
    planing: 0,
    tight: 0,
    flood: Infinity,
    residual: 1,
    entry: Infinity,
    rudder: 0,
    lwl: 0,
    rake: 0,
    ...o,
  })
  const cps = af.crashPoints
  const named = (re: RegExp) => cps.filter((c) => re.test(c.name)).map((c) => c.p)
  const wheelBottom = Math.min(af.mainL.y, af.noseWheel?.y ?? Infinity, af.tailWheel?.y ?? Infinity)

  // --- góndola o fuselaje ---
  const noses = named(/^morro/)
  const bellies = named(/^panza|^quilla/)
  const sides = named(/^costado/)
  const noseX = noses.length ? Math.max(...noses.map((p) => p.x)) : (af.noseWheel?.x ?? af.mainL.x + 1.6) + 0.4
  const bellyY = bellies.length ? Math.min(...bellies.map((p) => p.y)) : wheelBottom + 0.3
  const halfW = sides.length ? Math.max(...sides.map((p) => Math.abs(p.z))) : 0.42
  // por detrás, hasta el motor (la hélice propulsora va justo detrás); en los tractores, hasta el mástil
  const aftX = af.prop.x < af.cg.x ? af.prop.x + 0.35 : af.hub.x - 0.4
  const rr = Math.max(0.25, Math.min(0.5, halfW))
  const len = Math.max(0.5, noseX - rr - (aftX + rr))
  const n = Math.max(2, Math.round(len / (1.35 * rr)) + 1)
  for (let i = 0; i < n; i++) {
    const x = noseX - rr - (len * i) / (n - 1)
    const a = Math.PI * rr * rr
    out.push(
      base({
        name: i === 0 ? 'morro' : 'panza',
        kind: 'hull',
        p: new Vector3(x, bellyY + rr, 0),
        r: rr,
        cdA: new Vector3(0.45 * a, 1.0 * a, 0.9 * a),
        // fondo de la góndola: rebota y patina como el de una lancha si entra rasante
        planing: 0.6 * a,
        // cabina abierta y bajos sin estanqueidad: desplaza la mitad de su volumen y se llena en ~30 s
        tight: 0.5,
        flood: 30,
        residual: 0.12,
        entry: 7,
        lwl: noseX - aftX,
        rake: i === 0 ? 0.25 : 0,
      }),
    )
  }

  // --- tren (con flotadores, los apoyos de la ficha son sus quillas: no hay ruedas en el agua) ---
  const wr = af.wheelRadius ?? 0.19
  const wheel = (p: Vector3 | undefined, name: string) => {
    if (!p || af.floats?.length) return
    const a = 2 * wr * 0.16 + 0.04 // neumático + carenado y pata
    out.push(
      base({
        name,
        kind: 'gear',
        p: new Vector3(p.x, p.y + wr, p.z),
        r: wr,
        cdA: new Vector3(1.0 * a, 1.1 * a, 0.9 * a),
        // neumático hinchado: unos 15 l de aire que flotan
        tight: 0.35,
      }),
    )
  }
  wheel(af.noseWheel, 'rueda de morro')
  wheel(af.tailWheel, 'rueda de cola')
  wheel(af.mainL, 'rueda principal izquierda')
  wheel(af.mainR, 'rueda principal derecha')
  // ruedas de unos flotadores anfibios: en el agua solo si el tren está abajo (`HydroBody.gearPos`); un
  // amerizaje con ellas fuera las clava y vuelca el aparato de morro, como en la realidad
  if (af.floats?.length && af.amphib) {
    const r = af.amphib.radius
    const a = 2 * r * 0.16 + 0.03
    for (const p of af.amphib.wheels) {
      out.push(
        base({
          name: p.z < 0 ? 'flotador izquierdo' : 'flotador derecho',
          kind: 'gear',
          p: new Vector3(p.x, p.y + r, p.z),
          r,
          cdA: new Vector3(1.0 * a, 1.1 * a, 0.9 * a),
          tight: 0.35,
          retract: af.amphib.retract,
        }),
      )
    }
  }

  // --- cola: estabilizador y derivas (placas) ---
  const stabs = cps.filter((c) => /^estabilizador/.test(c.name))
  const fins = cps.filter((c) => /^deriva/.test(c.name))
  for (const s of stabs) {
    const a = af.stabArea / Math.max(1, stabs.length)
    out.push(base({ name: s.name, kind: 'part', p: s.p.clone(), r: 0.12, cdA: new Vector3(0.06 * a, 1.2 * a, 0.15 * a), entry: 9, tight: 0.3 }))
  }
  for (const f of fins) {
    const a = af.finArea / Math.max(1, fins.length)
    out.push(base({ name: f.name, kind: 'part', p: f.p.clone(), r: 0.12, cdA: new Vector3(0.06 * a, 0.15 * a, 1.2 * a), entry: 9, tight: 0.3 }))
  }
  out.push(base({ name: 'patín de cola', kind: 'part', p: af.tail.clone(), r: 0.1, cdA: new Vector3(0.03, 0.05, 0.05) }))
  // lo demás que cuelga (barras de fumigación, alas, carenados…): poca cosa
  for (const c of cps) {
    if (/^morro|^panza|^quilla|^costado|^estabilizador|^deriva|^mástil|^pilón/.test(c.name)) continue
    out.push(base({ name: c.name, kind: 'part', p: c.p.clone(), r: 0.12, cdA: new Vector3(0.05, 0.12, 0.1), entry: 9 }))
  }

  // --- flotadores ---
  for (const f of af.floats ?? []) out.push(...floatSections(f))
  return out
}

/** Tramos de un flotador (8), estancos y con fondo de planeo; timón de agua en el último. */
export function floatSections(f: FloatSpec, n = 8): HullElement[] {
  const out: HullElement[] = []
  const L = f.bow.distanceTo(f.stern)
  const r = f.radius
  const seg = L / n
  // resistencia de presión de todo el flotador (casco fino, eslora ~7 veces el diámetro: Cd ≈ 0,03 sobre la
  // sección; la ola va aparte) + rozamiento del casco mojado (Cf ≈ 0,004 sobre ~2/3 del perímetro × eslora),
  // repartidas por tramos. (Con Cd 0,1, la de un cuerpo romo, un hidro de 850 kg no pasaba de 55 km/h.)
  const front = (Math.PI * r * r * 0.03 + 0.004 * (4 / 3) * Math.PI * r * L) / n
  // inclinación del flotador (proa más alta que la popa): todo el fondo va con ese ángulo de más
  const incidence = Math.atan2(f.bow.y - f.stern.y, f.bow.x - f.stern.x)
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n
    const p = f.stern.clone().lerp(f.bow, t)
    const aft = f.step !== undefined && p.x < f.step
    // la proa se estrecha: los dos primeros tramos, algo menos de volumen
    const ri = i >= n - 2 ? r * (i === n - 1 ? 0.75 : 0.9) : r
    out.push({
      name: f.name,
      kind: 'float',
      p,
      r: ri,
      len: seg,
      cdA: new Vector3(front, 2 * ri * seg * 1.1, 2 * ri * seg * 0.9),
      // (detrás del redán el agua va despegada del fondo: no planea)
      planing: aft ? 0 : 2 * ri * seg * 0.9,
      tight: 1,
      flood: Infinity,
      residual: 1,
      entry: 4.5,
      rudder: i === 0 ? (f.rudder ?? 0) : 0,
      lwl: L,
      // la proa se curva hacia arriba (el último tramo mucho, el anterior algo)
      rake: incidence + (aft ? 0 : (f.forebodyTrim ?? 0)) + (i === n - 1 ? 0.3 : i === n - 2 ? 0.1 : 0),
    })
  }
  return out
}

/** Volumen de un elemento entero (m³). */
export function elementVolume(e: HullElement): number {
  return e.len > 0 ? Math.PI * e.r * e.r * e.len : (4 / 3) * Math.PI * e.r ** 3
}

/** Volumen sumergido con el centro `d` metros por debajo de la superficie (negativo: por encima). */
function submerged(e: HullElement, d: number): number {
  const r = e.r
  const h = Math.max(0, Math.min(2 * r, d + r))
  if (h <= 0) return 0
  if (e.len > 0) {
    const k = r - h
    return e.len * (r * r * Math.acos(Math.max(-1, Math.min(1, k / r))) - k * Math.sqrt(Math.max(0, 2 * r * h - h * h)))
  }
  return (Math.PI * h * h * (3 * r - h)) / 3
}

/** Lo que necesita del aparato (para no importar autogyro.ts). */
export interface HydroBody {
  pos: Vector3
  vel: Vector3
  quat: Quaternion
  omega: Vector3
  mass: number
  inertia: Vector3
  /** CG actual (modelo) */
  cg: Vector3
  /** giro de la rueda de morro con los pedales (rad): los timones de agua van con ella */
  noseSteer: number
  /** tren anfibio: 1 abajo, 0 recogido (si falta, abajo) */
  gearPos?: number
}

export class Hydro {
  private states: State[] = []
  /** empuje de Arquímedes total de este paso (N) */
  buoyancy = 0
  /** fuerza del agua sin el empuje (N, filtrada ~50 ms) para la deceleración */
  private dyn = 0
  /** algo está mojado */
  wet = false
  /** profundidad del CG bajo la superficie (m; negativa: por encima) */
  cgDepth = -Infinity
  failure: HydroFailure | null = null
  /** chapoteos desde la última lectura (los vacía quien los consume) */
  readonly splashes: SplashEvent[] = []
  /** lo que está mojado en este paso */
  readonly wetPoints: WetPoint[] = []

  setAirframe(af: Airframe): void {
    this.states = hullFor(af).map((e) => ({ e, wasWet: false, flooded: 0 }))
    this.reset()
  }

  get elements(): readonly HullElement[] {
    return this.states.map((s) => s.e)
  }

  /** Aparato recolocado: seco y sin agua dentro. */
  reset(): void {
    for (const s of this.states) {
      s.wasWet = false
      s.flooded = 0
    }
    this.buoyancy = 0
    this.dyn = 0
    this.wet = false
    this.cgDepth = -Infinity
    this.failure = null
    this.splashes.length = 0
    this.wetPoints.length = 0
  }

  /** Marca todo como mojado (aparato colocado en el agua: sin chapoteo ni comprobación de entrada). */
  settleWet(): void {
    for (const s of this.states) s.wasWet = true
  }

  /**
   * Fuerzas del agua de un paso: suma la fuerza (mundo) a `F` y el momento (cuerpo, respecto al CG)
   * a `M`.
   */
  step(b: HydroBody, ground: WaterGround, dt: number, F: Vector3, M: Vector3): void {
    this.buoyancy = 0
    this.wet = false
    this.failure = null
    this.wetPoints.length = 0
    const depthAt = ground.waterDepth
    if (!depthAt) return
    const q = b.quat
    const I = b.inertia
    const iMin = Math.min(I.x, I.y, I.z)
    _dyn.set(0, 0, 0)
    const qInv = _qInv.copy(q).invert()
    // agua bajo el CG (para el hundimiento)
    const dCg = depthAt.call(ground, b.pos.x, b.pos.z)
    this.cgDepth = dCg > 0 ? ground.heightAt(b.pos.x, b.pos.z, _n) - b.pos.y : -Infinity
    for (const s of this.states) {
      const e = s.e
      if (e.retract && (b.gearPos ?? 1) < 0.5) {
        s.wasWet = false
        continue
      }
      _rb.copy(e.p).sub(b.cg) // cuerpo, respecto al CG
      _rw.copy(_rb).applyQuaternion(q)
      const cx = b.pos.x + _rw.x
      const cy = b.pos.y + _rw.y
      const cz = b.pos.z + _rw.z
      const depth = depthAt.call(ground, cx, cz)
      if (!(depth > 0)) {
        s.wasWet = false
        continue
      }
      const surf = ground.heightAt(cx, cz, _n)
      const d = surf - cy
      if (d <= -e.r) {
        s.wasWet = false
        continue
      }
      const V = submerged(e, d)
      const Vfull = elementVolume(e)
      const frac = V / Vfull
      const wet = Math.max(0, Math.min(1, (d + e.r) / (2 * e.r)))
      this.wet = true
      // velocidad del centro del elemento: mundo y cuerpo
      _vw.copy(b.omega).cross(_rb).applyQuaternion(q).add(b.vel)
      _u.copy(_vw).applyQuaternion(qInv)

      // entrada en el agua: golpe y chapoteo
      if (!s.wasWet) {
        const down = -_vw.y
        if (down > e.entry && !this.failure) this.failure = { kind: 'entry', part: e.name, speed: down }
        const sp = _vw.length()
        if (sp > 0.8) this.splashes.push({ x: cx, y: surf, z: cz, vx: _vw.x, vy: _vw.y, vz: _vw.z, size: e.len > 0 ? Math.max(e.r * 2, e.len) : e.r * 2 })
      }
      s.wasWet = true
      if (this.splashes.length > 64) this.splashes.splice(0, this.splashes.length - 64)

      // se llena de agua mientras está metido
      if (e.flood < Infinity) s.flooded = Math.min(1, s.flooded + (dt * frac) / e.flood)
      const tight = e.tight * (1 - s.flooded * (1 - e.residual))

      // ---- empuje de Arquímedes (vertical, en el centro del elemento) ----
      const Fb = RHO_WATER * G * V * tight
      this.buoyancy += Fb
      F.y += Fb
      _fb.set(0, Fb, 0).applyQuaternion(qInv)
      M.add(_t.crossVectors(_rb, _fb))

      // ---- resistencia y planeo (ejes del cuerpo) ----
      const U = _u.length()
      _fw.set(0, 0, 0)
      if (U > 1e-3) {
        // por componentes (flujo cruzado de un cuerpo alargado: ∝ (V·sen α)², no V²·sen α); con un
        // mínimo de 0,3 m/s, que hace de amortiguación del cabeceo y del balanceo en reposo (las olas
        // que levanta al moverse se llevan la energía)
        const k = 0.5 * RHO_WATER * wet
        _fw.set(
          -k * e.cdA.x * Math.max(0.3, Math.abs(_u.x)) * _u.x,
          -k * e.cdA.y * Math.max(0.3, Math.abs(_u.y)) * _u.y,
          -k * e.cdA.z * Math.max(0.3, Math.abs(_u.z)) * _u.z,
        )
        if (e.lwl > 0) {
          // resistencia de ola de un casco que desplaza agua: crece con el número de Froude hasta la
          // "joroba" (Fn ≈ 0,5, la ola de proa tan larga como el casco) y luego cae; al planear, con
          // menos casco metido, cae aún más. Pico ≈ 19 % del peso que sostiene.
          const vh = Math.hypot(_vw.x, _vw.z)
          if (vh > 0.05) {
            const x = vh / Math.sqrt(G * e.lwl) / 0.45
            const x2 = x * x
            const Dw = (0.35 * RHO_WATER * G * V * x2 * x2) / (1 + x2 * x2 * x2)
            _t.set((-Dw * _vw.x) / vh, 0, (-Dw * _vw.z) / vh).applyQuaternion(qInv)
            _fw.add(_t)
          }
        }
        if (e.planing > 0 && _u.x > 0.3) {
          // fondo plano: el agua le llega con ángulo α (morro arriba o bajando, más lo que sube el fondo
          // ahí) y lo empuja por la normal
          const alpha = Math.atan2(-_u.y, _u.x) + e.rake
          if (alpha > 0) {
            const S = e.planing * Math.min(1, 2 * wet)
            const Cn = 2 * Math.sin(alpha) * Math.cos(alpha)
            // (normal al fondo: donde el fondo sube hacia proa, también frena)
            const Fn = 0.5 * RHO_WATER * (_u.x * _u.x + _u.y * _u.y) * S * Cn
            _fw.x -= Fn * Math.sin(e.rake)
            _fw.y += Fn * Math.cos(e.rake)
          }
        }
        if (e.rudder > 0 && Math.abs(_u.x) > 0.3) {
          // timón de agua: placa vertical girada con los pedales (ángulo de ataque = giro − deriva local)
          const a = Math.max(-0.5, Math.min(0.5, b.noseSteer - Math.atan2(_u.z, Math.abs(_u.x))))
          _fw.z += 0.5 * RHO_WATER * _u.x * Math.abs(_u.x) * e.rudder * wet * 2.5 * a
        }
        // limitador implícito: lo que frena en un paso no puede pasar de la velocidad del punto
        // (masa e inercia efectivas en el punto)
        const fMag = _fw.length()
        if (fMag > 0) {
          const wEff = 1 / b.mass + _rb.lengthSq() / iMin
          const kk = (fMag * dt * wEff) / U
          if (kk > 0.8) _fw.multiplyScalar(0.8 / kk)
          M.add(_t.crossVectors(_rb, _fw))
          _fw.applyQuaternion(q)
          F.add(_fw)
          _dyn.add(_fw)
        }
      }
      this.wetPoints.push({ x: cx, y: surf, z: cz, vx: _vw.x, vy: _vw.y, vz: _vw.z, wet, size: 2 * e.r, kind: e.kind, name: e.name, along: e.p.x })
    }
    // deceleración del agua (filtrada: un paso suelto no cuenta)
    this.dyn += (_dyn.length() - this.dyn) * Math.min(1, dt / 0.05)
    const g = this.dyn / (b.mass * G)
    if (!this.failure && g > 9) this.failure = { kind: 'impact', g, speed: b.vel.length() }
    // hundido: el CG casi un metro bajo el agua
    if (!this.failure && this.cgDepth > 0.9) this.failure = { kind: 'sunk' }
  }
}


// ---------------------------------------------------------------------------
// Mensajes del accidente
// ---------------------------------------------------------------------------
addStrings('es', {
  'crash.water.entry.title': 'Golpe contra el agua',
  'crash.water.entry': '{Part} ha entrado en el agua bajando a {ms} m/s ({fpm} ft/min). A esa velocidad el agua no tiene tiempo de apartarse y golpea casi como el suelo.',
  'crash.water.float': '{Part} ha golpeado el agua bajando a {ms} m/s ({fpm} ft/min) y se han roto sus montantes. Con flotadores se toma como en tierra: suave, con el morro un poco arriba y sin dejarlo caer.',
  'crash.water.impact.title': 'Impacto contra el agua',
  'crash.water.impact': 'El aparato ha tocado el agua a {kmh} km/h y se ha clavado en ella: una deceleración de {g} g que la estructura no aguanta. Un autogiro con ruedas no puede amerizar con velocidad: hay que llegar al agua casi parado.',
  'crash.water.sunk.title': 'El autogiro se ha hundido',
  'crash.water.sunk': 'La góndola se ha llenado de agua y el aparato se ha ido al fondo. Sin flotadores, un amerizaje solo da unos segundos de flotación para salir.',
  'crash.rotor.water.title': 'Las palas del rotor han tocado el agua',
  'crash.rotor.water': 'El disco del rotor ha tocado la superficie: una pala que golpea el agua girando se parte igual que contra el suelo. Al meterse en el agua, el aparato se ladea o se hunde y el rotor acaba tocándola.',
  'crash.water.flip.title': 'Ha volcado al tocar el agua',
  'crash.water.flip': 'Las ruedas se han clavado en el agua a {kmh} km/h y el aparato ha volcado hacia delante hasta que el rotor ha golpeado los topes y el agua. Con tren fijo hay que llegar al agua casi parado y con la cola baja.',
  'crash.prop.water.title': 'La hélice ha tocado el agua',
  'crash.prop.water': 'La hélice ha golpeado el agua girando y se ha roto. Con el aparato metido en el agua, la hélice propulsora queda a ras de la superficie.',
  'crash.keel.title': 'Flotadores rotos',
  'crash.keel.detail': '{Part} ha golpeado el suelo bajando a {ms} m/s ({fpm} ft/min) y se han roto sus montantes. Sobre las quillas no hay amortiguadores: en tierra se toma aún más suave que en el agua.',
})
addStrings('en', {
  'crash.water.entry.title': 'Hit the water too hard',
  'crash.water.entry': '{Part} went into the water sinking at {ms} m/s ({fpm} ft/min). At that speed the water has no time to get out of the way and hits almost like solid ground.',
  'crash.water.float': '{Part} hit the water sinking at {ms} m/s ({fpm} ft/min) and its struts broke. On floats you land as on a runway: gently, nose slightly up, without dropping it in.',
  'crash.water.impact.title': 'Water impact',
  'crash.water.impact': 'The aircraft touched the water at {kmh} km/h and dug in: a {g} g deceleration the structure cannot take. A wheeled gyroplane cannot ditch with speed: you have to reach the water almost stopped.',
  'crash.water.sunk.title': 'The gyroplane sank',
  'crash.water.sunk': 'The pod filled with water and the aircraft went to the bottom. Without floats, a ditching only gives you a few seconds afloat to get out.',
  'crash.rotor.water.title': 'The rotor blades hit the water',
  'crash.rotor.water': 'The rotor disc touched the surface: a spinning blade that hits water breaks just as on the ground. Once in the water the aircraft tilts or settles and the rotor ends up touching it.',
  'crash.water.flip.title': 'Flipped over on touching the water',
  'crash.water.flip': 'The wheels dug into the water at {kmh} km/h and the aircraft tipped forward until the rotor hit its stops and the water. With fixed gear you have to reach the water almost stopped, tail low.',
  'crash.prop.water.title': 'The propeller hit the water',
  'crash.prop.water': 'The spinning propeller hit the water and broke. With the aircraft settled in the water, a pusher propeller sits right at the surface.',
  'crash.keel.title': 'Floats broken',
  'crash.keel.detail': '{Part} hit the ground sinking at {ms} m/s ({fpm} ft/min) and its struts broke. There are no shock absorbers on a float keel: on land you touch down even more gently than on water.',
  'pt.flotador izquierdo': 'the left float',
  'pt.flotador derecho': 'the right float',
  'pt.flotador': 'the float',
  'pt.flotadores': 'the floats',
})

/** Accidente en el agua para el panel (ver `Hydro.failure`). */
export function waterCrashInfo(f: HydroFailure): CrashInfo {
  if (f.kind === 'entry') {
    const float = /^flotador/.test(f.part)
    return {
      cause: 'water',
      part: f.part,
      title: t('crash.water.entry.title'),
      detail: t(float ? 'crash.water.float' : 'crash.water.entry', { part: partLabel(f.part), ms: f.speed.toFixed(1), fpm: (f.speed * 196.85).toFixed(0) }),
    }
  }
  if (f.kind === 'impact') return { cause: 'water', title: t('crash.water.impact.title'), detail: t('crash.water.impact', { kmh: Math.round(f.speed * 3.6), g: f.g.toFixed(0) }) }
  return { cause: 'water', title: t('crash.water.sunk.title'), detail: t('crash.water.sunk') }
}

/** Vuelco hacia delante al clavarse el tren en el agua (`speed`: velocidad sobre el agua, m/s). */
export function waterFlipInfo(speed: number): CrashInfo {
  return { cause: 'water', title: t('crash.water.flip.title'), detail: t('crash.water.flip', { kmh: Math.round(speed * 3.6) }) }
}
