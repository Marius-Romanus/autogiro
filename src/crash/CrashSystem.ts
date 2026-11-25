// Orquesta el accidente: cuando el modelo de vuelo detecta un fallo estructural
// (o un choque con un obstáculo), convierte el autogiro en el despiece físico de
// src/sim/wreck, monta a su alrededor el suelo y los obstáculos reales del
// escenario como colisionadores, y cada fotograma sincroniza piezas, efectos,
// sonido y el estado del aparato (para cámara, sonido de motor/rotor y sombras).

import { Box3, Color, Matrix4, Mesh, Quaternion, Raycaster, Sphere, Vector3, type BufferGeometry, type Camera, type DirectionalLight, type LightProbe, type Object3D, type WebGLRenderer, type Scene } from 'three'
import type { Autogyro, CrashInfo } from '../sim/autogyro.ts'
import { propCoeffs } from '../sim/airframes.ts'
import { CG } from '../sim/autogyro.ts'
import { t } from '../i18n.ts'
import { loadRapier, rapierReady, Wreck, WRECK_DT, type Impact } from '../sim/wreck/Wreck.ts'
import { fallbackShapes } from '../sim/wreck/shapes.ts'
import { GENERIC_WRECK, makePartDefs, type PartDef, type WreckSpec } from '../sim/wreck/parts.ts'
import { WreckModel } from '../aircraft/WreckModel.ts'
import type { AircraftView } from '../aircraft/AircraftView.ts'
import { CrashFx } from '../fx/CrashFx.ts'
import { CrashAudio, type ImpactKind } from '../audio/CrashAudio.ts'
import { wireStrike, type Pose } from './wireStrike.ts'
import { WaterFx } from '../fx/WaterFx.ts'
import type { WetPart } from '../sim/wreck/Wreck.ts'

/** Lo que el sistema necesita saber del escenario. */
export interface CrashWorld {
  /** 'google': las teselas 3D ya son el suelo; 'terrain': relieve + edificios aparte */
  mode: 'google' | 'terrain'
  /** altura del suelo (Y mundo) en (x, z), o null si no hay datos */
  heightAt(x: number, z: number): number | null
  /** mallas con las que se puede chocar (teselas, edificios…) */
  meshes(): Iterable<Mesh>
  /** ¿hay un edificio o la copa de un árbol en este punto? (si el escenario lo sabe sin rayos) */
  obstacleAt?(p: Vector3): 'building' | 'bridge' | 'pylon' | 'tree' | 'vehicle' | null
  /** tramos de cable de los tendidos (mundo: x0, y0, z0, x1, y1, z1…) a menos de r del punto */
  wiresNear?(p: Vector3, r: number, out: number[]): void
  /** ¿está el punto dentro de la copa de un árbol? */
  inFoliage?: (p: Vector3) => boolean
  /**
   * Profundidad del agua en (x, z) (m; 0 en tierra). Donde hay agua, `heightAt` es su superficie y el
   * suelo de los restos es el fondo, la profundidad más abajo.
   */
  waterAt?(x: number, z: number): number
  /** rayo contra el escenario (para obstáculos al vuelo) */
  raycast?(origin: Vector3, dir: Vector3, far: number): { point: Vector3; normal: Vector3 | null; distance: number } | null
}

export interface AircraftState {
  pos: Vector3
  quat: Quaternion
  vel: Vector3
  omega: Vector3
}

// (con tres palas de rotor, para que también estén las del Cierva)
const DEFS = new Map<string, PartDef>(makePartDefs({ ...GENERIC_WRECK, blades: 3 }).map((d) => [d.id, d]))
/**
 * Incendio del depósito según la deceleración máxima en el asiento (g, promedio de
 * 50 ms): por debajo de FIRE_G0 nunca, por encima de FIRE_G1 siempre, y en medio
 * con probabilidad lineal. Son impactos que aplastan la célula: una toma dura que
 * rompe el tren se queda en 10-25 g; los incendios tras el choque son raros salvo
 * en los más violentos.
 */
const FIRE_G0 = 35
const FIRE_G1 = 65
const _pv = new Vector3()
// colores en sRGB, como la ortofoto (Color los pasa a lineal)
const SOIL = new Color(0x9a8670)
const CONCRETE = new Color(0xa9a59d)
const _v = new Vector3()
const _v2 = new Vector3()
const _q = new Quaternion()
const _m = new Matrix4()

interface Agg {
  part: string
  impulse: number
  best: Impact
  approach: number
  slide: number
}

export class CrashSystem {
  readonly model = new WreckModel()
  readonly fx = new CrashFx()
  readonly audio = new CrashAudio()
  /** salpicaduras, espuma, estelas y burbujas (también las del aparato en vuelo: `updateWater`) */
  readonly waterFx: WaterFx
  private readonly camPos = new Vector3()
  private wetList: WetPart[] = []
  private readonly lastFoam = new Map<string, number>()
  wreck: Wreck | null = null
  /** origen del marco local del accidente (mundo) */
  readonly origin = new Vector3()
  private world: CrashWorld | null = null
  private acc = 0
  private elapsed = 0
  private still = 0
  timeScale = 1
  private info: CrashInfo | null = null
  private obstacleMeshes: Mesh[] = []
  private lastDust = new Map<string, number>()
  private hint: HTMLDivElement
  private engineOffT = 0.5
  private readonly scene: Object3D
  /** ya ha sonado el golpe principal */
  private bigHit = false
  /** momento (s de accidente) en que revienta el depósito; <0: no */
  private explodeAt = -1
  private exploded = false
  /** fuego tras la explosión, 0..1 */
  private fire = 0
  /** tirada de este accidente para el incendio (0..1) */
  private fireRoll = 1
  private readonly podV = new Vector3()
  private podVSet = false

