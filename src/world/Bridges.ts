// Puentes 3D de todo el mundo, de OpenStreetMap (capa transportation de las teselas vectoriales
// de OpenFreeMap, las mismas que usan edificios, árboles y pistas).
//
// La ortofoto trae los puentes pintados sobre el terreno. Aquí se levantan de verdad: tablero
// con el ancho de cada tipo de vía, pretiles, pilas hasta el suelo o el agua y estribos, a la
// altura que se deduce del relieve en sus dos extremos (bridgeNet.ts y bridgeChains.ts). Se
// puede pasar por debajo, chocar con ellos y posarse en el tablero.
//
// - Los puentes de los que se sabe el tipo (public/bridges.bin: colgantes, atirantados, de
//   arco, de celosía…) llevan además su estructura (bridgeShapes.ts).
// - Donde el MDT del IGN trae el puente incrustado (el terreno sube hasta la calzada), se
//   rebaja el terreno por debajo: `onCarve` entrega los parches a Runways.ts.
// - Bajo el tablero se tapa el puente pintado en la ortofoto con una banda del color del agua
//   o del suelo de los lados (`decals`).
//
// Igual que los edificios: por teselas z14 alrededor de la cámara (TileLayer), material
// iluminado con alfa = 0 (ya iluminado), cielo como mapa de entorno y sombra del sol.

import { Color, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, Vector3, type Texture } from 'three'
import type { GeoFrame } from './GeoFrame.ts'
import type { HeightSource } from './HeightSource.ts'
import { BridgeNet, geoToUnit, tileKey, unitToGeo, type BridgePiece } from './bridgeNet.ts'
import { ChainBuilder, offsetGeo, profileAt, stationAt, type Chain } from './bridgeChains.ts'
import { ChainFrame, MeshBuilder, primBounds, primHit, type Prim } from './bridgeMesh.ts'
import { buildStructure, planStructure, type StructurePlan } from './bridgeShapes.ts'
import { bridgeRecordsNear } from './bridgeStructures.ts'
import { loadOrthoMosaic, latToY, lonToX, Z } from './mapTiles.ts'
import { asphaltColour, OrthoSampler } from './orthoSample.ts'
import type { TerrainPatch } from './Runways.ts'
import { Slicer, TileLayer, type LayerTile } from './TileLayer.ts'

/** lado de las celdas de la rejilla de choques (m) */
const CELL = 64
/** a menos de esto del borde de una tesela se miran también las formas de la vecina (m) */
const EDGE = 40

// colores en sRGB, como la ortofoto (Color los pasa a lineal)
const ASPHALT = new Color(0x4d4e51)
const PATHWAY = new Color(0x9c968c)
const BALLAST = new Color(0x736b62)
const PARAPET = new Color(0xbfbcb4)
const RAILING = new Color(0x6a6e72)
const CONCRETE = new Color(0xb1ada4)
const UNDER = new Color(0x8e8a82)
const PIER = new Color(0xaaa69d)

interface BridgeTile extends LayerTile {
  mesh: Mesh | null
  decal: Mesh | null
  prims: Prim[]
  grid: Map<number, number[]>
  /** cadenas dibujadas (por sus rebajes del terreno) */
  chains: Chain[]
  count: number
}

export interface BridgeOptions {
  /** plantilla XYZ de la ortofoto (para tapar el puente pintado); null = no se tapa */
  imageryUrl: string | null
  /** rebajar el terreno bajo los puentes incrustados en el MDT (solo con el MDT del IGN) */
  carve: boolean
  /** rellenar los accesos (terraplén contra el estribo) y margen del relleno (ver ChainOptions) */
  fill: boolean
  fillPad: number
}

/** dos calzadas con el rumbo de un vehículo igual de alineado (coseno, ≈ 10° junto a 0°) */
const ALIGN_TIE = 0.015

const _q = new Vector3()
const _a = new Vector3()
const _b = new Vector3()
const _c = new Vector3()
const _d = new Vector3()
const _in = new Vector3()

export class Bridges extends TileLayer<BridgeTile> {
  /** puentes en escena (para depurar) */
  count = 0
  /** bandas que tapan el puente pintado en la ortofoto (no dan sombra: van aparte) */
  readonly decals = new Group()
  /** parches de terreno vigentes cuando cambian (los aplica Runways.ts) */
  onCarve: ((patches: TerrainPatch[]) => void) | null = null
  /** teselas de red a partir de las cuales se empieza de cero (vuelos largos: no acumular) */
  private static readonly NET_MAX = 700
  private net = new BridgeNet()
  private builder: ChainBuilder
  private readonly heights: HeightSource
  private readonly opts: BridgeOptions
  private readonly material: MeshStandardMaterial
  private readonly decalMaterial: MeshBasicMaterial
  private readonly carves = new Map<string, { patch: TerrainPatch; refs: number }>()
  private carveDirty = false
  private plans = new Map<Chain, Promise<StructurePlan | null>>()
  /** color del firme de cada cadena de carretera, de la ortofoto (null: el gris de siempre) */
  private tops = new Map<Chain, Promise<Color | null>>()
  private readonly sampler: OrthoSampler | null
  private readonly sampleAbort = new AbortController()
  /** estructuras ya resueltas (para depurar) */
  private readonly shapes = new Map<Chain, string>()

