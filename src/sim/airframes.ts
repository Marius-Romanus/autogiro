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
import { CELIER_912ULST, GENET_MAJOR, GENET_MAJOR_I, LE_RHONE_9J, LYCOMING_IO540, MCCULLOCH_4318A, PLASMA_MHD, KINNER_R5, ROTAX_503, ROTAX_912ULS, ROTAX_914UL, ROTAX_915IS, type EngineSpec } from './engines.ts'
import { DEFAULT_ROTOR, type RotorParams } from './rotor.ts'
import type { WreckZones } from './wreck/parts.ts'
import type { CspPropSpec, SlowedRotorSpec, WingSpec } from './compound.ts'
import type { FloatSpec, HullElement } from './hydro.ts'
import { withFloats } from './floatKit.ts'

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
  /**
   * masa en vacío (kg, con aceite y refrigerante) y combustible de referencia (kg): el que llevan los
   * bancos de pruebas y con el que vale el CG de la ficha. En el juego se sale con el del menú;
   * capacidad, consumo y dónde va el depósito: sim/fuel.ts
   */
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
   * Arranque del rotor con cuerda en vez de prerrotador (Cierva C.6): con el aparato parado y el rotor
   * quieto, la tecla del prerrotador hace que el personal de tierra tire de la cuerda (ver `RopeStart`).
   */
  ropeStart?: RopeStart
  /**
   * Tren estrecho sin rueda gobernable ni deriva (Cierva C.6): en tierra la ayuda de teclado lleva las alas a
   * nivel con los alerones y el rumbo con el que echó a rodar con el timón, mientras no se toquen esos mandos (sin
   * ella, al aligerarse en la carrera se va de lado y vuelca sobre una punta).
   */
  groundAssist?: boolean
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
  /** el apoyo de cola (`tailWheel`) es un patín (Cierva C.19): no rueda, roza en todas direcciones */
  tailSkid?: boolean
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
  /**
   * Rotor de paso cíclico sin batimiento (Wilford XOZ-1): las palas solo cambian de paso y giran siempre
   * en el plano del eje, fijo al pilón; lo que se inclina con la palanca y el viento es el empuje, no el
   * disco. Las fuerzas son las de un rotor que bate (equivalencia paso-batimiento), pero se dibuja con
   * las palas en el plano del eje: la deriva del XOZ-1 llega a 0,3 m del plano del rotor, y un disco que
   * se inclinara hacia atrás la atravesaría.
   */
  featheringRotor?: boolean
  /**
   * Cabeza del rotor fija (los Cierva de antes del mando directo: C.6, C.19 hasta el Mk IV): la palanca
   * no inclina el rotor, que se queda en `head.base`; se gobierna como un avión, con los alerones del
   * ala (`wing`), la profundidad (`elevator`) y el timón, que apenas sirven a poca velocidad.
   */
  headFixed?: boolean
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
  /**
   * Fracción del soplado de la hélice que llega a estabilizador y deriva (1 si falta). 0 cuando la
   * salida va por detrás de la cola (la tobera del Sigilo): si no, el chorro de un disco pequeño y muy
   * cargado haría de la cola un timón de profundidad gigante.
   */
  tailSlipstream?: number
  /**
   * Aguante del rotor contra los topes de batimiento respecto a un bipala basculante (1): cuántos
   * golpes aguanta antes de romper. Un rotor rígido de material compuesto con topes elastoméricos
   * (Sigilo) aguanta bastante más en maniobras bruscas.
   */
  flapToughness?: number
  /** escala del velocímetro (km/h) si el aparato pasa de la normal (0-200: arco verde 45-150, amarillo hasta 180) */
  asi?: AsiSpec
  /**
   * Equipo de fumigación (Gyro Tractor): tolva y barras. Las boquillas son los nodos `spray_NN` del
   * modelo; la tecla U abre y cierra el paso (src/fx/SprayFx.ts) y el producto que sale aligera el aparato.
   */
  sprayer?: SprayerSpec
  /**
   * Flotadores (hidroautogiro): cascos estancos que flotan, planean a velocidad y llevan timón de agua
   * en la popa (sim/hydro.ts). Sin ellos, en el agua solo flotan un rato la góndola y los neumáticos.
   */
  floats?: FloatSpec[]
  /** casco para el agua hecho a mano (si falta, `hullFor` lo saca de los puntos de la célula) */
  hull?: HullElement[]
  /**
   * Hidroautogiro sin ruedas: los apoyos de la ficha (`mainL`, `mainR`, `noseWheel`) son las quillas de
   * los flotadores. En tierra no ruedan: patinan (y en el agua ni tocan el fondo).
   */
  keelGear?: boolean
  /** más quillas (proas y popas de los flotadores) que apoyan si el tren no lo hace */
  keels?: Vector3[]
  /**
   * Tren anfibio (flotadores con ruedas, `floatKit.ts`): los apoyos de la ficha son las ruedas bajadas;
   * al recogerlas suben `retract` metros dentro del flotador. `wheels`: apoyo de cada rueda (para el
   * agua, si se amariza con ellas fuera) y su radio.
   */
  amphib?: { retract: number; wheels: Vector3[]; radius: number; noses?: Vector3[] }
  /**
   * Tren retráctil (Sigilo): la tecla del tren (Y) lo sube o lo baja en `time` s. Recogido, las ruedas no
   * tocan (se toma sobre la panza: sus puntos de choque) y la célula pierde `dragSave` m² de resistencia.
   * `parts`: nodos del modelo que giran al recogerlo (patas con su rueda, compuertas): eje en ejes del
   * modelo (x adelante, y arriba, z derecha) y grados de abajo/abierto a recogido/cerrado; `late` = la
   * compuerta se cierra al final, cuando la pata ya está dentro (y se abre la primera al bajarlo).
   */
  retractGear?: RetractGearSpec

  // ---- Autogiro compuesto de rotor frenado (Carter PAV): `compound.ts` ----
  /** ala con alerones (fuerzas en el centro aerodinámico de cada franja) */
  wing?: WingSpec
  /**
   * Timón de profundidad: grados de incidencia del estabilizador por unidad de palanca de cabeceo
   * (palanca atrás → borde de salida arriba). La palanca sigue inclinando la cabeza del rotor.
   */
  elevator?: number
  /**
   * Grados con la palanca a fondo atrás, si la profundidad sube más de lo que baja (C.19: con la cabeza
   * fija, tiene que poder levantar el morro para la bajada empinada). Cerca del centro manda `elevator`;
   * la subida extra crece con el cuadrado de la palanca.
   */
  elevatorAft?: number
  /** hélice de paso variable con regulador (en vez de la de paso fijo de `propCoeffs`) */
  cspProp?: CspPropSpec
  /**
   * Rotor frenado: ley de vueltas con el mástil basculante (la cabeza bascula sobre `headPivot`, el
   * pie del mástil, y la palanca inclina además el plano de la cabeza sobre el buje), colectivo
   * automático y salto. Avisos y accidente de bajas vueltas referidos a la ley de vueltas.
   */
  slowedRotor?: SlowedRotorSpec
}

export interface RetractGearSpec {
  time: number
  lift: number
  dragSave: number
  parts: { node: string; axis: [number, number, number]; angle: number; late?: boolean }[]
}

/** Escala del velocímetro: fondo, marca grande cada `step` y pequeña cada `minor`, arcos de color (km/h). */
export interface AsiSpec {
  max: number
  step: number
  minor: number
  green: [number, number]
  yellow: [number, number]
  red: number
}

