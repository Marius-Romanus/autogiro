// Agua de verdad sobre la ortofoto, en todo el mundo.
//
// El terreno es una foto: el mar, los lagos y los ríos salen con su color real (el
// azul oscuro del mar abierto, el turquesa de un arrecife, el verde de un embalse, el
// marrón de un río crecido), pero quietos y mates, iluminados como si fueran tierra.
// Aquí se les da lo que hace que el agua parezca agua, sin tocar ese color:
//
// - dónde hay agua lo dice OpenStreetMap (capa `water` de las teselas de OpenFreeMap:
//   océano, lagos, embalses, ríos, estanques…), que `world/WaterMask.ts` dibuja en una
//   textura por niveles alrededor de la cámara. El pase de la máscara de iluminación
//   (SunShadows.ts) la proyecta a pantalla: canal B = cuánta agua, canal A = cuánto
//   oleaje admite (mar 1, lago, río, piscina);
// - el efecto de atmósfera, que es quien ilumina el terreno, trata esos píxeles como una
//   superficie de agua: el color de la foto es la luz que sale de dentro del agua y encima
//   van el reflejo del cielo (Fresnel: casi nada mirando hacia abajo, casi todo hacia el
//   horizonte), el del sol sobre las olas (el camino de destellos) y el oleaje, que sale
//   de la velocidad y la dirección del viento del simulador (Cox y Munk: varianza de la
//   pendiente = 0,003 + 0,00512·U). Con calma un lago es un espejo; con 20 nudos el mar
//   se riza, se oscurece a rachas y saca borreguillos.
//
// Las olas que caben en un píxel se dibujan (inclinan la normal); las que no, pasan a ser
// rugosidad (ensanchan el brillo), así que de cerca se ven olas y de lejos un brillo liso.

import { ClampToEdgeWrapping, DataArrayTexture, LinearFilter, type Matrix4, RGFormat, Uniform, UnsignedByteType, Vector2, Vector3, Vector4 } from 'three'

/** Niveles de teselas de la máscara, del más fino al más basto. */
export const WATER_ZOOMS = [14, 12, 10, 8, 6] as const
export const WATER_LEVELS = WATER_ZOOMS.length
/** Texeles por lado de cada tesela (los de los bordes caen justo sobre el borde: sin costuras). */
export const WATER_TILE = 512
/** Capas por nivel: ventana de 3×3 teselas alrededor de la cámara, direccionada módulo 3. */
export const WATER_SLOTS = 9

let maskTexture: DataArrayTexture | null = null

/** Textura de la máscara (R: agua, G: energía del oleaje × agua), una capa por tesela. */
export function waterMaskTexture(): DataArrayTexture {
  if (!maskTexture) {
    const layers = WATER_LEVELS * WATER_SLOTS
    const t = new DataArrayTexture(new Uint8Array(WATER_TILE * WATER_TILE * 2 * layers), WATER_TILE, WATER_TILE, layers)
    t.format = RGFormat
    t.type = UnsignedByteType
    t.minFilter = LinearFilter
    t.magFilter = LinearFilter
    t.wrapS = ClampToEdgeWrapping
    t.wrapT = ClampToEdgeWrapping
    t.generateMipmaps = false
    t.needsUpdate = true
    maskTexture = t
    waterMaskUniforms.wtMap.value = t
  }
  return maskTexture
}

const vec4s = (n: number): Vector4[] => Array.from({ length: n }, () => new Vector4())

/** Máscara de agua: la escribe world/WaterMask.ts y la lee el pase de máscara (SunShadows.ts). */
export const waterMaskUniforms = {
  wtMap: new Uniform<DataArrayTexture | null>(null),
  /** 1 = hay máscara (0: sin agua, el terreno queda como estaba) */
  wtOn: new Uniform(0),
  /** origen del mundo: x sen φ, y cos φ, z radio de curvatura del meridiano, w del primer vertical (m) */
  wtGeo: new Uniform(new Vector4(0, 1, 6.36e6, 6.38e6)),
  /** por nivel: xy = origen del mundo dentro de su tesela, zw = cámara (teselas, desde esa esquina) */
  wtA: new Uniform(vec4s(WATER_LEVELS)),
  /** por nivel: xy = tesela central de la ventana respecto a la del origen, zw = tesela del origen módulo 3 */
  wtB: new Uniform(vec4s(WATER_LEVELS)),
  /** por nivel: x = bits de las capas cargadas, y = lado de un texel (m) */
  wtC: new Uniform(Array.from({ length: WATER_LEVELS }, () => new Vector2())),
  /** ángulo de un píxel de pantalla (rad) */
  wtPix: new Uniform(0.001),
}

