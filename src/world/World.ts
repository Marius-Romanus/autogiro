// Escenario del mundo real: Google Photorealistic 3D Tiles (con clave) o, sin
// clave, relieve + ortofoto (PNOA/Esri) con edificios 3D de OpenStreetMap.
// El relieve sin clave es el MDT de 5 m del IGN en España (quantized-mesh) y el
// global Terrarium (~30 m) fuera. Consultas de suelo y re-centrado del origen flotante.

import {
  BufferGeometry,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Raycaster,
  Vector2,
  Vector3,
  type Camera,
  type PerspectiveCamera,
  type Material,
  type Object3D,
  type Scene,
  type Texture,
  type WebGLRenderer,
} from 'three'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { TilesRenderer } from '3d-tiles-renderer'
import * as TilesPlugins from '3d-tiles-renderer/plugins'
import {
  GLTFExtensionsPlugin,
  GoogleCloudAuthPlugin,
  ImageOverlayPlugin,
  QuantizedMeshPlugin,
  TilesFadePlugin,
} from '3d-tiles-renderer/plugins'

// (los tipos publicados aún no incluyen estas clases)
const { TerrariumMeshPlugin, XYZTilesOverlay } = TilesPlugins as any
type TerrariumMeshPlugin = { sampleCartographicElevation(lat: number, lon: number): number | null }
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh'
import { GeoFrame } from './GeoFrame.ts'
import { Buildings } from './Buildings.ts'
import { Trees } from './Trees.ts'
import { Landmarks } from './Landmarks.ts'
import { Bridges } from './Bridges.ts'
import { PowerLines } from './PowerLines.ts'
import { Traffic } from '../traffic/Traffic.ts'
import { Runways } from './Runways.ts'
import { GridRunways } from './gridRunways.ts'
import { TerrainNormals } from './terrainNormals.ts'
import { WaterMask, type WaterSample } from './WaterMask.ts'
import { flattenSea } from './seaLevel.ts'
import { skipEsriPlaceholders } from './esriImagery.ts'
import { fixIgnAvailability, hasIgnTerrain, QMHeightSource, TerrariumHeightSource, type HeightSource } from './HeightSource.ts'
import type { Quality, Settings } from '../config.ts'
import { getLang } from '../i18n.ts'

// BVH para raycasts rápidos contra la geometría de los tiles
;(BufferGeometry.prototype as any).computeBoundsTree = computeBoundsTree
;(BufferGeometry.prototype as any).disposeBoundsTree = disposeBoundsTree
Mesh.prototype.raycast = acceleratedRaycast

const DEG = Math.PI / 180
const _ray = new Raycaster()
const _o = new Vector3()
const _d = new Vector3()
const _p = new Vector3()
const _wp = new Vector3()
const _hits: any[] = []
const _deck = { y: 0, normal: new Vector3() }

/** MDT de 5 m del IGN (CNIG) como terreno quantized-mesh, con CORS abierto */
const IGN_QM = 'https://qm-mdt.idee.es/1.0.0/terrain/'
const TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
const PNOA =
  'https://www.ign.es/wmts/pnoa-ma?request=GetTile&service=WMTS&VERSION=1.0.0&Layer=OI.OrthoimageCoverage&Style=default&Format=image/jpeg&TileMatrixSet=GoogleMapsCompatible&TileMatrix={z}&TileRow={y}&TileCol={x}'
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'

export interface GroundSample {
  y: number
  normal: Vector3
}

/** ¿Se usaría el MDT del IGN en este punto con estos ajustes? */
export function usesIgnTerrain(settings: Settings, lat: number, lon: number): boolean {
  return settings.elevation !== 'global' && hasIgnTerrain(lat, lon)
}

/**
 * Las mallas quantized-mesh vienen con un material iluminado; el terreno se
 * dibuja como "albedo" sin iluminar (lo ilumina el posproceso de la atmósfera).
 * Corre antes que ImageOverlayPlugin (prioridad −15), que añade la ortofoto al shader.
 */
class UnlitTerrainPlugin {
  name = 'UNLIT_TERRAIN_PLUGIN'
  priority = -100
  processTileModel(scene: Object3D): void {
    scene.traverse((o) => {
      const m = o as Mesh
      if (!m.isMesh) return
      const old = m.material as Material & { isMeshBasicMaterial?: boolean }
      if (old.isMeshBasicMaterial) return
      m.material = new MeshBasicMaterial({ color: 0x8c8474 })
      old.dispose()
    })
  }
}

