// Sonido sintetizado con WebAudio: motor Rotax, hélice, "whop" del rotor bipala,
// viento, rodadura, prerrotador y avisos.

export interface SoundState {
  engineRpm: number
  power: number // 0..1
  rotorRpm: number
  rotorLoad: number // empuje/peso
  tas: number // m/s
  rolling: number // m/s
  prerot: boolean
  lowRotor: boolean
  teeterHit: number
  cockpit: boolean
  distance: number // cámara-aparato (m)
  engineOn: boolean
  /**
   * Motor que falla (sim/powerplant.ts): cuánto tironea (0..1) y lo que está quemando ahora (0..1;
   * 0 = un corte). Faltan con el motor sano.
   */
  misfire?: number
  firing?: number
  /**
   * Voz del aparato (si falta, la del Rotax de cuatro cilindros con reductora 2,43, hélice
   * tripala y rotor bipala de ~350 rpm): cilindros, reductora, palas de hélice y de rotor,
   * régimen máximo del motor y vueltas de rotor de crucero.
   */
  voice?: { cylinders: number; gear: number; propBlades: number; rotorBlades: number; rpmMax: number; rotorRpm: number }
}

const ROTAX_VOICE = { cylinders: 4, gear: 2.43, propBlades: 3, rotorBlades: 2, rpmMax: 5500, rotorRpm: 380 }

export class Sound {
  private ctx: AudioContext | null = null
  private master!: GainNode
  private eng!: { osc1: OscillatorNode; osc2: OscillatorNode; prop: OscillatorNode; lp: BiquadFilterNode; gain: GainNode; propGain: GainNode; noiseGain: GainNode; noiseBp: BiquadFilterNode }
  private rotor!: { gain: GainNode; lfo: OscillatorNode; lfoGain: GainNode; bp: BiquadFilterNode; thump: OscillatorNode; thumpGain: GainNode }
  private wind!: { gain: GainNode; lp: BiquadFilterNode }
  private tire!: { gain: GainNode }
  private pre!: { osc: OscillatorNode; gain: GainNode }
  private warn!: { osc: OscillatorNode; gain: GainNode }
  private hitGain!: GainNode
  private t = 0
  private lastFiring = 1
  volume = 0.8

