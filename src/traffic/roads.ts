// Calles y carreteras de una tesela z14 de OpenFreeMap (capa `transportation`, esquema
// OpenMapTiles) listas para hacer la red de tráfico: solo las que llevan coches, recortadas a la
// tesela y con los cruces reparados.
//
// Las teselas vienen simplificadas: el vértice donde una calle desemboca en otra a veces
// desaparece de la línea que sigue recta (queda una «T» sin punto común), y en algunos cruces en
// «X» ninguna de las dos líneas conserva el vértice. Aquí se recuperan: el extremo que cae sobre
// otra línea (≤ 1 m) se une a ella y dos líneas que se cortan a la misma altura (misma capa, ni
// puente ni túnel distinto) se cortan en el punto de cruce. Sin three.js ni DOM (worker y Node).

import type { VectorTile } from '@mapbox/vector-tile'

/** unidades por tesela */
export const E = 4096

export type RoadClass = 'motorway' | 'trunk' | 'primary' | 'secondary' | 'tertiary' | 'minor'

/** importancia de cada clase de vía (más alta = más principal) */
export const RANK: Record<RoadClass, number> = { motorway: 6, trunk: 5, primary: 4, secondary: 3, tertiary: 2, minor: 1 }

export interface RoadLine {
  cls: RoadClass
  /** 1 = sentido único en el sentido de la línea, -1 = al revés, 0 = doble sentido */
  oneway: -1 | 0 | 1
  ramp: boolean
  /** 0 = a nivel, 1 = puente, -1 = túnel */
  brunnel: number
  layer: number
  /**
   * Anillo cerrado casi circular con varias calles alrededor (una rotonda): 1 = sus vértices van
   * en sentido antihorario visto desde arriba, -1 = horario, 0 = no es rotonda. Las rotondas son
   * de sentido único aunque OSM no lo diga (va implícito en junction=roundabout, que las teselas
   * no traen): la red le da el sentido de la circulación del país.
   */
  loop: number
  /** pasa por suelo urbano (residencial, comercial, industrial): límites de ciudad, semáforos */
  urban: boolean
  /** vértices en unidades de la tesela (0..E): x, y alternados */
  pts: number[]
}

export interface RoadTile {
  x: number
  y: number
  lines: RoadLine[]
  /** edificios de la tesela (para saber si es ciudad) */
  buildings: number
  /** vías de tren (las de servicio de las playas de vías no: ahí no circula nadie) */
  rails: RailLine[]
  /** estaciones y apeaderos (unidades de la tesela); `tram`: parada de tranvía */
  stations: Array<{ x: number; y: number; metro: boolean; tram: boolean }>
  /** líneas de ferri (unidades de la tesela, x, y alternados) */
  ferries: number[][]
  /**
   * agua navegable (capa `water`): clase 1 mar, 2 lago o embalse, 3 río, 4 dársena; anillos en
   * unidades de la tesela (x, y alternados; exteriores y huecos, par-impar)
   */
  water: Array<{ cls: number; rings: number[][] }>
  /** pantalanes y muelles (líneas; los que son superficie, su contorno) */
  piers: number[][]
  /** los pantalanes que son superficie (anillos de cada uno): tierra para los barcos */
  pierAreas: number[][][]
  /** zonas industriales (anillos de cada polígono): los puertos */
  industrial: number[][][]
  /** edificios (anillos), solo en las teselas con agua: ningún barco debajo */
  buildingRings: number[][]
}

/** clases de agua de OpenMapTiles por las que pueden ir barcos */
const WATER_CLS: Record<string, number> = { ocean: 1, lake: 2, river: 3, dock: 4 }

/** Vía de tren: 'rail' = ancho normal o ibérico, 'narrow' = vía estrecha, 'metro' = metro, 'tram' = tranvía o metro ligero */
export interface RailLine {
  kind: 'rail' | 'narrow' | 'metro' | 'tram'
  brunnel: number
  layer: number
  pts: number[]
}

