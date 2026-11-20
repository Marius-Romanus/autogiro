// Simulación física del accidente con Rapier (sólidos rígidos con contacto,
// fricción y uniones).
//
// En el instante del choque el autogiro se convierte en varios sólidos:
//   - el fuselaje (góndola + mástil + cola + patas del tren) como un sólido
//     compuesto cuyas piezas se desprenden cuando la carga en su unión supera
//     su resistencia,
//   - el rotor (buje + 2 palas de 3 tramos), la hélice (buje + 3 palas) y las 3
//     ruedas, cada uno con su eje de giro libre (unión de revolución que también
//     se puede romper), y con el momento angular que traían.
//
// La carga en cada unión sale de la 2.ª ley de Newton sobre el subárbol de
// piezas que cuelga de ella: F = Σ m·(a − g) − Σ F_contacto − Σ F_ejes, y el
// momento flector igual respecto al punto de unión. Como el contacto entre
// sólidos rígidos da impulsos casi instantáneos, la carga se filtra con el tiempo
// de respuesta de cada estructura (la fuerza de pico de un impulso J repartido en
// τ es J/τ), de modo que el resultado no depende del paso de integración.
//
// El rotor entero y girando sigue actuando como disco en autorrotación (empuje
// según el flujo que lo atraviesa, como un paracaídas de ~10 m/s en descenso
// vertical), y frena por la resistencia de perfil en cuanto se rompe una pala.
//
// Todo trabaja en un marco local con origen en el punto del choque (Rapier usa
// coma flotante de 32 bits).

import { Quaternion, Vector3 } from 'three'
import type * as RapierNS from '@dimforge/rapier3d-compat'
import { CG } from '../autogyro.ts'
import { BLADE_ROOT, bladeCuts, bladeSides, GENERIC_WRECK, makeJointDefs, makePartDefs, podMassProperties, type JointDef, type PartDef, type WreckSpec } from './parts.ts'
import { centroid, type PartShapes } from './shapes.ts'
import { t, wreckLabel } from '../../i18n.ts'

type Rapier = typeof RapierNS
let RAPIER: Rapier | null = null

/** Carga el motor de física (WASM). Se llama una vez al arrancar. */
export async function loadRapier(): Promise<Rapier> {
  if (RAPIER) return RAPIER
  const mod: any = await import('@dimforge/rapier3d-compat')
  const R = (mod.default?.init ? mod.default : mod) as Rapier
  await R.init()
  RAPIER = R
  return R
}
export const rapierReady = (): boolean => RAPIER !== null

export const WRECK_DT = 1 / 480
const G = 9.80665
const GRAV = new Vector3(0, -G, 0)

// grupos de colisión: (pertenencia << 16) | filtro
const WORLD = 0x1, AIR = 0x2, HUB = 0x4, BLADE = 0x8, PROPB = 0x10, WHEEL = 0x20, DEBRIS = 0x40
const ALL = 0xffff
const grp = (m: number, f: number) => (m << 16) | f
const G_WORLD = grp(WORLD, ALL)
const G_AIR = grp(AIR, WORLD | AIR | BLADE | PROPB | DEBRIS)
const G_HUB = grp(HUB, WORLD | HUB | BLADE | PROPB | DEBRIS)
const G_BLADE = grp(BLADE, WORLD | AIR | HUB | BLADE | PROPB | WHEEL | DEBRIS)
const G_PROPB = grp(PROPB, WORLD | AIR | HUB | BLADE | PROPB | WHEEL | DEBRIS)
const G_WHEEL = grp(WHEEL, WORLD | BLADE | PROPB | WHEEL | DEBRIS)
const G_DEBRIS = grp(DEBRIS, ALL)

export type Surface = 'ground' | 'obstacle' | 'part' | 'debris' | 'foliage'

/** Contacto relevante (para efectos y sonido). Coordenadas locales del accidente. */
export interface Impact {
  part: string
  material: PartDef['material']
  surface: Surface
  point: Vector3
  /** normal de la superficie golpeada (hacia la pieza) */
  normal: Vector3
  /** impulso normal en este paso (N·s) */
  impulse: number
  /** velocidad de deslizamiento (m/s) y su dirección */
  slide: number
  tangent: Vector3
  /** velocidad con la que se acerca a la superficie (m/s) */
  approach: number
}

export interface BreakEvent {
  id: string
  name: string
  point: Vector3
  /** carga que la rompió, relativa a su resistencia */
  ratio: number
}

export interface Chunk {
  rb: RapierNS.RigidBody
  size: Vector3
  color: number
  glass: boolean
  born: number
}

export interface WreckStart {
  /** posición del CG (marco local del accidente) */
  pos: Vector3
  quat: Quaternion
  vel: Vector3
  /** velocidad angular en ejes del cuerpo */
  omegaBody: Vector3
  /** rad/s alrededor del eje del rotor */
  rotorOmega: number
  /** rad/s de la hélice (gira alrededor de −X) */
  propOmega: number
  /** par del motor en el eje de la hélice (N·m) en el momento del choque */
  propTorque: number
  mass: number
  rho: number
  wind: Vector3
  shapes: PartShapes
  /** piezas o ejes rotos de partida (el fallo que detectó el modelo de vuelo) */
  preBreak: string[]
  /** suelta el rotor con un golpe de balancín (flapping) */
  rotorKick?: boolean
  seed?: number
  /**
   * Altura del suelo: si se da, se sube el conjunto lo justo para que ninguna
   * pieza del fuselaje empiece enterrada (el modelo de vuelo usa muelles y las
   * ruedas pueden estar unos centímetros "dentro"; Rapier lo expulsaría de golpe).
   */
  heightAt?: (x: number, z: number) => number | null
  /** rotor y hélice del aparato (si falta, los del genérico) */
  spec?: WreckSpec
}

interface Part {
  def: PartDef
  id: string
  body: Body
  parent: Part | null
  children: Part[]
  attached: boolean
  descs: RapierNS.ColliderDesc[]
  colliders: RapierNS.Collider[]
  mass: number
  /** centro de masas y punto de unión (marco del cuerpo = marco del modelo en el choque) */
  com: Vector3
  attach: Vector3
  fMax: number
  mMax: number
  fF: Vector3
  fM: Vector3
  // acumuladores por paso
  fc: Vector3
  lc: Vector3
  fj: Vector3
  lj: Vector3
  /** peor contacto del paso (para efectos) */
  best: Impact | null
  lastSpawn: number
  /** fuerza de las ramas (si está dentro de la copa de un árbol) y su punto */
  ff: Vector3
  fp: Vector3
}

interface Body {
  rb: RapierNS.RigidBody
  parts: Part[]
  v0: Vector3
  w0: Vector3
  a: Vector3
  alpha: Vector3
  fresh: boolean
  cdA: number
  /** fuerza/par externos aplicados este paso (aerodinámica, motor) */
  fx: Vector3
  tx: Vector3
  /** parte de fx que va al buje del rotor (empuje del disco) */
  fh: Vector3
}

interface Joint {
  def: JointDef
  a: Part
  b: Part
  joint: RapierNS.ImpulseJoint | null
  broken: boolean
  fF: Vector3
  fMax: number
}

type Owner = { kind: 'part'; part: Part } | { kind: 'ground' } | { kind: 'obstacle' } | { kind: 'debris'; chunk: Chunk }

const _a = new Vector3()
const _b = new Vector3()
const _c = new Vector3()
const _d = new Vector3()
const _p = new Vector3()
const _n = new Vector3()
const _q = new Quaternion()
const _q2 = new Quaternion()
const _w1 = new Vector3()
const _w2 = new Vector3()
const _qc = new Quaternion()