  private readonly lights: { sun: DirectionalLight; sky: LightProbe } | null

  constructor(scene: Object3D, lights?: { sun: DirectionalLight; sky: LightProbe }) {
    this.scene = scene
    this.lights = lights ?? null
    scene.add(this.fx.root)
    this.waterFx = new WaterFx(scene, lights)
    this.waterFx.sound = (strength, p) => this.audio.impact('water', strength, this.camPos.distanceTo(p), 'water')
    void loadRapier().catch((e) => console.warn('No se pudo cargar Rapier (física de accidentes):', e))
    // (aspecto en src/style.css, .crash-hint)
    this.hint = document.createElement('div')
    this.hint.className = 'crash-hint'
    this.hint.style.display = 'none'
    document.body.appendChild(this.hint)
    window.addEventListener('keydown', (e) => {
      if (!this.wreck || e.repeat) return
      if (e.code === 'KeyJ') {
        this.timeScale = this.timeScale === 1 ? 0.2 : 1
        this.updateHint()
      }
    })
  }

  get ready(): boolean {
    return rapierReady()
  }
  get active(): boolean {
    return this.wreck !== null
  }

  /** Trocea el modelo en cuanto está cargado (llamar cada fotograma; solo trabaja una vez por modelo). */
  prepare(view: AircraftView, renderer?: WebGLRenderer, camera?: Camera): void {
    if (this.model.needsPrepare(view)) {
      const t0 = performance.now()
      this.model.prepare(view)
      console.info(`Despiece del modelo para accidentes: ${(performance.now() - t0).toFixed(0)} ms`)
    }
    // compila de antemano los programas de los efectos (en una gráfica integrada
    // compilar en el momento del choque da un tirón)
    if (!this.warmed && renderer && camera) {
      this.warmed = true
      void renderer.compileAsync(this.fx.root, camera, this.scene as Scene).catch(() => {})
    }
  }
  private warmed = false

  // ---------------------------------------------------------------------------
  // Obstáculos al vuelo: palas, morro y cola contra edificios/árboles
  // ---------------------------------------------------------------------------
  private probeFlip = 0
  /** Comprueba si el disco del rotor o los extremos del aparato tocan un obstáculo. */
  probe(ac: Autogyro, world: CrashWorld, from: Pose | null = null): CrashInfo | null {
    if (ac.onGround && ac.groundSpeed < 2) return null
    // cables de los tendidos: el movimiento del fotograma contra el disco, la hélice y la célula
    if (world.wiresNear) {
      const segs: number[] = []
      world.wiresNear(ac.pos, ac.rotor.p.radius + 6 + ac.vel.length() * 0.05, segs)
      const hit = segs.length ? wireStrike(ac, segs, from) : null
      if (hit) {
        const what = t('obj.wire')
        const kmh = Math.round(ac.tas * 3.6)
        if (hit === 'rotor') return { cause: 'obstacle', title: t('crash.bladesHit', { what }), detail: t('crash.wire.rotor', { kmh }) }
        if (hit === 'prop') return { cause: 'obstacle', title: t('crash.wire.prop.title'), detail: t('crash.wire.prop', { kmh }) }
        return { cause: 'obstacle', title: t('crash.collisionWith', { what }), detail: t('crash.wire.body', { kmh }) }
      }
    }
    const pts: Vector3[] = []
    const hub = _v.copy(ac.hubBody).applyQuaternion(ac.quat).add(ac.pos)
    const n = ac.rotor.normal
    const a = _v2.set(1, 0, 0).applyQuaternion(ac.quat)
    a.addScaledVector(n, -a.dot(n)).normalize()
    const b = new Vector3().crossVectors(n, a)
    if (world.obstacleAt) {
      for (let k = 0; k < 8; k++) {
        const ang = (k / 8) * Math.PI * 2
        pts.push(hub.clone().addScaledVector(a, Math.cos(ang) * 4.1).addScaledVector(b, Math.sin(ang) * 4.1))
      }
      for (const p of [new Vector3(2.1, -0.4, 0), new Vector3(-3.9, 0.4, 0), new Vector3(-0.4, -0.8, 1.05), new Vector3(-0.4, -0.8, -1.05)])
        pts.push(p.sub(CG).applyQuaternion(ac.quat).add(ac.pos))
      for (const p of pts) {
        const kind = world.obstacleAt(p)
        if (kind) {
          const rotor = p.distanceTo(hub) > 3.5
          const what = t(`obj.${kind}`)
          return {
            cause: 'obstacle',
            title: t(rotor ? 'crash.bladesHit' : 'crash.collisionWith', { what }),
            detail: t(rotor ? 'crash.bladesHit.detail' : 'crash.obstacle.hit', { what, kmh: Math.round(ac.tas * 3.6) }),
          }
        }
      }
    }
    if (world.raycast && ac.agl < 120 && ac.rotor.rpm > 60) {
      // dos radios del disco por fotograma (alternando)
      this.probeFlip = (this.probeFlip + 1) % 2
      for (const s of this.probeFlip ? [1, -1] : []) {
        const dir = a.clone().multiplyScalar(s)
        const hit = world.raycast(hub, dir, 4.15)
        if (hit) return this.obstacleInfo(ac, true)
      }
      for (const s of this.probeFlip ? [] : [1, -1]) {
        const dir = b.clone().multiplyScalar(s)
        const hit = world.raycast(hub, dir, 4.15)
        if (hit) return this.obstacleInfo(ac, true)
      }
    }
    return null
  }

