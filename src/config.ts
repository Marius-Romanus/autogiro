// Ajustes, ubicaciones predefinidas y persistencia.

import { has, t } from './i18n.ts'

export type SceneryMode = 'google' | 'terrain'
export type ImagerySource = 'auto' | 'pnoa' | 'esri'
/** relieve sin clave: MDT de 5 m del IGN en España, o el global de ~30 m */
export type ElevationSource = 'auto' | 'global'
export type StartMode = 'runway' | 'air'
export type CloudPreset = 'clear' | 'fair' | 'scattered' | 'overcast'
export type Quality = 'low' | 'medium' | 'high' | 'ultra'

export interface Location {
  id: string
  name: string
  lat: number
  lon: number
  /** rumbo verdadero de salida (grados) */
  heading: number
  /** ondulación del geoide (m), para convertir alturas elipsoidales a QNH */
  geoid: number
  /** si es pista: el aparato se coloca en el suelo con start=runway */
  runway?: boolean
  /** altura sobre el terreno si se empieza en vuelo */
  airAGL?: number
  note?: string
  /** grupo del desplegable del menú (por defecto, 'scenic') */
  group?: LocationGroup
}

export type LocationGroup = 'airfield' | 'scenic'

// Casarrubios del Monte (LEMT): pista 08/26, 948 × 26 m, rumbo verdadero 077,97°.
// Eje según OpenStreetMap (coincide con la ortofoto PNOA): extremos 40.2339443, −4.0324438
// y 40.2357257, −4.0215379; centro 40.23484 N, −4.02699 E. Las salidas, 15 m dentro de cada extremo.
export const LOCATIONS: Location[] = [
  {
    id: 'lemt08',
    name: 'Casarrubios (LEMT) · cabecera 08',
    lat: 40.233972,
    lon: -4.032271,
    heading: 77.97,
    geoid: 51.6,
    group: 'airfield',
    runway: true,
    note: 'Pista 08/26 · 948 m · asfalto',
  },
  {
    id: 'lemt26',
    name: 'Casarrubios (LEMT) · cabecera 26',
    lat: 40.235698,
    lon: -4.02171,
    heading: 257.97,
    geoid: 51.6,
    group: 'airfield',
    runway: true,
    note: 'Pista 08/26 · 948 m · asfalto',
  },
  {
    id: 'lemt-air',
    name: 'Circuito de Casarrubios (en vuelo)',
    lat: 40.2205,
    lon: -4.045,
    heading: 81,
    geoid: 51.6,
    group: 'airfield',
    airAGL: 300,
    note: 'Tramo de viento en cola, 1000 ft sobre el campo',
  },

  // Aeropuertos y aeródromos históricos. Ejes de pista de OpenStreetMap (los mismos que alisa
  // src/world/Runways.ts), salida 15 m dentro del extremo: `node --experimental-strip-types
  // tools/runway-info.ts <lat> <lon>`. Geoide EGM2008 (GeographicLib GeoidEval).
  {
    id: 'lecu27',
    name: 'Madrid-Cuatro Vientos (LECU) · cabecera 27',
    lat: 40.370213,
    lon: -3.775831,
    heading: 273.75,
    geoid: 51.7,
    group: 'airfield',
    runway: true,
    note: 'Pista 09/27 · 1500 m · asfalto · el aeródromo más antiguo de España (1911)',
  },
  {
    id: 'lecu09',
    name: 'Madrid-Cuatro Vientos (LECU) · cabecera 09',
    lat: 40.371143,
    lon: -3.794462,
    heading: 93.75,
    geoid: 51.7,
    group: 'airfield',
    runway: true,
    note: 'Pista 09/27 · 1500 m · asfalto',
  },
  {
    id: 'lemd36l',
    name: 'Madrid-Barajas (LEMD) · cabecera 36L',
    lat: 40.492695,
    lon: -3.574613,
    heading: 359.73,
    geoid: 51.7,
    group: 'airfield',
    runway: true,
    note: 'Pista 18R/36L · 4350 m · despegues en configuración norte',
  },
  {
    // final de la 32L a 3 NM (5,5 km antes de la cabecera, rumbo 322,3°), ~1000 ft
    id: 'lemd-final32l',
    name: 'Madrid-Barajas (LEMD) · final 32L (en vuelo)',
    lat: 40.4239,
    lon: -3.5141,
    heading: 322.3,
    geoid: 51.7,
    group: 'airfield',
    airAGL: 300,
    note: 'Aproximación final a la 32L, 3 NM, 1000 ft',
  },
  {
    id: 'lebl24l',
    name: 'Barcelona-El Prat (LEBL) · cabecera 24L',
    lat: 41.292169,
    lon: 2.103134,
    heading: 245.47,
    geoid: 49.6,
    group: 'airfield',
    runway: true,
    note: 'Pista 06R/24L · 2660 m · junto a la playa',
  },
  {
    id: 'lepa24l',
    name: 'Palma de Mallorca (LEPA) · cabecera 24L',
    lat: 39.555276,
    lon: 2.761378,
    heading: 238.47,
    geoid: 49.4,
    group: 'airfield',
    runway: true,
    note: 'Pista 06R/24L · 3000 m',
  },
  {
    id: 'lemg13',
    name: 'Málaga-Costa del Sol (LEMG) · cabecera 13',
    lat: 36.68445,
    lon: -4.512476,
    heading: 131.7,
    geoid: 48.3,
    group: 'airfield',
    runway: true,
    note: 'Pista 13/31 · 3200 m · despegue hacia el mar',
  },
  {
    id: 'lezl27',
    name: 'Sevilla-San Pablo (LEZL) · cabecera 27',
    lat: 37.418005,
    lon: -5.874336,
    heading: 269.75,
    geoid: 50.4,
    group: 'airfield',
    runway: true,
    note: 'Pista 09/27 · 3360 m',
  },
  {
    id: 'levc12',
    name: 'Valencia-Manises (LEVC) · cabecera 12',
    lat: 39.496307,
    lon: -0.499973,
    heading: 116.28,
    geoid: 50.8,
    group: 'airfield',
    runway: true,
    note: 'Pista 12/30 · 3200 m · hacia la ciudad y el mar',
  },
  {
    id: 'lebb30',
    name: 'Bilbao (LEBB) · cabecera 30',
    lat: 43.295904,
    lon: -2.896453,
    heading: 296.61,
    geoid: 50.2,
    group: 'airfield',
    runway: true,
    note: 'Pista 12/30 · 2600 m · entre montes',
  },
  {
    id: 'gcxo30',
    name: 'Tenerife Norte-Los Rodeos (GCXO) · cabecera 30',
    lat: 28.477312,
    lon: -16.32542,
    heading: 290.67,
    geoid: 45.1,
    group: 'airfield',
    runway: true,
    note: 'Pista 12/30 · 3400 m · 630 m de altitud, con el Teide al fondo',
  },
  {
    id: 'gclp03l',
    name: 'Gran Canaria (GCLP) · cabecera 03L',
    lat: 27.918997,
    lon: -15.392289,
    heading: 21.32,
    geoid: 44.1,
    group: 'airfield',
    runway: true,
    note: 'Pista 03L/21R · 3100 m · junto al mar',
  },

  { id: 'madrid', name: 'Madrid · Palacio Real', lat: 40.4153, lon: -3.7244, heading: 60, geoid: 51.9, airAGL: 350 },
  { id: 'toledo', name: 'Toledo · casco histórico', lat: 39.8505, lon: -4.0425, heading: 20, geoid: 51.3, airAGL: 250 },
  { id: 'escorial', name: 'San Lorenzo de El Escorial', lat: 40.5772, lon: -4.1428, heading: 340, geoid: 52.2, airAGL: 300 },
  { id: 'gredos', name: 'Sierra de Gredos · Almanzor', lat: 40.2205, lon: -5.2802, heading: 200, geoid: 52.0, airAGL: 500 },
  { id: 'segovia', name: 'Segovia · Acueducto y Alcázar', lat: 40.952, lon: -4.1295, heading: 290, geoid: 52.5, airAGL: 250 },
  { id: 'montserrat', name: 'Montserrat', lat: 41.592, lon: 1.835, heading: 330, geoid: 49.5, airAGL: 500 },
  { id: 'ordesa', name: 'Valle de Ordesa', lat: 42.645, lon: -0.03, heading: 70, geoid: 50.0, airAGL: 600 },
]

