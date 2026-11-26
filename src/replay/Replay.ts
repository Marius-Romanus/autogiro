// Repetición del vuelo: graba siempre (FlightRecorder) y, con F4 o «Ver repetición» tras un accidente,
// para la física y enseña lo grabado desde cualquier cámara, a cualquier velocidad, con los restos del
// accidente y sus efectos. Al salir todo vuelve a como estaba (en vuelo, en pausa hasta pulsar Espacio;
// tras un accidente, al resumen). Exporta la traza en GPX y KML (trackExport.ts).
//
// Enganches en main.ts: `record()` al final de cada fotograma; con la repetición activa, `update()` en
// lugar de mover el aparato, `camera()`, `updateGfx()`, `updateHud()` y `soundState()`; la física, los
// mandos, la hora y el viento se quedan parados mientras `frozen`.

import { Color, Matrix4, Quaternion, Vector3, type Object3D } from 'three'
import type { Graphics } from '../render/Graphics.ts'
import type { GroundSample, World } from '../world/World.ts'
import type { Autogyro, Controls } from '../sim/autogyro.ts'
import type { AircraftView, ViewControls } from '../aircraft/AircraftView.ts'
import { camName, type CameraRig, type CameraRigState } from '../camera/CameraRig.ts'
import type { Hud, HudData } from '../hud/Hud.ts'
import type { CrashSystem } from '../crash/CrashSystem.ts'
import type { Sound, SoundState } from '../audio/Sound.ts'
import type { Chunk } from '../sim/wreck/Wreck.ts'
import { CrashFx } from '../fx/CrashFx.ts'
import { WaterFx } from '../fx/WaterFx.ts'
import { locationName, type Location, type Settings } from '../config.ts'
import { aircraftById, aircraftName } from '../aircraft/catalog.ts'
import { addStrings, onLangChange, t } from '../i18n.ts'
import { localUtcOffset } from '../menu/sun.ts'
import { C, D, FL, FlightRecorder, ND, NF, replayArgs, type BodyTrack, type CrashRec, type FxEvent, type RecEvent } from './FlightRecorder.ts'
import { buildGpx, buildKml, saveTextFile, type TrackInfo } from './trackExport.ts'
import { clock, ReplayUi, SPEEDS } from './ReplayUi.ts'

/** Lo que la repetición usa de la aplicación (main.ts). */
export interface ReplayHost {
  readonly gfx: Graphics
  readonly world: World | null
  readonly ac: Autogyro
  readonly view: AircraftView
  readonly rig: CameraRig
  readonly hud: Hud
  readonly crashSys: CrashSystem
  readonly sound: Sound
  readonly ctl: Controls
  readonly state: 'loading' | 'flying' | 'crashed'
  readonly menuOpen: boolean
  readonly simDate: Date
  readonly location: Location
  readonly settings: Settings
}
export interface ReplayHooks {
  /** viento en el aparato (mundo), el que mueve el hilo de guiñada */
  wind: Vector3
  toast(msg: string, secs?: number): void
}

/** Aparato que se ve en la repetición (lo que piden la vista, la cámara y la cabina). */
class ReplayAircraft {
  readonly pos = new Vector3()
  readonly quat = new Quaternion()
  readonly vel = new Vector3()
  /** velocidad angular, ejes cuerpo */
  readonly omega = new Vector3()
  readonly hubBody = new Vector3()
  readonly cgOff = new Vector3()
  readonly wind = new Vector3()
  readonly rotor = { omega: 0, rpm: 0, thrust: 0, normal: new Vector3(0, 1, 0), p: { blades: 2, radius: 4.2 } }
  headPitch = 0
  headRoll = 0
  rudder = 0
  noseSteer = 0
  engineRpm = 0
  onGround = false
  gearPos = 1
  tas = 0
  gLoad = 1
  agl = 0
  groundSpeed = 0
}

/** Cascote de Rapier visto desde CrashFx.update (solo usa rb.translation/rotation, size, color y glass). */
interface FakeChunk {
  tr: { x: number; y: number; z: number }
  rot: { x: number; y: number; z: number; w: number }
  rb: { translation(): { x: number; y: number; z: number }; rotation(): { x: number; y: number; z: number; w: number } }
  size: Vector3
  color: number
  glass: boolean
  born: number
}

interface Saved {
  rig: CameraRigState
  lights: boolean
  modelVisible: boolean
  wreckVisible: boolean
  wreckMats: Array<[Object3D, Matrix4]>
  fxVisible: boolean
  wfxVisible: boolean
}

const TAU = Math.PI * 2
const ZERO = new Vector3()
const UP = new Vector3(0, 1, 0)
const _p = new Vector3()
const _p2 = new Vector3()
const _v = new Vector3()
const _v2 = new Vector3()
const _s = new Vector3()
const _q = new Quaternion()
const _q2 = new Quaternion()
const _qt = new Quaternion()
const _m = new Matrix4()
/** de cuánto antes se vuelven a lanzar los efectos del agua al saltar a un instante (s) */
const WATER_PREROLL = 12

