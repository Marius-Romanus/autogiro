// Edificios 3D de OpenStreetMap (teselas vectoriales de OpenFreeMap, esquema
// OpenMapTiles): huella real de cada edificio extruida a su altura (etiquetas
// height / building:levels; en España casi todos vienen del Catastro) y asentada
// sobre el relieve con las mismas alturas que dibuja el terreno.
//
// - Tejados del color de la ortofoto en ese punto (se ven como en la foto).
// - Fachadas de colores habituales en España, con ventanas por planta hechas en
//   el shader (se funden a un tono medio cuando son más pequeñas que un píxel).
// - Materiales iluminados por el sol y el cielo reales (alfa = 0: igual que el
//   aparato, no se vuelven a iluminar en posproceso; la bruma sí se aplica).
//
// - Tejados inclinados deducidos de la planta (roofShapes.ts): a dos o cuatro aguas en las
//   casas, bóveda en los hangares, faldones desde cada fachada en las plantas irregulares
//   (esto último en un worker). Planos: bloques altos, naves y edificios con partes.
// - En España, además, los edificios del Catastro que no estén en OpenStreetMap (con su
//   número real de plantas), descargados por delante del aparato (catastro/).
//
// Se cargan por teselas z14 (~1,9 km) alrededor de la cámara (TileLayer),
// troceando el trabajo para no dar tirones, y se descargan al alejarse.

import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  Mesh,
  MeshStandardMaterial,
  ShapeUtils,
  Sphere,
  SRGBColorSpace,
  type Texture,
  Vector2,
  Vector3,
} from 'three'
import { BRIDGE_CABLE_STAYED, BRIDGE_EXTRADOSED, BRIDGE_SUSPENSION, type BridgeRecord } from './bridgeFormat.ts'
import { widthOf } from './bridgeNet.ts'
import { deckLines, towerCut, type TowerCut } from './bridgeTowers.ts'
import { bridgeRecordsIn } from './bridgeStructures.ts'
import { catastro, type BBox, type CatTile, type Circle } from './catastro/Catastro.ts'
import type { GeoFrame } from './GeoFrame.ts'
import type { HeightSource } from './HeightSource.ts'
import { classifyRings, fetchVectorTile, latToY, loadOrthoMosaic, lonToX, xToLon, yToLat, Z, type Ring } from './mapTiles.ts'
import { facadeColour, parseOsmColour, roofColour } from './osmColour.ts'
import { WX_BUILDING_GLSL, WX_COMMON_GLSL, weatherUniforms } from '../render/weathering.ts'
import { lampGridUniforms, nightUniforms, streetLampGLSL } from '../render/nightLights.ts'
import { ROOF_CONE, ROOF_DOME, ROOF_FLAT, ROOF_GABLED, ROOF_HIPPED, ROOF_ONION, ROOF_PYRAMIDAL, ROOF_ROUND, ROOF_SKILLION } from './osmRoofFormat.ts'
import { osmRoofsTile, type OsmRoof } from './osmRoofs.ts'
import { worldRoofsTile } from './worldRoofs.ts'
import { landmarkNear, replacedByLandmark } from './Landmarks.ts'
import type { RoofJob } from './roof.worker.ts'
import { buildRoofs } from './roofClient.ts'
import {
  orientedBox,
  PROFILE_DOME,
  PROFILE_ONION,
  PROFILE_SPIRE,
  radialRoof,
  rectRoof,
  ringCentroid,
  skillionHeights,
  starShaped,
  type OrientedBox,
  type RectKind,
  type SmoothMesh,
} from './roofShapes.ts'
import { Slicer, TileLayer, type LayerTile } from './TileLayer.ts'

/** altura de una planta del Catastro (m) */
const FLOOR_H = 3.0
/** pendiente de las viviendas y de las plantas grandes (naves pequeñas, manzanas) */
const PITCH_HOUSE = Math.tan((28 * Math.PI) / 180)
const PITCH_WIDE = Math.tan((15 * Math.PI) / 180)
/** subida máxima de un tejado inclinado (m): las plantas muy anchas quedan con azotea en medio */
const ROOF_CAP = 4

/** Un tejado del worker pendiente: se dibuja cuando llega (o plano si no se pudo). */
interface DeferredRoof {
  job: RoofJob
  emit: (tris: Float32Array | null) => void
}

interface Built {
  mesh: Mesh | null
  prisms: Prism[]
  count: number
}

interface Prism {
  /** huella en coordenadas locales de la tesela (x, z alternados) */
  ring: Float32Array
  minX: number
  maxX: number
  minZ: number
  maxZ: number
  base: number
  top: number
}

interface BuildingTile extends LayerTile {
  mesh: Mesh | null
  prisms: Prism[]
  /** falta algún municipio del Catastro que toca esta tesela (se rehará cuando llegue) */
  catPending: boolean
  /** el Catastro cambió mientras se construía: rehacerla al terminar */
  needsRebuild: boolean
}

export class Buildings extends TileLayer<BuildingTile> {
  /** edificios en escena (para el menú / depuración) */
  count = 0
  private readonly material: MeshStandardMaterial
  private readonly heights: HeightSource
  /** plantilla XYZ de la ortofoto para el color de los tejados (null = colores genéricos) */
  private readonly imageryUrl: string | null
  /** completar con los edificios del Catastro (España) */
  private readonly useCatastro: boolean
  private readonly offCatastro: (() => void) | null = null
  private readonly rebuildQueue: string[] = []
  private readonly rebuildTries = new Map<string, number>()
  private rebuilding = false
  private readonly bornAt = performance.now()
  // para pedir al Catastro lo que viene por delante
  private wantTimer = 0
  private lastGeo: { lat: number; lon: number; t: number } | null = null
  /** desplazamientos de los tres últimos segundos (m/s hacia el este y el norte) */
  private readonly steps: Array<{ e: number; n: number }> = []

  constructor(worldFrame: GeoFrame, heights: HeightSource, imageryUrl: string | null, useCatastro = false) {
    super(worldFrame, 'buildings')
    this.radius = 4000
    this.heights = heights
    this.imageryUrl = imageryUrl
    this.material = createBuildingMaterial()
    this.useCatastro = useCatastro
    if (useCatastro) this.offCatastro = catastro.onTiles((keys, bbox) => this.catastroChanged(keys, bbox))
  }

  override update(dt: number, cameraWorld: Vector3): void {
    super.update(dt, cameraWorld)
    if (this.useCatastro && this.enabled && !this.disposed) this.wantAhead(dt, cameraWorld)
  }

  /**
   * ¿Esperar al Catastro antes de despegar? Mientras falten municipios para las teselas de
   * alrededor del punto de salida (como mucho 25 s: si el servicio va lento, se vuela igual
   * y los edificios aparecen al llegar).
   */
  get catastroBusy(): boolean {
    if (!this.useCatastro || performance.now() - this.bornAt > 25000) return false
    for (const t of this.tiles.values()) if (t.dist <= 0.6 && (t.state === 'loading' || t.catPending)) return true
    return false
  }

  /**
   * Pide al Catastro la zona de alrededor y la que viene por delante (1 a 5 minutos al rumbo
   * y velocidad actuales, hasta 12 km): un municipio son 1-6 MB que se bajan en segundos,
   * así que suele estar listo antes de que sus teselas entren en el radio de edificios.
   */
  private wantAhead(dt: number, cam: Vector3): void {
    this.wantTimer -= dt
    if (this.wantTimer > 0) return
    this.wantTimer = 1
    const g = this.worldFrame.worldToGeo(cam)
    const now = performance.now() / 1000
    const kx = 111320 * Math.cos((g.lat * Math.PI) / 180)
    if (this.lastGeo) {
      const dtS = Math.max(0.2, now - this.lastGeo.t)
      this.steps.push({ e: ((g.lon - this.lastGeo.lon) * kx) / dtS, n: ((g.lat - this.lastGeo.lat) * 111320) / dtS })
      if (this.steps.length > 3) this.steps.shift()
    }
    this.lastGeo = { lat: g.lat, lon: g.lon, t: now }
    // Velocidad: la media de los tres últimos segundos, y solo si en los tres se ha avanzado.
    // Un salto de cámara (aparecer, cambiar de vista) dura una muestra y no es velocidad: tomarlo
    // por tal hacía bajar, parado en la pista, una docena de municipios a 15 km en esa dirección.
    const vel = { e: 0, n: 0 }
    if (this.steps.length === 3 && this.steps.every((s) => Math.hypot(s.e, s.n) > 5 && Math.hypot(s.e, s.n) < 150)) {
      for (const s of this.steps) {
        vel.e += s.e / 3
        vel.n += s.n / 3
      }
    }
    const circles: Circle[] = [{ lat: g.lat, lon: g.lon, r: this.radius + 1000 }]
    const speed = Math.hypot(vel.e, vel.n)
    if (speed > 5) {
      for (const tAhead of [60, 120, 180, 240, 300]) {
        const d = Math.min(speed * tAhead, 12000)
        const lat = g.lat + (vel.n / speed) * (d / 111320)
        const lon = g.lon + (vel.e / speed) * (d / kx)
        circles.push({ lat, lon, r: this.radius })
        if (d >= 12000) break
      }
    }
    catastro.want(circles)
  }

  /** Llegó (o se borró) un municipio: rehacer las teselas cargadas que toca, de una en una. */
  private catastroChanged(keys: string[], bbox: BBox | null = null): void {
    for (const k of keys) {
      const t = this.tiles.get(k)
      if (!t) continue
      if (t.state === 'loading') t.needsRebuild = true
      else if (!this.rebuildQueue.includes(k)) this.rebuildQueue.push(k)
    }
    // las que lo esperaban sin tener edificios suyos (su recuadro las toca, pero no hay nada)
    // solo dejan de esperar: no hace falta rehacerlas
    if (bbox) {
      const n = 2 ** Z
      for (const t of this.tiles.values()) {
        if (!t.catPending || keys.includes(t.key)) continue
        const s = yToLat(t.y + 1, n)
        const nn = yToLat(t.y, n)
        const w = xToLon(t.x, n)
        const e = xToLon(t.x + 1, n)
        if (s > bbox.n || nn < bbox.s || w > bbox.e || e < bbox.w) continue
        void catastro.pending(t.x, t.y).then((p) => {
          if (this.tiles.get(t.key) === t && !t.needsRebuild) t.catPending = p
        })
      }
    }
    void this.pumpRebuilds()
  }

  private async pumpRebuilds(): Promise<void> {
    if (this.rebuilding) return
    this.rebuilding = true
    try {
      while (this.rebuildQueue.length > 0 && !this.disposed) {
        // la más cercana primero
        this.rebuildQueue.sort((a, b) => (this.tiles.get(a)?.dist ?? 99) - (this.tiles.get(b)?.dist ?? 99))
        const key = this.rebuildQueue.shift()!
        const t = this.tiles.get(key)
        if (!t || t.state === 'loading') continue
        let built: Built | null
        try {
          built = await this.buildTile(t)
        } catch (e) {
          // falló una petición (o la tesela se descargó mientras tanto): las demás siguen,
          // y esta se reintenta a los 4, 8 y 12 s
          if (!t.abort.signal.aborted && this.tiles.get(key) === t) {
            const n = (this.rebuildTries.get(key) ?? 0) + 1
            this.rebuildTries.set(key, n)
            if (n <= 3) setTimeout(() => !this.disposed && this.tiles.get(key) === t && this.catastroChanged([key]), 4000 * n)
            else console.warn('buildings: no se pudo rehacer la tesela', key, e)
          }
          continue
        }
        this.rebuildTries.delete(key)
        if (!built || t.abort.signal.aborted || this.tiles.get(key) !== t) continue
        this.attach(t, built)
      }
    } finally {
      this.rebuilding = false
    }
  }

