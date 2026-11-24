// Tráfico en el hilo principal: habla con el worker (traffic.worker.ts), que monta la red de
// calles alrededor de la cámara y mueve los vehículos, y dibuja lo que le manda.
//
// - Vehículos: una malla instanciada por modelo (vehicleModels.ts), con el color de cada uno; de
//   lejos, una caja de su tamaño. Solo los que caen en pantalla.
// - Alturas: las del worker (MDT a nivel 14); cerca de la cámara, las del suelo de la física
//   (lo que se ve) y, en los puentes, la calzada del tablero (Bridges.ts).
// - Luces: faros, pilotos (más fuertes al frenar) e intermitentes, como puntos con tamaño mínimo
//   en píxeles que escriben su radiancia y alfa 0 (igual que las luces del aparato). Los faros y
//   los pilotos se encienden al atardecer; frenos e intermitentes se ven también de día de cerca.
// - Barcos: los que navegan llegan cada fotograma como los vehículos; los quietos (amarrados,
//   atracados y fondeados) una vez por región, y se dibujan los cercanos a la cámara en un grupo con
//   el marco de la región. De noche, luces de navegación y de fondeo.
// - Choques: `collides` (el aparato contra un vehículo o un barco).

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Frustum,
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  NoBlending,
  Points,
  Quaternion,
  ShaderMaterial,
  Sphere,
  Vector2,
  Vector3,
  type Camera,
  type Texture,
  type WebGLRenderer,
} from 'three'
import { OVERLAY_LAYER } from '../render/Graphics.ts'
import type { StreetLightEffect } from '../render/StreetLightEffect.ts'
import { setNightLights } from '../render/nightLights.ts'
import { viewerLight } from '../render/SunShadows.ts'
import { GeoFrame } from '../world/GeoFrame.ts'
import { BOAT_STRIDE, BOAT_TYPE, FERRY_TYPE, FLAG, STRIDE, TRAIN_TYPE, type FromWorker, type ToWorker } from './protocol.ts'
import { VTYPES } from './sim.ts'
import { BOAT_BASE, FERRY_LEN, TRAILER_LEN, TRAIN_DIMS, boatColour, boatGeometries, bodyColour, ferryColour, trainColour, vehicleGeometries } from './vehicleModels.ts'

export interface TrafficOptions {
  heights: 'ign' | 'terrarium'
  ignUrl: string
  terrariumUrl: string
}

/** el suelo como lo ve la física (World.sampleGround) */
export interface GroundSampler {
  sampleGround(x: number, z: number, yHint: number, out: { y: number; normal: Vector3 }, deckMaxY?: number, deckDirX?: number, deckDirZ?: number): boolean
  /** ¿dentro de un edificio? */
  insideBuilding?(p: Vector3): boolean
}

/** a partir de aquí, caja de su tamaño en vez del modelo */
const FAR_LOD = 650
/** cerca de la cámara, altura del suelo de la física (la del worker es más gruesa) */
const NEAR_GROUND = 500
/** lux por unidad de iluminancia de la escena (ver AircraftLights) */
const LUX_PER_UNIT = 75718

/** altura de faros y pilotos por tipo (los índices de VTYPES; 6 = tractora) */
const LAMP_Y: Array<[number, number]> = [
  [0.72, 0.86],
  [0.72, 0.95],
  [0.92, 1.05],
  [0.95, 1.0],
  [0.85, 0.9],
  [0.6, 0.9],
  [0.9, 1.05],
]
const LAMPS_PER_VEH = 6

/**
 * Barcos (a la eslora del modelo): manga, altura de la obra muerta, del tope (luz de tope) y de lo más
 * alto (para los choques).
 */
const BOAT_DIMS: Array<{ beam: number; hull: number; mast: number; top: number }> = [
  { beam: 3.84, hull: 1, mast: 16, top: 16 },
  { beam: 3.84, hull: 1, mast: 16, top: 16 },
  { beam: 4.86, hull: 1.8, mast: 5.3, top: 5.3 },
  { beam: 2.3, hull: 0.75, mast: 1.8, top: 1.8 },
  { beam: 4.8, hull: 2.2, mast: 9.5, top: 9.5 },
  { beam: 7.6, hull: 1.2, mast: 3.6, top: 3.6 },
  { beam: 9.2, hull: 1.5, mast: 6.2, top: 6.2 },
  { beam: 37.5, hull: 11, mast: 42, top: 42 },
  { beam: 39.6, hull: 9, mast: 37, top: 37 },
  { beam: 32, hull: 9, mast: 36, top: 36 },
]

const _f = new Vector3()
const _r = new Vector3()
const _h = new Vector3()
const _t = new Vector3()
const _fw = new Vector3()
const _up = new Vector3()
const _rt = new Vector3()
const _c = new Vector3()
const _c0 = new Vector3()
const _u3 = new Vector3()
const _m = new Matrix4()
const _col = new Color()
const _sphere = new Sphere()
const _frustum = new Frustum()
const _pv = new Matrix4()
const _size = new Vector2()
const _gs = { y: 0, normal: new Vector3() }
const _q = new Quaternion()
const _inv = new Matrix4()
const _Y = new Vector3(0, 1, 0)

export class Traffic {
  /** vehículos y luces (en coordenadas de mundo) */
  readonly group = new Group()
  enabled = true
  /** máximo de vehículos, radio de la región en teselas, radio de dibujo (m), densidad */
  cap = 1500
  tiles = 2
  drawRadius = 4000
  density = 1
  /** hora local (0–24) */
  hour = 12
  /** último estado del worker (para depurar) */
  info: FromWorker['info'] | null = null
  private readonly worker: Worker
  private busy = false
  private acc = 0
  private latest: FromWorker | null = null
  private readonly region = new GeoFrame()
  private regionKey = ''
  private readonly toWorld = new Matrix4()
  private readonly material: MeshStandardMaterial
  /** barcos grandes, turísticos y ferris: con algo de luz propia de noche */
  private readonly shipMaterial: MeshStandardMaterial
  private readonly meshes: InstancedMesh[]
  private readonly trailerMesh: InstancedMesh
  private readonly farMesh: InstancedMesh
  /** coches de tren: cabeza y coche de cada tipo (tren, vía estrecha, metro) */
  private readonly trainMeshes: InstancedMesh[]
  /** transbordadores: lancha y ferri grande */
  private readonly ferryMeshes: InstancedMesh[]
  /** barcos que navegan (por tipo) */
  private readonly boatMeshes: InstancedMesh[]
  private readonly boatGeos: BufferGeometry[]
  // barcos quietos: en un grupo con el marco de la región (se rellena al llegar o al moverse la cámara)
  private readonly staticGroup = new Group()
  private staticMeshes: InstancedMesh[] = []
  private staticData: Float32Array = new Float32Array(0)
  private staticDirty = false
  private readonly staticCenter = new Vector3(1e12, 0, 1e12)
  private readonly staticLights: Points
  private staticKey = ''
  private staticT = 0
  private readonly lights: Points
  private readonly lightMat: ShaderMaterial
  private readonly lampPos: Float32Array
  private readonly lampCol: Float32Array
  private capacity: number
  /** cajas de los vehículos cercanos al aparato (para los choques): centro, eje, semitamaños, suelo */
  private boxes: Float32Array = new Float32Array(0)
  private nBoxes = 0
  private t = 0
  private readonly worldFrame: GeoFrame
  private disposed = false
  // farolas (marco de la región): x, y de la bombilla, z, tipo (potencia + ,5 si es LED)
  private lampData = new Float32Array(4 * 4096)
  private nLamps = 0
  private lampsDirty = false
  private readonly lampHeads: Points
  private lampHeadsCap = 0
  private streetLight: StreetLightEffect | null = null
  /** encendido de las farolas (0 de día, 1 de noche) */
  private lampsOn = 0
  private lampsOnShown = -1
  private exposure = 1
  // rejilla de las farolas para la luz sobre el suelo
  private gridCenter = new Vector3(1e12, 0, 1e12)
  private gridKey = ''
  private gridT = 0
  private gridLamps = new Float32Array(0)
  private gridCells = new Float32Array(0)

