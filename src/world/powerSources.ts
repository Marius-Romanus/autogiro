// De dónde salen los tendidos: en España, public/power-es.bin (tools/power-lines.ts, sacado del
// volcado de OpenStreetMap, con cada vía y sus apoyos en orden); en el resto del mundo, las
// teselas vectoriales de OpenInfraMap (los mismos datos de OSM, al día, pero con el trazado
// simplificado y las torres como puntos sueltos: aquí se vuelven a enhebrar). Las dos dan
// PowerWay (powerFormat.ts).

import { VectorTile } from '@mapbox/vector-tile'
import { PbfReader } from 'pbf'
import { unzlibSync } from 'fflate'
import { hasIgnTerrain } from './HeightSource.ts'
import { KIND, NODE, parsePowerWays, type PowerWay } from './powerFormat.ts'
import { latToY, lonToX, xToLon, yToLat } from './mapTiles.ts'

export interface Bbox {
  south: number
  west: number
  north: number
  east: number
}

/** ¿Este punto se sirve con el fichero de España? */
export function spainCovers(lat: number, lon: number): boolean {
  return hasIgnTerrain(lat, lon)
}

// ---------------------------------------------------------------------------
// España

interface SpainIndex {
  ways: PowerWay[]
  /** celdas de 0,1° → vías que las tocan */
  grid: Map<number, number[]>
}

let spain: Promise<SpainIndex | null> | null = null
const CELL = 0.1

function cellKey(i: number, j: number): number {
  return (i + 2000) * 4000 + (j + 2000)
}

