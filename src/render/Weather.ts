// Bruma, niebla y velo de la precipitación, dentro del efecto de atmósfera de takram (sin niebla de
// three.js encima): se parchea su shader y, tras su propia transmitancia e in-scattering (el aire
// limpio), se integra de forma analítica la extinción añadida entre la cámara y cada píxel.
//
// Tres medios, todos referidos al suelo de la salida (h = 0):
//  - bruma: β0·e^(−h/H), con β0 de la visibilidad (Koschmieder) — calima (H de km, parda, absorbe
//    azul) o bruma húmeda (capa de mezcla, blanca, muy hacia delante);
//  - niebla: capa entre dos alturas con la cima difuminada y ondulada (ruido de las nubes);
//  - precipitación: lluvia por debajo de la isoterma de 0 °C y nieve por encima, hasta la base de
//    las nubes.
// La luz que devuelven sale de un modelo de dos flujos (el mismo k = 0,1125 de la luz difusa bajo las
// nubes de SunShadows): arriba de una capa gruesa ≈ E/π (un mar de nubes blanco), abajo lo que la
// atraviesa; más la dispersión simple del sol con fase de Henyey-Greenstein (resplandor hacia el
// sol). El suelo de debajo recibe el sol atenuado y esa luz difusa. Las nubes de takram llegan como
// `overlay` sin distancia: se les pone la niebla que hay hasta su capa.
//
// Además: suelo mojado (más oscuro y con el cielo reflejado a ras) y nieve cuajada por encima de la
// isoterma de 0 °C. Con todo a cero (`wxCam.w` = 0) el shader hace exactamente lo de antes.

import { Uniform, Vector2, Vector3, Vector4, type Texture } from 'three'
import type { WeatherState } from '../sim/weather.ts'

const EARTH_R = 6.371e6

