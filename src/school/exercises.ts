// Ejercicios de la escuela: los de un curso de piloto de autogiro, en su orden.
//
// De dónde salen:
//  · Reino Unido, PPL(G): CAA Standards Document 44 «Gyroplane Licensing» (v6, octubre de 2025),
//    Appendix A «The PPL(G) Syllabus» (ejercicios 1-38) y Appendix B (progresión en tierra de los
//    monoplazas: SS/2 rodaje, SS/3 prerrotación, SS/6-8 «wheel balancing», SS/10-11 «low hops»).
//    https://caa.co.uk/publication/download/16500
//  · España: licencia de piloto de ultraligero con habilitación de autogiro (AG), Real Decreto
//    123/2015 (art. 5.4: 15 h de vuelo, 20 despegues y 20 aterrizajes). El decreto no trae un
//    programa por ejercicios; el orden de aquí es el británico, que es el que está publicado.
// Cada ejercicio dice a qué ejercicio del programa corresponde (`syllabus`).
//
// Un ejercicio es una pequeña máquina de estados (`Runner`) que mira al aparato en cada paso y al
// final da criterios cumplidos o no y una nota de 0 a 10. No toca la física ni los mandos (salvo
// el simulacro de fallo de motor, que es el mismo de la tecla F2: el instructor quita gas).

import { Vector3 } from 'three'
import type { Autogyro } from '../sim/autogyro.ts'
import { glideFor } from '../sim/glideData.ts'
import type { LandingGrade, LandingSample } from './landingScore.ts'
import { circuitGates, CIRCUIT_WIDTH, GATE, type Gate, type Local, type RwyFrame } from './site.ts'

export type ExerciseId = 'taxi' | 'balance' | 'hop' | 'circuit' | 'precision' | 'poweroff' | 'efato' | 'crosswind' | 'turns' | 'slow'

export interface StartPose {
  s: number
  d: number
  /** null: en el suelo */
  agl: number | null
  /** m/s */
  speed: number
  /** rumbo respecto al de la pista (grados) */
  hdg: number
}

/** Lo que ve el ejercicio en cada paso. */
export interface Ctx {
  dt: number
  ac: Autogyro
  loc: Local
  f: RwyFrame
  side: 1 | -1
  /** altura del circuito sobre la pista (m) */
  H: number
  throttle: number
  prerot: boolean
  brake: number
  /** rumbo del aparato respecto al de la pista (grados, −180…180) */
  hdgRel: number
  /** rumbo absoluto en el mundo (grados) */
  hdg: number
  /** lectura del altímetro (ft) a una altura h sobre la pista */
  altFt(h: number): number
  /** nueva puerta a resaltar */
  nextGate(i: number): void
}

export interface Criterion {
  key: string
  vars?: Record<string, string | number>
  ok: boolean
}

export interface Line {
  key: string
  vars?: Record<string, string | number>
}

export abstract class Runner {
  /** indicación en curso (clave de i18n) y lecturas en vivo para el HUD */
  step = ''
  stepVars: Record<string, string | number> = {}
  lines: Line[] = []
  done = false
  landing: LandingGrade | null = null
  landingSample: LandingSample | null = null
  abstract update(c: Ctx): void
  abstract criteria(): Criterion[]
  /** 0…10 */
  abstract score(): number
  /** la toma que cierra el ejercicio (si lo cierra una toma) */
  onLanding(s: LandingSample, g: LandingGrade): void {
    this.landingSample = s
    this.landing = g
    this.done = true
  }
  protected say(key: string, vars: Record<string, string | number> = {}): void {
    this.step = key
    this.stepVars = vars
  }
}

