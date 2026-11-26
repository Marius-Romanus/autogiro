// Perfil de cada puente: de la cadena de tramos de la red (bridgeNet.ts) a una fila de
// estaciones cada pocos metros con la altura del terreno, la del tablero, la luz libre y las
// pilas. También detecta los puentes que el modelo del terreno lleva «incrustados» (el MDT
// sube hasta la calzada y el puente parece un terraplén) y prepara el parche que rebaja el
// terreno por debajo (lo aplica Runways.ts, igual que alisa las pistas).
//
// Sin three.js ni DOM: también lo usa tools/bridge-info.ts desde Node.

import type { HeightSource } from './HeightSource.ts'
import { BridgeNet, D_MAX, geoToUnit, unitToGeo, type BridgeNode, type BridgePiece } from './bridgeNet.ts'
import type { TerrainPatch } from './Runways.ts'

const DEG = Math.PI / 180
/** separación máxima entre estaciones (m) */
const STEP = 6
/** hasta dónde (m) se mira el terreno más allá del extremo de un puente para saber su altura */
const APPROACH = 12
/** peso del «tablero a altura fija sobre el terreno» frente a los terminales (viaductos larguísimos) */
const W_FOLLOW = 0.02 / D_MAX
/** altura sobre el terreno de un viaducto sin terminales cerca (m) */
const FOLLOW_CLEAR = 9
/** luz libre mínima para que merezca dibujar el puente (m) */
export const MIN_CLEAR = 2
/** el terreno bajo un puente incrustado se rebaja hasta el de los lados, medido a esta distancia del borde */
/**
 * Distancias (m) al borde del tablero a las que se mide el terreno de los lados. A la segunda
 * (12 m) un tablero incrustado normal ya ha caído casi todo; un talud, no.
 */
const SIDES = [8, 12, 24, 36]
/**
 * Tableros incrustados altos (20 m o más sobre el terreno de los lados, como el puente de Cádiz
 * sobre la bahía): el MDT los une al agua con triángulos largos que pasan de los 36 m de SIDES, y
 * el rebaje dejaba a los lados paredes de terreno de 10–25 m. Ahí se sigue mirando más lejos.
 */
const TALL = 20
const WIDE = [50, 70, 95, 125]
/** pendiente máxima de la rasante (m/m) más allá del último tramo con el tablero en el MDT */
const MAX_GRADE: Record<string, number> = { road: 0.06, rail: 0.035, path: 0.08 }
/** cola (m) sin tablero en el MDT a partir de la que se aplica esa pendiente */
const LONG_TAIL = 150
/** largo máximo (m) de la rampa del MDT que se rebaja más allá de un tramo incrustado */
const RAMP_MAX = 60
/**
 * Acuerdos verticales: la rasante se promedia en ±VCURVE m a lo largo del eje (menos cerca de los
 * extremos, que no se mueven). Un cambio de pendiente pasa a repartirse en una curva de 2·VCURVE m
 * en vez de en un quiebro, como en una carretera de verdad; con el quiebro los coches cabeceaban
 * de golpe y los semirremolques se doblaban sobre la cresta.
 */
const VCURVE = 30
/** el rebaje se funde con el terreno en los últimos metros de su ancho */
const CARVE_BLEND = 6
/** relleno de los accesos: talud del terraplén (m en horizontal por m de altura) */
const FILL_SLOPE = 1.5
/** arcén de tierra a cada lado de la calzada en lo alto del terraplén (m) */
const FILL_SHOULDER = 1.5
/** hasta dónde, más allá del extremo, se busca el terreno a la altura de la calzada (m) */
const FILL_REACH = 24
/**
 * celda más grande (m) de una rejilla de alturas en la que se aplica un relleno: en una más gruesa
 * un solo texel subido haría un bulto de cientos de metros (ver gridRunways.ts)
 */
const FILL_MAX_CELL = 12
/** hueco mínimo (m) que merece relleno, y máximo: más es un dato raro, no un terraplén suavizado */
const FILL_MIN = 0.4
const FILL_MAX = 15

export interface Chain {
  key: string
  parts: Array<{ piece: BridgePiece; rev: boolean; s0: number }>
  len: number
  closed: boolean
  /** número de estaciones */
  n: number
  s: Float64Array
  lat: Float64Array
  lon: Float64Array
  /** posición en un plano local (m al este y al norte de la primera estación) */
  e: Float64Array
  nn: Float64Array
  /** tangente unitaria (este, norte) y factor de inglete del ancho en los quiebros */
  te: Float32Array
  tn: Float32Array
  mitre: Float32Array
  /** índice del tramo (parts) de cada estación */
  part: Uint16Array
  /** semiancho del tablero (m) */
  hw: Float32Array
  /** terreno bajo el eje, ya rebajado donde se rebaja (m) */
  ground: Float32Array
  /** altura de la calzada (m) */
  deck: Float32Array
  /** distancia por el grafo al terminal más cercano (m) */
  dTerm: Float32Array
  maxClear: number
  /** se dibuja (tiene luz libre suficiente en algún punto) */
  draw: boolean
  /** los extremos de la cadena, ¿vuelven al suelo? */
  startTerminal: boolean
  endTerminal: boolean
  /** posiciones (s) de las pilas */
  piers: number[]
  /** canto del tablero (m) */
  depth: number
  /** pasarela o acera que va pegada a un puente de carretera o de tren: sin pilas ni estribos propios */
  companion: boolean
  /** parche que rebaja el terreno incrustado, si lo hay */
  carve: (TerrainPatch & { stations: number }) | null
  /** la rasante pasa por alturas medidas del tablero (el MDT del IGN lo trae incrustado en algún tramo) */
  measured: boolean
  /** parches que rellenan el acceso en los extremos que vuelven al suelo (terraplén contra el estribo) */
  fills: Array<TerrainPatch & { depth: number; reach: number }>
  lat0: number
  lon0: number
  mLat: number
  mLon: number
}

export interface ChainOptions {
  /** buscar tableros incrustados en el terreno y preparar su rebaje (solo con el MDT del IGN) */
  carve: boolean
  /** rellenar los accesos donde el relieve redondea el terraplén contra el estribo */
  fill?: boolean
  /**
   * margen (m) con que se ensancha y alarga el relleno: con una rejilla de alturas gruesa (el
   * relieve mundial, ~7 m por texel) alguno de sus texeles tiene que caer dentro, y bajo el
   * estribo, para que no quede hueco entre el final del tablero y el texel relleno
   */
  fillPad?: number
}

/** Punto a `off` metros a la derecha del eje en la estación i (lat, lon). */
export function offsetGeo(c: Chain, i: number, off: number): [number, number] {
  const k = off * c.mitre[i]
  // derecha de (te, tn) = (tn, −te)
  return [c.lat[i] - (k * c.te[i]) / c.mLat, c.lon[i] + (k * c.tn[i]) / c.mLon]
}

