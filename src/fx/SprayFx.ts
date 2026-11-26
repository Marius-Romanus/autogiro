// Fumigación (ELA Gyro Tractor): con el paso abierto (tecla U, botón Y del mando o el botón de la
// barra superior) sale caldo por cada boquilla de las barras (nodos `spray_NN` del modelo). Las gotas
// salen con la velocidad del aparato y el soplado del rotor, el aire las frena enseguida, caen
// despacio, derivan con el viento y se posan en el suelo.
//
// La tolva se vacía según la dosis (l/ha), la anchura de pasada y la velocidad respecto al suelo
// (como el caudalímetro del AgNav: a más velocidad, más caudal), y el producto que sale aligera el
// aparato (Autogyro.setPayload). Se rellena al salir otra vez (spawn).
//
// Las gotas se dibujan con los billboards del polvo de los accidentes (CrashFx), en dos pasadas según
// lo que haya detrás: albedo donde el fondo lo ilumina luego la atmósfera (terreno) y color ya
// iluminado donde el fondo ya lo está (aparato, cielo).

import {
  AddEquation,
  CanvasTexture,
  CustomBlending,
  DstAlphaFactor,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  OneFactor,
  OneMinusDstAlphaFactor,
  OneMinusSrcAlphaFactor,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  Vector3,
  ZeroFactor,
  type DirectionalLight,
  type LightProbe,
  type Matrix4,
  type Object3D,
} from 'three'
import { addStrings, onLangChange, t } from '../i18n.ts'
import { OVERLAY_LAYER } from '../render/Graphics.ts'
import { hideWhenEmpty } from '../render/emptyDraws.ts'
import type { SprayerSpec } from '../sim/airframes.ts'
import type { Autogyro } from '../sim/autogyro.ts'
import { BILLBOARD_FS, BILLBOARD_VS } from './CrashFx.ts'

/** Mancha de niebla: campana suave, sin el borde de lóbulos del polvo (muchas solapadas = cortina). */
function mistTexture(size: number): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')!
  const h = size / 2
  const rg = g.createRadialGradient(h, h, 0, h, h, h)
  for (let i = 0; i <= 8; i++) {
    const r = i / 8
    rg.addColorStop(r, `rgba(255,255,255,${(Math.exp(-4.5 * r * r) - Math.exp(-4.5)).toFixed(3)})`)
  }
  g.fillStyle = rg
  g.fillRect(0, 0, size, size)
  return new CanvasTexture(c)
}

addStrings('es', {
  'spray.label': 'Fumigar',
  'spray.title': 'Fumigación: abrir o cerrar el paso de las barras (U)',
  'toast.sprayOn': 'Fumigación abierta',
  'toast.sprayOff': 'Fumigación cerrada',
  'toast.sprayEmpty': 'Tolva vacía: sal otra vez para cargarla',
  'toast.sprayNone': 'Este autogiro no lleva equipo de fumigación',
})
addStrings('en', {
  'spray.label': 'Spray',
  'spray.title': 'Crop spraying: open or close the boom valve (U)',
  'toast.sprayOn': 'Spraying on',
  'toast.sprayOff': 'Spraying off',
  'toast.sprayEmpty': 'Hopper empty: restart to reload it',
  'toast.sprayNone': 'This gyroplane has no spraying gear',
})

/** gotas a la vez como mucho */
const MAX = 7000
/** gotas por segundo entre todas las boquillas al caudal de trabajo */
const RATE_TOTAL = 1600
/** velocidad respecto al suelo por debajo de la cual el caudal ya no baja (m/s) */
const MIN_GS = 8
/** frenado del aire (1/s), velocidad de caída de la niebla (m/s) y soplado hacia abajo al salir */
const DRAG = 2.2
const SETTLE = 0.9
const DOWNWASH = 3.2
const ALBEDO = [0.95, 0.96, 0.97]

const _v = new Vector3()
const _d = new Vector3()
const _q = new Quaternion()

export class CropSprayer {
  readonly root = new Group()
  /** radiancia por unidad de albedo (sol + cielo) para la pasada sobre lo ya iluminado */
  private readonly light = new Vector3(0.5, 0.5, 0.5)
  private spec: SprayerSpec | null = null
  /** paso abierto */
  on = false
  /** litros en la tolva y caudal de ahora (l/s) */
  litres = 0
  flow = 0
  private nozzles: Object3D[] = []
  /** boquillas en ejes de la raíz del aparato (CG); se calculan la primera vez */
  private local: Vector3[] = []
  private acc: number[] = []
  private readonly btn: HTMLButtonElement
  private readonly level: HTMLElement
  private readonly amount: HTMLElement
  private shownL = -1

