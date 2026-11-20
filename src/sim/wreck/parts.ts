// Despiece estructural del autogiro para la simulación de accidentes.
//
// Cada pieza es un sólido rígido que puede ir unido a su "padre" (unión rígida
// que se rompe por fuerza o por momento flector) o, en el caso de rotor, hélice
// y ruedas, a un eje que gira libre (unión de revolución que se rompe por fuerza).
// Las cifras son las de un biplaza tipo MTOsport / ELA: palas de aluminio
// extruido de 8,4 m, hélice tripala de material compuesto de 1,72 m, tren de
// ballesta y botalón de aluminio.
//
// Coordenadas del modelo (igual que el GLB): x adelante, y arriba, z derecha,
// origen en el origen del modelo (el CG está en `CG`, de autogyro.ts).

import { Vector3 } from 'three'
import { CG, GEOM } from '../autogyro.ts'

/** Grupo rígido del modelo 3D del que sale la geometría de la pieza. */
export type PartGroup = 'airframe' | 'rotor' | 'prop' | 'wheelL' | 'wheelR' | 'wheelN'

export interface PartDef {
  id: string
  /** nombre para mensajes (con artículo) */
  name: string
  group: PartGroup
  /** padre en la unión rígida (null = raíz de su cuerpo) */
  parent: string | null
  mass: number
  /** resistencia de la unión con el padre: fuerza (N) y momento flector (N·m) */
  fMax: number
  mMax: number
  /** tiempo de respuesta estructural (s): filtra los picos de impulso de un contacto rígido */
  tau: number
  /** punto de unión con el padre (coordenadas del modelo) */
  attach: Vector3
  /** área de resistencia aerodinámica (m²) */
  cdA: number
  friction: number
  restitution: number
  /** se abolla / dobla con los golpes (rigidez de abollado, N·s por metro de hundimiento) */
  dent?: { k: number; radius: number; max: number }
  /** material, para chispas y sonido */
  material: 'composite' | 'metal' | 'rubber'
}

export interface JointDef {
  id: string
  name: string
  /** pieza del cuerpo "fijo" (fuselaje) */
  a: string
  /** pieza que gira (raíz de su propio cuerpo) */
  b: string
  /** ancla y eje en coordenadas del modelo (se rellenan al empezar el accidente) */
  anchor: Vector3
  axis: Vector3
  fMax: number
  tau: number
}

const R = 4.2 // radio del rotor
export const BLADE_ROOT = 0.35
/** límites radiales de los tramos de pala (rotura a lo largo de la envergadura) */
export const BLADE_CUTS = [BLADE_ROOT, 1.6, 2.9, R]
export const PROP_HUB_R = 0.13
export const PROP_BLADES = 3

/**
 * Lo que cambia del despiece entre aparatos: rotor (radio, palas, masa de cada pala,
 * inercia y vueltas de crucero) y hélice (palas y radio). Todo lo demás (fuselaje,
 * tren, cola) es el del genérico.
 */
export interface WreckSpec {
  rotorR: number
  blades: number
  bladeMass: number
  rotorInertia: number
  /** vueltas de crucero del rotor (rad/s) */
  rotorOmega0: number
  propBlades: number
  propR: number
  /** coeficiente de potencia de la hélice a punto fijo (P/ρn³D⁵) */
  propCp0: number
  zones?: WreckZones
}
export const GENERIC_WRECK: WreckSpec = {
  rotorR: R,
  blades: 2,
  bladeMass: 12.7,
  rotorInertia: 165,
  rotorOmega0: (352 * 2 * Math.PI) / 60,
  propBlades: PROP_BLADES,
  propR: 0.86,
  propCp0: 0.0823,
}
/** nombres de las palas del rotor (blade{A,B,C}{tramo}) */
export const BLADE_SIDES = ['A', 'B', 'C', 'D'] as const
/** palas del rotor de un despiece */
export const bladeSides = (spec: WreckSpec) => BLADE_SIDES.slice(0, spec.blades)
/** cortes de pala para un rotor de radio `r` (los del genérico, en proporción) */
export function bladeCuts(r: number): number[] {
  return r === R ? BLADE_CUTS : [BLADE_ROOT, (1.6 * r) / R, (2.9 * r) / R, r]
}

