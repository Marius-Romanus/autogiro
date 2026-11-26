// Disco de las palas en giro (rotor y hélice), calculado en vez de dibujado a mano.
//
// A la vista, una pala que gira no es más que su propia silueta repartida por el arco que barre
// mientras dura la «exposición» del ojo: en cada punto del disco tapa el fondo la fracción de ese
// tiempo en la que tiene una pala encima. De ahí sale todo, sin halos ni aros inventados:
//
//  · En un radio r, N palas de cuerda c tapan N·c / (2π·r) de la vuelta: mucho junto al buje y
//    casi nada en las puntas (un 1,5 % en un rotor bipala de 8,4 m). Por eso un rotor de verdad
//    apenas se ve por fuera y se cierra hacia el centro.
//  · La cuerda, el color (puntas pintadas incluidas) y el canto de las palas a cada radio se
//    miden del propio modelo 3D, visto desde arriba (`analyse`).
//  · El rotor de un autogiro pasa de pala unas 12 veces por segundo, muy por debajo de lo que
//    el ojo funde (~50-60 Hz): en la realidad se ven las palas como cuñas borrosas que giran y
//    parpadean, no un disco liso. Cada fotograma dibuja el arco barrido en 1/60 s (`EXPOSURE`),
//    que es el desenfoque de movimiento exacto; al pasar de ~30-60 pasos de pala por segundo (la
//    hélice con gas) las cuñas se funden en el disco uniforme que ve el ojo.
//  · De canto, la pala enseña su grosor: la silueta crece con la oblicuidad, así que el disco,
//    con su conicidad, se ve como una línea fina y densa en vez de desaparecer.
//
//  · El disco refleja la luz como la pala: mismo color, metal y rugosidad que el material del
//    modelo a cada radio, así que brilla al sol (y se oscurece a contraluz) igual que ella.
//
// Se dibuja en las dos pasadas de `overlayAlbedoPass` / `overlayLightPass` (Graphics.ts): la malla
// es la de albedo y lleva una hija con la misma geometría para la de luz. Las dos calculan la
// luz que devuelve la pala; la de albedo la divide por la que devolvería un suelo blanco, que es
// por lo que el posproceso multiplica después esos píxeles (los que tienen terreno detrás).

import {
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  DataUtils,
  DoubleSide,
  HalfFloatType,
  LinearFilter,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  RGBAFormat,
  RingGeometry,
  SRGBColorSpace,
  UnsignedByteType,
  Vector3,
  Vector4,
  type Material,
  type Object3D,
} from 'three'
import { OVERLAY_LAYER, overlayAlbedoPass, overlayLightPass } from '../render/Graphics.ts'

/** tiempo que integra el ojo a plena luz (s): el arco que barre la pala en cada imagen */
const EXPOSURE = 1 / 60
/** barrido, en anchos de pala, a partir del cual la pala ya solo es su estela (y por debajo del cual reaparece) */
const SOLID_OFF = 2.5
const SOLID_ON = 2.0
/** tramos radiales del perfil y lado de la rejilla en la que se proyecta el modelo */
const BINS = 256
const GRID = 768
const TAU = Math.PI * 2

/** Lo que se mide del modelo, por radio (0 → R en `BINS` tramos). */
interface Profile {
  /** color medio de lo que gira (sRGB 8 bits) y, en el alfa, cuánto tiene de metal */
  color: Uint8Array
  /** cuerda (m), desfase del centro de la pala respecto a `phase` (rad), canto (m) y rugosidad */
  shape: Float32Array
  /** acimut de una pala con el giro a cero (rad, ejes del disco) */
  phase: number
  /** ancho angular de una pala al 70 % del radio (rad) */
  refWidth: number
  /** altura del plano de las palas junto a la raíz, sobre el origen del nodo (m) */
  rootZ: number
  /** por malla, en orden de recorrido: no se emborrona (pieza de revolución: cono, buje…) */
  solid: boolean[]
}

const cache = new Map<string, Profile>()

