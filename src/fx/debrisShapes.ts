// Formas de los trozos sueltos del accidente (terrones, cascotes, cristales,
// hojas, ramitas). Todas caben en un cubo de 1 m centrado en el origen, para que
// se escalen igual que el antiguo cubo; varias variantes de cada una, porque una
// sola forma repetida cien veces se nota tanto como el cubo.
//
// `ShapeSet` reparte instancias entre las variantes (una InstancedMesh por
// variante con el mismo material).

import { BufferGeometry, CylinderGeometry, Float32BufferAttribute, IcosahedronGeometry, InstancedMesh, Vector3, type Color, type Material, type Matrix4 } from 'three'

/** Generador pseudoaleatorio reproducible (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Piedra / terrón / cascote: icosaedro con cada vértice desplazado hacia dentro o
 * hacia fuera y algún corte plano (cara de rotura). Caras planas (sin índices).
 */
export function rockGeometry(seed: number): BufferGeometry {
  const r = rng(seed)
  const ico = new IcosahedronGeometry(0.5, seed % 3 === 0 ? 1 : 0)
  const pos = ico.getAttribute('position')
  // el mismo vértice aparece en varias caras: desplazarlo igual en todas
  const moved = new Map<string, Vector3>()
  const v = new Vector3()
  // un corte plano en una dirección al azar (cara de rotura limpia)
  const cutN = new Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize()
  const cutD = 0.18 + r() * 0.15
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    const key = `${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`
    let m = moved.get(key)
    if (!m) {
      m = v.clone().multiplyScalar(0.62 + r() * 0.5)
      const d = m.dot(cutN)
      if (d > cutD) m.addScaledVector(cutN, cutD - d)
      moved.set(key, m)
    }
    pos.setXYZ(i, m.x, m.y, m.z)
  }
  const g = ico.index ? ico.toNonIndexed() : ico
  g.computeVertexNormals()
  return fit(g)
}

/**
 * Lasca plana irregular (cristal, trozo de teja o de revoque, hoja): polígono de
 * 4-7 lados con grosor 1 en Y. `pointy` la alarga y afila (hoja).
 */
export function shardGeometry(seed: number, pointy = false): BufferGeometry {
  const r = rng(seed)
  const n = pointy ? 6 : 4 + Math.floor(r() * 4)
  const pts: Array<[number, number]> = []
  const angles = Array.from({ length: n }, (_, i) => ((i + (pointy ? 0 : r() * 0.6)) / n) * Math.PI * 2).sort((a, b) => a - b)
  for (const a of angles) {
    if (pointy) {
      // hoja: puntas en ±X, más ancha hacia la base
      const s = Math.sin(a)
      pts.push([0.5 * Math.cos(a), 0.22 * s * (s > 0 ? 1 : 0.8)])
    } else {
      const rad = 0.3 + r() * 0.25
      pts.push([Math.cos(a) * rad, Math.sin(a) * rad])
    }
  }
  const p: number[] = []
  const tri = (a: number[], b: number[], c: number[]) => p.push(...a, ...b, ...c)
  const top = (i: number) => [pts[i][0], 0.5, pts[i][1]]
  const bot = (i: number) => [pts[i][0], -0.5, pts[i][1]]
  const ct = [0, 0.5, 0]
  const cb = [0, -0.5, 0]
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    tri(ct, top(j), top(i))
    tri(cb, bot(i), bot(j))
    tri(top(i), top(j), bot(j))
    tri(top(i), bot(j), bot(i))
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(p, 3))
  g.computeVertexNormals()
  return fit(g)
}

/** Ramita: prisma fino y algo torcido a lo largo de Y. */
export function twigGeometry(seed: number): BufferGeometry {
  const r = rng(seed)
  const g = new CylinderGeometry(0.4, 0.5, 1, 4, 2).toNonIndexed()
  const pos = g.getAttribute('position')
  const bend = (r() - 0.5) * 0.8
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i)
    pos.setX(i, pos.getX(i) + bend * (0.25 - y * y))
  }
  g.computeVertexNormals()
  return fit(g)
}

/** Centra y lleva la forma a un cubo de 1 m (como el cubo unidad al que sustituye). */
function fit(g: BufferGeometry): BufferGeometry {
  g.computeBoundingBox()
  const b = g.boundingBox!
  const c = b.getCenter(new Vector3())
  const s = b.getSize(new Vector3())
  g.translate(-c.x, -c.y, -c.z)
  g.scale(1 / Math.max(1e-3, s.x), 1 / Math.max(1e-3, s.y), 1 / Math.max(1e-3, s.z))
  g.computeVertexNormals()
  g.computeBoundingSphere()
  return g
}

/** Varias formas con el mismo material: una InstancedMesh por variante. */
export class ShapeSet {
  readonly meshes: InstancedMesh[]
  private readonly n: number[]

  constructor(geos: BufferGeometry[], material: Material, max: number, setup: (m: InstancedMesh) => void) {
    this.meshes = geos.map((g) => {
      const m = new InstancedMesh(g, material, max)
      m.count = 0
      setup(m)
      return m
    })
    this.n = geos.map(() => 0)
  }

  get variants(): number {
    return this.meshes.length
  }

  begin(): void {
    this.n.fill(0)
  }

  add(variant: number, m: Matrix4, color: Color): void {
    const i = ((variant % this.meshes.length) + this.meshes.length) % this.meshes.length
    const mesh = this.meshes[i]
    const k = this.n[i]
    if (k >= mesh.instanceMatrix.count) return
    mesh.setMatrixAt(k, m)
    mesh.setColorAt(k, color)
    this.n[i] = k + 1
  }

  end(): void {
    this.meshes.forEach((m, i) => {
      m.count = this.n[i]
      m.instanceMatrix.needsUpdate = true
      if (m.instanceColor) m.instanceColor.needsUpdate = true
    })
  }

  clear(): void {
    this.begin()
    this.end()
  }
}
