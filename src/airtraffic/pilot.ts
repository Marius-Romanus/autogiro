// Piloto simulado de un autogiro del tráfico: decide como un piloto en un aeródromo sin control
// (rodar, esperar, alinear, prerrotar, despegar, circuito, toma, frustrada, dejar la pista) y lleva
// los mandos de un `Autogyro` de verdad con `Autopilot`.
//
// Procedimientos (los de los manuales, los mismos de tools/fdm-scenarios.ts):
//  · prerrotación con frenos, palanca adelante y medio gas hasta ~210 rpm; al soltar, palanca toda
//    atrás y todo el gas; en el aire se cede palanca para acelerar en efecto suelo y se sube a ~95 km/h;
//  · circuito a la altura publicada, viento en cola a 450 m de la pista (school/site.ts);
//  · final a ~95 km/h llevando la senda con el gas, recogida a unos metros y toma sobre las
//    principales; con viento cruzado, deriva corregida en final y morro al eje en la recogida.

import { Vector3 } from 'three'
import { Autogyro, type Environment, type GroundProvider } from '../sim/autogyro.ts'
import { WindModel } from '../sim/atmosphere.ts'
import type { Airframe } from '../sim/airframes.ts'
import { Autopilot, wrapPi } from './autopilot.ts'
import type { Pt, RwyDir, Spot } from './airfield.ts'

const KMH = 1 / 3.6
const G = 9.81
const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x)

/** separación del viento en cola (m): como el circuito de la escuela */
export const CIRCUIT_WIDTH = 450
/** punto de toma: metros dentro del umbral */
const AIM_TG = 70

export type Phase =
  | 'parked'
  | 'startup'
  | 'taxiOut'
  | 'hold'
  | 'lineUp'
  | 'prerotate'
  | 'roll'
  | 'liftoff'
  | 'upwind'
  | 'crosswind'
  | 'downwind'
  | 'base'
  | 'final'
  | 'flare'
  | 'touchGo'
  | 'rollout'
  | 'vacate'
  | 'taxiIn'
  | 'shutdown'
  | 'goAround'
  | 'depart'
  | 'arrive'
  | 'orbit'
  | 'wreck'
  | 'gone'

/** Fases en las que el aparato va por el aire. */
export const AIRBORNE: ReadonlySet<Phase> = new Set(['liftoff', 'upwind', 'crosswind', 'downwind', 'base', 'final', 'flare', 'goAround', 'depart', 'arrive', 'orbit'])
/** Fases en las que ocupa (o va a ocupar ya) la pista. */
const ON_RUNWAY: ReadonlySet<Phase> = new Set(['lineUp', 'prerotate', 'roll', 'liftoff', 'flare', 'touchGo', 'rollout'])

/** Prestaciones y manías de cada aparato del tráfico (los que el piloto simulado sabe llevar bien). */
export interface Perf {
  /** velocidades indicadas (m/s): subida, viento en cola, final y sobre el umbral */
  climb: number
  cruise: number
  approach: number
  /** altura de recogida (m) */
  flare: number
  /** vueltas de rotor para soltar frenos */
  preRpm: number
}

export function perfFor(af: Airframe): Perf {
  return {
    climb: 95 * KMH,
    cruise: 105 * KMH,
    approach: 95 * KMH,
    flare: 5.5,
    preRpm: af.prerotator ? af.prerotator.maxRpm * 0.92 : 210,
    ...PERF[af.id],
  }
}
const PERF: Record<string, Partial<Perf>> = {}

/** Suelo de un aparato: plano ajustado bajo él (como el del jugador en main.ts). */
export class PlaneGround implements GroundProvider {
  readonly p0 = new Vector3()
  readonly n = new Vector3(0, 1, 0)
  heightAt(x: number, z: number, out: Vector3): number {
    out.copy(this.n)
    const n = this.n
    return this.p0.y - (n.x * (x - this.p0.x) + n.z * (z - this.p0.z)) / n.y
  }
}

/** Otro tráfico tal como lo ve un piloto: los demás aparatos simulados y el del jugador. */
export interface Contact {
  readonly pos: Vector3
  readonly vel: Vector3
  readonly onGround: boolean
  readonly agl: number
  readonly isPlayer: boolean
  /** segundos hasta el umbral si viene a tomar (base o final); Infinity si no */
  readonly eta: number
  /** va a parar del todo: ocupa la pista más rato */
  readonly fullStop: boolean
  /** segundos que le quedan ocupando la pista (0 si no está en ella) */
  readonly occupies: number
  readonly phase: Phase | 'player'
  /** radio del rotor (m) */
  readonly rotorR: number
}

/** Lo que el piloto necesita del aeródromo y de los demás. */
export interface Scene {
  /** pista en uso */
  readonly rwy: RwyDir
  readonly time: number
  contacts(): readonly Contact[]
  /** altura del suelo del aeródromo en (x, z), o null si aún no se sabe */
  groundY(x: number, z: number): number | null
  radio(who: TrafficAircraft, key: string, vars?: Record<string, string | number>): void
  /** rodaje del puesto a la pista y de la pista al puesto */
  routeOut(spot: Spot, heading: number): { pts: Pt[]; hold: number } | null
  routeIn(spot: Spot): { pts: Pt[]; heading: number } | null
  /** s del punto por donde se deja la pista */
  exitS(): number
  /** un puesto libre (para el visitante que tiene que quedarse), o null */
  freeSpot(): Spot | null
  /** sale del aeródromo: por dónde y hasta dónde */
  departure(who: TrafficAircraft): Pt
}

/** Qué quiere hacer el piloto en este vuelo. */
export interface Plan {
  /** tomas y despegues que le quedan antes de la toma final */
  laps: number
  /** se va del aeródromo tras despegar */
  leaving: boolean
}

let nextId = 1
const _v = new Vector3()
const DEBUG = Boolean((globalThis as any).process?.env?.AT_DEBUG)
const envN = (k: string, d: number) => Number((globalThis as any).process?.env?.[k] ?? d)
const FL = { k: envN('FK', 0.1), p: envN('FP', 0.12), ff: envN('FF', 0.2), top: envN('FT', 0.19), h: envN('FH', 8), v0: envN('FV0', 0.25), v1: envN('FV1', 0.55), g: envN('FG', 2.2), hold: envN('FHO', 0.5), vtd: envN('FVT', 12) }

