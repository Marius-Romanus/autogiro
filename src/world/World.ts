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
  Vector3,
  type Camera,
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
import { Runways } from './Runways.ts'
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
const _hits: any[] = []

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

  /** Geometría real (Google o malla del IGN): admite el pase de normales para iluminar el relieve. */
  get realGeometry(): boolean {
    return this.mode === 'google' || this.terrainKind === 'ign'
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
      const makeOverlay = () => new XYZTilesOverlay({ url: imageryUrl, levels: src === 'pnoa' ? 20 : 19 })
      const ign = usesIgnTerrain(this.settings, lat, lon)
      this.terrainKind = ign ? 'ign' : 'terrarium'
      const en = getLang() === 'en'
      const relief = `${en ? 'Terrain' : 'Relieve'}: ${ign ? 'MDT05 © IGN (scne.es)' : 'Mapzen/AWS Terrain Tiles'}`
      this.imageryName =
        (src === 'pnoa'
          ? `${en ? 'PNOA orthophoto' : 'Ortofoto PNOA'} © Instituto Geográfico Nacional (scne.es) · ${relief}`
          : `${en ? 'Imagery' : 'Imágenes'} © Esri, Maxar, Earthstar Geographics · ${relief}`) +
        (this.settings.buildings ? (en ? ' · Buildings © OpenStreetMap contributors (OpenFreeMap)' : ' · Edificios © colaboradores de OpenStreetMap (OpenFreeMap)') : '') +
        (this.settings.buildings && this.settings.catastro && spain ? (en ? ' and Dirección General del Catastro' : ' y Dirección General del Catastro') : '')
      if (ign) {
        tiles = new TilesRenderer(IGN_QM)
        tiles.registerPlugin(new IgnAvailabilityPlugin())
        tiles.registerPlugin(new QuantizedMeshPlugin({ useRecommendedSettings: true }))
        tiles.registerPlugin(new UnlitTerrainPlugin())
        tiles.registerPlugin(new ImageOverlayPlugin({ overlays: [makeOverlay()], renderer: this.renderer, resolution: 256 } as any))
        tiles.registerPlugin(new TilesFadePlugin({ fadeDuration: 300 }))
        // la malla más fina (nivel 16, ≈ 230 × 300 m por tesela) para el suelo del aparato
        const qm = new QMHeightSource(IGN_QM, 16)
        this.heights = qm
        // el MDT tiene costuras de algunos decímetros: las pistas se alisan (Runways.ts)
        this.runways = new Runways(qm, tiles as any)
        tiles.registerPlugin(this.runways.plugin())
        // y un nivel menos para asentar los edificios (cuatro veces menos peticiones)
        if (this.settings.buildings || this.settings.trees) this.buildingHeights = new QMHeightSource(IGN_QM, 15)
      } else {
        tiles = new TilesRenderer()
        this.terrain = new TerrariumMeshPlugin({
          url: TERRARIUM,
          maxZoom: 15,
          overlay: makeOverlay(),
          applyOverlayTexture: true,
          unlit: true,
        })
        tiles.registerPlugin(this.terrain as object)
        tiles.registerPlugin(new TilesFadePlugin({ fadeDuration: 300 }))
        if (this.settings.buildings || this.settings.trees) this.buildingHeights = new TerrariumHeightSource(TERRARIUM, 15)
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
    }
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
    } else if (this.terrainKind === 'ign') {
      // error en píxeles de la malla y de la textura compuesta de cada tesela
      t.errorTarget = { low: 3, medium: 2, high: 1.4, ultra: 1 }[q]
    } else {
      // 1 = un texel de ortofoto por píxel de pantalla
      t.errorTarget = { low: 2.2, medium: 1.5, high: 1.0, ultra: 0.75 }[q]
    }
    if (this.buildings) this.buildings.radius = { low: 2200, medium: 3500, high: 5000, ultra: 7000 }[q]
    if (this.trees) {
      this.trees.radius = { low: 900, medium: 1400, high: 2000, ultra: 2800 }[q]
      this.trees.maxPerTile = { low: 8000, medium: 16000, high: 30000, ultra: 45000 }[q]
    }
  }

  get loadProgress(): number {
    const p = (this.tiles as any).loadProgress ?? 1
    // sin el perfil de las pistas cercanas el aparato se posaría en el MDT sin alisar
    if (this.runways?.pending) return Math.min(p, 0.95)
    // edificios del Catastro de alrededor del punto de salida (espera como mucho 25 s)
    return this.buildings?.catastroBusy ? Math.min(p, 0.97) : p
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
    // malla fina del MDT alrededor de la cámara (≈ ±400 m), para que el suelo del aparato no espere
    this.prefetchTimer -= dt
    if (this.heights && this.prefetchTimer <= 0) {
      this.prefetchTimer = 0.5
      const g = this.frame.worldToGeo(this.camera.position)
      const dLat = 0.0036
      const dLon = dLat / Math.cos(g.lat * DEG)
      void this.heights.ensure(g.lat - dLat, g.lon - dLon, g.lat + dLat, g.lon + dLon)
      this.runways?.update(g.lat, g.lon)
    }
    // pistas nuevas (o que se van): volver a alisar las teselas ya cargadas
    if (this.runways?.consumeChanged()) this.runways.reapply(this.meshes)
  }
  private prefetchTimer = 0

  updateAttribution(): void {
    let text = ''
    if (this.mode === 'google') {
      const attrs = (this.tiles as any).getAttributions?.() ?? []
      const parts: string[] = []
      for (const a of attrs) if (a.type === 'string') parts.push(a.value)
      text = `Google · ${parts.join(' · ')}`
    } else text = this.imageryName
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
   * Altura del terreno (Y del mundo) bajo (x, z) y normal. `null` si aún no hay datos.
   * yHint: altura desde la que lanzar el rayo (por encima del aparato).
   */
  sampleGround(x: number, z: number, yHint: number, out: GroundSample): boolean {
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

  /** ¿El punto (mundo) está dentro de un edificio de OpenStreetMap? */
  hitsBuilding(p: Vector3): boolean {
    return (this.buildings?.collides(p) ?? false) || (this.landmarks?.collides(p) ?? false)
  }

  /** ¿Choca el punto (mundo) con un edificio o con la copa de un árbol? */
  hitsObstacle(p: Vector3): 'building' | 'tree' | null {
    if (this.buildings?.collides(p) || this.landmarks?.collides(p)) return 'building'
    if (this.trees?.collides(p)) return 'tree'
    return null
  }

  /** Luz ambiente del cielo para edificios y árboles (el mismo mapa que el aparato). */
  setEnvMap(tex: Texture | null): void {
    this.buildings?.setEnvMap(tex)
    this.trees?.setEnvMap(tex)
    this.landmarks?.setEnvMap(tex)
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
    this.runways?.dispose()
    this.heights?.dispose()
    this.buildingHeights?.dispose()
  }
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
