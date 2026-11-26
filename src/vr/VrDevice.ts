// El visor, visto desde el simulador: de dónde salen los fotogramas, las vistas de cada ojo y los
// mandos. Dos implementaciones con el mismo recorrido de dibujo:
//  - XrDevice: una sesión WebXR `immersive-vr` (Chrome o Edge con OpenXR en Windows);
//  - ScreenDevice: «VR en pantalla», un visor simulado que dibuja los dos ojos lado a lado en el
//    lienzo (para comprobar y medir la cadena estéreo sin visor; la cabeza se mueve con el ratón).

import {
  Matrix4,
  Mesh,
  NoBlending,
  OrthographicCamera,
  PlaneGeometry,
  Quaternion,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  UnsignedByteType,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three'

/** Un ojo en el espacio de referencia del visor (metros, Y arriba, −Z al frente). */
export interface DeviceEye {
  /** ojo → espacio de referencia */
  matrix: Matrix4
  /** tangentes de los semiángulos del campo de visión: izquierda y abajo negativas */
  left: number
  right: number
  up: number
  down: number
  x: number
  y: number
  w: number
  h: number
}

/** Mando de realidad virtual (disposición `xr-standard`). */
export interface VrPad {
  hand: 'left' | 'right'
  /** palanquita: x a la derecha, y hacia atrás (como un mando de consola) */
  x: number
  y: number
  trigger: number
  squeeze: number
  /** pulsar la palanquita, botón de abajo (A/X) y de arriba (B/Y) */
  click: boolean
  a: boolean
  b: boolean
}

export interface VrDevice {
  readonly kind: 'xr' | 'screen'
  /** tamaño de cada ojo en el búfer (píxeles) */
  readonly eyeW: number
  readonly eyeH: number
  /** frecuencia del visor si se sabe (Hz; 0 = no se sabe) */
  readonly hz: number
  /** Pide el siguiente fotograma del visor. */
  requestFrame(cb: (t: number) => void): void
  /** Vistas de este fotograma; null si el visor no da postura (sin seguimiento, visor quitado). */
  eyes(): DeviceEye[] | null
  /** cabeza → espacio de referencia, del mismo fotograma que `eyes()` */
  readonly head: Matrix4
  /** Búfer del visor para este fotograma. */
  target(renderer: WebGLRenderer): WebGLRenderTarget
  /** Tras dibujar los ojos (la vista en pantalla copia su búfer al lienzo). */
  present(renderer: WebGLRenderer): void
  pads(): VrPad[]
  end(): Promise<void>
  /** se llama cuando la sesión termina, la cierre quien la cierre */
  onEnd: (() => void) | null
}

const _p = new Vector3()
const _q = new Quaternion()
const _q2 = new Quaternion()
const _s = new Vector3(1, 1, 1)

/** Tangentes del campo de visión a partir de la matriz de proyección de una vista de WebXR. */
export function fovTangents(p: ArrayLike<number>): { left: number; right: number; up: number; down: number } {
  return { left: (p[8] - 1) / p[0], right: (p[8] + 1) / p[0], up: (p[9] + 1) / p[5], down: (p[9] - 1) / p[5] }
}

// ---------------------------------------------------------------------------------------------
// Sesión WebXR
// ---------------------------------------------------------------------------------------------

export class XrDevice implements VrDevice {
  readonly kind = 'xr'
  eyeW = 0
  eyeH = 0
  hz = 0
  readonly head = new Matrix4()
  onEnd: (() => void) | null = null
  private frame: XRFrame | null = null
  private readonly rt: WebGLRenderTarget
  private readonly pool: DeviceEye[] = []
  private ended = false
  private readonly session: XRSession
  private readonly layer: XRWebGLLayer
  private readonly space: XRReferenceSpace

  private constructor(session: XRSession, layer: XRWebGLLayer, space: XRReferenceSpace) {
    this.session = session
    this.layer = layer
    this.space = space
    // Un destino de three.js que dibuja en el búfer de la sesión (renderer.setRenderTargetFramebuffer)
    this.rt = new WebGLRenderTarget(layer.framebufferWidth, layer.framebufferHeight, { depthBuffer: false })
    ;(this.rt as unknown as { isXRRenderTarget: boolean }).isXRRenderTarget = true
    this.rt.texture.colorSpace = SRGBColorSpace
    // (hasta el primer fotograma: mitad del búfer para cada ojo)
    this.eyeW = Math.floor(layer.framebufferWidth / 2)
    this.eyeH = layer.framebufferHeight
    this.hz = session.frameRate ?? 0
    session.addEventListener('end', () => {
      this.ended = true
      this.rt.dispose()
      this.onEnd?.()
    })
  }

  /**
   * Abre la sesión (hay que llamarlo desde un gesto del jugador). `scale`: resolución respecto a la
   * que recomienda el visor.
   */
  static async open(renderer: WebGLRenderer, scale: number): Promise<XrDevice> {
    const xr = navigator.xr
    if (!xr) throw new Error('WebXR')
    const session = await xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] })
    try {
      const gl = renderer.getContext() as WebGL2RenderingContext
      // (el contexto se creó sin `xrCompatible`: si el visor cuelga de otra gráfica, aquí se pierde)
      await gl.makeXRCompatible()
      // sin suavizado ni profundidad propios: la imagen llega ya compuesta y suavizada (SMAA)
      const layer = new XRWebGLLayer(session, gl, { antialias: false, depth: false, stencil: false, alpha: false, framebufferScaleFactor: scale })
      await session.updateRenderState({ baseLayer: layer })
      // sentado: origen donde estaba la cabeza al empezar, sin moverse por la habitación
      const space = await session.requestReferenceSpace('local')
      return new XrDevice(session, layer, space)
    } catch (e) {
      void session.end().catch(() => {})
      throw e
    }
  }

  requestFrame(cb: (t: number) => void): void {
    if (this.ended) {
      requestAnimationFrame(cb)
      return
    }
    this.session.requestAnimationFrame((t, frame) => {
      this.frame = frame
      try {
        cb(t)
      } finally {
        this.frame = null
      }
    })
  }

  eyes(): DeviceEye[] | null {
    const pose = this.frame?.getViewerPose(this.space)
    if (!pose) return null
    this.head.fromArray(pose.transform.matrix)
    const out: DeviceEye[] = []
    for (let i = 0; i < pose.views.length && i < 2; i++) {
      const v = pose.views[i]
      const vp = this.layer.getViewport(v)
      if (!vp || vp.width === 0) continue
      const e = (this.pool[i] ??= { matrix: new Matrix4(), left: 0, right: 0, up: 0, down: 0, x: 0, y: 0, w: 0, h: 0 })
      e.matrix.fromArray(v.transform.matrix)
      Object.assign(e, fovTangents(v.projectionMatrix))
      e.x = vp.x
      e.y = vp.y
      e.w = vp.width
      e.h = vp.height
      this.eyeW = vp.width
      this.eyeH = vp.height
      out.push(e)
    }
    return out.length ? out : null
  }

  target(renderer: WebGLRenderer): WebGLRenderTarget {
    // (el búfer de la sesión es opaco y solo vale dentro de su fotograma)
    ;(renderer as unknown as { setRenderTargetFramebuffer(rt: WebGLRenderTarget, fb: WebGLFramebuffer | null): void }).setRenderTargetFramebuffer(this.rt, this.layer.framebuffer)
    return this.rt
  }

  present(): void {}

  pads(): VrPad[] {
    const out: VrPad[] = []
    for (const src of this.session.inputSources) {
      const gp = src.gamepad
      if (!gp || (src.handedness !== 'left' && src.handedness !== 'right')) continue
      // xr-standard: ejes 2 y 3 = palanquita (0 y 1, el panel táctil de los mandos que lo llevan)
      const stick = gp.axes.length >= 4 ? 2 : 0
      out.push({
        hand: src.handedness,
        x: gp.axes[stick] ?? 0,
        y: gp.axes[stick + 1] ?? 0,
        trigger: gp.buttons[0]?.value ?? 0,
        squeeze: gp.buttons[1]?.value ?? 0,
        click: gp.buttons[3]?.pressed ?? false,
        a: gp.buttons[4]?.pressed ?? false,
        b: gp.buttons[5]?.pressed ?? false,
      })
    }
    return out
  }

  async end(): Promise<void> {
    if (!this.ended) await this.session.end().catch(() => {})
  }
}

