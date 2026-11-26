// Tráfico aéreo de los aeródromos, en el juego: busca las pistas cercanas al jugador, monta en cada
// una su tráfico simulado (sim.ts: modelo de vuelo completo + piloto) y lo dibuja, lo hace sonar,
// enseña sus llamadas de radio y detecta los choques con el aparato del jugador.
//
// Cada aeródromo se simula en su propio plano local (un GeoFrame con el origen en el centro de la
// pista): el origen del mundo se mueve con el jugador y el tráfico no tiene que enterarse.

import { Matrix4, Quaternion, Vector3, type Camera, type Object3D, type Texture } from 'three'
import { AircraftView, type AircraftPose } from '../aircraft/AircraftView.ts'
import { DistantDetail } from '../aircraft/DistantDetail.ts'
import { aircraftById, aircraftUrl } from '../aircraft/catalog.ts'
import type { GroundBeam } from '../render/LandingLightEffect.ts'
import type { Autogyro } from '../sim/autogyro.ts'
import type { LocalAir, WindSettings } from '../sim/atmosphere.ts'
import { AIRFRAMES } from '../sim/airframes.ts'
import { lemtRunwayFor } from '../school/site.ts'
import { GeoFrame } from '../world/GeoFrame.ts'
import type { World } from '../world/World.ts'
import type { WindField } from '../world/WindField.ts'
import { Shape, shapeOf, shapesHit } from '../net/Multiplayer.ts'
import { t } from '../i18n.ts'
import { Airfield, type Pt, type RawAirfield } from './airfield.ts'
import { AI_FLEET } from './fleet.ts'
import { fetchAirfield, radioName, registrationPrefix } from './osm.ts'
import { CIRCUIT_WIDTH, type TrafficAircraft } from './pilot.ts'
import { radioText } from './radioText.ts'
import { AirTrafficSim, type Density, type GroundHit, type RadioMsg, type SimHost } from './sim.ts'
import { TrafficSound, type VoiceState } from './TrafficSound.ts'
import './airtraffic.css'

const RPM_TO_RAD = Math.PI / 30
/** aeródromos con tráfico a la vez: el del jugador y el siguiente más cercano */
const MAX_SITES = 2
/** se monta el tráfico de una pista a menos de esto del jugador (m) y se quita al alejarse */
const SITE_NEAR = 7000
const SITE_FAR = 10000
/** pistas de aeródromo de autogiros y ultraligeros, no de aeropuerto (m) */
const RWY_MIN = 280
const RWY_MAX = 1700
/** más allá no se dibuja un autogiro (ocupa menos de un píxel) */
const DRAW_FAR = 6500

export interface AirTrafficHooks {
  scene: Object3D
  /** choque del jugador con un aparato del tráfico */
  collide(title: string, detail: string): void
}

export interface AirTrafficFrame {
  world: World | null
  camera: Camera
  player: Autogyro
  /** el jugador está volando (no cargando ni accidentado) */
  flying: boolean
  /** el tiempo corre (ni menú ni repetición) */
  running: boolean
  enabled: boolean
  density: Density
  wind: WindSettings
  windField: WindField | null
  simMs: number
  rho: number
  /** de día y con tiempo para volar a la vista */
  vfr: boolean
  exposure: number
  sunY: number
  audio: { ctx: AudioContext; node: AudioNode } | null
  cockpit: boolean
}

/** Pose de un aparato del tráfico en el mundo, con la forma que espera AircraftView. */
class WorldPose implements AircraftPose {
  readonly pos = new Vector3()
  readonly quat = new Quaternion()
  readonly vel = new Vector3()
  readonly hubBody = new Vector3(-0.25, 1.7, 0)
  readonly rotor = {
    omega: 0,
    normal: new Vector3(0, 1, 0),
    get rpm(): number {
      return this.omega / RPM_TO_RAD
    },
  }
  headPitch = 0
  headRoll = 0
  rudder = 0
  noseSteer = 0
  engineRpm = 0
  onGround = true
}

interface Drawn {
  view: AircraftView
  /** piezas que de lejos no llegan a un píxel (aircraft/DistantDetail.ts) */
  detail: DistantDetail
  pose: WorldPose
  distance: number
  prevDistance: number
  /** restos cayendo tras un choque: velocidad (local) y giro */
  fall: { vel: Vector3; spin: Vector3; down: boolean } | null
}

