// Nota de una toma: lo que miraría un instructor de autogiro, con cifras.
//
// Módulo puro (sin DOM ni escena): lo usan el juego (School.ts) y el banco tools/school-test.ts.
//
// De dónde salen los umbrales:
//  · Velocidad vertical. BCAR Section T (CAP 643, autogiros ligeros), T 474 a): el tren se diseña
//    para una velocidad vertical de aterrizaje de al menos 2,55 m/s (lo mismo que la caída de
//    0,33 m de T 473). Por encima de eso la toma está fuera de lo que garantiza el tren aunque no
//    se rompa; en el simulador las ruedas principales ceden a 3,6 m/s y la de morro a 3,3
//    (sim/autogyro.ts, checkImpact). Una toma bien recogida queda por debajo de ~1 m/s.
//  · Velocidad. Manual de vuelo del AutoGyro MTOsport 2017 (4.14): aproximación a 100 km/h,
//    redondear, recogida final cerca del suelo y posarse «a la mínima velocidad posible»; un
//    autogiro bien recogido toca casi sin velocidad respecto al suelo. Tocar a velocidad de
//    aproximación es tomar como un avión: carrera larga y la rueda de morro cargada.
//  · Actitud. Mismo manual (y el del Cavalon): sobre el tren principal, con la rueda de morro en
//    el aire, y bajarla después con los pedales al centro. Tocar con la rueda de morro girada y con
//    velocidad «agarra» y puede acabar en vuelco.
//  · Deriva y alineación. Mismo manual: alinear con el pedal y quitar la deriva con mando lateral.
//    El tren se calcula con una carga lateral de 0,5 W en una rueda (BCAR T 485): poco margen; el
//    folleto de la CAA «Gyroplane Handling Performance» avisa de que un autogiro con el rotor
//    girando vuelca en tierra con poca carga lateral.
//  · Rotor. Tras la toma, palanca adelante antes de que las vueltas salgan del arco verde (MTOsport
//    4.16; Cavalon: no menos de 300 rpm). Aquí solo se mira que el rotor llegue cargado al suelo.

export type FirstContact = 'mains' | 'flat' | 'nose'

/** Dónde ha tocado respecto a la pista (m). */
export interface RunwayHit {
  /** distancia a lo largo del eje desde el principio de la zona de toma (umbral, o umbral desplazado) */
  s: number
  /** desvío lateral respecto al eje (+ a la derecha) */
  d: number
  /** pista útil desde el principio de la zona de toma */
  len: number
  /** semiancho */
  hw: number
  /** pista que hay antes del umbral de toma (umbral desplazado): tocar ahí no es salirse */
  before: number
  /** ángulo entre el morro y el eje de la pista (grados, con signo) */
  axisDeg: number
  /** punto de toma marcado (m desde el principio de la zona), o null: vale la zona de toma */
  aim: number | null
}

export interface LandingSample {
  /** el accidente que ha acabado la toma (título), o null */
  crash: string | null
  /** velocidad vertical del primer contacto y la peor de los rebotes (m/s, positiva hacia abajo) */
  vs: number
  /** velocidad indicada y respecto al suelo al tocar (m/s) */
  ias: number
  gs: number
  /** cabeceo sobre la postura de reposo en tierra (grados, + morro arriba) */
  pitchDeg: number
  /** rueda de cola (Cierva): la toma en tres puntos es la buena */
  tailwheel: boolean
  /** velocidad lateral del aparato respecto al suelo, en su eje transversal (m/s, con signo, + a la derecha) */
  drift: number
  /** ángulo entre el morro y la trayectoria sobre el suelo (grados) */
  crabDeg: number
  runway: RunwayHit | null
  /** hay una pista cerca o el ejercicio pide tomar en ella: salirse cuenta */
  wantRunway: boolean
  /** carrera hasta parar (m); null si ha vuelto a despegar (toma y despegue) */
  rollout: number | null
  /** vueltas de rotor al tocar y las normales de vuelo del aparato */
  rotorRpm: number
  rotorRef: number
  bounces: number
  /** altura a la que empezó a tirar de palanca (m), si se ha podido ver */
  flareAgl: number | null
  /** altura de recogida que le va al aparato (sim/glideData.ts) */
  flareRef: number
  /** ha tocado en el agua (flotadores) */
  water: boolean
}

export type ItemId = 'vs' | 'speed' | 'attitude' | 'drift' | 'axis' | 'centre' | 'point' | 'rollout' | 'rotor' | 'bounce'

export interface GradeItem {
  id: ItemId
  /** 0 bien · 1 pasable · 2 flojo · 3 mal */
  level: 0 | 1 | 2 | 3
  penalty: number
  /** clave de i18n del valor (`school.v.<...>`) y sus variables */
  text: string
  vars: Record<string, string | number>
}

export interface LandingGrade {
  /** 0…10, en medios puntos */
  score: number
  items: GradeItem[]
  /** comentarios del instructor: clave de i18n y variables (el primero, el principal) */
  comments: Array<{ key: string; vars: Record<string, string | number> }>
  crash: boolean
}

