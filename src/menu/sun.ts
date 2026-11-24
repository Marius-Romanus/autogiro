// Hora local de la salida y salida/puesta del sol (para el arco del sol del menú).
//
// La hora del menú es la hora local del sitio: en España, la oficial (CET/CEST, Canarias una
// hora menos); fuera, la solar redondeada a horas (longitud / 15). main.applySettings la pasa a
// UTC con la misma función, así el arco y el cielo del simulador coinciden.

import { isInSpain } from '../config.ts'

const DEG = Math.PI / 180

/** Horas que hay que sumar a UTC para tener la hora local del menú. */
export function localUtcOffset(lat: number, lon: number, dayOfYear: number): number {
  if (isInSpain(lat, lon)) {
    const summer = dayOfYear > 87 && dayOfYear < 299
    // Canarias, una hora menos que la península
    return (summer ? 2 : 1) - (lon < -12 ? 1 : 0)
  }
  return Math.round(lon / 15)
}

export type SunTimes =
  | { kind: 'normal'; rise: number; set: number }
  | { kind: 'polarDay' }
  | { kind: 'polarNight' }

/**
 * Salida y puesta del sol en hora local (horas decimales), con la aproximación de la NOAA
 * (ecuación del tiempo y declinación por series de Fourier; refracción + radio del disco = 0,833°).
 */
export function sunTimes(lat: number, lon: number, dayOfYear: number, utcOffset: number): SunTimes {
  const g = ((2 * Math.PI) / 365) * (dayOfYear - 1)
  const eqTime =
    229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g))
  const decl =
    0.006918 -
    0.399912 * Math.cos(g) +
    0.070257 * Math.sin(g) -
    0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) +
    0.00148 * Math.sin(3 * g)
  const phi = lat * DEG
  const cosH = Math.cos(90.833 * DEG) / (Math.cos(phi) * Math.cos(decl)) - Math.tan(phi) * Math.tan(decl)
  if (cosH > 1) return { kind: 'polarNight' }
  if (cosH < -1) return { kind: 'polarDay' }
  const h = Math.acos(cosH) / DEG
  const wrap = (x: number) => ((x % 24) + 24) % 24
  const rise = wrap((720 - 4 * (lon + h) - eqTime) / 60 + utcOffset)
  const set = wrap((720 - 4 * (lon - h) - eqTime) / 60 + utcOffset)
  return { kind: 'normal', rise, set }
}