export class TrafficAircraft implements Contact {
  readonly id = nextId++
  readonly ac: Autogyro
  readonly ap = new Autopilot()
  readonly ground = new PlaneGround()
  readonly wind = new WindModel()
  readonly wv = new Vector3()
  readonly env: Environment
  readonly perf: Perf
  readonly isPlayer = false
  phase: Phase = 'parked'
  /** segundos en la fase actual */
  tPhase = 0
  plan: Plan = { laps: 0, leaving: false }
  /** puesto de estacionamiento (null: visitante sin puesto) y rumbo con el que está aparcado */
  spot: Spot | null = null
  parkHdg = 0
  /** la física corre (si no, está aparcado y quieto) */
  live = false
  eta = Infinity
  occupies = 0
  private clearT = 0
  /** el suelo bajo el aparato ya es bueno */
  grounded = false
  // ---- rodaje ----
  private path: Pt[] = []
  private seg = 0
  private stopAt = -1
  private taxiI = 0
  /** parado por otro aparato delante */
  blocked = false
  /** segundos seguidos sin moverse rodando (para detectar atascos) */
  stuckT = 0
  /** segundos seguidos esperando a que se aparte el de delante */
  blockedT = 0
  // ---- circuito ----
  /** s (desde el umbral de toma) donde vira a base: se alarga para separarse */
  private baseS = -380
  private called = ''
  /** frustradas seguidas y total */
  goArounds = 0
  private sideStep = 0
  private thT = 0
  private thI = 0
  private aimS = AIM_TG
  private orbitAcc = 0
  private orbitPrev = 0
  private orbitDir = 1
  private target: Pt = { x: 0, z: 0 }
  /** despegues, tomas y frustradas de este aparato (para las pruebas) */
  readonly stats = { takeoffs: 0, landings: 0, touchGos: 0, goArounds: 0, maxSink: 0 }
  /** velocidad vertical del último contacto (m/s) */
  lastTouch = 0
  touchIas = 0
  touchPitch = 0
  private wasAir = false
  /** maniobra evasiva en curso: segundos que quedan, y hacia dónde */
  private evadeT = 0
  private evadeTrack = 0
  private evadeVs = 0
  private evadeFrom: Contact | null = null
  /** el jugador u otro tráfico le obliga a esperar (para el aviso por radio una sola vez) */
  private waitCalled = false

  readonly af: Airframe
  readonly callsign: string
  readonly passenger: boolean

  constructor(af: Airframe, callsign: string, passenger: boolean) {
    this.af = af
    this.callsign = callsign
    this.passenger = passenger
    this.ac = new Autogyro(af)
    this.ac.setLoad(passenger)
    this.env = { rho: 1.12, wind: this.wv, ground: this.ground }
    this.perf = perfFor(af)
  }

  // ---- Contact ----
  get pos(): Vector3 {
    return this.ac.pos
  }
  get vel(): Vector3 {
    return this.ac.vel
  }
  get onGround(): boolean {
    return !this.live || this.ac.onGround
  }
  get agl(): number {
    return this.live ? this.ac.agl : 0
  }
  get fullStop(): boolean {
    return this.plan.laps <= 0
  }
  get rotorR(): number {
    return this.af.rotor.radius
  }
  get airborne(): boolean {
    return AIRBORNE.has(this.phase)
  }
  get onRunwayPhase(): boolean {
    return ON_RUNWAY.has(this.phase)
  }

  setPhase(p: Phase): void {
    if (p === this.phase) return
    this.phase = p
    this.tPhase = 0
  }

  // -------------------------------------------------------------------------
  // Colocar
  // -------------------------------------------------------------------------
  /** Aparcado en su puesto, motor parado y rotor frenado. */
  park(spot: Spot, heading: number, groundY: number): void {
    this.spot = spot
    this.parkHdg = heading
    this.ac.placeOnGround(spot.x, spot.z, groundY, (heading * 180) / Math.PI)
    this.ac.engineOn = false
    this.ac.engineRpm = 0
    this.ground.p0.set(spot.x, groundY, spot.z)
    this.ground.n.set(0, 1, 0)
    this.ap.reset(this.ac, -1, 0)
    this.ap.rotorBrake = true
    this.ap.brake = 1
    this.live = false
    this.eta = Infinity
    this.setPhase('parked')
  }

  /** En vuelo, llegando al aeródromo. */
  spawnInbound(x: number, y: number, z: number, heading: number, groundY: number): void {
    this.ac.placeInAir(x, y, z, (heading * 180) / Math.PI, this.perf.cruise)
    this.ground.p0.set(x, groundY, z)
    this.ground.n.set(0, 1, 0)
    this.ap.reset(this.ac, 0.11, 0.74)
    this.ap.rotorBrake = false
    this.ap.brake = 0
    // (hasta el primer paso de la física, los instrumentos marcan lo de la colocación)
    this.ac.agl = y - groundY
    this.ac.ias = this.ac.tas = this.perf.cruise
    this.live = true
    this.wasAir = true
    this.setPhase('arrive')
  }

  // -------------------------------------------------------------------------
  // Lo que ve
  // -------------------------------------------------------------------------
  private busyRunway(sc: Scene, from = -1e9, landing = false): Contact | null {
    const r = sc.rwy
    for (const c of sc.contacts()) {
      if (c === this) continue
      const s = r.s(c.pos.x, c.pos.z)
      const d = r.d(c.pos.x, c.pos.z)
      if (s < from || s < -15 || s > r.total + 15) continue
      // al que ya va lanzado en su carrera de despegue (o recién en el aire) pista adelante no se le
      // alcanza: cuando yo toque, él estará lejos
      if (landing && !c.isPlayer && (c.phase === 'roll' || c.phase === 'liftoff' || c.phase === 'touchGo') && Math.hypot(c.vel.x, c.vel.z) > 13 && s - r.s(this.pos.x, this.pos.z) > 350) continue
      const lim = r.hw + 9
      // en la pista, o a punto de tocarla (recogida, despegue recién hecho)
      if (Math.abs(d) < lim && (c.onGround || c.agl < 12)) return c
      if (!c.isPlayer && (c.phase === 'lineUp' || c.phase === 'prerotate' || c.phase === 'roll' || c.phase === 'rollout' || c.phase === 'touchGo' || c.phase === 'flare')) return c
    }
    return null
  }

  /** otro en el aire justo delante en la senda o sobre la pista (uno lento, uno que acaba de despegar) */
  private trafficAhead(sc: Scene): Contact | null {
    const r = sc.rwy
    const s0 = r.s(this.pos.x, this.pos.z)
    for (const c of sc.contacts()) {
      if (c === this || c.onGround) continue
      const ds = r.s(c.pos.x, c.pos.z) - s0
      if (ds > 0 && ds < 320 && Math.abs(r.d(c.pos.x, c.pos.z)) < 50 && c.pos.y < this.pos.y + 35) return c
    }
    return null
  }

  /** el que llega antes al umbral (base o final), o null */
  private nextArrival(sc: Scene): Contact | null {
    let best: Contact | null = null
    for (const c of sc.contacts()) if (c !== this && c.eta < (best?.eta ?? Infinity)) best = c
    return best
  }

  /** alguien en tierra sobre mi camino de rodaje, en los próximos `reach` metros */
  private blockerAhead(sc: Scene, reach = 19): Contact | null {
    const p = this.path
    if (p.length < 2) return null
    let i = Math.min(this.seg + 1, p.length - 1)
    let x = this.pos.x
    let z = this.pos.z
    for (let run = 2.5; run <= reach; run += 2.5) {
      // avanzar 2,5 m por el camino
      let step = 2.5
      while (step > 0) {
        const dx = p[i].x - x
        const dz = p[i].z - z
        const l = Math.hypot(dx, dz)
        if (l > step || i >= p.length - 1) {
          const k = l > 1e-6 ? Math.min(1, step / l) : 0
          x += dx * k
          z += dz * k
          step = 0
        } else {
          x = p[i].x
          z = p[i].z
          step -= l
          i++
        }
      }
      for (const c of sc.contacts()) {
        if (c === this || !(c.onGround || c.agl < 3)) continue
        if (Math.hypot(c.pos.x - x, c.pos.z - z) < 2.6 + c.rotorR * 0.8) return c
      }
    }
    return null
  }

