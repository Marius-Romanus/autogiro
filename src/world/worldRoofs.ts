// Tejados de OpenStreetMap de todo el mundo (cúpulas, chapiteles, dos y cuatro aguas…), cargados
// por zonas según se vuela.
//
// España (y los monumentos del mundo) van en public/osm-roofs.bin, dentro del juego. El resto del
// mundo son ~10 millones de tejados (sacados de Overture Maps con tools/world-roofs-overture.py y
// empaquetados con tools/world-roofs-pack.ts): un solo fichero de ~150 MB que se aloja aparte (adjunto
// «datos-tejados» de las versiones de GitHub). El juego lee su índice y pide por rangos solo la zona
// z8 (~150 km) por donde vuela, a través del servidor local (/tejados/…: server/tejados.ts y
// src-tauri/src/tejados.rs), porque GitHub no manda cabeceras CORS.
//
// Los registros traen el rectángulo envolvente de la huella (no su área): cada edificio de la
// tesela vectorial se casa por el centro y el tamaño de su rectángulo.

import { unzlibSync } from 'fflate'
import { hasIgnTerrain } from './HeightSource.ts'
import { latToY, lonToX, xToLon, yToLat, Z } from './mapTiles.ts'
import { RECORD, WORLD_HEADER, WORLD_INDEX, WORLD_MAGIC } from './osmRoofFormat.ts'
import { readRoofRecord, type OsmRoof } from './osmRoofs.ts'

/** Fichero de datos vigente (el nombre lleva la fecha: cambia con cada versión de los datos). */
export const WORLD_ROOFS_FILE = 'tejados-mundo-20261118.bin'
const URL = `${import.meta.env.BASE_URL}tejados/${WORLD_ROOFS_FILE}`
/** zonas en memoria (las más recientes) */
const KEEP = 10
/** espera máxima por una zona al construir una tesela (si no llega, la tesela sale sin ellos) */
const WAIT_MS = 6000

interface Index {
  z: number
  keys: Uint32Array
  offs: Uint32Array
  lens: Uint32Array
}

interface Zone {
  dv: DataView
  /** tesela z14 (y · 2^14 + x) → [primer registro, último + 1] */
  byTile: Map<number, [number, number]>
}

let index: Promise<Index | null> | null = null
const zones = new Map<number, Promise<Zone | null>>()
let failed = false

async function fetchRange(start: number, end: number): Promise<Uint8Array> {
  const r = await fetch(URL, { headers: { Range: `bytes=${start}-${end - 1}` } })
  if (r.status !== 206 && r.status !== 200) throw new Error(`HTTP ${r.status}`)
  const b = new Uint8Array(await r.arrayBuffer())
  // un servidor que no entienda de rangos devuelve el fichero entero
  return r.status === 200 ? b.subarray(start, end) : b
}

function loadIndex(): Promise<Index | null> {
  index ??= (async () => {
    try {
      // cabecera e índice de una vez (unas 10 000 zonas = 160 KB); si no cabe, otra petición
      let head = await fetchRange(0, 256 * 1024)
      const magic = String.fromCharCode(head[0], head[1], head[2], head[3])
      if (magic !== WORLD_MAGIC) throw new Error(`formato desconocido (${magic})`)
      let dv = new DataView(head.buffer, head.byteOffset, head.byteLength)
      const count = dv.getUint32(8, true)
      const z = head[12]
      const need = WORLD_HEADER + count * WORLD_INDEX
      if (head.length < need) {
        head = await fetchRange(0, need)
        dv = new DataView(head.buffer, head.byteOffset, head.byteLength)
      }
      const keys = new Uint32Array(count)
      const offs = new Uint32Array(count)
      const lens = new Uint32Array(count)
      for (let i = 0; i < count; i++) {
        const o = WORLD_HEADER + i * WORLD_INDEX
        keys[i] = dv.getUint32(o, true)
        offs[i] = dv.getUint32(o + 4, true)
        lens[i] = dv.getUint32(o + 8, true)
      }
      return { z, keys, offs, lens }
    } catch (e) {
      failed = true
      console.warn('tejados del mundo: no se pudo leer el índice (fuera de España se deducen de la planta)', e)
      return null
    }
  })()
  return index
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'function') {
    const s = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'))
    return new Uint8Array(await new Response(s).arrayBuffer())
  }
  return unzlibSync(data)
}

function loadZone(idx: Index, key: number): Promise<Zone | null> {
  let p = zones.get(key)
  if (p) {
    // más reciente al final
    zones.delete(key)
    zones.set(key, p)
    return p
  }
  p = (async () => {
    // búsqueda binaria en el índice (ordenado por clave)
    let lo = 0
    let hi = idx.keys.length - 1
    let at = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (idx.keys[mid] === key) {
        at = mid
        break
      }
      if (idx.keys[mid] < key) lo = mid + 1
      else hi = mid - 1
    }
    if (at < 0) return null // zona sin tejados
    try {
      const raw = await inflate(await fetchRange(idx.offs[at], idx.offs[at] + idx.lens[at]))
      const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
      const n = 2 ** Z
      const byTile = new Map<number, [number, number]>()
      const count = Math.floor(raw.length / RECORD)
      let last = -1
      for (let i = 0; i < count; i++) {
        const o = i * RECORD
        const lat = dv.getInt32(o, true) / 1e7
        const lon = dv.getInt32(o + 4, true) / 1e7
        const k = Math.floor(latToY(lat, n)) * n + Math.floor(lonToX(lon, n))
        if (k === last) byTile.get(k)![1] = i + 1
        else {
          last = k
          const prev = byTile.get(k)
          byTile.set(k, prev ? [prev[0], i + 1] : [i, i + 1])
        }
      }
      return { dv, byTile }
    } catch (e) {
      console.warn('tejados del mundo: no se pudo cargar una zona', e)
      zones.delete(key) // se reintenta la próxima vez
      return null
    }
  })()
  zones.set(key, p)
  while (zones.size > KEEP) zones.delete(zones.keys().next().value!)
  return p
}

