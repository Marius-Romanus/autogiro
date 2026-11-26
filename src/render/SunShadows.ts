// Sombras del sol que proyectan edificios y árboles, y sombra de las nubes sobre todo
// lo que se ilumina con luces reales (edificios, árboles, el aparato).
//
// - Cuatro cascadas centradas en la cámara (radios crecientes) en un atlas 2×2 de
//   profundidad. Centradas en la cámara y no ajustadas al encuadre: girar la vista no
//   las mueve (no titilan) y al desplazarse se fijan a la rejilla de texeles. Las lejanas
//   se redibujan cada pocos fotogramas: cada una guarda la matriz con la que se dibujó.
// - Proyectan sombra las capas por teselas (edificios, árboles: userData.worldShadowCaster).
//   Se dibujan sus caras traseras, como hace three.js: una cara iluminada nunca se
//   sombrea a sí misma (sin "acné"), y las que dan la espalda al sol ya están oscuras.
// - Las reciben: el terreno, que se ilumina en posproceso (canal G de la máscara de
//   iluminación, que el efecto de atmósfera multiplica por la luz del sol), y los
//   materiales iluminados, parcheados al dibujarse por primera vez: la luz direccional
//   (el sol) se multiplica por la sombra del mundo y por la de las nubes. La sombra del
//   aparato sobre el terreno (ShadowMaterial) se apaga donde el sol ya no llega.

import {
  BackSide,
  DataArrayTexture,
  DepthFormat,
  DepthTexture,
  LessEqualCompare,
  LinearFilter,
  Material,
  Matrix4,
  Mesh,
  MeshDepthMaterial,
  MeshLambertMaterial,
  MeshPhongMaterial,
  MeshStandardMaterial,
  OrthographicCamera,
  PlaneGeometry,
  RedFormat,
  Scene,
  ShaderChunk,
  ShaderMaterial,
  ShadowMaterial,
  Uniform,
  UnsignedIntType,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type Camera,
  type Object3D,
  type PerspectiveCamera,
  type Texture,
  type WebGLRenderer,
} from 'three'
import { Pass } from 'postprocessing'
import type { Quality } from '../config.ts'
import { WATER_MASK_GLSL, waterMaskUniforms } from './Water.ts'

/** Capa en la que se dibujan los que proyectan sombra (solo la ven las cámaras de sombra). */
export const WORLD_SHADOW_LAYER = 14

/**
 * Luz ambiente donde está el que mira, a la que se adapta el ojo: iluminancia horizontal en
 * unidades de escena (sol tras edificios, árboles y nubes, luz difusa de las nubes y cielo; el
 * sol de mediodía da ~1,3). La calcula Graphics cada fotograma; NaN mientras no hay datos.
 * La usan los focos de aterrizaje.
 */
export const viewerLight = { illuminance: Number.NaN }
const N = 4

const mat4s = (): Matrix4[] => Array.from({ length: N }, () => new Matrix4())

/** Sombras de edificios y árboles: compartidas por todos los materiales que las reciben. */
export const wsUniforms = {
  wsMap: new Uniform<Texture | null>(null),
  /** mundo → [0,1]³ de cada cascada */
  wsMatrix: new Uniform(mat4s()),
  /** lado del texel (m) de cada cascada */
  wsTexel: new Uniform(new Vector4(1, 1, 1, 1)),
  /** profundidad (m) del volumen de cada cascada */
  wsDepth: new Uniform(new Vector4(1, 1, 1, 1)),
  /** x: distancia a la que se empiezan a apagar, y: a la que desaparecen, z: encendidas */
  wsFade: new Uniform(new Vector3(0, 1, 0)),
  /** lado de un texel del atlas, en coordenadas de textura */
  wsTexelUv: new Uniform(1),
}

/** textura vacía para el mapa de nubes cuando no hay nubes (el muestreador necesita una) */
export const EMPTY_CLOUD_SHADOW = emptyArrayTexture()

/** Sombras de las nubes (mapas de la librería de nubes) para los materiales iluminados. */
export const csUniforms = {
  csMap: new Uniform<Texture>(EMPTY_CLOUD_SHADOW),
  csMatrix: new Uniform(mat4s()),
  csInterval: new Uniform(Array.from({ length: N }, () => new Vector2())),
  /** x: near de la cámara, y: alcance de las sombras, z: cascadas, w: encendidas */
  csParams: new Uniform(new Vector4()),
  /** x: altura elipsoidal de la cámara, y: coseno del cenit del sol, z: techo de las sombras, w: radio del suelo */
  csGeo: new Uniform(new Vector4(0, 1, 0, 6360000)),
  /** vertical en la cámara (mundo) */
  csUp: new Uniform(new Vector3(0, 1, 0)),
  /** cámara (mundo) */
  csCam: new Uniform(new Vector3()),
}

