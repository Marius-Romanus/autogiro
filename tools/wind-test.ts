// Banco de pruebas del viento del terreno (src/sim/wind): perfil y giro con la altura, relieve,
// estela de obstáculos, térmicas y turbulencia, contra la teoría y datos publicados.
//   node --experimental-strip-types tools/wind-test.ts [v]
// Cada línea: OK/FALLA, la magnitud, el valor del modelo y el rango esperado con su fuente.

import { WindModel } from '../src/sim/atmosphere.ts'
import {
  heatSinceSunrise,
  localProfile,
  sinSolarElevation,
  solveBoundaryLayer,
  refSpeed,
  turnAt,
  turbulenceAt,
  type BoundaryLayer,
} from '../src/sim/wind/boundaryLayer.ts'
import { LocalWind, newWindSample, type SurfacePoint } from '../src/sim/wind/LocalWind.ts'
import { buildReliefSync } from '../src/sim/wind/relief.ts'
import { allenProfile, sampleThermals, thermalField, type ThermalSample } from '../src/sim/wind/thermals.ts'
import { obstacleWake, type ObstacleGrid, type WakeSample } from '../src/sim/wind/wakes.ts'

let fails = 0
let total = 0
function check(name: string, v: number, lo: number, hi: number, ref: string, digits = 2): void {
  total++
  const ok = v >= lo && v <= hi
  if (!ok) fails++
  console.log(`${ok ? ' OK  ' : 'FALLA'} ${name.padEnd(64)} ${v.toFixed(digits).padStart(8)}   [${lo} … ${hi}]  ${ref}`)
}
const KT = 0.514444
const LEMT = { lat: 40.07, lon: -4.2 }

/** Capa límite de un día: lugar, día del año, hora UTC, nubes (0..1), base de cúmulos, temperatura y viento. */
function day(lat: number, lon: number, doy: number, utc: number, cloud: number, base: number | null, tempC: number, speed10: number, fromDeg = 270): BoundaryLayer {
  return solveBoundaryLayer({
    speed10,
    fromDeg,
    latDeg: lat,
    sinElev: sinSolarElevation(lat, lon, doy, utc),
    cloud,
    tempC,
    cloudBaseAgl: base,
    heat: heatSinceSunrise(lat, lon, doy, utc, cloud, tempC + 273.15),
  })
}

