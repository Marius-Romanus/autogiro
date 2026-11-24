// Formato del fichero de tejados de OpenStreetMap (public/osm-roofs.bin), compartido por la
// herramienta que lo genera (tools/osm-roofs.ts) y el juego (osmRoofs.ts).
//
// Cabecera: «ROF1», uint32 número de registros, uint32 fecha del volcado (AAAAMMDD).
// Registros de RECORD bytes (little endian), ordenados por tesela z14:
//   0  int32   latitud del centroide × 1e7
//   4  int32   longitud × 1e7
//   8  float32 área de la huella exterior (m²)
//  12  uint16  height en dm (0 = sin altura explícita: la de la tesela es la de las paredes)
//  14  uint16  min_height en dm
//  16  uint16  altura del tejado en dm (0 = sin dato: se deduce de la forma)
//  18  uint16  roof:direction en grados (0xffff = sin dato)
//  20  uint8   forma (ROOF_*)
//  21  uint8   indicadores (FLAG_*)
//  22  uint8   roof:angle en grados (0 = sin dato)
//  23  uint8×3 color del tejado sRGB (vale si FLAG_COLOUR o FLAG_MATERIAL)
//  26  uint16  libre
// Todo el fichero va comprimido con zlib (fflate).

export const MAGIC = 'ROF1'
export const HEADER = 12
export const RECORD = 28

// Tejados de todo el mundo (worldRoofs.ts, generado con tools/world-roofs.py + tools/world-roofs.ts):
// un solo fichero, alojado aparte, del que se piden por rangos las zonas por donde se vuela.
//   Cabecera (WORLD_HEADER bytes): «ROW1», uint32 fecha de los datos (AAAAMMDD), uint32 número de
//   zonas, uint8 nivel de las zonas (WORLD_Z), 3 bytes libres.
//   Índice: por zona (ordenadas por clave = y · 2^Z + x) uint32 clave, uint32 desplazamiento,
//   uint32 longitud (bytes comprimidos), uint32 número de registros.
//   Zonas: registros de RECORD bytes comprimidos con zlib, ordenados por tesela z14, con el mismo
//   formato que los de España salvo los bytes 8–11: uint16 ancho y uint16 alto del rectángulo
//   envolvente de la huella (dm, este-oeste y norte-sur), y lat/lon = centro de ese rectángulo
//   (los datos de Overture traen el rectángulo, no la huella).
export const WORLD_MAGIC = 'ROW1'
export const WORLD_HEADER = 16
export const WORLD_INDEX = 16
/** nivel de las zonas (z8: ~150 km; una zona densa de Alemania pesa unos 2–3 MB) */
export const WORLD_Z = 8

export const ROOF_FLAT = 0
export const ROOF_GABLED = 1
export const ROOF_HIPPED = 2
export const ROOF_PYRAMIDAL = 3
export const ROOF_DOME = 4
export const ROOF_ONION = 5
export const ROOF_CONE = 6
export const ROOF_SKILLION = 7
export const ROOF_ROUND = 8

/** caballete transversal (roof:orientation=across) */
export const FLAG_ACROSS = 1
/** color de roof:colour */
export const FLAG_COLOUR = 2
/** color deducido de roof:material */
export const FLAG_MATERIAL = 4
/** es una parte (building:part) */
export const FLAG_PART = 8

/** roof:shape de OSM → forma que sabemos dibujar (undefined = no dice nada útil) */
export const SHAPES: Record<string, number> = {
  flat: ROOF_FLAT,
  gabled: ROOF_GABLED,
  pitched: ROOF_GABLED,
  gabled_row: ROOF_GABLED,
  saltbox: ROOF_GABLED,
  double_saltbox: ROOF_GABLED,
  gambrel: ROOF_GABLED,
  gabled_height_moved: ROOF_GABLED,
  'apse_gabled': ROOF_GABLED,
  hipped: ROOF_HIPPED,
  side_hipped: ROOF_HIPPED,
  'half-hipped': ROOF_HIPPED,
  half_hipped: ROOF_HIPPED,
  side_half_hipped: ROOF_HIPPED,
  'side_half-hipped': ROOF_HIPPED,
  mansard: ROOF_HIPPED,
  side_mansard: ROOF_HIPPED,
  'hipped-and-gabled': ROOF_HIPPED,
  equal_hipped: ROOF_HIPPED,
  quadruple_saltbox: ROOF_HIPPED,
  crosspitched: ROOF_HIPPED,
  pyramidal: ROOF_PYRAMIDAL,
  side_pyramidal: ROOF_PYRAMIDAL,
  round_pyramidal: ROOF_PYRAMIDAL,
  dome: ROOF_DOME,
  doom: ROOF_DOME,
  spherical: ROOF_DOME,
  parabolic: ROOF_DOME,
  onion: ROOF_ONION,
  cone: ROOF_CONE,
  conical: ROOF_CONE,
  skillion: ROOF_SKILLION,
  lean_to: ROOF_SKILLION,
  shed: ROOF_SKILLION,
  round: ROOF_ROUND,
  round_gabled: ROOF_ROUND,
  round_row: ROOF_ROUND,
}

/** roof:material → color sRGB aproximado (solo se usa en lo alto, donde la ortofoto engaña) */
export const MATERIAL_COLOURS: Record<string, string> = {
  roof_tiles: '#a0644a',
  tiles: '#a0644a',
  tile: '#a0644a',
  clay: '#a0644a',
  slate: '#555a60',
  metal: '#8d9399',
  metal_sheet: '#8d9399',
  sheet_metal: '#8d9399',
  steel: '#8d9399',
  tin: '#8d9399',
  zinc: '#8c9296',
  lead: '#7b7f84',
  copper: '#6c9a87',
  concrete: '#a8a49c',
  glass: '#7f9aa8',
  stone: '#b3a68f',
  thatch: '#8a7653',
  asphalt: '#5a5a58',
  tar_paper: '#5a5a58',
  bitumen: '#5a5a58',
  gravel: '#9a948a',
  grass: '#6d7d4a',
  plants: '#6d7d4a',
  eternit: '#a5a39b',
  wood: '#7a5a3e',
}

/** Rumbo de roof:direction (grados o puntos cardinales); null si no se entiende. */
export function parseDirection(v: string | undefined): number | null {
  if (!v) return null
  const s = v.trim().toUpperCase()
  const card = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
  const k = card.indexOf(s)
  if (k >= 0) return k * 22.5
  const n = Number(s.replace(',', '.'))
  return Number.isFinite(n) ? ((n % 360) + 360) % 360 : null
}

/** Longitud en metros («12», «12.5 m», «12,5»); null si no se entiende. */
export function parseMetres(v: string | undefined): number | null {
  if (!v) return null
  const m = /^\s*(-?\d+(?:[.,]\d+)?)\s*(m|ft|')?\s*$/i.exec(v)
  if (!m) return null
  let n = Number(m[1].replace(',', '.'))
  if (m[2] && m[2] !== 'm' && m[2] !== 'M') n *= 0.3048
  return Number.isFinite(n) ? n : null
}
