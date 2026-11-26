// Mangas de viento de los aeródromos: dónde están, cómo son y cómo se mueven con el viento.
//
// Dónde. Las teselas de OpenFreeMap no traen `aeroway=windsock` (la capa aeroway solo tiene
// pistas, rodaduras, plataformas y el recinto), así que:
//  1. las de OpenStreetMap salen de public/windsocks.bin (tools/windsocks.ts, ~11 400 en el mundo);
//  2. algunas comprobadas a mano en la ortofoto (KNOWN: la de Casarrubios no está en OSM, pero su
//     círculo blanco de 15 m —el que pide la OACI alrededor del mástil— se ve en el PNOA);
//  3. en cualquier otra pista de OSM sin ninguna manga cerca (Runways.ts, las mismas pistas que se
//     alisan), una puesta donde suelen estar: a un lado, fuera de la franja y del lado sin
//     plataformas ni hangares (que frenan el viento); en las pistas cortas a media pista, visible
//     desde todo el circuito como en LEMT, y en las largas una junto a cada cabecera, en la zona de
//     toma. Se esquivan rodaduras, plataformas, otras pistas y edificios de la tesela.
//
// Cómo son (OACI, Anexo 14, 5.1.1): tronco de cono de tela de 3,6 m con 0,9 m de boca, cinco
// franjas alternas rojas y blancas (la primera y la última del color oscuro), en un mástil con
// la boca en un aro que gira; la boca queda a ~6 m del suelo.
//
// Cómo se mueven. Con el viento del modelo del sitio (WindField: relieve, abrigo de obstáculos,
// térmicas, capa límite) a la altura de la boca, más sus propias rachas (proceso de Markov con
// la desviación y la escala de la turbulencia del punto, como las del aparato). Comportamiento
// de una manga real: cada franja que se llena son unos 3 kt y a 15 kt queda horizontal. La
// veleta gira con un muelle aerodinámico (rigidez ∝ U²) amortiguado, y la cola ondea más con más
// viento y más racha. Sin viento cuelga floja.
//
// Dibujo: como los demás objetos del escenario, cuelga del marco ECEF (syncFrame), escribe alfa 0
// (ya iluminado), refleja el cielo, proyecta sombra del sol (worldShadowCaster) y queda fuera del
// pase de normales (litOnly). La manga se deforma en la CPU (unos 300 vértices) para que la sombra
// siga su forma; solo se animan las que están a menos de ANIM_DIST de la cámara. De noche, las de
// los aeródromos con luz se ven iluminadas por sus focos; las demás, no.

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  DataTexture,
  DoubleSide,
  Group,
  LinearFilter,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  NearestFilter,
  RGBAFormat,
  Sphere,
  SRGBColorSpace,
  TorusGeometry,
  Vector3,
  type Camera,
  type Texture,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { unzlibSync } from 'fflate'
import { GeoFrame } from './GeoFrame.ts'
import type { HeightSource } from './HeightSource.ts'
import { fetchVectorTile, latToY, lonToX, xToLon, yToLat, Z } from './mapTiles.ts'
import type { Runway, Runways } from './Runways.ts'
import type { WindField } from './WindField.ts'
import { HEADER, MAGIC, RECORD, readWindsock } from './windsockFormat.ts'
import { TURBULENCE_UNIT, type WindSettings } from '../sim/atmosphere.ts'
import { viewerLight } from '../render/SunShadows.ts'

const DEG = Math.PI / 180
const KT = 0.514444
/** a qué distancia (m) de la cámara se colocan y se quitan */
const BUILD_DIST = 5000
const DROP_DIST = 7000
/** más lejos no se distinguen (3,6 m de manga): se esconden y no se animan */
const ANIM_DIST = 3500
/** sitios conocidos que no están en OSM (comprobados en la ortofoto) */
const KNOWN: Array<{ lat: number; lon: number; lit: boolean; note: string }> = [
  // Casarrubios (LEMT): círculo de 15 m a media pista (486 m de la cabecera 08) y 102 m al norte
  // del eje, del lado sin hangares (PNOA). Aeródromo solo diurno: sin luz.
  { lat: 40.235762, lon: -4.027099, lit: false, note: 'LEMT' },
]

// Medidas
const MAST_H = 5.5 // pivote
const RING_X = 0.12 // aro de la boca, a sotavento del eje del mástil
const RING_Y = 0.5 // centro del aro sobre el pivote
const SOCK_LEN = 3.6
const SOCK_R0 = 0.45
const SOCK_R1 = 0.2
const NS = 25 // tramos a lo largo (5 por franja)
const NR = 12 // lados
/** altura de la boca sobre el suelo, donde se toma el viento */
const SOCK_AGL = MAST_H + RING_Y

// ---------------------------------------------------------------------------
// Datos: OSM empaquetado
// ---------------------------------------------------------------------------

interface Pack {
  lat: Float64Array
  lon: Float64Array
  lit: Int8Array
}

