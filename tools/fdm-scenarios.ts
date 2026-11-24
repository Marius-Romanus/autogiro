// Escenarios de vuelo completos con un "piloto de teclado" simulado que usa el
// mismo código de ayuda al pilotaje que el juego.
//   node --experimental-strip-types tools/fdm-scenarios.ts [filtro] [-v]
import { Vector3 } from 'three'
import { Autogyro, defaultControls, type Controls, type Environment } from '../src/sim/autogyro.ts'
import { KEY_THROTTLE_RATE, keyPitchRate, PilotAssist } from '../src/sim/assist.ts'
import { isaDensity } from '../src/sim/atmosphere.ts'
import { AIRFRAMES } from '../src/sim/airframes.ts'
import { applyTune, pickAirframe } from './af-override.ts'

const DT = 1 / 240
const flat = { heightAt: (_x: number, _z: number, n: Vector3) => (n.set(0, 1, 0), 0) }
const env: Environment = { rho: isaDensity(650), wind: new Vector3(), ground: flat }
const verbose = process.argv.includes('-v')
const STEP = Number(process.env.STEP ?? 2)
const afArg = process.argv.slice(2).find((a) => a.startsWith('af='))?.slice(3) ?? 'generic'
if (!(afArg in AIRFRAMES)) throw new Error(`aparato desconocido: ${afArg} (${Object.keys(AIRFRAMES).join(', ')})`)
console.log(`Aparato: ${afArg}`)
const airframe = pickAirframe(afArg)
// (los argumentos clave=valor, como af=, pull= o runStick=, no son filtros)
const filter = process.argv.slice(2).find((a) => !a.startsWith('-') && !a.includes('='))

/** Estado del teclado del jugador. */
interface Keys {
  pitch: -1 | 0 | 1 // W = −1 (adelante), S = +1 (atrás)
  throttleTarget: number
  prerot: boolean
  brake: boolean
  rotorBrake: boolean
  engineOff: boolean
}

interface Tel {
  t: number
  ias: number
  vxBody: number
  vs: number
  pitch: number
  roll: number
  agl: number
  rpm: number
  g: number
  stick: number
}

interface Outcome {
  crash: string
  touchdown: { ias: number; impact: number; t: number } | null
  minIas: number
  maxSink: number
  minVx: number
  maxAgl: number
  minRpm: number
  maxRpm: number
  minG: number
  impact: number
  log: string[]
  end: Tel
}

