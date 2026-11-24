// Torres y postes de los tendidos, hechos de barras (cada barra se dibuja como una cinta que mira
// a la cámara, con un ancho mínimo de un píxel y la transparencia de lo que de verdad cubre: ver
// powerMaterial.ts). Coordenadas del apoyo: x a lo largo de la cruceta (de través a la línea),
// y hacia arriba desde el pie, z a lo largo de la línea.
//
// Medidas de los apoyos habituales en España (REE y distribuidoras): 400 kV de 40 a 55 m, 220 kV
// de 32 a 45, 132 kV de 28 a 36, 45-66 kV de 20 a 30 (celosía con crucetas al tresbolillo), media
// tensión en apoyos de celosía o de hormigón de 11 a 14 m con cruceta recta, baja en postes de
// madera u hormigón de 8 a 9 m con el cable trenzado, teléfono en postes de madera de 7 m.

import { MATERIAL, NODE } from './powerFormat.ts'

export type V3 = [number, number, number]

export interface Member {
  a: V3
  b: V3
  /** radio (m) en a y en b */
  ra: number
  rb: number
  /** opacidad (las caras de celosía vistas de lejos) */
  op: number
  /** color: índice de PALETTE */
  col: number
}

/** Caja de choque en coordenadas del apoyo. */
export interface Box {
  x0: number
  x1: number
  y0: number
  y1: number
  z: number
}

export interface Template {
  id: string
  /** altura nominal (m) */
  height: number
  /** barras para verlo de cerca */
  full: Member[]
  /** silueta para verlo de lejos (pocas barras, caras de celosía semitransparentes) */
  simple: Member[]
  /** puntos de enganche (x, y) de cada fase, por circuito */
  circuits: Array<Array<[number, number]>>
  /** puntos de enganche de los cables de tierra */
  earth: Array<[number, number]>
  boxes: Box[]
}

/** Colores (sRGB): acero galvanizado, vidrio de aisladores, hormigón, madera, negro, aluminio. */
export const PALETTE = [0x8e9293, 0x4c6458, 0xb3aea4, 0x5c4a38, 0x232323, 0x9fa2a3, 0x77797b]
const STEEL = 0
const GLASS = 1
const CONCRETE = 2
const WOOD = 3

// ---------------------------------------------------------------------------
// Piezas

class Builder {
  readonly full: Member[] = []
  readonly simple: Member[] = []
  readonly boxes: Box[] = []
  bar(a: V3, b: V3, r: number, col = STEEL, rb = r, op = 1): void {
    this.full.push({ a, b, ra: r, rb, op, col })
  }
  far(a: V3, b: V3, r: number, col = STEEL, rb = r, op = 1): void {
    this.simple.push({ a, b, ra: r, rb, op, col })
  }
  both(a: V3, b: V3, r: number, col = STEEL, rb = r): void {
    this.bar(a, b, r, col, rb)
    this.far(a, b, r, col, rb)
  }
  box(x0: number, x1: number, y0: number, y1: number, z: number): void {
    this.boxes.push({ x0: Math.min(x0, x1), x1: Math.max(x0, x1), y0, y1, z })
  }