/** Plano de rotura del botalón (todo lo que queda por detrás es "cola"). */
export const TAIL_CUT_X = -2.75

/**
 * Zonas del fuselaje para trocear el GLB en piezas (coordenadas del modelo) y dónde se
 * unen a la góndola. Las del genérico valen para los ELA; el Cierva tiene las suyas
 * ('wreck' en su ficha de airframes.ts).
 */
export interface WreckZones {
  /** todo lo que queda por detrás es la cola */
  tailCutX: number
  /** patas del tren principal: x entre x0 y x1, por debajo de yMax y más afuera que zMin; raíz de la izquierda */
  gear: { x0: number; x1: number; yMax: number; zMin: number; attach: Vector3 }
  /** mástil o pilón: x entre x0 y x1, por encima de yMin y más adentro que zMax; su pie */
  mast: { x0: number; x1: number; yMin: number; zMax: number; attach: Vector3 }
  /** tramos (x) para descomponer la góndola en cascos convexos */
  podSlabs: number[]
  /** rueda de cola en vez de rueda de morro (nombres de las piezas y su unión) */
  tailWheel?: Vector3
}
export const GENERIC_ZONES: WreckZones = {
  tailCutX: TAIL_CUT_X,
  gear: { x0: -1.0, x1: 0.3, yMax: -0.4, zMin: 0.45, attach: new Vector3(-0.4, -0.74, -0.45) },
  mast: { x0: -0.62, x1: -0.02, yMin: 0.4, zMax: 0.2, attach: new Vector3(-0.38, 0.4, 0) },
  podSlabs: [TAIL_CUT_X, -1.75, -1.36, -0.62, 0.15, 0.85, 1.5, 9],
}

function v(x: number, y: number, z: number): Vector3 {
  return new Vector3(x, y, z)
}

/**
 * Lista de piezas. Masas para 395 kg (solo); la góndola absorbe la diferencia
 * con pasajero. Resistencias aproximadas:
 *  - palas: momento flector de rotura ~3 kN·m en la raíz (la pala de aluminio se
 *    dobla y se parte en cuanto muerde el suelo girando),
 *  - mástil: tubo de acero inoxidable 100×80, ~9 kN·m en el pie,
 *  - tren: ballesta de composite, ~17 kN por rueda (aguanta tomas firmes de 3 m/s),
 *  - cola: ~6 kN / 4 kN·m en el botalón.
 */
