// Banco de pruebas del Carter PAV (autogiro compuesto de rotor frenado con ala y salto).
//
//   node --experimental-strip-types tools/fdm-carter.ts [secciones] [-v]
//
// Secciones: level glide climb stab turn land jump roll brake alt (por defecto, todas).
// Cifras de referencia (Carter y Lewis, ERF 2015; notas de prensa de Carter 2013-2015):
//  · rotor ≈ 300 rpm por debajo de ~110-135 km/h, ≈ 105-125 rpm en crucero rápido (μ ≈ 0,8-1)
//  · fineza máxima ≈ 11 (medida), "casi 12"; velocidad máxima a 650 m con 300 CV ≈ 240-280 km/h
//    (325 km/h verdaderos a 5500 m); ascenso > 500 ft/min a 4100 m
//  · salto de 15-40 m con 1,9 t; toma casi sin carrera con la energía del rotor
import { Vector3 } from 'three'
import { Autogyro, defaultControls, type Controls, type Environment } from '../src/sim/autogyro.ts'
import { AIRFRAMES } from '../src/sim/airframes.ts'
import { KEY_THROTTLE_RATE, keyPitchRate, PilotAssist } from '../src/sim/assist.ts'
import { isaDensity } from '../src/sim/atmosphere.ts'
import { applyTune, pickAirframe } from './af-override.ts'

const DT = 1 / 240
const G = 9.80665
const flat = { heightAt: (_x: number, _z: number, n: Vector3) => (n.set(0, 1, 0), 0) }
const RHO = isaDensity(650)
const env: Environment = { rho: RHO, wind: new Vector3(), ground: flat }
const verbose = process.argv.includes('-v')
const sections = new Set(process.argv.slice(2).filter((a) => !a.startsWith('-') && !a.includes('=')))
const want = (s: string) => sections.size === 0 || sections.has(s)
const ID = 'carterpav'
if (!(ID in AIRFRAMES)) throw new Error('falta la ficha carterpav')
const airframe = pickAirframe(ID)
// ajuste fino sin tocar la ficha: SR="collective.jump=8,mast.kp=0.1" (campos numéricos de slowedRotor)
for (const kv of (process.env.SR ?? '').split(',').filter(Boolean)) {
  const [k, val] = kv.split('=')
  const path = k.split('.')
  let o = airframe.slowedRotor as unknown as Record<string, unknown>
  for (const p of path.slice(0, -1)) o = o[p] as Record<string, unknown>
  o[path[path.length - 1]] = Number(val)
}

function make(dual = false): Autogyro {
  const ac = new Autogyro(airframe)
  applyTune(ac)
  ac.setLoad(dual)
  return ac
}
const pad = (s: string | number, n: number) => String(s).padStart(n)
const f1 = (x: number) => x.toFixed(1)
const f0 = (x: number) => x.toFixed(0)
const _f = new Vector3()
const _r = new Vector3()
const _up = new Vector3()
const pitchOf = (ac: Autogyro) => Math.asin(Math.max(-1, Math.min(1, _f.set(1, 0, 0).applyQuaternion(ac.quat).y))) * 57.2958
const rollOf = (ac: Autogyro) => Math.asin(Math.max(-1, Math.min(1, -_r.set(0, 0, 1).applyQuaternion(ac.quat).y))) * 57.2958
/** parte del peso que lleva el rotor (fuerza del rotor en la vertical del mundo) */
const rotorShare = (ac: Autogyro) => ac.rotor.force.y / (ac.mass * G)
const wingShare = (ac: Autogyro) => {
  _up.set(0, 1, 0).applyQuaternion(ac.quat)
  return ((ac.cmp?.wingLift ?? 0) * _up.y) / (ac.mass * G)
}

const checks: { name: string; value: string; expected: string; ok: boolean }[] = []
function check(name: string, value: number, lo: number, hi: number, unit: string, digits = 0): void {
  checks.push({ name, value: `${value.toFixed(digits)} ${unit}`, expected: `${lo}–${hi} ${unit}`, ok: Number.isFinite(value) && value >= lo && value <= hi })
}
function checkBool(name: string, ok: boolean, text: string): void {
  checks.push({ name, value: text, expected: 'sí', ok })
}

interface Res {
  ias: number
  tas: number
  vs: number
  rpm: number
  target: number
  mast: number
  coll: number
  mu: number
  pitch: number
  roll: number
  power: number
  engRpm: number
  beta: number
  rotorShare: number
  wingShare: number
  wingCL: number
  osc: number
  rpmOsc: number
  ld: number
  g: number
  teeter: number
  crash: string
  stick: number
  throttle: number
}

/**
 * Vuela hasta el régimen permanente. Palanca: fija (`stick`) con la estabilización básica del piloto
 * (como fdm-validate) o llevada por un piloto automático que mantiene la velocidad `hold` (km/h).
 * Gas: fijo o 'level' (un automático lo ajusta para volar nivelado).
 */
