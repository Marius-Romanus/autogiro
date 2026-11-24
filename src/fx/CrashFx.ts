// Efectos del accidente sobre lo que se golpea:
//  - polvo (partículas que crecen, se frenan y derivan con el viento),
//  - terrones de tierra (balísticos, se quedan en el suelo),
//  - chispas (metal contra superficies duras),
//  - surcos en el suelo y desconchones en paredes (calcas sobre la superficie),
//  - cascotes y cristales (los simula Rapier; aquí solo se dibujan),
//  - bola de fuego, humo negro y fuego que sigue ardiendo si revienta el depósito.
//
// Polvo y calcas se pintan como albedo (alfa del búfer intacto: la atmósfera los
// ilumina en posproceso igual que al terreno); terrones y cascotes son sólidos
// iluminados como el aparato (alfa 0); las chispas emiten luz propia.

import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  CustomBlending,
  AddEquation,
  DoubleSide,
  DstAlphaFactor,
  MaxEquation,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  SrcAlphaFactor,
  Vector3,
  ZeroFactor,
  type Camera,
  type Material,
} from 'three'
import { keepAlpha, LIGHT_LAYER } from '../render/Graphics.ts'
import type { Chunk } from '../sim/wreck/Wreck.ts'
import { rockGeometry, shardGeometry, ShapeSet, twigGeometry } from './debrisShapes.ts'

const _v = new Vector3()
const _v2 = new Vector3()
const _q = new Quaternion()
const _m = new Matrix4()
const _s = new Vector3()
const _c = new Color()
const UP = new Vector3(0, 1, 0)

/** Material sólido iluminado igual que el aparato (alfa 0 = ya iluminado). */
function litMaterial(m: MeshStandardMaterial): MeshStandardMaterial {
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <dithering_fragment>', '#include <dithering_fragment>\n\tgl_FragColor.a = 0.0;')
  }
  m.customProgramCacheKey = () => 'lit-alpha0'
  return m
}

// -----------------------------------------------------------------------------
// Partículas tipo billboard (instanciadas)
// -----------------------------------------------------------------------------
class Billboards {
  readonly mesh: Mesh
  /** segunda pasada (polvo sobre píxeles ya iluminados) */
  mesh2: Mesh | null = null
  private readonly geo: InstancedBufferGeometry
  private readonly pos: Float32Array
  private readonly col: Float32Array
  private readonly sr: Float32Array
  private n = 0
  private readonly p: Array<{ x: Vector3; v: Vector3; age: number; life: number; s0: number; s1: number; rot: number; spin: number; a: number; c: Color; drag: number; rise: number }> = []

  readonly max: number

