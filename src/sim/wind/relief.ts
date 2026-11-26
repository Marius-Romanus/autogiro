// Viento sobre el relieve: teoría lineal de flujo sobre colinas resuelta en Fourier sobre una rejilla
// de alturas alrededor del aparato.
//
// Modelo (Jackson y Hunt 1975, Q. J. R. Meteorol. Soc. 101; en 3D Mason y Sykes 1979; revisión de
// Hunt, Leibovich y Richards 1988; es la base de MS3DJH y del modelo de orografía de WAsP):
//  - Fuera de la capa interna el flujo sobre el relieve h(x, y) es potencial. Para cada número de onda
//    (k, l), con κ = |(k, l)|, las líneas de corriente se desplazan δ̂ = ĥ·e^(−κz): la velocidad
//    vertical es w = U·∇δ (en el suelo, w = U·pendiente) y la horizontal cambia u' = (k kᵀ/κ)·ĥ·e^(−κz)·U
//    (aceleración sobre las cumbres, frenado al pie y en los valles).
//  - La presión la fija el flujo a la altura de la escala de la colina (hm ≈ 1/κ) y, como cerca del
//    suelo el aire va más despacio, se acelera más: el aumento relativo crece por
//    [ln(hm/z0)/ln(z/z0)]² hasta la capa interna ℓ (ℓ·ln(ℓ/z0) = 2κ²·L), que es el resultado de
//    Jackson y Hunt: ΔS ≈ 2·H/L en una loma 2D y 1,6·H/L en un cerro (guía de Taylor y Lee 1984).
//  - Ni δ ni el tensor de u' dependen de la dirección del viento: se calculan una vez por rejilla (a
//    varias alturas) y sirven para cualquier viento, también con el giro del viento en altura.
//
// La teoría lineal vale mientras el flujo no se desprende (pendientes hasta ~0,3). A sotavento de
// pendientes mayores hay desprendimiento (Wood 1995, Boundary-Layer Meteorol. 76: pendiente crítica
// ≈ 0,3): ahí se aplica una estela con déficit de velocidad, descendencia y turbulencia de rotor que
// se alarga unas diez alturas de la cresta (Kaimal y Finnigan 1994, cap. 5; Arya et al. 1987).

import { KAPPA } from './boundaryLayer.ts'

/** FFT compleja en el sitio (radix 2). `inv`: transformada inversa sin normalizar. */
function fft(re: Float64Array, im: Float64Array, n: number, inv: boolean, off = 0, stride = 1): void {
  // permutación de bits
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const a = off + i * stride
      const b = off + j * stride
      let t = re[a]
      re[a] = re[b]
      re[b] = t
      t = im[a]
      im[a] = im[b]
      im[b] = t
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inv ? 2 : -2) * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = off + (i + k) * stride
        const b = off + (i + k + len / 2) * stride
        const xr = re[b] * cr - im[b] * ci
        const xi = re[b] * ci + im[b] * cr
        re[b] = re[a] - xr
        im[b] = im[a] - xi
        re[a] += xr
        im[a] += xi
        const t = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = t
      }
    }
  }
}

function fft2(re: Float64Array, im: Float64Array, n: number, inv: boolean): void {
  for (let j = 0; j < n; j++) fft(re, im, n, inv, j * n, 1)
  for (let i = 0; i < n; i++) fft(re, im, n, inv, i, n)
}

/** campos por nivel: ∂δ/∂E, ∂δ/∂N, Mee, Men, Mnn */
const NF = 5

export interface ReliefGrid {
  n: number
  dx: number
  /** esquina suroeste (m, este y norte en el marco local) */
  e0: number
  n0: number
  /** alturas sobre el suelo de los niveles (m) */
  levels: Float32Array
  /** campos [nivel][campo] de n×n (fila = norte, columna = este) */
  fields: Float32Array[]
  /** alturas del terreno de la rejilla (m), sin ventana */
  ground: Float32Array
}

export interface ReliefOptions {
  /** alturas sobre el suelo de los niveles */
  levels: number[]
  /** rugosidad con que se calcula la amplificación de la capa interna */
  z0?: number
  /** ancho (fracción de la rejilla) de la ventana de coseno de los bordes */
  taper?: number
  /** relieve de fondo (ya contado en otra rejilla más gruesa) que se resta antes de transformar */
  background?: Float32Array
}

