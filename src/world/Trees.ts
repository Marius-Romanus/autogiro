// Árboles 3D colocados donde la ortofoto muestra copas de árbol.
//
// OpenStreetMap apenas tiene árboles sueltos, pero la ortofoto (PNOA, ~1,8 m/píxel
// a z16) sí: cada encina, olivo o pino es una mancha oscura y verdosa. Por tesela
// z14 se clasifica cada píxel (oscuro + exceso de verde), se suaviza y se pone un
// árbol en cada máximo local, con un tamaño según lo que ocupa la mancha y el color
// de la propia foto. Así salen los olivares en sus filas, las dehesas, los pinares
// y el arbolado urbano donde están de verdad.
//
// Se descartan el agua, los edificios, las carreteras y las pistas (capas de
// OpenFreeMap), que también pueden salir oscuras o verdosas en la foto.
//
// Dibujo: dos mallas instanciadas por tesela (frondosa redondeada y conífera), con
// dos niveles de detalle según la distancia; materiales iluminados como los
// edificios (alfa = 0) y una variación de luz en la copa hecha en el shader.

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  type Texture,
} from 'three'
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { VectorTile } from '@mapbox/vector-tile'
import type { GeoFrame } from './GeoFrame.ts'
import type { HeightSource } from './HeightSource.ts'
import { classifyRings, fetchVectorTile, latToY, loadOrthoMosaic, lonToX, xToLon, yToLat, Z } from './mapTiles.ts'
import { Slicer, TileLayer, type LayerTile } from './TileLayer.ts'

/** Umbrales del detector de copas (sRGB 0..255). */
export const TREE_DETECT = {
  /** luminancia máxima de una copa (más claro = campo, pasto, cultivo) */
  maxLum: 100,
  /** luminancia mínima (más oscuro = sombra negra o agua profunda) */
  minLum: 14,
  /** exceso de verde normalizado (2G − R − B) / (R + G + B) mínimo */
  minExg: 0.035,
  /** puntuación suavizada mínima de un máximo para poner un árbol */
  minScore: 0.16,
}

interface TreeTile extends LayerTile {
  meshes: InstancedMesh[]
  detail: boolean
  /** para colisiones: x, z, radio, base, copa (coordenadas locales de la tesela) */
  hit: Float32Array
  /** rejilla 64×64 sobre la tesela: inicio de cada celda en `order` */
  cellStart: Uint32Array
  order: Uint32Array
  half: number
  count: number
}

const GRID = 64

export class Trees extends TileLayer<TreeTile> {
  count = 0
  /** máximo de árboles por tesela (se aclaran al azar por encima) */
  maxPerTile = 30000
  private readonly heights: HeightSource
  private readonly imageryUrl: string
  private readonly material: MeshStandardMaterial
  /** geometría por forma: [lejos, cerca] */
  private readonly geo: Record<Kind, [BufferGeometry, BufferGeometry]>

  constructor(worldFrame: GeoFrame, heights: HeightSource, imageryUrl: string) {
    super(worldFrame, 'trees')
    this.radius = 1800
    this.heights = heights
    this.imageryUrl = imageryUrl
    this.material = createTreeMaterial()
    this.geo = {
      round: [makeRoundTree(0), makeRoundTree(1)],
      pine: [makePine(0), makePine(1)],
      cypress: [makeCypress(5), makeCypress(8)],
    }
  }

  setEnvMap(tex: Texture | null): void {
    const m = this.material
    if ((m.envMap === null) !== (tex === null)) m.needsUpdate = true
    m.envMap = tex
    m.envMapIntensity = 1
  }