export interface ExerciseDef {
  id: ExerciseId
  /** ejercicio del programa PPL(G) de la CAA al que corresponde */
  syllabus: string
  /** viento del ejercicio: de dónde viene respecto al rumbo de la pista (grados, + por la derecha) y nudos */
  wind: { rel: number; kt: number }
  /** acaba con una toma en la pista (su nota entra en la del ejercicio) */
  landing: boolean
  /** el ejercicio pide tomar en la pista: salirse cuenta */
  wantRunway: boolean
  /** punto de toma marcado (m desde el principio de la zona de toma) */
  aim?: number
  /** solo triciclos (rueda de morro) */
  noseWheelOnly?: boolean
  start(f: RwyFrame, side: 1 | -1, H: number): StartPose
  gates?(f: RwyFrame, side: 1 | -1, H: number): Gate[]
  /** recuadros pintados en la pista: [s0, s1, raya] */
  boxes?(f: RwyFrame): Array<[number, number, number | null]>
  make(f: RwyFrame, side: 1 | -1, H: number): Runner
}

const KMH = 3.6
const kmh = (ms: number) => Math.round(ms * KMH)
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const half = (v: number) => Math.round(clamp(v, 0, 10) * 2) / 2
/** en la pista, 15 m dentro del extremo (donde salen los aparatos) */
const lineUp = (f: RwyFrame): StartPose => ({ s: -f.before + 15, d: 0, agl: null, speed: 0, hdg: 0 })
const onFinal = (): StartPose => ({ s: -900, d: 0, agl: 120, speed: 28, hdg: 0 })
const _f = new Vector3()

/** cabeceo sobre la postura de reposo (grados) */
function pitchUp(ac: Autogyro): number {
  _f.set(1, 0, 0).applyQuaternion(ac.quat)
  return ((Math.asin(clamp(_f.y, -1, 1)) - ac.restAttitude().pitch) * 180) / Math.PI
}

// ---------------------------------------------------------------------------
// 1. Rodaje y prerrotación con frenos
// ---------------------------------------------------------------------------
const TAXI = { dist: 150, box: 30, speed: 25, speedMax: 30, off: 5, hold: 2 }

class TaxiRunner extends Runner {
  private phase: 'taxi' | 'prerot' = 'taxi'
  private maxSpeed = 0
  private maxOff = 0
  private inBox = false
  private readonly stop = new Vector3()
  private moved = 0
  private readonly s0: number
  constructor(f: RwyFrame) {
    super()
    this.s0 = -f.before + 15 + TAXI.dist
  }
  update(c: Ctx): void {
    const ac = c.ac
    const target = 200 * ac.rpmScale
    if (this.phase === 'taxi') {
      this.say('school.taxi.s1', { kmh: TAXI.speed })
      this.maxSpeed = Math.max(this.maxSpeed, ac.groundSpeed)
      this.maxOff = Math.max(this.maxOff, Math.abs(c.loc.d))
      const to = this.s0 - c.loc.s
      this.lines = [
        { key: 'school.l.toBox', vars: { m: Math.max(0, Math.round(to)) } },
        { key: 'school.l.speed', vars: { kmh: kmh(ac.groundSpeed), max: TAXI.speed } },
        { key: 'school.l.centre', vars: { m: Math.abs(c.loc.d).toFixed(1) } },
      ]
      const within = c.loc.s >= this.s0 && c.loc.s <= this.s0 + TAXI.box
      if (ac.groundSpeed < 0.3 && c.loc.s > this.s0 - 40 && (within || c.loc.s > this.s0 + TAXI.box)) {
        this.inBox = within
        this.stop.copy(ac.pos)
        this.phase = 'prerot'
      }
    } else {
      this.say('school.taxi.s2', { rpm: Math.round(target) })
      this.moved = Math.max(this.moved, Math.hypot(ac.pos.x - this.stop.x, ac.pos.z - this.stop.z))
      this.lines = [
        { key: 'school.l.rotor', vars: { rpm: Math.round(ac.rotor.rpm), target: Math.round(target) } },
        { key: 'school.l.moved', vars: { m: this.moved.toFixed(1) } },
      ]
      if (ac.rotor.rpm >= target) this.done = true
    }
  }
  criteria(): Criterion[] {
    return [
      { key: 'school.k.taxiSpeed', vars: { kmh: kmh(this.maxSpeed), max: TAXI.speedMax }, ok: this.maxSpeed * KMH <= TAXI.speedMax },
      { key: 'school.k.centre', vars: { m: this.maxOff.toFixed(1), max: TAXI.off }, ok: this.maxOff <= TAXI.off },
      { key: 'school.k.inBox', ok: this.inBox },
      { key: 'school.k.held', vars: { m: this.moved.toFixed(1), max: TAXI.hold }, ok: this.phase === 'prerot' && this.done && this.moved <= TAXI.hold },
    ]
  }
  score(): number {
    return half(10 - 2.5 * this.criteria().filter((k) => !k.ok).length)
  }
}