/** Nombre del lugar en el idioma de la interfaz (los nombres de LOCATIONS están en español). */
export function locationName(l: Location): string {
  const k = `loc.${l.id}`
  return has(k) ? t(k) : l.name
}

export interface Settings {
  scenery: SceneryMode
  googleKey: string
  imagery: ImagerySource
  elevation: ElevationSource
  /** edificios 3D de OpenStreetMap en el modo sin clave */
  buildings: boolean
  /** árboles 3D detectados en la ortofoto (modo sin clave) */
  trees: boolean
  locationId: string
  customLat: number
  customLon: number
  start: StartMode
  passenger: boolean
  /** id del modelo 3D en src/aircraft/catalog.ts */
  aircraft: string
  hour: number // hora local (decimal)
  dayOfYear: number
  windFrom: number
  windSpeed: number // nudos
  turbulence: number // 0..1
  clouds: CloudPreset
  /** 'auto' = según la GPU detectada */
  quality: Quality | 'auto'
  volume: number
  invertPitch: boolean
  mouseStick: boolean
  /** ayuda de pilotaje: nivelado de alas y coordinación con pedales */
  assist: boolean
  // mapeo de joystick
  axisPitch: number
  axisRoll: number
  axisYaw: number
  axisThrottle: number
  invertThrottle: boolean
  exposure: number
}

export const DEFAULT_SETTINGS: Settings = {
  scenery: 'terrain',
  googleKey: '',
  imagery: 'auto',
  elevation: 'auto',
  buildings: true,
  trees: true,
  locationId: 'lemt26',
  customLat: 40.2348,
  customLon: -4.027,
  start: 'runway',
  passenger: false,
  aircraft: 'ela07',
  hour: 11,
  dayOfYear: 140,
  windFrom: 250,
  windSpeed: 6,
  turbulence: 0.25,
  clouds: 'fair',
  quality: 'auto',
  volume: 0.8,
  invertPitch: false,
  mouseStick: false,
  assist: true,
  axisPitch: 1,
  axisRoll: 0,
  axisYaw: 2,
  axisThrottle: 3,
  invertThrottle: true,
  exposure: 2.6,
}

const KEY = 'autogiro.settings.v4'

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch {
    /* almacenamiento no disponible */
  }
  const s = { ...DEFAULT_SETTINGS }
  // la clave de .env.local solo en desarrollo: el juego compilado (npm run server, que se
  // comparte por Internet) nunca la lleva dentro; ahí cada uno la pone en el menú
  const envKey = import.meta.env.DEV ? (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined) : undefined
  if (envKey) {
    s.googleKey = envKey
    s.scenery = 'google'
  }
  return s
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* ignorar */
  }
}

export function isInSpain(lat: number, lon: number): boolean {
  // península + Baleares (aprox.); Canarias tienen PNOA también
  const peninsula = lat > 35.9 && lat < 43.9 && lon > -9.5 && lon < 4.4
  const canarias = lat > 27.5 && lat < 29.5 && lon > -18.3 && lon < -13.3
  return peninsula || canarias
}
