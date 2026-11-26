// Estela de los obstáculos cercanos al suelo (edificios, hangares, masas de árboles) que quedan a
// barlovento: menos viento y más turbulencia detrás y por debajo de unas dos alturas del obstáculo.
//
// Modelo: la fórmula de Perera (1981, J. Wind Eng. Ind. Aerodyn. 8) para la estela de una barrera 2D,
// la que usan el modelo de abrigo de WAsP y la corrección de datos de viento de Taylor y Salmon (1993,
// J. Appl. Meteor. 32):
//     Δu/U_h = 9,75·(1 − P)·(h/x)·η·exp(−0,67·η^1,5),   η = (z/h)·(K·x/h)^(−1/(n+2)),
//     K = 2κ²/ln(h/z0),  n = 0,14,  P = porosidad (0 edificio, ~0,5 arbolado)
// con U_h el viento sin obstáculo a su altura. Un obstáculo de ancho finito se trata como una fila de
// tramos estrechos cuya estela se abre de lado con σy = 0,15·x: sumados dan la barrera 2D y, sueltos,
// el factor de ancho finito 1/(1 + 0,2·x/ancho) de Taylor y Salmon. Muy cerca (x < ~5 h), donde la
// fórmula ya no vale, el déficit se satura como detrás de una barrera densa (queda un 15–25 % del
// viento, medidas de cortavientos de Nägeli 1946 y Heisler y DeWalle 1988).
//
// Los obstáculos llegan como una rejilla de alturas (edificios y copas). Solo cuentan las caras de
// sotavento (donde la altura baja en el sentido del viento): el interior de un edificio ancho o de un
// bosque no suma estelas, las suma su borde. Y de varios obstáculos en fila (hileras de hangares) solo
// cuenta el último antes del punto: el aire pasa por encima del conjunto.

import { KAPPA } from './boundaryLayer.ts'

export interface ObstacleGrid {
  n: number
  /** lado de la celda (m) */
  cell: number
  /** esquina suroeste (m, marco local este/norte) */
  e0: number
  n0: number
  /** altura del obstáculo de cada celda (m); 0 = nada */
  h: Float32Array
  /** porosidad 0..1 (0 = macizo) */
  por: Float32Array
}

export interface WakeSample {
  /** déficit relativo del viento medio (0..0,85) */
  deficit: number
  /** turbulencia añadida, como fracción del viento local sin obstáculo */
  sigma: number
  /** altura media (m) de los obstáculos que hacen la estela (escala de sus remolinos) */
  scale: number
}

/** alcance (m) y alturas del obstáculo hasta donde se cuenta su estela */
const RANGE = 300
const MAX_H = 30
const CAP = 0.85

// erf (Abramowitz y Stegun 7.1.26)
function erf(x: number): number {
  const s = x < 0 ? -1 : 1
  const a = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * a)
  return s * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a))
}

/** Déficit Δu/U_h de Perera a x metros de una barrera 2D de altura h, a la altura z. */
export function pereraDeficit(x: number, z: number, h: number, z0: number, porosity: number): number {
  const K = (2 * KAPPA * KAPPA) / Math.log(h / z0)
  const eta = (z / h) * Math.pow((K * x) / h, -1 / 2.14)
  return 9.75 * (1 - porosity) * (h / x) * eta * Math.exp(-0.67 * Math.pow(eta, 1.5))
}

/**
 * Estela de los obstáculos de la rejilla en (e, n) a la altura z sobre el suelo. (we, wn): hacia
 * dónde sopla el viento (unitario); z0: rugosidad del terreno alrededor.
 */