  /** alguien rodando cerca (para no salir del puesto delante de él) */
  private movingNear(sc: Scene, x: number, z: number, reach: number): boolean {
    for (const c of sc.contacts()) {
      if (c === this || !c.onGround) continue
      if (Math.hypot(c.vel.x, c.vel.z) > 0.5 && Math.hypot(c.pos.x - x, c.pos.z - z) < reach) return true
    }
    return false
  }

  // -------------------------------------------------------------------------
  // Rodaje
  // -------------------------------------------------------------------------
  private setPath(pts: Pt[], stopAt = -1): void {
    this.path = pts
    this.seg = 0
    this.stopAt = stopAt < 0 ? pts.length - 1 : stopAt
    this.taxiI = 0
  }

  /** metros de camino hasta el punto de parada */
  private pathLeft(): number {
    const p = this.path
    if (!p.length) return 0
    const i = Math.min(this.seg + 1, this.stopAt)
    let d = Math.hypot(p[i].x - this.pos.x, p[i].z - this.pos.z)
    for (let k = i; k < this.stopAt; k++) d += Math.hypot(p[k + 1].x - p[k].x, p[k + 1].z - p[k].z)
    // (ya pasado el último punto)
    if (this.seg >= this.stopAt) {
      const a = p[Math.max(0, this.stopAt - 1)]
      const b = p[this.stopAt]
      const l = Math.hypot(b.x - a.x, b.z - a.z) || 1
      d = ((b.x - this.pos.x) * (b.x - a.x) + (b.z - this.pos.z) * (b.z - a.z)) / l
    }
    return d
  }

  /** Sigue el camino a pie de rueda. Devuelve true al llegar al punto de parada. */
  private taxi(dt: number, sc: Scene, vmax = 4.2): boolean {
    const ac = this.ac
    const ap = this.ap
    const p = this.path
    // avanzar de tramo al pasar su final
    while (this.seg < p.length - 2) {
      const a = p[this.seg]
      const b = p[this.seg + 1]
      const l2 = (b.x - a.x) ** 2 + (b.z - a.z) ** 2
      const t = l2 > 1e-6 ? ((this.pos.x - a.x) * (b.x - a.x) + (this.pos.z - a.z) * (b.z - a.z)) / l2 : 1
      if (t < 1) break
      this.seg++
    }
    // punto de mira: unos metros por delante sobre el camino
    const look = 4.5 + ap.gs * 0.6
    let i = this.seg
    const a0 = p[i]
    const b0 = p[Math.min(i + 1, p.length - 1)]
    const l0 = Math.hypot(b0.x - a0.x, b0.z - a0.z) || 1
    let t0 = clamp(((this.pos.x - a0.x) * (b0.x - a0.x) + (this.pos.z - a0.z) * (b0.z - a0.z)) / (l0 * l0), 0, 1)
    let rest = look
    let tx = b0.x
    let tz = b0.z
    for (;;) {
      const a = p[i]
      const b = p[Math.min(i + 1, p.length - 1)]
      const l = Math.hypot(b.x - a.x, b.z - a.z)
      const avail = l * (1 - t0)
      if (rest <= avail || i >= p.length - 2) {
        const t = l > 1e-6 ? t0 + rest / l : 1
        // (más allá del final: se prolonga el último tramo, para llegar derecho)
        tx = a.x + (b.x - a.x) * t
        tz = a.z + (b.z - a.z) * t
        break
      }
      rest -= avail
      i++
      t0 = 0
    }
    const want = Math.atan2(tx - this.pos.x, -(tz - this.pos.z))
    const err = wrapPi(want - ap.hdg)
    const left = this.pathLeft()
    let v = vmax * clamp(1.15 - Math.abs(err) / 0.7, 0.4, 1)
    v = Math.min(v, Math.sqrt(Math.max(0, 2 * 0.5 * (left - 0.4))))
    // frenar antes de las curvas del camino (un autogiro es alto y estrecho: vuelca si gira deprisa)
    let run = Math.hypot(p[Math.min(this.seg + 1, p.length - 1)].x - this.pos.x, p[Math.min(this.seg + 1, p.length - 1)].z - this.pos.z)
    for (let k = this.seg + 1; k < this.stopAt && run < 70; k++) {
      const turn = Math.abs(wrapPi(Math.atan2(p[k + 1].x - p[k].x, -(p[k + 1].z - p[k].z)) - Math.atan2(p[k].x - p[k - 1].x, -(p[k].z - p[k - 1].z))))
      const vc = clamp(4.4 * (1 - turn / 1.1), 1.5, vmax)
      v = Math.min(v, Math.sqrt(vc * vc + 2 * 0.45 * Math.max(0, run - 3)))
      run += Math.hypot(p[k + 1].x - p[k].x, p[k + 1].z - p[k].z)
    }
    const blk = this.blockerAhead(sc)
    this.blocked = blk !== null
    if (blk) v = 0
    const arrived = left < 0.6
    if (arrived) v = 0
    ap.steer(dt, ac, want)
    // la rueda de morro, solo lo que aguanta sin volcar a esta velocidad (0,15 g de lado)
    const yawMax = Math.min(1, Math.atan((1.9 * 1.5) / Math.max(ap.gs * ap.gs, 0.5)) / 0.384)
    ap.yaw = clamp(ap.yaw, -yawMax, yawMax)
    this.groundSpeed(dt, v)
    // palanca adelante y rotor frenado mientras se rueda
    ap.moveStick(dt, -1, 0.8)
    ap.roll = 0
    ap.prerot = false
    this.stuckT = ap.gs < 0.3 && !arrived && !blk ? this.stuckT + dt : 0
    this.blockedT = blk ? this.blockedT + dt : 0
    return arrived && ap.gs < 0.4
  }

  /** Velocidad de rodaje con gas y frenos. */
  private groundSpeed(dt: number, v: number): void {
    const ap = this.ap
    const e = v - ap.gs
    if (v <= 0.05) {
      ap.moveThrottle(dt, 0, 1)
      ap.brake = ap.gs > 2 ? 0.6 : 1
      this.taxiI = 0
      return
    }
    this.taxiI = clamp(this.taxiI + 0.04 * e * dt, 0, 0.35)
    ap.moveThrottle(dt, clamp(0.05 + this.taxiI + 0.08 * e, 0, 0.6), 0.6)
    ap.brake = e < -0.3 ? clamp(-0.35 * (e + 0.3), 0, 0.8) : 0
  }

  // -------------------------------------------------------------------------
  // Guiado en el aire
  // -------------------------------------------------------------------------
  /** Derrota para seguir una recta (punto + rumbo) con el error lateral `e` (m, + a la derecha). */
  private lineTrack(course: number, e: number, reach = 110): number {
    return course - clamp(Math.atan(e / reach), -0.9, 0.9)
  }

