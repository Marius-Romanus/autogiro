// Barcos en el agua de OpenStreetMap: de recreo (veleros, yates, lanchas), pesqueros, de río
// (turísticos y gabarras), mercantes (fondeados frente al puerto, atracados en los muelles y de
// paso) y los transbordadores de las líneas de ferri (rutas de ferry.ts).
//
// El agua de la región (capa `water`: mar, lagos y embalses, ríos anchos y dársenas) se pasa a una
// rejilla de 5 m con la distancia de cada celda a la orilla (los pantalanes y los barcos quietos
// cuentan como orilla). Los amarrados se colocan a lo largo de los pantalanes de los puertos
// deportivos (popa al pantalán, como en el Mediterráneo), los mercantes atracados en los muelles
// de las zonas industriales junto al mar y los fondeados en la rada, a más de 700 m de la costa;
// todo sale de un hash de la posición geográfica, así que al cambiar de región vuelven los mismos
// barcos al mismo sitio.
//
// Los que navegan van de un punto a otro por un camino (A* en una rejilla de 20 m que guarda la
// distancia mínima a la orilla de cada bloque, con un margen según el barco) y se apartan unos de
// otros con las reglas de la mar: el que tiene al otro por estribor cede, de frente los dos caen a
// estribor, el que alcanza se aparta, y los de recreo ceden a los de trabajo, estos a los ferris y
// los ferris a los mercantes. Ceder es aflojar o parar o, si eso no basta, caer a estribor. Al
// final hay una red de seguridad: un paso que dejaría dos cascos (cápsulas) tocándose o un casco
// sobre tierra no se da. Sin three.js ni DOM (worker y Node).

import { E, type RoadTile } from './roads.ts'
import { rng } from './sim.ts'
import { latToY, lonToX, xToLon, yToLat } from '../world/mapTiles.ts'
import type { Route } from './ferry.ts'

const NZ = 2 ** 14
/** celdas finas por celda gruesa (de lado) */
const CF = 4

export interface BoatSpec {
  /** eslora del modelo (m): cada barco se escala a la suya */
  base: number
  len: [number, number]
  /** manga / eslora */
  beam: number
  /** velocidad de crucero (m/s) */
  vmax: [number, number]
  /** quién se aparta: 0 recreo, 1 trabajo, 2 ferri, 3 mercante, 4 inmóvil */
  prio: number
  /** distancia a la orilla al navegar (m, además de media manga) */
  clear: number
  /** radio de giro mínimo (esloras) y giro con poca arrancada (rad/s) */
  turn: number
  pivot: number
  /** aceleración (m/s²) */
  acc: number
}

export const BOAT = { sail: 0, moored: 1, yacht: 2, motor: 3, fishing: 4, tour: 5, barge: 6, container: 7, tanker: 8, bulk: 9 }

export const BOATS: BoatSpec[] = [
  { base: 12, len: [8, 15], beam: 0.32, vmax: [2.5, 4], prio: 0, clear: 12, turn: 1.5, pivot: 0.12, acc: 0.15 },
  { base: 12, len: [8, 15], beam: 0.32, vmax: [0, 0], prio: 4, clear: 0, turn: 1, pivot: 0, acc: 0 },
  { base: 18, len: [12, 26], beam: 0.27, vmax: [6, 10], prio: 0, clear: 14, turn: 2, pivot: 0.08, acc: 0.4 },
  { base: 6.5, len: [5, 8.5], beam: 0.36, vmax: [6, 12], prio: 0, clear: 8, turn: 1.5, pivot: 0.2, acc: 0.8 },
  { base: 16, len: [12, 24], beam: 0.3, vmax: [3, 5], prio: 1, clear: 14, turn: 2, pivot: 0.06, acc: 0.12 },
  { base: 40, len: [28, 55], beam: 0.19, vmax: [2.8, 4.2], prio: 1, clear: 6, turn: 2, pivot: 0.06, acc: 0.12 },
  { base: 80, len: [38, 110], beam: 0.115, vmax: [2.8, 4], prio: 1, clear: 6, turn: 3, pivot: 0.03, acc: 0.05 },
  { base: 250, len: [170, 300], beam: 0.15, vmax: [6, 9], prio: 3, clear: 120, turn: 4, pivot: 0.002, acc: 0.02 },
  { base: 220, len: [150, 250], beam: 0.18, vmax: [5, 7], prio: 3, clear: 120, turn: 4, pivot: 0.002, acc: 0.015 },
  { base: 200, len: [140, 230], beam: 0.16, vmax: [5, 7], prio: 3, clear: 120, turn: 4, pivot: 0.002, acc: 0.015 },
]

/** transbordadores (los modelos de ferry): eslora nominal y manga/eslora de lancha y ferri grande */
export const FERRY_SPEC = [
  { base: 32, beam: 8 / 32, len: [28, 42] as [number, number] },
  { base: 140, beam: 24 / 140, len: [110, 180] as [number, number] },
]

/** margen de paso (m) según la prioridad */
const MARGIN = [5, 8, 14, 40, 6]

export interface Vessel {
  id: number
  /** tipo (BOATS); los ferris -1 (lancha) y -2 (grande) */
  kind: number
  /** centro, rumbo (adelante = cos h, sin h en x, z) y velocidad */
  x: number
  z: number
  h: number
  v: number
  len: number
  beam: number
  vmax: number
  prio: number
  /** clase del agua: 1 mar o dársena, 2 lago, 3 río */
  water: number
  /** 0 navegando, 1 parado un rato, 2 fondeado (no se mueve) */
  mode: number
  path: Float32Array | null
  pi: number
  goalX: number
  goalZ: number
  wait: number
  stuck: number
  legs: number
  avoid: number
  avoidH: number
  /** cuenta atrás para comprobar el camino */
  chk: number
  /** a quién está cediendo el paso ahora */
  yieldTo: Vessel | null
  /** velocidad máxima tras mirar a los demás (se recalcula cada cuarto de segundo) */
  capV: number
  rT: number
  y: number
  yT: number
  color: number
  transit: boolean
  dead: boolean
  // ferris
  route: Route | null
  dir: 1 | -1
  s: number
  dwell: number
}

/** barco quieto (amarrado, atracado o fondeado): lo dibuja el hilo principal una sola vez */
export interface StaticBoat {
  x: number
  z: number
  y: number
  h: number
  kind: number
  len: number
  color: number
  water: number
}

// ---------------------------------------------------------------------------
// geometría
// ---------------------------------------------------------------------------

function hash3(a: number, b: number, c: number): number {
  let h = Math.imul((a | 0) ^ 0x2545f491, 0x9e3779b1)
  h = Math.imul(h ^ (b | 0) ^ (h >>> 15), 0x85ebca77)
  h = Math.imul(h ^ (c | 0) ^ (h >>> 13), 0xc2b2ae3d)
  h ^= h >>> 16
  h = Math.imul(h, 0x27d4eb2f)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

function segDist2(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax
  const dz = bz - az
  const l2 = dx * dx + dz * dz
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const qx = ax + dx * t - px
  const qz = az + dz * t - pz
  return qx * qx + qz * qz
}

function orient(ax: number, az: number, bx: number, bz: number, cx: number, cz: number): number {
  return (bx - ax) * (cz - az) - (bz - az) * (cx - ax)
}

function segCross(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): boolean {
  const o1 = orient(ax, az, bx, bz, cx, cz)
  const o2 = orient(ax, az, bx, bz, dx, dz)
  const o3 = orient(cx, cz, dx, dz, ax, az)
  const o4 = orient(cx, cz, dx, dz, bx, bz)
  return o1 * o2 < 0 && o3 * o4 < 0
}

function segSeg(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): number {
  if (segCross(ax, az, bx, bz, cx, cz, dx, dz)) return 0
  return Math.sqrt(Math.min(segDist2(ax, az, cx, cz, dx, dz), segDist2(bx, bz, cx, cz, dx, dz), segDist2(cx, cz, ax, az, bx, bz), segDist2(dx, dz, ax, az, bx, bz)))
}

/** holgura entre dos cascos (cápsulas: eje de largo L − B, radio B/2); negativa si se pisan */
export function hullClear(x1: number, z1: number, h1: number, L1: number, B1: number, x2: number, z2: number, h2: number, L2: number, B2: number): number {
  const a1 = Math.max(0, L1 / 2 - B1 / 2)
  const a2 = Math.max(0, L2 / 2 - B2 / 2)
  const c1 = Math.cos(h1) * a1
  const s1 = Math.sin(h1) * a1
  const c2 = Math.cos(h2) * a2
  const s2 = Math.sin(h2) * a2
  return segSeg(x1 + c1, z1 + s1, x1 - c1, z1 - s1, x2 + c2, z2 + s2, x2 - c2, z2 - s2) - B1 / 2 - B2 / 2
}

function angDiff(a: number, b: number): number {
  let d = a - b
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return d
}

// ---------------------------------------------------------------------------
// orillas exactas (aristas de los polígonos de agua y pantalanes) en cubos de 20 m
// ---------------------------------------------------------------------------

class EdgeHash {
  private readonly B = 20
  private readonly map = new Map<number, number[]>()
  /** x0, z0, x1, z1, tipo (0 orilla, 1 pantalán) */
  readonly e: number[] = []
  private mark = new Uint32Array(0)
  private q = 0

  private key(ix: number, iz: number): number {
    return (ix + 40000) * 80000 + (iz + 40000)
  }

  add(x0: number, z0: number, x1: number, z1: number, kind: number): void {
    const L = Math.hypot(x1 - x0, z1 - z0)
    if (L > 60) {
      // las largas, a trozos (si no, ocupan muchos cubos)
      const n = Math.ceil(L / 60)
      for (let k = 0; k < n; k++) this.add(x0 + ((x1 - x0) * k) / n, z0 + ((z1 - z0) * k) / n, x0 + ((x1 - x0) * (k + 1)) / n, z0 + ((z1 - z0) * (k + 1)) / n, kind)
      return
    }
    const i = this.e.length / 5
    this.e.push(x0, z0, x1, z1, kind)
    const B = this.B
    for (let ix = Math.floor(Math.min(x0, x1) / B); ix <= Math.floor(Math.max(x0, x1) / B); ix++) {
      for (let iz = Math.floor(Math.min(z0, z1) / B); iz <= Math.floor(Math.max(z0, z1) / B); iz++) {
        const k = this.key(ix, iz)
        let l = this.map.get(k)
        if (!l) this.map.set(k, (l = []))
        l.push(i)
      }
    }
  }

  /** aristas que tocan el rectángulo; `fn` devuelve true para parar */
  near(x0: number, z0: number, x1: number, z1: number, fn: (i: number) => boolean | void): void {
    const n = this.e.length / 5
    if (this.mark.length < n) this.mark = new Uint32Array(n + 1024)
    const q = ++this.q
    const B = this.B
    for (let ix = Math.floor(x0 / B); ix <= Math.floor(x1 / B); ix++) {
      for (let iz = Math.floor(z0 / B); iz <= Math.floor(z1 / B); iz++) {
        const l = this.map.get(this.key(ix, iz))
        if (!l) continue
        for (const i of l) {
          if (this.mark[i] === q) continue
          this.mark[i] = q
          if (fn(i)) return
        }
      }
    }
  }

  /** ¿algún borde a menos de `r` del segmento? */
  touches(ax: number, az: number, bx: number, bz: number, r: number): boolean {
    let hit = false
    const e = this.e
    this.near(Math.min(ax, bx) - r, Math.min(az, bz) - r, Math.max(ax, bx) + r, Math.max(az, bz) + r, (i) => {
      const o = i * 5
      if (segSeg(ax, az, bx, bz, e[o], e[o + 1], e[o + 2], e[o + 3]) < r) return (hit = true)
    })
    return hit
  }

  /** distancia del segmento al borde más cercano (hasta `max`) */
  segDist(ax: number, az: number, bx: number, bz: number, max: number): number {
    let best = max
    const e = this.e
    this.near(Math.min(ax, bx) - max, Math.min(az, bz) - max, Math.max(ax, bx) + max, Math.max(az, bz) + max, (i) => {
      const o = i * 5
      const d = segSeg(ax, az, bx, bz, e[o], e[o + 1], e[o + 2], e[o + 3])
      if (d < best) best = d
    })
    return best
  }

  /** cruces del segmento con las orillas (no los pantalanes) */
  crossings(ax: number, az: number, bx: number, bz: number): number {
    let n = 0
    const e = this.e
    this.near(Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz), (i) => {
      const o = i * 5
      if (e[o + 4] === 0 && segCross(ax, az, bx, bz, e[o], e[o + 1], e[o + 2], e[o + 3])) n++
    })
    return n
  }

  /** distancia al borde más cercano (hasta `max`) */
  dist(x: number, z: number, max: number): number {
    let best = max * max
    const e = this.e
    this.near(x - max, z - max, x + max, z + max, (i) => {
      const o = i * 5
      const d = segDist2(x, z, e[o], e[o + 1], e[o + 2], e[o + 3])
      if (d < best) best = d
    })
    return Math.sqrt(best)
  }
}

