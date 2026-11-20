// Detalles de cabina añadidos sobre el GLB de cada aparato:
//  · hilo de guiñada 3D pegado al parabrisas, movido por el aire relativo real
//    (velocidad propia − viento con ráfagas, giro del aparato y gravedad);
//  · panel de instrumentos vivo (relojes, EFIS con horizonte y bola, avisos)
//    dibujado en un lienzo y puesto sobre el salpicadero del modelo.

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  Material,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Raycaster,
  RingGeometry,
  SRGBColorSpace,
  Vector3,
} from 'three'
import { LIGHT_LAYER } from '../render/Graphics.ts'
import { t } from '../i18n.ts'
import { CG } from '../sim/autogyro.ts'
import type { Hud, HudData } from '../hud/Hud.ts'

const DEG = Math.PI / 180
const TAU = Math.PI * 2

/** Salpicadero de cada GLB (coordenadas del modelo: +X morro, +Y arriba, +Z derecha). Sale de blender/*.py. */
interface PanelSpec {
  /** centro de la caja del panel */
  center: [number, number, number]
  width: number
  height: number
  /** inclinación hacia delante de la parte alta (grados) */
  tilt: number
  /** grosor de la caja del panel en Blender (la cara está a la mitad) */
  depth?: number
}
const PANELS: Record<string, PanelSpec> = {
  autogiro: { center: [1.1, -0.02, 0], width: 0.6, height: 0.21, tilt: 15 },
  ela07: { center: [1.38, -0.17, 0], width: 0.44, height: 0.2, tilt: 28 },
  ela10: { center: [1.38, -0.29, 0], width: 0.38, height: 0.15, tilt: 26 },
}

/**
 * Aparatos con el hilo en una varilla sobre el morro (ELA 07: delante de la cabina) en vez de
 * pegado al parabrisas. `x`: posición longitudinal de la varilla; `top`: altura de su punta
 * respecto al ojo del piloto (se ve a través del parabrisas).
 */
const YAW_ROD: Record<string, { x: number; top: number }> = {
  ela07: { x: 1.72, top: -0.08 },
}

/** Lo que el hilo necesita del aparato. */
export interface CockpitAircraft {
  readonly pos: Vector3
  readonly quat: Quaternion
  readonly vel: Vector3
  /** velocidad angular, ejes cuerpo (rad/s) */
  readonly omega?: Vector3
}

const _q = new Quaternion()
const _v = new Vector3()
const _v2 = new Vector3()
const _v3 = new Vector3()
const _u = new Vector3()
const _g = new Vector3()
const _m = new Matrix4()
const _cam = new Vector3()

export class Cockpit {
  private root = new Group()
  private model: Object3D | null = null
  private yaw: YawString | null = null
  private panel: LivePanel | null = null

  constructor() {
    this.root.name = 'cockpit_extras'
  }

  /** Coloca hilo y panel en el modelo recién cargado. `eye` en coordenadas del modelo. */
  attach(model: Object3D, key: string, glass: Mesh[], eye: Vector3): void {
    this.detach()
    this.model = model
    model.add(this.root)
    model.updateMatrixWorld(true)
    const spec = PANELS[key]
    if (spec) {
      this.panel = new LivePanel(spec)
      this.root.add(this.panel.group)
    }
    const rod = YAW_ROD[key] ? buildRod(model, glass, eye, YAW_ROD[key]) : null
    const anchor = rod ? { point: rod.top, normal: new Vector3(0, 1, 0) } : findStringAnchor(model, glass, eye)
    this.yaw = new YawString(anchor.point, anchor.normal, !!rod)
    if (rod) this.yaw.group.add(rod.mesh)
    this.root.add(this.yaw.group)
  }

  detach(): void {
    this.root.removeFromParent()
    this.panel?.dispose()
    this.yaw?.dispose()
    this.panel = null
    this.yaw = null
    this.model = null
  }

  /**
   * @param wind viento (mundo, m/s, con ráfagas)
   * @param hud datos de instrumentos (null: no hace falta redibujar el panel)
   * @param near la cámara está en cabina o cerca: merece la pena dibujar el panel
   */
  update(dt: number, ac: CockpitAircraft, wind: Vector3, camera: Vector3, hudPainter: Hud, hud: HudData | null, near: boolean): void {
    if (!this.model) return
    this.model.updateWorldMatrix(true, false)
    this.yaw?.update(dt, ac, wind, this.model.worldToLocal(_cam.copy(camera)))
    if (this.panel && hud && near) this.panel.update(dt, ac, hudPainter, hud)
  }
}

