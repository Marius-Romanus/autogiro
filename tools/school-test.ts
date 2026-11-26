// Banco de la nota de la toma (src/school): el «piloto de teclado» de los escenarios hace tomas
// buenas y malas y se comprueba que la nota las distingue.
//   node --experimental-strip-types tools/school-test.ts [af=<id>] [-v]
// Tomas: recogida bien hecha, toma dura (recogida tardía), toma plana y rápida con la rueda de
// morro, toma larga (pasada la mitad de la pista), toma cruzada (viento de lado sin corregir) y
// toma de precisión en el punto y lejos de él.
import { Vector3 } from 'three'
import { Autogyro, defaultControls, type Controls, type Environment } from '../src/sim/autogyro.ts'
import { KEY_THROTTLE_RATE, keyPitchRate, PilotAssist } from '../src/sim/assist.ts'
import { isaDensity } from '../src/sim/atmosphere.ts'
import { AIRFRAMES } from '../src/sim/airframes.ts'
import { glideFor } from '../src/sim/glideData.ts'
import { LandingRecorder, type RunwayLocator } from '../src/school/LandingRecorder.ts'
import { gradeLanding, type LandingGrade, type LandingSample } from '../src/school/landingScore.ts'

const DT = 1 / 240
const verbose = process.argv.includes('-v')
const afId = process.argv.slice(2).find((a) => a.startsWith('af='))?.slice(3) ?? 'generic'
const af = AIRFRAMES[afId]
if (!af) throw new Error(`aparato desconocido: ${afId}`)
const flat = { heightAt: (_x: number, _z: number, n: Vector3) => (n.set(0, 1, 0), 0) }

/** Pista de 950 × 26 m a lo largo de +X; `x0`: principio de la zona de toma. */
function runway(x0: number, aim: number | null): RunwayLocator {
  return (pos, fwd) => ({
    want: true,
    hit: { s: pos.x - x0, d: pos.z, len: 950, hw: 13, before: 0, axisDeg: (Math.atan2(fwd.z, fwd.x) * 180) / Math.PI, aim },
  })
}

interface Keys {
  /** mantiene el eje de la pista con mando lateral (si no, alas niveladas y a donde lleve el viento) */
  track: boolean
  pitch: -1 | 0 | 1
  throttle: number
  brake: boolean
}
interface Run {
  sample: LandingSample | null
  touchX: number
  crash: string
}

function fly(
  setup: (ac: Autogyro, st: { stick: number; throttle: number }) => void,
  script: (ac: Autogyro, k: Keys, st: { stick: number }) => void,
  locate: RunwayLocator,
  wind = new Vector3(),
): Run {
  const ac = new Autogyro(af)
  ac.setLoad(false)
  const env: Environment = { rho: isaDensity(650), wind, ground: flat }
  const st = { stick: 0, throttle: 0 }
  setup(ac, st)
  const ctl: Controls = defaultControls()
  const assist = new PilotAssist()
  const rec = new LandingRecorder()
  rec.reset(false)
  const keys: Keys = { track: true, pitch: 0, throttle: st.throttle, brake: false }
  let hold = 0
  let last = 0
  let touchX = NaN
  const rgt = new Vector3()
  for (let t = 0; t < 150; t += DT) {
    script(ac, keys, st)
    hold = keys.pitch !== 0 && keys.pitch === last ? hold + DT : 0
    last = keys.pitch
    st.stick = Math.max(-1, Math.min(1, st.stick + keys.pitch * keyPitchRate(hold) * DT))
    const dth = keys.throttle - st.throttle
    st.throttle += Math.sign(dth) * Math.min(Math.abs(dth), KEY_THROTTLE_RATE * DT)
    ctl.pitch = st.stick
    // eje de la pista: alabeo proporcional al desvío y a la velocidad lateral
    if (keys.track) {
      const bank = Math.asin(Math.max(-1, Math.min(1, -rgt.set(0, 0, 1).applyQuaternion(ac.quat).y)))
      const want = ac.onGround ? 0 : Math.max(-0.2, Math.min(0.2, -0.012 * ac.pos.z - 0.06 * ac.vel.z))
      ctl.roll = Math.max(-0.5, Math.min(0.5, 1.26 * (want - bank) - 0.35 * ac.omega.x))
    } else ctl.roll = 0
    ctl.yaw = 0
    ctl.throttle = st.throttle
    ctl.wheelBrake = keys.brake ? 1 : 0
    assist.apply(DT, ac, ctl, { pitchActive: keys.pitch !== 0, rollActive: keys.track, yawActive: false, analog: false })
    ac.step(DT, ctl, env)
    if (ac.onGround && Number.isNaN(touchX)) touchX = ac.pos.x
    const s = rec.step(DT, ac, st.stick, st.throttle, locate)
    if (s) return { sample: s, touchX, crash: ac.crash?.title ?? '' }
    if (ac.crash) return { sample: null, touchX, crash: ac.crash.title }
  }
  return { sample: null, touchX, crash: 'no llega a parar' }
}