  // gotas (anillo): posición, velocidad, suelo bajo ellas, edad, vida, tamaños, giro y opacidad
  private readonly p = new Float32Array(MAX * 3)
  private readonly v = new Float32Array(MAX * 3)
  private readonly g = new Float32Array(MAX)
  private readonly age = new Float32Array(MAX).fill(1)
  private readonly life = new Float32Array(MAX).fill(1)
  private readonly s0 = new Float32Array(MAX)
  private readonly s1 = new Float32Array(MAX)
  private readonly rot = new Float32Array(MAX)
  private readonly a = new Float32Array(MAX)
  private next = 0
  private readonly geo: InstancedBufferGeometry
  private readonly iPos = new Float32Array(MAX * 3)
  private readonly iCol = new Float32Array(MAX * 4)
  private readonly iSr = new Float32Array(MAX * 2)

  private readonly lights: { sun: DirectionalLight; sky: LightProbe } | null

  constructor(scene: Object3D, lights?: { sun: DirectionalLight; sky: LightProbe }) {
    this.lights = lights ?? null
    this.root.name = 'crop-spray'
    const base = new PlaneGeometry(1, 1)
    const geo = new InstancedBufferGeometry()
    geo.index = base.index
    geo.setAttribute('position', base.getAttribute('position'))
    geo.setAttribute('uv', base.getAttribute('uv'))
    geo.setAttribute('iPos', new InstancedBufferAttribute(this.iPos, 3))
    geo.setAttribute('iCol', new InstancedBufferAttribute(this.iCol, 4))
    geo.setAttribute('iSizeRot', new InstancedBufferAttribute(this.iSr, 2))
    geo.instanceCount = 0
    this.geo = geo
    const tex = mistTexture(64)
    const mk = (lit: boolean) => {
      const m = new ShaderMaterial({
        uniforms: { map: { value: tex }, emissive: { value: 0 }, light: { value: lit ? this.light : new Vector3(1, 1, 1) }, premultiply: { value: 1 } },
        vertexShader: BILLBOARD_VS,
        fragmentShader: BILLBOARD_FS,
        transparent: true,
        depthWrite: false,
      })
      // 1) atenúa el fondo por (1 − a) y suma albedo·a donde el fondo es albedo (terreno);
      // 2) suma radiancia·a donde el fondo ya está iluminado (cielo, aparato), como los discos de las
      //    palas (Graphics.overlayLightPass). Con el «máximo» del polvo de CrashFx la niebla blanca
      //    salía oscura contra el cielo, como humo.
      m.blending = CustomBlending
      m.blendEquation = AddEquation
      m.blendSrc = lit ? OneMinusDstAlphaFactor : DstAlphaFactor
      m.blendDst = lit ? OneFactor : OneMinusSrcAlphaFactor
      m.blendEquationAlpha = AddEquation
      m.blendSrcAlpha = ZeroFactor
      m.blendDstAlpha = OneFactor
      return m
    }
    for (const [i, lit] of [false, true].entries()) {
      // (sin gotas no se dibuja: render/emptyDraws.ts)
      const mesh = hideWhenEmpty(new Mesh(geo, mk(lit)))
      mesh.frustumCulled = false
      mesh.renderOrder = 4 + i
      // fuera del pase de normales, como los discos de las palas y los vidrios
      mesh.layers.set(OVERLAY_LAYER)
      this.root.add(mesh)
    }
    scene.add(this.root)

    // botón de la barra superior con el nivel de la tolva (solo con un aparato que fumiga)
    const b = document.createElement('button')
    b.id = 'btn-spray'
    b.type = 'button'
    b.className = 'hidden'
    b.setAttribute('aria-pressed', 'false')
    b.innerHTML = '<span class="label"></span><span class="tank"><i></i></span><span class="litres"></span><kbd>U</kbd>'
    // sin foco tras el clic: si no, Espacio (frenos) volvería a pulsar el botón
    b.addEventListener('mousedown', (e) => e.preventDefault())
    this.btn = b
    this.level = b.querySelector('.tank i') as HTMLElement
    this.amount = b.querySelector('.litres') as HTMLElement
    const lightsBtn = document.getElementById('btn-lights')
    if (lightsBtn) lightsBtn.after(b)
    else document.getElementById('topbar')?.appendChild(b)
    this.relabel()
    onLangChange(() => this.relabel())
  }

  /** El botón de la barra superior (main.ts le pone el clic). */
  get button(): HTMLButtonElement {
    return this.btn
  }

  /** ¿El aparato cargado fumiga? */
  get available(): boolean {
    return this.spec !== null && this.nozzles.length > 0
  }

