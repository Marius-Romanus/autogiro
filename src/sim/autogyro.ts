// Dinámica de vuelo de un autogiro biplaza en tándem (tipo MTOsport / ELA-07).
// Cuerpo rígido de 6 grados de libertad + rotor libre en autorrotación + motor
// Rotax con hélice propulsora + cola en el soplado + tren triciclo. Geometría, pesos,
// resistencia y motor de cada aparato: `airframes.ts` y `engines.ts`.
//
// Marco del mundo: X este, Y arriba, Z sur (plano tangente local).
// Marco del cuerpo: x adelante, y arriba, z derecha; origen en el CG.

import { Matrix3, Matrix4, Quaternion, Vector3 } from 'three'
import { DEFAULT_ROTOR, Rotor } from './rotor.ts'
import { DEFAULT_PREROTATOR, GENERIC, PASSENGER_MASS, PILOT_MASS, propCoeffs, type Airframe } from './airframes.ts'
import { partLabel, t } from '../i18n.ts'
import { Compound } from './compound.ts'

const DEG = Math.PI / 180
const G = 9.80665
/**
 * Rozamiento que añaden los frenos de las ruedas principales a fondo (sobre 0.025 de rodadura):
 * μ 0.75 en total, el de un neumático frenado en asfalto seco. Con 0.55 el ELA 07, que apoya el
 * 40 % del peso en la rueda de morro, deslizaba prerrotando al 40 % de gas con el rotor a 160 rpm;
 * ahora sujeta hasta pasar las 200-220 rpm a las que se suelta (tools/fdm-ground.ts). Cada aparato
 * puede llevar el suyo (`brakeMu` en la ficha: el Cierva, con frenos de tambor, 0.55).
 */
const BRAKE_MU = 0.725

export interface Controls {
  /** palanca cabeceo −1 (adelante) .. +1 (atrás) */
  pitch: number
  /** palanca alabeo −1 (izq) .. +1 (dcha) */
  roll: number
  /** pedales −1 (izq) .. +1 (dcha) */
  yaw: number
  /** gas 0..1 */
  throttle: number
  /** compensador de cabeceo −1..1 (positivo = morro arriba) */
  trim: number
  prerotator: boolean
  rotorBrake: boolean
  /** freno de ruedas 0..1 */
  wheelBrake: number
}

export function defaultControls(): Controls {
  return { pitch: 0, roll: 0, yaw: 0, throttle: 0, trim: 0, prerotator: false, rotorBrake: false, wheelBrake: 0 }
}

export interface GroundProvider {
  /** altura del terreno (Y del mundo) bajo (x, z) y su normal */
  heightAt(x: number, z: number, outNormal: Vector3): number
}

export interface Environment {
  rho: number
  /** viento en la posición del aparato (mundo) */
  wind: Vector3
  ground: GroundProvider
}

type ContactKind = 'wheel' | 'nose' | 'tailwheel' | 'skid' | 'crash'
interface Contact {
  name: string
  kind: ContactKind
  r: Vector3 // respecto al CG
  k: number
  c: number
  wasInContact: boolean
  force: number
  /** deformación del neumático (m) a lo largo de la rueda y de lado (adherencia) */
  sf: number
  sl: number
}

// Geometría (respecto al origen del modelo 3D). Cada aparato tiene la suya en
// `airframes.ts`; `GEOM` y `CG` son las del genérico y se mantienen para el
// código que no distingue aparatos (el CG es común a todos).
export const GEOM = GENERIC as Airframe & { noseWheel: Vector3 }
/** posición del CG respecto al origen del modelo */
export const CG = GENERIC.cg

const _v = new Vector3()
const _v2 = new Vector3()
const _f = new Vector3()
const _m = new Vector3()
const _r = new Vector3()
const _n = new Vector3()
const _air = new Vector3()
const _hubN = new Vector3()
const _hubF = new Vector3()
const _hubPos = new Vector3()
const _hubVel = new Vector3()
const _hubWorld = new Vector3()
const _q = new Quaternion()
const _qh = new Quaternion()
const _mat = new Matrix3()
const _matT = new Matrix3()
const X = new Vector3(1, 0, 0)
const Y = new Vector3(0, 1, 0)
const Z = new Vector3(0, 0, 1)

export type CrashCause = 'gear' | 'nose' | 'tail' | 'structure' | 'rotor' | 'prop' | 'flapping' | 'rpm' | 'obstacle'

export interface CrashInfo {
  title: string
  detail: string
  /** qué falló (para empezar la simulación del accidente con esa pieza rota) */
  cause?: CrashCause
  /** nombre del punto de contacto que falló */
  part?: string
}

export class Autogyro {
  // --- estado ---
  readonly pos = new Vector3() // CG en el mundo
  readonly vel = new Vector3() // mundo
  readonly quat = new Quaternion() // cuerpo → mundo
  readonly omega = new Vector3() // cuerpo (rad/s)
  readonly rotor = new Rotor(DEFAULT_ROTOR)

  mass = 400
  readonly inertia = new Vector3(320, 470, 540) // alabeo, guiñada, cabeceo

  // motor
  engineOn = true
  enginePower = 0 // W
  engineRpm = 1400
  propThrust = 0
  propInduced = 0
  /** potencia máxima del motor montado (W) */
  maxPower = 73500

  // cabeza del rotor (para animación)
  headPitch = 0 // rad, positivo = hacia atrás
  headRoll = 0 // rad, positivo = derecha
  noseSteer = 0
  rudder = 0

