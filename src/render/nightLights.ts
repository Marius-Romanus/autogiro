// Luces de la ciudad de noche compartidas entre materiales: cuánto de noche es (0 de día, 1 de
// noche), qué fracción de ventanas hay encendidas según la hora y la ganancia de la exposición
// (los brillos van en unidades ya expuestas, como las luces del aparato). Las ventanas de los
// edificios (world/Buildings.ts) leen estos uniformes; los actualiza src/traffic/Traffic.ts, que ya
// calcula el anochecer para las farolas.
//
// También la rejilla de las farolas (texturas y uniformes): la usan el efecto que alumbra el
// terreno (StreetLightEffect.ts) y el sombreador de los edificios para las fachadas, con la misma
// función de la luminaria (`streetLampGLSL`).

import { DataTexture, FloatType, NearestFilter, RGBAFormat, Uniform, Vector2 } from 'three'

export const nightUniforms = {
  nlOn: { value: 0 },
  nlLit: { value: 0.35 },
  nlGain: { value: 1 },
}

/** Fracción de ventanas encendidas a esa hora local (casas y oficinas de noche). */
export function litFraction(hour: number): number {
  const h = ((hour % 24) + 24) % 24
  // al anochecer mucha gente en casa; de madrugada casi nadie; al amanecer, algunas
  const prof = [0.12, 0.08, 0.06, 0.05, 0.05, 0.08, 0.2, 0.3, 0.25, 0.15, 0.12, 0.12, 0.12, 0.12, 0.12, 0.12, 0.14, 0.2, 0.32, 0.42, 0.46, 0.44, 0.36, 0.22]
  const i = Math.floor(h)
  return prof[i] + (prof[(i + 1) % 24] - prof[i]) * (h - i)
}

export function setNightLights(on: number, hour: number, exposure: number): void {
  nightUniforms.nlOn.value = on
  nightUniforms.nlLit.value = litFraction(hour)
  nightUniforms.nlGain.value = 1 / Math.max(exposure, 1e-3)
}

/** farolas por fila de la textura */
export const LAMP_TEX_W = 1024
/** radio de la luz de una farola (m): ha de ser menor que media celda + media celda */
export const LAMP_RADIUS = 24

export function floatTex(data: Float32Array, w: number, h: number): DataTexture {
  const t = new DataTexture(data, w, h, RGBAFormat, FloatType)
  t.minFilter = NearestFilter
  t.magFilter = NearestFilter
  t.needsUpdate = true
  return t
}

/**
 * Rejilla de las farolas (mundo): `slLamps` x, y, z, tipo (parte entera la potencia, ,5 si es LED)
 * ordenadas por celda; `slCells` inicio y cantidad por celda. La rellena StreetLightEffect.setGrid.
 */
export const lampGridUniforms = {
  slOn: new Uniform(0),
  slLamps: new Uniform(floatTex(new Float32Array(4 * LAMP_TEX_W), LAMP_TEX_W, 1)),
  slCells: new Uniform(floatTex(new Float32Array(4), 1, 1)),
  slOrigin: new Uniform(new Vector2()),
  slCell: new Uniform(40),
  slGrid: new Uniform(new Vector2(1, 1)),
  slGain: new Uniform(1),
  slKnee: new Uniform(1),
  slRows: new Uniform(1),
}

/** GLSL: `vec3 streetLampLight(P, N)`, irradiancia de las farolas en un punto del mundo (ya comprimida). */
export const streetLampGLSL = /* glsl */ `
uniform float slOn;           // 0 de día, 1 de noche
uniform sampler2D slLamps;    // x, y, z (mundo), tipo (0 sodio, 1 LED) + intensidad
uniform sampler2D slCells;    // inicio, cantidad
uniform vec2 slOrigin;        // esquina de la rejilla (mundo x, z)
uniform float slCell;         // lado de la celda (m)
uniform vec2 slGrid;          // celdas en x y en z
uniform float slGain;         // intensidad (unidades de escena)
uniform float slKnee;         // rodilla de la compresión (adaptación del ojo de noche)
uniform float slRows;         // filas de la textura de farolas

vec4 lampAt(float i) {
  float y = floor(i / ${LAMP_TEX_W}.0);
  return texture2D(slLamps, vec2((i - y * ${LAMP_TEX_W}.0 + 0.5) / ${LAMP_TEX_W}.0, (y + 0.5) / slRows));
}

vec3 streetLampLight(vec3 P, vec3 N) {
  vec2 g = (P.xz - slOrigin) / slCell;
  if (g.x < 1.0 || g.y < 1.0 || g.x > slGrid.x - 1.0 || g.y > slGrid.y - 1.0) return vec3(0.0);
  // las cuatro celdas más cercanas al punto
  vec2 c0 = floor(g - 0.5);
  vec3 e = vec3(0.0);
  for (int dz = 0; dz < 2; dz++) {
    for (int dx = 0; dx < 2; dx++) {
      vec2 c = c0 + vec2(float(dx), float(dz));
      vec4 cell = texture2D(slCells, (c + 0.5) / slGrid);
      float start = cell.x;
      int count = int(cell.y);
      for (int k = 0; k < 24; k++) {
        if (k >= count) break;
        vec4 L = lampAt(start + float(k));
        vec3 d = L.xyz - P;
        float d2 = dot(d, d);
        if (d2 > ${LAMP_RADIUS * LAMP_RADIUS}.0) continue;
        vec3 l = d * inversesqrt(max(d2, 1e-4));
        // luminaria que alumbra hacia abajo: casi nada en horizontal
        float down = clamp(l.y, 0.0, 1.0);
        float lum = pow(down, 0.6) * smoothstep(0.05, 0.35, down);
        float ndl = max(dot(N, l), 0.0);
        // ventana suave hasta el radio
        float r = d2 / ${LAMP_RADIUS * LAMP_RADIUS}.0;
        float win = (1.0 - r * r) * (1.0 - r * r);
        float ei = lum * ndl * win / max(d2, 16.0);
        // sodio (naranja) o LED (blanco cálido); la intensidad va en la parte entera
        float kind = fract(L.w);
        float power = floor(L.w);
        vec3 col = kind < 0.25 ? vec3(1.0, 0.56, 0.22) : vec3(1.0, 0.9, 0.78);
        e += col * (ei * power);
      }
    }
  }
  e *= slGain * slOn;
  // compresión logarítmica (como el foco: con la exposición fija, cerca quemaría)
  vec3 x = e / slKnee;
  return slKnee * log(1.0 + x);
}
`