  start(): void {
    if (this.ctx) {
      void this.ctx.resume()
      return
    }
    const ctx = new AudioContext()
    this.ctx = ctx
    this.master = ctx.createGain()
    this.master.gain.value = this.volume
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -14
    comp.ratio.value = 4
    this.master.connect(comp).connect(ctx.destination)

    const noise = makeNoise(ctx)

    // --- motor ---
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.Q.value = 0.9
    const shaper = ctx.createWaveShaper()
    shaper.curve = distortionCurve(18)
    const gain = ctx.createGain()
    gain.gain.value = 0
    const osc1 = ctx.createOscillator()
    osc1.type = 'sawtooth'
    const osc2 = ctx.createOscillator()
    osc2.type = 'square'
    const o2g = ctx.createGain()
    o2g.gain.value = 0.35
    osc1.connect(shaper)
    osc2.connect(o2g).connect(shaper)
    shaper.connect(lp).connect(gain).connect(this.master)
    const prop = ctx.createOscillator()
    prop.type = 'triangle'
    const propGain = ctx.createGain()
    propGain.gain.value = 0
    prop.connect(propGain).connect(this.master)
    const noiseSrc = ctx.createBufferSource()
    noiseSrc.buffer = noise
    noiseSrc.loop = true
    const noiseBp = ctx.createBiquadFilter()
    noiseBp.type = 'bandpass'
    noiseBp.Q.value = 1.2
    const noiseGain = ctx.createGain()
    noiseGain.gain.value = 0
    noiseSrc.connect(noiseBp).connect(noiseGain).connect(this.master)
    osc1.start()
    osc2.start()
    prop.start()
    noiseSrc.start()
    this.eng = { osc1, osc2, prop, lp, gain, propGain, noiseGain, noiseBp }

    // --- rotor: ruido modulado al paso de pala ---
    const rSrc = ctx.createBufferSource()
    rSrc.buffer = noise
    rSrc.loop = true
    rSrc.playbackRate.value = 0.7
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 420
    bp.Q.value = 0.8
    const rGain = ctx.createGain()
    rGain.gain.value = 0
    const mod = ctx.createGain()
    mod.gain.value = 0.5
    const lfo = ctx.createOscillator()
    lfo.type = 'sine'
    const lfoGain = ctx.createGain()
    lfoGain.gain.value = 0.5
    lfo.connect(lfoGain).connect(mod.gain)
    rSrc.connect(bp).connect(mod).connect(rGain).connect(this.master)
    const thump = ctx.createOscillator()
    thump.type = 'sine'
    thump.frequency.value = 45
    const thumpGain = ctx.createGain()
    thumpGain.gain.value = 0
    const thumpMod = ctx.createGain()
    thumpMod.gain.value = 0
    lfoGain.connect(thumpMod.gain)
    thump.connect(thumpMod).connect(thumpGain).connect(this.master)
    rSrc.start()
    lfo.start()
    thump.start()
    this.rotor = { gain: rGain, lfo, lfoGain, bp, thump, thumpGain }

    // --- viento ---
    const wSrc = ctx.createBufferSource()
    wSrc.buffer = noise
    wSrc.loop = true
    const wlp = ctx.createBiquadFilter()
    wlp.type = 'lowpass'
    const wGain = ctx.createGain()
    wGain.gain.value = 0
    wSrc.connect(wlp).connect(wGain).connect(this.master)
    wSrc.start()
    this.wind = { gain: wGain, lp: wlp }

    // --- rodadura ---
    const tSrc = ctx.createBufferSource()
    tSrc.buffer = noise
    tSrc.loop = true
    tSrc.playbackRate.value = 0.4
    const tlp = ctx.createBiquadFilter()
    tlp.type = 'lowpass'
    tlp.frequency.value = 180
    const tGain = ctx.createGain()
    tGain.gain.value = 0
    tSrc.connect(tlp).connect(tGain).connect(this.master)
    tSrc.start()
    this.tire = { gain: tGain }

    // --- prerrotador (zumbido de la transmisión) ---
    const pOsc = ctx.createOscillator()
    pOsc.type = 'sawtooth'
    const pGain = ctx.createGain()
    pGain.gain.value = 0
    const plp = ctx.createBiquadFilter()
    plp.type = 'lowpass'
    plp.frequency.value = 900
    pOsc.connect(plp).connect(pGain).connect(this.master)
    pOsc.start()
    this.pre = { osc: pOsc, gain: pGain }

    // --- aviso ---
    const wOsc = ctx.createOscillator()
    wOsc.type = 'square'
    wOsc.frequency.value = 880
    const warnGain = ctx.createGain()
    warnGain.gain.value = 0
    wOsc.connect(warnGain).connect(this.master)
    wOsc.start()
    this.warn = { osc: wOsc, gain: warnGain }

    // --- golpes en topes ---
    const hSrc = ctx.createBufferSource()
    hSrc.buffer = noise
    hSrc.loop = true
    const hlp = ctx.createBiquadFilter()
    hlp.type = 'lowpass'
    hlp.frequency.value = 260
    this.hitGain = ctx.createGain()
    this.hitGain.gain.value = 0
    hSrc.connect(hlp).connect(this.hitGain).connect(this.master)
    hSrc.start()
  }

  suspend(): void {
    void this.ctx?.suspend()
  }

  /** Contexto y salida general, para otros sonidos (p. ej. los del accidente). */
  get output(): { ctx: AudioContext; node: AudioNode } | null {
    return this.ctx ? { ctx: this.ctx, node: this.master } : null
  }

