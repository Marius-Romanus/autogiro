// Formato del fichero de mangas de viento de OpenStreetMap (public/windsocks.bin), compartido
// por la herramienta que lo genera (tools/windsocks.ts) y el juego (Windsocks.ts).
//
// Cabecera: «WSK1», uint32 número de registros, uint32 fecha (AAAAMMDD).
// Registros de RECORD bytes (little endian), ordenados por latitud:
//   0  int32  latitud × 1e7
//   4  int32  longitud × 1e7
//   8  int8   iluminada: 1 sí, 0 no, -1 sin dato (etiquetas lit / windsock:lit)
// Todo el fichero va comprimido con zlib (fflate).

export const MAGIC = 'WSK1'
export const HEADER = 12
export const RECORD = 9

export interface WindsockRecord {
  lat: number
  lon: number
  /** 1 iluminada, 0 sin luz, -1 sin dato */
  lit: number
}

export function readWindsock(dv: DataView, i: number): WindsockRecord {
  const o = HEADER + i * RECORD
  return { lat: dv.getInt32(o, true) / 1e7, lon: dv.getInt32(o + 4, true) / 1e7, lit: dv.getInt8(o + 8) }
}

export function writeWindsock(dv: DataView, i: number, r: WindsockRecord): void {
  const o = HEADER + i * RECORD
  dv.setInt32(o, Math.round(r.lat * 1e7), true)
  dv.setInt32(o + 4, Math.round(r.lon * 1e7), true)
  dv.setInt8(o + 8, r.lit)
}
