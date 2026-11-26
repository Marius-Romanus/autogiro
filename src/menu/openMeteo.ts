// Tiempo real: condiciones actuales de Open-Meteo (https://open-meteo.com, sin clave, CC BY 4.0) en el
// punto de salida, pasadas a los ajustes del simulador: viento, turbulencia (de las rachas), cielo (el
// preset más parecido), temperatura, QNH, punto de rocío, visibilidad, precipitación y hora local.
//
// La API manda `Access-Control-Allow-Origin: *`: funciona desde el navegador y desde la app de
// escritorio (WebView2 en http://localhost:47800, sin CSP) sin pasar por nuestro servidor.
// Sin nada del DOM: las pruebas (tools/weather-test.ts) lo importan en Node.

import type { CloudPreset, Settings } from '../config.ts'
import { qnhFromStation } from '../sim/airMass.ts'
import { localUtcOffset } from './sun.ts'

export const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast'
const KT = 0.514444
const VARS = [
  'temperature_2m',
  'dew_point_2m',
  'pressure_msl',
  'surface_pressure',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'cloud_cover',
  'cloud_cover_low',
  'cloud_cover_mid',
  'cloud_cover_high',
  'visibility',
  'precipitation',
  'weather_code',
]

/** Condiciones actuales tal como llegan (unidades de la petición: °C, hPa, nudos, %, m, mm). */
export interface RealWeather {
  /** hora local del dato del modelo (ISO sin zona) y huso del sitio (s) */
  time: string
  utcOffset: number
  timezone: string
  /** elevación (m) a la que Open-Meteo da temperatura y presión en superficie (MDT de 90 m) */
  elevation: number
  tempC: number
  dewC: number
  /** presión reducida al nivel del mar con la temperatura real (la del mapa del tiempo, no el QNH) */
  pMsl: number
  /** presión en superficie (hPa) o NaN */
  pSurface: number
  windKt: number
  windFrom: number
  gustKt: number
  cover: number
  low: number
  mid: number
  high: number
  /** visibilidad (m) o NaN */
  visibility: number
  /** precipitación del intervalo del dato (mm) y su duración (s) */
  precip: number
  interval: number
  code: number
}

export function openMeteoUrl(lat: number, lon: number): string {
  return `${OPEN_METEO_URL}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&current=${VARS.join(',')}&wind_speed_unit=kn&timezone=auto`
}

/** Pide las condiciones actuales. Lanza un Error con un texto corto si algo falla. */
export async function fetchRealWeather(lat: number, lon: number, signal?: AbortSignal): Promise<RealWeather> {
  const r = await fetch(openMeteoUrl(lat, lon), { signal })
  let j: any = null
  try {
    j = await r.json()
  } catch {
    /* sin JSON */
  }
  if (!r.ok || !j || j.error) throw new Error(j?.reason ? String(j.reason).slice(0, 120) : `HTTP ${r.status}`)
  return parseOpenMeteo(j)
}

export function parseOpenMeteo(j: any): RealWeather {
  const c = j?.current
  if (!c || typeof c !== 'object') throw new Error('sin datos actuales')
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN)
  const w: RealWeather = {
    time: String(c.time ?? ''),
    utcOffset: n(j.utc_offset_seconds),
    timezone: String(j.timezone ?? ''),
    elevation: n(j.elevation),
    tempC: n(c.temperature_2m),
    dewC: n(c.dew_point_2m),
    pMsl: n(c.pressure_msl),
    pSurface: n(c.surface_pressure),
    windKt: n(c.wind_speed_10m),
    windFrom: n(c.wind_direction_10m),
    gustKt: n(c.wind_gusts_10m),
    cover: n(c.cloud_cover),
    low: n(c.cloud_cover_low),
    mid: n(c.cloud_cover_mid),
    high: n(c.cloud_cover_high),
    visibility: n(c.visibility),
    precip: n(c.precipitation),
    interval: n(c.interval),
    code: n(c.weather_code),
  }
  // lo imprescindible: temperatura, alguna presión y viento
  if (!Number.isFinite(w.tempC) || (!Number.isFinite(w.pMsl) && !Number.isFinite(w.pSurface)) || !Number.isFinite(w.windKt))
    throw new Error('datos incompletos')
  return w
}

/**
 * QNH (hPa). Es la presión en el campo reducida al nivel del mar con la atmósfera ESTÁNDAR (lo que hace
 * que el altímetro marque la elevación en el suelo); la `pressure_msl` de los mapas se reduce con la
 * temperatura real y en campos altos con calor o frío se separa del QNH varios hPa. Con la presión en
 * superficie y su elevación sale el QNH de verdad; si falta, la del nivel del mar.
 */
export function realQnh(w: RealWeather): number {
  if (Number.isFinite(w.pSurface) && Number.isFinite(w.elevation)) return qnhFromStation(w.pSurface, w.elevation)
  return w.pMsl
}

/**
 * Turbulencia del simulador (0..1) a partir del viento medio y las rachas a 10 m. En WindModel
 * (sim/atmosphere.ts) la desviación típica de la ráfaga horizontal es σ = turb·(0,6 + 0,18·U) m/s, y
 * la racha máxima de una hora (lo que da Open-Meteo) queda unas 3,5 σ por encima del viento medio.
 */
