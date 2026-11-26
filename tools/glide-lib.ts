// Planeo sin motor de un aparato, volado con el propio modelo de vuelo (para tools/fdm-glide.ts y
// tools/fdm-failures.ts): la polar con la palanca fija en cada posición (en un autogiro la palanca
// fija la velocidad) y la toma con recogida a una altura dada, con el mismo «piloto de teclado» y
// la misma ayuda al pilotaje que tools/fdm-scenarios.ts.
import { Vector3 } from 'three'
import { Autogyro, defaultControls, type Controls, type Environment } from '../src/sim/autogyro.ts'
import { keyPitchRate, PilotAssist } from '../src/sim/assist.ts'
import { isaDensity } from '../src/sim/atmosphere.ts'
import type { Airframe } from '../src/sim/airframes.ts'

export const DT = 1 / 240
const flat = { heightAt: (_x: number, _z: number, n: Vector3) => (n.set(0, 1, 0), 0) }
// (el Wilford, sin ruedas, toma en un lago)
const lake = { ...flat, waterDepth: () => 6 }

/** Aire de las pruebas: 650 m (Casarrubios), sin viento. */
export function testEnv(af: Airframe): Environment {
  return { rho: isaDensity(650), wind: new Vector3(), ground: af.keelGear ? lake : flat }
}

export interface GlidePoint {
  stick: number
  /** km/h de IAS */
  ias: number
  /** velocidad sobre el suelo (km/h, sin viento: la horizontal) */
  gs: number
  /** m/s (negativo: baja) */
  vs: number
  ratio: number
}

/**
 * Planeo con la palanca fija en `stick`: motor al ralentí (gas cortado) o parado. Se deja asentar
 * `settle` s y se promedia `measure` s.
 */
export function glideAt(af: Airframe, stick: number, engine: 'idle' | 'off', settle = 40, measure = 20): GlidePoint | null {
  const env = testEnv(af)
  const ac = new Autogyro(af)
  ac.setLoad(false)
  ac.placeInAir(0, 3000, 0, 90, 26)
  ac.engineOn = engine === 'idle'
  if (engine === 'off') ac.enginePower = 0
  const ctl: Controls = defaultControls()
  const assist = new PilotAssist()
  let t = 0
  let n = 0
  let ias = 0
  let gs = 0
  let vs = 0
  // (se llega a la posición de palanca poco a poco, como con el teclado)
  let s = 0
  while (t < settle + measure) {
    s += Math.sign(stick - s) * Math.min(Math.abs(stick - s), 0.6 * DT)
    ctl.pitch = s
    ctl.roll = 0
    ctl.yaw = 0
    ctl.throttle = 0
    assist.apply(DT, ac, ctl, { pitchActive: false, rollActive: false, yawActive: false, analog: false })
    ac.step(DT, ctl, env)
    if (ac.crash) return null
    t += DT
    if (t > settle) {
      n++
      ias += ac.ias * 3.6
      gs += ac.groundSpeed * 3.6
      vs += ac.vs
    }
  }
  ias /= n
  gs /= n
  vs /= n
  return { stick, ias, gs, vs, ratio: vs < -0.05 ? gs / 3.6 / -vs : 99 }
}

/** Polar de planeo: puntos de palanca −0,3 … 1. */
export function polar(af: Airframe, engine: 'idle' | 'off'): GlidePoint[] {
  const out: GlidePoint[] = []
  for (let s = -0.3; s <= 1.001; s += 0.05) {
    const p = glideAt(af, Math.round(s * 100) / 100, engine)
    if (p) out.push(p)
  }
  return out
}

export interface GlideBest {
  /** IAS de mejor planeo (km/h), fineza y descenso a esa velocidad (m/s) */
  best: number
  ratio: number
  sink: number
  /** palanca con la que se vuela */
  stick: number
  /** mínimo descenso: m/s y a qué IAS */
  minSink: number
  minSinkV: number
}

