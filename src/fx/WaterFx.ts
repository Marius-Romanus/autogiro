// Efectos del agua: lo que salta y lo que queda en la superficie cuando algo entra en ella.
//
//  - salpicaduras: una corona de gotas que sale hacia arriba y hacia fuera (más alta cuanto más rápido
//    entra) y una nube de agua pulverizada; si entra rasante, la cortina sale hacia delante y a los lados;
//  - rociones mientras algo corre por el agua (flotadores, la góndola que patina, palas que la golpean);
//  - espuma en la superficie: el anillo del golpe, la mancha blanca que deja y la estela detrás de lo que
//    navega, que se abren y se apagan poco a poco;
//  - burbujas que suben mientras algo se hunde;
//  - el soplado del rotor sobre el agua a poca altura: un anillo de agua pulverizada que sale hacia fuera.
//
// Las gotas y la niebla se pintan con los billboards de la fumigación (SprayFx): dos pasadas según lo que
// haya detrás. La espuma es una calca sobre la superficie que se pinta como albedo (alfa del búfer
// intacto): la ilumina la atmósfera como al terreno y, como es clara y no tira a azul, el sombreado del
// agua (render/Water.ts) la deja fuera: queda blanca y mate, sin reflejos.

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
  RepeatWrapping,
  ShaderMaterial,
  SrcAlphaFactor,
  Vector3,
  ZeroFactor,
  type DirectionalLight,
  type LightProbe,
  type Matrix4,
  type Object3D,
} from 'three'
import { OVERLAY_LAYER } from '../render/Graphics.ts'
import type { Autogyro } from '../sim/autogyro.ts'
import type { WetPoint } from '../sim/hydro.ts'
import { BILLBOARD_FS, BILLBOARD_VS } from './CrashFx.ts'

/** gotas y niebla a la vez como mucho */
const MAXP = 9000
/** manchas de espuma a la vez como mucho */
const MAXF = 1800
/** albedo del agua pulverizada y de la espuma (lineal) */
const SPRAY = [0.82, 0.86, 0.9]
const FOAM = [0.78, 0.8, 0.82]

const _v = new Vector3()
const _p = new Vector3()
const _d = new Vector3()
const _q = new Quaternion()

/** Mancha suave: campana gaussiana (las gotas son pequeñas, la niebla grande). */
function softTexture(size: number): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')!
  const h = size / 2
  const rg = g.createRadialGradient(h, h, 0, h, h, h)
  for (let i = 0; i <= 8; i++) {
    const r = i / 8
    rg.addColorStop(r, `rgba(255,255,255,${(Math.exp(-4 * r * r) - Math.exp(-4)).toFixed(3)})`)
  }
  g.fillStyle = rg
  g.fillRect(0, 0, size, size)
  return new CanvasTexture(c)
}

