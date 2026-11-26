// Mallas instanciadas que casi siempre están vacías (polvo, chispas y cascotes de los accidentes,
// gotas de la fumigación, salpicaduras del agua).
//
// three.js no dibuja una malla con cero instancias, pero hasta darse cuenta la mete en la lista
// de dibujo, le busca programa, enlaza sus búferes y sube sus uniformes, en cada pase (escena,
// normales, sombras): con la telemetría (F3) salían 68 «dibujos» de cero triángulos por
// fotograma solo de los efectos de accidente, sin ningún accidente. Con `visible` a false three
// se la salta al recorrer la escena, y eso no cuesta nada.

import type { InstancedBufferGeometry, InstancedMesh, Mesh } from 'three'

/**
 * Hace que la malla solo cuente como visible mientras tenga instancias (InstancedMesh.count o
 * InstancedBufferGeometry.instanceCount). Quien la oculte o la muestre con `visible` sigue mandando.
 */
export function hideWhenEmpty<T extends Mesh>(mesh: T): T {
  let shown = mesh.visible
  const inst = mesh as unknown as InstancedMesh
  Object.defineProperty(mesh, 'visible', {
    configurable: true,
    enumerable: true,
    get: () => shown && (inst.isInstancedMesh ? inst.count > 0 : ((mesh.geometry as InstancedBufferGeometry).instanceCount ?? 1) > 0),
    set: (v: boolean) => {
      shown = v
    },
  })
  return mesh
}