  constructor(worldFrame: GeoFrame, heights: HeightSource, opts: BridgeOptions) {
    super(worldFrame, 'bridges')
    this.radius = 4000
    this.heights = heights
    this.opts = opts
    this.builder = new ChainBuilder(this.net, heights, { carve: opts.carve, fill: opts.fill, fillPad: opts.fillPad })
    this.sampler = opts.imageryUrl ? new OrthoSampler(opts.imageryUrl) : null
    this.material = createBridgeMaterial()
    this.decalMaterial = new MeshBasicMaterial({ vertexColors: true })
    this.decals.matrixAutoUpdate = false
    this.decals.name = 'bridge-decals'
  }

  override syncFrame(): void {
    super.syncFrame()
    this.decals.matrix.copy(this.worldFrame.ecefToWorld)
    this.decals.updateMatrixWorld(true)
  }

  override update(dt: number, cameraWorld: Vector3): void {
    super.update(dt, cameraWorld)
    this.decals.visible = this.group.visible
  }

  protected override afterUpdate(): void {
    // de lejos el terreno se dibuja más grueso y la banda asomaría o se hundiría: solo de cerca
    for (const t of this.tiles.values()) if (t.decal) t.decal.visible = t.dist < 0.8
    if (this.carveDirty) {
      this.carveDirty = false
      this.onCarve?.([...this.carves.values()].map((c) => c.patch))
    }
  }

  /**
   * Faltan por cargar los puentes de alrededor del punto de salida (como mucho 12 s): si se sale
   * de un puente, que el aparato se pose en su calzada y no en el terreno de debajo.
   */
  get busy(): boolean {
    if (performance.now() - this.bornAt > 12000) return false
    if (this.tiles.size === 0) return true
    for (const t of this.tiles.values()) if (t.dist <= 0.3 && t.state === 'loading') return true
    return false
  }
  private readonly bornAt = performance.now()

  setEnvMap(tex: Texture | null): void {
    const m = this.material
    if ((m.envMap === null) !== (tex === null)) m.needsUpdate = true
    m.envMap = tex
    m.envMapIntensity = 1
  }

  /** Mallas con las que pueden chocar los restos de un accidente. */
  meshes(): Mesh[] {
    const out: Mesh[] = []
    for (const t of this.tiles.values()) if (t.mesh) out.push(t.mesh)
    return out
  }

  /** ¿El punto (mundo) está dentro de un puente (tablero, pila, torre, cable…)? */
  collides(p: Vector3): boolean {
    let hit = false
    this.nearTiles(p, (t, q) => {
      const list = t.grid.get(cellKey(q.x, q.z))
      if (!list) return
      for (const i of list) {
        if (primHit(t.prims[i], q.x, q.y, q.z)) {
          hit = true
          return
        }
      }
    })
    return hit
  }

  /**
   * La calzada más alta bajo el punto (x, z) del mundo que no pase de `maxY` (la altura del
   * aparato: un tablero por encima de él es un techo, no un suelo). Devuelve su altura y su
   * normal en `out`, o false si no hay ninguna.
   * (dirX, dirZ): rumbo de un vehículo que va por el puente; solo cuenta la calzada que mejor lo
   * lleva (±37° como mucho), no la de un paso elevado que le cruza por encima en un enlace de
   * varios pisos, aunque sea con un ángulo cerrado. Entre varias que lo lleven igual (ramales que
   * se juntan, pisos paralelos), la más alta.
   */
  deckBelow(x: number, z: number, maxY: number, out: { y: number; normal: Vector3 }, dirX = 0, dirZ = 0): boolean {
    let best = -Infinity
    const dirL = Math.hypot(dirX, dirZ)
    /** alineación (coseno) de la mejor calzada hasta ahora con el rumbo */
    let bestCos = 0
    _a.set(x, maxY, z)
    this.nearTiles(_a, (t, q) => {
      const list = t.grid.get(cellKey(q.x, q.z))
      if (!list) return
      for (const i of list) {
        const p = t.prims[i]
        if (p.k !== 0) continue
        const dx = p.x1 - p.x0
        const dz = p.z1 - p.z0
        const l2 = dx * dx + dz * dz
        if (l2 < 1e-6) continue
        const f = ((q.x - p.x0) * dx + (q.z - p.z0) * dz) / l2
        if (f < -0.02 || f > 1.02) continue
        const l = Math.sqrt(l2)
        if (Math.abs(((q.x - p.x0) * dz - (q.z - p.z0) * dx) / l) > p.hw - 0.2) continue
        // (los marcos de las teselas y el del mundo apenas giran entre sí: el rumbo vale tal cual)
        const cos = dirL > 1e-6 ? Math.abs(dx * dirX + dz * dirZ) / (l * dirL) : 1
        if (cos < 0.8 || cos < bestCos - ALIGN_TIE) continue
        const top = p.y0 + (p.y1 - p.y0) * f
        // (q.y es la altura del aparato en el marco de la tesela)
        if (top > q.y + 0.3) continue
        // a mundo: la altura cambia lo mismo que la del punto de consulta
        const wy = maxY + (top - q.y)
        // (una calzada claramente mejor alineada manda aunque sea más baja)
        if (wy > best || cos > bestCos + ALIGN_TIE) {
          best = wy
          bestCos = Math.max(bestCos, cos)
          const slope = (p.y1 - p.y0) / l
          out.normal.set((-slope * dx) / l, 1, (-slope * dz) / l).normalize()
        }
      }
    })
    if (best === -Infinity) return false
    out.y = best
    return true
  }

