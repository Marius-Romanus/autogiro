// Motores. El par en el cigüeñal a pleno gas es una parábola a cada lado del régimen
// de par máximo; las RPM salen en `autogyro.ts` del equilibrio con el par que absorbe
// la hélice (Rotax: reductora 2,43:1 y tripala de 1,72 m con el paso que fija cada
// aparato; el radial del Cierva mueve directamente una bipala de madera).

/** Escala del cuentarrevoluciones (HUD): fondo de escala, marcas y arcos de color. */
export interface TachSpec {
  max: number
  /** marca grande cada `step` rpm (número = rpm/1000) y pequeña cada `minor` */
  step: number
  minor: number
  green: [number, number]
  yellow: [number, number]
  red: number
}

export interface EngineSpec {
  id: string
  name: string
  /** potencia máxima (W) al régimen máximo (5800 rpm) */
  maxPower: number
  /** par máximo (N·m) y régimen al que se da */
  torquePeak: number
  rpmPeak: number
  /** caída del par por debajo y por encima de ese régimen (N·m por rpm²) */
  dropBelow: number
  dropAbove: number
  /** fracción del par máximo que da con el gas cerrado (ralentí) */
  idle: number
  /**
   * Un atmosférico da potencia en proporción a la densidad del aire. Un turbo a
   * pleno gas mantiene la presión de admisión, y con ella toda la potencia, hasta
   * su altitud crítica (densidad `rhoCrit`) y por encima la pierde en proporción;
   * con el gas cerrado no sopla y respira como un atmosférico.
   */
  turbo: boolean
  rhoCrit: number
  /** reductora: vueltas del cigüeñal por vuelta de la hélice (1 = toma directa) */
  gear: number
  /** régimen a partir del cual el limitador corta (o el motor ya no da más) */
  rpmLimit: number
  /** por debajo de este régimen ayuda el motor de arranque */
  starterRpm: number
  /** ralentí en tierra y régimen típico de crucero (para colocar el aparato) */
  idleRpm: number
  cruiseRpm: number
  /** rozamiento interno en el cigüeñal: a + b·rpm (N·m) */
  friction: [number, number]
  /** inercia del motor y la hélice vista desde la hélice (kg·m²) */
  inertia: number
  /** cilindros de cuatro tiempos (sonido: explosiones por vuelta = cilindros / 2) */
  cylinders: number
  tach: TachSpec
}

const ROTAX_COMMON = {
  gear: 2.43,
  rpmLimit: 5900,
  starterRpm: 900,
  idleRpm: 1400,
  cruiseRpm: 4400,
  friction: [8, 0.0035] as [number, number],
  inertia: 0.42,
  cylinders: 4,
  tach: { max: 7000, step: 1000, minor: 500, green: [1400, 5500], yellow: [5500, 5800], red: 5800 } as TachSpec,
}

/** Rotax 912 ULS: atmosférico, 100 CV (73,5 kW) a 5800 rpm, 128 N·m a 5100 rpm. */
export const ROTAX_912ULS: EngineSpec = {
  id: '912uls',
  name: 'Rotax 912 ULS',
  maxPower: 73500,
  torquePeak: 128,
  rpmPeak: 5100,
  dropBelow: 2.8e-6,
  dropAbove: 1.4e-5,
  idle: 0.235,
  turbo: false,
  rhoCrit: 1.225,
  ...ROTAX_COMMON,
}

/**
 * Rotax 914 UL: turbo, 115 CV (84,5 kW) a 5800 rpm en despegue, 144 N·m a 4900 rpm.
 * Mantiene la potencia de despegue hasta unos 2450 m (ρ ≈ 0,96 kg/m³).
 */
export const ROTAX_914UL: EngineSpec = {
  id: '914ul',
  name: 'Rotax 914 UL',
  maxPower: 84500,
  torquePeak: 144,
  rpmPeak: 4900,
  dropBelow: 2.8e-6,
  dropAbove: 6.05e-6,
  // mismo par al ralentí que el 912
  idle: 0.209,
  turbo: true,
  rhoCrit: 0.96,
  ...ROTAX_COMMON,
}