  /** Altitud con el gas (velocidad vertical limitada). */
  private holdAlt(dt: number, y: number, up = 2.5, down = 3): void {
    this.ap.holdVs(dt, this.ac, clamp(0.14 * (y - this.pos.y), -down, up))
  }

  /** radio de viraje a la velocidad que lleva (m) y anticipo para un viraje de 90° */
  private lead(): number {
    const v = Math.max(this.ap.gs, 15)
    return (v * v) / (G * Math.tan(0.4)) + v * 1.2
  }

  /** Altura sobre la pista que toca a `dist` metros de camino del punto de toma. */
  private profile(dist: number, H: number): number {
    const near = 360
    const hNear = 45
    if (dist <= near) return (dist * hNear) / near
    return Math.min(H, hNear + (dist - near) * 0.077)
  }

  // -------------------------------------------------------------------------
  // Un paso
  // -------------------------------------------------------------------------
  step(dt: number, sc: Scene): void {
    if (!this.live) return
    const ac = this.ac
    const ap = this.ap
    this.tPhase += dt
    ap.look(ac, dt)
    ap.feet = false
    ap.prerot = false
    const r = sc.rwy
    const s = r.s(this.pos.x, this.pos.z)
    const d = r.d(this.pos.x, this.pos.z)
    /** desde el umbral de toma */
    const sT = s - r.displaced
    const L = r.total - r.displaced
    const side = r.side
    const W = CIRCUIT_WIDTH * side
    const gy = sc.groundY(r.px(r.displaced, 0), r.pz(r.displaced, 0)) ?? this.ground.p0.y
    const P = this.perf
    const Lc = Math.min(L, 900)
    this.eta = Infinity
    this.occupies = 0

    switch (this.phase) {
      // ------------------------------------------------------------------ tierra
      case 'startup': {
        // arranque y calentamiento, parado con frenos
        ap.brake = 1
        ap.rotorBrake = true
        ap.moveStick(dt, -1, 1)
        ap.moveThrottle(dt, this.tPhase > 8 ? 0.12 : 0.03, 0.2)
        if (this.tPhase > this.warmup) {
          const route = this.spot ? sc.routeOut(this.spot, this.parkHdg) : null
          if (!route) {
            this.setPhase('shutdown')
            break
          }
          this.setPath(route.pts, route.hold)
          // ceder el paso a quien venga por la calle o esté parado en mi salida
          if (this.blockerAhead(sc, 26) || (this.spot && this.movingNear(sc, this.spot.jx, this.spot.jz, 32))) break
          this.holdIdx = route.hold
          sc.radio(this, 'taxi', { rwy: r.id })
          this.setPhase('taxiOut')
        }
        break
      }
      case 'taxiOut': {
        if (this.taxi(dt, sc)) this.setPhase('hold')
        break
      }
      case 'hold': {
        // punto de espera: prueba de motor y mirar el circuito
        this.groundSpeed(dt, 0)
        ap.moveStick(dt, -1, 1)
        if (this.tPhase < this.runup) break
        const busy = this.busyRunway(sc)
        const arr = this.nextArrival(sc)
        if (busy || (arr && arr.eta < 90)) {
          if (!this.waitCalled && this.tPhase > this.runup + 1) {
            this.waitCalled = true
            sc.radio(this, 'holding', { rwy: r.id })
          }
          break
        }
        this.waitCalled = false
        sc.radio(this, 'lineUp', { rwy: r.id })
        // el mismo camino, ahora hasta el eje
        this.stopAt = this.path.length - 1
        this.setPhase('lineUp')
        break
      }
      case 'lineUp': {
        this.occupies = 55
        if (this.taxi(dt, sc, 3.5) || (Math.abs(d) < 1.5 && Math.abs(wrapPi(r.hdg - ap.hdg)) < 0.08 && this.pathLeft() < 6)) this.setPhase('prerotate')
        break
      }
      case 'prerotate': {
        // frenos, palanca adelante, medio gas y prerrotador (como en fdm-scenarios.ts)
        ap.brake = 1
        ap.rotorBrake = false
        ap.moveStick(dt, -1, 1.5)
        ap.steer(dt, ac, r.hdg)
        this.occupies = 35
        // pista libre por delante y nadie recién despegado demasiado cerca; si no, a ralentí y a
        // esperar (con medio gas y el rotor lanzado los frenos no sujetan mucho rato)
        const clear = this.upwindClear(sc)
        this.clearT = clear ? this.clearT + dt : 0
        if (this.clearT < 1) {
          ap.moveThrottle(dt, 0.06, 0.5)
          break
        }
        ap.moveThrottle(dt, 0.4, 0.35)
        ap.prerot = this.tPhase > 1.5 && ap.throttle > 0.3
        if (ac.rotor.rpm >= P.preRpm) {
          {
            if (DEBUG) console.log(`      ${this.callsign} suelta frenos s ${s.toFixed(0)} d ${d.toFixed(1)} rpm ${ac.rotor.rpm.toFixed(0)}: ${sc.contacts().filter((c) => c !== this && (c.onGround || c.isPlayer)).map((c) => `${(c as any).callsign ?? 'jugador'} ${c.phase} s ${r.s(c.pos.x, c.pos.z).toFixed(0)} d ${r.d(c.pos.x, c.pos.z).toFixed(0)}`).join(', ')}`)
            sc.radio(this, this.plan.leaving ? 'takeoffLeaving' : 'takeoff', { rwy: r.id })
            this.setPhase('roll')
          }
        }
        break
      }
      case 'roll': {
        // carrera: sin frenos ni prerrotador, todo el gas y la palanca toda atrás
        this.occupies = 14
        ap.brake = 0
        ap.rotorBrake = false
        ap.moveThrottle(dt, 1, 0.6)
        ap.moveStick(dt, 1, 1.6)
        this.runwaySteer(dt, r, d)
        if (ac.rotor.rpm > 250) ap.holdBank(dt, ac, this.windLean(r))
        else ap.roll = clamp(this.crossFromRight(r) * 0.06, -0.5, 0.5)
        if (ac.agl > 0.4 && !ac.onGround) {
          this.stats.takeoffs++
          this.wasAir = true
          this.setPhase('liftoff')
        }
        break
      }
      case 'liftoff': {
        // recién en el aire: ceder palanca y acelerar en efecto suelo hasta la velocidad de subida
        this.occupies = ac.agl < 10 ? 6 : 0
        ap.moveThrottle(dt, 1, 0.6)
        // actitud para subir muy poco mientras coge velocidad
        ap.holdPitch(dt, ac, ac.onGround ? 0.09 : clamp(0.04 * (clamp(0.6 * (2 - ac.agl), -0.3, 0.8) - ac.vs), -0.05, 0.14), 1.6)
        ap.holdTrack(dt, ac, this.lineTrack(r.hdg, d - this.sideStep, 80), 0.2)
        if (ac.ias > P.climb - 2 || ac.agl > 12) {
          ap.syncThrottle()
          this.setPhase('upwind')
        }
        break
      }
      // ------------------------------------------------------------------ circuito
      case 'goAround':
      case 'upwind': {
        if (this.phase === 'upwind' || ac.agl < 40) {
          ap.moveThrottle(dt, 1, 0.8)
          // cerca del suelo lo primero es no bajar: actitud de subida suave hasta tener altura y velocidad
          if (ac.agl < 12 && ac.ias < P.climb - 1) ap.holdPitch(dt, ac, clamp(0.02 + 0.04 * (1.5 - ac.vs), -0.02, 0.14), 1.6)
          else ap.holdSpeed(dt, ac, P.climb)
          ap.syncThrottle()
          ap.holdTrack(dt, ac, this.lineTrack(r.hdg, d - this.sideStep, 90), ac.agl < 25 ? 0.2 : 0.4)
        }
        // el que frustra deja pasar primero al que estaba en la pista: sigue de frente hasta que
        // el otro ha virado y está lejos (alarga el tramo de subida)
        if (this.phase === 'goAround') {
          if (ac.agl >= 40) {
            this.climbOrLevel(dt, gy + r.H)
            ap.holdTrack(dt, ac, this.lineTrack(r.hdg, d - this.sideStep, 90))
          }
          if (ac.agl < 40 || (this.runwayTraffic(sc) && sT < Lc + 2200)) break
        }
        // sin pisar al que acaba de virar delante: se alarga la subida hasta tener hueco
        if (ac.agl > 0.5 * r.H && ac.agl > 60 && sT > Lc + 60 && (this.crosswindClear(sc) || sT > Lc + 1800)) {
          this.sideStep = 0
          if (this.plan.leaving) {
            this.target = sc.departure(this)
            this.setPhase('depart')
          } else this.setPhase('crosswind')
        }
        break
      }
      case 'crosswind': {
        const course = r.hdg + (side * Math.PI) / 2
        this.climbOrLevel(dt, gy + r.H)
        // recta perpendicular a la pista: error lateral = lo que se ha ido pista adelante
        const sLine = this.xwS
        if (this.tPhase < dt * 1.5) this.xwS = sT + this.lead() * 0.9
        ap.holdTrack(dt, ac, this.lineTrack(course, -(sT - (this.xwS || sLine)) * side))
        if (Math.abs(d) > CIRCUIT_WIDTH - this.lead() && d * side > 0) {
          this.baseS = -380
          this.called = ''
          this.setPhase('downwind')
        }
        break
      }
      case 'downwind': {
        const course = r.hdg + Math.PI
        this.climbOrLevel(dt, gy + r.H, this.spacingSpeed(sc, sT))
        ap.holdTrack(dt, ac, this.lineTrack(course, -(d - W)))
        // a mitad del tramo, la llamada
        if (!this.called && sT < Lc * 0.5) {
          this.called = 'dw'
          sc.radio(this, this.plan.laps > 0 ? 'downwindTG' : 'downwindFull', { rwy: r.id, side: side > 0 ? 'R' : 'L' })
        }
        // desde el través del umbral ya cuenta como llegada
        this.aimS = this.aim(sc)
        // la base queda donde termine el viraje si se empieza ya (se va alargando al esperar hueco)
        const turnS = sT - this.lead() * 0.6
        const baseS = Math.min(-380, turnS)
        const toGo = Math.max(0, sT - baseS) + CIRCUIT_WIDTH + -baseS + this.aimS
        // cuenta como llegada desde que entra en el tramo: los que esperan en tierra ya le ven venir
        // (+8 s de los dos virajes)
        this.eta = toGo / 26 + 8
        if (sT < 0) this.descend(dt, gy, toGo, r.H)
        if (turnS <= -380) {
          // ¿hay hueco detrás del que va delante?
          if (this.baseGap(sc, this.eta, sT) || sT < -1600) {
            if (DEBUG) console.log(`      ${this.callsign} vira a base sT ${sT.toFixed(0)} eta ${this.eta.toFixed(0)}: ${sc.contacts().filter((c) => c !== this && (c.eta < 1e9 || c.occupies > 0)).map((c) => `${(c as any).callsign ?? 'jugador'} ${c.phase} eta ${c.eta.toFixed(0)} ocupa ${c.occupies.toFixed(0)}`).join(', ')}`)
            this.baseS = baseS
            this.setPhase('base')
          }
        }
        break
      }
      case 'base': {
        const course = r.hdg - (side * Math.PI) / 2
        const toGo = Math.abs(d) + -this.baseS + this.aimS
        this.eta = toGo / 26
        this.descend(dt, gy, toGo, r.H)
        ap.holdTrack(dt, ac, this.lineTrack(course, (sT - this.baseS) * side))
        if (Math.abs(d) < this.lead() * 0.95) {
          sc.radio(this, 'final', { rwy: r.id })
          this.setPhase('final')
        }
        break
      }
      case 'final': {
        const toGo = Math.max(0, this.aimS - sT)
        this.eta = Math.max(0, -sT) / Math.max(ap.gs, 15)
        const hT = this.profile(toGo, r.H)
        // altura de las ruedas sobre el umbral
        const hw = ac.agl + this.groundAtSelf() - gy
        // senda con el gas, velocidad con la palanca
        const v = toGo < 250 ? P.approach - 2 : P.approach
        ap.holdSpeed(dt, ac, v)
        const gs = Math.max(ap.gs, 12)
        const slope = toGo <= 360 ? 45 / 360 : 0.077
        ap.holdVs(dt, ac, clamp(-gs * slope + 0.35 * (hT - hw), -5.5, 1.5), 0, 0.85)
        ap.holdTrack(dt, ac, this.lineTrack(r.hdg, d, 70), ac.agl < 20 ? 0.26 : 0.4)
        // decisión: pista ocupada → frustrada
        const busy = this.busyRunway(sc, -1e9, true)
        const ahead = ac.agl > 8 ? this.trafficAhead(sc) : null
        if (ahead || (busy && ac.agl < 32) || (ac.agl < 14 && ac.agl > 6 && Math.abs(d) > r.hw + 6)) {
          this.goAround(sc, busy || ahead ? 'goAroundBusy' : 'goAround')
          break
        }
        if (ac.agl < FL.h) {
          this.thI = ap.pitch
          this.setPhase('flare')
        }
        break
      }
      case 'flare': {
        // recogida: gas fuera, morro arriba poco a poco para llegar al suelo casi sin bajar
        this.occupies = this.plan.laps > 0 ? 24 : 30 + Math.max(0, sc.exitS() - s) / 6
        ap.moveThrottle(dt, 0, 0.5)
        // redondear hasta quedar a medio metro del suelo y ahí «aguantar»: se sigue tirando para no
        // bajar mientras el aparato se frena, hasta que con el morro arriba ya no vuela y se posa
        // sobre las principales
        const over = ac.agl - FL.hold
        // (con la velocidad de toma ya se deja posar: aguantar más es quedarse sin mando a medio metro)
        const vsT = over > 0 ? -(FL.v0 + FL.v1 * over) : ac.ias > FL.vtd ? clamp(-FL.v0 - 0.8 * over, -FL.v0, 0.3) : -0.45
        // la actitud manda la velocidad vertical casi al momento (el disco coge o suelta carga): proporcional,
        // más lo que hay que ir subiendo el morro según se pierde velocidad
        const e = vsT - ac.vs
        const ff = clamp((-2 * ap.vDot * FL.ff) / Math.max(ac.ias, 8), 0, 0.07)
        this.thI = clamp(this.thI + (FL.k * e + ff) * dt, -0.2, FL.top)
        this.thT = clamp(this.thI + FL.p * e, -0.2, FL.top)
        ap.holdPitch(dt, ac, this.thT, FL.g)
        // morro al eje con los pedales y la deriva con la palanca
        ap.steer(dt, ac, r.hdg, 1.3)
        const dDot = -ac.vel.x * r.dz + ac.vel.z * r.dx
        ap.holdBank(dt, ac, clamp(-0.012 * d - 0.07 * dDot, -0.14, 0.14))
        if (ac.onGround) {
          this.lastTouch = ac.hardness
          this.touchIas = ac.ias
          this.touchPitch = ap.pitch
          this.stats.maxSink = Math.max(this.stats.maxSink, ac.hardness)
          this.stats.landings++
          if (this.plan.laps > 0 && !this.busyRunway(sc, s + 5) && sT < L * 0.6) {
            this.plan.laps--
            this.stats.touchGos++
            this.setPhase('touchGo')
          } else {
            this.plan.laps = 0
            this.setPhase('rollout')
          }
        } else if (this.tPhase > 25) this.goAround(sc, 'goAround')
        break
      }
      case 'touchGo': {
        // toma y despegue: sin frenar, todo el gas con la palanca atrás
        this.occupies = 16
        ap.brake = 0
        ap.moveThrottle(dt, 1, 0.7)
        // rotor ya lanzado: se acelera sobre las principales con el morro apenas levantado (la rueda
        // de morro en el suelo a esa velocidad «agarra») y se rota con velocidad
        ap.holdPitch(dt, ac, 0.03 + 0.075 * clamp((ac.ias - 16) / 5, 0, 1), 1.6)
        this.runwaySteer(dt, r, d)
        ap.holdBank(dt, ac, this.windLean(r))
        if (ac.agl > 0.4 && !ac.onGround && this.tPhase > 1) {
          this.stats.takeoffs++
          this.setPhase('liftoff')
        }
        break
      }
      case 'rollout': {
        // carrera de la toma: palanca atrás para frenar con el rotor; ya despacio, frenos hasta ir al
        // paso, disco plano y contra el viento y freno de rotor; con el rotor casi parado, a rodar
        ap.moveThrottle(dt, 0, 1)
        const left = sc.exitS() - s
        this.occupies = 25 + Math.max(0, left) / 6
        this.runwaySteer(dt, r, d)
        if (!ac.onGround && ac.agl > 0.3 && ac.ias > 10) {
          // ha rebotado: otra vez a recoger
          this.thI = Math.max(ap.pitch, 0.06)
          this.slowT = 0
          this.setPhase('flare')
          break
        }
        if (this.slowT <= 0 && ap.gs > 5.5) {
          // la palanca atrás del todo solo cuando ya no puede volver a levantarlo; el rotor frena
          // (y mantiene ligero el morro), las ruedas apenas
          ap.moveStick(dt, ac.ias > 16 ? Math.max(ap.stick, 0.3) : 1, 0.5)
          ap.holdBank(dt, ac, this.windLean(r))
          ap.brake = ap.gs < 12 ? 0.25 : 0
          break
        }
        this.slowT += dt
        this.groundSpeed(dt, 2.5)
        ap.brake = Math.min(ap.brake, 0.35)
        ap.moveStick(dt, -1, 0.35)
        // con vueltas, el disco sigue mandando: alas niveladas; ya sin ellas, la palanca al viento
        if (ac.rotor.rpm > 200) ap.holdBank(dt, ac, this.windLean(r))
        else ap.roll = this.windStick(r)
        ap.rotorBrake = ap.stick < -0.9 && ap.gs < 4.5
        if (ap.rotorBrake && ac.rotor.rpm < 110) {
          this.slowT = 0
          if (!this.spot) this.spot = sc.freeSpot()
          const route = this.spot ? sc.routeIn(this.spot) : null
          if (route) {
            // el camino empieza en el eje, en la salida: se añade donde está ahora
            this.setPath([{ x: this.pos.x, z: this.pos.z }, ...route.pts])
            this.parkHdg = route.heading
            this.setPhase('vacate')
          } else {
            // un visitante sin sitio donde aparcar: vuelve a despegar desde donde ha parado
            this.plan = { laps: 0, leaving: true }
            this.clearT = 0
            this.setPhase('prerotate')
          }
        }
        break
      }
      case 'vacate': {
        const done = this.taxi(dt, sc, Math.abs(d) < r.hw + 2 ? 8 : 4.2)
        ap.rotorBrake = true
        ap.roll = this.windStick(r)
        this.occupies = 10 + Math.max(0, sc.exitS() - s) / 6
        if (Math.abs(d) > r.hw + 10) {
          this.occupies = 0
          sc.radio(this, 'vacated', { rwy: r.id })
          this.setPhase('taxiIn')
        } else if (done) this.setPhase('shutdown')
        break
      }
      case 'taxiIn': {
        const done = this.taxi(dt, sc)
        ap.rotorBrake = true
        ap.roll = this.windStick(r)
        if (done) this.setPhase('shutdown')
        break
      }
      case 'shutdown': {
        ap.brake = 1
        ap.moveThrottle(dt, 0, 1)
        ap.moveStick(dt, -1, 1)
        ap.rotorBrake = true
        if (this.tPhase > 6) ac.engineOn = false
        if (this.tPhase > 10 && ac.rotor.rpm < 3 && ac.engineRpm < 30) {
          this.live = false
          this.ac.engineRpm = 0
          this.setPhase('parked')
        }
        break
      }
      // ------------------------------------------------------------------ fuera del circuito
      case 'depart': {
        // sale del circuito subiendo a su altura de crucero
        ap.holdSpeed(dt, ac, P.cruise)
        this.holdAlt(dt, gy + r.H + 90)
        ap.holdTrack(dt, ac, Math.atan2(this.target.x - this.pos.x, -(this.target.z - this.pos.z)))
        break
      }
      case 'arrive': {
        // hacia el principio del viento en cola, por fuera, a la altura del circuito
        const jx = r.px(r.displaced + Lc + 150, W + side * 750)
        const jz = r.pz(r.displaced + Lc + 150, W + side * 750)
        const dist = Math.hypot(jx - this.pos.x, jz - this.pos.z)
        ap.holdSpeed(dt, ac, P.cruise)
        this.holdAlt(dt, gy + r.H)
        ap.holdTrack(dt, ac, Math.atan2(jx - this.pos.x, -(jz - this.pos.z)))
        if (!this.called && dist < 2600) {
          this.called = 'in'
          sc.radio(this, 'inbound', { rwy: r.id, side: side > 0 ? 'R' : 'L', nm: Math.max(1, Math.round(dist / 1852)) })
        }
        if (dist < 260) {
          if (this.joinClear(sc)) {
            this.called = ''
            this.joining = true
            this.baseS = -380
            this.setPhase('downwind')
          } else {
            this.orbitAcc = 0
            this.orbitPrev = ap.track
            // la vuelta, hacia fuera: alejándose de la pista
            this.orbitDir = wrapPi(Math.atan2(r.px(r.total / 2, 0) - this.pos.x, -(r.pz(r.total / 2, 0) - this.pos.z)) - ap.track) > 0 ? -1 : 1
            this.setPhase('orbit')
          }
        }
        break
      }
      case 'orbit': {
        // una vuelta por fuera del circuito para dejar pasar al que viene por viento en cola
        ap.holdSpeed(dt, ac, P.cruise - 3)
        this.holdAlt(dt, gy + r.H)
        ap.holdBank(dt, ac, this.orbitDir * 0.38)
        this.orbitAcc += Math.abs(wrapPi(ap.track - this.orbitPrev))
        this.orbitPrev = ap.track
        if (this.orbitAcc > Math.PI * 1.9) this.setPhase('arrive')
        break
      }
      default:
        break
    }

    // red de seguridad: otro tráfico demasiado cerca en el aire
    if (this.airborne && this.phase !== 'flare') this.avoid(dt, sc)

    if (!ac.onGround) this.wasAir = true
    ac.step(dt, ap.apply(dt, ac), this.env)
    if (ac.crash) {
      this.setPhase('wreck')
      this.live = false
    }
  }