const WS_GLSL = /* glsl */ `
uniform sampler2DShadow wsMap;
uniform mat4 wsMatrix[4];
uniform vec4 wsTexel;
uniform vec4 wsDepth;
uniform vec3 wsFade;
uniform float wsTexelUv;

// Luz del sol que llega a p (1 = toda) según edificios y árboles. n: normal para
// desplazar el punto (offset en texeles); dist: distancia a la cámara.
float wsShadow(vec3 p, vec3 n, float dist, float offset) {
  if (wsFade.z < 0.5 || dist >= wsFade.y) return 1.0;
  for (int i = 0; i < 4; i++) {
    float tx = wsTexel[i];
    vec4 c = wsMatrix[i] * vec4(p + n * (offset * tx), 1.0);
    if (c.x > 0.02 && c.x < 0.98 && c.y > 0.02 && c.y < 0.98 && c.z < 1.0) {
      vec2 uv = c.xy * 0.5 + 0.5 * vec2(float(i - (i / 2) * 2), float(i / 2));
      float z = c.z - 0.6 * tx / wsDepth[i];
      // 3×3 muestras bilineales a un texel: borde suave de ~3 texeles, sin escalones
      float d = wsTexelUv;
      float s = 0.0;
      for (int k = 0; k < 9; k++) {
        vec2 o = vec2(float(k - (k / 3) * 3 - 1), float(k / 3 - 1)) * d;
        s += texture(wsMap, vec3(uv + o, z));
      }
      return mix(s / 9.0, 1.0, smoothstep(wsFade.x, wsFade.y, dist));
    }
  }
  return 1.0;
}
`

/**
 * Luz que atraviesa una capa de nubes de espesor óptico τ, difundida (dos flujos, dispersión
 * sin absorción, asimetría g = 0,85): T ≈ 1 / (1 + ¾(1 − g)τ), menos la parte directa e^−τ.
 * Bajo un cubierto (τ 10–20) llega un 30–50 % de la luz del sol, gris y desde todo el cielo;
 * sin esto, bajo las nubes solo quedaba el cielo azul despejado y a mediodía parecía de noche.
 */
const CLOUD_DIFFUSE_GLSL = /* glsl */ `
float wsCloudDiffuse(float od) {
  return max(1.0 / (1.0 + 0.1125 * od) - exp(-od), 0.0);
}
`

const CS_GLSL = /* glsl */ `
uniform highp sampler2DArray csMap;
uniform mat4 csMatrix[4];
uniform vec2 csInterval[4];
uniform vec4 csParams;
uniform vec4 csGeo;
uniform vec3 csUp;
uniform vec3 csCam;

// Espesor óptico de las nubes hacia el sol en p (como el efecto de atmósfera con el terreno).
float csOpticalDepth(vec3 p, float viewZ) {
  if (csParams.w < 0.5) return 0.0;
  int count = int(csParams.z + 0.5);
  float depth = (viewZ + csParams.x) / (csParams.x - csParams.y);
  int idx = count - 1;
  for (int i = 0; i < 4; i++) {
    if (i >= count) break;
    if (depth >= csInterval[i].x && depth < csInterval[i].y) {
      idx = i;
      break;
    }
  }
  vec4 clip = csMatrix[idx] * vec4(p, 1.0);
  vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
  // r: frente de la nube, g: extinción media, b: espesor óptico máximo
  vec4 s = texture(csMap, vec3(uv, float(idx)));
  // distancia hasta el techo de las sombras siguiendo el rayo del sol, sin restar
  // radios terrestres (en float pierde metros): t = q / (r·μ + sqrt(r²μ² + q))
  float h = csGeo.x + dot(p - csCam, csUp);
  float dlt = csGeo.z - h;
  if (dlt <= 0.0) return 0.0;
  float r = csGeo.w + h;
  float mu = csGeo.y;
  float q = dlt * (2.0 * r + dlt);
  float t = q / (r * mu + sqrt(max(r * r * mu * mu + q, 0.0)));
  return min(s.b, s.g * max(0.0, t - s.r));
}

${CLOUD_DIFFUSE_GLSL}

// x: sol directo que llega a p (edificios, árboles y nubes); y: luz difusa que dejan pasar
// las nubes, en fracción de la que daría el sol sobre un plano horizontal
vec2 wsSun2(vec3 p, vec3 n, float offset) {
  vec3 v = (viewMatrix * vec4(p, 1.0)).xyz;
  float od = csOpticalDepth(p, v.z);
  return vec2(wsShadow(p, n, length(v), offset) * exp(-od), wsCloudDiffuse(od));
}

float wsSun(vec3 p, vec3 n, float offset) {
  return wsSun2(p, n, offset).x;
}
`

// ---------------------------------------------------------------------------
// Materiales que reciben las sombras
// ---------------------------------------------------------------------------

