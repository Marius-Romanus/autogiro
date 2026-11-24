// Mensajes entre el hilo principal (Traffic.ts) y el worker del tráfico (traffic.worker.ts).

/** valores por vehículo: frontal, trasera, enganche y trasera del remolque (x, y, z), tipo, color, banderas */
export const STRIDE = 15
export const FLAG = { brake: 1, left: 2, right: 4, bridge: 8, stopped: 16, head: 32, last: 64 }
/** tipos de los coches de tren: 20 + 2·(tren, vía estrecha, metro) + (0 cabeza, 1 coche) */
export const TRAIN_TYPE = 20
/** transbordadores: 30 lancha, 31 ferri grande */
export const FERRY_TYPE = 30
/** barcos: 40 + tipo de marine.ts (vela, velero amarrado, yate, lancha, pesquero, turístico, gabarra, portacontenedores, petrolero, granelero) */
export const BOAT_TYPE = 40
/** valores por barco quieto: x, y, z, rumbo, tipo, eslora, color */
export const BOAT_STRIDE = 7

export type ToWorker =
  | { kind: 'init'; heights: 'ign' | 'terrarium'; ignUrl: string; terrariumUrl: string; seed: number }
  | {
      kind: 'frame'
      dt: number
      /** cámara */
      lat: number
      lon: number
      h: number
      /** hora local, máximo de vehículos, radio de la región (teselas), densidad, radio de dibujo (m) */
      hour: number
      cap: number
      tiles: number
      density: number
      drawRadius: number
      /** obstáculos en la calzada (el aparato posado) */
      obstacles: Array<{ lat: number; lon: number; h: number; r: number }>
      /** mover vehículos (false: solo la red y las farolas, con el tráfico apagado) */
      sim: boolean
    }

export interface FromWorker {
  kind: 'state'
  /** origen del marco de la región (lat, lon, altura) */
  origin: [number, number, number] | null
  count: number
  data: Float32Array
  /** farolas nuevas (marco de la región): x, y (cabeza), z, tipo (parte entera = potencia, ,5 = LED) */
  lamps: Float32Array
  /** las farolas de antes ya no valen (el marco de la región ha cambiado) */
  lampsReset: boolean
  /** barcos quietos (amarrados, atracados, fondeados) cuando cambian: sustituyen a los de antes */
  boats: Float32Array | null
  info: { vehicles: number; links: number; moves: number; building: boolean; tiles: number; buildMs: number; stepMs: number }
}
