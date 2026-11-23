// Monumentos que no vienen como edificio en OpenStreetMap y que hay que modelar aparte. La
// torre Eiffel está mapeada como «torre» (man_made=tower), no como edificio, así que las
// teselas de edificios no la traen: aquí se genera con sus medidas reales (cuatro pilares de
// celosía curvos que se unen en el segundo piso, arcos de la base, plataformas, remate y antena).
//
// Igual que los edificios: cuelgan del marco ECEF (se re-centran con syncFrame), alfa = 0 (ya
// iluminados), cielo como mapa de entorno, sombra del sol (worldShadowCaster) y choques.

import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  Group,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  Vector3,
  type Texture,
} from 'three'
import { GeoFrame } from './GeoFrame.ts'
import type { HeightSource } from './HeightSource.ts'

interface Model {
  object: Group
  /** ¿punto (coordenadas del modelo: x, z en horizontal, y desde el suelo) dentro de la estructura? */
  inside(x: number, y: number, z: number): boolean
}

interface Spec {
  id: string
  lat: number
  lon: number
  /** giro del modelo alrededor de la vertical (grados; 0 = lados al este y al sur) */
  yaw: number
  /** radio (m) en el que se quitan los edificios de OSM que lo representan a bloques */
  replaces: number
  build(mats: Materials): Model
}

interface Item {
  spec: Spec
  state: 'idle' | 'loading' | 'ready'
  root?: Group
  model?: Model
  toLocal: Matrix4
}

interface Materials {
  lattice: MeshStandardMaterial
  solid: MeshStandardMaterial
}

/** a qué distancia (m) se construye un monumento y a cuál se quita */
const BUILD_DIST = 30000
const DROP_DIST = 40000

// ---------------------------------------------------------------------------
// Torre Eiffel
// ---------------------------------------------------------------------------

/** semiancho exterior de la torre (m) según la altura */
const EIFFEL_OUT: Array<[number, number]> = [
  [0, 62.5], [20, 52], [39, 44], [57.6, 36.5], [80, 29.5], [100, 24.5], [115.7, 21], [140, 16.5], [180, 11.5],
  [220, 8], [260, 5.6], [276, 4.9], [300, 2.6],
]
/** semiancho del hueco entre pilares hasta que se unen en el segundo piso */
const EIFFEL_IN: Array<[number, number]> = [
  [0, 38], [20, 31.5], [39, 26.5], [57.6, 21.5], [80, 15], [100, 9.5], [115.7, 4],
]

function table(t: Array<[number, number]>, y: number): number {
  if (y <= t[0][0]) return t[0][1]
  for (let i = 1; i < t.length; i++) {
    if (y <= t[i][0]) {
      const [y0, v0] = t[i - 1]
      const [y1, v1] = t[i]
      return v0 + ((v1 - v0) * (y - y0)) / (y1 - y0)
    }
  }
  return t[t.length - 1][1]
}

/** tamaño (m) de una celda de la celosía */
const CELL = 6.5

class Builder {
  pos: number[] = []
  uv: number[] = []

  quad(a: Vector3, b: Vector3, c: Vector3, d: Vector3, ua: [number, number], ub: [number, number], uc: [number, number], ud: [number, number]): void {
    for (const [p, t] of [[a, ua], [b, ub], [c, uc], [a, ua], [c, uc], [d, ud]] as Array<[Vector3, [number, number]]>) {
      this.pos.push(p.x, p.y, p.z)
      this.uv.push(t[0], t[1])
    }
  }

  /** tronco de pirámide de base cuadrada entre dos alturas (centro y semiancho en cada una) */
  frustum(y0: number, cx0: number, cz0: number, h0: number, y1: number, cx1: number, cz1: number, h1: number): void {
    const P = (y: number, cx: number, cz: number, h: number, sx: number, sz: number) => new Vector3(cx + sx * h, y, cz + sz * h)
    // cuatro caras: (esquina inicial, esquina final) en el sentido de giro
    const sides: Array<[[number, number], [number, number]]> = [
      [[1, -1], [1, 1]],
      [[1, 1], [-1, 1]],
      [[-1, 1], [-1, -1]],
      [[-1, -1], [1, -1]],
    ]
    for (const [[ax, az], [bx, bz]] of sides) {
      const a = P(y0, cx0, cz0, h0, ax, az)
      const b = P(y0, cx0, cz0, h0, bx, bz)
      const c = P(y1, cx1, cz1, h1, bx, bz)
      const d = P(y1, cx1, cz1, h1, ax, az)
      this.quad(a, b, c, d, [-h0 / CELL, y0 / CELL], [h0 / CELL, y0 / CELL], [h1 / CELL, y1 / CELL], [-h1 / CELL, y1 / CELL])
    }
  }

