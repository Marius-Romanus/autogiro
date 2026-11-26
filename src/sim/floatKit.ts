// Flotadores opcionales (menú → «Con flotadores», como el pasajero): solo para los aparatos que los han
// llevado de verdad, con fotos que lo prueben.
//
//  - AutoGyro Cavalon → «Cavalon Amphib»: flotadores anfibios con ruedas que suben y bajan con aire
//    comprimido (certificado en Canadá; fotos de C-FGYE).
//  - AutoGyro MT-03 → AutoGyro los ofrecía para el MT-03; las fotos son del mismo juego de la casa en su
//    sucesor, el MTOsport («MTOamphib», Suecia). Suplemento del manual sueco del MTOsport con flotadores:
//    500 kg de máximo, 1,5 m/s de subida con dos a bordo y ~500 m de carrera en el agua.
//
// Los otros del catálogo no tienen esa opción: no hay fotos de ninguno con flotadores (el C.30A «Sea
// Rota» de 1935 salió en noticiarios, pero no hemos encontrado una imagen de cómo eran). El Wilford XOZ-1
// lleva sus flotadores de serie (en su ficha, airframes.ts).
//
// El juego cambia la ficha del aparato (`withFloats`): flotadores para el agua (sim/hydro.ts), peso y
// resistencia del juego, y el tren: las ruedas anfibias (bajadas) son los apoyos de la ficha y suben
// `retract` metros dentro del flotador al recogerlas; con el tren arriba apoya en las quillas.

import { Vector3 } from 'three'
import type { Airframe, CrashPoint } from './airframes.ts'
import type { FloatSpec } from './hydro.ts'

export interface FloatKit {
  /** los dos flotadores (proa, popa, radio y timón de agua) */
  floats: FloatSpec[]
  /** kg que añade el juego (flotadores, montantes, ruedas anfibias, bomba) y masa máxima con él */
  mass: number
  mtow?: number
  /** resistencia en el aire que añade (m² de placa plana) */
  cdA: number
  /** quillas: apoyos con el tren recogido (bajo la proa y la popa de cada flotador) */
  keels: Vector3[]
  /**
   * Tren anfibio, ruedas bajadas: apoyos de las principales y de proa (`nose`, en medio, para lo que pide
   * una sola rueda de morro; `noses`, las dos de verdad, una en cada proa: con un solo apoyo en medio, al
   * frenar volcaba de lado), radio, cuánto suben al recogerlas y dónde están todas las ruedas (para la
   * resistencia en el agua si se amariza con ellas fuera).
   */
  amphib?: { mainL: Vector3; mainR: Vector3; nose: Vector3; radius: number; retract: number; wheels: Vector3[]; noses?: Vector3[] }
  /** puntos de la célula que desaparecen con el juego (carenados de las ruedas, patas) */
  dropCrash?: RegExp
  /** puntos que añade (proas, travesaños) */
  crashPoints?: CrashPoint[]
  /** momentos de inercia que suma (alabeo, guiñada, cabeceo; kg·m², para 400 kg como los de la ficha) */
  inertia?: [number, number, number]
  /**
   * Rigidez del tren respecto a la de los autogiros actuales: las ruedas anfibias van en patas cortas y
   * rígidas dentro del flotador, no en el arco de fibra del tren de serie, y el aparato pesa más (con la
   * rigidez de serie y el CG tan alto, al frenar despacio con el piloto sentado a un lado volcaba)
   */
  gearScale?: number
}

const v = (x: number, y: number, z = 0) => new Vector3(x, y, z)

/**
 * Par de flotadores para la física: cilindros del volumen de los del modelo (radio equivalente con la
 * proa y la popa estrechadas de `floatSections`), con el eje a la altura de la quilla del redán más el
 * radio, nivelados, y el fondo de proa planeando con 3,5° (`forebodyTrim`, como en el Wilford).
 */
function pair(o: { bow: number; stern: number; step: number; keel: number; z: number; radius: number; rudder: number }): FloatSpec[] {
  const y = o.keel + o.radius
  const f = (name: string, z: number): FloatSpec => ({ name, bow: v(o.bow, y, z), stern: v(o.stern, y, z), radius: o.radius, rudder: o.rudder, step: o.step, forebodyTrim: 0.06 })
  return [f('flotador izquierdo', -o.z), f('flotador derecho', o.z)]
}

/** Puntos a ambos lados (z y −z). */
const both = (x: number, y: number, z: number) => [v(x, y, -z), v(x, y, z)]