  constructor(max: number, material: Material) {
    this.max = max
    const base = new PlaneGeometry(1, 1)
    const g = new InstancedBufferGeometry()
    g.index = base.index
    g.setAttribute('position', base.getAttribute('position'))
    g.setAttribute('uv', base.getAttribute('uv'))
    this.pos = new Float32Array(max * 3)
    this.col = new Float32Array(max * 4)
    this.sr = new Float32Array(max * 2)
    g.setAttribute('iPos', new InstancedBufferAttribute(this.pos, 3))
    g.setAttribute('iCol', new InstancedBufferAttribute(this.col, 4))
    g.setAttribute('iSizeRot', new InstancedBufferAttribute(this.sr, 2))
    g.instanceCount = 0
    this.geo = g
    this.mesh = new Mesh(g, material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 4
  }

  /** Añade una segunda pasada con otro material sobre la misma geometría. */
  withSecondPass(material: Material): Mesh {
    this.mesh2 = new Mesh(this.geo, material)
    this.mesh2.frustumCulled = false
    this.mesh2.renderOrder = 5
    return this.mesh2
  }

  add(x: Vector3, v: Vector3, life: number, s0: number, s1: number, alpha: number, color: Color, drag = 1.5, rise = 0): void {
    if (this.p.length >= this.max) this.p.shift()
    this.p.push({ x: x.clone(), v: v.clone(), age: 0, life, s0, s1, rot: Math.random() * 6.28, spin: (Math.random() - 0.5) * 0.6, a: alpha, c: color.clone(), drag, rise })
  }

  update(dt: number, wind: Vector3, gravity: number): void {
    let n = 0
    for (let i = this.p.length - 1; i >= 0; i--) {
      const q = this.p[i]
      q.age += dt
      if (q.age >= q.life) {
        this.p.splice(i, 1)
        continue
      }
    }
    for (const q of this.p) {
      // arrastre hacia el viento + empuje térmico / gravedad
      const k = Math.min(1, q.drag * dt)
      q.v.x += (wind.x - q.v.x) * k
      q.v.z += (wind.z - q.v.z) * k
      q.v.y += (wind.y + q.rise - q.v.y) * k - gravity * dt
      q.x.addScaledVector(q.v, dt)
      q.rot += q.spin * dt
      const t = q.age / q.life
      const size = q.s0 + (q.s1 - q.s0) * (1 - (1 - t) * (1 - t))
      const fadeIn = Math.min(1, q.age / 0.12)
      const alpha = q.a * fadeIn * (1 - t) * (1 - t)
      this.pos[n * 3] = q.x.x
      this.pos[n * 3 + 1] = q.x.y
      this.pos[n * 3 + 2] = q.x.z
      this.col[n * 4] = q.c.r
      this.col[n * 4 + 1] = q.c.g
      this.col[n * 4 + 2] = q.c.b
      this.col[n * 4 + 3] = alpha
      this.sr[n * 2] = size
      this.sr[n * 2 + 1] = q.rot
      n++
    }
    this.n = n
    this.geo.instanceCount = n
    for (const name of ['iPos', 'iCol', 'iSizeRot']) {
      const a = this.geo.getAttribute(name) as InstancedBufferAttribute
      a.needsUpdate = true
      a.clearUpdateRanges()
      a.addUpdateRange(0, n * a.itemSize)
    }
  }

  get count(): number {
    return this.n
  }

  clear(): void {
    this.p.length = 0
    this.geo.instanceCount = 0
  }
}

// (también los usa la fumigación: SprayFx.ts)
export const BILLBOARD_VS = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec3 iPos;
  attribute vec4 iCol;
  attribute vec2 iSizeRot;
  varying vec2 vUv;
  varying vec4 vCol;
  void main() {
    vUv = uv;
    vCol = iCol;
    vec4 mv = viewMatrix * vec4(iPos, 1.0);
    float c = cos(iSizeRot.y);
    float s = sin(iSizeRot.y);
    mv.xy += mat2(c, s, -s, c) * position.xy * iSizeRot.x;
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }
`
export const BILLBOARD_FS = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D map;
  uniform float emissive;
  uniform vec3 light;
  uniform float premultiply;
  varying vec2 vUv;
  varying vec4 vCol;
  void main() {
    #include <logdepthbuf_fragment>
    vec4 t = texture2D(map, vUv);
    float a = t.a * vCol.a;
    if (a < 0.004) discard;
    vec3 c = vCol.rgb * mix(1.0, t.r, emissive) * light;
    gl_FragColor = vec4(c * mix(1.0, a, premultiply), a);
  }
`

export function softTexture(size: number, kind: 'dust' | 'spark'): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')!
  const h = size / 2
  if (kind === 'spark') {
    const rg = g.createRadialGradient(h, h, 0, h, h, h)
    rg.addColorStop(0, 'rgba(255,255,255,1)')
    rg.addColorStop(0.25, 'rgba(255,255,255,0.8)')
    rg.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = rg
    g.fillRect(0, 0, size, size)
  } else {
    // nube irregular: varios lóbulos suaves
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2
      const r = Math.random() * h * 0.45
      const x = h + Math.cos(a) * r
      const y = h + Math.sin(a) * r
      const rad = h * (0.35 + Math.random() * 0.3)
      const rg = g.createRadialGradient(x, y, 0, x, y, rad)
      rg.addColorStop(0, 'rgba(255,255,255,0.22)')
      rg.addColorStop(1, 'rgba(255,255,255,0)')
      g.fillStyle = rg
      g.fillRect(0, 0, size, size)
    }
  }
  return new CanvasTexture(c)
}