  /** Mapa de entorno del cielo (el mismo que ilumina el aparato): luz ambiente de las fachadas en sombra. */
  setEnvMap(tex: Texture | null): void {
    const m = this.material
    if ((m.envMap === null) !== (tex === null)) m.needsUpdate = true
    m.envMap = tex
    m.envMapIntensity = 1
  }

  /** ¿El punto (mundo) está dentro de algún edificio? */
  collides(p: Vector3): boolean {
    const t = this.tileAt(p, _q)
    if (!t) return false
    const q = _q
    for (const b of t.prisms) {
      if (q.x < b.minX || q.x > b.maxX || q.z < b.minZ || q.z > b.maxZ) continue
      if (q.y < b.base || q.y > b.top) continue
      if (pointInRing(b.ring, q.x, q.z)) return true
    }
    return false
  }

  /**
   * Altura (m) del edificio que hay en (lat°, lon°): 0 si no hay ninguno y −1 si esa tesela aún no
   * está cargada. Para el viento (estela de los edificios, src/world/WindField.ts); con un índice
   * por tesela, porque se pregunta por miles de puntos.
   */
  heightAtGeo(lat: number, lon: number): number {
    const n = 2 ** this.zoom
    const t = this.tiles.get(`${Math.floor(lonToX(lon, n))}/${Math.floor(latToY(lat, n))}`)
    if (!t || (t.state !== 'ready' && t.state !== 'empty')) return -1
    if (t.prisms.length === 0) return 0
    let ix = prismIndex.get(t.prisms)
    if (!ix) prismIndex.set(t.prisms, (ix = indexPrisms(t.prisms)))
    t.frame.geoToWorld(lat, lon, 0, _q)
    const i = Math.floor((_q.x - ix.x0) / ix.cell)
    const j = Math.floor((_q.z - ix.z0) / ix.cell)
    if (i < 0 || j < 0 || i >= PRISM_GRID || j >= PRISM_GRID) return 0
    let h = 0
    for (const b of ix.cells[j * PRISM_GRID + i]) {
      if (_q.x < b.minX || _q.x > b.maxX || _q.z < b.minZ || _q.z > b.maxZ) continue
      if (b.top - b.base > h && pointInRing(b.ring, _q.x, _q.z)) h = b.top - b.base
    }
    return h
  }

  override dispose(): void {
    super.dispose()
    this.offCatastro?.()
    this.material.dispose()
  }

  // -------------------------------------------------------------------------

  protected createTile(base: LayerTile): BuildingTile {
    return { ...base, mesh: null, prisms: [], catPending: false, needsRebuild: false }
  }

  protected disposeTile(t: BuildingTile): void {
    if (!t.mesh) return
    this.group.remove(t.mesh)
    t.mesh.geometry.dispose()
    this.count -= (t.mesh.userData.count as number) ?? 0
    t.mesh = null
  }

  protected async loadTile(t: BuildingTile): Promise<void> {
    const built = await this.buildTile(t)
    if (!built || t.abort.signal.aborted || this.disposed) return
    this.attach(t, built)
    if (t.needsRebuild) {
      t.needsRebuild = false
      this.catastroChanged([t.key])
    }
  }

  /** Pone en escena lo construido (sustituyendo lo anterior de la tesela, si lo había). */
  private attach(t: BuildingTile, built: Built): void {
    this.disposeTile(t)
    t.prisms = built.prisms
    if (!built.mesh) {
      t.state = 'empty'
      return
    }
    const mesh = built.mesh
    mesh.matrixAutoUpdate = false
    mesh.matrix.copy(t.frame.worldToECEF)
    mesh.receiveShadow = true
    mesh.castShadow = false
    mesh.userData.count = built.count
    mesh.name = `buildings ${t.key}`
    this.group.add(mesh)
    mesh.updateMatrixWorld(true)
    t.mesh = mesh
    t.state = 'ready'
    this.count += built.count
  }

  /** Construye los edificios de la tesela (OpenStreetMap + Catastro) sin tocar la escena. */
  private async buildTile(t: BuildingTile): Promise<Built | null> {
    const signal = t.abort.signal
    const n = 2 ** Z
    const north = yToLat(t.y, n)
    const south = yToLat(t.y + 1, n)
    const west = xToLon(t.x, n)
    const east = xToLon(t.x + 1, n)
    const [vt, ortho, , cat, osmRoofs, worldRoofs] = await Promise.all([
      fetchVectorTile(t.x, t.y, signal),
      this.imageryUrl ? loadOrthoMosaic(this.imageryUrl, t.x, t.y, signal) : Promise.resolve(null),
      this.heights.ensure(south - 0.001, west - 0.001, north + 0.001, east + 0.001),
      this.useCatastro ? catastro.tile(t.x, t.y) : Promise.resolve(null),
      osmRoofsTile(t.x, t.y),
      // fuera de España, los del fichero mundial (por zonas: worldRoofs.ts)
      worldRoofsTile(t.x, t.y),
    ])
    if (signal.aborted) return null
    t.catPending = cat?.pending ?? false
    const colours = ortho ? new RoofColours(ortho.data, ortho.width) : null
    const layer = vt.layers.building
    const catData = cat?.data ?? []
    if ((!layer || layer.length === 0) && catData.length === 0) return { mesh: null, prisms: [], count: 0 }

    const builder = new GeometryBuilder()
    const E = layer?.extent ?? 4096
    const toGeo = (px: number, py: number): [number, number] => [yToLat(t.y + py / E, n), xToLon(t.x + px / E, n)]
    // recintos de aeródromo: lo que hay dentro son hangares (aspecto de nave)
    const aerodromes = aerodromePolygons(vt, E)
    const slicer = new Slicer(6)
    const prisms: Prism[] = []
    const deferred: DeferredRoof[] = []
    const add = (rings: Array<{ pts: Array<[number, number]>; cut: boolean[] }>, height: number, minHeight: number, colour: string | null, hangar: boolean, osmRoof: OsmRoof | null = null) =>
      this.addBuilding(builder, t.frame, prisms, deferred, rings, toGeo, height, minHeight, colour, colours, E, hangar, t.x * E, t.y * E, osmRoof)
    let buildings = 0
    // monumentos modelados aparte (Landmarks.ts): fuera sus edificios de OSM
    const landmarkHere = landmarkNear(south, west, north, east)
    // huellas de OSM (para no repetir con el Catastro los edificios que ya están)
    const osm = new RingGrid(E)
    // metros por unidad de la tesela vectorial (Mercator: igual en x que en y)
    const mPerPx = (40075016.7 * Math.cos((((north + south) / 2) * Math.PI) / 180)) / n / E
    // puentes de la tesela: hay contornos de puente etiquetados como edificio (building=bridge),
    // que saldrían como un bloque macizo de orilla a orilla; el puente lo dibuja Bridges.ts
    const bridgeLines = bridgeSamples(vt, E, mPerPx)
    // y las torres de algunos colgantes y atirantados, que OSM trae como un edificio macizo que
    // atraviesan los tableros (25 de Abril, Brooklyn, Verrazzano…): van como patas (towerCut)
    const decks = bridgeLines.length > 0 ? deckLines(vt, E, mPerPx, widthOf) : []
    const towersDone: Array<[number, number, number]> = []

    for (let i = 0; layer && i < layer.length; i++) {
      const f = layer.feature(i)
      if (f.type !== 3) continue
      const props = f.properties as Record<string, unknown>
      const height = Number(props.render_height ?? 5) || 5
      const minHeight = Number(props.render_min_height ?? 0) || 0
      const colour = typeof props.colour === 'string' ? props.colour : null
      for (const polygon of classifyRings(f.loadGeometry())) {
        // recortar a la tesela (los edificios que la cruzan se reparten entre teselas)
        const rings: Array<{ pts: Array<[number, number]>; cut: boolean[] }> = []
        for (const ring of polygon) {
          const pts = ring.map((p) => [p.x, p.y] as [number, number])
          if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop()
          const c = clipRing(pts, E)
          if (c.pts.length >= 3) rings.push(c)
        }
        if (rings.length === 0) continue
        osm.add(rings[0].pts)
        if (props.hide_3d) continue // contorno con partes (building:part) que ya se dibujan
        if (bridgeLines.length > 0 && coversBridge(rings, bridgeLines)) continue
        if (landmarkHere) {
          const [cx, cy] = ringCentroidArea(rings[0].pts)
          const [la, lo] = toGeo(cx, cy)
          if (replacedByLandmark(la, lo)) continue
        }
        // los que cruzan el borde: enteros en la tesela de su centroide si caben en su margen
        // (así llevan su tejado de OSM y no quedan partidos; p. ej. la pirámide de Keops)
        let draw = rings
        if (rings[0].cut.some(Boolean)) {
          const raw = polygon.map((ring) => {
            const pts = ring.map((p) => [p.x, p.y] as [number, number])
            if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop()
            return pts
          })
          const own = edgeOwner(raw[0], rings[0].pts, E)
          if (own === 'skip') continue // lo dibuja entero la tesela vecina
          if (own === 'whole') draw = raw.filter((pts) => pts.length >= 3).map((pts) => ({ pts, cut: pts.map(() => false) }))
          // aquí solo asoma: se omite si la vecina lo dibuja entero (si no, recortado, como siempre)
          else if (own !== 'clip' && (await neighbourDrawsWhole(t.x, t.y, own, rings[0].pts, E))) continue
          if (signal.aborted) return null
        }
        if (decks.length > 0 && height >= 25 && height - minHeight >= 20 && !draw[0].cut.some(Boolean)) {
          const cut = towerCut(draw[0].pts, decks, mPerPx)
          if (cut) {
            // (Brooklyn y Manhattan traen la huella dos veces, casi igual: una sola torre)
            const [tx, ty, ta] = ringCentroidArea(draw[0].pts)
            const twin = towersDone.some(([x, y, a]) => Math.hypot(x - tx, y - ty) * mPerPx < 3 && ta < 1.4 * a && a < 1.4 * ta)
            if (!twin) {
              towersDone.push([tx, ty, ta])
              const look = await this.towerLook(draw[0].pts, toGeo, colour)
              if (signal.aborted) return null
              if (look && this.addBridgeTower(builder, t.frame, prisms, deferred, draw[0].pts, cut, toGeo, height, minHeight, look, E, t.x * E, t.y * E, mPerPx)) buildings++
            }
            continue
          }
        }
        const hangar = aerodromes.length > 0 && inAnyPolygon(aerodromes, draw[0].pts)
        // forma del tejado mapeada en OSM (solo huellas enteras: las recortadas no casan)
        let osmRoof: OsmRoof | null = null
        if (osmRoofs && !draw[0].cut.some(Boolean)) {
          const [cx, cy, a] = ringCentroidArea(draw[0].pts)
          osmRoof = osmRoofs.match(cx, cy, a * mPerPx * mPerPx, mPerPx, E)
        }
        if (!osmRoof && worldRoofs && !draw[0].cut.some(Boolean)) {
          // (el fichero mundial guarda el rectángulo envolvente, no el área)
          let x0 = Infinity
          let y0 = Infinity
          let x1 = -Infinity
          let y1 = -Infinity
          for (const [px, py] of draw[0].pts) {
            if (px < x0) x0 = px
            if (px > x1) x1 = px
            if (py < y0) y0 = py
            if (py > y1) y1 = py
          }
          osmRoof = worldRoofs.match((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) * mPerPx, (y1 - y0) * mPerPx, mPerPx, E)
        }
        if (add(draw, height, minHeight, colour, hangar, osmRoof)) buildings++
      }
      // trocear el trabajo: ~6 ms por fotograma
      if (!(await slicer.yield(signal))) return null
    }

    // Catastro: las partes cuyo centro no cae dentro de un edificio de OSM
    let fromCatastro = 0
    let seen = 0
    for (const rec of catData) {
      for (let p = 0; p + 1 < rec.partRing.length; p++) {
        // (antes de los descartes: en ciudad casi todas las partes se descartan porque el edificio
        // ya está en OpenStreetMap, y con el corte al final del bucle no se cedía el hilo nunca:
        // tramos de 40 ms seguidos)
        if ((++seen & 31) === 0 && !(await slicer.yield(signal))) return null
        const rings = catastroRings(rec, p, E)
        if (rings.length === 0) continue
        const [cx, cy] = ringCentre(rings[0].pts)
        if (osm.contains(cx, cy)) continue
        // dentro de un aeródromo, solo lo de OSM: el Catastro registra como «construcción» de una
        // planta pistas y plataformas (en Casarrubios, 25 000 m² junto a la pista) y serían obstáculos
        if (aerodromes.length > 0 && inAnyPolygon(aerodromes, rings[0].pts)) continue
        // lo muy alargado y grande no es un edificio (pistas deportivas, viales cubiertos…)
        if (!looksLikeBuilding(rings[0].pts, mPerPx)) continue
        if (add(rings, rec.floors[p] * FLOOR_H, 0, null, false)) {
          buildings++
          fromCatastro++
        }
      }
    }

    // tejados de las plantas irregulares (worker)
    if (deferred.length > 0) {
      const res = await buildRoofs(
        deferred.map((d) => d.job),
        signal,
      )
      if (signal.aborted || this.disposed) return null
      for (let i = 0; i < deferred.length; i++) {
        deferred[i].emit(res[i] ?? null)
        if ((i & 31) === 0 && !(await slicer.yield(signal))) return null
      }
    }
    if (signal.aborted || this.disposed) return null
    if (buildings === 0) return { mesh: null, prisms, count: 0 }
    const mesh = new Mesh(builder.build(), this.material)
    mesh.userData.catastro = fromCatastro
    mesh.userData.osmRoofs = osmRoofs ? `${osmRoofs.matched}/${osmRoofs.size}` : null
    mesh.userData.worldRoofs = worldRoofs ? `${worldRoofs.matched}/${worldRoofs.size}` : null
    return { mesh, prisms, count: buildings }
  }

