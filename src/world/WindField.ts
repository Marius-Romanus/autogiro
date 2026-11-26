// Viento del terreno: saca del escenario lo que necesita el modelo de src/sim/wind (relieve, tipo de
// suelo, edificios y árboles a barlovento) y deja en `WindModel.local` el viento del punto donde
// está el aparato. La física está en src/sim/wind/*; aquí solo se recogen datos y se reparte el
// trabajo entre fotogramas para que no haya tirones:
//
//  - Relieve: dos rejillas de alturas Terrarium centradas en el aparato, una gruesa (128 × 400 m =
//    51 km, teselas z10) y una fina (128 × 100 m = 12,8 km, z12) que lleva lo que le falta a la
//    gruesa. Valen en todo el mundo (también con el MDT del IGN o los tiles de Google: para el
//    viento basta el relieve de ~30 m). Cada rejilla son ~40 transformadas de Fourier, una por
//    fotograma; cuando el aparato se aleja del centro se calcula otra y se funde con la anterior.
//  - Suelo: rejilla perezosa de celdas de 64 m con la rugosidad (agua de la máscara de agua, edificios
//    y árboles de las capas z14) y cuánto calienta el aire.
//  - Obstáculos: rejilla de 8 m alrededor del aparato (solo volando bajo) con la altura de edificios
//    y copas; se rehace por trozos cuando el aparato se mueve.
//
// El marco local (e, n) son metros al este y al norte de la salida; no cambia al re-centrar el mundo.

import { Vector3 } from 'three'
import type { LocalAir } from '../sim/atmosphere.ts'
import { heatSinceSunrise, sinSolarElevation, solveBoundaryLayer, SURFACES, type BoundaryLayer } from '../sim/wind/boundaryLayer.ts'
import { LocalWind, newWindSample, type SurfacePoint, type WindSample } from '../sim/wind/LocalWind.ts'
import { buildRelief, groundAt, type ReliefGrid } from '../sim/wind/relief.ts'
import { thermalField } from '../sim/wind/thermals.ts'
import type { ObstacleGrid } from '../sim/wind/wakes.ts'
import { TerrariumHeightSource } from './HeightSource.ts'
import type { World } from './World.ts'

const TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
const DEG = Math.PI / 180
const M_LAT = 110574

/** Condiciones del día (las de la sala en multijugador). */
export interface WindConditions {
  enabled: boolean
  /** viento a 10 m: de dónde viene (°) y velocidad (m/s) */
  fromDeg: number
  speed: number
  clouds: 'clear' | 'fair' | 'scattered' | 'overcast'
  dayOfYear: number
}

/** fracción de cielo cubierto y base de las nubes sobre el suelo (m) de cada cielo (Graphics.setClouds) */
const SKY: Record<WindConditions['clouds'], { cover: number; base: number | null }> = {
  clear: { cover: 0, base: null },
  fair: { cover: 0.22, base: 1300 },
  scattered: { cover: 0.4, base: 1150 },
  overcast: { cover: 0.95, base: 900 },
}

interface Nest {
  n: number
  dx: number
  zoom: number
  levels: number[]
  /** recalcular cuando el aparato se aleja esto del centro (m) */
  redo: number
  src: TerrariumHeightSource
  grid: ReliefGrid | null
  /** centro de la rejilla en curso o vigente */
  ce: number
  cn: number
  job: Generator<void, ReliefGrid> | null
  /** rejilla recién calculada, a la espera de entrar con la otra */
  ready: ReliefGrid | null
  heights: Float32Array | null
  row: number
  state: 'idle' | 'loading' | 'sampling' | 'building'
  /** centro pedido */
  je: number
  jn: number
  token: number
}

/** altura sobre las ruedas a la que se toma el viento del aparato (m): entre el fuselaje y el rotor */
const AIRCRAFT_H = 1.5
const OB_N = 112
const OB_CELL = 8
const SF_N = 128
const SF_CELL = 64

