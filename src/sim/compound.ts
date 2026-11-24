// Autogiro compuesto de rotor frenado (Carter PAV): ala con alerones, timón de profundidad,
// hélice de paso variable con regulador y rotor de paso colectivo automático en un mástil que
// bascula solo para llevar las vueltas que pide la velocidad.
//
// Todo es opcional en la ficha (`wing`, `elevator`, `cspProp`, `slowedRotor`); `autogyro.ts`
// solo llama aquí si el aparato lo lleva, así que los autogiros de siempre no cambian.
//
// Cómo vuela (Carter y Lewis, ERF 2015; patente US 7 448 571):
// · A poca velocidad es un autogiro de disco muy poco cargado: el rotor a ~300 rpm lleva el peso
//   y la palanca inclina la cabeza (cíclico) y mueve alerones y profundidad.
// · Con velocidad el ala toma la carga y un regulador automático inclina el mástil adelante para
//   frenar el rotor (≈ 300 rpm hasta ~120 km/h, ≈ 110 rpm en crucero rápido, μ ≈ 0,8-1); el
//   colectivo baja con μ hasta algo negativo para que las palas no batan.
// · Salto: en tierra el prerrotador lleva el rotor, con el paso plano, a ~370 rpm con la potencia
//   del motor; al soltarlo con mucho gas el colectivo sube de golpe y el aparato salta con la
//   energía del rotor mientras la hélice lo acelera; según caen las vueltas hacia 300 el colectivo
//   vuelve al de vuelo y sigue como autogiro (el rotor nunca va motorizado en vuelo).

import { Vector3, type Quaternion } from 'three'
import type { Airframe } from './airframes.ts'
import type { Autogyro, Controls } from './autogyro.ts'

const DEG = Math.PI / 180

/** Ala (dos semialas partidas en franjas): sustentación en el centro aerodinámico de cada franja. */
export interface WingSpec {
  /** superficie (m²), envergadura (m) y estrechamiento (cuerda de punta / de raíz) */
  area: number
  span: number
  taper: number
  /** centro aerodinámico (25 % de la cuerda) en la raíz, coordenadas del modelo; línea del 25 % recta */
  ac: Vector3
  /** calado respecto al fuselaje (°) y diedro (°) */
  incidence: number
  dihedral?: number
  /** CL con ángulo de ataque nulo (curvatura), CL máximo y mínimo; pendiente (1/rad; si falta, la del alargamiento) */
  cl0: number
  clMax: number
  clMin: number
  liftSlope?: number
  /** resistencia de perfil, factor de Oswald y momento de cabeceo en el centro aerodinámico */
  cd0: number
  oswald: number
  cm0: number
  /** alerones: grados de ángulo de ataque efectivo por unidad de palanca lateral, desde esta fracción de la semienvergadura */
  aileron: number
  aileronFrom: number
  /** franjas por semiala (4) */
  strips?: number
  /** fracción del flujo inducido del rotor que llega al ala (y a la cola) mientras la estela pasa por encima */
  rotorWash?: number
}

/** Hélice de paso variable con regulador (pala equivalente a 0,75 R). */
export interface CspPropSpec {
  /** vueltas que mantiene el regulador con el gas cerrado y abierto (palanca única) */
  govRpm: [number, number]
  /** suma de las cuerdas de las palas a 0,75 R (m) de la pala equivalente; perfil */
  chordBlades: number
  liftSlope: number
  cd0: number
  /** paso a 0,75 R (°): tope de paso fino, tope de paso grueso y paso plano (prerrotación) */
  betaFine: number
  betaMax: number
  betaFlat: number
}

