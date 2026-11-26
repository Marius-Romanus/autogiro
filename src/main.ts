// (lo primero: envuelve fetch antes de que nada pida datos, y avisa si un bloqueador corta los del mapa)
import './net/netWatch.ts'
import {
  CubeCamera,
  HalfFloatType,
  Matrix4,
  Mesh,
  PlaneGeometry,
  PMREMGenerator,
  Quaternion,
  Scene,
  Vector3,
  WebGLCubeRenderTarget,
  WebGLRenderTarget,
  Color,
  type Texture,
} from 'three'
import { SkyMaterial } from '@takram/three-atmosphere'
import { LOCATIONS, loadSettings, locationName, locationNote, saveSettings, type Location, type Quality, type Settings } from './config.ts'
import { applyI18n, getLang, locale, onLangChange, setLang, t, type Lang } from './i18n.ts'
import { Graphics, LIGHT_LAYER } from './render/Graphics.ts'
import { usesIgnTerrain, World, type GroundSample } from './world/World.ts'
import { hasIgnTerrain } from './world/HeightSource.ts'
import { setupCatastroMenu } from './world/catastro/catastroMenu.ts'
import { Autogyro, defaultControls, type Environment, type GroundProvider } from './sim/autogyro.ts'
import { WindModel } from './sim/atmosphere.ts'
import { WindField } from './world/WindField.ts'
import { AirModel } from './sim/airMass.ts'
import { WeatherSystem } from './fx/WeatherSystem.ts'
import { PilotAssist } from './sim/assist.ts'
import { AircraftView, SHADOW_ONLY_LAYER } from './aircraft/AircraftView.ts'
import { BEAM } from './aircraft/AircraftLights.ts'
import { AIRCRAFT, aircraftById, aircraftName, aircraftNote, aircraftUrl } from './aircraft/catalog.ts'
import { airframeById } from './sim/airframes.ts'
import { Input } from './input/Input.ts'
import { Vr, VR_DETAIL } from './vr/Vr.ts'
import { setupVrUi } from './vr/vrUi.ts'
import { camName, CameraRig, headingOf } from './camera/CameraRig.ts'
import { Hud, type HudData } from './hud/Hud.ts'
import { Guide } from './hud/Guide.ts'
import { Telemetry, type TelemetryInfo } from './hud/Telemetry.ts'
import { perf } from './hud/perf.ts'
import { gpuHelpHtml } from './hud/gpuHelp.ts'
import { Sound } from './audio/Sound.ts'
import { Multiplayer } from './net/Multiplayer.ts'
import { AirTraffic } from './airtraffic/AirTraffic.ts'
import { CrashSystem, type AircraftState, type CrashWorld } from './crash/CrashSystem.ts'
import { LocalWater } from './world/LocalWater.ts'
import { CropSprayer } from './fx/SprayFx.ts'
import { GearButton } from './hud/GearButton.ts'
import type { RoomConditions } from './net/protocol.ts'
import { WorldMap, type MapPick } from './menu/WorldMap.ts'
import { buildLocationSelect, localizeLocationSelect, showDeparture, syncCurrentDeparture } from './menu/locationSelect.ts'
import { menuBack, refreshMenuUi, setupMenuUi, updateAxisBars } from './menu/menuUi.ts'
import { setupFuelMenu } from './menu/fuelMenu.ts'
import { applyPowerplantSettings, powerplantFrame, powerplantGuide, powerplantHud, requestFailure, toggleEngine } from './hud/engineUi.ts'
import { setupWeatherMenu, syncAirControls } from './menu/weatherMenu.ts'
import { setupSkyMenu, syncSkyControls } from './menu/skyMenu.ts'
import { localUtcOffset } from './menu/sun.ts'
import { School } from './school/School.ts'
import { setupSchoolMenu } from './school/schoolMenu.ts'
import { Replay } from './replay/Replay.ts'

const DT = 1 / 240
const KT = 0.514444
const GROUND_ALBEDO = new Color(0.18, 0.17, 0.14)
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

// ---------------------------------------------------------------------------
// Suelo local para el modelo de vuelo: plano ajustado a 3 muestras por fotograma
// ---------------------------------------------------------------------------
class GroundCache implements GroundProvider {
  valid = false
  readonly p0 = new Vector3()
  readonly n = new Vector3(0, 1, 0)
  heightAt(x: number, z: number, out: Vector3): number {
    out.copy(this.n)
    if (!this.valid) return -1e7
    const n = this.n
    return this.p0.y - (n.x * (x - this.p0.x) + n.z * (z - this.p0.z)) / n.y
  }
  /** agua alrededor del aparato (src/world/LocalWater.ts): flotación y fondo (sim/hydro.ts) */
  readonly water = new LocalWater()
  waterDepth(x: number, z: number): number {
    // (la lámina de agua del relieve es llana: en pendiente es la orilla seca de un embalse bajo, que el
    // mapa sigue dando por agua)
    return this.n.y < 0.998 ? 0 : this.water.depthAt(x, z)
  }
  applyMatrix(m: Matrix4): void {
    this.p0.applyMatrix4(m)
    this.n.transformDirection(m)
    this.water.applyMatrix(m)
  }
}

type State = 'loading' | 'flying' | 'crashed'

class App {
  settings: Settings = loadSettings()
  gfx: Graphics
  world: World | null = null
  ac = new Autogyro()
  view = new AircraftView()
  input: Input
  rig: CameraRig
  hud: Hud
  guide: Guide
  /** panel de rendimiento (F3) */
  telemetry: Telemetry
  /** realidad virtual en la cabina (src/vr) */
  vr!: Vr
  sound = new Sound()
  mp: Multiplayer
  /** otros autogiros en los aeródromos (src/airtraffic) */
  airTraffic!: AirTraffic
  wind = new WindModel()
  /** viento del terreno: relieve, obstáculos, térmicas y perfil del día (src/world/WindField.ts, src/sim/wind) */
  windField = new WindField()
  assist = new PilotAssist()
  ground = new GroundCache()
  ctl = defaultControls()
  env: Environment
  state: State = 'loading'
  menuOpen = true
  location!: Location
  spawnXZ = new Vector3()
  loadingT = 0
  groundSeenT = 0
  last = performance.now()
  simDate = new Date()
  rotorBrake = true
  fps = 60
  private sample: GroundSample = { y: 0, normal: new Vector3() }
  private wv = new Vector3()
  private rebaseM = new Matrix4()
  private prevPos = new Vector3()
  private envTimer = 0
  private envScene = new Scene()
  private envSky: SkyMaterial
  private cubeRT = new WebGLCubeRenderTarget(64, { type: HalfFloatType })
  private cubeCam: CubeCamera
  private pmrem: PMREMGenerator
  private envTex: Texture | null = null
  private envRT: WebGLRenderTarget | null = null
  private groundEllipsoid = 650
  /** aire del día (temperatura y QNH del menú, anclados en el suelo de la salida): sim/airMass.ts */
  private air = new AirModel()
  /** visibilidad, niebla, lluvia y nieve (src/fx/WeatherSystem.ts) */
  private wx!: WeatherSystem
  private toastTimer = 0
  /** el botón «Relojes» ya refleja el estado del panel (updateHud) */
  private hudBtnSynced = false
  private worldKey = ''
  private orbitT = 0
  /** mapa del mundo del menú para elegir la salida (src/menu/WorldMap.ts) */
  private worldMap = new WorldMap()
  /** física de accidentes (despiece con Rapier, src/crash) */
  crashSys: CrashSystem
  /** fumigación del Gyro Tractor (src/fx/SprayFx.ts) */
  spray: CropSprayer
  /** botón «Tren» de la barra superior, solo con tren que se recoge (src/hud/GearButton.ts) */
  gearBtn = new GearButton()
  /** escuela: ejercicios con nota y la nota de cada toma (src/school) */
  school: School
  /** grabación continua, repetición del vuelo y traza GPX/KML (src/replay) */
  replay: Replay
  private crashShown = false
  /** estado al principio del fotograma (para rebobinar choques con obstáculos) */
  private snap: AircraftState = { pos: new Vector3(), quat: new Quaternion(), vel: new Vector3(), omega: new Vector3() }
  private crashWorldCache: { w: World; cw: CrashWorld } | null = null

  constructor() {
    const container = $('app')
    this.gfx = new Graphics(container)
    this.telemetry = new Telemetry(this.gfx.renderer)
    this.telemetry.visible = this.settings.telemetry
    this.gfx.renderer.toneMappingExposure = this.settings.exposure
    this.gfx.sunLight.shadow.camera.layers.enable(SHADOW_ONLY_LAYER)
    this.gfx.scene.add(this.view.root)
    this.crashSys = new CrashSystem(this.gfx.scene, { sun: this.gfx.sunLight, sky: this.gfx.skyLight })
    this.spray = new CropSprayer(this.gfx.scene, { sun: this.gfx.sunLight, sky: this.gfx.skyLight })
    this.wx = new WeatherSystem(this.gfx)
    this.input = new Input(this.settings, this.gfx.renderer.domElement)
    // interruptores y llave del panel, pulsables en la vista de cabina
    this.view.cockpit.bindPointer(
      this.gfx.renderer.domElement,
      this.gfx.camera,
      () => this.rig.mode === 'cockpit' && !this.menuOpen && this.state === 'flying',
      (a) => this.input.trigger(a),
    )
    this.rig = new CameraRig(this.gfx.camera)
    this.hud = new Hud($('hud') as HTMLCanvasElement)
    this.guide = new Guide(this.settings.guide, (v) => {
      this.settings.guide = v
      saveSettings(this.settings)
      this.toast(t(v ? 'toast.guideOn' : 'toast.guideOff'))
    })
    this.env = { rho: 1.15, wind: this.wv, ground: this.ground }
    this.pmrem = new PMREMGenerator(this.gfx.renderer)
    this.cubeCam = new CubeCamera(0.1, 10, this.cubeRT)
    this.envSky = new SkyMaterial()
    const skyQuad = new Mesh(new PlaneGeometry(2, 2), this.envSky)
    skyQuad.frustumCulled = false
    this.envScene.add(skyQuad)
    this.replay = new Replay(this, { wind: this.wv, toast: (m, secs) => this.toast(m, secs) })

    this.loadAircraft()

    // multijugador por salas (src/net/Multiplayer.ts)
    this.mp = new Multiplayer(this, {
      toast: (msg) => this.toast(msg),
      applyConditions: (c) => this.applyRoomConditions(c),
      respawn: () => this.spawn(),
      collide: (title, detail) => {
        if (this.ac.crash || this.state !== 'flying' || this.replay.frozen) return
        this.ac.crash = { title, detail, cause: 'obstacle' }
        // choque en el aire con otro aparato: las palas se llevan el golpe
        this.showCrash(['bladeA1', 'bladeB2'])
      },
    })

    // tráfico aéreo de los aeródromos (src/airtraffic): chocar con uno es como chocar con otro piloto
    this.airTraffic = new AirTraffic({
      scene: this.gfx.scene,
      collide: (title, detail) => {
        if (this.ac.crash || this.state !== 'flying' || this.replay.frozen) return
        this.ac.crash = { title, detail, cause: 'obstacle' }
        this.showCrash(['bladeA1', 'bladeB2'])
      },
    })

    // escuela (src/school/School.ts): prepara sus ejercicios con los ajustes del menú y recoloca el aparato
    this.school = new School({
      settings: this.settings,
      ac: this.ac,
      scene: this.gfx.scene,
      world: () => this.world,
      state: () => this.state,
      menuOpen: () => this.menuOpen,
      inRoom: () => this.mp.inRoom,
      location: () => this.currentLocation(),
      restart: () => {
        this.loadAircraft()
        this.lastStart = this.settings.start
        this.lastPassenger = this.settings.passenger
        this.applySettings(false)
        this.spawn()
        this.closeMenu()
      },
      place: (x, z, heading, agl, speed) => this.schoolPlace(x, z, heading, agl, speed),
      altimeterFt: (p) => {
        const w = this.world
        if (!w) return 0
        const g = w.frame.worldToGeo(p)
        return this.air.altimeter((w.mode === 'google' ? g.h - this.location.geoid : g.h) - 1.05) * 3.28084
      },
      throttle: () => this.input.throttle,
      toast: (msg, secs) => this.toast(msg, secs),
      refreshMenu: () => this.refreshMenu(),
      // «Ver repetición de la toma»: la repetición se abre sola unos segundos antes del último contacto
      replay: () => void this.replay.open(),
      frozen: () => this.replay.frozen,
    })

    // realidad virtual (src/vr): la sesión, su interfaz y la vuelta a la pantalla normal
    this.vr = new Vr({
      gfx: this.gfx,
      input: this.input,
      toast: (msg, secs) => this.toast(msg, secs),
      restoreScreen: () => {
        this.applyVrDetail()
        this.gfx.setQuality(this.quality, this.world?.realGeometry ?? false)
        this.last = performance.now()
      },
      entered: () => {
        this.rig.setMode('cockpit', this.ac, 0)
        this.applyVrDetail()
        this.toast(t('vr.entered'), 6)
      },
      ptt: (held) => (this.mp.radio.extPtt = held),
      radio: () => this.vrRadio(),
    })
    setupVrUi(this.vr, { enter: (kind) => this.enterVr(kind), exit: () => this.vr.exit(), detailChanged: () => this.applyVrDetail() })

    ;(window as any).app = this // depuración desde la consola
    this.setupMenu()
    setupSchoolMenu(this.school, this.settings, () => this.mp.inRoom)
    this.applySettings(true)
    requestAnimationFrame((t) => this.loop(t))
  }

