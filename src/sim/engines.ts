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
