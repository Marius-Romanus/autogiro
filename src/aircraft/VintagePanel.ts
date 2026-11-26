// Tablero de época de los autogiros antiguos (Cierva C.30A de 1934, Wilford XOZ-1 de 1936): relojes vivos
// con el aspecto de los de entonces, sobre el tablero de madera del modelo. Esfera negra, números y agujas
// con pintura luminosa de radio (de noche brillan un poco), agujas de espada, bisel negro con cuatro
// tornillos y nada que no hubiera: sin arcos de colores (llegaron después de la guerra) ni lecturas
// digitales. Instrumentos: anemómetro, altímetro de dos agujas, cuentavueltas del rotor y del motor,
// presión y temperatura del aceite, nivel transversal con su bola y, en el C.30A, la brújula de líquido,
// con la rosa que oscila al virar.
//
// La disposición viene del GLB: nodos `vintage_board*` con extras.board (blender/build_ela.py,
// `panel(live=...)`): centro de la cara en coordenadas de Blender, inclinación, tamaño y huecos
// (u a la derecha del piloto, v hacia arriba, diámetro). Todos los relojes comparten un lienzo (atlas) y
// cada tablero se dibuja con tres mallas (esferas, biseles y tornillos).

import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  Material,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  RingGeometry,
  SRGBColorSpace,
  Vector3,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { LIGHT_LAYER } from '../render/Graphics.ts'
import { addStrings, onLangChange, t } from '../i18n.ts'
import type { HudData } from '../hud/Hud.ts'
import type { TachSpec } from '../sim/engines.ts'

addStrings('es', {
  'ck.v.asi': 'VELOCIDAD',
  'ck.v.alt': 'ALTITUD',
  'ck.v.feet': 'PIES',
  'ck.v.rotor': 'ROTOR',
  'ck.v.engine': 'MOTOR',
  'ck.v.oilp': 'PRES. ACEITE',
  'ck.v.oilt': 'TEMP. ACEITE',
})
addStrings('en', {
  'ck.v.asi': 'AIR SPEED',
  'ck.v.alt': 'ALTITUDE',
  'ck.v.feet': 'FEET',
  'ck.v.rotor': 'ROTOR',
  'ck.v.engine': 'ENGINE',
  'ck.v.oilp': 'OIL PRESS.',
  'ck.v.oilt': 'OIL TEMP.',
})

type Kind = 'asi' | 'alt' | 'rotor' | 'engine' | 'oilp' | 'oilt' | 'compass' | 'level'
interface Slot {
  k: Kind
  u: number
  v: number
  d?: number
  w?: number
  h?: number
}
interface Board {
  /** centro de la cara del tablero (coordenadas de Blender) */
  c: [number, number, number]
  tilt: number
  w: number
  h: number
  slots: Slot[]
}
interface Cell {
  slot: Slot
  /** esquina de su celda en el atlas (px) y alto útil (el nivel ocupa una franja) */
  x: number
  y: number
  hpx: number
  /** capa fija (esfera, marcas, números; en la brújula, la rosa entera) */
  bg: HTMLCanvasElement
}

const DEG = Math.PI / 180
const TAU = Math.PI * 2
/** lado de una celda del atlas (px): una esfera de 7 cm a 60 cm del ojo ocupa ~90 px en 1080p */
const CELL = 200
const COLS = 4
/** pintura luminosa (radio) envejecida y esfera negra */
const LUME = '#ece4c6'
const LUME_DIM = 'rgba(236,228,198,0.78)'
const FONT = '"Barlow Condensed", Barlow, system-ui, sans-serif'
/** un reloj de 7 cm: el bisel tapa el 7 % del borde de la esfera */
const LIP_IN = 0.93
const LIP_OUT = 0.0042
const ROTAX_TACH: TachSpec = { max: 7000, step: 1000, minor: 500, green: [1400, 5500], yellow: [5500, 5800], red: 5800 }

const _m = new Matrix4()

export class VintagePanel {
  readonly group = new Group()
  private canvas = document.createElement('canvas')
  private ctx: CanvasRenderingContext2D
  private tex: CanvasTexture
  private cells: Cell[] = []
  private disposables: { dispose(): void }[] = []
  private offLang: () => void
  private drawnKey = ''
  private acc = 1
  private last = 0
  // estado de los instrumentos (con su inercia)
  private ias = 0
  private alt = 0
  private rotor = 0
  private engine = 0
  private oilP = 0
  private oilT = -1
  private card = 0
  private cardVel = 0
  private ball = 0
  private tach: TachSpec = ROTAX_TACH
  private rotorMax = 600
  private scaleKey = ''

