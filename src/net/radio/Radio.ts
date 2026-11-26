// Radio de voz de las salas multijugador.
//
// - PTT: se habla SOLO mientras se mantiene la tecla º (código `Backquote`, la de la consola /
//   ventana de ATC en los simuladores) o el botón de radio del mando (Ajustes › Joystick). Al
//   soltar, el micro vuelve a quedar mudo. Micro atascado: a los 35 s se corta la emisión.
// - Transporte: por el mismo WebSocket del relé de la sala, en mensajes binarios (protocol.ts).
//   Funciona detrás de cualquier NAT y por el túnel, sin servidores de terceros ni STUN/TURN; el
//   relé solo reenvía a los de la sala con la radio encendida, con límite de tamaño y de ritmo.
// - Códec: Opus (WebCodecs) si todos los que escuchan lo entienden; si no, μ-law. Siempre a
//   8 kHz: la radio de un avión solo pasa 300–3000 Hz (codec.ts).
// - Recepción: efecto de radio AM (RadioFx.ts), alcance VHF por línea de vista y relieve
//   (range.ts), y semidúplex (transmitiendo no se oye a nadie).

import './radio.css'
import './radioText.ts'
import { Vector3, type Mesh, type Object3D } from 'three'
import { t } from '../../i18n.ts'
import { RADIO_ON, RADIO_OPUS, type PeerInfo } from '../protocol.ts'
import {
  CODEC_OPUS,
  CODEC_ULAW,
  F_END,
  F_START,
  FRAME,
  FRAME_US,
  RATE,
  packVoice,
  ulawDecode,
  ulawEncode,
  unpackVoice,
} from './codec.ts'
import { OPUS_DEC, OPUS_ENC, opusSupport } from './opus.ts'
import { MicCapture, listMics, micAvailability } from './capture.ts'
import { RadioFx } from './RadioFx.ts'
import { CLEAN_DB, HISS_DB, fresnelV, linkMargin } from './range.ts'
import { DEFAULT_PAD_BUTTON, RadioUi } from './radioUi.ts'

/** tecla del PTT (º en un teclado español, ` en uno inglés) */
export const PTT_KEY = 'Backquote'
const STORE = 'autogiro.radio.v1'
/** micro atascado: las radios de aviación cortan la emisión si el PTT se queda pulsado */
const STUCK_MS = 35000
/** colchón de recepción (s): absorbe los altibajos de la red */
const JITTER = 0.16
/** sin paquetes durante esto, la emisión se da por terminada (se perdió el último) */
const RX_TIMEOUT = 600
/** recorrido del gatillo de la palanca al pulsarlo (m, hacia atrás) */
const TRIGGER_TRAVEL = 0.004

export type MicState = 'idle' | 'asking' | 'ok' | 'denied' | 'insecure' | 'unsupported' | 'nodevice' | 'error'

export interface RadioSettings {
  /** radio encendida (escuchar y, con micro, hablar); apagada por defecto */
  on: boolean
  /** micrófono elegido ('' = el del sistema) */
  deviceId: string
  /** volumen de la radio 0..1 (aparte del general) */
  volume: number
  /** botón del mando para el PTT (−1 = el de por defecto) */
  padButton: number
}

/** Lo que la radio necesita de cada piloto remoto (RemoteAircraft). */
export interface RadioPeer {
  readonly info: PeerInfo
  readonly color: string
  readonly active: boolean
  readonly pose: { readonly pos: Vector3; readonly vel: Vector3; readonly agl: number; readonly engineRpm: number }
  readonly view: { readonly parts: { stick?: Object3D } }
  /** icono de «hablando» en su etiqueta: 0 no, 1 sí, 2 con señal débil */
  setTalking(level: number): void
}

/** Lo que la radio necesita del multijugador y de la aplicación. */
export interface RadioHost {
  readonly inRoom: boolean
  readonly myId: number
  readonly peers: ReadonlyMap<number, RadioPeer>
  readonly menuOpen: boolean
  /** panel de instrumentos a la vista (la caja COM va encima) */
  readonly hudVisible: boolean
  readonly ac: { readonly pos: Vector3; readonly agl: number }
  readonly world: { sampleGround(x: number, z: number, yHint: number, out: { y: number; normal: Vector3 }): boolean } | null
  /** aparato propio: gatillo de la palanca y pantalla de la radio del panel */
  readonly view: { readonly parts?: { stick?: Object3D }; readonly cockpit?: { radio: number } }
  /** envía un mensaje binario por el WebSocket de la sala (false si no salió) */
  sendBinary(data: Uint8Array<ArrayBuffer>): boolean
  toast(msg: string): void
}