  /** caja maciza (para plataformas y remates) */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    const v = (x: number, y: number, z: number) => new Vector3(x, y, z)
    const z: [number, number] = [0, 0]
    const faces: Array<[Vector3, Vector3, Vector3, Vector3]> = [
      [v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1)],
      [v(x1, y0, z0), v(x0, y0, z0), v(x0, y1, z0), v(x1, y1, z0)],
      [v(x1, y0, z1), v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1)],
      [v(x0, y0, z0), v(x0, y0, z1), v(x0, y1, z1), v(x0, y1, z0)],
      [v(x0, y1, z1), v(x1, y1, z1), v(x1, y1, z0), v(x0, y1, z0)],
      [v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1)],
    ]
    for (const [a, b, c, d] of faces) this.quad(a, b, c, d, z, z, z, z)
  }

  /** arco de medio punto rebajado (semielipse) como una viga curva, en el plano z = zc */
  arch(zc: number, a: number, bh: number, width: number, depth: number, rotate: boolean): void {
    const n = 28
    const pt = (t: number, r: number, dz: number): Vector3 => {
      const x = (a + r) * Math.cos(t)
      const y = (bh + r) * Math.sin(t)
      const z = zc + dz
      return rotate ? new Vector3(z, y, x) : new Vector3(x, y, z)
    }
    const zz: [number, number] = [0, 0]
    for (let i = 0; i < n; i++) {
      const t0 = (Math.PI * i) / n
      const t1 = (Math.PI * (i + 1)) / n
      for (const [r0, r1, d0, d1] of [
        [0, 0, -depth / 2, depth / 2], // intradós
        [width, width, -depth / 2, depth / 2], // trasdós
        [0, width, -depth / 2, -depth / 2], // caras
        [0, width, depth / 2, depth / 2],
      ] as Array<[number, number, number, number]>) {
        this.quad(pt(t0, r0, d0), pt(t1, r0, d0), pt(t1, r1, d1), pt(t0, r1, d1), zz, zz, zz, zz)
      }
    }
  }

  geometry(): BufferGeometry {
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3))
    g.setAttribute('uv', new BufferAttribute(new Float32Array(this.uv), 2))
    g.computeVertexNormals()
    g.computeBoundingSphere()
    return g
  }
}

function eiffel(mats: Materials): Model {
  const lat = new Builder()
  const sol = new Builder()
  // cuatro pilares, curvos, hasta unirse en el segundo piso
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    for (let i = 0; i + 1 < EIFFEL_IN.length; i++) {
      const [y0, in0] = EIFFEL_IN[i]
      const [y1, in1] = EIFFEL_IN[i + 1]
      const o0 = table(EIFFEL_OUT, y0)
      const o1 = table(EIFFEL_OUT, y1)
      const c0 = (o0 + in0) / 2
      const c1 = (o1 + in1) / 2
      lat.frustum(y0, sx * c0, sz * c0, (o0 - in0) / 2, y1, sx * c1, sz * c1, (o1 - in1) / 2)
    }
  }
  // fuste único del segundo piso a la cima
  const shaft = EIFFEL_OUT.filter(([y]) => y >= 115.7)
  for (let i = 0; i + 1 < shaft.length; i++) lat.frustum(shaft[i][0], 0, 0, shaft[i][1], shaft[i + 1][0], 0, 0, shaft[i + 1][1])
  // primer piso: marco cuadrado con el hueco central; segundo piso; remate de la cima
  const f1 = 37.5
  const h1 = 19
  sol.box(-f1, 57.6, -f1, f1, 62, -h1)
  sol.box(-f1, 57.6, h1, f1, 62, f1)
  sol.box(-f1, 57.6, -h1, -h1, 62, h1)
  sol.box(h1, 57.6, -h1, f1, 62, h1)
  sol.box(-22, 115.7, -22, 22, 118.5, 22)
  sol.box(-5.5, 276, -5.5, 5.5, 283, 5.5)
  sol.box(-1.6, 300, -1.6, 1.6, 304, 1.6)
  sol.box(-0.6, 304, -0.6, 0.6, 330, 0.6) // antenas
  // arcos de la base, uno por cara
  for (const s of [-1, 1]) {
    sol.arch(s * 41, 34, 40, 2.2, 1.6, false)
    sol.arch(s * 41, 34, 40, 2.2, 1.6, true)
  }
  const object = new Group()
  object.add(new Mesh(lat.geometry(), mats.lattice), new Mesh(sol.geometry(), mats.solid))
  return {
    object,
    inside(x, y, z) {
      if (y < 0 || y > 330) return false
      const ax = Math.abs(x)
      const az = Math.abs(z)
      if (y > 304) return ax < 1 && az < 1
      if (y >= 115.7) {
        const o = y <= 118.5 ? 22 : table(EIFFEL_OUT, y)
        return ax <= o && az <= o
      }
      if (y >= 57.6 && y <= 62) return ax <= f1 && az <= f1 && (ax >= h1 || az >= h1)
      // pilares: entre ellos se puede pasar (por debajo de los arcos y por el centro)
      const o = table(EIFFEL_OUT, y)
      const i = table(EIFFEL_IN, y)
      return ax <= o && az <= o && ax >= i && az >= i
    },
  }
}