  constructor(worldFrame: GeoFrame, opts: TrafficOptions, capacity = 4000) {
    this.worldFrame = worldFrame
    this.capacity = capacity
    this.group.name = 'traffic'
    this.group.matrixAutoUpdate = false
    // dan sombra del sol como los edificios (render/SunShadows.ts)
    this.group.userData.worldShadowCaster = true
    this.material = makeMaterial()
    this.shipMaterial = makeMaterial(true)
    const geos = vehicleGeometries()
    this.meshes = geos.types.map((g) => this.makeMesh(g, capacity))
    this.trailerMesh = this.makeMesh(geos.trailer, capacity)
    this.farMesh = this.makeMesh(geos.far, capacity * 2)
    this.trainMeshes = geos.trains.map((g) => this.makeMesh(g, 400))
    this.ferryMeshes = geos.ferries.map((g) => this.makeMesh(g, 60, this.shipMaterial))
    this.boatGeos = boatGeometries()
    this.boatMeshes = this.boatGeos.map((g, k) => this.makeMesh(g, 150, k === 5 || k >= 7 ? this.shipMaterial : this.material))
    this.staticGroup.name = 'traffic_moored'
    this.staticGroup.matrixAutoUpdate = false
    this.staticGroup.visible = false
    this.group.add(this.staticGroup)
    this.staticMeshes = this.boatGeos.map((g, k) => this.makeStaticMesh(g, 64, k))
    const sg = new BufferGeometry()
    this.staticLights = new Points(sg, makeLightMaterial())
    this.staticLights.name = 'moored_lights'
    this.staticLights.frustumCulled = false
    this.staticLights.renderOrder = 4
    this.staticLights.layers.set(OVERLAY_LAYER)
    this.staticLights.visible = false
    this.staticLights.onBeforeRender = (renderer: WebGLRenderer) => {
      renderer.getDrawingBufferSize(_size)
      const m = this.staticLights.material as ShaderMaterial
      m.uniforms.viewportH.value = _size.y
      m.uniforms.gain.value = 1 / Math.max(renderer.toneMappingExposure, 1e-3)
    }
    this.staticGroup.add(this.staticLights)
    // luces
    this.lampPos = new Float32Array(capacity * LAMPS_PER_VEH * 3)
    this.lampCol = new Float32Array(capacity * LAMPS_PER_VEH * 3)
    const size = new Float32Array(capacity * LAMPS_PER_VEH * 2)
    for (let i = 0; i < capacity * LAMPS_PER_VEH; i++) {
      size[i * 2] = 0.16
      size[i * 2 + 1] = 1.6
    }
    const lg = new BufferGeometry()
    lg.setAttribute('position', new BufferAttribute(this.lampPos, 3).setUsage(DynamicDrawUsage))
    lg.setAttribute('lampColor', new BufferAttribute(this.lampCol, 3).setUsage(DynamicDrawUsage))
    lg.setAttribute('lampSize', new BufferAttribute(size, 2))
    lg.setDrawRange(0, 0)
    this.lightMat = makeLightMaterial()
    this.lights = new Points(lg, this.lightMat)
    this.lights.name = 'traffic_lights'
    this.lights.frustumCulled = false
    this.lights.renderOrder = 4
    this.lights.layers.set(OVERLAY_LAYER)
    this.lights.onBeforeRender = (renderer: WebGLRenderer) => {
      renderer.getDrawingBufferSize(_size)
      this.lightMat.uniforms.viewportH.value = _size.y
      this.lightMat.uniforms.gain.value = 1 / Math.max(renderer.toneMappingExposure, 1e-3)
      this.exposure = renderer.toneMappingExposure
    }
    this.group.add(this.lights)
    // bombillas de las farolas (puntos como las luces de los vehículos, en el marco de la región)
    const hg = new BufferGeometry()
    this.lampHeads = new Points(hg, makeLightMaterial())
    this.lampHeads.name = 'street_lamps'
    this.lampHeads.frustumCulled = false
    this.lampHeads.matrixAutoUpdate = false
    this.lampHeads.renderOrder = 4
    this.lampHeads.layers.set(OVERLAY_LAYER)
    this.lampHeads.visible = false
    this.lampHeads.onBeforeRender = (renderer: WebGLRenderer) => {
      renderer.getDrawingBufferSize(_size)
      const m = this.lampHeads.material as ShaderMaterial
      m.uniforms.viewportH.value = _size.y
      m.uniforms.gain.value = 1 / Math.max(renderer.toneMappingExposure, 1e-3)
    }
    this.group.add(this.lampHeads)
    // worker
    this.worker = new Worker(new URL('./traffic.worker.ts', import.meta.url), { type: 'module', name: 'trafico' })
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => {
      this.busy = false
      if (this.disposed) return
      this.latest = e.data
      this.takeLamps(e.data)
      if (e.data.boats) {
        this.staticData = e.data.boats
        this.staticDirty = true
      }
      this.info = e.data.info
    }
    this.worker.onerror = (e) => console.warn('tráfico: error en el worker', e.message)
    const init: ToWorker = { kind: 'init', heights: opts.heights, ignUrl: opts.ignUrl, terrariumUrl: opts.terrariumUrl, seed: (Math.random() * 1e9) | 0 }
    this.worker.postMessage(init)
  }

  private makeMesh(g: BufferGeometry, capacity: number, material = this.material): InstancedMesh {
    const m = new InstancedMesh(g, material, capacity)
    m.instanceMatrix.setUsage(DynamicDrawUsage)
    m.setColorAt(0, new Color(1, 1, 1))
    m.instanceColor!.setUsage(DynamicDrawUsage)
    m.count = 0
    m.frustumCulled = false
    m.castShadow = true
    this.group.add(m)
    return m
  }

  /** malla de barcos quietos (en el grupo del marco de la región) */
  private makeStaticMesh(g: BufferGeometry, capacity: number, kind: number): InstancedMesh {
    const m = new InstancedMesh(g, kind >= 7 ? this.shipMaterial : this.material, capacity)
    m.setColorAt(0, new Color(1, 1, 1))
    m.count = 0
    m.frustumCulled = false
    m.castShadow = true
    this.staticGroup.add(m)
    return m
  }