  /** Textos del botón en el idioma de la interfaz. */
  private relabel(): void {
    ;(this.btn.querySelector('.label') as HTMLElement).textContent = t('spray.label')
    this.btn.title = t('spray.title')
  }

  /** Aparato nuevo o salida otra vez: tolva cargada, paso cerrado, sin gotas en el aire. */
  reset(spec: SprayerSpec | undefined, nozzles: Object3D[], ac: Autogyro): void {
    this.spec = spec ?? null
    this.setNozzles(nozzles)
    this.on = false
    this.flow = 0
    this.litres = this.spec ? this.spec.load : 0
    ac.setPayload(this.spec ? this.litres * this.spec.density : 0)
    this.age.fill(1)
    this.life.fill(1)
    this.geo.instanceCount = 0
    this.shownL = -1
  }

  /** Boquillas del modelo (cambian al cargar otro aparato, que llega después del spawn). */
  setNozzles(nozzles: Object3D[]): void {
    if (nozzles === this.nozzles) return
    this.nozzles = nozzles
    this.local = []
    this.acc = nozzles.map(() => Math.random())
  }

  /** Abre o cierra el paso; devuelve el aviso que hay que mostrar. */
  toggle(): string {
    if (!this.available) return t('toast.sprayNone')
    if (!this.on && this.litres <= 0) return t('toast.sprayEmpty')
    this.on = !this.on
    return t(this.on ? 'toast.sprayOn' : 'toast.sprayOff')
  }

  /** Cierra el paso (accidente). */
  stop(): void {
    this.on = false
    this.flow = 0
  }

  /**
   * Un fotograma. `root`: raíz del modelo (en el CG del aparato); `wind`: viento junto al aparato
   * (mundo, m/s); `groundY`: altura del suelo bajo el aparato; `flying`: la física avanza (si no,
   * ni sale caldo ni se vacía la tolva, pero las gotas que ya están en el aire siguen su camino).
   * Devuelve el aviso de tolva vacía cuando se acaba en este fotograma.
   */
  update(dt: number, ac: Autogyro, root: Object3D, wind: Vector3, groundY: number | null, flying: boolean): string | null {
    let msg: string | null = null
    const spec = this.spec
    this.btn.classList.toggle('hidden', !this.available)
    if (spec && this.available) {
      if (this.on && flying && this.litres > 0) {
        const gs = Math.hypot(ac.vel.x, ac.vel.z)
        this.flow = (spec.rate * spec.swath * Math.max(gs, MIN_GS)) / 10000
        this.litres = Math.max(0, this.litres - this.flow * dt)
        ac.setPayload(this.litres * spec.density)
        this.emit(dt, ac, root, groundY ?? ac.pos.y - 50)
        if (this.litres <= 0) {
          this.on = false
          msg = t('toast.sprayEmpty')
        }
      } else this.flow = 0
      this.updateButton(spec)
    }
    this.step(dt, wind)
    return msg
  }

  private updateButton(spec: SprayerSpec): void {
    const l = Math.round(this.litres)
    this.btn.classList.toggle('on', this.on)
    this.btn.setAttribute('aria-pressed', String(this.on))
    if (l === this.shownL) return
    this.shownL = l
    this.amount.textContent = `${l} l`
    this.level.style.width = `${Math.round((100 * this.litres) / spec.hopper)}%`
  }

  /** Pone la luz de las gotas a partir del sol y del cielo de la escena (como el polvo de CrashFx). */
  private updateLight(): void {
    if (!this.lights) return
    const { sun, sky } = this.lights
    const sunDir = _v.copy(sun.position).sub(sun.target.position).normalize()
    const k = sun.intensity * Math.max(0, 0.35 + 0.65 * sunDir.y) * 0.6
    sky.sh.getIrradianceAt(_d.set(0, 1, 0), _v)
    this.light
      .set(sun.color.r * k, sun.color.g * k, sun.color.b * k)
      .addScaledVector(_v, sky.intensity)
      .multiplyScalar(1 / Math.PI)
  }

