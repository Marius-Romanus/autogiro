// Cámaras: persecución, cabina, órbita libre y "torre" (vista desde tierra).

import { MathUtils, PerspectiveCamera, Quaternion, Vector3 } from 'three'
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
const _q = new Quaternion()
const _q2 = new Quaternion()
const Y = new Vector3(0, 1, 0)
const Z = new Vector3(0, 0, 1)
const BASE = new Quaternion().setFromAxisAngle(Y, -Math.PI / 2)

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
  private readonly smoothPos = new Vector3()
  private shakeT = 0
  private fov = 62
  private lookBack = false

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
    if (m === 'chase') this.chaseYaw = headingOf(ac)
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
      // vibración 2/rev del rotor bipala + motor
      this.shakeT += dt
      const rpm = ac.rotor.rpm
      const twoRev = (2 * rpm) / 60
      const amp = Math.min(1, ac.rotor.thrust / 4500) * 0.0016 * (0.4 + Math.min(1, ac.tas / 40))
      const eng = 0.0004 * Math.min(1, ac.engineRpm / 5000)
      cam.position.y += Math.sin(this.shakeT * twoRev * Math.PI * 2) * amp + Math.sin(this.shakeT * 90) * eng
      // cabeza con fuerzas g
      cam.position.addScaledVector(_v2.set(0, 1, 0).applyQuaternion(ac.quat), -(ac.gLoad - 1) * 0.015)
      if (!dragging) {
        this.yawOff *= 1 - Math.min(1, dt * 0.8)
        this.pitchOff += (-0.08 - this.pitchOff) * Math.min(1, dt * 0.8)
      }
      _q.setFromAxisAngle(Y, this.yawOff + (this.lookBack ? Math.PI : 0))
      _q2.setFromAxisAngle(Z, this.pitchOff)
      cam.quaternion.copy(ac.quat).multiply(_q).multiply(_q2).multiply(BASE)
    } else if (this.mode === 'chase') {
      // sigue el rumbo con retraso, sin alabear la cámara
      const h = headingOf(ac)
      let d = h - this.chaseYaw
      d = Math.atan2(Math.sin(d), Math.cos(d))
      this.chaseYaw += d * Math.min(1, dt * 2.2)
      if (!dragging) {
        this.yawOff *= 1 - Math.min(1, dt * 0.6)
        this.pitchOff += (0.2 - this.pitchOff) * Math.min(1, dt * 0.6)
      }
      const yaw = this.chaseYaw + this.yawOff + (this.lookBack ? Math.PI : 0)
      const back = _v2.set(-Math.sin(yaw), 0, Math.cos(yaw)) // detrás (rumbo 0 = −Z)
      const off = back.multiplyScalar(this.dist * Math.cos(this.pitchOff)).setY(this.dist * Math.sin(this.pitchOff) + 1.2)
      const desired = off.add(target)
      if (this.smoothPos.distanceToSquared(desired) > 2500) this.smoothPos.copy(desired)
      this.smoothPos.lerp(desired, Math.min(1, dt * 8))
      cam.position.copy(this.smoothPos)
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
      this.fov += (want - this.fov) * Math.min(1, dt * 2)
    }
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov
      cam.updateProjectionMatrix()
    }
    view.setCockpitView(this.mode === 'cockpit')
  }

  /** Aplica la transformación de re-centrado a los estados internos. */
  rebase(m: import('three').Matrix4): void {
    this.towerPos.applyMatrix4(m)
    this.smoothPos.applyMatrix4(m)
  }
}

export function headingOf(ac: Autogyro): number {
  const f = _q.copy(ac.quat)
  const fwd = new Vector3(1, 0, 0).applyQuaternion(f)
  return Math.atan2(fwd.x, -fwd.z)
}