export function makePartDefs(spec: WreckSpec = GENERIC_WRECK): PartDef[] {
  const defs: PartDef[] = []
  const add = (d: Partial<PartDef> & Pick<PartDef, 'id' | 'name' | 'group' | 'mass'>) =>
    defs.push({
      parent: null,
      fMax: Infinity,
      mMax: Infinity,
      tau: 0.02,
      attach: v(0, 0, 0),
      cdA: 0.05,
      friction: 0.55,
      restitution: 0.08,
      material: 'metal',
      ...d,
    })

  // --- fuselaje ---
  const zn = spec.zones ?? GENERIC_ZONES
  const ga = zn.gear.attach
  const tw = zn.tailWheel
  // el Cierva (zonas propias): fuselaje de tubo de acero entelado, pilón de cuatro patas y tren de amortiguadores largos
  const big = spec.zones !== undefined
  add({ id: 'pod', name: big ? 'el fuselaje' : 'la góndola', group: 'airframe', mass: 0, cdA: big ? 1.6 : 1.1, friction: 0.5, material: big ? 'metal' : 'composite', dent: { k: 5200, radius: 0.45, max: 0.32 } })
  add({ id: 'mast', name: big ? 'el pilón del rotor' : 'el mástil', group: 'airframe', parent: 'pod', mass: 14, fMax: 42000 * (big ? 1.3 : 1), mMax: 10000 * (big ? 1.3 : 1), tau: 0.06, attach: zn.mast.attach.clone(), cdA: 0.12, dent: { k: 9000, radius: 0.3, max: 0.12 } })
  add({ id: 'tail', name: 'la cola', group: 'airframe', parent: 'pod', mass: big ? 22 : 9, fMax: 6500 * (big ? 1.5 : 1), mMax: 4200 * (big ? 1.5 : 1), tau: 0.03, attach: v(zn.tailCutX, big ? 0 : -0.6, 0), cdA: big ? 1.0 : 0.6, friction: 0.5, material: big ? 'metal' : 'composite', dent: { k: 2500, radius: 0.35, max: 0.2 } })
  add({ id: 'gearL', name: 'la pata izquierda del tren', group: 'airframe', parent: 'pod', mass: big ? 14 : 6, fMax: 17000 * (big ? 1.6 : 1), mMax: 7000 * (big ? 1.6 : 1), tau: 0.05, attach: ga.clone(), cdA: 0.12, material: big ? 'metal' : 'composite', dent: { k: 4000, radius: 0.3, max: 0.15 } })
  add({ id: 'gearR', name: 'la pata derecha del tren', group: 'airframe', parent: 'pod', mass: big ? 14 : 6, fMax: 17000 * (big ? 1.6 : 1), mMax: 7000 * (big ? 1.6 : 1), tau: 0.05, attach: v(ga.x, ga.y, -ga.z), cdA: 0.12, material: big ? 'metal' : 'composite', dent: { k: 4000, radius: 0.3, max: 0.15 } })
  add({ id: 'noseFork', name: tw ? 'la horquilla de la rueda de cola' : 'la horquilla de morro', group: 'wheelN', parent: 'pod', mass: 2, fMax: 8500, mMax: 2200, tau: 0.04, attach: tw ? v(tw.x, tw.y + 0.25, 0) : v(GEOM.noseWheel.x, -0.6, 0), cdA: 0.04 })

  // --- ruedas (cada una es un cuerpo que gira sobre su eje) ---
  add({ id: 'wheelL', name: 'la rueda izquierda', group: 'wheelL', mass: 4.5, cdA: 0.05, friction: 0.95, restitution: 0.25, material: 'rubber' })
  add({ id: 'wheelR', name: 'la rueda derecha', group: 'wheelR', mass: 4.5, cdA: 0.05, friction: 0.95, restitution: 0.25, material: 'rubber' })
  add({ id: 'wheelN', name: tw ? 'la rueda de cola' : 'la rueda de morro', group: 'wheelN', mass: 2.5, cdA: 0.04, friction: 0.95, restitution: 0.25, material: 'rubber' })

  // --- rotor: buje + 2 (o 3) palas de 3 tramos ---
  // inercia polar resultante ≈ 165 kg·m² (la del modelo de vuelo)
  add({ id: 'rotorHub', name: 'el buje del rotor', group: 'rotor', mass: spec.blades > 2 ? 18 : 6, cdA: 0.05 })
  const bladeMass = spec.bladeMass
  const cuts = bladeCuts(spec.rotorR)
  const span = spec.rotorR - BLADE_ROOT
  // las palas de madera y tela del Cierva aguantan algo menos que las de aluminio extruido
  const mScale = spec.blades > 2 ? 0.8 : 1
  for (const side of bladeSides(spec)) {
    for (let k = 0; k < 3; k++) {
      const r0 = cuts[k]
      const r1 = cuts[k + 1]
      add({
        id: `blade${side}${k}`,
        name: k === 0 ? 'una pala del rotor' : 'un trozo de pala',
        group: 'rotor',
        parent: k === 0 ? 'rotorHub' : `blade${side}${k - 1}`,
        mass: (bladeMass * (r1 - r0)) / span,
        // raíz más fuerte; la punta, perfil fino de pared delgada
        fMax: Infinity,
        mMax: [3000, 1800, 1100][k] * mScale,
        // la pala es flexible: el primer modo de flexión filtra los golpes cortos
        tau: 0.05,
        // el punto de unión real se coloca al crear el accidente (dirección de la pala)
        attach: v(side === 'A' ? r0 : -r0, 0, 0),
        cdA: 0.2 * (r1 - r0) * 0.9,
        friction: 1.1, // la pala "ara" la tierra: mucho más que fricción de deslizamiento
        restitution: 0.05,
        dent: { k: 900, radius: 0.7, max: 0.35 },
      })
    }
  }

  // --- hélice tripala (bipala de madera en el Cierva) ---
  add({ id: 'propHub', name: 'el buje de la hélice', group: 'prop', mass: 1.6, cdA: 0.03 })
  const wood = spec.propR > 1
  for (let k = 0; k < spec.propBlades; k++) {
    add({ id: `prop${k}`, name: 'una pala de la hélice', group: 'prop', parent: 'propHub', mass: wood ? 3.5 : 0.7, mMax: wood ? 900 : 320, tau: 0.015, cdA: wood ? 0.09 : 0.04, friction: 0.8, restitution: 0.05, material: 'composite' })
  }
  return defs
}

