// Geometría de cada aparato para el modelo de vuelo.
//
// Coordenadas respecto al origen del modelo 3D (x adelante, y arriba, z derecha),
// las mismas que usa el GLB. Medidas con `node tools/model-geom.mjs <glb>`; si se
// redibuja un modelo, hay que volver a medir y actualizar aquí.
//
// Todos comparten buje, centro de gravedad y perfil y paso de pala. Cambia el diámetro
// y la cuerda del rotor, dónde apoyan las ruedas,
// dónde está la hélice, hasta dónde llega la cola y el tamaño y brazo de sus
// superficies (rodadura, rotación en el despegue, golpes de cola y estabilidad), y
// también el peso en vacío, la resistencia de la célula y el motor (prestaciones).

import { Vector3 } from 'three'
import { GENET_MAJOR, ROTAX_912ULS, ROTAX_914UL, type EngineSpec } from './engines.ts'
import { DEFAULT_ROTOR, type RotorParams } from './rotor.ts'
import type { WreckZones } from './wreck/parts.ts'

/** masa del piloto y del pasajero, equipados (kg) */
export const PILOT_MASS = 85
export const PASSENGER_MASS = 83

export interface CrashPoint {
  /** nombre de la pieza (se muestra en el parte de accidente) */
  name: string
  p: Vector3
}

export interface Airframe {
  id: string
  hub: Vector3
  headPivot: Vector3
  prop: Vector3
  propRadius: number
  /** centro de gravedad */
  cg: Vector3
  /**
   * Puntos de contacto de las ruedas con el suelo (en los triciclo, y = −1.05). Un
   * aparato lleva rueda de morro (triciclo) o rueda de cola (el Cierva C.30A).
   */
  noseWheel?: Vector3
  tailWheel?: Vector3
  mainL: Vector3
  mainR: Vector3
  /** punto más bajo de la cola (patín; en los de rueda de cola, lo que toca si se aplasta) */
  tail: Vector3
  /** centro aerodinámico (25 % de la cuerda media) y superficie en planta del estabilizador */
  stab: Vector3
  stabArea: number
  /**
   * Pendiente de sustentación (1/rad) y coeficiente de fuerza normal con el aire de
   * frente a la placa (90°). Dependen del alargamiento y de las placas o derivas de
   * punta, que hacen rendir más a un estabilizador pequeño: ver `stabCoeffs`.
   */
  stabSlope: number
  stabCd90: number
  /** centro aerodinámico y superficie vertical total (derivas + timón) */
  fin: Vector3
  finArea: number
  /**
   * Recorrido de la cabeza del rotor en cabeceo (grados hacia atrás respecto al
   * fuselaje): con la palanca centrada, y cuánto se suma a fondo atrás / se resta
   * a fondo adelante. Es el reglaje de cada aparato y depende de su cola:
   * · `base` fija la velocidad con la palanca centrada (~105 km/h);
   * · `base + aft` es el tope trasero: debe dar descenso casi vertical SIN irse de
   *   cola. Cuanto menos frena la cola el aire que viene de abajo (superficie ×
   *   brazo), más bajo tiene que estar ese tope.
   */
  head: { base: number; aft: number; fwd: number }
  /** masa en vacío (kg, con aceite y refrigerante) y combustible que lleva a bordo (kg) */
  emptyMass: number
  fuelMass: number
  /** masa máxima al despegue (kg) */
  mtow: number
  /**
   * Resistencia de la célula (góndola, pilotos, mástil, cabeza y tren): superficie
   * equivalente de placa plana (m²). El rotor y la cola se calculan aparte.
   */
  cdA: number
  engine: EngineSpec
  /**
   * Rotor: radio, cuerda e inercia de cada aparato; perfil, paso de pala y topes son
   * los de `DEFAULT_ROTOR`. Las vueltas en vuelo salen solas del peso y de la
   * superficie de pala: con más cuerda gira más despacio.
   */
  rotor: RotorParams
  /**
   * Paso de la hélice respecto a la del genérico (1). Con más paso absorbe más par
   * a las mismas vueltas (∝ paso²), da más empuje (∝ paso) y deja de empujar a un
   * avance mayor: es como se ajusta en tierra una hélice de paso regulable para que
   * un motor más potente o un aparato más rápido no se pasen de vueltas.
   */
  propPitch: number
  /** puntos de la célula que no deben tocar el suelo */
  crashPoints: CrashPoint[]