// ---------------------------------------------------------------------------------------------
// Visor simulado en pantalla
// ---------------------------------------------------------------------------------------------

export interface ScreenDeviceOptions {
  eyeW?: number
  eyeH?: number
  /** separación entre ojos (m) */
  ipd?: number
}

/**
 * Visor simulado: dos ojos con el campo de visión asimétrico de un visor corriente (más abierto
 * hacia fuera y hacia abajo), separados la distancia interpupilar, dibujados lado a lado.
 */
export class ScreenDevice implements VrDevice {
  readonly kind = 'screen'
  readonly eyeW: number
  readonly eyeH: number
  readonly hz = 0
  readonly head = new Matrix4()
  onEnd: (() => void) | null = null
  /** cabeza simulada: guiñada y cabeceo (rad, con el ratón) y posición respecto al origen (m) */
  yaw = 0
  pitch = 0
  readonly pos = new Vector3()
  /** mandos simulados (pruebas) */
  fakePads: VrPad[] = []
  private readonly ipd: number
  private readonly rt: WebGLRenderTarget
  private readonly eyesOut: DeviceEye[]
  private readonly scene = new Scene()
  private readonly cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly quad: Mesh
  private ended = false

  constructor(o: ScreenDeviceOptions = {}) {
    this.eyeW = o.eyeW ?? 1832
    this.eyeH = o.eyeH ?? 1920
    this.ipd = o.ipd ?? 0.064
    this.rt = new WebGLRenderTarget(this.eyeW * 2, this.eyeH, { depthBuffer: false, format: RGBAFormat, type: UnsignedByteType })
    // como el búfer de un visor: recibe la imagen ya codificada en sRGB
    ;(this.rt as unknown as { isXRRenderTarget: boolean }).isXRRenderTarget = true
    this.rt.texture.colorSpace = SRGBColorSpace
    this.rt.texture.internalFormat = 'RGBA8'
    // un visor tipo Quest: 50° hacia fuera, 40° hacia la nariz, 44° arriba y 50° abajo
    const out = Math.tan((50 * Math.PI) / 180)
    const inn = Math.tan((40 * Math.PI) / 180)
    const up = Math.tan((44 * Math.PI) / 180)
    const down = -Math.tan((50 * Math.PI) / 180)
    const eye = (i: number): DeviceEye => ({
      matrix: new Matrix4(),
      left: i === 0 ? -out : -inn,
      right: i === 0 ? inn : out,
      up,
      down,
      x: i * this.eyeW,
      y: 0,
      w: this.eyeW,
      h: this.eyeH,
    })
    this.eyesOut = [eye(0), eye(1)]
    this.quad = new Mesh(
      new PlaneGeometry(2, 2),
      new ShaderMaterial({
        uniforms: { map: { value: this.rt.texture }, k: { value: new Vector2(1, 1) } },
        vertexShader: 'uniform vec2 k; varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy * k, 0.0, 1.0); }',
        fragmentShader: 'uniform sampler2D map; varying vec2 vUv; void main() { gl_FragColor = vec4(texture2D(map, vUv).rgb, 1.0); }',
        depthTest: false,
        depthWrite: false,
        blending: NoBlending,
        toneMapped: false,
      }),
    )
    this.quad.frustumCulled = false
    this.scene.add(this.quad)
  }