export class WindField {
  /** lo que lee la física (WindModel.local) */
  readonly local: LocalAir = { mean: new Vector3(), sigH: 0, sigW: 0, lenH: 50, lenW: 20, sigSlow: 0, lenSlow: 500 }
  /** la última muestra en el aparato, con su desglose (telemetría y pruebas) */
  readonly last: WindSample = newWindSample()
  /** ms de CPU del último fotograma y el máximo reciente */
  cpuMs = 0
  /** temperatura del aire en el suelo de la salida (°C): la del menú (main la pone al día) */
  tempC = 15
  cpuMax = 0
  private cond: WindConditions | null = null
  private bl: BoundaryLayer | null = null
  private wind: LocalWind | null = null
  private blAt = -1e18
  private lat0 = 0
  private lon0 = 0
  private mE = 1
  private anchored = false
  private readonly coarse: Nest
  private readonly fine: Nest
  private fade = 1
  private world: World | null = null
  // suelo
  private sfZ0 = new Float32Array(SF_N * SF_N)
  private sfHeat = new Float32Array(SF_N * SF_N)
  /** 0 = sin calcular, 1 = definitivo, 2 = provisional (faltaban teselas) */
  private sfState = new Uint8Array(SF_N * SF_N)
  private sfE0 = 0
  private sfN0 = 0
  private sfClock = 0
  private sfAt = new Float32Array(SF_N * SF_N)
  private readonly sfPoint: SurfacePoint = { z0: SURFACES.field.z0, heat: 1, water: false }
  // obstáculos
  private ob: ObstacleGrid | null = null
  private obNext: ObstacleGrid | null = null
  private obRow = 0
  private obAge = 1e9
  private first = true
  private readonly s = newWindSample()

  constructor() {
    const nest = (dx: number, zoom: number, levels: number[], redo: number): Nest => ({
      n: 128,
      dx,
      zoom,
      levels,
      redo,
      src: new TerrariumHeightSource(TERRARIUM, zoom, 40),
      grid: null,
      ce: 0,
      cn: 0,
      job: null,
      ready: null,
      heights: null,
      row: 0,
      state: 'idle',
      je: 0,
      jn: 0,
      token: 0,
    })
    this.coarse = nest(400, 10, [10, 40, 100, 220, 450, 900, 1800, 3000], 9000)
    this.fine = nest(100, 12, [5, 15, 40, 100, 220, 450, 900], 2200)
  }

  /** Condiciones del día (main.applySettings y la sala). */
  setConditions(c: WindConditions): void {
    this.cond = c
    this.blAt = -1e18
  }

  get enabled(): boolean {
    return Boolean(this.cond?.enabled)
  }

  /** Capa límite vigente (telemetría y pruebas). */
  get boundaryLayer(): BoundaryLayer | null {
    return this.bl
  }

  /** Salida nueva: el marco local se ancla en ella y se tira todo lo calculado. */
  reset(lat: number, lon: number): void {
    this.lat0 = lat
    this.lon0 = lon
    this.mE = 111320 * Math.cos(lat * DEG)
    this.anchored = true
    for (const k of [this.coarse, this.fine]) {
      k.grid = k.ready = null
      k.job = null
      k.state = 'idle'
      k.token++
    }
    this.sfState.fill(0)
    this.sfE0 = this.sfN0 = NaN
    this.ob = this.obNext = null
    this.obAge = 1e9
    this.first = true
    this.blAt = -1e18
    if (this.wind) {
      const s = this.wind.site
      s.coarse = s.fine = s.coarsePrev = s.finePrev = null
      s.obstacles = null
    }
  }

  private solve(simMs: number): void {
    const c = this.cond!
    const d = new Date(simMs)
    const utc = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600
    const sky = SKY[c.clouds] ?? SKY.clear
    const tK = this.tempC + 273.15
    this.bl = solveBoundaryLayer({
      speed10: c.speed,
      fromDeg: c.fromDeg,
      latDeg: this.lat0,
      sinElev: sinSolarElevation(this.lat0, this.lon0, c.dayOfYear, utc),
      cloud: sky.cover,
      tempC: this.tempC,
      cloudBaseAgl: sky.base,
      heat: heatSinceSunrise(this.lat0, this.lon0, c.dayOfYear, utc, sky.cover, tK),
    })
    if (!this.wind) {
      this.wind = new LocalWind(this.bl)
      this.wind.site.surface = this.surfaceFn
    } else this.wind.bl = this.bl
    this.wind.site.thermals = thermalField(this.bl, c.dayOfYear)
    this.blAt = simMs
  }

