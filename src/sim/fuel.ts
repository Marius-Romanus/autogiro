// Combustible: depósito de cada aparato y consumo de cada motor.
//
// · Depósito (`FUEL`, por id de aparato): capacidad total y combustible no utilizable con datos
//   publicados (manuales, fabricantes, hojas de datos de la CAA británica). Lo que no se ha
//   encontrado lleva `est: true` y la razón de la cifra. El peso del combustible va en el CG salvo
//   que se sepa dónde está el depósito (`tank`): entonces el CG se mueve al gastarlo.
// · Consumo (`ENGINE_FUEL`, por id de motor): litros por kWh que da el motor en el eje según la
//   fracción de su potencia máxima a la que trabaja (curva de consumo específico, con el
//   enriquecimiento a plena potencia de los carburadores), con un mínimo al ralentí que crece con
//   las vueltas. La potencia es la que da el motor del modelo en cada paso (`Autogyro.enginePower`).
// · `fuelMass` de la ficha (airframes.ts) sigue siendo la carga de referencia de los bancos de
//   pruebas: con ella el CG es el de la ficha y las pruebas dan lo mismo que antes.

import { Vector3 } from 'three'
import type { Airframe } from './airframes.ts'
import type { EngineSpec } from './engines.ts'

export interface FuelSpec {
  /** capacidad total del depósito o depósitos (l) */
  capacity: number
  /** combustible no utilizable (l): queda en el depósito cuando el motor se para por falta de él */
  unusable: number
  /** densidad (kg/l): gasolina 0,72; mezcla de dos tiempos ~0,73 */
  density: number
  /** centro del depósito (origen del modelo); sin él, el peso del combustible va en el CG */
  tank?: Vector3
  /** de dónde salen las cifras */
  source: string
  /** alguna cifra es una estimación (dicha en `source`) */
  est?: boolean
  /** sin consumo (motor de ficción) */
  none?: boolean
}

const v = (x: number, y: number) => new Vector3(x, y, 0)
const AVGAS = 0.72
const PREMIX = 0.73

/** Depósito de cada aparato del catálogo (por id de airframes.ts). */
export const FUEL: Record<string, FuelSpec> = {
  // MTOsport de 2010 con el segundo depósito: 70 l, 4 l no utilizables (hoja BG02 de la CAA). Los
  // depósitos de los AutoGyro de tándem van bajo el asiento trasero (posición estimada).
  generic: { capacity: 70, unusable: 4, density: AVGAS, tank: v(-0.05, -0.45), source: 'CAA BG02 (MTOsport, dos depósitos); posición estimada', est: true },
  ela07: { capacity: 75, unusable: 2, density: AVGAS, source: 'ELA Aviación: 75 l; no utilizable estimado', est: true },
  ela10: { capacity: 100, unusable: 2, density: AVGAS, source: 'ELA Aviación: 100 l; no utilizable estimado', est: true },
  // 23 galones imperiales (los 76 kg de los pesos de la RAE, R&M 1859). Depósito en el fuselaje
  // entre el motor y la cabina delantera (posición estimada): al gastarlo, el CG va hacia atrás.
  cierva: { capacity: 104.6, unusable: 2, density: AVGAS, tank: v(0.9, 0.35), source: 'RAE R&M 1859 (23 gal); no utilizable y posición estimados', est: true },
  mt03: { capacity: 35, unusable: 2, density: AVGAS, tank: v(-0.05, -0.45), source: 'CAA BG01 (un depósito); posición estimada', est: true },
  cavalon: { capacity: 103, unusable: 2.1, density: AVGAS, source: 'CAA BG06' },
  c44: { capacity: 85, unusable: 2, density: AVGAS, source: 'DAeC 61208.1 ed. 6 (Xenon IV: 2 × 42,5 l, 2 l no utilizables)' },
  scorpion: { capacity: 75, unusable: 2, density: AVGAS, source: 'el del ELA 07 (mismo fuselaje); no utilizable estimado', est: true },
  calidus: { capacity: 75, unusable: 1.2, density: AVGAS, source: 'CAA BG04 (dos depósitos)' },
  carterpav: { capacity: 227, unusable: 4, density: AVGAS, source: 'estimado (~60 galones US; Carter no lo publicó)', est: true },
  sclightning: { capacity: 18.9, unusable: 0.5, density: PREMIX, source: 'Sport Copter: 5 galones US; no utilizable estimado', est: true },
  sclightning_f: { capacity: 18.9, unusable: 0.5, density: PREMIX, source: 'Sport Copter: 5 galones US; no utilizable estimado', est: true },
  jro: { capacity: 68, unusable: 1.5, density: AVGAS, source: 'DTA: 68 l; no utilizable estimado', est: true },
  niki: { capacity: 70, unusable: 1.5, density: AVGAS, source: 'Niki Rotor Aviation: 70 l; no utilizable estimado', est: true },
  wa116: { capacity: 36, unusable: 1, density: PREMIX, source: '58 lb de gasolina (~8 galones imperiales); no utilizable estimado', est: true },
  tractor: { capacity: 75, unusable: 2, density: AVGAS, source: 'estimado: el depósito del ELA 07 (ELA no publica el del fumigador)', est: true },
  vencejo: { capacity: 90, unusable: 1.5, density: AVGAS, source: 'aparato inventado', est: true },
  sigilo: { capacity: 60, unusable: 0, density: AVGAS, source: 'ficción: el impulsor de plasma no gasta combustible', none: true },
  wilford: { capacity: 60.6, unusable: 1.5, density: AVGAS, source: 'Wilford Gyroplane: 16 galones US; no utilizable estimado', est: true },
  // 16 galones imperiales (Flight, 17-11-1932; 72 l en la Revista de Aeronáutica de mayo de 1932). Depósito
  // en el fuselaje tras el motor, bajo el carenado delantero (posición estimada): al gastarlo el CG va atrás
  cierva_c19: { capacity: 72.7, unusable: 1.5, density: AVGAS, tank: v(0.75, 0.2), source: 'Flight 1932 (16 gal); no utilizable y posición estimados', est: true },
  // el del Avro 504K: 25,5 galones imperiales (116 l) en el fuselaje tras el motor, bajo el carenado negro
  // (posición estimada); el aceite de ricino (6 gal) va aparte, en la masa en vacío
  cierva_c6: { capacity: 116, unusable: 2, density: AVGAS, tank: v(0.9, 0.35), source: 'Avro 504K: 25,5 gal imperiales (Wikipedia); no utilizable y posición estimados', est: true },
}

