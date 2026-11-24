// Modelos 3D de los vehículos del tráfico, hechos por código y de pocos polígonos (puede haber
// miles a la vez): perfil lateral extruido a lo ancho con el techo algo más estrecho, lunas
// oscuras, ruedas y, en camiones y autobuses, caja o ventanas corridas.
//
// Ejes del modelo: x hacia delante (frontal en +largo/2), y arriba (suelo en 0), z hacia la
// derecha. Atributo `paint`: 1 = toma el color de la carrocería de cada vehículo (instanceColor),
// 0 = color fijo (lunas, ruedas, faros, caja).

import { BufferAttribute, BufferGeometry, Color, ShapeUtils, Vector2 } from 'three'
import { VTYPES } from './sim.ts'

type P2 = [number, number]

const GLASS = new Color(0x1b2229)
const TYRE = new Color(0x1a1a1a)
const RIM = new Color(0x8a8d90)
const DARK = new Color(0x2a2b2d)
const LAMP = new Color(0xe8e4d8)
const TAIL = new Color(0x7a1012)
const BOX = new Color(0xe6e6e2)

class Builder {
  pos: number[] = []
  col: number[] = []
  paint: number[] = []
  tri(a: number[], b: number[], c: number[], color: Color, paint: number): void {
    this.pos.push(...a, ...b, ...c)
    for (let i = 0; i < 3; i++) {
      this.col.push(color.r, color.g, color.b)
      this.paint.push(paint)
    }
  }
  quad(a: number[], b: number[], c: number[], d: number[], color: Color, paint: number): void {
    this.tri(a, b, c, color, paint)
    this.tri(a, c, d, color, paint)
  }
  /** caja alineada con los ejes */
  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, color: Color, paint: number): void {
    const p = (x: number, y: number, z: number) => [x, y, z]
    // +x, -x, +y, -y, +z, -z (vértices en sentido antihorario visto desde fuera)
    this.quad(p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), p(x1, y0, z1), color, paint)
    this.quad(p(x0, y0, z1), p(x0, y1, z1), p(x0, y1, z0), p(x0, y0, z0), color, paint)
    this.quad(p(x0, y1, z0), p(x0, y1, z1), p(x1, y1, z1), p(x1, y1, z0), color, paint)
    this.quad(p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1), color, paint)
    this.quad(p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1), color, paint)
    this.quad(p(x1, y0, z0), p(x0, y0, z0), p(x0, y1, z0), p(x1, y1, z0), color, paint)
  }
  /**
   * Perfil lateral (x, y en sentido antihorario visto desde la derecha) extruido entre -w/2 y w/2;
   * por encima de `belt` las caras laterales se estrechan `tumble` metros por metro de subida.
   * `glass(i)`: el lado i del perfil (de i a i+1) es luna.
   */
  extrude(prof: P2[], w: number, belt: number, tumble: number, color: Color, paint: number, glass: (i: number) => boolean = () => false): void {
    const half = (y: number) => w / 2 - Math.max(0, y - belt) * tumble
    const n = prof.length
    // laterales
    const tris = ShapeUtils.triangulateShape(prof.map(([x, y]) => new Vector2(x, y)), [])
    for (const [a, b, c] of tris) {
      const A = prof[a]
      const B = prof[b]
      const C = prof[c]
      this.tri([A[0], A[1], half(A[1])], [B[0], B[1], half(B[1])], [C[0], C[1], half(C[1])], color, paint)
      this.tri([C[0], C[1], -half(C[1])], [B[0], B[1], -half(B[1])], [A[0], A[1], -half(A[1])], color, paint)
    }
    // contorno
    for (let i = 0; i < n; i++) {
      const A = prof[i]
      const B = prof[(i + 1) % n]
      const g = glass(i)
      this.quad([A[0], A[1], -half(A[1])], [B[0], B[1], -half(B[1])], [B[0], B[1], half(B[1])], [A[0], A[1], half(A[1])], g ? GLASS : color, g ? 0 : paint)
    }
  }
  /** luna lateral: polígono pegado al costado (por fuera, 1 cm) a los dos lados */
  sideWindow(poly: P2[], w: number, belt: number, tumble: number): void {
    const half = (y: number) => w / 2 - Math.max(0, y - belt) * tumble + 0.012
    const tris = ShapeUtils.triangulateShape(poly.map(([x, y]) => new Vector2(x, y)), [])
    for (const [a, b, c] of tris) {
      const A = poly[a]
      const B = poly[b]
      const C = poly[c]
      this.tri([A[0], A[1], half(A[1])], [B[0], B[1], half(B[1])], [C[0], C[1], half(C[1])], GLASS, 0)
      this.tri([C[0], C[1], -half(C[1])], [B[0], B[1], -half(B[1])], [A[0], A[1], -half(A[1])], GLASS, 0)
    }
  }
  /** rueda (cilindro de eje z) en (x, r) a un lado z */
  wheel(x: number, r: number, z: number, width: number): void {
    const seg = 10
    const z0 = z - width / 2
    const z1 = z + width / 2
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2
      const a1 = ((i + 1) / seg) * Math.PI * 2
      const p0 = [x + Math.cos(a0) * r, r + Math.sin(a0) * r]
      const p1 = [x + Math.cos(a1) * r, r + Math.sin(a1) * r]
      this.quad([p0[0], p0[1], z0], [p1[0], p1[1], z0], [p1[0], p1[1], z1], [p0[0], p0[1], z1], TYRE, 0)
      // tapacubos en las dos caras
      const zo = z > 0 ? z1 : z0
      const rr = 0.6
      const q0 = [x + Math.cos(a0) * r * rr, r + Math.sin(a0) * r * rr]
      const q1 = [x + Math.cos(a1) * r * rr, r + Math.sin(a1) * r * rr]
      if (z > 0) {
        this.tri([x, r, zo], [q0[0], q0[1], zo], [q1[0], q1[1], zo], RIM, 0)
        this.tri([p0[0], p0[1], zo], [p1[0], p1[1], zo], [q1[0], q1[1], zo], TYRE, 0)
        this.tri([p0[0], p0[1], zo], [q1[0], q1[1], zo], [q0[0], q0[1], zo], TYRE, 0)
      } else {
        this.tri([x, r, zo], [q1[0], q1[1], zo], [q0[0], q0[1], zo], RIM, 0)
        this.tri([p0[0], p0[1], zo], [q1[0], q1[1], zo], [p1[0], p1[1], zo], TYRE, 0)
        this.tri([p0[0], p0[1], zo], [q0[0], q0[1], zo], [q1[0], q1[1], zo], TYRE, 0)
      }
    }
  }
  /** prisma vertical de un polígono de planta (x, z en sentido antihorario visto desde arriba) */
  prism(poly: P2[], y0: number, y1: number, color: Color, paint: number, sideColor?: Color): void {
    const n = poly.length
    // tapa: visto desde arriba con x adelante y z a la derecha, antihorario en (x, -z)
    const tris = ShapeUtils.triangulateShape(poly.map(([x, z]) => new Vector2(x, -z)), [])
    for (const [a, b, c] of tris) this.tri([poly[a][0], y1, poly[a][1]], [poly[b][0], y1, poly[b][1]], [poly[c][0], y1, poly[c][1]], color, paint)
    for (let i = 0; i < n; i++) {
      const A = poly[i]
      const B = poly[(i + 1) % n]
      this.quad([A[0], y0, A[1]], [A[0], y1, A[1]], [B[0], y1, B[1]], [B[0], y0, B[1]], sideColor ?? color, sideColor ? 0 : paint)
    }
  }
  axle(x: number, r: number, w: number, tw = 0.24): void {
    this.wheel(x, r, w / 2 - tw / 2 - 0.02, tw)
    this.wheel(x, r, -(w / 2 - tw / 2 - 0.02), tw)
  }
  build(len: number): BufferGeometry {
    // centrar a lo largo: x de -len/2 a len/2
    const pos = new Float32Array(this.pos)
    for (let i = 0; i < pos.length; i += 3) pos[i] -= len / 2
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(pos, 3))
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3))
    g.setAttribute('paint', new BufferAttribute(new Float32Array(this.paint), 1))
    g.computeVertexNormals()
    g.computeBoundingSphere()
    return g
  }
}

