// Geometría de los puentes: constructor de mallas (cuadriláteros con normal de cara, color por
// vértice y coordenadas de calzada para las marcas viales del shader) y las formas de choque
// que acompañan a cada pieza (tableros, cajas, tubos y paños verticales), en el marco local de
// la tesela que las dibuja.

import { BufferAttribute, BufferGeometry, Color, Vector3 } from 'three'
import type { GeoFrame } from './GeoFrame.ts'
import { offsetGeo, type Chain } from './bridgeChains.ts'

// ---------------------------------------------------------------------------
// Formas de choque (coordenadas locales de la tesela: x este, y arriba, z sur)
// ---------------------------------------------------------------------------

/** Tramo recto de tablero: calzada entre (x0,z0) y (x1,z1), de y (arriba) a b (abajo) en cada extremo. */
export interface SpanPrim {
  k: 0
  x0: number
  z0: number
  x1: number
  z1: number
  y0: number
  y1: number
  b0: number
  b1: number
  hw: number
  /** altura de los pretiles (m) */
  rail: number
}
/** Caja vertical orientada (pilas, torres, estribos): centro, dirección, semilados y alturas. */
export interface BoxPrim {
  k: 1
  cx: number
  cz: number
  ux: number
  uz: number
  ha: number
  hb: number
  y0: number
  y1: number
}
/** Tubo entre dos puntos (cables, arcos, barras). */
export interface TubePrim {
  k: 2
  ax: number
  ay: number
  az: number
  bx: number
  by: number
  bz: number
  r: number
}
/** Paño vertical entre dos puntos en planta, con base y coronación en cada extremo (péndolas, tirantes, celosías). */
export interface WallPrim {
  k: 3
  x0: number
  z0: number
  x1: number
  z1: number
  b0: number
  b1: number
  t0: number
  t1: number
  /** semiespesor (m) */
  hw: number
}
export type Prim = SpanPrim | BoxPrim | TubePrim | WallPrim

/** ¿Está el punto local (x, y, z) dentro de la forma? */
export function primHit(p: Prim, x: number, y: number, z: number): boolean {
  switch (p.k) {
    case 0: {
      const dx = p.x1 - p.x0
      const dz = p.z1 - p.z0
      const l2 = dx * dx + dz * dz
      if (l2 < 1e-6) return false
      const t = ((x - p.x0) * dx + (z - p.z0) * dz) / l2
      if (t < -0.02 || t > 1.02) return false
      const off = Math.abs(((x - p.x0) * dz - (z - p.z0) * dx) / Math.sqrt(l2))
      if (off > p.hw) return false
      const top = p.y0 + (p.y1 - p.y0) * t
      const bot = p.b0 + (p.b1 - p.b0) * t
      // la losa (por debajo de la calzada: encima se rueda) o los pretiles
      if (y > bot && y < top - 0.15) return true
      return off > p.hw - 0.5 && y >= top - 0.15 && y < top + p.rail
    }
    case 1: {
      if (y < p.y0 || y > p.y1) return false
      const dx = x - p.cx
      const dz = z - p.cz
      return Math.abs(dx * p.ux + dz * p.uz) <= p.ha && Math.abs(dx * p.uz - dz * p.ux) <= p.hb
    }
    case 2: {
      const dx = p.bx - p.ax
      const dy = p.by - p.ay
      const dz = p.bz - p.az
      const l2 = dx * dx + dy * dy + dz * dz
      const t = l2 > 0 ? Math.min(1, Math.max(0, ((x - p.ax) * dx + (y - p.ay) * dy + (z - p.az) * dz) / l2)) : 0
      const ex = x - p.ax - dx * t
      const ey = y - p.ay - dy * t
      const ez = z - p.az - dz * t
      return ex * ex + ey * ey + ez * ez <= p.r * p.r
    }
    case 3: {
      const dx = p.x1 - p.x0
      const dz = p.z1 - p.z0
      const l2 = dx * dx + dz * dz
      if (l2 < 1e-6) return false
      const t = ((x - p.x0) * dx + (z - p.z0) * dz) / l2
      if (t < 0 || t > 1) return false
      if (Math.abs(((x - p.x0) * dz - (z - p.z0) * dx) / Math.sqrt(l2)) > p.hw) return false
      return y >= p.b0 + (p.b1 - p.b0) * t && y <= p.t0 + (p.t1 - p.t0) * t
    }
  }
}

/** Rectángulo en planta que ocupa la forma: [minX, minZ, maxX, maxZ]. */
export function primBounds(p: Prim): [number, number, number, number] {
  switch (p.k) {
    case 0:
    case 3:
      return [Math.min(p.x0, p.x1) - p.hw, Math.min(p.z0, p.z1) - p.hw, Math.max(p.x0, p.x1) + p.hw, Math.max(p.z0, p.z1) + p.hw]
    case 1: {
      const r = Math.hypot(p.ha, p.hb)
      return [p.cx - r, p.cz - r, p.cx + r, p.cz + r]
    }
    case 2:
      return [Math.min(p.ax, p.bx) - p.r, Math.min(p.az, p.bz) - p.r, Math.max(p.ax, p.bx) + p.r, Math.max(p.az, p.bz) + p.r]
  }
}

