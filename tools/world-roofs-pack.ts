// Empaqueta los tejados de OpenStreetMap de todo el mundo que saca tools/world-roofs-overture.py (de
// Overture Maps, un TSV por archivo) en el fichero por zonas que lee el juego (src/world/worldRoofs.ts;
// formato en src/world/osmRoofFormat.ts, «ROW1»).
//
//   node --experimental-strip-types tools/world-roofs-pack.ts <carpeta de TSV> [fecha=AAAAMMDD] [out=…]
//
// El fichero resultante (tejados-mundo-AAAAMMDD.bin, ~150 MB) no va en el instalador: se sube como
// adjunto de la versión «datos-tejados» de GitHub y el juego pide por rangos, a través del servidor
// local (server/tejados.ts y src-tauri/src/tejados.rs), solo las zonas por donde se vuela. Después,
// poner su nombre en WORLD_ROOFS_FILE (src/world/worldRoofs.ts).
//
// Columnas del TSV (sin cabecera; vacío = sin dato): x0 y0 x1 y1 (rectángulo envolvente, grados)
// roof_shape height min_height roof_height roof_direction roof_orientation roof_color roof_material part

import { createReadStream, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { zlibSync } from 'fflate'
import { Color } from 'three'
import {
  FLAG_ACROSS,
  FLAG_COLOUR,
  FLAG_MATERIAL,
  FLAG_PART,
  MATERIAL_COLOURS,
  RECORD,
  SHAPES,
  WORLD_HEADER,
  WORLD_INDEX,
  WORLD_MAGIC,
  WORLD_Z,
} from '../src/world/osmRoofFormat.ts'

const args = process.argv.slice(2)
const dir = args.find((a) => !a.includes('='))
const arg = (k: string) => args.find((a) => a.startsWith(`${k}=`))?.slice(k.length + 1)
if (!dir) {
  console.error('uso: world-roofs-pack.ts <carpeta de TSV> [fecha=AAAAMMDD] [out=tejados-mundo-AAAAMMDD.bin]')
  process.exit(1)
}
const date = Number(arg('fecha') ?? new Date().toISOString().slice(0, 10).replace(/-/g, ''))
const OUT = arg('out') ?? `tejados-mundo-${date}.bin`

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

const num = (s: string | undefined) => {
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

// registros en un búfer que crece; clave de orden aparte (zona, y luego tesela z14 dentro de ella)
let cap = 1 << 20
let buf = new Uint8Array(cap * RECORD)
let keys = new Float64Array(cap)
let count = 0
const SHIFT = 14 - WORLD_Z
const stats = { lines: 0, unknown: new Map<string, number>(), tiny: 0, huge: 0 }

function grow(): void {
  cap *= 2
  const b = new Uint8Array(cap * RECORD)
  b.set(buf)
  buf = b
  const k = new Float64Array(cap)
  k.set(keys)
  keys = k
}

const t0 = Date.now()
const files = readdirSync(dir).filter((f) => f.endsWith('.csv') || f.endsWith('.tsv')).sort()
for (const f of files) {
  const rl = createInterface({ input: createReadStream(join(dir, f), 'utf8'), crlfDelay: Infinity })
  for await (const line of rl) {
    stats.lines++
    const c = line.split('\t')
    const x0 = Number(c[0])
    const y0 = Number(c[1])
    const x1 = Number(c[2])
    const y1 = Number(c[3])
    if (!(x1 >= x0 && y1 >= y0)) continue
    const raw = (c[4] ?? '').trim().toLowerCase()
    const shape = SHAPES[raw] ?? SHAPES[raw.replace(/_/g, '-')]
    if (shape === undefined) {
      stats.unknown.set(raw, (stats.unknown.get(raw) ?? 0) + 1)
      continue
    }
    const lat = (y0 + y1) / 2
    const lon = (x0 + x1) / 2
    const w = (x1 - x0) * 111320 * Math.cos((lat * Math.PI) / 180)
    const h = (y1 - y0) * 110574
    if (w * h < 4) {
      stats.tiny++
      continue
    }
    if (w > 6000 || h > 6000) {
      stats.huge++
      continue
    }
    if (count === cap) grow()
    const height = num(c[5])
    const minHeight = num(c[6])
    const roofH = num(c[7])
    const dir = num(c[8])
    let flags = 0
    if ((c[9] ?? '').trim().toLowerCase() === 'across') flags |= FLAG_ACROSS
    if (c[12]?.trim() === '1') flags |= FLAG_PART
    let rgb = parseColour(c[10])
    if (rgb) flags |= FLAG_COLOUR
    else {
      const m = MATERIAL_COLOURS[(c[11] ?? '').trim().toLowerCase()]
      if (m) {
        rgb = parseColour(m)
        flags |= FLAG_MATERIAL
      }
    }
    const o = count * RECORD
    const dv = new DataView(buf.buffer, o, RECORD)
    const ok = (v: number | null) => (v !== null && v > 0 && v < 6000 ? v : 0)
    dv.setInt32(0, Math.round(lat * 1e7), true)
    dv.setInt32(4, Math.round(lon * 1e7), true)
    dv.setUint16(8, Math.min(65535, Math.round(w * 10)), true)
    dv.setUint16(10, Math.min(65535, Math.round(h * 10)), true)
    dv.setUint16(12, Math.min(65535, Math.round(ok(height) * 10)), true)
    dv.setUint16(14, Math.min(65535, Math.round(ok(minHeight) * 10)), true)
    dv.setUint16(16, Math.min(65535, Math.round(ok(roofH) * 10)), true)
    dv.setUint16(18, dir === null ? 0xffff : Math.round(((dir % 360) + 360) % 360) % 360, true)
    buf[o + 20] = shape
    buf[o + 21] = flags
    buf[o + 22] = 0 // Overture no trae roof:angle
    if (rgb) {
      buf[o + 23] = rgb[0]
      buf[o + 24] = rgb[1]
      buf[o + 25] = rgb[2]
    }
    const n14 = 2 ** 14
    const tx = Math.min(n14 - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n14)))
    const ty = Math.min(n14 - 1, Math.max(0, Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n14)))
    const zone = (ty >> SHIFT) * 2 ** WORLD_Z + (tx >> SHIFT)
    const inner = (ty & ((1 << SHIFT) - 1)) * (1 << SHIFT) + (tx & ((1 << SHIFT) - 1))
    // clave de orden: zona, tesela dentro de la zona e índice (cabe en 52 bits mientras count < 2^24)
    keys[count] = (zone * 2 ** (2 * SHIFT) + inner) * 2 ** 24 + count
    count++
  }
  process.stdout.write(`\r${f}: ${count} tejados`)
}
if (count >= 2 ** 24) throw new Error('demasiados registros para la clave de orden')

