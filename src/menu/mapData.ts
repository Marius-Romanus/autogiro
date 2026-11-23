// Datos del mapa del mundo del menú (WorldMap.ts): aeródromos de OurAirports, pistas de
// OpenStreetMap alrededor de un punto, elevación aproximada, búsqueda de lugares y
// lectura de coordenadas escritas a mano.

import { fetchVectorTile, latToY, lonToX, xToLon, yToLat } from '../world/mapTiles.ts'

const DEG = Math.PI / 180

// ---------------------------------------------------------------------------
// Aeródromos (public/airports.tsv, generado con tools/airports.ts)
// ---------------------------------------------------------------------------

/** L = aeropuerto grande, M = mediano, S = aeródromo pequeño. */
export type AirportKind = 'L' | 'M' | 'S'

export interface Airport {
  kind: AirportKind
  /** OACI si lo tiene; si no, el identificador de OurAirports (p. ej. ES-0209) */
  code: string
  iata: string
  lat: number
  lon: number
  /** elevación (m), null si no se conoce */
  elev: number | null
  name: string
  city: string
  country: string
  /** texto normalizado para buscar (minúsculas, sin acentos) */
  key: string
}

/** ¿Es un código OACI de verdad (y no un identificador local de OurAirports)? */
export function isIcao(code: string): boolean {
  return /^[A-Z0-9]{4}$/.test(code)
}

export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
}

let airports: Promise<Airport[]> | null = null

export function loadAirports(): Promise<Airport[]> {
  airports ??= fetch(`${import.meta.env.BASE_URL}airports.tsv`)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.text()
    })
    .then((txt) => {
      const out: Airport[] = []
      for (const line of txt.split('\n')) {
        const f = line.split('\t')
        if (f.length < 9) continue
        const lat = Number(f[3])
        const lon = Number(f[4])
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
        out.push({
          kind: f[0] as AirportKind,
          code: f[1],
          iata: f[2],
          lat,
          lon,
          elev: f[5] === '' ? null : Number(f[5]),
          name: f[6],
          city: f[7],
          country: f[8],
          key: normalize(`${f[1]} ${f[2]} ${f[6]} ${f[7]}`),
        })
      }
      return out
    })
    .catch((e) => {
      airports = null // reintentar la próxima vez
      throw e
    })
  return airports
}

/** Distancia aproximada (m) entre dos puntos cercanos. */
export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const x = (lon2 - lon1) * Math.cos(((lat1 + lat2) / 2) * DEG) * 111320
  const y = (lat2 - lat1) * 110574
  return Math.hypot(x, y)
}

/** Distancia ortodrómica (m), válida a cualquier distancia. */
export function greatCircleM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const a =
    Math.sin(((lat2 - lat1) * DEG) / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(((lon2 - lon1) * DEG) / 2) ** 2
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(a)))
}

// ---------------------------------------------------------------------------
// Pistas de OpenStreetMap (capa aeroway de OpenFreeMap, como src/world/Runways.ts)
// ---------------------------------------------------------------------------

export interface RunwayEnd {
  /** designador de la cabecera (08, 26L…) */
  name: string
  /** punto de salida, 15 m dentro del extremo (como las salidas de src/config.ts) */
  lat: number
  lon: number
  /** rumbo verdadero de despegue (grados) */
  heading: number
}

export interface MapRunway {
  ref: string
  length: number
  ends: [RunwayEnd, RunwayEnd]
  /** distancia del centro de la pista al punto buscado (m) */
  dist: number
}

/** A z13 (≈ 3,7 km de tesela en España) las pistas ya vienen con su geometría completa. */
const RUNWAY_Z = 13
const M_LAT = 111132

type Piece = { ref: string; pts: Array<[number, number]> }

function runwayPieces(vt: { layers: Record<string, any> }, x: number, y: number, z: number): Piece[] {
  const layer = vt.layers.aeroway
  const out: Piece[] = []
  if (!layer) return out
  const n = 2 ** z
  const E = layer.extent
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i)
    if (f.type !== 2 || f.properties.class !== 'runway') continue
    for (const line of f.loadGeometry() as Array<Array<{ x: number; y: number }>>) {
      if (line.length < 2) continue
      out.push({
        ref: String(f.properties.ref ?? ''),
        pts: line.map((p): [number, number] => [yToLat(y + p.y / E, n), xToLon(x + p.x / E, n)]),
      })
    }
  }
  return out
}