let pack: Promise<Pack | null> | null = null
function loadPack(): Promise<Pack | null> {
  pack ??= (async () => {
    try {
      const r = await fetch(`${import.meta.env.BASE_URL}windsocks.bin`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const raw = unzlibSync(new Uint8Array(await r.arrayBuffer()))
      const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
      const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3))
      if (magic !== MAGIC) throw new Error('formato desconocido')
      const n = Math.min(dv.getUint32(4, true), Math.floor((raw.byteLength - HEADER) / RECORD))
      const p: Pack = { lat: new Float64Array(n), lon: new Float64Array(n), lit: new Int8Array(n) }
      for (let i = 0; i < n; i++) {
        const w = readWindsock(dv, i)
        p.lat[i] = w.lat
        p.lon[i] = w.lon
        p.lit[i] = w.lit
      }
      return p
    } catch (e) {
      console.warn('mangas de viento: sin las de OpenStreetMap', e)
      return null
    }
  })()
  return pack
}

/** primer índice con latitud >= lat (el paquete va ordenado por latitud) */
function lowerBound(a: Float64Array, v: number): number {
  let lo = 0
  let hi = a.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (a[m] < v) lo = m + 1
    else hi = m
  }
  return lo
}

// ---------------------------------------------------------------------------
// Rodaduras, plataformas y edificios de la tesela (para no poner la manga encima)
// ---------------------------------------------------------------------------

interface AeroTile {
  lines: Array<Array<[number, number]>> // pistas y rodaduras, [lat, lon]
  polys: Array<Array<[number, number]>> // plataformas y edificios
  labels: Array<{ lat: number; lon: number; iata: boolean; cls: string }>
}

const aeroCache = new Map<string, Promise<AeroTile | null>>()

function aeroTile(x: number, y: number, signal: AbortSignal): Promise<AeroTile | null> {
  const key = `${x}/${y}`
  let p = aeroCache.get(key)
  if (!p) {
    p = fetchVectorTile(x, y, signal)
      .then((vt) => {
        const n = 2 ** Z
        const out: AeroTile = { lines: [], polys: [], labels: [] }
        const geo = (px: number, py: number, E: number): [number, number] => [yToLat(y + py / E, n), xToLon(x + px / E, n)]
        const aw = vt.layers.aeroway
        for (let i = 0; aw && i < aw.length; i++) {
          const f = aw.feature(i)
          const cls = f.properties.class
          const g = f.loadGeometry()
          if (f.type === 2 && (cls === 'runway' || cls === 'taxiway')) for (const l of g) out.lines.push(l.map((p) => geo(p.x, p.y, aw.extent)))
          else if (f.type === 3 && (cls === 'apron' || cls === 'runway' || cls === 'taxiway' || cls === 'helipad')) for (const r of g) out.polys.push(r.map((p) => geo(p.x, p.y, aw.extent)))
        }
        const bl = vt.layers.building
        for (let i = 0; bl && i < bl.length; i++) {
          const f = bl.feature(i)
          if (f.type === 3) for (const r of f.loadGeometry()) out.polys.push(r.map((p) => geo(p.x, p.y, bl.extent)))
        }
        const lb = vt.layers.aerodrome_label
        for (let i = 0; lb && i < lb.length; i++) {
          const f = lb.feature(i)
          const pt = f.loadGeometry()[0]?.[0]
          if (!pt) continue
          const [la, lo] = geo(pt.x, pt.y, lb.extent)
          out.labels.push({ lat: la, lon: lo, iata: Boolean(f.properties.iata), cls: String(f.properties.class ?? '') })
        }
        return out
      })
      .catch(() => {
        aeroCache.delete(key) // se reintenta otra vez
        return null
      })
    aeroCache.set(key, p)
    if (aeroCache.size > 40) aeroCache.delete(aeroCache.keys().next().value!)
  }
  return p
}

/** Teselas z14 que cubren un rectángulo. */
async function aeroIn(south: number, west: number, north: number, east: number, signal: AbortSignal): Promise<AeroTile[]> {
  const n = 2 ** Z
  const jobs: Promise<AeroTile | null>[] = []
  for (let y = Math.floor(latToY(north, n)); y <= Math.floor(latToY(south, n)); y++)
    for (let x = Math.floor(lonToX(west, n)); x <= Math.floor(lonToX(east, n)); x++) jobs.push(aeroTile(x, y, signal))
  return (await Promise.all(jobs)).filter((t): t is AeroTile => t !== null)
}

/** Plano local métrico alrededor de un punto. */
interface Plane {
  lat0: number
  lon0: number
  mLat: number
  mLon: number
}
function plane(lat: number, lon: number): Plane {
  return { lat0: lat, lon0: lon, mLat: 111132.92 - 559.82 * Math.cos(2 * lat * DEG), mLon: 111412.84 * Math.cos(lat * DEG) - 93.5 * Math.cos(3 * lat * DEG) }
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const l2 = dx * dx + dy * dy
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0
  return Math.hypot(px - ax - t * dx, py - ay - t * dy)
}

/** Distancia (m) de un punto a lo más cercano de las teselas: líneas, y bordes o interior de polígonos (0). */
function clearance(tiles: AeroTile[], lat: number, lon: number): { line: number; poly: number } {
  const p = plane(lat, lon)
  const X = (q: [number, number]) => (q[1] - lon) * p.mLon
  const Y = (q: [number, number]) => (q[0] - lat) * p.mLat
  let line = Infinity
  let poly = Infinity
  for (const t of tiles) {
    for (const l of t.lines) for (let i = 0; i + 1 < l.length; i++) line = Math.min(line, segDist(0, 0, X(l[i]), Y(l[i]), X(l[i + 1]), Y(l[i + 1])))
    for (const r of t.polys) {
      let inside = false
      let d = Infinity
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const xi = X(r[i])
        const yi = Y(r[i])
        const xj = X(r[j])
        const yj = Y(r[j])
        if (yi > 0 !== yj > 0 && 0 < ((xj - xi) * (0 - yi)) / (yj - yi) + xi) inside = !inside
        d = Math.min(d, segDist(0, 0, xi, yi, xj, yj))
      }
      poly = Math.min(poly, inside ? 0 : d)
    }
  }
  return { line, poly }
}