  private addBuilding(
    b: GeometryBuilder,
    frame: GeoFrame,
    prisms: Prism[],
    deferred: DeferredRoof[],
    rings: Array<{ pts: Array<[number, number]>; cut: boolean[] }>,
    toGeo: (px: number, py: number) => [number, number],
    height: number,
    minHeight: number,
    colour: string | null,
    colours: RoofColours | null,
    E: number,
    hangar: boolean,
    ox: number,
    oy: number,
    osm: OsmRoof | null = null,
    tower: TowerLook | null = null,
  ): boolean {
    // a coordenadas locales (curvatura incluida) y alturas del suelo
    const local: Vector3[][] = []
    let gMin = Infinity
    let gMax = -Infinity
    let cxp = 0
    let cyp = 0
    const outer = rings[0].pts
    for (const [px, py] of outer) {
      cxp += px
      cyp += py
    }
    cxp /= outer.length
    cyp /= outer.length
    for (let r = 0; r < rings.length; r++) {
      const ring = rings[r].pts
      const out: Vector3[] = []
      const step = Math.max(1, Math.floor(ring.length / 16))
      for (let k = 0; k < ring.length; k++) {
        const [lat, lon] = toGeo(ring[k][0], ring[k][1])
        const v = frame.geoToWorld(lat, lon, 0, new Vector3())
        out.push(v)
        if (r === 0 && k % step === 0) {
          const h = this.heights.sample(lat, lon)
          if (h !== null) {
            gMin = Math.min(gMin, h)
            gMax = Math.max(gMax, h)
          }
        }
      }
      local.push(out)
    }
    const [clat, clon] = toGeo(cxp, cyp)
    const hc = this.heights.sample(clat, clon)
    if (hc !== null) {
      gMin = Math.min(gMin, hc)
      gMax = Math.max(gMax, hc)
    }
    if (!isFinite(gMin)) return false
    // pieza de una torre de puente: todas con el mismo suelo, para que patas y travesaños casen
    const gOwn = gMin
    if (tower) gMin = tower.ground

    // área de la huella
    let area = 0
    for (let r = 0; r < local.length; r++) {
      const a = Math.abs(ringArea(local[r]))
      area += r === 0 ? a : -a
    }
    if (area < 6) return false

    // base hundida en el terreno (tapa los errores de la malla en pendiente);
    // tejado a su altura sobre el punto más bajo, y siempre algo por encima del más alto
    const parted = minHeight > 0.5
    const base = parted ? gMin + minHeight : Math.min(gMin, gOwn) - 1.5
    let top = gMin + height
    if (!parted) top = Math.max(top, gMax + Math.min(2.5, height))
    if (top - base < 1) return false

    // aspecto: nave / vivienda / bloque
    const seed = hash2(cxp + ox, cyp + oy)
    // nave: planta grande y poca altura (las manzanas de viviendas pasan de 10 m)
    // (en un aeropuerto grande, lo alto —torres, terminales— no es un hangar)
    const industrial = (hangar && height <= 16) || (area > 2500 && height <= 10) || (area > 900 && height <= 6)
    const wall = new Color()
    // color de fachada: en lo alto y en las partes, por casilla de ~8 m, para que las piezas
    // apiladas de una misma torre (building:part de OSM) no salgan cada una de un color
    const wallSeed = height > 12 || parted ? hash2(Math.round((cxp + ox) / 16), Math.round((cyp + oy) / 16)) : seed
    // (Color.set con un hexadecimal ya lo pasa de sRGB a lineal: no volver a convertirlo, que
    // oscurece y satura; así salían granates los ladrillos y rojo puro o morado lo de OSM)
    // building:colour de OSM (o el de building:material que pone OpenMapTiles), con el croma
    // de una pintura de fachada (osmColour.ts)
    const osmWall = parseOsmColour(colour)
    if (osmWall) wall.setRGB(...facadeColour(osmWall), SRGBColorSpace)
    else wall.set(pickWall(wallSeed, height, industrial))
    const roof = new Color()
    const rc = colours ? roofFromOrtho(colours, rings, cxp, cyp, E) : null
    if (rc) roof.setRGB(rc[0], rc[1], rc[2], SRGBColorSpace)
    else roof.set(industrial ? '#9a9890' : seed > 0.5 ? '#a4583e' : '#8f8a82')
    // color mapeado en OSM: roof:colour siempre; el de roof:material solo en lo alto, donde la
    // ortofoto (que no es ortogonal en las torres) da el color de la calle o de la fachada
    if (osm?.rgb && (!osm.fromMaterial || height >= 30)) {
      const c: [number, number, number] = [osm.rgb[0] / 255, osm.rgb[1] / 255, osm.rgb[2] / 255]
      roof.setRGB(...(osm.fromMaterial ? c : roofColour(c)), SRGBColorSpace)
    }
    if (tower) {
      wall.copy(tower.colour)
      roof.copy(tower.colour)
    }
    // un tejado en sombra en la foto no debe quedar negro (ni azulado: la sombra lo es)
    const lum = 0.2126 * roof.r + 0.7152 * roof.g + 0.0722 * roof.b
    if (lum < 0.05) roof.multiplyScalar(0.05 / Math.max(lum, 0.005)).lerp(_grey.setScalar(0.05), 0.5)
    roof.multiplyScalar(0.85)
    wall.multiplyScalar(0.85)

    // ventanas: altura de planta (0 = sin ventanas)
    // (ni en torres y cúpulas de OSM ni en las partes que empiezan en alto: campanarios,
    // chapiteles, linternas… no tienen pisos)
    const monument = parted || (osm !== null && (osm.shape === ROOF_PYRAMIDAL || osm.shape === ROOF_DOME || osm.shape === ROOF_ONION || osm.shape === ROOF_CONE))
    const floorH = tower || industrial || monument || height < 3.2 ? 0 : height > 40 ? 3.4 : 3.0

    // tejado mapeado en OSM: hasta dónde llegan las paredes y cuánto sube
    const plan = osm ? planOsmRoof(osm, local, top, base) : null

    // paredes
    const yb = base
    const yt = plan ? plan.wallTop : top
    for (let r = 0; r < local.length && yt - yb >= 0.05; r++) {
      const pts = local[r]
      const cut = rings[r].cut
      const sign = ringArea(pts) > 0 ? 1 : -1
      let u = 0
      for (let k = 0; k < pts.length; k++) {
        const a = pts[k]
        const c = pts[(k + 1) % pts.length]
        const len = Math.hypot(c.x - a.x, c.z - a.z)
        if (len < 0.05) continue
        if (!cut[k]) {
          // normal hacia fuera (para el exterior el lado derecho si el anillo es antihorario)
          const s = r === 0 ? sign : -sign
          const nx = (s * (c.z - a.z)) / len
          const nz = (-s * (c.x - a.x)) / len
          b.wall(a, c, yb, yt, nx, nz, u, u + len, base - gMin, yt - gMin, floorH, wall)
        }
        u += len
      }
    }
    // tejado
    const flatRoof = () => {
      const contour = local[0].map((p) => new Vector2(p.x, p.z))
      const holes = local.slice(1).map((h) => h.map((p) => new Vector2(p.x, p.z)))
      b.roof(local.flat(), ShapeUtils.triangulateShape(contour, holes), yt, roof)
    }
    // inclinado: casas y bloques bajos (hasta 5 plantas) enteros en la tesela; las naves,
    // los bloques altos y los edificios con partes (torres, cúpulas de OSM) quedan planos
    const anyCut = rings.some((r) => r.cut.some(Boolean))
    const outerArea = Math.abs(ringArea(local[0]))
    let rise = 0
    if (plan) rise = drawOsmRoof(b, local, plan, yt, roof, wall, yt - gMin, deferred, flatRoof)
    else if (!parted && !anyCut && height <= 15.5 && area >= 12 && outerArea <= 6000 && (!industrial || hangar)) {
      let yC = 0
      for (const p of local[0]) yC += p.y
      yC /= local[0].length
      const xz: number[] = []
      for (const p of local[0]) xz.push(p.x, p.z)
      const box = orientedBox(xz)
      const pitch = outerArea > 600 ? PITCH_WIDE : PITCH_HOUSE
      if (local.length === 1 && outerArea / box.area >= 0.85) {
        // planta casi rectangular: tejado limpio sobre el rectángulo
        const aspect = Math.max(box.hu, box.hv) / Math.max(0.1, Math.min(box.hu, box.hv))
        const kind: RectKind = hangar ? 'barrel' : aspect >= 1.6 ? (seed > 0.3 ? 'gable' : 'hip') : seed > 0.7 ? 'gable' : 'hip'
        const maxRise = hangar ? Math.min(5, 0.4 * Math.min(box.hu, box.hv)) : ROOF_CAP + 0.5
        const rr = rectRoof(box, kind, pitch, maxRise, hangar ? 0.15 : 0.3)
        emitTris(b, rr.roof, yC, yt, roof)
        for (let k = 0, j = 0; k < rr.ends.length; k += 9, j += 2) {
          const e = rr.ends
          b.face(
            e[k], yC + yt + e[k + 2], e[k + 1],
            e[k + 3], yC + yt + e[k + 5], e[k + 4],
            e[k + 6], yC + yt + e[k + 8], e[k + 7],
            rr.endNormals[j], 0, rr.endNormals[j + 1], wall, 0, false, top - gMin,
          )
        }
        rise = rr.rise
      } else if (!hangar && local.length <= 8) {
        // planta irregular: faldones desde cada fachada (worker); si no se puede, plano
        deferred.push({
          job: { rings: local.map((r) => Float64Array.from(r.flatMap((p) => [p.x, p.z]))), pitch, cap: ROOF_CAP },
          emit: (tris) => (tris ? emitTris(b, tris, yC, yt, roof) : flatRoof()),
        })
        rise = Math.min(ROOF_CAP, Math.sqrt(outerArea) * 0.3 * pitch)
      } else flatRoof()
    } else flatRoof()

    // para chocar, el tejado cuenta hasta media altura (por encima del alero, lejos de la cumbrera)
    prisms.push(makePrism(local[0], base, yt + rise * 0.5))
    return true
  }

