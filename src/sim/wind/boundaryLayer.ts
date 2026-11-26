// Capa límite atmosférica del día: del viento a 10 m del menú, la hora, las nubes y la temperatura
// salen la estabilidad, la altura de la capa límite, el perfil vertical del viento (con su giro) y la
// turbulencia. Todo con fórmulas publicadas (sin datos del navegador: lo usan también las pruebas).
//
//  - Radiación neta y calor sensible: Holtslag y van Ulden (1983, J. Climate Appl. Meteor. 22) para la
//    radiación (sol según su elevación, nubes con el factor de Kasten y Czeplak) y el reparto por
//    razón de Bowen de AERMET (EPA, Cimorelli et al. 2005): H = 0,9·Q*·B/(1+B).
//  - Noche: θ* = 0,09·(1 − 0,5·N²) K y la u* de Venkatram / van Ulden y Holtslag (1985), como AERMET.
//  - Perfil de la capa superficial: Monin-Obukhov con ψ de Paulson (1970) en inestable y de Beljaars y
//    Holtslag (1991) en estable.
//  - Altura: convectiva = base de los cúmulos o crecimiento por calentamiento («encroachment»,
//    Tennekes 1973); neutra 0,2·u*/|f|; estable 0,4·√(u*·L/|f|) (Zilitinkevich 1972).
//  - Viento en lo alto y giro total: ley de resistencia geostrófica con A = 1,8 y B = 4,5 (Atlas
//    Eólico Europeo, Troen y Petersen 1989); el giro se reparte con la altura como en la espiral de
//    Ekman. De día (capa mezclada) gira poco y de noche mucho (valores típicos de Stull 1988).
//  - Rugosidad del sitio: corrección de exposición de Wieringa (1986): el viento a la «altura de
//    mezcla» (60 m) es el de la zona y por debajo manda la rugosidad de lo que hay a barlovento.
//  - Turbulencia: σ de Panofsky y Dutton (1984) con u*, la parte convectiva de Lenschow et al. (1980)
//    con w*, y escalas de longitud de MIL-HDBK-1797 (baja cota).

export const KAPPA = 0.4
const G0 = 9.80665
/** ρ·cp del aire (J/m³/K) */
const RHO_CP = 1200
const DEG = Math.PI / 180
/** rugosidad del sitio de referencia del viento del menú (anemómetro de aeródromo: hierba, z0 = 0,03 m) */
export const Z0_REF = 0.03
/** gradiente de temperatura potencial sobre la capa de mezcla (K/m) para el crecimiento diurno */
const GAMMA_THETA = 0.005

/** Tipos de suelo: rugosidad (clases de Davenport-Wieringa), albedo y razón de Bowen (tablas de AERMET). */
export interface Surface {
  z0: number
  albedo: number
  bowen: number
  /** fracción de la radiación neta que se guarda en el suelo */
  storage: number
}
export const SURFACES = {
  water: { z0: 0.0002, albedo: 0.08, bowen: 0.1, storage: 0.9 },
  field: { z0: 0.05, albedo: 0.2, bowen: 1.0, storage: 0.1 },
  forest: { z0: 1.0, albedo: 0.12, bowen: 0.5, storage: 0.1 },
  city: { z0: 1.5, albedo: 0.16, bowen: 1.5, storage: 0.2 },
} satisfies Record<string, Surface>

/** Declinación (rad) y ecuación del tiempo (min) del día del año (series de la NOAA). */
function sunOfDay(dayOfYear: number): { decl: number; eq: number } {
  const g = ((2 * Math.PI) / 365) * (dayOfYear - 1)
  const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g))
  const decl =
    0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g)
  return { decl, eq }
}

/** Seno de la elevación del sol en (lat°, lon°), día del año y hora UTC (decimal). */
export function sinSolarElevation(latDeg: number, lonDeg: number, dayOfYear: number, utcHours: number): number {
  const { decl, eq } = sunOfDay(dayOfYear)
  const solar = utcHours * 60 + eq + 4 * lonDeg
  const ha = (solar / 4 - 180) * DEG
  const phi = latDeg * DEG
  return Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha)
}

/** Radiación neta Q* (W/m²) de Holtslag y van Ulden (1983). `cloud` 0..1, `tK` temperatura del aire (K). */
export function netRadiation(sinElev: number, cloud: number, tK: number, albedo: number): number {
  const N = Math.min(1, Math.max(0, cloud))
  const K = sinElev > 0.03 ? Math.max(0, (990 * sinElev - 30) * (1 - 0.75 * Math.pow(N, 3.4))) : 0
  return ((1 - albedo) * K + 5.31e-13 * tK ** 6 - 5.67e-8 * tK ** 4 + 60 * N) / 1.12
}