/** Espuma: burbujas de todos los tamaños en grumos, repetible por los bordes (alfa = cobertura). */
function foamTexture(size: number): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')!
  g.clearRect(0, 0, size, size)
  // grumos: zonas donde las burbujas se apiñan
  const clumps = Array.from({ length: 14 }, () => [Math.random() * size, Math.random() * size, size * (0.08 + Math.random() * 0.18)])
  const dot = (x: number, y: number, r: number, a: number) => {
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        g.beginPath()
        g.arc(x + ox, y + oy, r, 0, Math.PI * 2)
        g.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`
        g.fill()
      }
    }
  }
  for (let i = 0; i < 2600; i++) {
    let x = Math.random() * size
    let y = Math.random() * size
    let a = 0.18 + Math.random() * 0.3
    if (Math.random() < 0.7) {
      const [cx, cy, cr] = clumps[(Math.random() * clumps.length) | 0]
      const ang = Math.random() * Math.PI * 2
      const rr = cr * Math.sqrt(Math.random())
      x = cx + Math.cos(ang) * rr
      y = cy + Math.sin(ang) * rr
      a += 0.35
    }
    dot(x, y, 0.6 + Math.random() * Math.random() * 4.5, Math.min(1, a))
  }
  const t = new CanvasTexture(c)
  t.wrapS = t.wrapT = RepeatWrapping
  return t
}

const FOAM_VS = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec4 iPosR;   // centro (mundo) y radio
  attribute vec4 iParam;  // opacidad, hueco del anillo (0 = mancha llena), giro, semilla
  varying vec2 vLocal;
  varying vec2 vUv;
  varying vec2 vParam;
  void main() {
    float c = cos(iParam.z);
    float s = sin(iParam.z);
    vec2 rp = mat2(c, s, -s, c) * position.xy * 2.0 * iPosR.w;
    vec3 wp = vec3(iPosR.x + rp.x, iPosR.y, iPosR.z + rp.y);
    // un pelo por encima del agua (más de lejos: la precisión del búfer de profundidad)
    wp.y += 0.04 + 0.0015 * distance(cameraPosition, wp);
    vLocal = position.xy * 2.0;
    // la textura va a escala fija (≈ 2,5 m por repetición) aunque la mancha crezca
    vUv = rp / 2.5 + iParam.w;
    vParam = iParam.xy;
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
    #include <logdepthbuf_vertex>
  }
`
const FOAM_FS = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D map;
  uniform vec3 color;
  varying vec2 vLocal;
  varying vec2 vUv;
  varying vec2 vParam;
  void main() {
    #include <logdepthbuf_fragment>
    float r = length(vLocal);
    if (r > 1.0) discard;
    // borde deshilachado: la textura se come el contorno
    float f = texture2D(map, vUv).a;
    float edge = smoothstep(1.0, 0.55, r + 0.25 * (1.0 - f));
    float ring = vParam.y;
    float hole = ring > 0.0 ? smoothstep(ring - 0.3, ring + 0.05, r + 0.15 * (0.5 - f)) : 1.0;
    float a = vParam.x * edge * hole * (0.35 + 0.65 * f);
    if (a < 0.01) discard;
    gl_FragColor = vec4(color, a);
  }
`

export class WaterFx {
  readonly root = new Group()
  /** radiancia por unidad de albedo (sol + cielo) para la pasada sobre lo ya iluminado */
  private readonly light = new Vector3(0.5, 0.5, 0.5)
  private readonly lights: { sun: DirectionalLight; sky: LightProbe } | null
  /** sonido de cada chapoteo (fuerza 0..1,6 y punto); lo pone quien tiene el audio */
  sound: ((strength: number, p: Vector3) => void) | null = null

  // --- gotas y niebla (anillo) ---
  private readonly p = new Float32Array(MAXP * 3)
  private readonly v = new Float32Array(MAXP * 3)
  /** superficie del agua bajo cada gota (al caer en ella desaparece) */
  private readonly surf = new Float32Array(MAXP)
  private readonly age = new Float32Array(MAXP).fill(1)
  private readonly life = new Float32Array(MAXP).fill(1)
  private readonly s0 = new Float32Array(MAXP)
  private readonly s1 = new Float32Array(MAXP)
  private readonly rot = new Float32Array(MAXP)
  private readonly a = new Float32Array(MAXP)
  /** 0 gota (cae), 1 niebla (flota y se abre) */
  private readonly kind = new Uint8Array(MAXP)
  private next = 0
  private readonly pgeo: InstancedBufferGeometry
  private readonly iPos = new Float32Array(MAXP * 3)
  private readonly iCol = new Float32Array(MAXP * 4)
  private readonly iSr = new Float32Array(MAXP * 2)

  // --- espuma (anillo) ---
  private readonly fp = new Float32Array(MAXF * 3)
  private readonly fr0 = new Float32Array(MAXF)
  private readonly fr1 = new Float32Array(MAXF)
  private readonly fage = new Float32Array(MAXF).fill(1)
  private readonly flife = new Float32Array(MAXF).fill(1)
  private readonly fa = new Float32Array(MAXF)
  private readonly fring = new Float32Array(MAXF)
  private readonly frot = new Float32Array(MAXF)
  private readonly fseed = new Float32Array(MAXF)
  private fnext = 0
  private readonly fgeo: InstancedBufferGeometry
  private readonly iPosR = new Float32Array(MAXF * 4)
  private readonly iParam = new Float32Array(MAXF * 4)

  /** estelas: último punto donde dejó espuma cada cosa que navega, y cuándo */
  private readonly wakes = new Map<string, { x: number; y: number; z: number; t: number }>()
  private clock = 0
  private readonly floatEnds = new Map<string, { front: WetPoint; back: WetPoint }>()
  /** chapoteos recientes (para juntar los que caen a la vez en el mismo sitio) */
  private readonly recent: Array<{ x: number; z: number; t: number }> = []
  private sprayAcc = 0
  private washAcc = 0
  private bubbleAcc = 0

  constructor(scene: Object3D, lights?: { sun: DirectionalLight; sky: LightProbe }) {
    this.lights = lights ?? null
    this.root.name = 'water-fx'
    const base = new PlaneGeometry(1, 1)

    // gotas y niebla: dos pasadas (albedo donde detrás hay terreno, radiancia donde ya está iluminado)
    const pg = new InstancedBufferGeometry()
    pg.index = base.index
    pg.setAttribute('position', base.getAttribute('position'))
    pg.setAttribute('uv', base.getAttribute('uv'))
    pg.setAttribute('iPos', new InstancedBufferAttribute(this.iPos, 3))
    pg.setAttribute('iCol', new InstancedBufferAttribute(this.iCol, 4))
    pg.setAttribute('iSizeRot', new InstancedBufferAttribute(this.iSr, 2))
    pg.instanceCount = 0
    this.pgeo = pg
    const tex = softTexture(64)
    for (const [i, lit] of [false, true].entries()) {
      const m = new ShaderMaterial({
        uniforms: { map: { value: tex }, emissive: { value: 0 }, light: { value: lit ? this.light : new Vector3(1, 1, 1) }, premultiply: { value: 1 } },
        vertexShader: BILLBOARD_VS,
        fragmentShader: BILLBOARD_FS,
        transparent: true,
        depthWrite: false,
      })
      m.blending = CustomBlending
      m.blendEquation = AddEquation
      m.blendSrc = lit ? OneMinusDstAlphaFactor : DstAlphaFactor
      m.blendDst = lit ? OneFactor : OneMinusSrcAlphaFactor
      m.blendEquationAlpha = AddEquation
      m.blendSrcAlpha = ZeroFactor
      m.blendDstAlpha = OneFactor
      const mesh = new Mesh(pg, m)
      mesh.frustumCulled = false
      mesh.renderOrder = 6 + i
      mesh.layers.set(OVERLAY_LAYER)
      this.root.add(mesh)
    }

    // espuma: calca sobre la superficie, como albedo
    const fg = new InstancedBufferGeometry()
    fg.index = base.index
    fg.setAttribute('position', base.getAttribute('position'))
    fg.setAttribute('iPosR', new InstancedBufferAttribute(this.iPosR, 4))
    fg.setAttribute('iParam', new InstancedBufferAttribute(this.iParam, 4))
    fg.instanceCount = 0
    this.fgeo = fg
    const fm = new ShaderMaterial({
      uniforms: { map: { value: foamTexture(256) }, color: { value: new Vector3(FOAM[0], FOAM[1], FOAM[2]) } },
      vertexShader: FOAM_VS,
      fragmentShader: FOAM_FS,
      transparent: true,
      depthWrite: false,
    })
    fm.blending = CustomBlending
    fm.blendEquation = AddEquation
    fm.blendSrc = SrcAlphaFactor
    fm.blendDst = OneMinusSrcAlphaFactor
    fm.blendEquationAlpha = AddEquation
    fm.blendSrcAlpha = ZeroFactor
    fm.blendDstAlpha = OneFactor
    const foam = new Mesh(fg, fm)
    foam.frustumCulled = false
    foam.renderOrder = 2
    foam.layers.set(OVERLAY_LAYER)
    this.root.add(foam)
    scene.add(this.root)
  }

  // ---------------------------------------------------------------------------
  // Emisores
  // ---------------------------------------------------------------------------
  private add(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number, a: number, kind: 0 | 1, surf: number): void {
    const j = this.next
    this.next = (this.next + 1) % MAXP
    const o = j * 3
    this.p[o] = x
    this.p[o + 1] = y
    this.p[o + 2] = z
    this.v[o] = vx
    this.v[o + 1] = vy
    this.v[o + 2] = vz
    this.surf[j] = surf
    this.age[j] = 0
    this.life[j] = life
    this.s0[j] = s0
    this.s1[j] = s1
    this.rot[j] = Math.random() * 6.28
    this.a[j] = a
    this.kind[j] = kind
  }

  /** Mancha (o anillo, `ring` > 0: el hueco, 0..1) de espuma en p que se abre de r0 a r1 y se apaga en `life` s. */
  foam(p: Vector3, r0: number, r1: number, life: number, alpha: number, ring = 0): void {
    const j = this.fnext
    this.fnext = (this.fnext + 1) % MAXF
    this.fp[j * 3] = p.x
    this.fp[j * 3 + 1] = p.y
    this.fp[j * 3 + 2] = p.z
    this.fr0[j] = r0
    this.fr1[j] = r1
    this.fage[j] = 0
    this.flife[j] = life
    this.fa[j] = alpha
    this.fring[j] = ring
    this.frot[j] = Math.random() * 6.28
    this.fseed[j] = Math.random() * 10
  }

  /**
   * Algo entra en el agua en `p` (sobre la superficie) con velocidad `v` y tamaño `size` (m): corona de
   * gotas, agua pulverizada, anillo y mancha de espuma, y el ruido del golpe.
   */
  splash(p: Vector3, v: Vector3, size: number, gain = 1): void {
    // varias piezas que entran a la vez en el mismo sitio hacen un solo chapoteo: las demás solo suman
    // gotas (si no, cada una levantaba su nube y salía un muro blanco)
    let near = false
    for (const q of this.recent) if (this.clock - q.t < 0.35 && Math.hypot(q.x - p.x, q.z - p.z) < 3 + size) near = true
    if (near) gain *= 0.3
    else {
      this.recent.push({ x: p.x, z: p.z, t: this.clock })
      if (this.recent.length > 24) this.recent.shift()
    }
    const vy = Math.min(20, Math.max(0, -v.y))
    const vh0 = Math.hypot(v.x, v.z)
    // (una punta de pala que golpea a 150 m/s no lanza el agua a esa velocidad: se pulveriza)
    const vh = Math.min(25, vh0)
    const e = vy + 0.35 * vh
    if (e < 0.6) return
    const s = Math.max(0.1, Math.min(3, size))
    const dx = vh0 > 0.1 ? v.x / vh0 : 0
    const dz = vh0 > 0.1 ? v.z / vh0 : 0
    const n = Math.max(8, Math.min(360, Math.round((10 + 12 * e) * (0.4 + s) * gain)))
    const grazing = vh > 2 * vy
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2
      const ca = Math.cos(ang)
      const sa = Math.sin(ang)
      const up = Math.min(24, (0.7 + Math.random() * 1.5) * (1.1 + 0.5 * e)) * (grazing ? 0.55 : 1)
      const out = (0.3 + Math.random()) * (0.6 + 0.22 * e)
      const fwd = vh * (0.12 + 0.45 * Math.random())
      const r = s * 0.45 * Math.random()
      // gotas finas (cada sprite es un racimo de gotas, no una gota)
      const d = 0.025 + Math.random() * Math.random() * 0.09 * (0.5 + s)
      this.add(p.x + ca * r, p.y + 0.05, p.z + sa * r, ca * out + dx * fwd, up, sa * out + dz * fwd, 4, d, d * 1.4, 0.65, 0, p.y)
    }
    const m = near ? 0 : Math.min(14, Math.round(n / 12))
    for (let i = 0; i < m; i++) {
      const ang = Math.random() * Math.PI * 2
      const sp = (0.4 + Math.random()) * (0.5 + 0.18 * e)
      const s0 = 0.3 + s * 0.4 + Math.random() * 0.3
      this.add(p.x, p.y + 0.3 + Math.random() * 0.4 * s, p.z, Math.cos(ang) * sp + dx * vh * 0.2, 0.6 + Math.random() * (1 + 0.12 * e), Math.sin(ang) * sp + dz * vh * 0.2, 1.6 + Math.random() * 1.6 + 0.08 * e, s0, s0 + 0.8 + 0.1 * e * (0.5 + s), 0.12, 1, p.y)
    }
    _p.copy(p)
    if (!near) this.foam(_p, 0.25 * s + 0.2, 1 + s + 0.35 * e, 9 + e * 0.5, 0.75, 0.55)
    this.foam(_p, 0.4 * s + 0.2, 0.7 * s + 0.6 + 0.1 * e, 7 + Math.random() * 3, near ? 0.5 : 0.85)
    if (!near) this.sound?.(Math.min(1.6, (0.12 + 0.07 * e) * (0.5 + s) * gain), p)
  }

  /** Rociones de algo que corre por el agua (`amount` ≈ 0..2 por segundo de intensidad). */
  spray(p: Vector3, v: Vector3, amount: number, dt: number): void {
    const vh0 = Math.hypot(v.x, v.z)
    if (vh0 < 0.5) return
    const dx = v.x / vh0
    const dz = v.z / vh0
    const vh = Math.min(25, vh0)
    this.sprayAcc += dt * amount * 90
    for (; this.sprayAcc >= 1; this.sprayAcc--) {
      const side = Math.random() < 0.5 ? -1 : 1
      const lat = (0.8 + Math.random() * 2) * (1 + 0.08 * vh) * side
      const fwd = vh * (0.25 + 0.5 * Math.random())
      const up = (0.8 + Math.random() * 2.2) * (1 + 0.06 * vh)
      const d = 0.025 + Math.random() * Math.random() * 0.08
      this.add(p.x, p.y + 0.05, p.z, dx * fwd - dz * lat, up, dz * fwd + dx * lat, 3, d, d * 1.8, 0.7, 0, p.y)
      if (Math.random() < 0.12) {
        const s0 = 0.3 + Math.random() * 0.4
        this.add(p.x, p.y + 0.2, p.z, dx * vh * 0.35 - dz * lat * 0.4, 0.5 + Math.random(), dz * vh * 0.35 + dx * lat * 0.4, 1.2 + Math.random(), s0, s0 + 1 + 0.04 * vh, 0.12, 1, p.y)
      }
    }
  }

  /** Estela: espuma que deja detrás lo que navega (cada `key`, una). */
  wake(key: string, p: Vector3, v: Vector3, width: number): void {
    const last = this.wakes.get(key)
    const vh = Math.hypot(v.x, v.z)
    const step = Math.max(0.5, width * 0.7)
    if (last && this.clock - last.t < 0.6) {
      const d = Math.hypot(p.x - last.x, p.z - last.z)
      if (d < step) return
    }
    this.wakes.set(key, { x: p.x, y: p.y, z: p.z, t: this.clock })
    const a = Math.min(0.7, 0.15 + vh / 12)
    this.foam(p, width * 0.45, width * 0.6 + 1.2 + vh * 0.06, 12 + Math.random() * 6, a)
  }

  /** Burbujas que salen a la superficie en p (algo que se hunde): `intensity` 0..1. */
  bubbles(p: Vector3, intensity: number, dt: number): void {
    this.bubbleAcc += dt * (1 + 5 * intensity)
    for (; this.bubbleAcc >= 1; this.bubbleAcc--) {
      const ang = Math.random() * Math.PI * 2
      const r = Math.random() * (0.4 + intensity)
      _d.set(p.x + Math.cos(ang) * r, p.y, p.z + Math.sin(ang) * r)
      // cada burbuja que revienta deja un cerco pequeño y deshilachado que se abre y se borra
      this.foam(_d, 0.04, 0.15 + Math.random() * 0.3 * (0.5 + intensity), 1.5 + Math.random() * 1.5, 0.4, 0.3 + Math.random() * 0.3)
      if (intensity > 0.4 && Math.random() < 0.25) this.foam(_d, 0.1, 0.3 + Math.random() * 0.4, 2.5, 0.35)
    }
  }

  /**
   * Soplado del rotor sobre el agua: anillo de agua pulverizada alrededor de `p` (superficie bajo el
   * buje), de radio ≈ el del disco, que sale hacia fuera. `strength` 0..1+.
   */
  downwash(p: Vector3, radius: number, strength: number, dt: number): void {
    this.washAcc += dt * 140 * Math.min(1.5, strength)
    for (; this.washAcc >= 1; this.washAcc--) {
      const ang = Math.random() * Math.PI * 2
      const ca = Math.cos(ang)
      const sa = Math.sin(ang)
      const r = radius * (0.55 + 0.55 * Math.random())
      const sp = (3 + 7 * Math.min(1.2, strength)) * (0.6 + 0.7 * Math.random())
      const s0 = 0.3 + Math.random() * 0.5
      this.add(p.x + ca * r, p.y + 0.15, p.z + sa * r, ca * sp, 0.3 + Math.random() * 1.2, sa * sp, 1 + Math.random() * 1.3, s0, s0 + 2 + 2 * Math.random(), 0.1 + 0.1 * Math.min(1, strength), 1, p.y)
      if (strength > 0.5 && Math.random() < 0.25) {
        const d = 0.03 + Math.random() * 0.05
        this.add(p.x + ca * r, p.y + 0.05, p.z + sa * r, ca * sp * 0.8, 0.5 + Math.random() * 1.5, sa * sp * 0.8, 2, d, d * 1.5, 0.6, 0, p.y)
      }
    }
  }

  /**
   * Lo del aparato en vuelo, cada fotograma: chapoteos de lo que entra en el agua, estela y rociones de
   * lo que corre por ella (sim/hydro.ts) y el soplado del rotor a poca altura sobre el agua.
   * `water(x, z)`: profundidad (0 en tierra); `surface(x, z)`: altura de la superficie.
   */
  aircraft(dt: number, ac: Autogyro, water: ((x: number, z: number) => number) | null, surface: (x: number, z: number) => number | null): void {
    const h = ac.hydro
    for (const s of h.splashes) this.splash(_p.set(s.x, s.y, s.z), _v.set(s.vx, s.vy, s.vz), s.size)
    h.splashes.length = 0
    // cada flotador: estela desde su tramo mojado más a popa y rociones desde el más a proa (donde el
    // agua choca con el casco); lo demás (góndola, ruedas, cola), cada pieza la suya
    const floats = this.floatEnds
    floats.clear()
    h.wetPoints.forEach((w, i) => {
      if (w.kind === 'float') {
        const g = floats.get(w.name)
        if (!g) floats.set(w.name, { front: w, back: w })
        else {
          if (w.along > g.front.along) g.front = w
          if (w.along < g.back.along) g.back = w
        }
        return
      }
      const vh = Math.hypot(w.vx, w.vz)
      if (vh < 1) return
      _p.set(w.x, w.y, w.z)
      _v.set(w.vx, w.vy, w.vz)
      this.wake(`ac${i}`, _p, _v, Math.max(0.4, w.size))
      if (vh > 3.5) this.spray(_p, _v, w.wet * Math.min(1.6, vh / 10) * Math.min(1.5, w.size), dt)
    })
    for (const [name, g] of floats) {
      const vh = Math.hypot(g.back.vx, g.back.vz)
      if (vh < 0.8) continue
      this.wake(`fl-${name}`, _p.set(g.back.x, g.back.y, g.back.z), _v.set(g.back.vx, g.back.vy, g.back.vz), g.back.size * 1.4)
      if (vh > 3) this.spray(_p.set(g.front.x, g.front.y, g.front.z), _v.set(g.front.vx, g.front.vy, g.front.vz), Math.min(1.4, vh / 14) * (0.4 + g.front.wet), dt)
    }
    if (!water || ac.crash) return
    // soplado del rotor: con empuje y a menos de ~2 radios del agua
    const R = ac.rotor.p.radius
    const T = ac.rotor.thrust
    if (T < 300) return
    _d.copy(ac.hubBody).applyQuaternion(ac.quat).add(ac.pos)
    if (!(water(_d.x, _d.z) > 0)) return
    const sy = surface(_d.x, _d.z)
    if (sy === null) return
    const hh = _d.y - sy
    if (hh > 2.2 * R || hh < 0) return
    // carga del disco (≈ 80 N/m² en un biplaza) y cercanía al agua
    const load = T / (Math.PI * R * R) / 80
    const near = 1 - hh / (2.2 * R)
    this.downwash(_p.set(_d.x, sy, _d.z), R * (0.85 + 0.25 * (hh / R)), load * near * near, dt)
  }

  // ---------------------------------------------------------------------------
  update(dt: number, wind: Vector3): void {
    this.clock += dt
    this.updateLight()
    let n = 0
    const kd = Math.min(1, 0.35 * dt)
    const km = Math.min(1, 1.8 * dt)
    for (let j = 0; j < MAXP; j++) {
      const age = (this.age[j] += dt)
      const life = this.life[j]
      if (age >= life) continue
      const o = j * 3
      let vx = this.v[o]
      let vy = this.v[o + 1]
      let vz = this.v[o + 2]
      const mist = this.kind[j] === 1
      const k = mist ? km : kd
      vx += (wind.x - vx) * k
      vz += (wind.z - vz) * k
      if (mist) vy += (wind.y + 0.25 - vy) * k
      else vy -= 9.81 * dt
      const x = this.p[o] + vx * dt
      let y = this.p[o + 1] + vy * dt
      const z = this.p[o + 2] + vz * dt
      const t0 = age / life
      const size0 = this.s0[j] + (this.s1[j] - this.s0[j]) * (1 - (1 - t0) * (1 - t0))
      if (mist && y < this.surf[j] + 0.45 * size0) {
        // (la niebla no se mete bajo el agua: cortada por la superficie, se veía como una losa)
        y = this.surf[j] + 0.45 * size0
        vy = Math.max(vy, 0)
      }
      // la gota que vuelve al agua desaparece
      if (!mist && vy < 0 && y < this.surf[j]) {
        this.life[j] = age
        continue
      }
      this.p[o] = x
      this.p[o + 1] = y
      this.p[o + 2] = z
      this.v[o] = vx
      this.v[o + 1] = vy
      this.v[o + 2] = vz
      const t = age / life
      const size = this.s0[j] + (this.s1[j] - this.s0[j]) * (1 - (1 - t) * (1 - t))
      const fade = mist ? (1 - t) * Math.sqrt(1 - t) : 1 - t * t * t
      const fadeIn = Math.min(1, age / (mist ? 0.15 : 0.03))
      this.iPos[n * 3] = x
      this.iPos[n * 3 + 1] = y
      this.iPos[n * 3 + 2] = z
      this.iCol[n * 4] = SPRAY[0]
      this.iCol[n * 4 + 1] = SPRAY[1]
      this.iCol[n * 4 + 2] = SPRAY[2]
      this.iCol[n * 4 + 3] = this.a[j] * fade * fadeIn
      this.iSr[n * 2] = size
      this.iSr[n * 2 + 1] = this.rot[j] + age * 0.3
      n++
    }
    this.pgeo.instanceCount = n
    if (n > 0) {
      for (const name of ['iPos', 'iCol', 'iSizeRot']) {
        const a = this.pgeo.getAttribute(name) as InstancedBufferAttribute
        a.needsUpdate = true
        a.clearUpdateRanges()
        a.addUpdateRange(0, n * a.itemSize)
      }
    }

    let m = 0
    for (let j = 0; j < MAXF; j++) {
      const age = (this.fage[j] += dt)
      const life = this.flife[j]
      if (age >= life) continue
      const t = age / life
      const r = this.fr0[j] + (this.fr1[j] - this.fr0[j]) * (1 - (1 - t) * (1 - t))
      const a = this.fa[j] * Math.min(1, age / 0.12) * (1 - t) * Math.sqrt(1 - t)
      this.iPosR[m * 4] = this.fp[j * 3]
      this.iPosR[m * 4 + 1] = this.fp[j * 3 + 1]
      this.iPosR[m * 4 + 2] = this.fp[j * 3 + 2]
      this.iPosR[m * 4 + 3] = r
      // el anillo se abre: el hueco crece con la edad
      this.iParam[m * 4] = a
      this.iParam[m * 4 + 1] = this.fring[j] > 0 ? Math.min(0.92, this.fring[j] + 0.3 * t) : 0
      this.iParam[m * 4 + 2] = this.frot[j] + age * 0.05
      this.iParam[m * 4 + 3] = this.fseed[j]
      m++
    }
    this.fgeo.instanceCount = m
    if (m > 0) {
      for (const name of ['iPosR', 'iParam']) {
        const a = this.fgeo.getAttribute(name) as InstancedBufferAttribute
        a.needsUpdate = true
        a.clearUpdateRanges()
        a.addUpdateRange(0, m * a.itemSize)
      }
    }
    // estelas que ya no se mueven
    if (this.wakes.size) for (const [k, w] of this.wakes) if (this.clock - w.t > 3) this.wakes.delete(k)
  }

  /** Radiancia por unidad de albedo del sol y el cielo (como la niebla de la fumigación). */
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

  /** Re-centrado del mundo: todo lo que hay se mueve con él. */
  rebase(m: Matrix4): void {
    _q.setFromRotationMatrix(m)
    for (let j = 0; j < MAXP; j++) {
      if (this.age[j] >= this.life[j]) continue
      const o = j * 3
      _v.set(this.p[o], this.surf[j], this.p[o + 2]).applyMatrix4(m)
      this.surf[j] = _v.y
      _v.fromArray(this.p, o).applyMatrix4(m).toArray(this.p, o)
      _v.fromArray(this.v, o).applyQuaternion(_q).toArray(this.v, o)
    }
    for (let j = 0; j < MAXF; j++) {
      if (this.fage[j] >= this.flife[j]) continue
      _v.fromArray(this.fp, j * 3).applyMatrix4(m).toArray(this.fp, j * 3)
    }
    this.wakes.clear()
  }

  clear(): void {
    this.age.fill(1)
    this.life.fill(1)
    this.fage.fill(1)
    this.flife.fill(1)
    this.pgeo.instanceCount = 0
    this.fgeo.instanceCount = 0
    this.wakes.clear()
    this.recent.length = 0
    this.sprayAcc = this.washAcc = this.bubbleAcc = 0
  }

  /** Para la telemetría. */
  stats(): string {
    return `agua: gotas ${this.pgeo.instanceCount} · espuma ${this.fgeo.instanceCount}`
  }
}