const SPECS: Spec[] = [
  // ejes paralelos y perpendiculares al Campo de Marte (Trocadero–Escuela Militar, rumbo ≈ 132°).
  // En OSM está por partes (building:part) que salen como cajas apiladas: se quitan.
  { id: 'eiffel', lat: 48.858222, lon: 2.2945, yaw: 48, replaces: 72, build: eiffel },
]

/**
 * ¿Hay un monumento modelado aquí? Buildings.ts no dibuja los edificios de OSM cuyo centro cae
 * dentro (la torre Eiffel está mapeada como cajas apiladas que taparían el modelo).
 */
export function replacedByLandmark(lat: number, lon: number): boolean {
  for (const s of SPECS) if (distanceM(lat, lon, s.lat, s.lon) < s.replaces) return true
  return false
}

/** ¿Hay algún monumento modelado dentro de este rectángulo (más su radio)? */
export function landmarkNear(south: number, west: number, north: number, east: number): boolean {
  const m = 0.002
  return SPECS.some((s) => s.lat > south - m && s.lat < north + m && s.lon > west - m && s.lon < east + m)
}

// ---------------------------------------------------------------------------
// Materiales
// ---------------------------------------------------------------------------

/** celosía: marco y aspas de San Andrés; con distancia (mipmaps) queda como superficie oscura */
function latticeTexture(): Texture {
  const s = 64
  const cv = document.createElement('canvas')
  cv.width = s
  cv.height = s
  const ctx = cv.getContext('2d')!
  ctx.clearRect(0, 0, s, s)
  ctx.strokeStyle = '#fff'
  ctx.lineCap = 'square'
  ctx.lineWidth = 9
  ctx.strokeRect(0, 0, s, s)
  ctx.lineWidth = 6
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(s, s)
  ctx.moveTo(s, 0)
  ctx.lineTo(0, s)
  ctx.stroke()
  const tex = new CanvasTexture(cv)
  tex.wrapS = tex.wrapT = RepeatWrapping
  tex.colorSpace = SRGBColorSpace
  tex.minFilter = LinearMipmapLinearFilter
  tex.anisotropy = 8
  return tex
}

function litAlphaZero(m: MeshStandardMaterial, key: string): MeshStandardMaterial {
  // alfa = 0 → «este píxel ya está iluminado» (máscara de iluminación de Graphics.ts)
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <dithering_fragment>', '#include <dithering_fragment>\n\tgl_FragColor.a = 0.0;')
  }
  m.customProgramCacheKey = () => key
  return m
}

// ---------------------------------------------------------------------------
// Capa
// ---------------------------------------------------------------------------

const _p = new Vector3()
const _cam = new Vector3()