  /** Tablero de época del modelo, o null si el GLB no lo trae. */
  static create(model: Object3D): VintagePanel | null {
    const boards: Board[] = []
    model.traverse((o) => {
      const raw = o.userData?.board
      if (!/^vintage_board/.test(o.name) || typeof raw !== 'string') return
      try {
        boards.push(JSON.parse(raw) as Board)
      } catch (err) {
        console.warn('Tablero de época: no se pudo leer la disposición del GLB', err)
      }
    })
    return boards.length ? new VintagePanel(boards) : null
  }

  private constructor(boards: Board[]) {
    this.group.name = 'vintage_panel'
    const n = boards.reduce((a, b) => a + b.slots.length, 0)
    const rows = Math.ceil(n / COLS)
    this.canvas.width = COLS * CELL
    this.canvas.height = rows * CELL
    this.ctx = this.canvas.getContext('2d')!
    this.tex = new CanvasTexture(this.canvas)
    this.tex.colorSpace = SRGBColorSpace
    this.tex.anisotropy = 8
    this.disposables.push(this.tex)

    const dialMat = lit(
      new MeshStandardMaterial({
        map: this.tex,
        // la pintura de radio brilla un poco (verdosa) también de noche; la esfera negra, no
        emissiveMap: this.tex,
        emissive: new Color(0.5, 0.58, 0.36),
        emissiveIntensity: 0.28,
        roughness: 0.55,
        metalness: 0,
      }),
    )
    const bezelMat = lit(new MeshStandardMaterial({ color: new Color('#1b1a19'), roughness: 0.3, metalness: 0.65, side: DoubleSide }))
    const screwMat = lit(new MeshStandardMaterial({ color: new Color('#c4bfb2'), roughness: 0.3, metalness: 0.9 }))
    this.disposables.push(dialMat, bezelMat, screwMat)

    let i = 0
    for (const b of boards) {
      const dials: BufferGeometry[] = []
      const bezels: BufferGeometry[] = []
      const screws: BufferGeometry[] = []
      for (const slot of b.slots) {
        const x = (i % COLS) * CELL
        const y = Math.floor(i / COLS) * CELL
        i++
        const isLevel = slot.k === 'level'
        const w = slot.w ?? 0.09
        const h = slot.h ?? 0.02
        const hpx = isLevel ? Math.round((CELL * h) / w) : CELL
        const bg = document.createElement('canvas')
        bg.width = CELL
        bg.height = hpx
        this.cells.push({ slot, x, y, hpx, bg })
        const uvTo = (g: BufferGeometry) => {
          // UV de la malla (0..1, v hacia arriba) → su celda del atlas (lienzo con flipY)
          const uv = g.attributes.uv
          for (let k = 0; k < uv.count; k++) {
            const a = uv.getX(k)
            const bb = uv.getY(k)
            uv.setXY(k, (x + a * CELL) / this.canvas.width, 1 - (y + (1 - bb) * hpx) / this.canvas.height)
          }
          return g
        }
        if (isLevel) {
          dials.push(uvTo(new PlaneGeometry(w, h)).translate(slot.u, slot.v, 0.0012))
          // marco: cuatro listones
          const fr = 0.004
          for (const [du, dv, bw, bh] of [
            [0, h / 2 + fr / 2, w + 2 * fr, fr],
            [0, -h / 2 - fr / 2, w + 2 * fr, fr],
            [-w / 2 - fr / 2, 0, fr, h],
            [w / 2 + fr / 2, 0, fr, h],
          ] as [number, number, number, number][]) {
            bezels.push(new BoxGeometry(bw, bh, 0.006).translate(slot.u + du, slot.v + dv, 0.003))
          }
          for (const su of [-1, 1]) screws.push(screw(slot.u + su * (w / 2 + fr + 0.004), slot.v))
          continue
        }
        const r = (slot.d ?? 0.07) / 2
        // el cuenco de la brújula sobresale más
        const depth = slot.k === 'compass' ? 0.012 : 0.0065
        dials.push(uvTo(new CircleGeometry(r, 48)).translate(slot.u, slot.v, 0.0012))
        bezels.push(new RingGeometry(r * LIP_IN, r + LIP_OUT, 48).translate(slot.u, slot.v, depth))
        bezels.push(new CylinderGeometry(r * 0.97, r * 0.97, depth, 40, 1, true).rotateX(Math.PI / 2).translate(slot.u, slot.v, depth / 2))
        bezels.push(new CylinderGeometry(r + LIP_OUT, r + LIP_OUT + 0.0006, depth, 40, 1, true).rotateX(Math.PI / 2).translate(slot.u, slot.v, depth / 2))
        // cuatro tornillos de la brida, en diagonal
        const sr = r + LIP_OUT + 0.0045
        for (const a of [45, 135, 225, 315]) screws.push(screw(slot.u + Math.cos(a * DEG) * sr, slot.v + Math.sin(a * DEG) * sr))
      }
      // grupo del tablero: X a la derecha del piloto, Y hacia arriba por el tablero, Z hacia el piloto
      const tl = b.tilt * DEG
      const g = new Group()
      _m.makeBasis(new Vector3(0, 0, 1), new Vector3(Math.sin(tl), Math.cos(tl), 0), new Vector3(-Math.cos(tl), Math.sin(tl), 0))
      g.quaternion.setFromRotationMatrix(_m)
      g.position.set(b.c[0], b.c[2], -b.c[1])
      for (const [list, mat, shadow] of [
        [dials, dialMat, false],
        [bezels, bezelMat, true],
        [screws, screwMat, false],
      ] as [BufferGeometry[], Material, boolean][]) {
        if (!list.length) continue
        const geo = mergeGeometries(list)
        for (const x of list) x.dispose()
        if (!geo) continue
        this.disposables.push(geo)
        const m = new Mesh(geo, mat)
        m.layers.set(LIGHT_LAYER)
        m.castShadow = shadow
        m.receiveShadow = true
        g.add(m)
      }
      this.group.add(g)
    }
    this.paintStatic()
    this.offLang = onLangChange(() => this.paintStatic())
    // la letra condensada puede llegar después de la primera pintura
    document.fonts?.ready.then(() => this.paintStatic()).catch(() => {})
  }

