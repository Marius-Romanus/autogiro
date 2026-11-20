// Validación del modelo de vuelo contra teoría de rotores y cifras reales de
// un autogiro biplaza de 100 CV (clase MTOsport / ELA-07).
//
//   node --experimental-strip-types tools/fdm-validate.ts [clave=valor ...] [secciones]
//
// Claves de ajuste: pitch (°), cd0, cd2, inertia, cdA, propEta, headBase, headAft, headFwd, stabArea…
// Secciones: glide level climb vert turn dual (por defecto, todas)
import { Vector3 } from 'three'
import { Autogyro, defaultControls, type Environment } from '../src/sim/autogyro.ts'
import { AIRFRAMES } from '../src/sim/airframes.ts'
import { applyTune, pickAirframe } from './af-override.ts'
import { isaDensity } from '../src/sim/atmosphere.ts'

const DT = 1 / 240
const flat = { heightAt: (_x: number, _z: number, n: Vector3) => (n.set(0, 1, 0), 0) }
const RHO = isaDensity(650)
const env: Environment = { rho: RHO, wind: new Vector3(), ground: flat }

const overrides: Record<string, number> = {}
const sections = new Set<string>()
let airframeId = 'generic'
for (const a of process.argv.slice(2)) {
  const m = a.match(/^(\w+)=(-?[\d.]+)$/)
  const f = a.match(/^af=(\w+)$/)
  if (f) {
    if (!(f[1] in AIRFRAMES)) throw new Error(`aparato desconocido: ${f[1]} (${Object.keys(AIRFRAMES).join(', ')})`)
    airframeId = f[1]
  } else if (m) overrides[m[1]] = Number(m[2])
  else sections.add(a)
}
const want = (s: string) => sections.size === 0 || sections.has(s)
console.log(`Aparato: ${airframeId}`)
const airframe = pickAirframe(airframeId)

export function make(dual = false): Autogyro {
  const ac = new Autogyro(airframe)
  applyTune(ac)
  ac.setLoad(dual)
  const rp = { ...ac.rotor.p }
  for (const [k, v] of Object.entries(overrides)) {
    if (k === 'pitch') rp.pitch = (v * Math.PI) / 180
    else if (k in rp) (rp as any)[k] = v
    else if (k in ac.tune) (ac.tune as any)[k] = v
    else throw new Error(`clave desconocida: ${k}`)
  }
  ac.rotor.p = rp
  return ac
}

interface Res {
  ias: number // km/h
  vs: number // m/s
  rpm: number
  pitch: number
  roll: number
  power: number // kW
  engRpm: number
  discAoA: number
  osc: number // amplitud de IAS en la ventana final (km/h)
  ld: number
  crash: string
  lat: number
  ped: number
  g: number
}

