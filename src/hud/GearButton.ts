// Botón «Tren» de la barra superior (tecla Y), como el de las luces: solo aparece con un aparato cuyo
// tren se recoge de verdad, y su luz dice dónde está, con los colores del indicador del panel (Hud.ts):
// verde abajo, ámbar parpadeando mientras se mueve, azul arriba.
//
// Del catálogo, con tren que se recoge:
//  - los flotadores anfibios del Cavalon y del MT-03 (floatKit.ts): ruedas que suben dentro del flotador
//    para el agua;
//  - el tren retráctil de la ficha (`af.retractGear`).
// El resto lo lleva fijo, también el Carter PAV: en las fotos vuela con las ruedas fuera (AOPA, 2015) y
// ninguna fuente dice que se recoja; el retráctil era el del CarterCopter, su demostrador anterior.

import { addStrings, onLangChange, t } from '../i18n.ts'
import './gearButton.css'

export type GearKind = 'amphib' | 'retract'
type GearState = 'down' | 'up' | 'moving'

addStrings('es', {
  'gearBtn.label': 'Tren',
  'gearBtn.amphib': 'Tren anfibio (Y): arriba para el agua, abajo para tomar en tierra',
  'gearBtn.retract': 'Tren retráctil (Y): se sube en vuelo para ir más rápido y se baja para tomar',
  'gearBtn.down': 'Ahora abajo',
  'gearBtn.up': 'Ahora arriba',
  'gearBtn.moving': 'Moviéndose',
})
addStrings('en', {
  'gearBtn.label': 'Gear',
  'gearBtn.amphib': 'Amphibious gear (Y): up for water, down to land on the ground',
  'gearBtn.retract': 'Retractable gear (Y): raise it in flight to go faster, lower it to land',
  'gearBtn.down': 'Now down',
  'gearBtn.up': 'Now up',
  'gearBtn.moving': 'In transit',
})

export class GearButton {
  private readonly btn: HTMLButtonElement
  private readonly lights: HTMLElement | null
  private kind: GearKind | null = null
  private state: GearState | null = null

  constructor() {
    const b = document.createElement('button')
    b.id = 'btn-gear'
    b.type = 'button'
    b.className = 'hidden'
    b.setAttribute('aria-pressed', 'true')
    b.innerHTML = '<span class="lamp" aria-hidden="true"></span><span class="label"></span><kbd>Y</kbd>'
    // sin foco tras el clic: si no, Espacio (frenos) volvería a pulsar el botón
    b.addEventListener('mousedown', (e) => e.preventDefault())
    this.btn = b
    this.lights = document.getElementById('btn-lights')
    if (this.lights) this.lights.after(b)
    else document.getElementById('topbar')?.appendChild(b)
    this.relabel()
    onLangChange(() => this.relabel())
  }

  /** El botón (main.ts le pone el clic). */
  get button(): HTMLButtonElement {
    return this.btn
  }

  /**
   * Cada fotograma: qué tren lleva el aparato (null: fijo, sin botón) y dónde está (1 abajo, 0 recogido).
   * Solo toca el DOM cuando algo cambia.
   */
  update(kind: GearKind | null, pos: number): void {
    // siempre justo a la derecha de «Luces»: los botones que se crean después (VR, repetición, etiquetas
    // del multijugador, fumigación) también se meten detrás de él y lo empujaban al final
    if (this.lights && this.btn.previousElementSibling !== this.lights) this.lights.after(this.btn)
    const state: GearState = pos >= 1 ? 'down' : pos <= 0 ? 'up' : 'moving'
    if (kind === this.kind && state === this.state) return
    if (kind !== this.kind) this.btn.classList.toggle('hidden', kind === null)
    this.kind = kind
    this.state = state
    this.btn.classList.remove('down', 'up', 'moving')
    this.btn.classList.add(state)
    this.btn.setAttribute('aria-pressed', String(state !== 'up'))
    this.relabel()
  }

  /** Textos en el idioma de la interfaz. */
  private relabel(): void {
    ;(this.btn.querySelector('.label') as HTMLElement).textContent = t('gearBtn.label')
    this.btn.title = this.kind ? `${t(`gearBtn.${this.kind}`)} · ${t(`gearBtn.${this.state ?? 'down'}`)}` : ''
  }
}