export class ChainBuilder {
  /** para depurar (tools/bridge-info.ts): medidas con que se decide el rebaje de cada estación */
  carveDebug: ((c: Chain, rows: Array<{ s: number; deck: number; top: number; left: number[]; right: number[]; flag: number }>) => void) | null = null
  private readonly cache = new Map<string, Promise<Chain | null>>()
  private readonly termH = new Map<BridgeNode, Promise<number | null>>()
  private readonly net: BridgeNet
  private readonly heights: HeightSource
  private readonly opts: ChainOptions

  constructor(net: BridgeNet, heights: HeightSource, opts: ChainOptions) {
    this.net = net
    this.heights = heights
    this.opts = opts
  }

  /** La cadena del tramo, con su perfil (una vez por cadena; null si no hay datos de altura). */
  chain(piece: BridgePiece): Promise<Chain | null> {
    const raw = this.net.chainOf(piece)
    const first = raw.parts[0]
    const key = raw.closed ? `${first.piece.id}${first.rev ? 'r' : 'f'}` : `o${piece.id}`
    let p = this.cache.get(key)
    if (!p) {
      p = this.build(key, raw).catch((err) => {
        console.warn('puentes: perfil fallido', err)
        return null
      })
      this.cache.set(key, p)
    }
    return p
  }

  /** Altura del terreno donde un puente vuelve al suelo: la mayor de los primeros metros hacia fuera. */
  private terminalHeight(node: BridgeNode): Promise<number | null> {
    let p = this.termH.get(node)
    if (p) return p
    p = (async () => {
      const piece = node.pieces[0]
      const m = piece.gx.length
      const atA = piece.a === node
      const [la, lo] = unitToGeo(node.gx, node.gy)
      const [la1, lo1] = atA ? unitToGeo(piece.gx[1], piece.gy[1]) : unitToGeo(piece.gx[m - 2], piece.gy[m - 2])
      const mLat = 111132.92 - 559.82 * Math.cos(2 * la * DEG)
      const mLon = 111412.84 * Math.cos(la * DEG)
      let de = (lo - lo1) * mLon
      let dn = (la - la1) * mLat
      const l = Math.hypot(de, dn) || 1
      de /= l
      dn /= l
      const pad = 0.0004
      await this.heights.ensure(la - pad, lo - pad * 1.4, la + pad, lo + pad * 1.4)
      let best: number | null = null
      for (let d = 0; d <= APPROACH; d += 3) {
        const h = this.heights.sample(la + (dn * d) / mLat, lo + (de * d) / mLon)
        if (h !== null && (best === null || h > best)) best = h
      }
      return best
    })()
    this.termH.set(node, p)
    return p
  }

  private async build(key: string, raw: ReturnType<BridgeNet['chainOf']>): Promise<Chain | null> {
    const { parts } = raw
    // polilínea de la cadena en lat/lon
    const pla: number[] = []
    const plo: number[] = []
    const ppart: number[] = []
    parts.forEach((q, k) => {
      const p = q.piece
      const m = p.gx.length
      for (let j = k > 0 ? 1 : 0; j < m; j++) {
        const i = q.rev ? m - 1 - j : j
        const [la, lo] = unitToGeo(p.gx[i], p.gy[i])
        pla.push(la)
        plo.push(lo)
        ppart.push(k)
      }
    })
    if (pla.length < 2) return null
    const lat0 = pla[0]
    const lon0 = plo[0]
    const mLat = 111132.92 - 559.82 * Math.cos(2 * lat0 * DEG) + 1.175 * Math.cos(4 * lat0 * DEG)
    const mLon = 111412.84 * Math.cos(lat0 * DEG) - 93.5 * Math.cos(3 * lat0 * DEG)
    const pe = pla.map((_, i) => (plo[i] - lon0) * mLon)
    const pn = pla.map((la) => (la - lat0) * mLat)

    // estaciones: los vértices y los puntos intermedios para no pasar de STEP
    const S: number[] = []
    const Ee: number[] = []
    const Nn: number[] = []
    const Te: number[] = []
    const Tn: number[] = []
    const Mi: number[] = []
    const Pa: number[] = []
    let acc = 0
    let pde = 0
    let pdn = 0
    for (let k = 1; k < pe.length; k++) {
      let de = pe[k] - pe[k - 1]
      let dn = pn[k] - pn[k - 1]
      const L = Math.hypot(de, dn)
      if (L < 1e-3) continue
      de /= L
      dn /= L
      const sub = Math.max(1, Math.ceil(L / STEP))
      for (let j = 0; j < sub; j++) {
        const f = j / sub
        let te = de
        let tn = dn
        let mi = 1
        if (j === 0 && S.length > 0) {
          // quiebro: bisectriz, con el ancho corregido para que los bordes sigan paralelos
          const be = de + pde
          const bn = dn + pdn
          const bl = Math.hypot(be, bn)
          if (bl > 1e-6) {
            te = be / bl
            tn = bn / bl
            mi = 1 / Math.max(0.62, te * de + tn * dn)
          }
        }
        S.push(acc + L * f)
        Ee.push(pe[k - 1] + (pe[k] - pe[k - 1]) * f)
        Nn.push(pn[k - 1] + (pn[k] - pn[k - 1]) * f)
        Te.push(te)
        Tn.push(tn)
        Mi.push(mi)
        Pa.push(ppart[k])
      }
      acc += L
      pde = de
      pdn = dn
    }
    if (S.length === 0) return null
    S.push(acc)
    Ee.push(pe[pe.length - 1])
    Nn.push(pn[pn.length - 1])
    Te.push(pde)
    Tn.push(pdn)
    Mi.push(1)
    Pa.push(ppart[ppart.length - 1])
    const n = S.length
    const len = acc

    const first = parts[0]
    const last = parts[parts.length - 1]
    const startNode = first.rev ? first.piece.b : first.piece.a
    const endNode = last.rev ? last.piece.a : last.piece.b
    const c: Chain = {
      key,
      parts,
      len,
      closed: raw.closed,
      n,
      s: Float64Array.from(S),
      lat: Float64Array.from(Nn, (v) => lat0 + v / mLat),
      lon: Float64Array.from(Ee, (v) => lon0 + v / mLon),
      e: Float64Array.from(Ee),
      nn: Float64Array.from(Nn),
      te: Float32Array.from(Te),
      tn: Float32Array.from(Tn),
      mitre: Float32Array.from(Mi),
      part: Uint16Array.from(Pa),
      hw: Float32Array.from(Pa, (k) => parts[k].piece.width / 2),
      ground: new Float32Array(n),
      deck: new Float32Array(n),
      dTerm: new Float32Array(n).fill(Infinity),
      maxClear: 0,
      draw: false,
      startTerminal: this.net.isTerminal(startNode),
      endTerminal: this.net.isTerminal(endNode),
      piers: [],
      depth: 1,
      companion: false,
      carve: null,
      measured: false,
      fills: [],
      lat0,
      lon0,
      mLat,
      mLon,
    }
    // los tramos de la cadena empiezan donde dice la polilínea (no la suma de sus largos)
    {
      let k = 0
      for (let i = 0; i < n; i++) {
        while (k < c.part[i]) {
          k++
          parts[k].s0 = c.s[i > 0 ? i - 1 : 0]
        }
      }
    }

    // terminales al alcance de cada tramo, con su altura
    type Term = { dA: number; dB: number; h: number }
    const terms: Array<Map<BridgeNode, Term>> = []
    const pending: Array<Promise<void>> = []
    for (const q of parts) {
      const map = new Map<BridgeNode, Term>()
      for (const [list, isA] of [
        [this.net.terminalsNear(q.piece.a), true],
        [this.net.terminalsNear(q.piece.b), false],
      ] as Array<[Array<{ node: BridgeNode; d: number }>, boolean]>) {
        for (const { node, d } of list) {
          let t = map.get(node)
          if (!t) {
            t = { dA: Infinity, dB: Infinity, h: NaN }
            map.set(node, t)
            const tt = t
            pending.push(
              this.terminalHeight(node).then((h) => {
                tt.h = h ?? NaN
              }),
            )
          }
          if (isA) t.dA = d
          else t.dB = d
        }
      }
      terms.push(map)
    }
    // alturas del terreno a lo largo del puente (a trozos, para no pedir todo el rectángulo)
    const side = this.opts.carve ? SIDES[SIDES.length - 1] + 30 : 14
    const ensureAlong = (pad: number): Array<Promise<void>> => {
      const jobs: Array<Promise<void>> = []
      for (let i = 0; i < n; i += 20) {
        const j = Math.min(n - 1, i + 20)
        const padLat = pad / mLat
        const padLon = pad / mLon
        jobs.push(
          this.heights.ensure(
            Math.min(c.lat[i], c.lat[j]) - padLat,
            Math.min(c.lon[i], c.lon[j]) - padLon,
            Math.max(c.lat[i], c.lat[j]) + padLat,
            Math.max(c.lon[i], c.lon[j]) + padLon,
          ),
        )
      }
      return jobs
    }
    pending.push(...ensureAlong(side))
    await Promise.all(pending)

    // terreno bajo el eje (lo que falte, del vecino)
    const g = c.ground
    let known = 0
    const miss = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      const h = this.heights.sample(c.lat[i], c.lon[i])
      if (h === null) miss[i] = 1
      else {
        g[i] = h
        known++
      }
    }
    if (known === 0) return null
    if (known < n) {
      let lastOk = -1
      for (let i = 0; i < n; i++) {
        if (!miss[i]) lastOk = i
        else if (lastOk >= 0) g[i] = g[lastOk]
      }
      const firstOk = miss.indexOf(0)
      for (let i = 0; i < firstOk; i++) g[i] = g[firstOk]
    }

