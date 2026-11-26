// Cámaras: persecución, cabina, órbita libre y "torre" (vista desde tierra).

import { MathUtils, Matrix3, PerspectiveCamera, Quaternion, Vector3 } from 'three'
import type { Autogyro } from '../sim/autogyro.ts'
import type { AircraftView } from '../aircraft/AircraftView.ts'
import { t } from '../i18n.ts'

export type CamMode = 'chase' | 'cockpit' | 'orbit' | 'tower'
const MODES: CamMode[] = ['chase', 'cockpit', 'orbit', 'tower']
export const CAM_NAMES: Record<CamMode, string> = {
  chase: 'Persecución',
  cockpit: 'Cabina',
  orbit: 'Exterior libre',
  tower: 'Desde tierra',
}
/** Nombre de la cámara en el idioma de la interfaz. */
export const camName = (m: CamMode): string => t(`cam.${m}`)

const _v = new Vector3()
const _v2 = new Vector3()
const _v3 = new Vector3()
const _q = new Quaternion()
const _q2 = new Quaternion()
const Y = new Vector3(0, 1, 0)
const Z = new Vector3(0, 0, 1)
const BASE = new Quaternion().setFromAxisAngle(Y, -Math.PI / 2)
const _m3 = new Matrix3()

/** Fracción de acercamiento de un filtro de primer orden de velocidad `k` (1/s) en `dt`, igual a cualquier ritmo de fotogramas. */
const damp = (dt: number, k: number): number => 1 - Math.exp(-k * dt)

/**
 * Media de sin(φ) entre la fase del fotograma anterior y la actual: una vibración más rápida
 * que los fotogramas se atenúa en vez de convertirse en un vaivén lento (aliasing) cuando
 * baja el ritmo de fotogramas.
 */
function avgSin(prev: number, cur: number): number {
  const d = cur - prev
  return d < 1e-4 ? Math.sin(cur) : (Math.cos(prev) - Math.cos(cur)) / d
}

/** Retraso de la cámara de persecución por la velocidad del aparato (s): la deja algo atrás al ir rápido. */
const CHASE_LAG = 1 / 8

/** Estado guardado de la cámara (CameraRig.saveState). */
export interface CameraRigState {
  mode: CamMode
  n: number[]
  v: Vector3[]
  chaseReset: boolean
  lookBack: boolean
}

export class CameraRig {
  mode: CamMode = 'chase'
  private yawOff = 0
  private pitchOff = 0.2
  private dist = 11.5
  private orbitYaw = 2.4
  private orbitPitch = 0.25
  private orbitDist = 16
  private chaseYaw = 0
  private readonly towerPos = new Vector3()
  // persecución: desplazamiento respecto al aparato y velocidad suavizados (no la posición
  // absoluta, que daba tirones cuando un fotograma tardaba más)
  private readonly chaseOff = new Vector3()
  private readonly chaseVel = new Vector3()
  private chaseReset = true
  private rotorPhase = 0
  private enginePhase = 0
  private headG = 0
  private fov = 62
  private lookBack = false
  /** Cámara lenta (restos tras un accidente): el retraso por velocidad va con la que se ve. */
  timeScale = 1

  private cam: PerspectiveCamera
  constructor(cam: PerspectiveCamera) {
    this.cam = cam
  }

  next(ac: Autogyro, groundY: number): CamMode {
    const i = (MODES.indexOf(this.mode) + 1) % MODES.length
    this.setMode(MODES[i], ac, groundY)
    return this.mode
  }

  setMode(m: CamMode, ac: Autogyro, groundY: number): void {
    this.mode = m
    this.yawOff = 0
    this.pitchOff = m === 'cockpit' ? -0.08 : 0.2
    this.fov = m === 'cockpit' ? 72 : 62
    if (m === 'tower') {
      // a un lado de la trayectoria, por delante
      const fwd = _v.set(ac.vel.x, 0, ac.vel.z)
      if (fwd.lengthSq() < 1) fwd.set(1, 0, 0).applyQuaternion(ac.quat).setY(0)
      fwd.normalize()
      const side = _v2.crossVectors(fwd, Y).normalize()
      const speed = Math.max(10, Math.hypot(ac.vel.x, ac.vel.z))
      this.towerPos
        .copy(ac.pos)
        .addScaledVector(fwd, speed * 5)
        .addScaledVector(side, 45)
      this.towerPos.y = Math.max(groundY + 1.8, Math.min(ac.pos.y - 5, groundY + 30))
    }
    if (m === 'chase') {
      this.chaseYaw = headingOf(ac)
      this.chaseReset = true
    }
  }