// ---------------------------------------------------------------------------
// 2. Carrera equilibrada sobre las ruedas principales («wheel balancing»)
// ---------------------------------------------------------------------------
// (en este modelo de vuelo el morro sube ya cerca de la velocidad de despegue: el margen es estrecho)
const BALANCE = { goal: 6, pass: 3, lift: 1, off: 8, nose: 2 }

class BalanceRunner extends Runner {
  private cur = 0
  private best = 0
  private maxAgl = 0
  private maxOff = 0
  private stopped = false
  private rolled = false
  update(c: Ctx): void {
    const ac = c.ac
    const up = pitchUp(ac)
    if (ac.groundSpeed > 5) this.rolled = true
    if (this.rolled) this.maxOff = Math.max(this.maxOff, Math.abs(c.loc.d))
    if (!ac.onGround) this.maxAgl = Math.max(this.maxAgl, ac.agl)
    // en equilibrio: la rueda de morro en el aire y las principales en el suelo o rozándolo (a esa
    // velocidad el aparato va ya casi sin peso y da saltitos de un palmo: cuentan)
    const balanced = ac.groundSpeed > 4 && up > BALANCE.nose && (ac.onGround || ac.agl < 0.3)
    this.cur = balanced ? this.cur + c.dt : 0
    this.best = Math.max(this.best, this.cur)
    if (!this.rolled) this.say('school.balance.s1', { rpm: Math.round(200 * ac.rpmScale) })
    else if (this.best < BALANCE.goal) this.say('school.balance.s2')
    else this.say('school.balance.s3')
    this.lines = [
      { key: 'school.l.balance', vars: { s: this.cur.toFixed(1), best: this.best.toFixed(1), goal: BALANCE.goal } },
      { key: 'school.l.nose', vars: { deg: up.toFixed(1) } },
      { key: 'school.l.speedOnly', vars: { kmh: kmh(ac.groundSpeed) } },
    ]
    if (this.rolled && ac.onGround && ac.groundSpeed < 0.5 && (this.best >= BALANCE.pass || c.loc.s > 200)) {
      this.stopped = Math.abs(c.loc.d) <= c.f.hw && c.loc.s <= c.f.len
      this.done = true
    }
    // se ha ido al aire de verdad o se ha acabado la pista: fin
    if (this.maxAgl > 6 || c.loc.s > c.f.len + 30) this.done = true
  }
  criteria(): Criterion[] {
    return [
      { key: 'school.k.balance', vars: { s: this.best.toFixed(1), min: BALANCE.pass }, ok: this.best >= BALANCE.pass },
      { key: 'school.k.noLift', vars: { m: this.maxAgl.toFixed(1), max: BALANCE.lift }, ok: this.maxAgl <= BALANCE.lift },
      { key: 'school.k.centre', vars: { m: this.maxOff.toFixed(1), max: BALANCE.off }, ok: this.maxOff <= BALANCE.off },
      { key: 'school.k.stopped', ok: this.stopped },
    ]
  }
  score(): number {
    const k = this.criteria()
    return half(10 * clamp(this.best / BALANCE.goal, 0, 1) - 2 * k.slice(1).filter((x) => !x.ok).length)
  }
}

// ---------------------------------------------------------------------------
// 3. Salto a ras de pista («low hop»)
// ---------------------------------------------------------------------------
const HOP = { minDist: 80, maxAgl: 6, way: 10 }