    // terreno suavizado (±100 m) por si no hay terminales cerca
    const follow = new Float32Array(n)
    {
      let a = 0
      let b = 0
      let sum = 0
      for (let i = 0; i < n; i++) {
        while (b < n && c.s[b] <= c.s[i] + 100) sum += g[b++]
        while (c.s[a] < c.s[i] - 100) sum -= g[a++]
        follow[i] = sum / (b - a) + FOLLOW_CLEAR
      }
    }

    // altura del tablero: media de los terminales ponderada con 1/distancia
    for (let i = 0; i < n; i++) {
      const q = parts[c.part[i]]
      const u = Math.min(q.piece.len, Math.max(0, q.rev ? q.piece.len - (c.s[i] - q.s0) : c.s[i] - q.s0))
      let sw = W_FOLLOW
      let sh = W_FOLLOW * follow[i]
      let dMin = Infinity
      for (const t of terms[c.part[i]].values()) {
        if (Number.isNaN(t.h)) continue
        const d = Math.min(t.dA + u, t.dB + q.piece.len - u)
        if (d < dMin) dMin = d
        const w = 1 / Math.max(d, 1) - 1 / D_MAX
        if (w <= 0) continue
        sw += w
        sh += w * t.h
      }
      c.deck[i] = sh / sw
      c.dTerm[i] = dMin
    }

    // tableros incrustados en el terreno: rebajarlo (y contar con el terreno ya rebajado). Si el
    // terreno bajo el eje queda 20 m o más por encima del de los lados (un tablero alto metido en
    // el MDT), el rebaje mira más lejos (WIDE): pedir antes ese terreno, solo para esos puentes
    if (this.opts.carve) {
      let tall = false
      for (let i = 0; i < n && !tall; i += 3) {
        for (const off of [-(c.hw[i] + SIDES[SIDES.length - 1]), c.hw[i] + SIDES[SIDES.length - 1]]) {
          const [la, lo] = offsetGeo(c, i, off)
          const h = this.heights.sample(la, lo)
          if (h !== null && g[i] - h >= TALL) tall = true
        }
      }
      if (tall) await Promise.all(ensureAlong(WIDE[WIDE.length - 1] + 40))
      this.detectCarve(c)
    }
    // Viaductos largos: a más de ~1,4 km de todo estribo la rasante pasa de la media de los estribos
    // a «el terreno + 9 m» en unos 100 m, y si un estribo está alto eso es un precipicio (36 m en
    // 80 m en la calzada del 25 de Abril, a 1,5 km de Lisboa). Sin alturas medidas que lo corrijan
    // (el LiDAR del IGN), la rasante no cae más deprisa que la pendiente máxima de su clase
    {
      let far = 0
      for (let i = 0; i < n; i++) far = Math.max(far, c.dTerm[i])
      if (!c.measured && far > 0.8 * D_MAX) limitGrade(c, MAX_GRADE[parts[0].piece.kind] ?? 0.06)
    }
    // acuerdos verticales en los cambios de pendiente (antes de mirar el terreno: si asoma, se sube)
    smoothDeck(c, VCURVE)

    // el tablero nunca por debajo del terreno: donde este asoma, se sube suavemente
    {
      const up = new Float32Array(n)
      let any = false
      for (let i = 0; i < n; i++) {
        if (c.dTerm[i] < 6) continue
        const r = g[i] + 0.3 - c.deck[i]
        if (r > 0) {
          up[i] = r
          any = true
        }
      }
      if (any) {
        const mx = new Float32Array(n)
        for (let i = 0; i < n; i++) for (let k = Math.max(0, i - 3); k <= Math.min(n - 1, i + 3); k++) mx[i] = Math.max(mx[i], up[k])
        for (let i = 0; i < n; i++) {
          let sum = 0
          let cnt = 0
          for (let k = Math.max(0, i - 3); k <= Math.min(n - 1, i + 3); k++) {
            sum += mx[k]
            cnt++
          }
          // junto a los terminales la subida se apaga (allí manda el terreno del estribo)
          c.deck[i] += (sum / cnt) * Math.min(1, c.dTerm[i] / 12)
        }
      }
    }
    // en los estribos la calzada sale de debajo del terreno y sube unos centímetros sobre él
    for (let i = 0; i < n; i++) {
      const t = Math.min(1, c.dTerm[i] / 6)
      c.deck[i] += -0.12 + 0.42 * t * t * (3 - 2 * t)
    }