  private emit(dt: number, ac: Autogyro, root: Object3D, groundY: number): void {
    const n = this.nozzles.length
    if (this.local.length !== n) {
      // boquillas en ejes de la raíz (la del modelo de vuelo, en el CG)
      root.updateMatrixWorld(true)
      this.local = this.nozzles.map((o) => root.worldToLocal(o.getWorldPosition(new Vector3())))
    }
    const spec = this.spec!
    // caudal de trabajo (a 110 km/h) → RATE_TOTAL gotas por segundo; con menos caudal, menos gotas
    const nominal = (spec.rate * spec.swath * 30.6) / 10000
    const perNozzle = (RATE_TOTAL / n) * Math.min(1.4, Math.max(0.3, this.flow / nominal))
    const down = _d.set(0, -1, 0).applyQuaternion(root.quaternion)
    for (let i = 0; i < n; i++) {
      this.acc[i] += perNozzle * dt
      while (this.acc[i] >= 1) {
        this.acc[i] -= 1
        const j = this.next
        this.next = (this.next + 1) % MAX
        // repartidas a lo largo del camino de este fotograma (sin grumos a poca tasa de fotogramas)
        const back = Math.random() * dt
        _v.copy(this.local[i]).applyQuaternion(root.quaternion).add(root.position).addScaledVector(ac.vel, -back)
        this.p[j * 3] = _v.x
        this.p[j * 3 + 1] = _v.y
        this.p[j * 3 + 2] = _v.z
        const dw = DOWNWASH * (0.7 + Math.random() * 0.6)
        this.v[j * 3] = ac.vel.x * 0.9 + down.x * dw + (Math.random() - 0.5) * 2
        this.v[j * 3 + 1] = ac.vel.y * 0.9 + down.y * dw + (Math.random() - 0.5) * 0.6
        this.v[j * 3 + 2] = ac.vel.z * 0.9 + down.z * dw + (Math.random() - 0.5) * 2
        this.g[j] = groundY
        this.age[j] = back
        this.life[j] = 2.5 + Math.random() * 2.5
        this.s0[j] = 0.25 + Math.random() * 0.15
        this.s1[j] = 2.5 + Math.random() * 2.5
        this.rot[j] = Math.random() * 6.28
        this.a[j] = 0.12 + Math.random() * 0.1
      }
    }
  }

  private step(dt: number, wind: Vector3): void {
    this.updateLight()
    const k = Math.min(1, DRAG * dt)
    let n = 0
    for (let j = 0; j < MAX; j++) {
      const age = (this.age[j] += dt)
      const life = this.life[j]
      if (age >= life) continue
      const o = j * 3
      let vx = this.v[o]
      let vy = this.v[o + 1]
      let vz = this.v[o + 2]
      vx += (wind.x - vx) * k
      vz += (wind.z - vz) * k
      vy += (wind.y - SETTLE - vy) * k
      let y = this.p[o + 1] + vy * dt
      const x = this.p[o] + vx * dt
      const z = this.p[o + 2] + vz * dt
      const t = age / life
      let size = this.s0[j] + (this.s1[j] - this.s0[j]) * (1 - (1 - t) * (1 - t))
      // posada: se queda a ras del suelo, se abre y se apaga antes
      const floor = this.g[j] + 0.35 * size
      if (y < floor) {
        y = floor
        vy = 0
        if (life - age > 0.8) this.life[j] = age + 0.8
        size *= 1.25
      }
      this.p[o] = x
      this.p[o + 1] = y
      this.p[o + 2] = z
      this.v[o] = vx
      this.v[o + 1] = vy
      this.v[o + 2] = vz
      const fadeIn = Math.min(1, age / 0.1)
      const fade = 1 - t
      this.iPos[n * 3] = x
      this.iPos[n * 3 + 1] = y
      this.iPos[n * 3 + 2] = z
      this.iCol[n * 4] = ALBEDO[0]
      this.iCol[n * 4 + 1] = ALBEDO[1]
      this.iCol[n * 4 + 2] = ALBEDO[2]
      this.iCol[n * 4 + 3] = this.a[j] * fadeIn * fade * Math.sqrt(fade)
      this.iSr[n * 2] = size
      this.iSr[n * 2 + 1] = this.rot[j] + age * 0.2
      n++
    }
    this.geo.instanceCount = n
    if (n === 0) return
    for (const name of ['iPos', 'iCol', 'iSizeRot']) {
      const a = this.geo.getAttribute(name) as InstancedBufferAttribute
      a.needsUpdate = true
      a.clearUpdateRanges()
      a.addUpdateRange(0, n * a.itemSize)
    }
  }

  /** Re-centrado del mundo: las gotas que hay en el aire se mueven con él. */
  rebase(m: Matrix4): void {
    _q.setFromRotationMatrix(m)
    for (let j = 0; j < MAX; j++) {
      if (this.age[j] >= this.life[j]) continue
      const o = j * 3
      _v.set(this.p[o], this.g[j], this.p[o + 2]).applyMatrix4(m)
      this.g[j] = _v.y
      _v.fromArray(this.p, o).applyMatrix4(m).toArray(this.p, o)
      _v.fromArray(this.v, o).applyQuaternion(_q).toArray(this.v, o)
    }
  }
}