interface Talker {
  id: number
  /** voz de este emisor → entrada del receptor */
  gain: GainNode
  active: boolean
  /** llegó el último paquete y se espera a que el descodificador acabe */
  ending: boolean
  /** performance.now() del último paquete */
  last: number
  /** hora del contexto de audio a la que va el siguiente trozo */
  next: number
  /** silenciador abierto entre estas dos horas del contexto (Infinity: sigue abierto) */
  openFrom: number
  openUntil: number
  /** ya ha sonado voz en esta emisión */
  played: boolean
  /** margen del enlace (dB, range.ts) y desvanecimiento aleatorio encima */
  margin: number
  marginAt: number
  fade: number
  fadeTarget: number
  fadeAt: number
  dec: AudioDecoder | null
  decTs: number
}

function loadSettings(): RadioSettings {
  const def: RadioSettings = { on: false, deviceId: '', volume: 0.8, padButton: -1 }
  try {
    const raw = localStorage.getItem(STORE)
    if (raw) {
      const s = { ...def, ...JSON.parse(raw) } as RadioSettings
      return {
        on: s.on === true,
        deviceId: typeof s.deviceId === 'string' ? s.deviceId : '',
        volume: Number.isFinite(s.volume) ? Math.max(0, Math.min(1, s.volume)) : def.volume,
        padButton: Number.isInteger(s.padButton) && s.padButton >= -1 && s.padButton < 64 ? s.padButton : -1,
      }
    }
  } catch {
    /* sin almacenamiento */
  }
  return def
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))
/** 0 con señal limpia, 1 en el umbral del silenciador */
const weakness = (marginDb: number) => clamp01((HISS_DB - marginDb) / HISS_DB)

// gatillo PTT de la palanca (blender/controls.py: caja roja «Btn_Red» bajo la cabeza de la empuñadura)
const triggers = new WeakMap<Object3D, { o: Object3D; rest: Vector3 }[]>()
function pressTrigger(stick: Object3D | undefined, on: boolean): void {
  if (!stick) return
  let list = triggers.get(stick)
  if (!list) {
    const found: { o: Object3D; rest: Vector3 }[] = []
    stick.traverse((o) => {
      const m = o as Mesh
      if (!m.isMesh || o === stick) return
      const mats = Array.isArray(m.material) ? m.material : [m.material]
      if (mats.length && mats.every((x) => /^Btn_Red/i.test(x.name))) found.push({ o: m, rest: m.position.clone() })
    })
    triggers.set(stick, (list = found))
  }
  for (const tr of list) tr.o.position.set(tr.rest.x - (on ? TRIGGER_TRAVEL : 0), tr.rest.y, tr.rest.z)
}

function padPressed(button: number): boolean {
  const i = button >= 0 ? button : DEFAULT_PAD_BUTTON
  for (const gp of navigator.getGamepads?.() ?? []) {
    if (!gp || !gp.connected) continue
    return gp.buttons[i]?.pressed ?? false
  }
  return false
}

const _s = { y: 0, normal: new Vector3() }

export class Radio {
  private readonly host: RadioHost
  readonly settings: RadioSettings = loadSettings()
  fx: RadioFx | null = null
  private mic: MicCapture | null = null
  micState: MicState = 'idle'
  micError = ''
  devices: { id: string; label: string }[] = []
  private opening = false
  private opus = { enc: false, dec: false }
  private enc: AudioEncoder | null = null
  private encTs = 0
  private flushing = false
  /** transmitiendo ahora */
  tx = false
  private txAt = 0
  private txCodec = CODEC_ULAW
  private txSeq = 0
  private txFlags = 0
  private stuck = false
  private keyHeld = false
  private padHeld = false
  /** PTT pulsado desde fuera (gatillo de un mando de realidad virtual: src/vr) */
  extPtt = false
  private extHeld = false
  private nagged = false
  private readonly talkers = new Map<number, Talker>()
  private lastUpdate = performance.now()
  private lastListeners = -1
  private talkKey = ''
  /** cambia cada vez que cambia quién se oye (la lista de pilotos se repinta al momento) */
  talkVersion = 0
  readonly ui: RadioUi
  /** pruebas: emitir en μ-law aunque todos entiendan Opus */
  forceUlaw = false
  /** contadores para las pruebas */
  readonly stats = { sent: 0, recv: 0, played: 0, codecSent: -1, codecRecv: -1 }

