// Ayuda al pilotaje: lo que un piloto hace con la mano sin pensarlo.
//
// Un autogiro con la palanca fija tiene un fugoide muy poco amortiguado (la
// velocidad y la altura se intercambian en ciclos de 10-15 s, acoplados con las
// vueltas del rotor). El piloto real lo anula sin darse cuenta: si ve que el
// aparato se acelera, tira un poco; si se frena, cede. Con teclado eso es
// imposible, así que esta ayuda:
//   · amortigua el cabeceo y el fugoide (realimenta el régimen de cabeceo, la
//     tendencia de la velocidad y, brevemente, la actitud). No cambia la
//     velocidad de equilibrio de cada posición de palanca,
//   · nivela suavemente el alabeo cuando no hay mando lateral,
//   · coordina con pedales (centra el hilo) cuando no se pisan,
//   · en tierra, solo en los de vía estrecha sin rueda gobernable (`groundAssist`, Cierva C.6), lleva las
//     alas a nivel y el rumbo de salida con alerones y timón.
// No modifica la física: solo mueve los mandos dentro de un margen limitado.

import { Vector3 } from 'three'
import type { Autogyro, Controls } from './autogyro.ts'

export interface AssistInputs {
  /** el piloto está moviendo la palanca en cabeceo / alabeo / pisando pedales */
  pitchActive: boolean
  rollActive: boolean
  yawActive: boolean
  /** mando analógico (joystick): solo amortiguación ligera */
  analog: boolean
}

/** Velocidad del mando de gas con teclado (0..1 por segundo). */
export const KEY_THROTTLE_RATE = 0.45

/**
 * Velocidad de la palanca con teclado en función del tiempo que lleva pulsada
 * la tecla: toques cortos = ajuste fino; mantener = movimiento amplio y rápido
 * (necesario para la recogida). Recorrido completo −1..1 = 2.
 */
export function keyPitchRate(holdTime: number): number {
  const k = Math.min(1, holdTime / 0.7)
  return 0.3 + 1.5 * k * k
}

const _f = new Vector3()
const _r = new Vector3()

export class PilotAssist {
  /** ganancias (ajustables para pruebas) */
  readonly gains = { kq: 0.6, kqActive: 0.3, kth: 0.4, tau: 3, kv: 0.1, limit: 0.5, kf: 0.45, flareSlope: 0.8 }
  private thRef = 0
  private primed = false
  private vPrev = 0
  private vDot = 0
  private rollI = 0
  /** rumbo con el que echó a rodar (`groundAssist`); null en el aire */
  private hdgRef: number | null = null
  private flareBase = 0
  /** la ayuda está moderando una recogida */
  flaring = false
  /** corrección de cabeceo aplicada en el último paso (para mostrarla) */
  pitchCorrection = 0

  reset(): void {
    this.primed = false
    this.pitchCorrection = 0
    this.rollI = 0
    this.vDot = 0
    this.hdgRef = null
  }