// ---------------------------------------------------------------------------
// Constructor de mallas
// ---------------------------------------------------------------------------

const _ab = new Vector3()
const _ad = new Vector3()
const _n = new Vector3()

export class MeshBuilder {
  private pos = new Float32Array(3 * 4096)
  private nor = new Float32Array(3 * 4096)
  private col = new Float32Array(3 * 4096)
  private rd = new Float32Array(4 * 4096)
  private n = 0
  /** triángulos emitidos */
  get triangles(): number {
    return this.n / 3
  }

  private reserve(extra: number): void {
    if ((this.n + extra) * 3 <= this.pos.length) return
    const cap = Math.max(this.pos.length * 2, (this.n + extra) * 3)
    const grow = (a: Float32Array, size: number) => {
      const b = new Float32Array(size)
      b.set(a)
      return b
    }
    this.pos = grow(this.pos, cap)
    this.nor = grow(this.nor, cap)
    this.col = grow(this.col, cap)
    this.rd = grow(this.rd, (cap / 3) * 4)
  }

  private vert(p: Vector3, n: Vector3, c: Color, u: number, v: number, kind: number, hw: number): void {
    const i = this.n++
    this.pos[3 * i] = p.x
    this.pos[3 * i + 1] = p.y
    this.pos[3 * i + 2] = p.z
    this.nor[3 * i] = n.x
    this.nor[3 * i + 1] = n.y
    this.nor[3 * i + 2] = n.z
    this.col[3 * i] = c.r
    this.col[3 * i + 1] = c.g
    this.col[3 * i + 2] = c.b
    this.rd[4 * i] = u
    this.rd[4 * i + 1] = v
    this.rd[4 * i + 2] = kind
    this.rd[4 * i + 3] = hw
  }

  /**
   * Cuadrilátero a-b-c-d con la cara hacia fuera respecto de `inside` (un punto del interior de
   * la pieza). `marks` = coordenadas de calzada (u lateral y v a lo largo, en m, de a, b, c y d),
   * tipo de marcas y semiancho, para la superficie de rodadura.
   */
  quad(a: Vector3, b: Vector3, c: Vector3, d: Vector3, col: Color, inside: Vector3, marks?: { uv: number[]; kind: number; hw: number }): void {
    _ab.subVectors(b, a)
    _ad.subVectors(d, a)
    _n.crossVectors(_ab, _ad)
    if (_n.lengthSq() < 1e-12) {
      // a y d coinciden (triángulo degenerado en ese lado): la otra diagonal
      _ad.subVectors(c, a)
      _n.crossVectors(_ab, _ad)
      if (_n.lengthSq() < 1e-12) return
    }
    _n.normalize()
    const flip = _n.x * (a.x - inside.x) + _n.y * (a.y - inside.y) + _n.z * (a.z - inside.z) < 0
    if (flip) _n.negate()
    this.reserve(6)
    const uv = marks?.uv
    const kind = marks?.kind ?? 0
    const hw = marks?.hw ?? 0
    const order = flip ? [0, 3, 2, 0, 2, 1] : [0, 1, 2, 0, 2, 3]
    const pts = [a, b, c, d]
    for (const k of order) this.vert(pts[k], _n, col, uv ? uv[2 * k] : 0, uv ? uv[2 * k + 1] : 0, kind, hw)
  }

  /** Caja vertical orientada: centro (cx, cz), eje (ux, uz) unitario, semilados ha (a lo largo) y hb. */
  box(cx: number, cz: number, ux: number, uz: number, ha: number, hb: number, y0: number, y1: number, col: Color, top = true): void {
    const vx = -uz
    const vz = ux
    const c = (sa: number, sb: number, y: number) => new Vector3(cx + ux * ha * sa + vx * hb * sb, y, cz + uz * ha * sa + vz * hb * sb)
    const inside = new Vector3(cx, (y0 + y1) / 2, cz)
    const ring: Array<[number, number]> = [
      [1, 1],
      [-1, 1],
      [-1, -1],
      [1, -1],
    ]
    for (let i = 0; i < 4; i++) {
      const [a0, b0] = ring[i]
      const [a1, b1] = ring[(i + 1) % 4]
      this.quad(c(a0, b0, y0), c(a1, b1, y0), c(a1, b1, y1), c(a0, b0, y1), col, inside)
    }
    if (top) this.quad(c(1, 1, y1), c(-1, 1, y1), c(-1, -1, y1), c(1, -1, y1), col, inside)
  }