/** Une los trozos de cada pista (mismo criterio que clusterPieces en Runways.ts). */
function clusterPieces(pieces: Piece[]): Array<{ ref: string; a: [number, number]; b: [number, number] }> {
  type Cl = { ref: string; lat0: number; lon0: number; mLon: number; ux: number; uy: number; pts: Array<[number, number]> }
  const cls: Cl[] = []
  for (const p of pieces) {
    const [la0, lo0] = p.pts[0]
    const [la1, lo1] = p.pts[p.pts.length - 1]
    const mLon = M_LAT * Math.cos(la0 * DEG)
    const ex = (lo1 - lo0) * mLon
    const ny = (la1 - la0) * M_LAT
    const l = Math.hypot(ex, ny)
    if (l < 1) continue
    const ux = ex / l
    const uy = ny / l
    const c = cls.find((c) => {
      if (c.ref !== p.ref || Math.abs(c.ux * uy - c.uy * ux) > 0.07) return false
      for (const [la, lo] of [p.pts[0], p.pts[p.pts.length - 1]]) {
        const e = (lo - c.lon0) * c.mLon
        const nn = (la - c.lat0) * M_LAT
        if (Math.abs(e * c.uy - nn * c.ux) > 25) return false
      }
      return true
    })
    if (c) c.pts.push(...p.pts)
    else cls.push({ ref: p.ref, lat0: la0, lon0: lo0, mLon, ux, uy, pts: [...p.pts] })
  }
  return cls.map((c) => {
    let sMin = Infinity
    let sMax = -Infinity
    let a = c.pts[0]
    let b = c.pts[0]
    for (const pt of c.pts) {
      const s = (pt[1] - c.lon0) * c.mLon * c.ux + (pt[0] - c.lat0) * M_LAT * c.uy
      if (s < sMin) [sMin, a] = [s, pt]
      if (s > sMax) [sMax, b] = [s, pt]
    }
    return { ref: c.ref, a, b }
  })
}

/** Diferencia angular (grados, 0…180). */
function angDiff(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 360) % 360)
  return d > 180 ? 360 - d : d
}

/** Designador por rumbo (verdadero; la declinación puede moverlo uno arriba o abajo). */
function designator(hdg: number): string {
  const n = Math.round(hdg / 10) % 36
  return String(n === 0 ? 36 : n).padStart(2, '0')
}

/** Nombre de cada cabecera: del ref de OSM («08/26») si casa con el rumbo; si no, por rumbo. */
function endNames(ref: string, hdgAB: number): [string, string] {
  const parts = ref
    .split('/')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^\d{1,2}[LCR]?$/.test(s))
  const num = (s: string) => Number(s.replace(/[LCR]/, '')) * 10
  if (parts.length === 2) {
    const [p, q] = parts
    if (angDiff(num(p), hdgAB) <= angDiff(num(q), hdgAB)) return [p.padStart(2, '0'), q.padStart(2, '0')]
    return [q.padStart(2, '0'), p.padStart(2, '0')]
  }
  return [designator(hdgAB), designator((hdgAB + 180) % 360)]
}

/**
 * Pistas a menos de `radius` metros de un punto (ordenadas por distancia), con el punto
 * de salida y el rumbo de cada cabecera.
 */
export async function findRunways(lat: number, lon: number, radius: number, signal: AbortSignal): Promise<MapRunway[]> {
  const n = 2 ** RUNWAY_Z
  const dLat = radius / M_LAT
  const dLon = radius / (M_LAT * Math.cos(lat * DEG))
  const x0 = Math.floor(lonToX(lon - dLon, n))
  const x1 = Math.floor(lonToX(lon + dLon, n))
  const y0 = Math.floor(latToY(Math.min(85, lat + dLat), n))
  const y1 = Math.floor(latToY(Math.max(-85, lat - dLat), n))
  const jobs: Array<Promise<Piece[]>> = []
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const xx = ((x % n) + n) % n
      jobs.push(
        fetchVectorTile(xx, y, signal, RUNWAY_Z)
          .then((vt) => runwayPieces(vt as any, xx, y, RUNWAY_Z))
          .catch((e) => {
            if (signal.aborted) throw e
            return [] // tesela sin datos (mar, fuera de cobertura)
          }),
      )
    }
  }
  const pieces = (await Promise.all(jobs)).flat()
  const out: MapRunway[] = []
  for (const { ref, a, b } of clusterPieces(pieces)) {
    const mLon = M_LAT * Math.cos(((a[0] + b[0]) / 2) * DEG)
    const e = (b[1] - a[1]) * mLon
    const nn = (b[0] - a[0]) * M_LAT
    const len = Math.hypot(e, nn)
    if (len < 60) continue
    const hdg = (Math.atan2(e, nn) / DEG + 360) % 360
    const inset = (from: [number, number], dir: number): [number, number] => [
      from[0] + (dir * 15 * nn) / len / M_LAT,
      from[1] + (dir * 15 * e) / len / mLon,
    ]
    const dist = distanceM(lat, lon, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
    // la pista cuenta si algún punto de su eje queda dentro del radio
    const cx = (lon - a[1]) * mLon
    const cy = (lat - a[0]) * M_LAT
    const tt = Math.max(0, Math.min(1, (cx * e + cy * nn) / (len * len)))
    const axisDist = Math.hypot(cx - tt * e, cy - tt * nn)
    if (axisDist > radius) continue
    const [na, nb] = endNames(ref, hdg)
    const pa = inset(a, 1)
    const pb = inset(b, -1)
    out.push({
      ref: ref || `${na}/${nb}`,
      length: len,
      dist,
      ends: [
        { name: na, lat: pa[0], lon: pa[1], heading: hdg },
        { name: nb, lat: pb[0], lon: pb[1], heading: (hdg + 180) % 360 },
      ],
    })
  }
  // las pistas largas primero si están a una distancia parecida
  out.sort((p, q) => p.dist - p.length * 0.2 - (q.dist - q.length * 0.2))
  // fuera trozos sueltos (marcas, < 150 m) y prolongaciones dibujadas como otra pista en
  // línea con una más larga (zonas de parada, ampliaciones de cabecera); las paralelas
  // (hierba junto al asfalto) se quedan
  return out.filter(
    (r, i) =>
      r.length >= 150 &&
      !out.some((o) => o !== r && o.length > r.length * 1.2 && inLineWith(o, r)) &&
      !out.slice(0, i).some((o) => distanceM(o.ends[0].lat, o.ends[0].lon, r.ends[0].lat, r.ends[0].lon) < 20),
  )
}

