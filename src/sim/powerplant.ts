// Planta motriz: combustible que se gasta y fallos del motor.
//
// · Combustible: el caudal sale de la potencia que da el motor en cada paso (fuel.ts). La masa
//   baja al quemarlo (y el CG se mueve si se sabe dónde está el depósito: Autogyro.setLoad). Con
//   menos de ~0,3 l utilizables el motor empieza a fallar a tirones (la toma descubre a ratos) y,
//   agotado, se para y no vuelve a arrancar.
// · Simulacro «como en la escuela»: el instructor quita gas a ralentí y lo sujeta. El motor sigue
//   en marcha y el gas no responde hasta que se cancela el ejercicio (F2) o se toma tierra.
// · Fallos reales (modo «Reales»), lo que de verdad les pasa a estos motores:
//   - parada total (encendido, bomba, rotura; en los dos tiempos, el gripaje);
//   - pérdida parcial de potencia (un carburador que empobrece, un cilindro que no quema);
//   - funcionamiento irregular (agua en la gasolina, encendido): cortes y tirones;
//   - presión de aceite baja (solo los de engrase a presión): aviso y, si se sigue volando con
//     potencia, el motor se gripa en unos minutos (el manual de Rotax: reducir potencia y tomar
//     tierra cuanto antes);
//   - hielo en el carburador (solo con carburador): se forma según la temperatura, el punto de
//     rocío y la potencia (gráfico de la hoja de seguridad 14 de la CAA británica) y quita
//     potencia poco a poco hasta parar el motor; no va en los de inyección (915 iS, IO-540).
// · Los fallos llegan cuando el piloto los pide (F2) o, con «al azar», en un momento del vuelo.
//
// En los bancos de pruebas va apagado (`enabled = false`): el depósito no baja ni falla nada, y el
// modelo de vuelo da lo mismo que sin esta planta (factor de potencia 1, gas el del piloto).

import type { Airframe } from './airframes.ts'
import type { Autogyro, Environment } from './autogyro.ts'
import { cruiseFlowLph, engineFuel, fuelFlowLph, fuelSpec, reserveLitres, type EngineFuel, type FuelSpec } from './fuel.ts'
import { icingBand, ICE_RATES, isaTempC } from './icing.ts'
import './powerplantText.ts'

export type FailureMode = 'none' | 'drill' | 'real'
export type FailureKind = 'stop' | 'partial' | 'rough' | 'oil' | 'ice' | 'fuel'
/** por qué no arranca el motor */
export type DeadCause = 'fuel' | 'seized' | 'failed' | 'ice'

/** Suceso para el juego (aviso en pantalla): clave de texto y datos. */
export interface PowerEvent {
  key: string
  vars?: Record<string, string | number>
}

/** con menos de esto (l utilizables) la toma de combustible descubre a ratos */
const STARVE_L = 0.3
/** altura mínima (m sobre el suelo) para que el instructor quite gas: ~500 ft */
const DRILL_MIN_AGL = 150
/** altura mínima para un fallo real al azar (por debajo no daría para buscar campo) */
const FAIL_MIN_AGL = 60

export class Powerplant {
  /** consumo y fallos en marcha (lo enciende el juego; los bancos de pruebas lo dejan apagado) */
  enabled = false
  /** qué fallos hay: ninguno, simulacros del instructor o fallos reales */
  mode: FailureMode = 'none'
  /** llegan solos, en un momento al azar del vuelo */
  random = false
  af!: Airframe
  spec!: FuelSpec
  ef!: EngineFuel
  /** combustible a bordo (kg, con el no utilizable) */
  fuelKg = 0
  /** caudal actual (l/h) y lo gastado desde la salida (l) */
  flowLph = 0
  burnedL = 0
  /** aviso de reserva (l utilizables) */
  reserve = 0
  /** factor de la potencia del motor (lo aplica Autogyro al par en el cigüeñal) */
  power = 1
  /** simulacro en curso: el gas se queda a ralentí */
  drill = false
  /** fallo real en curso */
  failure: FailureKind | null = null
  /** el motor no arranca (y por qué) */
  dead: DeadCause | null = null
  /** presión de aceite (bar) */
  oilBar = 0
  /** hielo en el carburador (0..1) */
  ice = 0
  /** 0..1: tirones y cortes que se oyen (sonido) */
  rough = 0
  /** sucesos pendientes de mostrar */
  readonly events: PowerEvent[] = []

