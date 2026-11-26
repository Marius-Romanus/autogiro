// Modo escuela: ejercicios de un curso de piloto de autogiro con un instructor que pone nota, y la
// nota de cada toma también en vuelo libre.
//
//  · exercises.ts   los ejercicios (objetivo, condiciones, criterios) y su seguimiento
//  · site.ts        la pista en uso y su circuito (el real de Casarrubios; en otra pista, genérico)
//  · LandingRecorder.ts + landingScore.ts   qué pasó en la toma y qué nota merece
//  · Marks.ts       puertas del circuito y recuadros en la pista
//  · schoolMenu.ts  pestaña «Escuela» del menú; history.ts, el progreso guardado
//
// main.ts solo llama a step() tras cada paso de la física, a update() en cada fotograma y a
// onSpawn() al reaparecer. El ejercicio prepara sus condiciones cambiando los ajustes del menú
// (salida, viento, hora, combustible) y los devuelve al terminar; por si se cierra el juego a
// medias, la copia de los ajustes del jugador se guarda aparte y se restaura al arrancar.

import { Vector3, type Scene } from 'three'
import { saveSettings, type Location, type Settings } from '../config.ts'
import { locale, onLangChange, t } from '../i18n.ts'
import type { Autogyro, Controls } from '../sim/autogyro.ts'
import { aircraftById, aircraftName } from '../aircraft/catalog.ts'
import type { World } from '../world/World.ts'
import { EXERCISES, exerciseById, type Criterion, type Ctx, type ExerciseDef, type Runner } from './exercises.ts'
import { addAttempt, addLanding, bestScore, loadSchool, saveSchool, type SchoolData } from './history.ts'
import { LandingRecorder } from './LandingRecorder.ts'
import { gradeLanding, type LandingGrade, type LandingSample, type RunwayHit } from './landingScore.ts'
import { Marks } from './Marks.ts'
import { bearing, genericSite, halfWidthFor, lemtRunwayFor, lemtSite, RwyFrame, type GeoPoint, type Local, type Site } from './site.ts'
import './schoolText.ts'
import './school.css'

export interface SchoolHost {
  settings: Settings
  ac: Autogyro
  scene: Scene
  world(): World | null
  state(): 'loading' | 'flying' | 'crashed'
  menuOpen(): boolean
  inRoom(): boolean
  /** salida elegida en el menú */
  location(): Location
  /** aplica los ajustes y reaparece en la salida, cerrando el menú */
  restart(): void
  /** recoloca el aparato: en el suelo (agl null) o en vuelo; false si aún no hay terreno ahí */
  place(x: number, z: number, headingDeg: number, agl: number | null, speed: number): boolean
  /** lectura del altímetro (ft) en un punto del mundo */
  altimeterFt(p: Vector3): number
  throttle(): number
  toast(msg: string, secs?: number): void
  refreshMenu(): void
  /** repetición de la última toma (src/replay), si existe */
  replay?: (() => void) | null
  /** la simulación está parada (se está viendo la repetición): el ejercicio espera */
  frozen?: () => boolean
}

/** ajustes que un ejercicio cambia y que se devuelven al terminar */
const KEPT: Array<keyof Settings> = ['locationId', 'customLat', 'customLon', 'customHeading', 'customName', 'mapLocationId', 'start', 'hour', 'windFrom', 'windSpeed', 'turbulence', 'windGustKt', 'fuelPct', 'failures', 'failRandom']
const RESTORE_KEY = 'autogiro.school.restore'
const DEG = Math.PI / 180

interface Active {
  def: ExerciseDef
  site: Site
  /** con «Tu salida», la pista aún no se ha encontrado en el mapa */
  resolved: boolean
  phase: 'placing' | 'run' | 'done'
  runner: Runner | null
  t: number
}

interface Result {
  def: ExerciseDef
  score: number
  pass: boolean
  criteria: Criterion[]
  landing: LandingGrade | null
  crashed: boolean
}

