// Brazos y piernas del piloto que siguen a los mandos: la mano derecha a la palanca, la
// izquierda al gas y las botas a los pedales (o al reposapiés del Cierva).
//
// El GLB trae cada tramo como nodo raíz aparte, con el origen en su articulación
// (blender/pilot.py, rig=True):
//   pilot_front_armL_up (hombro) · _armL_lo (codo) · _handL (muñeca)
//   pilot_front_legL_up (cadera) · _legL_lo (rodilla) · _footL (tobillo)
// La mano o la bota va pegada a su mando (lo sigue tal cual, giro incluido) y el brazo o la
// pierna se recoloca con IK de dos huesos, con el codo o la rodilla en el mismo plano que en
// reposo. Los tramos se cuelgan del nodo del piloto para que se oculten con él en la cabina.

import { Matrix4, Object3D, Quaternion, Vector3 } from 'three'

interface Limb {
  up: Object3D
  lo: Object3D
  end: Object3D
  driver: Object3D
  /** hombro / cadera (fijo) y reposo de codo/rodilla y muñeca/tobillo, en la escena del GLB */
  root: Vector3
  joint0: Vector3
  end0: Vector3
  upDir0: Vector3
  loDir0: Vector3
  upQ0: Quaternion
  loQ0: Quaternion
  endM0: Matrix4
  driverInv0: Matrix4
  l1: number
  l2: number
  /** hacia dónde se dobla (perpendicular a raíz→extremo en reposo) */
  pole: Vector3
}

/** mando de cada extremo, por orden de preferencia */
const LIMBS: { arm: string; end: string; drivers: string[] }[] = [
  { arm: 'armR', end: 'handR', drivers: ['stick'] },
  { arm: 'armL', end: 'handL', drivers: ['throttle'] },
  { arm: 'legL', end: 'footL', drivers: ['pedal_L', 'foot_bar'] },
  { arm: 'legR', end: 'footR', drivers: ['pedal_R', 'foot_bar'] },
]

const _D = new Matrix4()
const _E = new Matrix4()
const _M = new Matrix4()
const _w = new Vector3()
const _d = new Vector3()
const _p = new Vector3()
const _j = new Vector3()
const _a = new Vector3()
const _q = new Quaternion()
const _s = new Vector3()

export class PilotRig {
  private limbs: Limb[] = []
  private pilotInv = new Matrix4()

  /**
   * Prepara el piloto `name` de la escena del GLB (todos los nodos, hijos directos de `scene`
   * y en reposo). Devuelve null si el modelo no trae los tramos sueltos.
   */
  static create(scene: Object3D, name = 'pilot_front'): PilotRig | null {
    const pilot = scene.getObjectByName(name)
    if (!pilot || pilot.parent !== scene) return null
    const rig = new PilotRig()
    scene.updateMatrixWorld(true)
    for (const spec of LIMBS) {
      const up = scene.getObjectByName(`${name}_${spec.arm}_up`)
      const lo = scene.getObjectByName(`${name}_${spec.arm}_lo`)
      const end = scene.getObjectByName(`${name}_${spec.end}`)
      const driver = spec.drivers.map((n) => scene.getObjectByName(n)).find((o) => o && o.parent === scene)
      if (!up || !lo || !end || !driver) continue
      for (const o of [up, lo, end, driver]) o.updateMatrix()
      const root = up.position.clone()
      const joint0 = lo.position.clone()
      const end0 = end.position.clone()
      const upDir0 = joint0.clone().sub(root)
      const loDir0 = end0.clone().sub(joint0)
      const l1 = upDir0.length()
      const l2 = loDir0.length()
      if (l1 < 1e-4 || l2 < 1e-4) continue
      const dn = end0.clone().sub(root).normalize()
      const pole = upDir0.clone().addScaledVector(dn, -upDir0.dot(dn))
      if (pole.lengthSq() < 1e-10) continue
      rig.limbs.push({
        up,
        lo,
        end,
        driver,
        root,
        joint0,
        end0,
        upDir0: upDir0.normalize(),
        loDir0: loDir0.normalize(),
        upQ0: up.quaternion.clone(),
        loQ0: lo.quaternion.clone(),
        endM0: end.matrix.clone(),
        driverInv0: driver.matrix.clone().invert(),
        l1,
        l2,
        pole: pole.normalize(),
      })
    }
    if (!rig.limbs.length) return null
    pilot.updateMatrix()
    rig.pilotInv.copy(pilot.matrix).invert()
    for (const l of rig.limbs) for (const o of [l.up, l.lo, l.end]) pilot.attach(o)
    return rig
  }

  /** Llamar después de mover los mandos (sus `quaternion`) en este fotograma. */
  update(): void {
    for (const l of this.limbs) {
      l.driver.updateMatrix()
      // el extremo sigue al mando: mismo cambio que el mando desde su reposo
      _D.multiplyMatrices(l.driver.matrix, l.driverInv0)
      _E.multiplyMatrices(_D, l.endM0)
      _w.setFromMatrixPosition(_E)
      // IK de dos huesos en el plano de reposo
      _d.subVectors(_w, l.root)
      const len = _d.length()
      const dist = Math.min(Math.max(len, Math.abs(l.l1 - l.l2) + 1e-3), (l.l1 + l.l2) * 0.999)
      _d.divideScalar(Math.max(len, 1e-6))
      const ca = Math.max(-1, Math.min(1, (l.l1 * l.l1 + dist * dist - l.l2 * l.l2) / (2 * l.l1 * dist)))
      const sa = Math.sqrt(1 - ca * ca)
      _p.copy(l.pole).addScaledVector(_d, -l.pole.dot(_d))
      if (_p.lengthSq() < 1e-10) _p.copy(l.pole)
      _p.normalize()
      _j.copy(l.root).addScaledVector(_d, l.l1 * ca).addScaledVector(_p, l.l1 * sa)
      // brazo / muslo: del codo de reposo al nuevo
      _a.subVectors(_j, l.root).normalize()
      _q.setFromUnitVectors(l.upDir0, _a).multiply(l.upQ0)
      this.place(l.up, l.root, _q)
      // antebrazo / espinilla: hacia la muñeca / tobillo
      _a.subVectors(_w, _j).normalize()
      _q.setFromUnitVectors(l.loDir0, _a).multiply(l.loQ0)
      this.place(l.lo, _j, _q)
      // mano / bota
      _M.multiplyMatrices(this.pilotInv, _E)
      _M.decompose(l.end.position, l.end.quaternion, _s)
    }
  }

  /** Pone `o` (hijo del piloto) en la pose dada en coordenadas de la escena. */
  private place(o: Object3D, pos: Vector3, q: Quaternion): void {
    _M.compose(pos, q, _s.set(1, 1, 1)).premultiply(this.pilotInv)
    _M.decompose(o.position, o.quaternion, _s)
  }
}
