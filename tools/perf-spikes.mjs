// Tirones en vuelo: perfil de CPU de la página del simulador partido por fotogramas.
//
//   node tools/perf-spikes.mjs <segundos> [perfil.json]   graba el perfil mientras se vuela y lo analiza
//   node tools/perf-spikes.mjs - <perfil.json>            analiza uno ya grabado
//
// Hace falta un Chrome con --remote-debugging-port (CDP_PORT, por defecto 9523) y el simulador
// abierto y volando en él (ver DESARROLLO.md, «Cómo medir»). Un fotograma es cada llamada a `loop`
// de main.ts; de cada uno se suma el tiempo ocupado del hilo principal (el bucle y las tareas que
// caen hasta el siguiente), que no depende de a qué ritmo entregue fotogramas el navegador. Saca:
//  - la distribución de ese tiempo y cuántos fotogramas pasan de 1,5×, 2× y 3× la mediana,
//  - a qué funciones se va el exceso de los fotogramas lentos, y los peores uno a uno,
//  - las tareas sueltas (fuera del bucle) que bloquean el hilo más de 8 y de 16 ms.
import { readFileSync, writeFileSync } from 'node:fs'
const PORT = process.env.CDP_PORT || 9523
let p
if (process.argv[2] === '-') p = JSON.parse(readFileSync(process.argv[3], 'utf8'))
else {
  const sec = +(process.argv[2] || 30)
  let wsUrl
  for (const host of ['127.0.0.1', '[::1]']) {
    try {
      const list = await (await fetch(`http://${host}:${PORT}/json/list`)).json()
      wsUrl = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))?.webSocketDebuggerUrl
      if (wsUrl) break
    } catch {}
  }
  const ws = new WebSocket(wsUrl)
  await new Promise((r) => (ws.onopen = r))
  let id = 0
  const waits = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id) }
  }
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; waits.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
  await send('Profiler.enable')
  await send('Profiler.setSamplingInterval', { interval: 200 })
  await send('Profiler.start')
  await new Promise((r) => setTimeout(r, sec * 1000))
  const { result } = await send('Profiler.stop')
  ws.close()
  p = result.profile
  writeFileSync(process.argv[3] || 'spikes.json', JSON.stringify(p))
}

