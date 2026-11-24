// Worker del tráfico: descarga las calles de la región alrededor de la cámara, monta la red
// (network.ts), le pone alturas del terreno y mueve los vehículos (sim.ts). Cada fotograma el
// hilo principal manda dónde está la cámara y cuánto tiempo ha pasado, y recibe la posición de
// cada vehículo (marco local de la región: x este, y arriba, z sur).
//
// La región es un cuadrado de (2r+1)² teselas z14 centrado en la de la cámara. Al cambiar de
// tesela se monta la red de la región nueva a trozos (los coches siguen moviéndose por la vieja
// mientras tanto) y los vehículos pasan a ella en su sitio (TrafficSim.adopt).

import { Vector3 } from 'three'
import { GeoFrame } from '../world/GeoFrame.ts'
import { QMHeightSource, TerrariumHeightSource, type HeightSource } from '../world/HeightSource.ts'
import { fetchVectorTile, latToY, lonToX, xToLon, yToLat } from '../world/mapTiles.ts'
import { driveSide } from './driveSide.ts'
import { buildNetwork, linkPose, type Link, type Network, type Road } from './network.ts'
import { parseRoadTile, type RoadTile } from './roads.ts'
import { TrafficSim, VTYPES, linkY } from './sim.ts'
import { BOAT_STRIDE, BOAT_TYPE, FERRY_TYPE, FLAG, STRIDE, TRAIN_TYPE, type FromWorker, type ToWorker } from './protocol.ts'
import { buildRailNet, carGap, RailSim, type Track } from './rail.ts'
import { buildFerryRoutes, type Route } from './ferry.ts'
import { buildMarine, MarineSim } from './marine.ts'

const NZ = 2 ** 14
const sim = new TrafficSim(1)
const rail = new RailSim(2)
sim.rail = rail
// los tranvías frenan por los coches que pisan su vía
rail.occupied = (x, z, r, ux, uz) => sim.occupied(x, z, r, ux, uz)
rail.boxBlocked = (cx, cz, ux, uz, hl, hw, tram) => sim.boxBlocked(cx, cz, ux, uz, hl, hw, tram)
let heightTracks: Track[] = []
// barcos (y ferris): los quietos se mandan una vez por región, cuando tienen altura
const marine = new MarineSim(3)
let staticsSent = -1
let staticsWait = 0
marine.waterY = (x, z, water) => {
  if (!region) return NaN
  const fr = region.frame
  const g = fr.worldToGeo(v3w.set(x, 0, z))
  if (water === 1 || water === 4) return fr.geoToWorld(g.lat, g.lon, 0, v3w).y
  const h = heights?.sample(g.lat, g.lon) ?? null
  return h === null ? NaN : fr.geoToWorld(g.lat, g.lon, h, v3w).y
}
// farolas: las que ya se han mandado (por posición) y las nuevas de este fotograma
let lampKeys = new Set<string>()
const lampRoads = new Set<Road>()
let newLamps: number[] = []
let lampsReset = false
let heightRoutes: Route[] = []
let trackCursor = 0
let heights: HeightSource | null = null
const tileCache = new Map<number, Promise<RoadTile | null>>()
let region: { cx: number; cy: number; r: number; keys: Set<number>; frame: GeoFrame; origin: [number, number, number] } | null = null
let building = false
let lastBuildMs = 0
let lastStepMs = 0
let heightLinks: Link[] = []
let heightCursor = 0
let heightSortT = 0
const v3 = new Vector3()
const v3b = new Vector3()
const v3w = new Vector3()

function getTile(x: number, y: number): Promise<RoadTile | null> {
  const k = y * NZ + x
  let p = tileCache.get(k)
  if (!p) {
    p = fetchVectorTile(x, y, new AbortController().signal)
      .then((vt) => parseRoadTile(vt, x, y))
      .catch(() => {
        tileCache.delete(k)
        return null
      })
    tileCache.set(k, p)
    // como mucho ~150 teselas en memoria (las más viejas fuera)
    if (tileCache.size > 150) {
      const first = tileCache.keys().next().value
      if (first !== undefined) tileCache.delete(first)
    }
  }
  return p
}

