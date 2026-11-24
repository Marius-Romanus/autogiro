// Esri World Imagery sin el cartel «Map data not yet available».
//
// Donde Esri no tiene imagen a un nivel (el 18 en Bora Bora, el 14 en mar abierto) responde con
// HTTP 200 y una tesela gris con ese texto, siempre el mismo JPEG. Aquí se reconoce y se
// sustituye por el recorte ampliado del antepasado más profundo que sí tiene imagen, de modo
// que el terreno se ve más borroso pero nunca con carteles.

import { SRGBColorSpace, Texture } from 'three'

const TILE = 256
/** El cartel: 2521 bytes, idénticos en todo el mundo y a todos los niveles (FNV-1a de 32 bits) */
const PLACEHOLDER_BYTES = 2521
const PLACEHOLDER_HASH = 0x92d9118f
/** imágenes de antepasados que se guardan para recortar (256 KB cada una) */
const MAX_ANCESTORS = 48

export function isEsriImagery(urlTemplate: string): boolean {
  return /arcgisonline\.com\/.*World_Imagery/i.test(urlTemplate)
}

export function isEsriPlaceholder(buf: ArrayBuffer): boolean {
  if (buf.byteLength !== PLACEHOLDER_BYTES) return false
  let h = 0x811c9dc5
  for (const c of new Uint8Array(buf)) h = Math.imul(h ^ c, 0x01000193)
  return h >>> 0 === PLACEHOLDER_HASH
}

/** Recorte de una tesela con imagen: la subtesela (ox, oy) de las 2^d × 2^d en que se divide. */
export interface TileCrop {
  img: ImageBitmap
  ox: number
  oy: number
  d: number
}

function tileUrl(template: string, x: number, y: number, z: number): string {
  return template
    .replace(/{\s*z\s*}/gi, String(z))
    .replace(/{\s*x\s*}/gi, String(x))
    .replace(/{\s*y\s*}/gi, String(y))
}

// Estado común a todas las capas (terreno, mosaicos de tejados y árboles): la misma URL.
/** teselas "z/x/y" que se sabe que son el cartel */
const missing = new Set<string>()
/** imágenes de antepasados, por "z/x/y" (null: es el cartel); las más recientes al final */
const ancestors = new Map<string, Promise<ImageBitmap | null>>()

/**
 * Nivel del antepasado más alto de (x, y, z) —o ella misma— que se sabe que es el cartel;
 * −1 si no se sabe de ninguno. Donde falta un nivel faltan también los siguientes.
 */
function missingFrom(x: number, y: number, z: number): number {
  let top = -1
  for (let k = z; k >= 0; k--) if (missing.has(`${k}/${x >> (z - k)}/${y >> (z - k)}`)) top = k
  return top
}