/**
 * GLSL de la máscara (para un ShaderMaterial): `wtWater(mundo, distancia, albedo)` da
 * x = cuánta agua (0–1) e y = energía del oleaje que admite (0–1).
 *
 * El punto se pasa a Mercator respecto al origen flotante del mundo, sin restar números
 * grandes (en float32 un ECEF tiene medio metro de resolución, y la orilla bailaría):
 * el desvío en longitud y latitud sale del este/norte/arriba locales, y la diferencia de
 * Mercator de atanh(sen φ) − atanh(sen φ₀) = atanh((a − b)/(1 − ab)).
 */
export const WATER_MASK_GLSL = /* glsl */ `
precision highp sampler2DArray;
uniform sampler2DArray wtMap;
uniform float wtOn;
uniform vec4 wtGeo;
uniform vec4 wtA[${WATER_LEVELS}];
uniform vec4 wtB[${WATER_LEVELS}];
uniform vec2 wtC[${WATER_LEVELS}];
uniform float wtPix;

// 2^z / 2π de cada nivel (teselas por radián de longitud)
const float WT_SCALE[${WATER_LEVELS}] = float[${WATER_LEVELS}](${WATER_ZOOMS.map((z) => (2 ** z / (2 * Math.PI)).toFixed(7)).join(', ')});

// (Δ longitud, −Δ Mercator) del punto respecto al origen del mundo, en radianes
vec2 wtMercator(vec3 p) {
  float e = p.x, n = -p.z, u = p.y;
  float s0 = wtGeo.x, c0 = wtGeo.y;
  // distancia al eje de la Tierra, en el plano del meridiano del origen
  float ax = (wtGeo.w + u) * c0 - n * s0;
  float dLon = atan(e, ax);
  // lo que el desvío al este aleja del eje (curvatura del paralelo)
  float dl = e * e / (sqrt(ax * ax + e * e) + ax);
  float dLat = atan(n - dl * s0, wtGeo.z + u + dl * c0);
  float sh = sin(0.5 * dLat);
  float s1 = s0 * cos(dLat) + c0 * sin(dLat);
  float dy = atanh(2.0 * sh * (c0 * cos(0.5 * dLat) - s0 * sh) / (1.0 - s0 * s1));
  return vec2(dLon, -dy);
}

// x: agua (0,5 = la orilla), y: energía × agua, z: lado del texel (m) del nivel que manda
vec3 wtMaskAt(vec3 world) {
  vec2 d = wtMercator(world);
  vec3 acc = vec3(0.0, 0.0, 1000.0);
  for (int i = ${WATER_LEVELS - 1}; i >= 0; i--) {
    vec2 t = wtA[i].xy + d * WT_SCALE[i];
    vec2 rel = floor(t);
    vec2 o = abs(rel - wtB[i].xy);
    if (max(o.x, o.y) > 1.0) continue;
    // (+0,5 y +0,001: enteros en coma flotante, que una GPU puede dejar una pizca por debajo)
    vec2 m = floor(mod(wtB[i].zw + rel + 0.5, 3.0));
    float slot = m.x + 3.0 * m.y;
    if (mod(floor(wtC[i].x * exp2(-slot) + 0.001), 2.0) < 0.5) continue;
    // se funde con el nivel más basto antes de llegar al borde de la ventana
    vec2 c = abs(t - wtA[i].zw);
    float w = 1.0 - smoothstep(0.6, 0.85, max(c.x, c.y));
    if (w <= 0.0) continue;
    vec2 uv = (0.5 + (t - rel) * ${WATER_TILE - 1}.0) / ${WATER_TILE}.0;
    vec2 s = textureLod(wtMap, vec3(uv, slot + ${WATER_SLOTS}.0 * float(i)), 0.0).rg;
    acc = mix(acc, vec3(s, wtC[i].y), w);
  }
  return acc;
}

vec2 wtWater(vec3 world, float dist, vec3 albedo) {
  vec3 m = wtMaskAt(world);
  if (m.x <= 0.004) return vec2(0.0);
  // orilla nítida de cerca (la textura se amplía: se corta por el 0,5) y suave de lejos
  float w = clamp(0.6 * dist * wtPix / m.z, 0.12, 0.5);
  float a = smoothstep(0.5 - w, 0.5 + w, m.x);
  // La foto manda sobre el mapa: lo claro que no tira a azul ni a verde (la arena, la orilla
  // seca de un embalse bajo, un espigón, un barco, la espuma de una rompiente) no es agua,
  // aunque el mapa la dé por tal. El agua clara de un arrecife sí: es turquesa.
  float l = dot(albedo, vec3(0.2126, 0.7152, 0.0722));
  float blue = (max(albedo.g, albedo.b) - albedo.r) / max(l, 1e-3);
  a *= 1.0 - smoothstep(0.16, 0.36, l) * (1.0 - smoothstep(-0.02, 0.1, blue));
  return vec2(a, clamp(m.y / max(m.x, 0.02), 0.0, 1.0));
}
`