function makePause(ms: number): () => Promise<void> | void {
  let t = performance.now()
  return () => {
    if (performance.now() - t < ms) return
    return new Promise<void>((r) =>
      setTimeout(() => {
        t = performance.now()
        r()
      }, 0),
    )
  }
}

async function rebuild(cx: number, cy: number, r: number, camLat: number, camLon: number): Promise<void> {
  building = true
  const t0 = performance.now()
  try {
    const keys: number[] = []
    const jobs: Array<Promise<RoadTile | null>> = []
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        keys.push(y * NZ + x)
        jobs.push(getTile(x, y))
      }
    }
    const got = await Promise.all(jobs)
    const tiles = got.filter((t): t is RoadTile => t !== null)
    // sin la tesela de la cámara no vale la pena (se reintentará)
    if (!got[Math.floor(got.length / 2)]) return
    // origen: el de la región anterior si está cerca (geometría idéntica en lo que se comparte)
    let origin: [number, number, number]
    const lat0 = yToLat(cy + 0.5, NZ)
    const lon0 = xToLon(cx + 0.5, NZ)
    if (region && distKm(region.origin[0], region.origin[1], lat0, lon0) < 6) origin = region.origin
    else {
      let h = heights?.sample(camLat, camLon) ?? null
      if (h === null && heights) {
        const d = 0.002
        await heights.ensure(camLat - d, camLon - d, camLat + d, camLon + d).catch(() => undefined)
        h = heights.sample(camLat, camLon)
      }
      origin = [lat0, lon0, h ?? 0]
    }
    const frame = new GeoFrame()
    frame.setOrigin(origin[0], origin[1], origin[2])
    const side = driveSide(lat0, lon0)
    const p = new Vector3()
    const net: Network = await buildNetwork(
      tiles,
      {
        side,
        hRef: origin[2],
        project: (la, lo, h, out) => {
          frame.geoToWorld(la, lo, h, p)
          out.x = p.x
          out.y = p.y
          out.z = p.z
        },
      },
      makePause(6),
    )
    const railNet = buildRailNet(
      tiles,
      (la, lo, out) => {
        frame.geoToWorld(la, lo, origin[2], p)
        out.x = p.x
        out.z = p.z
      },
      net.links,
      railSide(lat0, lon0, side),
      net.moves,
      side,
    )
    const routes = buildFerryRoutes(tiles, (la, lo, out) => {
      frame.geoToWorld(la, lo, origin[2], p)
      out.x = p.x
      out.z = p.z
    })
    // agua: al nivel del mar mientras no hay alturas (los lagos y ríos se corrigen luego)
    for (const r of routes) for (let i = 0; i < r.y.length; i++) r.y[i] = frame.geoToWorld(r.lat[i], r.lon[i], 0, v3).y
    heightRoutes = routes.slice()
    // agua navegable, puertos y barcos quietos
    const marineRegion = await buildMarine(
      tiles,
      routes,
      {
        project: (la, lo, out) => {
          frame.geoToWorld(la, lo, origin[2], p)
          out.x = p.x
          out.z = p.z
        },
        geo: (x, z) => frame.worldToGeo(v3.set(x, 0, z)),
      },
      makePause(6),
    )
    const keySet = new Set(keys)
    if (sim.net && region) {
      const old = region
      const same = old.origin === origin
      const map = same
        ? (x: number, z: number, out: { x: number; z: number }) => {
            out.x = x
            out.z = z
          }
        : (x: number, z: number, out: { x: number; z: number }) => {
            const g = old.frame.worldToGeo(v3.set(x, 0, z))
            frame.geoToWorld(g.lat, g.lon, g.h, v3b)
            out.x = v3b.x
            out.z = v3b.z
          }
      sim.adopt(net, map)
      rail.adopt(railNet, map)
      marine.setRegion(marineRegion, routes, map)
      // lo nuevo (teselas que no estaban), con su tráfico
      sim.fill((l) => !old.keys.has(linkTile(l)))
      rail.fill((t) => !old.keys.has(trackTile(t)))
    } else {
      sim.setNetwork(net)
      sim.fill()
      rail.setNetwork(railNet)
      rail.fill()
      marine.setRegion(marineRegion, routes, null)
    }
    heightTracks = railNet.tracks.slice()
    trackCursor = 0
    if (!region || region.origin !== origin) {
      // marco nuevo: las farolas se vuelven a mandar
      lampKeys = new Set()
      newLamps = []
      lampsReset = true
    }
    lampRoads.clear()
    region = { cx, cy, r, keys: keySet, frame, origin }
    heightLinks = net.links.slice()
    heightCursor = 0
    heightSortT = 0
  } finally {
    building = false
    lastBuildMs = performance.now() - t0
  }
}

