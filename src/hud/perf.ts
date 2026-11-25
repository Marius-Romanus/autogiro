// Medidor de rendimiento de la telemetría (tecla F3, src/hud/Telemetry.ts).
//
// El fotograma se parte en secciones con perf.mark('clave'): cada marca cierra la sección
// anterior y abre la siguiente. De cada sección se mide
//   - CPU: tiempo de JavaScript (incluye mandar las órdenes a WebGL, no su ejecución),
//   - GPU: tiempo real de la tarjeta con EXT_disjoint_timer_query_webgl2 (llega 1-3
//     fotogramas después; si el navegador no la ofrece, la GPU sale como «n/d»),
//   - llamadas de dibujo y triángulos (renderer.render envuelto: three pone a cero
//     renderer.info en cada render y el compositor hace muchos por fotograma).
// Con la telemetría oculta no se mide nada: cada marca es un `if`.

import type { WebGLRenderer } from 'three'

/** Fotogramas que se guardan para la gráfica y los percentiles. */
export const HISTORY = 240

export interface FrameRecord {
  /** tiempo entre fotogramas (ms, del reloj de requestAnimationFrame) */
  dt: number
  /** tiempo de CPU del bucle (ms) */
  cpu: number
  /** tiempo de GPU (ms); NaN hasta que llega la lectura o si no hay medidor */
  gpu: number
  /** número de fotograma (para casar la lectura de GPU, que llega tarde) */
  id: number
}

export interface SectionStat {
  key: string
  /** ms por fotograma, media de la ventana */
  cpu: number
  /** ms por fotograma; NaN sin medidor de GPU */
  gpu: number
  /** llamadas de dibujo por fotograma */
  calls: number
  /** triángulos por fotograma */
  tris: number
}

export interface WindowStats {
  frames: number
  /** duración de la ventana (ms) */
  span: number
  cpu: number
  gpu: number
  calls: number
  tris: number
  points: number
  lines: number
  /** llamadas a renderer.render por fotograma */
  renders: number
  sections: SectionStat[]
}

interface Ext {
  TIME_ELAPSED_EXT: number
  GPU_DISJOINT_EXT: number
}

interface PendingFrame {
  id: number
  /** pares (sección, consulta) en orden */
  sec: number[]
  q: WebGLQuery[]
}

class Perf {
  /** la telemetría quiere medidas (se aplica al empezar el siguiente fotograma) */
  wanted = false
  /** se está midiendo este fotograma */
  private active = false
  private gl: WebGL2RenderingContext | null = null
  private ext: Ext | null = null
  get gpuSupported(): boolean {
    return Boolean(this.ext)
  }

  // --- fotograma en curso
  private frameId = 0
  private frameT0 = 0
  private lastRaf = -1
  private cur = -1
  private curT0 = 0
  private queryOpen = false
  private frameSec: number[] = []
  private frameQ: WebGLQuery[] = []
  private pending: PendingFrame[] = []
  private pool: WebGLQuery[] = []

  // --- secciones (índices estables mientras dure la ventana)
  private keys: string[] = []
  private index = new Map<string, number>()
  private seen: boolean[] = []
  private cpuAcc: number[] = []
  private gpuAcc: number[] = []
  private callAcc: number[] = []
  private triAcc: number[] = []

  // --- ventana de promedios
  private winFrames = 0
  private winGpuFrames = 0
  private winT0 = performance.now()
  private winCpu = 0
  private winGpu = 0
  private winCalls = 0
  private winTris = 0
  private winPoints = 0
  private winLines = 0
  private winRenders = 0

  // --- historial por fotograma (anillo)
  readonly history: FrameRecord[] = Array.from({ length: HISTORY }, () => ({ dt: NaN, cpu: NaN, gpu: NaN, id: -1 }))
  /** índice del último fotograma escrito en `history` */
  head = -1

  /** Envuelve el renderer para contar dibujos y prepara el medidor de GPU. */
  attach(renderer: WebGLRenderer): void {
    const gl = renderer.getContext()
    if (typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext) {
      this.gl = gl
      this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as Ext | null
    }
    const info = renderer.info
    const render = renderer.render.bind(renderer)
    renderer.render = (scene, camera) => {
      render(scene, camera)
      if (!this.active) return
      // renderer.info se pone a cero al empezar cada render: lo que hay es de este
      const r = info.render
      this.winCalls += r.calls
      this.winTris += r.triangles
      this.winPoints += r.points
      this.winLines += r.lines
      this.winRenders++
      if (this.cur >= 0) {
        this.callAcc[this.cur] += r.calls
        this.triAcc[this.cur] += r.triangles
      }
    }
  }

  /**
   * Pone una etiqueta a cada pase del compositor (se envuelve su render, una vez por pase;
   * Graphics rehace alguno al cambiar las nubes, por eso se mira cada fotograma).
   */
  labelPasses(passes: readonly { render: (...a: any[]) => void }[], keyOf: (p: object) => string): void {
    if (!this.active) return
    for (const p of passes) {
      if (wrapped.has(p)) continue
      wrapped.add(p)
      const key = keyOf(p)
      const orig = p.render
      p.render = function (this: unknown, ...a: any[]) {
        perf.mark(key)
        return orig.apply(this, a)
      }
    }
  }