/** Surco / desconchón: mancha alargada de bordes irregulares. */
function scarTexture(): CanvasTexture {
  const w = 256
  const h = 128
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')!
  const img = g.createImageData(w, h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // v: a lo largo del surco (eje X de la calca) · u: a lo ancho
      const v = (x / w) * 2 - 1
      const u = (y / h) * 2 - 1
      // borde irregular
      const edge = 0.72 + 0.18 * Math.sin(v * 9 + Math.sin(v * 23) * 1.5) + 0.08 * Math.sin(v * 41)
      const ends = 1 - Math.pow(Math.abs(v), 6)
      let a = Math.max(0, Math.min(1, (edge - Math.abs(u)) * 6)) * ends
      // estrías a lo largo del surco
      const groove = 0.75 + 0.25 * Math.sin(u * 22 + Math.sin(v * 3))
      const n = Math.random()
      a *= 0.65 + 0.35 * n
      const k = (y * w + x) * 4
      const l = Math.round(255 * groove * (0.8 + 0.2 * n))
      img.data[k] = l
      img.data[k + 1] = l
      img.data[k + 2] = l
      img.data[k + 3] = Math.round(255 * a)
    }
  }
  g.putImageData(img, 0, 0)
  return new CanvasTexture(c)
}

interface Clod {
  x: Vector3
  v: Vector3
  q: Quaternion
  w: Vector3
  size: number
  color: Color
  rest: boolean
  ground: number
  age: number
  /** frenado del aire (hojas: mucho) */
  drag?: number
  /** forma (índice en las variantes de terrones: ver CLOD_*) y proporciones */
  shape: number
  scale: Vector3
  /** altura del centro sobre el suelo al quedar apoyado (× size) */
  restH: number
  leaf?: boolean
}

// variantes de los trozos sueltos: piedras/terrones, hojas, ramitas
const CLOD_ROCKS = 5
const CLOD_LEAF = CLOD_ROCKS
const CLOD_TWIG = CLOD_ROCKS + 2
const rockVariant = () => Math.floor(Math.random() * CLOD_ROCKS)


interface Scar {
  mesh: Mesh
  start: Vector3
  end: Vector3
  n: Vector3
  width: number
  key: string
  t: number
}

export class CrashFx {
  readonly root = new Group()
  private readonly dust: Billboards
  private readonly sparks: Billboards
  private readonly flames: Billboards
  /** fracciones pendientes de emitir del fuego continuo */
  private flameAcc = 0
  private smokeAcc = 0
  private readonly clods: Clod[] = []
  private readonly clodMesh: ShapeSet
  private readonly chunkMesh: ShapeSet
  private readonly glassMesh: ShapeSet
  /** forma de cada cascote de Rapier (fija mientras exista) */
  private readonly chunkShape = new WeakMap<Chunk, number>()
  private readonly scarMat: MeshBasicMaterial
  private readonly scarGeo: PlaneGeometry
  private readonly scars: Scar[] = []
  private readonly maxClods = 320
  private readonly maxScars = 70
  readonly wind = new Vector3()
  /** radiancia por unidad de albedo (sol + cielo), para el polvo delante de objetos ya iluminados */
  readonly dustLight = new Vector3(0.5, 0.5, 0.5)

