// Comprobaciones en tierra por aparato: asiento estático, reparto de peso,
// ángulo de golpe de cola y rotación en el despegue; frenos y agarre parado (aparcado con
// viento, prerrotado frenado como dice la guía y frenada a fondo). Los de rueda de cola (Cierva C.30A)
// se asientan con la cola apoyada; su hélice está delante y toca si el morro baja.
//   node --experimental-strip-types tools/fdm-ground.ts
import { Vector3 } from 'three'
import { Autogyro, defaultControls, type Environment } from '../src/sim/autogyro.ts'
import { AIRFRAMES } from '../src/sim/airframes.ts'
import { isaDensity, WindModel } from '../src/sim/atmosphere.ts'

const DT = 1 / 240
const flat = { heightAt: (_x: number, _z: number, n: Vector3) => (n.set(0, 1, 0), 0) }
const env: Environment = { rho: isaDensity(650), wind: new Vector3(), ground: flat }
const pitchOf = (ac: Autogyro) => Math.asin(new Vector3(1, 0, 0).applyQuaternion(ac.quat).y) * 57.2958

// Valores propios de algún aparato (si falta, los de los autogiros). El Carter PAV prerrota con todo el
// gas (su prerrotador se lleva casi todo el motor: al 40 % no pasa de ~185 rpm) y corre desde 300 rpm con la
// palanca a 0,3 (con toda atrás la profundidad lo sienta sobre la ruedecilla de cola); como en el Cierva,
// solo interesa la carrera: sin nadie a los mandos, una vez en el aire acabaría cayendo de lado.
const GROUND_AF: Record<string, { runRpm: number; runStick: number; preThrottle: number; stopAgl: number }> = {
  carterpav: { runRpm: 300, runStick: 0.3, preThrottle: 1, stopAgl: 1 },
  // con el 915 iS (un 20 % más de par que el 914) las ~3400 rpm de motor de la guía salen con un tercio de gas
  vencejo: { runRpm: 176, runStick: 1, preThrottle: 0.33, stopAgl: 8 },
  tractor: { runRpm: 215, runStick: 1, preThrottle: 0.33, stopAgl: 8 },
}