/** Umbrales (ver la cabecera). Velocidades verticales en m/s, respecto al suelo en km/h. */
export const LIMITS = {
  vs: { good: 0.8, ok: 1.3, firm: 1.9, design: 2.55 },
  gs: { good: 35, ok: 50, fast: 65, plane: 80 },
  drift: { good: 0.5, ok: 1, poor: 2 },
  axis: { good: 5, ok: 10, poor: 20 },
  centre: 3,
  aim: { good: 10, ok: 25, poor: 50 },
  rollout: { good: 50, ok: 120 },
  /** fracción de las vueltas de vuelo por debajo de la cual el rotor llega descargado */
  rotor: 0.8,
  /** cabeceo sobre el reposo: por debajo, la rueda de morro llega antes; hasta `flat`, las tres a la vez */
  pitch: { nose: -0.5, flat: 1.5 },
}

const band = (v: number, steps: number[]): 0 | 1 | 2 | 3 => (v <= steps[0] ? 0 : v <= steps[1] ? 1 : v <= steps[2] ? 2 : 3)

export function firstContact(s: LandingSample): FirstContact {
  if (s.tailwheel) return s.pitchDeg < -3 ? 'nose' : 'mains'
  return s.pitchDeg < LIMITS.pitch.nose ? 'nose' : s.pitchDeg < LIMITS.pitch.flat ? 'flat' : 'mains'
}

