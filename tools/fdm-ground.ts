// Comprobaciones en tierra por aparato: asiento estático, reparto de peso,
// ángulo de golpe de cola y rotación en el despegue; frenos y agarre parado (aparcado con
// viento, prerrotado frenado como dice la guía y frenada a fondo). Los de rueda de cola (Cierva C.30A)
// se asientan con la cola apoyada; su hélice está delante y toca si el morro baja.
//   node --experimental-strip-types tools/fdm-ground.ts
import { Vector3 } from 'three'
import { Autogyro, defaultControls, type Environment } from '../src/sim/autogyro.ts'
import { SURFACE_GRIP } from '../src/sim/weather.ts'
import { AIRFRAMES, airframeById } from '../src/sim/airframes.ts'
import { FLOAT_KITS } from '../src/sim/floatKit.ts'
import { isaDensity, WindModel } from '../src/sim/atmosphere.ts'
import { PilotAssist } from '../src/sim/assist.ts'

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
  // (el impulsor de plasma de ficción: 220 kW; prerrota con poco más de un quinto de gas)
  sigilo: { runRpm: 176, runStick: 1, preThrottle: 0.22, stopAgl: 8 },
  // el C.6 corre desde las ~53 rpm de la cuerda con la palanca neutra (con ella atrás el disco, fijo, frena tanto
  // que no pasa de ~47 km/h); sin frenos ni prerrotador
  cierva_c6: { runRpm: 53, runStick: 0, preThrottle: 0, stopAgl: 1 },
  // el C.19 suelta el embrague a ~175 rpm y corre con la palanca a medias atrás (toda atrás, el disco fijo frena
  // tanto que no pasa de ~45 km/h); prerrota con algo más de medio gas
  cierva_c19: { runRpm: 175, runStick: 0.3, preThrottle: 0.5, stopAgl: 1 },
}

// Aparatos con ruedas: los del catálogo menos los hidroautogiros sin ellas (el Wilford, en tools/water-test.ts)
// y, con el tren abajo, los anfibios de los juegos de flotadores (floatKit.ts)
const WHEELED = [...Object.values(AIRFRAMES).filter((af) => !af.keelGear), ...Object.keys(FLOAT_KITS).map((id) => airframeById(id, true))]