/** Mejor planeo y mínimo descenso de una polar (parábola por los tres puntos de alrededor). */
export function bestOf(pts: GlidePoint[]): GlideBest {
  const ok = pts.filter((p) => p.ias > 25 && p.ratio < 50)
  let bi = 0
  for (let i = 1; i < ok.length; i++) if (ok[i].ratio > ok[bi].ratio) bi = i
  let mi = 0
  for (let i = 1; i < ok.length; i++) if (ok[i].vs > ok[mi].vs) mi = i
  const b = ok[bi]
  let best = b.ias
  let stick = b.stick
  if (bi > 0 && bi < ok.length - 1) {
    // vértice de la parábola fineza(IAS)
    const [p0, p1, p2] = [ok[bi - 1], b, ok[bi + 1]]
    const d = (p0.ias - p1.ias) * (p0.ias - p2.ias) * (p1.ias - p2.ias)
    const A = (p2.ias * (p1.ratio - p0.ratio) + p1.ias * (p0.ratio - p2.ratio) + p0.ias * (p2.ratio - p1.ratio)) / d
    const B = (p2.ias * p2.ias * (p0.ratio - p1.ratio) + p1.ias * p1.ias * (p2.ratio - p0.ratio) + p0.ias * p0.ias * (p1.ratio - p2.ratio)) / d
    if (A < 0) {
      const v = -B / (2 * A)
      if (v > Math.min(p0.ias, p2.ias) && v < Math.max(p0.ias, p2.ias)) {
        best = v
        // palanca a esa velocidad, interpolada
        const q = v < p1.ias === p0.ias < p1.ias ? p0 : p2
        stick = p1.stick + ((q.stick - p1.stick) * (v - p1.ias)) / (q.ias - p1.ias)
      }
    }
  }
  return { best, ratio: b.ratio, sink: b.vs, stick, minSink: ok[mi].vs, minSinkV: ok[mi].ias }
}

export interface Landing {
  crash: string
  impact: number
  ias: number
  ac: Autogyro
}

/**
 * Toma sin motor desde un planeo con la palanca en `stick`: a `flareAgl` m se tira de la palanca
 * con el teclado (mantener S) hasta el tope, como en tools/fdm-scenarios.ts.
 */
export function landing(
  af: Airframe,
  stick: number,
  flareAgl: number,
  engine: 'idle' | 'off' = 'off',
  opts: { setup?: (ac: Autogyro) => void; after?: number } = {},
): Landing {
  const env = testEnv(af)
  const ac = new Autogyro(af)
  ac.setLoad(false)
  ac.placeInAir(0, 140, 0, 90, 24)
  ac.engineOn = engine === 'idle'
  ac.enginePower = 0
  ac.engineRpm = 2500 * (af.engine.cruiseRpm / 4400)
  opts.setup?.(ac)
  let touch = -1
  const ctl: Controls = defaultControls()
  const assist = new PilotAssist()
  let s = stick
  let hold = 0
  let t = 0
  let wasAir = false
  let out: Landing | null = null
  while (t < 120) {
    const pull = !ac.onGround && ac.agl < flareAgl && s < 0.99
    hold = pull ? hold + DT : 0
    if (pull) s = Math.min(1, s + keyPitchRate(hold) * DT)
    ctl.pitch = s
    ctl.roll = 0
    ctl.yaw = 0
    ctl.throttle = 0
    ctl.wheelBrake = ac.onGround ? 1 : 0
    assist.apply(DT, ac, ctl, { pitchActive: pull, rollActive: false, yawActive: false, analog: false })
    ac.step(DT, ctl, env)
    t += DT
    if (ac.crash) return { crash: ac.crash.title, impact: ac.hardness, ias: ac.ias * 3.6, ac }
    if (!ac.onGround) wasAir = true
    else if (wasAir && touch < 0) {
      touch = t
      out = { crash: '', impact: ac.hardness, ias: ac.ias * 3.6, ac }
    }
    // (sigue rodando y frenando `after` segundos tras tocar)
    if (out && t - touch >= (opts.after ?? 0)) return out
  }
  return out ?? { crash: 'no llega al suelo', impact: 0, ias: 0, ac }
}
