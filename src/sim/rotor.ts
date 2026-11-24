// Modelo de rotor de autogiro: rotor bipala basculante (teetering) en autorrotación.
//
// - Integración por elementos de pala (BEMT) promediada en azimut: empuje, fuerza
//   en el plano, par aerodinámico (autorrotación) y momentos de batimiento.
// - El plano de puntas (TPP) es libre (cabeza basculante): su normal se mueve por
//   precesión giroscópica bajo los momentos aerodinámicos (dn/dt = M / (I·Ω)).
//   Así aparecen solos el "blowback" (disco hacia atrás con la velocidad), el
//   retraso del disco respecto a la palanca y el batimiento excesivo con bajas RPM.
// - La palanca inclina el plano de cabeza (hub plane). La diferencia de inclinación
//   entre cabeza y TPP equivale a paso cíclico relativo al TPP:
//   θ(ψ) = θ0 − a1·sinψ + b1·cosψ
// - Flujo inducido: Glauert en avance, fórmula empírica en descenso axial
//   (estado de molinete / estela turbulenta), con dinámica de primer orden y efecto suelo
//   (que se desvanece con la velocidad).
//
// Convenciones: ejes del TPP x = adelante, y = normal (arriba), z = derecha.
// Rotación antihoraria vista desde arriba (pala que avanza a la derecha).
// ψ = 0 con la pala apuntando atrás.

import { Vector3 } from 'three'

const DEG = Math.PI / 180

export interface RotorParams {
  radius: number
  chord: number
  blades: number
  pitch: number // paso fijo de pala (rad)
  precone: number // conicidad fija del buje (rad)
  inertia: number // momento polar de inercia del rotor (kg·m²)
  rootCutout: number // m
  liftSlope: number // 1/rad
  teeterLimit: number // tope de balancín (rad)
  cd0: number // resistencia de perfil mínima
  cd2: number // crecimiento cuadrático con el ángulo de ataque (1/rad²)
  /**
   * Resistencia de perfil con la velocidad total de la sección, incluida la radial (flujo en
   * guiñada), y su fuerza a lo largo de la pala. A μ < 0.4 apenas cuenta; a μ ≈ 1 (rotor
   * frenado del Carter) la potencia de perfil crece con 1 + 4,65 μ² en vez de 1 + 3 μ². Solo
   * la llevan las fichas que la piden (sin ella, los resultados de siempre).
   */
  yawedDrag?: boolean
}

export const DEFAULT_ROTOR: RotorParams = {
  radius: 4.2,
  chord: 0.2,
  blades: 2,
  pitch: 4.4 * DEG,
  precone: 1.2 * DEG,
  inertia: 165,
  rootCutout: 0.42,
  liftSlope: 5.75,
  teeterLimit: 10.5 * DEG,
  cd0: 0.0095,
  cd2: 0.26,
}

const N_PSI = 16
const N_R = 9
const SIN_PSI = new Float64Array(N_PSI)
const COS_PSI = new Float64Array(N_PSI)
for (let k = 0; k < N_PSI; k++) {
  const psi = ((k + 0.5) / N_PSI) * Math.PI * 2
  SIN_PSI[k] = Math.sin(psi)
  COS_PSI[k] = Math.cos(psi)
}

/** Perfil tipo NACA 8H12 (reflejado, Cm≈0) con modelo post-pérdida de placa plana. */
function airfoil(alpha: number, out: { cl: number; cd: number }, a: number, cd0: number, cd2: number): void {
  // normaliza a [-π, π]
  if (alpha > Math.PI) alpha -= 2 * Math.PI
  else if (alpha < -Math.PI) alpha += 2 * Math.PI
  const abs = Math.abs(alpha)
  const stall = 13.5 * DEG
  const s = Math.sin(alpha)
  const clFlat = 1.05 * Math.sin(2 * alpha)
  const cdFlat = 0.03 + 1.85 * s * s
  if (abs < stall) {
    out.cl = a * alpha
    out.cd = cd0 + cd2 * alpha * alpha
    return
  }
  const w = Math.min(1, (abs - stall) / (8 * DEG))
  const sm = w * w * (3 - 2 * w)
  const clLin = a * Math.sign(alpha) * stall * (1 - 0.25 * w)
  const cdLin = cd0 + cd2 * stall * stall + 0.15 * w
  out.cl = clLin * (1 - sm) + clFlat * sm
  out.cd = cdLin * (1 - sm) + cdFlat * sm
}

