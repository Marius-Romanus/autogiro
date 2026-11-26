// Guía de pilotaje lateral: tarjeta a la izquierda con lo que toca hacer ahora.
//
// - En tierra: pasos del despegue.
// - En vuelo: cómo se lleva (velocidad con la palanca, altura con el gas) y cómo aterrizar.
// - Tras tomar tierra, mientras rueda: dos caminos, PARAR o VOLVER A DESPEGAR. El gas
//   decide cuál se resalta (ralentí = parar; gas a fondo = toma y despegue), así que el
//   piloto no tiene que avisar de lo que quiere: lo dice la mano en el gas.
// - Ya parado tras el aterrizaje, vuelve a los pasos del despegue.
// - Emergencia de motor en vuelo (simulacro del instructor, fallo, pérdida de potencia, aceite,
//   reserva de combustible: sim/powerplant.ts): el procedimiento de un autogiro con las cifras del
//   aparato sacadas de su modelo de vuelo (sim/glideData.ts).
//
// - Con flotadores en el agua (o yendo a ella): despegue sobre el redán, amaraje y qué hacer al tocar.
//
// Se muestra u oculta con la tecla J o con el botón «Guía» de la barra superior, y se
// recuerda en los ajustes.

import { addStrings, has, t } from '../i18n.ts'

export type GuidePhase = 'ground' | 'flight' | 'landing' | 'emergency'

/** Emergencia de motor para la guía: qué pasa y las cifras del aparato (velocidades, alturas). */
export interface GuideEmergency {
  kind: 'drill' | 'out' | 'power' | 'oil' | 'fuel'
  vars: Record<string, string | number>
}