  /** ¿El punto (mundo) está dentro de la copa de algún árbol? */
  collides(p: Vector3): boolean {
    const t = this.tileAt(p, _q)
    if (!t || t.count === 0) return false
    const cs = (2 * t.half) / GRID
    const cx = Math.floor((_q.x + t.half) / cs)
    const cz = Math.floor((_q.z + t.half) / cs)
    for (let j = cz - 1; j <= cz + 1; j++) {
      for (let i = cx - 1; i <= cx + 1; i++) {
        if (i < 0 || j < 0 || i >= GRID || j >= GRID) continue
        const cell = j * GRID + i
        for (let k = t.cellStart[cell]; k < t.cellStart[cell + 1]; k++) {
          const o = 5 * t.order[k]
          const h = t.hit
          const dx = _q.x - h[o]
          const dz = _q.z - h[o + 1]
          if (dx * dx + dz * dz < h[o + 2] * h[o + 2] && _q.y > h[o + 3] && _q.y < h[o + 4]) return true
        }
      }
    }
    return false
  }

  /**
   * Altura (m) del árbol más alto cuya copa queda a menos de `r` metros de (lat°, lon°): 0 si no hay
   * ninguno y −1 si esa tesela aún no está cargada. Para el viento (abrigo y rugosidad del arbolado).
   */
  canopyAtGeo(lat: number, lon: number, r: number): number {
    const n = 2 ** this.zoom
    const t = this.tiles.get(`${Math.floor(lonToX(lon, n))}/${Math.floor(latToY(lat, n))}`)
    if (!t || (t.state !== 'ready' && t.state !== 'empty')) return -1
    if (!t.count || !t.hit) return 0
    t.frame.geoToWorld(lat, lon, 0, _q)
    const cs = (2 * t.half) / GRID
    const cx = Math.floor((_q.x + t.half) / cs)
    const cz = Math.floor((_q.z + t.half) / cs)
    let best = 0
    for (let j = cz - 1; j <= cz + 1; j++) {
      for (let i = cx - 1; i <= cx + 1; i++) {
        if (i < 0 || j < 0 || i >= GRID || j >= GRID) continue
        const cell = j * GRID + i
        for (let k = t.cellStart[cell]; k < t.cellStart[cell + 1]; k++) {
          const o = 5 * t.order[k]
          const h = t.hit
          const dx = _q.x - h[o]
          const dz = _q.z - h[o + 1]
          const rr = r + h[o + 2]
          // (la copa va del 30 % al 95 % de la altura del árbol)
          if (dx * dx + dz * dz < rr * rr) best = Math.max(best, (h[o + 4] - h[o + 3]) / 0.65)
        }
      }
    }
    return best
  }

  override dispose(): void {
    super.dispose()
    this.material.dispose()
    for (const g of Object.values(this.geo).flat()) g.dispose()
  }

  // -------------------------------------------------------------------------

  protected createTile(base: LayerTile): TreeTile {
    return { ...base, meshes: [], detail: false, hit: new Float32Array(0), cellStart: new Uint32Array(0), order: new Uint32Array(0), half: 1, count: 0 }
  }

  protected disposeTile(t: TreeTile): void {
    for (const m of t.meshes) {
      this.group.remove(m)
      m.dispose()
    }
    this.count -= t.count
    t.meshes = []
    t.count = 0
  }

  /** Detalle alto solo cerca de la cámara. */
  protected override afterUpdate(): void {
    for (const t of this.tiles.values()) {
      if (t.state !== 'ready') continue
      const detail = t.dist < 0.3
      if (detail === t.detail) continue
      t.detail = detail
      const lod = detail ? 1 : 0
      for (const m of t.meshes) m.geometry = this.geo[m.userData.kind as Kind][lod]
    }
  }