const _m = new Matrix4()
const _mi = new Matrix4()
const _q = new Quaternion()
const _qi = new Quaternion()
const _p = new Vector3()
const _v = new Vector3()
const _s = { y: 0, normal: new Vector3() }
const _mine = new Shape()
const _theirs = new Shape()

/** Un aeródromo con su tráfico. */
class Site {
  readonly frame = new GeoFrame()
  sim: AirTrafficSim | null = null
  state: 'fetching' | 'checking' | 'ready' | 'none' = 'fetching'
  raw: RawAirfield | null = null
  age = 0
  readonly drawn = new Map<number, Drawn>()
  /** local → mundo y su inversa, del fotograma */
  readonly toWorld = new Matrix4()
  readonly toLocal = new Matrix4()
  readonly qToWorld = new Quaternion()
  readonly abort = new AbortController()
  private checkT = 0

  readonly key: string
  readonly lat: number
  readonly lon: number

  constructor(key: string, lat: number, lon: number) {
    this.key = key
    this.lat = lat
    this.lon = lon
    this.frame.setOrigin(lat, lon, 0)
  }

  sync(w: World): void {
    this.toWorld.multiplyMatrices(w.frame.ecefToWorld, this.frame.worldToECEF)
    this.toLocal.copy(this.toWorld).invert()
    this.qToWorld.setFromRotationMatrix(this.toWorld)
  }

  /** (lat, lon) → metros del plano local */
  local(lat: number, lon: number): Pt {
    this.frame.geoToWorld(lat, lon, 0, _p)
    return { x: _p.x, z: _p.z }
  }

  /** Suelo en el plano local, del relieve del juego. */
  ground(w: World, x: number, z: number, out: GroundHit): boolean {
    _p.set(x, 0, z).applyMatrix4(this.toWorld)
    if (!w.sampleGround(_p.x, _p.z, 9000, _s)) return false
    _p.y = _s.y
    out.y = _p.applyMatrix4(this.toLocal).y
    out.normal.copy(_s.normal)
    return true
  }

  /**
   * ¿Se puede volar el circuito a este lado sin que el relieve estorbe? Muestrea el suelo bajo el
   * viento en cola, la base y las prolongaciones de la pista. null: aún no hay relieve cargado.
   */
  circuitClear(w: World, f: Airfield, dirIdx: 0 | 1): boolean | null {
    const r = f.dirs[dirIdx]
    const hit: GroundHit = { y: 0, normal: new Vector3() }
    if (!this.ground(w, r.px(r.displaced, 0), r.pz(r.displaced, 0), hit)) return null
    const y0 = hit.y
    const L = r.total - r.displaced
    const W = CIRCUIT_WIDTH * r.side
    for (let s = -1100; s <= Math.min(L, 900) + 900; s += 150) {
      for (const [d, lim] of [
        [W, r.H - 70],
        [W * 0.5, r.H * 0.45],
        // (la propia pista puede subir unos metros de un extremo a otro)
        [0, s < 0 ? 15 + -s * 0.05 : s > L ? 15 + (s - L) * 0.05 : 1e9],
      ] as [number, number][]) {
        if (!this.ground(w, r.px(r.displaced + s, d), r.pz(r.displaced + s, d), hit)) return null
        if (hit.y - y0 > lim) return false
      }
    }
    return true
  }

