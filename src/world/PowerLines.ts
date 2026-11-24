// Tendidos eléctricos (y las pocas líneas de teléfono mapeadas) en 3D: torres, postes y pórticos
// de cada línea de OpenStreetMap, con sus conductores en catenaria y los cables de tierra. Datos de
// powerSources.ts (España: public/power-es.bin; resto del mundo: OpenInfraMap). Capa por teselas
// z13 (≈ 3,7 km en España): cada tesela dibuja los apoyos que caen dentro y los vanos cuyo punto
// medio cae dentro, con los datos de una caja algo mayor para conocer los vecinos.
//
// - Apoyos: los nodos de la vía marcados como torre/poste/pórtico; un vértice sin marcar entre
//   dos torres en línea recta es solo forma y se quita. Donde la vía no tiene apoyos mapeados y el
//   vano pasa del típico de su tensión se ponen postes donde la línea cruza una rejilla Mercator
//   global (cada `WIRE.span`): sale igual desde cualquier tesela.
// - Orientación: la cruceta, perpendicular a la bisectriz de los dos vanos.
// - Altura: la nominal del diseño (o la etiqueta height), ±6 %; si el conductor más bajo no
//   guarda el gálibo sobre el terreno en algún vano (relieve de una fuente gruesa), primero se
//   tensa (flecha hasta el 45 %) y si no basta se suben las dos torres, como mucho un 35 % (un
//   vano que pide más casi siempre es una torre que falta en OSM sobre una loma). Todo depende solo de cada
//   apoyo y de sus vanos, así que dos teselas calculan lo mismo para un apoyo compartido.
// - Flecha: L²/(8c) con el parámetro de la catenaria de cada tensión (WIRE en powerDesigns.ts).
// - Choques: cajas de cada apoyo (collides) y tramos de cable (wiresNear, crash/wireStrike.ts).

import { BufferGeometry, Color, Float32BufferAttribute, Matrix4, Mesh, MeshBasicMaterial, Vector3, type PerspectiveCamera, type Texture } from 'three'
import { OVERLAY_LAYER } from '../render/Graphics.ts'
import type { GeoFrame } from './GeoFrame.ts'
import type { HeightSource } from './HeightSource.ts'
import { latToY, lonToX, xToLon, yToLat } from './mapTiles.ts'
import { chooseTemplate, PALETTE, vclass, WIRE, type Template, type VClass } from './powerDesigns.ts'
import { MATERIAL, NODE, type PowerWay } from './powerFormat.ts'
import { createPowerMaterials, eyeBoost, pixelScale, SEGMENTS, templateArrays, towerGeometry, wireGeometry, type PowerMaterials } from './powerMaterial.ts'
import { powerWaysIn, usesOpenInfraMap } from './powerSources.ts'
import { Slicer, TileLayer, type LayerTile } from './TileLayer.ts'

const ZOOM = 13
/** margen (m) de la caja de datos alrededor de la tesela */
const MARGIN = 1300
const CELL = 64
const DEG = Math.PI / 180
const R_EARTH = 6378137

interface Seq {
  w: PowerWay
  vc: VClass
  circ: number
  bundle: number
  /** tipo de apoyo mayoritario de la vía (para los vértices sin marcar) */
  majType: number
  /** media tensión en celosía (si no, hormigón), por vía */
  lattice: boolean
  sups: Sup[]
}

interface Sup {
  key: string
  lat: number
  lon: number
  type: number
  mat: number
  tagH: number
  occ: Array<{ s: Seq; i: number }>
  tpl: Template | null
  vc: VClass
  base: number
  scale: number
  ground: number
  /** pie del apoyo en el marco de la tesela */
  p: Vector3
  ux: number
  uz: number
  low: number
  raise: number
}

interface TowerRec {
  x: number
  y: number
  z: number
  ux: number
  uz: number
  s: number
  tpl: Template
  r: number
  /** escala sin subir por el gálibo y lo subido (m), para depurar */
  base: number
  raise: number
}

interface PowerTile extends LayerTile {
  full: Mesh[]
  simple: Mesh[]
  wires: Mesh[]
  towers: TowerRec[]
  /** tramos de cable (x0, y0, z0, x1, y1, z1) en el marco de la tesela */
  segs: Float32Array
  grid: Map<number, number[]>
  nTowers: number
  nSpans: number
  oim: boolean
}

const _v = new Vector3()
const _w = new Vector3()
const _m = new Matrix4()
const _m2 = new Matrix4()
const _q = new Vector3()

const CONDUCTOR = new Color(PALETTE[5]).convertSRGBToLinear().r
const EARTH_WIRE = new Color(PALETTE[6]).convertSRGBToLinear().r
const BLACK = 0.015

