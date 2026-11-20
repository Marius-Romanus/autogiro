// Banco de pruebas de la física de accidentes (sin navegador):
//   node --experimental-strip-types tools/crash-test.ts [escenario]
//
// Cada escenario lanza el despiece del autogiro (src/sim/wreck) contra un suelo
// plano o una pared, con las formas de respaldo, y comprueba que el resultado es
// físicamente coherente: nada se rompe en reposo ni en una toma firme, el tren se
// rompe en una toma muy dura, las palas se parten al tocar el suelo girando, la
// energía nunca crece, y el disco entero sigue cayendo a ~10 m/s en vertical.

import { Quaternion, Vector3 } from 'three'
import { loadRapier, Wreck, WRECK_DT, type WreckStart } from '../src/sim/wreck/Wreck.ts'
import { fallbackShapes } from '../src/sim/wreck/shapes.ts'
import { CG, GEOM } from '../src/sim/autogyro.ts'

const DEG = Math.PI / 180
const RPM = (2 * Math.PI) / 60
const GEAR_Y = 1.05 + CG.y // altura del CG sobre el suelo con las ruedas apoyadas
// Autogiro colgado bajo el disco: eje del rotor del CG al buje y aparato girado para
// que ese eje quede vertical. Es la única actitud en la que el empuje (a lo largo del
// eje, aplicado en el buje) pasa por el CG y no da par: un descenso vertical sostenido.
const HANG_AXIS = new Vector3().subVectors(GEOM.hub, CG).normalize()
const HANG_TILT = Math.atan2(-HANG_AXIS.x, HANG_AXIS.y) / DEG

interface Scenario {
  name: string
  start: Partial<WreckStart> & { pitch?: number; bank?: number; height?: number; rotorAxis?: Vector3 }
  seconds: number
  wall?: boolean
  /** copa de árbol: esfera (centro x, y, z, radio) */
  tree?: [number, number, number, number]
  check: (w: Wreck, log: Log) => string[]
}

interface Log {
  maxRotorRpm: number
  rotorRpmAt1s: number
  keMax: number
  ke0: number
  vy: number[]
  minPodY: number
}

function startFor(s: Scenario['start']): WreckStart {
  const pitch = (s.pitch ?? 0) * DEG
  const bank = (s.bank ?? 0) * DEG
  const quat = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), pitch).premultiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), bank))
  const axis = s.rotorAxis ?? new Vector3(0, 1, 0).applyAxisAngle(new Vector3(0, 0, 1), 8 * DEG) // disco 8° atrás
  const shapes = fallbackShapes(axis, new Vector3(1, 0, 0.4).normalize(), 0.3, 0)
  return {
    pos: new Vector3(0, s.height ?? GEAR_Y + 0.002, 0),
    quat,
    vel: s.vel ?? new Vector3(),
    omegaBody: s.omegaBody ?? new Vector3(),
    rotorOmega: s.rotorOmega ?? 0,
    propOmega: s.propOmega ?? 0,
    propTorque: s.propTorque ?? 0,
    mass: s.mass ?? 395,
    rho: 1.15,
    wind: new Vector3(),
    shapes,
    preBreak: s.preBreak ?? [],
    rotorKick: s.rotorKick,
    seed: 12345,
    heightAt: () => 0,
  }
}

