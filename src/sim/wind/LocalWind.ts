// El viento en un punto: junta la capa límite del día (perfil, giro y turbulencia según la rugosidad
// de barlovento), el relieve (teoría lineal + estela de sotavento), la estela de los obstáculos
// cercanos y las térmicas. No toca el navegador: los datos del sitio llegan por `WindSite`
// (src/world/WindField.ts los saca del escenario; tools/wind-test.ts los fabrica).

import { localProfile, SURFACES, turbulenceAt, turnAt, type BoundaryLayer, type LocalProfile, type Turbulence } from './boundaryLayer.ts'
import { groundAt, leeWake, reliefWeight, sampleRelief, type LeeWake, type ReliefGrid, type ReliefSample } from './relief.ts'
import { sampleThermals, type ThermalField, type ThermalSample } from './thermals.ts'
import { obstacleWake, type ObstacleGrid, type WakeSample } from './wakes.ts'

/** Lo que se sabe del suelo en un punto. */
export interface SurfacePoint {
  /** rugosidad (m) */
  z0: number
  /** cuánto calienta el aire respecto al campo abierto (0 = agua) */
  heat: number
  water: boolean
}

/** Datos del sitio alrededor del aparato (todo opcional: lo que falta no se aplica). */
export interface WindSite {
  /** suelo en (e, n) del marco local (m al este y al norte) */
  surface: ((e: number, n: number) => SurfacePoint) | null
  /** relieve: rejilla gruesa (decenas de km) y fina (el resto, alrededor del aparato), con su peso 0..1 */
  coarse: ReliefGrid | null
  fine: ReliefGrid | null
  reliefGain: number
  /** rejillas anteriores, mientras se funden con las nuevas (peso 1 − reliefGain) */
  coarsePrev: ReliefGrid | null
  finePrev: ReliefGrid | null
  obstacles: ObstacleGrid | null
  thermals: ThermalField | null
}

export function emptySite(): WindSite {
  return { surface: null, coarse: null, fine: null, reliefGain: 1, coarsePrev: null, finePrev: null, obstacles: null, thermals: null }
}

export interface WindSample {
  /** viento medio (m/s): hacia el este, hacia el norte y hacia arriba */
  e: number
  n: number
  up: number
  /** turbulencia: desviaciones típicas (m/s) y escalas (m) */
  sigH: number
  sigW: number
  lenH: number
  lenW: number
  /** parte lenta (convectiva) de la racha horizontal y su escala */
  sigSlow: number
  lenSlow: number
  // desglose (telemetría y pruebas)
  /** viento medio sin relieve ni obstáculos (m/s) y de dónde viene (°) */
  base: number
  fromDeg: number
  /** rugosidad efectiva de barlovento (m) */
  z0: number
  /** velocidad vertical por el relieve y por las térmicas (m/s) */
  lift: number
  thermal: number
  /** aumento relativo de velocidad por el relieve (ΔS) */
  speedUp: number
  /** déficit relativo por la estela de sotavento del relieve y por obstáculos */
  lee: number
  shelter: number
}

export function newWindSample(): WindSample {
  return { e: 0, n: 0, up: 0, sigH: 0, sigW: 0, lenH: 50, lenW: 20, sigSlow: 0, lenSlow: 500, base: 0, fromDeg: 0, z0: 0.05, lift: 0, thermal: 0, speedUp: 0, lee: 0, shelter: 0 }
}

const FIELD: SurfacePoint = { z0: SURFACES.field.z0, heat: 1, water: false }
/** distancias a barlovento (m) donde se mira la rugosidad y su peso (más lo cercano) */
const FETCH = [20, 45, 90, 160, 260, 400, 600, 900, 1300, 1900, 2700]
const FETCH_W = FETCH.map((d, k) => (k === 0 ? d : d - FETCH[k - 1]) * Math.exp(-d / 800))
const DEG = Math.PI / 180

