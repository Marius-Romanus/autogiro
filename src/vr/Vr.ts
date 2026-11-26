/// <reference types="webxr" />
// Realidad virtual (WebXR) en la cabina.
//
// - La imagen sale de la misma cadena que la pantalla normal (Graphics.renderEyes): el compositor
//   entero por cada ojo, con lo común (sombras, sonda de sol, agua, tiempo) una vez por fotograma.
// - El cuerpo va con el aparato y la cabeza la mueve el jugador: la vista es la del asiento del
//   piloto (el mismo punto de la cámara de cabina) más la postura que da el visor respecto a donde
//   se recentró. Sin vibración de rotor, sin cabeceo por fuerzas g y sin suavizados: nada que la
//   cabeza no haya hecho.
// - En un accidente la vista se queda quieta y derecha donde estaba (con un parpadeo en negro al
//   soltarse del aparato): dar vueltas dentro de los restos marea a cualquiera.
// - Sin visor: «VR en pantalla» (ScreenDevice) dibuja los dos ojos lado a lado con la misma ruta.
//
// Notas técnicas: DESARROLLO.md «Realidad virtual».

import { Matrix4, Quaternion, Vector3, type PerspectiveCamera } from 'three'
import type { EyeView, Graphics } from '../render/Graphics.ts'
import type { Action, Input } from '../input/Input.ts'
import { t } from '../i18n.ts'
import { CloudsStereo } from './cloudsStereo.ts'
import { ScreenDevice, XrDevice, type DeviceEye, type VrDevice, type VrPad } from './VrDevice.ts'
import { domBlock, VrPanel, type PanelContent } from './VrPanel.ts'
import './vrText.ts'

/** ¿Puede este navegador abrir una sesión de realidad virtual? */
export type VrSupport = 'unknown' | 'checking' | 'yes' | 'no' | 'none'

/** Preferencias de la realidad virtual (aparte de los ajustes de la partida). */
export interface VrPrefs {
  /** el jugador la ha activado en Ajustes: solo entonces se pregunta al sistema si hay visor */
  on: boolean
  /** tablilla de avisos encendida */
  panel: boolean
  /** resolución respecto a la que recomienda el visor */
  scale: number
  /** cuánto del detalle de la pantalla normal se dibuja en el visor (VR_DETAIL) */
  detail: VrDetail
}

export type VrDetail = 'smooth' | 'balanced' | 'full'
/**
 * Perfiles de detalle del visor. La partida está limitada por la CPU (llamadas de dibujo) y en
 * estéreo el terreno se dibuja dos veces, así que lo que se recorta es eso: `terrain` multiplica el
 * error admitido en las teselas (menos teselas, foto del suelo menos nítida) y `normals` es el pase
 * de normales del relieve (otra pasada entera del terreno por ojo; sin él, el suelo se ilumina como
 * si fuera llano, como en las calidades Baja y Media). Medidas en DESARROLLO.md «Realidad virtual».
 */
export const VR_DETAIL: Record<VrDetail, { terrain: number; normals: boolean }> = {
  smooth: { terrain: 2, normals: false },
  balanced: { terrain: 1.5, normals: false },
  full: { terrain: 1, normals: true },
}

const STORE = 'autogiro.vr.v1'
const DEFAULT_PREFS: VrPrefs = { on: false, panel: true, scale: 1, detail: 'balanced' }

export function loadVrPrefs(): VrPrefs {
  try {
    const raw = localStorage.getItem(STORE)
    if (raw) {
      const p = { ...DEFAULT_PREFS, ...JSON.parse(raw) } as VrPrefs
      p.scale = Math.min(1.5, Math.max(0.5, Number(p.scale) || 1))
      if (!(p.detail in VR_DETAIL)) p.detail = DEFAULT_PREFS.detail
      return p
    }
  } catch {
    /* sin almacenamiento */
  }
  return { ...DEFAULT_PREFS }
}

export interface VrHost {
  gfx: Graphics
  input: Input
  toast(msg: string, secs?: number): void
  /** Repone el tamaño y la calidad de la pantalla normal al salir. */
  restoreScreen(): void
  /** Al entrar (y al cambiar el perfil de detalle con la sesión abierta): cámara de cabina y detalle del visor. */
  entered(): void
  /** PTT de la radio desde el gatillo de un mando. */
  ptt(held: boolean): void
  /** Radio: quién habla ('' = nadie). */
  radio(): string
}

