// Sonido de los aparatos del tráfico aéreo: motor, hélice y batir del rotor de los más cercanos,
// con su distancia (más flojo y más apagado: el aire se come los agudos), su lado (estéreo) y el
// efecto Doppler al pasar. Usa el mismo contexto y la misma salida que el sonido del jugador
// (audio/Sound.ts), así el volumen del menú manda en todo.

export interface VoiceState {
  id: number
  /** distancia a la cámara (m) y velocidad con que se acerca (m/s, + acercándose) */
  distance: number
  closing: number
  /** −1 izquierda .. +1 derecha respecto a donde mira la cámara */
  pan: number
  engineRpm: number
  /** 0..1 */
  power: number
  rotorRpm: number
  /** cilindros, reductora y palas (como SoundState.voice) */
  cylinders: number
  gear: number
  propBlades: number
  rotorBlades: number
  rpmMax: number
}

const VOICES = 3
const C_SOUND = 340

interface Voice {
  id: number
  osc1: OscillatorNode
  osc2: OscillatorNode
  prop: OscillatorNode
  lp: BiquadFilterNode
  eng: GainNode
  propGain: GainNode
  rotorGain: GainNode
  rotorLfo: OscillatorNode
  air: BiquadFilterNode
  pan: StereoPannerNode
  out: GainNode
}

export class TrafficSound {
  private ctx: AudioContext | null = null
  private voices: Voice[] = []

  private build(ctx: AudioContext, dest: AudioNode): void {
    this.ctx = ctx
    // ruido para el rotor
    const len = ctx.sampleRate * 2
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
    for (let k = 0; k < VOICES; k++) {
      const out = ctx.createGain()
      out.gain.value = 0
      const pan = ctx.createStereoPanner()
      const air = ctx.createBiquadFilter()
      air.type = 'lowpass'
      air.frequency.value = 6000
      air.connect(pan).connect(out).connect(dest)
      // motor: dos osciladores recortados por un paso bajo
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.Q.value = 0.8
      const eng = ctx.createGain()
      eng.gain.value = 0
      const osc1 = ctx.createOscillator()
      osc1.type = 'sawtooth'
      const osc2 = ctx.createOscillator()
      osc2.type = 'square'
      const o2 = ctx.createGain()
      o2.gain.value = 0.35
      osc1.connect(lp)
      osc2.connect(o2).connect(lp)
      lp.connect(eng).connect(air)
      // hélice
      const prop = ctx.createOscillator()
      prop.type = 'triangle'
      const propGain = ctx.createGain()
      propGain.gain.value = 0
      prop.connect(propGain).connect(air)
      // rotor: ruido filtrado que late al paso de las palas
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.loop = true
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.frequency.value = 320
      bp.Q.value = 0.7
      const rotorGain = ctx.createGain()
      rotorGain.gain.value = 0
      const beat = ctx.createGain()
      beat.gain.value = 0.5
      const rotorLfo = ctx.createOscillator()
      rotorLfo.type = 'sine'
      const lfoDepth = ctx.createGain()
      lfoDepth.gain.value = 0.5
      rotorLfo.connect(lfoDepth).connect(beat.gain)
      src.connect(bp).connect(beat).connect(rotorGain).connect(air)
      for (const o of [osc1, osc2, prop, rotorLfo]) o.start()
      src.start()
      this.voices.push({ id: -1, osc1, osc2, prop, lp, eng, propGain, rotorGain, rotorLfo, air, pan, out })
    }
  }

  /**
   * `list`: los aparatos con el motor en marcha o el rotor girando. `output`: la salida del sonido
   * del jugador (null hasta que arranca). `cockpit`: dentro de la cabina se oye menos lo de fuera.
   */
  update(list: VoiceState[], output: { ctx: AudioContext; node: AudioNode } | null, cockpit: boolean, quiet: boolean): void {
    if (!output) return
    if (!this.ctx) this.build(output.ctx, output.node)
    const ctx = this.ctx!
    if (ctx.state !== 'running') return
    const now = ctx.currentTime
    const set = (p: AudioParam, v: number, k = 0.08) => p.setTargetAtTime(v, now, k)
    // los más cercanos; cada voz sigue con su aparato mientras siga entre ellos
    const near = quiet ? [] : list.filter((s) => s.distance < 1800).sort((a, b) => a.distance - b.distance).slice(0, VOICES)
    for (const v of this.voices) if (!near.some((s) => s.id === v.id)) v.id = -1
    for (const s of near) {
      if (this.voices.some((v) => v.id === s.id)) continue
      const free = this.voices.find((v) => v.id === -1)
      if (free) {
        free.id = s.id
        free.out.gain.setTargetAtTime(0, now, 0.01)
      }
    }
    for (const v of this.voices) {
      const s = near.find((x) => x.id === v.id)
      if (!s) {
        set(v.out.gain, 0, 0.15)
        continue
      }
      const doppler = C_SOUND / (C_SOUND - Math.max(-60, Math.min(60, s.closing)))
      const fire = (s.engineRpm / 60) * (s.cylinders / 2) * doppler
      const rpmEq = (s.engineRpm * 5500) / s.rpmMax
      const on = s.engineRpm > 300 ? 1 : 0
      set(v.osc1.frequency, Math.max(5, fire))
      set(v.osc2.frequency, Math.max(3, fire / 2))
      set(v.prop.frequency, Math.max(2, (s.engineRpm / s.gear / 60) * s.propBlades * doppler))
      set(v.lp.frequency, 260 + rpmEq * 0.3 + s.power * 800)
      set(v.eng.gain, on * (0.05 + 0.13 * s.power + 0.05 * (rpmEq / 5500)))
      set(v.propGain.gain, on * (0.06 + 0.14 * s.power))
      const rotorOn = Math.min(1, s.rotorRpm / 300)
      set(v.rotorLfo.frequency, Math.max(0.5, (s.rotorRpm / 60) * s.rotorBlades * doppler))
      set(v.rotorGain.gain, 0.1 * rotorOn * rotorOn)
      // distancia: 1/d desde 12 m, y los agudos se pierden con los metros
      const att = 1 / (1 + Math.max(0, s.distance - 12) / 28)
      set(v.out.gain, att * (cockpit ? 0.45 : 1), 0.12)
      set(v.air.frequency, Math.max(500, 7000 / (1 + s.distance / 350)), 0.2)
      set(v.pan.pan, Math.max(-0.9, Math.min(0.9, s.pan)), 0.1)
    }
  }
}
