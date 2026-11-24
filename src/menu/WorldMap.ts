// Mapa del mundo del menú (como el de los simuladores de vuelo): un globo terráqueo con la
// ortofoto de Esri que se gira y se acerca con el ratón, los aeródromos del mundo
// (OurAirports) y las salidas del simulador, un buscador (aeródromos, lugares y
// coordenadas) y una ficha para elegir la salida: una cabecera de pista (de OpenStreetMap)
// o cualquier punto del globo con su rumbo, en el suelo o en vuelo.
//
// Usa su propio WebGLRenderer mientras está abierto (el bucle principal deja de dibujar,
// ver main.ts) y lo libera al cerrarse.

import './worldMap.css'
import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Group,
  Matrix4,
  Mesh,
  PerspectiveCamera,
  Points,
  Quaternion,
  Ray,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
} from 'three'
import { GlobeControls, TilesRenderer } from '3d-tiles-renderer'
import * as TilesPlugins from '3d-tiles-renderer/plugins'
import { LOCATIONS, locationCountry, locationName, locationNote, type Location, type StartMode } from '../config.ts'
import { countryName, getLang, locale, t } from '../i18n.ts'
import { skipEsriPlaceholders } from '../world/esriImagery.ts'
import {
  distanceM,
  elevationAt,
  findRunways,
  formatDms,
  greatCircleM,
  isIcao,
  loadAirports,
  normalize,
  parseCoords,
  placeName,
  searchPlaces,
  waterAt,
  type Airport,
  type MapRunway,
  type PlaceResult,
} from './mapData.ts'

const { GeneratedSurfacePlugin, XYZTilesOverlay, ImageOverlayPlugin, TilesFadePlugin } = TilesPlugins as any

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
const ESRI_PLACES = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'
const DEG = Math.PI / 180
const KM = 1000
/** distancia de la salida en final a la cabecera: 3 NM (con 300 m sobre el suelo, la senda de 3°) */
const FINAL_M = 5556

/** Lo que el menú tiene elegido al abrir el mapa. */
export interface MapDeparture {
  locationId: string
  lat: number
  lon: number
  heading: number
  name: string
  start: StartMode
  /** dirección de la que viene el viento (grados): rumbo por defecto en un punto suelto */
  windFrom: number
}

/** Salida elegida en el mapa. */
export type MapPick =
  | { kind: 'location'; id: string; start: StartMode }
  | { kind: 'custom'; lat: number; lon: number; heading: number; name: string; start: StartMode }

// ---------------------------------------------------------------------------
// Marcadores: C = aeródromo con salidas del simulador, P = sitio emblemático,
// L/M/S = aeródromos de OurAirports (grande, mediano, pequeño)
// ---------------------------------------------------------------------------

type MarkerKind = 'C' | 'P' | 'L' | 'M' | 'S'

interface Marker {
  kind: MarkerKind
  lat: number
  lon: number
  /** posición ECEF (m) */
  x: number
  y: number
  z: number
  label: string
  title: string
  /** código IATA de un aeródromo del simulador (para buscarlo, p. ej. MAD) */
  iata?: string
  airport?: Airport
  /** salidas del simulador (C: las de ese aeródromo; P: la del sitio) */
  locs?: Location[]
}

/** tamaño del punto (px), color, altura de la vista máxima a la que se ve y a la que lleva nombre */
const STYLE: Record<MarkerKind, { size: number; color: number; maxAlt: number; labelAlt: number; rank: number }> = {
  C: { size: 12, color: 0xf6c400, maxAlt: Infinity, labelAlt: 2500 * KM, rank: 0 },
  P: { size: 9, color: 0x3fd4c8, maxAlt: 6000 * KM, labelAlt: 600 * KM, rank: 1 },
  L: { size: 7.5, color: 0xffffff, maxAlt: Infinity, labelAlt: 1500 * KM, rank: 2 },
  M: { size: 6, color: 0xcfe2ff, maxAlt: 2500 * KM, labelAlt: 450 * KM, rank: 3 },
  S: { size: 5, color: 0xaab8cc, maxAlt: 400 * KM, labelAlt: 70 * KM, rank: 4 },
}

const MARKER_VS = /* glsl */ `
attribute float aSize;
attribute vec3 aColor;
attribute float aMaxAlt;
uniform float uAlt;
uniform float uPx;
uniform vec3 uCam;
uniform float uShowAirports;
attribute float aIsAirport;
varying vec3 vColor;
void main() {
  vec3 p = position;
  // oculto si la vista está demasiado alta para su categoría o si queda tras el horizonte
  float vis = step(uAlt, aMaxAlt) * step(0.0, dot(p, uCam - p)) * max(1.0 - aIsAirport, uShowAirports);
  vColor = aColor;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  // más pequeños con el globo entero a la vista (si no, Europa y EE. UU. son una mancha)
  gl_PointSize = aSize * uPx * clamp(1.0 - (uAlt - 3.0e6) / 2.0e7, 0.6, 1.0);
  if (vis < 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`

const MARKER_FS = /* glsl */ `
varying vec3 vColor;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r = length(c);
  if (r > 1.0) discard;
  vec3 col = mix(vColor, vec3(0.04, 0.05, 0.08), smoothstep(0.6, 0.72, r));
  gl_FragColor = vec4(col, 1.0 - smoothstep(0.86, 1.0, r));
}
`

// halo de la atmósfera alrededor del globo visto desde lejos
const GLOW_VS = /* glsl */ `
varying vec3 vN;
varying vec3 vV;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`
const GLOW_FS = /* glsl */ `
uniform float uOpacity;
varying vec3 vN;
varying vec3 vV;
void main() {
  float k = pow(clamp(0.72 + dot(vN, vV), 0.0, 1.0), 3.0);
  gl_FragColor = vec4(vec3(0.35, 0.62, 1.0) * k * uOpacity, 1.0);
}
`

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function fmtKm(m: number): string {
  const nf = (v: number, d = 0) => v.toLocaleString(locale(), { maximumFractionDigits: d })
  return m >= 10 * KM ? `${nf(m / KM)} km` : m >= KM ? `${nf(m / KM, 1)} km` : `${nf(m)} m`
}

const hdg3 = (h: number) => String(Math.round(((h % 360) + 360) % 360) || 360).padStart(3, '0')

/** La parte del nombre antes / después de « · » (salidas del simulador). */
function headPart(s: string): string {
  const i = s.indexOf(' · ')
  return i < 0 ? s : s.slice(0, i)
}
function tailPart(s: string): string {
  const i = s.indexOf(' · ')
  return i < 0 ? s : s.slice(i + 3)
}

interface Tween {
  t: number
  dur: number
  from: { dir: Vector3; h: number; q: Quaternion }
  to: { lat: number; lon: number; h: number }
  peak: number
}

/** Opción elegida en la ficha (para resaltarla). */
type ChoiceKey = string

export class WorldMap {
  isOpen = false

  private root: HTMLElement | null = null
  private dep: MapDeparture | null = null
  private onPick: ((p: MapPick, fly: boolean) => void) | null = null

  private renderer: WebGLRenderer | null = null
  private scene = new Scene()
  private camera = new PerspectiveCamera(40, 1, 1, 1e8)
  private tiles: any = null
  private controls: GlobeControls | null = null
  private labelsOverlay: any = null
  private overlayPlugin: any = null
  private ecefGroup = new Group()
  private glow: Mesh<SphereGeometry, ShaderMaterial> | null = null
  private points: Points<BufferGeometry, ShaderMaterial> | null = null
  private raf = 0
  private lastT = 0

  private markers: Marker[] = []
  private airportsReady = false
  private showAirports = true
  private tween: Tween | null = null

  // vista
  private camEcef = new Vector3()
  private alt = 1e7
  private viewKey = ''
  private labelT = 0
  private labelsDirty = true
  private placed: Array<{ m: Marker; el: HTMLElement; w: number }> = []
  private hover: Marker | null = null
  private mouse = { x: 0, y: 0, inside: false, moved: false }
  private down: { x: number; y: number; t: number } | null = null

  // ficha
  private selected: { kind: 'marker'; m: Marker } | { kind: 'point'; lat: number; lon: number } | null = null
  private choice: MapPick | null = null
  private choiceKey: ChoiceKey = ''
  private start: StartMode = 'runway'
  private pointHeading = 0
  private abort: AbortController | null = null
  private cardState: {
    runways: MapRunway[] | null
    runwayError: boolean
    elev: number | null
    /** el punto pinchado es agua (mar, lago…) */
    water: boolean
    place: string | null
    nearest: { a: Airport; d: number } | null
  } = { runways: null, runwayError: false, elev: null, water: false, place: null, nearest: null }

