// Tráfico aéreo de los aeródromos (src/airtraffic) sin render: media hora de tráfico con el modelo
// de vuelo completo de cada aparato y su piloto simulado.
//
//   node --experimental-strip-types tools/air-traffic-test.ts [filtro] [-v] [seed=N] [min=30]
//
// Comprueba, en Casarrubios (LEMT, calles de rodaje de OpenStreetMap) y en un campo de hierba en
// cuesta con viento cruzado:
//  · que nadie se accidenta ni choca, y que nunca se pierde la separación mínima (en el aire, en
//    tierra y en la pista);
//  · que todo el que despega acaba aterrizando (o se va del aeródromo) y aparcando;
//  · que nadie se queda atascado (ni rodando, ni en el punto de espera, ni en el circuito);
//  · que con el aparato del jugador parado en la pista nadie entra en ella ni toma: esperan o frustran;
//  · que con el jugador en final nadie entra en pista, y que se apartan de un jugador que cruza el circuito.
import { Vector3 } from 'three'
import { AIRFRAMES } from '../src/sim/airframes.ts'
import { Airfield, lemtRaw, type RawAirfield } from '../src/airtraffic/airfield.ts'
import { AI_FLEET } from '../src/airtraffic/fleet.ts'
import { AirTrafficSim, type Density, type PlayerState, type SimHost } from '../src/airtraffic/sim.ts'

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(k + '='))?.slice(k.length + 1) ?? d
const verbose = process.argv.includes('-v')
const filter = process.argv.slice(2).find((a) => !a.startsWith('-') && !a.includes('='))
const MIN = Number(arg('min', '30'))
const SEED = Number(arg('seed', '1'))
const KT = 0.514444

// azar repetible (el viento racheado usa Math.random)
let seed = SEED
const rng = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 4294967296
}
Math.random = rng

const flatHost: SimHost = {
  ground: (_x, _z, out) => {
    out.y = 0
    out.normal.set(0, 1, 0)
    return true
  },
}
/** campo en cuesta (1,2 %) y ondulado (±0,5 m) */
const hillHost: SimHost = {
  ground: (x, z, out) => {
    out.y = 0.012 * x + 0.5 * Math.sin(x / 90) * Math.cos(z / 70)
    const dx = 0.012 + (0.5 / 90) * Math.cos(x / 90) * Math.cos(z / 70)
    const dz = (-0.5 / 70) * Math.sin(x / 90) * Math.sin(z / 70)
    out.normal.set(-dx, 1, -dz).normalize()
    return true
  },
}
/** campo de ultraligeros de hierba: 620 × 18 m, rumbo 010/190, sin calles ni plataforma en el mapa */
function grassRaw(): RawAirfield {
  const h = (10 * Math.PI) / 180
  return { name: 'Campo de hierba', a: { x: 0, z: 0 }, b: { x: Math.sin(h) * 620, z: -Math.cos(h) * 620 }, hw: 9, taxiways: [], aprons: [] }
}

interface Scenario {
  name: string
  raw: RawAirfield
  host: SimHost
  wind: { fromDeg: number; kt: number; turbulence: number }
  density: Density
  /** el jugador en cada instante (null: no está) */
  player?: (t: number, sim: AirTrafficSim) => PlayerState | null
  /** comprobaciones propias del escenario */
  check?: (r: Result) => string[]
  /** separación mínima exigida entre dos simulados en el aire (m); 150 si no se dice */
  minAir?: number
  minutes?: number
}

interface Result {
  sim: AirTrafficSim
  /** distancia mínima de un simulado al jugador (m) */
  minPlayer: number
  /** simulados que entraron en la pista o tocaron mientras el jugador la ocupaba */
  intruders: string[]
  landingsAfter: number
  goAroundsWhileBlocked: number
  enteredWithPlayerOnFinal: string[]
}