  setEnvMap(tex: Texture | null): void {
    for (const m of [this.material, this.shipMaterial]) {
      if ((m.envMap === null) !== (tex === null)) m.needsUpdate = true
      m.envMap = tex
      m.envMapIntensity = 1
    }
  }

  /**
   * Cada fotograma: manda al worker la cámara (y el aparato si está posado, para que lo esquiven)
   * y dibuja el último estado recibido.
   */
  update(dt: number, camera: Camera, ground: GroundSampler | null, aircraft: { pos: Vector3; agl: number; onGround: boolean } | null, sunY: number): void {
    if (this.disposed) return
    // (con el tráfico apagado sigue habiendo farolas: el worker monta la red sin mover vehículos)
    this.t += dt
    this.acc += dt
    const cam = camera.position
    if (!this.busy) {
      const g = this.worldFrame.worldToGeo(cam)
      const obstacles: Array<{ lat: number; lon: number; h: number; r: number }> = []
      if (aircraft && aircraft.agl < 5) {
        const a = this.worldFrame.worldToGeo(aircraft.pos)
        obstacles.push({ lat: a.lat, lon: a.lon, h: a.h, r: 5 })
      }
      const msg: ToWorker = {
        kind: 'frame',
        dt: this.acc,
        lat: g.lat,
        lon: g.lon,
        h: g.h,
        hour: this.hour,
        cap: this.cap,
        tiles: this.tiles,
        density: this.density,
        drawRadius: this.drawRadius,
        obstacles,
        sim: this.enabled,
      }
      this.worker.postMessage(msg)
      this.busy = true
      this.acc = 0
    }
    this.syncRegion()
    if (this.enabled) this.draw(camera, ground, aircraft, sunY)
    else this.hideVehicles()
    this.updateLamps(camera, sunY)
  }