/** faros y pilotos pintados (se ven de día de cerca) */
function lamps(b: Builder, len: number, w: number, yHead: number, yTail: number, h = 0.14): void {
  const zw = w / 2 - 0.12
  for (const s of [-1, 1]) {
    const z0 = s * (zw - 0.32)
    const z1 = s * zw
    // faro (frontal)
    b.quad([len + 0.006, yHead - h / 2, Math.min(z0, z1)], [len + 0.006, yHead + h / 2, Math.min(z0, z1)], [len + 0.006, yHead + h / 2, Math.max(z0, z1)], [len + 0.006, yHead - h / 2, Math.max(z0, z1)], LAMP, 0)
    // piloto (trasera)
    b.quad([-0.006, yTail - h / 2, Math.max(z0, z1)], [-0.006, yTail + h / 2, Math.max(z0, z1)], [-0.006, yTail + h / 2, Math.min(z0, z1)], [-0.006, yTail - h / 2, Math.min(z0, z1)], TAIL, 0)
  }
}

function car(): BufferGeometry {
  const T = VTYPES[0]
  const L = T.len
  const W = T.width
  const b = new Builder()
  const prof: P2[] = [
    [0.05, 0.3],
    [L - 0.08, 0.3],
    [L, 0.5],
    [L, 0.7],
    [L - 0.15, 0.86],
    [3.2, 0.98],
    [2.72, 1.42],
    [1.45, 1.44],
    [0.92, 1.02],
    [0.12, 0.98],
    [0, 0.82],
    [0, 0.45],
  ]
  b.extrude(prof, W, 0.98, 0.32, new Color(1, 1, 1), 1, (i) => i === 5 || i === 7)
  b.sideWindow([[1.0, 1.02], [3.08, 1.0], [2.66, 1.36], [1.5, 1.38]], W, 0.98, 0.32)
  b.axle(0.88, 0.32, W)
  b.axle(L - 0.9, 0.32, W)
  lamps(b, L, W, 0.72, 0.86)
  return b.build(L)
}

function hatch(): BufferGeometry {
  const T = VTYPES[1]
  const L = T.len
  const W = T.width
  const b = new Builder()
  const prof: P2[] = [
    [0.05, 0.3],
    [L - 0.08, 0.3],
    [L, 0.5],
    [L, 0.7],
    [L - 0.15, 0.86],
    [2.85, 0.98],
    [2.3, 1.46],
    [0.45, 1.48],
    [0.08, 1.02],
    [0, 0.9],
    [0, 0.45],
  ]
  b.extrude(prof, W, 0.98, 0.3, new Color(1, 1, 1), 1, (i) => i === 5 || i === 7)
  b.sideWindow([[0.55, 1.03], [2.75, 1.0], [2.25, 1.4], [0.55, 1.42]], W, 0.98, 0.3)
  b.axle(0.72, 0.31, W)
  b.axle(L - 0.82, 0.31, W)
  lamps(b, L, W, 0.72, 0.95)
  return b.build(L)
}