/** Calor sensible (W/m²) que el suelo da al aire de día (≤ 0: no hay convección). */
export function sensibleHeat(sinElev: number, cloud: number, tK: number, s: Surface): number {
  const q = netRadiation(sinElev, cloud, tK, s.albedo)
  if (q <= 0) return q * 0.3
  return ((1 - s.storage) * q * s.bowen) / (1 + s.bowen)
}

/**
 * Calor acumulado desde el amanecer, ∫H/(ρ·cp) dt (K·m), sobre campo abierto: con él crece la capa
 * de mezcla. Se integra el día hacia atrás en pasos de 10 min hasta la noche anterior.
 */
export function heatSinceSunrise(latDeg: number, lonDeg: number, dayOfYear: number, utcHours: number, cloud: number, tK: number): number {
  let sum = 0
  const step = 1 / 6
  for (let k = 0; k < 6 * 20; k++) {
    const h = sensibleHeat(sinSolarElevation(latDeg, lonDeg, dayOfYear, utcHours - k * step), cloud, tK, SURFACES.field)
    if (h <= 0) {
      if (k > 0) break
      continue
    }
    sum += (h / RHO_CP) * step * 3600
  }
  return sum
}

/** ψm de Monin-Obukhov (ζ = z/L). */
export function psiM(zeta: number): number {
  if (zeta < 0) {
    const x = Math.pow(1 - 16 * Math.max(zeta, -50), 0.25)
    return 2 * Math.log((1 + x) / 2) + Math.log((1 + x * x) / 2) - 2 * Math.atan(x) + Math.PI / 2
  }
  const z = Math.min(zeta, 20)
  return -(z + (2 / 3) * (z - 5 / 0.35) * Math.exp(-0.35 * z) + (2 / 3) * (5 / 0.35))
}

export interface BLInput {
  /** viento del menú: velocidad a 10 m sobre hierba (m/s) y dirección de la que viene (°) */
  speed10: number
  fromDeg: number
  latDeg: number
  /** seno de la elevación del sol */
  sinElev: number
  /** fracción de cielo cubierto 0..1 */
  cloud: number
  /** temperatura del aire en el suelo (°C) */
  tempC: number
  /** base de los cúmulos sobre el suelo (m) o null sin cúmulos */
  cloudBaseAgl: number | null
  /** ∫H/(ρ·cp) dt desde el amanecer (K·m): `heatSinceSunrise` */
  heat: number
}

export interface BoundaryLayer {
  speed10: number
  fromDeg: number
  /** +1 hemisferio norte (el viento gira a la derecha al subir), −1 sur */
  veer: number
  tK: number
  sinElev: number
  cloud: number
  /** velocidad de fricción sobre el sitio de referencia (m/s) */
  ustar: number
  /** 1/L de Obukhov (1/m): < 0 inestable, > 0 estable */
  invL: number
  /** calor sensible sobre campo abierto (W/m²) */
  heatFlux: number
  /** altura de la capa límite (m) */
  h: number
  /** capa convectiva: su altura zi (m) y w* (m/s); 0 si no hay convección */
  zi: number
  wstar: number
  /** viento por encima de la capa límite (m/s) y giro total entre 10 m y lo alto (rad) */
  top: number
  turn: number
  /** altura de mezcla de rugosidades (m), tope de la capa superficial (m) y viento de referencia en ellas */
  zb: number
  zs: number
  uB: number
  uS: number
  kind: 'convective' | 'neutral' | 'stable'
}

const mo = (z: number, z0: number, invL: number): number => Math.log(z / z0) - psiM(z * invL) + psiM(z0 * invL)

