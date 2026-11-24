// Red de tráfico de una región (un cuadrado de teselas z14 alrededor de la cámara): calles unidas
// por cruces, carriles con su sentido y, en cada cruce, los movimientos posibles (de qué carril a
// qué carril se puede pasar), los puntos donde dos movimientos se cruzan o se juntan y quién cede.
//
// - Las calles se unen por sus vértices comunes (roads.ts repara los que la tesela simplificó) y,
//   de una tesela a otra, por los cortes en el borde. Los extremos que dan a una tesela que no está
//   en la región son la «frontera»: por ahí entran y salen los coches.
// - Carriles: las teselas no los traen; se deducen de la clase de vía y del sentido único, igual
//   que las marcas viales de los puentes (Bridges.ts), para que los coches vayan por ellas.
// - Cruces: cada calle se recorta donde empieza a pisar la calzada de las otras (`setback`); los
//   nudos unidos por tramos más cortos que eso (autovías desdobladas, enlaces apretados) y las
//   rotondas pequeñas forman un solo cruce. Rotondas: anillos de sentido único casi circulares
//   que giran en el sentido de la circulación.
// - Prioridad: la calle principal (clase y continuidad) no cede; en cruces de iguales, prioridad
//   a la derecha (a la izquierda donde se circula por la izquierda); quien gira a la izquierda
//   cede al que viene de frente; en las rotondas, quien está dentro. En cruces urbanos de calles
//   de cierta entidad hay semáforos (fases por ejes).
//
// Sin three.js ni DOM: la usa el worker de tráfico y las pruebas de Node.

import { xToLon, yToLat } from '../world/mapTiles.ts'
import { E, RANK, type RoadClass, type RoadLine, type RoadTile } from './roads.ts'
import type { Veh } from './sim.ts'
import type { Crossing } from './rail.ts'

const NZ = 2 ** 14
const BORDER_TOL = 3
/** separación máxima (m) entre vértices de una calle tras remuestrearla */
const MAX_SEG = 12
/** dos movimientos más cerca que esto (m, entre ejes) chocarían */
export const W_CONFLICT = 2.8
/** con un vehículo largo (camión, autobús): su cola se mete por dentro de las curvas */
export const W_WIDE = 4.2
/** tramos más cortos que esto (m) pueden fundir dos nudos en un cruce */
const SHORT = 40
/** diámetro máximo (m) de un cruce hecho de varios nudos */
const CLUSTER_MAX = 90
/** recorte máximo (m) de una calle en un cruce (incorporaciones casi paralelas) */
const SB_MAX = 80
/** perímetro máximo (m) de una rotonda que se trata como un solo cruce */
const RING_CLUSTER = 220

export type Turn = 'kerb' | 'straight' | 'far' | 'u'
export type ClusterKind = 'priority' | 'equal' | 'roundabout' | 'signal'

export interface Projector {
  (lat: number, lon: number, h: number, out: { x: number; y: number; z: number }): void
}

export interface NetOptions {
  /** 1 = se circula por la derecha, -1 = por la izquierda */
  side: 1 | -1
  /** (lat, lon, altura) → marco local (x este, y arriba, z sur), en metros */
  project: Projector
  /** altura de referencia del plano de la simulación */
  hRef: number
}

interface GNode {
  id: number
  gx: number
  gy: number
  x: number
  z: number
  pieces: Piece[]
  roads: Road[]
  /** en el borde de una tesela: claves de las dos */
  border: [number, number] | null
  /** da a una tesela que no está en la región */
  frontier: boolean
  cluster: Cluster | null
}

interface Piece {
  line: RoadLine
  gx: Float64Array
  gy: Float64Array
  a: GNode
  b: GNode
  urban: boolean
  f: number
  bk: number
  lw: number
  used: boolean
}

export interface Road {
  id: number
  a: GNode
  b: GNode
  x: Float64Array
  z: Float64Array
  lat: Float64Array
  lon: Float64Array
  s: Float64Array
  len: number
  /** por segmento */
  rank: Uint8Array
  bri: Int8Array
  layer: Int8Array
  urban: Uint8Array
  /** carriles hacia b y hacia a, ancho de carril */
  nF: number
  nB: number
  lw: number
  ramp: boolean
  /** rotonda a la que pertenece (-1 = ninguna) */
  ring: number
  /** dentro de un cruce de varios nudos: no lleva carriles propios */
  internal: boolean
  /** parte de una rotonda que entera es un solo cruce */
  ringFull: boolean
  sbA: number
  sbB: number
}

/** vehículo que ya ha salido de un tramo y aún no ha sacado la cola (cuentakilómetros al salir) */
export interface Tail {
  v: Veh
  odo: number
}

export interface Lane {
  link: Link
  i: number
  /** vehículos por posición creciente */
  vehs: Veh[]
  /** movimientos que salen de este carril */
  moves: Move[]
  /** movimientos que llegan a este carril */
  ins: Move[]
  /** movimientos de otros cruces que pasan por encima de este carril */
  zones: LaneZone[]
  /** carriles de otras calles que se tocan con este */
  near: LaneLane[]
  /** pasos a nivel (rail.ts) */
  rail: Crossing[]
  tails: Tail[]
}

export interface Link {
  id: number
  road: Road
  dir: 1 | -1
  /** número de carriles y ancho de cada uno */
  n: number
  lw: number
  /** desplazamiento lateral de cada carril (m, + hacia el arcén); 0 = el del arcén */
  off: Float32Array
  x: Float64Array
  z: Float64Array
  /** altura (mundo) de cada vértice; NaN = aún sin datos */
  y: Float32Array
  lat: Float64Array
  lon: Float64Array
  s: Float64Array
  len: number
  /** velocidad máxima en cada vértice (clase de vía y curva), m/s */
  vmax: Float32Array
  /** por segmento: 1 puente, -1 túnel; y su capa (puentes y túneles a varias alturas) */
  bri: Int8Array
  layer: Int8Array
  /** tramo útil: de s0 a s1 (fuera de los cruces) */
  s0: number
  s1: number
  from: Cluster | null
  to: Cluster | null
  rank: number
  urban: boolean
  lanes: Lane[]
  /** movimientos al final del enlace */
  moves: Move[]
  /** enlaces de salida posibles con sus movimientos por carril */
  outs: Array<{ to: Link; byLane: Array<Move | null>; turn: Turn }>
  /** desde aquí se puede salir de la región o seguir circulando (no es un callejón sin salida) */
  live: boolean
  /** densidad de tráfico relativa (vehículos por km y carril a la hora de más tráfico) */
  density: number
  /** apta para un tráiler: no es una calle residencial ni tiene curvas muy cerradas (radio < ~40 m) */
  heavy: boolean
}

export interface Zone {
  other: Move
  /** cruce (exclusivo) o tramo compartido (se sigue al de delante) */
  cross: boolean
  /** tramo de este movimiento y del otro */
  a0: number
  a1: number
  b0: number
  b1: number
  /** este movimiento cede ante el otro */
  yieldMe: boolean
  /** solo chocan si uno de los dos es un vehículo largo */
  wide: boolean
  /** puntos casados (s en este, s en el otro), por s creciente en este */
  mapA: Float32Array
  mapB: Float32Array
}

/** tramo de este carril que toca el de otra calle (s0..s1 aquí, o0..o1 en el otro) */
/**
 * Reserva de un tramo exclusivo (de quien llega primero a su distancia de frenado): la corriente
 * de vehículos (un carril o un movimiento) que lo tiene y cuándo lo pidió por última vez.
 */
export interface Token {
  stream: object | null
  t: number
}

export interface LaneLane {
  /** reserva compartida con el tramo del otro carril */
  tok: Token
  other: Lane
  s0: number
  s1: number
  o0: number
  o1: number
  /** solo con vehículos largos (curva cerrada de una calle de doble sentido) */
  wide: boolean
}

/** tramo de un movimiento que pasa por encima del carril de otra calle */
export interface LaneZone {
  tok: Token
  move: Move
  lane: Lane
  /** tramo en el movimiento y en el carril */
  a0: number
  a1: number
  s0: number
  s1: number
}

export interface Move {
  id: number
  cluster: Cluster
  from: Link
  lane: number
  to: Link
  toLane: number
  x: Float32Array
  z: Float32Array
  y: Float32Array
  s: Float32Array
  len: number
  vmax: Float32Array
  turn: Turn
  /** 2 = calle principal, 1 = secundaria */
  level: number
  /** fase del semáforo (-1 = sin semáforo) */
  phase: number
  zones: Zone[]
  /** vehículos encima (posición creciente) */
  vehs: Veh[]
  /** vehículos que ya tienen paso y aún no han llegado */
  committed: Veh[]
  /** vehículos que ya han salido pero aún no han sacado la cola */
  tails: Tail[]
  /** dirección de entrada y de salida (unitarias, x/z) */
  dIn: [number, number]
  dOut: [number, number]
  /** túnel (no se ve) */
  hidden: boolean
  /** tramos sobre carriles de otras calles */
  laneZones: LaneZone[]
  /** el camino se dobla sobre sí mismo: solo cabe un vehículo a la vez */
  single: boolean
  /** pasos a nivel dentro del cruce (rail.ts) */
  rail: Crossing[]
}

export interface Cluster {
  id: number
  nodes: GNode[]
  kind: ClusterKind
  x: number
  z: number
  ins: Link[]
  outs: Link[]
  moves: Move[]
  /** semáforo: verde de cada fase (s); ámbar 3 s y todo rojo 2 s detrás de cada una */
  greens: number[]
  cycle: number
  offset: number
}

export interface Network {
  side: 1 | -1
  links: Link[]
  clusters: Cluster[]
  moves: Move[]
  roads: Road[]
  /** enlaces que entran desde la frontera */
  entries: Link[]
  stats: { roads: number; links: number; clusters: number; moves: number; zones: number; rings: number; signals: number; ms: number }
}

// ---------------------------------------------------------------------------
// Carriles por clase de vía (como las marcas viales de Bridges.ts)
// ---------------------------------------------------------------------------