// ---------------------------------------------------------------------------
// Anclaje del hilo: el parabrisas justo delante del ojo del piloto
// ---------------------------------------------------------------------------
function findStringAnchor(model: Object3D, glass: Mesh[], eye: Vector3): { point: Vector3; normal: Vector3 } {
  const rc = new Raycaster()
  rc.layers.enableAll()
  const inv = new Matrix4().copy(model.matrixWorld).invert()
  const nMat = new Matrix4()
  const eyeW = eye.clone().applyMatrix4(model.matrixWorld)
  for (const elev of [7, 5, 9, 3, 11, 1, 14, -2, -5]) {
    const dir = new Vector3(Math.cos(elev * DEG), Math.sin(elev * DEG), 0).transformDirection(model.matrixWorld)
    rc.set(eyeW, dir)
    rc.far = 2.5
    const hits = rc.intersectObjects(glass, false).filter((h) => h.face)
    if (!hits.length) continue
    // la cara exterior: el último impacto a menos de 3 cm del primero (vidrio con grosor)
    let h = hits[0]
    for (const k of hits) if (k.distance - hits[0].distance < 0.03) h = k
    const p = h.point.clone().applyMatrix4(inv)
    nMat.copy(inv).multiply(h.object.matrixWorld)
    const n = h.face!.normal.clone().transformDirection(nMat)
    // hacia fuera = alejándose del ojo
    if (n.dot(_v.copy(p).sub(eye)) < 0) n.negate()
    return { point: p.addScaledVector(n, 0.0025), normal: n }
  }
  // sin parabrisas: en el morro, delante del piloto
  return { point: eye.clone().add(new Vector3(0.75, -0.02, 0)), normal: new Vector3(0.6, 0.8, 0).normalize() }
}

/** Varilla vertical sobre el morro: busca la piel del morro con un rayo hacia abajo. */
function buildRod(model: Object3D, glass: Mesh[], eye: Vector3, spec: { x: number; top: number }): { top: Vector3; mesh: Mesh } | null {
  const targets: Mesh[] = []
  model.traverse((o) => {
    const m = o as Mesh
    if (m.isMesh && !glass.includes(m) && !/pilot/i.test(m.name) && !/pilot/i.test(m.parent?.name ?? '')) targets.push(m)
  })
  const rc = new Raycaster()
  rc.layers.enableAll()
  // por debajo del rotor (sus palas pasan por encima del morro)
  const origin = new Vector3(spec.x, eye.y + 0.6, 0).applyMatrix4(model.matrixWorld)
  const dir = new Vector3(0, -1, 0).transformDirection(model.matrixWorld)
  rc.set(origin, dir)
  rc.far = 3
  const hit = rc.intersectObjects(targets, false)[0]
  if (!hit) return null
  const base = hit.point.clone().applyMatrix4(new Matrix4().copy(model.matrixWorld).invert())
  const topY = Math.max(base.y + 0.06, eye.y + spec.top)
  const len = topY - base.y + 0.01
  const geo = new CylinderGeometry(0.0022, 0.003, len, 8)
  const mat = lit(new MeshStandardMaterial({ color: new Color('#1a1b1e'), roughness: 0.4, metalness: 0.5 }))
  const mesh = new Mesh(geo, mat)
  mesh.position.set(spec.x, base.y - 0.01 + len / 2, 0)
  mesh.layers.set(LIGHT_LAYER)
  mesh.castShadow = true
  return { top: new Vector3(spec.x, topY, 0), mesh }
}

// ---------------------------------------------------------------------------
// Hilo de guiñada: cadena de partículas (dinámica por posiciones) en ejes cuerpo
// ---------------------------------------------------------------------------
const N = 12 // nodos
const LEN = 0.14 // m
const SEG = LEN / (N - 1)
/** arrastre por unidad de masa de un hilo de lana de 3 mm (0,5·ρ·Cd·d / masa por metro) ≈ 3,6 m⁻¹ */
const DRAG = 3.6
const WIDTH = 0.0042

class YawString {
  readonly group = new Group()
  private p: Vector3[] = []
  private vel: Vector3[] = []
  private geo = new BufferGeometry()
  private pos: Float32Array
  private nor: Float32Array
  private mesh: Mesh
  private tape: Mesh
  private t = Math.random() * 10
  private lastVel = new Vector3()
  private accBody = new Vector3()
  private first = true
  private side = new Vector3()