// ---------------------------------------------------------------------------
// rejilla del agua
// ---------------------------------------------------------------------------

export class WaterGrid {
  readonly cell: number
  readonly x0: number
  readonly z0: number
  readonly nx: number
  readonly nz: number
  /** clase del agua por celda (0 tierra); bit 0x80: tierra industrial */
  readonly cls: Uint8Array
  /** agua del mapa sin pantalanes ni barcos */
  wat: Uint8Array = new Uint8Array(0)
  /** distancia a la orilla (dm) */
  dist: Uint16Array = new Uint16Array(0)
  cnx = 0
  cnz = 0
  /** distancia mínima a la orilla de cada bloque grueso (dm) */
  cdist: Uint16Array = new Uint16Array(0)
  /** penalización de paso (cerca de las líneas de ferri) */
  pen: Uint8Array = new Uint8Array(0)
  readonly edges = new EdgeHash()
  /** rectángulo de la región (x0, z0, x1, z1) */
  readonly region: [number, number, number, number]

  constructor(x0: number, z0: number, nx: number, nz: number, cell: number, region: [number, number, number, number]) {
    this.x0 = x0
    this.z0 = z0
    this.nx = nx
    this.nz = nz
    this.cell = cell
    this.cls = new Uint8Array(nx * nz)
    this.region = region
  }

  idx(x: number, z: number): number {
    const i = Math.floor((x - this.x0) / this.cell)
    const j = Math.floor((z - this.z0) / this.cell)
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return -1
    return j * this.nx + i
  }

  water(x: number, z: number): number {
    const i = this.idx(x, z)
    return i < 0 ? 0 : this.cls[i] & 0x7f
  }

  /** distancia a la orilla (m); fuera de la rejilla: tierra, salvo fuera de la región (mar abierto) */
  distAt(x: number, z: number): number {
    const i = this.idx(x, z)
    if (i >= 0) return this.dist[i] / 10
    const r = this.region
    return x < r[0] || z < r[1] || x > r[2] || z > r[3] ? 9999 : 0
  }

  /** ¿el punto está en el agua del mapa? exacto: el centro de la celda y los cruces con la orilla */
  inWater(x: number, z: number): boolean {
    const i = this.idx(x, z)
    if (i < 0) return false
    const cx = this.x0 + ((i % this.nx) + 0.5) * this.cell
    const cz = this.z0 + (Math.floor(i / this.nx) + 0.5) * this.cell
    const base = this.wat[i] > 0
    return this.edges.crossings(x, z, cx, cz) % 2 === 1 ? !base : base
  }

  /** rellena polígonos (anillos en x, z alternados) por par-impar; `set` recibe cada celda */
  fill(rings: number[][], set: (i: number) => void): void {
    let zmin = Infinity
    let zmax = -Infinity
    for (const r of rings) {
      for (let k = 1; k < r.length; k += 2) {
        if (r[k] < zmin) zmin = r[k]
        if (r[k] > zmax) zmax = r[k]
      }
    }
    const c = this.cell
    const j0 = Math.max(0, Math.ceil((zmin - this.z0) / c - 0.5))
    const j1 = Math.min(this.nz - 1, Math.floor((zmax - this.z0) / c - 0.5))
    if (j1 < j0) return
    const rows: number[][] = []
    for (let j = j0; j <= j1; j++) rows.push([])
    for (const r of rings) {
      const n = r.length / 2
      for (let k = 0; k < n; k++) {
        const ax = r[k * 2]
        const az = r[k * 2 + 1]
        const bx = r[((k + 1) % n) * 2]
        const bz = r[((k + 1) % n) * 2 + 1]
        if (az === bz) continue
        const lo = Math.min(az, bz)
        const hi = Math.max(az, bz)
        const ja = Math.max(j0, Math.ceil((lo - this.z0) / c - 0.5))
        const jb = Math.min(j1, Math.ceil((hi - this.z0) / c - 0.5) - 1)
        for (let j = ja; j <= jb; j++) {
          const zc = this.z0 + (j + 0.5) * c
          rows[j - j0].push(ax + ((zc - az) * (bx - ax)) / (bz - az))
        }
      }
    }
    for (let j = j0; j <= j1; j++) {
      const xs = rows[j - j0]
      if (xs.length < 2) continue
      xs.sort((a, b) => a - b)
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil((xs[k] - this.x0) / c - 0.5))
        const i1 = Math.min(this.nx - 1, Math.ceil((xs[k + 1] - this.x0) / c - 0.5) - 1)
        for (let i = i0; i <= i1; i++) set(j * this.nx + i)
      }
    }
  }

  /** marca como tierra las celdas a menos de `r` de un segmento */
  stampSeg(ax: number, az: number, bx: number, bz: number, r: number): void {
    const c = this.cell
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - r - this.x0) / c))
    const i1 = Math.min(this.nx - 1, Math.floor((Math.max(ax, bx) + r - this.x0) / c))
    const j0 = Math.max(0, Math.floor((Math.min(az, bz) - r - this.z0) / c))
    const j1 = Math.min(this.nz - 1, Math.floor((Math.max(az, bz) + r - this.z0) / c))
    const rr = (r + c * 0.5) * (r + c * 0.5)
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = this.x0 + (i + 0.5) * c
        const z = this.z0 + (j + 0.5) * c
        if (segDist2(x, z, ax, az, bx, bz) <= rr) this.cls[j * this.nx + i] = 0
      }
    }
  }

  stampHull(x: number, z: number, h: number, L: number, B: number, margin: number): void {
    const a = Math.max(0, L / 2 - B / 2)
    this.stampSeg(x + Math.cos(h) * a, z + Math.sin(h) * a, x - Math.cos(h) * a, z - Math.sin(h) * a, B / 2 + margin)
  }

  /** distancia a la orilla (transformada de chaflán) y la rejilla gruesa */
  computeDist(): void {
    const { nx, nz, cls } = this
    const d = new Uint16Array(nx * nz)
    const o = Math.round(this.cell * 10)
    const g = Math.round(this.cell * 14.142)
    for (let i = 0; i < d.length; i++) d[i] = cls[i] & 0x7f ? 65535 : 0
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i
        let m = d[k]
        if (m === 0) continue
        if (i > 0) m = Math.min(m, d[k - 1] + o)
        if (j > 0) {
          m = Math.min(m, d[k - nx] + o)
          if (i > 0) m = Math.min(m, d[k - nx - 1] + g)
          if (i < nx - 1) m = Math.min(m, d[k - nx + 1] + g)
        }
        d[k] = Math.min(65535, m)
      }
    }
    for (let j = nz - 1; j >= 0; j--) {
      for (let i = nx - 1; i >= 0; i--) {
        const k = j * nx + i
        let m = d[k]
        if (m === 0) continue
        if (i < nx - 1) m = Math.min(m, d[k + 1] + o)
        if (j < nz - 1) {
          m = Math.min(m, d[k + nx] + o)
          if (i < nx - 1) m = Math.min(m, d[k + nx + 1] + g)
          if (i > 0) m = Math.min(m, d[k + nx - 1] + g)
        }
        d[k] = Math.min(65535, m)
      }
    }
    this.dist = d
    this.cnx = Math.ceil(nx / CF)
    this.cnz = Math.ceil(nz / CF)
    const cd = new Uint16Array(this.cnx * this.cnz).fill(65535)
    for (let j = 0; j < nz; j++) {
      const cj = Math.floor(j / CF) * this.cnx
      for (let i = 0; i < nx; i++) {
        const c = cj + Math.floor(i / CF)
        const v = d[j * nx + i]
        if (v < cd[c]) cd[c] = v
      }
    }
    this.cdist = cd
    this.pen = new Uint8Array(cd.length)
  }

  /** centro de una celda gruesa */
  cpos(c: number): [number, number] {
    const s = this.cell * CF
    return [this.x0 + ((c % this.cnx) + 0.5) * s, this.z0 + (Math.floor(c / this.cnx) + 0.5) * s]
  }

  cidx(x: number, z: number): number {
    const s = this.cell * CF
    const i = Math.floor((x - this.x0) / s)
    const j = Math.floor((z - this.z0) / s)
    if (i < 0 || j < 0 || i >= this.cnx || j >= this.cnz) return -1
    return j * this.cnx + i
  }

  /** ¿se ve un punto desde otro sin acercarse a menos de `clear` m de la orilla? */
  los(ax: number, az: number, bx: number, bz: number, clear: number): boolean {
    const L = Math.hypot(bx - ax, bz - az)
    const n = Math.max(1, Math.ceil(L / this.cell))
    for (let k = 0; k <= n; k++) if (this.distAt(ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n) < clear) return false
    return true
  }

  /**
   * Camino de (sx, sz) a (gx, gz) sin acercarse a menos de `clear` m de la orilla: A* en la rejilla
   * gruesa (8 vecinos, más caro cerca de la orilla y de las líneas de ferri) y luego tensado.
   */
  plan(sx: number, sz: number, gx: number, gz: number, clear: number, avoidFerries: boolean): Float32Array | null {
    // si no sale (un barco que se ha apartado hacia la orilla), con menos holgura
    return this.plan1(sx, sz, gx, gz, clear, avoidFerries) ?? this.plan1(sx, sz, gx, gz, clear * 0.6, avoidFerries)
  }

  private plan1(sx: number, sz: number, gx: number, gz: number, clear: number, avoidFerries: boolean): Float32Array | null {
    const s = this.cidx(sx, sz)
    const g = this.cidx(gx, gz)
    if (s < 0 || g < 0) return null
    const cl = clear * 10
    if (this.cdist[g] < cl) return null
    const cnx = this.cnx
    const cs = this.cell * CF
    // ventana alrededor de los dos extremos
    const si = s % cnx
    const sj = Math.floor(s / cnx)
    const gi = g % cnx
    const gj = Math.floor(g / cnx)
    const pad = Math.ceil(1500 / cs)
    const wi0 = Math.max(0, Math.min(si, gi) - pad)
    const wj0 = Math.max(0, Math.min(sj, gj) - pad)
    const wi1 = Math.min(cnx - 1, Math.max(si, gi) + pad)
    const wj1 = Math.min(this.cnz - 1, Math.max(sj, gj) + pad)
    const ww = wi1 - wi0 + 1
    const wh = wj1 - wj0 + 1
    const N = ww * wh
    const gs = new Float32Array(N).fill(Infinity)
    const from = new Int32Array(N).fill(-1)
    const closed = new Uint8Array(N)
    const heap: number[] = []
    const fsc: number[] = []
    const push = (w: number, f: number) => {
      heap.push(w)
      fsc.push(f)
      let i = heap.length - 1
      while (i > 0) {
        const p = (i - 1) >> 1
        if (fsc[p] <= fsc[i]) break
        ;[heap[p], heap[i]] = [heap[i], heap[p]]
        ;[fsc[p], fsc[i]] = [fsc[i], fsc[p]]
        i = p
      }
    }
    const pop = (): number => {
      const top = heap[0]
      const lw = heap.pop()!
      const lf = fsc.pop()!
      if (heap.length) {
        heap[0] = lw
        fsc[0] = lf
        let i = 0
        for (;;) {
          const l = i * 2 + 1
          const r = l + 1
          let m = i
          if (l < heap.length && fsc[l] < fsc[m]) m = l
          if (r < heap.length && fsc[r] < fsc[m]) m = r
          if (m === i) break
          ;[heap[m], heap[i]] = [heap[i], heap[m]]
          ;[fsc[m], fsc[i]] = [fsc[i], fsc[m]]
          i = m
        }
      }
      return top
    }
    const toW = (c: number) => (Math.floor(c / cnx) - wj0) * ww + ((c % cnx) - wi0)
    const toC = (w: number) => (Math.floor(w / ww) + wj0) * cnx + (w % ww) + wi0
    const sw = toW(s)
    const gw = toW(g)
    gs[sw] = 0
    push(sw, 0)
    let found = false
    let iter = 0
    while (heap.length && iter++ < 120000) {
      const w = pop()
      if (closed[w]) continue
      closed[w] = 1
      if (w === gw) {
        found = true
        break
      }
      const wi = w % ww
      const wj = Math.floor(w / ww)
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue
          const ni = wi + di
          const nj = wj + dj
          if (ni < 0 || nj < 0 || ni >= ww || nj >= wh) continue
          const nw = nj * ww + ni
          if (closed[nw]) continue
          const c = toC(nw)
          const cd = this.cdist[c]
          if (cd < cl) continue
          // en diagonal, las dos de al lado también han de valer
          if (di && dj && (this.cdist[toC(wj * ww + ni)] < cl || this.cdist[toC(nj * ww + wi)] < cl)) continue
          const step = di && dj ? 1.4142 : 1
          // más caro cerca de la orilla (va por el medio) y por las líneas de ferri
          const cost = step * (1 + 6 / (Math.min(cd, 40000) / 10 / cs + 1) + (avoidFerries ? this.pen[c] * 1.5 : 0))
          const ng = gs[w] + cost
          if (ng >= gs[nw]) continue
          gs[nw] = ng
          from[nw] = w
          const hx = ni - (gi - wi0)
          const hz = nj - (gj - wj0)
          push(nw, ng + Math.hypot(hx, hz))
        }
      }
    }
    if (!found) return null
    const cells: number[] = []
    for (let w = gw; w !== -1; w = from[w]) cells.push(toC(w))
    cells.reverse()
    const pts: number[] = [sx, sz]
    for (let k = 1; k + 1 < cells.length; k++) pts.push(...this.cpos(cells[k]))
    pts.push(gx, gz)
    // tensado: del punto actual, al más lejano que se ve
    const out: number[] = [pts[0], pts[1]]
    let a = 0
    const n = pts.length / 2
    while (a < n - 1) {
      let b = n - 1
      while (b > a + 1 && !this.los(pts[a * 2], pts[a * 2 + 1], pts[b * 2], pts[b * 2 + 1], clear)) b--
      out.push(pts[b * 2], pts[b * 2 + 1])
      a = b
    }
    return Float32Array.from(out)
  }
}

