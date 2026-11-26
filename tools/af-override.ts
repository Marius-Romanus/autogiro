// Ayuda para los bancos de pruebas: permite probar una ficha de aparato
// modificada sin tocar src/sim/airframes.ts.
//
//   STAB="-2.30,-0.52,0.88"   centro x,y y superficie del estabilizador
//   FIN="-2.47,-0.12,0.84"    centro x,y y superficie vertical
//   TUNE="headAft=7,stabSlip=0.75"   parámetros de Autogyro.tune
//   AF="torqueRoll=1,swirlYaw=1"      campos numéricos de la ficha
import type { Autogyro } from '../src/sim/autogyro.ts'
import { airframeById, AIRFRAMES, type Airframe } from '../src/sim/airframes.ts'

//   af=<id>+flot                     el aparato con su juego de flotadores (src/sim/floatKit.ts)
export function pickAirframe(id: string): Airframe {
  const [baseId, kit] = id.split('+')
  if (!(baseId in AIRFRAMES)) throw new Error(`aparato desconocido: ${id} (${Object.keys(AIRFRAMES).join(', ')})`)
  const base = airframeById(baseId, kit === 'flot')
  const { STAB, FIN, AF, AFJ } = process.env
  if (!STAB && !FIN && !AF && !AFJ) return base
  const af: Airframe = { ...base, stab: base.stab.clone(), fin: base.fin.clone() }
  // AFJ='{"wing":{"rotorWash":0},"body":null}': campos anidados (null quita el campo)
  if (AFJ) {
    const merge = (dst: Record<string, unknown>, src: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(src)) {
        if (v === null) delete dst[k]
        else if (typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object') {
          const d = { ...(dst[k] as Record<string, unknown>) }
          merge(d, v as Record<string, unknown>)
          dst[k] = d
        } else dst[k] = v
      }
    }
    merge(af as unknown as Record<string, unknown>, JSON.parse(AFJ))
  }
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