  private obstacleInfo(ac: Autogyro, rotor: boolean): CrashInfo {
    return {
      cause: 'obstacle',
      title: t(rotor ? 'crash.bladesObstacle' : 'crash.obstacle.title'),
      detail: t('crash.bladesObstacle.detail', { kmh: Math.round(ac.tas * 3.6) }),
    }
  }

  // ---------------------------------------------------------------------------
  // Inicio del accidente
  // ---------------------------------------------------------------------------
  /**
   * Arranca la simulación del accidente. `from` = estado del aparato antes del
   * choque (para obstáculos: se rebobina al principio del fotograma, para que el
   * golpe ocurra de verdad en la simulación). Devuelve false si no hay física.
   */
  begin(ac: Autogyro, view: AircraftView, world: CrashWorld, rho: number, wind: Vector3, from: AircraftState | null, extraBreak: string[] = []): boolean {
    if (!this.ready || !ac.crash) return false
    this.reset(false)
    this.prepare(view)
    this.world = world
    this.info = ac.crash
    const st: AircraftState = from ?? { pos: ac.pos, quat: ac.quat, vel: ac.vel, omega: ac.omega }
    this.origin.copy(st.pos)
    // (en el agua, el fondo: los restos no se suben por encima de la superficie)
    const local = (x: number, z: number) => {
      const h = world.heightAt(x + this.origin.x, z + this.origin.z)
      const d = h === null ? 0 : (world.waterAt?.(x + this.origin.x, z + this.origin.z) ?? 0)
      return h === null ? null : h - this.origin.y - (d > 0 ? d : 0)
    }
    let shapes = this.model.shapes(view)
    if (!shapes) {
      const qi = st.quat.clone().invert()
      shapes = fallbackShapes(ac.rotor.normal.clone().applyQuaternion(qi), new Vector3(1, 0, 0), 0, ac.noseSteer, ac.hubBody.clone().add(CG), wreckSpecOf(ac))
    }
    const cause = ac.crash.cause
    const preBreak: string[] = [...extraBreak]
    if (cause === 'gear') preBreak.push(/izquierda/.test(ac.crash.part ?? '') ? 'gearL' : 'gearR')
    if (cause === 'nose') preBreak.push('noseFork')
    if (cause === 'flapping') preBreak.push('rotor')
    const rpm2rad = (2 * Math.PI) / 60
    const gear = ac.af.engine.gear
    const propOmega = (ac.engineRpm / gear) * rpm2rad
    const crankOmega = Math.max(50, ac.engineRpm * rpm2rad)
    this.engineOffT = 0.5
    try {
      this.wreck = new Wreck({
        pos: new Vector3().subVectors(st.pos, this.origin),
        quat: st.quat.clone(),
        vel: st.vel.clone(),
        omegaBody: st.omega.clone(),
        rotorOmega: ac.rotor.omega,
        propOmega: ac.engineOn || ac.engineRpm > 200 ? propOmega : 0,
        propTorque: ac.engineOn ? Math.min(400 * (ac.af.engine.torquePeak / 128), (ac.enginePower / crankOmega) * gear) : 0,
        mass: ac.mass,
        rho,
        wind,
        shapes,
        preBreak,
        rotorKick: cause === 'flapping',
        heightAt: local,
        spec: wreckSpecOf(ac),
      })
    } catch (e) {
      console.warn('No se pudo crear la simulación del accidente:', e)
      this.wreck = null
      return false
    }
    this.wreck.obstacleColor = (p, n) => this.obstacleColor(p, n)
    if (world.inFoliage) {
      const f = world.inFoliage
      const q = new Vector3()
      this.wreck.foliage = (p) => f(q.copy(p).add(this.origin))
    }
    this.buildEnvironment(true)
    this.model.build(this.scene, view)
    this.fx.wind.copy(wind)
    this.acc = 0
    this.elapsed = 0
    this.still = 0
    this.timeScale = 1
    this.updateHint()
    ;(ac.rotor as { thrust: number }).thrust = 0
    ac.rotor.teeterHit = 0
    ac.warnings.length = 0
    return true
  }