/** Punto de vista del piloto para este fotograma. */
export interface VrSeat {
  /** ojos del piloto en el mundo (AircraftView.eyeWorld) */
  eye: Vector3
  /** actitud del aparato */
  quat: Quaternion
  /** tras un accidente: la vista se suelta del aparato */
  crashed: boolean
}

/** ejes de una cámara (−Z al frente) → ejes del aparato (+X al frente): como CameraRig */
const BASE = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -Math.PI / 2)
/** parpadeo en negro al soltar la vista del aparato o al volver a él (s) */
const BLINK = 0.22
/** margen del campo de la cámara de la cabeza sobre el de los ojos (tangente) */
const HEAD_MARGIN = 0.07

const _v = new Vector3()
const _v2 = new Vector3()
const _q = new Quaternion()
const _s = new Vector3(1, 1, 1)
const _m = new Matrix4()
const _rel = new Matrix4()

export class Vr {
  readonly prefs = loadVrPrefs()
  support: VrSupport = 'unknown'
  device: VrDevice | null = null
  readonly panel = new VrPanel()
  /** se llama cuando cambia algo que la interfaz enseña (soporte, sesión abierta o cerrada) */
  onChange: (() => void) | null = null
  /** tiempo entre fotogramas del visor, suavizado (ms) */
  frameMs = 0
  private readonly host: VrHost
  private clouds: CloudsStereo | null = null
  private entering = false
  // bucle
  private token = 0
  private pending: ((t: number) => void) | null = null
  private pendingXr = false
  private lastT = 0
  // postura
  /** asiento (cabina) → mundo */
  private readonly seat = new Matrix4()
  /** espacio del visor → asiento (lo fija «recentrar») */
  private readonly center = new Matrix4()
  private needCenter = true
  private frozen = false
  private blink = 0
  private views: EyeView[] = []
  private nViews = 0
  private readonly content: PanelContent = { warnings: [], cautions: [], hint: '', radio: '', toast: '', blocks: [], foot: '' }
  private contentT = 0
  // mandos
  private readonly held = new Set<string>()
  private pttHeld = false

  constructor(host: VrHost) {
    this.host = host
    this.panel.enabled = this.prefs.panel
    navigator.xr?.addEventListener?.('devicechange', () => {
      if (this.prefs.on && !this.device) void this.probe()
    })
  }

  get active(): boolean {
    return this.device !== null
  }

  /** sesión con visor de verdad (no la vista en pantalla) */
  get immersive(): boolean {
    return this.device?.kind === 'xr'
  }

  savePrefs(): void {
    try {
      localStorage.setItem(STORE, JSON.stringify(this.prefs))
    } catch {
      /* sin almacenamiento */
    }
  }

  /**
   * Pregunta al navegador si puede abrir una sesión `immersive-vr`. Solo se llama cuando el
   * jugador ha activado la realidad virtual: con SteamVR u otro runtime de OpenXR instalado, la
   * pregunta puede despertarlo, y eso no debe pasar en cada arranque a quien no usa visor.
   */
  async probe(): Promise<VrSupport> {
    const xr = navigator.xr
    if (!xr || !window.isSecureContext) this.support = 'none'
    else {
      this.support = 'checking'
      this.onChange?.()
      try {
        this.support = (await xr.isSessionSupported('immersive-vr')) ? 'yes' : 'no'
      } catch {
        this.support = 'no'
      }
    }
    this.onChange?.()
    return this.support
  }

  // ---- sesión ----

