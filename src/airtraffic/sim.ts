// Tráfico aéreo de un aeródromo: los aparatos, la pista en uso, quién sale y quién llega.
//
// Módulo puro (corre igual en el juego que en tools/air-traffic-test.ts): todo en el plano local
// del aeródromo (X este, Y arriba, Z sur). El juego le da el suelo, el viento y dónde está el
// jugador; él mueve cada aparato con su modelo de vuelo completo (240 pasos por segundo, como el
// del jugador) y su piloto simulado (pilot.ts).
//
// Aquí no se controla a nadie: como en un aeródromo sin torre, cada piloto mira y decide (pista
// ocupada, quién va delante, hueco para virar a base). Lo único que hace este «director» es lo
// que en la realidad decide cada uno antes de ir al campo: cuántos vuelan hoy, quién arranca y
// cuándo, y cuántas tomas quiere hacer.

import { Vector3 } from 'three'
import type { Airframe } from '../sim/airframes.ts'
import type { LocalAir, WindSettings } from '../sim/atmosphere.ts'
import { Airfield, type Pt, type RwyDir, type Spot } from './airfield.ts'
import { CIRCUIT_WIDTH, TrafficAircraft, type Contact, type Phase, type Scene } from './pilot.ts'

const DT = 1 / 240
const DEG = Math.PI / 180

export interface GroundHit {
  y: number
  normal: Vector3
}

export interface SimHost {
  /** suelo del aeródromo (plano local): altura y normal; false si aún no hay datos */
  ground(x: number, z: number, out: GroundHit): boolean
  /** viento del sitio en un punto (relieve, térmicas), o null: viento uniforme de `wind` */
  localAir?(pos: Vector3, agl: number): LocalAir | null
  /** ¿hay algo sólido (edificio, árbol…) en el punto? */
  blocked?(x: number, y: number, z: number): boolean
}

export interface PlayerState {
  pos: Vector3
  vel: Vector3
  onGround: boolean
  agl: number
  rotorR: number
}

export type Density = 'low' | 'normal' | 'high'

/** cuántos aparcados, cuántos moviéndose a la vez y cuántos en el circuito */
const DENSITY: Record<Density, { parked: number; active: number; circuit: number; gap: [number, number] }> = {
  low: { parked: 3, active: 1, circuit: 1, gap: [90, 240] },
  normal: { parked: 5, active: 2, circuit: 2, gap: [50, 150] },
  high: { parked: 7, active: 4, circuit: 3, gap: [25, 80] },
}

export interface RadioMsg {
  t: number
  callsign: string
  key: string
  vars: Record<string, string | number>
}

export interface SimOptions {
  density: Density
  /** aparatos que pueden salir (fichas de sim/airframes.ts) */
  fleet: Airframe[]
  /** prefijo de matrícula */
  prefix?: string
  /** azar (0..1); por defecto Math.random */
  rng?: () => number
}

/** El jugador visto por los pilotos simulados. */
class PlayerContact implements Contact {
  readonly pos = new Vector3()
  readonly vel = new Vector3()
  onGround = true
  agl = 0
  readonly isPlayer = true
  eta = Infinity
  occupies = 0
  readonly fullStop = true
  readonly phase = 'player' as const
  rotorR = 4.2
}

const _hit: GroundHit = { y: 0, normal: new Vector3() }
const _a = new Vector3()
const _b = new Vector3()
const _c = new Vector3()
const _n = new Vector3()
const BODY = [new Vector3(1.5, 0, 0), new Vector3(-0.4, 0, -1.1), new Vector3(-0.4, 0, 1.1)]

