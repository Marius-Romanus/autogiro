// Sonidos del accidente, sintetizados con WebAudio sobre el mismo contexto que
// el resto (src/audio/Sound.ts).
//
//  - `crash`: el golpe principal, una sola vez: estampido grave, chapa y fibra que
//    se aplastan y una lluvia de cascotes que se apaga.
//  - `setTumble`: los restos que siguen rodando y rebotando no son una ristra de
//    golpes sueltos (sonaba a palomitas) sino un crujido/traqueteo continuo cuyo
//    volumen sigue a la energía de los contactos.
//  - `impact` / `snap`: solo los golpes y roturas que destacan sobre ese fondo
//    (pocos por segundo), con timbre variado.
//  - `explosion` + fuego: si el depósito revienta en un choque muy violento.
//  - `setScrape`: arrastre continuo del fuselaje por el suelo.
//
// Todo pasa por una reverberación corta de exterior (se oye el sitio, no un
// estudio) y por un compresor propio que evita que la acumulación sature.

export type ImpactKind = 'ground' | 'metal' | 'composite' | 'glass' | 'masonry' | 'rubber' | 'foliage'

const SOUND_SPEED = 343

export class CrashAudio {
  private ctx: AudioContext | null = null
  /** entrada del bus del accidente (seco + envío a reverberación) */
  private out: GainNode | null = null
  private noises: AudioBuffer[] = []
  private crackle: AudioBuffer | null = null
  private shaper: WaveShaperNode | null = null
  private scrape: { src: AudioBufferSourceNode; bp: BiquadFilterNode; gain: GainNode } | null = null
  private fire: { src: AudioBufferSourceNode; roar: AudioBufferSourceNode; gain: GainNode; lp: BiquadFilterNode } | null = null
  private clatter: AudioBuffer | null = null
  private tumble: { gain: GainNode; lp: BiquadFilterNode; level: number } | null = null
  /** fuerza media reciente de los golpes (para dejar pasar solo los que destacan) */
  private recent = 0
  private recentT = 0
  private lastT = new Map<string, { t: number; g: number }>()
  /** presupuesto de golpes (fichas que se rellenan con el tiempo) */
  private tokens = 2
  private tokensT = 0
  /** momento del golpe principal: justo después, los golpes sueltos sobran */
  private bigT = -10

  attach(ctx: AudioContext, dest: AudioNode): void {
    if (this.ctx === ctx) return
    this.ctx = ctx
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -10
    comp.knee.value = 8
    comp.ratio.value = 6
    comp.attack.value = 0.002
    comp.release.value = 0.25
    comp.connect(dest)
    this.out = ctx.createGain()
    this.out.gain.value = 1
    this.out.connect(comp)
    const verb = ctx.createConvolver()
    verb.buffer = makeImpulse(ctx, 1.8)
    const send = ctx.createGain()
    send.gain.value = 0.32
    this.out.connect(send).connect(verb).connect(comp)

    this.noises = [makeColoredNoise(ctx, 0.97, 4), makeColoredNoise(ctx, 0.995, 14), makeColoredNoise(ctx, 0.6, 1.2)]
    this.crackle = makeCrackle(ctx, 4)
    this.clatter = makeClatter(ctx, 3)
    // saturación (mordiente del aplastamiento y de la deflagración); la curva
    // amplifica ~3× lo débil, así que se compensa a la salida
    this.shaper = ctx.createWaveShaper()
    this.shaper.curve = softClip(3)
    this.shaper.oversample = '2x'
    const post = ctx.createGain()
    post.gain.value = 0.4
    this.shaper.connect(post).connect(this.out)
  }

  private get ready(): boolean {
    return !!this.ctx && !!this.out && this.noises.length > 0 && this.ctx.state === 'running'
  }

  private att(distance: number): number {
    return Math.min(1, 14 / Math.max(6, distance))
  }

