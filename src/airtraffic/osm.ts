// Calles de rodaje, plataformas y nombre de un aeródromo, de OpenStreetMap (capa `aeroway` de las
// teselas vectoriales de OpenFreeMap, las mismas de world/Runways.ts).

import { fetchVectorTile, latToY, lonToX, xToLon, yToLat, Z } from '../world/mapTiles.ts'

export interface GeoPt {
  lat: number
  lon: number
}

export interface OsmAirfield {
  taxiways: GeoPt[][]
  aprons: GeoPt[][]
  /** nombre e indicativo OACI del aeródromo más cercano (si el mapa los trae) */
  name: string
  icao: string
}

/** Todo lo de `aeroway` a menos de `radius` metros del punto. */
export async function fetchAirfield(lat: number, lon: number, radius: number, signal: AbortSignal): Promise<OsmAirfield> {
  const n = 2 ** Z
  const mLat = 111132
  const mLon = 111320 * Math.cos((lat * Math.PI) / 180)
  const x0 = Math.floor(lonToX(lon - radius / mLon, n))
  const x1 = Math.floor(lonToX(lon + radius / mLon, n))
  const y0 = Math.floor(latToY(lat + radius / mLat, n))
  const y1 = Math.floor(latToY(lat - radius / mLat, n))
  const out: OsmAirfield = { taxiways: [], aprons: [], name: '', icao: '' }
  let bestLabel = Infinity
  const near = (p: GeoPt) => Math.hypot((p.lon - lon) * mLon, (p.lat - lat) * mLat) < radius
  const jobs: Promise<void>[] = []
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      jobs.push(
        fetchVectorTile(x, y, signal).then((vt) => {
          const layers = vt.layers as Record<string, any>
          const aero = layers.aeroway
          if (aero) {
            const E = aero.extent
            for (let i = 0; i < aero.length; i++) {
              const f = aero.feature(i)
              const cls = f.properties.class
              if (cls !== 'taxiway' && cls !== 'apron') continue
              for (const ring of f.loadGeometry() as Array<Array<{ x: number; y: number }>>) {
                const pts = ring.map((p): GeoPt => ({ lat: yToLat(y + p.y / E, n), lon: xToLon(x + p.x / E, n) }))
                if (!pts.some(near)) continue
                if (cls === 'taxiway' && f.type === 2 && pts.length >= 2) out.taxiways.push(pts)
                else if (cls === 'apron' && f.type === 3 && pts.length >= 4) out.aprons.push(pts.slice(0, -1))
              }
            }
          }
          const lab = layers.aerodrome_label
          if (lab) {
            const E = lab.extent
            for (let i = 0; i < lab.length; i++) {
              const f = lab.feature(i)
              const g = f.loadGeometry()[0]?.[0]
              if (!g) continue
              const d = Math.hypot((xToLon(x + g.x / E, n) - lon) * mLon, (yToLat(y + g.y / E, n) - lat) * mLat)
              if (d < bestLabel && d < 2500) {
                bestLabel = d
                out.name = String(f.properties['name:es'] ?? f.properties.name ?? '')
                out.icao = String(f.properties.icao ?? '')
              }
            }
          }
        }),
      )
    }
  }
  // (una tesela que falla deja el aeródromo sin algunas calles: se rodará por la hierba)
  await Promise.allSettled(jobs)
  return out
}

/** «Aeródromo de Casarrubios del Monte» → «Casarrubios del Monte»: como se le llama por radio. */
export function radioName(name: string): string {
  return name
    .replace(/^(aer[oó]dromo|aeropuerto|campo de vuelo|pista|a[ée]rodrome|a[ée]roport|airfield|airport|flugplatz|aeroporto|aviosuperficie)\s+(de la |de los |de las |del |de |d'|di |of )?/i, '')
    .replace(/\s+(airfield|airport|aerodrome|airstrip)$/i, '')
    .trim()
}

/** Prefijo de matrícula que se ve en la zona (a ojo: basta para que suene de allí). */
export function registrationPrefix(lat: number, lon: number): string {
  const inBox = (s: number, w: number, n: number, e: number) => lat >= s && lat <= n && lon >= w && lon <= e
  if (inBox(36.9, -9.6, 42.2, -6.2) && !(lat > 41.8 && lon > -8.9) && lon < -6.9) return 'CS-'
  if (inBox(35.8, -9.4, 43.9, 4.4) || inBox(27.5, -18.3, 29.5, -13.3)) return 'EC-'
  if (inBox(49.9, -8.2, 59.5, 1.8)) return 'G-'
  if (inBox(42.3, -4.8, 51.1, 8.2)) return 'F-J'
  if (inBox(47.3, 5.9, 55.1, 15.0)) return 'D-M'
  if (inBox(36.6, 6.6, 47.1, 18.5)) return 'I-'
  if (inBox(24, -125, 49.5, -66)) return 'N'
  return 'EC-'
}