export interface SprayerSpec {
  /** capacidad de la tolva (l) y lo que se carga al salir (l: hasta el peso máximo) */
  hopper: number
  load: number
  /** densidad del caldo (kg/l) */
  density: number
  /** dosis (l/ha) y anchura de pasada (m): el caudal sigue a la velocidad respecto al suelo */
  rate: number
  swath: number
}

export interface PropCoef {
  ct0: number
  cp0: number
  j0: number
  j1: number
}

/**
 * Arranque con cuerda (Cierva C.6 de 1924-25, sin prerrotador; Flight, 22-10-1925): una cuerda enrollada
 * en unos tacos bajo las palas, a `radius` m del eje, de la que tira el personal de tierra con `force` N
 * hasta que se acaban los `length` m o el rotor va más deprisa de lo que pueden correr (`speed`, m/s).
 */
export interface RopeStart {
  force: number
  radius: number
  length: number
  speed: number
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
  // motor de serie del Cougar: Rotax 912 ULS de 100 CV (el 914 turbo es opcional). 250 kg en vacío y
  // 450 kg de máximo (folleto de ELA y Wikipedia): con dos a bordo solo caben 42 de los 75 l del depósito
  emptyMass: 250,
  fuelMass: 30,
  mtow: 450,
  cdA: 0.6,
  engine: ROTAX_912ULS,
  // 8,23 m de diámetro y 22 cm de cuerda: palas más cortas y más anchas (y más pesadas)
  rotor: { ...DEFAULT_ROTOR, radius: 4.115, chord: 0.22, inertia: 179 },
  // con el 912 ULS, el mismo paso que el genérico (5150 rpm a punto fijo, 5670 a 158 km/h)
  propPitch: 1,
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

/**
 * Wallis WA-116 Agile (Ken Wallis, Reymerston Hall, Norfolk): el prototipo G-ARRT de 1961, el de la
 * serie que construyó Beagle (y del que salió «Little Nellie»). Monoplaza abierto diminuto: góndola
 * de fibra con el piloto al aire, mástil inclinado adelante con la cabeza de cardán desplazado de
 * Wallis (estable con las manos fuera), McCulloch de dos tiempos con la bipala en toma directa y una
 * deriva con un gran timón compensado. Calcado resolviendo la cámara de tres fotos de G-ARRT
 * (blender/build_wa116.py). Datos: rotor de 6,20 m, 116 kg en vacío, 249 kg de máximo, ~160 km/h.
 */
export const WA116: Airframe = {
  id: 'wa116',
  wreck: wreckZones(-0.95, 0.03, -0.713, 0.224, -0.111, 0.35, -0.736),
  hub: v(-0.111, 1.107),
  // cardán desplazado: el pivote de cabeceo va 0,10 m por delante del buje
  headPivot: v(-0.011, 0.885),
  // bipala de madera de 48 pulgadas (1,22 m)
  prop: v(-0.736, 0.147),
  propRadius: 0.61,
  cg: CG_COMMON.clone(),
  noseWheel: v(1.003, -0.713),
  mainL: v(0.03, -0.713, -0.76),
  mainR: v(0.03, -0.713, 0.76),
  // patín de cola
  tail: v(-1.551, -0.647),
  // estabilizador de 0,90 × 0,275 m sobre la deriva, sin placas de punta
  stab: v(-1.08, 0.147),
  stabArea: 0.24,
  ...stabCoeffs(0.9, 0.24, 0),
  // deriva (0,18 m²) + gran timón compensado (0,37 m²)
  fin: v(-1.331, -0.172),
  finArea: 0.548,
  // rotor pequeño y muy cargado y estabilizador diminuto: palanca centrada a ~105 km/h con la cabeza
  // a 9,6° y tope trasero en 14,2°
  head: { base: 9.6, aft: 4.6, fwd: 7.0 },
  // 116 kg en vacío; 26 kg de gasolina; 249 kg de máximo
  emptyMass: 116,
  fuelMass: 26,
  mtow: 249,
  seats: 1,
  // góndola pequeña, pero el piloto va con medio cuerpo al aire
  cdA: 0.46,
  engine: MCCULLOCH_4318A,
  // 6,20 m de diámetro y 7 pulgadas de cuerda; tan cargado gira a ~450 rpm (1,3 veces los biplaza)
  rotor: { ...DEFAULT_ROTOR, radius: 3.1, chord: 0.178, inertia: 55, rootCutout: 0.3 },
  rpmScale: 1.3,
  propPitch: 1,
  // bipala de madera de 48 pulgadas en toma directa: ~120 kgf a punto fijo a 4100 rpm
  propCoef: { ct0: 0.1, cp0: 0.055, j0: 0.75, j1: 0.82 },
  propBlades: 2,
  // prerrotador mecánico: el rotor, más pequeño y rápido, se suelta hacia 280 rpm
  prerotator: { minEngineRpm: 2000, ratio: 0.115, maxRpm: 300, torque: 120 },
  inertia: [200, 230, 250],
  body: { vertCdA: 1.2, vertCP: v(0.3, -0.1), sideCdA: 1.1, sideCP: v(0.1, 0.2) },
  gearScale: 0.45,
  wheelRadius: 0.1,
  crashPoints: [
    { name: 'morro', p: v(1.604, -0.228) },
    { name: 'quilla', p: v(0.489, -0.463) },
    { name: 'eje del tren', p: v(0.03, -0.622) },
    { name: 'costado izquierdo', p: v(0.209, -0.093, -0.224) },
    { name: 'costado derecho', p: v(0.209, -0.093, 0.224) },
    { name: 'motor', p: v(-0.461, 0.149, -0.338) },
    { name: 'motor', p: v(-0.461, 0.149, 0.338) },
    { name: 'mástil', p: v(-0.111, 1.142) },
    { name: 'estabilizador', p: v(-1.151, 0.147, -0.45) },
    { name: 'estabilizador', p: v(-1.151, 0.147, 0.45) },
    { name: 'deriva', p: v(-1.368, 0.347) },
    { name: 'deriva', p: v(-1.723, -0.191) },
  ],
}

/**
 * ELA Gyro Tractor (ELA Aviación, Córdoba): el ELA 07 de cola alta convertido en fumigador. Monoplaza
 * con una tolva de 200 l donde iba el asiento de atrás, Rotax 915 iS de 141 CV con una Helix de
 * 1,75 m y barras de 8,25 m desplegadas con 20 boquillas (`spray_NN` en el modelo; tecla U). Calcado
 * sobre las fotos de fábrica resolviendo la cámara de cada una (blender/build_tractor.py).
 * Hoja de ELA: 650 kg de máximo, 280 kg de carga útil, 200 l de tolva, 30 l/ha en pasadas de 15 m a
 * 110 km/h, 500 ft/min de ascenso con todo, 200 m de carrera de despegue.
 */
export const TRACTOR: Airframe = {
  id: 'tractor',
  wreck: wreckZones(-1.62, -0.45, -0.95, 0.385, -0.25, 0.6, -1.29),
  hub: v(-0.25, 1.782),
  headPivot: v(-0.25, 1.576),
  // Helix tripala de 1,75 m
  prop: v(-1.29, 0.292),
  propRadius: 0.875,
  cg: CG_COMMON.clone(),
  noseWheel: v(1.26, -0.95),
  mainL: v(-0.45, -0.95, -0.84),
  mainR: v(-0.45, -0.95, 0.84),
  // ruedecilla de cola
  tail: v(-2.35, -0.594),
  // el estabilizador del ELA 07 con las puntas dobladas 0,50 m hacia arriba
  stab: v(-2.029, -0.388),
  stabArea: 1.083,
  ...stabCoeffs(1.56, 1.083, 0.5),
  // palanca centrada a ~110 km/h, la velocidad de fumigar; tope trasero en 14,3°
  head: { base: 8.0, aft: 6.3, fwd: 8.2 },
  // deriva (0,24 m²) + timón (0,26 m²) + las dos puntas dobladas (0,13 m² cada una)
  fin: v(-2.315, -0.037),
  finArea: 0.758,
  // 370 kg en vacío (650 de máximo menos 280 de carga útil); 30 l de gasolina
  emptyMass: 370,
  fuelMass: 22,
  mtow: 650,
  seats: 1,
  // bastidor abierto y, sobre todo, 8,25 m de barras, tirantes, cables y boquillas al aire
  cdA: 0.85,
  engine: ROTAX_915IS,
  // 8,23 m de diámetro y 22 cm de cuerda, como el ELA 07
  rotor: { ...DEFAULT_ROTOR, radius: 4.115, chord: 0.22, inertia: 179 },
  propPitch: 1.12,
  wheelRadius: 0.2,
  // tolva cargada hasta los 650 kg: 650 − 370 − 22 − piloto ≈ 170 l
  sprayer: { hopper: 200, load: 170, density: 1, rate: 30, swath: 15 },
  crashPoints: [
    { name: 'morro', p: v(2.15, -0.302) },
    { name: 'carenado de la rueda de morro', p: v(1.477, -0.747) },
    { name: 'panza', p: v(0.48, -0.779) },
    { name: 'quilla', p: v(-1.272, -0.77) },
    { name: 'costado izquierdo', p: v(0.2, 0.08, -0.384) },
    { name: 'costado derecho', p: v(0.2, 0.08, 0.384) },
    { name: 'barra de fumigación izquierda', p: v(-0.37, -0.158, -4.185) },
    { name: 'barra de fumigación derecha', p: v(-0.37, -0.158, 4.185) },
    { name: 'barra de fumigación izquierda', p: v(-0.37, -0.263, -2.49) },
    { name: 'barra de fumigación derecha', p: v(-0.37, -0.263, 2.49) },
    { name: 'mástil', p: v(-0.292, 1.65) },
    { name: 'estabilizador', p: v(-2.61, -0.385, -0.22) },
    { name: 'estabilizador', p: v(-2.61, -0.385, 0.22) },
    { name: 'deriva lateral', p: v(-2.195, 0.092, -0.9) },
    { name: 'deriva lateral', p: v(-2.195, 0.092, 0.9) },
    { name: 'deriva', p: v(-2.187, 0.492) },
  ],
}

/**
 * Vencejo X1: biplaza en tándem INVENTADO para el simulador (un concepto de hacia 2045, no existe).
 * Casco en gota de carbono con una sola cúpula tintada, pilón en flecha con la cabeza carenada,
 * rotor tripala de 8,80 m y, detrás, una hélice carenada de 7 palas y 1,30 m en un anillo. Sobre el
 * anillo no va nada (el disco inclinado 15° atrás pasa a 0,33 m): el timón es una pala vertical
 * dentro del chorro, y las derivas son las aletas de las puntas del estabilizador, que atraviesa el
 * anillo. Diseñado con blender/build_vencejo.py. Motor: el Rotax 915 iS del Gyro Tractor.
 */
export const VENCEJO: Airframe = {
  id: 'vencejo',
  wreck: wreckZones(-1.85, -0.83, -0.95, 0.475, -0.25, 0.5, -2.25),
  hub: v(-0.25, 1.82),
  headPivot: v(-0.25, 1.62),
  // hélice carenada de 7 palas y 1,30 m
  prop: v(-2.25, 0.2),
  propRadius: 0.648,
  cg: CG_COMMON.clone(),
  noseWheel: v(1.39, -0.95),
  mainL: v(-0.83, -0.95, -0.8),
  mainR: v(-0.83, -0.95, 0.8),
  // patín bajo el anillo
  tail: v(-2.5, -0.541),
  // estabilizador de 2,15 m que atraviesa el anillo (0,80 m²) con aletas de 0,90 m en las puntas
  stab: v(-2.432, 0.2),
  stabArea: 0.8,
  ...stabCoeffs(2.15, 0.8, 0.9),
  // aletas de punta (0,63 m²) + timón y estatores en el chorro (0,30 m²)
  fin: v(-2.554, 0.246),
  finArea: 0.94,
  // rotor tripala de 8,80 m (más superficie de pala que los bipala): palanca centrada a ~105 km/h
  // con la cabeza a 5,45° (sin motor y manos fuera planea a más de 80); tope trasero en 12,45°
  head: { base: 5.45, aft: 7.0, fwd: 8.2 },
  // carbono: 300 kg en vacío; 40 kg de combustible; 560 kg de máximo
  emptyMass: 300,
  fuelMass: 40,
  mtow: 560,
  // casco en gota cerrado y ruedas carenadas, pero el anillo y las aletas también rozan
  cdA: 0.42,
  engine: ROTAX_915IS,
  // tripala de 8,80 m y 20 cm de cuerda, palas de material compuesto; con más pala gira más
  // despacio que los bipala (~285 rpm en crucero): avisos y cuentavueltas a esa escala
  rotor: { ...DEFAULT_ROTOR, radius: 4.4, chord: 0.2, blades: 3, inertia: 215 },
  rpmScale: 0.82,
  propPitch: 1,
  // hélice carenada: mucho más empuje por superficie de disco que una hélice libre de su tamaño;
  // absorbe los 104 kW a ~2280 rpm (5800 del motor) y sigue empujando a más avance
  propCoef: { ct0: 0.43, cp0: 0.36, j0: 1.6, j1: 1.7 },
  propBlades: 7,
  wheelRadius: 0.2,
  crashPoints: [
    { name: 'morro', p: v(2.37, -0.24) },
    { name: 'morro', p: v(2.05, -0.395) },
    { name: 'panza', p: v(0.05, -0.655) },
    { name: 'panza', p: v(-1.1, -0.545) },
    { name: 'costado izquierdo', p: v(0.65, -0.32, -0.475) },
    { name: 'costado derecho', p: v(0.65, -0.32, 0.475) },
    { name: 'carenado izquierdo', p: v(-1.23, -0.81, -0.8) },
    { name: 'carenado derecho', p: v(-1.23, -0.81, 0.8) },
    { name: 'mástil', p: v(-0.25, 1.715) },
    { name: 'anillo', p: v(-2.19, 0.928) },
    { name: 'anillo', p: v(-2.16, -0.528) },
    { name: 'anillo', p: v(-2.25, 0.2, -0.728) },
    { name: 'anillo', p: v(-2.25, 0.2, 0.728) },
    { name: 'estabilizador', p: v(-2.54, 0.2, -1.075) },
    { name: 'estabilizador', p: v(-2.54, 0.2, 1.075) },
    { name: 'deriva lateral', p: v(-2.785, 0.76, -1.213) },
    { name: 'deriva lateral', p: v(-2.785, 0.76, 1.213) },
    { name: 'deriva lateral', p: v(-2.455, -0.14, -0.972) },
    { name: 'deriva lateral', p: v(-2.455, -0.14, 0.972) },
  ],
}

/**
 * Sigilo SX-1: biplaza en tándem INVENTADO (hacia 2060) con lenguaje furtivo, el boceto C «Dos vigas»
 * que eligió el dueño en la segunda tanda (antes descartó un tubo con tobera de ventilador, «feísimo»,
 * y un cuerpo-ala en rombo que parecía «un F-22 con unas hélices absurdas arriba»). Proporciones de
 * autogiro: cabina facetada compacta con la cúpula dorada, mástil alto en cuchilla con un anillo de
 * plasma en el eje, alitas diminutas que llevan dos vigas finas hasta una cola alta con dos derivas
 * (un timón en cada una: nodos `rudder_L`/`rudder_R`, inclinadas 10°) y un impulsor de plasma de
 * ficción que sale por una ranura dentada en la popa de la cabina, entre las vigas, con el plasma
 * brillando según el gas. Diseñado con blender/build_sigilo.py. Rotor tripala de 8,80 m (el del Vencejo).
 */
export const SIGILO: Airframe = {
  id: 'sigilo',
  wreck: wreckZones(-1.3, -0.85, -0.95, 0.5, -0.25, 0.45, -1.13),
  hub: v(-0.25, 1.82),
  headPivot: v(-0.25, 1.62),
  // compresor de 0,34 m escondido dentro de la cabina, delante de la ranura (0,12 m bajo el CG); la
  // ranura echa el chorro 4° hacia abajo, así que la línea de empuje pasa por el CG: aquí cuenta esa
  // (con la del compresor, a poca velocidad y con potencia se encabritaba 20° y se quedaba sin velocidad)
  prop: v(-1.13, 0.1),
  propRadius: 0.17,
  cg: CG_COMMON.clone(),
  noseWheel: v(1.37, -0.95),
  mainL: v(-0.85, -0.95, -0.8),
  mainR: v(-0.85, -0.95, 0.8),
  // sin patín: lo primero que toca al encabritar es el pie de los timones (a 23°)
  tail: v(-2.92, -0.06),
  // estabilizador alto entre las vigas: 1,76 m y 0,77 m², con las derivas de placas (con el primero, de
  // 0,51 m², la recogida sin motor rebotaba y en la carrera el rotor acababa tocando el suelo)
  stab: v(-2.45, 0.36),
  stabArea: 0.774,
  ...stabCoeffs(1.76, 0.774, 0.43),
  // dos derivas con aleta ventral y timón de toda la altura: 0,86 m² vistas de lado (las primeras, de
  // 0,31 m², hacían trompo en la carrera de aterrizaje y metían el rotor en el suelo)
  fin: v(-2.703, 0.326),
  finArea: 0.857,
  // estabilizador pequeño y alto: palanca centrada a ~115 km/h y tope trasero en 10,9° (con más, a
  // fondo atrás y con potencia se encabrita y se queda sin velocidad); mucho recorrido adelante para
  // llegar a ~280 km/h
  head: { base: 5.9, aft: 5.0, fwd: 13 },
  // carbono: 320 kg en vacío; 40 kg de «combustible»; 600 kg de máximo
  emptyMass: 320,
  fuelMass: 40,
  mtow: 600,
  // cabina facetada fina, vigas finas y tren carenado: limpio
  cdA: 0.36,
  engine: PLASMA_MHD,
  // tripala de 8,80 m y 20 cm de cuerda, como el Vencejo: gira a ~0,82 de los bipala. Rotor rígido de
  // material compuesto con pesos en las puntas (guarda las vueltas cuando se descarga en maniobras) y
  // más recorrido de batimiento antes de los topes, que son elastoméricos (`flapToughness`)
  rotor: { ...DEFAULT_ROTOR, radius: 4.4, chord: 0.2, blades: 3, inertia: 300, teeterLimit: 14 * (Math.PI / 180) },
  flapToughness: 2.5,
  rpmScale: 0.82,
  propPitch: 1,
  // compresor diminuto y muy rápido (8800 rpm): ~2500 N a punto fijo y sigue empujando a mucho avance
  // (coeficientes de ficción para un disco de 0,34 m)
  propCoef: { ct0: 7.2, cp0: 12.4, j0: 2.5, j1: 2.6 },
  // velocímetro hasta 320 km/h
  asi: { max: 320, step: 40, minor: 10, green: [55, 250], yellow: [250, 290], red: 290 },
  propBlades: 15,
  // el chorro sale en lámina por una ranura de 5 cm, 0,38 m por debajo del estabilizador: no lo sopla
  tailSlipstream: 0,
  // compresor de etapas contrarrotativas: ni par de reacción ni remolino sobre las derivas (con el
  // remolino de una hélice y sin soplado que lo compense, a poca velocidad los pedales no daban más de
  // sí, se iba de lado y caía)
  torqueRoll: 0,
  swirlYaw: 0,
  // el compresor gira más deprisa que un Rotax: el embrague del prerrotador va más desmultiplicado
  prerotator: { minEngineRpm: 2500, ratio: 0.055, maxRpm: 290, torque: 420 },
  // ruedas pequeñas de caza (0,26 m)
  wheelRadius: 0.13,
  // Tren retráctil (tecla Y): las patas principales se pliegan hacia atrás en unas góndolas bajo las
  // vigas (como un P-38) y la de morro hacia delante, bajo el panel; las compuertas cierran al final.
  // Recogido quita ~0,06 m² de resistencia; sin bajarlo, se toma sobre la panza (y se rompe).
  retractGear: {
    time: 4,
    lift: 0.45,
    dragSave: 0.06,
    parts: [
      { node: 'gear_L', axis: [0, 0, -1], angle: 72.1 },
      { node: 'gear_R', axis: [0, 0, -1], angle: 72.1 },
      { node: 'gear_nose', axis: [0, 0, -1], angle: -105 },
      { node: 'door_L_out', axis: [1, 0, 0], angle: -100, late: true },
      { node: 'door_L_in', axis: [1, 0, 0], angle: 100, late: true },
      { node: 'door_R_out', axis: [1, 0, 0], angle: 100, late: true },
      { node: 'door_R_in', axis: [1, 0, 0], angle: -100, late: true },
      { node: 'door_nose_L', axis: [0.949, 0.3153, 0], angle: -95, late: true },
      { node: 'door_nose_R', axis: [0.949, 0.3153, 0], angle: 95, late: true },
    ],
  },
  // alitas diminutas (0,53 m² al aire, 1,68 m entre las vigas), sin alerones, detrás del CG: a 200 km/h
  // sostienen ~10 kg. (Contadas hasta el eje, 1,16 m², al entrar en pérdida con la palanca toda atrás
  // dejaban de tirar de la cola hacia arriba y el morro se encabritaba.)
  wing: {
    area: 0.533,
    span: 1.68,
    taper: 0.727,
    ac: v(-0.644, -0.17),
    incidence: 2,
    dihedral: 2.1,
    cl0: 0.1,
    clMax: 1.3,
    clMin: -1.0,
    cd0: 0.01,
    oswald: 0.8,
    cm0: -0.02,
    aileron: 0,
    aileronFrom: 1,
    rotorWash: 1,
  },
  crashPoints: [
    { name: 'morro', p: v(2.05, -0.3) },
    { name: 'panza', p: v(0.55, -0.63) },
    { name: 'panza', p: v(-0.97, -0.611) },
    { name: 'costado izquierdo', p: v(-0.15, -0.3, -0.5) },
    { name: 'costado derecho', p: v(-0.15, -0.3, 0.5) },
    { name: 'cúpula', p: v(0, 0.555) },
    { name: 'mástil', p: v(-0.25, 1.73) },
    { name: 'viga izquierda', p: v(-0.37, -0.15, -0.84) },
    { name: 'viga derecha', p: v(-0.37, -0.15, 0.84) },
    { name: 'viga izquierda', p: v(-2.78, 0.189, -0.84) },
    { name: 'viga derecha', p: v(-2.78, 0.189, 0.84) },
    { name: 'estabilizador', p: v(-2.78, 0.36, -0.88) },
    { name: 'estabilizador', p: v(-2.78, 0.36, 0.88) },
    { name: 'deriva', p: v(-2.643, 0.706, -0.924) },
    { name: 'deriva', p: v(-2.643, 0.706, 0.924) },
    { name: 'deriva', p: v(-3.114, 0.65, -0.914) },
    { name: 'deriva', p: v(-3.114, 0.65, 0.914) },
    { name: 'deriva', p: v(-2.49, -0.08, -0.785) },
    { name: 'deriva', p: v(-2.49, -0.08, 0.785) },
    { name: 'deriva', p: v(-2.92, -0.06, -0.788) },
    { name: 'deriva', p: v(-2.92, -0.06, 0.788) },
    { name: 'tobera', p: v(-1.7, -0.09) },
    { name: 'góndola izquierda', p: v(-0.63, -0.37, -0.8) },
    { name: 'góndola izquierda', p: v(-1.49, -0.37, -0.8) },
    { name: 'góndola derecha', p: v(-0.63, -0.37, 0.8) },
    { name: 'góndola derecha', p: v(-1.49, -0.37, 0.8) },
    { name: 'panza', p: v(0.742, -0.63) },
    { name: 'panza', p: v(-0.662, -0.621) },
    { name: 'compuertas del tren de morro', p: v(1.204, -0.598) },
  ],
}

/**
 * Wilford XOZ-1 (Pennsylvania Aircraft Syndicate, 1936): el hidroautogiro de pruebas de la US Navy.
 * Fuselaje y ala baja del entrenador Fleet N2Y, rotor de cuatro palas de 9,75 m sin articulaciones de
 * batimiento (las palas solo cambian de paso: las opuestas van unidas, y la palanca las inclina como un
 * cíclico, además de mover alerones y profundidad) sobre un pilón de cuatro tubos, Kinner R-5 de
 * 155 CV y dos flotadores Edo en vez de ruedas. Datos de Aero Digest (feb. 1935 y mar. 1937): ala de
 * 8,33 m y 10,2 m², rotor de 804 sq ft con 68,3 sq ft de pala, 660 kg en vacío y 900 al máximo como
 * avión de tierra, máxima 172 km/h, crucero 145, toma a 48 km/h. Con flotadores, unos 65 kg más.
 * Calcado sobre esas fotos y su plano de tres vistas (blender/build_wilford.py). Como un rotor de
 * paso cíclico hace lo mismo que inclinar la cabeza (equivalencia batimiento-paso), el modelo de vuelo
 * lo trata como los demás; el CG lleva el criterio común (buje 0,33 m por detrás).
 */
export const WILFORD: Airframe = {
  id: 'wilford',
  // medidas del modelo (blender/build_wilford.py): buje 1,58 m sobre el CG
  hub: v(-0.25, 1.68),
  headPivot: v(-0.25, 1.42),
  // bipala metálica de 2,50 m («metal propeller» en la ficha de 1937), toma directa
  prop: v(1.526, 0.25),
  propRadius: 1.25,
  cg: CG_COMMON.clone(),
  // sin ruedas: apoya en las quillas de los flotadores (bajo el redán, y en proas y popas)
  keelGear: true,
  mainL: v(-0.3, -1.75, -1.08),
  mainR: v(-0.3, -1.75, 1.08),
  keels: [v(1.7, -1.62, -1.08), v(1.7, -1.62, 1.08), v(-2.4, -1.38, -1.08), v(-2.4, -1.38, 1.08)],
  // lo más bajo de la cola: el pie del timón
  tail: v(-4.23, 0.12),
  // estabilizador y profundidad de 2,62 m (2,08 m²) sobre el fuselaje
  stab: v(-3.95, 0.55),
  stabArea: 2.08,
  ...stabCoeffs(2.62, 2.08, 0),
  // deriva (0,87 m²) y timón (0,78 m²)
  fin: v(-3.95, 0.82),
  finArea: 1.65,
  head: { base: 7.2, aft: 8.0, fwd: 8.2 },
  emptyMass: 725,
  fuelMass: 44,
  mtow: 970,
  // fuselaje de tela con cables, motor radial a la vista, pilón de cuatro tubos y los flotadores
  cdA: 1.0,
  engine: KINNER_R5,
  // 4 palas de ~0,34 m (68,3 sq ft entre las cuatro): madera y tela sobre larguero de acero
  rotor: {
    ...DEFAULT_ROTOR,
    radius: 4.875,
    chord: 0.34,
    blades: 4,
    pitch: 0.0465,
    precone: 3 * (Math.PI / 180),
    inertia: 380,
    rootCutout: 0.6,
    liftSlope: 5.72,
    cd0: 0.0105,
    cd2: 0.3,
  },
  propPitch: 1,
  // a punto fijo deja al Kinner subir a ~1800 rpm; con ella sube ~3,3 m/s solo y ~2,2 con dos (el C.30A, con
  // 140 CV y 770 kg, subía 2,7)
  propCoef: { ct0: 0.078, cp0: 0.031, j0: 0.72, j1: 0.82 },
  propBlades: 2,
  propSpin: 1,
  // embrague del prerrotador desde el motor: con el 40 % de gas (~1150 rpm) llega a las ~170 de soltar (0,7 de las de crucero, como el C.30A)
  prerotator: { minEngineRpm: 800, ratio: 0.165, maxRpm: 185, torque: 1500 },
  // rotor grande y de mucha cuerda: ~236 rpm en crucero
  rpmScale: 0.67,
  inertia: [520, 780, 900],
  // los flotadores frenan mucho el aire que viene de abajo y de lado
  body: { vertCdA: 8, vertCP: v(-0.3, -0.9), sideCdA: 7, sideCP: v(-0.9, -0.3) },
  // ala baja del Fleet: 8,33 m, cuerda 1,40 (1,32 en la punta), 5° de diedro, 2° de calado; alerones del 45 al 92 %
  wing: {
    area: 10.2,
    span: 8.33,
    taper: 0.94,
    ac: v(0.04, -0.185),
    incidence: 2,
    dihedral: 5,
    cl0: 0.25,
    clMax: 1.35,
    clMin: -0.6,
    cd0: 0.012,
    oswald: 0.75,
    cm0: -0.08,
    aileron: 10,
    aileronFrom: 0.45,
    // sin estela del rotor sobre ala y cola: su efecto en el Wilford no está medido y el modelo sencillo de
    // estela (compound.ts) lo exagera: con la cola alta, en la recogida la hacía caer de morro
    rotorWash: 0,
  },
  // la palanca mueve también la profundidad (además del paso cíclico del rotor)
  elevator: 4,
  // las palas no baten: se dibujan siempre en el plano del eje (la deriva llega a 0,3 m del disco)
  featheringRotor: true,
  // Edo 2000 (2000 lb de empuje cada uno: 0,9 m³) de 5,28 m, a 1,08 m a cada lado, redán 0,38 m por detrás del
  // CG. En la física van 0,15 m más adelante que en el dibujo: el CG del simulador va por criterio por delante
  // del real, y así el empuje queda bajo él (en reposo, nivelado) y el redán justo detrás. Nivelados; el fondo
  // de proa planea con 3,5°; timones de agua de 0,056 m²
  floats: [
    { name: 'flotador izquierdo', bow: v(2.52, -1.484, -1.08), stern: v(-2.76, -1.484, -1.08), radius: 0.266, rudder: 0.056, step: -0.15, forebodyTrim: 0.06 },
    { name: 'flotador derecho', bow: v(2.52, -1.484, 1.08), stern: v(-2.76, -1.484, 1.08), radius: 0.266, rudder: 0.056, step: -0.15, forebodyTrim: 0.06 },
  ],
  wreck: wreckZones(-2.6, -0.3, -1.75, 0.42, -0.25, 0.55, 1.526),
  crashPoints: [
    { name: 'motor', p: v(1.23, 0.84) },
    { name: 'motor', p: v(1.23, 0.432, -0.561) },
    { name: 'motor', p: v(1.23, 0.432, 0.561) },
    { name: 'motor', p: v(1.23, -0.227, -0.347) },
    { name: 'motor', p: v(1.23, -0.227, 0.347) },
    { name: 'panza', p: v(0.02, -0.26) },
    { name: 'panza', p: v(-1.6, -0.15) },
    { name: 'costado izquierdo', p: v(0.06, 0.14, -0.42) },
    { name: 'costado derecho', p: v(0.06, 0.14, 0.42) },
    { name: 'ala izquierda', p: v(-0.12, 0.144, -4.165) },
    { name: 'ala derecha', p: v(-0.12, 0.144, 4.165) },
    { name: 'pilón', p: v(-0.25, 1.32) },
    { name: 'estabilizador', p: v(-4.22, 0.57, -1.36) },
    { name: 'estabilizador', p: v(-4.22, 0.57, 1.36) },
    { name: 'deriva', p: v(-3.97, 1.43) },
    { name: 'deriva', p: v(-4.97, 0.32) },
  ],
}

/**
 * Cierva C.19 Mk IV (Avro 620, 1932), el EC-AIM del Museo del Aire: biplaza abierto de cabeza FIJA (antes del
 * mando directo): rotor tripala en voladizo de 34 ft con arranque por embrague desde el motor, ala baja de
 * 21 ft con alerones y puntas levantadas, cola normal con profundidad y timón, patín de cola y Genet Major I
 * de 5 cilindros. Calcado sobre el plano de la NACA (AC-120, Mk III) y fotos del museo con cámara resuelta
 * (blender/build_cierva_c19.py). Sin datos del CG: el criterio común (buje 0,33 m detrás del CG), a la
 * altura de la línea de empuje. Pesos y prestaciones de Flight (20-11-1931 y 17-11-1932) y de la Revista de
 * Aeronáutica (mayo de 1932).
 */
export const CIERVA_C19: Airframe = {
  id: 'cierva_c19',
  // buje 1,62 m sobre el CG y 0,13 por detrás: el CG medido del C.30A (R&M 1859), no el 0,33 común. Con la cabeza
  // fija al pilón (`headFixed`), con 0,33 el empuje del rotor clava el morro: la profundidad no lo frena de 70 km/h
  // y las ruedas quedan a 0,23 m del CG (capota al frenar)
  hub: v(-0.05, 1.722),
  headPivot: v(-0.05, 1.392),
  // bipala metálica de ~1,90 m (6 ft 3 in en el plano del Mk III), toma directa
  prop: v(1.773, 0.09),
  propRadius: 0.95,
  cg: CG_COMMON.clone(),
  // ruedas Dunlop de baja presión de 0,54 m, vía de 8 ft 10 in (2,70 m), amortiguadores de 24 cm
  mainL: v(0.51, -1.268, -1.35),
  mainR: v(0.51, -1.268, 1.35),
  // patín de cola: con él apoyado, 12° de cola abajo
  tailWheel: v(-3.5, -0.398),
  tailSkid: true,
  // si el patín cede, lo primero que toca es el pie del timón
  tail: v(-3.85, -0.26),
  // estabilizador (1,39 m²) y profundidad (1,01 m²) de 2,90 m, sobre los largueros altos
  stab: v(-3.32, 0.54),
  stabArea: 2.4,
  ...stabCoeffs(2.9, 2.4, 0),
  // deriva dorsal baja y larga (0,45 m²) y timón (0,76 m²)
  fin: v(-3.45, 0.44),
  finArea: 1.21,
  // (cabeza fija: solo cuenta `base`, la inclinación del eje respecto al fuselaje)
  head: { base: 0.8, aft: 6, fwd: 6 },
  // tara de 1075 lb (Flight 1932) + 12 l de aceite; 16 gal (72,7 l) de gasolina; 1550 lb de máximo
  emptyMass: 499,
  fuelMass: 52,
  mtow: 705,
  // fuselaje alto y estrecho, dos cabinas abiertas, radial a la vista, pilón y montantes (ajustada para la
  // máxima de 102 mph de Flight; el ala, la cola y el rotor van aparte)
  cdA: 0.45,
  engine: GENET_MAJOR_I,
  // 3 palas macizas de balsa con alma de abeto sobre larguero de acero, ~0,48 m de cuerda (solidez 0,09:
  // las vueltas, ~180 rpm, como las del arrancador de la Revista); ~4,3 kg/m → ~600 kg·m² (estimado)
  rotor: {
    ...DEFAULT_ROTOR,
    radius: 5.18,
    chord: 0.48,
    blades: 3,
    pitch: 0.0465,
    precone: 3 * (Math.PI / 180),
    inertia: 600,
    rootCutout: 0.62,
    liftSlope: 5.72,
    // (balsa maciza y lisa: algo menos de resistencia de perfil que las palas de costillas y tela)
    cd0: 0.0095,
    cd2: 0.3,
  },
  propPitch: 1,
  // a punto fijo deja al Genet subir a ~2000 rpm; da los 630 ft/min de Flight y ~160 km/h a fondo
  propCoef: { ct0: 0.115, cp0: 0.058, j0: 0.8, j1: 0.88 },
  propBlades: 2,
  propSpin: -1,
  // arrancador mecánico con embrague de disco: 180 rpm de rotor en 30 s (Revista de Aeronáutica, 1932)
  prerotator: { minEngineRpm: 900, ratio: 0.16, maxRpm: 190, torque: 1200 },
  rpmScale: 0.51,
  inertia: [480, 760, 900],
  body: { vertCdA: 3.0, vertCP: v(-1.1, -0.1), sideCdA: 4.5, sideCP: v(-0.9, 0.0) },
  tailWheelSteer: 0,
  // sin rueda gobernable: en la carrera la ayuda del teclado lleva el rumbo con el timón y las alas con los alerones
  groundAssist: true,
  gearScale: 1.5,
  wheelRadius: 0.27,
  headFixed: true,
  // frenos Bendix de tambor, flojos (con más, el patín no sujeta la cola y capota)
  brakeMu: 0.44,
  torqueRoll: -0.6,
  swirlYaw: -1,
  rollTrim: 0,
  // ala de madera de 6,40 m y 0,84 m de cuerda (3,78 m² según la Revista; 4,9 contando el centro y las puntas
  // planas), 5° de diedro y puntas levantadas 35° (diedro equivalente ~9°), alerones grandes del 33 % hacia fuera
  wing: {
    area: 4.9,
    span: 6.33,
    taper: 1,
    ac: v(0.445, -0.243),
    incidence: 2,
    dihedral: 9,
    cl0: 0.25,
    clMax: 1.3,
    clMin: -0.6,
    cd0: 0.012,
    oswald: 0.75,
    cm0: -0.06,
    aileron: 12,
    aileronFrom: 0.33,
    rotorWash: 0,
  },
  // la palanca mueve la profundidad (la mitad de la cola, como en el Mk III: 15,4 de 30,4 sq ft); sube mucho
  // más de lo que baja, para levantar el morro en la bajada lenta
  elevator: 4,
  elevatorAft: 30,
  // calado del estabilizador (con él, palanca neutra ≈ 105 km/h)
  stabIncidence: 1.5,
  wreck: wreckZones(-2.4, 0.51, -1.27, 0.32, -0.05, 0.6, 1.773),
  crashPoints: [
    { name: 'motor', p: v(1.462, -0.365) },
    { name: 'motor', p: v(1.462, 0.458, -0.267) },
    { name: 'motor', p: v(1.462, 0.458, 0.267) },
    { name: 'motor', p: v(1.462, -0.051, -0.433) },
    { name: 'motor', p: v(1.462, -0.051, 0.433) },
    { name: 'panza', p: v(0.25, -0.33) },
    { name: 'panza', p: v(-1.3, -0.28) },
    { name: 'costado izquierdo', p: v(0.2, 0.1, -0.32) },
    { name: 'costado derecho', p: v(0.2, 0.1, 0.32) },
    { name: 'ala izquierda', p: v(0.288, 0.234, -3.157) },
    { name: 'ala derecha', p: v(0.288, 0.234, 3.157) },
    { name: 'ala izquierda', p: v(0.35, -0.026, -2.78) },
    { name: 'ala derecha', p: v(0.35, -0.026, 2.78) },
    { name: 'pilón', p: v(-0.05, 1.32) },
    { name: 'estabilizador', p: v(-3.53, 0.542, -1.45) },
    { name: 'estabilizador', p: v(-3.53, 0.542, 1.45) },
    { name: 'deriva', p: v(-3.05, 0.8) },
    { name: 'deriva', p: v(-4.43, 0.48) },
  ],
}

/**
 * Cierva C.6bis (1925), con la decoración de la réplica del Museo del Aire («C6.B.» en el timón): el autogiro
 * que Courtney voló en Farnborough en octubre de 1925. Fuselaje de Avro 504K con su tren de patín central,
 * motor ROTATIVO Le Rhône 9J de 110 CV, una sola cabina, rotor de cuatro palas de 36 ft con articulaciones de
 * batimiento en un mástil de tubo con cuatro montantes y la cabeza FIJA: se gobierna como un avión, con dos
 * alerones enteros en las puntas de unos largueros, profundidad (el estabilizador mayor con compensación de
 * la versión bis) y timón de coma; sin prerrotador: el rotor se lanzaba tirando de una cuerda (`ropeStart`).
 * Geometría calcada del plano del Avro 504 y del plano del hangar 4 del Museo del Aire
 * (blender/build_cierva_c6.py). Datos: Flight (22-10-1925: rotor de 36 ft y ~140 rpm, 2 ft 7 in de cuerda
 * media), ficha del museo (900 kg de peso total, carrera de despegue 125 m, de aterrizaje 8,9 m) y Avro 504K
 * (Wikipedia: 558 kg en vacío, hélice de 9 ft). Sin datos del CG: el criterio común (buje 0,33 m detrás).
 */
export const CIERVA_C6: Airframe = {
  id: 'cierva_c6',
  // buje 1,85 m sobre el CG (1,75 sobre la línea de empuje, fotos); cabeza fija: el eje va fijo al mástil
  hub: v(-0.25, 1.95),
  headPivot: v(-0.25, 1.8),
  // bipala de madera del 504K: 9 ft (2,74 m), paso 8 ft 8 in; toma directa del rotativo
  prop: v(2.07, 0.2),
  propRadius: 1.37,
  cg: CG_COMMON.clone(),
  // ruedas de 700 × 75 mm, vía de 1,28 m (plano del 504)
  mainL: v(0.53, -1.56, -0.64),
  mainR: v(0.53, -1.56, 0.64),
  // patín de cola del 504K: con él apoyado, 9,6° de cola abajo
  tailWheel: v(-6.2, -0.42),
  tailSkid: true,
  // si el patín cede, lo primero que toca es el pie del timón
  tail: v(-6.25, -0.22),
  // estabilizador y profundidades con cuernos de compensación: 5,48 m² y 4,02 m de envergadura (plano)
  stab: v(-5.48, 0.35),
  stabArea: 5.48,
  ...stabCoeffs(4.02, 5.48, 0),
  // sin deriva: solo el timón de coma del 504K (0,92 m², compensado)
  fin: v(-6.34, 0.48),
  finArea: 0.92,
  // (cabeza fija: solo cuenta `base`, la inclinación del eje respecto al fuselaje)
  head: { base: 4, aft: 6, fwd: 6 },
  // estimado: los 558 kg del 504K vacío, más el aceite de ricino, menos las alas y más el rotor, el mástil y
  // los largueros de los alerones; lleno y con el piloto da ~860 kg (900 de «peso total» en la ficha)
  emptyMass: 690,
  fuelMass: 60,
  mtow: 900,
  // fuselaje de tela con el piloto asomado, tren de patín con montantes y cables, mástil con montantes,
  // largueros de los alerones y el capó del rotativo (estimada para la máxima de ~100-110 km/h)
  cdA: 0.95,
  engine: LE_RHONE_9J,
  // 4 palas de madera y tela de ~0,61 m de cuerda (plano de la réplica; Flight da 2 ft 7 in de media en la
  // original): solidez 0,14, ~140 rpm en vuelo (Flight: 264 ft/s en la punta); ~4,5 kg/m → ~1000 kg·m² (estimado).
  // Paso de 4,5° para esas vueltas; con la resistencia de perfil algo baja (0,0095) le alcanzan los 110 CV para
  // subir ~1 m/s y llegar a ~115 km/h (ajustado, sin datos de subida)
  rotor: {
    ...DEFAULT_ROTOR,
    radius: 5.49,
    chord: 0.61,
    blades: 4,
    pitch: 4.5 * (Math.PI / 180),
    precone: 3 * (Math.PI / 180),
    inertia: 1000,
    rootCutout: 0.75,
    liftSlope: 5.6,
    cd0: 0.0095,
    cd2: 0.3,
  },
  propPitch: 1,
  propCoef: { ct0: 0.1, cp0: 0.06, j0: 1.0, j1: 1.1 },
  propBlades: 2,
  // el rotativo gira a derechas visto desde la cabina: con gas alabea a la izquierda
  propSpin: 1,
  // sin prerrotador: cuatro hombres tiran (~250 N cada uno) de 30 m de cuerda enrollada en tacos a 0,61 m del
  // eje (Flight, 22-10-1925); lleva el rotor a ~53 rpm en ~16 s (fuerza, cuerda y carrera de los hombres estimadas)
  ropeStart: { force: 1000, radius: 0.61, length: 30, speed: 8 },
  rpmScale: 0.4,
  inertia: [480, 1000, 1150],
  body: { vertCdA: 4.5, vertCP: v(-2.0, -0.1), sideCdA: 5.0, sideCP: v(-1.6, 0.1) },
  tailWheelSteer: 0,
  gearScale: 1.6,
  wheelRadius: 0.35,
  headFixed: true,
  // el 504K no llevaba frenos: frena el patín de cola
  brakeMu: 0,
  rollTrim: 0,
  seats: 1,
  groundAssist: true,
  // alerones enteros de 0,78 × 2,14 m en las puntas de los largueros (de 1,75 a 3,89 m del eje): sin
  // superficie hasta `root`; cada uno es una placa de alargamiento ~2,7
  wing: {
    area: 3.34,
    span: 7.78,
    root: 1.75,
    taper: 1,
    ac: v(0.115, -0.3),
    incidence: 0,
    dihedral: 0,
    cl0: 0,
    clMax: 1.0,
    clMin: -1.0,
    liftSlope: 3.2,
    cd0: 0.02,
    oswald: 0.45,
    cm0: 0,
    // (enteros: ~20° de ángulo efectivo a fondo, estimado)
    aileron: 20,
    aileronFrom: 0,
    rotorWash: 0,
  },
  // (la profundidad del 504K, grande: con ella baja casi en vertical a 20-40 km/h, como en Farnborough)
  elevator: 12,
  wreck: wreckZones(-3.0, 0.53, -1.56, 0.5, -0.25, 0.75, 2.07),
  crashPoints: [
    { name: 'motor', p: v(1.77, 0.74) },
    { name: 'motor', p: v(1.77, 0.2, -0.54) },
    { name: 'motor', p: v(1.77, 0.2, 0.54) },
    { name: 'motor', p: v(1.74, -0.29) },
    { name: 'panza', p: v(1.07, -0.38) },
    { name: 'panza', p: v(-1.93, -0.37) },
    { name: 'costado izquierdo', p: v(0.07, 0.1, -0.5) },
    { name: 'costado derecho', p: v(0.07, 0.1, 0.5) },
    { name: 'ala izquierda', p: v(0.01, -0.3, -3.89) },
    { name: 'ala derecha', p: v(0.01, -0.3, 3.89) },
    { name: 'pilón', p: v(-0.25, 1.71) },
    { name: 'estabilizador', p: v(-6.13, 0.35, -2.01) },
    { name: 'estabilizador', p: v(-6.13, 0.35, 2.01) },
    { name: 'deriva', p: v(-6.13, 1.04) },
    { name: 'deriva', p: v(-6.89, 0.47) },
  ],
}

/**
 * BellComm C-44 MEDEVAC (2015-2016): el autogiro ambulancia que BellComm Information Systems (Madrid) y
 * Celier Aviation sacaron del Xenon IV CA-22 (después, Xenon IV CA-22 / C-44 MEDEVAC de FlyArgo). Cabina
 * de carbono con los dos sitios lado a lado: el piloto a la IZQUIERDA y, en vez del asiento derecho, la
 * camilla, que entra por la puerta delantera; dos contenedores laterales con las patas del tren, dos
 * vigas hasta dos derivas con timón y un estabilizador alto con las puntas dobladas hacia abajo.
 * Calcado sobre una foto lateral de FlyArgo y el plano en planta de BellComm (blender/build_c44.py).
 * Hoja de tipo DAeC 61208.1 (Xenon IV CA-22): 5,65 m de largo, 2,80 m de alto, 2,32 m de ancho, rotor de
 * 8,80 m, 560 kg de máximo, cabeza 19° atrás y 2° adelante, VNE 210 km/h, 180 km/h a potencia continua.
 * BellComm: 320 kg en vacío, 2 plazas (piloto y camilla), 160 km/h de crucero, 185 de máxima, 800 ft/min,
 * despegue en 50-100 m. FlyArgo: 200 km/h y 1200 ft/min. El pasajero del menú es el herido en la camilla
 * (a la derecha); volando solo, el peso del piloto lleva el CG a la izquierda.
 * CG: la hoja de tipo lo da entre 2121 y 2344 mm del morro (0,03-0,25 m por delante del eje del rotor);
 * aquí, como en el resto, 0,33 m por delante del buje y 0,85 m sobre el eje de las ruedas.
 */
export const C44: Airframe = {
  id: 'c44',
  wreck: wreckZones(-1.3, -0.414, -0.928, 0.6, -0.25, 0.62, -1.25),
  hub: v(-0.25, 1.826),
  headPivot: v(-0.22, 1.626),
  // Kaspar KA 2/3 tripala de 1,72 m con cono
  prop: v(-1.25, 0.367),
  propRadius: 0.86,
  cg: CG_COMMON.clone(),
  noseWheel: v(1.465, -0.928),
  mainL: v(-0.414, -0.928, -0.98),
  mainR: v(-0.414, -0.928, 0.98),
  // final de las vigas de cola (lo primero que toca al encabritar, a 11,5°)
  tail: v(-3.11, -0.38),
  // estabilizador alto de 2,32 m y 0,945 m de cuerda (2,19 m²) con aletas de 0,31 m hacia abajo en las puntas
  stab: v(-2.63, 0.374),
  stabArea: 2.19,
  ...stabCoeffs(2.32, 2.19, 0.31),
  // dos derivas con timón (0,64 m² cada una) y las dos aletas de las puntas (0,14 m² cada una)
  fin: v(-3.0, 0.05),
  finArea: 1.56,
  // palanca centrada a ~105 km/h; tope trasero en 14,5° (a fondo atrás y sin motor baja estable a ~35 km/h)
  head: { base: 6.1, aft: 8.4, fwd: 8.2 },
  // 320 kg en vacío (BellComm, con la camilla); 70 de los 85 l; 560 kg de máximo
  emptyMass: 320,
  fuelMass: 50,
  mtow: 560,
  // cabina cerrada con dos contenedores laterales, dos vigas y una cola grande
  cdA: 0.55,
  engine: CELIER_912ULST,
  // 8,80 m de diámetro y 20 cm de cuerda
  rotor: { ...DEFAULT_ROTOR, radius: 4.4, chord: 0.2, inertia: 190 },
  // con más paso que la de los Rotax: a pleno gas y parado, 5050 rpm de motor (2060 de hélice en la hoja de tipo)
  propPitch: 1.28,
  wheelRadius: 0.178,
  // piloto a la izquierda, herido a la derecha
  seatZ: { pilot: -0.23, passenger: 0.23 },
  crashPoints: [
    { name: 'morro', p: v(2.125, -0.246) },
    { name: 'panza', p: v(1.2, -0.477) },
    { name: 'panza', p: v(-0.2, -0.477) },
    { name: 'costado izquierdo', p: v(0.4, -0.15, -0.58) },
    { name: 'costado derecho', p: v(0.4, -0.15, 0.58) },
    { name: 'contenedor izquierdo', p: v(-0.25, -0.35, -1.16) },
    { name: 'contenedor derecho', p: v(-0.25, -0.35, 1.16) },
    { name: 'mástil', p: v(-0.15, 1.65) },
    { name: 'viga de cola', p: v(-3.11, -0.38, -0.68) },
    { name: 'viga de cola', p: v(-3.11, -0.38, 0.68) },
    { name: 'estabilizador', p: v(-2.85, 0.37, -1.16) },
    { name: 'estabilizador', p: v(-2.85, 0.37, 1.16) },
    { name: 'deriva lateral', p: v(-3.1, 0.036, -1.16) },
    { name: 'deriva lateral', p: v(-3.1, 0.036, 1.16) },
    { name: 'deriva', p: v(-3.612, -0.129, -0.68) },
    { name: 'deriva', p: v(-3.612, -0.129, 0.68) },
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
  vencejo: VENCEJO,
  tractor: TRACTOR,
  wa116: WA116,
  sigilo: SIGILO,
  wilford: WILFORD,
  cierva_c19: CIERVA_C19,
  cierva_c6: CIERVA_C6,
  c44: C44,
}

/** Geometría de vuelo del aparato del catálogo (la genérica si no tiene una propia). */
export function airframeById(id: string, floats = false): Airframe {
  const af = AIRFRAMES[id] ?? GENERIC
  // (con flotadores: la variante del juego anfibio, si el aparato lo tiene; floatKit.ts)
  return floats ? withFloats(af) : af
}