/**
 * Entrega a QuantizedMeshPlugin el layer.json del IGN con la disponibilidad real
 * (fixIgnAvailability): sin esto pide teselas de mar y de Marruecos que dan 403.
 */
class IgnAvailabilityPlugin {
  name = 'IGN_AVAILABILITY_PLUGIN'
  fetchData(url: string | URL, options?: RequestInit): Promise<Response> | null {
    if (!/\/layer\.json(\?|$)/.test(String(url))) return null
    return fetch(url, options).then(async (r) => {
      if (!r.ok) return r
      const layer = fixIgnAvailability(await r.json())
      return new Response(JSON.stringify(layer), { headers: { 'Content-Type': 'application/json' } })
    })
  }
}

const _size = new Vector2()

export class World {
  readonly frame = new GeoFrame()
  tiles!: TilesRenderer
  private terrain: TerrariumMeshPlugin | null = null
  readonly mode: 'google' | 'terrain'
  /** fuente del relieve en modo sin clave */
  terrainKind: 'ign' | 'terrarium' | null = null
  /** alturas del MDT leídas de los datos (física del suelo en modo IGN) */
  private heights: HeightSource | null = null
  /** edificios de OpenStreetMap (modo sin clave) */
  buildings: Buildings | null = null
  /** árboles detectados en la ortofoto (modo sin clave) */
  trees: Trees | null = null
  /** monumentos modelados aparte (torre Eiffel), con los edificios */
  landmarks: Landmarks | null = null
  /** pistas de OpenStreetMap alisadas sobre el MDT del IGN (dibujo y física) */
  runways: Runways | null = null
  /** las mismas pistas alisadas en la rejilla del relieve global (Terrarium) */
  gridRunways: GridRunways | null = null
  /** material de normales del relieve global, para iluminar sus laderas (terrainNormals.ts) */
  private terrainNormals: TerrainNormals | null = null
  /** puentes de OpenStreetMap en 3D (modo sin clave, con los edificios) */
  bridges: Bridges | null = null
  /** alturas con que se perfilan los puentes (la malla fina del IGN, la de la física, o Terrarium) */
  private bridgeHeights: HeightSource | null = null
  /** tendidos eléctricos en 3D (modo sin clave, con los edificios) */
  power: PowerLines | null = null
  /** tráfico simulado (modo sin clave) */
  traffic: Traffic | null = null
  /** relieve grueso para el gálibo de los vanos */
  private powerCoarse: HeightSource | null = null
  /** dónde hay agua (mar, lagos, ríos), para iluminarla como agua (render/Water.ts) */
  private water: WaterMask | null = null
  /** alturas para asentar edificios y árboles (compartidas) */
  private buildingHeights: HeightSource | null = null
  readonly attributionEl: HTMLElement
  /** errores de carga (clave inválida, sin red…) */
  lastError = ''
  private meshes = new Set<Mesh>()
  imageryName = ''
  private lastUpdate = performance.now()

  private settings: Settings
  private scene: Scene
  private camera: Camera
  private renderer: WebGLRenderer

  constructor(settings: Settings, scene: Scene, camera: Camera, renderer: WebGLRenderer, lat: number, lon: number) {
    this.settings = settings
    this.scene = scene
    this.camera = camera
    this.renderer = renderer
    this.mode = settings.scenery === 'google' && settings.googleKey ? 'google' : 'terrain'
    this.frame.setOrigin(lat, lon, 0)
    this.attributionEl = document.getElementById('attribution')!
    this.createTiles(lat, lon)
  }

  /**
   * El relieve admite el pase de normales para iluminar sus laderas: Google y la malla del IGN
   * con su geometría, el global (desplazado en la GPU) con el material de terrainNormals.ts.
   */
  get realGeometry(): boolean {
    return this.mode === 'google' || this.terrainKind !== null
  }

  /** Antes (true) y después (false) del pase de normales (Graphics.normalPassHook). */
  normalPass(on: boolean): void {
    if (!this.terrainNormals) return
    if (on) this.terrainNormals.begin(this.meshes)
    else this.terrainNormals.end()
  }

