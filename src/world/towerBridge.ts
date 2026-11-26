// Tower Bridge (Londres) procedural, para Landmarks.ts. OpenStreetMap lo tiene por partes
// (building:part) que salían como cajas apiladas, y Bridges.ts lo dibujaba como un colgante
// genérico con pilas cada 34 m. Aquí: sus dos torres góticas de piedra con los cuatro torreones
// y sus pináculos, las dos pasarelas altas entre las torres, las pilas en forma de barco, las
// hojas de las básculas del tablero bajo y los tramos colgantes laterales (las cadenas, que
// cuelgan de lo alto de las torres hasta casi el tablero y suben a las torres de los estribos).
//
// Medidas: Wikipedia (Tower Bridge): torres de 65 m, vano central de 61 m (200 ft) entre pilas,
// pasarelas a 143 ft (~44 m) sobre la pleamar, gálibo de 29 ft con las básculas bajadas, tableros
// de 60 ft de ancho (49 ft en el vano que se abre), pilas de 185 × 70 ft, vanos colgantes de
// 270 ft. Planta y alturas de cada parte: las building:part de OSM (torre 20,2 × 10,5 m hasta
// 47 m, torreones hasta 58, tejado hasta 65, pasarelas de 40 a 45 m, pilas hasta 9 m, torres de
// los estribos 20,3 × 6,9 m hasta 22 m y tejado hasta 30). Las alturas son sobre el agua; lo
// que va con el tablero (el arco de la calzada, las básculas, el punto bajo de las cadenas) se
// pone sobre la calzada que dibuja Bridges.ts, para que casen.

import { BufferAttribute, BufferGeometry, Color, Group, Mesh, Vector3, type Material } from 'three'
import type { TerrainPatch } from './Runways.ts'

/** Centro del puente (entre las dos torres) y rumbo del eje (de la torre sur a la norte), de OSM. */
export const TOWER_BRIDGE = { lat: 51.5055155, lon: -0.075351, bearing: 21.42 }
/** Zona (m a lo largo del eje y a los lados) donde el modelo sustituye a OSM y a Bridges.ts */
export const TOWER_BRIDGE_ZONE = { halfLen: 146, halfWid: 32 }

// medidas (m)
const TOWER_AT = 41.17 // centro de cada torre desde el centro del puente
const ABUT_AT = 138.6 // centro de las torres de los estribos
const TOWER_A = 5.25 // semiancho de la torre a lo largo del eje
const TOWER_C = 10.1 // y a lo ancho
const PIER_A = 10.5 // pila: 70 ft a lo largo
const PIER_C = 22 // 185 ft a lo ancho, con las puntas de tajamar hasta PIER_TIP
const PIER_TIP = 28
const ARCH_C = 7.4 // semiancho del paso de la calzada bajo cada torre
const ABUT_A = 3.45
const ABUT_C = 10.15
const ABUT_ARCH_C = 8.4
/** alturas sobre el agua (OSM) */
const BODY_TOP = 47
const TURRET_TOP = 52
const SPIRE_TOP = 58
const ROOF_RIDGE = 60
const ROOF_TOP = 65
const WALK_LOW = 40
const WALK_TOP = 45
const ABUT_BODY = 22
const ABUT_ROOF = 30

// colores (sRGB)
// piedra de Portland y granito de Cornualles, gris claro; el acero, azul claro y blanco (2008)
const STONE = new Color(0xcbc7bb)
const STONE_DARK = new Color(0xa9a497)
const GRANITE = new Color(0xa6a297)
const SLATE = new Color(0x505860)
const BLUE = new Color(0x9cc3e2)
const WHITE = new Color(0xeef2f4)
const WINDOW = new Color(0x2c3036)
const ASPHALT = new Color(0x45484b)
for (const c of [STONE, STONE_DARK, GRANITE, SLATE, BLUE, WHITE, WINDOW, ASPHALT]) c.convertSRGBToLinear()

/** Geometría con color por vértice, en coordenadas del puente: a = a lo largo (norte), c = a lo ancho (este), y = altura. */
class Painter {
  pos: number[] = []
  col: number[] = []
  P = (a: number, c: number, y: number) => new Vector3(c, y, -a)

