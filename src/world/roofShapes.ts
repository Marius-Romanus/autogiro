// Tejados inclinados deducidos de la planta del edificio (sin datos de cubierta: ni
// OpenStreetMap ni el Catastro dicen cómo es el tejado).
//
// - Planta casi rectangular: tejado limpio sobre el rectángulo mínimo que la contiene,
//   a dos aguas, a cuatro aguas o en bóveda (hangares), con un pequeño alero.
// - Cualquier otra planta (cascos antiguos, manzanas con patio, plantas en L): «esqueleto
//   recto» (cada fachada levanta un faldón con la misma pendiente; es como se construye un
//   tejado a cuatro aguas sobre una planta cualquiera), con un tope de altura: las plantas
//   muy anchas quedan con azotea plana en el centro.
//
// Todo en coordenadas locales (x, z) en metros; las alturas son sobre el alero.
// Funciones puras: se usan en el hilo principal, en el worker de tejados y en las pruebas.

import { ShapeUtils, Vector2 } from 'three'
import { SkeletonBuilder } from 'straight-skeleton'

/** Triángulos [x, z, h] × 3 por triángulo. */
export type Tris = number[]

export interface OrientedBox {
  /** ángulo del eje u (radianes, desde +x hacia +z) */
  angle: number
  /** centro en el marco girado */
  cu: number
  cv: number
  /** semilados a lo largo de u y v */
  hu: number
  hv: number
  area: number
}

/** Rectángulo de área mínima que contiene los puntos (x, z alternados), probando giros de 1°. */
export function orientedBox(xz: ArrayLike<number>): OrientedBox {
  let best: OrientedBox | null = null
  const n = xz.length / 2
  for (let deg = 0; deg < 90; deg++) {
    const a = (deg * Math.PI) / 180
    const c = Math.cos(a)
    const s = Math.sin(a)
    let u0 = Infinity
    let u1 = -Infinity
    let v0 = Infinity
    let v1 = -Infinity
    for (let i = 0; i < n; i++) {
      const x = xz[2 * i]
      const z = xz[2 * i + 1]
      const u = x * c + z * s
      const v = -x * s + z * c
      if (u < u0) u0 = u
      if (u > u1) u1 = u
      if (v < v0) v0 = v
      if (v > v1) v1 = v
    }
    const area = (u1 - u0) * (v1 - v0)
    if (!best || area < best.area) best = { angle: a, cu: (u0 + u1) / 2, cv: (v0 + v1) / 2, hu: (u1 - u0) / 2, hv: (v1 - v0) / 2, area }
  }
  return best!
}

export type RectKind = 'gable' | 'hip' | 'barrel'

export interface RectRoof {
  roof: Tris
  /** hastiales (triángulos de pared en los extremos de un tejado a dos aguas o de una bóveda) */
  ends: Tris
  /** normal hacia fuera de cada triángulo de `ends` (x, z) */
  endNormals: number[]
  rise: number
}

/**
 * Tejado sobre el rectángulo `box` (con alero `overhang` por cada lado).
 * `pitch` = tangente de la pendiente; la subida no pasa de `maxRise`.
 */