    let maxClear = 0
    for (let i = 0; i < n; i++) maxClear = Math.max(maxClear, c.deck[i] - g[i])
    c.maxClear = maxClear
    // (más de un 30 % de pendiente: escaleras o un dato raro)
    c.draw = maxClear >= MIN_CLEAR && len >= 8 && Math.abs(c.deck[n - 1] - c.deck[0]) < 0.3 * len + 1
    if (!c.draw) {
      c.carve = null
      return c
    }
    // aceras y carriles bici mapeados aparte junto a un puente de carretera o de tren
    if (parts[0].piece.kind === 'path') {
      const mine = new Set(parts.map((q) => q.piece))
      let beside = 0
      for (const f of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        const i = stationAt(c, len * f)
        const [gx, gy] = geoToUnit(c.lat[i], c.lon[i])
        if (this.net.piecesNear(gx, gy, 9).some((q) => q.piece.kind !== 'path' && !mine.has(q.piece))) beside++
      }
      c.companion = beside >= 4
    }
    if (c.companion) c.depth = 0.35
    else this.placePiers(c)
    // terraplenes de los accesos
    if (this.opts.fill) {
      for (const end of [0, 1] as const) {
        if (!(end ? c.endTerminal : c.startTerminal)) continue
        const f = await this.approachFill(c, end)
        if (f) c.fills.push(f)
      }
    }
    return c
  }

  /**
   * Relleno del acceso en un extremo que vuelve al suelo. El MDT (rejilla de 5 m, suavizada)
   * redondea el terraplén contra el estribo: el terreno queda varios metros por debajo de la
   * calzada justo donde acaba el puente y no llega a su altura hasta 6–12 m más allá, así que el
   * tablero terminaba en un escalón sobre un hueco y los coches bajaban a él y volvían a subir de
   * golpe. Se rellena a la altura de la calzada, recto desde el extremo hasta donde el terreno ya
   * la alcanza, con arcén y taludes a los lados, al final y, a los lados del estribo, hacia el
   * puente (no bajo el tablero: allí acaba dentro del estribo). Lo alto llega hasta media
   * mediana si la otra calzada también es un puente que acaba ahí (cada una con su talud dejaba
   * una grieta entre las dos). Solo sube el terreno, nunca lo baja, y no tapa ninguna calle ni vía
   * a nivel del suelo salvo la que sigue al puente.
   */
  private async approachFill(c: Chain, end: 0 | 1): Promise<(TerrainPatch & { depth: number; reach: number }) | null> {
    const i = end ? c.n - 1 : 0
    const j = end ? c.n - 2 : 1
    let ue = c.e[i] - c.e[j]
    let un = c.nn[i] - c.nn[j]
    const ul = Math.hypot(ue, un)
    if (ul < 1e-3) return null
    ue /= ul
    un /= ul
    // la calzada sale del terreno del estribo 0,12 m por debajo de él (ver arriba)
    const top = c.deck[i] + 0.12
    const lat = c.lat[i]
    const lon = c.lon[i]
    const { mLat, mLon } = c
    const around = FILL_REACH + 50
    await this.heights.ensure(lat - around / mLat, lon - around / mLon, lat + around / mLat, lon + around / mLon)
    // (punto a d metros hacia fuera por el eje y o a la derecha)
    const geoAt = (d: number, o: number): [number, number] => [lat + (un * d - ue * o) / mLat, lon + (ue * d + un * o) / mLon]
    // hasta dónde llega el hueco: el primer punto del eje donde el terreno ya está a la altura de
    // la calzada (o, si no llega, el más alto); y lo hondo que es
    let reach = -1
    let low = Infinity
    let best = -Infinity
    let bestD = 0
    for (let d = 0; d <= FILL_REACH; d++) {
      const h = this.heights.sample(...geoAt(d, 0))
      if (h === null) continue
      if (h >= top - 0.15) {
        reach = d
        break
      }
      low = Math.min(low, h)
      if (h > best) {
        best = h
        bestD = d
      }
    }
    if (reach < 0) reach = bestD
    const depth = top - low
    if (reach === 0 || !(depth >= FILL_MIN) || depth > FILL_MAX) return null

    const hw = c.hw[i]
    // semiancho de lo alto a cada lado (izquierda, derecha): la calzada y su arcén, o hasta media
    // mediana si al lado acaba otro puente paralelo (la otra calzada)
    const pad = this.opts.fillPad ?? 0
    let wcL = hw + FILL_SHOULDER + pad
    let wcR = hw + FILL_SHOULDER + pad
    const [egx, egy] = geoToUnit(lat, lon)
    const mine = new Set(c.parts.map((q) => q.piece))
    const metres = (gx: number, gy: number): [number, number] => {
      const [la, lo] = unitToGeo(gx, gy)
      return [(lo - lon) * mLon, (la - lat) * mLat]
    }
    for (const q of this.net.piecesNear(egx, egy, 40)) {
      const p = q.piece
      if (mine.has(p)) continue
      // que también acabe aquí (un extremo que vuelve al suelo a menos de 30 m)
      if (![p.a, p.b].some((nd) => this.net.isTerminal(nd) && Math.hypot(...metres(nd.gx, nd.gy)) < 30)) continue
      const k = q.index
      const [ax, ay] = metres(p.gx[k], p.gy[k])
      const [bx, by] = metres(p.gx[k + 1], p.gy[k + 1])
      const sl = Math.hypot(bx - ax, by - ay)
      if (sl < 1e-3 || Math.abs((bx - ax) * ue + (by - ay) * un) < 0.9 * sl) continue // no es paralelo
      const px = ax + (bx - ax) * q.t
      const py = ay + (by - ay) * q.t
      if (Math.abs(px * ue + py * un) > 15) continue // no va al lado
      const off = px * un - py * ue
      const gap = Math.abs(off) - p.width / 2
      if (gap <= hw || gap > hw + 25) continue
      const mid = (hw + gap) / 2
      if (off > 0) wcR = Math.max(wcR, mid)
      else wcL = Math.max(wcL, mid)
    }
    const slope = FILL_SLOPE * depth
    // (lo alto, hasta donde el terreno alcanza la calzada; con margen, algo más)
    const top0 = reach + pad
    const far = top0 + slope
    const inward = -1.5 - pad - slope
    const sideL = wcL + slope
    const sideR = wcR + slope
    /** altura del relleno en (d, o), sin mirar el terreno; -Infinity donde no hay */
    const target = (d: number, o: number): number => {
      const ao = Math.abs(o)
      if (ao <= hw + 0.3) {
        // bajo el tablero: solo hasta dentro del estribo, que mide 1,5 m hacia el puente
        if (d < -2 - pad) return -Infinity
        return top - Math.max(0, d - top0) / FILL_SLOPE - (d < 0 ? 0.15 : 0)
      }
      const lx = Math.max(0, ao - (o > 0 ? wcR : wcL))
      return top - (Math.max(0, d - top0) + Math.max(0, -d - 1.5 - pad) + lx) / FILL_SLOPE
    }
    // celdas de 1 m que el relleno subiría pero son de otra calle o vía a nivel del suelo
    const d0 = Math.floor(inward)
    const o0 = Math.floor(-sideL)
    const nd = Math.ceil(far) - d0 + 1
    const no = Math.ceil(sideR) - o0 + 1
    const blocked = new Uint8Array(nd * no)
    const skip = { gx: egx, gy: egy, r: 10, through: 1.5 }
    for (let a = 0; a < nd; a++) {
      for (let b = 0; b < no; b++) {
        const d = d0 + a
        const o = o0 + b
        const t = target(d, o)
        if (t === -Infinity) continue
        const [la, lo] = geoAt(d, o)
        const h = this.heights.sample(la, lo)
        if (h === null || t <= h + 0.05) continue
        const [gx, gy] = geoToUnit(la, lo)
        if (this.net.onGroundWay(gx, gy, 0.5, skip)) blocked[a * no + b] = 1
      }
    }
    let south = 90
    let north = -90
    let west = 180
    let east = -180
    for (const d of [inward, far]) {
      for (const o of [-sideL, sideR]) {
        const [la, lo] = geoAt(d, o)
        south = Math.min(south, la)
        north = Math.max(north, la)
        west = Math.min(west, lo)
        east = Math.max(east, lo)
      }
    }
    const e0 = c.e[i]
    const n0 = c.nn[i]
    const { lat0, lon0 } = c
    return {
      key: `bridgefill:${c.key}:${end}`,
      south,
      west,
      north,
      east,
      depth,
      reach,
      maxCell: FILL_MAX_CELL,
      apply(la: number, lo: number, h: number): number {
        const px = (lo - lon0) * mLon - e0
        const py = (la - lat0) * mLat - n0
        const d = px * ue + py * un
        if (d < inward || d > far) return h
        const o = px * un - py * ue
        let t = target(d, o)
        if (t <= h) return h
        const a = Math.round(d) - d0
        const b = Math.round(o) - o0
        if (a >= 0 && a < nd && b >= 0 && b < no && blocked[a * no + b]) return h
        // (bajo el estribo se funde con el terreno de debajo del tablero)
        if (d < -1 - pad && Math.abs(o) <= hw + 0.3) t = h + (d + 2 + pad) * (t - h)
        return t
      },
    }
  }

  /**
   * Marca las estaciones donde el MDT lleva el tablero incrustado, corrige la rasante con esa
   * altura (que es la de verdad) y prepara el rebaje del terreno.
   */
  private detectCarve(c: Chain): void {
    const n = c.n
    const g = c.ground
    const flag = new Uint8Array(n)
    const sample = (i: number, off: number): number => {
      const [la, lo] = offsetGeo(c, i, off)
      return this.heights.sample(la, lo) ?? NaN
    }
    // otros tableros que van pegados (la otra calzada de una autovía, una vía paralela): el
    // terreno de «al lado» se mide más allá de todos ellos
    const mine = new Set(c.parts.map((q) => q.piece))
    // por lado (0 izquierda, 1 derecha): terreno a cada distancia de SIDES del borde del conjunto
    const side = [0, 1].map(() => SIDES.map(() => new Float32Array(n)))
    const ext = [new Float32Array(n), new Float32Array(n)]
    const top = new Float32Array(n)
    let extL = 0
    let extR = 0
    for (let i = 0; i < n; i++) {
      if (i % 4 === 0) [extL, extR] = lateralExtent(this.net, c, i, mine)
      ext[0][i] = extL
      ext[1][i] = extR
      SIDES.forEach((d, k) => {
        side[0][k][i] = sample(i, -(extL + d))
        side[1][k][i] = sample(i, extR + d)
      })
      const hw = c.hw[i]
      const cl = sample(i, -hw / 2)
      const cr = sample(i, hw / 2)
      top[i] = Math.max(g[i], Number.isNaN(cl) ? g[i] : cl, Number.isNaN(cr) ? g[i] : cr)
    }
    // sin dato (el MDT no sirve las teselas de mar adentro): el del punto con dato más cercano
    // a lo largo del puente, por ese mismo lado
    for (const arrs of side) {
      for (const arr of arrs) {
        let last = NaN
        for (let i = 0; i < n; i++) {
          if (!Number.isNaN(arr[i])) last = arr[i]
          else arr[i] = last
        }
        last = NaN
        for (let i = n - 1; i >= 0; i--) {
          if (!Number.isNaN(arr[i])) last = arr[i]
          else arr[i] = last
        }
      }
    }
    // suelo de cada lado (el más bajo de las muestras) y hasta dónde llega el resalte: la primera
    // distancia a la que el terreno ya está casi en ese suelo. Un tablero estrecho cae a plomo
    // (8 m); uno ancho, o con el escalón repartido por los triángulos largos que el MDT tiende
    // sobre el agua, necesita un rebaje más ancho o quedaría entre dos paredes de terreno.
    const floor = [new Float32Array(n), new Float32Array(n)]
    const reach = [new Float32Array(n), new Float32Array(n)]
    let any = false
    for (let i = 0; i < n; i++) {
      const t = top[i]
      let ok = true
      for (let q = 0; q < 2; q++) {
        let low = Infinity
        for (const arr of side[q]) low = Math.min(low, arr[i])
        if (Number.isNaN(low)) {
          ok = false
          floor[q][i] = g[i]
          reach[q][i] = c.hw[i] + SIDES[0]
          continue
        }
        floor[q][i] = low
        let k = 0
        while (k < SIDES.length - 1 && side[q][k][i] > low + 1 + 0.2 * Math.max(0, t - low)) k++
        reach[q][i] = ext[q][i] + SIDES[k]
        floor[q][i] = side[q][k][i]
      }
      if (!ok || c.dTerm[i] < 4) continue
      const fl = floor[0][i]
      const fr = floor[1][i]
      const hi = Math.max(fl, fr)
      const lo = Math.min(fl, fr)
      // Un tablero incrustado cae casi a plomo: a SIDE_STEEP del borde el terreno ya ha bajado
      // casi todo lo que baja; un terraplén o un pedraplén (que OSM a veces etiqueta como puente)
      // siguen bajando en talud. Con menos de 6 m de altura no se distinguen: vale lo que diga
      // OSM. Y con 20 m o más ya no es un terraplén.
      const steep = (q: number) => t - floor[q][i] < 6 || t - floor[q][i] >= 20 || t - side[q][1][i] >= 0.6 * (t - floor[q][i])
      // (una presa tiene el agua alta a un lado y el pie mucho más abajo al otro: no es un puente)
      const level = t - hi >= 20 || hi - lo <= 0.35 * (t - lo) + 1.5
      // el terreno llega (casi) a la calzada, o la supera, y a los dos lados cae al menos 3 m
      if (t >= c.deck[i] - 2.5 && t - hi >= 3 && level && steep(0) && steep(1)) {
        flag[i] = 1
        any = true
      }
    }
    this.carveDebug?.(
      c,
      Array.from({ length: n }, (_, i) => ({ s: c.s[i], deck: c.deck[i], top: top[i], left: side[0].map((q) => q[i]), right: side[1].map((q) => q[i]), flag: flag[i] })),
    )
    if (!any) return
    // tramos de menos de tres estaciones: ruido
    for (let i = 0; i < n; ) {
      if (!flag[i]) {
        i++
        continue
      }
      let j = i
      while (j < n && flag[j]) j++
      if (j - i < 3) for (let k = i; k < j; k++) flag[k] = 0
      i = j
    }
    // huecos cortos entre tramos marcados (una pila ancha, un islote del MDT): también
    for (let i = 1; i < n - 1; i++) {
      if (flag[i] || !flag[i - 1]) continue
      let j = i
      while (j < n && !flag[j]) j++
      if (j < n && c.s[j] - c.s[i - 1] < 30) for (let k = i; k < j; k++) if (c.dTerm[k] >= 4) flag[k] = 2
      i = j
    }
    let stations = 0
    const w = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      if (flag[i]) {
        w[i] = 1
        stations++
      }
    }
    if (stations === 0) return
    // Donde el MDT trae el tablero, su altura es la de verdad (es LiDAR de la calzada): la rasante
    // deducida de los estribos se corrige para pasar por esos puntos, interpolando entre ellos y
    // volviendo a cero en los extremos de la cadena (donde manda el terreno del estribo o el cruce).
    // Solo valen las estaciones cuya altura sigue a la de sus vecinas marcadas (a dos estaciones,
    // por cada lado que lo esté) como lo haría una calzada: 12 % de pendiente y 1,5 m de ruido. En
    // los bordes de cada tramo incrustado el MDT baja en rampa hasta el agua o el suelo (de 14 a
    // 37 m en 12 m en Cádiz) y anclar la rasante ahí la hacía caer en cada hueco entre tramos y
    // subir de golpe en el siguiente. Una estación del borde (con una sola vecina marcada) puede
    // estar ya en el arranque de esa rampa sin que se note con esa holgura (en Cádiz, 2,1 m más
    // baja que la de 12 m antes): esas tienen que seguir a su vecina como una calzada de verdad,
    // con un 6 % y medio metro de ruido.
    const trusted = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      if (flag[i] !== 1) continue
      const nb: number[] = []
      for (const j of [i - 2, i + 2]) if (j >= 0 && j < n && flag[j]) nb.push(j)
      if (nb.length === 0) continue
      // (con las dos vecinas marcadas: 12 % + 1,5 m con cada una; con una sola, un borde: 6 % + 0,5 m)
      const [grade, noise] = nb.length === 2 ? [0.12, 1.5] : [0.06, 0.5]
      if (nb.every((j) => Math.abs(top[i] - top[j]) <= grade * Math.abs(c.s[i] - c.s[j]) + noise)) trusted[i] = 1
    }
    {
      const anchors: Array<[number, number]> = [[0, 0]]
      for (let i = 0; i < n; i++) {
        if (!trusted[i]) continue
        // (cerca de un extremo, lo que quepa con un 8 % de rampa)
        const room = 0.08 * Math.min(c.s[i], c.len - c.s[i])
        anchors.push([c.s[i], Math.min(room, Math.max(-room, top[i] + 0.3 - c.deck[i]))])
      }
      anchors.push([c.len, 0])
      c.measured = anchors.length > 2
      const up = new Float32Array(n)
      let k = 0
      for (let i = 0; i < n; i++) {
        while (k + 2 < anchors.length && anchors[k + 1][0] < c.s[i]) k++
        const [s0, v0] = anchors[k]
        const [s1, v1] = anchors[k + 1]
        up[i] = s1 > s0 ? v0 + (v1 - v0) * Math.min(1, Math.max(0, (c.s[i] - s0) / (s1 - s0))) : v1
      }
      // (suavizado: el MDT tiene su ruido). Se suaviza la rasante ya corregida, no solo la
      // corrección: la deducida de los estribos puede traer un quiebro (en Cádiz, donde el terminal
      // de la otra orilla deja de pesar a 1500 m y manda el terreno, que allí es el tablero
      // incrustado) y sumarle una corrección suavizada lo dejaba entero, como un pico de 5 m sobre
      // el LiDAR junto al pilono del muelle. Ventana simétrica, más corta en los extremos: allí la
      // altura es la del estribo o la del cruce y no se mueve.
      const raw = Float32Array.from(c.deck, (v, i) => v + up[i])
      for (let i = 0; i < n; i++) {
        const k = Math.min(3, i, n - 1 - i)
        let sum = 0
        for (let j = i - k; j <= i + k; j++) sum += raw[j]
        c.deck[i] = sum / (2 * k + 1)
      }
    }
    // Más allá del primer y del último punto con el tablero en el MDT, si queda mucho puente (el de
    // Cádiz tiene 1,5 km de viaducto sobre la Cabezuela que el MDT no trae), la rasante no puede
    // caer más deprisa que la pendiente máxima de su clase (5 % en el de Cádiz): la deducida de los
    // estribos bajaba 50 m en 100 m tras el pilono. Solo sube, y cerca de los extremos lo que quepa
    // con un 8 % de rampa, como los anclajes.
    {
      const grade = MAX_GRADE[c.parts[0].piece.kind] ?? 0.06
      let first = -1
      let last = -1
      for (let i = 0; i < n; i++) {
        if (!trusted[i]) continue
        if (first < 0) first = i
        last = i
      }
      // La cola va en recta del último ancla al extremo (la deducida de los estribos más la
      // corrección repartida a lo largo de 1,6 km hacía una curva que dependía de por dónde pasaba
      // cada calzada: en Cádiz las dos de la autovía acababan con 2,8 m de diferencia, solapadas), y
      // si esa recta cae más que la pendiente máxima, con la pendiente máxima.
      const tail = (a: number, dir: 1 | -1): void => {
        const h = c.deck[a]
        const e = dir > 0 ? n - 1 : 0
        const span = Math.abs(c.s[e] - c.s[a])
        const he = c.deck[e]
        for (let i = a + dir; i >= 0 && i < n; i += dir) {
          const d = Math.abs(c.s[i] - c.s[a])
          const line = h + ((he - h) * d) / span
          const want = Math.max(line, h - grade * d)
          const room = 0.08 * Math.min(c.s[i], c.len - c.s[i])
          if (want > c.deck[i]) c.deck[i] = Math.max(c.deck[i], Math.min(want, line + room))
        }
      }
      if (first >= 0 && c.s[first] > LONG_TAIL) tail(first, -1)
      if (last >= 0 && c.len - c.s[last] > LONG_TAIL) tail(last, 1)
    }
    // Donde acaba un tramo incrustado pero el puente sigue en el aire, el MDT baja en rampa del
    // tablero al agua o al suelo a lo largo del eje (en Cádiz, de 69 a 5 m en 30 m junto al pilono
    // del muelle de la Cabezuela): esa rampa se rebaja también, mientras siga bajando, la calzada
    // quede al menos 3 m por encima y no se llegue al estribo (allí la subida es el terraplén).
    {
      const ends: Array<[number, 1 | -1]> = []
      for (let i = 0; i < n; i++) {
        if (!w[i]) continue
        if (i + 1 < n && !w[i + 1]) ends.push([i, 1])
        if (i > 0 && !w[i - 1]) ends.push([i, -1])
      }
      for (const [i, dir] of ends) {
        let prev = top[i]
        for (let j = i + dir; j >= 0 && j < n && Math.abs(c.s[j] - c.s[i]) <= RAMP_MAX; j += dir) {
          if (w[j] || c.dTerm[j] < 4) break
          const bottom = Math.min(floor[0][j], floor[1][j])
          if (top[j] > prev + 0.5 || top[j] <= bottom + 1 || c.deck[j] - top[j] < 3) break
          w[j] = 1
          stations++
          prev = top[j]
        }
      }
    }
    // Tableros altos (TALL): el rebaje baja hasta el suelo natural de al lado, no hasta el primer
    // punto a menos de un 20 % de la caída (en Cádiz eso dejaba mesetas de 10–15 m junto al
    // tablero). Suelo natural: yendo hacia fuera, el primer punto ya en lo bajo de la caída (su
    // 15 % inferior) a partir del cual el terreno deja de caer en picado (menos de un 10 %): el agua
    // de la bahía, el muelle de la Cabezuela. Más allá de SIDES si hace falta (WIDE): las muestras
    // cercanas pueden caer aún en la rampa del MDT o en el tablero incrustado de otra calzada que se
    // separa, como junto al pilono del muelle. Si no aparece (una ladera que sigue bajando), como antes.
    for (let i = 0; i < n; i++) {
      if (!w[i] && !(i > 0 && w[i - 1]) && !(i < n - 1 && w[i + 1])) continue
      const t = top[i]
      for (let q = 0; q < 2; q++) {
        let low = Infinity
        for (const arr of side[q]) low = Math.min(low, arr[i])
        if (!(t - low >= TALL)) continue
        const dists = [...SIDES]
        const vals = side[q].map((arr) => arr[i])
        const sgn = q ? 1 : -1
        const far = WIDE.map((d) => sample(i, sgn * (ext[q][i] + d)))
        if (!far.some((v) => Number.isNaN(v))) {
          dists.push(...WIDE)
          vals.push(...far)
        }
        const fLow = Math.min(...vals)
        if (!Number.isFinite(fLow)) continue
        const cap = fLow + 1 + 0.15 * (t - fLow)
        let k = -1
        for (let j = 0; j < vals.length; j++) {
          if (vals[j] > cap) continue
          const next = j + 1 < vals.length ? vals[j + 1] : vals[j]
          const dd = j + 1 < vals.length ? dists[j + 1] - dists[j] : 1
          if (vals[j] - next <= 1 + 0.1 * dd) {
            k = j
            break
          }
        }
        if (k < 0) continue
        // y al menos tan ancho como alto es el tablero sobre ese suelo: los niveles gruesos del MDT
        // (las teselas que se ven a unos cientos de metros, que solo se corrigen vértice a vértice)
        // reparten la cresta del tablero mucho más a los lados (en Cádiz, 20 m de terreno a 55 m
        // del eje en el nivel 13) y dejaban paredes a lo largo del puente. Más allá de la caída
        // real el terreno ya está en el suelo y no cambia (el rebaje solo baja).
        reach[q][i] = ext[q][i] + Math.max(dists[k], Math.min(WIDE[WIDE.length - 1], t - vals[k]))
        floor[q][i] = vals[k]
      }
    }
    // terreno ya rebajado bajo el eje
    for (let i = 0; i < n; i++) if (w[i] > 0) g[i] = Math.min(g[i], (floor[0][i] + floor[1][i]) / 2)

    let south = 90
    let north = -90
    let west = 180
    let east = -180
    for (let i = 0; i < n; i++) {
      if (w[i] === 0 && !(i > 0 && w[i - 1] > 0) && !(i < n - 1 && w[i + 1] > 0)) continue
      for (const off of [-(reach[0][i] + 2), reach[1][i] + 2]) {
        const [la, lo] = offsetGeo(c, i, off)
        south = Math.min(south, la)
        north = Math.max(north, la)
        west = Math.min(west, lo)
        east = Math.max(east, lo)
      }
    }
    const { e, nn, lat0, lon0, mLat, mLon } = c
    const [fl, fr] = floor
    const [rl, rr] = reach
    c.carve = {
      key: `bridge:${c.key}`,
      south,
      west,
      north,
      east,
      stations,
      apply(lat: number, lon: number, h: number): number {
        const px = (lon - lon0) * mLon
        const py = (lat - lat0) * mLat
        // tramo de la polilínea más cercano
        let best = Infinity
        let bi = -1
        let bt = 0
        let boff = 0
        for (let i = 0; i + 1 < n; i++) {
          if (w[i] === 0 && w[i + 1] === 0) continue
          const dx = e[i + 1] - e[i]
          const dy = nn[i + 1] - nn[i]
          const l2 = dx * dx + dy * dy
          if (l2 < 1e-6) continue
          const t = Math.min(1, Math.max(0, ((px - e[i]) * dx + (py - nn[i]) * dy) / l2))
          const ox = px - e[i] - dx * t
          const oy = py - nn[i] - dy * t
          const d2 = ox * ox + oy * oy
          if (d2 < best) {
            best = d2
            bi = i
            bt = t
            // + a la derecha del sentido de avance
            boff = (ox * dy - oy * dx) / Math.sqrt(l2)
          }
        }
        if (bi < 0) return h
        const d = Math.sqrt(best)
        // hasta dónde llega el rebaje a cada lado del eje: total hasta CARVE_BLEND m antes, y se funde
        const reachL = rl[bi] + (rl[bi + 1] - rl[bi]) * bt
        const reachR = rr[bi] + (rr[bi + 1] - rr[bi]) * bt
        const lim = boff < 0 ? reachL : reachR
        if (d >= lim) return h
        const along = w[bi] + (w[bi + 1] - w[bi]) * bt
        const lateral = d <= lim - CARVE_BLEND ? 1 : (lim - d) / CARVE_BLEND
        const k = along * lateral * lateral * (3 - 2 * lateral)
        if (k <= 0) return h
        const left = fl[bi] + (fl[bi + 1] - fl[bi]) * bt
        const right = fr[bi] + (fr[bi + 1] - fr[bi]) * bt
        const base = left + (right - left) * Math.min(1, Math.max(0, (boff + reachL) / (reachL + reachR)))
        return base < h ? h + k * (base - h) : h
      },
    }
  }

  /** Pilas: vanos iguales a lo largo de la cadena, esquivando calzadas y vías que pasan por debajo. */
  private placePiers(c: Chain): void {
    const kind = c.parts[0].piece.kind
    const target = kind === 'road' ? 34 : kind === 'rail' ? 30 : 22
    const spans = c.len < target * 1.35 ? 1 : Math.max(1, Math.round(c.len / target))
    const span = c.len / spans
    c.depth = kind === 'path' ? Math.min(1.3, Math.max(0.4, span / 28)) : Math.min(2.8, Math.max(0.9, span / 20))
    for (let k = 1; k < spans; k++) {
      const base = k * span
      for (const shift of [0, -span / 5, span / 5, -span / 3, span / 3]) {
        const s = base + shift
        const i = stationAt(c, s)
        if (c.deck[i] - c.ground[i] < 2.4 + c.depth) break // casi a ras de suelo: sin pila
        const [gx, gy] = geoToUnit(c.lat[i], c.lon[i])
        if (this.net.onGroundWay(gx, gy, 1.5)) continue
        c.piers.push(c.s[i])
        break
      }
    }
  }
}