export function loadSpain(): Promise<SpainIndex | null> {
  spain ??= (async () => {
    try {
      const r = await fetch(`${import.meta.env.BASE_URL}power-es.bin`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const ways = parsePowerWays(unzlibSync(new Uint8Array(await r.arrayBuffer())))
      return indexWays(ways)
    } catch (e) {
      console.warn('Tendidos: no se pudo cargar power-es.bin', e)
      return null
    }
  })()
  return spain
}

/** Para las herramientas de Node. */
export function setSpainData(raw: Uint8Array): void {
  spain = Promise.resolve(indexWays(parsePowerWays(unzlibSync(raw))))
}

function indexWays(ways: PowerWay[]): SpainIndex {
  const grid = new Map<number, number[]>()
  ways.forEach((w, k) => {
    for (let i = Math.floor(w.minLat / CELL); i <= Math.floor(w.maxLat / CELL); i++) {
      for (let j = Math.floor(w.minLon / CELL); j <= Math.floor(w.maxLon / CELL); j++) {
        const key = cellKey(i, j)
        const l = grid.get(key)
        if (l) l.push(k)
        else grid.set(key, [k])
      }
    }
  })
  return { ways, grid }
}

async function spainWays(b: Bbox): Promise<PowerWay[]> {
  const idx = await loadSpain()
  if (!idx) return []
  const seen = new Set<number>()
  const out: PowerWay[] = []
  for (let i = Math.floor(b.south / CELL); i <= Math.floor(b.north / CELL); i++) {
    for (let j = Math.floor(b.west / CELL); j <= Math.floor(b.east / CELL); j++) {
      for (const k of idx.grid.get(cellKey(i, j)) ?? []) {
        if (seen.has(k)) continue
        seen.add(k)
        const w = idx.ways[k]
        if (w.maxLat < b.south || w.minLat > b.north || w.maxLon < b.west || w.minLon > b.east) continue
        out.push(w)
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// OpenInfraMap

const OIM = 'https://openinframap.org/tiles/{z}/{x}/{y}.pbf'
const OZ = 14

interface RawLine {
  id: number
  kind: number
  kv: number
  circuits: number
  /** trozos (lat, lon alternados) y si cada extremo es un corte del borde de la tesela */
  pts: number[]
  cutStart: boolean
  cutEnd: boolean
}

interface RawTower {
  id: number
  lat: number
  lon: number
  type: number
}

interface RawTile {
  lines: RawLine[]
  towers: RawTower[]
}

const rawCache = new Map<string, Promise<RawTile | null>>()
const RAW_MAX = 400
/** fallos seguidos: si el servidor no responde, no se le insiste */
let failures = 0
let blockedUntil = 0

function rawTile(x: number, y: number, signal: AbortSignal): Promise<RawTile | null> {
  const key = `${x}/${y}`
  let p = rawCache.get(key)
  if (p) {
    // (al final de la lista: la más reciente)
    rawCache.delete(key)
    rawCache.set(key, p)
    return p
  }
  p = fetchRaw(x, y, signal)
  rawCache.set(key, p)
  p.then((r) => {
    if (r === null) rawCache.delete(key)
  })
  while (rawCache.size > RAW_MAX) rawCache.delete(rawCache.keys().next().value!)
  return p
}

async function fetchRaw(x: number, y: number, signal: AbortSignal): Promise<RawTile | null> {
  if (performance.now() < blockedUntil) return null
  let buf: ArrayBuffer
  try {
    // (sin la señal de la tesela que la pide: la comparten las vecinas)
    void signal
    const r = await fetch(OIM.replace('{z}', String(OZ)).replace('{x}', String(x)).replace('{y}', String(y)))
    if (r.status === 404 || r.status === 204) return { lines: [], towers: [] }
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    buf = await r.arrayBuffer()
    failures = 0
  } catch (e) {
    if (++failures >= 6) {
      blockedUntil = performance.now() + 60000
      failures = 0
      console.warn('Tendidos: OpenInfraMap no responde; se reintenta en un minuto', e)
    }
    return null
  }
  return decodeRaw(new Uint8Array(buf), x, y)
}

function decodeRaw(bytes: Uint8Array, x: number, y: number): RawTile {
  const out: RawTile = { lines: [], towers: [] }
  if (bytes.length === 0) return out
  const vt = new VectorTile(new PbfReader(bytes))
  const n = 2 ** OZ
  const toGeo = (px: number, py: number, ext: number): [number, number] => [yToLat(y + py / ext, n), xToLon(x + px / ext, n)]
  const addLines = (name: string, telecom: boolean) => {
    const L = vt.layers[name]
    if (!L) return
    for (let i = 0; i < L.length; i++) {
      const f = L.feature(i)
      const p = f.properties as Record<string, string | number | boolean>
      if (p.construction === true || p.disused === true || p.tunnel === true) continue
      const loc = String(p.location ?? '')
      if (/underground|underwater|indoor/.test(loc)) continue
      let kind: number = KIND.telecom
      if (!telecom) {
        const type = String(p.type ?? '')
        if (type === 'line') kind = KIND.line
        else if (type === 'minor_line') kind = KIND.minor
        else if (type === 'cable' && loc === 'overhead') kind = KIND.cable
        else continue
        if (p.line === 'busbar' || p.line === 'bay') continue
      }
      const ext = L.extent
      let kv = 0
      for (const k of ['voltage', 'voltage_2', 'voltage_3']) {
        const v = Number(p[k] ?? 0)
        if (Number.isFinite(v) && v > kv) kv = v
      }
      const circuits = Math.max(0, Math.min(8, Math.round(Number(p.circuits ?? 0)) || 0))
      for (const part of f.loadGeometry()) {
        if (part.length < 2) continue
        const pts: number[] = []
        for (const q of part) pts.push(...toGeo(q.x, q.y, ext))
        const cut = (q: { x: number; y: number }) => q.x <= 0 || q.y <= 0 || q.x >= ext || q.y >= ext
        out.lines.push({ id: Number(p.osm_id ?? f.id ?? 0), kind, kv, circuits, pts, cutStart: cut(part[0]), cutEnd: cut(part[part.length - 1]) })
      }
    }
  }
  addLines('power_line', false)
  addLines('telecoms_communication_line', true)
  const T = vt.layers.power_tower
  if (T) {
    for (let i = 0; i < T.length; i++) {
      const f = T.feature(i)
      const p = f.properties as Record<string, string | number | boolean>
      if (p.construction === true || p.disused === true) continue
      const q = f.loadGeometry()[0]?.[0]
      if (!q) continue
      const [lat, lon] = toGeo(q.x, q.y, T.extent)
      out.towers.push({ id: Number(p.osm_id ?? f.id ?? 0), lat, lon, type: p.type === 'pole' ? NODE.pole : NODE.tower })
    }
  }
  return out
}

/**
 * Vías de OpenInfraMap en la caja: junta los trozos de cada línea de las teselas que la cubren,
 * le engancha las torres que caen sobre ella (a menos de 4 m) en orden y une los trozos de una
 * tesela a otra (por torres compartidas o siguiendo la dirección del corte).
 */
async function oimWays(b: Bbox, signal: AbortSignal): Promise<PowerWay[] | null> {
  const n = 2 ** OZ
  const x0 = Math.floor(lonToX(b.west, n))
  const x1 = Math.floor(lonToX(b.east, n))
  const y0 = Math.floor(latToY(b.north, n))
  const y1 = Math.floor(latToY(b.south, n))
  const jobs: Array<Promise<RawTile | null>> = []
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) jobs.push(rawTile(x, y, signal))
  const tiles = await Promise.all(jobs)
  if (signal.aborted) return null
  // sin alguna tesela, mejor reintentar luego que dibujar líneas a medias
  if (tiles.some((t) => t === null)) return null
  const lat0 = (b.south + b.north) / 2
  const ky = 110574
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180)
  const lon0 = (b.west + b.east) / 2
  const X = (lon: number) => (lon - lon0) * kx
  const Y = (lat: number) => (lat - lat0) * ky

  // torres sin repetir y su rejilla (celdas de 25 m)
  const towers = new Map<number, RawTower>()
  for (const t of tiles) for (const tw of t!.towers) if (!towers.has(tw.id)) towers.set(tw.id, tw)
  const G = 25
  const grid = new Map<string, RawTower[]>()
  for (const tw of towers.values()) {
    const k = `${Math.floor(X(tw.lon) / G)},${Math.floor(Y(tw.lat) / G)}`
    const l = grid.get(k)
    if (l) l.push(tw)
    else grid.set(k, [tw])
  }

  // trozos por línea
  const byId = new Map<number, RawLine[]>()
  for (const t of tiles) {
    for (const l of t!.lines) {
      const list = byId.get(l.id)
      if (list) list.push(l)
      else byId.set(l.id, [l])
    }
  }

  const out: PowerWay[] = []
  for (const [id, pieces] of byId) {
    const first = pieces[0]
    let kv = 0
    let circuits = 0
    for (const p of pieces) {
      kv = Math.max(kv, p.kv)
      circuits = Math.max(circuits, p.circuits)
    }
    // nodos del grafo: torres (id) o vértices sin torre (clave de posición, negativos)
    const node = new Map<string, { lat: number; lon: number; type: number }>()
    const adj = new Map<string, Set<string>>()
    const link = (a: string, c: string) => {
      if (a === c) return
      if (!adj.has(a)) adj.set(a, new Set())
      if (!adj.has(c)) adj.set(c, new Set())
      adj.get(a)!.add(c)
      adj.get(c)!.add(a)
    }
    const dangling: Array<{ key: string; dx: number; dy: number }> = []
    let anyTower = false
    for (const p of pieces) {
      const m = p.pts.length / 2
      // torres a menos de 4 m de algún tramo, con su posición a lo largo del trozo
      const hits = new Map<number, number>()
      let s = 0
      for (let i = 0; i + 1 < m; i++) {
        const ax = X(p.pts[2 * i + 1])
        const ay = Y(p.pts[2 * i])
        const bx = X(p.pts[2 * i + 3])
        const by = Y(p.pts[2 * i + 2])
        const dx = bx - ax
        const dy = by - ay
        const len = Math.hypot(dx, dy)
        const gx0 = Math.floor((Math.min(ax, bx) - 4) / G)
        const gx1 = Math.floor((Math.max(ax, bx) + 4) / G)
        const gy0 = Math.floor((Math.min(ay, by) - 4) / G)
        const gy1 = Math.floor((Math.max(ay, by) + 4) / G)
        for (let gy = gy0; gy <= gy1; gy++) {
          for (let gx = gx0; gx <= gx1; gx++) {
            for (const tw of grid.get(`${gx},${gy}`) ?? []) {
              const tx = X(tw.lon) - ax
              const ty = Y(tw.lat) - ay
              const f = len > 1e-6 ? Math.max(0, Math.min(1, (tx * dx + ty * dy) / (len * len))) : 0
              const d = Math.hypot(tx - f * dx, ty - f * dy)
              if (d > 4) continue
              const at = s + f * len
              const prev = hits.get(tw.id)
              if (prev === undefined || at < prev) hits.set(tw.id, at)
            }
          }
        }
        s += len
      }
      const seq: string[] = []
      if (hits.size > 0) {
        anyTower = true
        const sorted = [...hits].sort((a, c) => a[1] - c[1])
        for (const [tid] of sorted) {
          const tw = towers.get(tid)!
          const key = `t${tid}`
          node.set(key, { lat: tw.lat, lon: tw.lon, type: tw.type })
          seq.push(key)
        }
      } else {
        // línea sin torres mapeadas: sus vértices (los de dentro de la tesela, no los cortes)
        for (let i = 0; i < m; i++) {
          if ((i === 0 && p.cutStart) || (i === m - 1 && p.cutEnd)) continue
          const lat = p.pts[2 * i]
          const lon = p.pts[2 * i + 1]
          const key = `v${Math.round(lat * 1e6)},${Math.round(lon * 1e6)}`
          node.set(key, { lat, lon, type: NODE.vertex })
          seq.push(key)
        }
      }
      for (let i = 0; i + 1 < seq.length; i++) link(seq[i], seq[i + 1])
      if (seq.length === 0) continue
      // cortes del borde: el trozo sigue más allá del último apoyo
      if (p.cutStart) {
        const k = seq[0]
        const q = node.get(k)!
        dangling.push({ key: k, dx: X(p.pts[1]) - X(q.lon), dy: Y(p.pts[0]) - Y(q.lat) })
      }
      if (p.cutEnd) {
        const k = seq[seq.length - 1]
        const q = node.get(k)!
        dangling.push({ key: k, dx: X(p.pts[2 * m - 1]) - X(q.lon), dy: Y(p.pts[2 * m - 2]) - Y(q.lat) })
      }
    }
    // une cada corte con el apoyo más cercano de la misma línea en esa dirección
    for (const d of dangling) {
      const a = node.get(d.key)!
      if ((adj.get(d.key)?.size ?? 0) >= 2) continue
      const dl = Math.hypot(d.dx, d.dy)
      if (dl < 1e-6) continue
      let best: string | null = null
      let bestD = 2500
      for (const [k, q] of node) {
        if (k === d.key || adj.get(d.key)?.has(k)) continue
        if ((adj.get(k)?.size ?? 0) >= 2) continue
        const vx = X(q.lon) - X(a.lon)
        const vy = Y(q.lat) - Y(a.lat)
        const dist = Math.hypot(vx, vy)
        if (dist < 1 || dist >= bestD) continue
        if ((vx * d.dx + vy * d.dy) / (dist * dl) < 0.94) continue
        best = k
        bestD = dist
      }
      if (best) link(d.key, best)
    }
    // caminos del grafo
    const done = new Set<string>()
    const walk = (start: string) => {
      const path = [start]
      done.add(start)
      let cur = start
      for (;;) {
        let next: string | null = null
        for (const k of adj.get(cur) ?? []) if (!done.has(k)) next = next ?? k
        if (!next) break
        path.push(next)
        done.add(next)
        cur = next
      }
      return path
    }
    const paths: string[][] = []
    for (const k of node.keys()) if (!done.has(k) && (adj.get(k)?.size ?? 0) <= 1) paths.push(walk(k))
    for (const k of node.keys()) if (!done.has(k)) paths.push(walk(k))
    paths.forEach((path, pi) => {
      if (path.length < 2) return
      const m = path.length
      const lat = new Float64Array(m)
      const lon = new Float64Array(m)
      const flags = new Uint8Array(m)
      let minLat = Infinity
      let minLon = Infinity
      let maxLat = -Infinity
      let maxLon = -Infinity
      path.forEach((k, i) => {
        const q = node.get(k)!
        lat[i] = q.lat
        lon[i] = q.lon
        flags[i] = q.type
        minLat = Math.min(minLat, q.lat)
        maxLat = Math.max(maxLat, q.lat)
        minLon = Math.min(minLon, q.lon)
        maxLon = Math.max(maxLon, q.lon)
      })
      // (un camino tiene el sentido que salga; da igual para dibujarlo)
      out.push({
        id: `oim:${id}:${anyTower ? 't' : 'v'}${pi}:${path[0]}`,
        kind: first.kind,
        kv,
        cables: 0,
        circuits,
        wires: 0,
        design: 0,
        lat,
        lon,
        flags,
        height: new Float32Array(m),
        minLat,
        minLon,
        maxLat,
        maxLon,
      })
    })
  }
  return out
}

/** Vías que tocan la caja; null si faltan datos (se reintenta). */
export async function powerWaysIn(b: Bbox, signal: AbortSignal): Promise<PowerWay[] | null> {
  const cLat = (b.south + b.north) / 2
  const cLon = (b.west + b.east) / 2
  if (spainCovers(cLat, cLon)) return spainWays(b)
  return oimWays(b, signal)
}

/** ¿Hace falta citar a OpenInfraMap aquí? */
export function usesOpenInfraMap(lat: number, lon: number): boolean {
  return !spainCovers(lat, lon)
}