  /** Abre la sesión (desde un gesto del jugador): con el visor o, sin él, la vista en pantalla. */
  async enter(kind: 'xr' | 'screen', screen?: { eyeW?: number; eyeH?: number; ipd?: number }): Promise<boolean> {
    if (this.device || this.entering) return false
    this.entering = true
    try {
      const r = this.host.gfx.renderer
      let device: VrDevice
      if (kind === 'xr') device = await XrDevice.open(r, this.prefs.scale)
      else {
        const k = this.prefs.scale
        device = new ScreenDevice({ eyeW: Math.round((screen?.eyeW ?? 1832) * k), eyeH: Math.round((screen?.eyeH ?? 1920) * k), ipd: screen?.ipd })
      }
      device.onEnd = () => this.ended(device)
      this.device = device
      this.host.gfx.beginVr(device.eyeW, device.eyeH)
      this.clouds = new CloudsStereo(this.host.gfx.clouds)
      this.panel.attach(this.host.gfx.scene)
      this.needCenter = true
      this.frozen = false
      this.blink = 0
      this.frameMs = 0
      this.lastT = 0
      this.host.entered()
      this.onChange?.()
      return true
    } catch (e) {
      console.warn('VR:', e)
      this.host.toast(t('vr.failed'), 5)
      return false
    } finally {
      this.entering = false
    }
  }

  /** Cierra la sesión y vuelve a la pantalla normal. */
  exit(): void {
    void this.device?.end()
  }

  private ended(device: VrDevice): void {
    if (this.device !== device) return
    this.device = null
    const g = this.host.gfx
    this.clouds?.dispose()
    this.clouds = null
    this.panel.detach()
    this.host.input.xr = null
    if (this.pttHeld) this.host.ptt(false)
    this.pttHeld = false
    this.held.clear()
    this.nViews = 0
    g.endVr()
    this.host.restoreScreen()
    // el fotograma pedido a la sesión ya no llegará: sigue el bucle por la ventana
    if (this.pending && this.pendingXr) {
      const tk = this.token
      requestAnimationFrame((tt) => this.fire(tk, tt))
      this.pendingXr = false
    }
    this.onChange?.()
  }

  // ---- bucle ----

  /** Pide el siguiente fotograma: al visor mientras dura la sesión, a la ventana si no. */
  schedule(cb: (t: number) => void): void {
    const tk = ++this.token
    this.pending = cb
    const d = this.device
    this.pendingXr = d?.kind === 'xr'
    if (d) d.requestFrame((tt) => this.fire(tk, tt))
    else requestAnimationFrame((tt) => this.fire(tk, tt))
  }

  private fire(tk: number, tt: number): void {
    if (tk !== this.token) return
    const cb = this.pending
    this.pending = null
    if (this.device) {
      if (this.lastT) {
        const ms = tt - this.lastT
        this.frameMs = this.frameMs ? this.frameMs + (ms - this.frameMs) * 0.05 : ms
      }
      this.lastT = tt
    }
    cb?.(tt)
  }

  // ---- postura ----

  /** La próxima postura del visor pasa a ser "sentado y mirando al frente". */
  recenter(): void {
    this.needCenter = true
  }

  /** Cabeza simulada de la vista en pantalla (arrastre del ratón). */
  look(dx: number, dy: number): void {
    const d = this.device
    if (d instanceof ScreenDevice) {
      d.yaw -= dx * 0.004
      d.pitch = Math.max(-1.4, Math.min(1.4, d.pitch - dy * 0.004))
    }
  }

  /** El re-centrado del mundo (origen flotante) también mueve la vista suelta de un accidente. */
  rebase(m: Matrix4): void {
    if (this.frozen) this.seat.premultiply(m)
  }