export class AirTrafficSim implements Scene {
  readonly aircraft: TrafficAircraft[] = []
  /** los que ya no están (se fueron de viaje): para las cuentas de las pruebas */
  readonly retired: TrafficAircraft[] = []
  /** pista en uso */
  rwy: RwyDir
  time = 0
  /** viento del menú (el uniforme; el del sitio lo da el anfitrión) y densidad del aire */
  wind: WindSettings = { fromDeg: 260, speed: 3, turbulence: 0.25 }
  rho = 1.12
  /** se puede volar: de día, con visibilidad y sin lluvia (lo decide el juego) */
  vfr = true
  density: Density
  onRadio: ((m: RadioMsg) => void) | null = null
  readonly log: RadioMsg[] = []
  /** para las pruebas: separación mínima vista y choques */
  readonly stats = { minAir: Infinity, minAirWho: '', minGround: Infinity, minGroundWho: '', minOver: Infinity, minGoAround: Infinity, minRunway: Infinity, minRunwayWho: '', collisions: 0, crashes: 0, incursions: 0, launched: 0, arrived: 0, departed: 0, crashLog: [] as string[] }
  private readonly player = new PlayerContact()
  private hasPlayer = false
  private readonly list: Contact[] = []
  private readonly rng: () => number
  private readonly fleet: Airframe[]
  private readonly prefix: string
  private nextLaunch = 8
  private dirT = 0
  private wantDir: RwyDir | null = null
  private thrY: number | null = null
  private thrAt = -1e9
  private populated = false
  private usedCalls = new Set<string>()
  private frame = 0
  private acc = 0
  /** el campo cierra: no sale nadie más y los que vuelan hacen su toma final */
  closed = false
  /** proporción de vuelos que llegan de fuera */
  visitorRate = 0.3

  readonly field: Airfield
  readonly host: SimHost

  constructor(field: Airfield, host: SimHost, opts: SimOptions) {
    this.field = field
    this.host = host
    this.density = opts.density
    this.fleet = opts.fleet
    this.prefix = opts.prefix ?? 'EC-'
    this.rng = opts.rng ?? Math.random
    this.rwy = field.dirs[field.raw.preferred ?? 0]
  }

  // -------------------------------------------------------------------------
  // Scene
  // -------------------------------------------------------------------------
  contacts(): readonly Contact[] {
    return this.list
  }

  groundY(x: number, z: number): number | null {
    // (el umbral se pregunta en cada paso: se guarda un momento)
    const r = this.rwy
    const tx = r.px(r.displaced, 0)
    const tz = r.pz(r.displaced, 0)
    if (x === tx && z === tz) {
      if (this.time - this.thrAt > 2 || this.thrY === null) {
        this.thrY = this.host.ground(x, z, _hit) ? _hit.y : this.thrY
        this.thrAt = this.time
      }
      return this.thrY
    }
    return this.host.ground(x, z, _hit) ? _hit.y : null
  }

  radio(who: TrafficAircraft, key: string, vars: Record<string, string | number> = {}): void {
    const m: RadioMsg = { t: this.time, callsign: who.callsign, key, vars: { ...vars, field: this.field.name } }
    this.log.push(m)
    if (this.log.length > 200) this.log.shift()
    this.onRadio?.(m)
  }

  routeOut(spot: Spot, heading: number): { pts: Pt[]; hold: number } | null {
    return this.field.routeOut(spot, this.rwy, heading)
  }
  routeIn(spot: Spot): { pts: Pt[]; heading: number } | null {
    return this.field.routeIn(this.rwy, spot)
  }
  exitS(): number {
    return this.field.exitS(this.rwy)
  }
  freeSpot(): Spot | null {
    const free = this.freeSpots()
    return free.length ? free[Math.floor(this.rng() * free.length)] : null
  }

  departure(who: TrafficAircraft): Pt {
    // sale de frente o hacia el lado contrario al circuito: nunca cruza el viento en cola
    const r = this.rwy
    const brg = r.hdg - r.side * (0.05 + this.rng() * 0.9)
    void who
    return { x: who.pos.x + Math.sin(brg) * 20000, z: who.pos.z - Math.cos(brg) * 20000 }
  }

  // -------------------------------------------------------------------------
  // Jugador
  // -------------------------------------------------------------------------
  /** segundos que le quedan al jugador para el umbral si viene a tomar (Infinity si no) */
  get playerEta(): number {
    return this.hasPlayer ? this.player.eta : Infinity
  }

