// Forma del tejado mapeada en OpenStreetMap (cúpulas, chapiteles, bulbos, dos y cuatro aguas…)
// para los edificios de las teselas vectoriales, que traen la huella y la altura pero no el
// tejado. Los datos salen de un volcado de OSM con tools/osm-roofs.ts (public/osm-roofs.bin,
// formato en osmRoofFormat.ts) y se casan con cada huella de la tesela por el centroide y el
// área: las teselas no llevan el identificador de OSM.

import { unzlibSync } from 'fflate'
import { latToY, lonToX, Z } from './mapTiles.ts'
import { FLAG_ACROSS, FLAG_COLOUR, FLAG_MATERIAL, FLAG_PART, HEADER, MAGIC, RECORD } from './osmRoofFormat.ts'

export interface OsmRoof {
  /** ROOF_* de osmRoofFormat.ts */
  shape: number
  /** height explícita (m): la altura de la tesela es la de la cima del tejado; null = la de las paredes */
  height: number | null
  /** altura del tejado (m); null = deducirla de la forma */
  roofH: number | null
  /** roof:direction (grados, hacia donde cae el agua) */
  dir: number | null
  /** roof:angle (grados) */
  angle: number | null
  /** caballete a lo ancho */
  across: boolean
  /** color del tejado (sRGB 0–255) */
  rgb: [number, number, number] | null
  /** el color sale de roof:material (aproximado), no de roof:colour */
  fromMaterial: boolean
  part: boolean
}

interface Table {
  dv: DataView
  /** tesela z14 (y · 2^14 + x) → [primer registro, último + 1] */
  byTile: Map<number, [number, number]>
  count: number
}

let table: Promise<Table | null> | null = null

function loadTable(): Promise<Table | null> {
  table ??= (async () => {
    try {
      const r = await fetch(`${import.meta.env.BASE_URL}osm-roofs.bin`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      let raw: Uint8Array
      if (typeof DecompressionStream === 'function' && r.body) {
        // zlib = «deflate» en DecompressionStream; fuera del hilo principal
        raw = new Uint8Array(await new Response(r.body.pipeThrough(new DecompressionStream('deflate'))).arrayBuffer())
      } else raw = unzlibSync(new Uint8Array(await r.arrayBuffer()))
      const magic = String.fromCharCode(raw[0], raw[1], raw[2], raw[3])
      if (magic !== MAGIC) throw new Error(`formato desconocido (${magic})`)
      const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
      const count = dv.getUint32(4, true)
      const byTile = new Map<number, [number, number]>()
      const n = 2 ** Z
      let key = -1
      for (let i = 0; i < count; i++) {
        const o = HEADER + i * RECORD
        const lat = dv.getInt32(o, true) / 1e7
        const lon = dv.getInt32(o + 4, true) / 1e7
        const k = Math.floor(latToY(lat, n)) * n + Math.floor(lonToX(lon, n))
        if (k !== key) {
          key = k
          const prev = byTile.get(k)
          byTile.set(k, prev ? [prev[0], i + 1] : [i, i + 1])
        } else byTile.get(k)![1] = i + 1
      }
      return { dv, byTile, count }
    } catch (e) {
      console.warn('tejados de OSM: no se pudieron cargar (se usan los deducidos de la planta)', e)
      return null
    }
  })()
  return table
}

/** Tejados de OSM de una tesela z14 (null si no hay ninguno o no hay datos). */
export async function osmRoofsTile(x: number, y: number): Promise<TileRoofs | null> {
  const t = await loadTable()
  if (!t) return null
  const range = t.byTile.get(y * 2 ** Z + x)
  if (!range) return null
  return new TileRoofs(t.dv, range[0], range[1], x, y)
}

/** Registros de una tesela, para casarlos con sus huellas. */
export class TileRoofs {
  private readonly px: Float64Array
  private readonly py: Float64Array
  private readonly area: Float32Array
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
    this.area = new Float32Array(m)
    this.used = new Uint8Array(m)
    const n = 2 ** Z
    for (let i = 0; i < m; i++) {
      const o = HEADER + (first + i) * RECORD
      const lat = dv.getInt32(o, true) / 1e7
      const lon = dv.getInt32(o + 4, true) / 1e7
      // en fracción de tesela (0..1)
      this.px[i] = lonToX(lon, n) - x
      this.py[i] = latToY(lat, n) - y
      this.area[i] = dv.getFloat32(o + 8, true)
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
   * El registro de una huella: centroide (cx, cy) en unidades de la tesela vectorial (0..E),
   * área en m². Cada registro se usa una vez.
   */
  match(cx: number, cy: number, areaM2: number, mPerUnit: number, E: number): OsmRoof | null {
    const fx = cx / E
    const fy = cy / E
    // tolerancia: la tesela cuantiza a ~0,5 m; las huellas pequeñas cambian más de área
    const tolM = Math.max(1.5, 0.12 * Math.sqrt(areaM2))
    const tol = tolM / (mPerUnit * E)
    const hi = areaM2 < 60 ? 1.45 : 1.18
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
          const ratio = areaM2 / Math.max(0.01, this.area[i])
          if (ratio > hi || ratio < 1 / hi) continue
          const score = d / tol + Math.abs(Math.log(ratio)) / Math.log(hi)
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
    return this.read(best)
  }

  private read(i: number): OsmRoof {
    return readRoofRecord(this.dv, HEADER + (this.first + i) * RECORD)
  }
}

/** Lee el registro que empieza en `o` (mismo formato en España y en el fichero mundial). */
export function readRoofRecord(dv: DataView, o: number): OsmRoof {
  const height = dv.getUint16(o + 12, true) / 10
  const roofH = dv.getUint16(o + 16, true) / 10
  const dir = dv.getUint16(o + 18, true)
  const flags = dv.getUint8(o + 21)
  const angle = dv.getUint8(o + 22)
  const coloured = (flags & (FLAG_COLOUR | FLAG_MATERIAL)) !== 0
  return {
    shape: dv.getUint8(o + 20),
    height: height > 0 ? height : null,
    roofH: roofH > 0 ? roofH : null,
    dir: dir === 0xffff ? null : dir,
    angle: angle > 0 ? angle : null,
    across: (flags & FLAG_ACROSS) !== 0,
    rgb: coloured ? [dv.getUint8(o + 23), dv.getUint8(o + 24), dv.getUint8(o + 25)] : null,
    fromMaterial: (flags & FLAG_MATERIAL) !== 0,
    part: (flags & FLAG_PART) !== 0,
  }
}

function cell(fx: number, fy: number): number {
  return Math.floor(fy * 32) * 64 + Math.floor(fx * 32)
}
