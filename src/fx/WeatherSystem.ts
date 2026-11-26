// Une el tiempo del día (sim/weather.ts) con lo que se ve, se oye y se nota: bruma y niebla del
// render (render/Weather.ts), base de las nubes, lluvia y nieve alrededor de la cámara
// (Precipitation.ts), gotas en los vidrios (GlassRain.ts), sonido (audio/RainSound.ts) y agarre de
// las ruedas (`grip`, que main pasa a la física). main.ts solo llama a `apply`, `setGround` y `frame`.

import type { PerspectiveCamera, Vector3 as V3 } from 'three'
import { Vector3 } from 'three'
import type { AircraftView } from '../aircraft/AircraftView.ts'
import { RainSound } from '../audio/RainSound.ts'
import type { CloudPreset, Settings } from '../config.ts'
import type { Graphics } from '../render/Graphics.ts'
import type { AirModel } from '../sim/airMass.ts'
import { snowFraction, solveWeather, SURFACE_GRIP, type WeatherState } from '../sim/weather.ts'
import { GlassRain } from './GlassRain.ts'

const PRESET_BASE: Record<CloudPreset, number> = { clear: 1500, fair: 1300, scattered: 1150, overcast: 900 }
const KT = 0.514444

export interface WeatherFrame {
  camera: PerspectiveCamera
  view: AircraftView
  /** velocidad del aparato (mundo) y del aire (m/s) */
  vel: V3
  tas: number
  /** viento en el aparato (mundo, m/s) */
  wind: V3
  /** vista desde el asiento */
  cockpit: boolean
  /** altura elipsoidal de la cámara y del aparato */
  camH: number
  acH: number
  /** salida de audio (o null si aún no hay sonido) */
  audio: { ctx: AudioContext; node: AudioNode } | null
  /** en el menú o en pausa: sin sonido de lluvia */
  quiet: boolean
}

export class WeatherSystem {
  state: WeatherState | null = null
  /** agarre de las ruedas respecto al asfalto seco (1 = seco): `Environment.grip` */
  grip = 1
  surface: 'dry' | 'wet' | 'snow' = 'dry'
  readonly glass = new GlassRain()
  readonly rainSound = new RainSound()
  private readonly gfx: Graphics
  private oatC = 15
  private ground = 0
  private baseAgl = 1300
  /** exposición del jugador y lo que el ojo la sube dentro de la niebla con poca luz (1 = nada) */
  private exposure = 2.6
  private adapt = 1
  private readonly light = new Vector3()
  private readonly relWind = new Vector3()
  private readonly eye = new Vector3()

  constructor(gfx: Graphics) {
    this.gfx = gfx
    gfx.precip.world.add(this.glass.group)
  }

  /** Ajustes nuevos (menú, tiempo real o la sala). `air` ya con esos ajustes y la elevación de la salida. */
  apply(s: Settings, lat: number, lon: number, simDate: Date, air: AirModel): void {
    this.oatC = air.groundTempC()
    this.exposure = s.exposure
    this.state = solveWeather({
      oatC: this.oatC,
      dewPointC: air.groundDewC(),
      wind: s.windSpeed * KT,
      visibility: s.visibility,
      precip: s.precip,
      weatherCode: s.weatherCode,
      clouds: s.clouds,
      isa: s.isa,
      lat,
      lon,
      dayOfYear: s.dayOfYear,
      utcHours: simDate.getUTCHours() + simDate.getUTCMinutes() / 60,
    })
    this.baseAgl = this.state.cloudBaseAgl ?? PRESET_BASE[s.clouds]
    this.gfx.weather.set(this.state, this.oatC, this.ground, this.baseAgl)
  }

  /** Base de las nubes sobre el suelo si es más baja que la del preset (para Graphics.setClouds). */
  get cloudBaseAgl(): number | null {
    return this.state?.cloudBaseAgl ?? null
  }

  /** Suelo de la salida (altura elipsoidal): a él se refieren la niebla y la cota de nieve. */
  setGround(groundEllipsoid: number): void {
    this.ground = groundEllipsoid
    if (this.state) this.gfx.weather.set(this.state, this.oatC, this.ground, this.baseAgl)
  }