  private loadedAircraft = ''

  /** Carga (o cambia) el modelo 3D del aparato elegido en el menú. Su geometría de vuelo se aplica en spawn()/fly(). */
  private loadAircraft(): void {
    const m = aircraftById(this.settings.aircraft)
    // (con flotadores es otro modelo: el del juego anfibio, sin el tren de ruedas)
    const url = aircraftUrl(m, this.settings.floats)
    if (url === this.loadedAircraft) return
    this.loadedAircraft = url
    void this.view.load(`${import.meta.env.BASE_URL}${url}`, airframeById(m.id, this.settings.floats)).then(() => {
      this.view.setPassenger(this.settings.passenger)
      this.spray.setNozzles(this.view.sprayNozzles)
      if (this.envTex) this.view.setEnvMap(this.envTex)
    })
  }

  /** Calidad efectiva: la elegida o, en automático, según la GPU detectada. */
  get quality(): Quality {
    const q = this.settings.quality
    return q === 'auto' ? (this.gfx.gpuIntegrated ? 'low' : 'high') : q
  }

  // -------------------------------------------------------------------------
  // Mundo y aparición
  // -------------------------------------------------------------------------
  private currentLocation(): Location {
    const s = this.settings
    if (s.locationId === 'custom') {
      return {
        id: 'custom',
        name: s.customName || t('loc.custom'),
        lat: s.customLat,
        lon: s.customLon,
        heading: s.customHeading || 0,
        geoid: 50,
        airAGL: 300,
      }
    }
    return LOCATIONS.find((l) => l.id === s.locationId) ?? LOCATIONS[0]
  }

  /** Lo que obliga a recrear el escenario si cambia. */
  private worldKeyFor(loc: Location): string {
    const s = this.settings
    return [s.scenery, s.googleKey, s.imagery, s.elevation, s.buildings, s.catastro, s.trees, usesIgnTerrain(s, loc.lat, loc.lon), hasIgnTerrain(loc.lat, loc.lon)].join('|')
  }

  private spawn(): void {
    const s = this.settings
    // vuelo nuevo: fuera de la repetición y grabación desde cero
    this.replay.reset()
    // (con el menú abierto, aún no se ha salido: «Volar»)
    this.departed = !this.menuOpen
    const loc = this.currentLocation()
    this.location = loc
    const key = this.worldKeyFor(loc)
    if (!this.world || key !== this.worldKey) {
      this.world?.dispose()
      this.world = new World(s, this.gfx.scene, this.gfx.camera, this.gfx.renderer, loc.lat, loc.lon)
      this.world.applyQuality(this.quality)
      this.gfx.normalPassHook = (on) => this.world?.normalPass(on)
      this.gfx.setQuality(this.quality, this.world.realGeometry)
      this.worldKey = key
    } else {
      this.world.rebase(loc.lat, loc.lon, this.rebaseM)
    }
    this.world.frame.geoToWorld(loc.lat, loc.lon, 0, this.spawnXZ)
    // en una sala, cada piloto sale en su puesto (escalonados en pista o en formación)
    this.mp.offsetSpawn(this.spawnXZ, loc.heading, s.start === 'runway' && (Boolean(loc.runway) || loc.id === 'custom'))
    this.ground.valid = false
    this.state = 'loading'
    this.loadingT = 0
    this.groundSeenT = 0
    // geometría de vuelo del aparato elegido (ruedas, hélice, cola): ver sim/airframes.ts
    this.ac.setAirframe(airframeById(s.aircraft, s.floats))
    this.ac.setLoad(s.passenger)
    // combustible del menú y fallos de motor (sim/powerplant.ts)
    applyPowerplantSettings(this.ac, s, true)
    this.lastFuelPct = s.fuelPct
    this.view.setPassenger(s.passenger)
    // fumigador: tolva cargada (hasta el peso máximo) y paso cerrado
    this.spray.reset(airframeById(s.aircraft, s.floats).sprayer, this.view.sprayNozzles, this.ac)
    this.ac.crash = null
    this.crashSys.reset()
    this.crashShown = false
    $('crash').classList.add('hidden')
    // cámara provisional encima del punto de salida
    const cam = this.gfx.camera
    cam.position.set(this.spawnXZ.x - 60, 900, this.spawnXZ.z + 60)
    cam.lookAt(this.spawnXZ.x, 600, this.spawnXZ.z)
    this.input.throttle = 0
    this.input.trim = 0
    this.input.keyStick = 0
    this.assist.reset()
    this.input.parkBrake = true
    this.rotorBrake = true
    this.ctl = defaultControls()
    // guía lateral: en pista, pasos del despegue; en el aire, cómo volar
    // (con flotadores, una salida en el agua también empieza a flote: pasos del despegue)
    this.guide.reset(s.start === 'runway' && (Boolean(loc.runway) || loc.id === 'custom' || (loc.water === true && Boolean(this.ac.af.floats?.length))))
    // escuela: el ejercicio en curso vuelve a empezar
    this.school.onSpawn()
  }

  /** Escuela: recoloca el aparato donde empieza un ejercicio (en el suelo si `agl` es null). */
  private schoolPlace(x: number, z: number, heading: number, agl: number | null, speed: number): boolean {
    const s = this.sample
    if (!this.world?.sampleGround(x, z, 9000, s, 9000)) return false
    if (agl === null) {
      this.ac.placeOnGround(x, z, s.y, heading)
      this.input.throttle = 0
      this.input.parkBrake = true
      this.rotorBrake = true
    } else {
      this.ac.placeInAir(x, s.y + agl, z, heading, speed)
      this.input.throttle = 0.62
      this.input.parkBrake = false
      this.rotorBrake = false
    }
    this.ac.setGear(agl === null, true)
    this.input.trim = 0
    this.input.keyStick = 0
    this.assist.reset()
    this.ground.p0.set(x, s.y, z)
    this.ground.n.copy(s.normal)
    this.ground.valid = true
    this.prevPos.copy(this.ac.pos)
    this.guide.reset(agl === null)
    this.rig.setMode(this.rig.mode, this.ac, s.y)
    return true
  }

  /** Coloca el aparato en el punto de salida con la mejor altura de suelo conocida. */
  private placeAircraft(groundY: number, normal: Vector3): void {
    const s = this.settings
    const loc = this.location
    const x = this.spawnXZ.x
    const z = this.spawnXZ.z
    const af = this.ac.af
    const floats = Boolean(af.floats?.length)
    // en el suelo: en pista, en el punto del mapa o, con flotadores, en una salida en el agua; un
    // hidroautogiro sin ruedas (Wilford) no sale de una pista: empieza en vuelo
    let onSurface = s.start === 'runway' && (loc.runway || loc.id === 'custom' || (loc.water === true && floats))
    if (onSurface && af.keelGear && loc.runway) {
      onSurface = false
      this.toast(t('toast.noWheels'))
    }
    if (onSurface) {
      this.ac.placeOnGround(x, z, groundY, loc.heading)
      // tren anfibio: abajo en tierra, recogido si sale flotando en el agua
      const w = this.world?.waterSample(x, groundY, z, false)
      this.ac.setGear(!(loc.water || (w && w.water > 0.5 && normal.y > 0.998)), true)
      this.input.throttle = 0
      // (a flote no hay freno que valga: deriva con el viento hasta que se arranca)
      if (loc.water) this.input.parkBrake = false
    } else {
      const agl = loc.airAGL ?? 300
      this.ac.placeInAir(x, groundY + agl, z, loc.heading, 29.5)
      // (en el aire, con el tren anfibio arriba: se baja para tomar en tierra)
      this.ac.setGear(false, true)
      this.input.throttle = 0.62
      this.input.parkBrake = false
      this.rotorBrake = false
    }
    this.ground.p0.set(x, groundY, z)
    this.ground.n.copy(normal)
    this.ground.valid = true
    this.prevPos.copy(this.ac.pos)
  }