  /**
   * Fuste de celosía de sección cuadrada entre y0 (semiancho w0) e y1 (w1): cuatro montantes,
   * horizontales en cada nivel y cruces de San Andrés en cada cara.
   */
  lattice(y0: number, y1: number, w0: number, w1: number, panels: number, rLeg: number, rBrace: number, farOp = 0.3): void {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) this.bar([sx * w0, y0, sz * w0], [sx * w1, y1, sz * w1], rLeg)
    const at = (i: number): [number, number] => {
      const f = i / panels
      return [y0 + (y1 - y0) * f, w0 + (w1 - w0) * f]
    }
    for (let i = 0; i <= panels; i++) {
      const [y, w] = at(i)
      // horizontales (las del pie quedan bajo tierra: fuera)
      if (i > 0) {
        this.bar([-w, y, -w], [w, y, -w], rBrace)
        this.bar([-w, y, w], [w, y, w], rBrace)
        this.bar([-w, y, -w], [-w, y, w], rBrace)
        this.bar([w, y, -w], [w, y, w], rBrace)
      }
      if (i === panels) break
      const [yb, wb] = at(i + 1)
      for (const s of [-1, 1]) {
        // caras x = ±w y z = ±w
        this.bar([s * w, y, -w], [s * wb, yb, wb], rBrace)
        this.bar([s * w, y, w], [s * wb, yb, -wb], rBrace)
        this.bar([-w, y, s * w], [wb, yb, s * wb], rBrace)
        this.bar([w, y, s * w], [-wb, yb, s * wb], rBrace)
      }
    }
    // de lejos: una cara semitransparente y los montantes
    this.far([0, y0, 0], [0, y1, 0], w0 * 1.05, STEEL, w1 * 1.05, farOp)
    for (const sx of [-1, 1]) this.far([sx * w0, y0, 0], [sx * w1, y1, 0], rLeg * 1.4)
    // cajas de choque: el fuste en tres tramos
    for (let k = 0; k < 3; k++) {
      const ya = y0 + ((y1 - y0) * k) / 3
      const yb = y0 + ((y1 - y0) * (k + 1)) / 3
      const w = Math.max(w0 + ((w1 - w0) * k) / 3, w0 + ((w1 - w0) * (k + 1)) / 3)
      this.box(-w, w, ya, yb, w)
    }
  }

  /** Cruceta en celosía desde la cara del fuste (semiancho w a esa altura) hasta x = side·len. */
  arm(side: number, y: number, len: number, depth: number, w: number, r: number): [number, number] {
    const tip: V3 = [side * len, y, 0]
    const top: V3 = [side * (len - 0.15), y + depth * 0.18, 0]
    this.bar([side * w, y, -w], tip, r)
    this.bar([side * w, y, w], tip, r)
    this.bar([side * w, y + depth, -w * 0.9], top, r * 0.8)
    this.bar([side * w, y + depth, w * 0.9], top, r * 0.8)
    // celosía de la cruceta: dos niveles
    for (const f of [0.35, 0.68]) {
      const x = side * (w + (len - w) * f)
      const yt = y + depth * (1 - f * 0.82)
      const wz = w * (1 - f)
      this.bar([x, y, -wz], [x, yt, -wz * 0.9], r * 0.55)
      this.bar([x, y, wz], [x, yt, wz * 0.9], r * 0.55)
      this.bar([x, y, -wz], [x, y, wz], r * 0.55)
    }
    this.far([side * w, y + depth * 0.45, 0], tip, depth * 0.32, STEEL, 0.12, 0.55)
    this.box(side * w, side * (len + 0.4), y - 0.3, y + depth, w + 0.3)
    return [side * len, y]
  }

  /** Cadena de aisladores colgada de (x, y); devuelve el punto donde se engancha el conductor. */
  string(x: number, y: number, len: number, r: number): [number, number] {
    this.bar([x, y, 0], [x, y - len, 0], r, GLASS)
    this.far([x, y, 0], [x, y - len, 0], r, GLASS)
    this.box(x - 0.5, x + 0.5, y - len - 0.3, y, 0.5)
    return [x, y - len]
  }

  /** Aislador rígido de pie sobre (x, y) (media tensión). */
  post(x: number, y: number, len: number, r: number): [number, number] {
    this.bar([x, y, 0], [x, y + len, 0], r, GLASS)
    return [x, y + len]
  }

  /** Cúpula para el cable de tierra sobre el fuste (semiancho w a la altura y). */
  peak(x: number, y: number, w: number, h: number, r: number): [number, number] {
    const p: V3 = [x, y + h, 0]
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) this.bar([x + sx * w, y, sz * w], p, r)
    this.far([x, y, 0], p, w * 0.6, STEEL, 0.1, 0.6)
    this.box(x - w, x + w, y, y + h, w)
    return [x, y + h]
  }

  done(id: string, height: number, circuits: Array<Array<[number, number]>>, earth: Array<[number, number]>): Template {
    return { id, height, full: this.full, simple: this.simple, circuits, earth, boxes: this.boxes }
  }
}

// ---------------------------------------------------------------------------
// Diseños

/** Doble circuito «barril»: tres crucetas por lado, la del medio más larga; k = escala. */
function barrel(id: string, k: number, insul: number): Template {
  const b = new Builder()
  const y1 = 30 * k
  const yTop = 52 * k
  const w0 = 4.4 * k
  const w1 = 1.6 * k
  const w2 = 1.1 * k
  b.lattice(0, y1, w0, w1, Math.max(4, Math.round(7 * k + 1)), 0.09 * k + 0.02, 0.035 * k + 0.012)
  b.lattice(y1, yTop, w1, w2, Math.max(3, Math.round(5 * k + 1)), 0.07 * k + 0.015, 0.03 * k + 0.01, 0.35)
  const arms: Array<[number, number]> = [
    [31.2 * k, 9.5 * k],
    [39.6 * k, 11.5 * k],
    [48 * k, 9 * k],
  ]
  const wAt = (y: number) => w1 + ((w2 - w1) * (y - y1)) / (yTop - y1)
  const circ: Array<Array<[number, number]>> = [[], []]
  arms.forEach(([y, len]) => {
    for (const [ci, side] of [
      [0, -1],
      [1, 1],
    ] as const) {
      const [tx, ty] = b.arm(side, y, len, 2.6 * k, wAt(y), 0.06 * k + 0.015)
      circ[ci].push(b.string(tx - side * 0.15, ty, insul, 0.11 + 0.03 * k))
    }
  })
  const e = b.peak(0, yTop, w2, 4 * k, 0.05 * k + 0.012)
  return b.done(id, yTop + 4 * k, circ, [e])
}