/**
 * Tejados del mundo de una tesela z14 (null en España, que tiene los suyos en osm-roofs.bin, si no
 * hay ninguno, o si la zona no llega a tiempo).
 */
export async function worldRoofsTile(x: number, y: number): Promise<WorldTileRoofs | null> {
  if (failed) return null
  const n = 2 ** Z
  if (hasIgnTerrain(yToLat(y + 0.5, n), xToLon(x + 0.5, n))) return null
  const work = (async () => {
    const idx = await loadIndex()
    if (!idx) return null
    const shift = Z - idx.z
    const zone = await loadZone(idx, (y >> shift) * 2 ** idx.z + (x >> shift))
    const range = zone?.byTile.get(y * n + x)
    return zone && range ? new WorldTileRoofs(zone.dv, range[0], range[1], x, y) : null
  })()
  return Promise.race([work, new Promise<null>((r) => setTimeout(() => r(null), WAIT_MS))])
}

/** Registros de una tesela, para casarlos con sus huellas por el rectángulo envolvente. */
export class WorldTileRoofs {
  private readonly px: Float64Array
  private readonly py: Float64Array
  private readonly w: Float32Array
  private readonly h: Float32Array
  private readonly used: Uint8Array
  private readonly first: number
  private readonly dv: DataView
  /** rejilla 32 × 32 sobre la tesela → índices */
  private readonly grid = new Map<number, number[]>()
  matched = 0

  constructor(dv: DataView, first: number, end: number, x: number, y: number) {
    const m = end - first
    this.dv = dv
    this.first = first
    this.px = new Float64Array(m)
    this.py = new Float64Array(m)
    this.w = new Float32Array(m)
    this.h = new Float32Array(m)
    this.used = new Uint8Array(m)
    const n = 2 ** Z
    for (let i = 0; i < m; i++) {
      const o = (first + i) * RECORD
      this.px[i] = lonToX(dv.getInt32(o + 4, true) / 1e7, n) - x
      this.py[i] = latToY(dv.getInt32(o, true) / 1e7, n) - y
      this.w[i] = dv.getUint16(o + 8, true) / 10
      this.h[i] = dv.getUint16(o + 10, true) / 10
      const c = cell(this.px[i], this.py[i])
      const list = this.grid.get(c)
      if (list) list.push(i)
      else this.grid.set(c, [i])
    }
  }

  get size(): number {
    return this.px.length
  }

  /**
   * El registro de una huella por su rectángulo envolvente: centro (cx, cy) en unidades de la
   * tesela vectorial (0..E), ancho y alto en m. Cada registro se usa una vez.
   */
  match(cx: number, cy: number, wM: number, hM: number, mPerUnit: number, E: number): OsmRoof | null {
    const fx = cx / E
    const fy = cy / E
    const size = Math.sqrt(Math.max(1, wM * hM))
    // la tesela cuantiza a ~0,5 m y Overture redondea el rectángulo hacia fuera
    const tolM = Math.max(1.8, 0.12 * size)
    const tol = tolM / (mPerUnit * E)
    const hi = size < 8 ? 1.5 : 1.22
    let best = -1
    let bestScore = Infinity
    const c0x = Math.floor((fx - tol) * 32)
    const c1x = Math.floor((fx + tol) * 32)
    const c0y = Math.floor((fy - tol) * 32)
    const c1y = Math.floor((fy + tol) * 32)
    for (let gy = c0y; gy <= c1y; gy++) {
      for (let gx = c0x; gx <= c1x; gx++) {
        const list = this.grid.get(gy * 64 + gx)
        if (!list) continue
        for (const i of list) {
          if (this.used[i]) continue
          const d = Math.hypot(this.px[i] - fx, this.py[i] - fy)
          if (d > tol) continue
          const rw = (wM + 1) / (this.w[i] + 1)
          const rh = (hM + 1) / (this.h[i] + 1)
          if (rw > hi || rw < 1 / hi || rh > hi || rh < 1 / hi) continue
          const score = d / tol + (Math.abs(Math.log(rw)) + Math.abs(Math.log(rh))) / Math.log(hi)
          if (score < bestScore) {
            bestScore = score
            best = i
          }
        }
      }
    }
    if (best < 0) return null
    this.used[best] = 1
    this.matched++
    return readRoofRecord(this.dv, (this.first + best) * RECORD)
  }
}

function cell(fx: number, fy: number): number {
  return Math.floor(fy * 32) * 64 + Math.floor(fx * 32)
}