  private draw(camera: Camera, ground: GroundSampler | null, aircraft: { pos: Vector3; agl: number } | null, sunY: number): void {
    const st = this.latest
    for (const m of this.meshes) m.count = 0
    for (const m of this.trainMeshes) m.count = 0
    for (const m of this.ferryMeshes) m.count = 0
    for (const m of this.boatMeshes) m.count = 0
    this.trailerMesh.count = 0
    this.farMesh.count = 0
    this.lights.geometry.setDrawRange(0, 0)
    this.nBoxes = 0
    if (!st || !st.origin) return
    const key = st.origin.join(',')
    if (key !== this.regionKey) {
      this.regionKey = key
      this.region.setOrigin(st.origin[0], st.origin[1], st.origin[2])
    }
    // marco de la región → mundo (el mundo re-centra su origen de vez en cuando)
    this.toWorld.multiplyMatrices(this.worldFrame.ecefToWorld, this.region.worldToECEF)
    _up.set(0, 1, 0).transformDirection(this.toWorld)
    camera.updateMatrixWorld()
    _pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    _frustum.setFromProjectionMatrix(_pv)
    const cam = camera.position
    // faros y pilotos encendidos: con poca luz (como las luces del aparato)
    const amb = viewerLight.illuminance
    const night = amb >= 0 ? amb * LUX_PER_UNIT < 2500 : sunY < 0.1
    const blinkOn = this.t % 0.8 < 0.4
    const d = st.data
    const counts = new Array(this.meshes.length).fill(0)
    let nFar = 0
    let nTrailer = 0
    let nLamp = 0
    const lp = this.lampPos
    const lc = this.lampCol
    const ac = aircraft?.pos ?? null
    if (this.boxes.length < st.count * 10) this.boxes = new Float32Array(st.count * 10 + 100)
    const trainCounts = new Array(this.trainMeshes.length).fill(0)
    const ferryCounts = [0, 0]
    const boatCounts = new Array(this.boatMeshes.length).fill(0)
    for (let i = 0; i < st.count; i++) {
      const o = i * STRIDE
      const type = d[o + 12]
      const flags = d[o + 14]
      if (type >= BOAT_TYPE) {
        // barco (en el agua), escalado a su eslora
        const bk = type - BOAT_TYPE
        const D = BOAT_DIMS[bk]
        _f.set(d[o], d[o + 1], d[o + 2]).applyMatrix4(this.toWorld)
        _r.set(d[o + 3], d[o + 4], d[o + 5]).applyMatrix4(this.toWorld)
        const len = _f.distanceTo(_r)
        const k = len / BOAT_BASE[bk]
        _c.addVectors(_f, _r).multiplyScalar(0.5)
        _fw.subVectors(_f, _r).normalize()
        _rt.crossVectors(_fw, _up).normalize()
        const u = _h.crossVectors(_rt, _fw).normalize()
        if (ac && _c.distanceTo(ac) < len + 60) this.pushBox(_c, _fw, len, D.beam * k, D.top * k)
        _sphere.center.copy(_c)
        _sphere.radius = len * 0.6 + D.top * k
        if (!_frustum.intersectsSphere(_sphere)) continue
        _m.makeBasis(_fw, u, _rt).setPosition(_c)
        _m.scale(_t.set(k, k, k))
        boatColour(bk, d[o + 13], _col)
        const n = boatCounts[bk]++
        if (n < 150) {
          this.boatMeshes[bk].setMatrixAt(n, _m)
          this.boatMeshes[bk].setColorAt(n, _col)
        }
        // de noche: luz de tope (o tricolor en el tope del velero), costados y alcance
        if (night && nLamp + 4 < this.capacity * LAMPS_PER_VEH) {
          const hw = D.beam * k * 0.45
          const top = D.mast * k
          const lamp = (x: number, y: number, z: number, r: number, g: number, b: number) => {
            lp.set([x, y, z], nLamp * 3)
            lc.set([r, g, b], nLamp * 3)
            nLamp++
          }
          const bx = _c.x + _fw.x * len * 0.42
          const bz = _c.z + _fw.z * len * 0.42
          const sx = _c.x - _fw.x * len * 0.47
          const sz = _c.z - _fw.z * len * 0.47
          const hy = _c.y + D.hull * k + 0.4 * k
          if (bk >= 7) {
            shipLights(bk, len, (along, up, side, r, g, b) => {
              if (nLamp + 1 < this.capacity * LAMPS_PER_VEH) lamp(_c.x + _fw.x * along + _rt.x * side, _c.y + up, _c.z + _fw.z * along + _rt.z * side, r, g, b)
            })
          }
          if (bk === 0) {
            lamp(_c.x + _fw.x * len * 0.13 - _rt.x * 0.2, _c.y + top, _c.z + _fw.z * len * 0.13 - _rt.z * 0.2, 1, 0.03, 0.03)
            lamp(_c.x + _fw.x * len * 0.13 + _rt.x * 0.2, _c.y + top, _c.z + _fw.z * len * 0.13 + _rt.z * 0.2, 0.05, 1, 0.3)
          } else {
            lamp(_c.x + _fw.x * len * 0.15, _c.y + top, _c.z + _fw.z * len * 0.15, 2, 1.95, 1.8)
            lamp(bx - _rt.x * hw, hy, bz - _rt.z * hw, 1, 0.03, 0.03)
            lamp(bx + _rt.x * hw, hy, bz + _rt.z * hw, 0.05, 1, 0.3)
          }
          lamp(sx, hy, sz, 1.4, 1.35, 1.25)
        }
        continue
      }
      if (type >= FERRY_TYPE) {
        // transbordador (en el agua: sin corrección de suelo), escalado a su eslora
        const fi = type - FERRY_TYPE
        _f.set(d[o], d[o + 1], d[o + 2]).applyMatrix4(this.toWorld)
        _r.set(d[o + 3], d[o + 4], d[o + 5]).applyMatrix4(this.toWorld)
        const len = _f.distanceTo(_r)
        _c.addVectors(_f, _r).multiplyScalar(0.5)
        _fw.subVectors(_f, _r).normalize()
        _rt.crossVectors(_fw, _up).normalize()
        const u = _h.crossVectors(_rt, _fw).normalize()
        _sphere.center.copy(_c)
        _sphere.radius = len * 0.6 + 5
        if (ac && _c.distanceTo(ac) < len + 60) {
          const b = this.boxes
          const k = this.nBoxes * 10
          b[k] = _c.x
          b[k + 1] = _c.y - 1
          b[k + 2] = _c.z
          b[k + 3] = _fw.x
          b[k + 4] = _fw.y
          b[k + 5] = _fw.z
          b[k + 6] = len / 2
          b[k + 7] = (fi ? 24 : 8) * (len / FERRY_LEN[fi]) * 0.5
          b[k + 8] = (fi ? 25 : 6) * (len / FERRY_LEN[fi])
          this.nBoxes++
        }
        if (!_frustum.intersectsSphere(_sphere)) continue
        const k = len / FERRY_LEN[fi]
        _m.makeBasis(_fw, u, _rt).setPosition(_c)
        _m.scale(_t.set(k, k, k))
        ferryColour(d[o + 13], _col)
        const n = ferryCounts[fi]++
        if (n < 60) {
          this.ferryMeshes[fi].setMatrixAt(n, _m)
          this.ferryMeshes[fi].setColorAt(n, _col)
        }
        // luces de navegación de noche: tope blanco, roja a babor y verde a estribor
        if (night && nLamp + 3 < this.capacity * LAMPS_PER_VEH) {
          const hw = (fi ? 12 : 4) * k
          const top = (fi ? 30 : 7) * k
          lp.set([_c.x + _fw.x * len * 0.2, _c.y + top, _c.z + _fw.z * len * 0.2], nLamp * 3)
          lc.set([2, 1.95, 1.8], nLamp * 3)
          nLamp++
          lp.set([_c.x - _rt.x * hw, _c.y + top * 0.6, _c.z - _rt.z * hw], nLamp * 3)
          lc.set([1, 0.03, 0.03], nLamp * 3)
          nLamp++
          lp.set([_c.x + _rt.x * hw, _c.y + top * 0.6, _c.z + _rt.z * hw], nLamp * 3)
          lc.set([0.05, 1, 0.3], nLamp * 3)
          nLamp++
        }
        continue
      }
      if (type >= TRAIN_TYPE) {
        // coche de tren
        const ti = type - TRAIN_TYPE
        const D = TRAIN_DIMS[ti >> 1]
        _f.set(d[o], d[o + 1], d[o + 2]).applyMatrix4(this.toWorld)
        _r.set(d[o + 3], d[o + 4], d[o + 5]).applyMatrix4(this.toWorld)
        _c.addVectors(_f, _r).multiplyScalar(0.5)
        const dist = _c.distanceTo(cam)
        const onBridge = (flags & FLAG.bridge) !== 0
        // (rumbo: en un puente, solo el tablero que lo lleva)
        const hx = _f.x - _r.x
        const hz = _f.z - _r.z
        if (ground && (onBridge || dist < NEAR_GROUND)) {
          if (ground.sampleGround(_f.x, _f.z, _f.y + 60, _gs, onBridge ? _f.y + 80 : undefined, hx, hz)) _f.y = _gs.y
          if (ground.sampleGround(_r.x, _r.z, _r.y + 60, _gs, onBridge ? _r.y + 80 : undefined, hx, hz)) _r.y = _gs.y
          _c.addVectors(_f, _r).multiplyScalar(0.5)
        }
        _fw.subVectors(_f, _r).normalize()
        _rt.crossVectors(_fw, _up).normalize()
        const u = _h.crossVectors(_rt, _fw).normalize()
        if (ac && _c.distanceTo(ac) < 80) {
          const b = this.boxes
          const k = this.nBoxes * 10
          b[k] = _c.x
          b[k + 1] = _c.y
          b[k + 2] = _c.z
          b[k + 3] = _fw.x
          b[k + 4] = _fw.y
          b[k + 5] = _fw.z
          b[k + 6] = D.len / 2
          b[k + 7] = D.w / 2
          b[k + 8] = D.h
          this.nBoxes++
        }
        _sphere.center.copy(_c)
        _sphere.radius = D.len * 0.6 + 1
        if (!_frustum.intersectsSphere(_sphere)) continue
        _m.makeBasis(_fw, u, _rt).setPosition(_c)
        trainColour(d[o + 13], _col)
        if (dist > FAR_LOD * 1.5) {
          _m.scale(_t.set(D.len, D.h, D.w))
          this.farMesh.setMatrixAt(nFar, _m)
          this.farMesh.setColorAt(nFar, _col)
          nFar++
        } else {
          const mesh = this.trainMeshes[ti]
          const n = trainCounts[ti]++
          if (n < 400) {
            mesh.setMatrixAt(n, _m)
            mesh.setColorAt(n, _col)
          }
        }
        // faros en la cabeza, pilotos en el último coche (de noche)
        if (night && (flags & (FLAG.head | FLAG.last))) {
          const tox = cam.x - _c.x
          const toy = cam.y - _c.y
          const toz = cam.z - _c.z
          const tl = Math.hypot(tox, toy, toz) || 1
          const facing = (_fw.x * tox + _fw.y * toy + _fw.z * toz) / tl
          for (const s of [-1, 1]) {
            const sx = _rt.x * (D.w / 2 - 0.45) * s
            const sz = _rt.z * (D.w / 2 - 0.45) * s
            if (flags & FLAG.head && nLamp < this.capacity * LAMPS_PER_VEH) {
              const k = Math.max(0.15, facing) * 2.6
              lp.set([_c.x + _fw.x * (D.len / 2) + sx, _c.y + 1.5, _c.z + _fw.z * (D.len / 2) + sz], nLamp * 3)
              lc.set([k, k * 0.96, k * 0.85], nLamp * 3)
              nLamp++
            }
            if (flags & FLAG.last && nLamp < this.capacity * LAMPS_PER_VEH) {
              const k = Math.max(0.2, -facing) * 0.6
              lp.set([_c.x - _fw.x * (D.len / 2) + sx, _c.y + 1.5, _c.z - _fw.z * (D.len / 2) + sz], nLamp * 3)
              lc.set([k, k * 0.02, k * 0.02], nLamp * 3)
              nLamp++
            }
          }
        }
        continue
      }
      const T = VTYPES[type]
      _f.set(d[o], d[o + 1], d[o + 2]).applyMatrix4(this.toWorld)
      _r.set(d[o + 3], d[o + 4], d[o + 5]).applyMatrix4(this.toWorld)
      _c.addVectors(_f, _r).multiplyScalar(0.5)
      const dist = _c.distanceTo(cam)
      // puentes: sobre el tablero; cerca de la cámara, sobre el suelo que se ve
      const onBridge = (flags & FLAG.bridge) !== 0
      const hx = _f.x - _r.x
      const hz = _f.z - _r.z
      if (ground && (onBridge || dist < NEAR_GROUND)) {
        if (ground.sampleGround(_f.x, _f.z, _f.y + 60, _gs, onBridge ? _f.y + 80 : undefined, hx, hz)) _f.y = _gs.y
        if (ground.sampleGround(_r.x, _r.z, _r.y + 60, _gs, onBridge ? _r.y + 80 : undefined, hx, hz)) _r.y = _gs.y
        _c.addVectors(_f, _r).multiplyScalar(0.5)
      }
      const trailer = T.trailer > 0
      const len = trailer ? 6 : T.len
      _c0.copy(_c)
      _sphere.center.copy(_c)
      _sphere.radius = (trailer ? T.len : len) * 0.7 + 1
      if (trailer) _sphere.center.lerp(_r, 1)
      const visible = _frustum.intersectsSphere(_sphere)
      // base: x adelante, y arriba, z derecha
      _fw.subVectors(_f, _r).normalize()
      _rt.crossVectors(_fw, _up).normalize()
      const up2 = _h.crossVectors(_rt, _fw).normalize()
      // choques: los cercanos al aparato
      if (ac && _c.distanceTo(ac) < 60) {
        const b = this.boxes
        const k = this.nBoxes * 10
        b[k] = _c.x
        b[k + 1] = _c.y
        b[k + 2] = _c.z
        b[k + 3] = _fw.x
        b[k + 4] = _fw.y
        b[k + 5] = _fw.z
        b[k + 6] = len / 2
        b[k + 7] = T.width / 2
        b[k + 8] = trailer ? 3.4 : T.height
        this.nBoxes++
      }
      if (visible) {
        _m.makeBasis(_fw, up2, _rt).setPosition(_c)
        bodyColour(type === 6 ? 4 : type, d[o + 13], _col)
        if (dist > FAR_LOD) {
          const fm = this.farMesh
          _m.scale(_t.set(len, trailer ? 3.4 : T.height, T.width))
          fm.setMatrixAt(nFar, _m)
          fm.setColorAt(nFar, _col)
          nFar++
        } else {
          const mesh = this.meshes[trailer ? 6 : type]
          const n = counts[trailer ? 6 : type]++
          mesh.setMatrixAt(n, _m)
          mesh.setColorAt(n, _col)
        }
      }
      // semirremolque: del enganche a la trasera
      if (trailer) {
        _h.set(d[o + 6], d[o + 7], d[o + 8]).applyMatrix4(this.toWorld)
        _t.set(d[o + 9], d[o + 10], d[o + 11]).applyMatrix4(this.toWorld)
        if (ground && (onBridge || dist < NEAR_GROUND)) {
          if (ground.sampleGround(_h.x, _h.z, _h.y + 60, _gs, onBridge ? _h.y + 80 : undefined, _h.x - _t.x, _h.z - _t.z)) _h.y = _gs.y
          if (ground.sampleGround(_t.x, _t.z, _t.y + 60, _gs, onBridge ? _t.y + 80 : undefined, _h.x - _t.x, _h.z - _t.z)) _t.y = _gs.y
        }
        const fwx = _h.x - _t.x
        const fwy = _h.y - _t.y
        const fwz = _h.z - _t.z
        const fl = Math.hypot(fwx, fwy, fwz) || 1
        _fw.set(fwx / fl, fwy / fl, fwz / fl)
        _rt.crossVectors(_fw, _up).normalize()
        const u3 = _u3.crossVectors(_rt, _fw).normalize()
        // centro del remolque: a medio largo por detrás de la parte delantera del remolque
        _c.copy(_h).addScaledVector(_fw, 0.9 - TRAILER_LEN / 2)
        if (ac && _c.distanceTo(ac) < 60) {
          const b = this.boxes
          const k = this.nBoxes * 10
          b[k] = _c.x
          b[k + 1] = _c.y
          b[k + 2] = _c.z
          b[k + 3] = _fw.x
          b[k + 4] = _fw.y
          b[k + 5] = _fw.z
          b[k + 6] = TRAILER_LEN / 2
          b[k + 7] = 1.27
          b[k + 8] = 4.0
          this.nBoxes++
        }
        if (visible) {
          _m.makeBasis(_fw, u3, _rt).setPosition(_c)
          bodyColour(4, d[o + 13] * 7 + 3, _col)
          if (dist > FAR_LOD) {
            _m.scale(_t.set(TRAILER_LEN, 4, 2.55))
            this.farMesh.setMatrixAt(nFar, _m)
            this.farMesh.setColorAt(nFar, _col)
            nFar++
          } else {
            this.trailerMesh.setMatrixAt(nTrailer, _m)
            this.trailerMesh.setColorAt(nTrailer, _col)
            nTrailer++
          }
        }
      }
      // luces (con la base de la cabeza: recalculada)
      if (!visible) continue
      const brake = (flags & FLAG.brake) !== 0
      const left = (flags & FLAG.left) !== 0 && blinkOn
      const right = (flags & FLAG.right) !== 0 && blinkOn
      const near = dist < 180
      if (!night && !near) continue
      if (!night && !brake && !left && !right) continue
      _fw.subVectors(_f, _r).normalize()
      _rt.crossVectors(_fw, _up).normalize()
      const ly = LAMP_Y[trailer ? 6 : type]
      const hw = T.width / 2 - 0.3
      // hacia la cámara: los faros se ven de frente, los pilotos de espaldas (algo desde arriba)
      const tox = cam.x - _c0.x
      const toy = cam.y - _c0.y
      const toz = cam.z - _c0.z
      const tl = Math.hypot(tox, toy, toz) || 1
      const facing = (_fw.x * tox + _fw.y * toy + _fw.z * toz) / tl
      const headK = night ? Math.max(0.12, facing) : 0
      const tailK = Math.max(0.2, -facing)
      // frontal y trasera del vehículo (o del remolque)
      const fx = _c0.x + _fw.x * (len / 2)
      const fz = _c0.z + _fw.z * (len / 2)
      const fy = _c0.y + _fw.y * (len / 2)
      let bx = _c0.x - _fw.x * (len / 2)
      let by = _c0.y - _fw.y * (len / 2)
      let bz = _c0.z - _fw.z * (len / 2)
      if (trailer) {
        bx = _t.x
        by = _t.y
        bz = _t.z
      }
      const lamp = (x: number, y: number, z: number, r: number, g: number, b: number) => {
        if (nLamp >= this.capacity * LAMPS_PER_VEH) return
        lp[nLamp * 3] = x
        lp[nLamp * 3 + 1] = y
        lp[nLamp * 3 + 2] = z
        lc[nLamp * 3] = r
        lc[nLamp * 3 + 1] = g
        lc[nLamp * 3 + 2] = b
        nLamp++
      }
      for (const s of [-1, 1]) {
        const sx = _rt.x * hw * s
        const sz = _rt.z * hw * s
        if (headK > 0) lamp(fx + sx, fy + ly[0], fz + sz, 2.4 * headK, 2.3 * headK, 2.0 * headK)
        const tail = (brake ? 1.0 : night ? 0.45 : 0) * tailK
        if (tail > 0) lamp(bx + sx, by + ly[1], bz + sz, tail, 0.02 * tail, 0.02 * tail)
        if ((s < 0 && left) || (s > 0 && right)) lamp(bx + sx * 1.08, by + ly[1] + 0.12, bz + sz * 1.08, 1.0, 0.45, 0.02)
      }
    }
    boatCounts.forEach((n, i) => {
      const m = this.boatMeshes[i]
      m.count = Math.min(n, 150)
      if (n) {
        m.instanceMatrix.needsUpdate = true
        m.instanceColor!.needsUpdate = true
      }
    })
    this.drawStatics(cam, night, ac, ground)
    ferryCounts.forEach((n, i) => {
      const m = this.ferryMeshes[i]
      m.count = Math.min(n, 60)
      if (n) {
        m.instanceMatrix.needsUpdate = true
        m.instanceColor!.needsUpdate = true
      }
    })
    trainCounts.forEach((n, i) => {
      const m = this.trainMeshes[i]
      m.count = Math.min(n, 400)
      if (n) {
        m.instanceMatrix.needsUpdate = true
        m.instanceColor!.needsUpdate = true
      }
    })
    counts.forEach((n, i) => {
      const m = this.meshes[i]
      m.count = n
      if (n) {
        m.instanceMatrix.needsUpdate = true
        m.instanceColor!.needsUpdate = true
      }
    })
    this.trailerMesh.count = nTrailer
    if (nTrailer) {
      this.trailerMesh.instanceMatrix.needsUpdate = true
      this.trailerMesh.instanceColor!.needsUpdate = true
    }
    this.farMesh.count = nFar
    if (nFar) {
      this.farMesh.instanceMatrix.needsUpdate = true
      this.farMesh.instanceColor!.needsUpdate = true
    }
    const lg = this.lights.geometry
    lg.setDrawRange(0, nLamp)
    if (nLamp) {
      ;(lg.getAttribute('position') as BufferAttribute).needsUpdate = true
      ;(lg.getAttribute('lampColor') as BufferAttribute).needsUpdate = true
    }
  }