/** distancia (unidades) a la que un extremo suelto se une a otra línea (~1,1 m en España) */
const SNAP = 2.5
/** distancia (unidades) a la que un extremo se lleva al vértice de otra línea */
const SNAP_VERTEX = 3
const CELL = 64
const GRID = E / CELL

/** Lee las vías con coches de una tesela vectorial. */
export function parseRoadTile(vt: VectorTile, x: number, y: number): RoadTile {
  const out: RoadTile = { x, y, lines: [], buildings: vt.layers.building?.length ?? 0, rails: [], stations: [], ferries: [], water: [], piers: [], pierAreas: [], industrial: [], buildingRings: [] }
  parseWater(vt, out)
  const poi = vt.layers.poi
  for (let i = 0; poi && i < poi.length; i++) {
    const f = poi.feature(i)
    const p = f.properties as Record<string, unknown>
    if (p.class !== 'railway' || f.type !== 1) continue
    const sub = String(p.subclass ?? '')
    if (sub !== 'station' && sub !== 'halt' && sub !== 'subway' && sub !== 'tram_stop') continue
    const kp = E / poi.extent
    const g = (f.loadGeometry() as Array<Array<{ x: number; y: number }>>)[0]?.[0]
    if (g) out.stations.push({ x: g.x * kp, y: g.y * kp, metro: sub === 'subway', tram: sub === 'tram_stop' })
  }
  const layer = vt.layers.transportation
  if (!layer) return out
  const k = E / layer.extent
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i)
    if (f.type !== 2) continue
    const p = f.properties as Record<string, unknown>
    if (p.class === 'pier') {
      for (const line of f.loadGeometry() as Array<Array<{ x: number; y: number }>>) {
        if (line.length < 2) continue
        const flat: number[] = []
        for (const q of line) flat.push(q.x * k, q.y * k)
        for (const part of clip(flat)) out.piers.push(part)
      }
      continue
    }
    if (p.class === 'ferry') {
      for (const line of f.loadGeometry() as Array<Array<{ x: number; y: number }>>) {
        if (line.length < 2) continue
        const flat: number[] = []
        for (const q of line) flat.push(q.x * k, q.y * k)
        for (const part of clip(flat)) out.ferries.push(part)
      }
      continue
    }
    if (p.class === 'rail' || p.class === 'transit') {
      const sub = String(p.subclass ?? '')
      const kind = p.class === 'rail' ? (sub === 'rail' ? 'rail' : sub === 'narrow_gauge' ? 'narrow' : sub === 'light_rail' ? 'tram' : null) : sub === 'subway' ? 'metro' : sub === 'tram' || sub === 'light_rail' ? 'tram' : null
      // sin las vías de servicio salvo las escapes (unen dos vías paralelas)
      const service = String(p.service ?? '')
      if (!kind || (service && service !== 'crossover')) continue
      const brunnel = p.brunnel === 'bridge' ? 1 : p.brunnel === 'tunnel' ? -1 : 0
      for (const line of f.loadGeometry() as Array<Array<{ x: number; y: number }>>) {
        if (line.length < 2) continue
        const flat: number[] = []
        for (const q of line) flat.push(q.x * k, q.y * k)
        for (const part of clip(flat)) out.rails.push({ kind, brunnel, layer: Number(p.layer ?? 0) || 0, pts: part })
      }
      continue
    }
    const cls = String(p.class ?? '') as RoadClass
    if (!(cls in RANK)) continue
    if (p.access === 'no') continue
    const ow = Number(p.oneway ?? 0)
    const brunnel = p.brunnel === 'bridge' ? 1 : p.brunnel === 'tunnel' ? -1 : 0
    const base = { cls, oneway: (ow > 0 ? 1 : ow < 0 ? -1 : 0) as -1 | 0 | 1, ramp: Number(p.ramp ?? 0) === 1, brunnel, layer: Number(p.layer ?? 0) || 0, loop: 0, urban: false }
    for (const line of f.loadGeometry() as Array<Array<{ x: number; y: number }>>) {
      if (line.length < 2) continue
      const flat: number[] = []
      for (const q of line) flat.push(q.x * k, q.y * k)
      for (const part of clip(flat)) out.lines.push({ ...base, pts: part })
    }
  }
  repairJunctions(out.lines)
  markRoundabouts(out.lines, y)
  markUrban(vt, out.lines)
  // desvíos que la simplificación dejó sin vértice común (los cruces en diamante también se cortan:
  // ahí ningún tren gira, el ángulo no lo permite)
  repairJunctions(out.rails as unknown as RoadLine[])
  return out
}

