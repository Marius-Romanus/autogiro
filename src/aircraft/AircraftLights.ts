// Luces exteriores del aparato: navegación (roja a la izquierda, verde a la
// derecha, blanca en la cola), destellos anticolisión blancos (puntas del
// estabilizador y lo alto de la deriva) y foco de aterrizaje en el morro.
//
// Las posiciones se sacan de la geometría del modelo cargado (puntas del
// estabilizador, cola, parte alta de la deriva y morro), así sirven para
// cualquier aparato del catálogo sin fichas a mano.
//
// Render: cada luz es un punto con tamaño mínimo en píxeles que escribe su
// radiancia (HDR, el bloom hace el halo) y alfa = 0 ("ya iluminado", ver la
// máscara de iluminación en Graphics.ts); un halo semitransparente sobre el
// terreno se multiplicaría por la luz del sol en posproceso y de noche no se vería.

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Matrix4,
  Mesh,
  NoBlending,
  Object3D,
  Points,
  ShaderMaterial,
  SpotLight,
  Vector2,
  Vector3,
  type Camera,
  type WebGLRenderer,
} from 'three'
import { OVERLAY_LAYER } from '../render/Graphics.ts'
import type { GroundBeam } from '../render/LandingLightEffect.ts'
import { viewerLight } from '../render/SunShadows.ts'

const DEG = Math.PI / 180

/**
 * Haz del foco de aterrizaje: semiapertura, penumbra, inclinación hacia abajo e intensidades
 * (ya expuestas). El terreno usa una intensidad mayor con compresión (`groundKnee`, ver
 * LandingLightEffect): imita al ojo adaptado a la noche, que la exposición fija no tiene.
 * Aparato, edificios y árboles reciben la del SpotLight, sin comprimir. De día (sol alto) todo
 * recibe la intensidad física (`realCandela`, sin exposición ni compresión), en la misma escala
 * que el sol: con sol el foco apenas se nota. (Antes de día se usaba `candela` ya expuesta, unas
 * 30 000 veces el valor físico: dejaba un chorro blanco en la pista delante del morro.)
 */
export const BEAM = {
  angle: 15 * DEG,
  penumbra: 0.75,
  down: 4 * DEG,
  candela: 1e5,
  groundCandela: 2.5e6,
  groundKnee: 0.5,
  /** foco LED de aterrizaje real, en candelas */
  realCandela: 1e5,
}

/**
 * Lux por unidad de iluminancia de la escena: takram guarda la luminancia relativa a la del sol
 * con radiancia unidad (LUMINANCE_COEFFS · sunRadianceToLuminance de AtmosphereParameters).
 * El sol de mediodía da ~1,3 unidades (~100 000 lux).
 */
const LUX_PER_UNIT = 75718

type Kind = 'navL' | 'navR' | 'tail' | 'strobeL' | 'strobeR' | 'beacon' | 'landing'

interface Lamp {
  kind: Kind
  pos: Vector3
  color: Color
  /** brillo máximo ya expuesto (≈1 = blanco de la imagen; más alto quema y da halo) */
  power: number
  /** tamaño real de la lente (m) y mínimo en píxeles */
  size: number
  minPx: number
}

/** Piezas que no cuentan para situar las luces. */
const SKIP = /^(rotor|rotor_head|prop|wheel_L|wheel_R|nose_wheel|pilot_front|pilot_rear|stick|eye_front)$/

const _m = new Matrix4()
const _inv = new Matrix4()
const _v = new Vector3()
const _cam = new Vector3()
const _size = new Vector2()

export class AircraftLights {
  readonly points: Points
  private readonly geo = new BufferGeometry()
  private readonly mat: ShaderMaterial
  private lamps: Lamp[] = []
  private t = 0
  on = false
  /**
   * Luz real del foco para los materiales iluminados (aparato, edificios, árboles);
   * el terreno lo alumbra LandingLightEffect. Se queda siempre en la escena (intensidad 0
   * si está apagada): quitarla o ponerla cambia el número de luces y recompila todos los materiales.
   */
  readonly spot = new SpotLight(0xfff4e6, 0, 0, BEAM.angle, BEAM.penumbra, 2)
  /**
   * false en los aparatos de otros pilotos: sin SpotLight (cada uno que entra o sale de la
   * escena recompilaría todos los materiales); su foco solo alumbra el terreno.
   */
  useSpot = true
  /** haz sobre el terreno (mundo) para LandingLightEffect; intensity 0 = apagado */
  readonly beam: GroundBeam = { pos: new Vector3(), dir: new Vector3(1, 0, 0), intensity: 0 }
  /** rodilla de la compresión del haz sobre el terreno (unidades de escena) */
  knee = 1
  private hasLanding = false
  private readonly landingPos = new Vector3()
  private readonly landingDir = new Vector3()

