// Oclusión ambiental (sombra de contacto): rincones, pies de las fachadas, bajos de los coches,
// el tren de aterrizaje contra el fuselaje, el interior de la cabina… Lo que la sombra del sol no
// da y sin lo que todo parece posado encima en vez de apoyado.
//
// - En pantalla, a partir de la profundidad (no cuesta dibujos de geometría): por cada píxel se
//   reconstruye su posición y su normal y se miran unos puntos de alrededor en espiral; los que
//   asoman por encima del plano del píxel, dentro de un radio, lo tapan («Scalable Ambient
//   Obscurance», McGuire et al. 2012).
// - El radio va en metros y crece con la distancia (25 cm en la cabina, hasta 5 m en una ciudad a
//   300 m): así sirve igual para un tornillo del panel que para un patio de manzana. Cuando el
//   radio ya no llega a un par de píxeles se apaga, y no hay nada que parpadee a lo lejos.
// - La espiral gira según un patrón fijo de 4×4 píxeles y el resultado se suaviza con una media
//   de 4×4 que respeta los saltos de profundidad: sin ruido que hierva (no hay suavizado temporal).
// - Se aplica multiplicando el color del búfer de la escena, antes de la atmósfera, sin tocar su
//   alfa (la máscara de iluminación). Al terreno (albedo, alfa 1) casi entera; a lo ya iluminado
//   (alfa 0: edificios, vehículos, aparatos) a medias: su color ya lleva el sol, al que la
//   oclusión no quita nada, y oscurecerlo del todo deja tiznones en las piezas finas.
// - Nada a menos de un par de metros: en la cabina oscurecía el panel (los relojes y la pantalla
//   son luz propia) y tiznaba el borde del carenado. Tampoco de noche: lo único que se ve
//   entonces son luces, y la oclusión es sombra de la luz del cielo.
// - Nieblas, nubes y calima van después, por encima.

import {
  HalfFloatType,
  NearestFilter,
  RGFormat,
  ShaderMaterial,
  Uniform,
  Vector2,
  Vector4,
  WebGLRenderTarget,
  type PerspectiveCamera,
  type Texture,
  type WebGLRenderer,
} from 'three'
import { Pass } from 'postprocessing'
import type { Quality } from '../config.ts'

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}`

/** cuánto oscurece el terreno y cuánto lo ya iluminado */
const TERRAIN = 0.85
const LIT = 0.65

/** más allá no se calcula (m): el radio ya no ocupa ni dos píxeles */
const MAX_DIST = 9000

const AO_FRAGMENT = /* glsl */ `
uniform sampler2D depthBuffer;
uniform float logFar;
// posición de vista = ((uv · xy + zw) · w, −w), w = distancia en el eje de la cámara
uniform vec4 projInfo;
// píxeles que ocupa 1 m a 1 m de distancia
uniform float projScale;
uniform vec2 texel;
// x: radio por metro de distancia, y: radio mínimo (m), z: radio máximo (m), w: radio máximo (px)
uniform vec4 radius;
uniform float intensity;
// distancias (m) entre las que aparece
uniform vec2 nearFade;
varying vec2 vUv;

const int BAYER[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);

// profundidad logarítmica de three.js: d = log2(1 + w) / log2(far + 1)
float viewW(vec2 uv) {
  float d = texture2D(depthBuffer, uv).r;
  return d >= 1.0 ? 1e9 : exp2(d * logFar) - 1.0;
}
vec3 posAt(vec2 uv, float w) {
  return vec3((uv * projInfo.xy + projInfo.zw) * w, -w);
}

