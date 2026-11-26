// Térmicas: columnas de aire ascendente de la capa convectiva de día, con descendencia alrededor.
//
// Modelo de Allen (2006, «Updraft Model for Development of Autonomous Soaring Uninhabited Air
// Vehicles», AIAA 2006-1510, NASA Dryden), hecho con las medidas de Lenschow y Stephens (1980):
//   velocidad media de la ascendencia   w̄ = w*·(z/zi)^(1/3)·(1 − 1,1·z/zi)
//   radio                               r2 = 0,102·(z/zi)^(1/3)·(1 − 0,25·z/zi)·zi   (≥ 10 m)
//   núcleo                              w_pico = 3·w̄·(r2³ − r2²·r1)/(r2³ − r1³),  r1/r2 = 0,0011·r2 + 0,14
//   perfil radial en campana con anillo de descendencia entre r1 y 2·r2 en la mitad alta de la capa,
//   y una descendencia general del entorno que compensa la masa que sube.
//   densidad: N = 0,6·área/(zi·r2).
// w* = (g/T · H/(ρ·cp) · zi)^(1/3) es la escala convectiva de Deardorff: sale del calor que da el
// suelo (sol, nubes, tipo de suelo) y de la altura de la capa (la base de los cúmulos).
//
// El campo es determinista: las térmicas viven en una rejilla fija de celdas de 500 m que deriva con
// el viento de la capa de mezcla; dónde está cada una, cuánto dura (10–25 min, con nacimiento y
// muerte suaves) y su fuerza salen de un hash de la celda, la época y la semilla. Con las mismas
// condiciones y el mismo reloj (los de la sala en multijugador), dos pilotos ven las mismas térmicas
// en el mismo sitio. El suelo que tiene debajo cada térmica la alimenta o la apaga (agua: ninguna).

import type { BoundaryLayer } from './boundaryLayer.ts'

/** lado de la celda (m) */
export const THERMAL_CELL = 500

export interface ThermalField {
  zi: number
  wstar: number
  /** deriva (m/s, este y norte) */
  vE: number
  vN: number
  seed: number
  /** 0..1: cuánta convección organizada hay (con mucho viento y poco sol las térmicas se deshacen) */
  gate: number
  /** probabilidad de que una celda tenga térmica */
  fill: number
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Hash entero → [0, 1). */
function hash(a: number, b: number, c: number, d: number): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b) ^ Math.imul(c | 0, 0xc2b2ae35) ^ Math.imul(d | 0, 0x27d4eb2f)
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 12
  h = Math.imul(h, 0x297a2d39)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

/**
 * Campo de térmicas del día, o null si no hay convección (noche, cielo cubierto, sol bajo).
 * La deriva solo depende del viento del menú (1,35 × el de 10 m, girado 7° a la derecha en el
 * hemisferio norte: el de la capa de mezcla), para que sea idéntica en todos los ordenadores.
 */
export function thermalField(bl: BoundaryLayer, seed: number): ThermalField | null {
  if (bl.wstar < 0.25 || bl.zi < 150) return null
  const gate = smooth(0.25, 0.8, bl.wstar) * smooth(1.5, 8, -bl.zi * bl.invL)
  if (gate <= 0) return null
  const to = ((bl.fromDeg + 180 + 7 * bl.veer) * Math.PI) / 180
  const v = 1.35 * bl.speed10
  const c = THERMAL_CELL
  return { zi: bl.zi, wstar: bl.wstar, vE: Math.sin(to) * v, vN: Math.cos(to) * v, seed, gate, fill: Math.min(1, (0.6 * c * c) / (0.0708 * bl.zi * bl.zi)) }
}

// constantes de forma de Allen (2006), tabla 1, según r1/r2
const SHAPE: Array<[number, number, number, number, number]> = [
  [0.14, 1.5352, 2.5826, -0.0113, 0.0008],
  [0.25, 1.5265, 3.6054, -0.0176, 0.0005],
  [0.36, 1.4866, 4.8354, -0.032, 0.0001],
  [0.47, 1.2042, 7.7904, 0.0848, 0.0001],
  [0.58, 0.8816, 13.972, 0.3404, 0.0001],
  [0.69, 0.7067, 23.994, 0.5689, 0.0002],
  [0.8, 0.6189, 42.797, 0.7157, 0.0001],
]

/** Perfil de una térmica de Allen a la altura z: velocidad media, radio y pico (sin variaciones). */
export function allenProfile(zi: number, wstar: number, z: number): { wMean: number; r2: number; r1: number; wPeak: number } {
  const zr = z / zi
  if (zr <= 0 || zr >= 0.9) return { wMean: 0, r2: 10, r1: 2, wPeak: 0 }
  const c = Math.cbrt(zr)
  const wMean = wstar * c * (1 - 1.1 * zr)
  const r2 = Math.max(10, 0.102 * c * (1 - 0.25 * zr) * zi)
  const ratio = r2 < 600 ? 0.0011 * r2 + 0.14 : 0.8
  const r1 = ratio * r2
  const wPeak = (3 * wMean * (r2 ** 3 - r2 * r2 * r1)) / (r2 ** 3 - r1 ** 3)
  return { wMean, r2, r1, wPeak }
}