/** Simple circuito con cabeza en ventana («cabeza de gato»): tres fases en una viga, la central en la ventana. */
function catHead(id: string, k: number, insul: number): Template {
  const b = new Builder()
  const y1 = 28 * k
  const yb = 37 * k
  const half = 13 * k
  const w0 = 4 * k
  const w1 = 1.4 * k
  b.lattice(0, y1, w0, w1, Math.max(4, Math.round(7 * k)), 0.09 * k + 0.02, 0.035 * k + 0.012)
  const legX = 6.6 * k
  const dz = 1.0 * k
  const r = 0.07 * k + 0.015
  // patas inclinadas de la cabeza
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) b.bar([sx * w1, y1, sz * w1], [sx * legX, yb, sz * dz], r)
    // celosía de la pata
    b.bar([sx * w1, y1, -w1], [sx * legX, yb, dz], r * 0.5)
    b.bar([sx * w1, y1, w1], [sx * legX, yb, -dz], r * 0.5)
    b.far([sx * w1, y1, 0], [sx * legX, yb, 0], 0.9 * k, STEEL, 0.7 * k, 0.4)
    b.box(sx * w1, sx * legX, y1, yb, 1.6 * k)
  }
  // viga: cuatro cordones y celosía
  const yt = yb + 2.2 * k
  for (const [y, z] of [
    [yb, dz],
    [yb, -dz],
    [yt, dz * 0.6],
    [yt, -dz * 0.6],
  ] as const)
    b.bar([-half, y, z], [half, y, z], r * 0.8)
  const n = 10
  for (let i = 0; i <= n; i++) {
    const x = -half + (2 * half * i) / n
    b.bar([x, yb, dz], [x, yt, dz * 0.6], r * 0.45)
    b.bar([x, yb, -dz], [x, yt, -dz * 0.6], r * 0.45)
    if (i < n) {
      const x2 = -half + (2 * half * (i + 1)) / n
      b.bar([x, yb, dz], [x2, yt, dz * 0.6], r * 0.4)
      b.bar([x, yb, -dz], [x2, yt, -dz * 0.6], r * 0.4)
    }
  }
  b.far([-half, (yb + yt) / 2, 0], [half, (yb + yt) / 2, 0], 1.1 * k, STEEL, 1.1 * k, 0.55)
  b.box(-half, half, yb - 0.3, yt + 0.3, dz + 0.3)
  const phases: Array<[number, number]> = [-11 * k, 0, 11 * k].map((x) => b.string(x, yb, insul, 0.11 + 0.03 * k))
  // dos cúpulas para los cables de tierra
  const earth = [-1, 1].map((sx) => b.peak(sx * legX, yt, 0.8 * k, 5 * k, 0.05 * k + 0.012))
  return b.done(id, yt + 5 * k, [phases], earth)
}

/** Simple circuito al tresbolillo: una cruceta a un lado, otra al otro, otra arriba. */
function staggered(id: string, k: number, insul: number): Template {
  const b = new Builder()
  const y1 = 22 * k
  const yTop = 30 * k
  const w0 = 2.6 * k
  const w1 = 1.0 * k
  const w2 = 0.7 * k
  b.lattice(0, y1, w0, w1, Math.max(4, Math.round(6 * k)), 0.07 * k + 0.02, 0.03 * k + 0.01)
  b.lattice(y1, yTop, w1, w2, 3, 0.055 * k + 0.015, 0.025 * k + 0.008, 0.35)
  const wAt = (y: number) => w1 + ((w2 - w1) * (y - y1)) / (yTop - y1)
  const phases: Array<[number, number]> = []
  for (const [side, y] of [
    [-1, 23.2 * k],
    [1, 25.8 * k],
    [-1, 28.4 * k],
  ] as const) {
    const [tx, ty] = b.arm(side, y, 4.2 * k, 1.5 * k, wAt(y), 0.045 * k + 0.012)
    phases.push(b.string(tx - side * 0.1, ty, insul, 0.09 + 0.03 * k))
  }
  const e = b.peak(0, yTop, w2, 2.6 * k, 0.04 * k + 0.01)
  return b.done(id, yTop + 2.6 * k, [phases], [e])
}