const BUNDLES: Record<number, Array<[number, number]>> = {
  1: [[0, 0]],
  2: [
    [-0.2, 0],
    [0.2, 0],
  ],
  3: [
    [-0.23, 0],
    [0.23, 0],
    [0, 0.4],
  ],
  4: [
    [-0.225, -0.225],
    [0.225, -0.225],
    [-0.225, 0.225],
    [0.225, 0.225],
  ],
}

export class PowerLines extends TileLayer<PowerTile> {
  /** apoyos y vanos en escena (para depurar) */
  towerCount = 0
  spanCount = 0
  private readonly heights: HeightSource
  private readonly coarse: HeightSource
  private readonly mats: PowerMaterials

  /**
   * `heights`: relieve fino para el pie de los apoyos (el de los edificios); `coarse`: relieve
   * grueso para comprobar el gálibo de los vanos.
   */
  constructor(worldFrame: GeoFrame, heights: HeightSource, coarse: HeightSource) {
    super(worldFrame, 'power')
    this.zoom = ZOOM
    this.radius = 6000
    this.maxConcurrent = 2
    this.heights = heights
    this.coarse = coarse
    this.mats = createPowerMaterials()
    // (las cintas no sirven para el mapa de sombras: van sin sombra)
    this.group.userData.worldShadowCaster = false
  }

  /** Tamaño del píxel: llamar cada fotograma con la cámara y el alto del búfer en píxeles. */
  setView(camera: PerspectiveCamera, heightPx: number): void {
    if (heightPx > 0) pixelScale.value = (2 * Math.tan((camera.fov * DEG) / 2)) / camera.zoom / heightPx
    // (radianes por píxel frente a los ~0,35 mrad que resuelve el ojo)
    eyeBoost.value = Math.max(1, Math.min(4, pixelScale.value / 0.00035))
  }

  setEnvMap(tex: Texture | null): void {
    for (const m of [this.mats.towerLit, this.mats.wireLit]) {
      if ((m.envMap === null) !== (tex === null)) m.needsUpdate = true
      m.envMap = tex
    }
  }

  /** ¿Hay datos de OpenInfraMap a la vista? (para citarlos) */
  get usingOpenInfraMap(): boolean {
    for (const t of this.tiles.values()) if (t.oim && t.state === 'ready') return true
    return false
  }

  protected override afterUpdate(): void {
    for (const t of this.tiles.values()) {
      const near = t.dist < 0.3
      for (const m of t.full) m.visible = near
      for (const m of t.simple) m.visible = !near
      for (const m of t.wires) m.visible = t.dist < 0.75
    }
  }

  // -------------------------------------------------------------------------
  // Choques

  /** ¿El punto (mundo) está dentro de un apoyo (fuste, crucetas, aisladores)? */
  collides(p: Vector3): boolean {
    if (!this.enabled) return false
    let hit = false
    this.nearTiles(p, (t, q) => {
      if (hit) return
      for (const i of t.grid.get(cellKey(q.x, q.z)) ?? []) {
        if (i < 0) continue
        const tw = t.towers[i]
        const dx = q.x - tw.x
        const dz = q.z - tw.z
        const lx = (dx * tw.ux + dz * tw.uz) / tw.s
        const lz = (-dx * tw.uz + dz * tw.ux) / tw.s
        const ly = (q.y - tw.y) / tw.s
        for (const b of tw.tpl.boxes) {
          if (lx >= b.x0 && lx <= b.x1 && ly >= b.y0 && ly <= b.y1 && Math.abs(lz) <= b.z) {
            hit = true
            return
          }
        }
      }
    })
    return hit
  }

  /** Añade a `out` los tramos de cable (mundo: x0, y0, z0, x1, y1, z1) a menos de `r` del punto. */
  wiresNear(p: Vector3, r: number, out: number[]): void {
    if (!this.enabled) return
    this.nearTiles(p, (t, q, toWorld) => {
      const seen = new Set<number>()
      const c0x = Math.floor((q.x - r) / CELL)
      const c1x = Math.floor((q.x + r) / CELL)
      const c0z = Math.floor((q.z - r) / CELL)
      const c1z = Math.floor((q.z + r) / CELL)
      for (let cz = c0z; cz <= c1z; cz++) {
        for (let cx = c0x; cx <= c1x; cx++) {
          for (const i of t.grid.get(gridKey(cx, cz)) ?? []) {
            if (i >= 0 || seen.has(i)) continue
            seen.add(i)
            const k = (-1 - i) * 6
            const s = t.segs
            if (pointSegDist(q, s[k], s[k + 1], s[k + 2], s[k + 3], s[k + 4], s[k + 5]) > r) continue
            _v.set(s[k], s[k + 1], s[k + 2]).applyMatrix4(toWorld)
            _w.set(s[k + 3], s[k + 4], s[k + 5]).applyMatrix4(toWorld)
            out.push(_v.x, _v.y, _v.z, _w.x, _w.y, _w.z)
          }
        }
      }
    })
  }

