// Transbordadores por las líneas de ferri de OpenStreetMap (capa `transportation`, clase `ferry`).
//
// Cada ruta es una cadena de líneas de ferri entre dos puertos o la frontera de la región; los
// barcos que van y vienen por ellas los mueve marine.ts con los demás barcos. El tamaño depende de
// la ruta: lancha de pasaje en los cruces cortos, ferri grande en los largos. Sin three.js ni DOM
// (worker y Node).

import { E, type RoadTile } from './roads.ts'
import { xToLon, yToLat } from '../world/mapTiles.ts'

const NZ = 2 ** 14
const BORDER_TOL = 4
const MAX_SEG = 40

export interface Route {
  id: number
  x: Float64Array
  z: Float64Array
  lat: Float64Array
  lon: Float64Array
  y: Float32Array
  s: Float64Array
  len: number
  /** el extremo a / b da a la frontera de la región */
  aOut: boolean
  bOut: boolean
  /** barcos grandes (ruta larga) */
  big: boolean
}

interface FNode {
  gx: number
  gy: number
  out: boolean
  parts: FPart[]
}
interface FPart {
  gx: Float64Array
  gy: Float64Array
  a: FNode
  b: FNode
  used: boolean
}

let nextId = 1

export function buildFerryRoutes(tiles: RoadTile[], project: (lat: number, lon: number, out: { x: number; z: number }) => void): Route[] {
  const region = new Set(tiles.map((t) => t.y * NZ + t.x))
  const interior = new Map<string, FNode>()
  const borders = new Map<string, FNode[]>()
  const parts: FPart[] = []
  const node = (t: RoadTile, px: number, py: number): FNode => {
    const gx = t.x * E + px
    const gy = t.y * E + py
    if (px > 0 && py > 0 && px < E && py < E) {
      const key = `${gx},${gy}`
      let n = interior.get(key)
      if (!n) interior.set(key, (n = { gx, gy, out: false, parts: [] }))
      return n
    }
    const vertical = px <= 0 || px >= E
    const lineKey = vertical ? `v${gx}` : `h${gy}`
    const along = vertical ? gy : gx
    let list = borders.get(lineKey)
    if (!list) borders.set(lineKey, (list = []))
    for (const n of list) if (Math.abs((vertical ? n.gy : n.gx) - along) <= BORDER_TOL) return n
    const other = vertical ? t.y * NZ + (px <= 0 ? t.x - 1 : t.x + 1) : (py <= 0 ? t.y - 1 : t.y + 1) * NZ + t.x
    const n: FNode = { gx, gy, out: !region.has(other), parts: [] }
    list.push(n)
    return n
  }
  for (const t of tiles) {
    for (const l of t.ferries) {
      const k = l.length / 2
      const gx = new Float64Array(k)
      const gy = new Float64Array(k)
      for (let i = 0; i < k; i++) {
        gx[i] = t.x * E + l[i * 2]
        gy[i] = t.y * E + l[i * 2 + 1]
      }
      const a = node(t, l[0], l[1])
      const b = node(t, l[l.length - 2], l[l.length - 1])
      gx[0] = a.gx
      gy[0] = a.gy
      gx[k - 1] = b.gx
      gy[k - 1] = b.gy
      if (a === b) continue
      const p: FPart = { gx, gy, a, b, used: false }
      a.parts.push(p)
      b.parts.push(p)
      parts.push(p)
    }
  }
  const routes: Route[] = []
  for (const p0 of parts) {
    if (p0.used) continue
    p0.used = true
    const seq: Array<{ p: FPart; fwd: boolean }> = [{ p: p0, fwd: true }]
    const walk = (start: FNode, last: FPart, forward: boolean) => {
      let n = start
      let prev = last
      for (;;) {
        if (n.out || n.parts.length !== 2) break
        const q = n.parts[0] === prev ? n.parts[1] : n.parts[0]
        if (q.used) break
        q.used = true
        const fwd = q.a === n
        if (forward) seq.push({ p: q, fwd })
        else seq.unshift({ p: q, fwd: !fwd })
        prev = q
        n = fwd ? q.b : q.a
      }
    }
    walk(p0.b, p0, true)
    walk(p0.a, p0, false)
    const gx: number[] = []
    const gy: number[] = []
    for (const { p, fwd } of seq) {
      const k = p.gx.length
      for (let i = 0; i < k; i++) {
        const j = fwd ? i : k - 1 - i
        if (gx.length > 0 && i === 0) continue
        gx.push(p.gx[j])
        gy.push(p.gy[j])
      }
    }
    const a = seq[0].fwd ? seq[0].p.a : seq[0].p.b
    const last = seq[seq.length - 1]
    const b = last.fwd ? last.p.b : last.p.a
    const X: number[] = []
    const Z: number[] = []
    const LA: number[] = []
    const LO: number[] = []
    const P = { x: 0, z: 0 }
    let px = 0
    let pz = 0
    let plat = 0
    let plon = 0
    for (let i = 0; i < gx.length; i++) {
      const lat = yToLat(gy[i] / E, NZ)
      const lon = xToLon(gx[i] / E, NZ)
      project(lat, lon, P)
      if (i > 0) {
        const L = Math.hypot(P.x - px, P.z - pz)
        if (L < 0.1) continue
        const k = Math.ceil(L / MAX_SEG)
        for (let j = 1; j < k; j++) {
          const f = j / k
          X.push(px + (P.x - px) * f)
          Z.push(pz + (P.z - pz) * f)
          LA.push(plat + (lat - plat) * f)
          LO.push(plon + (lon - plon) * f)
        }
      }
      X.push(P.x)
      Z.push(P.z)
      LA.push(lat)
      LO.push(lon)
      px = P.x
      pz = P.z
      plat = lat
      plon = lon
    }
    const n = X.length
    if (n < 2) continue
    const s = new Float64Array(n)
    for (let i = 1; i < n; i++) s[i] = s[i - 1] + Math.hypot(X[i] - X[i - 1], Z[i] - Z[i - 1])
    if (s[n - 1] < 150) continue
    routes.push({
      id: nextId++,
      x: Float64Array.from(X),
      z: Float64Array.from(Z),
      lat: Float64Array.from(LA),
      lon: Float64Array.from(LO),
      y: new Float32Array(n).fill(NaN),
      s,
      len: s[n - 1],
      aOut: a.out,
      bOut: b.out,
      // ferri grande solo en las travesías largas (las lanchas de ría o de bahía cruzan 2–8 km)
      big: s[n - 1] > 12000 || ((a.out || b.out) && s[n - 1] > 8000),
    })
  }
  return routes
}
