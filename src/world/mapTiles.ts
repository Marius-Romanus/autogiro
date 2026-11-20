// Utilidades comunes de las capas por teselas Web Mercator z14 (edificios, árboles):
// conversión de coordenadas, teselas vectoriales de OpenFreeMap y mosaico de ortofoto.

import { VectorTile } from '@mapbox/vector-tile'
import { PbfReader } from 'pbf'

/** Nivel de las teselas de objetos: ~1,9 km de lado en España. */
export const Z = 14
const TILEJSON = 'https://tiles.openfreemap.org/planet'

export function lonToX(lon: number, n: number): number {
  return ((lon + 180) / 360) * n
}
export function latToY(lat: number, n: number): number {
  const r = (lat * Math.PI) / 180
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n
}
export function xToLon(x: number, n: number): number {
  return (x / n) * 360 - 180
}
export function yToLat(y: number, n: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI
}

// La URL de las teselas cambia con cada publicación semanal de OpenFreeMap: se lee una vez del TileJSON.
let tileTemplate: Promise<string | null> | null = null
function vectorTemplate(): Promise<string | null> {
  tileTemplate ??= fetch(TILEJSON)
    .then((r) => r.json())
    .then((j) => (j.tiles?.[0] as string) ?? null)
    .catch(() => {
      tileTemplate = null // reintentar la próxima vez
      return null
    })
  return tileTemplate
}

/** Tesela vectorial z14 de OpenFreeMap (esquema OpenMapTiles). */
export async function fetchVectorTile(x: number, y: number, signal: AbortSignal): Promise<VectorTile> {
  const tpl = await vectorTemplate()
  if (!tpl) throw new Error('sin TileJSON de OpenFreeMap')
  const url = tpl.replace('{z}', String(Z)).replace('{x}', String(x)).replace('{y}', String(y))
  const r = await fetch(url, { signal })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return new VectorTile(new PbfReader(new Uint8Array(await r.arrayBuffer())))
}

/**
 * Mosaico de la ortofoto a z16 (4×4 teselas, 1024 px, ≈ 1,8 m/píxel en España) que cubre
 * exactamente la tesela z14 (x, y). null si no se pudo cargar nada.
 */
export async function loadOrthoMosaic(urlTemplate: string, x: number, y: number, signal: AbortSignal): Promise<ImageData | null> {
  const k = 4
  const size = 256 * k
  try {
    const cv = new OffscreenCanvas(size, size)
    const ctx = cv.getContext('2d', { willReadFrequently: true })!
    let ok = 0
    const jobs: Promise<void>[] = []
    for (let j = 0; j < k; j++) {
      for (let i = 0; i < k; i++) {
        const u = urlTemplate
          .replace('{z}', String(Z + 2))
          .replace('{x}', String(x * k + i))
          .replace('{y}', String(y * k + j))
        jobs.push(
          fetch(u, { signal })
            .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))))
            .then((bl) => createImageBitmap(bl))
            .then((img) => {
              ctx.drawImage(img, i * 256, j * 256, 256, 256)
              img.close()
              ok++
            })
            .catch(() => undefined),
        )
      }
    }
    await Promise.all(jobs)
    if (signal.aborted || ok === 0) return null
    return ctx.getImageData(0, 0, size, size)
  } catch {
    return null
  }
}

export type Ring = Array<{ x: number; y: number }>

/** Agrupa anillos en polígonos (exterior + huecos), como vector-tile-js. */
export function classifyRings(rings: Ring[]): Ring[][] {
  const polys: Ring[][] = []
  let poly: Ring[] | null = null
  let ccw: boolean | undefined
  for (const ring of rings) {
    let area = 0
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) area += (ring[i].x - ring[j].x) * (ring[j].y + ring[i].y)
    if (area === 0) continue
    if (ccw === undefined) ccw = area < 0
    if (ccw === area < 0) {
      if (poly) polys.push(poly)
      poly = [ring]
    } else if (poly) poly.push(ring)
  }
  if (poly) polys.push(poly)
  return polys
}