  /** Suelo (campo de alturas) y obstáculos (malla de triángulos) alrededor del punto (mundo). */
  private buildEnvironment(first: boolean): void {
    const w = this.wreck!
    const world = this.world!
    const c = first ? this.origin.clone() : this.podWorld(new Vector3())
    const lx = c.x - this.origin.x
    const lz = c.z - this.origin.z
    if (world.mode === 'terrain' || first) {
      // en modo Google el suelo son las propias teselas; el campo de alturas queda
      // como red de seguridad medio metro por debajo (por si faltan triángulos)
      const drop = world.mode === 'google' ? 0.5 : 0
      const cache = new Map<string, number | null>()
      // (en el agua, el suelo es el fondo; la superficie va aparte)
      const water = new Map<string, number | null>()
      const sample = (x: number, z: number): string => {
        const k = `${x.toFixed(1)},${z.toFixed(1)}`
        if (cache.has(k)) return k
        const h = world.heightAt(x + this.origin.x, z + this.origin.z)
        const d = h === null ? 0 : (world.waterAt?.(x + this.origin.x, z + this.origin.z) ?? 0)
        cache.set(k, h === null ? null : h - this.origin.y - drop - (d > 0 ? d : 0))
        water.set(k, h !== null && d > 0 ? h - this.origin.y : null)
        return k
      }
      const size = world.mode === 'google' ? 96 : 128
      const cells = world.mode === 'google' ? 24 : 64
      w.setGround((x, z) => cache.get(sample(x, z))!, lx, lz, size, cells)
      if (world.waterAt) w.setWater((x, z) => water.get(sample(x, z)) ?? null, lx, lz, size, cells)
    }
    const tris = this.collectTriangles(world, c, 55, 45)
    w.setObstacles(tris, lx, lz)
  }

  /** Triángulos de las mallas del escenario dentro de la caja (coordenadas locales del accidente). */
  private collectTriangles(world: CrashWorld, center: Vector3, half: number, halfY: number): Float32Array | null {
    const box = new Box3(new Vector3(center.x - half, center.y - halfY, center.z - half), new Vector3(center.x + half, center.y + halfY, center.z + half))
    const out: number[] = []
    const used: Mesh[] = []
    const sph = new Sphere()
    const local = new Box3()
    const inv = new Matrix4()
    const a = new Vector3()
    const b = new Vector3()
    const cc = new Vector3()
    const MAX = 90000 * 9
    const o = this.origin
    for (const m of world.meshes()) {
      if (out.length >= MAX) break
      if (!m.visible || !visibleChain(m)) continue
      const g = m.geometry as BufferGeometry & { boundsTree?: any }
      if (!g.boundingSphere) g.computeBoundingSphere()
      sph.copy(g.boundingSphere!).applyMatrix4(m.matrixWorld)
      if (!box.intersectsSphere(sph)) continue
      used.push(m)
      const mw = m.matrixWorld
      inv.copy(mw).invert()
      local.copy(box).applyMatrix4(inv)
      const push = (va: Vector3, vb: Vector3, vc: Vector3) => {
        a.copy(va).applyMatrix4(mw)
        b.copy(vb).applyMatrix4(mw)
        cc.copy(vc).applyMatrix4(mw)
        out.push(a.x - o.x, a.y - o.y, a.z - o.z, b.x - o.x, b.y - o.y, b.z - o.z, cc.x - o.x, cc.y - o.y, cc.z - o.z)
      }
      if (g.boundsTree) {
        g.boundsTree.shapecast({
          intersectsBounds: (bx: Box3) => bx.intersectsBox(local),
          intersectsTriangle: (tri: { a: Vector3; b: Vector3; c: Vector3 }) => {
            if (out.length < MAX) push(tri.a, tri.b, tri.c)
            return false
          },
        })
      } else {
        const pos = g.getAttribute('position')
        if (!pos) continue
        const idx = g.getIndex()
        const n = idx ? idx.count : pos.count
        const va = new Vector3()
        const vb = new Vector3()
        const vc = new Vector3()
        for (let i = 0; i + 2 < n && out.length < MAX; i += 3) {
          va.fromBufferAttribute(pos as any, idx ? idx.getX(i) : i)
          vb.fromBufferAttribute(pos as any, idx ? idx.getX(i + 1) : i + 1)
          vc.fromBufferAttribute(pos as any, idx ? idx.getX(i + 2) : i + 2)
          if (Math.max(va.x, vb.x, vc.x) < local.min.x || Math.min(va.x, vb.x, vc.x) > local.max.x) continue
          if (Math.max(va.y, vb.y, vc.y) < local.min.y || Math.min(va.y, vb.y, vc.y) > local.max.y) continue
          if (Math.max(va.z, vb.z, vc.z) < local.min.z || Math.min(va.z, vb.z, vc.z) > local.max.z) continue
          push(va, vb, vc)
        }
      }
    }
    this.obstacleMeshes = used
    return out.length ? new Float32Array(out) : null
  }

