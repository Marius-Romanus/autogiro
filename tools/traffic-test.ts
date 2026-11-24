// Prueba del tráfico sin navegador: red de una zona real (teselas de OpenFreeMap) y unos minutos
// de simulación comprobando en cada paso que ningún vehículo pisa a otro.
//
//   node --experimental-strip-types tools/traffic-test.ts [lugar|lat lon] [radio=1] [min=5] [svg=ruta] [hora=8.5] [cap=1500]
//
// Lugares: casarrubios, navalcarnero, mostoles, madrid, paris, londres, manhattan, tokio, lagos,
// a5 (enlace A-5/M-50). `todos` prueba todos seguidos. Sale con código 1 si hay solapes.

import { writeFileSync } from 'node:fs'
import { Vector3 } from 'three'
import { GeoFrame } from '../src/world/GeoFrame.ts'
import { fetchVectorTile, latToY, lonToX } from '../src/world/mapTiles.ts'
import { buildNetwork, linkPose as linkPoseLocal, type Network } from '../src/traffic/network.ts'
import { parseRoadTile, type RoadTile } from '../src/traffic/roads.ts'
import { TrafficSim, VTYPES, type Veh } from '../src/traffic/sim.ts'
import { driveSide } from '../src/traffic/driveSide.ts'
import { buildRailNet, carGap, RailSim } from '../src/traffic/rail.ts'
const vec = new Vector3()

const PLACES: Record<string, [number, number]> = {
  casarrubios: [40.188, -4.03],
  navalcarnero: [40.289, -4.013],
  mostoles: [40.3223, -3.8649],
  madrid: [40.4168, -3.7038],
  a5: [40.371, -3.857],
  paris: [48.8738, 2.295],
  londres: [51.5074, -0.1278],
  manhattan: [40.758, -73.9855],
  tokio: [35.6595, 139.7005],
  zaragoza: [41.6565, -0.88],
  amsterdam: [52.372, 4.893],
  lagos: [6.455, 3.39],
}

const args = process.argv.slice(2)
const opt = (k: string, d: string) => args.find((a) => a.startsWith(k + '='))?.slice(k.length + 1) ?? d
const plain = args.filter((a) => !a.includes('='))
let targets: Array<[string, number, number]>
if (plain[0] === 'todos') targets = Object.entries(PLACES).map(([k, v]) => [k, v[0], v[1]])
else if (plain.length >= 2 && Number.isFinite(Number(plain[0]))) targets = [['punto', Number(plain[0]), Number(plain[1])]]
else targets = [[plain[0] ?? 'navalcarnero', ...(PLACES[plain[0] ?? 'navalcarnero'] ?? PLACES.navalcarnero)] as [string, number, number]]
const radius = Number(opt('radio', '1'))
const minutes = Number(opt('min', '5'))
const svgPath = opt('svg', '')
const hour = Number(opt('hora', '8.5'))
const cap = Number(opt('cap', '1500'))