function ancestorImage(template: string, x: number, y: number, z: number): Promise<ImageBitmap | null> {
  const key = `${z}/${x}/${y}`
  let p = ancestors.get(key)
  if (p) {
    ancestors.delete(key)
    ancestors.set(key, p)
    return p
  }
  // (sin señal de aborto: la comparten todas las subteselas; suele salir de la caché del navegador)
  p = fetch(tileUrl(template, x, y, z))
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((buf) => {
      if (z > 0 && isEsriPlaceholder(buf)) {
        missing.add(key)
        return null
      }
      return createImageBitmap(new Blob([buf]), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
    })
  p.catch(() => ancestors.delete(key)) // un fallo de red no se guarda
  ancestors.set(key, p)
  // (las que salen no se cierran: puede estar esperándolas un recorte)
  if (ancestors.size > MAX_ANCESTORS) ancestors.delete(ancestors.keys().next().value!)
  return p
}

/**
 * Recorte que sustituye a la tesela (x, y, z), que es el cartel o desciende de uno:
 * el del antepasado más profundo con imagen, empezando por encima del nivel `top`.
 */
async function fallbackCrop(template: string, x: number, y: number, z: number, top: number, signal?: AbortSignal): Promise<TileCrop> {
  for (let az = Math.min(top, z) - 1; az >= 0; az--) {
    const d = z - az
    const img = await ancestorImage(template, x >> d, y >> d, az)
    signal?.throwIfAborted()
    if (img) return { img, ox: x - ((x >> d) << d), oy: y - ((y >> d) << d), d }
  }
  throw new Error('Esri: sin imagen a ningún nivel')
}

/**
 * Dibuja el recorte ampliado en el cuadrado (dx, dy, size) del lienzo. Se dibuja con dos píxeles
 * de margen de la imagen de origen (recortados por el `clip`), para que el suavizado del borde
 * use los píxeles vecinos y dos subteselas contiguas casen sin costura.
 */
export function drawTileCrop(ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, c: TileCrop, dx: number, dy: number, size: number): void {
  const sw = c.img.width / 2 ** c.d
  const sh = c.img.height / 2 ** c.d
  const sx = c.ox * sw
  const sy = c.oy * sh
  const x0 = Math.max(0, Math.floor(sx) - 2)
  const y0 = Math.max(0, Math.floor(sy) - 2)
  const x1 = Math.min(c.img.width, Math.ceil(sx + sw) + 2)
  const y1 = Math.min(c.img.height, Math.ceil(sy + sh) + 2)
  const kx = size / sw
  const ky = size / sh
  ctx.save()
  ctx.beginPath()
  ctx.rect(dx, dy, size, size)
  ctx.clip()
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(c.img, x0, y0, x1 - x0, y1 - y0, dx + (x0 - sx) * kx, dy + (y0 - sy) * ky, (x1 - x0) * kx, (y1 - y0) * ky)
  ctx.restore()
}

/**
 * Para mosaicos: la tesela (x, y, z) como imagen propia (quien la pide la cierra) o, si Esri no
 * la tiene, el recorte del antepasado (para `drawTileCrop`; su imagen es compartida, no se cierra).
 */
export async function loadEsriTile(template: string, x: number, y: number, z: number, signal?: AbortSignal): Promise<ImageBitmap | TileCrop> {
  let top = missingFrom(x, y, z)
  if (top < 0) {
    const r = await fetch(tileUrl(template, x, y, z), { signal })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const buf = await r.arrayBuffer()
    if (z === 0 || !isEsriPlaceholder(buf)) return createImageBitmap(new Blob([buf]))
    missing.add(`${z}/${x}/${y}`)
    top = z
  }
  return fallbackCrop(template, x, y, z, top, signal)
}

/** Textura del recorte, volteada en vertical como las que crea TiledImageSource.processBufferToTexture. */
function cropTexture(c: TileCrop): Texture {
  const cv = new OffscreenCanvas(TILE, TILE)
  const ctx = cv.getContext('2d')!
  ctx.setTransform(1, 0, 0, -1, 0, TILE)
  drawTileCrop(ctx, c, 0, 0, TILE)
  const tex = new Texture(cv.transferToImageBitmap())
  tex.generateMipmaps = false
  tex.colorSpace = SRGBColorSpace
  tex.needsUpdate = true
  return tex
}

/**
 * Hace que la capa (un XYZTilesOverlay de 3d-tiles-renderer con las imágenes de Esri) no entregue
 * nunca el cartel. No hace nada con otras fuentes (PNOA).
 *
 * Sustituye `fetchItem` de su TiledImageSource: misma descarga y misma textura que el original
 * cuando la tesela tiene imagen; si es el cartel, la textura es el recorte del antepasado. Bajo un
 * cartel ya visto no se pide nada más al servidor (en mar abierto faltan los niveles 14 a 18).
 */
export function skipEsriPlaceholders<T extends { imageSource: any }>(overlay: T): T {
  const src = overlay.imageSource
  if (!isEsriImagery(String(src.url))) return overlay
  const template = String(src.url)
  src.fetchItem = async ([x, y, z]: number[], signal: AbortSignal): Promise<Texture> => {
    let top = missingFrom(x, y, z)
    if (top < 0) {
      const res: Response = await src.fetchData(src.getUrl(x, y, z), { ...src.fetchOptions, signal })
      const buf = await res.arrayBuffer()
      if (z === 0 || !isEsriPlaceholder(buf)) return src.processBufferToTexture(buf)
      missing.add(`${z}/${x}/${y}`)
      top = z
    }
    return cropTexture(await fallbackCrop(template, x, y, z, top, signal))
  }
  return overlay
}
