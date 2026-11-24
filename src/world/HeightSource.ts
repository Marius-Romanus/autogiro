// Alturas del terreno leídas directamente de los datos de origen (no de lo que
// esté pintado en pantalla): sirven para la física del suelo y para asentar los
// edificios, y no cambian con el nivel de detalle con el que se dibuja el terreno.
//
// - QMHeightSource: MDT del IGN (paso de malla 5 m) en formato quantized-mesh
//   (mallas TIN, esquema geográfico TMS de Cesium). Es la misma malla que dibuja
//   el renderizador, así que la altura coincide con lo que se ve.
// - TerrariumHeightSource: teselas PNG Terrarium (Mapzen/AWS, ~30 m) fuera de España.
//
// Las alturas son ortométricas (sobre el nivel del mar), igual que las usa el
// renderizador (las coloca tal cual sobre el elipsoide).

import { tileHasLandBelowSea } from './seaLevel.ts'

export interface HeightSource {
  /** Altura (m) en (lat°, lon°) o null si aún no hay datos (y los pide). */
  sample(latDeg: number, lonDeg: number): number | null
  /** Carga los datos que cubren el rectángulo indicado. */
  ensure(south: number, west: number, north: number, east: number): Promise<void>
  dispose(): void
}

// ---------------------------------------------------------------------------
// Cola de descargas sencilla (limita peticiones simultáneas por fuente)
// ---------------------------------------------------------------------------
class FetchQueue {
  private active = 0
  private waiting: Array<() => void> = []
  private readonly max: number
  constructor(max: number) {
    this.max = max
  }
  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiting.push(r))
    this.active++
    try {
      return await job()
    } finally {
      this.active--
      this.waiting.shift()?.()
    }
  }
}

// ---------------------------------------------------------------------------
// Quantized-mesh
// ---------------------------------------------------------------------------

interface QMTile {
  minH: number
  maxH: number
  u: Uint16Array
  v: Uint16Array
  h: Uint16Array
  idx: Uint16Array | Uint32Array
  /** rejilla de aceleración: celdas G×G con la lista de triángulos que las tocan */
  g: number
  cellStart: Uint32Array
  cellTris: Uint32Array
}

const QMAX = 32767

function zigzag(x: number): number {
  return (x >> 1) ^ -(x & 1)
}

/** Decodifica la parte geométrica de una tesela quantized-mesh 1.0 (sin extensiones). */
export function decodeQuantizedMesh(buf: ArrayBuffer): QMTile {
  const dv = new DataView(buf)
  const minH = dv.getFloat32(24, true)
  const maxH = dv.getFloat32(28, true)
  const n = dv.getUint32(88, true)
  let o = 92
  const u = new Uint16Array(n)
  const v = new Uint16Array(n)
  const h = new Uint16Array(n)
  let a = 0
  let b = 0
  let c = 0
  for (let i = 0; i < n; i++) {
    a += zigzag(dv.getUint16(o + 2 * i, true))
    b += zigzag(dv.getUint16(o + 2 * n + 2 * i, true))
    c += zigzag(dv.getUint16(o + 4 * n + 2 * i, true))
    u[i] = a
    v[i] = b
    h[i] = c
  }
  o += 6 * n
  const big = n > 65536
  if (big) o += (4 - (o % 4)) % 4
  else o += o % 2
  const tc = dv.getUint32(o, true)
  o += 4
  const idx = big ? new Uint32Array(tc * 3) : new Uint16Array(tc * 3)
  let highest = 0
  for (let i = 0; i < tc * 3; i++) {
    const code = big ? dv.getUint32(o + 4 * i, true) : dv.getUint16(o + 2 * i, true)
    idx[i] = highest - code
    if (code === 0) highest++
  }

  // rejilla de aceleración para encontrar el triángulo de un punto
  const g = Math.max(1, Math.min(32, Math.ceil(Math.sqrt(tc / 2))))
  const counts = new Uint32Array(g * g + 1)
  const cellOf = (q: number) => Math.min(g - 1, Math.floor((q / (QMAX + 1)) * g))
  const forCells = (t: number, fn: (cell: number) => void) => {
    const i0 = idx[3 * t]
    const i1 = idx[3 * t + 1]
    const i2 = idx[3 * t + 2]
    const x0 = cellOf(Math.min(u[i0], u[i1], u[i2]))
    const x1 = cellOf(Math.max(u[i0], u[i1], u[i2]))
    const y0 = cellOf(Math.min(v[i0], v[i1], v[i2]))
    const y1 = cellOf(Math.max(v[i0], v[i1], v[i2]))
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) fn(y * g + x)
  }
  for (let t = 0; t < tc; t++) forCells(t, (cell) => counts[cell + 1]++)
  for (let i = 0; i < g * g; i++) counts[i + 1] += counts[i]
  const cellStart = counts.slice()
  const fill = counts.slice()
  const cellTris = new Uint32Array(cellStart[g * g])
  for (let t = 0; t < tc; t++) forCells(t, (cell) => (cellTris[fill[cell]++] = t))
  return { minH, maxH, u, v, h, idx, g, cellStart, cellTris }
}