function fly(
  setup: (ac: Autogyro, st: { stick: number; throttle: number }) => void,
  script: (tel: Tel, keys: Keys, ac: Autogyro) => boolean | void,
  opts: { assist?: boolean; dual?: boolean; secs?: number; statsFrom?: number; stopOnGround?: boolean } = {},
): Outcome {
  const ac = new Autogyro(airframe)
  applyTune(ac)
  ac.setLoad(Boolean(opts.dual))
  const st = { stick: 0, throttle: 0 }
  setup(ac, st)
  const ctl: Controls = defaultControls()
  const assist = new PilotAssist()
  const keys: Keys = { pitch: 0, throttleTarget: st.throttle, prerot: false, brake: false, rotorBrake: false, engineOff: false }
  const out: Outcome = { crash: '', touchdown: null, minIas: 1e9, maxSink: 0, minVx: 1e9, maxAgl: 0, minRpm: 1e9, maxRpm: 0, minG: 9, impact: 0, log: [], end: null as unknown as Tel }
  const f = new Vector3()
  const r = new Vector3()
  const vb = new Vector3()
  const qi = ac.quat.clone()
  let t = 0
  let next = 0
  let hold = 0
  let lastKey = 0
  let wasAir = !ac.onGround
  for (const a of process.argv) {
    const m = a.match(/^g\.(\w+)=(-?[\d.]+)$/)
    if (m) (assist.gains as any)[m[1]] = Number(m[2])
  }
  const secs = opts.secs ?? 120
  while (t < secs) {
    f.set(1, 0, 0).applyQuaternion(ac.quat)
    r.set(0, 0, 1).applyQuaternion(ac.quat)
    vb.copy(ac.vel).applyQuaternion(qi.copy(ac.quat).invert())
    const tel: Tel = {
      t,
      ias: ac.ias * 3.6,
      vxBody: vb.x * 3.6,
      vs: ac.vs,
      pitch: Math.asin(Math.max(-1, Math.min(1, f.y))) * 57.3,
      roll: Math.asin(Math.max(-1, Math.min(1, -r.y))) * 57.3,
      agl: ac.agl,
      rpm: ac.rotor.rpm,
      g: ac.gLoad,
      stick: st.stick,
    }
    out.end = tel
    if (script(tel, keys, ac) === true) break
    // --- teclado → mandos (igual que Input.ts) ---
    hold = keys.pitch !== 0 && keys.pitch === lastKey ? hold + DT : 0
    lastKey = keys.pitch
    st.stick = Math.max(-1, Math.min(1, st.stick + keys.pitch * keyPitchRate(hold) * DT))
    const dth = keys.throttleTarget - st.throttle
    st.throttle += Math.sign(dth) * Math.min(Math.abs(dth), KEY_THROTTLE_RATE * DT)
    ctl.pitch = st.stick
    ctl.roll = 0
    ctl.yaw = 0
    ctl.throttle = st.throttle
    ctl.prerotator = keys.prerot
    ctl.wheelBrake = keys.brake ? 1 : 0
    ctl.rotorBrake = keys.rotorBrake
    ac.engineOn = !keys.engineOff
    if (opts.assist !== false) assist.apply(DT, ac, ctl, { pitchActive: keys.pitch !== 0, rollActive: false, yawActive: false, analog: false })
    ac.step(DT, ctl, env)
    t += DT
    if (t > (opts.statsFrom ?? 0)) {
      out.minIas = Math.min(out.minIas, tel.ias)
      out.maxSink = Math.min(out.maxSink, tel.vs)
      out.minVx = Math.min(out.minVx, tel.vxBody)
      out.maxAgl = Math.max(out.maxAgl, tel.agl)
      out.minRpm = Math.min(out.minRpm, tel.rpm)
      out.maxRpm = Math.max(out.maxRpm, tel.rpm)
      out.minG = Math.min(out.minG, tel.g)
    }
    if (verbose && t >= next) {
      next += STEP
      out.log.push(
        `   t=${t.toFixed(0).padStart(3)} agl ${tel.agl.toFixed(1).padStart(6)} ias ${tel.ias.toFixed(0).padStart(4)} vs ${tel.vs.toFixed(1).padStart(6)} cabeceo ${tel.pitch.toFixed(1).padStart(6)} alabeo ${tel.roll.toFixed(1).padStart(5)} rotor ${tel.rpm.toFixed(0)} g ${tel.g.toFixed(2)} palanca ${st.stick.toFixed(2)} (${ctl.pitch.toFixed(2)}) gas ${st.throttle.toFixed(2)} motor ${ac.engineRpm.toFixed(0)}`,
      )
    }
    if (ac.crash) {
      out.impact = ac.hardness
      if (verbose) out.log.push(`   → ${ac.crash.detail.slice(0, 110)}`)
      out.crash = `${ac.crash.title} (t=${t.toFixed(0)} s, ${tel.ias.toFixed(0)} km/h, vs ${tel.vs.toFixed(1)}, cabeceo ${tel.pitch.toFixed(0)}°, alabeo ${tel.roll.toFixed(0)}°)`
      break
    }
    if (ac.onGround && wasAir && !out.touchdown) {
      out.touchdown = { ias: tel.ias, impact: ac.hardness, t }
      if (opts.stopOnGround !== false) break
    }
    if (!ac.onGround) wasAir = true
  }
  return out
}