  // -------------------------------------------------------------------------
  // suelo

  private readonly surfaceFn = (e: number, n: number): SurfacePoint => {
    const p = this.sfPoint
    const i = Math.floor((e - this.sfE0) / SF_CELL)
    const j = Math.floor((n - this.sfN0) / SF_CELL)
    if (!(i >= 0 && j >= 0 && i < SF_N && j < SF_N)) {
      p.z0 = SURFACES.field.z0
      p.heat = 1
      p.water = false
      return p
    }
    const q = j * SF_N + i
    const st = this.sfState[q]
    if (st === 0 || (st === 2 && this.sfClock - this.sfAt[q] > 4)) this.classify(q, this.sfE0 + (i + 0.5) * SF_CELL, this.sfN0 + (j + 0.5) * SF_CELL)
    p.z0 = this.sfZ0[q]
    p.heat = this.sfHeat[q]
    p.water = p.heat === 0
    return p
  }

  /** Clasifica una celda de suelo: agua, campo, arbolado o edificado (clases de Davenport-Wieringa). */
  private classify(q: number, e: number, n: number): void {
    const w = this.world
    let z0 = SURFACES.field.z0
    let heat = 1
    let known = true
    if (w) {
      const lat = this.lat0 + n / M_LAT
      const lon = this.lon0 + e / this.mE
      const water = w.waterAtGeo(lat, lon)
      if (water === null && w.mode === 'terrain') known = false
      if (water !== null && water > 0.5) {
        z0 = SURFACES.water.z0
        heat = 0
      } else if (w.buildings || w.trees) {
        let nb = 0
        let nt = 0
        const d = SF_CELL / 3
        for (let b = -1; b <= 1; b++) {
          for (let a = -1; a <= 1; a++) {
            const la = lat + (b * d) / M_LAT
            const lo = lon + (a * d) / this.mE
            const hb = w.buildings && w.buildings.enabled ? w.buildings.heightAtGeo(la, lo) : 0
            if (hb < 0) known = false
            else if (hb > 2) nb++
            const ht = w.trees && w.trees.enabled ? w.trees.canopyAtGeo(la, lo, 6) : 0
            if (ht < 0) known = false
            else if (ht > 2) nt++
          }
        }
        const lb = nb / 9
        const lt = nt / 9
        // dispersos 0,4 · urbanización 0,7 · casco urbano 1–1,5; arbolado de 0,1 (suelto) a 1 (bosque)
        if (nb > 0) z0 = Math.max(z0, Math.min(1.5, 0.1 + 2.8 * lb))
        if (nt > 0) z0 = Math.max(z0, 0.05 + Math.pow(lt, 1.3))
        heat = 1 - 0.1 * lt + 0.05 * Math.min(1, 3 * lb)
      }
    }
    this.sfZ0[q] = z0
    this.sfHeat[q] = heat
    this.sfState[q] = known ? 1 : 2
    this.sfAt[q] = this.sfClock
  }

  // -------------------------------------------------------------------------
  // relieve