/** Altura en coordenadas de tesela (0..32767) por interpolación baricéntrica. */
function sampleQM(t: QMTile, qu: number, qv: number): number | null {
  const { u, v, h, idx, g } = t
  const cx = Math.min(g - 1, Math.max(0, Math.floor((qu / (QMAX + 1)) * g)))
  const cy = Math.min(g - 1, Math.max(0, Math.floor((qv / (QMAX + 1)) * g)))
  const cell = cy * g + cx
  let best = -1
  let bw0 = 0
  let bw1 = 0
  let bestOut = Infinity
  for (let k = t.cellStart[cell]; k < t.cellStart[cell + 1]; k++) {
    const tri = t.cellTris[k]
    const i0 = idx[3 * tri]
    const i1 = idx[3 * tri + 1]
    const i2 = idx[3 * tri + 2]
    const x0 = u[i0]
    const y0 = v[i0]
    const d = (v[i1] - v[i2]) * (x0 - u[i2]) + (u[i2] - u[i1]) * (y0 - v[i2])
    if (d === 0) continue
    const w0 = ((v[i1] - v[i2]) * (qu - u[i2]) + (u[i2] - u[i1]) * (qv - v[i2])) / d
    const w1 = ((v[i2] - y0) * (qu - u[i2]) + (x0 - u[i2]) * (qv - v[i2])) / d
    const w2 = 1 - w0 - w1
    const out = Math.max(-w0, -w1, -w2)
    if (out < bestOut) {
      bestOut = out
      best = tri
      bw0 = w0
      bw1 = w1
      if (out <= 1e-6) break
    }
  }
  if (best < 0) return null
  const hq = bw0 * h[idx[3 * best]] + bw1 * h[idx[3 * best + 1]] + (1 - bw0 - bw1) * h[idx[3 * best + 2]]
  return t.minH + ((t.maxH - t.minH) * hq) / QMAX
}

type Entry<T> = { state: 'loading' | 'ok' | 'missing'; data: T | null; promise: Promise<void>; used: number }

export class QMHeightSource implements HeightSource {
  private readonly tiles = new Map<string, Entry<QMTile>>()
  private readonly queue = new FetchQueue(8)
  private available: Array<Array<{ startX: number; startY: number; endX: number; endY: number }>> | null = null
  private readonly ready: Promise<void>
  private disposed = false
  private clock = 0

  /**
   * @param baseUrl raíz del servicio (termina en "/", contiene layer.json)
   * @param level nivel de las teselas que se leen (el máximo da la malla más fina)
   */
  private readonly baseUrl: string
  readonly level: number
  private readonly maxTiles: number

  constructor(baseUrl: string, level: number, maxTiles = 600) {
    this.baseUrl = baseUrl
    this.level = level
    this.maxTiles = maxTiles
    this.ready = fetch(new URL('layer.json', baseUrl))
      .then((r) => r.json())
      .then((j) => {
        this.available = fixIgnAvailability(j).available ?? null
        this.version = j.version ?? '1.0.0'
      })
      .catch(() => {
        this.available = null
      })
  }
  private version = '1.0.0'

  private isAvailable(z: number, x: number, y: number): boolean {
    const av = this.available
    if (!av) return true
    const ranges = av[z]
    if (!ranges) return false
    for (const r of ranges) if (x >= r.startX && x <= r.endX && y >= r.startY && y <= r.endY) return true
    return false
  }

