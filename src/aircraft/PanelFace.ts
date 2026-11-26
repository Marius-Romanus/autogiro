// Cara del panel de instrumentos con forma (blender/panel.py, nodo `panel_face`): sobre ella se
// pintan rótulos, pilotos LED, combustible, manómetro neumático y las pantallas de radio y
// transpondedor; los interruptores (`sw_<id>`) y la llave (`key`) siguen el estado del aparato y
// los que tienen función (luces, freno del rotor, contacto) se pueden pulsar desde la cabina.
// Los relojes vivos van encima, en la zona `layout.zone` (LivePanel de Cockpit.ts).

import {
  CanvasTexture,
  Color,
  Material,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  type Camera,
} from 'three'
import { onLangChange, t } from '../i18n.ts'

const DEG = Math.PI / 180
const TAU = Math.PI * 2

export interface PanelItem {
  type: 'toggle' | 'key' | 'usb' | 'fuel' | 'mano' | 'com' | 'xpdr'
  id?: string
  u: number
  v: number
  /** color del piloto de un interruptor: g verde, y amarillo, a ámbar */
  led?: string
  d?: number
  w?: number
  h?: number
}

/** Lo que exporta blender/panel.py en extras['layout'] (coordenadas del panel en metros). */
export interface PanelLayout {
  /** origen del panel en coordenadas de Blender (+X morro, +Y izquierda, +Z arriba) */
  p0: [number, number, number]
  /** inclinación hacia delante de la parte alta (grados) */
  tilt: number
  /** semiancho y alturas del contorno (u a la derecha del piloto, v hacia arriba por el panel) */
  A: number
  vmin: number
  vmax: number
  /** zona de los relojes vivos: centro (u, v), ancho y alto */
  zone: [number, number, number, number]
  outline: [number, number][]
  items: PanelItem[]
}

export interface PanelState {
  engineOn: boolean
  lightsOn: boolean
  rotorBrake: boolean
  /** combustible utilizable (0..1; falta: lleno) y aviso de reserva (sim/powerplant.ts) */
  fuel?: number
  fuelLow?: boolean
  /** radio de voz: 1 recibiendo, 2 transmitiendo (anunciador RX/TX de la pantalla COM) */
  radio?: number
}

/** Acciones del simulador que se pueden disparar pulsando el panel. */
export type PanelAction = 'lights' | 'rotorBrake' | 'engine'
const CLICKABLE: Record<string, PanelAction> = {
  sw_light: 'lights',
  sw_strobe: 'lights',
  sw_rbrake: 'rotorBrake',
  key: 'engine',
}

const LED: Record<string, [string, string]> = {
  g: ['#3ddc6a', '#13301c'],
  y: ['#ffd23a', '#33300f'],
  a: ['#ff9a1f', '#3a2410'],
  r: ['#ff3b30', '#3a1210'],
}
/** posición de la llave (grados en sentido horario visto por el piloto): OFF, L, R, BOTH, START */
const KEY_POS = [0, 30, 60, 90, 125]
const TOGGLE_THROW = 22 * DEG

function toggleOn(id: string, s: PanelState): boolean {
  switch (id) {
    case 'pump1':
    case 'pump2':
      return s.engineOn
    case 'light':
    case 'strobe':
      return s.lightsOn
    case 'rbrake':
      return s.rotorBrake
    default:
      return true // master, avionics
  }
}

const _v = new Vector3()
const _w = new Vector3()

export class PanelFace {
  readonly layout: PanelLayout
  /** ejes del panel en coordenadas del modelo (three: +X morro, +Y arriba, +Z derecha) */
  readonly p0 = new Vector3()
  readonly U = new Vector3(0, 0, 1)
  readonly V = new Vector3()
  readonly N = new Vector3()
  private canvas = document.createElement('canvas')
  private em = document.createElement('canvas')
  private tex: CanvasTexture
  private emTex: CanvasTexture
  private mat: MeshStandardMaterial
  private s: number
  private toggles: { id: string; node: Object3D; ang: number }[] = []
  private key: { node: Object3D; ang: number } | null = null
  private keyStart = 0
  private state: PanelState = { engineOn: true, lightsOn: false, rotorBrake: false }
  private drawnKey = ''
  private offLang: () => void

  /** Cara del panel del modelo, o null si el GLB no la trae. */
  static create(model: Object3D): PanelFace | null {
    const face = model.getObjectByName('panel_face')
    const raw = face?.userData?.layout
    if (!face || typeof raw !== 'string') return null
    try {
      return new PanelFace(model, face, JSON.parse(raw) as PanelLayout)
    } catch (err) {
      console.warn('Panel: no se pudo leer la disposición del GLB', err)
      return null
    }
  }

