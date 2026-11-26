// Catálogo de aparatos (modelos 3D) que se pueden elegir en el menú.
//
// Todos cumplen el contrato de nodos de DESARROLLO.md, «Modelos externos» (rotor, rotor_head, prop, rudder, ruedas,
// stick, pilotos, eye_front) y comparten buje, rotor y centro de gravedad. La posición de
// ruedas, hélice y cola de cada uno, y su peso, resistencia y motor (el que anuncia su `note`),
// están en src/sim/airframes.ts (misma `id`): si se
// redibuja un modelo hay que volver a medirlo con `node tools/model-geom.mjs <glb>`, actualizar
// esa ficha y pasar `npm run fdm-test:all`. Un aparato sin ficha vuela con la del genérico.

import { addStrings, has, t } from '../i18n.ts'

export interface AircraftModel {
  id: string
  /** nombre en el menú */
  name: string
  /** ruta del GLB relativa a public/ */
  url: string
  /** año del primer vuelo o de su presentación (los inventados, el de su ficción, siempre futuro): el menú
   *  los ordena del más antiguo al más nuevo, así que los inventados quedan los últimos */
  year: number
  /** el mismo aparato con su juego de flotadores (menú «Con flotadores»; src/sim/floatKit.ts) */
  floatsUrl?: string
  /** línea de detalle bajo el selector */
  note: string
  /** etiqueta, descripción corta y fabricante de su tarjeta del menú (menu/menuUi.ts) */
  tag?: string
  short?: string
  maker?: string
  /** lo mismo en inglés (los aparatos anteriores lo llevan en i18n.ts) */
  en?: { name: string; note: string; tag: string; short: string; maker: string }
}