  private anchor: Vector3
  private normal: Vector3
  /** en una varilla: cuelga libre, sin superficie debajo */
  private free: boolean

  constructor(anchor: Vector3, normal: Vector3, free = false) {
    this.anchor = anchor
    this.normal = normal
    this.free = free
    // de salida cuelga hacia atrás por la superficie
    const back = _v.set(-1, 0, 0).projectOnPlane(normal).normalize()
    for (let i = 0; i < N; i++) {
      this.p.push(anchor.clone().addScaledVector(back, i * SEG))
      this.vel.push(new Vector3())
    }
    this.pos = new Float32Array(N * 2 * 3)
    this.nor = new Float32Array(N * 2 * 3)
    const idx: number[] = []
    for (let i = 0; i < N - 1; i++) {
      const a = i * 2
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
    this.geo.setIndex(idx)
    this.geo.setAttribute('position', new BufferAttribute(this.pos, 3))
    this.geo.setAttribute('normal', new BufferAttribute(this.nor, 3))
    const mat = lit(new MeshStandardMaterial({ color: new Color('#ff3a14'), roughness: 0.85, side: DoubleSide }))
    this.mesh = new Mesh(this.geo, mat)
    this.mesh.frustumCulled = false
    this.mesh.layers.set(LIGHT_LAYER)
    this.group.add(this.mesh)

    // trocito de cinta adhesiva que lo sujeta
    const tapeMat = lit(new MeshStandardMaterial({ color: new Color('#d9dcd6'), roughness: 0.45 }))
    this.tape = new Mesh(new BoxGeometry(0.02, 0.0006, 0.014), tapeMat)
    this.tape.quaternion.setFromUnitVectors(_v.set(0, 1, 0), normal)
    // la cinta, alineada con el eje longitudinal proyectado
    const along = _v2.set(1, 0, 0).projectOnPlane(normal).normalize()
    const tx = _v3.set(1, 0, 0).applyQuaternion(this.tape.quaternion)
    const ang = Math.atan2(_u.crossVectors(tx, along).dot(normal), tx.dot(along))
    this.tape.quaternion.premultiply(_q.setFromAxisAngle(normal, ang))
    this.tape.position.copy(anchor).addScaledVector(normal, 0.0003)
    this.tape.layers.set(LIGHT_LAYER)
    this.tape.visible = !free
    this.group.add(this.tape)
    this.side.crossVectors(normal, along).normalize()
    this.writeGeometry()
  }

  private eye = new Vector3()

  update(dt: number, ac: CockpitAircraft, wind: Vector3, camLocal: Vector3): void {
    this.eye.copy(camLocal)
    dt = Math.min(dt, 0.05)
    if (dt <= 0) return
    this.t += dt
    _q.copy(ac.quat).invert()
    // aceleración del aparato (ejes cuerpo), para la fuerza de inercia sobre el hilo
    if (this.first) {
      this.lastVel.copy(ac.vel)
      this.first = false
    }
    _v.copy(ac.vel).sub(this.lastVel).divideScalar(dt)
    this.lastVel.copy(ac.vel)
    if (_v.lengthSq() > 900) _v.setLength(30) // saltos de posición/teletransporte
    _v.applyQuaternion(_q)
    this.accBody.lerp(_v, Math.min(1, dt * 12))
    // gravedad aparente en ejes cuerpo
    _g.set(0, -9.81, 0).applyQuaternion(_q).sub(this.accBody)
    // aire relativo en ejes cuerpo (en el CG): −(v − viento)
    const air = _v2.copy(wind).sub(ac.vel).applyQuaternion(_q)
    const om = ac.omega
    const speed = air.length()
    const n = this.normal
    const steps = 4
    const h = dt / steps
    const flutterAmp = 0.05 + 0.04 * Math.min(1, speed / 30)
    for (let s = 0; s < steps; s++) {
      const tt = this.t - dt + (s + 1) * h
      for (let i = 1; i < N; i++) {
        const p = this.p[i]
        const v = this.vel[i]
        // aire en este punto: el del CG menos ω × r
        _u.copy(air)
        if (om) _u.sub(_v3.copy(p).sub(CG).cross(om).negate())
        // el flujo se pega a la superficie: sin componente que entre en el vidrio
        const un = _u.dot(n)
        if (un < 0 && !this.free) _u.addScaledVector(n, -un * 0.9)
        // aleteo: desprendimiento de torbellinos, más fuerte hacia la punta
        const k = i / (N - 1)
        const f1 = Math.sin(tt * 61 + i * 0.9) + 0.6 * Math.sin(tt * 97 - i * 1.7) + 0.4 * Math.sin(tt * 23 + i * 0.4)
        _u.addScaledVector(this.side, speed * flutterAmp * k * f1)
        _u.addScaledVector(n, speed * flutterAmp * (this.free ? 0.6 : 0.2) * k * Math.sin(tt * 73 + i * 1.3))
        // gravedad y arrastre (implícito: estable con cualquier paso)
        v.addScaledVector(_g, h)
        const rel = _v3.copy(v).sub(_u)
        const r = rel.length()
        v.copy(_u).addScaledVector(rel, Math.exp(-DRAG * r * h))
        v.multiplyScalar(0.995)
      }
      // integrar y restringir
      const old = this.tmpOld
      for (let i = 1; i < N; i++) {
        old[i].copy(this.p[i])
        this.p[i].addScaledVector(this.vel[i], h)
      }
      this.p[0].copy(this.anchor)
      for (let it = 0; it < 2; it++) {
        // no atraviesa el vidrio
        for (let i = 1; i < N && !this.free; i++) {
          const dn = _v3.copy(this.p[i]).sub(this.anchor).dot(n)
          if (dn < 0.0012) this.p[i].addScaledVector(n, 0.0012 - dn)
        }
        // longitud fija: cada tramo sigue al anterior desde el anclaje (exacto)
        for (let i = 1; i < N; i++) {
          const d = _v3.copy(this.p[i]).sub(this.p[i - 1])
          const l = d.length()
          if (l < 1e-7) d.set(-SEG, 0, 0)
          else d.multiplyScalar(SEG / l)
          this.p[i].copy(this.p[i - 1]).add(d)
        }
      }
      for (let i = 1; i < N; i++) this.vel[i].copy(this.p[i]).sub(old[i]).divideScalar(h)
    }
    this.writeGeometry()
  }

  private tmpOld = Array.from({ length: N }, () => new Vector3())

  private writeGeometry(): void {
    const n = this.normal
    for (let i = 0; i < N; i++) {
      const a = this.p[Math.max(0, i - 1)]
      const b = this.p[Math.min(N - 1, i + 1)]
      const t = _v.copy(b).sub(a).normalize()
      // hilo redondo: la cinta siempre de cara a la cámara
      const w = _v2.crossVectors(t, _v3.copy(this.eye).sub(this.p[i]))
      if (w.lengthSq() < 1e-10) w.crossVectors(t, n)
      if (w.lengthSq() < 1e-10) w.copy(this.side)
      w.normalize().multiplyScalar((WIDTH * (1 - 0.35 * (i / (N - 1)))) / 2)
      const p = this.p[i]
      const o = i * 6
      this.pos[o] = p.x + w.x
      this.pos[o + 1] = p.y + w.y
      this.pos[o + 2] = p.z + w.z
      this.pos[o + 3] = p.x - w.x
      this.pos[o + 4] = p.y - w.y
      this.pos[o + 5] = p.z - w.z
      const nn = n
      this.nor[o] = this.nor[o + 3] = nn.x
      this.nor[o + 1] = this.nor[o + 4] = nn.y
      this.nor[o + 2] = this.nor[o + 5] = nn.z
    }
    this.geo.attributes.position.needsUpdate = true
    this.geo.attributes.normal.needsUpdate = true
  }

  dispose(): void {
    this.group.removeFromParent()
    this.group.traverse((o) => {
      const m = o as Mesh
      if (!m.isMesh) return
      m.geometry.dispose()
      ;(m.material as Material).dispose()
    })
  }
}

// ---------------------------------------------------------------------------
// Panel de instrumentos vivo
// ---------------------------------------------------------------------------
type GaugeKind = 'asi' | 'alt' | 'vsi' | 'rotor' | 'engine' | 'hdg'
interface GaugeSlot {
  kind: GaugeKind
  x: number
  y: number
  d: number
}

const PX_PER_M = 2900
const LIFT = 0.013 // por delante de la cara del panel del GLB (tapa sus relojes de adorno)

class LivePanel {
  readonly group = new Group()
  private canvas = document.createElement('canvas')
  private ctx: CanvasRenderingContext2D
  private tex: CanvasTexture
  private bg: HTMLCanvasElement
  private gauges: GaugeSlot[] = []
  private efis: { x: number; y: number; w: number; h: number }
  private ann: { x: number; y: number; w: number; h: number }
  private acc = 1
  private blink = 0
  private s: number
  private disposables: { dispose(): void }[] = []