  toggleLookBack(): void {
    this.lookBack = !this.lookBack
  }

  zoom(delta: number): void {
    if (this.mode === 'orbit') this.orbitDist = MathUtils.clamp(this.orbitDist * (1 + delta * 0.12), 6, 200)
    else if (this.mode === 'chase') this.dist = MathUtils.clamp(this.dist * (1 + delta * 0.1), 7, 60)
    else this.fov = MathUtils.clamp(this.fov + delta * 4, 15, 90)
  }

  look(dx: number, dy: number): void {
    if (this.mode === 'orbit') {
      this.orbitYaw -= dx * 0.005
      this.orbitPitch = MathUtils.clamp(this.orbitPitch + dy * 0.004, -0.6, 1.4)
    } else {
      this.yawOff -= dx * 0.004
      this.pitchOff = MathUtils.clamp(this.pitchOff - dy * 0.004 * (this.mode === 'cockpit' ? 1 : -1), -1.2, 1.3)
    }
  }

  update(dt: number, ac: Autogyro, view: AircraftView, groundY: number, dragging: boolean): void {
    const cam = this.cam
    const target = _v.copy(ac.pos).add(_v2.set(0, 0.6, 0))
    if (this.mode === 'cockpit') {
      view.eyeWorld(cam.position)
      // Vibración de paso de pala del rotor (2/rev en el bipala) y algo del motor. Es un efecto
      // de cámara, no sale del modelo de vuelo: en un rotor bien equilibrado son décimas de g,
      // invisibles a la vista, así que se deja en lo justo para notarla (antes rondaba 1 g).
      const prevR = this.rotorPhase
      const prevE = this.enginePhase
      this.rotorPhase += (ac.rotor.p.blades * ac.rotor.rpm * Math.PI * dt) / 30
      this.enginePhase += 90 * dt
      const amp = Math.min(1, ac.rotor.thrust / 4500) * 0.0008 * (0.4 + Math.min(1, ac.tas / 40))
      const eng = 0.00025 * Math.min(1, ac.engineRpm / 5000)
      cam.position.y += avgSin(prevR, this.rotorPhase) * amp + avgSin(prevE, this.enginePhase) * eng
      if (this.rotorPhase > 1e4) this.rotorPhase %= Math.PI * 2
      if (this.enginePhase > 1e4) this.enginePhase %= Math.PI * 2
      // cabeza con fuerzas g (asiento y cuello no responden al instante: sin saltos en los botes)
      this.headG += (ac.gLoad - 1 - this.headG) * damp(dt, 14)
      cam.position.addScaledVector(_v2.set(0, 1, 0).applyQuaternion(ac.quat), -this.headG * 0.015)
      if (!dragging) {
        const k = damp(dt, 0.8)
        this.yawOff *= 1 - k
        this.pitchOff += (-0.08 - this.pitchOff) * k
      }
      _q.setFromAxisAngle(Y, this.yawOff + (this.lookBack ? Math.PI : 0))
      _q2.setFromAxisAngle(Z, this.pitchOff)
      cam.quaternion.copy(ac.quat).multiply(_q).multiply(_q2).multiply(BASE)
    } else if (this.mode === 'chase') {
      // sigue el rumbo con retraso, sin alabear la cámara
      const h = headingOf(ac)
      let d = h - this.chaseYaw
      d = Math.atan2(Math.sin(d), Math.cos(d))
      this.chaseYaw += d * damp(dt, 2.2)
      if (!dragging) {
        const k = damp(dt, 0.6)
        this.yawOff *= 1 - k
        this.pitchOff += (0.2 - this.pitchOff) * k
      }
      const yaw = this.chaseYaw + this.yawOff + (this.lookBack ? Math.PI : 0)
      const back = _v2.set(-Math.sin(yaw), 0, Math.cos(yaw)) // detrás (rumbo 0 = −Z)
      const off = back.multiplyScalar(this.dist * Math.cos(this.pitchOff)).setY(this.dist * Math.sin(this.pitchOff) + 1.2)
      // La cámara va pegada al aparato con un desplazamiento suavizado y se queda atrás según su
      // velocidad (también suavizada). Las dos cosas son continuas aunque un fotograma tarde más,
      // así que el aparato ya no se acerca y se aleja de golpe tras un parón.
      // (en cámara lenta, la velocidad que se ve en pantalla)
      const vel = _v3.copy(ac.vel).multiplyScalar(this.timeScale)
      if (this.chaseReset || this.chaseOff.distanceToSquared(off) > 2500) {
        this.chaseOff.copy(off)
        this.chaseVel.copy(vel)
        this.chaseReset = false
      }
      const k = damp(dt, 8)
      this.chaseOff.lerp(off, k)
      this.chaseVel.lerp(vel, k)
      cam.position.copy(target).add(this.chaseOff).addScaledVector(this.chaseVel, -CHASE_LAG)
      cam.position.y = Math.max(cam.position.y, groundY + 0.6)
      cam.lookAt(target)
    } else if (this.mode === 'orbit') {
      const off = _v2.set(
        Math.cos(this.orbitPitch) * Math.sin(this.orbitYaw),
        Math.sin(this.orbitPitch),
        Math.cos(this.orbitPitch) * Math.cos(this.orbitYaw),
      )
      cam.position.copy(target).addScaledVector(off, this.orbitDist)
      cam.position.y = Math.max(cam.position.y, groundY + 0.6)
      cam.lookAt(target)
    } else {
      cam.position.copy(this.towerPos)
      cam.lookAt(target)
      // zoom automático para mantener el tamaño aparente
      const dist = cam.position.distanceTo(target)
      const want = MathUtils.clamp(MathUtils.radToDeg(2 * Math.atan(9 / dist)) * 1.6, 8, 70)
      this.fov += (want - this.fov) * damp(dt, 2)
    }
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov
      cam.updateProjectionMatrix()
    }
    view.setCockpitView(this.mode === 'cockpit')
  }

  /** Espectador en tierra (modo «Desde tierra»): la repetición lo pone donde mejor se ve (src/replay). */
  setTower(p: Vector3): void {
    this.towerPos.copy(p)
  }

  /** Copia del estado de la cámara (la repetición la guarda al entrar y la devuelve al salir). */
  saveState(): CameraRigState {
    return {
      mode: this.mode,
      n: [this.yawOff, this.pitchOff, this.dist, this.orbitYaw, this.orbitPitch, this.orbitDist, this.chaseYaw, this.headG, this.fov, this.timeScale],
      v: [this.towerPos.clone(), this.chaseOff.clone(), this.chaseVel.clone()],
      chaseReset: this.chaseReset,
      lookBack: this.lookBack,
    }
  }

  restoreState(s: CameraRigState): void {
    this.mode = s.mode
    ;[this.yawOff, this.pitchOff, this.dist, this.orbitYaw, this.orbitPitch, this.orbitDist, this.chaseYaw, this.headG, this.fov, this.timeScale] = s.n
    this.towerPos.copy(s.v[0])
    this.chaseOff.copy(s.v[1])
    this.chaseVel.copy(s.v[2])
    this.chaseReset = s.chaseReset
    this.lookBack = s.lookBack
  }

  /** Aplica la transformación de re-centrado a los estados internos. */
  rebase(m: import('three').Matrix4): void {
    this.towerPos.applyMatrix4(m)
    // vectores (no puntos): solo el giro del re-centrado
    _m3.setFromMatrix4(m)
    this.chaseOff.applyMatrix3(_m3)
    this.chaseVel.applyMatrix3(_m3)
  }
}

export function headingOf(ac: Autogyro): number {
  const f = _q.copy(ac.quat)
  const fwd = new Vector3(1, 0, 0).applyQuaternion(f)
  return Math.atan2(fwd.x, -fwd.z)
}