  /**
   * Malla (mundo) de los apoyos y cables a menos de `half` del punto, para los restos de un
   * accidente: cajas para los apoyos y cintas cruzadas de 6 cm para los cables. null si no hay nada.
   */
  collisionMesh(c: Vector3, half: number): Mesh | null {
    if (!this.enabled) return null
    const pos: number[] = []
    const segs: number[] = []
    this.wiresNear(c, half, segs)
    for (let i = 0; i + 5 < segs.length; i += 6) {
      const ax = segs[i]
      const ay = segs[i + 1]
      const az = segs[i + 2]
      const bx = segs[i + 3]
      const by = segs[i + 4]
      const bz = segs[i + 5]
      _v.set(bx - ax, by - ay, bz - az)
      // dos cintas: una horizontal y otra vertical
      const h = new Vector3(-_v.z, 0, _v.x).normalize().multiplyScalar(0.03)
      const u = new Vector3(0, 0.03, 0)
      for (const d of [h, u]) {
        pos.push(ax - d.x, ay - d.y, az - d.z, bx - d.x, by - d.y, bz - d.z, bx + d.x, by + d.y, bz + d.z)
        pos.push(ax - d.x, ay - d.y, az - d.z, bx + d.x, by + d.y, bz + d.z, ax + d.x, ay + d.y, az + d.z)
      }
    }
    this.nearTiles(c, (t, q, toWorld) => {
      const seen = new Set<number>()
      const r = half
      for (let cz = Math.floor((q.z - r) / CELL); cz <= Math.floor((q.z + r) / CELL); cz++) {
        for (let cx = Math.floor((q.x - r) / CELL); cx <= Math.floor((q.x + r) / CELL); cx++) {
          for (const i of t.grid.get(gridKey(cx, cz)) ?? []) {
            if (i < 0 || seen.has(i)) continue
            seen.add(i)
            const tw = t.towers[i]
            if (Math.hypot(tw.x - q.x, tw.z - q.z) > half + tw.r) continue
            for (const b of tw.tpl.boxes) boxTriangles(pos, tw, b, toWorld)
          }
        }
      }
    })
    if (pos.length === 0) return null
    const g = new BufferGeometry()
    g.setAttribute('position', new Float32BufferAttribute(pos, 3))
    const m = new Mesh(g, collisionMaterial)
    m.updateMatrixWorld(true)
    return m
  }

  /** Lo que hay cerca (para depurar desde la consola). */
  debugList(): Array<{ key: string; state: string; towers: number; spans: number; dist: number; oim: boolean }> {
    return [...this.tiles.values()].map((t) => ({ key: t.key, state: t.state, towers: t.nTowers, spans: t.nSpans, dist: Math.round(t.dist * 100) / 100, oim: t.oim }))
  }

  override dispose(): void {
    super.dispose()
    const m = this.mats
    m.towerAlbedo.dispose()
    m.towerLit.dispose()
    m.wireAlbedo.dispose()
    m.wireLit.dispose()
    m.towerDepth.dispose()
    m.wireDepth.dispose()
  }

  // -------------------------------------------------------------------------

  /** La tesela del punto y sus ocho vecinas, con el punto en el marco de cada una. */
  private nearTiles(p: Vector3, fn: (t: PowerTile, q: Vector3, toWorld: Matrix4) => void): void {
    const g = this.worldFrame.worldToGeo(p)
    const n = 2 ** ZOOM
    const tx = Math.floor(lonToX(g.lon, n))
    const ty = Math.floor(latToY(g.lat, n))
    for (let y = ty - 1; y <= ty + 1; y++) {
      for (let x = tx - 1; x <= tx + 1; x++) {
        const t = this.tiles.get(`${x}/${y}`)
        if (!t || t.state !== 'ready' || t.grid.size === 0) continue
        // mundo → tesela y tesela → mundo, sin invertir matrices
        _m.multiplyMatrices(t.frame.ecefToWorld, this.worldFrame.worldToECEF)
        _q.copy(p).applyMatrix4(_m)
        _m2.multiplyMatrices(this.worldFrame.ecefToWorld, t.frame.worldToECEF)
        fn(t, _q, _m2)
      }
    }
  }

  protected createTile(base: LayerTile): PowerTile {
    return { ...base, full: [], simple: [], wires: [], towers: [], segs: new Float32Array(0), grid: new Map(), nTowers: 0, nSpans: 0, oim: false }
  }

  protected disposeTile(t: PowerTile): void {
    for (const m of [...t.full, ...t.simple, ...t.wires]) {
      this.group.remove(m)
      m.geometry.dispose()
    }
    t.full = []
    t.simple = []
    t.wires = []
    t.towers = []
    t.segs = new Float32Array(0)
    t.grid = new Map()
    this.towerCount -= t.nTowers
    this.spanCount -= t.nSpans
    t.nTowers = 0
    t.nSpans = 0
  }

