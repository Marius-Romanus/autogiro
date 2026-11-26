// Radio de voz: interfaz. Todo se engancha desde aquí para no tocar index.html:
//   - Menú › Multijugador: casilla «Radio de voz», micrófono y estado.
//   - Ajustes › Sonido: volumen de la radio.
//   - Ajustes › Joystick: botón de radio (PTT) del mando, con «Asignar».
//   - En vuelo: caja «COM» encima de los instrumentos con TX (y nivel del micro) o quién se oye.

import { getLang, onLangChange, t } from '../../i18n.ts'
import type { Radio } from './Radio.ts'

/** botón del mando por defecto: X en un mando tipo Xbox (libre: A prerrotador, B frenos, Y fumigación) */
export const DEFAULT_PAD_BUTTON = 2

let layoutKey = ''
/** La tecla del PTT (código `Backquote`) como la rotula el teclado: º en español, ` en inglés… */
export function pttKeyLabel(): string {
  return layoutKey || (getLang() === 'es' ? 'º' : '`')
}

const WAVE_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="8" r="1.6" fill="currentColor"/><path d="M7 4.5a5 5 0 0 1 0 7M9.6 2.4a8 8 0 0 1 0 11.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square"/></svg>'

/** Icono de ondas (lista de pilotos, etiquetas). */
export function waveIcon(cls = 'rd-wave'): HTMLElement {
  const i = document.createElement('i')
  i.className = cls
  i.innerHTML = WAVE_SVG
  return i
}

export interface ComState {
  show: boolean
  tx: boolean
  /** nivel del micro 0..1 */
  level: number
  rx: { name: string; color: string; weak: boolean }[]
  /** px desde abajo (encima del panel de instrumentos) */
  bottom: number
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (html) e.innerHTML = html
  return e
}

export class RadioUi {
  private readonly radio: Radio
  private readonly menu: {
    on: HTMLInputElement
    desc: HTMLElement
    dev: HTMLElement
    mic: HTMLSelectElement
    status: HTMLElement
  } | null = null
  private readonly vol: { input: HTMLInputElement; out: HTMLOutputElement } | null = null
  private readonly pad: { info: HTMLElement; set: HTMLButtonElement; reset: HTMLButtonElement; row: HTMLElement } | null = null
  private readonly com: { box: HTMLElement; tx: HTMLElement; meter: HTMLElement; rx: HTMLElement }
  private waiting = 0
  private comKey = ''

  constructor(radio: Radio, mpSection: HTMLElement | null) {
    this.radio = radio

    // --- menú › multijugador ---
    if (mpSection) {
      const box = el('div', 'rd-menu')
      box.innerHTML = `
        <label class="m-row rd-switch"><span><b data-i18n="radio.title">${t('radio.title')}</b><small class="rd-desc"></small></span><span class="m-sw"><input id="rdOn" type="checkbox" /><i></i></span></label>
        <div class="rd-dev hidden"><label for="rdMic" data-i18n="radio.mic">${t('radio.mic')}</label><select id="rdMic"></select></div>
        <p class="rd-status"></p>`
      const list = mpSection.querySelector('#mpList')
      if (list) list.before(box)
      else mpSection.append(box)
      this.menu = {
        on: box.querySelector('#rdOn')!,
        desc: box.querySelector('.rd-desc')!,
        dev: box.querySelector('.rd-dev')!,
        mic: box.querySelector('#rdMic')!,
        status: box.querySelector('.rd-status')!,
      }
      this.menu.on.addEventListener('change', () => radio.setEnabled(this.menu!.on.checked))
      this.menu.mic.addEventListener('change', () => radio.setDevice(this.menu!.mic.value))
    }

    // --- ajustes › sonido ---
    const volField = document.getElementById('volume')?.closest('.m-field')
    if (volField) {
      const f = el('div', 'm-field')
      f.innerHTML = `<label for="rdVolume"><span data-i18n="radio.volume">${t('radio.volume')}</span> <output id="rdVolOut"></output></label><input id="rdVolume" type="range" min="0" max="1" step="0.05" />`
      volField.after(f)
      this.vol = { input: f.querySelector('input')!, out: f.querySelector('output')! }
      this.vol.input.addEventListener('input', () => radio.setVolume(Number(this.vol!.input.value)))
    }

    // --- ajustes › joystick ---
    const live = document.getElementById('axesLive')
    if (live) {
      const row = el('div', 'm-row rd-pad')
      row.innerHTML = `<span><b data-i18n="radio.pad">${t('radio.pad')}</b><small class="rd-pad-info"></small></span><span class="rd-pad-btns"><button type="button" class="rd-pad-reset" data-i18n="radio.padReset">${t('radio.padReset')}</button><button type="button" class="rd-pad-set"></button></span>`
      live.before(row)
      this.pad = { row, info: row.querySelector('.rd-pad-info')!, set: row.querySelector('.rd-pad-set')!, reset: row.querySelector('.rd-pad-reset')! }
      this.pad.set.addEventListener('click', () => this.learnPad())
      this.pad.reset.addEventListener('click', () => radio.setPadButton(-1))
    }

    // --- en vuelo: caja COM ---
    const box = el('div', 'rd-com hidden')
    box.id = 'radio-com'
    const k = el('span', 'rd-com-k', t('radio.com'))
    const tx = el('span', 'rd-com-tx', 'TX')
    const meter = el('span', 'rd-meter', '<i></i>')
    const rx = el('span', 'rd-com-rx')
    box.append(k, tx, meter, rx)
    document.body.append(box)
    this.com = { box, tx, meter, rx }

    onLangChange(() => this.refresh())
    // rótulo real de la tecla (Chrome/WebView2: mapa del teclado)
    const kb = (navigator as Navigator & { keyboard?: { getLayoutMap?(): Promise<Map<string, string>> } }).keyboard
    kb?.getLayoutMap?.()
      .then((m) => {
        const k = m.get('Backquote')
        if (k && k.trim()) {
          layoutKey = k
          this.refresh()
        }
      })
      .catch(() => {})
    this.refresh()
  }