  private createTiles(lat: number, lon: number): void {
    let tiles: TilesRenderer
    if (this.mode === 'google') {
      tiles = new TilesRenderer()
      tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: this.settings.googleKey, autoRefreshToken: true }))
      const draco = new DRACOLoader().setDecoderPath(`${import.meta.env.BASE_URL}draco/`)
      tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco }))
      tiles.registerPlugin(new TilesFadePlugin({ fadeDuration: 300 }))
      // Google: los volúmenes envolventes no son exactos → raycast directo
      ;(tiles as any).accelerateRaycast = false
    } else {
      // cobertura del PNOA: España (el rectángulo de isInSpain incluye Portugal y el sur de Francia)
      const spain = hasIgnTerrain(lat, lon)
      const src = this.settings.imagery === 'auto' ? (spain ? 'pnoa' : 'esri') : this.settings.imagery
      const imageryUrl = src === 'pnoa' ? PNOA : ESRI
      // (donde Esri no tiene imagen a un nivel, la del nivel anterior en vez de su cartel gris)
      const makeOverlay = () => skipEsriPlaceholders(new XYZTilesOverlay({ url: imageryUrl, levels: src === 'pnoa' ? 20 : 19 }))
      const ign = usesIgnTerrain(this.settings, lat, lon)
      this.terrainKind = ign ? 'ign' : 'terrarium'
      const en = getLang() === 'en'
      const relief = `${en ? 'Terrain' : 'Relieve'}: ${ign ? 'MDT05 © IGN (scne.es)' : 'Mapzen/AWS Terrain Tiles'}`
      this.imageryName =
        (src === 'pnoa'
          ? `${en ? 'PNOA orthophoto' : 'Ortofoto PNOA'} © Instituto Geográfico Nacional (scne.es) · ${relief}`
          : `${en ? 'Imagery' : 'Imágenes'} © Esri, Maxar, Earthstar Geographics · ${relief}`) +
        // (el agua —dónde hay mar, lagos y ríos— también sale de OpenStreetMap, haya edificios o no)
        (this.settings.buildings
          ? en
            ? ' · Buildings and water © OpenStreetMap contributors (OpenFreeMap)'
            : ' · Edificios y agua © colaboradores de OpenStreetMap (OpenFreeMap)'
          : en
            ? ' · Water © OpenStreetMap contributors (OpenFreeMap)'
            : ' · Agua © colaboradores de OpenStreetMap (OpenFreeMap)') +
        (this.settings.buildings && this.settings.catastro && spain ? (en ? ' and Dirección General del Catastro' : ' y Dirección General del Catastro') : '')
      if (ign) {
        tiles = new TilesRenderer(IGN_QM)
        tiles.registerPlugin(new IgnAvailabilityPlugin())
        tiles.registerPlugin(new QuantizedMeshPlugin({ useRecommendedSettings: true }))
        tiles.registerPlugin(new UnlitTerrainPlugin())
        tiles.registerPlugin(new ImageOverlayPlugin({ overlays: [guardRegionCounts(makeOverlay())], renderer: this.renderer, resolution: 256 } as any))
        tiles.registerPlugin(new TilesFadePlugin({ fadeDuration: 300 }))
        // la malla más fina (nivel 16, ≈ 230 × 300 m por tesela) para el suelo del aparato
        const qm = new QMHeightSource(IGN_QM, 16)
        this.heights = qm
        // el MDT tiene costuras de algunos decímetros: las pistas se alisan (Runways.ts)
        this.runways = new Runways(qm, tiles as any)
        tiles.registerPlugin(this.runways.plugin())
        // y un nivel menos para asentar los edificios (cuatro veces menos peticiones)
        // (siempre: los tendidos también lo usan y se pueden encender en vuelo; sin pedirle nada no descarga)
        this.buildingHeights = new QMHeightSource(IGN_QM, 15)
      } else {
        tiles = new TilesRenderer()
        this.terrain = new TerrariumMeshPlugin({
          url: TERRARIUM,
          maxZoom: 15,
          overlay: makeOverlay(),
          applyOverlayTexture: true,
          unlit: true,
        })
        // el relieve mundial trae el fondo marino: el mar, a cota 0
        flattenSea(this.terrain)
        // pistas alisadas en la propia rejilla de alturas (dibujo y física), perfiladas con
        // el mismo nivel de Terrarium que usa el relieve (14)
        this.gridRunways = new GridRunways(this.terrain, tiles as any, new TerrariumHeightSource(TERRARIUM, 14, 60))
        this.terrainNormals = new TerrainNormals()
        tiles.registerPlugin(this.terrain as object)
        tiles.registerPlugin(new TilesFadePlugin({ fadeDuration: 300 }))
        this.buildingHeights = new TerrariumHeightSource(TERRARIUM, 15)
      }
      if (this.buildingHeights && this.settings.buildings) {
        this.buildings = new Buildings(this.frame, this.buildingHeights, imageryUrl, this.settings.catastro && spain)
        this.scene.add(this.buildings.group)
        this.buildings.syncFrame()
      }
      if (this.buildingHeights && this.settings.buildings) {
        this.landmarks = new Landmarks(this.frame, this.buildingHeights)
        this.scene.add(this.landmarks.group)
        this.landmarks.syncFrame()
      }
      if (this.buildingHeights && this.settings.trees) {
        this.trees = new Trees(this.frame, this.buildingHeights, imageryUrl)
        this.scene.add(this.trees.group)
        this.trees.syncFrame()
      }
      if (this.settings.buildings) {
        this.bridgeHeights = ign ? new QMHeightSource(IGN_QM, 16, 900) : new TerrariumHeightSource(TERRARIUM, 15)
        // rebajes (solo con el MDT del IGN) y rellenos de los accesos; fuera de España la rejilla
        // de alturas es de ~7 m por texel y el relleno lleva margen para que alguno caiga dentro
        this.bridges = new Bridges(this.frame, this.bridgeHeights, { imageryUrl, carve: ign, fill: true, fillPad: ign ? 0 : 4 })
        // los parches los aplica el mecanismo de las pistas: mallas del IGN o rejilla del relieve mundial
        this.bridges.onCarve = (patches) => (this.runways ?? this.gridRunways?.runways)?.setExtra(patches)
        this.scene.add(this.bridges.group, this.bridges.decals)
        this.bridges.syncFrame()
      }
      if (this.buildingHeights) {
        // tendidos: el pie de los apoyos con el relieve de los edificios; el gálibo de los vanos, con uno grueso.
        // Se crean siempre y se encienden o apagan en vivo con su interruptor (main.ts → power.enabled)
        this.powerCoarse = ign ? new QMHeightSource(IGN_QM, 13, 200) : new TerrariumHeightSource(TERRARIUM, 12, 120)
        this.power = new PowerLines(this.frame, this.buildingHeights, this.powerCoarse)
        this.scene.add(this.power.group)
        this.power.enabled = this.settings.power
        this.power.syncFrame()
      }
      // tráfico simulado por las calles de OpenStreetMap (src/traffic): se crea siempre en el modo
      // sin clave; el ajuste «Tráfico» solo lo enciende o lo apaga (Traffic.enabled)
      this.traffic = new Traffic(this.frame, { heights: ign ? 'ign' : 'terrarium', ignUrl: IGN_QM, terrariumUrl: TERRARIUM })
      this.scene.add(this.traffic.group)
    }
    // (con los tiles de Google no está probado: su malla ya trae el agua con relieve y brillos)
    if (this.mode === 'terrain') this.water = new WaterMask(this.frame)
    this.tiles = tiles
    this.applyQuality(this.settings.quality === 'auto' ? 'medium' : this.settings.quality)
    tiles.setCamera(this.camera)
    tiles.setResolutionFromRenderer(this.camera, this.renderer)
    guardTilesGroup(tiles.group)
    tiles.group.matrixAutoUpdate = false
    tiles.group.matrix.copy(this.frame.ecefToWorld)
    tiles.group.updateMatrixWorld(true)
    this.scene.add(tiles.group)

    tiles.addEventListener('load-model', (e: any) => {
      const scene = e.scene as Object3D
      scene.traverse((o) => {
        const m = o as Mesh
        if (m.isMesh) {
          this.meshes.add(m)
          this.runways?.refresh(m)
          m.receiveShadow = false
          m.castShadow = false
        }
      })
    })
    tiles.addEventListener('dispose-model', (e: any) => {
      ;(e.scene as Object3D).traverse((o) => {
        const m = o as Mesh
        if (m.isMesh) {
          this.meshes.delete(m)
          this.terrainNormals?.release(m)
          ;(m.geometry as any).boundsTree && (m.geometry as any).disposeBoundsTree()
        }
      })
    })
    tiles.addEventListener('load-error', (e: any) => {
      const msg = String(e.error?.message ?? e.error ?? '')
      // el servicio del IGN declara teselas oceánicas de nivel bajo que luego no sirve (403): no es un fallo
      if (this.terrainKind === 'ign' && /\b40[34]\b/.test(msg)) return
      this.lastError = msg
      console.warn('Error cargando tiles:', e.url, msg)
    })
  }

  applyQuality(q: Quality): void {
    const t = this.tiles
    if (this.mode === 'google') {
      t.errorTarget = { low: 24, medium: 14, high: 8, ultra: 4 }[q]
      t.lruCache.maxBytesSize = { low: 0.4, medium: 0.7, high: 1.1, ultra: 1.6 }[q] * 1024 ** 3
      t.lruCache.minBytesSize = t.lruCache.maxBytesSize * 0.6
    } else {
      if (this.terrainKind === 'ign') {
        // error en píxeles de la malla y de la textura compuesta de cada tesela
        t.errorTarget = { low: 3, medium: 2, high: 1.4, ultra: 1 }[q]
      } else {
        // 1 = un texel de ortofoto por píxel de pantalla
        t.errorTarget = { low: 2.2, medium: 1.5, high: 1.0, ultra: 0.75 }[q]
      }
      // Caché de teselas (casi todo, la foto de cada una). Con los 0,4 GB de la librería se llenaba
      // en Alta: sobre París, 409/410 MB con 129 teselas esperando, porque con la caché llena el
      // renderer deja de pedir las nuevas. Baja se queda como estaba (gráficas integradas).
      t.lruCache.maxBytesSize = { low: 0.4, medium: 0.7, high: 1.1, ultra: 1.6 }[q] * 1024 ** 3
      t.lruCache.minBytesSize = t.lruCache.maxBytesSize * 0.75
    }
    if (this.buildings) this.buildings.radius = { low: 2200, medium: 3500, high: 5000, ultra: 7000 }[q]
    if (this.bridges) this.bridges.radius = { low: 2600, medium: 4000, high: 6000, ultra: 8000 }[q]
    if (this.power) this.power.radius = { low: 3500, medium: 5000, high: 7000, ultra: 9000 }[q]
    if (this.traffic) {
      // vehículos como mucho, región (teselas a cada lado de la de la cámara) y radio de dibujo
      this.traffic.cap = { low: 500, medium: 1200, high: 2200, ultra: 3500 }[q]
      this.traffic.tiles = q === 'low' ? 1 : 2
      this.traffic.drawRadius = { low: 2500, medium: 3500, high: 4500, ultra: 6000 }[q]
      this.traffic.groundLights = q !== 'low'
    }
    if (this.trees) {
      this.trees.radius = { low: 900, medium: 1400, high: 2000, ultra: 2800 }[q]
      this.trees.maxPerTile = { low: 8000, medium: 16000, high: 30000, ultra: 45000 }[q]
    }
  }

  get loadProgress(): number {
    const p = (this.tiles as any).loadProgress ?? 1
    // sin el perfil de las pistas cercanas el aparato se posaría en el MDT sin alisar
    if (this.runways?.pending || this.gridRunways?.pending) return Math.min(p, 0.95)
    // edificios del Catastro de alrededor del punto de salida (espera como mucho 25 s)
    if (this.buildings?.catastroBusy) return Math.min(p, 0.97)
    // puentes de alrededor del punto de salida (por si se sale de uno; espera como mucho 12 s)
    return this.bridges?.busy ? Math.min(p, 0.98) : p
  }

  update(): void {
    const now = performance.now()
    const dt = Math.min(0.5, (now - this.lastUpdate) / 1000)
    this.lastUpdate = now
    this.tiles.setResolutionFromRenderer(this.camera, this.renderer)
    this.tiles.update()
    this.buildings?.update(dt, this.camera.position)
    this.trees?.update(dt, this.camera.position)
    this.landmarks?.update(dt, this.camera.position)
    this.bridges?.update(dt, this.camera.position)
    if (this.power) {
      this.power.setView(this.camera as PerspectiveCamera, this.renderer.getDrawingBufferSize(_size).y)
      this.power.update(dt, this.camera.position)
    }
    this.water?.update(dt, this.camera.position)
    // malla fina del MDT alrededor de la cámara (≈ ±400 m), para que el suelo del aparato no espere
    this.prefetchTimer -= dt
    if ((this.heights || this.gridRunways) && this.prefetchTimer <= 0) {
      this.prefetchTimer = 0.5
      const g = this.frame.worldToGeo(this.camera.position)
      if (this.heights) {
        const dLat = 0.0036
        const dLon = dLat / Math.cos(g.lat * DEG)
        void this.heights.ensure(g.lat - dLat, g.lon - dLon, g.lat + dLat, g.lon + dLon)
      }
      this.runways?.update(g.lat, g.lon)
      this.gridRunways?.update(g.lat, g.lon)
    }
    // pistas nuevas (o que se van): volver a alisar las teselas ya cargadas
    if (this.runways?.consumeChanged()) this.runways.reapply(this.meshes)
    this.gridRunways?.sync(this.meshes)
  }
  private prefetchTimer = 0

  updateAttribution(): void {
    let text = ''
    if (this.mode === 'google') {
      const attrs = (this.tiles as any).getAttributions?.() ?? []
      const parts: string[] = []
      for (const a of attrs) if (a.type === 'string') parts.push(a.value)
      text = `Google · ${parts.join(' · ')}`
    } else {
      text = this.imageryName
      if (this.power?.enabled && this.power.towerCount > 0) {
        const en = getLang() === 'en'
        text += (en ? ' · Power lines © OpenStreetMap contributors' : ' · Tendidos © colaboradores de OpenStreetMap') + (this.power.usingOpenInfraMap ? ' (OpenInfraMap)' : '')
      }
    }
    if (this.attributionEl.textContent !== text) this.attributionEl.textContent = text
  }

  /** Re-centra el origen del mundo en (lat, lon). Devuelve M (p_nuevo = M·p_viejo). */
  rebase(lat: number, lon: number, out: Matrix4): Matrix4 {
    const old = this.frame.worldToECEF.clone()
    this.frame.setOrigin(lat, lon, 0)
    out.multiplyMatrices(this.frame.ecefToWorld, old)
    // el origen ya se ha movido: un fallo al recolocar el escenario no puede cortar el re-centrado
    // (el llamador tiene que mover el aparato con `out`; si no, se repetiría en cada fotograma)
    try {
      this.tiles.group.matrix.copy(this.frame.ecefToWorld)
      this.tiles.group.updateMatrixWorld(true)
      this.buildings?.syncFrame()
      this.trees?.syncFrame()
      this.landmarks?.syncFrame()
      this.bridges?.syncFrame()
      this.power?.syncFrame()
    } catch (e) {
      console.error('Error recolocando el escenario al re-centrar el origen:', e)
    }
    return out
  }

  /** Altura del MDT (m) en un punto; null si aún no hay datos. */
  private elevation(latDeg: number, lonDeg: number): number | null {
    if (this.heights) {
      const h = this.heights.sample(latDeg, lonDeg)
      // pistas alisadas: la misma superficie que la rejilla con que se dibujan (Runways.ts)
      return h === null || !this.runways ? h : this.runways.adjust(latDeg, lonDeg, h)
    }
    if (this.terrain) return this.terrain.sampleCartographicElevation(latDeg * DEG, lonDeg * DEG) ?? null
    return null
  }

  /**
   * Altura del suelo (Y del mundo) bajo (x, z) y normal; false si aún no hay datos.
   * yHint: altura desde la que lanzar el rayo (por encima del aparato).
   * deckMaxY: si se da, cuenta también la calzada de un puente que quede por debajo de esa
   * altura (la del aparato: se puede rodar y posarse en el tablero; uno más alto es un techo).
   * (deckDirX, deckDirZ): rumbo de un vehículo del tráfico; solo cuentan los tableros que lo llevan.
   */
  sampleGround(x: number, z: number, yHint: number, out: GroundSample, deckMaxY?: number, deckDirX = 0, deckDirZ = 0): boolean {
    const ok = this.sampleTerrain(x, z, yHint, out)
    if (deckMaxY !== undefined && this.bridges?.deckBelow(x, z, deckMaxY, _deck, deckDirX, deckDirZ) && (!ok || _deck.y > out.y)) {
      out.y = _deck.y
      out.normal.copy(_deck.normal)
      return true
    }
    return ok
  }

  /** Altura del terreno (sin puentes) bajo (x, z) y normal. */
  private sampleTerrain(x: number, z: number, yHint: number, out: GroundSample): boolean {
    if (this.heights || this.terrain) {
      const g = this.frame.worldToGeo(_p.set(x, yHint, z))
      const h = this.elevation(g.lat, g.lon)
      if (h === null) return false
      this.frame.geoToWorld(g.lat, g.lon, h, _p)
      out.y = _p.y
      // normal por diferencias finitas (≈ 6 m)
      const s = 6
      const ga = this.frame.worldToGeo(_p.set(x + s, yHint, z))
      const gb = this.frame.worldToGeo(_p.set(x, yHint, z + s))
      const ha = this.elevation(ga.lat, ga.lon) ?? h
      const hb = this.elevation(gb.lat, gb.lon) ?? h
      const ya = this.frame.geoToWorld(ga.lat, ga.lon, ha, _p).y
      const yb = this.frame.geoToWorld(gb.lat, gb.lon, hb, _p).y
      out.normal.set(-(ya - out.y) / s, 1, -(yb - out.y) / s).normalize()
      return true
    }
    _o.set(x, yHint, z)
    _d.set(0, -1, 0)
    const hit = this.raycast(_o, _d, 5000)
    if (!hit) return false
    out.y = hit.point.y
    if (hit.normal) out.normal.copy(hit.normal)
    else out.normal.set(0, 1, 0)
    if (out.normal.y < 0) out.normal.negate()
    return true
  }

  /**
   * Agua bajo el punto (mundo) para la física: cuánta (0,5 = la orilla), de qué clase y qué profundidad
   * (WaterMask.sample); null si aún no se sabe o si el escenario no tiene máscara de agua (Google).
   */
  waterSample(x: number, y: number, z: number, withDepth = true): WaterSample | null {
    if (!this.water) return null
    const g = this.frame.worldToGeo(_wp.set(x, y, z))
    return this.water.sample(g.lat, g.lon, withDepth)
  }

  /** ¿El punto (mundo) está dentro de un edificio de OpenStreetMap? */
  hitsBuilding(p: Vector3): boolean {
    return (this.buildings?.collides(p) ?? false) || (this.landmarks?.collides(p) ?? false)
  }

  /** ¿Choca el punto (mundo) con un edificio, un puente o la copa de un árbol? */
  hitsObstacle(p: Vector3): 'building' | 'bridge' | 'pylon' | 'tree' | 'vehicle' | null {
    if (this.traffic?.enabled && this.traffic.collides(p)) return 'vehicle'
    if (this.buildings?.collides(p) || this.landmarks?.collides(p)) return 'building'
    if (this.bridges?.collides(p)) return 'bridge'
    if (this.power?.collides(p)) return 'pylon'
    if (this.trees?.collides(p)) return 'tree'
    return null
  }

  /** ¿El punto (mundo) está dentro de un edificio? (los barcos amarrados bajo un edificio no se dibujan) */
  insideBuilding(p: Vector3): boolean {
    return !!(this.buildings?.collides(p) || this.landmarks?.collides(p))
  }

  /** Luz ambiente del cielo para edificios y árboles (el mismo mapa que el aparato). */
  setEnvMap(tex: Texture | null): void {
    this.buildings?.setEnvMap(tex)
    this.trees?.setEnvMap(tex)
    this.landmarks?.setEnvMap(tex)
    this.bridges?.setEnvMap(tex)
    this.power?.setEnvMap(tex)
    this.traffic?.setEnvMap(tex)
  }

  /** Raycast contra la geometría cargada (tiles de Google). */
  raycast(origin: Vector3, dir: Vector3, far: number): { point: Vector3; normal: Vector3 | null; distance: number } | null {
    if (this.terrain) return null
    _ray.set(origin, dir)
    _ray.far = far
    ;(_ray as any).firstHitOnly = true
    let best: any = null
    for (const m of this.meshes) {
      if (!m.visible || !isVisibleChain(m)) continue
      const geo = m.geometry
      if (!geo.boundingSphere) geo.computeBoundingSphere()
      // descarte rápido por esfera envolvente
      _p.copy(geo.boundingSphere!.center).applyMatrix4(m.matrixWorld)
      const r = geo.boundingSphere!.radius * maxScale(m)
      const toC = _o.copy(_p).sub(origin)
      const along = toC.dot(dir)
      if (along < -r || along > far + r) continue
      const distSq = toC.lengthSq() - along * along
      if (distSq > r * r) continue
      if (!(geo as any).boundsTree && !(geo as any).__noBVH) {
        try {
          ;(geo as any).computeBoundsTree()
        } catch {
          ;(geo as any).__noBVH = true // geometría no compatible: raycast normal
        }
      }
      _hits.length = 0
      m.raycast(_ray, _hits)
      for (const h of _hits) if (!best || h.distance < best.distance) best = h
    }
    if (!best) return null
    const normal = best.face ? best.face.normal.clone().transformDirection(best.object.matrixWorld) : null
    return { point: best.point.clone(), normal, distance: best.distance }
  }

  dispose(): void {
    this.scene.remove(this.tiles.group)
    this.tiles.dispose()
    this.meshes.clear()
    if (this.buildings) {
      this.scene.remove(this.buildings.group)
      this.buildings.dispose()
    }
    if (this.trees) {
      this.scene.remove(this.trees.group)
      this.trees.dispose()
    }
    if (this.landmarks) {
      this.scene.remove(this.landmarks.group)
      this.landmarks.dispose()
    }
    if (this.bridges) {
      this.scene.remove(this.bridges.group, this.bridges.decals)
      this.bridges.dispose()
    }
    if (this.power) {
      this.scene.remove(this.power.group)
      this.power.dispose()
    }
    this.powerCoarse?.dispose()
    this.traffic?.dispose()
    this.bridgeHeights?.dispose()
    this.water?.dispose()
    this.runways?.dispose()
    this.gridRunways?.dispose()
    this.heights?.dispose()
    this.buildingHeights?.dispose()
  }
}