  tri(p: Vector3, q: Vector3, r: Vector3, col: Color): void {
    for (const v of [p, q, r]) {
      this.pos.push(v.x, v.y, v.z)
      this.col.push(col.r, col.g, col.b)
    }
  }

  /** cuadrilátero con la cara hacia fuera de `inside` */
  quad(p: Vector3, q: Vector3, r: Vector3, s: Vector3, col: Color, inside: Vector3): void {
    const n = new Vector3().subVectors(q, p).cross(new Vector3().subVectors(s, p))
    if (n.lengthSq() < 1e-12) n.subVectors(q, p).cross(new Vector3().subVectors(r, p))
    if (n.dot(new Vector3().subVectors(p, inside)) < 0) {
      this.tri(p, s, r, col)
      this.tri(p, r, q, col)
    } else {
      this.tri(p, q, r, col)
      this.tri(p, r, s, col)
    }
  }

  /** prisma vertical de planta poligonal (a, c) entre dos alturas */
  prism(ring: Array<[number, number]>, y0: number, y1: number, col: Color, top = true, bottom = false): void {
    const ca = ring.reduce((s, p) => s + p[0], 0) / ring.length
    const cc = ring.reduce((s, p) => s + p[1], 0) / ring.length
    const inside = this.P(ca, cc, (y0 + y1) / 2)
    for (let i = 0; i < ring.length; i++) {
      const [a0, c0] = ring[i]
      const [a1, c1] = ring[(i + 1) % ring.length]
      this.quad(this.P(a0, c0, y0), this.P(a1, c1, y0), this.P(a1, c1, y1), this.P(a0, c0, y1), col, inside)
    }
    const below = this.P(ca, cc, y0 - 1)
    const above = this.P(ca, cc, y1 + 1)
    for (let i = 1; i + 1 < ring.length; i++) {
      const [a0, c0] = ring[0]
      const [a1, c1] = ring[i]
      const [a2, c2] = ring[i + 1]
      if (top) this.quad(this.P(a0, c0, y1), this.P(a1, c1, y1), this.P(a2, c2, y1), this.P(a2, c2, y1), col, below)
      if (bottom) this.quad(this.P(a0, c0, y0), this.P(a1, c1, y0), this.P(a2, c2, y0), this.P(a2, c2, y0), col, above)
    }
  }

  box(a0: number, a1: number, c0: number, c1: number, y0: number, y1: number, col: Color, top = true): void {
    this.prism([[a0, c0], [a1, c0], [a1, c1], [a0, c1]], y0, y1, col, top)
  }

  /** pirámide (o tejado a cuatro aguas si la cumbrera tiene largo) sobre un rectángulo */
  hip(a0: number, a1: number, c0: number, c1: number, y0: number, y1: number, ridgeC: number, col: Color): void {
    const am = (a0 + a1) / 2
    const cm = (c0 + c1) / 2
    const r0 = this.P(am, cm - ridgeC, y1)
    const r1 = this.P(am, cm + ridgeC, y1)
    const inside = this.P(am, cm, y0)
    const A = this.P(a0, c0, y0)
    const B = this.P(a1, c0, y0)
    const C = this.P(a1, c1, y0)
    const D = this.P(a0, c1, y0)
    this.quad(A, B, r0, r0, col, inside) // faldón del lado c0
    this.quad(C, D, r1, r1, col, inside)
    this.quad(B, C, r1, r0, col, inside)
    this.quad(D, A, r0, r1, col, inside)
  }

  /** torreón octogonal con su chapitel */
  turret(a: number, c: number, r: number, y0: number, y1: number, tip: number, col: Color, roof: Color): void {
    const ring: Array<[number, number]> = []
    for (let k = 0; k < 8; k++) {
      const t = ((k + 0.5) / 8) * Math.PI * 2
      ring.push([a + r * Math.cos(t), c + r * Math.sin(t)])
    }
    this.prism(ring, y0, y1, col, false)
    const apex = this.P(a, c, tip)
    const inside = this.P(a, c, y1)
    for (let k = 0; k < 8; k++) {
      const [a0, c0] = ring[k]
      const [a1, c1] = ring[(k + 1) % 8]
      this.quad(this.P(a0, c0, y1), this.P(a1, c1, y1), apex, apex, roof, inside)
    }
  }