  private constructor(model: Object3D, face: Object3D, layout: PanelLayout) {
    this.layout = layout
    const tl = layout.tilt * DEG
    this.p0.set(layout.p0[0], layout.p0[2], -layout.p0[1])
    this.V.set(Math.sin(tl), Math.cos(tl), 0)
    this.N.set(-Math.cos(tl), Math.sin(tl), 0)
    const w = 2 * layout.A
    const h = layout.vmax - layout.vmin
    this.s = Math.min(2600, 1600 / w, 1600 / h)
    for (const c of [this.canvas, this.em]) {
      c.width = Math.round(w * this.s)
      c.height = Math.round(h * this.s)
    }
    const mk = (c: HTMLCanvasElement) => {
      const tx = new CanvasTexture(c)
      tx.colorSpace = SRGBColorSpace
      tx.flipY = false // UV de glTF: v = 0 arriba
      tx.anisotropy = 8
      return tx
    }
    this.tex = mk(this.canvas)
    this.emTex = mk(this.em)
    this.mat = litMaterial(
      new MeshStandardMaterial({
        map: this.tex,
        emissiveMap: this.emTex,
        emissive: new Color(0xffffff),
        emissiveIntensity: 1.1,
        roughness: 0.5,
        metalness: 0.1,
      }),
    )
    face.traverse((o) => {
      const m = o as Mesh
      if (!m.isMesh) return
      for (const old of Array.isArray(m.material) ? m.material : [m.material]) old.dispose()
      m.material = this.mat
    })
    for (const it of layout.items) {
      if (it.type === 'toggle' && it.id) {
        const node = model.getObjectByName(`sw_${it.id}`)
        if (node) this.toggles.push({ id: it.id, node, ang: TOGGLE_THROW })
      } else if (it.type === 'key') {
        const node = model.getObjectByName('key')
        if (node) this.key = { node, ang: 0 }
      }
    }
    this.offLang = onLangChange(() => (this.drawnKey = ''))
    this.update(1, this.state)
  }

  /** Zona de los relojes vivos para LivePanel (centro en coordenadas del modelo). */
  zoneSpec(): { center: [number, number, number]; width: number; height: number; tilt: number; depth: number; lift: number } {
    const [zu, zv, zw, zh] = this.layout.zone
    const c = _v.copy(this.p0).addScaledVector(this.U, zu).addScaledVector(this.V, zv)
    return { center: [c.x, c.y, c.z], width: zw, height: zh, tilt: this.layout.tilt, depth: 0, lift: 0.004 }
  }

  update(dt: number, s: PanelState): void {
    if (s.engineOn && !this.state.engineOn) this.keyStart = 0.7 // al arrancar, la llave pasa por START
    this.state = { ...s }
    this.keyStart = Math.max(0, this.keyStart - dt)
    const k = Math.min(1, dt * 14)
    for (const tg of this.toggles) {
      // palanca arriba = encendido (giro negativo sobre el eje horizontal del panel)
      const target = toggleOn(tg.id, s) ? -TOGGLE_THROW : TOGGLE_THROW
      tg.ang += (target - tg.ang) * k
      tg.node.quaternion.setFromAxisAngle(this.U, tg.ang)
    }
    if (this.key) {
      const target = (s.engineOn ? (this.keyStart > 0 ? KEY_POS[4] : KEY_POS[3]) : KEY_POS[0]) * DEG
      this.key.ang += (target - this.key.ang) * k
      // horario visto por el piloto (que mira en −N)
      this.key.node.quaternion.setFromAxisAngle(this.N, -this.key.ang)
    }
    // (el combustible, por escalones de los pilotos: repintar la cara entera cuesta)
    const key = `${s.engineOn}|${s.lightsOn}|${s.rotorBrake}|${fuelStep(s)}|${s.radio ?? 0}`
    if (key !== this.drawnKey) {
      this.drawnKey = key
      this.paint()
    }
  }