  /** calentamiento y prueba de motor de este vuelo (s) */
  warmup = 30
  runup = 12
  /** segundos que se queda aparcado antes de poder volver a salir */
  rest = 0
  private holdIdx = -1
  private xwS = 0
  private joining = false
  private slowT = 0

  private groundAtSelf(): number {
    return this.ground.heightAt(this.pos.x, this.pos.z, _v)
  }

  /** viento cruzado desde la derecha de la pista (m/s) */
  private crossFromRight(r: RwyDir): number {
    // el viento va hacia −derecha si viene de la derecha
    return -(-this.wv.x * r.dz + this.wv.z * r.dx)
  }

  /**
   * Pedales en la carrera (despegue, toma): el morro, por donde va el aparato. Con velocidad, un
   * morro cruzado respecto a la marcha carga las ruedas de lado y vuelca: se corrige hacia el eje
   * muy poco a poco (2° como mucho); la pista es ancha.
   */
  private runwaySteer(dt: number, r: RwyDir, d: number): void {
    const ap = this.ap
    const want = r.hdg - clamp(0.01 * d, -0.05, 0.05)
    ap.steer(dt, this.ac, ap.gs > 6 ? ap.track + clamp(wrapPi(want - ap.track), -0.035, 0.035) : want)
  }

  /** Con el rotor aún girando en tierra, la palanca hacia el viento (si no, el viento lo levanta de un lado). */
  private windStick(r: RwyDir): number {
    const k = clamp((this.ac.rotor.rpm - 60) / 120, 0, 1)
    // viento desde la derecha del aparato
    const hx = Math.sin(this.ap.hdg)
    const hz = -Math.cos(this.ap.hdg)
    void r
    const fromRight = -(-this.wv.x * hz + this.wv.z * hx)
    return clamp(fromRight * 0.08, -0.6, 0.6) * k
  }

