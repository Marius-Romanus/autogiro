// Trenes por las vías de OpenStreetMap (capa `transportation` de OpenFreeMap: tren, vía
// estrecha, metro y tranvía o metro ligero; sin las vías de servicio de las playas de vías).
//
// Los tranvías van como los trenes (cantones, paradas, vía de su lado: el de los coches) pero
// por la calle: frenan por los coches que tienen delante en la vía, los coches no se les meten
// encima (la red de seguridad de sim.ts cuenta sus coches) y en los cruces la calle solo se
// cierra cuando el tranvía está llegando.
//
// - Red: tramos de vía entre desvíos (nudos de tres o más vías). En un desvío solo se pasa de una
//   vía a otra que siga casi recta (< 35°): en un cruce en diamante no se gira.
// - Cantones: cada tramo entre desvíos es un cantón. Un tren solo entra en un tramo que ha
//   reservado y reserva los de delante hasta su distancia de frenado: dos trenes nunca están en
//   el mismo tramo (vía única incluida: uno espera en el desvío). Libera los tramos que deja atrás.
// - Paran en las estaciones (puntos de OSM junto a la vía) y en una vía muerta dan la vuelta.
// - Vía doble: cada tren prefiere la vía de su lado (el de la circulación ferroviaria del país).
// - Pasos a nivel: las vías que cruzan una calle a nivel cierran el paso a los coches cuando se
//   acerca un tren (sim.ts mira `crossingClosed`).
//
// Sin three.js ni DOM (worker y Node).

import { E, type RailLine, type RoadTile } from './roads.ts'
import type { Lane, Link, Move } from './network.ts'
import { rng } from './sim.ts'
import { xToLon, yToLat } from '../world/mapTiles.ts'

const NZ = 2 ** 14
const BORDER_TOL = 3
const MAX_SEG = 15

export type RailKind = 'rail' | 'narrow' | 'metro' | 'tram'

interface TNode {
  gx: number
  gy: number
  x: number
  z: number
  ends: Array<{ t: Track; atA: boolean }>
  frontier: boolean
  pieces: RPiece[]
  /** tren que pasa por el nudo (enclavamiento: en un cruce en diamante, uno solo) */
  holder?: Train | null
}

interface RPiece {
  line: RailLine
  gx: Float64Array
  gy: Float64Array
  a: TNode
  b: TNode
  used: boolean
}

export interface Track {
  id: number
  kind: RailKind
  x: Float64Array
  z: Float64Array
  lat: Float64Array
  lon: Float64Array
  y: Float32Array
  s: Float64Array
  len: number
  bri: Int8Array
  layer: Int8Array
  vmax: Float32Array
  a: TNode
  b: TNode
  /** saliendo por b (sentido +1) o por a (sentido -1): tramos por los que se puede seguir */
  nextB: Array<{ t: Track; dir: 1 | -1; turn: number }>
  nextA: Array<{ t: Track; dir: 1 | -1; turn: number }>
  /** paradas (s) de las estaciones junto a este tramo */
  stops: number[]
  /** tren que lo tiene reservado */
  holder: Train | null
  /** pasos a nivel en este tramo */
  crossings: Crossing[]
  /** sentido preferido en vía doble (0 = vía única o no se sabe) */
  pref: 0 | 1 | -1
}

export interface Train {
  id: number
  kind: RailKind
  cars: number
  carLen: number
  len: number
  vmax: number
  a: number
  b: number
  /** viajeros (para en las estaciones) */
  stopsAtStations: boolean
  path: Array<{ t: Track; dir: 1 | -1 }>
  /** índice del tramo de la cabeza y posición en él (en su sentido) */
  hi: number
  s: number
  v: number
  dwell: number
  /** parada que ya se ha hecho (tramo y s) para no repetirla */
  lastStop: string
  stuck: number
  dead: boolean
  color: number
}

export interface Crossing {
  /** carril (o movimiento de un cruce) que cruza la vía */
  lane: Lane | null
  move: Move | null
  /** tramo de la calle (s) que ocupa la vía */
  s0: number
  s1: number
  track: Track
  /** punto de la vía (s) */
  ts: number
}

/** caja de un coche (plano): centro, eje, semilargo y semiancho */
interface CarBox {
  tr: Train
  cx: number
  cz: number
  ux: number
  uz: number
  hl: number
  hw: number
}

function boxHit(a: CarBox, b: CarBox): boolean {
  const dx = b.cx - a.cx
  const dz = b.cz - a.cz
  if (Math.abs(dx) > a.hl + b.hl + 1 || Math.abs(dz) > a.hl + b.hl + 1) return false
  const axes = [a.ux, a.uz, -a.uz, a.ux, b.ux, b.uz, -b.uz, b.ux]
  for (let i = 0; i < 8; i += 2) {
    const x = axes[i]
    const z = axes[i + 1]
    const ra = a.hl * Math.abs(a.ux * x + a.uz * z) + a.hw * Math.abs(-a.uz * x + a.ux * z)
    const rb = b.hl * Math.abs(b.ux * x + b.uz * z) + b.hw * Math.abs(-b.uz * x + b.ux * z)
    if (Math.abs(dx * x + dz * z) > ra + rb) return false
  }
  return true
}

const CAR: Record<RailKind, { len: number; cars: [number, number]; vmax: number; a: number; b: number }> = {
  rail: { len: 23.5, cars: [3, 8], vmax: 33, a: 0.6, b: 0.8 },
  narrow: { len: 17, cars: [2, 4], vmax: 19, a: 0.7, b: 0.9 },
  metro: { len: 17, cars: [4, 6], vmax: 19, a: 1.0, b: 1.1 },
  tram: { len: 9, cars: [3, 5], vmax: 14, a: 1.1, b: 1.3 },
}

/** medio ancho de la caja de un coche para los vehículos de la calle (con margen) */
export function carHalfWidth(kind: RailKind): number {
  return kind === 'tram' ? 1.2 : 1.5
}

/**
 * medio ancho de la caja entre trenes: más justo (en OSM dos vías paralelas pueden quedar a menos de
 * 3 m; lo que importa son las agujas y los cruces, donde las cajas se pisan de verdad)
 */
function trainHalfWidth(kind: RailKind): number {
  return kind === 'tram' ? 1.15 : 1.3
}

/** hueco entre coches (los módulos del tranvía van unidos por el fuelle) */
export function carGap(kind: RailKind): number {
  return kind === 'tram' ? 0.3 : 1.2
}

