// Barra de la repetición (estilo «Pista»: cuadrada, oscura, amarillo de cartel para lo activo): línea de
// tiempo con los sucesos, reproducir/pausa, velocidades, cámara, exportar la traza y salir. Va encima
// del panel de instrumentos (no lo tapa) y se puede ocultar (botón o B). Aspecto en replay.css.

import './replay.css'
import { onLangChange, t } from '../i18n.ts'
import type { RecEvent } from './FlightRecorder.ts'

export const SPEEDS = [0.25, 0.5, 1, 2, 4]

export interface ReplayUiHandlers {
  play(): void
  seek(T: number, dragging: boolean): void
  speed(s: number): void
  jump(seconds: number): void
  start(): void
  end(): void
  camera(): void
  gpx(): void
  kml(): void
  exit(): void
  resume(): void
}

export interface ReplayUiState {
  T: number
  t0: number
  t1: number
  playing: boolean
  speed: number
  cam: string
  /** px desde abajo: encima del panel de instrumentos */
  bottom: number
}

const svg = (path: string): string => `<svg viewBox="0 0 16 16" aria-hidden="true">${path}</svg>`
const ICON = {
  start: svg('<rect x="2" y="3" width="2" height="10"/><path d="M14 3v10L5 8z"/>'),
  end: svg('<rect x="12" y="3" width="2" height="10"/><path d="M2 3v10l9-5z"/>'),
  back: svg('<path d="M8 3v10L1 8zM15 3v10L8 8z"/>'),
  fwd: svg('<path d="M1 3v10l7-5zM8 3v10l7-5z"/>'),
  play: svg('<path d="M4 2.5v11L13.5 8z"/>'),
  pause: svg('<rect x="3.5" y="3" width="3" height="10"/><rect x="9.5" y="3" width="3" height="10"/>'),
  hide: svg('<path d="M3 5.5l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"/>'),
  show: svg('<path d="M3 10.5l5-5 5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"/>'),
}