/** Doble circuito al tresbolillo pequeño (45-66 kV): tres crucetas a cada lado, todas iguales. */
function smallDouble(id: string, k: number, insul: number): Template {
  const b = new Builder()
  const y1 = 18 * k
  const yTop = 28 * k
  const w0 = 2.4 * k
  const w1 = 0.9 * k
  const w2 = 0.65 * k
  b.lattice(0, y1, w0, w1, Math.max(4, Math.round(5 * k)), 0.07 * k + 0.02, 0.03 * k + 0.01)
  b.lattice(y1, yTop, w1, w2, 3, 0.055 * k + 0.015, 0.025 * k + 0.008, 0.35)
  const wAt = (y: number) => w1 + ((w2 - w1) * (y - y1)) / (yTop - y1)
  const circ: Array<Array<[number, number]>> = [[], []]
  for (const y of [19.5 * k, 23 * k, 26.5 * k]) {
    for (const [ci, side] of [
      [0, -1],
      [1, 1],
    ] as const) {
      const [tx, ty] = b.arm(side, y, 3.6 * k, 1.4 * k, wAt(y), 0.045 * k + 0.012)
      circ[ci].push(b.string(tx - side * 0.1, ty, insul, 0.09 + 0.02 * k))
    }
  }
  const e = b.peak(0, yTop, w2, 2.4 * k, 0.04 * k + 0.01)
  return b.done(id, yTop + 2.4 * k, circ, [e])
}

/** Apoyo de media tensión (celosía u hormigón) con crucetas rectas; double = dos circuitos. */
function mvPole(id: string, kind: 'lattice' | 'concrete', double: boolean): Template {
  const b = new Builder()
  const h = double ? 14 : 12
  if (kind === 'lattice') b.lattice(0, h, 0.45, 0.16, double ? 7 : 6, 0.04, 0.016, 0.45)
  else {
    b.both([0, 0, 0], [0, h, 0], 0.2, CONCRETE, 0.11)
    b.box(-0.25, 0.25, 0, h, 0.25)
  }
  const rArm = 0.05
  const arm = (y: number, half: number) => {
    b.both([-half, y, 0], [half, y, 0], rArm)
    b.bar([-0.16, y - 0.8, 0], [-half * 0.6, y, 0], rArm * 0.5)
    b.bar([0.16, y - 0.8, 0], [half * 0.6, y, 0], rArm * 0.5)
    b.box(-half - 0.2, half + 0.2, y - 0.4, y + 0.6, 0.4)
  }
  const circ: Array<Array<[number, number]>> = []
  if (!double) {
    arm(h - 0.5, 1.75)
    b.both([0, h, 0], [0, h + 0.45, 0], 0.06)
    circ.push([b.post(-1.6, h - 0.45, 0.32, 0.06), b.post(0, h + 0.45, 0.32, 0.06), b.post(1.6, h - 0.45, 0.32, 0.06)])
  } else {
    const ys = [h - 0.4, h - 1.8, h - 3.2]
    for (const y of ys) arm(y, 1.85)
    circ.push(ys.map((y) => b.post(-1.7, y + 0.05, 0.32, 0.06)))
    circ.push(ys.map((y) => b.post(1.7, y + 0.05, 0.32, 0.06)))
  }
  return b.done(id, h + 0.8, circ, [])
}

/** Poste de baja tensión o de teléfono con un solo cable (trenzado) en una palomilla. */
function lowPole(id: string, kind: 'wood' | 'concrete', h: number): Template {
  const b = new Builder()
  if (kind === 'wood') b.both([0, 0, 0], [0, h, 0], 0.13, WOOD, 0.095)
  else b.both([0, 0, 0], [0, h, 0], 0.16, CONCRETE, 0.1)
  b.box(-0.2, 0.2, 0, h, 0.2)
  const y = h - 0.7
  b.bar([0.08, y, 0], [0.26, y, 0], 0.025, 4)
  return b.done(id, h, [[[0.26, y - 0.05]]], [])
}