  requestFrame(cb: (t: number) => void): void {
    requestAnimationFrame(cb)
  }

  eyes(): DeviceEye[] | null {
    if (this.ended) return null
    _q.setFromAxisAngle(_p.set(0, 1, 0), this.yaw).multiply(_q2.setFromAxisAngle(_p.set(1, 0, 0), this.pitch))
    this.head.compose(this.pos, _q, _s)
    for (let i = 0; i < 2; i++) {
      const e = this.eyesOut[i]
      e.matrix.makeTranslation((i === 0 ? -0.5 : 0.5) * this.ipd, 0, 0).premultiply(this.head)
    }
    return this.eyesOut
  }

  target(): WebGLRenderTarget {
    return this.rt
  }

  /** Copia los dos ojos al lienzo, lado a lado y sin deformar. */
  present(renderer: WebGLRenderer): void {
    const el = renderer.domElement
    const shown = el.clientWidth / Math.max(1, el.clientHeight)
    const image = (2 * this.eyeW) / this.eyeH
    // el lienzo (del tamaño de un ojo) se ve estirado a la ventana: se compensa aquí
    ;((this.quad.material as ShaderMaterial).uniforms.k.value as Vector2).set(Math.min(1, image / shown), Math.min(1, shown / image))
    const prevAuto = renderer.autoClear
    renderer.autoClear = true
    renderer.setRenderTarget(null)
    renderer.setViewport(0, 0, el.width, el.height)
    renderer.setScissorTest(false)
    renderer.render(this.scene, this.cam)
    renderer.autoClear = prevAuto
  }

  pads(): VrPad[] {
    return this.fakePads
  }

  async end(): Promise<void> {
    if (this.ended) return
    this.ended = true
    this.rt.dispose()
    this.quad.geometry.dispose()
    ;(this.quad.material as ShaderMaterial).dispose()
    this.onEnd?.()
  }
}