const patched = new WeakSet<Material>()
let warned = false

function patchShader(shader: { vertexShader: string; fragmentShader: string; uniforms: Record<string, unknown> }, shadowOnly: boolean): void {
  let vs = shader.vertexShader
  let fs = shader.fragmentShader
  if (fs.includes('wsSun(')) return // ya parcheado (material clonado con el parche)
  if (!vs.includes('#include <project_vertex>') || !vs.includes('#include <common>') || !fs.includes('#include <common>')) return fail()
  if (shadowOnly) {
    const target = 'gl_FragColor = vec4( color, opacity * ( 1.0 - getShadowMask() ) );'
    if (!fs.includes(target)) return fail()
    // la sombra del aparato no se ve donde el sol ya está tapado (edificio, árbol, nube)
    fs = fs.replace(target, 'gl_FragColor = vec4( color, opacity * ( 1.0 - getShadowMask() ) * wsSun( vWsPos, vec3( 0.0 ), 0.0 ) );')
  } else {
    // la luz difusa de las nubes se suma a la indirecta al final del trozo de luces
    if (fs.includes('#include <lights_fragment_begin>'))
      fs = fs.replace(
        '#include <lights_fragment_begin>',
        `${ShaderChunk.lights_fragment_begin}\n#if defined( RE_IndirectDiffuse )\n\tirradiance += wsCloudIrr;\n#endif`,
      )
    const dir = 'getDirectionalLightInfo( directionalLight, directLight );'
    if (!fs.includes(dir) || !fs.includes('#include <normal_fragment_begin>') || !fs.includes('irradiance += wsCloudIrr;')) return fail()
    fs = fs
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nvec3 wsN = inverseTransformDirection( normal, viewMatrix );')
      .replace(
        'vec3 geometryPosition = - vViewPosition;',
        /* glsl */ `vec2 wsSunV = wsSun2( vWsPos, wsN, 0.5 );
float wsSunK = wsSunV.x;
// difusa de las nubes: con el color del sol, desde el cielo de arriba (coseno con la vertical)
vec3 wsUpV = normalize( ( viewMatrix * vec4( csUp, 0.0 ) ).xyz );
float wsCloudK = wsSunV.y * max( csGeo.y, 0.0 ) * 0.5 * ( 1.0 + dot( normal, wsUpV ) );
vec3 wsCloudIrr = vec3( 0.0 );
vec3 geometryPosition = - vViewPosition;`,
      )
      .replace(dir, `${dir}\n\t\twsCloudIrr += directLight.color * wsCloudK;\n\t\tdirectLight.color *= wsSunK;`)
    if (!fs.includes('float wsSunK')) return fail()
  }
  vs = vs.replace('#include <common>', '#include <common>\nvarying vec3 vWsPos;').replace(
    '#include <project_vertex>',
    /* glsl */ `#include <project_vertex>
    {
      vec4 wsP = vec4( transformed, 1.0 );
      #ifdef USE_BATCHING
      wsP = batchingMatrix * wsP;
      #endif
      #ifdef USE_INSTANCING
      wsP = instanceMatrix * wsP;
      #endif
      vWsPos = ( modelMatrix * wsP ).xyz;
    }`,
  )
  fs = fs.replace('#include <common>', `#include <common>\nvarying vec3 vWsPos;\n${WS_GLSL}\n${CS_GLSL}`)
  shader.vertexShader = vs
  shader.fragmentShader = fs
  Object.assign(shader.uniforms, wsUniforms, csUniforms)

  function fail(): void {
    if (!warned) console.warn('SunShadows: material sin los trozos de shader esperados; se queda sin sombras del mundo')
    warned = true
  }
}

/** Hace que el material reciba las sombras de edificios, árboles y nubes. */
export function receiveWorldShadows(m: Material): void {
  if (patched.has(m)) return
  patched.add(m)
  const shadowOnly = (m as ShadowMaterial).isShadowMaterial === true
  const prev = m.onBeforeCompile
  const ownKey = m.customProgramCacheKey !== Material.prototype.customProgramCacheKey
  const prevKey = m.customProgramCacheKey
  const prevSrc = prev.toString()
  m.onBeforeCompile = function (this: Material, shader, renderer) {
    prev.call(this, shader, renderer)
    patchShader(shader, shadowOnly)
  }
  // la clave por defecto es el texto de onBeforeCompile: la de la función original
  m.customProgramCacheKey = function (this: Material) {
    return `${ownKey ? prevKey.call(this) : prevSrc}|ws1`
  }
  m.needsUpdate = true
}

function patchObject(o: Object3D): void {
  const mat = (o as { material?: Material | Material[] }).material
  if (!mat) return
  for (const m of Array.isArray(mat) ? mat : [mat]) if (isReceiver(m)) receiveWorldShadows(m)
}