/** Depósito del aparato (si no está en la tabla: el combustible de referencia de su ficha). */
export function fuelSpec(af: Airframe): FuelSpec {
  return FUEL[af.id] ?? { capacity: Math.max(1, af.fuelMass / AVGAS), unusable: 1, density: AVGAS, source: 'sin datos: el combustible de la ficha', est: true }
}

// ---------------------------------------------------------------------------
// Consumo de cada motor
// ---------------------------------------------------------------------------

export interface EngineFuel {
  /**
   * Consumo específico (l por kWh en el eje) según la fracción de la potencia máxima: pares
   * [fracción, l/kWh] de menor a mayor; entre ellos, interpolación lineal.
   */
  sfc: [number, number][]
  /** consumo al ralentí en tierra (l/h, a `idleRpm`); sin carga crece con las vueltas */
  idle: number
  /** carburadores (hielo posible) o inyección */
  induction: 'carb' | 'injection' | 'none'
  /**
   * Propensión al hielo en el carburador respecto a un Rotax 912 (1): el 914 lleva los carburadores
   * después del turbo, que calienta el aire; los dos tiempos con carburador Bing son los peores.
   */
  iceRisk: number
  /** engrase a presión con manómetro (cuatro tiempos); los dos tiempos van con mezcla */
  oilPressure: boolean
  twoStroke: boolean
  /** presión de aceite normal en crucero (bar) */
  oilNormal: number
  /** de dónde salen las cifras */
  source: string
}