/** m:ss (o h:mm:ss) */
export function clock(s: number): string {
  s = Math.max(0, Math.floor(s))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const speedLabel = (s: number): string => (s === 0.25 ? '¼×' : s === 0.5 ? '½×' : `${s}×`)

export class ReplayUi {
  readonly el: HTMLDivElement
  private readonly panel: HTMLDivElement
  private readonly tab: HTMLButtonElement
  private readonly hold: HTMLDivElement
  private readonly rail: HTMLDivElement
  private readonly fill: HTMLDivElement
  private readonly thumb: HTMLDivElement
  private readonly marks: HTMLDivElement
  private readonly cur: HTMLElement
  private readonly dur: HTMLElement
  private readonly playBtn: HTMLButtonElement
  private readonly camLabel: HTMLElement
  private readonly speedBtns: HTMLButtonElement[] = []
  dragging = false
  private barHidden = false
  private last = ''
  private span = { t0: 0, t1: 1 }
  private events: RecEvent[] = []
  private eventsKey = ''
  private readonly h: ReplayUiHandlers

  constructor(h: ReplayUiHandlers) {
    this.h = h
    const el = document.createElement('div')
    el.id = 'replay'
    el.className = 'hidden'
    el.innerHTML = `
      <div class="rp-panel" role="region">
        <div class="rp-top">
          <span class="rp-tag"></span>
          <span class="rp-time"><b class="rp-cur">0:00</b><span class="rp-sep">/</span><span class="rp-dur">0:00</span></span>
          <div class="rp-track"><div class="rp-rail"><div class="rp-fill"></div><div class="rp-marks"></div><div class="rp-thumb"></div></div></div>
        </div>
        <div class="rp-row">
          <div class="rp-group">
            <button type="button" data-k="start">${ICON.start}</button>
            <button type="button" data-k="back">${ICON.back}</button>
            <button type="button" data-k="play" class="rp-play">${ICON.play}</button>
            <button type="button" data-k="fwd">${ICON.fwd}</button>
            <button type="button" data-k="end">${ICON.end}</button>
          </div>
          <div class="rp-group rp-speeds"></div>
          <button type="button" data-k="cam" class="rp-cam"><span class="rp-cam-k"></span><span class="rp-cam-name"></span><kbd>C</kbd></button>
          <span class="rp-spacer"></span>
          <div class="rp-group rp-export">
            <span class="rp-export-k"></span>
            <button type="button" data-k="gpx">GPX</button>
            <button type="button" data-k="kml">KML</button>
          </div>
          <button type="button" data-k="hide" class="rp-hide">${ICON.hide}</button>
          <button type="button" data-k="exit" class="rp-exit"><span class="rp-exit-k"></span><kbd>Esc</kbd></button>
        </div>
      </div>
      <button type="button" class="rp-tab hidden" data-k="show">${ICON.show}<span class="rp-tab-k"></span><kbd>B</kbd></button>`
    document.body.appendChild(el)
    this.el = el
    const q = <T extends HTMLElement>(s: string) => el.querySelector(s) as T
    this.panel = q('.rp-panel')
    this.tab = q('.rp-tab')
    this.rail = q('.rp-rail')
    this.fill = q('.rp-fill')
    this.thumb = q('.rp-thumb')
    this.marks = q('.rp-marks')
    this.cur = q('.rp-cur')
    this.dur = q('.rp-dur')
    this.playBtn = q('.rp-play')
    this.camLabel = q('.rp-cam-name')
    const sp = q('.rp-speeds')
    for (const s of SPEEDS) {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = speedLabel(s)
      b.addEventListener('click', () => h.speed(s))
      sp.appendChild(b)
      this.speedBtns.push(b)
    }
    // pausa tras salir de la repetición (en vuelo): Espacio o clic para seguir
    this.hold = document.createElement('div')
    this.hold.id = 'replay-hold'
    this.hold.className = 'hidden'
    this.hold.addEventListener('click', () => h.resume())
    document.body.appendChild(this.hold)

    const act: Record<string, () => void> = {
      start: () => h.start(),
      back: () => h.jump(-10),
      play: () => h.play(),
      fwd: () => h.jump(10),
      end: () => h.end(),
      cam: () => h.camera(),
      gpx: () => h.gpx(),
      kml: () => h.kml(),
      hide: () => this.toggleBar(),
      show: () => this.toggleBar(),
      exit: () => h.exit(),
    }
    for (const b of el.querySelectorAll<HTMLButtonElement>('button[data-k]')) {
      // sin foco tras el clic: Espacio es reproducir/pausa, no «pulsar otra vez el botón»
      b.addEventListener('mousedown', (e) => e.preventDefault())
      b.addEventListener('click', () => act[b.dataset.k!]?.())
    }
    for (const b of this.speedBtns) b.addEventListener('mousedown', (e) => e.preventDefault())
    // la barra no deja pasar el ratón a la escena (arrastrar en ella no gira la cámara)
    for (const ev of ['mousedown', 'wheel', 'contextmenu'] as const) this.panel.addEventListener(ev, (e) => e.stopPropagation())

    // línea de tiempo: arrastrar (o pinchar) para ir a un instante
    const seekAt = (e: PointerEvent, dragging: boolean) => {
      const r = this.rail.getBoundingClientRect()
      const k = Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width)))
      h.seek(this.span.t0 + k * (this.span.t1 - this.span.t0), dragging)
    }
    const track = q<HTMLDivElement>('.rp-track')
    track.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      track.setPointerCapture(e.pointerId)
      this.dragging = true
      track.classList.add('drag')
      seekAt(e, true)
    })
    track.addEventListener('pointermove', (e) => {
      if (this.dragging) seekAt(e, true)
    })
    const up = (e: PointerEvent) => {
      if (!this.dragging) return
      this.dragging = false
      track.classList.remove('drag')
      seekAt(e, false)
    }
    track.addEventListener('pointerup', up)
    track.addEventListener('pointercancel', up)
    this.relabel()
    onLangChange(() => this.relabel())
  }

  private relabel(): void {
    const set = (s: string, txt: string) => ((this.el.querySelector(s) as HTMLElement).textContent = txt)
    set('.rp-tag', t('replay.tag'))
    set('.rp-cam-k', t('replay.camera'))
    set('.rp-export-k', t('replay.export'))
    set('.rp-exit-k', t('replay.exit'))
    set('.rp-tab-k', t('replay.tag'))
    this.panel.setAttribute('aria-label', t('replay.tag'))
    const title = (k: string, key: string) => (this.el.querySelector(`[data-k="${k}"]`) as HTMLElement).setAttribute('title', t(key))
    title('start', 'replay.t.start')
    title('back', 'replay.t.back')
    title('play', 'replay.t.play')
    title('fwd', 'replay.t.fwd')
    title('end', 'replay.t.end')
    title('cam', 'replay.t.cam')
    title('gpx', 'replay.t.gpx')
    title('kml', 'replay.t.kml')
    title('hide', 'replay.t.hide')
    title('show', 'replay.t.show')
    title('exit', 'replay.t.exit')
    for (const [i, b] of this.speedBtns.entries()) b.title = t('replay.t.speed', { s: speedLabel(SPEEDS[i]) })
    this.hold.innerHTML = `<span class="rp-tag">${t('replay.hold.tag')}</span> ${t('replay.hold')}`
    this.eventsKey = ''
  }

  show(): void {
    this.el.classList.remove('hidden')
    this.last = ''
  }
  hide(): void {
    this.el.classList.add('hidden')
    this.dragging = false
  }
  get visible(): boolean {
    return !this.el.classList.contains('hidden')
  }

  toggleBar(): void {
    this.barHidden = !this.barHidden
    this.panel.classList.toggle('hidden', this.barHidden)
    this.tab.classList.toggle('hidden', !this.barHidden)
  }

  setHold(on: boolean): void {
    this.hold.classList.toggle('hidden', !on)
  }

  /** Marcas de los sucesos sobre la línea de tiempo (despegue, toma, accidente). */
  setEvents(events: RecEvent[], label: (e: RecEvent) => string): void {
    const key = events.map((e) => `${e.kind}${e.t.toFixed(1)}`).join('|') + `|${this.span.t0.toFixed(1)}|${this.span.t1.toFixed(1)}`
    if (key === this.eventsKey) return
    this.eventsKey = key
    this.events = events
    this.marks.textContent = ''
    const { t0, t1 } = this.span
    for (const e of events) {
      if (e.t < t0 || e.t > t1) continue
      const m = document.createElement('span')
      m.className = `rp-mark ${e.kind}`
      m.style.left = `${((e.t - t0) / Math.max(1e-6, t1 - t0)) * 100}%`
      m.title = label(e)
      this.marks.appendChild(m)
    }
  }

  update(s: ReplayUiState): void {
    this.span.t0 = s.t0
    this.span.t1 = s.t1
    const k = Math.min(1, Math.max(0, (s.T - s.t0) / Math.max(1e-6, s.t1 - s.t0)))
    const key = `${k.toFixed(4)}|${s.playing}|${s.speed}|${s.cam}|${s.bottom}|${Math.floor(s.T - s.t0)}|${Math.floor(s.t1 - s.t0)}`
    if (key === this.last) return
    this.last = key
    this.fill.style.width = `${k * 100}%`
    this.thumb.style.left = `${k * 100}%`
    this.cur.textContent = clock(s.T - s.t0)
    this.dur.textContent = clock(s.t1 - s.t0)
    this.playBtn.innerHTML = s.playing ? ICON.pause : ICON.play
    this.playBtn.classList.toggle('on', s.playing)
    for (const [i, b] of this.speedBtns.entries()) b.classList.toggle('on', SPEEDS[i] === s.speed)
    this.camLabel.textContent = s.cam
    this.el.style.setProperty('--rp-bottom', `${s.bottom}px`)
  }
}