  /** Puentes dibujados cerca (para depurar desde la consola). */
  debugList(): Array<{ key: string; cls: string; len: number; clear: number; carve: boolean; shape: string | null; lat: number; lon: number }> {
    const seen = new Set<Chain>()
    for (const t of this.tiles.values()) for (const c of t.chains) seen.add(c)
    return [...seen].map((c) => ({
      key: c.key,
      cls: c.parts[0].piece.cls,
      len: Math.round(c.len),
      clear: Math.round(c.maxClear * 10) / 10,
      carve: c.carve !== null,
      shape: this.shapes.get(c) ?? null,
      lat: c.lat[c.n >> 1],
      lon: c.lon[c.n >> 1],
    }))
  }

  override dispose(): void {
    super.dispose()
    this.net.dispose()
    this.material.dispose()
    this.decalMaterial.dispose()
    this.sampleAbort.abort()
    this.carves.clear()
    this.onCarve?.([])
  }

  // -------------------------------------------------------------------------

  /** La tesela del punto y, si está cerca de un borde, las vecinas; con el punto en su marco local. */
  private nearTiles(p: Vector3, fn: (t: BridgeTile, q: Vector3) => void): void {
    const g = this.worldFrame.worldToGeo(p)
    const n = 2 ** Z
    const fx = lonToX(g.lon, n)
    const fy = latToY(g.lat, n)
    const tx = Math.floor(fx)
    const ty = Math.floor(fy)
    const tileM = (40075016.7 * Math.cos((g.lat * Math.PI) / 180)) / n
    const m = EDGE / tileM
    const x0 = fx - tx < m ? tx - 1 : tx
    const x1 = tx + 1 - fx < m ? tx + 1 : tx
    const y0 = fy - ty < m ? ty - 1 : ty
    const y1 = ty + 1 - fy < m ? ty + 1 : ty
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const t = this.tiles.get(`${x}/${y}`)
        if (!t || t.state !== 'ready' || t.prims.length === 0) continue
        t.frame.geoToWorld(g.lat, g.lon, g.h, _q)
        fn(t, _q)
      }
    }
  }

  protected createTile(base: LayerTile): BridgeTile {
    return { ...base, mesh: null, decal: null, prims: [], grid: new Map(), chains: [], count: 0 }
  }

  protected disposeTile(t: BridgeTile): void {
    if (t.mesh) {
      this.group.remove(t.mesh)
      t.mesh.geometry.dispose()
      t.mesh = null
    }
    if (t.decal) {
      this.decals.remove(t.decal)
      t.decal.geometry.dispose()
      t.decal = null
    }
    for (const c of t.chains) {
      for (const patch of terrainPatches(c)) {
        const e = this.carves.get(patch.key)
        if (e && --e.refs <= 0) {
          this.carves.delete(patch.key)
          this.carveDirty = true
        }
      }
    }
    this.count -= t.count
    t.chains = []
    t.prims = []
    t.grid = new Map()
    t.count = 0
  }

  /**
   * Color del firme de una cadena de carretera, de la ortofoto: el de la calzada que sigue al
   * puente en sus extremos (a nivel del suelo, sin el desplazamiento con que sale en la foto lo
   * que está en alto); si no acaba en el suelo por ningún lado, el del propio tablero en la foto.
   * Uno por cadena, para que todas las teselas que la dibujan le den el mismo.
   */
  private deckTop(c: Chain, net: BridgeNet): Promise<Color | null> {
    let p = this.tops.get(c)
    if (p) return p
    p = (async () => {
      if (!this.sampler || c.parts[0].piece.kind !== 'road' || c.companion) return null
      const pts = deckSamplePoints(c, net)
      if (pts.length < 20) return null
      const px = await this.sampler.pixels(pts, this.sampleAbort.signal)
      const col = new Color()
      return asphaltColour(px, col) ? col : null
    })().catch(() => null)
    this.tops.set(c, p)
    return p
  }

  /** La estructura (colgante, arco…) de una cadena, si public/bridges.bin dice que la tiene. */
  private plan(c: Chain, net: BridgeNet, builder: ChainBuilder, plans: Map<Chain, Promise<StructurePlan | null>>): Promise<StructurePlan | null> {
    let p = plans.get(c)
    if (!p) {
      p = (async () => {
        const recs = await bridgeRecordsNear(c)
        return recs.length ? planStructure(c, recs, net, builder) : null
      })().catch(() => null)
      plans.set(c, p)
    }
    return p
  }

  /**
   * Tras muchas teselas (un vuelo largo) la red, los perfiles y las estructuras se sueltan y se
   * empieza de cero. Las teselas ya dibujadas no los necesitan; las que se están cargando acaban
   * con los suyos; y lo nuevo sale igual, porque todo se deduce de los mismos datos.
   */
  private renew(): void {
    if (this.net.tileCount < Bridges.NET_MAX) return
    this.net = new BridgeNet()
    this.builder = new ChainBuilder(this.net, this.heights, { carve: this.opts.carve, fill: this.opts.fill, fillPad: this.opts.fillPad })
    this.plans = new Map()
    this.tops = new Map()
    this.shapes.clear()
  }

  protected async loadTile(t: BridgeTile): Promise<void> {
    const signal = t.abort.signal
    this.renew()
    const net = this.net
    const builder = this.builder
    const planCache = this.plans
    await net.close(t.x, t.y)
    if (signal.aborted || this.disposed) return
    const key = tileKey(t.x, t.y)
    const pieces = net.piecesOf(t.x, t.y)
    if (pieces.length === 0) {
      t.state = 'empty'
      return
    }
    const built = await Promise.all(pieces.map((p) => builder.chain(p)))
    if (signal.aborted || this.disposed) return
    const chains = new Set<Chain>()
    for (const c of built) if (c?.draw) chains.add(c)
    if (chains.size === 0) {
      t.state = 'empty'
      return
    }
    const plans = new Map<Chain, StructurePlan | null>()
    const tops = new Map<Chain, Color | null>()
    await Promise.all(
      [...chains].map(async (c) => {
        const [p, top] = await Promise.all([this.plan(c, net, builder, planCache), this.deckTop(c, net)])
        plans.set(c, p)
        tops.set(c, top)
        if (p?.owner === c) this.shapes.set(c, p.shape)
      }),
    )
    if (signal.aborted || this.disposed) return

    const slicer = new Slicer(5)
    const mb = new MeshBuilder()
    const prims: Prim[] = []
    for (const c of chains) {
      if (!(await slicer.yield(signal))) return
      const fr = new ChainFrame(c, t.frame)
      const plan = plans.get(c) ?? null
      this.meshChain(mb, prims, fr, key, plan, tops.get(c) ?? null)
      // la estructura entera la dibuja la tesela donde cae su centro
      if (plan && plan.owner === c && pieceTileAt(c, plan.centre) === key) buildStructure(mb, prims, fr, plan)
    }
    if (signal.aborted || this.disposed) return
    const geo = mb.build()
    if (!geo) {
      t.state = 'empty'
      return
    }
    // banda que tapa el puente pintado en la ortofoto
    let decal: Mesh | null = null
    if (this.opts.imageryUrl) {
      try {
        decal = await this.buildDecal(t, [...chains], key, signal)
      } catch {
        decal = null
      }
      if (signal.aborted || this.disposed) {
        geo.dispose()
        decal?.geometry.dispose()
        return
      }
    }

    const mesh = new Mesh(geo, this.material)
    mesh.matrixAutoUpdate = false
    mesh.matrix.copy(t.frame.worldToECEF)
    mesh.receiveShadow = true
    mesh.castShadow = false
    mesh.name = `bridges ${t.key}`
    this.group.add(mesh)
    mesh.updateMatrixWorld(true)
    t.mesh = mesh
    if (decal) {
      decal.matrixAutoUpdate = false
      decal.matrix.copy(t.frame.worldToECEF)
      decal.name = `bridge-decal ${t.key}`
      this.decals.add(decal)
      decal.updateMatrixWorld(true)
      t.decal = decal
    }
    t.prims = prims
    t.grid = new Map()
    prims.forEach((p, i) => {
      const [x0, z0, x1, z1] = primBounds(p)
      for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
        for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
          const k = (cz + 512) * 1024 + cx + 512
          const l = t.grid.get(k)
          if (l) l.push(i)
          else t.grid.set(k, [i])
        }
      }
    })
    t.chains = [...chains]
    t.count = chains.size
    this.count += t.count
    for (const c of chains) {
      for (const patch of terrainPatches(c)) {
        const e = this.carves.get(patch.key)
        if (e) e.refs++
        else {
          this.carves.set(patch.key, { patch, refs: 1 })
          this.carveDirty = true
        }
      }
    }
    t.state = 'ready'
  }

  /** Tablero, pretiles, pilas y estribos de los tramos de la cadena que caen en esta tesela. */
  private meshChain(mb: MeshBuilder, prims: Prim[], fr: ChainFrame, key: number, plan: StructurePlan | null, top: Color | null): void {
    const c = fr.chain
    const mine = (i: number) => c.parts[c.part[i]].piece.tile === key
    const depthAt = (s: number) => (plan ? plan.depth(c, s) : c.depth)
    for (let i = 0; i + 1 < c.n; i++) {
      if (!mine(i)) continue
      const piece = c.parts[c.part[i]].piece
      const hw = c.hw[i]
      const sA = c.s[i]
      const sB = c.s[i + 1]
      // (los arcos de fábrica necesitan cortes más finos que las estaciones para su intradós)
      const cuts = plan ? plan.subdiv(c, sA, sB) : 1
      for (let j = 0; j < cuts; j++) {
        const s0 = sA + ((sB - sA) * j) / cuts
        const s1 = sA + ((sB - sA) * (j + 1)) / cuts
        const sec = section(piece, hw, c.companion, plan && plan.solid(c, (s0 + s1) / 2) ? plan : null, top)
        const d0 = depthAt(s0)
        const d1 = depthAt(s1)
        // los extremos del tramo, exactos en su estación; los cortes intermedios, interpolados
        const p0 = (off: number, dy: number, out: Vector3) => (j === 0 ? fr.at(i, off, dy, out) : fr.atS(s0, off, dy, out))
        const p1 = (off: number, dy: number, out: Vector3) => (j === cuts - 1 ? fr.at(i + 1, off, dy, out) : fr.atS(s1, off, dy, out))
        p0(sec.mid, -d0 / 2, _in)
        _in.lerp(p1(sec.mid, -d1 / 2, _a), 0.5)
        const m = sec.pts.length
        for (let e = 0; e < m; e++) {
          const [o0, y0, low0] = sec.pts[e]
          const [o1, y1, low1] = sec.pts[(e + 1) % m]
          // (low = el punto baja con el canto del tablero)
          p0(o0, low0 ? -d0 * y0 : y0, _a)
          p0(o1, low1 ? -d0 * y1 : y1, _b)
          p1(o1, low1 ? -d1 * y1 : y1, _c)
          p1(o0, low0 ? -d1 * y0 : y0, _d)
          mb.quad(_a, _b, _c, _d, sec.cols[e], _in, e === sec.surface && sec.marks > 0 ? { uv: [o0, s0, o1, s0, o1, s1, o0, s1], kind: sec.marks, hw } : undefined)
        }
        p0(sec.mid, 0, _a)
        p1(sec.mid, 0, _b)
        prims.push({
          k: 0,
          x0: _a.x,
          z0: _a.z,
          x1: _b.x,
          z1: _b.z,
          y0: _a.y,
          y1: _b.y,
          b0: _a.y - d0,
          b1: _b.y - d1,
          hw: sec.half * Math.max(c.mitre[i], c.mitre[i + 1]),
          rail: sec.rail,
        })
      }
    }
    if (c.companion) return
    // pilas
    const piece0 = c.parts[0].piece
    for (const s of c.piers) {
      if (plan && !plan.pierAllowed(c, s)) continue
      const i = Math.min(c.n - 2, lowerStation(c, s))
      if (!mine(i)) continue
      const width = 2 * c.hw[i]
      const top = fr.atS(s, 0, -depthAt(s), _a)
      const height = profileAt(c, c.deck, s) - profileAt(c, c.ground, s)
      const [ux, uz] = fr.dirAt(s)
      const narrow = piece0.kind === 'path'
      const hb = narrow ? Math.max(0.35, 0.2 * width) : Math.min(2.8, Math.max(0.45, 0.2 * width)) * (1 + Math.min(0.5, height / 160))
      const ha = narrow ? 0.35 : Math.min(1.7, 0.5 + 0.014 * height)
      const y0 = top.y - height - 2.5 + depthAt(s)
      mb.box(top.x, top.z, ux, uz, ha, hb, y0, top.y, PIER, false)
      prims.push({ k: 1, cx: top.x, cz: top.z, ux, uz, ha, hb, y0, y1: top.y })
    }
    // estribos: un macizo bajo cada extremo que vuelve al suelo
    for (const [terminal, i, s] of [
      [c.startTerminal, 0, 0],
      [c.endTerminal, c.n - 2, c.len],
    ] as Array<[boolean, number, number]>) {
      if (!terminal || i < 0 || !mine(i)) continue
      let low = Infinity
      for (let k = 0; k < c.n; k++) if (Math.abs(c.s[k] - s) < 14) low = Math.min(low, c.ground[k])
      const end = i === 0 ? 0 : c.n - 1
      const top = fr.at(end, 0, -0.2, _a)
      const [ux, uz] = fr.dirAt(s)
      const y0 = top.y - (c.deck[end] - low) - 3
      const hb = c.hw[i] + 0.3
      mb.box(top.x, top.z, ux, uz, 1.5, hb, y0, top.y, CONCRETE, true)
      prims.push({ k: 1, cx: top.x, cz: top.z, ux, uz, ha: 1.5, hb, y0, y1: top.y })
    }
  }

  /**
   * Banda sobre el terreno, bajo el tablero, del color de la ortofoto a los lados del puente
   * (agua, cauce, campo): tapa el puente pintado, que si no se vería en el suelo bajo el de
   * verdad. No ilumina ni da sombra: es «terreno» (alfa 1 = albedo, como la ortofoto).
   */
  private async buildDecal(t: BridgeTile, chains: Chain[], key: number, signal: AbortSignal): Promise<Mesh | null> {
    // solo donde el tablero va claramente por encima del suelo
    const wanted = chains.filter((c) => c.maxClear >= 3)
    if (wanted.length === 0) return null
    const ortho = await loadOrthoMosaic(this.opts.imageryUrl!, t.x, t.y, signal)
    if (!ortho || signal.aborted) return null
    const n = 2 ** Z
    const size = ortho.width
    const px = ortho.data
    /** color de la ortofoto (lineal) en un punto, promediando 3×3 píxeles; null fuera de la tesela */
    const colourAt = (lat: number, lon: number, out: Color): boolean => {
      const fx = Math.round((lonToX(lon, n) - t.x) * size)
      const fy = Math.round((latToY(lat, n) - t.y) * size)
      if (fx < 1 || fy < 1 || fx >= size - 1 || fy >= size - 1) return false
      let r = 0
      let g = 0
      let b = 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const o = ((fy + dy) * size + fx + dx) * 4
          r += px[o]
          g += px[o + 1]
          b += px[o + 2]
        }
      }
      out.setRGB(r / 9 / 255, g / 9 / 255, b / 9 / 255, 'srgb')
      return true
    }
    const mb = new MeshBuilder()
    const v = new Vector3()
    const colL = new Color()
    const colR = new Color()
    const mix = new Color()
    // («dentro» = muy por debajo: las caras miran hacia arriba)
    const below = new Vector3(0, -1e7, 0)
    for (const c of wanted) {
      const { mLat, mLon } = c
      // por estación: puntos de los dos bordes de la banda sobre el terreno y su color
      const idx: number[] = []
      for (let i = 0; i < c.n; i++) if (c.deck[i] - c.ground[i] >= 1.5 && c.parts[c.part[Math.min(i, c.n - 2)]].piece.tile === key) idx.push(i)
      if (idx.length < 2) continue
      type Row = { i: number; pts: Vector3[]; cols: Color[] }
      const rows: Row[] = []
      for (const i of idx) {
        // cuanto más alto el tablero, más desplazado sale el puente en la foto: banda más ancha
        const clear = c.deck[i] - c.ground[i]
        const half = c.hw[i] + 1.5 + Math.min(10, 0.18 * clear)
        const geo = (off: number): [number, number] => {
          const k = off * c.mitre[i]
          return [c.lat[i] - (k * c.te[i]) / mLat, c.lon[i] + (k * c.tn[i]) / mLon]
        }
        const [laL, loL] = geo(-(half + 3))
        const [laR, loR] = geo(half + 3)
        if (!colourAt(laL, loL, colL) || !colourAt(laR, loR, colR)) continue
        const pts: Vector3[] = []
        const cols: Color[] = []
        let ok = true
        for (let k = 0; k <= 4; k++) {
          const f = k / 4
          const [la, lo] = geo(-half + 2 * half * f)
          let h = this.heights.sample(la, lo)
          if (h === null) {
            ok = false
            break
          }
          if (c.carve) h = c.carve.apply(la, lo, h)
          pts.push(t.frame.geoToWorld(la, lo, h + 0.25, v).clone())
          cols.push(mix.copy(colL).lerp(colR, f).clone())
        }
        if (ok) rows.push({ i, pts, cols })
      }
      // suavizar los colores a lo largo (coches, barcas y sombras de la foto)
      for (let k = 0; k < 5; k++) {
        const src = rows.map((r) => r.cols[k].clone())
        rows.forEach((r, j) => {
          let cr = 0
          let cg = 0
          let cb = 0
          let cnt = 0
          for (let q = Math.max(0, j - 2); q <= Math.min(rows.length - 1, j + 2); q++) {
            cr += src[q].r
            cg += src[q].g
            cb += src[q].b
            cnt++
          }
          r.cols[k].setRGB(cr / cnt, cg / cnt, cb / cnt)
        })
      }
      for (let j = 0; j + 1 < rows.length; j++) {
        const r0 = rows[j]
        const r1 = rows[j + 1]
        if (r1.i - r0.i > 2) continue // hueco (tramo a ras de suelo o fuera de la foto)
        for (let k = 0; k < 4; k++) {
          mix.copy(r0.cols[k]).add(r0.cols[k + 1]).add(r1.cols[k]).add(r1.cols[k + 1]).multiplyScalar(0.25)
          mb.quad(r0.pts[k], r0.pts[k + 1], r1.pts[k + 1], r1.pts[k], mix, below)
        }
      }
    }
    const geo = mb.build()
    if (!geo) return null
    geo.deleteAttribute('rd')
    const mesh = new Mesh(geo, this.decalMaterial)
    mesh.castShadow = false
    mesh.receiveShadow = false
    return mesh
  }
}

