// Recorte rápido de las mallas del terreno (3d-tiles-renderer 0.5.4, GeometryClipper).
//
// Volando bajo, ImageOverlayPlugin parte cada tesela hoja del relieve en cuatro «hijas virtuales»
// para ponerles foto más fina, y QuantizedMeshPlugin saca del mismo modo las teselas que el
// servidor no tiene. Las dos cosas pasan por GeometryClipper.getClippedData, que recorre TODOS
// los triángulos de la malla una vez por cuadrante y, para cada uno, interpola la posición en sus
// tres esquinas por cada plano de corte, lo trocea, calcula una clave por vértice e interpola
// todos los atributos, con vectores genéricos y listas nuevas en cada paso. Son 100-200 ms de
// golpe en el hilo principal por tesela: el tirón más gordo que se nota en vuelo (casi la mitad
// del tiempo perdido en fotogramas lentos sobre Madrid, visto con el perfil de CPU).
//
// Casi ningún triángulo toca el corte. Aquí el valor de cada plano se calcula una vez por vértice
// (y vale para los cuatro cuadrantes), los triángulos que quedan enteros a un lado se copian o se
// descartan sin más, y solo los que cruzan un plano pasan por el código de la librería, tal cual.
// El resultado es la misma malla, bit a bit y en el mismo orden (comprobado comparando las dos
// salidas con teselas reales: ver DESARROLLO.md «Rendimiento»).
//
// La clase no se exporta: su prototipo se caza al construirse el primer recortador (ver
// `installFastClipper`). Si la librería cambia y algo no cuadra, se queda el método original.

import { Vector3, type BufferAttribute, type BufferGeometry, type Matrix4, type Mesh } from 'three'

type Corner = 'a' | 'b' | 'c'
const ABC: readonly Corner[] = ['a', 'b', 'c']

interface SplitOp {
  callback: (geometry: BufferGeometry, i0: number, i1: number, i2: number, barycoord: Vector3, matrixWorld: Matrix4) => number
  keepPositive: boolean
}

interface ClipTriangle {
  indices: Record<Corner, number>
  clipValues: Record<Corner, number>
  barycoord: Record<Corner, Vector3>
  initFromIndices(a: number, b: number, c: number): ClipTriangle
  getVertexHash(corner: number, geometry: BufferGeometry): number | string
  getVertexData(corner: number, geometry: BufferGeometry, out: Record<string, number[]>): void
}

interface ClipResult {
  index?: number[]
  vertexIsClipped?: boolean[]
  attributes?: Record<string, number[]>
}

interface Clipper {
  attributeList: null | ((key: string) => boolean) | string[]
  splitOperations: SplitOp[]
  trianglePool: { get(): ClipTriangle; reset(): void }
  splitTriangle(tri: ClipTriangle, keepNegative: boolean, out: ClipTriangle[]): void
  getClippedData(mesh: Mesh, range?: { start: number; count: number } | null, target?: ClipResult): ClipResult
}

type GetClippedData = Clipper['getClippedData'] & { fastClip?: true }

/** valores de un plano de corte en cada vértice de una geometría (valen para los cuatro cuadrantes) */
interface VertexValues {
  geometry: BufferGeometry
  matrix: Float64Array
  values: Float64Array
}

const UNIT_A = new Vector3(1, 0, 0)
const UNIT_B = new Vector3(0, 1, 0)
const UNIT_C = new Vector3(0, 0, 1)
const NORMALIZED = new Set(['normal', 'tangent', 'bitangent'])
const cache = new WeakMap<Clipper, Map<SplitOp['callback'], VertexValues>>()
const finite = new WeakMap<Clipper, WeakMap<BufferGeometry, boolean>>()

let patched = false
/**
 * Para depurar: llamadas por la vía rápida y por la original, triángulos vistos y cuántos cruzaban
 * un corte. Con `verify` a true cada recorte se hace también con el método original y se comparan
 * las dos salidas valor a valor (tal como quedan en float de 32 bits): así se comprobó que son
 * iguales, y así se vuelve a comprobar si se actualiza la librería. Con `enabled` a false todo va
 * por el método original (para medir la diferencia).
 */