const _prof: LocalProfile = { speed: 0, ustar: 0 }
const _turb: Turbulence = { sigH: 0, sigW: 0, lenH: 50, lenW: 20, sigSlow: 0, lenSlow: 500 }
const _rel: ReliefSample = { de: 0, dn: 0, mee: 0, men: 0, mnn: 0 }
const _lee: LeeWake = { deficit: 0, sigma: 0, sink: 0, crest: 0, dist: 0 }
const _wake: WakeSample = { deficit: 0, sigma: 0, scale: 0 }
const _th: ThermalSample = { w: 0, sigma: 0, dist: -1, radius: 0, peak: 0, de: 0, dn: 0 }

export class LocalWind {
  bl: BoundaryLayer
  site: WindSite = emptySite()
  /** la última térmica muestreada (para telemetría y pruebas) */
  readonly thermal = _th

  constructor(bl: BoundaryLayer) {
    this.bl = bl
  }

  /** Rugosidad efectiva (media logarítmica de lo que hay a barlovento) y si el punto está sobre agua. */
  roughness(e: number, n: number, we: number, wn: number): { z0: number; water: boolean } {
    const sf = this.site.surface
    if (!sf) return { z0: FIELD.z0, water: false }
    let s = 0
    let w = 0
    for (let k = 0; k < FETCH.length; k++) {
      const p = sf(e - we * FETCH[k], n - wn * FETCH[k])
      s += Math.log(p.z0) * FETCH_W[k]
      w += FETCH_W[k]
    }
    return { z0: Math.exp(s / w), water: sf(e, n).water }
  }

  private readonly groundFn = (e: number, n: number): number => {
    const s = this.site
    if (s.fine) {
      const h = groundAt(s.fine, e, n)
      if (h === h) return h
    }
    return s.coarse ? groundAt(s.coarse, e, n) : NaN
  }

  private readonly heatFn = (dx: number, dy: number): number => (this.site.surface ? this.site.surface(this.he + dx, this.hn + dy).heat : 1)
  private he = 0
  private hn = 0