  // --- salidas ---
  ias = 0 // m/s
  tas = 0
  aoa = 0
  beta = 0
  gLoad = 1
  vs = 0
  agl = 0
  onGround = false
  groundSpeed = 0
  wheelRolling = 0 // velocidad de rodadura en suelo (m/s) para sonido
  hardness = 0 // fuerza máxima de impacto en el último paso
  teeterHits = 0
  crash: CrashInfo | null = null
  warnings: string[] = []
  readonly lastForce = new Vector3()
  readonly specificForceBody = new Vector3()

  /** parámetros de ajuste fino */
  readonly tune = { stabArea: 0.9, stabSlip: 0.6, stabIncidence: -1.5, headBase: 7.2, headFwd: 8.2, headAft: 8.8, rollTrim: 0.35, swirl: 0.04, sideCPy: 0.3, finArea: 0.82, finDy: 0, dihedral: 0, cdA: 0.6, propEta: 1, brakeMu: BRAKE_MU }

  private contacts: Contact[] = []
  /** puntos de contacto (respecto al origen del modelo) de `contacts`, en el mismo orden */
  private contactPts: Vector3[] = []
  private passenger = false
  /** centro de gravedad con la carga actual (origen del modelo): el de la ficha más lo que lo mueven los ocupantes */
  readonly cg = new Vector3(0.08, 0.1, 0)
  /** desplazamiento del CG respecto al de la ficha (lo usa la vista para colocar el modelo) */
  readonly cgOff = new Vector3()
  private readonly accel = new Vector3()
  private lowRpmTimer = 0

  /** geometría del aparato en uso */
  af: Airframe = GENERIC
  /** ala, hélice de paso variable y rotor frenado (Carter PAV); null en los autogiros de siempre */
  cmp: Compound | null = null

  constructor(airframe: Airframe = GENERIC) {
    this.setAirframe(airframe)
  }

  /**
   * Cambia la geometría del aparato (ruedas, hélice, cola y puntos de la célula).
   * Hay que recolocarlo después (placeOnGround / placeInAir).
   */
  setAirframe(af: Airframe): void {
    this.af = af
    this.cmp = af.wing || af.slowedRotor || af.cspProp ? new Compound(af) : null
    this.rotor.collective = 0
    this.tune.stabArea = af.stabArea
    this.tune.finArea = af.finArea
    this.tune.headBase = af.head.base
    this.tune.headAft = af.head.aft
    this.tune.headFwd = af.head.fwd
    this.tune.cdA = af.cdA
    this.tune.rollTrim = af.rollTrim ?? 0.35
    this.tune.brakeMu = af.brakeMu ?? BRAKE_MU
    this.tune.stabIncidence = af.stabIncidence ?? -1.5
    this.maxPower = af.engine.maxPower
    this.rotor.p = af.rotor
    this.contacts = []
    this.setLoad(this.passenger)
    this.restHeight = this.restAttitude().height
    // buje del aparato nuevo, con la cabeza en reposo (hasta el primer paso o la colocación)
    this.computeHub(0, 0)
    const c =(name: string, kind: ContactKind, p: Vector3, k: number, cDamp: number): Contact => ({
      name,
      kind,
      r: p.clone().sub(this.cg),
      k,
      c: cDamp,
      wasInContact: false,
      force: 0,
      sf: 0,
      sl: 0,
    })
    // rigidez y amortiguación del tren (las cifras son las de un aparato de ~480 kg)
    const kg = af.gearScale ?? 1
    this.contacts = [
      ...(af.noseWheel ? [c('rueda de morro', 'nose', af.noseWheel, 38000 * (af.noseGearScale ?? 1), 2600 * (af.noseGearScale ?? 1))] : []),
      ...(af.tailWheel ? [c('rueda de cola', 'tailwheel', af.tailWheel, 30000 * kg, 2400 * kg)] : []),
      c('rueda principal izquierda', 'wheel', af.mainL, 60000 * kg, 4200 * kg),
      c('rueda principal derecha', 'wheel', af.mainR, 60000 * kg, 4200 * kg),
      c('patín de cola', 'skid', af.tail, 45000 * kg, 3000 * kg),
      ...af.crashPoints.map((cp) => {
        const tailPart = cp.name === 'estabilizador' || cp.name === 'deriva'
        return c(cp.name, 'crash', cp.p, tailPart ? 60000 : 80000, tailPart ? 4000 : 5000)
      }),
    ]
    this.contactPts = [
      ...(af.noseWheel ? [af.noseWheel] : []),
      ...(af.tailWheel ? [af.tailWheel] : []),
      af.mainL,
      af.mainR,
      af.tail,
      ...af.crashPoints.map((cp) => cp.p),
    ]
  }

  /** Masa en orden de vuelo del aparato en uso: vacío + combustible + piloto (+ pasajero). */
  setLoad(passenger: boolean): void {
    // (un monoplaza no lleva pasajero aunque el menú lo pida)
    this.passenger = passenger
    const pax = passenger && (this.af.seats ?? 2) > 1 ? PASSENGER_MASS : 0
    this.mass = this.af.emptyMass + this.af.fuelMass + PILOT_MASS + pax
    // asientos lado a lado: cada ocupante tira del CG hacia su lado
    const sz = this.af.seatZ
    this.cgOff.set(0, 0, sz ? (PILOT_MASS * sz.pilot + pax * sz.passenger) / this.mass : 0)
    this.cg.copy(this.af.cg).add(this.cgOff)
    // el piloto lo compensa con el compensador de alabeo: la cabeza se inclina hacia el lado ligero
    // lo justo para que el empuje del rotor pase por el CG (el fuselaje cuelga algo ladeado)
    if (sz) this.tune.rollTrim = (this.af.rollTrim ?? 0.35) - Math.atan2(this.cgOff.z, this.af.hub.y - this.cg.y) / DEG
    for (let i = 0; i < this.contacts.length; i++) this.contacts[i].r.copy(this.contactPts[i]).sub(this.cg)
    const s = this.mass / 400
    const [ix, iy, iz] = this.af.inertia ?? [320, 470, 540]
    this.inertia.set(ix * s, iy * s, iz * s)
  }