/** Parches de terreno de una cadena: el rebaje bajo el tablero y el relleno de los accesos. */
function terrainPatches(c: Chain): TerrainPatch[] {
  return c.carve ? [c.carve, ...c.fills] : c.fills
}

/**
 * Puntos [lat, lon] donde mirar en la foto el color del firme de una cadena (ver deckTop): a lo
 * ancho de la calzada (sin los bordes), de 4 a 40 m por las calles que siguen al puente en los
 * extremos que vuelven al suelo; si no hay, sobre el tablero (sin los extremos).
 */
function deckSamplePoints(c: Chain, net: BridgeNet): Array<[number, number]> {
  const pts: Array<[number, number]> = []
  const across = Math.max(0, c.hw[0] - 1.2)
  const offs: number[] = []
  for (let o = -across; o <= across + 1e-6; o += 1.5) offs.push(o)
  for (const [term, i] of [
    [c.startTerminal, 0],
    [c.endTerminal, c.n - 1],
  ] as Array<[boolean, number]>) {
    if (!term) continue
    const lat = c.lat[i]
    const lon = c.lon[i]
    const [gx, gy] = geoToUnit(lat, lon)
    for (const w of net.groundWaysFrom(gx, gy, 4)) {
      // la calle en metros (este, norte) desde el extremo
      const e: number[] = []
      const nn: number[] = []
      for (let k = 0; k < w.gx.length; k++) {
        const [la, lo] = unitToGeo(w.gx[k], w.gy[k])
        e.push((lo - lon) * c.mLon)
        nn.push((la - lat) * c.mLat)
      }
      let s0 = 0
      let k = 0
      for (let s = 4; s <= 40; s += 2) {
        while (k + 1 < e.length && s0 + Math.hypot(e[k + 1] - e[k], nn[k + 1] - nn[k]) < s) {
          s0 += Math.hypot(e[k + 1] - e[k], nn[k + 1] - nn[k])
          k++
        }
        if (k + 1 >= e.length) break
        const L = Math.hypot(e[k + 1] - e[k], nn[k + 1] - nn[k])
        if (L < 1e-6) continue
        const te = (e[k + 1] - e[k]) / L
        const tn = (nn[k + 1] - nn[k]) / L
        const pe = e[k] + te * (s - s0)
        const pn = nn[k] + tn * (s - s0)
        // (a la derecha de (te, tn) = (tn, −te))
        for (const o of offs) pts.push([lat + (pn - te * o) / c.mLat, lon + (pe + tn * o) / c.mLon])
      }
    }
  }
  if (pts.length === 0) {
    for (let s = 0.2 * c.len; s <= 0.8 * c.len; s += 3) {
      const i = stationAt(c, s)
      for (const o of offs) if (Math.abs(o) <= c.hw[i] - 2) pts.push(offsetGeo(c, i, o))
    }
  }
  return pts
}