export function gradeLanding(s: LandingSample): LandingGrade {
  const items: GradeItem[] = []
  const comments: LandingGrade['comments'] = []
  const L = LIMITS
  let cap = 10
  const add = (id: ItemId, level: 0 | 1 | 2 | 3, penalty: number, text: string, vars: Record<string, string | number> = {}) =>
    items.push({ id, level, penalty, text, vars })
  const r1 = (v: number) => Math.round(v * 10) / 10
  const kmh = (v: number) => Math.round(v * 3.6)

  // --- velocidad vertical ---
  const vsLevel = band(s.vs, [L.vs.good, L.vs.ok, L.vs.firm])
  const over = s.vs > L.vs.design
  add('vs', vsLevel, over ? 5 : [0, 0.5, 1.5, 3][vsLevel], 'school.v.vs', { ms: r1(s.vs), fpm: Math.round((s.vs * 196.85) / 10) * 10 })
  if (over) cap = Math.min(cap, 4)

  // --- velocidad al tocar (respecto al suelo; la indicada se enseña al lado) ---
  const gsK = s.gs * 3.6
  const gsLevel = band(gsK, [L.gs.good, L.gs.ok, L.gs.fast])
  add('speed', gsLevel, gsK > L.gs.plane ? 3 : [0, 0.5, 1, 2][gsLevel], 'school.v.speed', { gs: kmh(s.gs), ias: kmh(s.ias) })

  // --- actitud (en el agua no hay rueda de morro que valga) ---
  const first = firstContact(s)
  if (!s.water) {
    if (first === 'nose') {
      add('attitude', 3, 3, 'school.v.nose', { deg: r1(s.pitchDeg) })
      cap = Math.min(cap, 5)
    } else if (first === 'flat') add('attitude', 1, 1, 'school.v.flat', { deg: r1(s.pitchDeg) })
    else add('attitude', 0, 0, s.tailwheel ? 'school.v.threePoint' : 'school.v.mains', { deg: r1(s.pitchDeg) })
  }

  // --- deriva lateral ---
  const dr = Math.abs(s.drift)
  const drLevel = band(dr, [L.drift.good, L.drift.ok, L.drift.poor])
  add('drift', drLevel, [0, 0.5, 1.5, 3][drLevel], 'school.v.drift', { ms: r1(dr), deg: Math.round(Math.abs(s.crabDeg)) })
  if (drLevel === 3) cap = Math.min(cap, 5)

  // --- pista: alineación, eje, punto ---
  const rw = s.runway
  const outside = rw ? Math.abs(rw.d) > rw.hw || rw.s < -rw.before || rw.s > rw.len : true
  // fuera de la pista solo cuenta si había que tomar en ella (una toma en el campo no es un fallo)
  const off = outside && s.wantRunway
  if (rw && !outside) {
    const ax = Math.abs(rw.axisDeg)
    const axLevel = band(ax, [L.axis.good, L.axis.ok, L.axis.poor])
    add('axis', axLevel, [0, 0.5, 1, 2][axLevel], 'school.v.axis', { deg: Math.round(ax) })
    const c = Math.abs(rw.d)
    const cLevel = c <= L.centre ? 0 : c <= rw.hw * 0.6 ? 1 : 2
    add('centre', cLevel, [0, 0.5, 1][cLevel], 'school.v.centre', { m: r1(c), side: rw.d > 0 ? 'school.right' : 'school.left' })
    if (rw.aim !== null) {
      const e = rw.s - rw.aim
      const pLevel = band(Math.abs(e), [L.aim.good, L.aim.ok, L.aim.poor])
      add('point', pLevel, [0, 0.5, 1.5, 3][pLevel], e >= 0 ? 'school.v.pointLong' : 'school.v.pointShort', { m: Math.round(Math.abs(e)) })
    } else if (rw.s < 0) add('point', 3, 2, 'school.v.zoneShort', { m: Math.round(-rw.s) })
    else if (rw.s <= rw.len / 3) add('point', 0, 0, 'school.v.zoneIn', { m: Math.round(rw.s) })
    else add('point', rw.s > rw.len / 2 ? 2 : 1, rw.s > rw.len / 2 ? 1.5 : 1, 'school.v.zoneLong', { m: Math.round(rw.s) })
  } else if (off) {
    add('centre', 3, 3, 'school.v.offRunway')
    cap = Math.min(cap, 5)
  }

  // --- carrera ---
  if (s.rollout !== null && !s.water) {
    const roLevel = s.rollout <= L.rollout.good ? 0 : s.rollout <= L.rollout.ok ? 1 : 2
    add('rollout', roLevel, [0, 0.5, 1][roLevel], 'school.v.rollout', { m: Math.round(s.rollout) })
  }

  // --- rotor ---
  const lowRotor = s.rotorRpm < L.rotor * s.rotorRef
  add('rotor', lowRotor ? 2 : 0, lowRotor ? 1 : 0, 'school.v.rotor', { rpm: Math.round(s.rotorRpm) })

  // --- rebotes ---
  if (s.bounces > 0) add('bounce', s.bounces > 1 ? 2 : 1, Math.min(2, s.bounces), 'school.v.bounce', { n: s.bounces })

  let score = Math.max(0, Math.min(cap, 10 - items.reduce((a, i) => a + i.penalty, 0)))
  score = Math.round(score * 2) / 2
  if (s.crash) score = 0

  // --- comentario del instructor: lo peor primero, con qué hacer la próxima vez ---
  const say = (key: string, vars: Record<string, string | number> = {}) => comments.push({ key, vars })
  if (s.crash) say('school.c.crash', { what: s.crash, ms: r1(s.vs) })
  const worst = [...items].filter((i) => i.penalty > 0).sort((a, b) => b.penalty - a.penalty)
  for (const it of worst.slice(0, s.crash ? 1 : 2)) {
    switch (it.id) {
      case 'vs': {
        const v = { ms: r1(s.vs), ref: s.flareRef, agl: s.flareAgl === null ? 0 : r1(s.flareAgl) }
        // con velocidad de sobra, se recogió tarde o poco; sin velocidad, se recogió alto y se desplomó
        // (un toque solo algo firme no merece sermón)
        if (it.level < 2) say('school.c.vsSoft', v)
        else if (s.gs * 3.6 < 25 && s.flareAgl !== null && s.flareAgl > s.flareRef + 2) say('school.c.vsHigh', v)
        else if (s.flareAgl === null) say('school.c.vsNoFlare', v)
        else if (s.flareAgl < s.flareRef - 1.5) say('school.c.vsLate', v)
        else say('school.c.vsHold', v)
        break
      }
      case 'speed':
        say(first === 'mains' ? 'school.c.fast' : 'school.c.fastFlat', { gs: kmh(s.gs), ias: kmh(s.ias) })
        break
      case 'attitude':
        say(first === 'nose' ? 'school.c.nose' : 'school.c.flat', { gs: kmh(s.gs) })
        break
      case 'drift':
        say('school.c.drift', { ms: r1(dr), side: s.drift > 0 ? 'school.right' : 'school.left', into: s.drift > 0 ? 'school.left' : 'school.right' })
        break
      case 'axis':
        say('school.c.axis', { deg: Math.round(Math.abs(rw!.axisDeg)), pedal: rw!.axisDeg > 0 ? 'school.left' : 'school.right' })
        break
      case 'centre':
        if (off) say('school.c.offRunway')
        else say('school.c.centre', { m: r1(Math.abs(rw!.d)), side: rw!.d > 0 ? 'school.right' : 'school.left' })
        break
      case 'point':
        if (rw!.aim !== null) say(rw!.s > rw!.aim ? 'school.c.pointLong' : 'school.c.pointShort', { m: Math.round(Math.abs(rw!.s - rw!.aim)) })
        else say(rw!.s < 0 ? 'school.c.zoneShort' : 'school.c.zoneLong', { m: Math.round(Math.abs(rw!.s)) })
        break
      case 'rollout':
        say('school.c.rollout', { m: Math.round(s.rollout ?? 0) })
        break
      case 'rotor':
        say('school.c.rotor', { rpm: Math.round(s.rotorRpm) })
        break
      case 'bounce':
        say('school.c.bounce', { n: s.bounces })
        break
    }
  }
  if (!comments.length) say(score >= 9.5 ? 'school.c.perfect' : 'school.c.good')
  return { score, items, comments, crash: Boolean(s.crash) }
}