function roadWidth(cls: RoadClass, oneway: boolean, ramp: boolean): number {
  switch (cls) {
    case 'motorway':
      return ramp ? 7.5 : oneway ? 11.5 : 22
    case 'trunk':
      return ramp ? 7 : oneway ? 10.5 : 14
    case 'primary':
      return ramp ? 6.5 : oneway ? 8.5 : 11
    case 'secondary':
      return oneway ? 7.5 : 10
    case 'tertiary':
      return oneway ? 6.5 : 9
    default:
      return oneway ? 5.5 : 7
  }
}

/** carriles en total y ancho de cada uno */
export function laneLayout(cls: RoadClass, oneway: boolean, ramp: boolean): { lanes: number; lw: number } {
  const w = roadWidth(cls, oneway, ramp)
  const lanes = oneway ? Math.max(1, Math.round((w - 3.5) / 3.5)) : w >= 13 ? 4 : 2
  const cw = Math.min(lanes * 1.75, w / 2 - 0.75)
  return { lanes, lw: (2 * cw) / lanes }
}

/** velocidad (m/s) por clase, en ciudad o fuera */
export function classSpeed(rank: number, urban: boolean, ramp: boolean): number {
  const kmh = ramp
    ? rank >= 5
      ? 70
      : 50
    : urban
      ? [30, 30, 50, 50, 50, 80, 90][rank]
      : [40, 40, 70, 80, 90, 100, 120][rank]
  return kmh / 3.6
}

/** vehículos por km y carril en hora punta */
function densityOf(rank: number, urban: boolean): number {
  const d = [0.8, 1.1, 3.5, 5, 7, 10, 12][rank]
  return urban ? d * 1.15 : d
}

// ---------------------------------------------------------------------------
// Construcción
// ---------------------------------------------------------------------------

let nextId = 1

/** Cede el hilo si ya se ha pasado del presupuesto (para que el worker siga moviendo coches). */
export type Pause = () => Promise<void> | void

export async function buildNetwork(tiles: RoadTile[], opts: NetOptions, pause: Pause = () => {}): Promise<Network> {
  const t0 = performance.now()
  const region = new Set(tiles.map((t) => t.y * NZ + t.x))
  const { nodes, pieces } = buildPieces(tiles, region, opts.side)
  await pause()
  const p3 = { x: 0, y: 0, z: 0 }
  for (const n of nodes) {
    opts.project(yToLat(n.gy / E, NZ), xToLon(n.gx / E, NZ), opts.hRef, p3)
    n.x = p3.x
    n.z = p3.z
  }
  await pause()
  const roads = mergeRoads(nodes, pieces, opts)
  await pause()
  const rings = findRings(roads, opts.side)
  await pause()
  await computeSetbacks(nodes, pause)
  const clusters = makeClusters(nodes, roads, rings)
  await pause()
  const links = makeLinks(roads, opts.side)
  await pause()
  const moves: Move[] = []
  for (const c of clusters) {
    buildMoves(c, opts.side, moves)
    await pause()
  }
  const zones = (await buildConflicts(moves, pause)) + (await buildLaneZones(moves, links, opts.side, pause)) + (await buildLaneLaneZones(links, opts.side, pause))
  let signals = 0
  for (const c of clusters) {
    decideControl(c, opts.side)
    if (c.kind === 'signal') signals++
    await pause()
  }
  markLive(links)
  const entries = links.filter((l) => l.from === null)
  return {
    side: opts.side,
    links,
    clusters,
    moves,
    roads,
    entries,
    stats: { roads: roads.length, links: links.length, clusters: clusters.length, moves: moves.length, zones, rings: rings.length, signals, ms: performance.now() - t0 },
  }
}

// ---------------------------------------------------------------------------
// Tramos entre nudos
// ---------------------------------------------------------------------------

function buildPieces(tiles: RoadTile[], region: Set<number>, side: 1 | -1): { nodes: GNode[]; pieces: Piece[] } {
  const nodes: GNode[] = []
  const pieces: Piece[] = []
  const interior = new Map<string, GNode>()
  const borders = new Map<string, GNode[]>()
  const newNode = (gx: number, gy: number, border: [number, number] | null): GNode => {
    const n: GNode = { id: nextId++, gx, gy, x: 0, z: 0, pieces: [], roads: [], border, frontier: border !== null && !region.has(border[1]), cluster: null }
    nodes.push(n)
    return n
  }
  const node = (t: RoadTile, px: number, py: number): GNode => {
    const gx = t.x * E + px
    const gy = t.y * E + py
    if (px > 0 && py > 0 && px < E && py < E) {
      const key = `${gx},${gy}`
      let n = interior.get(key)
      if (!n) interior.set(key, (n = newNode(gx, gy, null)))
      return n
    }
    // en el borde: el corte visto desde la tesela vecina difiere en alguna unidad
    const vertical = px <= 0 || px >= E
    const lineKey = vertical ? `v${gx}` : `h${gy}`
    const along = vertical ? gy : gx
    let list = borders.get(lineKey)
    if (!list) borders.set(lineKey, (list = []))
    let best: GNode | null = null
    let bestD = BORDER_TOL
    for (const n of list) {
      const d = Math.abs((vertical ? n.gy : n.gx) - along)
      if (d <= bestD) {
        bestD = d
        best = n
      }
    }
    if (best) return best
    const other = vertical ? t.y * NZ + (px <= 0 ? t.x - 1 : t.x + 1) : (py <= 0 ? t.y - 1 : t.y + 1) * NZ + t.x
    const n = newNode(gx, gy, [t.y * NZ + t.x, other])
    list.push(n)
    return n
  }
  for (const t of tiles) {
    const count = new Map<string, number>()
    for (const l of t.lines) for (let i = 0; i < l.pts.length; i += 2) count.set(`${l.pts[i]},${l.pts[i + 1]}`, (count.get(`${l.pts[i]},${l.pts[i + 1]}`) ?? 0) + 1)
    for (const l of t.lines) {
      // rotonda sin sentido en los datos: el de la circulación (antihorario por la derecha)
      const ow = l.loop !== 0 && l.oneway === 0 ? (l.loop === side ? 1 : -1) : l.oneway
      const lay = laneLayout(l.cls, ow !== 0, l.ramp)
      const f = ow === 0 ? lay.lanes / 2 : ow > 0 ? lay.lanes : 0
      const bk = ow === 0 ? lay.lanes / 2 : ow < 0 ? lay.lanes : 0
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
        // (los cortes de borde casados con tolerancia: el extremo va al nudo)
        gx[0] = a.gx
        gy[0] = a.gy
        gx[k - 1] = b.gx
        gy[k - 1] = b.gy
        if (a !== b || k > 2) {
          const p: Piece = { line: l, gx, gy, a, b, urban: l.urban, f, bk, lw: lay.lw, used: false }
          a.pieces.push(p)
          b.pieces.push(p)
          pieces.push(p)
        }
        start = j
      }
    }
  }
  return { nodes, pieces }
}

/** Une los tramos seguidos (nudos de dos tramos con los mismos carriles) en calles. */
function mergeRoads(nodes: GNode[], pieces: Piece[], opts: NetOptions): Road[] {
  const roads: Road[] = []
  // carriles (hacia delante, hacia atrás) de un tramo recorrido de `from` a su otro extremo
  const lay = (p: Piece, fwd: boolean) => (fwd ? [p.f, p.bk] : [p.bk, p.f])
  const passable = (n: GNode, arriving: Piece, arrivingFwd: boolean): { q: Piece; fwd: boolean } | null => {
    if (n.frontier || n.pieces.length !== 2) return null
    const q = n.pieces[0] === arriving ? n.pieces[1] : n.pieces[0]
    if (q === arriving || q.used) return null
    const fwd = q.a === n
    const la = lay(arriving, arrivingFwd)
    const lb = lay(q, fwd)
    if (la[0] !== lb[0] || la[1] !== lb[1] || arriving.lw !== q.lw || arriving.line.ramp !== q.line.ramp) return null
    return { q, fwd }
  }
  for (const p0 of pieces) {
    if (p0.used) continue
    p0.used = true
    const seq: Array<{ p: Piece; fwd: boolean }> = [{ p: p0, fwd: true }]
    // hacia delante
    let n = p0.b
    let last = p0
    let lastFwd = true
    for (;;) {
      const nx = passable(n, last, lastFwd)
      if (!nx) break
      nx.q.used = true
      seq.push({ p: nx.q, fwd: nx.fwd })
      last = nx.q
      lastFwd = nx.fwd
      n = nx.fwd ? nx.q.b : nx.q.a
    }
    // hacia atrás
    n = p0.a
    last = p0
    lastFwd = false
    for (;;) {
      const nx = passable(n, last, lastFwd)
      if (!nx) break
      nx.q.used = true
      // recorrido hacia atrás: en la calle va al revés
      seq.unshift({ p: nx.q, fwd: !nx.fwd })
      last = nx.q
      lastFwd = nx.fwd
      n = nx.fwd ? nx.q.b : nx.q.a
    }
    const first = seq[0]
    const [f, bk] = lay(first.p, first.fwd)
    const road = buildRoad(seq, f, bk, first.p.lw, opts)
    if (road) roads.push(road)
  }
  for (const r of roads) {
    r.a.roads.push(r)
    r.b.roads.push(r)
  }
  return roads
}

