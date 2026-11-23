// Lista de aeródromos del mundo para el mapa del menú (src/menu/WorldMap.ts), sacada de
// OurAirports (https://ourairports.com/data/, dominio público).
//
//   curl -L -o airports.csv https://davidmegginson.github.io/ourairports-data/airports.csv
//   node --experimental-strip-types tools/airports.ts airports.csv
//
// Escribe public/airports.tsv: una línea por aeródromo abierto (grandes, medianos y
// pequeños; sin helipuertos, hidrobases ni cerrados), ordenados de más a menos importante:
//   tipo(L|M|S) \t código \t IATA \t lat \t lon \t elevación (m) \t nombre \t municipio \t país

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const src = process.argv[2]
if (!src) {
  console.error('uso: airports.ts <airports.csv>')
  process.exit(1)
}

/** Analizador CSV (RFC 4180): comillas dobles, comas y saltos de línea dentro de campos. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      field = ''
      rows.push(row)
      row = []
    } else field += ch
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

const rows = parseCsv(readFileSync(src, 'utf8'))
const head = rows.shift()!
const col = (name: string) => {
  const i = head.indexOf(name)
  if (i < 0) throw new Error(`falta la columna ${name}`)
  return i
}
const C = {
  ident: col('ident'),
  type: col('type'),
  name: col('name'),
  lat: col('latitude_deg'),
  lon: col('longitude_deg'),
  elev: col('elevation_ft'),
  country: col('iso_country'),
  muni: col('municipality'),
  icao: col('icao_code'),
  iata: col('iata_code'),
  gps: col('gps_code'),
}
const TYPES: Record<string, string> = { large_airport: 'L', medium_airport: 'M', small_airport: 'S' }
const ORDER: Record<string, number> = { L: 0, M: 1, S: 2 }
const clean = (s: string | undefined) => (s ?? '').replace(/[\t\r\n]+/g, ' ').trim()

type Out = { t: string; line: string }
const out: Out[] = []
for (const r of rows) {
  const t = TYPES[r[C.type]]
  if (!t) continue
  const lat = Number(r[C.lat])
  const lon = Number(r[C.lon])
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
  const ident = clean(r[C.ident])
  // código OACI si lo tiene (en OurAirports puede estar en icao_code, ident o gps_code)
  const code = clean(r[C.icao]) || (/^[A-Z]{4}$/.test(ident) ? ident : '') || (/^[A-Z]{4}$/.test(clean(r[C.gps])) ? clean(r[C.gps]) : '') || ident
  const ft = Number(r[C.elev])
  const elev = r[C.elev] !== '' && Number.isFinite(ft) ? String(Math.round(ft * 0.3048)) : ''
  out.push({
    t,
    line: [t, code, clean(r[C.iata]), lat.toFixed(4), lon.toFixed(4), elev, clean(r[C.name]), clean(r[C.muni]), clean(r[C.country])].join('\t'),
  })
}
out.sort((a, b) => ORDER[a.t] - ORDER[b.t])

const dst = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'airports.tsv')
writeFileSync(dst, out.map((o) => o.line).join('\n') + '\n')
const count = (t: string) => out.filter((o) => o.t === t).length
console.log(`${dst}: ${out.length} aeródromos (${count('L')} grandes, ${count('M')} medianos, ${count('S')} pequeños)`)
