// Formato de public/power-es.bin: los tendidos eléctricos (y las pocas líneas de teléfono
// mapeadas) de España sacados del volcado de OpenStreetMap por tools/power-lines.ts.
// Las teselas de OpenFreeMap no traen tendidos; fuera de España se piden a OpenInfraMap
// (powerSources.ts), que da el mismo tipo de vía.
//
// Fichero comprimido con zlib. Dentro:
//   'PWL1', u32 versión, u32 número de vías y, por cada vía:
//   u8 clase · u16 tensión (décimas de kV, 0 = sin dato) · u8 cables · u8 circuitos ·
//   u8 conductores por fase · u8 diseño de torre · varint nodos ·
//   i32 lat · i32 lon (millonésimas de grado) del primero y, para los demás, la diferencia en
//   varint zigzag · luego un u8 por nodo (tipo + material, + varint altura en dm si la lleva).

/** Clase de la vía. */
export const KIND = { line: 1, minor: 2, cable: 3, telecom: 4 } as const

/** Tipo de nodo (bits 0-2 del byte de nodo). */
export const NODE = { vertex: 0, tower: 1, pole: 2, portal: 3, terminal: 4 } as const

/** Material o estructura del apoyo (bits 3-5). */
export const MATERIAL = { unknown: 0, lattice: 1, tubular: 2, concrete: 3, wood: 4 } as const
export const HAS_HEIGHT = 0x40

/** Diseño de la torre (etiqueta design=* de OSM). */
export const DESIGN: Record<string, number> = {
  'one-level': 1,
  'two-level': 2,
  'three-level': 3,
  barrel: 3,
  donau: 4,
  donau_inverted: 4,
  delta: 5,
  'delta_two-level': 5,
  portal: 6,
  'portal_two-level': 6,
  'h-frame': 6,
  asymmetric: 7,
  triangle: 7,
  'y-frame': 8,
  flag: 9,
  monopolar: 1,
  'one-level_portal': 6,
}

export const MAGIC = 0x314c5750 // 'PWL1'
export const VERSION = 1

export interface PowerWay {
  /** identificador estable (para no repetirla al juntar teselas) */
  id: string
  kind: number
  /** tensión en kV (la mayor si lleva varias; 0 = sin dato) */
  kv: number
  cables: number
  circuits: number
  /** conductores por fase (dúplex = 2…) */
  wires: number
  design: number
  lat: Float64Array
  lon: Float64Array
  /** tipo | material << 3 por nodo */
  flags: Uint8Array
  /** altura del apoyo en m (0 = sin dato) */
  height: Float32Array
  /** caja (grados) */
  minLat: number
  minLon: number
  maxLat: number
  maxLon: number
}

// ---------------------------------------------------------------------------

export class ByteWriter {
  private buf = new Uint8Array(1 << 20)
  len = 0
  private room(n: number): void {
    if (this.len + n <= this.buf.length) return
    const b = new Uint8Array(Math.max(this.buf.length * 2, this.len + n))
    b.set(this.buf.subarray(0, this.len))
    this.buf = b
  }
  u8(v: number): void {
    this.room(1)
    this.buf[this.len++] = v & 255
  }
  u16(v: number): void {
    this.room(2)
    this.buf[this.len++] = v & 255
    this.buf[this.len++] = (v >> 8) & 255
  }
  u32(v: number): void {
    this.room(4)
    for (let i = 0; i < 4; i++) this.buf[this.len++] = (v >>> (8 * i)) & 255
  }
  i32(v: number): void {
    this.u32(v | 0)
  }
  varint(v: number): void {
    this.room(10)
    let x = v >>> 0
    while (x >= 0x80) {
      this.buf[this.len++] = (x & 0x7f) | 0x80
      x >>>= 7
    }
    this.buf[this.len++] = x
  }
  svarint(v: number): void {
    this.varint(v < 0 ? -2 * v - 1 : 2 * v)
  }
  bytes(): Uint8Array {
    return this.buf.slice(0, this.len)
  }
}

