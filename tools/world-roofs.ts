// Tejados de OpenStreetMap (roof:shape…) de los monumentos de los sitios del mundo
// (tools/world-sites.ts), añadidos a public/osm-roofs.bin, que solo se genera para España con
// tools/osm-roofs.ts a partir de los volcados de Geofabrik. Aquí se piden a Overpass alrededor de
// cada sitio (así las pirámides de Guiza salen como pirámides y las cúpulas como cúpulas, y no
// como bloques de techo plano). Los registros se calculan igual que en tools/osm-roofs.ts.
//
//   node --experimental-strip-types tools/world-sites.ts roofs
//
// Hay que volver a pasarlo cada vez que se regenere public/osm-roofs.bin con tools/osm-roofs.ts.
// Los registros que ya están (mismo centroide y área) no se repiten.

import { readFileSync, writeFileSync } from 'node:fs'
import { unzlibSync, zlibSync } from 'fflate'
import { Color } from 'three'
import {
  FLAG_ACROSS,
  FLAG_COLOUR,
  FLAG_MATERIAL,
  FLAG_PART,
  HEADER,
  MAGIC,
  MATERIAL_COLOURS,
  parseDirection,
  parseMetres,
  RECORD,
  SHAPES,
} from '../src/world/osmRoofFormat.ts'

const FILE = 'public/osm-roofs.bin'
// el principal y espejos públicos (si uno está saturado, se prueba otro)
const OVERPASS = [
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]
const RADIUS = 1500

type LatLon = { lat: number; lon: number }
interface OsmEl {
  type: 'way' | 'relation'
  tags?: Record<string, string>
  geometry?: LatLon[]
  members?: Array<{ type: string; role: string; geometry?: LatLon[] }>
}

const NAMES = (Color as unknown as { NAMES: Record<string, number> }).NAMES

function parseColour(v: string | undefined): [number, number, number] | null {
  if (!v) return null
  let s = v.trim().toLowerCase()
  if (/^#?[0-9a-f]{6}$/.test(s)) {
    s = s.replace('#', '')
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)]
  }
  if (/^#[0-9a-f]{3}$/.test(s)) return [parseInt(s[1] + s[1], 16), parseInt(s[2] + s[2], 16), parseInt(s[3] + s[3], 16)]
  const name = s.replace(/[\s_-]/g, '').replace('gray', 'grey')
  const hex = NAMES[name] ?? NAMES[name.replace('grey', 'gray')]
  if (hex === undefined) return null
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255]
}

/** Empalma trozos de anillo por sus extremos (vías exteriores partidas de un multipolígono). */
function joinRings(parts: LatLon[][]): LatLon[][] {
  const same = (a: LatLon, b: LatLon) => a.lat === b.lat && a.lon === b.lon
  const rings: LatLon[][] = []
  const left = parts.filter((p) => p.length >= 2).map((p) => [...p])
  while (left.length) {
    let ring = left.shift()!
    let grew = true
    while (!same(ring[0], ring[ring.length - 1]) && grew) {
      grew = false
      for (let i = 0; i < left.length; i++) {
        const p = left[i]
        const end = ring[ring.length - 1]
        if (same(end, p[0])) ring = ring.concat(p.slice(1))
        else if (same(end, p[p.length - 1])) ring = ring.concat([...p].reverse().slice(1))
        else continue
        left.splice(i, 1)
        grew = true
        break
      }
    }
    if (same(ring[0], ring[ring.length - 1])) rings.push(ring)
  }
  return rings
}

/** Registro de 28 bytes (formato de osmRoofFormat.ts), o null si el anillo no vale. */
function record(tags: Record<string, string>, ring: LatLon[]): Uint8Array | null {
  const shape = SHAPES[tags['roof:shape']]
  if (shape === undefined || ring.length < 4) return null
  // área y centroide en un plano local (m), como tools/osm-roofs.ts
  const lat0 = ring[0].lat
  const lon0 = ring[0].lon
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180)
  const ky = 110574
  let a = 0
  let cx = 0
  let cy = 0
  for (let i = 0; i < ring.length - 1; i++) {
    const x0 = (ring[i].lon - lon0) * kx
    const y0 = (ring[i].lat - lat0) * ky
    const x1 = (ring[i + 1].lon - lon0) * kx
    const y1 = (ring[i + 1].lat - lat0) * ky
    const c = x0 * y1 - x1 * y0
    a += c
    cx += (x0 + x1) * c
    cy += (y0 + y1) * c
  }
  a /= 2
  if (Math.abs(a) < 4) return null
  cx /= 6 * a
  cy /= 6 * a
  const lat = lat0 + cy / ky
  const lon = lon0 + cx / kx
  const height = parseMetres(tags.height) ?? parseMetres(tags['building:height'])
  const minHeight = parseMetres(tags.min_height)
  let roofH = parseMetres(tags['roof:height'])
  if (roofH === null) {
    const rl = Number((tags['roof:levels'] ?? '').replace(',', '.'))
    if (rl > 0 && rl < 30) roofH = rl * 3
  }
  const angle = Number((tags['roof:angle'] ?? '').replace(',', '.').replace('°', ''))
  const dir = parseDirection(tags['roof:direction'])
  let flags = 0
  if (tags['roof:orientation'] === 'across') flags |= FLAG_ACROSS
  if (tags['building:part'] !== undefined && tags.building === undefined) flags |= FLAG_PART
  let rgb = parseColour(tags['roof:colour'] ?? tags['roof:color'])
  if (rgb) flags |= FLAG_COLOUR
  else {
    const m = MATERIAL_COLOURS[(tags['roof:material'] ?? '').toLowerCase()]
    if (m) {
      rgb = parseColour(m)
      flags |= FLAG_MATERIAL
    }
  }
  const ok = (v: number | null) => (v !== null && v > 0 && v < 6000 ? v : 0)
  const out = new Uint8Array(RECORD)
  const dv = new DataView(out.buffer)
  dv.setInt32(0, Math.round(lat * 1e7), true)
  dv.setInt32(4, Math.round(lon * 1e7), true)
  dv.setFloat32(8, Math.abs(a), true)
  dv.setUint16(12, Math.min(65535, Math.round(ok(height) * 10)), true)
  dv.setUint16(14, Math.min(65535, Math.round(ok(minHeight) * 10)), true)
  dv.setUint16(16, Math.min(65535, Math.round(ok(roofH) * 10)), true)
  dv.setUint16(18, dir === null ? 0xffff : Math.round(dir) % 360, true)
  out[20] = shape
  out[21] = flags
  out[22] = angle > 0 && angle < 90 ? Math.round(angle) : 0
  if (rgb) out.set(rgb, 23)
  return out
}