export const fastClipStats = { enabled: true, fast: 0, fallback: 0, triangles: 0, slowTriangles: 0, verify: false, verified: 0, mismatches: 0, firstMismatch: '' }

/**
 * Sustituye el recorte de mallas de la librería por el rápido. `overlayPlugin`: el
 * ImageOverlayPlugin del terreno, que es quien crea los recortadores.
 */
export function installFastClipper(overlayPlugin: object): void {
  const plugin = overlayPlugin as { expandVirtualChildren?: (...args: unknown[]) => unknown }
  const expand = plugin.expandVirtualChildren
  if (typeof expand !== 'function') return
  plugin.expandVirtualChildren = function (this: unknown, ...args: unknown[]) {
    if (patched) return expand.apply(this, args)
    // La parte síncrona de expandVirtualChildren crea un recortador (`new GeometryClipper()`), y
    // su constructor asigna `trianglePool`: solo durante esa llamada, un «setter» heredado de
    // Object.prototype ve pasar esa asignación y de ahí sale el prototipo de la clase.
    Object.defineProperty(Object.prototype, 'trianglePool', {
      configurable: true,
      enumerable: false,
      set(this: object, value: unknown) {
        Object.defineProperty(this, 'trianglePool', { value, writable: true, enumerable: true, configurable: true })
        if (!patched) patchPrototype(this)
      },
    })
    try {
      return expand.apply(this, args)
    } finally {
      delete (Object.prototype as { trianglePool?: unknown }).trianglePool
    }
  }
}

function patchPrototype(instance: object): void {
  let proto = Object.getPrototypeOf(instance) as (Partial<Clipper> & object) | null
  while (proto && !Object.prototype.hasOwnProperty.call(proto, 'getClippedData')) proto = Object.getPrototypeOf(proto)
  if (!proto || typeof proto.getClippedData !== 'function' || typeof proto.splitTriangle !== 'function') return
  const original = proto.getClippedData as GetClippedData
  if (original.fastClip) return
  // (la firma con tres parámetros es la de la 0.5.4)
  if (original.length !== 1) return
  const fast: GetClippedData = function (this: Clipper, mesh, range = null, target = {}) {
    const done = fastClipStats.enabled ? clipFast(this, mesh, range, target) : null
    if (done) {
      fastClipStats.fast++
      if (fastClipStats.verify) compare(done, original.call(this, mesh, range, {}))
      return done
    }
    fastClipStats.fallback++
    return original.call(this, mesh, range, target)
  }
  fast.fastClip = true
  proto.getClippedData = fast
  patched = true
}

