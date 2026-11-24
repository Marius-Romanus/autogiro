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
import { GENET_MAJOR, LYCOMING_IO540, ROTAX_503, ROTAX_912ULS, ROTAX_914UL, type EngineSpec } from './engines.ts'
import { DEFAULT_ROTOR, type RotorParams } from './rotor.ts'
import type { WreckZones } from './wreck/parts.ts'
import type { CspPropSpec, SlowedRotorSpec, WingSpec } from './compound.ts'

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
  /** lo mismo para la rueda de morro (1 si falta) */
  noseGearScale?: number
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
  /** plazas (2 si falta): un monoplaza no admite pasajero */
  seats?: number
  /**
   * Asientos lado a lado: posición lateral del piloto y del acompañante (m, + a la derecha). El
   * peso de cada uno desplaza el centro de gravedad hacia su lado: volando solo, el aparato
   * cuelga algo ladeado y pide palanca (o compensador) al lado contrario.
   */
  seatZ?: { pilot: number; passenger: number }
  /** incidencia del estabilizador respecto al fuselaje (°, + borde de ataque arriba); −1,5 si falta */
  stabIncidence?: number

  // ---- Autogiro compuesto de rotor frenado (Carter PAV): `compound.ts` ----
  /** ala con alerones (fuerzas en el centro aerodinámico de cada franja) */
  wing?: WingSpec
  /**
   * Timón de profundidad: grados de incidencia del estabilizador por unidad de palanca de cabeceo
   * (palanca atrás → borde de salida arriba). La palanca sigue inclinando la cabeza del rotor.
   */
  elevator?: number
  /** hélice de paso variable con regulador (en vez de la de paso fijo de `propCoeffs`) */
  cspProp?: CspPropSpec
  /**
   * Rotor frenado: ley de vueltas con el mástil basculante (la cabeza bascula sobre `headPivot`, el
   * pie del mástil, y la palanca inclina además el plano de la cabeza sobre el buje), colectivo
   * automático y salto. Avisos y accidente de bajas vueltas referidos a la ley de vueltas.
   */
  slowedRotor?: SlowedRotorSpec
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
 * ELA 07 Cougar: tándem abierto con el Rotax a la vista, ruedas anchas sin carenar sobre patas
 * largas y cola corta sobre una viga: deriva central con timón y estabilizador en flecha con las
 * puntas dobladas hacia arriba. Calcado sobre fotos de fábrica (blender/build_ela07.py).
 */
export const ELA07: Airframe = {
  id: 'ela07',
  wreck: wreckZones(-1.62, -0.563, -0.994, 0.375, -0.25, 0.65, -1.244),
  hub: v(-0.25, 1.819),
  headPivot: v(-0.25, 1.613),
  // Helix tripala de 1,72 m
  prop: v(-1.244, 0.363),
  propRadius: 0.86,
  cg: CG_COMMON.clone(),
  noseWheel: v(1.32, -0.994),
  mainL: v(-0.563, -0.994, -0.78),
  mainR: v(-0.563, -0.994, 0.78),
  // ruedecilla de cola
  tail: v(-2.35, -0.557),
  // estabilizador en flecha de 1,56 m (1,11 m²) con las puntas dobladas 0,52 m hacia arriba
  stab: v(-2.058, -0.351),
  stabArea: 1.11,
  ...stabCoeffs(1.56, 1.11, 0.525),
  // tope trasero en 14,1°: a fondo atrás y sin motor baja casi en vertical avanzando unos 7 km/h;
  // palanca centrada algo más adelantada que en el genérico: la hélice va 0,26 m por encima del CG
  // y al cortar motor el morro sube (con 7,2° el planeo con manos fuera se quedaba en 79 km/h)
  head: { base: 6.9, aft: 7.2, fwd: 8.2 },
  // deriva (0,24 m²) + timón (0,27 m²) + las dos puntas dobladas (0,21 m² cada una)
  fin: v(-2.33, 0.01),
  finArea: 0.92,
  // 250 kg en vacío y 450 kg de máximo: con dos a bordo solo caben 42 de los 75 l del depósito
  emptyMass: 250,
  fuelMass: 30,
  mtow: 450,
  cdA: 0.6,
  engine: ROTAX_914UL,
  // 8,23 m de diámetro y 22 cm de cuerda: palas más cortas y más anchas (y más pesadas)
  rotor: { ...DEFAULT_ROTOR, radius: 4.115, chord: 0.22, inertia: 179 },
  propPitch: 1.05,
  // ruedas anchas de 0,49 m
  wheelRadius: 0.244,
  crashPoints: [
    { name: 'morro', p: v(2.294, -0.337) },
    { name: 'panza', p: v(1.35, -0.723) },
    { name: 'panza', p: v(1.05, -0.586) },
    { name: 'panza', p: v(-1.307, -0.731) },
    { name: 'costado izquierdo', p: v(0.43, -0.346, -0.375) },
    { name: 'costado derecho', p: v(0.43, -0.346, 0.375) },
    { name: 'pata izquierda', p: v(-0.563, -0.75, -0.875) },
    { name: 'pata derecha', p: v(-0.563, -0.75, 0.875) },
    { name: 'mástil', p: v(-0.25, 1.65) },
    { name: 'estabilizador', p: v(-2.35, -0.38, -0.78) },
    { name: 'estabilizador', p: v(-2.35, -0.38, 0.78) },
    { name: 'deriva lateral', p: v(-2.3, 0.174, -0.905) },
    { name: 'deriva lateral', p: v(-2.3, 0.174, 0.905) },
    { name: 'deriva', p: v(-2.2, 0.529) },
    { name: 'deriva', p: v(-2.76, -0.171) },
  ],
}