// ---------------------------------------------------------------------------
console.log('\n— Perfil vertical, giro y turbulencia —')
{
  // día cubierto con viento: casi neutro
  const n = day(LEMT.lat, LEMT.lon, 80, 12, 1, 900, 12, 8)
  const p = { speed: 0, ustar: 0 }
  check('neutro: U(10 m) = viento del menú (m/s)', localProfile(n, 10, 0.03, false, p).speed, 7.8, 8.2, 'definición')
  check('neutro: U(2 m)/U(10 m)', localProfile(n, 2, 0.03, false, p).speed / 8, 0.68, 0.76, 'ley logarítmica: ln(2/z0)/ln(10/z0) = 0,72')
  check('neutro: U(100 m)/U(10 m)', refSpeed(n, 100) / 8, 1.3, 1.5, 'ley logarítmica 1,40')
  check('neutro: viento en lo alto / U(10 m)', n.top / 8, 1.5, 2.2, 'ley de resistencia geostrófica (Atlas Eólico Europeo)')
  check('neutro: giro total (°)', (n.turn * 180) / Math.PI, 12, 28, '15–25° sobre tierra (Stull 1988)', 1)
  const t = { sigH: 0, sigW: 0, lenH: 0, lenW: 0, sigSlow: 0, lenSlow: 0 }
  localProfile(n, 10, 0.03, false, p)
  turbulenceAt(n, 10, p.ustar, t)
  check('neutro: intensidad de turbulencia a 10 m, σ/U', t.sigH / 8, 0.12, 0.19, '≈ 1/ln(z/z0) = 0,17 (EN 1991-1-4)')
  check('neutro: σw/σh a 10 m', t.sigW / t.sigH, 0.45, 0.7, 'σw = 1,25 u*, σu = 2,39 u* (Panofsky y Dutton)')

  // rugosidad del sitio (Wieringa): ciudad y agua frente a la hierba del aeródromo
  const city = localProfile(n, 10, 1.5, false, { speed: 0, ustar: 0 })
  const sea = localProfile(n, 10, 0.0002, true, { speed: 0, ustar: 0 })
  check('ciudad (z0 = 1,5): U(10 m) respecto al aeródromo', city.speed / 8, 0.6, 0.76, 'Wieringa 1986, mezcla a 60 m: 0,67')
  check('mar (z0 = 0,0002): U(10 m) respecto al aeródromo', sea.speed / 8, 1.07, 1.19, 'Wieringa 1986: 1,12')
  check('ciudad: u* respecto al aeródromo', city.ustar / p.ustar, 1.6, 2.6, 'más fricción = más turbulencia')
  check('mar: u* respecto al aeródromo', sea.ustar / p.ustar, 0.5, 0.8, 'menos turbulencia sobre el agua')

  // mediodía de verano y noche despejada en LEMT
  const d = day(LEMT.lat, LEMT.lon, 196, 12.5, 0.22, 1300, 32, 4)
  const nt = day(LEMT.lat, LEMT.lon, 196, 1, 0, null, 18, 3)
  check('día de verano: U(100 m)/U(10 m)', refSpeed(d, 100) / refSpeed(d, 10), 1.02, 1.28, 'capa mezclada: exponente 0,07–0,10 → 1,17–1,26')
  check('día de verano: giro total (°)', (d.turn * 180) / Math.PI, 2, 12, 'capa convectiva: 5–10° (Stull 1988)', 1)
  check('noche despejada: U(50 m)/U(10 m)', refSpeed(nt, 50) / refSpeed(nt, 10), 1.6, 3.2, 'estable: exponente 0,3–0,6 → 1,6–2,6')
  check('noche despejada: giro total (°)', (nt.turn * 180) / Math.PI, 25, 46, 'estable: 30–45° (Stull 1988)', 1)
  check('noche despejada: altura de la capa límite (m)', nt.h, 30, 250, 'capa nocturna de decenas a ~200 m', 0)
  check('día de verano: altura de la capa límite (m)', d.h, 1000, 2500, 'capa convectiva de 1–2,5 km', 0)
  const td = turbulenceAt(d, 30, localProfile(d, 30, 0.03, false, p).ustar, { sigH: 0, sigW: 0, lenH: 0, lenW: 0, sigSlow: 0, lenSlow: 0 })
  const tn = turbulenceAt(nt, 30, localProfile(nt, 30, 0.03, false, p).ustar, { sigH: 0, sigW: 0, lenH: 0, lenW: 0, sigSlow: 0, lenSlow: 0 })
  check('día de verano: racha horizontal lenta (convectiva) / w*', td.sigSlow / d.wstar, 0.55, 0.65, 'σu ≈ 0,6·w* (Panofsky et al. 1977)')
  check('σw a 30 m de noche respecto a la del día', tn.sigW / td.sigW, 0.02, 0.4, 'de noche, poca turbulencia')
  check('giro a 300 m de noche (°), hemisferio norte', (turnAt(nt, 300) * 180) / Math.PI, 20, 46, 'a la derecha al subir', 1)
  const south = day(-34, 18.5, 15, 1, 0, null, 18, 3)
  check('giro a 300 m de noche (°), hemisferio sur', (turnAt(south, 300) * 180) / Math.PI, -46, -20, 'a la izquierda al subir', 1)
  check('giro a 10 m (°)', (turnAt(nt, 10) * 180) / Math.PI, -0.01, 0.01, 'a 10 m, la dirección del menú')
}