  /** caja de choque (centro en la línea de flotación, eje, eslora, manga, altura) */
  private pushBox(c: Vector3, fw: Vector3, len: number, beam: number, height: number): void {
    if (this.boxes.length < (this.nBoxes + 1) * 10) {
      const b = new Float32Array(this.boxes.length * 2 + 100)
      b.set(this.boxes)
      this.boxes = b
    }
    const b = this.boxes
    const k = this.nBoxes * 10
    b[k] = c.x
    b[k + 1] = c.y - 1
    b[k + 2] = c.z
    b[k + 3] = fw.x
    b[k + 4] = fw.y
    b[k + 5] = fw.z
    b[k + 6] = len / 2
    b[k + 7] = beam / 2
    b[k + 8] = height + 1
    this.nBoxes++
  }

  /**
   * Barcos quietos cerca de la cámara (marco de la región): se vuelven a poner al llegar otros o
   * cuando la cámara se ha movido; sus luces de fondeo de noche y sus cajas de choque.
   */
  private drawStatics(cam: Vector3, night: boolean, ac: Vector3 | null, ground: GroundSampler | null): void {
    const g = this.staticGroup
    const n = this.staticData.length / BOAT_STRIDE
    g.visible = n > 0
    if (!n) return
    g.matrix.copy(this.toWorld)
    g.matrixWorldNeedsUpdate = true
    _inv.copy(this.toWorld).invert()
    const camR = _t.copy(cam).applyMatrix4(_inv)
    const d = this.staticData
    const R = this.drawRadius * 1.1
    // (y cada 8 s: los edificios van llegando y un amarrado no ha de quedar dentro de uno)
    if (this.staticDirty || this.staticKey !== this.regionKey || Math.hypot(camR.x - this.staticCenter.x, camR.z - this.staticCenter.z) > 250 || this.t - this.staticT > 8) {
      this.staticDirty = false
      this.staticT = this.t
      this.staticKey = this.regionKey
      this.staticCenter.copy(camR)
      const counts = new Array(this.staticMeshes.length).fill(0)
      const near: number[] = []
      for (let i = 0; i < n; i++) {
        const o = i * BOAT_STRIDE
        const dx = d[o] - camR.x
        const dz = d[o + 2] - camR.z
        if (dx * dx + dz * dz > (R + d[o + 5]) ** 2) continue
        if (ground?.insideBuilding && dx * dx + dz * dz < 2500 * 2500) {
          _c.set(d[o], d[o + 1] + 1.5, d[o + 2]).applyMatrix4(this.toWorld)
          if (ground.insideBuilding(_c)) continue
        }
        near.push(i)
        counts[d[o + 4]]++
      }
      // más sitio en las mallas que se queden cortas
      counts.forEach((c, k) => {
        if (c <= this.staticMeshes[k].instanceMatrix.count) return
        const old = this.staticMeshes[k]
        old.removeFromParent()
        old.dispose()
        this.staticMeshes[k] = this.makeStaticMesh(this.boatGeos[k], Math.ceil(c * 1.5), k)
      })
      counts.fill(0)
      const lights: number[] = []
      const lcol: number[] = []
      for (const i of near) {
        const o = i * BOAT_STRIDE
        const kind = d[o + 4]
        const len = d[o + 5]
        const k = len / BOAT_BASE[kind]
        _q.setFromAxisAngle(_Y, -d[o + 3])
        _m.compose(_f.set(d[o], d[o + 1], d[o + 2]), _q, _r.set(k, k, k))
        const mesh = this.staticMeshes[kind]
        const c = counts[kind]++
        mesh.setMatrixAt(c, _m)
        mesh.setColorAt(c, boatColour(kind, d[o + 6], _col))
        if (kind >= 7) {
          // mercantes: luces de fondeo, de cubierta y del puente
          const fx = Math.cos(d[o + 3])
          const fz = Math.sin(d[o + 3])
          shipLights(kind, len, (along, up, side, r, g, b) => {
            lights.push(d[o] + fx * along - fz * side, d[o + 1] + up, d[o + 2] + fz * along + fx * side)
            lcol.push(r, g, b)
          })
        }
      }
      counts.forEach((c, k) => {
        const m = this.staticMeshes[k]
        m.count = c
        m.instanceMatrix.needsUpdate = true
        if (m.instanceColor) m.instanceColor.needsUpdate = true
      })
      const lg = this.staticLights.geometry
      lg.setAttribute('position', new BufferAttribute(new Float32Array(lights), 3))
      lg.setAttribute('lampColor', new BufferAttribute(new Float32Array(lcol), 3))
      const size = new Float32Array((lights.length / 3) * 2)
      for (let i = 0; i < size.length; i += 2) {
        size[i] = 0.9
        size[i + 1] = 2
      }
      lg.setAttribute('lampSize', new BufferAttribute(size, 2))
      lg.setDrawRange(0, lights.length / 3)
    }
    this.staticLights.visible = night
    // choques con los quietos cerca del aparato
    if (!ac) return
    const acR = _h.copy(ac).applyMatrix4(_inv)
    for (let i = 0; i < n; i++) {
      const o = i * BOAT_STRIDE
      const len = d[o + 5]
      if (Math.abs(d[o] - acR.x) > len + 60 || Math.abs(d[o + 2] - acR.z) > len + 60) continue
      const kind = d[o + 4]
      const k = len / BOAT_BASE[kind]
      const D = BOAT_DIMS[kind]
      _c.set(d[o], d[o + 1], d[o + 2]).applyMatrix4(this.toWorld)
      _f.set(d[o] + Math.cos(d[o + 3]), d[o + 1], d[o + 2] + Math.sin(d[o + 3])).applyMatrix4(this.toWorld)
      _fw.subVectors(_f, _c).normalize()
      this.pushBox(_c, _fw, len, D.beam * k, D.top * k)
    }
  }