  // ---- Lo que sigue es opcional: sin ello vale lo de los autogiros actuales (genérico y ELA) ----
  /**
   * Hélice con curvas propias en vez de las de la tripala de los Rotax escaladas por
   * `propPitch`: coeficientes de empuje y de potencia a punto fijo (CT0 = T/ρn²D⁴,
   * CP0 = P/ρn³D⁵) y avances J = V/nD de empuje nulo y de potencia absorbida nula.
   */
  propCoef?: PropCoef
  /** palas de la hélice (3) y sentido de giro visto desde atrás (1 horario, −1 antihorario) */
  propBlades?: number
  propSpin?: 1 | -1
  /**
   * Prerrotador: régimen mínimo del motor para embragarlo, vueltas de rotor por vuelta
   * del motor, tope de vueltas del rotor y par máximo en el eje del rotor (N·m).
   */
  prerotator?: Prerotator
  /**
   * Escala de las vueltas del rotor respecto a las de los autogiros actuales (8,4 m,
   * ~350 rpm en crucero): avisos de bajas vueltas, cuentarrevoluciones, desenfoque de
   * las palas. Un rotor grande y lento (el del Cierva) gira a ~0,6 de esas vueltas.
   */
  rpmScale?: number
  /** momentos de inercia (alabeo, guiñada, cabeceo; kg·m²) para 400 kg; escalan con la masa */
  inertia?: [number, number, number]
  /**
   * Fuselaje: superficie equivalente frente al aire que viene de abajo y de lado (m²)
   * y dónde actúan esas fuerzas respecto al CG (m, ejes cuerpo).
   */
  body?: { vertCdA: number; vertCP: Vector3; sideCdA: number; sideCP: Vector3 }
  /** rueda de cola: grados de giro con los pedales a fondo (0 = loca) */
  tailWheelSteer?: number
  /** rigidez y amortiguación del tren respecto a las de los autogiros actuales (~480 kg) */
  gearScale?: number
  /** radio de las ruedas principales (para que giren a la velocidad del suelo) */
  wheelRadius?: number
  /**
   * La palanca cuelga de la cabeza del rotor y se mueve con ella (mando directo del
   * Cierva) en vez de salir del suelo de la cabina.
   */
  hangingStick?: boolean
  /** zonas del modelo 3D para el despiece de los accidentes (si no, las del genérico) */
  wreck?: WreckZones
  /** false: sin timón (el Cierva C.30A): los pedales solo mueven la rueda de cola */
  rudder?: boolean
  /**
   * Rozamiento que añaden los frenos a fondo (sobre 0.025 de rodadura). Por defecto 0.725, el de
   * los discos hidráulicos actuales en asfalto seco; el Cierva lleva frenos de tambor de los años
   * 30, más flojos (con los de ahora, frenar a fondo justo al tomar a 80 km/h lo pondría de morro).
   */
  brakeMu?: number
  /**
   * Alabeo por el par de la hélice (1 = el de los Rotax: a la izquierda con potencia) y guiñada
   * por el remolino del soplado sobre la deriva (1 = la de los Rotax). El Cierva lleva una hélice
   * que gira al revés y un estabilizador con curvatura contraria en cada lado que compensa casi
   * todo el par: queda un poco de alabeo a la derecha con potencia.
   */
  torqueRoll?: number
  swirlYaw?: number
  /**
   * Inclinación lateral fija de la cabeza (°, + a la derecha) con la palanca centrada. En los
   * actuales, 0,35° para el par motor; el Cierva la ajustaba en vuelo con muelles de compensación.
   */
  rollTrim?: number
}

export interface PropCoef {
  ct0: number
  cp0: number
  j0: number
  j1: number
}

export interface Prerotator {
  minEngineRpm: number
  ratio: number
  maxRpm: number
  torque: number
}