function isReceiver(m: Material): boolean {
  const a = m as unknown as Record<string, boolean>
  return a.isMeshStandardMaterial || a.isMeshLambertMaterial || a.isMeshPhongMaterial || a.isShadowMaterial
}

let hooksInstalled = false

/**
 * Parchea cada material iluminado justo antes de compilarse por primera vez (sin tocar
 * cada sitio donde se crean): onBeforeRender del material va antes de elegir programa.
 */
export function installWorldShadowHooks(renderer: WebGLRenderer): void {
  if (!hooksInstalled) {
    hooksInstalled = true
    for (const C of [MeshStandardMaterial, MeshLambertMaterial, MeshPhongMaterial, ShadowMaterial]) {
      const proto = C.prototype as Material
      const orig = proto.onBeforeRender
      proto.onBeforeRender = function (this: Material, ...args: Parameters<Material['onBeforeRender']>) {
        if (!patched.has(this)) receiveWorldShadows(this)
        orig.apply(this, args)
      }
    }
  }
  // compile/compileAsync no llaman a onBeforeRender: parchear antes de precompilar
  const compile = renderer.compile.bind(renderer)
  renderer.compile = ((scene: Object3D, camera, target) => {
    scene.traverse(patchObject)
    return compile(scene, camera, target)
  }) as WebGLRenderer['compile']
}

// ---------------------------------------------------------------------------
// Mapas de sombra en cascada
// ---------------------------------------------------------------------------

const BIAS = new Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
/** radio mínimo de cada cascada (m) y cuánto crece con la altura de la cámara sobre el suelo */
const BASE_RADII = [35, 170, 800, 3500]
const AGL_SCALE = [1.2, 2.5, 6, 0]
/** cada cuántos fotogramas se redibuja cada cascada (los que proyectan no se mueven) */
const PERIOD = [1, 1, 2, 3]

export class SunShadows {
  enabled = false
  private size = 0
  private target: WebGLRenderTarget
  private readonly cams = Array.from({ length: N }, () => new OrthographicCamera())
  private readonly depthMaterial = new MeshDepthMaterial({ side: BackSide })
  private readonly radii = BASE_RADII.slice()
  private frame = 0
  private forceAll = true
  /** el mapa ya existe en la GPU (borrado al menos una vez) */
  private initialized = false
  private readonly lastFrame = new Matrix4()

  constructor() {
    this.depthMaterial.colorWrite = false
    for (const c of this.cams) {
      c.layers.set(WORLD_SHADOW_LAYER)
      c.matrixAutoUpdate = true
    }
    this.target = this.makeTarget(1)
  }

  /** Sin sombras en calidad baja (GPU integrada); el mapa crece con la calidad. */
  setQuality(q: Quality): void {
    this.enabled = q !== 'low'
    const size = { low: 1, medium: 1024, high: 2048, ultra: 3072 }[q]
    if (size !== this.size) {
      this.target.depthTexture?.dispose()
      this.target.dispose()
      this.target = this.makeTarget(size)
      this.forceAll = true
    }
    if (!this.enabled) wsUniforms.wsFade.value.z = 0
  }

  /**
   * Redibuja las cascadas que tocan. worldToECEF: si cambia (re-centrado del mundo)
   * las coordenadas de las guardadas ya no valen y se redibujan todas.
   */
  render(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera, sunDir: Vector3, agl: number, worldToECEF: Matrix4): void {
    const u = wsUniforms
    if (!this.initialized) {
      // Un mapa que nunca se ha dibujado no existe en la GPU, y muestrearlo con sampler2DShadow
      // invalida el dibujo (INVALID_OPERATION): sin esto, en calidad baja o empezando de noche no
      // se veían el aparato, los edificios ni los árboles. Se borra a "todo al sol".
      this.initialized = true
      const prev = renderer.getRenderTarget()
      this.target.scissorTest = false
      this.target.viewport.set(0, 0, this.target.width, this.target.height)
      renderer.setRenderTarget(this.target)
      renderer.clear(false, true, false)
      renderer.setRenderTarget(prev)
    }
    if (!this.enabled || sunDir.y < 0.005) {
      u.wsFade.value.z = 0
      this.forceAll = true
      return
    }
    if (!this.lastFrame.equals(worldToECEF)) {
      this.lastFrame.copy(worldToECEF)
      this.forceAll = true
    }
    this.markCasters(scene)
    this.markLights(scene)
    this.updateRadii(agl)

    const prevTarget = renderer.getRenderTarget()
    const prevOverride = scene.overrideMaterial
    const prevAutoShadow = renderer.shadowMap.autoUpdate
    const prevAutoClear = renderer.autoClear
    const prevMatrixAuto = scene.matrixWorldAutoUpdate
    const prevSort = renderer.sortObjects
    // solo se escribe profundidad: el orden de dibujo da igual
    renderer.sortObjects = false
    renderer.shadowMap.autoUpdate = false
    renderer.autoClear = false
    scene.overrideMaterial = this.depthMaterial
    // las matrices de los que proyectan ya están al día (son fijos en el mundo)
    scene.matrixWorldAutoUpdate = false
    const t = this.target
    const s = this.size
    try {
      for (let i = 0; i < N; i++) {
        if (!this.forceAll && (this.frame + i) % PERIOD[i] !== 0) continue
        const cam = this.fit(i, camera, sunDir)
        t.viewport.set((i % 2) * s, Math.floor(i / 2) * s, s, s)
        t.scissor.copy(t.viewport)
        t.scissorTest = true
        renderer.setRenderTarget(t)
        renderer.clear(false, true, false)
        renderer.render(scene, cam)
      }
    } finally {
      t.scissorTest = false
      scene.overrideMaterial = prevOverride
      scene.matrixWorldAutoUpdate = prevMatrixAuto
      renderer.sortObjects = prevSort
      renderer.shadowMap.autoUpdate = prevAutoShadow
      renderer.autoClear = prevAutoClear
      renderer.setRenderTarget(prevTarget)
    }
    this.forceAll = false
    this.frame++
    const far = this.radii[N - 1]
    u.wsFade.value.set(far * 0.8, far * 0.97, 1)
  }