/** Resuelve la capa límite del día. */
export function solveBoundaryLayer(i: BLInput): BoundaryLayer {
  const tK = i.tempC + 273.15
  const U = Math.max(i.speed10, 0.05)
  const z0 = Z0_REF
  const zr = 10
  const lat = Math.abs(i.latDeg) < 15 ? 15 : Math.abs(i.latDeg)
  const f = 2 * 7.292e-5 * Math.sin(lat * DEG)
  const H = sensibleHeat(i.sinElev, i.cloud, tK, SURFACES.field)
  const un = (KAPPA * U) / Math.log(zr / z0)
  let ustar = un
  let invL = 0
  if (H > 1) {
    // inestable: u* y L a la vez
    for (let k = 0; k < 8; k++) {
      invL = -(KAPPA * G0 * H) / (RHO_CP * tK * Math.max(ustar, 0.03) ** 3)
      invL = Math.max(invL, -2)
      ustar = (KAPPA * U) / mo(zr, z0, invL)
    }
  } else if (H < -0.5 || i.sinElev <= 0.03) {
    // estable (noche o sol muy bajo con nubes): Venkatram / van Ulden y Holtslag
    const thetaStar = 0.09 * (1 - 0.5 * i.cloud * i.cloud)
    const cd = KAPPA / Math.log(zr / z0)
    const u0 = Math.sqrt((4.7 * zr * G0 * thetaStar) / tK)
    const ucr = (2 * u0) / Math.sqrt(cd)
    let ts = thetaStar
    if (U >= ucr) ustar = ((cd * U) / 2) * (1 + Math.sqrt(1 - (ucr / U) ** 2))
    else {
      ustar = ((cd * ucr) / 2) * (U / ucr)
      ts = thetaStar * (U / ucr)
    }
    ustar = Math.max(ustar, 0.02)
    invL = Math.min(0.5, (KAPPA * G0 * ts) / (tK * ustar * ustar))
  }
  const hMech = Math.min(2500, Math.max(60, (0.2 * un) / f))
  let h: number
  let zi = 0
  let wstar = 0
  let kind: BoundaryLayer['kind'] = 'neutral'
  if (invL > 1e-4) {
    kind = 'stable'
    h = Math.min(hMech, Math.max(40, 0.4 * Math.sqrt(ustar / invL / f)))
  } else if (H > 1) {
    // crecimiento por calentamiento desde el amanecer; con cúmulos, hasta su base (si el calor del día
    // da para acercarse a ella: una mañana de invierno con cúmulos dibujados no tiene térmicas de verano)
    const enc = Math.sqrt(100 * 100 + (2 * 1.4 * i.heat) / GAMMA_THETA)
    zi = i.cloudBaseAgl !== null ? Math.min(i.cloudBaseAgl, 1.5 * enc) : Math.min(enc, 3500)
    wstar = Math.cbrt((G0 / tK) * (H / RHO_CP) * zi)
    h = Math.max(zi, hMech * 0.5)
    if (-zi * invL > 1.5) kind = 'convective'
  } else h = hMech

  // viento en lo alto y giro total (ley de resistencia, neutra) y su corrección por estabilidad
  const gN = (un / KAPPA) * Math.hypot(Math.log(un / (f * z0)) - 1.8, 4.5)
  const aN = Math.asin(Math.min(0.9, (4.5 * un) / (KAPPA * gN)))
  const zb = Math.min(60, Math.max(20, 0.5 * h))
  const zs = Math.max(0.1 * h, zb)
  const sl = (z: number): number => (ustar / KAPPA) * mo(z, z0, invL)
  const uB = sl(zb)
  const uS = sl(zs)
  let top: number
  let turn: number
  if (kind === 'stable') {
    top = Math.max(sl(h), gN)
    turn = aN + (45 * DEG - aN) * (1 - Math.exp(-(h * invL) / 3))
  } else if (H > 1) {
    const s = Math.sqrt(Math.max(0, -zi * invL))
    // capa mezclada: casi uniforme y con poco giro; con viento fuerte tiende a la neutra
    const mix = s / (2 + s)
    top = Math.max(uS * 1.1, gN * (1 - mix) + uS * 1.1 * mix)
    turn = aN / (1 + 0.25 * s)
  } else {
    top = Math.max(gN, uS)
    turn = aN
  }
  if (i.speed10 < 0.05) top = 0
  return {
    speed10: i.speed10,
    fromDeg: i.fromDeg,
    veer: i.latDeg >= 0 ? 1 : -1,
    tK,
    sinElev: i.sinElev,
    cloud: i.cloud,
    ustar,
    invL,
    heatFlux: H,
    h,
    zi,
    wstar,
    top,
    turn,
    zb,
    zs,
    uB,
    uS,
    kind,
  }
}

/** Viento medio (m/s) a la altura z sobre el sitio de referencia (hierba de aeródromo). */
export function refSpeed(bl: BoundaryLayer, z: number): number {
  if (bl.speed10 < 0.05) return 0
  if (z >= bl.h) return bl.top
  if (z <= bl.zs) return (bl.ustar / KAPPA) * mo(Math.max(z, 2 * Z0_REF), Z0_REF, bl.invL)
  const s = (z - bl.zs) / Math.max(1, bl.h - bl.zs)
  return bl.uS + (bl.top - bl.uS) * (1 - (1 - s) * (1 - s))
}

export interface LocalProfile {
  /** viento medio (m/s) y velocidad de fricción local (m/s) */
  speed: number
  ustar: number
}

/**
 * Viento medio a la altura z sobre un suelo de rugosidad efectiva `z0e` (la de barlovento). Por
 * debajo de la altura de mezcla el perfil es el de esa rugosidad (Wieringa 1986); por encima, el de la zona.
 * `overWater`: el agua no se calienta con el sol (perfil neutro aunque sea de día).
 */