function buildRoad(seq: Array<{ p: Piece; fwd: boolean }>, f: number, bk: number, lw: number, opts: NetOptions): Road | null {
  // vértices globales y atributos por segmento
  const gx: number[] = []
  const gy: number[] = []
  const rank: number[] = []
  const bri: number[] = []
  const lay: number[] = []
  const urb: number[] = []
  for (const { p, fwd } of seq) {
    const k = p.gx.length
    for (let i = 0; i < k; i++) {
      const j = fwd ? i : k - 1 - i
      if (gx.length > 0 && i === 0) continue
      gx.push(p.gx[j])
      gy.push(p.gy[j])
      if (gx.length > 1) {
        rank.push(RANK[p.line.cls])
        bri.push(p.line.brunnel)
        lay.push(p.line.layer)
        urb.push(p.urban ? 1 : 0)
      }
    }
  }
  let a = seq[0].fwd ? seq[0].p.a : seq[0].p.b
  const lastS = seq[seq.length - 1]
  let b = lastS.fwd ? lastS.p.b : lastS.p.a
  // sentido único: siempre de a hacia b
  if (f === 0) {
    gx.reverse()
    gy.reverse()
    rank.reverse()
    bri.reverse()
    lay.reverse()
    urb.reverse()
    ;[a, b] = [b, a]
    ;[f, bk] = [bk, f]
  }
  // proyección y remuestreo
  const X: number[] = []
  const Z: number[] = []
  const LA: number[] = []
  const LO: number[] = []
  const R: number[] = []
  const B: number[] = []
  const Y: number[] = []
  const U: number[] = []
  const p3 = { x: 0, y: 0, z: 0 }
  let px = 0
  let pz = 0
  let plat = 0
  let plon = 0
  for (let i = 0; i < gx.length; i++) {
    const lat = yToLat(gy[i] / E, NZ)
    const lon = xToLon(gx[i] / E, NZ)
    opts.project(lat, lon, opts.hRef, p3)
    if (i > 0) {
      const L = Math.hypot(p3.x - px, p3.z - pz)
      if (L < 0.05) continue
      const k = Math.ceil(L / MAX_SEG)
      for (let j = 1; j < k; j++) {
        const t = j / k
        X.push(px + (p3.x - px) * t)
        Z.push(pz + (p3.z - pz) * t)
        LA.push(plat + (lat - plat) * t)
        LO.push(plon + (lon - plon) * t)
        R.push(rank[i - 1])
        B.push(bri[i - 1])
        Y.push(lay[i - 1])
        U.push(urb[i - 1])
      }
      R.push(rank[i - 1])
      B.push(bri[i - 1])
      Y.push(lay[i - 1])
      U.push(urb[i - 1])
    }
    X.push(p3.x)
    Z.push(p3.z)
    LA.push(lat)
    LO.push(lon)
    px = p3.x
    pz = p3.z
    plat = lat
    plon = lon
  }
  if (X.length < 2) return null
  roundCorners(X, Z, LA, LO, R, B, U, Y)
  const n = X.length
  const s = new Float64Array(n)
  for (let i = 1; i < n; i++) s[i] = s[i - 1] + Math.hypot(X[i] - X[i - 1], Z[i] - Z[i - 1])
  if (s[n - 1] < 0.5) return null
  return {
    id: nextId++,
    a,
    b,
    x: Float64Array.from(X),
    z: Float64Array.from(Z),
    lat: Float64Array.from(LA),
    lon: Float64Array.from(LO),
    s,
    len: s[n - 1],
    rank: Uint8Array.from(R),
    bri: Int8Array.from(B),
    layer: Int8Array.from(Y),
    urban: Uint8Array.from(U),
    nF: f,
    nB: bk,
    lw,
    ramp: seq[0].p.line.ramp,
    ring: -1,
    internal: false,
    ringFull: false,
    sbA: 0,
    sbB: 0,
  }
}

/**
 * Redondea las esquinas de la polilínea (dos pasadas de Chaikin solo en los vértices que giran
 * más de ~12°): los carriles van desplazados del eje y en una esquina viva se cruzarían.
 * Los extremos no se mueven. Atributos por segmento: se reparten con los segmentos nuevos.
 */
function roundCorners(X: number[], Z: number[], LA: number[], LO: number[], R: number[], B: number[], U: number[], Y: number[]): void {
  for (let pass = 0; pass < 2; pass++) {
    const n = X.length
    if (n < 3) return
    const ox: number[] = [X[0]]
    const oz: number[] = [Z[0]]
    const ola: number[] = [LA[0]]
    const olo: number[] = [LO[0]]
    const oR: number[] = []
    const oB: number[] = []
    const oU: number[] = []
    const oY: number[] = []
    for (let i = 1; i < n - 1; i++) {
      const ax = X[i] - X[i - 1]
      const az = Z[i] - Z[i - 1]
      const bx = X[i + 1] - X[i]
      const bz = Z[i + 1] - Z[i]
      const la = Math.hypot(ax, az)
      const lb = Math.hypot(bx, bz)
      const cos = la > 0 && lb > 0 ? (ax * bx + az * bz) / (la * lb) : 1
      if (cos > 0.978) {
        // casi recto: se queda
        ox.push(X[i])
        oz.push(Z[i])
        ola.push(LA[i])
        olo.push(LO[i])
        oR.push(R[i - 1])
        oB.push(B[i - 1])
        oU.push(U[i - 1])
        oY.push(Y[i - 1])
        continue
      }
      // corta la esquina a un cuarto de cada segmento (como mucho 6 m)
      const ta = Math.min(0.25, 6 / Math.max(la, 1e-6))
      const tb = Math.min(0.25, 6 / Math.max(lb, 1e-6))
      ox.push(X[i] - ax * ta, X[i] + bx * tb)
      oz.push(Z[i] - az * ta, Z[i] + bz * tb)
      ola.push(LA[i] - (LA[i] - LA[i - 1]) * ta, LA[i] + (LA[i + 1] - LA[i]) * tb)
      olo.push(LO[i] - (LO[i] - LO[i - 1]) * ta, LO[i] + (LO[i + 1] - LO[i]) * tb)
      oR.push(R[i - 1], R[i])
      oB.push(B[i - 1], B[i])
      oU.push(U[i - 1], U[i])
      oY.push(Y[i - 1], Y[i])
    }
    ox.push(X[n - 1])
    oz.push(Z[n - 1])
    ola.push(LA[n - 1])
    olo.push(LO[n - 1])
    oR.push(R[n - 2])
    oB.push(B[n - 2])
    oU.push(U[n - 2])
    oY.push(Y[n - 2])
    X.splice(0, X.length, ...ox)
    Z.splice(0, Z.length, ...oz)
    LA.splice(0, LA.length, ...ola)
    LO.splice(0, LO.length, ...olo)
    R.splice(0, R.length, ...oR)
    B.splice(0, B.length, ...oB)
    U.splice(0, U.length, ...oU)
    Y.splice(0, Y.length, ...oY)
  }
}

/** semiancho de la calzada (m) */
function halfWidth(r: Road): number {
  const lanes = r.nF + r.nB
  return r.nB > 0 ? Math.max(r.nF, r.nB) * r.lw + 0.5 : (lanes * r.lw) / 2 + 0.5
}

/** dirección (unitaria) con la que la calle sale del nudo n, medida a `d` metros */
function dirFrom(r: Road, atA: boolean, d = 6): [number, number] {
  const L = Math.min(d, r.len * 0.5)
  const p = pointAt(r.x, r.z, r.s, atA ? L : r.len - L)
  const ox = atA ? r.x[0] : r.x[r.x.length - 1]
  const oz = atA ? r.z[0] : r.z[r.z.length - 1]
  const dx = p[0] - ox
  const dz = p[1] - oz
  const l = Math.hypot(dx, dz) || 1
  return [dx / l, dz / l]
}

function pointAt(x: ArrayLike<number>, z: ArrayLike<number>, s: ArrayLike<number>, at: number): [number, number] {
  const n = s.length
  if (at <= 0) return [x[0], z[0]]
  if (at >= s[n - 1]) return [x[n - 1], z[n - 1]]
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1
    if (s[m] <= at) lo = m
    else hi = m
  }
  const t = (at - s[lo]) / (s[hi] - s[lo] || 1)
  return [x[lo] + (x[hi] - x[lo]) * t, z[lo] + (z[hi] - z[lo]) * t]
}

/** ángulo con signo (rad) de `a` a `b` visto desde arriba con el norte arriba: + = a la izquierda */
function turnAngle(ax: number, az: number, bx: number, bz: number): number {
  // en (este, norte): norte = -z
  return Math.atan2(ax * -bz - -az * bx, ax * bx + az * bz)
}

// ---------------------------------------------------------------------------
// Rotondas
// ---------------------------------------------------------------------------

function findRings(roads: Road[], side: 1 | -1): Road[][] {
  const out = new Map<GNode, Road[]>()
  for (const r of roads) {
    if (r.nB !== 0 || r.ramp || r.len > 400) continue
    let l = out.get(r.a)
    if (!l) out.set(r.a, (l = []))
    l.push(r)
  }
  const rings: Road[][] = []
  const endDir = (r: Road): [number, number] => {
    const d = dirFrom(r, false, 4)
    return [-d[0], -d[1]]
  }
  for (const r0 of roads) {
    if (r0.ring >= 0 || r0.nB !== 0 || r0.ramp || r0.len > 400) continue
    // búsqueda en profundidad del ciclo más corto que vuelve a r0.a
    let best: Road[] | null = null
    let bestLen = 800
    const path: Road[] = [r0]
    const visit = (len: number) => {
      if (path.length > 16 || len >= bestLen) return
      const last = path[path.length - 1]
      if (last.b === r0.a) {
        best = [...path]
        bestLen = len
        return
      }
      const ed = endDir(last)
      for (const nx of out.get(last.b) ?? []) {
        if (path.includes(nx) || nx.ring >= 0) continue
        const sd = dirFrom(nx, true, 4)
        const a = turnAngle(ed[0], ed[1], sd[0], sd[1])
        // en el anillo se gira poco y siempre hacia dentro
        if (Math.abs(a) > 1.2 || a * side < -0.3) continue
        path.push(nx)
        visit(len + nx.len)
        path.pop()
      }
    }
    visit(r0.len)
    if (!best) continue
    const ring: Road[] = best
    // área con signo (este, norte) y perímetro
    let area = 0
    let per = 0
    let maxTurn = 0
    let pdx = 0
    let pdz = 0
    let first = true
    for (const r of ring) {
      for (let i = 1; i < r.x.length; i++) {
        const x0 = r.x[i - 1]
        const n0 = -r.z[i - 1]
        const x1 = r.x[i]
        const n1 = -r.z[i]
        area += (x0 * n1 - x1 * n0) / 2
        const dx = r.x[i] - r.x[i - 1]
        const dz = r.z[i] - r.z[i - 1]
        const l = Math.hypot(dx, dz)
        per += l
        if (l > 0.5) {
          if (!first) maxTurn = Math.max(maxTurn, Math.abs(turnAngle(pdx, pdz, dx / l, dz / l)))
          pdx = dx / l
          pdz = dz / l
          first = false
        }
      }
    }
    const ccw = area > 0
    const compact = (4 * Math.PI * Math.abs(area)) / (per * per)
    if (per < 25 || compact < 0.6 || maxTurn > 1.05 || ccw !== (side === 1)) continue
    const id = rings.length
    for (const r of ring) r.ring = id
    rings.push(ring)
  }
  return rings
}