/** Altura de la capa interna para una escala L (ℓ·ln(ℓ/z0) = 2κ²·L). */
export function innerLayer(L: number, z0: number): number {
  let l = Math.max(2 * z0, 0.05 * L)
  for (let k = 0; k < 6; k++) l = (2 * KAPPA * KAPPA * L) / Math.max(1, Math.log(Math.max(l, 2.8 * z0) / z0))
  return Math.max(l, 3 * z0)
}

/**
 * Calcula los campos de una rejilla de alturas (n potencia de 2). Es un generador para repartir el
 * cálculo entre fotogramas: cada `next()` hace una transformada (≈ 1–2 ms con n = 128).
 */
export function* buildRelief(heights: Float32Array, n: number, dx: number, e0: number, n0: number, opt: ReliefOptions): Generator<void, ReliefGrid> {
  const z0 = opt.z0 ?? 0.05
  const taper = opt.taper ?? 0.2
  const N2 = n * n
  const hr = new Float64Array(N2)
  const hi = new Float64Array(N2)
  // ventana de Tukey sobre la altura menos su media (o menos el relieve de fondo)
  let mean = 0
  if (!opt.background) {
    for (let i = 0; i < N2; i++) mean += heights[i]
    mean /= N2
  }
  const win = new Float64Array(n)
  const m = Math.max(1, Math.floor(taper * n))
  for (let i = 0; i < n; i++) {
    const d = Math.min(i, n - 1 - i)
    win[i] = d >= m ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * d) / m)
  }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) hr[j * n + i] = (heights[j * n + i] - (opt.background ? opt.background[j * n + i] : mean)) * win[i] * win[j]
  fft2(hr, hi, n, false)
  yield
  // números de onda
  const kk = new Float64Array(n)
  for (let i = 0; i < n; i++) kk[i] = ((2 * Math.PI) / (n * dx)) * (i < n / 2 ? i : i - n)
  const levels = Float32Array.from(opt.levels)
  const fields: Float32Array[] = []
  const re = new Float64Array(N2)
  const im = new Float64Array(N2)
  const fac = new Float64Array(N2)
  const amp = new Float64Array(N2)
  const norm = 1 / N2
  // capa interna y altura media de cada número de onda (no dependen del nivel)
  const inner = new Float64Array(N2)
  const mid = new Float64Array(N2)
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const kap = Math.hypot(kk[i], kk[j])
      if (kap === 0) continue
      const l = innerLayer(1 / kap, z0)
      inner[j * n + i] = l
      mid[j * n + i] = Math.max(1 / kap, 1.5 * l)
    }
  }
  yield
  for (let li = 0; li < levels.length; li++) {
    const z = levels[li]
    // atenuación con la altura y amplificación de Jackson-Hunt de cada número de onda
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const kap = Math.hypot(kk[i], kk[j])
        const q = j * n + i
        if (kap === 0) {
          fac[q] = 0
          amp[q] = 0
          continue
        }
        const l = inner[q]
        const hm = mid[q]
        const lh = Math.log(hm / z0)
        const zz = Math.max(z, l)
        const a = zz < hm ? (lh / Math.log(zz / z0)) ** 2 : lh / Math.log(zz / z0)
        fac[q] = Math.exp(-kap * z) * norm
        amp[q] = a
      }
    }
    yield
    for (let f = 0; f < NF; f++) {
      for (let j = 0; j < n; j++) {
        const l = kk[j]
        for (let i = 0; i < n; i++) {
          const k = kk[i]
          const q = j * n + i
          const e = fac[q]
          if (e === 0) {
            re[q] = 0
            im[q] = 0
            continue
          }
          if (f < 2) {
            // i·k·ĥ (la frecuencia de Nyquist no tiene derivada real)
            const c = (f === 0 ? (i === n / 2 ? 0 : k) : j === n / 2 ? 0 : l) * e
            re[q] = -hi[q] * c
            im[q] = hr[q] * c
          } else {
            const kap = Math.hypot(k, l)
            const c = ((f === 2 ? k * k : f === 3 ? k * l : l * l) / kap) * e * amp[q]
            re[q] = hr[q] * c
            im[q] = hi[q] * c
          }
        }
      }
      fft2(re, im, n, true)
      fields.push(Float32Array.from(re))
      yield
    }
  }
  return { n, dx, e0, n0, levels, fields, ground: heights }
}

