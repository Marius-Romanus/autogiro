// Representación visual del autogiro: carga el GLB hecho en Blender y anima
// sus piezas a partir del estado del modelo de vuelo.

import {
  AdditiveBlending,
  BoxGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  SphereGeometry,
  Vector3,
  type Texture,
} from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { CG, GEOM } from '../sim/autogyro.ts'
import { GENERIC, type Airframe, type RetractGearSpec } from '../sim/airframes.ts'
import { keepAlpha, LIGHT_LAYER, OVERLAY_LAYER } from '../render/Graphics.ts'
import { Cockpit } from './Cockpit.ts'
import { AircraftLights } from './AircraftLights.ts'
import { PilotRig } from './PilotRig.ts'
import { BladeDisc } from './BladeDisc.ts'
import { applyAircraftWear } from './AircraftWear.ts'

export const SHADOW_ONLY_LAYER = 11

/**
 * Lo que la vista necesita para posar y animar el modelo. Lo cumple el `Autogyro`
 * propio y también los aparatos de otros pilotos (src/net/RemoteAircraft.ts).
 */
export interface AircraftPose {
  readonly pos: Vector3
  readonly quat: Quaternion
  readonly vel: Vector3
  /** buje respecto al CG, ejes cuerpo */
  readonly hubBody: Vector3
  readonly rotor: { readonly omega: number; readonly rpm: number; readonly normal: Vector3 }
  readonly headPitch: number
  readonly headRoll: number
  readonly rudder: number
  readonly noseSteer: number
  readonly engineRpm: number
  readonly onGround: boolean
  /** desplazamiento del CG respecto al común (asientos lado a lado con un solo ocupante) */
  readonly cgOff?: Vector3
  /** tren de unos flotadores anfibios: 1 abajo, 0 recogido (si falta, abajo) */
  readonly gearPos?: number
}
/** Mandos que mueve la vista (`Controls` del propio aparato; los remotos mandan solo parte). */
export interface ViewControls {
  pitch: number
  roll: number
  /** pedales −1..1 (si falta, se deduce de la rueda de morro) */
  yaw?: number
  throttle?: number
  wheelBrake?: number
  prerotator?: boolean
}

const DEG = Math.PI / 180
/** recorrido de la palanca de gas (ralentí dibujado atrás → todo gas adelante); blender/controls.py */
const THROTTLE_TRAVEL = 50 * DEG
/** giro de cada pedal sobre su bisagra con el pie a fondo (~3 cm en la planta) */
const PEDAL_TRAVEL = 18 * DEG
/** giro del reposapiés del Cierva sobre su pivote */
const FOOT_BAR_TRAVEL = 15 * DEG
/** la rueda de morro gira 22° con el pedal a fondo (src/sim/autogyro.ts) */
const NOSE_STEER_MAX = 22 * DEG
/**
 * Columna colgante del Cierva: giro visual frente a la inclinación de la cabeza. Con la mano en
 * el recorrido completo de la cabeza la columna atravesaba el tablero y el marco del parabrisas
 * (comprobado en Blender barriendo su recorrido), así que se mueve algo menos que la cabeza.
 */
const HANGING_PITCH = 0.6
const HANGING_ROLL = 0.8
const Y = new Vector3(0, 1, 0)
const X = new Vector3(1, 0, 0)
const Z = new Vector3(0, 0, 1)
const ZERO = new Vector3()
const _q = new Quaternion()
const _q2 = new Quaternion()
const _v = new Vector3()

interface Parts {
  rotor?: Object3D
  rotor_head?: Object3D
  prop?: Object3D
  rudder?: Object3D
  nose_wheel?: Object3D
  wheel_L?: Object3D
  wheel_R?: Object3D
  stick?: Object3D
  throttle?: Object3D
  throttle_brake?: Object3D
  brake_lever?: Object3D
  starter_lever?: Object3D
  pedal_L?: Object3D
  pedal_R?: Object3D
  foot_bar?: Object3D
  /** profundidad y alerones (Cierva C.19): giran sobre su bisagra con la palanca */
  elevator?: Object3D
  aileron_L?: Object3D
  aileron_R?: Object3D
  pilot_front?: Object3D
  pilot_rear?: Object3D
  eye_front?: Object3D
}