const results: { name: string; ok: boolean; text: string }[] = []
function report(name: string, ok: boolean, text: string, o?: Outcome): void {
  if (filter && !name.toLowerCase().includes(filter.toLowerCase())) return
  results.push({ name, ok, text })
  console.log(`${ok ? ' OK  ' : 'FALLA'} ${name}: ${text}`)
  if (verbose && o) for (const l of o.log) console.log(l)
}
const inAir = (alt: number, speedKmh = 106) => (ac: Autogyro, st: { stick: number; throttle: number }) => {
  ac.placeInAir(0, alt, 0, 90, speedKmh / 3.6)
  st.throttle = 0.62
}
const run = (name: string) => !filter || name.toLowerCase().includes(filter.toLowerCase())

// ---------------------------------------------------------------------------
// 1. Corte de motor en crucero
// ---------------------------------------------------------------------------
function engineOut(name: string, stickTarget: number, engineOff: boolean, assist: boolean, alt: number, expect: (o: Outcome) => boolean): void {
  if (!run(name)) return
  const o = fly(
    inAir(alt),
    (tel, k) => {
      if (tel.t > 8) {
        k.throttleTarget = 0
        k.engineOff = engineOff
        k.pitch = Math.abs(stickTarget - tel.stick) < 0.01 ? 0 : stickTarget > tel.stick ? 1 : -1
      }
    },
    { assist, statsFrom: 9 },
  )
  const end = o.crash
    ? `ACCIDENTE EN VUELO: ${o.crash}`
    : o.touchdown
      ? `llega al suelo en ${o.touchdown.t.toFixed(0)} s a ${o.touchdown.ias.toFixed(0)} km/h y ${o.touchdown.impact.toFixed(1)} m/s`
      : 'sigue volando'
  // un contacto sin recogida rompe el tren: eso no es un fallo de estabilidad
  const groundHit = /tren roto/.test(o.crash)
  const txt = `${groundHit ? `planea hasta el suelo (sin recogida: ${o.end.ias.toFixed(0)} km/h, ${o.end.vs.toFixed(1)} m/s)` : end} | IAS mín ${o.minIas.toFixed(0)}, descenso máx ${o.maxSink.toFixed(1)} m/s, vx mín ${o.minVx.toFixed(0)} km/h`
  report(name, (!o.crash || groundHit || !assist) && expect(o), txt, o)
}
engineOut('Corte de gas, manos fuera', 0, false, true, 400, (o) => o.minIas > 80 && o.maxSink > -8)
engineOut('Motor apagado, manos fuera', 0, true, true, 400, (o) => o.minIas > 80 && o.maxSink > -9.5)
engineOut('Corte de gas, palanca media atrás', 0.5, false, true, 400, (o) => o.minIas > 30 && o.maxSink > -8)
// Descenso vertical: ~1,8 veces la velocidad inducida de referencia v_h. El Carter PAV (1,7 t sobre un disco
// de 148 m²: v_h ≈ 7 m/s frente a ~5,5 de los biplaza) baja en vertical a unos 12,8 m/s.
const VERT_SINK = ({ carterpav: 15 } as Record<string, number>)[airframe.id] ?? 13.5
engineOut('Corte de gas, palanca todo atrás', 1, false, true, 700, (o) => o.minVx > -8 && o.maxSink > -VERT_SINK)
engineOut('Motor apagado, palanca todo atrás', 1, true, true, 700, (o) => o.minVx > -8 && o.maxSink > -VERT_SINK)
engineOut('Corte de gas, palanca adelante', -0.3, false, true, 500, (o) => o.maxSink > -14)
engineOut('Corte de gas SIN ayuda y sin tocar nada (espiral lenta esperada)', 0, false, false, 500, (o) => o.end.t > 45)

