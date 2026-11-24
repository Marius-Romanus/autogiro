// Multijugador por salas con código.
//
// - Uno crea la sala y recibe un código de 4 caracteres (p. ej. «K7QX»); los demás
//   se unen escribiéndolo o abriendo el enlace ?sala=K7QX.
// - Cada cliente simula su autogiro y difunde su estado a 15 Hz (en ECEF); los
//   demás lo interpolan (RemoteAircraft). El servidor (server/rooms.ts) solo reparte.
// - El anfitrión fija lugar, hora, viento, turbulencia y nubes para toda la sala.
// - Choques entre aparatos (rotor y fuselaje), chat (Intro) y lista de pilotos.

import './multiplayer.css'
import { Group, Quaternion, Vector3, type PerspectiveCamera, type Scene, type Texture } from 'three'
import { Ellipsoid } from '@takram/three-geospatial'
import { CG, GEOM, type Autogyro, type Controls } from '../sim/autogyro.ts'
import type { World } from '../world/World.ts'
import type { Location, Settings } from '../config.ts'
import { aircraftById, aircraftName } from '../aircraft/catalog.ts'
import { getLang, onLangChange, t } from '../i18n.ts'
import type { AircraftPose } from '../aircraft/AircraftView.ts'
import type { GroundBeam } from '../render/LandingLightEffect.ts'
import {
  CHAT_MAX,
  CODE_LENGTH,
  MAX_PLAYERS,
  MP_PATH,
  NAME_MAX,
  cleanName,
  isValidCode,
  normalizeCode,
  type ClientMsg,
  type PeerInfo,
  type RoomConditions,
  type ServerMsg,
  type StateMsg,
} from './protocol.ts'
import {
  PEER_COLORS,
  RemoteAircraft,
  ST_CRASHED,
  ST_FLYING,
  ST_LOADING,
  ST_PAUSED,
  fmtDistance,
  type ScreenInset,
} from './RemoteAircraft.ts'
import { createOnlineHelp, hostKind, type OnlineHelp } from './onlineHelp.ts'

/** Lo que el multijugador lee de la aplicación (main.ts). */
export interface MpApp {
  readonly ac: Autogyro
  readonly ctl: Controls
  readonly world: World | null
  readonly ground: { readonly valid: boolean; heightAt(x: number, z: number, out: Vector3): number }
  readonly gfx: {
    readonly scene: Scene
    readonly camera: PerspectiveCamera
    readonly renderer: { readonly toneMappingExposure: number }
    readonly sunDirWorld: Vector3
  }
  /** luces exteriores del aparato propio (se difunden a la sala) */
  readonly view: { readonly lights: { readonly on: boolean } }
  /** panel de instrumentos (las flechas de borde no lo pisan) */
  readonly hud?: { readonly visible: boolean }
  readonly settings: Settings
  readonly state: 'loading' | 'flying' | 'crashed'
  readonly menuOpen: boolean
  readonly location: Location
  simDate: Date
}

/** Lo que el multijugador pide a la aplicación. */
export interface MpHooks {
  toast(msg: string): void
  /** (invitados) condiciones de la sala: lugar, hora, viento, nubes */
  applyConditions(c: RoomConditions): void
  /** volver a aparecer (para ocupar el puesto de salida de la sala) */
  respawn(): void
  /** choque con otro aparato */
  collide(title: string, detail: string): void
}

const STORE = 'autogiro.mp.v1'
const SEND_INTERVAL = 1000 / 15
const IDLE_INTERVAL = 500
const DEG = Math.PI / 180
const ROTOR_R = 4.2
/** inputs del menú que fija el anfitrión */
const ROOM_INPUTS = ['depmode-map', 'depmode-place', 'country', 'location', 'btn-worldmap', 'customLat', 'customLon', 'customHeading', 'hour', 'dayOfYear', 'windFrom', 'windSpeed', 'turbulence', 'clouds']
const COND_KEYS = ['locationId', 'customLat', 'customLon', 'customHeading', 'customName', 'hour', 'dayOfYear', 'windFrom', 'windSpeed', 'turbulence', 'clouds', 'collisions'] as const

// puntos del fuselaje para los choques (respecto al CG, ejes cuerpo)
const BODY_PTS = [
  new Vector3(1.95, -0.35, 0), // morro
  new Vector3(0.75, -0.05, 0), // cabina
  new Vector3(0.08, 0.1, 0),
  new Vector3(-0.95, 0.25, 0), // motor
  GEOM.prop.clone(),
  new Vector3(-0.3, 1.25, 0), // mástil
  new Vector3(-2.2, -0.65, 0), // quilla
  GEOM.fin.clone(),
  GEOM.tail.clone(),
  GEOM.noseWheel.clone(),
  GEOM.mainL.clone(),
  GEOM.mainR.clone(),
].map((p) => p.sub(CG))
const RIM_N = 16

const _p = new Vector3()
const _n = new Vector3()
const _v = new Vector3()
const _t = new Vector3()
const _q = new Quaternion()
const _qF = new Quaternion()
const _qInv = new Quaternion()
const _sample = { y: 0, normal: new Vector3() }
const _inset: ScreenInset = { top: 0, right: 0, bottom: 0, left: 0, notchLeft: 0, notchBottom: 0 }

const r = (x: number, k: number) => Math.round(x * k) / k

interface Stored {
  name: string
  server: string
  collisions: boolean
  /** etiquetas y flechas de borde de los demás pilotos */
  tags: boolean
}

function loadStored(): Stored {
  const def: Stored = { name: t('mp.defaultName', { n: Math.floor(10 + Math.random() * 90) }), server: '', collisions: true, tags: true }
  try {
    const raw = localStorage.getItem(STORE)
    if (raw) return { ...def, ...JSON.parse(raw) }
  } catch {
    /* sin almacenamiento */
  }
  return def
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text) e.textContent = text
  return e
}