  setPlayer(p: PlayerState | null): void {
    this.hasPlayer = p !== null
    if (!p) return
    const c = this.player
    c.pos.copy(p.pos)
    c.vel.copy(p.vel)
    c.onGround = p.onGround
    c.agl = p.agl
    c.rotorR = p.rotorR
    // ¿viene a tomar? En final (o en una base corta) hacia la pista en uso
    const r = this.rwy
    const sT = r.s(p.pos.x, p.pos.z) - r.displaced
    const d = r.d(p.pos.x, p.pos.z)
    const gs = Math.hypot(p.vel.x, p.vel.z)
    c.eta = Infinity
    // en la pista (posado o a punto): no se sabe cuánto va a tardar en dejarla
    c.occupies = (p.onGround || p.agl < 4) && Math.abs(d) < r.hw + 9 && sT > -r.displaced - 15 && sT < r.total - r.displaced + 15 ? 600 : 0
    if (!p.onGround && p.agl < r.H + 80 && sT < 0 && sT > -2200 && gs > 6) {
      const along = (p.vel.x * r.dx + p.vel.z * r.dz) / gs
      const inFinal = Math.abs(d) < 70 + 0.18 * -sT && along > 0.8
      // en base: cerca del eje, por debajo del circuito y acercándose a él
      const closing = -(Math.sign(d) * (-p.vel.x * r.dz + p.vel.z * r.dx))
      const inBase = Math.abs(d) < CIRCUIT_WIDTH + 150 && sT > -1100 && closing > 8 && p.agl < r.H + 30
      if (inFinal) c.eta = -sT / Math.max(gs * along, 12)
      else if (inBase) c.eta = (Math.abs(d) + -sT) / Math.max(gs, 15)
    }
  }

  // -------------------------------------------------------------------------
  // Población
  // -------------------------------------------------------------------------
  private callsign(): string {
    const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    for (;;) {
      const a = L[Math.floor(this.rng() * 26)]
      const b = L[Math.floor(this.rng() * 26)]
      const n = 1 + Math.floor(this.rng() * 9)
      const cs = `${this.prefix}${a}${b}${n}`
      if (!this.usedCalls.has(cs)) {
        this.usedCalls.add(cs)
        return cs
      }
    }
  }

  private newAircraft(): TrafficAircraft {
    const af = this.fleet[Math.floor(this.rng() * this.fleet.length)]
    const t = new TrafficAircraft(af, this.callsign(), this.rng() < 0.45)
    t.wind.settings = this.wind
    return t
  }

  private freeSpots(): Spot[] {
    return this.field.spots.filter((s) => !this.aircraft.some((a) => a.spot === s))
  }

  /** rumbo con el que queda aparcado un aparato en un puesto: el del sentido de rodaje de hoy */
  private parkHeading(spot: Spot): number {
    return this.field.routeIn(this.rwy, spot)?.heading ?? Math.atan2(spot.tx, -spot.tz)
  }

  /** Coloca los aparcados (cuando ya hay suelo bajo los puestos). */
  private populate(): void {
    if (!this.field.hasGround) {
      this.populated = true
      return
    }
    const want = Math.min(DENSITY[this.density].parked, Math.max(0, this.field.spots.length - 1))
    const have = this.aircraft.filter((a) => a.spot).length
    if (have >= want) {
      this.populated = true
      return
    }
    const free = this.freeSpots()
    // (los puestos con algo sólido encima —un hangar mal dibujado en el mapa— no se usan)
    for (let k = have; k < want && free.length; k++) {
      const i = Math.floor(this.rng() * free.length)
      const spot = free.splice(i, 1)[0]
      if (!this.host.ground(spot.x, spot.z, _hit)) return
      if (this.host.blocked?.(spot.x, _hit.y + 1.2, spot.z)) {
        k--
        continue
      }
      const t = this.newAircraft()
      t.park(spot, this.parkHeading(spot), _hit.y)
      this.aircraft.push(t)
    }
    this.populated = true
  }

  /** Cambia la densidad (los que sobran aparcados se quedan; los que vuelan terminan su vuelo). */
  setDensity(d: Density): void {
    if (d === this.density) return
    this.density = d
    this.populated = false
  }