// ---------------------------------------------------------------------------
// Cruces
// ---------------------------------------------------------------------------

/**
 * Distancia desde cada nudo a la que cada calle deja de pisar la calzada de las demás: se recorre
 * la calle desde el nudo y, metro a metro, se mira si su sección (todo el ancho) cae aún dentro de
 * la calzada de otra calle que sale del mismo nudo. Con la geometría real (no solo el ángulo de
 * salida): dos calles que salen casi paralelas o que se curvan una hacia otra se recortan hasta
 * donde de verdad se separan.
 */
async function computeSetbacks(nodes: GNode[], pause: Pause): Promise<void> {
  for (const n of nodes) {
    await pause()
    if (n.frontier) continue
    const ends: Array<{ r: Road; atA: boolean; h: number; px: number[]; pz: number[] }> = []
    for (const r of n.roads) {
      if (r.a === n) ends.push({ r, atA: true, h: halfWidth(r), ...pathFrom(r, true, SB_MAX + 30) })
      if (r.b === n) ends.push({ r, atA: false, h: halfWidth(r), ...pathFrom(r, false, SB_MAX + 30) })
    }
    for (const e of ends) {
      let sb = 0
      if (ends.length === 1) sb = 4
      else {
        const others = ends.filter((f) => f !== e)
        sb = SB_MAX
        for (let s = 0; s <= SB_MAX; s += 1) {
          const p = pointAt(e.px, e.pz, polyS(e), s)
          const d = dirAlong(e, s)
          // normal
          const nx = -d[1]
          const nz = d[0]
          let inside = false
          for (const f of others) {
            for (const k of [-1, -0.5, 0, 0.5, 1]) {
              if (inCorridor(f, p[0] + nx * e.h * k, p[1] + nz * e.h * k)) {
                inside = true
                break
              }
            }
            if (inside) break
          }
          if (!inside) {
            sb = s
            break
          }
        }
      }
      // nudo de dos calles (cambio de carriles): un poco de sitio para el empalme
      if (ends.length === 2) sb = Math.max(sb, 3)
      sb = Math.min(SB_MAX, sb + (ends.length > 2 ? 1 : 0))
      if (e.atA) e.r.sbA = sb
      else e.r.sbB = sb
    }
  }
}

/** Polilínea de la calle desde un extremo (hasta `max` metros). */
function pathFrom(r: Road, atA: boolean, max: number): { px: number[]; pz: number[] } {
  const px: number[] = []
  const pz: number[] = []
  const k = r.x.length
  for (let i = 0; i < k; i++) {
    const j = atA ? i : k - 1 - i
    const s = atA ? r.s[j] : r.len - r.s[j]
    px.push(r.x[j])
    pz.push(r.z[j])
    if (s > max) break
  }
  return { px, pz }
}
function polyS(e: { px: number[]; pz: number[]; cum?: number[] }): number[] {
  if (e.cum) return e.cum
  const c = [0]
  for (let i = 1; i < e.px.length; i++) c.push(c[i - 1] + Math.hypot(e.px[i] - e.px[i - 1], e.pz[i] - e.pz[i - 1]))
  e.cum = c
  return c
}
function dirAlong(e: { px: number[]; pz: number[] }, s: number): [number, number] {
  const c = polyS(e)
  let i = 0
  while (i < c.length - 2 && c[i + 1] < s) i++
  const dx = e.px[i + 1] - e.px[i]
  const dz = e.pz[i + 1] - e.pz[i]
  const l = Math.hypot(dx, dz) || 1
  return [dx / l, dz / l]
}
/** ¿El punto está en la calzada de la calle (a menos de su semiancho del eje, sin contar lo que queda detrás del nudo)? */
function inCorridor(f: { px: number[]; pz: number[]; h: number }, x: number, z: number): boolean {
  const h2 = f.h * f.h
  for (let i = 0; i + 1 < f.px.length; i++) {
    const ax = f.px[i]
    const az = f.pz[i]
    const dx = f.px[i + 1] - ax
    const dz = f.pz[i + 1] - az
    const l2 = dx * dx + dz * dz
    if (l2 < 1e-9) continue
    let t = ((x - ax) * dx + (z - az) * dz) / l2
    if (t < 0) {
      if (i === 0) continue // detrás del nudo: fuera de esta calzada
      t = 0
    } else if (t > 1) t = 1
    const ex = x - ax - dx * t
    const ez = z - az - dz * t
    if (ex * ex + ez * ez < h2) return true
  }
  return false
}

function makeClusters(nodes: GNode[], roads: Road[], rings: Road[][]): Cluster[] {
  const parent = new Map<GNode, GNode>()
  const find = (n: GNode): GNode => {
    let p = parent.get(n) ?? n
    if (p !== n) {
      p = find(p)
      parent.set(n, p)
    }
    return p
  }
  const members = new Map<GNode, GNode[]>()
  const union = (a: GNode, b: GNode): boolean => {
    const ra = find(a)
    const rb = find(b)
    if (ra === rb) return true
    const la = members.get(ra) ?? [ra]
    const lb = members.get(rb) ?? [rb]
    // diámetro máximo del cruce resultante
    for (const p of la) for (const q of lb) if (Math.hypot(p.x - q.x, p.z - q.z) > CLUSTER_MAX) return false
    parent.set(rb, ra)
    members.set(ra, [...la, ...lb])
    members.delete(rb)
    return true
  }
  // rotondas pequeñas: un solo cruce
  for (const ring of rings) {
    let per = 0
    for (const r of ring) per += r.len
    if (per > RING_CLUSTER) continue
    if (ring.some((r) => r.a.frontier || r.b.frontier)) continue
    let ok = true
    for (const r of ring) ok = ok && union(r.a, r.b)
    for (const r of ring) {
      r.internal = ok
      r.ringFull = ok
    }
  }
  // tramos cortos dentro de un cruce
  for (const r of roads) {
    if (r.internal || r.a === r.b || r.a.frontier || r.b.frontier) continue
    // tramo tan corto que no cabe un camión parado entre los dos cruces: un solo cruce (si no, uno
    // que espera en el segundo con la cola dentro del primero bloquea los dos)
    if ((r.len < SHORT && r.sbA + r.sbB + 3 > r.len) || (r.len < 60 && r.len - r.sbA - r.sbB < 22)) {
      if (union(r.a, r.b)) r.internal = true
    }
  }
  // tramos que quedan con los dos extremos en el mismo cruce y son cortos: también internos
  for (const r of roads) {
    if (!r.internal && r.a !== r.b && !r.a.frontier && !r.b.frontier && find(r.a) === find(r.b) && r.len < SHORT) r.internal = true
  }
  const byRoot = new Map<GNode, Cluster>()
  const clusters: Cluster[] = []
  for (const n of nodes) {
    if (n.frontier) continue
    const root = find(n)
    let c = byRoot.get(root)
    if (!c) {
      c = { id: nextId++, nodes: [], kind: 'priority', x: 0, z: 0, ins: [], outs: [], moves: [], greens: [], cycle: 0, offset: 0 }
      byRoot.set(root, c)
      clusters.push(c)
    }
    c.nodes.push(n)
    n.cluster = c
  }
  for (const c of clusters) {
    for (const n of c.nodes) {
      c.x += n.x / c.nodes.length
      c.z += n.z / c.nodes.length
    }
  }
  return clusters
}

// ---------------------------------------------------------------------------
// Enlaces (calle + sentido) y carriles
// ---------------------------------------------------------------------------

function makeLinks(roads: Road[], side: 1 | -1): Link[] {
  const links: Link[] = []
  for (const r of roads) {
    if (r.internal) continue
    const sA = r.a.frontier ? 0 : r.sbA
    const sB = r.b.frontier ? 0 : r.sbB
    let s0 = sA
    let s1 = r.len - sB
    // tramo muy corto entre dos cruces: se reparte lo que hay
    if (s1 - s0 < 2) {
      const tot = sA + sB
      const room = Math.max(0, r.len - 2)
      s0 = tot > 0 ? (room * sA) / tot : 0
      s1 = r.len - (tot > 0 ? (room * sB) / tot : 0)
      if (s1 - s0 < 0.5) {
        s0 = r.len * 0.25
        s1 = r.len * 0.75
      }
    }
    const fwd = r.nF > 0 ? makeLink(r, 1, r.nF, s0, s1, side) : null
    const back = r.nB > 0 ? makeLink(r, -1, r.nB, r.len - s1, r.len - s0, side) : null
    if (fwd) links.push(fwd)
    if (back) links.push(back)
  }
  return links
}

