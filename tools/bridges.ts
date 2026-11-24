// Puentes con estructura conocida de todo el mundo, para public/bridges.bin (formato en
// src/world/bridgeFormat.ts). Las teselas vectoriales traen el trazado de cada puente pero no
// de qué tipo es; aquí se piden a Wikidata los puentes colgantes, atirantados, de arco y de
// celosía con sus coordenadas y, si constan, su longitud, su vano mayor y su altura. El juego
// (src/world/Bridges.ts) casa cada registro con el puente de la tesela que pasa por ese punto.
//
//   node --experimental-strip-types tools/bridges.ts [out=public/bridges.bin]
//
// Tarda un par de minutos (una consulta por tipo al servicio SPARQL público de Wikidata).

import { writeFileSync } from 'node:fs'
import { zlibSync } from 'fflate'
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
  HEADER,
  MAGIC,
  RECORD,
  writeRecord,
  type BridgeRecord,
} from '../src/world/bridgeFormat.ts'

const outArg = process.argv.find((a) => a.startsWith('out='))
const OUT = outArg ? outArg.slice(4) : 'public/bridges.bin'
const SPARQL = 'https://query.wikidata.org/sparql'

/** clase de Wikidata → tipo y prioridad (si un puente es de varias clases gana la mayor; 0 = descartar) */
const ROOTS: Array<{ q: string; name: string; type: number; prio: number }> = [
  { q: 'Q3916505', name: 'pasarela colgante simple', type: 0, prio: 100 },
  { q: 'Q11486300', name: 'puente desaparecido', type: 0, prio: 100 },
  { q: 'Q12570', name: 'colgante', type: BRIDGE_SUSPENSION, prio: 90 },
  { q: 'Q1385169', name: 'extradosado', type: BRIDGE_EXTRADOSED, prio: 86 },
  { q: 'Q158555', name: 'atirantado', type: BRIDGE_CABLE_STAYED, prio: 85 },
  { q: 'Q1429218', name: 'en ménsula', type: BRIDGE_CANTILEVER, prio: 70 },
  { q: 'Q158218', name: 'de celosía', type: BRIDGE_TRUSS, prio: 60 },
  { q: 'Q5592057', name: 'arco de tablero inferior', type: BRIDGE_ARCH_THROUGH, prio: 55 },
  { q: 'Q818882', name: 'arco atirantado', type: BRIDGE_ARCH_THROUGH, prio: 55 },
  { q: 'Q1704122', name: 'arco de péndolas en red', type: BRIDGE_ARCH_THROUGH, prio: 55 },
  { q: 'Q14276458', name: 'arco de tablero superior', type: BRIDGE_ARCH_DECK, prio: 54 },
  { q: 'Q18449828', name: 'arco de piedra', type: BRIDGE_ARCH_STONE, prio: 50 },
  { q: 'Q1223230', name: 'romano', type: BRIDGE_ARCH_STONE, prio: 45 },
  { q: 'Q158438', name: 'de arco', type: BRIDGE_ARCH, prio: 40 },
  { q: 'Q3397526', name: 'de piedra', type: BRIDGE_ARCH_STONE, prio: 30 },
  { q: 'Q7123018', name: 'de herradura', type: BRIDGE_ARCH_STONE, prio: 30 },
]

/** color de la estructura de algunos puentes muy conocidos (por su nombre en inglés) */
const COLOURS: Array<[RegExp, number]> = [
  [/^Golden Gate Bridge$/, 0xc0362c],
  [/^Forth Bridge$/, 0x8f2d24],
  [/^25 de Abril Bridge$/, 0xb5412f],
  [/^Hell Gate Bridge$/, 0x7a2f2a],
  [/^New River Gorge Bridge$/, 0x6b4a3a],
  [/^Sydney Harbour Bridge$/, 0x6f7a80],
  [/^Brooklyn Bridge$/, 0x9b8f80],
  [/^Manhattan Bridge$/, 0x4d6377],
  [/^Mackinac Bridge$/, 0xe6dfcc],
  [/^Clifton Suspension Bridge$/, 0xa59682],
  [/^Alamillo Bridge$/, 0xe8e6e0],
  [/^Dom Lu[ií]s I Bridge$/, 0x70777d],
  [/^Tower Bridge$/, 0xa39a8c],
]

/** atirantados de varios vanos iguales: número de pilonos (lo normal son dos y viaductos de acceso) */
const TOWERS: Array<[RegExp, number]> = [
  [/^Millau Viaduct$/, 7],
  [/^Rio[–-]Antirrio [Bb]ridge$/, 4],
  [/^Queensferry Crossing$/, 3],
  [/^Ting Kau Bridge$/, 3],
  [/^Mezcala Bridge$/, 3],
  [/^Jiaxing-Shaoxing Sea Bridge$/, 6],
]

interface Row {
  q: string
  label: string
  lat: number
  lon: number
  len: number
  span: number
  height: number
  type: number
  prio: number
  gone: boolean
}