/** Curvas de consumo por id de motor (engines.ts). */
export const ENGINE_FUEL: Record<string, EngineFuel> = {
  // Manual de operación de Rotax (912 Series, §1.10): despegue 27 l/h (73,5 kW), máxima continua
  // 25 l/h (69 kW), 75 % de la continua 18,5 l/h (51,7 kW); por debajo, estimado.
  '912uls': {
    sfc: [[0.2, 0.5], [0.4, 0.4], [0.703, 0.358], [0.939, 0.362], [1, 0.367]],
    idle: 2.5,
    induction: 'carb',
    iceRisk: 1,
    oilPressure: true,
    twoStroke: false,
    oilNormal: 3.5,
    source: 'Rotax, manual de operación 912 Series (27 / 25 / 18,5 l/h)',
  },
  // Rotax no publica el caudal del 914 en el manual: con ~285 g/kWh, unos 20 l/h al 75 % de la
  // continua (55 kW) y ~35 l/h en despegue, más rico por el turbo (estimado).
  '914ul': {
    sfc: [[0.2, 0.5], [0.4, 0.4], [0.652, 0.363], [0.87, 0.39], [1, 0.41]],
    idle: 2.5,
    induction: 'carb',
    iceRisk: 0.35,
    oilPressure: true,
    twoStroke: false,
    oilNormal: 3.5,
    source: 'estimado con 285 g/kWh (Rotax no publica el caudal del 914)',
  },
  // 915 iS: el caudal va en el modelo del ECU; Wikipedia da 280-310 g/kWh a 5500 rpm. Estimado:
  // ~42 l/h en despegue (104 kW) y ~26 l/h al 75 % de la continua (76 kW). Inyección: sin hielo.
  '915is': {
    sfc: [[0.2, 0.46], [0.4, 0.37], [0.73, 0.345], [0.97, 0.385], [1, 0.4]],
    idle: 2.5,
    induction: 'injection',
    iceRisk: 0,
    oilPressure: true,
    twoStroke: false,
    oilNormal: 3.5,
    source: 'estimado con 280-310 g/kWh (Rotax 915 iS)',
  },
  // 912 ULS con turbo de Celier (BellComm C-44): BellComm da 22 l/h y FlyArgo 25 l/h de consumo; con la
  // curva del 914 (más rica arriba por el turbo) salen ~22 l/h a ~60 % de los 107 kW y ~44 l/h a plena
  // potencia. Carburadores con el turbo delante (como el 914): menos hielo que un 912 (estimado).
  ca912ulst: {
    sfc: [[0.2, 0.5], [0.4, 0.4], [0.62, 0.34], [0.85, 0.385], [1, 0.41]],
    idle: 2.5,
    induction: 'carb',
    iceRisk: 0.5,
    oilPressure: true,
    twoStroke: false,
    oilNormal: 3.5,
    source: 'BellComm (22 l/h) y FlyArgo (25 l/h); curva del 914 (estimada)',
  },
  // 503: unos 15 l/h (4 gal US/h; Wikipedia, citando a Rotax); la forma de la curva, la del 582
  // (425 g/kWh: 26,5 l/h en despegue y 20,5 al 75 %, manual del 582).
  '503ul': {
    sfc: [[0.25, 0.7], [0.5, 0.58], [0.75, 0.55], [1, 0.57]],
    idle: 2,
    induction: 'carb',
    iceRisk: 1.4,
    oilPressure: false,
    twoStroke: true,
    oilNormal: 0,
    source: '~15 l/h (Wikipedia, citando a Rotax); curva del 582 (manual del 582 UL)',
  },
  // McCulloch de los blancos aéreos (mezcla 10:1): sin datos; un dos tiempos de los 60 gasta
  // ~0,75 lb/CV·h (estimado).
  'mcculloch-4318a': {
    sfc: [[0.25, 0.85], [0.5, 0.7], [0.75, 0.66], [1, 0.68]],
    idle: 2.5,
    induction: 'carb',
    iceRisk: 1.2,
    oilPressure: false,
    twoStroke: true,
    oilNormal: 0,
    source: 'estimado (dos tiempos, ~480 g/kWh)',
  },
  // Genet Major: el C.19 con el mismo motor gastaba unos 6 galones imperiales/h en crucero
  // (NACA); radial de los años 30, ~0,5 lb/CV·h en crucero y más rico a plena potencia.
  'genet-major-ia': {
    sfc: [[0.3, 0.5], [0.6, 0.4], [0.75, 0.42], [1, 0.48]],
    idle: 4,
    induction: 'carb',
    iceRisk: 0.8,
    oilPressure: true,
    twoStroke: false,
    oilNormal: 4,
    source: 'NACA (C.19: ~6 gal/h en crucero); curva estimada',
  },
  // Genet Major I (5 cilindros, C.19 Mk IV): 16 galones imperiales para 230 millas a 90 mph (Flight,
  // 17-11-1932) = ~28,5 l/h en crucero, con el motor hacia el 70 % de su potencia (~0,52 l/kWh)
  'genet-major-i': {
    sfc: [[0.3, 0.62], [0.6, 0.52], [0.75, 0.52], [1, 0.58]],
    idle: 3.5,
    induction: 'carb',
    iceRisk: 0.8,
    oilPressure: true,
    twoStroke: false,
    oilNormal: 4,
    source: 'Flight 1932 (C.19 Mk IV: 16 gal para 230 millas a 90 mph); curva estimada',
  },
  // Le Rhône 9J (rotativo, C.6): unos 38 kg/h de gasolina a 110 CV y 1100 rpm (~53 l/h, ~0,64 l/kWh): los
  // rotativos gastaban mucho; con poco gas, más por kWh (estimado). Sin carburador: válvula de mezcla («bloctube»)
  // en el cigüeñal hueco, poco propensa al hielo; el pulsómetro del aceite hace de manómetro
  'le-rhone-9j': {
    sfc: [[0.3, 0.78], [0.6, 0.67], [0.8, 0.64], [1, 0.66]],
    idle: 7,
    induction: 'carb',
    iceRisk: 0.4,
    oilPressure: true,
    twoStroke: false,
    oilNormal: 2,
    source: '~38 kg/h a 110 CV (tablas del Le Rhône 110 CV); curva estimada',
  },
  'kinner-r5': {
    sfc: [[0.3, 0.52], [0.6, 0.41], [0.75, 0.42], [1, 0.47]],
    idle: 4,
    induction: 'carb',
    iceRisk: 0.8,
    oilPressure: true,
    twoStroke: false,
    oilNormal: 4,
    source: 'estimado (radial de los años 30, ~0,5 lb/CV·h)',
  },
  // Lycoming IO-540 de 300 CV: ~16,5 galones US/h al 75 % (mejor potencia), ~13,5 al 65 %,
  // ~26 a plena potencia con mezcla rica (tablas de Lycoming).
  'io-540': {
    sfc: [[0.2, 0.48], [0.4, 0.38], [0.65, 0.35], [0.75, 0.372], [1, 0.44]],
    idle: 6,
    induction: 'injection',
    iceRisk: 0,
    oilPressure: true,
    twoStroke: false,
    oilNormal: 4.5,
    source: 'Lycoming (16,5 gal/h al 75 %)',
  },
}