function settle(o: { stick?: number; hold?: number; throttle: number | 'level'; v0: number; dual?: boolean; bank?: number; secs?: number; rho?: number; alt?: number }): Res {
  const ac = make(o.dual)
  const e: Environment = o.rho ? { ...env, rho: o.rho } : env
  ac.placeInAir(0, o.alt ?? 3000, 0, 90, o.v0 / 3.6)
  const ctl = defaultControls()
  const lvl = o.throttle === 'level'
  let thr = lvl ? 0.6 : (o.throttle as number)
  const secs = o.secs ?? (o.hold !== undefined ? 150 : 90)
  const win = 25
  let thRef = 0
  let rollI = 0
  let stickI = o.stick ?? 0
  let t = 0
  let n = 0
  const acc = { ias: 0, tas: 0, vs: 0, rpm: 0, target: 0, mast: 0, coll: 0, mu: 0, pitch: 0, roll: 0, power: 0, eng: 0, beta: 0, rs: 0, ws: 0, cl: 0, g: 0, gs: 0, teeter: 0, stick: 0, thr: 0 }
  let iasMin = 1e9
  let iasMax = -1e9
  let rMin = 1e9
  let rMax = -1e9
  let crash = ''
  while (t < secs) {
    const pitch = pitchOf(ac) / 57.2958
    const roll = rollOf(ac) / 57.2958
    thRef += ((pitch - thRef) / 8) * DT
    let base = o.stick ?? 0
    if (o.hold !== undefined) {
      // piloto automático de velocidad: palanca atrás si va rápido
      const err = ac.ias * 3.6 - o.hold
      stickI = Math.max(-1, Math.min(1, stickI + 0.0015 * err * DT))
      base = stickI + Math.max(-0.3, Math.min(0.3, 0.01 * err))
    }
    const sas = Math.max(-0.5, Math.min(0.5, -0.6 * ac.omega.z - 2.0 * (pitch - thRef)))
    ctl.pitch = Math.max(-1, Math.min(1, base + sas))
    if (lvl) {
      thr = Math.max(0, Math.min(1, thr - 0.005 * ac.vs * DT))
      ctl.throttle = Math.max(0, Math.min(1, thr - 0.01 * ac.vs))
    } else ctl.throttle = thr
    const bank = ((o.bank ?? 0) * Math.PI) / 180
    ctl.roll = Math.max(-1, Math.min(1, -1.3 * (roll - bank) - 0.35 * ac.omega.x + rollI))
    rollI = Math.max(-0.6, Math.min(0.6, rollI - 0.25 * (roll - bank) * DT))
    ctl.yaw = Math.max(-1, Math.min(1, 1.6 * ac.beta + 0.3 * ac.omega.y))
    ac.step(DT, ctl, e)
    if (ac.crash) {
      crash = ac.crash.title
      break
    }
    if (t > secs - win) {
      const v = ac.ias * 3.6
      acc.ias += v
      acc.tas += ac.tas * 3.6
      acc.vs += ac.vs
      acc.rpm += ac.rotor.rpm
      acc.target += ac.cmp!.rpmTarget
      acc.mast += (ac.cmp!.mast * 180) / Math.PI
      acc.coll += (ac.cmp!.collective * 180) / Math.PI
      acc.mu += ac.rotor.mu
      acc.pitch += pitch * 57.3
      acc.roll += roll * 57.3
      acc.power += ac.enginePower / 1000
      acc.eng += ac.engineRpm
      acc.beta += ac.cmp!.beta
      acc.rs += rotorShare(ac)
      acc.ws += wingShare(ac)
      acc.cl += ac.cmp!.wingCL
      acc.g += ac.gLoad
      acc.gs += Math.hypot(ac.vel.x, ac.vel.z)
      acc.stick += ctl.pitch
      acc.thr += ctl.throttle
      acc.teeter = Math.max(acc.teeter, Math.hypot(ac.rotor.a1, ac.rotor.b1) * 57.3)
      iasMin = Math.min(iasMin, v)
      iasMax = Math.max(iasMax, v)
      rMin = Math.min(rMin, ac.rotor.rpm)
      rMax = Math.max(rMax, ac.rotor.rpm)
      n++
    }
    t += DT
  }
  const k = 1 / Math.max(1, n)
  return {
    ias: acc.ias * k,
    tas: acc.tas * k,
    vs: acc.vs * k,
    rpm: acc.rpm * k,
    target: acc.target * k,
    mast: acc.mast * k,
    coll: acc.coll * k,
    mu: acc.mu * k,
    pitch: acc.pitch * k,
    roll: acc.roll * k,
    power: acc.power * k,
    engRpm: acc.eng * k,
    beta: acc.beta * k,
    rotorShare: acc.rs * k,
    wingShare: acc.ws * k,
    wingCL: acc.cl * k,
    osc: (iasMax - iasMin) / 2,
    rpmOsc: (rMax - rMin) / 2,
    ld: (acc.gs * k) / Math.max(0.01, -acc.vs * k),
    g: acc.g * k,
    teeter: acc.teeter,
    crash,
    stick: acc.stick * k,
    throttle: acc.thr * k,
  }
}

