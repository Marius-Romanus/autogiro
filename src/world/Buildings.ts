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
// Se cargan por teselas z14 (~1,9 km) alrededor de la cámara (TileLayer),
// troceando el trabajo para no dar tirones, y se descargan al alejarse.

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Mesh,
  MeshStandardMaterial,
  ShapeUtils,
  SRGBColorSpace,
  Vector2,
  Vector3,
  type Texture,
} from 'three'
import type { GeoFrame } from './GeoFrame.ts'
import type { HeightSource } from './HeightSource.ts'
import { classifyRings, fetchVectorTile, loadOrthoMosaic, xToLon, yToLat, Z, type Ring } from './mapTiles.ts'
import { Slicer, TileLayer, type LayerTile } from './TileLayer.ts'

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
}

export class Buildings extends TileLayer<BuildingTile> {
  /** edificios en escena (para el menú / depuración) */
  count = 0
  private readonly material: MeshStandardMaterial
  private readonly heights: HeightSource
  /** plantilla XYZ de la ortofoto para el color de los tejados (null = colores genéricos) */
  private readonly imageryUrl: string | null

  constructor(worldFrame: GeoFrame, heights: HeightSource, imageryUrl: string | null) {
    super(worldFrame, 'buildings')
    this.radius = 4000
    this.heights = heights
    this.imageryUrl = imageryUrl
    this.material = createBuildingMaterial()
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

  override dispose(): void {
    super.dispose()
    this.material.dispose()
  }

  // -------------------------------------------------------------------------

  protected createTile(base: LayerTile): BuildingTile {
    return { ...base, mesh: null, prisms: [] }
  }

  protected disposeTile(t: BuildingTile): void {
    if (!t.mesh) return
    this.group.remove(t.mesh)
    t.mesh.geometry.dispose()
    this.count -= (t.mesh.userData.count as number) ?? 0
    t.mesh = null
  }

  protected async loadTile(t: BuildingTile): Promise<void> {
    const signal = t.abort.signal
    const n = 2 ** Z
    const north = yToLat(t.y, n)
    const south = yToLat(t.y + 1, n)
    const west = xToLon(t.x, n)
    const east = xToLon(t.x + 1, n)
    const [vt, ortho] = await Promise.all([
      fetchVectorTile(t.x, t.y, signal),
      this.imageryUrl ? loadOrthoMosaic(this.imageryUrl, t.x, t.y, signal) : Promise.resolve(null),
      this.heights.ensure(south - 0.001, west - 0.001, north + 0.001, east + 0.001),
    ])
    if (signal.aborted) return
    const colours = ortho ? new RoofColours(ortho.data, ortho.width) : null
    const layer = vt.layers.building
    if (!layer || layer.length === 0) {
      t.state = 'empty'
      return
    }

    const builder = new GeometryBuilder()
    const E = layer.extent
    const toGeo = (px: number, py: number): [number, number] => [yToLat(t.y + py / E, n), xToLon(t.x + px / E, n)]
    // recintos de aeródromo: lo que hay dentro son hangares (aspecto de nave)
    const aerodromes = aerodromePolygons(vt, E)
    const slicer = new Slicer(6)
    let buildings = 0

    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i)
      if (f.type !== 3) continue
      const props = f.properties as Record<string, unknown>
      if (props.hide_3d) continue // contorno con partes (building:part) que ya se dibujan
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
        const hangar = aerodromes.length > 0 && inAnyPolygon(aerodromes, rings[0].pts)
        if (this.addBuilding(builder, t, rings, toGeo, height, minHeight, colour, colours, E, hangar)) buildings++
      }
      // trocear el trabajo: ~6 ms por fotograma
      if (!(await slicer.yield(signal))) return
    }
    if (signal.aborted || this.disposed) return
    if (buildings === 0) {
      t.state = 'empty'
      return
    }
    const geo = builder.build()
    const mesh = new Mesh(geo, this.material)
    mesh.matrixAutoUpdate = false
    mesh.matrix.copy(t.frame.worldToECEF)
    mesh.receiveShadow = true
    mesh.castShadow = false
    mesh.userData.count = buildings
    mesh.name = `buildings ${t.key}`
    this.group.add(mesh)
    mesh.updateMatrixWorld(true)
    t.mesh = mesh
    t.state = 'ready'
    this.count += buildings
  }

  private addBuilding(
    b: GeometryBuilder,
    t: BuildingTile,
    rings: Array<{ pts: Array<[number, number]>; cut: boolean[] }>,
    toGeo: (px: number, py: number) => [number, number],
    height: number,
    minHeight: number,
    colour: string | null,
    colours: RoofColours | null,
    E: number,
    hangar: boolean,
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
        const v = t.frame.geoToWorld(lat, lon, 0, new Vector3())
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
    const base = parted ? gMin + minHeight : gMin - 1.5
    let top = gMin + height
    if (!parted) top = Math.max(top, gMax + Math.min(2.5, height))
    if (top - base < 1) return false

    // aspecto: nave / vivienda / bloque
    const seed = hash2(cxp + t.x * E, cyp + t.y * E)
    // nave: planta grande y poca altura (las manzanas de viviendas pasan de 10 m)
    // (en un aeropuerto grande, lo alto —torres, terminales— no es un hangar)
    const industrial = (hangar && height <= 16) || (area > 2500 && height <= 10) || (area > 900 && height <= 6)
    const wall = new Color()
    if (colour && /^#?[0-9a-f]{6}$/i.test(colour)) wall.set(colour.startsWith('#') ? colour : `#${colour}`)
    else wall.set(pickWall(seed, height, industrial))
    wall.convertSRGBToLinear()
    const roof = new Color()
    const rc = colours?.at((cxp / E) * colours.size, (cyp / E) * colours.size)
    if (rc) roof.setRGB(rc[0], rc[1], rc[2], SRGBColorSpace)
    else roof.set(industrial ? '#9a9890' : seed > 0.5 ? '#a4583e' : '#8f8a82').convertSRGBToLinear()
    // un tejado en sombra en la foto no debe quedar negro
    const lum = 0.2126 * roof.r + 0.7152 * roof.g + 0.0722 * roof.b
    if (lum < 0.05) roof.multiplyScalar(0.05 / Math.max(lum, 0.005))
    roof.multiplyScalar(0.85)
    wall.multiplyScalar(0.85)

    // ventanas: altura de planta (0 = sin ventanas)
    const floorH = industrial || height < 3.2 ? 0 : height > 40 ? 3.4 : 3.0

    // paredes
    const yb = base
    const yt = top
    for (let r = 0; r < local.length; r++) {
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
          b.wall(a, c, yb, yt, nx, nz, u, u + len, base - gMin, top - gMin, floorH, wall)
        }
        u += len
      }
    }
    // tejado
    const contour = local[0].map((p) => new Vector2(p.x, p.z))
    const holes = local.slice(1).map((h) => h.map((p) => new Vector2(p.x, p.z)))
    const tris = ShapeUtils.triangulateShape(contour, holes)
    b.roof(local.flat(), tris, yt, roof)

    t.prisms.push(makePrism(local[0], base, top))
    return true
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
    const A = this.v(a.x, a.y + yb, a.z, nx, 0, nz, col, u0, v0, floorH)
    const B = this.v(c.x, c.y + yb, c.z, nx, 0, nz, col, u1, v0, floorH)
    const C = this.v(c.x, c.y + yt, c.z, nx, 0, nz, col, u1, v1, floorH)
    const D = this.v(a.x, a.y + yt, a.z, nx, 0, nz, col, u0, v1, floorH)
    if (facing > 0) {
      this.tri(A, B, C)
      this.tri(A, C, D)
    } else {
      this.tri(A, C, B)
      this.tri(A, D, C)
    }
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
    g.computeBoundingSphere()
    g.computeBoundingBox()
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
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 fac;\nvarying vec3 vFac;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFac = fac;')
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        varying vec3 vFac;
        float bHash(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }`,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        float winMask = 0.0;
        if (vFac.z > 0.5) {
          // ventanas: una cada 3,4 m en horizontal y una por planta
          vec2 g = vec2(vFac.x / 3.4, vFac.y / vFac.z);
          vec2 cell = fract(g);
          vec2 id = floor(g);
          vec2 fw = fwidth(g);
          float wx = smoothstep(0.28 - fw.x, 0.28 + fw.x, cell.x) - smoothstep(0.72 - fw.x, 0.72 + fw.x, cell.x);
          float wy = smoothstep(0.30 - fw.y, 0.30 + fw.y, cell.y) - smoothstep(0.80 - fw.y, 0.80 + fw.y, cell.y);
          float w = wx * wy * step(0.0, id.y);
          // lejos (patrón menor que un píxel): tono medio
          float far = smoothstep(0.18, 0.5, max(fw.x, fw.y));
          w = mix(w, 0.22, far);
          float r = bHash(id + 0.5);
          // cristal oscuro, o persiana a medio bajar (muy habitual en España)
          vec3 glass = vec3(0.025, 0.03, 0.035) * (0.6 + 0.8 * r);
          vec3 blind = diffuseColor.rgb * vec3(0.78, 0.72, 0.62);
          vec3 winCol = mix(glass, blind, step(0.62, r) * (1.0 - far));
          diffuseColor.rgb = mix(diffuseColor.rgb, winCol, w * 0.9);
          winMask = w * (1.0 - step(0.62, r));
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
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n\tgl_FragColor.a = 0.0;')
  }
  m.customProgramCacheKey = () => 'osm-buildings-v1'
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