/**
 * Hasta dónde llegan a cada lado (m desde el eje, [izquierda, derecha]) los tableros que van
 * pegados al de la cadena en la estación i: la otra calzada de una autovía, una vía paralela,
 * las aceras mapeadas aparte… Como mínimo, su propio semiancho.
 */
export function lateralExtent(net: BridgeNet, c: Chain, i: number, mine: Set<BridgePiece>): [number, number] {
  let extL = c.hw[i]
  let extR = c.hw[i]
  const [gx, gy] = geoToUnit(c.lat[i], c.lon[i])
  for (const q of net.piecesNear(gx, gy, 40)) {
    if (mine.has(q.piece)) continue
    const p = q.piece
    const [la, lo] = unitToGeo(p.gx[q.index] + (p.gx[q.index + 1] - p.gx[q.index]) * q.t, p.gy[q.index] + (p.gy[q.index + 1] - p.gy[q.index]) * q.t)
    const de = (lo - c.lon[i]) * c.mLon
    const dn = (la - c.lat[i]) * c.mLat
    if (Math.abs(de * c.te[i] + dn * c.tn[i]) > 12) continue // no va al lado: cruza o queda por delante
    const off = de * c.tn[i] - dn * c.te[i]
    if (off > 0) extR = Math.max(extR, off + p.width / 2)
    else extL = Math.max(extL, -off + p.width / 2)
  }
  return [extL, extR]
}