  /** tesela (x, y TMS desde el sur) que contiene el punto, y su posición cuantizada */
  private locate(latDeg: number, lonDeg: number, z: number): { x: number; y: number; qu: number; qv: number } {
    const size = 180 / 2 ** z
    const fx = (lonDeg + 180) / size
    const fy = (latDeg + 90) / size
    const x = Math.floor(fx)
    const y = Math.floor(fy)
    return { x, y, qu: (fx - x) * QMAX, qv: (fy - y) * QMAX }
  }

  private request(z: number, x: number, y: number): Entry<QMTile> {
    const key = `${z}/${x}/${y}`
    let e = this.tiles.get(key)
    if (e) {
      e.used = ++this.clock
      return e
    }
    const entry: Entry<QMTile> = { state: 'loading', data: null, promise: Promise.resolve(), used: ++this.clock }
    entry.promise = this.ready
      .then(() => {
        if (!this.isAvailable(z, x, y)) throw new Error('no disponible')
        return this.queue.run(() => fetch(`${this.baseUrl}${z}/${x}/${y}.terrain?v=${this.version}`))
      })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.arrayBuffer()
      })
      .then((buf) => {
        entry.data = decodeQuantizedMesh(buf)
        entry.state = 'ok'
      })
      .catch(() => {
        entry.state = 'missing'
      })
    this.tiles.set(key, entry)
    this.evict()
    return entry
  }

  private evict(): void {
    if (this.tiles.size <= this.maxTiles) return
    const list = [...this.tiles.entries()].filter(([, e]) => e.state !== 'loading').sort((a, b) => a[1].used - b[1].used)
    for (let i = 0; i < list.length && this.tiles.size > this.maxTiles * 0.8; i++) this.tiles.delete(list[i][0])
  }

  /** Carga una tesela concreta (z, x, y TMS) de cualquier nivel; false si no existe. */
  async ensureTile(z: number, x: number, y: number): Promise<boolean> {
    const e = this.request(z, x, y)
    await e.promise
    return e.state === 'ok'
  }

  /** Altura dentro de una tesela concreta ya cargada (fu, fv ∈ [0, 1] de oeste a este y de sur a norte). */
  sampleTile(z: number, x: number, y: number, fu: number, fv: number): number | null {
    const e = this.tiles.get(`${z}/${x}/${y}`)
    if (e?.state !== 'ok') return null
    e.used = ++this.clock
    const c = (f: number) => Math.min(1, Math.max(0, f)) * QMAX
    return sampleQM(e.data!, c(fu), c(fv))
  }

  sample(latDeg: number, lonDeg: number): number | null {
    if (this.disposed) return null
    const p = this.locate(latDeg, lonDeg, this.level)
    const e = this.request(this.level, p.x, p.y)
    if (e.state === 'ok') return sampleQM(e.data!, p.qu, p.qv)
    // mientras llega (o si no existe a ese nivel): el padre más fino ya cargado
    for (let z = this.level - 1; z >= Math.max(0, this.level - 6); z--) {
      const q = this.locate(latDeg, lonDeg, z)
      const pe = this.tiles.get(`${z}/${q.x}/${q.y}`)
      if (pe?.state === 'ok') return sampleQM(pe.data!, q.qu, q.qv)
    }
    // ninguno: se pide uno grueso (cubre 8×8 teselas) para tener algo pronto
    const z = Math.max(0, this.level - 3)
    const q = this.locate(latDeg, lonDeg, z)
    this.request(z, q.x, q.y)
    return null
  }

  async ensure(south: number, west: number, north: number, east: number): Promise<void> {
    const z = this.level
    const a = this.locate(south, west, z)
    const b = this.locate(north, east, z)
    const jobs: Promise<void>[] = []
    for (let y = a.y; y <= b.y; y++) for (let x = a.x; x <= b.x; x++) jobs.push(this.request(z, x, y).promise)
    await Promise.all(jobs)
  }

  dispose(): void {
    this.disposed = true
    this.tiles.clear()
  }
}

// ---------------------------------------------------------------------------
// Terrarium (PNG, Web Mercator)
// ---------------------------------------------------------------------------

interface GridTile {
  w: number
  h: number
  data: Float32Array
}

export class TerrariumHeightSource implements HeightSource {
  private readonly tiles = new Map<string, Entry<GridTile>>()
  private readonly queue = new FetchQueue(6)
  private clock = 0
  private disposed = false