export interface BladeDiscOptions {
  radius: number
  blades: number
  /** conicidad de las palas en vuelo (rad); una hélice, 0 */
  cone: number
  renderOrder: number
  /** albedo (lineal) si el modelo no trae la pieza */
  fallback: Color
}

export class BladeDisc {
  readonly mesh: Mesh
  private readonly lit: Mesh
  private readonly opt: BladeDiscOptions
  private readonly period: number
  private readonly uBlade = { value: new Vector4(0, 0, 1, 1) }
  /** z: tangente de la conicidad */
  private readonly uDim = { value: new Vector4(0, 0, 0, 0) }
  private readonly uColor: { value: DataTexture }
  private readonly uShape: { value: DataTexture }
  private phase = 0
  private refWidth = 0.07
  /** mallas del modelo a las que sustituye el disco cuando giran deprisa */
  private blurred: Mesh[] = []
  private solidShown = true

  constructor(opt: BladeDiscOptions) {
    this.opt = opt
    this.period = TAU / opt.blades
    const flat = flatProfile(opt)
    this.uColor = { value: colorTexture(flat.color) }
    this.uShape = { value: shapeTexture(flat.shape) }
    this.applyProfile(flat)

    const geo = new RingGeometry(0.02, opt.radius, 96, 1)
    const common = { transparent: true, depthWrite: false, side: DoubleSide } as const
    this.mesh = new Mesh(geo, overlayAlbedoPass(this.patch(new MeshStandardMaterial(common), true)))
    this.mesh.renderOrder = opt.renderOrder
    this.mesh.layers.set(OVERLAY_LAYER)
    this.lit = new Mesh(geo, overlayLightPass(this.patch(new MeshStandardMaterial(common), false)))
    this.lit.renderOrder = opt.renderOrder + 1
    this.lit.layers.set(OVERLAY_LAYER)
    this.mesh.add(this.lit)
    this.mesh.visible = false
  }

  /**
   * Mide las palas del modelo. `spin`: el grupo que gira, en su pose de reposo; el disco ya tiene
   * que estar colocado (su orientación da el eje de giro). `keep`: mallas que no se emborronan
   * nunca. `key`: identifica el modelo, para no medirlo otra vez en cada aparato igual.
   * Devuelve la altura del plano de las palas sobre el origen del nodo.
   */
  attach(spin: Object3D, key: string, keep: (m: Mesh) => boolean = () => false): number {
    const meshes: Mesh[] = []
    spin.traverse((o) => {
      const m = o as Mesh
      if (m.isMesh && m !== this.mesh && m !== this.lit) meshes.push(m)
    })
    const id = `${key}|${this.opt.radius}|${this.opt.blades}|${meshes.length}`
    let p = cache.get(id)
    if (!p) {
      p = analyse(meshes, spin, this.mesh, this.opt, keep)
      cache.set(id, p)
    }
    this.blurred = meshes.filter((_, i) => !p.solid[i])
    this.solidShown = true
    ;(this.uColor.value.image.data as Uint8Array).set(p.color)
    this.uColor.value.needsUpdate = true
    ;(this.uShape.value.image.data as Uint16Array).set(halfFloats(p.shape))
    this.uShape.value.needsUpdate = true
    this.applyProfile(p)
    return p.rootZ
  }

  /** El modelo se descarta: sus mallas ya no son cosa del disco. */
  detach(): void {
    this.blurred = []
    this.solidShown = true
    this.mesh.visible = false
    this.mesh.removeFromParent()
  }

  /**
   * `angle`: giro actual del nodo (rad, con el signo con el que gira en los ejes del disco);
   * `omega`: su velocidad (rad/s, mismo signo); `dt`: tiempo simulado de este fotograma.
   */
  update(angle: number, omega: number, dt: number): void {
    if (dt === 0) return // en pausa se queda como estaba
    const sweep = Math.abs(omega) * Math.max(Math.abs(dt), EXPOSURE)
    const s = sweep / this.refWidth
    // con poco barrido se ve la pala del modelo y, detrás, su estela; con mucho, solo la estela
    const solid = this.solidShown ? s < SOLID_OFF : s < SOLID_ON
    if (solid !== this.solidShown) {
      this.solidShown = solid
      for (const m of this.blurred) m.visible = solid
    }
    this.mesh.visible = s > 0.05
    // las palas han ido de (ángulo − barrido) a ángulo
    const from = omega >= 0 ? angle - sweep : angle
    this.uBlade.value.x = (((from + this.phase) % TAU) + TAU) % TAU
    this.uBlade.value.y = sweep
    // la conicidad llega con las vueltas (parado, las palas del modelo están planas)
    this.uDim.value.z = Math.tan(this.opt.cone) * smooth(1, 5, s)
  }

