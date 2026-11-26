// Planeo sin motor de cada aparato, sacado del propio modelo de vuelo: lo genera
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
  generic: { best: 88, ratio: 4.7, sink: -5.3, minSink: -4.3, minSinkV: 60, bestOff: 89, ratioOff: 4.2, sinkOff: -5.9, stickOff: 0.13, flare: 7 },
  ela07: { best: 84, ratio: 4.7, sink: -4.8, minSink: -4.1, minSinkV: 56, bestOff: 85, ratioOff: 4.1, sinkOff: -5.6, stickOff: 0.14, flare: 7 },
  ela10: { best: 94, ratio: 5.3, sink: -5, minSink: -4.1, minSinkV: 63, bestOff: 95, ratioOff: 4.6, sinkOff: -5.9, stickOff: 0.12, flare: 6 },
  cierva: { best: 100, ratio: 5.2, sink: -5.4, minSink: -4.6, minSinkV: 66, bestOff: 99, ratioOff: 4.5, sinkOff: -6.1, stickOff: 0.05, flare: 6 },
  mt03: { best: 83, ratio: 4.7, sink: -4.8, minSink: -4.1, minSinkV: 55, bestOff: 84, ratioOff: 4.1, sinkOff: -5.7, stickOff: 0.2, flare: 7 },
  scorpion: { best: 88, ratio: 4.9, sink: -5.1, minSink: -4.2, minSinkV: 57, bestOff: 89, ratioOff: 4.3, sinkOff: -5.7, stickOff: 0.18, flare: 7 },
  jro: { best: 90, ratio: 5, sink: -5.1, minSink: -4.2, minSinkV: 61, bestOff: 91, ratioOff: 4.4, sinkOff: -5.7, stickOff: 0.13, flare: 7 },
  niki: { best: 94, ratio: 5.2, sink: -5, minSink: -4.2, minSinkV: 63, bestOff: 95, ratioOff: 4.6, sinkOff: -5.8, stickOff: 0.05, flare: 12 },
  sclightning: { best: 73, ratio: 4.5, sink: -4.5, minSink: -3.9, minSinkV: 50, bestOff: 74, ratioOff: 3.8, sinkOff: -5.5, stickOff: 0.32, flare: 8 },
  sclightning_f: { best: 77, ratio: 4.8, sink: -4.5, minSink: -3.9, minSinkV: 54, bestOff: 77, ratioOff: 4, sinkOff: -5.5, stickOff: 0.27, flare: 12 },
  calidus: { best: 93, ratio: 5.2, sink: -5.1, minSink: -4.1, minSinkV: 60, bestOff: 94, ratioOff: 4.5, sinkOff: -5.7, stickOff: 0.08, flare: 8 },
  cavalon: { best: 92, ratio: 4.8, sink: -5.4, minSink: -4.5, minSinkV: 60, bestOff: 93, ratioOff: 4.2, sinkOff: -6.2, stickOff: 0.06, flare: 7 },
  carterpav: { best: 107, ratio: 7.4, sink: -4.2, minSink: -4.1, minSinkV: 90, bestOff: 105, ratioOff: 6.2, sinkOff: -4.8, stickOff: 0.41, flare: 4 },
  vencejo: { best: 97, ratio: 6.2, sink: -4.4, minSink: -3.7, minSinkV: 66, bestOff: 96, ratioOff: 5.1, sinkOff: -5.2, stickOff: 0.14, flare: 6 },
  tractor: { best: 89, ratio: 4.2, sink: -6, minSink: -5, minSinkV: 60, bestOff: 90, ratioOff: 3.8, sinkOff: -6.7, stickOff: 0.12, flare: 12 },
  wa116: { best: 87, ratio: 4.6, sink: -5.2, minSink: -4.4, minSinkV: 61, bestOff: 84, ratioOff: 3.9, sinkOff: -6, stickOff: 0.14, flare: 9 },
  sigilo: { best: 103, ratio: 7.4, sink: -4, minSink: -3.4, minSinkV: 73, bestOff: 103, ratioOff: 5.7, sinkOff: -5.1, stickOff: 0.05, flare: 6 },
  wilford: { best: 93, ratio: 4.8, sink: -5.3, minSink: -4.5, minSinkV: 61, bestOff: 94, ratioOff: 4.2, sinkOff: -6.3, stickOff: 0.16, flare: 7 },
  'cavalon+flot': { best: 94, ratio: 4.3, sink: -6, minSink: -5.1, minSinkV: 62, bestOff: 95, ratioOff: 3.9, sinkOff: -6.7, stickOff: 0.14, flare: 12 },
  'mt03+flot': { best: 84, ratio: 4.3, sink: -5.4, minSink: -4.5, minSinkV: 55, bestOff: 84, ratioOff: 3.8, sinkOff: -6.2, stickOff: 0.27, flare: 8 },
  cierva_c19: { best: 97, ratio: 7.3, sink: -3.8, minSink: -3.2, minSinkV: 68, bestOff: 96, ratioOff: 6.3, sinkOff: -4.2, stickOff: 0.08, flare: 5 },
  cierva_c6: { best: 89, ratio: 5.7, sink: -4.4, minSink: -3.8, minSinkV: 64, bestOff: 85, ratioOff: 4.7, sinkOff: -4.9, stickOff: -0.07, flare: 6 },
  c44: { best: 94, ratio: 4.8, sink: -5.5, minSink: -4.5, minSinkV: 59, bestOff: 94, ratioOff: 4.3, sinkOff: -6.2, stickOff: 0.07, flare: 6 },
}

/** Clave de la tabla: el id del aparato, con «+flot» si lleva su juego de flotadores (floatKit.ts). */
export function glideKey(af: Airframe): string {
  return af.floats?.length && !AIRFRAMES[af.id]?.floats?.length ? `${af.id}+flot` : af.id
}

/** Planeo del aparato (si falta en la tabla, cifras de un biplaza tipo MTOsport). */
export function glideFor(af: Airframe): GlideData {
  return GLIDE[glideKey(af)] ?? GLIDE[af.id] ?? { best: 85, ratio: 4.7, sink: -5, minSink: -4.4, minSinkV: 55, bestOff: 85, ratioOff: 4.5, sinkOff: -5.3, stickOff: 0.2, flare: 6 }
}