  /**
   * Coloca la cámara de la escena en la cabeza del piloto (con un campo que cubre los dos ojos:
   * con ella se eligen las teselas y se recorta lo que no se ve) y prepara las vistas de cada ojo.
   */
  frame(dt: number, seat: VrSeat, hud: { warnings: string[]; cautions?: string[]; hint: string } | null): void {
    const d = this.device
    if (!d) return
    const cam = this.host.gfx.camera
    this.blink = Math.max(0, this.blink - dt)

    // asiento → mundo
    if (seat.crashed) {
      if (!this.frozen) {
        // suelta la vista: quieta y derecha, mirando hacia donde miraba el aparato
        this.frozen = true
        this.blink = BLINK
        _v.set(0, 0, -1).applyQuaternion(_q.copy(seat.quat).multiply(BASE))
        if (Math.hypot(_v.x, _v.z) < 0.2) _v.set(0, 1, 0).applyQuaternion(_q)
        _q.setFromAxisAngle(_v2.set(0, 1, 0), Math.atan2(-_v.x, -_v.z))
        this.seat.compose(_v.setFromMatrixPosition(this.seat), _q, _s)
      }
    } else {
      if (this.frozen) {
        this.frozen = false
        this.blink = BLINK
      }
      this.seat.compose(seat.eye, _q.copy(seat.quat).multiply(BASE), _s)
    }

    const eyes = d.eyes()
    if (!eyes) {
      this.nViews = 0
      return
    }
    if (this.needCenter) {
      this.needCenter = false
      // solo la guiñada: el horizonte de la sala es el de la cabina
      _v.set(0, 0, -1).transformDirection(d.head)
      _q.setFromAxisAngle(_v2.set(0, 1, 0), Math.atan2(-_v.x, -_v.z))
      this.center.compose(_v.setFromMatrixPosition(d.head), _q, _s).invert()
    }
    // espacio del visor → mundo
    _m.multiplyMatrices(this.seat, this.center)

    // cámara de la cabeza
    _rel.multiplyMatrices(_m, d.head)
    _rel.decompose(cam.position, cam.quaternion, _v)
    this.headProjection(cam, d, eyes)
    cam.updateMatrixWorld(true)

    // vistas de cada ojo
    this.nViews = eyes.length
    for (let i = 0; i < eyes.length; i++) {
      const e = eyes[i]
      const v = (this.views[i] ??= { matrix: new Matrix4(), projection: new Matrix4(), fov: 90, x: 0, y: 0, w: 1, h: 1 })
      v.matrix.multiplyMatrices(_m, e.matrix)
      const n = cam.near
      v.projection.makePerspective(e.left * n, e.right * n, e.up * n, e.down * n, n, cam.far, cam.coordinateSystem, cam.reversedDepth)
      v.fov = ((Math.atan(e.up) - Math.atan(e.down)) * 180) / Math.PI
      v.x = e.x
      v.y = e.y
      v.w = e.w
      v.h = e.h
    }
    // (el visor puede cambiar el tamaño de sus vistas)
    const g = this.host.gfx
    if (eyes[0].w !== g.vrWidth || eyes[0].h !== g.vrHeight) g.beginVr(eyes[0].w, eyes[0].h)

    // tablilla de avisos
    this.contentT -= dt
    if (this.contentT <= 0) {
      this.contentT = 0.2
      this.gather(hud, seat.crashed)
    }
    // (tras un accidente el asiento es la vista suelta: la tablilla sigue en su sitio, a la izquierda)
    this.panel.update(this.seat, this.content, g.renderer.toneMappingExposure)
  }

  /** Campo simétrico que cubre el de los dos ojos, visto desde la cabeza. */
  private headProjection(cam: PerspectiveCamera, d: VrDevice, eyes: DeviceEye[]): void {
    let th = 0
    let tv = 0
    _m.copy(d.head).invert()
    for (const e of eyes) {
      _rel.multiplyMatrices(_m, e.matrix)
      for (let k = 0; k < 4; k++) {
        _v.set(k & 1 ? e.right : e.left, k & 2 ? e.up : e.down, -1).transformDirection(_rel)
        if (_v.z > -0.05) continue
        th = Math.max(th, Math.abs(_v.x / _v.z))
        tv = Math.max(tv, Math.abs(_v.y / _v.z))
      }
    }
    // (frame() reutiliza _m: se vuelve a calcular allí antes de usarlo)
    _m.multiplyMatrices(this.seat, this.center)
    if (!th || !tv) return
    th += HEAD_MARGIN
    tv += HEAD_MARGIN
    const fov = (2 * Math.atan(tv) * 180) / Math.PI
    const aspect = th / tv
    if (Math.abs(cam.fov - fov) > 0.01 || Math.abs(cam.aspect - aspect) > 1e-4) {
      cam.fov = fov
      cam.aspect = aspect
      cam.updateProjectionMatrix()
    }
  }

