// Menú principal por pestañas (index.html → #menu, estilo en menu.css).
//
// main.ts sigue atando cada control a los ajustes como siempre; aquí va lo que es solo del menú:
//   - pestañas (Aparato, Salida, Hora y meteo, Escenario, Multijugador) y la pantalla de Ajustes;
//   - tarjetas y botones que manejan los selectores ocultos (aircraft, clouds, quality): se cambia
//     el <select> y se lanza su «change», así que main.ts no se entera de la diferencia;
//   - lo que se dibuja a partir de los ajustes: plan de vuelo, ficha del aparato, arco del sol,
//     rosa de los vientos con el rumbo de salida y datos de la salida.
// refreshMenuUi() lo vuelve a pintar todo; se llama al tocar cualquier control y desde
// main.refreshMenu() (idioma, salida elegida en el mapa, condiciones de una sala...).

import './menu.css'
import pkg from '../../package.json'
import { AIRCRAFT, aircraftById, aircraftName, aircraftNote } from '../aircraft/catalog.ts'
import { airframeById } from '../sim/airframes.ts'
import { FLOAT_KITS } from '../sim/floatKit.ts'
import { LOCATIONS, locationName, type Location, type Settings } from '../config.ts'
import { has, locale, t } from '../i18n.ts'
import { localUtcOffset, sunTimes } from './sun.ts'
import { failPlanText, fuelPlanText, refreshFuelMenu } from './fuelMenu.ts'
import { airPlan, drawAir } from './weatherMenu.ts'

export type MenuTab = 'aparato' | 'salida' | 'meteo' | 'escenario' | 'escuela' | 'multi'
const TABS: MenuTab[] = ['aparato', 'salida', 'meteo', 'escenario', 'escuela', 'multi']

export interface MenuHooks {
  settings: Settings
  /** salida elegida ahora mismo en el menú */
  location(): Location
  /** el menú está abierto y nada lo tapa (mapa del mundo, ventanas de ayuda) */
  canFly(): boolean
  fly(): void
}

const DEG = Math.PI / 180
const SVG = 'http://www.w3.org/2000/svg'

let hooks: MenuHooks
let menu: HTMLElement

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

export function setupMenuUi(h: MenuHooks): void {
  hooks = h
  menu = $('menu')
  buildAircraftCards()
  buildWindRose()
  $('menuVersion').textContent = `v${pkg.version}`

  menu.addEventListener('click', (e) => {
    const el = e.target as HTMLElement
    // (el propio #menu lleva data-tab y data-screen: no cuenta)
    const tab = el.closest<HTMLElement>('[data-tab]')
    if (tab && tab !== menu) setTab(tab.dataset.tab as MenuTab)
    const screen = el.closest<HTMLElement>('[data-screen]')
    if (screen && screen !== menu) setScreen(screen.dataset.screen === 'settings' ? 'settings' : 'main')
    const btn = el.closest<HTMLButtonElement>('button[data-value]')
    const box = btn?.closest<HTMLElement>('[data-for]')
    if (btn && box) pick(box.dataset.for!, btn.dataset.value!)
  })
  menu.addEventListener('keydown', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('.plan-list li')
    if (li && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault()
      e.stopPropagation()
      setTab(li.dataset.tab as MenuTab)
    }
  })
  // los manejadores de main.ts van en cada control y se ejecutan antes que estos
  menu.addEventListener('input', (e) => {
    // (casillas y radios guardan su ajuste en el «change» que llega justo después: repintar con su
    // «input» volvía a poner la casilla como estaba y deshacía el clic, p. ej. «Cuando menos te lo
    // esperes» o la ayuda al pilotaje del plan de vuelo)
    const type = (e.target as HTMLInputElement).type
    if (type === 'checkbox' || type === 'radio') return
    refreshMenuUi()
  })
  menu.addEventListener('change', () => refreshMenuUi())

  // la ayuda al pilotaje está en el plan de vuelo y también en Ajustes
  const assist = $<HTMLInputElement>('assist')
  const mirror = $<HTMLInputElement>('assistMirror')
  mirror.addEventListener('change', () => {
    assist.checked = mirror.checked
    assist.dispatchEvent(new Event('change', { bubbles: true }))
  })

  // Intro = volar (si no se está escribiendo en un campo)
  window.addEventListener('keydown', (e) => {
    if ((e.key !== 'Enter' && e.code !== 'NumpadEnter') || e.repeat || !hooks.canFly()) return
    const tgt = e.target as HTMLElement | null
    if (tgt?.closest('input, select, textarea, button, a, summary, [contenteditable], .plan-list li')) return
    e.preventDefault()
    hooks.fly()
  })

  setTab('aparato')
}