class ByteReader {
  pos = 0
  private readonly b: Uint8Array
  constructor(b: Uint8Array) {
    this.b = b
  }
  u8(): number {
    return this.b[this.pos++]
  }
  u16(): number {
    const v = this.b[this.pos] | (this.b[this.pos + 1] << 8)
    this.pos += 2
    return v
  }
  u32(): number {
    const b = this.b
    const p = this.pos
    this.pos += 4
    return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0
  }
  i32(): number {
    return this.u32() | 0
  }
  varint(): number {
    let v = 0
    let s = 0
    for (;;) {
      const c = this.b[this.pos++]
      v += (c & 0x7f) * 2 ** s
      if (c < 0x80) return v
      s += 7
    }
  }
  svarint(): number {
    const v = this.varint()
    return v % 2 === 1 ? -(v + 1) / 2 : v / 2
  }
}

/** Lee el fichero ya descomprimido. */
export function parsePowerWays(raw: Uint8Array, prefix = 'es'): PowerWay[] {
  const r = new ByteReader(raw)
  if (r.u32() !== MAGIC) throw new Error('power-es.bin: formato desconocido')
  const ver = r.u32()
  if (ver !== VERSION) throw new Error(`power-es.bin: versión ${ver}`)
  const n = r.u32()
  const out: PowerWay[] = []
  for (let w = 0; w < n; w++) {
    const kind = r.u8()
    const kv = r.u16() / 10
    const cables = r.u8()
    const circuits = r.u8()
    const wires = r.u8()
    const design = r.u8()
    const m = r.varint()
    const lat = new Float64Array(m)
    const lon = new Float64Array(m)
    let la = r.i32()
    let lo = r.i32()
    lat[0] = la * 1e-6
    lon[0] = lo * 1e-6
    for (let i = 1; i < m; i++) {
      la += r.svarint()
      lo += r.svarint()
      lat[i] = la * 1e-6
      lon[i] = lo * 1e-6
    }
    const flags = new Uint8Array(m)
    const height = new Float32Array(m)
    for (let i = 0; i < m; i++) {
      const f = r.u8()
      flags[i] = f & 0x3f
      if (f & HAS_HEIGHT) height[i] = r.varint() / 10
    }
    let minLat = Infinity
    let minLon = Infinity
    let maxLat = -Infinity
    let maxLon = -Infinity
    for (let i = 0; i < m; i++) {
      if (lat[i] < minLat) minLat = lat[i]
      if (lat[i] > maxLat) maxLat = lat[i]
      if (lon[i] < minLon) minLon = lon[i]
      if (lon[i] > maxLon) maxLon = lon[i]
    }
    out.push({ id: `${prefix}:${w}`, kind, kv, cables, circuits, wires, design, lat, lon, flags, height, minLat, minLon, maxLat, maxLon })
  }
  return out
}

/** Tensión en kV de la etiqueta voltage (varios valores con ';': la mayor). */
export function parseVoltageKV(v: string | undefined): number {
  if (!v) return 0
  let best = 0
  for (const part of v.split(/[;,]/)) {
    const x = Number.parseFloat(part.trim())
    if (Number.isFinite(x) && x > 0) best = Math.max(best, x >= 100 ? x / 1000 : x)
  }
  // (por debajo de 100 se entiende que alguien la ha mapeado en kV: "15" = 15 kV; "400" = 400 V)
  return Math.min(best, 6553)
}

/** Primer número de una etiqueta numérica (cables=6, circuits=2, height=34 m…). */
export function parseCount(v: string | undefined): number {
  if (!v) return 0
  let sum = 0
  for (const part of v.split(';')) {
    const x = Number.parseInt(part.trim(), 10)
    if (Number.isFinite(x) && x > 0) sum += x
  }
  return Math.min(sum, 255)
}

export function parseWires(v: string | undefined): number {
  switch ((v ?? '').split(';')[0].trim()) {
    case 'single':
      return 1
    case 'double':
      return 2
    case 'triple':
      return 3
    case 'quad':
      return 4
    case 'sexta':
    case 'hexa':
      return 6
    default:
      return 0
  }
}