  /** Barra de sección rectangular (w a los lados, h en vertical) entre dos puntos. */
  beam(a: Vector3, b: Vector3, w: number, h: number, col: Color): void {
    const dir = new Vector3().subVectors(b, a)
    const len = dir.length()
    if (len < 1e-4) return
    dir.divideScalar(len)
    const side = new Vector3(dir.z, 0, -dir.x)
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0)
    side.normalize()
    const up = new Vector3().crossVectors(side, dir).normalize()
    const corner = (p: Vector3, s: number, u: number) => p.clone().addScaledVector(side, (s * w) / 2).addScaledVector(up, (u * h) / 2)
    const inside = new Vector3().addVectors(a, b).multiplyScalar(0.5)
    const ring: Array<[number, number]> = [
      [1, 1],
      [-1, 1],
      [-1, -1],
      [1, -1],
    ]
    for (let i = 0; i < 4; i++) {
      const [s0, u0] = ring[i]
      const [s1, u1] = ring[(i + 1) % 4]
      this.quad(corner(a, s0, u0), corner(a, s1, u1), corner(b, s1, u1), corner(b, s0, u0), col, inside)
    }
  }

  build(): BufferGeometry | null {
    if (this.n === 0) return null
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(this.pos.slice(0, this.n * 3), 3))
    g.setAttribute('normal', new BufferAttribute(this.nor.slice(0, this.n * 3), 3))
    g.setAttribute('color', new BufferAttribute(this.col.slice(0, this.n * 3), 3))
    g.setAttribute('rd', new BufferAttribute(this.rd.slice(0, this.n * 4), 4))
    g.computeBoundingSphere()
    g.computeBoundingBox()
    return g
  }
}

// ---------------------------------------------------------------------------
// Una cadena en el marco de una tesela
// ---------------------------------------------------------------------------

/**
 * Posición de cada estación de una cadena en el marco local de una tesela: centro de la
 * calzada (px, py, pz) y vector «a la derecha» en planta (rx, rz) por metro de desfase.
 */
export class ChainFrame {
  readonly px: Float64Array
  readonly py: Float64Array
  readonly pz: Float64Array
  readonly rx: Float32Array
  readonly rz: Float32Array
  readonly chain: Chain

  constructor(chain: Chain, frame: GeoFrame) {
    this.chain = chain
    const n = chain.n
    this.px = new Float64Array(n)
    this.py = new Float64Array(n)
    this.pz = new Float64Array(n)
    this.rx = new Float32Array(n)
    this.rz = new Float32Array(n)
    const v = new Vector3()
    for (let i = 0; i < n; i++) {
      frame.geoToWorld(chain.lat[i], chain.lon[i], chain.deck[i], v)
      this.px[i] = v.x
      this.py[i] = v.y
      this.pz[i] = v.z
      const [la, lo] = offsetGeo(chain, i, 1)
      frame.geoToWorld(la, lo, chain.deck[i], v)
      this.rx[i] = v.x - this.px[i]
      this.rz[i] = v.z - this.pz[i]
    }
  }

  /** Punto de la sección en la estación i: `off` m a la derecha del eje y `dy` m sobre la calzada. */
  at(i: number, off: number, dy: number, out: Vector3): Vector3 {
    return out.set(this.px[i] + this.rx[i] * off, this.py[i] + dy, this.pz[i] + this.rz[i] * off)
  }

  /** Lo mismo en una posición s cualquiera de la cadena (interpolando entre estaciones). */
  atS(s: number, off: number, dy: number, out: Vector3): Vector3 {
    const c = this.chain
    let lo = 0
    let hi = c.n - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (c.s[mid] <= s) lo = mid
      else hi = mid
    }
    const d = c.s[hi] - c.s[lo]
    const t = d > 0 ? Math.min(1, Math.max(0, (s - c.s[lo]) / d)) : 0
    const rx = this.rx[lo] + (this.rx[hi] - this.rx[lo]) * t
    const rz = this.rz[lo] + (this.rz[hi] - this.rz[lo]) * t
    return out.set(
      this.px[lo] + (this.px[hi] - this.px[lo]) * t + rx * off,
      this.py[lo] + (this.py[hi] - this.py[lo]) * t + dy,
      this.pz[lo] + (this.pz[hi] - this.pz[lo]) * t + rz * off,
    )
  }

  /** Dirección de avance unitaria en planta en la posición s: [x, z]. */
  dirAt(s: number): [number, number] {
    const c = this.chain
    let lo = 0
    let hi = c.n - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (c.s[mid] <= s) lo = mid
      else hi = mid
    }
    const dx = this.px[hi] - this.px[lo]
    const dz = this.pz[hi] - this.pz[lo]
    const l = Math.hypot(dx, dz) || 1
    return [dx / l, dz / l]
  }
}