export const WEATHER_GLSL = /* glsl */ `
uniform vec4 wxCam;   // altura de la cámara sobre el suelo de la salida, radio de la Tierra, tiempo, activo
uniform vec4 wxHaze;  // β0 (1/m), H (m), polvo 0..1, g de la fase
uniform vec4 wxFog;   // β (1/m), base, cima (m sobre la salida), borde difuso (m)
uniform vec4 wxRain;  // β lluvia, β nieve (1/m), isoterma de 0 °C, base de las nubes (m sobre la salida)
uniform vec4 wxWet;   // suelo mojado 0..1, nieve cuajada 0..1, cota de nieve (m sobre la salida)
uniform vec3 wxSun;   // irradiancia del sol que llega a la altura de la cámara (perpendicular)
uniform vec3 wxAmb;   // irradiancia difusa sobre un plano horizontal (cielo + nubes)
uniform float wxSunMu;
uniform vec2 wxCloud; // base y cima de las nubes de takram respecto a la cámara (m)
uniform sampler3D wxNoise;

float wxGH = 0.0;
float wxSkyT = 1.0;
float wxWetAmt = 0.0;
float wxSnowAmt = 0.0;

// ∫ de la densidad de una capa [zb, zt] con la cima difuminada en w metros, desde zb hasta h
float wxG(float h, const float zb, const float zt, const float w) {
  h = max(h, zb);
  float a = zt - w;
  if (h <= a) return h - zb;
  float x = min(h, zt) - a;
  return a - zb + x - x * x / (2.0 * w);
}
float wxRho(const float h, const float zb, const float zt, const float w) {
  return h < zb ? 0.0 : clamp((zt - h) / w, 0.0, 1.0);
}
// espesor óptico/β de la capa a lo largo de un tramo de longitud d entre las alturas h1 y h2
float wxSlab(const float h1, const float h2, const float d, const float zb, const float zt, const float w) {
  float dh = h2 - h1;
  if (abs(dh) < 1.0) return wxRho(0.5 * (h1 + h2), zb, zt, w) * d;
  return d * abs(wxG(h2, zb, zt, w) - wxG(h1, zb, zt, w)) / abs(dh);
}
// columna vertical de bruma, niebla y precipitación por encima de h (espesor óptico)
float wxAbove(const float h, const float fogTop) {
  float t = wxHaze.x * wxHaze.y * exp(-max(h, -400.0) / wxHaze.y);
  if (wxFog.x > 0.0) {
    float w = min(wxFog.w, fogTop - wxFog.y);
    t += wxFog.x * (fogTop - wxFog.y - 0.5 * w - wxG(h, wxFog.y, fogTop, w));
  }
  t += wxRain.x * max(min(wxRain.z, wxRain.w) - h, 0.0) + wxRain.y * max(wxRain.w - max(h, wxRain.z), 0.0);
  return t;
}

/** Espesor óptico añadido a lo largo de d metros de un rayo con coseno cenital mu; J: la luz que devuelve. */
float wxFogTau(float d, const float mu, out vec3 J) {
  d = min(d, 3.0e5);
  float hc = wxCam.x;
  float he = max(hc + mu * d + (1.0 - mu * mu) * d * d / (2.0 * wxCam.y), -400.0);
  float dh = he - hc;
  // bruma exponencial
  float x = dh / wxHaze.y;
  float f = abs(x) < 1e-3 ? 1.0 - 0.5 * x : (1.0 - exp(-x)) / x;
  float tau = wxHaze.x * exp(-max(hc, -400.0) / wxHaze.y) * d * f;
  // niebla: la cima ondula (ruido anclado al suelo, en el punto donde el rayo la cruza)
  float fogTop = wxFog.z;
  float tauFog = 0.0;
  float billow = 0.5;
  float facing = 0.0;
  if (wxFog.x > 0.0) {
    float w = min(wxFog.w, wxFog.z - wxFog.y);
    float sc = abs(dh) > 0.01 ? clamp((wxFog.z - 0.5 * w - hc) * d / dh, 0.0, d) : 0.0;
    vec3 p = vCameraPosition + normalize(vRayDirection) * (sc * METER_TO_LENGTH_UNIT);
    vec3 q = p * 1.4 + vec3(wxCam.z * 0.004, 0.0, wxCam.z * 0.0025);
    // (tres escalas no conmensurables: sin ellas se nota la repetición de la textura a lo lejos)
    float big = texture(wxNoise, q.zxy * 0.19).r;
    float low = texture(wxNoise, q).r;
    billow = smoothstep(0.15, 0.85, big * 0.45 + low * 0.35 + texture(wxNoise, q.yzx * 4.3).r * 0.2);
    // pendiente de los bultos hacia el sol (otra muestra 70 m más allá): la cara que le da el sol, más clara
    vec3 up = normalize(vCameraPosition);
    vec3 sunH = sunDirection - up * dot(sunDirection, up);
    facing = clamp((low - texture(wxNoise, q + sunH * 0.1).r) * 5.0, -1.0, 1.0);
    fogTop += (billow - 0.5) * 2.0 * w;
    tauFog = wxFog.x * wxSlab(hc, he, d, wxFog.y, fogTop, w);
    tau += tauFog;
  }
  // precipitación: lluvia bajo la isoterma de 0 °C, nieve por encima, hasta la base de las nubes
  if (wxRain.x + wxRain.y > 0.0) {
    float zr = min(wxRain.z, wxRain.w);
    tau += wxRain.x * wxSlab(hc, he, d, -1.0e4, zr, 40.0);
    if (wxRain.w > wxRain.z) tau += wxRain.y * wxSlab(hc, he, d, wxRain.z, wxRain.w, 40.0);
  }
  if (tau < 1e-5) {
    J = vec3(0.0);
    return 0.0;
  }
  // altura representativa: donde el rayo lleva espesor óptico ~1. Con la cámara dentro del medio,
  // a 1/β de ella; mirando la niebla desde fuera, un espesor óptico por debajo de su cima
  float bc = wxHaze.x * exp(-max(hc, -400.0) / wxHaze.y) + wxRain.x * step(hc, min(wxRain.z, wxRain.w))
    + wxRain.y * step(wxRain.z, hc) * step(hc, wxRain.w);
  if (wxFog.x > 0.0) bc += wxFog.x * wxRho(hc, wxFog.y, fogTop, min(wxFog.w, wxFog.z - wxFog.y));
  float hs;
  if (bc * d > 0.5 * min(tau, 2.0)) hs = hc + mu * min(d, 1.0 / bc);
  else if (tauFog > 0.5 * tau) hs = fogTop - min(abs(mu) / wxFog.x, fogTop - wxFog.y);
  else hs = hc + dh * min(1.0, 1.0 / tau);
  float above = wxAbove(hs, fogTop);
  float total = wxAbove(-50.0, fogTop);
  float below = max(total - above, 0.0);
  float mus = max(wxSunMu, 0.0);
  float sunT = exp(-above / max(wxSunMu, 0.06));
  vec3 Eh = wxSun * mus + wxAmb;
  // dos flujos: intensidad media dentro de una capa que casi no absorbe
  // (×1,35: la dispersión real, muy hacia delante, devuelve más luz a ras que la de dos flujos isótropa)
  // El cielo entra desde arriba (espesor vertical); el sol, en oblicuo: recorre total/μ dentro de la capa.
  // Con el sol rasante una niebla fina devuelve casi toda su luz (con el espesor vertical salía
  // casi transparente al sol y, al alba, oscura). Y a ras el relieve de la cima se hace sombra: solo
  // las caras que miran al sol reciben el directo (cálido); el resto queda con la luz azulada del cielo.
  float mue = max(mus, 0.05);
  float topView = clamp(tauFog / tau, 0.0, 1.0) * step(wxFog.z - wxFog.w, hc);
  float lit = mix(1.0, clamp(0.3 + 3.0 * mus + 0.9 * facing, 0.0, 1.25), topView);
  vec3 sunDiffuse = wxSun * (mus * lit * (1.0 + 0.225 * below / mue) / (1.0 + 0.1125 * total / mue));
  vec3 skyDiffuse = wxAmb * ((1.0 + 0.225 * below) / (1.0 + 0.1125 * total));
  vec3 Jd = max(sunDiffuse + skyDiffuse - wxSun * (mus * sunT), vec3(0.0)) * (1.35 / (2.0 * PI));
  float g = wxHaze.w;
  float cosT = dot(normalize(vRayDirection), sunDirection);
  float hg = (1.0 - g * g) / (4.0 * PI * pow(1.0 + g * g - 2.0 * g * cosT, 1.5));
  // (la fase tan picuda quemaría el disco del sol: se recorta)
  vec3 Js = wxSun * (sunT * min(hg, 1.2));
  // calima: el polvo absorbe el azul; la niebla y la lluvia son blancas
  float dustW = wxHaze.z * (tau - tauFog) / tau;
  vec3 albedo = mix(vec3(1.0), vec3(0.96, 0.86, 0.68), dustW);
  // la cima de la niebla vista desde fuera: bultos más claros y huecos más oscuros
  float relief = 1.0 + 0.22 * (billow - 0.5) * topView;
  J = albedo * (Jd + Js) * relief;
  // dentro de la niebla la luz ha rebotado tantas veces que pierde casi todo el tono del sol bajo
  J = mix(J, vec3(dot(J, vec3(0.2126, 0.7152, 0.0722))), mix(0.85, 0.45, step(wxFog.z - wxFog.w, hc)) * clamp(tauFog / tau, 0.0, 1.0));
  return tau;
}

// distancia a la capa de nubes de takram a lo largo del rayo
float wxCloudDist(const float mu) {
  float R = wxCam.y;
  if (wxCloud.x > 0.0) return 2.0 * wxCloud.x / (mu + sqrt(mu * mu + 2.0 * wxCloud.x / R));
  if (wxCloud.y < 0.0) {
    float disc = mu * mu + 2.0 * wxCloud.y / R;
    if (mu >= 0.0 || disc < 0.0) return 1.0e9;
    return R * (-mu - sqrt(disc));
  }
  return 0.0;
}

// nubes (premultiplicadas) sobre la escena ya con su niebla: se les pone la niebla que hay hasta ellas
vec3 wxOverlay(const vec3 scene, const vec4 overlay, const float d, const float mu) {
  vec3 Ja;
  float ta = exp(-wxFogTau(min(wxCloudDist(mu), d), mu, Ja));
  return scene * (1.0 - overlay.a) + Ja * (overlay.a * (1.0 - ta)) + overlay.rgb * ta;
}

// sol y cielo que llegan al suelo a la altura wxGH bajo la bruma y la niebla
void wxGroundLight(inout float sunT, inout float cloudDiffuse) {
  float tv = wxAbove(wxGH, wxFog.z);
  float direct = exp(-tv / max(wxSunMu, 0.06));
  wxSkyT = 1.0 / (1.0 + 0.1125 * tv);
  // lo que se pierde del sol directo y vuelve como luz difusa (wxSkyT se aplica después a todo el cielo)
  cloudDiffuse += sunT * max(wxSkyT - direct, 0.0) / wxSkyT;
  sunT *= direct;
  float snow = wxWet.y * smoothstep(wxWet.z - 120.0, wxWet.z + 120.0, wxGH);
  wxSnowAmt = snow;
  wxWetAmt = wxWet.x * (1.0 - snow);
}

vec3 wxSurfaceAlbedo(const vec3 c) {
  // mojado: la película de agua oscurece el suelo poroso; nieve: blanca salvo lo muy oscuro (bosque)
  vec3 a = c * mix(1.0, 0.6, wxWetAmt);
  float lum = dot(c, vec3(0.3, 0.6, 0.1));
  return mix(a, vec3(0.86, 0.88, 0.92), wxSnowAmt * (0.55 + 0.45 * smoothstep(0.03, 0.2, lum)));
}

// el cielo reflejado en el suelo mojado (Fresnel del agua, normal hacia arriba)
vec3 wxSheen(const float mu) {
  float c = 1.0 - min(abs(mu), 1.0);
  float c2 = c * c;
  float fres = 0.02 + 0.98 * c2 * c2 * c;
  return wxAmb * (wxSkyT * wxWetAmt * 0.7 * fres / PI);
}
`