  /**
   * Mando pulsable bajo el puntero, o null. `ndc`: coordenadas normalizadas (−1..1) del puntero;
   * `px`: tamaño del lienzo en píxeles. El mando se coge en un radio de ~1,8 cm alrededor.
   */
  pick(ndcX: number, ndcY: number, camera: Camera, pxW: number, pxH: number): PanelAction | null {
    let best: PanelAction | null = null
    let bestD = Infinity
    const right = _w.set(1, 0, 0).applyQuaternion(camera.quaternion)
    const nodes: [string, Object3D][] = this.toggles.map((tg) => [`sw_${tg.id}`, tg.node])
    if (this.key) nodes.push(['key', this.key.node])
    for (const [name, node] of nodes) {
      const action = CLICKABLE[name]
      if (!action) continue
      node.getWorldPosition(_v)
      const p = _v.clone()
      const edge = _v.clone().addScaledVector(right, 0.018)
      p.project(camera)
      edge.project(camera)
      if (p.z > 1 || p.z < -1) continue
      const r = Math.max(12, Math.hypot((edge.x - p.x) * pxW * 0.5, (edge.y - p.y) * pxH * 0.5))
      const d = Math.hypot((ndcX - p.x) * pxW * 0.5, (ndcY - p.y) * pxH * 0.5)
      if (d < r && d < bestD) {
        bestD = d
        best = action
      }
    }
    return best
  }

  // -------------------------------------------------------------------------
  // dibujo (solo cuando cambia algo: luces, motor, freno del rotor, idioma)
  // -------------------------------------------------------------------------
  private X(u: number): number {
    return (u + this.layout.A) * this.s
  }
  private Y(v: number): number {
    return (this.layout.vmax - v) * this.s
  }

  private paint(): void {
    const c = this.canvas.getContext('2d')!
    const e = this.em.getContext('2d')!
    const s = this.s
    const L = this.layout
    const W = this.canvas.width
    const H = this.canvas.height
    // fibra de carbono (sarga) en todo el lienzo: fuera del contorno no se ve
    c.fillStyle = '#141518'
    c.fillRect(0, 0, W, H)
    const cell = Math.max(3, Math.round(0.0032 * s))
    for (let y = 0; y < H; y += cell) {
      for (let x = 0; x < W; x += cell) {
        const k = (Math.floor(x / cell) + Math.floor(y / cell) * 2) % 4
        c.fillStyle = k < 2 ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.06)'
        c.fillRect(x, y, cell, cell)
      }
    }
    const lg = c.createLinearGradient(0, 0, 0, H)
    lg.addColorStop(0, 'rgba(255,255,255,0.05)')
    lg.addColorStop(1, 'rgba(0,0,0,0.22)')
    c.fillStyle = lg
    c.fillRect(0, 0, W, H)
    e.fillStyle = '#000'
    e.fillRect(0, 0, W, H)
    // borde: luz por dentro del canto
    c.save()
    c.beginPath()
    L.outline.forEach(([u, v], i) => (i ? c.lineTo(this.X(u), this.Y(v)) : c.moveTo(this.X(u), this.Y(v))))
    c.closePath()
    c.clip()
    c.strokeStyle = 'rgba(255,255,255,0.10)'
    c.lineWidth = 0.004 * s
    c.stroke()
    c.restore()
    // tornillos repartidos por el contorno, 1,1 cm hacia dentro
    this.screwsAlongOutline(c)
    // rebaje de la zona de relojes
    const [zu, zv, zw, zh] = L.zone
    c.fillStyle = 'rgba(0,0,0,0.25)'
    roundRect(c, this.X(zu - zw / 2) - 0.004 * s, this.Y(zv + zh / 2) - 0.004 * s, (zw + 0.008) * s, (zh + 0.008) * s, 0.006 * s)
    c.fill()

