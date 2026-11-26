// Panel de telemetría (tecla F3 o Ajustes › Gráficos): FPS, gráfica de tiempos, CPU y GPU por
// sección del fotograma, llamadas de dibujo, memoria, teselas cargadas, errores de la consola y
// dónde está uno (para que una captura de pantalla diga todo lo necesario al depurar).
// Las medidas las toma src/hud/perf.ts; aquí solo se presentan.

import type { WebGLRenderer } from 'three'
import pkg from '../../package.json'
import { t } from '../i18n.ts'
import { HISTORY, perf, type WindowStats } from './perf.ts'
import './telemetry.css'

/** Lo que el panel necesita saber de la partida (lo da main.ts al refrescar el texto). */
export interface TelemetryInfo {
  gpu: string
  /** calidad efectiva ('low' | 'medium' | 'high' | 'ultra') */
  quality: string
  /** origen del terreno y la foto, ya en texto */
  terrain: string
  place: string
  lat: number
  lon: number
  altFt: number
  camera: string
  /** hora local simulada (hh:mm) */
  clock: string
  /** otros pilotos en la sala; -1 = sin sala */
  peers: number
  /** viento del terreno en el aparato, ya en texto (vacío = apagado) */
  wind?: string
  /** teselas del terreno (3d-tiles-renderer) */
  tiles: { stats?: Record<string, number>; lruCache?: { cachedBytes?: number; maxBytesSize?: number } } | null
  /** capas por teselas z14 (edificios, árboles, puentes…) */
  layers: { key: string; layer: unknown }[]
}

/** Tirón: fotograma de más de 50 ms. Por encima de 1,5 s se supone pestaña oculta, no tirón. */
const HITCH_MS = 50
const HIDDEN_MS = 1500
const REFRESH_MS = 500

interface LoggedError {
  msg: string
  at: number
}

export class Telemetry {
  readonly el: HTMLElement
  private readonly fpsEl: HTMLElement
  private readonly boundEl: HTMLElement
  private readonly body: HTMLElement
  private readonly graph: HTMLCanvasElement
  private readonly g2d: CanvasRenderingContext2D
  private _visible = false
  private lastText = -1e9
  private win: WindowStats | null = null
  /** tirones del último minuto (instante, duración) */
  private hitches: { at: number; ms: number }[] = []
  private errors: LoggedError[] = []
  private errorCount = 0
  private contextLost = false
  private renderer: WebGLRenderer

  constructor(renderer: WebGLRenderer) {
    this.renderer = renderer
    perf.attach(renderer)
    const el = document.createElement('div')
    el.id = 'telemetry'
    el.className = 'hidden'
    el.setAttribute('aria-hidden', 'true')
    el.innerHTML = `
      <div class="tl-head"><span class="tl-title"></span><kbd>F3</kbd><span class="tl-ver">v${pkg.version}</span></div>
      <div class="tl-fps"><b>--</b><span>FPS</span><em></em></div>
      <canvas class="tl-graph"></canvas>
      <div class="tl-legend"></div>
      <div class="tl-body"></div>`
    document.body.appendChild(el)
    this.el = el
    this.fpsEl = el.querySelector('.tl-fps b')!
    this.boundEl = el.querySelector('.tl-fps em')!
    this.body = el.querySelector('.tl-body')!
    this.graph = el.querySelector('.tl-graph')!
    this.g2d = this.graph.getContext('2d')!
    this.hookErrors()
    renderer.domElement.addEventListener('webglcontextlost', () => (this.contextLost = true))
    renderer.domElement.addEventListener('webglcontextrestored', () => (this.contextLost = false))
  }

  get visible(): boolean {
    return this._visible
  }

  set visible(v: boolean) {
    this._visible = v
    perf.wanted = v
    this.el.classList.toggle('hidden', !v)
    this.lastText = -1e9
    if (v) {
      // descarta lo medido antes de abrirlo (la primera ventana sale entera)
      perf.takeWindow()
      this.win = null
    }
  }

  /**
   * Cada fotograma, después de perf.endFrame(). `info` solo se pide al refrescar el texto
   * (dos veces por segundo).
   */
  update(info: () => TelemetryInfo): void {
    const now = performance.now()
    const rec = perf.history[perf.head]
    if (rec && rec.dt > HITCH_MS && rec.dt < HIDDEN_MS) this.hitches.push({ at: now, ms: rec.dt })
    while (this.hitches.length && now - this.hitches[0].at > 60e3) this.hitches.shift()
    if (!this._visible) return
    this.drawGraph()
    if (now - this.lastText < REFRESH_MS) return
    this.lastText = now
    this.win = perf.takeWindow()
    this.renderText(this.win, info())
    this.placeBelowPilots()
  }