  private readonly url: string
  readonly zoom: number
  private readonly maxTiles: number

  constructor(url: string, zoom = 15, maxTiles = 200) {
    this.url = url
    this.zoom = zoom
    this.maxTiles = maxTiles
  }

  private locate(latDeg: number, lonDeg: number, z: number): { x: number; y: number; fx: number; fy: number } {
    const n = 2 ** z
    const lat = (latDeg * Math.PI) / 180
    const fx = ((lonDeg + 180) / 360) * n
    const fy = ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n
    return { x: Math.floor(fx), y: Math.floor(fy), fx: fx - Math.floor(fx), fy: fy - Math.floor(fy) }
  }

  private request(z: number, x: number, y: number): Entry<GridTile> {
    const key = `${z}/${x}/${y}`
    let e = this.tiles.get(key)
    if (e) {
      e.used = ++this.clock
      return e
    }
    const entry: Entry<GridTile> = { state: 'loading', data: null, promise: Promise.resolve(), used: ++this.clock }
    const src = this.url.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))
    entry.promise = this.queue
      .run(() => fetch(src))
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.blob()
      })
      .then((b) => createImageBitmap(b))
      .then((img) => {
        const cv = new OffscreenCanvas(img.width, img.height)
        const ctx = cv.getContext('2d', { willReadFrequently: true })!
        ctx.drawImage(img, 0, 0)
        const px = ctx.getImageData(0, 0, img.width, img.height).data
        const data = new Float32Array(img.width * img.height)
        // el fondo marino (cotas negativas) se lleva a 0, como en el terreno que se dibuja (seaLevel.ts)
        const lo = tileHasLandBelowSea(z, x, y) ? -Infinity : 0
        for (let i = 0; i < data.length; i++) data[i] = Math.max(lo, px[4 * i] * 256 + px[4 * i + 1] + px[4 * i + 2] / 256 - 32768)
        entry.data = { w: img.width, h: img.height, data }
        entry.state = 'ok'
        img.close()
      })
      .catch(() => {
        entry.state = 'missing'
      })
    this.tiles.set(key, entry)
    if (this.tiles.size > this.maxTiles) {
      const list = [...this.tiles.entries()].filter(([, e2]) => e2.state !== 'loading').sort((p, q) => p[1].used - q[1].used)
      for (let i = 0; i < list.length && this.tiles.size > this.maxTiles * 0.8; i++) this.tiles.delete(list[i][0])
    }
    return entry
  }

  sample(latDeg: number, lonDeg: number): number | null {
    if (this.disposed) return null
    const p = this.locate(latDeg, lonDeg, this.zoom)
    const e = this.request(this.zoom, p.x, p.y)
    if (e.state !== 'ok') return null
    const t = e.data!
    // centros de píxel en (i + 0.5)
    const gx = Math.min(t.w - 1.001, Math.max(0, p.fx * t.w - 0.5))
    const gy = Math.min(t.h - 1.001, Math.max(0, p.fy * t.h - 0.5))
    const i = Math.floor(gx)
    const j = Math.floor(gy)
    const sx = gx - i
    const sy = gy - j
    const d = t.data
    const w = t.w
    const a = d[j * w + i] * (1 - sx) + d[j * w + i + 1] * sx
    const b = d[(j + 1) * w + i] * (1 - sx) + d[(j + 1) * w + i + 1] * sx
    return a * (1 - sy) + b * sy
  }

  async ensure(south: number, west: number, north: number, east: number): Promise<void> {
    const a = this.locate(north, west, this.zoom)
    const b = this.locate(south, east, this.zoom)
    const jobs: Promise<void>[] = []
    for (let y = a.y; y <= b.y; y++) for (let x = a.x; x <= b.x; x++) jobs.push(this.request(this.zoom, x, y).promise)
    await Promise.all(jobs)
  }

  dispose(): void {
    this.disposed = true
    this.tiles.clear()
  }
}

// ---------------------------------------------------------------------------
// Cobertura del MDT del IGN
// ---------------------------------------------------------------------------