/** Rotor frenado: vueltas según la velocidad (mástil basculante) y colectivo automático. */
export interface SlowedRotorSpec {
  /** vueltas objetivo frente a la velocidad indicada: [km/h, rpm] */
  rpm: [number, number][]
  /**
   * constante de tiempo (s) del filtro de la velocidad con la que se leen las vueltas objetivo: el
   * regulador sigue la velocidad de crucero, no los vaivenes del fugoide (si no, al frenarse el
   * aparato el rotor pediría más vueltas, cargaría más y lo frenaría más)
   */
  iasTau: number
  mast: {
    /** límites del mástil (°, + hacia atrás), velocidad máxima (°/s) */
    min: number
    max: number
    rate: number
    /** posición a poca velocidad, donde no se regulan las vueltas: [km/h, °] */
    ff: [number, number][]
    /**
     * Regulador en cascada. Lazo exterior: PI + amortiguación sobre el error de vueltas que pide un
     * ángulo de ataque del disco (°/rpm, °/(rpm·s), °/(rpm/s)), entre `aoaMin` y `aoaMax` (°):
     * con el ángulo por debajo de cero el aire entra por arriba y el rotor se volvería a embalar
     * empujando hacia abajo (rama de molinete). Lazo interior: el mástil sigue ese ángulo
     * (`kAoa`, 1/s).
     */
    kp: number
    ki: number
    kd: number
    aoaMin: number
    aoaMax: number
    kAoa: number
    /** por debajo de esta velocidad (km/h) no corrige las vueltas (el rotor lleva todo el peso) */
    minIas: number
    /** posición al prerrotar y en el salto (°) */
    ground: number
    /** posición rodando por tierra (°): atrás, para que el aire embale el rotor en la carrera */
    roll: number
    /**
     * Inclinación de la cabeza respecto al mástil que se añade en tierra y en el salto (°, + atrás):
     * con el mástil adelante el buje queda sobre el CG y el disco a nivel, de modo que el empuje
     * del salto pasa por el CG. En vuelo se va a cero a la vez que el mástil vuelve a su sitio.
     */
    groundHead: number
  }
  collective: {
    /** paso plano para prerrotar (°) */
    flat: number
    /** colectivo de vuelo frente a μ: [μ, °] */
    flight: [number, number][]
    /** salto: colectivo (°), vueltas y gas mínimos al soltar el prerrotador, vueltas a las que empieza a bajar y a las que acaba */
    jump: number
    jumpMinRpm: number
    jumpMinThrottle: number
    jumpFullRpm: number
    jumpEndRpm: number
    /** velocidad (km/h) a la que el salto pasa a vuelo aunque queden vueltas */
    jumpEndKmh: number
    /** velocidad del colectivo (°/s) normal y en el salto */
    rate: number
    jumpRate: number
    /**
     * Colchón automático cerca del suelo: por debajo de `agl` m bajando a más de `sink` m/s sube
     * el colectivo `gain` °/(m/s), hasta `max` °, con la energía del rotor.
     */
    cushion?: { agl: number; sink: number; gain: number; max: number }
  }
  /** μ a partir del que avisa (rotor demasiado lento para la velocidad) y al que se pierde (inestabilidad de la pala que retrocede) */
  muWarn: number
  muLimit: number
}

export type JumpState = 'flight' | 'pre' | 'jump'

const _r = new Vector3()
const _u = new Vector3()
const _F = new Vector3()
const _t = new Vector3()
const _sec = { cl: 0, cd: 0 }

function smooth01(x: number): number {
  const t = Math.max(0, Math.min(1, x))
  return t * t * (3 - 2 * t)
}

/** Interpolación lineal en una tabla [x, y] ordenada por x (constante fuera). */
export function interp(tab: [number, number][], x: number): number {
  if (x <= tab[0][0]) return tab[0][1]
  for (let i = 1; i < tab.length; i++) {
    if (x <= tab[i][0]) {
      const [x0, y0] = tab[i - 1]
      const [x1, y1] = tab[i]
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)
    }
  }
  return tab[tab.length - 1][1]
}