  constructor(host: RadioHost, mpSection: HTMLElement | null) {
    this.host = host
    void opusSupport().then((s) => (this.opus = s))
    if (this.settings.on) this.ensureFx()
    this.ui = new RadioUi(this, mpSection)

    window.addEventListener('keydown', (e) => {
      if (e.code !== PTT_KEY || e.ctrlKey || e.altKey || e.metaKey) return
      const tg = e.target as HTMLElement | null
      if (tg && (['INPUT', 'SELECT', 'TEXTAREA'].includes(tg.tagName) || tg.isContentEditable)) return
      e.preventDefault()
      if (this.keyHeld) return
      this.keyHeld = true
      this.evalPtt()
    })
    window.addEventListener('keyup', (e) => {
      if (e.code !== PTT_KEY || !this.keyHeld) return
      this.keyHeld = false
      this.evalPtt()
    })
    window.addEventListener('blur', () => {
      this.keyHeld = false
      this.evalPtt()
    })
    // el navegador no deja sonar audio hasta el primer gesto del jugador
    const resume = () => this.fx?.resume()
    window.addEventListener('pointerdown', resume, true)
    window.addEventListener('keydown', resume, true)
  }

  /** Bits del campo `radio` del perfil. */
  get flags(): number {
    return this.settings.on ? RADIO_ON | (this.opus.dec ? RADIO_OPUS : 0) : 0
  }

  get inRoom(): boolean {
    return this.host.inRoom
  }

  /** Cuántos pilotos más de la sala tienen la radio encendida. */
  get listeners(): number {
    let n = 0
    for (const p of this.host.peers.values()) if ((p.info.radio ?? 0) & RADIO_ON) n++
    return n
  }

  private save(): void {
    try {
      localStorage.setItem(STORE, JSON.stringify(this.settings))
    } catch {
      /* sin almacenamiento */
    }
  }

  private ensureFx(): RadioFx {
    if (!this.fx) {
      this.fx = new RadioFx()
      this.fx.setVolume(this.settings.volume)
    }
    return this.fx
  }

  // -------------------------------------------------------------------------
  // Ajustes (desde la interfaz)
  // -------------------------------------------------------------------------
  setEnabled(on: boolean): void {
    this.settings.on = on
    this.save()
    if (on) {
      this.ensureFx().resume()
      this.micState = 'idle'
      // el permiso se pide ahora (la casilla es el gesto del jugador); dentro de una sala el
      // micro se queda abierto (mudo) y fuera se cierra en cuanto se sabe que funciona
      void this.openMic(this.host.inRoom)
    } else {
      this.stopTx()
      this.closeMic()
      this.clearTalkers()
      this.micState = 'idle'
    }
    this.ui.refresh()
  }

  setDevice(id: string): void {
    this.settings.deviceId = id
    this.save()
    if (this.mic) {
      this.stopTx()
      this.closeMic()
      void this.openMic(true)
    }
  }

  setVolume(v: number): void {
    this.settings.volume = clamp01(v)
    this.save()
    this.fx?.setVolume(this.settings.volume)
    this.ui.refresh()
  }

  setPadButton(i: number): void {
    this.settings.padButton = i
    this.save()
    this.ui.refresh()
  }

  // -------------------------------------------------------------------------
  // Micrófono
  // -------------------------------------------------------------------------
  private wantMic(): boolean {
    return this.settings.on && this.host.inRoom
  }