  /**
   * Postura en tierra con todas las ruedas apoyadas: cabeceo (rad, morro arriba; 0 en
   * los triciclo) y altura del CG sobre el suelo.
   */
  restAttitude(): { pitch: number; height: number } {
    const af = this.af
    const pitch = af.tailWheel ? Math.atan2(af.tailWheel.y - af.mainL.y, af.mainL.x - af.tailWheel.x) : 0
    const rx = af.mainL.x - this.cg.x
    const ry = af.mainL.y - this.cg.y
    return { pitch, height: -(rx * Math.sin(pitch) + ry * Math.cos(pitch)) }
  }

  /** vueltas de rotor de referencia: las del genérico × `rpmScale` del aparato */
  get rpmScale(): number {
    return this.af.rpmScale ?? 1
  }

  /**
   * Escala de las vueltas para los avisos de bajas vueltas: la fija del aparato o, con rotor
   * frenado, la que pide su ley de vueltas a la velocidad actual (a 110 rpm en crucero rápido no
   * pasa nada; a 110 rpm a 90 km/h, sí).
   */
  get rpmWarnScale(): number {
    return this.cmp && this.af.slowedRotor ? this.cmp.warnScale : this.rpmScale
  }

  /** altura del CG sobre el suelo con el aparato parado (para la altura AGL) */
  private restHeight = 1.15

  /** Cuerpo → mundo para un vector local. */
  toWorld(v: Vector3, out: Vector3): Vector3 {
    return out.copy(v).applyQuaternion(this.quat)
  }

  /** Coloca el aparato parado en el suelo con rumbo `headingDeg` (verdadero). */
  placeOnGround(x: number, z: number, groundY: number, headingDeg: number): void {
    this.crash = null
    this.teeterHits = 0
    const h = headingDeg * DEG
    // rumbo 0 = norte (−Z); yaw positivo = morro a la izquierda
    this.quat.setFromAxisAngle(Y, -h + Math.PI / 2)
    // postura en tierra: nivelado (triciclo) o con la cola apoyada (rueda de cola)
    const rest = this.restAttitude()
    if (rest.pitch) this.quat.multiply(_q.setFromAxisAngle(Z, rest.pitch))
    // altura: ruedas apoyadas (en los triciclo, −1.05 respecto al origen del modelo)
    this.pos.set(x, groundY + rest.height - 0.035, z)
    this.vel.set(0, 0, 0)
    this.omega.set(0, 0, 0)
    this.rotor.omega = 0
    this.rotor.vi = 0
    this.computeHub(0, 0)
    this.rotor.alignTo(_hubN)
    this.engineOn = true
    this.enginePower = 0
    this.engineRpm = this.af.engine.idleRpm
    for (const c of this.contacts) {
      c.wasInContact = true
      c.sf = c.sl = 0
    }
    if (this.cmp) {
      this.cmp.reset(this)
      this.computeHub(0, 0)
      this.rotor.alignTo(_hubN)
    }
  }

  /** Coloca el aparato en vuelo nivelado. */
  placeInAir(x: number, y: number, z: number, headingDeg: number, speed: number): void {
    this.crash = null
    this.teeterHits = 0
    const h = headingDeg * DEG
    this.quat.setFromAxisAngle(Y, -h + Math.PI / 2)
    this.pos.set(x, y, z)
    const fwd = _v.set(1, 0, 0).applyQuaternion(this.quat)
    this.vel.copy(fwd).multiplyScalar(speed)
    this.omega.set(0, 0, 0)
    this.rotor.rpm = 365 * this.rpmScale
    this.rotor.vi = 1.5
    if (this.cmp) this.cmp.placeInAir(this, speed)
    this.computeHub(0.25, 0)
    this.rotor.alignTo(_hubN)
    // disco algo hacia atrás (blowback de equilibrio)
    _v2.set(0, 0, 1).applyQuaternion(this.quat)
    this.rotor.normal.applyAxisAngle(_v2, 3 * DEG)
    this.engineOn = true
    this.enginePower = 0.5 * this.maxPower
    this.engineRpm = this.af.engine.cruiseRpm
    for (const c of this.contacts) {
      c.wasInContact = false
      c.sf = c.sl = 0
    }
  }

