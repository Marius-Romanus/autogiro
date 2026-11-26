// Red de puentes de OpenStreetMap: las líneas `brunnel=bridge` de la capa `transportation` de
// las teselas vectoriales z14 de OpenFreeMap (las mismas que usan edificios, árboles y pistas),
// recortadas a su tesela y unidas en un grafo por sus extremos, también de una tesela a otra.
//
// Las teselas no traen la altura del tablero. Aquí se deduce del terreno: los extremos donde el
// puente vuelve al suelo («terminales») están a la altura del relieve, y cualquier otro punto, a
// la media de las alturas de los terminales cercanos ponderada con el inverso de la distancia
// por el grafo (con dos terminales es una recta de estribo a estribo; en un enlace con ramales
// es una mezcla suave). Es una regla local: lo que calcula una tesela para un punto compartido
// con la vecina sale idéntico en las dos, y un viaducto de decenas de kilómetros no obliga a
// cargarlo entero (lejos de todo terminal el tablero sigue al terreno a una altura fija).
//
// Sin three.js ni DOM: también lo usa tools/bridge-info.ts desde Node.

import type { VectorTile } from '@mapbox/vector-tile'
import { fetchVectorTile, latToY, lonToX, xToLon, yToLat, Z } from './mapTiles.ts'

const N = 2 ** Z
/** unidades por tesela (la `extent` de OpenMapTiles) */
export const E = 4096
/** alcance (m por el grafo) de un terminal sobre la altura del tablero */
export const D_MAX = 1500
/** hasta dónde (m, en cada sentido) se sigue una cadena de tramos para tomarla entera */
export const CHAIN_MAX = 6000
/** hasta dónde (m por el grafo) se carga la red alrededor de una tesela */
const REACH = CHAIN_MAX + D_MAX
/** tolerancia (unidades) al casar los cortes de una línea en el borde de dos teselas */
const BORDER_TOL = 3

export type BridgeKind = 'road' | 'path' | 'rail'

export interface BridgeNode {
  id: number
  /** posición en unidades globales z14 (tesela × E + posición en la tesela) */
  gx: number
  gy: number
  /** tramos que llegan (uno con los dos extremos aquí aparece dos veces) */
  pieces: BridgePiece[]
  /** en el borde entre dos teselas: claves de las dos */
  tiles: [number, number] | null
}

export interface BridgePiece {
  id: number
  tile: number
  cls: string
  kind: BridgeKind
  /** ancho del tablero (m) */
  width: number
  layer: number
  oneway: boolean
  /** vértices en unidades globales */
  gx: Float64Array
  gy: Float64Array
  /** distancia acumulada (m) en cada vértice */
  s: Float64Array
  len: number
  a: BridgeNode
  b: BridgeNode
}

/** Vía a nivel del suelo (para no plantar pilas en mitad de una calzada o de una vía). */
export interface GroundWay {
  gx: Float64Array
  gy: Float64Array
  hw: number
}

/** Edificio alto de la tesela (las torres de algunos puentes están modeladas como edificios en OSM). */
export interface TallBuilding {
  gx: number
  gy: number
  /** altura sobre el suelo (m) */
  h: number
}

interface NetTile {
  key: number
  x: number
  y: number
  state: 'loading' | 'ok' | 'failed'
  /** cuándo falló (performance.now): pasado un rato se vuelve a pedir */
  failedAt?: number
  promise: Promise<void>
  pieces: BridgePiece[]
  ground: GroundWay[]
  tall: TallBuilding[]
  /** rejilla 16×16 de las vías del suelo (índices) */
  groundGrid: Map<number, number[]> | null
}

export function tileKey(x: number, y: number): number {
  return y * N + x
}

/** metros por unidad global a la altura de gy */
export function metresPerUnit(gy: number): number {
  const lat = yToLat(gy / E, N)
  return (40075016.7 * Math.cos((lat * Math.PI) / 180)) / N / E
}

export function unitToGeo(gx: number, gy: number): [number, number] {
  return [yToLat(gy / E, N), xToLon(gx / E, N)]
}

export function geoToUnit(lat: number, lon: number): [number, number] {
  return [lonToX(lon, N) * E, latToY(lat, N) * E]
}