/** Coeficientes de una sección de ala a cualquier ángulo: lineal, entrada en pérdida suave y placa plana. */
function wingSection(alpha: number, w: WingSpec, a: number, kInd: number, out: { cl: number; cd: number }): void {
  if (alpha > Math.PI) alpha -= 2 * Math.PI
  else if (alpha < -Math.PI) alpha += 2 * Math.PI
  // la recta llega a 1,15·CLmáx donde la curva redondeada alcanza el máximo con pendiente nula
  const aP = (1.15 * w.clMax - w.cl0) / a
  const aN = (1.15 * w.clMin - w.cl0) / a
  const s = Math.sin(alpha)
  const clFlat = 1.05 * Math.sin(2 * alpha)
  const cdFlat = 0.03 + 1.25 * s * s
  if (alpha >= aN && alpha <= aP) {
    const lin = w.cl0 + a * alpha
    const lim = lin >= 0 ? w.clMax : -w.clMin
    const x = Math.abs(lin)
    let cl = x
    // redondeo desde el 85 % del máximo: k + (lim − k)(e − e²/4), e = (x − k)/(lim − k)
    if (x > 0.85 * lim) {
      const e = (x - 0.85 * lim) / (0.15 * lim)
      cl = 0.85 * lim + 0.15 * lim * (e - 0.25 * e * e)
    }
    cl *= Math.sign(lin)
    out.cl = cl
    out.cd = w.cd0 + kInd * cl * cl
    return
  }
  const pos = alpha > aP
  const edge = pos ? aP : aN
  const wgt = Math.min(1, Math.abs(alpha - edge) / 0.22)
  const sm = wgt * wgt * (3 - 2 * wgt)
  const clStall = (pos ? w.clMax : w.clMin) * (1 - 0.3 * wgt)
  const cdStall = w.cd0 + kInd * clStall * clStall + 0.12 * wgt
  out.cl = clStall * (1 - sm) + clFlat * sm
  out.cd = cdStall * (1 - sm) + cdFlat * sm
}

/** Sección de la pala equivalente de la hélice. */
function propSection(alpha: number, a: number, cd0: number, out: { cl: number; cd: number }): void {
  if (alpha > Math.PI) alpha -= 2 * Math.PI
  else if (alpha < -Math.PI) alpha += 2 * Math.PI
  const stall = 0.24
  const abs = Math.abs(alpha)
  if (abs < stall) {
    out.cl = a * alpha
    out.cd = cd0 + 0.04 * out.cl * out.cl
    return
  }
  const s = Math.sin(alpha)
  const w = Math.min(1, (abs - stall) / 0.25)
  const sm = w * w * (3 - 2 * w)
  const clLin = a * Math.sign(alpha) * stall * (1 - 0.3 * w)
  const cdLin = cd0 + 0.04 * clLin * clLin + 0.1 * w
  out.cl = clLin * (1 - sm) + 1.05 * Math.sin(2 * alpha) * sm
  out.cd = cdLin * (1 - sm) + (0.03 + 1.8 * s * s) * sm
}

export class Compound {
  readonly af: Airframe
  // --- rotor ---
  /** inclinación del mástil (rad, + hacia atrás) y adónde va en el paso siguiente */
  mast = 0
  mastCmd = 0
  private mastI = 0
  /** inclinación extra de la cabeza respecto al mástil (rad, + atrás): la de tierra y salto */
  headTrim = 0
  /** colectivo (rad) */
  collective = 0
  state: JumpState = 'flight'
  /** vueltas objetivo de la ley de vueltas (rpm) */
  rpmTarget = 300
  /** velocidad indicada filtrada (km/h) */
  iasF = 0
  private rpmPrev = -1
  private rpmDot = 0
  // --- profundidad y estela sobre la cola ---
  /** incidencia que se suma al estabilizador (profundidad − estela del ala), rad */
  tailIncidence = 0
  /** velocidad hacia arriba del estabilizador respecto al aire por la estela del rotor (m/s) */
  tailWash = 0
  // --- hélice ---
  /** paso de la hélice a 0,75 R (°) */
  beta = 0
  private betaI = 0
  private flatProp = false
  propVi = 0
  /** par del prerrotador sobre el rotor en este paso (N·m): carga el motor */
  prerotTorque = 0
  // --- salidas del ala (para bancos y vista) ---
  wingLift = 0
  wingDrag = 0
  wingCL = 0
  aileronDeg = 0
  elevatorDeg = 0

  // geometría de las franjas del ala
  private readonly stripY: number[] = []
  private readonly stripArea: number[] = []
  private readonly stripChord: number[] = []
  private readonly stripAil: boolean[] = []
  private readonly wingSlope: number = 0
  private readonly kInd: number = 0
  private readonly ar: number = 0