/** Vuelve de Ajustes a las pestañas. Devuelve false si ya estaba en ellas. */
export function menuBack(): boolean {
  if (menu?.dataset.screen !== 'settings') return false
  setScreen('main')
  return true
}

function setTab(tab: MenuTab): void {
  if (!TABS.includes(tab)) return
  const changed = menu.dataset.tab !== tab
  menu.dataset.tab = tab
  menu.dataset.screen = 'main'
  if (changed) menu.querySelector('.m-content')?.scrollTo({ top: 0 })
  refreshMenuUi()
}

function setScreen(screen: 'main' | 'settings'): void {
  menu.dataset.screen = screen
  refreshMenuUi()
}

/** Tarjeta o botón de un selector oculto: cambia el <select> como si se hubiera elegido en él. */
function pick(selectId: string, value: string): void {
  const sel = $<HTMLSelectElement>(selectId)
  if (!sel || sel.disabled || sel.value === value) return
  sel.value = value
  sel.dispatchEvent(new Event('change', { bubbles: true }))
}

// ---------------------------------------------------------------------------
// Construcción
// ---------------------------------------------------------------------------

function buildAircraftCards(): void {
  const box = $('acCards')
  box.textContent = ''
  for (const a of AIRCRAFT) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'ac-card'
    b.dataset.value = a.id
    const img = document.createElement('img')
    // miniatura: public/models/thumbs/<id>.jpg (un aparato nuevo sin ella lleva el logo)
    img.src = `${import.meta.env.BASE_URL}models/thumbs/${a.id}.jpg`
    img.addEventListener('error', () => img.classList.add('ac-nothumb'), { once: true })
    img.alt = ''
    img.loading = 'lazy'
    img.decoding = 'async'
    const tag = document.createElement('span')
    tag.className = 'ac-tag'
    const txt = document.createElement('span')
    txt.className = 'ac-txt'
    txt.append(document.createElement('b'), document.createElement('small'))
    b.append(img, tag, txt)
    box.appendChild(b)
  }
}

function buildWindRose(): void {
  const svg = $('windRose')
  const el = (tag: string, attrs: Record<string, string | number>, cls?: string) => {
    const e = document.createElementNS(SVG, tag)
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
    if (cls) e.setAttribute('class', cls)
    return e
  }
  svg.append(el('circle', { cx: 80, cy: 80, r: 70 }, 'wr-ring'))
  for (let a = 0; a < 360; a += 10) {
    const major = a % 30 === 0
    const r1 = major ? 60 : 64
    const s = Math.sin(a * DEG)
    const c = Math.cos(a * DEG)
    svg.append(el('line', { x1: 80 + 70 * s, y1: 80 - 70 * c, x2: 80 + r1 * s, y2: 80 - r1 * c }, major ? 'wr-tick maj' : 'wr-tick'))
  }
  const cards: Array<[string, number, number]> = [
    ['N', 80, 36],
    ['E', 127, 85],
    ['S', 80, 133],
    ['W', 33, 85],
  ]
  for (const [k, x, y] of cards) {
    const tx = el('text', { x, y }, 'wr-card')
    tx.dataset.card = k
    svg.append(tx)
  }
  // rumbo de salida (pista o trayectoria) con el aparato en el centro
  const hdg = el('g', { transform: 'translate(80 80)' })
  hdg.id = 'wrHdg'
  hdg.append(el('rect', { x: -4.5, y: -34, width: 9, height: 68 }, 'wr-hdg'), el('path', { d: 'M0 -13 L7 8 L0 4 L-7 8 Z' }, 'wr-ac'))
  // viento: flecha desde donde sopla
  const wind = el('g', { transform: 'translate(80 80)' }, 'wr-wind')
  wind.id = 'wrWind'
  wind.append(el('path', { d: 'M0 -66 L0 30' }, 'wr-arrow'), el('path', { d: 'M0 42 L-7 27 L7 27 Z' }, 'wr-head'))
  svg.append(hdg, wind)
}

// ---------------------------------------------------------------------------
// Pintado
// ---------------------------------------------------------------------------

