// Desgaste de los aparatos: polvo posado, barro de las ruedas en los bajos, hollín tras el escape,
// goma polvorienta, acero del escape recalentado y, sobre todo, un barniz que no brilla igual en
// todas partes (lo que más delata a una pintura «de plástico»).
//
// Se hace al cargar el modelo y en el shader, no en Blender: vale para todos los aparatos (y los que
// vengan) sin volver a exportar ningún GLB ni añadirles texturas, y no cuesta dibujos de más.
//
// - Al cargar, cada vértice recibe dos atributos: `wxP`, su posición en el marco del modelo en
//   reposo (el ruido va pegado a la pieza aunque gire o se mueva, y a la misma escala en todas), y
//   `wxM`, cuatro máscaras que dependen de dónde está la pieza en el aparato y por eso no pueden
//   salir del shader: bajos y estela de las ruedas, cercanía al escape, caras que miran arriba.
// - Los materiales se reconocen por su nombre (los modelos comparten nomenclatura: Paint_*,
//   Metal_Frame, Engine, Rubber, Steel_Exhaust…). Lo que no está en la lista no se toca: pilotos,
//   lentes, botones y, sobre todo, las caras de los instrumentos.
// - Cuánto desgaste, según la época: los modernos de club van limpios; un Cierva de los años 30,
//   con su motor en estrella delante, bastante menos. Lo gradúa todo `wxAmount` (render/weathering.ts;
//   0 en calidad Baja).

import { Box3, BufferAttribute, Matrix3, Matrix4, Vector3, Vector4, type Material, type Mesh, type MeshStandardMaterial, type Object3D } from 'three'
import { WX_COMMON_GLSL, weatherUniforms } from '../render/weathering.ts'
import { AIRCRAFT } from './catalog.ts'

/** `wxP` va en enteros de 16 bits: ± este tamaño (m) */
const SPAN = 16

/** Desgaste (0–1) de un modelo según su época (clave = nombre del GLB sin extensión). */
export function wearFor(modelKey: string): number {
  // el de fumigar trabaja a ras de un campo de tierra
  if (modelKey === 'tractor') return 0.9
  const m = AIRCRAFT.find((a) => a.url.endsWith(`/${modelKey}.glb`) || a.floatsUrl?.endsWith(`/${modelKey}.glb`))
  const year = m?.year ?? 2010
  // (los inventados son de exposición)
  return year >= 2040 ? 0.25 : year >= 1990 ? 0.65 : year >= 1950 ? 0.8 : 1
}

/**
 * Qué desgaste admite cada material: x suciedad (polvo, barro, manchas), y variación del brillo,
 * z hollín del escape, w clase (0 normal, 1 goma, 2 motor, 3 acero del escape).
 */
const CLASSES: Array<[RegExp, [number, number, number, number]]> = [
  [/exhaust/i, [0.6, 0.8, 0, 3]],
  [/^Rubber/i, [1, 0.5, 0.6, 1]],
  [/^(Engine|Rotary|Radiator|Rocker|Rotax|Belt|Hose|Filter|Shroud|Duct)/i, [1, 0.8, 0.3, 2]],
  [/^(Paint|Fabric|Camo|Float_|Wing_|Rudder_|Hub_|Teal|Accent|Tank|Polymer|Seat_Shell|Tramp)/i, [1, 1, 1, 0]],
  [/^(Metal_Frame|Alu|Keel|Frame_Alu|Strut|Leg_|Rod_|Chrome|Steel|Wire|Nozzle_Housing)/i, [0.8, 0.7, 1, 0]],
  [/^(Rotor_Blade|Prop|Carbon|Wood|Tip_)/i, [0.6, 0.9, 0.5, 0]],
  [/^(Interior|Seat|Canvas)/i, [0.5, 0.5, 0, 0]],
]

function classOf(name: string): [number, number, number, number] | null {
  for (const [re, cfg] of CLASSES) if (re.test(name)) return cfg
  return null
}