// ---------------------------------------------------------------------------
console.log('\n— Relieve (teoría lineal de Jackson-Hunt) —')
const LEVELS = [5, 15, 40, 100, 220, 450, 900, 1800]
function terrain(n: number, dx: number, f: (x: number, y: number) => number): Float32Array {
  const h = new Float32Array(n * n)
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) h[j * n + i] = f((i - n / 2) * dx, (j - n / 2) * dx)
  return h
}
/** Viento local sobre un relieve analítico centrado en el origen. */
function overRelief(bl: BoundaryLayer, n: number, dx: number, f: (x: number, y: number) => number): LocalWind {
  const w = new LocalWind(bl)
  w.site.fine = buildReliefSync(terrain(n, dx, f), n, dx, (-n / 2) * dx, (-n / 2) * dx, { levels: LEVELS })
  return w
}
{
  // viento del oeste de 8 m/s, día cubierto (neutro)
  const bl = day(LEMT.lat, LEMT.lon, 80, 12, 1, 900, 12, 8, 270)
  const s = newWindSample()
  const H = 200
  const L = 800
  // loma 2D (campana de Agnesi) de norte a sur, viento perpendicular
  const ridge = (x: number) => H / (1 + (x / L) ** 2)
  const w = overRelief(bl, 128, 100, ridge)
  // media ladera de barlovento (pendiente máxima en x = −L/√3)
  const xs = -L / Math.sqrt(3)
  const slope = (ridge(xs + 1) - ridge(xs - 1)) / 2
  w.sample(xs, 0, 10, 0, 0, 0, s)
  check('ladera de barlovento: w/(U·pendiente) a 10 m', s.lift / (s.base * slope), 0.75, 1.25, 'flujo paralelo a la ladera: w = U·pendiente')
  console.log(`        (pendiente ${slope.toFixed(3)}, U ${s.base.toFixed(1)} m/s → ascendencia ${s.lift.toFixed(2)} m/s)`)
  w.sample(xs, 0, 150, 0, 0, 0, s)
  check('ladera de barlovento: ascendencia a 150 m respecto a la de 10 m', s.lift / s.base / slope, 0.45, 0.95, 'se atenúa con e^(−κz); a 150 m queda más de la mitad')
  w.sample(0, 0, 10, 0, 0, 0, s)
  check('cresta de loma 2D: ΔS a 10 m en unidades de H/L', s.speedUp / (H / L), 1.5, 2.5, 'Jackson-Hunt / Taylor y Lee 1984: 2,0')
  check('cresta: velocidad vertical (m/s)', s.up, -0.25, 0.25, 'en la cumbre, ni sube ni baja')
  w.sample(-xs, 0, 10, 0, 0, 0, s)
  check('ladera de sotavento suave: w/(U·pendiente) a 10 m', s.lift / (s.base * slope), -1.25, -0.75, 'descendencia simétrica (sin desprendimiento)')
  check('ladera de sotavento suave: déficit por desprendimiento', s.lee, 0, 0.01, 'pendiente 0,16 < 0,3: flujo adherido (Wood 1995)')
  w.sample(-3 * L, 0, 10, 0, 0, 0, s)
  check('pie de barlovento: ΔS a 10 m', s.speedUp, -0.35, -0.02, 'frenado al pie de la loma')

  // cerro redondo
  const hill = overRelief(bl, 128, 100, (x, y) => H / Math.pow(1 + (x * x + y * y) / (L * L), 1.5))
  hill.sample(0, 0, 10, 0, 0, 0, s)
  check('cumbre de cerro 3D: ΔS a 10 m en unidades de H/L', s.speedUp / (H / L), 1.0, 2.1, 'Taylor y Lee 1984: 1,6')

  // Askervein (Hébridas, 1982–83): H = 116 m, L ≈ 250 m en el eje corto, 1 km × 2 km
  const ax = 250 / Math.sqrt(Math.log(2))
  const ask = overRelief(bl, 128, 50, (x, y) => 116 * Math.exp(-((x / ax) ** 2) - (y / (2 * ax)) ** 2))
  ask.sample(0, 0, 10, 0, 0, 0, s)
  check('Askervein: ΔS a 10 m en la cumbre', s.speedUp, 0.6, 1.1, 'medido ≈ 0,8–0,9 (Taylor y Teunissen 1987)')
  ask.sample(0, 0, 100, 0, 0, 0, s)
  check('Askervein: ΔS a 100 m sobre la cumbre', s.speedUp, 0.08, 0.4, 'se apaga con la altura (medido ≈ 0,15–0,25)')

  // cresta escarpada: sotavento con desprendimiento
  const Hs = 300
  const Ls = 300
  const steep = (x: number) => Hs / (1 + (x / Ls) ** 2)
  const st = overRelief(bl, 128, 100, steep)
  st.sample(3 * Hs, 0, 30, 0, 0, 0, s)
  const open = s.base
  check('sotavento de cresta escarpada, a 3 alturas: viento/viento libre', Math.hypot(s.e, s.n) / open, 0.05, 0.6, 'zona desprendida: viento flojo y variable')
  check('sotavento, a 3 alturas: σ horizontal / viento en la cresta', s.sigH / refSpeed(bl, Hs), 0.2, 0.5, 'rotor: σ ≈ 0,3·U (Kaimal y Finnigan 1994)')
  st.sample(4 * Hs, 0, 0.5 * Hs, 0, 0, 0, s)
  check('sotavento, a 4 alturas y media altura: velocidad vertical (m/s)', s.up, -4, -0.5, 'descendencia de sotavento')
  st.sample(25 * Hs > 6000 ? 6000 : 25 * Hs, 0, 30, 0, 0, 0, s)
  check('sotavento, a 20 alturas: déficit', s.lee, 0, 0.12, 'la estela se acaba a 10–20 alturas')
  st.sample(-Ls, 0, 30, 0, 0, 0, s)
  check('barlovento de la cresta escarpada: ascendencia (m/s)', s.up, 2, 7, 'U·pendiente ≈ 8·0,5, acotada')
  check('barlovento de la cresta escarpada: déficit', s.lee, 0, 0.001, 'a barlovento no hay estela')
}