  protected async loadTile(t: PowerTile): Promise<void> {
    const signal = t.abort.signal
    const n = 2 ** ZOOM
    const north = yToLat(t.y, n)
    const south = yToLat(t.y + 1, n)
    const west = xToLon(t.x, n)
    const east = xToLon(t.x + 1, n)
    const clat = (north + south) / 2
    const ky = 110574
    const kx = 111320 * Math.cos(clat * DEG)
    const box = { south: south - MARGIN / ky, north: north + MARGIN / ky, west: west - MARGIN / kx, east: east + MARGIN / kx }
    t.oim = usesOpenInfraMap(clat, (west + east) / 2)
    const ways = await powerWaysIn(box, signal)
    if (signal.aborted || this.disposed) return
    if (ways === null) throw new Error('sin datos de tendidos')
    if (ways.length === 0) {
      t.state = 'empty'
      return
    }
    const inTile = (lat: number, lon: number) => lat >= south && lat < north && lon >= west && lon < east
    const slicer = new Slicer(5)

    // 1) apoyos de cada vía, sin repetir los compartidos
    const sups = new Map<string, Sup>()
    const seqs: Seq[] = []
    for (const w of ways) {
      const seq = buildSeq(w, sups, kx, ky)
      if (seq) seqs.push(seq)
    }
    for (const s of seqs) s.sups.forEach((p, i) => p.occ.push({ s, i }))

    // 2) vanos de esta tesela y apoyos que hacen falta
    const ownedSpans: Array<{ s: Seq; i: number }> = []
    const ends = new Set<Sup>()
    for (const s of seqs) {
      for (let i = 0; i + 1 < s.sups.length; i++) {
        const a = s.sups[i]
        const b = s.sups[i + 1]
        if (a === b) continue
        if (!inTile((a.lat + b.lat) / 2, (a.lon + b.lon) / 2)) continue
        ownedSpans.push({ s, i })
        ends.add(a)
        ends.add(b)
      }
    }
    const owned: Sup[] = []
    for (const p of sups.values()) {
      if (inTile(p.lat, p.lon)) {
        owned.push(p)
        ends.add(p)
      }
    }
    if (ends.size === 0) {
      t.state = 'empty'
      return
    }
    const need = new Set<Sup>(ends)
    for (const p of ends) for (const o of p.occ) for (const d of [-1, 1]) {
      const q = o.s.sups[o.i + d]
      if (q) need.add(q)
    }

    // 3) relieve: fino en el pie de cada apoyo, grueso para el gálibo de los vanos
    const e = 1.5e-4
    await Promise.all([
      ...[...need].map((p) => this.heights.ensure(p.lat - e, p.lon - e, p.lat + e, p.lon + e)),
      this.coarse.ensure(box.south, box.west, box.north, box.east),
    ])
    if (signal.aborted || this.disposed) return
    for (const p of need) {
      p.ground = this.heights.sample(p.lat, p.lon) ?? this.coarse.sample(p.lat, p.lon) ?? 0
      t.frame.geoToWorld(p.lat, p.lon, p.ground, p.p)
      chooseFor(p)
    }
    for (const p of need) orient(p, need)
    if (!(await slicer.yield(signal))) return

    // 4) gálibo: lo que hay que subir cada apoyo (con la flecha mínima) y luego la flecha de cada vano
    const sample = (lat: number, lon: number) => this.coarse.sample(lat, lon) ?? this.heights.sample(lat, lon)
    for (const p of ends) {
      let raise = 0
      for (const o of p.occ) {
        for (const d of [-1, 1]) {
          const q = o.s.sups[o.i + d]
          if (!q || !need.has(q) || q === p) continue
          const [a, b] = d < 0 ? [q, p] : [p, q]
          raise = Math.max(raise, spanFit(a, b, o.s.vc, a.base, b.base, sample).deficit)
        }
      }
      p.raise = raise
    }
    // (los vecinos de fuera de `ends` solo hacen falta con su escala base)
    for (const p of need) {
      p.scale = ends.has(p) ? Math.min(p.base * 1.35, p.base + (p.low > 0.5 ? p.raise / p.low : 0)) : p.base
    }
    if (!(await slicer.yield(signal))) return

    // 5) mallas
    const byTpl = new Map<Template, Sup[]>()
    for (const p of owned) {
      if (!p.tpl) continue
      const l = byTpl.get(p.tpl)
      if (l) l.push(p)
      else byTpl.set(p.tpl, [p])
    }
    const tileR = 0.75 * Math.hypot((east - west) * kx, (north - south) * ky) + 800
    const towers: TowerRec[] = []
    for (const [tpl, list] of byTpl) {
      const ip = new Float32Array(list.length * 4)
      const iu = new Float32Array(list.length * 2)
      list.forEach((p, i) => {
        ip.set([p.p.x, p.p.y, p.p.z, p.scale], i * 4)
        iu.set([p.ux, p.uz], i * 2)
        let r = 0
        for (const b of tpl.boxes) r = Math.max(r, Math.abs(b.x0), Math.abs(b.x1), b.z)
        towers.push({ x: p.p.x, y: p.p.y, z: p.p.z, ux: p.ux, uz: p.uz, s: p.scale, tpl, r: r * p.scale, base: p.base, raise: p.raise })
      })
      t.full.push(...this.pair(towerGeometry(templateArrays(tpl, false), ip, iu, tileR), true, t))
      t.simple.push(...this.pair(towerGeometry(templateArrays(tpl, true), ip, iu, tileR), true, t))
    }

    const wa: number[] = []
    const wb: number[] = []
    const wp: number[] = []
    const segs: number[] = []
    const earthDone = new Set<string>()
    const A = new Vector3()
    const B = new Vector3()
    const addWire = (pa: Vector3, pb: Vector3, sag: number, r: number, grey: number) => {
      wa.push(pa.x, pa.y, pa.z)
      wb.push(pb.x, pb.y, pb.z)
      wp.push(sag, r, grey, 1)
      // la misma curva que el shader, en SEGMENTS tramos
      let px = pa.x
      let py = pa.y
      let pz = pa.z
      for (let k = 1; k <= SEGMENTS; k++) {
        const f = k / SEGMENTS
        const x = pa.x + (pb.x - pa.x) * f
        const y = pa.y + (pb.y - pa.y) * f - 4 * sag * f * (1 - f)
        const z = pa.z + (pb.z - pa.z) * f
        segs.push(px, py, pz, x, y, z)
        px = x
        py = y
        pz = z
      }
    }
    for (const { s, i } of ownedSpans) {
      const a = s.sups[i]
      const b = s.sups[i + 1]
      if (!a.tpl || !b.tpl) continue
      const fit = spanFit(a, b, s.vc, a.scale, b.scale, sample)
      const sag = fit.sag
      const vc = s.vc
      const wire = WIRE[vc]
      const grey = vc === 0 || vc === 6 ? BLACK : CONDUCTOR
      // perpendicular horizontal al vano (para separar los conductores de un haz)
      const dx = b.p.x - a.p.x
      const dz = b.p.z - a.p.z
      const dl = Math.hypot(dx, dz) || 1
      const hx = -dz / dl
      const hz = dx / dl
      const offA = circuitOffset(a, s)
      const offB = circuitOffset(b, s)
      const bundle = BUNDLES[Math.min(4, Math.max(1, s.bundle))] ?? BUNDLES[1]
      const single = vc === 0 || vc === 6
      for (let j = 0; j < s.circ; j++) {
        const ca = a.tpl.circuits[(offA + j) % a.tpl.circuits.length]
        const cb = b.tpl.circuits[(offB + j) % b.tpl.circuits.length]
        const phases = single ? 1 : Math.max(ca.length, cb.length)
        for (let ph = 0; ph < phases; ph++) {
          attach(a, ca[ph % ca.length], A)
          attach(b, cb[ph % cb.length], B)
          for (const [o, u] of bundle) {
            _v.set(A.x + hx * o, A.y + u, A.z + hz * o)
            _w.set(B.x + hx * o, B.y + u, B.z + hz * o)
            addWire(_v, _w, sag, wire.r, grey)
          }
        }
      }
      // cables de tierra (una vez por pareja de apoyos aunque pasen dos vías)
      if (wire.earthR > 0 && a.tpl.earth.length && b.tpl.earth.length) {
        const k = a.key < b.key ? `${a.key}|${b.key}` : `${b.key}|${a.key}`
        if (!earthDone.has(k)) {
          earthDone.add(k)
          const ne = Math.max(a.tpl.earth.length, b.tpl.earth.length)
          for (let e2 = 0; e2 < ne; e2++) {
            attach(a, a.tpl.earth[e2 % a.tpl.earth.length], A)
            attach(b, b.tpl.earth[e2 % b.tpl.earth.length], B)
            addWire(A, B, sag * 0.85, wire.earthR, EARTH_WIRE)
          }
        }
      }
    }
    if (wa.length) t.wires.push(...this.pair(wireGeometry(new Float32Array(wa), new Float32Array(wb), new Float32Array(wp), tileR), false, t))

    // 6) rejilla de choques: apoyos (índice ≥ 0) y tramos de cable (−1 − índice)
    const grid = new Map<number, number[]>()
    const put = (k: number, v: number) => {
      const l = grid.get(k)
      if (l) l.push(v)
      else grid.set(k, [v])
    }
    towers.forEach((tw, i) => {
      for (let cz = Math.floor((tw.z - tw.r) / CELL); cz <= Math.floor((tw.z + tw.r) / CELL); cz++)
        for (let cx = Math.floor((tw.x - tw.r) / CELL); cx <= Math.floor((tw.x + tw.r) / CELL); cx++) put(gridKey(cx, cz), i)
    })
    for (let i = 0; i * 6 < segs.length; i++) {
      const k = i * 6
      const x0 = Math.min(segs[k], segs[k + 3])
      const x1 = Math.max(segs[k], segs[k + 3])
      const z0 = Math.min(segs[k + 2], segs[k + 5])
      const z1 = Math.max(segs[k + 2], segs[k + 5])
      for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++)
        for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) put(gridKey(cx, cz), -1 - i)
    }
    t.towers = towers
    t.segs = new Float32Array(segs)
    t.grid = grid
    t.nTowers = owned.length
    t.nSpans = ownedSpans.length
    this.towerCount += t.nTowers
    this.spanCount += t.nSpans
    if (t.full.length + t.wires.length === 0) {
      t.state = 'empty'
      return
    }
    this.afterUpdate()
    t.state = 'ready'
  }

  /** Malla de la pasada de albedo y la de luz (misma geometría), colgadas del grupo. */
  private pair(geo: BufferGeometry, tower: boolean, t: PowerTile): Mesh[] {
    const m = this.mats
    // (la tercera solo escribe la profundidad de lo que cubre más de medio píxel: va en la cola opaca)
    const out = [new Mesh(geo, tower ? m.towerAlbedo : m.wireAlbedo), new Mesh(geo, tower ? m.towerLit : m.wireLit), new Mesh(geo, tower ? m.towerDepth : m.wireDepth)]
    out.forEach((mesh, k) => {
      mesh.matrixAutoUpdate = false
      mesh.matrix.copy(t.frame.worldToECEF)
      mesh.layers.set(OVERLAY_LAYER)
      // transparentes: antes de los discos del rotor (2-5), para que el disco los vele; la de
      // profundidad, la última de la cola opaca (si va antes que el terreno o el cielo, les tapa el fondo)
      mesh.renderOrder = k === 2 ? 100 : (tower ? -4 : -2) + k
      mesh.name = `power ${tower ? 'towers' : 'wires'} ${t.key}`
      this.group.add(mesh)
      mesh.updateMatrixWorld(true)
    })
    // (la de luz comparte geometría: al liberar la tesela se libera una vez de más, sin efecto)
    return out
  }
}

