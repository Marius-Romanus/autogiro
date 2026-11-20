// Render: atmósfera física (Bruneton), nubes volumétricas, sol y luz del cielo
// según fecha y hora reales, sombras del aparato y posproceso HDR.

import {
  CustomBlending,
  Data3DTexture,
  DataTexture,
  FloatType,
  NearestFilter,
  RGBAFormat,
  HalfFloatType,
  LinearFilter,
  LinearMipMapLinearFilter,
  Matrix4,
  OneFactor,
  OneMinusSrcAlphaFactor,
  SrcAlphaFactor,
  ZeroFactor,
  type Material,
  Mesh,
  NoColorSpace,
  NoToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  RedFormat,
  RepeatWrapping,
  Scene,
  ShaderMaterial,
  ShadowMaterial,
  SRGBColorSpace,
  TextureLoader,
  Uniform,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
  type Texture,
} from 'three'
import {
  BlendFunction,
  BloomEffect,
  BrightnessContrastEffect,
  HueSaturationEffect,
  Effect,
  EffectComposer,
  EffectPass,
  NormalPass,
  Pass,
  RenderPass,
  SMAAEffect,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing'
import {
  AerialPerspectiveEffect,
  getMoonDirectionECEF,
  getSunDirectionECEF,
  PrecomputedTexturesLoader,
  SkyLightProbe,
  SkyMaterial,
  SunDirectionalLight,
  type PrecomputedTextures,
} from '@takram/three-atmosphere'
import { CloudsEffect } from '@takram/three-clouds'
import { DataTextureLoader, DEFAULT_STBN_URL, Geodetic, parseUint8Array, STBNLoader } from '@takram/three-geospatial'
import type { CloudPreset, Quality } from '../config.ts'
import { GroundDetailEffect } from './GroundDetailEffect.ts'
import { LandingLightEffect } from './LandingLightEffect.ts'

export const LIGHT_LAYER = 10
/**
 * Superposiciones transparentes (discos de desenfoque, vidrios): se ven, pero no
 * entran en el pase de normales; si no, el terreno de detrás se ilumina con la
 * normal del disco aunque éste sea invisible (opacidad 0 con el rotor parado).
 */
export const OVERLAY_LAYER = 12
const BASE = import.meta.env.BASE_URL

/**
 * Composición de nubes de la librería + máscara de cercanía. Las nubes se trazan a
 * 1/4 de resolución y se reconstruyen con historial temporal; en el borde de
 * geometría muy próxima (arco del parabrisas, palanca, el propio aparato visto
 * desde fuera) ese historial y el recorte por vecindario arrastran nubes del cielo
 * contiguo y "traspasan" el contorno. Si la cámara está a h metros de la capa de
 * nubes, nada a menos de h puede tener nubes delante: ahí se descartan (la neblina
 * que también va en este búfer es < 0,5 % a 100 m, imperceptible).
 */
const CLOUDS_COMPOSITE = /* glsl */ `
uniform sampler2D cloudsBuffer;
uniform float nearMask; // distancia de vista (m) por debajo de la cual no puede haber nubes

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  #ifdef SKIP_RENDERING
  outputColor = inputColor;
  #else
  vec4 clouds = texture(cloudsBuffer, uv);
  if (nearMask > 0.0 && depth < 1.0 - 1e-7) {
    float d = -perspectiveDepthToViewZ(depth, cameraNear, cameraFar);
    clouds *= smoothstep(0.6 * nearMask, nearMask, d);
  }
  outputColor.rgb = inputColor.rgb * (1.0 - clouds.a) + clouds.rgb;
  outputColor.a = inputColor.a * (1.0 - clouds.a) + clouds.a;
  #endif
}`
const _camEcef = new Vector3()
const _camGeo = new Geodetic()

export class Graphics {
  readonly renderer: WebGLRenderer
  readonly scene = new Scene()
  readonly camera: PerspectiveCamera
  readonly composer: EffectComposer
  readonly aerial: AerialPerspectiveEffect
  readonly clouds: CloudsEffect
  readonly sunLight: SunDirectionalLight
  readonly skyLight: SkyLightProbe
  readonly sky: Mesh
  readonly skyMaterial: SkyMaterial
  readonly textures: PrecomputedTextures
  readonly shadowCatcher: Mesh
  private cloudsPass: EffectPass
  private readonly maskPass: AlphaMaskPass
  readonly detail: GroundDetailEffect
  /** foco de aterrizaje sobre el terreno (tras la iluminación del efecto de atmósfera) */
  readonly landingLight: LandingLightEffect
  readonly tone: ToneMappingEffect
  readonly grade: BrightnessContrastEffect
  readonly saturation: HueSaturationEffect
  private readonly nanGuard: Effect
  readonly normalPass: NormalPass
  private readonly bloom: BloomEffect
  private readonly vignette: VignetteEffect
  private finalPass: EffectPass
  private readonly smaaPass: EffectPass
  /** normal "hacia arriba" en espacio de vista (1×1): iluminación del terreno sin pase de normales */
  private readonly flatNormal = new DataTexture(new Float32Array([0.5, 1, 0.5, 1]), 1, 1, RGBAFormat, FloatType)
  private geometryNormals = false
  private bloomOn = true
  gpuName = ''
  gpuIntegrated = false
  readonly sunDirECEF = new Vector3()
  readonly moonDirECEF = new Vector3()
  readonly sunDirWorld = new Vector3()
  cloudsEnabled = true
  /** altura elipsoidal de la base y la cima de las capas densas de nubes */
  private cloudBottom = Infinity
  private cloudTop = -Infinity
  private readonly cloudNearMask = new Uniform(0)

  constructor(container: HTMLElement) {
    const renderer = new WebGLRenderer({
      antialias: false,
      depth: false,
      stencil: false,
      logarithmicDepthBuffer: true,
      powerPreference: 'high-performance',
    })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    renderer.setSize(container.clientWidth, container.clientHeight)
    renderer.outputColorSpace = SRGBColorSpace
    renderer.toneMapping = NoToneMapping
    renderer.toneMappingExposure = 10
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = PCFShadowMap
    container.appendChild(renderer.domElement)
    this.renderer = renderer

    const camera = new PerspectiveCamera(62, container.clientWidth / container.clientHeight, 0.06, 4e6)
    camera.layers.enable(LIGHT_LAYER)
    camera.layers.enable(OVERLAY_LAYER)
    this.camera = camera

    // Texturas precalculadas de la atmósfera (incluidas en /public/atmosphere)
    this.textures = new PrecomputedTexturesLoader({ format: 'binary' }).setType(renderer).load(`${BASE}atmosphere/`)

    // Cielo (quad de pantalla)
    this.skyMaterial = new SkyMaterial()
    this.sky = new Mesh(new PlaneGeometry(2, 2), this.skyMaterial)
    this.sky.frustumCulled = false
    this.sky.renderOrder = -1
    this.scene.add(this.sky)

    // Sol y luz de cielo para los objetos con materiales iluminados (el autogiro)
    this.sunLight = new SunDirectionalLight({ distance: 60 })
    this.sunLight.castShadow = true
    this.sunLight.shadow.mapSize.set(2048, 2048)
    const sc = this.sunLight.shadow.camera
    sc.left = -9
    sc.right = 9
    sc.top = 9
    sc.bottom = -9
    sc.near = 1
    sc.far = 140
    sc.layers.enable(LIGHT_LAYER)
    this.sunLight.shadow.bias = -0.0003
    this.sunLight.shadow.normalBias = 0.05
    this.scene.add(this.sunLight)
    this.scene.add(this.sunLight.target)
    this.skyLight = new SkyLightProbe()
    this.scene.add(this.skyLight)

    // Receptor de sombra bajo el aparato (los tiles son "albedo" sin iluminar)
    this.shadowCatcher = new Mesh(
      new PlaneGeometry(40, 40),
      keepAlpha(new ShadowMaterial({ opacity: 0.62, transparent: true, depthWrite: false })),
    )
    this.shadowCatcher.receiveShadow = true
    this.shadowCatcher.renderOrder = 1
    this.scene.add(this.shadowCatcher)

    // ---- Posproceso ----
    const composer = new EffectComposer(renderer, { frameBufferType: HalfFloatType, multisampling: 0 })
    composer.addPass(new RenderPass(this.scene, camera))
    this.normalPass = new NormalPass(this.scene, camera)
    const renderNormals = this.normalPass.render.bind(this.normalPass)
    this.normalPass.render = (...args) => {
      camera.layers.disable(OVERLAY_LAYER)
      try {
        renderNormals(...args)
      } finally {
        camera.layers.enable(OVERLAY_LAYER)
      }
    }
    composer.addPass(this.normalPass)

    this.aerial = new AerialPerspectiveEffect(camera, {
      sunLight: true,
      skyLight: true,
      normalBuffer: this.normalPass.texture,
      reconstructNormal: false,
      correctGeometricError: true,
      albedoScale: 0.85,
    } as any)
    // Máscara de iluminación en el canal alfa del propio render: los materiales
    // del aparato escriben alfa = 0 (ya iluminados por las luces reales) y el
    // terreno alfa = 1 (albedo que se ilumina en posproceso). Es exacta por píxel;
    // la máscara por comparación de profundidad de la librería dejaba motas.
    this.maskPass = new AlphaMaskPass()
    composer.addPass(this.maskPass)
    ;(this.aerial as any).lightingMask = { map: this.maskPass.texture, channel: 'r' }

    this.clouds = new CloudsEffect(camera)
    // el parámetro debe llamarse "depth" para que EffectPass le pase la profundidad
    ;(this.clouds as any).setFragmentShader(CLOUDS_COMPOSITE)
    this.clouds.uniforms.set('nearMask', this.cloudNearMask)
    this.loadCloudTextures()
    this.clouds.lightShafts = false
    ;(this.aerial as any).stbnTexture = this.clouds.stbnTexture
    this.clouds.events.addEventListener('change', (e: any) => this.wireClouds(e.property))
    this.wireClouds()
    this.nanGuard = new Effect(
      'NaNGuard',
      /* glsl */ `
      // comprobación por bits: inmune a optimizaciones "fast-math" de ANGLE/D3D
      // NaN → 0; +Inf (brillos especulares que desbordan half float) → máximo
      float fixFloat(float x) {
        uint b = floatBitsToUint(x);
        if ((b & 0x7f800000u) != 0x7f800000u) return x;
        return ((b & 0x007fffffu) != 0u || (b & 0x80000000u) != 0u) ? 0.0 : 30000.0;
      }
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        vec3 c = vec3(fixFloat(inputColor.r), fixFloat(inputColor.g), fixFloat(inputColor.b));
        // alfa = 1 a partir de aquí: la máscara de iluminación ya se usó, y el lienzo
        // es transparente (alpha: true); sin SMAA (calidad baja) los píxeles con alfa 0
        // (aparato, edificios) salían negros
        outputColor = vec4(clamp(c, 0.0, 30000.0), 1.0);
      }`,
      // SRC y no NORMAL: la mezcla normal es mix(entrada, salida, 1) y NaN·0 = NaN, así
      // que el NaN pasaba igual, el bloom lo extendía por sus mipmaps y salían
      // bloques negros de media pantalla durante un fotograma
      { blendFunction: BlendFunction.SRC },
    )
    this.detail = new GroundDetailEffect(camera)
    this.landingLight = new LandingLightEffect(camera)
    this.cloudsPass = new EffectPass(camera, this.detail, this.clouds, this.aerial, this.landingLight, this.nanGuard)
    composer.addPass(this.cloudsPass)

    this.bloom = new BloomEffect({ intensity: 0.3, luminanceThreshold: 0.9, luminanceSmoothing: 0.25, mipmapBlur: true })
    this.tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC })
    this.grade = new BrightnessContrastEffect({ brightness: 0, contrast: 0.08 })
    this.saturation = new HueSaturationEffect({ saturation: 0.18 })
    this.vignette = new VignetteEffect({ offset: 0.35, darkness: 0.3 })
    this.finalPass = new EffectPass(camera, this.bloom, this.tone, this.grade, this.saturation, this.vignette)
    composer.addPass(this.finalPass)
    this.smaaPass = new EffectPass(camera, new SMAAEffect())
    composer.addPass(this.smaaPass)
    this.composer = composer

    // sombras de nubes: radio pequeño (el filtrado estocástico de la librería
    // está pensado para TAA; sin él deja un tramado de puntos sobre el terreno)
    ;(this.aerial as any).shadowRadius = 0.6
    this.flatNormal.minFilter = NearestFilter
    this.flatNormal.magFilter = NearestFilter
    this.useGeometryNormals(false)

    // GPU en uso (para avisar si es la integrada)
    const gl = renderer.getContext()
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    const raw = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : ''
    const fields = raw.replace(/^ANGLE \(/, '').replace(/\)$/, '').split(',')
    this.gpuName =
      (fields[1] ?? raw)
        .replace(/\(0x[0-9A-Fa-f]+\)/g, '')
        .replace(/Direct3D.*$/, '')
        .replace(/\((R|TM)\)/g, '')
        .replace(/\s+/g, ' ')
        .trim() || 'desconocida'
    this.gpuIntegrated = /Intel|UHD|Iris|Basic Render|SwiftShader|llvmpipe/i.test(raw) && !/\bArc\b/i.test(raw)

    this.applyTextures()

    window.addEventListener('resize', () => this.resize(container))
  }

  private applyTextures(): void {
    const t = this.textures
    Object.assign(this.skyMaterial, t)
    Object.assign(this.aerial, t)
    this.sunLight.transmittanceTexture = t.transmittanceTexture
    this.skyLight.irradianceTexture = t.irradianceTexture
    Object.assign(this.clouds, {
      irradianceTexture: t.irradianceTexture,
      scatteringTexture: t.scatteringTexture,
      transmittanceTexture: t.transmittanceTexture,
      singleMieScatteringTexture: t.singleMieScatteringTexture ?? null,
      higherOrderScatteringTexture: t.higherOrderScatteringTexture ?? null,
    })
  }

  private wireClouds(property?: string): void {
    const c = this.clouds
    const a = this.aerial as any
    if (!property || property === 'atmosphereOverlay') a.overlay = this.cloudsEnabled ? c.atmosphereOverlay : null
    if (!property || property === 'atmosphereShadow') a.shadow = this.cloudsEnabled ? c.atmosphereShadow : null
    // los rayos crepusculares (shadowLength) generan ruido sin TAA: desactivados
    a.shadowLength = null
  }

  private loadCloudTextures(): void {
    const tex2d = (url: string): Texture =>
      new TextureLoader().load(url, (t) => {
        t.minFilter = LinearMipMapLinearFilter
        t.magFilter = LinearFilter
        t.wrapS = RepeatWrapping
        t.wrapT = RepeatWrapping
        t.colorSpace = NoColorSpace
        t.needsUpdate = true
      })
    const tex3d = (url: string, size: number): Data3DTexture =>
      new DataTextureLoader(Data3DTexture, parseUint8Array, {
        width: size,
        height: size,
        depth: size,
        format: RedFormat,
        minFilter: LinearFilter,
        magFilter: LinearFilter,
        wrapS: RepeatWrapping,
        wrapT: RepeatWrapping,
        wrapR: RepeatWrapping,
        colorSpace: NoColorSpace,
      } as any).load(url) as Data3DTexture
    const c = this.clouds
    c.localWeatherTexture = tex2d(`${BASE}clouds/local_weather.png`)
    c.shapeTexture = tex3d(`${BASE}clouds/shape.bin`, 128)
    c.shapeDetailTexture = tex3d(`${BASE}clouds/shape_detail.bin`, 32)
    c.turbulenceTexture = tex2d(`${BASE}clouds/turbulence.png`)
    c.stbnTexture = new STBNLoader().load(DEFAULT_STBN_URL)
  }

  /** Configura nubes por preset. groundEllipsoid: altura elipsoidal del terreno local. */
  setClouds(preset: CloudPreset, groundEllipsoid: number, quality: Quality): void {
    const c = this.clouds
    const enabled = preset !== 'clear'
    if (enabled !== this.cloudsEnabled) {
      // reconstruye el pase (las nubes cuestan GPU incluso con cobertura 0)
      const idx = this.composer.passes.indexOf(this.cloudsPass)
      this.composer.removePass(this.cloudsPass)
      this.cloudsPass = new EffectPass(
        this.camera,
        ...(enabled
          ? [this.detail, c, this.aerial, this.landingLight, this.nanGuard]
          : [this.detail, this.aerial, this.landingLight, this.nanGuard]),
      )
      this.composer.addPass(this.cloudsPass, idx)
    }
    this.cloudsEnabled = enabled
    this.wireClouds()
    if (!this.cloudsEnabled) {
      this.cloudBottom = Infinity
      this.cloudTop = -Infinity
      return
    }
    this.applyCloudQuality(quality)
    const g = groundEllipsoid
    // repeat: tamaño de las nubes (más repeticiones del mapa de tiempo = cúmulos más pequeños)
    const presets: Record<string, { coverage: number; base: number; h1: number; h2: number; density: number; repeat: number }> = {
      fair: { coverage: 0.22, base: 1300, h1: 700, h2: 1100, density: 0.18, repeat: 260 },
      scattered: { coverage: 0.34, base: 1150, h1: 800, h2: 1500, density: 0.2, repeat: 190 },
      overcast: { coverage: 0.62, base: 900, h1: 900, h2: 1600, density: 0.24, repeat: 110 },
    }
    const p = presets[preset]
    // capas densas (la de cirros a 7500 m es casi transparente y queda fuera)
    this.cloudBottom = g + p.base
    this.cloudTop = g + p.base + Math.max(p.h1, 250 + p.h2)
    c.coverage = p.coverage
    c.localWeatherRepeat.setScalar(p.repeat)
    c.cloudLayers.set([
      {
        channel: 'r',
        altitude: g + p.base,
        height: p.h1,
        densityScale: p.density,
        shapeAmount: 1,
        shapeDetailAmount: 1,
        weatherExponent: 1,
        shapeAlteringBias: 0.35,
        coverageFilterWidth: 0.6,
        shadow: true,
      },
      {
        channel: 'g',
        altitude: g + p.base + 250,
        height: p.h2,
        densityScale: p.density,
        shapeAmount: 1,
        shapeDetailAmount: 1,
        weatherExponent: 1,
        shapeAlteringBias: 0.35,
        coverageFilterWidth: 0.6,
        shadow: true,
      },
      {
        channel: 'b',
        altitude: 7500,
        height: 500,
        densityScale: 0.003,
        shapeAmount: 0.4,
        shapeDetailAmount: 0,
        weatherExponent: 1,
        shapeAlteringBias: 0.35,
        coverageFilterWidth: 0.5,
      },
      { channel: 'a', height: 0 },
    ] as any)
    c.localWeatherVelocity.set(0.00002, 0)
  }

  /**
   * Normales para iluminar el terreno en posproceso: de la geometría (tiles 3D
   * de Google o malla del MDT del IGN, con un pase extra) o planas hacia arriba (ortofoto + relieve,
   * cuyo relieve se desplaza en la GPU y no aparece en el pase de normales).
   */
  useGeometryNormals(flag: boolean): void {
    this.geometryNormals = flag
    this.normalPass.enabled = flag
    this.aerial.normalBuffer = flag ? this.normalPass.texture : this.flatNormal
  }

  /** realGeometry: el terreno es geometría real (Google o malla del IGN) y admite el pase de normales */
  setQuality(q: Quality, realGeometry = false): void {
    const dpr = window.devicePixelRatio
    const ratio = { low: Math.min(dpr, 0.8), medium: Math.min(dpr, 1), high: Math.min(dpr, 1.5), ultra: Math.min(dpr, 2) }[q]
    this.renderer.setPixelRatio(ratio)
    const shadowSize = q === 'low' ? 1024 : q === 'ultra' ? 4096 : 2048
    if (this.sunLight.shadow.mapSize.x !== shadowSize) {
      this.sunLight.shadow.mapSize.setScalar(shadowSize)
      this.sunLight.shadow.map?.dispose()
      ;(this.sunLight.shadow as any).map = null
    }
    if (this.cloudsEnabled) this.applyCloudQuality(q)
    this.useGeometryNormals(realGeometry && (q === 'high' || q === 'ultra'))
    // en calidad baja: sin resplandor ni suavizado de bordes
    const wantBloom = q !== 'low'
    if (wantBloom !== this.bloomOn) {
      this.bloomOn = wantBloom
      const idx = this.composer.passes.indexOf(this.finalPass)
      this.composer.removePass(this.finalPass)
      const fx = wantBloom
        ? [this.bloom, this.tone, this.grade, this.saturation, this.vignette]
        : [this.tone, this.grade, this.saturation, this.vignette]
      this.finalPass = new EffectPass(this.camera, ...fx)
      this.composer.addPass(this.finalPass, idx)
    }
    this.smaaPass.enabled = q !== 'low'
    this.smaaPass.renderToScreen = this.smaaPass.enabled
    this.finalPass.renderToScreen = !this.smaaPass.enabled
    const c = this.renderer.domElement.parentElement
    if (c) this.resize(c)
  }

  private applyCloudQuality(q: Quality): void {
    ;(this.clouds as any).qualityPreset = q
    // los rayos crepusculares dejan ruido sin TAA (y cuestan GPU)
    this.clouds.lightShafts = false
    // Sombras de nubes hasta 100 km. Por defecto llegan al plano lejano de la
    // cámara (4000 km): la primera cascada cubría ~500 km con texeles de 1-2 km,
    // las sombras casi no se veían y al moverse la cámara saltaban a bloques
    // (parpadeo y manchas oscuras enormes de un fotograma).
    this.clouds.shadow.maxFar = 1e5
    this.wireClouds()
  }

  /** Fecha/hora → dirección del sol y la luna (ECEF). */
  setDate(date: Date): void {
    getSunDirectionECEF(date, this.sunDirECEF)
    getMoonDirectionECEF(date, this.moonDirECEF)
  }

  /** Actualiza matrices del marco local y luces en la posición `focus` (mundo). */
  update(worldToECEF: Matrix4, focus: Vector3, groundY: number | null, groundNormal: Vector3, agl: number): void {
    const sun = this.sunDirECEF
    this.skyMaterial.sunDirection.copy(sun)
    this.skyMaterial.moonDirection.copy(this.moonDirECEF)
    this.skyMaterial.worldToECEFMatrix.copy(worldToECEF)
    this.aerial.sunDirection.copy(sun)
    ;(this.aerial as any).moonDirection?.copy(this.moonDirECEF)
    this.aerial.worldToECEFMatrix.copy(worldToECEF)
    this.clouds.sunDirection.copy(sun)
    this.clouds.worldToECEFMatrix.copy(worldToECEF)
    // Máscara de cercanía de las nubes: distancia de la cámara a la capa densa más
    // próxima (0 dentro de ella). ×0,6: la máscara usa la profundidad de vista, y en
    // las esquinas de la pantalla la distancia real es hasta ~1,6 veces mayor.
    _camEcef.setFromMatrixPosition(this.camera.matrixWorld).applyMatrix4(worldToECEF)
    if (_camEcef.lengthSq() > 1e12) {
      // (sin marco geográfico todavía la posición es ~0 y setFromECEF lanzaría)
      const camH = _camGeo.setFromECEF(_camEcef).height
      const gap = Math.max(this.cloudBottom - camH, camH - this.cloudTop, 0)
      this.cloudNearMask.value = Number.isFinite(gap) ? Math.min(Math.max((gap - 10) * 0.6, 0), 100) : 100
    }
    this.sunLight.sunDirection.copy(sun)
    this.sunLight.worldToECEFMatrix.copy(worldToECEF)
    this.sunLight.target.position.copy(focus)
    this.sunLight.update()
    this.skyLight.sunDirection.copy(sun)
    this.skyLight.worldToECEFMatrix.copy(worldToECEF)
    this.skyLight.position.copy(focus)
    this.skyLight.update()
    // dirección del sol en el mundo
    this.sunDirWorld.copy(sun).transformDirection(_inv.copy(worldToECEF).invert())
    // normal "arriba" en espacio de vista para el terreno (cuando no hay pase de normales)
    if (!this.geometryNormals) {
      this.camera.updateMatrixWorld()
      _z.set(0, 1, 0).transformDirection(this.camera.matrixWorldInverse)
      const d = this.flatNormal.image.data as Float32Array
      d[0] = _z.x * 0.5 + 0.5
      d[1] = _z.y * 0.5 + 0.5
      d[2] = _z.z * 0.5 + 0.5
      this.flatNormal.needsUpdate = true
    }

    // receptor de sombra
    if (groundY !== null && agl < 80) {
      this.shadowCatcher.visible = true
      this.shadowCatcher.position.set(focus.x, groundY + 0.04, focus.z)
      this.shadowCatcher.quaternion.setFromUnitVectors(_z.set(0, 0, 1), groundNormal)
      // proyectar el centro hacia donde cae la sombra
      const s = this.sunDirWorld
      if (s.y > 0.05) {
        const k = Math.min(agl / s.y, 30)
        this.shadowCatcher.position.x -= s.x * k
        this.shadowCatcher.position.z -= s.z * k
      }
    } else this.shadowCatcher.visible = false
  }

  render(dt: number): void {
    this.composer.render(dt)
  }

  resize(container: HTMLElement): void {
    const w = container.clientWidth
    const h = container.clientHeight
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h)
    this.composer.setSize(w, h)
  }
}

