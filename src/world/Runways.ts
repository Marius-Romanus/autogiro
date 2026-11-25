// Pistas de aeródromo alisadas sobre el MDT del IGN.
//
// El MDT05 tiene costuras y ruido de algunos decímetros: en LEMT, una costura de
// ~0,4 m cruza la pista a 40 m de la cabecera 08 y se veía (y se notaba al rodar)
// como un escalón. Una pista de verdad es lisa, así que con el trazado de las pistas
// de OpenStreetMap (capa aeroway de OpenFreeMap) se calcula para cada una un perfil
// suave ajustado al propio MDT (altura del eje + pendiente transversal, regresión
// local con núcleo gaussiano, que respeta las pendientes y los cambios de rasante
// reales) y se aplica a la vez:
//  - a la física del suelo (World.elevation → adjust), y
//  - a las teselas de terreno que se dibujan (plugin de 3d-tiles-renderer).
//
// La malla del IGN es un TIN: en la pista casi no tiene vértices y la costura está
// hecha con triángulos largos que la cruzan entera, así que mover vértices no basta.
// Las teselas finas (niveles 15–16) que tocan una pista se vuelven a mallar con una
// rejilla regular (~2 m en el nivel 16) muestreada del propio TIN, y luego se corrige
// cada vértice. Las teselas lejanas, más groseras, solo corrigen sus vértices.
//
// El mismo mecanismo aplica otros parches de terreno que le pasen (`setExtra`): los rebajes
// bajo los puentes que el MDT trae incrustados (Bridges.ts).
//
// Fuera de España (relieve global Terrarium, ~30 m) se usa solo la parte de descubrir y
// perfilar las pistas, con un suavizado más ancho (RUNWAY_TUNING.global); la corrección se
// aplica a la rejilla de alturas del relieve en gridRunways.ts.

import { BufferAttribute, Matrix4, Vector3, type BufferGeometry, type Mesh, type Object3D } from 'three'
import type { HeightSource, QMHeightSource } from './HeightSource.ts'
import { fetchVectorTile, latToY, lonToX, xToLon, yToLat, Z } from './mapTiles.ts'

const DEG = Math.PI / 180
/** separación de las estaciones del perfil a lo largo de la pista (m) */
const STATION = 5

/** Cómo se perfila cada pista, según la finura del relieve. */
export interface RunwayTuning {
  /** suavizado de la altura del eje y de la pendiente transversal (sigma, m) */
  sigmaH: number
  sigmaX: number
  /** transición entre la pista alisada y el relieve (m), a los lados y más allá de los extremos */
  blend: number
  /** pendiente transversal máxima (m/m) */
  maxCross: number
}

export const RUNWAY_TUNING: Record<'ign' | 'global', RunwayTuning> = {
  // MDT05: respeta los cambios de rasante reales
  ign: { sigmaH: 30, sigmaX: 60, blend: 20, maxCross: Infinity },
  // Terrarium (SRTM, ~30 m, con picos sueltos de 5–10 m sobre las pistas): solo las tendencias
  // largas (la regresión local conserva las rampas; lo que suaviza es la curvatura, que en una
  // pista de verdad es muy poca); no más del 2 % de pendiente transversal, y el borde se funde
  // más despacio porque al lado el relieve puede quedar varios metros por encima o por debajo
  global: { sigmaH: 250, sigmaX: 400, blend: 50, maxCross: 0.02 },
}
/** celdas por lado de la rejilla con que se vuelven a mallar las teselas finas (nivel 16) */
const GRID = 128
/** WGS84 (el elipsoide de tiles.ellipsoid) */
const WGS_A = 6378137
const WGS_E2 = 6.69437999014e-3
/** nivel quantized-mesh a partir del cual las teselas se vuelven a mallar */
const REGRID_LEVEL = 15
/** radio de búsqueda de pistas, en teselas vectoriales z14 (≈ 1,9 km) alrededor de la cámara */
const SEARCH = 2

/** Pista con su perfil suavizado, en un plano local con origen en el extremo A. */
export interface Runway {
  key: string
  lat0: number
  lon0: number
  /** metros por grado de latitud y de longitud en el origen */
  mLat: number
  mLon: number
  /** dirección A→B (este, norte), unitaria */
  ux: number
  uy: number
  len: number
  /** semiancho de la zona alisada (m) */
  hw: number
  /** perfil cada `ds` m desde A: altura en el eje (a) y pendiente transversal (b, m/m, + a la derecha) */
  ds: number
  a: Float64Array
  b: Float64Array
  /** transición con el relieve (m) */
  blend: number
  south: number
  west: number
  north: number
  east: number
}

/**
 * Corrección del terreno que no es una pista (p. ej. el rebaje bajo un puente): rectángulo
 * donde actúa y la altura corregida de un punto a partir de la del MDT.
 */
export interface TerrainPatch {
  key: string
  south: number
  west: number
  north: number
  east: number
  /** celda más grande (m) de una rejilla de alturas en la que tiene sentido (gridRunways.ts); sin ella, todas */
  maxCell?: number
  apply(lat: number, lon: number, h: number): number
}

export type Patch = Runway | TerrainPatch
type Box ={ south: number; west: number; north: number; east: number }

interface Piece {
  ref: string
  pts: Array<[number, number]> // [lat, lon]
}

interface VTile {
  state: 'loading' | 'ok' | 'failed'
  pieces: Piece[]
}

/** Ancho probable de la pista según su longitud (OpenMapTiles no trae el ancho). */
function widthFor(len: number): number {
  if (len < 600) return 18
  if (len < 1300) return 26
  if (len < 2000) return 30
  if (len < 3000) return 45
  return 60
}

function smooth01(t: number): number {
  return t * t * (3 - 2 * t)
}

/** Coordenadas de pista (s a lo largo desde A, off lateral + a la derecha) de un punto. */
function toLocal(r: Runway, lat: number, lon: number, out: { s: number; off: number }): void {
  const e = (lon - r.lon0) * r.mLon
  const n = (lat - r.lat0) * r.mLat
  out.s = e * r.ux + n * r.uy
  out.off = e * r.uy - n * r.ux
}