  private async openMic(keep: boolean): Promise<void> {
    if (this.opening) return
    const av = micAvailability()
    if (av !== 'ok') {
      this.micState = av
      this.ui.refresh()
      return
    }
    const fx = this.ensureFx()
    this.opening = true
    this.micState = 'asking'
    this.ui.refresh()
    try {
      const mic = await MicCapture.open(fx.ctx, this.settings.deviceId)
      this.micState = 'ok'
      this.devices = await listMics()
      if (keep && this.wantMic() && !this.mic) {
        this.mic = mic
        mic.onFrame = (f) => this.onMicFrame(f)
      } else mic.close()
    } catch (e) {
      const name = (e as Error)?.name ?? ''
      this.micState =
        name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'nodevice' : 'error'
      this.micError = name || String(e)
    }
    this.opening = false
    this.ui.refresh()
  }

  private closeMic(): void {
    this.mic?.close()
    this.mic = null
  }

  // -------------------------------------------------------------------------
  // Transmisión (PTT)
  // -------------------------------------------------------------------------
  private evalPtt(): void {
    const held = this.keyHeld || this.padHeld || this.extHeld
    if (!held) {
      this.stuck = false
      this.nagged = false
      if (this.tx) this.stopTx()
      return
    }
    if (this.tx || this.stuck || !this.host.inRoom || this.host.menuOpen) return
    if (!this.settings.on || !this.mic) {
      if (!this.nagged && !this.opening) {
        this.nagged = true
        this.host.toast(t(this.settings.on ? 'radio.noMicToast' : 'radio.offToast'))
      }
      return
    }
    this.startTx()
  }

  private startTx(): void {
    const mic = this.mic
    const fx = this.fx
    if (!mic || !fx) return
    fx.resume()
    this.tx = true
    this.txAt = performance.now()
    this.txFlags = F_START
    // Opus solo si todos los que escuchan lo entienden
    let opus = this.opus.enc && !this.forceUlaw
    for (const p of this.host.peers.values()) {
      const f = p.info.radio ?? 0
      if (f & RADIO_ON && !(f & RADIO_OPUS)) opus = false
    }
    this.txCodec = opus && this.ensureEncoder() ? CODEC_OPUS : CODEC_ULAW
    this.stats.codecSent = this.txCodec
    mic.setGate(true)
    fx.setTransmitting(true)
    fx.keyClick()
    pressTrigger(this.host.view.parts?.stick, true)
  }

  private stopTx(): void {
    if (!this.tx) return
    this.tx = false
    this.mic?.setGate(false)
    this.fx?.setTransmitting(false)
    this.fx?.keyClick()
    pressTrigger(this.host.view.parts?.stick, false)
    const codec = this.txCodec
    const end = () => {
      // (si ya ha empezado otra emisión, su primer paquete lleva la marca de inicio)
      if (this.tx) return
      this.host.sendBinary(packVoice(codec, F_END, this.txSeq, new Uint8Array(0)))
      this.txSeq = (this.txSeq + 1) & 0xffff
    }
    const enc = this.enc
    if (codec === CODEC_OPUS && enc && enc.state === 'configured') {
      this.flushing = true
      enc
        .flush()
        .catch(() => {})
        .finally(() => {
          this.flushing = false
          end()
        })
    } else end()
  }

  private ensureEncoder(): boolean {
    if (this.enc && this.enc.state === 'configured') return true
    try {
      this.enc = new AudioEncoder({
        output: (chunk) => {
          if (!this.tx && !this.flushing) return
          const b = new Uint8Array(chunk.byteLength)
          chunk.copyTo(b)
          this.sendVoice(CODEC_OPUS, b)
        },
        error: () => {
          this.enc = null
          this.opus.enc = false
        },
      })
      this.enc.configure(OPUS_ENC)
      return true
    } catch {
      this.enc = null
      this.opus.enc = false
      return false
    }
  }

  private onMicFrame(f: Float32Array): void {
    if (!this.tx) return
    const enc = this.enc
    if (this.txCodec === CODEC_OPUS && enc && enc.state === 'configured') {
      const data = new AudioData({ format: 'f32', sampleRate: RATE, numberOfFrames: FRAME, numberOfChannels: 1, timestamp: this.encTs, data: f as Float32Array<ArrayBuffer> })
      this.encTs += FRAME_US
      try {
        enc.encode(data)
      } finally {
        data.close()
      }
      return
    }
    // (si el codificador falla a media emisión se sigue en μ-law: cada paquete dice su códec)
    this.txCodec = CODEC_ULAW
    this.sendVoice(CODEC_ULAW, ulawEncode(f))
  }