  /**
   * Suelo y color de una torre de puente: el suelo más bajo de la huella (el mismo para todas sus
   * piezas) y el color del puente si `bridges.bin` lo trae (Wikidata: el 25 de Abril, rojo), si
   * no el de OSM, y si tampoco, acero (colgantes) u hormigón (atirantados) como en bridgeShapes.ts.
   */
  private async towerLook(ring: Array<[number, number]>, toGeo: (px: number, py: number) => [number, number], osmColour: string | null): Promise<TowerLook | null> {
    let ground = Infinity
    for (const [px, py] of ring) {
      const h = this.heights.sample(...toGeo(px, py))
      if (h !== null) ground = Math.min(ground, h)
    }
    const [cx, cy] = ringCentroidArea(ring)
    const [lat, lon] = toGeo(cx, cy)
    const hc = this.heights.sample(lat, lon)
    if (hc !== null) ground = Math.min(ground, hc)
    if (!isFinite(ground)) return null
    // el registro de Wikidata suele estar en el centro del puente (Akashi: torres a 1 km)
    const cos = Math.max(0.2, Math.cos((lat * Math.PI) / 180))
    let rec: BridgeRecord | null = null
    let best = 3000
    for (const r of await bridgeRecordsIn(lat - 0.027, lon - 0.027 / cos, lat + 0.027, lon + 0.027 / cos)) {
      if (r.type !== BRIDGE_SUSPENSION && r.type !== BRIDGE_CABLE_STAYED && r.type !== BRIDGE_EXTRADOSED) continue
      const d = Math.hypot(r.lat - lat, (r.lon - lon) * cos) * 111320
      if (d < best) {
        best = d
        rec = r
      }
    }
    const colour = new Color()
    const osm = parseOsmColour(osmColour)
    if (rec?.colour) colour.set(rec.colour)
    else if (osm) colour.setRGB(osm[0], osm[1], osm[2], SRGBColorSpace)
    else colour.set(rec && rec.type !== BRIDGE_SUSPENSION ? TOWER_CONCRETE : TOWER_STEEL)
    return { ground, colour }
  }

  /** Torre de puente atravesada por los tableros: patas a sus lados y travesaños en lo alto (towerPieces). */
  private addBridgeTower(
    b: GeometryBuilder,
    frame: GeoFrame,
    prisms: Prism[],
    deferred: DeferredRoof[],
    ring: Array<[number, number]>,
    cut: TowerCut,
    toGeo: (px: number, py: number) => [number, number],
    height: number,
    minHeight: number,
    look: TowerLook,
    E: number,
    ox: number,
    oy: number,
    mPerPx: number,
  ): boolean {
    let any = false
    for (const p of towerPieces(ring, cut, height, minHeight, mPerPx)) {
      const rings = [{ pts: p.pts, cut: p.pts.map(() => false) }]
      if (this.addBuilding(b, frame, prisms, deferred, rings, toGeo, p.top, p.bottom, null, null, E, false, ox, oy, null, look)) any = true
    }
    return any
  }
}

// ---------------------------------------------------------------------------
// Tejados mapeados en OpenStreetMap (osmRoofs.ts)

interface OsmRoofPlan {
  kind: 'flat' | 'rect' | 'skeleton' | 'radial' | 'skillion'
  /** altura (absoluta, como `top`) donde acaban las paredes y empieza el tejado */
  wallTop: number
  /** subida del tejado sobre las paredes (m) */
  rise: number
  osm: OsmRoof
  /** huella exterior (x, z alternados) */
  xz: number[]
  box: OrientedBox
  /** altura local media de la huella (curvatura) */
  yC: number
}

const TAN30 = Math.tan((30 * Math.PI) / 180)
const TAN12 = Math.tan((12 * Math.PI) / 180)

/**
 * Cómo dibujar el tejado de OSM sobre esta huella. Con `height` explícita la altura de la tesela
 * es la de la cima: las paredes acaban `rise` más abajo. Sin ella (solo plantas), el tejado va
 * encima. Si la forma no cabe en la planta (huecos, planta que no es en estrella…), plano.
 */
function planOsmRoof(osm: OsmRoof, local: Vector3[][], top: number, base: number): OsmRoofPlan {
  const xz: number[] = []
  let yC = 0
  for (const p of local[0]) {
    xz.push(p.x, p.z)
    yC += p.y
  }
  yC /= local[0].length
  const box = orientedBox(xz)
  const area = Math.abs(ringArea(local[0]))
  const holes = local.length > 1
  const flat: OsmRoofPlan = { kind: 'flat', wallTop: top, rise: 0, osm, xz, box, yC }
  let kind: OsmRoofPlan['kind'] = 'flat'
  switch (osm.shape) {
    case ROOF_FLAT:
      return flat
    case ROOF_GABLED:
    case ROOF_HIPPED:
    case ROOF_ROUND:
      kind = !holes && area / box.area >= 0.8 ? 'rect' : local.length <= 8 ? 'skeleton' : 'flat'
      break
    case ROOF_SKILLION:
      kind = holes ? 'flat' : 'skillion'
      break
    default: {
      // chapitel, cono, cúpula, bulbo: de revolución hacia el centro de la planta
      const [cx, cz] = ringCentroid(xz)
      if (!holes && starShaped(xz, cx, cz)) kind = 'radial'
      else if (osm.shape === ROOF_PYRAMIDAL || osm.shape === ROOF_CONE) kind = local.length <= 8 ? 'skeleton' : 'flat'
    }
  }
  if (kind === 'flat') return flat
  // semiancho de la planta y radio del círculo de la misma área
  const half = Math.min(box.hu, box.hv)
  const rEq = Math.sqrt(area / Math.PI)
  const radial = kind === 'radial'
  let rise = osm.roofH ?? 0
  if (!osm.roofH) {
    if (osm.angle) {
      const run = osm.shape === ROOF_SKILLION ? 2 * half : radial ? rEq : half
      rise = Math.tan((Math.min(osm.angle, 80) * Math.PI) / 180) * run
    } else if (osm.shape === ROOF_DOME) rise = rEq
    else if (osm.shape === ROOF_ONION || osm.shape === ROOF_CONE) rise = 1.5 * rEq
    else if (osm.shape === ROOF_PYRAMIDAL) rise = 0.7 * (radial ? rEq : half)
    else if (osm.shape === ROOF_ROUND) rise = 0.5 * half
    else if (osm.shape === ROOF_SKILLION) rise = Math.min(2 * half * TAN30 * 0.5, 1 + 2 * half * TAN12 * 0.5)
    // dos y cuatro aguas: 30° en las casas, más tendido en las plantas anchas
    else rise = Math.min(half * TAN30, 1.5 + half * TAN12)
  }
  let wallTop = top
  if (osm.height !== null) {
    wallTop = top - rise
    if (wallTop < base) {
      wallTop = base
      rise = top - base
    }
  }
  if (rise < 0.3) return flat
  return { kind, wallTop, rise, osm, xz, box, yC }
}

/** Dibuja el tejado planeado; devuelve lo que sube (0 si se quedó plano). */
function drawOsmRoof(
  b: GeometryBuilder,
  local: Vector3[][],
  plan: OsmRoofPlan,
  yt: number,
  roofCol: Color,
  wallCol: Color,
  fv: number,
  deferred: DeferredRoof[],
  flatRoof: () => void,
): number {
  const { osm, xz, box, yC, rise } = plan
  switch (plan.kind) {
    case 'flat':
      flatRoof()
      return 0
    case 'rect': {
      const kind: RectKind = osm.shape === ROOF_HIPPED ? 'hip' : osm.shape === ROOF_ROUND ? 'barrel' : 'gable'
      const overhang = 0.2
      const W = ((box.hu >= box.hv) !== osm.across ? box.hv : box.hu) + overhang
      const rr = rectRoof(box, kind, rise / W, rise, overhang, osm.across)
      emitTris(b, rr.roof, yC, yt, roofCol)
      for (let k = 0, j = 0; k < rr.ends.length; k += 9, j += 2) {
        const e = rr.ends
        b.face(
          e[k], yC + yt + e[k + 2], e[k + 1],
          e[k + 3], yC + yt + e[k + 5], e[k + 4],
          e[k + 6], yC + yt + e[k + 8], e[k + 7],
          rr.endNormals[j], 0, rr.endNormals[j + 1], wallCol, 0, false, fv,
        )
      }
      return rr.rise
    }
    case 'skeleton': {
      // faldones desde cada fachada con la pendiente que da esa subida (worker)
      const half = Math.max(0.5, Math.min(box.hu, box.hv))
      deferred.push({
        job: { rings: local.map((r) => Float64Array.from(r.flatMap((p) => [p.x, p.z]))), pitch: rise / half, cap: rise },
        emit: (tris) => (tris ? emitTris(b, tris, yC, yt, roofCol) : flatRoof()),
      })
      return rise
    }
    case 'radial': {
      const [cx, cz] = ringCentroid(xz)
      const profile = osm.shape === ROOF_DOME ? PROFILE_DOME : osm.shape === ROOF_ONION ? PROFILE_ONION : PROFILE_SPIRE
      b.mesh(radialRoof(xz, cx, cz, rise, profile, osm.shape !== ROOF_PYRAMIDAL), yC + yt, roofCol)
      return rise
    }
    case 'skillion': {
      // hacia dónde cae el agua: roof:direction o, sin ella, a lo ancho
      let dx: number
      let dz: number
      if (osm.dir !== null) {
        const a = (osm.dir * Math.PI) / 180
        dx = Math.sin(a) // x = este
        dz = -Math.cos(a) // z = sur
      } else if (box.hu < box.hv) {
        dx = Math.cos(box.angle)
        dz = Math.sin(box.angle)
      } else {
        dx = -Math.sin(box.angle)
        dz = Math.cos(box.angle)
      }
      const hs = skillionHeights(xz, dx, dz, rise)
      const pts = local[0]
      for (const [i0, i1, i2] of ShapeUtils.triangulateShape(pts.map((p) => new Vector2(p.x, p.z)), [])) {
        const p0 = pts[i0]
        const p1 = pts[i1]
        const p2 = pts[i2]
        b.face(p0.x, p0.y + yt + hs[i0], p0.z, p1.x, p1.y + yt + hs[i1], p1.z, p2.x, p2.y + yt + hs[i2], p2.z, 0, 1, 0, roofCol, -1, true)
      }
      // paredes de las fachadas hasta el faldón
      const sign = ringArea(pts) > 0 ? 1 : -1
      for (let k = 0; k < pts.length; k++) {
        const k1 = (k + 1) % pts.length
        if (hs[k] < 0.01 && hs[k1] < 0.01) continue
        const a = pts[k]
        const c = pts[k1]
        const len = Math.hypot(c.x - a.x, c.z - a.z)
        if (len < 0.05) continue
        const nx = (sign * (c.z - a.z)) / len
        const nz = (-sign * (c.x - a.x)) / len
        b.face(a.x, a.y + yt, a.z, c.x, c.y + yt, c.z, c.x, c.y + yt + hs[k1], c.z, nx, 0, nz, wallCol, 0, false, fv)
        b.face(a.x, a.y + yt, a.z, c.x, c.y + yt + hs[k1], c.z, a.x, a.y + yt + hs[k], a.z, nx, 0, nz, wallCol, 0, false, fv)
      }
      return rise
    }
  }
}