  dispose(): void {
    this.mesh.removeFromParent()
    this.mesh.geometry.dispose()
    ;(this.mesh.material as Material).dispose()
    ;(this.lit.material as Material).dispose()
    this.uColor.value.dispose()
    this.uShape.value.dispose()
  }

  private applyProfile(p: Profile): void {
    this.phase = p.phase
    this.refWidth = Math.max(p.refWidth, 1e-3)
    this.uBlade.value.z = this.period
    this.uBlade.value.w = this.opt.radius
  }

  private patch<T extends Material>(m: T, albedo: boolean): T {
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uBlade = this.uBlade
      shader.uniforms.uBladeDim = this.uDim
      shader.uniforms.uBladeColor = this.uColor
      shader.uniforms.uBladeShape = this.uShape
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VERT_HEAD}`)
        .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n${VERT_NORMAL}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_BEGIN}`)
        .replace('#include <project_vertex>', `#include <project_vertex>\n${VERT_VIEW}`)
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FRAG_HEAD}`)
        .replace('#include <map_fragment>', `#include <map_fragment>\n${FRAG_COVER}`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n	roughnessFactor = mix(bladeShp.a, 1.0, 0.6 * bladeEdge);`)
        .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n	metalnessFactor = bladeCol.a;`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${FRAG_NORMAL}`)
      if (albedo) shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `#include <opaque_fragment>\n${FRAG_ALBEDO}`)
    }
    m.customProgramCacheKey = () => (albedo ? 'blade-disc-albedo' : 'blade-disc-light')
    return m
  }
}

const VERT_HEAD = /* glsl */ `
uniform vec4 uBladeDim;
varying vec3 vBladePos;
varying vec3 vBladeView;
varying vec3 vBladeSpan;
`
const VERT_NORMAL = /* glsl */ `
objectNormal = normalize(vec3(-uBladeDim.z * normalize(position.xy), 1.0));
`
const VERT_BEGIN = /* glsl */ `
transformed.z += uBladeDim.z * length(position.xy);
vBladePos = transformed;
`
// hacia el ojo, en los ejes del disco (la matriz solo gira y escala por igual)
const VERT_VIEW = /* glsl */ `
vBladeView = (-mvPosition.xyz) * mat3(modelViewMatrix);
vBladeSpan = normalMatrix * vec3(normalize(position.xy), 0.0);
`
const FRAG_HEAD = /* glsl */ `
uniform vec4 uBlade;    // inicio del barrido, barrido, ángulo entre palas (rad), radio (m)
uniform vec4 uBladeDim; // z: tangente de la conicidad
uniform sampler2D uBladeColor; // color de la pala a cada radio; alfa: metal
uniform sampler2D uBladeShape; // cuerda (m), desfase (rad), canto (m), rugosidad
varying vec3 vBladePos;
varying vec3 vBladeView;
varying vec3 vBladeSpan;
// medida, hasta x, de las franjas de ancho a centradas en cada múltiplo de p
float bladeCum(float x, float a, float p) {
  float u = x + 0.5 * a;
  float k = floor(u / p);
  return k * a + min(u - k * p, a);
}
`
const FRAG_COVER = /* glsl */ `
float bladeR = length(vBladePos.xy);
float bladeU = bladeR / uBlade.w;
vec4 bladeCol = texture2D(uBladeColor, vec2(bladeU, 0.5));
vec4 bladeShp = texture2D(uBladeShape, vec2(bladeU, 0.5));
float bladeEdge = 0.0; // parte de la silueta que es canto de pala (0: se ve su cara; 1: solo el canto)
{
  float chord = bladeShp.r;
  float edge = bladeShp.b;
  // silueta de la pala vista en oblicuo: a la cuerda se le suma el canto que asoma
  vec2 er = vBladePos.xy / max(bladeR, 1e-4);
  vec3 bn = normalize(vec3(-uBladeDim.z * er, 1.0));
  float vt = dot(vBladeView.xy, vec2(-er.y, er.x));
  float vn = dot(vBladeView, bn);
  float slant = abs(vt) / max(abs(vn), 1e-4 * length(vBladeView));
  float width = sqrt(chord * chord + edge * edge * slant * slant);
  bladeEdge = edge * edge * slant * slant / max(width * width, 1e-8);
  float p = uBlade.z;
  float a = min(width / max(bladeR, 1e-4), p);
  // fracción de la exposición con una pala encima
  float th = atan(vBladePos.y, vBladePos.x) - bladeShp.g;
  float sweep = max(uBlade.y, 1e-5);
  float x0 = uBlade.x - th;
  float exact = (bladeCum(x0 + sweep, a, p) - bladeCum(x0, a, p)) / sweep;
  // por encima de lo que el ojo distingue, la media de la vuelta
  float cover = mix(exact, a / p, smoothstep(0.5, 1.0, sweep / p));
  diffuseColor.rgb *= bladeCol.rgb;
  diffuseColor.a *= clamp(cover, 0.0, 1.0) * step(bladeU, 1.0);
}
`