function toGeo(r: Pick<Runway, 'lat0' | 'lon0' | 'mLat' | 'mLon' | 'ux' | 'uy'>, s: number, off: number): [number, number] {
  const e = s * r.ux + off * r.uy
  const n = s * r.uy - off * r.ux
  return [r.lat0 + n / r.mLat, r.lon0 + e / r.mLon]
}

/** Peso de la pista alisada en (s, off): 1 en la pista, 0 fuera de la transición. */
function weightAt(r: Runway, s: number, off: number): number {
  const dl = Math.abs(off) - r.hw
  const de = s < 0 ? -s : s - r.len
  const blend = r.blend
  if (dl >= blend || de >= blend) return 0
  const wl = dl <= 0 ? 1 : smooth01(1 - dl / blend)
  const we = de <= 0 ? 1 : smooth01(1 - de / blend)
  return wl * we
}

/** Altura de la superficie alisada en (s, off). */
function profileAt(r: Runway, s: number, off: number): number {
  const f = Math.min(Math.max(s, 0), r.len) / r.ds
  const i = Math.min(Math.floor(f), r.a.length - 2)
  const t = f - i
  const a = r.a[i] + (r.a[i + 1] - r.a[i]) * t
  const b = r.b[i] + (r.b[i + 1] - r.b[i]) * t
  return a + b * off
}

const _loc = { s: 0, off: 0 }

/** Altura del terreno con las pistas de `list` alisadas (h = altura del MDT en el punto). */
export function adjustWith(list: Patch[], lat: number, lon: number, h: number): number {
  for (const r of list) {
    if (lat < r.south || lat > r.north || lon < r.west || lon > r.east) continue
    if ('apply' in r) {
      h = r.apply(lat, lon, h)
      continue
    }
    toLocal(r, lat, lon, _loc)
    const w = weightAt(r, _loc.s, _loc.off)
    if (w > 0) h += w * (profileAt(r, _loc.s, _loc.off) - h)
  }
  return h
}

function inAnyBox(list: Box[], lat: number, lon: number): boolean {
  for (const r of list) if (lat >= r.south && lat <= r.north && lon >= r.west && lon <= r.east) return true
  return false
}

/** Las correcciones de `list` cuyo rectángulo toca [south, north] × [west, east], en su orden. */
function touching<T extends Box>(list: T[], south: number, west: number, north: number, east: number): T[] {
  return list.filter((r) => north >= r.south && south <= r.north && east >= r.west && west <= r.east)
}

/**
 * Celda del índice de correcciones (grados). Con cientos de parches (rebajes y rellenos de los
 * puentes) recorrerlos todos en cada consulta del suelo y en cada vértice pesaba.
 */
const INDEX_CELL = 0.01
const indexKey = (la: number, lo: number) => (la + 9000) * 40000 + lo + 20000
const NO_PATCHES: Patch[] = []

/** ¿Algún rectángulo de pista solapa con [south, north] × [west, east] (grados)? */
function boxTouches(list: Box[], south: number, west: number, north: number, east: number): boolean {
  return list.some((r) => north >= r.south && south <= r.north && east >= r.west && west <= r.east)
}

/** Regresión lineal local con pesos gaussianos (sin sesgo en los extremos ni en las rampas). */
function localLinear(ys: Float64Array, ok: Uint8Array, ds: number, sigma: number): Float64Array {
  const n = ys.length
  const out = new Float64Array(n)
  const reach = Math.ceil((3 * sigma) / ds)
  for (let i = 0; i < n; i++) {
    let s0 = 0
    let s1 = 0
    let s2 = 0
    let sy = 0
    let sxy = 0
    for (let k = Math.max(0, i - reach); k <= Math.min(n - 1, i + reach); k++) {
      if (!ok[k]) continue
      const d = (k - i) * ds
      const w = Math.exp((-d * d) / (2 * sigma * sigma))
      s0 += w
      s1 += w * d
      s2 += w * d * d
      sy += w * ys[k]
      sxy += w * d * ys[k]
    }
    const den = s0 * s2 - s1 * s1
    out[i] = Math.abs(den) > 1e-9 * s0 * s0 ? (s2 * sy - s1 * sxy) / den : s0 > 0 ? sy / s0 : NaN
  }
  return out
}

type TilesLike = {
  ellipsoid: {
    getPositionToCartographic(p: Vector3, t: { lat: number; lon: number; height: number }): unknown
    getCartographicToPosition(lat: number, lon: number, h: number, t: Vector3): Vector3
    getPositionToNormal(p: Vector3, t: Vector3): Vector3
  }
  group: Object3D
  lruCache: { remove(item: object): boolean }
}

/**
 * Atributos de vértice con la altura sin corregir (m sobre el elipsoide) y de dónde parte
 * la corrección: 0 = de esa misma altura (rejilla: la pista queda en el perfil), 1 = de la
 * del MDT fino en ese punto (TIN de teselas groseras, que conservan su nivel, y faldones).
 * Así cada corrección se calcula desde el original, sin acumular errores, y las teselas que
 * ImageOverlayPlugin trocea (su GeometryClipper interpola todos los atributos) los heredan.
 * (La costura del MDT es casi vertical: volver a muestrear el TIN en la posición redondeada
 * de un vértice puede caer al otro lado del escalón; por eso se guarda la altura original.)
 */
const RAW = 'rwRaw'
const MODE = 'rwMode'

/** Nivel quantized-mesh de una tesela del IGN (por el ancho de su región), o null. */
function tileLevel(tile: any): number | null {
  const r = tile?.boundingVolume?.region as number[] | undefined
  if (!r) return null
  const w = r[2] - r[0]
  return w > 0 ? Math.round(Math.log2(Math.PI / w)) : null
}