  private sendVoice(codec: number, payload: Uint8Array): void {
    const ok = this.host.sendBinary(packVoice(codec, this.txFlags, this.txSeq, payload))
    this.txSeq = (this.txSeq + 1) & 0xffff
    if (ok) {
      this.txFlags = 0
      this.stats.sent++
    }
  }

  // -------------------------------------------------------------------------
  // Recepción
  // -------------------------------------------------------------------------
  /** Mensaje binario del relé. */
  onBinary(buf: ArrayBuffer): void {
    const pk = unpackVoice(buf)
    if (!pk) return
    this.stats.recv++
    if (!this.settings.on || pk.id === this.host.myId) return
    const fx = this.fx
    if (!fx) return
    let tk = this.talkers.get(pk.id)
    if (!tk) {
      const gain = fx.ctx.createGain()
      gain.connect(fx.input)
      tk = {
        id: pk.id,
        gain,
        active: false,
        ending: false,
        last: 0,
        next: 0,
        openFrom: 0,
        openUntil: -Infinity,
        played: false,
        margin: CLEAN_DB,
        marginAt: 0,
        fade: 0,
        fadeTarget: 0,
        fadeAt: 0,
        dec: null,
        decTs: 0,
      }
      this.talkers.set(pk.id, tk)
    }
    const now = performance.now()
    tk.last = now
    if (!tk.active || pk.flags & F_START) {
      tk.active = true
      tk.ending = false
      tk.played = false
      tk.margin = this.marginFor(tk.id)
      tk.marginAt = now
    }
    if (pk.data.length) {
      this.stats.codecRecv = pk.codec
      if (pk.codec === CODEC_ULAW) this.play(tk, ulawDecode(pk.data), RATE)
      else if (pk.codec === CODEC_OPUS) this.decodeOpus(tk, pk.data)
    }
    if (pk.flags & F_END) {
      // (con Opus, el cierre espera a que salga lo que quede en el descodificador)
      const dec = tk.dec
      if (dec && dec.state === 'configured') {
        const k = tk
        k.ending = true
        dec.flush().then(
          () => k.ending && this.endRx(k),
          () => this.endRx(k),
        )
      } else this.endRx(tk)
    }
  }