const WEAR_GLSL = /* glsl */ `
uniform vec4 wxCfg;
uniform float wxWear;
varying vec3 vWxP;
varying vec4 vWxM;
${WX_COMMON_GLSL}
// col: albedo; gloss: lo que sube la rugosidad (también la del barniz); M: bajos, escape, arriba
void wxAircraft(inout vec3 col, inout float gloss, vec3 P, vec4 M, vec4 cfg, float k) {
  float m1 = wxBand3(P * 2.1);
  float m2 = wxBand3(P * 13.0);
  vec3 dustCol = vec3(0.36, 0.32, 0.27);
  if (cfg.w > 2.5) {
    // acero recalentado: del paja al pardo y al azulado, a tramos
    float heat = 0.5 + 0.5 * wxBand3(P * 5.0 + 3.7);
    col *= mix(vec3(1.0), mix(vec3(0.95, 0.70, 0.42), vec3(0.50, 0.52, 0.72), smoothstep(0.55, 0.9, heat)), 0.75 * k);
    col *= 1.0 - 0.35 * k * smoothstep(0.1, 0.8, m2);
    gloss += 0.25 * k;
    return;
  }
  col *= 1.0 + k * cfg.x * (0.08 * m1 + 0.05 * m2);
  // polvo posado en lo que mira arriba y barro de las ruedas en los bajos, a ráfagas
  float dust = M.b * (0.55 + 0.45 * m1) * cfg.x * k * 0.7;
  float grime = M.r * smoothstep(-0.45, 0.45, wxBand3(P * 6.0) + 0.5 * m1) * cfg.x * k;
  // hollín tras el escape, en churretones a lo largo
  float soot = M.g * (0.7 + 0.3 * wxBand(vec2((P.y + P.z) * 11.0, P.x * 1.1))) * cfg.z * k;
  if (cfg.w > 1.5) {
    // motor: película de aceite y polvo pegado
    float oil = smoothstep(-0.2, 0.7, m1 + 0.6 * m2);
    col = mix(col, col * vec3(0.55, 0.47, 0.36), 0.38 * k * oil);
    grime = max(grime, 0.25 * k * (1.0 - oil));
  } else if (cfg.w > 0.5) {
    // goma: polvo de la pista en la banda de rodadura
    col = mix(col, dustCol * 0.75, k * (0.30 + 0.25 * m2));
    gloss += 0.2 * k;
  }
  col = mix(col, dustCol, clamp(dust * 0.35 + grime * 0.55, 0.0, 0.8));
  col = mix(col, vec3(0.012), clamp(0.6 * soot, 0.0, 0.6));
  gloss += k * (cfg.y * (0.16 * m1 + 0.10 * m2) + 0.5 * dust + 0.6 * grime + 0.4 * soot);
}
`

/** Uniformes de un aparato (los comparten todos sus materiales). */
interface WearUniforms {
  wxWear: { value: number }
}

function patchMaterial(mat: Material, cfg: [number, number, number, number], shared: WearUniforms): void {
  if (mat.userData.wxWear) return
  mat.userData.wxWear = true
  const wxCfg = { value: new Vector4(...cfg) }
  const prev = mat.onBeforeCompile
  const prevKey = mat.customProgramCacheKey
  mat.onBeforeCompile = function (this: Material, shader, renderer) {
    prev.call(this, shader, renderer)
    Object.assign(shader.uniforms, weatherUniforms, shared, { wxCfg })
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 wxP;\nattribute vec4 wxM;\nvarying vec3 vWxP;\nvarying vec4 vWxM;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvWxP = wxP * ${SPAN.toFixed(1)};\nvWxM = wxM;`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${WEAR_GLSL}`)
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\n\tfloat wxGloss = 0.0;\n\tif (wxAmount > 0.0) wxAircraft(diffuseColor.rgb, wxGloss, vWxP, vWxM, wxCfg, wxWear * wxAmount);',
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n\troughnessFactor = clamp(roughnessFactor + wxGloss, 0.04, 1.0);')
      // el barniz, mate donde hay polvo
      .replace(
        '#include <lights_physical_fragment>',
        '#include <lights_physical_fragment>\n#ifdef USE_CLEARCOAT\n\tmaterial.clearcoatRoughness = clamp(material.clearcoatRoughness + 1.6 * wxGloss, 0.03, 1.0);\n#endif',
      )
  }
  mat.customProgramCacheKey = function (this: Material) {
    return `${prevKey.call(this)}|wear1`
  }
  mat.needsUpdate = true
}

const SPINNING = /^(rotor|prop|nose_wheel|wheel_[LR]|amph_(main|nose)_[LR])$/

/**
 * Prepara el desgaste de un modelo recién cargado: atributos por vértice y materiales.
 * `scene` con sus matrices de mundo al día y aún en la postura de reposo.
 */