addStrings('es', {
  'replay.tag': 'Repetición',
  'replay.camera': 'Cámara',
  'replay.export': 'Traza',
  'replay.exit': 'Salir',
  'replay.btn': 'Repetición',
  'replay.btn.title': 'Repetición del vuelo (F4)',
  'replay.crashBtn': 'Ver repetición',
  'replay.t.start': 'Al principio (Inicio)',
  'replay.t.back': '10 s atrás (← : 5 s)',
  'replay.t.play': 'Reproducir / pausa (Espacio)',
  'replay.t.fwd': '10 s adelante (→ : 5 s)',
  'replay.t.end': 'Al final (Fin)',
  'replay.t.speed': 'Velocidad {s} (↑ ↓ · J: cámara lenta)',
  'replay.t.cam': 'Cambiar de cámara (C)',
  'replay.t.gpx': 'Descargar la traza en GPX (hora, altitud y velocidad)',
  'replay.t.kml': 'Descargar la traza en KML para Google Earth (línea hasta el suelo)',
  'replay.t.hide': 'Ocultar la barra (B)',
  'replay.t.show': 'Mostrar la barra (B)',
  'replay.t.exit': 'Salir de la repetición (Esc o F4)',
  'replay.hold.tag': 'En pausa',
  'replay.hold': '<kbd>Espacio</kbd> seguir volando',
  'replay.empty': 'Todavía no hay nada que repetir',
  'replay.open': 'Repetición · Espacio: pausa · ← →: saltar · Esc: salir',
  'replay.saved': 'Traza guardada: {name}',
  'replay.ev.takeoff': 'Despegue',
  'replay.ev.touchdown': 'Toma',
  'replay.ev.touchdownWater': 'Amerizaje',
  'replay.ev.crash': 'Accidente',
  'replay.ev.at': '{what} · {time}',
  'replay.ev.td': '{vs} ft/min · {gs} km/h',
  'replay.track': 'Traza',
  'replay.timed': 'Recorrido con hora',
  'replay.events': 'Sucesos',
  'replay.desc': 'Vuelo en el simulador Autogiro: {aircraft}, salida de {place}. {dur} grabados. Altitudes sobre el nivel del mar (las de las ruedas).',
})
addStrings('en', {
  'replay.tag': 'Replay',
  'replay.camera': 'Camera',
  'replay.export': 'Track',
  'replay.exit': 'Exit',
  'replay.btn': 'Replay',
  'replay.btn.title': 'Flight replay (F4)',
  'replay.crashBtn': 'Watch replay',
  'replay.t.start': 'To the start (Home)',
  'replay.t.back': '10 s back (← : 5 s)',
  'replay.t.play': 'Play / pause (Space)',
  'replay.t.fwd': '10 s forward (→ : 5 s)',
  'replay.t.end': 'To the end (End)',
  'replay.t.speed': 'Speed {s} (↑ ↓ · J: slow motion)',
  'replay.t.cam': 'Switch camera (C)',
  'replay.t.gpx': 'Download the track as GPX (time, altitude and speed)',
  'replay.t.kml': 'Download the track as KML for Google Earth (line down to the ground)',
  'replay.t.hide': 'Hide the bar (B)',
  'replay.t.show': 'Show the bar (B)',
  'replay.t.exit': 'Leave the replay (Esc or F4)',
  'replay.hold.tag': 'Paused',
  'replay.hold': '<kbd>Space</kbd> to keep flying',
  'replay.empty': 'Nothing to replay yet',
  'replay.open': 'Replay · Space: pause · ← →: skip · Esc: exit',
  'replay.saved': 'Track saved: {name}',
  'replay.ev.takeoff': 'Take-off',
  'replay.ev.touchdown': 'Landing',
  'replay.ev.touchdownWater': 'Water landing',
  'replay.ev.crash': 'Crash',
  'replay.ev.at': '{what} · {time}',
  'replay.ev.td': '{vs} ft/min · {gs} km/h',
  'replay.track': 'Track',
  'replay.timed': 'Timed track',
  'replay.events': 'Events',
  'replay.desc': 'Flight in the Autogiro simulator: {aircraft}, departing from {place}. {dur} recorded. Altitudes above mean sea level (at the wheels).',
})

export class Replay {
  readonly rec = new FlightRecorder()
  /** viendo la repetición */
  active = false
  /** tras salir en vuelo: la simulación sigue parada hasta pulsar Espacio */
  held = false
  private T = 0
  private playing = true
  private speed = 1
  /** paso de tiempo de la repetición en este fotograma (dt × velocidad; 0 en pausa) */
  private dts = 0
  /** canales interpolados del instante T y sus bits */
  private readonly row = new Float32Array(NF)
  private flags = 0
  private hdg = 0
  /** fecha simulada en T (el sol de la repetición) */
  private simMs = 0
  private readonly dateObj = new Date(0)
  readonly ac = new ReplayAircraft()
  private readonly vctl: Required<ViewControls> = { pitch: 0, roll: 0, yaw: 0, throttle: 0, wheelBrake: 0, prerotator: false }
  private saved: Saved | null = null
  private readonly ui: ReplayUi
  private readonly host: ReplayHost
  private readonly hooks: ReplayHooks
  // grabación
  private readonly wrow = new Float32Array(NF)
  private readonly wdrow = new Float64Array(ND)
  private lastHud: HudData | null = null
  private recAf: unknown = null
  private recWorld: World | null = null
  private lastContact = false
  private lastCrashed = false
  private crashedAt = -1
  private settledAt = -1
  private readonly qFrame = new Quaternion()
  // efectos propios de la repetición (los del vuelo se quedan como estaban)
  private fx: CrashFx | null = null
  private wfx: WaterFx | null = null
  private fxT = -Infinity
  private fxDirty = true
  private prerolling = false
  private readonly fakeChunks = new Map<BodyTrack, FakeChunk>()
  private readonly chunkList: FakeChunk[] = []
  private readonly groundCache = new Map<number, number | null>()
  private readonly gs: GroundSample = { y: 0, normal: new Vector3() }
  private groundY: number | null = null
  // espectador en tierra
  private readonly spot = new Vector3()
  private spotDirty = true
  /** al saltar en pausa: repintar el panel de la cabina */
  private repaint = false
  private muted = false
  private readonly topBtn: HTMLButtonElement
  private readonly crashBtn: HTMLButtonElement | null

  constructor(host: ReplayHost, hooks: ReplayHooks) {
    this.host = host
    this.hooks = hooks
    this.ui = new ReplayUi({
      play: () => this.togglePlay(),
      seek: (T, dragging) => this.seek(T, dragging),
      speed: (s) => this.setSpeed(s),
      jump: (s) => this.seek(this.T + s),
      start: () => this.seek(this.rec.t0),
      end: () => this.seek(this.rec.t1),
      camera: () => this.nextCamera(),
      gpx: () => this.exportTrack('gpx'),
      kml: () => this.exportTrack('kml'),
      exit: () => this.close(),
      resume: () => this.release(),
    })
    // efectos del accidente y del agua: se graban sus llamadas
    const recording = () => !this.active && !this.rec.frozen && !host.menuOpen
    const epoch = () => (host.world ? this.rec.epochOf(host.world.frame.worldToECEF) : 0)
    this.rec.tapEmitters('crash', host.crashSys.fx, recording, epoch)
    this.rec.tapEmitters('water', host.crashSys.waterFx, recording, epoch)
    this.rec.tapEmitters('audio', host.crashSys.audio, recording, epoch)
    // teclas: F4 siempre; las de la repetición, solo en ella (antes que los mandos, src/input/Input.ts)
    window.addEventListener('keydown', (e) => this.onKey(e), true)
    // botón de la barra superior (como el de las luces) y «Ver repetición» en el resumen del accidente
    this.topBtn = document.createElement('button')
    this.topBtn.id = 'btn-replay'
    this.topBtn.type = 'button'
    this.topBtn.innerHTML = '<span></span><kbd>F4</kbd>'
    this.topBtn.addEventListener('mousedown', (e) => e.preventDefault())
    this.topBtn.addEventListener('click', () => this.toggle())
    const bar = document.getElementById('topbar')
    const lights = document.getElementById('btn-lights')
    if (lights) lights.after(this.topBtn)
    else bar?.appendChild(this.topBtn)
    const row = document.querySelector('#crash .row')
    this.crashBtn = row ? document.createElement('button') : null
    if (row && this.crashBtn) {
      this.crashBtn.id = 'crash-replay'
      this.crashBtn.type = 'button'
      this.crashBtn.innerHTML = '<span></span> <kbd>F4</kbd>'
      this.crashBtn.addEventListener('click', () => this.open())
      const retry = document.getElementById('crash-retry')
      if (retry) retry.after(this.crashBtn)
      else row.appendChild(this.crashBtn)
    }
    this.relabel()
    onLangChange(() => this.relabel())
  }