/**
 * 3d-tiles-renderer 0.5.4: el overlay de la ortofoto cuenta las regiones visibles y lanza un
 * error si la cuenta baja de cero. Pasa al recargar una tesela que se está viendo (Runways.reapply
 * la saca de la caché para mallarla en rejilla cuando aparece una pista o el rebaje de un puente):
 * al descargarla ya se descuenta su región, y si la nueva descarga empieza antes de que el
 * renderizador la dé por no visible, ese aviso la descuenta otra vez. Aquí el descuento de más
 * se ignora (la cuenta ya está a cero, que es lo cierto).
 */
function guardRegionCounts<T extends object>(overlay: T): T {
  const o = overlay as any
  const base = o.setRegionVisible
  if (typeof base !== 'function') return overlay
  o.setRegionVisible = function (this: any, range: number[], visible: boolean, ...rest: unknown[]) {
    if (!visible) {
      const entry = this._visibleRegionCounts?.get(range.join('_'))
      if (!entry || entry.count <= 0) return
    }
    return base.call(this, range, visible, ...rest)
  }
  return overlay
}

/**
 * 3d-tiles-renderer 0.5.4: TilesGroup.updateMatrixWorld, cuando cambia la matriz del grupo
 * (re-centrado del origen), actualiza también las teselas activas ocultas y da por hecho que
 * todas tienen escena; una tesela cargada sin modelo la tiene a null y revienta. Si eso pasa,
 * World.rebase se corta a medias (origen movido, aparato no) y se repite en cada fotograma.
 * Misma función que la de la librería, saltando las teselas sin escena.
 */
