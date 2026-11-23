// «Salida desde» del menú: o el mapa del mundo o un lugar emblemático, uno u otro.
//   - Mapa del mundo: la salida elegida en el mapa (WorldMap.ts: un aeródromo, una pista, un punto
//     cualquiera) o unas coordenadas escritas a mano, y en el suelo o en vuelo.
//   - Lugar emblemático: primero el país (un campo que filtra la lista mientras se escribe, por el
//     nombre en el idioma del menú) y luego el lugar de ese país (salida siempre en vuelo; los de
//     España, por comunidades autónomas).
// Cada modo recuerda su última elección (mapLocationId / placeLocationId) para poder alternar.

import './locationSelect.css'
import { LOCATIONS, locationCountry, locationName, locationNote, type Location, type Settings } from '../config.ts'
import { countryName, locale, t } from '../i18n.ts'
import { normalize } from './mapData.ts'

const SPAIN = 'ES'

let sel: HTMLSelectElement
let input: HTMLInputElement
let list: HTMLElement
let settings: Settings
let changed: () => void = () => {}
/** país mostrado (código ISO) */
let current = SPAIN
let shown: string[] = []
let active = 0

const $ = (id: string) => document.getElementById(id)!

/** Paisajes (lo que se elige por país); las salidas de aeródromo van con el mapa. */
const sites = (): Location[] => LOCATIONS.filter((l) => l.group !== 'airfield')
const isPlace = (id: string) => sites().some((l) => l.id === id)
const isMapDeparture = (id: string) => id === 'custom' || LOCATIONS.some((l) => l.id === id && l.group === 'airfield')

/** Países con paisajes, con su número de sitios. */
function countries(): Map<string, number> {
  const m = new Map<string, number>()
  for (const l of sites()) m.set(locationCountry(l), (m.get(locationCountry(l)) ?? 0) + 1)
  return m
}

/** Opciones de «Lugar» para un país. */
function fillPlaces(cc: string): void {
  const keep = sel.value
  sel.textContent = ''
  if (cc === SPAIN) {
    // por comunidades, en el orden de LOCATIONS
    const groups = new Map<string, HTMLOptGroupElement>()
    for (const l of sites()) {
      if (locationCountry(l) !== SPAIN) continue
      const g = l.region ?? 'scenic'
      let og = groups.get(g)
      if (!og) {
        og = document.createElement('optgroup')
        og.label = t(`locgroup.${g}`)
        groups.set(g, og)
        sel.appendChild(og)
      }
      og.appendChild(option(l.id, locationName(l)))
    }
  } else {
    const coll = new Intl.Collator(locale())
    for (const l of sites()
      .filter((x) => locationCountry(x) === cc)
      .sort((a, b) => coll.compare(locationName(a), locationName(b))))
      sel.appendChild(option(l.id, locationName(l)))
  }
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep
}

function option(value: string, text: string): HTMLOptionElement {
  const o = document.createElement('option')
  o.value = value
  o.textContent = text
  return o
}

// ---------------------------------------------------------------------------
// Lista de países filtrable (por el nombre en el idioma del menú)
// ---------------------------------------------------------------------------

function openList(filter: string): void {
  const counts = countries()
  const coll = new Intl.Collator(locale())
  const all = [...counts.keys()].sort((a, b) => coll.compare(countryName(a), countryName(b)))
  const q = normalize(filter.trim())
  shown = q ? all.filter((k) => normalize(countryName(k)).includes(q)) : all
  // con filtro, primero los que empiezan por lo escrito
  if (q) shown.sort((a, b) => Number(!normalize(countryName(a)).startsWith(q)) - Number(!normalize(countryName(b)).startsWith(q)))
  active = Math.max(0, q ? 0 : shown.indexOf(current))
  list.innerHTML = shown.length
    ? shown
        .map(
          (k, i) =>
            `<div class="combo-item${i === active ? ' on' : ''}${k === current ? ' cur' : ''}" role="option" data-k="${k}">` +
            `<span>${escapeHtml(countryName(k))}</span><small>${counts.get(k)}</small></div>`,
        )
        .join('')
    : `<div class="combo-empty">${escapeHtml(t('menu.countryNone'))}</div>`
  list.classList.remove('hidden')
  input.setAttribute('aria-expanded', 'true')
  list.querySelector('.combo-item.on')?.scrollIntoView({ block: 'nearest' })
}

function closeList(): void {
  list.classList.add('hidden')
  input.setAttribute('aria-expanded', 'false')
  input.value = countryName(current)
}

function moveActive(d: number): void {
  if (!shown.length) return
  active = (active + d + shown.length) % shown.length
  list.querySelectorAll('.combo-item').forEach((el, i) => el.classList.toggle('on', i === active))
  list.querySelector('.combo-item.on')?.scrollIntoView({ block: 'nearest' })
}