/** Triángulos [x, z, h] (h sobre el alero) como caras de tejado. */
function emitTris(b: GeometryBuilder, tris: ArrayLike<number>, yC: number, top: number, col: Color): void {
  for (let k = 0; k + 8 < tris.length; k += 9) {
    b.face(tris[k], yC + top + tris[k + 2], tris[k + 1], tris[k + 3], yC + top + tris[k + 5], tris[k + 4], tris[k + 6], yC + top + tris[k + 8], tris[k + 7], 0, 1, 0, col, -1, true)
  }
}

/** Anillos (coordenadas de la tesela vectorial, 0..E) de la parte `p` de un registro del Catastro. */
function catastroRings(rec: CatTile, p: number, E: number): Array<{ pts: Array<[number, number]>; cut: boolean[] }> {
  const out: Array<{ pts: Array<[number, number]>; cut: boolean[] }> = []
  for (let r = rec.partRing[p]; r < rec.partRing[p + 1]; r++) {
    const pts: Array<[number, number]> = []
    for (let i = rec.ringStart[r]; i < rec.ringStart[r + 1]; i++) pts.push([rec.coords[2 * i] * E, rec.coords[2 * i + 1] * E])
    if (pts.length >= 3) out.push({ pts, cut: pts.map(() => false) })
  }
  return out
}

/** Descarta partes del Catastro de más de 12:1 y más de 2000 m² (una fila de adosados ronda 10:1 y 1500 m²). */
function looksLikeBuilding(pts: Array<[number, number]>, mPerPx: number): boolean {
  const xz: number[] = []
  for (const [x, y] of pts) xz.push(x * mPerPx, y * mPerPx)
  const box = orientedBox(xz)
  const long = Math.max(box.hu, box.hv)
  const short = Math.max(0.01, Math.min(box.hu, box.hv))
  return !(long / short > 12 && box.area > 2000)
}

/** Centroide de área y área (sin signo) de un anillo de la tesela vectorial. */
function ringCentroidArea(pts: Array<[number, number]>): [number, number, number] {
  let a = 0
  let cx = 0
  let cy = 0
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i]
    const [x1, y1] = pts[(i + 1) % pts.length]
    const c = x0 * y1 - x1 * y0
    a += c
    cx += (x0 + x1) * c
    cy += (y0 + y1) * c
  }
  if (Math.abs(a) < 1e-9) return [...ringCentre(pts), 0]
  return [cx / (3 * a), cy / (3 * a), Math.abs(a / 2)]
}

function ringCentre(pts: Array<[number, number]>): [number, number] {
  let x = 0
  let y = 0
  for (const [px, py] of pts) {
    x += px
    y += py
  }
  return [x / pts.length, y / pts.length]
}

/** Rejilla de anillos (coordenadas de tesela) para saber deprisa si un punto cae dentro de alguno. */
class RingGrid {
  private readonly cells = new Map<number, Array<Array<[number, number]>>>()
  private readonly k: number
  constructor(E: number) {
    this.k = 32 / E
  }
  add(ring: Array<[number, number]>): void {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const [x, y] of ring) {
      x0 = Math.min(x0, x)
      x1 = Math.max(x1, x)
      y0 = Math.min(y0, y)
      y1 = Math.max(y1, y)
    }
    for (let cy = Math.floor(y0 * this.k); cy <= Math.floor(y1 * this.k); cy++) {
      for (let cx = Math.floor(x0 * this.k); cx <= Math.floor(x1 * this.k); cx++) {
        const key = cy * 4096 + cx
        let list = this.cells.get(key)
        if (!list) this.cells.set(key, (list = []))
        list.push(ring)
      }
    }
  }
  contains(x: number, y: number): boolean {
    const list = this.cells.get(Math.floor(y * this.k) * 4096 + Math.floor(x * this.k))
    if (!list) return false
    for (const r of list) {
      let inside = false
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        if (r[i][1] > y !== r[j][1] > y && x < ((r[j][0] - r[i][0]) * (y - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) inside = !inside
      }
      if (inside) return true
    }
    return false
  }
}

// ---------------------------------------------------------------------------
// Geometría
// ---------------------------------------------------------------------------

/**
 * Geometría indexada y compacta (≈ 30 bytes por vértice): una ciudad densa son
 * cientos de miles de vértices por tesela y la subida a la GPU es lo que más cuesta.
 */
class GeometryBuilder {
  private cap = 8192
  private n = 0
  private pos = new Float32Array(this.cap * 3)
  private nor = new Int8Array(this.cap * 3)
  private col = new Uint8Array(this.cap * 3)
  private fac = new Float32Array(this.cap * 3)
  private idx = new Uint32Array(this.cap * 2)
  private ni = 0

  private reserve(nv: number, nidx: number): void {
    if (this.n + nv > this.cap) {
      let c = this.cap
      while (this.n + nv > c) c *= 2
      this.pos = growTo(this.pos, c * 3)
      this.nor = growTo(this.nor, c * 3)
      this.col = growTo(this.col, c * 3)
      this.fac = growTo(this.fac, c * 3)
      this.cap = c
    }
    if (this.ni + nidx > this.idx.length) {
      let c = this.idx.length
      while (this.ni + nidx > c) c *= 2
      this.idx = growTo(this.idx, c)
    }
  }

  private v(x: number, y: number, z: number, nx: number, ny: number, nz: number, c: Color, fu: number, fv: number, fs: number): number {
    const i = this.n++
    const o = 3 * i
    this.pos[o] = x
    this.pos[o + 1] = y
    this.pos[o + 2] = z
    this.nor[o] = Math.round(nx * 127)
    this.nor[o + 1] = Math.round(ny * 127)
    this.nor[o + 2] = Math.round(nz * 127)
    this.col[o] = Math.min(255, Math.round(c.r * 255))
    this.col[o + 1] = Math.min(255, Math.round(c.g * 255))
    this.col[o + 2] = Math.min(255, Math.round(c.b * 255))
    this.fac[o] = fu
    this.fac[o + 1] = fv
    this.fac[o + 2] = fs
    return i
  }

  private tri(a: number, b: number, c: number): void {
    this.idx[this.ni++] = a
    this.idx[this.ni++] = b
    this.idx[this.ni++] = c
  }

  wall(a: Vector3, c: Vector3, yb: number, yt: number, nx: number, nz: number, u0: number, u1: number, v0: number, v1: number, floorH: number, col: Color): void {
    // cuatro vértices y dos triángulos; el orden se elige para que la cara mire hacia fuera
    this.reserve(4, 6)
    const ex = c.x - a.x
    const ez = c.z - a.z
    // la cara (A, B, C) tiene normal ∝ (−ez, 0, ex): si apunta hacia fuera, ese orden
    const facing = -ez * nx + ex * nz
    // fs = altura de planta (< 16) + 16 × la coronación de la pared en medios metros: el shader
    // la necesita para los churretones que bajan de la cornisa (render/weathering.ts)
    const fs = floorH + 16 * Math.max(0, Math.round(2 * v1))
    const A = this.v(a.x, a.y + yb, a.z, nx, 0, nz, col, u0, v0, fs)
    const B = this.v(c.x, c.y + yb, c.z, nx, 0, nz, col, u1, v0, fs)
    const C = this.v(c.x, c.y + yt, c.z, nx, 0, nz, col, u1, v1, fs)
    const D = this.v(a.x, a.y + yt, a.z, nx, 0, nz, col, u0, v1, fs)
    if (facing > 0) {
      this.tri(A, B, C)
      this.tri(A, C, D)
    } else {
      this.tri(A, C, B)
      this.tri(A, D, C)
    }
  }

  /**
   * Triángulo suelto con la normal de su cara (aristas marcadas en los tejados inclinados).
   * up = que mire hacia arriba; si no, hacia (nx, ny, nz). fs/fv como en las paredes
   * (fs = −1: sin ventanas ni oscurecimiento al pie).
   */
  face(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, nx: number, ny: number, nz: number, col: Color, fs: number, up: boolean, fv = 0): void {
    const e1x = bx - ax
    const e1y = by - ay
    const e1z = bz - az
    const e2x = cx - ax
    const e2y = cy - ay
    const e2z = cz - az
    let qx = e1y * e2z - e1z * e2y
    let qy = e1z * e2x - e1x * e2z
    let qz = e1x * e2y - e1y * e2x
    const l = Math.hypot(qx, qy, qz)
    if (l < 1e-9) return
    qx /= l
    qy /= l
    qz /= l
    const flip = up ? qy < 0 : qx * nx + qy * ny + qz * nz < 0
    if (flip) {
      qx = -qx
      qy = -qy
      qz = -qz
    }
    this.reserve(3, 3)
    const A = this.v(ax, ay, az, qx, qy, qz, col, 0, fv, fs)
    const B = this.v(bx, by, bz, qx, qy, qz, col, 0, fv, fs)
    const C = this.v(cx, cy, cz, qx, qy, qz, col, 0, fv, fs)
    if (flip) this.tri(A, C, B)
    else this.tri(A, B, C)
  }