  protected async loadTile(t: TreeTile): Promise<void> {
    const signal = t.abort.signal
    const n = 2 ** Z
    const north = yToLat(t.y, n)
    const south = yToLat(t.y + 1, n)
    const west = xToLon(t.x, n)
    const east = xToLon(t.x + 1, n)
    let vtError: unknown = null
    const [vt, ortho] = await Promise.all([
      fetchVectorTile(t.x, t.y, signal).catch((e) => {
        vtError = e
        return null
      }),
      loadOrthoMosaic(this.imageryUrl, t.x, t.y, signal),
      this.heights.ensure(south - 0.001, west - 0.001, north + 0.001, east + 0.001),
    ])
    if (signal.aborted) return
    // Sin el mapa no se sabe dónde está el agua: el mar verdoso o las rocas con algas de la foto
    // saldrían llenos de árboles (bahía de Botafogo, Campo del Sur). Mejor ninguno hasta que llegue:
    // la tesela queda fallida y TileLayer la vuelve a pedir.
    if (!vt) throw vtError ?? new Error('sin la tesela vectorial')
    if (!ortho) {
      t.state = 'empty'
      return
    }
    const W = ortho.width
    const H = ortho.height
    const slicer = new Slicer(6)
    // metros por píxel del mosaico en esta latitud
    const mpp = (40075016.7 * Math.cos((t.frame.latDeg * Math.PI) / 180)) / n / W
    const excl = await exclusionMask(vt, W, mpp, slicer, signal)
    if (signal.aborted) return
    if (!excl) throw new Error('no se pudo dibujar la máscara de agua y calles')

    // 1) puntuación por píxel
    const px = ortho.data
    const score = new Float32Array(W * H)
    const isTree = new Uint8Array(W * H)
    const D = TREE_DETECT
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        const o = 4 * i
        if (excl && excl[o] > 0) continue
        const r = px[o]
        const g = px[o + 1]
        const b = px[o + 2]
        const lum = 0.299 * r + 0.587 * g + 0.114 * b
        if (lum < D.minLum || lum > D.maxLum) continue
        const exg = (2 * g - r - b) / (r + g + b + 1)
        if (exg < D.minExg || g + 2 < b) continue
        isTree[i] = 1
        score[i] = Math.min(1, (D.maxLum + 15 - lum) / D.maxLum) * Math.min(1, Math.max(0.3, exg * 5))
      }
      if ((y & 63) === 0 && !(await slicer.yield(signal))) return
    }
    // 2) suavizado 3×3 (separable)
    const tmp = new Float32Array(W * H)
    const S = new Float32Array(W * H)
    for (let y = 0; y < H; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x
        tmp[i] = score[i - 1] + score[i] + score[i + 1]
      }
    }
    for (let y = 1; y < H - 1; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        S[i] = (tmp[i - W] + tmp[i] + tmp[i + W]) / 9
      }
      if ((y & 127) === 0 && !(await slicer.yield(signal))) return
    }
    // 3) máximos locales (5×5): una copa por máximo
    const cand: number[] = [] // x, y, cobertura
    for (let y = 2; y < H - 2; y++) {
      for (let x = 2; x < W - 2; x++) {
        const i = y * W + x
        const s = S[i]
        if (s < D.minScore) continue
        let isMax = true
        let cov = 0
        for (let dy = -2; dy <= 2 && isMax; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const j = i + dy * W + dx
            if (S[j] > s || (S[j] === s && j < i)) {
              isMax = false
              break
            }
            cov += isTree[j]
          }
        }
        if (isMax) cand.push(x, y, cov / 25)
      }
      if ((y & 63) === 0 && !(await slicer.yield(signal))) return
    }
    const total = cand.length / 3
    if (total === 0) {
      t.state = 'empty'
      return
    }

    // 4) árboles: posición sobre el MDT, tamaño, especie y color de la foto
    const keep = Math.min(1, this.maxPerTile / total)
    const byKind: Record<Kind, TreeInst[]> = { round: [], pine: [], cypress: [] }
    const col = new Color()
    for (let k = 0; k < total; k++) {
      // (al principio: al final del bucle, las candidatas descartadas se lo saltaban)
      if ((k & 1023) === 0 && k > 0 && !(await slicer.yield(signal))) return
      const x = cand[3 * k]
      const y = cand[3 * k + 1]
      const cov = cand[3 * k + 2]
      const rnd = hash(x * 7.13 + t.x * 1.7, y * 3.91 + t.y * 2.3)
      if (keep < 1 && hash(y * 1.37 + 5.1, x * 2.11) > keep) continue
      const fx = (x + (rnd - 0.5) * 0.8) / W
      const fy = (y + (hash(x + 0.31, y + 0.77) - 0.5) * 0.8) / H
      const lat = yToLat(t.y + fy, n)
      const lon = xToLon(t.x + fx, n)
      const h = this.heights.sample(lat, lon)
      if (h === null) continue
      // color medio de los píxeles de copa alrededor
      let r = 0
      let g = 0
      let b = 0
      let c = 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const j = (y + dy) * W + x + dx
          if (!isTree[j]) continue
          r += px[4 * j]
          g += px[4 * j + 1]
          b += px[4 * j + 2]
          c++
        }
      }
      if (c === 0) continue
      r /= c
      g /= c
      b /= c
      const lum = 0.299 * r + 0.587 * g + 0.114 * b
      // pinos: verde azulado muy oscuro, y más en la montaña; algún ciprés suelto
      const rnd2 = hash(rnd * 3.7, cov + 0.5)
      const kind: Kind = rnd2 < 0.035 ? 'cypress' : (b > r * 0.92 && lum < 55 && rnd2 < 0.75) || (h > 1300 && rnd2 < 0.6) ? 'pine' : 'round'
      const D0 = (2.4 + 5.6 * cov) * (0.8 + 0.45 * hash(rnd, cov))
      const diam = Math.max(1.8, Math.min(11, D0))
      const hr = hash(cov + 1, rnd)
      const height = kind === 'pine' ? diam * (1.6 + 0.8 * hr) + 1 : kind === 'cypress' ? diam * (1.9 + 0.8 * hr) : diam * (0.7 + 0.4 * hr) + 0.6
      const width = kind === 'cypress' ? diam * 0.45 : diam
      // la foto ya trae la copa en sombra (algo más clara como albedo) y tira a amarillo por la luz del sol
      col.setRGB(Math.min(1, (r / 255) * 0.98), Math.min(1, (g / 255) * 1.12), Math.min(1, (b / 255) * 1.05), SRGBColorSpace)
      const p = t.frame.geoToWorld(lat, lon, h - 0.35, new Vector3())
      byKind[kind].push({ p, w: width, h: height, rot: rnd * Math.PI * 2, r: col.r, g: col.g, b: col.b })
    }
    if (signal.aborted || this.disposed) return
    const list = [...byKind.round, ...byKind.pine, ...byKind.cypress]
    const all = list.length
    if (all === 0) {
      t.state = 'empty'
      return
    }
    t.detail = t.dist < 0.3
    const lod = t.detail ? 1 : 0
    for (const kind of ['round', 'pine', 'cypress'] as Kind[]) {
      if (byKind[kind].length) t.meshes.push(this.makeMesh(t, byKind[kind], this.geo[kind][lod], kind))
    }
    this.buildHitGrid(t, list, mpp * W)
    t.count = all
    this.count += all
    t.state = 'ready'
  }

  private makeMesh(t: TreeTile, list: TreeInst[], geo: BufferGeometry, kind: Kind): InstancedMesh {
    const m = new InstancedMesh(geo, this.material, list.length)
    const c = new Color()
    for (let i = 0; i < list.length; i++) {
      const a = list[i]
      _rot.setFromAxisAngle(_up, a.rot)
      _m.compose(a.p, _rot, _s.set(a.w, a.h, a.w))
      m.setMatrixAt(i, _m)
      m.setColorAt(i, c.setRGB(a.r, a.g, a.b))
    }
    m.instanceMatrix.needsUpdate = true
    if (m.instanceColor) m.instanceColor.needsUpdate = true
    m.computeBoundingSphere()
    m.matrixAutoUpdate = false
    m.matrix.copy(t.frame.worldToECEF)
    m.castShadow = false
    m.receiveShadow = true
    m.userData.kind = kind
    m.name = `trees ${kind} ${t.key}`
    this.group.add(m)
    m.updateMatrixWorld(true)
    return m
  }

  /** Rejilla de colisión: copa como cilindro (el tronco no cuenta). */
  private buildHitGrid(t: TreeTile, list: TreeInst[], tileM: number): void {
    const half = tileM / 2
    const cs = tileM / GRID
    const hit = new Float32Array(list.length * 5)
    const cellOf = new Uint32Array(list.length)
    const counts = new Uint32Array(GRID * GRID + 1)
    list.forEach((a, i) => {
      hit[5 * i] = a.p.x
      hit[5 * i + 1] = a.p.z
      hit[5 * i + 2] = a.w * 0.35
      hit[5 * i + 3] = a.p.y + a.h * 0.3
      hit[5 * i + 4] = a.p.y + a.h * 0.95
      const cx = Math.min(GRID - 1, Math.max(0, Math.floor((a.p.x + half) / cs)))
      const cz = Math.min(GRID - 1, Math.max(0, Math.floor((a.p.z + half) / cs)))
      cellOf[i] = cz * GRID + cx
      counts[cellOf[i] + 1]++
    })
    for (let i = 0; i < GRID * GRID; i++) counts[i + 1] += counts[i]
    const fill = counts.slice()
    const order = new Uint32Array(list.length)
    for (let i = 0; i < list.length; i++) order[fill[cellOf[i]]++] = i
    t.hit = hit
    t.cellStart = counts
    t.order = order
    t.half = half
  }
}