  constructor() {
    this.root.name = 'crash-fx'
    // Polvo en dos pasadas, según lo que haya detrás (alfa del búfer):
    //  1) "encima" con su albedo donde el fondo lo ilumina luego la atmósfera
    //     (alfa 1); donde ya está iluminado (aparato, piezas: alfa 0) solo atenúa;
    //  2) máximo con el color ya iluminado (sol + cielo, `light`): sobre lo ya
    //     iluminado aproxima la composición "encima" sin acumular, y sobre el
    //     terreno no cambia nada (el polvo iluminado es más oscuro que su albedo).
    // En ambas el alfa del búfer no cambia.
    const dustTex = softTexture(128, 'dust')
    const mkDust = (lit: boolean) => {
      const m = new ShaderMaterial({
        uniforms: { map: { value: dustTex }, emissive: { value: 0 }, light: { value: lit ? this.dustLight : new Vector3(1, 1, 1) }, premultiply: { value: 1 } },
        vertexShader: BILLBOARD_VS,
        fragmentShader: BILLBOARD_FS,
        transparent: true,
        depthWrite: false,
      })
      m.blending = CustomBlending
      m.blendEquation = lit ? MaxEquation : AddEquation
      m.blendSrc = DstAlphaFactor
      m.blendDst = OneMinusSrcAlphaFactor
      m.blendEquationAlpha = AddEquation
      m.blendSrcAlpha = ZeroFactor
      m.blendDstAlpha = OneFactor
      return m
    }
    this.dust = new Billboards(700, mkDust(false))
    const dust2 = this.dust.withSecondPass(mkDust(true))
    const sparkMat = new ShaderMaterial({
      uniforms: { map: { value: softTexture(32, 'spark') }, emissive: { value: 1 }, light: { value: new Vector3(1, 1, 1) }, premultiply: { value: 0 } },
      vertexShader: BILLBOARD_VS,
      fragmentShader: BILLBOARD_FS,
      transparent: true,
      depthWrite: false,
    })
    // aditivas; el alfa del búfer no se toca
    sparkMat.blending = CustomBlending
    sparkMat.blendSrc = SrcAlphaFactor
    sparkMat.blendDst = OneFactor
    sparkMat.blendSrcAlpha = ZeroFactor
    sparkMat.blendDstAlpha = OneFactor
    this.sparks = new Billboards(300, sparkMat)
    // llamas: como las chispas (luz propia, aditivas) pero con la textura de nube
    const flameMat = sparkMat.clone()
    flameMat.uniforms = { map: { value: softTexture(64, 'dust') }, emissive: { value: 1 }, light: { value: new Vector3(1, 1, 1) }, premultiply: { value: 0 } }
    this.flames = new Billboards(500, flameMat)
    this.flames.mesh.renderOrder = 6
    this.root.add(this.dust.mesh, dust2, this.sparks.mesh, this.flames.mesh)

    // trozos sueltos con formas irregulares (caras planas: se ven las aristas de rotura)
    const mk = (geos: BufferGeometry[], max: number, mat: MeshStandardMaterial) =>
      new ShapeSet(geos, litMaterial(mat), max, (m) => {
        m.frustumCulled = false
        m.castShadow = true
        m.receiveShadow = true
        m.layers.set(LIGHT_LAYER)
        m.instanceColor = new InstancedBufferAttribute(new Float32Array(max * 3), 3)
        this.root.add(m)
      })
    const rocks = Array.from({ length: CLOD_ROCKS }, (_, i) => rockGeometry(101 + i * 7))
    this.clodMesh = mk(
      [...rocks, shardGeometry(11, true), shardGeometry(12, true), twigGeometry(21), twigGeometry(22)],
      this.maxClods,
      new MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, flatShading: true }),
    )
    // cascotes: piedras y alguna lasca (teja, revoque)
    this.chunkMesh = mk([...rocks, shardGeometry(31), shardGeometry(32)], 220, new MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0, flatShading: true }))
    this.glassMesh = mk(
      [0, 1, 2, 3].map((i) => shardGeometry(41 + i)),
      220,
      new MeshStandardMaterial({ color: 0xffffff, roughness: 0.06, metalness: 0.1, envMapIntensity: 1, flatShading: true }),
    )

    this.scarMat = keepAlpha(
      new MeshBasicMaterial({ map: scarTexture(), color: 0xffffff, transparent: true, depthWrite: false, side: DoubleSide, vertexColors: false }),
    )
    this.scarGeo = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2) // normal +Y, largo en X
    void BufferAttribute
  }

  // ---------------------------------------------------------------------------
  // Emisores
  // ---------------------------------------------------------------------------
  /** Nube de polvo en p. `amount` 0..1+ (fuerza del golpe). */
  dustBurst(p: Vector3, n: Vector3, amount: number, color: Color, carry: Vector3): void {
    const count = Math.min(14, Math.round(2 + amount * 7))
    for (let i = 0; i < count; i++) {
      const v = _v
        .copy(n)
        .multiplyScalar(0.6 + Math.random() * 2.2 * Math.min(2, amount))
        .addScaledVector(carry, 0.25 + Math.random() * 0.35)
        .add(_v2.set(Math.random() - 0.5, Math.random() * 0.6, Math.random() - 0.5).multiplyScalar(2.5 * Math.min(2, 0.4 + amount)))
      _c.copy(color).multiplyScalar(0.85 + Math.random() * 0.3)
      const s0 = 0.5 + Math.random() * 0.8
      this.dust.add(
        _v2.copy(p).addScaledVector(n, 0.2).add(new Vector3((Math.random() - 0.5) * 0.6, 0, (Math.random() - 0.5) * 0.6)),
        v,
        2.5 + Math.random() * 4.5 * Math.min(1.5, 0.5 + amount),
        s0,
        s0 + 2.5 + Math.random() * 3.5 * Math.min(1.6, 0.4 + amount),
        0.55 + 0.35 * Math.min(1, amount),
        _c,
        1.2,
        0.25,
      )
    }
  }

  /** Terrones de tierra lanzados en dirección `dir` a `speed` m/s (p. ej. una pala que muerde el suelo). */
  dirt(p: Vector3, n: Vector3, dir: Vector3, speed: number, count: number, groundY: number): void {
    for (let i = 0; i < count; i++) {
      if (this.clods.length >= this.maxClods) this.clods.shift()
      const v = new Vector3()
        .copy(dir)
        .multiplyScalar(Math.min(28, speed) * (0.25 + Math.random() * 0.6))
        .addScaledVector(n, 1.5 + Math.random() * Math.min(8, 0.25 * speed + 2))
        .add(new Vector3(Math.random() - 0.5, Math.random() * 0.5, Math.random() - 0.5).multiplyScalar(2 + 0.15 * speed))
      const shade = 0.55 + Math.random() * 0.5
      const grass = Math.random() < 0.25
      this.clods.push({
        x: p.clone().addScaledVector(n, 0.08),
        v,
        q: new Quaternion().setFromAxisAngle(new Vector3(Math.random(), Math.random(), Math.random()).normalize(), Math.random() * 6),
        w: new Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(18),
        size: 0.03 + Math.random() * Math.random() * 0.14,
        color: (grass ? new Color(0x4b5a2a) : new Color(0x6b5440)).multiplyScalar(shade),
        rest: false,
        ground: groundY,
        age: 0,
        shape: rockVariant(),
        scale: new Vector3(0.8 + Math.random() * 0.5, 0.55 + Math.random() * 0.45, 0.8 + Math.random() * 0.5),
        restH: 0.3,
      })
    }
  }

  /** Hojas y ramitas arrancadas al atravesar la copa de un árbol. */
  leaves(p: Vector3, dir: Vector3, speed: number, count: number): void {
    for (let i = 0; i < count; i++) {
      if (this.clods.length >= this.maxClods) this.clods.shift()
      const v = new Vector3()
        .copy(dir)
        .multiplyScalar(speed * (0.1 + Math.random() * 0.3))
        .add(new Vector3(Math.random() - 0.5, Math.random() * 0.6, Math.random() - 0.5).multiplyScalar(4))
      const shade = 0.5 + Math.random() * 0.6
      const twig = Math.random() < 0.3
      this.clods.push({
        x: p.clone().add(new Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)),
        v,
        q: new Quaternion().setFromAxisAngle(new Vector3(Math.random(), Math.random(), Math.random()).normalize(), Math.random() * 6),
        w: new Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(10),
        size: twig ? 0.04 + Math.random() * 0.12 : 0.03 + Math.random() * 0.05,
        color: (twig ? new Color(0x5a4630) : new Color(0x3e5228)).multiplyScalar(shade),
        rest: false,
        ground: p.y - 15,
        age: 0,
        drag: twig ? 0.3 : 2.2,
        // ramita: larga y fina; hoja: plana
        shape: twig ? CLOD_TWIG + (Math.random() < 0.5 ? 0 : 1) : CLOD_LEAF + (Math.random() < 0.5 ? 0 : 1),
        scale: twig ? new Vector3(0.12, 1, 0.12) : new Vector3(1, 0.06, 0.55 + Math.random() * 0.2),
        restH: twig ? 0.06 : 0.03,
        leaf: !twig,
      })
    }
    this.dustBurst(p, new Vector3(0, 0.3, 0), 0.15, new Color(0x56603e), dir.clone().multiplyScalar(speed * 0.2))
  }

  sparksAt(p: Vector3, dir: Vector3, count: number): void {
    for (let i = 0; i < count; i++) {
      const v = _v
        .copy(dir)
        .multiplyScalar(2 + Math.random() * 8)
        .add(_v2.set(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).multiplyScalar(5))
      this.sparks.add(p, v, 0.15 + Math.random() * 0.35, 0.05 + Math.random() * 0.05, 0.02, 1, _c.setRGB(6, 3.2, 1.1), 0.4, -6)
    }
  }

  /** Bola de fuego del depósito que revienta en `p`, con humo negro y chispas. */
  explode(p: Vector3): void {
    for (let i = 0; i < 70; i++) {
      const dir = new Vector3(Math.random() - 0.5, Math.random() * 0.8 - 0.15, Math.random() - 0.5).normalize()
      const v = _v.copy(dir).multiplyScalar(3 + Math.random() * 9)
      v.y += 2
      const k = Math.random()
      _c.setRGB(9 - 3 * k, 4.5 - 2.6 * k, 1.4 - 1.1 * k)
      const s0 = 0.8 + Math.random() * 1.2
      this.flames.add(_v2.copy(p).addScaledVector(dir, Math.random() * 0.8), v, 0.6 + Math.random() * 0.9, s0, s0 + 3 + Math.random() * 4, 1, _c, 2.8, 5)
    }
    for (let i = 0; i < 30; i++) {
      const v = _v.set(Math.random() - 0.5, 0.4 + Math.random(), Math.random() - 0.5).multiplyScalar(4)
      const sh = 0.05 + Math.random() * 0.06
      _c.setRGB(sh, sh * 0.95, sh * 0.9)
      const s0 = 1.5 + Math.random() * 2
      this.dust.add(_v2.copy(p).add(_v.clone().multiplyScalar(0.2)), v, 9 + Math.random() * 8, s0, s0 + 9 + Math.random() * 8, 0.9, _c, 0.7, 3.5)
    }
    for (let i = 0; i < 3; i++) this.sparksAt(p, _v.set(Math.random() - 0.5, 1, Math.random() - 0.5).normalize(), 18)
  }

  /**
   * Fuego que sigue ardiendo en `p` (intensidad 0..1): llamas que suben y una
   * columna de humo. `carry`: velocidad de los restos (las llamas van con ellos).
   */
  burn(p: Vector3, intensity: number, dt: number, carry: Vector3): void {
    if (intensity <= 0) return
    this.flameAcc += dt * 60 * intensity
    for (; this.flameAcc >= 1; this.flameAcc--) {
      const off = _v2.set((Math.random() - 0.5) * 1.6, Math.random() * 0.3, (Math.random() - 0.5) * 1.6).multiplyScalar(0.5 + 0.5 * intensity)
      const v = _v.set((Math.random() - 0.5) * 0.8, 1.5 + Math.random() * 2, (Math.random() - 0.5) * 0.8).addScaledVector(carry, 0.8)
      const k = Math.random()
      _c.setRGB(6 - 2 * k, 2.8 - 1.6 * k, 0.7 - 0.5 * k).multiplyScalar(0.6 + 0.4 * intensity)
      const s0 = 0.5 + Math.random() * 0.9 * (0.3 + intensity)
      this.flames.add(off.add(p), v, 0.45 + Math.random() * 0.6, s0, s0 * (1.5 + Math.random()), 0.9, _c, 1.5, 3.5 + 2.5 * intensity)
    }
    this.smokeAcc += dt * (1.5 + 4 * intensity)
    for (; this.smokeAcc >= 1; this.smokeAcc--) {
      const v = _v.set((Math.random() - 0.5) * 0.6, 1.5 + Math.random() * 1.5, (Math.random() - 0.5) * 0.6)
      const sh = 0.05 + Math.random() * 0.05 + 0.12 * (1 - intensity)
      _c.setRGB(sh, sh * 0.96, sh * 0.92)
      const s0 = 1 + Math.random() * 1.2
      this.dust.add(_v2.copy(p).add(_v.clone().multiplyScalar(0.3)).setY(p.y + 1.2), v, 10 + Math.random() * 8, s0, s0 + 7 + Math.random() * 7 * (0.5 + intensity), 0.55 + 0.3 * intensity, _c, 0.6, 3 + intensity)
    }
  }

  /**
   * Surco en el suelo (o desconchón en una pared) por el que se arrastra una pieza.
   * Si la misma pieza sigue arrastrándose, alarga el surco anterior.
   */
  scar(key: string, p: Vector3, n: Vector3, dir: Vector3, width: number, darkness: number, wall: boolean): void {
    const pos = _v.copy(p).addScaledVector(n, wall ? 0.03 : 0.06)
    const last = this.scars.find((s) => s.key === key)
    if (last && last.end.distanceTo(pos) < Math.max(2.2, width * 4) && last.start.distanceTo(pos) < 18 && last.n.dot(n) > 0.7) {
      if (pos.distanceTo(last.start) > last.end.distanceTo(last.start)) last.end.copy(pos)
      last.width = Math.max(last.width, width)
      last.t = 0
      this.placeScar(last)
      return
    }
    if (last) last.key = '' // deja de extenderse: el siguiente empieza nuevo
    let s: Scar
    if (this.scars.length >= this.maxScars) s = this.scars.shift()!
    else if (this.spare.length) {
      s = this.spare.pop()!
      s.mesh.visible = true
    } else {
      const mesh = new Mesh(this.scarGeo, this.scarMat.clone())
      mesh.matrixAutoUpdate = false
      mesh.renderOrder = 1
      mesh.frustumCulled = false
      this.root.add(mesh)
      s = { mesh, start: new Vector3(), end: new Vector3(), n: new Vector3(), width, key, t: 0 }
    }
    // colores en sRGB (la ortofoto también lo es): tierra removida y rozadura gris
    const tint = wall ? new Color(0x3d3a36) : new Color(0x3a2c1e)
    ;(s.mesh.material as MeshBasicMaterial).color.copy(tint).multiplyScalar(1 - 0.4 * Math.min(1, darkness))
    ;(s.mesh.material as MeshBasicMaterial).opacity = 0.9
    s.key = key
    s.start.copy(pos).addScaledVector(dir, -width * 0.4)
    s.end.copy(pos).addScaledVector(dir, width * 0.4)
    s.n.copy(n)
    s.width = width
    s.t = 0
    this.placeScar(s)
    this.scars.push(s)
  }

  private placeScar(s: Scar): void {
    const len = Math.max(s.width, s.start.distanceTo(s.end))
    const along = _v2.subVectors(s.end, s.start)
    if (along.lengthSq() < 1e-6) along.set(1, 0, 0)
    along.addScaledVector(s.n, -along.dot(s.n)).normalize()
    const side = new Vector3().crossVectors(s.n, along)
    _m.makeBasis(along, s.n, side.negate())
    _q.setFromRotationMatrix(_m)
    const mid = _v.addVectors(s.start, s.end).multiplyScalar(0.5)
    s.mesh.matrix.compose(mid, _q, _s.set(len, 1, s.width))
    s.mesh.matrixWorldNeedsUpdate = true
  }

  // ---------------------------------------------------------------------------
  update(dt: number, camera: Camera, chunks: readonly Chunk[], origin: Vector3, groundAt: (x: number, z: number) => number | null): void {
    void camera
    this.dust.update(dt, this.wind, 0)
    this.sparks.update(dt, _v.set(0, 0, 0), 9.8)
    this.flames.update(dt, this.wind, 0)

    // terrones
    for (let i = this.clods.length - 1; i >= 0; i--) {
      const c = this.clods[i]
      c.age += dt
      if (c.age > 40) {
        this.clods.splice(i, 1)
        continue
      }
      if (c.rest) continue
      c.v.y -= 9.81 * dt
      c.v.multiplyScalar(1 - Math.min(1, (c.drag ?? 0.15) * dt))
      if (c.drag && c.drag > 1) {
        // las hojas caen planeando y con el viento
        c.v.x += (this.wind.x - c.v.x) * Math.min(1, dt * c.drag)
        c.v.z += (this.wind.z - c.v.z) * Math.min(1, dt * c.drag)
        c.v.y = Math.max(c.v.y, -1.6)
      }
      c.x.addScaledVector(c.v, dt)
      c.q.multiply(_q.setFromAxisAngle(_v.copy(c.w).normalize(), c.w.length() * dt))
      const g = groundAt(c.x.x, c.x.z) ?? c.ground
      if (c.x.y < g + c.size * c.restH) {
        c.x.y = g + c.size * c.restH
        if (c.v.y < -1.2 && !c.leaf) {
          c.v.y *= -0.2
          c.v.x *= 0.5
          c.v.z *= 0.5
          c.w.multiplyScalar(0.5)
        } else {
          c.rest = true
          // la hoja se queda tumbada; la ramita, acostada
          if (c.leaf) c.q.setFromAxisAngle(UP, Math.random() * 6.28)
          else if (c.shape >= CLOD_TWIG) c.q.setFromAxisAngle(_v.set(Math.random() - 0.5, 0, Math.random() - 0.5).normalize(), Math.PI / 2)
        }
      }
    }
    this.clodMesh.begin()
    for (const c of this.clods) {
      const f = c.age > 34 ? Math.max(0, 1 - (c.age - 34) / 6) : 1
      _m.compose(c.x, c.q, _s.copy(c.scale).multiplyScalar(c.size * f))
      this.clodMesh.add(c.shape, _m, c.color)
    }
    this.clodMesh.end()

    // cascotes y cristales de Rapier
    this.chunkMesh.begin()
    this.glassMesh.begin()
    for (const ch of chunks) {
      const t = ch.rb.translation()
      const r = ch.rb.rotation()
      _v.set(t.x + origin.x, t.y + origin.y, t.z + origin.z)
      _q.set(r.x, r.y, r.z, r.w)
      _m.compose(_v, _q, ch.size)
      _c.setHex(ch.color)
      const set = ch.glass ? this.glassMesh : this.chunkMesh
      let shape = this.chunkShape.get(ch)
      if (shape === undefined) {
        // cascote: casi siempre piedra; lasca si la pieza es plana
        const flat = Math.min(ch.size.x, ch.size.y, ch.size.z) < 0.45 * Math.max(ch.size.x, ch.size.y, ch.size.z)
        shape = ch.glass ? Math.floor(Math.random() * 4) : flat && Math.random() < 0.6 ? CLOD_ROCKS + Math.floor(Math.random() * 2) : rockVariant()
        this.chunkShape.set(ch, shape)
      }
      set.add(shape, _m, _c)
    }
    this.chunkMesh.end()
    this.glassMesh.end()
    for (const s of this.scars) s.t += dt
  }

  clear(): void {
    this.dust.clear()
    this.sparks.clear()
    this.flames.clear()
    this.flameAcc = this.smokeAcc = 0
    this.clods.length = 0
    this.clodMesh.clear()
    this.chunkMesh.clear()
    this.glassMesh.clear()
    // las calcas se guardan para el siguiente accidente (sin liberar el material:
    // así no se recompila su programa en la GPU)
    for (const s of this.scars) {
      s.mesh.visible = false
      s.key = ''
      this.spare.push(s)
    }
    this.scars.length = 0
  }

  private readonly spare: Scar[] = []

  /** Pone la luz del polvo a partir del sol y del cielo de la escena. */
  setLight(sunIrr: Vector3, skyIrr: Vector3): void {
    // radiancia difusa por unidad de albedo: (E_sol·0,6 + E_cielo)/π
    this.dustLight.copy(sunIrr).multiplyScalar(0.6).add(skyIrr).multiplyScalar(1 / Math.PI)
  }

  /** Mueve todo con el re-centrado del mundo (por si acaso). */
  stats(): string {
    return `polvo ${this.dust.count} · terrones ${this.clods.length} · surcos ${this.scars.length}`
  }
}

export { UP as FX_UP }
