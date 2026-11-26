// Día caluroso y altura: el aire del menú (temperatura y QNH, src/sim/airMass.ts) frente a la atmósfera
// estándar, en Casarrubios (LEMT, 625 m).
//
//   node --experimental-strip-types tools/fdm-density.ts [af=<id> ...]   (por defecto: generic y ela07)
//
// 1. El modelo del aire: en modo ISA da la densidad de siempre bit a bit; con 15 °C a nivel del mar y
//    1013,25 hPa «a mano», la misma; el altímetro marca la elevación en el suelo; 38 °C en LEMT son
//    ~5000 ft de altitud de densidad.
// 2. Carrera de despegue y distancia hasta 15 m (piloto de teclado con la ayuda, como en
//    fdm-scenarios.ts) y mejor régimen de ascenso a pleno gas (como en fdm-validate.ts), a ISA (10,9 °C)
//    y a ISA+25 (35,9 °C), con el mismo QNH: la altitud de densidad pasa de 2050 a 4860 ft (σ ×0,919).
//    De dónde salen los rangos (`RANGES`, abajo):
//    - Lo mínimo que da la física: carrera ∝ V²/aceleración con V_despegue² ∝ 1/σ (misma IAS) y empuje
//      ∝ σ (motor atmosférico, hélice de paso fijo) → ×1/σ² = ×1,18; el rozamiento de las ruedas y el
//      rotor, que tarda más en embalarse con aire menos denso, solo pueden alargarla.
//    - Manual de la Cessna 172S (Lycoming atmosférico; fig. 5-5 y 5-6, 2550 lb, 2000 ft), interpolando
//      a 10,9 y 35,9 °C: carrera 1118 → 1341 ft (×1,20), distancia a 50 ft 1903 → 2287 ft (×1,20) y
//      ascenso máximo 657 → 573 ft/min (×0,87). Unos +7 % por cada 1000 ft de altitud de densidad.
//    - Manual del AutoGyro MTOsport 2017 (§5.7 «Influence on Take-off Distance and Climb Rate», el ábaco
//      de Koch, que AutoGyro aplica igual al 912 y al 914 turbo; su ejemplo, 28 °C y 3500 ft: +88 % y
//      −53 %, se lee en el ábaco como +87 % y −53 %): de 2050 ft y 10,9 °C a 35,9 °C la distancia de
//      despegue (hasta un obstáculo de 15 m) pasa de +27 % a +75 % sobre la de nivel del mar (×1,38) y
//      el ascenso, de −21 % a −47 % (×0,66). Es una carta genérica y conservadora: el techo.
//    - Regla habitual de +10–15 % de carrera por cada 1000 ft de altitud de densidad → ×1,28–1,42
//      (también conservadora: la 172S se queda en un 7 %).
//    Un turbo (914, 915) mantiene la presión de admisión (ρ ≈ 1,06 > ρ crítica) y solo pierde lo que la
//    carga caliente entra menos densa (√(T_ISA/T): −4 %, airMass.turboTempFactor) más la parte
//    aerodinámica (V² ∝ 1/σ: +9 %): carrera y ascenso cambian bastante menos que con un atmosférico.
import { Vector3 } from 'three'
import { Autogyro, defaultControls, type Controls, type Environment } from '../src/sim/autogyro.ts'
import { KEY_THROTTLE_RATE, keyPitchRate, PilotAssist } from '../src/sim/assist.ts'
import { isaDensity } from '../src/sim/atmosphere.ts'
import { AirModel, densityAltitude, isaTempC } from '../src/sim/airMass.ts'
import { applyTune, pickAirframe } from './af-override.ts'

const DT = 1 / 240
const ELEV = 625 // LEMT (OurAirports; Open-Meteo da 624 m)
const flat = { heightAt: (_x: number, _z: number, n: Vector3) => (n.set(0, 1, 0), 0) }

let fails = 0
function check(name: string, ok: boolean, text: string): void {
  if (!ok) fails++
  console.log(`${ok ? ' OK  ' : 'FALLA'} ${name}: ${text}`)
}

// ---------------------------------------------------------------------------
// 1. Modelo del aire
// ---------------------------------------------------------------------------
{
  const isa = new AirModel()
  isa.elev = ELEV
  let worst = 0
  for (let h = -400; h <= 6000; h += 37.3) worst = Math.max(worst, Math.abs(isa.density(h) - isaDensity(h)))
  check('ISA bit a bit', worst === 0, `diferencia máxima con isaDensity ${worst}`)

  const hand = new AirModel()
  hand.set({ isa: false, oatC: 15, qnh: 1013.25, dewPointC: 5 })
  hand.elev = 0
  let rel = 0
  for (let h = -400; h <= 6000; h += 37.3) rel = Math.max(rel, Math.abs(hand.density(h) / isaDensity(h) - 1))
  check('15 °C y 1013,25 a mano = ISA', rel < 1e-9, `error relativo ${rel.toExponential(1)}`)

  const hot = new AirModel()
  hot.set({ isa: false, oatC: 38, qnh: 1013.25, dewPointC: 10 })
  hot.elev = ELEV
  const da = hot.densityAltitude(ELEV)
  check('38 °C en LEMT', da > 1450 && da < 1650, `altitud de densidad ${da.toFixed(0)} m (${(da * 3.28084).toFixed(0)} ft)`)
  const onGround = hot.altimeter(ELEV)
  const above = hot.altimeter(ELEV + 1000) - onGround
  check(
    'Altímetro calado al QNH',
    Math.abs(onGround - ELEV) < 1e-6 && above > 900 && above < 935,
    `en el suelo ${onGround.toFixed(2)} m; 1000 m más arriba marca ${above.toFixed(0)} m más (calor: menos de lo real, ≈ ×T_ISA/T)`,
  )
}

