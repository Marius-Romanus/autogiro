// Planeo sin motor de cada aparato, sacado del propio modelo de vuelo, para la guía de emergencia:
// velocidad de mejor planeo (con el motor al ralentí, como en un simulacro, y parado), fineza,
// mínimo descenso y la altura de recogida que mejor funciona con el teclado.
//   node --experimental-strip-types tools/fdm-glide.ts [id ...] [--write]
// Con --write reescribe src/sim/glideData.ts (todos los aparatos). Hay que volver a pasarlo si
// cambia la ficha de un aparato: tools/fdm-failures.ts avisa si la tabla se ha quedado vieja.
import { writeFileSync } from 'node:fs'
import { AIRFRAMES } from '../src/sim/airframes.ts'
import { FLOAT_KITS } from '../src/sim/floatKit.ts'
import { pickAirframe } from './af-override.ts'
import { bestOf, landing, polar } from './glide-lib.ts'
import { GLIDE, type GlideData } from '../src/sim/glideData.ts'

const args = process.argv.slice(2)
const write = args.includes('--write')
const ids = args.filter((a) => !a.startsWith('-'))
// (y cada aparato con su juego de flotadores: <id>+flot)
const list = ids.length ? ids : [...Object.keys(AIRFRAMES), ...Object.keys(FLOAT_KITS).map((k) => `${k}+flot`)]
const FLARES = [3, 4, 5, 6, 7, 8, 9, 10, 12]
const out: Record<string, GlideData> = { ...GLIDE }

for (const id of list) {
  const af = pickAirframe(id)
  const idle = bestOf(polar(af, 'idle'))
  const off = bestOf(polar(af, 'off'))
  // recogida (motor parado, aproximación a la velocidad de mejor planeo): con el teclado, tirando
  // de la palanca a fondo desde esa altura
  const res = FLARES.map((h) => ({ h, r: landing(af, off.stick, h) }))
  const good = res.filter((x) => !x.r.crash && x.r.impact < 2.6)
  // (la más baja que posa con menos de 2 m/s; si ninguna, la más suave)
  let flare = 6
  if (good.length) flare = (good.find((x) => x.r.impact <= 2) ?? good.reduce((a, b) => (b.r.impact < a.r.impact ? b : a))).h
  const d: GlideData = {
    best: Math.round(idle.best),
    ratio: Math.round(idle.ratio * 10) / 10,
    sink: Math.round(idle.sink * 10) / 10,
    minSink: Math.round(idle.minSink * 10) / 10,
    minSinkV: Math.round(idle.minSinkV),
    bestOff: Math.round(off.best),
    ratioOff: Math.round(off.ratio * 10) / 10,
    sinkOff: Math.round(off.sink * 10) / 10,
    stickOff: Math.round(off.stick * 100) / 100,
    flare,
  }
  out[id] = d
  console.log(
    `${id.padEnd(14)} ralentí: mejor planeo ${d.best} km/h, fineza ${d.ratio}, ${d.sink} m/s; mín. descenso ${d.minSink} m/s a ${d.minSinkV} km/h | parado: ${d.bestOff} km/h, fineza ${d.ratioOff}, ${d.sinkOff} m/s | recogida ${flare} m (valen ${good.map((g) => g.h).join(', ') || 'ninguna'})`,
  )
}

if (write) {
  const body = Object.entries(out)
    .map(([id, d]) => `  ${/^\w+$/.test(id) ? id : `'${id}'`}: { ${JSON.stringify(d).slice(1, -1).replace(/"(\w+)":/g, '$1: ').replace(/,/g, ', ')} },`)
    .join('\n')
  const src = `// Planeo sin motor de cada aparato, sacado del propio modelo de vuelo: lo genera
// tools/fdm-glide.ts --write (no editar a mano; volver a generarlo si cambia la ficha de un aparato).
//   best, ratio, sink: mejor planeo con el motor al ralentí (km/h de IAS, fineza, m/s)
//   minSink, minSinkV: mínimo descenso (m/s) y a qué IAS (km/h)
//   bestOff, ratioOff, sinkOff, stickOff: lo mismo con el motor parado y la palanca con que se vuela
//   flare: altura de recogida (m) que mejor sale con el teclado, motor parado
// Con flotadores (floatKit.ts), la clave es <id>+flot.

import { AIRFRAMES, type Airframe } from './airframes.ts'

export interface GlideData {
  best: number
  ratio: number
  sink: number
  minSink: number
  minSinkV: number
  bestOff: number
  ratioOff: number
  sinkOff: number
  stickOff: number
  flare: number
}

export const GLIDE: Record<string, GlideData> = {
${body}
}

/** Clave de la tabla: el id del aparato, con «+flot» si lleva su juego de flotadores (floatKit.ts). */
export function glideKey(af: Airframe): string {
  return af.floats?.length && !AIRFRAMES[af.id]?.floats?.length ? \`\${af.id}+flot\` : af.id
}

/** Planeo del aparato (si falta en la tabla, cifras de un biplaza tipo MTOsport). */
export function glideFor(af: Airframe): GlideData {
  return GLIDE[glideKey(af)] ?? GLIDE[af.id] ?? { best: 85, ratio: 4.7, sink: -5, minSink: -4.4, minSinkV: 55, bestOff: 85, ratioOff: 4.5, sinkOff: -5.3, stickOff: 0.2, flare: 6 }
}
`
  writeFileSync(new URL('../src/sim/glideData.ts', import.meta.url), src)
  console.log('src/sim/glideData.ts escrito')
}