/**
 * ELA 10 Eclipse: cabina cerrada en tándem con cúpula de una pieza, pilón en aleta de tiburón que
 * sale del capó, viga de cola en cuello de cisne y cola alta: deriva en cajón con el timón, y encima
 * el estabilizador con aletas de punta hacia arriba y hacia abajo. Calcado sobre fotos de Wikimedia
 * Commons y de fábrica (blender/build_ela10.py).
 */
export const ELA10: Airframe = {
  id: 'ela10',
  wreck: wreckZones(-1.65, -0.467, -0.925, 0.42, -0.25, 0.6, -1.28),
  hub: v(-0.25, 1.835),
  headPivot: v(-0.266, 1.645),
  // Helix H50F tripala de 1,73 m con cono
  prop: v(-1.28, 0.215),
  propRadius: 0.865,
  cg: CG_COMMON.clone(),
  noseWheel: v(1.711, -0.925),
  mainL: v(-0.467, -0.925, -0.8),
  mainR: v(-0.467, -0.925, 0.8),
  // ruedecilla de cola bajo la deriva
  tail: v(-2.238, -0.639),
  // estabilizador en flecha de 1,60 m (1,05 m²) con 12° de diedro negativo sobre la deriva, y aletas
  // de punta de 0,36 m hacia arriba y 0,38 m hacia abajo
  stab: v(-2.345, 0.213),
  stabArea: 1.048,
  ...stabCoeffs(1.6, 1.048, 0.74),
  // deriva en cajón (0,42 m²) + timón (0,30 m²) + las dos aletas de punta (0,23 m² cada una)
  fin: v(-2.491, -0.067),
  finArea: 1.17,
  // tope trasero en 14,0°: a fondo atrás y sin motor baja casi en vertical avanzando unos 8 km/h
  // (con los 16° del genérico se iría de cola). Palanca centrada en 6,0°: con el buje a 1,74 m del
  // CG la resistencia del rotor encabrita más, y con los 7,2° del genérico volaba a 95 km/h
  head: { base: 6.0, aft: 8.0, fwd: 8.2 },
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
  wheelRadius: 0.175,
  crashPoints: [
    { name: 'morro', p: v(2.006, -0.502) },
    { name: 'morro', p: v(1.907, -0.604) },
    { name: 'panza', p: v(1.05, -0.634) },
    { name: 'panza', p: v(-1.724, -0.695) },
    { name: 'costado izquierdo', p: v(0.6, -0.455, -0.471) },
    { name: 'costado derecho', p: v(0.6, -0.455, 0.471) },
    { name: 'carenado izquierdo', p: v(-0.467, -0.75, -0.89) },
    { name: 'carenado derecho', p: v(-0.467, -0.75, 0.89) },
    { name: 'mástil', p: v(-0.25, 1.67) },
    { name: 'deriva lateral', p: v(-2.824, 0.477, -0.896) },
    { name: 'deriva lateral', p: v(-2.824, 0.477, 0.896) },
    { name: 'deriva lateral', p: v(-2.722, -0.267, -0.8) },
    { name: 'deriva lateral', p: v(-2.722, -0.267, 0.8) },
    { name: 'deriva', p: v(-2.965, -0.391) },
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

/**
 * Zonas de despiece para los accidentes (WreckZones) a partir de unas pocas medidas del aparato:
 * dónde empieza la cola, eje y altura del tren principal, media anchura de la góndola, buje, altura
 * a la que el mástil sale del fuselaje y plano de la hélice.
 */
function wreckZones(
  tailCutX: number,
  mainX: number,
  groundY: number,
  podHalfWidth: number,
  hubX: number,
  mastFootY: number,
  propX: number,
): WreckZones {
  const cuts = [propX - 0.25, propX + 0.15, -0.6, 0.15, 0.85, 1.5].filter((x) => x > tailCutX + 0.1).sort((a, b) => a - b)
  return {
    tailCutX,
    gear: { x0: mainX - 0.6, x1: mainX + 0.6, yMax: groundY + 0.6, zMin: podHalfWidth, attach: v(mainX, groundY + 0.3, -podHalfWidth) },
    mast: { x0: hubX - 0.5, x1: hubX + 0.3, yMin: mastFootY, zMax: 0.2, attach: v(hubX - 0.1, mastFootY, 0) },
    podSlabs: [tailCutX, ...cuts, 9],
  }
}

// ---------------------------------------------------------------------------------------------
// Aparatos calcados sobre fotos y planos de fábrica en el "marco del buje" (blender/gyrokit.py):
// buje, hélice, ruedas y cola van donde están de verdad unos respecto a otros. El origen del modelo
// se coloca para que el CG común (0,08; 0,10) quede 0,33 m por delante del buje, como en el resto
// de aparatos: es la posición con la que está validado el modelo de vuelo (línea de empuje del
// rotor por el CG con el fuselaje nivelado). Con el CG de las hojas de datos de la CAA, casi en la
// vertical del buje, el modelo vuela muy encabritado y sin motor se va de cola.
// ---------------------------------------------------------------------------------------------

/**
 * AutoGyro MT-03 (2004-2010): tándem abierto con Rotax 912 ULS a la vista, quilla que baja bajo la
 * hélice y sube a una cola en U (estabilizador con dos derivas cortas en las puntas) con deriva
 * central alta y timón grande. Calcado sobre fotos de Wikimedia Commons (blender/build_mt03.py).
 * Ruedas, hélice y cola están donde en el aparato real respecto al buje (las principales, 0,54 m
 * por detrás de él); el CG lleva el criterio común del simulador (buje 0,33 m por detrás del CG) y
 * la altura de la hoja de datos BG01 de la CAA británica (0,885 m sobre el eje de las ruedas).
 */
export const MT03: Airframe = {
  id: 'mt03',
  wreck: wreckZones(-2.05, -0.79, -0.972, 0.45, -0.25, 0.55, -1.43),
  hub: v(-0.25, 1.734),
  headPivot: v(-0.25, 1.519),
  // HTC tripala de 1,72 m, sin cono
  prop: v(-1.43, 0.287),
  propRadius: 0.86,
  cg: CG_COMMON.clone(),
  noseWheel: v(1.29, -0.972),
  mainL: v(-0.79, -0.972, -0.83),
  mainR: v(-0.79, -0.972, 0.83),
  // borde de salida del estabilizador, sobre el final de la quilla
  tail: v(-2.57, -0.41),
  // estabilizador de 1,66 m: cuerda 0,53 m en el centro y 0,36 m en las puntas, con derivas de punta
  // de 0,60 m de alto
  stab: v(-2.23, -0.384),
  stabArea: 0.74,
  ...stabCoeffs(1.66, 0.74, 0.6),
  // deriva central + timón (0,67 m²) y las dos derivas de punta (0,18 m² cada una)
  fin: v(-2.42, 0.0),
  finArea: 1.02,
  // tope trasero en 14,5°: a fondo atrás y sin motor baja casi en vertical avanzando unos 5 km/h
  head: { base: 7.2, aft: 7.3, fwd: 8.2 },
  // 250 kg en vacío con el 912; un depósito de 35 l; 450 kg de máximo
  emptyMass: 250,
  fuelMass: 25,
  mtow: 450,
  cdA: 0.6,
  engine: ROTAX_912ULS,
  // 8,40 m de diámetro y 20 cm de cuerda (NACA 8H12)
  rotor: DEFAULT_ROTOR,
  propPitch: 1,
  crashPoints: [
    { name: 'morro', p: v(2.07, -0.478) },
    { name: 'panza', p: v(0.52, -0.675) },
    { name: 'costado izquierdo', p: v(0.32, -0.03, -0.4) },
    { name: 'costado derecho', p: v(0.32, -0.03, 0.4) },
    { name: 'carenado izquierdo', p: v(-0.79, -0.72, -0.95) },
    { name: 'carenado derecho', p: v(-0.79, -0.72, 0.95) },
    { name: 'mástil', p: v(-0.26, 1.55) },
    { name: 'estabilizador', p: v(-2.38, -0.384, -0.83) },
    { name: 'estabilizador', p: v(-2.38, -0.384, 0.83) },
    { name: 'deriva lateral', p: v(-2.34, 0.18, -0.865) },
    { name: 'deriva lateral', p: v(-2.34, 0.18, 0.865) },
    { name: 'deriva', p: v(-2.33, 0.512) },
    { name: 'deriva', p: v(-3.02, -0.14) },
  ],
}

/**
 * AutoGyro Cavalon (2011): cabina cerrada con los dos asientos lado a lado, mástil carenado que nace
 * del techo, Rotax 914 carenado con agallas y cola de AutoGyro (estabilizador con dos derivas de
 * punta y deriva central con el timón). Calcado sobre el plano de tres vistas del manual de vuelo
 * (4,73 × 1,77 × 2,77 m) y fotos de Wikimedia Commons (blender/build_cavalon.py). El piloto al mando
 * va a la DERECHA (manual de vuelo): volando solo, su peso lleva el CG 5-6 cm a su lado (la hoja
 * BG06 de la CAA admite de −24 a +70 mm) y el compensador de alabeo lo corrige: el fuselaje vuela
 * un par de grados caído a la derecha.
 */
export const CAVALON: Airframe = {
  id: 'cavalon',
  wreck: wreckZones(-1.75, -0.69, -0.945, 0.66, -0.25, 0.85, -1.27),
  hub: v(-0.25, 1.76),
  headPivot: v(-0.255, 1.55),
  // HTC tripala de 1,72 m con cono
  prop: v(-1.27, 0.405),
  propRadius: 0.86,
  cg: CG_COMMON.clone(),
  noseWheel: v(1.321, -0.945),
  mainL: v(-0.69, -0.945, -0.775),
  mainR: v(-0.69, -0.945, 0.775),
  // final de la quilla, bajo el estabilizador
  tail: v(-2.63, -0.405),
  // estabilizador de 1,60 m en flecha (0,724 m²) con derivas de punta de 0,59 m
  stab: v(-2.318, -0.362),
  stabArea: 0.724,
  ...stabCoeffs(1.6, 0.724, 0.59),
  // deriva central + timón (0,52 m²) y dos derivas de punta (0,19 m² cada una)
  fin: v(-2.541, -0.034),
  finArea: 0.912,
  // La cabina ancha frena mucho el aire que viene de abajo por delante del CG: el tope trasero se
  // queda en 14,2° (con más, a fondo atrás y sin motor cabecea y se va de cola), y con él la mínima
  // nivelada sale algo alta (58 km/h)
  head: { base: 7.9, aft: 6.3, fwd: 8.2 },
  // 290 kg en vacío con el 914; 70 de los 100 l del depósito; 560 kg de máximo
  emptyMass: 290,
  fuelMass: 50,
  mtow: 560,
  // cabina cerrada, ancha (dos plazas lado a lado)
  cdA: 0.55,
  engine: ROTAX_914UL,
  rotor: DEFAULT_ROTOR,
  propPitch: 1.05,
  wheelRadius: 0.205,
  seatZ: { pilot: 0.28, passenger: -0.28 },
  crashPoints: [
    { name: 'morro', p: v(1.681, -0.402) },
    { name: 'panza', p: v(0.56, -0.59) },
    { name: 'panza', p: v(-1.357, -0.698) },
    { name: 'costado izquierdo', p: v(0.36, -0.065, -0.639) },
    { name: 'costado derecho', p: v(0.36, -0.065, 0.639) },
    { name: 'carenado izquierdo', p: v(-0.7, -0.68, -0.9) },
    { name: 'carenado derecho', p: v(-0.7, -0.68, 0.9) },
    { name: 'mástil', p: v(-0.26, 1.58) },
    { name: 'estabilizador', p: v(-2.41, -0.33, -0.82) },
    { name: 'estabilizador', p: v(-2.41, -0.33, 0.82) },
    { name: 'deriva lateral', p: v(-2.47, 0.23, -0.8) },
    { name: 'deriva lateral', p: v(-2.47, 0.23, 0.8) },
    { name: 'deriva', p: v(-2.44, 0.466) },
    { name: 'deriva', p: v(-3.094, -0.058) },
  ],
}

/**
 * ELA 07 Scorpion: el ELA 07 de la línea deportiva actual. Tándem abierto de morro en pico con dos
 * parabrisas (el trasero, sobre la joroba del reposacabezas), Rotax 914 turbo bajo un capó carenado,
 * carenados en lágrima en las ruedas principales y cola alta sobre un tubo: deriva con timón sobre un
 * estabilizador en flecha con las puntas dobladas hacia arriba. Calcado sobre la foto lateral de
 * fábrica (blender/build_scorpion.py); la escala sale de la hélice Helix de 1,72 m. Datos de ELA:
 * 275 kg en vacío, 500 kg de máximo, crucero 150 km/h, VNE 160 km/h, rotor de 8,50 m.
 */
export const SCORPION: Airframe = {
  id: 'scorpion',
  wreck: wreckZones(-1.58, -0.55, -0.925, 0.42, -0.25, 0.6, -1.196),
  hub: v(-0.25, 1.684),
  headPivot: v(-0.238, 1.484),
  // Helix H50 tripala de 1,72 m con cono
  prop: v(-1.196, 0.272),
  propRadius: 0.86,
  cg: CG_COMMON.clone(),
  noseWheel: v(1.37, -0.925),
  mainL: v(-0.55, -0.925, -0.76),
  mainR: v(-0.55, -0.925, 0.76),
  // ruedecilla de cola
  tail: v(-2.32, -0.57),
  // estabilizador en flecha de 1,56 m (0,95 m²) con las puntas dobladas 0,49 m hacia arriba
  stab: v(-2.046, -0.431),
  stabArea: 0.947,
  ...stabCoeffs(1.56, 0.947, 0.49),
  // deriva (0,19 m²) + timón (0,29 m²) + las dos puntas dobladas (0,12 m² cada una)
  fin: v(-2.341, -0.077),
  finArea: 0.723,
  head: { base: 7.2, aft: 7.6, fwd: 8.2 },
  // 275 kg en vacío y 500 kg de máximo; 55 de los 75 l del depósito
  emptyMass: 275,
  fuelMass: 40,
  mtow: 500,
  // abierto, pero con el motor carenado y las ruedas en lágrima
  cdA: 0.55,
  engine: ROTAX_914UL,
  // 8,50 m de diámetro y 22 cm de cuerda, como el Eclipse
  rotor: { ...DEFAULT_ROTOR, radius: 4.25, chord: 0.22, inertia: 197 },
  propPitch: 1.05,
  wheelRadius: 0.175,
  crashPoints: [
    { name: 'morro', p: v(2.022, -0.499) },
    { name: 'panza', p: v(0.75, -0.622) },
    { name: 'panza', p: v(-1.235, -0.716) },
    { name: 'costado izquierdo', p: v(0.55, -0.366, -0.38) },
    { name: 'costado derecho', p: v(0.55, -0.366, 0.38) },
    { name: 'carenado izquierdo', p: v(-0.93, -0.696, -0.76) },
    { name: 'carenado derecho', p: v(-0.93, -0.696, 0.76) },
    { name: 'mástil', p: v(-0.25, 1.52) },
    { name: 'estabilizador', p: v(-2.39, -0.431, -0.78) },
    { name: 'estabilizador', p: v(-2.39, -0.431, 0.78) },
    { name: 'deriva lateral', p: v(-2.45, 0.056, -0.894) },
    { name: 'deriva lateral', p: v(-2.45, 0.056, 0.894) },
    { name: 'deriva', p: v(-2.1, 0.412) },
    { name: 'deriva', p: v(-2.78, -0.266) },
  ],
}

/**
 * AutoGyro Calidus (2009): cabina cerrada en tándem muy afilada, cúpula de una pieza abisagrada a la
 * izquierda, mástil carenado y curvo con toma de aire, Rotax carenado y cola de AutoGyro
 * (estabilizador con dos derivas de punta y deriva central con el timón) sobre una quilla que sale
 * por detrás de la cabina. Calcado sobre una foto lateral de Wikimedia Commons y el plano de tres
 * vistas del manual de vuelo (4,78 × 1,73 × 2,77 m): blender/build_calidus.py. Altura del CG de la
 * hoja BG04 de la CAA (0,845 m sobre el eje de las ruedas principales).
 */
export const CALIDUS: Airframe = {
  id: 'calidus',
  wreck: wreckZones(-1.9, -0.6, -0.95, 0.47, -0.25, 0.7, -1.335),
  hub: v(-0.25, 1.755),
  headPivot: v(-0.25, 1.56),
  // HTC tripala de 1,72 m con cono
  prop: v(-1.335, 0.34),
  propRadius: 0.86,
  cg: CG_COMMON.clone(),
  noseWheel: v(1.495, -0.95),
  mainL: v(-0.6, -0.95, -0.77),
  mainR: v(-0.6, -0.95, 0.77),
  // no lleva patín: lo primero que toca son las derivas de punta y el estabilizador
  tail: v(-2.45, -0.3),
  // estabilizador en flecha de 1,62 m (0,80 m²) con derivas de punta de 0,59 m
  stab: v(-2.227, -0.28),
  stabArea: 0.8,
  ...stabCoeffs(1.62, 0.8, 0.59),
  // deriva central (0,52 m²) + timón (0,25 m²) + dos derivas de punta (0,18 m² cada una)
  fin: v(-2.463, 0.07),
  finArea: 1.116,
  // tope trasero en 14,2°: a fondo atrás y sin motor baja casi en vertical avanzando unos km/h
  head: { base: 7.2, aft: 7.0, fwd: 8.2 },
  // 262 kg en vacío; 55 de los 75 l con el segundo depósito; 500 kg de máximo
  emptyMass: 262,
  fuelMass: 40,
  mtow: 500,
  // cabina cerrada y muy fina
  cdA: 0.4,
  engine: ROTAX_914UL,
  rotor: DEFAULT_ROTOR,
  propPitch: 1.1,
  wheelRadius: 0.205,
  crashPoints: [
    { name: 'morro', p: v(1.83, -0.41) },
    { name: 'panza', p: v(0.01, -0.65) },
    { name: 'panza', p: v(-1.28, -0.66) },
    { name: 'costado izquierdo', p: v(0.07, -0.13, -0.43) },
    { name: 'costado derecho', p: v(0.07, -0.13, 0.43) },
    { name: 'carenado izquierdo', p: v(-0.97, -0.66, -0.77) },
    { name: 'carenado derecho', p: v(-0.97, -0.66, 0.77) },
    { name: 'mástil', p: v(-0.26, 1.58) },
    { name: 'estabilizador', p: v(-2.42, -0.28, -0.81) },
    { name: 'estabilizador', p: v(-2.42, -0.28, 0.81) },
    { name: 'deriva lateral', p: v(-2.45, 0.29, -0.8) },
    { name: 'deriva lateral', p: v(-2.45, 0.29, 0.8) },
    { name: 'deriva', p: v(-2.28, 0.5) },
    { name: 'deriva', p: v(-2.905, -0.12) },
  ],
}

/**
 * Carter PAV (N210AV, 2014): autogiro compuesto de rotor frenado y despegue por salto. Bipala de
 * 13,72 m con 34 kg de plomo en cada punta (~4600 kg·m²) sobre un mástil de 1,37 m que bascula
 * (15° adelante … 30° atrás) sobre su pie; ala baja recta de 13,7 m y 13,9 m² con alerones; cola
 * en un solo larguero con estabilizador y profundidad y tres derivas, timón en la central; Lycoming
 * IO-540 de 300 CV con pentapala propulsora de 2,16 m y regulador; tren triciclo fijo.
 * Datos: Carter y Lewis (ERF 2015), avstop 2009, AOPA 2015, CompositesWorld 2015. Geometría medida
 * en el modelo 3D (suelo en y = −1,26; CG común en 0,08; 0,10).
 * · Buje 0,30 m por detrás del CG y 2,57 m por encima; el pie del mástil, 1,20 m por encima del CG.
 *   La línea del empuje pasa por el CG con el plano de la cabeza unos grados más atrás que el
 *   mástil: eso es `head.base`.
 * · ALA: dibujada, su cuarto de cuerda queda en x ≈ −1,04 (1,1 m por detrás del CG del simulador):
 *   el CG real no se conoce y con la sustentación tan atrás no hay equilibrio posible. Su centro
 *   aerodinámico es aquí un dato de la ficha, unos centímetros por detrás del CG (estable).
 */
export const CARTER_PAV: Airframe = {
  id: 'carterpav',
  wreck: wreckZones(-2.9, -0.57, -1.26, 0.72, -0.22, 1.5, -1.9),
  hub: v(-0.22, 2.67),
  headPivot: v(-0.22, 1.3),
  // pentapala de 2,16 m (medida en tres fotos); su línea de empuje pasa 0,49 m por encima del CG
  prop: v(-1.9, 0.59),
  propRadius: 1.08,
  cg: CG_COMMON.clone(),
  noseWheel: v(1.63, -1.26),
  mainL: v(-0.57, -1.26, -0.95),
  mainR: v(-0.57, -1.26, 0.95),
  // ruedecilla de cola bajo el larguero
  tail: v(-3.46, -0.5),
  // estabilizador de 4,38 × 0,60 m (2,63 m²) con derivas de punta de 0,61 m por arriba y 0,45 por abajo
  stab: v(-3.39, 0.34),
  stabArea: 2.63,
  ...stabCoeffs(4.38, 2.63, 1.06),
  stabIncidence: -2,
  // deriva central con timón (1,50 m²) y las dos de punta (0,91 m² cada una)
  fin: v(-3.36, 0.37),
  finArea: 3.32,
  // cabeza respecto al mástil (el mástil lo mueve la ley de vueltas)
  head: { base: 5, aft: 6, fwd: 8 },
  emptyMass: 1480,
  fuelMass: 150,
  mtow: 1950,
  // fuselaje, tren fijo, mástil y cabeza (el ala, la cola y el rotor van aparte)
  cdA: 0.34,
  engine: LYCOMING_IO540,
  rotor: {
    ...DEFAULT_ROTOR,
    radius: 6.86,
    // 0,44 m en la raíz y 0,30 en la punta
    chord: 0.37,
    blades: 2,
    // todo el paso lo da el colectivo automático
    pitch: 0,
    precone: 2 * (Math.PI / 180),
    inertia: 4600,
    rootCutout: 0.9,
    teeterLimit: 12 * (Math.PI / 180),
    cd0: 0.0075,
    cd2: 0.2,
    yawedDrag: true,
  },
  propPitch: 1,
  propBlades: 5,
  propSpin: 1,
  cspProp: { govRpm: [2300, 2700], chordBlades: 0.18, liftSlope: 5.7, cd0: 0.008, betaFine: 9, betaMax: 42, betaFlat: 2 },
  // prerrotador por correa desde el motor: ~370 rpm con el motor a fondo (el tope de 385 no se llega a alcanzar)
  prerotator: { minEngineRpm: 1200, ratio: 0.142, maxRpm: 385, torque: 6000 },
  rpmScale: 0.85,
  inertia: [816, 1750, 1050],
  body: { vertCdA: 4.5, vertCP: v(-0.5, 0), sideCdA: 5.0, sideCP: v(-0.8, 0.4) },
  gearScale: 2.2,
  noseGearScale: 3,
  wheelRadius: 0.2,
  rollTrim: 0,
  // dos asientos delante lado a lado, el piloto a la izquierda
  seatZ: { pilot: -0.31, passenger: 0.31 },
  wing: {
    area: 13.9,
    span: 13.72,
    taper: 0.35,
    // (ver arriba: centro aerodinámico cerca del CG, no donde está dibujado)
    ac: v(0.0, -0.45),
    incidence: 2,
    dihedral: 7,
    cl0: 0.3,
    clMax: 1.45,
    clMin: -0.9,
    cd0: 0.009,
    oswald: 0.85,
    cm0: -0.06,
    aileron: 6,
    // alerones de |z| 3,30 a 6,55
    aileronFrom: 0.48,
    rotorWash: 1,
  },
  elevator: 7,
  slowedRotor: {
    rpm: [
      [0, 285],
      [100, 280],
      [140, 215],
      [180, 150],
      [220, 122],
      [270, 110],
    ],
    iasTau: 15,
    mast: { min: -15, max: 30, rate: 4, ff: [[0, -11], [50, -7], [100, -6], [200, -12], [300, -14]], kp: 0.2, ki: 0.01, kd: 10, aoaMin: 0.5, aoaMax: 25, kAoa: 1.5, minIas: 105, ground: -15, groundHead: 7, roll: 6 },
    collective: {
      flat: 0,
      flight: [
        [0, 2],
        [0.12, 2],
        [0.3, 1],
        [0.8, 0],
        [1.2, -1],
      ],
      jump: 8,
      jumpMinRpm: 330,
      jumpMinThrottle: 0.6,
      jumpFullRpm: 320,
      jumpEndRpm: 240,
      jumpEndKmh: 75,
      rate: 2,
      jumpRate: 25,
      cushion: { agl: 5, sink: 1.5, gain: 1.5, max: 5 },
    },
    muWarn: 1.2,
    muLimit: 1.5,
  },
  crashPoints: [
    { name: 'morro', p: v(2.24, -0.53) },
    { name: 'panza', p: v(0.28, -0.9) },
    { name: 'panza', p: v(-1.62, -0.65) },
    { name: 'costado izquierdo', p: v(0.73, -0.18, -0.7) },
    { name: 'costado derecho', p: v(0.73, -0.18, 0.7) },
    { name: 'ala izquierda', p: v(-1.08, 0.045, -6.86) },
    { name: 'ala derecha', p: v(-1.08, 0.045, 6.86) },
    { name: 'mástil', p: v(-0.62, 1.5) },
    { name: 'estabilizador', p: v(-3.6, 0.34, -2.19) },
    { name: 'estabilizador', p: v(-3.6, 0.34, 2.19) },
    { name: 'deriva lateral', p: v(-3.52, 0.95, -2.19) },
    { name: 'deriva lateral', p: v(-3.52, 0.95, 2.19) },
    { name: 'deriva lateral', p: v(-3.45, -0.11, -2.19) },
    { name: 'deriva lateral', p: v(-3.45, -0.11, 2.19) },
    { name: 'deriva', p: v(-3.4, 1.12) },
  ],
}

/**
 * Sport Copter Lightning (Scappoose, Oregón): ultraligero monoplaza de bastidor abierto de tubo de
 * aluminio, con un Rotax 503 de dos tiempos tras el mástil, hélice bipala de madera de 60 pulgadas,
 * rotor de 23 pies (7,01 m, cuerda de 7 pulgadas) y una gran deriva-timón rectangular con un
 * estabilizador pequeño. Calcado sobre una foto aire-aire lateral (blender/build_sportcopter.py).
 * Datos de Sport Copter: 115-127 kg en vacío, 272 kg de máximo, 5 galones de gasolina, crucero de
 * 55 mph y máxima de 63-80 mph. Pesa la mitad que un biplaza: el CG va 0,27 m por delante del buje
 * (la misma inclinación buje-CG que el resto) según un reparto de masas, y lleva su propia inercia,
 * un tren más blando y un prerrotador ligero.
 */
export const SCLIGHTNING: Airframe = {
  id: 'sclightning',
  wreck: wreckZones(-1.15, -0.235, -1.024, 0.3, -0.19, 0.75, -0.738),
  hub: v(-0.194, 1.428),
  headPivot: v(-0.164, 1.248),
  // bipala de madera de 60 × 32 pulgadas (1,52 m)
  prop: v(-0.738, 0.158),
  propRadius: 0.762,
  cg: CG_COMMON.clone(),
  noseWheel: v(1.172, -1.024),
  mainL: v(-0.235, -1.024, -0.86),
  mainR: v(-0.235, -1.024, 0.86),
  // ruedecilla de cola
  tail: v(-1.529, -0.867),
  // estabilizador recto de 1,20 × 0,40 m con plaquitas de punta de 0,29 m
  stab: v(-1.294, -0.74),
  stabArea: 0.48,
  ...stabCoeffs(1.2, 0.48, 0.29),
  // deriva (0,34 m²) + timón (0,44 m²) + plaquitas de punta
  fin: v(-1.505, -0.413),
  finArea: 0.956,
  // estabilizador pequeño y cola corta: tope trasero en 13,9°; palanca centrada para ~90 km/h
  head: { base: 8.2, aft: 5.7, fwd: 7.0 },
  // 120 kg en vacío; 5 galones (19 l); 272 kg de máximo
  emptyMass: 120,
  fuelMass: 14,
  mtow: 272,
  seats: 1,
  // bastidor abierto: piloto, tubos y motor al aire
  cdA: 0.55,
  engine: ROTAX_503,
  // 7,01 m de diámetro y 17,8 cm de cuerda; palas ligeras de aluminio extruido
  rotor: { ...DEFAULT_ROTOR, radius: 3.505, chord: 0.178, inertia: 65, rootCutout: 0.35 },
  propPitch: 1,
  // empuje a punto fijo ~117 kgf con 35 kW a 2500 rpm de hélice; deja de empujar hacia J 0,65
  propCoef: { ct0: 0.105, cp0: 0.05, j0: 0.65, j1: 0.72 },
  propBlades: 2,
  // prerrotador mecánico opcional: hasta 220 rpm con el motor hacia 4400 rpm
  prerotator: { minEngineRpm: 2600, ratio: 0.05, maxRpm: 220, torque: 150 },
  inertia: [260, 300, 330],
  body: { vertCdA: 1.6, vertCP: v(0.3, -0.15), sideCdA: 1.5, sideCP: v(0.2, 0.25) },
  gearScale: 0.5,
  wheelRadius: 0.17,
  crashPoints: [
    { name: 'morro', p: v(1.306, -0.522) },
    { name: 'panza', p: v(0.126, -0.872) },
    { name: 'mástil', p: v(-0.19, 1.3) },
    { name: 'estabilizador', p: v(-1.394, -0.74, -0.62) },
    { name: 'estabilizador', p: v(-1.394, -0.74, 0.62) },
    { name: 'deriva', p: v(-1.794, 0.171) },
    { name: 'deriva', p: v(-2.103, -0.352) },
  ],
}

/** El mismo Lightning con el carenado de morro, parabrisas y techo: algo menos de resistencia. */
export const SCLIGHTNING_F: Airframe = {
  ...SCLIGHTNING,
  id: 'sclightning_f',
  emptyMass: 127,
  cdA: 0.45,
  crashPoints: [
    ...SCLIGHTNING.crashPoints.filter((c) => c.name !== 'morro'),
    { name: 'morro', p: v(1.431, -0.512) },
    { name: 'panza', p: v(0.806, -0.762) },
    { name: 'costado izquierdo', p: v(0.806, -0.452, -0.29) },
    { name: 'costado derecho', p: v(0.806, -0.452, 0.29) },
    { name: 'mástil', p: v(0.636, 0.738) },
  ],
}

/**
 * DTA J-RO (Montélimar, Francia): tándem cerrado de casco de carbono con cúpula pegada y puertas de
 * ala de gaviota, capó con cuatro agallas, tren ancho con carenados en lágrima y una cola muy
 * vertical: estabilizador en flecha con dos grandes aletas en las puntas y deriva central con el
 * timón. Calcado sobre el plano acotado del manual de vuelo (5,20 × 1,95 × 2,62 m; batalla 1,85 m)
 * y fotos (blender/build_jro.py). Manual: 279 kg en vacío con el 914, 560 kg de máximo (export),
 * rotor Averso de 8,60 m y 21,6 cm de cuerda, VNE 180 km/h, crucero 110-135 km/h.
 */
export const JRO: Airframe = {
  id: 'jro',
  wreck: wreckZones(-1.8, -0.522, -0.94, 0.5, -0.25, 0.75, -1.274),
  hub: v(-0.25, 1.684),
  headPivot: v(-0.28, 1.484),
  // DUC Flash tripala de 1,72 m
  prop: v(-1.274, 0.372),
  propRadius: 0.86,
  cg: CG_COMMON.clone(),
  noseWheel: v(1.328, -0.94),
  mainL: v(-0.522, -0.94, -0.85),
  mainR: v(-0.522, -0.94, 0.85),
  // no lleva patín: lo primero que toca es el borde de salida del estabilizador
  tail: v(-2.55, -0.34),
  // estabilizador en flecha de 1,69 m (0,845 m²) con aletas de punta de 0,73 m
  stab: v(-2.18, -0.31),
  stabArea: 0.845,
  ...stabCoeffs(1.69, 0.845, 0.73),
  // deriva central con timón (0,72 m²) y dos aletas de punta de 0,44 m²
  fin: v(-2.53, 0.12),
  finArea: 1.588,
  // tope trasero en 14,9°: a fondo atrás y sin motor baja casi en vertical avanzando unos 8 km/h
  head: { base: 7.2, aft: 7.7, fwd: 8.2 },
  // 279 kg en vacío con el 914; 60 de los 70 l del depósito; 560 kg de máximo
  emptyMass: 279,
  fuelMass: 45,
  mtow: 560,
  // cabina cerrada y ancha (0,94 m)
  cdA: 0.48,
  engine: ROTAX_914UL,
  // 8,60 m de diámetro y 21,6 cm de cuerda (Averso)
  rotor: { ...DEFAULT_ROTOR, radius: 4.3, chord: 0.216, inertia: 205 },
  propPitch: 1.05,
  crashPoints: [
    { name: 'morro', p: v(2.054, -0.388) },
    { name: 'panza', p: v(0.85, -0.616) },
    { name: 'panza', p: v(-1.29, -0.616) },
    { name: 'costado izquierdo', p: v(0.49, -0.18, -0.47) },
    { name: 'costado derecho', p: v(0.49, -0.18, 0.47) },
    { name: 'carenado izquierdo', p: v(-1.01, -0.62, -0.85) },
    { name: 'carenado derecho', p: v(-1.01, -0.62, 0.85) },
    { name: 'mástil', p: v(-0.26, 1.52) },
    { name: 'estabilizador', p: v(-2.4, -0.17, -0.845) },
    { name: 'estabilizador', p: v(-2.4, -0.17, 0.845) },
    { name: 'deriva lateral', p: v(-2.3, 0.474, -0.845) },
    { name: 'deriva lateral', p: v(-2.3, 0.474, 0.845) },
    { name: 'deriva lateral', p: v(-3.04, 0.0, -0.845) },
    { name: 'deriva lateral', p: v(-3.04, 0.0, 0.845) },
    { name: 'deriva', p: v(-2.55, 0.564) },
  ],
}

/**
 * Niki Lightning (Niki Rotor Aviation, Bulgaria): tándem cerrado con la hélice en MEDIO del aparato:
 * gira alrededor del tubo de cola, justo detrás de la cabina, movida por correa desde el Rotax que va
 * dentro del casco. Detrás, un cono de cola con estabilizador, dos aletas de punta, deriva dorsal y
 * deriva ventral con el timón (cola en cruz), y un patín de acero que protege la hélice. Calcado
 * resolviendo la cámara de la foto de Wikimedia Commons (blender/build_niki.py). Datos del
 * fabricante: 285 kg en vacío, 560 kg de máximo, rotor de 8,50 m (cuerda 21 cm), hélice E-Props de
 * 1,75 m, crucero 135-160 km/h, VNE 180-190 km/h.
 */
export const NIKI: Airframe = {
  id: 'niki',
  wreck: wreckZones(-2.1, -0.52, -0.93, 0.45, -0.25, 0.85, -1.17),
  hub: v(-0.25, 1.85),
  headPivot: v(-0.25, 1.65),
  // tripala E-Props de 1,75 m alrededor del tubo de cola
  prop: v(-1.17, 0.28),
  propRadius: 0.875,
  cg: CG_COMMON.clone(),
  noseWheel: v(1.47, -0.93),
  mainL: v(-0.52, -0.93, -0.865),
  mainR: v(-0.52, -0.93, 0.865),
  // patín de acero bajo la deriva ventral
  tail: v(-2.4, -0.56),
  // estabilizador recto de 1,74 × 0,37 m sobre el eje de la hélice, con aletas de punta de 0,65 m
  stab: v(-2.35, 0.29),
  stabArea: 0.64,
  ...stabCoeffs(1.74, 0.64, 0.65),
  // dorsal (0,25 m²) + ventral con timón (0,29 m²) + dos aletas de punta (0,19 m² cada una)
  fin: v(-2.39, 0.255),
  finArea: 0.92,
  // cola pequeña y alta, buje a 1,75 m del CG: el tope trasero se queda en 13,2° (con más, a fondo
  // atrás y sin motor se encabrita y se va de cola)
  head: { base: 7.2, aft: 6.0, fwd: 8.2 },
  // 285 kg en vacío; 60 de los 70 l; 560 kg de máximo
  emptyMass: 285,
  fuelMass: 45,
  mtow: 560,
  // cabina cerrada y fina, ruedas carenadas
  cdA: 0.42,
  engine: ROTAX_914UL,
  // 8,50 m de diámetro y 21 cm de cuerda (Trendak)
  rotor: { ...DEFAULT_ROTOR, radius: 4.25, chord: 0.21, inertia: 190 },
  propPitch: 1.05,
  wheelRadius: 0.18,
  crashPoints: [
    { name: 'morro', p: v(1.97, -0.3) },
    { name: 'panza', p: v(1.25, -0.565) },
    { name: 'panza', p: v(-0.47, -0.37) },
    { name: 'costado izquierdo', p: v(0.15, -0.03, -0.41) },
    { name: 'costado derecho', p: v(0.15, -0.03, 0.41) },
    { name: 'carenado izquierdo', p: v(-0.52, -0.7, -0.95) },
    { name: 'carenado derecho', p: v(-0.52, -0.7, 0.95) },
    { name: 'mástil', p: v(-0.26, 1.7) },
    { name: 'estabilizador', p: v(-2.45, 0.29, -0.87) },
    { name: 'estabilizador', p: v(-2.45, 0.29, 0.87) },
    { name: 'deriva lateral', p: v(-2.64, 0.58, -0.87) },
    { name: 'deriva lateral', p: v(-2.64, 0.58, 0.87) },
    { name: 'deriva lateral', p: v(-2.67, -0.07, -0.87) },
    { name: 'deriva lateral', p: v(-2.67, -0.07, 0.87) },
    { name: 'deriva', p: v(-2.38, 0.92) },
    { name: 'deriva', p: v(-2.635, -0.39) },
  ],
}

export const AIRFRAMES: Record<string, Airframe> = {
  generic: GENERIC,
  ela07: ELA07,
  ela10: ELA10,
  cierva: CIERVA_C30,
  mt03: MT03,
  scorpion: SCORPION,
  jro: JRO,
  niki: NIKI,
  sclightning: SCLIGHTNING,
  sclightning_f: SCLIGHTNING_F,
  calidus: CALIDUS,
  cavalon: CAVALON,
  carterpav: CARTER_PAV,
}

/** Geometría de vuelo del aparato del catálogo (la genérica si no tiene una propia). */
export function airframeById(id: string): Airframe {
  return AIRFRAMES[id] ?? GENERIC
}
