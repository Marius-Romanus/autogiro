// Worker de tejados: esqueleto recto de las plantas irregulares (roofShapes.ts) fuera del
// hilo principal. Cada caso tarda ~0,1 ms, pero alguno llega a 15 ms y una manzana grande
// de un casco antiguo tiene cientos: en el hilo principal serían tirones.

import { skeletonRoof } from './roofShapes.ts'

export interface RoofJob {
  /** anillos en metros (x, z alternados): exterior y huecos */
  rings: Float64Array[]
  /** tangente de la pendiente */
  pitch: number
  /** subida máxima sobre el alero (m) */
  cap: number
}

export interface RoofReply {
  id: number
  /** por trabajo: triángulos [x, z, h] o null (dejarlo plano) */
  results: Array<Float32Array | null>
}

self.onmessage = (e: MessageEvent<{ id: number; jobs: RoofJob[] }>) => {
  const { id, jobs } = e.data
  const results: Array<Float32Array | null> = []
  const transfer: ArrayBuffer[] = []
  for (const j of jobs) {
    let tris: number[] | null = null
    try {
      tris = skeletonRoof(j.rings, j.pitch, j.cap)
    } catch {
      tris = null
    }
    // el tejado tiene que cubrir la planta (±8 %): si no, el algoritmo se ha liado
    if (tris && !coversFootprint(tris, j.rings)) tris = null
    const arr = tris ? new Float32Array(tris) : null
    if (arr) transfer.push(arr.buffer)
    results.push(arr)
  }
  ;(self as unknown as Worker).postMessage({ id, results } satisfies RoofReply, transfer)
}

function coversFootprint(tris: number[], rings: Float64Array[]): boolean {
  let roof = 0
  for (let k = 0; k < tris.length; k += 9) roof += Math.abs((tris[k + 3] - tris[k]) * (tris[k + 7] - tris[k + 1]) - (tris[k + 6] - tris[k]) * (tris[k + 4] - tris[k + 1])) / 2
  let plan = 0
  rings.forEach((r, i) => {
    let a = 0
    const n = r.length / 2
    for (let p = 0; p < n; p++) {
      const q = (p + 1) % n
      a += r[2 * p] * r[2 * q + 1] - r[2 * q] * r[2 * p + 1]
    }
    plan += i === 0 ? Math.abs(a / 2) : -Math.abs(a / 2)
  })
  return plan > 0 && Math.abs(roof / plan - 1) < 0.08
}