  /** Color de los cascotes: el de la textura/material del obstáculo en ese punto. */
  private ray = new Raycaster()
  private probeCanvas: CanvasRenderingContext2D | null = null
  private obstacleColor(pLocal: Vector3, n: Vector3): { color: number; glass: number } {
    const p = _v.copy(pLocal).add(this.origin)
    const wall = Math.abs(n.y) < 0.6
    const h = this.world?.heightAt(p.x, p.z)
    const glass = wall && h !== null && h !== undefined && p.y - h > 1.2 ? 0.28 : 0.04
    let color = 0x9c958b
    try {
      this.ray.set(_v2.copy(p).addScaledVector(n, 0.4), n.clone().negate())
      this.ray.far = 1.2
      const hits = this.ray.intersectObjects(this.obstacleMeshes, false)
      const hit = hits[0]
      if (hit) {
        const mat = (Array.isArray((hit.object as Mesh).material) ? ((hit.object as Mesh).material as any)[0] : (hit.object as Mesh).material) as any
        const img = mat?.map?.image
        if (img && hit.uv && (img.width ?? 0) > 0) {
          if (!this.probeCanvas) {
            const c = document.createElement('canvas')
            c.width = c.height = 1
            this.probeCanvas = c.getContext('2d', { willReadFrequently: true })
          }
          const g = this.probeCanvas!
          const u = ((hit.uv.x % 1) + 1) % 1
          const v = ((hit.uv.y % 1) + 1) % 1
          const flip = mat.map.flipY !== false
          g.drawImage(img, Math.floor(u * img.width), Math.floor((flip ? 1 - v : v) * img.height), 1, 1, 0, 0, 1, 1)
          const d = g.getImageData(0, 0, 1, 1).data
          color = (d[0] << 16) | (d[1] << 8) | d[2]
        } else if (mat?.color) color = mat.color.getHex()
      }
    } catch {
      // textura no legible (comprimida): color genérico
    }
    return { color, glass }
  }

  // ---------------------------------------------------------------------------
  // Cada fotograma
  // ---------------------------------------------------------------------------
  update(dt: number, ac: Autogyro, camera: Camera): void {
    const w = this.wreck
    if (!w) return
    this.elapsed += dt
    this.acc += dt * this.timeScale
    let n = 0
    while (this.acc >= WRECK_DT && n < 40) {
      w.step()
      this.acc -= WRECK_DT
      n++
    }
    if (n >= 40) this.acc = 0
    const simDt = n * WRECK_DT

    // escenario alrededor de los restos
    const pod = this.podWorld(new Vector3())
    const gc = _v.copy(w.groundCenter).add(this.origin)
    if (Math.hypot(pod.x - gc.x, pod.z - gc.z) > 30) this.buildEnvironment(false)
    else {
      const oc = _v.copy(w.obstacleCenter).add(this.origin)
      if (Math.hypot(pod.x - oc.x, pod.z - oc.z) > 25) this.w_obstacles(pod)
    }

    this.camPos.copy(camera.position)
    this.mainHit(camera)
    this.effects(camera)
    this.fuelFire(dt, camera)
    this.waterEffects(dt)

    // piezas
    this.model.update(dt, (id, pos, quat) => {
      if (!w.partPose(id, pos, quat)) return false
      pos.add(this.origin)
      return true
    })
    const ground = (x: number, z: number) => this.world?.heightAt(x, z) ?? null
    if (this.lights) {
      const { sun, sky } = this.lights
      const sunDir = _v.copy(sun.position).sub(sun.target.position).normalize()
      const sunIrr = new Vector3(sun.color.r, sun.color.g, sun.color.b).multiplyScalar(sun.intensity * Math.max(0, 0.35 + 0.65 * sunDir.y))
      const skyIrr = sky.sh.getIrradianceAt(new Vector3(0, 1, 0), new Vector3()).multiplyScalar(sky.intensity)
      this.fx.setLight(sunIrr, skyIrr)
    }
    this.fx.update(dt, camera, w.chunks, this.origin, ground)

    // estado del aparato para cámara, sombras y sonido
    w.partPose('pod', _v, _q)
    ac.quat.copy(_q)
    ac.pos.copy(CG).applyQuaternion(_q).add(_v).add(this.origin)
    w.partVelocity('pod', ac.vel, _v2)
    ac.omega.copy(_v2).applyQuaternion(_q.clone().invert())
    // vueltas del rotor (para el sonido): las del disco si sigue en la cabeza; si
    // se ha soltado, el buje rueda por el suelo y sus "vueltas" no son las del rotor
    ac.rotor.omega = w.jointIntact('rotor') ? w.rotorOmega() : ac.rotor.omega * Math.exp(-simDt * 1.5)
    ;(ac.rotor as { thrust: number }).thrust = 0
    this.engineOffT -= simDt
    ac.engineRpm = (w.propOmega() * ac.af.engine.gear * 60) / (2 * Math.PI)
    ac.enginePower = 0
    if (this.engineOffT <= 0) ac.engineOn = false
    ac.tas = ac.vel.length()
    ac.groundSpeed = Math.hypot(ac.vel.x, ac.vel.z)
    ac.onGround = true
    ac.wheelRolling = 0
    ac.gLoad = 1

    // ¿se ha parado todo?
    const m = w.podMotion()
    if (m.v < 0.25 && m.w < 0.35) this.still += dt
    else this.still = 0
  }

  /** Solo la malla de obstáculos (más barata que el suelo). */
  private w_obstacles(center: Vector3): void {
    const w = this.wreck!
    const tris = this.collectTriangles(this.world!, center, 55, 45)
    w.setObstacles(tris, center.x - this.origin.x, center.z - this.origin.z)
  }

