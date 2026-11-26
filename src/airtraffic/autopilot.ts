// Manos y pies del piloto simulado: lleva los mandos de un `Autogyro` de verdad (el mismo modelo
// de vuelo que el jugador) como los lleva un piloto, con la ayuda al pilotaje de `sim/assist.ts`
// amortiguando el cabeceo igual que al jugador de teclado.
//
// Reparto de un autogiro: la palanca manda la velocidad, el gas manda subir o bajar, el alabeo
// manda el rumbo y los pedales el hilo (en el aire) o el morro (en tierra y en la recogida).
// No toca la física: solo escribe en `Controls`.

import { Vector3 } from 'three'
import { defaultControls, type Autogyro, type Controls } from '../sim/autogyro.ts'
import { PilotAssist } from '../sim/assist.ts'

const _f = new Vector3()
const _r = new Vector3()
const G = 9.81

export const wrapPi = (a: number): number => {
  a = (a + Math.PI) % (2 * Math.PI)
  return (a < 0 ? a + 2 * Math.PI : a) - Math.PI
}
const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x)

export class Autopilot {
  readonly ctl: Controls = defaultControls()
  private readonly assist = new PilotAssist()
  /** mano en la palanca (antes de la ayuda) y en el gas */
  stick = 0
  roll = 0
  yaw = 0
  throttle = 0
  brake = 0
  prerot = false
  rotorBrake = true
  /** el piloto lleva los pedales (en tierra y en la recogida); si no, la ayuda centra el hilo */
  feet = false
  /** el piloto está moviendo la palanca en cabeceo (la ayuda solo amortigua) */
  pulling = false

  // ---- lo que el piloto ve ----
  /** cabeceo y alabeo (rad), rumbo y derrota sobre el suelo (rad, 0 = norte, a derechas) */
  pitch = 0
  bank = 0
  hdg = 0
  track = 0
  /** velocidad sobre el suelo (m/s) */
  gs = 0
  /** tendencia de la velocidad indicada (m/s², filtrada) */
  private vPrev = 0
  vDot = 0
  private rollI = 0
  private thrI = 0
  private thI = 0
  private stI = 0
  /** el piloto lleva la actitud él mismo (la ayuda solo amortigua un poco) */
  private own = false
  private primed = false

  reset(ac: Autogyro, stick = 0, throttle = 0): void {
    this.stick = stick
    this.throttle = throttle
    this.roll = this.yaw = this.brake = 0
    this.rollI = 0
    this.thrI = throttle
    this.stI = stick
    this.primed = false
    this.assist.reset()
    this.look(ac, 1 / 240)
    this.thI = this.pitch
  }

  /** Lee los instrumentos y el horizonte. */
  look(ac: Autogyro, dt: number): void {
    _f.set(1, 0, 0).applyQuaternion(ac.quat)
    _r.set(0, 0, 1).applyQuaternion(ac.quat)
    this.pitch = Math.asin(clamp(_f.y, -1, 1))
    this.bank = Math.asin(clamp(-_r.y, -1, 1))
    this.hdg = Math.atan2(_f.x, -_f.z)
    this.gs = Math.hypot(ac.vel.x, ac.vel.z)
    this.track = this.gs > 1.5 ? Math.atan2(ac.vel.x, -ac.vel.z) : this.hdg
    if (!this.primed) {
      this.vPrev = ac.ias
      this.vDot = 0
      this.primed = true
    }
    const vd = (ac.ias - this.vPrev) / dt
    this.vPrev = ac.ias
    this.vDot += (vd - this.vDot) * Math.min(1, dt / 0.5)
  }

  // ---------------- cabeceo ----------------
  /**
   * Velocidad indicada (m/s) con la palanca, como se enseña: la velocidad se lleva con la actitud.
   * Demasiado rápido → morro arriba; el término integral busca la actitud de equilibrio.
   */
  holdSpeed(dt: number, ac: Autogyro, ias: number): void {
    const e = ac.ias - ias
    this.thI = clamp(this.thI + 0.006 * e * dt, -0.3, 0.3)
    const th = clamp(this.thI + 0.03 * e + 0.06 * this.vDot, -0.3, 0.32)
    this.holdPitch(dt, ac, th)
  }