// ---------------------------------------------------------------------------
// Superficie: oleaje y reflejos en el efecto de atmósfera
// ---------------------------------------------------------------------------

/** Trenes de olas (senos): 10 de mar de viento + 2 de mar de fondo. */
const WAVES = 12
/** Periodo del ancla del patrón (m): todas las celdas de ruido y los números de onda caben un número entero de veces. */
const PERIOD = 81920
const G = 9.81
const TAU = Math.PI * 2
/** desvío de cada tren respecto al viento (rad) y reparto de la varianza */
const SPREAD = [-0.1, 0.38, -0.5, 0.2, -0.3, 0.56, -0.66, 0.06, 0.46, -0.4]
/** lado de la celda (m) de las tres octavas de ruido (rizado fino) */
const CELLS = [0.25, 1, 4]

const SURFACE_GLSL = /* glsl */ `
uniform vec4 wtWave[${WAVES}];   // kx, kz (rad/m), amplitud de la pendiente, fase
uniform float wtGate[${WAVES}];  // energía mínima del agua (mar 1, lago, río…) para que exista el tren
uniform vec4 wtScroll[3];        // avance de las dos capas de cada octava de ruido (celdas)
uniform vec4 wtNoiseAmp;         // xyz: pendiente típica de cada octava, w: varianza del rizado que nunca se resuelve
uniform vec4 wtParams;           // x: reloj del centelleo, y: nubes (0–1), z: borreguillos (0–1), w: intensidad del efecto
uniform vec4 wtGust;             // xy: avance de las rachas (celdas), z: cuánto modulan
uniform vec4 wtAnchor;           // xy: ancla del patrón (mundo, xz), zw: coseno y seno del giro del mundo respecto al patrón
uniform vec4 wtWind;             // xy: hacia dónde sopla el viento (ejes del patrón), w: avance de la espuma (celdas)

float wtHash(vec2 p) {
  p = mod(p, 256.0);
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// ruido de valor con derivadas: x = valor (0–1), yz = gradiente por celda
vec3 wtNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  float a = wtHash(i);
  float b = wtHash(i + vec2(1.0, 0.0));
  float c = wtHash(i + vec2(0.0, 1.0));
  float d = wtHash(i + vec2(1.0, 1.0));
  float k1 = b - a;
  float k2 = c - a;
  float k3 = a - b - c + d;
  return vec3(a + k1 * u.x + k2 * u.y + k3 * u.x * u.y, du * vec2(k1 + k3 * u.y, k2 + k3 * u.x));
}

// Pendiente de la superficie (dh/dx, dh/dz en el mundo) con las olas que caben en la huella
// del píxel sobre el agua (fa: a lo largo de la vista, fb: de través, en metros); var:
// varianza de la pendiente de las que no caben. Un tren de olas se ve mientras su fase
// cambie poco dentro de la huella: de lejos, a ras de agua, siguen viéndose las crestas
// que corren hacia quien mira y se funden las que van de través (sin muaré).
vec2 wtSlope(vec2 p, vec2 fa, vec2 fb, float energy, out float var) {
  // rachas: manchas de un par de cientos de metros donde el viento riza más o menos
  float gust = wtNoise(p / 160.0 + wtGust.xy).x;
  float v = mix(0.4, 1.0, energy) * mix(1.0, 0.3 + 1.4 * gust, wtGust.z);
  float amp = sqrt(v);
  vec2 s = vec2(0.0);
  var = wtNoiseAmp.w * v;
  for (int i = 0; i < ${WAVES}; i++) {
    vec4 w = wtWave[i];
    float gate = clamp((energy - wtGate[i]) * 6.0, 0.0, 1.0);
    // el mar de fondo (los dos últimos) no depende del viento de aquí
    float a = w.z * gate * (i < ${WAVES - 2} ? amp : 1.0);
    float res = 1.0 - smoothstep(0.2, 0.5, max(abs(dot(w.xy, fa)), abs(dot(w.xy, fb))) * 0.1591549);
    s += normalize(w.xy) * (a * res * cos(dot(w.xy, p) - w.w));
    var += 0.5 * a * a * (1.0 - res * res);
  }
  float la = length(fa);
  float px = mix(sqrt(la * length(fb)), la, 0.4);
  for (int j = 0; j < 3; j++) {
    float cell = j == 0 ? ${CELLS[0].toFixed(2)} : j == 1 ? ${CELLS[1].toFixed(2)} : ${CELLS[2].toFixed(2)};
    float a = wtNoiseAmp[j] * amp;
    float res = 1.0 - smoothstep(0.3, 0.7, px / (2.0 * cell));
    if (res > 0.0) {
      vec2 q = p / cell;
      vec3 na = wtNoise(q + wtScroll[j].xy);
      // segunda capa girada (3-4-5) y con otro rumbo: al cruzarse con la primera el rizado cambia de forma
      vec3 nb = wtNoise(vec2(0.6 * q.x - 0.8 * q.y, 0.8 * q.x + 0.6 * q.y) + wtScroll[j].zw);
      vec2 g = na.yz + vec2(0.6 * nb.y + 0.8 * nb.z, -0.8 * nb.y + 0.6 * nb.z);
      s += g * (a * res * 1.645);
    }
    var += a * a * (1.0 - res * res);
  }
  return s;
}

// Borreguillos: crestas que rompen, alargadas de través al viento, a manchas, y que
// avanzan con él. La cobertura sigue a Monahan (≈ 3,84e-6·U^3,41): nada por debajo de
// 10 nudos, un 1 % con 20 y un 4 % con 30.
float wtFoam(vec2 p, float px, float energy) {
  float z = wtParams.z;
  if (z <= 0.0 || energy < 0.6) return 0.0;
  vec2 q = vec2(dot(p, wtWind.xy), dot(p, vec2(-wtWind.y, wtWind.x)));
  // deshilachada: un ruido fino tuerce el contorno y le quita espuma a trozos
  vec3 n3 = wtNoise(q / 1.3 + 7.0);
  vec2 qw = q + (n3.yz) * 1.1;
  float n1 = wtNoise(vec2(qw.x / 2.5 - wtWind.w, qw.y / 7.0)).x;
  float n2 = wtNoise(p / 24.0 + 50.0 - wtGust.xy * 2.0).x;
  float th = 0.885 - 0.225 * z;
  float f = n1 * (0.55 + 0.45 * n2);
  float fine = mix(0.8, 0.35 + 1.1 * n3.x, 1.0 - smoothstep(0.5, 2.5, px));
  return smoothstep(0.0, 0.12, z) * smoothstep(0.6, 0.95, energy) * smoothstep(th, th + 0.11, f) * fine * (1.0 - smoothstep(6.0, 40.0, px));
}

// Destellos de las celdas de un tamaño: cada una se enciende si su número al azar (que va
// cambiando) supera 1 − pr, y es un punto redondo algo descentrado; con casi todas
// encendidas se juntan en un brillo liso. La media es pr.
float wtGlint(vec2 p, float cell, float pr) {
  vec2 q = p / cell;
  vec2 i = floor(q);
  float t = wtParams.x * (0.6 + 0.8 * wtHash(i + 37.0)) + wtHash(i + 11.0) * 61.0;
  float k = floor(t);
  float r = mix(wtHash(i + k * vec2(17.0, 59.0)), wtHash(i + (k + 1.0) * vec2(17.0, 59.0)), smoothstep(0.0, 1.0, t - k));
  float pw = 0.3 * pr * (1.0 - pr) + 1e-3;
  float on = smoothstep(1.0 - pr - pw, 1.0 - pr + pw, r);
  vec2 c = 0.5 + 0.3 * (vec2(wtHash(i + 5.0), wtHash(i + 23.0)) - 0.5);
  float fill = pr * pr;
  float spot = mix(1.0 - smoothstep(0.26, 0.5, length(q - i - c)), 1.0, fill);
  return on * spot / mix(0.46, 1.0, fill);
}

// celdas de poco más de un píxel (dos tamaños fundidos, para que no salten al acercarse)
float wtSparkle(vec2 p, float px, float pr) {
  float l = clamp(log2(max(px * 1.3, 0.04)), -5.0, 5.99);
  float l0 = floor(l);
  return mix(wtGlint(p, exp2(l0), pr), wtGlint(p + 19.7, exp2(l0 + 1.0), pr), l - l0);
}

// sombreado entre facetas (Beckmann, aproximación racional de Walter)
float wtLambda(float cosT, float a2) {
  float a = cosT / sqrt(max(a2 * (1.0 - cosT * cosT), 1e-8));
  return a < 1.6 ? (1.0 - 1.259 * a + 0.396 * a * a) / (3.535 * a + 2.181 * a * a) : 0.0;
}

// Radiancia de un píxel de agua. body: la del agua como terreno (el color de la foto
// iluminado por el sol y el cielo); V: hacia la cámara (ECEF); sunT: sol que llega (nubes,
// edificios); cloudDiff: luz difusa de las nubes de encima.
vec3 wtShade(
  const vec3 body,
  const vec3 worldPosition,
  const vec3 positionECEF,
  const vec3 V,
  const float viewDist,
  const float pixAngle,
  const float energy,
  const float sunT,
  const float cloudDiff
) {
  vec3 up = normalize(positionECEF);
  vec3 pos = up * max(length(positionECEF), ATMOSPHERE.bottom_radius * 1.0000002);
  float nvFlat = max(dot(up, V), 0.0);
  // huella del píxel sobre el agua: de través y, estirada por la inclinación, a lo largo de la vista
  float pxB = viewDist * pixAngle;
  float pxA = pxB / max(nvFlat, 0.02);
  float px = sqrt(pxA * pxB);
  vec2 look = worldPosition.xz - inverseViewMatrix[3].xz;
  look /= max(length(look), 1e-3);
  // Al patrón de olas, que va fijo al terreno: el marco del mundo (este, sur) gira un poco
  // cada vez que se re-centra el origen, y sin deshacer ese giro las olas darían un salto.
  vec2 rot = wtAnchor.zw;
  vec2 wd = worldPosition.xz - wtAnchor.xy;
  vec2 wp = vec2(rot.x * wd.x + rot.y * wd.y, rot.x * wd.y - rot.y * wd.x);
  look = vec2(rot.x * look.x + rot.y * look.y, rot.x * look.y - rot.y * look.x);
  float var;
  vec2 sl = wtSlope(wp, look * pxA, vec2(-look.y, look.x) * pxB, energy, var);
  sl = vec2(rot.x * sl.x - rot.y * sl.y, rot.y * sl.x + rot.x * sl.y);
  float foam = wtFoam(wp, px, energy);
  vec3 east = normalize(cross(vec3(0.0, 0.0, 1.0), up));
  vec3 north = cross(up, east);
  vec3 N = normalize(up - east * sl.x + north * sl.y);
  float sig = sqrt(var);
  float nv = dot(N, V);

  // cielo reflejado. Las olas que no se ven inclinan las facetas hacia quien mira: a ras
  // de agua el mar no llega a ser un espejo y refleja el cielo de algo más arriba.
  float cosE = (max(nv, 0.0) + 1.2 * sig) / (1.0 + 1.2 * sig);
  float c1 = 1.0 - cosE;
  float c2 = c1 * c1;
  float F = 0.02 + 0.98 * c2 * c2 * c1;
  vec3 R = reflect(-V, N);
  R = normalize(R + up * max(0.0, 0.03 + 0.7 * sig - dot(R, up)));
  vec3 skyTr;
  vec3 sky = GetSkyRadiance(pos, R, 0.0, sunDirection, skyTr);
  vec3 skyIrr;
  vec3 sunH = GetSunAndSkyIrradiance(pos, up, sunDirection, skyIrr);
  // nubes: no se trazan en el reflejo; hacia el horizonte tapan más cielo
  float cover = 1.0 - pow(1.0 - wtParams.y, 1.0 / max(dot(R, up), 0.12));
  vec3 cloud = (sunH * mix(0.3, cloudDiff, wtParams.y) + skyIrr) * RECIPROCAL_PI;
  sky = mix(sky, cloud, cover);
  // un agua rizada no refleja un punto del cielo sino un trozo: tira a su brillo medio
  sky = mix(sky, skyIrr * RECIPROCAL_PI, min(1.5 * sig, 0.4));

  // sol sobre las olas
  float mus = dot(up, sunDirection);
  vec3 spec = vec3(0.0);
  float nl = dot(N, sunDirection);
  if (mus > 0.0 && nl > 0.0) {
    vec3 H = normalize(V + sunDirection);
    float nh = max(dot(N, H), 1e-3);
    float nv2 = max(nv, 0.03);
    float a2 = max(var, 2e-4);
    float nh2 = nh * nh;
    float D = exp(-(1.0 - nh2) / (nh2 * a2)) / (PI * a2 * nh2 * nh2);
    float h1 = 1.0 - max(dot(V, H), 0.0);
    float h2 = h1 * h1;
    float Fh = 0.02 + 0.98 * h2 * h2 * h1;
    float Gs = 1.0 / (1.0 + wtLambda(nv2, a2) + wtLambda(nl, a2));
    // radiancia media del reflejo, en unidades de la irradiancia del sol
    float m = Fh * D * Gs / (4.0 * nv2);
    // Destellos: cada faceta que apunta al sol brilla lo mismo (g0); lo que cambia de un
    // sitio a otro es cuántas hay. Donde el reflejo medio es fuerte casi todos los píxeles
    // tienen alguna (núcleo liso y cegador); en los bordes sólo unos pocos (chispas sueltas).
    // De lejos cada píxel abarca muchas olas y el brillo es liso.
    float g0 = 0.7;
    float pr = mix(1.0 - exp(-m / g0), 1.0, smoothstep(3.0, 40.0, px));
    spec = sunH / max(mus, 0.02) * (sunT * m * wtSparkle(wp, px, pr) / max(pr, 1e-4));
  }

  vec3 water = body * (1.0 - F) + sky * F + spec;
  // espuma: blanca y mate
  vec3 white = (sunH * (sunT + cloudDiff) + skyIrr) * (0.75 * RECIPROCAL_PI);
  return mix(water, white, foam);
}
`