  private relabel(): void {
    ;(this.topBtn.firstElementChild as HTMLElement).textContent = t('replay.btn')
    this.topBtn.title = t('replay.btn.title')
    if (this.crashBtn) (this.crashBtn.firstElementChild as HTMLElement).textContent = t('replay.crashBtn')
  }

  /** Fecha simulada del instante que se ve (posición del sol). */
  get date(): Date {
    this.dateObj.setTime(this.simMs)
    return this.dateObj
  }

  /** La física, los mandos, la hora y el viento quietos (viendo la repetición o en la pausa de después). */
  get frozen(): boolean {
    return this.active || this.held
  }

  // ---------------------------------------------------------------------------
  // Grabación (cada fotograma, al final)
  // ---------------------------------------------------------------------------
  /** Lo que acaba de pintar el HUD (main.updateHud): se graba con la muestra. */
  noteHud(hd: HudData): void {
    this.lastHud = hd
  }

  record(dt: number): void {
    const h = this.host
    const rec = this.rec
    const w = h.world
    if (this.held && (h.menuOpen || h.state !== 'flying')) this.release()
    if (this.active || this.held || rec.frozen || !w || h.menuOpen || h.state === 'loading') {
      rec.dropPending()
      this.lastHud = null
      return
    }
    const c0 = performance.now()
    const ac = h.ac
    // otro aparato o escenario: grabación nueva
    if (ac.af !== this.recAf || w !== this.recWorld) {
      this.reset()
      this.recAf = ac.af
      this.recWorld = w
    }
    if (rec.count === 0) rec.datumShift = w.mode === 'google' ? (h.location?.geoid ?? 0) : 0
    const crashed = h.state === 'crashed'
    const wreck = crashed && h.crashSys.active
    const contact = ac.onGround || ac.onWater
    const force = contact !== this.lastContact || crashed !== this.lastCrashed
    this.lastContact = contact
    this.lastCrashed = crashed
    if (rec.tick(dt, force)) {
      const hd = this.lastHud
      this.fillRow(w, wreck)
      rec.contactUpdate(contact, ac.onWater, hd?.vsFpm ?? ac.vs * 196.85, hd?.gsKmh ?? ac.groundSpeed * 3.6, crashed)
      rec.push(this.wrow, this.wdrow)
      if (hd) rec.text(hd.warnings, hd.cautions ?? [])
    }
    // accidente: restos y fin de la grabación cuando todo se ha parado
    if (crashed) {
      if (this.crashedAt < 0) {
        this.crashedAt = rec.clock
        rec.events.push({ t: rec.clock, kind: 'crash' })
      }
      if (wreck && !rec.crash) rec.beginCrash(h.crashSys.origin, w.frame.worldToECEF, h.crashSys.fx.wind)
      if (wreck && rec.crash) this.recordWreck(rec.crash)
      if (h.crashSys.settled && this.settledAt < 0) this.settledAt = rec.clock
      const t = rec.clock
      if ((this.settledAt >= 0 && t - this.settledAt > 6) || t - this.crashedAt > 45 || (!wreck && t - this.crashedAt > 3)) rec.frozen = true
    }
    this.lastHud = null
    rec.costMs += (performance.now() - c0 - rec.costMs) * 0.02
  }

  private fillRow(w: World, wreck: boolean): void {
    const h = this.host
    const ac = h.ac
    const r = this.wrow
    const d = this.wdrow
    const hd = this.lastHud
    const m = w.frame.worldToECEF
    const qf = this.qFrame.setFromRotationMatrix(m)
    _q.copy(ac.quat).premultiply(qf)
    r[C.qx] = _q.x
    r[C.qy] = _q.y
    r[C.qz] = _q.z
    r[C.qw] = _q.w
    const vec = (v: Vector3, k: number) => {
      _v.copy(v).applyQuaternion(qf)
      r[k] = _v.x
      r[k + 1] = _v.y
      r[k + 2] = _v.z
    }
    vec(ac.vel, C.vx)
    vec(ac.rotor.normal, C.nx)
    vec(this.hooks.wind, C.wx)
    r[C.ox] = ac.omega.x
    r[C.oy] = ac.omega.y
    r[C.oz] = ac.omega.z
    r[C.rotorOmega] = ac.rotor.omega
    r[C.headPitch] = ac.headPitch
    r[C.headRoll] = ac.headRoll
    r[C.rudder] = ac.rudder
    r[C.noseSteer] = ac.noseSteer
    r[C.engineRpm] = ac.engineRpm
    r[C.gearPos] = ac.gearPos
    r[C.cgx] = ac.cgOff.x
    r[C.cgy] = ac.cgOff.y
    r[C.cgz] = ac.cgOff.z
    r[C.hbx] = ac.hubBody.x
    r[C.hby] = ac.hubBody.y
    r[C.hbz] = ac.hubBody.z
    const ctl = h.ctl
    r[C.pitch] = ctl.pitch
    r[C.roll] = ctl.roll
    r[C.yaw] = ctl.yaw
    r[C.throttle] = ctl.throttle
    r[C.brake] = ctl.wheelBrake
    r[C.trim] = ctl.trim
    r[C.ias] = hd?.iasKmh ?? ac.ias * 3.6
    r[C.altFt] = hd?.altFt ?? 0
    r[C.vsFpm] = hd?.vsFpm ?? ac.vs * 196.85
    r[C.agl] = hd?.agl ?? Math.max(0, ac.agl)
    r[C.gs] = hd?.gsKmh ?? ac.groundSpeed * 3.6
    r[C.g] = hd?.g ?? ac.gLoad
    r[C.slip] = hd?.slip ?? 0
    r[C.beta] = hd?.beta ?? 0
    r[C.hdg] = hd?.heading ?? 0
    r[C.windFrom] = hd?.windFrom ?? 0
    r[C.windKt] = hd?.windKt ?? 0
    r[C.fuel] = hd?.fuel ?? 0
    r[C.fuelL] = hd?.fuelL ?? 0
    r[C.power] = ac.enginePower / Math.max(1, ac.maxPower)
    r[C.thrust] = ac.rotor.thrust
    r[C.tas] = ac.tas
    r[C.rolling] = ac.onGround ? ac.wheelRolling : 0
    r[C.teeter] = ac.rotor.teeterHit
    r[C.rough] = ac.pp.rough
    r[C.firing] = ac.pp.power
    let f = 0
    if (ac.onGround || ac.onWater) f |= FL.ground
    if (ac.onWater) f |= FL.water
    if (ctl.prerotator) f |= FL.prerot
    if (h.view.lights.on) f |= FL.lights
    if (hd?.rotorBrake ?? ctl.rotorBrake) f |= FL.rotorBrake
    if (hd?.parkBrake) f |= FL.parkBrake
    if (ac.engineOn) f |= FL.engineOn
    if (hd?.fuelLow) f |= FL.fuelLow
    if (hd?.oilLow) f |= FL.oilLow
    if (hd?.drill) f |= FL.drill
    if (hd?.gear) f |= FL.hasGear | (hd.gear === 'down' ? FL.gearDown : hd.gear === 'up' ? FL.gearUp : 0)
    if (hd?.fuel !== undefined) f |= FL.hasFuel
    if (wreck) f |= FL.wreck
    r[C.flags] = f
    d[D.sim] = h.simDate.getTime()
    _p.copy(ac.pos).applyMatrix4(m)
    d[D.px] = _p.x
    d[D.py] = _p.y
    d[D.pz] = _p.z
  }

