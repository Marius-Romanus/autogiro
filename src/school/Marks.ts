// Marcas de la escuela en el mundo: puertas del circuito y recuadros pintados en la pista.
//
// Reglas de dibujo del proyecto (render/Graphics.ts): son superposiciones transparentes, así que van
// en OVERLAY_LAYER (el pase de normales no las ve: si no, el terreno de detrás se iluminaría con la
// normal de la puerta) y mezclan con `keepAlpha`, sin tocar el alfa del búfer, que es la máscara de
// iluminación. No proyectan ni reciben sombra y no chocan con nada.

import { DoubleSide, Group, Mesh, MeshBasicMaterial, Path, Shape, ShapeGeometry, Vector3, type Scene } from 'three'
import { keepAlpha, OVERLAY_LAYER } from '../render/Graphics.ts'
import { GATE, type Gate, type RwyFrame, type SiteWorld } from './site.ts'

const YELLOW = 0xf6c400
const _p = new Vector3()
const _smp = { y: 0, normal: new Vector3() }

function ringGeometry(w: number, h: number, bar: number): ShapeGeometry {
  const s = new Shape()
  s.moveTo(-w / 2, -h / 2).lineTo(w / 2, -h / 2).lineTo(w / 2, h / 2).lineTo(-w / 2, h / 2).closePath()
  const hole = new Path()
  hole.moveTo(-w / 2 + bar, -h / 2 + bar).lineTo(-w / 2 + bar, h / 2 - bar).lineTo(w / 2 - bar, h / 2 - bar).lineTo(w / 2 - bar, -h / 2 + bar).closePath()
  s.holes.push(hole)
  return new ShapeGeometry([s])
}

/** Marco de una puerta con un poste hasta el suelo (da la distancia y la altura de un vistazo). */
function gateGeometry(h: number): ShapeGeometry {
  const ring = ringGeometry(GATE.w, GATE.h, 5)
  const post = new Shape()
  post.moveTo(-1.5, -h).lineTo(1.5, -h).lineTo(1.5, -GATE.h / 2).lineTo(-1.5, -GATE.h / 2).closePath()
  const shapes = [...(ring.parameters.shapes as Shape[]), post]
  ring.dispose()
  return new ShapeGeometry(shapes)
}

function material(opacity: number): MeshBasicMaterial {
  const m = keepAlpha(new MeshBasicMaterial({ color: YELLOW, transparent: true, opacity, depthWrite: false, side: DoubleSide, fog: false }))
  // algo más de luz que un amarillo mate: contra el cielo (que ya es radiancia) se quedaba pálido
  m.color.multiplyScalar(1.5)
  return m
}

interface GroundMark {
  mesh: Mesh
  s: number
  d: number
}

export class Marks {
  /** raíz en el principio de la zona de toma, con +X a lo largo de la pista y +Z a su derecha */
  readonly root = new Group()
  private gates: Mesh[] = []
  private ground: GroundMark[] = []
  private groundT = 0

  constructor(scene: Scene) {
    this.root.visible = false
    scene.add(this.root)
  }

  clear(): void {
    for (const m of [...this.gates, ...this.ground.map((g) => g.mesh)]) {
      this.root.remove(m)
      m.geometry.dispose()
      ;(m.material as MeshBasicMaterial).dispose()
    }
    this.gates = []
    this.ground = []
    this.root.visible = false
  }

  private add(m: Mesh): Mesh {
    m.layers.set(OVERLAY_LAYER)
    m.frustumCulled = false
    m.renderOrder = 3
    m.matrixAutoUpdate = true
    this.root.add(m)
    this.root.visible = true
    return m
  }

  /** Puertas del circuito: marcos verticales que se cruzan por dentro. */
  setGates(gates: Gate[]): void {
    for (const g of gates) {
      // el marco se construye en el plano XY: se gira para que su normal mire en el sentido de paso
      const m = this.add(new Mesh(gateGeometry(g.h), material(0.3)))
      m.position.set(g.s, g.h, g.d)
      m.rotation.y = Math.atan2(g.ts, g.td)
      this.gates.push(m)
    }
  }

  /** Resalta la puerta que toca y esconde las ya pasadas. */
  setNextGate(i: number): void {
    this.gates.forEach((m, k) => {
      m.visible = k >= i
      ;(m.material as MeshBasicMaterial).opacity = k === i ? 0.95 : 0.35
    })
  }

  /** Recuadro pintado en la pista entre s0 y s1, con una raya en `line` (el punto de toma). */
  addBox(s0: number, s1: number, hw: number, line: number | null = null): void {
    const len = s1 - s0
    const box = this.add(new Mesh(ringGeometry(len, 2 * hw, 1.2).rotateX(-Math.PI / 2), material(0.75)))
    this.ground.push({ mesh: box, s: (s0 + s1) / 2, d: 0 })
    if (line !== null) {
      const bar = new Shape()
      bar.moveTo(-0.9, -hw).lineTo(0.9, -hw).lineTo(0.9, hw).lineTo(-0.9, hw).closePath()
      const m = this.add(new Mesh(new ShapeGeometry(bar).rotateX(-Math.PI / 2), material(0.9)))
      this.ground.push({ mesh: m, s: line, d: 0 })
    }
    this.groundT = 0
  }

  /** Cada fotograma: coloca la raíz en la pista y, de vez en cuando, posa en el suelo los recuadros. */
  update(dt: number, f: RwyFrame, w: SiteWorld): void {
    if (!this.root.visible || !f.valid) return
    this.root.position.copy(f.origin)
    this.root.rotation.y = Math.atan2(-f.dir.z, f.dir.x)
    this.groundT -= dt
    if (this.groundT <= 0) {
      this.groundT = 1
      for (const g of this.ground) {
        f.world(g.s, g.d, 0, _p)
        const y = w.sampleGround(_p.x, _p.z, 9000, _smp, 9000) ? _smp.y - f.origin.y : 0
        g.mesh.position.set(g.s, y + 0.22, g.d)
      }
    }
  }

  dispose(scene: Scene): void {
    this.clear()
    scene.remove(this.root)
  }
}