/** Ancho del tablero (m) según la clase de vía; 0 = no se dibuja. */
function widthOf(cls: string, sub: string, oneway: boolean, ramp: boolean): { kind: BridgeKind; width: number } | null {
  switch (cls) {
    case 'motorway':
      return { kind: 'road', width: ramp ? 7.5 : oneway ? 11.5 : 22 }
    case 'trunk':
      return { kind: 'road', width: ramp ? 7 : oneway ? 10.5 : 14 }
    case 'primary':
      return { kind: 'road', width: ramp ? 6.5 : oneway ? 8.5 : 11 }
    case 'secondary':
      return { kind: 'road', width: oneway ? 7.5 : 10 }
    case 'tertiary':
      return { kind: 'road', width: oneway ? 6.5 : 9 }
    case 'minor':
      return { kind: 'road', width: oneway ? 5.5 : 7 }
    case 'busway':
      return { kind: 'road', width: 7 }
    case 'raceway':
      return { kind: 'road', width: 10 }
    case 'service':
      return { kind: 'road', width: 4.5 }
    case 'track':
      return { kind: 'road', width: 3.5 }
    case 'path':
      if (sub === 'steps' || sub === 'platform') return null
      return { kind: 'path', width: sub === 'pedestrian' ? 5 : sub === 'cycleway' ? 3 : 2.5 }
    case 'rail':
      // vía doble = dos líneas a ~4 m: tableros que casi se tocan, sin montarse
      return { kind: 'rail', width: sub === 'narrow_gauge' || sub === 'funicular' ? 3.2 : 3.9 }
    case 'transit':
      return { kind: 'rail', width: sub === 'monorail' ? 2.2 : 3.6 }
    default:
      return null
  }
}

const GROUND_HW: Record<string, number> = {
  motorway: 7,
  trunk: 6.5,
  primary: 6,
  secondary: 5,
  tertiary: 4.5,
  minor: 3.5,
  service: 2.5,
  rail: 3,
  transit: 2.5,
  busway: 3.5,
}

type Pt = { x: number; y: number }

/** Recorta una polilínea a la tesela [0, E]²; devuelve los trozos que quedan dentro. */
function clipLine(line: Pt[]): Array<Array<[number, number]>> {
  const out: Array<Array<[number, number]>> = []
  let cur: Array<[number, number]> | null = null
  for (let i = 1; i < line.length; i++) {
    const x0 = line[i - 1].x
    const y0 = line[i - 1].y
    const dx = line[i].x - x0
    const dy = line[i].y - y0
    // Liang–Barsky
    let t0 = 0
    let t1 = 1
    let ok = true
    for (const [p, q] of [
      [-dx, x0],
      [dx, E - x0],
      [-dy, y0],
      [dy, E - y0],
    ]) {
      if (p === 0) {
        if (q < 0) ok = false
      } else {
        const r = q / p
        if (p < 0) t0 = Math.max(t0, r)
        else t1 = Math.min(t1, r)
      }
    }
    if (!ok || t0 > t1 || (dx === 0 && dy === 0)) {
      cur = null
      continue
    }
    const a: [number, number] = [x0 + dx * t0, y0 + dy * t0]
    const b: [number, number] = [x0 + dx * t1, y0 + dy * t1]
    if (a[0] === b[0] && a[1] === b[1]) {
      if (t1 < 1) cur = null
      continue
    }
    if (!cur || t0 > 0) {
      cur = [a]
      out.push(cur)
    }
    cur.push(b)
    if (t1 < 1) cur = null
  }
  return out.filter((l) => l.length >= 2)
}

/** identificadores de tramos y nodos: únicos en toda la sesión (Bridges.ts renueva la red en vuelos largos) */
let nextId = 1

const onBorder = (p: [number, number]) => p[0] === 0 || p[0] === E || p[1] === 0 || p[1] === E

export class BridgeNet {
  private readonly tiles = new Map<number, NetTile>()
  private readonly interior = new Map<string, BridgeNode>()
  /** nodos de borde por línea de borde: «v<gx>» o «h<gy>» */
  private readonly borders = new Map<string, BridgeNode[]>()
  private readonly abort = new AbortController()
  private readonly fetchTile: (x: number, y: number, signal: AbortSignal) => Promise<VectorTile>
  /** terminales al alcance de cada nodo (vale mientras la red de alrededor esté cargada) */
  private readonly near = new Map<BridgeNode, Array<{ node: BridgeNode; d: number }>>()

