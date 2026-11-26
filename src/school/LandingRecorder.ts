// Sigue al aparato paso a paso y, cuando toma tierra, recoge lo que hace falta para puntuar la
// toma (landingScore.ts): velocidad vertical del contacto, velocidades, actitud, deriva, dónde ha
// tocado, carrera, rebotes. No toca la física: solo lee.
//
// Módulo sin DOM ni escena (lo usa también tools/school-test.ts).

import { Vector3 } from 'three'
import type { Autogyro } from '../sim/autogyro.ts'
import { glideFor } from '../sim/glideData.ts'
import type { LandingSample, RunwayHit } from './landingScore.ts'

/** Dónde queda un punto del mundo respecto a la pista que toca (o null si no hay pista cerca). */
export type RunwayLocator = (pos: Vector3, fwd: Vector3, vel: Vector3) => { hit: RunwayHit | null; want: boolean }

/** tiempo mínimo en el aire y altura mínima alcanzada para que el contacto cuente como una toma */
const MIN_AIR_T = 1.5
const MIN_AIR_AGL = 0.6
/** por debajo de esto (m/s) la carrera ha terminado */
const STOP_SPEED = 1.5
/** de nuevo en el aire más de este tiempo o por encima de esta altura: era una toma y despegue */
const GO_T = 2.5
const GO_AGL = 2.5
/** un despegue de las ruedas por encima de esto (m) durante más de BOUNCE_T es un rebote */
const BOUNCE_AGL = 0.25
const BOUNCE_T = 0.2
/** el golpe de las demás ruedas cuenta para la velocidad vertical durante este tiempo */
const SETTLE_T = 0.6

const _f = new Vector3()
const _r = new Vector3()

export class LandingRecorder {
  /** en el aire | rodando tras tocar */
  phase: 'ground' | 'air' | 'roll' = 'ground'
  private airT = 0
  private maxAgl = 0
  private readonly lastPos = new Vector3()
  // último instante en el aire
  private preVs = 0
  private preIas = 0
  private readonly preVel = new Vector3()
  // recogida: palanca más adelantada por debajo de 20 m y altura a la que se empezó a tirar
  private stickMin = 1
  private flareAgl: number | null = null
  // tras tocar
  private sample: LandingSample | null = null
  private rollT = 0
  private rollDist = 0
  private hopT = 0
  private hopCounted = false
  private hopMax = 0
  /** tiempo de simulación del último contacto (para la repetición) */
  touchTime = 0
  private t = 0

  reset(onGround: boolean): void {
    this.phase = onGround ? 'ground' : 'air'
    this.airT = onGround ? 0 : MIN_AIR_T
    this.maxAgl = onGround ? 0 : 10
    this.sample = null
    this.stickMin = 1
    this.flareAgl = null
  }