// ---------------------------------------------------------------------------
// la región: agua, pantalanes, puertos y barcos quietos
// ---------------------------------------------------------------------------

export interface MarineRegion {
  grid: WaterGrid | null
  statics: StaticBoat[]
  anchored: Vessel[]
  /** km² de agua para navegar: mar cerca de la costa, lagos, ríos anchos, mar abierto */
  areas: { sea: number; lake: number; river: number; deep: number }
  port: { x: number; z: number } | null
  moored: number
}

export interface MarineProjection {
  project: (lat: number, lon: number, out: { x: number; z: number }) => void
  geo: (x: number, z: number) => { lat: number; lon: number }
}

let nextId = 1

function newVessel(kind: number, x: number, z: number, h: number, len: number, water: number, rand: () => number): Vessel {
  const S = kind >= 0 ? BOATS[kind] : null
  const beam = S ? len * S.beam : len * FERRY_SPEC[-kind - 1].beam
  return {
    id: nextId++,
    kind,
    x,
    z,
    h,
    v: 0,
    len,
    beam,
    vmax: S ? S.vmax[0] + rand() * (S.vmax[1] - S.vmax[0]) : 0,
    prio: S ? S.prio : 2,
    water,
    mode: 0,
    path: null,
    pi: 0,
    goalX: x,
    goalZ: z,
    wait: 0,
    stuck: 0,
    legs: 0,
    avoid: 0,
    avoidH: h,
    chk: 0,
    yieldTo: null,
    capV: Infinity,
    rT: 0,
    y: NaN,
    yT: 0,
    color: Math.floor(rand() * 1e6),
    transit: false,
    dead: false,
    route: null,
    dir: 1,
    s: 0,
    dwell: 0,
  }
}