  /** Cuando ya hay relieve: decide el lado del circuito y monta el tráfico. */
  prepare(w: World, dt: number, density: Density, onRadio: (m: RadioMsg) => void, windField: () => WindField | null, simMs: () => number): void {
    this.age += dt
    if (this.state !== 'checking' || !this.raw) return
    this.checkT -= dt
    if (this.checkT > 0 || this.age < 2.5) return
    this.checkT = 0.5
    // Lado del circuito: el publicado (Casarrubios) o, si no se sabe, a izquierdas en los dos
    // sentidos; si por ahí el relieve estorba, los dos sentidos al lado del campo que quede libre.
    // Si no hay lado bueno (un campo encajado entre montes), aquí no se pone tráfico.
    const tries: RawAirfield[] = this.raw.sideAB !== undefined ? [this.raw] : [this.raw, { ...this.raw, sideAB: 1 }, { ...this.raw, sideAB: -1 }]
    let field: Airfield | null = null
    for (const raw of tries) {
      const f = new Airfield(raw)
      const a = this.circuitClear(w, f, 0)
      const b = this.circuitClear(w, f, 1)
      if (a === null || b === null) {
        // sin relieve fino tan lejos todavía: se ha pedido, se espera
        if (this.age > 40) this.state = 'none'
        return
      }
      if (a && b) {
        field = f
        break
      }
    }
    if (!field) {
      this.state = 'none'
      return
    }
    const host: SimHost = {
      ground: (x, z, out) => this.ground(w, x, z, out),
      blocked: (x, y, z) => {
        _p.set(x, y, z).applyMatrix4(this.toWorld)
        const hit = w.hitsObstacle(_p)
        return hit !== null && hit !== 'vehicle'
      },
      localAir: (pos, agl) => {
        const wf = windField()
        if (!wf) return null
        _p.copy(pos).applyMatrix4(this.toWorld)
        const s = wf.sampleAt(_p, agl, simMs())
        if (!s) return null
        const air: LocalAir = { mean: new Vector3(s.e, s.up, -s.n), sigH: s.sigH, sigW: s.sigW, lenH: s.lenH, lenW: s.lenW, sigSlow: s.sigSlow, lenSlow: s.lenSlow }
        return air
      },
    }
    this.sim = new AirTrafficSim(field, host, {
      density,
      fleet: AI_FLEET.map((id) => AIRFRAMES[id]).filter(Boolean),
      prefix: registrationPrefix(this.lat, this.lon),
    })
    this.sim.onRadio = onRadio
    this.state = 'ready'
  }

  dispose(): void {
    this.abort.abort()
    for (const d of this.drawn.values()) disposeView(d.view)
    this.drawn.clear()
    this.sim = null
  }
}

function disposeView(view: AircraftView): void {
  view.root.removeFromParent()
  view.root.traverse((o) => {
    const m = o as unknown as { isMesh?: boolean; geometry?: { dispose(): void }; material?: unknown }
    if (!m.isMesh) return
    m.geometry?.dispose()
    for (const mat of (Array.isArray(m.material) ? m.material : [m.material]) as { dispose?(): void }[]) mat?.dispose?.()
  })
}

export class AirTraffic {
  private sites: Site[] = []
  private world: World | null = null
  private scanT = 0
  private envMap: Texture | null = null
  private readonly sound = new TrafficSound()
  private readonly voices: VoiceState[] = []
  private readonly log: HTMLDivElement
  private msgs: { el: HTMLDivElement; until: number }[] = []
  private windField: WindField | null = null
  private simMs = 0
  /** tiempo de CPU del último fotograma (ms) y su máximo reciente, para medir */
  cpuMs = 0
  cpuMax = 0
  /** enseñar las llamadas de radio */
  showRadio = true

  private readonly hooks: AirTrafficHooks

  constructor(hooks: AirTrafficHooks) {
    this.hooks = hooks
    this.log = document.createElement('div')
    this.log.id = 'atc-log'
    document.body.append(this.log)
  }

  /** Aparatos simulados ahora mismo (para la telemetría y las pruebas). */
  get aircraft(): TrafficAircraft[] {
    return this.sites.flatMap((s) => s.sim?.aircraft ?? [])
  }

  /** Aeródromos con tráfico (para las pruebas en el navegador). */
  get fields(): { name: string; state: string; sim: AirTrafficSim | null; site: Site }[] {
    return this.sites.map((s) => ({ name: s.raw?.name ?? s.key, state: s.state, sim: s.sim, site: s }))
  }

  setEnvMap(tex: Texture | null): void {
    this.envMap = tex
    for (const s of this.sites) for (const d of s.drawn.values()) if (d.view.loaded) d.view.setEnvMap(tex)
  }

  /** Focos de aterrizaje encendidos del tráfico, del más cercano al más lejano. */
  landingBeams(): GroundBeam[] {
    const out: { b: GroundBeam; d: number }[] = []
    for (const s of this.sites) for (const d of s.drawn.values()) if (d.view.lights.beam.intensity > 0 && d.view.root.visible) out.push({ b: d.view.lights.beam, d: d.distance })
    return out.sort((x, y) => x.d - y.d).map((x) => x.b)
  }

  private clear(): void {
    for (const s of this.sites) s.dispose()
    this.sites = []
    for (const m of this.msgs) m.el.remove()
    this.msgs = []
  }

