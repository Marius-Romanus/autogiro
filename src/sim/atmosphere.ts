import { Vector3 } from 'three'

/** Densidad ISA (kg/m³) a altitud geométrica h (m) con desviación de temperatura dT (°C). */
export function isaDensity(h: number, dT = 0): number {
  const T0 = 288.15 + dT
  const L = 0.0065
  const T = T0 - L * Math.max(-500, Math.min(h, 11000))
  const p = 101325 * Math.pow(1 - (L * h) / 288.15, 5.2559)
  return p / (287.05 * T)
}

/** Ruido 1D suave (Markov de primer orden) para turbulencia. */
class Markov {
  v = 0
  step(dt: number, tau: number, sigma: number): number {
    const a = Math.exp(-dt / Math.max(tau, 1e-3))
    const g = sigma * Math.sqrt(1 - a * a)
    // gaussiana aproximada
    const r = (Math.random() + Math.random() + Math.random() + Math.random() - 2) * 1.7320508
    this.v = a * this.v + g * r
    return this.v
  }
}

export interface WindSettings {
  /** dirección DESDE la que sopla, grados verdaderos */
  fromDeg: number
  /** velocidad a 10 m sobre el suelo, m/s */
  speed: number
  /** 0..1 */
  turbulence: number
}

/**
 * Viento en el marco local del mundo (X este, Y arriba, Z sur) con gradiente
 * cerca del suelo y turbulencia tipo Dryden simplificada.
 */
export class WindModel {
  settings: WindSettings = { fromDeg: 260, speed: 3, turbulence: 0.25 }
  private tx = new Markov()
  private ty = new Markov()
  private tz = new Markov()
  readonly gust = new Vector3()

  /** Calcula el viento (m/s) a la altura sobre el suelo `agl`, con velocidad propia `tas`. */
  sample(dt: number, agl: number, tas: number, out: Vector3): Vector3 {
    const { fromDeg, speed, turbulence } = this.settings
    const z0 = 0.05
    const h = Math.max(agl, 0.5)
    const grad = Math.min(1.35, Math.log(h / z0) / Math.log(10 / z0))
    const ws = speed * Math.max(0, grad)
    // "desde" fromDeg → sopla hacia fromDeg+180
    const to = ((fromDeg + 180) * Math.PI) / 180
    // rumbo: norte = −Z, este = +X
    out.set(Math.sin(to) * ws, 0, -Math.cos(to) * ws)
    // turbulencia
    const sigma = turbulence * (0.6 + 0.18 * speed) * (agl < 300 ? 1 : 0.7)
    const L = Math.max(30, Math.min(agl, 300))
    const tau = L / Math.max(tas, 5)
    this.gust.set(
      this.tx.step(dt, tau, sigma),
      this.ty.step(dt, tau * 0.6, sigma * 0.55),
      this.tz.step(dt, tau, sigma),
    )
    return out.add(this.gust)
  }
}
