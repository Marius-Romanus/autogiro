// Tiempo real (src/menu/openMeteo.ts): de la respuesta de Open-Meteo a los ajustes del simulador.
//   node --experimental-strip-types tools/weather-test.ts [en-vivo]
// Sin argumentos no sale a la red: usa respuestas guardadas. Con «en-vivo» pide también el tiempo de
// ahora en Casarrubios y en Nueva York y comprueba que la respuesta se entiende.
import { cloudPreset, fetchRealWeather, gustTurbulence, localNow, parseOpenMeteo, realQnh, realWeatherSettings } from '../src/menu/openMeteo.ts'
import { AirModel, QNH_STD, qnhFromStation } from '../src/sim/airMass.ts'

let fails = 0
function check(name: string, ok: boolean, text = ''): void {
  if (!ok) fails++
  console.log(`${ok ? ' OK  ' : 'FALLA'} ${name}${text ? `: ${text}` : ''}`)
}

// respuesta real de Open-Meteo en LEMT (25-11-2026, 03:00 hora local)
const LEMT = {
  latitude: 40.22164,
  longitude: -4.0119257,
  utc_offset_seconds: 3600,
  timezone: 'Europe/Madrid',
  elevation: 624.0,
  current: {
    time: '2026-11-25T03:00',
    interval: 900,
    temperature_2m: 8.3,
    dew_point_2m: 6.5,
    pressure_msl: 1017.6,
    surface_pressure: 943.9,
    wind_speed_10m: 12.6,
    wind_direction_10m: 238,
    wind_gusts_10m: 23.7,
    cloud_cover: 100,
    cloud_cover_low: 89,
    cloud_cover_mid: 100,
    cloud_cover_high: 0,
    visibility: 21080.0,
    precipitation: 0.0,
    weather_code: 3,
  },
}

const w = parseOpenMeteo(LEMT)
const qnh = realQnh(w)
check('QNH desde la presión en superficie', Math.abs(qnh - 1016.9) < 0.2, `${qnh.toFixed(1)} hPa (pressure_msl ${w.pMsl})`)
// el QNH, por definición, hace que el altímetro marque la elevación en el suelo
{
  const am = new AirModel()
  am.set({ isa: false, oatC: w.tempC, qnh, dewPointC: w.dewC })
  am.elev = w.elevation
  const p = am.pressure(w.elevation) / 100
  check('Presión en el suelo = la de Open-Meteo', Math.abs(p - w.pSurface) < 0.01, `${p.toFixed(2)} hPa`)
  check('Altímetro en el suelo = elevación', Math.abs(am.altimeter(w.elevation) - w.elevation) < 0.01)
}
check('QNH estándar al nivel del mar', Math.abs(qnhFromStation(QNH_STD, 0) - QNH_STD) < 1e-9)

// 25-11-2026 02:07 UTC: en LEMT, 03:07 del 25 de noviembre (día 329)
const now = Date.UTC(2026, 10, 25, 2, 7)
const s = realWeatherSettings(w, 40.235, -4.0264, now)
check(
  'Ajustes de LEMT',
  s.isa === false &&
    s.oatC === 8.3 &&
    s.dewPointC === 6.5 &&
    s.windFrom === 240 &&
    s.windSpeed === 13 &&
    s.windGustKt === 24 &&
    s.clouds === 'overcast' &&
    s.visibility === 21080 &&
    s.precip === 0 &&
    s.weatherCode === 3 &&
    s.dayOfYear === 329 &&
    Math.abs(s.hour - (3 + 7 / 60)) < 1e-9,
  JSON.stringify(s),
)
check('Turbulencia de las rachas', s.turbulence >= 0.7 && s.turbulence <= 1, `12,6 kt con rachas de 23,7 → ${s.turbulence}`)
check('Sin rachas: casi sin turbulencia', gustTurbulence(8, 8) === 0.05)
check('Rachas moderadas', Math.abs(gustTurbulence(10, 16) - 0.6) < 0.11, `10 kt, rachas 16 → ${gustTurbulence(10, 16)}`)

// cielo
const sky = (low: number, mid: number, high: number, code = 0) => cloudPreset({ low, mid, high, cover: Math.max(low, mid, high), code })
check('Despejado', sky(0, 5, 0) === 'clear')
check('Solo cirros: despejado', sky(0, 0, 100) === 'clear')
check('Cúmulos', sky(25, 0, 0) === 'fair')
check('Nubes dispersas', sky(10, 50, 30) === 'scattered')
check('Cubierto', sky(90, 40, 0) === 'overcast')
check('Lluvia: cubierto', sky(40, 30, 0, 63) === 'overcast')
check('Chubascos: al menos dispersas', sky(20, 0, 0, 80) === 'scattered')

// hora local: verano en España (UTC+2), Canarias (UTC+1) y fuera (solar redondeada)
const summer = localNow(40.2, -4, Date.UTC(2026, 6, 15, 12, 30))
check('Madrid en julio', summer.hour === 14.5 && summer.dayOfYear === 196, JSON.stringify(summer))
const canary = localNow(28.1, -15.4, Date.UTC(2026, 0, 1, 0, 30))
check('Canarias en Año Nuevo', canary.hour === 0.5 && canary.dayOfYear === 1, JSON.stringify(canary))
const ny = localNow(40.7, -74, Date.UTC(2026, 0, 1, 3, 0))
check('Nueva York pasada la medianoche UTC: aún 31 de diciembre', ny.hour === 22 && ny.dayOfYear === 365, JSON.stringify(ny))

// errores
let threw = ''
try {
  parseOpenMeteo({ error: true, reason: 'x' })
} catch (e) {
  threw = (e as Error).message
}
check('Respuesta sin datos → error', threw !== '', threw)

if (process.argv.includes('en-vivo')) {
  for (const [name, lat, lon] of [
    ['Casarrubios', 40.235, -4.0264],
    ['Nueva York', 40.7128, -74.006],
  ] as const) {
    try {
      const live = await fetchRealWeather(lat, lon, AbortSignal.timeout(15000))
      const ls = realWeatherSettings(live, lat, lon)
      check(`En vivo: ${name}`, Number.isFinite(ls.oatC) && ls.qnh > 900 && ls.qnh < 1080, `${ls.oatC} °C, QNH ${ls.qnh}, ${ls.windFrom}°/${ls.windSpeed} kt, ${ls.clouds}, ${ls.hour.toFixed(2)} h día ${ls.dayOfYear}`)
    } catch (e) {
      check(`En vivo: ${name}`, false, (e as Error).message)
    }
  }
}

console.log(fails ? `\n${fails} comprobación(es) con fallos.` : '\nTodo correcto.')
process.exit(fails ? 1 : 0)