/** Curvas de la hélice del aparato (las del Rotax escaladas por `propPitch` si no tiene propias). */
export function propCoeffs(af: Airframe): PropCoef {
  if (af.propCoef) return af.propCoef
  const kp = af.propPitch
  return { ct0: 0.146 * kp, cp0: 0.0823 * kp * kp, j0: 0.9 * kp, j1: 1.0 * kp }
}

/** Prerrotador de los autogiros actuales: hasta 320 rpm de rotor a 0,075 de las vueltas del motor. */
export const DEFAULT_PREROTATOR: Prerotator = { minEngineRpm: 1700, ratio: 0.075, maxRpm: 320, torque: 420 }

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)

/**
 * Coeficientes de un estabilizador de envergadura `span`, superficie `area` y
 * placas o derivas de punta de altura `endplate` (m). Las placas aumentan el
 * alargamiento efectivo (≈ ×(1 + 1,9·h/b)); con él salen la pendiente de
 * sustentación (ala de alargamiento finito) y la fuerza normal a 90°, que va de
 * ~1,2 en una placa corta a ~2 en una muy alargada.
 */
export function stabCoeffs(span: number, area: number, endplate: number): { stabSlope: number; stabCd90: number } {
  const ar = ((span * span) / area) * (1 + (1.9 * endplate) / span)
  return { stabSlope: (2 * Math.PI * ar) / (ar + 2), stabCd90: 1.98 - 1.47 / ar }
}
const HUB = v(-0.25, 1.7)
const HEAD_PIVOT = v(-0.27, 1.47)
const CG_COMMON = v(0.08, 0.1)
const GROUND = -1.05

/** Tándem abierto genérico (tipo MTOsport): cola larga con deriva central. */
export const GENERIC: Airframe = {
  id: 'generic',
  hub: HUB.clone(),
  headPivot: HEAD_PIVOT.clone(),
  prop: v(-1.5, 0.25),
  propRadius: 0.86,
  cg: CG_COMMON.clone(),
  noseWheel: v(1.6, GROUND),
  // (el apoyo se adelanta 13 cm respecto al dibujo de la rueda)
  mainL: v(-0.27, GROUND, -0.95),
  mainR: v(-0.27, GROUND, 0.95),
  tail: v(-3.75, -0.5),
  // estabilizador recto de 1.55 × 0.45 m con placas de punta de 0.31 m
  stab: v(-3.42, -0.4),
  stabArea: 0.7,
  ...stabCoeffs(1.55, 0.7, 0.31),
  fin: v(-3.5, 0.0),
  finArea: 0.82,
  head: { base: 7.2, aft: 8.8, fwd: 8.2 },
  // 260 kg en vacío + 68 l de gasolina; con piloto 395 kg y con pasajero 478 kg
  emptyMass: 260,
  fuelMass: 50,
  mtow: 500,
  cdA: 0.6,
  engine: ROTAX_912ULS,
  // 8,40 m de diámetro y 20 cm de cuerda
  rotor: DEFAULT_ROTOR,
  propPitch: 1,
  crashPoints: [
    { name: 'morro', p: v(2.05, -0.45) },
    { name: 'panza', p: v(0.4, -0.78) },
    { name: 'costado izquierdo', p: v(0.3, -0.1, -0.45) },
    { name: 'costado derecho', p: v(0.3, -0.1, 0.45) },
    { name: 'carenado izquierdo', p: v(-0.4, -0.75, -1.1) },
    { name: 'carenado derecho', p: v(-0.4, -0.75, 1.1) },
    { name: 'mástil', p: v(-0.3, 1.5) },
    { name: 'estabilizador', p: v(-3.45, -0.4, -0.78) },
    { name: 'estabilizador', p: v(-3.45, -0.4, 0.78) },
    { name: 'deriva', p: v(-3.7, 0.45) },
  ],
}

/**
 * ELA 07 Cougar: tren principal más atrasado, rueda de morro más cerca, hélice
 * más pegada al mástil y cola corta: deriva central con timón, estabilizador en flecha a su pie
 * y dos derivas pequeñas en sus puntas.
 */