const collisionMaterial = new MeshBasicMaterial()

// ---------------------------------------------------------------------------

function cellKey(x: number, z: number): number {
  return gridKey(Math.floor(x / CELL), Math.floor(z / CELL))
}
function gridKey(cx: number, cz: number): number {
  return (cz + 4096) * 8192 + cx + 4096
}

function hash01(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 100000) / 100000
}

function supKey(lat: number, lon: number): string {
  return `${Math.round(lat * 1e6)},${Math.round(lon * 1e6)}`
}

function newSup(lat: number, lon: number, type: number, mat: number, tagH: number): Sup {
  return { key: supKey(lat, lon), lat, lon, type, mat, tagH, occ: [], tpl: null, vc: 1, base: 1, scale: 1, ground: 0, p: new Vector3(), ux: 1, uz: 0, low: 1, raise: 0 }
}

/** Apoyos de una vía en orden (los compartidos, una sola vez en `sups`). */
function buildSeq(w: PowerWay, sups: Map<string, Sup>, kx: number, ky: number): Seq | null {
  const m = w.lat.length
  if (m < 2) return null
  let towers = 0
  let poles = 0
  let tagged = 0
  for (const f of w.flags) {
    const t = f & 7
    if (t) tagged++
    if (t === NODE.tower) towers++
    else if (t === NODE.pole) poles++
  }
  const majType = towers === 0 && poles === 0 ? NODE.vertex : towers >= poles ? NODE.tower : NODE.pole
  const vc = vclass(w.kind, w.kv, majType)
  const single = vc === 0 || vc === 6
  const circ = single ? 1 : w.cables >= 3 ? Math.max(1, Math.min(4, Math.floor(w.cables / 3))) : Math.max(1, Math.min(4, w.circuits || 1))
  const bundle = single ? 1 : w.wires || WIRE[vc].bundle
  const seq: Seq = { w, vc, circ, bundle, majType, lattice: hash01(w.id) < 0.6, sups: [] }
  const get = (lat: number, lon: number, type: number, mat: number, tagH: number) => {
    const key = supKey(lat, lon)
    let s = sups.get(key)
    if (!s) {
      s = newSup(lat, lon, type, mat, tagH)
      sups.set(key, s)
    } else if (type && !s.type) {
      s.type = type
      s.mat = s.mat || mat
      s.tagH = s.tagH || tagH
    }
    return s
  }
  // nodos que son apoyos
  const keep: number[] = []
  for (let i = 0; i < m; i++) {
    const t = w.flags[i] & 7
    if (t !== NODE.vertex || i === 0 || i === m - 1 || tagged === 0) {
      keep.push(i)
      continue
    }
    // vértice sin marcar entre dos apoyos marcados, casi en línea recta: solo da forma
    if (w.flags[i - 1] & 7 && w.flags[i + 1] & 7) {
      const ax = (w.lon[i] - w.lon[i - 1]) * kx
      const ay = (w.lat[i] - w.lat[i - 1]) * ky
      const bx = (w.lon[i + 1] - w.lon[i]) * kx
      const by = (w.lat[i + 1] - w.lat[i]) * ky
      const c = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1)
      if (c > Math.cos(3 * DEG)) continue
    }
    keep.push(i)
  }
  const span = WIRE[vc].span
  for (let k = 0; k < keep.length; k++) {
    const i = keep[k]
    const f = w.flags[i]
    seq.sups.push(get(w.lat[i], w.lon[i], f & 7, (f >> 3) & 7, w.height[i]))
    if (k + 1 >= keep.length) break
    const j = keep[k + 1]
    const untagged = !(w.flags[i] & 7) || !(w.flags[j] & 7)
    const dist = Math.hypot((w.lon[j] - w.lon[i]) * kx, (w.lat[j] - w.lat[i]) * ky)
    if (!untagged || dist < span * 1.5) continue
    // postes donde el vano cruza la rejilla Mercator global
    for (const [lat, lon] of gridCrossings(w.lat[i], w.lon[i], w.lat[j], w.lon[j], span, dist)) seq.sups.push(get(lat, lon, NODE.vertex, 0, 0))
  }
  // (dos apoyos seguidos iguales: uno)
  seq.sups = seq.sups.filter((s, k) => k === 0 || s !== seq.sups[k - 1])
  return seq.sups.length >= 2 ? seq : null
}