class HopRunner extends Runner {
  private dist = 0
  private maxAgl = 0
  private readonly last = new Vector3()
  private was = false
  update(c: Ctx): void {
    const ac = c.ac
    const air = !ac.onGround && ac.agl > 0.3
    if (air) {
      if (this.was) this.dist += Math.hypot(ac.pos.x - this.last.x, ac.pos.z - this.last.z)
      this.maxAgl = Math.max(this.maxAgl, ac.agl)
    }
    this.was = air
    this.last.copy(ac.pos)
    if (this.maxAgl < 0.3) this.say('school.hop.s1')
    else if (air) this.say(ac.agl > HOP.maxAgl ? 'school.hop.high' : 'school.hop.s2')
    else this.say('school.hop.s3')
    this.lines = [
      { key: 'school.l.agl', vars: { m: Math.max(0, ac.agl).toFixed(1), max: HOP.maxAgl } },
      { key: 'school.l.airDist', vars: { m: Math.round(this.dist), min: HOP.minDist } },
      { key: 'school.l.left', vars: { m: Math.round(c.f.len - c.loc.s) } },
    ]
  }
  criteria(): Criterion[] {
    const g = this.landing
    return [
      { key: 'school.k.hopDist', vars: { m: Math.round(this.dist), min: HOP.minDist }, ok: this.dist >= HOP.minDist },
      { key: 'school.k.hopAgl', vars: { m: this.maxAgl.toFixed(1), max: HOP.maxAgl }, ok: this.maxAgl <= HOP.maxAgl },
      landingOk(g, 5),
    ]
  }
  score(): number {
    const task = 10 - (this.dist < HOP.minDist ? 5 : 0) - (this.maxAgl > HOP.way ? 10 : this.maxAgl > HOP.maxAgl ? 5 : 0)
    return half(0.6 * (this.landing?.score ?? 0) + 0.4 * clamp(task, 0, 10))
  }
}

function landingOk(g: LandingGrade | null, min: number): Criterion {
  return { key: g?.crash ? 'school.k.crash' : 'school.k.landing', vars: { score: (g?.score ?? 0).toFixed(1), min }, ok: Boolean(g) && !g!.crash && g!.score >= min }
}
function onRunway(s: LandingSample | null): Criterion {
  const rw = s?.runway
  const ok = Boolean(rw) && Math.abs(rw!.d) <= rw!.hw && rw!.s >= -rw!.before && rw!.s <= rw!.len
  return { key: 'school.k.onRunway', ok }
}

// ---------------------------------------------------------------------------
// 4. Circuito de tráfico completo
// ---------------------------------------------------------------------------
const CIRCUIT = { alt: 30 }

class CircuitRunner extends Runner {
  private readonly gates: Gate[]
  private i = 0
  private hit: boolean[] = []
  private altErr: number[] = []
  private prevSide = 0
  private told = false
  private readonly H: number
  constructor(f: RwyFrame, side: 1 | -1, H: number) {
    super()
    this.H = H
    this.gates = circuitGates(f, side, H)
  }
  update(c: Ctx): void {
    if (!this.told) {
      this.told = true
      c.nextGate(0)
    }
    const ac = c.ac
    const g = this.gates[this.i]
    if (g) {
      // paso por el plano de la puerta, en su sentido
      const along = (c.loc.s - g.s) * g.ts + (c.loc.d - g.d) * g.td
      const across = Math.abs(-(c.loc.s - g.s) * g.td + (c.loc.d - g.d) * g.ts)
      const dh = c.loc.h - g.h
      if (this.prevSide < 0 && along >= 0 && across < 900) {
        const inside = across <= GATE.w / 2 + GATE.slackW && Math.abs(dh) <= GATE.h / 2 + GATE.slackH
        this.hit[this.i] = inside
        if (g.level) this.altErr.push(Math.abs(dh))
        this.i++
        this.prevSide = 0
        c.nextGate(this.i)
      } else this.prevSide = along < 0 ? -1 : this.prevSide
      const dist = Math.hypot(c.loc.s - g.s, c.loc.d - g.d)
      this.say(ac.onGround && this.i === 0 ? 'school.circuit.s0' : `school.circuit.${g.id}`, { ft: Math.round(c.altFt(this.H) / 50) * 50 })
      this.lines = [
        { key: 'school.l.gate', vars: { n: this.i + 1, of: this.gates.length, m: Math.round(dist / 10) * 10 } },
        { key: 'school.l.gateAlt', vars: { ft: Math.round(c.altFt(g.h) / 10) * 10, d: Math.round((dh * 3.281) / 10) * 10 } },
      ]
    } else {
      this.say('school.circuit.land')
      this.lines = [{ key: 'school.l.agl', vars: { m: Math.max(0, ac.agl).toFixed(0), max: 0 } }]
    }
  }
  criteria(): Criterion[] {
    const n = this.hit.filter(Boolean).length
    const worst = this.altErr.length ? Math.max(...this.altErr) : 999
    return [
      { key: 'school.k.gates', vars: { n, of: this.gates.length }, ok: n === this.gates.length },
      { key: 'school.k.circuitAlt', vars: { ft: this.altErr.length ? Math.round(worst * 3.281) : '—', max: Math.round(CIRCUIT.alt * 3.281) }, ok: worst <= CIRCUIT.alt },
      onRunway(this.landingSample),
      landingOk(this.landing, 5),
    ]
  }
  score(): number {
    const n = this.hit.filter(Boolean).length
    const bust = this.altErr.filter((e) => e > CIRCUIT.alt).length + (this.altErr.length < 2 ? 2 - this.altErr.length : 0)
    const task = (10 * n) / this.gates.length - 1.5 * bust
    return half(0.5 * (this.landing?.score ?? 0) + 0.5 * clamp(task, 0, 10))
  }
}

