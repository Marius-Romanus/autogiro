// Torres de puente que OSM trae como edificio: cuáles son y por dónde pasan los tableros.
//
// En el 25 de Abril, Brooklyn, Manhattan, Williamsburg, Verrazzano, la Bahía de San Francisco,
// Forth, Akashi o el Gran Belt cada torre es un solo edificio desde el suelo hasta lo alto cuya
// huella cubre todo el ancho del puente: salía un bloque con ventanas que atravesaban la calzada,
// las vías y los coches. (El Golden Gate no: sus torres vienen por partes, patas aparte y
// travesaños finos, y se dibujan como siempre.) Se reconocen por la geometría (un edificio alto
// que una línea de puente cruza de lado a lado por su lado corto) y se dibujan como patas a los
// lados de los tableros (Buildings.ts), con travesaños en lo alto, sin ventanas y con el color del
// puente. Buildings.ts no sabe a qué altura va el tablero (lo calcula Bridges.ts), así que pone
// los travesaños por proporción (en estas torres el tablero va por debajo de la mitad: 25 de
// Abril, 0,4; Akashi, 0,25). Los choques salen de las piezas (patas y travesaños), así que entre
// las patas se pasa. Bridges.ts (`towerClusters` en bridgeShapes.ts) las sigue encontrando por su
// centro y su altura para ajustar el vano y colgar los cables, que caen junto a la cara interior
// de las patas; bridgeNet.ts guarda además en cada edificio alto si es una de estas torres y dónde
// quedan sus patas (`TallBuilding.cut`), y bridgeShapes.ts pone entre ellas la riostra bajo el
// tablero, que sí sabe a qué altura va.
//
// Lo usan Buildings.ts (dibujo) y bridgeNet.ts (riostra); no importa ninguno de los dos.

/** ancho y tipo de tablero de una clase de vía (`widthOf` de bridgeNet.ts) */
export type WidthOf = (cls: string, sub: string, oneway: boolean, ramp: boolean) => { kind: string; width: number } | null

/** holgura a cada lado de los tableros (m): pretiles; los cables cuelgan a 1,3 m del borde */
export const TOWER_MARGIN = 1
/** entre dos tableros más juntos que esto no queda pata (m) */
export const TOWER_MIN_GAP = 2.5

/** Línea de puente de la tesela con tablero en Bridges.ts y el semiancho de este (unidades de la tesela). */
export interface DeckLine {
  pts: Array<[number, number]>
  hw: number
  /** carretera o tren (no pasarela, vial de servicio ni pista) */
  main: boolean
  x0: number
  y0: number
  x1: number
  y1: number
}

/** Torre atravesada por los tableros (unidades de la tesela): eje del puente y franjas de los tableros. */
export interface TowerCut {
  ux: number
  uy: number
  cx: number
  cy: number
  /** desfase lateral de la huella, v = (p − c) · (−uy, ux) */
  v0: number
  v1: number
  /** franjas de los tableros con su holgura, ordenadas y separadas al menos TOWER_MIN_GAP */
  lanes: Array<[number, number]>
}

/** Las líneas de puente de la tesela que dibuja Bridges.ts (las que tienen ancho de tablero). */
export function deckLines(vt: { layers: Record<string, any> }, E: number, mPerPx: number, widthOf: WidthOf): DeckLine[] {
  const layer = vt.layers.transportation
  const out: DeckLine[] = []
  if (!layer || layer.extent !== E) return out
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i)
    const p = f.properties as Record<string, unknown>
    if (f.type !== 2 || p.brunnel !== 'bridge') continue
    const w = widthOf(String(p.class ?? ''), String(p.subclass ?? ''), Number(p.oneway ?? 0) !== 0, Number(p.ramp ?? 0) === 1)
    if (!w) continue
    for (const line of f.loadGeometry() as Array<Array<{ x: number; y: number }>>) {
      if (line.length < 2) continue
      const pts = line.map((q) => [q.x, q.y] as [number, number])
      let x0 = Infinity
      let y0 = Infinity
      let x1 = -Infinity
      let y1 = -Infinity
      for (const [x, y] of pts) {
        x0 = Math.min(x0, x)
        x1 = Math.max(x1, x)
        y0 = Math.min(y0, y)
        y1 = Math.max(y1, y)
      }
      // (los viales de servicio tampoco: rampas de aparcamiento que cruzan los podios de Kowloon)
      out.push({ pts, hw: w.width / 2 / mPerPx, main: w.kind === 'rail' || (w.kind === 'road' && w.width >= 5.5), x0, y0, x1, y1 })
    }
  }
  return out
}

/** Parámetro t en A→B del corte con el segmento P→Q (−1 si no se cortan). */
function segCut(ax: number, ay: number, bx: number, by: number, p: [number, number], q: [number, number]): number {
  const rx = bx - ax
  const ry = by - ay
  const sx = q[0] - p[0]
  const sy = q[1] - p[1]
  const den = rx * sy - ry * sx
  if (Math.abs(den) < 1e-12) return -1
  const t = ((p[0] - ax) * sy - (p[1] - ay) * sx) / den
  const u = ((p[0] - ax) * ry - (p[1] - ay) * rx) / den
  return u >= 0 && u <= 1 ? t : -1
}

/**
 * ¿Es la huella una torre de puente que atraviesan los tableros? Lo es si una carretera o una vía
 * de tren en puente la cruza de lado a lado (entra y sale; las pasarelas y los viales de servicio no
 * cuentan: en Hong Kong o en la City de Londres las peatonales elevadas atraviesan rascacielos, y en
 * Kowloon las rampas de servicio, los podios), si la huella es delgada a
 * lo largo del puente (lo que la línea recorre dentro, como mucho 0,8 veces su ancho y 40 m: una
 * torre, no un estribo o un bloque que el puente recorre a lo largo) y si los tableros ocupan al
 * menos el 30 % de su ancho, más o menos centrados (lo que queda a un lado y al otro no difiere en
 * más de un cuarto del ancho) y sin salirse más de 3 m por los lados.
 */