export class AircraftView {
  /** raíz: en la posición/orientación del CG */
  readonly root = new Group()
  /** modelo desplazado −CG */
  readonly model = new Group()
  parts: Parts = {}
  /** discos de las palas en giro (rotor y hélice): ver BladeDisc.ts */
  private rotorDisc!: BladeDisc
  private propDisc!: BladeDisc
  private rotorAngle = 0
  private propAngle = 0
  private wheelAngle = 0
  readonly eyeLocal = new Vector3(0.7 - CG.x, 0.47 - CG.y, 0)
  loaded = false
  private rotorRest = new Vector3()

  constructor() {
    this.root.add(this.model)
    this.model.position.copy(CG).negate()
    this.makeBlurDiscs()
  }

  private loadToken = 0
  private cockpitView = false
  /** hilo de guiñada y panel de instrumentos vivo */
  readonly cockpit = new Cockpit()
  /** luces de navegación, destellos y foco de aterrizaje */
  readonly lights = new AircraftLights()
  private modelKey = ''
  /** boquillas de fumigación del modelo (nodos `spray_NN`, Gyro Tractor); vacío si no lleva */
  sprayNozzles: Object3D[] = []
  /**
   * Timones de derivas inclinadas (nodos `rudder_L`, `rudder_R`… del Sigilo): cada uno gira sobre su
   * propio eje Y local (la bisagra), partiendo de la inclinación de su deriva (`rest`).
   */
  private extraRudders: { o: Object3D; rest: Quaternion }[] = []
  /** materiales `Plasma_Glow` (propulsor del Sigilo): su brillo sigue al gas */
  private glow: { m: MeshStandardMaterial; base: number }[] = []
  private readonly cgOff = new Vector3()
  private glassMeshes: Mesh[] = []
  /** vidrios del modelo (gotas de lluvia: fx/GlassRain.ts) */
  get glass(): readonly Mesh[] {
    return this.glassMeshes
  }
  /** ruedas de unos flotadores anfibios (`amph_main_L`…, floatKit.ts): suben `gearRetract` m al recogerlas */
  private amphWheels: { o: Object3D; rest: Vector3; main: boolean }[] = []
  private gearRetract = 0
  /** tren retráctil (`af.retractGear`, Sigilo): patas y compuertas que giran sobre sus bisagras al recogerlo */
  private retractSpec: RetractGearSpec | null = null
  private retractParts: { o: Object3D; rest: Quaternion; axis: Vector3; angle: number; late: boolean }[] = []
  /**
   * Rotor de paso cíclico sin batimiento (`featheringRotor`, Wilford XOZ-1): cabeza fija y palas en el
   * plano del eje, en el buje de la ficha (`featherHub`, coordenadas del modelo)
   */
  private feathering = false
  private readonly featherHub = new Vector3()

  /** Medidas del aparato que la animación necesita (rotor, hélice, ruedas, palanca). */
  vis = visualSpec(GENERIC)

  /**
   * Carga un modelo (o lo cambia por otro: el anterior se descarta). `af`: su ficha de
   * vuelo, de la que salen el tamaño del rotor y de la hélice, las palas, la reductora…
   */
  async load(url: string, af: Airframe = GENERIC): Promise<void> {
    const token = ++this.loadToken
    const vis = visualSpec(af)
    let scene: Object3D
    let key = (url.split('/').pop() ?? '').replace(/\.glb$/i, '')
    try {
      scene = (await new GLTFLoader().loadAsync(url)).scene
    } catch (err) {
      console.warn('No se pudo cargar el modelo GLB, uso el modelo de respaldo.', err)
      scene = buildFallbackModel()
      key = 'fallback'
    }
    if (token !== this.loadToken) return // mientras tanto se pidió otro aparato
    this.unload()
    this.gearRetract = af.amphib?.retract ?? 0
    this.retractSpec = af.retractGear ?? null
    this.feathering = af.featheringRotor === true
    this.featherHub.copy(af.hub)
    if (vis.key !== this.vis.key) {
      this.vis = vis
      this.disposeBlurDiscs()
      this.makeBlurDiscs()
    }
    this.modelKey = key
    this.setupModel(scene)
    this.setCockpitView(this.cockpitView)
    this.loaded = true
  }