  constructor(fetchTile: (x: number, y: number, signal: AbortSignal) => Promise<VectorTile> = fetchVectorTile) {
    this.fetchTile = fetchTile
  }

  dispose(): void {
    this.abort.abort()
    this.tiles.clear()
    this.interior.clear()
    this.borders.clear()
    this.near.clear()
  }

  get tileCount(): number {
    return this.tiles.size
  }

  /** ¿Falló hace más de 10 s? (un corte de red: se puede volver a pedir) */
  private stale(t: NetTile | undefined): boolean {
    return t?.state === 'failed' && performance.now() - (t.failedAt ?? 0) > 10000
  }

  /** Carga los puentes de una tesela (una vez; si falló, otra vez pasado un rato). */
  ensure(x: number, y: number): Promise<void> {
    const key = tileKey(x, y)
    let t = this.tiles.get(key)
    if (t && !this.stale(t)) return t.promise
    t = { key, x, y, state: 'loading', promise: Promise.resolve(), pieces: [], ground: [], tall: [], groundGrid: null }
    const tile = t
    tile.promise = this.fetchTile(x, y, this.abort.signal)
      .then((vt) => {
        this.addTile(tile, vt)
        tile.state = 'ok'
      })
      .catch(() => {
        tile.state = 'failed'
        tile.failedAt = performance.now()
      })
      .then(() => {
        // con esta tesela pueden aparecer terminales nuevos al alcance de nodos ya calculados
        this.near.clear()
      })
    this.tiles.set(key, tile)
    return tile.promise
  }

  loaded(x: number, y: number): boolean {
    const t = this.tiles.get(tileKey(x, y))
    return t !== undefined && t.state !== 'loading'
  }

  piecesOf(x: number, y: number): BridgePiece[] {
    return this.tiles.get(tileKey(x, y))?.pieces ?? []
  }

  /**
   * Carga la red de alrededor: todo lo que queda a menos de REACH metros (por el grafo) de los
   * puentes de la tesela. Tras esto, las alturas y las cadenas de sus tramos no dependen de qué
   * más haya cargado.
   */
  async close(x: number, y: number): Promise<void> {
    await this.ensure(x, y)
    // sin su propia tesela no se sabe si tiene puentes: que la capa la vuelva a intentar (TileLayer)
    if (this.tiles.get(tileKey(x, y))?.state === 'failed' && !this.abort.signal.aborted) throw new Error('sin la tesela vectorial')
    for (let round = 0; round < 12; round++) {
      const src = new Set<BridgeNode>()
      for (const p of this.piecesOf(x, y)) {
        src.add(p.a)
        src.add(p.b)
      }
      if (src.size === 0) return
      const dist = this.dijkstra([...src], REACH)
      const want = new Map<number, [number, number]>()
      for (const n of dist.keys()) {
        if (!n.tiles || n.pieces.length !== 1) continue
        for (const k of n.tiles) if (!this.tiles.has(k) || this.stale(this.tiles.get(k))) want.set(k, [k % N, Math.floor(k / N)])
      }
      // las que ya se están cargando (por otra tesela) también hay que esperarlas
      const busy: Array<Promise<void>> = []
      for (const n of dist.keys()) {
        if (!n.tiles) continue
        for (const k of n.tiles) {
          const t = this.tiles.get(k)
          if (t?.state === 'loading') busy.push(t.promise)
        }
      }
      if (want.size === 0 && busy.length === 0) return
      await Promise.all([...busy, ...[...want.values()].map(([tx, ty]) => this.ensure(tx, ty))])
      if (this.abort.signal.aborted) return
    }
  }

  /** ¿El puente sigue por una tesela que aún no está cargada? */
  isOpen(n: BridgeNode): boolean {
    if (!n.tiles || n.pieces.length !== 1) return false
    for (const k of n.tiles) {
      const t = this.tiles.get(k)
      if (!t || t.state === 'loading') return true
    }
    return false
  }

  /** Extremo donde el puente vuelve al suelo. */
  isTerminal(n: BridgeNode): boolean {
    return n.pieces.length === 1 && !this.isOpen(n)
  }

