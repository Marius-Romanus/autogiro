// Menú › Hora y meteo: visibilidad, precipitación y punto de rocío (src/sim/weather.ts). Los controles
// se crean aquí y se cuelgan de la pestaña (como menu/fuelMenu.ts): la visibilidad y la precipitación
// bajo el cielo, el punto de rocío junto a la temperatura y el QNH. Debajo, una nota con lo que sale
// de todo ello: niebla de radiación, base de las nubes, alcance visual y estado de la pista.
//
// La precipitación se guarda como la trae el tiempo real: intensidad (`precip`, mm/h) y código WMO
// (`weatherCode`); los botones ponen los de `PRECIP_PRESETS`.

import type { Settings } from '../config.ts'
import { applyI18n, locale, t } from '../i18n.ts'
import { relHumidity } from '../sim/airMass.ts'
import { precipKind, PRECIP_PRESETS, VIS_CLEAR, type PrecipKind, type WeatherState } from '../sim/weather.ts'

export interface SkyMenuHooks {
  settings: Settings
  /** cambió algo: aplicar los ajustes */
  changed(): void
  /** tiempo del día ya resuelto con los ajustes vigentes, y temperatura en el suelo de la salida */
  weather(): WeatherState | null
  groundTempC(): number
}

/** posiciones del deslizador de visibilidad (m); la última es «30 km o más»: el aire limpio de siempre */
const VIS_STEPS = [200, 400, 800, 1500, 3000, 5000, 8000, 10000, 15000, 20000, VIS_CLEAR]
const KINDS: PrecipKind[] = ['none', 'drizzle', 'rain', 'shower', 'snow']

let hooks: SkyMenuHooks | null = null
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null
const fmt = (v: number, d = 0) => v.toLocaleString(locale(), { minimumFractionDigits: d, maximumFractionDigits: d })

export function fmtVisibility(m: number): string {
  if (m >= VIS_CLEAR) return t('sky.visClear')
  return m >= 5000 ? `${fmt(m / 1000)} km` : m >= 1000 ? `${fmt(m / 1000, 1)} km` : `${fmt(Math.round(m / 50) * 50)} m`
}

export function setupSkyMenu(h: SkyMenuHooks): void {
  hooks = h
  const s = h.settings
  const sky = document.querySelector<HTMLElement>('#menu .sky-tiles[data-for="clouds"]')?.closest<HTMLElement>('.m-field')
  const air = $('airFields')
  if (!sky || !air || $('visibility')) return
  const box = document.createElement('div')
  box.innerHTML = `
    <div id="skyFields">
      <div class="m-field">
        <label for="visibility"><span data-i18n="sky.visibility">${t('sky.visibility')}</span> <output id="visOut"></output></label>
        <input id="visibility" type="range" min="0" max="${VIS_STEPS.length - 1}" step="1" />
      </div>
      <div class="m-field">
        <span class="m-label" data-i18n="sky.precip">${t('sky.precip')}</span>
        <select id="precipKind" class="m-src" aria-hidden="true" tabindex="-1">
          ${KINDS.map((k) => `<option value="${k}"></option>`).join('')}
        </select>
        <div class="m-seg m-choice sky-precip" data-for="precipKind">
          ${KINDS.map((k) => `<button type="button" data-value="${k}" data-i18n="sky.precip.${k}">${t(`sky.precip.${k}`)}</button>`).join('')}
        </div>
      </div>
    </div>
    <p id="skyNote" class="m-note"></p>`
  sky.after(...Array.from(box.children))
  const dew = document.createElement('div')
  dew.className = 'm-field'
  dew.innerHTML = `<label for="dewC"><span data-i18n="sky.dew">${t('sky.dew')}</span> <output id="dewOut"></output></label>
    <input id="dewC" type="range" min="-40" max="50" step="0.5" />`
  air.append(dew)
  applyI18n($('skyFields')!)
  applyI18n(dew)

  const vis = $<HTMLInputElement>('visibility')!
  vis.addEventListener('input', () => {
    s.visibility = VIS_STEPS[Number(vis.value)] ?? VIS_CLEAR
    syncSkyControls(s)
    h.changed()
  })
  const kind = $<HTMLSelectElement>('precipKind')!
  kind.addEventListener('change', () => {
    const k = kind.value as PrecipKind
    const p = PRECIP_PRESETS[k] ?? PRECIP_PRESETS.none
    s.weatherCode = p.code
    s.precip = p.rate
    // llueve de las nubes: sin ellas se pone el cielo que toca
    if (k !== 'none' && (s.clouds === 'clear' || s.clouds === 'fair')) s.clouds = k === 'shower' ? 'scattered' : 'overcast'
    // la nieve pide frío: si no lo hace, se pone a 0 °C en la salida con el aire casi saturado
    if (k === 'snow' && h.groundTempC() > 0.5) {
      s.isa = false
      s.oatC = 0
      s.dewPointC = -1.5
    }
    syncSkyControls(s)
    h.changed()
  })
  const dewIn = $<HTMLInputElement>('dewC')!
  dewIn.addEventListener('input', () => {
    s.dewPointC = Math.min(Number(dewIn.value), s.oatC)
    syncSkyControls(s)
    h.changed()
  })
  // cualquier otro control de la pestaña (hora, viento, cielo, temperatura) cambia la nota
  $('menu')?.addEventListener('input', () => queueMicrotask(() => syncSkyControls(s)))
  $('menu')?.addEventListener('change', () => queueMicrotask(() => syncSkyControls(s)))
  syncSkyControls(s)
}