/** Uniformes del sombreado del agua (los añade Graphics al efecto de atmósfera). */
export class WaterSurface {
  readonly uniforms = new Map<string, Uniform>([
    ['wtWave', new Uniform(vec4s(WAVES))],
    ['wtGate', new Uniform(new Array<number>(WAVES).fill(0))],
    ['wtScroll', new Uniform(vec4s(3))],
    ['wtNoiseAmp', new Uniform(new Vector4())],
    ['wtParams', new Uniform(new Vector4(0, 0, 0, 1))],
    ['wtGust', new Uniform(new Vector4())],
    ['wtAnchor', new Uniform(new Vector4(0, 0, 1, 0))],
    ['wtWind', new Uniform(new Vector4(0, -1, 0, 0))],
  ])
  /** ancla del patrón de olas en el mundo (se mueve al re-centrar el origen) */
  private readonly anchor = new Vector3()
  /** giro (rad) que lleva del marco del mundo al del patrón: lo que ha girado el mundo al re-centrarse */
  private turn = 0
  private time = 0
  /** viento: hacia dónde sopla (en los ejes del patrón, fijos al terreno) y velocidad (m/s) */
  private windX = 0
  private windZ = -1
  private wind = 0
  private windFrom = Number.NaN
  /** cobertura de nubes del reflejo (0 despejado – 1 cubierto) */
  cloudCover = 0

