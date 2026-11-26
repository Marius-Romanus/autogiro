// Banco de pruebas del agua en el modelo de vuelo (sin navegador):
//   node --experimental-strip-types tools/water-test.ts [filtro] [af=<id>] [-v]
//
// Un lago (superficie a 0 m, fondo a 6 m) y varios casos: un autogiro de ruedas que llega al agua casi
// parado flota unos segundos y se hunde; rasante a 80 km/h se estrella enseguida; uno con flotadores
// (el genérico con un par de flotadores de prueba) flota nivelado, navega y despega. Y los de verdad: el
// Wilford XOZ-1 y los aparatos con juego de flotadores (src/sim/floatKit.ts): en reposo, viraje con los
// pedales (y hacia dónde), despegue, toque suave y toque que rompe los montantes; los anfibios, además,
// amaraje con el tren abajo (vuelca) y en tierra con el tren abajo y arriba.

import { Quaternion, Vector3 } from 'three'
import { Autogyro, defaultControls, type Controls, type Environment } from '../src/sim/autogyro.ts'
import { isaDensity } from '../src/sim/atmosphere.ts'
import { AIRFRAMES, GENERIC, airframeById, type Airframe } from '../src/sim/airframes.ts'
import { elementVolume } from '../src/sim/hydro.ts'
import { FLOAT_KITS } from '../src/sim/floatKit.ts'
import { CG } from '../src/sim/autogyro.ts'
import { loadRapier, Wreck, WRECK_DT } from '../src/sim/wreck/Wreck.ts'
import { fallbackShapes } from '../src/sim/wreck/shapes.ts'

const DT = 1 / 240
const DEG = Math.PI / 180
const verbose = process.argv.includes('-v')
const filter = process.argv.slice(2).find((a) => !a.startsWith('-') && !a.includes('='))
const afArg = process.argv.slice(2).find((a) => a.startsWith('af='))?.slice(3) ?? 'generic'

const lake = (depth = 6) => ({
  heightAt: (_x: number, _z: number, n: Vector3) => (n.set(0, 1, 0), 0),
  waterDepth: () => depth,
})
const envFor = (depth = 6): Environment => ({ rho: isaDensity(300), wind: new Vector3(), ground: lake(depth) })

/** Genérico con dos flotadores de prueba (4 m, Ø 0,5 m, 1,5 m³ entre los dos) y el tren a la altura de las quillas. */
const FLOATS: Airframe = {
  ...GENERIC,
  id: 'floats-test',
  noseWheel: new Vector3(1.7, -1.3, 0),
  mainL: new Vector3(-0.3, -1.3, -1.0),
  mainR: new Vector3(-0.3, -1.3, 1.0),
  tail: new Vector3(-3.75, -0.6),
  floats: [
    { name: 'flotador izquierdo', bow: new Vector3(2.15, -1.03, -1.0), stern: new Vector3(-1.85, -1.07, -1.0), radius: 0.25, rudder: 0.06 },
    { name: 'flotador derecho', bow: new Vector3(2.15, -1.03, 1.0), stern: new Vector3(-1.85, -1.07, 1.0), radius: 0.25, rudder: 0.06 },
  ],
}

interface Run {
  ac: Autogyro
  t: number
  crash: string
  crashT: number
  maxDepth: number
  log: string[]
}

function pitchRoll(q: Quaternion): { pitch: number; roll: number } {
  const fwd = new Vector3(1, 0, 0).applyQuaternion(q)
  const right = new Vector3(0, 0, 1).applyQuaternion(q)
  return { pitch: Math.asin(Math.max(-1, Math.min(1, fwd.y))) / DEG, roll: Math.asin(Math.max(-1, Math.min(1, -right.y))) / DEG }
}