type Kind = 'round' | 'pine' | 'cypress'

interface TreeInst {
  p: Vector3
  w: number
  h: number
  rot: number
  r: number
  g: number
  b: number
}

// ---------------------------------------------------------------------------
// Máscara de exclusión (agua, edificios, carreteras, pistas) dibujada desde la tesela vectorial
// ---------------------------------------------------------------------------

/** Ancho (m) con el que se excluye cada clase de vía. */
const ROAD_WIDTH: Record<string, number> = {
  motorway: 32,
  trunk: 26,
  primary: 20,
  secondary: 15,
  tertiary: 12,
  minor: 9,
  service: 6,
  rail: 9,
  transit: 8,
  raceway: 12,
  busway: 10,
}

async function exclusionMask(vt: VectorTile, size: number, mpp: number, slicer: Slicer, signal: AbortSignal): Promise<Uint8ClampedArray | null> {
  try {
    const cv = new OffscreenCanvas(size, size)
    const ctx = cv.getContext('2d', { willReadFrequently: true })!
    ctx.fillStyle = '#fff'
    ctx.strokeStyle = '#fff'
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    // El lienzo apunta las órdenes y las dibuja de golpe cuando se lee: leer un píxel cada poco
    // hace que dibuje por tandas (el resultado es el mismo), y así ese trabajo entra en los tramos
    // que mide el Slicer en vez de caer todo junto en el getImageData del final (25 ms seguidos).
    let ops = 0
    const pause = (): Promise<boolean> => {
      ctx.getImageData(0, 0, 1, 1)
      return slicer.yield(signal)
    }
    const draw = async (layerName: string, widthOf: (props: Record<string, unknown>) => number, polyBuffer = 0) => {
      const layer = vt.layers[layerName]
      if (!layer) return
      const k = size / layer.extent
      for (let i = 0; i < layer.length; i++) {
        if ((i & 31) === 0 && !(await pause())) return
        const f = layer.feature(i)
        const props = f.properties as Record<string, unknown>
        const geom = f.loadGeometry()
        if (f.type === 3) {
          for (const poly of classifyRings(geom)) {
            const path = new Path2D()
            for (const ring of poly) {
              ring.forEach((p, j) => (j === 0 ? path.moveTo(p.x * k, p.y * k) : path.lineTo(p.x * k, p.y * k)))
              path.closePath()
            }
            ctx.fill(path, 'evenodd')
            if (polyBuffer > 0) {
              ctx.lineWidth = polyBuffer
              ctx.stroke(path)
            }
            // (una sola entidad de edificios trae a veces miles de polígonos)
            if ((++ops & 255) === 0 && !(await pause())) return
          }
        } else if (f.type === 2) {
          const w = widthOf(props)
          if (w <= 0) continue
          ctx.lineWidth = Math.max(1, w / mpp)
          const path = new Path2D()
          for (const line of geom) line.forEach((p, j) => (j === 0 ? path.moveTo(p.x * k, p.y * k) : path.lineTo(p.x * k, p.y * k)))
          ctx.stroke(path)
        }
      }
    }
    await draw('water', () => 0, 2)
    await draw('building', () => 0, 2)
    await draw('aeroway', (p) => (p.class === 'runway' ? 45 : p.class === 'taxiway' ? 22 : 0))
    await draw('transportation', (p) => ROAD_WIDTH[String(p.class)] ?? 0)
    return ctx.getImageData(0, 0, size, size).data
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Geometría (altura total 1 y copa de diámetro 1; la instancia la escala)
// ---------------------------------------------------------------------------

function withPart(g: BufferGeometry, part: number): BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g
  ng.deleteAttribute('uv')
  const n = ng.attributes.position.count
  ng.setAttribute('part', new BufferAttribute(new Float32Array(n).fill(part), 1))
  return ng
}

/** Copa redondeada algo irregular (encina, olivo, chopo…) sobre un tronco corto. */
function makeRoundTree(detail: number): BufferGeometry {
  let crown: BufferGeometry = new IcosahedronGeometry(0.5, detail)
  crown.deleteAttribute('uv')
  crown.deleteAttribute('normal')
  crown = mergeVertices(crown)
  const pos = crown.attributes.position as BufferAttribute
  const v = new Vector3()
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    // bultos fijos (misma forma en todas: la rotación y la escala de cada árbol la varían)
    const k =
      1 + 0.16 * Math.sin(v.x * 9.1 + v.y * 4.3) * Math.cos(v.z * 7.7 - v.y * 2.9) + 0.07 * Math.sin(v.x * 17.0 - v.z * 13.0 + v.y * 5.0)
    v.multiplyScalar(k)
    v.y = v.y * 0.66 + 0.62 // copa ancha y achatada, de ~0,25 a 1 de la altura
    pos.setXYZ(i, v.x, v.y, v.z)
  }
  crown.computeVertexNormals()
  const trunk = new CylinderGeometry(0.05, 0.075, 0.4, detail ? 6 : 4, 1, true)
  trunk.translate(0, 0.2, 0)
  return mergeGeometries([withPart(crown, 0), withPart(trunk, 1)])!
}