let nextId = 1

// ---------------------------------------------------------------------------
// Red
// ---------------------------------------------------------------------------

export interface RailNet {
  tracks: Track[]
  /** extremos de tramo que dan a la frontera (por ahí entran trenes) */
  entries: Array<{ t: Track; dir: 1 | -1 }>
  crossings: Crossing[]
}

export function buildRailNet(
  tiles: RoadTile[],
  project: (lat: number, lon: number, out: { x: number; z: number }) => void,
  links: Link[],
  side: 1 | -1,
  moves: Move[] = [],
  roadSide: 1 | -1 = side,
): RailNet {
  const region = new Set(tiles.map((t) => t.y * NZ + t.x))
  const nodes: TNode[] = []
  const pieces: RPiece[] = []
  const interior = new Map<string, TNode>()
  const borders = new Map<string, TNode[]>()
  const newNode = (gx: number, gy: number, frontier: boolean): TNode => {
    const n: TNode = { gx, gy, x: 0, z: 0, ends: [], frontier, pieces: [] }
    nodes.push(n)
    return n
  }
  const node = (t: RoadTile, px: number, py: number): TNode => {
    const gx = t.x * E + px
    const gy = t.y * E + py
    if (px > 0 && py > 0 && px < E && py < E) {
      const key = `${gx},${gy}`
      let n = interior.get(key)
      if (!n) interior.set(key, (n = newNode(gx, gy, false)))
      return n
    }
    const vertical = px <= 0 || px >= E
    const lineKey = vertical ? `v${gx}` : `h${gy}`
    const along = vertical ? gy : gx
    let list = borders.get(lineKey)
    if (!list) borders.set(lineKey, (list = []))
    for (const n of list) if (Math.abs((vertical ? n.gy : n.gx) - along) <= BORDER_TOL) return n
    const other = vertical ? t.y * NZ + (px <= 0 ? t.x - 1 : t.x + 1) : (py <= 0 ? t.y - 1 : t.y + 1) * NZ + t.x
    const n = newNode(gx, gy, !region.has(other))
    list.push(n)
    return n
  }
  for (const t of tiles) {
    const count = new Map<string, number>()
    for (const l of t.rails) for (let i = 0; i < l.pts.length; i += 2) count.set(`${l.pts[i]},${l.pts[i + 1]}`, (count.get(`${l.pts[i]},${l.pts[i + 1]}`) ?? 0) + 1)
    for (const l of t.rails) {
      const nv = l.pts.length / 2
      let start = 0
      for (let j = 1; j < nv; j++) {
        if (j < nv - 1 && (count.get(`${l.pts[j * 2]},${l.pts[j * 2 + 1]}`) ?? 0) < 2) continue
        const k = j - start + 1
        const gx = new Float64Array(k)
        const gy = new Float64Array(k)
        for (let i = 0; i < k; i++) {
          gx[i] = t.x * E + l.pts[(start + i) * 2]
          gy[i] = t.y * E + l.pts[(start + i) * 2 + 1]
        }
        const a = node(t, l.pts[start * 2], l.pts[start * 2 + 1])
        const b = node(t, l.pts[j * 2], l.pts[j * 2 + 1])
        gx[0] = a.gx
        gy[0] = a.gy
        gx[k - 1] = b.gx
        gy[k - 1] = b.gy
        if (a !== b || k > 2) {
          const p: RPiece = { line: l, gx, gy, a, b, used: false }
          a.pieces.push(p)
          b.pieces.push(p)
          pieces.push(p)
        }
        start = j
      }
    }
  }
  const P = { x: 0, z: 0 }
  for (const n of nodes) {
    project(yToLat(n.gy / E, NZ), xToLon(n.gx / E, NZ), P)
    n.x = P.x
    n.z = P.z
  }
  // tramos: cadenas por nudos de dos piezas del mismo tipo
  const tracks: Track[] = []
  for (const p0 of pieces) {
    if (p0.used) continue
    p0.used = true
    const seq: Array<{ p: RPiece; fwd: boolean }> = [{ p: p0, fwd: true }]
    const walk = (start: TNode, last: RPiece, forward: boolean) => {
      let n = start
      let prev = last
      for (;;) {
        if (n.frontier || n.pieces.length !== 2) break
        const q = n.pieces[0] === prev ? n.pieces[1] : n.pieces[0]
        if (q === prev || q.used || q.line.kind !== p0.line.kind) break
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
    const t = makeTrack(seq, project)
    if (t) tracks.push(t)
  }
  for (const t of tracks) {
    t.a.ends.push({ t, atA: true })
    t.b.ends.push({ t, atA: false })
  }
  // desvíos: de qué tramo a cuál se puede pasar
  for (const n of nodes) {
    for (const e of n.ends) {
      // llegar al nudo por e: si e empieza aquí, se llega en sentido -1
      const inDir = endDir(e.t, e.atA, true)
      const list = e.atA ? e.t.nextA : e.t.nextB
      for (const f of n.ends) {
        if (f === e) continue
        const outDir = endDir(f.t, f.atA, false)
        const turn = Math.abs(Math.atan2(inDir[0] * outDir[1] - inDir[1] * outDir[0], inDir[0] * outDir[0] + inDir[1] * outDir[1]))
        if (turn > 0.6) continue
        list.push({ t: f.t, dir: f.atA ? 1 : -1, turn })
      }
    }
  }
  // estaciones: la parada en cada vía a menos de 45 m del punto
  for (const tile of tiles) {
    for (const st of tile.stations) {
      project(yToLat((tile.y * E + st.y) / E, NZ), xToLon((tile.x * E + st.x) / E, NZ), P)
      for (const t of tracks) {
        // el tranvía para en sus paradas (y en las estaciones de tren de su camino)
        const want = t.kind === 'metro' ? st.metro : t.kind === 'tram' ? !st.metro : !st.metro && !st.tram
        if (!want) continue
        const tram = t.kind === 'tram'
        const near = nearestOnTrack(t, P.x, P.z)
        if (near.d < (tram ? 25 : 45) && near.s > (tram ? 15 : 30) && near.s < t.len - (tram ? 15 : 30)) t.stops.push(near.s)
      }
    }
  }
  for (const t of tracks) t.stops.sort((a, b) => a - b)
  // vía doble: el tramo paralelo más cercano dice de qué lado va esta
  const side2 = side
  for (const t of tracks) {
    const i = t.x.length >> 1
    const dx = t.x[Math.min(i + 1, t.x.length - 1)] - t.x[Math.max(i - 1, 0)]
    const dz = t.z[Math.min(i + 1, t.x.length - 1)] - t.z[Math.max(i - 1, 0)]
    const l = Math.hypot(dx, dz) || 1
    let best = Infinity
    let lat = 0
    for (const o of tracks) {
      if (o === t || o.kind !== t.kind) continue
      const near = nearestOnTrack(o, t.x[i], t.z[i])
      if (near.d > 7 || near.d < 2.5 || near.d > best) continue
      const ox = near.x - t.x[i]
      const oz = near.z - t.z[i]
      best = near.d
      // lado del paralelo respecto al sentido a→b: derecha si (−dz, dx)·(ox, oz) > 0
      lat = ((-dz / l) * ox + (dx / l) * oz) > 0 ? 1 : -1
    }
    // el paralelo a la derecha: esta es la vía de la izquierda; con circulación por la derecha va de b a a
    const sd = t.kind === 'tram' ? roadSide : side2
    if (best < Infinity) t.pref = (lat > 0 ? -sd : sd) as 1 | -1
  }
  // entradas por la frontera
  const entries: Array<{ t: Track; dir: 1 | -1 }> = []
  for (const t of tracks) {
    if (t.kind === 'metro' && t.bri.every((b) => b === -1)) continue
    if (t.a.frontier) entries.push({ t, dir: 1 })
    if (t.b.frontier) entries.push({ t, dir: -1 })
  }
  // pasos a nivel con las calles
  const crossings = findCrossings(tracks, links, side, moves)
  for (const c of crossings) c.track.crossings.push(c)
  return { tracks, entries, crossings }
}

function makeTrack(seq: Array<{ p: RPiece; fwd: boolean }>, project: (lat: number, lon: number, out: { x: number; z: number }) => void): Track | null {
  const gx: number[] = []
  const gy: number[] = []
  const bri: number[] = []
  const lay: number[] = []
  for (const { p, fwd } of seq) {
    const k = p.gx.length
    for (let i = 0; i < k; i++) {
      const j = fwd ? i : k - 1 - i
      if (gx.length > 0 && i === 0) continue
      gx.push(p.gx[j])
      gy.push(p.gy[j])
      if (gx.length > 1) {
        bri.push(p.line.brunnel)
        lay.push(p.line.layer)
      }
    }
  }
  const a = seq[0].fwd ? seq[0].p.a : seq[0].p.b
  const last = seq[seq.length - 1]
  const b = last.fwd ? last.p.b : last.p.a
  const X: number[] = []
  const Z: number[] = []
  const LA: number[] = []
  const LO: number[] = []
  const B: number[] = []
  const Y: number[] = []
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
      if (L < 0.05) continue
      const k = Math.ceil(L / MAX_SEG)
      for (let j = 1; j < k; j++) {
        const t = j / k
        X.push(px + (P.x - px) * t)
        Z.push(pz + (P.z - pz) * t)
        LA.push(plat + (lat - plat) * t)
        LO.push(plon + (lon - plon) * t)
        B.push(bri[i - 1])
        Y.push(lay[i - 1])
      }
      B.push(bri[i - 1])
      Y.push(lay[i - 1])
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
  if (n < 2) return null
  const s = new Float64Array(n)
  for (let i = 1; i < n; i++) s[i] = s[i - 1] + Math.hypot(X[i] - X[i - 1], Z[i] - Z[i - 1])
  if (s[n - 1] < 1) return null
  const kind = seq[0].p.line.kind
  const vmax = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let v = CAR[kind].vmax
    if (i > 0 && i < n - 1) {
      const R = radius(X[i - 1], Z[i - 1], X[i], Z[i], X[i + 1], Z[i + 1])
      v = Math.min(v, Math.max(kind === 'tram' ? 3 : 6, Math.sqrt(0.9 * R)))
    }
    vmax[i] = v
  }
  return {
    id: nextId++,
    kind,
    x: Float64Array.from(X),
    z: Float64Array.from(Z),
    lat: Float64Array.from(LA),
    lon: Float64Array.from(LO),
    y: new Float32Array(n).fill(NaN),
    s,
    len: s[n - 1],
    bri: Int8Array.from(B),
    layer: Int8Array.from(Y),
    vmax,
    a,
    b,
    nextA: [],
    nextB: [],
    stops: [],
    holder: null,
    crossings: [],
    pref: 0,
  }
}

/** nudo por el que se sale de un tramo en ese sentido */
function exitNode(p: { t: Track; dir: 1 | -1 }): TNode {
  return p.dir === 1 ? p.t.b : p.t.a
}

function radius(ax: number, az: number, bx: number, bz: number, cx: number, cz: number): number {
  const ab = Math.hypot(bx - ax, bz - az)
  const bc = Math.hypot(cx - bx, cz - bz)
  const ca = Math.hypot(ax - cx, az - cz)
  const cr = Math.abs((bx - ax) * (cz - az) - (bz - az) * (cx - ax))
  return cr < 1e-6 ? 1e6 : (ab * bc * ca) / (2 * cr)
}

/** dirección (unitaria) del tramo en un extremo: `arriving` = la de llegar a ese extremo */
function endDir(t: Track, atA: boolean, arriving: boolean): [number, number] {
  const k = t.x.length
  const i0 = atA ? 0 : k - 1
  const i1 = atA ? Math.min(2, k - 1) : Math.max(k - 3, 0)
  let dx = t.x[i1] - t.x[i0]
  let dz = t.z[i1] - t.z[i0]
  const l = Math.hypot(dx, dz) || 1
  dx /= l
  dz /= l
  // dx, dz apunta hacia dentro del tramo: saliendo del nudo; al llegar, al revés
  return arriving ? [-dx, -dz] : [dx, dz]
}

function nearestOnTrack(t: Track, px: number, pz: number): { d: number; s: number; x: number; z: number } {
  let best = { d: Infinity, s: 0, x: 0, z: 0 }
  for (let i = 0; i + 1 < t.x.length; i++) {
    const ax = t.x[i]
    const az = t.z[i]
    const dx = t.x[i + 1] - ax
    const dz = t.z[i + 1] - az
    const l2 = dx * dx + dz * dz
    const f = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0
    const x = ax + dx * f
    const z = az + dz * f
    const d = Math.hypot(px - x, pz - z)
    if (d < best.d) best = { d, s: t.s[i] + (t.s[i + 1] - t.s[i]) * f, x, z }
  }
  return best
}

/** Vías que cruzan una calle a nivel: el tramo de cada carril que pisa la vía. */
function findCrossings(tracks: Track[], links: Link[], side: 1 | -1, moves: Move[]): Crossing[] {
  const CELL = 25
  const key = (x: number, z: number) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`
  const grid = new Map<string, Array<[Track, number]>>()
  for (const t of tracks) {
    for (let i = 0; i + 1 < t.x.length; i++) {
      if (t.bri[i] !== 0) continue
      for (const k of new Set([key(t.x[i], t.z[i]), key(t.x[i + 1], t.z[i + 1]), key((t.x[i] + t.x[i + 1]) / 2, (t.z[i] + t.z[i + 1]) / 2)])) {
        const arr = grid.get(k)
        if (arr) arr.push([t, i])
        else grid.set(k, [[t, i]])
      }
    }
  }
  const out: Crossing[] = []
  for (const l of links) {
    for (let i = 0; i + 1 < l.x.length; i++) {
      if (l.bri[i] !== 0) continue
      const cands = new Set<[Track, number]>()
      for (const k of [key(l.x[i], l.z[i]), key(l.x[i + 1], l.z[i + 1]), key((l.x[i] + l.x[i + 1]) / 2, (l.z[i] + l.z[i + 1]) / 2)]) for (const c of grid.get(k) ?? []) cands.add(c)
      for (const [t, j] of cands) {
        const hit = segCross(l.x[i], l.z[i], l.x[i + 1], l.z[i + 1], t.x[j], t.z[j], t.x[j + 1], t.z[j + 1])
        if (!hit) continue
        const s = l.s[i] + (l.s[i + 1] - l.s[i]) * hit[0]
        const ts = t.s[j] + (t.s[j + 1] - t.s[j]) * hit[1]
        if (s < l.s0 || s > l.s1) continue
        // anchura de la vía a lo largo de la calle según el ángulo de cruce
        const ux = (l.x[i + 1] - l.x[i]) / (l.s[i + 1] - l.s[i] || 1)
        const uz = (l.z[i + 1] - l.z[i]) / (l.s[i + 1] - l.s[i] || 1)
        const vx = (t.x[j + 1] - t.x[j]) / (t.s[j + 1] - t.s[j] || 1)
        const vz = (t.z[j + 1] - t.z[j]) / (t.s[j + 1] - t.s[j] || 1)
        const sin = Math.max(0.3, Math.abs(ux * vz - uz * vx))
        const half = 3.5 / sin + 1
        for (const lane of l.lanes) {
          const c: Crossing = { lane, move: null, s0: s - half, s1: s + half, track: t, ts }
          lane.rail.push(c)
          out.push(c)
        }
      }
    }
  }
  // movimientos de los cruces que pasan por encima de la vía (paso a nivel dentro de un cruce)
  for (const m of moves) {
    const k = m.x.length
    for (let i = 0; i + 1 < k; i++) {
      const cands = new Set<[Track, number]>()
      for (const kk of [key(m.x[i], m.z[i]), key(m.x[i + 1], m.z[i + 1])]) for (const c of grid.get(kk) ?? []) cands.add(c)
      for (const [t, j] of cands) {
        const hit = segCross(m.x[i], m.z[i], m.x[i + 1], m.z[i + 1], t.x[j], t.z[j], t.x[j + 1], t.z[j + 1])
        if (!hit) continue
        if (m.from.bri[m.from.bri.length - 1] !== 0) continue
        const s = m.s[i] + (m.s[i + 1] - m.s[i]) * hit[0]
        const ts = t.s[j] + (t.s[j + 1] - t.s[j]) * hit[1]
        const c: Crossing = { lane: null, move: m, s0: s - 5, s1: s + 5, track: t, ts }
        m.rail.push(c)
        out.push(c)
      }
    }
  }
  void side
  return out
}

function segCross(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): [number, number] | null {
  const rx = bx - ax
  const rz = bz - az
  const sx = dx - cx
  const sz = dz - cz
  const den = rx * sz - rz * sx
  if (Math.abs(den) < 1e-9) return null
  const ta = ((cx - ax) * sz - (cz - az) * sx) / den
  const tb = ((cx - ax) * rz - (cz - az) * rx) / den
  if (ta < 0 || ta > 1 || tb < 0 || tb > 1) return null
  return [ta, tb]
}

// ---------------------------------------------------------------------------
// Trenes
// ---------------------------------------------------------------------------

export class RailSim {
  net: RailNet | null = null
  readonly trains: Train[] = []
  t = 0
  /** trenes por cada 10 km de vía (a la hora de más tráfico) */
  density = 1
  hour = 12
  camera: { x: number; z: number } | null = null
  /** ¿hay un coche a menos de r del punto? (lo pone el worker: los tranvías frenan por ellos) */
  occupied: ((x: number, z: number, r: number, ux: number, uz: number) => boolean) | null = null
  /** ¿esa caja pisa un coche? (red de seguridad de los tranvías; también la pone el worker) */
  boxBlocked: ((cx: number, cz: number, ux: number, uz: number, hl: number, hw: number, tram: boolean) => boolean) | null = null
  private readonly rand: () => number
  private spawnAcc = new Map<string, number>()

  constructor(seed = 3) {
    this.rand = rng(seed)
  }

  setNetwork(net: RailNet): void {
    for (const tr of this.trains) this.release(tr)
    this.trains.length = 0
    this.net = net
  }

  /** Pone trenes por la red (al empezar o en lo nuevo). */
  fill(only?: (t: Track) => boolean): void {
    const net = this.net
    if (!net) return
    for (const t of net.tracks) {
      if (only && !only(t)) continue
      // solo donde el tren cabe entero (si no, la cola asomaría a otro tramo sin reservar)
      if (t.holder || t.len < CAR[t.kind].len * CAR[t.kind].cars[1] * 1.1 + 30) continue
      if (t.kind === 'metro' && t.bri.every((b) => b === -1)) continue
      const want = (t.len / 10000) * 2.2 * (t.kind === 'tram' ? 3 : 1) * this.density * trafficHour(this.hour)
      if (this.rand() > want) continue
      const dir: 1 | -1 = t.pref !== 0 ? t.pref : this.rand() < 0.5 ? 1 : -1
      this.spawnOn(t, dir, t.len * (0.3 + this.rand() * 0.6))
    }
  }

  private spawnOn(t: Track, dir: 1 | -1, s: number): Train | null {
    if (t.holder) return null
    const C = CAR[t.kind]
    const cars = C.cars[0] + Math.floor(this.rand() * (C.cars[1] - C.cars[0] + 1))
    const len = cars * (C.len + carGap(t.kind))
    const tr: Train = {
      id: nextId++,
      kind: t.kind,
      cars,
      carLen: C.len,
      len,
      vmax: C.vmax * (0.85 + this.rand() * 0.15),
      a: C.a,
      b: C.b,
      stopsAtStations: t.kind !== 'rail' || this.rand() < 0.75,
      path: [{ t, dir }],
      hi: 0,
      s: Math.max(len + 1, Math.min(s, t.len)),
      v: 0,
      dwell: 0,
      lastStop: '',
      stuck: 0,
      dead: false,
      color: Math.floor(this.rand() * 1e6),
    }
    // si el tren no cabe en el tramo, hacia atrás por donde pueda
    tr.s = Math.min(t.len, Math.max(tr.s, Math.min(len + 1, t.len)))
    // ni encima de otro tren (vías muy juntas)
    const mine: CarBox[] = []
    this.carBoxes(tr, 0, mine)
    const others: CarBox[] = []
    for (const o of this.trains) if (!o.dead) this.carBoxes(o, 0, others)
    if (mine.some((m) => others.some((o) => boxHit(m, o)))) return null
    // ni encima de un coche (tranvías)
    const fb = this.boxBlocked
    if (fb && tr.kind === 'tram') {
      const wide: CarBox[] = []
      this.carBoxes(tr, 0, wide, true)
      if (wide.some((m) => fb(m.cx, m.cz, m.ux, m.uz, m.hl, m.hw, true))) return null
    }
    t.holder = tr
    tr.v = Math.min(tr.vmax, 12)
    this.trains.push(tr)
    return tr
  }

  step(dt: number): void {
    const net = this.net
    if (!net) return
    this.t += dt
    // red de seguridad física: las cajas de los coches de todos (a nivel)
    this.allBoxes = []
    for (const tr of this.trains) if (!tr.dead) this.carBoxes(tr, 0, this.allBoxes)
    for (const tr of this.trains) {
      if (tr.dead) continue
      this.extend(tr)
      const auth = this.authority(tr)
      // velocidad: la de la vía (curvas por delante), la autoridad (cantón libre) y la parada
      let target = tr.vmax
      const look = (tr.v * tr.v) / (2 * tr.b) + 60
      this.scanAhead(tr, look, (d, vlim) => {
        const allow = Math.sqrt(vlim * vlim + 2 * tr.b * 0.8 * Math.max(0, d))
        if (allow < target) target = allow
      })
      const tram = tr.kind === 'tram'
      let stopAt = Math.min(auth - (tram ? 6 : 15), this.nextStop(tr, look + 200), this.blockedCrossing(tr, look + 60) - (tram ? 3 : 12))
      // el tranvía, detrás de los coches que pisan su vía
      if (tram && this.occupied) stopAt = Math.min(stopAt, this.carAhead(tr, look) - 2.5)
      if (stopAt < Infinity) {
        const allow = Math.sqrt(2 * tr.b * 0.9 * Math.max(0, stopAt))
        if (allow < target) target = allow
      }
      if (tr.dwell > 0) {
        tr.dwell -= dt
        target = 0
      }
      const acc = target > tr.v ? tr.a : -Math.min(tr.b * 1.6, (tr.v - target) / Math.max(dt, 1e-3))
      const nv = Math.max(0, Math.min(target > tr.v ? target : tr.v, tr.v + acc * dt))
      let ds = ((tr.v + nv) / 2) * dt
      // nunca más allá de la autoridad
      if (ds > auth - 1) ds = Math.max(0, auth - 1)
      // ni pisando otro tren (cruces de vías muy juntas, agujas) ni, el tranvía, un coche que se le
      // ha metido delante sin dejarle frenar
      if (ds > 0 && (this.headHits(tr, ds) || this.headOnCar(tr, ds))) {
        ds = 0
        target = 0
        this.safetyStops++
        tr.v = 0
      }
      tr.v = ds === 0 && target === 0 ? 0 : nv
      tr.stuck = tr.v < 0.2 && tr.dwell <= 0 ? tr.stuck + dt : 0
      this.advance(tr, ds)
      // parada en estación: casi parado sobre ella
      if (tr.stopsAtStations && tr.dwell <= 0 && tr.v < 0.3) {
        const d = this.nextStop(tr, 30)
        if (d < 25) {
          const cur = tr.path[tr.hi]
          tr.lastStop = `${cur.t.id}:${Math.round(this.stopSNear(tr) ?? 0)}`
          tr.dwell = 25 + this.rand() * 25
        }
      }
      // vía muerta: da la vuelta
      if (tr.v < 0.2 && tr.dwell <= 0 && this.atDeadEnd(tr)) this.reverse(tr)
    }
    // fuera los que salen de la región o llevan mucho atascados lejos de la cámara
    let w = 0
    for (const tr of this.trains) {
      if (!tr.dead && tr.stuck > 120 && this.far(tr)) this.kill(tr)
      if (!tr.dead) this.trains[w++] = tr
    }
    this.trains.length = w
    this.spawn(dt)
  }

  /** paradas por la red de seguridad (pruebas) */
  safetyStops = 0
  private allBoxes: CarBox[] = []

  /** cajas de los coches a nivel de un tren adelantado `ahead` metros */
  private carBoxes(tr: Train, ahead: number, out: CarBox[], forCars = false): void {
    const F = { x: 0, z: 0, y: 0 }
    const R = { x: 0, z: 0, y: 0 }
    const gap = carGap(tr.kind)
    for (let k = 0; k < tr.cars; k++) {
      const f = k * (tr.carLen + gap) + 0.3 - ahead
      const w = this.where(tr, Math.max(0, f + tr.carLen / 2))
      if (w.tunnel || (w.bridge && tr.kind !== 'tram')) continue
      if (f < 0) {
        if (!this.pointAhead(tr, -f, F)) continue
      } else this.pointOf(tr, f, F)
      this.pointOf(tr, Math.max(0, f + tr.carLen - 0.6), R)
      let ux = F.x - R.x
      let uz = F.z - R.z
      const l = Math.hypot(ux, uz) || 1
      ux /= l
      uz /= l
      out.push({ tr, cx: (F.x + R.x) / 2, cz: (F.z + R.z) / 2, ux, uz, hl: tr.carLen / 2, hw: forCars ? carHalfWidth(tr.kind) : trainHalfWidth(tr.kind) })
    }
  }

  /** ¿algún coche del tren o del tranvía, adelantado `ds`, pisaría un vehículo de la calle? (el tren,
   * solo en un paso a nivel con alguien encima que no debía estar: ahí frena en seco) */
  private headOnCar(tr: Train, ds: number): boolean {
    const f = this.boxBlocked
    if (!f) return false
    // todos los módulos: en las curvas los de detrás barren hacia dentro
    const tram = tr.kind === 'tram'
    const mine: CarBox[] = []
    this.carBoxes(tr, ds, mine, true)
    const now: CarBox[] = []
    this.carBoxes(tr, 0, now, true)
    for (let k = 0; k < mine.length; k++) {
      const m = mine[k]
      if (!f(m.cx, m.cz, m.ux, m.uz, m.hl, m.hw, tram)) continue
      // si ya lo pisaba (aparecido encima), no se le bloquea por eso
      const n = now[k]
      if (n && f(n.cx, n.cz, n.ux, n.uz, n.hl, n.hw, tram)) continue
      return true
    }
    return false
  }

  /** ¿el primer coche, adelantado `ds`, pisaría un coche de otro tren? */
  private headHits(tr: Train, ds: number): boolean {
    const mine: CarBox[] = []
    this.carBoxes(tr, ds, mine)
    if (!mine.length) return false
    const now: CarBox[] = []
    this.carBoxes(tr, 0, now)
    const h = mine[0]
    const R = tr.len + 40
    for (const o of this.allBoxes) {
      if (o.tr === tr || o.tr.dead) continue
      if (Math.abs(o.cx - h.cx) > R || Math.abs(o.cz - h.cz) > R) continue
      // todos los coches (en las agujas y las curvas los de detrás barren de lado)
      for (let k = 0; k < mine.length; k++) {
        if (!boxHit(mine[k], o)) continue
        // ya se pisaban (aparecidos encima): no se le bloquea por eso
        if (now[k] && boxHit(now[k], o)) continue
        return true
      }
    }
    return false
  }

  private far(tr: Train): boolean {
    if (!this.camera) return true
    const p = { x: 0, z: 0, y: 0 }
    this.pointOf(tr, 0, p)
    return Math.hypot(p.x - this.camera.x, p.z - this.camera.z) > 800
  }

  private kill(tr: Train): void {
    tr.dead = true
    this.release(tr)
  }

  private release(tr: Train): void {
    for (const p of tr.path) {
      if (p.t.holder === tr) p.t.holder = null
      for (const n of [p.t.a, p.t.b]) if (n.holder === tr) n.holder = null
    }
  }

  /** Alarga el camino por delante (en los desvíos, preferiblemente recto y por su vía). */
  private extend(tr: Train): void {
    const want = (tr.v * tr.v) / (2 * tr.b) + 400
    let ahead = tr.path[tr.hi].t.len - tr.s
    for (let i = tr.hi + 1; i < tr.path.length; i++) ahead += tr.path[i].t.len
    let guard = 0
    while (ahead < want && guard++ < 20) {
      const last = tr.path[tr.path.length - 1]
      const opts = last.dir === 1 ? last.t.nextB : last.t.nextA
      // el metro y el tranvía, por sus vías; los trenes, por las de tren
      const usable = opts.filter((o) => o.t.kind === tr.kind || (tr.kind !== 'metro' && tr.kind !== 'tram' && o.t.kind !== 'metro' && o.t.kind !== 'tram'))
      if (usable.length === 0) break
      let total = 0
      const w = usable.map((o) => {
        let k = 1 / (0.05 + o.turn * 4)
        if (o.t.pref !== 0 && o.t.pref !== o.dir) k *= 0.1
        if (o.t.nextA.length + o.t.nextB.length === 0) k *= 0.2
        total += k
        return k
      })
      let r = this.rand() * total
      let pick = usable[usable.length - 1]
      for (let i = 0; i < usable.length; i++) {
        r -= w[i]
        if (r <= 0) {
          pick = usable[i]
          break
        }
      }
      tr.path.push({ t: pick.t, dir: pick.dir })
      ahead += pick.t.len
    }
    // fuera lo que ya ha quedado del todo detrás de la cola
    let behind = tr.s
    let cut = 0
    for (let i = tr.hi - 1; i >= 0; i--) {
      if (behind > tr.len + 5) {
        cut = i + 1
        break
      }
      behind += tr.path[i].t.len
    }
    if (cut > 0) {
      for (let i = 0; i < cut; i++) {
        if (tr.path[i].t.holder === tr && !this.coversLater(tr, tr.path[i].t, cut)) tr.path[i].t.holder = null
        // el nudo de salida de ese tramo ya ha quedado detrás de la cola
        const n = exitNode(tr.path[i])
        if (n.holder === tr) n.holder = null
      }
      tr.path.splice(0, cut)
      tr.hi -= cut
    }
  }

  private coversLater(tr: Train, t: Track, from: number): boolean {
    for (let i = from; i < tr.path.length; i++) if (tr.path[i].t === t) return true
    return false
  }

  /**
   * Metros libres por delante: hasta el final del último tramo reservado (reserva lo que pueda).
   * Si el siguiente lo tiene otro tren, hasta el piquete de libramiento (60 m antes del desvío: en
   * dos vías que se juntan con un desvío de ángulo cerrado, a 35 m aún se tocarían de lado).
   */
  private authority(tr: Train): number {
    let dist = tr.path[tr.hi].t.len - tr.s
    const need = (tr.v * tr.v) / (2 * tr.b) + 200
    // (el tranvía, con el piquete más cerca: desvíos de calle, de radio corto)
    const foul = tr.kind === 'tram' ? 25 : 60
    for (let i = tr.hi + 1; i < tr.path.length; i++) {
      const t = tr.path[i].t
      // el nudo por el que se entra: libre o ya suyo (en un cruce en diamante pasa uno solo)
      const node = exitNode(tr.path[i - 1])
      if (node.holder && node.holder !== tr) return dist - foul
      if (t.holder && t.holder !== tr) return dist - foul
      if (!t.holder) {
        if (dist > need) return dist
        t.holder = tr
      }
      node.holder = tr
      dist += t.len
    }
    // final del camino: vía muerta o frontera
    const last = tr.path[tr.path.length - 1]
    const end = last.dir === 1 ? last.t.b : last.t.a
    return end.frontier ? Infinity : dist
  }

  private scanAhead(tr: Train, look: number, f: (d: number, v: number) => void): void {
    let d = -tr.s
    for (let i = tr.hi; i < tr.path.length && d < look; i++) {
      const { t, dir } = tr.path[i]
      const n = t.x.length
      for (let q = 0; q < n; q++) {
        const sq = dir === 1 ? t.s[q] : t.len - t.s[n - 1 - q]
        const dd = d + sq
        if (dd < 0) continue
        if (dd > look) break
        f(dd, t.vmax[dir === 1 ? q : n - 1 - q])
      }
      d += t.len
    }
  }

  /** distancia al primer paso a nivel por delante con un vehículo encima (Infinity si no hay) */
  private blockedCrossing(tr: Train, look: number): number {
    let d = -tr.s
    for (let i = tr.hi; i < tr.path.length && d < look; i++) {
      const { t, dir } = tr.path[i]
      for (const c of t.crossings) {
        const at = dir === 1 ? c.ts : t.len - c.ts
        const dd = d + at
        if (dd < 2 || dd > look) continue
        const vehs = c.lane ? c.lane.vehs : c.move ? c.move.vehs : []
        for (const u of vehs) if (u.s > c.s0 - 0.5 && u.s - u.len < c.s1 + 0.5) return dd
      }
      d += t.len
    }
    return Infinity
  }

  /** distancia al primer coche que pisa la vía por delante (tranvías; Infinity si no hay) */
  private carAhead(tr: Train, look: number): number {
    const occ = this.occupied!
    const P = { x: 0, z: 0, y: 0 }
    const Q = { x: 0, z: 0, y: 0 }
    for (let d = 0.5; d < look; d += 2.5) {
      if (!this.pointAhead(tr, d, P)) break
      if (!this.pointAhead(tr, d + 1, Q)) this.pointOf(tr, 0, Q)
      const l = Math.hypot(Q.x - P.x, Q.z - P.z) || 1
      if (occ(P.x, P.z, 1.45, (Q.x - P.x) / l, (Q.z - P.z) / l)) return d
    }
    return Infinity
  }

  /** punto de la vía `d` metros por delante de la cabeza (false si el camino se acaba) */
  private pointAhead(tr: Train, d: number, out: { x: number; z: number; y: number }): boolean {
    let i = tr.hi
    let s = tr.s + d
    while (s > tr.path[i].t.len) {
      s -= tr.path[i].t.len
      i++
      if (i >= tr.path.length) return false
    }
    const { t, dir } = tr.path[i]
    const at = Math.max(0, Math.min(t.len, dir === 1 ? s : t.len - s))
    let lo = 0
    let hi = t.s.length - 1
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1
      if (t.s[m] <= at) lo = m
      else hi = m
    }
    const f = (at - t.s[lo]) / (t.s[hi] - t.s[lo] || 1)
    out.x = t.x[lo] + (t.x[hi] - t.x[lo]) * f
    out.z = t.z[lo] + (t.z[hi] - t.z[lo]) * f
    return true
  }

  /** distancia a la próxima parada de estación por delante (Infinity si no hay) */
  private nextStop(tr: Train, look: number): number {
    if (!tr.stopsAtStations) return Infinity
    let d = -tr.s
    for (let i = tr.hi; i < tr.path.length && d < look; i++) {
      const { t, dir } = tr.path[i]
      for (const st of t.stops) {
        const sq = dir === 1 ? st : t.len - st
        const dd = d + sq
        if (dd < -2) continue
        if (`${t.id}:${Math.round(st)}` === tr.lastStop) continue
        return Math.max(0, dd)
      }
      d += t.len
    }
    return Infinity
  }

  private stopSNear(tr: Train): number | null {
    const { t, dir } = tr.path[tr.hi]
    for (const st of t.stops) {
      const sq = dir === 1 ? st : t.len - st
      if (Math.abs(sq - tr.s) < 30) return st
    }
    return null
  }

  private advance(tr: Train, ds: number): void {
    tr.s += ds
    while (tr.s > tr.path[tr.hi].t.len) {
      if (tr.hi + 1 >= tr.path.length) {
        const last = tr.path[tr.hi]
        const end = last.dir === 1 ? last.t.b : last.t.a
        if (end.frontier) {
          this.kill(tr)
          return
        }
        tr.s = last.t.len
        tr.v = 0
        return
      }
      tr.s -= tr.path[tr.hi].t.len
      tr.hi++
    }
  }

  private atDeadEnd(tr: Train): boolean {
    if (tr.hi < tr.path.length - 1) return false
    const last = tr.path[tr.hi]
    const end = last.dir === 1 ? last.t.b : last.t.a
    const opts = last.dir === 1 ? last.t.nextB : last.t.nextA
    return !end.frontier && opts.length === 0 && last.t.len - tr.s < 25
  }

  /** Da la vuelta: la cola pasa a ser la cabeza. */
  private reverse(tr: Train): void {
    // tramos que cubre el tren, de la cabeza hacia atrás
    const cover: Array<{ t: Track; dir: 1 | -1 }> = []
    let back = tr.s
    cover.push(tr.path[tr.hi])
    for (let i = tr.hi - 1; i >= 0 && back < tr.len; i--) {
      cover.push(tr.path[i])
      back += tr.path[i].t.len
    }
    // de la cola al principio del tramo más atrasado (con el hueco de un coche: así las cajas de los
    // coches quedan donde estaban, sin pisar al que espera detrás)
    const tailS = Math.max(0, back - tr.len + carGap(tr.kind))
    // en el orden de la marcha nueva: detrás queda el tramo de la cabeza vieja; delante, el de la cola
    const rev = cover.map((p) => ({ t: p.t, dir: (p.dir === 1 ? -1 : 1) as 1 | -1 }))
    // liberar lo que ya no cubre (también los nudos: solo quedan los que hay entre sus tramos)
    for (const p of tr.path) {
      if (!cover.includes(p) && p.t.holder === tr) p.t.holder = null
      for (const n of [p.t.a, p.t.b]) if (n.holder === tr) n.holder = null
    }
    for (let i = 0; i + 1 < rev.length; i++) exitNode(rev[i]).holder = tr
    tr.path = rev
    tr.hi = rev.length - 1
    tr.s = rev[tr.hi].t.len - tailS
    tr.dwell = 40 + this.rand() * 40
    tr.lastStop = ''
  }

  private spawn(dt: number): void {
    const net = this.net!
    const rate = (0.9 / 600) * this.density * trafficHour(this.hour) // trenes por segundo y entrada
    for (const e of net.entries) {
      const key = `${e.t.id}:${e.dir}`
      // tranvías: uno cada ~5 min por entrada
      const acc = (this.spawnAcc.get(key) ?? this.rand()) + rate * (e.t.kind === 'tram' ? 2.2 : 1) * dt
      if (acc < 1) {
        this.spawnAcc.set(key, acc)
        continue
      }
      if (e.t.holder || (e.t.pref !== 0 && e.t.pref !== e.dir) || e.t.len < 60) {
        this.spawnAcc.set(key, 0.5)
        continue
      }
      this.spawnAcc.set(key, acc - 1)
      const C = CAR[e.t.kind]
      const tr = this.spawnOn(e.t, e.dir, C.len * C.cars[0] + 5)
      if (tr) tr.v = Math.min(tr.vmax, 20)
    }
  }

  /** ¿El paso a nivel está cerrado (un tren encima o a menos de ~25 s)? */
  crossingClosed(c: Crossing): boolean {
    const t = c.track
    const tr = t.holder
    if (!tr) {
      // también los que vienen por el tramo de al lado y aún no lo han reservado: con 25 s de margen
      return false
    }
    // posición del tren respecto al punto del paso
    for (let i = 0; i < tr.path.length; i++) {
      if (tr.path[i].t !== t) continue
      const dir = tr.path[i].dir
      const at = dir === 1 ? c.ts : t.len - c.ts
      let d = at - (i === tr.hi ? tr.s : 0)
      if (i > tr.hi) {
        d = at + (tr.path[tr.hi].t.len - tr.s)
        for (let k = tr.hi + 1; k < i; k++) d += tr.path[k].t.len
      } else if (i < tr.hi) {
        let behind = tr.s
        for (let k = tr.hi - 1; k > i; k--) behind += tr.path[k].t.len
        d = -(behind + (t.len - at))
      }
      // tranvía: solo cuando está llegando y en marcha (si espera detrás de un coche, que pase el
      // coche) y hasta que pase la cola
      if (t.kind === 'tram') {
        if (d >= 0) return d < 6 || (tr.v > 0.5 && d < Math.max(tr.v, 4) * 6 + 12)
        return -d < tr.len + 4
      }
      // delante: cerrado si llega en menos de 25 s; detrás: hasta que pase la cola
      if (d >= 0) return d < Math.max(tr.v, 8) * 25 + 30
      return -d < tr.len + 10
    }
    return true
  }

  /** Punto del eje de la vía a `back` metros por detrás de la cabeza (x, z, y). */
  pointOf(tr: Train, back: number, out: { x: number; z: number; y: number }): boolean {
    let i = tr.hi
    let s = tr.s - back
    while (s < 0 && i > 0) {
      i--
      s += tr.path[i].t.len
    }
    const { t, dir } = tr.path[i]
    const at = Math.max(0, Math.min(t.len, dir === 1 ? s : t.len - s))
    const n = t.s.length
    let lo = 0
    let hi = n - 1
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1
      if (t.s[m] <= at) lo = m
      else hi = m
    }
    const f = (at - t.s[lo]) / (t.s[hi] - t.s[lo] || 1)
    out.x = t.x[lo] + (t.x[hi] - t.x[lo]) * f
    out.z = t.z[lo] + (t.z[hi] - t.z[lo]) * f
    out.y = t.y[lo] + (t.y[hi] - t.y[lo]) * f
    return true
  }

  /** ¿Ese punto del tren va por un túnel o por un puente? */
  where(tr: Train, back: number): { tunnel: boolean; bridge: boolean } {
    let i = tr.hi
    let s = tr.s - back
    while (s < 0 && i > 0) {
      i--
      s += tr.path[i].t.len
    }
    const { t, dir } = tr.path[i]
    const at = Math.max(0, Math.min(t.len, dir === 1 ? s : t.len - s))
    let lo = 0
    let hi = t.s.length - 1
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1
      if (t.s[m] <= at) lo = m
      else hi = m
    }
    const b = t.bri[Math.min(lo, t.bri.length - 1)]
    return { tunnel: b === -1, bridge: b === 1 }
  }

  /**
   * Cambia a una red nueva: cada tren sigue en el tramo de la red nueva que pasa por su cabeza en
   * su sentido (los que no encuentran sitio se quitan).
   */
  adopt(net: RailNet, map: (x: number, z: number, out: { x: number; z: number }) => void): void {
    const old = this.trains.slice()
    for (const tr of old) this.release(tr)
    this.trains.length = 0
    this.net = net
    const P = { x: 0, z: 0, y: 0 }
    const Q = { x: 0, z: 0, y: 0 }
    for (const tr of old) {
      if (tr.dead) continue
      this.pointOf(tr, 0, P)
      this.pointOf(tr, 5, Q)
      const f = { x: 0, z: 0 }
      const b = { x: 0, z: 0 }
      map(P.x, P.z, f)
      map(Q.x, Q.z, b)
      let best: { t: Track; s: number; dir: 1 | -1; d: number } | null = null
      for (const t of net.tracks) {
        if (t.kind !== tr.kind) continue
        const n = nearestOnTrack(t, f.x, f.z)
        if (n.d > 2 || (best && n.d >= best.d)) continue
        const nb = nearestOnTrack(t, b.x, b.z)
        const dir: 1 | -1 = n.s >= nb.s ? 1 : -1
        best = { t, s: dir === 1 ? n.s : t.len - n.s, dir, d: n.d }
      }
      if (!best || best.t.holder) continue
      tr.path = [{ t: best.t, dir: best.dir }]
      tr.hi = 0
      tr.s = best.s
      best.t.holder = tr
      this.trains.push(tr)
    }
  }
}

/** trenes relativos a la hora punta (servicio reducido de noche) */
function trafficHour(h: number): number {
  const hh = ((h % 24) + 24) % 24
  if (hh < 5) return 0.1
  if (hh < 6.5) return 0.5
  if (hh < 23) return 1
  return 0.4
}