/** Planeo sin motor con recogida a `flareAgl` m y frenada hasta parar (como el escenario de fdm-scenarios). */
function glide(flareAgl: number, locate: RunwayLocator, wind?: Vector3): Run {
  return fly(
    (ac, st) => {
      ac.placeInAir(0, 120, 0, 90, 24)
      st.throttle = 0
      st.stick = 0.25
      ac.enginePower = 0
      ac.engineRpm = 2500
    },
    (ac, k, st) => {
      k.throttle = 0
      if (ac.onGround) {
        k.brake = true
        k.pitch = 0
      } else k.pitch = ac.agl < flareAgl && st.stick < 0.99 ? 1 : 0
    },
    locate,
    wind,
  )
}

/** Llegada con motor, tendida y rápida, sin recoger: se posa plano o con la rueda de morro. */
function flyOn(locate: RunwayLocator): Run {
  return fly(
    (ac, st) => {
      ac.placeInAir(0, 3, 0, 90, 29)
      st.throttle = 0.5
      st.stick = 0
    },
    (ac, k) => {
      if (ac.onGround) {
        k.throttle = 0
        k.brake = true
        k.pitch = 0
      } else {
        // baja a ~1 m/s con el gas y mantiene la palanca adelantada
        k.throttle = ac.vs < -0.9 ? 0.85 : ac.vs > -0.4 ? 0.35 : 0.55
        k.pitch = 0
      }
    },
    locate,
  )
}

let fails = 0
const grades: Record<string, LandingGrade | null> = {}
function show(name: string, r: Run): LandingGrade | null {
  const g = r.sample ? gradeLanding(r.sample) : null
  grades[name] = g
  const s = r.sample
  console.log(
    `      ${name}: ${g ? `nota ${g.score.toFixed(1)}` : `sin nota (${r.crash})`}` +
      (s ? ` | vs ${s.vs.toFixed(2)} m/s, suelo ${(s.gs * 3.6).toFixed(0)} km/h, cabeceo ${s.pitchDeg.toFixed(1)}°, deriva ${s.drift.toFixed(2)} m/s, s ${s.runway?.s.toFixed(0)} m, d ${s.runway?.d.toFixed(1)} m, recogida ${s.flareAgl?.toFixed(1)} m, carrera ${s.rollout?.toFixed(0)} m, rebotes ${s.bounces}${s.crash ? `, ACCIDENTE ${s.crash}` : ''}` : ''),
  )
  if (verbose && g) for (const c of g.comments) console.log(`         · ${c.key} ${JSON.stringify(c.vars)}`)
  return g
}
function check(name: string, ok: boolean, text: string): void {
  if (!ok) fails++
  console.log(`${ok ? ' OK  ' : 'FALLA'} ${name}: ${text}`)
}
const item = (g: LandingGrade | null, id: string) => g?.items.find((i) => i.id === id)

