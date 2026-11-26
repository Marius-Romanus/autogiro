// El aeródromo del tráfico aéreo: pista en uso, circuito, calles de rodaje, plataforma y puestos.
//
// Todo en un plano local del aeródromo: X al este, Z al sur (como el mundo), metros. Las alturas
// las da el suelo de quien simula (el relieve del juego o el de la prueba).
//
// De OpenStreetMap (capa `aeroway` de OpenFreeMap, la misma de world/Runways.ts) salen el eje de la
// pista, las calles de rodaje (líneas) y las plataformas (polígonos). Con ellas se hace un grafo de
// rodaje; los puestos de estacionamiento se reparten por las plataformas junto a una calle. Un
// campo sin calles ni plataforma (muchas pistas de ultraligeros) se rueda por la hierba: una calle
// paralela a la pista y una fila de puestos al otro lado del circuito.
//
// Sentido único: se entra en pista por el principio y se sale por el final (toma larga, como se
// hace en un campo con una sola calle paralela), así dos aparatos nunca se encuentran de frente.

export interface Pt {
  x: number
  z: number
}

/** Lo que se sabe del aeródromo, en metros locales. */
export interface RawAirfield {
  name: string
  icao?: string
  /** designadores de OSM («08/26») si los hay */
  ref?: string
  /** extremos del eje de la pista */
  a: Pt
  b: Pt
  /** semiancho de la pista (m) */
  hw: number
  taxiways: Pt[][]
  aprons: Pt[][]
  /** umbral desplazado al tomar de a hacia b / de b hacia a (m) */
  dispAB?: number
  dispBA?: number
  /** lado del circuito al tomar de a hacia b (+1 a derechas, −1 a izquierdas); el otro sentido, el contrario */
  sideAB?: 1 | -1
  /** altura del circuito sobre el campo (m) */
  circuitAgl?: number
  /** sentido que se usa con viento en calma: 0 = a→b, 1 = b→a */
  preferred?: 0 | 1
  /** declinación magnética (grados, + este) para numerar la pista si OSM no trae `ref` */
  declination?: number
}

/** Un sentido de la pista: se despega y se toma de `start` hacia `end`. */
export class RwyDir {
  /** designador («26») */
  id = ''
  /** principio del asfalto en este sentido y vector unitario del eje */
  x0 = 0
  z0 = 0
  dx = 1
  dz = 0
  /** longitud total del asfalto y umbral desplazado para la toma */
  total = 0
  displaced = 0
  hw = 13
  /** lado del circuito: +1 a derechas */
  side: 1 | -1 = -1
  /** altura del circuito sobre el campo (m) */
  H = 150
  /** rumbo verdadero (rad, 0 = norte, a derechas) */
  hdg = 0

  /** s a lo largo desde el principio del asfalto, d a la derecha del eje */
  s(x: number, z: number): number {
    return (x - this.x0) * this.dx + (z - this.z0) * this.dz
  }
  d(x: number, z: number): number {
    return -(x - this.x0) * this.dz + (z - this.z0) * this.dx
  }
  px(s: number, d: number): number {
    return this.x0 + this.dx * s - this.dz * d
  }
  pz(s: number, d: number): number {
    return this.z0 + this.dz * s + this.dx * d
  }
  pt(s: number, d: number): Pt {
    return { x: this.px(s, d), z: this.pz(s, d) }
  }
}

export interface Spot {
  id: number
  x: number
  z: number
  /** punto de la calle de rodaje más cercano y por dónde sigue la calle (unitario) */
  jx: number
  jz: number
  tx: number
  tz: number
  /** nodo del grafo insertado en ese punto */
  node: number
}

interface Node extends Pt {
  adj: number[]
  /** toca la pista: s a lo largo del eje (sentido a→b) o NaN */
  rwyS: number
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.z - b.z)

/** punto más cercano de un segmento: devuelve t (0..1) y la distancia */
function segNearest(p: Pt, a: Pt, b: Pt): { t: number; d: number; x: number; z: number } {
  const vx = b.x - a.x
  const vz = b.z - a.z
  const l2 = vx * vx + vz * vz
  const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.z - a.z) * vz) / l2)) : 0
  const x = a.x + vx * t
  const z = a.z + vz * t
  return { t, d: Math.hypot(p.x - x, p.z - z), x, z }
}

function inPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.z > p.z !== b.z > p.z && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) inside = !inside
  }
  return inside
}

function edgeDistance(p: Pt, poly: Pt[]): number {
  let best = Infinity
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) best = Math.min(best, segNearest(p, poly[j], poly[i]).d)
  return best
}

/** distancia de la fila de puestos a la calle de rodaje y separación entre puestos (m) */
const ROW_OFFSET = 12
const SPOT_GAP = 18
/** punto de espera: distancia al eje de la pista más allá del borde (m) */
const HOLD_CLEAR = 16
/** metros de calle entre el punto frente al puesto y donde se entra o se sale de ella */
const JOIN = 8

export class Airfield {
  readonly name: string
  readonly icao: string
  /** los dos sentidos: [a→b, b→a] */
  readonly dirs: [RwyDir, RwyDir]
  readonly spots: Spot[] = []
  /** las calles y la plataforma son de hierba (no hay en el mapa) */
  readonly grass: boolean
  private readonly nodes: Node[] = []
  /** nodos por los que se entra a la pista junto a cada extremo: [junto a `a`, junto a `b`] */
  private entry: [number, number] = [-1, -1]

  readonly raw: RawAirfield

  constructor(raw: RawAirfield) {
    this.raw = raw
    this.name = raw.name
    this.icao = raw.icao ?? ''
    const total = dist(raw.a, raw.b)
    const mk = (from: Pt, to: Pt, displaced: number, side: 1 | -1): RwyDir => {
      const r = new RwyDir()
      r.x0 = from.x
      r.z0 = from.z
      r.dx = (to.x - from.x) / total
      r.dz = (to.z - from.z) / total
      r.total = total
      r.displaced = displaced
      r.hw = raw.hw
      r.side = side
      r.H = raw.circuitAgl ?? 152
      r.hdg = Math.atan2(r.dx, -r.dz)
      return r
    }
    const sideAB = raw.sideAB ?? -1
    this.dirs = [mk(raw.a, raw.b, raw.dispAB ?? 0, sideAB), mk(raw.b, raw.a, raw.dispBA ?? 0, (raw.sideAB ? -sideAB : -1) as 1 | -1)]
    this.nameRunways()
    let taxi = raw.taxiways.filter((t) => t.length >= 2)
    let aprons = raw.aprons.filter((p) => p.length >= 3)
    this.buildGraph(taxi)
    this.findEntries()
    if (this.entry[0] >= 0 && this.entry[1] >= 0) this.makeSpots(aprons)
    this.grass = this.spots.length < 2
    if (this.grass) {
      // por la hierba: calle paralela a la pista y fila de puestos, al lado contrario del circuito
      // (si el circuito cambia de lado con el sentido, al lado contrario del sentido a→b)
      const virt = this.grassLayout(-this.dirs[0].side as 1 | -1)
      taxi = virt.taxi
      aprons = virt.aprons
      this.nodes.length = 0
      this.spots.length = 0
      this.buildGraph(taxi)
      this.findEntries()
      this.makeSpots(aprons)
    }
  }

  /** Hay por dónde rodar y dónde aparcar. */
  get hasGround(): boolean {
    return this.spots.length > 0 && this.entry[0] >= 0 && this.entry[1] >= 0
  }

  private nameRunways(): void {
    const [ab, ba] = this.dirs
    const num = (hdg: number) => {
      const deg = (((hdg * 180) / Math.PI - (this.raw.declination ?? 0)) % 360 + 360) % 360
      const n = Math.round(deg / 10) % 36 || 36
      return String(n).padStart(2, '0')
    }
    ab.id = num(ab.hdg)
    ba.id = num(ba.hdg)
    // los de OSM mandan si casan con el rumbo (±30°)
    const parts = (this.raw.ref ?? '').split('/').map((s) => s.trim())
    if (parts.length === 2 && parts.every((p) => /^\d{2}[LRC]?$/.test(p))) {
      const near = (id: string, hdg: number) => {
        const e = Math.abs((((parseInt(id, 10) * 10 - (hdg * 180) / Math.PI) % 360) + 540) % 360 - 180)
        return e < 30
      }
      if (near(parts[0], ab.hdg) && near(parts[1], ba.hdg)) [ab.id, ba.id] = parts
      else if (near(parts[1], ab.hdg) && near(parts[0], ba.hdg)) [ba.id, ab.id] = parts
    }
  }

