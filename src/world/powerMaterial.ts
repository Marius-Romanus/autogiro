// Materiales de los tendidos: barras de las torres y conductores en catenaria dibujados como
// cintas que miran a la cámara. El ancho es el real o, si es más fino que un píxel, un píxel con
// la opacidad de lo que de verdad cubre (2·r / tamaño del píxel): un cable de 3 cm se ve nítido a
// 50 m, como un hilo tenue a 500 m y desaparece a un par de kilómetros, que es lo que pasa en vuelo.
//
// Se dibujan en dos pasadas como los discos del rotor (overlayAlbedoPass / overlayLightPass en
// render/Graphics.ts): el búfer lleva albedo sobre el terreno (alfa 1) y radiancia sobre el cielo,
// los edificios y el aparato (alfa 0).
//
// Atributos de las torres (por vértice de la plantilla): pa, pb (extremos de la barra en el
// apoyo), pr (radio en a, radio en b, opacidad), pc (color lineal), st (lado ±1, t 0/1); por
// apoyo: ip (posición en la tesela, escala) e iu (eje de la cruceta en x, z).
// Atributos de los cables (por vértice: st con t de 0 a 1 en SEGMENTS tramos); por vano: wa, wb
// (enganches), wp (flecha, radio, gris lineal, opacidad).

import { Box3, BufferAttribute, Color, InstancedBufferAttribute as InstancedAttr, InstancedBufferGeometry, MeshBasicMaterial, MeshStandardMaterial, Sphere, Vector3, type Material } from 'three'
import { overlayAlbedoPass, overlayLightPass } from '../render/Graphics.ts'
import { PALETTE, type Template } from './powerDesigns.ts'

/** Tramos de cada conductor (la catenaria se calcula en el shader). */
export const SEGMENTS = 16

/** Metros por píxel a 1 m de distancia (2·tan(fov/2) / alto en píxeles), común a todos. */
export const pixelScale = { value: 0.001 }

/**
 * Cuánto más fino resuelve el ojo que un píxel: un píxel de un monitor normal con el campo de
 * visión del juego abarca ~1,7 mrad y el ojo distingue una raya oscura contra el cielo de unos
 * 0,35 mrad. Sin esto, un cable de 3 cm a 70 m (0,4 mrad, bien visible en vuelo) saldría como
 * una raya gris al 25 %. Solo afecta a lo que es más fino que un píxel; como mucho ×4.
 */
export const eyeBoost = { value: 1 }

const DECL = /* glsl */ `
uniform float uPx;
uniform float uEye;
attribute vec2 st;
#ifdef PW_TOWER
attribute vec3 pa;
attribute vec3 pb;
attribute vec3 pr;
attribute vec3 pc;
attribute vec4 ip;
attribute vec2 iu;
#else
attribute vec3 wa;
attribute vec3 wb;
attribute vec4 wp;
#endif
varying vec4 vPw;
varying vec3 vPwCol;
`

// geometría de la cinta: pwPos (punto en el modelo) y pwNormal (normal de un cilindro)
const GEOM = /* glsl */ `
  vec3 pwP;
  vec3 pwT;
  float pwR;
  float pwOp;
#ifdef PW_TOWER
  vec3 pwU = vec3(iu.x, 0.0, iu.y);
  vec3 pwD = vec3(-iu.y, 0.0, iu.x);
  vec3 pwA = ip.xyz + ip.w * (pa.x * pwU + vec3(0.0, pa.y, 0.0) + pa.z * pwD);
  vec3 pwB = ip.xyz + ip.w * (pb.x * pwU + vec3(0.0, pb.y, 0.0) + pb.z * pwD);
  pwP = mix(pwA, pwB, st.y);
  pwT = pwB - pwA;
  pwR = ip.w * mix(pr.x, pr.y, st.y);
  pwOp = pr.z;
  vPwCol = pc;
#else
  float pwt = st.y;
  pwP = mix(wa, wb, pwt);
  pwP.y -= 4.0 * wp.x * pwt * (1.0 - pwt);
  pwT = wb - wa;
  pwT.y += 4.0 * wp.x * (2.0 * pwt - 1.0);
  pwR = wp.y;
  pwOp = wp.w;
  vPwCol = vec3(wp.z);
#endif
  // la cámara en el marco de la tesela (matriz rígida: la inversa es la traspuesta)
  vec3 pwCam = transpose(mat3(modelMatrix)) * (cameraPosition - modelMatrix[3].xyz);
  vec3 pwV = pwCam - pwP;
  float pwDist = max(length(pwV), 0.01);
  vec3 pwS = cross(pwT, pwV);
  float pwSl = length(pwS);
  pwS = pwSl > 1e-9 ? pwS / pwSl : vec3(0.0, 1.0, 0.0);
  float pwPx = pwDist * uPx;
  float pwRPx = pwR / pwPx;
  // lo más fino que un píxel se ve como lo vería el ojo, no la pantalla (ver eyeBoost)
  if (pwRPx < 0.5) pwRPx = min(0.5, pwRPx * uEye);
  float pwHw = pwRPx < 0.5 ? 1.0 : pwRPx + 0.5;
  vPw = vec4(st.x, pwHw, pwRPx, pwOp);
  vec3 pwPos = pwP + pwS * (st.x * pwHw * pwPx);
  vec3 pwNormal = normalize(pwS * (st.x * 0.8) + (pwV / pwDist) * 0.6);
`