let failed = false
for (const [name, lat, lon] of targets) {
  const n = 2 ** 14
  const cx = Math.floor(lonToX(lon, n))
  const cy = Math.floor(latToY(lat, n))
  const tiles: RoadTile[] = []
  const t0 = performance.now()
  const jobs: Array<Promise<void>> = []
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      jobs.push(fetchVectorTile(x, y, new AbortController().signal).then((vt) => void tiles.push(parseRoadTile(vt, x, y))))
    }
  }
  await Promise.all(jobs)
  const tParse = performance.now() - t0
  const frame = new GeoFrame()
  frame.setOrigin(lat, lon, 0)
  const side = driveSide(lat, lon)
  const net = await buildNetwork(tiles, {
    side,
    hRef: 0,
    project: (la, lo, h, o) => {
      const w = frame.geoToWorld(la, lo, h, vec)
      o.x = w.x
      o.y = w.y
      o.z = w.z
    },
  })
  // alturas planas para la prueba
  for (const l of net.links) l.y.fill(0)
  for (const m of net.moves) m.y.fill(0)
  const st = net.stats
  console.log(`\n== ${name} (${radius * 2 + 1}×${radius * 2 + 1} teselas, ${side === 1 ? 'derecha' : 'izquierda'}): descarga ${tParse.toFixed(0)} ms, red ${st.ms.toFixed(0)} ms`)
  console.log(`   calles ${st.roads}, enlaces ${st.links}, cruces ${st.clusters} (rotondas ${st.rings}, semáforos ${st.signals}), movimientos ${st.moves}, conflictos ${st.zones}`)
  const kinds: Record<string, number> = {}
  for (const c of net.clusters) kinds[c.kind] = (kinds[c.kind] ?? 0) + 1
  console.log('   tipos de cruce:', JSON.stringify(kinds))
  const noMoves = net.links.filter((l) => l.to !== null && l.moves.length === 0).length
  console.log(`   enlaces sin salida: ${noMoves}, vivos ${net.links.filter((l) => l.live).length}/${net.links.length}, entradas ${net.entries.length}`)

  if (svgPath) writeSvg(net, frame, svgPath.replace('.svg', `-${name}.svg`), lat, lon)

  const railNet = buildRailNet(
    tiles,
    (la, lo, o) => {
      const w = frame.geoToWorld(la, lo, 0, vec)
      o.x = w.x
      o.z = w.z
    },
    net.links,
    side,
    net.moves,
  )
  for (const t of railNet.tracks) t.y.fill(0)
  const rail = new RailSim(5)
  rail.hour = hour
  rail.setNetwork(railNet)
  rail.fill()
  const stops = railNet.tracks.reduce((n, t) => n + t.stops.length, 0)
  console.log(`   vías ${railNet.tracks.length} (${(railNet.tracks.reduce((s, t) => s + t.len, 0) / 1000).toFixed(1)} km), paradas ${stops}, entradas ${railNet.entries.length}, pasos a nivel ${railNet.crossings.length}, trenes al empezar ${rail.trains.length}`)
  const sim = new TrafficSim(7)
  sim.rail = rail
  rail.occupied = (x, z, r, ux, uz) => sim.occupied(x, z, r, ux, uz)
  rail.boxBlocked = (cx, cz, ux, uz, hl, hw, tram) => sim.boxBlocked(cx, cz, ux, uz, hl, hw, tram)
  sim.hour = hour
  sim.cap = cap
  sim.setNetwork(net)
  sim.fill()
  console.log(`   vehículos al empezar: ${sim.vehs.length}`)
  const dt = 0.1
  const steps = Math.round((minutes * 60) / dt)
  let overlaps = 0
  let trainHits = 0
  let firstTrainHit = ''
  let maxTrains = 0
  const pairs = new Map<string, { a: number; b: number; cat: string; text: string; x: number; z: number; t: number }>()
  const cats: Record<string, number> = {}
  let worst = ''
  let maxStuck = 0
  let tSim = 0
  let checked = 0
  const P = { x: 0, z: 0, y: 0 }
  for (let i = 0; i < steps; i++) {
    const a = performance.now()
    rail.step(dt)
    sim.step(dt)
    if (i % 5 === 0) {
      const o = trainOverlaps(rail, sim)
      if (o) {
        trainHits++
        if (!firstTrainHit) firstTrainHit = `t=${sim.t.toFixed(1)} ${o}`
      }
    }
    maxTrains = Math.max(maxTrains, rail.trains.length)
    tSim += performance.now() - a
    if (i % 5 === 0) {
      const o = findOverlaps(sim)
      checked++
      if (o.length) {
        overlaps += o.length
        if (!worst) worst = `t=${sim.t.toFixed(1)} s: ${o[0].text}`
        for (const x of o) {
          const k = `${x.a}-${x.b}`
          if (pairs.has(k)) continue
          pairs.set(k, x)
          cats[x.cat] = (cats[x.cat] ?? 0) + 1
        }
      }
    }
    for (const v of sim.vehs) maxStuck = Math.max(maxStuck, v.stuck)
  }
  void P
  const stuck = sim.vehs.filter((v) => v.stuck > 60).length
  const c = sim.counters
  console.log(`   ${minutes} min simulados en ${(tSim / 1000).toFixed(1)} s (${((tSim / steps) * 1000 / Math.max(1, sim.vehs.length)).toFixed(2)} µs/veh/paso), vehículos al final ${sim.vehs.length}`)
  console.log(`   entradas ${c.spawned}, salidas ${c.exited}, cambios de carril ${c.laneChanges}, rutas cambiadas ${c.replans}, frenadas forzadas ${c.forcedStops}, paradas de seguridad ${c.safetyStops}`)
  console.log(`   parados > 60 s: ${stuck}, mayor espera ${maxStuck.toFixed(0)} s`)
  console.log(`   trenes: como mucho ${maxTrains} a la vez, al final ${rail.trains.length} (${rail.trains.filter((t) => t.v > 1).length} en marcha); solapes con trenes: ${trainHits}${firstTrainHit ? ' — ' + firstTrainHit : ''}`)
  console.log(`   SOLAPES: ${overlaps} en ${checked} comprobaciones${worst ? ' — primero: ' + worst : ''}`)
  if (overlaps) {
    failed = true
    console.log('   parejas distintas por tipo:', JSON.stringify(cats))
    for (const x of [...pairs.values()].slice(0, Number(opt('ver', '8')))) {
      const g = frame.worldToGeo(vec.set(x.x, 0, x.z) as any)
      console.log(`     t=${x.t.toFixed(1)} ${g.lat.toFixed(6)},${g.lon.toFixed(6)} [${x.cat}] ${x.text}`)
    }
  }
  // dónde están los atascados
  const stuckList = sim.vehs.filter((v) => v.stuck > 60 && v.lane && v.lane.link.s1 - v.s < 5).slice(0, 20)
  for (const v of stuckList) {
    sim.pointOf(v, 0, P)
    const g = frame.worldToGeo(vec.set(P.x, 0, P.z) as any)
    const where = v.lane ? `carril ${v.lane.i} de enlace ${v.lane.link.id} (${v.lane.link.s1 - v.s < 5 ? 'en la línea' : 'en cola'}, cruce ${v.lane.link.to?.kind ?? '-'})` : `movimiento ${v.move?.id}`
    console.log(`     atascado ${v.id} ${VTYPES[v.type].id} ${g.lat.toFixed(5)},${g.lon.toFixed(5)} ${where} plan=${v.plan ? v.plan.turn : 'no'} comprometido=${v.committed} motivo: ${v.why || '-'}`)
    // cadena de esperas
    const chain: string[] = []
    const seen = new Set<Veh>()
    let b: Veh | null = v
    for (let k = 0; k < 10 && b; k++) {
      if (seen.has(b)) {
        chain.push(`CICLO en ${b.id}`)
        break
      }
      seen.add(b)
      const st = b.lane ? (b.lane.link.s1 - b.s < 5 ? 'línea' : `cola s=${b.s.toFixed(0)}/${b.lane.link.s1.toFixed(0)}`) : `en mov ${b.move?.turn} s=${b.s.toFixed(1)}/${b.move?.len.toFixed(1)}`
      chain.push(`${b.id}[${st}${b.committed ? ',paso' : ''}${b.plan ? '' : ',sin plan'}${b.doomed ? ',sin salida' : ''} v=${b.v.toFixed(1)}] ${b.why || (b.lane && b.lane.link.s1 - b.s >= 5 ? 'cola' : '')}`)
      if (b.why === '' && b.lane) {
        // en cola: el de delante
        const i2 = b.lane.vehs.indexOf(b)
        b = b.lane.vehs[i2 + 1] ?? null
        continue
      }
      if (b.why === '' && b.move) {
        const i2 = b.move.vehs.indexOf(b)
        b = b.move.vehs[i2 + 1] ?? null
        continue
      }
      b = b.blocker
    }
    console.log('        ' + chain.join(' → '))
  }
}
process.exit(failed ? 1 : 0)