/** Simula `seconds` con los mandos que da `pilot` en cada instante. */
function run(ac: Autogyro, env: Environment, seconds: number, pilot: (t: number, c: Controls, ac: Autogyro) => boolean | void): Run {
  const c = defaultControls()
  const r: Run = { ac, t: 0, crash: '', crashT: -1, maxDepth: -Infinity, log: [] }
  let nextLog = 0
  for (let i = 0; i < seconds / DT; i++) {
    r.t = i * DT
    if (pilot(r.t, c, ac) === true) break
    ac.step(DT, c, env)
    r.maxDepth = Math.max(r.maxDepth, ac.hydro.cgDepth)
    if (r.t >= nextLog) {
      nextLog += 1
      const pr = pitchRoll(ac.quat)
      r.log.push(
        `t=${r.t.toFixed(0).padStart(3)} v=${(ac.vel.length() * 3.6).toFixed(0).padStart(3)} km/h vy=${ac.vel.y.toFixed(2).padStart(6)} cgDepth=${ac.hydro.cgDepth.toFixed(2).padStart(6)} flota=${((ac.hydro.buoyancy / (ac.mass * 9.80665)) * 100).toFixed(0).padStart(4)} % cab=${pr.pitch.toFixed(1).padStart(6)} alab=${pr.roll.toFixed(1).padStart(6)} rotor=${ac.rotor.rpm.toFixed(0).padStart(3)} agl=${ac.agl.toFixed(1)}`,
      )
    }
    if (ac.crash) {
      r.crash = `${ac.crash.title}: ${ac.crash.detail}`
      r.crashT = r.t
      break
    }
  }
  return r
}

/** Coloca el aparato con la góndola rozando el agua, parado o con velocidad. */
function placeOver(ac: Autogyro, clearance: number, speed: number, vy: number, rotorRpm: number, engine: boolean): void {
  ac.placeInAir(0, 0, 0, 90, speed)
  const minY = Math.min(...ac.hydro.elements.map((e) => e.p.y - e.r))
  ac.pos.y = clearance - (minY - ac.cg.y)
  ac.vel.y = vy
  ac.rotor.rpm = rotorRpm
  ac.engineOn = engine
  if (!engine) {
    ac.engineRpm = 0
    ac.enginePower = 0
  }
}

interface Case {
  name: string
  go: () => string[]
}