  private grassLayout(side: 1 | -1): { taxi: Pt[][]; aprons: Pt[][] } {
    const r = this.dirs[0]
    const lane = side * (r.hw + 22)
    const taxi: Pt[][] = [[r.pt(8, 0), r.pt(8, lane), r.pt(r.total - 8, lane), r.pt(r.total - 8, 0)]]
    // plataforma: una franja de 170 m a media pista, al otro lado de la calle
    const mid = r.total / 2
    const half = Math.min(85, r.total / 2 - 40)
    const d0 = lane + side * 1
    const d1 = lane + side * 26
    const aprons: Pt[][] = [[r.pt(mid - half, d0), r.pt(mid + half, d0), r.pt(mid + half, d1), r.pt(mid - half, d1)]]
    return { taxi, aprons }
  }

  // ---------------- grafo de rodaje ----------------
  private addNode(p: Pt): number {
    for (let i = 0; i < this.nodes.length; i++) if (dist(this.nodes[i], p) < 2.5) return i
    this.nodes.push({ x: p.x, z: p.z, adj: [], rwyS: NaN })
    return this.nodes.length - 1
  }

  private link(a: number, b: number): void {
    if (a === b) return
    if (!this.nodes[a].adj.includes(b)) this.nodes[a].adj.push(b)
    if (!this.nodes[b].adj.includes(a)) this.nodes[b].adj.push(a)
  }

  private buildGraph(lines: Pt[][]): void {
    // cortar cada línea donde el extremo de otra la toca (uniones en T)
    const cut: Pt[][] = lines.map((l) => l.map((p) => ({ x: p.x, z: p.z })))
    for (let i = 0; i < lines.length; i++) {
      for (const end of [lines[i][0], lines[i][lines[i].length - 1]]) {
        for (let j = 0; j < cut.length; j++) {
          if (j === i) continue
          const l = cut[j]
          for (let k = 0; k < l.length - 1; k++) {
            const n = segNearest(end, l[k], l[k + 1])
            if (n.d < 6 && n.t > 0.001 && n.t < 0.999 && dist(l[k], end) > 2.5 && dist(l[k + 1], end) > 2.5) {
              l.splice(k + 1, 0, { x: end.x, z: end.z })
              break
            }
          }
        }
      }
    }
    for (const l of cut) {
      let prev = -1
      for (const p of l) {
        const n = this.addNode(p)
        if (prev >= 0) this.link(prev, n)
        prev = n
      }
    }
  }