/**
 * Rotax 915 iS (ELA Gyro Tractor): turbo con intercooler e inyección, 141 CV (104 kW) en despegue a
 * 5800 rpm y 135 CV continuos, reductora de 2,54:1. Rotax no publica el par: con 104 kW a 5800 rpm
 * son 171 N·m, y en banco dan ~176 N·m con una curva plana (máximo hacia 5000 rpm). Mantiene la
 * potencia de despegue hasta 15 000 ft (4572 m, ρ ≈ 0,77 kg/m³).
 */
export const ROTAX_915IS: EngineSpec = {
  id: '915is',
  name: 'Rotax 915 iS',
  maxPower: 104000,
  torquePeak: 175,
  rpmPeak: 5000,
  dropBelow: 2.8e-6,
  dropAbove: 6.25e-6,
  // el mismo par al ralentí que el 914
  idle: 0.171,
  turbo: true,
  rhoCrit: 0.77,
  ...ROTAX_COMMON,
  gear: 2.54,
}

/**
 * Impulsor de plasma magnetohidrodinámico (Sigilo SX-1): FICCIÓN. El aire de dos tomas pasa por una
 * etapa de compresor (escondida en la cabina), se ioniza y lo aceleran anillos de imanes
 * superconductores. 220 kW (300 CV), par casi plano, sin reductora; como un turbo, mantiene la
 * potencia hasta ~5000 m. El «cuentavueltas» es el del compresor.
 */
export const PLASMA_MHD: EngineSpec = {
  id: 'plasma-mhd',
  name: 'Impulsor de plasma MHD',
  maxPower: 219000,
  torquePeak: 240,
  rpmPeak: 8000,
  dropBelow: 1.0e-6,
  dropAbove: 4e-6,
  idle: 0.12,
  turbo: true,
  rhoCrit: 0.74,
  gear: 1,
  rpmLimit: 9200,
  starterRpm: 1500,
  idleRpm: 2000,
  cruiseRpm: 7000,
  friction: [2, 0.0004],
  inertia: 0.08,
  // (sonido: un silbido agudo en vez de explosiones)
  cylinders: 24,
  tach: { max: 10000, step: 1000, minor: 500, green: [2000, 8800], yellow: [8800, 9000], red: 9000 },
}

/**
 * McCulloch 4318A (Wallis WA-116 Agile): el motor de los blancos aéreos del ejército de EE. UU.
 * (O-100-1), cuatro cilindros opuestos de dos tiempos refrigerados por aire, 1,63 l, 35 kg. 72 CV
 * (54 kW) a 4100 rpm en toma directa: la hélice gira a las vueltas del motor. Cuatro cilindros de dos
 * tiempos dan las explosiones por vuelta de ocho de cuatro tiempos (de ahí `cylinders`).
 */
export const MCCULLOCH_4318A: EngineSpec = {
  id: 'mcculloch-4318a',
  name: 'McCulloch 4318A',
  maxPower: 53700,
  torquePeak: 128,
  rpmPeak: 3700,
  dropBelow: 9.7e-6,
  dropAbove: 1.9e-5,
  idle: 0.2,
  turbo: false,
  rhoCrit: 1.225,
  gear: 1,
  rpmLimit: 4300,
  starterRpm: 900,
  idleRpm: 1800,
  cruiseRpm: 3600,
  friction: [3, 0.001],
  inertia: 0.3,
  cylinders: 8,
  tach: { max: 5000, step: 1000, minor: 500, green: [1800, 4100], yellow: [4100, 4200], red: 4200 },
}

/**
 * Armstrong Siddeley Genet Major IA (Cierva C.30A): radial de 7 cilindros, 7,3 l, atmosférico y
 * de toma directa. 140 CV (104 kW) a 2200 rpm según Flight (1934); la libreta del motor que probó
 * la RAE daba 152 CV a 2420 rpm (ARC R&M 1859). Par máximo ~460 N·m hacia 2000 rpm. Al ralentí
 * gira a unas 600 rpm.
 */
