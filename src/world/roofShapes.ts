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
 * `across` = caballete a lo ancho en vez de a lo largo (roof:orientation=across de OSM).
 */
export function rectRoof(box: OrientedBox, kind: RectKind, pitch: number, maxRise: number, overhang: number, across = false): RectRoof {
  const c = Math.cos(box.angle)
  const s = Math.sin(box.angle)
  const alongU = box.hu >= box.hv !== across
  const L = (alongU ? box.hu : box.hv) + overhang
  const W = (alongU ? box.hv : box.hu) + overhang
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

// ---------------------------------------------------------------------------
// Formas de tejado mapeadas en OpenStreetMap (roof:shape) que no salen de la planta:
// cúpulas, bulbos, chapiteles, conos y tejados a un agua.

/** Perfil de revolución: [escala hacia el centro, fracción de la altura], de la base a la cima. */
export type Profile = Array<[number, number]>

/** media esfera (estirada a la altura del tejado) */
export const PROFILE_DOME: Profile = Array.from({ length: 9 }, (_, k) => {
  const a = (k / 8) * (Math.PI / 2)
  return [Math.cos(a), Math.sin(a)] as [number, number]
})

/** bulbo (cebolla): se ensancha por encima de la base y acaba en punta */
export const PROFILE_ONION: Profile = [
  [1, 0],
  [1.12, 0.08],
  [1.2, 0.18],
  [1.17, 0.3],
  [1.02, 0.42],
  [0.78, 0.54],
  [0.5, 0.66],
  [0.27, 0.78],
  [0.12, 0.88],
  [0, 1],
]

/** cono o pirámide: recto hasta la punta */
export const PROFILE_SPIRE: Profile = [
  [1, 0],
  [0, 1],
]

export interface SmoothMesh {
  /** vértices [x, z, h] (h sobre el alero) */
  pos: number[]
  /** normales [nx, ny, nz] (y = arriba) */
  nor: number[]
  /** triángulos, mirando hacia fuera */
  idx: number[]
}

/** Centroide de área de un anillo (x, z alternados). */
export function ringCentroid(xz: ArrayLike<number>): [number, number] {
  const n = xz.length / 2
  let a = 0
  let cx = 0
  let cz = 0
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const c = xz[2 * i] * xz[2 * j + 1] - xz[2 * j] * xz[2 * i + 1]
    a += c
    cx += (xz[2 * i] + xz[2 * j]) * c
    cz += (xz[2 * i + 1] + xz[2 * j + 1]) * c
  }
  if (Math.abs(a) < 1e-9) {
    for (let i = 0; i < n; i++) {
      cx += xz[2 * i]
      cz += xz[2 * i + 1]
    }
    return [cx / n, cz / n]
  }
  return [cx / (3 * a), cz / (3 * a)]
}

/** ¿Se ve todo el contorno desde (cx, cz)? (planta en estrella: se puede encoger hacia ese punto) */
export function starShaped(xz: ArrayLike<number>, cx: number, cz: number): boolean {
  const n = xz.length / 2
  let sign = 0
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const c = (xz[2 * i] - cx) * (xz[2 * j + 1] - cz) - (xz[2 * j] - cx) * (xz[2 * i + 1] - cz)
    if (Math.abs(c) < 1e-6) continue
    const s = Math.sign(c)
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return sign !== 0
}

/**
 * Tejado de revolución sobre la planta: cada anillo del perfil es la huella encogida hacia
 * (cx, cz) y subida. `smooth` = normales promediadas (cúpula, bulbo, cono); si no, cada cara
 * con la suya (pirámide). La planta debe ser en estrella respecto a (cx, cz).
 */