  /** Avanza el cálculo de una rejilla; devuelve true si ha gastado tiempo de CPU apreciable. */
  private stepNest(k: Nest, e: number, n: number, background: ReliefGrid | null, needBackground: boolean): boolean {
    if (k.state === 'idle') {
      const far = !k.grid && !k.ready ? true : Math.hypot(e - k.ce, n - k.cn) > k.redo
      if (!far || (needBackground && !background)) return false
      // centro en múltiplos del paso (las rejillas sucesivas muestrean los mismos puntos)
      k.je = Math.round(e / k.dx) * k.dx
      k.jn = Math.round(n / k.dx) * k.dx
      const half = (k.n / 2) * k.dx
      const token = ++k.token
      k.state = 'loading'
      const s = this.lat0 + (k.jn - half) / M_LAT
      const nn = this.lat0 + (k.jn + half) / M_LAT
      const wv = this.lon0 + (k.je - half) / this.mE
      const ev = this.lon0 + (k.je + half) / this.mE
      void k.src.ensure(s, wv, nn, ev).then(() => {
        if (k.token !== token) return
        k.heights = new Float32Array(k.n * k.n)
        k.row = 0
        k.state = 'sampling'
      })
      return false
    }
    if (k.state === 'loading') return false
    const half = (k.n / 2) * k.dx
    if (k.state === 'sampling') {
      // alturas: media de 4 puntos por celda; unas filas por fotograma
      const h = k.heights!
      const q4 = k.dx / 4
      for (let r = 0; r < 12 && k.row < k.n; r++, k.row++) {
        const j = k.row
        for (let i = 0; i < k.n; i++) {
          const ce = k.je - half + i * k.dx
          const cn = k.jn - half + j * k.dx
          let sum = 0
          let cnt = 0
          for (let b = -1; b <= 1; b += 2) {
            for (let a = -1; a <= 1; a += 2) {
              const v = k.src.sample(this.lat0 + (cn + b * q4) / M_LAT, this.lon0 + (ce + a * q4) / this.mE)
              if (v !== null) {
                sum += v
                cnt++
              }
            }
          }
          h[j * k.n + i] = cnt ? sum / cnt : 0
        }
      }
      if (k.row >= k.n) {
        let bg: Float32Array | undefined
        if (background) {
          // lo que ya lleva la rejilla gruesa (su terreno, interpolado) no se cuenta dos veces
          bg = new Float32Array(k.n * k.n)
          for (let j = 0; j < k.n; j++)
            for (let i = 0; i < k.n; i++) {
              const g = groundAt(background, k.je - half + i * k.dx, k.jn - half + j * k.dx)
              bg[j * k.n + i] = g === g ? g : h[j * k.n + i]
            }
        }
        k.job = buildRelief(h, k.n, k.dx, k.je - half, k.jn - half, { levels: k.levels, background: bg })
        k.state = 'building'
      }
      return true
    }
    // una transformada por fotograma
    const r = k.job!.next()
    if (r.done) {
      k.ready = r.value
      k.job = null
      k.heights = null
      k.state = 'idle'
      k.ce = k.je
      k.cn = k.jn
    }
    return true
  }

  private stepRelief(dt: number, e: number, n: number): void {
    const site = this.wind!.site
    const c = this.coarse
    const f = this.fine
    // primero la gruesa; la fina se apoya en la gruesa vigente (o en la recién hecha)
    const busy = this.stepNest(c, e, n, null, false)
    if (!busy) this.stepNest(f, e, n, c.ready ?? c.grid, true)
    // entra lo nuevo: de golpe la primera vez, fundido después
    if ((c.ready || f.ready) && c.state === 'idle' && f.state === 'idle' && this.fade >= 1) {
      // (si la gruesa es nueva, la fina tiene que haberse rehecho sobre ella... o no existir aún)
      const hadAny = Boolean(site.coarse || site.fine)
      site.coarsePrev = site.coarse
      site.finePrev = site.fine
      if (c.ready) c.grid = c.ready
      if (f.ready) f.grid = f.ready
      c.ready = f.ready = null
      site.coarse = c.grid
      site.fine = f.grid
      this.fade = hadAny ? 0 : 0.0001
    }
    if (this.fade < 1) {
      this.fade = Math.min(1, this.fade + dt / 3)
      site.reliefGain = this.fade * this.fade * (3 - 2 * this.fade)
      if (this.fade >= 1) site.coarsePrev = site.finePrev = null
    }
  }

  // -------------------------------------------------------------------------
  // obstáculos