export const GENET_MAJOR: EngineSpec = {
  id: 'genet-major-ia',
  name: 'Armstrong Siddeley Genet Major IA',
  maxPower: 104400,
  torquePeak: 460,
  rpmPeak: 2000,
  dropBelow: 9.4e-5,
  dropAbove: 1.75e-4,
  idle: 0.2,
  turbo: false,
  rhoCrit: 1.225,
  gear: 1,
  rpmLimit: 2450,
  starterRpm: 350,
  idleRpm: 600,
  cruiseRpm: 1950,
  friction: [20, 0.012],
  inertia: 5,
  cylinders: 7,
  tach: { max: 3000, step: 500, minor: 100, green: [1000, 2200], yellow: [2200, 2400], red: 2400 },
}

/**
 * Armstrong Siddeley Genet Major I (Cierva C.19, 1929-32): radial de 5 cilindros con los mismos
 * cilindros que el IA de 7 (108 × 114,3 mm), 5,2 l, atmosférico y de toma directa. Flight (15-11-1934,
 * tabla de motores británicos): 100 CV normales a 2200 rpm y 110 de máxima; la cifra que dan Jackson y
 * Wikipedia es 105 CV (la de `maxPower`). Par: el del IA por 5/7 (~330 N·m hacia 2000 rpm), que da
 * 100 CV a 2200 y ~105 a 2420. Ralentí y escala del cuentavueltas, los del IA.
 */
export const GENET_MAJOR_I: EngineSpec = {
  id: 'genet-major-i',
  name: 'Armstrong Siddeley Genet Major I',
  maxPower: 78300,
  torquePeak: 329,
  rpmPeak: 2000,
  dropBelow: 6.7e-5,
  dropAbove: 1.25e-4,
  idle: 0.2,
  turbo: false,
  rhoCrit: 1.225,
  gear: 1,
  rpmLimit: 2450,
  starterRpm: 350,
  idleRpm: 600,
  cruiseRpm: 1900,
  friction: [15, 0.009],
  inertia: 3.8,
  cylinders: 5,
  tach: { max: 3000, step: 500, minor: 100, green: [1000, 2200], yellow: [2200, 2400], red: 2400 },
}

/**
 * Lycoming IO-540 (Carter PAV): seis cilindros opuestos, 8,9 l, inyección, atmosférico y de toma
 * directa. 300 CV (224 kW) continuos a 2700 rpm (792 N·m); par máximo ~810 N·m hacia 2500 rpm y
 * curva plana, como todos los Lycoming de cilindrada grande. Ralentí a unas 700 rpm. Mueve una
 * pentapala propulsora de paso variable con regulador (`cspProp` en la ficha) y, en tierra, el
 * prerrotador del rotor.
 */
export const LYCOMING_IO540: EngineSpec = {
  id: 'io-540',
  name: 'Lycoming IO-540',
  maxPower: 224000,
  torquePeak: 810,
  rpmPeak: 2500,
  dropBelow: 1.1e-4,
  dropAbove: 4.5e-4,
  idle: 0.075,
  turbo: false,
  rhoCrit: 1.225,
  gear: 1,
  rpmLimit: 2750,
  starterRpm: 350,
  idleRpm: 700,
  cruiseRpm: 2500,
  friction: [30, 0.03],
  inertia: 9,
  cylinders: 6,
  tach: { max: 3000, step: 500, minor: 100, green: [700, 2700], yellow: [2700, 2700], red: 2700 },
}

/**
 * Rotax 503 UL DCDI (Sport Copter Lightning): bicilíndrico de dos tiempos refrigerado por aire,
 * 50 CV (37 kW) a 6500 rpm y 55 N·m a 6000 rpm, con reductora B de 2,58:1. Al ralentí gira a unas
 * 2000 rpm. (Dos cilindros de dos tiempos dan las mismas explosiones por vuelta que cuatro de
 * cuatro tiempos: de ahí `cylinders`.)
 */
export const ROTAX_503: EngineSpec = {
  id: '503ul',
  name: 'Rotax 503 UL',
  maxPower: 37000,
  torquePeak: 56,
  rpmPeak: 6000,
  dropBelow: 1.6e-6,
  dropAbove: 6.4e-6,
  idle: 0.25,
  turbo: false,
  rhoCrit: 1.225,
  gear: 2.58,
  rpmLimit: 6800,
  starterRpm: 1300,
  idleRpm: 2000,
  cruiseRpm: 5600,
  friction: [2, 0.0008],
  inertia: 0.27,
  cylinders: 4,
  tach: { max: 8000, step: 1000, minor: 500, green: [2000, 6500], yellow: [6500, 6800], red: 6800 },
}