// ---------------------------------------------------------------------------


function findOverlaps(sim: TrafficSim): Array<{ a: number; b: number; cat: string; text: string; x: number; z: number; t: number }> {
  const out: Array<{ a: number; b: number; cat: string; text: string; x: number; z: number; t: number }> = []
  const boxes: Array<{ v: Veh; cx: number; cz: number; ux: number; uz: number; hl: number; hw: number; lvl: number }> = []
  const F = { x: 0, z: 0, y: 0 }
  const R = { x: 0, z: 0, y: 0 }
  for (const v of sim.vehs) {
    sim.pointOf(v, 0, F)
    sim.pointOf(v, v.len, R)
    let ux = F.x - R.x
    let uz = F.z - R.z
    const l = Math.hypot(ux, uz) || 1
    ux /= l
    uz /= l
    const w = sim.where(v)
    // en un túnel no se ve: no cuenta
    if (w.tunnel) continue
    const lvl = w.bridge ? 100 + w.layer : 0
    const T = VTYPES[v.type]
    if (T.trailer > 0) {
      // tractora y semirremolque por separado (el remolque se mete por dentro de las curvas)
      const H = { x: 0, z: 0, y: 0 }
      sim.pointOf(v, 6, R)
      boxes.push(box(v, F, R, 6, lvl))
      sim.pointOf(v, 4.5, H)
      sim.pointOf(v, v.len, R)
      boxes.push(box(v, H, R, T.trailer - 1.5, lvl))
    } else boxes.push({ v, cx: (F.x + R.x) / 2, cz: (F.z + R.z) / 2, ux, uz, hl: v.len / 2 - 0.25, hw: v.width / 2 - 0.15, lvl })
  }
  const grid = new Map<string, number[]>()
  boxes.forEach((b, i) => {
    const k = `${Math.floor(b.cx / 20)},${Math.floor(b.cz / 20)}`
    const l = grid.get(k)
    if (l) l.push(i)
    else grid.set(k, [i])
  })
  boxes.forEach((a, i) => {
    const gx = Math.floor(a.cx / 20)
    const gz = Math.floor(a.cz / 20)
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const j of grid.get(`${gx + dx},${gz + dz}`) ?? []) {
          if (j <= i) continue
          const b = boxes[j]
          if (a.v === b.v) continue
          if (a.lvl !== b.lvl) continue
          if (Math.hypot(a.cx - b.cx, a.cz - b.cz) > a.hl + b.hl + 3) continue
          if (obbOverlap(a, b)) {
            const desc = (v: Veh) =>
              v.lane
                ? `carril(enl ${v.lane.link.id} c${v.lane.i}/${v.lane.link.n} s=${v.s.toFixed(1)}/${v.lane.link.s0.toFixed(0)}-${v.lane.link.s1.toFixed(0)} v=${v.v.toFixed(1)} lc=${v.lcT.toFixed(1)} hist=${v.hist.length})`
                : `mov(${v.move!.id} ${v.move!.turn} cruce ${v.move!.cluster.id} ${v.move!.cluster.kind} s=${v.s.toFixed(1)}/${v.move!.len.toFixed(1)} v=${v.v.toFixed(1)})`
            const A = a.v
            const B = b.v
            let cat: string
            if (A.lane && B.lane) cat = A.lane.link === B.lane.link ? (A.lane === B.lane ? 'mismo carril' : 'carriles vecinos') : A.lane.link.road === B.lane.link.road ? 'sentidos de una calle' : 'enlaces distintos'
            else if (A.move && B.move) cat = A.move.cluster === B.move.cluster ? (A.move === B.move ? 'mismo movimiento' : 'movimientos del cruce') : 'cruces distintos'
            else cat = 'carril y movimiento'
            out.push({ a: Math.min(A.id, B.id), b: Math.max(A.id, B.id), cat, text: `${A.id} ${VTYPES[A.type].id} ${desc(A)} y ${B.id} ${VTYPES[B.type].id} ${desc(B)}`, x: a.cx, z: a.cz, t: sim.t })
          }
        }
      }
    }
  })
  return out
}