  private stepObstacles(dt: number, e: number, n: number, agl: number): void {
    const w = this.world
    const site = this.wind!.site
    const any = w && ((w.buildings && w.buildings.enabled) || (w.trees && w.trees.enabled))
    if (!any || agl > 160) {
      if (!any) site.obstacles = this.ob = null
      this.obNext = null
      return
    }
    this.obAge += dt
    if (!this.obNext) {
      const half = (OB_N / 2) * OB_CELL
      const moved = this.ob ? Math.max(Math.abs(e - (this.ob.e0 + half)), Math.abs(n - (this.ob.n0 + half))) : Infinity
      // se rehace al moverse (queda margen para los 300 m de alcance) o cada 12 s (teselas que van llegando)
      if (moved < 110 && this.obAge < 12) return
      const ce = Math.round(e / OB_CELL) * OB_CELL
      const cn = Math.round(n / OB_CELL) * OB_CELL
      this.obNext = { n: OB_N, cell: OB_CELL, e0: ce - half, n0: cn - half, h: new Float32Array(OB_N * OB_N), por: new Float32Array(OB_N * OB_N) }
      this.obRow = 0
    }
    const g = this.obNext
    const t0 = performance.now()
    // por filas, hasta ~0,6 ms por fotograma (la primera vez, de un tirón: aún se está cargando)
    const budget = this.ob ? 0.6 : 6
    while (this.obRow < OB_N) {
      const j = this.obRow++
      const lat = this.lat0 + (g.n0 + (j + 0.5) * OB_CELL) / M_LAT
      for (let i = 0; i < OB_N; i++) {
        const lon = this.lon0 + (g.e0 + (i + 0.5) * OB_CELL) / this.mE
        let h = w!.buildings && w!.buildings.enabled ? Math.max(0, w!.buildings.heightAtGeo(lat, lon)) : 0
        let p = 0
        if (h < 2 && w!.trees && w!.trees.enabled) {
          const ht = w!.trees.canopyAtGeo(lat, lon, 3)
          if (ht > 2) {
            h = ht
            p = 0.5
          }
        }
        g.h[j * OB_N + i] = h
        g.por[j * OB_N + i] = p
      }
      if (performance.now() - t0 > budget) break
    }
    if (this.obRow >= OB_N) {
      this.ob = site.obstacles = g
      this.obNext = null
      this.obAge = 0
    }
  }

  // -------------------------------------------------------------------------

  /**
   * Cada fotograma: pone al día los datos del sitio y calcula el viento en el aparato. Devuelve
   * `local` para engancharlo en `WindModel.local`, o null si está apagado o aún no hay condiciones.
   * `simMs`: fecha simulada (ms UTC), la misma para todos los de la sala: es el reloj de las térmicas.
   */
  update(dt: number, world: World | null, pos: Vector3, agl: number, simMs: number): LocalAir | null {
    if (!this.cond || !this.cond.enabled || !world) {
      this.cpuMs = 0
      return null
    }
    const t0 = performance.now()
    const geo = world.frame.worldToGeo(pos)
    if (this.world !== world || !this.anchored || Math.abs(geo.lat - this.lat0) > 0.5 || Math.abs(geo.lon - this.lon0) * Math.cos(geo.lat * DEG) > 0.5) {
      this.world = world
      this.reset(geo.lat, geo.lon)
    }
    // el sol se mueve: la capa límite se rehace cada 2 min de reloj simulado
    if (Math.abs(simMs - this.blAt) > 120e3) this.solve(simMs)
    const e = (geo.lon - this.lon0) * this.mE
    const n = (geo.lat - this.lat0) * M_LAT
    // rejilla de suelo centrada en el aparato (se vacía al alejarse 2 km del centro)
    this.sfClock += dt
    const sh = (SF_N / 2) * SF_CELL
    if (!(Math.abs(e - (this.sfE0 + sh)) < 2000 && Math.abs(n - (this.sfN0 + sh)) < 2000)) {
      this.sfE0 = Math.round(e / SF_CELL) * SF_CELL - sh
      this.sfN0 = Math.round(n / SF_CELL) * SF_CELL - sh
      this.sfState.fill(0)
    }
    this.stepRelief(dt, e, n)
    this.stepObstacles(dt, e, n, agl)
    const s = this.sampleEN(e, n, agl + AIRCRAFT_H, geo.lat, simMs, this.s)
    // paso bajo corto: nada entra de golpe (rejillas que cambian, celdas de 8 m)
    const a = this.first ? 1 : 1 - Math.exp(-dt / 0.25)
    this.first = false
    const L = this.last
    L.e += (s.e - L.e) * a
    L.n += (s.n - L.n) * a
    L.up += (s.up - L.up) * a
    L.sigH += (s.sigH - L.sigH) * a
    L.sigW += (s.sigW - L.sigW) * a
    L.lenH += (s.lenH - L.lenH) * a
    L.lenW += (s.lenW - L.lenW) * a
    L.sigSlow += (s.sigSlow - L.sigSlow) * a
    L.lenSlow = s.lenSlow
    L.base = s.base
    L.fromDeg = s.fromDeg
    L.z0 = s.z0
    L.lift = s.lift
    L.thermal = s.thermal
    L.speedUp = s.speedUp
    L.lee = s.lee
    L.shelter = s.shelter
    // marco del mundo: X este, Y arriba, Z sur
    this.local.mean.set(L.e, L.up, -L.n)
    this.local.sigH = L.sigH
    this.local.sigW = L.sigW
    this.local.lenH = L.lenH
    this.local.lenW = L.lenW
    this.local.sigSlow = L.sigSlow
    this.local.lenSlow = L.lenSlow
    this.cpuMs = performance.now() - t0
    this.cpuMax = Math.max(this.cpuMax * 0.995, this.cpuMs)
    return this.local
  }