  /** Calcula normal/adelante del plano de cabeza (mundo) a partir de la palanca. */
  private computeHub(pitchCmd: number, rollCmd: number): void {
    // cabeza: inclinación atrás −5°..+14°, alabeo ±7.5°, +0.6° a la derecha para compensar par
    const t = this.tune
    this.headPitch = (pitchCmd < 0 ? t.headBase + t.headFwd * pitchCmd : t.headBase + t.headAft * pitchCmd) * DEG
    this.headRoll = (7.5 * rollCmd + this.tune.rollTrim) * DEG
    _qh.setFromAxisAngle(Z, this.headPitch)
    _q.setFromAxisAngle(X, this.headRoll)
    _qh.multiply(_q)
    if (this.cmp && this.af.slowedRotor) {
      // mástil basculante: el mástil gira sobre su pie (`headPivot`) y lleva el buje adelante o
      // atrás; la palanca inclina además el plano de la cabeza sobre el buje
      const mast = this.cmp.mast
      this.headPitch += mast + this.cmp.headTrim
      _qh.setFromAxisAngle(Z, this.headPitch).multiply(_q.setFromAxisAngle(X, this.headRoll))
      _q.copy(this.quat).multiply(_qh)
      _hubN.copy(Y).applyQuaternion(_q)
      _hubF.copy(X).applyQuaternion(_q)
      _hubPos.copy(this.af.hub).sub(this.af.headPivot).applyAxisAngle(Z, mast).add(this.af.headPivot).sub(this.cg)
      this.hubBody.copy(_hubPos)
      return
    }
    _q.copy(this.quat).multiply(_qh)
    _hubN.copy(Y).applyQuaternion(_q)
    _hubF.copy(X).applyQuaternion(_q)
    // posición del buje (la cabeza bascula alrededor de su pivote)
    _hubPos.copy(this.af.hub).sub(this.af.headPivot).applyQuaternion(_qh).add(this.af.headPivot).sub(this.cg)
    this.hubBody.copy(_hubPos)
  }

  /**
   * Posición del buje en coordenadas del cuerpo (respecto al CG) del último paso, o de la
   * colocación: la vista pone ahí el rotor también mientras carga la salida y con el menú
   * abierto (a cero, las palas atravesaban la cabina).
   */
  readonly hubBody = new Vector3()