  update(dt: number, d: HudData): void {
    // inercias con el tiempo real (si la cámara se alejó un rato, el aceite siguió enfriándose)
    const now = performance.now() / 1000
    const el = this.last ? Math.min(600, now - this.last) : 0
    this.last = now
    const h = Math.min(0.1, dt)
    const tach = d.tach ?? ROTAX_TACH
    const rotorMax = Math.ceil((600 * (d.rpmScale ?? 1)) / 100) * 100
    const scaleKey = `${tach.max}|${tach.step}|${tach.minor}|${rotorMax}`
    if (scaleKey !== this.scaleKey) {
      this.scaleKey = scaleKey
      this.tach = tach
      this.rotorMax = rotorMax
      this.paintStatic()
    }
    const k = (rate: number) => Math.min(1, h * rate)
    this.ias += (Math.max(0, d.iasKmh) - this.ias) * k(6)
    this.alt += (d.altFt - this.alt) * k(3)
    this.rotor += (d.rotorRpm - this.rotor) * k(8)
    this.engine += (d.engineRpm - this.engine) * k(6)
    // aceite: presión con las vueltas (más en frío), temperatura que sube despacio con el motor en marcha
    const rated = tach.red || tach.max
    const run = d.engineOn && d.engineRpm > 150
    const load = Math.max(0, Math.min(1, d.engineRpm / rated))
    if (this.oilT < 0) this.oilT = run ? 55 + 20 * load : 15
    const tT = run ? 55 + 25 * load : 15
    this.oilT += (tT - this.oilT) * (1 - Math.exp(-el / (run ? 150 : 600)))
    const pT = !run ? 0 : d.oilLow ? 8 : 32 + 40 * Math.sqrt(load) + Math.max(0, 50 - this.oilT) * 0.35
    this.oilP += (pT - this.oilP) * (1 - Math.exp(-el / 0.7))
    // brújula de líquido: la rosa sigue al rumbo con un muelle poco amortiguado (oscila al salir del viraje)
    let err = (d.heading - this.card) % 360
    if (err > 180) err -= 360
    if (err < -180) err += 360
    const w0 = 2.6
    this.cardVel += (w0 * w0 * err - 2 * 0.35 * w0 * this.cardVel) * h
    this.card = (this.card + this.cardVel * h + 360) % 360
    // bola del nivel transversal (algo de líquido: frena)
    this.ball += (Math.max(-1, Math.min(1, d.slip)) - this.ball) * k(5)

    this.acc += dt
    if (this.acc < 1 / 20) return
    this.acc = 0
    const key = [this.ias * 2, this.alt / 4, this.rotor, this.engine / 5, this.oilP, this.oilT * 2, this.card * 3, this.ball * 150]
      .map((x) => Math.round(x))
      .join('|')
    if (key === this.drawnKey) return
    this.drawnKey = key
    this.paint()
  }

