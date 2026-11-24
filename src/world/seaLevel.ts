// Mar plano en el relieve mundial (Terrarium).
//
// Las teselas de Terrarium llevan el fondo marino (batimetría de GEBCO) con cotas
// negativas: una laguna de coral salía como un hoyo con paredes de foto estirada, y el
// mar abierto a 3000 m "bajo el nivel del mar". Aquí las cotas negativas se llevan a 0,
// que es donde está la superficie del agua, salvo en las pocas depresiones del mundo con
// tierra firme por debajo del nivel del mar (mar Muerto, Caspio, valle de la Muerte…).
// El MDT del IGN ya trae el mar a cota 0.

import { fetchVectorTile, latToY, lonToX } from './mapTiles.ts'

const DEG = Math.PI / 180

/** Depresiones con tierra bajo el nivel del mar: [lat sur, lat norte, lon oeste, lon este]. */
const BELOW_SEA: ReadonlyArray<readonly [number, number, number, number]> = [
  [30.0, 33.3, 35.0, 36.0], // mar Muerto, valle del Jordán y mar de Galilea
  [36.4, 47.5, 46.5, 54.5], // mar Caspio (su superficie está a −28 m) y su depresión
  [13.3, 14.7, 40.0, 40.7], // Danakil
  [11.5, 11.8, 42.3, 42.5], // lago Assal
  [28.6, 30.5, 26.0, 29.0], // depresión de Qattara
  [42.3, 43.2, 88.5, 90.5], // depresión de Turfán
  [35.6, 36.8, -117.3, -116.5], // valle de la Muerte
  [32.5, 33.8, -116.2, -115.2], // mar de Salton y valle Imperial
  [-29.6, -27.8, 136.6, 138.2], // lago Eyre
  [-49.7, -49.4, -68.6, -68.2], // laguna del Carbón
]

/** ¿Toca el rectángulo (grados) alguna depresión con tierra bajo el nivel del mar? */
export function hasLandBelowSea(latS: number, latN: number, lonW: number, lonE: number): boolean {
  for (const [s, n, w, e] of BELOW_SEA) {
    if (latN >= s && latS <= n && lonE >= w && lonW <= e) return true
  }
  return false
}

/** Lo mismo para una tesela Web Mercator (z, x, y). */
export function tileHasLandBelowSea(z: number, x: number, y: number): boolean {
  const n = 2 ** z
  const lat = (ty: number) => Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n))) / DEG
  return hasLandBelowSea(lat(y + 1), lat(y), (x / n) * 360 - 180, ((x + 1) / n) * 360 - 180)
}

interface Grid {
  image: { data: Float32Array; width: number; height: number }
  needsUpdate: boolean
}

/** Lleva a 0 las cotas negativas. Devuelve si la rejilla tiene mar y tierra (una costa). */
function clampAll(g: Grid): boolean {
  const d = g.image.data
  let sea = false
  let land = false
  for (let i = 0; i < d.length; i++) {
    if (d[i] <= 0) {
      d[i] = 0
      sea = true
    } else land = true
  }
  g.needsUpdate = true
  return sea && land
}

/**
 * Copia en el marco de `dst` que mira a la vecina (dx, dy) los texeles del borde de `src`
 * (lo mismo que hace la librería al cargar cada rejilla; las filas van de sur a norte).
 */
function fillBorder(dst: Grid, src: Grid, dx: number, dy: number): void {
  const { data, width, height } = dst.image
  const from = src.image.data
  const w = width - 2
  const h = height - 2
  const x0 = dx === -1 ? 0 : dx === 1 ? width - 1 : 1
  const x1 = dx === -1 ? 0 : dx === 1 ? width - 1 : width - 2
  const y0 = dy === -1 ? 0 : dy === 1 ? height - 1 : 1
  const y1 = dy === -1 ? 0 : dy === 1 ? height - 1 : height - 2
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) data[y * width + x] = from[(y - dy * h) * width + (x - dx * w)]
  }
  dst.needsUpdate = true
}

let maskCanvas: OffscreenCanvas | null = null

/**
 * Océano de OpenStreetMap en una tesela (la misma capa `water` del sombreado del agua),
 * dibujado a `size` píxeles: > 127 = mar. La fila 0 es el norte. null si no hay mar.
 */