function rnd(seed: { s: number }): number {
  // mulberry32
  let t = (seed.s += 0x6d2b79f5)
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const v3 = (v: { x: number; y: number; z: number }, out = new Vector3()) => out.set(v.x, v.y, v.z)

/** Punto en el marco local de un colisionador → mundo. */
function colliderToWorld(c: RapierNS.Collider, l: { x: number; y: number; z: number }, out: Vector3): Vector3 {
  const r = c.rotation()
  return v3(l, out).applyQuaternion(_qc.set(r.x, r.y, r.z, r.w)).add(c.translation())
}

export class Wreck {
  readonly world: RapierNS.World
  private readonly R: Rapier
  private readonly eq: RapierNS.EventQueue
  readonly parts = new Map<string, Part>()
  private bodies: Body[] = []
  private joints: Joint[] = []
  private owners = new Map<number, Owner>()
  /** distancia por debajo de la cual un punto del manifold es contacto para el solver (m) */
  private readonly contactReach: number
  readonly chunks: Chunk[] = []
  /** contactos y roturas desde la última lectura (los vacía quien los consume) */
  readonly impacts: Impact[] = []
  readonly breaks: BreakEvent[] = []
  time = 0
  /** deceleración máxima en el asiento del piloto (g, filtrada a 50 ms) */
  peakSeatG = 0
  private seatAcc = new Vector3()
  private readonly rho: number
  private readonly wind: Vector3
  private readonly seed: { s: number }
  private ground: RapierNS.Collider | null = null
  /**
   * Pares de sólidos que no chocan entre sí: una pieza recién desprendida y el
   * sólido del que sale. Sus cascos convexos pueden solaparse (en la malla real el
   * pie del mástil está metido en la góndola, el respaldo a su lado…) y Rapier los
   * separaría con fuerzas enormes. Se vuelven a tocar en cuanto dejan de solaparse.
   */
  private ignore = new Map<string, { a: Body; b: Body; check: number }>()
  private readonly hooks: RapierNS.PhysicsHooks
  readonly groundCenter = new Vector3(1e9, 0, 1e9)
  private obstacles: RapierNS.Collider | null = null
  readonly obstacleCenter = new Vector3(1e9, 0, 1e9)
  private propTorque: number
  private readonly rotorAxisLocal: Vector3
  /** rotor y hélice de este aparato */
  private spec: WreckSpec = GENERIC_WRECK
  private readonly totalMass: number
  /** color de los cascotes al golpear un obstáculo en un punto (lo da quien conoce el escenario) */
  obstacleColor: ((p: Vector3, n: Vector3) => { color: number; glass: number }) | null = null
  /** ¿está el punto (local) dentro de la copa de un árbol? */
  foliage: ((p: Vector3) => boolean) | null = null
  maxChunks = 160

  constructor(s: WreckStart) {
    if (!RAPIER) throw new Error('Rapier no está cargado')
    const R = RAPIER
    this.R = R
    this.rho = s.rho
    this.wind = s.wind.clone()
    this.seed = { s: s.seed ?? (Math.random() * 1e9) | 0 }
    this.propTorque = s.propTorque
    this.totalMass = s.mass
    this.world = new R.World({ x: 0, y: -G, z: 0 })
    this.world.timestep = WRECK_DT
    // Un único sub-paso con 8 iteraciones internas; la finura la da el paso de
    // 1/480 s. Así el impulso de los eventos de contacto es exactamente el de todo
    // el paso (con 4 sub-pasos Rapier 0.21 lo sobrestima un ~17 % en reposo).
    // Desde Rapier 0.20 el rozamiento se resuelve junto con el contacto: ya no hay
    // iteraciones de rozamiento adicionales que ajustar.
    this.world.integrationParameters.numSolverIterations = 1
    this.world.integrationParameters.numInternalPgsIterations = 8
    this.world.integrationParameters.maxCcdSubsteps = 2
    // Contactos predictivos a 2 mm (el valor de Rapier hasta la 0.19; desde la 0.20 son
    // 2 cm, pensados para pasos de 1/60 s). Con 2 cm el tren rebota casi elástico en
    // una toma firme (de −2,5 a +2,3 m/s) y rompe ejes y mástil. Con pasos de 1/480 s y
    // CCD en los cuerpos rápidos no hace falta más margen.
    this.world.integrationParameters.normalizedPredictionDistance = 0.002
    const ip = this.world.integrationParameters
    this.contactReach = ip.normalizedPredictionDistance * ip.lengthUnit
    this.eq = new R.EventQueue(true)
    const ignore = this.ignore
    this.hooks = {
      filterContactPair: (_c1, _c2, b1, b2) => (ignore.has(b1 < b2 ? `${b1}:${b2}` : `${b2}:${b1}`) ? null : R.SolverFlags.COMPUTE_IMPULSE),
      filterIntersectionPair: () => true,
    }
    this.rotorAxisLocal = s.shapes.rotorAxis.clone().normalize()
    this.spec = s.spec ?? GENERIC_WRECK
    this.build(s)
  }

  // ---------------------------------------------------------------------------
  // Construcción
  // ---------------------------------------------------------------------------
  private build(s: WreckStart): void {
    const R = this.R
    const sh = s.shapes
    const defs = makePartDefs(this.spec)
    // centros de masas de cada pieza (modelo)
    const coms = new Map<string, Vector3>()
    for (const d of defs) {
      const h = sh.hulls.get(d.id)
      if (h && h.length) coms.set(d.id, centroid(h))
    }
    for (const w of ['wheelL', 'wheelR', 'wheelN'] as const) coms.set(w, sh.wheels[w].center.clone())
    const podMP = podMassProperties(defs, s.mass, coms)

    // pose común: el marco de todos los cuerpos es el del modelo en el choque
    const qBody = s.quat.clone()
    const origin = CG.clone().applyQuaternion(qBody).negate().add(s.pos)
    if (s.heightAt) origin.y += this.clearance(s, origin, qBody)
    const omegaW = s.omegaBody.clone().applyQuaternion(qBody)
    const velAt = (pModel: Vector3, out: Vector3) => {
      // velocidad del punto (modelo) como sólido rígido del fuselaje
      const r = _d.copy(pModel).sub(CG).applyQuaternion(qBody)
      return out.crossVectors(omegaW, r).add(s.vel)
    }

    // piezas
    for (const d of defs) {
      const part: Part = {
        def: d,
        id: d.id,
        body: null as unknown as Body,
        parent: null,
        children: [],
        attached: d.parent !== null,
        descs: [],
        colliders: [],
        mass: d.id === 'pod' ? podMP.mass : d.mass,
        com: d.id === 'pod' ? podMP.com.clone() : (coms.get(d.id) ?? CG.clone()),
        attach: d.attach.clone(),
        fMax: d.fMax * (0.85 + 0.3 * rnd(this.seed)),
        mMax: d.mMax * (0.85 + 0.3 * rnd(this.seed)),
        fF: new Vector3(),
        fM: new Vector3(),
        fc: new Vector3(),
        lc: new Vector3(),
        fj: new Vector3(),
        lj: new Vector3(),
        best: null,
        lastSpawn: -1,
        ff: new Vector3(),
        fp: new Vector3(),
      }
      this.parts.set(d.id, part)
    }
    for (const p of this.parts.values()) {
      if (p.def.parent) {
        p.parent = this.parts.get(p.def.parent)!
        p.parent.children.push(p)
      }
    }
    // puntos de unión que dependen de la postura: palas a lo largo de su dirección
    const n = this.rotorAxisLocal
    const bdir = sh.bladeDir.clone().addScaledVector(n, -sh.bladeDir.dot(n)).normalize()
    const cuts = bladeCuts(this.spec.rotorR)
    bladeSides(this.spec).forEach((side, i) => {
      // pala i: la A girada i·360°/N alrededor del eje (con dos palas, B = −A)
      const d = _a.copy(bdir).applyAxisAngle(n, (i * 2 * Math.PI) / this.spec.blades)
      for (let k = 0; k < 3; k++) this.parts.get(`blade${side}${k}`)!.attach.copy(sh.hub).addScaledVector(d, cuts[k])
    })
    for (let k = 0; k < this.spec.propBlades; k++) {
      const pb = this.parts.get(`prop${k}`)!
      // raíz de la pala: a PROP_HUB_R del eje, hacia el centro de la pala
      const c = _a.copy(pb.com).sub(sh.prop)
      c.addScaledVector(sh.propAxis, -c.dot(sh.propAxis))
      if (c.lengthSq() > 1e-6) c.setLength(0.13)
      pb.attach.copy(sh.prop).add(c)
    }

    // descriptores de colisión
    for (const p of this.parts.values()) this.makeDescs(p, sh, podMP)

    // cuerpos: fuselaje, rotor, hélice, ruedas
    const bodyOf = (rootId: string, spin: Vector3 | null) => {
      const roots = [...this.parts.values()].filter((p) => p.id === rootId || this.rootOf(p).id === rootId)
      const b = this.createBody(origin, qBody, roots)
      const com = v3(b.rb.worldCom())
      const v = velAt(_b.copy(com).sub(origin).applyQuaternion(_q.copy(qBody).invert()), _c)
      b.rb.setLinvel(v, true)
      const w = omegaW.clone()
      if (spin) w.add(spin)
      b.rb.setAngvel(w, true)
      b.v0.copy(v)
      b.w0.copy(w)
      return b
    }
    bodyOf('pod', null)
    const axisW = n.clone().applyQuaternion(qBody)
    const rb = bodyOf('rotorHub', axisW.clone().multiplyScalar(s.rotorOmega))
    rb.rb.enableCcd(true)
    const propAxisW = sh.propAxis.clone().applyQuaternion(qBody)
    bodyOf('propHub', propAxisW.clone().multiplyScalar(-s.propOmega)).rb.enableCcd(true)
    for (const w of ['wheelL', 'wheelR', 'wheelN'] as const) {
      const ws = sh.wheels[w]
      const fwd = velAt(ws.center, _p).dot(_a.set(1, 0, 0).applyQuaternion(qBody))
      const spin = ws.axis.clone().applyQuaternion(qBody).multiplyScalar(-fwd / ws.radius)
      const b = bodyOf(w, spin)
      b.rb.setAngularDamping(0.15)
    }

    // ejes
    for (const jd of makeJointDefs(this.spec.zones)) {
      if (jd.id === 'rotor') {
        jd.anchor.copy(sh.hub)
        jd.axis.copy(n)
      } else if (jd.id === 'prop') {
        jd.anchor.copy(sh.prop)
        jd.axis.copy(sh.propAxis)
      } else {
        const w = sh.wheels[jd.b as 'wheelL' | 'wheelR' | 'wheelN']
        jd.anchor.copy(w.center)
        jd.axis.copy(w.axis)
      }
      const j: Joint = {
        def: jd,
        a: this.parts.get(jd.a)!,
        b: this.parts.get(jd.b)!,
        joint: null,
        broken: false,
        fF: new Vector3(),
        fMax: jd.fMax * (0.85 + 0.3 * rnd(this.seed)),
      }
      this.joints.push(j)
      this.attachJoint(j)
    }

    // fallo de partida
    for (const id of s.preBreak) {
      const p = this.parts.get(id)
      if (p && p.attached) this.split(p, 2)
      const j = this.joints.find((jj) => jj.def.id === id)
      if (j && !j.broken) this.breakJoint(j, 2)
    }
    if (s.rotorKick) {
      const rotor = this.parts.get('rotorHub')!.body.rb
      const kick = _a.crossVectors(axisW, _b.set(0, 1, 0)).normalize()
      if (kick.lengthSq() < 0.1) kick.set(1, 0, 0)
      rotor.applyTorqueImpulse(kick.multiplyScalar(260 * (0.7 + 0.6 * rnd(this.seed))), true)
      rotor.applyImpulse(_b.copy(axisW).multiplyScalar(120), true)
    }
  }

  /** Cuánto hay que subir el conjunto para que el fuselaje y las ruedas no empiecen enterrados. */
  private clearance(s: WreckStart, origin: Vector3, q: Quaternion): number {
    let pen = -Infinity
    const p = new Vector3()
    const test = (x: number, y: number, z: number) => {
      p.set(x, y, z).applyQuaternion(q).add(origin)
      const g = s.heightAt!(p.x, p.z)
      if (g !== null) pen = Math.max(pen, g - p.y)
    }
    for (const [id, hulls] of s.shapes.hulls) {
      if (/^blade|^prop|^rotorHub/.test(id)) continue // las palas que tocan el suelo se rompen
      for (const h of hulls) for (let i = 0; i < h.length; i += 3) test(h[i], h[i + 1], h[i + 2])
    }
    for (const w of Object.values(s.shapes.wheels)) {
      // punto más bajo de la rueda: en el plano de la rueda, hacia abajo
      const ax = w.axis.clone().applyQuaternion(q)
      const down = new Vector3(0, -1, 0).addScaledVector(ax, ax.y)
      if (down.lengthSq() > 1e-6) down.setLength(w.radius)
      const c = w.center.clone().applyQuaternion(q).add(down).sub(origin.clone().sub(origin))
      const lc = c.applyQuaternion(q.clone().invert())
      test(lc.x, lc.y, lc.z)
    }
    return pen > -0.005 ? Math.min(1.5, pen + 0.005) : 0
  }

  private rootOf(p: Part): Part {
    let r = p
    while (r.parent && r.attached) r = r.parent
    return r
  }

  private makeDescs(p: Part, sh: PartShapes, podMP: { mass: number; com: Vector3 }): void {
    const R = this.R
    const d = p.def
    const group = d.group === 'rotor' ? (d.id === 'rotorHub' ? G_HUB : G_BLADE) : d.group === 'prop' ? (d.id === 'propHub' ? G_HUB : G_PROPB) : /^wheel[LRN]$/.test(d.id) ? G_WHEEL : G_AIR
    const finish = (desc: RapierNS.ColliderDesc) =>
      desc
        .setFriction(d.friction)
        .setRestitution(d.restitution)
        .setCollisionGroups(group)
        .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(2)
        .setActiveHooks(R.ActiveHooks.FILTER_CONTACT_PAIRS)
    if (/^wheel[LRN]$/.test(d.id)) {
      const w = sh.wheels[d.id as 'wheelL' | 'wheelR' | 'wheelN']
      const rr = 0.04
      const desc = R.ColliderDesc.roundCylinder(Math.max(0.01, w.halfWidth - rr), Math.max(0.02, w.radius - rr), rr)
      _q.setFromUnitVectors(_a.set(0, 1, 0), _b.copy(w.axis).normalize())
      desc.setTranslation(w.center.x, w.center.y, w.center.z).setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }).setMass(p.mass)
      p.descs.push(finish(desc))
      return
    }
    const hulls = sh.hulls.get(d.id) ?? []
    const descs: RapierNS.ColliderDesc[] = []
    for (const pts of hulls) {
      if (pts.length < 12) continue
      let desc = R.ColliderDesc.convexHull(pts)
      if (!desc) desc = boxDesc(R, pts)
      if (desc) descs.push(desc)
    }
    if (!descs.length) {
      // pieza sin geometría: bolita en su centro de masas
      descs.push(R.ColliderDesc.ball(0.08).setTranslation(p.com.x, p.com.y, p.com.z))
    }
    if (d.id === 'pod') {
      const s = podMP.mass / 310
      descs[0].setMassProperties(podMP.mass, { x: podMP.com.x, y: podMP.com.y, z: podMP.com.z }, { x: 200 * s, y: 300 * s, z: 330 * s }, { x: 0, y: 0, z: 0, w: 1 })
      for (let i = 1; i < descs.length; i++) descs[i].setDensity(0)
    } else {
      for (const desc of descs) desc.setMass(p.mass / descs.length)
    }
    for (const desc of descs) p.descs.push(finish(desc))
  }

  private createBody(origin: Vector3, q: Quaternion, parts: Part[]): Body {
    const R = this.R
    const rb = this.world.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(origin.x, origin.y, origin.z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setAngularDamping(0.02)
        .setCanSleep(true),
    )
    const body: Body = { rb, parts: [], v0: new Vector3(), w0: new Vector3(), a: new Vector3(), alpha: new Vector3(), fresh: true, cdA: 0, fx: new Vector3(), tx: new Vector3(), fh: new Vector3() }
    for (const p of parts) this.addPartTo(p, body)
    rb.recomputeMassPropertiesFromColliders()
    this.bodies.push(body)
    return body
  }

  private addPartTo(p: Part, body: Body): void {
    p.body = body
    p.colliders = p.descs.map((d) => this.world.createCollider(d, body.rb))
    for (const c of p.colliders) this.owners.set(c.handle, { kind: 'part', part: p })
    body.parts.push(p)
    body.cdA += p.def.cdA
  }

  private attachJoint(j: Joint): void {
    const R = this.R
    const a = j.def.anchor
    const ax = j.def.axis
    const data = R.JointData.revolute({ x: a.x, y: a.y, z: a.z }, { x: a.x, y: a.y, z: a.z }, { x: ax.x, y: ax.y, z: ax.z })
    j.joint = this.world.createImpulseJoint(data, j.a.body.rb, j.b.body.rb, true)
  }

  // ---------------------------------------------------------------------------
  // Escenario
  // ---------------------------------------------------------------------------
  /** Suelo como campo de alturas de size×size m centrado en (cx, cz). */
  setGround(heightAt: (x: number, z: number) => number | null, cx: number, cz: number, size = 128, cells = 64): void {
    const R = this.R
    const n = cells
    const h = new Float32Array((n + 1) * (n + 1))
    let fallback = 0
    let have = false
    const step = size / n
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const x = cx - size / 2 + j * step
        const z = cz - size / 2 + i * step
        const y = heightAt(x, z)
        if (y !== null && Number.isFinite(y)) {
          if (!have) {
            fallback = y
            have = true
          }
          h[i + j * (n + 1)] = y
        } else h[i + j * (n + 1)] = NaN
      }
    }
    for (let k = 0; k < h.length; k++) if (Number.isNaN(h[k])) h[k] = fallback
    if (this.ground) {
      this.owners.delete(this.ground.handle)
      this.world.removeCollider(this.ground, true)
    }
    // FIX_INTERNAL_EDGES: sin él, las piezas que se arrastran por el terreno tropiezan con
    // las aristas entre triángulos (Rapier ≥ 0.13 ya no lo activa por defecto).
    const desc = R.ColliderDesc.heightfield(n, n, h, { x: size, y: 1, z: size }, R.HeightFieldFlags.FIX_INTERNAL_EDGES)
      .setTranslation(cx, 0, cz)
      .setFriction(1)
      .setFrictionCombineRule(R.CoefficientCombineRule.Multiply)
      .setRestitution(0.05)
      .setCollisionGroups(G_WORLD)
    this.ground = this.world.createCollider(desc)
    this.owners.set(this.ground.handle, { kind: 'ground' })
    this.groundCenter.set(cx, 0, cz)
    for (const b of this.bodies) b.rb.wakeUp()
  }

  /** Obstáculos (edificios, árboles, teselas 3D) como malla de triángulos (9 floats por triángulo). */
  setObstacles(tris: Float32Array | null, cx: number, cz: number): void {
    const R = this.R
    if (this.obstacles) {
      this.owners.delete(this.obstacles.handle)
      this.world.removeCollider(this.obstacles, true)
      this.obstacles = null
    }
    this.obstacleCenter.set(cx, 0, cz)
    if (!tris || tris.length < 9) return
    const nt = tris.length / 9
    const idx = new Uint32Array(nt * 3)
    for (let i = 0; i < idx.length; i++) idx[i] = i
    const desc = R.ColliderDesc.trimesh(tris, idx)
      .setFriction(1)
      .setFrictionCombineRule(R.CoefficientCombineRule.Multiply)
      .setRestitution(0.05)
      .setCollisionGroups(G_WORLD)
    this.obstacles = this.world.createCollider(desc)
    this.owners.set(this.obstacles.handle, { kind: 'obstacle' })
    for (const b of this.bodies) b.rb.wakeUp()
  }

  // ---------------------------------------------------------------------------
  // Paso
  // ---------------------------------------------------------------------------
  step(): void {
    const dt = WRECK_DT
    this.time += dt
    // 1) estado previo y fuerzas externas
    for (const b of this.bodies) {
      const rb = b.rb
      v3(rb.linvel(), b.v0)
      v3(rb.angvel(), b.w0)
      rb.resetForces(false)
      rb.resetTorques(false)
      b.fx.set(0, 0, 0)
      b.tx.set(0, 0, 0)
      b.fh.set(0, 0, 0)
    }
    for (const b of this.bodies) if (!b.rb.isSleeping()) this.aero(b)
    for (const b of this.bodies) {
      if (b.fx.lengthSq() > 0) b.rb.addForce(b.fx, true)
      if (b.tx.lengthSq() > 0) b.rb.addTorque(b.tx, true)
    }
    if (this.foliage) this.branches()
    // 2) Rapier
    this.world.step(this.eq, this.hooks)
    if (this.ignore.size) this.refreshIgnored()
    // 3) cinemática de cada cuerpo
    for (const b of this.bodies) {
      const rb = b.rb
      const v = v3(rb.linvel(), _a)
      const w = v3(rb.angvel(), _b)
      if (b.fresh) {
        b.fresh = false
        b.a.set(0, 0, 0)
        b.alpha.set(0, 0, 0)
      } else {
        b.a.copy(v).sub(b.v0).multiplyScalar(1 / dt)
        b.alpha.copy(w).sub(b.w0).multiplyScalar(1 / dt)
      }
      for (const p of b.parts) {
        // las ramas cuentan como un contacto más (para cargas y efectos)
        p.fc.copy(p.ff)
        p.lc.crossVectors(p.fp, p.ff)
        p.fj.set(0, 0, 0)
        p.lj.set(0, 0, 0)
        p.best = null
        if (p.ff.lengthSq() > 1) {
          const f = p.ff.length()
          const v = this.pointVel(b.rb, p.fp, new Vector3())
          const sp = v.length()
          p.best = {
            part: p.id,
            material: p.def.material,
            surface: 'foliage',
            point: p.fp.clone(),
            normal: p.ff.clone().multiplyScalar(1 / f),
            impulse: f * dt,
            slide: sp,
            tangent: sp > 1e-3 ? v.multiplyScalar(1 / sp) : new Vector3(),
            approach: sp,
          }
        }
        p.ff.set(0, 0, 0)
      }
    }
    // 4) contactos
    this.eq.drainContactForceEvents((e) => this.onContact(e))
    // 5) ejes: fuerza que transmiten y rotura
    for (const j of this.joints) if (!j.broken) this.evalJoint(j, dt)
    // 6) uniones rígidas
    const toBreak: Array<{ p: Part; ratio: number }> = []
    for (const b of this.bodies) this.evalBody(b, dt, toBreak)
    toBreak.sort((x, y) => y.ratio - x.ratio)
    for (const { p, ratio } of toBreak) if (p.attached) this.split(p, ratio)
    // 7) impactos para efectos
    for (const p of this.parts.values()) if (p.best) this.impacts.push(p.best)
    if (this.impacts.length > 400) this.impacts.splice(0, this.impacts.length - 400)
    // 8) deceleración en el asiento
    this.seatLoad(dt)
  }

  /** Aerodinámica: resistencia de cada cuerpo, disco del rotor en autorrotación, motor. */
  private aero(b: Body): void {
    const rb = b.rb
    const v = v3(rb.linvel(), _a).sub(this.wind)
    const V = v.length()
    if (V > 0.05) b.fx.addScaledVector(v, -0.5 * this.rho * b.cdA * V)
    const hubPart = this.parts.get('rotorHub')!
    if (hubPart.body === b) {
      // ¿cuánta pala queda unida al buje? (fracción del par de perfil, ∝ ∫r³dr)
      let frac = 0
      const { rotorR: ROTOR_R, rotorOmega0: ROTOR_OMEGA0, blades } = this.spec
      const cuts = bladeCuts(ROTOR_R)
      for (const side of bladeSides(this.spec)) {
        for (let k = 0; k < 3; k++) {
          const p = this.parts.get(`blade${side}${k}`)!
          if (p.body !== b || !this.isConnected(p, hubPart)) break
          const r0 = cuts[k]
          const r1 = cuts[k + 1]
          frac += (r1 ** 4 - r0 ** 4) / (blades * (ROTOR_R ** 4 - BLADE_ROOT ** 4))
        }
      }
      const q = rb.rotation()
      const axis = _c.copy(this.rotorAxisLocal).applyQuaternion(_q.set(q.x, q.y, q.z, q.w))
      const w = v3(rb.angvel(), _d)
      const omega = w.dot(axis)
      let T = 0
      if (frac > 0.999 && Math.abs(omega) > 12) {
        // disco entero en autorrotación: empuje ∝ V·(flujo que lo atraviesa de abajo arriba).
        // En descenso vertical da el equilibrio de ~10 m/s del modelo de vuelo.
        const vn = v.dot(axis) * Math.sign(omega)
        T = 0.5 * this.rho * Math.PI * ROTOR_R * ROTOR_R * 1.25 * V * Math.max(0, -vn) * Math.min(1, (omega / (0.6 * ROTOR_OMEGA0)) ** 2)
        b.fx.addScaledVector(axis, T * Math.sign(omega))
        b.fh.addScaledVector(axis, T * Math.sign(omega))
      }
      if (T > 300) {
        // las vueltas tienden a las de equilibrio con esa carga (Ω ∝ √T)
        const omegaEq = ROTOR_OMEGA0 * Math.sqrt(T / (this.totalMass * G))
        b.tx.addScaledVector(axis, (this.spec.rotorInertia * (Math.sign(omega) * omegaEq - omega)) / 2.5)
      } else {
        // sin flujo que lo mueva: frena por la resistencia de perfil + cojinete
        // (resistencia de perfil ∝ superficie de pala × R⁴: la del Cierva frena unas 4 veces más)
        const kd = 0.179 * (this.spec.blades / 2) * (ROTOR_R / 4.2) ** 4
        b.tx.addScaledVector(axis, -(kd * frac * omega * Math.abs(omega) + 4 * Math.tanh(omega)))
      }
    }
    // resistencia a la rodadura de las ruedas (par entre rueda y pata)
    for (const j of this.joints) {
      if (j.broken || j.b.body !== b || !j.def.id.startsWith('axle')) continue
      const q = rb.rotation()
      const axis = _c.copy(j.def.axis).applyQuaternion(_q.set(q.x, q.y, q.z, q.w))
      const wRel = v3(rb.angvel(), _d).sub(v3(j.a.body.rb.angvel(), _p)).dot(axis)
      const tr = (j.def.id === 'axleN' ? 3 : 6) * Math.tanh(wRel / 0.3)
      b.tx.addScaledVector(axis, -tr)
      j.a.body.tx.addScaledVector(axis, tr)
    }
    const propHub = this.parts.get('propHub')!
    if (propHub.body === b) {
      const q = rb.rotation()
      const axis = _c.set(1, 0, 0).applyQuaternion(_q.set(q.x, q.y, q.z, q.w))
      const w = v3(rb.angvel(), _d)
      // el giro de la hélice es alrededor de −X
      const om = -w.dot(axis)
      let nBlades = 0
      const pb = this.spec.propBlades
      for (let k = 0; k < pb; k++) if (this.parts.get(`prop${k}`)!.body === b) nBlades++
      const n = om / (2 * Math.PI)
      // par aerodinámico (externo)
      const Qa = -(this.spec.propCp0 * this.rho * n * Math.abs(n) * (2 * this.spec.propR) ** 5 * (nBlades / pb)) / (2 * Math.PI)
      // par del motor (interno: reacción sobre el fuselaje). Sigue tirando medio
      // segundo tras el golpe y después se cala (compresión + rozamiento).
      const j = this.joints.find((jj) => jj.def.id === 'prop')!
      const Qe = j.broken ? 0 : this.time < 0.5 ? this.propTorque - 10 * Math.tanh(om / 5) : -40 * Math.tanh(om / 5)
      b.tx.addScaledVector(axis, -(Qa + Qe))
      if (!j.broken) j.a.body.tx.addScaledVector(axis, Qe)
    }
  }

  /**
   * Copa de los árboles: las ramas frenan lo que las atraviesa con una fuerza
   * proporcional a v² (se para en unos pocos metros de copa). Las palas que giran
   * dentro se llevan fuerzas enormes y se parten, como en la realidad.
   */
  private branches(): void {
    const L = 2.5 // metros de copa para frenar
    for (const p of this.parts.values()) {
      const b = p.body
      if (b.rb.isSleeping()) continue
      const c = this.toWorld(b, p.com, new Vector3())
      if (!this.foliage!(c)) continue
      const v = this.pointVel(b.rb, c, new Vector3()).sub(this.wind)
      const sp = v.length()
      if (sp < 0.3) continue
      // tope: lo que aguantan las ramas antes de partirse (una pala las siega)
      const F = Math.min(/^blade|^prop\d/.test(p.id) ? 8000 : 40000, (p.mass * sp * sp) / L)
      p.ff.copy(v).multiplyScalar(-F / sp)
      p.fp.copy(c)
      b.rb.addForceAtPoint(p.ff, c, true)
    }
  }

  private isConnected(p: Part, root: Part): boolean {
    let r: Part | null = p
    while (r) {
      if (r === root) return true
      if (!r.attached) return false
      r = r.parent
    }
    return false
  }

  // ---------------------------------------------------------------------------
  // Contactos
  // ---------------------------------------------------------------------------
  private onContact(e: RapierNS.TempContactForceEvent): void {
    const h1 = e.collider1()
    const h2 = e.collider2()
    const o1 = this.owners.get(h1)
    const o2 = this.owners.get(h2)
    if (!o1 || !o2) return
    const mag = e.totalForceMagnitude()
    if (mag < 1) return
    const tf = v3(e.totalForce(), _a)
    // Punto de contacto: media de los puntos del manifold que están en contacto
    // (a menos de la distancia de predicción, los mismos que usa el solver), cada
    // uno a medio camino entre las dos superficies. Desde Rapier 0.20 el solver
    // trabaja con contactos agrupados que la API de JS no expone
    // (numSolverContacts() es siempre 0), así que se parte de los geométricos.
    // Si el par ya se ha separado al final del paso, vale el punto más cercano.
    const c1 = this.world.getCollider(h1)
    const c2 = this.world.getCollider(h2)
    const reach = this.contactReach
    _p.set(0, 0, 0)
    let np = 0
    let dMin = Infinity
    this.world.contactPair(c1, c2, (m, flipped) => {
      for (let i = 0, k = m.numContacts(); i < k; i++) {
        const d = m.contactDist(i)
        const near = d <= reach
        if (!near && (np > 0 || d >= dMin)) continue
        const l1 = flipped ? m.localContactPoint2(i) : m.localContactPoint1(i)
        const l2 = flipped ? m.localContactPoint1(i) : m.localContactPoint2(i)
        if (!l1 || !l2) continue
        const mid = colliderToWorld(c1, l1, _w1).add(colliderToWorld(c2, l2, _w2)).multiplyScalar(0.5)
        if (near) {
          if (np === 0) _p.set(0, 0, 0) // descarta el de reserva
          _p.add(mid)
          np++
        } else {
          _p.copy(mid)
          dMin = d
        }
      }
    })
    if (np > 0) _p.multiplyScalar(1 / np)
    else if (dMin === Infinity) return
    // fuerza sobre 2 = +tf, sobre 1 = −tf
    if (o1.kind === 'part') this.addContact(o1.part, _b.copy(tf).negate(), _p, o2, mag)
    if (o2.kind === 'part') this.addContact(o2.part, _b.copy(tf), _p, o1, mag)
  }

  private addContact(p: Part, F: Vector3, point: Vector3, other: Owner, mag: number): void {
    const rb = p.body.rb
    // velocidad relativa en el punto
    const vp = this.pointVel(rb, point, _c)
    if (other.kind === 'part') vp.sub(this.pointVel(other.part.body.rb, point, _d))
    else if (other.kind === 'debris') vp.sub(this.pointVel(other.chunk.rb, point, _d))
    const nHat = _n.copy(F).normalize()
    const vn = vp.dot(nHat)
    const vt = vp.addScaledVector(nHat, -vn)
    const slide = vt.length()
    // rozamiento (Rapier no lo da en el evento): μ·N opuesto al deslizamiento
    const mu = other.kind === 'ground' || other.kind === 'obstacle' ? p.def.friction : 0.6
    const Ft = mag * mu * Math.min(1, slide / 0.3)
    const tangent = slide > 1e-3 ? vt.clone().multiplyScalar(1 / slide) : new Vector3()
    const Ftot = _d.copy(F).addScaledVector(tangent, -Ft)
    p.fc.add(Ftot)
    p.lc.add(_c.crossVectors(point, Ftot))
    const impulse = mag * WRECK_DT
    if (!p.best || impulse > p.best.impulse) {
      p.best = {
        part: p.id,
        material: p.def.material,
        surface: other.kind,
        point: point.clone(),
        normal: nHat.clone(),
        impulse,
        slide,
        tangent,
        approach: Math.max(0, -vn),
      }
    }
    // cascotes al golpear un obstáculo (pared, tejado, árbol)
    if (other.kind === 'obstacle' && impulse > 0.9 && this.time - p.lastSpawn > 0.06) {
      p.lastSpawn = this.time
      this.spawnChunks(point, nHat, tangent.clone().multiplyScalar(slide), impulse)
    }
  }

  private pointVel(rb: RapierNS.RigidBody, p: Vector3, out: Vector3): Vector3 {
    const com = rb.worldCom()
    const w = rb.angvel()
    const v = rb.linvel()
    const rx = p.x - com.x
    const ry = p.y - com.y
    const rz = p.z - com.z
    return out.set(v.x + w.y * rz - w.z * ry, v.y + w.z * rx - w.x * rz, v.z + w.x * ry - w.y * rx)
  }

  // ---------------------------------------------------------------------------
  // Cargas y roturas
  // ---------------------------------------------------------------------------
  /**
   * Aceleración (menos g) de un punto del cuerpo, multiplicada por m.
   * `centripetal = false` en palas: la flexión estacionaria por fuerza centrífuga
   * y empuje la equilibra la conicidad de las palas, no la estructura.
   */
  private inertial(b: Body, pointWorld: Vector3, m: number, out: Vector3, centripetal = true): Vector3 {
    const com = v3(b.rb.worldCom())
    const r = new Vector3().subVectors(pointWorld, com)
    // a + α×r + ω×(ω×r)
    out.crossVectors(b.alpha, r)
    if (centripetal) {
      const w = v3(b.rb.angvel())
      const wr = new Vector3().crossVectors(w, r)
      out.add(new Vector3().crossVectors(w, wr))
    }
    out.add(b.a).sub(GRAV)
    return out.multiplyScalar(m)
  }

  private toWorld(b: Body, local: Vector3, out: Vector3): Vector3 {
    const t = b.rb.translation()
    const q = b.rb.rotation()
    return out.copy(local).applyQuaternion(_q.set(q.x, q.y, q.z, q.w)).add(_p.set(t.x, t.y, t.z))
  }

  private evalJoint(j: Joint, dt: number): void {
    const bc = j.b.body
    const rb = bc.rb
    const m = rb.mass()
    // F del eje sobre el cuerpo hijo = m(a − g) − contactos − fuerzas externas
    const F = new Vector3().copy(bc.a).sub(GRAV).multiplyScalar(m)
    const com = v3(rb.worldCom())
    const L = new Vector3() // Σ momentos externos respecto al CDM
    for (const p of bc.parts) {
      F.sub(p.fc)
      // r×F = (lc − com×fc)
      L.add(p.lc).sub(new Vector3().crossVectors(com, p.fc))
    }
    F.sub(bc.fx)
    L.add(bc.tx)
    // dL/dt = I·α + ω×(I·ω)
    const Iw = this.worldInertia(rb)
    const w = v3(rb.angvel())
    const dL = applyMat(Iw, bc.alpha).add(new Vector3().crossVectors(w, applyMat(Iw, w)))
    const anchorW = this.toWorld(bc, j.def.anchor, new Vector3())
    // par del eje sobre el hijo (excluido el de la fuerza en el ancla)
    const tau = dL.sub(L).sub(new Vector3().subVectors(anchorW, com).cross(F))
    j.fF.lerp(F, Math.min(1, dt / j.def.tau))
    if (j.fF.length() > j.fMax) {
      this.breakJoint(j, j.fF.length() / j.fMax)
      return
    }
    // reacción sobre la pieza del lado fijo
    const pa = j.a
    pa.fj.sub(F)
    pa.lj.add(new Vector3().crossVectors(anchorW, F).negate()).sub(tau)
  }

  private worldInertia(rb: RapierNS.RigidBody): number[] {
    const I = rb.principalInertia()
    const f = rb.principalInertiaLocalFrame()
    const q = rb.rotation()
    const rq = new Quaternion(q.x, q.y, q.z, q.w).multiply(new Quaternion(f.x, f.y, f.z, f.w))
    // M = R·diag(I)·Rᵀ
    const x = new Vector3(1, 0, 0).applyQuaternion(rq)
    const y = new Vector3(0, 1, 0).applyQuaternion(rq)
    const z = new Vector3(0, 0, 1).applyQuaternion(rq)
    const m = new Array(9).fill(0)
    const add = (a: Vector3, s: number) => {
      m[0] += s * a.x * a.x; m[1] += s * a.x * a.y; m[2] += s * a.x * a.z
      m[3] += s * a.y * a.x; m[4] += s * a.y * a.y; m[5] += s * a.y * a.z
      m[6] += s * a.z * a.x; m[7] += s * a.z * a.y; m[8] += s * a.z * a.z
    }
    add(x, I.x)
    add(y, I.y)
    add(z, I.z)
    return m
  }

  private evalBody(b: Body, dt: number, out: Array<{ p: Part; ratio: number }>): void {
    if (b.rb.isSleeping()) return
    // recorrido en post-orden de las piezas unidas dentro del cuerpo
    const F = new Map<Part, Vector3>()
    const L = new Map<Part, Vector3>()
    const shareAero = b.cdA > 0 ? 1 / b.cdA : 0
    const visit = (p: Part) => {
      const f = new Vector3()
      const l = new Vector3()
      for (const c of p.children) {
        if (!c.attached || c.body !== b) continue
        visit(c)
        f.add(F.get(c)!)
        l.add(L.get(c)!)
      }
      const c = this.toWorld(b, p.com, new Vector3())
      const blade = /^blade|^prop\d/.test(p.id)
      const fi = this.inertial(b, c, p.mass, new Vector3(), !blade)
      // fuerzas externas sobre la pieza: contacto, ejes y su parte de aerodinámica
      // (el empuje del disco va entero al buje)
      const fa = new Vector3().subVectors(b.fx, b.fh).multiplyScalar(p.def.cdA * shareAero)
      if (p.id === 'rotorHub') fa.add(b.fh)
      f.add(fi).sub(p.fc).sub(p.fj).sub(fa)
      l.add(new Vector3().crossVectors(c, fi)).sub(p.lc).sub(p.lj).sub(new Vector3().crossVectors(c, fa))
      F.set(p, f)
      L.set(p, l)
      if (p.parent && p.attached && p.parent.body === b) {
        const A = this.toWorld(b, p.attach, new Vector3())
        const M = new Vector3().copy(l).sub(new Vector3().crossVectors(A, f))
        const k = Math.min(1, dt / p.def.tau)
        p.fF.lerp(f, k)
        p.fM.lerp(M, k)
        const ratio = Math.max(p.fF.length() / p.fMax, p.fM.length() / p.mMax)
        if (ratio > 1) out.push({ p, ratio })
      }
    }
    for (const p of b.parts) if (!p.parent || !p.attached || p.parent.body !== b) visit(p)
  }

  /** Desprende la pieza `p` (y lo que cuelga de ella) a un sólido nuevo. */
  private split(p: Part, ratio: number): void {
    const B = p.body
    const sub: Part[] = []
    const collect = (q: Part) => {
      sub.push(q)
      for (const c of q.children) if (c.attached && c.body === B) collect(c)
    }
    collect(p)
    p.attached = false
    const rb = B.rb
    const v = v3(rb.linvel())
    const w = v3(rb.angvel())
    const comOld = v3(rb.worldCom())
    const t = v3(rb.translation())
    const qr = rb.rotation()
    const q = new Quaternion(qr.x, qr.y, qr.z, qr.w)
    for (const s of sub) {
      for (const c of s.colliders) {
        this.owners.delete(c.handle)
        this.world.removeCollider(c, false)
      }
      s.colliders = []
      B.cdA -= s.def.cdA
    }
    B.parts = B.parts.filter((x) => !sub.includes(x))
    rb.recomputeMassPropertiesFromColliders()
    const comB = v3(rb.worldCom())
    rb.setLinvel(new Vector3().crossVectors(w, comB.clone().sub(comOld)).add(v), true)
    const nb = this.createBody(t, q, sub)
    this.ignorePair(nb, B)
    const comN = v3(nb.rb.worldCom())
    const vN = new Vector3().crossVectors(w, comN.sub(comOld)).add(v)
    nb.rb.setLinvel(vN, true)
    nb.rb.setAngvel(w, true)
    nb.v0.copy(vN)
    nb.w0.copy(w)
    if (/^blade|^prop\d|^tail/.test(p.id)) nb.rb.enableCcd(true)
    for (const j of this.joints) if (!j.broken && (sub.includes(j.a) || sub.includes(j.b))) this.reattach(j)
    const at = this.toWorld(nb, p.attach, new Vector3())
    this.breaks.push({ id: p.id, name: p.def.name, point: at, ratio })
  }

  private pairKey(a: Body, b: Body): string {
    const ha = a.rb.handle
    const hb = b.rb.handle
    return ha < hb ? `${ha}:${hb}` : `${hb}:${ha}`
  }

  private ignorePair(a: Body, b: Body): void {
    this.ignore.set(this.pairKey(a, b), { a, b, check: this.time + 0.12 })
  }

  /** Quita de la lista los pares que ya no se solapan (cada 50 ms). */
  private refreshIgnored(): void {
    for (const [k, p] of this.ignore) {
      if (this.time < p.check) continue
      p.check = this.time + 0.05
      if (!this.bodies.includes(p.a) || !this.bodies.includes(p.b)) {
        this.ignore.delete(k)
        continue
      }
      let overlap = false
      for (const pa of p.a.parts) {
        for (const ca of pa.colliders) {
          for (const pb of p.b.parts) {
            for (const cb of pb.colliders) {
              const c = ca.contactCollider(cb, 0)
              if (c && c.distance < -0.005) {
                overlap = true
                break
              }
            }
            if (overlap) break
          }
          if (overlap) break
        }
        if (overlap) break
      }
      if (!overlap) this.ignore.delete(k)
    }
  }

  private reattach(j: Joint): void {
    if (j.joint) this.world.removeImpulseJoint(j.joint, true)
    j.joint = null
    this.attachJoint(j)
  }

  private breakJoint(j: Joint, ratio: number): void {
    j.broken = true
    if (j.joint) this.world.removeImpulseJoint(j.joint, true)
    j.joint = null
    const at = this.toWorld(j.b.body, j.def.anchor, new Vector3())
    this.breaks.push({ id: j.def.id, name: j.def.name, point: at, ratio })
  }

  private seatLoad(dt: number): void {
    const pod = this.parts.get('pod')!
    const b = pod.body
    const seat = this.toWorld(b, _a.set(0.85, -0.35, 0), new Vector3())
    const acc = this.inertial(b, seat, 1, new Vector3()) // a − g (fuerza específica)
    this.seatAcc.lerp(acc, Math.min(1, dt / 0.05))
    this.peakSeatG = Math.max(this.peakSeatG, this.seatAcc.length() / G)
  }

  // ---------------------------------------------------------------------------
  // Cascotes
  // ---------------------------------------------------------------------------
  private spawnChunks(p: Vector3, n: Vector3, vSlide: Vector3, impulse: number): void {
    const R = this.R
    const count = Math.min(12, Math.max(2, Math.round(impulse / 6)))
    const col = this.obstacleColor ? this.obstacleColor(p, n) : { color: 0x9a948a, glass: 0.2 }
    for (let i = 0; i < count; i++) {
      const glass = rnd(this.seed) < col.glass
      const s = glass ? new Vector3(0.05 + 0.12 * rnd(this.seed), 0.006, 0.04 + 0.1 * rnd(this.seed)) : new Vector3(0.03 + 0.13 * rnd(this.seed), 0.03 + 0.1 * rnd(this.seed), 0.03 + 0.12 * rnd(this.seed))
      const pos = p.clone().addScaledVector(n, 0.15 + 0.1 * rnd(this.seed)).add(new Vector3(rnd(this.seed) - 0.5, rnd(this.seed) - 0.5, rnd(this.seed) - 0.5).multiplyScalar(0.4))
      const vel = new Vector3()
        .addScaledVector(n, 1.5 + 4 * rnd(this.seed))
        .addScaledVector(vSlide, 0.15 + 0.4 * rnd(this.seed))
        .add(new Vector3(rnd(this.seed) - 0.5, rnd(this.seed) * 0.8, rnd(this.seed) - 0.5).multiplyScalar(3.5))
      const rb = this.world.createRigidBody(
        R.RigidBodyDesc.dynamic()
          .setTranslation(pos.x, pos.y, pos.z)
          .setRotation(randomQuat(this.seed))
          .setLinvel(vel.x, vel.y, vel.z)
          .setAngvel({ x: (rnd(this.seed) - 0.5) * 20, y: (rnd(this.seed) - 0.5) * 20, z: (rnd(this.seed) - 0.5) * 20 })
          .setLinearDamping(0.05)
          .setAngularDamping(0.3)
          .setCcdEnabled(true),
      )
      const c = this.world.createCollider(
        R.ColliderDesc.cuboid(s.x / 2, s.y / 2, s.z / 2)
          .setDensity(glass ? 2500 : 1900)
          .setFriction(0.75)
          .setRestitution(glass ? 0.1 : 0.2)
          .setCollisionGroups(G_DEBRIS),
        rb,
      )
      const chunk: Chunk = { rb, size: s, color: glass ? 0xb8c8cc : jitterColor(col.color, this.seed), glass, born: this.time }
      this.owners.set(c.handle, { kind: 'debris', chunk })
      this.chunks.push(chunk)
    }
    while (this.chunks.length > this.maxChunks) {
      const old = this.chunks.shift()!
      for (let i = 0; i < old.rb.numColliders(); i++) this.owners.delete(old.rb.collider(i).handle)
      this.world.removeRigidBody(old.rb)
    }
  }

  // ---------------------------------------------------------------------------
  // Consultas
  // ---------------------------------------------------------------------------
  /** Pose del sólido que lleva la pieza (marco del modelo en el choque), en coordenadas locales. */
  partPose(id: string, outPos: Vector3, outQuat: Quaternion): boolean {
    const p = this.parts.get(id)
    if (!p) return false
    const t = p.body.rb.translation()
    const q = p.body.rb.rotation()
    outPos.set(t.x, t.y, t.z)
    outQuat.set(q.x, q.y, q.z, q.w)
    return true
  }

  /** Velocidad lineal del sólido de la pieza y velocidad angular. */
  partVelocity(id: string, outV: Vector3, outW?: Vector3): void {
    const rb = this.parts.get(id)!.body.rb
    v3(rb.linvel(), outV)
    if (outW) v3(rb.angvel(), outW)
  }

  /** Vueltas del rotor (rad/s alrededor de su eje) y de la hélice. */
  rotorOmega(): number {
    const rb = this.parts.get('rotorHub')!.body.rb
    const q = rb.rotation()
    const axis = _c.copy(this.rotorAxisLocal).applyQuaternion(_q.set(q.x, q.y, q.z, q.w))
    const w = rb.angvel()
    return Math.abs(axis.x * w.x + axis.y * w.y + axis.z * w.z)
  }
  propOmega(): number {
    const rb = this.parts.get('propHub')!.body.rb
    const q = rb.rotation()
    const axis = _c.set(1, 0, 0).applyQuaternion(_q.set(q.x, q.y, q.z, q.w))
    const w = rb.angvel()
    return Math.abs(axis.x * w.x + axis.y * w.y + axis.z * w.z)
  }
  wheelSpeed(): number {
    let s = 0
    for (const id of ['wheelL', 'wheelR', 'wheelN']) {
      const rb = this.parts.get(id)!.body.rb
      s = Math.max(s, v3(rb.angvel()).length() * 0.19)
    }
    return s
  }

  isAttached(id: string): boolean {
    return this.parts.get(id)?.attached ?? false
  }
  jointIntact(id: string): boolean {
    return this.joints.some((j) => j.def.id === id && !j.broken)
  }
  /** ¿Comparten sólido dos piezas? */
  sameBody(a: string, b: string): boolean {
    return this.parts.get(a)?.body === this.parts.get(b)?.body
  }

  /** Energía cinética total (J), para saber si todo se ha parado. */
  kinetic(): number {
    let e = 0
    for (const b of this.bodies) {
      const v = b.rb.linvel()
      const w = v3(b.rb.angvel())
      e += 0.5 * b.rb.mass() * (v.x * v.x + v.y * v.y + v.z * v.z)
      e += 0.5 * w.dot(applyMat(this.worldInertia(b.rb), w))
    }
    return e
  }

  /** Velocidad del fuselaje (m/s) y su giro (rad/s), sin contar rotor/hélice/ruedas. */
  podMotion(): { v: number; w: number } {
    const rb = this.parts.get('pod')!.body.rb
    return { v: v3(rb.linvel()).length(), w: v3(rb.angvel()).length() }
  }

  bodyCount(): number {
    return this.bodies.length
  }

  /** Lista de piezas desprendidas y ejes rotos. */
  brokenSummary(): string[] {
    const out: string[] = []
    let blades = 0
    let props = 0
    for (const p of this.parts.values()) {
      if (p.attached || !p.parent) continue
      if (p.id.startsWith('blade')) blades++
      else if (/^prop\d/.test(p.id)) props++
      else out.push(wreckLabel('part', p.id, p.def.name))
    }
    for (const j of this.joints) if (j.broken) out.push(wreckLabel('joint', j.def.id, j.def.name))
    if (blades) out.push(blades === 1 ? t('crash.blades.1') : t('crash.blades.n', { n: blades }))
    if (props) out.push(props === 1 ? t('crash.props.1') : t('crash.props.n', { n: props }))
    return out
  }

  dispose(): void {
    this.eq.free()
    this.world.free()
  }
}