  /** Malla con normales propias (cúpulas, conos): vértices [x, z, h] a la altura y0 + h. */
  mesh(m: SmoothMesh, y0: number, col: Color): void {
    const nv = m.pos.length / 3
    this.reserve(nv, m.idx.length)
    const base = this.n
    for (let i = 0; i < nv; i++) this.v(m.pos[3 * i], y0 + m.pos[3 * i + 2], m.pos[3 * i + 1], m.nor[3 * i], m.nor[3 * i + 1], m.nor[3 * i + 2], col, 0, 0, -1)
    for (const k of m.idx) this.idx[this.ni++] = base + k
  }

  /** Tejado plano: los puntos de la huella (exterior + huecos) y la triangulación. */
  roof(pts: Vector3[], tris: number[][], top: number, col: Color): void {
    this.reserve(pts.length, tris.length * 3)
    const base = this.n
    for (const p of pts) this.v(p.x, p.y + top, p.z, 0, 1, 0, col, 0, 0, -1)
    for (const [i0, i1, i2] of tris) {
      const p0 = pts[i0]
      const p1 = pts[i1]
      const p2 = pts[i2]
      // componente Y de (p1−p0)×(p2−p0): positiva = cara hacia arriba
      const ny = (p1.z - p0.z) * (p2.x - p0.x) - (p1.x - p0.x) * (p2.z - p0.z)
      if (ny >= 0) this.tri(base + i0, base + i1, base + i2)
      else this.tri(base + i0, base + i2, base + i1)
    }
  }

  build(): BufferGeometry {
    const g = new BufferGeometry()
    const n3 = this.n * 3
    g.setAttribute('position', new BufferAttribute(this.pos.slice(0, n3), 3))
    g.setAttribute('normal', new BufferAttribute(this.nor.slice(0, n3), 3, true))
    g.setAttribute('color', new BufferAttribute(this.col.slice(0, n3), 3, true))
    g.setAttribute('fac', new BufferAttribute(this.fac.slice(0, n3), 3))
    g.setIndex(new BufferAttribute(this.idx.slice(0, this.ni), 1))
    if (n3 === 0) {
      g.computeBoundingSphere()
      g.computeBoundingBox()
      return g
    }
    // Envolventes: las mismas cuentas que computeBoundingBox y computeBoundingSphere de three.js
    // (caja, su centro y la distancia al vértice más lejano), en dos pasadas sobre la tabla en vez
    // de sus tres con un vector por vértice: en una tesela de ciudad, con cientos de miles de
    // vértices, eran ~10 ms seguidos sin soltar el hilo.
    const p = this.pos
    let x0 = Infinity
    let y0 = Infinity
    let z0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    let z1 = -Infinity
    for (let o = 0; o < n3; o += 3) {
      x0 = Math.min(x0, p[o])
      y0 = Math.min(y0, p[o + 1])
      z0 = Math.min(z0, p[o + 2])
      x1 = Math.max(x1, p[o])
      y1 = Math.max(y1, p[o + 1])
      z1 = Math.max(z1, p[o + 2])
    }
    const box = new Box3(new Vector3(x0, y0, z0), new Vector3(x1, y1, z1))
    const centre = box.getCenter(new Vector3())
    let maxSq = 0
    for (let o = 0; o < n3; o += 3) {
      const dx = centre.x - p[o]
      const dy = centre.y - p[o + 1]
      const dz = centre.z - p[o + 2]
      maxSq = Math.max(maxSq, dx * dx + dy * dy + dz * dz)
    }
    g.boundingBox = box
    g.boundingSphere = new Sphere(centre, Math.sqrt(maxSq))
    return g
  }
}

function growTo<T extends Float32Array | Int8Array | Uint8Array | Uint32Array>(a: T, size: number): T {
  const b = new (a.constructor as new (n: number) => T)(size)
  b.set(a)
  return b
}