// ---------------------------------------------------------------------------
console.log('\n— Estela de obstáculos (Perera / WAsP) —')
{
  const n = 128
  const cell = 8
  const grid = (f: (x: number, y: number) => [number, number]): ObstacleGrid => {
    const h = new Float32Array(n * n)
    const por = new Float32Array(n * n)
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const [hh, pp] = f((i + 0.5 - n / 2) * cell, (j + 0.5 - n / 2) * cell)
        h[j * n + i] = hh
        por[j * n + i] = pp
      }
    return { n, cell, e0: (-n / 2) * cell, n0: (-n / 2) * cell, h, por }
  }
  const hB = 6
  // nave larga de 6 m de alto y 16 m de fondo, de norte a sur; viento del oeste; su cara de sotavento en x = 0
  const long = grid((x, y) => (x > -16 && x < 0 && Math.abs(y) < 400 ? [hB, 0] : [0, 0]))
  const o: WakeSample = { deficit: 0, sigma: 0, scale: 0 }
  const at = (g: ObstacleGrid, x: number, y: number, z: number, we = 1, wn = 0) => 1 - obstacleWake(g, x, y, z, we, wn, 0.05, o).deficit
  check('nave larga: viento a 3 alturas, z = h/2 (fracción del libre)', at(long, 3 * hB, 0, hB / 2), 0.1, 0.32, 'barrera densa: 15–30 % (Nägeli 1946)')
  check('nave larga: viento a 5 alturas', at(long, 5 * hB, 0, hB / 2), 0.18, 0.45, 'barrera densa: 25–40 %')
  check('nave larga: viento a 10 alturas', at(long, 10 * hB, 0, hB / 2), 0.42, 0.7, 'barrera densa: 50–65 %; Perera/WAsP ≈ 50 %')
  check('nave larga: viento a 20 alturas', at(long, 20 * hB, 0, hB / 2), 0.72, 0.93, 'barrera densa: 80–90 %')
  check('nave larga: viento a 5 alturas y z = 2·h', at(long, 5 * hB, 0, 2 * hB), 0.88, 1, 'por encima de dos alturas apenas se nota')
  check('nave larga: viento a 10 alturas y z = 1,5·h', at(long, 10 * hB, 0, 1.5 * hB), 0.6, 0.95, 'la estela sube al alejarse')
  check('nave larga: a barlovento (5 alturas antes)', at(long, -16 - 5 * hB, 0, hB / 2), 0.999, 1, 'la estela va a sotavento')
  const d2 = 1 - at(long, 10 * hB, 0, hB / 2)
  // hangar suelto de 24 m de ancho
  const hangar = grid((x, y) => (x > -16 && x < 0 && Math.abs(y) < 12 ? [hB, 0] : [0, 0]))
  const d3 = 1 - at(hangar, 10 * hB, 0, hB / 2)
  check('hangar de 24 m: déficit a 10 alturas respecto a la nave larga', d3 / d2, 0.4, 0.8, 'ancho finito: 1/(1 + 0,2·x/ancho) = 0,67 (Taylor y Salmon 1993)')
  check('hangar: a 10 alturas pero 40 m al lado', 1 - at(hangar, 10 * hB, 40, hB / 2), 0, 0.06, 'fuera de la sombra')
  // arbolado (porosidad 0,5) de 10 m
  const trees = grid((x, y) => (x > -24 && x < 0 && Math.abs(y) < 400 ? [10, 0.5] : [0, 0]))
  check('hilera de árboles de 10 m: viento a 5 alturas, z = 3 m', at(trees, 50, 0, 3), 0.4, 0.75, 'cortavientos poroso: 40–70 % (Heisler y DeWalle 1988)')
  // viento en diagonal sobre la nave larga: misma distancia a lo largo del viento
  const c = Math.SQRT1_2
  const dd = 1 - at(long, 10 * hB * c, 10 * hB * c - 100, hB / 2, c, c)
  check('nave larga con viento a 45°: déficit a 10 alturas (a lo largo del viento)', dd / d2, 0.6, 1.4, 'como de frente, sin contar celdas dos veces')
  // con el perfil completo: toma con viento cruzado tras un hangar
  const bl = day(LEMT.lat, LEMT.lon, 80, 12, 1, 900, 12, 15 * KT, 270)
  const w = new LocalWind(bl)
  w.site.obstacles = hangar
  const s = newWindSample()
  w.sample(30, 0, 2, 0, 0, 0, s)
  const sh = Math.hypot(s.e, s.n)
  w.sample(30, 200, 2, 0, 0, 0, s)
  const fr = Math.hypot(s.e, s.n)
  check('15 kt cruzados, 30 m tras el hangar a 2 m: viento (kt)', sh / KT, 1, 7, `libre a esa altura: ${(fr / KT).toFixed(1)} kt`, 1)
  w.sample(30, 0, 2, 0, 0, 0, s)
  check('  y turbulencia horizontal respecto al libre', s.sigH / (w.sample(30, 200, 2, 0, 0, 0, newWindSample()).sigH), 1.05, 3, 'más racheado tras el hangar')
}