// ---------------------------------------------------------------------------
// Modelo
// ---------------------------------------------------------------------------

interface Materials {
  steel: MeshStandardMaterial
  sock: MeshStandardMaterial
  sockLit: MeshStandardMaterial
  lamp: MeshStandardMaterial
}

/** cinco franjas: roja, blanca, roja, blanca, roja (en la textura, de la boca a la cola) */
function stripeTexture(): Texture {
  const d = new Uint8Array(5 * 4)
  const red = [206, 32, 28]
  const white = [236, 234, 228]
  for (let i = 0; i < 5; i++) d.set([...(i % 2 ? white : red), 255], i * 4)
  const t = new DataTexture(d, 5, 1, RGBAFormat)
  t.magFilter = NearestFilter
  t.minFilter = LinearFilter
  t.colorSpace = SRGBColorSpace
  t.needsUpdate = true
  return t
}

function litAlphaZero(m: MeshStandardMaterial, key: string, emissiveTimesAlbedo = false): MeshStandardMaterial {
  // alfa = 0 → «este píxel ya está iluminado» (máscara de iluminación de Graphics.ts)
  m.onBeforeCompile = (shader) => {
    if (emissiveTimesAlbedo)
      // la luz de los focos sobre la tela: el brillo propio va por el color de cada franja
      shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= diffuseColor.rgb;')
    shader.fragmentShader = shader.fragmentShader.replace('#include <dithering_fragment>', '#include <dithering_fragment>\n\tgl_FragColor.a = 0.0;')
  }
  m.customProgramCacheKey = () => key
  return m
}

/** Mástil, base, cabeza giratoria (sin el aro) y, si tiene luz, los focos: en coordenadas del sitio. */
function mastGeometry(lit: boolean): BufferGeometry {
  const parts: BufferGeometry[] = []
  const base = new BoxGeometry(0.7, 0.5, 0.7)
  base.translate(0, -0.2, 0) // dado de hormigón (medio enterrado: tapa desniveles del relieve)
  parts.push(base)
  const pole = new CylinderGeometry(0.045, 0.06, MAST_H, 8, 1)
  pole.translate(0, MAST_H / 2, 0)
  parts.push(pole)
  const cap = new CylinderGeometry(0.07, 0.07, 0.18, 8, 1)
  cap.translate(0, MAST_H - 0.05, 0)
  parts.push(cap)
  if (lit) {
    // dos focos en brazos cortos bajo el pivote, mirando a la manga
    for (const s of [-1, 1]) {
      const arm = new BoxGeometry(0.5, 0.04, 0.04)
      arm.translate(0, MAST_H - 0.45, 0)
      arm.rotateY(s > 0 ? 0 : Math.PI / 2)
      parts.push(arm)
    }
  }
  const g = mergeGeometries(parts.map((p) => p.toNonIndexed()))
  for (const p of parts) p.dispose()
  return g
}

function lampGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = []
  for (const [x, z] of [[0.25, 0], [-0.25, 0], [0, 0.25], [0, -0.25]]) {
    const b = new BoxGeometry(0.12, 0.1, 0.12)
    b.translate(x, MAST_H - 0.4, z)
    parts.push(b.toNonIndexed())
  }
  return mergeGeometries(parts)
}

/** Aro de la boca, eje del giro y tirantes, en los ejes de la cabeza (+x a sotavento). */
function frameGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = []
  const ring = new TorusGeometry(SOCK_R0, 0.018, 6, 24)
  ring.rotateY(Math.PI / 2)
  ring.translate(RING_X, RING_Y, 0)
  parts.push(ring)
  const spindle = new CylinderGeometry(0.025, 0.025, RING_Y + SOCK_R0 + 0.05, 6, 1)
  spindle.translate(0, (RING_Y + SOCK_R0 + 0.05) / 2, 0)
  parts.push(spindle)
  for (const y of [RING_Y - SOCK_R0, RING_Y + SOCK_R0]) {
    const stay = new BoxGeometry(RING_X + 0.03, 0.025, 0.025)
    stay.translate(RING_X / 2, y, 0)
    parts.push(stay)
  }
  const g = mergeGeometries(parts.map((p) => p.toNonIndexed()))
  for (const p of parts) p.dispose()
  return g
}

/** Malla de la manga (se rellena en cada animación): NS+1 anillos de NR+1 vértices (costura repetida). */
function sockGeometry(): BufferGeometry {
  const g = new BufferGeometry()
  const nv = (NS + 1) * (NR + 1)
  g.setAttribute('position', new BufferAttribute(new Float32Array(nv * 3), 3))
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nv * 3), 3))
  const uv = new Float32Array(nv * 2)
  for (let i = 0; i <= NS; i++)
    for (let j = 0; j <= NR; j++) {
      const k = i * (NR + 1) + j
      uv[2 * k] = i / NS
      uv[2 * k + 1] = j / NR
    }
  g.setAttribute('uv', new BufferAttribute(uv, 2))
  const idx: number[] = []
  for (let i = 0; i < NS; i++)
    for (let j = 0; j < NR; j++) {
      const a = i * (NR + 1) + j
      const b = a + NR + 1
      idx.push(a, b, a + 1, a + 1, b, b + 1)
    }
  g.setIndex(idx)
  // la manga nunca sale de esta esfera (centro en la boca)
  g.boundingSphere = new Sphere(new Vector3(RING_X, RING_Y, 0), SOCK_LEN + 0.8)
  return g
}

