// El aire del día: temperatura y presión (QNH) → densidad, temperatura y punto de rocío a cualquier
// altitud, altitud de densidad y lo que marcan los instrumentos (altímetro calado al QNH, variómetro).
//
// Una sola columna de aire anclada en el suelo de la salida (sin cambios de un sitio a otro):
//  - temperatura: la del suelo de la salida y, hacia arriba, el gradiente estándar de 6,5 °C/km;
//  - presión: la del suelo sale del QNH por su propia definición (el altímetro calado al QNH marca la
//    elevación del campo: p = QNH·(1 − L·h/T0)^5,2559) y, por encima o por debajo, de la ley
//    hidrostática con la temperatura de verdad (p ∝ T^5,2559). Con calor la presión cae más despacio
//    al subir y el altímetro marca menos de la altura real («de alto a bajo, cuidado abajo» al revés);
//  - densidad: ρ = p / (R·T). Es lo único que leen el rotor, la hélice, el motor y la resistencia.
// Con 15 °C a nivel del mar y QNH 1013,25 sale exactamente la atmósfera estándar (ISA), y en modo
// ISA la densidad es la de `isaDensity`, la de siempre, bit a bit.
//
// Lo usa main.ts (`AirModel.fill` rellena el entorno de la física en cada fotograma) y el menú
// (altitud de densidad de la salida en el plan de vuelo).

import { isaDensity } from './atmosphere.ts'

/** Constantes de la atmósfera estándar (las mismas que `isaDensity`). */
export const ISA_T0 = 288.15
export const ISA_P0 = 101325
export const ISA_L = 0.0065
export const AIR_R = 287.05
/** g / (R·L) */
export const ISA_N = 5.2559
/** densidad ISA a nivel del mar (kg/m³) */
export const ISA_RHO0 = ISA_P0 / (AIR_R * ISA_T0)
/** QNH estándar (hPa) */
export const QNH_STD = 1013.25
/** diferencia entre temperatura y punto de rocío del modo ISA (humedad relativa ≈ 50 %) */
export const ISA_DEW_SPREAD = 10
/** el punto de rocío baja ~1,8 °C/km en una capa bien mezclada (base de cúmulos ≈ 125 m por °C de diferencia) */
const DEW_LAPSE = 0.0018
/** tropopausa: la temperatura no baja de aquí */
const T_MIN = 216.65

/** Temperatura ISA (°C) a la altitud h (m). */
export function isaTempC(h: number): number {
  return ISA_T0 - ISA_L * Math.max(-500, Math.min(h, 11000)) - 273.15
}

/** Presión ISA (Pa) a la altitud h (m). */
export function isaPressure(h: number): number {
  return ISA_P0 * Math.pow(1 - (ISA_L * h) / ISA_T0, ISA_N)
}

/** Altitud de densidad (m): la altitud ISA con esa densidad. */
export function densityAltitude(rho: number): number {
  return (ISA_T0 / ISA_L) * (1 - Math.pow(rho / ISA_RHO0, 1 / (ISA_N - 1)))
}

/** Altitud de presión (m): lo que marca un altímetro calado a 1013,25. */
export function pressureAltitude(p: number): number {
  return altimeterReading(p, QNH_STD)
}

/** Lo que marca (m) un altímetro calado a `qnh` (hPa) con presión estática `p` (Pa). */
export function altimeterReading(p: number, qnh: number): number {
  return (ISA_T0 / ISA_L) * (1 - Math.pow(p / (qnh * 100), 1 / ISA_N))
}

/** QNH (hPa) a partir de la presión en la estación (hPa) y su elevación (m). */
export function qnhFromStation(pHpa: number, elev: number): number {
  return pHpa / Math.pow(1 - (ISA_L * elev) / ISA_T0, ISA_N)
}

/**
 * Motor turbo con aire caliente o frío: el turbo mantiene la presión de admisión, pero la carga entra
 * con la temperatura del día y su densidad cambia con ella. A igual presión la potencia va como
 * √(T_ISA/T) (la corrección de potencia SAE J1349 / DIN 70020): unos −4 % a ISA+25. Con la atmósfera
 * estándar o sin temperatura (pruebas sin navegador), exactamente 1.
 */
export function turboTempFactor(oatC: number | undefined, pressure: number | undefined): number {
  if (oatC === undefined || pressure === undefined) return 1
  const r = (ISA_T0 * Math.pow(pressure / ISA_P0, 1 / ISA_N)) / (oatC + 273.15)
  return Math.abs(r - 1) < 1e-9 ? 1 : Math.sqrt(r)
}