  private podWorld(out: Vector3): Vector3 {
    const w = this.wreck!
    w.partPose('pod', out, _q)
    return out.add(_v2.copy(CG).applyQuaternion(_q)).add(this.origin)
  }

  /** Polvo, tierra, chispas, surcos, abolladuras y sonido a partir de los contactos. */
  private effects(camera: Camera): void {
    const w = this.wreck!
    // agrupa los contactos de los pasos de este fotograma por pieza
    const agg = new Map<string, Agg>()
    for (const im of w.impacts) {
      let a = agg.get(im.part)
      if (!a) agg.set(im.part, (a = { part: im.part, impulse: 0, best: im, approach: 0, slide: 0 }))
      a.impulse += im.impulse
      a.approach = Math.max(a.approach, im.approach)
      a.slide = Math.max(a.slide, im.slide)
      if (im.impulse > a.best.impulse) a.best = im
    }
    w.impacts.length = 0
    const now = this.elapsed
    let scrapeV = 0
    let scrapeLoad = 0
    let scrapeMetal = false
    let scrapeDist = 1e9
    let tumble = 0
    let tumbleDist = 1e9
    for (const a of agg.values()) {
      const d = DEFS.get(a.part)
      if (!d) continue
      const im = a.best
      const pW = _v.copy(im.point).add(this.origin)
      const dist = camera.position.distanceTo(pW)
      const ref = 8 * d.mass + 40
      const s = a.impulse / ref
      const ground = im.surface === 'ground' || (im.surface === 'obstacle' && im.normal.y > 0.75)
      const wall = im.surface === 'obstacle' && !ground
      const isBlade = /^blade|^prop\d/.test(a.part)
      if (im.surface === 'water') {
        const key = `w-${a.part}`
        const last = this.lastDust.get(key) ?? -1
        const vel = _v2.copy(im.tangent).multiplyScalar(a.slide)
        vel.y = -a.approach
        const size = isBlade ? 0.35 : Math.min(2.2, 0.35 + Math.cbrt(d.mass / 60))
        if (a.approach > 1.2 && now - last > 0.6) {
          // golpe: corona, nube y anillo de espuma (y su ruido)
          this.lastDust.set(key, now)
          this.waterFx.splash(pW, vel, size, isBlade ? 0.6 : 1)
        } else if (a.slide > 3) {
          // corre por el agua: rociones y estela
          this.waterFx.spray(pW, vel, Math.min(2, a.slide / 8) * size, 1 / 20)
          this.waterFx.wake(key, pW, vel, size)
        }
        continue
      }
      if (im.surface === 'foliage') {
        // hojas y ramitas
        const last = this.lastDust.get(`f-${a.part}`) ?? -1
        if (a.slide > 3 && now - last > 0.1) {
          this.lastDust.set(`f-${a.part}`, now)
          this.fx.leaves(pW, im.tangent, a.slide, Math.min(16, Math.round(2 + a.slide / (isBlade ? 8 : 3))))
          this.audio.impact('foliage', Math.min(1.2, 0.2 + a.slide / 30), dist, `f-${a.part}`)
        }
        continue
      }
      // traqueteo continuo con todos los contactos que se mueven; golpe suelto
      // solo con los fuertes (CrashAudio deja pasar los que destacan)
      // (un contacto que solo sostiene el peso no suena: cuenta el movimiento)
      const moving = Math.min(1, Math.max(0, a.slide + a.approach - 0.3) / 3)
      if (moving > 0) {
        tumble += Math.min(1, s) * moving * (/^wheel/.test(a.part) ? 0.3 : 1)
        tumbleDist = Math.min(tumbleDist, dist)
      }
      if (a.approach > 2 || s > 0.4) {
        const kind: ImpactKind = d.material === 'rubber' ? 'rubber' : d.material === 'metal' ? 'metal' : 'composite'
        if (im.surface === 'ground') this.audio.impact('ground', Math.min(1.5, s * 1.2 + a.approach * 0.06), dist, `g-${a.part}`)
        else if (im.surface === 'obstacle') this.audio.impact('masonry', Math.min(1.5, s + a.approach * 0.05), dist, `o-${a.part}`)
        this.audio.impact(kind, Math.min(1.4, s + a.approach * 0.05), dist, a.part)
        if (wall && a.approach > 4 && Math.random() < 0.6) this.audio.impact('glass', 0.6, dist, 'glass')
      }
      // polvo y tierra
      if (ground || wall) {
        const last = this.lastDust.get(a.part) ?? -1
        const amount = Math.min(2, s + a.slide / 18 + a.approach / 10)
        const moving = a.slide > 1.2 || a.approach > 0.8
        if (moving && ((amount > 0.08 && now - last > (a.slide > 2 ? 0.11 : 0.25)) || (amount > 0.6 && now - last > 0.05))) {
          this.lastDust.set(a.part, now)
          this.fx.dustBurst(pW, im.normal, amount, wall ? CONCRETE : SOIL, _v2.copy(im.tangent).multiplyScalar(a.slide))
          if (ground && im.surface === 'ground') {
            const gy = pW.y
            if (isBlade && a.slide > 8) this.fx.dirt(pW, im.normal, im.tangent, a.slide, Math.min(14, Math.round(2 + a.slide / 10)), gy)
            else if (s > 0.25) this.fx.dirt(pW, im.normal, im.tangent, Math.max(2, a.slide), Math.min(16, Math.round(3 + s * 8)), gy)
          }
        }
        // chispas: metal contra superficies duras
        if (wall && d.material === 'metal' && a.slide > 4) this.fx.sparksAt(pW, im.tangent, Math.min(18, Math.round(a.slide / 2)))
        // surcos y desconchones
        const pressure = a.impulse
        const width = a.part === 'pod' ? 0.55 : /^gear|^tail/.test(a.part) ? 0.3 : isBlade ? 0.12 : 0.2
        if (ground && a.slide > 1.2 && pressure > d.mass * 0.05 && !/^wheel/.test(a.part)) this.fx.scar(a.part, pW, im.normal, im.tangent, width, Math.min(1, s), false)
        if (wall && (s > 0.2 || a.slide > 3)) this.fx.scar(`w-${a.part}`, pW, im.normal, im.tangent, Math.max(0.3, width), 0.5, true)
        if (a.slide > scrapeV && a.impulse > d.mass * 0.03 && !/^wheel/.test(a.part)) {
          scrapeV = a.slide
          scrapeLoad = Math.min(1, s * 4)
          scrapeMetal = d.material === 'metal'
          scrapeDist = dist
        }
      }
      // abolladuras
      if (d.dent) {
        const J0 = d.dent.k * 0.025
        if (a.impulse > J0) {
          const depth = Math.min(d.dent.max, (a.impulse - J0) / d.dent.k)
          const dirW = _v2.copy(im.normal)
          this.model.dent(a.part, pW, dirW, depth, d.dent.radius * (0.6 + 1.2 * depth))
        }
      }
    }
    this.audio.setScrape(scrapeV, scrapeLoad, scrapeDist, scrapeMetal)
    this.audio.setTumble(tumble, tumbleDist)
    for (const b of w.breaks) {
      const pW = _v.copy(b.point).add(this.origin)
      const d = DEFS.get(b.id)
      const metal = !d || d.material === 'metal'
      this.audio.snap(Math.min(2, b.ratio), camera.position.distanceTo(pW), metal)
      // (sobre el agua no hay polvo que levantar)
      if (w.waterSurface(b.point.x, b.point.z) === null) this.fx.dustBurst(pW, new Vector3(0, 1, 0), 0.2, CONCRETE, new Vector3())
    }
    w.breaks.length = 0
  }