const W = make(false).mass
console.log(`Carter PAV: ${airframe.engine.name}, ${(airframe.engine.maxPower / 745.7).toFixed(0)} hp · solo ${W} kg, con pasajero ${make(true).mass} kg (máximo ${airframe.mtow}) · ρ=${RHO.toFixed(3)} (650 m)`)
const head = 'IAS obj |  IAS | palanca | gas  |  kW   | rotor/obj | mástil | colect |   μ  | rotor% | ala% | CL ala | cabeceo | batim | ±rpm'
const row = (h: number, r: Res) =>
  `${pad(f0(h), 7)} | ${pad(f0(r.ias), 4)} | ${pad(r.stick.toFixed(2), 7)} | ${pad(f0(r.throttle * 100), 3)}% | ${pad(f1(r.power), 5)} | ${pad(f0(r.rpm), 4)}/${pad(f0(r.target), 3)} | ${pad(f1(r.mast), 6)} | ${pad(f1(r.coll), 6)} | ${r.mu.toFixed(2)} | ${pad(f0(r.rotorShare * 100), 5)}% | ${pad(f0(r.wingShare * 100), 3)}% | ${pad(r.wingCL.toFixed(2), 6)} | ${pad(f1(r.pitch), 7)} | ${pad(f1(r.teeter), 5)} | ${f1(r.rpmOsc)}`

/** Velocidad máxima: la mayor velocidad mantenida a pleno gas sin perder altura (interpolada). */
function vmaxAt(holds: number[], rho?: number, alt?: number): { ias: number; tas: number; mu: number; rpm: number; log: string[] } {
  const log: string[] = []
  let prev: Res | null = null
  let prevH = 0
  for (const h of holds) {
    const r = settle({ hold: h, throttle: 1, v0: h, rho, alt })
    log.push(`  pleno gas a ${f0(h)} km/h: IAS ${f0(r.ias)}, TAS ${f0(r.tas)}, VS ${r.vs.toFixed(2)} m/s, rotor ${f0(r.rpm)} rpm, μ ${r.mu.toFixed(2)}, mástil ${f1(r.mast)}°, cabeceo ${f1(r.pitch)}° ${r.crash}`)
    if (r.crash || r.vs < 0) {
      if (!prev) return { ias: 0, tas: 0, mu: 0, rpm: 0, log }
      const k = prev.vs / Math.max(1e-3, prev.vs - (r.crash ? -1 : r.vs))
      const lerp = (a: number, b: number) => a + (b - a) * Math.min(1, k)
      return { ias: lerp(prev.ias, r.crash ? h : r.ias), tas: lerp(prev.tas, r.crash ? prev.tas : r.tas), mu: prev.mu, rpm: prev.rpm, log }
    }
    prev = r
    prevH = h
  }
  void prevH
  return { ias: prev!.ias, tas: prev!.tas, mu: prev!.mu, rpm: prev!.rpm, log }
}

// ---------------------------------------------------------------------------
if (want('level')) {
  console.log('\n== VUELO NIVELADO, solo (palanca y gas de un piloto automático) ==')
  console.log(head)
  let vmin = 999
  let pmin = 999
  let pminV = 0
  let rpmLow = 0
  let worstRpmErr = 0
  let worstErrV = 0
  for (const h of [50, 60, 65, 70, 75, 80, 90, 100, 120, 140, 160, 180, 200, 220, 240]) {
    const r = settle({ hold: h, throttle: 'level', v0: Math.max(h, 70) })
    if (r.crash) {
      console.log(`${pad(f0(h), 7)} | ACCIDENTE ${r.crash}`)
      continue
    }
    const sustained = Math.abs(r.vs) < 0.3 && Math.abs(r.ias - h) < 4 && r.throttle < 0.995
    console.log(row(h, r) + (sustained ? '' : `  (no mantiene: VS ${r.vs.toFixed(1)}, IAS ${f0(r.ias)})`))
    if (sustained) {
      vmin = Math.min(vmin, r.ias)
      if (r.power < pmin) {
        pmin = r.power
        pminV = r.ias
      }
      if (r.ias < 110) rpmLow = Math.max(rpmLow, r.rpm)
      if (r.ias > 100 && Math.abs(r.rpm - r.target) > worstRpmErr) {
        worstRpmErr = Math.abs(r.rpm - r.target)
        worstErrV = r.ias
      }
    }
  }
  const vm = vmaxAt([240, 250, 260, 270, 280, 290, 300])
  for (const l of vm.log) console.log(l)
  console.log(`velocidad máxima nivelada: ${f0(vm.ias)} km/h (rotor ${f0(vm.rpm)} rpm, μ ${vm.mu.toFixed(2)})`)
  // (limitada por la potencia: perfil del rotor a ~280 rpm y rendimiento de la hélice a poca velocidad)
  check('Velocidad mínima en vuelo nivelado', vmin, 30, 75, 'km/h')
  check('Velocidad máxima en vuelo nivelado (650 m, 300 hp)', vm.ias, 240, 280, 'km/h')
  check('Rotor a baja velocidad (<110 km/h)', rpmLow, 250, 330, 'rpm')
  check('Rotor a la velocidad máxima', vm.rpm, 100, 130, 'rpm')
  check('μ a la velocidad máxima', vm.mu, 0.75, 1.05, '', 2)
  check('Error de la ley de vueltas en régimen (>100 km/h)', worstRpmErr, 0, 15, `rpm (a ${f0(worstErrV)} km/h)`)
  check('Potencia mínima para volar nivelado', pmin, 40, 120, `kW (a ${f0(pminV)} km/h)`)
}