/**
 * Kinner R-5 (Wilford XOZ-1): radial de 5 cilindros, 6,4 l, atmosférico y de toma directa a una
 * bipala de madera. 155 CV (116 kW) a 1975 rpm según la ficha de Aero Digest (1935); par máximo
 * ~580 N·m algo por debajo, hacia 1850 rpm. Al ralentí, unas 550 rpm; crucero hacia 1800 rpm.
 */
export const KINNER_R5: EngineSpec = {
  id: 'kinner-r5',
  name: 'Kinner R-5',
  maxPower: 115600,
  torquePeak: 580,
  rpmPeak: 1850,
  dropBelow: 9.4e-5,
  dropAbove: 1.75e-4,
  idle: 0.2,
  turbo: false,
  rhoCrit: 1.225,
  gear: 1,
  rpmLimit: 2200,
  starterRpm: 300,
  idleRpm: 550,
  cruiseRpm: 1800,
  friction: [24, 0.014],
  inertia: 6,
  cylinders: 5,
  tach: { max: 2500, step: 500, minor: 100, green: [900, 1975], yellow: [1975, 2050], red: 2050 },
}

/**
 * Le Rhône 9J (Cierva C.6): ROTATIVO de 9 cilindros (cilindros y cárter giran con la hélice alrededor
 * del cigüeñal fijo), 15 l (112 × 170 mm), 146 kg en seco y aceite de ricino a pérdida total. 110 CV
 * (82 kW) a 1200 rpm según la ficha del Museo del Aire y Wikipedia (9Ja); par casi plano, ~660 N·m hacia
 * 1150 rpm (estimado con esa potencia). Toma directa a una bipala de madera. Se gobernaba con el gas y
 * la palanca de mezcla, y en tierra con el interruptor de corte («blip»): aquí, ralentí a unas 380 rpm.
 * Inercia grande: casi todo el motor (~110 kg a ~0,3 m del eje) gira con la hélice (estimada).
 */
export const LE_RHONE_9J: EngineSpec = {
  id: 'le-rhone-9j',
  name: 'Le Rhône 9J',
  maxPower: 82000,
  torquePeak: 660,
  rpmPeak: 1150,
  dropBelow: 4.6e-4,
  dropAbove: 3.2e-3,
  idle: 0.25,
  turbo: false,
  rhoCrit: 1.225,
  gear: 1,
  rpmLimit: 1350,
  starterRpm: 150,
  idleRpm: 380,
  cruiseRpm: 1150,
  friction: [30, 0.04],
  inertia: 15,
  cylinders: 9,
  tach: { max: 1600, step: 200, minor: 50, green: [900, 1250], yellow: [1250, 1300], red: 1300 },
}

/**
 * Celier CA 912 ULST (BellComm C-44 MEDEVAC, Celier Xenon IV): el Rotax 912 ULS con un turbo de Celier
 * Aviation (válvula de descarga neumática, dos carburadores, intercooler) y la reductora de serie de
 * 2,43:1. Hoja de datos de tipo del DAeC 61208.1 (ed. 6, 2020): 107 kW a 5200 rpm de máxima y 96 kW
 * continuos a 5000 rpm; BellComm y FlyArgo lo anuncian como «Rotax 912 ULS-T de 135 CV». Rotax no
 * fabrica este motor y nadie publica su curva: el par sale de esa potencia (196 N·m a 5200 rpm), con el
 * máximo (~204 N·m) hacia 4800 rpm y cayendo por encima para que la potencia no pase de 107 kW; por
 * debajo, la forma de la del 914. Mismo par al ralentí que el 912. La altitud crítica del turbo no está
 * publicada: la del 914 (estimada).
 */
export const CELIER_912ULST: EngineSpec = {
  id: 'ca912ulst',
  name: 'Rotax 912 ULS turbo (Celier)',
  maxPower: 107000,
  torquePeak: 204,
  rpmPeak: 4800,
  dropBelow: 4.0e-6,
  dropAbove: 4.72e-5,
  idle: 0.147,
  turbo: true,
  rhoCrit: 0.96,
  ...ROTAX_COMMON,
}
