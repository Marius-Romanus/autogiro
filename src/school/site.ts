// La pista de un ejercicio y su circuito de tráfico.
//
// Todo se mide en los ejes de la pista en uso: `s` a lo largo del eje desde el principio de la zona
// de toma (el umbral, o el umbral desplazado), `d` a la derecha del eje y `h` sobre la pista.
//
// Casarrubios del Monte (LEMT), de la Guía VFR de ENAIRE (enero de 2026,
// guiaVFR.enaire.es/contenido_GuiaVFR/AD/LE_guiaVFR_LEMT.pdf) y de la carta del aeródromo
// (casarrubios.net/lemt_chart.pdf):
//  · pista 08/26 de 950 × 26 m, asfalto, elevación 2050 ft; umbral 08 desplazado 400 m;
//  · circuito de aviación general al norte, a 2800 ft AMSL; ultraligeros a 2500 ft; los autogiros
//    hacen el suyo AL SUR de la pista (la carta avisa: «cuidado con tráfico de autogiros al sur»).
//    Sur = 08 a derechas y 26 a izquierdas. La altitud del circuito de autogiros no consta en
//    ninguna de las dos: se usa la de ultraligeros, 2500 ft (unos 450 ft sobre el campo);
//  · puntos de notificación N (Navalcarnero), S (Valmojado) y N2 (Calypo); 123,500 MHz.
// En cualquier otra pista: circuito a izquierdas (el normal si no hay carta que diga otra cosa) a
// 500 ft sobre el campo, la altura habitual de los circuitos de autogiro y ultraligero.

import { Vector3 } from 'three'

const FT = 0.3048

export interface GeoPoint {
  lat: number
  lon: number
}

/** Pista en uso: se toma de `a` hacia `b`. */
export interface Site {
  /** 'lemt08' | 'lemt26' | 'here' */
  id: string
  name: string
  a: GeoPoint
  b: GeoPoint
  /** semiancho (m) */
  hw: number
  /** umbral de toma desplazado respecto a `a` (m) */
  displaced: number
  /** lado del circuito: +1 a derechas, −1 a izquierdas */
  side: 1 | -1
  /** altura del circuito sobre la pista (m) */
  circuitAgl: number
  /** altitud publicada del circuito (ft AMSL), si la hay */
  circuitFt?: number
}

const LEMT_W: GeoPoint = { lat: 40.2339443, lon: -4.0324438 }
const LEMT_E: GeoPoint = { lat: 40.2357257, lon: -4.0215379 }
const LEMT_ELEV_FT = 2050
const LEMT_CIRCUIT_FT = 2500

export function lemtSite(rwy: '08' | '26'): Site {
  const east = rwy === '08'
  return {
    id: `lemt${rwy}`,
    name: `Casarrubios (LEMT) · ${rwy}`,
    a: east ? LEMT_W : LEMT_E,
    b: east ? LEMT_E : LEMT_W,
    hw: 13,
    displaced: east ? 400 : 0,
    side: east ? 1 : -1,
    circuitAgl: (LEMT_CIRCUIT_FT - LEMT_ELEV_FT) * FT,
    circuitFt: LEMT_CIRCUIT_FT,
  }
}

/** ¿Es la pista de Casarrubios? (para aplicarle su umbral desplazado y su circuito también en vuelo libre) */
export function lemtRunwayFor(a: GeoPoint, b: GeoPoint): Site | null {
  const near = (p: GeoPoint, q: GeoPoint) => Math.abs(p.lat - q.lat) < 0.0012 && Math.abs(p.lon - q.lon) < 0.0016
  if (near(a, LEMT_W) && near(b, LEMT_E)) return lemtSite('08')
  if (near(a, LEMT_E) && near(b, LEMT_W)) return lemtSite('26')
  return null
}

/** Ancho probable de una pista según su longitud (el mapa no lo trae): como world/Runways.ts. */
export function halfWidthFor(len: number): number {
  return (len < 600 ? 18 : len < 1300 ? 26 : len < 2000 ? 30 : len < 3000 ? 45 : 60) / 2
}

/** Circuito genérico: a izquierdas, 500 ft sobre el campo. */
export function genericSite(name: string, a: GeoPoint, b: GeoPoint, len: number): Site {
  return lemtRunwayFor(a, b) ?? { id: 'here', name, a, b, hw: halfWidthFor(len), displaced: 0, side: -1, circuitAgl: 500 * FT }
}

/** Rumbo verdadero (grados) de a hacia b. */
export function bearing(a: GeoPoint, b: GeoPoint): number {
  const k = Math.cos((a.lat * Math.PI) / 180)
  return ((Math.atan2((b.lon - a.lon) * k, b.lat - a.lat) * 180) / Math.PI + 360) % 360
}

