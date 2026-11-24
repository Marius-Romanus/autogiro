// Pistas alisadas sobre el relieve global (Terrarium, fuera de España).
//
// El relieve Terrarium de 3d-tiles-renderer (TerrainRGBMeshPlugin) desplaza en la GPU una
// malla lisa con una rejilla de alturas por tesela de origen (DataTexture de float, con un
// marco de un texel copiado de las vecinas). Esa misma rejilla da la altura del suelo a la
// física (sampleCartographicElevation). Así que aquí no se tocan mallas: se corrige la
// rejilla. Cada texel que cae en una pista o en su transición pasa a la altura del perfil
// alisado (Runways.ts, con el suavizado ancho de RUNWAY_TUNING.global), y el dibujo y la
// física cambian a la vez.
//
// Cada rejilla guarda sus alturas originales, así que al aparecer o desaparecer pistas se
// recalcula desde ellas sin acumular errores; después se vuelve a copiar el marco con las
// vecinas (o, sin vecina, se repite el borde, como hace la librería) para que no quede un
// escalón en el borde de las teselas.

import type { Mesh } from 'three'
import type { HeightSource } from './HeightSource.ts'
import { adjustWith, RUNWAY_TUNING, Runways, type Patch } from './Runways.ts'

const DEG = Math.PI / 180
/** nivel más grosero que se corrige (texel ≈ 150 m: por encima ni se distinguen las pistas) */
const MIN_LEVEL = 10

interface Grid {
  image: { data: Float32Array; width: number; height: number }
  source: object
  needsUpdate: boolean
}

type Key = [number, number, number]

interface GridCacheLike {
  fetchItem(key: Key, signal: AbortSignal): Promise<Grid>
  get(x: number, y: number, level: number): Grid | Promise<Grid> | null
  forEachItem(cb: (grid: Grid, key: Key) => void): void
}

interface PluginLike {
  _gridCache?: GridCacheLike
  _tiling?: { flipY: boolean; getTileBounds(x: number, y: number, level: number): number[]; getLevel(level: number): { tileCountX: number } } | null
}

type TilesArg = ConstructorParameters<typeof Runways>[1]

const mercY = (latDeg: number) => Math.log(Math.tan(Math.PI / 4 + (latDeg * DEG) / 2))
const mercLat = (m: number) => (2 * Math.atan(Math.exp(m)) - Math.PI / 2) / DEG

function isGrid(g: unknown): g is Grid {
  return Boolean(g) && !(g instanceof Promise) && (g as Grid).image?.data instanceof Float32Array
}

/**
 * Copia en el marco de `dst` que mira a la vecina (dx, dy) los texeles del borde de `src`
 * (como la librería; las filas van de sur a norte).
 */
function fillBorder(dst: Grid, src: Grid, dx: number, dy: number): void {
  const { data, width, height } = dst.image
  const from = src.image.data
  const w = width - 2
  const h = height - 2
  const [x0, x1] = dx === -1 ? [0, 0] : dx === 1 ? [width - 1, width - 1] : [1, width - 2]
  const [y0, y1] = dy === -1 ? [0, 0] : dy === 1 ? [height - 1, height - 1] : [1, height - 2]
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) data[y * width + x] = from[(y - dy * h) * width + (x - dx * w)]
}

/** Sin vecina cargada: el marco de ese lado repite el borde de la propia rejilla. */
function repeatEdge(g: Grid, dx: number, dy: number): void {
  const { data, width, height } = g.image
  const [x0, x1] = dx === -1 ? [0, 0] : dx === 1 ? [width - 1, width - 1] : [1, width - 2]
  const [y0, y1] = dy === -1 ? [0, 0] : dy === 1 ? [height - 1, height - 1] : [1, height - 2]
  for (let y = y0; y <= y1; y++) {
    const yi = Math.min(Math.max(y, 1), height - 2)
    for (let x = x0; x <= x1; x++) data[y * width + x] = data[yi * width + Math.min(Math.max(x, 1), width - 2)]
  }
}

export class GridRunways {
  /** descubrimiento y perfiles de las pistas */
  readonly runways: Runways
  private readonly cache: GridCacheLike | null
  private readonly plugin: PluginLike
  /** alturas originales (sin pistas) de cada rejilla */
  private readonly raw = new WeakMap<Grid, Float32Array>()
  /** correcciones que tienen aplicadas las rejillas */
  private applied: readonly Patch[] = []
  /** texturas cambiadas que las mallas aún tienen que volver a subir a la GPU */
  private readonly dirty = new Set<object>()
  private readonly heights: HeightSource