  dispose(): void {
    this.target.depthTexture?.dispose()
    this.target.dispose()
    this.depthMaterial.dispose()
  }

  private makeTarget(size: number): WebGLRenderTarget {
    this.size = size
    const depth = new DepthTexture(2 * size, 2 * size, UnsignedIntType)
    depth.format = DepthFormat
    depth.compareFunction = LessEqualCompare
    depth.minFilter = LinearFilter
    depth.magFilter = LinearFilter
    const t = new WebGLRenderTarget(2 * size, 2 * size, {
      format: RedFormat,
      depthBuffer: true,
      depthTexture: depth,
      generateMipmaps: false,
    })
    wsUniforms.wsMap.value = depth
    wsUniforms.wsTexelUv.value = 1 / (2 * size)
    this.initialized = false
    return t
  }

  private markCasters(scene: Scene): void {
    for (const child of scene.children) {
      if (child.userData.worldShadowCaster) child.traverse((o) => o.layers.enable(WORLD_SHADOW_LAYER))
    }
  }

  /**
   * Las luces de la escena, también a la vista de las cámaras de las cascadas. No alumbran nada
   * ahí (se dibuja solo profundidad), pero three.js lleva la cuenta de las luces de la escena en
   * cada dibujo: si las cascadas no ven ninguna, la cuenta cambia dos veces por fotograma (0 en
   * las cascadas, las de verdad en la escena) y cada material iluminado —unos setenta entre el
   * aparato, edificios, árboles y tráfico— vuelve a calcular de cero qué programa le toca en cada
   * fotograma (≈1 ms de CPU, visto con la telemetría). Con las luces en la capa, la cuenta no cambia.
   */
  private markLights(scene: Scene): void {
    // (las luces casi nunca cambian: el foco de aterrizaje, al cargar otro aparato)
    if (!this.forceAll && this.frame % 30 !== 0) return
    scene.traverse((o) => {
      if ((o as { isLight?: boolean }).isLight) o.layers.enable(WORLD_SHADOW_LAYER)
    })
  }

  /** Radios por escalones de √2 (cambiarlos de continuo haría titilar los bordes). */
  private updateRadii(agl: number): void {
    const h = Math.max(0, agl)
    for (let i = 0; i < N; i++) {
      const want = Math.max(BASE_RADII[i], AGL_SCALE[i] * h)
      const r = BASE_RADII[i] * 2 ** (Math.ceil(Math.log2(want / BASE_RADII[i]) * 2) / 2)
      const capped = Math.min(r, BASE_RADII[N - 1])
      if (capped !== this.radii[i]) {
        this.radii[i] = capped
        if (i < N - 1) this.forceAll = true
      }
    }
  }