const LIST: AircraftModel[] = [
  {
    id: 'generic',
    name: 'Tándem abierto genérico',
    url: 'models/autogiro.glb',

    year: 2006,
    note: 'Biplaza abierto tipo MTOsport',
  },
  {
    id: 'ela07',
    name: 'ELA 07 Cougar',
    url: 'models/ela07.glb',

    year: 2005,
    note: 'ELA Aviación (Córdoba) · tándem abierto · Rotax 912',
  },
  {
    id: 'scorpion',
    name: 'ELA 07 Scorpion',
    url: 'models/scorpion.glb',

    year: 2005,
    note: 'ELA Aviación (Córdoba) · tándem abierto de morro en pico, motor carenado y dos parabrisas · Rotax 914',
    tag: 'Turbo',
    short: 'Tándem abierto, motor carenado · Rotax 914',
    maker: 'ELA Aviación · Córdoba',
    en: {
      name: 'ELA 07 Scorpion',
      note: 'ELA Aviación (Córdoba, Spain) · open tandem with a beak nose, cowled engine and two windscreens · Rotax 914',
      tag: 'Turbo',
      short: 'Open tandem, cowled engine · Rotax 914',
      maker: 'ELA Aviación · Córdoba, Spain',
    },
  },
  {
    id: 'tractor',
    name: 'ELA Gyro Tractor',
    url: 'models/tractor.glb',

    year: 2021,
    note: 'ELA Aviación (Córdoba) · fumigador monoplaza: tolva de 200 l y barras de 8,25 m con 20 boquillas, pasadas de 15 m a 110 km/h (tecla U para fumigar) · Rotax 915 iS, 141 CV',
    tag: 'Fumigador',
    short: 'Monoplaza agrícola, tolva de 200 l · 141 CV',
    maker: 'ELA Aviación · Córdoba',
    en: {
      name: 'ELA Gyro Tractor',
      note: 'ELA Aviación (Córdoba, Spain) · single-seat crop sprayer: 200 l hopper and 8.25 m booms with 20 nozzles, 15 m swaths at 110 km/h (U key to spray) · Rotax 915 iS, 141 hp',
      tag: 'Crop sprayer',
      short: 'Single-seat ag gyro, 200 l hopper · 141 hp',
      maker: 'ELA Aviación · Córdoba, Spain',
    },
  },
  {
    id: 'ela10',
    name: 'ELA 10 Eclipse',
    url: 'models/ela10.glb',

    year: 2014,
    note: 'ELA Aviación (Córdoba) · cabina cerrada en tándem, cola alta · Rotax 914',
  },
  {
    id: 'mt03',
    name: 'AutoGyro MT-03',
    url: 'models/mt03.glb',

    year: 2004,
    floatsUrl: 'models/mt03_floats.glb',
    note: 'AutoGyro (Hildesheim, Alemania) · tándem abierto, cola en U con deriva central · Rotax 912 ULS',
    tag: 'Clásico',
    short: 'Tándem abierto · Rotax 912',
    maker: 'AutoGyro · Hildesheim (Alemania)',
    en: {
      name: 'AutoGyro MT-03',
      note: 'AutoGyro (Hildesheim, Germany) · open tandem, U-shaped tail with a central fin · Rotax 912 ULS',
      tag: 'Classic',
      short: 'Open tandem · Rotax 912',
      maker: 'AutoGyro · Hildesheim, Germany',
    },
  },
  {
    id: 'calidus',
    name: 'AutoGyro Calidus',
    url: 'models/calidus.glb',

    year: 2009,
    note: 'AutoGyro (Hildesheim, Alemania) · cabina cerrada en tándem, muy afilada · Rotax 914',
    tag: 'Turbo',
    short: 'Cabina cerrada en tándem · Rotax 914',
    maker: 'AutoGyro · Hildesheim (Alemania)',
    en: {
      name: 'AutoGyro Calidus',
      note: 'AutoGyro (Hildesheim, Germany) · sleek enclosed tandem cabin · Rotax 914',
      tag: 'Turbo',
      short: 'Enclosed tandem cabin · Rotax 914',
      maker: 'AutoGyro · Hildesheim, Germany',
    },
  },
  {
    id: 'cavalon',
    name: 'AutoGyro Cavalon',
    url: 'models/cavalon.glb',

    year: 2011,
    floatsUrl: 'models/cavalon_floats.glb',
    note: 'AutoGyro (Hildesheim, Alemania) · cabina cerrada con los asientos lado a lado, piloto a la derecha · Rotax 914',
    tag: 'Lado a lado',
    short: 'Cabina cerrada, asientos lado a lado · Rotax 914',
    maker: 'AutoGyro · Hildesheim (Alemania)',
    en: {
      name: 'AutoGyro Cavalon',
      note: 'AutoGyro (Hildesheim, Germany) · enclosed cabin with side-by-side seats, pilot on the right · Rotax 914',
      tag: 'Side by side',
      short: 'Enclosed cabin, side-by-side seats · Rotax 914',
      maker: 'AutoGyro · Hildesheim, Germany',
    },
  },
  {
    id: 'c44',
    name: 'BellComm C-44 MEDEVAC',
    url: 'models/c44.glb',

    year: 2015,
    note: 'BellComm (Madrid) y Celier Aviation · autogiro ambulancia sobre el Celier Xenon IV CA-22, camuflado: piloto a la izquierda y camilla a la derecha, que entra por la puerta delantera (con pasajero, un herido en ella); contenedores laterales, dos vigas y cola en H · Rotax 912 ULS turbo, 135-145 CV',
    tag: 'Ambulancia',
    short: 'Camilla a bordo, dos vigas · 912 turbo',
    maker: 'BellComm y Celier Aviation · Madrid y Polonia',
    en: {
      name: 'BellComm C-44 MEDEVAC',
      note: 'BellComm (Madrid, Spain) and Celier Aviation · camouflaged ambulance gyroplane on the Celier Xenon IV CA-22: pilot on the left and a stretcher on the right, loaded through the front door (with a passenger, a casualty lies on it); side pods, twin booms and an H tail · turbocharged Rotax 912 ULS, 135-145 hp',
      tag: 'Ambulance',
      short: 'Stretcher on board, twin booms · 912 turbo',
      maker: 'BellComm & Celier Aviation · Madrid, Spain and Poland',
    },
  },
  {
    id: 'jro',
    name: 'DTA J-RO',
    url: 'models/jro.glb',

    year: 2011,
    note: 'DTA (Montélimar, Francia) · tándem cerrado de carbono con puertas de ala de gaviota y tres derivas · Rotax 914',
    tag: 'Turbo',
    short: 'Cabina cerrada en tándem, tres derivas · Rotax 914',
    maker: 'DTA · Montélimar (Francia)',
    en: {
      name: 'DTA J-RO',
      note: 'DTA (Montélimar, France) · enclosed carbon tandem with gull-wing doors and three fins · Rotax 914',
      tag: 'Turbo',
      short: 'Enclosed tandem cabin, three fins · Rotax 914',
      maker: 'DTA · Montélimar, France',
    },
  },
  {
    id: 'niki',
    name: 'Niki Lightning',
    url: 'models/niki.glb',

    year: 2009,
    note: 'Niki Rotor Aviation (Bulgaria) · tándem cerrado con la hélice en medio, girando alrededor del tubo de cola · Rotax 914',
    tag: 'Hélice central',
    short: 'Hélice en medio del fuselaje · Rotax 914',
    maker: 'Niki Rotor Aviation · Bulgaria',
    en: {
      name: 'Niki Lightning',
      note: 'Niki Rotor Aviation (Bulgaria) · enclosed tandem with the propeller amidships, turning round the tail boom · Rotax 914',
      tag: 'Mid propeller',
      short: 'Propeller in the middle of the fuselage · Rotax 914',
      maker: 'Niki Rotor Aviation · Bulgaria',
    },
  },
  {
    id: 'sclightning',
    name: 'Sport Copter Lightning',
    url: 'models/sclightning.glb',

    year: 1994,
    note: 'Sport Copter (Oregón, EE. UU.) · ultraligero monoplaza de bastidor abierto · Rotax 503 de dos tiempos, 50 CV',
    tag: 'Monoplaza',
    short: 'Ultraligero monoplaza abierto · Rotax 503',
    maker: 'Sport Copter · Scappoose (Oregón)',
    en: {
      name: 'Sport Copter Lightning',
      note: 'Sport Copter (Oregon, USA) · open-frame single-seat ultralight · two-stroke Rotax 503, 50 hp',
      tag: 'Single-seat',
      short: 'Open single-seat ultralight · Rotax 503',
      maker: 'Sport Copter · Scappoose, Oregon',
    },
  },
  {
    id: 'sclightning_f',
    name: 'Sport Copter Lightning carenado',
    url: 'models/sclightning_f.glb',

    year: 1994,
    note: 'Sport Copter (Oregón, EE. UU.) · el monoplaza Lightning con carenado de morro, parabrisas y techo · Rotax 503',
    tag: 'Monoplaza',
    short: 'Monoplaza con carenado y parabrisas · Rotax 503',
    maker: 'Sport Copter · Scappoose (Oregón)',
    en: {
      name: 'Sport Copter Lightning (faired)',
      note: 'Sport Copter (Oregon, USA) · the single-seat Lightning with nose fairing, windscreen and roof · Rotax 503',
      tag: 'Single-seat',
      short: 'Single-seater with fairing and windscreen · Rotax 503',
      maker: 'Sport Copter · Scappoose, Oregon',
    },
  },
  {
    id: 'carterpav',
    name: 'Carter PAV',
    url: 'models/carterpav.glb',

    year: 2014,
    note: 'Carter Aviation (Texas, EE. UU.) · compuesto de rotor lento: alas de 13,7 m, mástil basculante y despegue de salto (prerrota con frenos y todo el gas y suelta por encima de 330 rpm) · Lycoming IO-540, 300 CV',
    tag: 'Rotor lento',
    short: 'Compuesto con alas y despegue de salto · 300 CV',
    maker: 'Carter Aviation Technologies · Texas',
    en: {
      name: 'Carter PAV',
      note: 'Carter Aviation (Texas, USA) · slowed-rotor compound: 13.7 m wings, tilting mast and jump take-off (pre-rotate with brakes and full throttle, release above 330 rpm) · Lycoming IO-540, 300 hp',
      tag: 'Slowed rotor',
      short: 'Compound with wings and jump take-off · 300 hp',
      maker: 'Carter Aviation Technologies · Texas',
    },
  },
  {
    id: 'wa116',
    name: 'Wallis WA-116 Agile',
    url: 'models/wa116.glb',

    year: 1961,
    note: 'Ken Wallis (Norfolk, Reino Unido, 1961) · el prototipo G-ARRT, hermano de «Little Nellie»: monoplaza abierto diminuto con rotor de 6,20 m y cabeza de cardán desplazado, estable con las manos fuera · McCulloch 4318A de dos tiempos, 72 CV',
    tag: 'Histórico',
    short: 'Monoplaza británico de 1961 · 72 CV',
    maker: 'Wallis Autogyros · Norfolk (Reino Unido)',
    en: {
      name: 'Wallis WA-116 Agile',
      note: 'Ken Wallis (Norfolk, UK, 1961) · the prototype G-ARRT, sister of "Little Nellie": tiny open single-seater with a 6.20 m rotor and offset-gimbal head, stable hands-off · two-stroke McCulloch 4318A, 72 hp',
      tag: 'Historic',
      short: 'British single-seater from 1961 · 72 hp',
      maker: 'Wallis Autogyros · Norfolk, UK',
    },
  },
  {
    id: 'vencejo',
    name: 'Vencejo X1',
    url: 'models/vencejo.glb',

    year: 2045,
    note: 'Prototipo inventado para el simulador (hacia 2045) · tándem cerrado con cúpula de una pieza, rotor tripala, hélice carenada de 7 palas y el timón dentro de su chorro · Rotax 915 iS',
    tag: 'Futurista',
    short: 'Concepto inventado, hélice carenada · 141 CV',
    maker: 'Diseño inventado para Autogiro',
    en: {
      name: 'Vencejo X1',
      note: 'Prototype invented for the simulator (around 2045) · enclosed tandem with a one-piece canopy, three-blade rotor, 7-blade ducted fan with the rudder in its jet · Rotax 915 iS',
      tag: 'Futuristic',
      short: 'Invented concept, ducted fan · 141 hp',
      maker: 'Design invented for Autogiro',
    },
  },
  {
    id: 'sigilo',
    name: 'Sigilo SX-1',
    url: 'models/sigilo.glb',

    year: 2060,
    note: 'Prototipo furtivo inventado para el simulador (hacia 2060) · cabina de caras planas con cúpula dorada, mástil en cuchilla, alitas con dos vigas hasta una cola alta y un impulsor de plasma de ficción que brilla en una ranura de popa; rotor rígido reforzado para maniobras y ~285 km/h · 300 CV',
    tag: 'Futurista',
    short: 'Furtivo de dos vigas, ~285 km/h · 300 CV',
    maker: 'Diseño inventado para Autogiro',
    en: {
      name: 'Sigilo SX-1',
      note: 'Stealth prototype invented for the simulator (around 2060) · faceted cabin with a gold canopy, blade mast, stub wings with twin booms to a high tail and a fictional plasma drive glowing in a stern slot; stiff reinforced rotor for manoeuvres and ~285 km/h · 300 hp',
      tag: 'Futuristic',
      short: 'Stealth twin-boom, ~285 km/h · 300 hp',
      maker: 'Design invented for Autogiro',
    },
  },
  {
    // C.6bis (Brooks, «Cierva Autogiros», ap. 7; Flight 1925): el de Farnborough, con la decoración de la réplica
    // del Museo del Aire («C6.B.» en el timón)
    id: 'cierva_c6',
    name: 'Cierva C.6bis (1925)',
    url: 'models/cierva_c6.glb',

    year: 1925,
    note: 'Juan de la Cierva · el primer autogiro que se exhibió en Inglaterra (Farnborough, octubre de 1925): fuselaje de Avro 504K, rotor de cuatro palas con articulaciones de batimiento y cabeza fija, alerones en largueros, sin prerrotador (el rotor se lanza tirando de una cuerda) · Le Rhône 9J rotativo, 110 CV · réplica del Museo del Aire',
    tag: 'Histórico',
    short: 'Fuselaje de Avro 504K, cabeza fija y alerones · 110 CV',
    maker: 'Juan de la Cierva · Aviación Militar, Cuatro Vientos · 1925',
    en: {
      name: 'Cierva C.6bis (1925)',
      note: 'Juan de la Cierva · the first autogiro shown in England (Farnborough, October 1925): Avro 504K fuselage, four-blade rotor with flapping hinges on a fixed head, ailerons on outrigger spars, no prerotator (the rotor is spun up by pulling a rope) · Le Rhône 9J rotary, 110 hp · Museo del Aire replica',
      tag: 'Historic',
      short: 'Avro 504K fuselage, fixed head and ailerons · 110 hp',
      maker: 'Juan de la Cierva · Military Aviation workshops, Cuatro Vientos (Madrid) · 1925',
    },
  },
  {
    id: 'cierva_c19',
    name: 'Cierva C.19 Mk IV (1932)',
    url: 'models/cierva_c19.glb',

    year: 1932,
    note: 'Juan de la Cierva · el único C.19 que se conserva: el EC-AIM del Museo del Aire (Avro 620 n.º 5158, ex G-ABXH, del Aero Club de Sevilla desde 1932; también citado como Mk IVP, «de producción») · rotor tripala en voladizo de 34 ft que se lanza con un embrague desde el motor, cabeza fija: se gobierna con los alerones del ala, la profundidad y el timón · Genet Major I de 5 cilindros, 105 CV',
    tag: 'Histórico',
    short: 'Cabeza fija, ala con alerones y embrague de arranque · 105 CV',
    maker: 'Juan de la Cierva · Cierva Autogiro Co. y Avro (Reino Unido) · 1932',
    en: {
      name: 'Cierva C.19 Mk IV (1932)',
      note: 'Juan de la Cierva · the only surviving C.19: EC-AIM of the Museo del Aire, Madrid (Avro 620 c/n 5158, ex G-ABXH, Seville Aero Club from 1932; also listed as Mk IVP, "production") · 34 ft three-blade cantilever rotor spun up through a clutch from the engine, fixed head: flown with wing ailerons, elevator and rudder · five-cylinder Genet Major I, 105 hp',
      tag: 'Historic',
      short: 'Fixed head, ailerons and clutch rotor starter · 105 hp',
      maker: 'Juan de la Cierva · Cierva Autogiro Co. and Avro (UK) · 1932',
    },
  },
  {
    id: 'cierva',
    name: 'Cierva C.30A (1934)',
    url: 'models/cierva_c30a.glb',

    year: 1934,
    note: 'Homenaje a Juan de la Cierva, inventor del autogiro · rotor tripala de mando directo, motor radial, sin timón · réplica del Museo del Aire',
  },
  {
    id: 'wilford',
    name: 'Wilford XOZ-1 (1936)',
    url: 'models/wilford.glb',

    year: 1936,
    note: 'Pennsylvania Aircraft Syndicate (Filadelfia, EE. UU.) · hidroautogiro de pruebas de la US Navy sobre dos flotadores Edo: rotor de cuatro palas de paso cíclico, sin articulaciones de batimiento, y ala baja con alerones · Kinner R-5 radial, 155 CV',
    tag: 'Hidroautogiro',
    short: 'US Navy, 1936, sobre dos flotadores · 155 CV',
    maker: 'Pennsylvania Aircraft Syndicate · Filadelfia (EE. UU.)',
    en: {
      name: 'Wilford XOZ-1 (1936)',
      note: 'Pennsylvania Aircraft Syndicate (Philadelphia, USA) · US Navy test seaplane gyro on twin Edo floats: four-blade cyclic-pitch rotor without flapping hinges and a low wing with ailerons · Kinner R-5 radial, 155 hp',
      tag: 'Seaplane gyro',
      short: 'US Navy, 1936, on twin floats · 155 hp',
      maker: 'Pennsylvania Aircraft Syndicate · Philadelphia, USA',
    },
  },
]