function mercX(lon: number): number {
  return lon * DEG * R_EARTH
}
function mercY(lat: number): number {
  return Math.log(Math.tan(Math.PI / 4 + (lat * DEG) / 2)) * R_EARTH
}

function gridCrossings(lat0: number, lon0: number, lat1: number, lon1: number, span: number, dist: number): Array<[number, number]> {
  const scale = span / Math.cos(((lat0 + lat1) / 2) * DEG)
  const ax = mercX(lon0)
  const bx = mercX(lon1)
  const ay = mercY(lat0)
  const by = mercY(lat1)
  const [a, b] = Math.abs(bx - ax) >= Math.abs(by - ay) ? [ax, bx] : [ay, by]
  if (a === b) return []
  const out: Array<[number, number]> = []
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  const margin = (0.3 * span) / dist
  for (let k = Math.ceil(lo / scale); k * scale <= hi; k++) {
    const f = (k * scale - a) / (b - a)
    if (f < margin || f > 1 - margin) continue
    out.push([lat0 + (lat1 - lat0) * f, lon0 + (lon1 - lon0) * f])
  }
  out.sort((p, q) => Math.abs(p[0] - lat0) + Math.abs(p[1] - lon0) - (Math.abs(q[0] - lat0) + Math.abs(q[1] - lon0)))
  return out
}