const fails: string[] = []
const cases: Case[] = [
  {
    name: 'amerizaje casi parado, motor parado: flota y se hunde',
    go: () => {
      const ac = new Autogyro(AIRFRAMES[afArg as keyof typeof AIRFRAMES] ?? GENERIC)
      ac.setLoad(false)
      placeOver(ac, 0.3, 0.5, -1.5, 0, false)
      const r = run(ac, envFor(), 120, (_t, c) => {
        c.rotorBrake = true
      })
      if (verbose) console.log(r.log.join('\n'))
      const e: string[] = []
      if (!/hundido|sank/.test(r.crash)) e.push(`esperaba que se hundiera; acaba: ${r.crash || 'sin accidente'} (cgDepth máx ${r.maxDepth.toFixed(2)})`)
      else if (r.crashT < 8) e.push(`se hunde demasiado pronto: ${r.crashT.toFixed(1)} s`)
      else if (r.crashT > 100) e.push(`tarda demasiado en hundirse: ${r.crashT.toFixed(1)} s`)
      return [`${r.crash ? `${r.crash.split(':')[0]} a los ${r.crashT.toFixed(1)} s` : 'sin accidente'}`, ...e]
    },
  },
  {
    name: 'amerizaje casi parado con el motor en marcha: la hélice toca el agua',
    go: () => {
      const ac = new Autogyro(AIRFRAMES[afArg as keyof typeof AIRFRAMES] ?? GENERIC)
      ac.setLoad(false)
      placeOver(ac, 0.3, 1, -1.5, 0, true)
      const r = run(ac, envFor(), 60, (_t, c) => {
        c.throttle = 0
        c.rotorBrake = true
      })
      if (verbose) console.log(r.log.join('\n'))
      const e: string[] = []
      if (!r.crash) e.push('no pasa nada en un minuto')
      return [`${r.crash ? `${r.crash.split(':')[0]} a los ${r.crashT.toFixed(1)} s` : 'sin accidente'}`, ...e]
    },
  },
  {
    name: 'rasante a 80 km/h con las ruedas en el agua: accidente enseguida',
    go: () => {
      const ac = new Autogyro(AIRFRAMES[afArg as keyof typeof AIRFRAMES] ?? GENERIC)
      ac.setLoad(false)
      placeOver(ac, 0.05, 80 / 3.6, -0.5, 340, true)
      const r = run(ac, envFor(), 10, (_t, c) => {
        c.throttle = 0.5
      })
      if (verbose) console.log(r.log.join('\n'))
      const e: string[] = []
      if (!r.crash) e.push('no se estrella')
      else if (r.crashT > 3) e.push(`tarda ${r.crashT.toFixed(1)} s en estrellarse`)
      return [`${r.crash ? `${r.crash.split(':')[0]} a los ${r.crashT.toFixed(2)} s` : 'sin accidente'}`, ...e]
    },
  },
  {
    name: 'caída vertical a 9 m/s: rompe al entrar',
    go: () => {
      const ac = new Autogyro(AIRFRAMES[afArg as keyof typeof AIRFRAMES] ?? GENERIC)
      ac.setLoad(false)
      placeOver(ac, 0.3, 0, -9, 0, false)
      const r = run(ac, envFor(), 4, () => {})
      if (verbose) console.log(r.log.join('\n'))
      const e: string[] = []
      if (!r.crash) e.push('no pasa nada')
      return [`${r.crash ? `${r.crash.split(':')[0]} a los ${r.crashT.toFixed(2)} s` : 'sin accidente'}`, ...e]
    },
  },
  {
    name: 'flotadores: en reposo flota nivelado',
    go: () => {
      const ac = new Autogyro(FLOATS)
      ac.setLoad(false)
      ac.placeOnGround(0, 0, 0, 90)
      ac.engineOn = false
      ac.engineRpm = 0
      const r = run(ac, envFor(), 40, (_t, c) => {
        c.rotorBrake = true
      })
      if (verbose) console.log(r.log.join('\n'))
      const e: string[] = []
      const pr = pitchRoll(ac.quat)
      // calado: la quilla (punto más bajo de los flotadores) bajo la superficie
      const keel = Math.min(...ac.hydro.elements.filter((x) => x.kind === 'float').map((x) => new Vector3(x.p.x, x.p.y - x.r, x.p.z).sub(ac.cg).applyQuaternion(ac.quat).add(ac.pos).y))
      const vol = ac.hydro.elements.filter((x) => x.kind === 'float').reduce((s, x) => s + elementVolume(x), 0)
      if (r.crash) e.push(`accidente: ${r.crash}`)
      if (-keel < 0.05 || -keel > 0.4) e.push(`calado raro: ${(-keel).toFixed(2)} m`)
      if (Math.abs(pr.pitch) > 6 || Math.abs(pr.roll) > 3) e.push(`no queda nivelado: cabeceo ${pr.pitch.toFixed(1)}°, alabeo ${pr.roll.toFixed(1)}°`)
      if (ac.vel.length() > 0.05) e.push(`no se para: ${ac.vel.length().toFixed(2)} m/s`)
      return [`calado ${(-keel).toFixed(2)} m · cabeceo ${pr.pitch.toFixed(1)}° · alabeo ${pr.roll.toFixed(1)}° · flotadores ${vol.toFixed(2)} m³ (${((vol * 1000) / ac.mass).toFixed(1)} veces el peso)`, ...e]
    },
  },
  {
    name: 'flotadores: navega con los pedales y despega',
    go: () => {
      const ac = new Autogyro(FLOATS)
      ac.setLoad(false)
      ac.placeOnGround(0, 0, 0, 90)
      let lift = -1
      let maxKmh = 0
      let turned = 0
      let hdg: Vector3 | null = null
      const h0 = new Vector3(1, 0, 0).applyQuaternion(ac.quat)
      const r = run(ac, envFor(), 90, (t, c, a) => {
        // 0-20 s: navega despacio y prerrota; 8-14 s: pedal a la derecha (vira)
        if (t < 20) {
          c.throttle = 0.42
          c.prerotator = true
          c.rotorBrake = false
          c.yaw = t > 8 && t < 14 ? 1 : 0
          c.pitch = 0.3
          if (t > 14 && t < 14.1) turned = Math.acos(Math.max(-1, Math.min(1, new Vector3(1, 0, 0).applyQuaternion(a.quat).dot(h0)))) / DEG
        } else {
          // mantiene el rumbo con los pedales (en el agua no hay rueda de morro que lo sujete)
          if (hdg === null) hdg = new Vector3(1, 0, 0).applyQuaternion(a.quat).setY(0).normalize()
          const f = new Vector3(1, 0, 0).applyQuaternion(a.quat).setY(0).normalize()
          const err = Math.atan2(f.x * hdg.z - f.z * hdg.x, f.dot(hdg))
          c.yaw = Math.max(-1, Math.min(1, -err * 4 + a.omega.y * 1.5))
          c.prerotator = false
          c.throttle = 1
          // palanca atrás para levantar el morro y que el rotor se cargue; luego cede
          c.pitch = a.agl > 3 ? 0.1 : 0.75
          c.roll = Math.max(-1, Math.min(1, -pitchRoll(a.quat).roll * 0.08))
        }
        maxKmh = Math.max(maxKmh, (a.ias * 3.6))
        if (lift < 0 && a.agl > 5 && !a.onWater) lift = t
      })
      if (verbose) console.log(r.log.join('\n'))
      const e: string[] = []
      if (r.crash) e.push(`accidente a los ${r.crashT.toFixed(1)} s: ${r.crash}`)
      if (turned < 20) e.push(`con el pedal apenas vira: ${turned.toFixed(0)}°`)
      if (lift < 0) e.push(`no despega en 70 s (máx ${maxKmh.toFixed(0)} km/h)`)
      return [`viraje con pedal ${turned.toFixed(0)}° en 6 s · despega ${lift > 0 ? `a los ${(lift - 20).toFixed(1)} s de dar gas` : 'no'} · máx ${maxKmh.toFixed(0)} km/h`, ...e]
    },
  },
]