  apply(dt: number, ac: Autogyro, ctl: Controls, inp: AssistInputs): void {
    const g = this.gains
    _f.set(1, 0, 0).applyQuaternion(ac.quat)
    _r.set(0, 0, 1).applyQuaternion(ac.quat)
    const pitch = Math.asin(Math.max(-1, Math.min(1, _f.y)))
    const bank = Math.asin(Math.max(-1, Math.min(1, -_r.y)))
    if (!this.primed) {
      this.thRef = pitch
      this.vPrev = ac.ias
      this.primed = true
    }
    // tendencia de la velocidad indicada (filtrada)
    const vd = (ac.ias - this.vPrev) / dt
    this.vPrev = ac.ias
    this.vDot += (vd - this.vDot) * Math.min(1, dt / 0.45)
    const moving = ac.tas > 6 || !ac.onGround

    // ---- cabeceo ----
    let corr = 0
    if (moving) {
      if (inp.analog) {
        this.thRef = pitch
        corr = -0.25 * ac.omega.z
      } else if (inp.pitchActive) {
        // el piloto manda: solo se amortigua un poco el régimen de cabeceo
        this.thRef = pitch
        corr = -g.kqActive * ac.omega.z
      } else {
        this.thRef += ((pitch - this.thRef) / g.tau) * dt
        corr = -g.kq * ac.omega.z - g.kth * (pitch - this.thRef)
        if (!ac.onGround) corr += g.kv * this.vDot
      }
      corr = Math.max(-g.limit, Math.min(g.limit, corr))
      // Recogida: cerca del suelo, con la palanca atrás y poco gas, evita "globear"
      // (cede palanca si el aparato deja de bajar) para que se pose en vez de
      // quedarse colgado a un metro y desplomarse. Es lo que hace el piloto al
      // "aguantar" la toma.
      const raw = ctl.pitch
      const flareZone = !inp.analog && !ac.onGround && ac.agl < 14 && ctl.throttle < 0.5
      // posición de palanca que traía el piloto antes de tirar: la ayuda nunca
      // empuja por debajo de ella (solo modera el tirón de la recogida)
      // (no se actualiza al tocar suelo: si rebota, la ayuda sigue moderando)
      if (ac.agl >= 14 || ctl.throttle >= 0.5 || inp.analog || raw < this.flareBase) this.flareBase = raw
      this.flaring = flareZone && raw > this.flareBase + 0.1
      if (this.flaring) {
        const target = -(0.5 + g.flareSlope * ac.agl)
        const c = -g.kqActive * ac.omega.z - g.kf * Math.max(0, ac.vs - target)
        corr = Math.max(this.flareBase - raw, Math.max(-0.75, c))
        this.thRef = pitch
      }
    } else this.thRef = pitch
    this.pitchCorrection = corr
    ctl.pitch = Math.max(-1, Math.min(1, ctl.pitch + corr))

    if (ac.onGround) {
      this.rollI = 0
      // tren estrecho sin rueda gobernable ni deriva (Cierva C.6, `groundAssist`): en la carrera, alas a nivel
      // con los alerones y el rumbo con el que echó a rodar con el timón, mientras no se toquen esos mandos
      if (ac.af.groundAssist) {
        const hdg = Math.atan2(-_f.z, _f.x)
        if (this.hdgRef === null || ac.groundSpeed < 1) this.hdgRef = hdg
        const e = Math.atan2(Math.sin(hdg - this.hdgRef), Math.cos(hdg - this.hdgRef))
        if (!inp.yawActive && Math.abs(ctl.yaw) < 0.08) ctl.yaw = Math.max(-1, Math.min(1, ctl.yaw + 4 * e + 3 * ac.omega.y))
        if (!inp.rollActive && Math.abs(ctl.roll) < 0.08) ctl.roll = Math.max(-1, Math.min(1, ctl.roll - 8 * bank - 2 * ac.omega.x))
      }
      return
    }
    this.hdgRef = null

    // ---- alabeo: alas niveladas si no hay mando lateral ----
    if (!inp.rollActive && Math.abs(ctl.roll) < 0.08) {
      // término integral: compensa el par motor para no quedar virando
      this.rollI = Math.max(-0.25, Math.min(0.25, this.rollI - 0.5 * bank * dt))
      const a = Math.max(-0.4, Math.min(0.4, -1.26 * bank - 0.35 * ac.omega.x + this.rollI))
      ctl.roll = Math.max(-1, Math.min(1, ctl.roll + a))
    }
    // ---- guiñada: vuelo coordinado si no se pisan pedales ----
    if (!inp.yawActive && Math.abs(ctl.yaw) < 0.08 && ac.tas > 12) {
      const y = Math.max(-0.5, Math.min(0.5, 1.6 * ac.beta + 0.25 * ac.omega.y))
      ctl.yaw = Math.max(-1, Math.min(1, ctl.yaw + y))
    }
  }
}