function trackTile(t: Track): number {
  const i = t.lat.length >> 1
  return Math.floor(latToY(t.lat[i], NZ)) * NZ + Math.floor(lonToX(t.lon[i], NZ))
}

/**
 * Lado por el que circulan los trenes en vía doble: el de las carreteras salvo en los países con
 * circulación ferroviaria por la izquierda (Francia, Bélgica, Suiza, Italia, Suecia y la red
 * convencional española).
 */
function railSide(lat: number, lon: number, road: 1 | -1): 1 | -1 {
  const boxes: Array<[number, number, number, number]> = [
    [42.3, -5.2, 51.1, 8.3], // Francia
    [49.5, 2.5, 51.5, 6.4], // Bélgica
    [45.8, 5.9, 47.8, 10.5], // Suiza
    [36.6, 6.6, 47.1, 18.6], // Italia
    [55.3, 11.0, 69.1, 24.2], // Suecia
    [35.9, -9.4, 43.8, 3.4], // España (sin Portugal: al oeste de -7,5 por debajo de 42)
  ]
  for (const [s, w, n, e] of boxes) {
    if (lat < s || lat > n || lon < w || lon > e) continue
    if (s === 35.9 && lon < -7.5 && lat < 42) continue
    return -1
  }
  return road
}

function linkTile(l: Link): number {
  const i = l.lat.length >> 1
  return Math.floor(latToY(l.lat[i], NZ)) * NZ + Math.floor(lonToX(l.lon[i], NZ))
}

function distKm(la1: number, lo1: number, la2: number, lo2: number): number {
  const dy = (la2 - la1) * 111.2
  const dx = (lo2 - lo1) * 111.2 * Math.cos((la1 * Math.PI) / 180)
  return Math.hypot(dx, dy)
}

/** Alturas del terreno de los enlaces (los más cercanos a la cámara primero), con un presupuesto de tiempo. */
function fillHeights(budgetMs: number, cam: { x: number; z: number }): void {
  const net = sim.net
  if (!net || !region || !heights) return
  const t0 = performance.now()
  if (t0 - heightSortT > 4000) {
    heightSortT = t0
    const d = (l: Link) => {
      const i = l.x.length >> 1
      return Math.hypot(l.x[i] - cam.x, l.z[i] - cam.z)
    }
    heightLinks = heightLinks.filter((l) => l.y.some((y) => Number.isNaN(y)))
    heightLinks.sort((a, b) => d(a) - d(b))
    heightCursor = 0
  }
  const frame = region.frame
  let done = 0
  while (heightCursor < heightLinks.length && performance.now() - t0 < budgetMs) {
    const l = heightLinks[heightCursor++]
    let missing = false
    for (let i = 0; i < l.y.length; i++) {
      if (!Number.isNaN(l.y[i])) continue
      const h = heights.sample(l.lat[i], l.lon[i])
      if (h === null) {
        missing = true
        continue
      }
      l.y[i] = frame.geoToWorld(l.lat[i], l.lon[i], h, v3).y
    }
    if (!missing) {
      done++
      placeLamps(l)
    }
    // movimientos que ya tienen las dos puntas
    for (const m of l.moves) fillMoveY(m)
    for (const lane of l.lanes) for (const m of lane.ins) fillMoveY(m)
  }
  if (heightCursor >= heightLinks.length) heightCursor = 0
  // vías
  while (trackCursor < heightTracks.length && performance.now() - t0 < budgetMs * 1.5) {
    const t = heightTracks[trackCursor++]
    for (let i = 0; i < t.y.length; i++) {
      if (!Number.isNaN(t.y[i])) continue
      const h = heights.sample(t.lat[i], t.lon[i])
      if (h !== null) t.y[i] = frame.geoToWorld(t.lat[i], t.lon[i], h, v3).y
    }
  }
  if (trackCursor >= heightTracks.length) trackCursor = 0
  // rutas de ferri: los embalses y ríos están por encima del mar
  if (heightRoutes.length && performance.now() - t0 < budgetMs * 1.6) {
    const r = heightRoutes.pop()!
    let ok = true
    for (let i = 0; i < r.y.length; i++) {
      const h = heights.sample(r.lat[i], r.lon[i])
      if (h === null) {
        ok = false
        continue
      }
      if (h > 1) r.y[i] = frame.geoToWorld(r.lat[i], r.lon[i], h, v3).y
    }
    if (!ok) heightRoutes.unshift(r)
  }
  void done
}