  /** alabeo (rad) en la carrera: nivelado, algo hacia el viento cruzado */
  private windLean(r: RwyDir): number {
    return clamp(this.crossFromRight(r) * 0.012, -0.08, 0.08)
  }

  /** Sube a la altura del circuito y la mantiene. */
  private climbOrLevel(dt: number, y: number, speed?: number): void {
    const ap = this.ap
    if (this.pos.y < y - 12) {
      ap.moveThrottle(dt, 1, 0.6)
      ap.holdSpeed(dt, this.ac, this.perf.climb)
      ap.syncThrottle()
    } else {
      ap.holdSpeed(dt, this.ac, speed ?? this.perf.cruise)
      this.holdAlt(dt, y)
    }
  }

  /** Baja siguiendo el perfil del circuito. */
  private descend(dt: number, gy: number, toGo: number, H: number): void {
    const ap = this.ap
    const hT = this.profile(toGo, H)
    const hw = this.pos.y - gy
    ap.holdSpeed(dt, this.ac, this.perf.approach + 1)
    const sink = hT >= H - 0.5 ? 0 : -Math.max(ap.gs, 15) * 0.077
    ap.holdVs(dt, this.ac, clamp(sink + 0.3 * (hT + 1.1 - hw), -4.5, 2), 0, 0.9)
  }