// ---------------------------------------------------------------------------
// 2. Despegue con teclado
// ---------------------------------------------------------------------------
// Prerrotación hasta 210 rpm en los actuales; el Cierva prerrota hasta ~185 rpm (R&M 1859), cerca del
// tope de su embrague
const PRE_AF = pickAirframe(afArg)
// El Carter PAV prerrota con todo el gas (el prerrotador se lleva casi todo el motor); soltando a 300 rpm,
// por debajo de las de salto (330), no salta y despega rodando como un autogiro, con la palanca a 0,4 (con
// más, la profundidad lo encabrita en la carrera)
const AF_TAKEOFF = ({ carterpav: { preRpm: 300, preThrottle: 1, runStick: 0.4 } } as Record<string, { preRpm: number; preThrottle: number; runStick: number }>)[afArg]
const PRE_RPM = AF_TAKEOFF?.preRpm ?? (PRE_AF.prerotator ? PRE_AF.prerotator.maxRpm * 0.92 : 210)
// Carrera. Los actuales (rotor bipala basculante): despegue «de prestaciones» de la guía de la CAA
// para autogiros (HSL04): al soltar el prerrotador, palanca toda atrás y TODO el gas a la vez.
// El Cierva (rotor tripala articulado), como en las notas del piloto de la RAE (R&M 1859, ap. I,
// §11.5): frenos y embrague se sueltan a la vez con una palanca, con todo el gas, y se acelera con la
// palanca adelante (disco a la mínima incidencia: menos resistencia, aunque el rotor pierda vueltas);
// con velocidad para autorrotar se tira «despacio pero a fondo» y el rotor se embala hasta despegar.
// (Correr con la palanca adelante y pocas vueltas haría batir las palas de un bipala basculante.)
const argNum = (k: string, d: number) => Number(process.argv.find((a) => a.startsWith(`${k}=`))?.slice(k.length + 1) ?? d)
/** velocidad (km/h) a la que se tira de la palanca; 0 = toda atrás desde el principio */
const PULL_KMH = argNum('pull', PRE_AF.rotor.blades > 2 ? 60 : 0)
/** palanca en la carrera una vez tirada (1 = toda atrás) */
const RUN_STICK = argNum('runStick', AF_TAKEOFF?.runStick ?? 1)
function takeoff(name: string, dual: boolean): void {
  if (!run(name)) return
  let phase = 0
  let tLift = -1
  // carrera = hasta que las ruedas dejan el suelo (como la mide la RAE); el paso a la fase de
  // ascenso se da a 0,4 m
  let xRun = 0
  let vRun = 0
  let pulled = PULL_KMH <= 0
  let x0 = 0
  let rpmStart = 0
  const o = fly(
    (ac) => ac.placeOnGround(0, 0, 0, 90),
    (tel, k, ac) => {
      if (phase === 0) {
        // prerrotación: frenos, palanca adelante, gas ~50 %, prerrotador
        k.brake = true
        k.pitch = tel.stick > -0.99 ? -1 : 0
        k.throttleTarget = AF_TAKEOFF?.preThrottle ?? 0.4
        k.prerot = tel.t > 2
        if (tel.rpm >= PRE_RPM) {
          phase = 1
          rpmStart = tel.rpm
          x0 = ac.pos.x
        }
      } else if (phase === 1) {
        // carrera: suelta frenos y prerrotador, todo el gas y palanca (ver arriba)
        k.prerot = false
        k.brake = false
        k.throttleTarget = 1
        if (!pulled) pulled = tel.ias >= PULL_KMH
        const target = pulled ? RUN_STICK : -1
        if (target >= 1) k.pitch = tel.stick < 0.99 ? 1 : 0
        else if (target <= -1) k.pitch = tel.stick > -0.99 ? -1 : 0
        else k.pitch = Math.abs(target - tel.stick) < 0.02 ? 0 : target > tel.stick ? 1 : -1
        if (ac.onGround) {
          xRun = ac.pos.x - x0
          vRun = tel.ias
        }
        if (tel.agl > 0.4) {
          phase = 2
          tLift = tel.t
        }
      } else if (phase === 2) {
        // ya en el aire: ceder palanca para acelerar en efecto suelo y subir a ~95 km/h
        k.throttleTarget = 1
        const target = 0.2
        k.pitch = Math.abs(target - tel.stick) < 0.02 ? 0 : target > tel.stick ? 1 : -1
        if (tel.agl > 40) return true
      }
    },
    { dual, secs: 150, stopOnGround: false },
  )
  const ok = !o.crash && o.end.agl > 40 && xRun > 50 && xRun < 260
  report(
    name,
    ok,
    o.crash
      ? `ACCIDENTE: ${o.crash}`
      : `prerrota a ${rpmStart.toFixed(0)} rpm${PULL_KMH > 0 ? `, tira de la palanca a ${PULL_KMH} km/h` : ''}; despega (ruedas fuera) a ${vRun.toFixed(0)} km/h tras ${xRun.toFixed(0)} m; a 40 m de altura con ${o.end.ias.toFixed(0)} km/h y ${o.end.vs.toFixed(1)} m/s (rotor ${o.end.rpm.toFixed(0)} rpm) en ${(o.end.t - tLift).toFixed(0)} s`,
    o,
  )
}
takeoff('Despegue con teclado, solo', false)
takeoff('Despegue con teclado, con pasajero', true)