  constructor(spec: PanelSpec) {
    const w = spec.width - 0.014
    const h = spec.height - 0.014
    const scale = Math.min(PX_PER_M, 1500 / w)
    this.s = scale
    this.canvas.width = Math.round(w * scale)
    this.canvas.height = Math.round(h * scale)
    this.ctx = this.canvas.getContext('2d')!

    // ----- disposición (en metros) -----
    const m = 0.009
    const annH = 0.016
    const efisW = Math.max(0.11, Math.min(0.165, w * 0.3))
    const efisH = Math.min(h - 2 * m - annH - 0.004, efisW * 0.78)
    this.efis = { x: (w - efisW) / 2, y: m, w: efisW, h: efisH }
    this.ann = { x: (w - efisW) / 2, y: m + efisH + 0.005, w: efisW, h: annH }
    const rw = (w - efisW) / 2 - 1.5 * m
    const regions: [number, GaugeKind[]][] = [
      [m, ['asi', 'alt', 'vsi']],
      [w - m - rw, ['rotor', 'engine', 'hdg']],
    ]
    for (const [rx, kinds] of regions) {
      const d1 = Math.min((rw - m * 0.6) / 2, (h - 2 * m) * 0.56)
      const d2 = Math.min(h - 2 * m - d1 - m * 0.4, d1)
      const cx = rx + rw / 2
      if (d2 > 0.036) {
        this.gauges.push({ kind: kinds[0], x: cx - d1 / 2 - m * 0.3, y: m + d1 / 2, d: d1 })
        this.gauges.push({ kind: kinds[1], x: cx + d1 / 2 + m * 0.3, y: m + d1 / 2, d: d1 })
        this.gauges.push({ kind: kinds[2], x: cx, y: m + d1 + m * 0.4 + d2 / 2, d: d2 })
      } else {
        const d = Math.min(rw / 3 - m * 0.4, h - 2 * m)
        kinds.forEach((k, i) => this.gauges.push({ kind: k, x: rx + (rw / 3) * (i + 0.5), y: h / 2, d }))
      }
    }

    this.bg = this.paintBackground(w, h)

    this.tex = new CanvasTexture(this.canvas)
    this.tex.colorSpace = SRGBColorSpace
    this.tex.anisotropy = 8
    this.disposables.push(this.tex)

    // ----- geometría: placa con la textura + biseles de los relojes -----
    const tilt = spec.tilt * DEG
    const nrm = new Vector3(-Math.cos(tilt), Math.sin(tilt), 0)
    const up = new Vector3(Math.sin(tilt), Math.cos(tilt), 0)
    const right = new Vector3(0, 0, 1)
    const faceC = new Vector3(...spec.center).addScaledVector(nrm, (spec.depth ?? 0.03) / 2)
    // base: X local → derecha, Y → arriba, Z → normal (hacia el piloto)
    _m.makeBasis(right, up, nrm)
    this.group.quaternion.setFromRotationMatrix(_m)
    this.group.position.copy(faceC)

    const plateDepth = LIFT
    const front = lit(
      new MeshStandardMaterial({
        map: this.tex,
        emissiveMap: this.tex,
        emissive: new Color(0xffffff),
        emissiveIntensity: 0.22,
        roughness: 0.62,
        metalness: 0,
      }),
    )
    const sideMat = lit(new MeshStandardMaterial({ color: new Color('#101113'), roughness: 0.7 }))
    const plateGeo = new BoxGeometry(w, h, plateDepth)
    const plate = new Mesh(plateGeo, [sideMat, sideMat, sideMat, sideMat, front, sideMat])
    plate.position.z = plateDepth / 2
    plate.layers.set(LIGHT_LAYER)
    plate.receiveShadow = true
    this.group.add(plate)
    this.disposables.push(plateGeo, front, sideMat)

    // biseles: anillo saliente que da sombra y relieve a cada reloj
    const bezelMat = lit(new MeshStandardMaterial({ color: new Color('#2a2c30'), roughness: 0.35, metalness: 0.6 }))
    const glassMat = lit(new MeshStandardMaterial({ color: new Color('#0b0c0e'), roughness: 0.5, side: DoubleSide }))
    this.disposables.push(bezelMat, glassMat)
    const toLocal = (x: number, y: number) => new Vector3(x - w / 2, h / 2 - y, plateDepth)
    for (const g of this.gauges) {
      const r = g.d / 2
      const tube = new CylinderGeometry(r * 1.02, r * 1.02, 0.007, 40, 1, true)
      tube.rotateX(Math.PI / 2)
      const lip = new RingGeometry(r * 0.97, r * 1.1, 40)
      this.disposables.push(tube, lip)
      const t = new Mesh(tube, glassMat)
      t.position.copy(toLocal(g.x, g.y)).add(_v.set(0, 0, 0.0035))
      const l = new Mesh(lip, bezelMat)
      l.position.copy(toLocal(g.x, g.y)).add(_v.set(0, 0, 0.007))
      for (const o of [t, l]) {
        o.layers.set(LIGHT_LAYER)
        o.castShadow = true
        o.receiveShadow = true
        this.group.add(o)
      }
    }
    // marco de la pantalla EFIS
    const e = this.efis
    const bars: [number, number, number, number][] = [
      [e.x + e.w / 2, e.y - 0.002, e.w + 0.008, 0.004],
      [e.x + e.w / 2, e.y + e.h + 0.002, e.w + 0.008, 0.004],
      [e.x - 0.002, e.y + e.h / 2, 0.004, e.h + 0.008],
      [e.x + e.w + 0.002, e.y + e.h / 2, 0.004, e.h + 0.008],
    ]
    for (const [x, y, bw, bh] of bars) {
      const g = new BoxGeometry(bw, bh, 0.005)
      this.disposables.push(g)
      const b = new Mesh(g, bezelMat)
      b.position.copy(toLocal(x, y)).add(_v.set(0, 0, 0.0025))
      b.layers.set(LIGHT_LAYER)
      b.castShadow = true
      this.group.add(b)
    }
  }