export interface GuideInput {
  /** se ve (no hay menú ni panel de accidente encima) */
  active: boolean
  onGround: boolean
  /** m/s */
  groundSpeed: number
  /** 0…1 */
  throttle: number
  cierva: boolean
  /**
   * aparato del catálogo: sus pasos propios `guide.<id>.<clave>` (los Cierva de cabeza fija, el C.6 que
   * arranca el rotor con cuerda) sustituyen a los generales; si falta, solo los del C.30A con `cierva`
   */
  aircraft?: string
  /** con flotadores, en el agua o yendo a ella: pasos del hidro (si falta, no) */
  water?: boolean
  /** emergencia de motor en curso (null o falta: ninguna) */
  emergency?: GuideEmergency | null
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
    if (!s.onGround) want = s.emergency ? 'emergency' : 'flight'
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
    const em = this.phase === 'emergency' ? s.emergency : null
    const key = `${this.phase}|${s.aircraft ?? ''}|${s.cierva}|${s.water === true}|${this.goAround}|${em ? `${em.kind}|${Object.values(em.vars).join(',')}` : ''}`
    if (key === this.rendered) return
    this.rendered = key
    this.el.dataset.phase = this.phase
    this.el.dataset.em = em?.kind ?? ''
    const body = this.el.querySelector<HTMLElement>('.guide-body')!
    body.innerHTML = this.html(s.cierva, s.water === true, em ?? null, s.aircraft)
  }

  private html(cierva: boolean, water: boolean, em: GuideEmergency | null, aircraft?: string): string {
    const k = (key: string) =>
      t(
        water && has(`guide.water.${key}`)
          ? `guide.water.${key}`
          : aircraft && has(`guide.${aircraft}.${key}`)
            ? `guide.${aircraft}.${key}`
            : cierva && has(`guide.cierva.${key}`)
              ? `guide.cierva.${key}`
              : `guide.${key}`,
      )
    const foot = `<p class="guide-foot">${t('guide.foot')}</p>`
    switch (this.phase) {
      case 'emergency': {
        if (!em) return ''
        const v = em.vars
        const steps =
          em.kind === 'drill'
            ? t('guide.em.glide', v) + t('guide.em.turns', v) + t('guide.em.drillEnd', v)
            : em.kind === 'out'
              ? t('guide.em.glide', v) + t('guide.em.restart', v) + t('guide.em.turns', v)
              : t(`guide.em.${em.kind}`, v)
        return `<h3 class="guide-em">${t(`guide.em.${em.kind}.title`)}</h3><ol>${steps}</ol>${foot}`
      }
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

// --- en el agua (hidroautogiros: Wilford XOZ-1 y aparatos con flotadores) ---
addStrings('es', {
  'guide.water.ground.title': 'Despegue desde el agua',
  'guide.water.ground.steps': `
    <li>Freno de rotor quitado (<kbd>B</kbd>). En el agua no hay frenos: el aparato deriva con el viento y los pedales mueven los <b>timones de agua</b>.</li>
    <li>Palanca <b>atrás</b> (mantén <kbd>S</kbd>) y gas a ~40 % (<kbd>R</kbd>/<kbd>F</kbd>): así la hélice no mete las proas en el agua.</li>
    <li>Mantén el <b>prerrotador</b> (<kbd>P</kbd>) hasta que el rotor deje de subir (~170 rpm en el Wilford, ~200 en los actuales).</li>
    <li>Suelta <kbd>P</kbd>, <b>todo el gas</b> y la palanca <b>a medias</b>: los flotadores suben al redán y corre planeando, con la proa algo arriba.</li>
    <li>A ~80 km/h <b>tira poco a poco</b>: se despega del agua. Cede palanca para subir a 85-100 km/h.</li>`,
  'guide.water.ground.note': 'Con flotadores se sale del agua y se vuelve a ella: un hidro sin ruedas (el Wilford) no puede tomar en una pista. Con un anfibio, el tren (<kbd>Y</kbd>) va <b>arriba en el agua</b> y abajo solo para tomar en tierra.',
  'guide.water.ground.warn': 'Con el agua picada o un tirón de palanca a poca velocidad las proas se clavan: corre con la palanca a medias y no la empujes.',
  'guide.water.flight.landTitle': 'Para amarizar',
  'guide.water.flight.land': `
    <li>Anfibio: <b>tren arriba</b> (<kbd>Y</kbd>). Con las ruedas fuera, el agua las clava y el aparato vuelca de morro.</li>
    <li>Aproxima a ~80 km/h, contra el viento y en agua abierta, lejos de barcos y orillas.</li>
    <li>Recoge antes que en tierra (a 8-10 m un aparato pesado): toca el agua <b>suave</b>, con el morro un poco arriba. Bajando a más de 4,5 m/s se rompen los montantes.</li>`,
  'guide.water.landing.title': 'En el agua: ¿parar o volver a despegar?',
  'guide.water.landing.stop': `
    <li>Gas al ralentí y palanca atrás: el agua frena sola (no hay frenos).</li>
    <li>Dirige con los pedales (timones de agua) y, ya despacio, freno de rotor (<kbd>B</kbd>).</li>`,
})
addStrings('en', {
  'guide.water.ground.title': 'Taking off from the water',
  'guide.water.ground.steps': `
    <li>Rotor brake off (<kbd>B</kbd>). There are no brakes on the water: the aircraft drifts with the wind and the pedals move the <b>water rudders</b>.</li>
    <li>Stick <b>back</b> (hold <kbd>S</kbd>) and ~40 % throttle (<kbd>R</kbd>/<kbd>F</kbd>), so the propeller does not push the bows under.</li>
    <li>Hold the <b>pre-rotator</b> (<kbd>P</kbd>) until the rotor stops gaining (~170 rpm on the Wilford, ~200 on modern gyros).</li>
    <li>Release <kbd>P</kbd>, <b>full throttle</b> and the stick <b>halfway</b>: the floats climb onto the step and plane, bows slightly up.</li>
    <li>At ~80 km/h <b>ease the stick back</b>: it leaves the water. Then relax it to climb at 85-100 km/h.</li>`,
  'guide.water.ground.note': 'On floats you leave from the water and come back to it: a seaplane without wheels (the Wilford) cannot land on a runway. On an amphibian the gear (<kbd>Y</kbd>) stays <b>up on the water</b> and goes down only to land ashore.',
  'guide.water.ground.warn': 'On choppy water, or pulling hard at low speed, the bows dig in: run with the stick halfway and never push it forward.',
  'guide.water.flight.landTitle': 'To land on water',
  'guide.water.flight.land': `
    <li>Amphibian: <b>gear up</b> (<kbd>Y</kbd>). With the wheels out the water grabs them and flips the aircraft onto its nose.</li>
    <li>Approach at ~80 km/h, into the wind, on open water away from boats and shores.</li>
    <li>Flare earlier than on land (8-10 m for a heavy aircraft): touch the water <b>gently</b>, nose slightly up. Sinking faster than 4.5 m/s breaks the struts.</li>`,
  'guide.water.landing.title': 'On the water: stop or take off again?',
  'guide.water.landing.stop': `
    <li>Throttle to idle and stick back: the water slows you down by itself (no brakes).</li>
    <li>Steer with the pedals (water rudders) and, once slow, apply the rotor brake (<kbd>B</kbd>).</li>`,
})