  step(dt: number, ctl: Controls, env: Environment): void {
    if (this.crash) return
    const rho = env.rho
    const q = this.quat
    _mat.setFromMatrix4(_tmpM4.makeRotationFromQuaternion(q))
    _matT.copy(_mat).transpose()

    // ---------------- Mandos ----------------
    const pitchCmd = Math.max(-1, Math.min(1, ctl.pitch + ctl.trim * 0.45))
    // automatismos del rotor frenado (mástil, colectivo, salto) y profundidad
    if (this.cmp) this.cmp.update(dt, this, ctl, pitchCmd)
    this.computeHub(pitchCmd, ctl.roll)
    // (sin timón, como el Cierva C.30A, los pedales solo giran la rueda de cola)
    this.rudder = this.af.rudder === false ? 0 : ctl.yaw * 25 * DEG
    this.noseSteer = ctl.yaw * 22 * DEG

    _f.set(0, 0, 0) // fuerza total (mundo)
    _m.set(0, 0, 0) // momento total (cuerpo)

    // velocidad respecto al aire en el CG (cuerpo)
    const vRelBody = _v.copy(this.vel).sub(env.wind).applyMatrix3(_matT)
    const vx = vRelBody.x
    const vy = vRelBody.y
    const vz = vRelBody.z
    const V = vRelBody.length()
    this.tas = V
    this.aoa = Math.atan2(-vy, Math.max(Math.abs(vx), 0.1))
    this.beta = Math.atan2(vz, Math.max(Math.abs(vx), 0.1))

    // ---------------- Rotor ----------------
    const hubWorldOff = _hubWorld.copy(_hubPos).applyQuaternion(q)
    _hubVel.copy(this.omega).cross(_hubPos).applyQuaternion(q).add(this.vel)
    _air.copy(env.wind).sub(_hubVel)
    const hubGroundY = env.ground.heightAt(this.pos.x + hubWorldOff.x, this.pos.z + hubWorldOff.z, _n)
    const hubAGL = this.pos.y + hubWorldOff.y - hubGroundY

    // prerrotador y freno de rotor
    let shaftTorque = 0
    if (this.cmp) this.cmp.prerotTorque = 0
    const airborneFast = V > 18 && !this.onGround
    const pre = this.af.prerotator ?? DEFAULT_PREROTATOR
    if (ctl.prerotator && this.engineOn && !airborneFast && this.engineRpm > pre.minEngineRpm) {
      const targetRpm = Math.min(this.engineRpm * pre.ratio, pre.maxRpm)
      const targetOmega = (targetRpm * 2 * Math.PI) / 60
      const t = Math.max(0, Math.min(1, (targetOmega - this.rotor.omega) / 2.5))
      shaftTorque += pre.torque * t
      if (this.cmp) this.cmp.prerotTorque = pre.torque * t
      // reacción sobre el fuselaje (guiñada a la derecha)
      _m.y -= pre.torque * t * 0.9
    }
    if (ctl.rotorBrake && this.rotor.omega > 0) {
      const brake = Math.min(260, (this.rotor.p.inertia * this.rotor.omega) / dt)
      shaftTorque -= brake
    }

    this.rotor.step(dt, {
      rho,
      airVel: _air,
      hubNormal: _hubN,
      hubForward: _hubF,
      heightAGL: hubAGL,
      shaftTorque,
    })
    // fuerza del rotor aplicada en el buje
    _f.add(this.rotor.force)
    _v2.copy(this.rotor.force).applyMatrix3(_matT) // a cuerpo
    _m.add(_tmpV.crossVectors(_hubPos, _v2))
    // golpes en topes de balancín
    if (this.rotor.teeterHit > 0) {
      _m.add(_v2.copy(this.rotor.stopMoment).applyMatrix3(_matT))
      this.teeterHits += this.rotor.teeterHit * dt * 4
    } else {
      this.teeterHits = Math.max(0, this.teeterHits - dt * 0.6)
    }

    // ---------------- Motor y hélice ----------------
    // Motor del aparato (`engines.ts`: Rotax 912 ULS o 914 turbo, reductora 2.43) +
    // hélice tripala de paso fijo de 1.72 m, con el paso ajustado a ese motor. Las
    // RPM salen del equilibrio entre el par del motor y el de
    // la hélice (curvas CT/CP en función del avance J), así que el régimen sube con
    // la velocidad, en estático no da toda la potencia y al ralentí en planeo la
    // hélice gira arrastrada por el aire y frena un poco.
    // (El Cierva C.30A lleva un radial de toma directa y una bipala de madera con sus
    // propias curvas: `engine.gear` y `propCoef` en su ficha.)
    const thr = Math.max(0, Math.min(1, ctl.throttle))
    let T: number
    let Qp: number
    if (this.cmp && this.af.cspProp) {
      // hélice de paso variable con regulador (Carter PAV): `compound.ts`
      this.cmp.propeller(dt, this, thr, vx, rho, ctl.prerotator, _prop)
      T = _prop.T
      Qp = _prop.Q
    } else {
      const eng = this.af.engine
      const GEAR = eng.gear
      const Dp = 2 * this.af.propRadius
      const Ap = Math.PI * this.af.propRadius * this.af.propRadius
      const Vax = Math.max(0, vx)
      const nProp = Math.max(0.2, this.engineRpm / GEAR / 60) // rev/s
      const J = Vax / (nProp * Dp)
      const pc = propCoeffs(this.af)
      const J0 = pc.j0 // avance de empuje nulo
      const J1 = pc.j1 // avance de potencia absorbida nula
      const D4 = Dp * Dp * Dp * Dp
      // empuje
      if (J < J0) T = pc.ct0 * (1 - Math.pow(J / J0, 2.4)) * rho * nProp * nProp * D4
      else T = -0.5 * rho * Vax * Vax * Ap * 0.09 * Math.min(1, (J - J0) / (0.6 * J0)) // frenado en molinete
      T *= this.tune.propEta
      // par absorbido por la hélice (negativo = el aire la arrastra)
      Qp = (pc.cp0 * (1 - Math.pow(J / J1, 3.8)) * rho * nProp * nProp * D4 * Dp) / (2 * Math.PI)
      const QpMin = -0.5 * rho * Vax * Vax * Ap * this.af.propRadius * 0.02
      if (Qp < QpMin) Qp = QpMin
      // par del motor en el cigüeñal
      const rpm = this.engineRpm
      const dR = rpm - eng.rpmPeak
      const na = rho / 1.225
      const air = eng.turbo ? na + (Math.min(1, rho / eng.rhoCrit) - na) * thr : na
      let Tmax = (eng.torquePeak - (dR < 0 ? eng.dropBelow : eng.dropAbove) * dR * dR) * air
      if (rpm > eng.rpmLimit) Tmax *= Math.max(0, 1 - ((rpm - eng.rpmLimit) / 250) * (5900 / eng.rpmLimit)) // limitador
      const Tfric = eng.friction[0] + eng.friction[1] * rpm
      let Qe: number
      if (this.engineOn) {
        const th = eng.idle + (1 - eng.idle) * thr
        Qe = th * Math.max(0, Tmax) - (1 - th) * Tfric
        if (rpm < eng.starterRpm) Qe += 35 * (eng.torquePeak / 128) * (1 - rpm / eng.starterRpm) // motor de arranque
      } else {
        Qe = -1.8 * Tfric - 6 * (eng.torquePeak / 128) // compresión: la hélice se para
      }
      // dinámica del conjunto (inercia vista desde la hélice)
      const propOmega0 = nProp * 2 * Math.PI
      let propOmega = propOmega0 + ((Qe * GEAR * 0.97 - Qp) / eng.inertia) * dt
      if (propOmega < 0) propOmega = 0
      this.engineRpm = (propOmega * GEAR * 60) / (2 * Math.PI)
      this.enginePower = Math.max(0, Qe) * ((rpm * 2 * Math.PI) / 60)
      this.propThrust = T
      this.propInduced = T > 0 ? -Vax / 2 + Math.sqrt((Vax * Vax) / 4 + T / (2 * rho * Ap)) : 0
    }
    _r.copy(this.af.prop).sub(this.cg)
    _v2.set(T, 0, 0)
    _f.add(_tmpV.copy(_v2).applyQuaternion(q))
    _m.add(_tmpV.crossVectors(_r, _v2))
    // par de reacción (alabeo a la izquierda con potencia) y remolino del soplado
    _m.x -= 0.35 * Qp * (this.af.torqueRoll ?? 1)
    _m.y += this.tune.swirl * Math.max(0, T) * (this.af.swirlYaw ?? 1)

    const vSlip = 2 * this.propInduced

    // ---------------- Fuselaje ----------------
    const qd = 0.5 * rho * V
    const body = this.af.body
    // fuerza del aire sobre el fuselaje = −½ρ|V|·CdA·v (v: velocidad respecto al aire)
    _v2.set(-qd * this.tune.cdA * vx, -qd * (body?.vertCdA ?? 2.6) * vy, 0)
    _f.add(_tmpV.copy(_v2).applyQuaternion(q))
    if (body) _r.copy(body.vertCP)
    else _r.set(0.35, -0.18, 0)
    _m.add(_tmpV.crossVectors(_r, _v2))
    // fuerza lateral: góndola, pilotos, mástil y cabeza → centro de presión por encima del CG
    _v2.set(0, 0, -qd * (body?.sideCdA ?? 2.4) * vz)
    _f.add(_tmpV.copy(_v2).applyQuaternion(q))
    if (body) _r.copy(body.sideCP)
    else _r.set(0.25, this.tune.sideCPy, 0)
    _m.add(_tmpV.crossVectors(_r, _v2))
    // sustentación ligera de la góndola (morro arriba con ángulo de ataque)
    _m.z += 0.5 * rho * V * V * 0.12 * Math.sin(this.aoa) * 0.6

    // ---------------- Ala (Carter PAV) ----------------
    if (this.cmp && this.af.wing) this.cmp.wing(this, vRelBody, rho, ctl.roll, q, _f, _m)

    // ---------------- Estabilizador horizontal ----------------
    // Modelo de placa válido a cualquier ángulo (incluido flujo desde abajo en
    // descenso vertical y flujo invertido): es lo que hace que la cola "busque"
    // el viento relativo y baje el morro cuando falta velocidad.
    {
      _r.copy(this.af.stab).sub(this.cg)
      const u = _tmpV.copy(this.omega).cross(_r).add(vRelBody) // velocidad del punto respecto al aire
      const ux = u.x + this.tune.stabSlip * vSlip
      // (con profundidad: incidencia según la palanca, estela del ala y del rotor)
      const cx = this.cmp
      plate(ux, cx ? u.y + cx.tailWash : u.y, cx ? this.tune.stabIncidence * DEG + cx.tailIncidence : this.tune.stabIncidence * DEG, this.af.stabSlope, this.af.stabCd90, _pf)
      const k = 0.5 * rho * this.tune.stabArea
      _v2.set(k * _pf.x, k * _pf.n, 0)
      _f.add(_v3.copy(_v2).applyQuaternion(q))
      _m.add(_v3.crossVectors(_r, _v2))
    }

    // ---------------- Deriva y timón ----------------
    {
      _r.copy(this.af.fin).sub(this.cg)
      _r.y += this.tune.finDy
      const u = _tmpV.copy(this.omega).cross(_r).add(vRelBody)
      const ux = u.x + 0.65 * vSlip
      // eje normal = −z (fuerza positiva hacia la izquierda); timón a la derecha = más "incidencia"
      plate(ux, -u.z, 0.5 * this.rudder, 3.0, 1.2, _pf)
      const k = 0.5 * rho * this.tune.finArea
      _v2.set(k * _pf.x, 0, -k * _pf.n)
      _f.add(_v3.copy(_v2).applyQuaternion(q))
      _m.add(_v3.crossVectors(_r, _v2))
    }

    // amortiguamiento aerodinámico residual (alabeo/guiñada) de góndola, tren y estructura
    _m.x -= 0.5 * rho * V * 6.0 * this.omega.x
    _m.y -= 0.5 * rho * V * 9.0 * this.omega.y
    _m.z -= 0.5 * rho * V * 6.0 * this.omega.z

    // ---------------- Gravedad ----------------
    _f.y -= this.mass * G

    // ---------------- Tren de aterrizaje y contactos ----------------
    this.onGround = false
    this.hardness = 0
    this.wheelRolling = 0
    for (const c of this.contacts) {
      const rw = _r.copy(c.r).applyQuaternion(q)
      const px = this.pos.x + rw.x
      const py = this.pos.y + rw.y
      const pz = this.pos.z + rw.z
      const gy = env.ground.heightAt(px, pz, _n)
      // penetración a lo largo de la normal
      const depth = (gy - py) * _n.y
      if (depth <= 0) {
        c.wasInContact = false
        c.force = 0
        c.sf = c.sl = 0
        continue
      }
      // velocidad del punto (mundo)
      const pv = _tmpV.copy(this.omega).cross(c.r).applyQuaternion(q).add(this.vel)
      const vn = pv.dot(_n)
      if (!c.wasInContact) {
        const impact = -vn
        this.hardness = Math.max(this.hardness, impact)
        this.checkImpact(c, impact, pv)
        if (this.crash) return
      }
      c.wasInContact = true
      let Fn = c.k * Math.min(depth, 0.4) - c.c * vn
      if (Fn < 0) Fn = 0
      c.force = Fn
      // fricción
      const fx = _v2.set(0, 0, 0)
      if (c.kind === 'wheel' || c.kind === 'nose' || c.kind === 'tailwheel') {
        this.onGround = true
        // la rueda de cola gira al revés que los pedales (para llevar el morro a la derecha
        // la cola va a la izquierda); si es loca, apenas sujeta de lado
        const tw = c.kind === 'tailwheel'
        const twSteer = this.af.tailWheelSteer ?? 0
        const steer = c.kind === 'nose' ? this.noseSteer : tw ? (-this.noseSteer * twSteer) / 22 : 0
        const dir = _v3.set(Math.cos(steer), 0, Math.sin(steer)).applyQuaternion(q)
        dir.addScaledVector(_n, -dir.dot(_n)).normalize()
        const lat = _v4.crossVectors(_n, dir)
        const vf = pv.dot(dir)
        const vl = pv.dot(lat)
        // rodadura (y freno en las principales) a lo largo de la rueda; agarre de lado
        const muF = c.kind === 'nose' || tw ? 0.025 : 0.025 + this.tune.brakeMu * Math.max(0, Math.min(1, ctl.wheelBrake))
        const muL = tw && twSteer === 0 ? 0.12 : 0.75
        const Ff = grip(c.sf, vf, muF * Fn, Fn, dt)
        c.sf = _grip.s
        const Fl = grip(c.sl, vl, muL * Fn, Fn, dt)
        c.sl = _grip.s
        fx.addScaledVector(dir, Ff).addScaledVector(lat, Fl)
        this.wheelRolling = Math.max(this.wheelRolling, Math.abs(vf))
      } else {
        // patín / estructura: fricción isotrópica
        const tang = _v3.copy(pv).addScaledVector(_n, -vn)
        const vt = tang.length()
        if (vt > 1e-4) fx.addScaledVector(tang, (-(c.kind === 'skid' ? 0.45 : 0.6) * Fn * Math.tanh(vt / 0.2)) / vt)
        if (c.kind === 'skid') this.onGround = true
      }
      fx.addScaledVector(_n, Fn)
      _f.add(fx)
      _v3.copy(fx).applyMatrix3(_matT)
      _m.add(_v4.crossVectors(c.r, _v3))
    }

    // ---------------- Golpe de palas contra el suelo ----------------
    this.checkRotorStrike(env, hubWorldOff)
    if (this.crash) return

    // ---------------- Integración ----------------
    this.lastForce.copy(_f)
    this.accel.copy(_f).multiplyScalar(1 / this.mass)
    // fuerza específica (lo que "siente" el piloto), en g y ejes del cuerpo
    this.specificForceBody.set(_f.x, _f.y + this.mass * G, _f.z).multiplyScalar(1 / (this.mass * G)).applyMatrix3(_matT)
    this.gLoad = this.specificForceBody.y

    this.vel.addScaledVector(this.accel, dt)
    this.pos.addScaledVector(this.vel, dt)

    // Euler: I ω̇ = M − ω × Iω
    const I = this.inertia
    const w = this.omega
    const Iw = _v2.set(I.x * w.x, I.y * w.y, I.z * w.z)
    const gyro = _v3.crossVectors(w, Iw)
    w.x += ((_m.x - gyro.x) / I.x) * dt
    w.y += ((_m.y - gyro.y) / I.y) * dt
    w.z += ((_m.z - gyro.z) / I.z) * dt
    // integra la orientación
    const ang = w.length() * dt
    if (ang > 1e-12) {
      _q.setFromAxisAngle(_v4.copy(w).normalize(), ang)
      q.multiply(_q).normalize()
    }

    // ---------------- Salidas ----------------
    const pitot = Math.max(0, vx)
    this.ias = pitot * Math.sqrt(rho / 1.225)
    this.vs = this.vel.y
    this.groundSpeed = Math.hypot(this.vel.x, this.vel.z)
    this.agl = this.pos.y - env.ground.heightAt(this.pos.x, this.pos.z, _n) - this.restHeight

    this.warnings.length = 0
    // vueltas de rotor referidas a las de los autogiros actuales (el Cierva gira más despacio)
    // (con rotor frenado, referidas a las que pide la ley de vueltas a esta velocidad, y avisa
    // también si el rotor va demasiado lento para la velocidad: μ alto)
    const rrpm = this.rotor.rpm / this.rpmWarnScale
    if (!this.onGround && (rrpm < 260 || (this.cmp !== null && this.cmp.muHigh(this)))) {
      this.warnings.push(t('warn.lowRotor'))
      this.lowRpmTimer += dt
    } else this.lowRpmTimer = 0
    if (this.rotor.teeterHit > 0) this.warnings.push(t('warn.teeter'))
    if (!this.onGround && this.gLoad < 0.35) this.warnings.push(t('warn.lowG'))
    if (this.onGround && this.groundSpeed > 6 && rrpm < 180 && this.rotor.mu > 0.28)
      this.warnings.push(t('warn.flapping'))
    // prerrotador contra el freno del rotor: el freno se come el par y el rotor no arranca
    if (ctl.prerotator && ctl.rotorBrake) this.warnings.push(t('warn.prerotBrake'))

    // Fallos estructurales / pérdidas de control irrecuperables
    if (this.teeterHits > 3.5) {
      this.crash = {
        cause: 'flapping',
        title: t('crash.flapping.title'),
        detail: this.onGround
          ? t('crash.flapping.ground')
          : t('crash.flapping.air'),
      }
      return
    }
    if (!this.onGround && (rrpm < 120 || (this.cmp !== null && this.cmp.rotorLost(this))) && this.agl > 3) {
      this.crash = {
        cause: 'rpm',
        title: t('crash.rpm.title'),
        detail: t('crash.rpm.detail'),
      }
      return
    }
    const up = _v4.set(0, 1, 0).applyQuaternion(q)
    if (!this.onGround && up.y < -0.2 && this.agl > 2) {
      // vuelco (bunt-over / PPO): no se termina hasta tocar el suelo, pero avisamos
      this.warnings.push(t('warn.attitude'))
    }
  }