/** Lo que hace falta del escenario para colocar la pista en el mundo. */
export interface SiteWorld {
  frame: { geoToWorld(lat: number, lon: number, h: number, out: Vector3): Vector3 }
  sampleGround(x: number, z: number, yHint: number, out: { y: number; normal: Vector3 }, deckMaxY?: number): boolean
}

export interface Local {
  s: number
  d: number
  h: number
}

const _a = new Vector3()
const _b = new Vector3()
const _smp = { y: 0, normal: new Vector3() }

/** Ejes de la pista en el mundo (se recalculan: el origen del mundo se mueve con el aparato). */
export class RwyFrame {
  /** principio de la zona de toma, en el suelo */
  readonly origin = new Vector3()
  readonly dir = new Vector3(1, 0, 0)
  readonly right = new Vector3(0, 0, 1)
  /** pista útil desde la zona de toma y pista que queda antes (umbral desplazado) */
  len = 0
  before = 0
  hw = 13
  /** la altura del suelo ya es la buena */
  grounded = false
  valid = false

  /** Ejes a mano (bancos de pruebas). */
  set(origin: Vector3, dir: Vector3, len: number, hw: number, before = 0): void {
    this.origin.copy(origin)
    this.dir.copy(dir).setY(0).normalize()
    this.right.set(-this.dir.z, 0, this.dir.x)
    this.len = len
    this.hw = hw
    this.before = before
    this.valid = this.grounded = true
  }

  update(w: SiteWorld, site: Site, sampleGround: boolean): void {
    w.frame.geoToWorld(site.a.lat, site.a.lon, 0, _a)
    w.frame.geoToWorld(site.b.lat, site.b.lon, 0, _b)
    const total = Math.hypot(_b.x - _a.x, _b.z - _a.z)
    this.dir.set(_b.x - _a.x, 0, _b.z - _a.z).normalize()
    this.right.set(-this.dir.z, 0, this.dir.x)
    this.before = site.displaced
    this.len = total - site.displaced
    this.hw = site.hw
    const x = _a.x + this.dir.x * site.displaced
    const z = _a.z + this.dir.z * site.displaced
    const y = this.origin.y
    this.origin.set(x, y, z)
    if (sampleGround || !this.grounded) {
      if (w.sampleGround(x, z, 9000, _smp, 9000)) {
        this.origin.y = _smp.y
        this.grounded = true
      }
    }
    this.valid = true
  }

  local(p: Vector3, out: Local): Local {
    const x = p.x - this.origin.x
    const z = p.z - this.origin.z
    out.s = x * this.dir.x + z * this.dir.z
    out.d = x * this.right.x + z * this.right.z
    out.h = p.y - this.origin.y
    return out
  }

  world(s: number, d: number, h: number, out: Vector3): Vector3 {
    return out.set(this.origin.x + this.dir.x * s + this.right.x * d, this.origin.y + h, this.origin.z + this.dir.z * s + this.right.z * d)
  }

  /** rumbo de la pista en el mundo (grados; 0 = norte = −Z) */
  get heading(): number {
    return ((Math.atan2(this.dir.x, -this.dir.z) * 180) / Math.PI + 360) % 360
  }
}

/** Puerta del circuito: centro (ejes de la pista), sentido en que se cruza y nombre del tramo. */
export interface Gate {
  id: 'climb' | 'crosswind' | 'downwind' | 'abeam' | 'base' | 'final'
  s: number
  d: number
  h: number
  /** sentido de paso en ejes de la pista (unitario): (a lo largo, a la derecha) */
  ts: number
  td: number
  /** se comprueba la altura del circuito al pasar */
  level: boolean
}

/** ancho y alto de una puerta (m) y lo que se admite fuera de ella */
export const GATE = { w: 120, h: 70, slackW: 30, slackH: 20 }
/** separación del tramo de viento en cola (m): circuito ceñido, de autogiro */
export const CIRCUIT_WIDTH = 450

/**
 * Circuito de tráfico rectangular: ascenso, viento cruzado, viento en cola (al pasar el final de la
 * pista y al través del umbral), base y final.
 */
export function circuitGates(f: RwyFrame, side: 1 | -1, H: number): Gate[] {
  const W = CIRCUIT_WIDTH * side
  // en una pista larga de aeropuerto el circuito no se alarga con ella: sería un circuito de avión
  const L = Math.min(f.len, 900)
  return [
    { id: 'climb', s: L + 200, d: 0, h: 0.6 * H, ts: 1, td: 0, level: false },
    { id: 'crosswind', s: L + 520, d: W * 0.5, h: 0.9 * H, ts: 0, td: side, level: false },
    { id: 'downwind', s: L, d: W, h: H, ts: -1, td: 0, level: true },
    { id: 'abeam', s: 0, d: W, h: H, ts: -1, td: 0, level: true },
    { id: 'base', s: -520, d: W * 0.5, h: 0.6 * H, ts: 0, td: -side, level: false },
    { id: 'final', s: -300, d: 0, h: 48, ts: 1, td: 0, level: false },
  ]
}