function guardTilesGroup(group: Object3D): void {
  const tmp = new Matrix4()
  const g = group as any
  g.updateMatrixWorld = function (this: any, force?: boolean): void {
    if (this.matrixAutoUpdate) this.updateMatrix()
    if (!this.matrixWorldNeedsUpdate && !force) return
    if (this.parent === null) tmp.copy(this.matrix)
    else tmp.multiplyMatrices(this.parent.matrixWorld, this.matrix)
    this.matrixWorldNeedsUpdate = false
    const a = tmp.elements
    const b = this.matrixWorld.elements
    let changed = false
    for (let i = 0; i < 16; i++) {
      if (Math.abs(a[i] - b[i]) > Number.EPSILON) {
        changed = true
        break
      }
    }
    if (!changed) return
    this.matrixWorld.copy(tmp)
    this.matrixWorldInverse.copy(tmp).invert()
    const children = this.children as Object3D[]
    for (let i = 0; i < children.length; i++) children[i].updateMatrixWorld()
    const { activeTiles, visibleTiles } = this.tilesRenderer
    activeTiles.forEach((tile: any) => {
      if (!visibleTiles.has(tile)) tile.engineData?.scene?.updateMatrixWorld(true)
    })
  }
}

function isVisibleChain(o: Object3D): boolean {
  let p: Object3D | null = o
  while (p) {
    if (!p.visible) return false
    p = p.parent
  }
  return true
}

function maxScale(o: Object3D): number {
  const e = o.matrixWorld.elements
  const sx = Math.hypot(e[0], e[1], e[2])
  const sy = Math.hypot(e[4], e[5], e[6])
  const sz = Math.hypot(e[8], e[9], e[10])
  return Math.max(sx, sy, sz)
}