  private updateGround(): void {
    const w = this.world
    if (!w) return
    const ac = this.ac
    const s = this.sample
    const yHint = ac.pos.y + 60
    // agua alrededor (flotación, fondo, soplado del rotor): solo cerca de la superficie
    if (ac.agl < 40) this.ground.water.update(ac.pos.x, ac.pos.z, (x, z, d) => w.waterSample(x, ac.pos.y, z, d))
    else this.ground.water.clear()
    if (ac.agl > 150 && this.ground.valid) {
      // lejos del suelo: una muestra basta
      if (w.sampleGround(ac.pos.x, ac.pos.z, yHint + 2000, s, ac.pos.y)) {
        this.ground.p0.set(ac.pos.x, s.y, ac.pos.z)
        this.ground.n.copy(s.normal)
      }
      return
    }
    const pts = [new Vector3(1.5, 0, 0), new Vector3(-0.4, 0, -1.1), new Vector3(-0.4, 0, 1.1)]
    const hits: Vector3[] = []
    for (const p of pts) {
      p.applyQuaternion(ac.quat).add(ac.pos)
      // (con la calzada de los puentes que queden por debajo del aparato: se puede rodar por ellos)
      if (w.sampleGround(p.x, p.z, yHint, s, ac.pos.y)) hits.push(new Vector3(p.x, s.y, p.z))
    }
    if (hits.length === 3) {
      const n = new Vector3().subVectors(hits[1], hits[0]).cross(new Vector3().subVectors(hits[2], hits[0])).normalize()
      if (n.y < 0) n.negate()
      if (n.y > 0.5) {
        this.ground.n.copy(n)
        this.ground.p0.copy(hits[0])
        this.ground.valid = true
      }
    } else if (hits.length > 0) {
      this.ground.p0.copy(hits[0])
      this.ground.valid = true
    }
  }

  /** Re-centra el origen cuando el aparato se aleja (precisión y curvatura). */
  private maybeRebase(): void {
    const w = this.world
    if (!w) return
    const ac = this.ac
    if (Math.hypot(ac.pos.x, ac.pos.z) < 2500) return
    const g = w.frame.worldToGeo(ac.pos)
    const m = w.rebase(g.lat, g.lon, this.rebaseM)
    const q = new Quaternion().setFromRotationMatrix(m)
    ac.pos.applyMatrix4(m)
    this.prevPos.applyMatrix4(m)
    ac.vel.applyQuaternion(q)
    ac.quat.premultiply(q)
    ac.rotor.normal.applyQuaternion(q)
    ac.rotor.normalRate.applyQuaternion(q)
    this.ground.applyMatrix(m)
    this.rig.rebase(m)
    this.vr.rebase(m)
    this.gfx.detail.rebase(m)
    this.gfx.water.rebase(m)
    this.spray.rebase(m)
    this.crashSys.waterFx.rebase(m)
    this.spawnXZ.applyMatrix4(m)
    this.gfx.camera.position.applyMatrix4(m)
    this.gfx.camera.quaternion.premultiply(q)
  }

  // -------------------------------------------------------------------------
  // Bucle principal
  // -------------------------------------------------------------------------
  private loop(t: number): void {
    // (con el visor de realidad virtual puesto, los fotogramas los da el visor)
    this.vr.schedule((tt) => this.loop(tt))
    const dt = Math.min(0.1, Math.max(0.0005, (t - this.last) / 1000))
    this.last = t
    this.fps += (1 / dt - this.fps) * 0.05
    const ac = this.ac
    const w = this.world
    // telemetría (F3): secciones del fotograma con perf.mark
    perf.beginFrame(t)
    perf.mark('sim')

    this.handleActions()
    this.ctl.prerotator = false
    this.ctl.wheelBrake = 0
    // repetición (src/replay): física, mandos, hora y viento parados mientras se ve y en la pausa de después
    const rp = this.replay.active
    const frozen = this.replay.frozen
    // realidad virtual: fuera del vuelo (menú, repetición) se vuelve a la pantalla; en él, sus mandos
    if (this.vr.active) {
      if (this.menuOpen || rp) this.vr.exit()
      else this.vr.controls((a) => this.input.trigger(a))
    }
    if (!this.menuOpen && !frozen) this.input.update(dt, this.ctl)
    // combustible y fallos: avisos y, en un simulacro, el gas sujeto a ralentí
    const ppMsg = frozen ? null : powerplantFrame(ac, this.input)
    if (ppMsg) this.toast(ppMsg, 3.5)
    if (this.settings.assist && !this.menuOpen && !frozen && this.state === 'flying')
      this.assist.apply(dt, ac, this.ctl, {
        pitchActive: this.input.keyPitch,
        rollActive: this.input.keyRoll,
        yawActive: this.input.keyYaw,
        analog: this.input.analog,
      })
    this.ctl.rotorBrake = this.rotorBrake

    // tiempo simulado (avanza en tiempo real)
    if (!frozen) this.simDate = new Date(this.simDate.getTime() + dt * 1000)
    this.gfx.setDate(rp ? this.replay.date : this.simDate)

    if (w) {
      // viento del terreno en el punto del aparato (también con el menú abierto: va adelantando el relieve)
      if (this.state !== 'crashed' && !frozen) {
        this.windField.tempC = this.air.groundTempC()
        this.wind.local = this.windField.update(dt, w, ac.pos, Math.max(0, ac.agl), this.simDate.getTime())
      }
      if (this.state === 'loading') this.updateLoading(dt)
      else if (this.state === 'flying' && !this.menuOpen && !frozen) this.stepPhysics(dt)
      this.updateGround()
      if (this.state === 'flying') this.maybeRebase()
    }
    // accidente: los restos siguen su física (y mueven al aparato para la cámara)
    perf.mark('aircraft')
    this.crashSys.prepare(this.view, this.gfx.renderer, this.gfx.camera)
    if (this.state === 'crashed' && this.crashSys.active && !this.menuOpen && !frozen) {
      this.crashSys.update(dt, ac, this.gfx.camera)
      if (!this.crashShown && this.crashSys.settled) this.showCrashPanel()
    }

    // el modelo primero (la cámara de cabina usa su posición de este fotograma); en la repetición, el grabado
    if (rp) this.replay.update(dt)
    else this.view.update(ac, dt, this.ctl)

    // cámara
    const look = this.input.consumeLook()
    const inVr = this.vr.active && !this.menuOpen && !rp
    if (inVr) this.vr.look(look.dx, look.dy)
    else {
      if (look.dx || look.dy) this.rig.look(look.dx, look.dy)
      if (look.wheel) this.rig.zoom(look.wheel)
    }
    const groundY = this.ground.valid ? this.ground.heightAt(this.gfx.camera.position.x, this.gfx.camera.position.z, this.wv2) : -1e6
    if (inVr) {
      // realidad virtual: la cabeza del piloto, sin la cámara de cabina (ni su vibración ni sus suavizados)
      this.view.setCockpitView(true)
      this.vr.frame(dt, { eye: this.view.eyeWorld(this.vrEye), quat: ac.quat, crashed: this.state === 'crashed' }, this.vrHud)
    } else if (this.state === 'loading' && !this.ground.valid) {
      // vista provisional
    } else if (this.menuOpen && this.state !== 'crashed') {
      // modo exhibición: órbita lenta alrededor del aparato
      this.orbitT += dt * 0.08
      const cam = this.gfx.camera
      const r = 11
      cam.position.set(ac.pos.x + Math.cos(this.orbitT) * r, ac.pos.y + 1.6, ac.pos.z + Math.sin(this.orbitT) * r)
      cam.position.y = Math.max(cam.position.y, groundY + 0.8)
      cam.lookAt(ac.pos.x, ac.pos.y + 0.6, ac.pos.z)
      if (cam.fov !== 50) {
        cam.fov = 50
        cam.updateProjectionMatrix()
      }
    } else if (rp) this.replay.camera(dt, this.input.dragging)
    else {
      this.rig.timeScale = this.state === 'crashed' ? this.crashSys.timeScale : 1
      this.rig.update(dt, ac, this.view, groundY, this.input.dragging)
    }
    this.view.lights.update(dt, this.gfx.camera, this.gfx.renderer.toneMappingExposure, this.gfx.sunDirWorld.y)
    // fumigación: caldo de las boquillas, gotas en el aire y nivel de la tolva
    const sprayGround = this.ground.valid ? this.ground.heightAt(ac.pos.x, ac.pos.z, this.wv2) : null
    const sprayMsg = this.spray.update(dt, ac, this.view.root, this.wv, sprayGround, this.state === 'flying' && !this.menuOpen && !frozen)
    if (sprayMsg) this.toast(sprayMsg)
    // agua: chapoteos, estela, rociones y soplado del rotor (src/fx/WaterFx.ts); el ruido del chapoteo
    // va por el sonido de los accidentes
    if (ac.onWater && this.sound.output) this.crashSys.attachAudio(this.sound.output.ctx, this.sound.output.node)
    if (!frozen) this.crashSys.updateWater(dt, ac, this.gfx.camera, this.state === 'flying' && !this.menuOpen, this.wv, this.waterDepthFn, this.surfaceFn)

    // luces / atmósfera
    if (w) {
      perf.mark('env')
      const gY = this.ground.valid ? this.ground.heightAt(ac.pos.x, ac.pos.z, this.wv2) : null
      if (rp) this.replay.updateGfx()
      else this.gfx.update(w.frame.worldToECEF, ac.pos, gY, this.ground.n, ac.agl)
      this.updateEnvMap(dt, w.frame.worldToECEF)
      this.gfx.camera.updateMatrixWorld()
      // lluvia y nieve alrededor de la cámara, gotas en los vidrios y su sonido
      this.wx.frame(dt, {
        camera: this.gfx.camera,
        view: this.view,
        vel: ac.vel,
        tas: ac.tas,
        wind: this.wv,
        cockpit: this.rig.mode === 'cockpit' && !this.menuOpen && !rp,
        camH: this.gfx.cameraHeight,
        acH: this.gfx.cameraHeight + ac.pos.y - this.gfx.camera.position.y,
        audio: this.sound.output,
        quiet: this.menuOpen,
      })
      // tendidos: su interruptor, en vivo
      if (w.power) w.power.enabled = this.settings.power
      perf.mark('world')
      // (cargando la salida no hay fotograma que cuidar: terreno y capas se ponen al día cuanto antes)
      w.settling = this.state === 'loading'
      w.update()
      // mangas de viento: el viento del sitio a la altura de la boca, con rachas (src/world/Windsocks.ts)
      w.windsocks?.update(dt, this.gfx.camera, {
        field: this.settings.terrainWind ? this.windField : null,
        settings: this.wind.settings,
        simMs: this.simDate.getTime(),
        exposure: this.gfx.renderer.toneMappingExposure,
        sunY: this.gfx.sunDirWorld.y,
      })
      // tráfico (src/traffic): hora local del lugar, aparato posado para que lo esquiven
      if (w.traffic) {
        perf.mark('traffic')
        const tr = w.traffic
        tr.enabled = this.settings.traffic
        // la luz de las farolas sobre el terreno la dibuja un efecto de Graphics
        tr.attachStreetLight(this.gfx.streetLight)
        const d = this.simDate
        const tz = localUtcOffset(this.location.lat, this.location.lon, this.settings.dayOfYear)
        tr.hour = (((d.getUTCHours() + d.getUTCMinutes() / 60 + tz) % 24) + 24) % 24
        tr.update(dt, this.gfx.camera, w, this.state === 'flying' ? { pos: ac.pos, agl: ac.agl, onGround: ac.onGround } : null, this.gfx.sunDirWorld.y)
      }
      if (Math.floor(t / 1000) !== Math.floor((t - dt * 1000) / 1000)) w.updateAttribution()
    }
    perf.mark('mp')
    this.mp.update(dt)
    // tráfico aéreo: fuera de las salas y de los ejercicios de la escuela; vuela de día y con buen tiempo
    this.airTraffic.update(dt, {
      world: w,
      camera: this.gfx.camera,
      player: ac,
      flying: this.state === 'flying',
      running: !this.menuOpen && !frozen && !rp,
      enabled: this.settings.airTraffic && !this.mp.inRoom && !this.school.active,
      density: this.settings.airTrafficDensity,
      wind: this.wind.settings,
      windField: this.settings.terrainWind ? this.windField : null,
      simMs: this.simDate.getTime(),
      rho: this.env.rho,
      vfr: this.gfx.sunDirWorld.y > 0.03 && this.settings.visibility >= 5000 && this.settings.precip <= 0,
      exposure: this.gfx.renderer.toneMappingExposure,
      sunY: this.gfx.sunDirWorld.y,
      audio: this.sound.output,
      cockpit: this.rig.mode === 'cockpit' && !this.menuOpen,
    })
    // focos de aterrizaje sobre el terreno: el propio y los de los demás pilotos
    const lights = this.view.lights
    this.gfx.landingLight.setBeams([lights.beam, ...this.mp.landingBeams(), ...this.airTraffic.landingBeams()], BEAM.angle, BEAM.penumbra, lights.knee)
    // con el mapa del mundo abierto la escena no se ve: la GPU es para el globo
    if (this.vr.active) this.vr.render(dt)
    else if (!this.worldMap.isOpen) this.gfx.render(dt)

    this.school.update(dt, this.ctl)
    perf.mark('hud')
    this.updateHud(dt)
    this.guide.update(dt, {
      active: !this.menuOpen && !rp && this.state !== 'crashed' && Boolean(this.world),
      onGround: this.state === 'loading' ? this.guide.phase !== 'flight' : ac.onGround,
      groundSpeed: ac.groundSpeed,
      throttle: this.input.throttle,
      cierva: this.settings.aircraft === 'cierva',
      aircraft: this.settings.aircraft,
      emergency: this.state === 'flying' ? powerplantGuide(ac) : null,
      // con flotadores, en el agua o yendo a ella (sin ruedas, o con el tren anfibio arriba)
      water: Boolean(ac.af.floats?.length) && (ac.onWater || ac.af.keelGear === true || (ac.af.amphib !== undefined && !ac.gearDown)),
    })
    this.updateSound(dt)
    // grabación continua del vuelo (src/replay)
    this.replay.record(dt)
    this.toastTimer -= dt
    if (this.toastTimer <= 0) $('toast').classList.remove('show')
    // el aviso de texto va debajo de la pila de avisos del HUD (motor, aceite, reserva…): no se pisan
    const tb = this.hud.stackBottom
    const top = tb > 0 ? `${Math.round(tb + 8)}px` : ''
    const toastEl = $('toast')
    if (toastEl.style.top !== top) toastEl.style.top = top
    perf.endFrame()
    this.telemetry.update(this.telemetryInfo)
  }