  /** Quita el modelo cargado (cambio de aparato desde el menú). */
  private unload(): void {
    this.cockpit.detach()
    this.lights.detach()
    this.glassMeshes.length = 0
    this.rotorDisc.detach()
    this.propDisc.detach()
    for (const c of [...this.model.children]) {
      this.model.remove(c)
      c.traverse((o) => {
        const m = o as Mesh
        if (!m.isMesh) return
        m.geometry.dispose()
        for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat.dispose()
      })
    }
    this.parts = {}
    this.sprayNozzles = []
    this.extraRudders = []
    this.amphWheels = []
    this.retractParts = []
    this.glow = []
    this.rig = null
    this.rotorSpin = null
    this.propSpin = null
    this.glassMaterials.length = 0
    this.eyeLocal.set(0.7 - CG.x, 0.47 - CG.y, 0)
    this.loaded = false
  }

  private setupModel(scene: Object3D): void {
    // las piezas animadas son hijas directas
    const names: (keyof Parts)[] = [
      'rotor',
      'rotor_head',
      'prop',
      'rudder',
      'nose_wheel',
      'wheel_L',
      'wheel_R',
      'stick',
      'throttle',
      'throttle_brake',
      'brake_lever',
      'starter_lever',
      'pedal_L',
      'pedal_R',
      'foot_bar',
      'elevator',
      'aileron_L',
      'aileron_R',
      'pilot_front',
      'pilot_rear',
      'eye_front',
    ]
    for (const n of names) {
      const o = scene.getObjectByName(n)
      if (o) this.parts[n] = o
    }
    if (this.parts.eye_front) this.eyeLocal.copy(this.parts.eye_front.position).sub(CG)
    if (this.parts.pilot_rear) this.parts.pilot_rear.visible = false
    if (this.parts.rotor) this.rotorRest.copy(this.parts.rotor.position)
    scene.traverse((o) => {
      if (/^spray_\d+$/.test(o.name)) this.sprayNozzles.push(o)
    })
    for (const o of scene.children) if (/^rudder_\w+$/.test(o.name)) this.extraRudders.push({ o, rest: o.quaternion.clone() })
    for (const o of scene.children)
      if (/^amph_(main|nose)_[LR]$/.test(o.name)) this.amphWheels.push({ o, rest: o.position.clone(), main: o.name.startsWith('amph_main') })
    for (const g of this.retractSpec?.parts ?? []) {
      const o = scene.getObjectByName(g.node)
      if (o)
        this.retractParts.push({ o, rest: o.quaternion.clone(), axis: new Vector3(...g.axis).normalize(), angle: g.angle * DEG, late: g.late === true })
    }

    scene.traverse((o) => {
      const m = o as Mesh
      if (!m.isMesh) return
      const mats = Array.isArray(m.material) ? m.material : [m.material]
      const transparent = mats.some((x) => x.transparent || (x as any).opacity < 1 || /glass/i.test(x.name))
      if (transparent) {
        // vidrio: en el búfer de albedo (no enmascarado), sin escribir profundidad
        // tinte oscuro: en el búfer de albedo un vidrio claro "lava" el paisaje; un vidrio de color
        // (la cúpula dorada del Sigilo) conserva su color, algo oscurecido
        const tint = glassTint(mats)
        const glass = new MeshBasicMaterial({
          color: tint.color,
          transparent: true,
          opacity: tint.opacity,
          depthWrite: false,
          side: DoubleSide,
        })
        glass.userData.baseOpacity = tint.opacity
        m.material = keepAlpha(glass)
        this.glassMaterials.push(glass)
        this.glassMeshes.push(m)
        m.renderOrder = 2
        m.layers.set(OVERLAY_LAYER)
        m.castShadow = false
        m.receiveShadow = false
      } else {
        m.layers.set(LIGHT_LAYER)
        m.castShadow = true
        m.receiveShadow = true
        for (const mat of mats) {
          tuneMaterial(mat)
          const sm = mat as MeshStandardMaterial
          if (/^Plasma_Glow/i.test(mat.name) && sm.isMeshStandardMaterial && !this.glow.some((g) => g.m === sm))
            this.glow.push({ m: sm, base: sm.emissiveIntensity })
        }
      }
    })

    this.model.add(scene)
    scene.updateMatrixWorld(true)
    // polvo, barro de las ruedas, hollín del escape… (antes de mover nada: va por la postura de reposo)
    applyAircraftWear(scene, this.modelKey)
    this.lights.attach(scene, scene)
    // la maneta de freno va montada en la palanca de gas
    if (this.parts.throttle && this.parts.throttle_brake) this.parts.throttle.attach(this.parts.throttle_brake)
    // brazos y piernas que siguen a palanca, gas y pedales
    this.rig = PilotRig.create(scene)

    // Rotor: pivote (inclinación del disco) + grupo de giro
    if (this.parts.rotor) {
      const { pivot, spin } = wrapPivot(this.parts.rotor)
      this.parts.rotor = pivot
      this.rotorSpin = spin
      this.rotorRest.copy(pivot.position)
      pivot.add(this.rotorDisc.mesh)
      // el disco, a la altura de las palas del modelo
      this.rotorDisc.mesh.position.set(0, this.rotorDisc.attach(spin, `${this.modelKey}|rotor`), 0)
    }
    if (this.parts.prop) {
      const { pivot, spin } = wrapPivot(this.parts.prop)
      this.parts.prop = pivot
      this.propSpin = spin
      pivot.add(this.propDisc.mesh)
      // por fuera del disco: detrás de una hélice propulsora, delante de una tractora
      this.propDisc.mesh.position.set(this.vis.tractor ? 0.04 : -0.04, 0, 0)
      // motor rotativo (el Le Rhône del Cierva C.6): cilindros y cárter giran con la hélice en el mismo nodo
      // (materiales Rotary_*); el disco solo sustituye a las palas, no al motor
      this.propDisc.attach(spin, `${this.modelKey}|prop`, (m) =>
        (Array.isArray(m.material) ? m.material : [m.material]).some((x) => /^Rotary/i.test(x.name)),
      )
    }

    this.cockpit.attach(this.model, this.modelKey, this.glassMeshes, this.eyeLocal.clone().add(CG))
  }

