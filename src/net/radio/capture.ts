// Radio de voz: el micrófono.
//
// getUserMedia → paso alto 280 Hz y dos paso bajo 3,2 kHz (banda de radio y antialias) → un
// AudioWorklet que SOLO deja salir muestras mientras la compuerta está abierta (PTT pulsado) →
// remuestreo a 8 kHz en tramas de 40 ms. Con la compuerta cerrada, además, la pista del micro
// queda desactivada (el navegador entrega silencio): nunca se graba ni se envía nada sin PTT.

import { FRAME, RATE } from './codec.ts'

// (de 1024 en 1024 muestras: ~47 mensajes por segundo a 48 kHz en vez de 375)
const WORKLET = `
class RadioTap extends AudioWorkletProcessor {
  constructor() {
    super()
    this.on = false
    this.buf = new Float32Array(1024)
    this.n = 0
    this.port.onmessage = (e) => { this.on = e.data === 1; this.n = 0 }
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!this.on || !ch) return true
    let i = 0
    while (i < ch.length) {
      const k = Math.min(ch.length - i, this.buf.length - this.n)
      this.buf.set(ch.subarray(i, i + k), this.n)
      this.n += k
      i += k
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf.slice(0))
        this.n = 0
      }
    }
    return true
  }
}
registerProcessor('radio-tap', RadioTap)
`

/** ¿Se puede pedir el micrófono aquí? (fuera de https o localhost, el navegador no lo da) */
export function micAvailability(): 'ok' | 'insecure' | 'unsupported' {
  if (typeof window === 'undefined' || !window.isSecureContext) return 'insecure'
  if (!navigator.mediaDevices?.getUserMedia) return 'unsupported'
  return 'ok'
}

const loaded = new WeakMap<BaseAudioContext, Promise<boolean>>()
function loadWorklet(ctx: AudioContext): Promise<boolean> {
  let p = loaded.get(ctx)
  if (!p) {
    p = (async () => {
      if (!ctx.audioWorklet) return false
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))
      try {
        await ctx.audioWorklet.addModule(url)
        return true
      } catch {
        return false
      } finally {
        URL.revokeObjectURL(url)
      }
    })()
    loaded.set(ctx, p)
  }
  return p
}

export class MicCapture {
  private readonly ctx: AudioContext
  private readonly stream: MediaStream
  private readonly nodes: AudioNode[] = []
  private readonly tap: AudioWorkletNode | ScriptProcessorNode
  private gate = false
  /** remuestreo: posición (en muestras de entrada) de la siguiente muestra de salida y la anterior */
  private pos = 0
  private prev = 0
  private readonly step: number
  private frame = new Float32Array(FRAME)
  private fill = 0
  /** nivel (0..1) de lo último captado, para el medidor de TX */
  level = 0
  /** trama de 40 ms a 8 kHz (solo con la compuerta abierta) */
  onFrame: ((f: Float32Array) => void) | null = null
  /** id del dispositivo que se está usando de verdad */
  readonly deviceId: string

  private constructor(ctx: AudioContext, stream: MediaStream, worklet: boolean) {
    this.ctx = ctx
    this.stream = stream
    this.step = ctx.sampleRate / RATE
    this.deviceId = stream.getAudioTracks()[0]?.getSettings().deviceId ?? ''
    for (const tr of stream.getAudioTracks()) tr.enabled = false
    const src = ctx.createMediaStreamSource(stream)
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 280
    const lp1 = ctx.createBiquadFilter()
    lp1.type = 'lowpass'
    lp1.frequency.value = 3200
    const lp2 = ctx.createBiquadFilter()
    lp2.type = 'lowpass'
    lp2.frequency.value = 3200
    // (el nodo tiene que acabar en el destino para que el navegador lo procese; sin sonido)
    const sink = ctx.createGain()
    sink.gain.value = 0
    if (worklet) {
      const node = new AudioWorkletNode(ctx, 'radio-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
      node.port.onmessage = (e: MessageEvent<Float32Array>) => this.block(e.data)
      this.tap = node
    } else {
      // navegadores sin AudioWorklet: ScriptProcessor (obsoleto, pero en todos)
      const node = ctx.createScriptProcessor(1024, 1, 1)
      node.onaudioprocess = (e) => {
        if (this.gate) this.block(e.inputBuffer.getChannelData(0).slice(0))
      }
      this.tap = node
    }
    src.connect(hp).connect(lp1).connect(lp2).connect(this.tap).connect(sink).connect(ctx.destination)
    this.nodes.push(src, hp, lp1, lp2, this.tap, sink)
  }

  /** Abre el micrófono (pide permiso si hace falta). Lanza la excepción de getUserMedia. */
  static async open(ctx: AudioContext, deviceId: string): Promise<MicCapture> {
    const base: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { ...base, deviceId: { exact: deviceId } } : base })
    } catch (e) {
      // el que estaba elegido ya no está (auriculares desenchufados): el de por defecto
      if (!deviceId || (e as Error).name !== 'OverconstrainedError' && (e as Error).name !== 'NotFoundError') throw e
      stream = await navigator.mediaDevices.getUserMedia({ audio: base })
    }
    const worklet = await loadWorklet(ctx)
    return new MicCapture(ctx, stream, worklet)
  }

  /** Abre o cierra la compuerta (PTT). */
  setGate(on: boolean): void {
    if (on === this.gate) return
    this.gate = on
    for (const tr of this.stream.getAudioTracks()) tr.enabled = on
    if (this.tap instanceof AudioWorkletNode) this.tap.port.postMessage(on ? 1 : 0)
    // lo que quede a medias (< 40 ms) se tira; la siguiente emisión empieza limpia
    this.fill = 0
    this.pos = 0
    this.prev = 0
    if (!on) this.level = 0
  }

  get live(): boolean {
    return this.stream.getAudioTracks().some((t) => t.readyState === 'live')
  }

  private block(x: Float32Array): void {
    if (!this.gate) return
    let s2 = 0
    for (let i = 0; i < x.length; i++) s2 += x[i] * x[i]
    const rms = Math.sqrt(s2 / Math.max(1, x.length))
    this.level += (Math.min(1, rms * 4) - this.level) * 0.3
    // interpolación lineal (los paso bajo de antes ya quitaron lo que se doblaría)
    const n = x.length
    let t = this.pos
    while (t < n - 1) {
      const i = Math.floor(t)
      const f = t - i
      const a = i < 0 ? this.prev : x[i]
      const b = x[i + 1]
      this.frame[this.fill++] = a + (b - a) * f
      if (this.fill === FRAME) {
        const out = this.frame
        this.frame = new Float32Array(FRAME)
        this.fill = 0
        this.onFrame?.(out)
      }
      t += this.step
    }
    this.pos = t - n
    this.prev = x[n - 1]
  }

  close(): void {
    this.setGate(false)
    this.onFrame = null
    for (const tr of this.stream.getTracks()) tr.stop()
    for (const n of this.nodes) n.disconnect()
    if (this.tap instanceof AudioWorkletNode) this.tap.port.onmessage = null
    else this.tap.onaudioprocess = null
  }
}

/** Micrófonos disponibles (los nombres solo aparecen después de dar permiso). */
export async function listMics(): Promise<{ id: string; label: string }[]> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices()
    return all.filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications').map((d) => ({ id: d.deviceId, label: d.label }))
  } catch {
    return []
  }
}