/** Agua navegable, pantalanes que son superficie y zonas industriales (para los barcos). */
function parseWater(vt: VectorTile, out: RoadTile): void {
  const rings = (f: { loadGeometry(): unknown }, k: number): number[][] => {
    const rs: number[][] = []
    for (const r of f.loadGeometry() as Array<Array<{ x: number; y: number }>>) {
      if (r.length < 3) continue
      const flat: number[] = []
      for (const q of r) flat.push(q.x * k, q.y * k)
      rs.push(flat)
    }
    return rs
  }
  const w = vt.layers.water
  for (let i = 0; w && i < w.length; i++) {
    const f = w.feature(i)
    if (f.type !== 3) continue
    const p = f.properties as Record<string, unknown>
    const cls = WATER_CLS[String(p.class ?? '')]
    if (!cls || Number(p.intermittent ?? 0) === 1 || p.brunnel === 'tunnel') continue
    const rs = rings(f, E / w.extent)
    if (rs.length) out.water.push({ cls, rings: rs })
  }
  const t = vt.layers.transportation
  for (let i = 0; t && i < t.length; i++) {
    const f = t.feature(i)
    if (f.type !== 3 || (f.properties as Record<string, unknown>).class !== 'pier') continue
    const rs = rings(f, E / t.extent)
    for (const r of rs) for (const part of clip(r.concat(r[0], r[1]))) out.piers.push(part)
    if (rs.length) out.pierAreas.push(rs)
  }
  const bl = vt.layers.building
  if (out.water.length && bl) {
    for (let i = 0; i < bl.length; i++) {
      const f = bl.feature(i)
      if (f.type === 3) for (const r of rings(f, E / bl.extent)) out.buildingRings.push(r)
    }
  }
  const lu = vt.layers.landuse
  for (let i = 0; lu && i < lu.length; i++) {
    const f = lu.feature(i)
    if (f.type !== 3 || (f.properties as Record<string, unknown>).class !== 'industrial') continue
    const rs = rings(f, E / lu.extent)
    if (rs.length) out.industrial.push(rs)
  }
}

/** Calles en suelo urbano: su punto medio (o uno de sus extremos) dentro de un uso del suelo de ciudad. */
function markUrban(vt: VectorTile, lines: RoadLine[]): void {
  const lu = vt.layers.landuse
  if (!lu) return
  const k = E / lu.extent
  const polys: Array<{ ring: number[]; x0: number; y0: number; x1: number; y1: number }> = []
  for (let i = 0; i < lu.length; i++) {
    const f = lu.feature(i)
    if (f.type !== 3) continue
    const c = String((f.properties as Record<string, unknown>).class ?? '')
    if (c !== 'residential' && c !== 'commercial' && c !== 'retail' && c !== 'industrial' && c !== 'neighbourhood' && c !== 'quarter') continue
    for (const r of f.loadGeometry() as Array<Array<{ x: number; y: number }>>) {
      const ring: number[] = []
      let x0 = Infinity
      let y0 = Infinity
      let x1 = -Infinity
      let y1 = -Infinity
      for (const q of r) {
        ring.push(q.x * k, q.y * k)
        x0 = Math.min(x0, q.x * k)
        y0 = Math.min(y0, q.y * k)
        x1 = Math.max(x1, q.x * k)
        y1 = Math.max(y1, q.y * k)
      }
      polys.push({ ring, x0, y0, x1, y1 })
    }
  }
  if (polys.length === 0) return
  const inside = (x: number, y: number) => {
    // pares de anillos (exterior y huecos): cuenta de cruces sobre todos
    let c = false
    for (const p of polys) {
      if (x < p.x0 || x > p.x1 || y < p.y0 || y > p.y1) continue
      const r = p.ring
      const n = r.length / 2
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = r[i * 2]
        const yi = r[i * 2 + 1]
        const xj = r[j * 2]
        const yj = r[j * 2 + 1]
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c
      }
    }
    return c
  }
  for (const l of lines) {
    const p = l.pts
    const m = (p.length / 2) >> 1
    l.urban = inside(p[m * 2], p[m * 2 + 1]) || inside(p[0], p[1]) || inside(p[p.length - 2], p[p.length - 1])
  }
}