  private rotorSpin: Object3D | null = null
  private propSpin: Object3D | null = null
  private rig: PilotRig | null = null
  /** mandos suavizados (el teclado y los frenos van a saltos) */
  private anim = { thr: 0, brake: 0, yaw: 0, pre: 0 }

  private disposeBlurDiscs(): void {
    this.rotorDisc.dispose()
    this.propDisc.dispose()
  }

  private makeBlurDiscs(): void {
    const vis = this.vis
    // el rotor antes que la hélice (en vista de persecución la hélice queda delante)
    this.rotorDisc = new BladeDisc({ radius: vis.rotorR, blades: vis.rotorBlades, cone: ROTOR_CONE, renderOrder: 3, fallback: ROTOR_BLADE })
    this.rotorDisc.mesh.rotation.x = -Math.PI / 2
    this.propDisc = new BladeDisc({ radius: vis.propR, blades: vis.propBlades, cone: 0, renderOrder: 5, fallback: PROP_BLADE })
    this.propDisc.mesh.rotation.y = Math.PI / 2
  }

  private glassMaterials: MeshBasicMaterial[] = []

  setCockpitView(cockpit: boolean): void {
    this.cockpitView = cockpit
    if (this.parts.pilot_front) this.parts.pilot_front.visible = !cockpit
    // desde dentro, el vidrio casi no se ve (lo justo para notar su tinte)
    for (const g of this.glassMaterials) g.opacity = (g.userData.baseOpacity ?? 0.2) * (cockpit ? 0.3 : 1)
  }

  setPassenger(p: boolean): void {
    if (this.parts.pilot_rear) this.parts.pilot_rear.visible = p
  }

