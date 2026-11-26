// Desgaste de los materiales del mundo: manchas, churretones de lluvia, suciedad al pie, rodadas,
// óxido… hecho en el shader con ruido (sin texturas que descargar ni dibujos de más), para que
// edificios, puentes, vehículos y barcos no sean un color liso.
//
// - Todo es ruido de valor con celdas en metros, en el marco propio de cada cosa (la tesela, el
//   modelo del vehículo): no se mueve al recentrar el mundo ni al girar la cámara.
// - Cada capa de ruido se apaga hacia su media cuando su celda ya no ocupa un par de píxeles
//   (`wxSeen`): de lejos no titila y el color medio no salta al acercarse.
// - `wxAmount` (0–1) lo gradúa todo; a 0 los materiales quedan como eran (calidad Baja: las
//   gráficas integradas no van sobradas de píxeles).

import type { Quality } from '../config.ts'

export const weatherUniforms = {
  wxAmount: { value: 1 },
}

/** Sin desgaste en calidad Baja. */
export function setWeatheringQuality(q: Quality): void {
  weatherUniforms.wxAmount.value = q === 'low' ? 0 : 1
}

/** Ruido y utilidades comunes (fragment shader). */
export const WX_COMMON_GLSL = /* glsl */ `
uniform float wxAmount;

float wxHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float wxHash3(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}
float wxNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(wxHash(i), wxHash(i + vec2(1.0, 0.0)), f.x), mix(wxHash(i + vec2(0.0, 1.0)), wxHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float wxNoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = mix(wxHash3(i), wxHash3(i + vec3(1.0, 0.0, 0.0)), f.x);
  float b = mix(wxHash3(i + vec3(0.0, 1.0, 0.0)), wxHash3(i + vec3(1.0, 1.0, 0.0)), f.x);
  float c = mix(wxHash3(i + vec3(0.0, 0.0, 1.0)), wxHash3(i + vec3(1.0, 0.0, 1.0)), f.x);
  float d = mix(wxHash3(i + vec3(0.0, 1.0, 1.0)), wxHash3(i + vec3(1.0, 1.0, 1.0)), f.x);
  return mix(mix(a, b, f.y), mix(c, d, f.y), f.z);
}
// 1 si la celda del ruido (p ya escalado: una celda por unidad) ocupa varios píxeles; 0 si ya no se distingue
float wxSeen(vec2 p) {
  vec2 w = fwidth(p);
  return 1.0 - smoothstep(0.3, 0.8, max(w.x, w.y));
}
float wxSeen3(vec3 p) {
  vec3 w = fwidth(p);
  return 1.0 - smoothstep(0.3, 0.8, max(w.x, max(w.y, w.z)));
}
// ruido −1..1 que de lejos se apaga a su media (0)
float wxBand(vec2 p) {
  float k = wxSeen(p);
  return k > 0.0 ? (wxNoise(p) * 2.0 - 1.0) * k : 0.0;
}
float wxBand3(vec3 p) {
  float k = wxSeen3(p);
  return k > 0.0 ? (wxNoise3(p) * 2.0 - 1.0) * k : 0.0;
}
// normal de la cara (hacia quien mira) en el marco de P
vec3 wxFaceNormal(vec3 P) {
  return normalize(cross(dFdx(P), dFdy(P)));
}
`

/**
 * Edificios. P: posición en el marco de la tesela (m; y arriba).
 * `wxWall`: uv = metros a lo largo de la fachada y altura sobre el suelo; top = altura de la
 * coronación (0 = no se sabe); floorH = altura de planta (0 = sin plantas). Devuelve la suciedad.
 * `wxRoof`: cubiertas (inclinadas: churretones y canales de la teja; planas: paños y charcos secos).
 */