/** Vía principal del apoyo (la de más tensión) y plantilla. */
function chooseFor(p: Sup): void {
  if (p.tpl) return
  let main = p.occ[0]
  for (const o of p.occ) if (o.s.vc > main.s.vc || (o.s.vc === main.s.vc && o.s.w.id < main.s.w.id)) main = o
  const seen = new Set<Seq>()
  let circ = 0
  for (const o of p.occ) {
    if (seen.has(o.s)) continue
    seen.add(o.s)
    if (o.s.vc === main.s.vc) circ += o.s.circ
  }
  const s = main.s
  let type = p.type || s.majType
  // final de línea de alta sin apoyo marcado: el pórtico de la subestación
  const isEnd = p.occ.length === 1 && (main.i === 0 || main.i === s.sups.length - 1)
  if (!p.type && isEnd && s.vc >= 2 && s.vc <= 5) type = NODE.portal
  let mat = p.mat
  if (s.vc === 1 && mat === MATERIAL.unknown && type !== NODE.tower) mat = s.lattice ? MATERIAL.lattice : MATERIAL.concrete
  p.vc = s.vc
  p.tpl = chooseTemplate(s.vc, circ, type, mat, s.w.design)
  const t = p.tpl
  p.base = p.tagH > 0 ? Math.max(0.6, Math.min(2, p.tagH / t.height)) : 1 + 0.12 * (hash01(p.key) - 0.5)
  p.scale = p.base
  let low = Infinity
  for (const c of t.circuits) for (const [, y] of c) low = Math.min(low, y)
  p.low = Number.isFinite(low) ? low : t.height
}

