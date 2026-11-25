// Máscara mundial de agua para el sombreado del agua (render/Water.ts).
//
// La capa `water` de las teselas vectoriales de OpenFreeMap (OpenStreetMap: océano, lagos,
// embalses, ríos, estanques, dársenas, piscinas) se dibuja en una textura por niveles
// alrededor de la cámara: z14 (≈ 4 m por texel) hasta kilómetro y medio, y z12, z10, z8 y
// z6 cada vez más lejos, hasta unos 300 km. De cada nivel hay 3×3 teselas, una por capa de
// la textura, colocadas por su índice módulo 3: al avanzar, la fila que entra ocupa las
// capas de la que sale y no hay que mover nada.
//
// Cada tesela guarda R = cuánta agua (suavizada: el 0,5 es la orilla y al ampliarla el
// borde sale limpio) y G = cuánto oleaje admite esa agua (mar 1, lago, río, piscina).
// Los puentes y pantalanes del mapa se recortan: van por encima del agua.

import type { VectorTile, VectorTileFeature } from '@mapbox/vector-tile'
import type { Vector2, Vector3, Vector4 } from 'three'
import type { GeoFrame } from './GeoFrame.ts'
import { fetchVectorTile, latToY, lonToX, yToLat } from './mapTiles.ts'
import { WATER_LEVELS, WATER_SLOTS, WATER_TILE, WATER_ZOOMS, waterMaskTexture, waterMaskUniforms } from '../render/Water.ts'

const DEG = Math.PI / 180
const SIZE = WATER_TILE
/** margen del lienzo (px) para que el suavizado no note el borde de la tesela */
const PAD = 6
const LAYER_BYTES = SIZE * SIZE * 2
/** elipsoide WGS84 */
const WGS_A = 6378137
const WGS_E2 = 0.00669437999014

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

interface Raster {
  /** R y G intercalados (SIZE²·2), o null si toda la tesela vale `fill` */
  data: Uint8Array | null
  fill: [number, number]
}

interface Entry {
  state: 'loading' | 'ready' | 'failed'
  raster: Raster | null
  abort: AbortController
  /** último uso (para vaciar la caché) o momento del fallo */
  stamp: number
  fails: number
}

interface Level {
  z: number
  /** tesela central de la ventana (sin envolver en el antimeridiano); NaN = aún sin colocar */
  cx: number
  cy: number
  /** clave de la tesela subida a cada capa */
  slots: Array<string | null>
}

const mod3 = (v: number): number => ((v % 3) + 3) % 3

/** Agua en un punto, para la física (ver `WaterMask.sample`). */
export interface WaterSample {
  /** 0..1 (0,5 = la orilla) */
  water: number
  /** clase del agua: mar 1, lago 0,55, río y dársena 0,3, estanque 0,2, piscina 0,1 */
  energy: number
  /** profundidad estimada (m); 0 en tierra (o sin calcular: `shore` < 0) */
  depth: number
  /** distancia a la orilla (m) con que se ha estimado; −1 si no se ha buscado */
  shore: number
}

/** nivel de la máscara que usa la física */
const FINE_Z = WATER_ZOOMS[0]
/** radios (texeles, ≈ 4 m) a los que se busca la orilla: hasta ~1,5 km */
const SHORE_RINGS = [1, 2, 3, 4, 6, 8, 11, 16, 22, 32, 45, 64, 90, 128, 180, 256, 360]

/**
 * Profundidad (m) a `shore` metros de la orilla: la pendiente típica del fondo de cada clase de agua
 * y un tope. Mar: playa de ~1:25 (a 100 m, 4 m de agua); lago y embalse: laderas de ~1:7 hasta 40 m;
 * río y dársena: hasta 8 m; estanque, 3 m; piscina, 1,8 m.
 */
export function depthFor(energy: number, shore: number): number {
  const [slope, max] = bottomOf(energy)
  return Math.min(max, 0.3 + shore * slope)
}
/** pendiente del fondo y profundidad máxima de cada clase de agua */
function bottomOf(energy: number): [number, number] {
  return energy > 0.8 ? [0.04, 80] : energy > 0.45 ? [0.15, 40] : energy > 0.25 ? [0.1, 8] : energy > 0.15 ? [0.1, 3] : [0.2, 1.8]
}
const DIRS = Array.from({ length: 16 }, (_, k) => [Math.cos((k / 16) * Math.PI * 2), Math.sin((k / 16) * Math.PI * 2)])

