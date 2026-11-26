// Interfaz de la realidad virtual: la fila de Ajustes › Gráficos (activarla, estado del visor,
// resolución, prueba sin visor), el botón «VR» de la barra superior (solo si hay visor) y el
// aviso que queda en la pantalla mientras se vuela con el visor puesto.

import { onLangChange, t } from '../i18n.ts'
import { VR_DETAIL, type Vr, type VrDetail } from './Vr.ts'
import './vr.css'

export interface VrUiHost {
  /** Entrar: cierra el menú (empieza o sigue el vuelo) y abre la sesión. */
  enter(kind: 'xr' | 'screen'): void
  exit(): void
  /** Ha cambiado el perfil de detalle del visor. */
  detailChanged(): void
}

/** Lo que inyecta la app de escritorio (src-tauri): puerto del servidor local. */
const desktopApp = (): { port: number } | undefined => (window as unknown as { __AUTOGIRO_APP__?: { port: number } }).__AUTOGIRO_APP__

export function setupVrUi(vr: Vr, host: VrUiHost): void {
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, html = ''): HTMLElementTagNameMap[K] => {
    const e = Object.assign(document.createElement(tag), props)
    if (html) e.innerHTML = html
    return e
  }

  // ---- Ajustes › Gráficos ----
  const row = el('label', { className: 'm-row', id: 'vr-row' }, '<span><b></b><small></small></span><span class="m-sw"><input id="vr-opt" type="checkbox" /><i></i></span>')
  const box = el('div', { id: 'vr-box', hidden: true })
  const status = el('div', { id: 'vr-status', className: 'm-hint' })
  const actions = el('div', { className: 'vr-actions' })
  const recheck = el('button', { type: 'button', id: 'vr-recheck' })
  const open = el('button', { type: 'button', id: 'vr-open' })
  const preview = el('button', { type: 'button', id: 'vr-preview' })
  actions.append(recheck, open, preview)
  const field = el('div', { className: 'm-field' }, '<label for="vr-scale"><span></span> <output></output></label><input id="vr-scale" type="range" min="0.6" max="1.4" step="0.1" />')
  const detail = el('div', { className: 'm-field' }, '<label><span></span></label><div class="m-seg"></div><div class="m-hint"></div>')
  const seg = detail.querySelector('.m-seg') as HTMLElement
  for (const k of Object.keys(VR_DETAIL) as VrDetail[]) {
    const b = el('button', { type: 'button' })
    b.dataset.value = k
    b.addEventListener('click', () => {
      vr.prefs.detail = k
      vr.savePrefs()
      host.detailChanged()
      refresh()
    })
    seg.append(b)
  }
  box.append(status, actions, detail, field)
  const anchor = document.getElementById('telemetry-opt')?.closest('label')
  anchor?.after(row, box)
  const opt = row.querySelector('input') as HTMLInputElement
  const scale = field.querySelector('input') as HTMLInputElement
  const scaleOut = field.querySelector('output') as HTMLOutputElement
  opt.checked = vr.prefs.on
  scale.value = String(vr.prefs.scale)

  // ---- barra superior ----
  const btn = el('button', { type: 'button', id: 'btn-vr', hidden: true })
  btn.setAttribute('aria-pressed', 'false')
  document.getElementById('btn-lights')?.after(btn)
  // sin foco tras el clic (Espacio son los frenos)
  btn.addEventListener('mousedown', (e) => e.preventDefault())
  btn.addEventListener('click', () => (vr.active ? host.exit() : host.enter('xr')))

  // ---- aviso en la pantalla durante la sesión ----
  const note = el('div', { id: 'vr-note', className: 'hidden' }, '<b></b><span></span>')
  document.getElementById('app')?.after(note)

  const refresh = (): void => {
    ;(row.querySelector('b') as HTMLElement).textContent = t('vr.optT')
    ;(row.querySelector('small') as HTMLElement).textContent = t('vr.optD')
    box.hidden = !vr.prefs.on
    const app = desktopApp()
    const s = vr.support
    const inApp = Boolean(app) && s !== 'yes' && s !== 'checking' && s !== 'unknown'
    status.textContent = inApp ? t('vr.st.app') : s === 'unknown' ? '' : t(`vr.st.${s}`)
    status.dataset.state = s
    recheck.textContent = t('vr.recheck')
    recheck.hidden = s !== 'no' || inApp
    open.textContent = t('vr.openBrowser')
    open.hidden = !inApp
    preview.textContent = t('vr.preview')
    preview.title = t('vr.previewTitle')
    ;(field.querySelector('span') as HTMLElement).textContent = t('vr.scale')
    scaleOut.textContent = `${Math.round(vr.prefs.scale * 100)} %`
    ;(detail.querySelector('span') as HTMLElement).textContent = t('vr.detail')
    for (const b of seg.querySelectorAll('button')) {
      b.textContent = t(`vr.detail.${b.dataset.value}`)
      b.classList.toggle('on', b.dataset.value === vr.prefs.detail)
    }
    ;(detail.querySelector('.m-hint') as HTMLElement).textContent = t(`vr.detailD.${vr.prefs.detail}`)
    btn.hidden = !(vr.prefs.on && s === 'yes') && !vr.active
    btn.innerHTML = `<span>${t('vr.btn')}</span>`
    btn.title = t('vr.btn.title')
    btn.classList.toggle('on', vr.active)
    btn.setAttribute('aria-pressed', String(vr.active))
    note.classList.toggle('hidden', !vr.active)
    document.body.classList.toggle('vr-active', vr.active)
    note.dataset.kind = vr.immersive ? 'xr' : 'screen'
    ;(note.querySelector('b') as HTMLElement).textContent = vr.immersive ? t('vr.note.t') : ''
    ;(note.querySelector('span') as HTMLElement).innerHTML = t(vr.immersive ? 'vr.note.d' : 'vr.note.preview')
  }

  opt.addEventListener('change', () => {
    vr.prefs.on = opt.checked
    vr.savePrefs()
    if (opt.checked) void vr.probe()
    refresh()
  })
  recheck.addEventListener('click', () => void vr.probe())
  open.addEventListener('click', () => {
    // 127.0.0.1 y no localhost: para la app es una dirección "de fuera" y la abre el navegador del sistema
    const app = desktopApp()
    if (app) window.open(`http://127.0.0.1:${app.port}/`, '_blank', 'noopener')
  })
  preview.addEventListener('click', () => host.enter('screen'))
  scale.addEventListener('input', () => {
    vr.prefs.scale = Number(scale.value)
    vr.savePrefs()
    refresh()
  })

  vr.onChange = refresh
  onLangChange(refresh)
  refresh()
  // solo quien la ha activado pregunta por el visor al arrancar
  if (vr.prefs.on) void vr.probe()
}