// ---------------------------------------------------------------------------
// Sitios
// ---------------------------------------------------------------------------

interface Site {
  key: string
  lat: number
  lon: number
  lit: boolean
  state: 'loading' | 'ready' | 'failed'
  root?: Group
  model?: Group
  head?: Group
  sock?: Mesh
  /** mundo → ejes del sitio (para los choques) */
  toLocal: Matrix4
  /** centro de la boca en el mundo */
  top: Vector3
  // dinámica
  yaw: number
  yawRate: number
  speed: number
  phase: number
  phase2: number
  gust: [number, number, number, number] // rápida e, n; lenta e, n
  windAge: number
  meanE: number
  meanN: number
  sigH: number
  lenH: number
  sigSlow: number
  lenSlow: number
  far: number
}

/** Lo que hace falta del resto del juego para animarlas. */
export interface WindsockEnv {
  /** viento del sitio (src/world/WindField.ts); si está apagado, el del menú */
  field: WindField | null
  settings: WindSettings
  /** fecha simulada (ms): reloj de las térmicas */
  simMs: number
  /** exposición del render (la luz de los focos va en unidades ya expuestas) */
  exposure: number
  /** seno de la altura del sol (si no hay medida de la luz ambiente) */
  sunY: number
}

const LUX_PER_UNIT = 75718
const _v = new Vector3()
const _cam = new Vector3()
const _t = new Vector3()
const _n1 = new Vector3()
const _n2 = new Vector3()
const _c = new Vector3()
const _z = new Vector3(0, 0, 1)

function gaussian(): number {
  let u = 0
  while (u === 0) u = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random())
}

