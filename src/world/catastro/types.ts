// Mensajes entre el juego y el worker del Catastro (catastro.worker.ts).

/** Edificios de un municipio en una tesela z14 (coordenadas 0..1 dentro de la tesela). */
export interface CatTile {
  code: string
  /** "x/y" de la tesela z14 */
  tile: string
  /** u, v alternados (u hacia el este, v hacia el sur, 0..1 en la tesela; puede salirse un poco) */
  coords: Float32Array
  /** índice (en puntos) donde empieza cada anillo, con uno de más al final */
  ringStart: Uint32Array
  /** índice del primer anillo de cada parte, con uno de más al final */
  partRing: Uint32Array
  /** plantas sobre rasante de cada parte */
  floors: Uint8Array
}

/** Municipio descargado (para el listado del menú). */
export interface MuniInfo {
  code: string
  name: string
  /** lo que ocupa guardado (bytes) */
  bytes: number
  parts: number
  /** cuándo se descargó (ms) */
  fetched: number
}

/** Municipio en cola o descargándose. */
export interface MuniStatus {
  code: string
  name: string
  state: 'queued' | 'downloading' | 'processing' | 'error'
  loaded?: number
  total?: number
}

export interface Circle {
  lat: number
  lon: number
  /** radio en metros */
  r: number
}

export type ToWorker =
  | { t: 'want'; circles: Circle[] }
  | { t: 'tile'; id: number; x: number; y: number }
  | { t: 'list'; id: number }
  | { t: 'delete'; id: number; code: string | null }
  | { t: 'pending'; id: number; x: number; y: number }

export type FromWorker =
  | { t: 'tile'; id: number; pending: boolean; data: CatTile[] }
  | { t: 'list'; id: number; munis: MuniInfo[] }
  | { t: 'deleted'; id: number; tiles: string[] }
  | { t: 'pending'; id: number; pending: boolean }
  /** un municipio terminado (o que falló): teselas que cambian y su recuadro (para revisar las que esperaban) */
  | { t: 'ready'; code: string; tiles: string[]; bbox: { s: number; w: number; n: number; e: number } }
  | { t: 'status'; queue: MuniStatus[] }