  update(ac: AircraftPose, dt: number, ctl: ViewControls): void {
    this.root.position.copy(ac.pos)
    this.root.quaternion.copy(ac.quat)
    // el origen de `root` es el CG real: si la carga lo ha movido de lado, el modelo se corre al revés
    this.model.position.copy(CG).negate()
    if (ac.cgOff) this.model.position.sub(ac.cgOff)
    this.cgOff.copy(ac.cgOff ?? ZERO)
    const p = this.parts

    // cabeza del rotor (la de un rotor de paso cíclico no se inclina: lo que cambia es el paso de las palas)
    if (p.rotor_head) {
      if (this.feathering) p.rotor_head.quaternion.identity()
      else {
        _q.setFromAxisAngle(Z, ac.headPitch)
        _q2.setFromAxisAngle(X, ac.headRoll)
        p.rotor_head.quaternion.copy(_q).multiply(_q2)
      }
    }

    // rotor: plano de puntas real del modelo + giro (sin batimiento, el plano del eje, fijo al pilón)
    this.rotorAngle = (this.rotorAngle + ac.rotor.omega * dt) % (Math.PI * 2)
    if (this.feathering) _q.identity()
    else {
      const nBody = _v.copy(ac.rotor.normal).applyQuaternion(_q2.copy(ac.quat).invert())
      _q.setFromUnitVectors(Y, nBody)
    }
    _q2.setFromAxisAngle(Y, this.rotorAngle)
    if (p.rotor) {
      p.rotor.quaternion.copy(_q)
      if (this.rotorSpin) this.rotorSpin.quaternion.copy(_q2)
      if (this.feathering) p.rotor.position.copy(this.featherHub).add(this.cgOff)
      else p.rotor.position.copy(ac.hubBody).add(CG).add(this.cgOff)
      this.rotorDisc.update(this.rotorAngle, ac.rotor.omega, dt)
    }

    // hélice
    const vis = this.vis
    const propRpm = ac.engineRpm / vis.gear
    const propOmega = propRpm * (2 * Math.PI) / 60
    this.propAngle = (this.propAngle + propOmega * dt) % (Math.PI * 2)
    if (p.prop && this.propSpin) {
      // Rotax: gira en sentido negativo sobre +X (vista desde atrás antihoraria); el radial
      // del Cierva, al revés (`propSpin` = 1)
      this.propSpin.quaternion.setFromAxisAngle(X, vis.propSpin * this.propAngle)
      this.propDisc.update(vis.propSpin * this.propAngle, vis.propSpin * propOmega, dt)
    }

    // timón, rueda de morro, ruedas, palanca
    if (p.rudder) p.rudder.quaternion.setFromAxisAngle(Y, ac.rudder)
    for (const r of this.extraRudders) r.o.quaternion.copy(r.rest).multiply(_q.setFromAxisAngle(Y, ac.rudder))
    // (rueda de cola: gira al revés que una de morro, y solo lo que permitan sus muelles)
    if (p.nose_wheel)
      p.nose_wheel.quaternion.setFromAxisAngle(Y, vis.tailWheel ? (ac.noseSteer * vis.tailWheelSteer) / 22 : -ac.noseSteer)
    const fwdSpeed = _v.set(1, 0, 0).applyQuaternion(ac.quat).dot(ac.vel)
    if (ac.onGround) this.wheelAngle -= (fwdSpeed / vis.wheelR) * dt
    if (p.wheel_L) p.wheel_L.quaternion.setFromAxisAngle(Z, this.wheelAngle)
    if (p.wheel_R) p.wheel_R.quaternion.setFromAxisAngle(Z, this.wheelAngle)
    // ruedas anfibias: suben dentro del flotador; las principales ruedan
    // tren retráctil: las patas suben en el primer 70 % del recorrido y las compuertas «tardías» se cierran
    // en el último 30 % (al bajarlo, al revés: primero se abren)
    if (this.retractParts.length) {
      const r = 1 - (ac.gearPos ?? 1)
      for (const g of this.retractParts) {
        const x = g.late ? (r - 0.7) / 0.3 : r / 0.7
        const k = x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x)
        g.o.quaternion.copy(g.rest).multiply(_q.setFromAxisAngle(g.axis, g.angle * k))
      }
    }
    const up = this.gearRetract * (1 - (ac.gearPos ?? 1))
    for (const w of this.amphWheels) {
      w.o.position.set(w.rest.x, w.rest.y + up, w.rest.z)
      if (w.main) w.o.quaternion.setFromAxisAngle(Z, this.wheelAngle)
    }
    if (p.stick && vis.hangingStick) {
      // mando directo (Cierva): la palanca cuelga de la cabeza del rotor y, por su varillaje,
      // la mano va en el sentido de un avión (atrás = disco atrás) pero la palanca entera se
      // inclina al revés que la cabeza (R&M 1859). En el GLB está en su posición neutra, con
      // el origen en la articulación.
      _q.setFromAxisAngle(Z, -HANGING_PITCH * (ac.headPitch - vis.headBase))
      _q2.setFromAxisAngle(X, -HANGING_ROLL * ac.headRoll)
      p.stick.quaternion.copy(_q).multiply(_q2)
    } else if (p.stick) {
      _q.setFromAxisAngle(Z, ctl.pitch * 13 * DEG)
      _q2.setFromAxisAngle(X, ctl.roll * 11 * DEG)
      p.stick.quaternion.copy(_q).multiply(_q2)
    }

