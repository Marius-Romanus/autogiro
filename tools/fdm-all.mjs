// Pasa los bancos de pruebas del modelo de vuelo con TODOS los aparatos de src/sim/airframes.ts:
//   node tools/fdm-all.mjs [id ...]
// Por aparato: tools/fdm-validate.ts (o tools/fdm-carter.ts para el compuesto de rotor lento) y
// tools/fdm-scenarios.ts; al final, tools/fdm-ground.ts. Imprime una línea por banco y devuelve
// código de error si algo falla.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/sim/airframes.ts', import.meta.url), 'utf8')
const reg = src.slice(src.indexOf('export const AIRFRAMES'))
const all = [...reg.slice(0, reg.indexOf('}')).matchAll(/^\s*(\w+):/gm)].map((m) => m[1])
const ids = process.argv.length > 2 ? process.argv.slice(2) : all
const run = (tool, args) => {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', `tools/${tool}`, ...args], { encoding: 'utf8' })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  const lines = out.trim().split('\n')
  const bad = lines.filter((l) => l.startsWith('FALLA'))
  return { ok: r.status === 0 && bad.length === 0 && !/Error|TypeError/.test(lines.slice(-3).join(' ')), last: lines[lines.length - 1] ?? '', bad }
}
let fails = 0
for (const id of ids) {
  const af = id === 'generic' ? [] : [`af=${id}`]
  const benches = id === 'carterpav' ? [['fdm-carter.ts', []], ['fdm-scenarios.ts', af]] : [['fdm-validate.ts', af], ['fdm-scenarios.ts', af]]
  for (const [tool, args] of benches) {
    const r = run(tool, args)
    if (!r.ok) fails++
    console.log(`${r.ok ? ' OK  ' : 'FALLA'} ${id.padEnd(14)} ${tool.padEnd(17)} ${r.last}`)
    for (const b of r.bad) console.log(`        ${b.slice(0, 160)}`)
  }
}
const g = run('fdm-ground.ts', [])
if (!g.ok) fails++
console.log(`${g.ok ? ' OK  ' : 'FALLA'} ${'(todos)'.padEnd(14)} ${'fdm-ground.ts'.padEnd(17)} ${g.last}`)
for (const b of g.bad) console.log(`        ${b.slice(0, 160)}`)
console.log(fails ? `\n${fails} banco(s) con fallos.` : '\nTodos los aparatos pasan todos los bancos.')
process.exit(fails ? 1 : 0)