  constructor() {
    this.mat = new ShaderMaterial({
      uniforms: { viewportH: { value: 720 }, gain: { value: 0.1 } },
      vertexShader: /* glsl */ `
        attribute vec3 lampColor;
        attribute vec2 lampSize; // tamaño real (m), mínimo (px)
        uniform float viewportH;
        uniform float gain; // 1 / exposición
        varying vec3 vColor;
        #include <common>
        #include <logdepthbuf_pars_vertex>
        void main() {
          vColor = lampColor * gain;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          float px = lampSize.x * projectionMatrix[1][1] * 0.5 * viewportH / max(-mvPosition.z, 1e-3);
          // apagada o casi: tamaño 0 (no se dibuja). La lente tapa el fondo por completo y,
          // de día, una casi apagada saldría como un punto oscuro sobre el cielo.
          gl_PointSize = max(lampColor.r, max(lampColor.g, lampColor.b)) > 0.6 ? max(px, lampSize.y) : 0.0;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        #include <common>
        #include <logdepthbuf_pars_fragment>
        void main() {
          #include <logdepthbuf_fragment>
          vec2 d = gl_PointCoord - 0.5;
          if (dot(d, d) > 0.25) discard;
          gl_FragColor = vec4(vColor, 0.0);
        }`,
      // opaca y alfa 0: el píxel es la lente encendida, ya "iluminada"
      blending: NoBlending,
      depthWrite: true,
      depthTest: true,
    })
    this.points = new Points(this.geo, this.mat)
    this.points.name = 'aircraft_lights'
    this.points.frustumCulled = false
    this.points.renderOrder = 4
    // fuera del pase de normales (ver OVERLAY_LAYER)
    this.points.layers.set(OVERLAY_LAYER)
    this.points.visible = false
    this.spot.castShadow = false
    this.spot.name = 'landing_light'
    this.spot.target.name = 'landing_light_target'
    this.points.onBeforeRender = (renderer: WebGLRenderer) => {
      renderer.getDrawingBufferSize(_size)
      this.mat.uniforms.viewportH.value = _size.y
      // brillos en unidades ya expuestas: el mismo color con cualquier exposición
      this.mat.uniforms.gain.value = 1 / Math.max(renderer.toneMappingExposure, 1e-3)
    }
  }

  /** Coloca las luces en el modelo recién cargado (`scene`, hijo de `parent`). */
  attach(parent: Object3D, scene: Object3D): void {
    this.points.removeFromParent()
    this.lamps = findLamps(scene)
    const n = this.lamps.length
    const pos = new Float32Array(n * 3)
    this.lamps.forEach((l, i) => l.pos.toArray(pos, i * 3))
    this.geo.setAttribute('position', new BufferAttribute(pos, 3))
    this.geo.setAttribute('lampColor', new BufferAttribute(new Float32Array(n * 3), 3))
    const size = new Float32Array(n * 2)
    this.lamps.forEach((l, i) => {
      size[i * 2] = l.size
      size[i * 2 + 1] = l.minPx
    })
    this.geo.setAttribute('lampSize', new BufferAttribute(size, 2))
    this.geo.setDrawRange(0, n)
    parent.add(this.points)
    const landing = this.lamps.find((l) => l.kind === 'landing')
    this.hasLanding = Boolean(landing)
    if (landing) {
      this.landingPos.copy(landing.pos)
      this.landingDir.set(Math.cos(BEAM.down), -Math.sin(BEAM.down), 0)
      this.spot.position.copy(landing.pos)
      this.spot.target.position.copy(landing.pos).add(this.landingDir)
      if (this.useSpot) parent.add(this.spot, this.spot.target)
    }
  }

  detach(): void {
    this.points.removeFromParent()
    this.spot.removeFromParent()
    this.spot.target.removeFromParent()
    this.lamps = []
    this.hasLanding = false
  }