/** Pone los controles como dicen los ajustes y repinta la nota (main.refreshMenu y al tocarlos). */
export function syncSkyControls(s: Settings): void {
  const vis = $<HTMLInputElement>('visibility')
  if (!vis || !hooks) return
  // la posición más cercana (el tiempo real trae cualquier valor)
  let best = VIS_STEPS.length - 1
  for (let i = 0; i < VIS_STEPS.length; i++) if (Math.abs(Math.log(s.visibility / VIS_STEPS[i])) < Math.abs(Math.log(s.visibility / VIS_STEPS[best]))) best = i
  if (s.visibility >= VIS_CLEAR) best = VIS_STEPS.length - 1
  vis.value = String(best)
  $('visOut')!.textContent = fmtVisibility(s.visibility)
  const kind = $<HTMLSelectElement>('precipKind')!
  kind.value = precipKind(s.weatherCode, s.precip)
  for (const b of document.querySelectorAll<HTMLButtonElement>('#menu [data-for="precipKind"] button')) {
    const on = b.dataset.value === kind.value
    b.classList.toggle('on', on)
    b.setAttribute('aria-pressed', String(on))
    b.disabled = kind.disabled
  }
  const dew = $<HTMLInputElement>('dewC')!
  dew.max = String(s.oatC)
  dew.value = String(Math.min(s.dewPointC, s.oatC))
  $('dewOut')!.textContent = `${fmt(Math.min(s.dewPointC, s.oatC), 1)} °C · ${fmt(relHumidity(s.oatC, s.dewPointC) * 100)} %`
  drawNote()
}

function drawNote(): void {
  const el = $('skyNote')
  const st = hooks?.weather()
  if (!el || !st || !hooks) return
  const s = hooks.settings
  const parts: string[] = []
  if (st.fog > 0.02) parts.push(t('sky.note.fog', { m: fmt(Math.round(st.fogDepth / 5) * 5), v: fmtVisibility(3.912 / st.fogBeta) }))
  else if (!s.isa && s.oatC - s.dewPointC <= 2.5 && st.kind === 'none') parts.push(t(`sky.note.nofog.${st.fogWhy || 'day'}`))
  if (st.hazeBeta > 0) parts.push(t(s.visibility < 1000 ? 'sky.note.fogbank' : st.dust > 0.5 ? 'sky.note.dust' : 'sky.note.haze'))
  if (st.cloudBaseAgl !== null && st.cloudBaseAgl < 880) parts.push(t('sky.note.base', { m: fmt(Math.round(st.cloudBaseAgl / 10) * 10), ft: fmt(Math.round((st.cloudBaseAgl * 3.28084) / 100) * 100) }))
  if (st.kind !== 'none') {
    parts.push(t('sky.note.vis', { v: fmtVisibility(st.visibility) }))
    parts.push(t(hooks.groundTempC() <= 1.5 ? 'sky.note.snow' : 'sky.note.wet'))
  }
  el.textContent = parts.join(' ')
  el.hidden = parts.length === 0
}