  /** Postura de las piezas de los restos y de los cascotes (como mucho a 60 Hz, solo lo que se mueve). */
  private recordWreck(cr: CrashRec): void {
    const rec = this.rec
    const cs = this.host.crashSys
    const t = rec.clock
    if (t - cr.lastT < 1 / 60 - 1e-4) return
    cr.lastT = t
    cr.frame++
    for (const g of cs.model.root.children) {
      if (!g.name.startsWith('wreck_')) continue
      const id = g.name.slice(6)
      let tr = cr.parts.get(id)
      if (!tr) cr.parts.set(id, (tr = rec.newTrack(t)))
      g.matrix.decompose(_p, _q, _s)
      rec.body(tr, t, _p, _q, cr.origin, cr.frame)
    }
    const wr = cs.wreck
    if (wr) {
      for (const ch of wr.chunks) {
        let tr = cr.chunks.get(ch)
        if (!tr) {
          tr = rec.newTrack(t)
          tr.size = ch.size.clone()
          tr.color = ch.color
          tr.glass = ch.glass
          cr.chunks.set(ch, tr)
        }
        const p = ch.rb.translation()
        const q = ch.rb.rotation()
        _p.set(p.x + cs.origin.x, p.y + cs.origin.y, p.z + cs.origin.z)
        _q.set(q.x, q.y, q.z, q.w)
        rec.body(tr, t, _p, _q, cr.origin, cr.frame)
      }
    }
    for (const tr of cr.chunks.values()) if (tr.seen !== cr.frame && tr.gone === Infinity) tr.gone = t
  }

  /** Vuelo nuevo (salida, reinicio): fuera de la repetición sin restaurar nada y grabación desde cero. */
  reset(): void {
    if (this.active) this.close(false)
    this.release()
    this.rec.reset()
    this.crashedAt = -1
    this.settledAt = -1
    this.lastCrashed = false
    this.fakeChunks.clear()
    this.recAf = null
    this.recWorld = null
  }

  // ---------------------------------------------------------------------------
  // Entrar y salir
  // ---------------------------------------------------------------------------
  toggle(): void {
    if (this.active) this.close()
    else this.open()
  }

  /** Abre la repetición (tras un accidente, unos segundos antes del golpe). */
  open(at?: number): boolean {
    const h = this.host
    const rec = this.rec
    if (this.active) return true
    if (h.menuOpen) return false
    if (!h.world || h.state === 'loading' || rec.count < 2 || rec.t1 - rec.t0 < 1) {
      this.hooks.toast(t('replay.empty'))
      return false
    }
    this.release()
    const cs = h.crashSys
    this.saved = {
      rig: h.rig.saveState(),
      lights: h.view.lights.on,
      modelVisible: h.view.model.visible,
      wreckVisible: cs.model.root.visible,
      wreckMats: cs.model.root.children.map((o) => [o, o.matrix.clone()] as [Object3D, Matrix4]),
      fxVisible: cs.fx.root.visible,
      wfxVisible: cs.waterFx.root.visible,
    }
    // (el resumen del accidente, su aviso de cámara lenta y la nota de la toma se ocultan con la clase
    // `replaying` del body: replay.css)
    document.body.classList.add('replaying')
    cs.fx.root.visible = false
    cs.waterFx.root.visible = false
    this.active = true
    // los sonidos continuos del accidente (fuego, arrastre) se callan; al salir los vuelve a poner él
    this.quietCrash()
    this.groundCache.clear()
    const cr = rec.crash
    let T0 = rec.t1 - 30
    if (cr) T0 = cr.t0 - 10
    else {
      // la última toma, si es reciente
      const td = [...rec.events].reverse().find((e) => e.kind === 'touchdown')
      if (td && rec.t1 - td.t < 90) T0 = td.t - 15
    }
    this.T = Math.min(rec.t1, Math.max(rec.t0, at ?? T0))
    this.playing = true
    this.speed = 1
    this.fxDirty = true
    this.spotDirty = true
    this.repaint = true
    this.sample(this.T)
    this.ui.show()
    this.topBtn.classList.add('on')
    this.ui.setEvents(rec.events, (e) => this.eventLabel(e))
    this.hooks.toast(t('replay.open'), 3)
    return true
  }

  /** Sale de la repetición y deja todo como estaba (`restore` = false: vuelo nuevo, no hace falta). */
  close(restore = true): void {
    if (!this.active) return
    const h = this.host
    const s = this.saved
    this.active = false
    document.body.classList.remove('replaying')
    this.ui.hide()
    this.topBtn.classList.remove('on')
    this.fx?.clear()
    this.wfx?.clear()
    this.quietCrash()
    if (this.fx) this.fx.root.visible = false
    if (this.wfx) this.wfx.root.visible = false
    if (this.muted) {
      h.sound.start()
      this.muted = false
    }
    if (restore && s) {
      const cs = h.crashSys
      h.rig.restoreState(s.rig)
      h.view.lights.on = s.lights
      h.view.model.visible = s.modelVisible
      cs.model.root.visible = s.wreckVisible
      for (const [o, mat] of s.wreckMats) {
        o.matrix.copy(mat)
        o.matrixWorldNeedsUpdate = true
      }
      cs.fx.root.visible = s.fxVisible
      cs.waterFx.root.visible = s.wfxVisible
      // en vuelo, la simulación sigue parada hasta que se pulse Espacio (para no salir de golpe)
      if (h.state === 'flying' && !h.menuOpen) {
        this.held = true
        this.ui.setHold(true)
      }
    }
    this.saved = null
  }

  private quietCrash(): void {
    const a = this.host.crashSys.audio
    a.setFire(0, 1e4)
    a.setScrape(0, 0, 1e4, false)
    a.setTumble(0, 1e4)
  }

  /** Fin de la pausa de después de la repetición. */
  release(): void {
    if (!this.held) return
    this.held = false
    this.ui.setHold(false)
  }