  /** Principio del fotograma (con la marca de tiempo de requestAnimationFrame). */
  beginFrame(raf: number): void {
    // tiempo entre fotogramas: se guarda siempre (la gráfica ya tiene algo al abrirla)
    const dt = this.lastRaf < 0 ? NaN : raf - this.lastRaf
    this.lastRaf = raf
    this.frameId++
    this.head = (this.head + 1) % HISTORY
    const rec = this.history[this.head]
    rec.dt = dt
    rec.cpu = NaN
    rec.gpu = NaN
    rec.id = this.frameId
    if (this.queryOpen) this.endQuery()
    this.active = this.wanted
    if (!this.active) return
    this.frameT0 = performance.now()
    this.cur = -1
    this.frameSec = []
    this.frameQ = []
  }

  /** Cierra la sección en curso y abre `key`. */
  mark(key: string): void {
    if (!this.active) return
    const now = performance.now()
    this.closeSection(now)
    let i = this.index.get(key)
    if (i === undefined) {
      i = this.keys.length
      this.index.set(key, i)
      this.keys.push(key)
      this.seen.push(false)
      this.cpuAcc.push(0)
      this.gpuAcc.push(0)
      this.callAcc.push(0)
      this.triAcc.push(0)
    }
    this.seen[i] = true
    this.cur = i
    this.curT0 = now
    const gl = this.gl
    const ext = this.ext
    if (gl && ext) {
      const q = this.pool.pop() ?? gl.createQuery()
      if (q) {
        gl.beginQuery(ext.TIME_ELAPSED_EXT, q)
        this.queryOpen = true
        this.frameSec.push(i)
        this.frameQ.push(q)
      }
    }
  }

  /** Final del fotograma: cierra la última sección y recoge las lecturas de GPU que hayan llegado. */
  endFrame(): void {
    if (!this.active) return
    const now = performance.now()
    this.closeSection(now)
    this.cur = -1
    const cpu = now - this.frameT0
    this.history[this.head].cpu = cpu
    this.winCpu += cpu
    this.winFrames++
    if (this.frameQ.length) {
      this.pending.push({ id: this.frameId, sec: this.frameSec, q: this.frameQ })
      // sin lecturas durante mucho rato (pestaña oculta…): se tiran las viejas
      while (this.pending.length > 12) this.dropFrame(this.pending.shift()!)
    }
    this.pollGpu()
  }

  /** Medias de la ventana desde la última llamada (y empieza otra). */
  takeWindow(): WindowStats {
    const now = performance.now()
    const n = Math.max(1, this.winFrames)
    const g = this.winGpuFrames
    const sections: SectionStat[] = []
    for (let i = 0; i < this.keys.length; i++) {
      if (!this.seen[i]) continue
      sections.push({
        key: this.keys[i],
        cpu: this.cpuAcc[i] / n,
        gpu: g ? this.gpuAcc[i] / g : NaN,
        calls: this.callAcc[i] / n,
        tris: this.triAcc[i] / n,
      })
    }
    const out: WindowStats = {
      frames: this.winFrames,
      span: now - this.winT0,
      cpu: this.winCpu / n,
      gpu: g ? this.winGpu / g : NaN,
      calls: this.winCalls / n,
      tris: this.winTris / n,
      points: this.winPoints / n,
      lines: this.winLines / n,
      renders: this.winRenders / n,
      sections,
    }
    this.winT0 = now
    this.winFrames = this.winGpuFrames = 0
    this.winCpu = this.winGpu = this.winCalls = this.winTris = this.winPoints = this.winLines = this.winRenders = 0
    this.seen.fill(false)
    this.cpuAcc.fill(0)
    this.gpuAcc.fill(0)
    this.callAcc.fill(0)
    this.triAcc.fill(0)
    return out
  }

  private closeSection(now: number): void {
    if (this.cur >= 0) this.cpuAcc[this.cur] += now - this.curT0
    if (this.queryOpen) this.endQuery()
  }

  private endQuery(): void {
    this.gl!.endQuery(this.ext!.TIME_ELAPSED_EXT)
    this.queryOpen = false
  }

  private pollGpu(): void {
    const gl = this.gl
    const ext = this.ext
    if (!gl || !ext) return
    while (this.pending.length) {
      const f = this.pending[0]
      // las consultas acaban en orden: si la última está, están todas
      if (!gl.getQueryParameter(f.q[f.q.length - 1], gl.QUERY_RESULT_AVAILABLE)) break
      this.pending.shift()
      // «disjoint» = la GPU cambió de reloj o de estado y las medidas no valen
      const bad = Boolean(gl.getParameter(ext.GPU_DISJOINT_EXT))
      let total = 0
      for (let k = 0; k < f.q.length; k++) {
        const ms = bad ? 0 : Number(gl.getQueryParameter(f.q[k], gl.QUERY_RESULT)) / 1e6
        const i = f.sec[k]
        if (i < this.gpuAcc.length) this.gpuAcc[i] += ms
        total += ms
        this.pool.push(f.q[k])
      }
      if (bad) continue
      this.winGpu += total
      this.winGpuFrames++
      const rec = this.history.find((r) => r.id === f.id)
      if (rec) rec.gpu = total
    }
  }

  private dropFrame(f: PendingFrame): void {
    for (const q of f.q) this.gl?.deleteQuery(q)
  }
}

const wrapped = new WeakSet<object>()

export const perf = new Perf()