function suv(): BufferGeometry {
  const T = VTYPES[2]
  const L = T.len
  const W = T.width
  const b = new Builder()
  const prof: P2[] = [
    [0.05, 0.38],
    [L - 0.08, 0.38],
    [L, 0.6],
    [L, 0.92],
    [L - 0.25, 1.06],
    [3.4, 1.15],
    [2.95, 1.7],
    [0.25, 1.72],
    [0.05, 1.18],
    [0, 1.05],
    [0, 0.5],
  ]
  b.extrude(prof, W, 1.15, 0.22, new Color(1, 1, 1), 1, (i) => i === 5 || i === 7)
  b.sideWindow([[0.3, 1.2], [3.3, 1.18], [2.9, 1.64], [0.32, 1.66]], W, 1.15, 0.22)
  b.axle(0.95, 0.37, W, 0.27)
  b.axle(L - 1.0, 0.37, W, 0.27)
  lamps(b, L, W, 0.92, 1.05)
  return b.build(L)
}

function van(): BufferGeometry {
  const T = VTYPES[3]
  const L = T.len
  const W = T.width
  const b = new Builder()
  const prof: P2[] = [
    [0.05, 0.36],
    [L - 0.08, 0.36],
    [L, 0.55],
    [L, 0.95],
    [L - 0.5, 1.15],
    [4.15, 1.45],
    [3.7, 2.38],
    [0.08, 2.42],
    [0, 2.3],
    [0, 0.5],
  ]
  b.extrude(prof, W, 1.45, 0.05, new Color(1, 1, 1), 1, (i) => i === 5)
  b.sideWindow([[3.5, 1.5], [4.08, 1.5], [3.66, 2.2], [3.5, 2.22]], W, 1.45, 0.05)
  b.axle(0.95, 0.35, W, 0.25)
  b.axle(L - 1.15, 0.35, W, 0.25)
  lamps(b, L, W, 0.95, 1.0)
  return b.build(L)
}

function truck(): BufferGeometry {
  const T = VTYPES[4]
  const L = T.len
  const W = T.width
  const b = new Builder()
  // cabina delante
  const cab: P2[] = [
    [L - 2.3, 0.55],
    [L - 0.05, 0.55],
    [L, 0.8],
    [L, 1.6],
    [L - 0.15, 2.85],
    [L - 0.4, 3.1],
    [L - 2.3, 3.1],
  ]
  b.extrude(cab, W, 1.6, 0.03, new Color(1, 1, 1), 1, (i) => i === 3)
  b.sideWindow([[L - 1.0, 1.95], [L - 0.12, 1.95], [L - 0.22, 2.75], [L - 1.0, 2.75]], W, 1.6, 0.03)
  // caja
  b.box(0, L - 2.45, 0.95, 3.55, -W / 2, W / 2, BOX, 0)
  // chasis
  b.box(0.3, L - 2.3, 0.5, 0.95, -0.5, 0.5, DARK, 0)
  b.axle(1.6, 0.5, W, 0.3)
  b.axle(L - 1.4, 0.5, W, 0.3)
  lamps(b, L, W, 0.85, 0.9, 0.18)
  return b.build(L)
}

function bus(): BufferGeometry {
  const T = VTYPES[5]
  const L = T.len
  const W = T.width
  const b = new Builder()
  const prof: P2[] = [
    [0.05, 0.3],
    [L - 0.05, 0.3],
    [L, 0.5],
    [L, 1.0],
    [L - 0.08, 2.95],
    [L - 0.3, 3.2],
    [0.2, 3.2],
    [0, 3.0],
    [0, 0.45],
  ]
  b.extrude(prof, W, 3.0, 0, new Color(1, 1, 1), 1, (i) => i === 3)
  // ventanas corridas
  b.sideWindow([[0.4, 1.25], [L - 1.2, 1.25], [L - 1.2, 2.75], [0.4, 2.75]], W, 3.0, 0)
  b.sideWindow([[L - 0.95, 1.0], [L - 0.15, 1.0], [L - 0.15, 2.75], [L - 0.95, 2.75]], W, 3.0, 0)
  b.axle(2.8, 0.5, W, 0.3)
  b.axle(L - 2.6, 0.5, W, 0.3)
  lamps(b, L, W, 0.6, 0.9, 0.2)
  return b.build(L)
}

/** cabeza tractora (6 m) */
function tractor(): BufferGeometry {
  const L = 6
  const W = 2.5
  const b = new Builder()
  const cab: P2[] = [
    [L - 2.4, 0.6],
    [L - 0.05, 0.6],
    [L, 0.85],
    [L, 1.7],
    [L - 0.15, 3.0],
    [L - 0.45, 3.35],
    [L - 2.4, 3.35],
  ]
  b.extrude(cab, W, 1.7, 0.03, new Color(1, 1, 1), 1, (i) => i === 3)
  b.sideWindow([[L - 1.1, 2.05], [L - 0.13, 2.05], [L - 0.24, 2.9], [L - 1.1, 2.9]], W, 1.7, 0.03)
  b.box(0, L - 2.4, 0.6, 1.15, -0.55, 0.55, DARK, 0)
  b.box(0.3, 1.9, 1.15, 1.3, -1.0, 1.0, DARK, 0)
  b.axle(1.0, 0.5, W, 0.3)
  b.axle(L - 1.6, 0.5, W, 0.3)
  lamps(b, L, W, 0.9, 0.95, 0.18)
  return b.build(L)
}