  /** Datos de la partida para el panel de telemetría (src/hud/Telemetry.ts). */
  private readonly telemetryInfo = (): TelemetryInfo => {
    const w = this.world
    const ac = this.ac
    const geo = w ? w.frame.worldToGeo(ac.pos) : { lat: this.location?.lat ?? 0, lon: this.location?.lon ?? 0, h: 0 }
    const msl = w && w.mode === 'google' ? geo.h - (this.location?.geoid ?? 0) : geo.h
    const d = this.simDate
    const tz = this.location ? localUtcOffset(this.location.lat, this.location.lon, this.settings.dayOfYear) : 0
    const hour = (((d.getUTCHours() + d.getUTCMinutes() / 60 + tz) % 24) + 24) % 24
    // (imageryName es la atribución entera: basta con la fuente de la foto)
    const photo = !w ? '' : /PNOA/.test(w.imageryName) ? ' + PNOA' : /Esri/.test(w.imageryName) ? ' + Esri' : ''
    const terrain = !w ? '' : w.mode === 'google' ? 'Google 3D' : `${w.terrainKind === 'ign' ? 'IGN MDT05' : 'Terrarium'}${photo}`
    return {
      gpu: this.gfx.gpuName,
      quality: this.quality,
      terrain,
      place: this.location ? locationName(this.location) : '',
      lat: geo.lat,
      lon: geo.lon,
      altFt: (msl - 1.05) * 3.28084,
      camera: this.menuOpen ? t('tel.menu') : camName(this.rig.mode),
      clock: fmtHour(hour),
      peers: this.mp.inRoom ? this.mp.peers.size : -1,
      wind: this.windField.describe(),
      tiles: (w?.tiles as unknown as TelemetryInfo['tiles']) ?? null,
      layers: w
        ? [
            { key: 'buildings', layer: w.buildings },
            { key: 'trees', layer: w.trees },
            { key: 'bridges', layer: w.bridges },
            { key: 'power', layer: w.power },
          ]
        : [],
    }
  }
  private wv2 = new Vector3()

  // ---- realidad virtual (src/vr) ----
  private vrEye = new Vector3()
  /** alarmas, precauciones e indicación del último fotograma, para la tablilla de avisos del visor */
  private vrHud: HudData | null = null

  /** Entra en realidad virtual (con visor, o los dos ojos en pantalla): desde el menú, empieza el vuelo. */
  private enterVr(kind: 'xr' | 'screen'): void {
    // (la sesión hay que pedirla dentro del gesto del jugador: antes de nada)
    const opening = this.vr.enter(kind)
    if (this.menuOpen) this.fly()
    void opening
  }

  /**
   * Detalle del terreno en el visor (perfiles de src/vr/Vr.ts): con la sesión abierta, menos teselas y,
   * salvo en «Completo», sin el pase de normales del relieve; fuera de ella, lo de la calidad elegida.
   */
  private applyVrDetail(): void {
    const d = this.vr.active ? VR_DETAIL[this.vr.prefs.detail] : null
    const w = this.world
    if (w && w.detailScale !== (d?.terrain ?? 1)) {
      w.detailScale = d?.terrain ?? 1
      w.applyQuality(this.quality)
    }
    if (d) this.gfx.useGeometryNormals(d.normals && (w?.realGeometry ?? false) && (this.quality === 'high' || this.quality === 'ultra'))
  }

  /** Quién habla por la radio de la sala, para la tablilla de avisos. */
  private vrRadio(): string {
    const r = this.mp.radio
    if (r.tx) return t('vr.radioTx')
    for (const p of this.mp.peers.values()) if (r.talking(p.info.id)) return t('vr.radioRx', { name: p.info.name })
    return ''
  }
  /** agua y superficie alrededor del aparato, para los efectos del agua */
  private readonly waterDepthFn = (x: number, z: number): number => this.ground.water.depthAt(x, z)
  private readonly surfaceFn = (x: number, z: number): number | null => (this.ground.valid ? this.ground.heightAt(x, z, this.wv3) : null)
  private wv3 = new Vector3()

  private updateLoading(dt: number): void {
    const w = this.world!
    this.loadingT += dt
    const s = this.sample
    // (si el punto de salida está sobre un puente, en su calzada)
    const ok = w.sampleGround(this.spawnXZ.x, this.spawnXZ.z, 9000, s, 9000)
    const progress = w.loadProgress
    $('loading').classList.toggle('hidden', this.menuOpen && this.loadingT < 0.5 ? false : false)
    $('loading').classList.remove('hidden')
    $('loading-bar').style.width = `${Math.round(Math.min(1, progress) * 100)}%`
    $('loading-text').textContent = w.lastError
      ? t('load.error', { msg: w.lastError.slice(0, 120) })
      : ok
        ? t('load.refining')
        : t('load.loading')
    if (ok) {
      if (this.groundSeenT === 0) this.groundSeenT = this.loadingT
      this.placeAircraft(s.y, s.normal)
      // cámara cerca del aparato para que carguen los detalles
      this.rig.setMode(this.rig.mode, this.ac, s.y)
      if (!this.menuOpen) this.rig.update(dt, this.ac, this.view, s.y, false)
      const settled = progress >= 0.999 && this.loadingT - this.groundSeenT > 1.5
      if (settled || this.loadingT - this.groundSeenT > 20) {
        this.groundEllipsoid = w.frame.worldToGeo(new Vector3(this.spawnXZ.x, s.y, this.spawnXZ.z)).h
        this.wx.setGround(this.groundEllipsoid)
        this.gfx.setClouds(this.settings.clouds, this.groundEllipsoid, this.quality, this.wx.cloudBaseAgl)
        this.state = 'flying'
        $('loading').classList.add('hidden')
      }
    }
  }

  private stepPhysics(dt: number): void {
    const ac = this.ac
    const w = this.world!
    if (!this.ground.valid) return
    // Pasos de como mucho DT que cubren justo el fotograma: el aparato se dibuja en el instante
    // del fotograma (con pasos fijos y sobrante quedaba hasta un paso atrás, distinto en cada
    // fotograma, y temblaba frente a la cámara). Tras un parón largo se simulan solo 20 pasos.
    const n = Math.min(20, Math.ceil(dt / DT - 1e-6))
    const h = Math.min(DT, dt / n)
    const geo = w.frame.worldToGeo(ac.pos)
    const msl = w.mode === 'google' ? geo.h - this.location.geoid : geo.h
    // densidad, temperatura, rocío y presión del aire a esta altitud (en ISA, la densidad de siempre)
    this.air.elev = w.mode === 'google' ? this.groundEllipsoid - this.location.geoid : this.groundEllipsoid
    this.air.fill(this.env, msl)
    // pista mojada o con nieve: menos agarre de las ruedas (1 en seco)
    this.env.grip = this.wx.grip
    this.prevPos.copy(ac.pos)
    this.snap.pos.copy(ac.pos)
    this.snap.quat.copy(ac.quat)
    this.snap.vel.copy(ac.vel)
    this.snap.omega.copy(ac.omega)
    for (let i = 0; i < n && !ac.crash; i++) {
      this.wind.sample(h, Math.max(0, ac.agl), ac.tas, this.wv)
      ac.step(h, this.ctl, this.env)
      // escuela: la toma se mira paso a paso (solo lee)
      this.school.step(h, ac, this.ctl)
    }
    // arranque con cuerda (Cierva C.6, sin prerrotador): lo que pasa con la cuerda y el personal de tierra
    if (ac.ropeMsg) {
      this.toast(t(ac.ropeMsg, { rpm: Math.round(ac.rotor.rpm) }), 3)
      ac.ropeMsg = null
    }
    // colisión con edificios/árboles (tiles 3D)
    if (!ac.crash && w.mode === 'google' && ac.vel.length() > 4) {
      const seg = new Vector3().subVectors(ac.pos, this.prevPos)
      const len = seg.length() + 1.2
      seg.normalize()
      const hit = w.raycast(this.prevPos, seg, len)
      if (hit && ac.agl > 2.5) {
        ac.crash = {
          cause: 'obstacle',
          title: t('crash.obstacle.title'),
          detail: t('crash.obstacle.google', { kmh: Math.round(ac.tas * 3.6) }),
        }
      }
    }
    // edificios y puentes de OpenStreetMap (modo sin clave)
    if (!ac.crash && (w.buildings || w.trees || w.bridges || w.power) && ac.vel.length() > 2) {
      // morro, cola y puntas del rotor (aprox.)
      const probes = [new Vector3(1.6, 0.2, 0), new Vector3(-2.6, 0.6, 0), new Vector3(0, 1.9, 3.8), new Vector3(0, 1.9, -3.8)]
      let hit = w.hitsObstacle(ac.pos)
      for (const p of probes) if (!hit) hit = w.hitsObstacle(p.applyQuaternion(ac.quat).add(ac.pos))
      if (hit) {
        ac.crash = {
          cause: 'obstacle',
          title: t('crash.obstacle.title'),
          detail: t('crash.obstacle.hit', { what: t(`obj.${hit}`), kmh: Math.round(ac.tas * 3.6) }),
        }
      }
    }
    // disco del rotor y extremos del aparato contra edificios, árboles y teselas 3D
    if (!ac.crash) {
      const hit = this.crashSys.probe(ac, this.crashWorld(), this.snap)
      if (hit) ac.crash = hit
    }
    if (ac.crash) this.showCrash()
  }