async function query(root: string): Promise<Array<Record<string, { value: string }>>> {
  // psn: = valor normalizado a unidades SI (metros), venga como venga
  const q = `SELECT ?b ?bLabel ?lat ?lon ?len ?span ?h ?gone WHERE {
  ?b wdt:P31/wdt:P279* wd:${root} ; p:P625/psv:P625 ?c .
  ?c wikibase:geoLatitude ?lat ; wikibase:geoLongitude ?lon ; wikibase:geoGlobe wd:Q2 .
  OPTIONAL { ?b p:P2043/psn:P2043/wikibase:quantityAmount ?len }
  OPTIONAL { ?b p:P2787/psn:P2787/wikibase:quantityAmount ?span }
  OPTIONAL { ?b p:P2048/psn:P2048/wikibase:quantityAmount ?h }
  OPTIONAL { ?b wdt:P576 ?gone }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,es,fr,de,it,pt". }
}`
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const r = await fetch(`${SPARQL}?query=${encodeURIComponent(q)}`, {
        headers: { Accept: 'application/sparql-results+json', 'User-Agent': 'bridge-structure-harvester/1.0' },
        signal: AbortSignal.timeout(120_000),
      })
      if (r.ok) return ((await r.json()) as { results: { bindings: Array<Record<string, { value: string }>> } }).results.bindings
      console.log(`  HTTP ${r.status}`)
    } catch (e) {
      console.log(`  ${(e as Error).message}`)
    }
    await new Promise((res) => setTimeout(res, 15000 * (attempt + 1)))
  }
  throw new Error(`Wikidata no responde (${root})`)
}

const rows = new Map<string, Row>()
for (const root of ROOTS) {
  const res = await query(root.q)
  let fresh = 0
  for (const b of res) {
    const q = b.b.value.replace(/^.*\//, '')
    const lat = Number(b.lat?.value)
    const lon = Number(b.lon?.value)
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85) continue
    const num = (v: { value: string } | undefined, max: number) => {
      const n = Number(v?.value)
      return Number.isFinite(n) && n > 0 && n <= max ? n : 0
    }
    let row = rows.get(q)
    if (!row) {
      row = { q, label: b.bLabel?.value ?? q, lat, lon, len: 0, span: 0, height: 0, type: 0, prio: -1, gone: false }
      rows.set(q, row)
      fresh++
    }
    // varias declaraciones del mismo dato: la mayor que sea creíble
    row.len = Math.max(row.len, num(b.len, 60000))
    row.span = Math.max(row.span, num(b.span, 2500))
    row.height = Math.max(row.height, num(b.h, 400))
    if (b.gone) row.gone = true
    if (root.prio > row.prio) {
      row.prio = root.prio
      row.type = root.type
    }
  }
  console.log(`${root.name.padEnd(28)} ${String(res.length).padStart(6)} filas, ${fresh} puentes nuevos`)
  await new Promise((res) => setTimeout(res, 1500))
}

const n14 = 2 ** 14
const tileOf = (r: BridgeRecord) => {
  const tx = Math.floor(((r.lon + 180) / 360) * n14)
  const ty = Math.floor(((1 - Math.asinh(Math.tan((r.lat * Math.PI) / 180)) / Math.PI) / 2) * n14)
  return ty * n14 + tx
}
const recs: BridgeRecord[] = []
const perType = new Map<number, number>()
for (const row of rows.values()) {
  if (row.type === 0 || row.gone) continue
  // el vano no puede ser mayor que el puente
  if (row.len > 0 && row.span > row.len * 1.02) row.span = 0
  let colour = 0
  for (const [re, c] of COLOURS) if (re.test(row.label)) colour = c
  let towers = 0
  for (const [re, n] of TOWERS) if (re.test(row.label)) towers = n
  recs.push({ lat: row.lat, lon: row.lon, length: row.len, span: row.span, height: row.height, type: row.type, colour, towers })
  perType.set(row.type, (perType.get(row.type) ?? 0) + 1)
}
recs.sort((a, b) => tileOf(a) - tileOf(b))

const buf = new Uint8Array(HEADER + recs.length * RECORD)
const dv = new DataView(buf.buffer)
for (let i = 0; i < 4; i++) buf[i] = MAGIC.charCodeAt(i)
dv.setUint32(4, recs.length, true)
const d = new Date()
dv.setUint32(8, d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate(), true)
recs.forEach((r, i) => writeRecord(dv, i, r))
const packed = zlibSync(buf, { level: 9 })
writeFileSync(OUT, packed)

const names: Record<number, string> = {
  [BRIDGE_SUSPENSION]: 'colgantes',
  [BRIDGE_CABLE_STAYED]: 'atirantados',
  [BRIDGE_EXTRADOSED]: 'extradosados',
  [BRIDGE_ARCH]: 'de arco',
  [BRIDGE_ARCH_DECK]: 'arco bajo el tablero',
  [BRIDGE_ARCH_THROUGH]: 'arco sobre el tablero',
  [BRIDGE_ARCH_STONE]: 'de piedra',
  [BRIDGE_TRUSS]: 'de celosía',
  [BRIDGE_CANTILEVER]: 'en ménsula',
}
for (const [t, c] of [...perType].sort((a, b) => b[1] - a[1])) console.log(`  ${String(c).padStart(6)} ${names[t]}`)
const withLen = recs.filter((r) => r.length > 0).length
const withSpan = recs.filter((r) => r.span > 0).length
console.log(`${OUT}: ${recs.length} puentes (${withLen} con longitud, ${withSpan} con vano) · ${(packed.length / 1024).toFixed(0)} kB`)