export function rectRoof(box: OrientedBox, kind: RectKind, pitch: number, maxRise: number, overhang: number): RectRoof {
  const c = Math.cos(box.angle)
  const s = Math.sin(box.angle)
  const alongU = box.hu >= box.hv
  const L = Math.max(box.hu, box.hv) + overhang
  const W = Math.min(box.hu, box.hv) + overhang
  // (a lo largo, transversal) → (x, z)
  const P = (a: number, t: number): [number, number] => {
    const u = box.cu + (alongU ? a : t)
    const v = box.cv + (alongU ? t : a)
    return [u * c - v * s, u * s + v * c]
  }
  const roof: Tris = []
  const ends: Tris = []
  const endNormals: number[] = []
  const tri = (out: Tris, p: [number, number, number], q: [number, number, number], r: [number, number, number]) => out.push(...p, ...q, ...r)
  const V = (a: number, t: number, h: number): [number, number, number] => {
    const [x, z] = P(a, t)
    return [x, z, h]
  }
  // hacia fuera a lo largo del eje largo (para los hastiales)
  const [ex, ez] = (() => {
    const [x0, z0] = P(0, 0)
    const [x1, z1] = P(1, 0)
    return [x1 - x0, z1 - z0]
  })()

  if (kind === 'barrel') {
    // bóveda de cañón a lo largo del eje largo: arco de flecha = rise
    const rise = Math.min(W * 0.55, maxRise)
    const SEG = 10
    // arco de circunferencia por (−W, 0), (0, rise), (W, 0)
    const R = (W * W + rise * rise) / (2 * rise)
    const yc = rise - R
    const arc: Array<[number, number]> = []
    const th = Math.asin(Math.min(1, W / R))
    for (let k = 0; k <= SEG; k++) {
      const a = -th + (2 * th * k) / SEG
      arc.push([R * Math.sin(a), Math.max(0, yc + R * Math.cos(a))])
    }
    for (let k = 0; k < SEG; k++) {
      const [t0, h0] = arc[k]
      const [t1, h1] = arc[k + 1]
      tri(roof, V(-L, t0, h0), V(L, t0, h0), V(L, t1, h1))
      tri(roof, V(-L, t0, h0), V(L, t1, h1), V(-L, t1, h1))
    }
    // fachadas de los extremos bajo el arco (a ras de pared, sin el alero)
    const wi = W - overhang
    const hAt = (t: number) => Math.max(0, yc + Math.sqrt(Math.max(0, R * R - t * t)))
    for (const e of [-1, 1]) {
      const a = e * (L - overhang)
      for (let k = 0; k < SEG; k++) {
        const t0 = -wi + (2 * wi * k) / SEG
        const t1 = -wi + (2 * wi * (k + 1)) / SEG
        const h0 = hAt(t0)
        const h1 = hAt(t1)
        tri(ends, V(a, t0, 0), V(a, t1, 0), V(a, t1, h1))
        tri(ends, V(a, t0, 0), V(a, t1, h1), V(a, t0, h0))
        endNormals.push(e * ex, e * ez, e * ex, e * ez)
      }
    }
    return { roof, ends, endNormals, rise }
  }

  const rise = Math.min(W * pitch, maxRise)
  const hr = kind === 'gable' ? L : Math.max(L - W, 0)
  // faldones largos
  tri(roof, V(-L, -W, 0), V(L, -W, 0), V(hr, 0, rise))
  tri(roof, V(-L, -W, 0), V(hr, 0, rise), V(-hr, 0, rise))
  tri(roof, V(L, W, 0), V(-L, W, 0), V(-hr, 0, rise))
  tri(roof, V(L, W, 0), V(-hr, 0, rise), V(hr, 0, rise))
  if (kind === 'hip') {
    tri(roof, V(L, -W, 0), V(L, W, 0), V(hr, 0, rise))
    tri(roof, V(-L, W, 0), V(-L, -W, 0), V(-hr, 0, rise))
  } else {
    // hastiales del color de la fachada, a ras de pared (sin el alero)
    const o = overhang
    const r = rise - o * pitch
    for (const e of [-1, 1]) {
      const a = e * (L - o)
      tri(ends, V(a, -W + o, 0), V(a, W - o, 0), V(a, 0, r))
      endNormals.push(e * ex, e * ez)
    }
  }
  return { roof, ends, endNormals, rise }
}

/**
 * Tejado por esqueleto recto sobre una planta cualquiera (exterior + huecos, x/z alternados).
 * Devuelve null si el algoritmo no puede con la planta (entonces se deja plano).
 */
