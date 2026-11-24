// Puentes de los que se sabe el tipo de estructura (public/bridges.bin, generado con
// tools/bridges.ts a partir de Wikidata; formato en bridgeFormat.ts). El fichero es pequeño
// (unos miles de puentes): se carga entero una vez y se indexa por tesela z14.

import { unzlibSync } from 'fflate'
import { HEADER, MAGIC, readRecord, RECORD, type BridgeRecord } from './bridgeFormat.ts'
import { latToY, lonToX, Z } from './mapTiles.ts'

interface Table {
  /** tesela z14 (y · 2^14 + x) → registros */
  byTile: Map<number, BridgeRecord[]>
  count: number
}

let table: Promise<Table | null> | null = null

/** Lee el fichero ya descomprimido. */
export function parseBridgeTable(raw: Uint8Array): Table {
  const magic = String.fromCharCode(raw[0], raw[1], raw[2], raw[3])
  if (magic !== MAGIC) throw new Error(`formato desconocido (${magic})`)
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  const count = Math.min(dv.getUint32(4, true), Math.floor((raw.byteLength - HEADER) / RECORD))
  const byTile = new Map<number, BridgeRecord[]>()
  const n = 2 ** Z
  for (let i = 0; i < count; i++) {
    const r = readRecord(dv, i)
    const k = Math.floor(latToY(r.lat, n)) * n + Math.floor(lonToX(r.lon, n))
    const l = byTile.get(k)
    if (l) l.push(r)
    else byTile.set(k, [r])
  }
  return { byTile, count }
}

/** Para las herramientas de Node (que no tienen `fetch` de rutas relativas). */
export function setBridgeTable(raw: Uint8Array): void {
  table = Promise.resolve(parseBridgeTable(unzlibSync(raw)))
}

function loadTable(): Promise<Table | null> {
  table ??= (async () => {
    try {
      const r = await fetch(`${import.meta.env.BASE_URL}bridges.bin`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return parseBridgeTable(unzlibSync(new Uint8Array(await r.arrayBuffer())))
    } catch (e) {
      console.warn('puentes: sin datos de estructura (todos se dibujan como viaducto de vigas)', e)
      return null
    }
  })()
  return table
}

/** Registros dentro de un rectángulo (grados). */
export async function bridgeRecordsIn(south: number, west: number, north: number, east: number): Promise<BridgeRecord[]> {
  const t = await loadTable()
  if (!t) return []
  const n = 2 ** Z
  const out: BridgeRecord[] = []
  for (let y = Math.floor(latToY(north, n)); y <= Math.floor(latToY(south, n)); y++) {
    for (let x = Math.floor(lonToX(west, n)); x <= Math.floor(lonToX(east, n)); x++) {
      const l = t.byTile.get(y * n + x)
      if (!l) continue
      for (const r of l) if (r.lat >= south && r.lat <= north && r.lon >= west && r.lon <= east) out.push(r)
    }
  }
  return out
}

/** Registros que pueden ser de este puente: los que caen cerca de su trazado. */
export function bridgeRecordsNear(c: { lat: Float64Array; lon: Float64Array; n: number; mLat: number; mLon: number }): Promise<BridgeRecord[]> {
  let south = 90
  let north = -90
  let west = 180
  let east = -180
  for (let i = 0; i < c.n; i++) {
    south = Math.min(south, c.lat[i])
    north = Math.max(north, c.lat[i])
    west = Math.min(west, c.lon[i])
    east = Math.max(east, c.lon[i])
  }
  const pad = 300
  return bridgeRecordsIn(south - pad / c.mLat, west - pad / c.mLon, north + pad / c.mLat, east + pad / c.mLon)
}
