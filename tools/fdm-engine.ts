// Banco del grupo motopropulsor: régimen, potencia y empuje a distintas velocidades.
//   node --experimental-strip-types tools/fdm-engine.ts [af=ela10] [propPitch=1.07]
import { Vector3 } from 'three'
import { Autogyro, defaultControls } from '../src/sim/autogyro.ts'
import { airframeById } from '../src/sim/airframes.ts'
const DT = 1 / 240
const flat = { heightAt: (_x: number, _z: number, n: Vector3) => (n.set(0, 1, 0), 0) }
const arg = (k: string) => process.argv.slice(2).find((a) => a.startsWith(k + '='))?.slice(k.length + 1)
const base = airframeById(arg('af') ?? 'generic')
const af = { ...base, propPitch: Number(arg('propPitch') ?? base.propPitch) }
console.log(`${af.id}: ${af.engine.name}, paso de hélice ×${af.propPitch}`)
for (const rho of [1.225, 1.15, 0.9]) {
  const env = { rho, wind: new Vector3(), ground: flat }
  console.log(`rho ${rho}`)
  for (const [v, thr, on] of [[0,0,1],[0,0.5,1],[0,1,1],[25,1,1],[33,1,1],[44,1,1],[52,1,1],[28,0,1],[28,0.5,1],[28,0,0],[15,0,1]] as [number,number,number][]) {
    const ac = new Autogyro(af); ac.setLoad(false); ac.placeInAir(0, 500, 0, 90, v)
    ac.engineOn = !!on
    const ctl = defaultControls(); ctl.throttle = thr
    for (let i = 0; i < 240 * 12; i++) { ac.vel.set(v, 0, 0); ac.pos.y = 500; ac.quat.setFromAxisAngle(new Vector3(0,1,0), 0); ac.omega.set(0,0,0); ac.step(DT, ctl, env) }
    console.log(`  V ${(v*3.6).toFixed(0).padStart(3)} km/h gas ${(thr*100).toFixed(0).padStart(3)}% ${on ? 'ON ' : 'OFF'}: ${ac.engineRpm.toFixed(0).padStart(5)} rpm, ${(ac.enginePower/1000).toFixed(1).padStart(5)} kW, empuje ${ac.propThrust.toFixed(0).padStart(5)} N, rendimiento ${(ac.propThrust*v/Math.max(1,ac.enginePower)).toFixed(2)}`)
  }
}
