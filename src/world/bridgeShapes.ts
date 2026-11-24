// Estructura de los puentes de tipo conocido: torres, cables y péndolas de los colgantes,
// pilonos y tirantes de los atirantados, arcos (bajo el tablero, sobre él o en fila, de
// fábrica) y celosías. Las teselas vectoriales solo traen el trazado; el tipo, la longitud,
// el vano y la altura salen de public/bridges.bin (Wikidata, tools/bridges.ts).
//
// Cada registro es un punto: se casa con la cadena (bridgeChains.ts) que pasa más cerca y se
// parezca en longitud; el vano principal se coloca sobre lo más hondo (el agua o el fondo del
// barranco) y lo demás se deduce con las proporciones habituales de cada tipo. Son puentes
// genéricos de su clase, no maquetas: un colgante sale con dos torres y catenaria, no con los
// detalles del Golden Gate.
//
// La geometría se construye en «coordenadas de cadena» (s a lo largo, desfase lateral, altura
// sobre la calzada) y ChainFrame la lleva al marco de la tesela que la dibuja.

import { Color, Vector3 } from 'three'
import {
  BRIDGE_ARCH,
  BRIDGE_ARCH_DECK,
  BRIDGE_ARCH_STONE,
  BRIDGE_ARCH_THROUGH,
  BRIDGE_CABLE_STAYED,
  BRIDGE_CANTILEVER,
  BRIDGE_EXTRADOSED,
  BRIDGE_SUSPENSION,
  BRIDGE_TRUSS,
  type BridgeRecord,
} from './bridgeFormat.ts'
import { lateralExtent, profileAt, projectOnChain, stationAt, type Chain, type ChainBuilder } from './bridgeChains.ts'
import type { ChainFrame, MeshBuilder, Prim } from './bridgeMesh.ts'
import { E, geoToUnit, metresPerUnit, unitToGeo, type BridgeNet } from './bridgeNet.ts'
import { bridgeRecordsNear } from './bridgeStructures.ts'

type Shape = 'suspension' | 'stayed' | 'arcade' | 'archDeck' | 'archThrough' | 'truss'

interface Bay {
  /** ¿cabe un arco? (si no, tablero normal) */
  ok: boolean
  /** flecha del arco y espesor en la clave (m) */
  rise: number
  crown: number
}

export interface StructurePlan {
  /** la cadena que lleva la estructura (las paralelas la comparten) */
  owner: Chain
  rec: BridgeRecord
  shape: Shape
  /** posición (s en `owner`) del centro de la estructura: la dibuja la tesela donde cae */
  centre: number
  /** extremos del puente propiamente dicho y del vano principal, en `owner` */
  a: number
  b: number
  m0: number
  m1: number
  span: number
  /** hasta dónde llegan los tableros pegados, a izquierda y derecha del eje (m) */
  extL: number
  extR: number
  colour: Color
  /** zona sin pilas propias de la cadena: [desde, hasta] */
  clear: [number, number]
  /** canto del tablero en la zona de la estructura (m) */
  girder: number
  // colgantes y atirantados
  towers: number[]
  towerH: number
  /** las torres las dibuja la estructura (false: ya están en OSM como edificios) */
  ownTowers: boolean
  /** hasta dónde llegan los cables a cada lado de la primera y la última torre (m) */
  back0: number
  back1: number
  // arcos en fila
  bays: Bay[]
  bayLen: number
  pierHalf: number
  // arco único
  rise: number
  // celosía
  trussH: number
  cantilever: boolean
  /** pilas que pone la estructura (s) */
  piers: number[]
  /** cuánto sube la rasante (m) en la posición s de la dueña (grandes vanos sobre el agua) */
  raise(s: number): number
  /** canto del tablero (m) en la posición s de la cadena c */
  depth(c: Chain, s: number): number
  /** ¿puede haber una pila de la cadena c en su posición s? */
  pierAllowed(c: Chain, s: number): boolean
  /** en cuántos trozos partir el tramo [s0, s1] de la cadena c al dibujar el tablero */
  subdiv(c: Chain, s0: number, s1: number): number
  /** ¿el tablero de la cadena c en s es de fábrica maciza (arcos en fila)? */
  solid(c: Chain, s: number): boolean
}

// colores en sRGB
const STEEL = 0x848c93
const CABLE = 0x4c5055
const PYLON = 0xc9c6bf
const STAY = 0xe4e4e0
const ARCH_STEEL = 0x7c8891
const ARCH_CONCRETE = 0xb7b3aa
const STONE = 0xa99a7e
const TRUSS_STEEL = 0x5f6d75

const PRIORITY = [BRIDGE_SUSPENSION, BRIDGE_CABLE_STAYED, BRIDGE_EXTRADOSED, BRIDGE_CANTILEVER, BRIDGE_TRUSS, BRIDGE_ARCH_THROUGH, BRIDGE_ARCH_DECK, BRIDGE_ARCH, BRIDGE_ARCH_STONE]

const owners = new WeakMap<BridgeRecord, Promise<{ chain: Chain; s: number; d: number } | null>>()
const plans = new WeakMap<Chain, Promise<StructurePlan | null>>()