/** semirremolque (13,6 m) */
export const TRAILER_LEN = 13.6
function trailer(): BufferGeometry {
  const L = TRAILER_LEN
  const W = 2.55
  const b = new Builder()
  b.box(0, L, 1.2, 4.0, -W / 2, W / 2, new Color(1, 1, 1), 1)
  b.box(0.2, L - 0.5, 0.95, 1.2, -1.0, 1.0, DARK, 0)
  for (const x of [1.3, 2.65, 4.0]) b.axle(x, 0.48, W, 0.3)
  // patas de apoyo
  b.box(L - 3.2, L - 3.0, 0.4, 1.2, -1.0, -0.8, DARK, 0)
  b.box(L - 3.2, L - 3.0, 0.4, 1.2, 0.8, 1.0, DARK, 0)
  // pilotos
  for (const s of [-1, 1]) b.quad([-0.006, 0.95, s * 1.15], [-0.006, 1.15, s * 1.15], [-0.006, 1.15, s * 0.85], [-0.006, 0.95, s * 0.85], TAIL, 0)
  return b.build(L)
}

/** medidas de los coches de tren: tren, vía estrecha, metro, módulo de tranvía */
export const TRAIN_DIMS: Array<{ len: number; w: number; h: number }> = [
  { len: 23.5, w: 2.9, h: 4.0 },
  { len: 17, w: 2.6, h: 3.7 },
  { len: 17, w: 2.8, h: 3.6 },
  { len: 9, w: 2.4, h: 3.5 },
]

/** coche de tren (cabeza con el frontal inclinado o coche intermedio) */
function trainCar(kind: number, head: boolean): BufferGeometry {
  if (kind === 3) return tramModule(head)
  const { len: L, w: W, h: H } = TRAIN_DIMS[kind]
  const b = new Builder()
  const floor = 1.0
  const prof: P2[] = head
    ? [
        [0, floor],
        [L - 0.25, floor],
        [L, floor + 0.6],
        [L, floor + 1.45],
        [L - 1.7, H - 0.12],
        [L - 2.3, H],
        [0.3, H],
        [0, H - 0.3],
      ]
    : [
        [0, floor],
        [L, floor],
        [L, H - 0.3],
        [L - 0.3, H],
        [0.3, H],
        [0, H - 0.3],
      ]
  b.extrude(prof, W, H - 0.6, 0.35, new Color(1, 1, 1), 1, (i) => head && i === 3)
  // ventanas corridas y puertas oscuras
  const wy0 = floor + 1.05
  const wy1 = H - 0.85
  b.sideWindow([[1.6, wy0], [L - (head ? 3.0 : 1.6), wy0], [L - (head ? 3.0 : 1.6), wy1], [1.6, wy1]], W, H - 0.6, 0.35)
  // bogies y faldón
  for (const x of [2.6, L - 2.6]) b.box(x - 1.3, x + 1.3, 0.15, floor, -1.15, 1.15, DARK, 0)
  b.box(0.3, L - 0.3, floor - 0.25, floor, -W / 2 + 0.15, W / 2 - 0.15, DARK, 0)
  return b.build(L)
}

/** módulo de tranvía de piso bajo: la cabeza con el frontal redondeado y el pantógrafo */
function tramModule(head: boolean): BufferGeometry {
  const { len: L, w: W, h: H } = TRAIN_DIMS[3]
  const b = new Builder()
  const floor = 0.35
  const prof: P2[] = head
    ? [
        [0, floor],
        [L - 0.5, floor],
        [L, floor + 0.55],
        [L, floor + 1.15],
        [L - 0.55, H - 0.35],
        [L - 0.95, H],
        [0.15, H],
        [0, H - 0.15],
      ]
    : [
        [0, floor],
        [L, floor],
        [L, H - 0.15],
        [L - 0.15, H],
        [0.15, H],
        [0, H - 0.15],
      ]
  b.extrude(prof, W, H - 0.5, 0.2, new Color(1, 1, 1), 1, (i) => head && (i === 3 || i === 4))
  // ventanas grandes (piso bajo) y faldón
  const wy0 = floor + 0.75
  const wy1 = H - 0.5
  b.sideWindow([[0.6, wy0], [L - (head ? 1.4 : 0.6), wy0], [L - (head ? 1.4 : 0.6), wy1], [0.6, wy1]], W, H - 0.5, 0.2)
  b.box(0.2, L - 0.2, 0.12, floor, -W / 2 + 0.2, W / 2 - 0.2, DARK, 0)
  // pantógrafo en el techo de los módulos intermedios
  if (!head) {
    b.box(L / 2 - 1.2, L / 2 + 1.2, H, H + 0.25, -0.6, 0.6, DARK, 0)
    b.box(L / 2 - 0.05, L / 2 + 0.05, H + 0.25, H + 1.1, -0.5, 0.5, DARK, 0)
  }
  return b.build(L)
}

