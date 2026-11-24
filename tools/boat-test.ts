// Prueba de los barcos sin navegador: agua, pantalanes y puertos de una zona real (teselas de
// OpenFreeMap) y unos minutos de simulación comprobando en cada paso que ningún casco pisa a otro
// (ni a los amarrados, atracados o fondeados) ni se sube a tierra.
//
//   node --experimental-strip-types tools/boat-test.ts [lugar|lat lon|todos] [radio=2] [min=10] [hora=12] [svg=ruta]
//
// Sale con código 1 si hay solapes o barcos en tierra.

import { writeFileSync } from 'node:fs'
import { Vector3 } from 'three'
import { GeoFrame } from '../src/world/GeoFrame.ts'
import { fetchVectorTile, latToY, lonToX } from '../src/world/mapTiles.ts'
import { parseRoadTile, type RoadTile } from '../src/traffic/roads.ts'
import { buildFerryRoutes } from '../src/traffic/ferry.ts'
import { BOATS, MarineSim, buildMarine, hullClear, type Vessel } from '../src/traffic/marine.ts'

const PLACES: Record<string, [number, number]> = {
  barcelona: [41.372, 2.19],
  palma: [39.562, 2.635],
  banus: [36.484, -4.952],
  algeciras: [36.135, -5.42],
  valencia: [39.445, -0.31],
  lisboa: [38.69, -9.17],
  paris: [48.858, 2.33],
  hamburgo: [53.54, 9.97],
  nuevayork: [40.69, -74.03],
  sidney: [-33.855, 151.21],
  embalse: [40.385, -4.32],
  ginebra: [46.215, 6.16],
}

const args = process.argv.slice(2)
const opt = (k: string, d: string) => args.find((a) => a.startsWith(k + '='))?.slice(k.length + 1) ?? d
const plain = args.filter((a) => !a.includes('='))
let targets: Array<[string, number, number]>
if (plain[0] === 'todos') targets = Object.entries(PLACES).map(([k, v]) => [k, v[0], v[1]])
else if (plain.length >= 2 && Number.isFinite(Number(plain[0]))) targets = [['punto', Number(plain[0]), Number(plain[1])]]
else targets = [[plain[0] ?? 'barcelona', ...(PLACES[plain[0] ?? 'barcelona'] ?? PLACES.barcelona)] as [string, number, number]]
const radius = Number(opt('radio', '2'))
const minutes = Number(opt('min', '10'))
const hour = Number(opt('hora', '12'))
const svgPath = opt('svg', '')
const vec = new Vector3()