function cellKey(x: number, z: number): number {
  return (Math.floor(z / CELL) + 512) * 1024 + Math.floor(x / CELL) + 512
}

/** Estación anterior (o igual) a la posición s. */
function lowerStation(c: Chain, s: number): number {
  let lo = 0
  let hi = c.n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (c.s[mid] <= s) lo = mid
    else hi = mid
  }
  return lo
}

/** Tesela (clave) del tramo que pasa por la posición s de la cadena. */
function pieceTileAt(c: Chain, s: number): number {
  return c.parts[c.part[Math.min(c.n - 2, lowerStation(c, s))]].piece.tile
}

interface Section {
  /** contorno de la sección: [desfase, altura, ¿la altura es una fracción del canto hacia abajo?] */
  pts: Array<[number, number, boolean]>
  /** centro y semiancho del cuerpo (m desde el eje) */
  mid: number
  half: number
  cols: Color[]
  /** índice del lado que es la superficie de rodadura */
  surface: number
  /** marcas viales (0 = ninguna; ver el shader) */
  marks: number
  /** altura de los pretiles (m) */
  rail: number
}

/**
 * Sección transversal del tablero según la vía. `solid`: fábrica maciza de un puente de arcos
 * (del ancho de todo el conjunto, con la calzada y sus pretiles encima).
 */