function makeLink(r: Road, dir: 1 | -1, n: number, s0: number, s1: number, side: 1 | -1): Link {
  const k = r.x.length
  const rev = dir < 0
  const pick = <T extends Float64Array>(src: T): T => {
    const o = new (src.constructor as any)(k) as T
    for (let i = 0; i < k; i++) o[i] = src[rev ? k - 1 - i : i]
    return o
  }
  const x = pick(r.x)
  const z = pick(r.z)
  const lat = pick(r.lat)
  const lon = pick(r.lon)
  const s = new Float64Array(k)
  for (let i = 1; i < k; i++) s[i] = s[i - 1] + Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1])
  const segs = k - 1
  const bri = new Int8Array(segs)
  const layer = new Int8Array(segs)
  const rank = new Uint8Array(segs)
  const urban = new Uint8Array(segs)
  for (let i = 0; i < segs; i++) {
    const j = rev ? segs - 1 - i : i
    bri[i] = r.bri[j]
    layer[i] = r.layer[j]
    rank[i] = r.rank[j]
    urban[i] = r.urban[j]
  }
  // carril 0 = el del arcén; desplazamiento + hacia el arcén
  const twoWay = r.nF > 0 && r.nB > 0
  const off = new Float32Array(n)
  for (let i = 0; i < n; i++) off[i] = twoWay ? (n - i - 0.5) * r.lw : ((n - 1) / 2 - i) * r.lw
  // velocidad por vértice: clase y curva (aceleración lateral cómoda ~2,2 m/s²)
  const vmax = new Float32Array(k)
  let rk = 0
  let ur = 0
  for (let i = 0; i < k; i++) {
    const sj = Math.min(segs - 1, i)
    const v0 = classSpeed(rank[sj], urban[sj] === 1, r.ramp)
    let v = v0
    if (i > 0 && i < k - 1) {
      const R = circumRadius(x[i - 1], z[i - 1], x[i], z[i], x[i + 1], z[i + 1])
      v = Math.min(v0, Math.max(4, Math.sqrt(2.2 * R)))
    }
    vmax[i] = v
  }
  for (let i = 0; i < segs; i++) {
    rk += rank[i] * (s[i + 1] - s[i])
    ur += urban[i] * (s[i + 1] - s[i])
  }
  const len = s[k - 1]
  const link: Link = {
    id: nextId++,
    road: r,
    dir,
    n,
    lw: r.lw,
    off,
    x,
    z,
    y: new Float32Array(k).fill(NaN),
    lat,
    lon,
    s,
    len,
    vmax,
    bri,
    layer,
    s0,
    s1,
    from: (rev ? r.b : r.a).cluster,
    to: (rev ? r.a : r.b).cluster,
    rank: Math.round(rk / Math.max(len, 1e-6)),
    urban: ur > len / 2,
    lanes: [],
    moves: [],
    outs: [],
    live: false,
    density: 0,
    heavy: true,
  }
  // calles que acaban en la frontera: el enlace sigue hasta el final (por ahí se sale)
  if (link.to === null) link.s1 = len
  if (link.from === null) link.s0 = 0
  link.density = densityOf(link.rank, link.urban)
  let minR = Infinity
  for (let i = 1; i < k - 1; i++) minR = Math.min(minR, circumRadius(x[i - 1], z[i - 1], x[i], z[i], x[i + 1], z[i + 1]))
  // tráileres: carreteras de cierta entidad, sin curvas cerradas y con tramos donde quepan
  link.heavy = link.rank >= 3 && minR > 40 && (link.s1 - link.s0 >= 30 || link.from === null || link.to === null)
  for (let i = 0; i < n; i++) link.lanes.push({ link, i, vehs: [], moves: [], ins: [], tails: [], zones: [], near: [], rail: [] })
  if (link.from) link.from.outs.push(link)
  if (link.to) link.to.ins.push(link)
  return link
}

function circumRadius(ax: number, az: number, bx: number, bz: number, cx: number, cz: number): number {
  const ab = Math.hypot(bx - ax, bz - az)
  const bc = Math.hypot(cx - bx, cz - bz)
  const ca = Math.hypot(ax - cx, az - cz)
  const cr = Math.abs((bx - ax) * (cz - az) - (bz - az) * (cx - ax))
  if (cr < 1e-6) return 1e6
  return (ab * bc * ca) / (2 * cr)
}

/** posición y dirección en un enlace (con desplazamiento lateral) */
export function linkPose(l: Link, at: number, off: number, side: 1 | -1, out: { x: number; z: number; dx: number; dz: number }): void {
  const s = l.s
  const n = s.length
  let lo = 0
  let hi = n - 1
  const a = Math.max(0, Math.min(l.len, at))
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1
    if (s[m] <= a) lo = m
    else hi = m
  }
  const t = (a - s[lo]) / (s[hi] - s[lo] || 1)
  let dx = l.x[hi] - l.x[lo]
  let dz = l.z[hi] - l.z[lo]
  const L = Math.hypot(dx, dz) || 1
  dx /= L
  dz /= L
  // normal hacia el arcén: derecha (−dz, dx) por la derecha, izquierda por la izquierda
  out.x = l.x[lo] + (l.x[hi] - l.x[lo]) * t + -dz * off * side
  out.z = l.z[lo] + (l.z[hi] - l.z[lo]) * t + dx * off * side
  out.dx = dx
  out.dz = dz
}

// ---------------------------------------------------------------------------
// Movimientos
// ---------------------------------------------------------------------------

function buildMoves(c: Cluster, side: 1 | -1, all: Move[]): void {
  const inCluster = new Set(c.nodes)
  const isRing = c.nodes.length > 1 && c.nodes.some((n) => n.roads.some((r) => r.internal && r.ring >= 0))
  // grafo interno del cruce
  const adj = new Map<GNode, Array<{ r: Road; to: GNode; fwd: boolean }>>()
  for (const n of c.nodes) {
    for (const r of n.roads) {
      if (!r.internal) continue
      if (r.a === n && inCluster.has(r.b) && r.nF > 0) push(adj, n, { r, to: r.b, fwd: true })
      if (r.b === n && inCluster.has(r.a) && r.nB > 0) push(adj, n, { r, to: r.a, fwd: false })
    }
  }
  const P = { x: 0, z: 0, dx: 0, dz: 0 }
  const Q = { x: 0, z: 0, dx: 0, dz: 0 }
  const externalRoads = new Set<Road>()
  for (const l of [...c.ins, ...c.outs]) externalRoads.add(l.road)
  for (const L of c.ins) {
    const nIn = L.dir === 1 ? L.road.b : L.road.a
    // caminos dentro del cruce desde nIn
    const prev = new Map<GNode, { r: Road; from: GNode; fwd: boolean } | null>([[nIn, null]])
    const queue = [nIn]
    while (queue.length) {
      const n = queue.shift()!
      for (const e of adj.get(n) ?? []) {
        if (prev.has(e.to)) continue
        prev.set(e.to, { r: e.r, from: n, fwd: e.fwd })
        queue.push(e.to)
      }
    }
    linkPose(L, L.s1, 0, side, P)
    const options: Array<{ O: Link; alpha: number; path: Array<{ r: Road; fwd: boolean }> }> = []
    for (const O of c.outs) {
      const nOut = O.dir === 1 ? O.road.a : O.road.b
      if (!prev.has(nOut)) continue
      linkPose(O, O.s0, 0, side, Q)
      const alpha = turnAngle(P.dx, P.dz, Q.dx, Q.dz)
      const path: Array<{ r: Road; fwd: boolean }> = []
      for (let n: GNode = nOut; ; ) {
        const pr = prev.get(n)
        if (!pr) break
        path.unshift({ r: pr.r, fwd: pr.fwd })
        n = pr.from
      }
      options.push({ O, alpha, path })
    }
    // sin cambios de sentido salvo en un callejón sin salida
    const isU = (o: { O: Link; alpha: number }) => o.O.road === L.road || Math.abs(o.alpha) > 2.75
    let opts = options.filter((o) => !isU(o))
    if (opts.length === 0) opts = options.filter((o) => o.O.road === L.road && externalRoads.size === 1)
    if (opts.length === 0) continue
    // del arcén hacia el otro lado (por la derecha: de los giros a la derecha a los de la izquierda)
    opts.sort((a, b) => (a.alpha - b.alpha) * side)
    let main = 0
    for (let i = 1; i < opts.length; i++) if (Math.abs(opts[i].alpha) < Math.abs(opts[main].alpha)) main = i
    const n = L.n
    for (let oi = 0; oi < opts.length; oi++) {
      const o = opts[oi]
      const O = o.O
      const u = isU(o)
      const turn: Turn = u ? 'u' : Math.abs(o.alpha) < 0.5 ? 'straight' : o.alpha * side < 0 ? 'kerb' : 'far'
      for (let i = 0; i < n; i++) {
        // carril del arcén: giros hacia el arcén y de frente; carril de fuera: giros al otro lado y de frente
        const ok = n === 1 || oi === main || (oi < main && i === 0) || (oi > main && i === n - 1)
        if (!ok) continue
        let j: number
        if (oi < main) j = 0
        else if (oi > main) j = O.n - 1
        else j = Math.min(i, O.n - 1)
        const m = makeMove(c, L, i, O, j, turn, o.path, isRing, side)
        if (!m) continue
        all.push(m)
        c.moves.push(m)
        L.moves.push(m)
        L.lanes[i].moves.push(m)
        O.lanes[j].ins.push(m)
        let entry = L.outs.find((e) => e.to === O)
        if (!entry) L.outs.push((entry = { to: O, byLane: new Array(n).fill(null), turn }))
        entry.byLane[i] = m
      }
    }
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const l = m.get(k)
  if (l) l.push(v)
  else m.set(k, [v])
}

function makeMove(c: Cluster, L: Link, i: number, O: Link, j: number, turn: Turn, path: Array<{ r: Road; fwd: boolean }>, ring: boolean, side: 1 | -1): Move | null {
  const P = { x: 0, z: 0, dx: 0, dz: 0 }
  const Q = { x: 0, z: 0, dx: 0, dz: 0 }
  linkPose(L, L.s1, L.off[i], side, P)
  linkPose(O, O.s0, O.off[j], side, Q)
  const dist = Math.hypot(Q.x - P.x, Q.z - P.z)
  let pts: number[] = []
  // por dentro de un cruce de varios nudos (o de una rotonda): por las calles internas, en su
  // carril (desplazado hacia el arcén), sin los puntos muy cercanos a los extremos
  const way: number[] = []
  if (path.length > 0) {
    for (const { r, fwd } of path) {
      const k = r.x.length
      const n = fwd ? r.nF : r.nB
      const twoWay = r.nF > 0 && r.nB > 0
      const li = Math.min(i, n - 1)
      const off = twoWay ? (n - li - 0.5) * r.lw : ((n - 1) / 2 - li) * r.lw
      for (let q = 0; q < k; q++) {
        const idx = fwd ? q : k - 1 - q
        const nxt = fwd ? Math.min(k - 1, idx + 1) : Math.max(0, idx - 1)
        const prv = fwd ? Math.max(0, idx - 1) : Math.min(k - 1, idx + 1)
        let dx = r.x[nxt] - r.x[prv]
        let dz = r.z[nxt] - r.z[prv]
        const l = Math.hypot(dx, dz) || 1
        dx /= l
        dz /= l
        const x = r.x[idx] + -dz * off * side
        const z = r.z[idx] + dx * off * side
        if (Math.hypot(x - P.x, z - P.z) < 6 || Math.hypot(x - Q.x, z - Q.z) < 6) continue
        way.push(x, z)
      }
    }
  }
  if (way.length > 0) {
    pts = chaikin([P.x, P.z, P.x + P.dx * 2, P.z + P.dz * 2, ...way, Q.x - Q.dx * 2, Q.z - Q.dz * 2, Q.x, Q.z], 3)
  } else {
    let k = Math.max(0.5, Math.min(25, dist * 0.4))
    if (turn === 'u' && dist < 15) k = Math.max(k, 6)
    const c1x = P.x + P.dx * k
    const c1z = P.z + P.dz * k
    const c2x = Q.x - Q.dx * k
    const c2z = Q.z - Q.dz * k
    const steps = Math.max(4, Math.ceil((dist + 2 * k) / 0.5))
    for (let q = 0; q <= steps; q++) {
      const t = q / steps
      const u = 1 - t
      pts.push(
        u * u * u * P.x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * Q.x,
        u * u * u * P.z + 3 * u * u * t * c1z + 3 * u * t * t * c2z + t * t * t * Q.z,
      )
    }
  }
  const res = resample(pts, 1)
  if (res.len < 0.2) {
    // los dos extremos coinciden: un empalme mínimo
    res.x = Float32Array.from([P.x, Q.x])
    res.z = Float32Array.from([P.z, Q.z])
    res.s = Float32Array.from([0, 0.2])
    res.len = 0.2
  }
  const k = res.x.length
  const vmax = new Float32Array(k)
  const vEnd = Math.min(L.vmax[L.vmax.length - 1], O.vmax[0])
  for (let q = 0; q < k; q++) {
    const a = Math.max(0, q - 3)
    const b = Math.min(k - 1, q + 3)
    const R = q > 0 && q < k - 1 ? circumRadius(res.x[a], res.z[a], res.x[q], res.z[q], res.x[b], res.z[b]) : 1e6
    vmax[q] = Math.min(vEnd, Math.max(3, Math.sqrt(2.2 * R)))
  }
  const m: Move = {
    id: nextId++,
    cluster: c,
    from: L,
    lane: i,
    to: O,
    toLane: j,
    x: res.x,
    z: res.z,
    y: new Float32Array(k).fill(NaN),
    s: res.s,
    len: res.len,
    vmax,
    turn,
    level: 1,
    phase: -1,
    zones: [],
    vehs: [],
    committed: [],
    tails: [],
    dIn: [P.dx, P.dz],
    dOut: [Q.dx, Q.dz],
    hidden: L.bri[L.bri.length - 1] === -1 && O.bri[0] === -1,
    laneZones: [],
    single: folds(res.x, res.z, res.s),
    rail: [],
  }
  return m
}

/** ¿Dos puntos del camino separados más de 10 m a lo largo quedan a menos de un coche de ancho? */
function folds(x: Float32Array, z: Float32Array, s: Float32Array): boolean {
  const n = x.length
  if (s[n - 1] < 20) return false
  const W2 = W_CONFLICT * W_CONFLICT
  for (let i = 0; i < n; i += 2) {
    for (let j = i + 2; j < n; j += 2) {
      if (s[j] - s[i] < 10) continue
      const dx = x[j] - x[i]
      const dz = z[j] - z[i]
      if (dx * dx + dz * dz < W2) return true
    }
  }
  return false
}

/** suavizado de Chaikin conservando los extremos */
function chaikin(p: number[], iters: number): number[] {
  let pts = p
  for (let it = 0; it < iters; it++) {
    const o: number[] = [pts[0], pts[1]]
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const ax = pts[i]
      const az = pts[i + 1]
      const bx = pts[i + 2]
      const bz = pts[i + 3]
      o.push(ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25, ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75)
    }
    o.push(pts[pts.length - 2], pts[pts.length - 1])
    pts = o
  }
  return pts
}