function applyMat(m: number[], v: Vector3): Vector3 {
  return new Vector3(m[0] * v.x + m[1] * v.y + m[2] * v.z, m[3] * v.x + m[4] * v.y + m[5] * v.z, m[6] * v.x + m[7] * v.y + m[8] * v.z)
}

function boxDesc(R: Rapier, pts: Float32Array): RapierNS.ColliderDesc | null {
  const mn = [Infinity, Infinity, Infinity]
  const mx = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < pts.length; i += 3)
    for (let k = 0; k < 3; k++) {
      mn[k] = Math.min(mn[k], pts[i + k])
      mx[k] = Math.max(mx[k], pts[i + k])
    }
  if (!Number.isFinite(mn[0])) return null
  return R.ColliderDesc.cuboid(Math.max(0.01, (mx[0] - mn[0]) / 2), Math.max(0.01, (mx[1] - mn[1]) / 2), Math.max(0.01, (mx[2] - mn[2]) / 2)).setTranslation(
    (mx[0] + mn[0]) / 2,
    (mx[1] + mn[1]) / 2,
    (mx[2] + mn[2]) / 2,
  )
}

function randomQuat(seed: { s: number }): { x: number; y: number; z: number; w: number } {
  const q = new Quaternion(rnd(seed) - 0.5, rnd(seed) - 0.5, rnd(seed) - 0.5, rnd(seed) - 0.5).normalize()
  return { x: q.x, y: q.y, z: q.z, w: q.w }
}

function jitterColor(c: number, seed: { s: number }): number {
  const k = 0.8 + 0.4 * rnd(seed)
  const r = Math.min(255, ((c >> 16) & 255) * k)
  const g = Math.min(255, ((c >> 8) & 255) * k)
  const b = Math.min(255, (c & 255) * k)
  return ((r | 0) << 16) | ((g | 0) << 8) | (b | 0)
}
