// Combustible y fallos del motor (src/sim/powerplant.ts y fuel.ts), con el propio modelo de vuelo:
//   node --experimental-strip-types tools/fdm-failures.ts [af=<id>] [-v]
//  · planeo con el simulacro (motor al ralentí) frente a motor parado: el de ralentí planea algo mejor;
//  · la tabla de planeo de la guía (src/sim/glideData.ts) sigue valiendo para la ficha actual;
//  · simulacro: el gas no responde, el motor sigue en marcha, «motor y al aire» y fin al tomar tierra;
//  · agotamiento del combustible: tirones, parada y no vuelve a arrancar; la masa baja lo quemado;
//  · consumo de una hora de crucero al 75 % de la potencia continua frente al dato publicado (una hora
//    entera con el primer aparato de cada motor; con los demás, 10 min);
//  · fallos reales: parada, pérdida parcial, presión de aceite (gripa antes con potencia que al
//    ralentí) y hielo en el carburador (solo con carburador; más con gas reducido).
import { Vector3 } from 'three'
import { Autogyro, defaultControls, type Controls, type Environment } from '../src/sim/autogyro.ts'
import { PilotAssist } from '../src/sim/assist.ts'
import { AIRFRAMES } from '../src/sim/airframes.ts'
import { engineFuel, fuelSpec, sfcAt } from '../src/sim/fuel.ts'
import { GLIDE, glideKey } from '../src/sim/glideData.ts'
import { DT, glideAt, landing, testEnv } from './glide-lib.ts'
import { pickAirframe } from './af-override.ts'

const afId = process.argv.slice(2).find((a) => a.startsWith('af='))?.slice(3) ?? 'generic'
const verbose = process.argv.includes('-v')
const af = pickAirframe(afId)
console.log(`Aparato: ${afId}`)
const fs = fuelSpec(af)
const ef = engineFuel(af.engine)

let fails = 0
function report(name: string, ok: boolean, text: string): void {
  if (!ok) fails++
  console.log(`${ok ? ' OK  ' : 'FALLA'} ${name}: ${text}`)
}

/** Azar con semilla (mulberry32): las pruebas dan siempre lo mismo. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Flight {
  ac: Autogyro
  ctl: Controls
  env: Environment
  t: number
}

/** Aparato en crucero (106 km/h, 62 % de gas) con la planta encendida y azar con semilla. */
function cruise(alt = 600, env?: Environment): Flight {
  const ac = new Autogyro(af)
  ac.setLoad(false)
  ac.placeInAir(0, alt, 0, 90, 106 / 3.6)
  ac.pp.rng = seeded(7)
  ac.pp.reset()
  ac.pp.enabled = true
  const ctl = defaultControls()
  ctl.throttle = 0.62
  assist.reset()
  return { ac, ctl, env: env ?? testEnv(af), t: 0 }
}

const assist = new PilotAssist()
/**
 * Vuela `secs` segundos. `each` puede tocar los mandos (devuelve true para parar). Palanca fija en
 * `f.ctl.pitch` con la ayuda al pilotaje, como el teclado sin tocar nada.
 */
function fly(f: Flight, secs: number, each?: (f: Flight) => boolean | void): void {
  const end = f.t + secs
  const stick = { v: f.ctl.pitch }
  while (f.t < end && !f.ac.crash) {
    if (each?.(f) === true) break
    stick.v = f.ctl.pitch
    assist.apply(DT, f.ac, f.ctl, { pitchActive: false, rollActive: false, yawActive: false, analog: false })
    f.ac.step(DT, f.ctl, f.env)
    f.ctl.pitch = stick.v
    f.ctl.roll = 0
    f.ctl.yaw = 0
    f.t += DT
  }
}

// ---------------------------------------------------------------------------
// 1. Planeo: simulacro (ralentí) frente a motor parado, y la tabla de la guía
// ---------------------------------------------------------------------------
const g = GLIDE[glideKey(af)]
if (!g) report('Tabla de planeo', false, `falta ${glideKey(af)} en src/sim/glideData.ts: node --experimental-strip-types tools/fdm-glide.ts --write`)
else {
  const idle = glideAt(af, g.stickOff, 'idle')
  const off = glideAt(af, g.stickOff, 'off')
  if (!idle || !off) report('Planeo con simulacro frente a motor parado', false, 'accidente en el planeo')
  else {
    report(
      'Planeo con simulacro (motor al ralentí) frente a motor parado',
      idle.ratio > off.ratio && idle.vs > off.vs,
      `ralentí: ${idle.ias.toFixed(0)} km/h, ${idle.vs.toFixed(1)} m/s, fineza ${idle.ratio.toFixed(2)} | parado: ${off.ias.toFixed(0)} km/h, ${off.vs.toFixed(1)} m/s, fineza ${off.ratio.toFixed(2)}`,
    )
    // la tabla de la guía sigue valiendo con la ficha de hoy
    const fresh = Math.abs(off.ias - g.bestOff) < 6 && Math.abs(off.vs - g.sinkOff) < 0.4
    report(
      'Tabla de planeo de la guía al día',
      fresh,
      fresh
        ? `mejor planeo ${g.bestOff} km/h (medido ${off.ias.toFixed(0)}), ${g.sinkOff} m/s (medido ${off.vs.toFixed(1)}); recogida a ${g.flare} m`
        : `la ficha ha cambiado: tabla ${g.bestOff} km/h / ${g.sinkOff} m/s, medido ${off.ias.toFixed(0)} km/h / ${off.vs.toFixed(1)} m/s → node --experimental-strip-types tools/fdm-glide.ts --write`,
    )
  }
}

