// Catálogo de aparatos (modelos 3D) que se pueden elegir en el menú.
//
// Todos cumplen el contrato de nodos de DESARROLLO.md, «Modelos externos» (rotor, rotor_head, prop, rudder, ruedas,
// stick, pilotos, eye_front) y comparten buje, rotor y centro de gravedad. La posición de
// ruedas, hélice y cola de cada uno, y su peso, resistencia y motor (el que anuncia su `note`),
// están en src/sim/airframes.ts (misma `id`): si se
// redibuja un modelo hay que volver a medirlo con `node tools/model-geom.mjs <glb>`, actualizar
// esa ficha y pasar `npm run fdm-test:all`. Un aparato sin ficha vuela con la del genérico.

import { has, t } from '../i18n.ts'

export interface AircraftModel {
  id: string
  /** nombre en el menú */
  name: string
  /** ruta del GLB relativa a public/ */
  url: string
  /** línea de detalle bajo el selector */
  note: string
}

export const AIRCRAFT: AircraftModel[] = [
  {
    id: 'generic',
    name: 'Tándem abierto genérico',
    url: 'models/autogiro.glb',
    note: 'Biplaza abierto tipo MTOsport · blender/build_autogiro.py',
  },
  {
    id: 'ela07',
    name: 'ELA 07 Cougar',
    url: 'models/ela07.glb',
    note: 'ELA Aviación (Córdoba) · tándem abierto · Rotax 914 · blender/build_ela.py',
  },
  {
    id: 'ela10',
    name: 'ELA 10 Eclipse',
    url: 'models/ela10.glb',
    note: 'ELA Aviación (Córdoba) · cabina cerrada en tándem, cola alta · Rotax 914 · blender/build_ela.py',
  },
  {
    id: 'cierva',
    name: 'Cierva C.30A (1934)',
    url: 'models/cierva_c30a.glb',
    note: 'Homenaje a Juan de la Cierva, inventor del autogiro · rotor tripala de mando directo, motor radial, sin timón · réplica del Museo del Aire · blender/build_cierva.py',
  },
]

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