export const ELA07: Airframe = {
  id: 'ela07',
  hub: HUB.clone(),
  headPivot: HEAD_PIVOT.clone(),
  prop: v(-1.24, 0.25),
  propRadius: 0.86,
  cg: CG_COMMON.clone(),
  noseWheel: v(1.3, GROUND),
  mainL: v(-0.62, GROUND, -0.95),
  mainR: v(-0.62, GROUND, 0.95),
  // patín bajo la raíz del estabilizador
  tail: v(-2.65, -0.58),
  // Estabilizador dibujado: en flecha, raíz x −1.82…−2.70 (0.88 m), puntas x −2.55…−2.80 (0.25 m)
  // caídas a y −0.56, envergadura 1.56 m → centro aerodinámico ≈ (−2.30, −0.52), 0.88 m².
  stab: v(-2.3, -0.52),
  stabArea: 0.88,
  // derivas de punta de 0.56 m de alto
  ...stabCoeffs(1.56, 0.88, 0.56),
  // Cola con un 15 % menos de "volumen" (superficie × pendiente × brazo) que la del genérico:
  // compensa menos el morro abajo que da la hélice y frena menos el aire que viene de abajo.
  // Con la palanca centrada la cabeza queda como en el genérico (lo que deja de compensar la
  // cola lo compensan sus 30 kg menos y su rotor), pero el tope trasero baja a 15,2° (16° en el
  // genérico): con 16°, a fondo atrás y sin motor el aparato se iría de cola.
  head: { base: 7.2, aft: 8.0, fwd: 8.2 },
  // deriva central en el eje (en el soplado de la hélice) + timón: x −2.15…−2.86, y −0.48…0.42, 0.56 m²;
  // más dos derivas pequeñas en las puntas del estabilizador: x −2.49…−2.86, y −0.61…−0.05, 0.14 m² cada una
  fin: v(-2.47, -0.12),
  finArea: 0.84,
  // 250 kg en vacío y 450 kg de máximo: con dos a bordo solo caben 42 de los 75 l del depósito
  emptyMass: 250,
  fuelMass: 30,
  mtow: 450,
  cdA: 0.6,
  engine: ROTAX_914UL,
  // 8,23 m de diámetro y 22 cm de cuerda: palas más cortas y más anchas (y más pesadas)
  rotor: { ...DEFAULT_ROTOR, radius: 4.115, chord: 0.22, inertia: 179 },
  propPitch: 1.05,
  crashPoints: [
    { name: 'morro', p: v(2.18, -0.46) },
    { name: 'panza', p: v(0.6, -0.76) },
    { name: 'costado izquierdo', p: v(0.5, -0.15, -0.4) },
    { name: 'costado derecho', p: v(0.5, -0.15, 0.4) },
    { name: 'carenado izquierdo', p: v(-0.62, -0.75, -1.05) },
    { name: 'carenado derecho', p: v(-0.62, -0.75, 1.05) },
    { name: 'mástil', p: v(-0.3, 1.5) },
    { name: 'estabilizador', p: v(-2.65, -0.56, -0.78) },
    { name: 'estabilizador', p: v(-2.65, -0.56, 0.78) },
    { name: 'deriva', p: v(-2.25, 0.42) },
    { name: 'deriva lateral', p: v(-2.77, -0.05, -0.815) },
    { name: 'deriva lateral', p: v(-2.77, -0.05, 0.815) },
  ],
}

/**
 * ELA 10 Eclipse: cabina cerrada, rueda de morro muy adelantada y cola corta con
 * estabilizador alto, dos derivas en las puntas y deriva ventral con el timón.
 */