function section(piece: BridgePiece, hw: number, companion: boolean, solid: StructurePlan | null = null, asphalt: Color | null = null): Section {
  const kind = piece.kind
  const pw = kind === 'path' ? 0.07 : kind === 'rail' ? 0.2 : 0.3
  const ph = kind === 'path' ? 1.1 : kind === 'rail' ? 0.45 : 0.85
  // viga cajón: la losa vuela a los lados; pasarelas y aceras, losa maciza
  const bw = kind === 'path' || companion ? hw : hw < 2.6 ? hw - 0.3 : hw * 0.55
  const fa = kind === 'path' || companion ? 1 : 0.28
  const rail = kind === 'path' ? RAILING : PARAPET
  const top = kind === 'path' ? PATHWAY : kind === 'rail' ? BALLAST : (asphalt ?? ASPHALT)
  let marks = 0
  const width = 2 * hw
  if (kind === 'rail') marks = 3
  else if (kind === 'road' && width >= 5.5) {
    const lanes = piece.oneway ? Math.max(1, Math.round((width - 3.5) / 3.5)) : width >= 13 ? 4 : 2
    marks = (piece.oneway ? 20 : 10) + lanes
  }
  if (solid) {
    const stone = solid.colour
    const shade = stone.clone().multiplyScalar(0.7)
    const l = -Math.max(hw, solid.extL) - 0.3
    const r = Math.max(hw, solid.extR) + 0.3
    const pws = Math.max(pw, 0.35)
    return {
      pts: [
        [-hw, ph, false],
        [-hw + pws, ph, false],
        [-hw + pws, 0, false],
        [hw - pws, 0, false],
        [hw - pws, ph, false],
        [hw, ph, false],
        [hw, -0.3, false],
        [r, -0.3, false],
        [r, 1, true],
        [l, 1, true],
        [l, -0.3, false],
        [-hw, -0.3, false],
      ],
      mid: (l + r) / 2,
      half: (r - l) / 2,
      cols: [stone, stone, top, stone, stone, stone, stone, stone, shade, stone, stone, stone],
      surface: 2,
      marks,
      rail: ph,
    }
  }
  return {
    pts: [
      [-hw, ph, false],
      [-hw + pw, ph, false],
      [-hw + pw, 0, false],
      [hw - pw, 0, false],
      [hw - pw, ph, false],
      [hw, ph, false],
      [hw, fa, true],
      [bw, 1, true],
      [-bw, 1, true],
      [-hw, fa, true],
    ],
    mid: 0,
    half: hw,
    cols: [rail, rail, top, rail, rail, CONCRETE, UNDER, UNDER, UNDER, CONCRETE],
    surface: 2,
    marks,
    rail: ph,
  }
}