/** Anillos cerrados casi circulares con dos o más calles que salen de ellos: rotondas. */
function markRoundabouts(lines: RoadLine[], tileY: number): void {
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (tileY + 0.5)) / 2 ** 14)))
  const mpu = (40075016.7 * Math.cos(lat)) / 2 ** 14 / E
  const count = new Map<string, number>()
  for (const l of lines) for (let i = 0; i < l.pts.length; i += 2) count.set(`${l.pts[i]},${l.pts[i + 1]}`, (count.get(`${l.pts[i]},${l.pts[i + 1]}`) ?? 0) + 1)
  for (const l of lines) {
    const p = l.pts
    const n = p.length / 2
    if (n < 5 || p[0] !== p[p.length - 2] || p[1] !== p[p.length - 1]) continue
    // área con signo en (este, norte) y perímetro
    let area = 0
    let per = 0
    for (let i = 0; i + 1 < n; i++) {
      const x0 = p[i * 2]
      const n0 = -p[i * 2 + 1]
      const x1 = p[i * 2 + 2]
      const n1 = -p[i * 2 + 3]
      area += (x0 * n1 - x1 * n0) / 2
      per += Math.hypot(x1 - x0, n1 - n0)
    }
    const perM = per * mpu
    const compact = (4 * Math.PI * Math.abs(area)) / (per * per)
    if (perM < 25 || perM > 450 || compact < 0.86) continue
    // calles que salen del anillo (vértices compartidos)
    let arms = 0
    for (let i = 0; i + 1 < n; i++) if ((count.get(`${p[i * 2]},${p[i * 2 + 1]}`) ?? 0) > 1) arms++
    if (arms < 2) continue
    l.loop = area > 0 ? 1 : -1
  }
}

/** Recorta una polilínea (x, y alternados) a [0, E]²: los trozos que quedan dentro. */
function clip(line: number[]): number[][] {
  const out: number[][] = []
  let cur: number[] | null = null
  for (let i = 2; i < line.length; i += 2) {
    const x0 = line[i - 2]
    const y0 = line[i - 1]
    const dx = line[i] - x0
    const dy = line[i + 1] - y0
    let t0 = 0
    let t1 = 1
    let ok = true
    const edge = (p: number, q: number) => {
      if (p === 0) {
        if (q < 0) ok = false
      } else {
        const r = q / p
        if (p < 0) t0 = Math.max(t0, r)
        else t1 = Math.min(t1, r)
      }
    }
    edge(-dx, x0)
    edge(dx, E - x0)
    edge(-dy, y0)
    edge(dy, E - y0)
    if (!ok || t0 > t1 || (dx === 0 && dy === 0)) {
      cur = null
      continue
    }
    const ax = x0 + dx * t0
    const ay = y0 + dy * t0
    const bx = x0 + dx * t1
    const by = y0 + dy * t1
    if (ax === bx && ay === by) {
      if (t1 < 1) cur = null
      continue
    }
    if (!cur || t0 > 0) {
      cur = [ax, ay]
      out.push(cur)
    }
    cur.push(bx, by)
    if (t1 < 1) cur = null
  }
  // sin vértices repetidos
  return out
    .map((l) => {
      const r: number[] = [l[0], l[1]]
      for (let i = 2; i < l.length; i += 2) if (l[i] !== r[r.length - 2] || l[i + 1] !== r[r.length - 1]) r.push(l[i], l[i + 1])
      return r
    })
    .filter((l) => l.length >= 4)
}