/** ¿Está `r` en la prolongación de `o` (misma recta, pegada o solapada)? */
function inLineWith(o: MapRunway, r: MapRunway): boolean {
  if (angDiff(o.ends[0].heading % 180, r.ends[0].heading % 180) > 4 && angDiff(o.ends[0].heading % 180, r.ends[0].heading % 180) < 176)
    return false
  const [a, b] = o.ends
  const mLon = M_LAT * Math.cos(a.lat * DEG)
  const ex = (b.lon - a.lon) * mLon
  const ny = (b.lat - a.lat) * M_LAT
  const len = Math.hypot(ex, ny)
  const ux = ex / len
  const uy = ny / len
  let sMin = Infinity
  let sMax = -Infinity
  for (const p of r.ends) {
    const e = (p.lon - a.lon) * mLon
    const n = (p.lat - a.lat) * M_LAT
    if (Math.abs(e * uy - n * ux) > 30) return false // fuera del eje
    const s = e * ux + n * uy
    sMin = Math.min(sMin, s)
    sMax = Math.max(sMax, s)
  }
  return sMax > -200 && sMin < len + 200 // solapada o a menos de 200 m de un extremo
}

// ---------------------------------------------------------------------------
// ¿Agua? (mar, lago, río ancho): polígonos de la capa water de OpenFreeMap a z13.
// null si no se pudo saber.
// ---------------------------------------------------------------------------

export async function waterAt(lat: number, lon: number, signal: AbortSignal): Promise<boolean | null> {
  const n = 2 ** RUNWAY_Z
  const fx = lonToX(lon, n)
  const fy = latToY(lat, n)
  const x = Math.floor(fx)
  const y = Math.floor(fy)
  try {
    const vt = (await fetchVectorTile(x, y, signal, RUNWAY_Z)) as any
    const layer = vt.layers.water
    if (!layer) return false
    const px = (fx - x) * layer.extent
    const py = (fy - y) * layer.extent
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i)
      if (f.type !== 3) continue
      // par-impar sobre todos los anillos del polígono (los huecos restan solos)
      let inside = false
      for (const ring of f.loadGeometry() as Array<Array<{ x: number; y: number }>>) {
        for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
          const pa = ring[a]
          const pb = ring[b]
          if (pa.y > py !== pb.y > py && px < ((pb.x - pa.x) * (py - pa.y)) / (pb.y - pa.y) + pa.x) inside = !inside
        }
      }
      if (inside) return true
    }
    return false
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Elevación aproximada (Terrarium z11, ≈ 60 m/píxel)
// ---------------------------------------------------------------------------

const TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'