  // ---------------------------------------------------------------------------
  // dibujo
  // ---------------------------------------------------------------------------
  private paint(): void {
    const c = this.ctx
    c.setTransform(1, 0, 0, 1, 0, 0)
    for (const cell of this.cells) {
      c.save()
      c.translate(cell.x, cell.y)
      c.beginPath()
      c.rect(0, 0, CELL, cell.hpx)
      c.clip()
      const R = CELL / 2
      switch (cell.slot.k) {
        case 'asi':
          c.drawImage(cell.bg, 0, 0)
          needle(c, R, R, R, asiAngle(this.ias))
          break
        case 'alt': {
          c.drawImage(cell.bg, 0, 0)
          const a = Math.max(0, this.alt)
          needle(c, R, R, R, -Math.PI / 2 + (a / 10000) * TAU, 0.5, 0.085)
          needle(c, R, R, R, -Math.PI / 2 + ((a % 1000) / 1000) * TAU, 0.84, 0.05)
          break
        }
        case 'rotor':
          c.drawImage(cell.bg, 0, 0)
          needle(c, R, R, R, sweep(this.rotor, 0, this.rotorMax, TACH_A0, TACH_A1))
          break
        case 'engine':
          c.drawImage(cell.bg, 0, 0)
          needle(c, R, R, R, sweep(this.engine, 0, this.tach.max, TACH_A0, TACH_A1))
          break
        case 'oilp':
          c.drawImage(cell.bg, 0, 0)
          needle(c, R, R, R, sweep(this.oilP, 0, 100, SMALL_A0, SMALL_A1), 0.78, 0.07)
          break
        case 'oilt':
          c.drawImage(cell.bg, 0, 0)
          needle(c, R, R, R, sweep(this.oilT, 0, 100, SMALL_A0, SMALL_A1), 0.78, 0.07)
          break
        case 'compass':
          this.compass(c, cell, R)
          break
        case 'level':
          this.level(c, cell)
          break
      }
      if (cell.slot.k !== 'level') glass(c, R)
      c.restore()
    }
    this.tex.needsUpdate = true
  }

  /** Capas fijas de cada reloj (al empezar, al cambiar de idioma o de motor y cuando llega la letra). */
  private paintStatic(): void {
    for (const cell of this.cells) {
      const g = cell.bg.getContext('2d')!
      g.setTransform(1, 0, 0, 1, 0, 0)
      g.clearRect(0, 0, cell.bg.width, cell.bg.height)
      const R = CELL / 2
      switch (cell.slot.k) {
        case 'asi':
          face(g, R)
          ticks(g, R, 0, 200, ASI_A0, ASI_A1, 20, 10, (v) => (v === 0 ? '' : `${v}`), 0.15)
          labels(g, R, t('ck.v.asi'), 'KM/H')
          break
        case 'alt':
          face(g, R)
          ticks(g, R, 0, 10, -Math.PI / 2, (3 * Math.PI) / 2, 1, 0.2, (v) => (v === 10 ? '' : `${v}`), 0.19)
          labels(g, R, t('ck.v.alt'), t('ck.v.feet'))
          break
        case 'rotor':
          face(g, R)
          ticks(g, R, 0, this.rotorMax, TACH_A0, TACH_A1, 100, 20, (v) => `${v / 100}`, 0.19)
          labels(g, R, t('ck.v.rotor'), 'R.P.M. ×100')
          break
        case 'engine': {
          face(g, R)
          const tc = this.tach
          const div = tc.max <= 3000 ? 100 : 1000
          ticks(g, R, 0, tc.max, TACH_A0, TACH_A1, tc.step, tc.minor, (v) => `${v / div}`, 0.17)
          labels(g, R, t('ck.v.engine'), div === 100 ? 'R.P.M. ×100' : 'R.P.M. ×1000')
          break
        }
        case 'oilp':
          face(g, R)
          ticks(g, R, 0, 100, SMALL_A0, SMALL_A1, 20, 10, (v) => `${v}`, 0.18)
          labels(g, R, t('ck.v.oilp'), 'LB/IN²', 0.15)
          break
        case 'oilt':
          face(g, R)
          ticks(g, R, 0, 100, SMALL_A0, SMALL_A1, 20, 10, (v) => `${v}`, 0.18)
          labels(g, R, t('ck.v.oilt'), '°C', 0.15)
          break
        case 'compass':
          compassCard(g, R)
          break
        case 'level':
          break
      }
    }
    this.drawnKey = ''
    this.paint()
  }