export const ELA10: Airframe = {
  id: 'ela10',
  hub: HUB.clone(),
  headPivot: HEAD_PIVOT.clone(),
  prop: v(-1.25, 0.25),
  propRadius: 0.86,
  cg: CG_COMMON.clone(),
  noseWheel: v(1.83, GROUND),
  mainL: v(-0.4, GROUND, -0.95),
  mainR: v(-0.4, GROUND, 0.95),
  tail: v(-2.95, -0.61),
  // estabilizador recto de 1.65 × 0.45 m (x −2.83…−2.42) a la altura del eje de la hélice,
  // con derivas de punta de 0.72 m de alto
  stab: v(-2.53, -0.18),
  stabArea: 0.74,
  ...stabCoeffs(1.65, 0.74, 0.72),
  // dos derivas en las puntas (0.72 m de alto) + deriva ventral con timón
  fin: v(-2.68, 0.08),
  finArea: 1.15,
  // tope trasero en 15,0°: con los 16° del genérico se iría de cola a fondo atrás sin motor
  head: { base: 7.2, aft: 7.8, fwd: 8.2 },
  // 275 kg en vacío y 530 kg de máximo; 70 de los 100 l del depósito
  emptyMass: 275,
  fuelMass: 50,
  mtow: 530,
  // cabina cerrada y carenada
  cdA: 0.4,
  engine: ROTAX_914UL,
  // 8,50 m de diámetro y 22 cm de cuerda
  rotor: { ...DEFAULT_ROTOR, radius: 4.25, chord: 0.22, inertia: 197 },
  propPitch: 1.1,
  crashPoints: [
    { name: 'morro', p: v(2.15, -0.6) },
    { name: 'panza', p: v(0.9, -0.75) },
    { name: 'costado izquierdo', p: v(0.25, -0.3, -0.46) },
    { name: 'costado derecho', p: v(0.25, -0.3, 0.46) },
    { name: 'carenado izquierdo', p: v(-0.4, -0.75, -1.08) },
    { name: 'carenado derecho', p: v(-0.4, -0.75, 1.08) },
    { name: 'mástil', p: v(-0.3, 1.5) },
    { name: 'estabilizador', p: v(-2.56, -0.18, -0.82) },
    { name: 'estabilizador', p: v(-2.56, -0.18, 0.82) },
    { name: 'deriva', p: v(-2.66, 0.54, -0.82) },
    { name: 'deriva', p: v(-2.66, 0.54, 0.82) },
  ],
}

/**
 * Cierva C.30A (Avro 671 Rota, 1934): el autogiro de Juan de la Cierva más fabricado. Hélice
 * tractora delante, rueda de cola, rotor tripala articulado de 11,28 m y mando directo (la
 * palanca cuelga de la cabeza y la inclina); sin alas, timón ni timón de profundidad.
 * Geometría calcada del plano de la NACA (Aircraft Circular 196, 1934); CG, pesos, rotor,
 * hélice, resistencia y prestaciones de los ensayos de la RAE (ARC R&M 1859 y 1727).
 */