/** Calcula la rejilla de una vez (pruebas). */
export function buildReliefSync(heights: Float32Array, n: number, dx: number, e0: number, n0: number, opt: ReliefOptions): ReliefGrid {
  const g = buildRelief(heights, n, dx, e0, n0, opt)
  for (;;) {
    const r = g.next()
    if (r.done) return r.value
  }
}

export interface ReliefSample {
  /** ∇δ (pendiente de las líneas de corriente) */
  de: number
  dn: number
  /** tensor del aumento relativo de la velocidad horizontal */
  mee: number
  men: number
  mnn: number
}

/** ¿Está (e, n) dentro de la zona útil de la rejilla (lejos de los bordes con ventana)? */
export function reliefWeight(g: ReliefGrid, e: number, nn: number, taper = 0.2): number {
  const u = (e - g.e0) / (g.dx * (g.n - 1))
  const v = (nn - g.n0) / (g.dx * (g.n - 1))
  const d = Math.min(u, 1 - u, v, 1 - v)
  return d <= 0 ? 0 : Math.min(1, d / Math.max(taper, 1e-3))
}

/** Suma a `out` los campos de la rejilla en (e, n) a la altura z sobre el suelo, con peso `w`. */
export function sampleRelief(g: ReliefGrid, e: number, nn: number, z: number, w: number, out: ReliefSample): void {
  const n = g.n
  const fx = (e - g.e0) / g.dx
  const fy = (nn - g.n0) / g.dx
  if (fx < 0 || fy < 0 || fx > n - 1 || fy > n - 1) return
  const i = Math.min(n - 2, Math.floor(fx))
  const j = Math.min(n - 2, Math.floor(fy))
  const a = fx - i
  const b = fy - j
  const q = j * n + i
  const w00 = (1 - a) * (1 - b)
  const w10 = a * (1 - b)
  const w01 = (1 - a) * b
  const w11 = a * b
  // nivel: interpolación lineal en altura; por encima del último, se apaga
  const lv = g.levels
  const nl = lv.length
  let l0 = 0
  let t = 0
  let top = 1
  if (z <= lv[0]) l0 = 0
  else if (z >= lv[nl - 1]) {
    l0 = nl - 2
    t = 1
    top = Math.max(0, 1 - (z - lv[nl - 1]) / lv[nl - 1])
  } else {
    while (l0 < nl - 2 && z > lv[l0 + 1]) l0++
    t = (z - lv[l0]) / (lv[l0 + 1] - lv[l0])
  }
  const s0 = w * top * (1 - t)
  const s1 = w * top * t
  const at = (f: Float32Array) => f[q] * w00 + f[q + 1] * w10 + f[q + n] * w01 + f[q + n + 1] * w11
  const F = g.fields
  const b0 = l0 * NF
  const b1 = (l0 + 1) * NF
  out.de += at(F[b0]) * s0 + at(F[b1]) * s1
  out.dn += at(F[b0 + 1]) * s0 + at(F[b1 + 1]) * s1
  out.mee += at(F[b0 + 2]) * s0 + at(F[b1 + 2]) * s1
  out.men += at(F[b0 + 3]) * s0 + at(F[b1 + 3]) * s1
  out.mnn += at(F[b0 + 4]) * s0 + at(F[b1 + 4]) * s1
}

/** Altura del terreno de la rejilla en (e, n), o NaN fuera. */
export function groundAt(g: ReliefGrid, e: number, nn: number): number {
  const n = g.n
  const fx = (e - g.e0) / g.dx
  const fy = (nn - g.n0) / g.dx
  if (fx < 0 || fy < 0 || fx > n - 1 || fy > n - 1) return NaN
  const i = Math.min(n - 2, Math.floor(fx))
  const j = Math.min(n - 2, Math.floor(fy))
  const a = fx - i
  const b = fy - j
  const q = j * n + i
  const h = g.ground
  return (h[q] * (1 - a) + h[q + 1] * a) * (1 - b) + (h[q + n] * (1 - a) + h[q + n + 1] * a) * b
}