/** transbordadores: largo nominal (se escalan al de cada barco) */
export const FERRY_LEN = [32, 140]

/** transbordador: casco con proa en punta (color del barco) y superestructura blanca con ventanas */
function ferryModel(big: boolean): BufferGeometry {
  const L = big ? 140 : 32
  const W = big ? 24 : 8
  const hull = big ? 9 : 2.4
  const b = new Builder()
  const WHITE = new Color(0xf1f1ee)
  // casco (de popa a proa, puntiagudo)
  const hw = W / 2
  const bow = big ? 22 : 7
  const hullPoly: P2[] = [
    [0, -hw * 0.92],
    [L - bow, -hw],
    [L, 0],
    [L - bow, hw],
    [0, hw * 0.92],
  ]
  // por debajo del agua un poco (calado)
  b.prism(hullPoly, -1.5, hull, new Color(1, 1, 1), 1)
  // superestructura
  const sx0 = big ? 18 : 6
  const sx1 = big ? L - 36 : L - 9
  const sw = hw * (big ? 0.8 : 0.7)
  const deck = big ? 3 : 2
  const levels = big ? 4 : 1
  for (let k = 0; k < levels; k++) {
    const y0 = hull + k * deck
    const inset = k * (big ? 3 : 0)
    b.box(sx0 + inset, sx1 - inset * 0.5, y0, y0 + deck - 0.15, -sw, sw, WHITE, 0)
    // ventanas corridas
    b.box(sx0 + inset + 0.5, sx1 - inset * 0.5 - 0.5, y0 + deck * 0.35, y0 + deck * 0.75, -sw - 0.03, sw + 0.03, GLASS, 0)
  }
  // puente de mando y chimenea
  const top = hull + levels * deck
  b.box(sx1 - (big ? 22 : 6), sx1 - (big ? 8 : 1.5), top, top + (big ? 3 : 1.6), -sw * 0.9, sw * 0.9, WHITE, 0)
  b.box(sx1 - (big ? 21 : 5.5), sx1 - (big ? 9 : 2), top + (big ? 1.2 : 0.6), top + (big ? 2.6 : 1.4), -sw * 0.92, sw * 0.92, GLASS, 0)
  if (big) b.box(sx0 + 10, sx0 + 18, top, top + 8, -2.5, 2.5, new Color(1, 1, 1), 1)
  return b.build(L)
}

/** caja de lejos (1 de largo, ancho y alto: se escala por instancia) */
function far(): BufferGeometry {
  const b = new Builder()
  b.box(0, 1, 0, 1, -0.5, 0.5, new Color(1, 1, 1), 1)
  return b.build(1)
}

/** geometrías por tipo (índices de VTYPES) y extras */
export function vehicleGeometries(): { types: BufferGeometry[]; tractor: BufferGeometry; trailer: BufferGeometry; far: BufferGeometry; trains: BufferGeometry[]; ferries: BufferGeometry[] } {
  const trains: BufferGeometry[] = []
  for (let k = 0; k < 4; k++) trains.push(trainCar(k, true), trainCar(k, false))
  return { types: [car(), hatch(), suv(), van(), truck(), bus(), tractor()], tractor: tractor(), trailer: trailer(), far: far(), trains, ferries: [ferryModel(false), ferryModel(true)] }
}

// colores de los trenes (blanco con frontal de color, plata, rojo, azul, verde, amarillo)
const TRAIN_COLOURS: Array<[number, number]> = [
  [0xeeeeea, 0.45],
  [0xb9bcbf, 0.2],
  [0xb32128, 0.1],
  [0x1f4e8c, 0.1],
  [0x2f7a3a, 0.08],
  [0xe0b21f, 0.07],
]

const FERRY_COLOURS = [0x1d3557, 0xa31d23, 0x2e4630, 0xf0f0ee, 0x2a62a8, 0x15161a]
export function ferryColour(seed: number, out: Color): Color {
  return out.setHex(FERRY_COLOURS[Math.floor(seed) % FERRY_COLOURS.length])
}

export function trainColour(seed: number, out: Color): Color {
  let r = ((seed * 9301 + 49297) % 233280) / 233280
  for (const [hex, w] of TRAIN_COLOURS) {
    r -= w
    if (r <= 0) return out.setHex(hex)
  }
  return out.setHex(TRAIN_COLOURS[0][0])
}

// colores de carrocería (sRGB) con su frecuencia aproximada en el parque europeo
const CAR_COLOURS: Array<[number, number]> = [
  [0xeeeeea, 0.24],
  [0x15161a, 0.19],
  [0x6b6e72, 0.16],
  [0xaeb2b5, 0.13],
  [0x1d3557, 0.08],
  [0x8e1a1c, 0.07],
  [0x5a1418, 0.02],
  [0x2e4630, 0.02],
  [0xc9b99a, 0.03],
  [0x5a4635, 0.02],
  [0x7fa3c0, 0.02],
  [0xd9b32b, 0.01],
  [0xc3611f, 0.01],
]
const WORK_COLOURS: Array<[number, number]> = [
  [0xf2f2ef, 0.6],
  [0xaeb2b5, 0.1],
  [0x1d3557, 0.1],
  [0x8e1a1c, 0.08],
  [0x15161a, 0.07],
  [0x2e4630, 0.05],
]
const BUS_COLOURS: Array<[number, number]> = [
  [0xd8262f, 0.3],
  [0xf2f2ef, 0.3],
  [0x1f5aa6, 0.2],
  [0x2f8a3a, 0.1],
  [0xe3a21a, 0.1],
]

