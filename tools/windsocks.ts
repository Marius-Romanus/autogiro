// Mangas de viento de OpenStreetMap (aeroway=windsock) → public/windsocks.bin para el juego
// (src/world/Windsocks.ts). Las teselas de OpenFreeMap no las traen (la capa aeroway solo tiene
// pistas, calles de rodaje, plataformas y el recinto), así que se piden una vez a Overpass: son
// unas 11 400 en todo el mundo (noviembre de 2026), una sola consulta.
//
//   node --experimental-strip-types tools/windsocks.ts [entrada.json]
//
// Con un .json (respuesta de Overpass guardada) no se consulta nada. Tarda un minuto.

import { readFileSync, writeFileSync } from 'node:fs'
import { zlibSync } from 'fflate'
import { HEADER, MAGIC, RECORD, writeWindsock, type WindsockRecord } from '../src/world/windsockFormat.ts'

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
]
const QUERY = '[out:json][timeout:300];node["aeroway"="windsock"];out;'

interface OsmNode {
  type: string
  id: number
  lat: number
  lon: number
  tags?: Record<string, string>
}

async function download(): Promise<OsmNode[]> {
  for (const url of MIRRORS) {
    try {
      console.log('consultando', url)
      const r = await fetch(url, {
        method: 'POST',
        body: new URLSearchParams({ data: QUERY }),
        headers: { 'User-Agent': 'autogiro-tools (windsocks, one-off)' },
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j = (await r.json()) as { elements: OsmNode[] }
      return j.elements
    } catch (e) {
      console.warn('  falló:', (e as Error).message)
    }
  }
  throw new Error('ningún servidor de Overpass respondió')
}

/** ¿Iluminada? 1 sí, 0 no, -1 sin dato (lit, windsock:lit, light). */
function litOf(t: Record<string, string>): number {
  for (const k of ['lit', 'windsock:lit', 'light', 'illuminated']) {
    const v = t[k]?.toLowerCase()
    if (!v) continue
    if (['yes', 'true', '1', 'internal', 'external', 'floodlight', 'automatic', 'interval'].includes(v)) return 1
    if (['no', 'false', '0', 'none'].includes(v)) return 0
  }
  return -1
}

const input = process.argv[2]
const nodes: OsmNode[] = input ? (JSON.parse(readFileSync(input, 'utf8')) as { elements: OsmNode[] }).elements : await download()
const recs: WindsockRecord[] = []
const tagCount = new Map<string, number>()
let lit = 0
let unlit = 0
for (const n of nodes) {
  if (n.type !== 'node' || !Number.isFinite(n.lat) || !Number.isFinite(n.lon)) continue
  const t = n.tags ?? {}
  for (const k of Object.keys(t)) tagCount.set(k, (tagCount.get(k) ?? 0) + 1)
  const l = litOf(t)
  if (l === 1) lit++
  if (l === 0) unlit++
  recs.push({ lat: n.lat, lon: n.lon, lit: l })
}
// por latitud: el juego busca por franjas
recs.sort((a, b) => a.lat - b.lat || a.lon - b.lon)
const buf = new ArrayBuffer(HEADER + recs.length * RECORD)
const dv = new DataView(buf)
for (let i = 0; i < 4; i++) dv.setUint8(i, MAGIC.charCodeAt(i))
dv.setUint32(4, recs.length, true)
const d = new Date()
dv.setUint32(8, d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate(), true)
recs.forEach((r, i) => writeWindsock(dv, i, r))
const out = zlibSync(new Uint8Array(buf), { level: 9 })
writeFileSync('public/windsocks.bin', out)
console.log(`${recs.length} mangas (${lit} iluminadas, ${unlit} sin luz, el resto sin dato) → public/windsocks.bin (${(out.length / 1024).toFixed(0)} kB)`)
console.log(
  'etiquetas más comunes:',
  [...tagCount]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([k, v]) => `${k} ${v}`)
    .join(', '),
)