  /** Viento del simulador: de dónde viene (grados) y velocidad (m/s). */
  setWind(fromDeg: number, speed: number): void {
    this.wind = Math.min(Math.max(speed, 0), 22)
    // La dirección se fija al terreno una vez: si siguiera al marco del mundo, cada
    // re-centrado giraría los trenes de olas una pizca alrededor de un ancla que está a
    // kilómetros, y aquí saltarían de fase.
    if (fromDeg === this.windFrom) return
    this.windFrom = fromDeg
    const to = ((fromDeg + 180) * Math.PI) / 180
    const x = Math.sin(to)
    const z = -Math.cos(to)
    const rc = Math.cos(this.turn)
    const rs = Math.sin(this.turn)
    this.windX = rc * x + rs * z
    this.windZ = rc * z - rs * x
  }

  /** Llamar tras re-centrar el mundo (p_nuevo = M · p_viejo). */
  rebase(m: Matrix4): void {
    this.anchor.applyMatrix4(m)
    // el nuevo marco está girado respecto al viejo (convergencia de meridianos): x' = c·x + s·z
    this.turn -= Math.atan2(m.elements[8], m.elements[0])
  }

  update(dt: number, cameraPos: Vector3): void {
    this.time += dt
    const t = this.time
    const U = this.wind
    const u = this.uniforms
    // ancla cerca de la cámara (el patrón se repite cada PERIOD a lo largo de sus propios ejes)
    const rc = Math.cos(this.turn)
    const rs = Math.sin(this.turn)
    const dx = cameraPos.x - this.anchor.x
    const dz = cameraPos.z - this.anchor.z
    const sx = Math.round((rc * dx + rs * dz) / PERIOD) * PERIOD
    const sz = Math.round((rc * dz - rs * dx) / PERIOD) * PERIOD
    ;(u.get('wtAnchor')!.value as Vector4).set(this.anchor.x + rc * sx - rs * sz, this.anchor.z + rs * sx + rc * sz, rc, rs)
    const windX = this.windX
    const windZ = this.windZ

    // Varianza de la pendiente (Cox y Munk) repartida por escalas: algo menos de la mitad es
    // rizado de centímetros, que nunca se resuelve; el resto, las octavas de ruido y los trenes.
    const cm = 0.00512 * U
    const waves = u.get('wtWave')!.value as Vector4[]
    const gates = u.get('wtGate')!.value as number[]
    const dir = Math.atan2(windZ, windX)
    const k0 = TAU / PERIOD
    // ola dominante del mar de viento (Pierson-Moskowitz): 0,88·U² m
    const peak = Math.min(Math.max(0.877 * U * U, 2.5), 110)
    const n = WAVES - 2
    const seaVar = 0.22 * cm
    for (let i = 0; i < WAVES; i++) {
      let lambda: number
      let a: number
      let ang: number
      if (i < n) {
        lambda = (peak * 1.25) / 1.32 ** i
        ang = dir + SPREAD[i]
        // las cortas llevan algo más de pendiente que las largas
        const share = (0.6 + (0.8 * i) / (n - 1)) / n
        a = Math.sqrt(2 * seaVar * share)
        gates[i] = lambda > 22 ? 0.75 : lambda > 7 ? 0.42 : lambda > 2 ? 0.22 : 0
      } else {
        // mar de fondo: largo, tendido y de otro rumbo; está aunque no haya viento
        lambda = i === n ? 150 : 95
        ang = dir + (i === n ? 0.9 : -0.55)
        a = i === n ? 0.03 : 0.022
        gates[i] = 0.8
      }
      const k = TAU / lambda
      // número de onda sobre la rejilla del ancla: al saltar ésta un periodo la fase no cambia
      const kx = Math.round((k * Math.cos(ang)) / k0) * k0
      const kz = Math.round((k * Math.sin(ang)) / k0) * k0
      const w = Math.sqrt(G * Math.hypot(kx, kz))
      waves[i].set(kx, kz, a, (w * t) % TAU)
    }

    const amps = u.get('wtNoiseAmp')!.value as Vector4
    amps.set(Math.sqrt(0.14 * cm), Math.sqrt(0.11 * cm), Math.sqrt(0.08 * cm), 0.003 + 0.45 * cm)
    const scroll = u.get('wtScroll')!.value as Vector4[]
    for (let j = 0; j < 3; j++) {
      const cell = CELLS[j]
      // velocidad de fase de una ola de ~2,5 celdas
      const c = Math.sqrt((G * 2.5 * cell) / TAU)
      const ax1 = (windX * c * t) / cell
      const az1 = (windZ * c * t) / cell
      // la segunda capa, a 35° de la primera y algo más lenta, en su rejilla girada
      const cs = Math.cos(0.6)
      const sn = Math.sin(0.6)
      const bx = ((windX * cs - windZ * sn) * 0.8 * c * t) / cell
      const bz = ((windX * sn + windZ * cs) * 0.8 * c * t) / cell
      scroll[j].set(-ax1 % 256, -az1 % 256, -(0.6 * bx - 0.8 * bz) % 256, -(0.8 * bx + 0.6 * bz) % 256)
    }
    // las rachas viajan con el viento, a media velocidad
    const g = u.get('wtGust')!.value as Vector4
    g.set((-(windX * U * 0.5 * t) / 160) % 256, (-(windZ * U * 0.5 * t) / 160) % 256, Math.min(U / 3, 1) * 0.8, 0)
    const p = u.get('wtParams')!.value as Vector4
    p.x = (t * 7) % 4096
    p.y = this.cloudCover
    // borreguillos: empiezan con unos 5 m/s (10 nudos); la espuma avanza con las crestas
    p.z = Math.min(Math.max((U - 5) / 13, 0), 1)
    ;(u.get('wtWind')!.value as Vector4).set(windX, windZ, U, ((0.6 * U * t) / 2.5) % 256)
  }
}