  /** Nodos que tocan la pista; el más cercano a cada extremo es por donde se entra y se sale. */
  private findEntries(): void {
    const r = this.dirs[0]
    this.entry = [-1, -1]
    let bestA = Infinity
    let bestB = Infinity
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i]
      const s = r.s(n.x, n.z)
      const d = r.d(n.x, n.z)
      if (Math.abs(d) > r.hw + 4 || s < -15 || s > r.total + 15) continue
      n.rwyS = Math.max(0, Math.min(r.total, s))
      if (s < bestA && s < r.total * 0.35) {
        bestA = s
        this.entry[0] = i
      }
      if (r.total - s < bestB && s > r.total * 0.65) {
        bestB = r.total - s
        this.entry[1] = i
      }
    }
  }

  private nearestOnGraph(p: Pt): { a: number; b: number; x: number; z: number; d: number } | null {
    let best: { a: number; b: number; x: number; z: number; d: number } | null = null
    for (let a = 0; a < this.nodes.length; a++) {
      for (const b of this.nodes[a].adj) {
        if (b < a) continue
        const n = segNearest(p, this.nodes[a], this.nodes[b])
        if (!best || n.d < best.d) best = { a, b, x: n.x, z: n.z, d: n.d }
      }
    }
    return best
  }

  private makeSpots(aprons: Pt[][]): void {
    const r = this.dirs[0]
    const cands: { p: Pt; j: NonNullable<ReturnType<Airfield['nearestOnGraph']>>; q: number }[] = []
    for (const poly of aprons) {
      let minX = Infinity
      let maxX = -Infinity
      let minZ = Infinity
      let maxZ = -Infinity
      for (const p of poly) {
        minX = Math.min(minX, p.x)
        maxX = Math.max(maxX, p.x)
        minZ = Math.min(minZ, p.z)
        maxZ = Math.max(maxZ, p.z)
      }
      for (let x = minX; x <= maxX; x += 2.5) {
        for (let z = minZ; z <= maxZ; z += 2.5) {
          const p = { x, z }
          if (!inPolygon(p, poly)) continue
          // dentro de la plataforma, a un rotor del borde, y lejos de la pista
          if (edgeDistance(p, poly) < 4.5) continue
          if (Math.abs(r.d(x, z)) < r.hw + 28) continue
          const j = this.nearestOnGraph(p)
          if (!j || j.d < ROW_OFFSET - 2.5 || j.d > ROW_OFFSET + 2.5) continue
          cands.push({ p, j, q: Math.abs(j.d - ROW_OFFSET) })
        }
      }
    }
    cands.sort((a, b) => a.q - b.q)
    const chosen: typeof cands = []
    for (const c of cands) {
      if (chosen.length >= 24) break
      if (chosen.some((o) => dist(o.p, c.p) < SPOT_GAP)) continue
      // sitio para salir en diagonal: la calle sigue al menos 10 m a cada lado de su punto
      chosen.push(c)
    }
    for (const c of chosen) {
      const A = this.nodes[c.j.a]
      const B = this.nodes[c.j.b]
      const l = dist(A, B) || 1
      const node = this.addNodeOnEdge(c.j.a, c.j.b, { x: c.j.x, z: c.j.z })
      this.spots.push({ id: this.spots.length, x: c.p.x, z: c.p.z, jx: c.j.x, jz: c.j.z, tx: (B.x - A.x) / l, tz: (B.z - A.z) / l, node })
    }
  }

  private addNodeOnEdge(a: number, b: number, p: Pt): number {
    if (dist(this.nodes[a], p) < 2.5) return a
    if (dist(this.nodes[b], p) < 2.5) return b
    // (la arista pudo partirse ya con otro puesto: buscar el tramo que contiene el punto)
    const best = this.nearestOnGraph(p)
    if (best && best.d < 0.5) {
      a = best.a
      b = best.b
      if (dist(this.nodes[a], p) < 2.5) return a
      if (dist(this.nodes[b], p) < 2.5) return b
    }
    this.nodes.push({ x: p.x, z: p.z, adj: [], rwyS: NaN })
    const n = this.nodes.length - 1
    const A = this.nodes[a]
    const B = this.nodes[b]
    A.adj = A.adj.filter((k) => k !== b)
    B.adj = B.adj.filter((k) => k !== a)
    this.link(a, n)
    this.link(n, b)
    return n
  }

  /** Camino más corto entre dos nodos (sin pisar la pista por el medio). */
  private path(from: number, to: number): Pt[] | null {
    const n = this.nodes.length
    const cost = new Float64Array(n).fill(Infinity)
    const prev = new Int32Array(n).fill(-1)
    const done = new Uint8Array(n)
    cost[from] = 0
    for (;;) {
      let u = -1
      for (let i = 0; i < n; i++) if (!done[i] && cost[i] < Infinity && (u < 0 || cost[i] < cost[u])) u = i
      if (u < 0 || u === to) break
      done[u] = 1
      for (const v of this.nodes[u].adj) {
        const c = cost[u] + dist(this.nodes[u], this.nodes[v])
        if (c < cost[v]) {
          cost[v] = c
          prev[v] = u
        }
      }
    }
    if (cost[to] === Infinity) return null
    const out: Pt[] = []
    for (let u = to; u >= 0; u = prev[u]) out.push({ x: this.nodes[u].x, z: this.nodes[u].z })
    return out.reverse()
  }

  /** índice del sentido de pista */
  dirIndex(r: RwyDir): 0 | 1 {
    return r === this.dirs[0] ? 0 : 1
  }

  /**
   * Rodaje de salida: del puesto al punto de espera y de ahí a alinear en el eje.
   * `heading` es hacia dónde mira el aparato aparcado. `hold`: índice del punto de espera en el camino.
   */
  routeOut(spot: Spot, r: RwyDir, heading: number): { pts: Pt[]; hold: number } | null {
    const di = this.dirIndex(r)
    const entry = this.entry[di]
    const g = this.path(spot.node, entry)
    if (!g) return null
    // sentido en que se sale por la calle desde el puesto
    const fx = g.length > 1 ? g[1].x - g[0].x : spot.tx
    const fz = g.length > 1 ? g[1].z - g[0].z : spot.tz
    const fl = Math.hypot(fx, fz) || 1
    const ux = fx / fl
    const uz = fz / fl
    const hx = Math.sin(heading)
    const hz = -Math.cos(heading)
    const pts: Pt[] = [{ x: spot.x, z: spot.z }]
    const along = hx * ux + hz * uz
    if (along > 0.3) {
      // mirando en el sentido de salida: en diagonal a la calle
      // (bien cruzado: en diagonal larga pasaría a un rotor del puesto de delante)
      pts.push({ x: spot.x + hx * 3, z: spot.z + hz * 3 })
      pts.push({ x: spot.jx + ux * JOIN, z: spot.jz + uz * JOIN })
    } else {
      // mirando al revés: media vuelta hacia la calle (un arco que acaba en ella)
      const tx = spot.jx - spot.x
      const tz = spot.jz - spot.z
      const tl = Math.hypot(tx, tz) || 1
      const rad = tl / 2
      const cx = spot.x + (tx / tl) * rad
      const cz = spot.z + (tz / tl) * rad
      for (let k = 1; k <= 6; k++) {
        const a = (k / 6) * Math.PI
        // del puesto (ángulo 0) girando por delante del morro hasta la calle
        pts.push({ x: cx - (tx / tl) * rad * Math.cos(a) + hx * rad * Math.sin(a), z: cz - (tz / tl) * rad * Math.cos(a) + hz * rad * Math.sin(a) })
      }
      pts.push({ x: spot.jx + ux * 5, z: spot.jz + uz * 5 })
    }
    // el resto del camino, desde más allá del punto de unión
    const start = pts[pts.length - 1]
    let acc = 0
    let k = 1
    const joinD = Math.hypot(start.x - spot.jx, start.z - spot.jz)
    for (; k < g.length; k++) {
      acc += dist(g[k - 1], g[k])
      if (acc > joinD + 1) break
    }
    for (; k < g.length; k++) pts.push(g[k])
    // punto de espera: donde el camino llega a HOLD_CLEAR del borde de la pista
    const lim = r.hw + HOLD_CLEAR
    let hold = -1
    for (let i = pts.length - 1; i > 0; i--) {
      const d1 = Math.abs(r.d(pts[i].x, pts[i].z))
      const d0 = Math.abs(r.d(pts[i - 1].x, pts[i - 1].z))
      if (d1 < lim && d0 >= lim) {
        const t = (d0 - lim) / (d0 - d1)
        pts.splice(i, 0, { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * t })
        hold = i
        break
      }
    }
    if (hold < 0) return null
    // alinear: del nodo de entrada al eje y unos metros pista adelante
    const e = pts[pts.length - 1]
    const s = Math.max(6, r.s(e.x, e.z))
    pts[pts.length - 1] = r.pt(s, 0)
    pts.push(r.pt(s + 14, 0))
    return { pts, hold }
  }

  /** s (en el sentido de `r`) del punto donde se deja la pista */
  exitS(r: RwyDir): number {
    const e = this.nodes[this.entry[1 - this.dirIndex(r)]]
    return Math.min(r.total - 6, r.s(e.x, e.z))
  }

  /** Rodaje de vuelta: del eje de la pista (en la salida) al puesto; queda mirando en el sentido de la calle. */
  routeIn(r: RwyDir, spot: Spot): { pts: Pt[]; heading: number } | null {
    const di = this.dirIndex(r)
    const g = this.path(this.entry[1 - di], spot.node)
    if (!g) return null
    const pts: Pt[] = [r.pt(this.exitS(r), 0)]
    // hasta unos metros antes del punto frente al puesto, y de ahí cruzado hasta él
    const n = g.length
    const lx = n > 1 ? g[n - 1].x - g[n - 2].x : spot.tx
    const lz = n > 1 ? g[n - 1].z - g[n - 2].z : spot.tz
    const ll = Math.hypot(lx, lz) || 1
    const ux = lx / ll
    const uz = lz / ll
    const back = JOIN
    // recortar el final del camino `back` metros
    let rest = back
    const trimmed = g.slice(1)
    while (trimmed.length > 1 && rest > 0) {
      const a = trimmed[trimmed.length - 2]
      const b = trimmed[trimmed.length - 1]
      const l = dist(a, b)
      if (l <= rest) {
        trimmed.pop()
        rest -= l
      } else {
        trimmed[trimmed.length - 1] = { x: b.x - ((b.x - a.x) / l) * rest, z: b.z - ((b.z - a.z) / l) * rest }
        rest = 0
      }
    }
    for (const p of trimmed) pts.push(p)
    pts.push({ x: spot.x - ux * 3, z: spot.z - uz * 3 })
    pts.push({ x: spot.x, z: spot.z })
    return { pts, heading: Math.atan2(ux, -uz) }
  }

  /** Líneas del grafo (para dibujarlo en las pruebas). */
  debugEdges(): [Pt, Pt][] {
    const out: [Pt, Pt][] = []
    for (let a = 0; a < this.nodes.length; a++) for (const b of this.nodes[a].adj) if (b > a) out.push([this.nodes[a], this.nodes[b]])
    return out
  }
}