  /** punto de toma (m desde el umbral): corto para toma y despegue, largo para dejar la pista por el final */
  private aim(sc: Scene): number {
    const r = sc.rwy
    const L = r.total - r.displaced
    if (this.plan.laps > 0 || !this.spot) return Math.min(AIM_TG, L * 0.2)
    const exit = sc.exitS() - r.displaced
    return clamp(exit - 230, Math.min(AIM_TG, L * 0.2), Math.max(AIM_TG, L - 260))
  }

  /** velocidad en viento en cola: más despacio si alcanza al de delante */
  private spacingSpeed(sc: Scene, sT: number): number {
    const r = sc.rwy
    let v = this.perf.cruise
    for (const c of sc.contacts()) {
      if (c === this || c.onGround) continue
      if (c.phase !== 'downwind' && c.phase !== 'base' && c.phase !== 'player') continue
      const cd = r.d(c.pos.x, c.pos.z) * r.side
      const cs = r.s(c.pos.x, c.pos.z) - r.displaced
      if (cd < CIRCUIT_WIDTH * 0.5) continue
      const gap = sT - cs
      // (un autogiro vuela a gusto a 75 km/h: es la manera fácil de abrir hueco)
      if (gap > 0 && gap < 1000) v = Math.min(v, this.perf.cruise - clamp((1000 - gap) / 45, 0, 8.5))
    }
    return v
  }

  /**
   * ¿Puedo virar a base? Hace falta hueco en el umbral: detrás del que ya viene en base o en final
   * (tiene preferencia), con la pista libre cuando yo llegue, y sin adelantar al que va delante
   * de mí en viento en cola (el número uno vira primero).
   */
  private baseGap(sc: Scene, myEta: number, sT: number): boolean {
    const r = sc.rwy
    for (const c of sc.contacts()) {
      if (c === this) continue
      // la pista, ocupada todavía cuando yo llegue
      if (c.occupies > 0 && myEta < c.occupies + 12) return false
      if (c.eta === Infinity) continue
      if (c.phase === 'downwind') {
        // otro en viento en cola: si va delante de mí, vira él primero
        if (r.s(c.pos.x, c.pos.z) - r.displaced < sT) return false
        continue
      }
      // en base o en final (o el jugador que viene a tomar): detrás de él con hueco, o muy por delante
      const need = c.isPlayer ? 75 : c.fullStop ? 90 : 50
      if (myEta >= c.eta ? myEta - c.eta < need : c.eta - myEta < 80) return false
    }
    return true
  }