const _p = new Vector3()
const _a = new Vector3()
const _b = new Vector3()
const _f = new Vector3()
const _loc: Local = { s: 0, d: 0, h: 0 }

/** Texto con variables: los números con la coma del idioma y los valores que son claves, traducidos. */
export function tv(key: string, vars?: Record<string, string | number>): string {
  if (!vars) return t(key)
  const out: Record<string, string | number> = {}
  for (const [k, v] of Object.entries(vars)) {
    if (typeof v === 'string' && v.startsWith('school.')) out[k] = t(v)
    else if (typeof v === 'number' && !Number.isInteger(v)) out[k] = v.toLocaleString(locale(), { maximumFractionDigits: 1 })
    else if (typeof v === 'string' && /^-?\d+\.\d+$/.test(v)) out[k] = Number(v).toLocaleString(locale(), { minimumFractionDigits: v.split('.')[1].length, maximumFractionDigits: 2 })
    else out[k] = v
  }
  return t(key, out)
}

export const fmtScore = (v: number) => v.toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })

export class School {
  readonly data: SchoolData = loadSchool()
  active: Active | null = null
  private readonly frame = new RwyFrame()
  private readonly marks: Marks
  private readonly rec = new LandingRecorder()
  private readonly card: HTMLElement
  private cardHtml = ''
  private cardT = 0
  /** tarjeta fija (resumen o nota de una toma) y cuánto le queda (s; Infinity: hasta que se cierre) */
  private pinned: { html: string; left: number } | null = null
  private groundT = 0
  private result: Result | null = null
  /** avisa al menú de que algo ha cambiado (progreso, ejercicio en curso) */
  onChange: () => void = () => {}

  private readonly host: SchoolHost

