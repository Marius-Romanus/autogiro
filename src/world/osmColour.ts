// Colores de OpenStreetMap (building:colour, roof:colour) llevados a algo creíble.
//
// Los mapeadores suelen poner un nombre CSS o un hexadecimal «de paleta»: red = #ff0000 para
// una teja, «#ff3300» para un ladrillo, «#ccccff» para un bloque grisáceo, «#0000a0» para uno
// azulado. Tal cual salen fachadas chillonas que no se parecen a la foto. Se conservan el tono
// y la claridad, pero la intensidad del color (croma) se limita a la de una pintura de fachada
// o una teja: los tonos cálidos (ladrillo, ocre, salmón) admiten más que los fríos (azules,
// verdes, violetas), que en España casi siempre son grises con un matiz.

import { Color } from 'three'

/** sRGB 0..1 */
export type Rgb = [number, number, number]

const NAMES = (Color as unknown as { NAMES: Record<string, number> }).NAMES

/** «#ff3300», «ff3300», «#f30» o un nombre CSS («red», «light grey»); null si no se entiende. */
export function parseOsmColour(v: unknown): Rgb | null {
  if (typeof v !== 'string') return null
  let s = v.trim().toLowerCase()
  if (/^#?[0-9a-f]{6}$/.test(s)) {
    s = s.replace('#', '')
    return [parseInt(s.slice(0, 2), 16) / 255, parseInt(s.slice(2, 4), 16) / 255, parseInt(s.slice(4, 6), 16) / 255]
  }
  if (/^#[0-9a-f]{3}$/.test(s)) return [parseInt(s[1] + s[1], 16) / 255, parseInt(s[2] + s[2], 16) / 255, parseInt(s[3] + s[3], 16) / 255]
  const name = s.replace(/[\s_-]/g, '')
  const hex = NAMES[name] ?? NAMES[name.replace('grey', 'gray')] ?? NAMES[name.replace('gray', 'grey')]
  if (hex === undefined) return null
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255]
}

/**
 * Fachada: ladrillo, ocre o salmón como mucho; los colores fríos, apenas un matiz (con la luz
 * azulada del cielo, un #d9d9f2 ya se ve lila); el amarillo limón (#ffff00, 60°) pasa a ocre, y
 * los amarillos y ocres, que son pinturas claras, no bajan de claridad 0,62 (ni «yellow» oliva).
 */
export function facadeColour(c: Rgb): Rgb {
  return tame(c, (h) => (h >= 35 && h < 75 ? 0.62 : 0.35), 0.93, (h) => (h < 50 || h >= 330 ? 0.3 : h < 70 ? 0.22 : 0.05), (h) => (h >= 50 && h < 75 ? 46 : h))
}

/** Tejado: «red» y compañía son teja (tono de barro cocido); cobres y pizarras con su matiz. */
export function roofColour(c: Rgb): Rgb {
  return tame(c, () => 0.15, 0.85, (h) => (h < 50 || h >= 330 ? 0.36 : 0.2), (h) => (h >= 335 || h < 20 ? 14 : h))
}

/**
 * Limita croma y claridad (HSL en sRGB): `cap(tono)` es el croma máximo, la claridad queda en
 * [lo(tono), hi] y `hue` puede mover el tono.
 */
function tame(c: Rgb, lo: (h: number) => number, hi: number, cap: (h: number) => number, hue?: (h: number) => number): Rgb {
  const [r, g, b] = c
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  let chroma = max - min
  let h = 0
  if (chroma > 1e-6) {
    if (max === r) h = 60 * (((g - b) / chroma + 6) % 6)
    else if (max === g) h = 60 * ((b - r) / chroma + 2)
    else h = 60 * ((r - g) / chroma + 4)
  }
  if (hue && chroma > 0.04) h = hue(h)
  const l = Math.min(hi, Math.max(chroma > 0.04 ? lo(h) : lo(-1), (max + min) / 2))
  // el croma que cabe a esa claridad
  chroma = Math.min(chroma, cap(h), 1 - Math.abs(2 * l - 1))
  const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - chroma / 2
  const k = Math.floor(h / 60) % 6
  const [rr, gg, bb] = k === 0 ? [chroma, x, 0] : k === 1 ? [x, chroma, 0] : k === 2 ? [0, chroma, x] : k === 3 ? [0, x, chroma] : k === 4 ? [x, 0, chroma] : [chroma, 0, x]
  return [rr + m, gg + m, bb + m]
}