/** Punto de la cadena más cercano a (lat, lon): posición s, desfase lateral (+ a la derecha) y distancia. */
export function projectOnChain(c: Chain, lat: number, lon: number): { s: number; off: number; d: number } {
  const px = (lon - c.lon0) * c.mLon
  const py = (lat - c.lat0) * c.mLat
  let best = Infinity
  let bs = 0
  let boff = 0
  for (let i = 0; i + 1 < c.n; i++) {
    const dx = c.e[i + 1] - c.e[i]
    const dy = c.nn[i + 1] - c.nn[i]
    const l2 = dx * dx + dy * dy
    if (l2 < 1e-6) continue
    const t = Math.min(1, Math.max(0, ((px - c.e[i]) * dx + (py - c.nn[i]) * dy) / l2))
    const ox = px - c.e[i] - dx * t
    const oy = py - c.nn[i] - dy * t
    const d2 = ox * ox + oy * oy
    if (d2 < best) {
      best = d2
      bs = c.s[i] + (c.s[i + 1] - c.s[i]) * t
      boff = (ox * dy - oy * dx) / Math.sqrt(l2)
    }
  }
  return { s: bs, off: boff, d: Math.sqrt(best) }
}

/** Índice de la estación más cercana a la posición s. */
export function stationAt(c: Chain, s: number): number {
  let lo = 0
  let hi = c.n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (c.s[mid] <= s) lo = mid
    else hi = mid
  }
  return s - c.s[lo] <= c.s[hi] - s ? lo : hi
}

