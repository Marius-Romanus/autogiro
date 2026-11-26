// Panel de instrumentos dibujado en canvas 2D.

import { t } from '../i18n.ts'
import type { TachSpec } from '../sim/engines.ts'
import type { AsiSpec } from '../sim/airframes.ts'

export interface HudData {
  iasKmh: number
  altFt: number
  vsFpm: number
  rotorRpm: number
  engineRpm: number
  heading: number // grados
  slip: number // −1..1 (bola)
  trim: number // −1..1
  throttle: number // 0..1
  g: number
  agl: number // m
  gsKmh: number
  windFrom: number
  windKt: number
  warnings: string[]
  /** precauciones (ámbar): reserva de combustible, simulacro, pérdida de potencia (sim/powerplant.ts) */
  cautions?: string[]
  /** combustible utilizable: fracción del depósito (0..1) y litros; falta si el aparato no gasta */
  fuel?: number
  fuelL?: number
  /** luces de aviso: reserva de combustible, presión de aceite baja, simulacro de fallo de motor */
  fuelLow?: boolean
  oilLow?: boolean
  drill?: boolean
  prerot: boolean
  rotorBrake: boolean
  parkBrake: boolean
  /** tren de unos flotadores anfibios (si el aparato lo lleva) */
  gear?: 'down' | 'up' | 'moving'
  engineOn: boolean
  camName: string
  onGround: boolean
  stickPitch: number
  stickRoll: number
  pedals: number
  mouseStick: boolean
  /** la rueda del ratón mueve el gas */
  wheelThrottle: boolean
  /** derrape (rad), positivo = el aparato se desplaza a la derecha respecto al aire */
  beta: number
  cockpit: boolean
  /** indicación breve para el piloto (no es una alarma) */
  hint: string
  /** vueltas de rotor del aparato respecto a las de los autogiros actuales (escala del tacómetro) */
  rpmScale?: number
  /** escala del aviso de pocas vueltas si no es la de `rpmScale` (rotor lento: sigue su programa de vueltas) */
  rpmWarn?: number
  /** arcos propios del cuentavueltas del rotor (rotor lento de un compuesto): verde y principio del rojo, en rpm */
  rotorArcs?: { green: [number, number]; red: number }
  /** escala del cuentarrevoluciones del motor del aparato */
  tach?: TachSpec
  /** escala del velocímetro del aparato (si no, 0-200 km/h) */
  asi?: AsiSpec
}

const DEFAULT_ASI: AsiSpec = { max: 200, step: 40, minor: 10, green: [45, 150], yellow: [150, 180], red: 180 }

const ROTAX_TACH: TachSpec = { max: 7000, step: 1000, minor: 500, green: [1400, 5500], yellow: [5500, 5800], red: 5800 }

const TAU = Math.PI * 2

export class Hud {
  private ctx: CanvasRenderingContext2D
  private dpr = 1
  visible = true
  /**
   * Borde inferior (px) de la pila de avisos rojos, precauciones ámbar e indicación del centro de
   * arriba; 0 si no hay ninguno. main.ts pone ahí debajo los avisos de texto («toast») para que no se
   * pisen.
   */
  stackBottom = 0
  private acc = 0
  private blink = 0