// ---------------------------------------------------------------------------
// 2. Despegue y ascenso
// ---------------------------------------------------------------------------
const ids = process.argv.slice(2).filter((a) => a.startsWith('af=')).map((a) => a.slice(3))
if (ids.length === 0) ids.push('generic', 'ela10')

/**
 * Factores ISA+25 / ISA esperados (ver la cabecera). Atmosférico: carrera entre la física mínima (×1,18,
 * ×1,15 con margen) y la regla conservadora (×1,45); hasta 15 m también cuenta el ascenso, hasta el ábaco
 * de Koch con margen (×1,50); ascenso entre Koch (×0,66, ×0,62 con margen) y la 172S (×0,87, ×0,90).
 * Turbo: no puede empeorar más que un atmosférico ni mejorar con calor.
 */
const RANGES = {
  atmo: { roll: [1.15, 1.45], d15: [1.15, 1.5], climb: [0.62, 0.9] },
  turbo: { roll: [1.03, 1.3], d15: [1.02, 1.35], climb: [0.8, 0.99] },
} satisfies Record<string, Record<string, [number, number]>>

/** Entorno de la física en LEMT con el aire del menú (ISA, o ISA + dT con el mismo QNH), como en main.ts. */
const envFor = (dT: number | null): Environment => {
  const a = new AirModel()
  if (dT !== null) a.set({ isa: false, oatC: isaTempC(ELEV) + dT, qnh: 1013.25, dewPointC: 0 })
  a.elev = ELEV
  const e: Environment = { rho: 0, wind: new Vector3(), ground: flat }
  a.fill(e, ELEV)
  return e
}
const ENV_ISA = envFor(null)
const ENV_HOT = envFor(25)
const RHO_ISA = ENV_ISA.rho
const RHO_HOT = ENV_HOT.rho

function make(id: string): Autogyro {
  const ac = new Autogyro(pickAirframe(id))
  applyTune(ac)
  ac.setLoad(false)
  return ac
}

/**
 * Carrera de despegue (m, hasta que las ruedas dejan el suelo) y distancia hasta 15 m de altura con el
 * procedimiento de fdm-scenarios.ts (en el aire, palanca a 0,2 para acelerar en efecto suelo y subir).
 */
function takeoff(id: string, env: Environment): { run: number; d15: number; v: number; crash: string } {
  const ac = make(id)
  ac.placeOnGround(0, 0, 0, 90)
  const pre = ac.af.prerotator
  const preRpm = pre ? pre.maxRpm * 0.92 : 210
  const ctl: Controls = defaultControls()
  const assist = new PilotAssist()
  let stick = 0
  let thr = 0
  let hold = 0
  let lastKey = 0
  let phase = 0
  let x0 = 0
  let run = 0
  let v = 0
  for (let t = 0; t < 150; t += DT) {
    let key: -1 | 0 | 1 = 0
    let thrTarget = 0.4
    let brake = true
    let prerot = false
    if (phase === 0) {
      key = stick > -0.99 ? -1 : 0
      prerot = t > 2
      if (ac.rotor.rpm >= preRpm) {
        phase = 1
        x0 = ac.pos.x
      }
    }
    if (phase === 1) {
      brake = false
      thrTarget = 1
      key = stick < 0.99 ? 1 : 0
      if (ac.onGround) {
        run = ac.pos.x - x0
        v = ac.ias * 3.6
      }
      if (ac.agl > 0.4) phase = 2
    }
    if (phase === 2) {
      brake = false
      thrTarget = 1
      key = Math.abs(0.2 - stick) < 0.02 ? 0 : 0.2 > stick ? 1 : -1
      if (ac.agl > 15) return { run, d15: ac.pos.x - x0, v, crash: '' }
    }
    hold = key !== 0 && key === lastKey ? hold + DT : 0
    lastKey = key
    stick = Math.max(-1, Math.min(1, stick + key * keyPitchRate(hold) * DT))
    const d = thrTarget - thr
    thr += Math.sign(d) * Math.min(Math.abs(d), KEY_THROTTLE_RATE * DT)
    ctl.pitch = stick
    ctl.roll = 0
    ctl.yaw = 0
    ctl.throttle = thr
    ctl.prerotator = prerot
    ctl.wheelBrake = brake ? 1 : 0
    assist.apply(DT, ac, ctl, { pitchActive: key !== 0, rollActive: false, yawActive: false, analog: false })
    ac.step(DT, ctl, env)
    if (ac.crash) return { run, d15: 0, v, crash: ac.crash.title }
  }
  return { run, d15: 0, v, crash: 'no despega' }
}

