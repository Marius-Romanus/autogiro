// Prueba rápida del despiece con rotor tripala y hélice bipala (Cierva C.30A): que se crea sin
// errores, que el disco entero autorrota en descenso vertical y que las palas se parten al
// tocar el suelo girando. Usa las formas de respaldo (cajas), no el GLB.
//   node --experimental-strip-types tools/crash-test-3blade.ts
import { Quaternion, Vector3 } from 'three'
import { loadRapier, Wreck, WRECK_DT } from '../src/sim/wreck/Wreck.ts'
import { fallbackShapes } from '../src/sim/wreck/shapes.ts'
import { CG } from '../src/sim/autogyro.ts'
import { CIERVA_C30, propCoeffs } from '../src/sim/airframes.ts'
import type { WreckSpec } from '../src/sim/wreck/parts.ts'

const DEG = Math.PI / 180
const RPM = (2 * Math.PI) / 60
const af = CIERVA_C30
const spec: WreckSpec = {
  rotorR: af.rotor.radius,
  blades: af.rotor.blades,
  bladeMass: Math.min(60, ((3 * af.rotor.inertia) / (af.rotor.blades * af.rotor.radius ** 2)) * 0.9),
  rotorInertia: af.rotor.inertia,
  rotorOmega0: ((af.rpmScale ?? 1) * 352 * 2 * Math.PI) / 60,
  propBlades: af.propBlades ?? 3,
  propR: af.propRadius,
  propCp0: propCoeffs(af).cp0,
  zones: af.wreck,
}

function make(o: { bank?: number; height: number; vel: Vector3; rotorRpm: number; omegaBody?: Vector3; axis?: Vector3 }): Wreck {
  const quat = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), (o.bank ?? 0) * DEG)
  const axis = o.axis ?? new Vector3(0, 1, 0)
  const shapes = fallbackShapes(axis, new Vector3(1, 0, 0.3).normalize(), 0.2, 0, af.hub.clone(), spec)
  return new Wreck({
    pos: new Vector3(0, o.height, 0),
    quat,
    vel: o.vel,
    omegaBody: o.omegaBody ?? new Vector3(),
    rotorOmega: o.rotorRpm * RPM,
    propOmega: 0,
    propTorque: 0,
    mass: 728,
    rho: 1.15,
    wind: new Vector3(),
    shapes,
    preBreak: [],
    seed: 7,
    heightAt: () => 0,
    spec,
  })
}

await loadRapier()
let fails = 0
const report = (name: string, ok: boolean, txt: string) => {
  if (!ok) fails++
  console.log(`${ok ? '✓' : '✗'} ${name}\n    ${txt}`)
}

// 1. Disco entero en descenso vertical desde 60 m: autorrota (~9–11 m/s)
{
  const hang = new Vector3().subVectors(af.hub, CG).normalize()
  const w = make({ height: 60, vel: new Vector3(0, -9, 0), rotorRpm: 215, axis: hang })
  const v = new Vector3()
  for (let i = 0; i < 480 * 4; i++) w.step(WRECK_DT)
  w.partVelocity('pod', v)
  const vy = v.y
  const rpm = w.rotorOmega() / RPM
  report('descenso vertical con el disco tripala entero', vy < -6 && vy > -13 && rpm > 120, `vy ${vy.toFixed(1)} m/s, rotor ${rpm.toFixed(0)} rpm, roto: ${w.brokenSummary().join(', ') || 'nada'}`)
}

// 2. Vuelco en tierra girando: se parten palas (de las tres)
{
  const w = make({ bank: 40, height: 1.6, vel: new Vector3(4, 0, 0), rotorRpm: 220, omegaBody: new Vector3(-1.8, 0, 0) })
  for (let i = 0; i < 480 * 4; i++) w.step(WRECK_DT)
  const br = w.brokenSummary()
  report('vuelco en tierra con el rotor tripala a 220 rpm', br.some((b) => /palas del rotor/.test(b)), `roto: ${br.join(', ') || 'nada'} · rotor ${(w.rotorOmega() / RPM).toFixed(0)} rpm`)
}
console.log(fails ? `\n${fails} prueba(s) fallan.` : '\nTodo correcto')
process.exit(fails ? 1 : 0)