export function applyAircraftWear(scene: Object3D, modelKey: string): void {
  const shared: WearUniforms = { wxWear: { value: wearFor(modelKey) } }
  const inv = new Matrix4().copy(scene.matrixWorld).invert()
  const meshes: Array<{ m: Mesh; rel: Matrix4; spinning: boolean }> = []
  const exhaust = new Box3()
  const all = new Box3()
  const tmp = new Box3()
  scene.traverse((o) => {
    const m = o as Mesh
    if (!m.isMesh || !m.geometry.getAttribute('position')) return
    const mats = (Array.isArray(m.material) ? m.material : [m.material]) as MeshStandardMaterial[]
    if (!mats.some((x) => x.isMeshStandardMaterial)) return
    const rel = new Matrix4().multiplyMatrices(inv, m.matrixWorld)
    let spinning = false
    for (let p: Object3D | null = m; p && p !== scene; p = p.parent) if (SPINNING.test(p.name)) spinning = true
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox()
    tmp.copy(m.geometry.boundingBox!).applyMatrix4(rel)
    all.union(tmp)
    if (mats.some((x) => /exhaust/i.test(x.name))) exhaust.union(tmp)
    meshes.push({ m, rel, spinning })
  })
  if (meshes.length === 0) return

  // ruedas (marco del modelo): el suelo y la estela de barro de cada una
  const wheels: Array<{ c: Vector3; r: number }> = []
  for (const name of ['nose_wheel', 'wheel_L', 'wheel_R']) {
    const o = scene.getObjectByName(name)
    if (!o) continue
    const b = new Box3().setFromObject(o).applyMatrix4(inv)
    if (b.isEmpty()) continue
    wheels.push({ c: b.getCenter(new Vector3()), r: 0.5 * (b.max.y - b.min.y) })
  }
  const groundY = wheels.length ? Math.min(...wheels.map((w) => w.c.y - w.r)) : all.min.y
  // hacia dónde es «atrás» (el timón queda a popa del piloto)
  const rudder = scene.getObjectByName('rudder')
  const eye = scene.getObjectByName('eye_front') ?? scene.getObjectByName('pilot_front')
  const aft = rudder && eye ? Math.sign(_a.setFromMatrixPosition(rudder.matrixWorld).applyMatrix4(inv).x - _b.setFromMatrixPosition(eye.matrixWorld).applyMatrix4(inv).x) || -1 : -1
  const hasExhaust = !exhaust.isEmpty()
  const exC = exhaust.getCenter(new Vector3())
  const exH = exhaust.getSize(new Vector3()).multiplyScalar(0.5)

  const done = new Set<unknown>()
  const nm = new Matrix3()
  for (const { m, rel, spinning } of meshes) {
    // una geometría que usan dos mallas: cada una necesita su posición de reposo
    if (done.has(m.geometry)) m.geometry = m.geometry.clone()
    done.add(m.geometry)
    const g = m.geometry
    const pos = g.getAttribute('position')
    const nor = g.getAttribute('normal')
    const n = pos.count
    const P = new Int16Array(n * 3)
    const M = new Uint8Array(n * 4)
    nm.getNormalMatrix(rel)
    for (let i = 0; i < n; i++) {
      _a.fromBufferAttribute(pos, i).applyMatrix4(rel)
      P[3 * i] = q16(_a.x)
      P[3 * i + 1] = q16(_a.y)
      P[3 * i + 2] = q16(_a.z)
      if (spinning) continue
      const ny = nor ? _b.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize().y : 0
      // bajos: cerca del suelo y más lo que mira hacia abajo; y la estela de cada rueda
      const h = _a.y - groundY
      let grime = (1 - smooth(0.1, 0.8, h)) * (0.4 + 0.6 * clamp01(0.3 - 1.4 * ny)) * 0.7
      for (const w of wheels) {
        const back = (_a.x - w.c.x) * aft
        if (back < -w.r || back > 1.4 || h > 1.1) continue
        const side = Math.abs(_a.z - w.c.z)
        const k = (1 - smooth(0.12, 0.38, side)) * (1 - smooth(0.4, 1.4, back)) * (1 - smooth(0.5, 1.1, h))
        grime = Math.max(grime, 0.85 * k)
      }
      // hollín: junto al escape y, sobre todo, a popa de él
      let soot = 0
      if (hasExhaust) {
        let ex = Math.max(Math.abs(_a.x - exC.x) - exH.x, 0)
        if ((_a.x - exC.x) * aft > 0) ex *= 0.3
        const ey = Math.max(Math.abs(_a.y - exC.y) - exH.y, 0)
        const ez = Math.max(Math.abs(_a.z - exC.z) - exH.z, 0)
        const d = Math.hypot(ex, ey, ez)
        const s = 1 - smooth(0.02, 0.4, d)
        // (dentro de la caja —un colector en anillo abraza el motor entero— no es todo hollín)
        soot = d > 0 ? s * s : 0.45
      }
      M[4 * i] = Math.round(255 * clamp01(grime))
      M[4 * i + 1] = Math.round(255 * soot)
      M[4 * i + 2] = Math.round(255 * smooth(0.35, 0.9, ny))
      M[4 * i + 3] = 255
    }
    g.setAttribute('wxP', new BufferAttribute(P, 3, true))
    g.setAttribute('wxM', new BufferAttribute(M, 4, true))
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      const cfg = (mat as MeshStandardMaterial).isMeshStandardMaterial ? classOf(mat.name) : null
      if (cfg) patchMaterial(mat, cfg, shared)
    }
  }
}

const _a = new Vector3()
const _b = new Vector3()

function q16(v: number): number {
  return Math.max(-32767, Math.min(32767, Math.round((v / SPAN) * 32767)))
}
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}
function smooth(a: number, b: number, v: number): number {
  const t = clamp01((v - a) / (b - a))
  return t * t * (3 - 2 * t)
}