/**
 * Farolas de una calle urbana (las de las carreteras fuera de poblado no se alumbran): cada
 * 28–38 m según la clase, a un lado en las calles estrechas y a los dos (al tresbolillo) en las
 * avenidas, a 7–12 m de altura, al borde de la calzada; ni en puentes ni en túneles. Sodio o LED
 * según la calle.
 */
function placeLamps(l: Link): void {
  const r = l.road
  if (lampRoads.has(r)) return
  lampRoads.add(r)
  if (!l.urban) return
  const side = sim.net!.side
  const rank = l.rank
  const spacing = rank <= 1 ? 28 : rank <= 3 ? 32 : 38
  const twoWay = r.nF > 0 && r.nB > 0
  const both = r.nF + r.nB >= 3 || (twoWay && rank >= 3)
  const hw = twoWay ? Math.max(r.nF, r.nB) * r.lw : ((r.nF + r.nB) * r.lw) / 2
  const off = hw + 1.0
  const height = rank >= 5 ? 12 : rank >= 2 ? 9 : 7
  // sodio (naranja) en un 40 % de las calles, LED en el resto
  const led = (r.id * 2654435761) % 100 >= 40
  const power = rank >= 3 ? 2 : 1
  const kind = power + (led ? 0.5 : 0)
  const P = { x: 0, z: 0, dx: 0, dz: 0 }
  const put = (s: number, o: number) => {
    let i = 0
    while (i < l.s.length - 2 && l.s[i + 1] < s) i++
    if (l.bri[Math.min(i, l.bri.length - 1)] !== 0) return
    linkPose(l, s, o, side, P)
    const y = linkY(l, s)
    if (Number.isNaN(y)) return
    const key = `${Math.round(P.x)},${Math.round(P.z)}`
    if (lampKeys.has(key)) return
    lampKeys.add(key)
    newLamps.push(P.x, y + height, P.z, kind)
  }
  for (let s = l.s0 + spacing / 2; s < l.s1 - 3; s += spacing) {
    put(s, off)
    if (both) put(Math.min(l.s1 - 3, s + spacing / 2), -off)
  }
}

function fillMoveY(m: Network['moves'][number]): void {
  if (!Number.isNaN(m.y[0])) return
  const a = linkY(m.from, m.from.s1)
  const b = linkY(m.to, m.to.s0)
  if (Number.isNaN(a) || Number.isNaN(b)) return
  const k = m.y.length
  for (let q = 0; q < k; q++) m.y[q] = a + (b - a) * (m.s[q] / Math.max(m.len, 1e-6))
}

let out = new Float32Array(STRIDE * 2000)