// ---------------------------------------------------------------------------
// Aparatos de verdad con flotadores: el Wilford XOZ-1 (de serie) y los juegos de floatKit.ts
// ---------------------------------------------------------------------------
const REAL: { id: string; af: () => Airframe | null; maxTakeoff: number }[] = [
  { id: 'wilford', af: () => AIRFRAMES.wilford ?? null, maxTakeoff: 60 },
  ...Object.keys(FLOAT_KITS).map((id) => ({ id: `${id}+flotadores`, af: () => airframeById(id, true), maxTakeoff: 60 })),
]

/** Calado: la quilla (punto más bajo de los flotadores) bajo la superficie (m). */
function draft(ac: Autogyro): number {
  return -Math.min(...ac.hydro.elements.filter((x) => x.kind === 'float').map((x) => new Vector3(x.p.x, x.p.y - x.r, x.p.z).sub(ac.cg).applyQuaternion(ac.quat).add(ac.pos).y))
}

/** Rumbo (rad) en el plano horizontal. */
const yawOf = (q: Quaternion) => {
  const f = new Vector3(1, 0, 0).applyQuaternion(q)
  return Math.atan2(-f.z, f.x)
}

/**
 * Despegue del agua (manual del MTOsport con flotadores y banco de escenarios del Wilford): prerrota a la
 * deriva, corre sobre el redán con la palanca a medias, tira al llegar a ~80 km/h y, en el aire, sube a
 * ~85 km/h sujetando el rumbo con los pedales.
 */
function waterTakeoff(ac: Autogyro, seconds: number) {
  let lift = -1
  let maxKmh = 0
  let hdg: Vector3 | null = null
  let pulled = false
  const r = run(ac, envFor(), seconds, (t, c, a) => {
    if (t < 20) {
      // prerrota con el motor a medio gas, a la deriva
      c.throttle = 0.42
      c.prerotator = true
      c.rotorBrake = false
      c.pitch = 0.3
      return
    }
    if (hdg === null) hdg = new Vector3(1, 0, 0).applyQuaternion(a.quat).setY(0).normalize()
    const f = new Vector3(1, 0, 0).applyQuaternion(a.quat).setY(0).normalize()
    const err = Math.atan2(f.x * hdg.z - f.z * hdg.x, f.dot(hdg))
    c.yaw = Math.max(-1, Math.min(1, -err * 4 + a.omega.y * 1.5))
    c.prerotator = false
    c.throttle = 1
    const kmh = a.ias * 3.6
    if (kmh > 78) pulled = true
    // en el aire: velocidad de subida (~85 km/h) con la palanca (lento → adelante), amortiguando el cabeceo
    const pr = pitchRoll(a.quat)
    c.pitch = a.agl > 1.5 && !a.onWater ? Math.max(-0.5, Math.min(0.8, 0.3 - (85 - kmh) * 0.02 - (pr.pitch - 5) * 0.03 - a.omega.z * 0.5)) : pulled ? 0.6 : 0.4
    c.roll = Math.max(-1, Math.min(1, -pitchRoll(a.quat).roll * 0.2 - a.omega.x * 1.0))
    maxKmh = Math.max(maxKmh, kmh)
    if (lift < 0 && a.agl > 5 && !a.onWater) lift = t - 20
    // arriba y subiendo: ya está
    return a.agl > 30
  })
  return { r, lift, maxKmh }
}