export const WX_BUILDING_GLSL = /* glsl */ `
float wxWall(inout vec3 col, vec3 P, vec2 uv, float top, float floorH) {
  float u = uv.x;
  float v = uv.y;
  // manchas grandes y medianas del paño
  float m = 0.4 * wxBand3(P * 0.045) + 0.35 * wxBand3(P * 0.17) + 0.25 * wxBand3(P * 0.8);
  // churretones: ruido estirado en vertical
  float dirt = 0.35 * smoothstep(0.1, 0.75, wxBand(vec2(u * 2.3, v * 0.11)));
  if (top > 0.25) {
    // los que bajan de la cornisa, cada uno con su largo, y la franja sucia de debajo
    float d = top - v;
    float kS = wxSeen(vec2(u * 3.1, 0.0));
    float column = mix(0.3, smoothstep(0.4, 0.85, wxNoise(vec2(u * 3.1, 11.3))), kS);
    float len = 1.5 + 5.0 * wxNoise(vec2(u * 0.9, 3.7));
    dirt += 0.55 * column * (1.0 - smoothstep(0.0, len, d));
    dirt += 0.35 * (1.0 - smoothstep(0.0, 0.6, d));
  }
  // salpicaduras y humedad al pie
  dirt += 0.5 * (1.0 - smoothstep(0.0, 0.9 + 1.6 * wxNoise(vec2(u * 0.6, 5.1)), v));
  dirt = clamp(dirt, 0.0, 1.0) * wxAmount;
  col *= 1.0 + 0.16 * m * wxAmount;
  col = mix(col, col * vec3(0.50, 0.46, 0.41), dirt * 0.6);
  if (floorH > 0.5) {
    // canto de los forjados: una línea algo más clara en cada planta
    float f = v / floorH;
    float fw = fwidth(f);
    float line = (1.0 - smoothstep(0.045, 0.045 + fw, abs(fract(f + 0.5) - 0.5))) * (1.0 - smoothstep(0.15, 0.5, fw));
    col *= 1.0 + 0.08 * line * wxAmount;
  }
  return dirt;
}

void wxRoof(inout vec3 col, vec3 P) {
  vec3 n = wxFaceNormal(P);
  float pitched = 1.0 - smoothstep(0.93, 0.99, n.y);
  vec2 q = P.xz;
  // musgo, polvo y parches
  float m = 0.4 * wxBand(q * 0.06 + 1.7) + 0.35 * wxBand(q * 0.21) + 0.25 * wxBand(q * 1.05 + 7.3);
  col *= 1.0 + 0.2 * m * wxAmount;
  // inclinadas: churretones ladera abajo y canales de la teja
  vec2 h = normalize(n.xz + vec2(1e-4));
  float across = dot(q, vec2(-h.y, h.x));
  float along = dot(q, h);
  float run = smoothstep(0.0, 0.8, wxBand(vec2(across * 1.7, along * 0.14 + P.y * 0.2)));
  float rows = 0.5 - 0.5 * cos(across * 28.56);
  float kR = wxSeen(vec2(across * 9.1, 0.0));
  col *= 1.0 - wxAmount * pitched * (0.14 * run + 0.20 * kR * (rows - 0.5));
  // planas: paños de otra tela y cercos de charco
  float kP = wxSeen(q * 0.07);
  float cloth = mix(0.4, smoothstep(0.52, 0.58, wxNoise(q * 0.07 + 3.1)), kP);
  float pond = smoothstep(0.60, 0.78, wxNoise(q * 0.33 + 9.7)) * wxSeen(q * 0.33);
  col *= 1.0 - wxAmount * (1.0 - pitched) * (0.08 * (cloth - 0.4) + 0.13 * pond);
}
`

/**
 * Puentes. P: posición en el marco de la tesela; rd: coordenadas de calzada (u lateral, v a lo
 * largo, tipo, semiancho; tipo 0 = hormigón o acero de la estructura).
 */
export const WX_BRIDGE_GLSL = /* glsl */ `
void wxBridge(inout vec3 col, vec3 P, vec4 rd) {
  vec3 n = wxFaceNormal(P);
  float k = wxAmount;
  if (rd.z > 0.5) {
    float u = rd.x;
    float v = rd.y;
    float hw = rd.w;
    // firme: paños de distinto asfalto y grano
    col *= 1.0 + k * (0.09 * wxBand(vec2(u * 0.3, v * 0.07)) + 0.06 * wxBand(vec2(u, v) * 1.9));
    if (rd.z > 9.5) {
      float lanes = mod(rd.z, 10.0);
      float cw = min(lanes * 1.75, hw - 0.75);
      float lw = 2.0 * cw / lanes;
      // rodadas (más oscuras y pulidas) y la gota de aceite del centro de cada carril
      float lx = (fract((u + cw) / lw) - 0.5) * lw;
      float inRoad = step(abs(u), cw);
      float t = (abs(lx) - 0.85) / 0.30;
      float track = exp(-t * t);
      float o = lx / 0.25;
      float oil = exp(-o * o) * (0.5 + 0.5 * wxNoise(vec2(u * 0.2, v * 0.05)));
      float kL = 1.0 - smoothstep(0.25, 0.9, fwidth(u));
      col *= 1.0 - k * inRoad * kL * (0.10 * track + 0.08 * oil);
      // suciedad acumulada junto al bordillo
      col *= 1.0 - k * 0.16 * smoothstep(hw - 1.1, hw - 0.2, abs(u)) * (0.6 + 0.4 * wxNoise(vec2(u, v * 0.3)));
    }
    // juntas de dilatación
    float j = abs(fract(v / 28.0 + 0.5) - 0.5) * 28.0;
    float fv = fwidth(v);
    float joint = (1.0 - smoothstep(0.06, 0.06 + fv, j)) * (1.0 - smoothstep(0.2, 0.7, fv));
    col = mix(col, vec3(0.03), joint * 0.7 * k);
  } else {
    // hormigón o acero: manchas, churretones en las caras verticales y humedad por debajo
    col *= 1.0 + k * (0.11 * wxBand3(P * 0.23) + 0.07 * wxBand3(P * 1.2));
    float vertical = 1.0 - smoothstep(0.2, 0.6, abs(n.y));
    vec2 t = normalize(vec2(-n.z, n.x) + vec2(1e-4));
    float s = dot(P.xz, t);
    float run = wxBand(vec2(s * 1.5, P.y * 0.09));
    col *= 1.0 - k * vertical * (0.24 * smoothstep(0.1, 0.8, run) - 0.07 * smoothstep(0.35, 0.9, -run));
    float under = smoothstep(0.3, 0.8, -n.y);
    col *= 1.0 - k * 0.18 * under * (0.55 + 0.45 * wxNoise(P.xz * 0.18));
  }
}
`