/** color (lineal) de la carrocería de un vehículo según su tipo y su semilla */
export function bodyColour(type: number, seed: number, out: Color): Color {
  const list = type >= 3 && type !== 5 ? WORK_COLOURS : type === 5 ? BUS_COLOURS : CAR_COLOURS
  let r = ((seed * 9301 + 49297) % 233280) / 233280
  for (const [hex, w] of list) {
    r -= w
    if (r <= 0) return out.setHex(hex)
  }
  return out.setHex(list[0][0])
}

// ---------------------------------------------------------------------------
// Barcos (marine.ts): eslora del modelo (se escalan a la de cada barco), casco del color del barco
// ---------------------------------------------------------------------------

/** eslora de cada modelo (la de BOATS[k].base en marine.ts) */
export const BOAT_BASE = [12, 12, 18, 6.5, 16, 40, 80, 250, 220, 200]

const WHITE = new Color(0xf2f2ee)
const SAIL = new Color(0xeeece4)
const TEAK = new Color(0x9a7650)
const STEEL = new Color(0xb8bcc0)
const COVER = new Color(0x1f3d63)
const DECK = new Color(0x6d6a64)
const RUST = new Color(0x7a3326)

/** planta del casco: popa casi recta, manga máxima hacia el tercio de proa y proa en punta */
function hullPlan(L: number, B: number, bow: number, stern = 0.85): P2[] {
  const h = B / 2
  return [
    [0, -h * stern],
    [L * 0.25, -h],
    [L - bow, -h],
    [L - bow * 0.45, -h * 0.62],
    [L, 0],
    [L - bow * 0.45, h * 0.62],
    [L - bow, h],
    [L * 0.25, h],
    [0, h * stern],
  ]
}

/** vela: triángulo vertical (las dos caras) en el plano z = 0 */
function sail(b: Builder, a: P2, c: P2, d: P2, color: Color): void {
  b.tri([a[0], a[1], 0.02], [c[0], c[1], 0.02], [d[0], d[1], 0.02], color, 0)
  b.tri([d[0], d[1], -0.02], [c[0], c[1], -0.02], [a[0], a[1], -0.02], color, 0)
  b.tri([a[0], a[1], 0.02], [d[0], d[1], 0.02], [c[0], c[1], 0.02], color, 0)
  b.tri([c[0], c[1], -0.02], [d[0], d[1], -0.02], [a[0], a[1], -0.02], color, 0)
}

/** ventanas corridas a los dos lados de una caja */
function windowBand(b: Builder, x0: number, x1: number, y0: number, y1: number, hw: number): void {
  b.box(x0, x1, y0, y1, -hw - 0.03, hw + 0.03, GLASS, 0)
}

function sailboat(underSail: boolean): BufferGeometry {
  const L = 12
  const B = 3.84
  const b = new Builder()
  b.prism(hullPlan(L, B, 3.2, 0.8), -0.5, 1.0, new Color(1, 1, 1), 1)
  // cubierta de teca y cabina
  b.prism(hullPlan(L - 0.6, B - 0.5, 2.8, 0.8).map(([x, z]) => [x + 0.3, z] as P2), 1.0, 1.04, TEAK, 0)
  b.box(3.4, 7.2, 1.0, 1.65, -1.15, 1.15, WHITE, 0)
  windowBand(b, 4.0, 6.8, 1.25, 1.5, 1.15)
  // mástil y botavara
  const mx = 7.6
  const top = 16
  b.box(mx - 0.09, mx + 0.09, 1.0, top, -0.09, 0.09, STEEL, 0)
  b.box(2.6, mx, 2.55, 2.7, -0.07, 0.07, STEEL, 0)
  if (underSail) {
    // mayor y génova
    sail(b, [mx - 0.1, 2.75], [mx - 0.1, top - 0.4], [2.8, 2.75], SAIL)
    sail(b, [mx + 0.15, top - 1.6], [L - 0.3, 1.2], [mx + 0.4, 1.4], SAIL)
  } else {
    // vela recogida en la botavara con su funda
    b.box(2.8, mx - 0.1, 2.7, 3.05, -0.17, 0.17, COVER, 0)
  }
  return b.build(L)
}

function motorYacht(): BufferGeometry {
  const L = 18
  const B = 4.86
  const b = new Builder()
  b.prism(hullPlan(L, B, 5, 0.9), -0.8, 1.8, new Color(1, 1, 1), 1)
  b.prism(hullPlan(L - 0.6, B - 0.4, 4.6, 0.9).map(([x, z]) => [x + 0.3, z] as P2), 1.8, 1.84, TEAK, 0)
  // salón y puente volante
  b.box(4.5, 12.5, 1.8, 3.5, -1.95, 1.95, WHITE, 0)
  windowBand(b, 5.0, 12.2, 2.3, 3.2, 1.95)
  b.box(12.5, 13.6, 1.8, 3.1, -1.7, 1.7, GLASS, 0)
  b.box(6.5, 11.5, 3.5, 4.1, -1.7, 1.7, WHITE, 0)
  b.box(8.5, 9.0, 4.1, 5.3, -1.2, 1.2, WHITE, 0)
  return b.build(L)
}