for (const real of REAL) {
  const make = () => {
    const af = real.af()
    if (!af) return null
    const ac = new Autogyro(af)
    ac.setLoad(false)
    // en el agua, el tren anfibio arriba
    ac.setGear(false, true)
    return ac
  }
  cases.push(
    {
      name: `${real.id}: en reposo flota nivelado`,
      go: () => {
        const ac = make()
        if (!ac) return ['(sin ficha todavía)', 'falta la ficha']
        ac.placeOnGround(0, 0, 0, 90)
        ac.setGear(false, true)
        ac.engineOn = false
        ac.engineRpm = 0
        const r = run(ac, envFor(), 40, (_t, c) => {
          c.rotorBrake = true
        })
        if (verbose) console.log(r.log.join('\n'))
        const e: string[] = []
        const pr = pitchRoll(ac.quat)
        const d = draft(ac)
        const vol = ac.hydro.elements.filter((x) => x.kind === 'float').reduce((s, x) => s + elementVolume(x), 0)
        const reserve = (vol * 1000) / ac.mass
        if (r.crash) e.push(`accidente: ${r.crash}`)
        if (d < 0.08 || d > 0.4) e.push(`calado raro: ${d.toFixed(2)} m`)
        if (Math.abs(pr.pitch) > 5 || Math.abs(pr.roll) > 2) e.push(`no queda nivelado: cabeceo ${pr.pitch.toFixed(1)}°, alabeo ${pr.roll.toFixed(1)}°`)
        // (las normas de aviones piden 1,8 veces el peso; los juegos de ultraligero se quedan en ~1,4-1,6)
        if (reserve < 1.4) e.push(`flotadores escasos: ${reserve.toFixed(1)} veces el peso`)
        if (ac.vel.length() > 0.05) e.push(`no se para: ${ac.vel.length().toFixed(2)} m/s`)
        return [`calado ${d.toFixed(2)} m · cabeceo ${pr.pitch.toFixed(1)}° · alabeo ${pr.roll.toFixed(1)}° · ${ac.mass.toFixed(0)} kg · flotadores ${vol.toFixed(2)} m³ (${reserve.toFixed(1)} veces el peso)`, ...e]
      },
    },
    {
      name: `${real.id}: con los pedales vira en el agua`,
      go: () => {
        const ac = make()
        if (!ac) return ['(sin ficha todavía)', 'falta la ficha']
        ac.placeOnGround(0, 0, 0, 90)
        ac.setGear(false, true)
        // giro acumulado (+ a la derecha: el rumbo de yawOf crece hacia la izquierda)
        let prev = yawOf(ac.quat)
        let turned = 0
        const r = run(ac, envFor(), 20, (t, c, a) => {
          // rodando despacio a un tercio de gas, pedal a fondo a la derecha desde los 4 s
          c.throttle = 0.35
          c.rotorBrake = false
          c.pitch = 0.3
          c.yaw = t > 4 ? 1 : 0
          const y = yawOf(a.quat)
          turned -= ((y - prev + 3 * Math.PI) % (2 * Math.PI) - Math.PI) / DEG
          prev = y
        })
        if (verbose) console.log(r.log.join('\n'))
        const e: string[] = []
        if (r.crash) e.push(`accidente: ${r.crash}`)
        if (turned < 0) e.push(`con el pedal derecho gira a la izquierda: ${(-turned).toFixed(0)}°`)
        else if (turned < 60) e.push(`apenas vira: ${turned.toFixed(0)}° en 16 s`)
        return [`gira ${turned.toFixed(0)}° a la derecha en 16 s con el pedal derecho a fondo · ${(ac.groundSpeed * 3.6).toFixed(0)} km/h`, ...e]
      },
    },
    {
      name: `${real.id}: despega del agua`,
      go: () => {
        const ac = make()
        if (!ac) return ['(sin ficha todavía)', 'falta la ficha']
        ac.placeOnGround(0, 0, 0, 90)
        ac.setGear(false, true)
        const x0 = ac.pos.clone()
        const { r, lift, maxKmh } = waterTakeoff(ac, 20 + real.maxTakeoff + 10)
        if (verbose) console.log(r.log.join('\n'))
        const e: string[] = []
        if (r.crash) e.push(`accidente a los ${r.crashT.toFixed(1)} s: ${r.crash}`)
        if (lift < 0) e.push(`no despega en ${real.maxTakeoff} s (máx ${maxKmh.toFixed(0)} km/h)`)
        const run_m = ac.pos.clone().sub(x0).setY(0).length()
        return [`despega ${lift > 0 ? `a los ${lift.toFixed(1)} s de dar gas` : 'no'} · máx ${maxKmh.toFixed(0)} km/h · ${run_m.toFixed(0)} m recorridos al final`, ...e]
      },
    },
    {
      name: `${real.id}: tocar el agua a 2,5 m/s aguanta; a 5,5 m/s rompe los flotadores`,
      go: () => {
        const out: string[] = []
        const e: string[] = []
        for (const vy of [-2.5, -5.5]) {
          const ac = make()
          if (!ac) return ['(sin ficha todavía)', 'falta la ficha']
          placeOver(ac, 0.15, 60 / 3.6, vy, 330 * (ac.af.rpmScale ?? 1), true)
          // el cabeceo de un amaraje: morro algo arriba
          ac.quat.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 4 * DEG))
          const r = run(ac, envFor(), 4, (_t, c) => {
            c.throttle = 0.15
            c.pitch = 0.3
          })
          const broke = /flotador/.test(r.crash)
          out.push(`${(-vy).toFixed(1)} m/s → ${r.crash ? r.crash.split(':')[0] : 'sin daños'}`)
          if (vy > -3 && r.crash) e.push(`a ${-vy} m/s no debería pasar nada: ${r.crash}`)
          if (vy < -5 && !broke) e.push(`a ${-vy} m/s debería romper los flotadores: ${r.crash || 'sin daños'}`)
        }
        return [out.join(' · '), ...e]
      },
    },
  )
}

