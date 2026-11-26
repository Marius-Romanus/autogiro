// Menú › Hora y meteo: aire del día (atmósfera estándar o temperatura y QNH) y botón «Tiempo real»
// (Open-Meteo, openMeteo.ts). Controles en index.html: #btn-realwx, #wxStatus, #isaAir, #oatC, #qnh,
// #isaNote, #airNote. El plan de vuelo (menuUi.ts) pide aquí su línea del aire (`airPlan`).
//
// La altitud de densidad se calcula en el suelo de la salida: su elevación la da el simulador si ya
// tiene cargada esa salida y, si no, el relieve Terrarium (mapData.elevationAt, ≈ 60 m/píxel).

import { locationName, type Location, type Settings } from '../config.ts'
import { locale, t } from '../i18n.ts'
import { AirModel, ISA_DEW_SPREAD, QNH_STD, isaTempC } from '../sim/airMass.ts'
import { elevationAt } from './mapData.ts'
import { fetchRealWeather, gustTurbulenceTerrain, realWeatherSettings, type RealWeather } from './openMeteo.ts'

export interface WeatherMenuHooks {
  settings: Settings
  /** salida elegida ahora mismo en el menú */
  location(): Location
  /** elevación (m sobre el nivel del mar) del suelo de esa salida si el simulador ya la tiene cargada */
  simElevation(loc: Location): number | null
  /** cambió algo del aire: aplicar los ajustes */
  changed(): void
  /** tiempo real recibido: repintar el menú entero, aplicar y guardar */
  applied(): void
  /** repintar el menú (llegó la elevación de la salida) */
  refresh(): void
}

let hooks: WeatherMenuHooks | null = null
const air = new AirModel()
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null

/**
 * Lo que vuelve a su valor por defecto con la atmósfera estándar. La visibilidad y la precipitación
 * tienen ya sus propios controles (menu/skyMenu.ts) y no se tocan.
 */
const CALM = { windGustKt: 0 }

export function setupWeatherMenu(h: WeatherMenuHooks): void {
  hooks = h
  const s = h.settings
  const isa = $<HTMLInputElement>('isaAir')
  const oat = $<HTMLInputElement>('oatC')
  const qnh = $<HTMLInputElement>('qnh')
  isa?.addEventListener('change', () => {
    s.isa = isa.checked
    if (s.isa) Object.assign(s, CALM)
    else {
      // se parte de la atmósfera estándar en la salida
      const elev = departureElevation(h.location()) ?? 0
      s.oatC = Math.round(isaTempC(elev))
      s.qnh = Math.round(QNH_STD)
      s.dewPointC = s.oatC - ISA_DEW_SPREAD
    }
    lastReal = null
    syncAirControls(s)
    h.changed()
  })
  oat?.addEventListener('input', () => {
    const v = Number(oat.value)
    // (se conserva la diferencia con el punto de rocío: la humedad relativa apenas cambia)
    s.dewPointC = Math.min(v, s.dewPointC + (v - s.oatC))
    s.oatC = v
    syncAirControls(s)
    h.changed()
  })
  qnh?.addEventListener('input', () => {
    s.qnh = Number(qnh.value)
    syncAirControls(s)
    h.changed()
  })
  $('btn-realwx')?.addEventListener('click', () => void realWeather())
  syncAirControls(s)
}

// ---------------------------------------------------------------------------
// Tiempo real
// ---------------------------------------------------------------------------

let busy = false
/** último tiempo real aplicado (para la nota de estado mientras siga puesto) */
let lastReal: { w: RealWeather; loc: Location } | null = null