export function radialRoof(xz: ArrayLike<number>, cx: number, cz: number, h: number, profile: Profile, smooth: boolean): SmoothMesh {
  const n = xz.length / 2
  const out: SmoothMesh = { pos: [], nor: [], idx: [] }
  // orientación de la planta: con área negativa (x este, z sur), (a, b, c) mira hacia fuera
  let area = 0
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    area += xz[2 * i] * xz[2 * j + 1] - xz[2 * j] * xz[2 * i + 1]
  }
  const ccw = area < 0
  const P = (k: number, i: number): [number, number, number] => {
    const [s, t] = profile[k]
    return [cx + (xz[2 * i] - cx) * s, cz + (xz[2 * i + 1] - cz) * s, h * t]
  }
  const faceN = (a: number[], b: number[], c: number[]): [number, number, number] => {
    // (x, h, z) como (x, y, z)
    const e1 = [b[0] - a[0], b[2] - a[2], b[1] - a[1]]
    const e2 = [c[0] - a[0], c[2] - a[2], c[1] - a[1]]
    let nx = e1[1] * e2[2] - e1[2] * e2[1]
    let ny = e1[2] * e2[0] - e1[0] * e2[2]
    let nz = e1[0] * e2[1] - e1[1] * e2[0]
    const l = Math.hypot(nx, ny, nz) || 1
    nx /= l
    ny /= l
    nz /= l
    return [nx, ny, nz]
  }
  const K = profile.length
  const apex = profile[K - 1][0] === 0
  if (smooth) {
    // rejilla (K anillos × n) con normales acumuladas; la punta, una por gajo
    const grid: number[] = []
    const acc: number[] = []
    const rings = apex ? K - 1 : K
    for (let k = 0; k < rings; k++) {
      for (let i = 0; i < n; i++) {
        grid.push(...P(k, i))
        acc.push(0, 0, 0)
      }
    }
    const tris: Array<[number, number, number]> = []
    const v = (k: number, i: number) => k * n + (i % n)
    const addTri = (a: number, b: number, c: number) => {
      const A = grid.slice(3 * a, 3 * a + 3)
      const B = grid.slice(3 * b, 3 * b + 3)
      const C = grid.slice(3 * c, 3 * c + 3)
      const [nx, ny, nz] = faceN(A, B, C)
      // área (sin normalizar) para promediar
      const w = triArea(A, B, C)
      for (const q of [a, b, c]) {
        acc[3 * q] += nx * w
        acc[3 * q + 1] += ny * w
        acc[3 * q + 2] += nz * w
      }
      tris.push([a, b, c])
    }
    for (let k = 0; k + 1 < rings; k++) {
      for (let i = 0; i < n; i++) {
        const a = v(k, i)
        const b = v(k, i + 1)
        const c = v(k + 1, i + 1)
        const d = v(k + 1, i)
        if (ccw) {
          addTri(a, b, c)
          addTri(a, c, d)
        } else {
          addTri(a, c, b)
          addTri(a, d, c)
        }
      }
    }
    for (let q = 0; q < grid.length / 3; q++) {
      const l = Math.hypot(acc[3 * q], acc[3 * q + 1], acc[3 * q + 2]) || 1
      out.pos.push(grid[3 * q], grid[3 * q + 1], grid[3 * q + 2])
      out.nor.push(acc[3 * q] / l, acc[3 * q + 1] / l, acc[3 * q + 2] / l)
    }
    for (const [a, b, c] of tris) out.idx.push(a, b, c)
    if (apex) {
      // último anillo → punta: un vértice de punta por gajo, con la normal media de sus dos bordes
      const top = P(K - 1, 0)
      const k = rings - 1
      for (let i = 0; i < n; i++) {
        const a = v(k, i)
        const b = v(k, i + 1)
        const base = out.pos.length / 3
        const A = grid.slice(3 * a, 3 * a + 3)
        const B = grid.slice(3 * b, 3 * b + 3)
        const fn = ccw ? faceN(A, B, top) : faceN(B, A, top)
        const nx = out.nor[3 * a] + out.nor[3 * b] + fn[0]
        const ny = out.nor[3 * a + 1] + out.nor[3 * b + 1] + fn[1]
        const nz = out.nor[3 * a + 2] + out.nor[3 * b + 2] + fn[2]
        const l = Math.hypot(nx, ny, nz) || 1
        out.pos.push(...top)
        out.nor.push(nx / l, ny / l, nz / l)
        if (ccw) out.idx.push(a, b, base)
        else out.idx.push(b, a, base)
      }
    }
    return out
  }
  // caras planas: cada triángulo con sus vértices
  const pushTri = (A: number[], B: number[], C: number[]) => {
    const [nx, ny, nz] = faceN(A, B, C)
    const base = out.pos.length / 3
    out.pos.push(...A, ...B, ...C)
    for (let q = 0; q < 3; q++) out.nor.push(nx, ny, nz)
    out.idx.push(base, base + 1, base + 2)
  }
  for (let k = 0; k + 1 < K; k++) {
    for (let i = 0; i < n; i++) {
      const a = P(k, i)
      const b = P(k, (i + 1) % n)
      const c = P(k + 1, (i + 1) % n)
      const d = P(k + 1, i)
      const quad = profile[k + 1][0] > 0
      if (ccw) {
        pushTri(a, b, c)
        if (quad) pushTri(a, c, d)
      } else {
        pushTri(a, c, b)
        if (quad) pushTri(a, d, c)
      }
    }
  }
  return out
}

function triArea(a: number[], b: number[], c: number[]): number {
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
  return Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]) / 2
}

/**
 * Tejado a un agua: altura de cada vértice de la planta (de `h` en el lado alto a 0 en el bajo).
 * (dx, dz) = hacia dónde cae el agua (roof:direction de OSM).
 */
export function skillionHeights(xz: ArrayLike<number>, dx: number, dz: number, h: number): number[] {
  const n = xz.length / 2
  let p0 = Infinity
  let p1 = -Infinity
  for (let i = 0; i < n; i++) {
    const p = xz[2 * i] * dx + xz[2 * i + 1] * dz
    p0 = Math.min(p0, p)
    p1 = Math.max(p1, p)
  }
  const span = Math.max(1e-6, p1 - p0)
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push((h * (p1 - (xz[2 * i] * dx + xz[2 * i + 1] * dz))) / span)
  return out
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