  private paintBackground(w: number, h: number): HTMLCanvasElement {
    const c = document.createElement('canvas')
    c.width = this.canvas.width
    c.height = this.canvas.height
    const g = c.getContext('2d')!
    const s = this.s
    // fibra de carbono mate
    g.fillStyle = '#16171a'
    g.fillRect(0, 0, c.width, c.height)
    const cell = Math.max(4, Math.round(0.004 * s))
    for (let y = 0; y < c.height; y += cell) {
      for (let x = 0; x < c.width; x += cell) {
        const odd = ((x / cell) | 0) + ((y / cell) | 0)
        g.fillStyle = odd % 2 ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.05)'
        g.fillRect(x, y, cell, cell)
      }
    }
    // degradado de luz (más luz arriba)
    const lg = g.createLinearGradient(0, 0, 0, c.height)
    lg.addColorStop(0, 'rgba(255,255,255,0.06)')
    lg.addColorStop(1, 'rgba(0,0,0,0.25)')
    g.fillStyle = lg
    g.fillRect(0, 0, c.width, c.height)
    // tornillos de las esquinas y de los relojes
    const screw = (x: number, y: number, r: number) => {
      const rg = g.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r)
      rg.addColorStop(0, '#9aa0a6')
      rg.addColorStop(1, '#3a3d42')
      g.fillStyle = rg
      g.beginPath()
      g.arc(x, y, r, 0, TAU)
      g.fill()
      g.strokeStyle = 'rgba(0,0,0,0.6)'
      g.lineWidth = r * 0.3
      g.beginPath()
      g.moveTo(x - r * 0.6, y - r * 0.2)
      g.lineTo(x + r * 0.6, y + r * 0.2)
      g.stroke()
    }
    const sr = 0.0022 * s
    const e = 0.006 * s
    screw(e, e, sr)
    screw(c.width - e, e, sr)
    screw(e, c.height - e, sr)
    screw(c.width - e, c.height - e, sr)
    for (const gs of this.gauges) {
      const r = (gs.d / 2) * s * 1.18
      for (const a of [-0.78, 0.78, Math.PI - 0.78, Math.PI + 0.78]) screw(gs.x * s + Math.cos(a) * r, gs.y * s + Math.sin(a) * r, sr * 0.75)
    }
    // rótulos
    g.fillStyle = 'rgba(235,235,235,0.55)'
    g.font = `600 ${Math.round(0.0052 * s)}px Inter, system-ui, sans-serif`
    g.textAlign = 'center'
    g.fillText(t('ck.placard'), (w / 2) * s, (h - 0.004) * s)
    return c
  }

  update(dt: number, ac: CockpitAircraft, painter: Hud, d: HudData): void {
    this.acc += dt
    this.blink += dt
    if (this.acc < 1 / 20) return
    this.acc = 0
    const c = this.ctx
    const s = this.s
    c.setTransform(1, 0, 0, 1, 0, 0)
    c.drawImage(this.bg, 0, 0)
    for (const g of this.gauges) painter.drawGauge(c, g.kind, g.x * s, g.y * s, g.d * s, d)
    this.drawEfis(c, ac, d)
    this.drawAnnunciators(c, d)
    this.tex.needsUpdate = true
  }

  private drawEfis(c: CanvasRenderingContext2D, ac: CockpitAircraft, d: HudData): void {
    const s = this.s
    const x = this.efis.x * s
    const y = this.efis.y * s
    const w = this.efis.w * s
    const h = this.efis.h * s
    // actitud
    const fwd = _v.set(1, 0, 0).applyQuaternion(ac.quat)
    const rgt = _v2.set(0, 0, 1).applyQuaternion(ac.quat)
    const upv = _v3.set(0, 1, 0).applyQuaternion(ac.quat)
    const pitch = Math.asin(Math.max(-1, Math.min(1, fwd.y)))
    const roll = Math.atan2(-rgt.y, upv.y)
    const cx = x + w / 2
    const cy = y + h * 0.46
    const ppd = h / 50 // píxeles por grado
    c.save()
    c.beginPath()
    c.rect(x, y, w, h)
    c.clip()
    c.translate(cx, cy)
    c.rotate(-roll)
    c.translate(0, (pitch / DEG) * ppd)
    const big = w * 2
    const sky = c.createLinearGradient(0, -big, 0, 0)
    sky.addColorStop(0, '#0c3d8a')
    sky.addColorStop(1, '#3f8fe0')
    c.fillStyle = sky
    c.fillRect(-big, -big, big * 2, big)
    const gnd = c.createLinearGradient(0, 0, 0, big)
    gnd.addColorStop(0, '#8a5a2b')
    gnd.addColorStop(1, '#3f2810')
    c.fillStyle = gnd
    c.fillRect(-big, 0, big * 2, big)
    c.strokeStyle = '#fff'
    c.lineWidth = Math.max(1, h * 0.012)
    c.beginPath()
    c.moveTo(-big, 0)
    c.lineTo(big, 0)
    c.stroke()
    c.fillStyle = '#fff'
    c.font = `600 ${h * 0.055}px Inter, system-ui, sans-serif`
    c.textAlign = 'left'
    c.textBaseline = 'middle'
    for (let p = -30; p <= 30; p += 5) {
      if (p === 0) continue
      const yy = -p * ppd
      const half = p % 10 === 0 ? w * 0.13 : w * 0.06
      c.beginPath()
      c.moveTo(-half, yy)
      c.lineTo(half, yy)
      c.stroke()
      if (p % 10 === 0) c.fillText(`${Math.abs(p)}`, half + w * 0.015, yy)
    }
    c.restore()
    // escala de alabeo
    c.save()
    c.translate(cx, cy)
    c.strokeStyle = '#fff'
    c.fillStyle = '#fff'
    c.lineWidth = Math.max(1, h * 0.01)
    const rr = h * 0.4
    c.beginPath()
    c.arc(0, 0, rr, -Math.PI / 2 - 60 * DEG, -Math.PI / 2 + 60 * DEG)
    c.stroke()
    for (const a of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) {
      const ang = -Math.PI / 2 + a * DEG
      const l = Math.abs(a) % 30 === 0 ? h * 0.06 : h * 0.035
      c.beginPath()
      c.moveTo(Math.cos(ang) * rr, Math.sin(ang) * rr)
      c.lineTo(Math.cos(ang) * (rr + l), Math.sin(ang) * (rr + l))
      c.stroke()
    }
    c.beginPath()
    c.moveTo(0, -rr)
    c.lineTo(-h * 0.03, -rr - h * 0.05)
    c.lineTo(h * 0.03, -rr - h * 0.05)
    c.closePath()
    c.fill()
    // indicador de alabeo (gira con el horizonte)
    c.rotate(-roll)
    c.fillStyle = '#ffd23a'
    c.beginPath()
    c.moveTo(0, -rr + 1)
    c.lineTo(-h * 0.03, -rr + h * 0.055)
    c.lineTo(h * 0.03, -rr + h * 0.055)
    c.closePath()
    c.fill()
    c.restore()
    // avión fijo
    c.save()
    c.translate(cx, cy)
    c.fillStyle = '#ffd23a'
    c.strokeStyle = '#000'
    c.lineWidth = Math.max(1, h * 0.006)
    const bw = w * 0.16
    const bt = h * 0.025
    for (const sgn of [-1, 1]) {
      c.beginPath()
      c.rect(sgn > 0 ? w * 0.05 : -w * 0.05 - bw, -bt / 2, bw, bt)
      c.fill()
      c.stroke()
    }
    c.beginPath()
    c.arc(0, 0, bt * 0.8, 0, TAU)
    c.fill()
    c.stroke()
    c.restore()
    // bola de derrape
    const tw = w * 0.36
    const th = h * 0.075
    const tx = cx - tw / 2
    const ty = y + h - th - h * 0.03
    c.fillStyle = 'rgba(0,0,0,0.55)'
    roundRect(c, tx, ty, tw, th, th / 2)
    c.fill()
    c.strokeStyle = 'rgba(255,255,255,0.8)'
    c.lineWidth = Math.max(1, h * 0.006)
    c.beginPath()
    c.moveTo(cx - th * 0.62, ty)
    c.lineTo(cx - th * 0.62, ty + th)
    c.moveTo(cx + th * 0.62, ty)
    c.lineTo(cx + th * 0.62, ty + th)
    c.stroke()
    c.fillStyle = '#f2f2f2'
    c.beginPath()
    c.arc(cx + d.slip * (tw / 2 - th / 2), ty + th / 2, th * 0.42, 0, TAU)
    c.fill()
    // datos
    c.fillStyle = 'rgba(0,0,0,0.5)'
    c.fillRect(x, y, w, h * 0.12)
    c.fillStyle = '#fff'
    c.font = `600 ${h * 0.075}px Inter, system-ui, sans-serif`
    c.textBaseline = 'middle'
    c.textAlign = 'left'
    c.fillText(`G ${d.g.toFixed(1)}`, x + w * 0.03, y + h * 0.06)
    c.textAlign = 'center'
    c.fillText(`GS ${Math.round(d.gsKmh)}`, x + w * 0.45, y + h * 0.06)
    c.textAlign = 'right'
    c.fillStyle = '#7fd3ff'
    c.fillText(`${String(Math.round(d.windFrom)).padStart(3, '0')}°/${Math.round(d.windKt)}kt`, x + w * 0.97, y + h * 0.06)
    // reflejo del cristal
    const gl = c.createLinearGradient(x, y, x + w, y + h)
    gl.addColorStop(0, 'rgba(255,255,255,0.10)')
    gl.addColorStop(0.45, 'rgba(255,255,255,0.0)')
    c.fillStyle = gl
    c.fillRect(x, y, w, h)
  }

  private drawAnnunciators(c: CanvasRenderingContext2D, d: HudData): void {
    const s = this.s
    const x = this.ann.x * s
    const y = this.ann.y * s
    const w = this.ann.w * s
    const h = this.ann.h * s
    const on = this.blink % 0.6 < 0.35
    const lowRotor = !d.onGround && d.rotorRpm < 280 * (d.rpmScale ?? 1)
    const items: [string, string | null][] = [
      [t('ck.prerot'), d.prerot ? '#3ddc6a' : null],
      [t('ck.rotBrake'), d.rotorBrake ? '#ffb23a' : null],
      [t('ck.brake'), d.parkBrake ? '#ffb23a' : null],
      [t('ck.rotor'), lowRotor && on ? '#ff3b30' : null],
      [t('ck.engine'), !d.engineOn ? '#ff3b30' : null],
    ]
    const gap = w * 0.02
    const bw = (w - gap * (items.length - 1)) / items.length
    c.font = `700 ${h * 0.36}px Inter, system-ui, sans-serif`
    c.textAlign = 'center'
    c.textBaseline = 'middle'
    items.forEach(([label, col], i) => {
      const bx = x + i * (bw + gap)
      roundRect(c, bx, y, bw, h, h * 0.15)
      c.fillStyle = col ?? '#202226'
      c.fill()
      c.strokeStyle = 'rgba(0,0,0,0.8)'
      c.lineWidth = 1
      c.stroke()
      c.fillStyle = col ? '#111' : 'rgba(200,200,200,0.35)'
      c.fillText(label, bx + bw / 2, y + h / 2 + 1)
    })
  }

  dispose(): void {
    this.group.removeFromParent()
    for (const d of this.disposables) d.dispose()
  }
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