  /** ¿El punto (mundo) está dentro de un vehículo? */
  collides(p: Vector3): boolean {
    const b = this.boxes
    for (let i = 0; i < this.nBoxes; i++) {
      const k = i * 10
      const dx = p.x - b[k]
      const dy = p.y - b[k + 1]
      const dz = p.z - b[k + 2]
      if (dy < -0.2 || dy > b[k + 8]) continue
      const along = dx * b[k + 3] + dz * b[k + 5]
      if (Math.abs(along) > b[k + 6]) continue
      // lateral (perpendicular en el plano)
      const fl = Math.hypot(b[k + 3], b[k + 5]) || 1
      const lat = Math.abs(dx * -b[k + 5] + dz * b[k + 3]) / fl
      if (lat > b[k + 7]) continue
      return true
    }
    return false
  }

  /** marco de la región → mundo (el mundo re-centra su origen de vez en cuando) */
  private syncRegion(): void {
    const st = this.latest
    if (!st || !st.origin) return
    const key = st.origin.join(',')
    if (key !== this.regionKey) {
      this.regionKey = key
      this.region.setOrigin(st.origin[0], st.origin[1], st.origin[2])
    }
    this.toWorld.multiplyMatrices(this.worldFrame.ecefToWorld, this.region.worldToECEF)
  }