// ---------------------------------------------------------------------------
// 3. Aterrizaje sin motor con recogida
// ---------------------------------------------------------------------------
function landing(name: string, flareAgl: number, approachStick: number, engineOff: boolean): Outcome | null {
  if (!run(name)) return null
  let stopped = false
  const o = fly(
    (ac, st) => {
      ac.placeInAir(0, 120, 0, 90, 24)
      st.throttle = 0
      st.stick = approachStick
      ac.enginePower = 0
      ac.engineRpm = 2500
    },
    (tel, k, ac) => {
      k.throttleTarget = 0
      k.engineOff = engineOff
      if (ac.onGround) {
        k.brake = true
        k.pitch = 0
        if (ac.groundSpeed < 0.5) stopped = true
        return stopped
      }
      k.pitch = tel.agl < flareAgl && tel.stick < 0.99 ? 1 : 0
    },
    { secs: 90, stopOnGround: false },
  )
  return o
}
{
  const rows: string[] = []
  let good = 0
  const heights = [3, 4, 5, 6, 7, 8, 10, 13]
  for (const h of heights) {
    const o = landing('Aterrizaje sin motor', h, 0.25, false)
    if (!o) continue
    const td = o.touchdown
    const ok = !o.crash && td !== null && td.impact < 2.6
    if (ok) good++
    rows.push(`recogida a ${h} m → ${o.crash ? `ACCIDENTE (${o.crash.split(' (')[0]}; impacto ${o.impact.toFixed(1)} m/s a ${o.end.ias.toFixed(0)} km/h, cabeceo ${o.end.pitch.toFixed(0)}°)` : `toma a ${td!.ias.toFixed(0)} km/h, ${td!.impact.toFixed(1)} m/s`}`)
  }
  if (rows.length) report('Aterrizaje sin motor (planeo a ~80 km/h, tirar de palanca al llegar a la altura indicada)', good >= 3, `\n        ${rows.join('\n        ')}`)
  // (el Cavalon, más pesado y con menos recorrido de cabeza hacia atrás, recoge un metro antes)
  // (el Gyro Tractor, con las barras, planea empinado: hay que empezar la recogida más arriba)
  const flareOff = ({ cavalon: 7, sclightning: 8, sclightning_f: 7, tractor: 8, wa116: 8 } as Record<string, number>)[airframe.id] ?? 6
  const o2 = landing('Aterrizaje con motor PARADO', flareOff, 0.25, true)
  if (o2) {
    const td = o2.touchdown
    report(`Aterrizaje con motor PARADO, recogida a ${flareOff} m`, !o2.crash && td !== null && td.impact < 2.8, o2.crash ? `ACCIDENTE: ${o2.crash}` : `toma a ${td!.ias.toFixed(0)} km/h, ${td!.impact.toFixed(1)} m/s`, o2)
  }
}