// ---------------------------------------------------------------------------
// 2. Simulacro «como en la escuela»
// ---------------------------------------------------------------------------
{
  const f = cruise(500)
  fly(f, 8)
  const rpm0 = f.ac.engineRpm
  f.ac.pp.mode = 'drill'
  f.ac.pp.request(f.ac)
  let minRpm = 1e9
  let maxRpm = 0
  let maxP = 0
  let sink = 0
  let alwaysOn = true
  fly(f, 30, (x) => {
    // el alumno mete gas y no responde
    x.ctl.throttle = 1
    if (x.t > 20) {
      minRpm = Math.min(minRpm, x.ac.engineRpm)
      maxRpm = Math.max(maxRpm, x.ac.engineRpm)
      maxP = Math.max(maxP, x.ac.enginePower)
      sink = Math.min(sink, x.ac.vs)
    }
    if (!x.ac.engineOn) alwaysOn = false
  })
  // (al ralentí y planeando, la hélice gira arrastrada por el aire: las vueltas no bajan al ralentí de
  // tierra, pero el motor no da potencia)
  const drillOk = f.ac.pp.drill && alwaysOn && maxP < 0.12 * af.engine.maxPower && minRpm > 0.6 * af.engine.idleRpm && sink < -2
  // motor y al aire: F2 y gas a fondo
  f.ac.pp.request(f.ac)
  let climb = -99
  fly(f, 25, (x) => {
    x.ctl.throttle = 1
    if (x.t > 50) climb = Math.max(climb, x.ac.vs)
  })
  report(
    'Simulacro: el gas no responde y el motor sigue en marcha; F2 y motor y al aire',
    drillOk && !f.ac.pp.drill && climb > 0.5 && !f.ac.crash,
    `crucero a ${rpm0.toFixed(0)} rpm → con gas a fondo pedido, ${minRpm.toFixed(0)}-${maxRpm.toFixed(0)} rpm y ${(maxP / 1000).toFixed(1)} kW como mucho (ralentí ${af.engine.idleRpm} rpm), baja ${sink.toFixed(1)} m/s; tras F2 sube ${climb.toFixed(1)} m/s`,
  )
  // y termina solo al tomar tierra (planeo al ralentí y recogida con el teclado, como el jugador; lo
  // que se mira es que el simulacro acabe, así que si la recogida de la tabla, hecha con el motor
  // parado, no sale bien al ralentí, se prueba a otras alturas)
  let l = null as ReturnType<typeof landing> | null
  let flareUsed = 0
  for (const h of [g?.flare ?? 6, 8, 10, 7, 6, 9, 12]) {
    flareUsed = h
    l = landing(af, g?.stickOff ?? 0.2, h, 'idle', {
      // (rodando y frenando unos segundos: algún aparato rebota al tocar)
      after: 6,
      setup: (ac) => {
        ac.pp.enabled = true
        ac.pp.mode = 'drill'
        ac.pp.startDrill()
      },
    })
    // (una toma que rebota y vuelve al aire tampoco vale: se prueba otra altura)
    if (!l.crash && !l.ac.pp.drill) break
  }
  if (!l) throw new Error('sin toma')
  report(
    'Simulacro: termina al tomar tierra',
    !l.crash && !l.ac.pp.drill,
    l.crash ? `ACCIDENTE: ${l.crash} (${l.impact.toFixed(1)} m/s)` : `recogida a ${flareUsed} m: toma a ${l.ias.toFixed(0)} km/h y ${l.impact.toFixed(1)} m/s; simulacro ${l.ac.pp.drill ? 'SIGUE' : 'terminado'}`,
  )
}