  /**
   * Viento en (e, n) del marco local a la altura `agl` sobre el suelo. (gx, gy): el mismo punto en
   * metros de un marco fijo a la Tierra (para las térmicas); t: reloj (s).
   */
  sample(e: number, n: number, agl: number, gx: number, gy: number, t: number, out: WindSample): WindSample {
    const bl = this.bl
    const site = this.site
    const z = Math.max(agl, 0.3)
    // dirección a 10 m para mirar a barlovento, y perfil con la rugosidad de ese barlovento
    const to10 = (bl.fromDeg + 180) * DEG
    const rough = this.roughness(e, n, Math.sin(to10), Math.cos(to10))
    localProfile(bl, z, rough.z0, rough.water, _prof)
    const turn = turnAt(bl, z)
    const to = to10 + turn
    const we = Math.sin(to)
    const wn = Math.cos(to)
    let ue = we * _prof.speed
    let un = wn * _prof.speed
    let up = 0
    out.base = _prof.speed
    out.fromDeg = (((bl.fromDeg + turn / DEG) % 360) + 360) % 360
    out.z0 = rough.z0
    turbulenceAt(bl, z, _prof.ustar, _turb, rough.water ? 0.2 : 1)
    let sh2 = _turb.sigH * _turb.sigH
    let sw2 = _turb.sigW * _turb.sigW
    let lenH = _turb.lenH
    let lenW = _turb.lenW
    out.lift = 0
    out.speedUp = 0
    out.lee = 0
    out.shelter = 0
    out.thermal = 0

    // relieve
    if ((site.coarse || site.fine) && _prof.speed > 0.05) {
      _rel.de = _rel.dn = _rel.mee = _rel.men = _rel.mnn = 0
      const g = site.reliefGain
      if (site.coarse) sampleRelief(site.coarse, e, n, z, g * reliefWeight(site.coarse, e, n), _rel)
      if (site.fine) sampleRelief(site.fine, e, n, z, g * reliefWeight(site.fine, e, n), _rel)
      if (g < 1) {
        if (site.coarsePrev) sampleRelief(site.coarsePrev, e, n, z, (1 - g) * reliefWeight(site.coarsePrev, e, n), _rel)
        if (site.finePrev) sampleRelief(site.finePrev, e, n, z, (1 - g) * reliefWeight(site.finePrev, e, n), _rel)
      }
      // aumento de velocidad (acotado: la teoría lineal se pasa con pendientes fuertes)
      let de = _rel.mee * we + _rel.men * wn
      let dn = _rel.men * we + _rel.mnn * wn
      const mag = Math.hypot(de, dn)
      if (mag > 1e-6) {
        const lim = Math.tanh(mag / 0.9) * 0.9
        de *= lim / mag
        dn *= lim / mag
      }
      const along = de * we + dn * wn
      // pendiente de las líneas de corriente (también acotada: un acantilado no da w = 3·U)
      let slope = _rel.de * we + _rel.dn * wn
      slope = Math.tanh(slope / 0.9) * 0.9
      let lift = slope * _prof.speed
      // estela de sotavento (flujo desprendido tras pendientes fuertes)
      leeWake(this.groundFn, e, n, z, we, wn, _lee)
      let k = 1
      if (_lee.deficit > 0 || _lee.sigma > 0) {
        // viento a la altura de la cresta, que es el que mueve el rotor de sotavento
        const uc = localProfile(bl, Math.max(z, _lee.crest), rough.z0, rough.water, _prof2).speed * (1 + Math.max(0, along))
        k = 1 - _lee.deficit * g
        lift = lift * (1 - 0.7 * _lee.deficit * g) + _lee.sink * uc * g
        // de noche el aire estable de abajo queda desacoplado del viento de las crestas: poco rotor
        const sg = _lee.sigma * uc * g * (bl.kind === 'stable' ? 0.35 : 1)
        sh2 += sg * sg
        sw2 += 0.6 * sg * sg
        // remolinos del tamaño de la cresta
        const lw = Math.max(15, 0.5 * _lee.crest)
        const a = Math.min(1, (sg * sg) / Math.max(sh2, 1e-6))
        lenH += (Math.min(lenH, 2 * lw) - lenH) * a
        lenW += (Math.min(lenW, lw) - lenW) * a
        out.lee = _lee.deficit * g
      }
      ue = (ue + de * _prof.speed) * k
      un = (un + dn * _prof.speed) * k
      up += lift
      out.lift = lift
      out.speedUp = along
    }

    // obstáculos cercanos al suelo
    if (site.obstacles && z < 130 && _prof.speed > 0.05) {
      obstacleWake(site.obstacles, e, n, z, we, wn, rough.z0, _wake)
      if (_wake.deficit > 0) {
        const sg = _wake.sigma * Math.hypot(ue, un)
        ue *= 1 - _wake.deficit
        un *= 1 - _wake.deficit
        sh2 += sg * sg
        sw2 += 0.7 * sg * sg
        const a = Math.min(1, (sg * sg) / Math.max(sh2, 1e-6))
        const lw = Math.max(4, _wake.scale)
        lenH += (Math.min(lenH, 2 * lw) - lenH) * a
        lenW += (Math.min(lenW, lw) - lenW) * a
        out.shelter = _wake.deficit
      }
    }

    // térmicas
    if (site.thermals) {
      this.he = e
      this.hn = n
      sampleThermals(site.thermals, gx, gy, z, t, site.surface ? this.heatFn : null, _th)
      up += _th.w
      sw2 += _th.sigma * _th.sigma
      sh2 += 0.5 * _th.sigma * _th.sigma
      out.thermal = _th.w
    } else {
      _th.w = 0
      _th.dist = -1
    }

    out.e = ue
    out.n = un
    out.up = up
    out.sigH = Math.sqrt(sh2)
    out.sigW = Math.sqrt(sw2)
    out.lenH = lenH
    out.lenW = lenW
    out.sigSlow = _turb.sigSlow
    out.lenSlow = _turb.lenSlow
    return out
  }
}
const _prof2: LocalProfile = { speed: 0, ustar: 0 }