  private hideVehicles(): void {
    for (const m of [...this.meshes, ...this.trainMeshes, ...this.ferryMeshes, ...this.boatMeshes, this.trailerMesh, this.farMesh]) m.count = 0
    this.staticGroup.visible = false
    this.lights.geometry.setDrawRange(0, 0)
    this.nBoxes = 0
  }

  /** luz de las farolas sobre la calzada (en calidad baja, solo las bombillas) */
  groundLights = true

  /** La luz de las farolas sobre el terreno (efecto de posproceso de Graphics). */
  attachStreetLight(e: StreetLightEffect | null): void {
    if (this.streetLight === e) return
    this.streetLight = e
    this.gridKey = ''
  }

  private takeLamps(st: FromWorker): void {
    if (st.lampsReset) {
      this.nLamps = 0
      this.lampsDirty = true
    }
    const n = st.lamps.length / 4
    if (!n) return
    if ((this.nLamps + n) * 4 > this.lampData.length) {
      // como mucho ~120 000 farolas: si no, se empieza de nuevo con las de ahora
      if (this.nLamps + n > 120000) this.nLamps = 0
      const bigger = new Float32Array(Math.max(this.lampData.length * 2, (this.nLamps + n) * 4 * 1.5))
      bigger.set(this.lampData.subarray(0, this.nLamps * 4))
      this.lampData = bigger
    }
    this.lampData.set(st.lamps, this.nLamps * 4)
    this.nLamps += n
    this.lampsDirty = true
  }

  /** Encendido de las farolas, sus bombillas y la rejilla de su luz sobre el suelo. */
  private updateLamps(camera: Camera, sunY: number): void {
    // se encienden al atardecer (unos 1500 lux) y del todo hacia los 300
    const amb = viewerLight.illuminance
    const lux = amb >= 0 ? amb * LUX_PER_UNIT : sunY > 0.12 ? 1e5 : sunY > 0 ? 2000 : 10
    const on = 1 - smooth01((Math.log10(Math.max(lux, 1)) - Math.log10(300)) / (Math.log10(1500) - Math.log10(300)))
    this.lampsOn = on
    // luz propia de los barcos grandes de noche (unidades ya expuestas, como las luces)
    this.shipMaterial.emissive.setRGB(1, 0.82, 0.6).multiplyScalar((0.07 * on) / Math.max(this.exposure, 1e-3))
    // ventanas encendidas en los edificios: con la misma penumbra y la hora local
    setNightLights(on, this.hour, this.exposure)
    const sl = this.streetLight
    if (sl) {
      sl.on = this.nLamps > 0 && this.groundLights ? on : 0
      // como el foco de aterrizaje: unidades ya expuestas y compresión del ojo adaptado
      const ex = Math.max(this.exposure, 1e-3)
      sl.setLevels(2000 / ex, 0.5 / ex)
    }
    this.lampHeads.visible = on > 0.01 && this.nLamps > 0
    if (!this.lampHeads.visible) return
    this.lampHeads.matrix.copy(this.toWorld)
    this.lampHeads.matrixWorldNeedsUpdate = true
    // geometría de las bombillas (cuando llegan farolas nuevas o cambia el encendido)
    if (this.lampsDirty || Math.abs(on - this.lampsOnShown) > 0.05) {
      const n = this.nLamps
      const g = this.lampHeads.geometry
      if (n > this.lampHeadsCap) {
        this.lampHeadsCap = Math.ceil(n * 1.5)
        g.setAttribute('position', new BufferAttribute(new Float32Array(this.lampHeadsCap * 3), 3))
        g.setAttribute('lampColor', new BufferAttribute(new Float32Array(this.lampHeadsCap * 3), 3))
        const size = new Float32Array(this.lampHeadsCap * 2)
        for (let i = 0; i < this.lampHeadsCap; i++) {
          size[i * 2] = 0.5
          size[i * 2 + 1] = 1.3
        }
        g.setAttribute('lampSize', new BufferAttribute(size, 2))
      }
      const pos = g.getAttribute('position') as BufferAttribute
      const col = g.getAttribute('lampColor') as BufferAttribute
      const P = pos.array as Float32Array
      const C = col.array as Float32Array
      const d = this.lampData
      for (let i = 0; i < n; i++) {
        P[i * 3] = d[i * 4]
        P[i * 3 + 1] = d[i * 4 + 1]
        P[i * 3 + 2] = d[i * 4 + 2]
        const led = d[i * 4 + 3] % 1 > 0.25
        const k = 1.25 * on
        C[i * 3] = k
        C[i * 3 + 1] = (led ? 0.92 : 0.55) * k
        C[i * 3 + 2] = (led ? 0.8 : 0.2) * k
      }
      pos.needsUpdate = true
      col.needsUpdate = true
      g.setDrawRange(0, n)
      this.lampsOnShown = on
    }
    // rejilla para la luz sobre el suelo: 4 km alrededor de la cámara (celdas de 40 m)
    if (!sl || on <= 0) {
      this.lampsDirty = false
      return
    }
    const cam = camera.position
    const key = this.toWorld.elements.map((v) => v.toFixed(3)).join(',')
    const moved = Math.hypot(cam.x - this.gridCenter.x, cam.z - this.gridCenter.z) > 600
    const now = performance.now()
    if ((this.lampsDirty && now - this.gridT > 800) || moved || key !== this.gridKey) {
      this.gridT = now
      this.gridKey = key
      this.gridCenter.copy(cam)
      this.buildLampGrid(sl, cam)
    }
    this.lampsDirty = false
  }