  constructor(af: Airframe) {
    this.af = af
    const w = af.wing
    if (w) {
      const n = w.strips ?? 4
      const half = w.span / 2
      const cRoot = (2 * w.area) / (w.span * (1 + w.taper))
      for (let i = 0; i < n; i++) {
        const y0 = (i / n) * half
        const y1 = ((i + 1) / n) * half
        const c0 = cRoot * (1 - (1 - w.taper) * (y0 / half))
        const c1 = cRoot * (1 - (1 - w.taper) * (y1 / half))
        const area = ((c0 + c1) / 2) * (y1 - y0)
        // centroide de la franja trapezoidal
        const yc = y0 + ((y1 - y0) * (c0 + 2 * c1)) / (3 * (c0 + c1))
        this.stripY.push(yc)
        this.stripArea.push(area)
        this.stripChord.push((c0 + c1) / 2)
        this.stripAil.push(yc / half >= w.aileronFrom)
      }
      this.ar = (w.span * w.span) / w.area
      this.wingSlope = w.liftSlope ?? (2 * Math.PI * this.ar) / (2 + Math.sqrt(this.ar * this.ar + 4))
      this.kInd = 1 / (Math.PI * this.ar * w.oswald)
    }
    if (af.cspProp) this.beta = af.cspProp.betaFine
  }

  /** Vueltas de referencia para los avisos: las de la ley de vueltas, sobre las 352 de los autogiros actuales. */
  get warnScale(): number {
    return this.rpmTarget / 352
  }

  /** Rotor perdido: casi parado (el disco cae sobre la cabeza) o μ más allá del límite de estabilidad de la pala. */
  rotorLost(ac: Autogyro): boolean {
    const sr = this.af.slowedRotor
    if (!sr) return false
    return ac.rotor.rpm < 85 || ac.rotor.mu > sr.muLimit
  }

  /** μ por encima del aviso (rotor demasiado lento para la velocidad). */
  muHigh(ac: Autogyro): boolean {
    const sr = this.af.slowedRotor
    return sr !== undefined && ac.rotor.mu > sr.muWarn
  }

  /** En tierra parado: mástil en su posición de tierra, colectivo de vuelo, hélice al paso fino. */
  reset(ac: Autogyro): void {
    const sr = this.af.slowedRotor
    this.state = 'flight'
    this.mastI = 0
    this.rpmPrev = -1
    this.rpmDot = 0
    if (sr) {
      this.mast = this.mastCmd = sr.mast.roll * DEG
      this.headTrim = 0
      this.collective = interp(sr.collective.flight, 0) * DEG
      this.rpmTarget = interp(sr.rpm, 0)
      this.iasF = 0
    }
    ac.rotor.collective = this.collective
    const cp = this.af.cspProp
    if (cp) this.beta = this.betaI = cp.betaFine
    this.propVi = 0
    this.flatProp = false
  }

  /** En vuelo a `speed` m/s: rotor a sus vueltas, mástil y colectivo en su sitio. */
  placeInAir(ac: Autogyro, speed: number): void {
    this.reset(ac)
    const sr = this.af.slowedRotor
    if (sr) {
      const kmh = speed * 3.6
      this.rpmTarget = interp(sr.rpm, kmh)
      this.iasF = kmh
      ac.rotor.rpm = this.rpmTarget
      this.mast = this.mastCmd = Math.max(sr.mast.min, Math.min(sr.mast.max, interp(sr.mast.ff, kmh))) * DEG
      this.headTrim = 0
      const mu = speed / Math.max(1, ac.rotor.omega * ac.rotor.p.radius)
      this.collective = interp(sr.collective.flight, mu) * DEG
      ac.rotor.collective = this.collective
    }
    const cp = this.af.cspProp
    if (cp) {
      this.beta = this.betaI = Math.min(cp.betaMax, cp.betaFine + 0.3 * speed)
      this.propVi = 2
    }
  }