  // búsqueda
  private searchAbort: AbortController | null = null
  private results: Array<{ icon: string; name: string; detail: string; go: () => void }> = []
  private resultSel = 0

  private readonly onKey = (e: KeyboardEvent) => this.handleKey(e)
  private readonly onResize = () => this.resize()

  // -------------------------------------------------------------------------
  // Abrir y cerrar
  // -------------------------------------------------------------------------
  open(dep: MapDeparture, onPick: (p: MapPick, fly: boolean) => void): void {
    if (this.isOpen) return
    this.isOpen = true
    this.dep = dep
    this.onPick = onPick
    this.start = dep.start
    this.pointHeading = Math.round(dep.windFrom / 5) * 5
    this.selected = null
    this.choice = null
    this.choiceKey = ''
    this.buildDom()
    this.buildGlobe()
    this.buildMarkers()
    window.addEventListener('keydown', this.onKey, true)
    window.addEventListener('resize', this.onResize)
    this.resize()
    // entrada: del globo entero a la zona de la salida actual
    this.setView(dep.lat, dep.lon, 16000 * KM)
    this.flyTo(dep.lat, dep.lon, 2200 * KM, 1.8)
    this.renderCard()
    this.lastT = performance.now()
    const loop = (tt: number) => {
      this.raf = requestAnimationFrame(loop)
      this.frame(tt)
    }
    this.raf = requestAnimationFrame(loop)
    // los aeródromos del mundo llegan después (3 MB)
    void loadAirports()
      .then((list) => {
        if (!this.isOpen) return
        this.addAirports(list)
      })
      .catch(() => this.root?.querySelector('.wm-apt-error')?.classList.remove('hidden'))
  }

  close(): void {
    if (!this.isOpen) return
    this.isOpen = false
    cancelAnimationFrame(this.raf)
    window.removeEventListener('keydown', this.onKey, true)
    window.removeEventListener('resize', this.onResize)
    this.abort?.abort()
    this.searchAbort?.abort()
    this.controls?.dispose()
    this.controls = null
    if (this.tiles) {
      this.scene.remove(this.tiles.group)
      this.tiles.dispose()
      this.tiles = null
    }
    for (const o of [this.glow, this.points]) {
      if (!o) continue
      o.removeFromParent()
      o.geometry.dispose()
      o.material.dispose()
    }
    this.glow = null
    this.points = null
    this.scene.remove(this.ecefGroup)
    this.labelsOverlay = null
    this.overlayPlugin = null
    this.renderer?.dispose()
    this.renderer?.forceContextLoss()
    this.renderer = null
    this.root?.remove()
    this.root = null
    this.markers = []
    this.placed = []
    this.airportsReady = false
    this.tween = null
  }