  // ---------------------------------------------------------------------------
  // Piezas básicas
  // ---------------------------------------------------------------------------
  /** Ráfaga de ruido filtrado con envolvente percusiva. */
  private burst(o: {
    t0: number
    freq: number
    q?: number
    type?: BiquadFilterType
    dur: number
    gain: number
    attack?: number
    sweepTo?: number
    noise?: number
    rate?: number
    pan?: number
    dest?: AudioNode
  }): void {
    const ctx = this.ctx!
    const src = ctx.createBufferSource()
    src.buffer = this.noises[o.noise ?? (Math.random() * this.noises.length) | 0]
    src.playbackRate.value = o.rate ?? 0.75 + Math.random() * 0.5
    const f = ctx.createBiquadFilter()
    f.type = o.type ?? 'bandpass'
    f.frequency.setValueAtTime(o.freq, o.t0)
    if (o.sweepTo) f.frequency.exponentialRampToValueAtTime(o.sweepTo, o.t0 + o.dur)
    f.Q.value = o.q ?? 0.8
    const e = ctx.createGain()
    const a = o.attack ?? 0.003
    e.gain.setValueAtTime(0, o.t0)
    e.gain.linearRampToValueAtTime(o.gain, o.t0 + a)
    e.gain.exponentialRampToValueAtTime(0.0005, o.t0 + a + o.dur)
    let node: AudioNode = src.connect(f).connect(e)
    if (o.pan) {
      const p = ctx.createStereoPanner()
      p.pan.value = Math.max(-1, Math.min(1, o.pan))
      node = node.connect(p)
    }
    node.connect(o.dest ?? this.out!)
    src.start(o.t0, Math.random() * 1.5, a + o.dur + 0.05)
  }

  /** Golpe grave (seno que cae de tono): el "cuerpo" de un impacto pesado. */
  private thump(t0: number, freq: number, dur: number, gain: number, slide = 0.45, dest?: AudioNode): void {
    const ctx = this.ctx!
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(freq, t0)
    o.frequency.exponentialRampToValueAtTime(Math.max(18, freq * slide), t0 + dur)
    const e = ctx.createGain()
    e.gain.setValueAtTime(0, t0)
    e.gain.linearRampToValueAtTime(gain, t0 + 0.006)
    e.gain.exponentialRampToValueAtTime(0.0005, t0 + dur)
    o.connect(e).connect(dest ?? this.out!)
    o.start(t0)
    o.stop(t0 + dur + 0.05)
  }

  /**
   * Chapa o tubo que resuena: ruido por filtros estrechos a frecuencias no
   * armónicas (suena a "clanc", no a nota musical como un oscilador).
   */
  private clank(t0: number, gain: number, dur: number, pan: number): void {
    const base = 350 + Math.random() * 1100
    const ratios = [1, 1.6 + Math.random() * 0.5, 2.7 + Math.random() * 0.9]
    ratios.forEach((r, i) =>
      this.burst({ t0, freq: base * r, q: 9 + Math.random() * 10, type: 'bandpass', dur: dur * (1 - i * 0.25), gain: gain / (1 + i * 0.6), attack: 0.002, noise: 2, pan }),
    )
  }

  /**
   * Lluvia de cascotes: un traqueteo continuo que se apaga (no golpecitos sueltos,
   * que suenan a palomitas) y unos pocos golpes más gordos por encima.
   */
  private debris(t0: number, span: number, count: number, gain: number): void {
    const ctx = this.ctx!
    if (this.clatter) {
      const src = ctx.createBufferSource()
      src.buffer = this.clatter
      src.playbackRate.value = 0.8 + Math.random() * 0.3
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.setValueAtTime(2600, t0)
      lp.frequency.exponentialRampToValueAtTime(700, t0 + span)
      const e = ctx.createGain()
      e.gain.setValueAtTime(0, t0)
      e.gain.linearRampToValueAtTime(gain * 0.9, t0 + 0.05)
      e.gain.exponentialRampToValueAtTime(0.0005, t0 + span)
      src.connect(lp).connect(e).connect(this.out!)
      src.start(t0, Math.random() * 1.5, span + 0.1)
    }
    for (let i = 0; i < count; i++) {
      const u = Math.random()
      const t = t0 + span * 0.7 * u * u
      const fade = 1 - 0.6 * u
      const pan = (Math.random() - 0.5) * 1.2
      if (Math.random() < 0.5) this.clank(t, gain * fade * 0.25, 0.08 + Math.random() * 0.15, pan)
      else this.burst({ t0: t, freq: 220 + Math.random() * 400, q: 0.9, type: 'lowpass', dur: 0.08 + Math.random() * 0.12, gain: gain * fade * 0.55, noise: 0, pan })
    }
  }