void main() {
  float w = viewW(vUv);
  gl_FragColor = vec4(1.0, min(w, 60000.0), 0.0, 1.0);
  // (ni lo de dentro de la cabina ni lo que ya no se distingue)
  float near = smoothstep(nearFade.x, nearFade.y, w);
  if (w > float(MAX_DIST) || near <= 0.0) return;
  vec3 P = posAt(vUv, w);

  // normal de la superficie: de las dos diferencias de cada eje, la que no cruza un borde
  vec2 dx = vec2(texel.x, 0.0);
  vec2 dy = vec2(0.0, texel.y);
  float wl = viewW(vUv - dx);
  float wr = viewW(vUv + dx);
  float wd = viewW(vUv - dy);
  float wu = viewW(vUv + dy);
  vec3 ddx = abs(wl - w) < abs(wr - w) ? P - posAt(vUv - dx, wl) : posAt(vUv + dx, wr) - P;
  vec3 ddy = abs(wd - w) < abs(wu - w) ? P - posAt(vUv - dy, wd) : posAt(vUv + dy, wu) - P;
  vec3 n = normalize(cross(ddx, ddy));

  float r = clamp(w * radius.x, radius.y, radius.z);
  float rpx = r * projScale / w;
  if (rpx > radius.w) {
    r *= radius.w / rpx;
    rpx = radius.w;
  }
  // un radio de menos de un par de píxeles no da más que ruido
  float seen = smoothstep(1.5, 3.5, rpx);
  if (seen <= 0.0) return;

  // giro de la espiral: patrón fijo de 4×4 (el suavizado de después lo promedia)
  ivec2 pix = ivec2(gl_FragCoord.xy) & 3;
  float turn = float(BAYER[pix.y * 4 + pix.x]) / 16.0;
  float r2 = r * r;
  float bias = 0.02 * r + 0.0004 * w;
  float sum = 0.0;
  for (int i = 0; i < SAMPLES; i++) {
    float a = (float(i) + 0.5) / float(SAMPLES);
    float ang = 6.2831853 * (a * float(TURNS) + turn);
    vec2 uv = vUv + vec2(cos(ang), sin(ang)) * (a * rpx) * texel;
    vec3 v = posAt(uv, viewW(uv)) - P;
    float vv = dot(v, v);
    float f = max(r2 - vv, 0.0);
    sum += f * f * f * max((dot(v, n) - bias) / (vv + 0.0001 * r2), 0.0);
  }
  // (cada muestra aporta ∝ 1/r: se multiplica por r para que tape igual a cualquier escala)
  float ao = max(0.0, 1.0 - sum * 5.0 * intensity * r / (r2 * r2 * r2 * float(SAMPLES)));
  gl_FragColor.r = mix(1.0, max(ao, 0.3), seen * near);
}`

const APPLY_FRAGMENT = /* glsl */ `
uniform sampler2D inputBuffer;
uniform sampler2D aoBuffer;
uniform vec2 texel;
// x: cuánto oscurece el terreno, y: cuánto lo ya iluminado
uniform vec2 strength;
varying vec2 vUv;