export class Multiplayer {
  private readonly app: MpApp
  private readonly hooks: MpHooks
  private readonly stored = loadStored()
  private ws: WebSocket | null = null
  private pending: ClientMsg | null = null
  private reconnectTries = 0

  /** código de la sala ('' = fuera de sala) */
  code = ''
  myId = 0
  hostId = 0
  slot = 0
  readonly peers = new Map<number, RemoteAircraft>()
  /** condiciones vigentes (recibidas como invitado o enviadas como anfitrión) */
  private cond: RoomConditions | null = null
  private condAt = 0
  private condCheckAt = 0

  private readonly group = new Group()
  private onlineHelp!: OnlineHelp
  private envMap: Texture | null = null
  private lastSend = 0
  private seq = 0
  private spawnedAt = 0
  private prevState = ''
  private lastProfile = ''
  private panelAt = 0
  /** caja de la lista de pilotos en vuelo (las flechas de borde la esquivan) */
  private hudRect: DOMRect | null = null

  // interfaz
  private ui!: {
    section: HTMLElement
    name: HTMLInputElement
    out: HTMLElement
    inRoom: HTMLElement
    create: HTMLButtonElement
    codeInput: HTMLInputElement
    join: HTMLButtonElement
    roomCode: HTMLButtonElement
    link: HTMLButtonElement
    leave: HTMLButtonElement
    list: HTMLUListElement
    status: HTMLElement
    where: HTMLElement
    collWrap: HTMLElement
    coll: HTMLInputElement
    server: HTMLInputElement
    hud: HTMLElement
    hudCode: HTMLElement
    hudCount: HTMLElement
    hudList: HTMLUListElement
    chat: HTMLElement
    chatLog: HTMLElement
    chatInput: HTMLInputElement
    tags: HTMLElement
    tagsBtn: HTMLButtonElement
    condNote: HTMLElement | null
  }

  constructor(app: MpApp, hooks: MpHooks) {
    this.app = app
    this.hooks = hooks
    this.group.name = 'multijugador'
    app.gfx.scene.add(this.group)
    this.save() // fija el nombre por defecto para que no cambie en cada recarga
    this.buildUI()
    this.refreshUI()
    // idioma: los textos fijos llevan data-i18n (los cambia i18n.applyI18n); aquí, los generados
    onLangChange(() => {
      this.refreshUI()
      for (const id of ROOM_INPUTS) {
        const e = document.getElementById(id)
        if (e?.title) e.title = t('mp.hostLocked')
      }
    })

    // enlace directo: ?sala=K7QX
    const fromUrl = normalizeCode(new URLSearchParams(location.search).get('sala') ?? '')
    if (isValidCode(fromUrl)) {
      this.ui.codeInput.value = fromUrl
      setTimeout(() => this.join(fromUrl), 400)
    }
  }

  get inRoom(): boolean {
    return this.code !== ''
  }
  get isHost(): boolean {
    return this.inRoom && this.myId === this.hostId
  }

  // -------------------------------------------------------------------------
  // Conexión
  // -------------------------------------------------------------------------
  private serverUrl(): string {
    const s = this.stored.server.trim()
    if (!s) return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${MP_PATH}`
    let u = s.replace(/^http(s?):\/\//i, (_m, sec: string) => (sec ? 'wss://' : 'ws://'))
    if (!/^wss?:\/\//i.test(u)) u = `ws://${u}`
    const url = new URL(u)
    if (url.pathname === '/' || url.pathname === '') url.pathname = MP_PATH
    return url.toString()
  }

  private connect(first: ClientMsg): void {
    this.pending = first
    const ws = this.ws
    if (ws && ws.readyState === WebSocket.OPEN) return this.flushPending()
    if (ws && ws.readyState === WebSocket.CONNECTING) return
    let url: string
    try {
      url = this.serverUrl()
    } catch {
      this.setStatus(t('mp.badServer'), true)
      this.pending = null
      return
    }
    this.setStatus(t('mp.connecting'))
    const sock = new WebSocket(url)
    this.ws = sock
    sock.onopen = () => this.flushPending()
    sock.onmessage = (e) => this.onMessage(String(e.data))
    sock.onclose = () => this.onClose(sock)
  }

  private flushPending(): void {
    if (this.pending) this.send(this.pending)
    this.pending = null
  }

