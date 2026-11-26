// Menú: combustible con el que se sale (pestaña Aparato) y fallos de motor (pestaña Escuela)
// (sim/fuel.ts, sim/powerplant.ts). Las filas se crean aquí con el estilo del resto del menú: el
// deslizador del combustible va debajo de «Con flotadores» (con litros, kilos, autonomía y aviso si
// se pasa del peso máximo); los botones Ninguno / Simulacro / Reales (un <select> oculto, como la
// calidad gráfica) y el interruptor «Cuando menos te lo esperes», en #failBox de la Escuela.

import { applyI18n, t } from '../i18n.ts'
import type { Settings } from '../config.ts'
import { aircraftById } from '../aircraft/catalog.ts'
import { airframeById, PASSENGER_MASS, PILOT_MASS } from '../sim/airframes.ts'
import { cruiseFlowLph, fuelSpec } from '../sim/fuel.ts'
import '../sim/powerplantText.ts'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

/** Litros con los que se sale: el no utilizable más el % del depósito utilizable. */
export function departureLitres(s: Settings): number {
  const fs = fuelSpec(airframeById(aircraftById(s.aircraft).id, s.floats))
  const pct = Math.max(0, Math.min(100, s.fuelPct ?? 100)) / 100
  return fs.unusable + pct * (fs.capacity - fs.unusable)
}

/** Crea las filas (una vez) y ata sus controles a los ajustes. */
export function setupFuelMenu(s: Settings, onChange: () => void): void {
  if ($('fuelPct')) return
  const anchor = $('floatsRow') ?? $('passenger')?.closest('label')
  const failBox = $('failBox')
  if (!anchor || !failBox) return
  const box = document.createElement('div')
  box.innerHTML = `
    <div class="m-field" id="fuelField">
      <label for="fuelPct"><span data-i18n="menu.fuelT">${t('menu.fuelT')}</span> <output id="fuelOut"></output></label>
      <input id="fuelPct" type="range" min="5" max="100" step="5" />
      <small class="m-hint" id="fuelNote"></small>
    </div>`
  anchor.after(...Array.from(box.children))
  applyI18n($('fuelField').parentElement!)
  failBox.innerHTML = `
    <div class="m-field">
      <span class="m-label" data-i18n="menu.failT">${t('menu.failT')}</span>
      <select id="failures" class="m-src" aria-hidden="true" tabindex="-1">
        <option value="none"></option><option value="drill"></option><option value="real"></option>
      </select>
      <div class="m-seg m-choice" data-for="failures">
        <button type="button" data-value="none" data-i18n="menu.fail.none">${t('menu.fail.none')}</button>
        <button type="button" data-value="drill" data-i18n="menu.fail.drill">${t('menu.fail.drill')}</button>
        <button type="button" data-value="real" data-i18n="menu.fail.real">${t('menu.fail.real')}</button>
      </div>
      <small class="m-hint" id="failNote"></small>
    </div>
    <label class="m-row" id="failRandomRow">
      <span><b data-i18n="menu.failRandomT">${t('menu.failRandomT')}</b><small data-i18n="menu.failRandomD">${t('menu.failRandomD')}</small></span>
      <span class="m-sw"><input id="failRandom" type="checkbox" /><i></i></span>
    </label>`
  applyI18n(failBox)

  const fuel = $<HTMLInputElement>('fuelPct')
  const sel = $<HTMLSelectElement>('failures')
  const rnd = $<HTMLInputElement>('failRandom')
  fuel.addEventListener('input', () => {
    s.fuelPct = Number(fuel.value)
    onChange()
  })
  sel.addEventListener('change', () => {
    s.failures = sel.value as Settings['failures']
    // sin fallos no llega ninguno al azar
    if (s.failures === 'none') s.failRandom = false
    onChange()
  })
  rnd.addEventListener('change', () => {
    s.failRandom = rnd.checked
    // con «Ninguno» el interruptor no se quedaba muerto: elige los simulacros del instructor
    if (s.failRandom && (s.failures ?? 'none') === 'none') {
      s.failures = 'drill'
      sel.value = 'drill'
    }
    onChange()
  })
  refreshFuelMenu(s)
}

/** Vuelve a pintar las filas con los ajustes y el aparato elegido. */
export function refreshFuelMenu(s: Settings): void {
  const fuel = $<HTMLInputElement>('fuelPct')
  if (!fuel) return
  const af = airframeById(aircraftById(s.aircraft).id, s.floats)
  const fs = fuelSpec(af)
  if (document.activeElement !== fuel) fuel.value = String(s.fuelPct ?? 100)
  const sel = $<HTMLSelectElement>('failures')
  sel.value = s.failures ?? 'none'
  const rnd = $<HTMLInputElement>('failRandom')
  rnd.checked = Boolean(s.failRandom) && sel.value !== 'none'
  $('failNote').innerHTML = t(`menu.failD.${sel.value}`)
  fuel.disabled = Boolean(fs.none)
  const pct = Math.round(s.fuelPct ?? 100)
  const l = departureLitres(s)
  const kg = l * fs.density
  $('fuelOut').textContent = fs.none ? '—' : `${pct} % · ${Math.round(l)} l`
  if (fs.none) {
    $('fuelNote').textContent = t('menu.fuelNone')
    $('fuelNote').classList.remove('warn')
    return
  }
  // peso al despegue con esta carga (y la tolva llena del fumigador)
  const pax = s.passenger && (af.seats ?? 2) > 1 ? PASSENGER_MASS : 0
  const hopper = af.sprayer ? af.sprayer.load * af.sprayer.density : 0
  const mass = af.emptyMass + kg + PILOT_MASS + pax + hopper
  const over = mass - af.mtow
  const hours = (l - fs.unusable) / Math.max(0.5, cruiseFlowLph(af.engine))
  const hh = Math.floor(hours)
  const mm = Math.round((hours - hh) * 60)
  const h = hh > 0 ? `${hh} h ${String(mm).padStart(2, '0')}` : `${mm} min`
  const vars = { l: Math.round(l), cap: Math.round(fs.capacity), kg: Math.round(kg), h, mass: Math.round(mass), over: Math.round(over), mtow: af.mtow }
  const note = $('fuelNote')
  note.textContent = t(over > 0.5 ? 'menu.fuelOver' : 'menu.fuelD', vars)
  note.style.color = over > 0.5 ? '#ffb23a' : ''
}

/** Texto del plan de vuelo para la fila del aparato: el combustible. */
export function fuelPlanText(s: Settings): string {
  const af = airframeById(aircraftById(s.aircraft).id, s.floats)
  return fuelSpec(af).none ? '' : t('plan.fuel', { l: Math.round(departureLitres(s)) })
}

/** Texto del plan de vuelo para los fallos de motor ('' sin fallos). */
export function failPlanText(s: Settings): string {
  if (!s.failures || s.failures === 'none') return ''
  return t(`plan.fail.${s.failures}`) + (s.failRandom ? ` ${t('plan.failRandom')}` : '')
}