/** coches de tren que se pisan entre sí o con un vehículo (a nivel) */
function trainOverlaps(rail: RailSim, sim: TrafficSim): string {
  type B = { cx: number; cz: number; ux: number; uz: number; hl: number; hw: number; who: string }
  const boxes: B[] = []
  const F = { x: 0, z: 0, y: 0 }
  const R = { x: 0, z: 0, y: 0 }
  for (const tr of rail.trains) {
    for (let k = 0; k < tr.cars; k++) {
      const f = k * (tr.carLen + carGap(tr.kind)) + 0.3
      const w = rail.where(tr, f + tr.carLen / 2)
      const wf = rail.where(tr, f)
      const wr = rail.where(tr, f + tr.carLen)
      if (w.tunnel || w.bridge || wf.bridge || wr.bridge || wf.tunnel || wr.tunnel) continue
      rail.pointOf(tr, f, F)
      rail.pointOf(tr, f + tr.carLen - 0.6, R)
      let ux = F.x - R.x
      let uz = F.z - R.z
      const l = Math.hypot(ux, uz) || 1
      ux /= l
      uz /= l
      boxes.push({ cx: (F.x + R.x) / 2, cz: (F.z + R.z) / 2, ux, uz, hl: tr.carLen / 2 - 0.3, hw: tr.kind === 'tram' ? 1.1 : 1.3, who: `${tr.kind === 'tram' ? 'tranvía' : 'tren'} ${tr.id} coche ${k} v=${tr.v.toFixed(1)} parado=${tr.dwell > 0} vía ${Array.from(tr.path[tr.hi].t.bri).join('')}` })
    }
  }
  if (boxes.length === 0) return ''
  const nTrain = boxes.length
  for (const v of sim.vehs) {
    const w = sim.where(v)
    if (w.tunnel || w.bridge) continue
    sim.pointOf(v, 0, F)
    sim.pointOf(v, v.len, R)
    let ux = F.x - R.x
    let uz = F.z - R.z
    const l = Math.hypot(ux, uz) || 1
    ux /= l
    uz /= l
    boxes.push({ cx: (F.x + R.x) / 2, cz: (F.z + R.z) / 2, ux, uz, hl: v.len / 2 - 0.25, hw: v.width / 2 - 0.15, who: `vehículo ${v.id} ${v.lane ? 'carril' : 'movimiento'} ${VTYPES[v.type].name ?? v.type} v=${v.v.toFixed(1)} s=${v.s.toFixed(0)} enlace ${v.lane ? v.lane.link.id : '-'} puentes ${v.lane ? Array.from(v.lane.link.bri).join('') : '-'}` })
  }
  for (let i = 0; i < nTrain; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]
      const b = boxes[j]
      if (Math.hypot(a.cx - b.cx, a.cz - b.cz) > a.hl + b.hl + 3) continue
      if (a.who.split(' coche')[0] === b.who.split(' coche')[0]) continue
      if (obbOverlap(a, b)) {
        // dónde: el vehículo respecto a la caja del coche de tren
        const dx = b.cx - a.cx
        const dz = b.cz - a.cz
        const along = dx * a.ux + dz * a.uz
        const lat = -dx * a.uz + dz * a.ux
        const occ = sim.occupied(a.cx + a.ux * a.hl, a.cz + a.uz * a.hl, 1.45)
        return `${a.who} y ${b.who} (a lo largo ${along.toFixed(1)} m, de lado ${lat.toFixed(1)} m, ángulo ${((Math.acos(Math.min(1, Math.abs(a.ux * b.ux + a.uz * b.uz))) * 180) / Math.PI).toFixed(0)}°, ocupado en la cabeza ${occ})`
      }
    }
  }
  return ''
}

