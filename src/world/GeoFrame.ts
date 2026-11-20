// Marco de referencia local con origen flotante sobre el elipsoide WGS84.
// Mundo: X este, Y arriba, Z sur (plano tangente en el origen).

import { Matrix4, Quaternion, Vector3 } from 'three'
import { Ellipsoid, Geodetic } from '@takram/three-geospatial'

const DEG = Math.PI / 180
const _e = new Vector3()
const _n = new Vector3()
const _u = new Vector3()
const _p = new Vector3()
const _g = new Geodetic()

export class GeoFrame {
  readonly worldToECEF = new Matrix4()
  readonly ecefToWorld = new Matrix4()
  latDeg = 0
  lonDeg = 0
  height = 0

  setOrigin(latDeg: number, lonDeg: number, height = 0): void {
    this.latDeg = latDeg
    this.lonDeg = lonDeg
    this.height = height
    const ecef = new Geodetic(lonDeg * DEG, latDeg * DEG, height).toECEF(_p)
    Ellipsoid.WGS84.getEastNorthUpVectors(ecef, _e, _n, _u)
    _n.negate() // sur
    this.worldToECEF.makeBasis(_e, _u, _n).setPosition(ecef)
    this.ecefToWorld.copy(this.worldToECEF).invert()
  }

  /** Mundo → (lat°, lon°, altura elipsoidal) */
  worldToGeo(p: Vector3): { lat: number; lon: number; h: number } {
    _p.copy(p).applyMatrix4(this.worldToECEF)
    _g.setFromECEF(_p)
    return { lat: _g.latitude / DEG, lon: _g.longitude / DEG, h: _g.height }
  }

  /** (lat°, lon°, h) → mundo */
  geoToWorld(latDeg: number, lonDeg: number, h: number, out: Vector3): Vector3 {
    _g.set(lonDeg * DEG, latDeg * DEG, h)
    return _g.toECEF(out).applyMatrix4(this.ecefToWorld)
  }

  /** "Arriba" geodésico en un punto del mundo (lejos del origen deja de ser +Y). */
  upAt(p: Vector3, out: Vector3): Vector3 {
    _p.copy(p).applyMatrix4(this.worldToECEF)
    Ellipsoid.WGS84.getSurfaceNormal(_p, out)
    return out.transformDirection(this.ecefToWorld)
  }
}

/**
 * Transformación rígida entre dos marcos (para re-centrar el origen sin saltos).
 * Devuelve M tal que p_nuevo = M · p_viejo.
 */
export function rebaseMatrix(oldFrame: GeoFrame, newFrame: GeoFrame, out: Matrix4): Matrix4 {
  return out.multiplyMatrices(newFrame.ecefToWorld, oldFrame.worldToECEF)
}

export function rotationOf(m: Matrix4, out: Quaternion): Quaternion {
  const pos = new Vector3()
  const scale = new Vector3()
  m.decompose(pos, out, scale)
  return out
}