/** Región de la tesela en grados: [sur, oeste, norte, este], o null. */
function regionDeg(tile: any): [number, number, number, number] | null {
  const r = tile?.boundingVolume?.region as number[] | undefined
  return r ? [r[1] / DEG, r[0] / DEG, r[3] / DEG, r[2] / DEG] : null
}

const _v = new Vector3()
const _n = new Vector3()
const _m = new Matrix4()
const _mi = new Matrix4()
const _carto = { lat: 0, lon: 0, height: 0 }
const _a = new Vector3()
const _b = new Vector3()
const _c = new Vector3()

export class Runways {
  /** correcciones vigentes (las que se aplican ahora): las pistas y los parches externos */
  private runways: Patch[] = []
  /** las pistas de `runways` */
  private own: Runway[] = []
  /** parches externos (rebajes bajo puentes) */
  private extra: TerrainPatch[] = []
  /** `runways` por celdas, para `adjust`, y la versión con que se hizo */
  private readonly index = new Map<number, Patch[]>()
  private indexVersion = -1
  /** versión de `runways`: cambia al aparecer o desaparecer pistas o parches */
  private version = 0
  private readonly versions = new Map<number, Patch[]>([[0, []]])
  private readonly vtiles = new Map<string, VTile>()
  private readonly built = new Map<string, Runway | null>()
  private readonly building = new Set<string>()
  private readonly abort = new AbortController()
  /** relieve con que se perfilan las pistas */
  private readonly heights: HeightSource
  private readonly tuning: RunwayTuning
  private readonly tiles: TilesLike
  private centerX = NaN
  private centerY = NaN
  private inflight = 0
  private pendingSince = performance.now()
  private waiters: Array<() => void> = []
  private changed = false
  private disposed = false
  /** versión de las pistas con que se dejó cada geometría */
  private readonly applied = new WeakMap<BufferGeometry, number>()
  /** correcciones que cambiaron en la última versión */
  private lastChanged: Patch[] = []
  private readonly tileVersion = new WeakMap<object, number>()
  /** geometrías ya convertidas en rejilla */
  private readonly gridded = new WeakSet<BufferGeometry>()
  /** teselas que ya se mandaron recargar para mallarlas (una vez) */
  private readonly reloaded = new WeakSet<object>()

  /**
   * heights: relieve con que se perfilan las pistas. Para alisar mallas del IGN (plugin(),
   * reapply, refresh) tiene que ser el QMHeightSource de esas mallas; con el relieve global
   * solo se usan el descubrimiento y los perfiles (gridRunways.ts).
   */
  constructor(heights: HeightSource, tiles: TilesLike, tuning: RunwayTuning = RUNWAY_TUNING.ign) {
    this.heights = heights
    this.tiles = tiles
    this.tuning = tuning
  }

  /** El MDT del IGN (solo en las funciones que trabajan sobre sus mallas). */
  private get qm(): QMHeightSource {
    return this.heights as QMHeightSource
  }

  /** Todas las correcciones vigentes (pistas y parches externos). */
  get patches(): readonly Patch[] {
    return this.runways
  }

  /** Plugin para TilesRenderer: alisa cada tesela de terreno al cargarla. */
  plugin(): object {
    return {
      name: 'RUNWAY_FLATTEN_PLUGIN',
      // después de que QuantizedMeshPlugin cree la malla y antes de que ImageOverlayPlugin la trocee
      priority: -50,
      fetchData: (url: string, options: RequestInit) => this.fetchData(url, options),
      processTileModel: (scene: Object3D, tile: any) => this.processTile(scene, tile),
    }
  }

  /**
   * Descarga de una tesela fina: si aún se buscan pistas por allí, espera a conocerlas, y si
   * toca alguna, carga antes sus datos en `heights` para mallarla en rejilla al procesarla.
   * (El procesado tiene que ser síncrono: ImageOverlayPlugin trabaja a la vez sobre la malla.)
   */
  private fetchData(url: string, options: RequestInit): Promise<Response> | null {
    const m = /\/(\d+)\/(\d+)\/(\d+)\.terrain/.exec(url)
    if (!m) return null
    const z = Number(m[1])
    const x = Number(m[2])
    const y = Number(m[3])
    if (z < REGRID_LEVEL) return null
    const size = 180 / 2 ** z
    const reg: [number, number, number, number] = [-90 + y * size, -180 + x * size, -90 + (y + 1) * size, -180 + (x + 1) * size]
    const wait = this.busy && this.covers((reg[0] + reg[2]) / 2, (reg[1] + reg[3]) / 2)
    if (!wait && !boxTouches(this.runways, ...reg)) return null
    return (async () => {
      if (wait) await this.whenSettled()
      if (boxTouches(this.runways, ...reg)) await this.qm.ensureTile(z, x, y)
      return fetch(url, options)
    })()
  }

  private get busy(): boolean {
    return this.inflight > 0 || this.building.size > 0
  }

  /** ¿Faltan aún pistas por descubrir o perfilar cerca? (con un tope de 8 s para no bloquear) */
  get pending(): boolean {
    return this.busy && performance.now() - this.pendingSince < 8000
  }

  /** Altura del suelo en (lat, lon) con las pistas alisadas, a partir de la del MDT. */
  adjust(lat: number, lon: number, h: number): number {
    if (!this.runways.length) return h
    if (this.indexVersion !== this.version) this.buildIndex()
    return adjustWith(this.index.get(indexKey(Math.floor(lat / INDEX_CELL), Math.floor(lon / INDEX_CELL))) ?? NO_PATCHES, lat, lon, h)
  }

  /** Reparte las correcciones vigentes por celdas de INDEX_CELL (cada celda, en el orden de la lista). */
  private buildIndex(): void {
    this.index.clear()
    for (const r of this.runways) {
      for (let la = Math.floor(r.south / INDEX_CELL); la <= Math.floor(r.north / INDEX_CELL); la++) {
        for (let lo = Math.floor(r.west / INDEX_CELL); lo <= Math.floor(r.east / INDEX_CELL); lo++) {
          const k = indexKey(la, lo)
          const l = this.index.get(k)
          if (l) l.push(r)
          else this.index.set(k, [r])
        }
      }
    }
    this.indexVersion = this.version
  }