/** polilínea remuestreada cada `step` metros */
function resample(p: number[], step: number): { x: Float32Array; z: Float32Array; s: Float32Array; len: number } {
  const n = p.length / 2
  const cum = new Float64Array(n)
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(p[i * 2] - p[i * 2 - 2], p[i * 2 + 1] - p[i * 2 - 1])
  const len = cum[n - 1]
  const k = Math.max(2, Math.ceil(len / step) + 1)
  const x = new Float32Array(k)
  const z = new Float32Array(k)
  const s = new Float32Array(k)
  let j = 0
  for (let q = 0; q < k; q++) {
    const at = (len * q) / (k - 1)
    while (j < n - 2 && cum[j + 1] < at) j++
    const t = (at - cum[j]) / (cum[j + 1] - cum[j] || 1)
    x[q] = p[j * 2] + (p[j * 2 + 2] - p[j * 2]) * t
    z[q] = p[j * 2 + 1] + (p[j * 2 + 3] - p[j * 2 + 1]) * t
    s[q] = at
  }
  return { x, z, s, len }
}

// ---------------------------------------------------------------------------
// Conflictos entre movimientos de un cruce
// ---------------------------------------------------------------------------

async function buildConflicts(ms: Move[], pause: Pause): Promise<number> {
  if (ms.length < 2) return 0
  // rejilla de muestras de todos los movimientos (celdas de 5 m): también entre cruces vecinos
  const CELLM = 5
  const grid = new Map<number, number[]>() // [mov, índice…]
  const key = (cx: number, cz: number) => (cx + 100000) * 200003 + (cz + 100000)
  ms.forEach((m, mi) => {
    for (let q = 0; q < m.x.length; q++) {
      const k = key(Math.floor(m.x[q] / CELLM), Math.floor(m.z[q] / CELLM))
      const l = grid.get(k)
      if (l) l.push(mi, q)
      else grid.set(k, [mi, q])
    }
  })
  // por pareja: muestras cercanas (con la distancia)
  const hits = new Map<number, Array<[number, number, number]>>()
  const W2 = W_WIDE * W_WIDE
  const N = ms.length
  for (let mi = 0; mi < ms.length; mi++) {
    const m = ms[mi]
    await pause()
    for (let q = 0; q < m.x.length; q++) {
      const cx = Math.floor(m.x[q] / CELLM)
      const cz = Math.floor(m.z[q] / CELLM)
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const l = grid.get(key(cx + dx, cz + dz))
          if (!l) continue
          for (let k = 0; k < l.length; k += 2) {
            const mj = l[k]
            if (mj <= mi) continue
            const o = ms[mj]
            // el que sigue al otro (sale de donde el otro llega): no es un conflicto
            if (o.from === m.to || m.from === o.to) continue
            const qj = l[k + 1]
            const ex = o.x[qj] - m.x[q]
            const ez = o.z[qj] - m.z[q]
            const d2 = ex * ex + ez * ez
            if (d2 > W2) continue
            const pk = mi * N + mj
            const arr = hits.get(pk)
            if (arr) arr.push([q, qj, d2])
            else hits.set(pk, [[q, qj, d2]])
          }
        }
      }
    }
  }
  let count = 0
  const WN2 = W_CONFLICT * W_CONFLICT
  for (const [pk, all] of hits) {
    const A = ms[Math.floor(pk / N)]
    const B = ms[pk % N]
    const narrow = all.filter((h) => h[2] <= WN2)
    const wide = narrow.length === 0
    const list = wide ? all : narrow
    let a0 = Infinity
    let a1 = -Infinity
    let b0 = Infinity
    let b1 = -Infinity
    let headSum = 0
    for (const [qa, qb] of list) {
      a0 = Math.min(a0, A.s[qa])
      a1 = Math.max(a1, A.s[qa])
      b0 = Math.min(b0, B.s[qb])
      b1 = Math.max(b1, B.s[qb])
      const da = dirAt(A, qa)
      const db = dirAt(B, qb)
      headSum += Math.abs(Math.acos(Math.max(-1, Math.min(1, da[0] * db[0] + da[1] * db[1]))))
    }
    const head = headSum / list.length
    const sameFrom = A.from === B.from && A.lane === B.lane
    const sameTo = A.to === B.to && A.toLane === B.toLane
    const cross = !sameFrom && !sameTo && head > 0.6
    // tabla de correspondencia (para los tramos compartidos)
    const best = new Map<number, [number, number]>()
    for (const [qa, qb, d2] of list) {
      const prev = best.get(qa)
      if (!prev || d2 < prev[1]) best.set(qa, [qb, d2])
    }
    const keys = [...best.keys()].sort((p, q) => p - q)
    const mapA = new Float32Array(keys.length)
    const mapB = new Float32Array(keys.length)
    keys.forEach((qa, i) => {
      mapA[i] = A.s[qa]
      mapB[i] = B.s[best.get(qa)![0]]
    })
    // los que comparten carril de llegada comparten hasta el final; los que salen del mismo, desde el principio
    if (sameTo) {
      a1 = A.len
      b1 = B.len
    }
    if (sameFrom) {
      a0 = 0
      b0 = 0
    }
    const za: Zone = { other: B, cross, a0, a1, b0, b1, yieldMe: false, wide, mapA, mapB }
    const zb: Zone = { other: A, cross, a0: b0, a1: b1, b0: a0, b1: a1, yieldMe: false, wide, mapA: mapB, mapB: mapA }
    if (!cross) {
      // la tabla de B ordenada por su s
      const idx = [...mapB.keys()].sort((p, q) => mapB[p] - mapB[q])
      zb.mapA = Float32Array.from(idx.map((i) => mapB[i]))
      zb.mapB = Float32Array.from(idx.map((i) => mapA[i]))
    }
    A.zones.push(za)
    B.zones.push(zb)
    count++
  }
  return count
}