/**
 * La rasante no baja más deprisa que `grade` en ningún sentido: la menor que pase por encima de la
 * que había con esa pendiente máxima (solo sube). Cerca de los extremos, lo que quepa con un 8 % de
 * rampa (allí manda la altura del estribo o del cruce).
 */
function limitGrade(c: Chain, grade: number): void {
  const { n, s, deck } = c
  const env = Float64Array.from(deck)
  for (let i = 1; i < n; i++) env[i] = Math.max(env[i], env[i - 1] - grade * (s[i] - s[i - 1]))
  for (let i = n - 2; i >= 0; i--) env[i] = Math.max(env[i], env[i + 1] - grade * (s[i + 1] - s[i]))
  for (let i = 0; i < n; i++) deck[i] = Math.min(env[i], deck[i] + 0.08 * Math.min(s[i], c.len - s[i]))
}

/** Acuerdos verticales: la rasante, suavizada como dice `smoothAlong`. */
function smoothDeck(c: Chain, half: number): void {
  c.deck.set(smoothAlong(c, c.deck, half))
}

/**
 * Media móvil de un perfil de la cadena en ±h m a lo largo del eje (del perfil lineal entre
 * estaciones), con h = min(half, distancia al extremo más cercano): los extremos no se mueven, una
 * recta se queda como está y un quiebro pasa a ser una curva de 2h m (un acuerdo vertical).
 */