  /** Dibuja el fotograma en el visor. false si no había nada que dibujar (el visor no da postura). */
  render(dt: number): boolean {
    const d = this.device
    if (!d || !this.nViews) return false
    const g = this.host.gfx
    const r = g.renderer
    const target = d.target(r)
    if (this.blink > 0) {
      target.viewport.set(0, 0, target.width, target.height)
      target.scissorTest = false
      r.setRenderTarget(target)
      r.setClearColor(0x000000, 1)
      r.clear(true, false, false)
      r.setRenderTarget(null)
    } else {
      const c = this.clouds
      g.renderEyes(dt, this.views.slice(0, this.nViews), target, c && g.cloudsEnabled ? (i, begin) => (begin ? c.begin(i) : c.end(i)) : undefined)
    }
    d.present(r)
    return true
  }

  // ---- tablilla ----

  /** Alterna la tablilla de avisos (tecla I con el visor puesto). */
  togglePanel(): boolean {
    this.prefs.panel = this.panel.enabled = !this.panel.enabled
    this.savePrefs()
    return this.panel.enabled
  }

  private gather(hud: { warnings: string[]; cautions?: string[]; hint: string } | null, crashed: boolean): void {
    const c = this.content
    c.warnings = hud?.warnings ?? []
    c.cautions = hud?.cautions ?? []
    c.hint = hud?.hint ?? ''
    c.radio = this.host.radio()
    const toast = document.getElementById('toast')
    c.toast = toast?.classList.contains('show') ? (toast.textContent ?? '') : ''
    c.blocks = []
    // radio del tráfico del aeródromo: los dos últimos mensajes
    const atc = document.getElementById('atc-log')
    if (atc && atc.children.length && atc.getClientRects().length) {
      const lines = [...atc.children].slice(-2).map((e) => (e.textContent ?? '').trim()).filter(Boolean)
      if (lines.length) c.blocks.push({ title: t('vr.radioT'), lines })
    }
    const add = (id: string, max?: number): void => {
      const b = domBlock(document.getElementById(id), max)
      if (b) c.blocks.push(b)
    }
    if (crashed) {
      const title = document.getElementById('crash-title')?.textContent ?? ''
      const detail = document.getElementById('crash-detail')?.textContent ?? ''
      if (title) c.blocks.push({ title, lines: [detail, t('vr.crashKeys')].filter(Boolean) })
    }
    add('school-card', 10)
    add('tips', 12)
    c.foot = c.blocks.length ? t('vr.foot') : ''
  }

  // ---- mandos de realidad virtual ----

  /**
   * Mandos del visor → mandos de vuelo (antes de Input.update). Como un mando de consola: palanca
   * en la palanquita derecha, pedales y gas en la izquierda, freno en el gatillo izquierdo,
   * prerrotador en el agarre derecho y PTT de la radio en el gatillo derecho.
   */
  controls(trigger: (a: Action) => void): void {
    const d = this.device
    const input = this.host.input
    const pads = d ? d.pads() : []
    if (!pads.length) {
      input.xr = null
      if (this.pttHeld) this.host.ptt((this.pttHeld = false))
      return
    }
    const x = (input.xr ??= { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0, prerotator: false })
    x.pitch = x.roll = x.yaw = x.throttle = x.brake = 0
    x.prerotator = false
    let ptt = false
    const edge = (key: string, down: boolean, a: Action): void => {
      if (down && !this.held.has(key)) trigger(a)
      if (down) this.held.add(key)
      else this.held.delete(key)
    }
    for (const p of pads) {
      if (p.hand === 'right') {
        x.pitch = p.y
        x.roll = p.x
        x.prerotator = p.squeeze > 0.5
        ptt = p.trigger > 0.5
        edge('r.click', p.click, 'vrCenter')
        edge('r.a', p.a, 'parkBrake')
        edge('r.b', p.b, 'rotorBrake')
      } else {
        x.yaw = p.x
        x.throttle = -p.y
        x.brake = p.trigger
        edge('l.a', p.a, 'engine')
        edge('l.b', p.b, 'hud')
      }
    }
    if (ptt !== this.pttHeld) this.host.ptt((this.pttHeld = ptt))
  }

  /** Mandos simulados para las pruebas de la vista en pantalla. */
  fakePads(pads: VrPad[]): void {
    if (this.device instanceof ScreenDevice) this.device.fakePads = pads
  }
}