// Contorno aproximado (lon, lat) de la España peninsular y Baleares: las fronteras
// con Portugal, Francia y Andorra con unos km de precisión; por mar, con holgura.
// Fuera de él, el servicio del IGN devuelve teselas planas a altura 0.
const SPAIN: Array<[number, number]> = [
  [-9.7, 44.2], [-1.85, 44.2], [-1.79, 43.37], [-1.5, 43.28], [-1.4, 43.05], [-0.75, 42.95], [-0.3, 42.82], [0.0, 42.69],
  [0.65, 42.85], [0.95, 42.8], [1.4, 42.5], [1.75, 42.4], [2.0, 42.36], [2.5, 42.36], [3.0, 42.43], [3.2, 42.43],
  [3.6, 42.5], [4.7, 40.4], [4.7, 38.4], [0.4, 38.2], [-1.4, 36.6], [-5.2, 35.95], [-6.6, 36.3], [-7.42, 37.17],
  [-7.45, 37.55], [-7.1, 38.0], [-6.95, 38.2], [-7.3, 38.43], [-7.25, 38.75], [-7.05, 38.9], [-7.05, 39.1], [-7.3, 39.4],
  [-7.53, 39.66], [-7.0, 39.66], [-6.88, 39.95], [-6.95, 40.25], [-6.8, 40.55], [-6.85, 40.9], [-6.93, 41.03], [-6.55, 41.3],
  [-6.25, 41.55], [-6.3, 41.68], [-6.55, 41.95], [-6.85, 41.97], [-7.2, 41.88], [-7.6, 41.87], [-7.9, 41.83], [-8.2, 42.12],
  [-8.65, 42.05], [-8.88, 41.87], [-9.7, 41.87],
]

export function hasIgnTerrain(latDeg: number, lonDeg: number): boolean {
  const canarias = latDeg > 27.5 && latDeg < 29.5 && lonDeg > -18.3 && lonDeg < -13.3
  if (canarias) return true
  let inside = false
  for (let i = 0, j = SPAIN.length - 1; i < SPAIN.length; j = i++) {
    const [xi, yi] = SPAIN[i]
    const [xj, yj] = SPAIN[j]
    if (yi > latDeg !== yj > latDeg && lonDeg < ((xj - xi) * (latDeg - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

type TileRange = { startX: number; startY: number; endX: number; endY: number }

// El layer.json del IGN anuncia en cada nivel un único rectángulo, de Canarias a los Pirineos,
// pero el servicio solo sirve dos y el resto (Atlántico, Marruecos, Francia…) responde 403.
// Rangos TMS medidos en el nivel 16 contra el servidor; los de cada nivel salen de desplazarlos
// (comprobado en los bordes e interior de los niveles 0–16 el 2026-11-20, 648 teselas sin fallos).
const IGN_DECLARED_L16: TileRange = { startX: 58905, startY: 42828, endX: 67334, endY: 48764 }
const IGN_SERVED_L16: TileRange[] = [
  { startX: 62094, startY: 45529, endX: 67334, endY: 48764 }, // Península, Baleares, Ceuta y Melilla
  { startX: 58905, startY: 42828, endX: 60682, endY: 43481 }, // Canarias
]

/**
 * Sustituye la disponibilidad del layer.json del IGN por la que sirve de verdad, para no pedir
 * teselas que van a dar 403 (errores en consola y huecos en el horizonte). Si el layer.json ya
 * no es el conocido (el IGN ha cambiado el servicio), lo deja tal cual.
 */
export function fixIgnAvailability<T extends { available?: TileRange[][] | null }>(layer: T): T {
  const av = layer.available
  const d = av?.[16]
  const known = av?.length === 17 && d?.length === 1 && (Object.keys(IGN_DECLARED_L16) as (keyof TileRange)[]).every((k) => d[0][k] === IGN_DECLARED_L16[k])
  if (!known) return layer
  const available = av.map((_, z) => {
    const s = 16 - z
    const ranges: TileRange[] = []
    for (const r of IGN_SERVED_L16) {
      const q = { startX: r.startX >> s, startY: r.startY >> s, endX: r.endX >> s, endY: r.endY >> s }
      // en los niveles bajos los dos rectángulos se solapan: basta con el que contiene al otro
      const big = ranges.find((o) => o.startX <= q.startX && o.startY <= q.startY && o.endX >= q.endX && o.endY >= q.endY)
      if (!big) ranges.push(q)
    }
    return ranges
  })
  return { ...layer, available }
}