/**
 * Juegos de flotadores por id del catálogo. Medidas de los modelos `<id>_floats.glb` (blender/floatkit.py,
 * calcados sobre las fotos). El empuje se pone bajo el CG del simulador, que por el criterio común va
 * ~0,33 m por delante del real: en el Cavalon eso adelanta los flotadores de la física 0,40 m respecto a
 * los dibujados (su centro de volumen quedaba 0,56 m por detrás del CG y flotaba de morro); en el MT-03 los
 * dibujados ya caen ahí. Las quillas y las ruedas, donde están dibujadas.
 */
export const FLOAT_KITS: Record<string, FloatKit> = {
  // Cavalon Amphib (C-FGYE): flotadores de 4,69 m y 0,53 m³ cada uno (1066 kg de empuje), redán 0,47 m por
  // detrás del origen, ruedas que suben 0,25 m; 365 kg en vacío frente a 290 (+75), hasta 600 kg
  cavalon: {
    floats: pair({ bow: 1.736 + 0.4, stern: -2.95 + 0.4, step: -0.47 + 0.4, keel: -1.435, z: 0.86, radius: 0.219, rudder: 0.047 }),
    mass: 75,
    mtow: 600,
    cdA: 0.2,
    keels: [...both(-0.47, -1.435, 0.86), ...both(1.386, -1.256, 0.86)],
    amphib: {
      mainL: v(-0.72, -1.565, -0.86),
      mainR: v(-0.72, -1.565, 0.86),
      nose: v(1.15, -1.565, 0),
      radius: 0.16,
      retract: 0.248,
      wheels: [...both(-0.72, -1.565, 0.86), ...both(1.15, -1.565, 0.86)],
      noses: both(1.15, -1.565, 0.86),
    },
    dropCrash: /^carenado/,
    inertia: [45, 30, 30],
    gearScale: 1.5,
  },
  // MT-03 con el juego anfibio de AutoGyro (fotos del MTOamphib): flotadores de 4,40 m y 0,35 m³ cada uno
  // (701 kg de empuje: poco margen, como en un ultraligero), redán casi bajo el CG, ruedas que suben 0,22 m;
  // +45 kg (MTOamphib 300 kg frente a 255 del MTOsport); 500 kg de máximo (suplemento sueco del manual)
  mt03: {
    floats: pair({ bow: 2.04, stern: -2.36, step: -0.031, keel: -1.294, z: 0.86, radius: 0.183, rudder: 0.042 }),
    mass: 45,
    mtow: 500,
    cdA: 0.2,
    keels: [...both(-0.031, -1.294, 0.86), ...both(1.69, -1.149, 0.86)],
    amphib: {
      mainL: v(-0.271, -1.424, -0.86),
      mainR: v(-0.271, -1.424, 0.86),
      nose: v(1.48, -1.424, 0),
      radius: 0.125,
      retract: 0.223,
      wheels: [...both(-0.271, -1.424, 0.86), ...both(1.48, -1.424, 0.86)],
      noses: both(1.48, -1.424, 0.86),
    },
    dropCrash: /^carenado/,
    inertia: [30, 20, 20],
    gearScale: 1.5,
  },
}

const variants = new WeakMap<Airframe, Airframe>()

/** La ficha del aparato con su juego de flotadores (la misma ficha si no tiene). Siempre el mismo objeto. */
export function withFloats(af: Airframe): Airframe {
  const k = FLOAT_KITS[af.id]
  if (!k) return af
  let out = variants.get(af)
  if (out) return out
  const [ix, iy, iz] = af.inertia ?? [320, 470, 540]
  const [ax, ay, az] = k.inertia ?? [0, 0, 0]
  const crash = af.crashPoints.filter((c) => !k.dropCrash?.test(c.name)).concat(k.crashPoints ?? [])
  out = {
    ...af,
    floats: k.floats,
    emptyMass: af.emptyMass + k.mass,
    mtow: k.mtow ?? af.mtow,
    cdA: af.cdA + k.cdA,
    keels: k.keels,
    crashPoints: crash,
    inertia: [ix + ax, iy + ay, iz + az],
    gearScale: k.gearScale ?? af.gearScale,
    ...(k.amphib
      ? {
          mainL: k.amphib.mainL,
          mainR: k.amphib.mainR,
          noseWheel: k.amphib.nose,
          wheelRadius: k.amphib.radius,
          amphib: { retract: k.amphib.retract, wheels: k.amphib.wheels, radius: k.amphib.radius, noses: k.amphib.noses },
        }
      : { keelGear: true }),
  }
  variants.set(af, out)
  return out
}

/** El aparato admite el juego de flotadores del menú. */
export function hasFloatKit(id: string): boolean {
  return id in FLOAT_KITS
}