// ---------------------------------------------------------------------------
// 5 y 8. Toma de precisión en un punto · toma con viento cruzado
// ---------------------------------------------------------------------------
const PRECISION = { aim: 100, pass: 20 }

class ApproachRunner extends Runner {
  private readonly kind: 'precision' | 'crosswind'
  constructor(kind: 'precision' | 'crosswind') {
    super()
    this.kind = kind
  }
  update(c: Ctx): void {
    const ac = c.ac
    this.say(ac.agl > 12 ? `school.${this.kind}.s1` : `school.${this.kind}.s2`, { m: PRECISION.aim })
    const to = (this.kind === 'precision' ? PRECISION.aim : 0) - c.loc.s
    this.lines = [
      { key: this.kind === 'precision' ? 'school.l.toPoint' : 'school.l.toThreshold', vars: { m: Math.round(to) } },
      { key: 'school.l.centre', vars: { m: Math.abs(c.loc.d).toFixed(0) } },
      { key: 'school.l.speedOnly', vars: { kmh: kmh(ac.ias) } },
    ]
  }
  criteria(): Criterion[] {
    const s = this.landingSample
    const rw = s?.runway
    if (this.kind === 'precision') {
      const e = rw ? Math.abs(rw.s - PRECISION.aim) : 999
      return [{ key: 'school.k.point', vars: { m: rw ? Math.round(e) : '—', max: PRECISION.pass }, ok: e <= PRECISION.pass }, onRunway(s), landingOk(this.landing, 5)]
    }
    return [
      { key: 'school.k.drift', vars: { ms: s ? Math.abs(s.drift).toFixed(1) : '—', max: 1 }, ok: Boolean(s) && Math.abs(s!.drift) <= 1 },
      { key: 'school.k.axis', vars: { deg: rw ? Math.round(Math.abs(rw.axisDeg)) : '—', max: 10 }, ok: Boolean(rw) && Math.abs(rw!.axisDeg) <= 10 },
      onRunway(s),
      landingOk(this.landing, 5),
    ]
  }
  score(): number {
    return this.landing?.score ?? 0
  }
}

// ---------------------------------------------------------------------------
// 6 y 7. Toma sin motor desde viento en cola · fallo de motor tras el despegue
// ---------------------------------------------------------------------------
/** velocidad mínima admitida en el planeo (km/h): por debajo ya no queda con qué recoger */
const GLIDE_MIN = 45