  /** nadie recién despegado demasiado cerca por delante, ni llegando */
  private upwindClear(sc: Scene): boolean {
    const r = sc.rwy
    const s0 = r.s(this.pos.x, this.pos.z)
    for (const c of sc.contacts()) {
      if (c === this) continue
      const s = r.s(c.pos.x, c.pos.z)
      const d = r.d(c.pos.x, c.pos.z)
      if (Math.abs(d) < 120 && s > s0 && s < s0 + 650 && (c.onGround ? Math.abs(d) < r.hw + 9 : c.agl < r.H * 0.6)) return false
      if (c.eta < 25) return false
    }
    return true
  }

  /**
   * ¿Sitio para entrar en viento en cola? No, si otro va a llegar al principio del tramo más o
   * menos a la vez que yo (me quedan unos 800 m).
   */
  private joinClear(sc: Scene): boolean {
    const r = sc.rwy
    const Lc = Math.min(r.total - r.displaced, 900)
    const sE = Lc + 150
    for (const c of sc.contacts()) {
      if (c === this || c.onGround) continue
      const cs = r.s(c.pos.x, c.pos.z) - r.displaced
      const cd = r.d(c.pos.x, c.pos.z) * r.side
      let dist = Infinity
      if (c.phase === 'upwind' || c.phase === 'goAround' || c.phase === 'liftoff') dist = Math.max(0, sE - cs) + CIRCUIT_WIDTH
      else if (c.phase === 'crosswind') dist = Math.max(0, CIRCUIT_WIDTH - cd)
      else if (c.phase === 'downwind') dist = cs - sE
      else if (c.phase === 'player' && cd > 150 && cd < CIRCUIT_WIDTH + 300 && cs > Lc - 300) dist = cs - sE
      else if ((c.phase === 'arrive' || c.phase === 'orbit') && Math.hypot(c.pos.x - this.pos.x, c.pos.z - this.pos.z) < 900) return this.id < (c as TrafficAircraft).id
      // (yo entro en el tramo unos 600 m más allá de su principio, tras recorrer unos 850)
      if (dist > -350 && dist < 900) return false
    }
    return true
  }

  /** nadie en viento cruzado o empezando el viento en cola a menos de 600 m */
  private crosswindClear(sc: Scene): boolean {
    for (const c of sc.contacts()) {
      if (c === this || c.onGround) continue
      if ((c.phase === 'crosswind' || c.phase === 'downwind' || c.phase === 'player') && Math.hypot(c.pos.x - this.pos.x, c.pos.z - this.pos.z) < 600 && Math.abs(c.pos.y - this.pos.y) < 120) return false
    }
    return true
  }

  /** alguien despegando o recién despegado por el eje de la pista (al que el que frustra deja ir delante) */
  private runwayTraffic(sc: Scene): boolean {
    const r = sc.rwy
    for (const c of sc.contacts()) {
      if (c === this || c.isPlayer) continue
      if (c.phase === 'roll' || c.phase === 'touchGo' || c.phase === 'liftoff' || c.phase === 'upwind') return true
      if (c.phase === 'crosswind' && Math.hypot(c.pos.x - this.pos.x, c.pos.z - this.pos.z) < 600) return true
    }
    void r
    return false
  }

  private goAround(sc: Scene, key: string): void {
    const r = sc.rwy
    this.stats.goArounds++
    if (DEBUG) console.log(`      ${this.callsign} frustra (${key}) agl ${this.ac.agl.toFixed(0)} d ${r.d(this.pos.x, this.pos.z).toFixed(0)} sT ${(r.s(this.pos.x, this.pos.z) - r.displaced).toFixed(0)} fase ${this.phase} ias ${(this.ac.ias * 3.6).toFixed(0)}`)
    this.goArounds++
    // por el lado contrario al circuito, para no perder de vista al que está en la pista
    this.sideStep = -r.side * 60
    sc.radio(this, key, { rwy: r.id })
    this.ap.syncThrottle()
    this.setPhase('goAround')
  }

  /** Red de seguridad: si otro aparato va a pasar demasiado cerca, se aparta. */
  private avoid(dt: number, sc: Scene): void {
    const ap = this.ap
    if (this.evadeT <= 0) this.evadeFrom = null
    if (this.evadeT > 0) {
      this.evadeT -= dt
      ap.holdTrack(dt, this.ac, this.evadeTrack, 0.5)
      ap.holdSpeed(dt, this.ac, this.perf.climb)
      ap.holdVs(dt, this.ac, this.evadeVs)
    }
    for (const c of sc.contacts()) {
      // (mientras se aparta de uno sigue mirando a los demás)
      if (c === this || c === this.evadeFrom || (c.onGround && c.agl < 1)) continue
      const rx = c.pos.x - this.pos.x
      const ry = c.pos.y - this.pos.y
      const rz = c.pos.z - this.pos.z
      const dist = Math.hypot(rx, rz)
      if (dist > 900 || Math.abs(ry) > 70) continue
      const vx = c.vel.x - this.vel.x
      const vy = c.vel.y - this.vel.y
      const vz = c.vel.z - this.vel.z
      const v2 = vx * vx + vz * vz
      // instante de máxima cercanía (en planta)
      const t = v2 > 0.5 ? clamp(-(rx * vx + rz * vz) / v2, 0, 14) : 0
      const mx = rx + vx * t
      const mz = rz + vz * t
      const my = ry + vy * t
      const miss = Math.hypot(mx, mz)
      if (miss > 75 || Math.abs(my) > 28) continue
      if (t <= 0 && dist > 90) continue
      // entre dos simulados cede el de detrás en el circuito (o el de número mayor); ante el jugador, siempre
      if (!c.isPlayer && !this.yieldsTo(c as TrafficAircraft)) continue
      // apartarse: virar alejándose y separarse en altura
      // hacia el lado contrario de por donde iba a pasar (de frente, cada uno a su derecha)
      const away = miss > 8 ? Math.atan2(-mx, mz) : ap.track + 1.2
      const turn = wrapPi(away - ap.track)
      this.evadeTrack = ap.track + clamp(turn, -1.2, 1.2)
      // en altura: el de arriba sube y el de abajo baja; a la misma altura, unos suben y otros bajan
      const up = Math.abs(ry) > 8 ? ry < 0 : this.id % 2 === 1
      this.evadeVs = up || this.agl < 110 ? 2.5 : -2.5
      this.evadeT = 6
      this.evadeFrom = c
      if (this.phase === 'final' || this.phase === 'base') this.goAround(sc, 'goAround')
      return
    }
  }

  private yieldsTo(o: TrafficAircraft): boolean {
    const rank: Partial<Record<Phase, number>> = { flare: 9, final: 8, base: 7, downwind: 6, crosswind: 5, upwind: 4, liftoff: 4, goAround: 3, arrive: 2, orbit: 2, depart: 1 }
    const a = rank[this.phase] ?? 0
    const b = rank[o.phase] ?? 0
    return a < b || (a === b && this.id > o.id)
  }
}