void main() {
  // media de 4×4 (el periodo del patrón de giro) entre los vecinos de la misma superficie
  float w0 = texture2D(aoBuffer, vUv).g;
  float tol = 1.0 / (0.03 * w0 + 0.03);
  float sum = 0.0;
  float k = 0.0;
  for (int j = -2; j < 2; j++) {
    for (int i = -2; i < 2; i++) {
      vec2 s = texture2D(aoBuffer, vUv + vec2(float(i), float(j)) * texel).rg;
      float q = max(0.0, 1.0 - abs(s.g - w0) * tol);
      sum += s.r * q;
      k += q;
    }
  }
  float ao = k > 1e-4 ? sum / k : 1.0;
  vec4 src = texture2D(inputBuffer, vUv);
  gl_FragColor = vec4(src.rgb * mix(1.0, ao, src.a > 0.002 ? strength.x : strength.y), src.a);
}`

export class ContactAOPass extends Pass {
  private readonly target: WebGLRenderTarget
  private readonly cam: PerspectiveCamera
  private readonly aoMaterial: ShaderMaterial
  private readonly applyMaterial: ShaderMaterial
  private samples = 0

  constructor(camera: PerspectiveCamera) {
    super('ContactAOPass')
    this.cam = camera
    this.needsDepthTexture = true
    // r: oclusión, g: distancia (para que el suavizado no mezcle superficies distintas)
    this.target = new WebGLRenderTarget(1, 1, { depthBuffer: false, format: RGFormat, type: HalfFloatType, minFilter: NearestFilter, magFilter: NearestFilter })
    this.aoMaterial = new ShaderMaterial({
      uniforms: {
        depthBuffer: new Uniform<Texture | null>(null),
        logFar: new Uniform(1),
        projInfo: new Uniform(new Vector4()),
        projScale: new Uniform(1),
        texel: new Uniform(new Vector2(1, 1)),
        radius: new Uniform(new Vector4(0.017, 0.25, 5, 40)),
        intensity: new Uniform(7),
        nearFade: new Uniform(new Vector2(2, 5)),
      },
      defines: { SAMPLES: 9, TURNS: 5, MAX_DIST },
      vertexShader: VERTEX,
      fragmentShader: AO_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })
    // copia el color de la escena oscurecido y deja su alfa (la máscara de iluminación) como estaba
    this.applyMaterial = new ShaderMaterial({
      uniforms: {
        inputBuffer: new Uniform<Texture | null>(null),
        aoBuffer: new Uniform(this.target.texture),
        texel: new Uniform(new Vector2(1, 1)),
        strength: new Uniform(new Vector2()),
      },
      vertexShader: VERTEX,
      fragmentShader: APPLY_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })
    this.setQuality('high')
  }

  /** Solo en Alta y Ultra (más muestras): es trabajo de la gráfica por cada píxel. */
  setQuality(q: Quality): void {
    this.enabled = q === 'high' || q === 'ultra'
    const samples = q === 'ultra' ? 16 : 9
    if (samples !== this.samples) {
      this.samples = samples
      this.aoMaterial.defines.SAMPLES = samples
      this.aoMaterial.defines.TURNS = q === 'ultra' ? 7 : 5
      this.aoMaterial.needsUpdate = true
    }
  }

  /** 0–1: cuánto oscurece (para comparar con y sin) */
  strength = 1
  /** 0–1: luz de día (de noche no hay oclusión: lo que se ve son luces) */
  daylight = 1

  override setDepthTexture(depthTexture: Texture): void {
    this.aoMaterial.uniforms.depthBuffer.value = depthTexture
  }

  override render(renderer: WebGLRenderer, inputBuffer: WebGLRenderTarget, outputBuffer: WebGLRenderTarget): void {
    const k = this.strength * this.daylight
    const a = this.applyMaterial.uniforms
    ;(a.strength.value as Vector2).set(TERRAIN * k, LIT * k)
    a.inputBuffer.value = inputBuffer.texture
    const u = this.aoMaterial.uniforms
    const e = this.cam.projectionMatrix.elements
    // x/w = (x_ndc + P02) / P00 (y lo mismo en y): vale también con proyecciones descentradas (visor)
    ;(u.projInfo.value as Vector4).set(2 / e[0], 2 / e[5], (e[8] - 1) / e[0], (e[9] - 1) / e[5])
    u.projScale.value = 0.5 * e[5] * this.target.height
    u.logFar.value = Math.log2(this.cam.far + 1)
    this.fullscreenMaterial = this.aoMaterial
    renderer.setRenderTarget(this.target)
    renderer.render(this.scene, this.camera)
    this.fullscreenMaterial = this.applyMaterial
    renderer.setRenderTarget(this.renderToScreen ? null : outputBuffer)
    renderer.render(this.scene, this.camera)
  }

  override setSize(width: number, height: number): void {
    this.target.setSize(width, height)
    ;(this.aoMaterial.uniforms.texel.value as Vector2).set(1 / width, 1 / height)
    ;(this.applyMaterial.uniforms.texel.value as Vector2).set(1 / width, 1 / height)
  }

  override dispose(): void {
    this.target.dispose()
    this.aoMaterial.dispose()
    this.applyMaterial.dispose()
    super.dispose()
  }
}