/** Elegir país: se rellena «Lugar» y se elige su primer sitio. */
function pickCountry(cc: string): void {
  current = cc
  closeList()
  fillPlaces(cc)
  const keep = LOCATIONS.find((l) => l.id === sel.value)
  if (!keep || locationCountry(keep) !== cc) sel.selectedIndex = 0
  choosePlace(sel.value)
}

function choosePlace(id: string): void {
  if (!isPlace(id)) return
  settings.locationId = id
  settings.placeLocationId = id
  showDeparture(settings)
  changed()
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

// ---------------------------------------------------------------------------
// Modo (mapa / lugar emblemático)
// ---------------------------------------------------------------------------

function setMode(mode: 'map' | 'place'): void {
  const s = settings
  if (mode === 'place') {
    const id = isPlace(s.placeLocationId) ? s.placeLocationId : (sites()[0]?.id ?? s.locationId)
    s.locationId = id
    s.placeLocationId = id
    current = locationCountry(LOCATIONS.find((l) => l.id === id)!)
    fillPlaces(current)
    sel.value = id
    input.value = countryName(current)
  } else {
    s.locationId = isMapDeparture(s.mapLocationId) ? s.mapLocationId : 'custom'
  }
  showDeparture(s)
  changed()
}

/** Lo que se ve de la salida: el bloque del modo y los textos (nombre y nota). */
export function showDeparture(s: Settings): void {
  const place = isPlace(s.locationId)
  $('dep-map').classList.toggle('hidden', place)
  $('dep-place').classList.toggle('hidden', !place)
  ;($('depmode-map') as HTMLInputElement).checked = !place
  ;($('depmode-place') as HTMLInputElement).checked = place
  const l = LOCATIONS.find((x) => x.id === s.locationId)
  if (place) {
    $('locationNote').textContent = l ? locationNote(l) : ''
    return
  }
  if (l) {
    $('depCurrent').textContent = `✈ ${locationName(l)}`
    $('depCurrentNote').textContent = locationNote(l)
  } else {
    $('depCurrent').textContent = s.customName ? `📍 ${s.customName}` : t('menu.customCoords')
    $('depCurrentNote').textContent = t('loc.customNote', {
      lat: s.customLat.toFixed(5),
      lon: s.customLon.toFixed(5),
      hdg: String(Math.round(s.customHeading || 0) % 360).padStart(3, '0'),
    })
  }
}

// ---------------------------------------------------------------------------
// API del menú (main.ts)
// ---------------------------------------------------------------------------

/** `onChange`: la salida ha cambiado (settings.locationId ya está puesto). */
export function buildLocationSelect(select: HTMLSelectElement, s: Settings, onChange: () => void): void {
  sel = select
  settings = s
  changed = onChange
  input = $('country') as HTMLInputElement
  list = $('country-list')
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name=depmode]'))
    r.addEventListener('change', () => r.checked && setMode(r.value as 'map' | 'place'))
  sel.addEventListener('change', () => choosePlace(sel.value))
  input.addEventListener('focus', () => {
    input.select()
    openList('')
  })
  input.addEventListener('click', () => {
    if (list.classList.contains('hidden')) openList('')
  })
  input.addEventListener('input', () => openList(input.value))
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (list.classList.contains('hidden')) openList('')
      else moveActive(e.key === 'ArrowDown' ? 1 : -1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (shown[active]) pickCountry(shown[active])
      input.blur()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeList()
      input.blur()
    }
  })
  input.addEventListener('blur', () => setTimeout(closeList, 120))
  list.addEventListener('mousedown', (e) => e.preventDefault()) // que el campo no pierda el foco
  list.addEventListener('click', (e) => {
    const k = (e.target as HTMLElement).closest<HTMLElement>('[data-k]')?.dataset.k
    if (k) {
      pickCountry(k)
      input.blur()
    }
  })
}

/** Textos según el idioma (países y sitios). */
export function localizeLocationSelect(_select: HTMLSelectElement, s: Settings): void {
  settings = s
  fillPlaces(current)
  if (list.classList.contains('hidden')) input.value = countryName(current)
  else openList(input.value)
  showDeparture(s)
}

/** País, lugares y modo para la salida guardada (antes de poner su valor en el desplegable). */
export function syncCurrentDeparture(_select: HTMLSelectElement, s: Settings): void {
  settings = s
  // la última de cada modo, para poder volver a ella al cambiar de modo
  if (isPlace(s.locationId)) s.placeLocationId = s.locationId
  else if (isMapDeparture(s.locationId)) s.mapLocationId = s.locationId
  const l = LOCATIONS.find((x) => x.id === (isPlace(s.locationId) ? s.locationId : s.placeLocationId))
  if (l && isPlace(l.id)) current = locationCountry(l)
  fillPlaces(current)
  if (list.classList.contains('hidden')) input.value = countryName(current)
  showDeparture(s)
}