/** Todos, del más antiguo al más nuevo (`year`; a igual año, en el orden de LIST). */
export const AIRCRAFT: AircraftModel[] = [...LIST].sort((a, b) => a.year - b.year)

// textos de las tarjetas de los aparatos que los llevan en su ficha
for (const a of AIRCRAFT) {
  const es: Record<string, string> = {}
  if (a.tag) es[`ac.${a.id}.tag`] = a.tag
  if (a.short) es[`ac.${a.id}.short`] = a.short
  if (a.maker) es[`ac.${a.id}.maker`] = a.maker
  addStrings('es', es)
  if (a.en)
    addStrings('en', {
      [`ac.${a.id}`]: a.en.name,
      [`ac.${a.id}.note`]: a.en.note,
      [`ac.${a.id}.tag`]: a.en.tag,
      [`ac.${a.id}.short`]: a.en.short,
      [`ac.${a.id}.maker`]: a.en.maker,
    })
}

/** Nombre y nota en el idioma de la interfaz (los de AIRCRAFT están en español). */
export function aircraftName(a: AircraftModel): string {
  return has(`ac.${a.id}`) ? t(`ac.${a.id}`) : a.name
}
export function aircraftNote(a: AircraftModel): string {
  return has(`ac.${a.id}.note`) ? t(`ac.${a.id}.note`) : a.note
}

/** GLB que se ve: con flotadores, el del juego si el aparato lo tiene. */
export function aircraftUrl(a: AircraftModel, floats: boolean): string {
  return floats && a.floatsUrl ? a.floatsUrl : a.url
}

export function aircraftById(id: string): AircraftModel {
  return AIRCRAFT.find((a) => a.id === id) ?? AIRCRAFT.find((a) => a.id === 'generic')!
}
