// Muestras de color de la ortofoto en puntos sueltos (teselas z16 de 256 px, con una caché
// pequeña: casi siempre son las mismas que acaba de pedir el mosaico de la banda bajo los
// puentes, así que salen de la caché del navegador). Para dar a la calzada de los puentes el
// color del firme que se ve en la foto.

import { Color } from 'three'
import { drawTileCrop, isEsriImagery, loadEsriTile } from './esriImagery.ts'
import { latToY, lonToX } from './mapTiles.ts'

/** nivel de las teselas muestreadas (≈ 1,8 m/píxel en España, el del mosaico de las bandas) */
const ZOOM = 16
/** teselas guardadas (256 kB cada una) */
const CACHE = 48

export class OrthoSampler {
  private readonly url: string
  private readonly esri: boolean
  private readonly cache = new Map<string, Promise<ImageData | null>>()

  constructor(urlTemplate: string) {
    this.url = urlTemplate
    this.esri = isEsriImagery(urlTemplate)
  }

  /** Color (sRGB 0–255) de la foto en cada punto [lat, lon]; los que no se pudieron leer no salen. */
  async pixels(points: Array<[number, number]>, signal: AbortSignal): Promise<Array<[number, number, number]>> {
    const n = 2 ** ZOOM
    const byTile = new Map<string, Array<[number, number]>>()
    for (const [la, lo] of points) {
      const fx = lonToX(lo, n)
      const fy = latToY(la, n)
      const key = `${Math.floor(fx)}/${Math.floor(fy)}`
      const l = byTile.get(key)
      if (l) l.push([fx, fy])
      else byTile.set(key, [[fx, fy]])
    }
    const out: Array<[number, number, number]> = []
    await Promise.all(
      [...byTile].map(async ([key, list]) => {
        const [tx, ty] = key.split('/').map(Number)
        const img = await this.tile(tx, ty, signal)
        if (!img) return
        for (const [fx, fy] of list) {
          const px = Math.min(255, Math.max(0, Math.floor((fx - tx) * 256)))
          const py = Math.min(255, Math.max(0, Math.floor((fy - ty) * 256)))
          const o = (py * 256 + px) * 4
          out.push([img.data[o], img.data[o + 1], img.data[o + 2]])
        }
      }),
    )
    return out
  }

  private tile(x: number, y: number, signal: AbortSignal): Promise<ImageData | null> {
    const key = `${x}/${y}`
    let p = this.cache.get(key)
    if (p) {
      // (la más reciente al final)
      this.cache.delete(key)
      this.cache.set(key, p)
      return p
    }
    p = this.load(x, y, signal)
    this.cache.set(key, p)
    while (this.cache.size > CACHE) this.cache.delete(this.cache.keys().next().value!)
    return p
  }

  private async load(x: number, y: number, signal: AbortSignal): Promise<ImageData | null> {
    try {
      const cv = new OffscreenCanvas(256, 256)
      const ctx = cv.getContext('2d', { willReadFrequently: true })!
      if (this.esri) {
        // (Esri sin imagen a este nivel: el recorte del anterior, como el mosaico)
        const t = await loadEsriTile(this.url, x, y, ZOOM, signal)
        if (t instanceof ImageBitmap) {
          ctx.drawImage(t, 0, 0, 256, 256)
          t.close()
        } else drawTileCrop(ctx, t, 0, 0, 256)
      } else {
        const u = this.url.replace('{z}', String(ZOOM)).replace('{x}', String(x)).replace('{y}', String(y))
        const r = await fetch(u, { signal })
        if (!r.ok) return null
        const img = await createImageBitmap(await r.blob())
        ctx.drawImage(img, 0, 0, 256, 256)
        img.close()
      }
      return ctx.getImageData(0, 0, 256, 256)
    } catch {
      this.cache.delete(`${x}/${y}`) // otra vez será
      return null
    }
  }
}

const toLinear = (c: number) => {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

/**
 * Color del firme a partir de píxeles de la foto tomados sobre una calzada: se quedan los grises
 * (fuera la vegetación, la tierra y los coches de color) y, de ellos, la franja media de brillo
 * (fuera las marcas viales y los vehículos blancos por arriba, las sombras y los coches oscuros
 * por abajo). Media en lineal. false si no quedan bastantes para fiarse.
 */
export function asphaltColour(px: Array<[number, number, number]>, out: Color): boolean {
  const grey = px.filter(([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b) <= 30)
  if (grey.length < 16 || grey.length < 0.35 * px.length) return false
  const lum = ([r, g, b]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b
  grey.sort((a, b) => lum(a) - lum(b))
  const a = Math.floor(grey.length * 0.15)
  const b = Math.max(a + 1, Math.ceil(grey.length * 0.6))
  let r = 0
  let g = 0
  let bl = 0
  for (let i = a; i < b; i++) {
    r += toLinear(grey[i][0])
    g += toLinear(grey[i][1])
    bl += toLinear(grey[i][2])
  }
  const k = 1 / (b - a)
  out.setRGB(r * k, g * k, bl * k)
  return true
}