  private buildLampGrid(sl: StreetLightEffect, cam: Vector3): void {
    const CELL = 40
    const N = 100
    const ox = Math.floor((cam.x - (N * CELL) / 2) / CELL) * CELL
    const oz = Math.floor((cam.z - (N * CELL) / 2) / CELL) * CELL
    const n = this.nLamps
    const d = this.lampData
    const cellOf = new Int32Array(n)
    const counts = new Uint32Array(N * N)
    const wx = new Float32Array(n)
    const wy = new Float32Array(n)
    const wz = new Float32Array(n)
    let inside = 0
    for (let i = 0; i < n; i++) {
      _t.set(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]).applyMatrix4(this.toWorld)
      const cx = Math.floor((_t.x - ox) / CELL)
      const cz = Math.floor((_t.z - oz) / CELL)
      if (cx < 0 || cz < 0 || cx >= N || cz >= N) {
        cellOf[i] = -1
        continue
      }
      const c = cz * N + cx
      cellOf[i] = c
      counts[c]++
      wx[i] = _t.x
      wy[i] = _t.y
      wz[i] = _t.z
      inside++
    }
    if (this.gridCells.length < N * N * 4) this.gridCells = new Float32Array(N * N * 4)
    if (this.gridLamps.length < inside * 4) this.gridLamps = new Float32Array(Math.max(4, inside * 4))
    const start = new Uint32Array(N * N)
    let acc = 0
    for (let c = 0; c < N * N; c++) {
      start[c] = acc
      this.gridCells[c * 4] = acc
      this.gridCells[c * 4 + 1] = Math.min(24, counts[c])
      this.gridCells[c * 4 + 2] = 0
      this.gridCells[c * 4 + 3] = 0
      acc += counts[c]
    }
    const fill = start.slice()
    for (let i = 0; i < n; i++) {
      const c = cellOf[i]
      if (c < 0) continue
      const k = fill[c]++
      this.gridLamps[k * 4] = wx[i]
      this.gridLamps[k * 4 + 1] = wy[i]
      this.gridLamps[k * 4 + 2] = wz[i]
      this.gridLamps[k * 4 + 3] = d[i * 4 + 3]
    }
    sl.setGrid(this.gridLamps, inside, this.gridCells, N, N, new Vector2(ox, oz), CELL)
  }

  dispose(): void {
    this.disposed = true
    this.worker.terminate()
    this.group.removeFromParent()
    for (const m of [...this.meshes, ...this.trainMeshes, ...this.ferryMeshes, ...this.boatMeshes, this.trailerMesh, this.farMesh]) {
      m.geometry.dispose()
      m.dispose()
    }
    for (const m of this.staticMeshes) m.dispose()
    this.staticLights.geometry.dispose()
    ;(this.staticLights.material as ShaderMaterial).dispose()
    this.material.dispose()
    this.shipMaterial.dispose()
    this.lights.geometry.dispose()
    this.lightMat.dispose()
    this.lampHeads.geometry.dispose()
    ;(this.lampHeads.material as ShaderMaterial).dispose()
    if (this.streetLight) this.streetLight.on = 0
    setNightLights(0, 12, 1)
  }
}

function smooth01(t: number): number {
  const x = Math.min(1, Math.max(0, t))
  return x * x * (3 - 2 * x)
}

/** Material de las carrocerías: iluminado, alfa 0 (ya iluminado) y color por vehículo donde `paint` = 1. */
function makeMaterial(lit = false): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.25 })
  m.onBeforeCompile = (shader) => {
    // barcos de noche: la luz de cubierta y de los camarotes, sobre su propio color
    if (lit) shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= diffuseColor.rgb;')
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nattribute float paint;').replace(
      '#include <color_vertex>',
      /* glsl */ `vColor = vec4(1.0);
      #ifdef USE_COLOR
        vColor.rgb *= color;
      #endif
      #ifdef USE_INSTANCING_COLOR
        vColor.rgb = mix(vColor.rgb, vColor.rgb * instanceColor.rgb, paint);
      #endif`,
    )
    shader.fragmentShader = shader.fragmentShader.replace('#include <dithering_fragment>', '#include <dithering_fragment>\n\tgl_FragColor.a = 0.0;')
  }
  m.customProgramCacheKey = () => (lit ? 'traffic-ships-v1' : 'traffic-vehicles-v1')
  return m
}

/**
 * Luces de un mercante de noche (en su marco: a lo largo desde el centro, altura sobre el agua, a
 * estribor): fondeo a proa y a popa, focos de cubierta a los dos costados y ventanas del puente.
 */
function shipLights(kind: number, len: number, put: (along: number, up: number, side: number, r: number, g: number, b: number) => void): void {
  const k = len / BOAT_BASE[kind]
  const D = BOAT_DIMS[kind]
  const deck = D.hull * k
  const hw = D.beam * k * 0.42
  put(len * 0.48, deck + 6 * k, 0, 3.2, 3.1, 2.9)
  put(-len * 0.47, D.mast * k * 0.8, 0, 3.2, 3.1, 2.9)
  for (let t = -0.34; t <= 0.42; t += 22 / len) {
    for (const s of [-1, 1]) put(len * t, deck + 1.5, s * hw, 1.5, 1.15, 0.65)
  }
  // puente: el bloque de la superestructura (modelo: x desde popa)
  const house = kind === 7 ? [214, 33, 16] : kind === 8 ? [18, 28, 17] : [17, 27, 14]
  const along = (house[0] / BOAT_BASE[kind] - 0.5) * len
  const face = along + (kind === 7 ? 8 : 12) * k
  for (let row = 0; row < 4; row++) {
    for (let c = -2; c <= 2; c++) put(face, deck + (house[1] - D.hull - 2 - row * 4.5) * k, c * house[2] * 0.35 * k, 1.3, 1.1, 0.75)
  }
}

/** Puntos de luz con tamaño mínimo en píxeles (como AircraftLights). */
function makeLightMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { viewportH: { value: 720 }, gain: { value: 0.1 } },
    vertexShader: /* glsl */ `
      attribute vec3 lampColor;
      attribute vec2 lampSize;
      uniform float viewportH;
      uniform float gain;
      varying vec3 vColor;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        vColor = lampColor * gain;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        float px = lampSize.x * projectionMatrix[1][1] * 0.5 * viewportH / max(-mvPosition.z, 1e-3);
        gl_PointSize = max(lampColor.r, max(lampColor.g, lampColor.b)) > 0.05 ? max(px, lampSize.y) : 0.0;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      #include <common>
      #include <logdepthbuf_pars_fragment>
      void main() {
        #include <logdepthbuf_fragment>
        vec2 d = gl_PointCoord - 0.5;
        if (dot(d, d) > 0.25) discard;
        gl_FragColor = vec4(vColor, 0.0);
      }`,
    blending: NoBlending,
    depthWrite: true,
    depthTest: true,
  })
}