  /**
   * Tras cada paso de la física. `stick`: palanca en cabeceo (−1…1, + atrás); `throttle`: gas (0…1). Devuelve la toma
   * terminada (parado, de nuevo en el aire o accidentado) o null.
   */
  step(dt: number, ac: Autogyro, stick: number, throttle: number, locate: RunwayLocator): LandingSample | null {
    this.t += dt
    if (ac.crash) {
      // accidente al tocar o en la carrera: la toma acaba aquí
      if (this.phase === 'roll' && this.sample) {
        this.sample.rollout = this.rollDist
        return this.finish(ac, ac.crash.title)
      }
      if (this.phase === 'air' && this.airT >= MIN_AIR_T && ac.agl < 4 && ac.crash.cause !== 'obstacle') {
        this.sample = this.capture(ac, locate)
        this.sample.vs = Math.max(this.sample.vs, -this.preVs)
        return this.finish(ac, ac.crash.title)
      }
      this.phase = 'ground'
      return null
    }
    const ground = ac.onGround
    switch (this.phase) {
      case 'ground':
        if (!ground) {
          this.phase = 'air'
          this.airT = 0
          this.maxAgl = 0
          this.stickMin = 1
          this.flareAgl = null
        }
        break
      case 'air':
        if (!ground) {
          this.airT += dt
          this.maxAgl = Math.max(this.maxAgl, ac.agl)
          this.preVs = ac.vs
          this.preIas = ac.ias
          this.preVel.copy(ac.vel)
          // recogida: por encima de 20 m se olvida; por debajo, cuándo empieza a tirar
          if (ac.agl > 20) {
            this.stickMin = stick
            this.flareAgl = null
          } else {
            this.stickMin = Math.min(this.stickMin, stick)
            if (this.flareAgl === null && stick > this.stickMin + 0.15) this.flareAgl = ac.agl
          }
        } else if (this.airT >= MIN_AIR_T && this.maxAgl >= MIN_AIR_AGL) {
          this.sample = this.capture(ac, locate)
          this.touchTime = this.t
          this.phase = 'roll'
          this.rollT = this.rollDist = this.hopT = this.hopMax = 0
          this.hopCounted = false
          this.lastPos.copy(ac.pos)
        } else this.phase = 'ground'
        break
      case 'roll': {
        const s = this.sample!
        this.rollT += dt
        this.rollDist += Math.hypot(ac.pos.x - this.lastPos.x, ac.pos.z - this.lastPos.z)
        this.lastPos.copy(ac.pos)
        if (ground) {
          // las demás ruedas y los rebotes: cuenta el golpe más fuerte
          if (this.rollT < SETTLE_T || this.hopT > 0) s.vs = Math.max(s.vs, ac.hardness)
          this.hopT = 0
          this.hopMax = 0
          this.hopCounted = false
          if (ac.groundSpeed < STOP_SPEED) {
            s.rollout = this.rollDist
            return this.finish(ac, null)
          }
        } else {
          this.hopT += dt
          this.hopMax = Math.max(this.hopMax, ac.agl)
          if (!this.hopCounted && this.hopT > BOUNCE_T && this.hopMax > BOUNCE_AGL) {
            this.hopCounted = true
            s.bounces++
          }
          // de nuevo al aire con gas: toma y despegue (el salto que lo saca no es un rebote); sin gas
          // es un rebote, por alto que sea
          if (((this.hopT > GO_T || this.hopMax > GO_AGL) && throttle > 0.5) || this.hopT > 10) {
            if (this.hopCounted) s.bounces--
            s.rollout = null
            const done = this.finish(ac, null)
            this.phase = 'air'
            this.airT = MIN_AIR_T
            this.maxAgl = ac.agl
            return done
          }
        }
        break
      }
    }
    return null
  }

  private finish(_ac: Autogyro, crash: string | null): LandingSample {
    const s = this.sample!
    s.crash = crash
    this.sample = null
    this.phase = 'ground'
    return s
  }

  private capture(ac: Autogyro, locate: RunwayLocator): LandingSample {
    _f.set(1, 0, 0).applyQuaternion(ac.quat)
    _r.set(0, 0, 1).applyQuaternion(ac.quat)
    const pitch = Math.asin(Math.max(-1, Math.min(1, _f.y)))
    const rest = ac.restAttitude().pitch
    // velocidad sobre el suelo justo antes de tocar, en los ejes del aparato
    const v = this.preVel
    const fwdH = Math.hypot(_f.x, _f.z) || 1
    const vf = (v.x * _f.x + v.z * _f.z) / fwdH
    const rH = Math.hypot(_r.x, _r.z) || 1
    const vr = (v.x * _r.x + v.z * _r.z) / rH
    const gs = Math.hypot(v.x, v.z)
    const loc = locate(ac.pos, _f, v)
    return {
      crash: null,
      vs: Math.max(ac.onWater ? ac.hydro.entrySpeed : ac.hardness, 0),
      ias: this.preIas,
      gs,
      pitchDeg: ((pitch - rest) * 180) / Math.PI,
      tailwheel: Boolean(ac.af.tailWheel),
      drift: gs > 1 ? vr : 0,
      crabDeg: gs > 3 ? (Math.atan2(vr, vf) * 180) / Math.PI : 0,
      runway: loc.hit,
      wantRunway: loc.want,
      rollout: 0,
      rotorRpm: ac.rotor.rpm,
      rotorRef: 350 * ac.rpmScale,
      bounces: 0,
      flareAgl: this.flareAgl,
      flareRef: glideFor(ac.af).flare,
      water: ac.onWater,
    }
  }
}