const results: { name: string; ok: boolean; text: string }[] = []
const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`
const num = (x: number) => (Number.isFinite(x) ? x.toFixed(0) : '—')

function run(sc: Scenario): void {
  if (filter && !sc.name.toLowerCase().includes(filter.toLowerCase())) return
  seed = SEED
  const field = new Airfield(sc.raw)
  const sim = new AirTrafficSim(field, sc.host, { density: sc.density, fleet: AI_FLEET.map((id) => AIRFRAMES[id]), rng })
  sim.wind = { fromDeg: sc.wind.fromDeg, speed: sc.wind.kt * KT, turbulence: sc.wind.turbulence }
  if (verbose) sim.onRadio = (m) => console.log(`   [${fmt(m.t)}] ${m.callsign} ${m.key} ${m.vars.rwy ?? ''}`)
  const minutes = sc.minutes ?? MIN
  const res: Result = { sim, minPlayer: Infinity, intruders: [], landingsAfter: 0, goAroundsWhileBlocked: 0, enteredWithPlayerOnFinal: [] }
  const phaseSince = new Map<number, { phase: string; t: number }>()
  const airSince = new Map<number, number>()
  const problems: string[] = []
  const worst = { hold: 0, taxi: 0, air: 0, blocked: 0 }
  const touch: number[] = []
  const lastLandings = new Map<number, number>()
  const lastGo = new Map<number, number>()
  let closedAt = -1
  let playerOnRunwaySince = -1
  let playerLeftAt = -1
  const t0 = performance.now()
  for (;;) {
    const player = sc.player ? sc.player(sim.time, sim) : null
    sim.setPlayer(player)
    sim.update(1 / 60)
    const r = sim.rwy
    const pOnRwy = player !== null && player.onGround && Math.abs(r.d(player.pos.x, player.pos.z)) < r.hw + 5
    if (pOnRwy && playerOnRunwaySince < 0) playerOnRunwaySince = sim.time
    if (!pOnRwy && playerOnRunwaySince >= 0) {
      playerOnRunwaySince = -1
      playerLeftAt = sim.time
    }
    const pFinal = player !== null && !player.onGround && sim.playerEta < 60
    for (const t of sim.aircraft) {
      const ps = phaseSince.get(t.id)
      if (!ps || ps.phase !== t.phase) {
        if (verbose && t.phase !== 'parked') console.log(`   [${fmt(sim.time)}] ${t.callsign} (${t.af.id}) → ${t.phase}`)
        // entrar en pista con el jugador en ella (tras 15 s para verlo) o en final
        if (t.phase === 'lineUp') {
          if (playerOnRunwaySince >= 0 && sim.time - playerOnRunwaySince > 15) res.intruders.push(`${t.callsign} entra en pista t=${fmt(sim.time)}`)
          if (pFinal) res.enteredWithPlayerOnFinal.push(`${t.callsign} t=${fmt(sim.time)}`)
        }
        phaseSince.set(t.id, { phase: t.phase, t: sim.time })
      }
      const since = sim.time - phaseSince.get(t.id)!.t
      if (t.phase === 'hold') worst.hold = Math.max(worst.hold, since)
      if (t.phase === 'taxiOut' || t.phase === 'taxiIn' || t.phase === 'vacate' || t.phase === 'lineUp') worst.taxi = Math.max(worst.taxi, t.stuckT)
      if (t.live && !t.airborne) worst.blocked = Math.max(worst.blocked, t.blockedT)
      if (t.airborne && !airSince.has(t.id)) airSince.set(t.id, sim.time)
      if (!t.airborne) airSince.delete(t.id)
      // (con el jugador ocupando la pista no cuenta: esperan en el aire lo que haga falta)
      if (t.airborne && t.phase !== 'depart' && t.phase !== 'arrive' && !sc.player) worst.air = Math.max(worst.air, sim.time - airSince.get(t.id)!)
      const nl = t.stats.landings
      if (nl !== (lastLandings.get(t.id) ?? 0)) {
        lastLandings.set(t.id, nl)
        touch.push(t.lastTouch)
        if (verbose) console.log(`   [${fmt(sim.time)}] ${t.callsign} toca a ${t.lastTouch.toFixed(2)} m/s, ${(t.touchIas * 3.6).toFixed(0)} km/h, morro ${((t.touchPitch * 180) / Math.PI).toFixed(0)}°`)
        if (playerOnRunwaySince >= 0 && sim.time - playerOnRunwaySince > 15) res.intruders.push(`${t.callsign} toma t=${fmt(sim.time)}`)
        else if (playerLeftAt >= 0) res.landingsAfter++
      }
      const ng = t.stats.goArounds
      if (ng !== (lastGo.get(t.id) ?? 0)) {
        lastGo.set(t.id, ng)
        if (playerOnRunwaySince >= 0) res.goAroundsWhileBlocked++
      }
      if (player && t.live) res.minPlayer = Math.min(res.minPlayer, t.pos.distanceTo(player.pos))
    }
    if (closedAt < 0 && sim.time >= minutes * 60) {
      sim.closed = true
      closedAt = sim.time
    }
    if (closedAt >= 0) {
      const busy = sim.aircraft.some((t) => t.live && t.phase !== 'depart')
      if (!busy) break
      if (sim.time > closedAt + 20 * 60) {
        problems.push(`20 min después del cierre siguen sin aparcar: ${sim.aircraft.filter((t) => t.live).map((t) => `${t.callsign} ${t.phase}`).join(', ')}`)
        break
      }
    }
  }
  const st = sim.stats
  const sum = { takeoffs: 0, landings: 0, touchGos: 0, goArounds: 0 }
  for (const t of [...sim.aircraft, ...sim.retired]) {
    sum.takeoffs += t.stats.takeoffs
    sum.landings += t.stats.landings
    sum.touchGos += t.stats.touchGos
    sum.goArounds += t.stats.goArounds
  }
  if (st.crashes) problems.push(`${st.crashes} accidente(s): ${st.crashLog.join('; ')}`)
  if (st.collisions) problems.push(`${st.collisions} choque(s) entre aparatos`)
  if (st.minAir < (sc.minAir ?? 150)) problems.push(`separación en el aire ${st.minAir.toFixed(0)} m (${st.minAirWho})`)
  if (st.minGoAround < 40) problems.push(`una frustrada pasa a ${st.minGoAround.toFixed(0)} m de otro en el aire`)
  if (st.minGround < 9) problems.push(`separación en tierra ${st.minGround.toFixed(1)} m (${st.minGroundWho})`)
  if (st.minRunway < 250) problems.push(`dos en la pista a ${st.minRunway.toFixed(0)} m (${st.minRunwayWho})`)
  if (st.minOver < 20) problems.push(`uno pasa a ${st.minOver.toFixed(0)} m sobre otro que está en tierra`)
  if (worst.hold > 600 && !sc.player) problems.push(`${(worst.hold / 60).toFixed(1)} min en el punto de espera`)
  if (worst.blocked > 720) problems.push(`${(worst.blocked / 60).toFixed(1)} min esperando detrás de otro`)
  if (worst.taxi > 150) problems.push(`${worst.taxi.toFixed(0)} s parado rodando`)
  if (worst.air > 900) problems.push(`${(worst.air / 60).toFixed(1)} min seguidos en el aire en el circuito`)
  if (!sc.player && sum.landings < 4) problems.push(`solo ${sum.landings} tomas`)
  // todo el que despegó ha vuelto al suelo o se ha ido del aeródromo
  const balance = sum.takeoffs + st.arrived - (sum.landings + st.departed) - sim.aircraft.filter((t) => t.phase === 'depart').length
  if (balance !== 0) problems.push(`despegues + llegadas − tomas − salidas = ${balance}`)
  if (Math.max(0, ...touch) > 2.6) problems.push(`toma de ${Math.max(...touch).toFixed(1)} m/s`)
  if (sc.check) problems.push(...sc.check(res))
  touch.sort((a, b) => a - b)
  const med = touch.length ? touch[Math.floor(touch.length / 2)] : 0
  const text =
    `${fmt(sim.time)} simulados en ${((performance.now() - t0) / 1000).toFixed(0)} s · arrancan ${st.launched}, llegan de fuera ${st.arrived}, se van ${st.departed} · ` +
    `${sum.takeoffs} despegues, ${sum.landings} tomas (${sum.touchGos} con despegue), ${sum.goArounds} frustradas · ` +
    `toma mediana ${med.toFixed(2)} m/s, peor ${Math.max(0, ...touch).toFixed(2)} · separación mínima: aire ${num(st.minAir)} m, tierra ${num(st.minGround)} m, pista ${num(st.minRunway)} m` +
    (sc.player ? ` · al jugador ${num(res.minPlayer)} m` : '') +
    ` · espera más larga ${(worst.hold / 60).toFixed(1)} min` +
    (problems.length ? `\n        ✗ ${problems.join('\n        ✗ ')}` : '')
  results.push({ name: sc.name, ok: problems.length === 0, text })
  console.log(`${problems.length ? 'FALLA' : ' OK  '} ${sc.name}: ${text}`)
}

// ---------------------------------------------------------------------------
// El jugador de las pruebas
// ---------------------------------------------------------------------------
const P = { pos: new Vector3(), vel: new Vector3(), onGround: true, agl: 0, rotorR: 4.2 }
const hit = { y: 0, normal: new Vector3() }
/** parado en la pista en uso, a `s` metros del principio, entre t0 y t1 */
const parkedOnRunway =
  (s: number, t0: number, t1: number) =>
  (t: number, sim: AirTrafficSim): PlayerState | null => {
    if (t < t0 || t > t1) return null
    const r = sim.rwy
    sim.host.ground(r.px(s, 0), r.pz(s, 0), hit)
    P.pos.set(r.px(s, 0), hit.y + 1.1, r.pz(s, 0))
    P.vel.set(0, 0, 0)
    P.onGround = true
    P.agl = 0
    return P
  }
/** haciendo finales largas una tras otra (sin llegar a tocar: se va a 20 m y vuelve a empezar) */
const onFinal = (t: number, sim: AirTrafficSim): PlayerState | null => {
  if (t < 240) return null
  const r = sim.rwy
  const k = ((t - 240) % 150) / 150
  if (k > 0.55) return null
  const s = r.displaced - 2000 + (k / 0.55) * 1950
  const h = 20 + (r.displaced - s) * 0.09
  P.pos.set(r.px(s, 0), h, r.pz(s, 0))
  P.vel.set(r.dx * 26, -2.3, r.dz * 26)
  P.onGround = false
  P.agl = h
  return P
}
/** cruzando el viento en cola a la altura del circuito, a contramano, una y otra vez */
const crossing = (t: number, sim: AirTrafficSim): PlayerState | null => {
  const r = sim.rwy
  const k = (t % 90) / 90
  const s = r.displaced - 1200 + k * 2700
  const d = r.side * 450
  P.pos.set(r.px(s, d), r.H + 1, r.pz(s, d))
  P.vel.set(r.dx * 30, 0, r.dz * 30)
  P.onGround = false
  P.agl = r.H
  return P
}

run({ name: 'Casarrubios, viento 250° 6 kt, mucho tráfico', raw: lemtRaw(), host: flatHost, wind: { fromDeg: 250, kt: 6, turbulence: 0.25 }, density: 'high' })
run({ name: 'Casarrubios, viento 090° 10 kt racheado (pista 08, umbral desplazado), tráfico normal', raw: lemtRaw(), host: flatHost, wind: { fromDeg: 90, kt: 10, turbulence: 0.35 }, density: 'normal' })
run({ name: 'Campo de hierba en cuesta, viento cruzado 280° 8 kt, tráfico normal', raw: grassRaw(), host: hillHost, wind: { fromDeg: 280, kt: 8, turbulence: 0.25 }, density: 'normal' })
run({
  name: 'Casarrubios, el jugador parado en la pista del minuto 5 al 11',
  raw: lemtRaw(),
  host: flatHost,
  wind: { fromDeg: 260, kt: 5, turbulence: 0.25 },
  density: 'high',
  player: parkedOnRunway(350, 300, 660),
  minutes: 20,
  check: (r) => {
    const out: string[] = []
    if (r.intruders.length) out.push(`con el jugador en la pista: ${r.intruders.join(', ')}`)
    if (r.minPlayer < 25) out.push(`un aparato pasa a ${r.minPlayer.toFixed(0)} m del jugador`)
    if (r.landingsAfter < 1) out.push('al dejar el jugador la pista nadie vuelve a tomar')
    return out
  },
})
run({
  name: 'Casarrubios, el jugador haciendo finales largas',
  raw: lemtRaw(),
  host: flatHost,
  wind: { fromDeg: 260, kt: 5, turbulence: 0.25 },
  density: 'high',
  player: onFinal,
  minutes: 15,
  check: (r) => {
    const out: string[] = []
    if (r.enteredWithPlayerOnFinal.length) out.push(`entran en pista con el jugador a menos de un minuto del umbral: ${r.enteredWithPlayerOnFinal.join(', ')}`)
    if (r.minPlayer < 40) out.push(`un aparato pasa a ${r.minPlayer.toFixed(0)} m del jugador`)
    return out
  },
})
run({
  name: 'Casarrubios, el jugador cruzando el viento en cola a contramano',
  raw: lemtRaw(),
  host: flatHost,
  wind: { fromDeg: 260, kt: 5, turbulence: 0.25 },
  density: 'high',
  player: crossing,
  minutes: 15,
  // un jugador que se mete a contramano a la altura del circuito: los demás se apartan de él (y
  // entre ellos) como pueden; lo que se exige es que no haya choque ni pasada rozando
  minAir: 60,
  check: (r) => (r.minPlayer < 20 ? [`un aparato pasa a ${r.minPlayer.toFixed(0)} m del jugador`] : []),
})

const bad = results.filter((r) => !r.ok).length
console.log(`\n${bad === 0 ? 'Tráfico aéreo: todo correcto.' : `Tráfico aéreo: ${bad} escenario(s) fallan.`}`)
process.exit(bad ? 1 : 0)
