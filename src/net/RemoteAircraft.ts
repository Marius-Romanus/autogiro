// Autogiro de otro piloto: guarda sus instantáneas de estado, las interpola con
// un pequeño retardo (vuelo suave aunque la red tenga altibajos) y anima el modelo.

import { Matrix4, Quaternion, Vector3, type Camera, type Object3D, type PerspectiveCamera, type Texture } from 'three'
import { Ellipsoid } from '@takram/three-geospatial'
import { AircraftView, type AircraftPose } from '../aircraft/AircraftView.ts'
import { aircraftById } from '../aircraft/catalog.ts'
import { airframeById } from '../sim/airframes.ts'
import { t } from '../i18n.ts'
import type { PeerInfo, StateMsg } from './protocol.ts'

/** retardo de interpolación (ms): ~1,5 envíos a 15 Hz */
const INTERP_DELAY = 110
/** extrapolación máxima con la última velocidad conocida (ms) */
const MAX_EXTRAP = 500
const RPM_TO_RAD = Math.PI / 30

export const PEER_COLORS = ['#ff7a45', '#4fc3f7', '#aed581', '#f06292', '#ffd54f', '#b39ddb', '#4db6ac', '#e57373']

// estados de StateMsg.st
export const ST_LOADING = 0
export const ST_FLYING = 1
export const ST_CRASHED = 2
export const ST_PAUSED = 3

interface Snap {
  ts: number
  p: Vector3 // ECEF, en el datum común (ver Multiplayer.datumShift)
  q: Quaternion // cuerpo → ECEF
  v: Vector3
  n: Vector3
  hb: Vector3
  rr: number
  er: number
  hp: number
  hr: number
  rd: number
  ns: number
  sp: number
  sr: number
  th: number
  wb: number
  g: boolean
  ag: number
}

/** Pose de un aparato remoto en el mundo local, con la forma que espera AircraftView. */
export class RemotePose implements AircraftPose {
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
  onGround = false
  /** altura del CG sobre el suelo que ve el otro piloto (m) */
  agl = 0
}

const _p = new Vector3()
const _n = new Vector3()
const _q = new Quaternion()
const _c = new Vector3()

/** Márgenes (px) de la zona donde van las etiquetas y las flechas de borde. */
export interface ScreenInset {
  top: number
  right: number
  bottom: number
  left: number
  /** esquina superior derecha ocupada (lista de pilotos): x desde donde empieza, y hasta donde llega; 0 = libre */
  notchLeft: number
  notchBottom: number
}

const ARROW_SVG =
  '<svg viewBox="-12 -12 24 24" aria-hidden="true"><path d="M10 0 L-7 -8 L-3 0 L-7 8 Z" fill="currentColor" stroke="rgba(0,0,0,0.75)" stroke-width="1.6" stroke-linejoin="round"/></svg>'

function finite(a: unknown, len: number): a is number[] {
  if (!Array.isArray(a) || a.length !== len) return false
  for (const x of a) if (typeof x !== 'number' || !Number.isFinite(x)) return false
  return true
}

export class RemoteAircraft {
  info: PeerInfo
  readonly color: string
  readonly view = new AircraftView()
  /** pose interpolada (lo que se dibuja) */
  readonly pose = new RemotePose()
  /** pose extrapolada al instante actual (para los choques) */
  readonly now = new RemotePose()
  readonly ctl = { pitch: 0, roll: 0, throttle: 0, wheelBrake: 0 }
  status = ST_LOADING
  /** ms (reloj local) de la última instantánea */
  lastRecv = 0
  /** ms (reloj local) del último cambio de aparición */
  spawnedAt = 0
  /** se ha dibujado este fotograma (hay datos y está en vuelo/accidentado/pausa) */
  active = false
  /** distancia a la cámara (m) */
  distance = Infinity
  readonly tag: HTMLDivElement
  private readonly tagName: HTMLElement
  private readonly tagInfo: HTMLElement
  /** flecha en el borde de la pantalla cuando el aparato queda fuera de ella */
  private readonly edge: HTMLDivElement
  private readonly edgeArrow: HTMLElement
  private readonly edgeLabel: HTMLElement
  private readonly edgeName: HTMLElement
  private readonly edgeInfo: HTMLElement
  private edgeW = 0
  private edgeH = 0
  private snaps: Snap[] = []
  private seq = -1
  /** estimación de (reloj local − reloj del emisor), envolvente inferior */
  private offset = NaN
  private model = ''
  private envMap: Texture | null = null
  private localGround = { y: 0, at: -1e9, x: 0, z: 0, ok: false }
  /** corrección vertical aplicada este fotograma para asentarlo en nuestro relieve */
  private yCorr = 0
  /** luces exteriores encendidas según la última instantánea */
  private lightsOn = false