const NO_FUEL: EngineFuel = { sfc: [[1, 0]], idle: 0, induction: 'none', iceRisk: 0, oilPressure: false, twoStroke: false, oilNormal: 0, source: 'ficción' }

/** Consumo del motor (el impulsor de ficción del Sigilo no gasta). */
export function engineFuel(eng: EngineSpec): EngineFuel {
  return ENGINE_FUEL[eng.id] ?? NO_FUEL
}

/** Litros por kWh a la fracción `load` de la potencia máxima. */
export function sfcAt(f: EngineFuel, load: number): number {
  const p = f.sfc
  if (load <= p[0][0]) return p[0][1]
  for (let i = 1; i < p.length; i++) {
    if (load <= p[i][0]) {
      const [x0, y0] = p[i - 1]
      const [x1, y1] = p[i]
      return y0 + ((y1 - y0) * (load - x0)) / (x1 - x0)
    }
  }
  return p[p.length - 1][1]
}

/** Caudal (l/h) del motor dando `powerW` en el eje a `rpm`. */
export function fuelFlowLph(eng: EngineSpec, f: EngineFuel, powerW: number, rpm: number): number {
  if (f.induction === 'none') return 0
  const kw = Math.max(0, powerW) / 1000
  const load = Math.max(0, powerW) / eng.maxPower
  const idle = f.idle * Math.max(0, rpm / eng.idleRpm)
  return Math.max(idle, kw * sfcAt(f, load))
}

/** Caudal al 75 % de la potencia máxima continua (aquí, el 70 % de la máxima): referencia de crucero. */
export function cruiseFlowLph(eng: EngineSpec): number {
  const f = engineFuel(eng)
  return fuelFlowLph(eng, f, 0.7 * eng.maxPower, eng.cruiseRpm)
}

/** Litros utilizables con los que se enciende el aviso de reserva: unos 20 min de crucero. */
export function reserveLitres(af: Airframe): number {
  const fs = fuelSpec(af)
  const usable = fs.capacity - fs.unusable
  return Math.max(1.5, Math.min(usable * 0.3, Math.round(cruiseFlowLph(af.engine) / 3)))
}