export interface ThermalSample {
  /** velocidad vertical del aire (m/s) */
  w: number
  /** turbulencia añadida dentro de la térmica (m/s) */
  sigma: number
  /** la térmica más cercana: distancia a su eje (m), su radio (m) y su pico (m/s); −1 si no hay */
  dist: number
  radius: number
  peak: number
  /** hacia dónde queda su eje (m, este y norte) */
  de: number
  dn: number
}

/**
 * Velocidad vertical de las térmicas en el punto (x este, y norte: metros en un marco fijo a la
 * Tierra) a la altura z sobre el suelo, en el instante t (s). `heat(dx, dy)`: cuánto calienta el
 * suelo a (dx, dy) del punto, relativo al campo abierto (0 = agua).
 */
export function sampleThermals(tf: ThermalField, x: number, y: number, z: number, t: number, heat: ((dx: number, dy: number) => number) | null, out: ThermalSample): ThermalSample {
  out.w = 0
  out.sigma = 0
  out.dist = -1
  out.radius = 0
  out.peak = 0
  out.de = 0
  out.dn = 0
  const zr = z / tf.zi
  if (zr <= 0 || zr >= 0.9) return out
  const p = allenProfile(tf.zi, tf.wstar, z)
  const c = THERMAL_CELL
  // marco que deriva con el viento
  const mx = x - tf.vE * t
  const my = y - tf.vN * t
  const ci = Math.floor(mx / c)
  const cj = Math.floor(my / c)
  const low = smooth(0, 15, z)
  let sum = 0
  let core = 0
  let best = Infinity
  for (let j = cj - 1; j <= cj + 1; j++) {
    for (let i = ci - 1; i <= ci + 1; i++) {
      const h0 = hash(i, j, tf.seed, 1)
      const period = 600 + 900 * h0
      const ph = t / period + hash(i, j, tf.seed, 2)
      const k = Math.floor(ph)
      const frac = ph - k
      const exist = Math.min(1, Math.max(0, (tf.fill - hash(i, j, tf.seed, 3 + 7 * k)) / 0.1 + 0.5))
      if (exist <= 0) continue
      const env = smooth(0, 0.2, frac) * (1 - smooth(0.8, 1, frac))
      if (env <= 0) continue
      const tx = (i + 0.12 + 0.76 * hash(i, j, tf.seed, 4 + 7 * k)) * c
      const ty = (j + 0.12 + 0.76 * hash(i, j, tf.seed, 5 + 7 * k)) * c
      const s = 0.6 + 0.8 * hash(i, j, tf.seed, 6 + 7 * k)
      const r2 = p.r2 * (0.8 + 0.45 * hash(i, j, tf.seed, 7 + 7 * k))
      const dx = tx - mx
      const dy = ty - my
      const r = Math.hypot(dx, dy)
      if (r > 2 * r2) {
        if (r < best) {
          best = r
          out.radius = r2
          out.peak = 0
          out.de = dx
          out.dn = dy
        }
        continue
      }
      // el suelo que hay bajo la térmica (centro y cuatro puntos a un radio)
      let q = 1
      if (heat) q = 0.4 * heat(dx, dy) + 0.15 * (heat(dx + r2, dy) + heat(dx - r2, dy) + heat(dx, dy + r2) + heat(dx, dy - r2))
      const ratio = r2 < 600 ? 0.0011 * r2 + 0.14 : 0.8
      const r1 = ratio * r2
      const wPeak = ((3 * p.wMean * (r2 ** 3 - r2 * r2 * r1)) / (r2 ** 3 - r1 ** 3)) * s * env * exist * q * tf.gate
      let sh = SHAPE[0]
      for (const row of SHAPE) if (Math.abs(row[0] - ratio) < Math.abs(sh[0] - ratio)) sh = row
      const rr = r / r2
      const bell = 1 / (1 + Math.pow(Math.abs(sh[1] * rr + sh[3]), sh[2]))
      const wl = r > r1 ? (Math.PI / 6) * Math.sin(Math.PI * rr) : 0
      const wd = zr > 0.5 ? 2.5 * wl * (zr - 0.5) : 0
      const edge = 1 - smooth(1.6, 2, rr)
      sum += wPeak * (bell + sh[4] * rr + wd) * edge
      core = Math.max(core, bell * env * exist)
      if (r < best) {
        best = r
        out.radius = r2
        out.peak = wPeak
        out.de = dx
        out.dn = dy
      }
    }
  }
  // descendencia del entorno: compensa la masa que sube por las térmicas
  const frac = Math.min(0.5, (Math.PI * p.r2 * p.r2 * tf.fill * 0.8) / (c * c))
  const env = ((-p.wMean * frac) / (1 - frac)) * tf.gate
  out.w = (sum + env * (1 - core)) * low
  out.sigma = 0.25 * Math.abs(sum) * low
  if (best < Infinity) out.dist = best
  return out
}