async function overpass(lat: number, lon: number): Promise<OsmEl[]> {
  const around = `(around:${RADIUS},${lat},${lon})`
  const q = `[out:json][timeout:170];(way["roof:shape"]["building"]${around};way["roof:shape"]["building:part"]${around};relation["roof:shape"]["type"="multipolygon"]${around};);out tags geom;`
  for (let attempt = 0; attempt < 10; attempt++) {
    const url = OVERPASS[attempt % OVERPASS.length]
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': 'autogiro-world-roofs-tool', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(q)}`,
        signal: AbortSignal.timeout(200_000),
      })
      if (r.ok) return ((await r.json()) as { elements: OsmEl[] }).elements
      console.log(`  ${new URL(url).host}: HTTP ${r.status}`)
    } catch (e) {
      console.log(`  ${new URL(url).host}: ${(e as Error).message}`)
    }
    // 429/504 o sin respuesta: el servidor está ocupado; se prueba el siguiente y se espera más cada vez
    await new Promise((res) => setTimeout(res, 10000 * (attempt + 1)))
  }
  throw new Error('Overpass no responde')
}

const keyOf = (rec: Uint8Array) => {
  const dv = new DataView(rec.buffer, rec.byteOffset, RECORD)
  return `${dv.getInt32(0, true)},${dv.getInt32(4, true)},${dv.getFloat32(8, true).toFixed(1)}`
}

export async function worldRoofs(sites: Array<{ id: string; lat: number; lon: number }>): Promise<void> {
  const raw = unzlibSync(new Uint8Array(readFileSync(FILE)))
  if (String.fromCharCode(...raw.subarray(0, 4)) !== MAGIC) throw new Error(`${FILE}: formato desconocido`)
  const hdv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  const count = hdv.getUint32(4, true)
  const date = hdv.getUint32(8, true)
  const recs: Uint8Array[] = []
  const seen = new Set<string>()
  for (let i = 0; i < count; i++) {
    const r = raw.slice(HEADER + i * RECORD, HEADER + (i + 1) * RECORD)
    recs.push(r)
    seen.add(keyOf(r))
  }
  let added = 0
  for (const s of sites) {
    const els = await overpass(s.lat, s.lon)
    let n = 0
    for (const el of els) {
      const tags = el.tags ?? {}
      const rings =
        el.type === 'way'
          ? el.geometry
            ? [el.geometry]
            : []
          : joinRings((el.members ?? []).filter((m) => m.type === 'way' && (m.role === 'outer' || m.role === '') && m.geometry).map((m) => m.geometry!))
      for (const ring of rings) {
        const rec = record(tags, ring)
        if (!rec) continue
        const k = keyOf(rec)
        if (seen.has(k)) continue
        seen.add(k)
        recs.push(rec)
        n++
      }
    }
    added += n
    console.log(`${s.id.padEnd(15)} ${els.length} elementos con roof:shape → ${n} tejados nuevos`)
    await new Promise((res) => setTimeout(res, 2000)) // sin saturar Overpass
  }
  // ordenados por tesela z14, como los escribe tools/osm-roofs.ts (osmRoofs.ts indexa por tramos)
  const n14 = 2 ** 14
  const tileOf = (r: Uint8Array) => {
    const dv = new DataView(r.buffer, r.byteOffset, RECORD)
    const lat = dv.getInt32(0, true) / 1e7
    const lon = dv.getInt32(4, true) / 1e7
    const tx = Math.floor(((lon + 180) / 360) * n14)
    const ty = Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n14)
    return ty * n14 + tx
  }
  const keyed = recs.map((r) => ({ r, t: tileOf(r) }))
  keyed.sort((p, q) => p.t - q.t)
  const buf = new Uint8Array(HEADER + keyed.length * RECORD)
  const dv = new DataView(buf.buffer)
  for (let i = 0; i < 4; i++) buf[i] = MAGIC.charCodeAt(i)
  dv.setUint32(4, keyed.length, true)
  dv.setUint32(8, date, true)
  keyed.forEach((k, i) => buf.set(k.r, HEADER + i * RECORD))
  const packed = zlibSync(buf, { level: 9 })
  writeFileSync(FILE, packed)
  console.log(`\n${FILE}: ${count} + ${added} = ${keyed.length} tejados · ${(packed.length / 1e6).toFixed(2)} MB`)
}