  private cut = 0
  private cutRate = 0
  private partialK = 1
  private roughK = 1
  private oilDamage = 0
  private flightT = 0
  private dueT = Infinity
  private groundT = 0
  private reserveWarned = false
  private oilWarned = false
  private iceK = 1
  private noise = 0
  /** generador de azar (las pruebas ponen uno con semilla) */
  rng: () => number = Math.random

  /** Aparato nuevo: depósito con la carga de referencia de la ficha y nada roto. */
  setAirframe(af: Airframe): void {
    this.af = af
    this.spec = fuelSpec(af)
    this.ef = engineFuel(af.engine)
    this.reserve = reserveLitres(af)
    this.fuelKg = af.fuelMass
    this.reset()
  }

  /** Salida nueva: nada roto, sin simulacro, motor sano (el combustible lo pone `setLitres`). */
  reset(): void {
    this.power = 1
    this.drill = false
    this.failure = null
    this.dead = null
    this.ice = 0
    this.rough = 0
    this.cut = 0
    this.cutRate = 0
    this.partialK = 1
    this.roughK = 1
    this.oilDamage = 0
    this.oilBar = this.ef?.oilNormal ?? 0
    this.flightT = 0
    this.dueT = Infinity
    this.groundT = 0
    this.burnedL = 0
    this.flowLph = 0
    this.reserveWarned = false
    this.oilWarned = false
    this.events.length = 0
    // cada día el aire y el aparato son distintos: el hielo cuaja más o menos
    this.iceK = 0.4 + 0.9 * this.rng()
  }

  get density(): number {
    return this.spec.density
  }
  /** litros a bordo (con el no utilizable) */
  get litres(): number {
    return this.fuelKg / this.spec.density
  }
  /** litros utilizables */
  get usable(): number {
    return Math.max(0, this.litres - this.spec.unusable)
  }
  /** capacidad utilizable (l) */
  get usableCapacity(): number {
    return Math.max(0.1, this.spec.capacity - this.spec.unusable)
  }
  /** fracción del depósito utilizable (0..1): lo que marca el indicador */
  get fraction(): number {
    return Math.min(1, this.usable / this.usableCapacity)
  }
  get lowFuel(): boolean {
    return !this.spec.none && this.usable <= this.reserve
  }
  get oilLow(): boolean {
    return this.ef.oilPressure && this.oilBar < 0.8 && this.dead !== 'seized'
  }
  /** minutos de vuelo que quedan al caudal actual (Infinity si no gasta) */
  get enduranceMin(): number {
    return this.flowLph > 0.1 ? (this.usable / this.flowLph) * 60 : Infinity
  }

  /** Litros con los que se sale (sin pasar de la capacidad). */
  setLitres(l: number): void {
    this.fuelKg = Math.max(0, Math.min(this.spec.capacity, l)) * this.spec.density
  }

  /** Fallos del menú: al cambiar, el próximo (si van al azar) se vuelve a sortear. */
  setMode(mode: FailureMode, random: boolean): void {
    if (mode === this.mode && random === this.random) return
    this.mode = mode
    this.random = random && mode !== 'none'
    this.dueT = Infinity
  }

  /** Gas que llega al carburador: el del piloto, o ralentí si el instructor lo sujeta. */
  throttle(cmd: number): number {
    return this.drill ? 0 : cmd
  }

  /** El motor puede arrancar (llave): null si sí; si no, la causa. */
  startBlock(): DeadCause | null {
    if (this.dead === 'ice' && this.ice < 0.4) this.dead = null
    if (this.dead === null && !this.spec.none && this.usable <= 0) return 'fuel'
    return this.dead
  }