/**
 * Material de los puentes: iluminado, color por vértice y marcas viales en la calzada hechas
 * en el shader con el atributo `rd` (u lateral y v a lo largo en metros, tipo, semiancho):
 * 10 + carriles = doble sentido, 20 + carriles = sentido único, 3 = vía de tren.
 */
function createBridgeMaterial(): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 })
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 rd;\nvarying vec4 vRd;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRd = rd;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec4 vRd;')
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        if (vRd.z > 0.5) {
          float u = vRd.x;
          float v = vRd.y;
          float hw = vRd.w;
          float fu = fwidth(u);
          // metros por píxel: de lejos las marcas se funden con el firme
          float near = 1.0 - smoothstep(0.12, 0.5, fu);
          if (vRd.z > 9.5) {
            float lanes = mod(vRd.z, 10.0);
            float twoWay = step(vRd.z, 19.5);
            // calzada centrada, con arcenes si sobra ancho
            float cw = min(lanes * 1.75, hw - 0.75);
            float lw = 2.0 * cw / lanes;
            float edge = 1.0 - smoothstep(0.07, 0.07 + fu, abs(abs(u) - cw));
            float x = (u + cw) / lw;
            float k = floor(x + 0.5);
            float inner = step(0.5, k) * step(k, lanes - 0.5);
            float centre = twoWay * (1.0 - step(0.25, abs(k - lanes * 0.5)));
            float dash = max(centre, step(fract(v / 12.0), 0.34));
            float lane = (1.0 - smoothstep(0.06, 0.06 + fu, abs(x - k) * lw)) * inner * dash;
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.72), max(edge, lane) * near * 0.85);
            // arcenes algo más claros
            diffuseColor.rgb *= 1.0 + 0.10 * step(cw, abs(u));
          } else {
            // vía: traviesas y carriles sobre el balasto
            float sleeper = step(fract(v / 0.6), 0.42) * step(abs(u), 1.25);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.40, 0.37), sleeper * near * 0.7);
            float railLine = 1.0 - smoothstep(0.05, 0.05 + fu, abs(abs(u) - 0.72));
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.10, 0.09, 0.09), railLine * (0.35 + 0.65 * near));
          }
        }`,
      )
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n\tgl_FragColor.a = 0.0;')
  }
  m.customProgramCacheKey = () => 'osm-bridges-v1'
  return m
}