/** La cadena a la que corresponde un registro: la que pasa cerca del punto y más se le parece en longitud. */
function ownerOf(rec: BridgeRecord, net: BridgeNet, builder: ChainBuilder): Promise<{ chain: Chain; s: number; d: number } | null> {
  let p = owners.get(rec)
  if (p) return p
  p = (async () => {
    const [gx, gy] = geoToUnit(rec.lat, rec.lon)
    // las coordenadas de Wikidata pueden caer en un extremo o algo desviadas
    const radius = Math.min(260, 70 + 0.12 * (rec.length || 300))
    const tx = Math.floor(gx / E)
    const ty = Math.floor(gy / E)
    const fx = gx / E - tx
    const fy = gy / E - ty
    const jobs: Array<Promise<void>> = []
    for (let dy = fy < 0.15 ? -1 : 0; dy <= (fy > 0.85 ? 1 : 0); dy++) for (let dx = fx < 0.15 ? -1 : 0; dx <= (fx > 0.85 ? 1 : 0); dx++) jobs.push(net.close(tx + dx, ty + dy))
    await Promise.all(jobs)
    const seen = new Set<Chain>()
    let best: { chain: Chain; s: number; d: number } | null = null
    let bestScore = Infinity
    const old = rec.type === BRIDGE_ARCH_STONE || rec.type === BRIDGE_ARCH
    for (const q of net.piecesNear(gx, gy, radius).sort((u, v) => u.d - v.d)) {
      const chain = await builder.chain(q.piece)
      if (!chain || !chain.draw || seen.has(chain)) continue
      seen.add(chain)
      const pr = projectOnChain(chain, rec.lat, rec.lon)
      let score = pr.d
      if (rec.length > 0) score += 40 * Math.abs(Math.log2(chain.len / rec.length))
      // los puentes notables rara vez son pasarelas (salvo los antiguos, hoy peatonales muchos)
      if (chain.parts[0].piece.kind === 'path') score += chain.companion ? 80 : old || (rec.length > 0 && rec.length < 150) ? 8 : 35
      // a igualdad, la calzada principal antes que una vía de servicio o un ramal
      else score += 2 * Math.max(0, 11 - chain.parts[0].piece.width)
      if (score < bestScore) {
        bestScore = score
        best = { chain, s: pr.s, d: pr.d }
      }
    }
    return best
  })().catch(() => null)
  owners.set(rec, p)
  return p
}

/** La estructura que lleva una cadena (como dueña), si algún registro es suyo. */
function planOfOwner(c: Chain, net: BridgeNet, builder: ChainBuilder): Promise<StructurePlan | null> {
  let p = plans.get(c)
  if (p) return p
  p = (async () => {
    const recs = await bridgeRecordsNear(c)
    let best: { rec: BridgeRecord; s: number } | null = null
    let bestRank = Infinity
    for (const rec of recs) {
      const o = await ownerOf(rec, net, builder)
      if (!o || o.chain !== c) continue
      // el tipo más «vistoso» y, a igualdad, el registro con más datos y más cercano
      const rank = PRIORITY.indexOf(rec.type) * 1000 - (rec.span > 0 ? 300 : 0) - (rec.length > 0 ? 100 : 0) + o.d
      if (rank < bestRank) {
        bestRank = rank
        best = { rec, s: o.s }
      }
    }
    return best ? makePlan(c, best.rec, best.s, net) : null
  })().catch(() => null)
  plans.set(c, p)
  return p
}

/**
 * La estructura que afecta a una cadena: la suya o la de un puente al que va pegada (la otra
 * calzada, una acera mapeada aparte): esas no llevan pilas donde el vano principal.
 */
export async function planStructure(c: Chain, recs: BridgeRecord[], net: BridgeNet, builder: ChainBuilder): Promise<StructurePlan | null> {
  const own = await planOfOwner(c, net, builder)
  if (own) return own
  const mid = c.n >> 1
  for (const rec of recs) {
    const o = await ownerOf(rec, net, builder)
    if (!o || o.chain === c) continue
    const plan = await planOfOwner(o.chain, net, builder)
    if (!plan) continue
    const pr = projectOnChain(plan.owner, c.lat[mid], c.lon[mid])
    if (pr.s > plan.a - 20 && pr.s < plan.b + 20 && pr.d <= Math.max(plan.extL, plan.extR) + 6) {
      raiseDeck(c, plan)
      return plan
    }
  }
  return null
}