  /**
   * Accidente: en vez de congelar el aparato, arranca la simulación física de los
   * restos (src/crash). El panel con el resumen sale cuando todo se ha parado.
   * `extraBreak`: piezas que ya llegan rotas (p. ej. palas en un choque en el aire).
   */
  private showCrash(extraBreak: string[] = []): void {
    this.state = 'crashed'
    const ac = this.ac
    const o = this.sound.output
    if (o) this.crashSys.attachAudio(o.ctx, o.node)
    // contra obstáculos se rebobina al principio del fotograma: el golpe ocurre en la simulación
    const obstacle = !ac.crash!.cause || ac.crash!.cause === 'obstacle'
    let started = false
    if (this.world && this.ground.valid) {
      started = this.crashSys.begin(ac, this.view, this.crashWorld(), this.env.rho, this.wv, obstacle ? this.snap : null, extraBreak)
    }
    this.crashShown = false
    if (!started) this.showCrashPanel()
  }

  private showCrashPanel(): void {
    this.crashShown = true
    const info = this.ac.crash
    if (!info) return
    $('crash-title').textContent = info.title
    $('crash-detail').textContent = info.detail
    const card = $('crash').querySelector('.card') as HTMLElement
    let extra = document.getElementById('crash-damage')
    if (!extra) {
      extra = document.createElement('div')
      extra.id = 'crash-damage'
      $('crash-detail').after(extra)
    }
    extra.textContent = ''
    if (this.crashSys.active) {
      const s = this.crashSys.summary()
      for (const line of [s.damage, s.seat, s.fire].filter(Boolean)) {
        const p = document.createElement('p')
        p.textContent = line
        extra.appendChild(p)
      }
    }
    // el panel abajo y sin tapar los restos: se puede seguir mirando con el ratón
    const el = $('crash')
    el.style.alignItems = this.crashSys.active ? 'flex-end' : ''
    el.style.background = this.crashSys.active ? 'transparent' : ''
    el.style.pointerEvents = this.crashSys.active ? 'none' : ''
    card.style.pointerEvents = 'auto'
    el.classList.remove('hidden')
  }

  /** El escenario visto por la física de accidentes. */
  private crashWorld(): CrashWorld {
    const w = this.world!
    if (this.crashWorldCache?.w === w) return this.crashWorldCache.cw
    const google = w.mode === 'google'
    const s: GroundSample = { y: 0, normal: new Vector3() }
    const n = new Vector3()
    const self = this
    const cw: CrashWorld = {
      mode: google ? 'google' : 'terrain',
      // con Google el suelo son las teselas; la altura solo hace de red de seguridad (plano local)
      heightAt: google
        ? (x, z) => (this.ground.valid ? this.ground.heightAt(x, z, n) : null)
        : (x, z) => (w.sampleGround(x, z, this.ac.pos.y + 500, s) ? s.y : null),
      meshes: function* () {
        if (google) yield* ((w as any).meshes as Set<Mesh>) ?? []
        const g = w.buildings?.group
        if (g) {
          const list: Mesh[] = []
          g.traverse((o) => {
            if ((o as Mesh).isMesh && !(o as any).isInstancedMesh) list.push(o as Mesh)
          })
          yield* list
        }
        if (w.bridges) yield* w.bridges.meshes()
        // apoyos y cables de los tendidos de alrededor (cajas y cintas para los restos)
        const pm = w.power?.collisionMesh(self.ac.pos, 60)
        if (pm) yield pm
      },
      wiresNear: w.power ? (p, r, out) => w.power!.wiresNear(p, r, out) : undefined,
      obstacleAt: (p) => w.hitsObstacle(p),
      inFoliage: w.trees ? (p) => w.trees!.collides(p) : undefined,
      // agua (mar, lagos, ríos): los restos flotan, se llenan y se van al fondo
      waterAt: (x, z) => {
        const ws = w.waterSample(x, self.ac.pos.y, z)
        if (!ws || ws.water < 0.5) return 0
        // (en pendiente es la orilla seca de un embalse bajo, aunque el mapa la dé por agua)
        return w.sampleGround(x, z, self.ac.pos.y + 500, s) && s.normal.y < 0.998 ? 0 : ws.depth
      },
      raycast: google ? (o, d, f) => w.raycast(o, d, f) : undefined,
    }
    this.crashWorldCache = { w, cw }
    return cw
  }

  private updateEnvMap(dt: number, worldToECEF: Matrix4): void {
    this.envTimer -= dt
    if (this.envTimer > 0) return
    this.envTimer = 2.5
    const m = this.envSky
    Object.assign(m, this.gfx.textures)
    m.sunDirection.copy(this.gfx.sunDirECEF)
    m.moonDirection.copy(this.gfx.moonDirECEF)
    m.worldToECEFMatrix.copy(worldToECEF)
    m.groundAlbedo.copy(GROUND_ALBEDO)
    m.sun = false
    this.cubeCam.position.copy(this.ac.pos)
    this.cubeCam.update(this.gfx.renderer, this.envScene)
    // siempre el mismo destino: antes cada 2,5 s se creaba otro (fuga en la GPU) y
    // se marcaban todos los materiales del aparato para recompilar (tirón periódico)
    // (los tipos piden WebGLCubeRenderTarget, pero three devuelve y acepta un WebGLRenderTarget)
    this.envRT = this.pmrem.fromCubemap(this.cubeRT.texture, this.envRT as any)
    this.envTex = this.envRT.texture
    this.view.setEnvMap(this.envTex)
    this.mp.setEnvMap(this.envTex)
    this.airTraffic.setEnvMap(this.envTex)
    this.world?.setEnvMap(this.envTex)
    this.gfx.skyLightBase = 0.35
  }

  // -------------------------------------------------------------------------
  // Acciones de teclado
  // -------------------------------------------------------------------------
  private handleActions(): void {
    for (const a of this.input.consumeActions()) {
      // en la repetición, la cámara y Esc son suyos y los mandos de pilotar no hacen nada
      if (this.replay.active && this.replay.action(a)) continue
      switch (a) {
        case 'pause':
          // en Ajustes, Esc vuelve a las pestañas del menú
          if (this.menuOpen) {
            if (!menuBack()) this.closeMenu()
          } else this.openMenu()
          break
        case 'help':
          $('help').classList.toggle('hidden')
          break
        case 'vrCenter':
          if (this.vr.active) {
            this.vr.recenter()
            this.toast(t('vr.centered'))
          }
          break
        case 'camera': {
          if (this.menuOpen) break
          if (this.vr.active) {
            this.toast(t('vr.cockpitOnly'))
            break
          }
          const m = this.rig.next(this.ac, this.ground.heightAt(this.ac.pos.x, this.ac.pos.z, this.wv2))
          this.toast(t('toast.camera', { name: camName(m) }))
          break
        }
        case 'cameraBack':
          if (!this.vr.active) this.rig.toggleLookBack()
          break
        case 'reset':
          if (this.world) this.spawn()
          break
        case 'rotorBrake':
          this.rotorBrake = !this.rotorBrake
          this.toast(t(this.rotorBrake ? 'toast.rotorBrakeOn' : 'toast.rotorBrakeOff'))
          break
        case 'engine':
          // (un motor gripado, sin combustible o con el carburador helado no arranca)
          this.toast(toggleEngine(this.ac))
          break
        case 'failure':
          // F2: simulacro del instructor o, con fallos reales, uno de verdad
          if (!this.menuOpen && this.state === 'flying') requestFailure(this.ac)
          break
        case 'parkBrake':
          this.input.parkBrake = !this.input.parkBrake
          this.toast(t(this.input.parkBrake ? 'toast.parkOn' : 'toast.parkOff'))
          break
        case 'hud': {
          // con el visor puesto no hay relojes en pantalla: la tecla enseña u oculta la tablilla de avisos
          if (this.vr.active) {
            this.toast(t(this.vr.togglePanel() ? 'vr.panelOn' : 'vr.panelOff'))
            break
          }
          // se recuerda por separado en cabina (ya tiene su panel 3D) y en las cámaras exteriores
          const cockpit = this.rig.mode === 'cockpit'
          const key = cockpit ? 'hudCockpit' : 'hudOutside'
          this.settings[key] = !this.settings[key]
          saveSettings(this.settings)
          // (updateHud lo aplica al panel y al botón en el siguiente fotograma)
          this.toast(t(`toast.hud${cockpit ? 'Cockpit' : 'Outside'}${this.settings[key] ? 'On' : 'Off'}`), 2.6)
          break
        }
        case 'lights':
          this.toggleLights()
          break
        case 'guide':
          if (!this.menuOpen) this.guide.toggle()
          break
        case 'spray':
          if (!this.menuOpen && this.state === 'flying') this.toast(this.spray.toggle())
          break
        case 'gear':
          // tren de unos flotadores anfibios (floatKit.ts): sube o baja en unos segundos
          if (!this.menuOpen && this.state === 'flying' && this.ac.af.amphib) {
            this.ac.setGear(!this.ac.gearDown)
            this.toast(t(this.ac.gearDown ? 'toast.gearDown' : 'toast.gearUp'))
          } else if (!this.menuOpen && this.state === 'flying' && this.ac.af.retractGear) {
            // tren retráctil (Sigilo): en tierra no se puede recoger
            if (this.ac.gearDown && this.ac.onGround) break
            this.ac.setGear(!this.ac.gearDown)
            this.toast(t(this.ac.gearDown ? 'toast.retractDown' : 'toast.retractUp'))
          }
          break
        case 'mouseStick':
          this.input.mouseStick = !this.input.mouseStick
          this.settings.mouseStick = this.input.mouseStick
          saveSettings(this.settings)
          this.toast(t(this.input.mouseStick ? 'toast.mouseStickOn' : 'toast.mouseStickOff'))
          break
        case 'wheelMode':
          this.input.wheelThrottle = !this.input.wheelThrottle
          this.toast(t(this.input.wheelThrottle ? 'toast.wheelThrottle' : 'toast.wheelZoom'))
          break
        case 'zoomIn':
          this.rig.zoom(-1)
          break
        case 'zoomOut':
          this.rig.zoom(1)
          break
        case 'telemetry':
          this.setTelemetry(!this.telemetry.visible)
          break
      }
    }
  }