  startDrill(): void {
    if (this.drill) return
    this.drill = true
    this.events.push({ key: 'pp.drillStart' })
  }

  endDrill(onGround = false): void {
    if (!this.drill) return
    this.drill = false
    this.events.push({ key: onGround ? 'pp.drillLanded' : 'pp.drillEnd' })
    // el siguiente, más tarde (si van al azar)
    if (this.random && this.mode === 'drill') this.dueT = this.flightT + 90 + this.rng() * 210
  }

  /**
   * Tecla de fallos (F2): termina el simulacro en curso; si no hay, empieza uno o, en el modo de
   * fallos reales, provoca uno. Devuelve false si no hace nada.
   */
  request(ac: Autogyro): boolean {
    if (this.drill) {
      this.endDrill()
      return true
    }
    if (this.mode === 'real') {
      if (this.failure || this.dead) {
        this.events.push({ key: 'pp.already' })
        return false
      }
      this.trigger(ac)
      return true
    }
    if (ac.onGround || !ac.engineOn) {
      this.events.push({ key: 'pp.drillAir' })
      return false
    }
    this.startDrill()
    return true
  }

  /** Fallo real ya (`kind`, o uno al azar con lo que suele romperse en ese motor). */
  trigger(ac: Autogyro, kind?: FailureKind): void {
    const ef = this.ef
    if (!kind) {
      const w: [FailureKind, number][] = ef.twoStroke
        ? [['stop', 0.45], ['partial', 0.25], ['rough', 0.3]]
        : ef.oilPressure
          ? [['stop', 0.2], ['partial', 0.3], ['rough', 0.25], ['oil', 0.25]]
          : [['stop', 0.4], ['partial', 0.3], ['rough', 0.3]]
      let r = this.rng() * w.reduce((a, b) => a + b[1], 0)
      kind = w[w.length - 1][0]
      for (const [k, p] of w) {
        if ((r -= p) <= 0) {
          kind = k
          break
        }
      }
    }
    this.failure = kind
    switch (kind) {
      case 'stop':
        this.kill(ac, ef.twoStroke ? 'seized' : 'failed')
        this.events.push({ key: ef.twoStroke ? 'pp.seize' : 'pp.stop' })
        break
      case 'partial':
        // (del par: la potencia cae más, porque con menos par la hélice frena el motor)
        this.partialK = 0.5 + 0.3 * this.rng()
        this.events.push({ key: 'pp.partial' })
        break
      case 'rough':
        this.roughK = 0.7 + 0.2 * this.rng()
        this.cutRate = 1.5 + 3 * this.rng()
        this.events.push({ key: 'pp.rough' })
        break
      case 'oil':
        // la presión cae en unos segundos (fuga, bomba): el aviso llega al bajar de 0,8 bar
        this.oilDamage = 0
        break
      case 'ice':
        this.ice = Math.max(this.ice, 0.5)
        break
      case 'fuel':
        break
    }
  }

  private kill(ac: Autogyro, cause: DeadCause): void {
    this.dead = cause
    ac.engineOn = false
  }