  // ---------------------------------------------------------------------------
  // Golpe principal
  // ---------------------------------------------------------------------------
  /**
   * El choque en sí, una vez por accidente. `severity` ≈ velocidad de impacto del
   * fuselaje (m/s), `distance` cámara-golpe (m).
   */
  crash(severity: number, distance: number): void {
    if (!this.ready) return
    const ctx = this.ctx!
    const t0 = ctx.currentTime + 0.01 + distance / SOUND_SPEED
    this.bigT = ctx.currentTime
    const s = Math.min(1.5, 0.35 + severity / 18)
    const g = s * this.att(distance)
    // estampido grave
    this.thump(t0, 75 + Math.random() * 20, 0.55 + 0.25 * s, g * 1.1, 0.4)
    this.thump(t0 + 0.012, 42, 0.7, g * 0.7, 0.6)
    // aplastamiento: ruido ancho que se cierra de agudo a grave, con mordiente
    this.burst({ t0, freq: 5000, sweepTo: 350, type: 'lowpass', q: 0.7, dur: 0.45 + 0.3 * s, gain: g * 0.9, noise: 0, dest: this.shaper! })
    this.burst({ t0, freq: 2600, q: 0.9, dur: 0.12, gain: g * 0.7, noise: 2 })
    // chapa que se arruga y fibra que cruje en los primeros instantes
    for (let i = 0; i < 6; i++) {
      const t = t0 + 0.01 + Math.random() * 0.22
      const pan = (Math.random() - 0.5) * 0.8
      if (i % 2) this.clank(t, g * 0.35, 0.2 + Math.random() * 0.3, pan)
      else this.burst({ t0: t, freq: 1800 + Math.random() * 2500, q: 1.5, type: 'bandpass', dur: 0.05 + Math.random() * 0.08, gain: g * 0.45, noise: 2, pan })
    }
    // chirrido de metal que se dobla
    this.burst({ t0: t0 + 0.05, freq: 900 + Math.random() * 500, sweepTo: 500, q: 12, dur: 0.35, gain: g * 0.25, attack: 0.04, noise: 2 })
    // cascotes que caen después
    this.debris(t0 + 0.12, 1.2 + 0.6 * s, Math.round(2 + 3 * s), g * 0.5)
  }

  // ---------------------------------------------------------------------------
  // Explosión y fuego
  // ---------------------------------------------------------------------------
  /** El depósito revienta: deflagración, rugido y fuego que se queda ardiendo. */
  explosion(distance: number): void {
    if (!this.ready) return
    const ctx = this.ctx!
    const t0 = ctx.currentTime + 0.01 + distance / SOUND_SPEED
    this.bigT = ctx.currentTime
    const g = Math.min(1, 22 / Math.max(10, distance))
    // frente de la deflagración (golpe seco)
    this.burst({ t0, freq: 1400, type: 'highpass', q: 0.7, dur: 0.04, gain: g * 0.9, attack: 0.001, noise: 2 })
    // bola de fuego: ruido grave que se abre y se cierra, saturado
    this.burst({ t0, freq: 3500, sweepTo: 160, type: 'lowpass', q: 0.6, dur: 1.8, gain: g * 1.2, attack: 0.02, noise: 1, rate: 0.55, dest: this.shaper! })
    this.burst({ t0: t0 + 0.03, freq: 900, sweepTo: 120, type: 'lowpass', q: 0.8, dur: 3.2, gain: g * 0.9, attack: 0.08, noise: 1, rate: 0.4 })
    // presión: graves profundos
    this.thump(t0, 58, 1.4, g * 1.3, 0.45)
    this.thump(t0 + 0.02, 34, 2.2, g * 0.9, 0.7)
    // retumbo que se aleja (eco del terreno)
    this.burst({ t0: t0 + 0.25, freq: 180, type: 'lowpass', q: 0.7, dur: 3.5, gain: g * 0.45, attack: 0.3, noise: 1, rate: 0.35 })
    // trozos y chisporroteo
    this.debris(t0 + 0.1, 2.5, 5, g * 0.4)
    this.startFire(t0 + 0.3, distance)
  }