export function smoothAlong(c: Chain, arr: ArrayLike<number>, half: number): Float32Array {
  const { n, s } = c
  const out = Float32Array.from(arr)
  if (n < 3) return out
  const d = Float64Array.from(arr)
  // integral de la rasante desde el principio hasta cada estación (trapecios)
  const acc = new Float64Array(n)
  for (let i = 1; i < n; i++) acc[i] = acc[i - 1] + ((d[i] + d[i - 1]) / 2) * (s[i] - s[i - 1])
  const integral = (x: number): number => {
    if (x <= s[0]) return 0
    if (x >= s[n - 1]) return acc[n - 1]
    let lo = 0
    let hi = n - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (s[mid] <= x) lo = mid
      else hi = mid
    }
    const ds = s[hi] - s[lo]
    const v = ds > 0 ? d[lo] + ((d[hi] - d[lo]) * (x - s[lo])) / ds : d[lo]
    return acc[lo] + ((d[lo] + v) / 2) * (x - s[lo])
  }
  for (let i = 1; i < n - 1; i++) {
    const h = Math.min(half, s[i] - s[0], s[n - 1] - s[i])
    if (h < 0.5) continue
    out[i] = (integral(s[i] + h) - integral(s[i] - h)) / (2 * h)
  }
  return out
}

/** Valor interpolado de un perfil en la posición s. */
export function profileAt(c: Chain, arr: ArrayLike<number>, s: number): number {
  let lo = 0
  let hi = c.n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (c.s[mid] <= s) lo = mid
    else hi = mid
  }
  const d = c.s[hi] - c.s[lo]
  const t = d > 0 ? Math.min(1, Math.max(0, (s - c.s[lo]) / d)) : 0
  return arr[lo] + (arr[hi] - arr[lo]) * t
}