  // -------------------------------------------------------------------------
  // Aeródromos cercanos
  // -------------------------------------------------------------------------
  private scan(w: World, player: Vector3): void {
    const rw = w.runways ?? w.gridRunways?.runways
    const list = rw?.list ?? []
    const g = w.frame.worldToGeo(player)
    const mLat = 111132
    const mLon = 111320 * Math.cos((g.lat * Math.PI) / 180)
    const dist = (lat: number, lon: number) => Math.hypot((lon - g.lon) * mLon, (lat - g.lat) * mLat)
    // quitar los que quedan lejos
    for (let i = this.sites.length - 1; i >= 0; i--) {
      if (dist(this.sites[i].lat, this.sites[i].lon) > SITE_FAR) {
        this.sites[i].dispose()
        this.sites.splice(i, 1)
      }
    }
    if (this.sites.length >= MAX_SITES) return
    let best: { key: string; lat: number; lon: number; d: number; r: (typeof list)[number] } | null = null
    for (const r of list) {
      if (r.len < RWY_MIN || r.len > RWY_MAX) continue
      const lat = r.lat0 + (r.uy * r.len * 0.5) / r.mLat
      const lon = r.lon0 + (r.ux * r.len * 0.5) / r.mLon
      const d = dist(lat, lon)
      if (d > SITE_NEAR) continue
      // (otra pista del mismo aeródromo: una sola con tráfico)
      if (this.sites.some((s) => s.key === r.key || Math.hypot((s.lon - lon) * mLon, (s.lat - lat) * mLat) < 2500)) continue
      if (!best || d < best.d) best = { key: r.key, lat, lon, d, r }
    }
    if (!best) return
    const site = new Site(best.key, best.lat, best.lon)
    this.sites.push(site)
    const r = best.r
    const A = { lat: r.lat0, lon: r.lon0 }
    const B = { lat: r.lat0 + (r.uy * r.len) / r.mLat, lon: r.lon0 + (r.ux * r.len) / r.mLon }
    // relieve fino bajo el campo y su circuito (lejos de la cámara no se carga solo)
    const pad = 1500
    void w.ensureHeights(best.lat - pad / mLat, best.lon - pad / mLon, best.lat + pad / mLat, best.lon + pad / mLon)
    void fetchAirfield(best.lat, best.lon, r.len / 2 + 450, site.abort.signal)
      .catch(() => ({ taxiways: [], aprons: [], name: '', icao: '' }))
      .then((osm) => {
        const lemt = lemtRunwayFor(A, B)
        const raw: RawAirfield = {
          name: lemt ? 'Casarrubios' : radioName(osm.name),
          icao: lemt ? 'LEMT' : osm.icao,
          a: site.local(A.lat, A.lon),
          b: site.local(B.lat, B.lon),
          // (la pista alisada lleva 4 m de margen a cada lado)
          hw: Math.max(7, r.hw - 4),
          taxiways: osm.taxiways.map((l) => l.map((p) => site.local(p.lat, p.lon))),
          aprons: osm.aprons.map((l) => l.map((p) => site.local(p.lat, p.lon))),
        }
        if (lemt) {
          // Casarrubios: umbral 08 desplazado, autogiros al sur (08 a derechas, 26 a izquierdas), 2500 ft
          const ab08 = lemt.id === 'lemt08'
          raw.dispAB = ab08 ? 400 : 0
          raw.dispBA = ab08 ? 0 : 400
          raw.sideAB = ab08 ? 1 : -1
          raw.circuitAgl = lemt.circuitAgl
          raw.preferred = ab08 ? 1 : 0
        }
        site.raw = raw
        site.state = 'checking'
      })
  }