  /** Distancias (m por el grafo) desde unos nodos, hasta maxDist. */
  dijkstra(sources: BridgeNode[], maxDist: number): Map<BridgeNode, number> {
    const dist = new Map<BridgeNode, number>()
    const heap = new Heap()
    for (const s of sources) {
      dist.set(s, 0)
      heap.push(0, s)
    }
    for (;;) {
      const top = heap.pop()
      if (!top) break
      const [d, n] = top
      if (d > (dist.get(n) ?? Infinity)) continue
      for (const p of n.pieces) {
        const o = p.a === n ? p.b : p.a
        const nd = d + p.len
        if (nd > maxDist || nd >= (dist.get(o) ?? Infinity)) continue
        dist.set(o, nd)
        heap.push(nd, o)
      }
    }
    return dist
  }

  /** Terminales a menos de D_MAX (por el grafo) de un nodo, con su distancia. */
  terminalsNear(n: BridgeNode): Array<{ node: BridgeNode; d: number }> {
    let list = this.near.get(n)
    if (list) return list
    list = []
    for (const [o, d] of this.dijkstra([n], D_MAX)) if (this.isTerminal(o)) list.push({ node: o, d })
    this.near.set(n, list)
    return list
  }

  /**
   * La cadena a la que pertenece un tramo: los tramos seguidos (nodos de dos tramos) hasta un
   * terminal o un cruce, en un orden que no depende del tramo de partida. `rev` = el tramo se
   * recorre de b a a. Si en algún sentido pasa de CHAIN_MAX (viaductos de muchos kilómetros), la
   * cadena es solo el tramo (`closed` = false): así no depende de por dónde se empiece.
   */
  chainOf(piece: BridgePiece): { parts: Array<{ piece: BridgePiece; rev: boolean; s0: number }>; len: number; closed: boolean } {
    const walk = (from: BridgeNode, first: BridgePiece): { list: Array<{ piece: BridgePiece; rev: boolean }>; end: BridgeNode; len: number; cut: boolean } => {
      // avanza desde `from` (un extremo de `first`) alejándose de `first`
      const list: Array<{ piece: BridgePiece; rev: boolean }> = []
      let node = from
      let prev = first
      let len = 0
      for (;;) {
        if (node.pieces.length !== 2) return { list, end: node, len, cut: false }
        const next = node.pieces[0] === prev ? node.pieces[1] : node.pieces[0]
        if (next === prev || next === first) return { list, end: node, len, cut: false } // anillo
        if (len + next.len > CHAIN_MAX) return { list, end: node, len, cut: true }
        const rev = next.b === node
        list.push({ piece: next, rev })
        len += next.len
        node = rev ? next.a : next.b
        prev = next
      }
    }
    const fwd = walk(piece.b, piece)
    const back = walk(piece.a, piece)
    if (fwd.cut || back.cut) return { parts: [{ piece, rev: false, s0: 0 }], len: piece.len, closed: false }
    // sentido canónico: del extremo de menor posición al otro
    const e0 = back.end
    const e1 = fwd.end
    const flip = e0.gx > e1.gx || (e0.gx === e1.gx && e0.gy > e1.gy)
    const seq: Array<{ piece: BridgePiece; rev: boolean }> = [
      ...back.list.reverse().map((q) => ({ piece: q.piece, rev: !q.rev })),
      { piece, rev: false },
      ...fwd.list,
    ]
    if (flip) {
      seq.reverse()
      for (const q of seq) q.rev = !q.rev
    }
    let s = 0
    const parts = seq.map((q) => {
      const o = { piece: q.piece, rev: q.rev, s0: s }
      s += q.piece.len
      return o
    })
    return { parts, len: s, closed: !this.isOpen(e0) && !this.isOpen(e1) }
  }

  /** Tramos de puente con algún vértice o punto a menos de `radius` metros de (gx, gy), con su distancia. */
  piecesNear(gx: number, gy: number, radius: number): Array<{ piece: BridgePiece; d: number; index: number; t: number }> {
    const mpu = metresPerUnit(gy)
    const r = radius / mpu
    const out: Array<{ piece: BridgePiece; d: number; index: number; t: number }> = []
    for (let ty = Math.floor((gy - r) / E); ty <= Math.floor((gy + r) / E); ty++) {
      for (let tx = Math.floor((gx - r) / E); tx <= Math.floor((gx + r) / E); tx++) {
        const t = this.tiles.get(tileKey(tx, ty))
        if (!t) continue
        for (const p of t.pieces) {
          let best = Infinity
          let bi = 0
          let bt = 0
          for (let k = 1; k < p.gx.length; k++) {
            const ax = p.gx[k - 1]
            const ay = p.gy[k - 1]
            const dx = p.gx[k] - ax
            const dy = p.gy[k] - ay
            const l2 = dx * dx + dy * dy
            const f = l2 > 0 ? Math.min(1, Math.max(0, ((gx - ax) * dx + (gy - ay) * dy) / l2)) : 0
            const d = Math.hypot(gx - ax - dx * f, gy - ay - dy * f)
            if (d < best) {
              best = d
              bi = k - 1
              bt = f
            }
          }
          if (best <= r) out.push({ piece: p, d: best * mpu, index: bi, t: bt })
        }
      }
    }
    return out
  }