  /** Panel de telemetría (tecla F3 o Ajustes › Gráficos); se recuerda entre partidas. */
  private setTelemetry(on: boolean): void {
    this.telemetry.visible = on
    this.settings.telemetry = on
    ;($('telemetry-opt') as HTMLInputElement).checked = on
    saveSettings(this.settings)
  }

  /** Luces exteriores (botón de la barra superior o tecla L). */
  private toggleLights(): void {
    const l = this.view.lights
    l.on = !l.on
    const b = $('btn-lights')
    b.classList.toggle('on', l.on)
    b.setAttribute('aria-pressed', String(l.on))
    this.toast(t(l.on ? 'toast.lightsOn' : 'toast.lightsOff'))
  }

  private toast(msg: string, secs = 1.8): void {
    const el = $('toast')
    el.textContent = msg
    el.classList.add('show')
    this.toastTimer = secs
  }

  // -------------------------------------------------------------------------
  // HUD y sonido
  // -------------------------------------------------------------------------
  private updateHud(dt: number): void {
    // relojes en pantalla según la cámara (tecla I): en cabina y fuera se recuerdan por separado
    const hudOn = this.rig.mode === 'cockpit' ? this.settings.hudCockpit : this.settings.hudOutside
    if (hudOn !== this.hud.visible || !this.hudBtnSynced) {
      this.hud.visible = hudOn
      this.hudBtnSynced = true
      const b = $('btn-hud')
      b.classList.toggle('on', hudOn)
      b.setAttribute('aria-pressed', String(hudOn))
    }
    // botón «Tren» (tecla Y): solo con tren que se recoge; en la repetición, donde estaba el grabado
    const af = this.ac.af
    this.gearBtn.update(af.amphib ? 'amphib' : af.retractGear ? 'retract' : null, this.replay.active ? this.replay.ac.gearPos : this.ac.gearPos)
    // repetición: instrumentos y cabina con lo grabado
    if (this.replay.active) return this.replay.updateHud(dt)
    const ac = this.ac
    const w = this.world
    const sf = ac.specificForceBody
    const geo = w ? w.frame.worldToGeo(ac.pos) : { lat: 0, lon: 0, h: 0 }
    const msl = w && w.mode === 'google' ? geo.h - (this.location?.geoid ?? 0) : geo.h
    // altímetro calado al QNH del día: con calor marca menos de la altura real (en ISA, la real)
    const altFt = this.air.altimeter(msl - 1.05) * 3.28084
    const hdg = (((headingOf(ac) * 180) / Math.PI) + 360) % 360
    const ws = this.wind.settings
    const show = this.state !== 'loading' && !this.menuOpen
    let hd: HudData | null = null
    if (!show) {
      this.hud.draw(
        { ...EMPTY_HUD, warnings: [] },
        dt,
      )
      ;($('hud') as HTMLCanvasElement).style.opacity = '0'
    } else {
      ;($('hud') as HTMLCanvasElement).style.opacity = '1'
      const pph = powerplantHud(ac)
      hd = {
          iasKmh: ac.ias * 3.6,
          altFt,
          vsFpm: ac.vs * this.air.vsiFactor(msl) * 196.85,
          rotorRpm: ac.rotor.rpm,
          engineRpm: ac.engineOn || ac.engineRpm > 50 ? ac.engineRpm : 0,
          heading: hdg,
          slip: Math.max(-1, Math.min(1, (-sf.z / Math.max(0.3, sf.y)) * 4)),
          trim: this.input.trim,
          throttle: this.input.throttle,
          g: ac.gLoad,
          agl: Math.max(0, ac.agl),
          gsKmh: ac.groundSpeed * 3.6,
          windFrom: ws.fromDeg,
          windKt: ws.speed / KT,
          warnings: this.state === 'flying' ? [...ac.warnings, ...pph.warnings] : [],
          cautions: this.state === 'flying' ? pph.cautions : [],
          fuel: pph.fuel,
          fuelL: pph.fuelL,
          fuelLow: pph.fuelLow,
          oilLow: pph.oilLow,
          drill: pph.drill,
          // (con cuerda, el C.6: encendido mientras tiran de ella)
          prerot: ac.af.ropeStart ? ac.ropeLeft > 0 : this.ctl.prerotator,
          rotorBrake: this.rotorBrake,
          parkBrake: this.input.parkBrake,
          engineOn: ac.engineOn,
          camName: camName(this.rig.mode),
          onGround: ac.onGround,
          stickPitch: this.ctl.pitch,
          stickRoll: this.ctl.roll,
          pedals: this.ctl.yaw,
          mouseStick: this.input.mouseStick,
          wheelThrottle: this.input.wheelIsThrottle,
          beta: ac.tas > 5 ? ac.beta : 0,
          cockpit: this.rig.mode === 'cockpit',
          hint: this.pilotHint(),
          rpmScale: ac.rpmScale,
          rpmWarn: ac.rpmWarnScale,
          rotorArcs: ac.af.slowedRotor ? { green: [100, 380], red: 400 } : undefined,
          tach: ac.af.engine.tach,
          asi: ac.af.asi,
          gear: ac.af.amphib || ac.af.retractGear ? (ac.gearPos >= 1 ? 'down' : ac.gearPos <= 0 ? 'up' : 'moving') : undefined,
        }
      this.hud.draw(hd, dt)
      this.replay.noteHud(hd)
      this.vrHud = hd
    }
    // hilo de guiñada (siempre) y panel de instrumentos 3D (en cabina o con la cámara cerca)
    this.view.cockpit.update(dt, ac, this.wv, this.gfx.camera.position, this.hud, hd, this.rig.mode === 'cockpit' || this.gfx.camera.position.distanceTo(ac.pos) < 6)
    const st = $('status')
    const txt = `${this.location ? locationName(this.location) : ''} · ${geo.lat.toFixed(4)}° ${geo.lon.toFixed(4)}° · ${Math.round(altFt)} ft · ${Math.round(this.fps)} fps`
    if (st.textContent !== txt && Math.random() < 0.2) st.textContent = txt
  }

  /** Indicaciones de pilotaje (solo con la ayuda activada). */
  private pilotHint(): string {
    const ac = this.ac
    if (!this.settings.assist || this.state !== 'flying') return ''
    if (!ac.onGround && this.input.throttle < 0.5 && ac.vs < -2.5 && ac.agl < 9 && ac.agl > 1.5 && !this.assist.flaring)
      return t('hint.flare')
    if (ac.onGround && ac.groundSpeed > 8 && ac.rotor.rpm < 170 * ac.rpmWarnScale && this.input.throttle > 0.5)
      return t('hint.lowRotor')
    if (!ac.onGround && ac.agl > 3 && ac.agl < 60 && ac.ias * 3.6 < 60 && this.input.throttle > 0.7 && ac.vs < 1.5)
      return t('hint.backside')
    return ''
  }

  private updateSound(dt: number): void {
    if (this.replay.active) return this.sound.update(this.replay.soundState(), dt)
    const ac = this.ac
    const cam = this.gfx.camera
    this.sound.update(
      {
        engineRpm: ac.engineRpm,
        power: ac.enginePower / ac.maxPower,
        rotorRpm: ac.rotor.rpm,
        rotorLoad: ac.rotor.thrust / (ac.mass * 9.81),
        tas: ac.tas,
        rolling: ac.onGround ? ac.wheelRolling : 0,
        // (sin prerrotador, el C.6: la tecla solo llama al personal de tierra)
        prerot: this.ctl.prerotator && ac.engineOn && !ac.af.ropeStart,
        lowRotor: this.state === 'flying' && !ac.onGround && ac.rotor.rpm < 260 * ac.rpmWarnScale,
        teeterHit: ac.rotor.teeterHit,
        cockpit: this.rig.mode === 'cockpit' && !this.menuOpen,
        distance: cam.position.distanceTo(ac.pos),
        engineOn: ac.engineOn,
        // tirones y cortes de un motor que falla (sim/powerplant.ts)
        misfire: ac.pp.rough,
        firing: ac.pp.power,
        voice: {
          cylinders: ac.af.engine.cylinders,
          gear: ac.af.engine.gear,
          propBlades: ac.af.propBlades ?? 3,
          rotorBlades: ac.af.rotor.blades,
          rpmMax: ac.af.engine.tach.green[1],
          rotorRpm: 380 * ac.rpmScale,
        },
      },
      dt,
    )
  }

  // -------------------------------------------------------------------------
  // Menú
  // -------------------------------------------------------------------------
  private openMenu(): void {
    this.menuOpen = true
    $('menu').classList.remove('hidden')
    this.sound.suspend()
    // tras un accidente, el menú enseña ya el aparato entero en la salida (lo que haría «Volar»):
    // así lo que se elija en él se ve detrás, como antes de salir
    if (this.state === 'crashed' && this.world) this.newDeparture()
    this.refreshMenu()
  }

  private closeMenu(): void {
    this.menuOpen = false
    $('menu').classList.add('hidden')
    this.sound.start()
    this.last = performance.now()
    this.departed = true
  }

  /** Se ha jugado desde la última salida (el botón del menú dice «Continuar» en vez de «Volar»). */
  private departed = false

  /** Salida nueva con lo elegido en el menú: aparato, pasajero, sitio, modo de salida y escenario. */
  private newDeparture(): void {
    const s = this.settings
    this.loadAircraft()
    this.lastStart = s.start
    this.lastPassenger = s.passenger
    // (huso horario del sitio)
    this.applySettings(false)
    this.spawn()
  }