const order = keys.subarray(0, count).sort()
// zonas
const zones: Array<{ key: number; first: number; end: number }> = []
for (let i = 0; i < count; i++) {
  const zone = Math.floor(order[i] / 2 ** 24 / 2 ** (2 * SHIFT))
  const last = zones[zones.length - 1]
  if (last && last.key === zone) last.end = i + 1
  else zones.push({ key: zone, first: i, end: i + 1 })
}
const blobs: Uint8Array[] = []
let maxZone = 0
for (const z of zones) {
  const m = z.end - z.first
  const raw = new Uint8Array(m * RECORD)
  for (let i = 0; i < m; i++) {
    const src = (order[z.first + i] % 2 ** 24) * RECORD
    raw.set(buf.subarray(src, src + RECORD), i * RECORD)
  }
  const packed = zlibSync(raw, { level: 9 })
  blobs.push(packed)
  maxZone = Math.max(maxZone, packed.length)
}
const head = new Uint8Array(WORLD_HEADER + zones.length * WORLD_INDEX)
const hv = new DataView(head.buffer)
for (let i = 0; i < 4; i++) head[i] = WORLD_MAGIC.charCodeAt(i)
hv.setUint32(4, date, true)
hv.setUint32(8, zones.length, true)
head[12] = WORLD_Z
let offset = head.length
zones.forEach((z, i) => {
  const o = WORLD_HEADER + i * WORLD_INDEX
  hv.setUint32(o, z.key, true)
  hv.setUint32(o + 4, offset, true)
  hv.setUint32(o + 8, blobs[i].length, true)
  hv.setUint32(o + 12, z.end - z.first, true)
  offset += blobs[i].length
})
const out = new Uint8Array(offset)
out.set(head)
let p = head.length
for (const b of blobs) {
  out.set(b, p)
  p += b.length
}
writeFileSync(OUT, out)
console.log(`\n${count} tejados en ${zones.length} zonas (${stats.lines} filas; ${stats.tiny} diminutos, ${stats.huge} enormes)`)
console.log('formas sin uso:', Object.fromEntries([...stats.unknown].sort((a, b) => b[1] - a[1]).slice(0, 12)))
console.log(`${OUT}: ${(out.length / 1e6).toFixed(1)} MB, zona mayor ${(maxZone / 1e6).toFixed(2)} MB · ${((Date.now() - t0) / 1000).toFixed(0)} s`)