  /** Edificios de 25 m o más dentro de un rectángulo (unidades globales), de las teselas cargadas. */
  tallIn(gx0: number, gy0: number, gx1: number, gy1: number): TallBuilding[] {
    const out: TallBuilding[] = []
    for (let ty = Math.floor(gy0 / E); ty <= Math.floor(gy1 / E); ty++) {
      for (let tx = Math.floor(gx0 / E); tx <= Math.floor(gx1 / E); tx++) {
        const t = this.tiles.get(tileKey(tx, ty))
        if (!t) continue
        for (const b of t.tall) if (b.gx >= gx0 && b.gx <= gx1 && b.gy >= gy0 && b.gy <= gy1) out.push(b)
      }
    }
    return out
  }

  /**
   * Calzadas y vías a nivel del suelo que empiezan o acaban a menos de r metros del punto
   * (unidades globales): la continuación de un puente en su extremo. Cada una orientada desde ese
   * extremo hacia fuera.
   */
  groundWaysFrom(gx: number, gy: number, r: number): Array<{ gx: Float64Array; gy: Float64Array }> {
    const t = this.tiles.get(tileKey(Math.floor(gx / E), Math.floor(gy / E)))
    if (!t) return []
    const lim = r / metresPerUnit(gy)
    const out: Array<{ gx: Float64Array; gy: Float64Array }> = []
    for (const w of t.ground) {
      const m = w.gx.length - 1
      if (Math.hypot(w.gx[0] - gx, w.gy[0] - gy) < lim) out.push({ gx: w.gx, gy: w.gy })
      else if (Math.hypot(w.gx[m] - gx, w.gy[m] - gy) < lim) out.push({ gx: w.gx.slice().reverse(), gy: w.gy.slice().reverse() })
    }
    return out
  }

  /**
   * ¿Hay una calzada o una vía a nivel del suelo en este punto (unidades globales)? Con `skip`,
   * sin contar las que conectan con el extremo de un puente en (skip.gx, skip.gy): las que
   * empiezan o acaban a menos de skip.r metros o pasan a menos de skip.through metros de él (la
   * simplificación de las teselas aparta a veces unos metros los extremos de las calles de un cruce).
   */
  onGroundWay(gx: number, gy: number, margin: number, skip?: { gx: number; gy: number; r: number; through?: number }): boolean {
    const t = this.tiles.get(tileKey(Math.floor(gx / E), Math.floor(gy / E)))
    if (!t || t.ground.length === 0) return false
    if (!t.groundGrid) {
      t.groundGrid = new Map()
      const cell = E / 16
      t.ground.forEach((w, i) => {
        const seen = new Set<number>()
        for (let k = 1; k < w.gx.length; k++) {
          const c0x = Math.floor((Math.min(w.gx[k - 1], w.gx[k]) - t.x * E) / cell - 0.1)
          const c1x = Math.floor((Math.max(w.gx[k - 1], w.gx[k]) - t.x * E) / cell + 0.1)
          const c0y = Math.floor((Math.min(w.gy[k - 1], w.gy[k]) - t.y * E) / cell - 0.1)
          const c1y = Math.floor((Math.max(w.gy[k - 1], w.gy[k]) - t.y * E) / cell + 0.1)
          for (let cy = c0y; cy <= c1y; cy++) for (let cx = c0x; cx <= c1x; cx++) seen.add(cy * 64 + cx)
        }
        for (const c of seen) {
          const l = t.groundGrid!.get(c)
          if (l) l.push(i)
          else t.groundGrid!.set(c, [i])
        }
      })
    }
    const cell = E / 16
    const list = t.groundGrid.get(Math.floor((gy - t.y * E) / cell) * 64 + Math.floor((gx - t.x * E) / cell))
    if (!list) return false
    const mpu = metresPerUnit(gy)
    const skipR = skip ? skip.r / mpu : 0
    for (const i of list) {
      const w = t.ground[i]
      if (skip) {
        const m = w.gx.length - 1
        if (Math.hypot(w.gx[0] - skip.gx, w.gy[0] - skip.gy) < skipR || Math.hypot(w.gx[m] - skip.gx, w.gy[m] - skip.gy) < skipR) continue
        if (skip.through) {
          const lim = skip.through / mpu
          let touches = false
          for (let k = 1; k < w.gx.length && !touches; k++) touches = distToSegment(skip.gx, skip.gy, w.gx[k - 1], w.gy[k - 1], w.gx[k], w.gy[k]) < lim
          if (touches) continue
        }
      }
      const lim = (w.hw + margin) / mpu
      for (let k = 1; k < w.gx.length; k++) {
        if (distToSegment(gx, gy, w.gx[k - 1], w.gy[k - 1], w.gx[k], w.gy[k]) < lim) return true
      }
    }
    return false
  }