/** Mejor régimen de ascenso (m/s) a pleno gas, con la estabilización de fdm-validate.ts. */
function climb(id: string, env: Environment): { vs: number; ias: number } {
  let best = { vs: -99, ias: 0 }
  for (let s0 = 0; s0 <= 0.6001; s0 += 0.075) {
    const ac = make(id)
    ac.placeInAir(0, 3000, 0, 90, (100 - 60 * s0) / 3.6)
    const ctl = defaultControls()
    ctl.throttle = 1
    const f = new Vector3()
    const r = new Vector3()
    let thRef = 0
    let rollI = 0
    let n = 0
    let vs = 0
    let ias = 0
    for (let t = 0; t < 80 && !ac.crash; t += DT) {
      f.set(1, 0, 0).applyQuaternion(ac.quat)
      r.set(0, 0, 1).applyQuaternion(ac.quat)
      const pitch = Math.asin(Math.max(-1, Math.min(1, f.y)))
      const roll = Math.asin(Math.max(-1, Math.min(1, -r.y)))
      thRef += ((pitch - thRef) / 8) * DT
      ctl.pitch = Math.max(-1, Math.min(1, s0 + Math.max(-0.5, Math.min(0.5, -0.6 * ac.omega.z - 2.0 * (pitch - thRef)))))
      ctl.roll = Math.max(-1, Math.min(1, -1.3 * roll - 0.35 * ac.omega.x + rollI))
      rollI = Math.max(-0.6, Math.min(0.6, rollI - 0.25 * roll * DT))
      ctl.yaw = Math.max(-1, Math.min(1, 1.6 * ac.beta + 0.3 * ac.omega.y))
      ac.step(DT, ctl, env)
      if (t > 55) {
        vs += ac.vs
        ias += ac.ias * 3.6
        n++
      }
    }
    if (!ac.crash && n && vs / n > best.vs) best = { vs: vs / n, ias: ias / n }
  }
  return best
}

const daIsa = densityAltitude(RHO_ISA) * 3.28084
const daHot = densityAltitude(RHO_HOT) * 3.28084
console.log(`\nLEMT ${ELEV} m, QNH 1013,25: ISA ${isaTempC(ELEV).toFixed(1)} °C → altitud de densidad ${daIsa.toFixed(0)} ft; ISA+25 → ${daHot.toFixed(0)} ft (ρ ${RHO_ISA.toFixed(4)} → ${RHO_HOT.toFixed(4)} kg/m³, σ ×${(RHO_HOT / RHO_ISA).toFixed(3)})`)
const perK = (k: number) => `${k >= 1 ? '+' : ''}${((k - 1) * 100).toFixed(0)} %, ${(((k - 1) * 100) / ((daHot - daIsa) / 1000)).toFixed(1)} % por 1000 ft`
for (const id of ids) {
  const af = pickAirframe(id)
  const R = af.engine.turbo ? RANGES.turbo : RANGES.atmo
  const a = takeoff(id, ENV_ISA)
  const b = takeoff(id, ENV_HOT)
  const ka = b.run / a.run
  const kd = b.d15 / a.d15
  const crash = a.crash || b.crash ? ` ACCIDENTE: ${a.crash} ${b.crash}` : ''
  check(
    `${id} (${af.engine.name}) carrera`,
    !crash && ka >= R.roll[0] && ka <= R.roll[1],
    `${a.run.toFixed(0)} m a ${a.v.toFixed(0)} km/h → ${b.run.toFixed(0)} m a ${b.v.toFixed(0)} km/h IAS: ×${ka.toFixed(2)} (${perK(ka)}; esperado ×${R.roll[0]}–${R.roll[1]})${crash}`,
  )
  check(
    `${id} (${af.engine.name}) hasta 15 m`,
    !crash && kd >= R.d15[0] && kd <= R.d15[1],
    `${a.d15.toFixed(0)} → ${b.d15.toFixed(0)} m: ×${kd.toFixed(2)} (${perK(kd)}; esperado ×${R.d15[0]}–${R.d15[1]})${crash}`,
  )
  const c = climb(id, ENV_ISA)
  const d = climb(id, ENV_HOT)
  const clRange = R.climb
  const kc = d.vs / c.vs
  check(
    `${id} (${af.engine.name}) ascenso`,
    kc >= clRange[0] && kc <= clRange[1],
    `${c.vs.toFixed(2)} m/s a ${c.ias.toFixed(0)} km/h → ${d.vs.toFixed(2)} m/s a ${d.ias.toFixed(0)} km/h IAS: ×${kc.toFixed(2)} (${((kc - 1) * 100).toFixed(0)} %; esperado ×${clRange[0]}–${clRange[1]})`,
  )
}
console.log(fails ? `\n${fails} comprobación(es) fuera de rango.` : '\nTodo dentro de rango.')
process.exit(fails ? 1 : 0)