function dirAt(m: Move, q: number): [number, number] {
  const a = Math.max(0, q - 1)
  const b = Math.min(m.x.length - 1, q + 1)
  const dx = m.x[b] - m.x[a]
  const dz = m.z[b] - m.z[a]
  const l = Math.hypot(dx, dz) || 1
  return [dx / l, dz / l]
}

// ---------------------------------------------------------------------------
// Prioridad y semáforos
// ---------------------------------------------------------------------------

interface Arm {
  road: Road
  u: [number, number]
  rank: number
  ins: Link[]
}

function decideControl(c: Cluster, side: 1 | -1): void {
  if (c.moves.length === 0) return
  const ringCluster = c.nodes.length > 1 && c.nodes.some((n) => n.roads.some((r) => r.internal && r.ringFull))
  // brazos: cada calle externa que llega al cruce
  const arms: Arm[] = []
  const armOf = new Map<Road, Arm>()
  for (const l of [...c.ins, ...c.outs]) {
    let a = armOf.get(l.road)
    if (!a) {
      // dirección con la que el brazo sale del cruce
      const u = dirFrom(l.road, l.road.a.cluster === c)
      a = { road: l.road, u, rank: l.rank + (l.road.ring >= 0 ? 10 : 0), ins: [] }
      armOf.set(l.road, a)
      arms.push(a)
    }
    if (l.to === c) a.ins.push(l)
  }
  if (ringCluster) {
    c.kind = 'roundabout'
    for (const m of c.moves) m.level = 1
  } else {
    // pasillos: brazos casi paralelos de la misma clase (las dos calzadas de una autovía)
    const corr: Arm[][] = []
    for (const a of arms) {
      const k = corr.find((g) => g[0].rank === a.rank && g[0].u[0] * a.u[0] + g[0].u[1] * a.u[1] > 0.9)
      if (k) k.push(a)
      else corr.push([a])
    }
    const rankOf = (g: Arm[]) => g[0].rank
    const dirOf = (g: Arm[]) => g[0].u
    let major: Set<Arm> | null = null
    if (corr.length >= 3) {
      let best = -Infinity
      let bi = -1
      let bj = -1
      for (let i = 0; i < corr.length; i++) {
        for (let j = i + 1; j < corr.length; j++) {
          const col = -(dirOf(corr[i])[0] * dirOf(corr[j])[0] + dirOf(corr[i])[1] * dirOf(corr[j])[1])
          const sc = rankOf(corr[i]) + rankOf(corr[j]) + 3 * col
          if (sc > best) {
            best = sc
            bi = i
            bj = j
          }
        }
      }
      const pair = [corr[bi], corr[bj]]
      const col = -(dirOf(pair[0])[0] * dirOf(pair[1])[0] + dirOf(pair[0])[1] * dirOf(pair[1])[1])
      const rest = corr.filter((g) => g !== pair[0] && g !== pair[1])
      const minP = Math.min(rankOf(pair[0]), rankOf(pair[1]))
      const maxR = Math.max(...rest.map(rankOf))
      let rival = false
      for (let i = 0; i < rest.length; i++) {
        for (let j = i + 1; j < rest.length; j++) {
          const cc = -(dirOf(rest[i])[0] * dirOf(rest[j])[0] + dirOf(rest[i])[1] * dirOf(rest[j])[1])
          if (cc > 0.8 && Math.min(rankOf(rest[i]), rankOf(rest[j])) >= minP) rival = true
        }
      }
      if (minP > maxR || (col > 0.6 && minP >= maxR && !rival)) major = new Set([...pair[0], ...pair[1]])
      else if (rankOf(pair[0]) !== rankOf(pair[1]) && Math.max(rankOf(pair[0]), rankOf(pair[1])) > maxR) major = new Set([...pair[0], ...pair[1]])
    }
    // semáforo: ciudad, cuatro brazos o más (o tres de entidad), sin autopistas
    const urban = c.ins.some((l) => l.urban)
    const strong = corr.filter((g) => rankOf(g) >= 2 && rankOf(g) < 10).length
    const maxRank = Math.max(...arms.map((a) => a.rank))
    const signal = urban && maxRank <= 4 && c.ins.length >= 2 && ((corr.length >= 4 && strong >= 3) || (corr.length === 3 && strong >= 3 && arms.every((a) => a.rank >= 3)))
    if (signal) {
      c.kind = 'signal'
      // fases: brazos de entrada enfrentados juntos
      const phaseOf = new Map<Arm, number>()
      const inArms = arms.filter((a) => a.ins.length > 0)
      let np = 0
      for (const a of inArms) {
        if (phaseOf.has(a)) continue
        const p = np++
        phaseOf.set(a, p)
        for (const b of inArms) {
          if (phaseOf.has(b)) continue
          if (a.u[0] * b.u[0] + a.u[1] * b.u[1] < -0.6) phaseOf.set(b, p)
        }
      }
      if (np < 2) c.kind = 'priority'
      else {
        c.greens = []
        for (let p = 0; p < np; p++) {
          const rk = Math.max(...inArms.filter((a) => phaseOf.get(a) === p).map((a) => a.rank))
          c.greens.push(14 + 4 * rk)
        }
        c.cycle = c.greens.reduce((s, g) => s + g + 5, 0)
        c.offset = (c.id * 7.31) % c.cycle
        for (const m of c.moves) {
          m.phase = phaseOf.get(armOf.get(m.from.road)!) ?? 0
          m.level = 1
        }
      }
    }
    if (c.kind !== 'signal') {
      c.kind = major ? 'priority' : 'equal'
      for (const m of c.moves) m.level = major && major.has(armOf.get(m.from.road)!) ? 2 : 1
    }
  }
  // quién cede en cada zona
  for (const m of c.moves) {
    for (const z of m.zones) z.yieldMe = z.other.cluster === c && yields(c, m, z.other, side)
  }
}

/** ¿El movimiento a cede ante b? (en las rotondas solo cuenta quién ya está dentro) */
function yields(c: Cluster, a: Move, b: Move, side: 1 | -1): boolean {
  if (c.kind === 'roundabout') return false
  if (a.level !== b.level) return a.level < b.level
  if (a.from === b.from) return false
  const opposite = a.dIn[0] * b.dIn[0] + a.dIn[1] * b.dIn[1] < -0.5
  const tr = (m: Move) => (m.turn === 'u' ? 0 : m.turn === 'far' ? 1 : 2)
  if (opposite) return tr(a) < tr(b)
  if (a.dIn[0] * b.dIn[0] + a.dIn[1] * b.dIn[1] > 0.7) {
    // misma dirección (incorporación): cede el que viene del lado del arcén... salvo ese caso, nadie
    return false
  }
  // b viene por el lado del arcén de a (derecha si se circula por la derecha)
  const cr = turnAngle(a.dIn[0], a.dIn[1], b.dIn[0], b.dIn[1])
  return side === 1 ? cr > 0 : cr < 0
}

/** Enlaces desde los que se puede seguir circulando (salir de la región o dar vueltas). */
function markLive(links: Link[]): void {
  // grafo inverso
  const preds = new Map<Link, Link[]>()
  for (const l of links) for (const o of l.outs) push(preds, o.to, l)
  // componentes fuertemente conexas (Tarjan iterativo)
  const index = new Map<Link, number>()
  const low = new Map<Link, number>()
  const onStack = new Set<Link>()
  const stack: Link[] = []
  let idx = 0
  const good = new Set<Link>()
  for (const root of links) {
    if (index.has(root)) continue
    const work: Array<{ l: Link; i: number }> = [{ l: root, i: 0 }]
    index.set(root, idx)
    low.set(root, idx++)
    stack.push(root)
    onStack.add(root)
    while (work.length) {
      const top = work[work.length - 1]
      const outs = top.l.outs
      if (top.i < outs.length) {
        const w = outs[top.i++].to
        if (!index.has(w)) {
          index.set(w, idx)
          low.set(w, idx++)
          stack.push(w)
          onStack.add(w)
          work.push({ l: w, i: 0 })
        } else if (onStack.has(w)) low.set(top.l, Math.min(low.get(top.l)!, index.get(w)!))
      } else {
        work.pop()
        if (work.length) low.set(work[work.length - 1].l, Math.min(low.get(work[work.length - 1].l)!, low.get(top.l)!))
        if (low.get(top.l) === index.get(top.l)) {
          const comp: Link[] = []
          for (;;) {
            const w = stack.pop()!
            onStack.delete(w)
            comp.push(w)
            if (w === top.l) break
          }
          if (comp.length > 1) for (const w of comp) good.add(w)
        }
      }
    }
  }
  for (const l of links) if (l.to === null) good.add(l)
  // todo lo que llega a un enlace bueno
  const queue = [...good]
  for (const l of good) l.live = true
  while (queue.length) {
    const l = queue.pop()!
    for (const p of preds.get(l) ?? []) {
      if (p.live) continue
      p.live = true
      queue.push(p)
    }
  }
}

// ---------------------------------------------------------------------------
// Movimientos que pasan por encima de un carril de otra calle
// ---------------------------------------------------------------------------

/**
 * En cruces grandes o con calles muy juntas, el camino de un giro puede pasar sobre el carril de
 * una calle que no es la suya (ni la de entrada ni la de salida). Se apunta el tramo de los dos:
 * quien gira cede a los de ese carril y los de ese carril frenan si alguien lo está cruzando.
 */
