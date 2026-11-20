// Sonidos del accidente, sintetizados con WebAudio sobre el mismo contexto que
// el resto (src/audio/Sound.ts): golpes sordos contra tierra, chapa y tubo de
// aluminio que resuenan, composite que cruje, cristales, chasquidos de rotura y
// el arrastre continuo del fuselaje por el suelo.

export type ImpactKind = 'ground' | 'metal' | 'composite' | 'glass' | 'masonry' | 'rubber' | 'foliage'

export class CrashAudio {
  private ctx: AudioContext | null = null
  private out: GainNode | null = null
  private noise: AudioBuffer | null = null
  private scrape: { src: AudioBufferSourceNode; bp: BiquadFilterNode; gain: GainNode } | null = null
  private lastT = new Map<string, number>()

  attach(ctx: AudioContext, dest: AudioNode): void {
    if (this.ctx === ctx) return
    this.ctx = ctx
    this.out = ctx.createGain()
    this.out.gain.value = 1
    this.out.connect(dest)
    const len = ctx.sampleRate * 2
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const d = buf.getChannelData(0)
    // ruido algo rosado (más cuerpo en graves)
    let b = 0
    for (let i = 0; i < len; i++) {
      b = 0.97 * b + 0.03 * (Math.random() * 2 - 1)
      d[i] = (Math.random() * 2 - 1) * 0.6 + b * 4
    }
    this.noise = buf
  }