  // -------------------------------------------------------------------------
  // Fotograma
  // -------------------------------------------------------------------------
  update(dt: number, f: AirTrafficFrame): void {
    const t0 = performance.now()
    const w = f.world
    // solo donde hay pistas del mapa y relieve propio (el modo sin clave)
    const usable = f.enabled && w !== null && Boolean(w.runways ?? w.gridRunways)
    if (!usable || w !== this.world) {
      this.clear()
      this.world = w
      this.scanT = 0
    }
    this.log.classList.toggle('hidden', !usable || !this.showRadio || !f.running)
    if (!usable || !w) {
      this.sound.update([], f.audio, f.cockpit, true)
      this.cpuMs = 0
      return
    }
    this.windField = f.windField
    this.simMs = f.simMs
    this.scanT -= dt
    if (this.scanT <= 0) {
      this.scanT = 1.5
      this.scan(w, f.player.pos)
    }
    const cam = f.camera.position
    this.voices.length = 0
    _mi.copy(f.camera.matrixWorld).invert()
    for (let i = 0; i < this.sites.length; i++) {
      const site = this.sites[i]
      site.sync(w)
      if (site.state === 'checking')
        site.prepare(
          w,
          dt,
          i === 0 ? f.density : 'low',
          (m) => this.radio(m),
          () => this.windField,
          () => this.simMs,
        )
      else site.age += dt
      const sim = site.sim
      if (!sim) continue
      sim.wind = f.wind
      sim.rho = f.rho
      sim.vfr = f.vfr
      if (i === 0) sim.setDensity(f.density)
      // el jugador, en el plano del aeródromo
      if (f.flying) {
        const ac = f.player
        P.pos.copy(ac.pos).applyMatrix4(site.toLocal)
        _qi.copy(site.qToWorld).invert()
        P.vel.copy(ac.vel).applyQuaternion(_qi)
        P.onGround = ac.onGround
        P.agl = Math.max(0, ac.agl)
        P.rotorR = ac.af.rotor.radius
        sim.setPlayer(P)
      } else sim.setPlayer(null)
      if (f.running) sim.update(dt)
      this.draw(site, sim, dt, f)
    }
    if (f.flying && f.running) this.checkCollisions(f.player)
    this.sound.update(this.voices, f.audio, f.cockpit, !f.running)
    // mensajes de radio: se van solos
    const now = performance.now()
    for (let i = this.msgs.length - 1; i >= 0; i--) {
      const m = this.msgs[i]
      if (now > m.until) m.el.classList.remove('show')
      if (now > m.until + 500) {
        m.el.remove()
        this.msgs.splice(i, 1)
      }
    }
    void cam
    this.cpuMs = performance.now() - t0
    this.cpuMax = Math.max(this.cpuMax * 0.995, this.cpuMs)
  }

  private draw(site: Site, sim: AirTrafficSim, dt: number, f: AirTrafficFrame): void {
    const cam = f.camera.position
    const live = new Set<number>()
    for (const t of sim.aircraft) {
      live.add(t.id)
      let d = site.drawn.get(t.id)
      _p.copy(t.pos).applyMatrix4(site.toWorld)
      const distance = _p.distanceTo(cam)
      if (!d) {
        if (distance > DRAW_FAR) continue
        const view = new AircraftView()
        // sin SpotLight: cada aparato que entra o sale recompilaría todos los materiales
        view.lights.useSpot = false
        view.root.visible = false
        this.hooks.scene.add(view.root)
        const model = aircraftById(t.af.id)
        void view.load(`${import.meta.env.BASE_URL}${aircraftUrl(model, false)}`, t.af).then(() => {
          view.setPassenger(t.passenger)
          if (this.envMap) view.setEnvMap(this.envMap)
        })
        d = { view, detail: new DistantDetail(view), pose: new WorldPose(), distance, prevDistance: distance, fall: null }
        site.drawn.set(t.id, d)
      }
      d.prevDistance = d.distance
      d.distance = distance
      const ac = t.ac
      const pose = d.pose
      // restos tras un choque en el aire: caen
      if (t.phase === 'wreck') this.fall(site, sim, t, d, dt, f.running)
      pose.pos.copy(t.pos).applyMatrix4(site.toWorld)
      pose.quat.copy(site.qToWorld).multiply(ac.quat)
      pose.vel.copy(ac.vel).applyQuaternion(site.qToWorld)
      pose.hubBody.copy(ac.hubBody)
      pose.rotor.omega = ac.rotor.omega
      pose.rotor.normal.copy(ac.rotor.normal).applyQuaternion(site.qToWorld)
      pose.headPitch = ac.headPitch
      pose.headRoll = ac.headRoll
      pose.rudder = ac.rudder
      pose.noseSteer = ac.noseSteer
      pose.engineRpm = t.phase === 'wreck' ? 0 : ac.engineRpm
      pose.onGround = !t.live || ac.onGround
      const visible = d.view.loaded && distance < DRAW_FAR && (t.live || t.grounded || t.phase === 'parked' || t.phase === 'wreck')
      d.view.root.visible = visible
      if (visible) {
        d.view.update(pose, dt, t.ap.ctl)
        d.detail.update(distance)
      }
      d.view.lights.on = visible && t.live && ac.engineOn && ac.engineRpm > 600
      d.view.lights.update(dt, f.camera, f.exposure, f.sunY)
      // sonido de los que tienen el motor en marcha o el rotor girando
      if (t.live && distance < 1800 && (ac.engineRpm > 300 || ac.rotor.rpm > 60)) {
        _v.copy(pose.pos).applyMatrix4(_mi)
        const eng = t.af.engine
        this.voices.push({
          id: t.id,
          distance,
          closing: dt > 0 ? (d.prevDistance - distance) / dt : 0,
          pan: _v.x / Math.max(1, Math.hypot(_v.x, _v.z)),
          engineRpm: ac.engineOn ? ac.engineRpm : 0,
          power: ac.enginePower / ac.maxPower,
          rotorRpm: ac.rotor.rpm,
          cylinders: eng.cylinders,
          gear: eng.gear,
          propBlades: t.af.propBlades ?? 3,
          rotorBlades: t.af.rotor.blades,
          rpmMax: eng.tach.green[1],
        })
      }
    }
    for (const [id, d] of site.drawn) {
      if (live.has(id)) continue
      disposeView(d.view)
      site.drawn.delete(id)
    }
  }