export interface RotorInputs {
  rho: number
  /** velocidad del aire respecto al buje (mundo) = viento − v_buje */
  airVel: Vector3
  /** normal del plano de cabeza (mundo) */
  hubNormal: Vector3
  /** eje adelante del plano de cabeza (mundo) */
  hubForward: Vector3
  /** altura del buje sobre el suelo (m), Infinity si no hay suelo cerca */
  heightAGL: number
  /** par externo en el eje (prerrotador − freno), N·m */
  shaftTorque: number
}

const _x = new Vector3()
const _z = new Vector3()
const _m = new Vector3()
const _tmp = new Vector3()
const _wt = new Vector3()
const _af = { cl: 0, cd: 0 }

export class Rotor {
  p: RotorParams
  /** velocidad angular del rotor (rad/s) */
  omega = 0
  /** normal del plano de puntas (mundo) */
  readonly normal = new Vector3(0, 1, 0)
  /** dn/dt del paso anterior (mundo) */
  readonly normalRate = new Vector3()
  /** velocidad inducida media (m/s, positiva hacia abajo a través del disco) */
  vi = 0

  // --- salidas del último paso ---
  thrust = 0
  /** fuerza total del rotor sobre el buje (mundo) */
  readonly force = new Vector3()
  /** momento sobre el fuselaje por golpes en los topes de balancín (mundo) */
  readonly stopMoment = new Vector3()
  aeroTorque = 0
  /** inclinación relativa TPP/cabeza: a1 atrás, b1 derecha (rad) */
  a1 = 0
  b1 = 0
  /** ratio de avance μ */
  mu = 0
  /** ratio de flujo a través del disco (positivo hacia arriba) */
  inflowRatio = 0
  /** ángulo de ataque del disco (rad, positivo = disco hacia atrás contra el viento) */
  discAoA = 0
  /** intensidad del golpe en topes (0..1+) en este paso */
  teeterHit = 0
  /** 0..1 fracción de pala en pérdida (avisos/sonido) */
  stallFraction = 0
  /**
   * Paso colectivo (rad) que se suma al paso fijo de la pala. 0 en los autogiros de paso fijo;
   * el Carter lo mueve solo (`compound.ts`): plano para prerrotar, de vuelo según μ y alto para
   * el salto.
   */
  collective = 0

  constructor(params: RotorParams = DEFAULT_ROTOR) {
    this.p = params
  }

  get rpm(): number {
    return (this.omega * 60) / (2 * Math.PI)
  }

  set rpm(v: number) {
    this.omega = (v * 2 * Math.PI) / 60
  }

  /** Coloca el disco alineado con la cabeza (p. ej. al reiniciar). */
  alignTo(hubNormal: Vector3): void {
    this.normal.copy(hubNormal).normalize()
    this.normalRate.set(0, 0, 0)
  }