// ---------------------------------------------------------------------------
if (want('glide')) {
  console.log('\n== PLANEO (gas cortado, hélice al paso fino en molinete), solo ==')
  console.log(head + ' | VS   | fineza')
  let best = 0
  let bestV = 0
  for (const h of [80, 100, 120, 140, 160, 180, 200, 220]) {
    const r = settle({ hold: h, throttle: 0, v0: h })
    if (r.crash) {
      console.log(`${pad(f0(h), 7)} | ACCIDENTE ${r.crash}`)
      continue
    }
    console.log(`${row(h, r)} | ${pad(r.vs.toFixed(1), 4)} | ${r.ld.toFixed(1)}`)
    if (r.ld > best) {
      best = r.ld
      bestV = r.ias
    }
  }
  check('Mejor fineza sin motor', best, 9, 13, `(a ${f0(bestV)} km/h)`, 1)
}

// ---------------------------------------------------------------------------
if (want('climb')) {
  console.log('\n== ASCENSO a pleno gas ==')
  let best = -99
  let bestV = 0
  for (const h of [70, 90, 110, 130, 150, 170]) {
    const r = settle({ hold: h, throttle: 1, v0: h })
    console.log(`a ${f0(h)} km/h: IAS ${f0(r.ias)} km/h, VS ${r.vs.toFixed(2)} m/s (${f0(r.vs * 196.85)} ft/min), rotor ${f0(r.rpm)}/${f0(r.target)} rpm, mástil ${f1(r.mast)}°, cabeceo ${f1(r.pitch)}°, palanca ${r.stick.toFixed(2)} ${r.crash}`)
    if (r.vs > best && !r.crash) {
      best = r.vs
      bestV = r.ias
    }
  }
  check('Mejor régimen de ascenso, solo', best, 4, 8, `m/s (a ${f0(bestV)} km/h)`, 1)
  const d = settle({ hold: bestV, throttle: 1, v0: bestV, dual: true })
  console.log(`con pasajero (${make(true).mass} kg) a ${f0(bestV)} km/h: VS ${d.vs.toFixed(2)} m/s ${d.crash}`)
}

// ---------------------------------------------------------------------------
if (want('alt')) {
  console.log('\n== VELOCIDAD MÁXIMA A 5500 m (pleno gas) ==')
  const vm = vmaxAt([150, 165, 180, 195, 210, 225], isaDensity(5500), 5500)
  for (const l of vm.log) console.log(l)
  console.log(`máxima: ${f0(vm.ias)} km/h indicados, ${f0(vm.tas)} km/h verdaderos, μ ${vm.mu.toFixed(2)}`)
  // (el Carter llevaba entonces un motor sobrealimentado: 325 hp a 5500 m; este IO-540 atmosférico da allí el 61 %)
  check('Velocidad verdadera máxima a 5500 m con el IO-540 atmosférico', vm.tas, 230, 300, 'km/h')
  check('μ a esa velocidad (Carter: hasta 1,16)', vm.mu, 0.55, 1.25, '', 2)
}