  private startFire(t0: number, distance: number): void {
    const ctx = this.ctx!
    if (this.fire || !this.crackle) return
    const gain = ctx.createGain()
    gain.gain.value = 0
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 5000
    // chisporroteo
    const src = ctx.createBufferSource()
    src.buffer = this.crackle
    src.loop = true
    src.connect(lp)
    // rugido de las llamas
    const roar = ctx.createBufferSource()
    roar.buffer = this.noises[1]
    roar.loop = true
    roar.playbackRate.value = 0.5
    const rlp = ctx.createBiquadFilter()
    rlp.type = 'lowpass'
    rlp.frequency.value = 320
    const rg = ctx.createGain()
    rg.gain.value = 1.4
    roar.connect(rlp).connect(rg).connect(lp)
    lp.connect(gain).connect(this.out!)
    src.start(t0)
    roar.start(t0, Math.random())
    this.fire = { src, roar, gain, lp }
    this.setFire(1, distance)
  }

  /** Intensidad del fuego 0..1 (se va apagando) y distancia a la cámara. */
  setFire(intensity: number, distance: number): void {
    if (!this.fire || !this.ctx) return
    const att = Math.min(1, 16 / Math.max(6, distance))
    const t = this.ctx.currentTime
    this.fire.gain.gain.setTargetAtTime(0.16 * intensity * att, t, 0.3)
    this.fire.lp.frequency.setTargetAtTime(1500 + 4000 * att, t, 0.3)
  }

  // ---------------------------------------------------------------------------
  // Restos rodando
  // ---------------------------------------------------------------------------
  /**
   * Traqueteo continuo de los restos. `energy` ≈ suma de la fuerza de los
   * contactos de este fotograma (la misma escala que `impact`), `distance` a la
   * cámara. Se suaviza: sube enseguida y baja despacio.
   */
  setTumble(energy: number, distance: number): void {
    const ctx = this.ctx
    if (!ctx || !this.out || !this.clatter) return
    if (!this.tumble) {
      const src = ctx.createBufferSource()
      src.buffer = this.clatter
      src.loop = true
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.Q.value = 0.6
      lp.frequency.value = 900
      const gain = ctx.createGain()
      gain.gain.value = 0
      src.connect(lp).connect(gain).connect(this.out)
      src.start(0, Math.random() * 2)
      this.tumble = { gain, lp, level: 0 }
    }
    const tb = this.tumble
    const target = Math.min(1.5, energy)
    tb.level += (target - tb.level) * (target > tb.level ? 0.5 : 0.08)
    const t = ctx.currentTime
    const g = Math.min(0.55, 0.32 * Math.sqrt(tb.level)) * this.att(distance)
    tb.gain.gain.setTargetAtTime(tb.level > 0.02 ? g : 0, t, 0.05)
    // golpes más fuertes = más graves y más cuerpo; si apenas se mueve, más fino
    tb.lp.frequency.setTargetAtTime(600 + 1400 * Math.min(1, tb.level), t, 0.08)
  }