export function towerCut(ring: Array<[number, number]>, lines: DeckLine[], mPerPx: number): TowerCut | null {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const [x, y] of ring) {
    x0 = Math.min(x0, x)
    x1 = Math.max(x1, x)
    y0 = Math.min(y0, y)
    y1 = Math.max(y1, y)
  }
  const rings = [{ pts: ring }]
  // lo que cada línea recorre dentro de la huella
  const inside: Array<{ segs: number[]; len: number; dx: number; dy: number; hw: number; main: boolean; through: boolean }> = []
  for (const l of lines) {
    if (l.x1 < x0 || l.x0 > x1 || l.y1 < y0 || l.y0 > y1) continue
    const segs: number[] = []
    let len = 0
    let dx = 0
    let dy = 0
    for (let k = 1; k < l.pts.length; k++) {
      const [ax, ay] = l.pts[k - 1]
      const [bx, by] = l.pts[k]
      if (Math.max(ax, bx) < x0 || Math.min(ax, bx) > x1 || Math.max(ay, by) < y0 || Math.min(ay, by) > y1) continue
      const ts = [0, 1]
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const t = segCut(ax, ay, bx, by, ring[j], ring[i])
        if (t > 0 && t < 1) ts.push(t)
      }
      ts.sort((p, q) => p - q)
      for (let m = 1; m < ts.length; m++) {
        const ta = ts[m - 1]
        const tb = ts[m]
        if (tb - ta < 1e-9) continue
        const tm = (ta + tb) / 2
        if (!inRings(rings, ax + (bx - ax) * tm, ay + (by - ay) * tm)) continue
        const px = ax + (bx - ax) * ta
        const py = ay + (by - ay) * ta
        const qx = ax + (bx - ax) * tb
        const qy = ay + (by - ay) * tb
        segs.push(px, py, qx, qy)
        len += Math.hypot(qx - px, qy - py)
        dx += qx - px
        dy += qy - py
      }
    }
    if (len * mPerPx < 0.5) continue
    const a = l.pts[0]
    const z = l.pts[l.pts.length - 1]
    inside.push({ segs, len, dx, dy, hw: l.hw, main: l.main, through: !inRings(rings, a[0], a[1]) && !inRings(rings, z[0], z[1]) })
  }
  const through = inside.filter((c) => c.main && c.through && c.len * mPerPx >= 2)
  if (through.length === 0) return null
  // eje del puente: el rumbo medio de las que la cruzan
  let ux = 0
  let uy = 0
  for (const c of through) {
    const s = c.dx * through[0].dx + c.dy * through[0].dy >= 0 ? 1 : -1
    ux += s * c.dx
    uy += s * c.dy
  }
  const ul = Math.hypot(ux, uy)
  if (ul < 1e-9) return null
  ux /= ul
  uy /= ul
  let cx = 0
  let cy = 0
  for (const [x, y] of ring) {
    cx += x
    cy += y
  }
  cx /= ring.length
  cy /= ring.length
  const vOf = (x: number, y: number) => (y - cy) * ux - (x - cx) * uy
  let v0 = Infinity
  let v1 = -Infinity
  for (const [x, y] of ring) {
    const v = vOf(x, y)
    v0 = Math.min(v0, v)
    v1 = Math.max(v1, v)
  }
  const W = (v1 - v0) * mPerPx
  let chord = 0
  for (const c of through) chord = Math.max(chord, c.len * mPerPx)
  if (W < 8 || chord > Math.min(40, 0.8 * W)) return null
  // franjas de los tableros (solo las líneas que van más o menos a lo largo del eje)
  const margin = TOWER_MARGIN / mPerPx
  const iv: Array<[number, number]> = []
  for (const c of inside) {
    if (Math.abs(c.dx * ux + c.dy * uy) < 0.85 * Math.hypot(c.dx, c.dy)) continue
    let a = Infinity
    let b = -Infinity
    for (let k = 0; k < c.segs.length; k += 2) {
      const v = vOf(c.segs[k], c.segs[k + 1])
      a = Math.min(a, v)
      b = Math.max(b, v)
    }
    iv.push([a - c.hw - margin, b + c.hw + margin])
  }
  if (iv.length === 0) return null
  iv.sort((p, q) => p[0] - q[0])
  const lanes: Array<[number, number]> = []
  const gap = TOWER_MIN_GAP / mPerPx
  for (const r of iv) {
    const last = lanes[lanes.length - 1]
    if (last && r[0] - last[1] < gap) last[1] = Math.max(last[1], r[1])
    else lanes.push([r[0], r[1]])
  }
  const over = 3 / mPerPx
  if (lanes[0][0] < v0 - over || lanes[lanes.length - 1][1] > v1 + over) return null
  if (Math.abs(lanes[0][0] - v0 - (v1 - lanes[lanes.length - 1][1])) * mPerPx > 0.25 * W) return null
  let wide = 0
  for (const [a, b] of lanes) wide += Math.min(b, v1) - Math.max(a, v0)
  if (wide * mPerPx < 0.3 * W) return null
  return { ux, uy, cx, cy, v0, v1, lanes }
}

/** ¿(x, y) dentro de los anillos? (par-impar) */
function inRings(rings: Array<{ pts: Array<[number, number]> }>, x: number, y: number): boolean {
  let inside = false
  for (const { pts: r } of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      if (r[i][1] > y !== r[j][1] > y && x < ((r[j][0] - r[i][0]) * (y - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) inside = !inside
    }
  }
  return inside
}