  private fit(i: number, camera: PerspectiveCamera, sunDir: Vector3): OrthographicCamera {
    const r = this.radii[i]
    const texel = (2 * r) / this.size
    _lz.copy(sunDir).normalize()
    _up.set(0, 1, 0)
    if (Math.abs(_lz.y) > 0.999) _up.set(0, 0, 1)
    _lx.crossVectors(_up, _lz).normalize()
    _ly.crossVectors(_lz, _lx)
    camera.getWorldPosition(_p)
    // centro en la cámara, fijado a la rejilla de texeles en el plano del sol
    const cx = Math.round(_p.dot(_lx) / texel) * texel
    const cy = Math.round(_p.dot(_ly) / texel) * texel
    const cz = _p.dot(_lz)
    // hacia el sol, lo bastante para que entren torres que no están en la esfera
    const extra = Math.min(6000, 350 / Math.max(_lz.y, 0.06))
    const cam = this.cams[i]
    cam.position.set(0, 0, 0).addScaledVector(_lx, cx).addScaledVector(_ly, cy).addScaledVector(_lz, cz + r + extra)
    cam.quaternion.setFromRotationMatrix(_m.makeBasis(_lx, _ly, _lz))
    cam.left = -r
    cam.right = r
    cam.top = r
    cam.bottom = -r
    cam.near = 0
    cam.far = 2 * r + extra
    cam.updateProjectionMatrix()
    cam.updateMatrixWorld(true)
    wsUniforms.wsMatrix.value[i].multiplyMatrices(BIAS, cam.projectionMatrix).multiply(cam.matrixWorldInverse)
    wsUniforms.wsTexel.value.setComponent(i, texel)
    wsUniforms.wsDepth.value.setComponent(i, cam.far - cam.near)
    return cam
  }
}

// ---------------------------------------------------------------------------
// Máscara de iluminación + sombra sobre el terreno
// ---------------------------------------------------------------------------

/**
 * R: máscara de iluminación (0 = píxel de un objeto ya iluminado, alfa 0 en el render;
 * binaria porque el terreno escribe alfas intermedios al fundir niveles de detalle).
 * G: luz del sol que llega al terreno (edificios y árboles), que el efecto de atmósfera
 * multiplica por la irradiancia solar.
 * B: cuánta agua hay en el píxel y A: cuánto oleaje admite (máscara mundial de agua,
 * Water.ts), para que el efecto de atmósfera la ilumine como agua.
 */
export class ShadowMaskPass extends Pass {
  private readonly target = new WebGLRenderTarget(1, 1, { depthBuffer: false })
  private readonly cam: PerspectiveCamera
  private readonly material: ShaderMaterial