const FRAG_DECL = /* glsl */ `
varying vec4 vPw;
varying vec3 vPwCol;
`

// cobertura del píxel: perfil en tienda (integral 2·r) si es más fino que medio píxel; si no, borde suavizado
const FRAG = /* glsl */ `
  float pwd = abs(vPw.x) * vPw.y;
  float pwA = vPw.z < 0.5 ? 2.0 * vPw.z * max(0.0, 1.0 - pwd) : clamp(vPw.z + 0.5 - pwd, 0.0, 1.0);
  diffuseColor.rgb *= vPwCol;
  diffuseColor.a *= pwA * vPw.w;
`

/** Solo profundidad donde la barra cubre más de medio píxel (si no, las nubes y la atmósfera la tratan como cielo). */
const DEPTH_FRAG = /* glsl */ `
  float pwd = abs(vPw.x) * vPw.y;
  float pwA = vPw.z < 0.5 ? 2.0 * vPw.z * max(0.0, 1.0 - pwd) : clamp(vPw.z + 0.5 - pwd, 0.0, 1.0);
  if (pwA * vPw.w < 0.5) discard;
`

function patch(m: Material, tower: boolean, lit: boolean, depth = false): void {
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uPx = pixelScale
    shader.uniforms.uEye = eyeBoost
    let vs = shader.vertexShader
    vs = vs.replace('#include <common>', `#include <common>\n${tower ? '#define PW_TOWER\n' : ''}${DECL}`)
    vs = vs.replace('void main() {', `void main() {\n${GEOM}`)
    if (lit) vs = vs.replace('#include <beginnormal_vertex>', 'vec3 objectNormal = pwNormal;')
    vs = vs.replace('#include <begin_vertex>', 'vec3 transformed = pwPos;')
    shader.vertexShader = vs
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${FRAG_DECL}`).replace('#include <color_fragment>', `#include <color_fragment>\n${depth ? DEPTH_FRAG : FRAG}`)
  }
  m.customProgramCacheKey = () => `power-${tower ? 't' : 'w'}-${depth ? 'd' : lit ? 'l' : 'a'}-v1`
}

export interface PowerMaterials {
  towerAlbedo: MeshBasicMaterial
  towerLit: MeshStandardMaterial
  wireAlbedo: MeshBasicMaterial
  wireLit: MeshStandardMaterial
  /** pasada previa de profundidad (cola opaca, sin color) */
  towerDepth: MeshBasicMaterial
  wireDepth: MeshBasicMaterial
}

export function createPowerMaterials(): PowerMaterials {
  const common = { color: 0xffffff, transparent: true, depthWrite: false } as const
  const towerAlbedo = overlayAlbedoPass(new MeshBasicMaterial(common))
  const towerLit = overlayLightPass(new MeshStandardMaterial({ ...common, roughness: 0.7, metalness: 0.35 }))
  const wireAlbedo = overlayAlbedoPass(new MeshBasicMaterial(common))
  const wireLit = overlayLightPass(new MeshStandardMaterial({ ...common, roughness: 0.5, metalness: 0.55 }))
  patch(towerAlbedo, true, false)
  patch(towerLit, true, true)
  patch(wireAlbedo, false, false)
  patch(wireLit, false, true)
  const towerDepth = new MeshBasicMaterial({ colorWrite: false })
  const wireDepth = new MeshBasicMaterial({ colorWrite: false })
  patch(towerDepth, true, false, true)
  patch(wireDepth, false, false, true)
  return { towerAlbedo, towerLit, wireAlbedo, wireLit, towerDepth, wireDepth }
}