type Rep = [string, string]

/** Parchea el shader del efecto de atmósfera (ya con los parches de sombras, agua y nubes cercanas). */
export function patchAerialWeather(src: string): string {
  const overlayMix = 'outputColor.rgb = outputColor.rgb * (1.0 - overlay.a) + overlay.rgb;'
  const reps: Rep[] = [
    ['void correctGeometricError(', `${WEATHER_GLSL}\nvoid correctGeometricError(`],
    ['vec3 diffuse = inputColor * albedoScale * RECIPROCAL_PI;', 'vec3 diffuse = wxSurfaceAlbedo(inputColor) * albedoScale * RECIPROCAL_PI;'],
    [
      '  #if defined(SUN_LIGHT) && defined(SKY_LIGHT)\n  return diffuse * (sunIrradiance + skyIrradiance);',
      '  skyIrradiance *= wxSkyT;\n  #if defined(SUN_LIGHT) && defined(SKY_LIGHT)\n  return diffuse * (sunIrradiance + skyIrradiance);',
    ],
    // nube opaca: con niebla por delante ya no vale salir sin más
    ['if (overlay.a == 1.0) {', 'if (overlay.a == 1.0 && wxCam.w < 0.5) {'],
    // cielo
    [
      `    #ifdef HAS_OVERLAY\n    ${overlayMix}\n    #endif // HAS_OVERLAY\n    return;`,
      /* glsl */ `    if (wxCam.w > 0.5) {
      float wxMuS = dot(rayDirection, normalize(vCameraPosition));
      vec3 wxJs;
      float wxTs = exp(-wxFogTau(3.0e5, wxMuS, wxJs));
      outputColor.rgb = outputColor.rgb * wxTs + wxJs * (1.0 - wxTs);
      #ifdef HAS_OVERLAY
      outputColor.rgb = wxOverlay(outputColor.rgb, overlay, 3.0e5, wxMuS);
      #endif // HAS_OVERLAY
      return;
    }
    #ifdef HAS_OVERLAY
    ${overlayMix}
    #endif // HAS_OVERLAY
    return;`,
    ],
    // suelo: sol y cielo bajo la niebla, mojado y nieve
    [
      '  vec3 radiance;\n  #if defined(SUN_LIGHT) || defined(SKY_LIGHT)',
      /* glsl */ `  float wxD = length(viewPosition);
  float wxMu = dot(rayDirection, normalize(vCameraPosition));
  if (wxCam.w > 0.5) {
    wxGH = wxCam.x + wxMu * wxD + (1.0 - wxMu * wxMu) * wxD * wxD / (2.0 * wxCam.y);
    wxGroundLight(sunTransmittance, wsCloudDiff);
  }
  vec3 radiance;
  #if defined(SUN_LIGHT) || defined(SKY_LIGHT)`,
    ],
    [
      'radiance = mix(inputColor.rgb, radiance, lightingMask);',
      'radiance = mix(inputColor.rgb, radiance, lightingMask);\n  if (wxWetAmt > 0.0) radiance += wxSheen(wxMu) * lightingMask;',
    ],
    [
      '  outputColor = vec4(radiance, inputColor.a);',
      /* glsl */ `  if (wxCam.w > 0.5) {
    vec3 wxJ;
    float wxT = exp(-wxFogTau(wxD, wxMu, wxJ));
    radiance = radiance * wxT + wxJ * (1.0 - wxT);
  }
  outputColor = vec4(radiance, inputColor.a);`,
    ],
    [
      `  #ifdef HAS_OVERLAY\n  ${overlayMix}\n  #endif // HAS_OVERLAY\n}`,
      /* glsl */ `  #ifdef HAS_OVERLAY
  if (wxCam.w > 0.5) outputColor.rgb = wxOverlay(outputColor.rgb, overlay, wxD, wxMu);
  else ${overlayMix}
  #endif // HAS_OVERLAY
}`,
    ],
  ]
  let out = src
  for (const [a, b] of reps) {
    if (!out.includes(a)) {
      console.warn('Weather: el shader de atmósfera ha cambiado; no hay bruma, niebla ni suelo mojado', a)
      return src
    }
    out = out.replace(a, b)
  }
  return out
}