/** Vuela con palanca y gas fijos (más la estabilización básica del piloto) hasta el régimen permanente. */
function settle(o: { stick: number; throttle: number; v0: number; dual?: boolean; engineOff?: boolean; bank?: number; secs?: number }): Res {
  const ac = make(o.dual)
  ac.placeInAir(0, 3000, 0, 90, o.v0 / 3.6)
  if (o.engineOff) ac.engineOn = false
  const ctl = defaultControls()
  ctl.throttle = o.throttle
  ac.enginePower = 0
  const secs = o.secs ?? 80
  const win = 25
  let thRef = 0
  let t = 0
  let n = 0
  const acc = { ias: 0, vs: 0, rpm: 0, pitch: 0, roll: 0, power: 0, eng: 0, aoa: 0, lat: 0, ped: 0, g: 0, gs: 0 }
  let iasMin = 1e9
  let iasMax = -1e9
  let crash = ''
  const f = new Vector3()
  const r = new Vector3()
  while (t < secs) {
    f.set(1, 0, 0).applyQuaternion(ac.quat)
    r.set(0, 0, 1).applyQuaternion(ac.quat)
    const pitch = Math.asin(Math.max(-1, Math.min(1, f.y)))
    const roll = Math.asin(Math.max(-1, Math.min(1, -r.y)))
    thRef += ((pitch - thRef) / 8) * DT
    const sas = Math.max(-0.5, Math.min(0.5, -0.6 * ac.omega.z - 2.0 * (pitch - thRef)))
    ctl.pitch = Math.max(-1, Math.min(1, o.stick + sas))
    const bank = ((o.bank ?? 0) * Math.PI) / 180
    ctl.roll = Math.max(-1, Math.min(1, -1.3 * (roll - bank) - 0.35 * ac.omega.x + rollI))
    rollI += -0.25 * (roll - bank) * DT
    rollI = Math.max(-0.6, Math.min(0.6, rollI))
    ctl.yaw = Math.max(-1, Math.min(1, 1.6 * ac.beta + 0.3 * ac.omega.y))
    ac.step(DT, ctl, env)
    if (ac.crash) {
      crash = ac.crash.title
      break
    }
    if (t > secs - win) {
      const v = ac.ias * 3.6
      acc.ias += v
      acc.vs += ac.vs
      acc.rpm += ac.rotor.rpm
      acc.pitch += pitch * 57.3
      acc.roll += roll * 57.3
      acc.power += ac.enginePower / 1000
      acc.eng += ac.engineRpm
      acc.aoa += ac.rotor.discAoA * 57.3
      acc.lat += ctl.roll
      acc.ped += ctl.yaw
      acc.g += ac.gLoad
      acc.gs += Math.hypot(ac.vel.x, ac.vel.z)
      iasMin = Math.min(iasMin, v)
      iasMax = Math.max(iasMax, v)
      n++
    }
    t += DT
  }
  rollI = 0
  const k = 1 / Math.max(1, n)
  return {
    ias: acc.ias * k,
    vs: acc.vs * k,
    rpm: acc.rpm * k,
    pitch: acc.pitch * k,
    roll: acc.roll * k,
    power: acc.power * k,
    engRpm: acc.eng * k,
    discAoA: acc.aoa * k,
    osc: (iasMax - iasMin) / 2,
    ld: (acc.gs * k) / Math.max(0.01, -acc.vs * k),
    crash,
    lat: acc.lat * k,
    ped: acc.ped * k,
    g: acc.g * k,
  }
}
let rollI = 0

/** Gas necesario para vuelo nivelado con la palanca dada (bisección). */
function level(stick: number, v0: number, dual = false, bank = 0): Res & { throttle: number } {
  let lo = 0
  let hi = 1
  let res = settle({ stick, throttle: 1, v0, dual, bank })
  if (res.crash || res.vs < 0) return { ...res, throttle: 1 }
  for (let i = 0; i < 7; i++) {
    const mid = (lo + hi) / 2
    res = settle({ stick, throttle: mid, v0, dual, bank, secs: 70 })
    if (res.crash) break
    if (res.vs > 0) hi = mid
    else lo = mid
  }
  const thr = (lo + hi) / 2
  res = settle({ stick, throttle: thr, v0, dual, bank })
  return { ...res, throttle: thr }
}

const checks: { name: string; value: string; expected: string; ok: boolean }[] = []
function check(name: string, value: number, lo: number, hi: number, unit: string, digits = 0): void {
  checks.push({ name, value: `${value.toFixed(digits)} ${unit}`, expected: `${lo}–${hi} ${unit}`, ok: value >= lo && value <= hi })
}
const pad = (s: string | number, n: number) => String(s).padStart(n)