class EngineOutRunner extends Runner {
  private cut = false
  private usedEngine = false
  private minIas = 999
  private readonly cutAgl: number
  private t = 0
  private readonly kind: 'poweroff' | 'efato'
  constructor(kind: 'poweroff' | 'efato') {
    super()
    this.kind = kind
    // el instructor corta entre 60 y 90 m (200-300 ft): no se sabe cuándo
    this.cutAgl = 60 + Math.random() * 30
  }
  update(c: Ctx): void {
    const ac = c.ac
    const g = glideFor(ac.af)
    this.t += c.dt
    if (!this.cut) {
      const now = this.kind === 'poweroff' ? this.t > 4 : !ac.onGround && ac.agl >= this.cutAgl
      if (now && !ac.onGround) {
        ac.pp.startDrill()
        this.cut = true
      }
      this.say(this.kind === 'poweroff' ? 'school.poweroff.s0' : ac.onGround ? 'school.efato.s0' : 'school.efato.s1')
    } else if (!ac.onGround) {
      // el simulacro se quita con F2: eso es «motor y al aire», no una toma sin motor
      if (!ac.pp.drill) this.usedEngine = true
      // (por debajo de 10 m ya es la recogida: ahí la velocidad tiene que caer)
      if (ac.agl > 10) this.minIas = Math.min(this.minIas, ac.ias * KMH)
      this.say(`school.${this.kind}.s2`, { best: Math.round(g.best / 5) * 5, flare: g.flare })
    }
    this.lines = [
      { key: 'school.l.speedBest', vars: { kmh: kmh(ac.ias), best: Math.round(g.best / 5) * 5 } },
      { key: 'school.l.agl', vars: { m: Math.max(0, ac.agl).toFixed(0), max: 0 } },
    ]
    if (this.kind === 'poweroff') this.lines.push({ key: 'school.l.centre', vars: { m: Math.abs(c.loc.d).toFixed(0) } })
  }
  criteria(): Criterion[] {
    const s = this.landingSample
    const g = this.landing
    const min = GLIDE_MIN
    const list: Criterion[] = [
      { key: 'school.k.noEngine', ok: this.cut && !this.usedEngine },
      { key: 'school.k.glideSpeed', vars: { kmh: this.minIas > 900 ? '—' : Math.round(this.minIas), min }, ok: this.minIas >= min },
    ]
    if (this.kind === 'poweroff') list.push(onRunway(s))
    list.push(landingOk(g, this.kind === 'poweroff' ? 5 : 4))
    return list
  }
  score(): number {
    const k = this.criteria()
    const task = 10 - 5 * k.slice(0, -1).filter((x) => !x.ok).length
    return half(0.7 * (this.landing?.score ?? 0) + 0.3 * clamp(task, 0, 10))
  }
}

// ---------------------------------------------------------------------------
// 9. Virajes de 360° nivelados
// ---------------------------------------------------------------------------
const TURNS = { alt: 30, speed: 15, settle: 4, timeout: 300 }