let failed = false
for (const [name, lat, lon] of targets) {
  const n = 2 ** 14
  const cx = Math.floor(lonToX(lon, n))
  const cy = Math.floor(latToY(lat, n))
  const tiles: RoadTile[] = []
  const jobs: Array<Promise<void>> = []
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      jobs.push(fetchVectorTile(x, y, new AbortController().signal).then((vt) => void tiles.push(parseRoadTile(vt, x, y))))
    }
  }
  await Promise.all(jobs)
  const frame = new GeoFrame()
  frame.setOrigin(lat, lon, 0)
  const project = (la: number, lo: number, o: { x: number; z: number }) => {
    const w = frame.geoToWorld(la, lo, 0, vec)
    o.x = w.x
    o.z = w.z
  }
  const routes = buildFerryRoutes(tiles, project)
  for (const r of routes) r.y.fill(0)
  const t0 = performance.now()
  const reg = await buildMarine(tiles, routes, { project, geo: (x, z) => frame.worldToGeo(vec.set(x, 0, z)) }, () => undefined)
  const buildMs = performance.now() - t0
  const g = reg.grid
  console.log(`\n== ${name}: agua ${g ? `${g.nx}×${g.nz} celdas de ${g.cell} m` : 'ninguna'}, ${buildMs.toFixed(0)} ms`)
  console.log(`   mar ${reg.areas.sea.toFixed(1)} km², abierto ${reg.areas.deep.toFixed(1)}, lagos ${reg.areas.lake.toFixed(1)}, ríos ${reg.areas.river.toFixed(1)}; puerto ${reg.port ? 'sí' : 'no'}; ferris ${routes.length} rutas`)
  const kinds = new Map<number, number>()
  for (const b of reg.statics) kinds.set(b.kind, (kinds.get(b.kind) ?? 0) + 1)
  console.log(`   quietos ${reg.statics.length} (amarrados ${reg.moored}, por tipo ${JSON.stringify(Object.fromEntries(kinds))}), fondeados ${reg.anchored.length}`)
  // los quietos entre sí y en tierra
  let staticBad = 0
  for (let i = 0; i < reg.statics.length; i++) {
    const a = reg.statics[i]
    const Ba = a.len * BOATS[a.kind].beam
    if (g && !g.inWater(a.x, a.z)) {
      staticBad++
      if (staticBad < 6) console.log(`     · quieto fuera del agua: tipo ${a.kind} ${a.len.toFixed(0)} m en ${a.x.toFixed(0)}, ${a.z.toFixed(0)}`)
    }
    for (let j = i + 1; j < reg.statics.length; j++) {
      const b = reg.statics[j]
      if (Math.abs(a.x - b.x) > 400 || Math.abs(a.z - b.z) > 400) continue
      const c = hullClear(a.x, a.z, a.h, a.len, Ba, b.x, b.z, b.h, b.len, b.len * BOATS[b.kind].beam)
      if (c < -0.05) {
        staticBad++
        if (staticBad < 10) console.log(`     · quietos que se pisan: tipos ${a.kind} y ${b.kind} (${c.toFixed(1)} m) en ${a.x.toFixed(0)}, ${a.z.toFixed(0)}`)
      }
    }
  }
  if (staticBad) console.log(`   ¡quietos mal puestos: ${staticBad}!`)
  const sim = new MarineSim(5)
  sim.hour = hour
  sim.camera = { x: 0, z: 0 }
  sim.setRegion(reg, routes, null)
  const count0 = sim.vessels.length
  const dt = 0.1
  const steps = Math.round((minutes * 60) / dt)
  const pairs = new Map<string, string>()
  const onLand = new Map<number, string>()
  const statHits = new Map<string, string>()
  let maxN = 0
  let sumV = 0
  let nV = 0
  const desc = (v: Vessel) => (v.route ? `ferri ${v.len.toFixed(0)} m` : `${['vela', 'amarrado', 'yate', 'lancha', 'pesquero', 'turístico', 'gabarra', 'portacontenedores', 'petrolero', 'granelero'][v.kind]} ${v.len.toFixed(0)} m`)
  const tStep = performance.now()
  for (let k = 0; k < steps; k++) {
    sim.step(dt)
    const vs = sim.vessels
    maxN = Math.max(maxN, vs.length)
    for (let i = 0; i < vs.length; i++) {
      const a = vs[i]
      if (a.mode !== 2) {
        sumV += a.v
        nV++
      }
      for (let j = i + 1; j < vs.length; j++) {
        const b = vs[j]
        if (Math.abs(a.x - b.x) > 400 || Math.abs(a.z - b.z) > 400) continue
        const c = hullClear(a.x, a.z, a.h, a.len, a.beam, b.x, b.z, b.h, b.len, b.beam)
        if (c < -0.05) {
          const key = `${a.id}-${b.id}`
          const st = (v: Vessel) => (v.route ? `s ${v.s.toFixed(0)}/${v.route.len.toFixed(0)} dir ${v.dir} amarre ${v.dwell.toFixed(0)} ruta ${v.route.id}` : `modo ${v.mode}`)
          if (!pairs.has(key)) pairs.set(key, `${desc(a)} y ${desc(b)} a ${(k * dt).toFixed(1)} s (${c.toFixed(1)} m) en ${a.x.toFixed(0)}, ${a.z.toFixed(0)} [${st(a)}] [${st(b)}]`)
        }
      }
      if (!g || a.route || a.mode === 2) continue
      for (const t of [-0.45, 0, 0.45]) {
        const x = a.x + Math.cos(a.h) * a.len * t
        const z = a.z + Math.sin(a.h) * a.len * t
        if (g.idx(x, z) >= 0 && !g.inWater(x, z) && !onLand.has(a.id)) onLand.set(a.id, `${desc(a)} a ${(k * dt).toFixed(0)} s en ${x.toFixed(0)}, ${z.toFixed(0)} (t ${t}, modo ${a.mode}, apartándose ${a.avoid.toFixed(1)}, v ${a.v.toFixed(1)}, rejilla ${g.distAt(x, z).toFixed(1)} m, orilla ${g.edges.dist(x, z, 50).toFixed(1)} m)`)
      }
      for (const b of sim.statics) {
        if (Math.abs(a.x - b.x) > 300 || Math.abs(a.z - b.z) > 300) continue
        const c = hullClear(a.x, a.z, a.h, a.len, a.beam, b.x, b.z, b.h, b.len, b.len * BOATS[b.kind].beam)
        if (c < -0.05 && !(b.kind >= 7 && reg.anchored.some((v) => v.x === b.x && v.z === b.z))) {
          const key = `${a.id}-${b.x.toFixed(0)}`
          if (!statHits.has(key)) statHits.set(key, `${desc(a)} contra un quieto a ${(k * dt).toFixed(0)} s`)
        }
      }
    }
  }
  const ms = performance.now() - tStep
  const byKind = new Map<string, number>()
  for (const v of sim.vessels) byKind.set(desc(v).split(' ')[0], (byKind.get(desc(v).split(' ')[0]) ?? 0) + 1)
  const stuck = sim.vessels.filter((v) => v.stuck > 30).length
  console.log(`   barcos al empezar ${count0}, al final ${sim.vessels.length} (${JSON.stringify(Object.fromEntries(byKind))}), máx ${maxN}; velocidad media ${(sumV / Math.max(1, nV)).toFixed(1)} m/s`)
  console.log(`   ${minutes} min en ${(ms / 1000).toFixed(1)} s (${((ms / steps) * 1000).toFixed(0)} µs/paso); paradas de seguridad ${sim.counters.safetyStops}, caminos fallidos ${sim.counters.plansFailed}, nuevos ${sim.counters.spawned}, quitados ${sim.counters.removed}, atascados ${stuck}`)
  if (sim.counters.safetyStops) console.log('   paradas:', [...sim.whyLog.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} ×${n}`).join(' | '))
  if (sim.counters.safetyStops) console.log(`   paradas por tipo: ${JSON.stringify(Object.fromEntries(sim.counters.stopsByKind))}`)
  console.log(`   solapes ${pairs.size}, en tierra ${onLand.size}, contra quietos ${statHits.size}`)
  for (const t of [...pairs.values()].slice(0, 6)) console.log('     · ' + t)
  for (const t of [...onLand.values()].slice(0, 6)) console.log('     · tierra: ' + t)
  for (const t of [...statHits.values()].slice(0, 4)) console.log('     · ' + t)
  if (pairs.size || onLand.size || statHits.size || staticBad) failed = true
  if (svgPath && g) writeSvg(svgPath.replace('.svg', `-${name}.svg`), sim, reg)
}
process.exit(failed ? 1 : 0)

/** Dibujo: agua, barcos quietos y los que navegan con su camino. */
function writeSvg(path: string, sim: MarineSim, reg: Awaited<ReturnType<typeof buildMarine>>): void {
  const g = reg.grid!
  const W = g.nx * g.cell
  const H = g.nz * g.cell
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${g.x0} ${g.z0} ${W} ${H}" width="1600" height="${Math.round((1600 * H) / W)}"><rect x="${g.x0}" y="${g.z0}" width="${W}" height="${H}" fill="#d8d2c4"/>`]
  // agua por filas (tramos seguidos)
  for (let j = 0; j < g.nz; j++) {
    let i = 0
    while (i < g.nx) {
      const c = g.wat[j * g.nx + i]
      if (!c) {
        i++
        continue
      }
      let e = i
      while (e < g.nx && g.wat[j * g.nx + e] === c) e++
      out.push(`<rect x="${g.x0 + i * g.cell}" y="${g.z0 + j * g.cell}" width="${(e - i) * g.cell}" height="${g.cell + 0.5}" fill="${c === 1 ? '#7fa7c9' : c === 2 ? '#7fb5b8' : c === 3 ? '#8fb7d6' : '#6e98bd'}"/>`)
      i = e
    }
  }
  const e = g.edges.e
  for (let k = 0; k < e.length; k += 5) if (e[k + 4] === 1) out.push(`<line x1="${e[k]}" y1="${e[k + 1]}" x2="${e[k + 2]}" y2="${e[k + 3]}" stroke="#6b4f2a" stroke-width="2"/>`)
  const hull = (x: number, z: number, h: number, L: number, B: number, fill: string) => {
    const c = Math.cos(h)
    const s = Math.sin(h)
    const p = (a: number, b: number) => `${(x + c * a - s * b).toFixed(1)},${(z + s * a + c * b).toFixed(1)}`
    out.push(`<polygon points="${p(L / 2, 0)} ${p(L / 4, B / 2)} ${p(-L / 2, B / 2)} ${p(-L / 2, -B / 2)} ${p(L / 4, -B / 2)}" fill="${fill}" stroke="#222" stroke-width="0.3"/>`)
  }
  for (const b of reg.statics) hull(b.x, b.z, b.h, b.len, b.len * BOATS[b.kind].beam, b.kind >= 7 ? '#8a3b2a' : '#ffffff')
  for (const v of sim.vessels) {
    if (v.path) out.push(`<polyline points="${Array.from(v.path).join(' ')}" fill="none" stroke="#c0392b" stroke-width="3" stroke-dasharray="12 8"/>`)
    hull(v.x, v.z, v.h, Math.max(v.len, 25), Math.max(v.beam, 8), v.route ? '#f1c40f' : v.kind >= 7 ? '#e74c3c' : '#2ecc71')
  }
  for (const r of sim.routes) out.push(`<polyline points="${Array.from(r.x).map((x, i) => `${x},${r.z[i]}`).join(' ')}" fill="none" stroke="#f39c12" stroke-width="4"/>`)
  out.push('</svg>')
  writeFileSync(path, out.join('\n'))
  console.log('   dibujo:', path)
}