  /**
   * Brillo de cada luz según el sector desde el que se mira y los destellos, y el haz del
   * foco (`exposure`: la del render, para dar la intensidad en unidades de escena;
   * `sunY`: seno de la altura del sol, para pasar de la luz "adaptada" de noche a la física de día).
   */
  update(dt: number, camera: Camera, exposure: number, sunY = -1): void {
    this.t += dt
    this.points.visible = this.on && this.lamps.length > 0
    const on = this.on && this.hasLanding
    const ex = Math.max(exposure, 1e-3)
    // Del foco físico (pleno sol) al adaptado de noche según la luz ambiente que hay en el
    // aparato (nubes y sombras incluidas); sin ese dato, según la altura del sol (−6° a 3°).
    // Interpolación geométrica: los dos extremos se llevan cinco órdenes de magnitud.
    const p = phys()
    const night = BEAM.groundCandela / ex
    const amb = viewerLight.illuminance
    const k = amb >= 0 ? adaptation(amb * LUX_PER_UNIT, night / p) : 1 - smoothstep(-0.1, 0.05, sunY)
    this.spot.intensity = on ? geo(p, BEAM.candela / ex, k) : 0
    const b = this.beam
    b.intensity = on && shown(this.points.parent) ? geo(p, night, k) : 0
    // compresión siempre con la rodilla de noche: con el foco físico (de día) no llega a
    // actuar, y en la transición no deja que la mancha queme antes de que oscurezca
    this.knee = BEAM.groundKnee / ex
    if (b.intensity > 0) {
      this.points.updateWorldMatrix(true, false)
      const m = this.points.matrixWorld
      b.pos.copy(this.landingPos).applyMatrix4(m)
      b.dir.copy(this.landingDir).transformDirection(m)
    }
    if (!this.points.visible) return
    // cámara en los ejes del modelo (x adelante, y arriba, z derecha)
    this.points.updateWorldMatrix(true, false)
    _inv.copy(_m.copy(this.points.matrixWorld)).invert()
    camera.getWorldPosition(_cam).applyMatrix4(_inv)
    const col = this.geo.getAttribute('lampColor') as BufferAttribute
    const arr = col.array as Float32Array
    // destellos: doble destello de las puntas cada 1,2 s, el de la deriva desfasado
    const ph = this.t % 1.2
    const tipFlash = ph < 0.05 || (ph > 0.14 && ph < 0.19) ? 1 : 0
    const ph2 = (this.t + 0.6) % 1.2
    const finFlash = ph2 < 0.06 ? 1 : 0
    this.lamps.forEach((l, i) => {
      _v.copy(_cam).sub(l.pos)
      const dist = _v.length()
      _v.divideScalar(Math.max(dist, 1e-6))
      // azimut horizontal desde la luz hacia la cámara: 0 = proa, + = derecha
      const az = Math.atan2(_v.z, _v.x) / DEG
      let k = 0
      switch (l.kind) {
        case 'navL':
          k = sector(-az, -2, 110)
          break
        case 'navR':
          k = sector(az, -2, 110)
          break
        case 'tail':
          k = sector(Math.abs(az), 110, 182)
          break
        case 'strobeL':
        case 'strobeR':
          k = tipFlash
          break
        case 'beacon':
          k = finFlash
          break
        case 'landing': {
          // haz de ~±12° con caída suave hasta ~40°
          const off = Math.acos(Math.min(1, Math.max(-1, _v.x))) / DEG
          k = off < 12 ? 1 : off < 40 ? 0.04 + 0.96 * Math.pow(1 - (off - 12) / 28, 3) : 0.03 * Math.max(0, _v.x)
          break
        }
      }
      const c = k * l.power
      arr[i * 3] = l.color.r * c
      arr[i * 3 + 1] = l.color.g * c
      arr[i * 3 + 2] = l.color.b * c
    })
    col.needsUpdate = true
  }
}

/** foco físico en unidades de escena (sin exposición): a pleno sol apenas se nota */
const phys = () => BEAM.realCandela / LUX_PER_UNIT

/**
 * Adaptación del ojo según la luz ambiente (lux), que la exposición fija no tiene: 0 = foco
 * físico, 1 = foco adaptado de noche (`nightGain` veces el físico). El aumento es ×40 de pleno
 * sol (100 000 lux) a nublado (40 000 lux), para que la mancha delante del morro se note, y
 * luego crece con la oscuridad (×8 por cada década menos de luz) hasta el de noche.
 * Medido en el simulador (LEMT, 20 de mayo): sol de mediodía ~96 000 lux (×1), cubierto a
 * mediodía ~42 000 (×40), a las 20:48 ~7 000 (×190), puesta de sol ~420 (×2400, ya se ve bien),
 * noche ≲ 1 lux (adaptado del todo).
 */
function adaptation(lux: number, nightGain: number): number {
  const l = Math.max(lux, 1e-6)
  const lg = 1.6 * smoothstep(0, 1, Math.log10(1e5 / l) / Math.log10(1e5 / 4e4)) + 0.9 * Math.max(0, Math.log10(4e4 / l))
  return Math.min(1, lg / Math.log10(Math.max(nightGain, 10)))
}
/** interpolación geométrica (a, b > 0) */
const geo = (a: number, b: number, t: number) => a * Math.pow(b / a, t)