  constructor(info: PeerInfo, parent: Object3D, tagLayer: HTMLElement) {
    this.info = info
    this.color = PEER_COLORS[info.slot % PEER_COLORS.length]
    // sin SpotLight: cada aparato que entra o sale recompilaría todos los materiales
    this.view.lights.useSpot = false
    parent.add(this.view.root)
    this.view.root.visible = false
    this.tag = document.createElement('div')
    this.tag.className = 'mp-tag'
    this.tag.style.display = 'none'
    this.tagName = document.createElement('b')
    this.tagName.style.color = this.color
    this.tagInfo = document.createElement('span')
    this.tag.append(this.tagName, this.tagInfo)
    this.edge = document.createElement('div')
    this.edge.className = 'mp-edge'
    this.edge.style.display = 'none'
    this.edgeArrow = document.createElement('i')
    this.edgeArrow.className = 'mp-edge-arrow'
    this.edgeArrow.style.color = this.color
    this.edgeArrow.innerHTML = ARROW_SVG
    this.edgeLabel = document.createElement('div')
    this.edgeLabel.className = 'mp-edge-label'
    this.edgeName = document.createElement('b')
    this.edgeName.style.color = this.color
    this.edgeInfo = document.createElement('span')
    this.edgeLabel.append(this.edgeName, this.edgeInfo)
    this.edge.append(this.edgeArrow, this.edgeLabel)
    tagLayer.append(this.tag, this.edge)
    this.setInfo(info)
  }

  setInfo(info: PeerInfo): void {
    this.info = info
    this.tagName.textContent = info.name
    this.edgeName.textContent = info.name
    this.edgeW = 0 // volver a medir
    const m = aircraftById(info.aircraft)
    if (m.id !== this.model) {
      this.model = m.id
      void this.view.load(`${import.meta.env.BASE_URL}${m.url}`, airframeById(m.id)).then(() => {
        this.view.setPassenger(this.info.passenger)
        if (this.envMap) this.view.setEnvMap(this.envMap)
      })
    }
    this.view.setPassenger(info.passenger)
  }

  setEnvMap(tex: Texture | null): void {
    this.envMap = tex
    if (this.view.loaded) this.view.setEnvMap(tex)
  }

