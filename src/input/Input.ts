// Mandos: teclado, ratón como palanca y joystick/mando (Gamepad API).

import type { Controls } from '../sim/autogyro.ts'
import { KEY_THROTTLE_RATE, keyPitchRate } from '../sim/assist.ts'
import type { Settings } from '../config.ts'

export type Action =
  | 'camera'
  | 'cameraBack'
  | 'reset'
  | 'pause'
  | 'help'
  | 'prerotator'
  | 'rotorBrake'
  | 'engine'
  | 'hud'
  | 'map'
  | 'mouseStick'
  | 'wheelMode'
  | 'parkBrake'
  | 'zoomIn'
  | 'zoomOut'
  | 'lights'
  | 'guide'

const ACTION_KEYS: Record<string, Action> = {
  KeyC: 'camera',
  KeyV: 'cameraBack',
  Backspace: 'reset',
  Escape: 'pause',
  F1: 'help',
  KeyH: 'help',
  KeyB: 'rotorBrake',
  KeyM: 'engine',
  KeyI: 'hud',
  KeyN: 'map',
  KeyK: 'mouseStick',
  KeyL: 'parkBrake',
  KeyO: 'lights',
  KeyJ: 'guide',
  Equal: 'zoomIn',
  NumpadAdd: 'zoomIn',
  Minus: 'zoomOut',
  NumpadSubtract: 'zoomOut',
}

/** gas por muesca de rueda en modo gas */
const WHEEL_THROTTLE_STEP = 0.05

export class Input {
  readonly keys = new Set<string>()
  private actions: Action[] = []
  // estado de mandos suavizado
  pitch = 0
  roll = 0
  yaw = 0
  throttle = 0
  trim = 0
  parkBrake = true
  // ratón
  mouseStick = false
  /** con el ratón como palanca, la rueda mueve el gas en vez del zoom (botón central alterna) */
  wheelThrottle = false
  /** posición de la palanca de ratón (−1…1 por eje); normalmente = cursor */
  private mouseX = 0
  private mouseY = 0
  /** posición real del cursor (−1…1) */
  private curX = 0
  private curY = 0
  // vista con ratón (arrastre)
  lookDX = 0
  lookDY = 0
  wheel = 0
  dragging = false
  private dragPx = 0
  private lockAsked = false
  private resync = false
  gamepadName = ''
  /** hay entrada activa de cabeceo/alabeo/pedales (para la ayuda de pilotaje) */
  keyPitch = false
  keyRoll = false
  keyYaw = false
  hasJoystick = false
  /** el cabeceo viene de un mando analógico (joystick, mando o ratón) */
  analog = false
  /** posición retenida de la palanca en cabeceo (teclado) */
  keyStick = 0
  private pitchHold = 0
  private lastPitchDir = 0
  private gpThrottleSeen = false
  private lastGpThrottle = -2