// Del canto de la pala (borde de ataque o de salida, redondeado) lo que se ve mira al ojo, no hacia
// arriba como su cara: de canto, el disco se ilumina como ese borde y no como un espejo rasante.
const FRAG_NORMAL = /* glsl */ `
{
  vec3 span = normalize(vBladeSpan);
  vec3 eye = normalize(vViewPosition);
  vec3 facing = eye - dot(eye, span) * span;
  normal = normalize(mix(normal, normalize(facing + 1e-4 * normal), bladeEdge));
}
`

// Pasada de albedo: lo que sale es radiancia; se pasa a «albedo equivalente» dividiéndola por la de
// un suelo blanco mate bajo las mismas luces (sol y cielo), que es lo que le aplicará el posproceso.
const FRAG_ALBEDO = /* glsl */ `
{
  vec3 bladeUp = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  vec3 bladeE = ambientLightColor;
  #if NUM_DIR_LIGHTS > 0
  for (int i = 0; i < NUM_DIR_LIGHTS; i++) bladeE += directionalLights[i].color * max(dot(bladeUp, directionalLights[i].direction), 0.0);
  #endif
  #if defined(USE_LIGHT_PROBES)
  bladeE += getLightProbeIrradiance(lightProbe, bladeUp);
  #endif
  gl_FragColor.rgb = min(gl_FragColor.rgb * PI / max(bladeE, vec3(1e-5)), vec3(6.0));
}
`

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

function colorTexture(data: Uint8Array): DataTexture {
  const t = new DataTexture(new Uint8Array(data), BINS, 1, RGBAFormat, UnsignedByteType)
  t.colorSpace = SRGBColorSpace
  return profileTexture(t)
}

/** (media precisión: con 8 bits el borde de la cuña salía a escalones de un radio a otro) */
function shapeTexture(data: Float32Array): DataTexture {
  return profileTexture(new DataTexture(halfFloats(data), BINS, 1, RGBAFormat, HalfFloatType))
}

function profileTexture(t: DataTexture): DataTexture {
  t.magFilter = t.minFilter = LinearFilter
  t.wrapS = t.wrapT = ClampToEdgeWrapping
  t.generateMipmaps = false
  t.needsUpdate = true
  return t
}

function halfFloats(data: Float32Array): Uint16Array {
  const out = new Uint16Array(data.length)
  for (let i = 0; i < data.length; i++) out[i] = DataUtils.toHalfFloat(data[i])
  return out
}

