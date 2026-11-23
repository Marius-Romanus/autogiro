// Protocolo del multijugador (compartido por el cliente y el servidor de salas).
//
// Cada cliente simula SU autogiro y difunde su estado ~15 veces por segundo; el
// servidor solo reparte mensajes dentro de cada sala. Las posiciones viajan en
// ECEF (WGS84, metros) porque cada cliente tiene su propio origen local flotante.

export const MP_PATH = '/mp'
export const MAX_PLAYERS = 8
/** sin I, O, 0 ni 1 para que se pueda dictar sin confusiones */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const CODE_LENGTH = 4
export const NAME_MAX = 20
export const CHAT_MAX = 200

/** Normaliza lo que escribe el usuario: mayúsculas, sin espacios ni guiones. */
export function normalizeCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, CODE_LENGTH)
}

export function isValidCode(code: string): boolean {
  if (code.length !== CODE_LENGTH) return false
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return false
  return true
}

export function cleanName(raw: unknown): string {
  const s = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim()
    .slice(0, NAME_MAX)
  return s || 'Piloto'
}

export function cleanText(raw: unknown, max = CHAT_MAX): string {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max)
}

/** Lo que ven los demás de un piloto. */
export interface PeerInfo {
  id: number
  name: string
  /** id del modelo 3D (src/aircraft/catalog.ts) */
  aircraft: string
  passenger: boolean
  /** puesto en la sala (0 = anfitrión original): separa los puntos de salida */
  slot: number
}

/** Condiciones comunes de la sala, las fija el anfitrión. */
export interface RoomConditions {
  locationId: string
  customLat: number
  customLon: number
  /** rumbo y nombre de la salida personalizada (mapa del mundo); no llegan de versiones anteriores */
  customHeading?: number
  customName?: string
  hour: number
  dayOfYear: number
  windFrom: number
  windSpeed: number
  turbulence: number
  clouds: string
  /** fecha simulada del anfitrión (ms UTC) en el momento de enviarla */
  simTime: number
  /** choques entre aparatos */
  collisions: boolean
}

/** Estado de vuelo difundido por cada cliente. */
export interface StateMsg {
  t: 's'
  /** id del emisor (lo pone el servidor) */
  id?: number
  /** reloj del emisor (ms, performance.now) */
  ts: number
  /** contador de apariciones: si cambia, el receptor no interpola desde lo anterior */
  sq: number
  /** 0 cargando · 1 volando · 2 accidentado · 3 en el menú (pausa) */
  st: number
  /** posición del CG en ECEF (m) */
  p: [number, number, number]
  /** orientación cuerpo → ECEF (x, y, z, w) */
  q: [number, number, number, number]
  /** velocidad en ECEF (m/s) */
  v: [number, number, number]
  /** normal del plano de puntas del rotor en ECEF */
  n: [number, number, number]
  /** buje respecto al CG, ejes cuerpo (m) */
  hb: [number, number, number]
  /** rpm de rotor y de motor */
  rr: number
  er: number
  /** cabeza del rotor (cabeceo, alabeo), timón y rueda de morro (rad) */
  hp: number
  hr: number
  rd: number
  ns: number
  /** palanca (cabeceo, alabeo) */
  sp: number
  sr: number
  /** en el suelo */
  g: 0 | 1
  /** altura del CG sobre el suelo del emisor (m): el receptor la aplica sobre SU relieve cerca del suelo */
  ag: number
  /** luces exteriores encendidas (los clientes anteriores no lo mandan: apagadas) */
  li?: 0 | 1
  /** gas 0..1 y freno de ruedas 0..1, para las palancas de cabina (opcionales: clientes anteriores) */
  th?: number
  wb?: number
}

export type ClientMsg =
  | { t: 'create'; name: string; aircraft: string; passenger: boolean }
  | { t: 'join'; code: string; name: string; aircraft: string; passenger: boolean }
  | { t: 'leave' }
  | { t: 'profile'; name: string; aircraft: string; passenger: boolean }
  | { t: 'cond'; c: RoomConditions }
  | { t: 'chat'; text: string }
  | { t: 'ev'; k: 'crash'; text: string }
  | StateMsg

export type ServerMsg =
  | {
      t: 'welcome'
      code: string
      id: number
      hostId: number
      slot: number
      peers: PeerInfo[]
      /** condiciones actuales (null si el anfitrión aún no las ha enviado) */
      c: RoomConditions | null
      /** antigüedad de esas condiciones (ms) para adelantar su reloj */
      age: number
    }
  | { t: 'error'; code: 'noroom' | 'full' | 'badcode' | 'proto'; msg: string }
  | { t: 'join'; peer: PeerInfo }
  | { t: 'leave'; id: number }
  | { t: 'host'; id: number }
  | { t: 'profile'; id: number; name: string; aircraft: string; passenger: boolean }
  | { t: 'cond'; c: RoomConditions }
  | { t: 'chat'; id: number; text: string }
  | { t: 'ev'; id: number; k: 'crash'; text: string }
  | (StateMsg & { id: number })