function createBuildingMaterial(): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 })
  m.onBeforeCompile = (shader) => {
    // ventanas encendidas de noche (render/nightLights.ts)
    Object.assign(shader.uniforms, nightUniforms, lampGridUniforms, weatherUniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 fac;\nvarying vec3 vFac;\nvarying float vFacTop;\nvarying vec3 vWinSeed;\nvarying vec3 vSlWorld;\nvarying vec3 vSlNormal;')
      // fac.z = altura de planta + 16 × coronación de la pared en medios metros (−1: tejado)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nfloat facTop = floor(max(fac.z, 0.0) / 16.0);\nvFac = vec3(fac.xy, fac.z - 16.0 * facTop);\nvFacTop = 0.5 * facTop;\nvWinSeed = position;\nvSlWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvSlNormal = mat3(modelMatrix) * objectNormal;')
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        varying vec3 vFac;
        varying float vFacTop;
        varying vec3 vWinSeed;
        varying vec3 vSlWorld;
        varying vec3 vSlNormal;
        ${streetLampGLSL}
        ${WX_COMMON_GLSL}
        ${WX_BUILDING_GLSL}
        uniform float nlOn;
        uniform float nlLit;
        uniform float nlGain;
        float bHash(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }`,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        // desgaste (render/weathering.ts): manchas y churretones en las fachadas, cubiertas con vida
        if (wxAmount > 0.0) {
          if (vFac.z > -0.5) wxWall(diffuseColor.rgb, vWinSeed, vFac.xy, vFacTop, vFac.z);
          else wxRoof(diffuseColor.rgb, vWinSeed);
        }
        float winMask = 0.0;
        vec3 winEmit = vec3(0.0);
        if (vFac.z > 0.5) {
          // ventanas: una cada 3,4 m en horizontal y una por planta
          vec2 g = vec2(vFac.x / 3.4, vFac.y / vFac.z);
          vec2 cell = fract(g);
          vec2 id = floor(g);
          vec2 fw = fwidth(g);
          float wx = smoothstep(0.28 - fw.x, 0.28 + fw.x, cell.x) - smoothstep(0.72 - fw.x, 0.72 + fw.x, cell.x);
          float wy = smoothstep(0.30 - fw.y, 0.30 + fw.y, cell.y) - smoothstep(0.80 - fw.y, 0.80 + fw.y, cell.y);
          float w = wx * wy * step(0.0, id.y);
          float w0 = w;
          // lejos (patrón menor que un píxel): tono medio
          float far = smoothstep(0.18, 0.5, max(fw.x, fw.y));
          w = mix(w, 0.22, far);
          float r = bHash(id + 0.5);
          // cristal oscuro, o persiana a medio bajar (muy habitual en España)
          vec3 glass = vec3(0.025, 0.03, 0.035) * (0.6 + 0.8 * r);
          vec3 blind = diffuseColor.rgb * vec3(0.78, 0.72, 0.62);
          vec3 winCol = mix(glass, blind, step(0.62, r) * (1.0 - far));
          // de cerca: alféizar claro bajo el hueco, el churretón de sus esquinas y el dintel,
          // que deja en sombra la parte alta del hueco
          float wxNear = (1.0 - far) * wxAmount * step(0.0, id.y);
          float sill = wx * (smoothstep(0.25 - fw.y, 0.25 + fw.y, cell.y) - smoothstep(0.30 - fw.y, 0.30 + fw.y, cell.y));
          vec2 sx = (cell.xx - vec2(0.29, 0.71)) / 0.035;
          float stain = (exp(-sx.x * sx.x) + exp(-sx.y * sx.y)) * smoothstep(0.0, 0.25, cell.y) * step(cell.y, 0.26) * step(0.35, bHash(id + 4.7));
          diffuseColor.rgb *= 1.0 + wxNear * (0.22 * sill - 0.22 * stain);
          winCol *= 1.0 - 0.5 * wxNear * smoothstep(0.64, 0.80, cell.y);
          diffuseColor.rgb = mix(diffuseColor.rgb, winCol, w * 0.9);
          winMask = w * (1.0 - step(0.62, r));
          if (nlOn > 0.0) {
            // de noche: una parte de las ventanas encendidas (la semilla, por ventana y por zona
            // de 60 m del edificio, para que no se repita el mismo dibujo en todas las fachadas)
            vec2 zone = floor(vWinSeed.xz / 60.0);
            float seed = bHash(id + zone * 17.31 + 0.37);
            // cuántas encendidas cambia de unos bloques a otros (oficinas a oscuras, casas con
            // gente): ruido suave de unos 80 m, sin saltos en las fachadas largas
            vec2 nq = vWinSeed.xz / 80.0;
            vec2 ni = floor(nq);
            vec2 nf = fract(nq);
            nf = nf * nf * (3.0 - 2.0 * nf);
            float zv = mix(mix(bHash(ni + 7.1), bHash(ni + vec2(8.1, 7.1)), nf.x), mix(bHash(ni + vec2(7.1, 8.1)), bHash(ni + 8.1), nf.x), nf.y);
            float litP = clamp(nlLit * (0.15 + 1.9 * zv * zv), 0.0, 0.85);
            float lit = step(seed, litP);
            // cálida casi siempre, alguna blanca y alguna azulada (la tele)
            float tone = bHash(id * 1.7 + zone * 5.13 + 3.1);
            vec3 lc = tone < 0.72 ? vec3(1.0, 0.7, 0.4) : tone < 0.92 ? vec3(0.95, 0.88, 0.76) : vec3(0.5, 0.62, 1.0);
            // tras la persiana, luz tamizada
            float through = step(0.62, r) > 0.5 ? 0.4 : 1.0;
            float k = 0.5 + 0.5 * bHash(id + zone + 9.3);
            vec3 nearE = w0 * lit * through * k * lc;
            // lejos, cuando la ventana ya no ocupa ni un par de píxeles: la media del patrón
            // (superficie de ventana por fracción encendida), algo rebajada, que de lejos el ojo
            // ve puntos sueltos y no una pared que brilla
            float farL = smoothstep(0.45, 1.0, max(fw.x, fw.y));
            vec3 farE = vec3(0.22 * litP * 0.75 * 0.77 * 0.55) * vec3(1.0, 0.72, 0.45);
            winEmit = mix(nearE, farE, farL) * 0.85 * nlGain * nlOn;
          }
        }
        if (vFac.z > -0.5) {
          // oscurecimiento al pie de la pared (oclusión con el suelo)
          diffuseColor.rgb *= mix(0.55, 1.0, smoothstep(-0.5, 3.0, vFac.y));
        }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.18, winMask);',
      )
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += winEmit;\n// la luz de las farolas en las fachadas (la misma rejilla que alumbra el suelo)\nif (slOn > 0.0) totalEmissiveRadiance += diffuseColor.rgb * streetLampLight(vSlWorld, normalize(vSlNormal)) * 0.3183099;')
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n\tgl_FragColor.a = 0.0;')
  }
  m.customProgramCacheKey = () => 'osm-buildings-v4'
  return m
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

class RoofColours {
  private readonly px: Uint8ClampedArray
  readonly size: number
  constructor(px: Uint8ClampedArray, size: number) {
    this.px = px
    this.size = size
  }
  /** media de 3×3 píxeles (≈ 5 m) alrededor de (x, y), en 0..1 sRGB */
  at(x: number, y: number): [number, number, number] | null {
    const s = this.size
    const cx = Math.round(x)
    const cy = Math.round(y)
    let r = 0
    let g = 0
    let b = 0
    let k = 0
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const xx = cx + i
        const yy = cy + j
        if (xx < 0 || yy < 0 || xx >= s || yy >= s) continue
        const o = 4 * (yy * s + xx)
        if (this.px[o + 3] === 0) continue // sin imagen
        r += this.px[o]
        g += this.px[o + 1]
        b += this.px[o + 2]
        k++
      }
    }
    if (k === 0 || r + g + b === 0) return null
    return [r / k / 255, g / k / 255, b / k / 255]
  }
}

/**
 * Color del tejado en la ortofoto (sRGB 0..1): el centro y, desde cada vértice, un cuarto del
 * camino hacia él, solo los puntos dentro de la huella, y de ellos la mitad más clara. Con una
 * sola muestra en el centro, los edificios con patio tomaban el del patio y los tejados a la
 * sombra de un vecino alto, el de la sombra: casi negros, y aclarados quedaban azul marino.
 */
function roofFromOrtho(colours: RoofColours, rings: Array<{ pts: Array<[number, number]> }>, cx: number, cy: number, E: number): [number, number, number] | null {
  const k = colours.size / E
  const samples: Array<[number, number, number]> = []
  const tryAt = (x: number, y: number) => {
    if (!inRings(rings, x, y)) return
    const c = colours.at(x * k, y * k)
    if (c) samples.push(c)
  }
  tryAt(cx, cy)
  const outer = rings[0].pts
  const step = Math.max(1, Math.floor(outer.length / 12))
  for (let i = 0; i < outer.length; i += step) tryAt(outer[i][0] + 0.25 * (cx - outer[i][0]), outer[i][1] + 0.25 * (cy - outer[i][1]))
  if (samples.length === 0) return colours.at(cx * k, cy * k)
  const lum = (c: [number, number, number]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  samples.sort((a, b) => lum(b) - lum(a))
  const n = Math.ceil(samples.length / 2)
  const out: [number, number, number] = [0, 0, 0]
  for (let i = 0; i < n; i++) for (let j = 0; j < 3; j++) out[j] += samples[i][j] / n
  return out
}

/** ¿(x, y) cae dentro de la huella (anillo exterior menos los patios)? Par-impar. */
function inRings(rings: Array<{ pts: Array<[number, number]> }>, x: number, y: number): boolean {
  let inside = false
  for (const { pts: r } of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      if (r[i][1] > y !== r[j][1] > y && x < ((r[j][0] - r[i][0]) * (y - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) inside = !inside
    }
  }
  return inside
}

const _grey = new Color()

const WALLS_LOW = ['#efece4', '#efece4', '#ebe3d2', '#e6dcc6', '#ddcfb4', '#d9c3a0', '#e2c39b', '#d9a98a', '#b9775a', '#cfccc4']
const WALLS_TALL = ['#e9e6de', '#ddd2bd', '#d3c3a6', '#c9b28e', '#b46c4f', '#a86448', '#bdbab3', '#cfcac0', '#9f5d43', '#e0d6c4']
const WALLS_INDUSTRIAL = ['#cfcdc6', '#c4c2bb', '#d8d2c2', '#b9bcbd', '#e3e0d8', '#c8bfae']

function pickWall(seed: number, height: number, industrial: boolean): string {
  const list = industrial ? WALLS_INDUSTRIAL : height > 12 ? WALLS_TALL : WALLS_LOW
  return list[Math.floor(seed * list.length) % list.length]
}

function hash2(x: number, y: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return s - Math.floor(s)
}

function ringArea(pts: Vector3[]): number {
  // área con signo en el plano (x, z)
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    const q = pts[(i + 1) % pts.length]
    a += p.x * q.z - q.x * p.z
  }
  return a / 2
}

function makePrism(ring: Vector3[], base: number, top: number): Prism {
  const arr = new Float32Array(ring.length * 2)
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  ring.forEach((p, i) => {
    arr[2 * i] = p.x
    arr[2 * i + 1] = p.z
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
    minZ = Math.min(minZ, p.z)
    maxZ = Math.max(maxZ, p.z)
  })
  // el anillo está a la cota 0 del marco de la tesela: la altura de cada punto es y + base/top
  const y0 = ring[0].y
  return { ring: arr, minX, maxX, minZ, maxZ, base: base + y0, top: top + y0 }
}

/** Índice de los prismas de una tesela para `heightAtGeo`: rejilla con los que tocan cada celda. */
const PRISM_GRID = 48
interface PrismIndex {
  x0: number
  z0: number
  cell: number
  cells: Prism[][]
}
const prismIndex = new WeakMap<Prism[], PrismIndex>()
function indexPrisms(prisms: Prism[]): PrismIndex {
  let x0 = Infinity
  let z0 = Infinity
  let x1 = -Infinity
  let z1 = -Infinity
  for (const b of prisms) {
    x0 = Math.min(x0, b.minX)
    z0 = Math.min(z0, b.minZ)
    x1 = Math.max(x1, b.maxX)
    z1 = Math.max(z1, b.maxZ)
  }
  const cell = Math.max(1, Math.max(x1 - x0, z1 - z0) / PRISM_GRID + 1e-3)
  const cells: Prism[][] = Array.from({ length: PRISM_GRID * PRISM_GRID }, () => [])
  const at = (v: number) => Math.min(PRISM_GRID - 1, Math.max(0, Math.floor(v / cell)))
  for (const b of prisms) {
    for (let j = at(b.minZ - z0); j <= at(b.maxZ - z0); j++) for (let i = at(b.minX - x0); i <= at(b.maxX - x0); i++) cells[j * PRISM_GRID + i].push(b)
  }
  return { x0, z0, cell, cells }
}

function pointInRing(r: Float32Array, x: number, z: number): boolean {
  let inside = false
  const n = r.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = r[2 * i]
    const zi = r[2 * i + 1]
    const xj = r[2 * j]
    const zj = r[2 * j + 1]
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
  }
  return inside
}

/**
 * Recorta un anillo al cuadrado [0, E]² (Sutherland–Hodgman) y marca los lados que
 * quedan sobre el borde de la tesela (ahí no se pone pared: el edificio sigue en la vecina).
 */
/** Margen de las teselas vectoriales de OpenFreeMap (unidades de tesela): ahí se cortan las huellas. */
const MVT_BUFFER = 64

type EdgeSide = 'left' | 'right' | 'top' | 'bottom'
const SIDE_OFFSET: Record<EdgeSide, [number, number]> = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] }

/**
 * Qué hace esta tesela con un edificio que cruza su borde: 'whole' = dibujarlo entero (cabe en
 * el margen y su centroide cae aquí), 'skip' = lo dibuja entero una vecina, 'clip' = dibujar
 * solo lo que cae dentro (como antes; para los que no caben en el margen de nadie). Un lado
 * ('left'…) = aquí solo asoma una franja de un edificio que sigue en esa vecina más allá de
 * nuestro margen: hay que preguntarle a ella si lo dibuja entero (neighbourDrawsWhole).
 * `raw` es la huella tal cual viene (con el margen), `clipped` la recortada a la tesela.
 */
function edgeOwner(raw: Array<[number, number]>, clipped: Array<[number, number]>, E: number): 'whole' | 'skip' | 'clip' | EdgeSide {
  const lo = -MVT_BUFFER
  const hi = E + MVT_BUFFER
  const box = (pts: Array<[number, number]>) => {
    let x0 = Infinity
    let x1 = -Infinity
    let y0 = Infinity
    let y1 = -Infinity
    for (const [x, y] of pts) {
      x0 = Math.min(x0, x)
      x1 = Math.max(x1, x)
      y0 = Math.min(y0, y)
      y1 = Math.max(y1, y)
    }
    return { x0, x1, y0, y1 }
  }
  const r = box(raw)
  const left = r.x0 <= lo
  const right = r.x1 >= hi
  const top = r.y0 <= lo
  const bottom = r.y1 >= hi
  if (!left && !right && !top && !bottom) {
    // se ve entero; solo los que cruzan un único borde (dos teselas): los de las esquinas,
    // recortados como siempre
    const spanX = Math.ceil(r.x1 / E) - Math.floor(r.x0 / E)
    const spanY = Math.ceil(r.y1 / E) - Math.floor(r.y0 / E)
    if (spanX * spanY !== 2) return 'clip'
    // lo dibuja la tesela de su centroide, si también le cabe en el margen
    const [cx, cy] = ringCentroidArea(raw)
    const ox = Math.floor(cx / E) * E
    const oy = Math.floor(cy / E) * E
    if (ox === 0 && oy === 0) return 'whole'
    return r.x0 - ox > lo && r.x1 - ox < hi && r.y0 - oy > lo && r.y1 - oy < hi ? 'skip' : 'clip'
  }
  // cortado por el margen por un solo lado y, dentro de la tesela, tocando solo ese borde: si aquí
  // solo asoma una franja (que la vecina ve en su margen), puede que la vecina lo vea entero; qué
  // hace ella no se sabe desde aquí (el edificio puede doblar una esquina fuera de nuestra vista)
  if (Number(left) + Number(right) + Number(top) + Number(bottom) !== 1) return 'clip'
  const c = box(clipped)
  const edges = Number(c.x0 <= 0) + Number(c.x1 >= E) + Number(c.y0 <= 0) + Number(c.y1 >= E)
  if (edges !== 1) return 'clip'
  const side: EdgeSide = left ? 'left' : right ? 'right' : top ? 'top' : 'bottom'
  const strip = left ? c.x1 < MVT_BUFFER : right ? c.x0 > E - MVT_BUFFER : top ? c.y1 < MVT_BUFFER : c.y0 > E - MVT_BUFFER
  return strip ? side : 'clip'
}

/** Puntos donde una huella recortada toca el borde de la tesela (a lo largo de él), ordenados. */
function edgeCrossings(clipped: Array<[number, number]>, side: EdgeSide, E: number): number[] {
  const axis = side === 'left' || side === 'right' ? 0 : 1
  const at = side === 'left' || side === 'top' ? 0 : E
  return clipped.filter((p) => p[axis] === at).map((p) => p[1 - axis]).sort((a, b) => a - b)
}

/**
 * Edificios de una tesela que cruzan uno de sus bordes: dónde lo cruzan y si esa tesela los
 * dibuja enteros. Se calcula una vez por tesela y borde, y lo comparten las teselas vecinas.
 */
const edgeIndex = new Map<string, Promise<Array<{ at: number[]; whole: boolean }>>>()

function tileEdgeIndex(x: number, y: number, side: EdgeSide): Promise<Array<{ at: number[]; whole: boolean }>> {
  const k = `${x}/${y}/${side}`
  let p = edgeIndex.get(k)
  if (!p) {
    p = fetchVectorTile(x, y, new AbortController().signal)
      .then((vt) => {
        const layer = vt.layers.building
        const out: Array<{ at: number[]; whole: boolean }> = []
        if (!layer) return out
        const E = layer.extent
        for (let i = 0; i < layer.length; i++) {
          const f = layer.feature(i)
          if (f.type !== 3 || f.properties.hide_3d) continue
          for (const polygon of classifyRings(f.loadGeometry())) {
            const raw = polygon[0].map((q) => [q.x, q.y] as [number, number])
            if (raw.length > 1 && raw[0][0] === raw[raw.length - 1][0] && raw[0][1] === raw[raw.length - 1][1]) raw.pop()
            const c = clipRing(raw, E)
            if (c.pts.length < 3) continue
            const at = edgeCrossings(c.pts, side, E)
            if (at.length >= 2) out.push({ at, whole: edgeOwner(raw, c.pts, E) === 'whole' })
          }
        }
        return out
      })
      .catch(() => {
        // (un corte de red: no se guarda, la próxima vez se vuelve a pedir)
        if (edgeIndex.get(k) === p) edgeIndex.delete(k)
        return []
      })
    edgeIndex.set(k, p)
    if (edgeIndex.size > 64) edgeIndex.delete(edgeIndex.keys().next().value!)
  }
  return p
}

/**
 * ¿La tesela vecina dibuja entero el edificio del que aquí solo asoma una franja? Se busca su
 * trozo por los puntos donde cruza el borde común y se decide con edgeOwner desde allí.
 */
async function neighbourDrawsWhole(tx: number, ty: number, side: EdgeSide, clipped: Array<[number, number]>, E: number): Promise<boolean> {
  const [dx, dy] = SIDE_OFFSET[side]
  const opposite: EdgeSide = side === 'left' ? 'right' : side === 'right' ? 'left' : side === 'top' ? 'bottom' : 'top'
  const ours = edgeCrossings(clipped, side, E)
  for (const theirs of await tileEdgeIndex(tx + dx, ty + dy, opposite)) {
    if (theirs.at.length === ours.length && theirs.at.every((v, j) => Math.abs(v - ours[j]) <= 3)) return theirs.whole
  }
  return false
}

function clipRing(pts: Array<[number, number]>, E: number): { pts: Array<[number, number]>; cut: boolean[] } {
  let out = pts
  const edges: Array<[number, number, boolean]> = [
    [0, 0, true], // x >= 0
    [0, E, false], // x <= E
    [1, 0, true], // y >= 0
    [1, E, false], // y <= E
  ]
  for (const [axis, lim, ge] of edges) {
    const inside = (p: [number, number]) => (ge ? p[axis] >= lim : p[axis] <= lim)
    const next: Array<[number, number]> = []
    for (let i = 0; i < out.length; i++) {
      const a = out[i]
      const b = out[(i + 1) % out.length]
      const ia = inside(a)
      const ib = inside(b)
      if (ia) next.push(a)
      if (ia !== ib) {
        const t = (lim - a[axis]) / (b[axis] - a[axis])
        const p: [number, number] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
        p[axis] = lim
        next.push(p)
      }
    }
    out = next
    if (out.length < 3) return { pts: [], cut: [] }
  }
  // sin puntos repetidos consecutivos (el triangulador los quitaría y descuadraría los índices)
  out = out.filter((p, i) => {
    const q = out[(i + 1) % out.length]
    return p[0] !== q[0] || p[1] !== q[1]
  })
  if (out.length < 3) return { pts: [], cut: [] }
  const cut = out.map((a, i) => {
    const b = out[(i + 1) % out.length]
    return (a[0] === b[0] && (a[0] <= 0 || a[0] >= E)) || (a[1] === b[1] && (a[1] <= 0 || a[1] >= E))
  })
  return { pts: out, cut }
}

/** Polígonos 'aerodrome' de la capa aeroway, en coordenadas de la tesela vectorial. */
function aerodromePolygons(vt: { layers: Record<string, any> }, E: number): Ring[][] {
  const layer = vt.layers.aeroway
  const out: Ring[][] = []
  if (!layer || layer.extent !== E) return out
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i)
    if (f.type === 3 && f.properties.class === 'aerodrome') out.push(...classifyRings(f.loadGeometry()))
  }
  return out
}

/** Puntos cada ~8 m a lo largo de cada puente (líneas brunnel=bridge) de la tesela, en sus unidades. */
function bridgeSamples(vt: { layers: Record<string, any> }, E: number, mPerPx: number): Array<Array<[number, number]>> {
  const layer = vt.layers.transportation
  const out: Array<Array<[number, number]>> = []
  if (!layer || layer.extent !== E) return out
  const step = 8 / mPerPx
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i)
    if (f.type !== 2 || f.properties.brunnel !== 'bridge') continue
    for (const line of f.loadGeometry() as Array<Array<{ x: number; y: number }>>) {
      const pts: Array<[number, number]> = []
      let carry = 0
      for (let k = 1; k < line.length; k++) {
        const dx = line[k].x - line[k - 1].x
        const dy = line[k].y - line[k - 1].y
        const len = Math.hypot(dx, dy)
        if (len === 0) continue
        let d = carry
        for (; d < len; d += step) pts.push([line[k - 1].x + (dx * d) / len, line[k - 1].y + (dy * d) / len])
        carry = d - len
      }
      if (pts.length >= 3) out.push(pts)
    }
  }
  return out
}

/** ¿La huella es en realidad un puente? (la recorre por dentro la mayor parte de uno, 24 m o más) */
function coversBridge(rings: Array<{ pts: Array<[number, number]> }>, lines: Array<Array<[number, number]>>): boolean {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const [x, y] of rings[0].pts) {
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  for (const line of lines) {
    let inside = 0
    for (const [x, y] of line) if (x >= minX && x <= maxX && y >= minY && y <= maxY && inRings(rings, x, y)) inside++
    if (inside >= 3 && inside >= 0.6 * line.length) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Torres de puente que OSM trae como edificio: se reconocen en bridgeTowers.ts (`towerCut`) y aquí
// se dibujan como patas a los lados de los tableros con travesaños en lo alto (`towerPieces`), sin
// ventanas y con el color del puente. La riostra bajo el tablero la pone bridgeShapes.ts, que sabe
// a qué altura va.

/** acero de los colgantes y hormigón de los pilonos (los de bridgeShapes.ts) */
const TOWER_STEEL = 0x848c93
const TOWER_CONCRETE = 0xc9c6bf
interface TowerLook {
  /** suelo de referencia de todas las piezas (m) */
  ground: number
  colour: Color
}

/**
 * Piezas de una torre atravesada por los tableros (anillos en unidades de la tesela y alturas sobre
 * el suelo): una pata por cada trozo de la huella fuera de las franjas de los tableros (si el de un
 * lado no llega al mínimo, una pata de ese mínimo pegada a la franja, aunque se salga de la huella)
 * y, sobre cada franja, un travesaño en lo alto y otro hacia los dos tercios en las torres de 90 m o
 * más. La huella se recorta por franjas a lo largo del eje; si el recorte no es limpio (el borde de
 * la franja corta el contorno más de dos veces), la pieza es la caja que lo envuelve.
 */
function towerPieces(ring: Array<[number, number]>, cut: TowerCut, height: number, minHeight: number, mPerPx: number): Array<{ pts: Array<[number, number]>; bottom: number; top: number }> {
  const { ux, uy, cx, cy, v0, v1, lanes } = cut
  // a coordenadas del puente: u a lo largo, v de lado
  const uv = ring.map(([x, y]) => [(x - cx) * ux + (y - cy) * uy, (y - cy) * ux - (x - cx) * uy] as [number, number])
  const back = (q: [number, number]): [number, number] => [cx + q[0] * ux - q[1] * uy, cy + q[0] * uy + q[1] * ux]
  const clipV = (poly: Array<[number, number]>, v: number, keepAbove: boolean): Array<[number, number]> => {
    const out: Array<[number, number]> = []
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]
      const q = poly[(i + 1) % poly.length]
      const sp = keepAbove ? p[1] - v : v - p[1]
      const sq = keepAbove ? q[1] - v : v - q[1]
      if (sp >= 0) out.push(p)
      if (sp >= 0 !== sq >= 0) {
        const t = sp / (sp - sq)
        out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t])
      }
    }
    return out
  }
  const crossings = (v: number) => {
    let n = 0
    for (let i = 0; i < uv.length; i++) if (uv[i][1] >= v !== uv[(i + 1) % uv.length][1] >= v) n++
    return n
  }
  const box = (u0: number, u1: number, a: number, b: number): Array<[number, number]> => [
    [u0, a],
    [u1, a],
    [u1, b],
    [u0, b],
  ]
  const uRange = (poly: Array<[number, number]>): [number, number] => {
    let u0 = Infinity
    let u1 = -Infinity
    for (const [u] of poly) {
      u0 = Math.min(u0, u)
      u1 = Math.max(u1, u)
    }
    return [u0, u1]
  }
  /** la huella entre v = a y v = b */
  const band = (a: number, b: number): Array<[number, number]> | null => {
    const poly = clipV(clipV(uv, a, true), b, false)
    if (poly.length < 3) return null
    if ((a > v0 && crossings(a) > 2) || (b < v1 && crossings(b) > 2)) {
      const [u0, u1] = uRange(poly)
      return u1 - u0 > 1e-6 ? box(u0, u1, a, b) : null
    }
    return poly
  }
  const span = height - minHeight
  const minLeg = Math.min(4, Math.max(1.5, 0.1 * (v1 - v0) * mPerPx)) / mPerPx
  /** canto de un travesaño */
  const strut = Math.min(9, Math.max(2.5, 0.045 * span))
  const out: Array<{ pts: Array<[number, number]>; bottom: number; top: number }> = []
  const piece = (poly: Array<[number, number]> | null, bottom: number, top: number) => {
    if (poly && poly.length >= 3) out.push({ pts: poly.map(back), bottom, top })
  }
  // patas de los lados: lo que queda de la huella o, si no llega, el mínimo pegado a la franja
  const first = lanes[0][0]
  const last = lanes[lanes.length - 1][1]
  const edge = 3 / mPerPx
  if (first - v0 >= minLeg) piece(band(v0 - 1, first), minHeight, height)
  else {
    const near = band(v0 - 1, Math.max(v0 + edge, first)) ?? uv
    const [u0, u1] = uRange(near)
    piece(box(u0, u1, first - minLeg, first), minHeight, height)
  }
  if (v1 - last >= minLeg) piece(band(last, v1 + 1), minHeight, height)
  else {
    const near = band(Math.min(v1 - edge, last), v1 + 1) ?? uv
    const [u0, u1] = uRange(near)
    piece(box(u0, u1, last, last + minLeg), minHeight, height)
  }
  // patas entre tableros (la pila central de Brooklyn, entre sus dos arcos)
  for (let k = 1; k < lanes.length; k++) piece(band(lanes[k - 1][1], lanes[k][0]), minHeight, height)
  // travesaños sobre cada franja (de pata a pata, aunque la franja se salga de la huella)
  for (const [a, b] of lanes) {
    const inner = a >= v0 && b <= v1 ? band(a, b) : null
    const poly = inner ?? box(...uRange(band(Math.max(a, v0), Math.min(b, v1)) ?? uv), a, b)
    piece(poly, height - strut, height)
    if (span >= 90) piece(poly, minHeight + 0.68 * span, minHeight + 0.68 * span + 0.8 * strut)
  }
  return out
}

/** ¿El centro del anillo cae dentro de alguno de los polígonos (con sus huecos)? */
function inAnyPolygon(polys: Ring[][], ring: Array<[number, number]>): boolean {
  let x = 0
  let y = 0
  for (const [px, py] of ring) {
    x += px
    y += py
  }
  x /= ring.length
  y /= ring.length
  for (const poly of polys) {
    let inside = false
    for (const r of poly) {
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        if (r[i].y > y !== r[j].y > y && x < ((r[j].x - r[i].x) * (y - r[i].y)) / (r[j].y - r[i].y) + r[i].x) inside = !inside
      }
    }
    if (inside) return true
  }
  return false
}

const _q = new Vector3()