export class WaterMask {
  private readonly frame: GeoFrame
  private readonly levels: Level[] = WATER_ZOOMS.map((z) => ({ z, cx: NaN, cy: NaN, slots: new Array<string | null>(WATER_SLOTS).fill(null) }))
  private readonly cache = new Map<string, Entry>()
  private loading = 0
  private disposed = false
  private clock = 0

  constructor(frame: GeoFrame) {
    this.frame = frame
    waterMaskTexture()
    waterMaskUniforms.wtOn.value = 1
    for (const c of waterMaskUniforms.wtC.value) c.x = 0
  }

  /** Coloca las ventanas alrededor de la cámara y pone al día los uniformes (cada fotograma). */
  update(dt: number, cameraWorld: Vector3): void {
    if (this.disposed) return
    this.clock += dt
    const f = this.frame
    const cam = f.worldToGeo(cameraWorld)
    const u = waterMaskUniforms
    const s0 = Math.sin(f.latDeg * DEG)
    const c0 = Math.cos(f.latDeg * DEG)
    const w = 1 - WGS_E2 * s0 * s0
    ;(u.wtGeo.value as Vector4).set(s0, c0, (WGS_A * (1 - WGS_E2)) / (w * Math.sqrt(w)), WGS_A / Math.sqrt(w))
    let uploads = 3
    for (let i = 0; i < WATER_LEVELS; i++) {
      const lv = this.levels[i]
      const n = 2 ** lv.z
      const ox = lonToX(f.lonDeg, n)
      const oy = latToY(f.latDeg, n)
      // cámara cerca del origen aunque el antimeridiano quede en medio
      let px = lonToX(cam.lon, n)
      if (px - ox > n / 2) px -= n
      else if (ox - px > n / 2) px += n
      const py = latToY(Math.max(-85, Math.min(85, cam.lat)), n)
      // la ventana se mueve cuando la cámara se mete 0,15 teselas en la vecina (sin vaivén en el borde)
      if (!(px >= lv.cx - 0.15 && px <= lv.cx + 1.15)) lv.cx = Math.floor(px)
      if (!(py >= lv.cy - 0.15 && py <= lv.cy + 1.15)) lv.cy = Math.floor(py)
      const tx = Math.floor(ox)
      const ty = Math.floor(oy)
      ;(u.wtA.value[i] as Vector4).set(ox - tx, oy - ty, px - tx, py - ty)
      ;(u.wtB.value[i] as Vector4).set(lv.cx - tx, lv.cy - ty, mod3(tx), mod3(ty))
      let bits = 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = lv.cx + dx
          const y = lv.cy + dy
          const slot = mod3(x) + 3 * mod3(y)
          const key = `${lv.z}/${x}/${y}`
          if (lv.slots[slot] === key) {
            bits |= 1 << slot
            this.touch(key)
            continue
          }
          const e = this.request(lv.z, x, y, key)
          if (e.state === 'ready' && uploads > 0) {
            uploads--
            this.upload(i * WATER_SLOTS + slot, e.raster!)
            lv.slots[slot] = key
            bits |= 1 << slot
            // las de los niveles bastos ya están en la textura y tardan en volver a hacer falta
            if (i > 0) this.cache.delete(key)
          }
        }
      }
      const tileM = (2 * Math.PI * WGS_A * c0) / n
      ;(u.wtC.value[i] as Vector2).set(bits, tileM / (SIZE - 1))
    }
    // del nivel fino, también el anillo de alrededor: al cruzar a otra tesela ya está dibujada
    const fine = this.levels[0]
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) === 2) this.request(fine.z, fine.cx + dx, fine.cy + dy, `${fine.z}/${fine.cx + dx}/${fine.cy + dy}`)
      }
    }
    if (this.cache.size > 56) this.prune()
  }

  /**
   * Lo que hay en un punto según el nivel fino (z14, ≈ 4 m por texel), para la física: cuánta agua
   * (0..1, la orilla en 0,5), qué clase de agua (`energy`, la del oleaje: mar 1, lago 0,55, río 0,3,
   * estanque 0,2, piscina 0,1) y una profundidad estimada. null si esa tesela aún no ha llegado.
   *
   * No hay batimetría (el relieve del mar se aplana a 0 en seaLevel.ts y el de los embalses es su
   * lámina de agua), así que la profundidad sale de la distancia a la orilla con la pendiente típica
   * del fondo de cada clase: una playa baja despacio, un embalse cae enseguida.
   */
  sample(lat: number, lon: number, withDepth = true): WaterSample | null {
    const n = 2 ** FINE_Z
    const fx = lonToX(lon, n)
    const fy = latToY(Math.max(-85, Math.min(85, lat)), n)
    const tx = Math.floor(fx)
    const ty = Math.floor(fy)
    const r = this.fineRaster(tx, ty)
    if (!r) return null
    // texel 0 sobre el borde de la tesela y SIZE−1 sobre el opuesto
    const u = (fx - tx) * (SIZE - 1)
    const v = (fy - ty) * (SIZE - 1)
    let water: number
    let energy: number
    if (!r.data) {
      water = r.fill[0] / 255
      energy = r.fill[0] > 0 ? r.fill[1] / r.fill[0] : 0
    } else {
      const i0 = Math.min(SIZE - 2, Math.floor(u))
      const j0 = Math.min(SIZE - 2, Math.floor(v))
      const a = u - i0
      const b = v - j0
      const d = r.data
      const k00 = (j0 * SIZE + i0) * 2
      const k10 = k00 + 2
      const k01 = k00 + SIZE * 2
      const k11 = k01 + 2
      const R = (d[k00] * (1 - a) + d[k10] * a) * (1 - b) + (d[k01] * (1 - a) + d[k11] * a) * b
      const G = (d[k00 + 1] * (1 - a) + d[k10 + 1] * a) * (1 - b) + (d[k01 + 1] * (1 - a) + d[k11 + 1] * a) * b
      water = R / 255
      // (el canal G va multiplicado por el agua: el suavizado mezcla los dos igual)
      energy = R > 2 ? Math.min(1, G / R) : 0
    }
    if (water < 0.5) return { water, energy, depth: 0, shore: 0 }
    if (!withDepth) return { water, energy, depth: 0, shore: -1 }
    const lat0 = yToLat(ty + 0.5, n)
    const mpp = (2 * Math.PI * WGS_A * Math.cos(lat0 * DEG)) / n / (SIZE - 1)
    // (más allá de donde el fondo ya llega a su tope, no hace falta buscar la orilla)
    const [slope, max] = bottomOf(energy)
    const shore = this.shoreTexels(tx * (SIZE - 1) + u, ty * (SIZE - 1) + v, (max - 0.3) / slope / mpp) * mpp
    return { water, energy, depth: depthFor(energy, shore), shore }
  }

  /** Raster del nivel fino de la tesela (x, y) si ya está en la caché. */
  private fineRaster(x: number, y: number): Raster | null {
    const n = 2 ** FINE_Z
    // (las claves de la ventana pueden ir sin envolver junto al antimeridiano)
    for (const xx of [x, x - n, x + n]) {
      const e = this.cache.get(`${FINE_Z}/${xx}/${y}`)
      if (e && e.state === 'ready' && e.raster) return e.raster
    }
    return null
  }

  /** Agua (0–255) del texel global (gx, gy) del nivel fino; −1 si su tesela no está. */
  private texel(gx: number, gy: number): number {
    const tx = Math.floor(gx / (SIZE - 1))
    const ty = Math.floor(gy / (SIZE - 1))
    // (casi todas las lecturas seguidas caen en la misma tesela)
    if (tx !== this.lastTx || ty !== this.lastTy || this.clock !== this.lastClock) {
      this.lastTx = tx
      this.lastTy = ty
      this.lastClock = this.clock
      this.lastRaster = this.fineRaster(tx, ty)
    }
    const r = this.lastRaster
    if (!r) return -1
    if (!r.data) return r.fill[0]
    const i = Math.round(gx - tx * (SIZE - 1))
    const j = Math.round(gy - ty * (SIZE - 1))
    return r.data[(Math.min(SIZE - 1, j) * SIZE + Math.min(SIZE - 1, i)) * 2]
  }

  /**
   * Distancia (texeles) a la tierra más cercana desde (gu, gv): anillos crecientes en 16 direcciones
   * (basta para la profundidad; un espigón fino puede escaparse). Donde se acaba lo cargado, se para.
   */
  private shoreTexels(gu: number, gv: number, limit: number): number {
    for (const rad of SHORE_RINGS) {
      if (rad > limit) return limit
      for (const [c, s] of DIRS) {
        const t = this.texel(gu + c * rad, gv + s * rad)
        if (t < 128) return rad
      }
    }
    return SHORE_RINGS[SHORE_RINGS.length - 1]
  }
  private lastTx = NaN
  private lastTy = NaN
  private lastClock = -1
  private lastRaster: Raster | null = null

  dispose(): void {
    this.disposed = true
    for (const e of this.cache.values()) e.abort.abort()
    this.cache.clear()
    waterMaskUniforms.wtOn.value = 0
    for (const c of waterMaskUniforms.wtC.value) c.x = 0
  }

  private touch(key: string): void {
    const e = this.cache.get(key)
    if (e) e.stamp = this.clock
  }

  /** Tesela de la caché; si no está (o falló hace rato), la pide. */
  private request(z: number, x: number, y: number, key: string): Entry {
    const old = this.cache.get(key)
    if (old) {
      if (old.state !== 'failed') {
        old.stamp = this.clock
        return old
      }
      // un corte de red: se reintenta a los 15 s, tres veces
      if (old.fails > 3 || this.clock - old.stamp < 15) return old
    }
    const fails = old?.fails ?? 0
    const entry: Entry = { state: 'loading', raster: null, abort: new AbortController(), stamp: this.clock, fails }
    const n = 2 ** z
    if (y < 0 || y >= n) {
      // más allá del borde de Mercator (los polos)
      entry.state = 'ready'
      entry.raster = { data: null, fill: [0, 0] }
      this.cache.set(key, entry)
      return entry
    }
    // cola llena: no se apunta, y se vuelve a pedir en otro fotograma
    if (this.loading >= 6) return old ?? entry
    this.cache.set(key, entry)
    this.loading++
    const lat = yToLat(y + 0.5, n)
    fetchVectorTile(((x % n) + n) % n, y, entry.abort.signal, z)
      .then((vt) => {
        if (entry.abort.signal.aborted) return
        entry.raster = rasterize(vt, z, (2 * Math.PI * WGS_A * Math.cos(lat * DEG)) / n / (SIZE - 1))
        entry.state = 'ready'
      })
      .catch((err) => {
        if (entry.abort.signal.aborted) return
        entry.state = 'failed'
        entry.stamp = this.clock
        entry.fails = fails + 1
        if (entry.fails === 1) console.warn('Agua: no se pudo cargar la tesela', key, err)
      })
      .finally(() => this.loading--)
    return entry
  }

  private upload(layer: number, r: Raster): void {
    const tex = waterMaskTexture()
    const all = tex.image.data as Uint8Array
    const at = layer * LAYER_BYTES
    if (r.data) all.set(r.data, at)
    else if (r.fill[0] === r.fill[1]) all.fill(r.fill[0], at, at + LAYER_BYTES)
    else {
      for (let i = at; i < at + LAYER_BYTES; i += 2) {
        all[i] = r.fill[0]
        all[i + 1] = r.fill[1]
      }
    }
    tex.addLayerUpdate(layer)
    tex.needsUpdate = true
  }

  /** Vacía de la caché lo que lleva más tiempo sin usarse (lo subido a la textura sigue en ella). */
  private prune(): void {
    const old = [...this.cache.entries()].filter(([, e]) => e.state !== 'loading').sort((a, b) => a[1].stamp - b[1].stamp)
    for (let i = 0; i < old.length - 40; i++) this.cache.delete(old[i][0])
  }
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

/** mpp: metros por texel de esta tesela. */
function rasterize(vt: VectorTile, z: number, mpp: number): Raster {
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