export function skeletonRoof(rings: ArrayLike<number>[], pitch: number, cap: number): Tris | null {
  const clean = rings.map((r) => simplifyRing(r))
  if (clean[0].length < 6) return null
  const outer = clean[0]
  const holes = clean.slice(1).filter((h) => h.length >= 6)
  // exterior antihorario, huecos horarios (sin repetir el primer punto al final)
  const ring = (r: number[], ccw: boolean): Array<[number, number]> => {
    const pts: Array<[number, number]> = []
    for (let i = 0; i < r.length; i += 2) pts.push([r[i], r[i + 1]])
    if (signedArea(r) > 0 !== ccw) pts.reverse()

    return pts
  }
  // centrado (el algoritmo trabaja mejor cerca del origen)
  let cx = 0
  let cz = 0
  for (let i = 0; i < outer.length; i += 2) {
    cx += outer[i]
    cz += outer[i + 1]
  }
  cx /= outer.length / 2
  cz /= outer.length / 2
  const shift = (r: number[]) => r.map((v, i) => (i % 2 === 0 ? v - cx : v - cz))
  const poly = [ring(shift(outer), true), ...holes.map((h) => ring(shift(h), false))]
  let sk
  try {
    sk = SkeletonBuilder.BuildFromGeoJSON([poly])
  } catch {
    return null
  }
  const out: Tris = []
  for (const er of sk.Edges) {
    const face = er.Polygon
    if (face.length < 3) continue
    const pts = face.map((p) => new Vector2(p.X, p.Y))
    const hs = face.map((p) => sk.Distances.get(p) ?? 0)
    let tris: number[][]
    try {
      tris = ShapeUtils.triangulateShape(pts, [])
    } catch {
      return null
    }
    for (const [i0, i1, i2] of tris) {
      clipTriangle(
        [pts[i0].x + cx, pts[i0].y + cz, hs[i0] * pitch],
        [pts[i1].x + cx, pts[i1].y + cz, hs[i1] * pitch],
        [pts[i2].x + cx, pts[i2].y + cz, hs[i2] * pitch],
        cap,
        out,
      )
    }
  }
  if (out.length === 0) return null
  for (const v of out) if (!Number.isFinite(v)) return null
  return out
}

/**
 * Triángulo de un faldón cortado por la altura máxima: lo que queda por debajo se deja
 * inclinado y lo de encima se aplana a la cota `cap` (azotea).
 */
function clipTriangle(a: number[], b: number[], c: number[], cap: number, out: Tris): void {
  const pts = [a, b, c]
  const below: number[][] = []
  const above: number[][] = []
  for (let i = 0; i < 3; i++) {
    const p = pts[i]
    const q = pts[(i + 1) % 3]
    const pin = p[2] <= cap
    const qin = q[2] <= cap
    if (pin) below.push(p)
    else above.push([p[0], p[1], cap])
    if (pin !== qin) {
      const t = (cap - p[2]) / (q[2] - p[2])
      const m = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, cap]
      below.push(m)
      above.push(m)
    }
  }
  for (const poly of [below, above]) for (let k = 1; k + 1 < poly.length; k++) out.push(...poly[0], ...poly[k], ...poly[k + 1])
}

/** Quita puntos repetidos y casi alineados (el esqueleto se lía con ellos). */
function simplifyRing(r: ArrayLike<number>): number[] {
  // de uno en uno y comparando con los vecinos que quedan (quitar varios a la vez se come esquinas)
  const pts: Array<[number, number]> = []
  for (let i = 0; i + 1 < r.length; i += 2) {
    const last = pts[pts.length - 1]
    if (!last || Math.hypot(r[i] - last[0], r[i + 1] - last[1]) >= 0.15) pts.push([r[i], r[i + 1]])
  }
  while (pts.length > 3 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 0.15) pts.pop()
  let changed = true
  while (changed && pts.length > 3) {
    changed = false
    for (let i = 0; i < pts.length && pts.length > 3; ) {
      const p = pts[(i + pts.length - 1) % pts.length]
      const x = pts[i]
      const n = pts[(i + 1) % pts.length]
      const ax = x[0] - p[0]
      const az = x[1] - p[1]
      const bx = n[0] - x[0]
      const bz = n[1] - x[1]
      const base = Math.hypot(n[0] - p[0], n[1] - p[1])
      // casi alineado: el punto se aparta menos de 8 cm de la recta entre sus vecinos
      if (base > 1e-6 && Math.abs(ax * bz - az * bx) / base < 0.08 && ax * bx + az * bz > 0) {
        pts.splice(i, 1)
        changed = true
      } else i++
    }
  }
  return pts.flat()
}

function signedArea(r: ArrayLike<number>): number {
  let a = 0
  const n = r.length / 2
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    a += r[2 * i] * r[2 * j + 1] - r[2 * j] * r[2 * i + 1]
  }
  return a / 2
}