  private compass(c: CanvasRenderingContext2D, cell: Cell, R: number): void {
    // fondo del cuenco (líquido) y la rosa girada: el rumbo queda bajo la línea de fe, arriba
    const bowl = c.createRadialGradient(R, R * 0.8, R * 0.1, R, R, R)
    bowl.addColorStop(0, '#24211b')
    bowl.addColorStop(1, '#0a0908')
    c.fillStyle = bowl
    c.fillRect(0, 0, CELL, CELL)
    c.save()
    c.translate(R, R)
    c.rotate(-this.card * DEG)
    c.drawImage(cell.bg, -R, -R)
    c.restore()
    // tinte ámbar del alcohol y menisco
    c.fillStyle = 'rgba(150,118,50,0.10)'
    c.beginPath()
    c.arc(R, R, R, 0, TAU)
    c.fill()
    // línea de fe (fija) y la cruz del soporte
    c.strokeStyle = LUME
    c.lineWidth = R * 0.035
    c.beginPath()
    c.moveTo(R, R * 0.06)
    c.lineTo(R, R * 0.34)
    c.stroke()
    c.strokeStyle = 'rgba(20,18,16,0.85)'
    c.lineWidth = R * 0.02
    c.beginPath()
    c.moveTo(R * 0.55, R)
    c.lineTo(R * 1.45, R)
    c.moveTo(R, R * 0.55)
    c.lineTo(R, R * 1.45)
    c.stroke()
    c.fillStyle = '#2a2724'
    c.beginPath()
    c.arc(R, R, R * 0.07, 0, TAU)
    c.fill()
  }

  private level(c: CanvasRenderingContext2D, cell: Cell): void {
    const W = CELL
    const H = cell.hpx
    c.fillStyle = '#0c0b0a'
    c.fillRect(0, 0, W, H)
    // tubo de vidrio curvado (los extremos más altos: la bola descansa en medio)
    const half = W * 0.44
    const sag = H * 0.16
    const y0 = H * 0.42
    const yAt = (x: number) => y0 + sag * (1 - ((x - W / 2) / half) ** 2)
    c.lineCap = 'round'
    c.strokeStyle = 'rgba(214,210,170,0.9)'
    c.lineWidth = H * 0.5
    c.beginPath()
    for (let k = 0; k <= 24; k++) {
      const x = W / 2 - half + (2 * half * k) / 24
      if (k) c.lineTo(x, yAt(x))
      else c.moveTo(x, yAt(x))
    }
    c.stroke()
    // marcas del centro
    const br = H * 0.2
    c.strokeStyle = '#141210'
    c.lineWidth = Math.max(1, H * 0.06)
    c.beginPath()
    for (const s of [-1, 1]) {
      const x = W / 2 + s * br * 1.25
      c.moveTo(x, yAt(x) - H * 0.27)
      c.lineTo(x, yAt(x) + H * 0.27)
    }
    c.stroke()
    // bola
    const bx = W / 2 + this.ball * (half - br * 1.2)
    const by = yAt(bx)
    const g = c.createRadialGradient(bx - br * 0.35, by - br * 0.35, br * 0.1, bx, by, br)
    g.addColorStop(0, '#5a5650')
    g.addColorStop(1, '#0e0d0c')
    c.fillStyle = g
    c.beginPath()
    c.arc(bx, by, br, 0, TAU)
    c.fill()
    // brillo del vidrio
    c.strokeStyle = 'rgba(255,255,255,0.35)'
    c.lineWidth = H * 0.06
    c.beginPath()
    for (let k = 2; k <= 22; k++) {
      const x = W / 2 - half + (2 * half * k) / 24
      if (k > 2) c.lineTo(x, yAt(x) - H * 0.16)
      else c.moveTo(x, yAt(x) - H * 0.16)
    }
    c.stroke()
  }