// ---------------------------------------------------------------------------
console.log('\n— Térmicas (Allen 2006 / Lenschow y Stephens 1980) —')
{
  const scan = (bl: BoundaryLayer, z: number, heat: ((dx: number, dy: number) => number) | null = null) => {
    const tf = thermalField(bl, 196)
    const r = { max: 0, min: 0, mean: 0, up: 0, radius: 0, n: 0 }
    if (!tf) return r
    const o: ThermalSample = { w: 0, sigma: 0, dist: -1, radius: 0, peak: 0, de: 0, dn: 0 }
    for (let y = 0; y < 6000; y += 20)
      for (let x = 0; x < 6000; x += 20) {
        sampleThermals(tf, x, y, z, 1000, heat, o)
        r.n++
        r.mean += o.w
        if (o.w > 0.5) r.up++
        if (o.w > r.max) {
          r.max = o.w
          r.radius = o.radius
        }
        if (o.w < r.min) r.min = o.w
      }
    r.mean /= r.n
    r.up /= r.n
    return r
  }
  // 15 de julio, 14:30 locales, cúmulos de buen tiempo (base 1300 m), 32 °C, 6 kt
  const summer = day(LEMT.lat, LEMT.lon, 196, 12.5, 0.22, 1300, 32, 6 * KT)
  check('verano 14:30: calor sensible (W/m²)', summer.heatFlux, 180, 330, 'campo en verano a mediodía: 200–300 W/m²', 0)
  check('verano: altura de la capa convectiva zi (m)', summer.zi, 1299, 1301, 'la base de los cúmulos dibujados', 0)
  check('verano: w* (m/s)', summer.wstar, 1.7, 2.8, 'escala convectiva típica de verano: 2–2,5 m/s')
  const p = allenProfile(summer.zi, summer.wstar, 0.3 * summer.zi)
  check('verano: radio de la térmica a 0,3·zi (m)', p.r2, 60, 140, 'd ≈ 0,16·zi·(z/zi)^⅓ (Lenschow y Stephens): r ≈ 80 m')
  const sm = scan(summer, 0.3 * summer.zi)
  check('verano: núcleo más fuerte en 36 km² a 390 m (m/s)', sm.max, 2, 5.5, 'térmicas de verano en la meseta: 2–5 m/s')
  check('verano: mayor descendencia entre térmicas (m/s)', sm.min, -1.5, -0.05, 'descendencia suave del entorno')
  check('verano: fracción del área que sube > 0,5 m/s', sm.up, 0.03, 0.3, 'las ascendencias ocupan una fracción pequeña')
  check('verano: media de w en toda el área / w*', sm.mean / summer.wstar, -0.08, 0.2, 'lo que sube lo compensa lo que baja')
  const low = scan(summer, 60)
  check('verano: núcleo más fuerte a 60 m (m/s)', low.max, 0.5, 3, 'abajo las térmicas son estrechas y flojas (∝ z^⅓)')
  // 15 de enero, 10:30 locales, mismo cielo, 6 °C
  const winter = day(LEMT.lat, LEMT.lon, 15, 9.5, 0.22, 1300, 6, 6 * KT)
  check('invierno 10:30: calor sensible (W/m²)', winter.heatFlux, -20, 80, 'sol bajo: casi nada', 0)
  check('invierno: zi (m)', winter.zi, 0, 600, 'capa de mezcla baja a media mañana', 0)
  check('invierno: w* (m/s)', winter.wstar, 0, 1, 'convección débil')
  const wn = scan(winter, Math.max(60, 0.3 * winter.zi))
  check('invierno: núcleo más fuerte (m/s)', wn.max, 0, 1.3, 'térmicas flojas o ninguna')
  check('invierno: núcleo respecto al de verano', wn.max / sm.max, 0, 0.5, 'menos de la mitad que en verano (w* ∝ (H·zi)^⅓)')
  check('invierno: radio (m) respecto al de verano', wn.radius / Math.max(1, sm.radius), 0, 0.6, 'más estrechas (capa más baja)')
  // noche y cielo cubierto
  const night = day(LEMT.lat, LEMT.lon, 196, 1, 0, null, 18, 6 * KT)
  check('noche: hay térmicas (0 = no)', thermalField(night, 196) ? 1 : 0, 0, 0, 'de noche, ninguna', 0)
  const ovc = day(LEMT.lat, LEMT.lon, 196, 12.5, 0.95, 900, 22, 6 * KT)
  check('cubierto a mediodía: núcleo más fuerte respecto al de cúmulos', scan(ovc, 300).max / sm.max, 0, 0.75, 'sin sol directo, más flojas')
  // sobre el agua
  check('sobre el agua: núcleo más fuerte (m/s)', scan(summer, 390, () => 0).max, -1, 0.001, 'el agua no dispara térmicas')
  // determinismo y deriva con el viento
  const tf = thermalField(summer, 196)!
  const a: ThermalSample = { w: 0, sigma: 0, dist: -1, radius: 0, peak: 0, de: 0, dn: 0 }
  const b: ThermalSample = { ...a }
  let diff = 0
  let drift = 0
  for (let k = 0; k < 400; k++) {
    const x = 37 * k
    const y = 91 * k
    sampleThermals(tf, x, y, 400, 5000, null, a)
    sampleThermals(thermalField(summer, 196)!, x, y, 400, 5000, null, b)
    diff = Math.max(diff, Math.abs(a.w - b.w))
    sampleThermals(tf, x + tf.vE * 2, y + tf.vN * 2, 400, 5002, null, b)
    drift = Math.max(drift, Math.abs(a.w - b.w))
  }
  check('mismo sitio, misma hora, mismas condiciones: diferencia (m/s)', diff, 0, 0, 'campo determinista', 4)
  check('2 s después y desplazado con el viento: diferencia (m/s)', drift, 0, 0.05, 'las térmicas derivan con el viento', 4)
  check('velocidad de deriva / viento a 10 m', Math.hypot(tf.vE, tf.vN) / (6 * KT), 1.2, 1.5, 'viento de la capa de mezcla')
}