    // gas (con su maneta de freno), palancas del Cierva y pedales
    const a = this.anim
    const k = Math.min(1, dt * 10)
    a.thr += (Math.min(1, Math.max(0, ctl.throttle ?? 0)) - a.thr) * k
    a.brake += (Math.min(1, Math.max(0, ctl.wheelBrake ?? 0)) - a.brake) * Math.min(1, dt * 14)
    a.yaw += (Math.min(1, Math.max(-1, ctl.yaw ?? ac.noseSteer / NOSE_STEER_MAX)) - a.yaw) * k
    a.pre += ((ctl.prerotator ? 1 : 0) - a.pre) * Math.min(1, dt * 8)
    // (todo gas = palanca adelante: giro negativo sobre +Z)
    if (p.throttle) p.throttle.quaternion.setFromAxisAngle(Z, -a.thr * THROTTLE_TRAVEL)
    // propulsor de plasma: un rescoldo al ralentí y todo el brillo a pleno gas; apagado, nada
    if (this.glow.length) {
      const k = ac.engineRpm > 50 ? 0.12 + 0.88 * a.thr : 0
      for (const g of this.glow) g.m.emissiveIntensity = g.base * k
    }
    if (p.throttle_brake) p.throttle_brake.quaternion.setFromAxisAngle(Z, -a.brake * 18 * DEG)
    if (p.brake_lever) p.brake_lever.quaternion.setFromAxisAngle(Z, a.brake * 22 * DEG)
    if (p.starter_lever) p.starter_lever.quaternion.setFromAxisAngle(Z, a.pre * 22 * DEG)
    // pedal derecho adelante con pie derecho; el izquierdo vuelve lo mismo
    if (p.pedal_R) p.pedal_R.quaternion.setFromAxisAngle(Z, -a.yaw * PEDAL_TRAVEL)
    if (p.pedal_L) p.pedal_L.quaternion.setFromAxisAngle(Z, a.yaw * PEDAL_TRAVEL)
    if (p.foot_bar) p.foot_bar.quaternion.setFromAxisAngle(Y, a.yaw * FOOT_BAR_TRAVEL)
    // profundidad (palanca atrás → borde de salida arriba; sube más de lo que baja) y alerones (palanca a la
    // derecha → el derecho sube): nodos de bisagra sobre +Z, el borde de salida hacia −X
    if (p.elevator) p.elevator.quaternion.setFromAxisAngle(Z, -ctl.pitch * (ctl.pitch > 0 ? 28 : 16) * DEG)
    if (p.aileron_R) p.aileron_R.quaternion.setFromAxisAngle(Z, -ctl.roll * 18 * DEG)
    if (p.aileron_L) p.aileron_L.quaternion.setFromAxisAngle(Z, ctl.roll * 18 * DEG)
    if (this.rig && p.pilot_front?.visible) this.rig.update()
    // interruptores de luces del panel
    this.cockpit.lightsOn = this.lights.on
  }

  /** Posición del ojo del piloto en el mundo. */
  eyeWorld(out: Vector3): Vector3 {
    return out.copy(this.eyeLocal).sub(this.cgOff).applyQuaternion(this.root.quaternion).add(this.root.position)
  }

  setEnvMap(tex: Texture | null): void {
    this.model.traverse((o) => {
      const m = o as Mesh
      if (!m.isMesh) return
      const mats = Array.isArray(m.material) ? m.material : [m.material]
      for (const mat of mats) {
        const s = mat as MeshStandardMaterial
        if (s.isMeshStandardMaterial) {
          s.envMapIntensity = 0.85
          // recompilar solo si cambia la textura (se reutiliza la misma, que se actualiza en la GPU)
          if (s.envMap !== tex) {
            s.envMap = tex
            s.needsUpdate = true
          }
        }
      }
    })
  }
}