// ---------------------------------------------------------------------------
// 4. Baja carga: empujar la palanca a fondo en crucero
// ---------------------------------------------------------------------------
if (run('Baja carga')) {
  let rpm0 = 0
  const o = fly(
    inAir(800),
    (tel, k) => {
      if (tel.t < 8) rpm0 = tel.rpm
      // empujón de 1.2 s y después recuperar tirando
      k.pitch = tel.t > 8 && tel.t < 9.2 ? -1 : tel.t >= 9.2 && tel.stick < 0.1 ? 1 : 0
      if (tel.t > 30) return true
    },
    { statsFrom: 8, secs: 40 },
  )
  report(
    'Baja carga (empujón de palanca 1,2 s en crucero y recuperación)',
    !o.crash && o.minG < 0.7 && o.minRpm < rpm0 * 0.97,
    o.crash ? `ACCIDENTE: ${o.crash}` : `g mínimo ${o.minG.toFixed(2)}, rotor ${rpm0.toFixed(0)} → ${o.minRpm.toFixed(0)} rpm (las vueltas caen al descargar), recupera`,
    o,
  )
}

// ---------------------------------------------------------------------------
// 5. Flapping: correr a pleno gas sin prerrotar
// ---------------------------------------------------------------------------
if (run('Flapping')) {
  let pulled = false
  const o = fly(
    (ac) => ac.placeOnGround(0, 0, 0, 90),
    (tel, k) => {
      // sin prerrotar apenas, palanca adelante y pleno gas; al llegar a 70 km/h, tirar
      // (el rotor ligero del Sport Copter se embala en 5 s: con 2 s queda igual de parado que los otros)
      k.prerot = tel.t < (({ sclightning: 2, sclightning_f: 2 } as Record<string, number>)[airframe.id] ?? 5)
      k.throttleTarget = 1
      if (tel.ias < 70 && !pulled) k.pitch = tel.stick > -0.9 ? -1 : 0
      else {
        pulled = true
        k.pitch = tel.stick < 0.99 ? 1 : 0
      }
      if (tel.t > 45) return true
    },
    { secs: 50, stopOnGround: false },
  )
  // Un rotor articulado de palas largas y lentas (el Cierva, 3 palas con articulaciones de
  // batimiento) no golpea los topes: corriendo se embala y el aparato se va al aire, que es como
  // despegaban los primeros Cierva antes de tener prerrotador. Lo que se comprueba entonces es eso.
  // (el tripala del Vencejo es uno moderno, sin articulaciones: bate como los bipala)
  const articulated = airframe.rotor.blades > 2 && airframe.id === 'cierva'
  // El rotor del Carter PAV, con 34 kg en cada punta, tampoco llega a los topes: el aparato se va al
  // aire con el ala (y, sin nadie al alabeo en esta prueba, acaba tocando con una punta).
  const heavy = Boolean(airframe.slowedRotor)
  const flapped = /flapping|Batimiento/i.test(o.crash)
  report(
    articulated
      ? 'Rotor articulado: correr a 70 km/h con el rotor casi parado y tirar de palanca lo embala, sin batimiento'
      : heavy
        ? 'Rotor lento de gran inercia: correr a 70 km/h con el rotor casi parado y tirar de palanca no lo hace batir'
        : 'Flapping (correr a 70 km/h con el rotor casi parado y entonces tirar de palanca)',
    articulated ? !flapped && o.maxRpm > 280 * (airframe.rpmScale ?? 1) : heavy ? !flapped : flapped,
    o.crash ? `${articulated || heavy ? 'termina en' : 'como debe ser →'} ${o.crash}` : `sin accidente (rotor ${o.end.rpm.toFixed(0)} rpm, ${o.end.ias.toFixed(0)} km/h, agl ${o.end.agl.toFixed(1)})`,
    o,
  )
}

console.log(`\n${results.filter((r) => !r.ok).length === 0 ? 'Todos los escenarios correctos.' : `${results.filter((r) => !r.ok).length} escenario(s) fallan.`}`)
