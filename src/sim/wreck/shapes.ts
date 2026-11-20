// Formas de colisión de las piezas. Lo normal es sacarlas de la malla real del
// modelo 3D (WreckModel.ts); aquí está la versión paramétrica de respaldo (sin
// modelo cargado y para las pruebas sin navegador).

import { Vector3 } from 'three'
import { CG, GEOM } from '../autogyro.ts'
import { bladeCuts, bladeSides, GENERIC_WRECK, PROP_HUB_R, TAIL_CUT_X, type WreckSpec } from './parts.ts'

export interface WheelShape {
  /** centro del eje (coordenadas del modelo) */
  center: Vector3
  radius: number
  halfWidth: number
  /** eje de giro (unitario, coordenadas del modelo) */
  axis: Vector3
}

/** Geometría de todas las piezas en coordenadas del modelo, en la postura del instante del choque. */
export interface PartShapes {
  /** nubes de puntos para cascos convexos (x,y,z alternados), una o varias por pieza */
  hulls: Map<string, Float32Array[]>
  hub: Vector3
  rotorAxis: Vector3
  /** dirección de la pala A, en el plano del rotor */
  bladeDir: Vector3
  prop: Vector3
  propAxis: Vector3
  wheels: Record<'wheelL' | 'wheelR' | 'wheelN', WheelShape>
}

/** Puntos de las 8 esquinas de una caja centrada en c con semiejes a·u, b·v, c·w. */
function boxPts(out: number[], c: Vector3, u: Vector3, a: number, vv: Vector3, b: number, w: Vector3, d: number): void {
  for (const su of [-1, 1])
    for (const sv of [-1, 1])
      for (const sw of [-1, 1]) {
        out.push(
          c.x + su * a * u.x + sv * b * vv.x + sw * d * w.x,
          c.y + su * a * u.y + sv * b * vv.y + sw * d * w.y,
          c.z + su * a * u.z + sv * b * vv.z + sw * d * w.z,
        )
      }
}

function aabb(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Float32Array {
  const o: number[] = []
  boxPts(o, new Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), X, (x1 - x0) / 2, Y, (y1 - y0) / 2, Z, (z1 - z0) / 2)
  return new Float32Array(o)
}

const X = new Vector3(1, 0, 0)
const Y = new Vector3(0, 1, 0)
const Z = new Vector3(0, 0, 1)

/**
 * Formas de respaldo (cajas) a partir de la geometría común `GEOM`.
 * @param rotorAxis eje del rotor (modelo)  @param bladeDir dirección de la pala A (modelo)
 * @param propPhase ángulo de la hélice  @param noseSteer giro de la rueda de morro (rad)
 */
export function fallbackShapes(rotorAxis: Vector3, bladeDir: Vector3, propPhase: number, noseSteer: number, hub = GEOM.hub, spec: WreckSpec = GENERIC_WRECK): PartShapes {
  const hulls = new Map<string, Float32Array[]>()
  hulls.set('pod', [
    aabb(1.3, 2.15, -0.62, 0.15, -0.3, 0.3),
    aabb(0.25, 1.3, -0.72, 0.35, -0.4, 0.4),
    // hasta 0,65: respaldo y cabeza del pasajero, a la altura del pie del mástil (se solapan, como en la malla real)
    aabb(-0.62, 0.25, -0.72, 0.65, -0.4, 0.4),
    aabb(-1.38, -0.62, -0.75, 0.55, -0.3, 0.3),
    aabb(-1.75, -1.38, -0.8, -0.66, -0.05, 0.05),
    aabb(TAIL_CUT_X, -1.75, -0.8, -0.57, -0.05, 0.05),
  ])
  hulls.set('mast', [aabb(-0.45, -0.17, 0.4, 1.6, -0.07, 0.07)])
  hulls.set('tail', [aabb(-3.7, -3.2, -0.45, -0.35, -0.8, 0.8), aabb(-3.97, -3.2, -0.6, 0.45, -0.05, 0.05), aabb(-3.2, TAIL_CUT_X, -0.66, -0.5, -0.05, 0.05)])
  hulls.set('gearL', [aabb(-0.55, -0.25, -0.9, -0.6, -1.06, -0.45)])
  hulls.set('gearR', [aabb(-0.55, -0.25, -0.9, -0.6, 0.45, 1.06)])
  hulls.set('noseFork', [aabb(1.5, 1.7, -0.86, -0.55, -0.07, 0.07)])

  // rotor (en el plano perpendicular a rotorAxis)
  const n = rotorAxis.clone().normalize()
  const b = bladeDir.clone().addScaledVector(n, -bladeDir.dot(n)).normalize()
  const c = new Vector3().crossVectors(n, b)
  const hp: number[] = []
  boxPts(hp, hub, b, 0.32, c, 0.08, n, 0.06)
  hulls.set('rotorHub', [new Float32Array(hp)])
  const cuts = bladeCuts(spec.rotorR)
  bladeSides(spec).forEach((side, i) => {
    const bi = b.clone().applyAxisAngle(n, (i * 2 * Math.PI) / spec.blades)
    const ci = new Vector3().crossVectors(n, bi)
    for (let k = 0; k < 3; k++) {
      const r0 = cuts[k]
      const r1 = cuts[k + 1]
      const o: number[] = []
      boxPts(o, hub.clone().addScaledVector(bi, (r0 + r1) / 2), bi, (r1 - r0) / 2, ci, 0.1, n, 0.015)
      hulls.set(`blade${side}${k}`, [new Float32Array(o)])
    }
  })
  // hélice: eje X, palas en el plano YZ
  const pc = GEOM.prop
  const ph: number[] = []
  boxPts(ph, pc, X, 0.1, Y, PROP_HUB_R, Z, PROP_HUB_R)
  hulls.set('propHub', [new Float32Array(ph)])
  for (let k = 0; k < spec.propBlades; k++) {
    const a = propPhase + (k * 2 * Math.PI) / spec.propBlades
    const d = new Vector3(0, Math.cos(a), Math.sin(a))
    const t = new Vector3().crossVectors(X, d)
    const o: number[] = []
    const r0 = PROP_HUB_R
    const r1 = spec.propR
    boxPts(o, pc.clone().addScaledVector(d, (r0 + r1) / 2), d, (r1 - r0) / 2, t, 0.05, X, 0.02)
    hulls.set(`prop${k}`, [new Float32Array(o)])
  }
  const wheelL: WheelShape = { center: new Vector3(-0.4, -0.86, -0.95), radius: 0.19, halfWidth: 0.07, axis: Z.clone() }
  const wheelR: WheelShape = { center: new Vector3(-0.4, -0.86, 0.95), radius: 0.19, halfWidth: 0.07, axis: Z.clone() }
  const wheelN: WheelShape = {
    center: new Vector3(1.6, -0.89, 0),
    radius: 0.16,
    halfWidth: 0.055,
    axis: new Vector3(0, 0, 1).applyAxisAngle(Y, -noseSteer),
  }
  return { hulls, hub: hub.clone(), rotorAxis: n, bladeDir: b, prop: GEOM.prop.clone(), propAxis: X.clone(), wheels: { wheelL, wheelR, wheelN } }
}

/** Centroide de una nube de puntos (x,y,z alternados). */
export function centroid(pts: Float32Array[], out = new Vector3()): Vector3 {
  out.set(0, 0, 0)
  let n = 0
  for (const p of pts) {
    for (let i = 0; i < p.length; i += 3) {
      out.x += p[i]
      out.y += p[i + 1]
      out.z += p[i + 2]
      n++
    }
  }
  return n ? out.multiplyScalar(1 / n) : out.copy(CG)
}