export function refreshMenuUi(): void {
  if (!hooks || !menu) return
  const s = hooks.settings
  const loc = hooks.location()

  for (const b of menu.querySelectorAll<HTMLElement>('.m-tabs [data-tab]')) {
    const on = b.dataset.tab === menu.dataset.tab
    b.classList.toggle('on', on)
    b.setAttribute('aria-current', on ? 'page' : 'false')
  }
  // botones de los selectores ocultos
  for (const box of menu.querySelectorAll<HTMLElement>('[data-for]')) {
    const sel = $<HTMLSelectElement>(box.dataset.for!)
    if (!sel) continue
    for (const b of box.querySelectorAll<HTMLButtonElement>('button[data-value]')) {
      const on = b.dataset.value === sel.value
      b.classList.toggle('on', on)
      b.setAttribute('aria-pressed', String(on))
      b.disabled = sel.disabled
    }
  }
  for (const r of menu.querySelectorAll<HTMLInputElement>('input[type=range]')) {
    const min = Number(r.min || 0)
    const max = Number(r.max || 100)
    r.style.setProperty('--p', `${((Number(r.value) - min) / (max - min || 1)) * 100}%`)
  }
  $<HTMLInputElement>('assistMirror').checked = $<HTMLInputElement>('assist').checked

  const tz = localUtcOffset(loc.lat, loc.lon, s.dayOfYear)
  const sun = sunTimes(loc.lat, loc.lon, s.dayOfYear, tz)
  drawAircraft(s)
  drawSun(s, sun)
  drawWind(s, loc)
  drawDeparture(loc, tz)
  drawAir(s, loc)
  drawPlan(s, loc, sun)
}

