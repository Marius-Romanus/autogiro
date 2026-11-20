// Comprobaciones en tierra por aparato: asiento estático, reparto de peso,
// ángulo de golpe de cola y rotación en el despegue. Los de rueda de cola (Cierva C.30A)
// se asientan con la cola apoyada; su hélice está delante y toca si el morro baja.
//   node --experimental-strip-types tools/fdm-ground.ts
import { Vector3 } from 'three'
import { Autogyro, defaultControls, type Environment } from '../src/sim/autogyro.ts'
import { AIRFRAMES } from '../src/sim/airframes.ts'
import { isaDensity } from '../src/sim/atmosphere.ts'

const DT = 1 / 240
const flat = { heightAt: (_x: number, _z: number, n: Vector3) => (n.set(0, 1, 0), 0) }
const env: Environment = { rho: isaDensity(650), wind: new Vector3(), ground: flat }
const pitchOf = (ac: Autogyro) => Math.asin(new Vector3(1, 0, 0).applyQuaternion(ac.quat).y) * 57.2958

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
  b.rotor.rpm = 215 * k
  // palanca toda atrás y todo el gas desde el principio (despegue «de prestaciones» de la CAA; el
  // Cierva acaba igual tras tirar de la palanca: ver el escenario de despegue de fdm-scenarios)
  c2.pitch = 1
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
    if (b.agl > (tw ? 1.0 : 8)) break
  }
  const okRun = !b.crash && liftV > 0
  if (!okStatic || !okRun) fails++
  console.log(
    `${af.id.padEnd(8)} | batalla ${wheelbase.toFixed(2)} m | ${tw ? 'cola' : 'morro'} carga ${(noseShare * 100).toFixed(0)} % | asiento ${pitchOf(ac).toFixed(1)}° | golpe de cola a ${tailAngle.toFixed(1)}° | hélice toca a ${propAngle.toFixed(1)}°${tw ? ' morro abajo' : ''} | palanca atrás sin corregir: morro arriba a ${noseUpV.toFixed(0)} km/h, despega a ${liftV.toFixed(0)} km/h, cabeceo máx ${maxPitch.toFixed(1)}°${tailTouched ? ', ROZA COLA' : ''}${b.crash ? ` → ${b.crash.title}` : ''} ${okStatic && okRun ? 'OK' : 'FALLA'}`,
  )
}
console.log(fails ? `\n${fails} aparato(s) con problemas en tierra.` : '\nTodos los aparatos se comportan bien en tierra.')
