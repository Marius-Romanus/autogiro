// Choque con un cable de un tendido: un conductor tiene 1-3 cm de grueso, así que no vale mirar si
// un punto del aparato «está dentro» como con edificios y árboles. Se mira el movimiento del
// fotograma en cuatro pasos: si el cable cruza el plano del disco del rotor (o de la hélice)
// dentro del radio de las palas, o pasa a menos de su radio de la célula o del mástil, hay choque.

import { Quaternion, Vector3 } from 'three'
import type { Autogyro } from '../sim/autogyro.ts'

export type WireHit = 'rotor' | 'prop' | 'body'

export interface Pose {
  pos: Vector3
  quat: Quaternion
}

const STEPS = 4
const _q = new Quaternion()
const _p = new Vector3()
const _hub = new Vector3()
const _n = new Vector3()
const _prop = new Vector3()
const _ax = new Vector3()
const _nose = new Vector3()
const _tail = new Vector3()
const _a = new Vector3()
const _b = new Vector3()
const _c = new Vector3()
const _top = new Vector3()

interface Frame {
  hub: Vector3
  n: Vector3
  prop: Vector3
  ax: Vector3
  nose: Vector3
  tail: Vector3
  pos: Vector3
}

/**
 * `segs`: tramos de cable cercanos en coordenadas del mundo (x0, y0, z0, x1, y1, z1, …);
 * `from`: postura al empezar el fotograma (null = solo la de ahora).
 */
export function wireStrike(ac: Autogyro, segs: ArrayLike<number>, from: Pose | null): WireHit | null {
  if (segs.length < 6) return null
  const R = ac.rotor.p.radius
  const rp = ac.af.propRadius
  const cg = ac.af.cg
  const propBody = new Vector3().subVectors(ac.af.prop, cg)
  const noseBody = new Vector3(2.1, -0.4, 0).sub(cg)
  const tailBody = new Vector3(-3.9, 0.4, 0).sub(cg)
  // el disco gira con el aparato: su normal en ejes del cuerpo, para los pasos intermedios
  const nBody = ac.rotor.normal.clone().applyQuaternion(_q.copy(ac.quat).invert())
  const frames: Frame[] = []
  const steps = from ? STEPS : 0
  for (let s = 0; s <= steps; s++) {
    const f = steps ? s / steps : 1
    const pos = from ? new Vector3().lerpVectors(from.pos, ac.pos, f) : ac.pos.clone()
    const q = from ? new Quaternion().slerpQuaternions(from.quat, ac.quat, f) : ac.quat.clone()
    frames.push({
      pos,
      hub: _hub.copy(ac.hubBody).applyQuaternion(q).add(pos).clone(),
      n: _n.copy(nBody).applyQuaternion(q).clone(),
      prop: _prop.copy(propBody).applyQuaternion(q).add(pos).clone(),
      ax: _ax.set(1, 0, 0).applyQuaternion(q).clone(),
      nose: _nose.copy(noseBody).applyQuaternion(q).add(pos).clone(),
      tail: _tail.copy(tailBody).applyQuaternion(q).add(pos).clone(),
    })
  }
  const rotorOn = ac.rotor.rpm > 30
  // conicidad de las palas: la del buje y unos 1,2° más en vuelo (las puntas, unos 15 cm sobre el centro)
  const cone = Math.tan(ac.rotor.p.precone) + 0.02
  const propOn = ac.engineRpm > 300
  for (let i = 0; i + 5 < segs.length; i += 6) {
    _a.set(segs[i], segs[i + 1], segs[i + 2])
    _b.set(segs[i + 3], segs[i + 4], segs[i + 5])
    for (let s = 0; s < frames.length; s++) {
      const fr = frames[s]
      const prev = s > 0 ? frames[s - 1] : null
      if (rotorOn && discHit(_a, _b, fr.hub, fr.n, R, prev?.hub ?? null, prev?.n ?? null, cone)) return 'rotor'
      if (propOn && discHit(_a, _b, fr.prop, fr.ax, rp, prev?.prop ?? null, prev?.ax ?? null)) return 'prop'
      // célula (de morro a cola) y mástil hasta lo alto de la cabeza del rotor
      if (segSegDist(_a, _b, fr.nose, fr.tail) < 0.45) return 'body'
      _top.copy(fr.hub).addScaledVector(fr.n, 0.3)
      if (segSegDist(_a, _b, fr.pos, _top) < 0.15) return 'body'
      if (!rotorOn && discHit(_a, _b, fr.hub, fr.n, R, null, null, cone)) return 'rotor'
    }
  }
  return null
}