  /** Restos de un aparato del tráfico tras chocar: caen girando hasta el suelo y ahí se quedan. */
  private fall(site: Site, sim: AirTrafficSim, t: TrafficAircraft, d: Drawn, dt: number, running: boolean): void {
    const ac = t.ac
    if (!d.fall) d.fall = { vel: ac.vel.clone(), spin: new Vector3((Math.random() - 0.5) * 2.4, (Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 2.4), down: false }
    const fl = d.fall
    if (fl.down || !running) return
    ac.rotor.omega *= Math.exp(-dt / 1.5)
    const hit: GroundHit = { y: 0, normal: _v }
    const gy = sim.host.ground(ac.pos.x, ac.pos.z, hit) ? hit.y : ac.pos.y - 1
    if (ac.pos.y - gy < 0.75) {
      // en el suelo: tumbado de lado
      ac.pos.y = gy + 0.7
      fl.down = true
      ac.rotor.omega = 0
      return
    }
    fl.vel.y -= 9.81 * dt
    fl.vel.multiplyScalar(Math.exp(-dt * 0.25))
    ac.pos.addScaledVector(fl.vel, dt)
    ac.vel.copy(fl.vel)
    _q.setFromAxisAngle(_p.copy(fl.spin).normalize(), fl.spin.length() * dt)
    ac.quat.premultiply(_q)
  }

  // -------------------------------------------------------------------------
  // Choques con el jugador
  // -------------------------------------------------------------------------
  private checkCollisions(ac: Autogyro): void {
    if (ac.crash) return
    let mine: Shape | null = null
    const myR = ac.af.rotor.radius
    for (const site of this.sites) {
      if (!site.sim) continue
      for (const tr of site.sim.aircraft) {
        const d = site.drawn.get(tr.id)
        if (!d || !d.view.root.visible || (tr.phase === 'wreck' && d.fall)) continue
        const other = d.pose
        const theirR = tr.af.rotor.radius
        if (other.pos.distanceTo(ac.pos) > myR + theirR + 6) continue
        const rel = ac.vel.distanceTo(other.vel)
        if (rel < 1.5) continue // apoyados o rodando juntos muy despacio: no cuenta
        mine ??= shapeOf(ac, _mine, myR)
        if (!shapesHit(mine, shapeOf(other, _theirs, theirR))) continue
        const both = ac.onGround && other.onGround
        // el otro también se lleva lo suyo
        tr.live = false
        tr.ac.engineOn = false
        tr.setPhase('wreck')
        this.hooks.collide(t(both ? 'mp.midairBoth' : 'mp.midair'), t('mp.midair.detail', { name: tr.callsign, kmh: Math.round(rel * 3.6) }))
        return
      }
    }
  }

  // -------------------------------------------------------------------------
  // Radio
  // -------------------------------------------------------------------------
  private radio(m: RadioMsg): void {
    if (!this.showRadio) return
    const el = document.createElement('div')
    el.className = 'atc-msg'
    const text = radioText(m)
    // el indicativo, resaltado
    const i = text.indexOf(m.callsign)
    if (i >= 0) {
      el.append(text.slice(0, i))
      const b = document.createElement('b')
      b.textContent = m.callsign
      el.append(b, text.slice(i + m.callsign.length))
    } else el.textContent = text
    this.log.append(el)
    requestAnimationFrame(() => el.classList.add('show'))
    this.msgs.push({ el, until: performance.now() + 9000 })
    while (this.msgs.length > 3) this.msgs.shift()!.el.remove()
  }

  dispose(): void {
    this.clear()
    this.log.remove()
  }
}

const P = { pos: new Vector3(), vel: new Vector3(), onGround: true, agl: 0, rotorR: 4.2 }