  /**
   * Automatismos antes de cada paso: ley de vueltas (mástil), colectivo y salto, profundidad.
   * `pitchCmd`: palanca de cabeceo con el compensador (−1..1).
   */
  update(dt: number, ac: Autogyro, ctl: Controls, pitchCmd: number): void {
    const af = this.af
    if (af.elevator !== undefined) this.elevatorDeg = -af.elevator * pitchCmd
    const sr = af.slowedRotor
    if (!sr) {
      this.tailIncidence = this.elevatorDeg * DEG
      return
    }
    const ias = ac.ias * 3.6
    const rpm = ac.rotor.rpm
    this.iasF += (ias - this.iasF) * Math.min(1, dt / sr.iasTau)
    this.rpmTarget = interp(sr.rpm, this.iasF)
    if (this.rpmPrev >= 0) this.rpmDot += ((rpm - this.rpmPrev) / dt - this.rpmDot) * Math.min(1, dt / 0.5)
    this.rpmPrev = rpm
    const onG = ac.onGround
    const c = sr.collective

    // ---- colectivo y salto ----
    if (onG && ctl.prerotator) this.state = 'pre'
    else if (this.state === 'pre') {
      // se acaba de soltar el prerrotador: salto si hay vueltas y gas; si no, despegue rodando
      this.state = onG && rpm >= c.jumpMinRpm && ctl.throttle >= c.jumpMinThrottle ? 'jump' : 'flight'
    }
    // el salto se acaba al caer las vueltas o al coger velocidad
    if (this.state === 'jump' && (rpm < c.jumpEndRpm || (!onG && ias > c.jumpEndKmh))) this.state = 'flight'
    // (con el rotor casi parado μ no significa nada)
    const mu = rpm > 60 ? ac.rotor.mu : 0
    const flight = interp(c.flight, mu)
    let target: number
    let rate = c.rate
    if (this.state === 'pre') target = c.flat
    else if (this.state === 'jump') {
      target = flight + (c.jump - flight) * smooth01((rpm - c.jumpEndRpm) / (c.jumpFullRpm - c.jumpEndRpm))
      rate = c.jumpRate
    } else {
      target = flight
      const cu = c.cushion
      if (cu && !onG && ac.agl < cu.agl && ac.vs < -cu.sink) {
        target += Math.min(cu.max, cu.gain * (-ac.vs - cu.sink)) * smooth01(rpm / this.rpmTarget - 0.5)
        rate = c.jumpRate
      }
    }
    const dc = target * DEG - this.collective
    const maxStep = rate * DEG * dt
    this.collective += Math.max(-maxStep, Math.min(maxStep, dc))
    ac.rotor.collective = this.collective

    // ---- mástil: ley de vueltas ----
    const m = sr.mast
    const aoa = ac.rotor.discAoA / DEG
    let rateDeg: number // velocidad pedida al mástil (°/s)
    const mastDeg = this.mast / DEG
    if (this.state !== 'flight') {
      // prerrotando y en el salto: mástil adelante (buje sobre el CG)
      this.aoaCmd = aoa
      this.mastI = 0
      rateDeg = (m.ground - mastDeg) * 2
    } else if (onG) {
      // rodando: hacia atrás para que el aire embale el rotor, como un autogiro
      this.aoaCmd = aoa
      this.mastI = 0
      rateDeg = (m.roll - mastDeg) * 2
    } else {
      const err = this.rpmTarget - rpm
      const active = smooth01((ias - m.minIas) / 20)
      // a poca velocidad, a su posición; al entrar en la ley de vueltas, el integrador arranca
      // desde el ángulo del disco que haya (sin saltos)
      if (active < 1e-3) this.mastI = aoa
      const raw = m.kp * err - m.kd * this.rpmDot
      const iNew = this.mastI + m.ki * err * dt
      const cmdA = raw + iNew
      // integral con antisaturación: no sigue empujando contra un tope del ángulo ni del mástil
      const sat = cmdA < m.aoaMin || cmdA > m.aoaMax || (mastDeg <= m.min + 0.1 && err < 0) || (mastDeg >= m.max - 0.1 && err > 0)
      if (!sat || Math.abs(iNew) < Math.abs(this.mastI)) this.mastI = iNew
      this.aoaCmd = Math.max(m.aoaMin, Math.min(m.aoaMax, raw + this.mastI))
      const ctlRate = m.kAoa * (this.aoaCmd - aoa)
      const ffRate = (interp(m.ff, ias) - mastDeg) * 1
      rateDeg = active * ctlRate + (1 - active) * ffRate
    }
    // (en el salto se va quitando con la velocidad: el disco ya se inclina atrás solo al avanzar)
    const trimT = this.state === 'pre' ? m.groundHead * DEG : this.state === 'jump' ? m.groundHead * DEG * (1 - smooth01(ias / 50)) : 0
    this.headTrim += (trimT - this.headTrim) * Math.min(1, dt * (this.state !== 'flight' ? 2 : 1))
    rateDeg = Math.max(-m.rate, Math.min(m.rate, rateDeg))
    this.mast = Math.max(m.min * DEG, Math.min(m.max * DEG, this.mast + rateDeg * DEG * dt))
    this.mastCmd = this.mast + rateDeg * DEG * dt
  }