/** Casarrubios del Monte (LEMT) tal como está en OpenStreetMap (metros desde 40,2348 N 4,0270 O; aquí Z = −norte). */
export function lemtRaw(): RawAirfield {
  const P = (s: string): Pt[] =>
    s.split(' ').map((q) => {
      const [x, n] = q.split(',').map(Number)
      return { x, z: -n }
    })
  return {
    name: 'Casarrubios',
    icao: 'LEMT',
    ref: '08/26',
    a: { x: -463, z: 95 },
    b: { x: 465, z: -103 },
    hw: 13,
    // umbral 08 desplazado 400 m; autogiros al sur: 08 a derechas, 26 a izquierdas (school/site.ts)
    dispAB: 400,
    sideAB: 1,
    circuitAgl: 137,
    // en calma, la 26 (la de la escuela)
    preferred: 1,
    taxiways: [
      '456,101 476,79 476,61 37,-33 -269,-97 -432,-133 -452,-93',
      '-5,-123 43,-118 44,-109 29,-34',
      '-269,-97 -269,-103 -273,-118 -284,-142 -291,-147 -299,-147 -304,-143 -306,-139 -313,-107',
      '363,-123 330,31',
      '390,-110 359,36',
      '417,-112 384,42',
      '442,-104 410,47',
      '468,-101 436,53',
      '335,-129 304,25',
      '307,-135 274,18',
      '279,-142 247,13',
      '252,-146 220,7',
      '225,-153 194,1',
      '199,-157 167,-5',
      '171,-161 140,-10',
      '144,-164 113,-16',
    ].map(P),
    aprons: [
      '-8,-112 -7,-119 31,-116 34,-110 20,-36 37,-33 56,-119 56,-121 -5,-127 -4,-134 -18,-138 -23,-116',
      '-33,-80 -249,-126 -244,-152 -266,-156 -288,-157 -290,-152 -295,-153 -305,-149 -309,-145 -317,-108 -307,-106 -300,-141 -297,-142 -293,-142 -290,-141 -286,-137 -274,-106 -276,-99 -38,-49',
    ].map(P),
  }
}