  /** barra de sección rectangular entre dos puntos (a, c, y) */
  beam(p: [number, number, number], q: [number, number, number], w: number, h: number, col: Color): void {
    const A = this.P(...p)
    const B = this.P(...q)
    const dir = new Vector3().subVectors(B, A)
    const len = dir.length()
    if (len < 1e-4) return
    dir.divideScalar(len)
    const side = new Vector3(dir.z, 0, -dir.x)
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0)
    side.normalize()
    const up = new Vector3().crossVectors(side, dir).normalize()
    const k = (v: Vector3, s: number, u: number) => v.clone().addScaledVector(side, (s * w) / 2).addScaledVector(up, (u * h) / 2)
    const inside = new Vector3().addVectors(A, B).multiplyScalar(0.5)
    const ring: Array<[number, number]> = [[1, 1], [-1, 1], [-1, -1], [1, -1]]
    for (let i = 0; i < 4; i++) {
      const [s0, u0] = ring[i]
      const [s1, u1] = ring[(i + 1) % 4]
      this.quad(k(A, s0, u0), k(A, s1, u1), k(B, s1, u1), k(B, s0, u0), col, inside)
    }
  }

  geometry(): BufferGeometry {
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3))
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3))
    g.computeVertexNormals()
    g.computeBoundingSphere()
    return g
  }
}

/**
 * Puerta gótica: dos machones a los lados del paso de la calzada, el arco apuntado y el cuerpo de
 * encima, en la torre centrada en `a` (semiancho ha a lo largo, hc a lo ancho), de y0 a top.
 */
function gate(p: Painter, a: number, ha: number, hc: number, open: number, y0: number, spring: number, apex: number, top: number, col: Color): void {
  // machones
  p.box(a - ha, a + ha, -hc, -open, y0, top, col, false)
  p.box(a - ha, a + ha, open, hc, y0, top, col, false)
  // cuerpo sobre el arco
  p.box(a - ha, a + ha, -open, open, apex, top, col)
  // tímpano: el hueco apuntado entre los machones, en las dos caras, y su intradós
  const N = 10
  const curve: Array<[number, number]> = []
  for (let k = 0; k <= N; k++) {
    // arco apuntado equilátero: cada mitad, 60° de una circunferencia de radio igual a la luz con
    // centro en el arranque contrario (la altura, escalada a la de la clave)
    const t = k / N
    const side = t < 0.5 ? -1 : 1
    const u = t < 0.5 ? t * 2 : (1 - t) * 2 // 0 en el arranque, 1 en la clave
    const phi = (u * Math.PI) / 3
    curve.push([-side * (open - 2 * open * Math.cos(phi)), spring + ((apex - spring) * Math.sin(phi)) / Math.sin(Math.PI / 3)])
  }
  for (const face of [a - ha, a + ha]) {
    const inside = p.P(a, 0, (spring + apex) / 2)
    for (let k = 0; k < N; k++) {
      const [c0, y0b] = curve[k]
      const [c1, y1b] = curve[k + 1]
      p.quad(p.P(face, c0, y0b), p.P(face, c1, y1b), p.P(face, c1, apex), p.P(face, c0, apex), col, inside)
    }
  }
  for (let k = 0; k < N; k++) {
    const [c0, y0b] = curve[k]
    const [c1, y1b] = curve[k + 1]
    p.quad(p.P(a - ha, c0, y0b), p.P(a - ha, c1, y1b), p.P(a + ha, c1, y1b), p.P(a + ha, c0, y0b), col, p.P(a, 0, apex + 5))
  }
}

/** ventanas góticas oscuras en una cara (a lo ancho, en c = ±face) */
function windows(p: Painter, a: number, ha: number, faceC: number, levels: number[], h: number): void {
  const s = Math.sign(faceC)
  const c0 = faceC - 0.1 * s
  const c1 = faceC + 0.15 * s
  for (const y of levels) for (const da of [-ha * 0.45, ha * 0.45]) p.box(a + da - 0.8, a + da + 0.8, Math.min(c0, c1), Math.max(c0, c1), y, y + h, WINDOW)
}

export interface TowerBridgeModel {
  object: Group
  inside(x: number, y: number, z: number): boolean
  /** calzada bajo las torres (y sobre el agua) o null fuera de ese paso */
  deckAt(x: number, z: number): number | null
}