/** Uniformes del parche y su puesta al día en cada fotograma. */
export class WeatherLayer {
  readonly cam = new Uniform(new Vector4(0, EARTH_R, 0, 0))
  readonly haze = new Uniform(new Vector4(0, 1000, 0, 0.8))
  readonly fog = new Uniform(new Vector4(0, -250, 0, 30))
  readonly rain = new Uniform(new Vector4(0, 0, 1e5, 0))
  readonly wet = new Uniform(new Vector4(0, 0, 1e5, 0))
  readonly sun = new Uniform(new Vector3())
  readonly amb = new Uniform(new Vector3())
  readonly sunMu = new Uniform(1)
  readonly cloud = new Uniform(new Vector2(1e9, 1e9))
  readonly noise = new Uniform<Texture | null>(null)
  /** altura elipsoidal del suelo de la salida */
  ground = 0
  state: WeatherState | null = null
  /** temperatura en el suelo de la salida (°C): cota de nieve */
  oatC = 15
  /** mojado del suelo 0..1 (sigue a la precipitación con retardo) */
  wetness = 0
  private time = 0

  get uniforms(): Array<[string, Uniform]> {
    return [
      ['wxCam', this.cam],
      ['wxHaze', this.haze],
      ['wxFog', this.fog],
      ['wxRain', this.rain],
      ['wxWet', this.wet],
      ['wxSun', this.sun],
      ['wxAmb', this.amb],
      ['wxSunMu', this.sunMu],
      ['wxCloud', this.cloud],
      ['wxNoise', this.noise],
    ]
  }