// tren anfibio: amarizar con las ruedas fuera vuelca de morro; en tierra rueda con ellas
for (const id of Object.keys(FLOAT_KITS).filter((k) => FLOAT_KITS[k].amphib)) {
  cases.push(
    {
      name: `${id}+flotadores: amarizar con el tren abajo vuelca`,
      go: () => {
        const ac = new Autogyro(airframeById(id, true))
        ac.setLoad(false)
        ac.setGear(true, true)
        placeOver(ac, 0.1, 55 / 3.6, -1.5, 300, true)
        const r = run(ac, envFor(), 8, (_t, c) => {
          c.throttle = 0.15
          c.pitch = 0.5
        })
        const e = r.crash ? [] : ['no pasa nada con las ruedas en el agua']
        return [`${r.crash ? `${r.crash.split(':')[0]} a los ${r.crashT.toFixed(2)} s` : 'sin accidente'}`, ...e]
      },
    },
    {
      name: `${id}+flotadores: en tierra con el tren abajo rueda; con el tren arriba se apoya en las quillas`,
      go: () => {
        const flat = { heightAt: (_x: number, _z: number, n: Vector3) => (n.set(0, 1, 0), 0) }
        const env: Environment = { rho: isaDensity(300), wind: new Vector3(), ground: flat }
        const e: string[] = []
        const out: string[] = []
        for (const down of [true, false]) {
          const ac = new Autogyro(airframeById(id, true))
          ac.setLoad(false)
          ac.placeOnGround(0, 0, 0, 90)
          ac.setGear(down, true)
          const x0 = ac.pos.clone()
          const r = run(ac, env, 15, (_t, c) => {
            c.throttle = 0.45
            c.rotorBrake = false
            c.wheelBrake = 0
          })
          const moved = ac.pos.clone().sub(x0).setY(0).length()
          out.push(`${down ? 'abajo' : 'arriba'}: ${moved.toFixed(0)} m en 15 s${r.crash ? ` (${r.crash.split(':')[0]})` : ''}`)
          if (r.crash) e.push(`accidente con el tren ${down ? 'abajo' : 'arriba'}: ${r.crash}`)
          if (down && moved < 20) e.push(`con el tren abajo apenas rueda: ${moved.toFixed(1)} m`)
          if (!down && moved > 5) e.push(`sobre las quillas se desliza demasiado: ${moved.toFixed(1)} m`)
        }
        return [out.join(' · '), ...e]
      },
    },
  )
}