  /** Pistas vigentes (para depurar). */
  get list(): readonly Runway[] {
    return this.own
  }

  /** Parches de terreno externos (los rebajes bajo puentes de Bridges.ts): sustituyen a los anteriores. */
  setExtra(patches: TerrainPatch[]): void {
    if (this.disposed) return
    this.extra = patches
    this.commit(this.own)
  }

  /** Publica la lista de correcciones si ha cambiado (nueva versión: las mallas se ponen al día). */
  private commit(own: Runway[]): void {
    this.own = own
    const next: Patch[] = [...own, ...this.extra]
    const same = next.length === this.runways.length && next.every((r, i) => r === this.runways[i])
    if (same) return
    // las que aparecen o desaparecen: solo las mallas que tocan alguna cambian de altura
    this.lastChanged = [...next.filter((r) => !this.runways.includes(r)), ...this.runways.filter((r) => !next.includes(r))]
    this.runways = next
    this.version++
    this.versions.set(this.version, next)
    // versiones viejas que ya no puede tener ninguna malla (se guardan unas cuantas por las teselas en vuelo)
    for (const v of this.versions.keys()) if (v < this.version - 64) this.versions.delete(v)
    this.changed = true
  }

  /** true una vez tras cambiar las pistas: hay que volver a aplicar las mallas cargadas. */
  consumeChanged(): boolean {
    const c = this.changed
    this.changed = false
    return c
  }

  // -------------------------------------------------------------------------
  // Descubrimiento de pistas (teselas vectoriales z14 alrededor de la cámara)
  // -------------------------------------------------------------------------

  update(lat: number, lon: number): void {
    if (this.disposed) return
    const n = 2 ** Z
    const cx = Math.floor(lonToX(lon, n))
    const cy = Math.floor(latToY(lat, n))
    if (cx === this.centerX && cy === this.centerY) return
    this.centerX = cx
    this.centerY = cy
    for (const [k, t] of this.vtiles) {
      const [x, y] = k.split('/').map(Number)
      if (t.state !== 'loading' && Math.max(Math.abs(x - cx), Math.abs(y - cy)) > SEARCH + 2) this.vtiles.delete(k)
    }
    for (let dy = -SEARCH; dy <= SEARCH; dy++) for (let dx = -SEARCH; dx <= SEARCH; dx++) this.request(cx + dx, cy + dy)
    this.rebuild()
  }

  private request(x: number, y: number): void {
    const key = `${x}/${y}`
    if (this.vtiles.has(key)) return
    if (Math.max(Math.abs(x - this.centerX), Math.abs(y - this.centerY)) > SEARCH + 2) return
    const t: VTile = { state: 'loading', pieces: [] }
    this.vtiles.set(key, t)
    if (!this.busy) this.pendingSince = performance.now()
    this.inflight++
    fetchVectorTile(x, y, this.abort.signal)
      .then((vt) => {
        t.pieces = runwayPieces(vt, x, y)
        t.state = 'ok'
      })
      .catch(() => {
        t.state = 'failed'
      })
      .finally(() => {
        this.inflight--
        if (this.disposed) return
        // una pista cortada por el borde de la tesela sigue en la vecina: pedirla también
        const n = 2 ** Z
        for (const p of t.pieces) {
          for (const [la, lo] of [p.pts[0], p.pts[p.pts.length - 1]]) this.request(Math.floor(lonToX(lo, n)), Math.floor(latToY(la, n)))
        }
        this.rebuild()
      })
  }

  /** Agrupa los trozos de pista de las teselas cargadas y prepara los perfiles que falten. */
  private rebuild(): void {
    if (this.disposed || this.inflight > 0) return
    const pieces: Piece[] = []
    for (const t of this.vtiles.values()) if (t.state === 'ok') pieces.push(...t.pieces)
    const groups = clusterPieces(pieces)
    const keys: string[] = []
    for (const g of groups) {
      keys.push(g.key)
      if (this.built.has(g.key) || this.building.has(g.key)) continue
      if (!this.busy) this.pendingSince = performance.now()
      this.building.add(g.key)
      void this.buildProfile(g)
        .catch(() => null)
        .then((r) => {
          this.building.delete(g.key)
          this.built.set(g.key, r)
          this.rebuild()
        })
    }
    if (this.building.size > 0) return
    this.commit(keys.map((k) => this.built.get(k)).filter((r): r is Runway => Boolean(r)))
    // olvidar perfiles de pistas lejanas
    if (this.built.size > 64) for (const k of this.built.keys()) if (!keys.includes(k)) this.built.delete(k)
    // las teselas que esperaban a conocer las pistas ya pueden seguir
    const w = this.waiters
    this.waiters = []
    for (const f of w) f()
  }