  update(s: SoundState, dt: number): void {
    const ctx = this.ctx
    if (!ctx || ctx.state !== 'running') return
    this.t += dt
    const now = ctx.currentTime
    const k = 0.06 // constante de suavizado (s)
    const set = (p: AudioParam, v: number) => p.setTargetAtTime(v, now, k)
    this.master.gain.setTargetAtTime(this.volume, now, 0.1)
    const distAtt = s.cockpit ? 1 : 1 / (1 + Math.max(0, s.distance - 8) / 25)

    // motor
    const vc = s.voice ?? ROTAX_VOICE
    // régimen "equivalente" de un Rotax para los filtros (un radial lento no suena más apagado
    // por girar a 2000 rpm: lo que baja es la frecuencia de las explosiones)
    const rpmEq = (s.engineRpm * 5500) / vc.rpmMax
    const fire = (s.engineRpm / 60) * (vc.cylinders / 2)
    set(this.eng.osc1.frequency, Math.max(5, fire))
    set(this.eng.osc2.frequency, Math.max(3, fire / 2))
    const propF = ((s.engineRpm / vc.gear) / 60) * vc.propBlades
    set(this.eng.prop.frequency, Math.max(2, propF))
    set(this.eng.lp.frequency, 280 + rpmEq * 0.32 + s.power * 900)
    const on = s.engineOn && rpmEq > 300 ? 1 : 0
    // motor que falla: en cada corte se apaga el ruido de las explosiones de golpe (queda la hélice
    // y el aire) y al volver a encender petardea
    const rough = s.misfire ?? 0
    const firing = s.firing ?? 1
    const cut = rough > 0 ? 0.2 + 0.8 * Math.min(1, firing) : 1
    const engGain = on * (0.05 + 0.13 * s.power + 0.05 * (rpmEq / 5500)) * (s.cockpit ? 1.1 : 0.9) * distAtt * cut
    if (rough > 0) this.eng.gain.gain.setTargetAtTime(engGain, now, 0.012)
    else set(this.eng.gain.gain, engGain)
    set(this.eng.propGain.gain, on * (0.05 + 0.12 * s.power) * distAtt * (s.cockpit ? 0.7 : 1.2))
    set(this.eng.noiseBp.frequency, 500 + rpmEq * 0.25)
    const noise = on * (0.02 + 0.08 * s.power) * distAtt
    if (rough > 0 && on && this.lastFiring < 0.5 && firing >= 0.5) {
      this.eng.noiseGain.gain.setValueAtTime(0.3 * distAtt, now)
      this.eng.noiseGain.gain.setTargetAtTime(noise, now + 0.03, 0.04)
    } else set(this.eng.noiseGain.gain, noise)
    this.lastFiring = firing

    // rotor
    const bladePass = (vc.rotorBlades * s.rotorRpm) / 60
    set(this.rotor.lfo.frequency, Math.max(0.1, bladePass))
    const rLevel = Math.min(1.4, Math.pow(s.rotorRpm / vc.rotorRpm, 2))
    set(this.rotor.gain.gain, rLevel * (0.06 + 0.07 * Math.min(1.6, s.rotorLoad)) * (s.cockpit ? 0.8 : 1.2) * distAtt)
    set(this.rotor.lfoGain.gain, 0.35 + 0.35 * Math.min(1.5, s.rotorLoad))
    set(this.rotor.bp.frequency, 260 + s.rotorRpm * 0.6)
    set(this.rotor.thumpGain.gain, rLevel * 0.25 * Math.min(1.5, s.rotorLoad) * distAtt)

    // viento (cabina abierta: mucho viento)
    const w = Math.min(1.5, Math.pow(s.tas / 40, 2))
    set(this.wind.gain.gain, w * (s.cockpit ? 0.28 : 0.1))
    set(this.wind.lp.frequency, 300 + s.tas * 28)

    set(this.tire.gain.gain, Math.min(1, s.rolling / 15) * 0.22 * distAtt)

    set(this.pre.gain.gain, s.prerot ? 0.05 * distAtt : 0)
    set(this.pre.osc.frequency, 60 + s.rotorRpm * 0.9)

    const beep = s.lowRotor && this.t % 0.6 < 0.3 ? 0.06 : 0
    set(this.warn.gain.gain, beep)

    const hit = Math.min(1, s.teeterHit * 2)
    this.hitGain.gain.setTargetAtTime(hit * 0.9, now, 0.01)
  }
}

function makeNoise(ctx: AudioContext): AudioBuffer {
  const len = ctx.sampleRate * 2
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const d = buf.getChannelData(0)
  // ruido rosa aproximado
  let b0 = 0
  let b1 = 0
  let b2 = 0
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1
    b0 = 0.99765 * b0 + w * 0.099046
    b1 = 0.963 * b1 + w * 0.2965164
    b2 = 0.57 * b2 + w * 1.0526913
    d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.18
  }
  return buf
}

function distortionCurve(k: number): Float32Array<ArrayBuffer> {
  const n = 1024
  const curve = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x))
  }
  return curve
}