console.log(`Ajustes: ${JSON.stringify(overrides)}  ρ=${RHO.toFixed(3)} kg/m³ (650 m)`)
const massSolo = make(false).mass
const massDual = make(true).mass
console.log(`${airframe.engine.name}, ${(airframe.engine.maxPower / 735.5).toFixed(0)} CV · solo ${massSolo} kg, con pasajero ${massDual} kg (máximo ${airframe.mtow} kg) · CdA ${airframe.cdA} m² · rotor ${(2 * airframe.rotor.radius).toFixed(2)} m, cuerda ${airframe.rotor.chord} m`)
// Prestaciones de referencia de cada aparato: [mín, máx] alrededor de lo que publican
// el fabricante y los directorios (a 650 m y con el peso de la ficha).
//  · genérico (tipo MTOsport, 912 ULS): máxima 160–185 km/h, ascenso ~4–5 m/s
//  · ELA 07 Cougar con 914: crucero 140, VNE 175, máxima 185 km/h, ascenso 5–7 m/s
//  · ELA 10 Eclipse con 914: crucero 160, máxima 190 km/h, ascenso 5 m/s con carga
//  · fineza: 3,5–4,8 en los abiertos; la cabina cerrada, con un tercio menos de
//    resistencia de célula, planea algo mejor
//  · Cierva C.30A (ensayos de la RAE, ARC R&M 1859 y 1727, reducidos a nivel del mar): máxima
//    97 mph (156 km/h) con 1700 lb y 94 mph con 1900 lb; mínima nivelada 28 mph (45 km/h);
//    ascenso 540 ft/min (2,7 m/s) con 1700 lb y 355 ft/min (1,8) con 1900 lb; rotor a 200–240 rpm
//    (227 a 90 mph, 238 a 110 mph). Aquí a 650 m: un 6 % menos de potencia.
type Range = [number, number]
interface Ref {
  vmax: Range
  climbSolo: Range
  climbDual: Range
  glide: Range
  minSink?: Range
  vmin?: Range
  pmin?: Range
  /** vueltas de rotor: planeo y crucero con la palanca neutra (solo) y crucero con pasajero */
  rpmGlide?: Range
  rpmCruise?: Range
  rpmDual?: Range
  cruiseIas?: Range
}
const REFS: Record<string, Ref> = {
  generic: { vmax: [145, 185], climbSolo: [4.0, 6.5], climbDual: [2.3, 4.5], glide: [3.5, 4.8] },
  ela07: { vmax: [160, 185], climbSolo: [5.5, 8.5], climbDual: [3.5, 6.0], glide: [3.5, 4.8] },
  ela10: { vmax: [175, 200], climbSolo: [5.5, 8.5], climbDual: [3.8, 6.0], glide: [4.0, 5.6] },
  cierva: {
    vmax: [142, 165],
    climbSolo: [2.1, 3.4],
    climbDual: [1.2, 2.4],
    glide: [3.5, 5.5],
    minSink: [4.0, 6.5],
    vmin: [35, 56],
    pmin: [40, 70],
    rpmGlide: [205, 245],
    rpmCruise: [205, 245],
    rpmDual: [215, 255],
    cruiseIas: [90, 130],
  },
}
const REF = REFS[airframe.id] ?? REFS.generic
const R_ = (r: Range | undefined, d: Range): Range => r ?? d
const W = massSolo * 9.80665
const A = Math.PI * airframe.rotor.radius ** 2
const vh = Math.sqrt(W / (2 * RHO * A))

// ---------------------------------------------------------------------------
if (want('glide')) {
  console.log('\n== PLANEO (motor al ralentí), solo ==')
  console.log('palanca |  IAS  |   VS   | fineza | rotor | cabeceo | ±IAS')
  let best = 0
  let bestV = 0
  let minSink = 99
  let minSinkV = 0
  let rpm100 = 0
  for (const s of [-0.2, 0, 0.2, 0.4, 0.6, 0.8, 1.0]) {
    const r = settle({ stick: s, throttle: 0, v0: 95 - 60 * s })
    if (r.crash) {
      console.log(`${pad(s.toFixed(1), 7)} | ACCIDENTE ${r.crash}`)
      continue
    }
    console.log(
      `${pad(s.toFixed(1), 7)} | ${pad(r.ias.toFixed(0), 5)} | ${pad(r.vs.toFixed(2), 6)} | ${pad(r.ld.toFixed(2), 6)} | ${pad(r.rpm.toFixed(0), 5)} | ${pad(r.pitch.toFixed(1), 7)} | ${pad(r.osc.toFixed(1), 4)}`,
    )
    if (r.ld > best) {
      best = r.ld
      bestV = r.ias
    }
    if (-r.vs < minSink) {
      minSink = -r.vs
      minSinkV = r.ias
    }
    if (s === 0) rpm100 = r.rpm
  }
  check('Mejor fineza de planeo', best, REF.glide[0], REF.glide[1], `(a ${bestV.toFixed(0)} km/h)`, 2)
  check('Descenso mínimo en planeo', minSink, ...R_(REF.minSink, [4.0, 6.5]), `m/s (a ${minSinkV.toFixed(0)} km/h)`, 1)
  check('RPM de rotor en planeo (palanca neutra, solo)', rpm100, ...R_(REF.rpmGlide, [320, 370]), 'rpm')
}