  // -------------------------------------------------------------------------

  private addTile(t: NetTile, vt: VectorTile): void {
    const layer = vt.layers.transportation
    if (!layer) return
    // edificios altos (por si son las torres de un puente): centro de su huella y altura
    const bl = vt.layers.building
    for (let i = 0; bl && i < bl.length; i++) {
      const f = bl.feature(i)
      const h = Number(f.properties.render_height ?? 0)
      if (f.type !== 3 || !(h >= 25)) continue
      const ring = (f.loadGeometry() as Pt[][])[0]
      if (!ring || ring.length < 3) continue
      let x = 0
      let y = 0
      for (const q of ring) {
        x += q.x
        y += q.y
      }
      const kb = E / bl.extent
      t.tall.push({ gx: t.x * E + (x / ring.length) * kb, gy: t.y * E + (y / ring.length) * kb, h })
    }
    const k = E / layer.extent
    type Raw = { pts: Array<[number, number]>; cls: string; kind: BridgeKind; width: number; layer: number; oneway: boolean }
    const raws: Raw[] = []
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i)
      if (f.type !== 2) continue
      const p = f.properties as Record<string, unknown>
      const cls = String(p.class ?? '')
      if (p.brunnel !== 'bridge') {
        // vías del suelo (ni puente ni túnel): estorbos para las pilas
        const hw = p.brunnel === undefined ? GROUND_HW[cls] : undefined
        if (hw) {
          for (const line of f.loadGeometry() as Pt[][]) {
            if (line.length < 2) continue
            const gx = new Float64Array(line.length)
            const gy = new Float64Array(line.length)
            line.forEach((q, j) => {
              gx[j] = t.x * E + q.x * k
              gy[j] = t.y * E + q.y * k
            })
            t.ground.push({ gx, gy, hw })
          }
        }
        continue
      }
      const oneway = Number(p.oneway ?? 0) !== 0
      const w = widthOf(cls, String(p.subclass ?? ''), oneway, Number(p.ramp ?? 0) === 1)
      if (!w) continue
      for (const line of f.loadGeometry() as Pt[][]) {
        const scaled = k === 1 ? line : line.map((q) => ({ x: q.x * k, y: q.y * k }))
        for (const part of clipLine(scaled)) {
          // sin vértices repetidos
          const pts = part.filter((q, j) => j === 0 || q[0] !== part[j - 1][0] || q[1] !== part[j - 1][1])
          if (pts.length >= 2) raws.push({ pts, cls, kind: w.kind, width: w.width, layer: Number(p.layer ?? 0) || 0, oneway })
        }
      }
    }
    if (raws.length === 0) return

    // cortar cada línea en los vértices donde empieza o acaba otra (ramal que sale de un tablero)
    // o que comparte con otra (cruce): OpenMapTiles funde las líneas sin partirlas en los cruces
    const ends = new Set<string>()
    const seenBy = new Map<string, number>()
    const vk = (q: [number, number]) => `${q[0]},${q[1]}`
    raws.forEach((r, ri) => {
      ends.add(vk(r.pts[0]))
      ends.add(vk(r.pts[r.pts.length - 1]))
      for (let j = 1; j < r.pts.length - 1; j++) {
        const key = vk(r.pts[j])
        const other = seenBy.get(key)
        if (other !== undefined && other !== ri) ends.add(key)
        else seenBy.set(key, ri)
      }
    })
    for (const r of raws) {
      let start = 0
      for (let j = 1; j < r.pts.length; j++) {
        if (j < r.pts.length - 1 && !ends.has(vk(r.pts[j]))) continue
        this.addPiece(t, r.pts.slice(start, j + 1), r)
        start = j
      }
    }
  }

  private addPiece(
    t: NetTile,
    pts: Array<[number, number]>,
    r: { cls: string; kind: BridgeKind; width: number; layer: number; oneway: boolean },
  ): void {
    const n = pts.length
    const gx = new Float64Array(n)
    const gy = new Float64Array(n)
    const s = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      gx[i] = t.x * E + pts[i][0]
      gy[i] = t.y * E + pts[i][1]
      if (i > 0) s[i] = s[i - 1] + Math.hypot(gx[i] - gx[i - 1], gy[i] - gy[i - 1]) * metresPerUnit((gy[i] + gy[i - 1]) / 2)
    }
    if (s[n - 1] < 0.05) return
    const piece: BridgePiece = {
      id: nextId++,
      tile: t.key,
      cls: r.cls,
      kind: r.kind,
      width: r.width,
      layer: r.layer,
      oneway: r.oneway,
      gx,
      gy,
      s,
      len: s[n - 1],
      a: this.node(t, pts[0]),
      b: this.node(t, pts[n - 1]),
    }
    piece.a.pieces.push(piece)
    piece.b.pieces.push(piece)
    t.pieces.push(piece)
  }

  private node(t: NetTile, p: [number, number]): BridgeNode {
    const gx = t.x * E + p[0]
    const gy = t.y * E + p[1]
    if (!onBorder(p)) {
      const key = `${gx},${gy}`
      let n = this.interior.get(key)
      if (!n) {
        n = { id: nextId++, gx, gy, pieces: [], tiles: null }
        this.interior.set(key, n)
      }
      return n
    }
    // en el borde: el mismo corte visto desde la tesela vecina difiere en alguna unidad
    const vertical = p[0] === 0 || p[0] === E
    const lineKey = vertical ? `v${gx}` : `h${gy}`
    const along = vertical ? gy : gx
    let list = this.borders.get(lineKey)
    if (!list) {
      list = []
      this.borders.set(lineKey, list)
    }
    let best: BridgeNode | null = null
    let bestD = BORDER_TOL
    for (const n of list) {
      const d = Math.abs((vertical ? n.gy : n.gx) - along)
      if (d <= bestD) {
        bestD = d
        best = n
      }
    }
    if (best) return best
    const other = vertical ? tileKey(p[0] === 0 ? t.x - 1 : t.x + 1, t.y) : tileKey(t.x, p[1] === 0 ? t.y - 1 : t.y + 1)
    const n: BridgeNode = { id: nextId++, gx, gy, pieces: [], tiles: [t.key, other] }
    list.push(n)
    return n
  }
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const l2 = dx * dx + dy * dy
  const t = l2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0
  return Math.hypot(px - ax - dx * t, py - ay - dy * t)
}

/** Montículo binario mínimo (distancia, nodo). */
class Heap {
  private readonly d: number[] = []
  private readonly v: BridgeNode[] = []
  push(d: number, v: BridgeNode): void {
    let i = this.d.length
    this.d.push(d)
    this.v.push(v)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.d[p] <= this.d[i]) break
      ;[this.d[p], this.d[i]] = [this.d[i], this.d[p]]
      ;[this.v[p], this.v[i]] = [this.v[i], this.v[p]]
      i = p
    }
  }
  pop(): [number, BridgeNode] | null {
    const n = this.d.length
    if (n === 0) return null
    const top: [number, BridgeNode] = [this.d[0], this.v[0]]
    const ld = this.d.pop()!
    const lv = this.v.pop()!
    if (n > 1) {
      this.d[0] = ld
      this.v[0] = lv
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < n - 1 && this.d[l] < this.d[m]) m = l
        if (r < n - 1 && this.d[r] < this.d[m]) m = r
        if (m === i) break
        ;[this.d[m], this.d[i]] = [this.d[i], this.d[m]]
        ;[this.v[m], this.v[i]] = [this.v[i], this.v[m]]
        i = m
      }
    }
    return top
  }
}