/** Ejes con giro libre. Anclas/ejes se rellenan al empezar (dependen de la posición del rotor). */
export function makeJointDefs(zones?: WreckZones): JointDef[] {
  return [
    { id: 'rotor', name: 'la cabeza del rotor', a: 'mast', b: 'rotorHub', anchor: GEOM.hub.clone(), axis: v(0, 1, 0), fMax: 45000, tau: 0.01 },
    { id: 'prop', name: 'el eje de la hélice', a: 'pod', b: 'propHub', anchor: GEOM.prop.clone(), axis: v(1, 0, 0), fMax: 14000, tau: 0.01 },
    { id: 'axleL', name: 'el eje de la rueda izquierda', a: 'gearL', b: 'wheelL', anchor: v(-0.4, -0.86, -0.95), axis: v(0, 0, 1), fMax: 16000, tau: 0.04 },
    { id: 'axleR', name: 'el eje de la rueda derecha', a: 'gearR', b: 'wheelR', anchor: v(-0.4, -0.86, 0.95), axis: v(0, 0, 1), fMax: 16000, tau: 0.04 },
    { id: 'axleN', name: zones?.tailWheel ? 'el eje de la rueda de cola' : 'el eje de la rueda de morro', a: 'noseFork', b: 'wheelN', anchor: v(1.6, -0.89, 0), axis: v(0, 0, 1), fMax: 9000, tau: 0.04 },
  ]
}

/**
 * Pieza de fuselaje a la que pertenece un triángulo (centroide en coordenadas del
 * modelo). `node` = nombre del nodo del GLB del que viene.
 */
export function classifyAirframe(x: number, y: number, z: number, node: string, zn: WreckZones = GENERIC_ZONES): string {
  if (/^pilot|^stick|^windscreen|^eye/.test(node)) return 'pod'
  if (node === 'rudder') return 'tail'
  if (node === 'rotor_head') return 'mast'
  if (x < zn.tailCutX) return 'tail'
  const m = zn.mast
  if (x > m.x0 && x < m.x1 && y > m.yMin && Math.abs(z) < m.zMax) return 'mast'
  const g = zn.gear
  if (y < g.yMax && x > g.x0 && x < g.x1 && Math.abs(z) > g.zMin) return z < 0 ? 'gearL' : 'gearR'
  return 'pod'
}

/** Masa y centro de masas objetivo del conjunto (para cuadrar la góndola). */
export function podMassProperties(defs: PartDef[], totalMass: number, partCom: Map<string, Vector3>): { mass: number; com: Vector3 } {
  let m = 0
  const s = new Vector3()
  for (const d of defs) {
    if (d.id === 'pod') continue
    const c = partCom.get(d.id)
    if (!c) continue
    m += d.mass
    s.addScaledVector(c, d.mass)
  }
  const mPod = Math.max(150, totalMass - m)
  // CG del conjunto = CG del modelo de vuelo
  const com = CG.clone().multiplyScalar(totalMass).sub(s).multiplyScalar(1 / mPod)
  return { mass: mPod, com }
}