  /** Espera a que no haya pistas pendientes (como mucho hasta el tope de `pending`). */
  private whenSettled(): Promise<void> {
    if (!this.pending) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve)
      setTimeout(resolve, Math.max(0, 8000 - (performance.now() - this.pendingSince)))
    })
  }

  /** ¿La búsqueda de pistas en curso cubre este punto? */
  private covers(lat: number, lon: number): boolean {
    const n = 2 ** Z
    const x = Math.floor(lonToX(lon, n))
    const y = Math.floor(latToY(lat, n))
    return Math.abs(x - this.centerX) <= SEARCH + 1 && Math.abs(y - this.centerY) <= SEARCH + 1
  }

  /** Perfil suave de una pista a partir del MDT fino. */
  private async buildProfile(g: { key: string; a: [number, number]; b: [number, number] }): Promise<Runway | null> {
    const [lat0, lon0] = g.a
    const mLat = 111132.92 - 559.82 * Math.cos(2 * lat0 * DEG) + 1.175 * Math.cos(4 * lat0 * DEG)
    const mLon = 111412.84 * Math.cos(lat0 * DEG) - 93.5 * Math.cos(3 * lat0 * DEG)
    const ex = (g.b[1] - lon0) * mLon
    const ny = (g.b[0] - lat0) * mLat
    const len = Math.hypot(ex, ny)
    if (len < 150 || len > 6000) return null
    const hw = widthFor(len) / 2 + 4
    const { sigmaH, sigmaX, blend, maxCross } = this.tuning
    const base = { lat0, lon0, mLat, mLon, ux: ex / len, uy: ny / len }
    let south = 90
    let north = -90
    let west = 180
    let east = -180
    for (const s of [-blend, len + blend]) {
      for (const off of [-hw - blend, hw + blend]) {
        const [la, lo] = toGeo(base, s, off)
        south = Math.min(south, la)
        north = Math.max(north, la)
        west = Math.min(west, lo)
        east = Math.max(east, lo)
      }
    }
    await this.heights.ensure(south, west, north, east)
    if (this.disposed) return null

    const count = Math.max(2, Math.ceil(len / STATION) + 1)
    const ds = len / (count - 1)
    const aRaw = new Float64Array(count)
    const bRaw = new Float64Array(count)
    const ok = new Uint8Array(count)
    let valid = 0
    for (let i = 0; i < count; i++) {
      // ajuste lineal transversal h = a + b·off con muestras cada 2,5 m de lado a lado
      let n = 0
      let so = 0
      let soo = 0
      let sh = 0
      let soh = 0
      for (let off = -hw; off <= hw + 1e-6; off += 2.5) {
        const [la, lo] = toGeo(base, i * ds, off)
        const h = this.heights.sample(la, lo)
        if (h === null) continue
        n++
        so += off
        soo += off * off
        sh += h
        soh += off * h
      }
      if (n < 4) continue
      const den = n * soo - so * so
      bRaw[i] = den > 1e-9 ? (n * soh - so * sh) / den : 0
      aRaw[i] = (sh - bRaw[i] * so) / n
      ok[i] = 1
      valid++
    }
    if (valid < count * 0.6) return null
    const a = localLinear(aRaw, ok, ds, sigmaH)
    const b = localLinear(bRaw, ok, ds, sigmaX)
    for (let i = 0; i < count; i++) {
      if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) return null
      b[i] = Math.max(-maxCross, Math.min(maxCross, b[i]))
    }
    return { key: g.key, ...base, len, hw, ds, a, b, blend, south, west, north, east }
  }

  // -------------------------------------------------------------------------
  // Teselas del terreno
  // -------------------------------------------------------------------------

  private processTile(scene: Object3D, tile: any): void {
    // los hijos virtuales (teselas troceadas de la del padre) heredan la corrección que tenía el padre
    const virtual = Boolean(tile?.internal?.isVirtual)
    const inherited = virtual && tile.parent ? (this.tileVersion.get(tile.parent) ?? 0) : 0
    const z = virtual ? null : tileLevel(tile)
    const reg = regionDeg(tile)
    // tesela fina que toca una pista: rejilla regular en lugar del TIN (datos ya cargados en fetchData)
    if (z !== null && z >= REGRID_LEVEL && reg && boxTouches(this.runways, ...reg)) this.regrid(scene, z, reg)
    this.applyScene(scene, tile, inherited)
  }

  private applyScene(scene: Object3D, tile: any, inherited: number): void {
    scene.updateMatrixWorld(true)
    scene.traverse((o) => {
      if ((o as Mesh).isMesh) this.applyMesh(o as Mesh, inherited)
    })
    if (tile) this.tileVersion.set(tile, this.version)
  }

  /** Vuelve a aplicar las pistas vigentes a las mallas ya cargadas. */
  reapply(meshes: Iterable<Mesh>): void {
    const reload = new Set<object>()
    for (const m of meshes) {
      const tile = m.userData.tile
      const z = tile?.internal?.isVirtual ? null : tileLevel(tile)
      const reg = regionDeg(tile)
      // tesela fina cargada antes de conocer la pista: recargarla para mallarla en rejilla
      if (z !== null && z >= REGRID_LEVEL && reg && !this.gridded.has(m.geometry) && !this.reloaded.has(tile) && boxTouches(this.runways, ...reg)) {
        reload.add(tile)
        continue
      }
      this.refresh(m, this.lastChanged)
    }
    for (const t of reload) {
      this.reloaded.add(t)
      this.tiles.lruCache.remove(t)
    }
  }

  /**
   * Pone al día una malla cargada (si se procesó con otra versión de las pistas). Con
   * `changed`, si venía de la versión anterior y no toca ninguna de esas pistas, no cambia.
   */
  refresh(mesh: Mesh, changed?: Patch[]): void {
    const v = this.applied.get(mesh.geometry)
    if (v === this.version) return
    const tile = mesh.userData.tile
    const inherited = tile?.internal?.isVirtual && tile.parent ? (this.tileVersion.get(tile.parent) ?? 0) : 0
    this.applyMesh(mesh, inherited, v === this.version - 1 ? changed : undefined)
    if (tile) this.tileVersion.set(tile, this.version)
  }

  /** Corrección (m) que las pistas de `list` dan a un punto; NaN si falta el MDT fino. */
  private deltaAt(list: Patch[], lat: number, lon: number): number {
    if (!list.length || !inAnyBox(list, lat, lon)) return 0
    const h = this.heights.sample(lat, lon)
    if (h === null) return NaN
    return adjustWith(list, lat, lon, h) - h
  }

  /** Matriz malla → ECEF (fuera de la escena al procesarla; dentro, quitando la de tiles.group). */
  private ecefMatrix(mesh: Mesh, out: Matrix4): Matrix4 {
    mesh.updateWorldMatrix(true, false)
    out.copy(mesh.matrixWorld)
    if (isDescendant(mesh, this.tiles.group)) out.premultiply(_mi.copy(this.tiles.group.matrixWorld).invert())
    return out
  }

  /**
   * Sustituye la superficie TIN de una tesela fina por una rejilla regular muestreada del
   * mismo TIN (alturas sin corregir: la corrección la pone applyMesh). Conserva los faldones.
   */
  private regrid(scene: Object3D, z: number, reg: [number, number, number, number]): void {
    let mesh: Mesh | null = null
    scene.traverse((o) => {
      if (!mesh && (o as Mesh).isMesh) mesh = o as Mesh
    })
    if (!mesh) return
    const m = mesh as Mesh
    const geo = m.geometry as BufferGeometry
    if (this.gridded.has(geo)) return
    const [south, west, north, east] = reg
    const size = 180 / 2 ** z
    const tx = Math.round((west + 180) / size)
    const ty = Math.round((south + 90) / size)
    // los datos los cargó fetchData; si no están (tesela recién descartada), se queda en TIN
    if (this.qm.sampleTile(z, tx, ty, 0.5, 0.5) === null) return

    const pos = geo.getAttribute('position')
    const uv = geo.getAttribute('uv')
    const nor = geo.getAttribute('normal')
    const idx = geo.index
    if (!pos || !uv || !idx || !geo.groups.length) return
    const g0 = geo.groups[0]
    // los vértices de la superficie van primero; los faldones, detrás
    let surf = 0
    for (let k = g0.start; k < g0.start + g0.count; k++) surf = Math.max(surf, idx.getX(k) + 1)
    const skirt = pos.count - surf

    // ~1,8 × 2,4 m en el nivel 16; el 15 (que se ve de más lejos) con la mitad de celdas por lado
    const grid = z >= 16 ? GRID : GRID / 2
    const side = grid + 1
    const count = side * side + skirt
    const P = new Float32Array(count * 3)
    const U = new Float32Array(count * 2)
    const N = new Float32Array(count * 3)
    const R = new Float32Array(count)
    const Mo = new Float32Array(count).fill(2)
    this.ecefMatrix(m, _m)
    const inv = _mi.copy(_m).invert()
    const ell = this.tiles.ellipsoid
    const list = touching(this.runways, south, west, north, east)
    // ECEF por filas y columnas (WGS84, como tiles.ellipsoid; se comprueba con él en una esquina)
    const cosL = new Float64Array(side)
    const sinL = new Float64Array(side)
    for (let i = 0; i < side; i++) {
      const lon = (west + (i / grid) * (east - west)) * DEG
      cosL[i] = Math.cos(lon)
      sinL[i] = Math.sin(lon)
    }
    ell.getCartographicToPosition(south * DEG, west * DEG, 500, _a)
    const n0 = WGS_A / Math.sqrt(1 - WGS_E2 * Math.sin(south * DEG) ** 2)
    _b.set((n0 + 500) * Math.cos(south * DEG) * cosL[0], (n0 + 500) * Math.cos(south * DEG) * sinL[0], (n0 * (1 - WGS_E2) + 500) * Math.sin(south * DEG))
    const fast = _a.distanceTo(_b) < 0.01
    for (let j = 0; j < side; j++) {
      const fv = j / grid
      const latD = south + fv * (north - south)
      const sp = Math.sin(latD * DEG)
      const cp = Math.cos(latD * DEG)
      const nr = WGS_A / Math.sqrt(1 - WGS_E2 * sp * sp)
      for (let i = 0; i < side; i++) {
        const fu = i / grid
        const h = this.qm.sampleTile(z, tx, ty, fu, fv)
        if (h === null) return
        const k = j * side + i
        R[k] = h
        Mo[k] = 0
        // la rejilla sale ya en la pista alisada (applyMesh no tendrá nada que hacer)
        const hf = adjustWith(list, latD, west + fu * (east - west), h)
        if (fast) _v.set((nr + hf) * cp * cosL[i], (nr + hf) * cp * sinL[i], (nr * (1 - WGS_E2) + hf) * sp)
        else ell.getCartographicToPosition(latD * DEG, (west + fu * (east - west)) * DEG, hf, _v)
        _v.applyMatrix4(inv)
        P[3 * k] = _v.x
        P[3 * k + 1] = _v.y
        P[3 * k + 2] = _v.z
        U[2 * k] = fu
        U[2 * k + 1] = fv
      }
    }
    const base = side * side
    for (let k = 0; k < skirt; k++) {
      for (let c = 0; c < 3; c++) if (nor) N[3 * (base + k) + c] = nor.array[3 * (surf + k) + c]
      U[2 * (base + k)] = uv.array[2 * (surf + k)]
      U[2 * (base + k) + 1] = uv.array[2 * (surf + k) + 1]
      // faldones: misma corrección que el borde (desde el MDT fino), conservando su largo
      _v.fromBufferAttribute(pos, surf + k).applyMatrix4(_m)
      ell.getPositionToCartographic(_v, _carto)
      R[base + k] = _carto.height
      const lat = _carto.lat / DEG
      const lon = _carto.lon / DEG
      const h16 = inAnyBox(list, lat, lon) ? this.heights.sample(lat, lon) : null
      if (h16 !== null) {
        ell.getPositionToNormal(_v, _n)
        _v.addScaledVector(_n, adjustWith(list, lat, lon, h16) - h16)
      }
      _v.applyMatrix4(inv)
      P[3 * (base + k)] = _v.x
      P[3 * (base + k) + 1] = _v.y
      P[3 * (base + k) + 2] = _v.z
    }

    const rest = idx.count - (g0.start + g0.count)
    const triCount = grid * grid * 6
    const I = count > 65535 ? new Uint32Array(triCount + rest + g0.start) : new Uint16Array(triCount + rest + g0.start)
    let o = 0
    for (let j = 0; j < grid; j++) {
      for (let i = 0; i < grid; i++) {
        const a = j * side + i
        const b = a + 1
        const c = a + side + 1
        const d = a + side
        // antihorario visto desde arriba (u al este, v al norte), como el TIN
        I[o++] = a
        I[o++] = b
        I[o++] = c
        I[o++] = a
        I[o++] = c
        I[o++] = d
      }
    }
    // índices de los faldones (y de lo que hubiera antes del grupo 0), con su nuevo origen
    const remap = (v: number) => (v >= surf ? v - surf + base : v)
    for (let k = 0; k < g0.start; k++) I[o++] = remap(idx.getX(k))
    for (let k = g0.start + g0.count; k < idx.count; k++) I[o++] = remap(idx.getX(k))
    const groups = geo.groups.map((g) => ({ ...g }))
    geo.clearGroups()
    geo.addGroup(0, triCount, groups[0].materialIndex)
    let start = triCount
    for (const g of groups.slice(1)) {
      geo.addGroup(start, g.count, g.materialIndex)
      start += g.count
    }
    geo.setIndex(new BufferAttribute(I, 1))
    geo.setAttribute('position', new BufferAttribute(P, 3))
    geo.setAttribute('uv', new BufferAttribute(U, 2))
    if (nor) geo.setAttribute('normal', new BufferAttribute(N, 3))
    geo.setAttribute(RAW, new BufferAttribute(R, 1))
    geo.setAttribute(MODE, new BufferAttribute(Mo, 1))
    surfaceNormals(geo)
    geo.computeBoundingSphere()
    geo.computeBoundingBox()
    this.gridded.add(geo)
    this.applied.set(geo, this.version)
  }

  /**
   * Alturas originales de una malla que aún no las tiene: las actuales, salvo en un hijo
   * virtual sin ellas (troceado de un padre sin atributos), donde se descuenta la corrección
   * que heredó (estimada con el MDT fino).
   */
  private rawHeights(geo: BufferGeometry, inherited: number): void {
    const pos = geo.getAttribute('position')
    const count = pos.count
    const R = new Float32Array(count)
    const Mo = new Float32Array(count).fill(1)
    // faldones: los vértices que no usa la superficie (grupo 0) de una malla quantized-mesh
    const idx = geo.index
    if (idx && geo.groups.length > 1) {
      Mo.fill(2)
      const g0 = geo.groups[0]
      for (let k = g0.start; k < g0.start + g0.count; k++) Mo[idx.getX(k)] = 1
    }
    let oldList = inherited ? (this.versions.get(inherited) ?? []) : []
    if (oldList.length) {
      // (por vértice, solo las que tocan la malla)
      if (!geo.boundingSphere) geo.computeBoundingSphere()
      const sph = geo.boundingSphere!
      _v.copy(sph.center).applyMatrix4(_m)
      this.tiles.ellipsoid.getPositionToCartographic(_v, _carto)
      const cLat = _carto.lat / DEG
      const rLat = sph.radius / 111000
      const rLon = rLat / Math.max(0.1, Math.cos(cLat * DEG))
      oldList = touching(oldList, cLat - rLat, _carto.lon / DEG - rLon, cLat + rLat, _carto.lon / DEG + rLon)
    }
    for (let i = 0; i < count; i++) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(_m)
      this.tiles.ellipsoid.getPositionToCartographic(_v, _carto)
      let h = _carto.height
      if (oldList.length) {
        const d = this.deltaAt(oldList, _carto.lat / DEG, _carto.lon / DEG)
        if (!Number.isNaN(d)) h -= d
      }
      R[i] = h
    }
    geo.setAttribute(RAW, new BufferAttribute(R, 1))
    geo.setAttribute(MODE, new BufferAttribute(Mo, 1))
  }

  /**
   * Deja los vértices de una malla en la altura que les dan las pistas vigentes, calculada
   * siempre desde su altura original (atributos RAW/MODE), sin acumular correcciones.
   */
  private applyMesh(mesh: Mesh, inherited: number, changed?: Patch[]): void {
    const geo = mesh.geometry as BufferGeometry
    const pos = geo.getAttribute('position')
    if (!pos || this.applied.get(geo) === this.version) return
    const list = this.runways

    this.ecefMatrix(mesh, _m)

    // descarte rápido con la esfera envolvente: lejos de las pistas de ahora y de las recientes
    // (si alguna vez se corrigió, tiene RAW y hay que poder deshacerlo)
    let raw = geo.getAttribute(RAW)
    if (!geo.boundingSphere) geo.computeBoundingSphere()
    const sph = geo.boundingSphere!
    _v.copy(sph.center).applyMatrix4(_m)
    this.tiles.ellipsoid.getPositionToCartographic(_v, _carto)
    const cLat = _carto.lat / DEG
    const cLon = _carto.lon / DEG
    const rLat = sph.radius / 111000
    const rLon = rLat / Math.max(0.1, Math.cos(cLat * DEG))
    // (por vértice, solo las que tocan la malla)
    const local = touching(list, cLat - rLat, cLon - rLon, cLat + rLat, cLon + rLon)
    const near = local.length > 0
    const unaffected = changed && !boxTouches(changed, cLat - rLat, cLon - rLon, cLat + rLat, cLon + rLon)
    if ((!near && !raw) || unaffected) {
      this.applied.set(geo, this.version)
      return
    }
    if (!raw) {
      this.rawHeights(geo, inherited)
      raw = geo.getAttribute(RAW)
    }
    const mode = geo.getAttribute(MODE)

    _mi.copy(_m).invert()
    const ell = this.tiles.ellipsoid
    let moved = false
    for (let i = 0; i < pos.count; i++) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(_m)
      ell.getPositionToCartographic(_v, _carto)
      const lat = _carto.lat / DEG
      const lon = _carto.lon / DEG
      const r0 = raw.getX(i)
      let target = r0
      if (near && inAnyBox(local, lat, lon)) {
        // la rejilla parte de su propia altura; el resto, de la del MDT fino en el punto
        const base = mode && mode.getX(i) < 0.5 ? r0 : this.heights.sample(lat, lon)
        if (base === null) continue
        target = r0 + adjustWith(local, lat, lon, base) - base
      }
      const dd = target - _carto.height
      if (Math.abs(dd) > 1e-3) {
        ell.getPositionToNormal(_v, _n)
        _v.addScaledVector(_n, dd).applyMatrix4(_mi)
        pos.setXYZ(i, _v.x, _v.y, _v.z)
        moved = true
      }
    }
    this.applied.set(geo, this.version)
    if (!moved) return
    pos.needsUpdate = true
    surfaceNormals(geo)
    geo.computeBoundingSphere()
    const g = geo as any
    if (g.boundsTree) g.disposeBoundsTree()
  }

  dispose(): void {
    this.disposed = true
    this.abort.abort()
    this.vtiles.clear()
    this.built.clear()
    const w = this.waiters
    this.waiters = []
    for (const f of w) f()
  }
}