const scenarios: Scenario[] = [
  {
    name: 'reposo sobre las ruedas (rotor parado)',
    start: {},
    seconds: 3,
    check: (w) => {
      const e: string[] = []
      const br = w.brokenSummary()
      if (br.length) e.push(`se ha roto algo en reposo: ${br.join(', ')}`)
      const m = w.podMotion()
      if (m.v > 0.05) e.push(`no se queda quieto: ${m.v.toFixed(3)} m/s`)
      return e
    },
  },
  {
    name: 'toma firme a 2,5 m/s',
    start: { vel: new Vector3(3, -2.5, 0), height: GEAR_Y + 0.05, rotorOmega: 250 * RPM },
    seconds: 2.5,
    check: (w) => {
      const br = w.brokenSummary()
      return br.length ? [`toma firme rompe: ${br.join(', ')}`] : []
    },
  },
  {
    name: 'toma muy dura a 7 m/s',
    start: { vel: new Vector3(2, -7, 0), height: GEAR_Y + 0.05, rotorOmega: 200 * RPM },
    seconds: 3,
    check: (w) => {
      const br = w.brokenSummary()
      return br.some((b) => /tren|horquilla|eje de la rueda/.test(b)) ? [] : [`el tren aguanta 7 m/s (roto: ${br.join(', ') || 'nada'})`]
    },
  },
  {
    name: 'vuelco en tierra con el rotor a 330 rpm',
    start: { bank: 40, omegaBody: new Vector3(-1.8, 0, 0), height: GEAR_Y + 0.25, rotorOmega: 330 * RPM, vel: new Vector3(4, 0, 0) },
    seconds: 4,
    check: (w, log) => {
      const e: string[] = []
      const br = w.brokenSummary()
      if (!br.some((b) => /palas del rotor/.test(b))) e.push(`las palas no se rompen al tocar el suelo girando (roto: ${br.join(', ') || 'nada'})`)
      if (w.rotorOmega() / RPM > 120 && w.jointIntact('rotor')) e.push(`el rotor sigue a ${(w.rotorOmega() / RPM).toFixed(0)} rpm tras golpear el suelo`)
      void log
      return e
    },
  },
  {
    name: 'morro contra el suelo a 25 m/s (picado 35°)',
    start: { pitch: -35, vel: new Vector3(25 * Math.cos(35 * DEG), -25 * Math.sin(35 * DEG), 0), height: 2.4, rotorOmega: 340 * RPM, propOmega: 230, propTorque: 150 },
    seconds: 5,
    check: (w, log) => {
      const e: string[] = []
      const br = w.brokenSummary()
      if (br.length < 3) e.push(`impacto de 25 m/s apenas rompe nada: ${br.join(', ')}`)
      if (w.peakSeatG < 15) e.push(`deceleración en cabina sospechosamente baja: ${w.peakSeatG.toFixed(0)} g`)
      void log
      return e
    },
  },
  {
    name: 'caída con el rotor sin vueltas (100 rpm) desde 40 m',
    start: { height: 40, rotorOmega: 100 * RPM, vel: new Vector3(5, -3, 0) },
    seconds: 6,
    check: (w, log) => {
      const e: string[] = []
      const v = Math.min(...log.vy)
      if (v > -15) e.push(`cae demasiado despacio sin vueltas: ${v.toFixed(1)} m/s`)
      void w
      return e
    },
  },
  {
    name: 'descenso vertical con el disco entero (autorrotación)',
    // Arranca en equilibrio (colgado bajo el disco). Con el disco 8° atrás y la góndola
    // nivelada, el empuje pasa 10 cm por detrás del CG: ~400 N·m de picado sin compensar
    // que ningún autogiro con la palanca fija aguanta, y el disco deriva (con Rapier 0.12
    // pasaba por poco porque calculaba mal la inercia del rotor y la deriva iba más lenta).
    start: { height: 300, rotorOmega: 352 * RPM, vel: new Vector3(0, -10, 0), rotorAxis: HANG_AXIS, pitch: -HANG_TILT },
    seconds: 8,
    check: (w, log) => {
      const v = log.vy[log.vy.length - 1]
      void w
      return v < -13 || v > -7 ? [`descenso vertical estabilizado en ${v.toFixed(1)} m/s (esperado ~10)`] : []
    },
  },
  {
    name: 'contra una pared a 22 m/s',
    start: { height: 3.5, vel: new Vector3(22, 0, 0), rotorOmega: 340 * RPM, propOmega: 230, propTorque: 150 },
    wall: true,
    seconds: 4,
    check: (w) => {
      const e: string[] = []
      if (w.chunks.length < 4) e.push(`casi no salen cascotes de la pared (${w.chunks.length})`)
      const br = w.brokenSummary()
      if (!br.some((b) => /palas del rotor|cabeza|mástil/.test(b))) e.push(`el rotor sale intacto de la pared: ${br.join(', ')}`)
      return e
    },
  },
  {
    name: 'rotor y góndola contra la copa de un árbol a 24 m/s',
    start: { height: 4.2, vel: new Vector3(24, 0, 0), rotorOmega: 345 * RPM, propOmega: 230, propTorque: 150 },
    tree: [14, 5, 0, 3.5],
    seconds: 5,
    check: (w) => {
      const e: string[] = []
      const br = w.brokenSummary()
      if (!br.some((b) => /palas del rotor/.test(b))) e.push(`las palas salen intactas de la copa: ${br.join(', ') || 'nada'}`)
      return e
    },
  },
]