export class Landmarks {
  readonly group = new Group()
  private readonly frame: GeoFrame
  private readonly heights: HeightSource
  private readonly items: Item[]
  private readonly mats: Materials
  private timer = 0
  private disposed = false

  constructor(frame: GeoFrame, heights: HeightSource) {
    this.frame = frame
    this.heights = heights
    this.items = SPECS.map((spec) => ({ spec, state: 'idle', toLocal: new Matrix4() }))
    this.group.matrixAutoUpdate = false
    this.group.userData.worldShadowCaster = true // sombra del sol (SunShadows)
    const lattice = latticeTexture()
    // bronce de la torre Eiffel («marrón torre Eiffel»)
    this.mats = {
      lattice: litAlphaZero(
        new MeshStandardMaterial({ color: 0x7a6249, map: lattice, alphaTest: 0.45, side: DoubleSide, roughness: 0.72, metalness: 0.25 }),
        'landmark-lattice',
      ),
      solid: litAlphaZero(new MeshStandardMaterial({ color: 0x6a5440, side: DoubleSide, roughness: 0.7, metalness: 0.25 }), 'landmark-solid'),
    }
  }

  /** Construye los cercanos y quita los lejanos (cada segundo). */
  update(dt: number, camera: Vector3): void {
    this.timer -= dt
    if (this.timer > 0) return
    this.timer = 1
    const g = this.frame.worldToGeo(_cam.copy(camera))
    for (const it of this.items) {
      const d = distanceM(g.lat, g.lon, it.spec.lat, it.spec.lon)
      if (it.state === 'idle' && d < BUILD_DIST) void this.build(it)
      else if (it.state === 'ready' && d > DROP_DIST) this.drop(it)
    }
  }

  private async build(it: Item): Promise<void> {
    it.state = 'loading'
    const { lat, lon } = it.spec
    let ground: number | null = null
    try {
      await this.heights.ensure(lat - 0.002, lon - 0.003, lat + 0.002, lon + 0.003)
      ground = this.heights.sample(lat, lon)
    } catch {
      ground = null
    }
    if (this.disposed) return
    if (ground === null) {
      it.state = 'idle' // se reintenta en la próxima pasada
      return
    }
    const model = it.spec.build(this.mats)
    const root = new Group()
    root.matrixAutoUpdate = false
    const f = new GeoFrame()
    f.setOrigin(lat, lon, 0)
    root.matrix.copy(f.worldToECEF)
    model.object.position.y = ground
    model.object.rotation.y = (it.spec.yaw * Math.PI) / 180
    root.add(model.object)
    this.group.add(root)
    it.root = root
    it.model = model
    it.state = 'ready'
    this.syncFrame()
  }

  private drop(it: Item): void {
    if (!it.root) return
    it.root.removeFromParent()
    it.root.traverse((o) => (o as Mesh).geometry?.dispose())
    it.root = undefined
    it.model = undefined
    it.state = 'idle'
  }

  /** Re-centrado del mundo. */
  syncFrame(): void {
    this.group.matrix.copy(this.frame.ecefToWorld)
    this.group.updateMatrixWorld(true)
    for (const it of this.items) if (it.model) it.toLocal.copy(it.model.object.matrixWorld).invert()
  }

  /** ¿El punto (mundo) está dentro de algún monumento? */
  collides(p: Vector3): boolean {
    for (const it of this.items) {
      if (!it.model) continue
      _p.copy(p).applyMatrix4(it.toLocal)
      if (Math.abs(_p.x) > 70 || Math.abs(_p.z) > 70) continue
      if (it.model.inside(_p.x, _p.y, _p.z)) return true
    }
    return false
  }

  setEnvMap(tex: Texture | null): void {
    for (const m of [this.mats.lattice, this.mats.solid]) {
      if ((m.envMap === null) !== (tex === null)) m.needsUpdate = true
      m.envMap = tex
      m.envMapIntensity = 1
    }
  }

  dispose(): void {
    this.disposed = true
    for (const it of this.items) this.drop(it)
    this.mats.lattice.map?.dispose()
    this.mats.lattice.dispose()
    this.mats.solid.dispose()
  }
}

function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const k = Math.PI / 180
  const x = (lon2 - lon1) * Math.cos(((lat1 + lat2) / 2) * k) * 111320
  const y = (lat2 - lat1) * 110574
  return Math.hypot(x, y)
}