  private setupMenu(): void {
    const s = this.settings
    applyI18n()
    // salida desde el mapa del mundo o desde un lugar emblemático (src/menu/locationSelect.ts)
    buildLocationSelect($('location') as HTMLSelectElement, s, () => {
      refreshMenuUi()
      this.schedulePreview()
    })
    const acSel = $('aircraft') as HTMLSelectElement
    for (const a of AIRCRAFT) {
      const o = document.createElement('option')
      o.value = a.id
      o.textContent = a.name
      acSel.appendChild(o)
    }
    acSel.addEventListener('change', () => {
      s.aircraft = acSel.value
      $('aircraftNote').textContent = aircraftNote(aircraftById(s.aircraft))
      this.previewMenu()
    })

    const bindRange = (id: keyof Settings, out: string, fmt: (v: number) => string) => {
      const el = $(id) as HTMLInputElement
      const o = $(out)
      el.addEventListener('input', () => {
        ;(s as any)[id] = Number(el.value)
        o.textContent = fmt(Number(el.value))
        this.applySettings(false)
      })
    }
    bindRange('hour', 'hourOut', fmtHour)
    bindRange('dayOfYear', 'dayOut', fmtDay)
    bindRange('windFrom', 'windFromOut', (v) => `${String(v).padStart(3, '0')}°`)
    bindRange('windSpeed', 'windSpeedOut', (v) => `${v} kt`)
    bindRange('turbulence', 'turbOut', (v) => `${Math.round(v * 100)} %`)
    bindRange('exposure', 'expOut', (v) => v.toFixed(1))
    bindRange('volume', 'volOut', (v) => `${Math.round(v * 100)} %`)
    // (el escenario y el modo de salida se ven ya detrás del menú)
    for (const r of document.querySelectorAll<HTMLInputElement>('input[name=scenery]'))
      r.addEventListener('change', () => {
        s.scenery = r.value as any
        this.schedulePreview()
      })
    for (const r of document.querySelectorAll<HTMLInputElement>('input[name=start]'))
      r.addEventListener('change', () => {
        s.start = r.value as any
        this.schedulePreview()
      })
    const bindVal = (id: keyof Settings, num = false) => {
      const el = $(id) as HTMLInputElement | HTMLSelectElement
      el.addEventListener('change', () => {
        ;(s as any)[id] = num ? Number(el.value) : el.value
        if (id === 'quality' || id === 'clouds') this.applySettings(false)
        if (id === 'imagery' || id === 'elevation' || id === 'googleKey') this.schedulePreview()
      })
    }
    bindVal('googleKey')
    bindVal('imagery')
    bindVal('elevation')
    bindVal('customLat', true)
    bindVal('customLon', true)
    bindVal('customHeading', true)
    // coordenadas escritas a mano: la salida pasa a ser esas coordenadas (sin el nombre del mapa)
    for (const id of ['customLat', 'customLon', 'customHeading']) {
      $(id).addEventListener('change', () => {
        if (id !== 'customHeading') s.customName = ''
        s.locationId = 'custom'
        s.mapLocationId = 'custom'
        this.showLocationNote()
        this.schedulePreview()
      })
    }
    $('btn-worldmap').addEventListener('click', () => this.openWorldMap())
    bindVal('clouds')
    bindVal('quality')
    bindVal('axisPitch', true)
    bindVal('axisRoll', true)
    bindVal('axisYaw', true)
    bindVal('axisThrottle', true)
    ;($('googleKey') as HTMLInputElement).addEventListener('input', (e) => {
      s.googleKey = (e.target as HTMLInputElement).value.trim()
      if (s.googleKey) (document.querySelector('input[name=scenery][value=google]') as HTMLInputElement).checked = true
      if (s.googleKey) s.scenery = 'google'
    })
    const bindCheck = (id: keyof Settings) => {
      const el = $(id) as HTMLInputElement
      el.addEventListener('change', () => {
        ;(s as any)[id] = el.checked
        if (id === 'mouseStick') this.input.mouseStick = el.checked
        // (edificios, árboles y Catastro: el escenario se rehace detrás del menú)
        if (id === 'buildings' || id === 'trees' || id === 'catastro') this.schedulePreview()
      })
    }
    bindCheck('passenger')
    $('passenger').addEventListener('change', () => this.previewMenu())
    bindCheck('floats')
    $('floats').addEventListener('change', () => this.previewMenu())
    // combustible al salir y fallos de motor (src/menu/fuelMenu.ts): los fallos cambian ya en vuelo
    setupFuelMenu(s, () => {
      if (this.state !== 'loading') applyPowerplantSettings(this.ac, s, false)
    })
    bindCheck('buildings')
    bindCheck('trees')
    bindCheck('traffic')
    bindCheck('airTraffic')
    bindVal('airTrafficDensity')
    bindCheck('power')
    bindCheck('terrainWind')
    $('terrainWind').addEventListener('change', () => this.applySettings(false))
    bindCheck('catastro')
    setupCatastroMenu()
    bindCheck('assist')
    bindCheck('invertPitch')
    bindCheck('mouseStick')
    bindCheck('invertThrottle')
    const telOpt = $('telemetry-opt') as HTMLInputElement
    telOpt.checked = s.telemetry
    telOpt.addEventListener('change', () => this.setTelemetry(telOpt.checked))

    $('btn-fly').addEventListener('click', () => this.fly())
    $('btn-help').addEventListener('click', () => $('help').classList.toggle('hidden'))
    // sin foco tras el clic: si no, Espacio (frenos) volvería a pulsar el botón
    $('btn-lights').addEventListener('mousedown', (e) => e.preventDefault())
    $('btn-lights').addEventListener('click', () => this.toggleLights())
    $('btn-hud').addEventListener('mousedown', (e) => e.preventDefault())
    $('btn-hud').addEventListener('click', () => this.input.trigger('hud'))
    this.spray.button.addEventListener('click', () => this.input.trigger('spray'))
    this.gearBtn.button.addEventListener('click', () => this.input.trigger('gear'))
    $('crash-retry').addEventListener('click', () => {
      this.spawn()
      this.closeMenu()
    })
    $('crash-menu').addEventListener('click', () => {
      $('crash').classList.add('hidden')
      this.openMenu()
    })
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-close]'))
      b.addEventListener('click', () => $(b.dataset.close!).classList.add('hidden'))
    // idioma (src/i18n.ts): se guarda en este navegador
    for (const r of document.querySelectorAll<HTMLInputElement>('input[name=lang]'))
      r.addEventListener('change', () => r.checked && setLang(r.value as Lang))
    onLangChange(() => {
      this.guide.refresh()
      this.localizeMenu()
      this.refreshMenu()
    })
    this.localizeMenu()

