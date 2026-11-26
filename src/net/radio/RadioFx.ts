// Radio de voz: lo que hace el receptor con el sonido para que suene a radio de avión (AM, VHF).
//
//   voces ─┐
//   soplido (ruido) ─┤
//   chasquidos del silenciador ─┼→ paso banda 300–3000 Hz → «nasal» (+5 dB a 1,8 kHz) → saturación
//   pitido heterodino ─┤             → compresor (CAG) → mudo al transmitir → volumen → altavoz
//   ruido de cabina del emisor ─┘
//
// - El soplido sube cuanto más débil llega la señal (lejos, en el límite del alcance o detrás
//   del relieve) y solo se oye con el silenciador abierto.
// - Al abrirse el silenciador, un chasquido; al cerrarse, la cola de ruido («kssh»).
// - Dos emisiones a la vez en AM no se anulan: se oyen las dos, embarulladas, con el pitido de
//   batido entre las dos portadoras (heterodino), tanto más fuerte cuanto más parecidas llegan.
// - Semidúplex: mientras transmites no oyes a nadie.

const DRIVE = 2.4

function softClipCurve(k: number): Float32Array<ArrayBuffer> {
  const n = 1024
  const c = new Float32Array(n)
  const norm = Math.tanh(k)
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    c[i] = Math.tanh(k * x) / norm
  }
  return c
}

function noiseBuffer(ctx: BaseAudioContext, seconds: number, brown = false): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const d = buf.getChannelData(0)
  let last = 0
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1
    if (brown) {
      last = (last + 0.02 * w) / 1.02
      d[i] = last * 3.5
    } else d[i] = w
  }
  return buf
}

export class RadioFx {
  readonly ctx: AudioContext
  /** entrada de las voces (cada emisor conecta aquí su ganancia) */
  readonly input: GainNode
  /** salida (tras el volumen), para medir el nivel en las pruebas */
  readonly analyser: AnalyserNode
  private readonly noise: AudioBuffer
  private readonly hiss: GainNode
  private readonly het: OscillatorNode
  private readonly hetGain: GainNode
  private readonly hetWobble: GainNode
  private readonly bed: GainNode
  private readonly sum: GainNode
  private readonly gate: GainNode
  private readonly vol: GainNode
  private readonly clickBus: GainNode
  private carrier = false

  constructor() {
    const ctx = new AudioContext({ latencyHint: 'interactive' })
    this.ctx = ctx
    this.noise = noiseBuffer(ctx, 2)
    this.sum = ctx.createGain()
    this.input = ctx.createGain()
    this.input.connect(this.sum)

    // soplido de fondo (silenciador abierto)
    const hissSrc = ctx.createBufferSource()
    hissSrc.buffer = this.noise
    hissSrc.loop = true
    this.hiss = ctx.createGain()
    this.hiss.gain.value = 0
    hissSrc.connect(this.hiss).connect(this.sum)
    hissSrc.start()

    // heterodino: batido entre dos portadoras (con un poco de deriva, como dos osciladores reales)
    this.het = ctx.createOscillator()
    this.het.type = 'sine'
    this.het.frequency.value = 900
    const lfo = ctx.createOscillator()
    lfo.frequency.value = 0.55
    this.hetWobble = ctx.createGain()
    this.hetWobble.gain.value = 0
    lfo.connect(this.hetWobble).connect(this.het.frequency)
    this.hetGain = ctx.createGain()
    this.hetGain.gain.value = 0
    this.het.connect(this.hetGain).connect(this.sum)
    this.het.start()
    lfo.start()

    // ruido de cabina del que habla (cabina abierta: viento y motor por el micro)
    const bedSrc = ctx.createBufferSource()
    bedSrc.buffer = noiseBuffer(ctx, 3, true)
    bedSrc.loop = true
    const bedLp = ctx.createBiquadFilter()
    bedLp.type = 'lowpass'
    bedLp.frequency.value = 1100
    this.bed = ctx.createGain()
    this.bed.gain.value = 0
    bedSrc.connect(bedLp).connect(this.bed).connect(this.sum)
    bedSrc.start()

    // banda de la radio, carácter y CAG
    const hp1 = ctx.createBiquadFilter()
    hp1.type = 'highpass'
    hp1.frequency.value = 300
    hp1.Q.value = 0.8
    const hp2 = ctx.createBiquadFilter()
    hp2.type = 'highpass'
    hp2.frequency.value = 300
    hp2.Q.value = 0.6
    const lp1 = ctx.createBiquadFilter()
    lp1.type = 'lowpass'
    lp1.frequency.value = 3000
    lp1.Q.value = 0.8
    const lp2 = ctx.createBiquadFilter()
    lp2.type = 'lowpass'
    lp2.frequency.value = 3000
    lp2.Q.value = 0.6
    const nasal = ctx.createBiquadFilter()
    nasal.type = 'peaking'
    nasal.frequency.value = 1800
    nasal.Q.value = 1.1
    nasal.gain.value = 5
    const drive = ctx.createGain()
    drive.gain.value = DRIVE
    const shaper = ctx.createWaveShaper()
    shaper.curve = softClipCurve(2.2)
    shaper.oversample = '2x'
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -26
    comp.knee.value = 6
    comp.ratio.value = 8
    comp.attack.value = 0.002
    comp.release.value = 0.12
    const makeup = ctx.createGain()
    makeup.gain.value = 1.6
    this.gate = ctx.createGain()
    this.vol = ctx.createGain()
    this.vol.gain.value = 0.8
    this.analyser = ctx.createAnalyser()
    this.analyser.fftSize = 2048
    this.sum.connect(hp1).connect(hp2).connect(lp1).connect(lp2).connect(nasal).connect(drive).connect(shaper).connect(comp).connect(makeup)
    makeup.connect(this.gate).connect(this.vol).connect(ctx.destination)
    this.vol.connect(this.analyser)

    // chasquidos del PTT propio: directos al volumen (no los calla el semidúplex)
    this.clickBus = ctx.createGain()
    const clickLp = ctx.createBiquadFilter()
    clickLp.type = 'bandpass'
    clickLp.frequency.value = 1500
    clickLp.Q.value = 0.7
    this.clickBus.connect(clickLp).connect(this.vol)
  }

