// Despiece visual del modelo 3D para los accidentes.
//
// Al cargar el aparato se trocea su malla (triángulo a triángulo, por la posición
// de su centroide) en las mismas piezas que usa la física (src/sim/wreck/parts.ts):
// góndola, mástil, cola, patas del tren, horquilla, ruedas, buje y tramos de pala
// del rotor, buje y palas de la hélice. Los bordes de corte quedan dentados, como
// una fractura. De cada pieza se guardan también nubes de puntos para los cascos
// convexos de colisión, así que la física choca con la forma real del modelo.
//
// En el accidente cada pieza se coloca con el sólido de Rapier que la lleva, y los
// golpes abollan la malla (hundimiento suave alrededor del punto de impacto).

import { BufferAttribute, BufferGeometry, Group, Matrix3, Matrix4, Mesh, Object3D, Quaternion, Vector3, type Material } from 'three'
import type { AircraftView } from './AircraftView.ts'
import { BLADE_CUTS, BLADE_SIDES, bladeCuts, classifyAirframe, GENERIC_ZONES, PROP_HUB_R, type PartGroup, type WreckZones } from '../sim/wreck/parts.ts'
import type { PartShapes, WheelShape } from '../sim/wreck/shapes.ts'
import { GEOM } from '../sim/autogyro.ts'

interface PieceSrc {
  part: string
  group: PartGroup
  /** geometría en coordenadas del grupo (nodo del GLB) */
  geometry: BufferGeometry
  material: Material | Material[]
  source: Mesh
  sourceNode: string
}

interface LiveMesh {
  mesh: Mesh
  src: PieceSrc
  dirty: boolean
}

const _m = new Matrix4()
const _mi = new Matrix4()
const _v = new Vector3()
const _v2 = new Vector3()
const _q = new Quaternion()

/** Puntos máximos por casco convexo. */
const HULL_PTS = 420

export class WreckModel {
  private pieces: PieceSrc[] = []
  /** nubes de puntos por pieza (coordenadas del grupo) */
  private hullPts = new Map<string, Float32Array[]>()
  private wheelLocal: Partial<Record<'wheelL' | 'wheelR' | 'wheelN', WheelShape>> = {}
  /** dirección de la pala A en el nodo del rotor (con dos palas, el eje de envergadura) */
  private spanAxis = new Vector3(1, 0, 0)
  /** palas y radio del rotor, palas de la hélice y dónde está su disco (del aparato cargado) */
  private rotorBlades = 2
  private cuts = BLADE_CUTS
  private propBlades = 3
  private propZone: { x: number; y: number; z: number; r: number; tractor: boolean } | null = null
  /** zonas del fuselaje del aparato cargado (tren, mástil, cola, tramos de la góndola) */
  private zones: WreckZones = GENERIC_ZONES
  private preparedFor: Object3D | null = null
  /** grupos de la escena del accidente, por pieza */
  private partGroups = new Map<string, Group>()
  private live = new Map<string, LiveMesh[]>()
  private groupMatrix = new Map<PartGroup, Matrix4>()
  readonly root = new Group()
  private view: AircraftView | null = null
  private normalTimer = 0

  constructor() {
    this.root.name = 'wreck'
  }

  get prepared(): boolean {
    return this.preparedFor !== null
  }

  /** Nodo raíz del GLB cargado (o null). */
  private sceneOf(view: AircraftView): Object3D | null {
    return view.model.children[0] ?? null
  }

  needsPrepare(view: AircraftView): boolean {
    return view.loaded && this.sceneOf(view) !== this.preparedFor
  }