  /** Nueva instantánea de la red. `shiftIn`: metros a sumar sobre la normal (datum propio). */
  push(m: StateMsg, nowMs: number): void {
    if (typeof m.ts !== 'number' || !finite(m.p, 3) || !finite(m.q, 4) || !finite(m.v, 3) || !finite(m.n, 3) || !finite(m.hb, 3)) return
    if (m.sq !== this.seq) {
      // nueva aparición (reinicio, cambio de lugar): nada de interpolar desde la anterior
      this.seq = m.sq
      this.snaps.length = 0
      this.offset = NaN
      this.spawnedAt = nowMs
    }
    const o = nowMs - m.ts
    if (Number.isNaN(this.offset) || o < this.offset) this.offset = o
    else this.offset += (o - this.offset) * 0.01 // deriva lenta de relojes
    const last = this.snaps[this.snaps.length - 1]
    if (last && m.ts <= last.ts) return // desordenado o repetido
    const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
    this.snaps.push({
      ts: m.ts,
      p: new Vector3().fromArray(m.p),
      q: new Quaternion().fromArray(m.q).normalize(),
      v: new Vector3().fromArray(m.v),
      n: new Vector3().fromArray(m.n).normalize(),
      hb: new Vector3().fromArray(m.hb),
      rr: num(m.rr),
      er: num(m.er),
      hp: num(m.hp),
      hr: num(m.hr),
      rd: num(m.rd),
      ns: num(m.ns),
      sp: num(m.sp),
      sr: num(m.sr),
      th: num(m.th),
      wb: num(m.wb),
      g: m.g === 1,
      ag: num(m.ag),
    })
    if (this.snaps.length > 60) this.snaps.shift()
    this.lastRecv = nowMs
    this.status = num(m.st)
    this.lightsOn = m.li === 1
  }

  /**
   * Pose en el reloj del emisor `t` (ms) → mundo local. Devuelve false si no hay datos.
   * ecefToWorld/qE2W: marco local actual; shift: metros a sumar sobre la vertical (datum).
   */
  private sampleInto(out: RemotePose, t: number, ecefToWorld: Matrix4, qE2W: Quaternion, shift: number): boolean {
    const s = this.snaps
    if (!s.length) return false
    let a = s[0]
    let b = s[0]
    let k = 0
    if (t >= s[s.length - 1].ts) {
      a = b = s[s.length - 1]
    } else if (t > s[0].ts) {
      for (let i = 0; i < s.length - 1; i++) {
        if (s[i + 1].ts > t) {
          a = s[i]
          b = s[i + 1]
          k = (t - a.ts) / Math.max(1, b.ts - a.ts)
          break
        }
      }
    }
    const lerp = (x: number, y: number) => x + (y - x) * k
    _p.copy(a.p).lerp(b.p, k)
    if (a === b && t > a.ts && this.status === ST_FLYING) {
      // sin datos nuevos: sigue con la última velocidad un momento
      _p.addScaledVector(a.v, Math.min(MAX_EXTRAP, t - a.ts) / 1000)
    }
    if (shift) {
      Ellipsoid.WGS84.getSurfaceNormal(_p, _n)
      _p.addScaledVector(_n, shift)
    }
    out.pos.copy(_p).applyMatrix4(ecefToWorld)
    _q.copy(a.q).slerp(b.q, k)
    out.quat.copy(qE2W).multiply(_q)
    out.vel.copy(a.v).lerp(b.v, k).applyQuaternion(qE2W)
    out.rotor.normal.copy(a.n).lerp(b.n, k).normalize().applyQuaternion(qE2W)
    out.hubBody.copy(a.hb).lerp(b.hb, k)
    out.rotor.omega = lerp(a.rr, b.rr) * RPM_TO_RAD
    out.engineRpm = lerp(a.er, b.er)
    out.headPitch = lerp(a.hp, b.hp)
    out.headRoll = lerp(a.hr, b.hr)
    out.rudder = lerp(a.rd, b.rd)
    out.noseSteer = lerp(a.ns, b.ns)
    out.onGround = k < 0.5 ? a.g : b.g
    out.agl = lerp(a.ag, b.ag)
    this.ctl.pitch = lerp(a.sp, b.sp)
    this.ctl.roll = lerp(a.sr, b.sr)
    this.ctl.throttle = lerp(a.th, b.th)
    this.ctl.wheelBrake = lerp(a.wb, b.wb)
    return true
  }

  /** Pose extrapolada al instante actual (sin retardo de interpolación), para detectar choques. */
  predict(nowMs: number, ecefToWorld: Matrix4, qE2W: Quaternion, shift: number): RemotePose | null {
    if (Number.isNaN(this.offset)) return null
    if (!this.sampleInto(this.now, nowMs - this.offset, ecefToWorld, qE2W, shift)) return null
    this.now.pos.y += this.yCorr // misma corrección de relieve que el modelo dibujado
    return this.now
  }