  // ---------------------------------------------------------------------------
  // Mandos de la repetición
  // ---------------------------------------------------------------------------
  private onKey(e: KeyboardEvent): void {
    const tg = e.target as HTMLElement | null
    if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.isContentEditable || tg.closest?.('select'))) return
    const stop = () => {
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    if (e.code === 'F4') {
      stop()
      if (!e.repeat && !this.host.menuOpen) this.toggle()
      return
    }
    if (this.held && e.code === 'Space') {
      stop()
      this.release()
      return
    }
    if (!this.active || e.ctrlKey || e.altKey || e.metaKey) return
    const i = SPEEDS.indexOf(this.speed)
    switch (e.code) {
      case 'Space':
        if (!e.repeat) this.togglePlay()
        break
      case 'ArrowLeft':
        this.seek(this.T - (e.shiftKey ? 1 : 5))
        break
      case 'ArrowRight':
        this.seek(this.T + (e.shiftKey ? 1 : 5))
        break
      case 'ArrowUp':
        this.setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, i + 1)])
        break
      case 'ArrowDown':
        this.setSpeed(SPEEDS[Math.max(0, i - 1)])
        break
      case 'Home':
        this.seek(this.rec.t0)
        break
      case 'End':
        this.seek(this.rec.t1)
        break
      case 'Comma':
      case 'Period':
        // fotograma a fotograma (en pausa)
        this.playing = false
        this.seek(this.T + (e.code === 'Comma' ? -1 : 1) / 30)
        break
      case 'KeyJ':
        // cámara lenta, como tras un accidente
        if (!e.repeat) this.setSpeed(this.speed < 1 ? 1 : 0.25)
        break
      case 'KeyB':
        if (!e.repeat) this.ui.toggleBar()
        break
      default:
        return
    }
    stop()
  }

  /**
   * Acciones de Input durante la repetición: la cámara, Esc (salir) y las de ver (ayuda, instrumentos,
   * telemetría, zoom) siguen; las de pilotar no hacen nada. Devuelve true si la ha consumido.
   */
  action(a: string): boolean {
    switch (a) {
      case 'camera':
        this.nextCamera()
        return true
      case 'pause':
        this.close()
        return true
      case 'cameraBack':
      case 'help':
      case 'hud':
      case 'telemetry':
      case 'zoomIn':
      case 'zoomOut':
        return false
      default:
        return true
    }
  }

  private togglePlay(): void {
    if (!this.playing && this.T >= this.rec.t1 - 1e-3) this.seek(this.rec.t0)
    this.playing = !this.playing
  }

  private setSpeed(s: number): void {
    this.speed = s
    if (!this.playing) this.playing = true
  }

  private seek(T: number, dragging = false): void {
    const rec = this.rec
    const nt = Math.min(rec.t1, Math.max(rec.t0, T))
    if (Math.abs(nt - this.T) > 0.4 || nt < this.fxT - 1e-6) this.fxDirty = true
    this.T = nt
    this.spotDirty = true
    this.repaint = true
    void dragging
  }

  private nextCamera(): void {
    const h = this.host
    const m = h.rig.next(this.ac as unknown as Autogyro, this.groundY ?? this.ac.pos.y - 2)
    if (m === 'tower') this.spotDirty = true
    this.hooks.toast(t('toast.camera', { name: camName(m) }))
  }

  // ---------------------------------------------------------------------------
  // Cada fotograma con la repetición
  // ---------------------------------------------------------------------------
  update(dt: number): void {
    const h = this.host
    const rec = this.rec
    if (h.menuOpen || !h.world || h.state === 'loading' || rec.count < 2) {
      this.close()
      return
    }
    if (this.playing && !this.ui.dragging) {
      this.T += dt * this.speed
      if (this.T >= rec.t1) {
        this.T = rec.t1
        this.playing = false
      }
    }
    const sp = this.playing && !this.ui.dragging ? this.speed : 0
    this.dts = dt * sp
    // en pausa, sin sonido (como un vídeo)
    if (sp === 0 && !this.muted) {
      h.sound.suspend()
      this.muted = true
    } else if (sp > 0 && this.muted) {
      h.sound.start()
      this.muted = false
    }
    this.sample(this.T)
    const w = h.world
    const a = this.ac
    this.groundY = w.sampleGround(a.pos.x, a.pos.z, a.pos.y + 60, this.gs, a.pos.y) ? this.gs.y : null
    h.view.lights.on = (this.flags & FL.lights) !== 0
    // el aparato entero o, desde el golpe, los restos
    const cr = rec.crash
    const cs = h.crashSys
    const wreckOn = Boolean(cr && this.T >= cr.t0 && cs.active)
    h.view.model.visible = !wreckOn
    cs.model.root.visible = wreckOn
    h.view.update(a, this.dts, this.vctl)
    if (wreckOn && cr) {
      const M = this.epochMatrix(cr.epoch)
      _q2.setFromRotationMatrix(M)
      cs.model.update(0, (id, pos, quat) => this.bodyPose(cr.parts.get(id), this.T, cr.origin, M, pos, quat))
    }
    this.updateFx()
    this.ui.setEvents(rec.events, (e) => this.eventLabel(e))
    this.ui.update({
      T: this.T,
      t0: rec.t0,
      t1: rec.t1,
      playing: this.playing,
      speed: this.speed,
      cam: camName(h.rig.mode),
      bottom: this.barBottom(),
    })
  }

  /** Encima del panel de relojes del HUD (misma medida que Hud.draw), o abajo del todo si está oculto. */
  private barBottom(): number {
    if (!this.host.hud.visible) return 14
    const W = window.innerWidth
    const size = Math.max(92, Math.min(148, (W - 120) / 7.2))
    return Math.round(size + 40)
  }

  /** Marco del mundo de un suceso → el de ahora. */
  private epochMatrix(e: number): Matrix4 {
    const w = this.host.world!
    const ep = this.rec.epochs[e]
    return ep ? _m.multiplyMatrices(w.frame.ecefToWorld, ep) : _m.identity()
  }

  /** Postura grabada de un sólido de los restos en T (mundo). */
  private bodyPose(tr: BodyTrack | undefined, T: number, origin: Vector3, M: Matrix4, pos: Vector3, quat: Quaternion): boolean {
    if (!tr || !tr.t.length) return false
    const tt = tr.t
    const d = tr.d
    let i = 0
    let s = 0
    if (T >= tt[tt.length - 1]) i = tt.length - 1
    else if (T > tt[0]) {
      let lo = 0
      let hi = tt.length - 1
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1
        if (tt[mid] <= T) lo = mid
        else hi = mid
      }
      i = lo
      s = (T - tt[lo]) / Math.max(1e-6, tt[hi] - tt[lo])
    }
    const o = i * 7
    pos.set(d[o], d[o + 1], d[o + 2])
    quat.set(d[o + 3], d[o + 4], d[o + 5], d[o + 6])
    if (s > 0) {
      const o2 = o + 7
      pos.lerp(_v2.set(d[o2], d[o2 + 1], d[o2 + 2]), s)
      quat.slerp(_qt.set(d[o2 + 3], d[o2 + 4], d[o2 + 5], d[o2 + 6]), s)
    }
    pos.add(origin).applyMatrix4(M)
    quat.premultiply(_q2)
    return true
  }

  /** Interpola la grabación en T: aparato (posición con Hermite: velocidad en los extremos), mandos e instrumentos. */
  private sample(T: number): void {
    const rec = this.rec
    const h = this.host
    const w = h.world!
    const i = rec.find(T)
    const j = Math.min(rec.end - 1, i + 1)
    const [fa, oa] = rec.row(i)
    const [fb, ob] = rec.row(j)
    const [da, pa] = rec.drow(i)
    const [db, pb] = rec.drow(j)
    const ta = da[pa + D.t]
    const span = db[pb + D.t] - ta
    const s = span > 1e-6 ? Math.min(1, Math.max(0, (T - ta) / span)) : 0
    const r = this.row
    for (let k = 0; k < NF; k++) r[k] = fa[oa + k] + (fb[ob + k] - fa[oa + k]) * s
    this.flags = (s < 0.5 ? fa[oa + C.flags] : fb[ob + C.flags]) | 0
    this.simMs = da[pa + D.sim] + (db[pb + D.sim] - da[pa + D.sim]) * s
    // rumbo: por el lado corto
    const h0 = fa[oa + C.hdg]
    let dh = fb[ob + C.hdg] - h0
    dh -= 360 * Math.round(dh / 360)
    this.hdg = (((h0 + dh * s) % 360) + 360) % 360
    const qE2W = _q2.setFromRotationMatrix(w.frame.ecefToWorld)
    const a = this.ac
    // orientación
    _q.set(fa[oa + C.qx], fa[oa + C.qy], fa[oa + C.qz], fa[oa + C.qw])
    a.quat.set(fb[ob + C.qx], fb[ob + C.qy], fb[ob + C.qz], fb[ob + C.qw])
    a.quat.copy(_q.slerp(a.quat, s)).premultiply(qE2W)
    // posición (ECEF, doble precisión)
    const s2 = s * s
    const s3 = s2 * s
    const h00 = 2 * s3 - 3 * s2 + 1
    const h10 = s3 - 2 * s2 + s
    const h01 = -2 * s3 + 3 * s2
    const h11 = s3 - s2
    const hv = (k: number, kv: number) => h00 * da[pa + k] + h10 * span * fa[oa + kv] + h01 * db[pb + k] + h11 * span * fb[ob + kv]
    a.pos.set(hv(D.px, C.vx), hv(D.py, C.vy), hv(D.pz, C.vz)).applyMatrix4(w.frame.ecefToWorld)
    a.vel.set(r[C.vx], r[C.vy], r[C.vz]).applyQuaternion(qE2W)
    a.rotor.normal.set(r[C.nx], r[C.ny], r[C.nz]).applyQuaternion(qE2W).normalize()
    a.wind.set(r[C.wx], r[C.wy], r[C.wz]).applyQuaternion(qE2W)
    a.omega.set(r[C.ox], r[C.oy], r[C.oz])
    a.rotor.omega = r[C.rotorOmega]
    a.rotor.rpm = (a.rotor.omega * 60) / TAU
    a.rotor.thrust = r[C.thrust]
    a.rotor.p.blades = h.ac.af.rotor.blades
    a.rotor.p.radius = h.ac.af.rotor.radius
    a.headPitch = r[C.headPitch]
    a.headRoll = r[C.headRoll]
    a.rudder = r[C.rudder]
    a.noseSteer = r[C.noseSteer]
    a.engineRpm = r[C.engineRpm]
    a.gearPos = r[C.gearPos]
    a.cgOff.set(r[C.cgx], r[C.cgy], r[C.cgz])
    a.hubBody.set(r[C.hbx], r[C.hby], r[C.hbz])
    a.onGround = (this.flags & FL.ground) !== 0
    a.tas = r[C.tas]
    a.gLoad = r[C.g]
    a.agl = r[C.agl]
    a.groundSpeed = r[C.gs] / 3.6
    const c = this.vctl
    c.pitch = r[C.pitch]
    c.roll = r[C.roll]
    c.yaw = r[C.yaw]
    c.throttle = r[C.throttle]
    c.wheelBrake = r[C.brake]
    c.prerotator = (this.flags & FL.prerot) !== 0
  }

  /** Posición y velocidad grabadas en T (mundo), para colocar al espectador. */
  private posVelAt(T: number, pos: Vector3, vel: Vector3): void {
    const rec = this.rec
    const w = this.host.world!
    const i = rec.find(T)
    const [d, o] = rec.drow(i)
    const [f, fo] = rec.row(i)
    pos.set(d[o + D.px], d[o + D.py], d[o + D.pz]).applyMatrix4(w.frame.ecefToWorld)
    vel.set(f[fo + C.vx], f[fo + C.vy], f[fo + C.vz]).applyQuaternion(_q.setFromRotationMatrix(w.frame.ecefToWorld))
  }

  // ---------------------------------------------------------------------------
  // Cámara
  // ---------------------------------------------------------------------------
  camera(dt: number, dragging: boolean): void {
    const h = this.host
    const cam = h.gfx.camera.position
    const gy = this.groundAt(cam.x, cam.z, cam.y) ?? -1e6
    h.rig.timeScale = this.playing ? this.speed : 0
    if (h.rig.mode === 'tower') this.updateSpectator()
    h.rig.update(dt, this.ac as unknown as Autogyro, h.view, gy, dragging)
  }

  /**
   * Espectador en tierra («Desde tierra»): de pie (1,7 m) a un lado de la trayectoria, con el sol a la
   * espalda, donde va a pasar el aparato: junto a la toma, el despegue o el accidente si llegan en los
   * próximos 25 s, y si no, donde estará dentro de unos segundos. Se cambia de sitio cuando el aparato
   * se aleja.
   */
  private updateSpectator(): void {
    const a = this.ac
    if (!this.spotDirty) {
      const d = a.pos.distanceTo(this.spot)
      const away = _v.subVectors(a.pos, this.spot).dot(a.vel) > 0
      if (!(d > 420 && away) && d < 2500) return
    }
    this.spotDirty = false
    const rec = this.rec
    const T = this.T
    const ev = rec.events.find((e) => e.t > T + 1.5 && e.t < T + 25)
    const ta = ev ? ev.t : Math.min(rec.t1, T + 6)
    this.posVelAt(ta, _p, _v)
    const fwd = _v2.set(_v.x, 0, _v.z)
    const speed = fwd.length()
    if (speed < 1) fwd.set(1, 0, 0).applyQuaternion(a.quat).setY(0)
    fwd.normalize()
    const side = new Vector3().crossVectors(fwd, UP).normalize()
    const sun = this.host.gfx.sunDirWorld
    if (side.dot(sun) < 0) side.negate()
    const dist = Math.min(70, Math.max(28, 18 + speed * 0.9))
    // un poco por delante del punto, para verlo llegar y pasar
    _p2.copy(_p).addScaledVector(side, dist).addScaledVector(fwd, ev ? Math.min(60, speed * 0.8) : 0)
    const gy = this.groundAt(_p2.x, _p2.z, _p.y) ?? _p.y - 2
    _p2.y = gy + 1.7
    this.spot.copy(_p2)
    this.host.rig.setTower(this.spot)
  }

  /** Altura del suelo (con caché de 0,5 m mientras dura la repetición). */
  private groundAt(x: number, z: number, yHint: number): number | null {
    const k = Math.round(x * 2) * 1e7 + Math.round(z * 2)
    const c = this.groundCache.get(k)
    if (c !== undefined) return c
    const w = this.host.world
    const y = w && w.sampleGround(x, z, yHint + 500, this.gs2) ? this.gs2.y : null
    if (this.groundCache.size > 20000) this.groundCache.clear()
    this.groundCache.set(k, y)
    return y
  }
  private readonly gs2: GroundSample = { y: 0, normal: new Vector3() }

  // ---------------------------------------------------------------------------
  // Luz, instrumentos y sonido
  // ---------------------------------------------------------------------------
  updateGfx(): void {
    const h = this.host
    const w = h.world!
    const a = this.ac
    h.gfx.update(w.frame.worldToECEF, a.pos, this.groundY, this.groundY !== null ? this.gs.normal : UP, a.agl)
  }

  updateHud(dt: number): void {
    const h = this.host
    const ac = h.ac
    const r = this.row
    const f = this.flags
    const a = this.ac
    const wreck = (f & FL.wreck) !== 0
    const txt = this.rec.textAt(this.T)
    const hd: HudData = {
      iasKmh: r[C.ias],
      altFt: r[C.altFt],
      vsFpm: r[C.vsFpm],
      rotorRpm: a.rotor.rpm,
      engineRpm: f & FL.engineOn || a.engineRpm > 50 ? a.engineRpm : 0,
      heading: this.hdg,
      slip: r[C.slip],
      trim: r[C.trim],
      throttle: r[C.throttle],
      g: r[C.g],
      agl: r[C.agl],
      gsKmh: r[C.gs],
      windFrom: r[C.windFrom],
      windKt: r[C.windKt],
      warnings: wreck ? [] : (txt?.warnings ?? []),
      cautions: wreck ? [] : (txt?.cautions ?? []),
      fuel: f & FL.hasFuel ? r[C.fuel] : undefined,
      fuelL: f & FL.hasFuel ? r[C.fuelL] : undefined,
      fuelLow: (f & FL.fuelLow) !== 0,
      oilLow: (f & FL.oilLow) !== 0,
      drill: (f & FL.drill) !== 0,
      prerot: (f & FL.prerot) !== 0,
      rotorBrake: (f & FL.rotorBrake) !== 0,
      parkBrake: (f & FL.parkBrake) !== 0,
      engineOn: (f & FL.engineOn) !== 0,
      camName: camName(h.rig.mode),
      onGround: (f & FL.ground) !== 0,
      stickPitch: this.vctl.pitch,
      stickRoll: this.vctl.roll,
      pedals: this.vctl.yaw,
      mouseStick: false,
      wheelThrottle: false,
      beta: r[C.beta],
      cockpit: h.rig.mode === 'cockpit',
      hint: '',
      rpmScale: ac.rpmScale,
      rpmWarn: ac.rpmWarnScale,
      rotorArcs: ac.af.slowedRotor ? { green: [100, 380], red: 400 } : undefined,
      tach: ac.af.engine.tach,
      gear: f & FL.hasGear ? (f & FL.gearDown ? 'down' : f & FL.gearUp ? 'up' : 'moving') : undefined,
    }
    const canvas = document.getElementById('hud') as HTMLCanvasElement | null
    if (canvas && canvas.style.opacity !== '1') canvas.style.opacity = '1'
    h.hud.draw(hd, dt)
    const cam = h.gfx.camera.position
    const near = h.rig.mode === 'cockpit' || cam.distanceTo(a.pos) < 6
    // (en pausa el hilo de guiñada se queda quieto; tras un salto se repinta el panel)
    const cdt = this.dts > 0 ? this.dts : this.repaint ? 0.051 : 0
    this.repaint = false
    h.view.cockpit.update(cdt, a, a.wind, cam, h.hud, hd, near)
  }

  soundState(): SoundState {
    const h = this.host
    const ac = h.ac
    const r = this.row
    const f = this.flags
    const a = this.ac
    const af = ac.af
    return {
      engineRpm: a.engineRpm,
      power: r[C.power],
      rotorRpm: a.rotor.rpm,
      rotorLoad: r[C.thrust] / (ac.mass * 9.81),
      tas: r[C.tas],
      rolling: r[C.rolling],
      prerot: (f & FL.prerot) !== 0 && (f & FL.engineOn) !== 0,
      lowRotor: !(f & (FL.ground | FL.wreck)) && a.rotor.rpm < 260 * ac.rpmWarnScale,
      teeterHit: r[C.teeter],
      cockpit: h.rig.mode === 'cockpit',
      distance: h.gfx.camera.position.distanceTo(a.pos),
      engineOn: (f & FL.engineOn) !== 0,
      misfire: r[C.rough],
      firing: r[C.firing],
      voice: {
        cylinders: af.engine.cylinders,
        gear: af.engine.gear,
        propBlades: af.propBlades ?? 3,
        rotorBlades: af.rotor.blades,
        rpmMax: af.engine.tach.green[1],
        rotorRpm: 380 * ac.rpmScale,
      },
    }
  }

  // ---------------------------------------------------------------------------
  // Efectos: se vuelven a lanzar las llamadas grabadas sobre unos efectos propios
  // ---------------------------------------------------------------------------
  private ensureFx(): void {
    const g = this.host.gfx
    const lights = { sun: g.sunLight, sky: g.skyLight }
    if (!this.fx) {
      this.fx = new CrashFx()
      g.scene.add(this.fx.root)
    }
    if (!this.wfx) {
      this.wfx = new WaterFx(g.scene, lights)
      // el ruido de los chapoteos, por el sonido de los accidentes (no al rebobinar)
      this.wfx.sound = (strength, p) => {
        if (!this.prerolling) this.host.crashSys.audio.impact('water', strength, g.camera.position.distanceTo(p), 'water')
      }
    }
    this.fx.root.visible = true
    this.wfx.root.visible = true
  }

  private updateFx(): void {
    const rec = this.rec
    if (!rec.fx.length && !rec.crash) return
    this.ensureFx()
    if (this.fxDirty) {
      if (this.ui.dragging) {
        // arrastrando la barra: sin efectos hasta soltarla
        this.fx!.clear()
        this.wfx!.clear()
        this.fxT = this.T
        return
      }
      this.fxDirty = false
      this.preroll()
      return
    }
    if (this.T < this.fxT - 1e-6) {
      this.fxDirty = true
      return
    }
    this.emit(this.fxT, this.T)
    this.fxT = this.T
    this.stepFx(this.dts, this.T)
  }

  /** Efectos al saltar a un instante: se lanzan los de antes (todo el accidente; ~12 s en el agua) y se adelantan. */
  private preroll(): void {
    const rec = this.rec
    const T = this.T
    this.fx!.clear()
    this.wfx!.clear()
    let from = T - WATER_PREROLL
    const cr = rec.crash
    if (cr && T >= cr.t0) from = Math.min(from, cr.t0 - 0.05)
    from = Math.max(rec.t0, from)
    const steps = Math.min(160, Math.ceil((T - from) / 0.1))
    this.fxT = from
    this.prerolling = true
    for (let k = 1; k <= steps; k++) {
      const next = from + ((T - from) * k) / steps
      this.emit(this.fxT, next)
      this.stepFx(next - this.fxT, next)
      this.fxT = next
    }
    this.prerolling = false
    this.fxT = T
  }

  /** Sucesos de efectos en (a, b]. */
  private emit(a: number, b: number): void {
    const list = this.rec.fx
    if (!list.length || b <= a) return
    let lo = 0
    let hi = list.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (list[mid].t <= a) lo = mid + 1
      else hi = mid
    }
    let lastEpoch = -1
    for (let k = lo; k < list.length && list[k].t <= b; k++) {
      const e = list[k]
      if (e.epoch !== lastEpoch) {
        lastEpoch = e.epoch
        _q2.setFromRotationMatrix(this.epochMatrix(e.epoch))
      }
      this.fire(e, _m, _q2)
    }
  }

  private fire(e: FxEvent, M: Matrix4, rot: Quaternion): void {
    // sonidos: solo reproduciendo (no al rebobinar), a la distancia de la cámara de la repetición
    if (e.target === 'audio' && (this.prerolling || this.dts <= 0)) return
    const target = (e.target === 'crash' ? this.fx : e.target === 'water' ? this.wfx : this.host.crashSys.audio) as unknown as Record<string, (...a: unknown[]) => void> | null
    const fn = target?.[e.fn]
    if (!fn) return
    const args = replayArgs(e, M, rot, this.host.gfx.camera.position.distanceTo(this.ac.pos))
    // (los colores se copian: algunos emisores los modifican)
    for (let i = 0; i < args.length; i++) if (args[i] instanceof Color) args[i] = (args[i] as Color).clone()
    fn.apply(target, args)
  }

  private stepFx(dt: number, T: number): void {
    const h = this.host
    if (dt <= 0) return
    const cr = this.rec.crash
    const fx = this.fx!
    if (cr) {
      fx.wind.copy(cr.wind)
      const sun = h.gfx.sunLight
      const sky = h.gfx.skyLight
      const sunDir = _v.copy(sun.position).sub(sun.target.position).normalize()
      const sunIrr = new Vector3(sun.color.r, sun.color.g, sun.color.b).multiplyScalar(sun.intensity * Math.max(0, 0.35 + 0.65 * sunDir.y))
      const skyIrr = sky.sh.getIrradianceAt(UP, new Vector3()).multiplyScalar(sky.intensity)
      fx.setLight(sunIrr, skyIrr)
    }
    const chunks = cr && T >= cr.t0 ? this.chunksAt(cr, T) : []
    fx.update(dt, h.gfx.camera, chunks as unknown as Chunk[], ZERO, (x, z) => this.groundAt(x, z, this.ac.pos.y))
    this.wfx!.update(dt, this.ac.wind)
  }

  /** Cascotes que existían en T, en su postura grabada. */
  private chunksAt(cr: CrashRec, T: number): FakeChunk[] {
    const out = this.chunkList
    out.length = 0
    const M = this.epochMatrix(cr.epoch)
    _q2.setFromRotationMatrix(M)
    for (const tr of cr.chunks.values()) {
      if (T < tr.born || T >= tr.gone) continue
      let fc = this.fakeChunks.get(tr)
      if (!fc) {
        const c: FakeChunk = {
          tr: { x: 0, y: 0, z: 0 },
          rot: { x: 0, y: 0, z: 0, w: 1 },
          rb: { translation: () => c.tr, rotation: () => c.rot },
          size: tr.size ?? new Vector3(0.1, 0.1, 0.1),
          color: tr.color ?? 0x9c958b,
          glass: tr.glass ?? false,
          born: tr.born,
        }
        fc = c
        this.fakeChunks.set(tr, fc)
      }
      this.bodyPose(tr, T, cr.origin, M, _p, _q)
      fc.tr.x = _p.x
      fc.tr.y = _p.y
      fc.tr.z = _p.z
      fc.rot.x = _q.x
      fc.rot.y = _q.y
      fc.rot.z = _q.z
      fc.rot.w = _q.w
      out.push(fc)
    }
    return out
  }

  // ---------------------------------------------------------------------------
  // Traza
  // ---------------------------------------------------------------------------
  private eventName(e: RecEvent): string {
    return t(e.kind === 'touchdown' && e.water ? 'replay.ev.touchdownWater' : `replay.ev.${e.kind}`)
  }
  private eventDesc(e: RecEvent): string {
    return e.kind === 'touchdown' && e.vs !== undefined ? t('replay.ev.td', { vs: Math.round(e.vs), gs: Math.round(e.gs ?? 0) }) : ''
  }
  private eventLabel(e: RecEvent): string {
    const d = this.eventDesc(e)
    return t('replay.ev.at', { what: this.eventName(e), time: clock(e.t - this.rec.t0) }) + (d ? ` · ${d}` : '')
  }

  private exportTrack(kind: 'gpx' | 'kml'): void {
    const h = this.host
    const rec = this.rec
    if (rec.count < 2) return
    const place = h.location ? locationName(h.location) : ''
    const acName = aircraftName(aircraftById(h.settings.aircraft))
    const info: TrackInfo = {
      name: `${place} · ${acName}`,
      desc: t('replay.desc', { aircraft: acName, place, dur: clock(rec.t1 - rec.t0) }),
      eventName: (e) => this.eventName(e),
      eventDesc: (e) => this.eventDesc(e),
    }
    const text = kind === 'gpx' ? buildGpx(rec, info) : buildKml(rec, info, { track: t('replay.track'), timed: t('replay.timed'), events: t('replay.events') })
    // nombre: lugar y hora local de la salida (la del simulador)
    const [d0, o0] = rec.drow(rec.start)
    const loc = h.location
    const tz = loc ? localUtcOffset(loc.lat, loc.lon, h.settings.dayOfYear) : 0
    const when = new Date(d0[o0 + D.sim] + tz * 3600e3)
    const stamp = `${when.getUTCFullYear()}${String(when.getUTCMonth() + 1).padStart(2, '0')}${String(when.getUTCDate()).padStart(2, '0')}-${String(when.getUTCHours()).padStart(2, '0')}${String(when.getUTCMinutes()).padStart(2, '0')}`
    const slug =
      place
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^A-Za-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40) || 'vuelo'
    const name = `autogiro-${slug}-${stamp}.${kind}`
    saveTextFile(name, kind === 'gpx' ? 'application/gpx+xml' : 'application/vnd.google-earth.kml+xml', text)
    this.hooks.toast(t('replay.saved', { name }), 3.5)
  }

  /** Datos para las pruebas y la telemetría: muestras, minutos, memoria y coste. */
  stats(): { samples: number; minutes: number; mb: number; ms: number; fx: number; events: number } {
    const r = this.rec
    return { samples: r.count, minutes: (r.t1 - r.t0) / 60, mb: r.bytes / 1048576, ms: r.costMs, fx: r.fx.length, events: r.events.length }
  }
}
