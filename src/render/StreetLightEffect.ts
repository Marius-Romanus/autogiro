// Luz de las farolas sobre el terreno (de noche).
//
// Como el foco de aterrizaje (LandingLightEffect): el terreno se dibuja como albedo sin iluminar
// (alfa = 1) y aquí, después del efecto de atmósfera, se le suma albedo/π · E. Pero son miles de
// farolas: no se recorren todas en cada píxel. Están en una rejilla del suelo (celdas de `cell`
// metros alrededor de la cámara, en coordenadas del mundo), ordenadas por celda en una textura
// (x, y, z, tipo) y otra textura da, por celda, dónde empiezan y cuántas hay. Cada píxel mira las
// de las cuatro celdas más cercanas a su punto (el radio de una farola es menor que una celda).
// Lo rellena src/traffic/Traffic.ts con las farolas que coloca el worker del tráfico. La rejilla y
// la función de la luminaria están en nightLights.ts: las fachadas de los edificios (que ya salen
// iluminadas, alfa 0) usan las mismas en su sombreador.

import { DataTexture, Matrix4, Uniform, Vector2, type PerspectiveCamera } from 'three'
import { Effect, EffectAttribute } from 'postprocessing'
import { LAMP_RADIUS, LAMP_TEX_W, floatTex, lampGridUniforms, streetLampGLSL } from './nightLights.ts'

export { LAMP_RADIUS, LAMP_TEX_W }

const fragment = /* glsl */ `
uniform vec2 slProj;          // 1/P[0][0], 1/P[1][1]
uniform mat4 slViewToWorld;   // matriz de la cámara
${streetLampGLSL}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  float w = -perspectiveDepthToViewZ(min(depth, 0.99999994), cameraNear, cameraFar);
  vec2 ndc = uv * 2.0 - 1.0;
  vec3 p = vec3(ndc.x * w * slProj.x, ndc.y * w * slProj.y, -w);
  vec3 n = cross(dFdx(p), dFdy(p));
  float nl = length(n);
  n = nl > 1e-12 ? n / nl : vec3(0.0, 1.0, 0.0);
  if (dot(n, p) > 0.0) n = -n;
  outputColor = inputColor;
  if (slOn <= 0.0) return;
  vec4 raw = texture2D(inputBuffer, uv);
  float valid = step(depth, 1.0 - 1e-7) * step(0.002, raw.a);
  if (valid <= 0.0) return;
  vec3 P = (slViewToWorld * vec4(p, 1.0)).xyz;
  vec3 N = normalize(mat3(slViewToWorld) * n);
  vec3 e = streetLampLight(P, N);
  outputColor = vec4(inputColor.rgb + raw.rgb * e * 0.3183099, inputColor.a);
}
`

export class StreetLightEffect extends Effect {
  private readonly camera: PerspectiveCamera
  /** 0 de día, 1 de noche (fundido al atardecer) */
  on = 0

  constructor(camera: PerspectiveCamera) {
    super('StreetLightEffect', fragment, {
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map<string, Uniform>([
        ['slProj', new Uniform(new Vector2())],
        ['slViewToWorld', new Uniform(new Matrix4())],
        ...(Object.entries(lampGridUniforms) as [string, Uniform][]),
      ]),
    })
    this.camera = camera
  }

  /**
   * Farolas de la rejilla: `lamps` (x, y, z, tipo+intensidad por farola, ya ordenadas por celda),
   * `cells` (inicio, cantidad, 0, 0 por celda), esquina y lado de celda en el mundo.
   */
  setGrid(lamps: Float32Array, nLamps: number, cells: Float32Array, nx: number, nz: number, origin: Vector2, cell: number): void {
    const u = lampGridUniforms
    const rows = Math.max(1, Math.ceil(nLamps / LAMP_TEX_W))
    const old = u.slLamps.value as DataTexture
    const data = new Float32Array(rows * LAMP_TEX_W * 4)
    data.set(lamps.subarray(0, nLamps * 4))
    u.slLamps.value = floatTex(data, LAMP_TEX_W, rows)
    u.slRows.value = rows
    old.dispose()
    const oldC = u.slCells.value as DataTexture
    u.slCells.value = floatTex(cells.slice(0, nx * nz * 4), nx, nz)
    oldC.dispose()
    u.slOrigin.value.copy(origin)
    u.slCell.value = cell
    u.slGrid.value.set(nx, nz)
  }

  /** intensidad (unidades de escena) y rodilla de la compresión */
  setLevels(gain: number, knee: number): void {
    lampGridUniforms.slGain.value = gain
    lampGridUniforms.slKnee.value = knee
  }

  override update(): void {
    const u = this.uniforms
    lampGridUniforms.slOn.value = this.on
    if (this.on <= 0) return
    const cam = this.camera
    const e = cam.projectionMatrix.elements
    ;(u.get('slProj')!.value as Vector2).set(1 / e[0], 1 / e[5])
    ;(u.get('slViewToWorld')!.value as Matrix4).copy(cam.matrixWorld)
  }
}