  /** Estado de los controles del menú y ajustes. */
  refresh(): void {
    const r = this.radio
    const s = r.settings
    const key = pttKeyLabel()
    if (this.menu) {
      const m = this.menu
      m.on.checked = s.on
      m.desc.innerHTML = t('radio.enableD', { key })
      // micrófonos (los nombres solo aparecen tras dar permiso)
      const devs = r.devices
      const want = [['', t('radio.micDefault')], ...devs.map((d, i) => [d.id, d.label || `${t('radio.mic')} ${i + 1}`])]
      const sig = want.map((w) => w.join('\u0001')).join('\u0002')
      if (m.mic.dataset.sig !== sig) {
        m.mic.dataset.sig = sig
        m.mic.replaceChildren(
          ...want.map(([id, label]) => {
            const o = el('option')
            o.value = id
            o.textContent = label
            return o
          }),
        )
      }
      m.mic.value = devs.some((d) => d.id === s.deviceId) ? s.deviceId : ''
      m.dev.classList.toggle('hidden', !s.on || devs.length < 2)
      let st = ''
      let bad = false
      if (s.on) {
        const ms = r.micState
        if (ms === 'asking') st = t('radio.st.asking')
        else if (ms === 'ok') st = t('radio.st.ok', { key })
        else if (ms !== 'idle') {
          st = ms === 'error' ? t('radio.st.error', { err: r.micError }) : t(`radio.st.${ms}`)
          bad = true
        }
        if (r.inRoom && r.listeners === 0) st += (st ? ' ' : '') + t('radio.st.alone')
      }
      m.status.innerHTML = st
      m.status.classList.toggle('bad', bad)
    }
    if (this.vol) {
      this.vol.input.value = String(s.volume)
      this.vol.out.textContent = `${Math.round(s.volume * 100)} %`
    }
    this.refreshPad()
  }

  private refreshPad(): void {
    if (!this.pad) return
    const b = this.radio.settings.padButton
    const n = b >= 0 ? b : DEFAULT_PAD_BUTTON
    const btn = b >= 0 ? t('radio.padBtn', { n }) : t('radio.padDefault', { n })
    this.pad.info.textContent = t('radio.padInfo', { btn })
    this.pad.set.textContent = this.waiting ? t('radio.padWait') : t('radio.padAssign')
    this.pad.reset.classList.toggle('hidden', b < 0 || this.waiting > 0)
  }

  /** «Asignar»: el siguiente botón que se pulse en el mando (hasta 8 s). */
  private learnPad(): void {
    if (this.waiting) return
    const pressed = (): Set<string> => {
      const out = new Set<string>()
      for (const gp of navigator.getGamepads?.() ?? []) {
        if (!gp?.connected) continue
        gp.buttons.forEach((b, i) => b.pressed && out.add(`${gp.index}:${i}`))
      }
      return out
    }
    const before = pressed()
    const until = performance.now() + 8000
    const tick = () => {
      if (!this.waiting) return
      for (const k of pressed()) {
        if (before.has(k)) continue
        this.waiting = 0
        this.radio.setPadButton(Number(k.split(':')[1]))
        return
      }
      for (const k of [...before]) if (!pressed().has(k)) before.delete(k)
      if (performance.now() > until) {
        this.waiting = 0
        this.refreshPad()
        return
      }
      this.waiting = requestAnimationFrame(tick)
    }
    this.waiting = requestAnimationFrame(tick)
    this.refreshPad()
  }

  /** Botón de radio del mando pulsado ahora (resalta la fila en Ajustes). */
  padLive(on: boolean): void {
    this.pad?.row.classList.toggle('rd-live', on)
  }

  /** Caja COM en vuelo (se llama cada fotograma; solo toca el DOM si algo cambia). */
  hud(s: ComState): void {
    const c = this.com
    const key = !s.show || (!s.tx && !s.rx.length) ? '' : `${s.tx}|${s.rx.map((r) => `${r.name}${r.color}${r.weak}`).join(',')}|${s.bottom}`
    if (s.show && s.tx) {
      const bar = c.meter.firstElementChild as HTMLElement
      bar.style.width = `${Math.round(Math.min(1, s.level) * 100)}%`
    }
    if (key === this.comKey) return
    this.comKey = key
    c.box.classList.toggle('hidden', !key)
    if (!key) return
    c.box.style.bottom = `${s.bottom}px`
    c.box.classList.toggle('tx', s.tx)
    c.tx.classList.toggle('hidden', !s.tx)
    c.meter.classList.toggle('hidden', !s.tx)
    c.rx.replaceChildren()
    c.rx.classList.toggle('hidden', s.tx || !s.rx.length)
    if (!s.tx)
      s.rx.forEach((r, i) => {
        if (i) c.rx.append(el('span', 'rd-sep', '+'))
        c.rx.append(waveIcon())
        const b = el('b')
        b.textContent = r.name
        b.style.color = r.color
        c.rx.append(b)
        if (r.weak) {
          const w = el('small')
          w.textContent = t('radio.weak')
          c.rx.append(w)
        }
      })
    c.box.classList.toggle('weak', !s.tx && s.rx.some((r) => r.weak))
  }
}