/** Lo que la animación necesita de la ficha de vuelo del aparato. */
function visualSpec(af: Airframe) {
  const s = {
    rotorR: af.rotor.radius,
    rotorBlades: af.rotor.blades,
    propR: af.propRadius,
    propBlades: af.propBlades ?? 3,
    propSpin: af.propSpin ?? -1,
    gear: af.engine.gear,
    tractor: af.prop.x > af.cg.x,
    wheelR: af.wheelRadius ?? 0.19,
    hangingStick: af.hangingStick ?? false,
    headBase: (af.head.base * Math.PI) / 180,
    tailWheel: af.tailWheel !== undefined,
    tailWheelSteer: af.tailWheelSteer ?? 0,
    wreck: af.wreck,
    key: '',
  }
  s.key = [s.rotorR, s.rotorBlades, s.propR, s.propBlades].join('|')
  return s
}

/** Sustituye `node` por pivote (misma pose) → giro → node (pose identidad). */
function wrapPivot(node: Object3D): { pivot: Group; spin: Group } {
  const parent = node.parent!
  const pivot = new Group()
  pivot.name = `${node.name}_pivot`
  pivot.position.copy(node.position)
  pivot.quaternion.copy(node.quaternion)
  pivot.scale.copy(node.scale)
  parent.add(pivot)
  parent.remove(node)
  node.position.set(0, 0, 0)
  node.quaternion.identity()
  node.scale.set(1, 1, 1)
  const spin = new Group()
  spin.name = `${node.name}_spin`
  pivot.add(spin)
  spin.add(node)
  return { pivot, spin }
}

/**
 * Tinte del vidrio en el simulador: el oscuro de siempre, salvo que el material del modelo sea un vidrio
 * de color claramente saturado (dorado, ámbar…): entonces su color, oscurecido, y algo más opaco.
 */
const _hsl = { h: 0, s: 0, l: 0 }
function glassTint(mats: Material[]): { color: Color; opacity: number } {
  for (const m of mats) {
    const c = (m as MeshStandardMaterial).color
    if (!c) continue
    c.getHSL(_hsl)
    if (_hsl.s > 0.4 && _hsl.l > 0.15 && _hsl.l < 0.85) return { color: c.clone().multiplyScalar(0.6), opacity: 0.34 }
  }
  return { color: new Color(0x1c2833), opacity: 0.2 }
}

function tuneMaterial(mat: Material): void {
  const s = mat as MeshPhysicalMaterial
  // alfa = 0 → "este píxel ya está iluminado" (ver máscara de iluminación en Graphics.ts)
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <dithering_fragment>',
      '#include <dithering_fragment>\n\tgl_FragColor.a = 0.0;',
    )
  }
  mat.customProgramCacheKey = () => 'lit-alpha0'
  if (!s.isMeshStandardMaterial) return
  if (/Paint_White|Paint_Accent|Paint_Dark/i.test(s.name)) {
    if ((s as MeshPhysicalMaterial).isMeshPhysicalMaterial) {
      s.clearcoat = 0.8
      s.clearcoatRoughness = 0.08
    }
  }
}

/** albedo (lineal) de las palas si el modelo no tiene su material: aluminio pintado, hélice de carbono */
const ROTOR_BLADE = new Color(0.35, 0.37, 0.4)
const PROP_BLADE = new Color(0.02, 0.02, 0.022)
/** conicidad de las palas del rotor en vuelo */
const ROTOR_CONE = 2.5 * (Math.PI / 180)