/** Humedad relativa (0..1) con temperatura y punto de rocío en °C (Magnus, sobre agua). */
export function relHumidity(tC: number, dewC: number): number {
  const es = (x: number) => Math.exp((17.625 * x) / (243.04 + x))
  return Math.min(1, es(Math.min(dewC, tC)) / es(tC))
}

/** Lo que el menú y la sala cuentan del aire (ajustes del jugador). */
export interface AirSettings {
  /** atmósfera estándar: 15 °C y 1013,25 hPa a nivel del mar */
  isa: boolean
  /** temperatura en el suelo de la salida (°C) */
  oatC: number
  /** QNH (hPa) */
  qnh: number
  /** punto de rocío en el suelo de la salida (°C) */
  dewPointC: number
}

/** Campos del entorno de la física que rellena `AirModel.fill` (ver `Environment` en autogyro.ts). */
export interface AirEnv {
  rho: number
  oatC?: number
  dewPointC?: number
  pressure?: number
}

/** El aire del día: una columna anclada en el suelo de la salida. */
export class AirModel {
  isa = true
  /** temperatura (°C) y punto de rocío en el suelo de la salida */
  tempC = 15
  dewC = 15 - ISA_DEW_SPREAD
  qnh = QNH_STD
  /** altitud (m sobre el nivel del mar) del suelo de la salida */
  private elevM = 0

  set(s: AirSettings): void {
    this.isa = s.isa
    this.tempC = s.oatC
    this.qnh = s.qnh
    this.dewC = Math.min(s.dewPointC, s.oatC)
  }

  /** Suelo de la salida (m sobre el nivel del mar): ahí está la temperatura del menú. */
  get elev(): number {
    return this.elevM
  }
  set elev(h: number) {
    this.elevM = Number.isFinite(h) ? h : 0
  }

  /** temperatura en el suelo de la salida (°C) */
  groundTempC(): number {
    return this.isa ? isaTempC(this.elevM) : this.tempC
  }

  groundDewC(): number {
    return this.isa ? isaTempC(this.elevM) - ISA_DEW_SPREAD : this.dewC
  }

  /** Temperatura (K) a la altitud h (m). */
  tempK(h: number): number {
    if (this.isa) return isaTempC(h) + 273.15
    return Math.max(T_MIN, this.tempC + 273.15 - ISA_L * (h - this.elevM))
  }

  /** Presión estática (Pa) a la altitud h (m). */
  pressure(h: number): number {
    if (this.isa) return isaPressure(h)
    const tg = this.tempC + 273.15
    const pg = this.qnh * 100 * Math.pow(1 - (ISA_L * this.elevM) / ISA_T0, ISA_N)
    return pg * Math.pow(this.tempK(h) / tg, ISA_N)
  }

  /** Densidad (kg/m³) a la altitud h (m). */
  density(h: number): number {
    if (this.isa) return isaDensity(h)
    return this.pressure(h) / (AIR_R * this.tempK(h))
  }

  /** Punto de rocío (°C) a la altitud h (m): nunca por encima de la temperatura. */
  dewPointC(h: number): number {
    return Math.min(this.tempK(h) - 273.15, this.groundDewC() - DEW_LAPSE * (h - this.elevM))
  }

  /** Rellena el entorno de la física a la altitud h (m sobre el nivel del mar). */
  fill(env: AirEnv, h: number): void {
    env.rho = this.density(h)
    env.oatC = this.tempK(h) - 273.15
    env.dewPointC = this.dewPointC(h)
    env.pressure = this.pressure(h)
  }

  /** Lo que marca (m) el altímetro calado al QNH del día a la altitud h. */
  altimeter(h: number): number {
    return this.isa ? h : altimeterReading(this.pressure(h), this.qnh)
  }

  /**
   * Variómetro: mide cómo cambia la presión, así que marca la velocidad vertical «de altímetro»:
   * la verdadera × T_ISA(altitud indicada) / T real (con calor marca algo menos de lo que se sube).
   */
  vsiFactor(h: number): number {
    if (this.isa) return 1
    const hi = this.altimeter(h)
    return (ISA_T0 - ISA_L * hi) / this.tempK(h)
  }

  /** Altitud de densidad (m) a la altitud h. */
  densityAltitude(h: number): number {
    return densityAltitude(this.density(h))
  }
}