  /**
   * El golpe principal (una vez): el primer frenazo brusco del fuselaje. Se mide
   * con el salto de su velocidad de un fotograma a otro, que es lo que nota quien
   * va dentro; la velocidad de acercamiento de los contactos ya sale frenada por
   * el solver. Y el depósito: revienta según lo violento del impacto (la
   * deceleración en el asiento), con una tirada por accidente para que entre
   * ~35 g y ~65 g unas veces arda y otras no.
   */
  private mainHit(camera: Camera): void {
    const w = this.wreck!
    w.partVelocity('pod', _pv, _v2)
    const dv = this.podVSet ? _v2.subVectors(_pv, this.podV).length() : 0
    this.podV.copy(_pv)
    this.podVSet = true
    if (!this.bigHit && dv > 2.5) {
      this.bigHit = true
      this.audio.crash(Math.min(30, dv * 1.6), camera.position.distanceTo(this.podWorld(_v2)))
    }
    if (!this.exploded && this.explodeAt < 0 && this.elapsed < 8) {
      const p = Math.min(1, Math.max(0, (w.peakSeatG - FIRE_G0) / (FIRE_G1 - FIRE_G0)))
      if (p > this.fireRoll && w.partWet('pod') < 0.3) this.explodeAt = this.elapsed + 0.15 + Math.random() * 0.35
    }
  }

  /** Explosión del depósito y fuego que queda ardiendo sobre los restos. */
  private fuelFire(dt: number, camera: Camera): void {
    if (this.explodeAt >= 0 && this.elapsed >= this.explodeAt && this.wreck!.partWet('pod') >= 0.3) this.explodeAt = -1
    if (this.explodeAt >= 0 && this.elapsed >= this.explodeAt) {
      this.explodeAt = -1
      this.exploded = true
      this.fire = 1
      const p = this.podWorld(new Vector3())
      this.fx.explode(p)
      this.audio.explosion(camera.position.distanceTo(p))
    }
    if (this.fire <= 0) return
    // arde fuerte un rato y luego se va apagando (~1 min)
    this.fire = Math.max(0, this.fire - dt * (this.fire > 0.6 ? 0.012 : 0.02))
    const p = this.podWorld(new Vector3())
    const gy = this.world?.heightAt(p.x, p.z)
    if (gy != null) p.y = Math.min(p.y, gy + 0.6)
    this.wreck!.partVelocity('pod', _pv)
    this.fx.burn(p, this.fire, dt, _pv)
    this.audio.setFire(this.fire, camera.position.distanceTo(p))
  }