  private settings: Settings
  constructor(settings: Settings, el: HTMLElement) {
    this.settings = settings
    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null
      if (target?.tagName === 'INPUT') return
      // Con el desplegable abierto, sus teclas (Esc, flechas, letras) son suyas
      // (con la lista abierta el foco está en la <option>, no en el <select>)
      const sel = target?.closest?.('select')
      if (sel && selectOpen(sel)) return
      if (!this.keys.has(e.code)) {
        const a = ACTION_KEYS[e.code]
        if (a) this.actions.push(a)
      }
      this.keys.add(e.code)
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'F1'].includes(e.code)) e.preventDefault()
    })
    window.addEventListener('keyup', (e) => this.keys.delete(e.code))
    window.addEventListener('blur', () => {
      this.keys.clear()
      this.endDrag(el)
    })
    el.addEventListener('mousedown', (e) => {
      if (e.button === 0 || e.button === 2) {
        this.dragging = true
        this.dragPx = 0
        this.lockAsked = false
      }
      if (e.button === 1) {
        e.preventDefault() // sin autodesplazamiento del navegador
        if (this.mouseStick) this.actions.push('wheelMode')
      }
    })
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0 || e.button === 2) this.endDrag(el)
    })
    // el bloqueo puede llegar después de soltar (clic corto): soltarlo entonces
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement === el && !this.dragging) document.exitPointerLock()
    })
    window.addEventListener('mousemove', (e) => {
      const locked = document.pointerLockElement === el
      const x = locked ? this.curX : (e.clientX / window.innerWidth) * 2 - 1
      const y = locked ? this.curY : (e.clientY / window.innerHeight) * 2 - 1
      // primer evento tras un arrastre: el cursor reaparece, no es un movimiento
      const dx = this.resync ? 0 : x - this.curX
      const dy = this.resync ? 0 : y - this.curY
      if (!this.dragging) this.resync = false
      this.curX = x
      this.curY = y
      if (this.dragging) {
        this.lookDX += e.movementX
        this.lookDY += e.movementY
        // Girar la cámara NO mueve la palanca: se queda donde estaba y se oculta
        // el cursor (pointer lock) para que al soltar siga en el mismo sitio.
        if (this.mouseStick) {
          this.dragPx += Math.abs(e.movementX) + Math.abs(e.movementY)
          if (!this.lockAsked && this.dragPx > 4) {
            this.lockAsked = true
            try {
              const p: unknown = el.requestPointerLock()
              if (p instanceof Promise) p.catch(() => {})
            } catch {
              /* sin bloqueo: la palanca recupera el cursor poco a poco (abajo) */
            }
          }
          return
        }
      }
      if (!this.mouseStick) {
        this.mouseX = x
        this.mouseY = y
        return
      }
      // La palanca sigue al cursor; si quedaron desfasados (arrastre sin bloqueo)
      // se van juntando sólo mientras el ratón se mueve, sin saltos.
      this.mouseX = approach(this.mouseX + dx, x, MOUSE_CATCHUP * Math.abs(dx))
      this.mouseY = approach(this.mouseY + dy, y, MOUSE_CATCHUP * Math.abs(dy))
    })
    el.addEventListener('contextmenu', (e) => e.preventDefault())
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        if (this.wheelIsThrottle) {
          // rueda hacia delante = más gas; 5 % por muesca (≈100 px), proporcional en touchpad
          const px = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 800 : 1)
          const notches = Math.max(-1, Math.min(1, px / 100))
          this.throttle = Math.max(0, Math.min(1, this.throttle - notches * WHEEL_THROTTLE_STEP))
        } else this.wheel += Math.sign(e.deltaY)
      },
      { passive: false },
    )
    this.mouseStick = settings.mouseStick
  }

  private endDrag(el: HTMLElement): void {
    if (!this.dragging) return
    this.dragging = false
    if (document.pointerLockElement === el) {
      this.resync = true
      document.exitPointerLock()
    }
  }

  /** la rueda del ratón está ahora en modo gas */
  get wheelIsThrottle(): boolean {
    return this.mouseStick && this.wheelThrottle
  }

  /** Acción pedida desde fuera del teclado (interruptores de la cabina pulsados con el ratón). */
  trigger(a: Action): void {
    this.actions.push(a)
  }

  consumeActions(): Action[] {
    const a = this.actions
    this.actions = []
    return a
  }

  consumeLook(): { dx: number; dy: number; wheel: number } {
    const r = { dx: this.lookDX, dy: this.lookDY, wheel: this.wheel }
    this.lookDX = this.lookDY = this.wheel = 0
    return r
  }

  /** Actualiza los mandos (dt en s) y los vuelca en `ctl`. */
  update(dt: number, ctl: Controls): void {
    const k = this.keys
    const s = this.settings
    const inv = s.invertPitch ? -1 : 1

    // --- teclado: palanca con retorno suave al centro ---
    let kp = 0
    let kr = 0
    let ky = 0
    if (k.has('KeyS') || k.has('ArrowDown')) kp += 1 // tirar (atrás)
    if (k.has('KeyW') || k.has('ArrowUp')) kp -= 1 // empujar
    if (k.has('KeyD') || k.has('ArrowRight')) kr += 1
    if (k.has('KeyA') || k.has('ArrowLeft')) kr -= 1
    if (k.has('KeyE') || k.has('KeyX')) ky += 1
    if (k.has('KeyQ') || k.has('KeyZ')) ky -= 1
    const rate = (target: number, cur: number, up: number, down: number) => {
      const r = target !== 0 ? up : down
      const d = target - cur
      return cur + Math.sign(d) * Math.min(Math.abs(d), r * dt)
    }
    // Palanca en cabeceo por teclado: MANTIENE la posición (como una palanca
    // compensada). En un autogiro la posición de palanca fija la velocidad, así
    // que soltar la tecla no debe devolverla al centro. Toques cortos = ajuste
    // fino; mantener pulsado = recorrido rápido (recogida). Inicio = centrar.
    const fine = k.has('ShiftRight') || k.has('AltLeft') ? 0.4 : 1
    const dir = kp * inv
    this.pitchHold = dir !== 0 && dir === this.lastPitchDir ? this.pitchHold + dt : 0
    this.lastPitchDir = dir
    this.keyStick = Math.max(-1, Math.min(1, this.keyStick + dir * keyPitchRate(this.pitchHold) * fine * dt))
    if (k.has('Home') || k.has('Numpad5')) this.keyStick = rate(0, this.keyStick, 1.5, 1.5)
    let pitch = this.keyStick
    let roll = rate(kr * fine, this.roll, 1.6, 2.4)
    let yaw = rate(ky, this.yaw, 2.5, 3.0)
    this.keyPitch = dir !== 0
    this.keyRoll = kr !== 0
    this.keyYaw = ky !== 0
    this.analog = false

    // gas
    if (k.has('KeyR') || k.has('PageUp') || k.has('ShiftLeft')) this.throttle = Math.min(1, this.throttle + dt * KEY_THROTTLE_RATE)
    if (k.has('KeyF') || k.has('PageDown')) this.throttle = Math.max(0, this.throttle - dt * KEY_THROTTLE_RATE)
    for (let i = 0; i <= 9; i++) if (k.has(`Digit${i}`)) this.throttle = i === 0 ? 1 : (i - 1) / 9
    // compensador
    if (k.has('KeyT')) this.trim = Math.max(-1, this.trim - dt * 0.35)
    if (k.has('KeyG')) this.trim = Math.min(1, this.trim + dt * 0.35)

    // --- ratón como palanca ---
    if (this.mouseStick) {
      const dz = (v: number) => (Math.abs(v) < 0.03 ? 0 : v)
      pitch = Math.max(-1, Math.min(1, dz(this.mouseY) * 1.6 * inv))
      roll = Math.max(-1, Math.min(1, dz(this.mouseX) * 1.6))
      this.analog = true
    }

    // --- joystick / mando ---
    const pads = navigator.getGamepads?.() ?? []
    for (const gp of pads) {
      if (!gp || !gp.connected) continue
      this.gamepadName = gp.id
      this.hasJoystick = true
      const ax = (i: number) => (i >= 0 && i < gp.axes.length ? gp.axes[i] : 0)
      const dz = (v: number, d = 0.06) => (Math.abs(v) < d ? 0 : (v - Math.sign(v) * d) / (1 - d))
      const isStandard = gp.mapping === 'standard'
      if (isStandard) {
        // mando tipo Xbox: stick izq. = palanca, stick dcho. X = pedales, gatillos = gas
        const p = dz(ax(1))
        const r = dz(ax(0))
        const y = dz(ax(2))
        if (p || r) {
          // el stick del mando se suma a la posición retenida (que hace de compensador)
          pitch = Math.max(-1, Math.min(1, this.keyStick + expo(p) * inv))
          roll = expo(r)
          this.analog = true
        }
        if (y) yaw = expo(y)
        const rt = gp.buttons[7]?.value ?? 0
        const lt = gp.buttons[6]?.value ?? 0
        this.throttle = Math.max(0, Math.min(1, this.throttle + (rt - lt) * dt * 0.6))
        if (gp.buttons[0]?.pressed) ctl.prerotator = true
        ctl.wheelBrake = Math.max(ctl.wheelBrake, gp.buttons[1]?.value ?? 0)
        if (gp.buttons[4]?.pressed) this.trim = Math.max(-1, this.trim - dt * 0.35)
        if (gp.buttons[5]?.pressed) this.trim = Math.min(1, this.trim + dt * 0.35)
      } else {
        // joystick genérico (HOTAS): ejes configurables
        const p = dz(ax(s.axisPitch), 0.03)
        const r = dz(ax(s.axisRoll), 0.03)
        const y = dz(ax(s.axisYaw), 0.08)
        pitch = p * inv
        roll = r
        yaw = y
        this.analog = true
        if (s.axisThrottle >= 0 && s.axisThrottle < gp.axes.length) {
          const raw = ax(s.axisThrottle)
          if (!this.gpThrottleSeen && this.lastGpThrottle !== -2 && Math.abs(raw - this.lastGpThrottle) > 0.02) this.gpThrottleSeen = true
          this.lastGpThrottle = raw
          if (this.gpThrottleSeen) this.throttle = s.invertThrottle ? (1 - raw) / 2 : (1 + raw) / 2
        }
        if (gp.buttons[0]?.pressed) ctl.wheelBrake = 1
        if (gp.buttons[1]?.pressed) ctl.prerotator = true
      }
      break
    }

    this.pitch = pitch
    this.roll = roll
    this.yaw = yaw

    ctl.pitch = pitch
    ctl.roll = roll
    ctl.yaw = yaw
    ctl.throttle = this.throttle
    ctl.trim = this.trim
    ctl.prerotator = ctl.prerotator || k.has('KeyP')
    ctl.wheelBrake = Math.max(ctl.wheelBrake, k.has('Space') ? 1 : 0, this.parkBrake ? 1 : 0)
  }
}

/** fracción del movimiento del ratón que se usa para reunir palanca y cursor */
const MOUSE_CATCHUP = 0.4

function approach(v: number, target: number, step: number): number {
  const d = target - v
  return Math.abs(d) <= step ? target : v + Math.sign(d) * step
}

function expo(v: number): number {
  return 0.45 * v + 0.55 * v * v * v
}

/** ¿Está abierto el desplegable de este <select>? (`:open` no existe en navegadores viejos) */
function selectOpen(el: HTMLElement): boolean {
  try {
    return el.matches(':open')
  } catch {
    return false
  }
}