// ---------------------------------------------------------------------------
// Restos (Rapier) en el agua: lago con la superficie a 0 y el fondo a 8 m
// ---------------------------------------------------------------------------
function wreckIn(vel: Vector3, rotorRpm: number, pitch = 0): Wreck {
  const quat = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), pitch * DEG)
  const shapes = fallbackShapes(new Vector3(0, 1, 0).applyAxisAngle(new Vector3(0, 0, 1), 8 * DEG), new Vector3(1, 0, 0.4).normalize(), 0.3, 0)
  const w = new Wreck({
    pos: new Vector3(0, 1.05 + CG.y + 0.05, 0),
    quat,
    vel,
    omegaBody: new Vector3(),
    rotorOmega: (rotorRpm * 2 * Math.PI) / 60,
    propOmega: 0,
    propTorque: 0,
    mass: 395,
    rho: 1.15,
    wind: new Vector3(),
    shapes,
    preBreak: [],
    seed: 777,
    heightAt: () => -8,
  })
  w.setGround(() => -8, 0, 0)
  w.setWater(() => 0, 0, 0)
  return w
}
const podY = (w: Wreck) => {
  const p = new Vector3()
  const q = new Quaternion()
  w.partPose('pod', p, q)
  return p.add(CG.clone().applyQuaternion(q)).y
}
cases.push(
  {
    name: 'restos: caen al agua parados, flotan y se hunden',
    go: () => {
      const w = wreckIn(new Vector3(0, -1, 0), 0)
      const ys: number[] = []
      for (let i = 0; i < 60 / WRECK_DT; i++) {
        w.step()
        w.impacts.length = 0
        if (i % Math.round(1 / WRECK_DT) === 0) ys.push(podY(w))
      }
      if (verbose) console.log(ys.map((y, i) => `${i}s ${y.toFixed(2)}`).join(' · '))
      const e: string[] = []
      if (ys[4] < -1) e.push(`a los 4 s ya está hundida (${ys[4].toFixed(2)} m)`)
      if (ys[59] > -6) e.push(`al minuto no se ha ido al fondo (${ys[59].toFixed(2)} m)`)
      const sink = ys.findIndex((y) => y < -1.5)
      const floaters = w.wetParts().filter((p) => p.point.y > -0.5).map((p) => p.id)
      return [`góndola a 4 s: ${ys[4].toFixed(2)} m · bajo el agua a los ${sink} s · al minuto ${ys[59].toFixed(2)} m · flotan: ${floaters.join(', ') || 'nada'}`, ...e]
    },
  },
  {
    name: 'restos: entran a 90 km/h rasantes y el agua los frena',
    go: () => {
      const w = wreckIn(new Vector3(25, -2, 0), 330, -4)
      const v = new Vector3()
      let v1 = 0
      let splashes = 0
      for (let i = 0; i < 6 / WRECK_DT; i++) {
        w.step()
        splashes += w.impacts.filter((m) => m.surface === 'water').length
        w.impacts.length = 0
        if (i === Math.round(1.5 / WRECK_DT)) {
          w.partVelocity('pod', v)
          v1 = v.length()
        }
      }
      const br = w.brokenSummary()
      const e: string[] = []
      if (v1 > 8) e.push(`a 1,5 s aún va a ${(v1 * 3.6).toFixed(0)} km/h`)
      if (!br.length) e.push('no se rompe nada')
      if (splashes < 5) e.push(`apenas salpica (${splashes})`)
      return [`a 1,5 s: ${(v1 * 3.6).toFixed(0)} km/h · asiento ${w.peakSeatG.toFixed(0)} g · roturas: ${br.join(', ') || 'ninguna'} · chapoteos ${splashes}`, ...e]
    },
  },
)

await loadRapier()
for (const c of cases) {
  if (filter && !c.name.includes(filter)) continue
  const out = c.go()
  const ok = out.length === 1
  console.log(`${ok ? 'OK ' : 'MAL'} ${c.name}\n    ${out.join('\n    ')}`)
  if (!ok) fails.push(c.name)
}
console.log(fails.length ? `\n${fails.length} casos MAL` : '\nTodo bien')
process.exit(fails.length ? 1 : 0)