  private send(m: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m))
  }

  private onClose(sock: WebSocket): void {
    if (sock !== this.ws) return
    this.ws = null
    if (this.inRoom) {
      this.clearPeers()
      if (this.reconnectTries < 8) {
        this.reconnectTries++
        this.setStatus(t('mp.reconnecting', { n: this.reconnectTries }), true)
        setTimeout(() => {
          if (this.inRoom && !this.ws) this.connect({ t: 'join', code: this.code, ...this.profile() })
        }, 2500)
      } else {
        this.leaveLocal()
        this.hooks.toast(t('mp.lostToast'))
        this.setStatus(t('mp.lostServer'), true)
      }
    } else if (this.pending) {
      this.pending = null
      this.setStatus(t('mp.cantConnect', { url: this.safeUrl() }), true)
    }
    this.refreshUI()
  }

  private safeUrl(): string {
    try {
      return this.serverUrl()
    } catch {
      return '?'
    }
  }

  private profile(): { name: string; aircraft: string; passenger: boolean } {
    return { name: this.stored.name, aircraft: aircraftById(this.app.settings.aircraft).id, passenger: this.app.settings.passenger }
  }

  create(): void {
    this.connect({ t: 'create', ...this.profile() })
  }

  join(raw: string): void {
    const code = normalizeCode(raw)
    if (!isValidCode(code)) {
      this.setStatus(t('mp.badCode', { n: CODE_LENGTH }), true)
      return
    }
    this.connect({ t: 'join', code, ...this.profile() })
  }

  leave(): void {
    if (!this.inRoom) return
    this.send({ t: 'leave' })
    const code = this.code
    this.leaveLocal()
    this.setStatus(t('mp.leftStatus', { code }))
    this.hooks.toast(t('mp.leftToast'))
  }

  private leaveLocal(): void {
    this.code = ''
    this.myId = this.hostId = this.slot = 0
    this.cond = null
    this.reconnectTries = 0
    this.clearPeers()
    this.lockConditions(false)
    const sock = this.ws
    this.ws = null
    sock?.close()
    this.setUrlCode('')
    this.refreshUI()
  }

  private clearPeers(): void {
    for (const p of this.peers.values()) p.dispose()
    this.peers.clear()
  }

  // -------------------------------------------------------------------------
  // Mensajes del servidor
  // -------------------------------------------------------------------------
  private onMessage(data: string): void {
    let m: ServerMsg
    try {
      m = JSON.parse(data)
    } catch {
      return
    }
    switch (m.t) {
      case 's':
        this.peers.get(m.id)?.push(m, performance.now())
        return
      case 'welcome':
        this.onWelcome(m)
        return
      case 'error': {
        const rejoining = this.reconnectTries > 0 && this.inRoom
        if (rejoining && m.code === 'noroom') {
          const code = this.code
          this.leaveLocal()
          this.hooks.toast(t('mp.roomGone', { code }))
        } else if (m.code === 'noroom' && !this.inRoom) this.setUrlCode('') // enlace a una sala ya cerrada
        this.setStatus(getLang() === 'es' ? m.msg : t(`mp.err.${m.code}`), true)
        return
      }
      case 'join':
        this.addPeer(m.peer)
        this.system(t('mp.joined', { name: m.peer.name }), m.peer.id)
        this.refreshUI()
        return
      case 'leave': {
        const p = this.peers.get(m.id)
        if (p) {
          this.system(t('mp.left', { name: p.info.name }), m.id)
          p.dispose()
          this.peers.delete(m.id)
        }
        this.refreshUI()
        return
      }
      case 'host':
        this.hostId = m.id
        if (m.id === this.myId) {
          this.lockConditions(false)
          this.cond = null // se reenvían las nuestras (que son las de la sala)
          this.hooks.toast(t('mp.nowHostToast'))
          this.system(t('mp.nowHost'))
        } else {
          const p = this.peers.get(m.id)
          if (p) this.system(t('mp.newHost', { name: p.info.name }), m.id)
        }
        this.refreshUI()
        return
      case 'profile': {
        const p = this.peers.get(m.id)
        if (p) p.setInfo({ ...p.info, name: m.name, aircraft: m.aircraft, passenger: m.passenger })
        this.refreshUI()
        return
      }
      case 'cond':
        if (!this.isHost) this.applyConditions(m.c, 0)
        return
      case 'chat': {
        const mine = m.id === this.myId
        const p = this.peers.get(m.id)
        this.chatLine(mine ? this.stored.name : (p?.info.name ?? '?'), mine ? '#ffffff' : (p?.color ?? '#ccc'), m.text)
        return
      }
      case 'ev': {
        const p = this.peers.get(m.id)
        if (p) this.system(`✖ ${p.info.name}: ${m.text}`, m.id)
        return
      }
    }
  }

  private onWelcome(m: Extract<ServerMsg, { t: 'welcome' }>): void {
    const rejoin = this.code === m.code
    this.code = m.code
    this.myId = m.id
    this.hostId = m.hostId
    this.slot = m.slot
    this.reconnectTries = 0
    this.clearPeers()
    for (const p of m.peers) this.addPeer(p)
    this.lastProfile = ''
    if (this.isHost) {
      this.cond = null
      this.lockConditions(false)
    } else if (m.c) this.applyConditions(m.c, m.age)
    this.setUrlCode(m.code)
    this.setStatus('')
    this.refreshUI()
    if (rejoin) {
      this.hooks.toast(t('mp.reconnected'))
      return
    }
    this.hooks.toast(t(this.isHost ? 'mp.createdToast' : 'mp.joinedToast', { code: m.code }))
    this.system(t(this.isHost ? 'mp.createdSys' : 'mp.joinedSys', { code: m.code, n: m.peers.length + 1 }))
    // si estás parado en el punto de salida, pasa a tu puesto para no solaparte con otro
    const ac = this.app.ac
    if (this.slot !== 0 && (this.app.state === 'loading' || (ac.onGround && ac.groundSpeed < 2))) this.hooks.respawn()
  }

  private addPeer(info: PeerInfo): void {
    if (info.id === this.myId) return
    this.peers.get(info.id)?.dispose()
    const p = new RemoteAircraft(info, this.group, this.ui.tags)
    p.setEnvMap(this.envMap)
    this.peers.set(info.id, p)
  }

  // -------------------------------------------------------------------------
  // Condiciones de la sala
  // -------------------------------------------------------------------------
  private applyConditions(c: RoomConditions, age: number): void {
    this.cond = c
    this.condAt = performance.now() - age
    this.lockConditions(true)
    this.hooks.applyConditions(c)
  }

  private hostConditions(): RoomConditions {
    const s = this.app.settings
    const loc = this.app.location
    return {
      // el lugar donde el anfitrión está de verdad (no lo que tenga a medio elegir en el menú)
      locationId: loc?.id ?? s.locationId,
      customLat: loc?.id === 'custom' ? loc.lat : s.customLat,
      customLon: loc?.id === 'custom' ? loc.lon : s.customLon,
      customHeading: loc?.id === 'custom' ? loc.heading : s.customHeading,
      customName: loc?.id === 'custom' ? loc.name : s.customName,
      hour: s.hour,
      dayOfYear: s.dayOfYear,
      windFrom: s.windFrom,
      windSpeed: s.windSpeed,
      turbulence: s.turbulence,
      clouds: s.clouds,
      simTime: this.app.simDate.getTime(),
      collisions: this.stored.collisions,
    }
  }

  /** Anfitrión: envía las condiciones si cambian, si el reloj salta o cada 10 s. */
  private pollHostConditions(now: number): void {
    if (now - this.condCheckAt < 500) return
    this.condCheckAt = now
    const c = this.hostConditions()
    const prev = this.cond
    const expected = prev ? prev.simTime + (now - this.condAt) : 0
    const changed =
      !prev || COND_KEYS.some((k) => c[k] !== prev[k]) || Math.abs(c.simTime - expected) > 2000 || now - this.condAt > 10000
    if (!changed) return
    this.cond = c
    this.condAt = now
    this.send({ t: 'cond', c })
  }

  private lockConditions(lock: boolean): void {
    for (const id of ROOM_INPUTS) {
      const e = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null
      if (!e) continue
      e.disabled = lock
      e.title = lock ? t('mp.hostLocked') : ''
    }
    const note = this.ui.condNote
    if (note) note.classList.toggle('hidden', !lock)
  }

  // -------------------------------------------------------------------------
  // Integración con el bucle principal
  // -------------------------------------------------------------------------
  /**
   * Desplaza el punto de salida según el puesto en la sala, para no aparecer
   * encima de otro piloto. En pista: escalonados a lo largo de la pista; en vuelo:
   * en formación abierta.
   */
  offsetSpawn(out: Vector3, headingDeg: number, onRunway: boolean): void {
    this.seq++
    this.spawnedAt = performance.now()
    const k = this.inRoom ? this.slot : 0
    if (!k) return
    const h = headingDeg * DEG
    const fwd = _v.set(Math.sin(h), 0, -Math.cos(h))
    const right = _t.set(Math.cos(h), 0, Math.sin(h))
    const side = k % 2 ? 1 : -1 // en vuelo: a derecha e izquierda alternos
    // en pista, uno detrás de otro sobre el eje (el punto de salida de algunos campos está en una franja estrecha)
    if (onRunway) out.addScaledVector(fwd, 22 * k)
    else out.addScaledVector(fwd, -35 * k).addScaledVector(right, 70 * Math.ceil(k / 2) * side)
  }

  setEnvMap(tex: Texture | null): void {
    this.envMap = tex
    for (const p of this.peers.values()) p.setEnvMap(tex)
  }

  /** Metros que el datum de este cliente está por encima del común (Google = elipsoide; MDT = nivel del mar). */
  private datumShift(): number {
    const w = this.app.world
    return w && w.mode === 'google' ? (this.app.location?.geoid ?? 0) : 0
  }

  /** Llamar una vez por fotograma, con la cámara ya colocada y antes de dibujar. */
  update(dt: number): void {
    const app = this.app
    const now = performance.now()
    const w = app.world

    if (this.inRoom) {
      // anuncio de accidente propio
      if (app.state === 'crashed' && this.prevState === 'flying' && app.ac.crash) this.send({ t: 'ev', k: 'crash', text: app.ac.crash.title })
      this.prevState = app.state
      // cambios de nombre o de aparato
      const prof = this.profile()
      const key = `${prof.name}|${prof.aircraft}|${prof.passenger}`
      if (key !== this.lastProfile) {
        if (this.lastProfile) this.send({ t: 'profile', ...prof })
        this.lastProfile = key
      }
      if (this.isHost) this.pollHostConditions(now)
      else if (this.cond) app.simDate = new Date(this.cond.simTime + (now - this.condAt))
      if (w) this.sendState(now, w)
    }

    // aparatos de los demás
    const cam = app.gfx.camera
    const show = !app.menuOpen
    const W = window.innerWidth
    const H = window.innerHeight
    if (w && this.peers.size) {
      const shift = this.datumShift()
      _qInv.setFromRotationMatrix(w.frame.ecefToWorld)
      // (yAbove = 60 m sobre el aparato: cuenta también el tablero de un puente si está posado en él)
      const groundAt = (x: number, z: number, yAbove: number) => (w.sampleGround(x, z, yAbove, _sample, yAbove - 59) ? _sample.y : null)
      const inset = this.screenInset(W)
      for (const p of this.peers.values()) {
        p.update(dt, now, w.frame.ecefToWorld, _qInv, shift, groundAt)
        p.updateLights(dt, cam, app.gfx.renderer.toneMappingExposure, app.gfx.sunDirWorld.y)
        const alt = p.active ? (w.frame.worldToGeo(p.pose.pos).h - shift - 1.05) * 3.28084 : null
        p.updateTag(cam, show, this.stored.tags, alt, W, H, inset)
      }
      this.checkCollisions(now, w, shift)
    }

    if (now - this.panelAt > 250) {
      this.panelAt = now
      this.refreshHud()
    }
  }

  /**
   * Zona de pantalla para etiquetas y flechas de borde: debajo de la barra superior
   * y, con los instrumentos visibles, encima de su panel (misma medida que Hud.draw).
   */
  private screenInset(W: number): ScreenInset {
    const gauge = Math.max(92, Math.min(148, (W - 120) / 7.2))
    _inset.top = 54
    _inset.left = _inset.right = 24
    _inset.bottom = this.app.hud?.visible === false ? 24 : gauge + 50
    // lista de pilotos arriba a la derecha (en pantallas estrechas va abajo: ver multiplayer.css)
    const r = this.hudRect
    const corner = r && r.width > 0 && r.top < 120
    _inset.notchLeft = corner ? r.left - 18 : 0
    _inset.notchBottom = corner ? r.bottom + 20 : 0
    return _inset
  }

  /** Etiquetas y flechas de los demás pilotos (botón «Amigos» o tecla Tab). */
  toggleTags(): void {
    this.stored.tags = !this.stored.tags
    this.save()
    this.refreshTagsBtn()
    this.hooks.toast(t(this.stored.tags ? 'mp.tags.on' : 'mp.tags.off'))
  }

  private refreshTagsBtn(): void {
    const b = this.ui.tagsBtn
    b.classList.toggle('hidden', !this.inRoom)
    b.classList.toggle('on', this.stored.tags)
    b.setAttribute('aria-pressed', String(this.stored.tags))
  }

  /** Focos de aterrizaje encendidos de los demás, del más cercano a la cámara al más lejano. */
  landingBeams(): GroundBeam[] {
    const out: { b: GroundBeam; d: number }[] = []
    for (const p of this.peers.values()) {
      const b = p.view.lights.beam
      if (p.active && b.intensity > 0) out.push({ b, d: p.distance })
    }
    return out.sort((x, y) => x.d - y.d).map((x) => x.b)
  }

  private sendState(now: number, w: World): void {
    const app = this.app
    const st = app.state === 'loading' ? ST_LOADING : app.menuOpen ? ST_PAUSED : app.state === 'crashed' ? ST_CRASHED : ST_FLYING
    if (now - this.lastSend < (st === ST_FLYING ? SEND_INTERVAL : IDLE_INTERVAL)) return
    this.lastSend = now
    const ac = app.ac
    const m = w.frame.worldToECEF
    _qF.setFromRotationMatrix(m)
    _p.copy(ac.pos).applyMatrix4(m)
    const shift = this.datumShift()
    if (shift) {
      Ellipsoid.WGS84.getSurfaceNormal(_p, _n)
      _p.addScaledVector(_n, -shift)
    }
    _q.copy(_qF).multiply(ac.quat)
    _v.copy(ac.vel).applyQuaternion(_qF)
    _n.copy(ac.rotor.normal).applyQuaternion(_qF)
    const gy = app.ground.valid ? app.ground.heightAt(ac.pos.x, ac.pos.z, _t) : NaN
    const msg: StateMsg = {
      t: 's',
      ts: Math.round(now),
      sq: this.seq,
      st,
      p: [r(_p.x, 100), r(_p.y, 100), r(_p.z, 100)],
      q: [r(_q.x, 1e5), r(_q.y, 1e5), r(_q.z, 1e5), r(_q.w, 1e5)],
      v: [r(_v.x, 100), r(_v.y, 100), r(_v.z, 100)],
      n: [r(_n.x, 1e4), r(_n.y, 1e4), r(_n.z, 1e4)],
      hb: [r(ac.hubBody.x, 1000), r(ac.hubBody.y, 1000), r(ac.hubBody.z, 1000)],
      rr: Math.round(ac.rotor.rpm),
      er: Math.round(ac.engineRpm),
      hp: r(ac.headPitch, 1e4),
      hr: r(ac.headRoll, 1e4),
      rd: r(ac.rudder, 1000),
      ns: r(ac.noseSteer, 1000),
      sp: r(app.ctl.pitch, 1000),
      sr: r(app.ctl.roll, 1000),
      g: ac.onGround ? 1 : 0,
      ag: Number.isFinite(gy) ? r(ac.pos.y - gy, 100) : 999,
      li: app.view.lights.on ? 1 : 0,
      th: r(app.ctl.throttle, 100),
      wb: r(app.ctl.wheelBrake, 100),
    }
    this.send(msg)
  }

  // -------------------------------------------------------------------------
  // Choques entre aparatos
  // -------------------------------------------------------------------------
  private checkCollisions(now: number, w: World, shift: number): void {
    const app = this.app
    const ac = app.ac
    if (!this.inRoom || app.state !== 'flying' || app.menuOpen || ac.crash) return
    if (this.cond ? !this.cond.collisions : !this.stored.collisions) return
    if (now - this.spawnedAt < 3000) return
    let mine: Shape | null = null
    for (const p of this.peers.values()) {
      if (p.status !== ST_FLYING && p.status !== ST_CRASHED) continue
      if (now - p.lastRecv > 2000 || now - p.spawnedAt < 3000) continue
      const other = p.predict(now, w.frame.ecefToWorld, _qInv, shift)
      if (!other || other.pos.distanceTo(ac.pos) > 2 * ROTOR_R + 6) continue
      const rel = ac.vel.distanceTo(other.vel)
      if (rel < 1.5) continue // apoyados o rodando juntos muy despacio: no cuenta
      mine ??= shapeOf(ac, _mine)
      if (!shapesHit(mine, shapeOf(other, _theirs))) continue
      const both = ac.onGround && other.onGround
      this.hooks.collide(
        t(both ? 'mp.midairBoth' : 'mp.midair'),
        t('mp.midair.detail', { name: p.info.name, kmh: Math.round(rel * 3.6) }),
      )
      return
    }
  }

  // -------------------------------------------------------------------------
  // Interfaz
  // -------------------------------------------------------------------------
  private buildUI(): void {
    // sección del menú (banda a todo el ancho, encima de los ajustes)
    const section = el('section', 'mp-section')
    section.id = 'mp'
    section.innerHTML = `
      <div class="mp-head">
        <h4 data-i18n="mp.title">${t('mp.title')}</h4>
        <p class="muted" data-i18n="mp.intro">${t('mp.intro')}</p>
        <button id="mpOnline" type="button" class="mp-linkbtn" data-i18n="mp.onlineBtn">${t('mp.onlineBtn')}</button>
      </div>
      <div class="mp-body">
        <div class="field mp-name"><label for="mpName" data-i18n="mp.yourName">${t('mp.yourName')}</label><input id="mpName" type="text" maxlength="${NAME_MAX}" autocomplete="nickname" spellcheck="false" /></div>
        <div class="mp-out">
          <button id="mpCreate" class="primary" data-i18n="mp.create">${t('mp.create')}</button>
          <span class="mp-or" data-i18n="mp.or">${t('mp.or')}</span>
          <input id="mpCode" class="mp-code-input" type="text" maxlength="${CODE_LENGTH + 2}" placeholder="${t('mp.codePh')}" autocomplete="off" spellcheck="false" aria-label="${t('mp.codeAria')}" data-i18n-attr="placeholder:mp.codePh;aria-label:mp.codeAria" />
          <button id="mpJoin" data-i18n="mp.join">${t('mp.join')}</button>
        </div>
        <div class="mp-in hidden">
          <span class="mp-label" data-i18n="mp.room">${t('mp.room')}</span>
          <button id="mpRoomCode" class="mp-bigcode" title="${t('mp.copyCodeTitle')}" data-i18n-attr="title:mp.copyCodeTitle"></button>
          <button id="mpLink" title="${t('mp.copyLinkTitle')}" data-i18n-attr="title:mp.copyLinkTitle" data-i18n="mp.copyLink">${t('mp.copyLink')}</button>
          <button id="mpLeave" data-i18n="mp.leave">${t('mp.leave')}</button>
        </div>
      </div>
      <ul id="mpList" class="mp-list hidden"></ul>
      <div class="mp-foot">
        <span id="mpWhere" class="mp-where-note hidden"></span>
        <span id="mpStatus" class="muted"></span>
        <label class="check hidden" id="mpCollWrap"><input id="mpColl" type="checkbox" /> <span data-i18n="mp.collisions">${t('mp.collisions')}</span></label>
        <details class="mp-server">
          <summary data-i18n="mp.server">${t('mp.server')}</summary>
          <input id="mpServer" type="text" placeholder="${t('mp.serverPh')}" data-i18n-attr="placeholder:mp.serverPh" spellcheck="false" autocomplete="off" />
          <small class="muted" data-i18n="mp.serverNote">${t('mp.serverNote')}</small>
        </details>
      </div>`
    // (pestaña Multijugador del menú)
    const slot = document.getElementById('mp-slot')
    if (slot) slot.append(section)
    else document.getElementById('menu')?.appendChild(section)

    // nota en la sección de condiciones (invitados)
    let condNote: HTMLElement | null = null
    const condSection = document.getElementById('hour')?.closest('section')
    if (condSection) {
      condNote = el('p', 'mp-cond-note hidden', t('mp.condNote'))
      condNote.dataset.i18n = 'mp.condNote'
      condSection.querySelector('.pane-head, h4')?.after(condNote)
    }

    // lista de pilotos en vuelo, chat y etiquetas
    const hud = el('div', 'mp-hud hidden')
    hud.id = 'mp-hud'
    const head = el('div', 'mp-hud-head')
    const hudCode = el('b')
    const hudCount = el('span', 'mp-hud-count')
    const hudRoom = el('span', '', t('mp.room'))
    hudRoom.dataset.i18n = 'mp.room'
    hudRoom.style.marginRight = '0.3em'
    head.append(hudRoom, hudCode, hudCount)
    const hudList = el('ul')
    const hint = el('div', 'mp-hud-hint')
    hint.innerHTML = t('mp.chatHint')
    hint.dataset.i18n = 'mp.chatHint'
    hud.append(head, hudList, hint)

    const chat = el('div', 'mp-chat hidden')
    chat.id = 'mp-chat'
    const chatLog = el('div', 'mp-chat-log')
    const chatInput = el('input', 'mp-chat-input hidden')
    chatInput.type = 'text'
    chatInput.maxLength = CHAT_MAX
    chatInput.placeholder = t('mp.chatPh')
    chatInput.dataset.i18nAttr = 'placeholder:mp.chatPh'
    chatInput.autocomplete = 'off'
    chat.append(chatLog, chatInput)

    const tags = el('div', 'mp-tags')
    tags.id = 'mp-tags'
    document.body.append(tags, hud, chat)

    // botón de la barra superior, junto al de luces (solo dentro de una sala)
    const tagsBtn = el('button', 'hidden')
    tagsBtn.id = 'btn-tags'
    tagsBtn.type = 'button'
    tagsBtn.title = t('mp.tags.title')
    tagsBtn.dataset.i18nAttr = 'title:mp.tags.title'
    tagsBtn.innerHTML =
      '<svg class="mp-tags-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M14 8 L3 2.5 L6 8 L3 13.5 Z" fill="currentColor"/></svg>'
    const tagsLabel = el('span', '', t('mp.tags.label'))
    tagsLabel.dataset.i18n = 'mp.tags.label'
    tagsBtn.append(tagsLabel, el('kbd', '', 'Tab'))
    const topbar = document.getElementById('topbar')
    const lightsBtn = document.getElementById('btn-lights')
    if (lightsBtn) lightsBtn.after(tagsBtn)
    else topbar?.appendChild(tagsBtn)
    // sin foco tras el clic: si no, Espacio (frenos) volvería a pulsar el botón
    tagsBtn.addEventListener('mousedown', (e) => e.preventDefault())
    tagsBtn.addEventListener('click', () => this.toggleTags())
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey) return
      const tg = e.target as HTMLElement | null
      if (tg && ['INPUT', 'SELECT', 'TEXTAREA'].includes(tg.tagName)) return
      if (!this.inRoom || this.app.menuOpen) return
      e.preventDefault() // en vuelo, Tab no mueve el foco por los botones
      if (!e.repeat) this.toggleTags()
    })

    const $ = <T extends HTMLElement>(id: string) => section.querySelector<T>(`#${id}`)!
    this.ui = {
      section,
      name: $('mpName'),
      out: section.querySelector('.mp-out')!,
      inRoom: section.querySelector('.mp-in')!,
      create: $('mpCreate'),
      codeInput: $('mpCode'),
      join: $('mpJoin'),
      roomCode: $('mpRoomCode'),
      link: $('mpLink'),
      leave: $('mpLeave'),
      list: $('mpList'),
      status: $('mpStatus'),
      where: $('mpWhere'),
      collWrap: $('mpCollWrap'),
      coll: $('mpColl'),
      server: $('mpServer'),
      hud,
      hudCode,
      hudCount,
      hudList,
      chat,
      chatLog,
      chatInput,
      tags,
      tagsBtn,
      condNote,
    }
    const ui = this.ui
    ui.name.value = this.stored.name
    ui.server.value = this.stored.server
    ui.coll.checked = this.stored.collisions

    ui.name.addEventListener('change', () => {
      this.stored.name = cleanName(ui.name.value)
      ui.name.value = this.stored.name
      this.save()
      this.refreshUI()
    })
    ui.server.addEventListener('change', () => {
      this.stored.server = ui.server.value.trim()
      this.save()
    })
    ui.coll.addEventListener('change', () => {
      this.stored.collisions = ui.coll.checked
      this.save()
    })
    ui.create.addEventListener('click', () => this.create())
    ui.join.addEventListener('click', () => this.join(ui.codeInput.value))
    ui.codeInput.addEventListener('input', () => {
      const pos = ui.codeInput.selectionStart
      ui.codeInput.value = ui.codeInput.value.toUpperCase()
      ui.codeInput.setSelectionRange(pos, pos)
    })
    ui.codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.join(ui.codeInput.value)
    })
    ui.leave.addEventListener('click', () => this.leave())
    ui.roomCode.addEventListener('click', () => this.copy(this.code, t('mp.codeCopied')))
    ui.link.addEventListener('click', () =>
      this.copy(
        this.roomLink(),
        t(hostKind() === 'local' ? 'mp.linkCopiedLocal' : 'mp.linkCopied'),
      ),
    )
    // guía para jugar por Internet (túnel de Cloudflare)
    this.onlineHelp = createOnlineHelp((text, ok) => this.copy(text, ok))
    section.querySelector('#mpOnline')!.addEventListener('click', () => this.onlineHelp.open())
    ui.where.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) this.onlineHelp.open()
    })

    // chat
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Enter' && e.code !== 'NumpadEnter') return
      const t = e.target as HTMLElement | null
      if (t && ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName)) return
      if (!this.inRoom || this.app.menuOpen) return
      e.preventDefault()
      this.openChat()
    })
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const text = chatInput.value.trim()
        if (text) this.send({ t: 'chat', text })
        this.closeChat()
      } else if (e.key === 'Escape') this.closeChat()
      e.stopPropagation()
    })
    chatInput.addEventListener('blur', () => this.closeChat())
  }

  private save(): void {
    try {
      localStorage.setItem(STORE, JSON.stringify(this.stored))
    } catch {
      /* sin almacenamiento */
    }
  }

  private roomLink(): string {
    const u = new URL(location.href)
    u.search = ''
    u.hash = ''
    u.searchParams.set('sala', this.code)
    return u.toString()
  }

  private setUrlCode(code: string): void {
    try {
      const u = new URL(location.href)
      if (code) u.searchParams.set('sala', code)
      else u.searchParams.delete('sala')
      history.replaceState(history.state, '', u)
    } catch {
      /* ignorar */
    }
  }

  private copy(text: string, ok: string): void {
    const fallback = () => {
      const ta = el('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const done = document.execCommand('copy')
      ta.remove()
      this.hooks.toast(done ? ok : text)
    }
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => this.hooks.toast(ok), fallback)
    else fallback()
  }

  private setStatus(msg: string, error = false): void {
    this.ui.status.textContent = msg
    this.ui.status.classList.toggle('mp-error', error)
  }

  private openChat(): void {
    const i = this.ui.chatInput
    i.classList.remove('hidden')
    this.ui.chat.classList.add('open')
    i.value = ''
    i.focus()
  }

  private closeChat(): void {
    const i = this.ui.chatInput
    if (i.classList.contains('hidden')) return
    i.classList.add('hidden')
    this.ui.chat.classList.remove('open')
    i.blur()
  }

  private chatLine(name: string, color: string, text: string, system = false): void {
    const line = el('div', system ? 'mp-line mp-sys' : 'mp-line')
    if (!system) {
      const b = el('b', '', `${name}: `)
      b.style.color = color
      line.append(b)
    }
    line.append(document.createTextNode(text))
    const log = this.ui.chatLog
    log.appendChild(line)
    while (log.children.length > 40) log.firstElementChild?.remove()
    setTimeout(() => line.classList.add('old'), 12000)
  }

  private system(text: string, peerId?: number): void {
    const color = peerId !== undefined ? this.peers.get(peerId)?.color : undefined
    this.chatLine('', color ?? '', text, true)
  }

  /** Estado del menú (dentro/fuera de sala, lista de pilotos). */
  private refreshUI(): void {
    const ui = this.ui
    const inRoom = this.inRoom
    ui.out.classList.toggle('hidden', inRoom)
    ui.inRoom.classList.toggle('hidden', !inRoom)
    ui.list.classList.toggle('hidden', !inRoom)
    ui.collWrap.classList.toggle('hidden', !inRoom || !this.isHost)
    ui.chat.classList.toggle('hidden', !inRoom)
    this.refreshTagsBtn()
    ui.roomCode.textContent = this.code
    // ¿les sirve el enlace a los demás desde esta dirección?
    const kind = hostKind()
    const where = ui.where
    where.replaceChildren()
    if (inRoom && kind === 'local') {
      where.append(t('mp.whereLocal'))
      const b = el('button', 'mp-linkbtn', t('mp.howOnline'))
      b.type = 'button'
      where.append(b)
    } else if (inRoom && kind === 'tunnel') where.append(t('mp.whereTunnel'))
    else if (inRoom && kind === 'lan') where.append(t('mp.whereLan'))
    where.className = `mp-where-note ${kind}${where.childNodes.length ? '' : ' hidden'}`
    ui.list.replaceChildren()
    if (!inRoom) return
    const rows: { name: string; color: string; host: boolean; aircraft: string; me: boolean }[] = [
      {
        name: this.stored.name,
        color: PEER_COLORS[this.slot % PEER_COLORS.length],
        host: this.isHost,
        aircraft: this.app.settings.aircraft,
        me: true,
      },
    ]
    for (const p of this.peers.values())
      rows.push({ name: p.info.name, color: p.color, host: p.info.id === this.hostId, aircraft: p.info.aircraft, me: false })
    for (const row of rows) {
      const li = el('li')
      const dot = el('i', 'mp-dot')
      dot.style.background = row.color
      li.append(dot, el('b', '', row.name))
      if (row.me) li.append(el('span', 'mp-badge', t('mp.you')))
      if (row.host) li.append(el('span', 'mp-badge host', t('mp.host')))
      li.append(el('small', 'muted', aircraftName(aircraftById(row.aircraft))))
      ui.list.append(li)
    }
    const count = el('li', 'mp-count muted', t('mp.count', { n: rows.length, max: MAX_PLAYERS }))
    ui.list.append(count)
  }

  /** Lista compacta de pilotos durante el vuelo (arriba a la derecha). */
  private refreshHud(): void {
    const ui = this.ui
    const show = this.inRoom && !this.app.menuOpen
    ui.hud.classList.toggle('hidden', !show)
    if (!show) {
      this.hudRect = null
      return
    }
    ui.hudCode.textContent = this.code
    ui.hudCount.textContent = ` · ${this.peers.size + 1}/${MAX_PLAYERS}`
    const ac = this.app.ac
    const rows: HTMLElement[] = []
    for (const p of [...this.peers.values()].sort((a, b) => a.info.slot - b.info.slot)) {
      const li = el('li')
      const dot = el('i', 'mp-dot')
      dot.style.background = p.color
      li.append(dot, el('b', '', p.info.name))
      let info: string
      if (!p.active) info = t(p.status === ST_LOADING ? 'mp.loading' : 'mp.noSignal')
      else if (p.status === ST_PAUSED) info = t('mp.inMenu')
      else if (p.status === ST_CRASHED) info = t('mp.crashed')
      else {
        const d = p.pose.pos.distanceTo(ac.pos)
        const hdg = bearing(ac.pos, p.pose.pos)
        info = `${fmtDistance(d)} · ${String(Math.round(hdg)).padStart(3, '0')}°`
      }
      li.append(el('span', 'mp-hud-info', info))
      rows.push(li)
    }
    if (!rows.length) rows.push(el('li', 'muted', t('mp.waiting')))
    ui.hudList.replaceChildren(...rows)
    this.hudRect = ui.hud.getBoundingClientRect()
  }
}