  /**
   * Golpe. `strength` ≈ 0..1+ (impulso normalizado), `distance` cámara-golpe (m).
   * Limita la repetición del mismo tipo para no saturar.
   */
  impact(kind: ImpactKind, strength: number, distance: number, key: string = kind): void {
    const ctx = this.ctx
    if (!ctx || !this.out || !this.noise || ctx.state !== 'running') return
    const now = ctx.currentTime
    const last = this.lastT.get(key) ?? -1
    if (now - last < 0.045) return
    this.lastT.set(key, now)
    const s = Math.min(1.6, strength)
    const att = Math.min(1, 14 / Math.max(6, distance))
    const g = 0.9 * s * att
    if (g < 0.01) return

    const noiseHit = (freq: number, q: number, dur: number, gain: number, type: BiquadFilterType = 'bandpass', delay = 0) => {
      const src = ctx.createBufferSource()
      src.buffer = this.noise!
      src.playbackRate.value = 0.8 + Math.random() * 0.4
      const f = ctx.createBiquadFilter()
      f.type = type
      f.frequency.value = freq
      f.Q.value = q
      const e = ctx.createGain()
      const t0 = now + delay
      e.gain.setValueAtTime(0, t0)
      e.gain.linearRampToValueAtTime(gain, t0 + 0.004)
      e.gain.exponentialRampToValueAtTime(0.0008, t0 + dur)
      src.connect(f).connect(e).connect(this.out!)
      src.start(t0, Math.random() * 1.5, dur + 0.05)
    }
    const tone = (freq: number, dur: number, gain: number, type: OscillatorType = 'sine', slide = 0.6) => {
      const o = ctx.createOscillator()
      o.type = type
      o.frequency.setValueAtTime(freq, now)
      o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), now + dur)
      const e = ctx.createGain()
      e.gain.setValueAtTime(0, now)
      e.gain.linearRampToValueAtTime(gain, now + 0.003)
      e.gain.exponentialRampToValueAtTime(0.0008, now + dur)
      o.connect(e).connect(this.out!)
      o.start(now)
      o.stop(now + dur + 0.05)
    }

    switch (kind) {
      case 'ground':
        // golpe sordo + tierra que salta
        tone(70 + Math.random() * 30, 0.35, g * 0.9, 'sine', 0.5)
        noiseHit(260, 0.7, 0.28 + 0.25 * s, g * 0.9, 'lowpass')
        noiseHit(1800, 0.8, 0.12, g * 0.25)
        break
      case 'metal': {
        // chapa / tubo: golpe + varias resonancias que se apagan
        noiseHit(1200, 0.9, 0.08, g * 0.8)
        const base = 380 + Math.random() * 900
        for (const m of [1, 2.76, 5.4]) tone(base * m, 0.35 + Math.random() * 0.5 * s, (g * 0.18) / m, 'triangle', 0.98)
        tone(90, 0.2, g * 0.5, 'sine', 0.5)
        break
      }
      case 'composite':
        // fibra que cruje: ráfaga seca y aguda + cuerpo
        noiseHit(2600, 1.2, 0.07, g * 0.8, 'highpass')
        noiseHit(600, 0.9, 0.18, g * 0.6)
        noiseHit(3400, 2, 0.05, g * 0.4, 'bandpass', 0.03 + Math.random() * 0.04)
        tone(110, 0.18, g * 0.4, 'sine', 0.6)
        break
      case 'glass':
        for (let i = 0; i < 5; i++) noiseHit(4000 + Math.random() * 5000, 8, 0.08 + Math.random() * 0.2, g * 0.3, 'bandpass', Math.random() * 0.18)
        break
      case 'masonry':
        noiseHit(500, 0.6, 0.35, g * 0.9, 'lowpass')
        noiseHit(1500, 1, 0.2, g * 0.4)
        for (let i = 0; i < 3; i++) noiseHit(900 + Math.random() * 1500, 3, 0.06, g * 0.25, 'bandpass', 0.08 + Math.random() * 0.4)
        break
      case 'foliage':
        // ramas que se parten y hojas
        noiseHit(2400, 0.6, 0.35, g * 0.35, 'highpass')
        for (let i = 0; i < 3; i++) noiseHit(1500 + Math.random() * 2000, 4, 0.04, g * 0.4, 'bandpass', Math.random() * 0.25)
        break
      case 'rubber':
        tone(55, 0.25, g * 0.7, 'sine', 0.6)
        noiseHit(300, 0.7, 0.12, g * 0.3, 'lowpass')
        break
    }
  }

  /** Chasquido de una rotura estructural (pala, tubo, ballesta). */
  snap(strength: number, distance: number, metal: boolean): void {
    const ctx = this.ctx
    if (!ctx || !this.out || !this.noise || ctx.state !== 'running') return
    const now = ctx.currentTime
    const att = Math.min(1, 14 / Math.max(6, distance))
    const g = Math.min(1.2, 0.5 + 0.3 * strength) * att
    const src = ctx.createBufferSource()
    src.buffer = this.noise
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = metal ? 1500 : 2200
    const e = ctx.createGain()
    e.gain.setValueAtTime(g, now)
    e.gain.exponentialRampToValueAtTime(0.001, now + 0.09)
    src.connect(hp).connect(e).connect(this.out)
    src.start(now, Math.random(), 0.12)
    if (metal) this.impact('metal', strength * 0.7, distance, 'snap-metal')
    else this.impact('composite', strength * 0.7, distance, 'snap-comp')
  }

  /** Arrastre continuo: `speed` m/s de la pieza que más se arrastra, `load` 0..1. */
  setScrape(speed: number, load: number, distance: number, metal: boolean): void {
    const ctx = this.ctx
    if (!ctx || !this.out || !this.noise) return
    if (!this.scrape) {
      const src = ctx.createBufferSource()
      src.buffer = this.noise
      src.loop = true
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.Q.value = 0.8
      const gain = ctx.createGain()
      gain.gain.value = 0
      src.connect(bp).connect(gain).connect(this.out)
      src.start()
      this.scrape = { src, bp, gain }
    }
    const att = Math.min(1, 14 / Math.max(6, distance))
    const target = Math.min(0.7, 0.05 * speed * (0.3 + load)) * att
    const t = ctx.currentTime
    this.scrape.gain.gain.setTargetAtTime(speed > 0.4 ? target : 0, t, 0.06)
    this.scrape.bp.frequency.setTargetAtTime((metal ? 900 : 350) + speed * (metal ? 120 : 45), t, 0.08)
  }

  stop(): void {
    if (this.scrape && this.ctx) this.scrape.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05)
  }
}