const onBorder = (x: number, y: number) => x <= 0 || y <= 0 || x >= E || y >= E

interface Insert {
  seg: number
  t: number
  x: number
  y: number
}

/**
 * Une los extremos que caen sobre otra línea y corta las líneas que se cruzan a la misma altura
 * sin vértice común (la simplificación de la tesela se los ha comido).
 */
export function repairJunctions(lines: RoadLine[]): void {
  // rejilla de segmentos
  const cells = new Map<number, number[]>() // celda → [línea, segmento, línea, segmento…]
  lines.forEach((l, li) => {
    const p = l.pts
    for (let s = 0; s + 3 < p.length; s += 2) {
      const c0x = clampCell(Math.min(p[s], p[s + 2]) - SNAP)
      const c1x = clampCell(Math.max(p[s], p[s + 2]) + SNAP)
      const c0y = clampCell(Math.min(p[s + 1], p[s + 3]) - SNAP)
      const c1y = clampCell(Math.max(p[s + 1], p[s + 3]) + SNAP)
      for (let cy = c0y; cy <= c1y; cy++) {
        for (let cx = c0x; cx <= c1x; cx++) {
          const key = cy * GRID + cx
          let arr = cells.get(key)
          if (!arr) cells.set(key, (arr = []))
          arr.push(li, s >> 1)
        }
      }
    }
  })
  const vkey = (x: number, y: number) => `${x},${y}`
  const owners = new Map<string, number[]>() // vértice → líneas que pasan por él
  lines.forEach((l, li) => {
    for (let i = 0; i < l.pts.length; i += 2) {
      const k = vkey(l.pts[i], l.pts[i + 1])
      const o = owners.get(k)
      if (!o) owners.set(k, [li])
      else if (!o.includes(li)) o.push(li)
    }
  })
  const inserts = new Map<number, Insert[]>()
  const addInsert = (li: number, ins: Insert) => {
    let arr = inserts.get(li)
    if (!arr) inserts.set(li, (arr = []))
    arr.push(ins)
  }
  const sameLevel = (a: RoadLine, b: RoadLine) => a.brunnel === b.brunnel && a.layer === b.layer

  // 1) extremos sobre otra línea que no pasa por ellos (también los que ya unen dos líneas: la
  //    entrada y la salida de un ramal que se juntan justo donde tocan la carretera)
  lines.forEach((l, li) => {
    const p = l.pts
    const n = p.length
    const closed = p[0] === p[n - 2] && p[1] === p[n - 1]
    for (const end of [0, n - 2]) {
      const x = p[end]
      const y = p[end + 1]
      if (onBorder(x, y) || closed) continue
      const own = owners.get(vkey(x, y)) ?? [li]
      const list = cells.get(clampCell(y) * GRID + clampCell(x))
      if (!list) continue
      let best = SNAP
      let bl = -1
      let bs = -1
      let bt = 0
      for (let k = 0; k < list.length; k += 2) {
        const oj = list[k]
        if (own.includes(oj) || !sameLevel(l, lines[oj])) continue
        const q = lines[oj].pts
        const s = list[k + 1] * 2
        const ax = q[s]
        const ay = q[s + 1]
        const dx = q[s + 2] - ax
        const dy = q[s + 3] - ay
        const l2 = dx * dx + dy * dy
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0
        const d = Math.hypot(x - ax - dx * t, y - ay - dy * t)
        if (d < best) {
          best = d
          bl = oj
          bs = s
          bt = t
        }
      }
      if (bl < 0) continue
      const q = lines[bl].pts
      const ax = q[bs]
      const ay = q[bs + 1]
      const bx = q[bs + 2]
      const by = q[bs + 3]
      const segLen = Math.hypot(bx - ax, by - ay)
      if (bt * segLen <= SNAP_VERTEX) {
        p[end] = ax
        p[end + 1] = ay
      } else if ((1 - bt) * segLen <= SNAP_VERTEX) {
        p[end] = bx
        p[end + 1] = by
      } else {
        // el extremo se queda donde está y la otra línea pasa por él
        addInsert(bl, { seg: bs >> 1, t: bt, x, y })
      }
    }
  })

  // 2) cruces sin vértice común a la misma altura
  const seen = new Set<string>()
  for (const list of cells.values()) {
    for (let a = 0; a < list.length; a += 2) {
      for (let b = a + 2; b < list.length; b += 2) {
        const la = list[a]
        const lb = list[b]
        if (la === lb) continue
        const A = lines[la]
        const B = lines[lb]
        if (!sameLevel(A, B)) continue
        const sa = list[a + 1]
        const sb = list[b + 1]
        const key = la < lb ? `${la}:${sa}:${lb}:${sb}` : `${lb}:${sb}:${la}:${sa}`
        if (seen.has(key)) continue
        seen.add(key)
        const p = A.pts
        const q = B.pts
        const hit = segCross(p[sa * 2], p[sa * 2 + 1], p[sa * 2 + 2], p[sa * 2 + 3], q[sb * 2], q[sb * 2 + 1], q[sb * 2 + 2], q[sb * 2 + 3])
        if (!hit) continue
        const [ta, tb] = hit
        const x = p[sa * 2] + (p[sa * 2 + 2] - p[sa * 2]) * ta
        const y = p[sa * 2 + 1] + (p[sa * 2 + 3] - p[sa * 2 + 1]) * ta
        addInsert(la, { seg: sa, t: ta, x, y })
        addInsert(lb, { seg: sb, t: tb, x, y })
      }
    }
  }

  // 3) meter los vértices nuevos
  for (const [li, list] of inserts) {
    list.sort((a, b) => a.seg - b.seg || a.t - b.t)
    const p = lines[li].pts
    const r: number[] = []
    let k = 0
    for (let s = 0; s < p.length / 2; s++) {
      r.push(p[s * 2], p[s * 2 + 1])
      while (k < list.length && list[k].seg === s) {
        const ins = list[k++]
        if (ins.x !== r[r.length - 2] || ins.y !== r[r.length - 1]) r.push(ins.x, ins.y)
      }
    }
    // (sin repetir el vértice siguiente si el punto cae justo en él)
    const clean: number[] = [r[0], r[1]]
    for (let i = 2; i < r.length; i += 2) if (r[i] !== clean[clean.length - 2] || r[i + 1] !== clean[clean.length - 1]) clean.push(r[i], r[i + 1])
    lines[li].pts = clean
  }
}

function clampCell(v: number): number {
  return Math.max(0, Math.min(GRID - 1, Math.floor(v / CELL)))
}

/** Cruce propio de dos segmentos (sin contar los extremos): parámetros (ta, tb) o null. */
function segCross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): [number, number] | null {
  const rx = bx - ax
  const ry = by - ay
  const sx = dx - cx
  const sy = dy - cy
  const den = rx * sy - ry * sx
  if (Math.abs(den) < 1e-9) return null
  const ta = ((cx - ax) * sy - (cy - ay) * sx) / den
  const tb = ((cx - ax) * ry - (cy - ay) * rx) / den
  const eps = 1e-6
  if (ta <= eps || ta >= 1 - eps || tb <= eps || tb >= 1 - eps) return null
  return [ta, tb]
}
