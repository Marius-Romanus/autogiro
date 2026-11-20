// Detalle procedural del suelo a corta distancia.
//
// Una ortofoto (o una tesela 3D) tiene 10-50 cm por píxel: desde el aire es
// nítida, pero rodando por la pista queda ampliada 10 veces y se ve borrosa.
// Este efecto reconstruye la posición de cada píxel del terreno a partir de la
// profundidad y le añade grano fino (tierra, hierba, asfalto) solo cerca de la
// cámara. No afecta al aparato (alfa = 0) ni al cielo, y cada octava se apaga
// cuando sería más pequeña que un píxel, para que no parpadee.

import { Matrix4, Uniform, Vector2, Vector3, type PerspectiveCamera } from 'three'
import { Effect, EffectAttribute } from 'postprocessing'

const fragment = /* glsl */ `
uniform mat4 detailInverseView;
uniform vec2 detailProj;      // 1/P[0][0], 1/P[1][1]
uniform vec3 detailOrigin;    // ancla del patrón (se mueve al re-centrar el mundo)
uniform float detailStrength;

const float PERIOD = 1024.0;

float dHash(vec2 p) {
  p = mod(p, PERIOD);
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float dNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(dHash(i), dHash(i + vec2(1.0, 0.0)), u.x), mix(dHash(i + vec2(0.0, 1.0)), dHash(i + vec2(1.0, 1.0)), u.x), u.y);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  // (sin "return" antes de las derivadas: se enmascara al final)
  // distancia en el eje de la cámara (postprocessing ya entrega la profundidad
  // en formato de perspectiva estándar aunque el búfer sea logarítmico)
  float w = -perspectiveDepthToViewZ(min(depth, 0.99999994), cameraNear, cameraFar);
  // cielo, aparato (alfa = 0) o demasiado lejos: sin efecto
  float valid = step(depth, 1.0 - 1e-7) * step(0.002, inputColor.a) * step(w, 260.0);
  vec2 ndc = uv * 2.0 - 1.0;
  vec3 viewPos = vec3(ndc.x * w * detailProj.x, ndc.y * w * detailProj.y, -w);
  vec3 world = (detailInverseView * vec4(viewPos, 1.0)).xyz - detailOrigin;
  vec2 p = world.xz;
  // tamaño de un píxel sobre el suelo (para apagar octavas demasiado finas)
  float px = max(length(dFdx(p)), length(dFdy(p)));
  float dist = length(viewPos);
  float fade = 1.0 - smoothstep(25.0, 240.0, dist);
  float n = 0.0;
  // tres escalas: grano (0.12 m), manchas (0.6 m) y parches (3 m)
  float s0 = 1.0 - smoothstep(0.35, 0.9, px / 0.12);
  float s1 = 1.0 - smoothstep(0.35, 0.9, px / 0.6);
  float s2 = 1.0 - smoothstep(0.35, 0.9, px / 3.0);
  n += s0 * 0.5 * (dNoise(p / 0.12) - 0.5);
  n += s1 * 0.8 * (dNoise(p / 0.6 + 17.0) - 0.5);
  n += s2 * 0.7 * (dNoise(p / 3.0 + 91.0) - 0.5);
  float k = 1.0 + detailStrength * fade * n * valid;
  outputColor = vec4(inputColor.rgb * k, inputColor.a);
}
`

export class GroundDetailEffect extends Effect {
  private readonly camera: PerspectiveCamera
  /** ancla del patrón en coordenadas del mundo */
  readonly origin = new Vector3()

  constructor(camera: PerspectiveCamera, strength = 0.55) {
    super('GroundDetailEffect', fragment, {
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map<string, Uniform>([
        ['detailInverseView', new Uniform(new Matrix4())],
        ['detailProj', new Uniform(new Vector2())],
        ['detailOrigin', new Uniform(new Vector3())],
        ['detailStrength', new Uniform(strength)],
      ]),
    })
    this.camera = camera
  }

  set strength(v: number) {
    this.uniforms.get('detailStrength')!.value = v
  }

  /** Llamar tras re-centrar el mundo (p_nuevo = M · p_viejo). */
  rebase(m: Matrix4): void {
    this.origin.applyMatrix4(m)
  }

  override update(): void {
    const cam = this.camera
    const u = this.uniforms
    ;(u.get('detailInverseView')!.value as Matrix4).copy(cam.matrixWorld)
    const e = cam.projectionMatrix.elements
    ;(u.get('detailProj')!.value as Vector2).set(1 / e[0], 1 / e[5])
    // mantener el ancla cerca (el patrón es periódico cada 1024 m)
    const o = u.get('detailOrigin')!.value as Vector3
    const P = 1024
    o.set(this.origin.x - Math.round((this.origin.x - cam.position.x) / P) * P, 0, this.origin.z - Math.round((this.origin.z - cam.position.z) / P) * P)
  }
}
