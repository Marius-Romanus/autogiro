// Pistas de OpenStreetMap (capa aeroway de OpenFreeMap, la misma que usa src/world/Runways.ts)
// alrededor de unas coordenadas: extremos del eje, longitud, rumbo verdadero y el punto de
// salida 15 m dentro de cada extremo, para escribir las ubicaciones de src/config.ts.
//
//   node --experimental-strip-types tools/runway-info.ts 40.4936 -3.5668 [radio_km]

import { VectorTile } from '@mapbox/vector-tile'
import { PbfReader } from 'pbf'

const DEG = Math.PI / 180
const Z = 14
const lat = Number(process.argv[2])
const lon = Number(process.argv[3])
const radiusKm = Number(process.argv[4] ?? 3)
if (!isFinite(lat) || !isFinite(lon)) {
  console.error('uso: runway-info.ts <lat> <lon> [radio_km]')
  process.exit(1)
}

const n = 2 ** Z
const lonToX = (lo: number) => ((lo + 180) / 360) * n
const latToY = (la: number) => {
  const r = la * DEG
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n
}
const xToLon = (x: number) => (x / n) * 360 - 180
const yToLat = (y: number) => Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) / DEG

const tpl = ((await (await fetch('https://tiles.openfreemap.org/planet')).json()) as { tiles: string[] }).tiles[0]
const tileKm = (40075 * Math.cos(lat * DEG)) / n
const r = Math.ceil(radiusKm / tileKm)
const cx = Math.floor(lonToX(lon))
const cy = Math.floor(latToY(lat))

type Piece = { ref: string; pts: Array<[number, number]> }
const pieces: Piece[] = []
for (let y = cy - r; y <= cy + r; y++) {
  for (let x = cx - r; x <= cx + r; x++) {
    const url = tpl.replace('{z}', String(Z)).replace('{x}', String(x)).replace('{y}', String(y))
    const res = await fetch(url)
    if (!res.ok) continue
    const vt = new VectorTile(new PbfReader(new Uint8Array(await res.arrayBuffer())))
    const layer = vt.layers.aeroway
    if (!layer) continue
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i)
      if (f.type !== 2 || f.properties.class !== 'runway') continue
      for (const line of f.loadGeometry()) {
        if (line.length < 2) continue
        pieces.push({
          ref: String(f.properties.ref ?? ''),
          pts: line.map((p): [number, number] => [yToLat(y + p.y / layer.extent), xToLon(x + p.x / layer.extent)]),
        })
      }
    }
  }
}

// unir los trozos de cada pista (mismo criterio que clusterPieces en Runways.ts)
const mLat = 111132
type Cl = { ref: string; lat0: number; lon0: number; mLon: number; ux: number; uy: number; pts: Array<[number, number]> }
const cls: Cl[] = []
for (const p of pieces) {
  const [la0, lo0] = p.pts[0]
  const [la1, lo1] = p.pts[p.pts.length - 1]
  const mLon = mLat * Math.cos(la0 * DEG)
  const ex = (lo1 - lo0) * mLon
  const ny = (la1 - la0) * mLat
  const l = Math.hypot(ex, ny)
  if (l < 1) continue
  const ux = ex / l
  const uy = ny / l
  const c = cls.find((c) => {
    if (c.ref !== p.ref || Math.abs(c.ux * uy - c.uy * ux) > 0.07) return false
    for (const [la, lo] of [p.pts[0], p.pts[p.pts.length - 1]]) {
      const e = (lo - c.lon0) * c.mLon
      const nn = (la - c.lat0) * mLat
      if (Math.abs(e * c.uy - nn * c.ux) > 25) return false
    }
    return true
  })
  if (c) c.pts.push(...p.pts)
  else cls.push({ ref: p.ref, lat0: la0, lon0: lo0, mLon, ux, uy, pts: [...p.pts] })
}

for (const c of cls) {
  let sMin = Infinity
  let sMax = -Infinity
  let a = c.pts[0]
  let b = c.pts[0]
  for (const pt of c.pts) {
    const s = (pt[1] - c.lon0) * c.mLon * c.ux + (pt[0] - c.lat0) * mLat * c.uy
    if (s < sMin) [sMin, a] = [s, pt]
    if (s > sMax) [sMax, b] = [s, pt]
  }
  const mLon = mLat * Math.cos(((a[0] + b[0]) / 2) * DEG)
  const e = (b[1] - a[1]) * mLon
  const nn = (b[0] - a[0]) * mLat
  const len = Math.hypot(e, nn)
  const hdg = (Math.atan2(e, nn) / DEG + 360) % 360
  const inset = (from: [number, number], dir: number): string => {
    const la = from[0] + (dir * 15 * nn) / len / mLat
    const lo = from[1] + (dir * 15 * e) / len / mLon
    return `${la.toFixed(6)}, ${lo.toFixed(6)}`
  }
  console.log(
    `${c.ref.padEnd(9)} ${Math.round(len)} m  A ${a[0].toFixed(7)}, ${a[1].toFixed(7)} → B ${b[0].toFixed(7)}, ${b[1].toFixed(7)}\n` +
      `          salida desde A: ${inset(a, 1)} rumbo ${hdg.toFixed(2)}°\n` +
      `          salida desde B: ${inset(b, -1)} rumbo ${((hdg + 180) % 360).toFixed(2)}°`,
  )
}