/** proceso de Markov de primer orden (Dryden simplificado): paso de dt con tiempo τ y desviación σ */
function markov(x: number, dt: number, tau: number, sigma: number): number {
  const a = Math.exp(-dt / Math.max(tau, 0.05))
  return a * x + sigma * Math.sqrt(1 - a * a) * gaussian()
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export class Windsocks {
  readonly group = new Group()
  private readonly frame: GeoFrame
  private readonly heights: HeightSource
  private readonly runways: () => Runways | null
  private readonly sites = new Map<string, Site>()
  /** pistas ya estudiadas (clave → hay manga real cerca o ya se puso la suya) */
  private readonly studied = new Set<string>()
  private readonly mats: Materials
  private readonly mastGeo: BufferGeometry
  private readonly mastLitGeo: BufferGeometry
  private readonly lampGeo: BufferGeometry
  private readonly frameGeo: BufferGeometry
  private readonly abort = new AbortController()
  private timer = 0
  /** colocación de las mangas supuestas, una pista tras otra */
  private placing: Promise<void> = Promise.resolve()
  private disposed = false
  private lampsOn = 0

  constructor(frame: GeoFrame, heights: HeightSource, runways: () => Runways | null) {
    this.frame = frame
    this.heights = heights
    this.runways = runways
    this.group.matrixAutoUpdate = false
    this.group.userData.worldShadowCaster = true // sombra del sol (SunShadows)
    this.group.userData.litOnly = true // ya iluminado: fuera del pase de normales (Graphics.ts)
    const stripes = stripeTexture()
    this.mats = {
      steel: litAlphaZero(new MeshStandardMaterial({ color: 0x9a9c9c, roughness: 0.5, metalness: 0.6 }), 'windsock-steel'),
      sock: litAlphaZero(new MeshStandardMaterial({ map: stripes, side: DoubleSide, roughness: 0.85 }), 'windsock-sock'),
      sockLit: litAlphaZero(new MeshStandardMaterial({ map: stripes, side: DoubleSide, roughness: 0.85, emissive: 0xffffff, emissiveIntensity: 0 }), 'windsock-sock-lit', true),
      lamp: litAlphaZero(new MeshStandardMaterial({ color: 0x303234, roughness: 0.4, metalness: 0.5, emissive: 0xfff1d8, emissiveIntensity: 0 }), 'windsock-lamp'),
    }
    this.mastGeo = mastGeometry(false)
    this.mastLitGeo = mastGeometry(true)
    this.lampGeo = lampGeometry()
    this.frameGeo = frameGeometry()
  }

  /** Coloca las cercanas, quita las lejanas (cada segundo) y anima las que se ven (cada fotograma). */
  update(dt: number, camera: Camera, env: WindsockEnv): void {
    if (this.disposed) return
    camera.getWorldPosition(_cam)
    this.timer -= dt
    if (this.timer <= 0) {
      this.timer = 1
      void this.scan()
    }
    // focos: se encienden al atardecer (como las farolas: de ~1500 lux, del todo hacia 300)
    const amb = viewerLight.illuminance
    const lux = amb >= 0 ? amb * LUX_PER_UNIT : env.sunY > 0.12 ? 1e5 : env.sunY > 0 ? 2000 : 10
    this.lampsOn = 1 - smoothstep(Math.log10(300), Math.log10(1500), Math.log10(Math.max(lux, 1)))
    const ex = Math.max(env.exposure, 1e-3)
    // tela blanca bajo los focos: ~0,4 ya expuesto (como un objeto blanco con focos para el ojo
    // adaptado a la noche; la FAA pide unos 20 lux sobre la manga)
    this.mats.sockLit.emissiveIntensity = (0.5 * this.lampsOn) / ex
    this.mats.lamp.emissiveIntensity = (0.6 * this.lampsOn) / ex
    for (const s of this.sites.values()) {
      if (s.state !== 'ready' || !s.root) continue
      const d = s.top.distanceTo(_cam)
      const show = d < ANIM_DIST
      s.root.visible = show
      if (!show) continue
      // las lejanas, a menos fotogramas (no se nota)
      s.far += dt
      if (d > 900 && s.far < 0.1) continue
      this.animate(s, s.far, env)
      s.far = 0
    }
  }

  // -------------------------------------------------------------------------
  // Colocación
  // -------------------------------------------------------------------------

  private async scan(): Promise<void> {
    const g = this.frame.worldToGeo(_cam)
    const lat = g.lat
    const lon = g.lon
    const mLon = 111320 * Math.cos(lat * DEG)
    const dist = (la: number, lo: number) => Math.hypot((la - lat) * 110574, (lo - lon) * mLon)
    // quitar las lejanas
    for (const [k, s] of this.sites) {
      if (dist(s.lat, s.lon) > DROP_DIST) {
        this.drop(s)
        this.sites.delete(k)
      }
    }
    for (const k of this.studied) {
      const [la, lo] = k.split('|')[1]?.split(',').map(Number) ?? [NaN, NaN]
      if (!(dist(la, lo) < DROP_DIST)) this.studied.delete(k)
    }
    // las de OSM y las conocidas
    const p = await loadPack()
    if (this.disposed) return
    const dLat = BUILD_DIST / 110574
    const real: Array<{ lat: number; lon: number }> = []
    if (p) {
      for (let i = lowerBound(p.lat, lat - dLat - 0.02); i < p.lat.length && p.lat[i] < lat + dLat + 0.02; i++) {
        if (Math.abs(p.lon[i] - lon) * mLon > BUILD_DIST + 2000) continue
        real.push({ lat: p.lat[i], lon: p.lon[i] })
        if (dist(p.lat[i], p.lon[i]) < BUILD_DIST) this.add(`osm:${p.lat[i].toFixed(6)},${p.lon[i].toFixed(6)}`, p.lat[i], p.lon[i], p.lit[i])
      }
    }
    for (const k of KNOWN) {
      if (dist(k.lat, k.lon) > BUILD_DIST + 2000) continue
      real.push(k)
      if (dist(k.lat, k.lon) < BUILD_DIST) this.add(`known:${k.note}`, k.lat, k.lon, k.lit ? 1 : 0)
    }
    // pistas de OSM sin ninguna manga cerca: la suya (cuando ya se conocen todas las de alrededor,
    // de la más larga a la más corta y una tras otra: en un aeródromo pequeño basta una)
    const rw = this.runways()
    if (!rw || rw.pending) return
    for (const r of [...rw.list].sort((a, b) => b.len - a.len)) {
      if (this.studied.has(r.key)) continue
      const mid = runwayPoint(r, r.len / 2, 0)
      if (dist(mid[0], mid[1]) > BUILD_DIST) continue
      this.studied.add(r.key)
      if (real.some((w) => nearRunway(r, w.lat, w.lon))) continue
      this.placing = this.placing.then(() => this.place(r)).catch(() => undefined)
    }
  }

  /** Mangas supuestas de una pista sin ninguna en OSM. */
  private async place(r: Runway): Promise<void> {
    // pista corta con la manga de otra pista del mismo aeródromo ya cerca: no hace falta otra
    if (r.len < 1500 && [...this.sites.values()].some((w) => w.key.startsWith('rw:') && nearRunway(r, w.lat, w.lon))) return
    const pad = 0.004
    const tiles = await aeroIn(Math.min(r.south, r.north) - pad, r.west - pad / Math.cos(r.lat0 * DEG), r.north + pad, r.east + pad / Math.cos(r.lat0 * DEG), this.abort.signal)
    if (this.disposed) return
    const len = r.len
    // separación del eje: fuera de la franja (OACI: 30/40 m en pistas cortas sin instrumentos,
    // 75 m en las medianas, 140–150 m en las de instrumentos)
    const off = len < 800 ? 45 : len < 1200 ? 60 : len < 1800 ? 95 : 160
    // lado: el que tiene menos plataformas y edificios cerca (son los que frenan el viento)
    let score = 0
    for (const t of tiles) {
      for (const ring of t.polys) {
        for (const q of ring) {
          const { s, o } = runwayLocal(r, q[0], q[1])
          if (s > -100 && s < len + 100 && Math.abs(o) < 400) score += Math.sign(o)
        }
      }
    }
    const side = score > 0 ? -1 : 1 // + = a la derecha de A→B
    const stations = len < 1500 ? [len / 2] : [Math.min(300, len * 0.2), len - Math.min(300, len * 0.2)]
    const mid = runwayPoint(r, len / 2, 0)
    const lit = await this.aerodromeLit(mid[0], mid[1], len)
    if (this.disposed) return
    stations.forEach((s0, i) => {
      let pick: [number, number] | null = null
      search: for (const sd of [side, -side]) {
        for (const ds of [0, -50, 50, -100, 100, -150, 150]) {
          for (const dOff of [0, 20, 40]) {
            const s = s0 + ds
            if (s < 30 || s > len - 30) continue
            const [la, lo] = runwayPoint(r, s, sd * (off + dOff))
            const c = clearance(tiles, la, lo)
            if (c.line < 30 || c.poly < 15) continue
            pick = [la, lo]
            break search
          }
        }
      }
      pick ??= runwayPoint(r, s0, side * off)
      this.add(`rw:${r.key}:${i}`, pick[0], pick[1], lit ? 1 : 0)
    })
  }

  private add(key: string, lat: number, lon: number, lit: number): void {
    if (this.sites.has(key)) return
    const s: Site = {
      key,
      lat,
      lon,
      lit: lit === 1,
      state: 'loading',
      toLocal: new Matrix4(),
      top: new Vector3(),
      yaw: Math.random() * Math.PI * 2,
      yawRate: 0,
      speed: 0,
      phase: Math.random() * 10,
      phase2: Math.random() * 10,
      gust: [0, 0, 0, 0],
      windAge: 1,
      meanE: 0,
      meanN: 0,
      sigH: 0,
      lenH: 50,
      sigSlow: 0,
      lenSlow: 500,
      far: 0,
    }
    this.sites.set(key, s)
    // sin dato en OSM: según el aeródromo
    if (lit === -1)
      void this.aerodromeLit(lat, lon, 0).then((l) => {
        s.lit = l
        return this.build(s)
      })
    else void this.build(s)
  }

  /**
   * ¿Aeródromo con luz (vuelos de noche)? Si tiene una pista de 2400 m o más (aeropuerto), o si
   * la etiqueta de aeródromo más cercana (a menos de 4 km) es de uno con código IATA (vuelos
   * regulares), internacional o militar. Los demás, sin luz: la mayoría de los aeródromos
   * pequeños son solo diurnos (como LEMT).
   */
  private async aerodromeLit(lat: number, lon: number, len: number): Promise<boolean> {
    if (len >= 2400) return true
    // las pistas de alrededor aún se están buscando: esperarlas (como mucho lo que espera Runways)
    const rw = this.runways()
    for (let i = 0; i < 20 && rw?.pending && !this.disposed; i++) await new Promise((r) => setTimeout(r, 500))
    if (rw?.list.some((r) => r.len >= 2400 && nearRunway(r, lat, lon))) return true
    const d = 0.03
    const k = Math.cos(lat * DEG)
    const tiles = await aeroIn(lat - d, lon - d / k, lat + d, lon + d / k, this.abort.signal)
    let best = 4000
    let lit = false
    for (const t of tiles) {
      for (const l of t.labels) {
        const dist = Math.hypot((l.lat - lat) * 110574, (l.lon - lon) * 111320 * k)
        if (dist < best) {
          best = dist
          lit = l.iata || l.cls === 'international' || l.cls === 'military'
        }
      }
    }
    return lit
  }

  private async build(s: Site): Promise<void> {
    let ground: number | null = null
    try {
      await this.heights.ensure(s.lat - 0.0005, s.lon - 0.0007, s.lat + 0.0005, s.lon + 0.0007)
      ground = this.heights.sample(s.lat, s.lon)
      // pistas alisadas y rellenos de los puentes: la misma superficie que se dibuja
      const rw = this.runways()
      if (ground !== null && rw) ground = rw.adjust(s.lat, s.lon, ground)
    } catch {
      ground = null
    }
    if (this.disposed || this.sites.get(s.key) !== s) return
    if (ground === null) {
      s.state = 'failed'
      this.sites.delete(s.key) // se reintenta en la próxima pasada
      return
    }
    const root = new Group()
    root.matrixAutoUpdate = false
    const f = new GeoFrame()
    f.setOrigin(s.lat, s.lon, 0)
    root.matrix.copy(f.worldToECEF)
    const model = new Group()
    model.position.y = ground
    model.add(new Mesh(s.lit ? this.mastLitGeo : this.mastGeo, this.mats.steel))
    if (s.lit) model.add(new Mesh(this.lampGeo, this.mats.lamp))
    const head = new Group()
    head.position.y = MAST_H
    head.rotation.y = s.yaw
    head.add(new Mesh(this.frameGeo, this.mats.steel))
    const sock = new Mesh(sockGeometry(), s.lit ? this.mats.sockLit : this.mats.sock)
    head.add(sock)
    model.add(head)
    root.add(model)
    this.group.add(root)
    s.root = root
    s.model = model
    s.head = head
    s.sock = sock
    s.state = 'ready'
    this.syncSite(s)
    this.shape(s, 0, 0)
  }

  private drop(s: Site): void {
    if (!s.root) return
    s.root.removeFromParent()
    s.sock?.geometry.dispose()
    s.root = s.model = s.head = s.sock = undefined
  }

  /** Re-centrado del mundo. */
  syncFrame(): void {
    this.group.matrix.copy(this.frame.ecefToWorld)
    this.group.updateMatrixWorld(true)
    for (const s of this.sites.values()) if (s.state === 'ready') this.syncSite(s)
  }

  private syncSite(s: Site): void {
    if (!s.model) return
    this.group.updateMatrixWorld(true)
    s.toLocal.copy(s.model.matrixWorld).invert()
    s.top.set(RING_X, MAST_H + RING_Y, 0).applyMatrix4(s.model.matrixWorld)
  }

  // -------------------------------------------------------------------------
  // Viento y forma
  // -------------------------------------------------------------------------

  private animate(s: Site, dt: number, env: WindsockEnv): void {
    const { settings } = env
    const kTurb = settings.turbulence / TURBULENCE_UNIT
    // viento medio del sitio a la altura de la boca (cada ~0,25 s: cambia despacio)
    s.windAge += dt
    if (s.windAge > 0.25) {
      s.windAge = 0
      const w = env.field?.sampleAt(s.top, SOCK_AGL, env.simMs) ?? null
      if (w) {
        s.meanE = w.e
        s.meanN = w.n
        s.sigH = w.sigH * kTurb
        s.lenH = w.lenH
        s.sigSlow = w.sigSlow * kTurb
        s.lenSlow = w.lenSlow
      } else {
        // viento uniforme del menú con su perfil logarítmico (el mismo que ve el aparato sin el del terreno)
        const z0 = 0.05
        const u = settings.speed * Math.max(0, Math.log(SOCK_AGL / z0) / Math.log(10 / z0))
        const to = (settings.fromDeg + 180) * DEG
        s.meanE = Math.sin(to) * u
        s.meanN = Math.cos(to) * u
        s.sigH = settings.turbulence * (0.6 + 0.18 * settings.speed)
        s.lenH = 30
        s.sigSlow = 0
        s.lenSlow = 500
      }
    }
    // rachas en un punto fijo: la turbulencia pasa con el viento (hipótesis de Taylor), τ = L/U
    const U = Math.max(Math.hypot(s.meanE, s.meanN), 0.5)
    const g = s.gust
    g[0] = markov(g[0], dt, s.lenH / U, s.sigH)
    g[1] = markov(g[1], dt, s.lenH / U, s.sigH)
    g[2] = markov(g[2], dt, s.lenSlow / U, s.sigSlow)
    g[3] = markov(g[3], dt, s.lenSlow / U, s.sigSlow)
    const we = s.meanE + g[0] + g[2]
    const wn = s.meanN + g[1] + g[3]
    const w = Math.hypot(we, wn)
    // la tela se llena y se vacía en unas décimas
    s.speed += (w - s.speed) * (1 - Math.exp(-dt / 0.35))
    // veleta: muelle aerodinámico (rigidez ∝ U², ωn ≈ 0,8·U) con amortiguamiento ζ ≈ 0,4; sin viento,
    // solo el roce del cojinete
    if (w > 0.05) {
      // ejes de la cabeza: +x a sotavento; giro y de three.js: +x → (cos ψ, −sin ψ) en (x, z), z = sur
      const target = Math.atan2(wn, we) // (z = −norte)
      const wnat = 0.8 * w
      const steps = Math.max(1, Math.ceil((dt * wnat) / 0.2))
      const h = dt / steps
      for (let i = 0; i < steps; i++) {
        let e = target - s.yaw
        e = Math.atan2(Math.sin(e), Math.cos(e))
        s.yawRate += h * (wnat * wnat * Math.sin(e) - 2 * 0.4 * wnat * s.yawRate - 0.6 * s.yawRate)
        s.yaw += h * s.yawRate
      }
      s.yaw = Math.atan2(Math.sin(s.yaw), Math.cos(s.yaw))
    } else s.yawRate *= Math.exp(-dt * 0.6)
    // ondeo: más deprisa con más viento (de ~1 a ~3 Hz)
    s.phase += dt * 2 * Math.PI * (0.7 + 0.3 * s.speed)
    s.phase2 += dt * 2 * Math.PI * (0.45 + 0.17 * s.speed)
    const gusty = Math.min(1, (s.sigH + s.sigSlow) / Math.max(U, 1))
    this.shape(s, s.speed / KT, gusty)
  }

  /** Forma de la manga para un viento de `kt` nudos (y lo racheado, 0..1). */
  private shape(s: Site, kt: number, gusty: number): void {
    if (!s.head || !s.sock) return
    s.head.rotation.y = s.yaw
    const geo = s.sock.geometry
    const pos = geo.getAttribute('position') as BufferAttribute
    const nor = geo.getAttribute('normal') as BufferAttribute
    const P = pos.array as Float32Array
    const N = nor.array as Float32Array
    const ds = SOCK_LEN / NS
    // eje de la manga desde el centro de la boca, en los ejes de la cabeza (x a sotavento, y arriba, z lateral)
    _c.set(RING_X, RING_Y, 0)
    let prevLat = 0
    let prevUp = 0
    // amplitud del ondeo de la cola (m): crece con el viento, con lo racheado, y es máxima en
    // la manga a medio llenar (la cola floja da latigazos); con calma no hay
    const wind01 = Math.min(1, kt / 15)
    const ampLat = (0.05 + 0.22 * Math.sin(Math.PI * Math.min(1, kt / 18)) + 0.25 * gusty) * smoothstep(0.5, 3, kt)
    const ampUp = (0.04 + 0.08 * wind01) * smoothstep(1, 5, kt)
    for (let i = 0; i <= NS; i++) {
      const u = i / NS
      // franjas llenas: cada una ~3 kt (la primera a 3, todas a 15); tras la última llena, la
      // tela se va vaciando a lo largo de franja y media
      const fill = i === 0 ? 1 : smoothstep(-1.6, 0.05, kt / 3 - 5 * u)
      // caída bajo la horizontal: colgando sin viento, casi recta del todo llena (algo de comba hasta ~20 kt)
      const droop = 85 * DEG * Math.pow(1 - fill, 1.5) + 3 * DEG * u * (1 - Math.min(1, kt / 20))
      if (i > 0) {
        // ondeo: ondas que corren hacia la cola, a los lados y arriba-abajo
        const k = u * u
        const lat = ampLat * k * (Math.sin(s.phase - 2.4 * u * Math.PI) + 0.35 * Math.sin(1.7 * s.phase + 1.3 - 3.1 * u * Math.PI))
        const up = ampUp * k * Math.sin(s.phase2 * 1.3 - 2 * u * Math.PI)
        _t.set(Math.cos(droop) * ds, -Math.sin(droop) * ds + (up - prevUp), lat - prevLat)
        _c.add(_t)
        prevLat = lat
        prevUp = up
        _t.normalize()
      } else _t.set(1, 0, 0)
      // anillo: elipse (la tela floja se aplasta) perpendicular al eje
      _n2.copy(_z).addScaledVector(_t, -_z.dot(_t)).normalize()
      _n1.crossVectors(_t, _n2)
      const r = SOCK_R0 + (SOCK_R1 - SOCK_R0) * u
      const ra = i === 0 ? r : r * (0.18 + 0.82 * fill)
      const rb = i === 0 ? r : r * (0.55 + 0.45 * fill)
      for (let j = 0; j <= NR; j++) {
        const th = (j / NR) * Math.PI * 2
        const ca = Math.cos(th)
        const sa = Math.sin(th)
        const k = (i * (NR + 1) + j) * 3
        P[k] = _c.x + ra * ca * _n1.x + rb * sa * _n2.x
        P[k + 1] = _c.y + ra * ca * _n1.y + rb * sa * _n2.y
        P[k + 2] = _c.z + ra * ca * _n1.z + rb * sa * _n2.z
        _v.copy(_n1).multiplyScalar(ca / ra).addScaledVector(_n2, sa / rb).normalize()
        N[k] = _v.x
        N[k + 1] = _v.y
        N[k + 2] = _v.z
      }
    }
    pos.needsUpdate = true
    nor.needsUpdate = true
  }

  // -------------------------------------------------------------------------

  /** ¿El punto (mundo) choca con el mástil o la cabeza de alguna manga? (la tela no) */
  collides(p: Vector3): boolean {
    for (const s of this.sites.values()) {
      if (s.state !== 'ready') continue
      if (Math.abs(p.x - s.top.x) > 8 || Math.abs(p.z - s.top.z) > 8) continue
      _v.copy(p).applyMatrix4(s.toLocal)
      const rh = Math.hypot(_v.x, _v.z)
      if (rh < 0.3 && _v.y > -0.2 && _v.y < MAST_H + 0.2) return true
      if (rh < RING_X + SOCK_R0 + 0.1 && _v.y > MAST_H && _v.y < MAST_H + RING_Y + SOCK_R0 + 0.1) return true
    }
    return false
  }

  /** Para depurar y probar: sitios con su posición y estado. */
  get debug(): Array<{ key: string; lat: number; lon: number; lit: boolean; state: string; yawDeg: number; kt: number; top: number[] }> {
    return [...this.sites.values()].map((s) => ({
      key: s.key,
      lat: s.lat,
      lon: s.lon,
      lit: s.lit,
      state: s.state,
      yawDeg: s.yaw / DEG,
      kt: s.speed / KT,
      top: [s.top.x, s.top.y, s.top.z],
    }))
  }

  setEnvMap(tex: Texture | null): void {
    for (const m of Object.values(this.mats)) {
      if ((m.envMap === null) !== (tex === null)) m.needsUpdate = true
      m.envMap = tex
      m.envMapIntensity = 1
    }
  }

  dispose(): void {
    this.disposed = true
    this.abort.abort()
    for (const s of this.sites.values()) this.drop(s)
    this.sites.clear()
    this.mastGeo.dispose()
    this.mastLitGeo.dispose()
    this.lampGeo.dispose()
    this.frameGeo.dispose()
    this.mats.sock.map?.dispose()
    for (const m of Object.values(this.mats)) m.dispose()
  }
}

// ---------------------------------------------------------------------------

/** (lat, lon) de un punto de la pista: s a lo largo desde A, o lateral (+ a la derecha). */
function runwayPoint(r: Runway, s: number, o: number): [number, number] {
  const e = s * r.ux + o * r.uy
  const n = s * r.uy - o * r.ux
  return [r.lat0 + n / r.mLat, r.lon0 + e / r.mLon]
}

function runwayLocal(r: Runway, lat: number, lon: number): { s: number; o: number } {
  const e = (lon - r.lon0) * r.mLon
  const n = (lat - r.lat0) * r.mLat
  return { s: e * r.ux + n * r.uy, o: e * r.uy - n * r.ux }
}

/** ¿El punto es del mismo aeródromo que la pista? (a menos de 600 m del eje, sin pasar 400 m de los extremos) */
function nearRunway(r: Runway, lat: number, lon: number): boolean {
  const { s, o } = runwayLocal(r, lat, lon)
  return s > -400 && s < r.len + 400 && Math.abs(o) < 600
}
