// Pasa los bancos de pruebas del modelo de vuelo con TODOS los aparatos de src/sim/airframes.ts:
//   node tools/fdm-all.mjs [id ...]
// Por aparato: tools/fdm-validate.ts (o tools/fdm-carter.ts para el compuesto de rotor lento),
// tools/fdm-scenarios.ts y tools/fdm-failures.ts (combustible y fallos del motor); al final, tools/fdm-ground.ts y tools/fdm-density.ts (día caluroso). Imprime una línea por banco y devuelve
// código de error si algo falla.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/sim/airframes.ts', import.meta.url), 'utf8')
const reg = src.slice(src.indexOf('export const AIRFRAMES'))
const all = [...reg.slice(0, reg.indexOf('}')).matchAll(/^\s*(\w+):/gm)].map((m) => m[1])
// y cada aparato con su juego de flotadores (src/sim/floatKit.ts): en tierra, con el tren anfibio abajo
const kitSrc = readFileSync(new URL('../src/sim/floatKit.ts', import.meta.url), 'utf8')
const kitReg = kitSrc.slice(kitSrc.indexOf('export const FLOAT_KITS'))
const kits = [...kitReg.matchAll(/^  (\w+): \{/gm)].map((m) => `${m[1]}+flot`)
const ids = process.argv.length > 2 ? process.argv.slice(2) : [...all, ...kits]
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
  // combustible y fallos del motor (planeo con simulacro, agotamiento, consumo de crucero, fallos)
  benches.push(['fdm-failures.ts', af])
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
// día caluroso en LEMT frente a ISA (aire del menú, src/sim/airMass.ts): un atmosférico y un turbo
const dn = run('fdm-density.ts', ['af=generic', 'af=ela10'])
if (!dn.ok) fails++
console.log(`${dn.ok ? ' OK  ' : 'FALLA'} ${'(912 y 914)'.padEnd(14)} ${'fdm-density.ts'.padEnd(17)} ${dn.last}`)
for (const b of dn.bad) console.log(`        ${b.slice(0, 160)}`)
// viento del terreno (src/sim/wind): perfil, relieve, obstáculos y térmicas contra la teoría
const wn = run('wind-test.ts', [])
if (!wn.ok) fails++
console.log(`${wn.ok ? ' OK  ' : 'FALLA'} ${'(viento)'.padEnd(14)} ${'wind-test.ts'.padEnd(17)} ${wn.last}`)
for (const b of wn.bad) console.log(`        ${b.slice(0, 160)}`)
// nota de la toma de la escuela (src/school): tomas buenas y malas con el piloto de los escenarios, en
// los aparatos que ese piloto sabe posar bien (con los demás le salen flojas, y la nota lo dice)
for (const id of ['generic', 'ela07', 'ela10', 'mt03', 'cierva', 'calidus']) {
  if (process.argv.length > 2 && !ids.includes(id)) continue
  const sc = run('school-test.ts', id === 'generic' ? [] : [`af=${id}`])
  if (!sc.ok) fails++
  console.log(`${sc.ok ? ' OK  ' : 'FALLA'} ${id.padEnd(14)} ${'school-test.ts'.padEnd(17)} ${sc.last}`)
  for (const b of sc.bad) console.log(`        ${b.slice(0, 160)}`)
}
console.log(fails ? `\n${fails} banco(s) con fallos.` : '\nTodos los aparatos pasan todos los bancos.')
process.exit(fails ? 1 : 0)