  private checkImpact(c: Contact, impact: number, pv: Vector3): void {
    const speed = pv.length()
    if (c.kind === 'crash' && (impact > 1.2 || speed > 4)) {
      this.crash = {
        cause: 'structure',
        part: c.name,
        title: t('crash.part.title', { part: partLabel(c.name) }),
        detail:
          c.name === 'mástil'
            ? t('crash.mast.detail')
            : t('crash.part.detail', { part: partLabel(c.name), kmh: (speed * 3.6).toFixed(0) }),
      }
    } else if ((c.kind === 'wheel' && impact > 3.6) || ((c.kind === 'nose' || c.kind === 'tailwheel') && impact > 3.3)) {
      this.crash = {
        cause: c.kind === 'nose' ? 'nose' : 'gear',
        part: c.name,
        title: t('crash.gear.title'),
        detail: t('crash.gear.detail', { fpm: (impact * 196.85).toFixed(0), ms: impact.toFixed(1) }),
      }
    } else if (c.kind === 'skid' && impact > 3) {
      this.crash = {
        cause: 'tail',
        part: c.name,
        title: t('crash.tail.title'),
        detail: t('crash.tail.detail'),
      }
    }
  }

  private checkRotorStrike(env: Environment, hubWorldOff: Vector3): void {
    const n = this.rotor.normal
    if (this.rotor.omega < 3) return
    // punto más bajo del disco: dirección en el plano del disco más hacia abajo
    const down = _v3.set(0, -1, 0).addScaledVector(n, n.y)
    const len = down.length()
    if (len < 1e-4) return
    down.multiplyScalar(this.rotor.p.radius / len)
    const tipX = this.pos.x + hubWorldOff.x + down.x
    const tipY = this.pos.y + hubWorldOff.y + down.y
    const tipZ = this.pos.z + hubWorldOff.z + down.z
    const gy = env.ground.heightAt(tipX, tipZ, _n)
    if (tipY < gy + 0.05) {
      // Si las palas ya venían golpeando los topes del balancín, el vuelco es la
      // consecuencia del batimiento (un aparato ligero y potente vuelca antes de que
      // el batimiento rompa nada): se diagnostica como tal.
      this.crash =
        this.teeterHits > 1
          ? {
              cause: 'flapping',
              title: t('crash.flapping.title'),
              detail: this.onGround ? t('crash.flapping.ground') : t('crash.flapping.air'),
            }
          : {
              cause: 'rotor',
              title: t('crash.rotor.title'),
              detail: t('crash.rotor.detail'),
            }
    }
    // hélice: punto inferior del disco de la hélice
    const pr = _v4.copy(this.af.prop).sub(this.cg)
    pr.y -= this.af.propRadius
    pr.applyQuaternion(this.quat).add(this.pos)
    const gp = env.ground.heightAt(pr.x, pr.z, _n)
    if (pr.y < gp && this.engineRpm > 1000) {
      this.crash = {
        cause: 'prop',
        title: t('crash.prop.title'),
        detail: t('crash.prop.detail'),
      }
    }
  }
}