/** Pino: copa ovalada e irregular en lo alto de un tronco largo. */
function makePine(detail: number): BufferGeometry {
  let crown: BufferGeometry = new IcosahedronGeometry(0.5, detail)
  crown.deleteAttribute('uv')
  crown.deleteAttribute('normal')
  crown = mergeVertices(crown)
  const pos = crown.attributes.position as BufferAttribute
  const v = new Vector3()
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    const k = 1 + 0.2 * Math.sin(v.x * 8.3 - v.y * 6.1) * Math.cos(v.z * 9.7 + v.y * 3.3) + 0.08 * Math.sin(v.z * 19.0 + v.x * 11.0)
    v.multiplyScalar(k)
    v.y = v.y * 0.55 + 0.68 // de ~0,35 a 1 de la altura
    pos.setXYZ(i, v.x, v.y, v.z)
  }
  crown.computeVertexNormals()
  const trunk = new CylinderGeometry(0.035, 0.055, 0.5, detail ? 6 : 4, 1, true)
  trunk.translate(0, 0.25, 0)
  return mergeGeometries([withPart(crown, 0), withPart(trunk, 1)])!
}

/** Ciprés (y abetos de jardín): cono esbelto sobre tronco corto. */
function makeCypress(segments: number): BufferGeometry {
  let cone: BufferGeometry = new ConeGeometry(0.5, 0.86, segments, 3, true)
  cone.translate(0, 0.14 + 0.43, 0)
  cone.deleteAttribute('uv')
  cone.deleteAttribute('normal')
  cone = mergeVertices(cone)
  const pos = cone.attributes.position as BufferAttribute
  const v = new Vector3()
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    const k = 1 + 0.12 * Math.sin(v.y * 23.0 + Math.atan2(v.z, v.x) * 3)
    pos.setXYZ(i, v.x * k, v.y, v.z * k)
  }
  cone.computeVertexNormals()
  const trunk = new CylinderGeometry(0.03, 0.045, 0.2, 4, 1, true)
  trunk.translate(0, 0.1, 0)
  return mergeGeometries([withPart(cone, 0), withPart(trunk, 1)])!
}

