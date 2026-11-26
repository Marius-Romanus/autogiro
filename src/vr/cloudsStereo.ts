// Nubes volumétricas en estéreo. La librería las traza a 1/4 de resolución y las reconstruye con
// el fotograma anterior (historial + matrices de la cámara anterior). Con un solo historial para
// los dos ojos, cada ojo reproyectaría la imagen del otro: a lo lejos da igual, pero de cerca
// (dentro de una nube, o con la cabina delante) cada ojo arrastraría el contorno visto desde
// 6 cm más allá. Aquí cada ojo guarda su historial y sus matrices, y los dos usan el mismo número
// de fotograma (el mismo patrón de muestreo: si no, el ruido de cada ojo sería distinto y las
// nubes "hervirían" al fundir las dos imágenes).
//
// Toca campos privados de CloudsEffect / CloudsPass de @takram/three-clouds 0.7.6
// (resolveRenderTarget, historyRenderTarget, previousProjectionMatrix…): si se actualiza la
// librería, revisar; si falta algo de eso, se queda con un solo historial y avisa por consola.

import type { Matrix4, Texture, WebGLRenderTarget } from 'three'

interface History {
  resolve: WebGLRenderTarget
  history: WebGLRenderTarget
  prevProj: Matrix4 | undefined
  prevView: Matrix4 | undefined
}

/** Lo que se usa por dentro de la librería. */
interface CloudsInternals {
  frame: number
  cloudsPass: {
    resolveRenderTarget: WebGLRenderTarget & { shadowLength?: Texture | null; depthVelocity?: Texture | null }
    historyRenderTarget: WebGLRenderTarget & { shadowLength?: Texture | null; depthVelocity?: Texture | null }
    resolveMaterial: { uniforms: Record<string, { value: unknown }> }
    currentMaterial: { previousProjectionMatrix?: Matrix4; previousViewMatrix?: Matrix4 }
  }
  shadowPass: { update: (...a: unknown[]) => void }
  shadowMaps: { update: (...a: unknown[]) => void }
}

const NOOP = (): void => {}

export class CloudsStereo {
  private readonly c: CloudsInternals
  private readonly sets: (History | null)[] = [null, null]
  private frame = 0
  private readonly ok: boolean
  private shadowUpdate: ((...a: unknown[]) => void) | null = null
  private mapsUpdate: ((...a: unknown[]) => void) | null = null

  constructor(clouds: unknown) {
    this.c = clouds as CloudsInternals
    const cp = this.c.cloudsPass
    this.ok = Boolean(
      cp?.resolveRenderTarget?.isWebGLRenderTarget &&
        cp.historyRenderTarget?.isWebGLRenderTarget &&
        cp.resolveMaterial?.uniforms?.colorHistoryBuffer &&
        typeof this.c.frame === 'number',
    )
    if (!this.ok) console.warn('VR: la librería de nubes ha cambiado; los dos ojos comparten el historial de las nubes')
  }

  /** Antes de dibujar el ojo `eye` (0 o 1). */
  begin(eye: number): void {
    if (!this.ok) return
    const c = this.c
    const cp = c.cloudsPass
    const mat = cp.currentMaterial
    if (eye === 0) this.frame = c.frame
    else {
      c.frame = this.frame
      // las cascadas de sombra de las nubes ya están hechas con el primer ojo (y son las mismas)
      if (typeof c.shadowPass?.update === 'function' && typeof c.shadowMaps?.update === 'function') {
        this.shadowUpdate = c.shadowPass.update
        this.mapsUpdate = c.shadowMaps.update
        c.shadowPass.update = NOOP
        c.shadowMaps.update = NOOP
      }
    }
    let s = this.sets[eye]
    if (!s) {
      if (eye === 0) return // el primero usa los búferes de la librería tal como están
      const mk = (src: WebGLRenderTarget): WebGLRenderTarget => Object.assign(src.clone(), { depthVelocity: null, shadowLength: null })
      s = this.sets[eye] = { resolve: mk(cp.resolveRenderTarget), history: mk(cp.historyRenderTarget), prevProj: undefined, prevView: undefined }
    }
    // (la librería solo cambia de tamaño el juego que tiene puesto)
    const w = this.sets[0]?.resolve.width ?? cp.resolveRenderTarget.width
    const h = this.sets[0]?.resolve.height ?? cp.resolveRenderTarget.height
    if (s.resolve.width !== w || s.resolve.height !== h) {
      s.resolve.setSize(w, h)
      s.history.setSize(w, h)
      s.prevProj = s.prevView = undefined
    }
    cp.resolveRenderTarget = s.resolve
    cp.historyRenderTarget = s.history
    const u = cp.resolveMaterial.uniforms
    u.colorHistoryBuffer.value = s.history.texture
    if (u.shadowLengthHistoryBuffer) u.shadowLengthHistoryBuffer.value = null
    mat.previousProjectionMatrix = s.prevProj
    mat.previousViewMatrix = s.prevView
  }

  /** Después de dibujar el ojo `eye`: guarda cómo quedó su historial. */
  end(eye: number): void {
    if (!this.ok) return
    const c = this.c
    const cp = c.cloudsPass
    if (this.shadowUpdate && this.mapsUpdate) {
      c.shadowPass.update = this.shadowUpdate
      c.shadowMaps.update = this.mapsUpdate
      this.shadowUpdate = this.mapsUpdate = null
    }
    const mat = cp.currentMaterial
    const s = (this.sets[eye] ??= { resolve: cp.resolveRenderTarget, history: cp.historyRenderTarget, prevProj: undefined, prevView: undefined })
    s.resolve = cp.resolveRenderTarget
    s.history = cp.historyRenderTarget
    s.prevProj = mat.previousProjectionMatrix
    s.prevView = mat.previousViewMatrix
  }

  /** Al salir: la librería se queda con el juego del primer ojo y el del segundo se libera. */
  dispose(): void {
    if (!this.ok) return
    const cp = this.c.cloudsPass
    const a = this.sets[0]
    const b = this.sets[1]
    if (a) {
      cp.resolveRenderTarget = a.resolve
      cp.historyRenderTarget = a.history
      cp.resolveMaterial.uniforms.colorHistoryBuffer.value = a.history.texture
      cp.currentMaterial.previousProjectionMatrix = a.prevProj
      cp.currentMaterial.previousViewMatrix = a.prevView
    }
    if (b) {
      b.resolve.dispose()
      b.history.dispose()
    }
    this.sets[0] = this.sets[1] = null
  }
}