export async function buildMarine(tiles: RoadTile[], routes: Route[], P: MarineProjection, pause: () => Promise<void> | void): Promise<MarineRegion> {
  const empty: MarineRegion = { grid: null, statics: [], anchored: [], areas: { sea: 0, lake: 0, river: 0, deep: 0 }, port: null, moored: 0 }
  const q = { x: 0, z: 0 }
  const proj = (gx: number, gy: number): [number, number] => {
    P.project(yToLat(gy / E, NZ), xToLon(gx / E, NZ), q)
    return [q.x, q.z]
  }
  // agua (proyectada) y su recuadro
  const feats: Array<{ cls: number; rings: number[][]; x0: number; z0: number; x1: number; z1: number }> = []
  // todos los polígonos de agua (también los pequeños) para saber si un punto es agua de verdad
  const allWater: Array<{ rings: number[][]; x0: number; z0: number; x1: number; z1: number }> = []
  const shore: number[] = []
  /** las mismas aristas en unidades globales de tesela (para los hashes: iguales en cualquier región) */
  const shoreG: number[] = []
  let bx0 = Infinity
  let bz0 = Infinity
  let bx1 = -Infinity
  let bz1 = -Infinity
  for (const t of tiles) {
    for (const f of t.water) {
      const rings: number[][] = []
      let fx0 = Infinity
      let fz0 = Infinity
      let fx1 = -Infinity
      let fz1 = -Infinity
      for (const r of f.rings) {
        const out: number[] = []
        const n = r.length / 2
        for (let k = 0; k < n; k++) {
          const [x, z] = proj(t.x * E + r[k * 2], t.y * E + r[k * 2 + 1])
          out.push(x, z)
          fx0 = Math.min(fx0, x)
          fz0 = Math.min(fz0, z)
          fx1 = Math.max(fx1, x)
          fz1 = Math.max(fz1, z)
        }
        rings.push(out)
        // orillas de verdad (no el recorte de la tesela)
        for (let k = 0; k < n; k++) {
          const k2 = (k + 1) % n
          const ux = r[k * 2]
          const uy = r[k * 2 + 1]
          const vx = r[k2 * 2]
          const vy = r[k2 * 2 + 1]
          const mx = (ux + vx) / 2
          const my = (uy + vy) / 2
          if (mx < 0 || my < 0 || mx > E || my > E) continue
          const onEdge = (a: number, b: number) => (a <= 0.5 && b <= 0.5) || (a >= E - 0.5 && b >= E - 0.5)
          if (onEdge(ux, vx) || onEdge(uy, vy)) continue
          shore.push(out[k * 2], out[k * 2 + 1], out[k2 * 2], out[k2 * 2 + 1])
          shoreG.push(t.x * E + ux, t.y * E + uy, t.x * E + vx, t.y * E + vy)
        }
      }
      allWater.push({ rings, x0: fx0, z0: fz0, x1: fx1, z1: fz1 })
      // lagos y ríos pequeños: nada que navegar
      if (f.cls !== 1 && f.cls !== 4 && (fx1 - fx0) * (fz1 - fz0) < 150 * 150) continue
      feats.push({ cls: f.cls, rings, x0: fx0, z0: fz0, x1: fx1, z1: fz1 })
      bx0 = Math.min(bx0, fx0)
      bz0 = Math.min(bz0, fz0)
      bx1 = Math.max(bx1, fx1)
      bz1 = Math.max(bz1, fz1)
    }
  }
  if (!feats.length) return empty
  // recuadro de la región
  let tx0 = Infinity
  let ty0 = Infinity
  let tx1 = -Infinity
  let ty1 = -Infinity
  for (const t of tiles) {
    tx0 = Math.min(tx0, t.x)
    ty0 = Math.min(ty0, t.y)
    tx1 = Math.max(tx1, t.x + 1)
    ty1 = Math.max(ty1, t.y + 1)
  }
  let rx0 = Infinity
  let rz0 = Infinity
  let rx1 = -Infinity
  let rz1 = -Infinity
  for (const [a, b] of [
    [tx0, ty0],
    [tx1, ty0],
    [tx0, ty1],
    [tx1, ty1],
    [(tx0 + tx1) / 2, ty0],
    [(tx0 + tx1) / 2, ty1],
    [tx0, (ty0 + ty1) / 2],
    [tx1, (ty0 + ty1) / 2],
  ]) {
    const [x, z] = proj(a * E, b * E)
    rx0 = Math.min(rx0, x)
    rz0 = Math.min(rz0, z)
    rx1 = Math.max(rx1, x)
    rz1 = Math.max(rz1, z)
  }
  const gx0 = Math.max(rx0, bx0 - 60)
  const gz0 = Math.max(rz0, bz0 - 60)
  const gx1 = Math.min(rx1, bx1 + 60)
  const gz1 = Math.min(rz1, bz1 + 60)
  if (gx1 - gx0 < 50 || gz1 - gz0 < 50) return empty
  const cell = Math.max(5, Math.ceil(Math.sqrt(((gx1 - gx0) * (gz1 - gz0)) / 4.5e6)))
  const grid = new WaterGrid(gx0, gz0, Math.ceil((gx1 - gx0) / cell), Math.ceil((gz1 - gz0) / cell), cell, [rx0 + 1, rz0 + 1, rx1 - 1, rz1 - 1])
  const cls = grid.cls
  for (const order of [1, 4, 2, 3]) {
    for (const f of feats) {
      if (f.cls !== order) continue
      grid.fill(f.rings, (i) => {
        if (!cls[i]) cls[i] = order
      })
    }
  }
  await pause()
  grid.wat = cls.slice()
  // pantalanes que son superficie: tierra también en el agua del mapa (con su contorno como orilla)
  for (const t of tiles) {
    for (const poly of t.pierAreas) {
      const rings = poly.map((r) => {
        const out: number[] = []
        for (let k = 0; k < r.length; k += 2) out.push(...proj(t.x * E + r[k], t.y * E + r[k + 1]))
        return out
      })
      grid.fill(rings, (i) => {
        cls[i] = 0
        grid.wat[i] = 0
      })
      for (const r of rings) {
        const n = r.length / 2
        for (let k = 0; k < n; k++) {
          const k2 = (k + 1) % n
          grid.edges.add(r[k * 2], r[k * 2 + 1], r[k2 * 2], r[k2 * 2 + 1], 0)
        }
      }
    }
  }
  const insideWater = (x: number, z: number) => {
    for (const f of allWater) if (x >= f.x0 && x <= f.x1 && z >= f.z0 && z <= f.z1 && inRings(f.rings, x, z)) return true
    return false
  }
  // solo las aristas con agua a un lado y tierra al otro (los polígonos de agua vienen partidos en
  // trozos que se tocan: esas costuras no son orilla)
  const side = cell * 0.8
  const realShore: number[] = []
  for (let k = 0; k < shore.length; k += 4) {
    const ax = shore[k]
    const az = shore[k + 1]
    const bx = shore[k + 2]
    const bz = shore[k + 3]
    const L = Math.hypot(bx - ax, bz - az)
    if (L < 1e-3) continue
    const mx = (ax + bx) / 2
    const mz = (az + bz) / 2
    const px = (-(bz - az) / L) * side
    const pz = ((bx - ax) / L) * side
    const i1 = grid.idx(mx + px, mz + pz)
    const i2 = grid.idx(mx - px, mz - pz)
    const w1 = i1 >= 0 && grid.wat[i1] > 0
    const w2 = i2 >= 0 && grid.wat[i2] > 0
    if (w1 !== w2) {
      grid.edges.add(ax, az, bx, bz, 0)
      realShore.push(k)
    }
    else if (w1) {
      // agua a los dos lados en la rejilla: o una costura o tierra más fina que una celda (un
      // espigón); se mira con los polígonos a medio metro
      const qx = px / side * 0.5
      const qz = pz / side * 0.5
      if (insideWater(mx + qx, mz + qz) !== insideWater(mx - qx, mz - qz)) {
        grid.edges.add(ax, az, bx, bz, 0)
        realShore.push(k)
      }
    }
  }
  // las orillas exactas también como tierra para navegar (los espigones finos no llenan una celda)
  {
    const e = grid.edges.e
    for (let k = 0; k < e.length; k += 5) grid.stampSeg(e[k], e[k + 1], e[k + 2], e[k + 3], 0.5)
  }
  // zonas industriales (en tierra)
  for (const t of tiles) {
    for (const poly of t.industrial) {
      const rings = poly.map((r) => {
        const out: number[] = []
        for (let k = 0; k < r.length; k += 2) out.push(...proj(t.x * E + r[k], t.y * E + r[k + 1]))
        return out
      })
      grid.fill(rings, (i) => {
        if (!cls[i]) cls[i] = 0x80
      })
    }
  }
  // edificios sobre el agua (casetas, cobertizos, restaurantes): tierra y borde exacto
  for (const t of tiles) {
    for (const r of t.buildingRings) {
      const xz: number[] = []
      let inGrid = false
      for (let k = 0; k < r.length; k += 2) {
        const [x, z] = proj(t.x * E + r[k], t.y * E + r[k + 1])
        xz.push(x, z)
        if (!inGrid && grid.idx(x, z) >= 0) inGrid = true
      }
      if (!inGrid) continue
      grid.fill([xz], (i) => {
        cls[i] = 0
      })
      for (let k = 0; k < xz.length; k += 2) {
        const k2 = (k + 2) % xz.length
        grid.edges.add(xz[k], xz[k + 1], xz[k2], xz[k2 + 1], 3)
      }
    }
  }
  // pantalanes: tierra en la rejilla y borde exacto
  const piers: Array<{ xz: number[]; g: number[] }> = []
  for (const t of tiles) {
    for (const l of t.piers) {
      const xz: number[] = []
      const g: number[] = []
      for (let k = 0; k < l.length; k += 2) {
        xz.push(...proj(t.x * E + l[k], t.y * E + l[k + 1]))
        g.push(t.x * E + l[k], t.y * E + l[k + 1])
      }
      for (let k = 0; k + 3 < xz.length; k += 2) {
        grid.stampSeg(xz[k], xz[k + 1], xz[k + 2], xz[k + 3], 1.5)
        grid.edges.add(xz[k], xz[k + 1], xz[k + 2], xz[k + 3], 1)
      }
      piers.push({ xz, g })
    }
  }
  await pause()
  const statics: StaticBoat[] = []
  const placed = new EdgeHash()
  const free = (x: number, z: number, h: number, L: number, B: number, gap: number): boolean => {
    const a = Math.max(0, L / 2 - B / 2)
    const ax = x + Math.cos(h) * a
    const az = z + Math.sin(h) * a
    const bx = x - Math.cos(h) * a
    const bz = z - Math.sin(h) * a
    // ni orillas ni pantalanes ni otros barcos tocando el casco, y dentro del agua
    if (grid.edges.touches(ax, az, bx, bz, B / 2 + gap)) return false
    if (placed.touches(ax, az, bx, bz, B / 2 + gap)) return false
    return grid.inWater(x, z)
  }
  const addStatic = (b: StaticBoat) => {
    statics.push(b)
    const S = BOATS[b.kind]
    const B = b.len * S.beam
    // el casco como un rectángulo de eslora × manga (líneas a lo largo, una cada 1,5 m)
    const a = b.len / 2
    const ax = b.x + Math.cos(b.h) * a
    const az = b.z + Math.sin(b.h) * a
    const bx = b.x - Math.cos(b.h) * a
    const bz = b.z - Math.sin(b.h) * a
    const n = Math.max(1, Math.ceil(B / 2 / 1.5))
    // varias líneas a lo ancho (la prueba de los demás es contra segmentos)
    for (let k = -n; k <= n; k++) {
      const o = (k / n) * (B / 2)
      const px = -Math.sin(b.h) * o
      const pz = Math.cos(b.h) * o
      placed.add(ax + px, az + pz, bx + px, bz + pz, 2)
    }
  }
  // 1) amarrados en los pantalanes de los puertos deportivos (tres o más pantalanes juntos)
  const mids = piers.map((p) => {
    const k = (p.xz.length / 2) >> 1
    return [p.xz[k * 2], p.xz[k * 2 + 1]]
  })
  let moored = 0
  for (let pi = 0; pi < piers.length; pi++) {
    const p = piers[pi]
    let near = 0
    for (let k = 0; k < mids.length; k++) if (k !== pi && Math.hypot(mids[k][0] - mids[pi][0], mids[k][1] - mids[pi][1]) < 160) near++
    const inDock = grid.water(mids[pi][0], mids[pi][1]) === 4 || grid.wat[Math.max(0, grid.idx(mids[pi][0], mids[pi][1]))] === 4
    if (near < 2 && !inDock) continue
    const xz = p.xz
    const g = p.g
    for (let k = 0; k + 3 < xz.length; k += 2) {
      const ax = xz[k]
      const az = xz[k + 1]
      const dx = xz[k + 2] - ax
      const dz = xz[k + 3] - az
      const L = Math.hypot(dx, dz)
      if (L < 3) continue
      const ux = dx / L
      const uz = dz / L
      // tamaño de los barcos de este tramo (los pantalanes suelen ser de una eslora parecida)
      const hs = hash3(Math.round(g[k]), Math.round(g[k + 1]), 7)
      const Lb0 = 7 + hs * 9
      const pitch = Lb0 * 0.34 + 1.1
      for (let s = pitch * 0.6; s < L - pitch * 0.4; s += pitch) {
        const px = ax + ux * s
        const pz = az + uz * s
        const gx = Math.round(g[k] + ((g[k + 2] - g[k]) * s) / L)
        const gy = Math.round(g[k + 1] + ((g[k + 3] - g[k + 1]) * s) / L)
        for (const side of [-1, 1]) {
          const hb = hash3(gx, gy, side + 11)
          if (hb > 0.82) continue
          const nxv = -uz * side
          const nzv = ux * side
          const kr = hash3(gx, gy, side + 23)
          const kind = kr < 0.5 ? BOAT.moored : kr < 0.82 ? BOAT.yacht : BOAT.motor
          let Lb = kind === BOAT.motor ? 5 + hash3(gx, gy, 31) * 3 : Lb0 * (0.9 + hash3(gx, gy, 37) * 0.2)
          const h = Math.atan2(nzv, nxv)
          // del más largo al más corto que quepa
          for (let tries = 0; tries < 3; tries++) {
            const B = Lb * BOATS[kind].beam
            const cx = px + nxv * (Lb / 2 + 1.2)
            const cz = pz + nzv * (Lb / 2 + 1.2)
            // el pantalán propio queda a 1,2 m de la popa: se mira con algo menos
            if (free(cx, cz, h, Lb, B, 0.35)) {
              addStatic({ x: cx, z: cz, y: NaN, h, kind, len: Lb, color: Math.floor(hash3(gx, gy, 41) * 1e6), water: grid.wat[grid.idx(cx, cz)] || 1 })
              moored++
              break
            }
            Lb *= 0.8
            if (Lb < 5) break
          }
        }
      }
    }
  }
  await pause()
  // 2) puerto: tierra industrial junto al mar
  const coast: number[] = []
  const { nx, nz } = grid
  for (let j = 1; j < nz - 1; j++) {
    for (let i = 1; i < nx - 1; i++) {
      const k = j * nx + i
      const c = cls[k] & 0x7f
      if (c !== 1 && c !== 4) continue
      if (cls[k - 1] === 0x80 || cls[k + 1] === 0x80 || cls[k - nx] === 0x80 || cls[k + nx] === 0x80) coast.push(k)
    }
  }
  let port: { x: number; z: number } | null = null
  if (coast.length * cell >= 600) {
    let sx = 0
    let sz = 0
    for (const k of coast) {
      sx += grid.x0 + ((k % nx) + 0.5) * cell
      sz += grid.z0 + (Math.floor(k / nx) + 0.5) * cell
    }
    port = { x: sx / coast.length, z: sz / coast.length }
    // mercantes atracados: puntos cada ~25 m a lo largo de la orilla con tierra industrial detrás,
    // en orden de su hash (de las coordenadas de la tesela: los mismos en cada región y sin tope por
    // región, así que al cambiar de región salen los mismos barcos en el mismo sitio)
    const cand: Array<{ x: number; z: number; nx: number; nz: number; r: number; hx: number; hy: number }> = []
    for (const k of realShore) {
      const ax = shore[k]
      const az = shore[k + 1]
      const L = Math.hypot(shore[k + 2] - ax, shore[k + 3] - az)
      if (L < 20) continue
      const ux = (shore[k + 2] - ax) / L
      const uz = (shore[k + 3] - az) / L
      for (let d = 10; d < L - 10; d += 25) {
        const x = ax + ux * d
        const z = az + uz * d
        // hacia el agua
        let nxv = -uz
        let nzv = ux
        const iw = grid.idx(x + nxv * 4, z + nzv * 4)
        if (iw < 0 || !grid.wat[iw]) {
          nxv = -nxv
          nzv = -nzv
        }
        const w2 = grid.idx(x + nxv * 4, z + nzv * 4)
        if (w2 < 0 || (grid.wat[w2] !== 1 && grid.wat[w2] !== 4)) continue
        // detrás, el muelle (tierra industrial)
        const il = grid.idx(x - nxv * 12, z - nzv * 12)
        if (il < 0 || cls[il] !== 0x80) continue
        const hx = Math.round(shoreG[k] + ((shoreG[k + 2] - shoreG[k]) * d) / L)
        const hy = Math.round(shoreG[k + 1] + ((shoreG[k + 3] - shoreG[k + 1]) * d) / L)
        cand.push({ x, z, nx: nxv, nz: nzv, r: hash3(hx >> 3, hy >> 3, 51), hx, hy })
      }
    }
    cand.sort((a, b) => a.r - b.r)
    for (const c of cand) {
      if (c.r > 0.25) break
      const nxv = c.nx
      const nzv = c.nz
      const kr = hash3(c.hx >> 3, c.hy >> 3, 53)
      const kind = kr < 0.45 ? BOAT.container : kr < 0.7 ? BOAT.tanker : BOAT.bulk
      const S = BOATS[kind]
      const L = S.len[0] * 0.7 + hash3(c.hx >> 3, c.hy >> 3, 57) * (S.len[1] - S.len[0] * 0.7)
      const B = L * S.beam
      const gap = 2.5
      const cx = c.x + nxv * (B / 2 + gap)
      const cz = c.z + nzv * (B / 2 + gap)
      // a lo largo del muelle (cualquiera de los dos sentidos)
      const h = Math.atan2(nxv, -nzv) + (hash3(c.hx >> 3, c.hy >> 3, 59) < 0.5 ? 0 : Math.PI)
      if (!free(cx, cz, h, L, B, gap * 0.4)) continue
      // muelle recto: a lo largo del costado, la orilla a menos de 8 m
      let straight = true
      for (let t = -0.45; t <= 0.45; t += 0.15) {
        const sx2 = cx + Math.cos(h) * L * t - nxv * (B / 2)
        const sz2 = cz + Math.sin(h) * L * t - nzv * (B / 2)
        if (grid.edges.dist(sx2, sz2, 10) > 8) {
          straight = false
          break
        }
      }
      if (!straight) continue
      addStatic({ x: cx, z: cz, y: NaN, h, kind, len: L, color: Math.floor(hash3(c.hx >> 3, c.hy >> 3, 61) * 1e6), water: 1 })
    }
  }
  // 3) fondeados en la rada: rejilla geográfica de ~1,3 km con un punto movido por hash
  const anchored: Vessel[] = []
  const rand = rng(Math.floor((port ? port.x * 7 + port.z * 13 : 0) + 991))
  if (port) {
    grid.computeDist()
    const g0 = P.geo(grid.x0, grid.z0 + grid.nz * cell)
    const g1 = P.geo(grid.x0 + grid.nx * cell, grid.z0)
    const STEP = 0.012

    const latA = Math.floor(Math.min(g0.lat, g1.lat) / STEP)
    const latB = Math.ceil(Math.max(g0.lat, g1.lat) / STEP)
    const lonA = Math.floor(Math.min(g0.lon, g1.lon) / STEP)
    const lonB = Math.ceil(Math.max(g0.lon, g1.lon) / STEP)
    for (let a = latA; a <= latB; a++) {
      for (let b = lonA; b <= lonB; b++) {
        if (hash3(a, b, 73) > 0.45) continue
        const lat = (a + 0.15 + hash3(a, b, 79) * 0.7) * STEP
        const lon = (b + 0.15 + hash3(a, b, 83) * 0.7) * STEP
        P.project(lat, lon, q)
        const kr = hash3(a, b, 89)
        const kind = kr < 0.4 ? BOAT.container : kr < 0.7 ? BOAT.tanker : BOAT.bulk
        const S = BOATS[kind]
        const L = S.len[0] + hash3(a, b, 97) * (S.len[1] - S.len[0])
        if (grid.water(q.x, q.z) !== 1 || grid.distAt(q.x, q.z) < 700 + L / 2) continue
        if (Math.hypot(q.x - port.x, q.z - port.z) > 8000) continue
        let near = false
        for (const r of routes) {
          for (let k = 0; k < r.x.length && !near; k += 3) if (Math.hypot(r.x[k] - q.x, r.z[k] - q.z) < 500) near = true
          if (near) break
        }
        for (const o of anchored) if (Math.hypot(o.x - q.x, o.z - q.z) < 2.2 * Math.max(o.len, L)) near = true
        if (near) continue
        // aproan al viento de la zona (el mismo en cuadros de ~20 km)
        const wind = hash3(Math.floor(a / 16), Math.floor(b / 16), 71) * Math.PI * 2
        const h = wind + (hash3(a, b, 101) - 0.5) * 0.5
        const v = newVessel(kind, q.x, q.z, h, L, 1, rand)
        v.mode = 2
        v.prio = 4
        v.color = Math.floor(hash3(a, b, 103) * 1e6)
        anchored.push(v)
      }
    }
  }
  // los amarrados y atracados, también como borde exacto (la comprobación fina de los que navegan)
  {
    const e = placed.e
    for (let k = 0; k < e.length; k += 5) grid.edges.add(e[k], e[k + 1], e[k + 2], e[k + 3], 2)
  }
  // los quietos cuentan como orilla para los caminos (los fondeados, con un círculo de borneo)
  for (const b of statics) grid.stampHull(b.x, b.z, b.h, b.len, b.len * BOATS[b.kind].beam, 1)
  for (const v of anchored) grid.stampHull(v.x, v.z, v.h, v.len, v.beam, 40)
  await pause()
  grid.computeDist()
  await pause()
  // cerca de las líneas de ferri, caro para los de recreo
  for (const r of routes) {
    for (let k = 0; k < r.x.length; k++) {
      const R = 80
      const cs = cell * CF
      for (let dz = -R; dz <= R; dz += cs) {
        for (let dx = -R; dx <= R; dx += cs) {
          const c = grid.cidx(r.x[k] + dx, r.z[k] + dz)
          if (c >= 0) grid.pen[c] = 1
        }
      }
    }
  }
  // superficies navegables (km²)
  const areas = { sea: 0, lake: 0, river: 0, deep: 0 }
  const a1 = (cell * cell) / 1e6
  for (let k = 0; k < cls.length; k++) {
    const c = cls[k] & 0x7f
    if (!c) continue
    const d = grid.dist[k] / 10
    if ((c === 1 || c === 4) && d >= 30 && d <= 2500) areas.sea += a1
    if (c === 1 && d >= 800) areas.deep += a1
    if (c === 2 && d >= 25) areas.lake += a1
    if (c === 3 && d >= 15) areas.river += a1
  }
  // los fondeados también son barcos (los demás se apartan de ellos)
  for (const v of anchored) {
    statics.push({ x: v.x, z: v.z, y: NaN, h: v.h, kind: v.kind, len: v.len, color: v.color, water: 1 })
  }
  return { grid, statics, anchored, areas, port, moored }
}