  step(dt: number, ac: Autogyro, env: Environment): void {
    if (!this.enabled) return
    const ef = this.ef
    const running = ac.engineOn
    // (posado: en tierra o en el agua, aunque los flotadores aún planeen)
    const airborne = !ac.onGround && !ac.onWater

    // ---------------- combustible ----------------
    if (running && !this.spec.none) {
      this.flowLph = fuelFlowLph(ac.af.engine, ef, ac.enginePower, ac.engineRpm)
      const dl = (this.flowLph * dt) / 3600
      this.fuelKg = Math.max(0, this.fuelKg - dl * this.spec.density)
      this.burnedL += dl
    } else this.flowLph = 0
    if (!this.spec.none && this.lowFuel && !this.reserveWarned) {
      this.reserveWarned = true
      // (litros con un decimal por debajo de 10; minutos a crucero, al menos 1)
      const l = this.usable < 10 ? Math.round(this.usable * 10) / 10 : Math.round(this.usable)
      this.events.push({ key: 'pp.reserve', vars: { l, min: Math.max(1, Math.round((this.usable / cruiseFlowLph(ac.af.engine)) * 60)) } })
    }

    // ---------------- cuándo llegan los fallos ----------------
    if (airborne) {
      this.flightT += dt
      this.groundT = 0
      if (this.dueT === Infinity && this.random && this.mode !== 'none') {
        // el primero: entre 1 y 4 min de vuelo (simulacro) o entre 1,5 y 6 (fallo real); con más
        // (hasta 12 min) casi nunca llegaba en un vuelo normal y parecía que no funcionaba
        this.dueT = this.flightT + (this.mode === 'drill' ? 60 + this.rng() * 180 : 90 + this.rng() * 270)
      }
    } else this.groundT += dt
    if (this.flightT >= this.dueT && airborne && running) {
      if (this.mode === 'drill' && !this.drill && ac.agl > DRILL_MIN_AGL) {
        this.dueT = Infinity
        this.startDrill()
      } else if (this.mode === 'real' && !this.failure && ac.agl > FAIL_MIN_AGL) {
        // (uno por vuelo)
        this.dueT = -Infinity
        this.trigger(ac)
      }
    }
    // el simulacro termina al tomar tierra
    if (this.drill && this.groundT > 0.8) this.endDrill(true)

    // ---------------- estado del motor ----------------
    let k = 1
    let roughness = 0
    // presión de aceite: sana, la normal con el motor en marcha (algo menos al ralentí)
    if (ef.oilPressure) {
      const rpmK = Math.min(1, ac.engineRpm / Math.max(1, ac.af.engine.cruiseRpm))
      const healthy = running || ac.engineRpm > 300 ? ef.oilNormal * (0.45 + 0.55 * rpmK) : 0
      const target = this.failure === 'oil' ? (running ? 0.35 : 0) : healthy
      this.oilBar += (target - this.oilBar) * Math.min(1, dt / (this.failure === 'oil' ? 12 : 1.5))
      if (this.failure === 'oil' && running) {
        if (this.oilBar < 0.8 && !this.oilWarned) {
          this.oilWarned = true
          this.events.push({ key: 'pp.oil' })
        }
        // sin aceite, el motor se desgasta según la potencia: a crucero se gripa en ~5 min, al
        // ralentí aguanta mucho más
        if (this.oilBar < 1.2) {
          const load = Math.max(0, ac.enginePower) / ac.maxPower
          this.oilDamage += ((0.12 + load) / 260) * dt
        }
        if (this.oilDamage > 0.85) {
          // los últimos segundos: pierde potencia y golpea
          const d = (this.oilDamage - 0.85) / 0.15
          k *= 1 - 0.6 * d
          roughness = Math.max(roughness, 0.4 + 0.5 * d)
          this.cutRate = Math.max(this.cutRate, 2 + 4 * d)
        }
        if (this.oilDamage >= 1) {
          this.kill(ac, 'seized')
          this.events.push({ key: 'pp.oilSeize' })
        }
      }
    }
    // hielo en el carburador (solo con fallos reales y carburador)
    if (this.mode === 'real' && ef.induction === 'carb') {
      const oat = env.oatC ?? isaTempC(ac.pos.y)
      const dew = env.dewPointC ?? oat - 8
      const band = icingBand(oat, dew)
      const low = ac.enginePower < 0.35 * ac.maxPower
      const rate = band > 0 ? ICE_RATES[band][low ? 0 : 1] * ef.iceRisk * this.iceK : 0
      if (running) {
        // se funde poco a poco si el aire deja de dar hielo (el motor calienta la toma)
        this.ice += (rate > 0 ? rate : -1 / 6) * (dt / 60)
        // con poca humedad el hielo no pasa de una capa fina
        if (band === 1) this.ice = Math.min(this.ice, 0.35)
      } else this.ice -= (dt / 60) * 0.6
      this.ice = Math.max(0, Math.min(1, this.ice))
      if (this.ice > 0) {
        k *= 1 - 0.7 * Math.pow(this.ice, 1.5)
        if (this.ice > 0.7) {
          roughness = Math.max(roughness, (this.ice - 0.7) / 0.3)
          this.cutRate = Math.max(this.cutRate, 1 + 5 * (this.ice - 0.7))
        }
        if (this.ice >= 1 && running) {
          this.kill(ac, 'ice')
          this.events.push({ key: 'pp.iceStop' })
        }
      }
    }
    if (this.failure === 'partial') {
      // pierde lo que pierde y ronronea algo irregular
      this.noise += ((this.rng() - 0.5) * 0.2 - this.noise) * Math.min(1, dt * 2)
      k *= this.partialK * (1 + this.noise)
      roughness = Math.max(roughness, 0.2)
    }
    if (this.failure === 'rough') {
      k *= this.roughK
      roughness = Math.max(roughness, 0.6)
    }
    // falta de combustible: la toma descubre a ratos y al final se para
    if (!this.spec.none && running) {
      const u = this.usable
      if (u <= 0) {
        this.failure = 'fuel'
        this.kill(ac, 'fuel')
        this.events.push({ key: 'pp.fuelOut' })
      } else if (u < STARVE_L) {
        const s = 1 - u / STARVE_L
        roughness = Math.max(roughness, 0.5 + 0.5 * s)
        this.cutRate = Math.max(this.cutRate, 0.5 + 6 * s)
        if (this.failure === null) this.failure = 'fuel'
      }
    }
    // cortes: tirones de 0,05-0,35 s, más seguidos cuanto peor va
    if (this.cut > 0) this.cut -= dt
    else if (roughness > 0 && running && this.rng() < this.cutRate * roughness * dt) this.cut = 0.05 + 0.3 * this.rng() * roughness
    if (this.cut > 0) k = 0
    this.power = running ? Math.max(0, k) : 1
    this.rough = running ? roughness : 0
  }