  // ---------------------------------------------------------------------------
  // Troceado (una vez por modelo cargado)
  // ---------------------------------------------------------------------------
  prepare(view: AircraftView): void {
    const scene = this.sceneOf(view)
    if (!scene) return
    this.preparedFor = scene
    this.pieces = []
    this.hullPts.clear()
    this.wheelLocal = {}
    view.model.updateMatrixWorld(true)
    const modelInv = new Matrix4().copy(view.model.matrixWorld).invert()
    const p = view.parts
    // nodos de grupo (el nodo original dentro de los pivotes de giro)
    const inner = (o: Object3D | undefined) => {
      if (!o) return null
      const spin = o.children.find((c) => /_spin$/.test(c.name))
      return spin?.children[0] ?? o
    }
    const groupNodes: Array<[PartGroup, Object3D | null]> = [
      ['rotor', inner(p.rotor)],
      ['prop', inner(p.prop)],
      ['wheelL', p.wheel_L ?? null],
      ['wheelR', p.wheel_R ?? null],
      ['wheelN', p.nose_wheel ?? null],
    ]
    const owner = new Map<Mesh, { group: PartGroup; node: Object3D | null; top: string }>()
    scene.traverse((o) => {
      const m = o as Mesh
      if (!m.isMesh) return
      const g = m.geometry
      if (!g || (g as any).type === 'RingGeometry' || (g as any).type === 'CircleGeometry') return // discos de desenfoque
      let group: PartGroup = 'airframe'
      let node: Object3D | null = null
      for (const [gid, n] of groupNodes) {
        if (n && isDescendant(m, n)) {
          group = gid
          node = n
          break
        }
      }
      // nombre del nodo de primer nivel (airframe, pilot_front, rudder…)
      let top: Object3D = m
      while (top.parent && top.parent !== scene) top = top.parent
      owner.set(m, { group, node, top: top.name })
    })

    // ruedas: centro y radio a partir de los triángulos de goma
    for (const [gid, n] of groupNodes) {
      if (!n || !gid.startsWith('wheel')) continue
      const nInv = new Matrix4().copy(n.matrixWorld).invert()
      const mn = new Vector3(Infinity, Infinity, Infinity)
      const mx = new Vector3(-Infinity, -Infinity, -Infinity)
      const mnAll = mn.clone()
      const mxAll = mx.clone()
      for (const [m, o] of owner) {
        if (o.node !== n) continue
        _m.multiplyMatrices(nInv, m.matrixWorld)
        const rubber = matNames(m).some((s) => /rubber|tire|tyre/i.test(s))
        forEachVertex(m.geometry, _m, (x, y, z) => {
          mnAll.min(_v.set(x, y, z))
          mxAll.max(_v)
          if (rubber) {
            mn.min(_v)
            mx.max(_v)
          }
        })
      }
      const lo = Number.isFinite(mn.x) ? mn : mnAll
      const hi = Number.isFinite(mn.x) ? mx : mxAll
      if (!Number.isFinite(lo.x)) continue
      const c = lo.clone().add(hi).multiplyScalar(0.5)
      this.wheelLocal[gid as 'wheelL'] = {
        center: c,
        radius: Math.max(0.08, (hi.y - lo.y) / 2),
        halfWidth: Math.max(0.03, (hi.z - lo.z) / 2),
        axis: new Vector3(0, 0, 1),
      }
    }

    // rotor: eje de envergadura (el más largo en el plano del disco)
    const vis = view.vis
    this.zones = vis.wreck ?? GENERIC_ZONES
    this.rotorBlades = vis.rotorBlades
    this.cuts = bladeCuts(vis.rotorR)
    this.propBlades = vis.propBlades
    const propNode = p.prop
    this.propZone = propNode
      ? { x: propNode.position.x, y: propNode.position.y, z: propNode.position.z, r: vis.propR, tractor: vis.tractor }
      : null
    const rotorNode = groupNodes[0][1]
    if (rotorNode && this.rotorBlades > 2) {
      // tres palas: la A es la que llega más lejos del eje
      const nInv = new Matrix4().copy(rotorNode.matrixWorld).invert()
      let best = 0
      for (const [m, o] of owner) {
        if (o.node !== rotorNode) continue
        _m.multiplyMatrices(nInv, m.matrixWorld)
        forEachVertex(m.geometry, _m, (x, _y, z) => {
          const r2 = x * x + z * z
          if (r2 > best) {
            best = r2
            this.spanAxis.set(x, 0, z).normalize()
          }
        })
      }
    } else if (rotorNode) {
      const nInv = new Matrix4().copy(rotorNode.matrixWorld).invert()
      let ex = 0
      let ez = 0
      for (const [m, o] of owner) {
        if (o.node !== rotorNode) continue
        _m.multiplyMatrices(nInv, m.matrixWorld)
        forEachVertex(m.geometry, _m, (x, _y, z) => {
          ex = Math.max(ex, Math.abs(x))
          ez = Math.max(ez, Math.abs(z))
        })
      }
      this.spanAxis.set(ex >= ez ? 1 : 0, 0, ex >= ez ? 0 : 1)
    }

    // troceado
    const pts = new Map<string, number[][]>() // pieza → nubes (una por tramo)
    const pushPt = (part: string, slab: number, x: number, y: number, z: number) => {
      let arr = pts.get(part)
      if (!arr) pts.set(part, (arr = []))
      ;(arr[slab] ??= []).push(x, y, z)
    }
    for (const [m, o] of owner) {
      const frame = o.node ? new Matrix4().copy(o.node.matrixWorld).invert() : modelInv
      _m.multiplyMatrices(frame, m.matrixWorld)
      const g = m.geometry
      const pos = g.getAttribute('position') as BufferAttribute
      if (!pos) continue
      const idx = g.getIndex()
      const nTri = idx ? idx.count / 3 : pos.count / 3
      const local = new Float32Array(pos.count * 3)
      for (let i = 0; i < pos.count; i++) {
        _v.fromBufferAttribute(pos, i).applyMatrix4(_m)
        local[i * 3] = _v.x
        local[i * 3 + 1] = _v.y
        local[i * 3 + 2] = _v.z
      }
      const byPart = new Map<string, number[]>()
      const wheel = o.group.startsWith('wheel') ? this.wheelLocal[o.group as 'wheelL'] : undefined
      for (let t = 0; t < nTri; t++) {
        const a = idx ? idx.getX(t * 3) : t * 3
        const b = idx ? idx.getX(t * 3 + 1) : t * 3 + 1
        const c = idx ? idx.getX(t * 3 + 2) : t * 3 + 2
        const cx = (local[a * 3] + local[b * 3] + local[c * 3]) / 3
        const cy = (local[a * 3 + 1] + local[b * 3 + 1] + local[c * 3 + 1]) / 3
        const cz = (local[a * 3 + 2] + local[b * 3 + 2] + local[c * 3 + 2]) / 3
        const part = this.classify(o.group, o.top, cx, cy, cz, wheel)
        let list = byPart.get(part)
        if (!list) byPart.set(part, (list = []))
        list.push(a, b, c)
      }
      const nrm = new Matrix3().getNormalMatrix(_m)
      for (const [part, tris] of byPart) {
        const geo = subGeometry(g, tris, local, nrm)
        this.pieces.push({ part, group: o.group, geometry: geo, material: m.material, source: m, sourceNode: o.top })
        // puntos para los cascos convexos de colisión
        for (const vi of tris) {
          const x = local[vi * 3]
          const y = local[vi * 3 + 1]
          const z = local[vi * 3 + 2]
          if (part === 'pod') {
            // fuera del disco de la hélice (si no, la hélice chocaría con su propio fuselaje)
            const pz = this.propZone
            if (pz?.tractor) {
              if (x > pz.x - 0.25 && x < pz.x + 0.2 && Math.hypot(y - pz.y, z - pz.z) < pz.r + 0.06) continue
            } else if (x > -1.76 && x < -1.36 && Math.hypot(y - GEOM.prop.y, z - GEOM.prop.z) < GEOM.propRadius + 0.06) continue
            let s = 0
            const slabs = this.zones.podSlabs
            while (s < slabs.length - 2 && x > slabs[s + 1]) s++
            pushPt('pod', s, x, y, z)
          } else pushPt(part, 0, x, y, z)
        }
      }
    }
    for (const [part, clouds] of pts) {
      const out: Float32Array[] = []
      for (const c of clouds) if (c && c.length >= 12) out.push(subsample(c, HULL_PTS))
      this.hullPts.set(part, out)
    }
  }