  // ---------------------------------------------------------------------------
  // Golpes y roturas sueltas
  // ---------------------------------------------------------------------------
  /**
   * Golpe. `strength` ≈ 0..1+ (impulso normalizado), `distance` cámara-golpe (m).
   * Va con presupuesto: si ya han sonado muchos, solo pasan los fuertes; y el mismo
   * contacto repitiéndose (pieza que rebota o tiembla) tiene que superar al anterior.
   */
  impact(kind: ImpactKind, strength: number, distance: number, key: string = kind): void {
    if (!this.ready) return
    const ctx = this.ctx!
    const now = ctx.currentTime
    const s = Math.min(1.6, strength)
    const g = 0.75 * s * this.att(distance)
    if (g < 0.02) return
    // justo tras el golpe principal los sueltos se pierden en él
    if (now - this.bigT < 0.35 && s < 1.2) return
    const last = this.lastT.get(key)
    if (last) {
      const dt = now - last.t
      if (dt < 0.2) return
      if (dt < 0.8 && g < last.g * (0.7 + dt)) return
    }
    // solo los que destacan sobre los golpes recientes (el resto ya lo cubre el
    // traqueteo continuo) y como mucho unos pocos por segundo
    this.recent *= Math.exp(-(now - this.recentT) / 0.6)
    this.recentT = now
    const stands = g > this.recent * 1.3
    this.recent = Math.max(this.recent, g)
    if (!stands && kind !== 'glass') return
    this.tokens = Math.min(2, this.tokens + (now - this.tokensT) * 2.5)
    this.tokensT = now
    if (this.tokens < 1) return
    this.tokens -= 1
    this.lastT.set(key, { t: now, g })

    const t0 = now + distance / SOUND_SPEED
    const v = () => 0.8 + Math.random() * 0.45
    const pan = (Math.random() - 0.5) * 0.7
    switch (kind) {
      case 'ground':
        // golpe sordo + tierra que salta
        this.thump(t0, (55 + Math.random() * 40) * v(), 0.25 + 0.15 * s, g * 0.8, 0.5)
        this.burst({ t0, freq: 220 * v(), q: 0.7, type: 'lowpass', dur: 0.2 + 0.25 * s, gain: g * 0.85, noise: 0, pan })
        if (s > 0.8) this.burst({ t0: t0 + 0.01, freq: 1300 * v(), q: 0.8, dur: 0.1, gain: g * 0.18, noise: 2, pan })
        break
      case 'metal':
        // chapa / tubo: golpe seco + resonancias que se apagan pronto
        this.burst({ t0, freq: 900 * v(), q: 0.9, dur: 0.07, gain: g * 0.45, noise: 0, pan })
        this.clank(t0, g * 0.3, (0.12 + 0.25 * s) * v(), pan)
        this.thump(t0, 85 * v(), 0.15, g * 0.4, 0.5)
        break
      case 'composite':
        // fibra que cruje: ráfaga seca y aguda + cuerpo
        if (s > 0.7) this.burst({ t0, freq: 2000 * v(), q: 1.2, type: 'highpass', dur: 0.05, gain: g * 0.35, noise: 2, pan })
        this.burst({ t0, freq: 500 * v(), q: 0.9, dur: 0.18, gain: g * 0.6, noise: 0, pan })
        this.thump(t0, 100 * v(), 0.15, g * 0.35, 0.6)
        break
      case 'glass':
        for (let i = 0; i < 6; i++) this.burst({ t0: t0 + Math.random() * 0.2, freq: 3500 + Math.random() * 6000, q: 6 + Math.random() * 6, dur: 0.05 + Math.random() * 0.2, gain: g * 0.28, noise: 2, pan: (Math.random() - 0.5) * 1.2 })
        break
      case 'masonry':
        this.burst({ t0, freq: 450 * v(), q: 0.6, type: 'lowpass', dur: 0.3, gain: g * 0.85, noise: 0, pan })
        this.burst({ t0, freq: 1400 * v(), q: 1, dur: 0.15, gain: g * 0.35, noise: 2, pan })
        this.debris(t0 + 0.05, 0.6, 1, g * 0.4)
        break
      case 'foliage':
        // ramas que se parten y hojas
        this.burst({ t0, freq: 2200 * v(), q: 0.6, type: 'highpass', dur: 0.3, gain: g * 0.3, noise: 2, pan })
        for (let i = 0; i < 3; i++) this.burst({ t0: t0 + Math.random() * 0.25, freq: 1500 + Math.random() * 2000, q: 4, dur: 0.03, gain: g * 0.35, noise: 2, pan })
        break
      case 'rubber':
        this.thump(t0, 50 * v(), 0.2, g * 0.6, 0.6)
        this.burst({ t0, freq: 280 * v(), q: 0.7, type: 'lowpass', dur: 0.1, gain: g * 0.25, noise: 0, pan })
        break
    }
  }