// ---------------------------------------------------------------------------
if (want('stab')) {
  console.log('\n== ESTABILIDAD CON LA PALANCA FIJA (sin ayuda), tras un pulso de palanca ==')
  for (const v0 of [110, 180, 240]) {
    const tr = settle({ hold: v0, throttle: 'level', v0 })
    const ac = make()
    ac.placeInAir(0, 3000, 0, 90, v0 / 3.6)
    const ctl = defaultControls()
    // 60 s con el piloto automático y luego todo suelto: palanca y gas fijos + pulso de 1 s
    let thRef = 0
    let t = 0
    let stickI = tr.stick
    let thr = tr.throttle
    let maxDp = 0
    let maxBank = 0
    let amp1 = 0
    let amp2 = 0
    let v0r = 0
    let p0 = 0
    let rpmMin = 1e9
    let rpmMax = 0
    let stick0 = 0
    let roll0 = 0
    let yaw0 = 0
    let dp30 = 0
    let bank30 = 0
    let crash30 = false
    while (t < 130 && !ac.crash) {
      if (t < 90 && ac.crash) crash30 = true
      const pitch = pitchOf(ac) / 57.2958
      if (t < 60) {
        thRef += ((pitch - thRef) / 8) * DT
        const err = ac.ias * 3.6 - v0
        stickI = Math.max(-1, Math.min(1, stickI + 0.0015 * err * DT))
        ctl.pitch = Math.max(-1, Math.min(1, stickI + 0.01 * err + Math.max(-0.5, Math.min(0.5, -0.6 * ac.omega.z - 2 * (pitch - thRef)))))
        thr = Math.max(0, Math.min(1, thr - 0.005 * ac.vs * DT))
        ctl.throttle = thr
        ctl.roll = Math.max(-1, Math.min(1, (-1.3 * rollOf(ac)) / 57.3 - 0.35 * ac.omega.x))
        ctl.yaw = Math.max(-1, Math.min(1, 1.6 * ac.beta + 0.3 * ac.omega.y))
        stick0 = stick0 + (ctl.pitch - stick0) * Math.min(1, DT / 2)
        roll0 = roll0 + (ctl.roll - roll0) * Math.min(1, DT / 2)
        yaw0 = yaw0 + (ctl.yaw - yaw0) * Math.min(1, DT / 2)
        v0r = ac.ias
        p0 = pitchOf(ac)
      } else {
        ctl.pitch = stick0 + (t < 61 ? 0.15 : 0)
        ctl.roll = roll0
        ctl.yaw = yaw0
        maxDp = Math.max(maxDp, Math.abs(pitchOf(ac) - p0))
        maxBank = Math.max(maxBank, Math.abs(rollOf(ac)))
        const dv = Math.abs(ac.ias - v0r) * 3.6
        if (t < 90) amp1 = Math.max(amp1, dv)
        else amp2 = Math.max(amp2, dv)
        if (t < 90) {
          dp30 = Math.max(dp30, Math.abs(pitchOf(ac) - p0))
          bank30 = Math.max(bank30, Math.abs(rollOf(ac)))
        }
        rpmMin = Math.min(rpmMin, ac.rotor.rpm)
        rpmMax = Math.max(rpmMax, ac.rotor.rpm)
      }
      ac.step(DT, ctl, env)
      t += DT
    }
    if (ac.crash && t < 90) crash30 = true
    const ok = !crash30 && dp30 < 20 && bank30 < 30 && amp1 < 40
    const txt = crash30 ? `ACCIDENTE ${ac.crash!.title}` : `en 30 s: cabeceo ±${f1(dp30)}°, IAS ±${f1(amp1)} km/h, alabeo ${f1(bank30)}°; a los 70 s: cabeceo ±${f1(maxDp)}°, IAS ±${f1(amp2)} km/h, alabeo ${f1(maxBank)}° (espiral lenta), rotor ${f0(rpmMin)}-${f0(rpmMax)} rpm${ac.crash ? `, ${ac.crash.title}` : ''}`
    console.log(`${f0(v0)} km/h (palanca ${stick0.toFixed(2)}, gas ${f0(thr * 100)} %): ${txt}`)
    checkBool(`Palanca fija tras un pulso a ${f0(v0)} km/h: sin divergencia en 30 s`, ok, txt)
  }
}

// ---------------------------------------------------------------------------
if (want('turn')) {
  console.log('\n== VIRAJE NIVELADO 45° ==')
  for (const v of [130, 200]) {
    const a = settle({ hold: v, throttle: 'level', v0: v })
    const b = settle({ hold: v, throttle: 'level', v0: v, bank: 45 })
    console.log(`recto:  IAS ${f0(a.ias)} rotor ${f0(a.rpm)}/${f0(a.target)} rpm gas ${f0(a.throttle * 100)}% mástil ${f1(a.mast)}° palanca ${a.stick.toFixed(2)} g ${a.g.toFixed(2)}`)
    console.log(`viraje: IAS ${f0(b.ias)} rotor ${f0(b.rpm)}/${f0(b.target)} rpm gas ${f0(b.throttle * 100)}% mástil ${f1(b.mast)}° palanca ${b.stick.toFixed(2)} g ${b.g.toFixed(2)} alabeo ${f0(b.roll)}° batimiento ${f1(b.teeter)}° VS ${b.vs.toFixed(2)} ${b.crash}`)
    checkBool(`Viraje de 45° nivelado a ${f0(v)} km/h`, !b.crash && b.throttle < 0.995 && Math.abs(b.vs) < 0.3 && Math.abs(b.roll - 45) < 5 && b.g > 1.3, b.crash || `${f0(b.ias)} km/h, gas ${f0(b.throttle * 100)} %, ${b.g.toFixed(2)} g, rotor ${f0(b.rpm)} rpm`)
  }
}