    // pestañas, tarjetas, plan de vuelo y pantalla de ajustes (src/menu/menuUi.ts)
    setupMenuUi({
      settings: s,
      location: () => this.currentLocation(),
      canFly: () => this.menuOpen && !this.worldMap.isOpen && $('help').classList.contains('hidden'),
      fly: () => this.fly(),
    })
    // temperatura, QNH y tiempo real (src/menu/weatherMenu.ts)
    setupWeatherMenu({
      settings: s,
      location: () => this.currentLocation(),
      simElevation: (loc) => {
        const w = this.world
        const here = this.location
        if (!w || !here || this.state === 'loading' || loc.lat !== here.lat || loc.lon !== here.lon) return null
        return w.mode === 'google' ? this.groundEllipsoid - here.geoid : this.groundEllipsoid
      },
      changed: () => this.applySettings(false),
      applied: () => {
        this.refreshMenu()
        this.applySettings(false)
        saveSettings(s)
      },
      refresh: () => refreshMenuUi(),
    })
    // visibilidad, precipitación y punto de rocío (src/menu/skyMenu.ts)
    setupSkyMenu({
      settings: s,
      changed: () => {
        this.applySettings(false)
        this.refreshMenu()
      },
      weather: () => this.wx.state,
      groundTempC: () => this.air.groundTempC(),
    })
    this.refreshMenu()
    // ejes del joystick en vivo
    setInterval(() => {
      if (!this.menuOpen) return
      const pads = navigator.getGamepads?.() ?? []
      const gp = pads.find((p) => p && p.connected)
      $('padName').textContent = gp ? `· ${gp.id.slice(0, 40)}` : t('pad.none')
      $('axesLive').textContent = gp ? gp.axes.map((a, i) => `${i}:${a.toFixed(2)}`).join('  ') : ''
      updateAxisBars(gp ?? null, s)
    }, 150)
  }

  /** Textos del menú que se generan desde código (lugares y aparatos). */
  private localizeMenu(): void {
    localizeLocationSelect($('location') as HTMLSelectElement, this.settings)
    for (const o of ($('aircraft') as HTMLSelectElement).options) o.textContent = aircraftName(aircraftById(o.value))
    this.showLocationNote()
  }

  private showLocationNote(): void {
    showDeparture(this.settings)
  }

  /** Mapa del mundo: elegir la salida pinchando en el globo, en un aeródromo o una pista. */
  private openWorldMap(): void {
    const s = this.settings
    const loc = this.currentLocation()
    this.worldMap.open(
      { locationId: s.locationId, lat: loc.lat, lon: loc.lon, heading: loc.heading, name: locationName(loc), start: s.start, windFrom: s.windFrom },
      (p, fly) => this.applyMapPick(p, fly),
    )
  }

  private applyMapPick(p: MapPick, fly: boolean): void {
    const s = this.settings
    if (p.kind === 'location') s.locationId = p.id
    else {
      s.mapLocationId = 'custom'
      s.locationId = 'custom'
      s.customLat = Math.round(p.lat * 1e6) / 1e6
      s.customLon = Math.round(p.lon * 1e6) / 1e6
      s.customHeading = Math.round(p.heading * 100) / 100
      s.customName = p.name
    }
    s.start = p.start
    this.refreshMenu()
    this.localizeMenu()
    this.applySettings(false) // huso horario del nuevo sitio
    saveSettings(s)
    if (fly) this.fly()
    else this.previewMenu()
  }

  private refreshMenu(): void {
    const s = this.settings
    const set = (id: string, v: string | number | boolean) => {
      const el = $(id) as HTMLInputElement
      if (el.type === 'checkbox') el.checked = Boolean(v)
      else el.value = String(v)
    }
    set('googleKey', s.googleKey)
    set('imagery', s.imagery)
    set('elevation', s.elevation)
    set('buildings', s.buildings)
    set('trees', s.trees)
    set('traffic', s.traffic)
    set('airTraffic', s.airTraffic)
    set('airTrafficDensity', s.airTrafficDensity)
    set('power', s.power)
    set('catastro', s.catastro)
    syncCurrentDeparture($('location') as HTMLSelectElement, s)
    set('location', s.locationId)
    set('customLat', s.customLat)
    set('customLon', s.customLon)
    set('customHeading', Math.round(s.customHeading || 0))
    set('hour', s.hour)
    set('dayOfYear', s.dayOfYear)
    set('windFrom', s.windFrom)
    set('windSpeed', s.windSpeed)
    set('turbulence', s.turbulence)
    set('terrainWind', s.terrainWind)
    set('clouds', s.clouds)
    syncAirControls(s)
    syncSkyControls(s)
    set('quality', s.quality)
    set('exposure', s.exposure)
    set('volume', s.volume)
    set('passenger', s.passenger)
    set('floats', s.floats)
    set('aircraft', aircraftById(s.aircraft).id)
    $('aircraftNote').textContent = aircraftNote(aircraftById(s.aircraft))
    this.showLocationNote()
    set('assist', s.assist)
    set('invertPitch', s.invertPitch)
    set('mouseStick', this.input.mouseStick)
    set('axisPitch', s.axisPitch)
    set('axisRoll', s.axisRoll)
    set('axisYaw', s.axisYaw)
    set('axisThrottle', s.axisThrottle)
    set('invertThrottle', s.invertThrottle)
    ;(document.querySelector(`input[name=scenery][value=${s.scenery}]`) as HTMLInputElement).checked = true
    ;(document.querySelector(`input[name=start][value=${s.start}]`) as HTMLInputElement).checked = true
    $('hourOut').textContent = fmtHour(s.hour)
    $('dayOut').textContent = fmtDay(s.dayOfYear)
    $('windFromOut').textContent = `${String(s.windFrom).padStart(3, '0')}°`
    $('windSpeedOut').textContent = `${s.windSpeed} kt`
    $('turbOut').textContent = `${Math.round(s.turbulence * 100)} %`
    $('expOut').textContent = s.exposure.toFixed(1)
    $('volOut').textContent = `${Math.round(s.volume * 100)} %`
    const gi = $('gpuInfo')
    const gpuName = this.gfx.gpuName.replace(/[<>&"]/g, '')
    // solo si cambia: reescribirlo cerraría el desplegable cada vez que se toca un ajuste
    const giKey = `${this.gfx.gpuIntegrated}|${gpuName}|${getLang()}`
    if (gi.dataset.key !== giKey) {
      gi.dataset.key = giKey
      gi.innerHTML = this.gfx.gpuIntegrated
        ? `${t('gpu.integrated', { name: gpuName })}
           <details><summary>${t('gpu.howto')}</summary>${gpuHelpHtml()}</details>`
        : `GPU: ${gpuName}`
    }
    gi.classList.toggle('warn', this.gfx.gpuIntegrated)
    this.updateFlyLabel()
    refreshMenuUi()
  }

  /**
   * Menú: lo elegido se ve ya detrás (aparato, pasajero, flotadores, salida, modo de salida y
   * escenario). Hace lo mismo que haría «Volar»: en el aire, otro aparato o el pasajero se cambian
   * sin más; si no, se vuelve a salir con lo elegido (en el suelo las ruedas no apoyan en el mismo
   * sitio). En una sala, otra salida movería a todos: esa espera a «Volar» (el pasajero se ve igual).
   */
  private previewMenu(): void {
    clearTimeout(this.previewTimer)
    const s = this.settings
    this.view.setPassenger(s.passenger)
    if (!this.world || !this.location) return
    // (Google sin clave: lo avisa «Volar»)
    if (s.scenery === 'google' && !s.googleKey) return
    if (this.state === 'crashed' || this.departureChanged()) {
      if (this.mp.inRoom && this.state !== 'crashed') return
      this.newDeparture()
    } else {
      this.loadAircraft()
      const airframe = airframeById(s.aircraft, s.floats)
      const airframeChanged = airframe !== this.ac.af
      const passengerChanged = s.passenger !== this.lastPassenger
      if (!airframeChanged && !passengerChanged) return
      if (this.airborne()) {
        if (airframeChanged) {
          this.ac.setAirframe(airframe)
          applyPowerplantSettings(this.ac, s, true)
        }
        if (passengerChanged) this.ac.setLoad(s.passenger)
        this.lastPassenger = s.passenger
      } else this.newDeparture()
    }
    this.updateFlyLabel()
  }

  private previewTimer = 0

  /** Lo mismo, un momento después: al pasar sitios con las flechas no se carga cada uno. */
  private schedulePreview(): void {
    clearTimeout(this.previewTimer)
    this.previewTimer = window.setTimeout(() => this.menuOpen && this.previewMenu(), 400)
  }

  /** La salida elegida no es la del aparato: otro sitio, otro modo de salida u otro escenario. */
  private departureChanged(): boolean {
    const loc = this.currentLocation()
    const here = this.location
    return (
      !this.world ||
      !here ||
      this.worldKeyFor(loc) !== this.worldKey ||
      loc.id !== here.id ||
      loc.lat !== here.lat ||
      loc.lon !== here.lon ||
      loc.heading !== here.heading ||
      this.lastStart !== this.settings.start
    )
  }

  /** En vuelo (ni en tierra ni a flote): ahí otro aparato se cambia sin volver a salir. */
  private airborne(): boolean {
    return this.state === 'flying' && !this.ac.onGround && !this.ac.onWater
  }

  /** «Continuar» con un vuelo en marcha; «Volar» si se va a salir (también tras elegir otra salida). */
  private updateFlyLabel(): void {
    $('flyLabel').textContent = t(this.departed && this.state !== 'crashed' && this.world ? 'menu.continue' : 'menu.fly')
  }

  /** Botón Volar: re-aparece si cambió el escenario/lugar; si no, continúa. */
  private fly(): void {
    clearTimeout(this.previewTimer)
    const s = this.settings
    if (s.scenery === 'google' && !s.googleKey) {
      alert(t('alert.googleKey'))
      return
    }
    saveSettings(s)
    this.loadAircraft()
    // Cada aparato tiene su geometría de vuelo. En el aire se cambia sin más; en
    // el suelo hay que recolocarlo (las ruedas no apoyan en el mismo sitio).
    const airframe = airframeById(s.aircraft, s.floats)
    const airframeChanged = airframe !== this.ac.af
    const swapInFlight = airframeChanged && this.airborne()
    if (swapInFlight) {
      this.ac.setAirframe(airframe)
      applyPowerplantSettings(this.ac, s, true)
    }
    const needSpawn =
      this.departureChanged() ||
      (airframeChanged && !swapInFlight) ||
      this.lastPassenger !== s.passenger ||
      this.state === 'crashed'
    this.lastStart = s.start
    this.lastPassenger = s.passenger
    this.applySettings(false)
    if (needSpawn) this.spawn()
    else {
      // otro combustible con el aparato parado en la salida: se llena (o vacía) el depósito
      const parked = this.ac.onGround && this.ac.vel.length() < 0.5
      applyPowerplantSettings(this.ac, s, parked && this.lastFuelPct !== s.fuelPct)
      if (parked) this.lastFuelPct = s.fuelPct
    }
    this.closeMenu()
    this.rig.setMode(this.rig.mode, this.ac, this.ground.valid ? this.ground.heightAt(this.ac.pos.x, this.ac.pos.z, this.wv2) : 0)
  }
  private lastStart = ''
  private lastPassenger = false
  private lastFuelPct = 100

  /** Multijugador (invitado): el anfitrión fija lugar, hora, viento y nubes de la sala. */
  private applyRoomConditions(c: RoomConditions): void {
    const s = this.settings
    s.locationId = c.locationId
    s.customLat = c.customLat
    s.customLon = c.customLon
    // (anfitriones de versiones anteriores no los mandan)
    s.customHeading = c.customHeading ?? 0
    s.customName = c.customName ?? ''
    s.hour = c.hour
    s.dayOfYear = c.dayOfYear
    s.windFrom = c.windFrom
    s.windSpeed = c.windSpeed
    s.turbulence = c.turbulence
    // (anfitriones de versiones anteriores no lo mandan: viento uniforme, como el suyo)
    s.terrainWind = c.terrainWind ?? false
    // aire del día (anfitriones de versiones anteriores no lo mandan: atmósfera estándar)
    s.isa = c.isa ?? true
    s.oatC = c.oatC ?? 15
    s.qnh = c.qnh ?? 1013.25
    s.dewPointC = c.dewPointC ?? s.oatC - 10
    s.visibility = c.visibility ?? 30000
    s.precip = c.precip ?? 0
    s.weatherCode = c.weatherCode ?? -1
    s.windGustKt = c.windGustKt ?? 0
    if (['clear', 'fair', 'scattered', 'overcast'].includes(c.clouds)) s.clouds = c.clouds as Settings['clouds']
    this.applySettings(false)
    this.refreshMenu()
    // si la sala está en otro sitio y ya estamos volando, nos lleva allí
    const loc = this.currentLocation()
    const moved = !this.location || loc.id !== this.location.id || loc.lat !== this.location.lat || loc.lon !== this.location.lon
    if (moved && this.world && !this.menuOpen) {
      this.spawn()
      this.toast(t('toast.roomLocation', { name: locationName(loc) }))
    }
  }

  private applySettings(initial: boolean): void {
    const s = this.settings
    this.wind.settings = { fromDeg: s.windFrom, speed: s.windSpeed * KT, turbulence: s.turbulence }
    this.windField.setConditions({ enabled: s.terrainWind, fromDeg: s.windFrom, speed: s.windSpeed * KT, clouds: s.clouds, dayOfYear: s.dayOfYear })
    if (!s.terrainWind) this.wind.local = null
    this.air.set(s)
    // el mismo viento riza el agua
    this.gfx.water.setWind(s.windFrom, s.windSpeed * KT)
    this.gfx.renderer.toneMappingExposure = s.exposure
    this.sound.volume = s.volume
    // fecha y hora local → UTC
    const loc = this.currentLocation()
    // (España: hora oficial, Canarias una menos; fuera, la solar redondeada; también la usa el menú)
    const tz = localUtcOffset(loc.lat, loc.lon, s.dayOfYear)
    const ms = Date.UTC(2026, 0, 1) + (s.dayOfYear - 1) * 86400e3 + (s.hour - tz) * 3600e3
    this.simDate = new Date(ms)
    this.gfx.setDate(this.simDate)
    // bruma, niebla y precipitación del día (y la base de las nubes que sale del punto de rocío)
    this.wx.apply(s, loc.lat, loc.lon, this.simDate, this.air)
    if (initial) {
      this.lastStart = s.start
      this.lastPassenger = s.passenger
      this.gfx.setQuality(this.quality)
      this.spawn()
    } else {
      this.gfx.setQuality(this.quality, this.world?.realGeometry ?? false)
      this.world?.applyQuality(this.quality)
      if (this.state === 'flying') this.gfx.setClouds(s.clouds, this.groundEllipsoid, this.quality, this.wx.cloudBaseAgl)
    }
    void LIGHT_LAYER
  }
}

const EMPTY_HUD = {
  iasKmh: 0,
  altFt: 0,
  vsFpm: 0,
  rotorRpm: 0,
  engineRpm: 0,
  heading: 0,
  slip: 0,
  trim: 0,
  throttle: 0,
  g: 1,
  agl: 0,
  gsKmh: 0,
  windFrom: 0,
  windKt: 0,
  warnings: [] as string[],
  prerot: false,
  rotorBrake: false,
  parkBrake: false,
  engineOn: false,
  camName: '',
  onGround: true,
  stickPitch: 0,
  stickRoll: 0,
  pedals: 0,
  mouseStick: false,
  wheelThrottle: false,
  beta: 0,
  cockpit: false,
  hint: '',
}

function fmtHour(h: number): string {
  const hh = Math.floor(h)
  const mm = Math.round((h - hh) * 60)
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

function fmtDay(d: number): string {
  const date = new Date(Date.UTC(2026, 0, 1) + (d - 1) * 86400e3)
  return date.toLocaleDateString(locale(), { day: 'numeric', month: 'long', timeZone: 'UTC' })
}

new App()