/** Perfil de respaldo (sin modelo que medir): palas rectas de cuerda constante. */
function flatProfile(opt: BladeDiscOptions): Profile {
  const chord = opt.radius * 0.048
  const color = new Uint8Array(BINS * 4)
  const shape = new Float32Array(BINS * 4)
  const c = [opt.fallback.r, opt.fallback.g, opt.fallback.b].map(toSrgb8)
  for (let b = 0; b < BINS; b++) {
    color.set([c[0], c[1], c[2], 0], b * 4)
    shape.set([b < BINS - 1 ? chord : 0, 0, chord * 0.12, 0.45], b * 4)
  }
  return { color, shape, phase: 0, refWidth: chord / (0.7 * opt.radius), rootZ: 0, solid: [] }
}

function toSrgb8(x: number): number {
  const v = x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055
  return Math.round(255 * Math.min(1, Math.max(0, v)))
}

const _m = new Matrix4()
const _r = new Matrix4()
const _v = new Vector3()

/** Triángulos de una malla en los ejes del disco (x, y en su plano; z a lo largo del eje de giro). */
function trianglesOf(mesh: Mesh, spin: Object3D, disc: Object3D): Float32Array {
  // malla → grupo de giro
  mesh.updateMatrix()
  _m.copy(mesh.matrix)
  for (let o = mesh.parent; o && o !== spin; o = o.parent) {
    o.updateMatrix()
    _m.premultiply(o.matrix)
  }
  // grupo de giro (en reposo, los ejes del pivote) → disco, solo su orientación
  _m.premultiply(_r.makeRotationFromQuaternion(disc.quaternion).invert())
  const pos = mesh.geometry.getAttribute('position')
  const idx = mesh.geometry.getIndex()
  const n = idx ? idx.count : pos.count
  const out = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    _v.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(_m)
    out[i * 3] = _v.x
    out[i * 3 + 1] = _v.y
    out[i * 3 + 2] = _v.z
  }
  return out
}

interface Raster {
  size: number
  /** triángulos que tapan cada celda */
  hits: Uint16Array
  /** suma, por celda, de color (lineal), metal y rugosidad de esos triángulos */
  pbr: Float32Array
  zMin: Float32Array
  zMax: Float32Array
}

function newRaster(size: number): Raster {
  return {
    size,
    hits: new Uint16Array(size * size),
    pbr: new Float32Array(size * size * 5),
    zMin: new Float32Array(size * size).fill(Infinity),
    zMax: new Float32Array(size * size).fill(-Infinity),
  }
}

/** Proyecta los triángulos sobre el plano del disco: la rejilla cubre [−extent, extent]². */
function rasterize(ra: Raster, tris: Float32Array, extent: number, pbr: readonly number[]): void {
  const S = ra.size
  const k = S / (2 * extent)
  for (let t = 0; t + 8 < tris.length; t += 9) {
    const ax = (tris[t] + extent) * k
    const ay = (tris[t + 1] + extent) * k
    const az = tris[t + 2]
    const bx = (tris[t + 3] + extent) * k
    const by = (tris[t + 4] + extent) * k
    const bz = tris[t + 5]
    const cx = (tris[t + 6] + extent) * k
    const cy = (tris[t + 7] + extent) * k
    const cz = tris[t + 8]
    const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay)
    if (Math.abs(det) < 1e-6) continue // de canto: no tapa nada visto desde arriba
    const gx = ((bz - az) * (cy - ay) - (cz - az) * (by - ay)) / det
    const gy = ((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) / det
    const zLo = Math.min(az, bz, cz)
    const zHi = Math.max(az, bz, cz)
    const y0 = Math.max(0, Math.ceil(Math.min(ay, by, cy) - 0.5))
    const y1 = Math.min(S - 1, Math.floor(Math.max(ay, by, cy) - 0.5))
    for (let y = y0; y <= y1; y++) {
      const yc = y + 0.5
      let xa = Infinity
      let xb = -Infinity
      if (ay <= yc !== by <= yc) {
        const x = ax + ((yc - ay) * (bx - ax)) / (by - ay)
        xa = Math.min(xa, x)
        xb = Math.max(xb, x)
      }
      if (by <= yc !== cy <= yc) {
        const x = bx + ((yc - by) * (cx - bx)) / (cy - by)
        xa = Math.min(xa, x)
        xb = Math.max(xb, x)
      }
      if (cy <= yc !== ay <= yc) {
        const x = cx + ((yc - cy) * (ax - cx)) / (ay - cy)
        xa = Math.min(xa, x)
        xb = Math.max(xb, x)
      }
      const x0 = Math.max(0, Math.ceil(xa - 0.5))
      const x1 = Math.min(S - 1, Math.ceil(xb - 0.5) - 1)
      for (let x = x0; x <= x1; x++) {
        const i = y * S + x
        const z = Math.min(zHi, Math.max(zLo, az + gx * (x + 0.5 - ax) + gy * (yc - ay)))
        ra.hits[i]++
        for (let c = 0; c < 5; c++) ra.pbr[i * 5 + c] += pbr[c]
        if (z < ra.zMin[i]) ra.zMin[i] = z
        if (z > ra.zMax[i]) ra.zMax[i] = z
      }
    }
  }
}