  // -------------------------------------------------------------------------
  // Pista en uso
  // -------------------------------------------------------------------------
  /** viento de cara (m/s) en un sentido de la pista */
  headwind(r: RwyDir): number {
    const to = (this.wind.fromDeg + 180) * DEG
    return -(Math.sin(to) * r.dx + -Math.cos(to) * r.dz) * this.wind.speed
  }
  crosswind(r: RwyDir): number {
    const to = (this.wind.fromDeg + 180) * DEG
    return Math.abs(-Math.sin(to) * r.dz + -Math.cos(to) * r.dx) * this.wind.speed
  }

  /** ¿Se vuela hoy? Viento dentro de lo que vuela un piloto de club y condiciones visuales. */
  get flyable(): boolean {
    return this.vfr && this.wind.speed <= 7.5 && this.crosswind(this.rwy) <= 5 && this.wind.turbulence <= 0.36
  }

  private chooseRunway(): void {
    const [a, b] = this.field.dirs
    const ha = this.headwind(a)
    const hb = this.headwind(b)
    const other = this.rwy === a ? b : a
    const better = (this.rwy === a ? hb - ha : ha - hb) > 1.5
    this.wantDir = better ? other : null
    if (!this.wantDir) return
    // se cambia cuando no queda nadie moviéndose
    const moving = this.aircraft.some((t) => t.live && t.phase !== 'shutdown')
    if (!moving) {
      this.rwy = this.wantDir
      this.wantDir = null
      this.thrY = null
      // los aparcados miran ya hacia el nuevo sentido de rodaje la próxima vez que aparquen; los
      // que están, salen dando media vuelta (airfield.routeOut)
    }
  }

  // -------------------------------------------------------------------------
  // Director: quién arranca y quién llega
  // -------------------------------------------------------------------------
  private direct(): void {
    const D = DENSITY[this.density]
    if (!this.populated) this.populate()
    // retirar los que se han ido y los restos viejos
    for (let i = this.aircraft.length - 1; i >= 0; i--) {
      const t = this.aircraft[i]
      if (t.phase === 'depart') {
        const far = Math.hypot(t.pos.x, t.pos.z)
        const fromPlayer = this.hasPlayer ? t.pos.distanceTo(this.player.pos) : Infinity
        if ((far > 6000 && fromPlayer > 4500) || far > 14000) {
          this.stats.departed++
          this.retired.push(...this.aircraft.splice(i, 1))
        }
      } else if (t.phase === 'wreck' && t.tPhase > 180) this.retired.push(...this.aircraft.splice(i, 1))
    }
    // (el que se va de viaje deja de contar en cuanto sale del circuito: ya no estorba a nadie y,
    // si no, tenía a los de la plataforma esperando minutos hasta que se alejaba 6 km)
    const active = this.aircraft.filter((t) => t.live && t.phase !== 'shutdown' && t.phase !== 'wreck' && !(t.phase === 'depart' && Math.hypot(t.pos.x, t.pos.z) > 2500))
    const circuit = active.filter((t) => t.phase !== 'depart' && t.phase !== 'vacate' && t.phase !== 'taxiIn')
    // con mal tiempo o cambio de pista pendiente, los que vuelan terminan: toma final
    if (!this.flyable || this.wantDir || this.closed) for (const t of active) if (t.airborne && t.phase !== 'depart' && !t.plan.leaving) t.plan.laps = 0
    if (!this.flyable || this.wantDir || this.closed || this.time < this.nextLaunch) return
    if (active.length >= D.active || circuit.length >= D.circuit) return
    const gap = D.gap[0] + this.rng() * (D.gap[1] - D.gap[0])
    const parked = this.aircraft.filter((t) => t.phase === 'parked' && t.tPhase > t.rest)
    const free = this.freeSpots()
    const inbound = this.aircraft.some((t) => t.phase === 'arrive' || t.phase === 'orbit')
    const visitor = !inbound && (this.rng() < this.visitorRate || !parked.length)
    if (!visitor && !parked.length) return
    if (visitor) {
      if (this.spawnArrival(free)) this.nextLaunch = this.time + gap
      else this.nextLaunch = this.time + 10
      return
    }
    const t = parked[Math.floor(this.rng() * parked.length)]
    this.start(t)
    this.nextLaunch = this.time + gap
  }