function isDescendant(o: Object3D, root: Object3D): boolean {
  for (let p = o.parent; p; p = p.parent) if (p === root) return true
  return false
}

/**
 * Normales de la superficie, como computeVertexNormals; los faldones (MODE = 2, o fuera del
 * grupo 0 si no hay MODE) conservan las suyas.
 */
function surfaceNormals(geo: BufferGeometry): void {
  const idx = geo.index
  const pos = geo.getAttribute('position')
  const nor = geo.getAttribute('normal')
  if (!idx || !pos || !nor) return
  const mode = geo.getAttribute(MODE)
  const g = mode ? { start: 0, count: idx.count } : (geo.groups[0] ?? { start: 0, count: idx.count })
  const skirt = (i: number) => (mode ? mode.getX(i) > 1.5 : false)
  const used = new Uint8Array(pos.count)
  const end = Math.min(idx.count, g.start + g.count)
  for (let k = g.start; k < end; k++) {
    const i = idx.getX(k)
    if (!skirt(i)) used[i] = 1
  }
  const acc = new Float32Array(pos.count * 3)
  for (let k = g.start; k + 2 < end; k += 3) {
    const ia = idx.getX(k)
    const ib = idx.getX(k + 1)
    const ic = idx.getX(k + 2)
    if (skirt(ia) || skirt(ib) || skirt(ic)) continue
    _a.fromBufferAttribute(pos, ia)
    _b.fromBufferAttribute(pos, ib)
    _c.fromBufferAttribute(pos, ic)
    _c.sub(_b)
    _a.sub(_b)
    _c.cross(_a)
    acc[3 * ia] += _c.x
    acc[3 * ia + 1] += _c.y
    acc[3 * ia + 2] += _c.z
    acc[3 * ib] += _c.x
    acc[3 * ib + 1] += _c.y
    acc[3 * ib + 2] += _c.z
    acc[3 * ic] += _c.x
    acc[3 * ic + 1] += _c.y
    acc[3 * ic + 2] += _c.z
  }
  for (let i = 0; i < pos.count; i++) {
    if (!used[i]) continue
    _a.set(acc[3 * i], acc[3 * i + 1], acc[3 * i + 2])
    if (_a.lengthSq() === 0) continue
    _a.normalize()
    nor.setXYZ(i, _a.x, _a.y, _a.z)
  }
  nor.needsUpdate = true
}