  /**
   * Coloca y anima el modelo. `groundAt`: altura del suelo LOCAL bajo (x, z) o null;
   * cerca del suelo se usa para que el aparato no flote ni se hunda si nuestros
   * relieves difieren (Google frente a MDT del IGN, por ejemplo).
   */
  update(
    dt: number,
    nowMs: number,
    ecefToWorld: Matrix4,
    qE2W: Quaternion,
    shift: number,
    groundAt: (x: number, z: number, yAbove: number) => number | null,
  ): void {
    const t = nowMs - this.offset - INTERP_DELAY
    const ok = !Number.isNaN(this.offset) && this.status !== ST_LOADING && this.sampleInto(this.pose, t, ecefToWorld, qE2W, shift)
    this.active = ok
    this.view.root.visible = ok && this.view.loaded
    if (!ok) return
    // drop de instantáneas viejas (se conserva una anterior a t para interpolar)
    while (this.snaps.length > 2 && this.snaps[1].ts <= t - 200) this.snaps.shift()

    const pose = this.pose
    this.yCorr = 0
    if (pose.agl < 40) {
      const g = this.localGround
      if (nowMs - g.at > 200 || Math.hypot(pose.pos.x - g.x, pose.pos.z - g.z) > 4) {
        const y = groundAt(pose.pos.x, pose.pos.z, pose.pos.y + 60)
        g.ok = y !== null
        if (y !== null) g.y = y
        g.x = pose.pos.x
        g.z = pose.pos.z
        g.at = nowMs
      }
      if (g.ok) {
        const w = pose.agl < 10 ? 1 : 1 - (pose.agl - 10) / 30
        this.yCorr = (g.y + pose.agl - pose.pos.y) * w
        pose.pos.y += this.yCorr
      }
    }
    this.view.update(pose, dt, this.ctl)
  }

  /** Luces exteriores (llamar tras `update`, con la cámara ya colocada). */
  updateLights(dt: number, camera: Camera, exposure: number, sunY: number): void {
    this.view.lights.on = this.lightsOn && this.active
    this.view.lights.update(dt, camera, exposure, sunY)
  }