export const CIERVA_C30: Airframe = {
  id: 'cierva',
  // buje 1,76 m por encima del CG y 0,13 m por detrás (R&M 1859)
  hub: v(-0.03, 1.82),
  headPivot: v(-0.03, 1.62),
  // Fairey Reed bipala metálica de 7 ft (2,13 m), paso 4,33 ft
  prop: v(1.63, 0.02),
  propRadius: 1.065,
  cg: CG_COMMON.clone(),
  // ruedas de 0,49 m, vía de 9 ft (2,74 m); rueda de cola de 270 × 100 mm, 10° de cola apoyada
  mainL: v(1.05, -1.495, -1.37),
  mainR: v(1.05, -1.495, 1.37),
  tailWheel: v(-3.47, -0.71),
  // si la rueda de cola se aplasta, lo primero que toca es el bulbo de la cola
  tail: v(-3.85, -0.37),
  // estabilizador de 15,6 sq ft (1,45 m²), cuerda 0,75 m, más las aletas levantadas de las
  // puntas (8,55 sq ft a 44°): centro aerodinámico a 3,0 m del CG
  stab: v(-2.95, 0.1),
  stabArea: 1.8,
  ...stabCoeffs(2.24, 1.45, 0.4),
  // deriva superior 12,9 sq ft + ventral 3,38 sq ft + lo que dan de lado las aletas de punta
  fin: v(-2.82, 0.33),
  finArea: 1.9,
  // la cabeza bascula 2,5° adelante y 7,5° atrás respecto a la perpendicular a los largueros
  head: { base: 3.3, aft: 4.2, fwd: 5.8 },
  // 1220 lb en vacío + 3½ gal de aceite; 23 gal de gasolina (76 kg); 1800 lb de máximo
  emptyMass: 567,
  fuelMass: 76,
  mtow: 816,
  // 90 lb a 100 ft/s (R&M 1859): f ≈ 0,70 m², sin el estabilizador
  cdA: 0.65,
  engine: GENET_MAJOR,
  // 3 palas de 0,279 m (solidez 0,047), paso 2,66°, perfil tipo Göttingen 606; madera y tela
  // sobre larguero de acero: 2,94 kg/m → ~530 kg·m²
  rotor: {
    ...DEFAULT_ROTOR,
    radius: 5.64,
    chord: 0.279,
    blades: 3,
    pitch: 0.0465,
    precone: 4 * (Math.PI / 180),
    inertia: 530,
    rootCutout: 0.55,
    liftSlope: 5.72,
    cd0: 0.0105,
    cd2: 0.3,
  },
  propPitch: 1,
  propCoef: { ct0: 0.097, cp0: 0.0464, j0: 0.73, j1: 0.8 },
  propBlades: 2,
  propSpin: -1,
  // embrague y engranaje cónico desde el motor: ~185 rpm de rotor antes de soltar
  prerotator: { minEngineRpm: 900, ratio: 0.17, maxRpm: 195, torque: 1500 },
  rpmScale: 0.64,
  inertia: [440, 715, 860],
  body: { vertCdA: 3.5, vertCP: v(-1.0, -0.1), sideCdA: 4.0, sideCP: v(-0.6, 0.15) },
  tailWheelSteer: 25,
  gearScale: 1.5,
  wheelRadius: 0.245,
  hangingStick: true,
  rudder: false,
  brakeMu: 0.55,
  torqueRoll: -0.3,
  swirlYaw: -1,
  rollTrim: -0.2,
  wreck: {
    tailCutX: -2.55,
    gear: { x0: -0.1, x1: 1.45, yMax: -0.38, zMin: 0.44, attach: v(0.99, -0.44, -0.4) },
    mast: { x0: -0.6, x1: 0.45, yMin: 0.6, zMax: 0.45, attach: v(0.0, 0.5) },
    podSlabs: [-2.55, -1.8, -1.1, -0.45, 0.2, 0.9, 1.15, 9],
    tailWheel: v(-3.47, -0.575),
  },
  crashPoints: [
    { name: 'motor', p: v(1.4, -0.44) },
    { name: 'motor', p: v(1.4, 0.47) },
    { name: 'panza', p: v(0.5, -0.47) },
    { name: 'panza', p: v(-1.2, -0.44) },
    { name: 'costado izquierdo', p: v(0.2, 0.05, -0.42) },
    { name: 'costado derecho', p: v(0.2, 0.05, 0.42) },
    { name: 'pata izquierda', p: v(0.99, -0.44, -1.14) },
    { name: 'pata derecha', p: v(0.99, -0.44, 1.14) },
    { name: 'pilón', p: v(0.3, 1.5) },
    { name: 'estabilizador', p: v(-3.02, 0.49, -1.53) },
    { name: 'estabilizador', p: v(-3.02, 0.49, 1.53) },
    { name: 'estabilizador', p: v(-3.1, 0.1, -1.12) },
    { name: 'estabilizador', p: v(-3.1, 0.1, 1.12) },
    { name: 'deriva', p: v(-2.3, 0.73) },
    { name: 'deriva', p: v(-4.25, 0.04) },
    { name: 'deriva ventral', p: v(-2.6, -0.61) },
  ],
}

export const AIRFRAMES: Record<string, Airframe> = { generic: GENERIC, ela07: ELA07, ela10: ELA10, cierva: CIERVA_C30 }

/** Geometría de vuelo del aparato del catálogo (la genérica si no tiene una propia). */
export function airframeById(id: string): Airframe {
  return AIRFRAMES[id] ?? GENERIC
}