  // ---------------------------------------------------------------------------
  // Gráfica de tiempos (barras = fotograma, línea amarilla = CPU, línea blanca = GPU)
  // ---------------------------------------------------------------------------
  private drawGraph(): void {
    const c = this.graph
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const cssW = c.clientWidth || 300
    const cssH = c.clientHeight || 58
    const W = Math.round(cssW * dpr)
    const H = Math.round(cssH * dpr)
    if (c.width !== W || c.height !== H) {
      c.width = W
      c.height = H
    }
    const g = this.g2d
    g.clearRect(0, 0, W, H)
    const hist = perf.history
    const head = perf.head
    // escala: la menor que quepa (20, 33, 50, 100 o 200 ms) con los fotogramas a la vista
    let peak = 0
    for (const r of hist) if (r.dt < HIDDEN_MS && r.dt > peak) peak = r.dt
    const top = [20, 1000 / 30 + 3, 50, 100, 200].find((s) => peak * 1.05 <= s) ?? 200
    const y = (ms: number) => H - (Math.min(ms, top) / top) * (H - 2 * dpr)
    const bw = W / HISTORY
    // guías de 10, 20, 30, 60 y 120 FPS (de arriba abajo)
    g.font = `${10 * dpr}px 'Barlow Condensed', sans-serif`
    g.textBaseline = 'bottom'
    let labelY = -Infinity
    for (const [ms, fps] of [
      [100, 10],
      [50, 20],
      [1000 / 30, 30],
      [1000 / 60, 60],
      [1000 / 120, 120],
    ]) {
      if (ms >= top) continue
      const yy = Math.round(y(ms)) + 0.5
      g.fillStyle = 'rgba(255,255,255,0.16)'
      g.fillRect(0, yy, W, dpr)
      // (con escala grande las guías bajas se juntan: se rotula solo si cabe)
      if (yy - labelY < 11 * dpr) continue
      g.fillStyle = 'rgba(255,255,255,0.45)'
      // (pegada al borde de arriba, el rótulo va debajo de su línea)
      g.fillText(String(fps), W - 16 * dpr, yy < 11 * dpr ? yy + 11 * dpr : yy - dpr)
      labelY = yy
    }
    // barras del fotograma, del más viejo (izquierda) al último (derecha)
    for (let k = 0; k < HISTORY; k++) {
      const r = hist[(head + 1 + k) % HISTORY]
      if (!(r.dt > 0) || r.dt >= HIDDEN_MS) continue
      g.fillStyle = r.dt > HITCH_MS ? '#d8262b' : r.dt > 1000 / 30 ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.26)'
      const yy = y(r.dt)
      g.fillRect(k * bw, yy, Math.max(1, bw - 0.4 * dpr), H - yy)
    }
    // líneas de CPU y GPU
    const line = (pick: (k: number) => number, color: string) => {
      g.strokeStyle = color
      g.lineWidth = 1.4 * dpr
      g.beginPath()
      let pen = false
      for (let k = 0; k < HISTORY; k++) {
        const v = pick((head + 1 + k) % HISTORY)
        if (!(v >= 0)) {
          pen = false
          continue
        }
        const xx = (k + 0.5) * bw
        if (pen) g.lineTo(xx, y(v))
        else g.moveTo(xx, y(v))
        pen = true
      }
      g.stroke()
    }
    line((i) => hist[i].cpu, '#f6c400')
    if (perf.gpuSupported) line((i) => hist[i].gpu, '#ffffff')
  }

  // ---------------------------------------------------------------------------
  // Texto
  // ---------------------------------------------------------------------------
  private renderText(w: WindowStats, info: TelemetryInfo): void {
    const fps = w.span > 0 ? (w.frames * 1000) / w.span : 0
    this.fpsEl.textContent = String(Math.round(fps))
    this.el.classList.toggle('tl-warn', fps < 30 && fps >= 20)
    this.el.classList.toggle('tl-bad', fps < 20)
    this.el.querySelector('.tl-title')!.textContent = t('tel.title')
    this.el.querySelector('.tl-legend')!.innerHTML =
      `<span class="tl-sw tl-sw-frame"></span>${t('tel.frame')}` +
      `<span class="tl-sw tl-sw-cpu"></span>CPU` +
      (perf.gpuSupported ? `<span class="tl-sw tl-sw-gpu"></span>GPU` : '')

    // tiempos del fotograma: percentiles sobre el historial
    const dts: number[] = []
    for (const r of perf.history) if (r.dt > 0 && r.dt < HIDDEN_MS) dts.push(r.dt)
    dts.sort((a, b) => a - b)
    const pct = (p: number) => (dts.length ? dts[Math.min(dts.length - 1, Math.floor(p * dts.length))] : NaN)
    const frame = fps > 0 ? 1000 / fps : NaN
    const best = dts.length ? dts[Math.floor(dts.length * 0.05)] : NaN

    // qué limita: la GPU, la CPU (nuestro bucle) o lo demás (pantalla, cargas, recolector)
    let bound: string
    if (perf.gpuSupported && w.gpu > 0.8 * frame) bound = 'gpu'
    else if (w.cpu > 0.8 * frame) bound = 'cpu'
    else if (frame < best * 1.2) bound = 'vsync'
    else bound = 'main'
    this.boundEl.textContent = t(`tel.bound.${bound}`)
    this.boundEl.className = `tl-bound-${bound}`

    const h: string[] = []
    const kv = (k: string, v: string) => `<span class="tl-k">${k}</span> <span class="tl-v">${v}</span>`
    h.push(
      `<div class="tl-row">${kv(t('tel.frame'), `${ms(frame)} ms`)}${kv('P95', ms(pct(0.95)))}${kv('P99', ms(pct(0.99)))}${kv(t('tel.peak'), ms(dts[dts.length - 1]))}</div>`,
    )
    h.push(
      `<div class="tl-row">${kv('CPU', `${ms(w.cpu)} ms`)}${kv('GPU', perf.gpuSupported ? `${ms(w.gpu)} ms` : t('tel.na'))}</div>`,
    )
    const worst = this.hitches.reduce((m, x) => Math.max(m, x.ms), 0)
    h.push(
      `<div class="tl-row${this.hitches.length ? ' tl-hot' : ''}">${kv(t('tel.hitches'), String(this.hitches.length))}${
        this.hitches.length ? kv(t('tel.worst'), `${Math.round(worst)} ms`) : ''
      }</div>`,
    )
    // lo grave, arriba (que no se corte en pantallas bajas)
    if (this.contextLost) h.push(`<div class="tl-row tl-err">${t('tel.contextLost')}</div>`)
    if (this.errorCount) {
      const last = this.errors[this.errors.length - 1]
      const ago = Math.round((performance.now() - last.at) / 1000)
      h.push(
        `<div class="tl-row tl-err"><b>${this.errorCount === 1 ? t('tel.errors1') : t('tel.errors', { n: this.errorCount })}</b> · ${t('tel.ago', { s: ago })}<br>${esc(last.msg)}</div>`,
      )
    }

    // secciones del fotograma
    h.push(`<div class="tl-sec tl-sec-head"><span>${t('tel.section')}</span><span>CPU</span><span>GPU</span><span>${t('tel.draws')}</span></div>`)
    const maxCpu = Math.max(...w.sections.map((s) => s.cpu), 0)
    const maxGpu = Math.max(...w.sections.map((s) => (s.gpu >= 0 ? s.gpu : 0)), 0)
    for (const s of w.sections) {
      const hotC = s.cpu > 2 && s.cpu >= maxCpu * 0.999
      const hotG = s.gpu > 2 && s.gpu >= maxGpu * 0.999
      h.push(
        `<div class="tl-sec"><span>${esc(t(`tel.sec.${s.key}`))}</span><span${hotC ? ' class="tl-hot"' : ''}>${ms(s.cpu)}</span><span${
          hotG ? ' class="tl-hot"' : ''
        }>${perf.gpuSupported ? (s.gpu < 0.005 ? '·' : ms(s.gpu)) : '–'}</span><span>${s.calls >= 0.5 ? Math.round(s.calls) : '·'}</span></div>`,
      )
    }

    // dibujos y memoria
    const mem = this.renderer.info.memory
    const progs = this.renderer.info.programs?.length ?? 0
    h.push(`<div class="tl-sep"></div>`)
    h.push(
      `<div class="tl-row">${kv(t('tel.draws'), String(Math.round(w.calls)))}${kv(t('tel.tris'), count(w.tris))}${kv(t('tel.renders'), String(Math.round(w.renders)))}</div>`,
    )
    // (cifra delante: «748 geom. · 767 text.»)
    const list = (k: string, items: string[]) => `<div class="tl-row tl-list">${kv(k, '')}<span>${items.filter(Boolean).join(' · ')}</span></div>`
    h.push(
      list(t('tel.memory'), [
        `<b>${mem.geometries}</b> ${t('tel.geoms')}`,
        `<b>${mem.textures}</b> ${t('tel.textures')}`,
        `<b>${progs}</b> ${t('tel.shaders')}`,
      ]),
    )
    const heap = (performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory
    if (heap) h.push(list(t('tel.heap'), [`<b>${mb(heap.usedJSHeapSize)}</b> / ${mb(heap.jsHeapSizeLimit)} MB`]))

    // teselas del terreno y capas
    const st = info.tiles?.stats
    if (st) {
      const lru = info.tiles?.lruCache
      const loading = (st.queued ?? 0) + (st.downloading ?? 0) + (st.parsing ?? 0)
      const full = lru?.maxBytesSize ? (lru.cachedBytes ?? 0) / lru.maxBytesSize : 0
      h.push(
        list(t('tel.terrain'), [
          `<b>${st.visible ?? 0}</b> ${t('tel.visible')}`,
          `<b>${st.inCache ?? 0}</b> ${t('tel.cached')}` +
            (lru?.maxBytesSize ? ` <span${full > 0.97 ? ' class="tl-hot"' : ''}>(${mb(lru.cachedBytes ?? 0)}/${mb(lru.maxBytesSize)} MB)</span>` : ''),
          loading ? `<b>${loading}</b> ${t('tel.loading')}` : '',
          // (pedidas en la última actualización que no cupieron: caché llena)
          st.refused ? `<span class="tl-hot"><b>${st.refused}</b> ${t('tel.refused')}</span>` : '',
          st.failed ? `<span class="tl-hot"><b>${st.failed}</b> ${t('tel.failed')}</span>` : '',
        ]),
      )
    }
    const layers: string[] = []
    for (const { key, layer } of info.layers) {
      const tiles = (layer as { tiles?: unknown } | null)?.tiles
      if (!(tiles instanceof Map)) continue
      let ready = 0
      let loading = 0
      for (const x of tiles.values()) {
        const s = (x as { state?: string }).state
        if (s === 'ready') ready++
        else if (s === 'loading') loading++
      }
      layers.push(`<b>${ready}</b> ${t(`tel.layer.${key}`)}${loading ? ` <i>(+${loading})</i>` : ''}`)
    }
    if (layers.length) h.push(list(t('tel.layers'), layers))

    // dónde y con qué (para las capturas)
    h.push(`<div class="tl-sep"></div>`)
    const cv = this.renderer.domElement
    h.push(
      `<div class="tl-row tl-ctx">${esc(info.gpu)} · ${t(`tel.q.${info.quality}`)} · ${cv.width}×${cv.height} ×${this.renderer.getPixelRatio().toFixed(2).replace(/\.?0+$/, '')}</div>`,
    )
    h.push(
      `<div class="tl-row tl-ctx">${info.lat.toFixed(5)}° ${info.lon.toFixed(5)}° · ${Math.round(info.altFt)} ft · ${esc(info.camera)} · ${info.clock}</div>`,
    )
    h.push(
      `<div class="tl-row tl-ctx">${esc(info.place)}${info.terrain ? ` · ${esc(info.terrain)}` : ''}${
        info.peers >= 0 ? ` · ${t('tel.room', { n: info.peers + 1 })}` : ''
      }</div>`,
    )
    if (info.wind) h.push(`<div class="tl-row tl-ctx">${esc(info.wind)}</div>`)
    this.body.innerHTML = h.join('')
  }

  /**
   * En una sala, la lista de pilotos ocupa la misma esquina, y en el menú están el idioma y
   * los mandos: el panel va debajo.
   */
  private placeBelowPilots(): void {
    let below = 0
    for (const sel of ['.mp-hud', '#menu .m-head']) {
      // (oculto = display none = rectángulo vacío; offsetParent no vale: es null en los fijos)
      const r = document.querySelector(sel)?.getBoundingClientRect()
      if (r && r.height > 0) below = Math.max(below, r.bottom)
    }
    this.el.style.top = below > 0 ? `${Math.round(below + 8)}px` : ''
  }

  /** Cuenta los errores de la consola y de la página (el último sale en el panel). */
  private hookErrors(): void {
    const push = (msg: string) => {
      this.errorCount++
      this.errors.push({ msg: msg.replace(/\s+/g, ' ').slice(0, 220), at: performance.now() })
      if (this.errors.length > 5) this.errors.shift()
    }
    const orig = console.error.bind(console)
    console.error = (...args: unknown[]) => {
      push(args.map(fmtArg).join(' '))
      orig(...args)
    }
    window.addEventListener('error', (e) => push(e.message || String(e.error)))
    window.addEventListener('unhandledrejection', (e) => push(`(promesa) ${fmtArg(e.reason)}`))
  }
}

function fmtArg(a: unknown): string {
  if (a instanceof Error) return `${a.name}: ${a.message}`
  if (typeof a === 'string') return a
  try {
    return JSON.stringify(a)
  } catch {
    return String(a)
  }
}

function ms(v: number): string {
  if (!(v >= 0)) return '–'
  return v < 10 ? v.toFixed(2) : v.toFixed(1)
}

function mb(bytes: number): string {
  return String(Math.round(bytes / 1048576))
}

function count(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} M`
  if (n >= 1e3) return `${Math.round(n / 1e3)} k`
  return String(Math.round(n))
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}