// ---------------------------------------------------------------------------
// 3. Agotamiento del combustible
// ---------------------------------------------------------------------------
if (fs.none) console.log(' --   Sin combustible: motor de ficción, no gasta')
else {
  const f = cruise(800)
  const startL = fs.unusable + 0.8
  f.ac.pp.setLitres(startL)
  f.ac.setFuel(f.ac.pp.fuelKg)
  const m0 = f.ac.mass
  let firstCut = -1
  let stopT = -1
  let cuts = 0
  let wasCut = false
  fly(f, 900, (x) => {
    const cut = x.ac.engineOn && x.ac.pp.power === 0
    if (cut && !wasCut) {
      cuts++
      if (firstCut < 0) firstCut = x.t
    }
    wasCut = cut
    if (!x.ac.engineOn && stopT < 0) stopT = x.t
    if (stopT > 0 && x.t > stopT + 2) return true
  })
  const burnt = m0 - f.ac.mass
  const block = f.ac.pp.startBlock()
  const lph = (0.8 / Math.max(1, stopT)) * 3600
  report(
    'Agotamiento del combustible: tirones, parada y no arranca',
    firstCut > 0 && firstCut < stopT && cuts >= 3 && stopT > 0 && f.ac.pp.dead === 'fuel' && block === 'fuel' && Math.abs(burnt - 0.8 * fs.density) < 0.05,
    `con 0,8 l utilizables a crucero (${lph.toFixed(1)} l/h): primer tirón a los ${firstCut.toFixed(0)} s, ${cuts} cortes, se para a los ${stopT.toFixed(0)} s; la masa baja ${burnt.toFixed(2)} kg; la llave: ${block ?? 'arranca'}`,
  )
}

// ---------------------------------------------------------------------------
// 4. Consumo de una hora de crucero al 75 % frente al dato publicado
// ---------------------------------------------------------------------------
/** 75 % de la potencia continua (fracción de la máxima) y caudal de referencia (l/h). */
const REF: Record<string, { frac: number; lph: number; pub: boolean; src: string }> = {
  '912uls': { frac: 0.703, lph: 18.5, pub: true, src: 'Rotax, manual 912' },
  '914ul': { frac: 0.652, lph: 20, pub: false, src: 'estimado (Rotax no lo publica)' },
  '915is': { frac: 0.73, lph: 26, pub: false, src: 'estimado (280-310 g/kWh)' },
  '503ul': { frac: 0.75, lph: 15.3, pub: false, src: '~15 l/h según Wikipedia, que cita a Rotax' },
  'mcculloch-4318a': { frac: 0.75, lph: 26.6, pub: false, src: 'estimado' },
  'genet-major-ia': { frac: 0.6, lph: 25, pub: false, src: 'NACA: ~6 gal imp./h en crucero el C.19, con el mismo motor' },
  'kinner-r5': { frac: 0.75, lph: 36.5, pub: false, src: 'estimado' },
  'io-540': { frac: 0.75, lph: 62.5, pub: true, src: 'Lycoming: 16,5 gal/h al 75 %' },
}
const ref = REF[af.engine.id]
if (!ref || fs.none) console.log(` --   Consumo de crucero: sin referencia para ${af.engine.name}`)
else {
  const first = Object.values(AIRFRAMES).find((a) => a.engine.id === af.engine.id)?.id === af.id
  const secs = first ? 3600 : 600
  const f = cruise(800)
  f.ac.pp.setLitres(fs.capacity)
  f.ac.setFuel(f.ac.pp.fuelKg)
  f.ctl.throttle = 0.7
  const target = ref.frac * af.engine.maxPower
  const m0 = f.ac.mass
  const l0 = f.ac.pp.litres
  let thI = 0.7
  let stI = 0
  let n = 0
  let kmh = 0
  let alt0 = 0
  fly(f, secs, (x) => {
    // gas para la potencia; palanca para mantener la altura (en un autogiro, la velocidad)
    const e = (target - x.ac.enginePower) / af.engine.maxPower
    thI = Math.max(0, Math.min(1, thI + 0.4 * e * DT))
    x.ctl.throttle = Math.max(0, Math.min(1, thI + 0.5 * e))
    stI = Math.max(-1, Math.min(0.6, stI - 0.004 * x.ac.vs * DT))
    x.ctl.pitch = Math.max(-1, Math.min(1, stI - 0.03 * x.ac.vs))
    if (x.t > 60) {
      n++
      kmh += x.ac.ias * 3.6
    }
    if (Math.abs(x.t - 60) < DT) alt0 = x.ac.pos.y
  })
  const used = l0 - f.ac.pp.litres
  const lph = (used / f.t) * 3600
  const dm = m0 - f.ac.mass
  const okMass = Math.abs(dm - used * fs.density) < 0.05
  const ok = Math.abs(lph - ref.lph) / ref.lph < 0.1 && okMass && !f.ac.crash
  report(
    `Consumo de ${first ? 'una hora' : '10 min'} de crucero al 75 % (${af.engine.name})`,
    ok,
    `${used.toFixed(1)} l en ${(f.t / 60).toFixed(0)} min = ${lph.toFixed(1)} l/h a ${(kmh / Math.max(1, n)).toFixed(0)} km/h (altura ${alt0.toFixed(0)} → ${f.ac.pos.y.toFixed(0)} m); ${ref.pub ? 'publicado' : 'referencia'} ${ref.lph} l/h (${ref.src}); la masa baja ${dm.toFixed(1)} kg${okMass ? '' : ' (NO cuadra)'} · al despegue ${sfcAt(ef, 1).toFixed(3)} l/kWh = ${((af.engine.maxPower / 1000) * sfcAt(ef, 1)).toFixed(0)} l/h`,
  )
}