export function localProfile(bl: BoundaryLayer, z: number, z0e: number, overWater: boolean, out: LocalProfile): LocalProfile {
  if (bl.speed10 < 0.05) {
    out.speed = 0
    out.ustar = 0
    return out
  }
  const invL = overWater ? Math.max(0, bl.invL) * 0.3 : bl.invL
  const fb = mo(bl.zb, z0e, invL)
  out.ustar = (KAPPA * bl.uB) / fb
  if (z >= bl.zb) out.speed = refSpeed(bl, z)
  else {
    const zz = Math.max(z, 3 * z0e, 0.3)
    out.speed = (bl.uB * Math.max(0, mo(zz, z0e, invL))) / fb
    // por debajo de los elementos rugosos (z < 3·z0) el viento sigue bajando hacia el suelo
    if (z < zz) out.speed *= 0.5 + 0.5 * Math.max(0, z / zz)
  }
  return out
}

/** Dirección de la espiral de Ekman normalizada: 1 en el suelo, 0 en lo alto (ζ = π). */
function ekmanShape(zeta: number): number {
  if (zeta >= Math.PI) return 0
  if (zeta < 1e-4) return 1
  const e = Math.exp(-zeta)
  return Math.atan2(e * Math.sin(zeta), 1 - e * Math.cos(zeta)) / (Math.PI / 4)
}

/**
 * Giro del viento (rad) a la altura z respecto al de 10 m: positivo = a la derecha (viene de un
 * rumbo mayor) en el hemisferio norte; en el sur, al revés.
 */
export function turnAt(bl: BoundaryLayer, z: number): number {
  const sh = (zz: number) => ekmanShape((Math.PI * Math.max(0, zz)) / bl.h)
  return bl.veer * bl.turn * Math.max(0, sh(10) - sh(z)) / Math.max(0.2, sh(10))
}

export interface Turbulence {
  /** desviación típica de la racha horizontal y vertical (m/s) */
  sigH: number
  sigW: number
  /** escalas de longitud (m) */
  lenH: number
  lenW: number
  /**
   * Parte lenta de la racha horizontal (m/s) y su escala (m): los remolinos convectivos del tamaño de
   * la capa de mezcla, que cerca del suelo se notan como cambios de viento de minutos, no como meneo.
   */
  sigSlow: number
  lenSlow: number
}

/**
 * Turbulencia a la altura z con la fricción local `ustar`: mecánica (Panofsky y Dutton) que se apaga
 * hacia lo alto de la capa límite, más la convectiva de día (Lenschow et al. 1980 en vertical y 0,6·w* en horizontal, Panofsky et al. 1977; las térmicas
 * grandes van aparte, como columnas, y aquí queda la parte pequeña). `convection`: 0..1, cuánta
 * convección hay sobre este suelo (sobre el agua, casi nada).
 */
export function turbulenceAt(bl: BoundaryLayer, z: number, ustar: number, out: Turbulence, convection = 1): Turbulence {
  const zz = Math.max(z, 1)
  const r = Math.min(1, zz / bl.h)
  const decay = bl.kind === 'stable' ? 1 - r : Math.pow(1 - 0.85 * r, 0.75)
  const fade = zz > bl.h ? Math.max(0, 1 - (zz - bl.h) / (0.2 * bl.h)) : 1
  const su = 2.39 * ustar * decay * fade
  const sv = 1.92 * ustar * decay * fade
  const sw = 1.25 * ustar * decay * fade
  let cu = 0
  let cw = 0
  if (bl.wstar > 0 && convection > 0) {
    const q = Math.min(1.2, zz / bl.zi)
    const cf = q > 1 ? Math.max(0, 1 - (q - 1) / 0.2) : 1
    cu = 0.6 * bl.wstar * cf * convection
    cw = 0.6 * Math.sqrt(1.8) * Math.pow(q, 1 / 3) * Math.max(0, 1 - 0.8 * q) * bl.wstar * cf * convection
  }
  // aire libre por encima: un resto pequeño
  const free = 0.03 * bl.top
  out.sigH = Math.sqrt((su * su + sv * sv) / 2 + free * free)
  out.sigSlow = cu
  out.lenSlow = Math.max(300, 0.6 * bl.zi)
  out.sigW = Math.sqrt(sw * sw + cw * cw + 0.25 * free * free)
  // MIL-HDBK-1797, baja cota (pies): Lw = h, Lu = h / (0,177 + 0,000823·h)^1,2; por encima de 1000 ft, 1750 ft
  const hf = Math.min(1000, Math.max(10, zz * 3.28084))
  out.lenW = hf / 3.28084
  out.lenH = hf / Math.pow(0.177 + 0.000823 * hf, 1.2) / 3.28084
  if (bl.wstar > 0 && zz > 0.1 * bl.zi) out.lenW = Math.max(out.lenW, 0.15 * bl.zi)
  return out
}