  /**
   * plugin: el TerrariumMeshPlugin (después de flattenSea: el original es el relieve ya con el mar
   * a cota 0). heights: el relieve Terrarium con que se perfilan las pistas (pasa a ser de esta clase).
   */
  constructor(plugin: unknown, tiles: TilesArg, heights: HeightSource) {
    this.heights = heights
    this.runways = new Runways(heights, tiles, RUNWAY_TUNING.global)
    this.plugin = plugin as PluginLike
    const cache = this.plugin._gridCache
    if (!cache || typeof cache.fetchItem !== 'function' || typeof cache.get !== 'function' || typeof cache.forEachItem !== 'function') {
      console.warn('gridRunways: la librería de teselas ha cambiado; las pistas no se alisan')
      this.cache = null
      return
    }
    this.cache = cache
    const fetchItem = cache.fetchItem.bind(cache)
    cache.fetchItem = async (key, signal) => {
      const grid = await fetchItem(key, signal)
      try {
        if (isGrid(grid) && key[2] >= MIN_LEVEL) {
          this.raw.set(grid, grid.image.data.slice())
          if (this.applied.length && this.apply(grid, key, this.applied, this.applied)) this.stitch(grid, key)
        }
      } catch (e) {
        console.warn('gridRunways: no se pudo alisar una rejilla', e)
      }
      return grid
    }
  }

  update(lat: number, lon: number): void {
    this.runways.update(lat, lon)
  }

  get pending(): boolean {
    return this.runways.pending
  }

  /**
   * Cada fotograma: si han cambiado las pistas, corrige las rejillas cargadas, y marca para
   * volver a subir las texturas de alturas que han cambiado.
   */
  sync(meshes: Iterable<Mesh>): void {
    if (this.runways.consumeChanged() && this.cache) {
      const next = this.runways.patches
      const changed = [...next.filter((r) => !this.applied.includes(r)), ...this.applied.filter((r) => !next.includes(r))]
      this.applied = next
      if (changed.length) {
        const touched: Array<[Grid, Key]> = []
        this.cache.forEachItem((grid, key) => {
          if (isGrid(grid) && key[2] >= MIN_LEVEL && this.apply(grid, key, next, changed)) touched.push([grid, key])
        })
        for (const [grid, key] of touched) this.stitch(grid, key)
      }
    }
    if (!this.dirty.size) return
    // las mallas dibujan copias de la rejilla (comparten la imagen): cada una tiene que enterarse
    for (const m of meshes) {
      const tex = (m.material as { displacementMap?: { source: object; needsUpdate: boolean } | null }).displacementMap
      if (tex && this.dirty.has(tex.source)) tex.needsUpdate = true
    }
    this.dirty.clear()
  }

  /**
   * Recalcula, con todas las correcciones de `list`, los texeles de la rejilla que caen en
   * alguna de las de `changed`. Devuelve si ha tocado alguno.
   */
  private apply(grid: Grid, key: Key, list: readonly Patch[], changed: readonly Patch[]): boolean {
    const raw = this.raw.get(grid)
    const tiling = this.plugin._tiling
    if (!raw || !tiling) return false
    const [x, y, level] = key
    // límites de la tesela: oeste, sur, este, norte (radianes → grados)
    const [west, south, east, north] = tiling.getTileBounds(x, y, level).map((v) => v / DEG)
    const { data, width, height } = grid.image
    const w = width - 2
    const h = height - 2
    const mS = mercY(south)
    const mN = mercY(north)
    let any = false
    for (const r of changed) {
      if (r.north < south || r.south > north || r.east < west || r.west > east) continue
      // texeles interiores (1..w, 1..h; centro del i-ésimo en (i − 0,5)/w) dentro del rectángulo
      const i0 = Math.max(1, Math.floor(((r.west - west) / (east - west)) * w + 0.5))
      const i1 = Math.min(w, Math.ceil(((r.east - west) / (east - west)) * w + 0.5))
      const j0 = Math.max(1, Math.floor(((mercY(r.south) - mS) / (mN - mS)) * h + 0.5))
      const j1 = Math.min(h, Math.ceil(((mercY(r.north) - mS) / (mN - mS)) * h + 0.5))
      for (let j = j0; j <= j1; j++) {
        const lat = mercLat(mS + ((j - 0.5) / h) * (mN - mS))
        for (let i = i0; i <= i1; i++) {
          const lon = west + ((i - 0.5) / w) * (east - west)
          const k = j * width + i
          data[k] = adjustWith(list as Patch[], lat, lon, raw[k])
        }
      }
      any = true
    }
    if (any) {
      grid.needsUpdate = true
      this.dirty.add(grid.source)
    }
    return any
  }

  /** Vuelve a casar el marco de la rejilla con sus vecinas (en los dos sentidos). */
  private stitch(grid: Grid, key: Key): void {
    const tiling = this.plugin._tiling
    if (!tiling || !this.cache) return
    const [x, y, level] = key
    const count = tiling.getLevel(level).tileCountX
    const yDir = tiling.flipY ? -1 : 1
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue
        const nb = this.cache.get((x + dx + count) % count, y + dy * yDir, level)
        if (isGrid(nb) && nb.image.width === grid.image.width && nb.image.height === grid.image.height) {
          fillBorder(grid, nb, dx, dy)
          fillBorder(nb, grid, -dx, -dy)
          nb.needsUpdate = true
          this.dirty.add(nb.source)
        } else repeatEdge(grid, dx, dy)
      }
    }
    grid.needsUpdate = true
    this.dirty.add(grid.source)
  }

  dispose(): void {
    this.runways.dispose()
    this.heights.dispose()
  }
}
