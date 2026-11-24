// Formato del fichero de puentes con estructura conocida (public/bridges.bin), compartido por
// la herramienta que lo genera (tools/bridges.ts) y el juego (bridgeStructures.ts).
//
// Las teselas vectoriales traen el trazado de todos los puentes, pero no de qué tipo son. Este
// fichero dice cuáles son colgantes, atirantados, de arco o de celosía (y, si se sabe, su
// longitud, su vano mayor y la altura de sus torres); los demás se dibujan como viaducto de
// vigas sobre pilas.
//
// Cabecera: «BRG1», uint32 número de registros, uint32 fecha (AAAAMMDD).
// Registros de RECORD bytes (little endian), ordenados por tesela z14:
//   0  int32   latitud × 1e7 (un punto del puente, normalmente el centro)
//   4  int32   longitud × 1e7
//   8  uint16  longitud total en m (0 = sin dato)
//  10  uint16  vano mayor en m (0 = sin dato)
//  12  uint16  altura de la estructura en m (torres o clave del arco sobre el agua; 0 = sin dato)
//  14  uint8   tipo (BRIDGE_*)
//  15  uint8×3 color sRGB de la estructura (0,0,0 = el habitual del tipo)
//  18  uint8   número de torres o pilonos (0 = lo habitual: dos, o uno si el vano es casi todo el puente)
//  19  uint8   libre
// Todo el fichero va comprimido con zlib (fflate).

export const MAGIC = 'BRG1'
export const HEADER = 12
export const RECORD = 20

/** colgante: dos torres, cables principales en catenaria y péndolas */
export const BRIDGE_SUSPENSION = 1
/** atirantado: pilonos y tirantes rectos al tablero */
export const BRIDGE_CABLE_STAYED = 2
/** arco sin más datos: bajo el tablero si hay altura, sobre él si no */
export const BRIDGE_ARCH = 3
/** arco bajo el tablero (tablero superior) */
export const BRIDGE_ARCH_DECK = 4
/** arco sobre el tablero (tablero inferior, bowstring) */
export const BRIDGE_ARCH_THROUGH = 5
/** arcos de fábrica en fila (puentes de piedra, romanos) */
export const BRIDGE_ARCH_STONE = 6
/** celosía metálica a los lados y por encima del tablero */
export const BRIDGE_TRUSS = 7
/** celosía en ménsula: más alta sobre las pilas */
export const BRIDGE_CANTILEVER = 8
/** extradosado: atirantado de torres bajas */
export const BRIDGE_EXTRADOSED = 9

export interface BridgeRecord {
  lat: number
  lon: number
  /** longitud total (m) o 0 */
  length: number
  /** vano mayor (m) o 0 */
  span: number
  /** altura de la estructura (m) o 0 */
  height: number
  type: number
  /** color sRGB (0xRRGGBB) o 0 */
  colour: number
  /** número de torres o pilonos, o 0 */
  towers: number
}

export function readRecord(dv: DataView, i: number): BridgeRecord {
  const o = HEADER + i * RECORD
  return {
    lat: dv.getInt32(o, true) / 1e7,
    lon: dv.getInt32(o + 4, true) / 1e7,
    length: dv.getUint16(o + 8, true),
    span: dv.getUint16(o + 10, true),
    height: dv.getUint16(o + 12, true),
    type: dv.getUint8(o + 14),
    colour: (dv.getUint8(o + 15) << 16) | (dv.getUint8(o + 16) << 8) | dv.getUint8(o + 17),
    towers: dv.getUint8(o + 18),
  }
}

export function writeRecord(dv: DataView, i: number, r: BridgeRecord): void {
  const o = HEADER + i * RECORD
  const u16 = (v: number) => Math.max(0, Math.min(65535, Math.round(v)))
  dv.setInt32(o, Math.round(r.lat * 1e7), true)
  dv.setInt32(o + 4, Math.round(r.lon * 1e7), true)
  dv.setUint16(o + 8, u16(r.length), true)
  dv.setUint16(o + 10, u16(r.span), true)
  dv.setUint16(o + 12, u16(r.height), true)
  dv.setUint8(o + 14, r.type)
  dv.setUint8(o + 15, (r.colour >> 16) & 255)
  dv.setUint8(o + 16, (r.colour >> 8) & 255)
  dv.setUint8(o + 17, r.colour & 255)
  dv.setUint8(o + 18, Math.max(0, Math.min(255, r.towers)))
}