async function oceanMask(z: number, x: number, y: number, size: number, signal: AbortSignal): Promise<Uint8ClampedArray | null> {
  const vt = await fetchVectorTile(x, y, signal, z)
  const water = vt.layers.water
  if (!water) return null
  maskCanvas ??= new OffscreenCanvas(size, size)
  if (maskCanvas.width !== size) {
    maskCanvas.width = size
    maskCanvas.height = size
  }
  const ctx = maskCanvas.getContext('2d', { willReadFrequently: true })!
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, size, size)
  ctx.fillStyle = '#fff'
  const k = size / water.extent
  ctx.setTransform(k, 0, 0, k, 0, 0)
  let any = false
  for (let i = 0; i < water.length; i++) {
    const f = water.feature(i)
    if (f.type !== 3 || (f.properties as Record<string, unknown>).class !== 'ocean') continue
    const path = new Path2D()
    for (const ring of f.loadGeometry()) {
      for (let j = 0; j < ring.length; j++) {
        if (j === 0) path.moveTo(ring[j].x, ring[j].y)
        else path.lineTo(ring[j].x, ring[j].y)
      }
      path.closePath()
    }
    ctx.fill(path, 'nonzero')
    any = true
  }
  return any ? ctx.getImageData(0, 0, size, size).data : null
}

/**
 * Aplana el mar en las rejillas de alturas de un TerrainRGBMeshPlugin de 3d-tiles-renderer
 * (las usa para desplazar la malla y para `sampleCartographicElevation`, o sea, dibujo y
 * física). Cada rejilla se corrige recién descargada:
 * - las cotas negativas (fondo marino) pasan a 0;
 * - en las teselas de costa, además, todo lo que OpenStreetMap da por océano: los datos de
 *   arrecifes y lagunas traen bultos de decenas de metros en medio del agua.
 * Al cargar, la librería intercambia los texeles del borde con las rejillas vecinas antes de
 * que se corrijan, así que al terminar se repite ese intercambio.
 */
export function flattenSea(plugin: unknown): void {
  const p = plugin as {
    _gridCache?: { fetchItem?: (key: [number, number, number], signal: AbortSignal) => Promise<Grid>; get?: (x: number, y: number, level: number) => unknown }
    _tiling?: { flipY: boolean; getTileBounds(x: number, y: number, level: number): number[]; getLevel(level: number): { tileCountX: number } } | null
  }
  const cache = p._gridCache
  if (!cache || typeof cache.fetchItem !== 'function' || typeof cache.get !== 'function') {
    console.warn('seaLevel: la librería de teselas ha cambiado; el mar conserva el relieve del fondo')
    return
  }
  const fetchItem = cache.fetchItem.bind(cache)
  const get = cache.get.bind(cache)
  let warned = false
  cache.fetchItem = async (key, signal) => {
    const grid = await fetchItem(key, signal)
    try {
      const [x, y, level] = key
      const tiling = p._tiling!
      // límites en radianes: oeste, sur, este, norte
      const b = tiling.getTileBounds(x, y, level).map((v) => v / DEG)
      if (grid?.image?.data instanceof Float32Array && !hasLandBelowSea(b[1], b[3], b[0], b[2])) {
        const coast = clampAll(grid)
        if (coast && level <= 14) {
          const n = 2 ** level
          const size = grid.image.width - 2
          const mask = await Promise.race([
            oceanMask(level, Math.floor(lonToX((b[0] + b[2]) / 2, n)), Math.floor(latToY((b[1] + b[3]) / 2, n)), size, signal).catch(() => null),
            new Promise<null>((r) => setTimeout(() => r(null), 6000)),
          ])
          if (mask && grid.image.height - 2 === size) {
            const { data, width } = grid.image
            for (let j = 0; j < size; j++) {
              // fila j de la rejilla (de sur a norte) = fila size−1−j de la máscara
              const row = (size - 1 - j) * size * 4
              for (let i = 0; i < size; i++) if (mask[row + i * 4] > 127) data[(j + 1) * width + i + 1] = 0
            }
            grid.needsUpdate = true
          }
        }
        // marcos: con las vecinas ya cargadas, en los dos sentidos
        const count = tiling.getLevel(level).tileCountX
        const yDir = tiling.flipY ? -1 : 1
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue
            const nb = get((x + dx + count) % count, y + dy * yDir, level) as Grid | Promise<unknown> | null | undefined
            if (!nb || nb instanceof Promise || !(nb.image?.data instanceof Float32Array) || nb.image.width !== grid.image.width) continue
            fillBorder(grid, nb, dx, dy)
            fillBorder(nb, grid, -dx, -dy)
          }
        }
      }
    } catch (e) {
      if (!warned) console.warn('seaLevel: no se pudo aplanar el mar', e)
      warned = true
    }
    return grid
  }
}