  /**
   * Etiqueta con nombre, distancia y altura sobre el aparato; si queda fuera de la
   * zona útil de la pantalla (o detrás de la cámara), una flecha en el borde que
   * apunta hacia él. `labels`: el piloto las quiere ver (botón «Amigos», tecla Tab).
   */
  updateTag(
    camera: PerspectiveCamera,
    show: boolean,
    labels: boolean,
    altFt: number | null,
    w: number,
    h: number,
    inset: ScreenInset,
  ): void {
    const pos = this.pose.pos
    this.distance = this.active ? camera.position.distanceTo(pos) : Infinity
    if (!show || !labels || !this.active || this.distance < 6) {
      hide(this.tag)
      hide(this.edge)
      return
    }
    const parts = [fmtDistance(this.distance)]
    if (altFt !== null) parts.push(`${Math.round(altFt / 10) * 10} ft`)
    if (this.status === ST_PAUSED) parts.push(t('mp.inMenu'))
    else if (this.status === ST_CRASHED) parts.push(t('mp.crashed'))
    if (nowStale(this.lastRecv)) parts.push(t('mp.noSignal'))
    const txt = parts.join(' · ')
    const opacity = String(Math.max(0.5, 1 - Math.max(0, this.distance - 1500) / 20000))

    // zona útil (sin la barra superior ni el panel de instrumentos)
    const L = Math.min(inset.left, w * 0.4)
    const R = w - Math.min(inset.right, w * 0.4)
    const T = Math.min(inset.top, h * 0.4)
    const B = h - Math.min(inset.bottom, h * 0.4)
    const NL = inset.notchBottom > T ? Math.max(inset.notchLeft, w * 0.55) : R
    const NB = Math.min(inset.notchBottom, h * 0.45)
    _p.copy(pos)
    _p.y += 3.2
    _c.copy(_p).applyMatrix4(camera.matrixWorldInverse) // espacio de cámara: delante = z < 0
    if (_c.z < 0) {
      _p.project(camera)
      const x = ((_p.x + 1) / 2) * w
      const y = ((1 - _p.y) / 2) * h
      if (x >= L && x <= R && y >= T && y <= B && !(x > NL && y < NB)) {
        hide(this.edge)
        const el = this.tag
        if (el.style.display !== '') el.style.display = ''
        el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`
        el.style.opacity = opacity
        if (this.tagInfo.textContent !== txt) this.tagInfo.textContent = txt
        return
      }
    }
    hide(this.tag)

    // Dirección en pantalla sin dividir por la profundidad: vale también detrás de
    // la cámara (la proyección la reflejaría). Justo detrás → abajo.
    const e = camera.projectionMatrix.elements
    let sx = _c.x * e[0] * (w / 2)
    let sy = -_c.y * e[5] * (h / 2)
    const len = Math.hypot(sx, sy)
    if (len < 1e-6) {
      sx = 0
      sy = 1
    } else {
      sx /= len
      sy /= len
    }
    // del centro de la pantalla hasta el borde de la zona útil
    const cx = w / 2
    const cy = h / 2
    const kx = sx > 1e-6 ? (R - cx) / sx : sx < -1e-6 ? (L - cx) / sx : Infinity
    const ky = sy > 1e-6 ? (B - cy) / sy : sy < -1e-6 ? (T - cy) / sy : Infinity
    let k = Math.max(0, Math.min(kx, ky))
    // la esquina ocupada: el rayo entra en ella al cruzar su borde izquierdo o el inferior
    if (NL < R && sx > 1e-6 && sy < -1e-6 && cx + sx * k > NL && cy + sy * k < NB)
      k = Math.max(0, Math.max((NL - cx) / sx, (NB - cy) / sy))
    const ex = cx + sx * k
    const ey = cy + sy * k

    const el = this.edge
    if (el.style.display !== '') el.style.display = ''
    if (this.edgeInfo.textContent !== txt) {
      this.edgeInfo.textContent = txt
      this.edgeW = 0
    }
    if (!this.edgeW) {
      this.edgeW = this.edgeLabel.offsetWidth
      this.edgeH = this.edgeLabel.offsetHeight
    }
    el.style.transform = `translate(${ex.toFixed(1)}px, ${ey.toFixed(1)}px)`
    el.style.opacity = opacity
    this.edgeArrow.style.transform = `translate(-50%, -50%) rotate(${Math.atan2(sy, sx).toFixed(3)}rad)`
    // el rótulo, hacia dentro de la pantalla, sin pisar la flecha
    const d = 15 + Math.abs(sx) * (this.edgeW / 2) + Math.abs(sy) * (this.edgeH / 2)
    this.edgeLabel.style.transform = `translate(${(-sx * d).toFixed(1)}px, ${(-sy * d).toFixed(1)}px) translate(-50%, -50%)`
  }

  dispose(): void {
    this.view.root.removeFromParent()
    this.view.root.traverse((o) => {
      const m = o as unknown as { isMesh?: boolean; geometry?: { dispose(): void }; material?: unknown }
      if (!m.isMesh) return
      m.geometry?.dispose()
      for (const mat of (Array.isArray(m.material) ? m.material : [m.material]) as { dispose?(): void }[]) mat?.dispose?.()
    })
    this.tag.remove()
    this.edge.remove()
  }
}

function hide(el: HTMLElement): void {
  if (el.style.display !== 'none') el.style.display = 'none'
}

function nowStale(lastRecv: number): boolean {
  return performance.now() - lastRecv > 3000
}

export function fmtDistance(m: number): string {
  if (m < 1000) return `${Math.round(m / 10) * 10} m`
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',')} km`
}