function drawAircraft(s: Settings): void {
  const a = aircraftById(s.aircraft)
  const af = airframeById(a.id, s.floats)
  drawFloats(s, a.id)
  // combustible al salir y fallos de motor de la Escuela (fuelMenu.ts)
  refreshFuelMenu(s)
  for (const card of $('acCards').querySelectorAll<HTMLElement>('.ac-card')) {
    const id = card.dataset.value!
    // (un aparato nuevo sin sus claves ac.<id>.tag/.short/.maker sale sin etiqueta y con su nota)
    const tag = card.querySelector<HTMLElement>('.ac-tag')!
    tag.textContent = has(`ac.${id}.tag`) ? t(`ac.${id}.tag`) : ''
    tag.hidden = !tag.textContent
    card.querySelector('b')!.textContent = aircraftName(aircraftById(id))
    card.querySelector('small')!.textContent = has(`ac.${id}.short`) ? t(`ac.${id}.short`) : aircraftNote(aircraftById(id))
  }
  $('acMaker').textContent = has(`ac.${a.id}.maker`) ? t(`ac.${a.id}.maker`) : ''
  $('acName').textContent = aircraftName(a)
  $('passengerNote').textContent = t('menu.passengerD', { kg: af.mtow })
  const cv = Math.round(af.engine.maxPower / 735.5)
  const specs: Array<[string, string, string]> = [
    [t('spec.engine'), af.engine.name, ''],
    [t('spec.power'), String(cv), t('spec.cv')],
    [t('spec.rotor'), num(af.rotor.radius * 2, 2), t('spec.rotorUnit', { n: af.rotor.blades })],
    [t('spec.mass'), `${af.emptyMass} / ${af.mtow}`, 'kg'],
  ]
  $('acSpecs').innerHTML = specs
    .map(([k, v, u]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}${u ? `<small>${esc(u)}</small>` : ''}</dd></div>`)
    .join('')
}

/**
 * Fila «Con flotadores»: solo en los aparatos con juego de flotadores (floatKit.ts); el Wilford XOZ-1
 * los lleva de serie (marcada y fija). Los demás no la muestran.
 */
let floatsFor = ''
function drawFloats(s: Settings, id: string): void {
  const kit = FLOAT_KITS[id]
  const builtIn = !kit && Boolean(airframeById(id).floats?.length)
  const row = $('floatsRow')
  row.hidden = !kit && !builtIn
  const box = $('floats') as HTMLInputElement
  box.disabled = builtIn
  // (la casilla solo se pone al cambiar de aparato: el menú se repinta con «input», antes del «change» que
  // guarda el ajuste, y forzarla siempre deshacía el clic)
  if (builtIn) box.checked = true
  else if (id !== floatsFor) box.checked = s.floats
  floatsFor = id
  $('floatsNote').textContent = builtIn ? t('menu.floatsBuiltIn') : kit ? t(kit.amphib ? 'menu.floatsAmphib' : 'menu.floatsD', { kg: kit.mass }) : ''
}

const ARC = { x0: 18, x1: 282, cx: 150, rx: 132, ry: 88, hy: 104 }

function drawSun(s: Settings, sun: ReturnType<typeof sunTimes>): void {
  $('hourBig').textContent = fmtHour(s.hour)
  $('dayBig').textContent = fmtDay(s.dayOfYear)
  const { x0, x1, cx, rx, ry, hy } = ARC
  let html = `<path class="sa-hz" d="M0 ${hy} H300"/><path class="sa-arc" d="M${x0} ${hy} A${rx} ${ry} 0 0 1 ${x1} ${hy}"/>`
  let sx = cx
  let sy = hy - ry
  let down = false
  if (sun.kind === 'normal') {
    const f = (s.hour - sun.rise) / (sun.set - sun.rise)
    const th = Math.PI * (1 - Math.min(1, Math.max(0, f)))
    sx = cx + rx * Math.cos(th)
    sy = hy - ry * Math.sin(th)
    down = f < 0 || f > 1
    if (f > 0.002) html += `<path class="sa-done" d="M${x0} ${hy} A${rx} ${ry} 0 0 1 ${sx.toFixed(1)} ${sy.toFixed(1)}"/>`
    html +=
      `<text class="sa-t" x="${x0}" y="122">${esc(t('menu.sunrise', { h: fmtHour(sun.rise) }))}</text>` +
      `<text class="sa-t" x="${x1}" y="122" text-anchor="end">${esc(t('menu.sunset', { h: fmtHour(sun.set) }))}</text>`
  } else {
    down = sun.kind === 'polarNight'
    if (down) sy = hy
    html += `<text class="sa-t" x="${cx}" y="122" text-anchor="middle">${esc(t(sun.kind === 'polarDay' ? 'menu.polarDay' : 'menu.polarNight'))}</text>`
  }
  html += `<circle class="sa-halo" cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="14"/><circle class="sa-sun" cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="6.5"/>`
  const svg = $('sunArc')
  svg.innerHTML = html
  svg.classList.toggle('down', down)
}

function drawWind(s: Settings, loc: Location): void {
  const hdg = norm360(loc.heading || 0)
  for (const tx of $('windRose').querySelectorAll<SVGTextElement>('[data-card]')) tx.textContent = t(`card.${tx.dataset.card}`)
  $('wrHdg').setAttribute('transform', `translate(80 80) rotate(${hdg.toFixed(1)})`)
  $('wrWind').setAttribute('transform', `translate(80 80) rotate(${s.windFrom})`)
  $('windRose').classList.toggle('calm', s.windSpeed <= 0)
  let text: string
  if (s.windSpeed <= 0) text = t('wind.calm')
  else {
    const rel = (s.windFrom - hdg) * DEG
    const head = Math.round(s.windSpeed * Math.cos(rel))
    const cross = Math.round(s.windSpeed * Math.sin(rel))
    const parts: string[] = []
    if (head > 0) parts.push(t('wind.head', { kt: head }))
    else if (head < 0) parts.push(t('wind.tail', { kt: -head }))
    if (cross !== 0) parts.push(t(cross > 0 ? 'wind.crossRight' : 'wind.crossLeft', { kt: Math.abs(cross) }))
    text = `${t('wind.rel', { hdg: pad3(hdg) })}: ${parts.join(' · ') || t('wind.calm')}`
  }
  $('windComp').textContent = text
}

function drawDeparture(loc: Location, tz: number): void {
  // código OACI en el nombre («Casarrubios (LEMT) · cabecera 26», «LEMD», ...)
  const name = locationName(loc)
  const icao = isPlace(loc) ? null : /(?:^|[\s(])([A-Z]{4})(?=$|[\s)·,])/.exec(name)?.[1]
  const badge = $('depIcao')
  badge.textContent = icao ?? ''
  badge.classList.toggle('hidden', !icao)
  const lat = `${num(Math.abs(loc.lat), 4)}° ${t(loc.lat >= 0 ? 'card.N' : 'card.S')}`
  const lon = `${num(Math.abs(loc.lon), 4)}° ${t(loc.lon >= 0 ? 'card.E' : 'card.W')}`
  const facts: Array<[string, string]> = [
    [t('dep.heading'), `${pad3(norm360(loc.heading || 0))}°`],
    [t('dep.coords'), `${lat} · ${lon}`],
    [t('dep.tz'), `UTC${tz >= 0 ? '+' : '−'}${Math.abs(tz)}`],
  ]
  $('depFacts').innerHTML = facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')
}

function drawPlan(s: Settings, loc: Location, sun: ReturnType<typeof sunTimes>): void {
  const google = s.scenery === 'google'
  const extras = [s.buildings && t('plan.buildings'), s.trees && t('plan.trees'), s.power && t('plan.power'), s.catastro && t('plan.catastro')].filter(Boolean)
  const start = isPlace(loc) || s.start === 'air' ? t('plan.inFlight') : t('plan.onRunway')
  const rows: Array<{ tab: MenuTab; k: string; v: string; s?: string; warn?: boolean }> = [
    { tab: 'aparato', k: t('plan.aircraft'), v: aircraftName(aircraftById(s.aircraft)), s: [t(s.passenger ? 'plan.pax' : 'plan.solo') + (airframeById(s.aircraft, s.floats).floats?.length ? ` · ${t('plan.floats')}` : ''), fuelPlanText(s)].filter(Boolean).join(' · ') },
    { tab: 'salida', k: t('plan.departure'), v: locationName(loc), s: start },
    {
      tab: 'meteo',
      k: t('plan.time'),
      v: `${fmtHour(s.hour)} · ${fmtDay(s.dayOfYear)}`,
      s: sun.kind === 'normal' ? t('plan.sun', { rise: fmtHour(sun.rise), set: fmtHour(sun.set) }) : '',
    },
    {
      tab: 'meteo',
      k: t('plan.wind'),
      v: s.windSpeed > 0 ? `${pad3(s.windFrom)}° / ${s.windSpeed} kt` : t('wind.calm'),
      s: t('plan.turb', { pct: Math.round(s.turbulence * 100) }),
    },
    { tab: 'meteo', k: t('plan.sky'), v: t(`sky.${s.clouds}`) },
    // temperatura, QNH y altitud de densidad en la salida (weatherMenu.ts)
    { tab: 'meteo', k: t('plan.air'), ...airPlan(s, loc) },
    {
      tab: 'escenario',
      k: t('plan.scenery'),
      v: t(google ? 'plan.google' : 'plan.terrain'),
      s: google ? t(s.googleKey ? 'plan.keyOk' : 'plan.keyMissing') : extras.length ? extras.join(' · ') : t('plan.noExtras'),
      warn: google && !s.googleKey,
    },
  ]
  // fallos de motor (pestaña Escuela): solo si hay alguno elegido
  const fail = failPlanText(s)
  if (fail) rows.push({ tab: 'escuela', k: t('menu.failT'), v: fail.charAt(0).toUpperCase() + fail.slice(1) })
  const cur = menu.dataset.tab
  $('planList').innerHTML = rows
    .map(
      (r) =>
        `<li data-tab="${r.tab}" tabindex="0" role="button"${r.tab === cur ? ' class="on"' : ''}>` +
        `<span class="k">${esc(r.k)}</span><span class="v">${esc(r.v)}</span>` +
        (r.s ? `<span class="s${r.warn ? ' warn' : ''}">${esc(r.s)}</span>` : '') +
        `</li>`,
    )
    .join('')
}

// ---------------------------------------------------------------------------
// Joystick en Ajustes: barras de los cuatro ejes asignados
// ---------------------------------------------------------------------------

export function updateAxisBars(gp: Gamepad | null, s: Settings): void {
  const bars: Array<[string, number]> = [
    ['axBarPitch', s.axisPitch],
    ['axBarRoll', s.axisRoll],
    ['axBarYaw', s.axisYaw],
    ['axBarThrottle', s.axisThrottle],
  ]
  for (const [id, axis] of bars) {
    const v = gp && axis >= 0 ? (gp.axes[axis] ?? 0) : 0
    const bar = document.getElementById(id)
    if (!bar) continue
    const x = Math.max(-1, Math.min(1, v))
    bar.style.left = `${50 + Math.min(0, x) * 50}%`
    bar.style.width = `${Math.abs(x) * 50}%`
  }
}

// ---------------------------------------------------------------------------
// utilidades
// ---------------------------------------------------------------------------

/** Lugar emblemático (siempre en vuelo), no un aeródromo ni un punto del mapa. */
function isPlace(loc: Location): boolean {
  return loc.id !== 'custom' && LOCATIONS.some((l) => l.id === loc.id && l.group !== 'airfield')
}

const norm360 = (d: number) => ((Math.round(d) % 360) + 360) % 360
const pad3 = (d: number) => String(norm360(d)).padStart(3, '0')
const num = (v: number, digits: number) => v.toLocaleString(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits })
const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export function fmtHour(h: number): string {
  const total = Math.round(h * 60)
  const hh = Math.floor(total / 60) % 24
  const mm = total % 60
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

export function fmtDay(d: number): string {
  const date = new Date(Date.UTC(2026, 0, 1) + (d - 1) * 86400e3)
  return date.toLocaleDateString(locale(), { day: 'numeric', month: 'long', timeZone: 'UTC' })
}