function wallTris(x: number): Float32Array {
  // pared de 30×12 m perpendicular a X, más un tejado
  const q = (a: number[], b: number[], c: number[], d: number[]) => [...a, ...b, ...c, ...a, ...c, ...d]
  return new Float32Array([
    ...q([x, 0, -15], [x, 12, -15], [x, 12, 15], [x, 0, 15]),
    ...q([x + 8, 0, -15], [x + 8, 12, -15], [x + 8, 12, 15], [x + 8, 0, 15]),
    ...q([x, 12, -15], [x + 8, 12, -15], [x + 8, 12, 15], [x, 12, 15]),
  ])
}

async function main(): Promise<void> {
  await loadRapier()
  const only = process.argv[2]
  let fails = 0
  for (const sc of scenarios) {
    if (only && !sc.name.includes(only)) continue
    const t0 = performance.now()
    const w = new Wreck(startFor(sc.start))
    w.setGround(() => 0, 0, 0)
    if (sc.wall) w.setObstacles(wallTris(4), 0, 0)
    if (sc.tree) {
      const [tx, ty, tz, tr] = sc.tree
      w.foliage = (p) => (p.x - tx) ** 2 + (p.y - ty) ** 2 + (p.z - tz) ** 2 < tr * tr
    }
    const log: Log = { maxRotorRpm: 0, rotorRpmAt1s: 0, keMax: 0, ke0: w.kinetic(), vy: [], minPodY: Infinity }
    const pe0 = 395 * 9.80665 * (startFor(sc.start).pos.y + 5)
    const n = Math.round(sc.seconds / WRECK_DT)
    const v = new Vector3()
    let energyErr = ''
    let kePrev = w.kinetic()
    let jump = { dE: 0, t: 0 }
    for (let i = 0; i < n; i++) {
      w.step()
      w.impacts.length = 0
      // ningún paso puede ganar más energía que la que da la gravedad (+ motor y
      // autorrotación, que son pequeños): un salto así es una "explosión" numérica
      const ke = w.kinetic()
      if (ke - kePrev > jump.dE) jump = { dE: ke - kePrev, t: i * WRECK_DT }
      kePrev = ke
      if (i % 24 === 0) {
        w.partVelocity('pod', v)
        log.vy.push(v.y)
        const ke = w.kinetic()
        log.keMax = Math.max(log.keMax, ke)
        if (ke > log.ke0 + pe0 + 2000 && !energyErr) energyErr = `la energía crece: ${(ke / 1000).toFixed(1)} kJ (inicial ${(log.ke0 / 1000).toFixed(1)} kJ) en t=${(i * WRECK_DT).toFixed(2)} s`
      }
    }
    const ms = performance.now() - t0
    const errs = sc.check(w, log)
    if (energyErr) errs.push(energyErr)
    if (jump.dE > 4000) errs.push(`salto de energía de ${(jump.dE / 1000).toFixed(1)} kJ en un paso (t=${jump.t.toFixed(3)} s)`)
    const breaks = w.breaks.map((b) => `${b.name} (t=${'?'} ×${b.ratio.toFixed(1)})`)
    console.log(`${errs.length ? '✗' : '✓'} ${sc.name}`)
    console.log(`    roto: ${w.brokenSummary().join(', ') || 'nada'}`)
    console.log(`    pico en asiento ${w.peakSeatG.toFixed(1)} g · rotor ${(w.rotorOmega() / RPM).toFixed(0)} rpm · sólidos ${w.bodyCount()} · cascotes ${w.chunks.length} · vy final ${log.vy[log.vy.length - 1].toFixed(2)} m/s · ${(ms / (sc.seconds / (1 / 60))).toFixed(2)} ms/fotograma`)
    if (process.env.VERBOSE) console.log('    ' + breaks.join('\n    '))
    for (const e of errs) console.log(`    ✗ ${e}`)
    if (errs.length) fails++
    w.dispose()
  }
  console.log(fails ? `\n${fails} escenario(s) con problemas` : '\nTodo correcto')
  process.exitCode = fails ? 1 : 0
}

void main()