  private decodeOpus(tk: Talker, data: Uint8Array): void {
    if (!this.opus.dec) return
    if (!tk.dec || tk.dec.state === 'closed') {
      try {
        const k = tk
        tk.dec = new AudioDecoder({
          output: (d) => {
            const a = new Float32Array(d.numberOfFrames)
            d.copyTo(a, { planeIndex: 0, format: 'f32-planar' })
            const sr = d.sampleRate
            d.close()
            this.play(k, a, sr)
          },
          error: () => {
            k.dec = null
          },
        })
        tk.dec.configure(OPUS_DEC)
      } catch {
        tk.dec = null
        return
      }
    }
    tk.dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: tk.decTs, data }))
    tk.decTs += FRAME_US
  }

  /** Programa un trozo de voz recibido (o lo pierde si la señal no llega). */
  private play(tk: Talker, samples: Float32Array, rate: number): void {
    const fx = this.fx
    if (!fx || !tk.active && !tk.ending) return
    const ctx = fx.ctx
    const cur = ctx.currentTime
    const dur = samples.length / rate
    if (tk.next < cur + 0.015) tk.next = cur + JITTER
    const eff = tk.margin + tk.fade
    if (eff <= 0) {
      // no llega (lejos, tras el relieve o en un desvanecimiento): el silenciador se cierra
      if (tk.openUntil === Infinity) {
        fx.squelchClose(tk.next, 1)
        tk.openUntil = tk.next
      }
      tk.next += dur
      return
    }
    if (tk.openUntil !== Infinity) {
      const at = tk.next - 0.045
      fx.squelchOpen(at, weakness(eff))
      tk.openFrom = at
      tk.openUntil = Infinity
    }
    const buf = ctx.createBuffer(1, samples.length, rate)
    buf.copyToChannel(samples as Float32Array<ArrayBuffer>, 0)
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(tk.gain)
    src.start(tk.next)
    tk.next += dur
    tk.played = true
    this.stats.played++
  }

  private endRx(tk: Talker): void {
    if (!tk.active) return
    tk.active = false
    tk.ending = false
    const fx = this.fx
    if (!fx) return
    const cur = fx.ctx.currentTime
    if (tk.openUntil === Infinity) {
      const at = Math.max(tk.next, cur)
      fx.squelchClose(at, weakness(tk.margin + tk.fade))
      tk.openUntil = at
    } else if (!tk.played && tk.margin > 0) {
      // un toque de PTT sin voz: chasquido y cola (los «dos clics» de acuse de recibo)
      fx.squelchOpen(cur + 0.03, weakness(tk.margin))
      fx.squelchClose(cur + 0.1, weakness(tk.margin))
      tk.openFrom = cur + 0.03
      tk.openUntil = cur + 0.1
    }
  }

  private clearTalkers(): void {
    for (const tk of this.talkers.values()) {
      tk.gain.disconnect()
      if (tk.dec && tk.dec.state !== 'closed') tk.dec.close()
    }
    this.talkers.clear()
  }

  /** Margen del enlace con un piloto (dB): horizonte radioeléctrico y relieve en medio. */
  private marginFor(id: number): number {
    const p = this.host.peers.get(id)
    const w = this.host.world
    if (!p || !p.active || !w) return CLEAN_DB
    const a = this.host.ac.pos
    const b = p.pose.pos
    const d = a.distanceTo(b)
    // antenas: en el mástil o la deriva, ~2 m sobre el suelo con el aparato posado
    const h1 = this.host.ac.agl + 2
    const h2 = p.pose.agl + 1
    const ya = a.y + 1
    const yb = b.y + 1
    let vMax = -Infinity
    if (d > 30) {
      const N = 12
      const yHint = Math.max(a.y, b.y) + 300
      for (let i = 1; i < N; i++) {
        const f = i / N
        if (!w.sampleGround(a.x + (b.x - a.x) * f, a.z + (b.z - a.z) * f, yHint, _s)) continue
        const v = fresnelV(_s.y - (ya + (yb - ya) * f), f * d, (1 - f) * d)
        if (v > vMax) vMax = v
      }
    }
    return linkMargin(d, h1, h2, vMax)
  }

  // -------------------------------------------------------------------------
  // Cada fotograma
  // -------------------------------------------------------------------------
  update(): void {
    const now = performance.now()
    const dt = Math.min(0.1, (now - this.lastUpdate) / 1000)
    this.lastUpdate = now
    const host = this.host

    // micro abierto (mudo) mientras se está en una sala con la radio encendida
    if (this.wantMic()) {
      if (!this.mic && !this.opening && (this.micState === 'idle' || this.micState === 'ok')) void this.openMic(true)
    } else if (this.mic) {
      this.stopTx()
      this.closeMic()
    }
    if (this.mic && !this.mic.live) {
      // desenchufado
      this.stopTx()
      this.closeMic()
      this.micState = 'nodevice'
      this.ui.refresh()
    }

    // PTT del mando (también fuera de sala: la fila de Ajustes se resalta al pulsarlo)
    const pad = padPressed(this.settings.padButton)
    this.ui.padLive(pad)
    if (pad !== this.padHeld || this.extPtt !== this.extHeld) {
      this.padHeld = pad
      this.extHeld = this.extPtt
      this.evalPtt()
    }
    if (this.tx && (host.menuOpen || !host.inRoom || !this.mic)) this.stopTx()
    else if (!this.tx && (this.keyHeld || this.padHeld || this.extHeld)) this.evalPtt()
    if (this.tx && now - this.txAt > STUCK_MS) {
      this.stopTx()
      this.stuck = true
      host.toast(t('radio.stuck'))
    }

    // receptor
    const fx = this.fx
    const heard: Talker[] = []
    let bed = 0
    if (fx) {
      const cur = fx.ctx.currentTime
      let strongest = -Infinity
      for (const tk of this.talkers.values()) {
        const p = host.peers.get(tk.id)
        if (!p) {
          tk.gain.disconnect()
          if (tk.dec && tk.dec.state !== 'closed') tk.dec.close()
          this.talkers.delete(tk.id)
          continue
        }
        if (tk.active && !tk.ending && now - tk.last > RX_TIMEOUT) this.endRx(tk)
        if (tk.active && now - tk.marginAt > 300) {
          tk.margin = this.marginFor(tk.id)
          tk.marginAt = now
        }
        // desvanecimientos: más hondos cuanto más débil llega
        const w = weakness(tk.margin)
        if (now > tk.fadeAt) {
          tk.fadeTarget = (Math.random() * 2 - 1) * 10 * w * w
          tk.fadeAt = now + 80 + Math.random() * 260
        }
        tk.fade += (tk.fadeTarget - tk.fade) * Math.min(1, dt * 8)
        if (cur >= tk.openFrom && cur < tk.openUntil) {
          heard.push(tk)
          strongest = Math.max(strongest, tk.margin + tk.fade)
          // ruido de cabina por el micro del que habla: viento y motor (cabina abierta)
          const v = p.pose.vel.length()
          bed += 0.012 + 0.035 * clamp01(p.pose.engineRpm / 5500) + 0.045 * clamp01(v / 45)
        }
      }
      // voces: más bajas con señal débil; si se pisan, cada una algo más baja
      const k = heard.length > 1 ? 0.78 : 1
      for (const tk of this.talkers.values()) {
        const g = (0.45 + 0.55 * clamp01((tk.margin + tk.fade) / 20)) * k
        tk.gain.gain.setTargetAtTime(g, cur, 0.02)
      }
      let het: { hz: number; level: number } | null = null
      if (heard.length > 1) {
        const [a, b] = [...heard].sort((x, y) => y.margin - x.margin)
        const lo = Math.min(a.id, b.id)
        const hi = Math.max(a.id, b.id)
        het = { hz: 420 + ((lo * 7919 + hi * 104729) % 1300), level: Math.pow(10, -Math.abs(a.margin - b.margin) / 20) }
      }
      fx.setCarrier(heard.length ? weakness(strongest) : null, het, Math.min(0.2, bed))
    }

    // indicadores: quién se oye (transmitiendo no se oye a nadie), gatillos, panel y caja COM
    const rx: { name: string; color: string; weak: boolean }[] = []
    let talkKey = ''
    for (const p of host.peers.values()) {
      const tk = this.talkers.get(p.info.id)
      const on = !this.tx && tk !== undefined && heard.includes(tk)
      const weak = on && tk!.margin + tk!.fade < 12
      p.setTalking(on ? (weak ? 2 : 1) : 0)
      if (on) {
        rx.push({ name: p.info.name, color: p.color, weak })
        talkKey += `${p.info.id}${weak ? 'w' : ''},`
      }
      pressTrigger(p.view.parts.stick, tk?.active === true)
    }
    if (talkKey !== this.talkKey) {
      this.talkKey = talkKey
      this.talkVersion++
    }
    const ck = host.view.cockpit
    if (ck) ck.radio = !this.settings.on || !host.inRoom ? 0 : this.tx ? 2 : rx.length ? 1 : 0
    const W = window.innerWidth
    const gauge = Math.max(92, Math.min(148, (W - 120) / 7.2))
    this.ui.hud({
      show: host.inRoom && this.settings.on && !host.menuOpen,
      tx: this.tx,
      level: this.mic?.level ?? 0,
      rx,
      bottom: Math.round(host.hudVisible ? gauge + 62 : 26),
    })
    const n = host.inRoom ? this.listeners : -1
    if (n !== this.lastListeners) {
      this.lastListeners = n
      this.ui.refresh()
    }
  }

  /** Estado de un piloto para la lista: 0 nada, 1 se le oye, 2 se le oye con señal débil. */
  talking(id: number): number {
    if (this.tx) return 0
    const tk = this.talkers.get(id)
    const fx = this.fx
    if (!tk || !fx) return 0
    const cur = fx.ctx.currentTime
    if (cur < tk.openFrom || cur >= tk.openUntil) return 0
    return tk.margin + tk.fade < 12 ? 2 : 1
  }

  /** Al salir de la sala o perder la conexión. */
  roomLeft(): void {
    this.stopTx()
    this.closeMic()
    this.clearTalkers()
    if (this.micState === 'asking') this.micState = 'idle'
  }
}