/** El objeto está en la escena y se dibuja (él y todos sus padres visibles). */
function shown(o: Object3D | null): boolean {
  if (!o) return false
  for (let p: Object3D | null = o; p; p = p.parent) if (!p.visible) return false
  return true
}
function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** 1 dentro de [a, b] (grados), con bordes suaves de 4°. */
function sector(x: number, a: number, b: number): number {
  const s = (u: number) => Math.min(1, Math.max(0, u))
  return s((x - a) / 4 + 0.5) * s((b - x) / 4 + 0.5)
}

// Con ACES los colores saturados muy brillantes viran (rojo → naranja, verde → amarillo
// pálido): las de navegación van justo por debajo del blanco para que sigan siendo rojo y verde.
const RED = new Color(1, 0, 0)
const GREEN = new Color(0, 1, 0.3)
const WHITE = new Color(1, 0.96, 0.9)
const STROBE = new Color(0.92, 0.95, 1)

/** Busca en la geometría del modelo dónde van las luces (coordenadas de `scene`). */
function findLamps(scene: Object3D): Lamp[] {
  scene.updateMatrixWorld(true)
  _inv.copy(scene.matrixWorld).invert()
  const pts: number[] = []
  const visit = (o: Object3D) => {
    if (o !== scene && SKIP.test(o.name)) return
    const m = o as Mesh
    if (m.isMesh) {
      const mats = Array.isArray(m.material) ? m.material : [m.material]
      const glass = mats.some((x) => x.transparent || /glass/i.test(x.name))
      const p = m.geometry.getAttribute('position')
      if (!glass && p) {
        _m.multiplyMatrices(_inv, m.matrixWorld)
        for (let i = 0; i < p.count; i++) {
          _v.fromBufferAttribute(p, i).applyMatrix4(_m)
          pts.push(_v.x, _v.y, _v.z)
        }
      }
    }
    for (const c of o.children) visit(c)
  }
  visit(scene)
  if (pts.length === 0) return []

  let xMin = Infinity
  let xMax = -Infinity
  for (let i = 0; i < pts.length; i += 3) {
    xMin = Math.min(xMin, pts[i])
    xMax = Math.max(xMax, pts[i])
  }
  // cola: el último metro; ahí están el estabilizador (y sus derivas) y la deriva central
  const tailX = xMin + 1.0
  const left = new Vector3(0, 0, Infinity)
  const right = new Vector3(0, 0, -Infinity)
  const tail = new Vector3(Infinity, 0, 0)
  const top = new Vector3(0, -Infinity, 0)
  const nose = new Vector3(-Infinity, 0, 0)
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i]
    const y = pts[i + 1]
    const z = pts[i + 2]
    if (x < tailX) {
      if (z < left.z) left.set(x, y, z)
      if (z > right.z) right.set(x, y, z)
      if (Math.abs(z) < 0.2) {
        if (x < tail.x) tail.set(x, y, z)
        if (y > top.y) top.set(x, y, z)
      }
    }
    if (Math.abs(z) < 0.25 && x > nose.x) nose.set(x, y, z)
  }

  const lamps: Lamp[] = []
  const add = (kind: Kind, pos: Vector3, color: Color, power: number, size: number, minPx: number) =>
    lamps.push({ kind, pos, color, power, size, minPx })
  const out = 0.035 // lentes un poco por fuera de la superficie (que no las tape la profundidad)
  if (isFinite(left.z) && isFinite(right.z) && right.z - left.z > 0.3) {
    add('navL', left.clone().add(_v.set(0, 0, -out)), RED, 0.9, 0.05, 3)
    add('navR', right.clone().add(_v.set(0, 0, out)), GREEN, 0.65, 0.05, 3)
    add('strobeL', left.clone().add(_v.set(-0.06, 0, -out)), STROBE, 40, 0.07, 4)
    add('strobeR', right.clone().add(_v.set(-0.06, 0, out)), STROBE, 40, 0.07, 4)
  }
  if (isFinite(tail.x)) add('tail', tail.clone().add(_v.set(-out, 0, 0)), WHITE, 1.2, 0.045, 3)
  if (isFinite(top.y)) add('beacon', top.clone().add(_v.set(0, out, 0)), STROBE, 25, 0.06, 3.5)
  if (isFinite(nose.x) && nose.x > xMin + 1) add('landing', nose.clone().add(_v.set(out, 0, 0)), WHITE, 30, 0.09, 3)
  return lamps
}