// ---------------------------------------------------------------------------
console.log('\n— Conjunto —')
{
  // sin datos del sitio: el perfil sobre hierba, sin relieve ni térmicas
  const bl = day(LEMT.lat, LEMT.lon, 80, 12, 1, 900, 12, 6 * KT, 250)
  const w = new LocalWind(bl)
  const s = w.sample(0, 0, 10, 0, 0, 0, newWindSample())
  // z0 del «campo» por defecto (0,05) algo mayor que el de la referencia (0,03)
  check('sin datos del sitio: viento a 10 m (kt)', Math.hypot(s.e, s.n) / KT, 5.6, 6.1, 'el del menú', 2)
  check('sin datos del sitio: rumbo de donde viene (°)', (Math.atan2(-s.e, -s.n) * 180) / Math.PI + 360, 249.9, 250.1, 'el del menú', 1)
  check('sin datos del sitio: velocidad vertical', s.up, 0, 0, 'ninguna')
  // suelo: agua a barlovento → más viento y menos turbulencia que con ciudad a barlovento
  const water: SurfacePoint = { z0: 0.0002, heat: 0, water: true }
  const town: SurfacePoint = { z0: 1.2, heat: 1.05, water: false }
  w.site.surface = () => water
  const a = w.sample(0, 0, 10, 0, 0, 0, newWindSample())
  w.site.surface = () => town
  const b = w.sample(0, 0, 10, 0, 0, 0, newWindSample())
  check('a 10 m sobre el mar / sobre ciudad: viento', Math.hypot(a.e, a.n) / Math.hypot(b.e, b.n), 1.25, 2, 'Wieringa: 1,12 / 0,72 (algo menos de día: la tierra calentada mezcla más)')
  check('a 10 m sobre el mar / sobre ciudad: turbulencia', a.sigH / b.sigH, 0.2, 0.5, 'u* mucho menor sobre el agua')
  // el modelo clásico sigue intacto si no se le engancha el viento local
  check('WindModel sin viento local: `local` es null (0)', new WindModel().local === null ? 0 : 1, 0, 0, 'las pruebas de la física no cambian', 0)
}

console.log(fails ? `\n${fails} de ${total} comprobaciones del viento FALLAN.` : `\nViento: las ${total} comprobaciones pasan.`)
process.exit(fails ? 1 : 0)