/** Tramo [inicio, fin] de largo W que empieza entre lo y hi con la mayor luz libre media. */
function bestWindow(c: Chain, W: number, lo: number, hi: number): [number, number] {
  lo = Math.max(0, lo)
  hi = Math.min(c.len - W, hi)
  if (hi <= lo) {
    const st = Math.max(0, Math.min(c.len - W, lo))
    return [st, st + W]
  }
  // integral de la luz libre a lo largo
  const acc = new Float64Array(c.n)
  for (let i = 1; i < c.n; i++) acc[i] = acc[i - 1] + ((c.deck[i] - c.ground[i] + c.deck[i - 1] - c.ground[i - 1]) / 2) * (c.s[i] - c.s[i - 1])
  const at = (s: number) => profileAt(c, acc, s)
  const step = Math.max(1, (hi - lo) / 80)
  let best = lo
  let bestV = -Infinity
  const mid = (lo + hi) / 2
  for (let st = lo; st <= hi + 1e-6; st += step) {
    // a igualdad (agua plana de orilla a orilla), el más centrado
    const v = at(st + W) - at(st) - 1e-6 * W * Math.abs(st - mid)
    if (v > bestV) {
      bestV = v
      best = st
    }
  }
  return [best, best + W]
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * Edificios altos plantados sobre el puente entre a y b, agrupados a lo largo: posición s y
 * altura sobre el suelo de cada grupo. Son las torres del puente si OSM las tiene como edificio.
 */
function towerClusters(c: Chain, net: BridgeNet, a: number, b: number, half: number): Array<{ s: number; top: number }> {
  let gx0 = Infinity
  let gy0 = Infinity
  let gx1 = -Infinity
  let gy1 = -Infinity
  for (let i = 0; i < c.n; i++) {
    if (c.s[i] < a - 10 || c.s[i] > b + 10) continue
    const [gx, gy] = geoToUnit(c.lat[i], c.lon[i])
    gx0 = Math.min(gx0, gx)
    gx1 = Math.max(gx1, gx)
    gy0 = Math.min(gy0, gy)
    gy1 = Math.max(gy1, gy)
  }
  if (gx0 === Infinity) return []
  const pad = (half + 20) / metresPerUnit((gy0 + gy1) / 2)
  const hits: Array<{ s: number; h: number }> = []
  for (const t of net.tallIn(gx0 - pad, gy0 - pad, gx1 + pad, gy1 + pad)) {
    const [la, lo] = unitToGeo(t.gx, t.gy)
    const pr = projectOnChain(c, la, lo)
    if (pr.d <= half + 8 && pr.s > a + 1 && pr.s < b - 1) hits.push({ s: pr.s, h: t.h })
  }
  hits.sort((p, q) => p.s - q.s)
  const out: Array<{ s: number; top: number }> = []
  for (let i = 0; i < hits.length; ) {
    let j = i
    let top = 0
    while (j < hits.length && (j === i || hits[j].s - hits[j - 1].s < 45)) top = Math.max(top, hits[j++].h)
    // centro del grupo: el de sus partes más altas
    let sum = 0
    let cnt = 0
    for (let k = i; k < j; k++) {
      if (hits[k].h >= 0.6 * top) {
        sum += hits[k].s
        cnt++
      }
    }
    out.push({ s: sum / cnt, top })
    i = j
  }
  return out
}

const raised = new WeakSet<Chain>()

/**
 * Ajusta la rasante de una cadena a la estructura, una sola vez: la dueña sube lo que pida el
 * vano principal; las que van pegadas a ella (la otra calzada, un carril central, las aceras)
 * toman su misma rasante, porque son un mismo tablero y cada una por su cuenta saldría a una
 * altura algo distinta.
 */
function raiseDeck(c: Chain, plan: StructurePlan): void {
  if (raised.has(c)) return
  raised.add(c)
  const owner = plan.owner
  const near = Math.max(plan.extL, plan.extR) + 6
  let max = 0
  for (let i = 0; i < c.n; i++) {
    if (c === owner) c.deck[i] += plan.raise(c.s[i])
    else {
      const pr = projectOnChain(owner, c.lat[i], c.lon[i])
      if (pr.d <= near && pr.s > plan.a && pr.s < plan.b) {
        // (junto a su propio estribo, la suya: allí manda su terreno)
        const t = Math.min(1, c.dTerm[i] / 40)
        c.deck[i] += (profileAt(owner, owner.deck, pr.s) - c.deck[i]) * t * t * (3 - 2 * t)
      }
    }
    max = Math.max(max, c.deck[i] - c.ground[i])
  }
  c.maxClear = max
}

function makePlan(owner: Chain, rec: BridgeRecord, sRec: number, net: BridgeNet): StructurePlan | null {
  const len = owner.len
  const clearAt = (s: number) => profileAt(owner, owner.deck, s) - profileAt(owner, owner.ground, s)
  // el puente propiamente dicho dentro de la cadena (que puede incluir viaductos de acceso)
  let a = 0
  let b = len
  if (rec.length > 0 && rec.length < 0.85 * len) [a, b] = bestWindow(owner, rec.length, sRec - rec.length, sRec)
  const ext = b - a
  if (ext < 12) return null

  let shape: Shape
  let span = rec.span > 0 ? Math.min(rec.span, ext) : 0
  /** luz libre máxima del puente (para estimar cuánto sube la estructura sobre el tablero) */
  let high = 0
  for (let s = a; s <= b; s += Math.max(2, ext / 60)) high = Math.max(high, clearAt(s))
  switch (rec.type) {
    case BRIDGE_SUSPENSION:
      shape = 'suspension'
      // sin vano: de la altura de las torres si se sabe (≈ vano / 9 sobre el tablero)
      if (!span) span = ext < 70 ? ext * 0.9 : rec.height > 0 ? clamp((rec.height - high) * 9, 0.3 * ext, 0.6 * ext) : Math.min(ext * 0.56, 1100)
      break
    case BRIDGE_CABLE_STAYED:
    case BRIDGE_EXTRADOSED:
      shape = 'stayed'
      // (un puente largo suele ser un vano atirantado con viaductos de acceso)
      if (!span) span = rec.height > 0 ? clamp((rec.height - high) / 0.21, 0.22 * ext, 0.6 * ext) : clamp(ext * 0.5, Math.min(ext, 40), 330)
      break
    case BRIDGE_TRUSS:
    case BRIDGE_CANTILEVER:
      shape = 'truss'
      if (!span) span = rec.type === BRIDGE_CANTILEVER ? ext * 0.5 : Math.min(ext, 90)
      break
    case BRIDGE_ARCH_THROUGH:
      shape = 'archThrough'
      if (!span) span = Math.min(ext, 260) * 0.95
      break
    case BRIDGE_ARCH_DECK:
      shape = span || ext <= 220 ? 'archDeck' : 'arcade'
      if (!span) span = ext * 0.92
      break
    case BRIDGE_ARCH:
      // un gran arco suele tener su vano en Wikidata; sin él, lo normal es un puente de varios arcos
      shape = span >= 40 ? 'archDeck' : 'arcade'
      break
    default:
      shape = 'arcade'
  }
  if (shape !== 'arcade' && span < 10) return null
  // el vano principal va sobre lo más hondo; y si el punto del registro cae en mitad del puente
  // (en Wikidata suele ser el centro del vano), cerca de él
  const interior = sRec > a + 0.12 * ext && sRec < b - 0.12 * ext
  let [m0, m1] =
    shape === 'arcade'
      ? [a, b]
      : interior
        ? bestWindow(owner, span, Math.max(a, sRec - 0.7 * span), Math.min(b - span, sRec - 0.3 * span))
        : bestWindow(owner, span, a, b - span)
  let centre = (m0 + m1) / 2
  // un arco bajo el tablero necesita altura; si no la hay, va por encima
  if (shape === 'archDeck' && clearAt(centre) - 1.5 < span / 7) shape = rec.type === BRIDGE_ARCH_DECK && span < 40 ? 'arcade' : 'archThrough'
  if (shape === 'arcade') [m0, m1] = [a, b]

  // ancho del conjunto: los tableros que van pegados
  const mine = new Set(owner.parts.map((q) => q.piece))
  let extL = 0
  let extR = 0
  for (const f of [0.2, 0.5, 0.8]) {
    const [l, r] = lateralExtent(net, owner, stationAt(owner, m0 + (m1 - m0) * f), mine)
    extL = Math.max(extL, l)
    extR = Math.max(extR, r)
  }

  // Torres que OSM ya tiene modeladas como edificios (Golden Gate, Brooklyn, 25 de Abril…): las
  // dibuja Buildings.ts con su forma de verdad; aquí el vano se ajusta a ellas y solo se ponen
  // los cables.
  let osmTowers = false
  let osmTop = 0
  if (shape === 'suspension' || shape === 'stayed') {
    const found = towerClusters(owner, net, a, b, Math.max(extL, extR)).filter((t) => t.top - clearAt(t.s) >= Math.max(10, 0.03 * span))
    let best: [number, number] | null = null
    let bestScore = 0.45
    for (let i = 0; i < found.length; i++) {
      for (let j = i + 1; j < found.length; j++) {
        const sep = found[j].s - found[i].s
        // separadas más o menos un vano y centradas más o menos donde se esperaba
        const score = Math.abs(sep - span) / span + (0.5 * Math.abs((found[i].s + found[j].s) / 2 - centre)) / span
        if (score < bestScore) {
          bestScore = score
          best = [i, j]
        }
      }
    }
    if (best) {
      const [t0, t1] = [found[best[0]], found[best[1]]]
      m0 = t0.s
      m1 = t1.s
      span = m1 - m0
      centre = (m0 + m1) / 2
      osmTowers = true
      osmTop = (t0.top - clearAt(t0.s) + t1.top - clearAt(t1.s)) / 2
    }
  }

  // grandes vanos sobre el agua: la rasante sube para dejar paso a los barcos aunque el puente
  // arranque a ras de costa (y el tablero deducido de los estribos se quede bajo)
  let lift = 0
  let ramp0 = 1
  let ramp1 = 1
  if ((shape === 'suspension' || shape === 'stayed') && span >= 250) {
    const want = Math.min(62, 0.11 * span)
    const have = clearAt(centre)
    if (have < want - 3) {
      lift = want - have
      // rampas del 3,5 %, o lo que quepa hasta el estribo
      ramp0 = Math.max(20, Math.min(lift / 0.035, m0))
      ramp1 = Math.max(20, Math.min(lift / 0.035, len - m1))
    }
  }
  const raise = (so: number): number => {
    if (lift === 0) return 0
    const t = so < m0 ? 1 - (m0 - so) / ramp0 : so > m1 ? 1 - (so - m1) / ramp1 : 1
    return t <= 0 ? 0 : lift * t * t * (3 - 2 * t)
  }

  const defaults: Record<Shape, number> = { suspension: STEEL, stayed: PYLON, arcade: STONE, archDeck: ARCH_CONCRETE, archThrough: ARCH_STEEL, truss: TRUSS_STEEL }
  const plan: StructurePlan = {
    owner,
    rec,
    shape,
    centre,
    a,
    b,
    m0,
    m1,
    span,
    extL,
    extR,
    colour: new Color(rec.colour || defaults[shape]),
    clear: [m0, m1],
    girder: owner.depth,
    towers: [],
    towerH: 0,
    ownTowers: true,
    back0: 0,
    back1: 0,
    bays: [],
    bayLen: 0,
    pierHalf: 0,
    rise: 0,
    trussH: 0,
    cantilever: rec.type === BRIDGE_CANTILEVER,
    piers: [],
    raise,
    depth: () => owner.depth,
    pierAllowed: () => true,
    subdiv: () => 1,
    solid: () => false,
  }
  raiseDeck(owner, plan)
  /** posición en la dueña del punto s de la cadena c */
  const toOwner = (c: Chain, s: number): number => {
    if (c === owner) return s
    const i = stationAt(c, s)
    return projectOnChain(owner, c.lat[i], c.lon[i]).s
  }
  /** altura de la estructura sobre la calzada si Wikidata la da (sobre el agua o el suelo) y es creíble */
  const heightAbove = (s: number, min: number, fallback: number): number => {
    const h = rec.height - clearAt(s)
    return rec.height > 0 && h >= min ? Math.min(h, fallback * 2.5) : fallback
  }

  if (shape === 'suspension') {
    plan.towers = [m0, m1]
    plan.ownTowers = !osmTowers
    // (si las torres son de OSM, su altura menos lo que sube la rasante)
    plan.towerH = osmTowers ? Math.max(6, osmTop - raise(m0)) : heightAbove(m0, span / 14, clamp(span / 9, 7, 230))
    // vanos laterales: hasta la mitad del principal, o lo que quede de puente
    plan.back0 = Math.max(Math.min(0.5 * span, m0 - a), Math.min(m0, 0.18 * span))
    plan.back1 = Math.max(Math.min(0.5 * span, b - m1), Math.min(len - m1, 0.18 * span))
    plan.clear = [m0 - plan.back0, m1 + plan.back1]
    plan.girder = clamp(span / 150, 1.4, 8)
  } else if (shape === 'stayed') {
    const low = rec.type === BRIDGE_EXTRADOSED
    if (rec.towers >= 3 && ext >= (rec.towers - 0.5) * span) {
      // varios vanos iguales (como el viaducto de Millau)
      const count = rec.towers
      const first = (a + b) / 2 - ((count - 1) / 2) * span
      for (let k = 0; k < count; k++) plan.towers.push(first + k * span)
      plan.towerH = heightAbove(plan.towers[0], span / 8, span * (low ? 0.1 : 0.25))
      plan.back0 = plan.back1 = span * 0.47
    } else if (osmTowers || span <= 0.64 * ext) {
      plan.towers = [m0, m1]
      plan.ownTowers = !osmTowers
      plan.towerH = osmTowers ? Math.max(6, osmTop - raise(m0)) : heightAbove(m0, span / 9, clamp(span * (low ? 0.1 : 0.21), 6, 240))
      plan.back0 = Math.min(0.46 * span, m0 - a)
      plan.back1 = Math.min(0.46 * span, b - m1)
    } else {
      // un solo pilono, en el extremo del vano que da a tierra
      const atStart = clearAt(m0) <= clearAt(m1)
      plan.towers = [atStart ? m0 : m1]
      plan.towerH = heightAbove(plan.towers[0], span / 6, clamp(span * (low ? 0.14 : 0.36), 7, 220))
      const land = Math.min(0.45 * span, atStart ? m0 : len - m1)
      plan.back0 = atStart ? land : span * 0.94
      plan.back1 = atStart ? span * 0.94 : land
    }
    plan.clear = [plan.towers[0] - plan.back0, plan.towers[plan.towers.length - 1] + plan.back1]
    plan.girder = clamp(span / 110, 1.4, 4.5)
  } else if (shape === 'arcade') {
    // luz libre típica → tamaño de los arcos
    const cl: number[] = []
    for (let s = a; s <= b; s += Math.max(2, ext / 40)) cl.push(clearAt(s))
    cl.sort((x, y) => x - y)
    const typical = cl[Math.floor(cl.length * 0.6)]
    // arcos de medio punto: la luz es el doble de la flecha (los viaductos altos, más esbeltos)
    const want = rec.span > 0 && rec.span < 60 ? rec.span * 1.12 : clamp(2 * typical, 7, 26)
    const count = Math.max(1, Math.round(ext / want))
    plan.bayLen = ext / count
    plan.pierHalf = clamp(0.1 * plan.bayLen, 0.7, 2.4)
    const open = plan.bayLen - 2 * plan.pierHalf
    for (let k = 0; k < count; k++) {
      let low = Infinity
      for (let j = 0; j <= 6; j++) low = Math.min(low, clearAt(a + (k + j / 6) * plan.bayLen))
      const crown = Math.max(0.7, open / 14)
      const rise = Math.min(open / 2, low - crown - 0.4)
      plan.bays.push({ ok: rise >= 1.4, rise, crown })
      if (k > 0 && (rise >= 1.4 || plan.bays[k - 1].ok)) plan.piers.push(a + k * plan.bayLen)
    }
    if (!plan.bays.some((q) => q.ok)) return null
    plan.clear = [a, b]
  } else if (shape === 'archDeck') {
    plan.rise = Math.min(span / 3.2, Math.max(span / 9, clearAt(centre) * 0.85 - owner.depth))
    plan.girder = Math.max(owner.depth * 0.7, 1)
  } else if (shape === 'archThrough') {
    plan.rise = heightAbove(centre, span / 9, clamp(span / 5.5, 5, 95))
    plan.piers = [m0, m1]
  } else {
    // celosía: sobre todo el puente si se conoce su longitud; si no, sobre el vano y sus vecinos
    if (!(rec.length > 0)) {
      a = Math.max(0, m0 - span * 0.6)
      b = Math.min(len, m1 + span * 0.6)
      plan.a = a
      plan.b = b
    }
    plan.trussH = plan.cantilever ? clamp(span / 34, 5, 16) : clamp(span / 7.5, 5, 13)
    if (rec.span > 0 || plan.cantilever) {
      plan.piers = [m0, m1]
      for (let s = m0 - span * 0.8; s > a + span * 0.35; s -= span * 0.8) plan.piers.push(s)
      for (let s = m1 + span * 0.8; s < b - span * 0.35; s += span * 0.8) plan.piers.push(s)
      plan.clear = [a, b]
    } else plan.clear = [0, -1]
  }

  plan.depth = (c, s) => {
    const so = toOwner(c, s)
    if (shape === 'arcade') {
      if (c !== owner || so <= a || so >= b) return c.depth
      const k = Math.min(plan.bays.length - 1, Math.floor((so - a) / plan.bayLen))
      const bay = plan.bays[k]
      if (!bay.ok) return c.depth
      const x = so - (a + (k + 0.5) * plan.bayLen)
      const half = plan.bayLen / 2 - plan.pierHalf
      if (Math.abs(x) >= half) return bay.crown + bay.rise
      return bay.crown + bay.rise * (1 - Math.sqrt(1 - (x / half) ** 2))
    }
    if ((shape === 'suspension' || shape === 'stayed') && so >= plan.clear[0] && so <= plan.clear[1]) return c.companion ? c.depth : plan.girder
    return c.depth
  }
  plan.pierAllowed = (c, s) => {
    const so = toOwner(c, s)
    return so < plan.clear[0] + 1 || so > plan.clear[1] - 1
  }
  plan.subdiv = (c, s0, s1) => {
    if (shape !== 'arcade' || c !== owner || s1 <= a || s0 >= b) return 1
    return Math.max(1, Math.ceil((s1 - s0) / Math.max(0.45, (plan.bayLen - 2 * plan.pierHalf) / 16)))
  }
  plan.solid = (c, s) => {
    if (shape !== 'arcade' || c !== owner || s <= a || s >= b) return false
    return plan.bays[Math.min(plan.bays.length - 1, Math.floor((s - a) / plan.bayLen))].ok
  }
  return plan
}

// ---------------------------------------------------------------------------
// Geometría
// ---------------------------------------------------------------------------

/** Dibuja la estructura (todo lo que no es el tablero) y añade sus formas de choque. */
export function buildStructure(mb: MeshBuilder, prims: Prim[], fr: ChainFrame, plan: StructurePlan): void {
  const c = plan.owner
  const col = plan.colour
  const P = (s: number, off: number, dy: number) => fr.atS(s, off, dy, new Vector3())
  /** altura del suelo respecto de la calzada en s (negativa) */
  const groundDy = (s: number) => -(profileAt(c, c.deck, s) - profileAt(c, c.ground, s))
  const left = -plan.extL
  const right = plan.extR
  /** barra con su forma de choque */
  const bar = (p: Vector3, q: Vector3, w: number, h: number, colour: Color, solid = true) => {
    mb.beam(p, q, w, h, colour)
    if (solid) prims.push({ k: 2, ax: p.x, ay: p.y, az: p.z, bx: q.x, by: q.y, bz: q.z, r: Math.max(w, h) / 2 + 0.25 })
  }
  /** pila o pata vertical: caja orientada con el puente, de dy0 a dy1 sobre la calzada */
  const post = (s: number, off: number, ha: number, hb: number, dy0: number, dy1: number, colour: Color, top = true) => {
    const p = P(s, off, 0)
    const [ux, uz] = fr.dirAt(s)
    mb.box(p.x, p.z, ux, uz, ha, hb, p.y + dy0, p.y + dy1, colour, top)
    prims.push({ k: 1, cx: p.x, cz: p.z, ux, uz, ha, hb, y0: p.y + dy0, y1: p.y + dy1 })
  }
  /** paño vertical de choque entre dos puntos de la cadena (péndolas, tirantes, celosías) */
  const curtain = (s0: number, s1: number, off: number, t0: number, t1: number) => {
    const p = P(s0, off, 0)
    const q = P(s1, off, 0)
    prims.push({ k: 3, x0: p.x, z0: p.z, x1: q.x, z1: q.z, b0: p.y, b1: q.y, t0: p.y + t0, t1: q.y + t1, hw: 0.45 })
  }
  const dark = col.clone().multiplyScalar(0.55)

  if (plan.shape === 'suspension') {
    const S = plan.span
    const H = plan.towerH
    const [t0, t1] = plan.towers
    const lo = left - 1.3
    const ro = right + 1.3
    const ha = clamp(Math.max(S / 260, H / 50), 0.8, 4.5)
    const hb = clamp(Math.max(S / 330, H / 65), 0.7, 3.4)
    for (const s of plan.ownTowers ? plan.towers : []) {
      const base = groundDy(s) - 3
      post(s, lo, ha, hb, base, H, col)
      post(s, ro, ha, hb, base, H, col)
      // riostras: bajo el tablero, a media altura y en lo alto
      for (const dy of [-plan.girder - hb, H * 0.5, H - hb * 1.5]) bar(P(s, lo, dy), P(s, ro, dy), ha * 1.6, hb * 1.8, col)
    }
    const sag = Math.max(1.6, 0.012 * S)
    const cableY = (s: number): number => {
      if (s >= t0 && s <= t1) return sag + (H - sag) * ((s - (t0 + t1) / 2) / (S / 2)) ** 2
      // vanos laterales: de lo alto de la torre al anclaje, a la altura del tablero
      const back = s < t0 ? plan.back0 : plan.back1
      const t = clamp(1 - (s < t0 ? t0 - s : s - t1) / Math.max(1, back), 0, 1)
      return 0.6 + (H - 0.6) * t ** 1.5
    }
    const d = clamp(S / 900, 0.3, 1.1)
    const from = t0 - plan.back0
    const to = t1 + plan.back1
    const step = clamp(S / 44, 4, 30)
    const count = Math.max(4, Math.round((to - from) / step))
    const hang = Math.max(1, Math.round(clamp(S / 70, 8, 22) / ((to - from) / count)))
    for (const off of [lo, ro]) {
      const edge = off < 0 ? left + 0.2 : right - 0.2
      for (let k = 0; k < count; k++) {
        const s0 = from + ((to - from) * k) / count
        const s1 = from + ((to - from) * (k + 1)) / count
        bar(P(s0, off, cableY(s0)), P(s1, off, cableY(s1)), d, d, dark)
        curtain(s0, s1, off, cableY(s0), cableY(s1))
        // péndolas
        if (k % hang === 0 && cableY(s0) > 2.5 && Math.abs(s0 - t0) > 2 && Math.abs(s0 - t1) > 2) mb.beam(P(s0, off, cableY(s0)), P(s0, edge, 0.4), 0.14, 0.14, dark)
      }
    }
  } else if (plan.shape === 'stayed') {
    const S = plan.span
    const H = plan.towerH
    const lo = left - 1.2
    const ro = right + 1.2
    // patas proporcionadas al vano y a su propia altura (un pilono de 130 m no es una aguja)
    const ha = clamp(Math.max(S / 150, H / 45), 0.8, 5)
    const hb = clamp(Math.max(S / 220, H / 60), 0.7, 3.5)
    const stay = new Color(STAY)
    const n = plan.towers.length
    plan.towers.forEach((s, k) => {
      if (plan.ownTowers) {
        const base = groundDy(s) - 3
        post(s, lo, ha, hb, base, H, col)
        post(s, ro, ha, hb, base, H, col)
        bar(P(s, lo, -plan.girder - hb), P(s, ro, -plan.girder - hb), ha * 1.6, hb * 1.8, col)
        if (H > 12) bar(P(s, lo, H * 0.82), P(s, ro, H * 0.82), ha * 1.2, hb * 1.4, col)
      }
      // tirantes a los dos lados, en los dos planos
      const reach = [k === 0 ? plan.back0 : (s - plan.towers[k - 1]) * 0.48, k === n - 1 ? plan.back1 : (plan.towers[k + 1] - s) * 0.48]
      for (const dir of [-1, 1]) {
        const r = reach[dir < 0 ? 0 : 1]
        if (r < 8) continue
        const stays = clamp(Math.round(r / 11), 3, 16)
        for (const off of [lo, ro]) {
          const edge = off < 0 ? left + 0.15 : right - 0.15
          for (let j = 1; j <= stays; j++) {
            const f = j / stays
            mb.beam(P(s, off, H * (0.55 + 0.42 * f)), P(s + dir * r * (0.1 + 0.9 * f), edge, 0.5), 0.2, 0.2, stay)
          }
          curtain(s, s + dir * r, off, H, 0.8)
        }
      }
    })
  } else if (plan.shape === 'arcade') {
    // pilas de fábrica del ancho del puente, hasta el arranque de los arcos
    const hb = (plan.extL + plan.extR) / 2 + 0.3
    const mid = (right + left) / 2
    for (const s of plan.piers) {
      const k = Math.min(plan.bays.length - 1, Math.floor((s - plan.a) / plan.bayLen))
      const bay = plan.bays[k].ok ? plan.bays[k] : plan.bays[Math.max(0, k - 1)]
      const spring = bay.ok ? -(bay.crown + bay.rise) : -c.depth
      post(s, mid, plan.pierHalf, hb, groundDy(s) - 2.5, spring + 0.05, col, false)
      // tajamar: un zócalo algo más ancho al pie
      const foot = groundDy(s)
      if (spring - foot > 5) post(s, mid, plan.pierHalf + 0.5, hb + 0.6, foot - 2.5, foot + Math.min(2.5, (spring - foot) * 0.25), col, true)
    }
  } else if (plan.shape === 'archDeck') {
    const S = plan.span
    const f = plan.rise
    const top = -plan.girder - 0.3
    const y = (s: number) => top - f * ((s - plan.centre) / (S / 2)) ** 2
    const w = clamp(S / 45, 0.7, 3.5)
    const h = clamp(S / 40, 0.8, 4)
    const width = right - left
    const ribs = width > 8 ? [left + width * 0.2, right - width * 0.2] : [(left + right) / 2]
    const segs = 28
    const cols = Math.max(4, Math.round(S / clamp(S / 11, 8, 22)))
    for (const off of ribs) {
      for (let k = 0; k < segs; k++) {
        const s0 = plan.m0 + (S * k) / segs
        const s1 = plan.m0 + (S * (k + 1)) / segs
        bar(P(s0, off, y(s0) - h / 2), P(s1, off, y(s1) - h / 2), w, h, col)
      }
      // montantes del arco al tablero
      for (let k = 1; k < cols; k++) {
        const s = plan.m0 + (S * k) / cols
        if (top - y(s) < 1.2) continue
        const m = clamp(w * 0.55, 0.4, 1.4)
        post(s, off, m / 2, m / 2, y(s), top + 0.2, col, false)
      }
    }
    // arranques
    for (const s of [plan.m0, plan.m1]) post(s, (left + right) / 2, w, width / 2 + 0.2, Math.min(groundDy(s), top - f) - 3, top - f + h * 0.6, col)
  } else if (plan.shape === 'archThrough') {
    const S = plan.span
    const f = plan.rise
    const y = (s: number) => f * (1 - ((s - plan.centre) / (S / 2)) ** 2)
    const w = clamp(S / 55, 0.6, 3)
    const h = clamp(S / 45, 0.7, 3.6)
    const lo = left - w / 2 - 0.3
    const ro = right + w / 2 + 0.3
    const segs = 28
    const hangers = Math.max(1, Math.round(clamp(S / 16, 4, 14) / (S / segs)))
    for (const off of [lo, ro]) {
      for (let k = 0; k < segs; k++) {
        const s0 = plan.m0 + (S * k) / segs
        const s1 = plan.m0 + (S * (k + 1)) / segs
        bar(P(s0, off, y(s0)), P(s1, off, y(s1)), w, h, col)
        curtain(s0, s1, off, Math.max(0.5, y(s0)), Math.max(0.5, y(s1)))
        if (k > 0 && k % hangers === 0 && y(s0) > 2) mb.beam(P(s0, off, y(s0)), P(s0, off, 0.3), 0.16, 0.16, dark)
      }
    }
    // arriostramiento entre los dos arcos, donde ya pasa el tráfico por debajo
    for (let k = 2; k < segs - 1; k += 3) {
      const s = plan.m0 + (S * k) / segs
      if (y(s) > 6.5) bar(P(s, lo, y(s)), P(s, ro, y(s)), w * 0.6, h * 0.6, col)
    }
    for (const s of plan.piers) post(s, (left + right) / 2, 1.2 + S / 200, (right - left) / 2 + 1, groundDy(s) - 3, -c.depth, new Color(PYLON), false)
  } else {
    // celosía: dos vigas a los lados, montantes y diagonales, y arriostramiento por arriba
    const S = plan.span
    const base = plan.trussH
    const peak = plan.cantilever ? clamp(S / 8.5, base * 1.5, 70) : base
    const height = (s: number): number => {
      if (!plan.cantilever) return base
      const k = Math.max(0, 1 - Math.abs(s - plan.m0) / (0.42 * S), 1 - Math.abs(s - plan.m1) / (0.42 * S))
      return base + (peak - base) * k * k * (3 - 2 * k)
    }
    const lo = left - 0.5
    const ro = right + 0.5
    const panel = plan.cantilever ? clamp(S / 18, 6, 24) : clamp(base, 5, 11)
    const count = Math.max(2, Math.round((plan.b - plan.a) / panel))
    const m = clamp(base / 26, 0.22, 0.9)
    for (let k = 0; k <= count; k++) {
      const s = plan.a + ((plan.b - plan.a) * k) / count
      const hs = height(s)
      for (const off of [lo, ro]) bar(P(s, off, 0.2), P(s, off, hs), m, m, col, false)
      // riostra superior (por encima del gálibo)
      if (hs > 5.5) bar(P(s, lo, hs), P(s, ro, hs), m, m, col, false)
      if (k === count) break
      const s1 = plan.a + ((plan.b - plan.a) * (k + 1)) / count
      const h1 = height(s1)
      for (const off of [lo, ro]) {
        bar(P(s, off, hs), P(s1, off, h1), m * 1.3, m * 1.3, col, false)
        // diagonales alternas (Warren)
        if (k % 2 === 0) bar(P(s, off, 0.2), P(s1, off, h1), m, m, col, false)
        else bar(P(s, off, hs), P(s1, off, 0.2), m, m, col, false)
        curtain(s, s1, off, hs, h1)
      }
      // techo de choque: no se puede atravesar la celosía por arriba
      const p = P(s, (lo + ro) / 2, hs)
      const q = P(s1, (lo + ro) / 2, h1)
      prims.push({ k: 0, x0: p.x, z0: p.z, x1: q.x, z1: q.z, y0: p.y, y1: q.y, b0: p.y - 0.8, b1: q.y - 0.8, hw: (ro - lo) / 2, rail: 0 })
    }
    for (const s of plan.piers) post(s, (left + right) / 2, 1.3 + S / 180, (right - left) / 2 + 0.8, groundDy(s) - 3, -c.depth, new Color(PYLON), false)
  }
}