  dispose(): void {
    this.offLang()
    this.group.removeFromParent()
    for (const d of this.disposables) d.dispose()
  }
}

// ---------------------------------------------------------------------------
// piezas de dibujo de una esfera de época (lienzo de CELL × CELL, centro en R, R)
// ---------------------------------------------------------------------------
const ASI_A0 = Math.PI * 0.6
const ASI_A1 = Math.PI * 2.4
const TACH_A0 = Math.PI * 0.7
const TACH_A1 = Math.PI * 2.3
const SMALL_A0 = Math.PI * 0.75
const SMALL_A1 = Math.PI * 2.25

function sweep(v: number, min: number, max: number, a0: number, a1: number): number {
  return a0 + Math.max(0, Math.min(1, (v - min) / (max - min))) * (a1 - a0)
}
function asiAngle(kmh: number): number {
  return sweep(kmh, 0, 200, ASI_A0, ASI_A1)
}

function face(g: CanvasRenderingContext2D, R: number): void {
  const grad = g.createRadialGradient(R, R * 0.75, R * 0.05, R, R, R)
  grad.addColorStop(0, '#1e1d1a')
  grad.addColorStop(1, '#090908')
  g.fillStyle = grad
  g.fillRect(0, 0, 2 * R, 2 * R)
  // anillo fino impreso por fuera de las marcas
  g.strokeStyle = 'rgba(236,228,198,0.35)'
  g.lineWidth = R * 0.012
  g.beginPath()
  g.arc(R, R, R * 0.885, 0, TAU)
  g.stroke()
}

function ticks(
  g: CanvasRenderingContext2D,
  R: number,
  min: number,
  max: number,
  a0: number,
  a1: number,
  major: number,
  minor: number,
  label: (v: number) => string,
  font: number,
): void {
  g.strokeStyle = LUME
  g.fillStyle = LUME
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.font = `600 ${Math.round(R * font)}px ${FONT}`
  const n = Math.round((max - min) / minor)
  for (let i = 0; i <= n; i++) {
    const v = +(min + i * minor).toFixed(6)
    const a = a0 + ((v - min) / (max - min)) * (a1 - a0)
    const isMajor = Math.abs(v / major - Math.round(v / major)) < 1e-6
    const r0 = R * (isMajor ? 0.71 : 0.79)
    g.lineWidth = R * (isMajor ? 0.04 : 0.018)
    g.beginPath()
    g.moveTo(R + Math.cos(a) * r0, R + Math.sin(a) * r0)
    g.lineTo(R + Math.cos(a) * R * 0.87, R + Math.sin(a) * R * 0.87)
    g.stroke()
    if (!isMajor) continue
    const txt = label(v)
    if (txt) g.fillText(txt, R + Math.cos(a) * R * 0.55, R + Math.sin(a) * R * 0.55 + R * 0.01)
  }
}

function labels(g: CanvasRenderingContext2D, R: number, name: string, unit: string, size = 0.12): void {
  g.fillStyle = LUME_DIM
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.font = `600 ${Math.round(R * size)}px ${FONT}`
  // que quepa entre las marcas
  const max = R * 0.78
  const wName = g.measureText(name).width
  if (wName > max) g.font = `600 ${Math.round((R * size * max) / wName)}px ${FONT}`
  g.fillText(name, R, R - R * 0.27)
  g.font = `500 ${Math.round(R * size * 0.85)}px ${FONT}`
  g.fillText(unit, R, R + R * 0.33)
}

