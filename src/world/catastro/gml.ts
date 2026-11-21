// Lectura de los edificios del Catastro (INSPIRE, fichero A.ES.SDGC.BU.<municipio>.buildingpart.gml)
// por trozos, sin cargar el fichero entero en memoria (el de Madrid pasa de 2 GB descomprimido).
//
// Cada «BuildingPart» es un volumen con un número de plantas sobre rasante; las partes de un
// mismo edificio comparten huella (casa de dos plantas + garaje de una, etc.). Las coordenadas
// vienen en UTM ETRS89 (25829/25830/25831; en Canarias REGCAN95 UTM 28, EPSG 4083) y se pasan
// aquí a latitud/longitud.
//
// Se usa en el worker del Catastro y en las pruebas de node (no toca el DOM).

export interface CatastroPart {
  /** anillos [lat, lon, lat, lon, …]: el primero es el exterior, el resto huecos */
  rings: Float64Array[]
  /** plantas sobre rasante (0 = nada que levantar: soportales, piscinas, sótanos) */
  floors: number
}

const OPEN = '<bu-ext2d:BuildingPart'
const CLOSE = '</bu-ext2d:BuildingPart>'

/** Analizador incremental: push() con trozos de texto, onPart por cada parte completa. */
export class PartParser {
  private buf = ''
  private readonly onPart: (p: CatastroPart) => void
  /** partes leídas (con o sin plantas) */
  count = 0

  constructor(onPart: (p: CatastroPart) => void) {
    this.onPart = onPart
  }

  push(text: string): void {
    this.buf = this.buf.length ? this.buf + text : text
    let i = 0
    for (;;) {
      const s = this.buf.indexOf(OPEN, i)
      if (s < 0) {
        // puede quedar el principio de una etiqueta cortada al final del trozo
        i = Math.max(i, this.buf.length - OPEN.length)
        break
      }
      const e = this.buf.indexOf(CLOSE, s)
      if (e < 0) {
        i = s
        break
      }
      this.part(this.buf.slice(s, e))
      i = e + CLOSE.length
    }
    this.buf = i > 0 ? this.buf.slice(i) : this.buf
  }

  private part(xml: string): void {
    this.count++
    const fm = /<bu-ext2d:numberOfFloorsAboveGround>(\d+)</.exec(xml)
    const floors = fm ? Number(fm[1]) : 1
    const sm = /srsName="[^"]*?(\d{4,5})"/.exec(xml)
    const epsg = sm ? Number(sm[1]) : 25830
    const zone = utmZone(epsg)
    if (zone === null) return
    // una o varias «PolygonPatch», cada una con exterior y huecos
    for (const patch of xml.split('<gml:PolygonPatch>').slice(1)) {
      const rings: Float64Array[] = []
      const re = /<gml:(exterior|interior)>[\s\S]*?<gml:posList[^>]*>([^<]*)<\/gml:posList>/g
      let m: RegExpExecArray | null
      while ((m = re.exec(patch))) {
        if (m[1] === 'exterior' && rings.length > 0) break // otra superficie (no debería pasar)
        const r = toLatLon(m[2], zone)
        if (r.length >= 6) rings.push(r)
      }
      if (rings.length > 0) this.onPart({ rings, floors })
    }
  }
}

/** Huso UTM del código EPSG (null si no es UTM). */
export function utmZone(epsg: number): number | null {
  if (epsg >= 25828 && epsg <= 25831) return epsg - 25800
  if (epsg >= 32628 && epsg <= 32631) return epsg - 32600
  if (epsg === 4082) return 27
  if (epsg === 4083) return 28
  return null
}

/** "x y x y …" UTM → [lat, lon, …] sin el punto final repetido. */
function toLatLon(posList: string, zone: number): Float64Array {
  const nums = posList.trim().split(/\s+/)
  let n = Math.floor(nums.length / 2)
  if (n > 1 && nums[0] === nums[2 * n - 2] && nums[1] === nums[2 * n - 1]) n--
  const out = new Float64Array(2 * n)
  const ll: [number, number] = [0, 0]
  for (let i = 0; i < n; i++) {
    utmToLatLon(Number(nums[2 * i]), Number(nums[2 * i + 1]), zone, ll)
    out[2 * i] = ll[0]
    out[2 * i + 1] = ll[1]
  }
  return out
}

// UTM inversa (Krüger, series de Karney a orden n⁴: error < 1 mm en el huso). Elipsoide GRS80.
const A = 6378137
const F = 1 / 298.257222101
const N = F / (2 - F)
const N2 = N * N
const N3 = N2 * N
const N4 = N3 * N
const AA = (A / (1 + N)) * (1 + N2 / 4 + N4 / 64)
const BETA = [N / 2 - (2 / 3) * N2 + (37 / 96) * N3 - N4 / 360, N2 / 48 + N3 / 15 - (437 / 1440) * N4, (17 / 480) * N3 - (37 / 840) * N4, (4397 / 161280) * N4]
const DELTA = [2 * N - (2 / 3) * N2 - 2 * N3 + (116 / 45) * N4, (7 / 3) * N2 - (8 / 5) * N3 - (227 / 45) * N4, (56 / 15) * N3 - (136 / 35) * N4, (4279 / 630) * N4]
const K0 = 0.9996
const DEG = 180 / Math.PI

export function utmToLatLon(x: number, y: number, zone: number, out: [number, number]): [number, number] {
  const xi = y / (K0 * AA)
  const eta = (x - 500000) / (K0 * AA)
  let xp = xi
  let ep = eta
  for (let j = 1; j <= 4; j++) {
    xp -= BETA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta)
    ep -= BETA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta)
  }
  const chi = Math.asin(Math.sin(xp) / Math.cosh(ep))
  let phi = chi
  for (let j = 1; j <= 4; j++) phi += DELTA[j - 1] * Math.sin(2 * j * chi)
  const lon0 = (zone * 6 - 183) / DEG
  const lam = lon0 + Math.atan2(Math.sinh(ep), Math.cos(xp))
  out[0] = phi * DEG
  out[1] = lam * DEG
  return out
}