// ---------------------------------------------------------------------------
if (want('vert')) {
  console.log('\n== DESCENSO VERTICAL ==')
  const r = settle({ stick: 1, throttle: 0, v0: 30, engineOff: true, secs: 90 })
  console.log(`motor parado, palanca atrás: IAS ${r.ias.toFixed(0)} km/h, VS ${r.vs.toFixed(2)} m/s, rotor ${r.rpm.toFixed(0)} rpm, cabeceo ${r.pitch.toFixed(1)}°, ±IAS ${r.osc.toFixed(1)} ${r.crash}`)
  const r2 = settle({ stick: 1, throttle: 0, v0: 30, secs: 90 })
  console.log(`ralentí, palanca atrás:      IAS ${r2.ias.toFixed(0)} km/h, VS ${r2.vs.toFixed(2)} m/s, rotor ${r2.rpm.toFixed(0)} rpm, cabeceo ${r2.pitch.toFixed(1)}°, ±IAS ${r2.osc.toFixed(1)} ${r2.crash}`)
  const r3 = settle({ stick: 1, throttle: 0, v0: 30, engineOff: true, dual: true, secs: 90 })
  console.log(`motor parado, con pasajero:  IAS ${r3.ias.toFixed(0)} km/h, VS ${r3.vs.toFixed(2)} m/s, rotor ${r3.rpm.toFixed(0)} rpm, cabeceo ${r3.pitch.toFixed(1)}°, ±IAS ${r3.osc.toFixed(1)} ${r3.crash}`)
  console.log(`velocidad inducida de referencia v_h = ${vh.toFixed(2)} m/s`)
  if (r.ias < 12) check('Descenso vertical / v_h (teoría y ensayos NACA: 1.6–2.0)', -r.vs / vh, 1.55, 2.1, '', 2)
  check('Palanca atrás sin motor: sin deslizar hacia atrás, estable', r.crash ? -1 : r.osc, 0, 6, 'km/h de oscilación', 1)
  check('Palanca atrás sin motor, con pasajero: estable', r3.crash ? -1 : r3.osc, 0, 6, 'km/h de oscilación', 1)
  check('Palanca atrás al ralentí: velocidad de equilibrio', r2.ias, 10, 45, 'km/h')
}

// ---------------------------------------------------------------------------
let cruise: (Res & { throttle: number }) | null = null
if (want('level')) {
  console.log('\n== VUELO NIVELADO, solo (gas necesario) ==')
  console.log('palanca |  IAS  |  gas  |  kW   | motor | rotor | cabeceo | AoA disco | lat   | ped')
  let vmin = 999
  let vmax = 0
  let pmin = 999
  let pminV = 0
  for (const s of [-0.74, -0.68, -0.65, -0.62, -0.59, -0.56, -0.53, -0.5, -0.46, -0.42, -0.35, -0.2, -0.1, 0, 0.2, 0.4, 0.6, 0.8, 1.0]) {
    const r = level(s, 100 - 60 * s)
    if (r.crash) {
      console.log(`${pad(s.toFixed(2), 7)} | ACCIDENTE ${r.crash}`)
      continue
    }
    const sustained = Math.abs(r.vs) < 0.3
    console.log(
      `${pad(s.toFixed(2), 7)} | ${pad(r.ias.toFixed(0), 5)} | ${pad((r.throttle * 100).toFixed(0), 4)}% | ${pad(r.power.toFixed(1), 5)} | ${pad(r.engRpm.toFixed(0), 5)} | ${pad(r.rpm.toFixed(0), 5)} | ${pad(r.pitch.toFixed(1), 7)} | ${pad(r.discAoA.toFixed(1), 9)} | ${pad(r.lat.toFixed(2), 5)} | ${pad(r.ped.toFixed(2), 5)}${sustained ? '' : `  (no mantiene: VS ${r.vs.toFixed(1)})`}`,
    )
    if (sustained) {
      vmin = Math.min(vmin, r.ias)
      vmax = Math.max(vmax, r.ias)
      if (r.power < pmin) {
        pmin = r.power
        pminV = r.ias
      }
    }
    if (s === 0) cruise = r
  }
  check('Velocidad máxima en vuelo nivelado', vmax, REF.vmax[0], REF.vmax[1], 'km/h')
  check('Velocidad mínima en vuelo nivelado', vmin, ...R_(REF.vmin, [30, 55]), 'km/h')
  check('Potencia mínima para volar nivelado', pmin, ...R_(REF.pmin, [22, 38]), `kW (a ${pminV.toFixed(0)} km/h)`, 1)
  if (cruise) {
    check(`RPM de rotor en crucero (solo, ${massSolo} kg)`, (cruise as Res).rpm, ...R_(REF.rpmCruise, [325, 375]), 'rpm')
    check('Palanca neutra ↔ velocidad de crucero', (cruise as Res).ias, ...R_(REF.cruiseIas, [95, 125]), 'km/h')
  }
}