/**
 * El modelo, con el agua en y = 0 y la calzada a `deck` m sobre ella (la que dibuja Bridges.ts en
 * las torres). `material`: con color por vértice, ya iluminado (alfa 0).
 */
export function buildTowerBridge(material: Material, deck: number): TowerBridgeModel {
  const p = new Painter()
  const D = deck
  // --- pilas en forma de barco y torres principales
  for (const s of [-1, 1]) {
    const a = s * TOWER_AT
    p.prism(
      [
        [a - PIER_A, -PIER_C],
        [a, -PIER_TIP],
        [a + PIER_A, -PIER_C],
        [a + PIER_A, PIER_C],
        [a, PIER_TIP],
        [a - PIER_A, PIER_C],
      ],
      -3,
      D - 1.4,
      GRANITE,
    )
    gate(p, a, TOWER_A, TOWER_C - 1.2, ARCH_C, D - 1.4, D + 7.5, D + 13.5, BODY_TOP, STONE)
    // impostas: bandas algo más salientes y más oscuras
    for (const y of [D + 14, 29, BODY_TOP - 1.2]) p.box(a - TOWER_A - 0.25, a + TOWER_A + 0.25, -TOWER_C + 0.95, TOWER_C - 0.95, y, y + 0.7, STONE_DARK)
    // torreones en las cuatro esquinas, con sus pináculos
    for (const da of [-1, 1]) for (const dc of [-1, 1]) p.turret(a + da * (TOWER_A - 0.9), dc * (TOWER_C - 1.5), 1.6, D - 1.4, TURRET_TOP, SPIRE_TOP, STONE, SLATE)
    // tejado a cuatro aguas con su aguja
    p.hip(a - TOWER_A + 0.6, a + TOWER_A - 0.6, -TOWER_C + 2.2, TOWER_C - 2.2, BODY_TOP, ROOF_RIDGE, 3.5, SLATE)
    p.turret(a, 0, 0.9, ROOF_RIDGE - 1.5, ROOF_RIDGE + 1, ROOF_TOP, STONE_DARK, SLATE)
    // buhardillas (gabletes) en las caras del río
    for (const dc of [-1, 1]) {
      const c0 = dc * (TOWER_C - 2.4)
      p.box(a - 1.6, a + 1.6, Math.min(c0, c0 + dc * 1.5), Math.max(c0, c0 + dc * 1.5), BODY_TOP, BODY_TOP + 3.5, STONE)
      p.hip(a - 1.6, a + 1.6, Math.min(c0, c0 + dc * 1.5), Math.max(c0, c0 + dc * 1.5), BODY_TOP + 3.5, BODY_TOP + 6, 0, SLATE)
    }
    // calzada bajo la torre: OSM corta ahí el puente (el tramo bajo cada torre no es «bridge») y
    // Bridges.ts no la dibuja; también es suelo para el aparato y los coches (deckAt)
    p.box(a - TOWER_A - 1, a + TOWER_A + 1, -ARCH_C, ARCH_C, D - 1.2, D, ASPHALT)
    // ventanas: caras del río y de la calzada
    for (const dc of [-1, 1]) windows(p, a, TOWER_A, dc * (TOWER_C - 1.2), [D + 16, 31, 39], 5.5)
    for (const da of [-1, 1]) {
      const face = a + da * (TOWER_A + 0.12)
      for (const y of [D + 16, 31, 39]) for (const dc of [-3.2, 3.2]) p.box(face - 0.12, face + 0.12, dc - 0.8, dc + 0.8, y, y + 5.5, WINDOW)
    }
  }
  // --- pasarelas altas (celosía azul y blanca) entre las dos torres
  const w0 = -TOWER_AT + TOWER_A
  const w1 = TOWER_AT - TOWER_A
  for (const dc of [-1, 1]) {
    const c = dc * (TOWER_C - 1.95)
    p.box(w0, w1, c - 1.6, c + 1.6, WALK_LOW + 0.6, WALK_TOP - 0.6, WHITE)
    // cordones arriba y abajo
    for (const y of [WALK_LOW + 0.3, WALK_TOP - 0.3]) for (const cc of [c - 1.75, c + 1.75]) p.beam([w0, cc, y], [w1, cc, y], 0.45, 0.6, BLUE)
    // celosía en las dos caras
    const bays = 14
    for (const cc of [c - 1.72, c + 1.72]) {
      for (let k = 0; k < bays; k++) {
        const a0 = w0 + ((w1 - w0) * k) / bays
        const a1 = w0 + ((w1 - w0) * (k + 1)) / bays
        p.beam([a0, cc, WALK_LOW + 0.5], [a1, cc, WALK_TOP - 0.5], 0.3, 0.3, BLUE)
        p.beam([a0, cc, WALK_TOP - 0.5], [a1, cc, WALK_LOW + 0.5], 0.3, 0.3, BLUE)
      }
    }
  }
  // --- básculas: las vigas laterales de las dos hojas, pintadas, con la junta en el centro
  const b0 = -TOWER_AT + PIER_A
  const b1 = TOWER_AT - PIER_A
  for (const dc of [-1, 1]) {
    const c = dc * (ARCH_C - 0.2)
    p.beam([b0, c, D - 0.9], [-0.15, c, D - 0.9], 0.5, 1.7, BLUE)
    p.beam([0.15, c, D - 0.9], [b1, c, D - 0.9], 0.5, 1.7, BLUE)
  }
  // --- torres de los estribos
  for (const s of [-1, 1]) {
    const a = s * ABUT_AT
    gate(p, a, ABUT_A, ABUT_C, ABUT_ARCH_C, -1, D + 6, D + 9.5, ABUT_BODY, STONE)
    for (const da of [-1, 1]) for (const dc of [-1, 1]) p.turret(a + da * (ABUT_A - 0.7), dc * (ABUT_C - 1), 1.1, -1, ABUT_BODY + 1.5, ABUT_BODY + 5.5, STONE, SLATE)
    p.hip(a - ABUT_A + 0.3, a + ABUT_A - 0.3, -ABUT_C + 1.6, ABUT_C - 1.6, ABUT_BODY, ABUT_ROOF, 5, SLATE)
    p.box(a - ABUT_A - 0.2, a + ABUT_A + 0.2, -ABUT_C + 0.6, ABUT_C - 0.6, D + 10, D + 10.6, STONE_DARK)
  }
  // --- tramos colgantes laterales: las cadenas (vigas de celosía) de lo alto de la torre a la del
  // estribo, bajando hasta casi el tablero, con sus péndolas
  const chainC = ARCH_C + 1.3
  for (const s of [-1, 1]) {
    const aT = s * (TOWER_AT + TOWER_A) // cara de la torre
    const aA = s * (ABUT_AT - ABUT_A) // cara del estribo
    const yT = WALK_LOW - 1
    const yA = ABUT_BODY - 3
    const yLow = D + 1.6
    // parábola con su punto bajo donde las dos ramas dan las alturas de los extremos
    const r = Math.sqrt((yT - yLow) / (yA - yLow))
    const xm = r / (1 + r) // fracción del vano (desde la torre) del punto bajo
    const L = Math.abs(aA - aT)
    const k = (yT - yLow) / (xm * L) ** 2
    const yAt = (x: number) => yLow + k * (x - xm * L) ** 2
    const N = 18
    for (const dc of [-1, 1]) {
      const c = dc * chainC
      for (let i = 0; i < N; i++) {
        const x0 = (L * i) / N
        const x1 = (L * (i + 1)) / N
        p.beam([aT + s * x0, c, yAt(x0)], [aT + s * x1, c, yAt(x1)], 0.9, 1.6, BLUE)
        if (i > 0 && yAt(x0) > D + 2.6) p.beam([aT + s * x0, c, yAt(x0) - 0.8], [aT + s * x0, c, D + 0.6], 0.14, 0.3, BLUE)
      }
    }
  }
  const object = new Group()
  object.add(new Mesh(p.geometry(), material))

  const inPier = (a: number, c: number) => Math.abs(c) <= PIER_TIP - (PIER_TIP - PIER_C) * (Math.abs(a) / PIER_A) && Math.abs(a) <= PIER_A
  return {
    object,
    deckAt(x: number, z: number) {
      const along = -z
      if (Math.abs(x) > ARCH_C) return null
      for (const s of [-1, 1]) if (Math.abs(along - s * TOWER_AT) <= TOWER_A + 1) return D
      return null
    },
    // modelo: x = a lo ancho, y = altura sobre el agua, z = −a lo largo
    inside(x: number, y: number, z: number) {
      const along = -z
      const c = Math.abs(x)
      for (const s of [-1, 1]) {
        const a = along - s * TOWER_AT
        if (Math.abs(a) <= PIER_A && y < D - 1.4 && inPier(a, x)) return true
        if (Math.abs(a) <= TOWER_A + 0.3 && c <= TOWER_C) {
          if (y > ROOF_RIDGE + 1 && y < ROOF_TOP && c < 1.5 && Math.abs(a) < 1.5) return true
          if (y > D - 1.4 && y < ROOF_RIDGE) {
            // bajo el arco se pasa (por la calzada)
            if (c < ARCH_C && y < D + 7.5 + (6 * (ARCH_C - c)) / ARCH_C) return false
            return true
          }
          if (y >= ROOF_RIDGE - 4 && y < SPIRE_TOP && c > TOWER_C - 3.1) return true
        }
        const ab = along - s * ABUT_AT
        if (Math.abs(ab) <= ABUT_A + 0.3 && c <= ABUT_C && y > -1 && y < ABUT_ROOF) {
          if (c < ABUT_ARCH_C && y < D + 6 + (3.5 * (ABUT_ARCH_C - c)) / ABUT_ARCH_C) return false
          return true
        }
      }
      // pasarelas
      if (Math.abs(along) < TOWER_AT - TOWER_A && y > WALK_LOW && y < WALK_TOP && c > TOWER_C - 3.75 && c < TOWER_C - 0.15) return true
      return false
    },
  }
}