  frame(dt: number, f: WeatherFrame): void {
    const st = this.state
    const gfx = this.gfx
    const wx = gfx.weather
    const raining = st !== null && st.kind !== 'none'
    // --- agarre de las ruedas: mojado o con nieve según la temperatura a la altura del aparato ---
    const lapse = (h: number) => this.oatC - 0.0065 * (h - this.ground)
    this.surface = !raining ? 'dry' : snowFraction(lapse(f.acH)) > 0.5 ? 'snow' : 'wet'
    this.grip = SURFACE_GRIP[this.surface]

    // --- lo que cae alrededor de la cámara ---
    let amount = 0
    let snow = 0
    let fall = 6.5
    if (raining) {
      const rel = f.camH - this.ground
      // dentro de la nube ya no llueve: se apaga entre la base y 300 m más arriba
      const under = 1 - Math.min(1, Math.max(0, (rel - this.baseAgl) / 300))
      snow = snowFraction(lapse(f.camH))
      const lg = Math.log10(Math.max(st.rate, 0.05))
      const rainAmt = Math.min(1, Math.max(0.15, 0.35 + 0.47 * lg))
      const snowAmt = Math.min(1, Math.max(0.25, 0.5 + 0.45 * lg))
      amount = (rainAmt + (snowAmt - rainAmt) * snow) * under
      fall = st.kind === 'drizzle' ? 2 : st.kind === 'shower' ? 9 : 6.5
    }
    // luz ambiente que ilumina gotas y copos (blanco difuso bajo el sol y el cielo que quedan)
    const tv = wx.active ? wx.above(f.camH - this.ground) : 0
    this.light
      .copy(wx.sun.value)
      .multiplyScalar(Math.max(wx.sunMu.value, 0))
      .add(wx.amb.value)
      .multiplyScalar(1 / (Math.PI * (1 + 0.1125 * tv)))
    // El ojo dentro de la niebla: rodeado de un campo uniforme y poco luminoso (al alba una niebla
    // recibe 20–50 veces menos luz que a mediodía) se adapta a él y la ve gris clara, no negra. Solo
    // cuenta lo que la niebla tapa a menos de 300 m; por encima de ella, con el cielo a la vista, nada.
    {
      const h = f.camH - this.ground
      const beta = wx.active ? wx.extinction(h) : 0
      // (de noche no: ahí mandan las luces del aparato y su propia adaptación)
      const day = Math.min(1, Math.max(0, (wx.sunMu.value + 0.1) / 0.1))
      const inFog = (1 - Math.exp(-beta * 300)) * day
      const lum = 0.2126 * this.light.x + 0.7152 * this.light.y + 0.0722 * this.light.z
      const want = 1 + (Math.min(8, Math.max(1, 0.09 / Math.max(lum, 1e-4))) - 1) * inFog
      this.adapt += (want - this.adapt) * Math.min(1, dt / 1.5)
      if (Math.abs(this.adapt - 1) < 1e-3) this.adapt = 1
      gfx.renderer.toneMappingExposure = this.exposure * this.adapt
    }
    const view = f.view
    view.eyeWorld(this.eye)
    this.glass.attach(view.glass, view.root, this.eye)
    const inside = f.cockpit && this.glass.enclosed
    const liquid = amount * (1 - snow)
    this.relWind.copy(f.wind).sub(f.vel)
    gfx.precip.extra = this.glass.update(dt, liquid, f.tas, this.relWind, view.root, this.light, gfx.precip.depth)
    gfx.precip.update(dt, { amount, snow, fall, wind: f.wind, light: this.light, near: inside ? 1.7 : 0.35 })

    // --- sonido ---
    if (f.audio) {
      this.rainSound.attach(f.audio.ctx, f.audio.node)
      this.rainSound.update({ amount: f.quiet ? 0 : liquid, cockpit: f.cockpit, enclosed: this.glass.enclosed, tas: f.tas })
    }
  }
}