/** Modelo sencillo de respaldo por si el GLB no está disponible. */
function buildFallbackModel(): Object3D {
  const root = new Group()
  const white = new MeshPhysicalMaterial({ color: 0xf2f2f0, roughness: 0.25, clearcoat: 1, name: 'Paint_White' })
  const orange = new MeshPhysicalMaterial({ color: 0xff5a1f, roughness: 0.3, clearcoat: 1, name: 'Paint_Accent' })
  const metal = new MeshStandardMaterial({ color: 0xb8bcc2, metalness: 0.9, roughness: 0.3, name: 'Metal_Frame' })
  const dark = new MeshStandardMaterial({ color: 0x222428, roughness: 0.5, name: 'Paint_Dark' })
  const blade = new MeshStandardMaterial({ color: 0xd8dadd, metalness: 0.5, roughness: 0.35, name: 'Rotor_Blade' })
  const pod = new Mesh(new SphereGeometry(1, 32, 16), white)
  pod.scale.set(1.45, 0.42, 0.4)
  pod.position.set(0.7, -0.3, 0)
  root.add(pod)
  const stripe = new Mesh(new SphereGeometry(1, 32, 16), orange)
  stripe.scale.set(1.3, 0.2, 0.405)
  stripe.position.set(0.7, -0.42, 0)
  root.add(stripe)
  const mast = new Mesh(new BoxGeometry(0.1, 1.9, 0.08), metal)
  mast.position.set(-0.36, 0.48, 0)
  root.add(mast)
  const keel = new Mesh(new BoxGeometry(3.4, 0.07, 0.07), metal)
  keel.position.set(-2.05, -0.72, 0)
  root.add(keel)
  const engine = new Mesh(new BoxGeometry(0.6, 0.55, 0.6), dark)
  engine.position.set(-1.05, 0.05, 0)
  root.add(engine)
  const fin = new Mesh(new BoxGeometry(0.6, 0.9, 0.04), white)
  fin.position.set(-3.35, 0.0, 0)
  root.add(fin)
  const stab = new Mesh(new BoxGeometry(0.45, 0.03, 1.5), white)
  stab.position.set(-3.42, -0.4, 0)
  root.add(stab)
  const head = new Group()
  head.name = 'rotor_head'
  head.position.set(-0.27, 1.47, 0)
  const headBox = new Mesh(new BoxGeometry(0.16, 0.2, 0.14), metal)
  headBox.position.set(0, 0.1, 0)
  head.add(headBox)
  root.add(head)
  const rotor = new Group()
  rotor.name = 'rotor'
  rotor.position.set(-0.25, 1.7, 0)
  const blades = new Group()
  const b = new Mesh(new BoxGeometry(8.4, 0.025, 0.2), blade)
  blades.add(b)
  rotor.add(blades)
  root.add(rotor)
  const prop = new Group()
  prop.name = 'prop'
  prop.position.set(-1.5, 0.25, 0)
  const propBlades = new Group()
  for (let i = 0; i < 3; i++) {
    const pb = new Mesh(new BoxGeometry(0.03, 0.86, 0.1), dark)
    pb.position.y = 0.43
    const holder = new Group()
    holder.rotation.x = (i / 3) * Math.PI * 2
    holder.add(pb)
    propBlades.add(holder)
  }
  prop.add(propBlades)
  root.add(prop)
  const tire = new MeshStandardMaterial({ color: 0x111111, roughness: 0.9, name: 'Rubber' })
  const mk = (name: string, x: number, y: number, z: number, r: number) => {
    const w = new Group()
    w.name = name
    w.position.set(x, y, z)
    const t = new Mesh(new CylinderGeometry(r, r, 0.12, 24), tire)
    t.rotation.x = Math.PI / 2
    w.add(t)
    root.add(w)
  }
  mk('wheel_L', -0.4, -0.86, -0.95, 0.19)
  mk('wheel_R', -0.4, -0.86, 0.95, 0.19)
  mk('nose_wheel', 1.6, -0.89, 0, 0.16)
  const glass = new MeshStandardMaterial({ color: 0x99aabb, transparent: true, opacity: 0.25, name: 'Glass' })
  const ws = new Mesh(new BoxGeometry(0.02, 0.5, 0.7), glass)
  ws.position.set(1.15, 0.3, 0)
  ws.rotation.z = 0.6
  root.add(ws)
  const eye = new Object3D()
  eye.name = 'eye_front'
  eye.position.set(0.7, 0.47, 0)
  root.add(eye)
  const add = new Mesh(new BoxGeometry(0.01, 0.01, 0.01), new MeshBasicMaterial({ blending: AdditiveBlending }))
  add.visible = false
  root.add(add)
  return root
}