let fails = 0
for (const af of Object.values(AIRFRAMES)) {
  // --- asiento estático ---
  const ac = new Autogyro(af)
  ac.setLoad(false)
  ac.placeOnGround(0, 0, 0, 90)
  const ctl = defaultControls()
  ctl.wheelBrake = 1
  for (let i = 0; i < 240 * 4; i++) ac.step(DT, ctl, env)
  const contacts = (ac as unknown as { contacts: { name: string; kind: string; force: number }[] }).contacts
  const tw = af.tailWheel !== undefined
  const third = contacts.find((c) => c.kind === 'nose' || c.kind === 'tailwheel')!
  const mains = contacts.filter((c) => c.kind === 'wheel').reduce((a, c) => a + c.force, 0)
  const noseShare = third.force / (third.force + mains)
  const steer = (af.noseWheel ?? af.tailWheel)!
  const wheelbase = Math.abs(steer.x - af.mainL.x)
  const rest = ac.restAttitude().pitch * 57.2958
  const gy = af.mainL.y
  // golpe de cola: cabeceo (sobre las principales) al que toca el patín / la cola
  const tailAngle = Math.atan2(af.tail.y - gy, af.mainL.x - af.tail.x) * 57.2958
  // ángulo al que la punta inferior de la hélice tocaría el suelo girando sobre las principales
  // (propulsora: morro arriba; tractora: morro abajo)
  const propClear = af.prop.y - af.propRadius - gy
  const propAngle = Math.atan2(propClear, Math.abs(af.mainL.x - af.prop.x)) * 57.2958
  const okStatic = !ac.crash && Math.abs(pitchOf(ac) - rest) < 1.5 && noseShare > 0.08 && noseShare < 0.45

  // --- carrera de despegue con palanca toda atrás: ¿levanta el morro?, ¿toca cola? ---
  const b = new Autogyro(af)
  b.setLoad(false)
  b.placeOnGround(0, 0, 0, 90)
  const c2 = defaultControls()
  const k = af.rpmScale ?? 1
  b.rotor.rpm = GROUND_AF[af.id]?.runRpm ?? 215 * k
  // palanca toda atrás y todo el gas desde el principio (despegue «de prestaciones» de la CAA; el
  // Cierva acaba igual tras tirar de la palanca: ver el escenario de despegue de fdm-scenarios)
  c2.pitch = GROUND_AF[af.id]?.runStick ?? 1
  c2.throttle = 1
  let maxPitch = 0
  let noseUpV = -1
  let liftV = -1
  let tailTouched = false
  for (let i = 0; i < 240 * 45 && !b.crash; i++) {
    b.step(DT, c2, env)
    const p = pitchOf(b)
    maxPitch = Math.max(maxPitch, p)
    if (noseUpV < 0 && p > rest + 2) noseUpV = b.ias * 3.6
    if (liftV < 0 && b.agl > 0.4) liftV = b.ias * 3.6
    const cs = (b as unknown as { contacts: { kind: string; force: number }[] }).contacts
    if (cs.some((c) => c.kind === 'skid' && c.force > 0)) tailTouched = true
    // (el Cierva es algo inestable en alabeo: sin nadie a los mandos, una vez en el aire se
    // acabaría yendo de lado; aquí solo interesa la carrera)
    if (b.agl > (GROUND_AF[af.id]?.stopAgl ?? (tw ? 1.0 : 8))) break
  }
  const okRun = !b.crash && liftV > 0
  if (!okStatic || !okRun) fails++
  console.log(
    `${af.id.padEnd(8)} | batalla ${wheelbase.toFixed(2)} m | ${tw ? 'cola' : 'morro'} carga ${(noseShare * 100).toFixed(0)} % | asiento ${pitchOf(ac).toFixed(1)}° | golpe de cola a ${tailAngle.toFixed(1)}° | hélice toca a ${propAngle.toFixed(1)}°${tw ? ' morro abajo' : ''} | palanca atrás sin corregir: morro arriba a ${noseUpV.toFixed(0)} km/h, despega a ${liftV.toFixed(0)} km/h, cabeceo máx ${maxPitch.toFixed(1)}°${tailTouched ? ', ROZA COLA' : ''}${b.crash ? ` → ${b.crash.title}` : ''} ${okStatic && okRun ? 'OK' : 'FALLA'}`,
  )
}
// --- frenos y agarre parado ---
// 1) Aparcado (parking y freno de rotor, ralentí) con el viento por defecto del juego (250°/6 kt,
//    turbulencia 25 %) en cuatro rumbos: ni gira ni se arrastra.
// 2) Prerrotado como dice la guía (gas 40 %, palanca adelante, frenos puestos) hasta las vueltas a
//    las que se suelta (200-220 rpm; el Cierva, ~180): ni avanza ni lo tuerce la reacción del
//    prerrotador. Solo y con pasajero, con y sin viento. Se informa de si además sujeta con el
//    rotor ya al máximo que da el prerrotador.
// 3) Frenada a fondo rodando a 60 km/h sin capotar.
console.log('\nFrenos y agarre parado:')
const headingOf = (ac: Autogyro) => {
  const f = new Vector3(1, 0, 0).applyQuaternion(ac.quat)
  return Math.atan2(f.x, -f.z) * 57.2958
}
const turned = (a: number, b: number) => Math.abs(((b - a + 540) % 360) - 180)
for (const af of Object.values(AIRFRAMES)) {
  const notes: string[] = []
  let bad = false
  // 1) aparcado con viento
  let worstTurn = 0
  let worstMove = 0
  for (const hdg of [80, 170, 260, 350]) {
    const ac = new Autogyro(af)
    ac.setLoad(false)
    ac.placeOnGround(0, 0, 0, hdg)
    const wind = new WindModel()
    wind.settings = { fromDeg: 250, speed: 6 * 0.514444, turbulence: 0.25 }
    const wv = new Vector3()
    const e: Environment = { ...env, wind: wv }
    const ctl = defaultControls()
    ctl.wheelBrake = 1
    ctl.rotorBrake = true
    const h0 = headingOf(ac)
    const p0 = ac.pos.clone()
    for (let i = 0; i < 240 * 60 && !ac.crash; i++) {
      wind.sample(DT, Math.max(0, ac.agl), ac.tas, wv)
      ac.step(DT, ctl, e)
    }
    worstTurn = Math.max(worstTurn, turned(h0, headingOf(ac)))
    worstMove = Math.max(worstMove, ac.pos.distanceTo(p0))
  }
  if (worstTurn > 0.5 || worstMove > 0.1) bad = true
  notes.push(`aparcado con viento: gira ${worstTurn.toFixed(1)}°, se mueve ${(worstMove * 100).toFixed(0)} cm`)
  // 2) prerrotado frenado
  const release = Math.min(220, (af.prerotator?.maxRpm ?? 320) - 15)
  const pre: string[] = []
  for (const [pax, windy] of [[false, false], [true, false], [false, true], [true, true]] as const) {
    const ac = new Autogyro(af)
    ac.setLoad(pax)
    ac.placeOnGround(0, 0, 0, 80)
    const wind = new WindModel()
    wind.settings = { fromDeg: 250, speed: windy ? 6 * 0.514444 : 0, turbulence: windy ? 0.25 : 0 }
    const wv = new Vector3()
    const e: Environment = { ...env, wind: wv }
    const ctl = defaultControls()
    Object.assign(ctl, { wheelBrake: 1, pitch: -1, throttle: GROUND_AF[af.id]?.preThrottle ?? 0.4, prerotator: true })
    const h0 = headingOf(ac)
    const p0 = ac.pos.clone()
    let atRelease: { d: number; turn: number } | null = null
    for (let i = 0; i < 240 * 45 && !ac.crash; i++) {
      wind.sample(DT, Math.max(0, ac.agl), ac.tas, wv)
      ac.step(DT, ctl, e)
      if (!atRelease && ac.rotor.rpm >= release) atRelease = { d: ac.pos.distanceTo(p0), turn: turned(h0, headingOf(ac)) }
    }
    const label = `${pax ? 'con pasajero' : 'solo'}${windy ? ' y viento' : ''}`
    if (!atRelease || atRelease.d > 0.2 || atRelease.turn > 0.5 || ac.crash) {
      bad = true
      pre.push(`${label}: NO SUJETA${atRelease ? ` (${atRelease.d.toFixed(1)} m, ${atRelease.turn.toFixed(1)}°)` : ` (rotor ${ac.rotor.rpm.toFixed(0)} rpm)`}`)
    } else {
      const still = ac.pos.distanceTo(p0) < 0.2
      pre.push(`${label}: sujeta${still ? ` también a ${ac.rotor.rpm.toFixed(0)} rpm` : `; pasadas, a ${ac.rotor.rpm.toFixed(0)} rpm, se arrastra`}`)
    }
  }
  notes.push(`prerrotado al 40 % hasta ${release} rpm: ${pre.join(', ')}`)
  // 3) frenada a fondo a 60 km/h
  {
    const ac = new Autogyro(af)
    ac.setLoad(false)
    ac.placeOnGround(0, 0, 0, 90)
    const ctl = defaultControls()
    ctl.rotorBrake = true
    for (let i = 0; i < 240 * 2; i++) ac.step(DT, ctl, env)
    ac.vel.copy(new Vector3(1, 0, 0).applyQuaternion(ac.quat).setY(0).normalize()).multiplyScalar(60 / 3.6)
    for (let i = 0; i < 240; i++) ac.step(DT, ctl, env)
    const p0 = ac.pos.clone()
    ctl.wheelBrake = 1
    for (let i = 0; i < 240 * 20 && !ac.crash && ac.groundSpeed > 0.05; i++) ac.step(DT, ctl, env)
    if (ac.crash) bad = true
    notes.push(`frenada a fondo desde 60 km/h: ${ac.crash ? ac.crash.title : `para en ${ac.pos.distanceTo(p0).toFixed(0)} m`}`)
  }
  if (bad) fails++
  console.log(`${af.id.padEnd(8)} | ${notes.join(' | ')} ${bad ? 'FALLA' : 'OK'}`)
}

console.log(fails ? `\n${fails} comprobación(es) con problemas en tierra.` : '\nTodos los aparatos se comportan bien en tierra.')