function box(v: Veh, F: { x: number; z: number }, R: { x: number; z: number }, len: number, lvl: number) {
  let ux = F.x - R.x
  let uz = F.z - R.z
  const l = Math.hypot(ux, uz) || 1
  ux /= l
  uz /= l
  return { v, cx: (F.x + R.x) / 2, cz: (F.z + R.z) / 2, ux, uz, hl: len / 2 - 0.25, hw: v.width / 2 - 0.15, lvl }
}

function obbOverlap(a: { cx: number; cz: number; ux: number; uz: number; hl: number; hw: number }, b: { cx: number; cz: number; ux: number; uz: number; hl: number; hw: number }): boolean {
  const axes = [
    [a.ux, a.uz],
    [-a.uz, a.ux],
    [b.ux, b.uz],
    [-b.uz, b.ux],
  ]
  const dx = b.cx - a.cx
  const dz = b.cz - a.cz
  for (const [x, z] of axes) {
    const ra = a.hl * Math.abs(a.ux * x + a.uz * z) + a.hw * Math.abs(-a.uz * x + a.ux * z)
    const rb = b.hl * Math.abs(b.ux * x + b.uz * z) + b.hw * Math.abs(-b.uz * x + b.ux * z)
    if (Math.abs(dx * x + dz * z) > ra + rb) return false
  }
  return true
}

