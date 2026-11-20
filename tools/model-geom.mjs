// Mide en un GLB los puntos que necesita la física (ruedas, hélice, cola, morro…).
//   node tools/model-geom.mjs public/models/ela07.glb [...]
// Ejes del modelo: x adelante, y arriba, z derecha; origen del modelo = referencia común.
import fs from 'node:fs'

function load(path) {
  const b = fs.readFileSync(path)
  const jsonLen = b.readUInt32LE(12)
  const json = JSON.parse(b.subarray(20, 20 + jsonLen).toString('utf8'))
  const bin = b.subarray(20 + jsonLen + 8)
  return { json, bin }
}

function positions({ json, bin }, accIndex) {
  const acc = json.accessors[accIndex]
  const bv = json.bufferViews[acc.bufferView]
  const stride = bv.byteStride ?? 12
  const off = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0)
  const out = new Float32Array(acc.count * 3)
  for (let i = 0; i < acc.count; i++) {
    out[i * 3] = bin.readFloatLE(off + i * stride)
    out[i * 3 + 1] = bin.readFloatLE(off + i * stride + 4)
    out[i * 3 + 2] = bin.readFloatLE(off + i * stride + 8)
  }
  return out
}

const f2 = (v) => v.toFixed(2)
for (const path of process.argv.slice(2)) {
  const g = load(path)
  const { json } = g
  const nodes = json.nodes
  const byName = Object.fromEntries(nodes.map((n) => [n.name, n]))
  const tr = (n) => (byName[n]?.translation ?? [0, 0, 0]).map(Number)
  // puntos de la célula: todo menos rotor, hélice, ruedas, pilotos y palanca
  const skip = new Set(['rotor', 'prop', 'wheel_L', 'wheel_R', 'nose_wheel', 'pilot_front', 'pilot_rear', 'stick', 'rotor_head'])
  const pts = []
  const collect = (ni, base) => {
    const n = nodes[ni]
    const t = n.translation ?? [0, 0, 0]
    const p = [base[0] + t[0], base[1] + t[1], base[2] + t[2]]
    if (n.mesh !== undefined)
      for (const prim of json.meshes[n.mesh].primitives) {
        const a = positions(g, prim.attributes.POSITION)
        for (let i = 0; i < a.length; i += 3) pts.push([a[i] + p[0], a[i + 1] + p[1], a[i + 2] + p[2]])
      }
    for (const c of n.children ?? []) collect(c, p)
  }
  for (const ni of json.scenes[json.scene ?? 0].nodes) if (!skip.has(nodes[ni].name)) collect(ni, [0, 0, 0])

  const hub = tr('rotor')
  const sel = (fn) => pts.filter(fn)
  const ext = (arr, i, sign) => arr.reduce((best, p) => (best === null || sign * p[i] > sign * best[i] ? p : best), null)
  const tail = sel((p) => p[0] < hub[0] - 1.35)
  const nose = ext(pts, 0, 1)
  const tailEnd = ext(tail, 0, -1)
  const tailLow = ext(tail, 1, -1)
  const tailHigh = ext(tail, 1, 1)
  const tailWide = ext(tail, 2, 1)
  const belly = ext(sel((p) => p[0] > 0 && p[0] < 1.3 && Math.abs(p[2]) < 0.3), 1, -1)
  const side = ext(sel((p) => p[0] > 0 && p[0] < 1.2 && p[1] > -0.6 && p[1] < 0.3), 2, 1)
  const spat = ext(sel((p) => Math.abs(p[2]) > 0.8 && p[1] < -0.5), 2, 1)
  const top = ext(sel((p) => Math.abs(p[0] - hub[0]) < 0.4 && Math.abs(p[2]) < 0.3), 1, 1)
  const show = (label, p) => console.log(`  ${label.padEnd(26)} x ${f2(p[0]).padStart(6)}  y ${f2(p[1]).padStart(6)}  z ${f2(p[2]).padStart(6)}`)
  console.log(`${path}  (${pts.length} vértices de célula)`)
  for (const n of ['rotor', 'rotor_head', 'prop', 'nose_wheel', 'wheel_L', 'wheel_R', 'rudder', 'stick', 'eye_front']) if (byName[n]) show(`nodo ${n}`, tr(n))
  show('morro (x máx)', nose)
  show('panza (y mín, x 0..1.3)', belly)
  show('costado (z máx cabina)', side)
  show('carenado/tren (z máx)', spat)
  show('mástil (y máx)', top)
  show('cola: extremo trasero', tailEnd)
  show('cola: punto más bajo', tailLow)
  show('cola: punto más alto', tailHigh)
  show('cola: punta más ancha', tailWide)
  // centro de superficies de cola: horizontal (banda fina en y con mucha envergadura) y vertical
  const span = Math.abs(tailWide[2])
  const stabPts = tail.filter((p) => Math.abs(p[2]) > span * 0.55)
  if (stabPts.length) {
    const c = [0, 1, 2].map((i) => stabPts.reduce((s, p) => s + (i === 2 ? Math.abs(p[i]) : p[i]), 0) / stabPts.length)
    const xs = stabPts.map((p) => p[0])
    const ys = stabPts.map((p) => p[1])
    console.log(`  estabilizador (z>${f2(span * 0.55)}):  x ${f2(Math.min(...xs))}..${f2(Math.max(...xs))}  y ${f2(Math.min(...ys))}..${f2(Math.max(...ys))}  centro x ${f2(c[0])} y ${f2(c[1])}  envergadura ${f2(2 * span)}`)
  }
  const finPts = tail.filter((p) => p[1] > tailLow[1] + 0.25)
  if (finPts.length) {
    const xs = finPts.map((p) => p[0])
    const ys = finPts.map((p) => p[1])
    console.log(`  zona vertical de cola:        x ${f2(Math.min(...xs))}..${f2(Math.max(...xs))}  y ${f2(Math.min(...ys))}..${f2(Math.max(...ys))}`)
  }
}