  step(dt: number, inp: RotorInputs): void {
    const { radius: R, chord: c, blades: Nb, precone, inertia, rootCutout, liftSlope, cd0, cd2 } = this.p
    const theta0 = this.p.pitch + this.collective
    const yawed = this.p.yawedDrag === true
    const n = this.normal
    const rho = inp.rho

    // Ejes del TPP
    _x.copy(inp.hubForward).addScaledVector(n, -inp.hubForward.dot(n)).normalize()
    _z.crossVectors(_x, n).normalize()

    // Inclinación relativa del TPP respecto al plano de cabeza (en ejes de cabeza)
    const hubN = inp.hubNormal
    _tmp.crossVectors(inp.hubForward, hubN) // derecha de la cabeza
    const nxHub = n.dot(inp.hubForward)
    const nzHub = n.dot(_tmp)
    this.a1 = -Math.asin(Math.max(-1, Math.min(1, nxHub)))
    this.b1 = Math.asin(Math.max(-1, Math.min(1, nzHub)))
    const a1 = this.a1
    const b1 = this.b1

    // Velocidad del aire en ejes del TPP
    const Wx = inp.airVel.dot(_x)
    const Wy = inp.airVel.dot(n)
    const Wz = inp.airVel.dot(_z)
    const Vt = Math.hypot(Wx, Wz)
    const omega = Math.max(this.omega, 0)
    const tipSpeed = Math.max(omega * R, 1e-3)
    this.mu = Vt / tipSpeed
    this.inflowRatio = (Wy - this.vi) / tipSpeed
    this.discAoA = Math.atan2(Wy, Math.max(Vt, 1e-3))

    // Velocidad angular de basculación del disco (amortiguamiento aerodinámico)
    _wt.crossVectors(n, this.normalRate)
    const wtx = _wt.dot(_x)
    const wtz = _wt.dot(_z)

    const dr = (R - rootCutout) / N_R
    const tipLossR = 0.97 * R
    let T = 0
    let Fx = 0
    let Fz = 0
    let Q = 0
    let Mx = 0
    let Mz = 0
    let stalled = 0
    const vi = this.vi
    for (let k = 0; k < N_PSI; k++) {
      const sp = SIN_PSI[k]
      const cp = COS_PSI[k]
      const ut0 = -(Wx * sp + Wz * cp)
      const ur = -Wx * cp + Wz * sp
      const theta = theta0 - a1 * sp + b1 * cp
      const up0 = Wy - vi - ur * precone
      const tiltRate = wtz * cp + wtx * sp
      let fnSum = 0
      let ftSum = 0
      let fnR = 0
      let ftR = 0
      let frSum = 0
      for (let j = 0; j < N_R; j++) {
        const r = rootCutout + (j + 0.5) * dr
        const UT = omega * r + ut0
        const UP = up0 + r * tiltRate
        const U2 = UT * UT + UP * UP
        if (U2 < 1e-6) continue
        const U = Math.sqrt(U2)
        const alpha = theta + Math.atan2(UP, UT)
        airfoil(alpha, _af, liftSlope, cd0, cd2)
        if (Math.abs(alpha) > 12 * DEG && UT > 0) stalled++
        const qd = 0.5 * rho * U2 * c * dr
        // pérdidas de punta (Prandtl simplificado): sin sustentación en el 3% exterior
        const L = r > tipLossR ? 0 : qd * _af.cl
        let D = qd * _af.cd
        if (yawed) {
          // principio de independencia del flujo en guiñada: la resistencia de presión va con la
          // velocidad en el plano de la sección; el rozamiento (cd0), con la total, también la radial
          const k3 = Math.sqrt(1 + (ur * ur) / U2)
          D += qd * cd0 * (k3 - 1)
          frSum += (qd * cd0 * k3 * ur) / U
        }
        // fuerzas en (t: dirección de avance de la pala, n: normal)
        const Ft = (L * UP - D * UT) / U
        const Fn = (L * UT + D * UP) / U
        fnSum += Fn
        ftSum += Ft
        fnR += Fn * r
        ftR += Ft * r
      }
      T += fnSum
      Fx += ftSum * sp
      Fz += ftSum * cp
      if (yawed) {
        // fuerza radial (hacia fuera de la pala: −cosψ adelante, +sinψ a la derecha)
        Fx -= frSum * cp
        Fz += frSum * sp
      }
      Q += ftR
      Mx += -sp * fnR
      Mz += -cp * fnR
    }
    const scale = Nb / N_PSI
    T *= scale
    Fx *= scale
    Fz *= scale
    Q *= scale
    Mx *= scale
    Mz *= scale
    this.stallFraction = stalled / (N_PSI * N_R)
    this.thrust = T
    this.aeroTorque = Q

    // Fuerza sobre el buje (mundo). La fuerza en el plano sobre las palas en la
    // dirección de giro es Ft; sobre el buje se transmite igual.
    this.force.copy(n).multiplyScalar(T).addScaledVector(_x, Fx).addScaledVector(_z, Fz)

    // --- Dinámica del rotor (RPM) ---
    const friction = 4 + 0.09 * omega
    let dOmega = (Q + inp.shaftTorque - (omega > 0.05 ? friction : 0)) / inertia
    this.omega = Math.max(0, this.omega + dOmega * dt)
    if (this.omega < 0.02 && Q + inp.shaftTorque <= friction) this.omega = Math.max(0, this.omega)

    // --- Flujo inducido (dinámico) ---
    const A = Math.PI * R * R
    const absT = Math.abs(T)
    const vh = Math.sqrt(absT / (2 * rho * A))
    let viTarget = 0
    if (vh > 1e-3) {
      const Vc = -Wy // velocidad de ascenso a lo largo de la normal
      // Glauert (avance)
      let v = Math.max(this.vi * Math.sign(T || 1), 0.1)
      for (let it = 0; it < 6; it++) {
        const vn = v * 0.5 + 0.5 * (vh * vh) / Math.max(Math.hypot(Vt, Vc + v), 0.3 * vh)
        v = vn
      }
      const vGlauert = v
      // Axial
      const x = Vc / vh
      let vAxial: number
      if (x >= 0) vAxial = -Vc / 2 + Math.sqrt((Vc * Vc) / 4 + vh * vh)
      else if (x <= -2) vAxial = -Vc / 2 - Math.sqrt((Vc * Vc) / 4 - vh * vh)
      else {
        const k = 1.15 - 1.125 * x - 1.372 * x * x - 1.718 * x * x * x - 0.655 * x * x * x * x
        vAxial = k * vh
      }
      const tw = Math.min(1, Math.max(0, (Vt / vh - 0.6) / 1.2))
      const sw = tw * tw * (3 - 2 * tw)
      viTarget = vAxial * (1 - sw) + vGlauert * sw
      // Efecto suelo (Cheeseman y Bennett): en estacionario reduce el flujo inducido en
      // 1 − (R/4h)²; con velocidad la estela se va hacia atrás antes de llegar al suelo y el
      // efecto se desvanece con 1 / (1 + (V/vi)²). A las velocidades de carrera y de recogida
      // apenas queda (la RAE no encontró efecto suelo en la velocidad mínima del C.30, R&M 1859).
      const h = inp.heightAGL
      if (h < 3 * R) {
        const fade = 1 + Math.pow(Vt / Math.max(Math.abs(viTarget), 0.05), 2)
        const ge = 1 - Math.pow(R / (4 * Math.max(h, R * 0.3)), 2) / fade
        viTarget *= Math.max(0.45, ge)
      }
      viTarget *= Math.sign(T)
    }
    const tauInflow = 0.08
    this.vi += (viTarget - this.vi) * Math.min(1, dt / tauInflow)

    // --- Dinámica del disco libre (precesión) ---
    _m.copy(_x).multiplyScalar(Mx).addScaledVector(_z, Mz)
    const H = inertia * Math.max(this.omega, 1e-3)
    const omegaLow = 9 // rad/s (~85 rpm): por debajo, el disco cae sobre la cabeza
    this.normalRate.copy(_m).multiplyScalar(1 / Math.max(H, inertia * 6))
    if (this.omega < omegaLow) {
      const w = 1 - this.omega / omegaLow
      _tmp.copy(hubN).sub(n).multiplyScalar(18 * w)
      this.normalRate.multiplyScalar(1 - w).add(_tmp)
    }
    // mantener ṅ perpendicular a n
    this.normalRate.addScaledVector(n, -this.normalRate.dot(n))
    n.addScaledVector(this.normalRate, dt).normalize()

    // --- Topes de balancín ---
    this.teeterHit = 0
    this.stopMoment.set(0, 0, 0)
    const cosAng = Math.max(-1, Math.min(1, n.dot(hubN)))
    const ang = Math.acos(cosAng)
    const lim = this.p.teeterLimit
    if (ang > lim) {
      // volver al cono límite
      _tmp.copy(n)
      const axis = _wt.crossVectors(hubN, n)
      const len = axis.length()
      if (len > 1e-9) {
        axis.multiplyScalar(1 / len)
        n.copy(hubN).applyAxisAngle(axis, lim).normalize()
      }
      // par transmitido al fuselaje = −I·Ω·Δn/dt (limitado)
      _tmp.sub(n).multiplyScalar(H / dt) // = −(par sobre rotor)
      const maxM = 9000
      const mag = _tmp.length()
      if (mag > maxM) _tmp.multiplyScalar(maxM / mag)
      this.stopMoment.copy(_tmp)
      this.teeterHit = (ang - lim) / (2 * DEG) + mag / maxM
      // quita la componente de ṅ que empuja contra el tope
      const outward = _wt.copy(n).sub(hubN)
      const ol = outward.length()
      if (ol > 1e-9) {
        outward.multiplyScalar(1 / ol)
        const d = this.normalRate.dot(outward)
        if (d > 0) this.normalRate.addScaledVector(outward, -d)
      }
    }
  }
}