  /** ángulo de ataque del disco que pide la ley de vueltas (°) */
  aoaCmd = 0

  /**
   * Hélice de paso variable y motor: devuelve el empuje (N) y el par absorbido por la hélice
   * (N·m) en `out`, y deja en el aparato las vueltas, la potencia y el flujo inducido.
   */
  propeller(dt: number, ac: Autogyro, thr: number, vax: number, rho: number, prerot: boolean, out: { T: number; Q: number }): void {
    const af = this.af
    const cp = af.cspProp!
    const eng = af.engine
    const R = af.propRadius
    const A = Math.PI * R * R
    const rpm = ac.engineRpm
    const omega = Math.max(2, (rpm * 2 * Math.PI) / 60)
    // ---- regulador ----
    const gov = cp.govRpm[0] + (cp.govRpm[1] - cp.govRpm[0]) * smooth01(thr / 0.85)
    // al prerrotar la hélice baja a paso plano (casi todo el motor va al rotor) y el regulador solo
    // la deja subir hasta el paso fino; al soltar sigue desde ahí sin saltos
    const flat = prerot && ac.onGround
    if (flat !== this.flatProp) {
      this.flatProp = flat
      this.betaI = this.beta
    }
    const bMin = flat ? cp.betaFlat : cp.betaFine
    const bMax = flat ? cp.betaFine : cp.betaMax
    const err = rpm - gov
    this.betaI = Math.max(bMin, Math.min(bMax, this.betaI + 0.03 * err * dt))
    const b = Math.max(bMin, Math.min(bMax, this.betaI + 0.01 * err))
    // el mecanismo de paso no es instantáneo
    this.beta += Math.max(-15 * dt, Math.min(15 * dt, b - this.beta))
    // ---- pala equivalente a 0,75 R con el flujo inducido de la teoría de cantidad de movimiento ----
    const r75 = 0.75 * R
    const vt = omega * r75
    const va = Math.max(0, vax) + this.propVi
    const phi = Math.atan2(va, vt)
    propSection(this.beta * DEG - phi, cp.liftSlope, cp.cd0, _sec)
    const w2 = vt * vt + va * va
    const k = 0.5 * rho * w2 * cp.chordBlades * 0.8 * R
    const cphi = Math.cos(phi)
    const sphi = Math.sin(phi)
    const T = k * (_sec.cl * cphi - _sec.cd * sphi)
    const Q = k * r75 * (_sec.cl * sphi + _sec.cd * cphi)
    const V = Math.max(0, vax)
    const viT = T > 0 ? -V / 2 + Math.sqrt((V * V) / 4 + T / (2 * rho * A)) : 0
    this.propVi += (viT - this.propVi) * Math.min(1, dt / 0.06)
    // ---- motor (toma directa) ----
    const dR = rpm - eng.rpmPeak
    let Tmax = (eng.torquePeak - (dR < 0 ? eng.dropBelow : eng.dropAbove) * dR * dR) * (rho / 1.225)
    if (rpm > eng.rpmLimit) Tmax *= Math.max(0, 1 - (rpm - eng.rpmLimit) / 150)
    const Tfric = eng.friction[0] + eng.friction[1] * rpm
    let Qe: number
    if (ac.engineOn) {
      const th = eng.idle + (1 - eng.idle) * thr
      Qe = th * Math.max(0, Tmax) - (1 - th) * Tfric
      if (rpm < eng.starterRpm) Qe += 0.25 * eng.torquePeak * (1 - rpm / eng.starterRpm)
    } else Qe = -1.8 * Tfric - 0.05 * eng.torquePeak
    // el prerrotador (correa, 90 %) toma del cigüeñal la potencia que da al rotor
    const Qpre = this.prerotTorque > 0 ? (this.prerotTorque * ac.rotor.omega) / (omega * 0.9) : 0
    let w = omega + ((Qe * 0.97 - Q - Qpre) / eng.inertia) * dt
    if (w < 0) w = 0
    ac.engineRpm = (w * 60) / (2 * Math.PI)
    ac.enginePower = Math.max(0, Qe) * omega
    ac.propThrust = T
    ac.propInduced = Math.max(0, this.propVi)
    out.T = T
    out.Q = Q
  }