/** ¿punto dentro de un anillo? (par-impar sobre todos los anillos de un polígono) */
function inRings(rings: number[][], x: number, z: number): boolean {
  let c = false
  for (const r of rings) {
    const n = r.length / 2
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = r[i * 2]
      const zi = r[i * 2 + 1]
      const xj = r[j * 2]
      const zj = r[j * 2 + 1]
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c
    }
  }
  return c
}

/** Desfase lateral (a estribor) de los ferris de una ruta: separa a los que se cruzan. */
export function ferryOffsets(r: Route, grid: WaterGrid | null): [Float32Array, Float32Array] {
  const n = r.x.length
  const out: [Float32Array, Float32Array] = [new Float32Array(n), new Float32Array(n)]
  for (let big = 0; big < 2; big++) {
    const F = FERRY_SPEC[big]
    const B = F.len[1] * F.beam
    const want = B / 2 + 6
    const taper = 1.5 * F.base + 30
    const raw = new Float32Array(n)
    for (let k = 0; k < n; k++) {
      const room = grid ? grid.distAt(r.x[k], r.z[k]) : 60
      raw[k] = Math.max(0, Math.min(want, room - B / 2 - 3))
    }
    const o = out[big]
    for (let k = 0; k < n; k++) {
      let m = Infinity
      for (let j = Math.max(0, k - 2); j <= Math.min(n - 1, k + 2); j++) m = Math.min(m, raw[j])
      const s = r.s[k]
      const e = Math.min(s, r.len - s)
      const t = Math.min(1, Math.max(0, e / taper))
      o[k] = m * t * t * (3 - 2 * t)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// simulación
// ---------------------------------------------------------------------------

/** tiempo de previsión (s) según la prioridad */
const HORIZON = [25, 40, 60, 120, 0]

export class MarineSim {
  grid: WaterGrid | null = null
  vessels: Vessel[] = []
  statics: StaticBoat[] = []
  routes: Route[] = []
  camera: { x: number; z: number } | null = null
  hour = 12
  density = 1
  /** sube cada vez que cambia la lista de barcos quietos */
  staticsVersion = 0
  /** altura del agua (marco de la región) en un punto */
  waterY: (x: number, z: number, water: number) => number = () => 0
  private areas = { sea: 0, lake: 0, river: 0, deep: 0 }
  private moored = 0
  private offs = new Map<Route, [Float32Array, Float32Array]>()
  /** dónde espera un ferri a que quede libre el atraque (proa a esa distancia del extremo b / a, por tamaño) */
  private holds = new Map<Route, number[]>()
  private readonly rand: () => number
  private manageT = 0
  private acc = new Map<string, number>()
  /** contadores (pruebas) */
  /** por qué no cupo el último paso (pruebas) y el barco que estorbaba */
  why = ''
  private whyO: Vessel | null = null
  readonly whyLog = new Map<string, number>()
  readonly counters = { safetyStops: 0, spawned: 0, removed: 0, plansFailed: 0, stopsByKind: new Map<number, number>() }

  constructor(seed = 11) {
    this.rand = rng(seed)
  }

  /** Región nueva: con `map`, los barcos que navegaban siguen en su sitio; si no, se empieza de cero. */
  setRegion(reg: MarineRegion, routes: Route[], map: ((x: number, z: number, out: { x: number; z: number }) => void) | null): void {
    const old = this.vessels
    this.vessels = []
    this.grid = reg.grid
    this.routes = routes
    this.statics = reg.statics
    this.areas = reg.areas
    this.moored = reg.moored
    this.staticsVersion++
    this.offs.clear()
    this.holds.clear()
    for (const r of routes) this.offs.set(r, ferryOffsets(r, reg.grid))
    for (const r of routes) this.holds.set(r, this.holdPoints(r, routes))
    for (const a of reg.anchored) this.vessels.push(a)
    const q = { x: 0, z: 0 }
    const q2 = { x: 0, z: 0 }
    if (map) {
      for (const v of old) {
        if (v.mode === 2 || v.dead) continue
        map(v.x + Math.cos(v.h), v.z + Math.sin(v.h), q2)
        map(v.x, v.z, q)
        v.h = Math.atan2(q2.z - q.z, q2.x - q.x)
        v.x = q.x
        v.z = q.z
        if (v.route) {
          if (!this.reattach(v, routes)) continue
        } else {
          if (!this.grid || this.grid.distAt(v.x, v.z) < v.beam / 2) continue
          map(v.goalX, v.goalZ, q)
          v.goalX = q.x
          v.goalZ = q.z
          v.path = null
          if (v.mode === 0) v.mode = 1
          v.wait = Math.min(v.wait, 0.5)
        }
        this.vessels.push(v)
      }
      // rutas nuevas sin ferri
      for (const r of routes) if (!this.vessels.some((v) => v.route === r)) this.addFerry(r, this.rand() < 0.5 ? 1 : -1, this.rand() * r.len)
    } else {
      this.fill()
    }
  }

  private reattach(v: Vessel, routes: Route[]): boolean {
    let best: { r: Route; at: number; d: number } | null = null
    for (const r of routes) {
      for (let i = 0; i + 1 < r.x.length; i++) {
        const ax = r.x[i]
        const az = r.z[i]
        const dx = r.x[i + 1] - ax
        const dz = r.z[i + 1] - az
        const l2 = dx * dx + dz * dz
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((v.x - ax) * dx + (v.z - az) * dz) / l2)) : 0
        const d = Math.hypot(v.x - ax - dx * t, v.z - az - dz * t)
        if (d < 50 && (!best || d < best.d)) best = { r, at: r.s[i] + (r.s[i + 1] - r.s[i]) * t, d }
      }
    }
    if (!best) return false
    v.route = best.r
    // el centro está a media eslora detrás de la proa
    const c = v.dir === 1 ? best.at : best.r.len - best.at
    v.s = Math.max(v.len, Math.min(best.r.len, c + v.len / 2))
    return true
  }

  // --- población -----------------------------------------------------------

  private targets(): { sea: number; lake: number; river: number; transit: number } {
    const h = ((this.hour % 24) + 24) % 24
    // de día salen los de recreo; de noche apenas
    const day = h < 6 || h > 22 ? 0.08 : h < 9 ? 0.08 + ((h - 6) / 3) * 0.92 : h > 20 ? 0.08 + ((22 - h) / 2) * 0.92 : 1
    const d = this.density
    return {
      sea: Math.min(60, Math.round((this.areas.sea * 0.6 + this.moored * 0.05) * day * d)),
      lake: Math.min(25, Math.round(this.areas.lake * 0.8 * day * d)),
      river: Math.min(25, Math.round(this.areas.river * 2.5 * Math.max(0.3, day) * d)),
      transit: this.areas.deep > 40 ? 2 : this.areas.deep > 8 ? 1 : 0,
    }
  }

  private family(v: Vessel): 'sea' | 'lake' | 'river' | 'transit' | null {
    if (v.route || v.mode === 2) return null
    if (v.transit) return 'transit'
    return v.water === 2 ? 'lake' : v.water === 3 ? 'river' : 'sea'
  }

  fill(): void {
    for (const r of this.routes) {
      // uno por ruta y otro más por cada 10 km
      const n = 1 + Math.floor(r.len / 10000)
      for (let i = 0; i < n; i++) this.addFerry(r, this.rand() < 0.5 ? 1 : -1, this.rand() * r.len)
    }
    this.manage(true)
  }

  private manage(initial: boolean): void {
    const g = this.grid
    if (!g) return
    const T = this.targets()
    const count = { sea: 0, lake: 0, river: 0, transit: 0 }
    for (const v of this.vessels) {
      const f = this.family(v)
      if (f) count[f]++
    }
    const cam = this.camera
    const far = (x: number, z: number, d: number) => !cam || Math.hypot(x - cam.x, z - cam.z) > d
    // sobran: se quitan los que están lejos y parados o ya han hecho algún tramo
    for (const v of this.vessels) {
      const f = this.family(v)
      if (!f || f === 'transit') continue
      const stuckFar = v.stuck > 90 && far(v.x, v.z, 600)
      if ((count[f] > T[f] && (v.mode === 1 || v.legs > 0) && far(v.x, v.z, 1500)) || stuckFar) {
        v.dead = true
        count[f]--
        this.counters.removed++
      }
    }
    // faltan: aparecen lejos de la cámara (al empezar, en cualquier sitio)
    const minCam = initial ? 150 : 1300
    for (const f of ['sea', 'lake', 'river'] as const) {
      let n = Math.min(initial ? 99 : 2, T[f] - count[f])
      while (n-- > 0) if (!this.spawnLeisure(f, minCam)) break
    }
    if (count.transit < T.transit && (initial || this.rand() < 0.05)) this.spawnTransit(initial)
  }

  private pickKind(f: 'sea' | 'lake' | 'river'): number {
    const r = this.rand()
    if (f === 'sea') return r < 0.42 ? BOAT.sail : r < 0.62 ? BOAT.yacht : r < 0.88 ? BOAT.motor : BOAT.fishing
    if (f === 'lake') return r < 0.55 ? BOAT.sail : BOAT.motor
    return r < 0.4 ? BOAT.tour : r < 0.8 ? BOAT.barge : BOAT.motor
  }

  /** un punto de agua de la familia con holgura `clear` y como mucho `maxD` de la orilla */
  private randomWater(f: 'sea' | 'lake' | 'river', clear: number, maxD: number, near: { x: number; z: number; r: number } | null): [number, number] | null {
    const g = this.grid!
    const want = f === 'sea' ? [1, 4] : f === 'lake' ? [2] : [3]
    for (let k = 0; k < 80; k++) {
      let x: number
      let z: number
      if (near) {
        const a = this.rand() * Math.PI * 2
        const r = near.r * Math.sqrt(0.1 + 0.9 * this.rand())
        x = near.x + Math.cos(a) * r
        z = near.z + Math.sin(a) * r
      } else {
        x = g.x0 + this.rand() * g.nx * g.cell
        z = g.z0 + this.rand() * g.nz * g.cell
      }
      const c = g.cidx(x, z)
      if (c < 0) continue
      const d = g.cdist[c] / 10
      if (d < clear || d > maxD || g.pen[c]) continue
      if (!want.includes(g.water(x, z))) continue
      return [x, z]
    }
    return null
  }

  private spawnLeisure(f: 'sea' | 'lake' | 'river', minCam: number): boolean {
    const kind = this.pickKind(f)
    const S = BOATS[kind]
    const len = S.len[0] + this.rand() * (S.len[1] - S.len[0])
    const B = len * S.beam
    const clear = B / 2 + S.clear
    const maxD = kind === BOAT.fishing ? 6000 : f === 'river' ? 1e4 : 2500
    for (let k = 0; k < 6; k++) {
      const p = this.randomWater(f, Math.max(clear + 10, len * 0.55), maxD, null)
      if (!p) return false
      const cam = this.camera
      if (cam && Math.hypot(p[0] - cam.x, p[1] - cam.z) < minCam) continue
      if (this.vessels.some((o) => Math.hypot(o.x - p[0], o.z - p[1]) < (o.len + len) / 2 + 60)) continue
      // proa hacia donde más agua hay a lo largo del casco (en un río, a lo largo del río)
      const h = this.bestHeading(p[0], p[1], len, B)
      if (h === null) continue
      const v = newVessel(kind, p[0], p[1], h, len, f === 'sea' ? 1 : f === 'lake' ? 2 : 3, this.rand)
      v.mode = 1
      v.wait = this.rand() * 5
      this.vessels.push(v)
      this.counters.spawned++
      return true
    }
    return false
  }

  /** rumbo con más holgura a lo largo del casco (null si en ninguno cabe con 2 m de sobra) */
  private bestHeading(x: number, z: number, len: number, B: number): number | null {
    const g = this.grid!
    const h0 = this.rand() * Math.PI
    let best = -Infinity
    let bh = h0
    for (let k = 0; k < 16; k++) {
      const h = h0 + (k / 16) * Math.PI
      let m = Infinity
      for (let t = -0.5; t <= 0.501; t += 0.125) m = Math.min(m, g.distAt(x + Math.cos(h) * len * t, z + Math.sin(h) * len * t))
      if (m > best) {
        best = m
        bh = h
      }
    }
    if (best < B / 2 + 2) return null
    return this.rand() < 0.5 ? bh : bh + Math.PI
  }

  /** mercante de paso: entra por un borde de la región y sale por otro lejano */
  private spawnTransit(initial: boolean): void {
    const g = this.grid!
    const r = g.region
    const kr = this.rand()
    const kind = kr < 0.45 ? BOAT.container : kr < 0.75 ? BOAT.tanker : BOAT.bulk
    const S = BOATS[kind]
    const len = S.len[0] + this.rand() * (S.len[1] - S.len[0])
    const B = len * S.beam
    const clear = B / 2 + S.clear
    const border: number[] = []
    const cs = g.cell * CF
    for (let c = 0; c < g.cdist.length; c++) {
      if (g.cdist[c] / 10 < clear + 150) continue
      const [x, z] = g.cpos(c)
      if (x - r[0] < cs * 1.5 || r[2] - x < cs * 1.5 || z - r[1] < cs * 1.5 || r[3] - z < cs * 1.5) border.push(c)
    }
    if (border.length < 2) return
    for (let k = 0; k < 8; k++) {
      const a = g.cpos(border[Math.floor(this.rand() * border.length)])
      const b = g.cpos(border[Math.floor(this.rand() * border.length)])
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 4500) continue
      const cam = this.camera
      if (!initial && cam && Math.hypot(a[0] - cam.x, a[1] - cam.z) < 2500) continue
      const path = g.plan(a[0], a[1], b[0], b[1], clear, false)
      if (!path) {
        this.counters.plansFailed++
        continue
      }
      const v = newVessel(kind, a[0], a[1], Math.atan2(path[3] - path[1], path[2] - path[0]), len, 1, this.rand)
      v.transit = true
      v.path = path
      v.pi = 1
      v.goalX = b[0]
      v.goalZ = b[1]
      v.v = v.vmax
      if (initial) {
        // ya a mitad de camino
        const k2 = Math.floor(this.rand() * (path.length / 2 - 1))
        v.x = path[k2 * 2] + (path[k2 * 2 + 2] - path[k2 * 2]) * 0.5
        v.z = path[k2 * 2 + 1] + (path[k2 * 2 + 3] - path[k2 * 2 + 1]) * 0.5
        v.h = Math.atan2(path[k2 * 2 + 3] - path[k2 * 2 + 1], path[k2 * 2 + 2] - path[k2 * 2])
        v.pi = k2 + 1
      }
      if (this.vessels.some((o) => hullClear(o.x, o.z, o.h, o.len, o.beam, v.x, v.z, v.h, v.len, v.beam) < 200)) return
      this.vessels.push(v)
      this.counters.spawned++
      return
    }
  }

  private addFerry(r: Route, dir: 1 | -1, s: number): Vessel | null {
    const big = r.big ? 1 : 0
    const F = FERRY_SPEC[big]
    const len = F.len[0] + this.rand() * (F.len[1] - F.len[0])
    const v = newVessel(-1 - big, 0, 0, 0, len, 1, this.rand)
    v.route = r
    v.dir = dir
    v.s = Math.max(len, Math.min(r.len, s))
    v.vmax = big ? 9 + this.rand() * 3 : 6 + this.rand() * 3
    v.color = Math.floor(this.rand() * 1e6)
    this.ferryPose(v, v.s, _p)
    v.x = _p.x
    v.z = _p.z
    v.h = _p.h
    for (const o of this.vessels) if (o !== v && hullClear(o.x, o.z, o.h, o.len, o.beam, v.x, v.z, v.h, v.len, v.beam) < 20) return null
    this.vessels.push(v)
    return v
  }

  // --- paso ----------------------------------------------------------------

  step(dt: number): void {
    this.manageT -= dt
    if (this.manageT <= 0) {
      this.manageT = 2
      this.manage(false)
      this.ferryEntries(2)
    }
    for (const v of this.vessels) {
      if (v.dead || v.mode === 2) continue
      if (v.route) this.stepFerry(v, dt)
      else this.stepBoat(v, dt)
      v.yT -= dt
      if (v.yT <= 0 || Number.isNaN(v.y)) {
        v.yT = 2 + this.rand()
        v.y = v.route ? this.routeY(v) : this.waterY(v.x, v.z, v.water)
      }
    }
    let w = 0
    for (const v of this.vessels) if (!v.dead) this.vessels[w++] = v
    this.vessels.length = w
  }

  /** ferris que entran por la frontera: uno cada ~20 min por cada extremo que da fuera */
  private ferryEntries(dt: number): void {
    for (const r of this.routes) {
      for (const [out, dir] of [
        [r.aOut, 1],
        [r.bOut, -1],
      ] as Array<[boolean, 1 | -1]>) {
        if (!out) continue
        const key = `${r.id}:${dir}`
        const a = (this.acc.get(key) ?? this.rand()) + dt / 1200
        if (a < 1) {
          this.acc.set(key, a)
          continue
        }
        this.acc.set(key, a - 1)
        if (this.vessels.some((f) => f.route === r && f.dir === dir && f.s < 600)) continue
        const f = this.addFerry(r, dir, 0)
        if (f) f.v = f.vmax
      }
    }
  }

  /**
   * Punto de espera de cada extremo (para cada tamaño de ferri): pasada la zona del atraque y, si
   * se puede, donde el casco no estorbe a las otras líneas de ferri.
   */
  private holdPoints(r: Route, routes: Route[]): number[] {
    const out: number[] = []
    const probe = newVessel(-1, 0, 0, 0, 1, 1, this.rand)
    probe.route = r
    for (const dir of [1, -1] as const) {
      for (let big = 0; big < 2; big++) {
        const F = FERRY_SPEC[big]
        const L = F.len[1]
        const B = L * F.beam
        probe.kind = -1 - big
        probe.dir = dir
        probe.len = L
        const base = 1.5 * F.base + 45 + L
        let best = base
        for (let d = base; d < r.len * 0.45; d += 20) {
          // proa a d metros del extremo de llegada
          this.ferryPose(probe, r.len - d, _p)
          const a = Math.max(0, L / 2 - B / 2)
          const ax = _p.x + Math.cos(_p.h) * a
          const az = _p.z + Math.sin(_p.h) * a
          const bx = _p.x - Math.cos(_p.h) * a
          const bz = _p.z - Math.sin(_p.h) * a
          let clear = Infinity
          for (const o of routes) {
            if (o === r) continue
            for (let k = 0; k + 1 < o.x.length; k++) clear = Math.min(clear, segSeg(ax, az, bx, bz, o.x[k], o.z[k], o.x[k + 1], o.z[k + 1]))
          }
          best = d
          if (clear > B / 2 + 40) break
          if (d - base > 1500) {
            best = base
            break
          }
        }
        out.push(best)
      }
    }
    return out
  }

  private routeY(v: Vessel): number {
    const r = v.route!
    const at = Math.max(0, Math.min(r.len, v.dir === 1 ? v.s - v.len / 2 : r.len - (v.s - v.len / 2)))
    const i = this.segAt(r, at)
    const t = (at - r.s[i]) / (r.s[i + 1] - r.s[i] || 1)
    return r.y[i] + (r.y[i + 1] - r.y[i]) * t
  }

  private segAt(r: Route, at: number): number {
    let lo = 0
    let hi = r.s.length - 1
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1
      if (r.s[m] <= at) lo = m
      else hi = m
    }
    return lo
  }

  /** punto de la ruta a `sm` (en el sentido de la marcha), con el desfase a estribor */
  private routeAt(v: Vessel, sm: number, out: { x: number; z: number }): void {
    const r = v.route!
    const at = Math.max(0, Math.min(r.len, v.dir === 1 ? sm : r.len - sm))
    const i = this.segAt(r, at)
    const L = r.s[i + 1] - r.s[i] || 1
    const t = (at - r.s[i]) / L
    const tx = ((r.x[i + 1] - r.x[i]) / L) * v.dir
    const tz = ((r.z[i + 1] - r.z[i]) / L) * v.dir
    const off = this.offs.get(r)?.[v.kind === -2 ? 1 : 0]
    const o = off ? off[i] + (off[i + 1] - off[i]) * t : 0
    out.x = r.x[i] + (r.x[i + 1] - r.x[i]) * t - tz * o
    out.z = r.z[i] + (r.z[i + 1] - r.z[i]) * t + tx * o
  }

  private ferryPose(v: Vessel, s: number, out: { x: number; z: number; h: number }): void {
    this.routeAt(v, s, _a)
    this.routeAt(v, s - v.len, _b)
    out.x = (_a.x + _b.x) / 2
    out.z = (_a.z + _b.z) / 2
    out.h = Math.atan2(_a.z - _b.z, _a.x - _b.x)
  }

  /** ¿cede `v` ante `o`? (los dos en marcha o `o` parado) */
  private giveWay(v: Vessel, o: Vessel): boolean {
    if (o.mode === 2 || o.prio === 4) return true
    // parado: se le esquiva, salvo que esté esperando a que pase yo
    if (o.v < 0.2 && o.yieldTo !== v) return true
    if (o.prio !== v.prio) return v.prio < o.prio
    const rel = angDiff(Math.atan2(o.z - v.z, o.x - v.x), v.h)
    const relO = angDiff(Math.atan2(v.z - o.z, v.x - o.x), o.h)
    // de vuelta encontrada: los dos caen a estribor
    if (Math.abs(rel) < 0.25 && Math.abs(relO) < 0.25) return true
    // alcance: el que alcanza se aparta
    if (Math.abs(relO) > 1.96 && Math.abs(rel) < 1.2) return true
    if (Math.abs(rel) > 1.96 && Math.abs(relO) < 1.2) return false
    // cruce: cede quien tiene al otro por estribor
    return rel > 0
  }

  /** holgura mínima en los próximos `T` s (los dos en línea recta) y si se van acercando */
  private conflict(v: Vessel, h: number, sp: number, o: Vessel, T: number, margin: number): { c: number; t: number } | null {
    const ov = o.mode === 2 ? 0 : o.v
    const c0 = hullClear(v.x, v.z, v.h, v.len, v.beam, o.x, o.z, o.h, o.len, o.beam)
    let best = Infinity
    let bt = 0
    const n = 10
    const cv = Math.cos(h) * sp
    const sv = Math.sin(h) * sp
    const co = Math.cos(o.h) * ov
    const so = Math.sin(o.h) * ov
    for (let k = 1; k <= n; k++) {
      const t = (T * k) / n
      const c = hullClear(v.x + cv * t, v.z + sv * t, h, v.len, v.beam, o.x + co * t, o.z + so * t, o.h, o.len, o.beam)
      if (c < best) {
        best = c
        bt = t
      }
      if (c < 0) break
    }
    if (best >= margin || best >= c0 - 0.05) return null
    return { c: best, t: bt }
  }

  private landOk(v: Vessel, h: number, sp: number, clear: number): boolean {
    const g = this.grid
    if (!g) return true
    for (const t of [4, 8, 14]) {
      const x = v.x + Math.cos(h) * (sp * t + v.len / 2)
      const z = v.z + Math.sin(h) * (sp * t + v.len / 2)
      if (g.distAt(x, z) < clear) return false
    }
    return true
  }

  /** rumbo y velocidad tras apartarse de los demás */
  private resolve(v: Vessel, hd: number, vd: number, canSteer: boolean): { h: number; v: number; by: Vessel | null } {
    let H = hd
    let V = vd
    let by: Vessel | null = null
    v.yieldTo = null
    let yv = vd
    const T = HORIZON[Math.min(v.prio, 3)]
    for (const o of this.vessels) {
      if (o === v || o.dead) continue
      const R = (v.vmax + (o.mode === 2 ? 0 : o.v)) * T + (v.len + o.len) / 2 + 60
      if (Math.abs(o.x - v.x) > R || Math.abs(o.z - v.z) > R) continue
      const m = Math.max(MARGIN[Math.min(v.prio, 4)], MARGIN[Math.min(o.prio, 4)])
      const c = this.conflict(v, H, V, o, T, m)
      if (!c) continue
      if (!this.giveWay(v, o)) {
        // a rumbo, pero si se echa encima, afloja
        if (c.t < 8) V = Math.min(V, vd * 0.3)
        continue
      }
      let ok = false
      for (const f of [0.6, 0.3, 0]) {
        if (!this.conflict(v, H, vd * f, o, T, m)) {
          V = Math.min(V, vd * f)
          ok = true
          break
        }
      }
      // un barco parado de menos rango en el camino: que se aparte
      if (o.v < 0.2 && o.prio < v.prio && o.mode !== 2 && !o.route && V < vd * 0.5) by = o
      if (V < yv) {
        yv = V
        v.yieldTo = o
      }
      if (ok || !canSteer) {
        if (!ok) V = 0
        continue
      }
      // caer a estribor
      const S = BOATS[v.kind]
      const clear = v.beam / 2 + S.clear * 0.5
      for (const d of [0.5, 1.0, 1.5, 2.1]) {
        const h2 = hd + d
        if (!this.conflict(v, h2, vd, o, T, m) && this.landOk(v, h2, vd, clear)) {
          H = h2
          V = vd
          v.avoid = 8 + this.rand() * 6
          v.avoidH = h2
          ok = true
          break
        }
      }
      if (!ok) V = 0
    }
    return { h: H, v: V, by }
  }

  /** el barco `o` estorba a uno de más rango: deja de esperar o busca por dónde salir */
  private nudge(o: Vessel | null): void {
    if (!o) return
    if (o.mode === 1) o.wait = Math.min(o.wait, 0)
    else o.stuck = Math.max(o.stuck, 16)
  }

  /** ¿cabe el casco en esa posición? (ni en tierra ni tocando a otro barco) */
  private fits(v: Vessel, x: number, z: number, h: number): boolean {
    this.whyO = null
    const g = this.grid
    if (g && !v.route) {
      let worstNew = Infinity
      let worstOld = Infinity
      for (const t of [-0.4, -0.2, 0, 0.2, 0.4]) {
        worstNew = Math.min(worstNew, g.distAt(x + Math.cos(h) * v.len * t, z + Math.sin(h) * v.len * t))
        worstOld = Math.min(worstOld, g.distAt(v.x + Math.cos(v.h) * v.len * t, v.z + Math.sin(v.h) * v.len * t))
      }
      // cerca de la orilla, con las aristas exactas (la rejilla de 5 m se equivoca en unos metros):
      // no se entra en tierra ni se acerca uno más a la orilla si ya está a menos de media manga
      if (worstNew < v.beam / 2 + 6) {
        const need = v.beam / 2 + 0.6
        const a = Math.max(0, v.len / 2 - v.beam / 2)
        const clr = (px: number, pz: number, ph: number) => g.edges.segDist(px + Math.cos(ph) * a, pz + Math.sin(ph) * a, px - Math.cos(ph) * a, pz - Math.sin(ph) * a, need + 1)
        const cNew = clr(x, z, h)
        if (cNew < need) {
          const cOld = clr(v.x, v.z, v.h)
          if (cNew < cOld || (!g.inWater(x, z) && g.inWater(v.x, v.z))) {
            this.why = 'orilla exacta'
            return false
          }
        }
      }
      if (worstNew < v.beam / 2 + 0.5 && worstNew < worstOld) {
        this.why = 'orilla rejilla'
        return false
      }
    }
    for (const o of this.vessels) {
      if (o === v || o.dead) continue
      const R = (v.len + o.len) / 2 + 5
      if (Math.abs(o.x - x) > R || Math.abs(o.z - z) > R) continue
      const cn = hullClear(x, z, h, v.len, v.beam, o.x, o.z, o.h, o.len, o.beam)
      if (cn >= 0.5) continue
      const co = hullClear(v.x, v.z, v.h, v.len, v.beam, o.x, o.z, o.h, o.len, o.beam)
      if (cn < co) {
        this.whyO = o
        this.why = `barco ${o.route ? `ferri ruta ${o.route.id} dir ${o.dir} s ${o.s.toFixed(0)} amarre ${o.dwell.toFixed(0)}` : `${o.kind} modo ${o.mode}`}`
        return false
      }
    }
    return true
  }

  private stepBoat(v: Vessel, dt: number): void {
    const S = BOATS[v.kind]
    if (v.mode === 1) {
      v.v = Math.max(0, v.v - S.acc * dt)
      v.wait -= dt
      if (v.wait <= 0 && v.v < 0.05) this.nextLeg(v)
      return
    }
    const path = v.path
    if (!path) {
      this.nextLeg(v)
      return
    }
    // seguimiento del camino (persecución pura)
    const look = Math.max(20, v.len * 1.5)
    const n = path.length / 2
    while (v.pi < n - 1 && Math.hypot(path[v.pi * 2] - v.x, path[v.pi * 2 + 1] - v.z) < look) v.pi++
    const tx = path[v.pi * 2]
    const tz = path[v.pi * 2 + 1]
    // de vez en cuando: ¿se sigue viendo el punto al que va? (tras apartarse, puede quedar tierra
    // en medio: otro camino)
    v.chk -= dt
    if (v.chk <= 0 && this.grid) {
      v.chk = 1.5
      if (!this.grid.los(v.x, v.z, tx, tz, v.beam / 2 + S.clear * 0.4)) {
        this.replan(v)
        return
      }
    }
    let rem = Math.hypot(tx - v.x, tz - v.z)
    for (let k = v.pi; k < n - 1; k++) rem += Math.hypot(path[k * 2 + 2] - path[k * 2], path[k * 2 + 3] - path[k * 2 + 1])
    const arrive = v.transit ? 30 : Math.max(8, v.len * 0.4)
    if (rem < arrive) {
      v.legs++
      v.path = null
      if (v.transit) {
        v.dead = true
        return
      }
      v.mode = 1
      v.wait = this.pauseTime(v)
      return
    }
    let hd = Math.atan2(tz - v.z, tx - v.x)
    if (v.avoid > 0) {
      v.avoid -= dt
      hd = v.avoidH
      if (v.avoid <= 0) {
        // vuelta al camino: si se ha alejado mucho, otro camino
        const k = Math.max(1, v.pi)
        if (Math.sqrt(segDist2(v.x, v.z, path[(k - 1) * 2], path[(k - 1) * 2 + 1], path[k * 2], path[k * 2 + 1])) > 40 + v.len) this.replan(v)
      }
    }
    const turnErr = Math.abs(angDiff(hd, v.h))
    let vd = v.vmax * (1 - 0.6 * Math.min(1, turnErr / (Math.PI / 2)))
    vd = Math.min(vd, Math.sqrt(2 * S.acc * 0.7 * rem) + 0.3)
    // mirar a los demás (cada cuarto de segundo; entre medias, el mismo límite de velocidad)
    let H = hd
    v.rT -= dt
    if (v.rT <= 0 || v.capV < vd * 0.99) {
      v.rT = 0.25
      const res = this.resolve(v, hd, vd, true)
      this.nudge(res.by)
      H = res.h
      v.capV = res.v
    }
    this.move(v, H, Math.min(vd, v.capV), dt)
  }

  /** gira hacia `h` y acelera hacia `sp` con sus límites; el paso solo se da si cabe */
  private move(v: Vessel, h: number, sp: number, dt: number): void {
    const S = BOATS[v.kind]
    const nv = v.v + Math.max(-S.acc * 2 * dt, Math.min(S.acc * dt, sp - v.v))
    const rate = Math.max(S.pivot, nv / (S.turn * v.len))
    const d = angDiff(h, v.h)
    const nh = v.h + Math.max(-rate * dt, Math.min(rate * dt, d))
    const nx = v.x + Math.cos(nh) * nv * dt
    const nz = v.z + Math.sin(nh) * nv * dt
    if (this.fits(v, nx, nz, nh)) {
      v.x = nx
      v.z = nz
      v.h = nh
      v.v = Math.max(0, nv)
      v.stuck = v.v < 0.1 ? v.stuck + dt : 0
    } else {
      this.counters.safetyStops++
      this.counters.stopsByKind.set(v.kind, (this.counters.stopsByKind.get(v.kind) ?? 0) + 1)
      const wk = `${v.id} ${v.kind} ${this.why} ${v.x.toFixed(0)},${v.z.toFixed(0)}`
      this.whyLog.set(wk, (this.whyLog.get(wk) ?? 0) + 1)
      v.v = 0
      v.stuck += dt
      if (S.pivot > 0.01 && this.fits(v, v.x, v.z, nh)) v.h = nh
      else if (v.stuck > 4 && S.pivot >= 0.03) {
        // marcha atrás despacio
        const bx = v.x - Math.cos(v.h) * 0.6 * dt
        const bz = v.z - Math.sin(v.h) * 0.6 * dt
        if (this.fits(v, bx, bz, v.h)) {
          v.x = bx
          v.z = bz
        }
      }
    }
    // atascado: buscar por dónde salir
    if (v.stuck > 15 && v.avoid <= 0) {
      let best = -Infinity
      let bh = v.h
      for (let k = 0; k < 12; k++) {
        const hh = v.h + (k / 12) * Math.PI * 2
        let clear = Infinity
        const px = v.x + Math.cos(hh) * v.len * 0.6
        const pz = v.z + Math.sin(hh) * v.len * 0.6
        for (const o of this.vessels) if (o !== v && !o.dead) clear = Math.min(clear, hullClear(px, pz, hh, v.len, v.beam, o.x, o.z, o.h, o.len, o.beam))
        if (this.grid) clear = Math.min(clear, this.grid.distAt(px, pz) - v.beam / 2)
        if (clear > best) {
          best = clear
          bh = hh
        }
      }
      v.avoid = 12
      v.avoidH = bh
      v.stuck = 0
    }
  }

  private pauseTime(v: Vessel): number {
    const r = this.rand()
    switch (v.kind) {
      case BOAT.sail:
        return r < 0.25 ? 120 + this.rand() * 600 : 2
      case BOAT.yacht:
      case BOAT.motor:
        return r < 0.5 ? 120 + this.rand() * 900 : 3
      case BOAT.fishing:
        return r < 0.7 ? 300 + this.rand() * 1200 : 5
      default:
        return 5 + this.rand() * 20
    }
  }

  private replan(v: Vessel): void {
    const g = this.grid
    if (!g) return
    const S = BOATS[v.kind]
    const path = g.plan(v.x, v.z, v.goalX, v.goalZ, v.beam / 2 + S.clear, v.prio === 0)
    if (path) {
      v.path = path
      v.pi = 1
    } else {
      this.counters.plansFailed++
      v.path = null
      v.mode = 1
      v.wait = 20
    }
  }

  /** siguiente tramo: un punto de agua de su familia a unos km */
  private nextLeg(v: Vessel): void {
    const g = this.grid
    if (!g) return
    const S = BOATS[v.kind]
    const f = v.water === 2 ? 'lake' : v.water === 3 ? 'river' : 'sea'
    const clear = v.beam / 2 + S.clear
    const R = v.kind === BOAT.sail ? 2000 : v.kind === BOAT.fishing ? 3500 : f === 'river' ? 4000 : 3000
    const maxD = v.kind === BOAT.fishing ? 6000 : f === 'river' ? 1e4 : 2500
    // a medio tramo de un camino anterior (región nueva): el mismo destino
    if (v.goalX !== v.x || v.goalZ !== v.z) {
      if (Math.hypot(v.goalX - v.x, v.goalZ - v.z) > 60) {
        const path = g.plan(v.x, v.z, v.goalX, v.goalZ, clear, v.prio === 0)
        if (path) {
          v.path = path
          v.pi = 1
          v.mode = 0
          return
        }
      }
    }
    for (let k = 0; k < 4; k++) {
      // donde quepa dar la vuelta
      const p = this.randomWater(f, Math.max(clear + 10, v.len * 0.55), maxD, { x: v.x, z: v.z, r: R })
      if (!p) break
      const path = g.plan(v.x, v.z, p[0], p[1], clear, v.prio === 0)
      if (!path) {
        this.counters.plansFailed++
        continue
      }
      v.path = path
      v.pi = 1
      v.goalX = p[0]
      v.goalZ = p[1]
      v.mode = 0
      return
    }
    v.goalX = v.x
    v.goalZ = v.z
    v.mode = 1
    v.wait = 30
  }

  private stepFerry(v: Vessel, dt: number): void {
    const r = v.route!
    if (v.dwell > 0) {
      v.dwell -= dt
      v.v = 0
      return
    }
    const toEnd = r.len - v.s
    const endOut = v.dir === 1 ? r.bOut : r.aOut
    // frena al llegar a puerto (0,04 m/s²) y sale despacio
    let target = endOut ? v.vmax : Math.min(v.vmax, Math.sqrt(2 * 0.04 * Math.max(0, toEnd - 5)) + 0.3)
    // atraque ocupado (otro ferri amarrado o saliendo de ese extremo): espera fuera
    if (!endOut) {
      const F = FERRY_SPEC[v.kind === -2 ? 1 : 0]
      const zone = 1.5 * F.base + 45
      const hold = this.holds.get(r)?.[(v.dir === 1 ? 0 : 2) + (v.kind === -2 ? 1 : 0)] ?? zone + v.len
      for (const o of this.vessels) {
        if (o === v || o.route !== r || o.dir === v.dir || o.dead) continue
        if (o.s < o.len + zone + 20) {
          target = Math.min(target, Math.sqrt(2 * 0.04 * Math.max(0, toEnd - Math.max(hold, zone + o.len))))
          break
        }
      }
    }
    v.rT -= dt
    if (v.rT <= 0 || v.capV < target * 0.99) {
      v.rT = 0.25
      const res = this.resolve(v, v.h, target, false)
      this.nudge(res.by)
      v.capV = res.v
    }
    target = Math.min(target, v.capV)
    v.v += Math.max(-0.1, Math.min(0.06, target - v.v)) * dt * 2
    v.v = Math.max(0, v.v)
    const ns = v.s + v.v * dt
    this.ferryPose(v, ns, _p)
    if (this.fits(v, _p.x, _p.z, _p.h)) {
      v.s = ns
      v.x = _p.x
      v.z = _p.z
      v.h = _p.h
      if (v.v > 0.2) v.stuck = 0
    } else {
      v.stuck += dt
      // atascado contra otro ferri al que cedía el paso: marcha atrás por la ruta hasta dejarle sitio
      if (v.stuck > 6 && this.whyO && this.whyO.route && (v.yieldTo === this.whyO || (this.whyO.yieldTo !== v && v.id > this.whyO.id))) {
        const bs = v.s - 0.6 * dt
        this.ferryPose(v, bs, _p)
        if (bs > v.len && this.fits(v, _p.x, _p.z, _p.h)) {
          v.s = bs
          v.x = _p.x
          v.z = _p.z
          v.h = _p.h
          v.yieldTo = this.whyO
        }
      }
      this.counters.safetyStops++
      this.counters.stopsByKind.set(v.kind, (this.counters.stopsByKind.get(v.kind) ?? 0) + 1)
      const wk = `ferri ${v.id} ruta ${r.id} dir ${v.dir} quedan ${Math.round((r.len - v.s) / 50) * 50}/${r.len.toFixed(0)} m: ${this.why}`
      this.whyLog.set(wk, (this.whyLog.get(wk) ?? 0) + 1)
      v.v = 0
    }
    if (v.s >= r.len - 2) {
      if (endOut) {
        v.dead = true
        return
      }
      // atraca y vuelve (si la posición de salida cabe: la de llegada se corre un par de metros)
      const s0 = v.s
      v.s = v.len
      v.dir = v.dir === 1 ? -1 : 1
      this.ferryPose(v, v.s, _p)
      if (!this.fits(v, _p.x, _p.z, _p.h)) {
        v.dir = v.dir === 1 ? -1 : 1
        v.s = s0
        v.v = 0
        return
      }
      v.v = 0
      v.dwell = 240 + this.rand() * 360
      v.x = _p.x
      v.z = _p.z
      v.h = _p.h
    }
  }

  /** proa y popa (x, z) de un barco */
  ends(v: Vessel, bow: { x: number; z: number }, stern: { x: number; z: number }): void {
    const c = Math.cos(v.h) * v.len * 0.5
    const s = Math.sin(v.h) * v.len * 0.5
    bow.x = v.x + c
    bow.z = v.z + s
    stern.x = v.x - c
    stern.z = v.z - s
  }
}

const _p = { x: 0, z: 0, h: 0 }
const _a = { x: 0, z: 0 }
const _b = { x: 0, z: 0 }