export function gustTurbulence(windKt: number, gustKt: number): number {
  const U = Math.max(0, windKt) * KT
  const G = Math.max(gustKt, windKt) * KT
  if (!Number.isFinite(G)) return 0.25
  const sigma = (G - U) / 3.5
  const t = sigma / (0.6 + 0.18 * U)
  return Math.max(0.05, Math.min(1, Math.round(t * 20) / 20))
}

/**
 * Lo mismo con el viento del terreno (src/sim/wind): el deslizador multiplica la turbulencia del
 * modelo (0,25 = tal cual), que a 10 m sobre hierba vale σu ≈ 2,4·u* ≈ 0,165·U, más unos 0,5 m/s de
 * fondo (convección de día). Unas rachas como las de la teoría dejan el deslizador en el 25 %.
 */
export function gustTurbulenceTerrain(windKt: number, gustKt: number): number {
  const U = Math.max(0, windKt) * KT
  const G = Math.max(gustKt, windKt) * KT
  if (!Number.isFinite(G) || G <= U) return 0.25
  const t = (0.25 * (G - U)) / 3.5 / (0.165 * U + 0.5)
  return Math.max(0.05, Math.min(1, Math.round(t * 20) / 20))
}

/**
 * Cielo del simulador más parecido. Los presets son cúmulos y estratocúmulos bajos y medios (base a
 * 900–1300 m; cubren 0, 22, 40 y 95 % del cielo), así que cuentan las nubes bajas y medias; los cirros
 * apenas (un velo de cirros no llega a «cúmulos»). La lluvia, la llovizna o la nieve continuas vienen
 * de cielos cubiertos y los chubascos y tormentas, de nubes de desarrollo.
 */
export function cloudPreset(w: Pick<RealWeather, 'low' | 'mid' | 'high' | 'cover' | 'code'>): CloudPreset {
  const p = (v: number) => (Number.isFinite(v) ? v / 100 : 0)
  let c = Number.isFinite(w.low) || Number.isFinite(w.mid) ? Math.max(p(w.low), p(w.mid), 0.1 * p(w.high)) : p(w.cover)
  const code = w.code
  if (code >= 51 && code <= 77) c = Math.max(c, 0.8)
  else if (code >= 80 && code <= 99) c = Math.max(c, 0.5)
  return c < 0.11 ? 'clear' : c < 0.31 ? 'fair' : c < 0.675 ? 'scattered' : 'overcast'
}

const dayOfYearUtc = (d: Date) => Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400e3) + 1

/**
 * Hora y día «del menú» de ahora mismo en el sitio. El simulador usa su propia hora local (España: la
 * oficial; fuera, la solar redondeada, ver sun.ts) para colocar el sol; con ella el sol queda donde está
 * de verdad aunque fuera de España el reloj del sitio pueda ir una hora distinto.
 */
export function localNow(lat: number, lon: number, nowMs = Date.now()): { hour: number; dayOfYear: number } {
  let doy = dayOfYearUtc(new Date(nowMs))
  let local = new Date(nowMs)
  for (let i = 0; i < 2; i++) {
    const tz = localUtcOffset(lat, lon, Math.min(365, doy))
    local = new Date(nowMs + tz * 3600e3)
    doy = dayOfYearUtc(local)
  }
  const hour = Math.round((local.getUTCHours() + local.getUTCMinutes() / 60) * 60) / 60
  return { hour: hour >= 24 ? 0 : hour, dayOfYear: Math.max(1, Math.min(365, doy)) }
}

/** Ajustes que salen de unas condiciones reales (no toca nada más). */
export function realWeatherSettings(
  w: RealWeather,
  lat: number,
  lon: number,
  nowMs = Date.now(),
): Pick<Settings, 'windFrom' | 'windSpeed' | 'windGustKt' | 'turbulence' | 'clouds' | 'isa' | 'oatC' | 'qnh' | 'dewPointC' | 'visibility' | 'precip' | 'weatherCode' | 'hour' | 'dayOfYear'> {
  const windKt = Math.max(0, w.windKt)
  const gust = Number.isFinite(w.gustKt) ? Math.max(w.gustKt, windKt) : 0
  const { hour, dayOfYear } = localNow(lat, lon, nowMs)
  const r1 = (v: number) => Math.round(v * 10) / 10
  return {
    // (el selector va de 5 en 5 grados)
    windFrom: Number.isFinite(w.windFrom) ? (Math.round(w.windFrom / 5) * 5) % 360 : 0,
    windSpeed: Math.min(40, Math.round(windKt)),
    windGustKt: Math.round(gust),
    turbulence: gustTurbulence(windKt, gust || windKt),
    clouds: cloudPreset(w),
    isa: false,
    oatC: r1(w.tempC),
    qnh: r1(realQnh(w)),
    dewPointC: r1(Number.isFinite(w.dewC) ? Math.min(w.dewC, w.tempC) : w.tempC - 10),
    visibility: Number.isFinite(w.visibility) ? Math.round(w.visibility) : 30000,
    precip: Number.isFinite(w.precip) ? r1((w.precip * 3600) / (w.interval > 0 ? w.interval : 3600)) : 0,
    weatherCode: Number.isFinite(w.code) ? w.code : -1,
    hour,
    dayOfYear,
  }
}
