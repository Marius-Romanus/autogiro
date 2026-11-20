// Ayuda para los bancos de pruebas: permite probar una ficha de aparato
// modificada sin tocar src/sim/airframes.ts.
//
//   STAB="-2.30,-0.52,0.88"   centro x,y y superficie del estabilizador
//   FIN="-2.47,-0.12,0.84"    centro x,y y superficie vertical
//   TUNE="headAft=7,stabSlip=0.75"   parámetros de Autogyro.tune
//   AF="torqueRoll=1,swirlYaw=1"      campos numéricos de la ficha
import type { Autogyro } from '../src/sim/autogyro.ts'
import { airframeById, AIRFRAMES, type Airframe } from '../src/sim/airframes.ts'

export function pickAirframe(id: string): Airframe {
  if (!(id in AIRFRAMES)) throw new Error(`aparato desconocido: ${id} (${Object.keys(AIRFRAMES).join(', ')})`)
  const base = airframeById(id)
  const { STAB, FIN, AF } = process.env
  if (!STAB && !FIN && !AF) return base
  const af: Airframe = { ...base, stab: base.stab.clone(), fin: base.fin.clone() }
  for (const kv of AF ? AF.split(',') : []) {
    const [k, v] = kv.split('=')
    ;(af as unknown as Record<string, number>)[k] = Number(v)
  }
  if (STAB) {
    const [x, y, a] = STAB.split(',').map(Number)
    af.stab.set(x, y, 0)
    af.stabArea = a
  }
  if (FIN) {
    const [x, y, a] = FIN.split(',').map(Number)
    af.fin.set(x, y, 0)
    af.finArea = a
  }
  console.log(`(ficha modificada: estabilizador ${af.stab.x},${af.stab.y} ${af.stabArea} m² · vertical ${af.fin.x},${af.fin.y} ${af.finArea} m²)`)
  return af
}

export function applyTune(ac: Autogyro): void {
  const t = process.env.TUNE
  if (!t) return
  for (const kv of t.split(',')) {
    const [k, v] = kv.split('=')
    if (!(k in ac.tune)) throw new Error(`parámetro desconocido: ${k}`)
    ;(ac.tune as Record<string, number>)[k] = Number(v)
  }
}