async function realWeather(): Promise<void> {
  if (!hooks || busy) return
  const h = hooks
  const btn = $<HTMLButtonElement>('btn-realwx')
  if (btn?.disabled) return
  const loc = h.location()
  busy = true
  btn?.classList.add('busy')
  status(t('wx.loading', { place: locationName(loc) }), 'busy')
  try {
    const w = await fetchRealWeather(loc.lat, loc.lon, AbortSignal.timeout(12000))
    // (si mientras tanto cambió la salida o una sala bloqueó las condiciones, no se aplica)
    const now = h.location()
    if (now.lat !== loc.lat || now.lon !== loc.lon || btn?.disabled) {
      status('', '')
      return
    }
    Object.assign(h.settings, realWeatherSettings(w, loc.lat, loc.lon))
    // con el viento del terreno, el deslizador multiplica la turbulencia que sale del sitio
    if (h.settings.terrainWind) h.settings.turbulence = gustTurbulenceTerrain(w.windKt, Number.isFinite(w.gustKt) ? w.gustKt : w.windKt)
    if (Number.isFinite(w.elevation)) elevCache.set(elevKey(loc), Math.max(0, w.elevation))
    lastReal = { w, loc }
    busy = false
    status('', '')
    h.applied()
    drawStatus()
  } catch (e) {
    // (fetch rechaza con TypeError si no hay red o lo bloquea algo)
    const msg = e instanceof TypeError ? t('wx.offline') : e instanceof Error ? (e.name === 'TimeoutError' ? t('wx.timeout') : e.message) : String(e)
    lastReal = null
    status(t('wx.error', { msg }), 'warn')
  } finally {
    busy = false
    btn?.classList.remove('busy')
  }
}

function status(text: string, kind: '' | 'busy' | 'warn'): void {
  const el = $('wxStatus')
  if (!el) return
  el.textContent = text
  el.classList.toggle('warn', kind === 'warn')
  el.classList.toggle('busy', kind === 'busy')
}

/** Resumen del tiempo real aplicado (o nada si ya se ha cambiado algo a mano). */
function drawStatus(): void {
  const el = $('wxStatus')
  if (!el || busy || el.classList.contains('warn')) return
  if (!lastReal || !hooks) {
    status('', '')
    return
  }
  const { w, loc } = lastReal
  const s = hooks.settings
  const cur = hooks.location()
  if (s.isa || cur.lat !== loc.lat || cur.lon !== loc.lon) {
    status('', '')
    return
  }
  const n0 = (v: number) => Math.round(v).toLocaleString(locale())
  const r = realWeatherSettings(w, loc.lat, loc.lon)
  const parts = [
    `${n0(w.tempC)} °C`,
    t('wx.dew', { c: n0(r.dewPointC) }),
    `QNH ${hpa(Math.round(r.qnh))} hPa`,
    w.windKt < 0.5 ? t('wind.calm') : `${String(Math.round(w.windFrom) % 360).padStart(3, '0')}° / ${n0(w.windKt)} kt`,
  ]
  if (r.windGustKt > w.windKt + 2) parts.push(t('wx.gusts', { kt: n0(r.windGustKt) }))
  if (Number.isFinite(w.cover)) parts.push(t('wx.cover', { pct: n0(w.cover) }))
  const what = wxWord(w.code)
  if (what) parts.push(what)
  if (Number.isFinite(w.visibility))
    parts.push(t('wx.vis', { v: w.visibility >= 5000 ? `${n0(w.visibility / 1000)} km` : `${n0(Math.round(w.visibility / 50) * 50)} m` }))
  if (r.precip > 0) parts.push(t('wx.precip', { mm: r.precip.toLocaleString(locale(), { maximumFractionDigits: 1 }) }))
  const time = /T(\d\d:\d\d)/.exec(w.time)?.[1] ?? ''
  const text = `${t('wx.done', { place: locationName(loc), time })} ${parts.join(' · ')}.`
  status(text, '')
}

/** Palabra para el código de tiempo WMO (solo lo que no se ve ya en la cobertura de nubes). */
function wxWord(code: number): string {
  if (code === 45 || code === 48) return t('wx.code.fog')
  if (code >= 51 && code <= 57) return t('wx.code.drizzle')
  if (code >= 61 && code <= 67) return t('wx.code.rain')
  if (code >= 71 && code <= 77) return t('wx.code.snow')
  if (code >= 80 && code <= 82) return t('wx.code.showers')
  if (code === 85 || code === 86) return t('wx.code.snowShowers')
  if (code >= 95) return t('wx.code.storm')
  return ''
}