  /** ¿hay algo que dibujar? (si no, el shader va por el camino de siempre) */
  get active(): boolean {
    return this.cam.value.w > 0.5
  }

  set(state: WeatherState, oatC: number, ground: number, cloudBaseAgl: number): void {
    this.state = state
    this.oatC = oatC
    this.ground = ground
    const s = state
    this.haze.value.set(s.hazeBeta, s.hazeH, s.dust, 0.8 - 0.12 * s.dust)
    // niebla: desde 250 m por debajo de la salida (los valles) hasta su cima; borde difuso de un tercio
    this.fog.value.set(s.fogBeta, -250, s.fogDepth, Math.max(12, s.fogDepth * 0.35))
    // isoterma de 0,5 °C sobre la salida (gradiente estándar)
    const zero = (oatC - 0.5) / 0.0065
    const top = s.kind === 'none' ? 0 : cloudBaseAgl
    this.rain.value.set(s.rainBeta, s.snowBeta, zero, top)
    const precip = s.kind !== 'none'
    this.wetness = precip ? (s.kind === 'drizzle' ? 0.6 : 1) : 0
    this.wet.value.set(this.wetness, precip ? 1 : 0, zero, 0)
    this.cam.value.w = s.hazeBeta > 0 || s.fogBeta > 0 || precip ? 1 : 0
  }

