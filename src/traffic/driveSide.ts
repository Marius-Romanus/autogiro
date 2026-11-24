// Por qué lado se circula en un punto del mundo (contornos de lhtData.ts).

import { LHT_POLYS } from './lhtData.ts'

/** 1 = por la derecha, -1 = por la izquierda */
export function driveSide(lat: number, lon: number): 1 | -1 {
  for (const p of LHT_POLYS) if (inPoly(p, lon, lat)) return -1
  return 1
}

function inPoly(p: number[], x: number, y: number): boolean {
  let inside = false
  const n = p.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = p[i * 2]
    const yi = p[i * 2 + 1]
    const xj = p[j * 2]
    const yj = p[j * 2 + 1]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