/** Trozos de pista (líneas aeroway=runway) de una tesela vectorial z14, en lat/lon. */
function runwayPieces(vt: { layers: Record<string, any> }, x: number, y: number): Piece[] {
  const layer = vt.layers.aeroway
  const out: Piece[] = []
  if (!layer) return out
  const n = 2 ** Z
  const E = layer.extent
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i)
    if (f.type !== 2 || f.properties.class !== 'runway') continue
    for (const line of f.loadGeometry() as Array<Array<{ x: number; y: number }>>) {
      if (line.length < 2) continue
      out.push({
        ref: String(f.properties.ref ?? ''),
        pts: line.map((p): [number, number] => [yToLat(y + p.y / E, n), xToLon(x + p.x / E, n)]),
      })
    }
  }
  return out
}

/**
 * Une los trozos de una misma pista (cortada por las teselas, o dibujada con varios
 * tramos) y devuelve una recta por pista: de un extremo a otro de todos sus puntos.
 */
function clusterPieces(pieces: Piece[]): Array<{ key: string; a: [number, number]; b: [number, number] }> {
  type Cl = { ref: string; lat0: number; lon0: number; mLon: number; ux: number; uy: number; pts: Array<[number, number]> }
  const mLat = 111132
  const cls: Cl[] = []
  for (const p of pieces) {
    const [la0, lo0] = p.pts[0]
    const [la1, lo1] = p.pts[p.pts.length - 1]
    const mLon = mLat * Math.cos(la0 * DEG)
    const ex = (lo1 - lo0) * mLon
    const ny = (la1 - la0) * mLat
    const l = Math.hypot(ex, ny)
    if (l < 1) continue
    const ux = ex / l
    const uy = ny / l
    const c = cls.find((c) => {
      if (c.ref !== p.ref) return false
      if (Math.abs(c.ux * uy - c.uy * ux) > 0.07) return false // ≈ 4°
      // distancia de los extremos del trozo a la recta del grupo
      for (const [la, lo] of [p.pts[0], p.pts[p.pts.length - 1]]) {
        const e = (lo - c.lon0) * c.mLon
        const nn = (la - c.lat0) * mLat
        if (Math.abs(e * c.uy - nn * c.ux) > 25) return false
      }
      return true
    })
    if (c) c.pts.push(...p.pts)
    else cls.push({ ref: p.ref, lat0: la0, lon0: lo0, mLon, ux, uy, pts: [...p.pts] })
  }
  const out: Array<{ key: string; a: [number, number]; b: [number, number] }> = []
  for (const c of cls) {
    let sMin = Infinity
    let sMax = -Infinity
    let a: [number, number] = c.pts[0]
    let b: [number, number] = c.pts[0]
    for (const pt of c.pts) {
      const s = (pt[1] - c.lon0) * c.mLon * c.ux + (pt[0] - c.lat0) * mLat * c.uy
      if (s < sMin) {
        sMin = s
        a = pt
      }
      if (s > sMax) {
        sMax = s
        b = pt
      }
    }
    const k = (v: number) => v.toFixed(5)
    out.push({ key: `${c.ref}|${k(a[0])},${k(a[1])}|${k(b[0])},${k(b[1])}`, a, b })
  }
  return out
}