// ---------------------------------------------------------------------------
// Pilotos de teclado con la ayuda del juego (como fdm-scenarios)
interface Keys {
  pitch: -1 | 0 | 1
  throttleTarget: number
  prerot: boolean
  brake: boolean
}
interface Trace {
  t: number
  agl: number
  ias: number
  vs: number
  pitch: number
  rpm: number
  x: number
}
function flyKeys(
  setup: (ac: Autogyro, st: { stick: number; throttle: number }) => void,
  script: (tr: Trace, k: Keys, ac: Autogyro, st: { stick: number; throttle: number }) => boolean | void,
  secs: number,
  dual = false,
): { ac: Autogyro; log: string[] } {
  const ac = make(dual)
  const st = { stick: 0, throttle: 0 }
  setup(ac, st)
  const ctl: Controls = defaultControls()
  const assist = new PilotAssist()
  const k: Keys = { pitch: 0, throttleTarget: st.throttle, prerot: false, brake: false }
  let t = 0
  let hold = 0
  let last = 0
  let next = 0
  const log: string[] = []
  while (t < secs && !ac.crash) {
    const tr: Trace = { t, agl: ac.agl, ias: ac.ias * 3.6, vs: ac.vs, pitch: pitchOf(ac), rpm: ac.rotor.rpm, x: ac.pos.x }
    if (script(tr, k, ac, st) === true) break
    hold = k.pitch !== 0 && k.pitch === last ? hold + DT : 0
    last = k.pitch
    st.stick = Math.max(-1, Math.min(1, st.stick + k.pitch * keyPitchRate(hold) * DT))
    const dth = k.throttleTarget - st.throttle
    st.throttle += Math.sign(dth) * Math.min(Math.abs(dth), KEY_THROTTLE_RATE * DT)
    ctl.pitch = st.stick
    ctl.roll = 0
    ctl.yaw = 0
    ctl.throttle = st.throttle
    ctl.prerotator = k.prerot
    ctl.wheelBrake = k.brake ? 1 : 0
    assist.apply(DT, ac, ctl, { pitchActive: k.pitch !== 0, rollActive: false, yawActive: false, analog: false })
    ac.step(DT, ctl, env)
    t += DT
    if (verbose && t >= next) {
      next += 1
      log.push(
        `   t=${pad(f0(t), 3)} x ${pad(f0(ac.pos.x), 5)} agl ${pad(f1(ac.agl), 6)} ias ${pad(f0(ac.ias * 3.6), 4)} vs ${pad(f1(ac.vs), 5)} cab ${pad(f1(pitchOf(ac)), 5)} rotor ${pad(f0(ac.rotor.rpm), 4)}/${f0(ac.cmp!.rpmTarget)} col ${f1((ac.cmp!.collective * 180) / Math.PI)} mást ${f1((ac.cmp!.mast * 180) / Math.PI)} ${ac.cmp!.state} palanca ${st.stick.toFixed(2)}(${ctl.pitch.toFixed(2)}) gas ${st.throttle.toFixed(2)} motor ${f0(ac.engineRpm)} β ${f1(ac.cmp!.beta)} T ${f0(ac.propThrust)} g ${ac.gLoad.toFixed(2)}`,
      )
    }
  }
  return { ac, log }
}
const JUMP_PUSH = Number(process.env.JUMP_PUSH ?? -0.35)
const JUMP_T = Number(process.env.JUMP_T ?? 0.5)
const JUMP_V = Number(process.env.JUMP_V ?? 40)
/** palanca en la aproximación sin motor (~90 km/h) */
const APP_STICK = Number(process.env.APP_STICK ?? 0.7)
const ROLL_STICK = Number(process.env.ROLL_STICK ?? 0.3)
const toward = (k: Keys, cur: number, target: number) => {
  k.pitch = Math.abs(target - cur) < 0.02 ? 0 : target > cur ? 1 : -1
}