/** Rumbo verdadero (°) de a hacia b en el marco local (X este, Z sur). */
function bearing(a: Vector3, b: Vector3): number {
  const e = b.x - a.x
  const n = -(b.z - a.z)
  return ((Math.atan2(e, n) / DEG) + 360) % 360
}

// ---------------------------------------------------------------------------
// Geometría de choque: puntos del fuselaje y disco del rotor
// ---------------------------------------------------------------------------
class Shape {
  readonly body = BODY_PTS.map(() => new Vector3())
  readonly hub = new Vector3()
  readonly normal = new Vector3()
  readonly rim = Array.from({ length: RIM_N }, () => new Vector3())
}

const _a = new Vector3()
const _b = new Vector3()
const _mine = new Shape()
const _theirs = new Shape()

function shapeOf(pose: AircraftPose, s: Shape): Shape {
  for (let i = 0; i < BODY_PTS.length; i++) s.body[i].copy(BODY_PTS[i]).applyQuaternion(pose.quat).add(pose.pos)
  s.hub.copy(pose.hubBody).applyQuaternion(pose.quat).add(pose.pos)
  s.normal.copy(pose.rotor.normal).normalize()
  // base del plano del disco
  _a.set(1, 0, 0).applyQuaternion(pose.quat)
  _a.addScaledVector(s.normal, -_a.dot(s.normal)).normalize()
  _b.crossVectors(s.normal, _a)
  for (let i = 0; i < RIM_N; i++) {
    const ang = (i / RIM_N) * Math.PI * 2
    s.rim[i]
      .copy(s.hub)
      .addScaledVector(_a, Math.cos(ang) * ROTOR_R * 0.97)
      .addScaledVector(_b, Math.sin(ang) * ROTOR_R * 0.97)
  }
  return s
}

/** ¿Algún punto atraviesa el disco del rotor (una lámina de ±0,35 m)? */
function discHit(s: Shape, pts: Vector3[]): boolean {
  for (const p of pts) {
    _a.subVectors(p, s.hub)
    const h = _a.dot(s.normal)
    if (Math.abs(h) > 0.35) continue
    const rr = _a.lengthSq() - h * h
    if (rr < ROTOR_R * ROTOR_R) return true
  }
  return false
}

function shapesHit(a: Shape, b: Shape): boolean {
  // fuselaje contra fuselaje
  for (const p of a.body) for (const q of b.body) if (p.distanceToSquared(q) < 0.95 * 0.95) return true
  // palas contra fuselaje o palas
  if (discHit(a, b.body) || discHit(b, a.body)) return true
  if (discHit(a, b.rim) || discHit(b, a.rim)) return true
  if (discHit(a, [b.hub]) || discHit(b, [a.hub])) return true
  return false
}