/** Fracción de la vuelta que tapa la rejilla en el anillo [r0, r1] (fracciones de su radio). */
function ringCover(ra: Raster, r0: number, r1: number): number {
  const S = ra.size
  let all = 0
  let hit = 0
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const r = Math.hypot(x + 0.5 - S / 2, y + 0.5 - S / 2) / (S / 2)
      if (r < r0 || r > r1) continue
      all++
      if (ra.hits[y * S + x]) hit++
    }
  }
  return all ? hit / all : 0
}

/** color (lineal), metal y rugosidad del material de una malla */
function pbrOf(mesh: Mesh, fallback: Color): number[] {
  const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as MeshStandardMaterial | undefined
  if (!mat?.color) return [fallback.r, fallback.g, fallback.b, 0, 0.45]
  return [mat.color.r, mat.color.g, mat.color.b, mat.metalness ?? 0, mat.roughness ?? 0.45]
}

function analyse(meshes: Mesh[], spin: Object3D, disc: Object3D, opt: BladeDiscOptions, keep: (m: Mesh) => boolean): Profile {
  const R = opt.radius
  const N = opt.blades
  const period = TAU / N
  const tris = meshes.map((m) => trianglesOf(m, spin, disc))

  // piezas de revolución (cono de la hélice, buje, platos): giren o no, se ven igual → se quedan como están
  const solid = meshes.map((m, i) => {
    if (keep(m)) return true
    const t = tris[i]
    let rMax = 0
    for (let j = 0; j < t.length; j += 3) rMax = Math.max(rMax, Math.hypot(t[j], t[j + 1]))
    if (rMax < 1e-3) return true
    const ra = newRaster(96)
    rasterize(ra, t, rMax, [0, 0, 0, 0, 0])
    return ringCover(ra, 0.3, 0.9) > 0.6
  })

  const ra = newRaster(GRID)
  meshes.forEach((m, i) => {
    if (!solid[i]) rasterize(ra, tris[i], R, pbrOf(m, opt.fallback))
  })

  const all = new Float64Array(BINS)
  const hit = new Float64Array(BINS)
  const pbr = new Float64Array(BINS * 5)
  const zLo = new Float64Array(BINS).fill(Infinity)
  const zHi = new Float64Array(BINS).fill(-Infinity)
  const co = new Float64Array(BINS)
  const si = new Float64Array(BINS)
  let rootZ = 0
  let rootN = 0
  const S = GRID
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = x + 0.5 - S / 2
      const dy = y + 0.5 - S / 2
      const r = Math.hypot(dx, dy) / (S / 2)
      if (r >= 1) continue
      const b = Math.floor(r * BINS)
      all[b]++
      const i = y * S + x
      const h = ra.hits[i]
      if (!h) continue
      hit[b]++
      for (let c = 0; c < 5; c++) pbr[b * 5 + c] += ra.pbr[i * 5 + c] / h
      if (ra.zMin[i] < zLo[b]) zLo[b] = ra.zMin[i]
      if (ra.zMax[i] > zHi[b]) zHi[b] = ra.zMax[i]
      const th = Math.atan2(dy, dx) * N
      co[b] += Math.cos(th)
      si[b] += Math.sin(th)
      if (r > 0.15 && r < 0.5) {
        rootZ += (ra.zMin[i] + ra.zMax[i]) / 2
        rootN++
      }
    }
  }

  // acimut de las palas: media circular (de periodo 2π/N) de lo que hay de media pala hacia fuera
  let C = 0
  let Sn = 0
  for (let b = Math.floor(BINS * 0.35); b < BINS; b++) {
    C += co[b]
    Sn += si[b]
  }
  const phase = Math.atan2(Sn, C) / N

  const chord = new Float64Array(BINS)
  const height = new Float64Array(BINS)
  const off = new Float64Array(BINS)
  let any = false
  for (let b = 0; b < BINS; b++) {
    if (!hit[b]) continue
    const rMid = ((b + 0.5) / BINS) * R
    chord[b] = Math.min(1, hit[b] / all[b]) * period * rMid
    height[b] = Math.min(zHi[b] - zLo[b], 0.5)
    // desfase de este radio respecto al acimut común (palas en flecha o curvas)
    const d = Math.atan2(si[b], co[b]) / N - phase
    off[b] = d - Math.round(d / period) * period
    any = true
  }
  if (!any) return { ...flatProfile(opt), solid }

  // Cada tramo mide un par de celdas de la rejilla: tramo a tramo las medidas bailan y el borde
  // de la cuña salía rizado. Las palas son lisas: media de los tramos vecinos (los que tienen pala).
  const blur = (v: Float64Array, w: number): Float64Array => {
    const out = new Float64Array(BINS)
    for (let b = 0; b < BINS; b++) {
      if (!hit[b]) continue
      let sum = 0
      let n = 0
      for (let k = Math.max(0, b - w); k <= Math.min(BINS - 1, b + w); k++) {
        if (!hit[k]) continue
        sum += v[k] * hit[k]
        n += hit[k]
      }
      out[b] = sum / n
    }
    return out
  }
  const chordS = blur(chord, 2)
  const heightS = blur(height, 2)
  const offS = blur(off, 5)

  // los tramos vacíos toman color, desfase y canto del tramo con pala más cercano (el filtrado
  // lineal mezcla vecinos) y cuerda cero
  let near = -1
  const nearest = new Int32Array(BINS)
  for (let b = 0; b < BINS; b++) {
    if (hit[b]) near = b
    nearest[b] = near
  }
  near = -1
  for (let b = BINS - 1; b >= 0; b--) {
    if (hit[b]) near = b
    if (near >= 0 && (nearest[b] < 0 || near - b < b - nearest[b])) nearest[b] = near
  }
  const color = new Uint8Array(BINS * 4)
  const shape = new Float32Array(BINS * 4)
  for (let b = 0; b < BINS; b++) {
    const s = nearest[b]
    color[b * 4] = toSrgb8(pbr[s * 5] / hit[s])
    color[b * 4 + 1] = toSrgb8(pbr[s * 5 + 1] / hit[s])
    color[b * 4 + 2] = toSrgb8(pbr[s * 5 + 2] / hit[s])
    color[b * 4 + 3] = Math.round((255 * pbr[s * 5 + 3]) / hit[s])
    shape[b * 4] = chordS[b]
    shape[b * 4 + 1] = offS[s]
    shape[b * 4 + 2] = heightS[s]
    shape[b * 4 + 3] = Math.min(1, Math.max(0.04, pbr[s * 5 + 4] / hit[s]))
  }

  let ref = 0
  let refN = 0
  for (let b = Math.floor(BINS * 0.6); b < BINS * 0.8; b++) {
    ref += chord[b]
    refN++
  }
  return { color, shape, phase, refWidth: ref / refN / (0.7 * R), rootZ: rootN ? rootZ / rootN : 0, solid }
}