// ---------------------------------------------------------------------------
if (want('jump')) {
  console.log('\n== DESPEGUE POR SALTO (prerrotar con frenos, soltar a pleno gas) ==')
  for (const dual of [false, true]) {
    let phase = 0
    let tRel = 0
    let x0 = 0
    let rpmRel = 0
    let maxAgl = 0
    let aglAt5 = 0
    let tPre = 0
    let minAgl = 1e9
    let minIasAir = 1e9
    let accel = true
    const res = flyKeys(
      (ac) => ac.placeOnGround(0, 0, 0, 90),
      (tr, k, ac, st) => {
        if (phase === 0) {
          // prerrotación: frenos, palanca al centro, gas a fondo, prerrotador
          k.brake = true
          k.throttleTarget = 1
          k.prerot = tr.t > 2
          toward(k, st.stick, 0)
          if (tr.rpm >= 360) {
            phase = 1
            tRel = tr.t
            tPre = tr.t - 2
            x0 = ac.pos.x
            rpmRel = tr.rpm
          }
        } else {
          // suelta prerrotador y frenos: salta; arriba, palanca adelante para coger velocidad con la
          // hélice y, pasados los 40 km/h, un poco atrás para subir
          k.prerot = false
          k.brake = false
          k.throttleTarget = 1
          if (tr.ias > JUMP_V) accel = false
          toward(k, st.stick, tr.t - tRel < JUMP_T ? 0 : accel ? JUMP_PUSH : 0.3)
          maxAgl = Math.max(maxAgl, tr.agl)
          if (tr.t - tRel > 3 && tr.t - tRel < 15) minAgl = Math.min(minAgl, tr.agl)
          if (tr.t - tRel > 3 && tr.t - tRel < 15) minIasAir = Math.min(minIasAir, tr.ias)
          if (Math.abs(tr.t - tRel - 5) < DT) aglAt5 = tr.agl
          if (tr.agl > 150 || tr.t - tRel > 90) return true
        }
      },
      200,
      dual,
    )
    const ac = res.ac
    const dist = ac.pos.x - x0
    // (con pasajero, tras el salto el aparato se hunde hasta pocos metros mientras coge la velocidad mínima)
    const ok = !ac.crash && maxAgl > 15 && ac.agl > 100 && minAgl > 0.5
    console.log(
      `${dual ? 'con pasajero' : 'solo'}: prerrota a ${f0(rpmRel)} rpm en ${f0(tPre)} s; ${ac.crash ? `ACCIDENTE ${ac.crash.title}: ${ac.crash.detail}` : `a los 5 s ${f1(aglAt5)} m; altura mínima entre 3 y 15 s ${f1(minAgl)} m (IAS mín ${f0(minIasAir)} km/h); sigue: ${f0(ac.agl)} m a ${f0(ac.ias * 3.6)} km/h tras ${f0(dist)} m, rotor ${f0(ac.rotor.rpm)} rpm`}`,
    )
    if (verbose) for (const l of res.log) console.log(l)
    check(`Salto ${dual ? 'con pasajero' : 'solo'}: altura en los primeros 5 s`, ac.crash ? -1 : aglAt5, dual ? 10 : 15, 45, 'm', 1)
    checkBool(`Salto ${dual ? 'con pasajero' : 'solo'}: sin accidente y sigue en vuelo (100 m)`, ok, ac.crash ? ac.crash.title : `máx ${f1(maxAgl)} m, mín ${f1(minAgl)} m, ${f0(ac.agl)} m a ${f0(ac.ias * 3.6)} km/h`)
  }
}

// ---------------------------------------------------------------------------
if (want('roll')) {
  // (soltando el prerrotador por debajo de las vueltas de salto no salta: colectivo de vuelo y carrera)
  console.log('\n== DESPEGUE RODANDO (prerrotar a 300 rpm, por debajo de las del salto, soltar, pleno gas, palanca atrás) ==')
  let phase = 0
  let x0 = 0
  let xLift = -1
  let vLift = 0
  let x15 = -1
  const res = flyKeys(
    (ac) => ac.placeOnGround(0, 0, 0, 90),
    (tr, k, ac, st) => {
      if (phase === 0) {
        k.brake = true
        k.throttleTarget = 1
        k.prerot = tr.t > 2
        toward(k, st.stick, 0)
        if (tr.rpm >= 300) {
          phase = 1
          x0 = ac.pos.x
        }
      } else {
        k.prerot = false
        k.brake = false
        k.throttleTarget = 1
        toward(k, st.stick, tr.agl > 1 ? 0.3 : ROLL_STICK)
        if (xLift < 0 && tr.agl > 0.4) {
          xLift = ac.pos.x - x0
          vLift = tr.ias
        }
        if (x15 < 0 && tr.agl > 15) x15 = ac.pos.x - x0
        if (tr.agl > 60) return true
      }
    },
    200,
  )
  const ac = res.ac
  console.log(ac.crash ? `ACCIDENTE ${ac.crash.title}: ${ac.crash.detail}` : `ruedas fuera a ${f0(vLift)} km/h tras ${f0(xLift)} m; 15 m de altura a ${f0(x15)} m; 60 m a ${f0(ac.ias * 3.6)} km/h`)
  if (verbose) for (const l of res.log) console.log(l)
  check('Despegue rodando: carrera', ac.crash ? -1 : xLift, 20, 350, 'm')
}