// ---------------------------------------------------------------------------
// Elevación de la salida
// ---------------------------------------------------------------------------

const elevCache = new Map<string, number | null>()
const elevKey = (loc: Location) => `${loc.lat.toFixed(3)},${loc.lon.toFixed(3)}`

/** Elevación (m) del suelo de la salida; null mientras se pide (luego repinta el menú). */
export function departureElevation(loc: Location): number | null {
  const sim = hooks?.simElevation(loc) ?? null
  if (sim !== null) return sim
  const k = elevKey(loc)
  if (elevCache.has(k)) return elevCache.get(k)!
  elevCache.set(k, null)
  void elevationAt(loc.lat, loc.lon, AbortSignal.timeout(15000)).then((h) => {
    if (h === null) {
      // (sin conexión: se vuelve a intentar la próxima vez)
      setTimeout(() => elevCache.delete(k), 20000)
      return
    }
    // (en el mar el relieve da el fondo)
    elevCache.set(k, Math.max(0, h))
    hooks?.refresh()
  })
  return null
}

// ---------------------------------------------------------------------------
// Pintado
// ---------------------------------------------------------------------------

const fmt = (v: number, digits = 0) => v.toLocaleString(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits })
/** QNH sin separador de miles (1013, como en los METAR) */
const hpa = (v: number, digits = 0) => v.toLocaleString(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false })
const fmtQnh = (s: Settings) => (s.isa ? hpa(QNH_STD, 2) : hpa(Math.round(s.qnh)))

/** Pone los controles del aire como dicen los ajustes (main.refreshMenu y al tocarlos). */
export function syncAirControls(s: Settings): void {
  const isa = $<HTMLInputElement>('isaAir')
  if (!isa) return
  isa.checked = s.isa
  $('airFields')!.hidden = s.isa
  $<HTMLInputElement>('oatC')!.value = String(s.oatC)
  $<HTMLInputElement>('qnh')!.value = String(s.qnh)
  $('oatOut')!.textContent = `${fmt(Math.round(s.oatC))} °C`
  $('qnhOut')!.textContent = `${fmtQnh(s)} hPa`
}

/** Datos del aire en la salida: temperatura en el suelo, elevación y altitud de densidad (null: sin elevación). */
function departureAir(s: Settings, loc: Location): { tempC: number; elev: number | null; daM: number | null } {
  const elev = departureElevation(loc)
  air.set(s)
  air.elev = elev ?? 0
  return { tempC: air.groundTempC(), elev, daM: elev === null ? null : air.densityAltitude(elev) }
}

/** Línea «Aire» del plan de vuelo. */
export function airPlan(s: Settings, loc: Location): { v: string; s: string } {
  const a = departureAir(s, loc)
  const v = `${s.isa ? 'ISA · ' : ''}${fmt(Math.round(a.tempC))} °C · ${fmtQnh(s)} hPa`
  return { v, s: daText(a.daM) }
}

function daText(daM: number | null): string {
  if (daM === null) return t('plan.daWait')
  return t('plan.da', { ft: fmt(Math.round((daM * 3.28084) / 10) * 10), m: fmt(Math.round(daM / 10) * 10) })
}

/** Notas del bloque del aire en la pestaña (menuUi.refreshMenuUi). */
export function drawAir(s: Settings, loc: Location): void {
  const isaNote = $('isaNote')
  if (!isaNote) return
  const a = departureAir(s, loc)
  const elev = a.elev === null ? '' : t('wx.atElev', { m: fmt(Math.round(a.elev)) })
  isaNote.textContent = s.isa ? t('wx.isaNote', { c: fmt(Math.round(a.tempC)), elev }) : t('wx.manualNote')
  $('airNote')!.textContent = `${daText(a.daM)}${a.elev === null ? '' : ` · ${t('wx.elev', { m: fmt(Math.round(a.elev)) })}`}`
  drawStatus()
}
