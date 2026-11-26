// Pestaña «Escuela» del menú: pista y condiciones, la lista de ejercicios con su explicación y el
// progreso con el aparato elegido (mejor nota, intentos, últimas notas) y las últimas tomas.
// El contenido se pinta en #school-slot (index.html) y se repinta cuando cambia algo.

import { locale, onLangChange, t } from '../i18n.ts'
import type { Settings } from '../config.ts'
import { aircraftById } from '../aircraft/catalog.ts'
import { EXERCISES, type ExerciseDef } from './exercises.ts'
import { attemptsOf, bestScore, passed, removeLanding, saveSchool } from './history.ts'
import { fmtScore, tv, type School } from './School.ts'

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

export function setupSchoolMenu(school: School, settings: Settings, inRoom: () => boolean): void {
  const slot = document.getElementById('school-slot')
  if (!slot) return
  /** ejercicio desplegado */
  let open = ''
  let last = ''

  const condLine = (def: ExerciseDef): string => {
    const d = school.data
    const rwy = d.site === 'lemt' ? `LEMT ${school.active?.site.id === 'lemt08' ? '08' : d.cond === 'menu' ? '08/26' : '26'}` : t('school.site.here')
    if (d.cond === 'menu' && def.id !== 'crosswind') return t('school.condLineMenu', { rwy })
    const w = def.wind
    const wind = w.rel === 0 ? t('school.wind.head', { kt: w.kt }) : t('school.wind.cross', { kt: w.kt, deg: w.rel, x: Math.round(w.kt * Math.sin((w.rel * Math.PI) / 180)) })
    return t('school.condLine', { rwy, wind, hour: d.cond === 'menu' ? '' : '11:00', fuel: d.cond === 'menu' ? settings.fuelPct : 50 }).replace(' ·  · ', ' · ')
  }

  const render = (): void => {
    const d = school.data
    const ac = aircraftById(settings.aircraft).id
    const room = inRoom()
    const done = EXERCISES.filter((e) => passed(d, e.id, ac)).length
    const bests = EXERCISES.map((e) => bestScore(d, e.id, ac)).filter((b): b is number => b !== null)
    const avg = bests.length ? t('school.progressAvg', { avg: fmtScore(bests.reduce((a, b) => a + b, 0) / bests.length) }) : ''
    const seg = (name: string, value: string, cur: string, label: string) =>
      `<label><input type="radio" name="${name}" value="${value}"${cur === value ? ' checked' : ''} /><span>${label}</span></label>`

    const rows = EXERCISES.map((def, i) => {
      const list = attemptsOf(d, def.id, ac)
      const best = bestScore(d, def.id, ac)
      const ok = passed(d, def.id, ac)
      const why = school.blocked(def)
      const bars = list
        .slice(-8)
        .map((a) => `<i data-ok="${a.pass}" style="height:${Math.max(8, a.score * 10)}%" title="${fmtScore(a.score)}"></i>`)
        .join('')
      const state = best === null ? `<span class="sx-none">${t('school.untried')}</span>` : `<span class="sx-bars">${bars}</span><b class="sx-best" data-ok="${ok}">${fmtScore(best)}</b>`
      const isOpen = open === def.id
      const body = isOpen
        ? `<div class="sx-body">
            <h4>${t('school.h.goal')}</h4><p>${t(`school.ex.${def.id}.goal`)}</p>
            <h4>${t('school.h.cond')}</h4><p>${esc(condLine(def))} · ${esc(school.aircraftLabel())}</p>
            <h4>${t('school.h.pass')}</h4><p>${t(`school.ex.${def.id}.pass`)}</p>
            <p class="sx-ref">${t('school.ref', { ref: def.syllabus })}${list.length ? ` · ${list.length === 1 ? t('school.try1') : t('school.tries', { n: list.length })}` : ''}</p>
            ${why ? `<p class="m-callout">${t(why)}</p>` : ''}
            <button type="button" class="sx-start" data-start="${def.id}"${why ? ' disabled' : ''}><span aria-hidden="true">↗</span>${t('school.start')}</button>
          </div>`
        : ''
      return `<li class="sx-item${isOpen ? ' open' : ''}${ok ? ' passed' : ''}">
        <button type="button" class="sx-head" data-open="${def.id}" aria-expanded="${isOpen}">
          <span class="sx-n">${i + 1}</span><span class="sx-name">${t(`school.ex.${def.id}.name`)}</span>${state}
        </button>${body}</li>`
    }).join('')

    const landings = d.landings
      .slice(-6)
      .reverse()
      .map((l) => {
        const when = new Date(l.t).toLocaleDateString(locale(), { day: 'numeric', month: 'short' })
        return `<li><b data-ok="${l.score >= 5}">${fmtScore(l.score)}</b><span>${when} · ${esc(aircraftById(l.ac).name)}</span><small>${l.note ? tv(l.note, l.vars) : ''}</small><button type="button" class="sx-del" data-del="${l.t}" title="${t('school.delLanding')}" aria-label="${t('school.delLanding')}">×</button></li>`
      })
      .join('')

    const a = school.active
    const html = `
      ${a ? `<div class="sx-active"><span>${t('school.active', { name: t(`school.ex.${a.def.id}.name`) })}</span><button type="button" data-end>${t('school.end')}</button></div>` : ''}
      <p class="sx-intro">${t('school.intro')}</p>
      ${room ? `<p class="m-callout">${t('school.room')}</p>` : ''}
      <div class="sx-opts">
        <div><span class="sx-lab">${t('school.site')}</span><div class="m-seg" role="radiogroup">${seg('school-site', 'lemt', d.site, t('school.site.lemt'))}${seg('school-site', 'here', d.site, t('school.site.here'))}</div><small>${t(`school.siteNote.${d.site}`)}</small></div>
        <div><span class="sx-lab">${t('school.cond')}</span><div class="m-seg" role="radiogroup">${seg('school-cond', 'ex', d.cond, t('school.cond.ex'))}${seg('school-cond', 'menu', d.cond, t('school.cond.menu'))}</div><small>${t(`school.condNote.${d.cond}`)}</small></div>
      </div>
      <div class="sx-progress"><span>${t('school.progress', { ac: esc(school.aircraftLabel()), n: done, of: EXERCISES.length, avg })}</span><i style="--p:${(done / EXERCISES.length) * 100}%"></i></div>
      <ol class="sx-list">${rows}</ol>
      <label class="m-row">
        <span><b>${t('school.showGrade')}</b><small>${t('school.showGradeNote')}</small></span>
        <span class="m-sw"><input id="school-grade" type="checkbox"${d.showGrade ? ' checked' : ''} /><i></i></span>
      </label>
      <h3 class="sx-h">${t('school.lastLandings')}</h3>
      ${landings ? `<ul class="sx-landings">${landings}</ul>` : `<p class="sx-intro">${t('school.noLandings')}</p>`}`
    if (html === last) return
    last = html
    slot.innerHTML = html
  }

  slot.addEventListener('click', (e) => {
    const el = e.target as HTMLElement
    const del = el.closest<HTMLElement>('[data-del]')
    if (del) {
      removeLanding(school.data, Number(del.dataset.del))
      saveSchool(school.data)
      render()
      return
    }
    const start = el.closest<HTMLElement>('[data-start]')
    if (start) {
      school.start(start.dataset.start!)
      return
    }
    if (el.closest('[data-end]')) {
      school.end(true)
      render()
      return
    }
    const head = el.closest<HTMLElement>('[data-open]')
    if (head) {
      open = open === head.dataset.open ? '' : head.dataset.open!
      render()
    }
  })
  slot.addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement
    const d = school.data
    if (el.name === 'school-site') d.site = el.value === 'here' ? 'here' : 'lemt'
    else if (el.name === 'school-cond') d.cond = el.value === 'menu' ? 'menu' : 'ex'
    else if (el.id === 'school-grade') d.showGrade = el.checked
    saveSchool(d)
    render()
  })
  // el aparato, la salida o la sala cambian fuera de esta pestaña: se repinta al abrirla y al cambiar algo
  const menu = document.getElementById('menu')
  menu?.addEventListener('click', () => queueMicrotask(render))
  menu?.addEventListener('change', () => queueMicrotask(render))
  school.onChange = render
  onLangChange(render)
  render()
}