  /** Actitud de cabeceo (rad) con la palanca. */
  holdPitch(dt: number, ac: Autogyro, th: number, gain = 1): void {
    const e = th - this.pitch
    this.stI = clamp(this.stI + 0.5 * gain * e * dt, -0.7, 0.9)
    this.stick = clamp(this.stI + 2.2 * gain * e - 0.55 * ac.omega.z, -1, 1)
    this.pulling = true
    this.own = true
  }

  /** Lleva la palanca a una posición a un ritmo dado (recorrido −1..1 por segundo). */
  moveStick(dt: number, target: number, rate: number): void {
    const d = target - this.stick
    this.stick += Math.sign(d) * Math.min(Math.abs(d), rate * dt)
    this.stI = this.stick
    this.thI = this.pitch
    this.pulling = Math.abs(d) > 0.01
    this.own = false
  }

  // ---------------- gas ----------------
  /**
   * Velocidad vertical (m/s) con el gas. El gas pone energía: se mira la suma de lo que sube y lo
   * que acelera, para no quitarlo cuando la subida es solo velocidad que se está cambiando por altura.
   */
  holdVs(dt: number, ac: Autogyro, vs: number, min = 0, max = 1): void {
    const e = vs - (ac.vs + (ac.ias * this.vDot) / G)
    this.thrI = clamp(this.thrI + 0.03 * e * dt, min, max)
    const target = clamp(this.thrI + 0.1 * e, min, max)
    this.moveThrottle(dt, target, 0.5)
  }

  moveThrottle(dt: number, target: number, rate = 0.45): void {
    const d = target - this.throttle
    this.throttle += Math.sign(d) * Math.min(Math.abs(d), rate * dt)
  }

  /** deja el integrador del gas donde está la mano (al pasar de gas fijo a velocidad vertical) */
  syncThrottle(): void {
    this.thrI = this.throttle
  }

  // ---------------- alabeo ----------------
  holdBank(dt: number, ac: Autogyro, bank: number): void {
    const e = bank - this.bank
    // (compensa el par motor para no quedar virando)
    this.rollI = clamp(this.rollI + 0.5 * e * dt, -0.3, 0.3)
    this.roll = clamp(1.5 * e - 0.38 * ac.omega.x + this.rollI, -1, 1)
  }

  /** Derrota sobre el suelo (rad) con el alabeo; `maxBank` en rad. */
  holdTrack(dt: number, ac: Autogyro, track: number, maxBank = 0.44): void {
    const e = wrapPi(track - this.track)
    // viraje coordinado: régimen de viraje pedido → alabeo
    const rate = clamp(0.55 * e, -0.3, 0.3)
    const bank = clamp(Math.atan((rate * Math.max(this.gs, 12)) / G), -maxBank, maxBank)
    this.holdBank(dt, ac, bank)
  }

  // ---------------- pedales ----------------
  /** Rumbo del morro con los pedales (rueda de morro en tierra, timón en el aire). */
  steer(dt: number, ac: Autogyro, hdg: number, gain = 1): void {
    void dt
    const e = wrapPi(hdg - this.hdg)
    // (ω.y > 0 = morro a la izquierda)
    const k = ac.onGround ? 2.2 / (1 + this.gs / 12) : 2.5
    this.yaw = clamp((k * e + (ac.onGround ? 0.25 : 0.6) * ac.omega.y) * gain, -1, 1)
    this.feet = true
  }

  /** Escribe los mandos (con la ayuda al pilotaje del jugador de teclado en el cabeceo). */
  apply(dt: number, ac: Autogyro): Controls {
    const c = this.ctl
    c.pitch = this.stick
    c.roll = this.roll
    c.yaw = this.feet ? this.yaw : 0
    c.throttle = this.throttle
    c.prerotator = this.prerot
    c.rotorBrake = this.rotorBrake
    c.wheelBrake = this.brake
    c.trim = 0
    this.assist.apply(dt, ac, c, { pitchActive: this.pulling, rollActive: true, yawActive: this.feet, analog: this.own })
    return c
  }
}