// ---------------------------------------------------------------------------
// Geometrías

const LINEAR = PALETTE.map((hex) => new Color(hex).convertSRGBToLinear())

/** Atributos por vértice de una plantilla (cuatro vértices por barra). */
export interface TemplateArrays {
  pa: Float32Array
  pb: Float32Array
  pr: Float32Array
  pc: Float32Array
  st: Float32Array
  index: Uint32Array
}

const arraysCache = new WeakMap<object, TemplateArrays>()

export function templateArrays(t: Template, simple: boolean): TemplateArrays {
  const list = simple ? t.simple : t.full
  let a = arraysCache.get(list)
  if (a) return a
  const n = list.length
  a = {
    pa: new Float32Array(n * 12),
    pb: new Float32Array(n * 12),
    pr: new Float32Array(n * 12),
    pc: new Float32Array(n * 12),
    st: new Float32Array(n * 8),
    index: new Uint32Array(n * 6),
  }
  list.forEach((m, i) => {
    const c = LINEAR[m.col] ?? LINEAR[0]
    for (let v = 0; v < 4; v++) {
      const k = (i * 4 + v) * 3
      a!.pa.set(m.a, k)
      a!.pb.set(m.b, k)
      a!.pr[k] = m.ra
      a!.pr[k + 1] = m.rb
      a!.pr[k + 2] = m.op
      a!.pc[k] = c.r
      a!.pc[k + 1] = c.g
      a!.pc[k + 2] = c.b
      a!.st[(i * 4 + v) * 2] = v & 1 ? 1 : -1
      a!.st[(i * 4 + v) * 2 + 1] = v >> 1
    }
    const b = i * 4
    a!.index.set([b, b + 1, b + 3, b, b + 3, b + 2], i * 6)
  })
  arraysCache.set(list, a)
  return a
}

/** Geometría instanciada de una plantilla con los apoyos dados (ip: x, y, z, escala; iu: eje). */
export function towerGeometry(arrays: TemplateArrays, ip: Float32Array, iu: Float32Array, radius: number): InstancedBufferGeometry {
  const g = new InstancedBufferGeometry()
  g.setIndex(new BufferAttribute(arrays.index, 1))
  g.setAttribute('pa', new BufferAttribute(arrays.pa, 3))
  g.setAttribute('pb', new BufferAttribute(arrays.pb, 3))
  g.setAttribute('pr', new BufferAttribute(arrays.pr, 3))
  g.setAttribute('pc', new BufferAttribute(arrays.pc, 3))
  g.setAttribute('st', new BufferAttribute(arrays.st, 2))
  g.setAttribute('ip', new InstancedAttr(ip, 4))
  g.setAttribute('iu', new InstancedAttr(iu, 2))
  g.instanceCount = ip.length / 4
  setBounds(g, radius)
  return g
}

let wireArrays: { st: Float32Array; index: Uint32Array } | null = null

/** Geometría instanciada de los conductores (wa, wb: enganches; wp: flecha, radio, gris, opacidad). */
export function wireGeometry(wa: Float32Array, wb: Float32Array, wp: Float32Array, radius: number): InstancedBufferGeometry {
  if (!wireArrays) {
    const st = new Float32Array((SEGMENTS + 1) * 4)
    const index = new Uint32Array(SEGMENTS * 6)
    for (let i = 0; i <= SEGMENTS; i++) {
      st.set([-1, i / SEGMENTS, 1, i / SEGMENTS], i * 4)
      if (i < SEGMENTS) {
        const b = i * 2
        index.set([b, b + 1, b + 3, b, b + 3, b + 2], i * 6)
      }
    }
    wireArrays = { st, index }
  }
  const g = new InstancedBufferGeometry()
  g.setIndex(new BufferAttribute(wireArrays.index, 1))
  g.setAttribute('st', new BufferAttribute(wireArrays.st, 2))
  g.setAttribute('wa', new InstancedAttr(wa, 3))
  g.setAttribute('wb', new InstancedAttr(wb, 3))
  g.setAttribute('wp', new InstancedAttr(wp, 4))
  g.instanceCount = wa.length / 3
  setBounds(g, radius)
  return g
}


function setBounds(g: InstancedBufferGeometry, radius: number): void {
  g.boundingSphere = new Sphere(new Vector3(), radius)
  g.boundingBox = new Box3(new Vector3(-radius, -radius, -radius), new Vector3(radius, radius, radius))
}