/** ¿Atributo sencillo, de los que se pueden leer directamente de su tabla? */
function plain(a: BufferAttribute | undefined): a is BufferAttribute {
  return Boolean(a && a.isBufferAttribute && !(a as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute && !a.normalized)
}

/**
 * Lo mismo que GeometryClipper.getClippedData; null si la malla no es de las previstas (entonces
 * la recorta el método original).
 */
function clipFast(clipper: Clipper, mesh: Mesh, range: { start: number; count: number } | null, target: ClipResult): ClipResult | null {
  const geometry = mesh.geometry
  const ops = clipper.splitOperations
  const index = geometry.index
  const attrs = geometry.attributes as Record<string, BufferAttribute>
  const position = attrs.position
  if (!index || !plain(index) || !plain(position) || ops.length === 0) return null
  if ((target.index && target.index.length) || (target.vertexIsClipped && target.vertexIsClipped.length)) return null
  const list = clipper.attributeList
  const names: string[] = []
  for (const key in attrs) {
    if (list !== null && ((list instanceof Function && !list(key)) || (Array.isArray(list) && !list.includes(key)))) continue
    const a = attrs[key]
    if (!plain(a) || !(a.array instanceof Float32Array) || a.itemSize < 1 || a.itemSize > 4) return null
    names.push(key)
  }
  // (los atributos que no salen también los lee la librería al calcular claves: que sean normales)
  // Y todo finito: la librería interpola cada esquina con los tres vértices del triángulo
  // (x·1 + y·0 + z·0), y un NaN o un infinito en un vecino le contagia el resultado.
  // (una vez por geometría: la misma se recorta cuatro veces seguidas, una por cuadrante)
  let checked = finite.get(clipper)
  if (!checked) finite.set(clipper, (checked = new WeakMap()))
  let ok = checked.get(geometry)
  if (ok === undefined) {
    ok = true
    scan: for (const key in attrs) {
      const a = attrs[key]
      if (!plain(a)) {
        ok = false
        break
      }
      const arr = a.array
      for (let i = 0; i < arr.length; i++) {
        if (arr[i] - arr[i] !== 0) {
          ok = false
          break scan
        }
      }
    }
    checked.set(geometry, ok)
  }
  if (!ok) return null

  const start = range !== null ? range.start : 0
  const end = start + (range !== null ? range.count : index.count)
  const idx = index.array
  const world = mesh.matrixWorld
  const vertexCount = position.count

  // --- el valor de cada plano en cada vértice
  let perClipper = cache.get(clipper)
  if (!perClipper) cache.set(clipper, (perClipper = new Map()))
  const cv: Float64Array[] = []
  for (const op of ops) {
    let c = perClipper.get(op.callback)
    if (!c || c.geometry !== geometry || !sameMatrix(c.matrix, world)) {
      const values = new Float64Array(vertexCount)
      for (let v = 0; v < vertexCount; v++) values[v] = op.callback(geometry, v, v, v, UNIT_A, world)
      c = { geometry, matrix: Float64Array.from(world.elements), values }
      perClipper.set(op.callback, c)
    }
    cv.push(c.values)
  }
  // comprobación: en un triángulo de verdad, la librería obtiene esos mismos valores en sus esquinas
  if (end - start >= 3) {
    const i0 = idx[start]
    const i1 = idx[start + 1]
    const i2 = idx[start + 2]
    for (let k = 0; k < ops.length; k++) {
      const cb = ops[k].callback
      if (cb(geometry, i0, i1, i2, UNIT_A, world) !== cv[k][i0] || cb(geometry, i0, i1, i2, UNIT_B, world) !== cv[k][i1] || cb(geometry, i0, i1, i2, UNIT_C, world) !== cv[k][i2])
        return null
    }
  }

  // --- salida (las mismas listas que la librería)
  const outIndex: number[] = (target.index = target.index || [])
  const outClipped: boolean[] = (target.vertexIsClipped = target.vertexIsClipped || [])
  const outAttrs: Record<string, number[]> = (target.attributes = target.attributes || {})
  for (const key of names) outAttrs[key] = []
  const arrays = names.map((key) => attrs[key].array as Float32Array)
  const sizes = names.map((key) => attrs[key].itemSize)
  const unit = names.map((key) => NORMALIZED.has(key))
  const outs = names.map((key) => outAttrs[key])
  // vértices ya emitidos: los originales por su índice, los nuevos por su clave
  const seen = new Int32Array(vertexCount).fill(-1)
  const seenNew = new Map<string, number>()
  let count = 0
  const pool = clipper.trianglePool
  const nOps = ops.length

  /** un vértice original, tal como lo dejaría getVertexData con coordenadas (1, 0, 0) */
  const emit = (v: number): number => {
    let id = seen[v]
    if (id >= 0) return id
    id = seen[v] = count++
    for (let a = 0; a < arrays.length; a++) {
      const src = arrays[a]
      const size = sizes[a]
      const out = outs[a]
      const o = v * size
      // (x + 0: la interpolación de la librería deja en +0 un −0)
      const x = src[o] + 0
      const y = size > 1 ? src[o + 1] + 0 : 0
      const z = size > 2 ? src[o + 2] + 0 : 0
      const w = size > 3 ? src[o + 3] + 0 : 0
      if (unit[a]) {
        // Vector4.normalize: divideScalar(length || 1) = multiplyScalar(1 / s)
        const s = 1 / (Math.sqrt(x * x + y * y + z * z + w * w) || 1)
        if (size === 4) out.push(x * s, y * s, z * s, w * s)
        else if (size === 3) out.push(x * s, y * s, z * s)
        else if (size === 2) out.push(x * s, y * s)
        else out.push(x * s)
      } else if (size === 4) out.push(x, y, z, w)
      else if (size === 3) out.push(x, y, z)
      else if (size === 2) out.push(x, y)
      else out.push(x)
    }
    outClipped.push(false)
    return id
  }

  for (let t = start; t < end; t += 3) {
    const i0 = idx[t]
    const i1 = idx[t + 1]
    const i2 = idx[t + 2]
    // 0: entero dentro · 1: entero fuera · 2: cruza (o toca) algún plano
    let fate = 0
    for (let k = 0; k < nOps; k++) {
      const values = cv[k]
      const a = values[i0]
      const b = values[i1]
      const c = values[i2]
      if (a > 0 && b > 0 && c > 0) {
        if (!ops[k].keepPositive) {
          fate = 1
          break
        }
      } else if (a < 0 && b < 0 && c < 0) {
        if (ops[k].keepPositive) {
          fate = 1
          break
        }
      } else {
        fate = 2
        break
      }
    }
    if (fate === 1) continue
    if (fate === 0) {
      const ia = emit(i0)
      const ib = emit(i1)
      const ic = emit(i2)
      outIndex.push(ia, ib, ic)
      continue
    }
    // --- cruza un plano: el código de la librería, sin cambiar nada
    fastClipStats.slowTriangles++
    let tris: ClipTriangle[] = [pool.get().initFromIndices(i0, i1, i2)]
    for (let k = 0; k < nOps; k++) {
      const { keepPositive, callback } = ops[k]
      const next: ClipTriangle[] = []
      for (let j = 0; j < tris.length; j++) {
        const tri = tris[j]
        const s = tri.indices
        const bc = tri.barycoord
        tri.clipValues.a = callback(geometry, s.a, s.b, s.c, bc.a, world)
        tri.clipValues.b = callback(geometry, s.a, s.b, s.c, bc.b, world)
        tri.clipValues.c = callback(geometry, s.a, s.b, s.c, bc.c, world)
        clipper.splitTriangle(tri, !keepPositive, next)
      }
      tris = next
    }
    for (let j = 0; j < tris.length; j++) {
      const tri = tris[j]
      for (let r = 0; r < 3; r++) {
        const hash = tri.getVertexHash(r, geometry)
        let id: number | undefined
        if (typeof hash === 'number') {
          id = seen[hash]
          if (id < 0) id = undefined
        } else id = seenNew.get(hash)
        if (id === undefined) {
          id = count++
          if (typeof hash === 'number') seen[hash] = id
          else seenNew.set(hash, id)
          tri.getVertexData(r, geometry, outAttrs)
          outClipped.push(tri.clipValues[ABC[r]] === 0)
        }
        outIndex.push(id)
      }
    }
    pool.reset()
  }
  fastClipStats.triangles += (end - start) / 3
  return target
}

function compare(a: ClipResult, b: ClipResult): void {
  fastClipStats.verified++
  const diff = (what: string): void => {
    fastClipStats.mismatches++
    if (!fastClipStats.firstMismatch) fastClipStats.firstMismatch = what
  }
  const same = (x: readonly unknown[] | undefined, y: readonly unknown[] | undefined, what: string, float: boolean): void => {
    if (!x || !y || x.length !== y.length) return diff(`${what}: ${x?.length} frente a ${y?.length} valores`)
    for (let i = 0; i < x.length; i++) {
      const p = float ? Math.fround(x[i] as number) : x[i]
      const q = float ? Math.fround(y[i] as number) : y[i]
      if (!Object.is(p, q)) return diff(`${what}[${i}]: ${String(x[i])} frente a ${String(y[i])}`)
    }
  }
  same(a.index, b.index, 'índices', false)
  same(a.vertexIsClipped, b.vertexIsClipped, 'vertexIsClipped', false)
  const ka = Object.keys(a.attributes ?? {})
  const kb = Object.keys(b.attributes ?? {})
  if (ka.join() !== kb.join()) return diff(`atributos: ${ka.join()} frente a ${kb.join()}`)
  for (const k of ka) same(a.attributes![k], b.attributes![k], k, true)
}

function sameMatrix(a: Float64Array, m: Matrix4): boolean {
  const e = m.elements
  for (let i = 0; i < 16; i++) if (a[i] !== e[i]) return false
  return true
}
