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
  /** línea de detalle bajo el selector */
  note: string
  /** etiqueta, descripción corta y fabricante de su tarjeta del menú (menu/menuUi.ts) */
  tag?: string
  short?: string
  maker?: string
  /** lo mismo en inglés (los aparatos anteriores lo llevan en i18n.ts) */
  en?: { name: string; note: string; tag: string; short: string; maker: string }
}

export const AIRCRAFT: AircraftModel[] = [
  {
    id: 'generic',
    name: 'Tándem abierto genérico',
    url: 'models/autogiro.glb',
    note: 'Biplaza abierto tipo MTOsport',
  },
  {
    id: 'ela07',
    name: 'ELA 07 Cougar',
    url: 'models/ela07.glb',
    note: 'ELA Aviación (Córdoba) · tándem abierto · Rotax 914',
  },
  {
    id: 'scorpion',
    name: 'ELA 07 Scorpion',
    url: 'models/scorpion.glb',
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
    id: 'ela10',
    name: 'ELA 10 Eclipse',
    url: 'models/ela10.glb',
    note: 'ELA Aviación (Córdoba) · cabina cerrada en tándem, cola alta · Rotax 914',
  },
  {
    id: 'mt03',
    name: 'AutoGyro MT-03',
    url: 'models/mt03.glb',
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
    id: 'jro',
    name: 'DTA J-RO',
    url: 'models/jro.glb',
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
    id: 'cierva',
    name: 'Cierva C.30A (1934)',
    url: 'models/cierva_c30a.glb',
    note: 'Homenaje a Juan de la Cierva, inventor del autogiro · rotor tripala de mando directo, motor radial, sin timón · réplica del Museo del Aire',
  },
]

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

export function aircraftById(id: string): AircraftModel {
  return AIRCRAFT.find((a) => a.id === id) ?? AIRCRAFT[0]
}
