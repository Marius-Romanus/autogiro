// Visibilidad, niebla y precipitación del día: de los ajustes (temperatura, punto de rocío, viento,
// visibilidad, código de tiempo, hora) a lo que dibuja el render (src/render/Weather.ts), lo que cae
// (src/fx/Precipitation.ts) y lo que nota la física (agarre de las ruedas). Sin nada del DOM ni de
// three.js: las pruebas lo importan en Node.
//
// De dónde sale cada cosa:
// - Koschmieder: alcance visual V = 3,912/β (contraste umbral del 2 %).
// - Lluvia: distribuciones de gotas de Marshall-Palmer (1948) y Joss y Waldvogel (1969),
//   N(D) = N0·e^(−ΛD), Λ = a·R^−0,21 mm⁻¹; con óptica geométrica (Q = 2) la extinción es
//   β = π·N0/Λ³: 0,365·R^0,63 km⁻¹ la lluvia continua, 0,509·R^0,63 la llovizna y 0,163·R^0,63 el
//   chubasco de tormenta (R en mm/h).
// - Nieve: sin una ley fiable por tipo de copo; se usa V ≈ 1000·S^−0,8 m (S mm/h de agua), que deja la
//   nevada moderada en 0,5–1 km, la definición de intensidad por visibilidad de los METAR.
// - Base de las nubes: fórmula de Espy, 125 m por cada °C entre temperatura y punto de rocío.
// - Niebla de radiación: aire casi saturado (T − Td ≲ 2,5 °C), cielo poco cubierto, viento flojo
//   (más de ~8 kt la mezcla la levanta a estratos) y capa límite estable (solveBoundaryLayer); se
//   disipa cuando el calor acumulado desde el amanecer ha calentado la capa.
// - Pista mojada: ver `SURFACE_GRIP`.

import type { CloudPreset } from '../config.ts'
import { heatSinceSunrise, sinSolarElevation, solveBoundaryLayer } from './wind/boundaryLayer.ts'

export type PrecipKind = 'none' | 'drizzle' | 'rain' | 'shower' | 'snow'

/** Lo que pone el menú al elegir cada precipitación: código WMO e intensidad (mm/h de agua). */
export const PRECIP_PRESETS: Record<PrecipKind, { code: number; rate: number }> = {
  none: { code: -1, rate: 0 },
  drizzle: { code: 53, rate: 0.4 },
  rain: { code: 63, rate: 4 },
  shower: { code: 82, rate: 25 },
  snow: { code: 73, rate: 0.8 },
}

/** Visibilidad (m) a partir de la cual no se añade bruma: el aire limpio de siempre. */
export const VIS_CLEAR = 30000

/** Clase de precipitación del código de tiempo WMO (los del tiempo real) y la intensidad. */
export function precipKind(code: number, rate: number): PrecipKind {
  if (code >= 51 && code <= 57) return 'drizzle'
  if (code >= 61 && code <= 67) return 'rain'
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow'
  if ((code >= 80 && code <= 82) || code >= 95) return 'shower'
  if (!(rate > 0)) return 'none'
  return rate < 0.5 ? 'drizzle' : rate >= 10 ? 'shower' : 'rain'
}

/** Fracción de nieve a una temperatura (°C): los copos aguantan hasta ~2 °C antes de fundirse. */
export function snowFraction(tC: number): number {
  return Math.min(1, Math.max(0, (2.5 - tC) / 2))
}

/** Extinción (1/m) de la precipitación líquida o de la nieve. */
export function precipExtinction(kind: PrecipKind, rate: number, snow: number): number {
  if (kind === 'none' || !(rate > 0)) return 0
  const k = kind === 'drizzle' ? 0.509 : kind === 'shower' ? 0.163 : 0.365
  const rain = k * Math.pow(rate, 0.63) * 1e-3
  const snowB = 3.912 / (1000 * Math.pow(rate, -0.8))
  return rain + (snowB - rain) * snow
}

/**
 * Agarre de las ruedas respecto al asfalto seco (multiplica el μ de frenada y el lateral).
 * - Seco: μ de frenada 0,75 (0,725 del freno + 0,025 de rodadura), el de siempre.
 * - Mojado: 0,50. Asfalto mojado da 0,4–0,6 (la OACI llama «buena» a la frenada con μ ≥ 0,40 y da
 *   clave 5 a la pista mojada; el CS-25.109 da ~0,5–0,6 a baja velocidad con neumáticos de poca
 *   presión). La carrera con frenos sale ×1,5; con la parte en el aire, el +15 % de distancia de
 *   aterrizaje en pista mojada de los manuales ligeros (CAA Safety Sense 7).
 * - Nieve: 0,30 (nieve compacta o húmeda, clave 3 «media» de la OACI: 0,30–0,35).
 */
export const SURFACE_GRIP = { dry: 1, wet: (0.5 - 0.025) / 0.725, snow: (0.3 - 0.025) / 0.725 } as const

export interface WeatherInput {
  /** temperatura y punto de rocío en el suelo de la salida (°C) */
  oatC: number
  dewPointC: number
  /** viento a 10 m (m/s) */
  wind: number
  /** visibilidad del menú o del tiempo real (m) */
  visibility: number
  /** precipitación (mm/h) y código WMO */
  precip: number
  weatherCode: number
  clouds: CloudPreset
  /** con la atmósfera estándar la base de las nubes es la de cada preset */
  isa: boolean
  lat: number
  lon: number
  dayOfYear: number
  /** hora UTC (decimal) */
  utcHours: number
}