/** Pórtico de entrada a una subestación. */
function portal(id: string, k: number): Template {
  const b = new Builder()
  const h = 16 * k
  const s = 6 * k
  for (const sx of [-1, 1]) {
    b.both([sx * s, 0, 0], [sx * s, h, 0], 0.35 * k, STEEL, 0.25 * k)
    b.box(sx * s - 0.5, sx * s + 0.5, 0, h, 0.5)
  }
  b.both([-s - 0.5, h, 0], [s + 0.5, h, 0], 0.4 * k)
  b.box(-s - 0.5, s + 0.5, h - 0.5, h + 0.5, 0.5)
  const phases = [-0.65 * s, 0, 0.65 * s].map((x): [number, number] => b.string(x, h - 0.4, 1.6 * k, 0.1))
  const earth = [-1, 1].map((sx) => b.peak(sx * s, h, 0.3 * k, 2.5 * k, 0.05))
  return b.done(id, h + 2.5 * k, [phases], earth)
}

// ---------------------------------------------------------------------------
// Elección

/** Escalón de tensión: 0 baja, 1 media, 2 45-66 kV, 3 110-132, 4 220, 5 400, 6 teléfono. */
export type VClass = 0 | 1 | 2 | 3 | 4 | 5 | 6

export function vclass(kind: number, kv: number, nodeType: number): VClass {
  if (kind === 4) return 6
  if (kv <= 0) {
    // sin tensión: power=line en torres → 45-66 kV; minor_line → media
    if (kind === 1) return nodeType === NODE.pole ? 1 : 2
    if (kind === 3) return 0
    return 1
  }
  if (kv <= 1) return 0
  if (kv < 30) return 1
  if (kv < 90) return 2
  if (kv < 150) return 3
  if (kv < 300) return 4
  return 5
}

/** Conductor: radio (m), haz por defecto, parámetro de la catenaria (m), gálibo (m), vano típico (m). */
export const WIRE: Record<VClass, { r: number; bundle: number; c: number; clear: number; span: number; earthR: number }> = {
  0: { r: 0.018, bundle: 1, c: 450, clear: 4, span: 40, earthR: 0 },
  1: { r: 0.0055, bundle: 1, c: 900, clear: 6, span: 110, earthR: 0 },
  2: { r: 0.009, bundle: 1, c: 1400, clear: 7, span: 230, earthR: 0.0065 },
  3: { r: 0.011, bundle: 1, c: 1700, clear: 7, span: 300, earthR: 0.007 },
  4: { r: 0.0135, bundle: 1, c: 1900, clear: 8, span: 350, earthR: 0.0075 },
  5: { r: 0.0152, bundle: 2, c: 2100, clear: 9, span: 420, earthR: 0.008 },
  6: { r: 0.007, bundle: 1, c: 380, clear: 4, span: 45, earthR: 0 },
}

const cache = new Map<string, Template>()
function get(id: string, make: () => Template): Template {
  let t = cache.get(id)
  if (!t) {
    t = make()
    cache.set(id, t)
  }
  return t
}

/**
 * Plantilla del apoyo. `circuits` = circuitos que pasan por él, `nodeType`/`material` del nodo
 * de OSM (si los tiene), `design` = etiqueta design=* resumida (powerFormat.DESIGN).
 */
export function chooseTemplate(vc: VClass, circuits: number, nodeType: number, material: number, design: number): Template {
  const double = circuits >= 2 || design === 3
  if (nodeType === NODE.portal) return vc >= 4 ? get('portal-hv', () => portal('portal-hv', 1)) : get('portal-mv', () => portal('portal-mv', vc >= 2 ? 0.75 : 0.55))
  switch (vc) {
    case 6:
      return get('tel', () => lowPole('tel', 'wood', 7))
    case 0:
      return material === MATERIAL.concrete || material === MATERIAL.tubular ? get('lv-c', () => lowPole('lv-c', 'concrete', 9)) : get('lv-w', () => lowPole('lv-w', 'wood', 8.5))
    case 1: {
      const lattice = material === MATERIAL.lattice || (material === MATERIAL.unknown && nodeType === NODE.tower)
      const id = `mv-${lattice ? 'l' : 'c'}${double ? 2 : 1}`
      return get(id, () => mvPole(id, lattice ? 'lattice' : 'concrete', double))
    }
    case 2:
      return double ? get('hv66-2', () => smallDouble('hv66-2', 1, 1.2)) : get('hv66-1', () => staggered('hv66-1', 0.8, 1.2))
    case 3:
      return double ? get('hv132-2', () => barrel('hv132-2', 0.66, 1.8)) : get('hv132-1', () => staggered('hv132-1', 1.05, 1.7))
    case 4:
      return double ? get('hv220-2', () => barrel('hv220-2', 0.82, 2.8)) : get('hv220-1', () => catHead('hv220-1', 0.82, 2.8))
    default:
      return double || design === 3 ? get('ehv-2', () => barrel('ehv-2', 1, 4.4)) : get('ehv-1', () => catHead('ehv-1', 1, 4.2))
  }
}