  resume(): void {
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {})
  }

  setVolume(v: number): void {
    this.vol.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), this.ctx.currentTime, 0.03)
  }

  /** Semidúplex: transmitiendo no se oye el receptor. */
  setTransmitting(on: boolean): void {
    this.gate.gain.setTargetAtTime(on ? 0 : 1, this.ctx.currentTime, on ? 0.004 : 0.02)
  }

  /** Ráfaga de ruido de `dur` s a la hora `t` con envolvente exponencial (chasquidos del silenciador). */
  private burst(t: number, dur: number, peak: number, to: AudioNode = this.sum, decay = dur / 3): void {
    const ctx = this.ctx
    const src = ctx.createBufferSource()
    src.buffer = this.noise
    const g = ctx.createGain()
    g.gain.value = 0
    src.connect(g).connect(to)
    const at = Math.max(ctx.currentTime, t)
    g.gain.setValueAtTime(0, at)
    g.gain.linearRampToValueAtTime(peak, at + 0.003)
    g.gain.setTargetAtTime(0, at + 0.004, decay)
    src.start(at, Math.random() * 1.5)
    src.stop(at + dur + 0.05)
    src.onended = () => g.disconnect()
  }

  /** El silenciador se abre: chasquido. `weak` 0..1 (más fuerte con señal débil). */
  squelchOpen(t: number, weak: number): void {
    this.burst(t, 0.05, 0.35 + 0.3 * weak)
  }

  /** El silenciador se cierra: cola de ruido. */
  squelchClose(t: number, weak: number): void {
    this.burst(t, 0.2, 0.42 + 0.25 * weak, this.sum, 0.06)
  }

  /** Clic del PTT propio (al pulsar y al soltar). */
  keyClick(): void {
    this.burst(this.ctx.currentTime, 0.012, 0.18, this.clickBus, 0.003)
  }

  /**
   * Portadora recibida: `weak` 0..1 de la más fuerte (0 limpia, 1 en el umbral) o null si el
   * silenciador está cerrado; `het` = pitido heterodino (Hz y nivel 0..1) si hay dos a la vez;
   * `bed` = nivel del ruido de cabina de los que hablan.
   */
  setCarrier(weak: number | null, het: { hz: number; level: number } | null, bed: number): void {
    const t = this.ctx.currentTime
    const open = weak !== null
    const hiss = open ? 0.02 + 0.34 * Math.pow(Math.max(0, Math.min(1, weak)), 1.4) : 0
    // (al cerrarse, el soplido se va con la cola; al abrirse, entra con el chasquido)
    this.hiss.gain.setTargetAtTime(hiss, t, open && !this.carrier ? 0.01 : 0.05)
    this.carrier = open
    if (het && open) {
      this.het.frequency.setTargetAtTime(het.hz, t, 0.05)
      this.hetWobble.gain.setTargetAtTime(het.hz * 0.03, t, 0.1)
      this.hetGain.gain.setTargetAtTime(0.2 * het.level, t, 0.03)
    } else this.hetGain.gain.setTargetAtTime(0, t, 0.03)
    this.bed.gain.setTargetAtTime(open ? bed : 0, t, 0.08)
  }

  /** Nivel (RMS) de lo que sale ahora mismo por el altavoz (pruebas). */
  outputRms(): number {
    const a = new Float32Array(this.analyser.fftSize)
    this.analyser.getFloatTimeDomainData(a)
    let s = 0
    for (const x of a) s += x * x
    return Math.sqrt(s / a.length)
  }

  close(): void {
    void this.ctx.close().catch(() => {})
  }
}