class TurnsRunner extends Runner {
  private t = 0
  private turn = 0
  private acc = 0
  private prevHdg = 0
  private alt0 = 0
  private ias0 = 0
  private dAlt = [0, 0]
  private dIas = [0, 0]
  private maxBank = 0
  private done2 = [false, false]
  update(c: Ctx): void {
    const ac = c.ac
    this.t += c.dt
    if (this.t < TURNS.settle) {
      this.alt0 = c.loc.h
      this.ias0 = ac.ias
      this.prevHdg = c.hdg
      this.say('school.turns.s0')
      return
    }
    if (this.turn > 1) return
    let dh = c.hdg - this.prevHdg
    if (dh > 180) dh -= 360
    if (dh < -180) dh += 360
    this.prevHdg = c.hdg
    this.acc += dh
    const k = this.turn
    this.dAlt[k] = Math.max(this.dAlt[k], Math.abs(c.loc.h - this.alt0))
    this.dIas[k] = Math.max(this.dIas[k], Math.abs(ac.ias - this.ias0) * KMH)
    _f.set(0, 0, 1).applyQuaternion(ac.quat)
    const bank = (Math.asin(clamp(-_f.y, -1, 1)) * 180) / Math.PI
    this.maxBank = Math.max(this.maxBank, Math.abs(bank))
    // el primero a la izquierda (el rumbo baja), el segundo a la derecha
    const turned = k === 0 ? -this.acc : this.acc
    this.say(k === 0 ? 'school.turns.s1' : 'school.turns.s2', { ft: Math.round(c.altFt(this.alt0) / 10) * 10, kmh: kmh(this.ias0) })
    this.lines = [
      { key: 'school.l.turned', vars: { deg: Math.round(clamp(turned, 0, 360)) } },
      { key: 'school.l.altDev', vars: { ft: Math.round(((c.loc.h - this.alt0) * 3.281) / 10) * 10 } },
      { key: 'school.l.speedDev', vars: { kmh: kmh(ac.ias), ref: kmh(this.ias0) } },
      { key: 'school.l.bank', vars: { deg: Math.round(Math.abs(bank)) } },
    ]
    if (turned >= 355) {
      this.done2[k] = true
      this.turn++
      this.acc = 0
    }
    if (this.turn > 1 || this.t > TURNS.timeout) this.done = true
  }
  criteria(): Criterion[] {
    const alt = Math.max(...this.dAlt)
    const ias = Math.max(...this.dIas)
    return [
      { key: 'school.k.turnsDone', ok: this.done2[0] && this.done2[1] },
      { key: 'school.k.turnAlt', vars: { ft: Math.round(alt * 3.281), max: Math.round(TURNS.alt * 3.281) }, ok: alt <= TURNS.alt },
      { key: 'school.k.turnSpeed', vars: { kmh: Math.round(ias), max: TURNS.speed }, ok: ias <= TURNS.speed },
      { key: 'school.k.bank', vars: { deg: Math.round(this.maxBank) }, ok: this.maxBank >= 15 && this.maxBank <= 50 },
    ]
  }
  score(): number {
    let sc = 0
    for (const k of [0, 1]) {
      if (!this.done2[k]) continue
      sc += 5 - clamp(((this.dAlt[k] - TURNS.alt / 2) / (TURNS.alt / 2)) * 2, 0, 3.5) - clamp(((this.dIas[k] - TURNS.speed / 2) / (TURNS.speed / 2)) * 1.5, 0, 1.5)
    }
    return half(sc)
  }
}

// ---------------------------------------------------------------------------
// 10. Vuelo lento (detrás de la curva de potencia)
// ---------------------------------------------------------------------------
const SLOW = { hold: 30, alt: 30, band: 15, timeout: 240 }

class SlowRunner extends Runner {
  private t = 0
  private cur = 0
  private best = 0
  private alt0 = 0
  private dAlt = 0
  private worst = 0
  private minIas = 999
  update(c: Ctx): void {
    const ac = c.ac
    const g = glideFor(ac.af)
    // banda: desde 15 km/h por debajo de la velocidad de mínimo descenso hasta ella
    const hi = Math.round(g.minSinkV / 5) * 5
    const lo = hi - SLOW.band
    const v = ac.ias * KMH
    this.t += c.dt
    this.minIas = Math.min(this.minIas, v)
    const inBand = v >= lo && v <= hi
    if (inBand) {
      if (this.cur === 0) {
        this.alt0 = c.loc.h
        this.dAlt = 0
      }
      this.cur += c.dt
      this.dAlt = Math.max(this.dAlt, Math.abs(c.loc.h - this.alt0))
      if (this.cur > this.best) {
        this.best = this.cur
        this.worst = this.dAlt
      }
    } else this.cur = 0
    this.say(v > hi ? 'school.slow.s1' : v < lo ? 'school.slow.low' : 'school.slow.s2', { lo, hi })
    this.lines = [
      { key: 'school.l.speedBand', vars: { kmh: Math.round(v), lo, hi } },
      { key: 'school.l.hold', vars: { s: this.cur.toFixed(0), goal: SLOW.hold } },
      { key: 'school.l.altDev', vars: { ft: this.cur > 0 ? Math.round(((c.loc.h - this.alt0) * 3.281) / 10) * 10 : 0 } },
    ]
    if (this.best >= SLOW.hold || this.t > SLOW.timeout) this.done = true
  }
  criteria(): Criterion[] {
    return [
      { key: 'school.k.slowHold', vars: { s: Math.round(this.best), min: SLOW.hold }, ok: this.best >= SLOW.hold },
      { key: 'school.k.slowAlt', vars: { ft: Math.round(this.worst * 3.281), max: Math.round(SLOW.alt * 3.281) }, ok: this.best > 5 && this.worst <= SLOW.alt },
    ]
  }
  score(): number {
    return half(10 * clamp(this.best / SLOW.hold, 0, 1) - clamp(((this.worst - SLOW.alt / 2) / (SLOW.alt / 2)) * 2.5, 0, 5))
  }
}