  // -------------------------------------------------------------------------
  // DOM
  // -------------------------------------------------------------------------
  private buildDom(): void {
    const root = document.createElement('div')
    root.id = 'worldmap'
    root.className = 'wm'
    root.innerHTML = `
      <canvas class="wm-stars"></canvas>
      <div class="wm-gl"></div>
      <div class="wm-layer"></div>
      <div class="wm-tip hidden"></div>
      <div class="wm-top">
        <div class="wm-search">
          <svg class="wm-search-ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/></svg>
          <input type="search" spellcheck="false" autocomplete="off" placeholder="${esc(t('wm.search'))}" aria-label="${esc(t('wm.search'))}" />
          <div class="wm-results hidden" role="listbox"></div>
        </div>
        <div class="wm-tools">
          <button type="button" class="wm-btn wm-home" title="${esc(t('wm.homeTitle'))}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>
            <span>${esc(t('wm.home'))}</span>
          </button>
          <label class="wm-btn wm-check"><input type="checkbox" class="wm-t-apt" checked /> <span>${esc(t('wm.airports'))}</span></label>
          <label class="wm-btn wm-check"><input type="checkbox" class="wm-t-names" /> <span>${esc(t('wm.names'))}</span></label>
          <button type="button" class="wm-btn wm-close" title="${esc(t('wm.close'))}" aria-label="${esc(t('wm.close'))}">✕</button>
        </div>
      </div>
      <aside class="wm-card"></aside>
      <div class="wm-hint">${esc(t('wm.hint'))}</div>
      <div class="wm-bottom">
        <div class="wm-readout"><span class="wm-cursor"></span><span class="wm-alt"></span></div>
        <div class="wm-legend">
          <span><i class="dot c"></i>${esc(t('wm.legend.sim'))}</span>
          <span><i class="dot p"></i>${esc(t('wm.legend.scenic'))}</span>
          <span><i class="dot l"></i>${esc(t('wm.legend.airports'))}</span>
          <span class="wm-apt-error hidden">${esc(t('wm.airportsError'))}</span>
        </div>
        <div class="wm-attrib">${esc(t('wm.attrib'))}</div>
      </div>`
    document.body.appendChild(root)
    this.root = root

    const input = root.querySelector<HTMLInputElement>('.wm-search input')!
    input.addEventListener('input', () => this.localSearch(input.value))
    input.addEventListener('focus', () => input.value && this.localSearch(input.value))
    root.querySelector('.wm-close')!.addEventListener('click', () => this.close())
    root.querySelector('.wm-home')!.addEventListener('click', () => {
      const d = this.dep!
      this.flyTo(d.lat, d.lon, 60 * KM, 1.6)
    })
    root.querySelector<HTMLInputElement>('.wm-t-apt')!.addEventListener('change', (e) => {
      this.showAirports = (e.target as HTMLInputElement).checked
      this.viewKey = ''
    })
    root.querySelector<HTMLInputElement>('.wm-t-names')!.addEventListener('change', (e) => this.setPlaceNames((e.target as HTMLInputElement).checked))
    const results = root.querySelector<HTMLElement>('.wm-results')!
    results.addEventListener('mousedown', (e) => e.preventDefault()) // que el campo no pierda el foco
    results.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-i]')
      if (row) this.results[Number(row.dataset.i)]?.go()
    })
    input.addEventListener('blur', () => setTimeout(() => results.classList.add('hidden'), 150))

    const card = root.querySelector<HTMLElement>('.wm-card')!
    card.addEventListener('click', (e) => this.onCardClick(e))
    card.addEventListener('input', (e) => {
      const el = e.target as HTMLInputElement
      if (el.classList.contains('wm-hdg')) {
        // mover el rumbo elige la salida en el punto
        this.pointHeading = Number(el.value)
        this.choiceKey = 'point'
        this.setPointChoice()
        el.parentElement!.querySelector('output')!.textContent = `${hdg3(this.pointHeading)}°`
        card.querySelectorAll('.wm-opt.on').forEach((o) => o.classList.remove('on'))
        card.querySelector('[data-act=point]')?.classList.add('on')
        const sum = card.querySelector('.wm-summary')
        if (sum && this.choice) sum.textContent = t('wm.departure', { name: this.choiceName(this.choice) })
        card.querySelectorAll<HTMLButtonElement>('.wm-actions button').forEach((b) => (b.disabled = false))
      }
    })
    this.drawStars()
  }

  private drawStars(): void {
    const cv = this.root!.querySelector<HTMLCanvasElement>('.wm-stars')!
    const w = (cv.width = Math.min(2560, window.innerWidth))
    const h = (cv.height = Math.min(1600, window.innerHeight))
    const ctx = cv.getContext('2d')!
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646
    for (let i = 0; i < (w * h) / 3500; i++) {
      const a = 0.15 + rnd() ** 3 * 0.85
      ctx.fillStyle = `rgba(${200 + rnd() * 55}, ${210 + rnd() * 45}, 255, ${a})`
      const r = rnd() < 0.04 ? 1.4 : 0.8
      ctx.beginPath()
      ctx.arc(rnd() * w, rnd() * h, r, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // -------------------------------------------------------------------------
  // Globo
  // -------------------------------------------------------------------------
  private buildGlobe(): void {
    const renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
    renderer.setClearColor(0x000000, 0)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.root!.querySelector('.wm-gl')!.appendChild(renderer.domElement)
    this.renderer = renderer

    const tiles = new TilesRenderer()
    tiles.registerPlugin(
      new GeneratedSurfacePlugin({
        // (donde Esri no tiene imagen a un nivel, la del nivel anterior en vez de su cartel gris)
        overlay: skipEsriPlaceholders(new XYZTilesOverlay({ url: ESRI, levels: 19 })),
        applyOverlayTexture: true,
      }),
    )
    tiles.registerPlugin(new TilesFadePlugin({ fadeDuration: 250 }))
    // capa de nombres de países y ciudades (se añade o se quita con su casilla)
    this.overlayPlugin = new ImageOverlayPlugin({ overlays: [], renderer, resolution: 256 })
    tiles.registerPlugin(this.overlayPlugin)
    tiles.errorTarget = 1.5
    tiles.group.rotation.x = -Math.PI / 2 // polo norte hacia +Y
    this.scene.add(tiles.group)
    tiles.group.updateMatrixWorld(true)
    // halo y marcadores en ECEF: grupo propio con el mismo giro (el de las teselas no
    // actualiza la matriz de los hijos que no son suyos)
    this.ecefGroup = new Group()
    this.ecefGroup.rotation.x = -Math.PI / 2
    this.scene.add(this.ecefGroup)
    tiles.setCamera(this.camera)
    tiles.setResolutionFromRenderer(this.camera, renderer)
    this.tiles = tiles

    const controls = new GlobeControls(this.scene, this.camera, renderer.domElement)
    controls.setScene(tiles.group)
    controls.setEllipsoid(tiles.ellipsoid, tiles.group)
    controls.enableDamping = true
    controls.minDistance = 150
    controls.farMargin = 0.35 // el halo de la atmósfera queda por detrás del horizonte
    // sin el círculo blanco que la librería pinta donde se agarra el globo al arrastrar o
    // girar (el usuario lo veía «atravesando la pista» sin saber qué era)
    ;((controls as unknown as { pivotMesh: Mesh<BufferGeometry, ShaderMaterial> }).pivotMesh.material).visible = false
    this.controls = controls

    // halo
    const a = tiles.ellipsoid.radius.x as number
    const glow = new Mesh(
      new SphereGeometry(a * 1.03, 96, 48),
      new ShaderMaterial({
        vertexShader: GLOW_VS,
        fragmentShader: GLOW_FS,
        uniforms: { uOpacity: { value: 1 } },
        side: BackSide,
        blending: AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }),
    )
    glow.renderOrder = 1
    this.ecefGroup.add(glow)
    this.glow = glow

    // entrada del ratón: el clic (sin arrastrar) elige; con los controles se gira y acerca
    const el = renderer.domElement
    el.addEventListener('pointerdown', (e) => {
      if (this.tween) this.endTween()
      this.down = { x: e.clientX, y: e.clientY, t: performance.now() }
      this.root?.querySelector('.wm-hint')?.classList.add('gone')
      ;(document.activeElement as HTMLElement | null)?.blur?.()
    }, true)
    el.addEventListener('wheel', () => {
      if (this.tween) this.endTween()
      this.root?.querySelector('.wm-hint')?.classList.add('gone')
    }, { capture: true, passive: true })
    el.addEventListener('pointerup', (e) => {
      const d = this.down
      this.down = null
      if (!d || e.button !== 0) return
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5 || performance.now() - d.t > 450) return
      this.clickAt(e.clientX, e.clientY)
    })
    el.addEventListener('pointermove', (e) => {
      this.mouse.x = e.clientX
      this.mouse.y = e.clientY
      this.mouse.inside = true
      this.mouse.moved = true
    })
    el.addEventListener('pointerleave', () => {
      this.mouse.inside = false
      this.mouse.moved = true
    })
  }

  private setPlaceNames(on: boolean): void {
    if (!this.overlayPlugin) return
    if (on) {
      this.labelsOverlay ??= new XYZTilesOverlay({ url: ESRI_PLACES, levels: 17 })
      this.overlayPlugin.addOverlay(this.labelsOverlay)
    } else if (this.labelsOverlay) {
      this.overlayPlugin.deleteOverlay(this.labelsOverlay)
    }
  }

  private resize(): void {
    const r = this.renderer
    if (!r) return
    const w = window.innerWidth
    const h = window.innerHeight
    r.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.tiles?.setResolutionFromRenderer(this.camera, r)
    this.viewKey = ''
  }

  // -------------------------------------------------------------------------
  // Cámara: posición por coordenadas y vuelos animados
  // -------------------------------------------------------------------------
  private readonly v1 = new Vector3()
  private readonly v2 = new Vector3()
  private readonly v3 = new Vector3()
  private readonly m4 = new Matrix4()
  private readonly carto = { lat: 0, lon: 0, height: 0 }

  /** ECEF → escena */
  private toWorld(v: Vector3): Vector3 {
    return v.applyMatrix4(this.tiles.group.matrixWorld)
  }

  /** Orientación mirando al centro de la Tierra con el norte arriba. */
  private topDown(lat: number, lon: number, pos: Vector3, out: Quaternion): Quaternion {
    const east = this.v2
    const north = this.v3
    const up = new Vector3()
    this.tiles.ellipsoid.getEastNorthUpAxes(lat * DEG, lon * DEG, east, north, up)
    north.transformDirection(this.tiles.group.matrixWorld)
    const center = new Vector3().setFromMatrixPosition(this.tiles.group.matrixWorld)
    this.m4.lookAt(pos, center, north)
    return out.setFromRotationMatrix(this.m4)
  }

  private setView(lat: number, lon: number, h: number): void {
    const cam = this.camera
    this.toWorld(this.tiles.ellipsoid.getCartographicToPosition(lat * DEG, lon * DEG, h, cam.position))
    this.topDown(lat, lon, cam.position, cam.quaternion)
    cam.updateMatrixWorld()
  }

  /** Vuelo animado (arco por encima si el destino está lejos). */
  private flyTo(lat: number, lon: number, h: number, dur = 1.6): void {
    if (!this.tiles) return
    const cam = this.camera
    const local = this.v1.copy(cam.position).applyMatrix4(this.m4.copy(this.tiles.group.matrixWorld).invert())
    this.tiles.ellipsoid.getPositionToCartographic(local, this.carto)
    const lat0 = this.carto.lat / DEG
    const lon0 = this.carto.lon / DEG
    const h0 = this.carto.height
    const dist = greatCircleM(lat0, lon0, lat, lon)
    const peak = Math.max(h0, h, Math.min(dist * 0.55, 9000 * KM))
    this.tween = {
      t: 0,
      dur: dist < 1 && Math.abs(h - h0) < 1 ? 0.01 : dur,
      from: { dir: new Vector3(lat0, lon0, 0), h: h0, q: cam.quaternion.clone() },
      to: { lat, lon, h },
      peak,
    }
    if (this.controls) this.controls.enabled = false
  }

  private endTween(): void {
    this.tween = null
    if (this.controls) {
      this.controls.enabled = true
      this.controls.setCamera(this.camera)
    }
  }

  private stepTween(dt: number): void {
    const tw = this.tween!
    tw.t = Math.min(1, tw.t + dt / tw.dur)
    const e = tw.t < 0.5 ? 4 * tw.t ** 3 : 1 - (-2 * tw.t + 2) ** 3 / 2 // suave al salir y al llegar
    // posición: interpolación esférica de la dirección (por latitud/longitud vía vectores)
    const a = this.unit(tw.from.dir.x, tw.from.dir.y, new Vector3())
    const b = this.unit(tw.to.lat, tw.to.lon, new Vector3())
    const ang = a.angleTo(b)
    const dir =
      ang < 1e-9
        ? a
        : a.clone().multiplyScalar(Math.sin((1 - e) * ang) / Math.sin(ang)).add(b.clone().multiplyScalar(Math.sin(e * ang) / Math.sin(ang)))
    const lat = Math.asin(Math.max(-1, Math.min(1, dir.z / dir.length()))) / DEG
    const lon = Math.atan2(dir.y, dir.x) / DEG
    const base = tw.from.h + (tw.to.h - tw.from.h) * e
    const hump = Math.max(0, tw.peak - Math.max(tw.from.h, tw.to.h)) * Math.sin(Math.PI * e)
    // la altura cambia en escala logarítmica: de 16 000 km a 50 km sin un frenazo final
    const h = tw.from.h > 0 && tw.to.h > 0 ? Math.exp(Math.log(tw.from.h) + (Math.log(tw.to.h) - Math.log(tw.from.h)) * e) + hump : base + hump
    const cam = this.camera
    this.toWorld(this.tiles.ellipsoid.getCartographicToPosition(lat * DEG, lon * DEG, h, cam.position))
    const q = this.topDown(lat, lon, cam.position, new Quaternion())
    cam.quaternion.copy(tw.from.q).slerp(q, Math.min(1, e * 1.6))
    cam.updateMatrixWorld()
    // planos de recorte para la nueva altura (los controles no se actualizan durante el vuelo)
    this.controls?.adjustCamera(cam)
    if (tw.t >= 1) this.endTween()
  }

  private unit(lat: number, lon: number, out: Vector3): Vector3 {
    return out.set(Math.cos(lat * DEG) * Math.cos(lon * DEG), Math.cos(lat * DEG) * Math.sin(lon * DEG), Math.sin(lat * DEG))
  }

  /** Punto del elipsoide bajo un píxel (lat/lon en grados) o null si cae al espacio. */
  private pick(px: number, py: number): { lat: number; lon: number } | null {
    if (!this.tiles) return null
    const ndc = new Vector3((px / window.innerWidth) * 2 - 1, -(py / window.innerHeight) * 2 + 1, 0.5)
    const cam = this.camera
    const origin = cam.position.clone()
    const dirW = ndc.unproject(cam).sub(origin).normalize()
    const inv = this.m4.copy(this.tiles.group.matrixWorld).invert()
    const ray = new Ray(origin.applyMatrix4(inv), dirW.transformDirection(inv))
    const hit = this.tiles.ellipsoid.intersectRay(ray, new Vector3())
    if (!hit) return null
    this.tiles.ellipsoid.getPositionToCartographic(hit, this.carto)
    return { lat: this.carto.lat / DEG, lon: this.carto.lon / DEG }
  }

  // -------------------------------------------------------------------------
  // Marcadores
  // -------------------------------------------------------------------------
  private ecef(lat: number, lon: number): Vector3 {
    return this.tiles.ellipsoid.getCartographicToPosition(lat * DEG, lon * DEG, 0, new Vector3())
  }

  private buildMarkers(): void {
    // salidas del simulador: una por aeródromo (por su código OACI) y una por sitio
    const groups = new Map<string, Location[]>()
    const loose: Location[] = []
    for (const l of LOCATIONS) {
      if (l.group !== 'airfield') {
        this.addMarker('P', l.lat, l.lon, headPart(locationName(l)), locationName(l), { locs: [l] })
        continue
      }
      const icao = /\(([A-Z0-9]{4})\)/.exec(l.name)?.[1]
      if (!icao) {
        loose.push(l)
        continue
      }
      if (!groups.has(icao)) groups.set(icao, [])
      groups.get(icao)!.push(l)
    }
    // salidas sin código (el circuito de Casarrubios): al aeródromo más cercano
    for (const l of loose) {
      let best: Location[] | null = null
      let bd = 8000
      for (const g of groups.values()) {
        const d = distanceM(l.lat, l.lon, g[0].lat, g[0].lon)
        if (d < bd) [bd, best] = [d, g]
      }
      if (best) best.push(l)
      else groups.set(l.id, [l])
    }
    for (const [code, locs] of groups) {
      const rw = locs.filter((l) => l.runway)
      const ref = rw.length ? rw : locs
      const lat = ref.reduce((s, l) => s + l.lat, 0) / ref.length
      const lon = ref.reduce((s, l) => s + l.lon, 0) / ref.length
      const title = headPart(locationName(rw[0] ?? locs[0]))
      this.addMarker('C', lat, lon, isIcao(code) ? code : title, title, { locs })
    }
    this.rebuildPoints()
  }

  private addMarker(kind: MarkerKind, lat: number, lon: number, label: string, title: string, extra: Partial<Marker>): Marker {
    const p = this.ecef(lat, lon)
    const m: Marker = { kind, lat, lon, x: p.x, y: p.y, z: p.z, label, title, ...extra }
    this.markers.push(m)
    return m
  }

  private addAirports(list: Airport[]): void {
    const sim = new Map(this.markers.filter((m) => m.kind === 'C').map((m) => [m.label, m]))
    for (const a of list) {
      const own = sim.get(a.code)
      if (own) {
        // ya está como aeródromo del simulador: solo se le apunta el código IATA
        if (a.iata) own.iata = a.iata
        continue
      }
      const label = isIcao(a.code) ? a.code : a.name.length > 26 ? `${a.name.slice(0, 24)}…` : a.name
      this.addMarker(a.kind, a.lat, a.lon, label, a.name, { airport: a })
    }
    // primero los pequeños: los importantes se dibujan encima
    this.markers.sort((p, q) => STYLE[q.kind].rank - STYLE[p.kind].rank)
    this.airportsReady = true
    this.rebuildPoints()
    this.viewKey = ''
  }

  private rebuildPoints(): void {
    const n = this.markers.length
    const pos = new Float32Array(n * 3)
    const col = new Float32Array(n * 3)
    const size = new Float32Array(n)
    const maxAlt = new Float32Array(n)
    const isApt = new Float32Array(n)
    this.markers.forEach((m, i) => {
      const st = STYLE[m.kind]
      pos.set([m.x, m.y, m.z], i * 3)
      col.set([((st.color >> 16) & 255) / 255, ((st.color >> 8) & 255) / 255, (st.color & 255) / 255], i * 3)
      size[i] = st.size
      maxAlt[i] = Math.min(st.maxAlt, 1e12)
      isApt[i] = m.airport ? 1 : 0
    })
    const geo = new BufferGeometry()
    geo.setAttribute('position', new BufferAttribute(pos, 3))
    geo.setAttribute('aColor', new BufferAttribute(col, 3))
    geo.setAttribute('aSize', new BufferAttribute(size, 1))
    geo.setAttribute('aMaxAlt', new BufferAttribute(maxAlt, 1))
    geo.setAttribute('aIsAirport', new BufferAttribute(isApt, 1))
    if (this.points) {
      this.points.geometry.dispose()
      this.points.geometry = geo
    } else {
      this.points = new Points(
        geo,
        new ShaderMaterial({
          vertexShader: MARKER_VS,
          fragmentShader: MARKER_FS,
          uniforms: { uAlt: { value: 0 }, uPx: { value: 1 }, uCam: { value: new Vector3() }, uShowAirports: { value: 1 } },
          transparent: true,
          depthTest: false,
          depthWrite: false,
        }),
      )
      this.points.frustumCulled = false
      this.points.renderOrder = 2
      this.ecefGroup.add(this.points)
    }
  }

  private visible(m: Marker): boolean {
    if (m.airport && !this.showAirports) return false
    if (this.alt > STYLE[m.kind].maxAlt) return false
    const c = this.camEcef
    return m.x * (c.x - m.x) + m.y * (c.y - m.y) + m.z * (c.z - m.z) > 0
  }

  /** Matriz ECEF → NDC de la vista actual. */
  private projMatrix(): Matrix4 {
    return this.m4
      .copy(this.camera.projectionMatrix)
      .multiply(this.camera.matrixWorldInverse)
      .multiply(this.tiles.group.matrixWorld)
  }

  /** Píxel de un punto ECEF (null si queda detrás de la cámara o fuera de la pantalla). */
  private screen(e: number[], x: number, y: number, z: number, margin = 40): { sx: number; sy: number } | null {
    const w = e[3] * x + e[7] * y + e[11] * z + e[15]
    if (w <= 0) return null
    const nx = (e[0] * x + e[4] * y + e[8] * z + e[12]) / w
    const ny = (e[1] * x + e[5] * y + e[9] * z + e[13]) / w
    const sx = (nx * 0.5 + 0.5) * window.innerWidth
    const sy = (-ny * 0.5 + 0.5) * window.innerHeight
    if (sx < -margin || sy < -margin || sx > window.innerWidth + margin || sy > window.innerHeight + margin) return null
    return { sx, sy }
  }

  /** Marcador bajo el ratón (a menos de 11 px). */
  private markerAt(px: number, py: number): Marker | null {
    const e = this.projMatrix().elements
    let best: Marker | null = null
    let bd = 11 * 11
    let bestRank = 9
    for (const m of this.markers) {
      if (!this.visible(m)) continue
      const s = this.screen(e, m.x, m.y, m.z, 0)
      if (!s) continue
      const d = (s.sx - px) ** 2 + (s.sy - py) ** 2
      const rank = STYLE[m.kind].rank
      // a igual cercanía, el más importante
      if (d < bd - 9 || (d <= bd + 9 && rank < bestRank)) {
        bd = Math.min(bd, d)
        best = m
        bestRank = rank
      }
    }
    return best
  }

  // -------------------------------------------------------------------------
  // Fotograma
  // -------------------------------------------------------------------------
  private frame(tt: number): void {
    const dt = Math.min(0.1, (tt - this.lastT) / 1000)
    this.lastT = tt
    const r = this.renderer
    if (!r || !this.tiles || !this.controls) return
    if (this.tween) this.stepTween(dt)
    else this.controls.update(dt)
    this.camera.updateMatrixWorld()

    // altura de la vista y cámara en ECEF
    const inv = this.v1.copy(this.camera.position).applyMatrix4(this.m4.copy(this.tiles.group.matrixWorld).invert())
    this.camEcef.copy(inv)
    this.tiles.ellipsoid.getPositionToCartographic(inv, this.carto)
    this.alt = Math.max(1, this.carto.height)

    this.tiles.update()

    const glowOn = Math.min(1, Math.max(0, (this.alt - 400 * KM) / (2500 * KM)))
    this.glow!.material.uniforms.uOpacity.value = glowOn
    this.glow!.visible = glowOn > 0
    if (this.points) {
      const u = this.points.material.uniforms
      u.uAlt.value = this.alt
      u.uPx.value = r.getPixelRatio()
      u.uCam.value.copy(this.camEcef)
      u.uShowAirports.value = this.showAirports ? 1 : 0
    }
    r.render(this.scene, this.camera)

    this.updateOverlay(tt)
  }

  /** Nombres, marcador de salida, selección, cursor y altura (capa HTML sobre el globo). */
  private updateOverlay(tt: number): void {
    const root = this.root!
    const e = this.projMatrix().elements.slice()
    const key = e.map((v) => v.toPrecision(6)).join(',')
    const moved = key !== this.viewKey
    if (moved) {
      this.viewKey = key
      this.labelsDirty = true
    }
    // recolocar los nombres mientras la vista cambia (como mucho cada 120 ms) y una vez al pararse
    if (this.labelsDirty && tt - this.labelT > 120) {
      this.layoutLabels(e)
      this.labelT = tt
      if (!moved) this.labelsDirty = false
    }
    // los nombres ya colocados siguen a sus puntos en cada fotograma
    for (const p of this.placed) {
      const s = this.visible(p.m) ? this.screen(e, p.m.x, p.m.y, p.m.z) : null
      if (!s) {
        p.el.style.display = 'none'
        continue
      }
      p.el.style.display = ''
      p.el.style.transform = `translate(${s.sx + STYLE[p.m.kind].size / 2 + 3}px, ${s.sy - 9}px)`
    }

    // marcador de la salida elegida (o la actual) con la flecha del rumbo
    const dep = root.querySelector<HTMLElement>('.wm-dep') ?? this.makeDepMarker()
    const target = this.departureSpot()
    const ds = target ? this.spot(e, target.lat, target.lon) : null
    if (target && ds) {
      dep.style.display = ''
      dep.style.transform = `translate(${ds.sx}px, ${ds.sy}px)`
      const ahead = this.offset(target.lat, target.lon, target.heading, Math.max(50, this.alt * 0.05))
      const as = this.spot(e, ahead.lat, ahead.lon)
      const arrow = dep.querySelector<HTMLElement>('.arrow')!
      arrow.style.display = target.showHeading && as ? '' : 'none'
      if (as) arrow.style.transform = `rotate(${Math.atan2(as.sx - ds.sx, -(as.sy - ds.sy))}rad)`
      dep.querySelector('.tag')!.textContent = this.choice ? t('wm.chosen') : t('wm.current')
    } else dep.style.display = 'none'

    // selección
    const sel = root.querySelector<HTMLElement>('.wm-sel') ?? this.makeSelMarker()
    const sp = this.selected ? (this.selected.kind === 'marker' ? this.selected.m : this.selected) : null
    const ss = sp ? this.spot(e, sp.lat, sp.lon) : null
    if (ss) {
      sel.style.display = ''
      sel.style.transform = `translate(${ss.sx}px, ${ss.sy}px)`
    } else sel.style.display = 'none'

    // ratón: coordenadas bajo el cursor y nombre del marcador
    if (this.mouse.moved || moved) {
      this.mouse.moved = false
      const tip = root.querySelector<HTMLElement>('.wm-tip')!
      const cur = root.querySelector<HTMLElement>('.wm-cursor')!
      const geo = this.mouse.inside ? this.pick(this.mouse.x, this.mouse.y) : null
      cur.textContent = geo ? formatDms(geo.lat, geo.lon, getLang() === 'es' ? 'O' : 'W') : ''
      const m = this.mouse.inside && !this.tween ? this.markerAt(this.mouse.x, this.mouse.y) : null
      this.hover = m
      this.renderer!.domElement.style.cursor = m ? 'pointer' : ''
      if (m) {
        tip.innerHTML = `<b>${esc(m.title)}</b><small>${esc(this.markerSub(m))}</small>`
        tip.classList.remove('hidden')
        const x = Math.min(window.innerWidth - tip.offsetWidth - 8, this.mouse.x + 14)
        tip.style.transform = `translate(${x}px, ${this.mouse.y + 16}px)`
      } else tip.classList.add('hidden')
    }
    root.querySelector('.wm-alt')!.textContent = t('wm.alt', { h: fmtKm(this.alt) })
  }

  /** Píxel de un punto en lat/lon si se ve (delante del horizonte y en pantalla). */
  private spot(e: number[], lat: number, lon: number): { sx: number; sy: number } | null {
    const p = this.ecef(lat, lon)
    const c = this.camEcef
    if (p.x * (c.x - p.x) + p.y * (c.y - p.y) + p.z * (c.z - p.z) <= 0) return null
    return this.screen(e, p.x, p.y, p.z)
  }

  /** Punto a `d` metros en el rumbo `hdg`. */
  private offset(lat: number, lon: number, hdg: number, d: number): { lat: number; lon: number } {
    return {
      lat: lat + (Math.cos(hdg * DEG) * d) / 110574,
      lon: lon + (Math.sin(hdg * DEG) * d) / (111320 * Math.max(0.01, Math.cos(lat * DEG))),
    }
  }

  private layoutLabels(e: number[]): void {
    const layer = this.root!.querySelector<HTMLElement>('.wm-layer')!
    type Cand = { m: Marker; sx: number; sy: number; score: number }
    const cands: Cand[] = []
    const cx = window.innerWidth / 2
    const cy = window.innerHeight / 2
    for (const m of this.markers) {
      if (this.alt > STYLE[m.kind].labelAlt || !this.visible(m)) continue
      const s = this.screen(e, m.x, m.y, m.z, 0)
      if (!s) continue
      cands.push({ m, ...s, score: STYLE[m.kind].rank * 1e7 + (s.sx - cx) ** 2 + (s.sy - cy) ** 2 })
    }
    cands.sort((p, q) => p.score - q.score)
    const boxes: Array<[number, number, number, number]> = []
    const keep: Array<{ m: Marker; w: number }> = []
    for (const c of cands) {
      if (keep.length >= 70) break
      const w = c.m.label.length * 7 + 10
      const x0 = c.sx + STYLE[c.m.kind].size / 2 + 3
      const box: [number, number, number, number] = [x0 - 2, c.sy - 11, x0 + w + 2, c.sy + 11]
      if (boxes.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue
      boxes.push(box)
      keep.push({ m: c.m, w })
    }
    // reutilizar los elementos de los que siguen
    const old = new Map(this.placed.map((p) => [p.m, p]))
    const next: typeof this.placed = []
    for (const k of keep) {
      let p = old.get(k.m)
      if (p) old.delete(k.m)
      else {
        const el = document.createElement('div')
        el.className = `wm-label k${k.m.kind}`
        el.textContent = k.m.label
        layer.appendChild(el)
        p = { m: k.m, el, w: k.w }
      }
      next.push(p)
    }
    for (const p of old.values()) p.el.remove()
    this.placed = next
  }

  private makeDepMarker(): HTMLElement {
    const el = document.createElement('div')
    el.className = 'wm-dep'
    el.innerHTML = `<div class="arrow"><svg viewBox="0 0 20 40" aria-hidden="true"><path d="M10 0 L18 14 H12 V40 H8 V14 H2 Z"/></svg></div><div class="pin"></div><div class="tag"></div>`
    this.root!.querySelector('.wm-layer')!.appendChild(el)
    return el
  }

  private makeSelMarker(): HTMLElement {
    const el = document.createElement('div')
    el.className = 'wm-sel'
    this.root!.querySelector('.wm-layer')!.appendChild(el)
    return el
  }

  /** Dónde está la salida elegida (o la que tenía el menú). */
  private departureSpot(): { lat: number; lon: number; heading: number; showHeading: boolean } | null {
    const c = this.choice
    if (c?.kind === 'custom') return { lat: c.lat, lon: c.lon, heading: c.heading, showHeading: true }
    const id = c?.kind === 'location' ? c.id : null
    if (id) {
      const l = LOCATIONS.find((x) => x.id === id)
      if (l) return { lat: l.lat, lon: l.lon, heading: l.heading, showHeading: true }
    }
    const d = this.dep
    return d ? { lat: d.lat, lon: d.lon, heading: d.heading, showHeading: true } : null
  }

  private markerSub(m: Marker): string {
    if (m.kind === 'C') return t('wm.kind.C')
    if (m.kind === 'P') return `${t('wm.kind.P')} · ${countryName(locationCountry(m.locs![0]))}`
    const a = m.airport!
    const code = [isIcao(a.code) ? a.code : '', a.iata].filter(Boolean).join(' · ')
    return [t(`wm.kind.${m.kind}`), code, [a.city, a.country].filter(Boolean).join(', ')].filter(Boolean).join(' · ')
  }

  // -------------------------------------------------------------------------
  // Clic y ficha
  // -------------------------------------------------------------------------
  private clickAt(px: number, py: number): void {
    const m = this.markerAt(px, py)
    if (m) return this.selectMarker(m)
    const g = this.pick(px, py)
    if (g) this.selectPoint(g.lat, g.lon)
  }

  private resetCard(): AbortController {
    this.abort?.abort()
    this.abort = new AbortController()
    this.cardState = { runways: null, runwayError: false, elev: null, water: false, place: null, nearest: null }
    return this.abort
  }

  private selectMarker(m: Marker): void {
    const ac = this.resetCard()
    this.selected = { kind: 'marker', m }
    // una salida del simulador ya elegida en el menú se marca al abrir su ficha
    if (m.locs?.some((l) => l.id === this.dep?.locationId) && !this.choice) {
      this.setChoice({ kind: 'location', id: this.dep!.locationId, start: this.start }, `loc:${this.dep!.locationId}`)
    }
    if (m.airport || m.kind === 'C') {
      const radius = m.kind === 'L' || m.kind === 'C' ? 4500 : m.kind === 'M' ? 3000 : 2000
      findRunways(m.lat, m.lon, radius, ac.signal)
        .then((rws) => {
          this.cardState.runways = rws
          this.renderCard()
        })
        .catch(() => {
          if (ac.signal.aborted) return
          this.cardState.runwayError = true
          this.renderCard()
        })
    }
    this.renderCard()
  }

  private selectPoint(lat: number, lon: number): void {
    const ac = this.resetCard()
    this.selected = { kind: 'point', lat, lon }
    // pinchar en el globo elige ese punto como salida (luego se puede cambiar por una pista)
    this.choiceKey = 'point'
    this.setPointChoice()
    const sig = ac.signal
    findRunways(lat, lon, 1500, sig)
      .then((rws) => {
        this.cardState.runways = rws
        this.renderCard()
      })
      .catch(() => {
        if (sig.aborted) return
        this.cardState.runwayError = true
        this.renderCard()
      })
    void Promise.all([elevationAt(lat, lon, sig), waterAt(lat, lon, sig)]).then(([h, water]) => {
      if (sig.aborted) return
      this.cardState.elev = h
      // sin datos de OSM: el mar abierto da 0 m o menos en el relieve
      this.cardState.water = water ?? (h !== null && h <= 0)
      // en el agua no hay suelo en el que salir
      if (this.cardState.water && this.start === 'runway') this.start = 'air'
      this.setPointChoice()
      this.renderCard()
    })
    void placeName(lat, lon, getLang(), sig).then((name) => {
      if (sig.aborted) return
      this.cardState.place = name
      this.setPointChoice()
      this.renderCard()
    })
    if (this.airportsReady) this.cardState.nearest = this.nearestAirport(lat, lon)
    this.renderCard()
  }

  private nearestAirport(lat: number, lon: number): { a: Airport; d: number } | null {
    let best: { a: Airport; d: number } | null = null
    for (const m of this.markers) {
      if (!m.airport || Math.abs(m.lat - lat) > 0.3) continue
      const d = distanceM(lat, lon, m.lat, m.lon)
      if (d < 25000 && (!best || d < best.d)) best = { a: m.airport, d }
    }
    return best
  }

  private setChoice(c: MapPick | null, key: ChoiceKey): void {
    this.choice = c
    this.choiceKey = key
  }

  /**
   * Salida en el punto con el rumbo del control: el punto pinchado o el de referencia
   * del aeródromo abierto. Solo si esa es la opción elegida (no una pista).
   */
  private setPointChoice(): void {
    const sel = this.selected
    if (!sel || this.choiceKey !== 'point') return
    let lat: number
    let lon: number
    let name: string
    if (sel.kind === 'point') {
      ;({ lat, lon } = sel)
      name = this.cardState.place?.split(',')[0] ?? `${lat.toFixed(4)}, ${lon.toFixed(4)}`
    } else if (sel.m.airport) {
      ;({ lat, lon } = sel.m)
      name = isIcao(sel.m.airport.code) ? sel.m.airport.code : sel.m.airport.name
    } else return
    this.setChoice({ kind: 'custom', lat, lon, heading: this.pointHeading, name, start: this.start }, 'point')
  }

  private onCardClick(ev: Event): void {
    const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]')
    if (!el) return
    const act = el.dataset.act!
    const sel = this.selected
    switch (act) {
      case 'close-card':
        this.abort?.abort()
        this.selected = null
        break
      case 'loc': {
        const id = el.dataset.id!
        const l = LOCATIONS.find((x) => x.id === id)
        if (l && !l.runway) this.start = 'air'
        else if (l?.runway && l.group === 'airfield') this.start = 'runway'
        this.setChoice({ kind: 'location', id, start: this.start }, `loc:${id}`)
        break
      }
      case 'rw':
      case 'final': {
        const rw = this.cardState.runways?.[Number(el.dataset.r)]
        const end = rw?.ends[Number(el.dataset.e)]
        if (!rw || !end) return
        const apt = sel?.kind === 'marker' ? sel.m.airport : this.cardState.nearest?.a
        const where =
          sel?.kind === 'marker' && sel.m.kind === 'C'
            ? sel.m.label
            : apt
              ? isIcao(apt.code)
                ? apt.code
                : apt.name
              : (this.cardState.place?.split(',')[0] ?? '')
        const key = `${act}:${el.dataset.r}:${el.dataset.e}`
        if (act === 'rw') {
          const name = where ? t('wm.rwName', { apt: where, rw: end.name }) : t('wm.runwayEnd', { rw: end.name })
          this.start = 'runway'
          this.setChoice({ kind: 'custom', lat: end.lat, lon: end.lon, heading: end.heading, name, start: 'runway' }, key)
        } else {
          // en final: 3 NM antes de la cabecera, en la prolongación del eje (a 300 m del suelo,
          // la senda de 3°), con el rumbo de la pista
          const p = this.offset(end.lat, end.lon, end.heading + 180, FINAL_M)
          const name = where ? t('wm.finalName', { apt: where, rw: end.name }) : t('wm.finalEnd', { rw: end.name })
          this.start = 'air'
          this.setChoice({ kind: 'custom', lat: p.lat, lon: p.lon, heading: end.heading, name, start: 'air' }, key)
        }
        break
      }
      case 'point':
        this.choiceKey = 'point'
        this.setPointChoice()
        break
      case 'wind':
        this.pointHeading = Math.round((this.dep?.windFrom ?? 0) / 5) * 5
        this.choiceKey = 'point'
        this.setPointChoice()
        break
      case 'nearest': {
        const a = this.cardState.nearest?.a
        const m = a && this.markers.find((x) => x.airport === a)
        if (m) {
          this.selectMarker(m)
          this.flyTo(m.lat, m.lon, 12 * KM, 1.2)
        }
        return
      }
      case 'start': {
        this.start = el.dataset.v as StartMode
        if (this.choice) this.choice = { ...this.choice, start: this.start }
        break
      }
      case 'zoom': {
        const p = sel?.kind === 'marker' ? sel.m : sel
        if (p) this.flyTo(p.lat, p.lon, sel?.kind === 'marker' && sel.m.kind === 'P' ? 25 * KM : 9 * KM, 1.4)
        return
      }
      case 'accept':
      case 'fly':
        if (this.choice) {
          const pick = { ...this.choice, start: this.start }
          const cb = this.onPick
          this.close()
          cb?.(pick, act === 'fly')
        }
        return
    }
    this.renderCard()
  }

  private renderCard(): void {
    const card = this.root?.querySelector<HTMLElement>('.wm-card')
    if (!card) return
    const sel = this.selected
    const st = this.cardState
    let body = ''
    if (!sel) {
      body = `<p class="wm-empty">${esc(t('wm.choose'))}</p>`
    } else if (sel.kind === 'marker' && sel.m.locs) {
      const m = sel.m
      const head = this.markerSub(m)
      const note = m.kind === 'P' ? locationNote(m.locs![0]) : (m.locs!.find((l) => l.runway) ? locationNote(m.locs!.find((l) => l.runway)!) : '')
      body = `
        <header>
          <small class="wm-kind k${m.kind}">${esc(head)}</small>
          <h3>${esc(m.title)}</h3>
          ${note ? `<p class="wm-sub">${esc(note)}</p>` : ''}
        </header>
        <h4>${esc(m.kind === 'C' ? t('wm.simDepartures') : t('wm.departures'))}</h4>
        <div class="wm-opts">
          ${m.locs!
            .map((l) => {
              const key = `loc:${l.id}`
              const label = m.kind === 'C' ? tailPart(locationName(l)) : t('wm.flyHere')
              const air = !l.runway ? ` · ${t('wm.inFlightAt', { m: l.airAGL ?? 300 })}` : ''
              return `<button type="button" class="wm-opt${this.choiceKey === key ? ' on' : ''}" data-act="loc" data-id="${esc(l.id)}">
                <b>${esc(label)}</b><small>${esc(`${t('wm.heading')} ${hdg3(l.heading)}°${air}`)}</small></button>`
            })
            .join('')}
        </div>
        ${m.kind === 'C' ? `<h4>${esc(t('wm.allRunways'))}</h4>${this.runwaysHtml(true)}` : ''}`
    } else {
      // aeródromo de OurAirports o punto suelto
      const isApt = sel.kind === 'marker'
      const a = isApt ? sel.m.airport! : null
      const lat = isApt ? sel.m.lat : sel.lat
      const lon = isApt ? sel.m.lon : sel.lon
      const codes = a ? [isIcao(a.code) ? a.code : '', a.iata].filter(Boolean).join(' · ') : ''
      const elev = a?.elev ?? st.elev
      const sub = a
        ? [codes, [a.city, a.country].filter(Boolean).join(', ')].filter(Boolean).join(' · ')
        : st.place
          ? t('wm.near', { place: st.place })
          : ''
      const facts = [
        formatDms(lat, lon, getLang() === 'es' ? 'O' : 'W'),
        elev !== null && !(st.water && !a) ? t('wm.elev', { m: Math.round(Math.max(elev, -500)).toLocaleString(locale()) }) : '',
      ].filter(Boolean)
      const water = !a && st.water
      const rws = st.runways
      const rwHtml = this.runwaysHtml(isApt)
      const nearest =
        !isApt && st.nearest
          ? `<button type="button" class="wm-link" data-act="nearest">${esc(
              t('wm.nearest', {
                name: `${isIcao(st.nearest.a.code) ? `${st.nearest.a.code} · ` : ''}${st.nearest.a.name}`,
                d: fmtKm(st.nearest.d),
              }),
            )}</button>`
          : ''
      const pointOn = this.choiceKey === 'point'
      body = `
        <header>
          <small class="wm-kind k${isApt ? sel.m.kind : 'X'}">${esc(isApt ? t(`wm.kind.${sel.m.kind}`) : t('wm.point'))}</small>
          <h3>${esc(a ? a.name : st.place ? st.place.split(',')[0] : `${lat.toFixed(4)}, ${lon.toFixed(4)}`)}</h3>
          ${sub ? `<p class="wm-sub">${esc(sub)}</p>` : ''}
          <p class="wm-facts">${facts.map(esc).join(' · ')}</p>
          ${nearest}
        </header>
        ${rws === null || rws.length || isApt ? `<h4>${esc(isApt ? t('wm.runways') : t('wm.runwaysNear'))}</h4>${rwHtml}` : ''}
        <h4>${esc(isApt ? t('wm.refPoint') : t('wm.thisPoint'))}</h4>
        <div class="wm-point${pointOn ? ' on' : ''}">
          <button type="button" class="wm-opt${pointOn ? ' on' : ''}" data-act="point">
            <b>${esc(t('wm.departHere'))}</b><small>${esc(water ? t('wm.water') : t('wm.departHereSub'))}</small>
          </button>
          <label class="wm-hdg-row"><span>${esc(t('wm.heading'))}</span>
            <input class="wm-hdg" type="range" min="0" max="355" step="5" value="${this.pointHeading}" />
            <output>${hdg3(this.pointHeading)}°</output>
          </label>
          <button type="button" class="wm-link" data-act="wind">${esc(t('wm.intoWind', { hdg: hdg3(this.dep?.windFrom ?? 0) }))}</button>
        </div>`
    }

    // pie: en el suelo / en vuelo y botones
    const c = this.choice
    // las salidas del simulador sin pista (sitios, circuito, final) son siempre en vuelo
    const scenic = c?.kind === 'location' && !LOCATIONS.find((l) => l.id === c.id)?.runway
    const water = c?.kind === 'custom' && this.choiceKey === 'point' && this.selected?.kind === 'point' && st.water
    const summary = c ? t('wm.departure', { name: this.choiceName(c) }) : t('wm.noChoice')
    card.innerHTML = `
      ${sel ? `<div class="wm-card-tools">
        <button type="button" class="wm-mini" data-act="zoom" title="${esc(t('wm.zoom'))}" aria-label="${esc(t('wm.zoom'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21M10.5 7.5v6M7.5 10.5h6"/></svg></button>
        <button type="button" class="wm-mini" data-act="close-card" aria-label="${esc(t('common.close'))}">✕</button>
      </div>` : ''}
      <div class="wm-card-body">${body}</div>
      <footer>
        <div class="wm-seg${scenic || water ? ' disabled' : ''}" role="radiogroup">
          <button type="button" data-act="start" data-v="runway" class="${this.start === 'runway' && !scenic && !water ? 'on' : ''}" ${scenic || water ? 'disabled' : ''}>${esc(t('wm.startGround'))}</button>
          <button type="button" data-act="start" data-v="air" class="${this.start === 'air' || scenic || water ? 'on' : ''}" ${scenic || water ? 'disabled' : ''}>${esc(t('wm.startAir'))}</button>
        </div>
        <p class="wm-summary">${esc(summary)}</p>
        <div class="wm-actions">
          <button type="button" data-act="accept" ${c ? '' : 'disabled'}>${esc(t('wm.accept'))}</button>
          <button type="button" class="primary" data-act="fly" ${c ? '' : 'disabled'}>${esc(t('wm.fly'))}</button>
        </div>
      </footer>`
    card.classList.toggle('has-sel', Boolean(sel))
  }

  /** Pistas (de OpenStreetMap) con despegue y llegada en final por cada cabecera. */
  private runwaysHtml(sayNone: boolean): string {
    const st = this.cardState
    const rws = st.runways
    if (rws === null)
      return st.runwayError
        ? `<p class="wm-muted">${esc(t('wm.runwaysError'))}</p>`
        : `<p class="wm-muted wm-loading">${esc(t('wm.runwaysLoading'))}</p>`
    if (rws.length === 0) return sayNone ? `<p class="wm-muted">${esc(t('wm.runwaysNone'))}</p>` : ''
    const arrow = (hdg: number) =>
      `<svg viewBox="0 0 20 20" aria-hidden="true" style="transform: rotate(${hdg}deg)"><path d="M10 2 L15 10 H11.5 V18 H8.5 V10 H5 Z"/></svg>`
    const plane = (hdg: number) =>
      `<svg viewBox="0 0 20 20" aria-hidden="true" style="transform: rotate(${hdg}deg)"><path d="M10 1.5 11.3 7.5 18 11v1.6l-6.7-2V15l2.2 1.6V18L10 17l-3.5 1v-1.4L8.7 15v-4.4L2 12.6V11l6.7-3.5Z"/></svg>`
    const btn = (act: 'rw' | 'final', i: number, j: number, inner: string, title: string) =>
      `<button type="button" class="wm-opt wm-end${this.choiceKey === `${act}:${i}:${j}` ? ' on' : ''}" data-act="${act}" data-r="${i}" data-e="${j}" title="${esc(title)}">${inner}</button>`
    return rws
      .map((r, i) => {
        const dep = r.ends.map((en, j) =>
          btn('rw', i, j, `${arrow(en.heading)}<b>${esc(en.name)}</b><small>${hdg3(en.heading)}°</small>`, t('wm.runwayTitle', { rw: en.name, hdg: hdg3(en.heading) })),
        )
        const arr = r.ends.map((en, j) =>
          btn('final', i, j, `${plane(en.heading)}<b>${esc(en.name)}</b><small>3 NM</small>`, t('wm.finalTitle', { rw: en.name, hdg: hdg3(en.heading) })),
        )
        return `
          <div class="wm-rw">
            <div class="wm-rw-name"><b>${esc(r.ref)}</b><small>${esc(fmtKm(r.length))}</small></div>
            <div class="wm-rw-grid">
              <span class="wm-rw-k">${esc(t('wm.takeoff'))}</span>${dep.join('')}
              <span class="wm-rw-k">${esc(t('wm.landing'))}</span>${arr.join('')}
            </div>
          </div>`
      })
      .join('')
  }

  private choiceName(c: MapPick): string {
    if (c.kind === 'location') {
      const l = LOCATIONS.find((x) => x.id === c.id)
      return l ? locationName(l) : c.id
    }
    return `${c.name} · ${t('wm.heading').toLowerCase()} ${hdg3(c.heading)}°`
  }

  // -------------------------------------------------------------------------
  // Teclado y búsqueda
  // -------------------------------------------------------------------------
  private handleKey(e: KeyboardEvent): void {
    const input = this.root?.querySelector<HTMLInputElement>('.wm-search input')
    const results = this.root?.querySelector<HTMLElement>('.wm-results')
    const inSearch = e.target === input
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopImmediatePropagation()
      if (results && !results.classList.contains('hidden')) results.classList.add('hidden')
      else if (inSearch && input!.value) input!.value = ''
      else if (this.selected) {
        this.selected = null
        this.renderCard()
      } else this.close()
      return
    }
    if (inSearch) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        if (!this.results.length) return
        this.resultSel = (this.resultSel + (e.key === 'ArrowDown' ? 1 : -1) + this.results.length) % this.results.length
        this.drawResults()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        this.results[this.resultSel]?.go()
      }
      return // el resto de teclas son del campo de búsqueda
    }
    // el mapa se queda con el teclado: que no lleguen al simulador
    if (!(e.target instanceof HTMLInputElement)) e.stopImmediatePropagation()
  }

  private localSearch(text: string): void {
    const q = text.trim()
    this.results = []
    this.resultSel = 0
    if (!q) return this.drawResults()
    const coords = parseCoords(q)
    if (coords) {
      this.results.push({
        icon: '⌖',
        name: t('wm.goCoords', { lat: coords.lat.toFixed(4), lon: coords.lon.toFixed(4) }),
        detail: formatDms(coords.lat, coords.lon, getLang() === 'es' ? 'O' : 'W'),
        go: () => this.goPoint(coords.lat, coords.lon, 15 * KM),
      })
    }
    const nq = normalize(q)
    const up = q.toUpperCase()
    // Intro: el código exacto (OACI/IATA); si no, el primero cuyo nombre empiece por lo
    // escrito; si tampoco, la búsqueda en todo el mundo
    let best = -1
    let bestStarts = -1
    // empieza por lo escrito alguna palabra del nombre («barajas» en «Madrid-Barajas»)
    const starts = (s: string) => {
      const ns = normalize(s)
      const i = ns.indexOf(nq)
      return i === 0 || (i > 0 && !/[a-z0-9]/.test(ns[i - 1]))
    }
    // salidas del simulador
    for (const m of this.markers) {
      if (m.airport || this.results.length >= 6) continue
      const where = m.kind === 'P' ? countryName(locationCountry(m.locs![0])) : ''
      if (normalize(`${m.label} ${m.iata ?? ''} ${m.title} ${where}`).includes(nq)) {
        if (best < 0 && (m.label === up || m.iata === up)) best = this.results.length
        if (bestStarts < 0 && starts(m.title)) bestStarts = this.results.length
        this.results.push({ icon: m.kind === 'C' ? '✈' : '★', name: m.title, detail: this.markerSub(m), go: () => this.goMarker(m) })
      }
    }
    // aeródromos: primero los que coinciden en código, luego por nombre o ciudad (por importancia)
    if (this.airportsReady && nq.length >= 2) {
      const exact: Marker[] = []
      const byName: Marker[] = []
      for (const m of this.markers) {
        const a = m.airport
        if (!a) continue
        if (a.code === up || a.iata === up) exact.push(m)
        else if (nq.length >= 3 && a.key.includes(nq)) byName.push(m)
      }
      byName.sort((p, q2) => STYLE[p.kind].rank - STYLE[q2.kind].rank)
      for (const m of [...exact, ...byName].slice(0, 9 - this.results.length)) {
        const a = m.airport!
        if (best < 0 && (a.code === up || a.iata === up)) best = this.results.length
        if (bestStarts < 0 && (starts(a.name) || starts(a.city))) bestStarts = this.results.length
        this.results.push({
          icon: '✈',
          name: a.name,
          detail: this.markerSub(m),
          go: () => this.goMarker(m),
        })
      }
    }
    if (!coords) {
      this.results.push({ icon: '🔎', name: t('wm.searchWorld', { q }), detail: t('wm.searchWorldSub'), go: () => this.worldSearch(q) })
      this.resultSel = best >= 0 ? best : bestStarts >= 0 && nq.length >= 3 ? bestStarts : this.results.length - 1
    }
    this.drawResults()
  }

  private drawResults(msg?: string): void {
    const box = this.root?.querySelector<HTMLElement>('.wm-results')
    if (!box) return
    if (!this.results.length && !msg) {
      box.classList.add('hidden')
      return
    }
    box.innerHTML =
      (msg ? `<div class="wm-res-msg">${esc(msg)}</div>` : '') +
      this.results
        .map(
          (r, i) =>
            `<div class="wm-res${i === this.resultSel ? ' on' : ''}" role="option" data-i="${i}"><span class="ico">${esc(r.icon)}</span><span class="txt"><b>${esc(r.name)}</b><small>${esc(r.detail)}</small></span></div>`,
        )
        .join('')
    box.classList.remove('hidden')
  }

  private worldSearch(q: string): void {
    this.searchAbort?.abort()
    const ac = (this.searchAbort = new AbortController())
    this.results = []
    this.drawResults(t('wm.searching'))
    searchPlaces(q, getLang(), ac.signal)
      .then((list) => {
        if (ac.signal.aborted) return
        this.results = list.map((p: PlaceResult) => ({
          icon: p.aerodrome ? '✈' : '📍',
          name: p.name,
          detail: p.detail,
          go: () => this.goPlace(p),
        }))
        this.resultSel = 0
        this.drawResults(list.length ? undefined : t('wm.noResults'))
      })
      .catch(() => {
        if (!ac.signal.aborted) this.drawResults(t('wm.searchError'))
      })
  }

  private hideResults(): void {
    const input = this.root?.querySelector<HTMLInputElement>('.wm-search input')
    input?.blur()
    this.root?.querySelector('.wm-results')?.classList.add('hidden')
  }

  private goMarker(m: Marker): void {
    this.hideResults()
    this.selectMarker(m)
    this.flyTo(m.lat, m.lon, m.kind === 'P' ? 30 * KM : m.kind === 'L' ? 14 * KM : 8 * KM, 2)
  }

  private goPoint(lat: number, lon: number, h: number): void {
    this.hideResults()
    this.selectPoint(lat, lon)
    this.flyTo(lat, lon, h, 2)
  }

  private goPlace(p: PlaceResult): void {
    this.hideResults()
    const h = Math.min(4000 * KM, Math.max(15 * KM, p.size * 2.2))
    if (p.aerodrome) {
      // si es uno de los de OurAirports, su ficha con las pistas; si no, el punto
      let best: Marker | null = null
      let bd = 3000
      for (const m of this.markers) {
        if (!m.airport && m.kind !== 'C') continue
        if (Math.abs(m.lat - p.lat) > 0.05) continue
        const d = distanceM(p.lat, p.lon, m.lat, m.lon)
        if (d < bd) [bd, best] = [d, m]
      }
      if (best) return this.goMarker(best)
    }
    // un lugar suelto (ciudad, montaña…): su ficha, lista para salir desde allí
    this.selectPoint(p.lat, p.lon)
    this.flyTo(p.lat, p.lon, h, 2)
  }
}