/**
 * Vehículos y barcos. P: posición en el marco del modelo (x a lo largo, y arriba —el suelo o la
 * flotación en 0—, z a lo ancho); paint: 0 color fijo, 1 carrocería, 2 lunas; seed: 0–1 por vehículo.
 */
export const WX_VEHICLE_GLSL = /* glsl */ `
void wxVehicle(inout vec3 col, inout float rough, inout float metal, vec3 P, float paint, float seed) {
  if (paint > 1.5) {
    // lunas: cristal que refleja el cielo
    rough = mix(rough, 0.14, wxAmount);
    metal = mix(metal, 0.0, wxAmount);
    return;
  }
  float k = wxAmount;
  // casi todos limpios, alguno hecho un asco
  float dirty = 0.12 + 0.88 * seed * seed * seed;
  float edge = 0.55 + 0.35 * wxNoise(vec2(P.x * 2.3 + seed * 37.0, P.z * 2.3));
  float splash = (1.0 - smoothstep(0.18, edge, P.y)) * dirty * step(0.5, paint);
  float film = dirty * dirty * 0.35 * (0.6 + 0.4 * wxNoise(P.xz * 1.3 + seed * 11.0)) * paint;
  float d = clamp(splash + film, 0.0, 1.0) * k;
  // chapa con vida: manchas suaves y, en los costados (cajas, furgones, vagones), los churretones
  // que bajan del techo
  vec3 n = wxFaceNormal(P);
  float side = 1.0 - smoothstep(0.3, 0.7, abs(n.y));
  float run = smoothstep(0.15, 0.8, wxBand(vec2((P.x + P.z) * 2.6 + seed * 13.0, P.y * 0.22)));
  col *= 1.0 + k * paint * (0.07 * wxBand3(P * 0.9 + seed * 7.0) - 0.20 * run * side * (0.35 + 0.65 * dirty));
  col = mix(col, vec3(0.20, 0.175, 0.15), d * 0.6);
  rough = mix(rough, 0.92, max(d, 0.5 * run * side * k));
  // penumbra de los bajos
  col *= mix(1.0, mix(0.55, 1.0, smoothstep(0.0, 0.5, P.y)), k);
}

void wxBoat(inout vec3 col, inout float rough, inout float metal, vec3 P, float paint, float seed, float wear) {
  if (paint > 1.5) {
    rough = mix(rough, 0.14, wxAmount);
    metal = mix(metal, 0.0, wxAmount);
    return;
  }
  float k = wxAmount;
  vec3 n = wxFaceNormal(P);
  float side = 1.0 - smoothstep(0.25, 0.6, abs(n.y));
  col *= 1.0 + k * (0.09 * wxBand3(P * 0.31) + 0.06 * wxBand3(P * 1.6));
  // verdín y roce en la flotación
  float wl = (1.0 - smoothstep(0.05, 0.3 + 0.35 * wxNoise(vec2(P.x * 0.7, P.z * 0.7 + seed * 9.0)), P.y)) * side;
  col = mix(col, vec3(0.05, 0.065, 0.045), wl * 0.7 * k * (0.35 + 0.65 * wear));
  // churretones de óxido en los costados: finos y, en los cascos grandes, a paños
  float t = P.x + P.z * 0.6;
  float run = smoothstep(0.2, 0.85, wxBand(vec2(t * 1.1, P.y * 0.09 + seed * 5.0))) + 0.6 * smoothstep(0.3, 0.9, wxBand(vec2(t * 0.16, P.y * 0.025 + 3.0)));
  float rust = clamp(run, 0.0, 1.0) * side * wear * k;
  col = mix(col, col * vec3(0.55, 0.36, 0.25) + vec3(0.02, 0.008, 0.0), rust * 0.65);
  rough = mix(rough, 0.9, max(rust, wl * k));
}
`