// ---------------------------------------------------------------------------
if (want('land')) {
  console.log('\n== PLANEO SIN MOTOR Y TOMA CON RECOGIDA (teclado + ayuda) ==')
  for (const [flare, engOff] of [
    [8, false],
    [6, false],
    [10, false],
    [8, true],
  ] as const) {
    let td: { ias: number; vs: number; x: number } | null = null
    let stopX = 0
    const res = flyKeys(
      (ac, st) => {
        ac.placeInAir(0, 150, 0, 90, 120 / 3.6)
        st.throttle = 0
        st.stick = APP_STICK
        if (engOff) ac.engineOn = false
      },
      (tr, k, ac, st) => {
        k.throttleTarget = 0
        if (engOff) ac.engineOn = false
        if (ac.onGround) {
          if (!td) td = { ias: tr.ias, vs: -ac.hardness, x: ac.pos.x }
          k.brake = true
          toward(k, st.stick, 0)
          if (ac.groundSpeed < 0.3) {
            stopX = ac.pos.x
            return true
          }
          return
        }
        if (tr.agl < flare) k.pitch = st.stick < 0.99 ? 1 : 0
        else toward(k, st.stick, APP_STICK)
      },
      120,
    )
    const ac = res.ac
    const t = td as { ias: number; vs: number; x: number } | null
    const txt = ac.crash ? `ACCIDENTE ${ac.crash.title}: ${ac.crash.detail}` : t ? `toma a ${f0(t.ias)} km/h y ${(-t.vs).toFixed(1)} m/s, para en ${f0(stopX - t.x)} m` : 'no llega'
    console.log(`recogida a ${flare} m${engOff ? ' (motor parado)' : ''}: ${txt}`)
    if (verbose) for (const l of res.log) console.log(l)
    if (flare === 8) checkBool(`Toma sin motor con recogida a 8 m${engOff ? ', motor parado' : ''}`, !ac.crash && t !== null && -t.vs < 2.6 && stopX - t.x < 120, txt)
  }
}

// ---------------------------------------------------------------------------
if (want('brake')) {
  console.log('\n== EN TIERRA ==')
  const ac = make()
  ac.placeOnGround(0, 0, 0, 90)
  const ctl = defaultControls()
  ctl.wheelBrake = 1
  for (let i = 0; i < 240 * 4; i++) ac.step(DT, ctl, env)
  console.log(`asiento ${f1(pitchOf(ac))}°, motor al ralentí ${f0(ac.engineRpm)} rpm, empuje ${f0(ac.propThrust)} N`)
  // frenada a fondo desde 60 km/h
  ctl.wheelBrake = 0
  ctl.rotorBrake = true
  ac.vel.copy(new Vector3(1, 0, 0).applyQuaternion(ac.quat).setY(0).normalize()).multiplyScalar(60 / 3.6)
  for (let i = 0; i < 240; i++) ac.step(DT, ctl, env)
  const p0 = ac.pos.clone()
  ctl.wheelBrake = 1
  for (let i = 0; i < 240 * 20 && !ac.crash && ac.groundSpeed > 0.05; i++) ac.step(DT, ctl, env)
  const d = ac.pos.distanceTo(p0)
  console.log(`frenada a fondo desde ${f0(ac.groundSpeed)}→0 km/h: ${ac.crash ? ac.crash.title : `${f0(d)} m`}`)
  check('Frenada a fondo desde ~55 km/h', ac.crash ? -1 : d, 10, 40, 'm')
  // estático a pleno gas con frenos y prerrotando
  const b = make()
  b.placeOnGround(0, 0, 0, 90)
  const c2 = defaultControls()
  Object.assign(c2, { wheelBrake: 1, throttle: 1 })
  for (let i = 0; i < 240 * 8; i++) b.step(DT, c2, env)
  console.log(`a pleno gas frenado (sin prerrotar): motor ${f0(b.engineRpm)} rpm, paso ${f1(b.cmp!.beta)}°, empuje ${f0(b.propThrust)} N, ${f0(b.enginePower / 1000)} kW, se mueve ${f1(b.pos.x)} m`)
  check('Empuje estático a pleno gas (hélice de 2,16 m)', b.propThrust, 4800, 7000, 'N')
}

console.log('\n== RESULTADO ==')
let fails = 0
for (const c of checks) {
  if (!c.ok) fails++
  console.log(`${c.ok ? ' OK  ' : 'FALLA'} ${c.name}: ${c.value}   [esperado ${c.expected}]`)
}
console.log(fails === 0 ? '\nTodo dentro de rango.' : `\n${fails} comprobación(es) fuera de rango.`)
