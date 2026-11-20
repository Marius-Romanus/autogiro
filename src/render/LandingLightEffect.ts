// Focos de aterrizaje sobre el terreno (el propio y los de otros pilotos).
//
// El terreno se dibuja como albedo sin iluminar (alfa = 1) y lo ilumina en
// posproceso el efecto de atmósfera con el sol y el cielo. Este efecto va justo
// después en el mismo pase: reconstruye la posición de cada píxel desde la
// profundidad y le suma albedo/π · E de cada foco (la misma fórmula que usa three
// con un SpotLight en los materiales iluminados: aparato, edificios y árboles,
// que alumbra el SpotLight de src/aircraft/AircraftLights.ts).
// El albedo se lee del búfer de entrada del pase (`inputBuffer`), que aún es el
// render sin iluminar; los píxeles con alfa 0 (ya iluminados) y el cielo no se tocan.

import { Uniform, Vector2, Vector3, type PerspectiveCamera } from 'three'
import { Effect, EffectAttribute } from 'postprocessing'

const fragment = /* glsl */ `
uniform vec2 llProj;                  // 1/P[0][0], 1/P[1][1]
uniform vec3 llPos[MAX_BEAMS];        // focos en espacio de vista
uniform vec3 llDir[MAX_BEAMS];        // ejes de los haces en espacio de vista
uniform float llIntensity[MAX_BEAMS]; // candelas en unidades de escena
uniform int llCount;                  // focos encendidos
uniform vec2 llCone;                  // cos del borde exterior e interior
uniform float llSat;                  // rodilla de la compresión logarítmica (adaptación del ojo)

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  // (sin "return" antes de las derivadas: se enmascara al final)
  float w = -perspectiveDepthToViewZ(min(depth, 0.99999994), cameraNear, cameraFar);
  vec2 ndc = uv * 2.0 - 1.0;
  vec3 p = vec3(ndc.x * w * llProj.x, ndc.y * w * llProj.y, -w);
  // Normal de la geometría a partir de la posición reconstruida. La luz llega muy
  // rasante (el foco va a medio metro del suelo): con la normal plana "hacia arriba"
  // que se usa sin pase de normales, una pista que sube un poco quedaba a oscuras a 45 m.
  vec3 n = cross(dFdx(p), dFdy(p));
  float nl = length(n);
  n = nl > 1e-12 ? n / nl : vec3(0.0, 1.0, 0.0);
  if (dot(n, p) > 0.0) n = -n; // hacia la cámara
  vec4 raw = texture2D(inputBuffer, uv);
  // cielo o píxel ya iluminado (aparato, edificios, árboles: los alumbra el SpotLight)
  float valid = step(depth, 1.0 - 1e-7) * step(0.002, raw.a);
  float e = 0.0;
  for (int i = 0; i < MAX_BEAMS; i++) {
    if (i >= llCount) break;
    vec3 L = llPos[i] - p;
    float d2 = max(dot(L, L), 1e-6);
    vec3 l = L * inversesqrt(d2);
    float spot = smoothstep(llCone.x, llCone.y, dot(-l, llDir[i]));
    float ndl = max(dot(n, l), 0.0);
    // 1/d² como three (decay 2), sin dejar que se dispare pegado al foco
    float ei = llIntensity[i] * ndl / max(d2, 1.0);
    // Compresión logarítmica (el ojo adaptado a la noche): con la exposición fija del
    // simulador y la luz rasante (cae ~1/d³), la pista cerca quemaba y a 50 m ya no se veía
    // nada. El logaritmo conserva el degradado con la distancia; una curva que satura no.
    // El cono se aplica después: comprimido antes, la penumbra quedaba como un borde duro.
    // (log(1 + x) con x pequeño pierde toda la precisión en float: serie de Taylor)
    float x = ei / llSat;
    e += llSat * (x < 1e-3 ? x - 0.5 * x * x : log(1.0 + x)) * spot;
  }
  outputColor = vec4(inputColor.rgb + raw.rgb * (e * valid * 0.3183099), inputColor.a);
}
`

const _v = new Vector3()

/** Haz de un foco de aterrizaje sobre el terreno (coordenadas del mundo). */
export interface GroundBeam {
  readonly pos: Vector3
  readonly dir: Vector3
  /** candelas en unidades de escena (0 = apagado) */
  intensity: number
}

/** el propio y los tres más cercanos de otros pilotos */
export const MAX_BEAMS = 4

export class LandingLightEffect extends Effect {
  private readonly camera: PerspectiveCamera
  private beams: readonly GroundBeam[] = []

  constructor(camera: PerspectiveCamera) {
    super('LandingLightEffect', fragment, {
      attributes: EffectAttribute.DEPTH,
      defines: new Map([['MAX_BEAMS', String(MAX_BEAMS)]]),
      uniforms: new Map<string, Uniform>([
        ['llProj', new Uniform(new Vector2())],
        ['llPos', new Uniform(Array.from({ length: MAX_BEAMS }, () => new Vector3()))],
        ['llDir', new Uniform(Array.from({ length: MAX_BEAMS }, () => new Vector3()))],
        ['llIntensity', new Uniform(new Array<number>(MAX_BEAMS).fill(0))],
        ['llCount', new Uniform(0)],
        ['llCone', new Uniform(new Vector2())],
        ['llSat', new Uniform(1)],
      ]),
    })
    this.camera = camera
  }

  /**
   * Focos de este fotograma (se usan los primeros MAX_BEAMS encendidos, por orden), con el
   * cono (radianes, como un SpotLight: `angle` y `penumbra`) y la rodilla de la compresión.
   */
  setBeams(beams: readonly GroundBeam[], angle: number, penumbra: number, knee: number): void {
    this.beams = beams
    ;(this.uniforms.get('llCone')!.value as Vector2).set(Math.cos(angle), Math.cos(angle * (1 - penumbra)))
    this.uniforms.get('llSat')!.value = knee
  }

  override update(): void {
    const u = this.uniforms
    const pos = u.get('llPos')!.value as Vector3[]
    const dir = u.get('llDir')!.value as Vector3[]
    const int = u.get('llIntensity')!.value as number[]
    const cam = this.camera
    let n = 0
    for (const b of this.beams) {
      if (n >= MAX_BEAMS) break
      if (!(b.intensity > 0)) continue
      pos[n].copy(b.pos).applyMatrix4(cam.matrixWorldInverse)
      dir[n].copy(_v.copy(b.dir).transformDirection(cam.matrixWorldInverse))
      int[n] = b.intensity
      n++
    }
    u.get('llCount')!.value = n
    if (!n) return
    const e = cam.projectionMatrix.elements
    ;(u.get('llProj')!.value as Vector2).set(1 / e[0], 1 / e[5])
  }
}