  private sampleEN(e: number, n: number, agl: number, lat: number, simMs: number, out: WindSample): WindSample {
    // marco fijo a la Tierra para las térmicas: metros con la escala de la banda de latitud (2°)
    const band = 2 * Math.floor(lat / 2) + 1
    const kE = 111320 * Math.cos(band * DEG)
    const gx = (this.lon0 + e / this.mE) * kE
    const gy = (this.lat0 + n / M_LAT) * M_LAT
    return this.wind!.sample(e, n, agl, gx, gy, simMs / 1000, out)
  }

  /**
   * Viento medio (sin rachas) en un punto cualquiera del mundo a la altura `agl` sobre el suelo:
   * para mangas de viento, humo… Devuelve false si el viento del terreno está apagado.
   */
  at(pos: Vector3, agl: number, simMs: number, out: Vector3): boolean {
    if (!this.world || !this.wind || !this.cond?.enabled) return false
    const geo = this.world.frame.worldToGeo(pos)
    const s = this.sampleEN((geo.lon - this.lon0) * this.mE, (geo.lat - this.lat0) * M_LAT, agl, geo.lat, simMs, _tmp)
    out.set(s.e, s.up, -s.n)
    return true
  }

  /**
   * Como `at`, pero con la turbulencia del punto (desviaciones y escalas de la racha), para quien
   * tenga que hacer sus propias rachas (las mangas de viento). La muestra es compartida: copiar lo
   * que haga falta antes de la siguiente llamada. null si el viento del terreno está apagado.
   */
  sampleAt(pos: Vector3, agl: number, simMs: number): Readonly<WindSample> | null {
    if (!this.world || !this.wind || !this.cond?.enabled) return null
    const geo = this.world.frame.worldToGeo(pos)
    return this.sampleEN((geo.lon - this.lon0) * this.mE, (geo.lat - this.lat0) * M_LAT, agl, geo.lat, simMs, _tmp)
  }

  /** Estado para la telemetría (F3). */
  describe(): string {
    const L = this.last
    const bl = this.bl
    if (!bl || !this.enabled) return ''
    const kt = (Math.hypot(L.e, L.n) / 0.514444).toFixed(0)
    const from = ((Math.atan2(-L.e, -L.n) / DEG + 360) % 360).toFixed(0).padStart(3, '0')
    const sign = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`
    const rel = this.fine.grid ? '' : this.coarse.grid ? ' · relieve grueso' : ' · sin relieve aún'
    return `${from}°/${kt} kt · w ${sign(L.up)} (ladera ${sign(L.lift)}, térmica ${sign(L.thermal)}) · σ ${L.sigH.toFixed(1)}/${L.sigW.toFixed(1)} (lenta ${L.sigSlow.toFixed(1)}) · abrigo ${Math.round(100 * Math.max(L.shelter, L.lee))} % · z0 ${L.z0.toFixed(2)} · ${bl.kind} h ${Math.round(bl.h)} m w* ${bl.wstar.toFixed(1)}${rel} · ${this.cpuMs.toFixed(2)} ms (máx ${this.cpuMax.toFixed(1)})`
  }

  dispose(): void {
    this.coarse.src.dispose()
    this.fine.src.dispose()
  }
}
const _tmp = newWindSample()