export interface WeatherState {
  /** bruma: extinción añadida en el suelo de la salida (1/m), altura de escala (m) y polvo (0 húmeda … 1 calima) */
  hazeBeta: number
  hazeH: number
  dust: number
  /** niebla de radiación: fuerza 0..1, extinción (1/m) y espesor sobre el suelo de la salida (m) */
  fog: number
  fogBeta: number
  fogDepth: number
  /** por qué no hay niebla (o '' si la hay): para la nota del menú */
  fogWhy: '' | 'dry' | 'wind' | 'cloud' | 'day'
  /** base de las nubes sobre el suelo (m) según Espy, o null si manda el preset */
  cloudBaseAgl: number | null
  kind: PrecipKind
  /** intensidad (mm/h) y extinción (1/m) de la lluvia y de la nieve por separado (la fase depende de la altura) */
  rate: number
  rainBeta: number
  snowBeta: number
  /** alcance visual en el suelo de la salida con todo junto (m) */
  visibility: number
}

const COVER: Record<CloudPreset, number> = { clear: 0, fair: 0.22, scattered: 0.4, overcast: 0.95 }
const PRESET_BASE: Record<CloudPreset, number> = { clear: 1e9, fair: 1300, scattered: 1150, overcast: 900 }
/** alcance visual del aire limpio del render (Rayleigh + aerosol de fondo de la atmósfera de takram) */
const BASE_VIS = 150000
const sat = (x: number) => Math.min(1, Math.max(0, x))
const smooth = (a: number, b: number, x: number) => {
  const t = sat((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}

export function solveWeather(i: WeatherInput): WeatherState {
  const spread = Math.max(0, i.oatC - Math.min(i.dewPointC, i.oatC))
  const kind = precipKind(i.weatherCode, i.precip)
  // (el tiempo real da a veces el código de lluvia con 0,0 mm en el intervalo)
  const rate = kind === 'none' ? 0 : Math.max(i.precip, kind === 'shower' ? 2 : 0.2)

  // --- bruma: lo que falta hasta la visibilidad pedida (Koschmieder) ---
  const V = Math.max(50, i.visibility)
  const ramp = smooth(VIS_CLEAR, 20000, V)
  const hazeBeta = Math.max(0, 3.912 / V - 3.912 / BASE_VIS) * ramp
  // calima: aire seco con polvo; con el aire húmedo, bruma de gotitas (y por debajo de ~1,5 km ya es niebla)
  const dust = kind === 'none' ? smooth(6, 14, spread) * smooth(1200, 4000, V) : 0
  // espesor: el polvo llena varios km; la bruma húmeda, la capa de mezcla; la niebla, 100–300 m
  const lv = sat(Math.log(V / 800) / Math.log(5000 / 800))
  const hazeH = 220 + (900 + 2100 * dust - 220) * lv

  // --- niebla de radiación ---
  const cover = COVER[i.clouds] ?? 0
  const sinElev = sinSolarElevation(i.lat, i.lon, i.dayOfYear, i.utcHours)
  const heat = heatSinceSunrise(i.lat, i.lon, i.dayOfYear, i.utcHours, cover, i.oatC + 273.15)
  const bl = solveBoundaryLayer({
    speed10: i.wind,
    fromDeg: 0,
    latDeg: i.lat,
    sinElev,
    cloud: cover,
    tempC: i.oatC,
    cloudBaseAgl: null,
    heat,
  })
  const kt = i.wind / 0.514444
  const moist = sat((2.5 - spread) / 1.5)
  const calm = 1 - smooth(6, 9, kt)
  const sky = 1 - smooth(0.5, 0.9, cover)
  // espesor: la capa estable de la noche (más honda con algo de viento), entre 30 y 180 m
  const depth0 = Math.min(180, Math.max(30, 30 + 22 * kt))
  // de día el suelo la calienta desde abajo: se va cuando el calor acumulado ha subido ~3 °C la capa
  // (de noche hace falta la capa estable del modelo de viento: enfriamiento por radiación sin mezcla)
  const persist = heat > 0 ? 1 - sat(heat / (depth0 * 3)) : bl.kind === 'stable' ? 1 : 0
  const fog = kind === 'none' ? moist * calm * sky * persist : 0
  const fogWhy = fog > 0.02 ? '' : moist <= 0 ? 'dry' : calm <= 0.02 ? 'wind' : sky <= 0.02 ? 'cloud' : 'day'
  const fogDepth = fog > 0.02 ? depth0 * (0.5 + 0.5 * fog) : 0
  // en la niebla se ve a 150–700 m
  const fogBeta = fog > 0.02 ? 3.912 / (150 + 550 * (1 - fog)) : 0

  // --- base de las nubes (Espy); con ISA, la de cada preset ---
  // (los cúmulos nacen de las térmicas: nunca a ras de suelo; el cubierto sí baja a estratos)
  const cloudBaseAgl = i.isa || i.clouds === 'clear' ? null : Math.min(PRESET_BASE[i.clouds], Math.max(i.clouds === 'overcast' ? 60 : 450, 125 * spread))

  const rainBeta = precipExtinction(kind, rate, 0)
  const snowBeta = precipExtinction(kind, rate, 1)
  const groundSnow = snowFraction(i.oatC)
  const total = 3.912 / BASE_VIS + hazeBeta + fogBeta + rainBeta + (snowBeta - rainBeta) * groundSnow
  return { hazeBeta, hazeH, dust, fog, fogBeta, fogDepth, fogWhy, cloudBaseAgl, kind, rate, rainBeta, snowBeta, visibility: 3.912 / total }
}
