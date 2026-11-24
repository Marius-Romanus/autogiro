// Genera src/traffic/lhtData.ts: contornos simplificados de los países y territorios donde se
// circula por la izquierda, de Natural Earth (dominio público, admin 0 a escala 1:10 M).
//
//   node --experimental-strip-types tools/drive-side.ts

import { writeFileSync } from 'node:fs'

const URL_NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson'

// ADM0_A3 de Natural Earth
const LHT = new Set(
  'GBR IRL IMN GGY JEY MLT CYP IND PAK BGD LKA NPL BTN THA MYS SGP BRN IDN TLS JPN HKG MAC AUS NZL PNG FJI SLB WSM TON KIR TUV NRU ZAF LSO SWZ NAM BWA ZWE ZMB MOZ MWI TZA KEN UGA MUS SYC SUR GUY JAM TTO BRB BHS ATG KNA LCA VCT GRD DMA CYM VGB VIR AIA MSR BMU TCA FLK SHN MDV COK NIU PCN NFK'.split(' '),
)

const r = await fetch(URL_NE)
if (!r.ok) throw new Error(`HTTP ${r.status}`)
const gj = (await r.json()) as { features: Array<{ properties: Record<string, unknown>; geometry: { type: string; coordinates: any } }> }

const polys: number[][] = []
const found = new Set<string>()
for (const f of gj.features) {
  const code = String(f.properties.ADM0_A3 ?? f.properties.ISO_A3)
  if (!LHT.has(code)) continue
  found.add(code)
  const g = f.geometry
  const list: number[][][][] = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []
  for (const poly of list) {
    const ring = poly[0] as number[][]
    // anillo cerrado: se parte por el punto más lejano al primero
    let far = 0
    let fd = -1
    for (let i = 0; i < ring.length; i++) {
      const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1])
      if (d > fd) {
        fd = d
        far = i
      }
    }
    const simp = far > 0 ? [...dp(ring.slice(0, far + 1), 0.004), ...dp(ring.slice(far), 0.004).slice(1, -1)] : []
    if (simp.length < 4) {
      // islas pequeñas: un cuadrado alrededor
      let x0 = Infinity
      let y0 = Infinity
      let x1 = -Infinity
      let y1 = -Infinity
      for (const [x, y] of ring) {
        x0 = Math.min(x0, x)
        y0 = Math.min(y0, y)
        x1 = Math.max(x1, x)
        y1 = Math.max(y1, y)
      }
      polys.push([x0 - 0.02, y0 - 0.02, x1 + 0.02, y0 - 0.02, x1 + 0.02, y1 + 0.02, x0 - 0.02, y1 + 0.02].map(round))
      continue
    }
    polys.push(simp.flat().map(round))
  }
}
const missing = [...LHT].filter((c) => !found.has(c))
console.log(`${found.size} territorios, ${polys.length} polígonos, ${polys.reduce((s, p) => s + p.length / 2, 0)} vértices; sin datos: ${missing.join(' ')}`)
writeFileSync(
  'src/traffic/lhtData.ts',
  `// Generado por tools/drive-side.ts (Natural Earth, dominio público): países y territorios donde se\n// circula por la izquierda, polígonos [lon, lat, lon, lat…] simplificados (~400 m).\n\nexport const LHT_POLYS: number[][] = ${JSON.stringify(polys)}\n`,
)

function round(v: number): number {
  return Math.round(v * 1000) / 1000
}

function dp(pts: number[][], eps: number): number[][] {
  if (pts.length < 3) return pts
  const keep = new Uint8Array(pts.length)
  keep[0] = 1
  keep[pts.length - 1] = 1
  const stack: Array<[number, number]> = [[0, pts.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()!
    let best = -1
    let bd = eps
    const [ax, ay] = pts[a]
    const [bx, by] = pts[b]
    const dx = bx - ax
    const dy = by - ay
    const l = Math.hypot(dx, dy) || 1e-9
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / l
      if (d > bd) {
        bd = d
        best = i
      }
    }
    if (best >= 0) {
      keep[best] = 1
      stack.push([a, best], [best, b])
    }
  }
  return pts.filter((_, i) => keep[i])
}