function createTreeMaterial(): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ roughness: 0.95, metalness: 0 })
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float part;\nvarying float vPart;\nvarying float vH;\nvarying vec3 vTreeP;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vPart = part;
        vH = position.y;
        #ifdef USE_INSTANCING
          vTreeP = (instanceMatrix * vec4(position, 1.0)).xyz;
        #else
          vTreeP = position;
        #endif`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        varying float vPart;
        varying float vH;
        varying vec3 vTreeP;
        float tHash(vec3 p) {
          p = fract(p * 0.3183099 + 0.1);
          p *= 17.0;
          return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
        }
        float tNoise(vec3 x) {
          vec3 i = floor(x);
          vec3 f = fract(x);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(tHash(i), tHash(i + vec3(1, 0, 0)), f.x), mix(tHash(i + vec3(0, 1, 0)), tHash(i + vec3(1, 1, 0)), f.x), f.y),
                     mix(mix(tHash(i + vec3(0, 0, 1)), tHash(i + vec3(1, 0, 1)), f.x), mix(tHash(i + vec3(0, 1, 1)), tHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
        }`,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        if (vPart > 0.5) {
          diffuseColor.rgb = vec3(0.075, 0.058, 0.042);
        } else {
          // más oscura por debajo (la copa se hace sombra a sí misma) y racimos de hojas
          float ao = mix(0.45, 1.12, smoothstep(0.15, 1.0, vH));
          float px = length(fwidth(vTreeP));
          float leaves = tNoise(vTreeP * 1.3) * 0.65 + tNoise(vTreeP * 3.1) * 0.35;
          float k = mix(0.7 + 0.55 * leaves, 0.95, smoothstep(0.25, 0.9, px));
          diffuseColor.rgb *= ao * k;
        }`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `#include <normal_fragment_maps>
        if (vPart < 0.5) {
          // relieve de racimos de hojas en la iluminación (se apaga a distancia, donde parpadearía)
          vec3 q = vTreeP * 1.7;
          vec3 nn = vec3(tNoise(q), tNoise(q + 17.3), tNoise(q + 41.7)) - 0.5;
          float fadeN = 1.0 - smoothstep(0.12, 0.5, length(fwidth(vTreeP)));
          normal = normalize(normal + nn * 1.5 * fadeN);
        }`,
      )
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n\tgl_FragColor.a = 0.0;')
  }
  m.customProgramCacheKey = () => 'ortho-trees-v1'
  return m
}

function hash(x: number, y: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return s - Math.floor(s)
}

const _q = new Vector3()
const _m = new Matrix4()
const _rot = new Quaternion()
const _s = new Vector3()
const _up = new Vector3(0, 1, 0)