/**
 * El relieve global (SRTM, ~30 m) trae el puente metido en el río como lomas alrededor de las
 * pilas: en el tramo de río del puente (hasta ~90 m del centro a lo largo, 45 m a los lados) el
 * terreno no pasa del agua (cota 0), con 15 m de transición.
 */
export function towerBridgeRiverPatch(): TerrainPatch {
  const k = Math.PI / 180
  const mLat = 111250
  const mLon = 111320 * Math.cos(TOWER_BRIDGE.lat * k)
  const b = TOWER_BRIDGE.bearing * k
  const HL = 90
  const HW = 45
  const BLEND = 15
  const r = Math.hypot(HL + BLEND, HW + BLEND)
  const smooth = (t: number) => t * t * (3 - 2 * t)
  return {
    key: 'landmark:towerbridge:rio',
    south: TOWER_BRIDGE.lat - r / mLat,
    north: TOWER_BRIDGE.lat + r / mLat,
    west: TOWER_BRIDGE.lon - r / mLon,
    east: TOWER_BRIDGE.lon + r / mLon,
    maxCell: 40,
    apply(lat: number, lon: number, h: number): number {
      if (h <= 0) return h
      const n = (lat - TOWER_BRIDGE.lat) * mLat
      const e = (lon - TOWER_BRIDGE.lon) * mLon
      const along = Math.abs(n * Math.cos(b) + e * Math.sin(b))
      const across = Math.abs(e * Math.cos(b) - n * Math.sin(b))
      if (along >= HL + BLEND || across >= HW + BLEND) return h
      const w = smooth(Math.min(1, (HL + BLEND - along) / BLEND)) * smooth(Math.min(1, (HW + BLEND - across) / BLEND))
      return h * (1 - w)
    },
  }
}

/** ¿(lat, lon) cae en la zona del puente? (para quitar las partes de OSM y lo genérico de Bridges.ts) */
export function inTowerBridgeZone(lat: number, lon: number): boolean {
  const k = Math.PI / 180
  const n = (lat - TOWER_BRIDGE.lat) * 111250
  const e = (lon - TOWER_BRIDGE.lon) * 111320 * Math.cos(TOWER_BRIDGE.lat * k)
  const b = TOWER_BRIDGE.bearing * k
  const along = n * Math.cos(b) + e * Math.sin(b)
  const across = e * Math.cos(b) - n * Math.sin(b)
  return Math.abs(along) <= TOWER_BRIDGE_ZONE.halfLen && Math.abs(across) <= TOWER_BRIDGE_ZONE.halfWid
}