/**
 * Efecto de atmósfera: los píxeles de agua (canal B de la máscara de iluminación) se
 * iluminan como agua. Va después de patchAerialShader (usa su `wsCloudDiff`).
 */
export function patchAerialWater(src: string): string {
  const k = '  #if defined(TRANSMITTANCE) || defined(INSCATTER)\n  applyTransmittanceInscatter(positionECEF, shadowLength, radiance);'
  if (!src.includes(k) || !src.includes('void mainImage(') || !src.includes('wsCloudDiff') || !src.includes('getSunSkyIrradiance(')) {
    console.warn('Water: el shader de atmósfera ha cambiado; el agua se queda como en la foto')
    return src
  }
  return src.replace('void mainImage(', `${SURFACE_GLSL}\nvoid mainImage(`).replace(
    k,
    /* glsl */ `  #if defined(HAS_LIGHTING_MASK) && (defined(SUN_LIGHT) || defined(SKY_LIGHT))
  {
    vec4 wtM = texture(lightingMaskBuffer, uv);
    if (wtM.b > 0.004 && wtM.r > 0.5) {
      // el color del agua es el de la foto, sin el grano de tierra que se añade de cerca
      vec3 wtAlbedo = texture(inputBuffer, uv).rgb;
      // mar sin foto (el PNOA lo deja en un negro violáceo mar adentro): azul de mar abierto
      float wtNoData = smoothstep(0.9, 1.2, wtAlbedo.r / max(wtAlbedo.g, 1e-4)) * (1.0 - smoothstep(0.02, 0.04, dot(wtAlbedo, vec3(0.2126, 0.7152, 0.0722)))) * smoothstep(0.7, 0.9, wtM.a);
      wtAlbedo = mix(wtAlbedo, vec3(0.009, 0.021, 0.054), wtNoData);
      vec3 wtBody = getSunSkyIrradiance(positionECEF, normalize(positionECEF), wtAlbedo, sunTransmittance, wsCloudDiff);
      vec3 wtOut = wtShade(wtBody, worldPosition, positionECEF, -rayDirection, length(viewPosition), fragmentAngle, wtM.a, sunTransmittance, wsCloudDiff);
      radiance = mix(radiance, wtOut, wtM.b * wtParams.w);
    }
  }
  #endif
${k}`,
  )
}