  /** Un piloto llega al campo, arranca y sale a hacer circuitos o a irse de viaje. */
  private start(t: TrafficAircraft): void {
    const leaving = this.rng() < 0.3
    t.plan = { laps: leaving ? 0 : 1 + Math.floor(this.rng() * 4), leaving }
    t.warmup = 20 + this.rng() * 25
    t.runup = 8 + this.rng() * 10
    t.rest = 120 + this.rng() * 400
    t.ac.engineOn = true
    t.ac.engineRpm = 0
    t.live = true
    t.grounded = false
    t.setPhase('startup')
    this.stats.launched++
  }

  /** Un visitante llega de fuera a incorporarse al circuito. */
  private spawnArrival(free: Spot[]): boolean {
    const r = this.rwy
    const Lc = Math.min(r.total - r.displaced, 900)
    const W = CIRCUIT_WIDTH * r.side
    const jx = r.px(r.displaced + Lc + 150, W + r.side * 750)
    const jz = r.pz(r.displaced + Lc + 150, W + r.side * 750)
    // llega por el lado del circuito, de entre través y más allá del final de la pista
    const brg = r.hdg + r.side * (0.5 + this.rng() * 1.0)
    const dist = 5200
    const x = jx + Math.sin(brg) * dist
    const z = jz - Math.cos(brg) * dist
    if (this.hasPlayer && Math.hypot(x - this.player.pos.x, z - this.player.pos.z) < 3000) return false
    const gy = this.groundY(r.px(r.displaced, 0), r.pz(r.displaced, 0))
    if (gy === null) return false
    const t = this.newAircraft()
    const here = this.host.ground(x, z, _hit) ? _hit.y : gy
    const y = Math.max(gy + r.H, here + 120)
    const spot = this.field.hasGround && free.length ? free[Math.floor(this.rng() * free.length)] : null
    t.spot = spot
    // con puesto, viene a quedarse (quizá tras alguna toma y despegue); sin él, tomas y despegues y se va
    t.plan = spot ? { laps: this.rng() < 0.5 ? 0 : 1, leaving: false } : { laps: 1 + Math.floor(this.rng() * 2), leaving: true }
    t.rest = 240 + this.rng() * 400
    t.spawnInbound(x, y, z, Math.atan2(jx - x, -(jz - z)), here)
    this.aircraft.push(t)
    this.stats.arrived++
    return true
  }

  // -------------------------------------------------------------------------
  // Paso
  // -------------------------------------------------------------------------
  /** Suelo bajo un aparato: plano ajustado a tres puntos (uno si va alto). */
  private refreshGround(t: TrafficAircraft): void {
    const ac = t.ac
    const g = t.ground
    if (t.grounded && ac.agl > 150) {
      if ((this.frame + t.id) % 8) return
      if (this.host.ground(ac.pos.x, ac.pos.z, _hit)) {
        g.p0.set(ac.pos.x, _hit.y, ac.pos.z)
        g.n.copy(_hit.normal)
      }
      return
    }
    if (t.grounded && ac.agl > 30 && (this.frame + t.id) % 3) return
    const pts = [_a, _b, _c]
    let ok = 0
    for (let i = 0; i < 3; i++) {
      const p = pts[i].copy(BODY[i]).applyQuaternion(ac.quat).add(ac.pos)
      if (!this.host.ground(p.x, p.z, _hit)) break
      p.y = _hit.y
      ok++
    }
    if (ok === 3) {
      _n.subVectors(_b, _a).cross(_c.clone().sub(_a)).normalize()
      if (_n.y < 0) _n.negate()
      if (_n.y > 0.5) {
        g.n.copy(_n)
        g.p0.copy(_a)
        t.grounded = true
      }
    } else if (ok > 0) {
      g.p0.copy(_a)
      t.grounded = true
    }
  }