function frame(msg: Extract<ToWorker, { kind: 'frame' }>): void {
  sim.hour = msg.hour
  rail.hour = msg.hour
  sim.cap = msg.cap
  sim.density = msg.density
  const cx = Math.floor(lonToX(msg.lon, NZ))
  const cy = Math.floor(latToY(msg.lat, NZ))
  const r = msg.tiles
  if (!building && (!region || region.cx !== cx || region.cy !== cy || region.r !== r)) void rebuild(cx, cy, r, msg.lat, msg.lon)
  let count = 0
  const t0 = performance.now()
  if (sim.net && region && !msg.sim) {
    // tráfico apagado: sin vehículos, pero las farolas siguen (alturas de las calles)
    const fr = region.frame
    fr.geoToWorld(msg.lat, msg.lon, msg.h, v3)
    fillHeights(3, { x: v3.x, z: v3.z })
  } else if (sim.net && region) {
    const fr = region.frame
    fr.geoToWorld(msg.lat, msg.lon, msg.h, v3)
    const cam = { x: v3.x, z: v3.z }
    sim.camera = cam
    rail.camera = cam
    marine.camera = cam
    marine.hour = msg.hour
    marine.density = msg.density
    sim.obstacles = msg.obstacles.map((o) => {
      fr.geoToWorld(o.lat, o.lon, o.h, v3b)
      return { x: v3b.x, z: v3b.z, r: o.r }
    })
    // pasos de como mucho 0,1 s (tras un parón, como mucho 1 s simulado)
    let dt = Math.min(1, msg.dt)
    while (dt > 1e-4) {
      const h = Math.min(0.1, dt)
      rail.step(h)
      marine.step(h)
      sim.step(h)
      dt -= h
    }
    fillHeights(3, cam)
    // salida
    let carsN = 0
    for (const tr of rail.trains) carsN += tr.cars
    const need = (sim.vehs.length + carsN + marine.vessels.length) * STRIDE
    if (out.length < need) out = new Float32Array(need * 1.5)
    const F = { x: 0, z: 0, y: 0 }
    const R2 = msg.drawRadius * msg.drawRadius
    for (const v of sim.vehs) {
      const w = sim.where(v)
      if (w.tunnel) continue
      sim.pointOf(v, 0.5, F)
      if (Number.isNaN(F.y)) continue
      const dx = F.x - cam.x
      const dz = F.z - cam.z
      if (dx * dx + dz * dz > R2) continue
      const o = count * STRIDE
      const T = VTYPES[v.type]
      out[o] = F.x
      out[o + 1] = F.y
      out[o + 2] = F.z
      const back = T.trailer > 0 ? 5.5 : v.len - 0.5
      sim.pointOf(v, back, F)
      out[o + 3] = F.x
      out[o + 4] = F.y
      out[o + 5] = F.z
      if (T.trailer > 0) {
        sim.pointOf(v, 4.4, F)
        out[o + 6] = F.x
        out[o + 7] = F.y
        out[o + 8] = F.z
        sim.pointOf(v, v.len - 0.5, F)
        out[o + 9] = F.x
        out[o + 10] = F.y
        out[o + 11] = F.z
      }
      if (Number.isNaN(out[o + 4])) continue
      out[o + 12] = v.type
      out[o + 13] = v.color
      let flags = 0
      if (v.acc < -0.8 || v.v < 0.3) flags |= FLAG.brake
      if (v.v < 0.3) flags |= FLAG.stopped
      if (v.blink < 0) flags |= FLAG.left
      if (v.blink > 0) flags |= FLAG.right
      if (w.bridge) flags |= FLAG.bridge
      out[o + 14] = flags
      count++
    }
    // barcos que navegan y ferris (los fondeados van con los quietos)
    const bow = { x: 0, z: 0 }
    const stern = { x: 0, z: 0 }
    for (const v of marine.vessels) {
      if (v.mode === 2 || Number.isNaN(v.y)) continue
      const dx = v.x - cam.x
      const dz = v.z - cam.z
      if (dx * dx + dz * dz > R2 * (v.len > 60 ? 2.25 : 1)) continue
      marine.ends(v, bow, stern)
      const o = count * STRIDE
      out[o] = bow.x
      out[o + 1] = v.y
      out[o + 2] = bow.z
      out[o + 3] = stern.x
      out[o + 4] = v.y
      out[o + 5] = stern.z
      out[o + 12] = v.route ? FERRY_TYPE + (v.kind === -2 ? 1 : 0) : BOAT_TYPE + v.kind
      out[o + 13] = v.color
      out[o + 14] = v.v < 0.3 ? FLAG.stopped : 0
      count++
    }
    // coches de tren
    const kinds = { rail: 0, narrow: 1, metro: 2, tram: 3 }
    for (const tr of rail.trains) {
      for (let k = 0; k < tr.cars; k++) {
        const front = k * (tr.carLen + carGap(tr.kind)) + 0.3
        const w = rail.where(tr, front + tr.carLen / 2)
        if (w.tunnel) continue
        rail.pointOf(tr, front, F)
        if (Number.isNaN(F.y)) continue
        const dx = F.x - cam.x
        const dz = F.z - cam.z
        if (dx * dx + dz * dz > R2) continue
        const o = count * STRIDE
        out[o] = F.x
        out[o + 1] = F.y
        out[o + 2] = F.z
        rail.pointOf(tr, front + tr.carLen - 0.6, F)
        if (Number.isNaN(F.y)) continue
        out[o + 3] = F.x
        out[o + 4] = F.y
        out[o + 5] = F.z
        out[o + 12] = TRAIN_TYPE + kinds[tr.kind] * 2 + (k === 0 ? 0 : 1)
        out[o + 13] = tr.color
        let flags = 0
        if (k === 0) flags |= FLAG.head
        if (k === tr.cars - 1) flags |= FLAG.last
        if (tr.v < 0.3) flags |= FLAG.stopped | FLAG.brake
        if (w.bridge) flags |= FLAG.bridge
        out[o + 14] = flags
        count++
      }
    }
  }
  lastStepMs = performance.now() - t0
  const data = out.slice(0, count * STRIDE)
  const boats = msg.sim ? takeStatics() : null
  const lamps = Float32Array.from(newLamps)
  newLamps = []
  const reset = lampsReset
  lampsReset = false
  const reply: FromWorker = {
    kind: 'state',
    origin: region ? region.origin : null,
    count,
    data,
    lamps,
    lampsReset: reset,
    boats,
    info: {
      vehicles: sim.vehs.length,
      links: sim.net?.links.length ?? 0,
      moves: sim.net?.moves.length ?? 0,
      building,
      tiles: tileCache.size,
      buildMs: lastBuildMs,
      stepMs: lastStepMs,
    },
  }
  ;(self as unknown as Worker).postMessage(reply, boats ? [data.buffer, lamps.buffer, boats.buffer] : [data.buffer, lamps.buffer])
}

/**
 * Barcos quietos de la región, cuando han cambiado y ya tienen altura (los de lagos y ríos
 * esperan a las alturas del terreno, como mucho unos 20 s).
 */
function takeStatics(): Float32Array | null {
  if (marine.staticsVersion === staticsSent) return null
  const list = marine.statics
  let missing = 0
  for (const b of list) {
    if (Number.isNaN(b.y)) b.y = marine.waterY(b.x, b.z, b.water)
    if (Number.isNaN(b.y)) missing++
  }
  if (missing && staticsWait++ < 1200) return null
  staticsSent = marine.staticsVersion
  staticsWait = 0
  const outB = new Float32Array((list.length - missing) * BOAT_STRIDE)
  let k = 0
  for (const b of list) {
    if (Number.isNaN(b.y)) continue
    outB.set([b.x, b.y, b.z, b.h, b.kind, b.len, b.color], k)
    k += BOAT_STRIDE
  }
  return outB
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data
  if (msg.kind === 'init') {
    heights = msg.heights === 'ign' ? new QMHeightSource(msg.ignUrl, 14, 500) : new TerrariumHeightSource(msg.terrariumUrl, 14, 300)
    return
  }
  if (msg.kind === 'frame') frame(msg)
}