const _pf = { x: 0, n: 0 }
const _prop = { T: 0, Q: 0 }

// Adherencia de las ruedas (modelo de cerdas): mientras la fuerza no pasa de μ·N, el neumático
// se queda pegado al suelo y solo se deforma unos milímetros (rigidez y amortiguación
// proporcionales a la carga); al pasar de μ·N desliza con μ·N. Así el freno y el agarre de
// lado sujetan de verdad: con un rozamiento que solo depende de la velocidad (el de antes,
// μ·N·tanh(v/v₀)) no hay rozamiento estático y el aparato parado se arrastraba y giraba poco
// a poco con el viento, el empuje al ralentí o la reacción del prerrotador, aun frenado.
const GRIP_K = 60 // 1/m: con μ = 0.75 desliza a 1.25 cm de deformación
const GRIP_C = 4 // s/m
const _grip = { s: 0 }

/** Fuerza de rozamiento en un eje de la rueda (deja la nueva deformación en `_grip.s`). */
function grip(s: number, v: number, cap: number, fn: number, dt: number): number {
  if (fn <= 0) {
    _grip.s = 0
    return 0
  }
  s += v * dt
  let f = -GRIP_K * fn * s - GRIP_C * fn * v
  if (Math.abs(f) > cap) {
    // desliza: el neumático se queda en la deformación que da justo μ·N
    f = Math.sign(f) * cap
    s = -f / (GRIP_K * fn)
  }
  _grip.s = s
  return f
}