export interface LeeWake {
  /** déficit relativo del viento medio (0..~0,7) */
  deficit: number
  /** turbulencia añadida, como fracción del viento a la altura de la cresta */
  sigma: number
  /** descendencia media, como fracción del viento a la altura de la cresta (≤ 0) */
  sink: number
  /** altura de la cresta de barlovento sobre el suelo del punto (m) y distancia a ella (m) */
  crest: number
  dist: number
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** distancias a barlovento (m) a las que se mira el relieve */
const LEE_STEPS = Array.from({ length: 26 }, (_, k) => 60 * Math.pow(1.19, k))

/**
 * Estela de sotavento: mira el relieve a barlovento del punto (hasta ~4,7 km). Si hay una cresta
 * por encima y entre ella y el punto la ladera cae con pendiente de desprendimiento (> ~0,3), el
 * punto está en la zona desprendida: menos viento, descendencia y turbulencia de rotor.
 * `ground(e, n)`: altura del terreno (NaN fuera de los datos); (we, wn): hacia dónde sopla (unitario).
 */
export function leeWake(ground: (e: number, n: number) => number, e: number, nn: number, agl: number, we: number, wn: number, out: LeeWake): LeeWake {
  out.deficit = 0
  out.sigma = 0
  out.sink = 0
  out.crest = 0
  out.dist = 0
  const g0 = ground(e, nn)
  if (!(g0 === g0)) return out
  const zp = g0 + agl
  // horizonte a barlovento y mayor caída de la ladera entre la cresta y el punto
  let best = 0
  let bestD = 0
  let bestH = 0
  let prev = g0
  let prevD = 0
  let drop = 0
  let dropAtBest = 0
  for (let k = 0; k < LEE_STEPS.length; k++) {
    const d = LEE_STEPS[k]
    const h = ground(e - we * d, nn - wn * d)
    if (!(h === h)) break
    const slope = (h - prev) / (d - prevD)
    if (slope > drop) drop = slope
    const ang = (h - zp) / d
    // (una cresta apenas más alta y muy lejos no cuenta: la estela se acaba a unas 25 alturas)
    if (ang > best && h - g0 > 8) {
      best = ang
      bestD = d
      bestH = h - g0
      dropAtBest = drop
    }
    prev = h
    prevD = d
  }
  // por encima de la cresta también llega algo de la capa de cortadura: se mira la cresta más alta cercana
  if (bestH <= 0) {
    let top = 0
    let topD = 0
    prev = g0
    prevD = 0
    drop = 0
    for (let k = 0; k < LEE_STEPS.length; k++) {
      const d = LEE_STEPS[k]
      const h = ground(e - we * d, nn - wn * d)
      if (!(h === h)) break
      const slope = (h - prev) / (d - prevD)
      if (slope > drop) drop = slope
      if (h - g0 > top && d < 12 * (h - g0)) {
        top = h - g0
        topD = d
        dropAtBest = drop
      }
      prev = h
      prevD = d
    }
    if (top < 8) return out
    bestH = top
    bestD = topD
  }
  const sep = smooth(0.25, 0.45, dropAtBest) * smooth(8, 25, bestH)
  if (sep <= 0) return out
  const x = bestD / bestH
  // altura del punto respecto a la cresta, en alturas de cresta
  const zeta = (agl - bestH) / bestH
  const thick = 0.25 + 0.04 * x
  const v = zeta <= 0 ? 1 : Math.exp(-((zeta / thick) ** 2))
  const g1 = x < 4 ? 1 : Math.exp(-(x - 4) / 8)
  const g2 = x < 6 ? 1 : Math.exp(-(x - 6) / 10)
  out.deficit = 0.7 * sep * g1 * v
  // la turbulencia es máxima en la capa de cortadura, a la altura de la cresta, y la mitad en el fondo
  out.sigma = 0.35 * sep * g2 * v * (0.5 + 0.5 * Math.exp(-((zeta / 0.5) ** 2)))
  // el aire de fuera baja hacia el punto de readherencia (pendiente ≈ 1:8), sobre todo entre 2 y 10 alturas
  // (pegado al suelo el aire no puede bajar: ahí solo queda el flujo paralelo a la ladera)
  const nearGround = Math.min(1, agl / Math.min(150, Math.max(20, 0.3 * bestH)))
  out.sink = -0.12 * sep * v * smooth(0.5, 2.5, x) * (x < 8 ? 1 : Math.exp(-(x - 8) / 6)) * nearGround
  out.crest = bestH
  out.dist = bestD
  return out
}