/**
 * ¿El tramo AB toca el disco (centro c, normal n, radio r)? Cruza su plano dentro del radio,
 * pasa a menos de 15 cm del disco, o (con la postura anterior) lo ha atravesado entre las dos.
 */
function discHit(a: Vector3, b: Vector3, c: Vector3, n: Vector3, r: number, pc: Vector3 | null, pn: Vector3 | null, cone = 0): boolean {
  const da = _c.subVectors(a, c).dot(n)
  const db = _c.subVectors(b, c).dot(n)
  if (cone === 0 && da * db <= 0 && da !== db) {
    const f = da / (da - db)
    _p.lerpVectors(a, b, f)
    if (_p.distanceTo(c) < r) return true
  }
  // lo más cerca del plano dentro del radio (muestras cada ~0,3 m de la parte cercana)
  const len = a.distanceTo(b)
  const k = Math.min(64, Math.max(2, Math.ceil(len / 0.3)))
  for (let i = 0; i <= k; i++) {
    _p.lerpVectors(a, b, i / k)
    _c.subVectors(_p, c)
    const dp = _c.dot(n)
    const radial = Math.sqrt(Math.max(0, _c.lengthSq() - dp * dp))
    if (radial > r + 0.2) continue
    // (con conicidad, la superficie que barren las palas sube hacia las puntas)
    const d = dp - radial * cone
    if (Math.abs(d) < 0.15 && radial < r) return true
    if (pc && pn) {
      // la misma muestra respecto al disco de antes: si cambia de lado dentro del radio, lo ha atravesado
      _c.subVectors(_p, pc)
      const d0p = _c.dot(pn)
      const r0 = Math.sqrt(Math.max(0, _c.lengthSq() - d0p * d0p))
      const d0 = d0p - r0 * cone
      if (d0 * d < 0 && Math.min(radial, r0) < r) return true
    }
  }
  return false
}

const _u = new Vector3()
const _v = new Vector3()
const _w = new Vector3()

/** Distancia mínima entre los tramos PQ y RS. */
function segSegDist(p: Vector3, q: Vector3, r: Vector3, s: Vector3): number {
  _u.subVectors(q, p)
  _v.subVectors(s, r)
  _w.subVectors(p, r)
  const a = _u.dot(_u)
  const b = _u.dot(_v)
  const c = _v.dot(_v)
  const d = _u.dot(_w)
  const e = _v.dot(_w)
  const D = a * c - b * b
  let sN: number
  let sD = D
  let tN: number
  let tD = D
  if (D < 1e-9) {
    sN = 0
    sD = 1
    tN = e
    tD = c
  } else {
    sN = b * e - c * d
    tN = a * e - b * d
    if (sN < 0) {
      sN = 0
      tN = e
      tD = c
    } else if (sN > sD) {
      sN = sD
      tN = e + b
      tD = c
    }
  }
  if (tN < 0) {
    tN = 0
    if (-d < 0) sN = 0
    else if (-d > a) sN = sD
    else {
      sN = -d
      sD = a
    }
  } else if (tN > tD) {
    tN = tD
    if (-d + b < 0) sN = 0
    else if (-d + b > a) sN = sD
    else {
      sN = -d + b
      sD = a
    }
  }
  const sc = Math.abs(sN) < 1e-9 ? 0 : sN / sD
  const tc = Math.abs(tN) < 1e-9 ? 0 : tN / tD
  return _w.addScaledVector(_u, sc).addScaledVector(_v, -tc).length()
}