  private canvas: HTMLCanvasElement
  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')!
    this.resize()
    window.addEventListener('resize', () => this.resize())
  }

  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio, 2)
    this.canvas.width = Math.round(window.innerWidth * this.dpr)
    this.canvas.height = Math.round(window.innerHeight * this.dpr)
  }

  draw(d: HudData, dt: number): void {
    this.acc += dt
    this.blink += dt
    if (this.acc < 1 / 40) return
    this.acc = 0
    const c = this.ctx
    const W = this.canvas.width / this.dpr
    const H = this.canvas.height / this.dpr
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    c.clearRect(0, 0, W, H)
    if (!this.visible) {
      this.drawWarnings(c, d, W)
      return
    }

    // panel inferior
    const size = Math.max(92, Math.min(148, (W - 120) / 7.2))
    const gap = size * 0.14
    const n = 6
    const total = n * size + (n - 1) * gap
    let x = (W - total) / 2 + size / 2
    const y = H - size / 2 - 16
    // fondo
    c.save()
    const pad = 14
    roundRect(c, (W - total) / 2 - pad, y - size / 2 - pad, total + pad * 2, size + pad * 2 + 4, 22)
    c.fillStyle = 'rgba(10,12,16,0.55)'
    c.fill()
    c.strokeStyle = 'rgba(255,255,255,0.08)'
    c.lineWidth = 1
    c.stroke()
    c.restore()

    this.asi(c, x, y, size, d)
    x += size + gap
    this.alt(c, x, y, size, d)
    x += size + gap
    this.rotor(c, x, y, size, d)
    x += size + gap
    this.engine(c, x, y, size, d)
    x += size + gap
    this.vsi(c, x, y, size, d)
    x += size + gap
    this.hdg(c, x, y, size, d)

    // barras laterales: gas y compensador, bola
    const left = (W - total) / 2 - pad - 54
    this.bars(c, left, y - size / 2, size, d)
    const right = (W + total) / 2 + pad + 18
    this.sidePanel(c, right, y - size / 2, size, d)

    this.drawWarnings(c, d, W)
  }

  /** Dibuja un reloj en otro lienzo (panel 3D de la cabina, src/aircraft/Cockpit.ts). */
  drawGauge(c: CanvasRenderingContext2D, kind: 'asi' | 'alt' | 'vsi' | 'rotor' | 'engine' | 'hdg', x: number, y: number, size: number, d: HudData): void {
    c.save()
    this[kind](c, x, y, size, d)
    c.restore()
  }

  private face(c: CanvasRenderingContext2D, x: number, y: number, s: number, label: string, unit: string): number {
    const r = s / 2
    c.save()
    const g = c.createRadialGradient(x, y - r * 0.3, r * 0.1, x, y, r)
    g.addColorStop(0, '#24272d')
    g.addColorStop(1, '#0d0f12')
    c.fillStyle = g
    c.beginPath()
    c.arc(x, y, r, 0, TAU)
    c.fill()
    c.lineWidth = r * 0.06
    c.strokeStyle = '#3a3e45'
    c.stroke()
    c.fillStyle = 'rgba(255,255,255,0.55)'
    c.font = `600 ${r * 0.13}px "Barlow Condensed", Barlow, system-ui, sans-serif`
    c.textAlign = 'center'
    c.fillText(label, x, y - r * 0.32)
    c.fillStyle = 'rgba(255,255,255,0.38)'
    c.font = `500 ${r * 0.11}px "Barlow Condensed", Barlow, system-ui, sans-serif`
    c.fillText(unit, x, y + r * 0.5)
    c.restore()
    return r
  }

  private arc(c: CanvasRenderingContext2D, x: number, y: number, r: number, a0: number, a1: number, color: string, w: number): void {
    c.beginPath()
    c.arc(x, y, r, a0, a1)
    c.strokeStyle = color
    c.lineWidth = w
    c.stroke()
  }

  private ticks(
    c: CanvasRenderingContext2D,
    x: number,
    y: number,
    r: number,
    min: number,
    max: number,
    a0: number,
    a1: number,
    major: number,
    minor: number,
    labelFn: (v: number) => string,
  ): void {
    c.save()
    c.strokeStyle = '#e8e8e8'
    c.fillStyle = '#f0f0f0'
    c.textAlign = 'center'
    c.textBaseline = 'middle'
    c.font = `600 ${r * 0.15}px "Barlow Condensed", Barlow, system-ui, sans-serif`
    for (let v = min; v <= max + 1e-6; v += minor) {
      const a = a0 + ((v - min) / (max - min)) * (a1 - a0)
      const isMajor = Math.abs(v / major - Math.round(v / major)) < 1e-6
      const r0 = r * (isMajor ? 0.78 : 0.85)
      c.lineWidth = isMajor ? r * 0.035 : r * 0.018
      c.beginPath()
      c.moveTo(x + Math.cos(a) * r0, y + Math.sin(a) * r0)
      c.lineTo(x + Math.cos(a) * r * 0.93, y + Math.sin(a) * r * 0.93)
      c.stroke()
      if (isMajor) c.fillText(labelFn(v), x + Math.cos(a) * r * 0.62, y + Math.sin(a) * r * 0.62)
    }
    c.restore()
  }

  private needle(c: CanvasRenderingContext2D, x: number, y: number, r: number, a: number, len = 0.82, color = '#ffffff', w = 0.05): void {
    c.save()
    c.translate(x, y)
    c.rotate(a)
    c.fillStyle = color
    c.shadowColor = 'rgba(0,0,0,0.6)'
    c.shadowBlur = r * 0.06
    c.beginPath()
    c.moveTo(-r * 0.12, -r * w)
    c.lineTo(r * len, -r * 0.012)
    c.lineTo(r * len, r * 0.012)
    c.lineTo(-r * 0.12, r * w)
    c.closePath()
    c.fill()
    c.restore()
    c.beginPath()
    c.fillStyle = '#2d3036'
    c.arc(x, y, r * 0.08, 0, TAU)
    c.fill()
  }

  private valueAngle(v: number, min: number, max: number, a0: number, a1: number): number {
    const t = Math.max(0, Math.min(1, (v - min) / (max - min)))
    return a0 + t * (a1 - a0)
  }

  private asi(c: CanvasRenderingContext2D, x: number, y: number, s: number, d: HudData): void {
    const r = this.face(c, x, y, s, t('hud.airspeed'), 'km/h')
    const a0 = Math.PI * 0.62
    const a1 = Math.PI * 2.38
    const sc = d.asi ?? DEFAULT_ASI
    const A = (v: number) => this.valueAngle(v, 0, sc.max, a0, a1)
    this.arc(c, x, y, r * 0.88, A(sc.green[0]), A(sc.green[1]), '#2ecc71', r * 0.07)
    this.arc(c, x, y, r * 0.88, A(sc.yellow[0]), A(sc.yellow[1]), '#f1c40f', r * 0.07)
    this.arc(c, x, y, r * 0.88, A(sc.red), A(sc.red + sc.max * 0.03), '#e74c3c', r * 0.1)
    this.ticks(c, x, y, r, 0, sc.max, a0, a1, sc.step, sc.minor, (v) => `${v}`)
    this.digital(c, x, y + r * 0.27, r, `${Math.round(d.iasKmh)}`)
    this.needle(c, x, y, r, A(d.iasKmh))
  }

  private alt(c: CanvasRenderingContext2D, x: number, y: number, s: number, d: HudData): void {
    const r = this.face(c, x, y, s, t('hud.altitude'), 'ft QNH')
    const a0 = -Math.PI / 2
    const a1 = a0 + TAU
    this.ticks(c, x, y, r, 0, 1000, a0, a1 - TAU / 10, 100, 20, (v) => `${v / 100}`)
    this.digital(c, x, y + r * 0.27, r, `${Math.round(d.altFt / 10) * 10}`)
    const h1000 = (d.altFt / 10000) * TAU + a0
    const h100 = ((d.altFt % 1000) / 1000) * TAU + a0
    this.needle(c, x, y, r, h1000, 0.5, '#cfd3d8', 0.07)
    this.needle(c, x, y, r, h100, 0.84)
  }

  private vsi(c: CanvasRenderingContext2D, x: number, y: number, s: number, d: HudData): void {
    const r = this.face(c, x, y, s, t('hud.vsi'), 'ft/min ×100')
    const a0 = Math.PI * 0.12 + Math.PI
    const a1 = Math.PI * 0.88 + Math.PI * 2
    // −20 .. +20 (×100 fpm), 0 a la izquierda
    const A = (v: number) => Math.PI + (Math.max(-20, Math.min(20, v)) / 20) * Math.PI * 0.88
    this.ticks(c, x, y, r, -20, 20, Math.PI - Math.PI * 0.88, Math.PI + Math.PI * 0.88, 5, 1, (v) => `${Math.abs(v)}`)
    void a0
    void a1
    this.digital(c, x + r * 0.25, y + r * 0.27, r, `${d.vsFpm >= 0 ? '+' : ''}${Math.round(d.vsFpm / 10) * 10}`)
    this.needle(c, x, y, r, A(d.vsFpm / 100))
  }

  private rotor(c: CanvasRenderingContext2D, x: number, y: number, s: number, d: HudData): void {
    const r = this.face(c, x, y, s, t('hud.rotor'), 'rpm')
    const a0 = Math.PI * 0.75
    const a1 = Math.PI * 2.25
    // arcos de los autogiros actuales; un rotor grande y lento (Cierva) los tiene a menos vueltas
    const k = d.rpmScale ?? 1
    const max = Math.ceil((600 * k) / 100) * 100
    const A = (v: number) => this.valueAngle(v, 0, max, a0, a1)
    if (d.rotorArcs) {
      // rotor lento (Carter PAV): de ~100 rpm en crucero rápido a ~370 al prerrotar para el salto
      const ra = d.rotorArcs
      this.arc(c, x, y, r * 0.88, A(ra.green[0]), A(ra.green[1]), '#2ecc71', r * 0.07)
      this.arc(c, x, y, r * 0.88, A(ra.green[1]), A(ra.red), '#f1c40f', r * 0.07)
      this.arc(c, x, y, r * 0.88, A(ra.red), A(max), '#e74c3c', r * 0.07)
    } else {
      this.arc(c, x, y, r * 0.88, A(180 * k), A(300 * k), '#f1c40f', r * 0.07)
      this.arc(c, x, y, r * 0.88, A(300 * k), A(450 * k), '#2ecc71', r * 0.07)
      this.arc(c, x, y, r * 0.88, A(450 * k), A(520 * k), '#f1c40f', r * 0.07)
      this.arc(c, x, y, r * 0.88, A(520 * k), A(max), '#e74c3c', r * 0.07)
    }
    this.ticks(c, x, y, r, 0, max, a0, a1, 100, k < 0.8 ? 10 : 20, (v) => `${v / 100}`)
    const low = d.rotorRpm < 280 * (d.rpmWarn ?? k) && !d.onGround
    this.digital(c, x, y + r * 0.27, r, `${Math.round(d.rotorRpm)}`, low && this.blink % 0.5 < 0.25 ? '#ff5a4a' : undefined)
    this.needle(c, x, y, r, A(d.rotorRpm), 0.84, '#ffcf3a')
  }

  private engine(c: CanvasRenderingContext2D, x: number, y: number, s: number, d: HudData): void {
    const tc = d.tach ?? ROTAX_TACH
    // motores lentos (el radial del Cierva, ~2000 rpm): escala en centenas
    const div = tc.max <= 3000 ? 100 : 1000
    const r = this.face(c, x, y, s, t('hud.engine'), div === 100 ? 'rpm ×100' : 'rpm ×1000')
    const a0 = Math.PI * 0.75
    const a1 = Math.PI * 2.25
    const A = (v: number) => this.valueAngle(v, 0, tc.max, a0, a1)
    this.arc(c, x, y, r * 0.88, A(tc.green[0]), A(tc.green[1]), '#2ecc71', r * 0.07)
    this.arc(c, x, y, r * 0.88, A(tc.yellow[0]), A(tc.yellow[1]), '#f1c40f', r * 0.07)
    this.arc(c, x, y, r * 0.88, A(tc.red), A(tc.max), '#e74c3c', r * 0.07)
    this.ticks(c, x, y, r, 0, tc.max, a0, a1, tc.step, tc.minor, (v) => `${v / div}`)
    this.digital(c, x, y + r * 0.27, r, d.engineOn ? `${Math.round(d.engineRpm / 10) * 10}` : 'OFF')
    this.needle(c, x, y, r, A(d.engineRpm))
  }

  private hdg(c: CanvasRenderingContext2D, x: number, y: number, s: number, d: HudData): void {
    const r = this.face(c, x, y, s, '', '')
    c.save()
    c.translate(x, y)
    c.rotate((-d.heading * Math.PI) / 180)
    c.strokeStyle = '#e8e8e8'
    c.fillStyle = '#f0f0f0'
    c.textAlign = 'center'
    c.textBaseline = 'middle'
    for (let h = 0; h < 360; h += 5) {
      const a = (h * Math.PI) / 180 - Math.PI / 2
      const major = h % 30 === 0
      c.lineWidth = major ? r * 0.03 : r * 0.015
      c.beginPath()
      c.moveTo(Math.cos(a) * r * (h % 10 === 0 ? 0.78 : 0.84), Math.sin(a) * r * (h % 10 === 0 ? 0.78 : 0.84))
      c.lineTo(Math.cos(a) * r * 0.92, Math.sin(a) * r * 0.92)
      c.stroke()
      if (major) {
        const lbl = h === 0 ? 'N' : h === 90 ? 'E' : h === 180 ? 'S' : h === 270 ? t('hud.west') : `${h / 10}`
        c.save()
        c.translate(Math.cos(a) * r * 0.63, Math.sin(a) * r * 0.63)
        c.rotate(a + Math.PI / 2)
        c.font = `${h % 90 === 0 ? 700 : 600} ${r * (h % 90 === 0 ? 0.19 : 0.14)}px "Barlow Condensed", Barlow, system-ui, sans-serif`
        c.fillStyle = h === 0 ? '#ff7a45' : '#f0f0f0'
        c.fillText(lbl, 0, 0)
        c.restore()
      }
    }
    // flecha de viento
    const wa = ((d.windFrom + 180) * Math.PI) / 180 - Math.PI / 2
    if (d.windKt > 0.5) {
      c.strokeStyle = '#4fc3f7'
      c.lineWidth = r * 0.04
      c.beginPath()
      c.moveTo(Math.cos(wa + Math.PI) * r * 0.42, Math.sin(wa + Math.PI) * r * 0.42)
      c.lineTo(Math.cos(wa) * r * 0.3, Math.sin(wa) * r * 0.3)
      c.stroke()
      c.fillStyle = '#4fc3f7'
      c.beginPath()
      c.moveTo(Math.cos(wa) * r * 0.42, Math.sin(wa) * r * 0.42)
      c.lineTo(Math.cos(wa + 0.35) * r * 0.25, Math.sin(wa + 0.35) * r * 0.25)
      c.lineTo(Math.cos(wa - 0.35) * r * 0.25, Math.sin(wa - 0.35) * r * 0.25)
      c.fill()
    }
    c.restore()
    // avión
    c.save()
    c.translate(x, y)
    c.fillStyle = '#f6c400'
    c.beginPath()
    c.moveTo(0, -r * 0.3)
    c.lineTo(r * 0.06, r * 0.1)
    c.lineTo(r * 0.22, r * 0.14)
    c.lineTo(r * 0.06, r * 0.18)
    c.lineTo(0, r * 0.28)
    c.lineTo(-r * 0.06, r * 0.18)
    c.lineTo(-r * 0.22, r * 0.14)
    c.lineTo(-r * 0.06, r * 0.1)
    c.closePath()
    c.fill()
    c.restore()
    // índice
    c.fillStyle = '#f6c400'
    c.beginPath()
    c.moveTo(x, y - r * 0.93)
    c.lineTo(x - r * 0.06, y - r * 1.04)
    c.lineTo(x + r * 0.06, y - r * 1.04)
    c.fill()
    c.fillStyle = '#fff'
    c.font = `700 ${r * 0.16}px "Barlow Condensed", Barlow, system-ui, sans-serif`
    c.textAlign = 'center'
    c.fillText(`${String(Math.round((d.heading + 360) % 360)).padStart(3, '0')}°`, x, y + r * 0.55)
  }

  private digital(c: CanvasRenderingContext2D, x: number, y: number, r: number, text: string, color?: string): void {
    c.save()
    c.font = `700 ${r * 0.17}px "JetBrains Mono", ui-monospace, monospace`
    c.textAlign = 'center'
    c.textBaseline = 'middle'
    const w = c.measureText(text).width + r * 0.14
    roundRect(c, x - w / 2, y - r * 0.12, w, r * 0.24, r * 0.05)
    c.fillStyle = 'rgba(0,0,0,0.6)'
    c.fill()
    c.fillStyle = color ?? '#9effa8'
    c.fillText(text, x, y + r * 0.005)
    c.restore()
  }

  private bars(c: CanvasRenderingContext2D, x: number, y: number, h: number, d: HudData): void {
    c.save()
    const w = 14
    if (d.fuel !== undefined) this.fuelBar(c, Math.max(4, x - 24), y, h, w, d)
    // gas
    roundRect(c, x, y, w, h, 6)
    c.fillStyle = 'rgba(0,0,0,0.5)'
    c.fill()
    const th = d.throttle * (h - 4)
    roundRect(c, x + 2, y + h - 2 - th, w - 4, th, 4)
    c.fillStyle = '#f6c400'
    c.fill()
    c.fillStyle = 'rgba(255,255,255,0.7)'
    c.font = '600 10px "Barlow Condensed", Barlow, system-ui, sans-serif'
    c.textAlign = 'center'
    c.fillText(t('hud.throttle'), x + w / 2, y - 6)
    // compensador
    const x2 = x + 24
    roundRect(c, x2, y, w, h, 6)
    c.fillStyle = 'rgba(0,0,0,0.5)'
    c.fill()
    const ty = y + h / 2 - d.trim * (h / 2 - 6)
    c.fillStyle = '#4fc3f7'
    c.fillRect(x2 + 1, ty - 2, w - 2, 4)
    c.fillStyle = 'rgba(255,255,255,0.3)'
    c.fillRect(x2 + 3, y + h / 2, w - 6, 1)
    c.fillStyle = 'rgba(255,255,255,0.7)'
    c.fillText(t('hud.trim'), x2 + w / 2, y - 6)
    c.restore()
  }

  /** Combustible utilizable: barra (ámbar en la reserva) y los litros debajo. */
  private fuelBar(c: CanvasRenderingContext2D, x: number, y: number, h: number, w: number, d: HudData): void {
    roundRect(c, x, y, w, h, 6)
    c.fillStyle = 'rgba(0,0,0,0.5)'
    c.fill()
    const f = Math.max(0, Math.min(1, d.fuel ?? 0))
    const fh = f * (h - 4)
    const low = d.fuelLow === true
    roundRect(c, x + 2, y + h - 2 - fh, w - 4, fh, 4)
    c.fillStyle = low ? (this.blink % 1 < 0.6 ? '#ffb23a' : '#7a5212') : '#7ee08a'
    c.fill()
    // marcas de cuartos
    c.fillStyle = 'rgba(255,255,255,0.35)'
    for (let i = 1; i < 4; i++) c.fillRect(x + 3, y + 2 + ((h - 4) * i) / 4, w - 6, 1)
    c.fillStyle = 'rgba(255,255,255,0.7)'
    c.font = '600 10px "Barlow Condensed", Barlow, system-ui, sans-serif'
    c.textAlign = 'center'
    c.fillText(t('hud.fuel'), x + w / 2, y - 6)
    // litros encima del rótulo (debajo de la barra van las atribuciones del mapa)
    const txt = `${Math.round(d.fuelL ?? 0)} l`
    c.font = '700 11px "Barlow Condensed", Barlow, system-ui, sans-serif'
    const tw = c.measureText(txt).width + 6
    c.fillStyle = 'rgba(0,0,0,0.55)'
    c.fillRect(x + w / 2 - tw / 2, y - 31, tw, 14)
    c.fillStyle = low ? '#ffb23a' : '#f4f8ff'
    c.fillText(txt, x + w / 2, y - 20)
  }

  private sidePanel(c: CanvasRenderingContext2D, x: number, yTop: number, h: number, d: HudData): void {
    c.save()
    // El contenido mide SIDE_H de alto y se ancla abajo: 4 datos, bola, hasta 4 indicadores
    // y la cámara, cada cosa en su fila (antes la cámara pisaba el tercer indicador).
    const SIDE_H = 148
    const y = yTop + h - SIDE_H
    const bw = 104
    const ms = 44
    const mx = x + bw + 18
    // fondo propio, como el del panel de relojes
    roundRect(c, x - 10, y - 14, mx + ms - x + 20, SIDE_H + 32, 16)
    c.fillStyle = 'rgba(10,12,16,0.68)'
    c.fill()
    c.strokeStyle = 'rgba(255,255,255,0.1)'
    c.lineWidth = 1
    c.stroke()

    c.font = '600 12px "Barlow Condensed", Barlow, system-ui, sans-serif'
    c.textAlign = 'left'
    const lines: [string, string, string?][] = [
      ['G', d.g.toFixed(2), d.g < 0.4 || d.g > 2.8 ? '#ff6b5a' : undefined],
      ['AGL', `${Math.round(d.agl * 3.281)} ft`],
      ['GS', `${Math.round(d.gsKmh)} km/h`],
      [t('hud.wind'), `${String(Math.round(d.windFrom)).padStart(3, '0')}°/${Math.round(d.windKt)} kt`],
    ]
    let yy = y + 6
    for (const [k, v, col] of lines) {
      c.fillStyle = 'rgba(255,255,255,0.68)'
      c.fillText(k, x, yy)
      c.fillStyle = col ?? '#f4f8ff'
      c.fillText(v, x + 52, yy)
      yy += 16
    }
    // bola de derrape
    const by = y + 72
    roundRect(c, x, by - 9, bw, 18, 9)
    c.fillStyle = 'rgba(255,255,255,0.14)'
    c.fill()
    c.strokeStyle = 'rgba(255,255,255,0.35)'
    c.stroke()
    c.strokeStyle = 'rgba(255,255,255,0.7)'
    c.beginPath()
    c.moveTo(x + bw / 2 - 10, by - 9)
    c.lineTo(x + bw / 2 - 10, by + 9)
    c.moveTo(x + bw / 2 + 10, by - 9)
    c.lineTo(x + bw / 2 + 10, by + 9)
    c.stroke()
    c.fillStyle = '#0c0d10'
    c.beginPath()
    c.arc(x + bw / 2 + Math.max(-1, Math.min(1, d.slip)) * (bw / 2 - 9), by, 7, 0, TAU)
    c.fill()
    c.strokeStyle = '#fff'
    c.lineWidth = 1.5
    c.stroke()
    c.lineWidth = 1
    // indicadores
    yy = y + 97
    const tags: [string, boolean, string][] = [
      [t('hud.prerot'), d.prerot, '#ffcf3a'],
      // frenos en rojo: tienen que saltar a la vista antes de prerrotar o rodar
      [t('hud.rotorBrake'), d.rotorBrake, '#ff6b5a'],
      [t('hud.parkBrake'), d.parkBrake, '#ff6b5a'],
      // luces de aviso del motor (sim/powerplant.ts)
      [t('hud.tagOil'), d.oilLow === true, '#ff6b5a'],
      [t('hud.tagFuel'), d.fuelLow === true, '#ffb23a'],
      [t('hud.tagDrill'), d.drill === true, '#ffb23a'],
      // tren anfibio: azul arriba (agua), verde abajo (tierra), ámbar mientras se mueve
      [t('hud.gearUp'), d.gear === 'up', '#4fc3f7'],
      [t('hud.gearDown'), d.gear === 'down', '#7ee08a'],
      [t('hud.gearMoving'), d.gear === 'moving', '#ffcf3a'],
      [t('hud.mouseStick'), d.mouseStick, '#4fc3f7'],
      [t('hud.wheelThrottle'), d.wheelThrottle, '#4fc3f7'],
    ]
    const active = tags.filter((tg) => tg[1])
    // caben 4 a 14 px antes de la línea de cámara; con más, se aprietan (y letra más pequeña)
    const tight = active.length > 4
    const step = tight ? Math.floor((SIDE_H - 103) / (active.length - 1)) : 14
    c.font = `700 ${tight ? 10 : 11}px "Barlow Condensed", Barlow, system-ui, sans-serif`
    for (const [t, , col] of active) {
      c.fillStyle = col
      c.fillText(`● ${t}`, x, yy)
      yy += step
    }
    c.fillStyle = 'rgba(255,255,255,0.72)'
    c.font = '600 11px "Barlow Condensed", Barlow, system-ui, sans-serif'
    c.fillText(t('hud.camera', { name: d.camName }), x, y + SIDE_H + 6)
    // mini indicador de mandos (palanca arriba, pedales a la altura de la bola)
    const my = y + 4
    c.fillStyle = 'rgba(255,255,255,0.07)'
    c.fillRect(mx, my, ms, ms)
    c.strokeStyle = 'rgba(255,255,255,0.28)'
    c.beginPath()
    c.moveTo(mx + ms / 2, my)
    c.lineTo(mx + ms / 2, my + ms)
    c.moveTo(mx, my + ms / 2)
    c.lineTo(mx + ms, my + ms / 2)
    c.stroke()
    c.strokeStyle = 'rgba(255,255,255,0.55)'
    c.strokeRect(mx, my, ms, ms)
    c.fillStyle = '#ffcf3a'
    c.beginPath()
    c.arc(mx + ms / 2 + (d.stickRoll * ms) / 2, my + ms / 2 + (d.stickPitch * ms) / 2, 4, 0, TAU)
    c.fill()
    c.fillStyle = 'rgba(255,255,255,0.4)'
    c.fillRect(mx, by - 2, ms, 4)
    c.fillStyle = '#4fc3f7'
    c.fillRect(mx + ms / 2 + (d.pedals * ms) / 2 - 2, by - 4, 4, 8)
    c.restore()
  }

  private drawWarnings(c: CanvasRenderingContext2D, d: HudData, W: number): void {
    // precauciones en ámbar, debajo de los avisos rojos (reserva, simulacro, pérdida de potencia)
    const cautions = d.cautions ?? []
    // la pila: avisos de 40 px, precauciones de 34 e indicación (bordes de cada caja: y−20…y+12,
    // y−18…y+10 e y−19…y+11)
    const nw = d.warnings.length
    this.stackBottom = d.hint
      ? 84 + nw * 40 + cautions.length * 34 + 11
      : cautions.length
        ? 84 + nw * 40 + (cautions.length - 1) * 34 + 10
        : nw
          ? 84 + (nw - 1) * 40 + 12
          : 0
    if (cautions.length) {
      c.save()
      c.font = '800 16px "Barlow Condensed", Barlow, system-ui, sans-serif'
      c.textAlign = 'center'
      let y = 84 + d.warnings.length * 40
      for (const w of cautions) {
        const tw = c.measureText(w).width + 32
        roundRect(c, W / 2 - tw / 2, y - 18, tw, 28, 8)
        c.fillStyle = 'rgba(40,28,6,0.78)'
        c.fill()
        c.strokeStyle = '#ffb23a'
        c.lineWidth = 1.5
        c.stroke()
        c.fillStyle = '#ffc861'
        c.fillText(w, W / 2, y + 2)
        y += 34
      }
      c.restore()
    }
    if (d.hint) {
      c.save()
      c.font = '700 16px "Barlow Condensed", Barlow, system-ui, sans-serif'
      c.textAlign = 'center'
      const tw = c.measureText(d.hint).width + 32
      const y = 84 + d.warnings.length * 40 + cautions.length * 34
      roundRect(c, W / 2 - tw / 2, y - 19, tw, 30, 10)
      c.fillStyle = 'rgba(20,24,30,0.72)'
      c.fill()
      c.strokeStyle = 'rgba(246,196,0,0.85)'
      c.lineWidth = 1.5
      c.stroke()
      c.fillStyle = '#f6c400'
      c.fillText(d.hint, W / 2, y + 2)
      c.restore()
    }
    if (!d.warnings.length) return
    c.save()
    c.font = '800 18px "Barlow Condensed", Barlow, system-ui, sans-serif'
    c.textAlign = 'center'
    let y = 84
    const on = this.blink % 0.8 < 0.55
    for (const w of d.warnings) {
      const tw = c.measureText(w).width + 36
      roundRect(c, W / 2 - tw / 2, y - 20, tw, 32, 10)
      c.fillStyle = on ? 'rgba(200,30,20,0.85)' : 'rgba(120,20,15,0.7)'
      c.fill()
      c.fillStyle = '#fff'
      c.fillText(w, W / 2, y + 2)
      y += 40
    }
    c.restore()
  }
}

// (estilo «Pista»: paneles rectos; el radio se ignora)
function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, _r: number): void {
  const r = 0
  c.beginPath()
  c.moveTo(x + r, y)
  c.arcTo(x + w, y, x + w, y + h, r)
  c.arcTo(x + w, y + h, x, y + h, r)
  c.arcTo(x, y + h, x, y, r)
  c.arcTo(x, y, x + w, y, r)
  c.closePath()
}