function writeSvg(net: Network, frame: GeoFrame, path: string, lat: number, lon: number): void {
  // vista de 1,2 km alrededor del punto con la ortofoto (PNOA en España, Esri fuera) debajo
  const half = Number(opt('zoom', '600'))
  const z = 17
  const nz = 2 ** z
  const parts: string[] = []
  const toSvg = (x: number, zz: number) => [x + half, zz + half]
  // teselas de fondo
  const spain = lat > 35 && lat < 44 && lon > -10 && lon < 5
  const url = spain
    ? 'https://www.ign.es/wmts/pnoa-ma?service=WMTS&request=GetTile&version=1.0.0&format=image/jpeg&layer=OI.OrthoimageCoverage&style=default&tilematrixset=GoogleMapsCompatible&tilematrix={z}&tilerow={y}&tilecol={x}'
    : 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
  const corner = (dx: number, dz: number) => frame.worldToGeo(vec.set(dx, 0, dz) as any)
  const nw = corner(-half, -half)
  const se = corner(half, half)
  const x0 = Math.floor(lonToX(nw.lon, nz))
  const x1 = Math.floor(lonToX(se.lon, nz))
  const y0 = Math.floor(latToY(nw.lat, nz))
  const y1 = Math.floor(latToY(se.lat, nz))
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const a = frame.geoToWorld(tileLat(ty, nz), tileLon(tx, nz), 0, new Vector3())
      const b = frame.geoToWorld(tileLat(ty + 1, nz), tileLon(tx + 1, nz), 0, new Vector3())
      const [sx, sy] = toSvg(a.x, a.z)
      const [ex, ey] = toSvg(b.x, b.z)
      parts.push(`<image href="${url.replace(/&/g, "&amp;").replace('{z}', String(z)).replace('{x}', String(tx)).replace('{y}', String(ty))}" x="${sx.toFixed(1)}" y="${sy.toFixed(1)}" width="${(ex - sx).toFixed(1)}" height="${(ey - sy).toFixed(1)}" preserveAspectRatio="none"/>`)
    }
  }
  parts.push(`<rect width="${half * 2}" height="${half * 2}" fill="black" opacity="0.35"/>`)
  const P = { x: 0, z: 0, dx: 0, dz: 0 }
  for (const l of net.links) {
    for (let i = 0; i < l.n; i++) {
      const pts: string[] = []
      for (let s = l.s0; s <= l.s1 + 0.01; s += Math.max(2, (l.s1 - l.s0) / 40)) {
        linkPoseLocal(l, Math.min(s, l.s1), l.off[i], net.side, P)
        const [x, y] = toSvg(P.x, P.z)
        if (x < -50 || y < -50 || x > half * 2 + 50 || y > half * 2 + 50) continue
        pts.push(`${x.toFixed(1)},${y.toFixed(1)}`)
      }
      if (pts.length > 1) parts.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${l.to === null ? '#ff0' : '#3cf'}" stroke-width="${(half / 600 * 0.9).toFixed(2)}" marker-end="url(#a)"/>`)
    }
  }
  const col: Record<string, string> = { priority: '#fff', equal: '#f0f', roundabout: '#0f0', signal: '#f33' }
  for (const m of net.moves) {
    const pts: string[] = []
    for (let q = 0; q < m.x.length; q += 2) {
      const [x, y] = toSvg(m.x[q], m.z[q])
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`)
    }
    const [x, y] = toSvg(m.x[m.x.length - 1], m.z[m.z.length - 1])
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`)
    const [ax, ay] = toSvg(m.x[0], m.z[0])
    if (ax < -50 || ay < -50 || ax > half * 2 + 50 || ay > half * 2 + 50) continue
    parts.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${m.level === 2 ? '#fc3' : '#f84'}" stroke-width="${(half / 600 * 0.6).toFixed(2)}" opacity="0.8"/>`)
  }
  for (const c of net.clusters) {
    const [x, y] = toSvg(c.x, c.z)
    if (x < 0 || y < 0 || x > half * 2 || y > half * 2) continue
    parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${((c.nodes.length > 1 ? 3 : 1.8) * half) / 600}" fill="none" stroke="${col[c.kind]}" stroke-width="${(half / 600 * 0.8).toFixed(2)}"/>`)
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1600" viewBox="0 0 ${half * 2} ${half * 2}"><defs><marker id="a" markerWidth="4" markerHeight="4" refX="3" refY="2" orient="auto"><path d="M0,0 L4,2 L0,4" fill="#3cf"/></marker></defs><rect width="${half * 2}" height="${half * 2}" fill="#222"/>${parts.join('')}</svg>`
  writeFileSync(path, svg)
  console.log(`   SVG: ${path}`)
}

function tileLat(y: number, n: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI
}
function tileLon(x: number, n: number): number {
  return (x / n) * 360 - 180
}