// ---------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------
const HEAD = { rel: 0, kt: 5 }

export const EXERCISES: ExerciseDef[] = [
  {
    id: 'taxi',
    syllabus: 'Ex 4 · SS/2-3',
    wind: HEAD,
    landing: false,
    wantRunway: false,
    start: lineUp,
    boxes: (f) => [[-f.before + 15 + TAXI.dist, -f.before + 15 + TAXI.dist + TAXI.box, null]],
    make: (f) => new TaxiRunner(f),
  },
  {
    id: 'balance',
    syllabus: 'Ex 13 · SS/6-8',
    wind: HEAD,
    landing: false,
    wantRunway: false,
    noseWheelOnly: true,
    start: lineUp,
    make: () => new BalanceRunner(),
  },
  {
    id: 'hop',
    syllabus: 'Ex 14/16 · SS/10-11',
    wind: HEAD,
    landing: true,
    wantRunway: true,
    start: lineUp,
    make: () => new HopRunner(),
  },
  {
    id: 'circuit',
    syllabus: 'Ex 12 · 14 · 16',
    wind: HEAD,
    landing: true,
    wantRunway: true,
    start: lineUp,
    gates: circuitGates,
    make: (f, side, H) => new CircuitRunner(f, side, H),
  },
  {
    id: 'precision',
    syllabus: 'Ex 18',
    wind: HEAD,
    landing: true,
    wantRunway: true,
    aim: PRECISION.aim,
    start: onFinal,
    boxes: () => [[PRECISION.aim - PRECISION.pass, PRECISION.aim + PRECISION.pass, PRECISION.aim]],
    make: () => new ApproachRunner('precision'),
  },
  {
    id: 'poweroff',
    syllabus: 'Ex 19 · 30',
    wind: HEAD,
    landing: true,
    wantRunway: true,
    // al través de la zona de toma, más cerca y más alto que el circuito normal: con fineza 4 y
    // media vuelta por medio, desde 450 m de separación a 450 ft no se llega
    start: (_f, side) => ({ s: 120, d: side * (CIRCUIT_WIDTH - 150), agl: 185, speed: 27, hdg: 180 }),
    make: () => new EngineOutRunner('poweroff'),
  },
  {
    id: 'efato',
    syllabus: 'Ex 27 · 29',
    wind: HEAD,
    landing: true,
    wantRunway: false,
    start: lineUp,
    make: () => new EngineOutRunner('efato'),
  },
  {
    id: 'crosswind',
    syllabus: 'Ex 17',
    // 10 kt a 70° por la derecha: 9 kt de través (el MTOsport tiene demostrados 22)
    wind: { rel: 70, kt: 10 },
    landing: true,
    wantRunway: true,
    start: onFinal,
    make: () => new ApproachRunner('crosswind'),
  },
  {
    id: 'turns',
    syllabus: 'Ex 6 · 8',
    wind: HEAD,
    landing: false,
    wantRunway: false,
    start: () => ({ s: 0, d: 0, agl: 300, speed: 28, hdg: 0 }),
    make: () => new TurnsRunner(),
  },
  {
    id: 'slow',
    syllabus: 'Ex 21',
    wind: HEAD,
    landing: false,
    wantRunway: false,
    start: () => ({ s: 0, d: 0, agl: 300, speed: 28, hdg: 0 }),
    make: () => new SlowRunner(),
  },
]

export function exerciseById(id: string): ExerciseDef | undefined {
  return EXERCISES.find((e) => e.id === id)
}