// ---------------------------------------------------------------------------
if (want('climb')) {
  console.log('\n== ASCENSO a pleno gas ==')
  let best = -99
  let bestV = 0
  for (const s of [0, 0.15, 0.3, 0.45, 0.6]) {
    const r = settle({ stick: s, throttle: 1, v0: 100 - 60 * s })
    console.log(`solo  palanca ${s.toFixed(2)}: IAS ${r.ias.toFixed(0)} km/h, VS ${r.vs.toFixed(2)} m/s (${(r.vs * 196.85).toFixed(0)} ft/min), rotor ${r.rpm.toFixed(0)} ${r.crash}`)
    if (r.vs > best) {
      best = r.vs
      bestV = r.ias
    }
  }
  check('Mejor régimen de ascenso, solo', best, REF.climbSolo[0], REF.climbSolo[1], `m/s (a ${bestV.toFixed(0)} km/h)`, 1)
  let bestD = -99
  let bestDV = 0
  for (const s of [0.15, 0.3, 0.45]) {
    const r = settle({ stick: s, throttle: 1, v0: 100 - 60 * s, dual: true })
    console.log(`dual  palanca ${s.toFixed(2)}: IAS ${r.ias.toFixed(0)} km/h, VS ${r.vs.toFixed(2)} m/s (${(r.vs * 196.85).toFixed(0)} ft/min), rotor ${r.rpm.toFixed(0)} ${r.crash}`)
    if (r.vs > bestD) {
      bestD = r.vs
      bestDV = r.ias
    }
  }
  check('Mejor régimen de ascenso, con pasajero', bestD, REF.climbDual[0], REF.climbDual[1], `m/s (a ${bestDV.toFixed(0)} km/h)`, 1)
}

// ---------------------------------------------------------------------------
if (want('turn')) {
  console.log('\n== VIRAJE NIVELADO 45° (factor de carga 1.41) ==')
  const a = level(0.1, 95)
  const b = level(0.1, 95, false, 45)
  console.log(`recto:  IAS ${a.ias.toFixed(0)} rotor ${a.rpm.toFixed(0)} rpm gas ${(a.throttle * 100).toFixed(0)}% g ${a.g.toFixed(2)}`)
  console.log(`viraje: IAS ${b.ias.toFixed(0)} rotor ${b.rpm.toFixed(0)} rpm gas ${(b.throttle * 100).toFixed(0)}% g ${b.g.toFixed(2)} alabeo ${b.roll.toFixed(0)}° ${b.crash}`)
  check('RPM en viraje 45° / RPM en recto (teoría: √1.41 = 1.19)', b.rpm / a.rpm, 1.1, 1.26, '', 2)
}

// ---------------------------------------------------------------------------
if (want('dual')) {
  console.log(`\n== CON PASAJERO (${massDual} kg) ==`)
  const r = level(0, 100, true)
  console.log(`crucero palanca neutra: IAS ${r.ias.toFixed(0)} km/h, gas ${(r.throttle * 100).toFixed(0)}%, rotor ${r.rpm.toFixed(0)} rpm, cabeceo ${r.pitch.toFixed(1)}°`)
  check(`RPM de rotor en crucero (con pasajero, ${massDual} kg)`, r.rpm, ...R_(REF.rpmDual, [355, 410]), 'rpm')
  const g = settle({ stick: 0.1, throttle: 0, v0: 90, dual: true })
  console.log(`planeo: IAS ${g.ias.toFixed(0)} km/h, VS ${g.vs.toFixed(2)} m/s, fineza ${g.ld.toFixed(2)}`)
}

console.log('\n== RESULTADO ==')
let fails = 0
for (const c of checks) {
  if (!c.ok) fails++
  console.log(`${c.ok ? ' OK  ' : 'FALLA'} ${c.name}: ${c.value}   [esperado ${c.expected}]`)
}
console.log(fails === 0 ? '\nTodo dentro de rango.' : `\n${fails} comprobación(es) fuera de rango.`)