const nodes = new Map(p.nodes.map((n) => [n.id, n]))
const parent = new Map()
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
const name = (n) => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop().split('?')[0]}:${n.callFrame.lineNumber + 1}`
const isLoop = (n) => n.callFrame.functionName === 'loop' && /main\.ts/.test(n.callFrame.url)
// por nodo: ¿dentro del bucle?, clave de atribución
const info = new Map()
const DEEPER = /^(render Graphics|update World|renderer\.render|WebGLRenderer\.render|render postprocessing|p\.render|update renderer-|te renderer-|update 3d-tiles|loop main|\(anon\) main\.ts)/
for (const n of p.nodes) {
  // cadena raíz → nodo
  const chain = []
  let cur = n.id
  while (cur !== undefined) { chain.push(nodes.get(cur)); cur = parent.get(cur) }
  chain.reverse() // [root, …, n]
  const li = chain.findIndex(isLoop)
  let key
  if (li >= 0) {
    // primer nivel bajo loop, bajando por los envoltorios
    let k = li + 1
    while (k < chain.length - 1 && DEEPER.test(name(chain[k]))) k++
    key = k < chain.length ? 'bucle › ' + name(chain[Math.min(k, chain.length - 1)]) : 'bucle (propio)'
  } else {
    const top = chain[1] ?? chain[0]
    key = name(top)
    // tareas: un nivel más si el de arriba es anónimo o genérico
    if (chain.length > 2 && /^\(anon\)|^run |^step |^next /.test(key)) key += ' › ' + name(chain[2])
  }
  info.set(n.id, { inLoop: li >= 0, idle: name(chain[1] ?? chain[0]).startsWith('(idle)'), key })
}

// fotogramas
const frames = []
let t = 0
let cur = null
let prevIn = false
for (let i = 0; i < p.samples.length; i++) {
  const dt = p.timeDeltas[i] / 1000
  t += dt
  const inf = info.get(p.samples[i])
  if (inf.inLoop && !prevIn) {
    cur = { t, busy: 0, loop: 0, keys: new Map() }
    frames.push(cur)
  }
  prevIn = inf.inLoop
  if (!cur || inf.idle) continue
  cur.busy += dt
  if (inf.inLoop) cur.loop += dt
  cur.keys.set(inf.key, (cur.keys.get(inf.key) ?? 0) + dt)
}
frames.pop() // el último, incompleto
const sorted = (a) => a.slice().sort((x, y) => x - y)
const q = (a, f) => sorted(a)[Math.min(a.length - 1, Math.floor(f * a.length))]
const busy = frames.map((f) => f.busy)
const med = q(busy, 0.5)
const dur = t / 1000
console.log(`${dur.toFixed(1)} s, ${frames.length} fotogramas`)
console.log(`ocupado por fotograma (ms): mediana ${med.toFixed(1)} · p90 ${q(busy, 0.9).toFixed(1)} · p95 ${q(busy, 0.95).toFixed(1)} · p99 ${q(busy, 0.99).toFixed(1)} · máx ${Math.max(...busy).toFixed(1)}`)
console.log(`del bucle: mediana ${q(frames.map((f) => f.loop), 0.5).toFixed(1)} · entre fotogramas: mediana ${q(frames.map((f) => f.busy - f.loop), 0.5).toFixed(1)}`)
for (const k of [1.5, 2, 3]) {
  const n = frames.filter((f) => f.busy > k * med).length
  console.log(`  > ${k}× la mediana (${(k * med).toFixed(1)} ms): ${n} fotogramas (${((n / dur) * 60).toFixed(0)} por minuto)`)
}
// exceso por clave en los fotogramas que pasan de 1,5× la mediana
const allKeys = new Set()
for (const f of frames) for (const k of f.keys.keys()) allKeys.add(k)
const base = new Map()
for (const k of allKeys) base.set(k, q(frames.map((f) => f.keys.get(k) ?? 0), 0.5))
const spikes = frames.filter((f) => f.busy > 1.5 * med)
const excess = new Map()
for (const f of spikes) for (const [k, v] of f.keys) { const e = v - base.get(k); if (e > 0) excess.set(k, (excess.get(k) ?? 0) + e) }
const totalExcess = spikes.reduce((s, f) => s + f.busy - med, 0)
console.log(`\nexceso total en los ${spikes.length} fotogramas lentos: ${totalExcess.toFixed(0)} ms (${((100 * totalExcess) / (dur * 1000)).toFixed(1)} % del tiempo). A qué se va:`)
for (const [k, v] of [...excess].sort((a, b) => b[1] - a[1]).slice(0, 22)) console.log(`${v.toFixed(0).padStart(6)} ms ${((100 * v) / totalExcess).toFixed(0).padStart(3)} %  ${k}`)
console.log('\nlos peores fotogramas:')
for (const f of frames.slice().sort((a, b) => b.busy - a.busy).slice(0, 12)) {
  const top = [...f.keys].map(([k, v]) => [k, v - base.get(k)]).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k.replace('bucle › ', '›')} +${v.toFixed(0)}`)
  console.log(`  t=${(f.t / 1000).toFixed(1)} s  ${f.busy.toFixed(0)} ms (bucle ${f.loop.toFixed(0)})  ${top.join(' | ')}`)
}
console.log('\nreparto del fotograma normal (mediana por clave, ms):')
for (const [k, v] of [...base].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`${v.toFixed(2).padStart(7)}  ${k}`)

// --- tareas sueltas entre fotogramas: tramos seguidos fuera del bucle con la misma función de arriba
{
  const rootKey = new Map()
  for (const n of p.nodes) {
    const chain = []
    let c = n.id
    while (c !== undefined) { chain.push(nodes.get(c)); c = parent.get(c) }
    chain.reverse()
    rootKey.set(n.id, name(chain[1] ?? chain[0]))
  }
  const tasks = new Map() // clave → [duraciones]
  let curKey = null
  let curDur = 0
  const flush = () => { if (curKey && curDur > 0) { if (!tasks.has(curKey)) tasks.set(curKey, []); tasks.get(curKey).push(curDur) } curKey = null; curDur = 0 }
  for (let i = 0; i < p.samples.length; i++) {
    const inf = info.get(p.samples[i])
    const k = inf.inLoop || inf.idle ? null : rootKey.get(p.samples[i])
    if (k === null || /^\(program\)|^\(garbage/.test(k)) { if (k === null) flush(); else curDur += p.timeDeltas[i] / 1000; continue }
    if (k !== curKey) flush()
    curKey = k
    curDur += p.timeDeltas[i] / 1000
  }
  flush()
  const rows = [...tasks].map(([k, d]) => ({ k, n8: d.filter((x) => x > 8).length, n16: d.filter((x) => x > 16).length, max: Math.max(...d), sum: d.reduce((a, b) => a + b, 0) })).filter((r) => r.n8 > 0).sort((a, b) => b.n16 - a.n16 || b.max - a.max)
  console.log('\ntareas sueltas que bloquean el hilo (nº de más de 8 ms / de más de 16 ms / la más larga / total):')
  for (const r of rows.slice(0, 16)) console.log(`${String(r.n8).padStart(4)} ${String(r.n16).padStart(4)} ${r.max.toFixed(0).padStart(5)} ms ${r.sum.toFixed(0).padStart(6)} ms  ${r.k}`)
}
