// Enganche del combustible y los fallos del motor (sim/powerplant.ts) con el juego: ajustes del
// menú, avisos en pantalla, llave de contacto, tecla F2, HUD, guía y sonido. Así main.ts solo
// llama a estas funciones.

import { locale, t } from '../i18n.ts'
import type { Settings } from '../config.ts'
import type { Autogyro } from '../sim/autogyro.ts'
import { glideFor } from '../sim/glideData.ts'
import { cruiseFlowLph } from '../sim/fuel.ts'
import type { GuideEmergency } from './Guide.ts'
import { departureLitres } from '../menu/fuelMenu.ts'

/** Al salir (spawn): planta en marcha con los fallos del menú y el combustible elegido. */
export function applyPowerplantSettings(ac: Autogyro, s: Settings, refuel: boolean): void {
  const pp = ac.pp
  pp.enabled = true
  pp.setMode(s.failures ?? 'none', Boolean(s.failRandom))
  if (refuel) {
    pp.reset()
    pp.setLitres(departureLitres(s))
    ac.setFuel(pp.fuelKg)
  }
}

/** Cada fotograma: avisos que han salido (para el «toast») y el gas sujeto en el simulacro. */
export function powerplantFrame(ac: Autogyro, input: { throttle: number }): string | null {
  // el instructor sujeta el gas a ralentí: la palanca del gas no se mueve
  if (ac.pp.drill) input.throttle = 0
  let msg: string | null = null
  for (const e of ac.pp.consumeEvents()) {
    // (decimales con la coma o el punto del idioma)
    const vars = e.vars && Object.fromEntries(Object.entries(e.vars).map(([k, v]) => [k, typeof v === 'number' && !Number.isInteger(v) ? v.toLocaleString(locale()) : v]))
    msg = t(e.key, vars)
  }
  return msg
}

/** Llave de contacto (tecla M o la llave del panel): devuelve el aviso que toca. */
export function toggleEngine(ac: Autogyro): string {
  if (ac.engineOn) {
    ac.engineOn = false
    return t('toast.engineOff')
  }
  const block = ac.pp.enabled ? ac.pp.startBlock() : null
  if (block) return t(`pp.noStart.${block}`)
  ac.engineOn = true
  return t('toast.engineOn')
}

/** Tecla F2: simulacro (o fallo real en el modo «Reales»). El aviso sale con los sucesos. */
export function requestFailure(ac: Autogyro): void {
  if (ac.pp.enabled) ac.pp.request(ac)
}

/** Lo que el HUD y el panel necesitan del combustible y de los fallos. */
export function powerplantHud(ac: Autogyro): {
  warnings: string[]
  cautions: string[]
  fuel?: number
  fuelL?: number
  fuelLow: boolean
  oilLow: boolean
  drill: boolean
} {
  const pp = ac.pp
  if (!pp.enabled) return { warnings: [], cautions: [], fuelLow: false, oilLow: false, drill: false }
  const st = pp.status(ac)
  return {
    warnings: st.warnings.map((k) => t(k)),
    cautions: st.cautions.map((k) => t(k)),
    fuel: pp.spec.none ? undefined : pp.fraction,
    fuelL: pp.spec.none ? undefined : pp.usable,
    fuelLow: pp.lowFuel,
    oilLow: pp.oilLow && ac.engineOn,
    drill: pp.drill,
  }
}

/** Emergencia para la guía de pilotaje, con las cifras del aparato. */
export function powerplantGuide(ac: Autogyro): GuideEmergency | null {
  const kind = ac.pp.emergency(ac)
  if (!kind) return null
  const g = glideFor(ac.af)
  const best = kind === 'drill' ? g.best : g.bestOff
  const ratio = kind === 'drill' ? g.ratio : g.ratioOff
  const min = Math.max(1, Math.round((ac.pp.usable / Math.max(0.5, cruiseFlowLph(ac.af.engine))) * 60))
  return {
    kind,
    vars: {
      best: Math.round(best / 5) * 5,
      minsink: Math.round(g.minSinkV / 5) * 5,
      flare: g.flare,
      flareFt: Math.round((g.flare * 3.281) / 5) * 5,
      // km por cada 300 m de altura
      km: (Math.round(ratio * 0.3 * 10) / 10).toLocaleString(locale()),
      // (la reserva se cuenta en tramos de 5 min para no repintar la guía a cada segundo)
      min: kind === 'fuel' ? Math.max(5, Math.round(min / 5) * 5) : 0,
    },
  }
}
