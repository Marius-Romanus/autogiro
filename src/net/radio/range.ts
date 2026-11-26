// Radio de voz: alcance VHF (banda aérea, 118–137 MHz).
//
// En VHF la potencia sobra (6 W y −107 dBm de sensibilidad dan ~145 dB de margen frente a los
// ~100 dB de espacio libre a 20 km): lo que limita es la LÍNEA DE VISTA. Dos cosas:
//
// 1. Horizonte radioeléctrico (Tierra con refracción estándar, k = 4/3):
//        d (NM) ≈ 1,23 · (√h₁ + √h₂),  h en pies sobre el terreno
//    Dos aparatos en la pista se oyen a ~8 km; a 500 ft, a ~100 km.
// 2. Relieve en medio: difracción de filo de cuchillo (ITU-R P.526), con el parámetro de Fresnel
//    del obstáculo que más tapa, v = h·√(2d / (λ·d₁·d₂)), y la pérdida
//        J(v) ≈ 6,9 + 20·log₁₀(√((v − 0,1)² + 1) + v − 0,1)  dB  (v > −0,78)
//
// El resultado es un margen en dB sobre el umbral del silenciador: 40 = limpio, por debajo de
// ~28 empieza el soplido, cerca de 0 se entrecorta y por debajo no se oye nada.

/** longitud de onda (m) a ~120 MHz */
export const LAMBDA = 2.5
/** radio de la Tierra (m) y factor de refracción estándar */
const R_EARTH = 6371000
const K_REFRACTION = 4 / 3
/** margen (dB) de un enlace limpio y desde dónde se nota el soplido */
export const CLEAN_DB = 40
export const HISS_DB = 28

/** Horizonte radioeléctrico (m) entre dos antenas a h1 y h2 metros sobre el terreno. */
export function radioHorizon(h1: number, h2: number): number {
  const ft = (m: number) => Math.max(1.5, m) * 3.28084
  return 1.23 * (Math.sqrt(ft(h1)) + Math.sqrt(ft(h2))) * 1852
}

/** Pérdida por difracción de un filo (dB) para el parámetro de Fresnel v. */
export function knifeEdgeLoss(v: number): number {
  if (v <= -0.78) return 0
  return 6.9 + 20 * Math.log10(Math.sqrt((v - 0.1) * (v - 0.1) + 1) + v - 0.1)
}

/**
 * Parámetro de Fresnel de un obstáculo a d1 y d2 metros de cada antena que sobresale `h` metros
 * por encima de la recta entre ellas (negativo: la recta pasa por encima). Se le resta la parte
 * de la curvatura que compensa la refracción (la recta del modelo es geométrica).
 */
export function fresnelV(h: number, d1: number, d2: number): number {
  const d = d1 + d2
  if (d1 <= 1 || d2 <= 1) return -10
  const refr = ((d1 * d2) / (2 * R_EARTH)) * (1 - 1 / K_REFRACTION)
  return (h - refr) * Math.sqrt((2 * d) / (LAMBDA * d1 * d2))
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * Margen del enlace (dB sobre el umbral del silenciador).
 * @param d distancia entre antenas (m)
 * @param h1 altura de una antena sobre su terreno (m)
 * @param h2 la de la otra
 * @param vMax parámetro de Fresnel del relieve que más tapa (−Infinity: nada en medio o sin datos)
 */
export function linkMargin(d: number, h1: number, h2: number, vMax: number): number {
  const q = d / radioHorizon(h1, h2)
  // limpio hasta ~70 % del horizonte; el soplido crece hasta él y poco más allá ya no llega
  // (más lejos, la sombra de la Tierra sigue sumando pérdida: ni un desvanecimiento lo abre)
  const horizon = 46 * smooth(0.7, 1.15, q) + 60 * Math.max(0, q - 1.15)
  // el relieve pesa algo más que un filo ideal: varias crestas, suelo, vegetación
  const terrain = 1.6 * knifeEdgeLoss(vMax)
  return CLEAN_DB - horizon - terrain
}