console.log(`Aparato: ${afId}`)
const ref = glideFor(af).flare
// el piloto automático afina su altura de recogida como un alumno: se queda con la que mejor le sale
let flare = ref
let dry: Run | null = null
let best = -1
for (const h of [ref, ref + 1, ref + 2, ref + 3]) {
  const r = glide(h, runway(0, null))
  const sc = r.sample ? gradeLanding({ ...r.sample, runway: null, wantRunway: false }).score : -1
  if (sc > best) {
    best = sc
    flare = h
    dry = r
  }
}
// la pista se coloca para que la toma buena caiga 80 m dentro
const x0 = dry!.touchX - 80

const good = show(`recogida bien hecha (a ${flare} m)`, glide(flare, runway(x0, null)))
check('Recogida bien hecha', good !== null && !good.crash && good.score >= 8, good ? `nota ${good.score}` : 'sin toma')

// recogida cada vez más tardía: la primera que da un golpe serio o rompe
let hard: LandingGrade | null = null
let hardAt = 0
for (const k of [0.75, 0.65, 0.55, 0.45, 0.3, 0]) {
  const h = flare * k
  const g = show(`recogida tardía a ${h.toFixed(1)} m`, glide(h, runway(x0, null)))
  if (g && (g.crash || (item(g, 'vs')?.level ?? 0) >= 3)) {
    hard = g
    hardAt = h
    break
  }
}
check('Toma dura', hard !== null && good !== null && hard.score <= good.score - 2.5 && hard.score <= 6 && /school.c.(vs|crash)/.test(hard.comments[0].key), hard ? `recogida a ${hardAt.toFixed(1)} m → nota ${hard.score}, comentario ${hard.comments[0].key}` : 'ninguna recogida tardía dio un golpe')

const nose = show('plana y rápida', flyOn(runway(-100, null)))
const att = item(nose, 'attitude')
check('Toma con la rueda de morro', nose !== null && good !== null && att !== undefined && att.level >= 1 && (item(nose, 'speed')?.level ?? 0) >= 2 && nose.score <= good.score - 2.5, nose ? `nota ${nose.score}, actitud ${att?.text}, velocidad nivel ${item(nose, 'speed')?.level}` : 'sin toma')

const long = show('toma larga', glide(flare, runway(dry!.touchX - 600, null)))
check('Toma larga', long !== null && good !== null && (item(long, 'point')?.level ?? 0) >= 2 && long.score < good.score, long ? `nota ${long.score}, punto ${item(long, 'point')?.text}` : 'sin toma')

// viento de lado de 2,5 m/s: el piloto sigue el eje con el morro al viento y no lo endereza al tocar
const cross = show('toma cruzada', glide(flare, runway(x0 - 100, null), new Vector3(0, 0, Number(process.env.XW ?? 2.5))))
check('Toma cruzada', cross !== null && good !== null && (item(cross, 'drift')?.level ?? 0) >= 2 && cross.score <= good.score - 1.5, cross ? `nota ${cross.score}, deriva nivel ${item(cross, 'drift')?.level}, eje nivel ${item(cross, 'axis')?.level}` : 'sin toma')

const onPoint = show('precisión en el punto', glide(flare, runway(dry!.touchX - 100, 100)))
const offPoint = show('precisión a 70 m', glide(flare, runway(dry!.touchX - 170, 100)))
check('Toma de precisión', onPoint !== null && offPoint !== null && item(onPoint, 'point')?.level === 0 && item(offPoint, 'point')?.level === 3 && offPoint.score <= onPoint.score - 2.5, onPoint && offPoint ? `en el punto ${onPoint.score}, a 70 m ${offPoint.score}` : 'sin toma')

console.log(fails ? `${fails} comprobación(es) fallan.` : `La nota distingue las tomas buenas de las malas (${afId}).`)
process.exit(fails ? 1 : 0)