function motorboat(): BufferGeometry {
  const L = 6.5
  const B = 2.3
  const b = new Builder()
  b.prism(hullPlan(L, B, 2, 0.85), -0.3, 0.75, new Color(1, 1, 1), 1)
  b.prism(hullPlan(L - 0.3, B - 0.25, 1.85, 0.85).map(([x, z]) => [x + 0.15, z] as P2), 0.75, 0.78, WHITE, 0)
  // consola, parabrisas y motor fueraborda
  b.box(3.0, 3.8, 0.78, 1.55, -0.45, 0.45, WHITE, 0)
  b.box(3.8, 3.9, 1.3, 1.75, -0.5, 0.5, GLASS, 0)
  b.box(-0.45, 0.05, -0.1, 1.15, -0.22, 0.22, DARK, 0)
  return b.build(L)
}

function fishingBoat(): BufferGeometry {
  const L = 16
  const B = 4.8
  const b = new Builder()
  b.prism(hullPlan(L, B, 4.5, 0.9), -1.0, 2.2, new Color(1, 1, 1), 1)
  b.prism(hullPlan(L - 0.5, B - 0.4, 4.2, 0.9).map(([x, z]) => [x + 0.25, z] as P2), 2.2, 2.25, DECK, 0)
  // puente, mástil y pórtico de popa
  b.box(9.0, 12.4, 2.2, 4.9, -1.6, 1.6, WHITE, 0)
  windowBand(b, 9.3, 12.45, 3.9, 4.6, 1.6)
  b.box(11.0, 11.2, 4.9, 9.5, -0.1, 0.1, STEEL, 0)
  b.box(1.0, 1.25, 2.2, 6.8, -2.0, -1.75, STEEL, 0)
  b.box(1.0, 1.25, 2.2, 6.8, 1.75, 2.0, STEEL, 0)
  b.box(1.0, 1.25, 6.55, 6.8, -2.0, 2.0, STEEL, 0)
  return b.build(L)
}

function tourBoat(): BufferGeometry {
  const L = 40
  const B = 7.6
  const b = new Builder()
  b.prism(hullPlan(L, B, 7, 0.95), -1.0, 1.2, new Color(1, 1, 1), 1)
  b.prism(hullPlan(L - 0.6, B - 0.4, 6.6, 0.95).map(([x, z]) => [x + 0.3, z] as P2), 1.2, 1.24, DECK, 0)
  // salón acristalado con techo blanco
  b.box(4, 33, 1.24, 3.3, -3.3, 3.3, GLASS, 0)
  b.box(3.6, 33.4, 3.3, 3.55, -3.45, 3.45, WHITE, 0)
  b.box(33, 35.5, 1.24, 3.6, -1.4, 1.4, WHITE, 0)
  windowBand(b, 33.3, 35.55, 2.6, 3.3, 1.4)
  return b.build(L)
}

function barge(): BufferGeometry {
  const L = 80
  const B = 9.2
  const b = new Builder()
  b.prism(hullPlan(L, B, 5, 1), -2.5, 1.5, new Color(1, 1, 1), 1)
  // bodega cubierta, alojamiento y timonera a popa
  b.box(10, 68, 1.5, 2.6, -4.2, 4.2, new Color(0x3b4a3a), 0)
  b.box(1.5, 9.5, 1.5, 3.8, -4.0, 4.0, WHITE, 0)
  windowBand(b, 2, 9.2, 2.4, 3.2, 4.0)
  b.box(5.5, 8.8, 3.8, 6.2, -2.2, 2.2, WHITE, 0)
  windowBand(b, 5.6, 8.85, 5.0, 5.9, 2.2)
  b.box(70, 76, 1.5, 1.9, -4.2, 4.2, DECK, 0)
  return b.build(L)
}

/** superestructura de los mercantes (a popa): bloque blanco de puentes, alerones y chimenea */
function shipHouse(b: Builder, x0: number, x1: number, y0: number, h: number, hw: number, funnel: Color): void {
  b.box(x0, x1, y0, y0 + h, -hw, hw, WHITE, 0)
  for (let k = 1; k < h / 2.8; k++) windowBand(b, x0 + 0.6, x1 + 0.03, y0 + k * 2.8 - 0.9, y0 + k * 2.8 - 0.2, hw)
  // puente con alerones
  b.box(x1 - 6, x1, y0 + h, y0 + h + 3, -hw - 4, hw + 4, WHITE, 0)
  windowBand(b, x1 - 5.6, x1 + 0.04, y0 + h + 1.2, y0 + h + 2.4, hw + 4)
  b.box(x0 + 2, x0 + 8, y0 + h, y0 + h + 9, -3, 3, funnel, 0)
}

function containerShip(): BufferGeometry {
  const L = 250
  const B = 37.5
  const b = new Builder()
  b.prism(hullPlan(L, B, 38, 0.92), -9, 11, new Color(1, 1, 1), 1)
  b.prism(hullPlan(L - 2, B - 1.5, 37, 0.92).map(([x, z]) => [x + 1, z] as P2), 11, 11.1, RUST, 0)
  // contenedores: bahías de 13 m, filas de colores y alturas distintas
  const cols = [0xb03a2e, 0x1f618d, 0x196f3d, 0xd4ac0d, 0x7b7d7d, 0xca6f1e, 0xf0f0ee, 0x4a235a, 0x0e6655, 0x922b21].map((h) => new Color(h))
  let n = 0
  for (let x = 40; x + 12.5 < 205; x += 13.2) {
    if (x > 120 && x < 133) continue
    const taper = x > 175 ? 0.8 : 1
    const rows = 6
    const w = (B - 4) * taper
    for (let r = 0; r < rows; r++) {
      const z0 = -w / 2 + (r * w) / rows
      const z1 = z0 + w / rows - 0.15
      const tiers = 3 + ((n * 7 + r * 3) % 4)
      for (let t = 0; t < tiers; t += 2) {
        const c = cols[(n * 3 + r * 5 + t) % cols.length]
        b.box(x, x + 12.2, 11.1 + t * 2.6, 11.1 + Math.min(tiers, t + 2) * 2.6 - 0.05, z0, z1, c, 0)
      }
    }
    n++
  }
  shipHouse(b, 207, 222, 11, 22, 16, new Color(0x2c3e50))
  return b.build(L)
}