let fails = 0
for (const af of WHEELED) {
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
  // (anfibios: las ruedas de proa van en los flotadores, más cerca del CG adelantado del simulador)
  const okStatic = !ac.crash && Math.abs(pitchOf(ac) - rest) < 1.5 && noseShare > 0.08 && noseShare < (af.amphib ? 0.52 : 0.45)

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
  // (vía estrecha sin rueda gobernable, el C.6: la ayuda lleva alas y rumbo en tierra, como en el juego)
  const ga = af.groundAssist ? new PilotAssist() : null
  for (let i = 0; i < 240 * 45 && !b.crash; i++) {
    if (ga) {
      c2.pitch = GROUND_AF[af.id]?.runStick ?? 1
      c2.roll = c2.yaw = 0
      ga.apply(DT, b, c2, { pitchActive: true, rollActive: false, yawActive: false, analog: false })
    }
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
    `${(af.floats ? af.id + '+flot' : af.id).padEnd(8)} | batalla ${wheelbase.toFixed(2)} m | ${tw ? 'cola' : 'morro'} carga ${(noseShare * 100).toFixed(0)} % | asiento ${pitchOf(ac).toFixed(1)}° | golpe de cola a ${tailAngle.toFixed(1)}° | hélice toca a ${propAngle.toFixed(1)}°${tw ? ' morro abajo' : ''} | palanca atrás sin corregir: morro arriba a ${noseUpV.toFixed(0)} km/h, despega a ${liftV.toFixed(0)} km/h, cabeceo máx ${maxPitch.toFixed(1)}°${tailTouched ? ', ROZA COLA' : ''}${b.crash ? ` → ${b.crash.title}` : ''} ${okStatic && okRun ? 'OK' : 'FALLA'}`,
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
for (const af of WHEELED) {
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
  // (sin frenos, el C.6: aparcado iría calzado; solo se informa)
  if ((worstTurn > 0.5 || worstMove > 0.1) && af.brakeMu !== 0) bad = true
  notes.push(`aparcado con viento${af.brakeMu === 0 ? ' (sin frenos ni calzos)' : ''}: gira ${worstTurn.toFixed(1)}°, se mueve ${(worstMove * 100).toFixed(0)} cm`)
  // 2) prerrotado frenado (sin prerrotador, el C.6: el rotor se lanza con cuerda y no hay nada que sujetar)
  if (af.ropeStart) notes.push('sin prerrotador (arranque con cuerda)')
  const release = Math.min(220, (af.prerotator?.maxRpm ?? 320) - 15)
  const pre: string[] = []
  for (const [pax, windy] of af.ropeStart ? [] : ([[false, false], [true, false], [false, true], [true, true]] as const)) {
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
  if (!af.ropeStart) notes.push(`prerrotado al 40 % hasta ${release} rpm: ${pre.join(', ')}`)
  // 3) frenada a fondo a 60 km/h: en seco (como siempre), con la pista mojada y con nieve
  //    (`Environment.grip`, sim/weather.ts). Mojada debe alargarse entre un 25 y un 70 % (μ 0,75 → 0,50
  //    da ×1,5 solo con frenos; la resistencia del aire y del rotor ayudan igual en los dos casos) y
  //    con nieve más aún, sin capotar ni irse de lado más de 2 m.
  {
    const stop = (grip?: number): { d: number; side: number; crash: string | null } => {
      const e: Environment = grip === undefined ? env : { ...env, grip }
      const ac = new Autogyro(af)
      ac.setLoad(false)
      ac.placeOnGround(0, 0, 0, 90)
      const ctl = defaultControls()
      ctl.rotorBrake = true
      const ga = af.groundAssist ? new PilotAssist() : null
      const step = () => {
        if (ga) {
          ctl.pitch = ctl.roll = ctl.yaw = 0
          ga.apply(DT, ac, ctl, { pitchActive: true, rollActive: false, yawActive: false, analog: false })
        }
        ac.step(DT, ctl, e)
      }
      for (let i = 0; i < 240 * 2; i++) step()
      const fwd = new Vector3(1, 0, 0).applyQuaternion(ac.quat).setY(0).normalize()
      // (sin frenos, el C.6, rueda desde su velocidad de toma: a 45 km/h y al ralentí el timón ya no lo sujeta)
      ac.vel.copy(fwd).multiplyScalar((af.brakeMu === 0 ? 35 : 60) / 3.6)
      for (let i = 0; i < 240; i++) step()
      const p0 = ac.pos.clone()
      ctl.wheelBrake = 1
      for (let i = 0; i < 240 * 30 && !ac.crash && ac.groundSpeed > 0.05; i++) step()
      const dp = ac.pos.clone().sub(p0)
      return { d: dp.length(), side: Math.abs(dp.x * fwd.z - dp.z * fwd.x), crash: ac.crash ? ac.crash.title : null }
    }
    const dry = stop()
    if (dry.crash) bad = true
    // (sin frenos, el 504K del C.6: solo se mira que ruede hasta pararse sin volcar; el patín de cola frena)
    const noBrakes = af.brakeMu === 0
    notes.push(`${noBrakes ? 'sin frenos, rodando desde 35' : 'frenada a fondo desde 60'} km/h: ${dry.crash ?? `para en ${dry.d.toFixed(0)} m`}`)
    const wet = stop(SURFACE_GRIP.wet)
    const snow = stop(SURFACE_GRIP.snow)
    const rw = wet.d / dry.d
    // (sin frenos no hay frenada que comparar: solo cuenta la carrera en seco)
    const okWet = noBrakes ? !dry.crash : !dry.crash && !wet.crash && !snow.crash && rw > 1.25 && rw < 1.7 && snow.d > wet.d * 1.2 && wet.side < 2 && snow.side < 2
    if (!okWet) bad = true
    notes.push(`mojada ${wet.crash ?? `${wet.d.toFixed(0)} m (×${rw.toFixed(2)})`}, con nieve ${snow.crash ?? `${snow.d.toFixed(0)} m (×${(snow.d / dry.d).toFixed(2)})`}${okWet ? '' : ' MAL'}`)
  }
  if (bad) fails++
  console.log(`${(af.floats ? af.id + '+flot' : af.id).padEnd(8)} | ${notes.join(' | ')} ${bad ? 'FALLA' : 'OK'}`)
}

console.log(fails ? `\n${fails} comprobación(es) con problemas en tierra.` : '\nTodos los aparatos se comportan bien en tierra.')