  constructor(camera: PerspectiveCamera) {
    super('ShadowMaskPass')
    this.cam = camera
    this.needsSwap = false
    this.needsDepthTexture = true
    this.material = new ShaderMaterial({
      uniforms: {
        inputBuffer: new Uniform(null),
        depthBuffer: new Uniform(null),
        camWorld: new Uniform(new Matrix4()),
        camProjInv: new Uniform(new Matrix4()),
        logFar: new Uniform(1),
        ...wsUniforms,
        ...waterMaskUniforms,
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = position.xy * 0.5 + 0.5;
          gl_Position = vec4(position.xy, 1.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D inputBuffer;
        uniform sampler2D depthBuffer;
        uniform mat4 camWorld;
        uniform mat4 camProjInv;
        uniform float logFar;
        ${WS_GLSL}
        ${WATER_MASK_GLSL}
        varying vec2 vUv;
        void main() {
          vec4 src = texture2D(inputBuffer, vUv);
          float mask = step(0.002, src.a);
          float sun = 1.0;
          vec2 water = vec2(0.0);
          if (mask > 0.5 && (wsFade.z > 0.5 || wtOn > 0.5)) {
            float d = texture2D(depthBuffer, vUv).r;
            if (d < 1.0) {
              // profundidad logarítmica de three.js: d = log2(1 + w) / log2(far + 1)
              float w = exp2(d * logFar) - 1.0;
              // dirección por el plano cercano: en el lejano (far = 4000 km) la inversa
              // de la proyección da w ≈ 1/far por resta de números casi iguales → NaN
              vec4 v = camProjInv * vec4(vUv * 2.0 - 1.0, -1.0, 1.0);
              vec3 view = v.xyz / v.w;
              view *= w / -view.z;
              vec3 world = (camWorld * vec4(view, 1.0)).xyz;
              // el terreno no proyecta: sin desplazamiento por la normal
              if (wsFade.z > 0.5) sun = wsShadow(world, vec3(0.0), length(view), 0.0);
              if (wtOn > 0.5) water = wtWater(world, length(view), src.rgb);
            }
          }
          gl_FragColor = vec4(mask, sun, water);
        }`,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })
    this.fullscreenMaterial = this.material
  }

  get texture(): Texture {
    return this.target.texture
  }

  override setDepthTexture(depthTexture: Texture): void {
    this.material.uniforms.depthBuffer.value = depthTexture
  }

  override render(renderer: WebGLRenderer, inputBuffer: WebGLRenderTarget): void {
    const u = this.material.uniforms
    u.inputBuffer.value = inputBuffer.texture
    u.camWorld.value.copy(this.cam.matrixWorld)
    u.camProjInv.value.copy(this.cam.projectionMatrixInverse)
    u.logFar.value = Math.log2(this.cam.far + 1)
    // ángulo de un píxel: la orilla del agua se dibuja nítida de cerca y suave de lejos
    waterMaskUniforms.wtPix.value = (2 * Math.tan((this.cam.fov * Math.PI) / 360)) / Math.max(this.target.height, 1)
    renderer.setRenderTarget(this.target)
    renderer.render(this.scene, this.camera)
  }

  override setSize(width: number, height: number): void {
    this.target.setSize(width, height)
  }
}

/**
 * Sonda de la luz del sol en un punto (el aparato): las mismas cuentas que los materiales (sombra
 * de edificios y árboles, espesor de las nubes) hechas en la GPU, y leídas sin pararla.
 * x: sol directo que llega (0–1), y: difusa de las nubes (fracción del sol sobre un plano
 * horizontal); los dos con 8 bits, como el píxel que se leía antes.
 *
 * La lectura es por consultas de oclusión, una por bit: dieciséis cuadrados de un píxel que se
 * descartan o no según el bit que les toca del valor, y la consulta dice si llegó a pintarse
 * algo. Sus resultados llegan uno o dos fotogramas después y preguntar por ellos no espera a
 * nada. Leer el píxel (readPixels, también «asíncrono» con búfer y fenceSync) sí espera: recoger
 * el dato es una ida y vuelta al proceso de la GPU, que antes despacha todo lo que tenga en cola,
 * y el hilo principal se quedaba parado varios milisegundos cinco veces por segundo
 * (`getBufferSubData`, 4 % del tiempo en el perfil de CPU).
 */
export class SunProbe {
  readonly value = new Vector2(1, 0)
  /** punto (mundo) que se mide */
  readonly position = new Vector3()
  private readonly target = new WebGLRenderTarget(1, 1, { depthBuffer: false })
  private readonly scene = new Scene()
  private timer = 0
  private gl: WebGL2RenderingContext | null = null
  /** una consulta por bit: 0–7 el sol directo, 8–15 la difusa de las nubes */
  private queries: WebGLQuery[] = []
  /** hay una medida esperando sus resultados */
  private pending = false

  constructor() {
    const geometry = new PlaneGeometry(2, 2)
    for (let bit = 0; bit < 16; bit++) {
      // (mismo programa para los dieciséis: solo cambia el uniforme)
      const material = new ShaderMaterial({
        uniforms: { probePos: new Uniform(this.position), probeBit: new Uniform(bit), ...wsUniforms, ...csUniforms },
        vertexShader: /* glsl */ `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`,
        fragmentShader: /* glsl */ `
          uniform vec3 probePos;
          uniform int probeBit;
          ${WS_GLSL}
          ${CS_GLSL}
          void main() {
            vec2 v = clamp(wsSun2(probePos, vec3(0.0), 0.0), 0.0, 1.0);
            // el byte que guardaría un búfer de 8 bits por canal, y de él el bit de esta consulta
            int q = int(floor((probeBit < 8 ? v.x : v.y) * 255.0 + 0.5));
            int b = probeBit < 8 ? probeBit : probeBit - 8;
            if (((q >> b) & 1) == 0) discard;
            gl_FragColor = vec4(1.0);
          }`,
        depthTest: false,
        depthWrite: false,
      })
      const quad = new Mesh(geometry, material)
      quad.frustumCulled = false
      quad.renderOrder = bit
      quad.onBeforeRender = () => this.gl!.beginQuery(this.gl!.ANY_SAMPLES_PASSED, this.queries[bit])
      quad.onAfterRender = () => this.gl!.endQuery(this.gl!.ANY_SAMPLES_PASSED)
      this.scene.add(quad)
    }
  }

  /** Recoge la medida pendiente si sus resultados ya han llegado (no espera a la GPU). */
  poll(): void {
    const gl = this.gl
    if (!this.pending || !gl || gl.isContextLost()) return
    const last = this.queries[15]
    if (!gl.isQuery(last)) {
      // contexto restaurado: las consultas de antes ya no existen
      this.queries = []
      this.pending = false
      return
    }
    // (acaban en orden: si está la última, están todas)
    if (!gl.getQueryParameter(last, gl.QUERY_RESULT_AVAILABLE)) return
    let x = 0
    let y = 0
    for (let b = 0; b < 8; b++) {
      if (gl.getQueryParameter(this.queries[b], gl.QUERY_RESULT)) x |= 1 << b
      if (gl.getQueryParameter(this.queries[b + 8], gl.QUERY_RESULT)) y |= 1 << b
    }
    this.pending = false
    this.value.set(x / 255, y / 255)
  }

  /** Mide cada 0,2 s con la cámara principal (sus matrices eligen las cascadas). */
  update(dt: number, renderer: WebGLRenderer, camera: Camera): void {
    this.timer -= dt
    if (this.pending || this.timer > 0) return
    this.timer = 0.2
    const gl = renderer.getContext() as WebGL2RenderingContext
    if (gl.isContextLost()) return
    this.gl = gl
    if (this.queries.length === 0) for (let i = 0; i < 16; i++) this.queries.push(gl.createQuery()!)
    const prev = renderer.getRenderTarget()
    renderer.setRenderTarget(this.target)
    renderer.render(this.scene, camera)
    renderer.setRenderTarget(prev)
    this.pending = true
  }
}

/**
 * Efecto de atmósfera: la irradiancia del sol sobre el terreno se multiplica también por
 * el canal G de la máscara (sombra de edificios y árboles), haya nubes o no, y bajo las
 * nubes se suma la luz difusa que dejan pasar (gris, desde todo el cielo de arriba).
 */
export function patchAerialShader(src: string): string {
  const reps: Array<[string, string]> = [
    ['  const float sunTransmittance\n) {', '  const float sunTransmittance,\n  const float cloudDiffuse\n) {'],
    [
      '  #ifdef HAS_SHADOW\n  sunIrradiance *= sunTransmittance;\n  #endif // HAS_SHADOW',
      /* glsl */ `  sunIrradiance *= sunTransmittance;
  if (cloudDiffuse > 0.0) {
    // la del sol sobre un plano horizontal, repartida por el cielo de arriba
    vec3 wsUp = normalize(positionECEF);
    vec3 wsSkyH;
    vec3 wsSunH = GetSunAndSkyIrradiance(positionECEF, wsUp, sunDirection, wsSkyH);
    skyIrradiance += wsSunH * (cloudDiffuse * 0.5 * (1.0 + dot(normal, wsUp)));
  }`,
    ],
    [
      'float sunTransmittance = exp(-opticalDepth);',
      'float sunTransmittance = exp(-opticalDepth) * wsTerrainSun(uv);\n  float wsCloudDiff = wsCloudDiffuse(opticalDepth);',
    ],
    ['float sunTransmittance = 1.0;', 'float sunTransmittance = wsTerrainSun(uv);\n  float wsCloudDiff = 0.0;'],
    [
      'getSunSkyIrradiance(positionECEF, normalECEF, inputColor.rgb, sunTransmittance)',
      'getSunSkyIrradiance(positionECEF, normalECEF, inputColor.rgb, sunTransmittance, wsCloudDiff)',
    ],
    [
      'void mainImage(',
      /* glsl */ `float wsTerrainSun(const vec2 uv) {
  #ifdef HAS_LIGHTING_MASK
  return texture(lightingMaskBuffer, uv).g;
  #else
  return 1.0;
  #endif
}
${CLOUD_DIFFUSE_GLSL}
void mainImage(`,
    ],
  ]
  let out = src
  for (const [a, b] of reps) {
    if (!out.includes(a)) {
      console.warn('SunShadows: el shader de atmósfera ha cambiado; el terreno no recibe sombras de edificios', a)
      return src
    }
    out = out.replace(a, b)
  }
  return out
}

/**
 * Nubes de la librería: su dispersión múltiple (octavas que se apagan con e^−τ·0,5ⁿ) deja
 * casi a oscuras el interior y la base de las nubes gruesas, iluminadas entonces solo por el
 * cielo azul: un cubierto salía azul marino. Se suma la luz difusa de dos flujos (la misma que
 * llega al suelo, `wsCloudDiffuse`) como intensidad media E/2π, solo donde ya hay espesor
 * (τ > 1–6: en las cimas al sol la aproximación de la librería ya basta). ×1,5 a ojo: con 1
 * el cubierto seguía algo apagado. En cúmulos de buen tiempo apenas cambia.
 */
export function patchCloudsShader(src: string): string {
  const k = 'radiance += skyIrradiance * RECIPROCAL_PI4 * skyGradient * skyLightScale;'
  if (!src.includes(k)) {
    console.warn('SunShadows: el shader de nubes ha cambiado; las bases de las nubes gruesas quedan oscuras')
    return src
  }
  return src.replace(
    k,
    /* glsl */ `${k}
      {
        float wsT = max(1.0 / (1.0 + 0.1125 * opticalDepth) - exp(-opticalDepth), 0.0);
        radiance += sunIrradiance * (max(dot(sunDirection, surfaceNormal), 0.0) * wsT * smoothstep(1.0, 6.0, opticalDepth) * 2.0 * RECIPROCAL_PI4 * 1.5);
      }`,
  )
}

function emptyArrayTexture(): DataArrayTexture {
  const t = new DataArrayTexture(new Uint8Array(4), 1, 1, 1)
  t.needsUpdate = true
  return t
}

const _lx = new Vector3()
const _ly = new Vector3()
const _lz = new Vector3()
const _up = new Vector3()
const _p = new Vector3()
const _m = new Matrix4()
