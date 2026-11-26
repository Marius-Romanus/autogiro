// Utilidades comunes de las capas por teselas Web Mercator z14 (edificios, árboles):
// conversión de coordenadas, teselas vectoriales de OpenFreeMap y mosaico de ortofoto.

import { VectorTile } from '@mapbox/vector-tile'
import { PbfReader } from 'pbf'
import { drawTileCrop, isEsriImagery, loadEsriTile } from './esriImagery.ts'

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
// (Si un bloqueador de anuncios la corta, avisa src/net/netWatch.ts: la lista EasyPrivacy bloqueó
// `||tiles.openfreemap.org/planet` el 2026-11-24.)
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

/** Un fallo de red o del servidor que puede pasar solo (vale la pena reintentar). */
class TransientError extends Error {}

/** Esperas (ms) entre intentos de una misma descarga: un corte breve no deja la tesela sin datos. */
const RETRY_MS = [1500, 4000]

/** Descargas en curso, compartidas: edificios, árboles, agua, puentes… piden la misma tesela a la vez. */
const inflight = new Map<string, { bytes: Promise<ArrayBuffer>; abort: AbortController; users: number }>()

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(done, ms)
    function done(): void {
      signal.removeEventListener('abort', stop)
      resolve()
    }
    function stop(): void {
      clearTimeout(t)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', stop, { once: true })
  })
}

async function downloadTile(z: number, x: number, y: number, signal: AbortSignal): Promise<ArrayBuffer> {
  for (let attempt = 0; ; attempt++) {
    try {
      const tpl = await vectorTemplate()
      if (!tpl) throw new TransientError('sin TileJSON de OpenFreeMap')
      const url = tpl.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))
      let r: Response
      try {
        r = await fetch(url, { signal })
      } catch (e) {
        // (fetch solo lanza por la red o por abortar)
        if (signal.aborted) throw e
        throw new TransientError(String(e))
      }
      if (!r.ok) {
        const msg = `HTTP ${r.status}`
        throw r.status === 429 || r.status >= 500 ? new TransientError(msg) : new Error(msg)
      }
      return await r.arrayBuffer()
    } catch (e) {
      if (signal.aborted || !(e instanceof TransientError) || attempt >= RETRY_MS.length) throw e
      await sleep(RETRY_MS[attempt], signal)
    }
  }
}

/**
 * Tesela vectorial (z14 si no se dice otro nivel) de OpenFreeMap (esquema OpenMapTiles).
 *
 * Si varias capas la piden a la vez se descarga una sola vez, y un fallo de red pasajero se
 * reintenta un par de veces antes de darlo por perdido. `signal` solo cancela a quien la pidió:
 * la descarga sigue mientras alguien más la espere.
 */
export async function fetchVectorTile(x: number, y: number, signal: AbortSignal, z = Z): Promise<VectorTile> {
  return new VectorTile(new PbfReader(new Uint8Array(await fetchVectorTileBytes(x, y, signal, z))))
}

/**
 * Los bytes de la tesela vectorial, sin leer (para quien la procesa en un worker). Comparte
 * descarga con `fetchVectorTile`; el búfer es de todos los que la piden: no se transfiere.
 */
export async function fetchVectorTileBytes(x: number, y: number, signal: AbortSignal, z = Z): Promise<ArrayBuffer> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  const key = `${z}/${x}/${y}`
  let job = inflight.get(key)
  if (!job) {
    const abort = new AbortController()
    const bytes = downloadTile(z, x, y, abort.signal)
    const created = { bytes, abort, users: 0 }
    job = created
    inflight.set(key, created)
    bytes.then(
      () => inflight.get(key) === created && inflight.delete(key),
      () => inflight.get(key) === created && inflight.delete(key),
    )
  }
  const shared = job
  shared.users++
  let onAbort: (() => void) | null = null
  try {
    const buf = await Promise.race([
      shared.bytes,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(new DOMException('Aborted', 'AbortError'))
        signal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
    return buf
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
    // el último que la esperaba se ha ido: se cancela (y la próxima petición empieza otra)
    if (--shared.users === 0 && signal.aborted && inflight.get(key) === shared) {
      inflight.delete(key)
      shared.abort.abort()
    }
  }
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
    // Esri: donde no tiene imagen a z16 da un cartel gris; en su lugar, el recorte del nivel anterior
    const esri = isEsriImagery(urlTemplate)
    for (let j = 0; j < k; j++) {
      for (let i = 0; i < k; i++) {
        if (esri) {
          jobs.push(
            loadEsriTile(urlTemplate, x * k + i, y * k + j, Z + 2, signal)
              .then((t) => {
                if (t instanceof ImageBitmap) {
                  ctx.drawImage(t, i * 256, j * 256, 256, 256)
                  t.close()
                } else drawTileCrop(ctx, t, i * 256, j * 256, 256)
                ok++
              })
              .catch(() => undefined),
          )
          continue
        }
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
