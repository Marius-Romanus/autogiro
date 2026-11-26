// Progreso de la escuela, guardado en este navegador: preferencias, intentos de cada ejercicio por
// aparato y las últimas tomas puntuadas en vuelo libre.

export interface Attempt {
  /** fecha (ms) */
  t: number
  score: number
  pass: boolean
  /** pista: 'lemt08', 'lemt26' o 'here' */
  site: string
}

export interface LandingEntry {
  t: number
  ac: string
  score: number
  /** comentario principal del instructor (clave de i18n y variables) */
  note: string
  vars: Record<string, string | number>
}

export interface SchoolData {
  /** pista de los ejercicios: Casarrubios o la de la salida elegida en el menú */
  site: 'lemt' | 'here'
  /** condiciones: las del ejercicio o las del menú */
  cond: 'ex' | 'menu'
  /** enseñar la nota de cada toma en vuelo libre */
  showGrade: boolean
  /** intentos[ejercicio][aparato], los últimos MAX_ATTEMPTS */
  attempts: Record<string, Record<string, Attempt[]>>
  landings: LandingEntry[]
}

const KEY = 'autogiro.school.v1'
const MAX_ATTEMPTS = 30
const MAX_LANDINGS = 40

export function loadSchool(): SchoolData {
  const d: SchoolData = { site: 'lemt', cond: 'ex', showGrade: true, attempts: {}, landings: [] }
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) Object.assign(d, JSON.parse(raw))
  } catch {
    /* sin almacenamiento */
  }
  return d
}

export function saveSchool(d: SchoolData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(d))
  } catch {
    /* sin almacenamiento */
  }
}

export function attemptsOf(d: SchoolData, ex: string, ac: string): Attempt[] {
  return d.attempts[ex]?.[ac] ?? []
}

export function addAttempt(d: SchoolData, ex: string, ac: string, a: Attempt): void {
  const list = ((d.attempts[ex] ??= {})[ac] ??= [])
  list.push(a)
  if (list.length > MAX_ATTEMPTS) list.splice(0, list.length - MAX_ATTEMPTS)
}

export function addLanding(d: SchoolData, l: LandingEntry): void {
  d.landings.push(l)
  if (d.landings.length > MAX_LANDINGS) d.landings.splice(0, d.landings.length - MAX_LANDINGS)
}

/** Quita una toma de la lista (por su fecha, que hace de identificador). */
export function removeLanding(d: SchoolData, t: number): void {
  d.landings = d.landings.filter((l) => l.t !== t)
}

export function bestScore(d: SchoolData, ex: string, ac: string): number | null {
  const list = attemptsOf(d, ex, ac)
  return list.length ? Math.max(...list.map((a) => a.score)) : null
}

export function passed(d: SchoolData, ex: string, ac: string): boolean {
  return attemptsOf(d, ex, ac).some((a) => a.pass)
}
