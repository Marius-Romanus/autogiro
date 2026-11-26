// Lluvia y nieve alrededor de la cámara: rayas (gotas alargadas por la velocidad relativa durante el
// tiempo de exposición del ojo) y copos, en un volumen que acompaña a la cámara y se repite. Cada
// partícula cae a su velocidad terminal, la lleva el viento y se ve pasar con la velocidad del
// aparato: en vuelo las rayas vienen casi de frente.
//
// Es un pase propio DESPUÉS del efecto de atmósfera: dibujadas en la escena, el posproceso las
// iluminaría como si fueran terreno y les pondría la niebla de lo que tienen detrás (justo cuando
// llueve no se verían). Como ahí ya no hay búfer de profundidad de la escena, cada fragmento compara
// su distancia con la textura de profundidad (logarítmica) y se descarta si hay algo delante.

import {
  DoubleSide,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  type PerspectiveCamera,
  type Texture,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three'
import { Pass } from 'postprocessing'
import type { Quality } from '../config.ts'

const MAX = 16000
/** lado del volumen que se repite (m) */
const BOX = 28
const COUNT: Record<Quality, number> = { low: 3500, medium: 7000, high: 11000, ultra: MAX }

export interface PrecipFrame {
  /** intensidad visual 0..1 y fracción de nieve 0..1 a la altura de la cámara */
  amount: number
  snow: number
  /** velocidad terminal de las gotas (m/s) */
  fall: number
  /** viento en la cámara (mundo, m/s) */
  wind: Vector3
  /** radiancia de una superficie blanca con la luz ambiente (ya en unidades de escena) */
  light: Vector3
  /** distancia mínima a la que se dibujan (m): dentro de una cabina cerrada no llueve */
  near: number
}

export class PrecipitationPass extends Pass {
  private readonly cam: PerspectiveCamera
  /** escena del pase: las partículas y lo que se quiera dibujar con ellas (gotas en los vidrios) */
  readonly world = new Scene()
  private readonly drops: Mesh
  /** hay algo más que dibujar aunque no caiga nada (vidrios mojados) */
  extra = false
  private readonly geo: InstancedBufferGeometry
  private readonly mat: ShaderMaterial
  private readonly offR = new Vector3()
  private readonly offS = new Vector3()
  private readonly prevCam = new Vector3()
  private readonly camVel = new Vector3()
  private hasPrev = false
  private time = 0
  private quality: Quality = 'high'
  private amount = 0

  constructor(camera: PerspectiveCamera) {
    super('PrecipitationPass')
    this.cam = camera
    this.needsSwap = false
    this.needsDepthTexture = true
    this.enabled = false

    const quad = new PlaneGeometry(1, 1)
    const geo = new InstancedBufferGeometry()
    geo.index = quad.index
    geo.setAttribute('position', quad.getAttribute('position'))
    const seed = new Float32Array(MAX * 4)
    // (aleatorio con semilla fija: el mismo dibujo en cada arranque)
    let r = 12345
    for (let i = 0; i < seed.length; i++) {
      r = (Math.imul(r, 1664525) + 1013904223) >>> 0
      seed[i] = r / 4294967296
    }
    geo.setAttribute('seed', new InstancedBufferAttribute(seed, 4))
    geo.instanceCount = 0
    this.geo = geo

    this.mat = new ShaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
      uniforms: {
        depthBuffer: { value: null as Texture | null },
        resolution: { value: new Vector2(1, 1) },
        cameraFar: { value: camera.far },
        uOffR: { value: this.offR },
        uOffS: { value: this.offS },
        uDirR: { value: new Vector3(0, -1, 0) },
        uDirS: { value: new Vector3(0, -1, 0) },
        uLen: { value: new Vector2(0.3, 0.02) },
        uSnow: { value: 0 },
        uPx: { value: 0.001 },
        uNear: { value: 0.4 },
        uTime: { value: 0 },
        uColor: { value: new Vector3(1, 1, 1) },
        uOpacity: { value: 0.3 },
      },
      vertexShader: /* glsl */ `
        attribute vec4 seed;
        uniform vec3 uOffR, uOffS, uDirR, uDirS;
        uniform vec2 uLen;
        uniform float uSnow, uPx, uNear, uTime;
        varying vec2 vUv;
        varying float vDepth;
        varying float vFade;
        varying float vFlake;
        void main() {
          float flake = step(seed.w, uSnow);
          vec3 c = (fract(seed.xyz - mix(uOffR, uOffS, flake)) - 0.5) * ${BOX.toFixed(1)};
          // los copos revolotean
          c.xz += flake * 0.12 * vec2(sin(uTime * 1.7 + seed.w * 97.0), cos(uTime * 1.3 + seed.x * 61.0));
          float dist = length(c);
          vec3 dir = mix(uDirR, uDirS, flake);
          vec3 side = cross(dir, c);
          side = dot(side, side) > 1e-8 ? normalize(side) : vec3(1.0, 0.0, 0.0);
          // gota de ~2 mm, copo de ~8 mm; nunca más fina que un píxel (se compensa en opacidad)
          float w0 = mix(0.0022, 0.008, flake) * (0.7 + 0.6 * seed.y);
          float len = max(mix(uLen.x, uLen.y, flake) * (0.8 + 0.4 * seed.z), w0);
          // ancho de al menos un píxel en CADA extremo (una raya que viene de frente tiene una punta
          // mucho más cerca que la otra) y distancia mínima de la raya entera a la cámara
          vec3 axis = c + dir * (position.y * len);
          float w = max(w0, length(axis) * uPx * 1.25);
          vec3 p = axis + side * (position.x * w);
          dist = length(c - dir * clamp(dot(c, dir), -0.5 * len, 0.5 * len));
          vec4 mv = viewMatrix * vec4(p + cameraPosition, 1.0);
          vDepth = -mv.z;
          vUv = position.xy * 2.0;
          vFlake = flake;
          vFade = sqrt(w0 / w) * smoothstep(uNear, uNear * 1.5 + 0.3, dist) * (1.0 - smoothstep(${(BOX * 0.38).toFixed(1)}, ${(BOX * 0.5).toFixed(1)}, dist));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D depthBuffer;
        uniform vec2 resolution;
        uniform float cameraFar;
        uniform vec3 uColor;
        uniform float uOpacity;
        varying vec2 vUv;
        varying float vDepth;
        varying float vFade;
        varying float vFlake;
        void main() {
          // profundidad logarítmica de la escena → distancia de vista
          float d = texture2D(depthBuffer, gl_FragCoord.xy / resolution).r;
          if (vDepth > pow(cameraFar + 1.0, d) - 1.0) discard;
          float across = 1.0 - vUv.x * vUv.x;
          float along = mix(1.0 - vUv.y * vUv.y * vUv.y * vUv.y, 1.0 - vUv.y * vUv.y, vFlake);
          float a = across * along * vFade * mix(uOpacity, 0.9, vFlake);
          if (a < 0.004) discard;
          // (las gotas brillan algo más que el velo gris de fondo: reflejan el cielo entero)
          gl_FragColor = vec4(uColor * mix(1.6, 1.15, vFlake), a);
        }`,
    })
    this.drops = new Mesh(geo, this.mat)
    this.drops.frustumCulled = false
    this.world.add(this.drops)
  }

  setQuality(q: Quality): void {
    this.quality = q
  }

  override setDepthTexture(depthTexture: Texture): void {
    this.mat.uniforms.depthBuffer.value = depthTexture
  }

  /** textura de profundidad de la escena y tamaño del búfer, para quien dibuje en este pase */
  get depth(): { depthBuffer: Texture | null; resolution: Vector2; cameraFar: number } {
    const u = this.mat.uniforms
    return { depthBuffer: u.depthBuffer.value, resolution: u.resolution.value, cameraFar: this.cam.far }
  }

  override setSize(width: number, height: number): void {
    this.mat.uniforms.resolution.value.set(width, height)
  }

  /** Mueve el campo de partículas. Llamar una vez por fotograma, con la cámara ya colocada. */
  update(dt: number, f: PrecipFrame): void {
    this.amount = f.amount
    this.drops.visible = f.amount > 0.01
    this.enabled = this.drops.visible || this.extra
    const cam = this.cam
    // velocidad de la cámara en el mundo (un salto grande es un cambio de origen o de vista)
    if (this.hasPrev && dt > 1e-4) {
      _v.copy(cam.position).sub(this.prevCam).divideScalar(dt)
      if (_v.lengthSq() < 150 * 150) this.camVel.lerp(_v, Math.min(1, dt * 12))
    }
    this.prevCam.copy(cam.position)
    this.hasPrev = true
    if (!this.drops.visible) return
    this.time += dt
    const u = this.mat.uniforms
    // lluvia y nieve: cada una con su caída
    const step = (off: Vector3, fall: number, dir: Vector3, exposure: number): number => {
      _v.copy(f.wind)
      _v.y -= fall
      _v.sub(this.camVel)
      off.addScaledVector(_v, -dt / BOX)
      off.set(off.x - Math.floor(off.x), off.y - Math.floor(off.y), off.z - Math.floor(off.z))
      const sp = _v.length()
      if (sp > 1e-3) dir.copy(_v).divideScalar(sp)
      return Math.min(3, sp * exposure)
    }
    // (1/30 s: lo que tarda el ojo en integrar; los copos, de cerca, se ven casi quietos)
    u.uLen.value.set(step(this.offR, f.fall, u.uDirR.value, 1 / 30), step(this.offS, 1.3, u.uDirS.value, 1 / 90))
    u.uSnow.value = f.snow
    u.uTime.value = this.time
    u.uNear.value = f.near
    u.uPx.value = (2 * Math.tan((cam.fov * Math.PI) / 360)) / Math.max(1, u.resolution.value.y)
    u.cameraFar.value = cam.far
    u.uColor.value.copy(f.light)
    u.uOpacity.value = 0.42
    this.geo.instanceCount = Math.round(COUNT[this.quality] * Math.min(1, 0.25 + 0.75 * f.amount))
  }

  override render(renderer: WebGLRenderer, inputBuffer: WebGLRenderTarget): void {
    const autoClear = renderer.autoClear
    renderer.autoClear = false
    renderer.setRenderTarget(this.renderToScreen ? null : inputBuffer)
    renderer.render(this.world, this.cam)
    renderer.autoClear = autoClear
  }
}

const _v = new Vector3()