  private classify(group: PartGroup, top: string, x: number, y: number, z: number, wheel?: WheelShape): string {
    switch (group) {
      case 'airframe':
        return classifyAirframe(x, y, z, top, this.zones)
      case 'rotor': {
        const cuts = this.cuts
        if (this.rotorBlades > 2) {
          // sector de la pala más cercana (ángulo alrededor de +Y, como en la física)
          const r = Math.hypot(x, z)
          if (r < cuts[0]) return 'rotorHub'
          const a0 = Math.atan2(-this.spanAxis.z, this.spanAxis.x)
          const step = (2 * Math.PI) / this.rotorBlades
          let da = Math.atan2(-z, x) - a0
          da = ((da % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
          const i = Math.round(da / step) % this.rotorBlades
          const k = r < cuts[1] ? 0 : r < cuts[2] ? 1 : 2
          return `blade${BLADE_SIDES[i]}${k}`
        }
        const s = this.spanAxis.x ? x : z
        const r = Math.abs(s)
        if (r < cuts[0]) return 'rotorHub'
        const k = r < cuts[1] ? 0 : r < cuts[2] ? 1 : 2
        return `blade${s > 0 ? 'A' : 'B'}${k}`
      }
      case 'prop': {
        const r = Math.hypot(y, z)
        if (r < PROP_HUB_R) return 'propHub'
        // sectores de 360°/palas a partir de "arriba"
        let a = Math.atan2(z, y)
        if (a < 0) a += 2 * Math.PI
        const k = Math.round(a / ((2 * Math.PI) / this.propBlades)) % this.propBlades
        return `prop${k}`
      }
      case 'wheelN': {
        if (wheel && Math.hypot(x - wheel.center.x, y - wheel.center.y) < wheel.radius + 0.01 && Math.abs(z - wheel.center.z) < wheel.halfWidth + 0.02) return 'wheelN'
        return 'noseFork'
      }
      default:
        return group
    }
  }

  // ---------------------------------------------------------------------------
  // Postura en el instante del choque
  // ---------------------------------------------------------------------------
  /** Matrices nodo → modelo de cada grupo, con la postura animada actual. */
  private captureGroupMatrices(view: AircraftView): void {
    view.model.updateMatrixWorld(true)
    const modelInv = new Matrix4().copy(view.model.matrixWorld).invert()
    const p = view.parts
    const inner = (o: Object3D | undefined) => {
      if (!o) return null
      const spin = o.children.find((c) => /_spin$/.test(c.name))
      return spin?.children[0] ?? o
    }
    this.groupMatrix.clear()
    this.groupMatrix.set('airframe', new Matrix4())
    const set = (g: PartGroup, n: Object3D | null) => this.groupMatrix.set(g, n ? new Matrix4().multiplyMatrices(modelInv, n.matrixWorld) : new Matrix4())
    set('rotor', inner(p.rotor))
    set('prop', inner(p.prop))
    set('wheelL', p.wheel_L ?? null)
    set('wheelR', p.wheel_R ?? null)
    set('wheelN', p.nose_wheel ?? null)
  }

  /** Formas para la física (coordenadas del modelo, postura actual). Null si no hay modelo troceado. */
  shapes(view: AircraftView): PartShapes | null {
    if (!this.prepared || !this.hullPts.size) return null
    this.captureGroupMatrices(view)
    const gOf = new Map<string, PartGroup>()
    for (const pc of this.pieces) gOf.set(pc.part, pc.group)
    const hulls = new Map<string, Float32Array[]>()
    for (const [part, clouds] of this.hullPts) {
      const M = this.groupMatrix.get(gOf.get(part) ?? 'airframe')!
      hulls.set(
        part,
        clouds.map((c) => {
          const o = new Float32Array(c.length)
          for (let i = 0; i < c.length; i += 3) {
            _v.set(c[i], c[i + 1], c[i + 2]).applyMatrix4(M)
            o[i] = _v.x
            o[i + 1] = _v.y
            o[i + 2] = _v.z
          }
          return o
        }),
      )
    }
    const R = this.groupMatrix.get('rotor')!
    const P = this.groupMatrix.get('prop')!
    const hub = new Vector3().setFromMatrixPosition(R)
    const rotorAxis = new Vector3(0, 1, 0).transformDirection(R)
    const bladeDir = this.spanAxis.clone().transformDirection(R)
    const prop = new Vector3().setFromMatrixPosition(P)
    const propAxis = new Vector3(1, 0, 0).transformDirection(P)
    const wheel = (id: 'wheelL' | 'wheelR' | 'wheelN', fb: WheelShape): WheelShape => {
      const w = this.wheelLocal[id]
      const M = this.groupMatrix.get(id)!
      if (!w) return fb
      return { center: w.center.clone().applyMatrix4(M), radius: w.radius, halfWidth: w.halfWidth, axis: w.axis.clone().transformDirection(M) }
    }
    const def = (c: Vector3, r: number, hw: number): WheelShape => ({ center: c, radius: r, halfWidth: hw, axis: new Vector3(0, 0, 1) })
    // piezas sin geometría propia en este modelo: no se quedan sin forma
    if (!hulls.get('mast')?.length) hulls.set('mast', [boxCloud(-0.45, -0.17, 0.4, 1.6, -0.07, 0.07)])
    return {
      hulls,
      hub: hub.lengthSq() > 0 ? hub : GEOM.hub.clone(),
      rotorAxis,
      bladeDir,
      prop: prop.lengthSq() > 0 ? prop : GEOM.prop.clone(),
      propAxis,
      wheels: {
        wheelL: wheel('wheelL', def(new Vector3(-0.4, -0.86, -0.95), 0.19, 0.07)),
        wheelR: wheel('wheelR', def(new Vector3(-0.4, -0.86, 0.95), 0.19, 0.07)),
        wheelN: wheel('wheelN', def(new Vector3(1.6, -0.89, 0), 0.16, 0.055)),
      },
    }
  }

  // ---------------------------------------------------------------------------
  // Escena del accidente
  // ---------------------------------------------------------------------------
  /** Crea las piezas en la escena (en la postura del choque) y oculta el modelo entero. */
  build(parent: Object3D, view: AircraftView): void {
    this.clear()
    this.view = view
    if (!this.groupMatrix.size) this.captureGroupMatrices(view)
    for (const pc of this.pieces) {
      let pg = this.partGroups.get(pc.part)
      if (!pg) {
        pg = new Group()
        pg.name = `wreck_${pc.part}`
        pg.matrixAutoUpdate = false
        this.partGroups.set(pc.part, pg)
        this.root.add(pg)
      }
      const geo = pc.geometry.clone() // se abolla: copia propia
      const mesh = new Mesh(geo, pc.material)
      mesh.matrixAutoUpdate = false
      mesh.matrix.copy(this.groupMatrix.get(pc.group) ?? new Matrix4())
      mesh.layers.mask = pc.source.layers.mask
      mesh.castShadow = pc.source.castShadow
      mesh.receiveShadow = pc.source.receiveShadow
      mesh.renderOrder = pc.source.renderOrder
      mesh.visible = pc.sourceNode === 'pilot_front' || visibleUpTo(pc.source, this.preparedFor)
      mesh.frustumCulled = false
      pg.add(mesh)
      let arr = this.live.get(pc.part)
      if (!arr) this.live.set(pc.part, (arr = []))
      arr.push({ mesh, src: pc, dirty: false })
    }
    if (!this.root.parent) parent.add(this.root)
    this.root.visible = true
    view.model.visible = false
  }

  /** Coloca cada pieza con su sólido. `pose(id, pos, quat)` devuelve la pose mundial del sólido. */
  update(dt: number, pose: (id: string, pos: Vector3, quat: Quaternion) => boolean): void {
    const cockpit = Boolean(this.view && (this.view as any).cockpitView)
    for (const [part, pg] of this.partGroups) {
      if (!pose(part, _v, _q)) continue
      pg.matrix.compose(_v, _q, _v2.set(1, 1, 1))
      pg.matrixWorldNeedsUpdate = true
    }
    for (const arr of this.live.values()) for (const l of arr) if (l.src.sourceNode === 'pilot_front') l.mesh.visible = !cockpit
    // normales de las piezas abolladas (como mucho 4 veces por segundo)
    this.normalTimer -= dt
    if (this.normalTimer <= 0) {
      this.normalTimer = 0.25
      for (const arr of this.live.values())
        for (const l of arr)
          if (l.dirty) {
            l.dirty = false
            l.mesh.geometry.computeVertexNormals()
          }
    }
  }

  /**
   * Abolla la pieza: hunde la malla alrededor de `pointW` en la dirección `dirW`
   * (mundo) `depth` metros, con caída suave hasta `radius`.
   */
  dent(part: string, pointW: Vector3, dirW: Vector3, depth: number, radius: number): void {
    const pg = this.partGroups.get(part)
    const arr = this.live.get(part)
    if (!pg || !arr || depth < 0.004) return
    pg.updateMatrixWorld(true)
    for (const l of arr) {
      _mi.copy(l.mesh.matrixWorld).invert()
      const p = _v.copy(pointW).applyMatrix4(_mi)
      const d = _v2.copy(dirW).transformDirection(_mi)
      const pos = l.mesh.geometry.getAttribute('position') as BufferAttribute
      const a = pos.array as Float32Array
      const r2 = radius * radius
      let moved = false
      for (let i = 0; i < a.length; i += 3) {
        const dx = a[i] - p.x
        const dy = a[i + 1] - p.y
        const dz = a[i + 2] - p.z
        const q = dx * dx + dy * dy + dz * dz
        if (q > r2) continue
        const f = 1 - q / r2
        const s = depth * f * f
        a[i] += d.x * s
        a[i + 1] += d.y * s
        a[i + 2] += d.z * s
        moved = true
      }
      if (moved) {
        pos.needsUpdate = true
        l.dirty = true
        l.mesh.geometry.boundingSphere = null
      }
    }
  }

  /** Quita las piezas y vuelve a mostrar el modelo entero. */
  clear(): void {
    for (const arr of this.live.values()) for (const l of arr) l.mesh.geometry.dispose()
    this.live.clear()
    for (const pg of this.partGroups.values()) pg.removeFromParent()
    this.partGroups.clear()
    this.groupMatrix.clear()
    this.root.visible = false
    if (this.view) this.view.model.visible = true
    this.view = null
  }
}

function isDescendant(o: Object3D, anc: Object3D): boolean {
  let p: Object3D | null = o
  while (p) {
    if (p === anc) return true
    p = p.parent
  }
  return false
}

/** ¿Se ve la malla dentro del modelo? (sin contar los nodos por encima de `stop`) */
function visibleUpTo(o: Object3D, stop: Object3D | null): boolean {
  let p: Object3D | null = o
  while (p && p !== stop) {
    if (!p.visible) return false
    p = p.parent
  }
  return true
}

function matNames(m: Mesh): string[] {
  const mats = Array.isArray(m.material) ? m.material : [m.material]
  return mats.map((x) => x?.name ?? '')
}

function forEachVertex(g: BufferGeometry, M: Matrix4, f: (x: number, y: number, z: number) => void): void {
  const pos = g.getAttribute('position') as BufferAttribute | undefined
  if (!pos) return
  for (let i = 0; i < pos.count; i++) {
    _v.fromBufferAttribute(pos, i).applyMatrix4(M)
    f(_v.x, _v.y, _v.z)
  }
}

/** Geometría con los triángulos indicados (índices del original), vértices ya transformados. */
function subGeometry(src: BufferGeometry, tris: number[], localPos: Float32Array, nrm: Matrix3): BufferGeometry {
  const remap = new Map<number, number>()
  const order: number[] = []
  const index = new Uint32Array(tris.length)
  for (let i = 0; i < tris.length; i++) {
    const v = tris[i]
    let n = remap.get(v)
    if (n === undefined) {
      n = order.length
      remap.set(v, n)
      order.push(v)
    }
    index[i] = n
  }
  const out = new BufferGeometry()
  const pos = new Float32Array(order.length * 3)
  for (let i = 0; i < order.length; i++) {
    const v = order[i]
    pos[i * 3] = localPos[v * 3]
    pos[i * 3 + 1] = localPos[v * 3 + 1]
    pos[i * 3 + 2] = localPos[v * 3 + 2]
  }
  out.setAttribute('position', new BufferAttribute(pos, 3))
  for (const name of Object.keys(src.attributes)) {
    if (name === 'position') continue
    const a = src.getAttribute(name) as BufferAttribute
    if (!a || (a as any).isInterleavedBufferAttribute) {
      if (a) {
        const n = a.itemSize
        const arr = new Float32Array(order.length * n)
        for (let i = 0; i < order.length; i++) for (let k = 0; k < n; k++) arr[i * n + k] = a.getComponent(order[i], k)
        out.setAttribute(name, new BufferAttribute(arr, n, a.normalized))
      }
      continue
    }
    const n = a.itemSize
    const Ctor = (a.array as any).constructor as { new (n: number): ArrayLike<number> & { [i: number]: number } }
    const arr = new Ctor(order.length * n)
    for (let i = 0; i < order.length; i++) for (let k = 0; k < n; k++) arr[i * n + k] = a.array[order[i] * n + k]
    out.setAttribute(name, new BufferAttribute(arr as any, n, a.normalized))
  }
  out.setIndex(new BufferAttribute(index, 1))
  // normales: al marco del grupo (la geometría original estaba en el de la malla)
  const n = out.getAttribute('normal') as BufferAttribute | undefined
  if (n && n.itemSize === 3) {
    const f = new Float32Array(n.count * 3)
    for (let i = 0; i < n.count; i++) {
      _v.set(n.getX(i), n.getY(i), n.getZ(i)).applyMatrix3(nrm).normalize()
      f[i * 3] = _v.x
      f[i * 3 + 1] = _v.y
      f[i * 3 + 2] = _v.z
    }
    out.setAttribute('normal', new BufferAttribute(f, 3))
  } else out.computeVertexNormals()
  out.deleteAttribute('tangent')
  out.computeBoundingSphere()
  return out
}

function subsample(c: number[], max: number): Float32Array {
  const n = c.length / 3
  if (n <= max) return new Float32Array(c)
  const out = new Float32Array(max * 3)
  // conserva los extremos (son los que definen el casco) y muestrea el resto
  const step = n / max
  for (let i = 0; i < max; i++) {
    const j = Math.floor(i * step) * 3
    out[i * 3] = c[j]
    out[i * 3 + 1] = c[j + 1]
    out[i * 3 + 2] = c[j + 2]
  }
  // asegura los puntos extremos en cada eje
  const ext = [0, 0, 0, 0, 0, 0]
  for (let i = 0; i < n; i++)
    for (let k = 0; k < 3; k++) {
      if (c[i * 3 + k] < c[ext[k * 2] * 3 + k]) ext[k * 2] = i
      if (c[i * 3 + k] > c[ext[k * 2 + 1] * 3 + k]) ext[k * 2 + 1] = i
    }
  for (let e = 0; e < 6; e++) {
    const j = ext[e] * 3
    out[e * 3] = c[j]
    out[e * 3 + 1] = c[j + 1]
    out[e * 3 + 2] = c[j + 2]
  }
  return out
}

function boxCloud(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Float32Array {
  const o: number[] = []
  for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) o.push(x, y, z)
  return new Float32Array(o)
}