  /**
   * Velocidad hacia abajo de la estela del rotor en un punto del cuerpo (respecto al CG): la
   * estela baja a ~1,5 vi y se va hacia atrás con la velocidad; fuera del disco, nada.
   */
  private wash(ac: Autogyro, x: number, y: number, z: number): number {
    const k = this.af.wing?.rotorWash ?? 0
    const vi = ac.rotor.vi
    if (k <= 0 || vi < 0.05) return 0
    const hub = ac.hubBody
    const drop = Math.max(0, hub.y - y)
    const vDown = 1.5 * vi
    const shift = (drop * ac.tas) / Math.max(vDown, 0.3)
    const dx = x - (hub.x - shift)
    const d = Math.hypot(dx, z - hub.z)
    const R = ac.rotor.p.radius
    const inside = 1 - smooth01((d - 0.75 * R) / (0.35 * R))
    return k * vDown * inside
  }

  /**
   * Fuerzas del ala (franjas de cada semiala, en su centro aerodinámico): suma la fuerza al total
   * del mundo `f` y el momento al del cuerpo `m`. Deja la estela del ala y la profundidad para la cola.
   */
  wing(ac: Autogyro, vRelBody: Vector3, rho: number, roll: number, q: Quaternion, f: Vector3, m: Vector3): void {
    const w = this.af.wing!
    const cg = ac.cg
    const gam = (w.dihedral ?? 0) * DEG
    const cg_ = Math.cos(gam)
    const sg = Math.sin(gam)
    const ail = Math.max(-1, Math.min(1, roll)) * w.aileron
    this.aileronDeg = ail
    let lift = 0
    let drag = 0
    let qS = 0
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < this.stripY.length; i++) {
        const yc = this.stripY[i]
        // (con diedro, la franja sube con la envergadura)
        _r.set(w.ac.x - cg.x, w.ac.y + sg * yc - cg.y, side * yc - cg.z)
        _u.copy(ac.omega).cross(_r).add(vRelBody)
        _u.y += this.wash(ac, _r.x, _r.y, _r.z)
        // normal de la franja: (0, cosΓ, −lado·sinΓ)
        const nz = -side * sg
        const ux = _u.x
        const un = _u.y * cg_ + _u.z * nz
        // alerón: palanca a la derecha → el de la derecha sube (menos ángulo), el de la izquierda baja
        const da = this.stripAil[i] ? -side * ail * DEG : 0
        const alpha = Math.atan2(-un, ux) + w.incidence * DEG + da
        wingSection(alpha, w, this.wingSlope, this.kInd, _sec)
        const v = Math.sqrt(ux * ux + un * un)
        const k = 0.5 * rho * this.stripArea[i]
        const fx = k * v * (-un * _sec.cl - ux * _sec.cd)
        const fn = k * v * (ux * _sec.cl - un * _sec.cd)
        _F.set(fx, fn * cg_, fn * nz)
        m.add(_t.crossVectors(_r, _F))
        // momento de cabeceo del perfil (con flujo normal y sin pérdida)
        if (ux > 0) m.z += k * ux * ux * this.stripChord[i] * w.cm0 * (1 - smooth01((Math.abs(alpha) - 0.25) / 0.2))
        f.add(_t.copy(_F).applyQuaternion(q))
        lift += _F.y
        drag -= _F.x
        qS += k * ux * Math.abs(ux)
      }
    }
    this.wingLift = lift
    this.wingDrag = drag
    this.wingCL = qS > 1 ? lift / qS : 0
    // cola: profundidad, estela del ala (2·CL/πA) y estela del rotor
    const st = this.af.stab
    const eps = this.wingCL * 2 / (Math.PI * this.ar) * smooth01(vRelBody.x / 8)
    this.tailIncidence = this.elevatorDeg * DEG - eps
    this.tailWash = this.wash(ac, st.x - cg.x, st.y - cg.y, 0)
  }
}