  /** Chasquido de una rotura estructural (pala, tubo, ballesta). */
  snap(strength: number, distance: number, metal: boolean): void {
    if (!this.ready) return
    const ctx = this.ctx!
    const now = ctx.currentTime
    // las roturas llegan en racimo (varias piezas en el mismo golpe): una sola
    // suena por encima del golpe principal y luego como mucho ~3 por segundo
    if (now - this.bigT < 0.5 && strength < 1.8) return
    const last = this.lastT.get('snap')
    if (last && now - last.t < 0.3) return
    this.lastT.set('snap', { t: now, g: 1 })
    const t0 = now + distance / SOUND_SPEED
    const g = Math.min(0.8, 0.3 + 0.2 * strength) * this.att(distance)
    const pan = (Math.random() - 0.5) * 0.7
    const v = 0.75 + Math.random() * 0.5
    this.burst({ t0, freq: (metal ? 1200 : 1600) * v, type: 'bandpass', q: 0.7, dur: 0.06, gain: g * 0.7, attack: 0.002, noise: 2, pan })
    this.burst({ t0, freq: 380 * v, q: 0.9, type: 'lowpass', dur: 0.16, gain: g * 0.6, noise: 0, pan })
    if (metal) this.clank(t0, g * 0.25, 0.2, pan)
  }

  /** Arrastre continuo: `speed` m/s de la pieza que más se arrastra, `load` 0..1. */
  setScrape(speed: number, load: number, distance: number, metal: boolean): void {
    const ctx = this.ctx
    if (!ctx || !this.out || !this.noises.length) return
    if (!this.scrape) {
      const src = ctx.createBufferSource()
      src.buffer = this.noises[0]
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
    const target = Math.min(0.6, 0.045 * speed * (0.3 + load)) * this.att(distance)
    const t = ctx.currentTime
    this.scrape.gain.gain.setTargetAtTime(speed > 0.4 ? target : 0, t, 0.08)
    this.scrape.bp.frequency.setTargetAtTime((metal ? 900 : 350) + speed * (metal ? 120 : 45), t, 0.08)
  }

  stop(): void {
    const ctx = this.ctx
    if (!ctx) return
    if (this.scrape) this.scrape.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.05)
    if (this.tumble) {
      this.tumble.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.05)
      this.tumble.level = 0
    }
    this.recent = 0
    if (this.fire) {
      const f = this.fire
      f.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.08)
      f.src.stop(ctx.currentTime + 0.6)
      f.roar.stop(ctx.currentTime + 0.6)
      this.fire = null
    }
    this.lastT.clear()
    this.bigT = -10
    this.tokens = 2
  }
}

// -----------------------------------------------------------------------------
// Búferes
// -----------------------------------------------------------------------------
/** Ruido con un paso bajo de un polo (`k` cerca de 1 = más grave) mezclado con blanco. */
function makeColoredNoise(ctx: AudioContext, k: number, lowMix: number): AudioBuffer {
  const len = ctx.sampleRate * 2
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const d = buf.getChannelData(0)
  let b = 0
  let peak = 0
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1
    b = k * b + (1 - k) * w
    d[i] = w * 0.5 + b * lowMix
    peak = Math.max(peak, Math.abs(d[i]))
  }
  for (let i = 0; i < len; i++) d[i] /= peak
  return buf
}