    // filas de interruptores: marco fino con su piloto y rótulo
    const rows = new Map<number, PanelItem[]>()
    for (const it of L.items) {
      if (it.type !== 'toggle') continue
      const key = Math.round(it.v * 1000)
      rows.set(key, [...(rows.get(key) ?? []), it])
    }
    for (const row of rows.values()) {
      const u0 = Math.min(...row.map((r) => r.u)) - 0.0145
      const u1 = Math.max(...row.map((r) => r.u)) + 0.0145
      const v = row[0].v
      c.strokeStyle = 'rgba(235,235,235,0.28)'
      c.lineWidth = Math.max(1, 0.0006 * s)
      roundRect(c, this.X(u0), this.Y(v + 0.024), (u1 - u0) * s, 0.048 * s, 0.003 * s)
      c.stroke()
    }
    for (const it of L.items) {
      switch (it.type) {
        case 'toggle':
          this.led(c, e, it.u, it.v + 0.0155, it.led ?? 'g', toggleOn(it.id ?? '', this.state))
          this.label(c, t(`ck.sw.${it.id}`), it.u, it.v - 0.0175, 0.0036)
          break
        case 'key':
          this.keyLabels(c, it)
          break
        case 'usb':
          this.label(c, 'USB', it.u, it.v - 0.0165, 0.0036)
          break
        case 'fuel':
          this.fuel(c, e, it)
          break
        case 'mano':
          this.manometer(c, it)
          break
        case 'com':
        case 'xpdr':
          this.display(c, e, it)
          break
      }
    }
    this.tex.needsUpdate = true
    this.emTex.needsUpdate = true
  }

  private label(c: CanvasRenderingContext2D, text: string, u: number, v: number, size: number, align: CanvasTextAlign = 'center'): void {
    c.fillStyle = 'rgba(238,238,238,0.85)'
    c.font = `700 ${Math.round(size * this.s)}px Inter, system-ui, sans-serif`
    c.textAlign = align
    c.textBaseline = 'middle'
    c.fillText(text, this.X(u), this.Y(v))
  }

  private led(c: CanvasRenderingContext2D, e: CanvasRenderingContext2D, u: number, v: number, col: string, on: boolean): void {
    const [lit, dark] = LED[col] ?? LED.g
    const x = this.X(u)
    const y = this.Y(v)
    const r = 0.0027 * this.s
    c.fillStyle = '#9aa0a6'
    c.beginPath()
    c.arc(x, y, r * 1.35, 0, TAU)
    c.fill()
    c.fillStyle = on ? lit : dark
    c.beginPath()
    c.arc(x, y, r, 0, TAU)
    c.fill()
    if (on) {
      const g = e.createRadialGradient(x, y, 0, x, y, r * 1.25)
      g.addColorStop(0, lit)
      g.addColorStop(1, 'rgba(0,0,0,0)')
      e.fillStyle = g
      e.beginPath()
      e.arc(x, y, r * 1.25, 0, TAU)
      e.fill()
      // reflejo blanco en el centro
      c.fillStyle = 'rgba(255,255,255,0.55)'
      c.beginPath()
      c.arc(x - r * 0.3, y - r * 0.3, r * 0.3, 0, TAU)
      c.fill()
    }
  }

  private keyLabels(c: CanvasRenderingContext2D, it: PanelItem): void {
    const names = ['OFF', 'L', 'R', t('ck.keyBoth'), t('ck.keyStart')]
    const r = 0.0215
    c.strokeStyle = 'rgba(238,238,238,0.6)'
    c.lineWidth = Math.max(1, 0.0006 * this.s)
    KEY_POS.forEach((a, i) => {
      const sa = Math.sin(a * DEG)
      const ca = Math.cos(a * DEG)
      // marca y nombre, horario desde arriba
      c.beginPath()
      c.moveTo(this.X(it.u + sa * 0.0155), this.Y(it.v + ca * 0.0155))
      c.lineTo(this.X(it.u + sa * 0.0185), this.Y(it.v + ca * 0.0185))
      c.stroke()
      const align: CanvasTextAlign = sa > 0.3 ? 'left' : sa < -0.3 ? 'right' : 'center'
      this.label(c, names[i], it.u + sa * r, it.v + ca * r, i === 4 ? 0.0028 : 0.0031, align)
    })
  }

  private fuel(c: CanvasRenderingContext2D, e: CanvasRenderingContext2D, it: PanelItem): void {
    // pilotos del nivel: se encienden según lo que queda; RES, con la reserva
    const f = this.state.fuel ?? 1
    const marks: [string, string, boolean][] = [
      ['>75', 'g', f > 0.75],
      ['>50', 'g', f > 0.5],
      ['>25', 'g', f > 0.25],
      ['RES', 'r', this.state.fuelLow === true],
    ]
    marks.forEach(([txt, col, on], i) => {
      const v = it.v + 0.0165 - i * 0.011
      this.led(c, e, it.u - 0.006, v, col, on)
      this.label(c, txt, it.u + 0.0005, v, 0.0031, 'left')
    })
    c.save()
    c.translate(this.X(it.u - 0.0145), this.Y(it.v))
    c.rotate(-Math.PI / 2)
    c.fillStyle = 'rgba(238,238,238,0.85)'
    c.font = `700 ${Math.round(0.0032 * this.s)}px Inter, system-ui, sans-serif`
    c.textAlign = 'center'
    c.textBaseline = 'middle'
    c.fillText(t('ck.fuel'), 0, 0)
    c.restore()
  }

  private manometer(c: CanvasRenderingContext2D, it: PanelItem): void {
    const s = this.s
    const x = this.X(it.u)
    const y = this.Y(it.v)
    const r = ((it.d ?? 0.04) / 2) * 0.86 * s
    c.fillStyle = '#0d0e10'
    c.beginPath()
    c.arc(x, y, r, 0, TAU)
    c.fill()
    // 0..10 bar en 270°, verde 7..9
    const ang = (b: number) => (-225 + 27 * b) * DEG
    c.strokeStyle = '#2fbf5a'
    c.lineWidth = r * 0.12
    c.beginPath()
    c.arc(x, y, r * 0.78, ang(7), ang(9))
    c.stroke()
    c.strokeStyle = '#e8e8e8'
    for (let b = 0; b <= 10; b++) {
      const a = ang(b)
      const l = b % 5 === 0 ? 0.22 : 0.12
      c.lineWidth = Math.max(1, r * (b % 5 === 0 ? 0.06 : 0.035))
      c.beginPath()
      c.moveTo(x + Math.cos(a) * r * 0.92, y + Math.sin(a) * r * 0.92)
      c.lineTo(x + Math.cos(a) * r * (0.92 - l), y + Math.sin(a) * r * (0.92 - l))
      c.stroke()
    }
    c.fillStyle = '#e8e8e8'
    c.font = `700 ${Math.round(r * 0.28)}px Inter, system-ui, sans-serif`
    c.textAlign = 'center'
    c.textBaseline = 'middle'
    c.fillText('bar', x, y + r * 0.45)
    c.font = `600 ${Math.round(r * 0.2)}px Inter, system-ui, sans-serif`
    c.fillText(t('ck.pneu'), x, y - r * 0.38)
    // aguja: presión de la neumática (algo menos con el freno del rotor apretado)
    const a = ang(this.state.rotorBrake ? 7.2 : 8.1)
    c.strokeStyle = '#ff7a1a'
    c.lineWidth = r * 0.07
    c.beginPath()
    c.moveTo(x - Math.cos(a) * r * 0.15, y - Math.sin(a) * r * 0.15)
    c.lineTo(x + Math.cos(a) * r * 0.8, y + Math.sin(a) * r * 0.8)
    c.stroke()
    c.fillStyle = '#222'
    c.beginPath()
    c.arc(x, y, r * 0.1, 0, TAU)
    c.fill()
  }

  private display(c: CanvasRenderingContext2D, e: CanvasRenderingContext2D, it: PanelItem): void {
    const s = this.s
    const w = (it.w ?? 0.1) * s
    const h = (it.h ?? 0.03) * s
    const x = this.X(it.u) - w / 2
    const y = this.Y(it.v) - h / 2
    c.fillStyle = '#0a0f0b'
    c.fillRect(x, y, w, h)
    e.fillStyle = 'rgba(20,50,28,0.35)'
    e.fillRect(x, y, w, h)
    const green = '#8dffa8'
    const on = this.state.engineOn
    // texto completo y, si no cabe a buen tamaño, el compacto
    const lines: [string, string, number, number][] =
      it.type === 'com'
        ? [
            ['COM  122.505', 'COM 122.505', 0.36, 0.34],
            ['SB  123.500', 'SB 123.500', 0.72, 0.24],
          ]
        : [
            ['XPDR  7000', 'XPDR 7000', 0.4, 0.34],
            ['ALT', 'ALT', 0.74, 0.24],
          ]
    if (!on) return
    // Ancho útil: los dos mandos del marco (blender/panel.py: radio 6,2 mm, a 9 mm de cada extremo
    // y 0,18·h por debajo del centro) tapan los extremos de la mitad de abajo; la línea de arriba
    // tiene casi todo el ancho. En los paneles estrechos (ELA 07, Scorpion: 58 mm) el texto a su
    // tamaño pasaba de la pantalla: se encoge lo justo para caber.
    const availTop = w - 2 * 0.0025 * s
    const availLow = Math.max(w * 0.4, w - 2 * 0.0165 * s)
    let avail = availTop
    const MONO = '"DejaVu Sans Mono", Consolas, monospace'
    /** pone la fuente para que `full` (o `compact`) quepa en `avail`: texto y tamaño (px) */
    const fit = (ctx: CanvasRenderingContext2D, full: string, compact: string, px: number, weight: number): [string, number] => {
      ctx.font = `${weight} ${px}px ${MONO}`
      let txt = full
      let m = ctx.measureText(txt).width
      if (m > avail && compact !== full) {
        const mc = ctx.measureText(compact).width
        // (el compacto si el completo tendría que encogerse mucho)
        if (avail / m < 0.8) {
          txt = compact
          m = mc
        }
      }
      if (m > avail) {
        px = Math.max(4, Math.floor((px * avail) / m))
        ctx.font = `${weight} ${px}px ${MONO}`
      }
      return [txt, px]
    }
    // radio de voz (multijugador): en la línea de reserva, TX en negativo al transmitir y RX al recibir
    const radio = it.type === 'com' ? (this.state.radio ?? 0) : 0
    if (radio) lines.pop()
    for (const ctx of [c, e]) {
      ctx.fillStyle = green
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      for (const [full, compact, fy, fs] of lines) {
        avail = fy < 0.5 ? availTop : availLow
        const [txt] = fit(ctx, full, compact, Math.round(h * fs), 600)
        ctx.fillText(txt, x + w / 2, y + h * fy)
      }
      if (radio) {
        const label = radio === 2 ? 'TX' : 'RX'
        avail = availLow
        const [, fs] = fit(ctx, label, label, Math.round(h * 0.26), 700)
        const bw = Math.min(fs * 1.9, avail)
        const cy = y + h * 0.72
        if (radio === 2) {
          ctx.fillRect(x + w / 2 - bw / 2, cy - fs * 0.62, bw, fs * 1.24)
          ctx.fillStyle = '#0a0f0b'
        }
        ctx.fillText(label, x + w / 2, cy + fs * 0.04)
      }
    }
  }

  private screwsAlongOutline(c: CanvasRenderingContext2D): void {
    const pts = this.layout.outline
    const s = this.s
    // centro aproximado para meter los tornillos hacia dentro
    let cu = 0
    let cv = 0
    for (const [u, v] of pts) {
      cu += u
      cv += v
    }
    cu /= pts.length
    cv /= pts.length
    let acc = 0
    const step = 0.085
    for (let i = 0; i < pts.length; i++) {
      const [u0, v0] = pts[i]
      const [u1, v1] = pts[(i + 1) % pts.length]
      const seg = Math.hypot(u1 - u0, v1 - v0)
      acc += seg
      if (acc < step) continue
      acc = 0
      // hacia dentro: perpendicular al borde, del lado del centro
      let nu = -(v1 - v0) / (seg || 1)
      let nv = (u1 - u0) / (seg || 1)
      if ((cu - u1) * nu + (cv - v1) * nv < 0) {
        nu = -nu
        nv = -nv
      }
      const x = this.X(u1 + nu * 0.009)
      const y = this.Y(v1 + nv * 0.009)
      const r = 0.0019 * s
      const rg = c.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r)
      rg.addColorStop(0, '#a9aeb4')
      rg.addColorStop(1, '#3a3d42')
      c.fillStyle = rg
      c.beginPath()
      c.arc(x, y, r, 0, TAU)
      c.fill()
      c.strokeStyle = 'rgba(0,0,0,0.6)'
      c.lineWidth = r * 0.35
      c.beginPath()
      c.moveTo(x - r * 0.6, y - r * 0.6)
      c.lineTo(x + r * 0.6, y + r * 0.6)
      c.stroke()
    }
  }

  dispose(): void {
    this.offLang()
    this.tex.dispose()
    this.emTex.dispose()
    this.mat.dispose()
  }
}

/** Escalón de los pilotos del combustible (0-3) y la reserva: solo se repinta al cambiar. */
function fuelStep(s: PanelState): string {
  const f = s.fuel ?? 1
  return `${f > 0.75 ? 3 : f > 0.5 ? 2 : f > 0.25 ? 1 : 0}${s.fuelLow ? 'R' : ''}`
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath()
  c.moveTo(x + r, y)
  c.arcTo(x + w, y, x + w, y + h, r)
  c.arcTo(x + w, y + h, x, y + h, r)
  c.arcTo(x, y + h, x, y, r)
  c.arcTo(x, y, x + w, y, r)
  c.closePath()
}

/** Material iluminado por la escena: escribe alfa 0 (máscara de iluminación, ver Graphics.ts). */
function litMaterial<T extends Material>(mat: T): T {
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <dithering_fragment>',
      '#include <dithering_fragment>\n\tgl_FragColor.a = 0.0;',
    )
  }
  mat.customProgramCacheKey = () => 'lit-alpha0'
  return mat
}