function tanker(): BufferGeometry {
  const L = 220
  const B = 39.6
  const b = new Builder()
  b.prism(hullPlan(L, B, 30, 0.95), -8, 9, new Color(1, 1, 1), 1)
  b.prism(hullPlan(L - 2, B - 1.5, 29, 0.95).map(([x, z]) => [x + 1, z] as P2), 9, 9.1, new Color(0x5e6b4f), 0)
  // tuberías y pasarela a lo largo, colector en el centro
  for (const z of [-3, -1.5, 0, 1.5, 3]) b.box(38, 195, 9.1, 9.8, z - 0.35, z + 0.35, new Color(0xc9b458), 0)
  b.box(38, 195, 11.5, 12.0, -1.0, 1.0, STEEL, 0)
  b.box(108, 118, 9.1, 13, -14, 14, new Color(0xc9b458), 0)
  b.box(200, 210, 9.1, 15, -5, 5, WHITE, 0)
  shipHouse(b, 6, 30, 9, 19, 17, new Color(0x922b21))
  return b.build(L)
}

function bulkCarrier(): BufferGeometry {
  const L = 200
  const B = 32
  const b = new Builder()
  b.prism(hullPlan(L, B, 26, 0.95), -8, 9, new Color(1, 1, 1), 1)
  b.prism(hullPlan(L - 2, B - 1.5, 25, 0.95).map(([x, z]) => [x + 1, z] as P2), 9, 9.1, RUST, 0)
  // bodegas con sus tapas y grúas entre ellas
  const covers = new Color(0x8a3324)
  const crane = new Color(0xd6c25a)
  for (let k = 0; k < 5; k++) {
    const x = 36 + k * 30
    b.box(x, x + 22, 9.1, 11.6, -11, 11, covers, 0)
    if (k < 4) {
      b.box(x + 24.5, x + 27.5, 9.1, 24, -1.5, 1.5, crane, 0)
      b.box(x + 25.5, x + 26.5, 22, 23, -1, 14, crane, 0)
    }
  }
  b.box(188, 196, 9.1, 14, -4, 4, WHITE, 0)
  shipHouse(b, 6, 28, 9, 18, 14, new Color(0x1b2631))
  return b.build(L)
}

/** modelos de los barcos por tipo (índices de BOATS en marine.ts) */
export function boatGeometries(): BufferGeometry[] {
  return [sailboat(true), sailboat(false), motorYacht(), motorboat(), fishingBoat(), tourBoat(), barge(), containerShip(), tanker(), bulkCarrier()]
}

// colores del casco por tipo de barco (los de recreo, casi siempre blancos)
const BOAT_COLOURS: Array<Array<[number, number]>> = [
  [[0xf4f4f0, 0.7], [0x1d3557, 0.15], [0x8e1a1c, 0.05], [0x2e4630, 0.05], [0x9aa3a8, 0.05]],
  [[0xf4f4f0, 0.7], [0x1d3557, 0.15], [0x8e1a1c, 0.05], [0x2e4630, 0.05], [0x9aa3a8, 0.05]],
  [[0xf4f4f0, 0.8], [0x15161a, 0.08], [0x1d3557, 0.07], [0x9aa3a8, 0.05]],
  [[0xf4f4f0, 0.6], [0x1d3557, 0.12], [0xb22222, 0.1], [0x2a62a8, 0.1], [0x15161a, 0.08]],
  [[0x1f5aa6, 0.3], [0xb32128, 0.25], [0x2f7a3a, 0.15], [0xf2f2ef, 0.2], [0x15161a, 0.1]],
  [[0xf2f2ef, 0.5], [0x1d3557, 0.3], [0x15161a, 0.2]],
  [[0x15161a, 0.4], [0x1d3557, 0.25], [0x5a1418, 0.2], [0x2e4630, 0.15]],
  [[0x15161a, 0.3], [0x1d3557, 0.25], [0x8a3324, 0.25], [0x2a62a8, 0.1], [0x2e4630, 0.1]],
  [[0x8a3324, 0.35], [0x15161a, 0.3], [0x1d3557, 0.2], [0x2e4630, 0.15]],
  [[0x8a3324, 0.3], [0x15161a, 0.3], [0x1d3557, 0.25], [0x5a6b75, 0.15]],
]

/** color (lineal) del casco de un barco según su tipo y su semilla */
export function boatColour(kind: number, seed: number, out: Color): Color {
  const list = BOAT_COLOURS[kind] ?? BOAT_COLOURS[0]
  let r = ((seed * 9301 + 49297) % 233280) / 233280
  for (const [hex, w] of list) {
    r -= w
    if (r <= 0) return out.setHex(hex)
  }
  return out.setHex(list[0][0])
}