  /** Lo que flota o se hunde: burbujas que suben, espuma alrededor y estela si aún se mueve. */
  private waterEffects(dt: number): void {
    const w = this.wreck!
    const now = this.elapsed
    for (const p of w.wetParts(this.wetList)) {
      const x = p.point.x + this.origin.x
      const z = p.point.z + this.origin.z
      const sy = p.surface + this.origin.y
      _v.set(x, sy, z)
      const depth = p.surface - p.point.y
      // hundiéndose: burbujas (más cuanto más rápido baja y más grande es)
      if (depth > 0.15 && p.vel.y < -0.03) this.waterFx.bubbles(_v, Math.min(1, -p.vel.y * 0.8) * Math.min(1, p.size / 1.5), dt)
      else if (depth > -0.3 && depth < 0.6 && p.size > 0.3) {
        // a flote: de vez en cuando un cerco de espuma alrededor (el agua que lo lame)
        const k = `f-${p.id}`
        if (now - (this.lastFoam.get(k) ?? -10) > 0.9 + Math.random()) {
          this.lastFoam.set(k, now)
          this.waterFx.foam(_v, p.size * 0.4, p.size * 0.6 + 0.6, 3.5, 0.35, 0.6)
        }
      }
      const vh = Math.hypot(p.vel.x, p.vel.z)
      if (vh > 1 && depth > -0.3 && depth < 0.8) this.waterFx.wake(`k-${p.id}`, _v, p.vel, Math.max(0.3, p.size * 0.6))
    }
  }

  /**
   * Agua del aparato en vuelo, cada fotograma (también durante el accidente, para que las gotas y la
   * espuma sigan su curso): chapoteos, estela, rociones y el soplado del rotor sobre el agua.
   * `waterAt`: profundidad (0 en tierra); `surfaceAt`: altura de la superficie.
   */
  updateWater(dt: number, ac: Autogyro, camera: Camera, flying: boolean, wind: Vector3, waterAt: ((x: number, z: number) => number) | null, surfaceAt: (x: number, z: number) => number | null): void {
    this.camPos.copy(camera.position)
    if (flying) this.waterFx.aircraft(dt, ac, waterAt, surfaceAt)
    this.waterFx.update(dt, wind)
  }

  // ---------------------------------------------------------------------------
  /** Todo parado (o pasado un rato): momento de enseñar el resumen. */
  get settled(): boolean {
    return !!this.wreck && (this.still > 2.2 || this.elapsed > 16)
  }

  /** Resumen para el panel de accidente. */
  summary(): { damage: string; seat: string; fire: string } {
    const w = this.wreck
    if (!w) return { damage: '', seat: '', fire: '' }
    const br = w.brokenSummary()
    const g = w.peakSeatG
    const verdict = t(`crash.verdict.${g < 12 ? 0 : g < 25 ? 1 : g < 45 ? 2 : 3}`)
    return {
      damage: br.length ? t('crash.damage', { list: br.join(', ') }) : t('crash.damage.none'),
      seat: t('crash.seat', { g: g.toFixed(0), verdict }),
      fire: this.exploded ? t('crash.fire') : '',
    }
  }

  private updateHint(): void {
    if (!this.wreck) {
      this.hint.style.display = 'none'
      return
    }
    this.hint.style.display = 'block'
    this.hint.textContent = this.timeScale < 1 ? t('crash.slowmo', { s: this.timeScale }) : t('crash.hint')
  }

  /**
   * Quita los restos y vuelve a mostrar el aparato entero. `full`: también la espuma y las gotas
   * (al volver a salir; al empezar un accidente se quedan las del golpe).
   */
  reset(full = true): void {
    if (full) this.waterFx.clear()
    this.lastFoam.clear()
    if (this.wreck) {
      this.wreck.dispose()
      this.wreck = null
    }
    this.model.clear()
    this.fx.clear()
    this.audio.stop()
    this.lastDust.clear()
    this.bigHit = false
    this.explodeAt = -1
    this.exploded = false
    this.fire = 0
    this.fireRoll = Math.random()
    this.podVSet = false
    this.obstacleMeshes = []
    this.info = null
    this.timeScale = 1
    this.updateHint()
  }

  /** Para dar contexto al sonido (se crea al pulsar Volar). */
  attachAudio(ctx: AudioContext | null, out: AudioNode | null): void {
    if (ctx && out) this.audio.attach(ctx, out)
  }
}

function visibleChain(o: Object3D): boolean {
  let p: Object3D | null = o
  while (p) {
    if (!p.visible) return false
    p = p.parent
  }
  return true
}

void _m

/** Rotor y hélice del aparato para el despiece (el resto es el del genérico). */
function wreckSpecOf(ac: Autogyro): WreckSpec {
  const af = ac.af
  const r = af.rotor
  // masa de cada pala a partir de la inercia del rotor (pala uniforme: I = N·m·R²/3)
  const bladeMass = (3 * r.inertia) / (r.blades * r.radius * r.radius)
  return {
    rotorR: r.radius,
    blades: r.blades,
    bladeMass: r.blades > 2 ? Math.min(60, bladeMass * 0.9) : GENERIC_WRECK.bladeMass,
    rotorInertia: r.inertia,
    rotorOmega0: ((af.rpmScale ?? 1) * 352 * 2 * Math.PI) / 60,
    propBlades: af.propBlades ?? 3,
    propR: af.propRadius,
    propCp0: propCoeffs(af).cp0,
    zones: af.wreck,
  }
}
