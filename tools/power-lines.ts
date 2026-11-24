// Saca de los volcados de OpenStreetMap (.osm.pbf de Geofabrik) los tendidos eléctricos aéreos
// (power=line, minor_line y los cable que van por el aire) y las líneas de teléfono mapeadas, con
// sus apoyos (torres, postes, pórticos) y los guarda en public/power-es.bin para el juego
// (src/world/powerSources.ts). Las teselas de OpenFreeMap no traen tendidos.
//
//   node --experimental-strip-types tools/power-lines.ts spain-latest.osm.pbf canary-islands-latest.osm.pbf
//   node --experimental-strip-types tools/power-lines.ts info <lat> <lon> [radio m]     (lo que hay en el .bin)
//
// Volcados: https://download.geofabrik.de/europe/spain-latest.osm.pbf (1,5 GB, sin Canarias) y
// https://download.geofabrik.de/africa/canary-islands-latest.osm.pbf. Tarda un par de minutos.

import { closeSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { PbfReader } from 'pbf'
import { unzlibSync, zlibSync } from 'fflate'
import { ByteWriter, DESIGN, HAS_HEIGHT, KIND, MAGIC, MATERIAL, NODE, parseCount, parsePowerWays, parseVoltageKV, parseWires, VERSION } from '../src/world/powerFormat.ts'

const OUT = 'public/power-es.bin'

if (process.argv[2] === 'info') {
  info(Number(process.argv[3]), Number(process.argv[4]), Number(process.argv[5] ?? 3000))
  process.exit(0)
}

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('uso: power-lines.ts <volcado.osm.pbf> [más volcados…]  |  power-lines.ts info <lat> <lon> [radio]')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Lectura del .osm.pbf (como tools/osm-roofs.ts)

interface Blob {
  offset: number
  data: Uint8Array
}

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
      if (!data) throw new Error(`bloque sin datos zlib/raw en ${offset}`)
      yield { offset, data }
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

function readWay(blk: Block, start: number, end: number): { id: number; tags: Map<string, string>; refs: number[] } {
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
    else if (tag === 2) keys = packedUInts(p)
    else if (tag === 3) vals = packedUInts(p)
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

// ---------------------------------------------------------------------------

/** Clase de la vía, o 0 si no es un tendido aéreo. */
function wayKind(tags: Map<string, string>): number {
  const loc = tags.get('location') ?? ''
  if (/underground|underwater|indoor|underground/.test(loc)) return 0
  if (tags.get('tunnel') && tags.get('tunnel') !== 'no') return 0
  const p = tags.get('power')
  if (p === 'line') {
    const l = tags.get('line')
    if (l === 'busbar' || l === 'bay') return 0
    return KIND.line
  }
  if (p === 'minor_line') return KIND.minor
  if (p === 'cable') return loc === 'overhead' ? KIND.cable : 0
  if (tags.get('telecom') === 'line' || tags.get('communication') === 'line') return KIND.telecom
  return 0
}

function nodeFlags(tags: Map<string, string> | undefined): { flags: number; height: number; design: number } {
  if (!tags) return { flags: 0, height: 0, design: 0 }
  const p = tags.get('power')
  let type: number = NODE.vertex
  if (p === 'tower') type = NODE.tower
  else if (p === 'pole' || tags.get('man_made') === 'utility_pole' || tags.get('telecom') === 'pole') type = NODE.pole
  else if (p === 'portal') type = NODE.portal
  else if (p === 'terminal' || p === 'substation' || p === 'transformer') type = NODE.terminal
  const s = `${tags.get('structure') ?? ''} ${tags.get('material') ?? ''} ${tags.get('tower:type') ?? ''}`.toLowerCase()
  let mat: number = MATERIAL.unknown
  if (/lattice/.test(s)) mat = MATERIAL.lattice
  else if (/wood/.test(s)) mat = MATERIAL.wood
  else if (/concrete/.test(s)) mat = MATERIAL.concrete
  else if (/tubular|solid|steel|metal/.test(s)) mat = MATERIAL.tubular
  let height = 0
  const h = tags.get('height')
  if (h) {
    const x = Number.parseFloat(h)
    if (Number.isFinite(x) && x > 3 && x < 400) height = x
  }
  return { flags: type | (mat << 3), height, design: DESIGN[(tags.get('design') ?? '').split(';')[0]] ?? 0 }
}

interface Way {
  kind: number
  kv: number
  cables: number
  circuits: number
  wires: number
  refs: number[]
}

const ways = new Map<number, Way>()
const nodeTags = new Map<number, Map<string, string>>()
const coords = new Map<number, [number, number]>()
const t0 = Date.now()
const secs = () => ((Date.now() - t0) / 1000).toFixed(0)

for (const file of files) {
  console.log(`\n${file}`)
  const nodeBlobs = new Set<number>()
  // 1) vías
  let nb = 0
  for (const b of blobs(file)) {
    const blk = readBlock(b.data)
    if (++nb % 2000 === 0) console.log(`  1/2 bloque ${nb} · ${secs()} s · ${ways.size} vías`)
    const hasKey = blk.strings.includes('power') || blk.strings.includes('telecom') || blk.strings.includes('communication')
    eachMessage(blk, (tag, s, e) => {
      if (tag === 2) nodeBlobs.add(b.offset)
      else if (tag === 3 && hasKey) {
        const w = readWay(blk, s, e)
        if (ways.has(w.id) || w.refs.length < 2) return
        const kind = wayKind(w.tags)
        if (!kind) return
        ways.set(w.id, {
          kind,
          kv: parseVoltageKV(w.tags.get('voltage')),
          cables: parseCount(w.tags.get('cables')),
          circuits: parseCount(w.tags.get('circuits')),
          wires: parseWires(w.tags.get('wires')),
          refs: w.refs,
        })
      }
    })
  }
  console.log(`  1/2 ${ways.size} vías · ${secs()} s`)
  // 2) nodos de esas vías (coordenadas y etiquetas)
  const need = new Set<number>()
  for (const w of ways.values()) for (const r of w.refs) if (!coords.has(r)) need.add(r)
  for (const b of blobs(file, nodeBlobs)) {
    const blk = readBlock(b.data)
    eachMessage(blk, (tag, s, e) => {
      if (tag !== 2) return
      const p = blk.pbf
      p.pos = s
      let ids: number[] = []
      let lats: number[] = []
      let lons: number[] = []
      let kv: number[] = []
      while (p.pos < e) {
        const val = p.readVarint()
        const t = val >> 3
        if (t === 1) ids = packedSInts(p)
        else if (t === 8) lats = packedSInts(p)
        else if (t === 9) lons = packedSInts(p)
        else if (t === 10) kv = packedUInts(p)
        else p.skip(val & 7)
      }
      let id = 0
      let la = 0
      let lo = 0
      let k = 0
      for (let i = 0; i < ids.length; i++) {
        id += ids[i]
        la += lats[i]
        lo += lons[i]
        const wanted = need.has(id)
        let tags: Map<string, string> | null = null
        // etiquetas del nodo: pares clave, valor terminados en 0
        while (k < kv.length && kv[k] !== 0) {
          if (wanted) {
            tags ??= new Map()
            tags.set(blk.strings[kv[k]], blk.strings[kv[k + 1]])
          }
          k += 2
        }
        k++
        if (!wanted) continue
        coords.set(id, [1e-9 * (blk.latOff + blk.granularity * la), 1e-9 * (blk.lonOff + blk.granularity * lo)])
        if (tags) nodeTags.set(id, tags)
      }
    })
  }
  console.log(`  2/2 ${coords.size} nodos · ${secs()} s`)
}

// ---------------------------------------------------------------------------
// Registros: las vías en orden espacial (teselas z10), para que comprima mejor

interface Rec {
  w: Way
  lat: number[]
  lon: number[]
  flags: number[]
  height: number[]
  design: number
  key: number
}

const recs: Rec[] = []
let missing = 0
const designs = new Map<number, number>()
for (const w of ways.values()) {
  const lat: number[] = []
  const lon: number[] = []
  const flags: number[] = []
  const height: number[] = []
  const votes = new Map<number, number>()
  for (const r of w.refs) {
    const c = coords.get(r)
    if (!c) continue
    // (nodo repetido seguido: fuera)
    if (lat.length && Math.round(c[0] * 1e6) === Math.round(lat[lat.length - 1] * 1e6) && Math.round(c[1] * 1e6) === Math.round(lon[lon.length - 1] * 1e6)) continue
    const f = nodeFlags(nodeTags.get(r))
    lat.push(c[0])
    lon.push(c[1])
    flags.push(f.flags)
    height.push(f.height)
    if (f.design) votes.set(f.design, (votes.get(f.design) ?? 0) + 1)
  }
  if (lat.length < 2) {
    missing++
    continue
  }
  let design = 0
  let best = 0
  for (const [d, n] of votes) if (n > best) [design, best] = [d, n]
  if (design) designs.set(design, (designs.get(design) ?? 0) + 1)
  const n10 = 1024
  const tx = Math.floor(((lon[0] + 180) / 360) * n10)
  const ty = Math.floor(((1 - Math.log(Math.tan((lat[0] * Math.PI) / 180) + 1 / Math.cos((lat[0] * Math.PI) / 180)) / Math.PI) / 2) * n10)
  recs.push({ w, lat, lon, flags, height, design, key: ty * n10 + tx })
}
recs.sort((a, b) => a.key - b.key)

const out = new ByteWriter()
out.u32(MAGIC)
out.u32(VERSION)
out.u32(recs.length)
const stats = { towers: 0, poles: 0, vertices: 0, byKind: new Map<number, number>() }
for (const r of recs) {
  out.u8(r.w.kind)
  out.u16(Math.round(r.w.kv * 10))
  out.u8(r.w.cables)
  out.u8(r.w.circuits)
  out.u8(r.w.wires)
  out.u8(r.design)
  out.varint(r.lat.length)
  let la = Math.round(r.lat[0] * 1e6)
  let lo = Math.round(r.lon[0] * 1e6)
  out.i32(la)
  out.i32(lo)
  for (let i = 1; i < r.lat.length; i++) {
    const a = Math.round(r.lat[i] * 1e6)
    const o = Math.round(r.lon[i] * 1e6)
    out.svarint(a - la)
    out.svarint(o - lo)
    la = a
    lo = o
  }
  for (let i = 0; i < r.lat.length; i++) {
    const h = r.height[i]
    out.u8(r.flags[i] | (h > 0 ? HAS_HEIGHT : 0))
    if (h > 0) out.varint(Math.round(h * 10))
    const t = r.flags[i] & 7
    if (t === NODE.tower) stats.towers++
    else if (t === NODE.pole) stats.poles++
    else stats.vertices++
  }
  stats.byKind.set(r.w.kind, (stats.byKind.get(r.w.kind) ?? 0) + 1)
}
const raw = out.bytes()
const z = zlibSync(raw, { level: 9 })
writeFileSync(OUT, z)
console.log(`\n${recs.length} vías (${missing} sin nodos) · ${stats.towers} torres · ${stats.poles} postes · ${stats.vertices} vértices sin apoyo`)
console.log('por clase', Object.fromEntries([...stats.byKind].map(([k, n]) => [Object.keys(KIND).find((x) => KIND[x as keyof typeof KIND] === k), n])))
console.log('diseños', Object.fromEntries(designs))
console.log(`${OUT}: ${(raw.length / 1e6).toFixed(2)} MB → ${(z.length / 1e6).toFixed(2)} MB comprimido · ${secs()} s`)

// ---------------------------------------------------------------------------

function info(lat: number, lon: number, radius: number): void {
  const all = parsePowerWays(unzlibSync(new Uint8Array(readFileSync(OUT))))
  const ky = 110574
  const kx = 111320 * Math.cos((lat * Math.PI) / 180)
  const near = all.filter((w) => {
    for (let i = 0; i < w.lat.length; i++) if (Math.hypot((w.lat[i] - lat) * ky, (w.lon[i] - lon) * kx) < radius) return true
    return false
  })
  console.log(`${all.length} vías en el fichero; ${near.length} a menos de ${radius} m de ${lat}, ${lon}`)
  for (const w of near) {
    let len = 0
    let maxSpan = 0
    for (let i = 1; i < w.lat.length; i++) {
      const d = Math.hypot((w.lat[i] - w.lat[i - 1]) * ky, (w.lon[i] - w.lon[i - 1]) * kx)
      len += d
      maxSpan = Math.max(maxSpan, d)
    }
    const types = [0, 0, 0, 0, 0]
    for (const f of w.flags) types[f & 7]++
    const kind = Object.keys(KIND).find((x) => KIND[x as keyof typeof KIND] === w.kind)
    console.log(
      `  ${w.id.padEnd(9)} ${String(kind).padEnd(7)} ${String(w.kv || '?').padStart(5)} kV  cables ${w.cables || '?'} circ ${w.circuits || '?'} haz ${w.wires || '?'} diseño ${w.design}` +
        `  ${(len / 1000).toFixed(2)} km, vano máx ${maxSpan.toFixed(0)} m · torres ${types[1]} postes ${types[2]} pórticos ${types[3]} vértices ${types[0]}`,
    )
  }
}
