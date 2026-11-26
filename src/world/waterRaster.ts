// Dibujo de una tesela de la máscara de agua (ver WaterMask.ts): la capa `water` de la tesela
// vectorial, con los puentes y pantalanes recortados, a R = cuánta agua y G = cuánto oleaje.
//
// Va aparte, sin nada de three.js, porque se ejecuta en un worker (water.worker.ts). El lienzo
// en que se dibuja está acelerado por la GPU, y leer sus píxeles espera a que la tarjeta acabe
// lo que tenga en cola: en el hilo principal eran 30-40 ms de parón por tesela, en mitad del
// vuelo (`getImageData` en el perfil de CPU). En un worker el dibujo es el mismo, píxel a píxel
// (comprobado con teselas reales), y el que espera es él. Con el lienzo en CPU
// (`willReadFrequently`) no habría espera, pero el suavizado de los bordes sale distinto.

import type { VectorTile, VectorTileFeature } from '@mapbox/vector-tile'

export interface Raster {
  /** R y G intercalados (SIZE²·2), o null si toda la tesela vale `fill` */
  data: Uint8Array | null
  fill: [number, number]
}

/** margen del lienzo (px) para que el suavizado no note el borde de la tesela */
const PAD = 6

/** Oleaje que admite cada clase de agua (canal G): el mar abierto todo, una piscina casi nada. */
const ENERGY: Record<string, number> = { ocean: 1, lake: 0.55, river: 0.3, dock: 0.3, pond: 0.2, swimming_pool: 0.1 }

/** Ancho (m) con el que un puente tapa el agua, por clase de vía. */
const BRIDGE_WIDTH: Record<string, number> = {
  motorway: 15,
  trunk: 13,
  primary: 11,
  secondary: 9,
  tertiary: 8,
  minor: 6,
  service: 4.5,
  track: 3.5,
  path: 2.5,
  rail: 6,
  transit: 6,
  busway: 7,
  pier: 3.5,
}

// ---------------------------------------------------------------------------
// Dibujo de una tesela
// ---------------------------------------------------------------------------

let canvasA: OffscreenCanvas | null = null
let canvasB: OffscreenCanvas | null = null

function pathOf(f: VectorTileFeature): Path2D {
  const path = new Path2D()
  for (const ring of f.loadGeometry()) {
    for (let j = 0; j < ring.length; j++) {
      if (j === 0) path.moveTo(ring[j].x, ring[j].y)
      else path.lineTo(ring[j].x, ring[j].y)
    }
    if (f.type === 3) path.closePath()
  }
  return path
}

/** `mpp`: metros por texel de esta tesela; `SIZE`: lado de la tesela en texeles. */
export function rasterize(vt: VectorTile, z: number, mpp: number, SIZE: number): Raster {
  const LAYER_BYTES = SIZE * SIZE * 2
  const water = vt.layers.water
  if (!water || water.length === 0) return { data: null, fill: [0, 0] }
  const side = SIZE + 2 * PAD
  canvasA ??= new OffscreenCanvas(side, side)
  canvasB ??= new OffscreenCanvas(side, side)
  const ctx = canvasA.getContext('2d')!
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, side, side)
  // el texel 0 cae sobre el borde de la tesela y el último sobre el opuesto: dos teselas
  // vecinas comparten esos valores y no hay costura
  const k = (SIZE - 1) / water.extent
  ctx.setTransform(k, 0, 0, k, PAD + 0.5, PAD + 0.5)
  // lo más revuelto encima: un río que desemboca en un lago o en el mar toma su oleaje
  const feats: Array<{ f: VectorTileFeature; e: number }> = []
  for (let i = 0; i < water.length; i++) {
    const f = water.feature(i)
    if (f.type !== 3) continue
    const p = f.properties as Record<string, unknown>
    // cauces secos y lagunas de temporada (en la foto suelen ser tierra) y ríos soterrados
    if (p.intermittent === 1 || p.brunnel === 'tunnel') continue
    feats.push({ f, e: ENERGY[String(p.class)] ?? 0.3 })
  }
  if (feats.length === 0) return { data: null, fill: [0, 0] }
  feats.sort((a, b) => a.e - b.e)
  for (const { f, e } of feats) {
    ctx.fillStyle = `rgb(255,${Math.round(e * 255)},0)`
    ctx.fill(pathOf(f), 'nonzero')
  }
  // puentes y pantalanes: por encima del agua (a z10 o menos ya no abultan un texel)
  const roads = z >= 12 ? vt.layers.transportation : undefined
  if (roads) {
    const kr = (SIZE - 1) / roads.extent
    ctx.setTransform(kr, 0, 0, kr, PAD + 0.5, PAD + 0.5)
    ctx.fillStyle = '#000'
    ctx.strokeStyle = '#000'
    ctx.lineCap = 'butt'
    ctx.lineJoin = 'round'
    for (let i = 0; i < roads.length; i++) {
      const f = roads.feature(i)
      const p = f.properties as Record<string, unknown>
      const cls = String(p.class)
      if (p.brunnel !== 'bridge' && cls !== 'pier' && cls !== 'bridge') continue
      if (f.type === 3) ctx.fill(pathOf(f), 'nonzero')
      else if (f.type === 2) {
        // (ancho en unidades de la tesela: el lienzo ya está escalado)
        ctx.lineWidth = (BRIDGE_WIDTH[cls] ?? 5) / mpp / kr
        ctx.stroke(pathOf(f))
      }
    }
  }
  // suavizado de un texel: la orilla queda en el 0,5 y al ampliar sale un borde limpio
  const out = canvasB.getContext('2d', { willReadFrequently: true })!
  out.filter = 'none'
  out.fillStyle = '#000'
  out.fillRect(0, 0, side, side)
  out.filter = 'blur(1px)'
  out.drawImage(canvasA, 0, 0)
  const img = out.getImageData(PAD, PAD, SIZE, SIZE).data
  const data = new Uint8Array(LAYER_BYTES)
  let lo = 255
  let hi = 0
  for (let i = 0, j = 0; i < img.length; i += 4, j += 2) {
    const r = img[i]
    data[j] = r
    data[j + 1] = img[i + 1]
    if (r < lo) lo = r
    if (r > hi) hi = r
  }
  // toda de agua (mar abierto) o toda seca: no hace falta guardarla
  if (hi === 0) return { data: null, fill: [0, 0] }
  if (lo === 255) {
    const g = data[1]
    let same = true
    for (let j = 1; j < data.length; j += 2) {
      if (data[j] !== g) {
        same = false
        break
      }
    }
    if (same) return { data: null, fill: [255, g] }
  }
  return { data, fill: [0, 0] }
}