// ---------------------------------------------------------------------------
// 5. Fallos reales
// ---------------------------------------------------------------------------
{
  // parada total
  const f = cruise(800)
  f.ac.pp.mode = 'real'
  fly(f, 5)
  f.ac.pp.trigger(f.ac, 'stop')
  fly(f, 10)
  // (parado no quiere decir quieto: en vuelo la hélice puede seguir girando arrastrada por el aire,
  // sobre todo una de paso variable como la del Carter PAV)
  const stopOk = !f.ac.engineOn && f.ac.pp.startBlock() !== null && f.ac.enginePower === 0
  // pérdida parcial: a fondo da bastante menos que sano
  const a = cruise(800)
  a.ctl.throttle = 1
  fly(a, 15)
  const pFull = a.ac.enginePower
  a.ac.pp.mode = 'real'
  a.ac.pp.trigger(a.ac, 'partial')
  let pSum = 0
  let pn = 0
  fly(a, 20, (x) => {
    if (x.t > 25) {
      pSum += x.ac.enginePower
      pn++
    }
  })
  const pPart = pSum / Math.max(1, pn)
  report(
    'Fallo real: parada total y pérdida parcial de potencia',
    stopOk && pPart < 0.8 * pFull && pPart > 0.15 * pFull && a.ac.engineOn,
    `parada: motor ${f.ac.engineOn ? 'EN MARCHA' : 'parado'} a ${f.ac.engineRpm.toFixed(0)} rpm, la llave: ${f.ac.pp.startBlock() ?? 'ARRANCA'} | parcial: a fondo ${(pFull / 1000).toFixed(0)} → ${(pPart / 1000).toFixed(0)} kW`,
  )
  // presión de aceite: se gripa antes con potencia que al ralentí
  if (ef.oilPressure) {
    const seize = (thr: number) => {
      const o = cruise(3500)
      o.ac.pp.mode = 'real'
      o.ac.pp.trigger(o.ac, 'oil')
      o.ctl.throttle = thr
      let warn = -1
      let t = -1
      fly(o, 1800, (x) => {
        if (warn < 0 && x.ac.pp.oilLow) warn = x.t
        if (!x.ac.engineOn) {
          t = x.t
          return true
        }
      })
      return { warn, t, dead: o.ac.pp.dead }
    }
    const hi = seize(0.75)
    const lo = seize(0.05)
    report(
      'Fallo real: presión de aceite baja → aviso y gripaje',
      hi.warn > 0 && hi.warn < 60 && hi.t > 120 && hi.t < 900 && hi.dead === 'seized' && (lo.t < 0 || lo.t > hi.t * 1.8),
      `aviso a los ${hi.warn.toFixed(0)} s; con 75 % de gas se gripa a los ${(hi.t / 60).toFixed(1)} min, al ralentí ${lo.t < 0 ? 'aguanta los 30 min' : `a los ${(lo.t / 60).toFixed(1)} min`}`,
    )
  }
  // hielo en el carburador: aire húmedo (10 °C, rocío 9 °C) durante 5 min, en crucero y planeando al ralentí
  const ice = (thr: number) => {
    const env = { ...testEnv(af), oatC: 10, dewPointC: 9 }
    const o = cruise(3000, env)
    o.ac.pp.mode = 'real'
    o.ctl.throttle = thr
    fly(o, 300)
    return o.ac.pp.ice
  }
  const iceCruise = ice(0.62)
  const iceIdle = ice(0)
  const carb = ef.induction === 'carb'
  report(
    `Hielo en el carburador (${carb ? 'carburador' : ef.induction === 'injection' ? 'inyección' : 'sin carburador'})`,
    carb ? iceIdle > iceCruise && iceCruise > 0 : iceIdle === 0 && iceCruise === 0,
    `5 min con 10 °C y rocío a 9 °C: hielo ${(iceCruise * 100).toFixed(0)} % en crucero, ${(iceIdle * 100).toFixed(0)} % con gas reducido${carb ? ` (propensión ×${ef.iceRisk})` : ''}`,
  )
}

if (verbose) console.log(`(depósito: ${fs.capacity} l, ${fs.unusable} no utilizables, ${fs.source})`)
console.log(fails ? `\n${fails} comprobación(es) fallan.` : '\nTodo correcto.')
process.exit(fails ? 1 : 0)