export function obstacleWake(g: ObstacleGrid, e: number, nn: number, z: number, we: number, wn: number, z0: number, out: WakeSample): WakeSample {
  out.deficit = 0
  out.sigma = 0
  out.scale = 0
  const { n, cell, h, por } = g
  const fi = (e - g.e0) / cell
  const fj = (nn - g.n0) / cell
  const r = Math.ceil(RANGE / cell)
  const i0 = Math.max(0, Math.floor(fi) - r)
  const i1 = Math.min(n - 1, Math.floor(fi) + r)
  const j0 = Math.max(0, Math.floor(fj) - r)
  const j1 = Math.min(n - 1, Math.floor(fj) + r)
  if (i0 > i1 || j0 > j1) return out
  // caras de sotavento: la del este si el viento va al este, etc.
  const si = we > 0 ? 1 : -1
  const sj = wn > 0 ? 1 : -1
  const wE = Math.abs(we)
  const wN = Math.abs(wn)
  let raw = 0
  let hsum = 0
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const hh = h[j * n + i]
      if (hh < 2) continue
      const ce = g.e0 + (i + 0.5) * cell
      const cn = g.n0 + (j + 0.5) * cell
      // distancia a barlovento del centro de la celda
      const xc = (e - ce) * we + (nn - cn) * wn
      if (xc < -cell || xc > Math.min(RANGE, MAX_H * hh)) continue
      const hEff = Math.min(hh, 60)
      const zz0 = Math.max(0.01, Math.min(z0, 0.1 * hEff))
      const p = por[j * n + i]
      for (let f = 0; f < 2; f++) {
        // f = 0: cara este/oeste; f = 1: cara norte/sur
        const wf = cell * (f === 0 ? wE : wN)
        if (wf < 0.15 * cell) continue
        const ni = f === 0 ? i + si : i
        const nj = f === 0 ? j : j + sj
        const hn = ni < 0 || nj < 0 || ni >= n || nj >= n ? 0 : h[nj * n + ni]
        const step = hh - hn
        if (step < 1.5) continue
        const fe = ce + (f === 0 ? (si * cell) / 2 : 0)
        const fn = cn + (f === 1 ? (sj * cell) / 2 : 0)
        const x = (e - fe) * we + (nn - fn) * wn
        if (x <= 0) continue
        // si otro obstáculo parecido la corta antes de 6 alturas (naves en fila, interior de un bosque), su
        // estela no llega: el flujo pasa por encima del conjunto y la estela la hace el último de la fila
        let cut = false
        for (let d = cell, reach = Math.min(x - cell, 6 * hEff); d < reach; d += cell) {
          const qi = Math.floor((fe + we * d - g.e0) / cell)
          const qj = Math.floor((fn + wn * d - g.n0) / cell)
          if (qi >= 0 && qj >= 0 && qi < n && qj < n && h[qj * n + qi] >= 0.6 * hh) {
            cut = true
            break
          }
        }
        if (cut) continue
        const xx = Math.max(x, 0.5 * hEff)
        const y = (e - fe) * -wn + (nn - fn) * we
        const sy = 0.15 * xx + 0.3 * wf
        if (Math.abs(y) > 3 * sy + wf) continue
        const lat = 0.5 * (erf((y + wf / 2) / (sy * Math.SQRT2)) - erf((y - wf / 2) / (sy * Math.SQRT2)))
        if (lat < 1e-3) continue
        // por debajo de 0,4 h el déficit ya no cambia con la altura
        const ze = Math.max(z, 0.4 * hEff)
        const d = pereraDeficit(xx, ze, hEff, zz0, p)
        // respecto al viento local a la altura z (perfil logarítmico)
        const rel = (d * Math.log(hEff / zz0)) / Math.log(Math.max(ze, 2 * zz0) / zz0)
        const c = rel * lat * (step / hh)
        raw += c
        hsum += c * hEff
      }
    }
  }
  // dentro del obstáculo (entre los árboles, pegado a una pared)
  const ci = Math.floor(fi)
  const cj = Math.floor(fj)
  if (ci >= 0 && cj >= 0 && ci < n && cj < n) {
    const hh = h[cj * n + ci]
    if (hh > 2 && z < hh) {
      const c = 1.2 * Math.sqrt(1 - por[cj * n + ci]) * Math.min(1, (hh - z) / (0.3 * hh))
      raw += c
      hsum += c * hh
    }
  }
  if (raw <= 0) return out
  out.deficit = CAP * Math.tanh(raw / CAP)
  out.sigma = 0.35 * out.deficit
  out.scale = hsum / raw
  return out
}
