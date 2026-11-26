// Sonido de la lluvia, sintetizado: el siseo de la lluvia al aire libre (ruido filtrado en agudos) y
// el repiqueteo sobre la cúpula en cabina cerrada (impactos sueltos que hacen sonar el metacrilato,
// más graves y más fuertes cuanto más deprisa se vuela). En cabina abierta, siseo y algún golpe en
// el casco y el parabrisas; desde fuera, solo el siseo. La nieve no suena.
// Se cuelga de la salida de Sound.ts (`sound.output`), así respeta el volumen general.

export interface RainSoundState {
  /** intensidad de la lluvia líquida 0..1 */
  amount: number
  /** vista desde el asiento, y si la cabina es cerrada */
  cockpit: boolean
  enclosed: boolean
  /** velocidad del aire (m/s): las gotas golpean más fuerte */
  tas: number
}

export class RainSound {
  private ctx: AudioContext | null = null
  private hiss!: { gain: GainNode; lp: BiquadFilterNode }
  private patter!: { gain: GainNode; bp: BiquadFilterNode }

  attach(ctx: AudioContext, out: AudioNode): void {
    if (this.ctx === ctx) return
    this.ctx = ctx
    const len = ctx.sampleRate * 3
    // ruido blanco
    const nb = ctx.createBuffer(1, len, ctx.sampleRate)
    const nd = nb.getChannelData(0)
    let r = 987654321
    const rnd = () => ((r = (Math.imul(r, 1664525) + 1013904223) >>> 0) / 4294967296)
    for (let i = 0; i < len; i++) nd[i] = rnd() * 2 - 1
    // impactos sueltos: chasquidos que se apagan en ~4 ms, a razón de ~140 por segundo
    const ib = ctx.createBuffer(1, len, ctx.sampleRate)
    const id = ib.getChannelData(0)
    const n = Math.floor(140 * 3)
    for (let k = 0; k < n; k++) {
      const at = Math.floor(rnd() * (len - 600))
      const amp = 0.25 + 0.75 * rnd() * rnd()
      const tau = ctx.sampleRate * (0.002 + 0.004 * rnd())
      for (let i = 0; i < 500; i++) id[at + i] += amp * Math.exp(-i / tau) * (rnd() * 2 - 1)
    }
    const loop = (b: AudioBuffer) => {
      const s = ctx.createBufferSource()
      s.buffer = b
      s.loop = true
      s.start()
      return s
    }
    // siseo
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 1400
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 9000
    const hg = ctx.createGain()
    hg.gain.value = 0
    loop(nb).connect(hp).connect(lp).connect(hg).connect(out)
    this.hiss = { gain: hg, lp }
    // repiqueteo
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 900
    bp.Q.value = 0.9
    const pg = ctx.createGain()
    pg.gain.value = 0
    loop(ib).connect(bp).connect(pg).connect(out)
    this.patter = { gain: pg, bp }
  }

  update(s: RainSoundState): void {
    const ctx = this.ctx
    if (!ctx) return
    const t = ctx.currentTime
    const set = (p: AudioParam, v: number) => p.setTargetAtTime(v, t, 0.15)
    const a = Math.min(1, Math.max(0, s.amount))
    const level = Math.sqrt(a)
    const inside = s.cockpit && s.enclosed
    // dentro de la cúpula el siseo llega apagado
    set(this.hiss.lp.frequency, inside ? 1500 : 9000)
    set(this.hiss.gain.gain, level * (inside ? 0.035 : s.cockpit ? 0.07 : 0.09))
    const speed = Math.min(1.6, 0.6 + s.tas / 35)
    // cúpula: metacrilato (≈ 900 Hz); cabina abierta: casco y parabrisas pequeño, más seco
    set(this.patter.bp.frequency, inside ? 900 : 2200)
    set(this.patter.gain.gain, s.cockpit ? level * speed * (inside ? 0.5 : 0.12) : 0)
  }
}