export async function elevationAt(lat: number, lon: number, signal: AbortSignal): Promise<number | null> {
  const z = 11
  const n = 2 ** z
  const fx = lonToX(lon, n)
  const fy = latToY(lat, n)
  const x = Math.floor(fx)
  const y = Math.floor(fy)
  try {
    const url = TERRARIUM.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))
    const r = await fetch(url, { signal })
    if (!r.ok) return null
    const img = await createImageBitmap(await r.blob())
    const cv = new OffscreenCanvas(img.width, img.height)
    const ctx = cv.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(img, 0, 0)
    const px = Math.min(img.width - 1, Math.floor((fx - x) * img.width))
    const py = Math.min(img.height - 1, Math.floor((fy - y) * img.height))
    const d = ctx.getImageData(px, py, 1, 1).data
    img.close()
    return d[0] * 256 + d[1] + d[2] / 256 - 32768
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Búsqueda de lugares (Nominatim de OpenStreetMap; solo al pulsar Intro y como mucho
// una petición por segundo, según su política de uso)
// ---------------------------------------------------------------------------

export interface PlaceResult {
  name: string
  detail: string
  lat: number
  lon: number
  /** tamaño aproximado del lugar (m), para elegir la altura de la vista */
  size: number
  /** aeródromo según OSM */
  aerodrome: boolean
}

let lastQuery = 0

async function politely(): Promise<void> {
  const wait = lastQuery + 1100 - Date.now()
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastQuery = Date.now()
}

export async function searchPlaces(q: string, lang: string, signal: AbortSignal): Promise<PlaceResult[]> {
  await politely()
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&accept-language=${lang}&q=${encodeURIComponent(q)}`
  const r = await fetch(url, { signal })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const list = (await r.json()) as Array<any>
  return list.map((p) => {
    const bb = (p.boundingbox ?? []).map(Number) as number[]
    const lat = Number(p.lat)
    const size =
      bb.length === 4 ? Math.max((bb[1] - bb[0]) * 110574, (bb[3] - bb[2]) * 111320 * Math.cos(lat * DEG)) : 2000
    const parts = String(p.display_name ?? '').split(',').map((s: string) => s.trim())
    return {
      name: p.name || parts[0] || q,
      detail: parts.slice(1).join(', '),
      lat,
      lon: Number(p.lon),
      size,
      aerodrome: p.category === 'aeroway' && p.type === 'aerodrome',
    }
  })
}

/** Nombre del pueblo o ciudad más cercano (Nominatim reverse, nivel ciudad). */
export async function placeName(lat: number, lon: number, lang: string, signal: AbortSignal): Promise<string | null> {
  await politely()
  if (signal.aborted) return null
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=${lang}&lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`
  try {
    const r = await fetch(url, { signal })
    if (!r.ok) return null
    const j = await r.json()
    const a = j.address ?? {}
    const town = a.city ?? a.town ?? a.village ?? a.municipality ?? a.county ?? a.state ?? null
    const parts = [town, a.country].filter(Boolean)
    return parts.length ? parts.join(', ') : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Coordenadas escritas a mano: «40.2348, -4.027», «40,2348 -4,027», «40°14'05"N 4°01'37"W»
// ---------------------------------------------------------------------------

export function parseCoords(text: string): { lat: number; lon: number } | null {
  const s = text.trim().toUpperCase().replace(/[′’']/g, "'").replace(/[″”"]/g, '"').replace(/º/g, '°')
  // grados, minutos y segundos con hemisferio
  const dms = /(\d{1,3})°\s*(?:(\d{1,2}(?:[.,]\d+)?)')?\s*(?:(\d{1,2}(?:[.,]\d+)?)")?\s*([NSEWO])/g
  const found: number[] = []
  const hemis: string[] = []
  for (let m; (m = dms.exec(s)); ) {
    const v = Number(m[1]) + Number((m[2] ?? '0').replace(',', '.')) / 60 + Number((m[3] ?? '0').replace(',', '.')) / 3600
    found.push(m[4] === 'S' || m[4] === 'W' || m[4] === 'O' ? -v : v)
    hemis.push(m[4])
  }
  if (found.length === 2) {
    const latFirst = hemis[0] === 'N' || hemis[0] === 'S'
    const lat = latFirst ? found[0] : found[1]
    const lon = latFirst ? found[1] : found[0]
    return valid(lat, lon)
  }
  // decimal: dos números separados por coma, punto y coma o espacio (admite coma decimal si hay espacio)
  const m =
    /^(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)$/.exec(s) ?? /^(-?\d{1,2}(?:,\d+)?)\s*[;\s]\s*(-?\d{1,3}(?:,\d+)?)$/.exec(s)
  if (m) return valid(Number(m[1].replace(',', '.')), Number(m[2].replace(',', '.')))
  return null
}

function valid(lat: number, lon: number): { lat: number; lon: number } | null {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null
}

/** 40°14′05″ N · 4°01′37″ O */
export function formatDms(lat: number, lon: number, west: string): string {
  const one = (v: number, pos: string, neg: string, w: number) => {
    const a = Math.abs(v)
    let d = Math.floor(a)
    let m = Math.floor((a - d) * 60)
    let s = Math.round(((a - d) * 60 - m) * 60)
    if (s === 60) {
      s = 0
      m++
    }
    if (m === 60) {
      m = 0
      d++
    }
    return `${String(d).padStart(w, '0')}°${String(m).padStart(2, '0')}′${String(s).padStart(2, '0')}″ ${v >= 0 ? pos : neg}`
  }
  return `${one(lat, 'N', 'S', 2)} · ${one(lon, 'E', west, 3)}`
}