/** Chisporroteo de fuego: estallidos sueltos de distinto tamaño sobre un siseo. */
function makeCrackle(ctx: AudioContext, seconds: number): AudioBuffer {
  const sr = ctx.sampleRate
  const len = sr * seconds
  const buf = ctx.createBuffer(1, len, sr)
  const d = buf.getChannelData(0)
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * 0.04
  const pops = seconds * 38
  for (let p = 0; p < pops; p++) {
    const at = (Math.random() * len) | 0
    const big = Math.random() < 0.15
    const n = ((big ? 0.012 : 0.003) + Math.random() * 0.004) * sr
    const amp = (big ? 0.9 : 0.35) * (0.4 + Math.random() * 0.6)
    let y = 0
    for (let j = 0; j < n; j++) {
      const idx = (at + j) % len
      y = 0.6 * y + 0.4 * (Math.random() * 2 - 1)
      d[idx] += y * amp * Math.exp((-6 * j) / n)
    }
  }
  return buf
}

/**
 * Traqueteo: muchos golpecitos solapados (piezas, tierra y piedras rodando) de
 * timbre y fuerza muy variados, tan densos que se oyen como textura y no como
 * golpes sueltos. Se reproduce en bucle con el volumen que marquen los contactos.
 */
function makeClatter(ctx: AudioContext, seconds: number): AudioBuffer {
  const sr = ctx.sampleRate
  const len = sr * seconds
  const buf = ctx.createBuffer(1, len, sr)
  const d = buf.getChannelData(0)
  const grains = seconds * 90
  for (let k = 0; k < grains; k++) {
    const at = (Math.random() * len) | 0
    const n = Math.round((0.008 + Math.random() * 0.035) * sr)
    // fuerza muy desigual: muchos roces flojos y algún golpe
    const amp = Math.pow(Math.random(), 2.5)
    // paso bajo de un polo: unos granos sordos (tierra), otros más secos (piezas)
    const c = 0.55 + Math.random() * 0.4
    let y = 0
    for (let j = 0; j < n; j++) {
      y = c * y + (1 - c) * (Math.random() * 2 - 1)
      d[(at + j) % len] += y * amp * Math.exp((-5 * j) / n) * (j < 20 ? j / 20 : 1)
    }
  }
  let peak = 0
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]))
  for (let i = 0; i < len; i++) d[i] /= peak
  return buf
}

/** Respuesta de un exterior abierto: primeras reflexiones del suelo y cola corta oscura. */
function makeImpulse(ctx: AudioContext, seconds: number): AudioBuffer {
  const sr = ctx.sampleRate
  const len = Math.round(sr * seconds)
  const buf = ctx.createBuffer(2, len, sr)
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch)
    let lp = 0
    for (let i = 0; i < len; i++) {
      const t = i / sr
      // se oscurece con el tiempo (el aire y la vegetación se comen los agudos)
      const k = Math.min(0.97, 0.35 + t * 0.9)
      lp = k * lp + (1 - k) * (Math.random() * 2 - 1)
      d[i] = lp * Math.exp(-t * 4.2) * (t < 0.012 ? t / 0.012 : 1)
    }
    // un par de ecos discretos (edificios, arbolado)
    for (const [t, a] of [
      [0.045 + ch * 0.007, 0.35],
      [0.11 + ch * 0.013, 0.2],
    ]) {
      const i0 = Math.round(t * sr)
      for (let j = 0; j < 200 && i0 + j < len; j++) d[i0 + j] += a * (Math.random() * 2 - 1) * Math.exp(-j / 40)
    }
  }
  return buf
}

function softClip(drive: number): Float32Array<ArrayBuffer> {
  const n = 1024
  const c = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    c[i] = Math.tanh(drive * x) / Math.tanh(drive)
  }
  return c
}