  constructor(host: SchoolHost) {
    this.host = host
    this.restoreLeftovers()
    this.marks = new Marks(host.scene)
    this.card = document.createElement('div')
    this.card.id = 'school-card'
    this.card.className = 'card hidden'
    document.body.appendChild(this.card)
    this.card.addEventListener('mousedown', (e) => e.preventDefault())
    this.card.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act
      if (act) this.cardAction(act)
    })
    onLangChange(() => this.repaint())
  }

  /** El juego se cerró con un ejercicio a medias: los ajustes del jugador vuelven a ser los suyos. */
  private restoreLeftovers(): void {
    try {
      const raw = localStorage.getItem(RESTORE_KEY)
      if (!raw) return
      Object.assign(this.host.settings, JSON.parse(raw))
      localStorage.removeItem(RESTORE_KEY)
      saveSettings(this.host.settings)
    } catch {
      /* sin almacenamiento */
    }
  }

  // -------------------------------------------------------------------------
  // Empezar y terminar un ejercicio
  // -------------------------------------------------------------------------

  /** Por qué no se puede empezar este ejercicio ahora (clave de i18n), o null. */
  blocked(def: ExerciseDef): string | null {
    const h = this.host
    if (h.inRoom()) return 'school.room'
    const id = aircraftById(h.settings.aircraft).id
    if (id === 'wilford') return 'school.noWheels'
    if (def.noseWheelOnly && id === 'cierva') return 'school.noseOnly'
    if (this.data.site === 'here' && !this.active) {
      const loc = h.location()
      if (!(loc.runway || loc.id === 'custom') || h.settings.start !== 'runway') return 'school.needRunway'
    }
    return null
  }

  /** Pista de Casarrubios en uso: con las condiciones del menú, la que queda contra el viento. */
  private lemtRunway(def: ExerciseDef): Site {
    const s = this.host.settings
    if (this.data.cond === 'menu' && def.id !== 'crosswind') {
      const s08 = lemtSite('08')
      const head = Math.cos((s.windFrom - bearing(s08.a, s08.b)) * DEG)
      return head >= 0 ? s08 : lemtSite('26')
    }
    return lemtSite('26')
  }

  start(id: string): void {
    const def = exerciseById(id)
    const h = this.host
    if (!def || this.blocked(def)) return
    const s = h.settings
    if (this.active) this.restoreSettings()
    // copia de los ajustes del jugador (también en disco, por si se cierra a medias)
    const keep: Record<string, unknown> = {}
    for (const k of KEPT) keep[k] = s[k]
    try {
      localStorage.setItem(RESTORE_KEY, JSON.stringify(keep))
    } catch {
      /* sin almacenamiento */
    }
    this.kept = keep
    let site: Site
    let resolved = true
    if (this.data.site === 'lemt') {
      site = this.lemtRunway(def)
      const hdg = bearing(site.a, site.b)
      // la salida, 15 m dentro del extremo de la pista
      const k = 15 / Math.hypot((site.b.lat - site.a.lat) * 111320, (site.b.lon - site.a.lon) * 111320 * Math.cos(site.a.lat * DEG))
      s.locationId = 'custom'
      s.mapLocationId = 'custom'
      s.customLat = site.a.lat + (site.b.lat - site.a.lat) * k
      s.customLon = site.a.lon + (site.b.lon - site.a.lon) * k
      s.customHeading = Math.round(hdg * 100) / 100
      s.customName = site.name
    } else {
      // «Tu salida»: de momento, 600 m de pista por delante; la de verdad se busca al cargar el mapa
      const loc = h.location()
      const a = { lat: loc.lat, lon: loc.lon }
      const d = 600
      const b = { lat: a.lat + (d * Math.cos(loc.heading * DEG)) / 111320, lon: a.lon + (d * Math.sin(loc.heading * DEG)) / (111320 * Math.cos(a.lat * DEG)) }
      site = genericSite(loc.name, a, b, d)
      resolved = false
    }
    s.start = 'runway'
    s.failures = 'none'
    s.failRandom = false
    if (this.data.cond === 'ex' || def.id === 'crosswind') {
      const hdg = bearing(site.a, site.b)
      s.windFrom = Math.round((hdg + def.wind.rel + 360) % 360)
      s.windSpeed = def.wind.kt
      s.windGustKt = 0
      s.turbulence = 0.1
    }
    if (this.data.cond === 'ex') {
      s.hour = 11
      s.fuelPct = 50
    }
    this.active = { def, site, resolved, phase: 'placing', runner: null, t: 0 }
    this.result = null
    this.pinned = null
    h.refreshMenu()
    h.restart()
    this.onChange()
  }
  private kept: Record<string, unknown> | null = null

  private restoreSettings(): void {
    if (this.kept) Object.assign(this.host.settings, this.kept)
    this.kept = null
    try {
      localStorage.removeItem(RESTORE_KEY)
    } catch {
      /* sin almacenamiento */
    }
  }

  /** Deja el ejercicio: el vuelo sigue, pero los ajustes del menú vuelven a ser los del jugador. */
  end(silent = false): void {
    if (!this.active) return
    this.active = null
    this.result = null
    this.pinned = null
    this.marks.clear()
    this.restoreSettings()
    saveSettings(this.host.settings)
    this.host.refreshMenu()
    if (!silent) this.host.toast(t('school.toast.ended'), 4)
    this.onChange()
  }

  /** Al reaparecer (Volar, Retroceso, Reintentar): el ejercicio en curso vuelve a empezar. */
  onSpawn(): void {
    this.rec.reset(true)
    const a = this.active
    if (!a) return
    // si la salida ya no es la del ejercicio (el jugador ha elegido otra en el menú), se acaba
    if (a.site.id !== 'here' && this.host.settings.customName !== a.site.name) {
      this.end(true)
      return
    }
    a.phase = 'placing'
    a.runner = null
    a.t = 0
    this.result = null
    this.pinned = null
    this.marks.clear()
    this.frame.valid = this.frame.grounded = false
  }

  // -------------------------------------------------------------------------
  // Pista
  // -------------------------------------------------------------------------

  /** Pistas del mapa alrededor (las mismas que alisa world/Runways.ts). */
  private runwayList(w: World): ReadonlyArray<{ lat0: number; lon0: number; mLat: number; mLon: number; ux: number; uy: number; len: number }> {
    return (w.runways ?? w.gridRunways?.runways)?.list ?? []
  }

  /** «Tu salida»: busca en el mapa la pista en la que está el punto de salida y elige el sentido. */
  private resolveSite(w: World, a: Active): boolean {
    const loc = this.host.location()
    let best: { a: GeoPoint; b: GeoPoint; len: number } | null = null
    let bestD = 60
    w.frame.geoToWorld(loc.lat, loc.lon, 0, _p)
    for (const r of this.runwayList(w)) {
      const A = { lat: r.lat0, lon: r.lon0 }
      const B = { lat: r.lat0 + (r.uy * r.len) / r.mLat, lon: r.lon0 + (r.ux * r.len) / r.mLon }
      w.frame.geoToWorld(A.lat, A.lon, 0, _a)
      w.frame.geoToWorld(B.lat, B.lon, 0, _b)
      const dx = _b.x - _a.x
      const dz = _b.z - _a.z
      const L = Math.hypot(dx, dz)
      const s = ((_p.x - _a.x) * dx + (_p.z - _a.z) * dz) / L
      const d = Math.abs((_p.x - _a.x) * -dz + (_p.z - _a.z) * dx) / L
      if (s > -30 && s < L + 30 && d < bestD) {
        bestD = d
        best = { a: A, b: B, len: r.len }
      }
    }
    if (!best) return false
    // sentido: el de la salida o, con las condiciones del menú, el que queda contra el viento
    const hdgAB = bearing(best.a, best.b)
    const ref = this.data.cond === 'menu' && a.def.id !== 'crosswind' ? this.host.settings.windFrom : loc.heading
    const flip = Math.cos((ref - hdgAB) * DEG) < 0
    a.site = genericSite(loc.name, flip ? best.b : best.a, flip ? best.a : best.b, best.len)
    a.resolved = true
    if (this.data.cond === 'ex' || a.def.id === 'crosswind') {
      // el viento del ejercicio, respecto a la pista de verdad
      const s = this.host.settings
      s.windFrom = Math.round((bearing(a.site.a, a.site.b) + a.def.wind.rel + 360) % 360)
    }
    return true
  }

  /** Dónde cae un punto respecto a la pista que toca: la del ejercicio o, en vuelo libre, la más cercana. */
  private readonly locate = (pos: Vector3, fwd: Vector3, vel: Vector3): { hit: RunwayHit | null; want: boolean } => {
    const a = this.active
    if (a && a.phase !== 'placing' && this.frame.valid) {
      return { hit: this.hitOn(this.frame, pos, fwd, a.def.aim ?? null), want: a.def.wantRunway }
    }
    const w = this.host.world()
    if (!w) return { hit: null, want: false }
    let best: RunwayHit | null = null
    let bestD = 70
    const f = this.free
    for (const r of this.runwayList(w)) {
      const A = { lat: r.lat0, lon: r.lon0 }
      const B = { lat: r.lat0 + (r.uy * r.len) / r.mLat, lon: r.lon0 + (r.ux * r.len) / r.mLon }
      w.frame.geoToWorld(A.lat, A.lon, 0, _a)
      w.frame.geoToWorld(B.lat, B.lon, 0, _b)
      // se toma en el sentido en que se va
      const fwdAB = vel.x * (_b.x - _a.x) + vel.z * (_b.z - _a.z) >= 0
      const site = lemtRunwayFor(fwdAB ? A : B, fwdAB ? B : A) ?? { id: 'free', name: '', a: fwdAB ? A : B, b: fwdAB ? B : A, hw: halfWidthFor(r.len), displaced: 0, side: -1 as const, circuitAgl: 150 }
      f.update(w, site, false)
      const hit = this.hitOn(f, pos, fwd, null)
      if (hit.s > -hit.before - 150 && hit.s < hit.len + 150 && Math.abs(hit.d) < bestD) {
        bestD = Math.abs(hit.d)
        best = hit
      }
    }
    return { hit: best, want: best !== null }
  }
  private readonly free = new RwyFrame()

  private hitOn(f: RwyFrame, pos: Vector3, fwd: Vector3, aim: number | null): RunwayHit {
    f.local(pos, _loc)
    const along = fwd.x * f.dir.x + fwd.z * f.dir.z
    const side = fwd.x * f.right.x + fwd.z * f.right.z
    return { s: _loc.s, d: _loc.d, len: f.len, hw: f.hw, before: f.before, axisDeg: Math.atan2(side, along) / DEG, aim }
  }

  // -------------------------------------------------------------------------
  // Cada paso de la física y cada fotograma
  // -------------------------------------------------------------------------

  /** Tras cada paso de la física (main.stepPhysics). */
  step(dt: number, ac: Autogyro, ctl: Controls): void {
    const a = this.active
    if (a && (a.phase === 'placing' || a.t <= 0.5)) return
    const s = this.rec.step(dt, ac, ctl.pitch, this.host.throttle(), this.locate)
    if (s) this.onLanding(s)
  }

  private onLanding(s: LandingSample): void {
    const g = gradeLanding(s)
    const a = this.active
    if (a) {
      if (a.phase !== 'run' || !a.runner) return
      if (a.def.landing) {
        a.runner.onLanding(s, g)
        this.finish(a)
      } else if (s.crash) this.finish(a, true)
      return
    }
    // vuelo libre
    addLanding(this.data, { t: Date.now(), ac: aircraftById(this.host.settings.aircraft).id, score: g.score, note: g.comments[0]?.key ?? '', vars: g.comments[0]?.vars ?? {} })
    saveSchool(this.data)
    this.onChange()
    if (this.data.showGrade) this.pinned = { html: this.landingHtml(s, g, true), left: g.crash ? Infinity : 25 }
  }

  /** Cada fotograma. */
  update(dt: number, ctl: Controls): void {
    const h = this.host
    const w = h.world()
    const a = this.active
    const state = h.state()
    // al entrar en una sala mandan las condiciones del anfitrión: el ejercicio se deja sin tocarlas
    if (a && h.inRoom()) {
      this.kept = null
      try {
        localStorage.removeItem(RESTORE_KEY)
      } catch {
        /* sin almacenamiento */
      }
      this.active = null
      this.pinned = null
      this.marks.clear()
      this.onChange()
      this.drawCard(dt)
      return
    }
    if (a && w) {
      // la pista en el mundo (el origen se mueve con el aparato); el suelo, de vez en cuando
      this.groundT -= dt
      const sample = this.groundT <= 0
      if (sample) this.groundT = 1
      if (a.phase === 'placing' && state === 'flying') {
        a.t += dt
        // «Tu salida»: se espera un poco a que el mapa tenga las pistas; si no hay, pista supuesta
        if (!a.resolved && (this.resolveSite(w, a) || a.t > 4)) a.resolved = true
        if (a.resolved) {
          this.frame.update(w, a.site, true)
          if (this.frame.grounded) this.begin(a, w)
        }
      } else if (a.phase !== 'placing') {
        this.frame.update(w, a.site, sample)
        this.marks.update(dt, this.frame, w)
      }
      if (h.frozen?.()) {
        // viendo la repetición: el aparato que se ve es el grabado, no cuenta
      } else if (a.phase === 'run' && a.runner && state === 'flying' && !h.menuOpen()) {
        // (el primer medio segundo tras recolocar, la altura y el «en tierra» aún son los de antes)
        a.t += dt
        if (a.t > 0.5) a.runner.update(this.ctx(dt, a, ctl))
        if (a.runner.done) this.finish(a)
      } else if (a.phase === 'run' && state === 'crashed') this.finish(a, true)
    }
    this.marks.root.visible = Boolean(a && a.phase !== 'placing' && this.marks.root.children.length)
    this.drawCard(dt)
  }

  private ctx(dt: number, a: Active, ctl: Controls): Ctx {
    const ac = this.host.ac
    const f = this.frame
    f.local(ac.pos, _loc)
    _f.set(1, 0, 0).applyQuaternion(ac.quat)
    const hdg = ((Math.atan2(_f.x, -_f.z) / DEG) + 360) % 360
    let rel = hdg - f.heading
    if (rel > 180) rel -= 360
    if (rel < -180) rel += 360
    return {
      dt,
      ac,
      loc: _loc,
      f,
      side: a.site.side,
      H: a.site.circuitAgl,
      throttle: this.host.throttle(),
      prerot: ctl.prerotator,
      brake: ctl.wheelBrake,
      hdgRel: rel,
      hdg,
      // (la altitud publicada del circuito manda sobre la lectura: en LEMT, 2500 ft justos)
      altFt: (hh) => (a.site.circuitFt && Math.abs(hh - a.site.circuitAgl) < 0.5 ? a.site.circuitFt : this.host.altimeterFt(f.world(0, 0, hh, _p))),
      nextGate: (i) => this.marks.setNextGate(i),
    }
  }

  /** Coloca el aparato donde empieza el ejercicio y pone las marcas. */
  private begin(a: Active, w: World): void {
    const f = this.frame
    const def = a.def
    const st = def.start(f, a.site.side, a.site.circuitAgl)
    f.world(st.s, st.d, 0, _p)
    if (!this.host.place(_p.x, _p.z, (f.heading + st.hdg) % 360, st.agl, st.speed)) return
    this.marks.clear()
    const gates = def.gates?.(f, a.site.side, a.site.circuitAgl)
    if (gates) {
      this.marks.setGates(gates)
      this.marks.setNextGate(0)
    }
    for (const [s0, s1, line] of def.boxes?.(f) ?? []) this.marks.addBox(s0, s1, f.hw, line)
    this.marks.update(0, f, w)
    a.runner = def.make(f, a.site.side, a.site.circuitAgl)
    a.phase = 'run'
    a.t = 0
    this.rec.reset(st.agl === null)
    this.repaint()
  }

  private finish(a: Active, crashed = false): void {
    if (a.phase !== 'run' || !a.runner) return
    a.phase = 'done'
    const r = a.runner
    crashed = crashed || Boolean(r.landing?.crash)
    const criteria = r.criteria()
    const pass = !crashed && criteria.every((k) => k.ok)
    const score = crashed ? 0 : r.score()
    this.result = { def: a.def, score, pass, criteria, landing: r.landing, crashed }
    const acId = aircraftById(this.host.settings.aircraft).id
    addAttempt(this.data, a.def.id, acId, { t: Date.now(), score, pass, site: a.site.id })
    saveSchool(this.data)
    this.pinned = { html: this.summaryHtml(this.result, r.landingSample), left: Infinity }
    this.onChange()
  }

  // -------------------------------------------------------------------------
  // Tarjeta (indicaciones, resumen, nota de la toma)
  // -------------------------------------------------------------------------

  private cardAction(act: string): void {
    const a = this.active
    switch (act) {
      case 'retry':
        if (a) this.host.restart()
        break
      case 'next': {
        if (!a) break
        const i = EXERCISES.findIndex((e) => e.id === a.def.id)
        for (let k = 1; k <= EXERCISES.length; k++) {
          const next = EXERCISES[(i + k) % EXERCISES.length]
          if (!this.blocked(next)) {
            this.start(next.id)
            break
          }
        }
        break
      }
      case 'free':
        this.end()
        break
      case 'replay':
        this.host.replay?.()
        break
      case 'close':
        this.pinned = null
        break
    }
    this.repaint()
  }

  /** La tarjeta se vuelve a pintar en el próximo fotograma aunque el contenido nuevo sea el mismo (o
   *  ninguno: al cerrar la nota en vuelo libre no queda nada que enseñar y hay que ocultarla). */
  private repaint(): void {
    this.cardHtml = '\u0000'
    this.cardT = 0
  }

  private drawCard(dt: number): void {
    const h = this.host
    const a = this.active
    let html = ''
    const hidden = h.menuOpen() || h.state() === 'loading'
    if (this.pinned) {
      this.pinned.left -= dt
      if (this.pinned.left <= 0) this.pinned = null
    }
    if (!hidden) {
      if (this.pinned) html = this.pinned.html
      else if (a && a.phase !== 'done') {
        this.cardT -= dt
        if (this.cardT > 0 && this.cardHtml) return
        this.cardT = 0.2
        html = this.runHtml(a)
      }
    }
    if (html === this.cardHtml) return
    this.cardHtml = html
    this.card.classList.toggle('hidden', !html)
    this.card.dataset.mode = this.pinned ? 'summary' : 'run'
    this.card.innerHTML = html
  }

  private head(def: ExerciseDef): string {
    const n = EXERCISES.indexOf(def) + 1
    return `<div class="sc-kicker">${t('school.card.kicker', { n, of: EXERCISES.length })}</div><h3>${t(`school.ex.${def.id}.name`)}</h3>`
  }

  private runHtml(a: Active): string {
    const r = a.runner
    if (!r || a.phase === 'placing') return `${this.head(a.def)}<p class="sc-step">${t('school.card.preparing')}</p>`
    const lines = r.lines.map((l) => `<li>${tv(l.key, l.vars)}</li>`).join('')
    return `${this.head(a.def)}<p class="sc-step">${r.step ? tv(r.step, r.stepVars) : ''}</p><ul class="sc-live">${lines}</ul><p class="sc-keys">${t('school.card.keys')}</p>`
  }

  private gradeRows(g: LandingGrade): string {
    return g.items.map((i) => `<tr data-level="${i.level}"><th>${t(`school.i.${i.id}`)}</th><td>${tv(i.text, i.vars)}</td></tr>`).join('')
  }

  private comments(g: LandingGrade): string {
    return `<div class="sc-say"><span>${t('school.card.instructor')}</span>${g.comments.map((c) => `<p>${tv(c.key, c.vars)}</p>`).join('')}</div>`
  }

  private replayButton(): string {
    return this.host.replay ? `<button type="button" data-act="replay">${t('school.card.replay')}</button>` : ''
  }

  private landingHtml(s: LandingSample, g: LandingGrade, free: boolean): string {
    const title = s.rollout === null && !g.crash ? t('school.card.touchGo') : t('school.card.landing')
    return `<div class="sc-kicker">${title}</div>
      <div class="sc-score" data-ok="${g.score >= 5}"><b>${fmtScore(g.score)}</b><span>/ 10</span></div>
      <table class="sc-items">${this.gradeRows(g)}</table>${this.comments(g)}
      ${free ? `<div class="sc-actions">${this.replayButton()}<button type="button" data-act="close">${t('school.card.close')}</button></div>` : ''}`
  }

  private summaryHtml(r: Result, s: LandingSample | null): string {
    const crit = r.criteria.map((k) => `<li data-ok="${k.ok}">${tv(k.key, k.vars)}</li>`).join('')
    const best = bestScore(this.data, r.def.id, aircraftById(this.host.settings.aircraft).id)
    const land = r.landing ? `<table class="sc-items">${this.gradeRows(r.landing)}</table>${this.comments(r.landing)}` : r.crashed ? `<p class="sc-step">${t('school.card.crashed')}</p>` : ''
    void s
    return `${this.head(r.def)}
      <div class="sc-score" data-ok="${r.pass}"><b>${fmtScore(r.score)}</b><span>/ 10 · ${t(r.pass ? 'school.card.pass' : 'school.card.fail')}</span></div>
      <ul class="sc-crit">${crit}</ul>${land}
      ${best !== null ? `<p class="sc-keys">${t('school.card.best', { best: fmtScore(best) })}</p>` : ''}
      <div class="sc-actions"><button type="button" class="primary" data-act="retry">${t('school.card.retry')}</button><button type="button" data-act="next">${t('school.card.next')}</button>${r.landing ? this.replayButton() : ''}<button type="button" data-act="free">${t('school.card.free')}</button></div>`
  }

  /** nombre del aparato elegido (para el menú) */
  aircraftLabel(): string {
    return aircraftName(aircraftById(this.host.settings.aircraft))
  }
}