  /**
   * @param camH altura elipsoidal de la cámara
   * @param sun irradiancia del sol (perpendicular) que llega a la cámara, ya con nubes y sombras
   * @param amb irradiancia difusa horizontal (cielo y nubes)
   */
  update(dt: number, camH: number, sunMu: number, cloudBottom: number, cloudTop: number): void {
    this.time += dt
    this.cam.value.x = camH - this.ground
    this.cam.value.z = this.time
    this.sunMu.value = sunMu
    this.cloud.value.set(Number.isFinite(cloudBottom) ? cloudBottom - camH : 1e9, Number.isFinite(cloudTop) ? cloudTop - camH : 1e9)
  }

  /** Extinción añadida (1/m) a la altura h (m sobre la salida). */
  extinction(h: number): number {
    const hz = this.haze.value
    const f = this.fog.value
    const r = this.rain.value
    let b = hz.x * Math.exp(-Math.max(h, -400) / hz.y)
    if (f.x > 0 && h >= f.y) b += f.x * Math.min(1, Math.max(0, (f.z - h) / Math.min(f.w, f.z - f.y)))
    if (h < Math.min(r.z, r.w)) b += r.x
    else if (h < r.w) b += r.y
    return b
  }

  /** Espesor óptico vertical de bruma, niebla y precipitación por encima de h (m sobre la salida): para las luces reales. */
  above(h: number): number {
    const hz = this.haze.value
    const f = this.fog.value
    const r = this.rain.value
    let t = hz.x * hz.y * Math.exp(-Math.max(h, -400) / hz.y)
    if (f.x > 0) t += f.x * Math.max(0, f.z - 0.5 * f.w - Math.max(h, f.y))
    t += r.x * Math.max(Math.min(r.z, r.w) - h, 0) + r.y * Math.max(r.w - Math.max(h, r.z), 0)
    return t
  }
}