/** Cruceta perpendicular a la bisectriz de los vanos de la vía principal. */
function orient(p: Sup, have: Set<Sup>): void {
  let main = p.occ[0]
  for (const o of p.occ) if (o.s.vc > main.s.vc || (o.s.vc === main.s.vc && o.s.w.id < main.s.w.id)) main = o
  const prev = main.s.sups[main.i - 1]
  const next = main.s.sups[main.i + 1]
  let dx = 0
  let dz = 0
  for (const [q, sgn] of [
    [prev, 1],
    [next, -1],
  ] as const) {
    if (!q || q === p) continue
    // sin el vecino en el marco de la tesela: su dirección desde la latitud y longitud
    let ex: number
    let ez: number
    if (have.has(q)) {
      ex = p.p.x - q.p.x
      ez = p.p.z - q.p.z
    } else {
      ex = (p.lon - q.lon) * 111320 * Math.cos(p.lat * DEG)
      ez = -(p.lat - q.lat) * 110574
    }
    const l = Math.hypot(ex, ez)
    if (l < 1e-6) continue
    dx += (sgn * ex) / l
    dz += (sgn * ez) / l
  }
  const l = Math.hypot(dx, dz)
  if (l < 1e-6) {
    p.ux = 1
    p.uz = 0
    return
  }
  dx /= l
  dz /= l
  // dirección de la línea d = (dx, dz) → eje de la cruceta u con d = (−u.z, u.x)
  p.ux = dz
  p.uz = -dx
}

/** Primer circuito de la vía en este apoyo (las vías que lo comparten, por orden de id). */
function circuitOffset(p: Sup, s: Seq): number {
  const list = [...new Set(p.occ.map((o) => o.s))].sort((a, b) => (a.w.id < b.w.id ? -1 : a.w.id > b.w.id ? 1 : 0))
  let off = 0
  for (const q of list) {
    if (q === s) return off
    off += q.circ
  }
  return 0
}

/** Punto de enganche (x, y del apoyo) en el marco de la tesela. */
function attach(p: Sup, at: [number, number], out: Vector3): Vector3 {
  return out.set(p.p.x + p.scale * at[0] * p.ux, p.p.y + p.scale * at[1], p.p.z + p.scale * at[0] * p.uz)
}

/**
 * Vano a–b con las escalas dadas: lo que falta de gálibo con la flecha mínima (deficit, m) y la
 * mayor flecha (hasta la natural L²/8c) que guarda el gálibo.
 */
function spanFit(a: Sup, b: Sup, vc: VClass, sa: number, sb: number, sample: (lat: number, lon: number) => number | null): { deficit: number; sag: number } {
  const w = WIRE[vc]
  const L = Math.hypot(b.p.x - a.p.x, b.p.z - a.p.z) || Math.hypot((b.lon - a.lon) * 111320 * Math.cos(a.lat * DEG), (b.lat - a.lat) * 110574)
  const sag0 = (L * L) / (8 * w.c)
  const sagMin = 0.45 * sag0
  const ya = a.ground + sa * a.low
  const yb = b.ground + sb * b.low
  let deficit = 0
  let sag = sag0
  for (let k = 1; k < 8; k++) {
    const f = k / 8
    const g = sample(a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f)
    if (g === null) continue
    const lin = ya + (yb - ya) * f
    const tau = 4 * f * (1 - f)
    deficit = Math.max(deficit, g + w.clear - (lin - sagMin * tau))
    sag = Math.min(sag, (lin - g - w.clear) / tau)
  }
  return { deficit, sag: Math.max(sagMin, Math.min(sag0, sag)) }
}

function pointSegDist(p: Vector3, ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const dx = bx - ax
  const dy = by - ay
  const dz = bz - az
  const l2 = dx * dx + dy * dy + dz * dz
  let f = l2 > 0 ? ((p.x - ax) * dx + (p.y - ay) * dy + (p.z - az) * dz) / l2 : 0
  f = Math.max(0, Math.min(1, f))
  return Math.hypot(p.x - ax - f * dx, p.y - ay - f * dy, p.z - az - f * dz)
}

const _bx = new Vector3()
/** Doce triángulos de una caja del apoyo, en coordenadas del mundo. */
function boxTriangles(out: number[], tw: TowerRec, b: { x0: number; x1: number; y0: number; y1: number; z: number }, toWorld: Matrix4): void {
  const corners: number[][] = []
  for (const lx of [b.x0, b.x1])
    for (const ly of [b.y0, b.y1])
      for (const lz of [-b.z, b.z]) {
        // apoyo → tesela: x·u + z·d con d = (−u.z, u.x)
        _bx.set(tw.x + tw.s * (lx * tw.ux - lz * tw.uz), tw.y + tw.s * ly, tw.z + tw.s * (lx * tw.uz + lz * tw.ux)).applyMatrix4(toWorld)
        corners.push([_bx.x, _bx.y, _bx.z])
      }
  // índices: x (0/4) + y (0/2) + z (0/1)
  const faces = [
    [0, 1, 3, 2],
    [4, 6, 7, 5],
    [0, 4, 5, 1],
    [2, 3, 7, 6],
    [0, 2, 6, 4],
    [1, 5, 7, 3],
  ]
  for (const [a, c, d, e] of faces) out.push(...corners[a], ...corners[c], ...corners[d], ...corners[a], ...corners[d], ...corners[e])
}