/**
 * Fuerza aerodinámica (por unidad de ½ρS) sobre una superficie plana.
 * ux, un: velocidad de la superficie respecto al aire a lo largo de la cuerda
 * (adelante) y de su normal. Devuelve componentes en esos mismos ejes.
 * Válido para cualquier ángulo: lineal hasta la pérdida y placa plana después
 * (Cn → cd90 con el flujo perpendicular).
 */
function plate(ux: number, un: number, incidence: number, a: number, cd90: number, out: { x: number; n: number }): void {
  const v2 = ux * ux + un * un
  if (v2 < 1e-6) {
    out.x = 0
    out.n = 0
    return
  }
  const v = Math.sqrt(v2)
  let alpha = Math.atan2(-un, ux) + incidence
  if (alpha > Math.PI) alpha -= 2 * Math.PI
  else if (alpha < -Math.PI) alpha += 2 * Math.PI
  const stall = 0.27
  const abs = Math.abs(alpha)
  const s = Math.sin(alpha)
  const clFlat = 1.05 * Math.sin(2 * alpha)
  const cdFlat = 0.03 + cd90 * s * s
  let cl: number
  let cd: number
  if (abs < stall) {
    cl = a * alpha
    cd = 0.015 + 0.09 * cl * cl
  } else {
    const w = Math.min(1, (abs - stall) / 0.2)
    const sm = w * w * (3 - 2 * w)
    const clLin = a * Math.sign(alpha) * stall
    const cdLin = 0.015 + 0.09 * clLin * clLin
    cl = clLin * (1 - sm) + clFlat * sm
    cd = cdLin * (1 - sm) + cdFlat * sm
  }
  // sustentación ⟂ al movimiento (girada +90°), resistencia opuesta a él
  out.x = v * (-un * cl - ux * cd)
  out.n = v * (ux * cl - un * cd)
}

const _tmpM4 = new Matrix4()
const _tmpV = new Vector3()
const _v3 = new Vector3()
const _v4 = new Vector3()