  /** Lo que se ve en el HUD: avisos rojos y precauciones ámbar (claves de texto). */
  status(ac: Autogyro): { warnings: string[]; cautions: string[] } {
    const warnings: string[] = []
    const cautions: string[] = []
    if (!this.enabled) return { warnings, cautions }
    if (this.oilLow && ac.engineOn) warnings.push('pp.w.oil')
    if (this.dead && !ac.onGround) warnings.push('pp.w.engine')
    if (this.drill) cautions.push('pp.c.drill')
    if (this.lowFuel) cautions.push(this.usable <= 0 ? 'pp.c.fuelOut' : 'pp.c.fuel')
    if (ac.engineOn && !this.drill && this.lossFactor() < 0.8) cautions.push('pp.c.power')
    return { warnings, cautions }
  }

  /** Potencia que queda respecto a la de un motor sano (sin contar los cortes). */
  lossFactor(): number {
    let k = 1
    if (this.failure === 'partial') k *= this.partialK
    if (this.failure === 'rough') k *= this.roughK
    if (this.ice > 0) k *= 1 - 0.7 * Math.pow(this.ice, 1.5)
    if (this.failure === 'oil' && this.oilDamage > 0.85) k *= 1 - 0.6 * ((this.oilDamage - 0.85) / 0.15)
    return k
  }

  /** Emergencia para la guía: qué pasa con el motor (null si nada). */
  emergency(ac: Autogyro): 'drill' | 'out' | 'power' | 'oil' | 'fuel' | null {
    if (!this.enabled) return null
    if (this.drill) return 'drill'
    if (this.dead || (!ac.engineOn && this.failure)) return 'out'
    if (this.failure === 'oil' && this.oilBar < 0.8) return 'oil'
    if (ac.engineOn && this.lossFactor() < 0.8) return 'power'
    if (this.failure === 'rough' || this.failure === 'partial' || (this.failure === 'fuel' && this.usable > 0)) return 'power'
    if (this.lowFuel) return 'fuel'
    return null
  }

  consumeEvents(): PowerEvent[] {
    const out = this.events.slice()
    this.events.length = 0
    return out
  }
}