const _z = new Vector3()
const _inv = new Matrix4()

/** Mezcla normal en color pero sin tocar el alfa del búfer (que es la máscara de iluminación). */
export function keepAlpha<T extends Material>(m: T): T {
  m.blending = CustomBlending
  m.blendSrc = SrcAlphaFactor
  m.blendDst = OneMinusSrcAlphaFactor
  m.blendSrcAlpha = ZeroFactor
  m.blendDstAlpha = OneFactor
  return m
}

/**
 * Convierte el alfa del render (0 = píxel del aparato, ya iluminado) en una
 * máscara binaria para la iluminación en posproceso. Binaria porque el terreno
 * escribe alfas intermedios mientras funde niveles de detalle.
 */
class AlphaMaskPass extends Pass {
  private readonly target = new WebGLRenderTarget(1, 1, { format: RedFormat, depthBuffer: false })

  constructor() {
    super('AlphaMaskPass')
    this.needsSwap = false
    this.fullscreenMaterial = new ShaderMaterial({
      uniforms: { inputBuffer: new Uniform(null) },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = position.xy * 0.5 + 0.5;
          gl_Position = vec4(position.xy, 1.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D inputBuffer;
        varying vec2 vUv;
        void main() {
          gl_FragColor = vec4(step(0.002, texture2D(inputBuffer, vUv).a));
        }`,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })
  }

  get texture(): Texture {
    return this.target.texture
  }

  override render(renderer: WebGLRenderer, inputBuffer: WebGLRenderTarget): void {
    ;(this.fullscreenMaterial as ShaderMaterial).uniforms.inputBuffer.value = inputBuffer.texture
    renderer.setRenderTarget(this.target)
    renderer.render(this.scene, this.camera)
  }

  override setSize(width: number, height: number): void {
    this.target.setSize(width, height)
  }
}