  update(dt: number): void {
    this.frame++
    // lista de tráfico que ve cada piloto
    this.list.length = 0
    for (const t of this.aircraft) if (t.phase !== 'gone') this.list.push(t)
    if (this.hasPlayer) this.list.push(this.player)

    this.dirT -= dt
    if (this.dirT <= 0) {
      this.dirT = 1
      this.chooseRunway()
      this.direct()
    }
    for (const t of this.aircraft) if (!t.live) t.tPhase += dt
    const live = this.aircraft.filter((t) => t.live)
    for (const t of live) {
      this.refreshGround(t)
      t.env.rho = this.rho
      t.wind.settings = this.wind
      if (this.host.localAir && (this.frame + t.id) % 6 === 0) t.wind.local = this.host.localAir(t.pos, Math.max(0, t.ac.agl))
      else if (!this.host.localAir) t.wind.local = null
    }
    // pasos de física: los mismos 240 Hz del jugador
    this.acc += Math.min(dt, 0.1)
    const n = Math.min(24, Math.floor(this.acc / DT + 1e-6))
    this.acc -= n * DT
    for (let i = 0; i < n; i++) {
      this.time += DT
      for (const t of live) {
        if (!t.live || !t.grounded) continue
        t.wind.sample(DT, Math.max(0, t.ac.agl), t.ac.tas, t.wv)
        t.step(DT, this)
        if (t.ac.crash && t.phase === 'wreck' && t.tPhase === 0) {
          this.stats.crashes++
          this.stats.crashLog.push(`${t.callsign} (${t.af.id}) t=${this.time.toFixed(0)}: ${t.ac.crash.title}`)
        }
      }
    }
    if (n > 0) this.measure()
  }

  /** Separaciones (para las pruebas y para detectar choques entre simulados). */
  private measure(): void {
    const a = this.aircraft
    const r = this.rwy
    const st = this.stats
    for (let i = 0; i < a.length; i++) {
      const p = a[i]
      if (p.phase === 'wreck') continue
      for (let j = i + 1; j < a.length; j++) {
        const q = a[j]
        if (q.phase === 'wreck' || (!p.live && !q.live)) continue
        const dh = Math.hypot(p.pos.x - q.pos.x, p.pos.z - q.pos.z)
        const dv = Math.abs(p.pos.y - q.pos.y)
        const pAir = p.live && !p.ac.onGround && p.ac.agl > 2
        const qAir = q.live && !q.ac.onGround && q.ac.agl > 2
        if (pAir && qAir && (p.phase === 'goAround' || q.phase === 'goAround')) {
          // una frustrada pasa al lado del que está en la pista o acaba de despegar: de lado, no encima
          if (dv < 30) st.minGoAround = Math.min(st.minGoAround, dh)
        } else if (pAir && qAir) {
          // los dos en el aire: distancia en planta si están a menos de 30 m de altura uno de otro
          if (dv < 30 && dh < st.minAir) {
            st.minAir = dh
            st.minAirWho = `${p.callsign} ${p.phase} / ${q.callsign} ${q.phase} t=${this.time.toFixed(0)}`
          }
        } else if (!pAir && !qAir) {
          if (dh < st.minGround) {
            st.minGround = dh
            st.minGroundWho = `${p.callsign} ${p.phase} / ${q.callsign} ${q.phase} t=${this.time.toFixed(0)}`
          }
        } else if (dv < 15) st.minOver = Math.min(st.minOver, dh)
        if (dh < 5 && dv < 2.5) {
          st.collisions++
          for (const t of [p, q]) {
            if (t.live) {
              t.live = false
              t.setPhase('wreck')
            }
          }
        }
        // dos en la pista a la vez (en el suelo o a punto de tocarlo): distancia entre ellos
        const on = (t: TrafficAircraft) => t.live && Math.abs(r.d(t.pos.x, t.pos.z)) < r.hw + 5 && r.s(t.pos.x, t.pos.z) > -20 && r.s(t.pos.x, t.pos.z) < r.total + 20 && t.ac.agl < 10
        if (on(p) && on(q) && dh < st.minRunway) {
          st.minRunway = dh
          st.minRunwayWho = `${p.callsign} ${p.phase} / ${q.callsign} ${q.phase} t=${this.time.toFixed(0)}`
        }
      }
    }
  }

  /** Recuento por fase (telemetría y pruebas). */
  census(): Partial<Record<Phase, number>> {
    const out: Partial<Record<Phase, number>> = {}
    for (const t of this.aircraft) out[t.phase] = (out[t.phase] ?? 0) + 1
    return out
  }
}