/** Aguja de espada: varilla fina, hoja con pintura luminosa hacia la punta y contrapeso redondo. */
function needle(c: CanvasRenderingContext2D, x: number, y: number, R: number, a: number, len = 0.82, wide = 0.06): void {
  c.save()
  c.translate(x, y)
  c.rotate(a)
  c.shadowColor = 'rgba(0,0,0,0.7)'
  c.shadowBlur = R * 0.05
  c.shadowOffsetY = R * 0.02
  c.fillStyle = '#d9d2b6'
  c.strokeStyle = '#1a1816'
  c.lineWidth = R * 0.01
  // varilla y contrapeso
  c.beginPath()
  c.moveTo(-R * 0.2, -R * 0.018)
  c.lineTo(R * len * 0.5, -R * 0.016)
  c.lineTo(R * len * 0.5, R * 0.016)
  c.lineTo(-R * 0.2, R * 0.018)
  c.closePath()
  c.fill()
  c.beginPath()
  c.arc(-R * 0.19, 0, R * 0.045, 0, TAU)
  c.fill()
  // hoja
  c.fillStyle = LUME
  c.beginPath()
  c.moveTo(R * len * 0.45, 0)
  c.lineTo(R * len * 0.68, -R * wide)
  c.lineTo(R * len, 0)
  c.lineTo(R * len * 0.68, R * wide)
  c.closePath()
  c.fill()
  c.shadowColor = 'transparent'
  c.stroke()
  c.restore()
  // eje: negro con el centro niquelado
  c.fillStyle = '#121110'
  c.beginPath()
  c.arc(x, y, R * 0.085, 0, TAU)
  c.fill()
  c.fillStyle = '#8f8a7e'
  c.beginPath()
  c.arc(x, y, R * 0.032, 0, TAU)
  c.fill()
}

function glass(c: CanvasRenderingContext2D, R: number): void {
  const g = c.createLinearGradient(R * 0.3, R * 0.2, R * 1.1, R * 1.1)
  g.addColorStop(0, 'rgba(255,255,255,0.10)')
  g.addColorStop(0.5, 'rgba(255,255,255,0)')
  c.fillStyle = g
  c.beginPath()
  c.arc(R, R, R * 0.93, 0, TAU)
  c.fill()
}

/** Rosa de la brújula (gira entera): N luminosa, letras y decenas de grado cada 30°. */
function compassCard(g: CanvasRenderingContext2D, R: number): void {
  g.save()
  g.translate(R, R)
  g.fillStyle = '#17150f'
  g.beginPath()
  g.arc(0, 0, R * 0.9, 0, TAU)
  g.fill()
  g.strokeStyle = LUME
  g.fillStyle = LUME
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  for (let hdg = 0; hdg < 360; hdg += 5) {
    const a = hdg * DEG - Math.PI / 2
    const big = hdg % 30 === 0
    const mid = hdg % 10 === 0
    g.lineWidth = R * (big ? 0.03 : 0.014)
    g.beginPath()
    g.moveTo(Math.cos(a) * R * (big ? 0.7 : mid ? 0.75 : 0.79), Math.sin(a) * R * (big ? 0.7 : mid ? 0.75 : 0.79))
    g.lineTo(Math.cos(a) * R * 0.86, Math.sin(a) * R * 0.86)
    g.stroke()
    if (!big) continue
    const card = hdg % 90 === 0
    const txt = hdg === 0 ? 'N' : hdg === 90 ? 'E' : hdg === 180 ? 'S' : hdg === 270 ? t('hud.west') : `${hdg / 10}`
    g.save()
    g.rotate(hdg * DEG)
    g.font = `${card ? 700 : 600} ${Math.round(R * (card ? 0.2 : 0.14))}px ${FONT}`
    g.fillText(txt, 0, -R * 0.55)
    g.restore()
  }
  // flecha del norte (luminosa) y aro interior
  g.beginPath()
  g.moveTo(0, -R * 0.42)
  g.lineTo(-R * 0.06, -R * 0.3)
  g.lineTo(R * 0.06, -R * 0.3)
  g.closePath()
  g.fill()
  g.strokeStyle = 'rgba(236,228,198,0.35)'
  g.lineWidth = R * 0.012
  g.beginPath()
  g.arc(0, 0, R * 0.26, 0, TAU)
  g.stroke()
  g.restore()
}

function screw(u: number, v: number): BufferGeometry {
  return new CylinderGeometry(0.0019, 0.0021, 0.0016, 10).rotateX(Math.PI / 2).translate(u, v, 0.0008)
}

/** Material iluminado por la escena: escribe alfa 0 (máscara de iluminación, ver Graphics.ts). */
function lit<T extends Material>(mat: T): T {
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <dithering_fragment>',
      '#include <dithering_fragment>\n\tgl_FragColor.a = 0.0;',
    )
  }
  mat.customProgramCacheKey = () => 'lit-alpha0'
  return mat
}
