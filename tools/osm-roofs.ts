// Saca de un volcado de OpenStreetMap (.osm.pbf de Geofabrik) la forma del tejado de cada
// edificio o parte de edificio que la tenga mapeada (roof:shape, roof:height, roof:direction,
// roof:colour…) y la guarda en public/osm-roofs.bin para el juego (src/world/osmRoofs.ts).
// Las teselas de OpenFreeMap traen la huella y la altura, pero no la forma del tejado: el juego
// casa cada huella con su registro por el centroide y el área.
//
//   node --experimental-strip-types tools/osm-roofs.ts spain-latest.osm.pbf canary-islands-latest.osm.pbf
//
// Volcados: https://download.geofabrik.de/europe/spain-latest.osm.pbf (1,5 GB, sin Canarias) y
// https://download.geofabrik.de/africa/canary-islands-latest.osm.pbf. Tarda unos minutos.
// Después hay que volver a añadir los monumentos del mundo: tools/world-sites.ts roofs.

import { closeSync, openSync, readSync, statSync, writeFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { PbfReader } from 'pbf'
import { zlibSync } from 'fflate'
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

const files = process.argv.slice(2).filter((a) => !a.startsWith('out='))
const outArg = process.argv.find((a) => a.startsWith('out='))
const OUT = outArg ? outArg.slice(4) : 'public/osm-roofs.bin'
if (files.length === 0) {
  console.error('uso: osm-roofs.ts <volcado.osm.pbf> [más volcados…] [out=public/osm-roofs.bin]')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Lectura del .osm.pbf (https://wiki.openstreetmap.org/wiki/PBF_Format)

interface Blob {
  offset: number
  type: string
  data: Uint8Array
}

/** Recorre los bloques del fichero; `only` = desplazamientos a leer (los demás se saltan). */
function* blobs(path: string, only?: Set<number>): Generator<Blob> {
  const fd = openSync(path, 'r')
  const size = statSync(path).size
  const lenBuf = Buffer.alloc(4)
  let pos = 0
  try {
    while (pos < size) {
      readSync(fd, lenBuf, 0, 4, pos)
      const hLen = lenBuf.readUInt32BE(0)
      const hBuf = Buffer.alloc(hLen)
      readSync(fd, hBuf, 0, hLen, pos + 4)
      let type = ''
      let dataSize = 0
      const h = new PbfReader(hBuf)
      h.readFields((tag, _r, p) => {
        if (tag === 1) type = p.readString()
        else if (tag === 3) dataSize = p.readVarint()
      }, null)
      const offset = pos
      const dataPos = pos + 4 + hLen
      pos = dataPos + dataSize
      if (type !== 'OSMData' || (only && !only.has(offset))) continue
      const raw = Buffer.alloc(dataSize)
      readSync(fd, raw, 0, dataSize, dataPos)
      let zlib: Uint8Array | null = null
      let plain: Uint8Array | null = null
      const b = new PbfReader(raw)
      b.readFields((tag, _r, p) => {
        if (tag === 1) plain = p.readBytes()
        else if (tag === 3) zlib = p.readBytes()
        else p.skip(p.type)
      }, null)
      const data = plain ?? (zlib ? new Uint8Array(inflateSync(zlib)) : null)
      if (!data) throw new Error(`bloque sin datos zlib/raw en ${offset} (¿otra compresión?)`)
      yield { offset, type, data }
    }
  } finally {
    closeSync(fd)
  }
}

interface Block {
  strings: string[]
  granularity: number
  latOff: number
  lonOff: number
  groups: Array<[number, number]>
  pbf: PbfReader
}

function readBlock(data: Uint8Array): Block {
  const pbf = new PbfReader(data)
  const blk: Block = { strings: [], granularity: 100, latOff: 0, lonOff: 0, groups: [], pbf }
  const td = new TextDecoder()
  pbf.readFields((tag, _r, p) => {
    if (tag === 1) {
      const end = p.readVarint() + p.pos
      while (p.pos < end) {
        const t = p.readVarint() >> 3
        const len = p.readVarint()
        if (t === 1) blk.strings.push(td.decode(data.subarray(p.pos, p.pos + len)))
        p.pos += len
      }
    } else if (tag === 2) {
      const len = p.readVarint()
      blk.groups.push([p.pos, p.pos + len])
      p.pos += len
    } else if (tag === 17) blk.granularity = p.readVarint()
    else if (tag === 19) blk.latOff = p.readVarint()
    else if (tag === 20) blk.lonOff = p.readVarint()
    else p.skip(p.type)
  }, null)
  return blk
}

/** Recorre los mensajes de los grupos: tag 2 = nodos densos, 3 = vía, 4 = relación. */
function eachMessage(blk: Block, fn: (tag: number, start: number, end: number) => void): void {
  const p = blk.pbf
  for (const [s, e] of blk.groups) {
    p.pos = s
    while (p.pos < e) {
      const val = p.readVarint()
      const tag = val >> 3
      if ((val & 7) !== 2) {
        p.skip(val & 7)
        continue
      }
      const len = p.readVarint()
      const start = p.pos
      fn(tag, start, start + len)
      p.pos = start + len
    }
  }
}

function packedUInts(p: PbfReader): number[] {
  const out: number[] = []
  const e = p.readVarint() + p.pos
  while (p.pos < e) out.push(p.readVarint())
  return out
}

function packedSInts(p: PbfReader): number[] {
  const out: number[] = []
  const e = p.readVarint() + p.pos
  while (p.pos < e) out.push(p.readSVarint())
  return out
}

interface WayMsg {
  id: number
  tags: Map<string, string>
  refs: number[]
}

function readWay(blk: Block, start: number, end: number, wantTags: boolean): WayMsg {
  const p = blk.pbf
  p.pos = start
  let id = 0
  let keys: number[] = []
  let vals: number[] = []
  const refs: number[] = []
  while (p.pos < end) {
    const val = p.readVarint()
    const tag = val >> 3
    if (tag === 1) id = p.readVarint()
    else if (tag === 2 && wantTags) keys = packedUInts(p)
    else if (tag === 3 && wantTags) vals = packedUInts(p)
    else if (tag === 8) {
      const e = p.readVarint() + p.pos
      let r = 0
      while (p.pos < e) {
        r += p.readSVarint()
        refs.push(r)
      }
    } else p.skip(val & 7)
  }
  const tags = new Map<string, string>()
  for (let i = 0; i < keys.length; i++) tags.set(blk.strings[keys[i]], blk.strings[vals[i]])
  return { id, tags, refs }
}

/** ¿Lleva roof:shape? (sin decodificar el resto) */
function wayHasKey(blk: Block, start: number, end: number, key: number): boolean {
  const p = blk.pbf
  p.pos = start
  while (p.pos < end) {
    const val = p.readVarint()
    if (val >> 3 === 2) {
      const e = p.readVarint() + p.pos
      while (p.pos < e) if (p.readVarint() === key) return true
      return false
    }
    p.skip(val & 7)
  }
  return false
}

interface RelMsg {
  id: number
  tags: Map<string, string>
  members: Array<{ id: number; type: number; role: string }>
}

function readRelation(blk: Block, start: number, end: number): RelMsg {
  const p = blk.pbf
  p.pos = start
  let id = 0
  let keys: number[] = []
  let vals: number[] = []
  let roles: number[] = []
  const memids: number[] = []
  let types: number[] = []
  while (p.pos < end) {
    const val = p.readVarint()
    const tag = val >> 3
    if (tag === 1) id = p.readVarint()
    else if (tag === 2) keys = packedUInts(p)
    else if (tag === 3) vals = packedUInts(p)
    else if (tag === 8) roles = packedUInts(p)
    else if (tag === 9) {
      const e = p.readVarint() + p.pos
      let r = 0
      while (p.pos < e) {
        r += p.readSVarint()
        memids.push(r)
      }
    } else if (tag === 10) types = packedUInts(p)
    else p.skip(val & 7)
  }
  const tags = new Map<string, string>()
  for (let i = 0; i < keys.length; i++) tags.set(blk.strings[keys[i]], blk.strings[vals[i]])
  return { id, tags, members: memids.map((m, i) => ({ id: m, type: types[i], role: blk.strings[roles[i]] ?? '' })) }
}

/** Empalma vías por sus extremos en anillos cerrados (los trozos que no cierran se dejan). */
function joinRings(ways: number[][]): number[][] {
  const out: number[][] = []
  const left = ways.map((w) => w.slice())
  while (left.length > 0) {
    let ring = left.shift()!
    while (ring[0] !== ring[ring.length - 1]) {
      const end = ring[ring.length - 1]
      const k = left.findIndex((w) => w[0] === end || w[w.length - 1] === end)
      if (k < 0) break
      const w = left.splice(k, 1)[0]
      ring = ring.concat((w[0] === end ? w : w.reverse()).slice(1))
    }
    if (ring.length >= 4 && ring[0] === ring[ring.length - 1]) out.push(ring)
  }
  return out
}

// ---------------------------------------------------------------------------

interface Feature {
  tags: Map<string, string>
  refs: number[]
  /** lat, lon alternados (null = falta algún nodo) */
  pts?: number[] | null
}

const features: Feature[] = []
const seenWays = new Set<number>()
const stats = { ways: 0, rels: 0, relOuters: 0, skippedShape: new Map<string, number>() }

function isBuilding(tags: Map<string, string>): boolean {
  const b = tags.get('building')
  const p = tags.get('building:part')
  return (b !== undefined && b !== 'no') || (p !== undefined && p !== 'no')
}

const t0 = Date.now()
for (const file of files) {
  console.log(`\n${file}`)
  const nodeBlobs = new Set<number>()
  const wayBlobs = new Set<number>()
  // relaciones multipolígono con roof:shape y sus vías exteriores
  const rels: Array<{ tags: Map<string, string>; outers: number[] }> = []
  const outerWays = new Map<number, number[] | null>() // vía → nodos (null hasta leerla)
  // 1) vías con roof:shape y relaciones multipolígono con roof:shape
  let nBlobs = 0
  for (const b of blobs(file)) {
    const blk = readBlock(b.data)
    const key = blk.strings.indexOf('roof:shape')
    if (++nBlobs % 2000 === 0) console.log(`  1/3 bloque ${nBlobs} · ${((Date.now() - t0) / 1000).toFixed(0)} s · ${features.length} tejados`)
    eachMessage(blk, (tag, s, e) => {
      if (tag === 2) nodeBlobs.add(b.offset)
      else if (tag === 3) {
        wayBlobs.add(b.offset)
        if (key < 0 || !wayHasKey(blk, s, e, key)) return
        const w = readWay(blk, s, e, true)
        if (!isBuilding(w.tags) || seenWays.has(w.id)) return
        const shape = w.tags.get('roof:shape')!
        if (SHAPES[shape] === undefined) {
          stats.skippedShape.set(shape, (stats.skippedShape.get(shape) ?? 0) + 1)
          return
        }
        seenWays.add(w.id)
        features.push({ tags: w.tags, refs: w.refs })
        stats.ways++
      } else if (tag === 4) {
        if (key < 0) return
        const r = readRelation(blk, s, e)
        if (r.tags.get('type') !== 'multipolygon' || !r.tags.has('roof:shape') || !isBuilding(r.tags)) return
        if (SHAPES[r.tags.get('roof:shape')!] === undefined) return
        stats.rels++
        const outers = r.members.filter((m) => m.type === 1 && (m.role === 'outer' || m.role === '')).map((m) => m.id)
        rels.push({ tags: r.tags, outers })
        for (const id of outers) outerWays.set(id, null)
      }
    })
  }
  // 2) las vías exteriores de esas relaciones; los anillos partidos en varias vías se empalman
  if (outerWays.size > 0) {
    for (const b of blobs(file, wayBlobs)) {
      const blk = readBlock(b.data)
      eachMessage(blk, (tag, s, e) => {
        if (tag !== 3) return
        const p = blk.pbf
        p.pos = s
        const v = p.readVarint()
        if (v >> 3 !== 1) return
        const id = p.readVarint()
        if (!outerWays.has(id)) return
        outerWays.set(id, readWay(blk, s, e, false).refs)
      })
    }
    for (const r of rels) {
      for (const ring of joinRings(r.outers.map((id) => outerWays.get(id)).filter((w): w is number[] => !!w && w.length >= 2))) {
        features.push({ tags: r.tags, refs: ring })
        stats.relOuters++
      }
    }
  }
  console.log(`  2/3 ${features.length} tejados · ${((Date.now() - t0) / 1000).toFixed(0)} s`)
  // 3) coordenadas de los nodos que hacen falta
  const need = new Map<number, number>()
  for (const f of features) for (const r of f.refs) if (!need.has(r)) need.set(r, -1)
  const coords: number[] = []
  for (const b of blobs(file, nodeBlobs)) {
    const blk = readBlock(b.data)
    eachMessage(blk, (tag, s, e) => {
      if (tag !== 2) return
      const p = blk.pbf
      p.pos = s
      let ids: number[] = []
      let lats: number[] = []
      let lons: number[] = []
      while (p.pos < e) {
        const val = p.readVarint()
        const t = val >> 3
        if (t === 1) ids = packedSInts(p)
        else if (t === 8) lats = packedSInts(p)
        else if (t === 9) lons = packedSInts(p)
        else p.skip(val & 7)
      }
      let id = 0
      let la = 0
      let lo = 0
      for (let i = 0; i < ids.length; i++) {
        id += ids[i]
        la += lats[i]
        lo += lons[i]
        if (need.get(id) === -1) {
          need.set(id, coords.length)
          coords.push(1e-9 * (blk.latOff + blk.granularity * la), 1e-9 * (blk.lonOff + blk.granularity * lo))
        }
      }
    })
  }
  // geometría de las vías de este volcado
  for (const f of features) {
    if (f.pts) continue
    const pts: number[] = []
    let ok = true
    for (const r of f.refs) {
      const k = need.get(r)
      if (k === undefined || k < 0) {
        ok = false
        break
      }
      pts.push(coords[k], coords[k + 1])
    }
    f.pts = ok ? pts : null
  }
  console.log(`  3/3 nodos · ${((Date.now() - t0) / 1000).toFixed(0)} s`)
}

// ---------------------------------------------------------------------------
// Registros

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

interface Rec {
  lat: number
  lon: number
  area: number
  height: number
  minHeight: number
  roofH: number
  dir: number
  shape: number
  flags: number
  angle: number
  rgb: [number, number, number]
  tx: number
  ty: number
}

const recs: Rec[] = []
let noGeom = 0
let tiny = 0
for (const f of features) {
  const pts = f.pts
  if (!pts || pts.length < 8) {
    noGeom++
    continue
  }
  // área y centroide en un plano local (m)
  const lat0 = pts[0]
  const lon0 = pts[1]
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180)
  const ky = 110574
  let a = 0
  let cx = 0
  let cy = 0
  const n = pts.length / 2 - 1 // el último repite el primero
  for (let i = 0; i < n; i++) {
    const x0 = (pts[2 * i + 1] - lon0) * kx
    const y0 = (pts[2 * i] - lat0) * ky
    const x1 = (pts[2 * i + 3] - lon0) * kx
    const y1 = (pts[2 * i + 2] - lat0) * ky
    const c = x0 * y1 - x1 * y0
    a += c
    cx += (x0 + x1) * c
    cy += (y0 + y1) * c
  }
  a /= 2
  if (Math.abs(a) < 4) {
    tiny++
    continue
  }
  cx /= 6 * a
  cy /= 6 * a
  const lat = lat0 + cy / ky
  const lon = lon0 + cx / kx
  const t = f.tags
  const shape = SHAPES[t.get('roof:shape')!]
  const height = parseMetres(t.get('height')) ?? parseMetres(t.get('building:height'))
  const minHeight = parseMetres(t.get('min_height'))
  let roofH = parseMetres(t.get('roof:height'))
  if (roofH === null) {
    const rl = Number((t.get('roof:levels') ?? '').replace(',', '.'))
    if (rl > 0 && rl < 30) roofH = rl * 3
  }
  const angle = Number((t.get('roof:angle') ?? '').replace(',', '.').replace('°', ''))
  const dir = parseDirection(t.get('roof:direction'))
  let flags = 0
  if (t.get('roof:orientation') === 'across') flags |= FLAG_ACROSS
  if (t.has('building:part') && !t.has('building')) flags |= FLAG_PART
  let rgb = parseColour(t.get('roof:colour') ?? t.get('roof:color'))
  if (rgb) flags |= FLAG_COLOUR
  else {
    const m = MATERIAL_COLOURS[(t.get('roof:material') ?? '').toLowerCase()]
    if (m) {
      rgb = parseColour(m)
      flags |= FLAG_MATERIAL
    }
  }
  const n14 = 2 ** 14
  recs.push({
    lat,
    lon,
    area: Math.abs(a),
    height: height !== null && height > 0 && height < 6000 ? height : 0,
    minHeight: minHeight !== null && minHeight > 0 && minHeight < 6000 ? minHeight : 0,
    roofH: roofH !== null && roofH > 0 && roofH < 6000 ? roofH : 0,
    dir: dir === null ? 0xffff : Math.round(dir) % 360,
    shape,
    flags,
    angle: angle > 0 && angle < 90 ? Math.round(angle) : 0,
    rgb: rgb ?? [0, 0, 0],
    tx: Math.floor(((lon + 180) / 360) * n14),
    ty: Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n14),
  })
}
recs.sort((p, q) => p.ty - q.ty || p.tx - q.tx)

const date = (() => {
  const d = new Date()
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate()
})()
const buf = new Uint8Array(HEADER + recs.length * RECORD)
const dv = new DataView(buf.buffer)
for (let i = 0; i < 4; i++) buf[i] = MAGIC.charCodeAt(i)
dv.setUint32(4, recs.length, true)
dv.setUint32(8, date, true)
recs.forEach((r, i) => {
  const o = HEADER + i * RECORD
  dv.setInt32(o, Math.round(r.lat * 1e7), true)
  dv.setInt32(o + 4, Math.round(r.lon * 1e7), true)
  dv.setFloat32(o + 8, r.area, true)
  dv.setUint16(o + 12, Math.min(65535, Math.round(r.height * 10)), true)
  dv.setUint16(o + 14, Math.min(65535, Math.round(r.minHeight * 10)), true)
  dv.setUint16(o + 16, Math.min(65535, Math.round(r.roofH * 10)), true)
  dv.setUint16(o + 18, r.dir, true)
  buf[o + 20] = r.shape
  buf[o + 21] = r.flags
  buf[o + 22] = r.angle
  buf[o + 23] = r.rgb[0]
  buf[o + 24] = r.rgb[1]
  buf[o + 25] = r.rgb[2]
})
const packed = zlibSync(buf, { level: 9 })
writeFileSync(OUT, packed)

const byShape = new Map<number, number>()
for (const r of recs) byShape.set(r.shape, (byShape.get(r.shape) ?? 0) + 1)
console.log(`\n${recs.length} tejados (${stats.ways} vías, ${stats.rels} relaciones → ${stats.relOuters} exteriores; ${noGeom} sin geometría, ${tiny} diminutos)`)
console.log('por forma:', Object.fromEntries([...byShape].map(([k, v]) => [Object.keys(SHAPES).find((s) => SHAPES[s] === k), v])))
console.log('formas sin uso:', Object.fromEntries([...stats.skippedShape].sort((a, b) => b[1] - a[1]).slice(0, 12)))
console.log(`${OUT}: ${(packed.length / 1e6).toFixed(2)} MB (${(buf.length / 1e6).toFixed(2)} MB sin comprimir) · ${((Date.now() - t0) / 1000).toFixed(0)} s`)
