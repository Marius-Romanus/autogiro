// Guía de pilotaje lateral: tarjeta a la izquierda con lo que toca hacer ahora.
//
// - En tierra: pasos del despegue.
// - En vuelo: cómo se lleva (velocidad con la palanca, altura con el gas) y cómo aterrizar.
// - Tras tomar tierra, mientras rueda: dos caminos, PARAR o VOLVER A DESPEGAR. El gas
//   decide cuál se resalta (ralentí = parar; gas a fondo = toma y despegue), así que el
//   piloto no tiene que avisar de lo que quiere: lo dice la mano en el gas.
// - Ya parado tras el aterrizaje, vuelve a los pasos del despegue.
//
// Se muestra u oculta con la tecla J o con el botón «Guía» de la barra superior, y se
// recuerda en los ajustes.

import { has, t } from '../i18n.ts'

export type GuidePhase = 'ground' | 'flight' | 'landing'

export interface GuideInput {
  /** se ve (no hay menú ni panel de accidente encima) */
  active: boolean
  onGround: boolean
  /** m/s */
  groundSpeed: number
  /** 0…1 */
  throttle: number
  cierva: boolean
}

/** tiempo que tiene que mantenerse una fase nueva antes de cambiar (rebotes, despegues indecisos) */
const SWITCH_DELAY = 0.4
/** tras aterrizar, parado este tiempo → otra vez pasos del despegue */
const STOPPED_DELAY = 1.5
/** por debajo de esto (m/s) se considera parado */
const STOPPED_SPEED = 1
/** con más gas que esto, tras aterrizar, se entiende que quiere volver a despegar */
const GO_THROTTLE = 0.6

export class Guide {
  phase: GuidePhase = 'ground'
  private pending: GuidePhase = 'ground'
  private pendingT = 0
  private stoppedT = 0
  private goAround = false
  private rendered = ''
  private readonly el: HTMLElement
  private readonly btn: HTMLElement

  visible: boolean
  private readonly onToggle: (visible: boolean) => void

  constructor(visible: boolean, onToggle: (visible: boolean) => void) {
    this.visible = visible
    this.onToggle = onToggle
    this.el = document.getElementById('tips')!
    this.btn = document.getElementById('btn-guide')!
    // sin foco tras el clic: si no, Espacio (frenos) volvería a pulsar el botón
    this.btn.addEventListener('mousedown', (e) => e.preventDefault())
    this.btn.addEventListener('click', () => this.toggle())
    this.el.querySelector('.close')?.addEventListener('click', () => this.toggle(false))
    this.syncButton()
  }

  /** Al (re)aparecer: en pista empieza en tierra; en el aire, en vuelo. */
  reset(onGround: boolean): void {
    this.phase = this.pending = onGround ? 'ground' : 'flight'
    this.pendingT = this.stoppedT = 0
    this.goAround = false
    this.rendered = ''
  }

  toggle(v = !this.visible): void {
    this.visible = v
    this.syncButton()
    this.onToggle(v)
  }

  /** Vuelve a pintar el texto (cambio de idioma). */
  refresh(): void {
    this.rendered = ''
  }

  update(dt: number, s: GuideInput): void {
    // --- fase ---
    let want: GuidePhase
    if (!s.onGround) want = 'flight'
    else if (this.phase === 'ground') want = 'ground'
    else {
      // en tierra después de volar: rodando = aterrizaje; parado un rato = en tierra
      this.stoppedT = s.groundSpeed < STOPPED_SPEED ? this.stoppedT + dt : 0
      want = this.stoppedT > STOPPED_DELAY ? 'ground' : 'landing'
    }
    if (want === this.phase) this.pendingT = 0
    else {
      if (want !== this.pending) this.pendingT = 0
      this.pending = want
      this.pendingT += dt
      // el paso a «parado» ya lleva su propia espera
      if (this.pendingT >= SWITCH_DELAY || (want === 'ground' && this.phase === 'landing')) {
        this.phase = want
        this.pendingT = this.stoppedT = 0
      }
    }
    // tras tomar tierra, el gas dice si quiere parar o volver a despegar (con histéresis)
    if (this.phase === 'landing') {
      if (s.throttle > GO_THROTTLE) this.goAround = true
      else if (s.throttle < GO_THROTTLE - 0.2) this.goAround = false
    } else this.goAround = false

    // --- tarjeta ---
    const show = this.visible && s.active
    this.el.classList.toggle('hidden', !show)
    if (!show) return
    const key = `${this.phase}|${s.cierva}|${this.goAround}`
    if (key === this.rendered) return
    this.rendered = key
    this.el.dataset.phase = this.phase
    const body = this.el.querySelector<HTMLElement>('.guide-body')!
    body.innerHTML = this.html(s.cierva)
  }

  private html(cierva: boolean): string {
    const k = (key: string) => t(cierva && has(`guide.cierva.${key}`) ? `guide.cierva.${key}` : `guide.${key}`)
    const foot = `<p class="guide-foot">${t('guide.foot')}</p>`
    switch (this.phase) {
      case 'ground':
        return `<h3>${k('ground.title')}</h3><ol>${k('ground.steps')}</ol>
          <p class="muted">${k('ground.note')}</p><p class="muted">${k('ground.warn')}</p>${foot}`
      case 'flight':
        return `<h3>${k('flight.title')}</h3><ul>${k('flight.tips')}</ul>
          <h4>${k('flight.landTitle')}</h4><ol>${k('flight.land')}</ol>${foot}`
      case 'landing': {
        const stop = this.goAround ? 'dim' : 'on'
        const go = this.goAround ? 'on' : 'dim'
        return `<h3>${k('landing.title')}</h3>
          <p class="muted">${k('landing.choose')}</p>
          <section class="guide-choice ${stop}"><h4>${k('landing.stopTitle')}</h4><ol>${k('landing.stop')}</ol></section>
          <section class="guide-choice ${go}"><h4>${k('landing.goTitle')}</h4><ol>${k('landing.go')}</ol></section>${foot}`
      }
    }
  }

  private syncButton(): void {
    this.btn.classList.toggle('on', this.visible)
    this.btn.setAttribute('aria-pressed', String(this.visible))
  }
}