async function buildLaneZones(moves: Move[], links: Link[], side: 1 | -1, pause: Pause): Promise<number> {
  // rejilla de segmentos de los ejes de los enlaces (celdas de 10 m)
  const CELL = 10
  const grid = new Map<number, number[]>() // [enlace, segmento…]
  const key = (cx: number, cz: number) => (cx + 100000) * 200003 + (cz + 100000)
  links.forEach((l, li) => {
    const maxOff = (l.n + 0.5) * l.lw
    for (let i = 0; i + 1 < l.x.length; i++) {
      if (l.s[i + 1] < l.s0 || l.s[i] > l.s1) continue
      const x0 = Math.min(l.x[i], l.x[i + 1]) - maxOff - W_CONFLICT
      const x1 = Math.max(l.x[i], l.x[i + 1]) + maxOff + W_CONFLICT
      const z0 = Math.min(l.z[i], l.z[i + 1]) - maxOff - W_CONFLICT
      const z1 = Math.max(l.z[i], l.z[i + 1]) + maxOff + W_CONFLICT
      for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
        for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
          const k = key(cx, cz)
          const arr = grid.get(k)
          if (arr) arr.push(li, i)
          else grid.set(k, [li, i])
        }
      }
    }
  })
  let count = 0
  for (const m of moves) {
    await pause()
    // nivel del movimiento: el del final del enlace de entrada
    const mb = m.from.bri[m.from.bri.length - 1]
    const ml = mb !== 0 ? m.from.layer[m.from.layer.length - 1] : 0
    // por carril tocado: tramo en el movimiento y en el carril
    const found = new Map<string, { lane: Lane; a0: number; a1: number; s0: number; s1: number }>()
    for (let q = 0; q < m.x.length; q++) {
      const px = m.x[q]
      const pz = m.z[q]
      const arr = grid.get(key(Math.floor(px / CELL), Math.floor(pz / CELL)))
      if (!arr) continue
      for (let k = 0; k < arr.length; k += 2) {
        const l = links[arr[k]]
        const i = arr[k + 1]
        // las calles de entrada y salida: solo lejos de la boca del cruce (ahí sus carriles van
        // pegados al movimiento por diseño)
        const ownIn = l.road === m.from.road
        const ownOut = l.road === m.to.road
        // mismo nivel
        const lb = l.bri[i]
        const ll = lb !== 0 ? l.layer[i] : 0
        if (lb !== mb || ll !== ml) continue
        const ax = l.x[i]
        const az = l.z[i]
        let dx = l.x[i + 1] - ax
        let dz = l.z[i + 1] - az
        const L = Math.hypot(dx, dz)
        if (L < 1e-6) continue
        dx /= L
        dz /= L
        const t = (px - ax) * dx + (pz - az) * dz
        if (t < -0.5 || t > L + 0.5) continue
        const s = l.s[i] + Math.max(0, Math.min(L, t))
        if (s < l.s0 || s > l.s1) continue
        const atEnd = l.s1 - s < 12
        const atStart = s - l.s0 < 12
        if (ownIn && ((l === m.from && atEnd) || (l !== m.from && atStart))) continue
        if (ownOut && ((l === m.to && atStart) || (l !== m.to && atEnd))) continue
        // desplazamiento lateral hacia el arcén
        const lat = ((px - ax) * -dz + (pz - az) * dx) * side
        for (let li = 0; li < l.n; li++) {
          if (Math.abs(lat - l.off[li]) > W_CONFLICT) continue
          const id = `${l.id}:${li}`
          const f = found.get(id)
          if (!f) found.set(id, { lane: l.lanes[li], a0: m.s[q], a1: m.s[q], s0: s, s1: s })
          else {
            f.a0 = Math.min(f.a0, m.s[q])
            f.a1 = Math.max(f.a1, m.s[q])
            f.s0 = Math.min(f.s0, s)
            f.s1 = Math.max(f.s1, s)
          }
        }
      }
    }
    for (const f of found.values()) {
      const z: LaneZone = { tok: { stream: null, t: -1e9 }, move: m, lane: f.lane, a0: f.a0 - 1, a1: f.a1 + 1, s0: f.s0 - 1, s1: f.s1 + 1 }
      m.laneZones.push(z)
      f.lane.zones.push(z)
      count++
    }
  }
  return count
}

// ---------------------------------------------------------------------------
// Carriles de calles distintas que se tocan
// ---------------------------------------------------------------------------

/**
 * Carriles de calles distintas que en el mapa quedan más cerca que un coche de ancho (dos calzadas
 * dibujadas casi encima, una calle que corre pegada a otra) y, en las curvas cerradas de una calle
 * de doble sentido, los dos carriles (ahí un camión invade el contrario). Se apunta el tramo de cada
 * uno: no se entra si el otro tramo está ocupado. Las curvas solo cuentan con vehículos largos.
 */
async function buildLaneLaneZones(links: Link[], side: 1 | -1, pause: Pause): Promise<number> {
  const STEP = 2
  const CELL = 8
  type Smp = { l: Link; lane: number; s: number; x: number; z: number; dx: number; dz: number; tight: boolean; hairpin: boolean; lvl: number }
  const grid = new Map<number, Smp[]>()
  const key = (cx: number, cz: number) => (cx + 100000) * 200003 + (cz + 100000)
  const P = { x: 0, z: 0, dx: 0, dz: 0 }
  for (const l of links) {
    await pause()
    for (let s = l.s0; s <= l.s1; s += STEP) {
      const i = segIdx(l, s)
      const lvl = l.bri[i] !== 0 ? l.bri[i] * 100 + l.layer[i] : 0
      if (l.bri[i] === -1) continue // en un túnel no se ve
      // curva cerrada para un vehículo largo (radio < ~45 m: vmax < √(2,2·45)); en una calle de
      // doble sentido estrecha la cola de un autobús de 12 m ya se mete medio metro en el contrario
      const vm = Math.min(l.vmax[i], l.vmax[Math.min(i + 1, l.vmax.length - 1)])
      const tight = vm < 10
      // horquilla (radio < ~12 m): ahí los carriles se tocan para cualquiera
      const hairpin = vm < 5.2
      for (let li = 0; li < l.n; li++) {
        linkPose(l, s, l.off[li], side, P)
        const smp: Smp = { l, lane: li, s, x: P.x, z: P.z, dx: P.dx, dz: P.dz, tight, hairpin, lvl }
        const k = key(Math.floor(P.x / CELL), Math.floor(P.z / CELL))
        const arr = grid.get(k)
        if (arr) arr.push(smp)
        else grid.set(k, [smp])
      }
    }
  }
  const pairs = new Map<string, { a: Smp; b: Smp; a0: number; a1: number; b0: number; b1: number; wide: boolean }>()
  const W2 = W_CONFLICT * W_CONFLICT
  for (const [k0, arr] of grid) {
    await pause()
    const cx = Math.floor(k0 / 200003) - 100000
    const cz = (k0 % 200003) - 100000
    for (const a of arr) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const other = grid.get(key(cx + dx, cz + dz))
          if (!other) continue
          for (const b of other) {
            if (b.l === a.l || b.l.id < a.l.id || b.lvl !== a.lvl) continue
            const sameRoad = b.l.road === a.l.road
            // los dos sentidos de una calle están pegados por diseño: solo cuentan en curvas cerradas
            if (sameRoad && !(a.tight || b.tight)) continue
            const ex = b.x - a.x
            const ez = b.z - a.z
            if (ex * ex + ez * ez > W2) continue
            // calles que se juntan en un cruce: eso ya lo lleva el cruce
            if (a.l.to && (a.l.to === b.l.to || a.l.to === b.l.from)) {
              const nearEnd = a.l.s1 - a.s < 30 || (b.l.to === a.l.to ? b.l.s1 - b.s < 30 : b.s - b.l.s0 < 30)
              if (nearEnd) continue
            }
            if (a.l.from && (a.l.from === b.l.from || a.l.from === b.l.to)) {
              const nearStart = a.s - a.l.s0 < 30 || (b.l.from === a.l.from ? b.s - b.l.s0 < 30 : b.l.s1 - b.s < 30)
              if (nearStart) continue
            }
            const id = `${a.l.id}:${a.lane}:${b.l.id}:${b.lane}`
            const p = pairs.get(id)
            if (!p) pairs.set(id, { a, b, a0: a.s, a1: a.s, b0: b.s, b1: b.s, wide: sameRoad && !(a.hairpin || b.hairpin) })
            else {
              p.a0 = Math.min(p.a0, a.s)
              p.a1 = Math.max(p.a1, a.s)
              p.b0 = Math.min(p.b0, b.s)
              p.b1 = Math.max(p.b1, b.s)
              if (a.hairpin || b.hairpin) p.wide = false
            }
          }
        }
      }
    }
  }
  let n = 0
  for (const p of pairs.values()) {
    const la = p.a.l.lanes[p.a.lane]
    const lb = p.b.l.lanes[p.b.lane]
    const tok: Token = { stream: null, t: -1e9 }
    // en las curvas cerradas la caja de un camión barre más allá del tramo de curva: medio camión más
    const m = p.a.l.road === p.b.l.road ? (p.wide ? 10 : 5) : 2
    const za: LaneLane = { tok, other: lb, s0: p.a0 - m, s1: p.a1 + m, o0: p.b0 - m, o1: p.b1 + m, wide: p.wide }
    const zb: LaneLane = { tok, other: la, s0: p.b0 - m, s1: p.b1 + m, o0: p.a0 - m, o1: p.a1 + m, wide: p.wide }
    la.near.push(za)
    lb.near.push(zb)
    n++
  }
  return n
}

function segIdx(l: Link, s: number): number {
  let lo = 0
  let hi = l.s.length - 1
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1
    if (l.s[m] <= s) lo = m
    else hi = m
  }
  return Math.min(lo, l.bri.length - 1)
}
