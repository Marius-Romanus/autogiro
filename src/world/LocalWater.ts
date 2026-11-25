// Agua alrededor del aparato para el modelo de vuelo: una rejilla pequeña (9×9 puntos cada 3 m) que se
// rehace en cada fotograma a partir de la máscara del agua (WaterMask.sample). El modelo de vuelo la
// consulta cientos de veces por fotograma (cada rueda, cada tramo de flotador, cada paso de 1/240 s) y
// así no pasa cada vez de coordenadas del mundo a latitud y longitud.

import type { Matrix4 } from 'three'
import type { WaterSample } from './WaterMask.ts'

const N = 9
const STEP = 3

export class LocalWater {
  private readonly water = new Float32Array(N * N)
  private readonly depth = new Float32Array(N * N)
  private x0 = 0
  private z0 = 0
  /** hay rejilla (cerca del agua y con datos) */
  valid = false
  /** algún punto de la rejilla tiene agua */
  any = false

  /**
   * Rehace la rejilla centrada en (x, z). `sample(x, z, withDepth)`: lo que hay en ese punto (null si
   * aún no se sabe: cuenta como tierra). La profundidad sale de buscar la orilla, que es lo caro: lejos
   * de ella (más de 40 m desde el centro) vale la del centro para toda la rejilla.
   */
  update(x: number, z: number, sample: (x: number, z: number, withDepth: boolean) => WaterSample | null): void {
    this.x0 = x - ((N - 1) / 2) * STEP
    this.z0 = z - ((N - 1) / 2) * STEP
    const c = sample(x, z, true)
    const far = c !== null && c.water >= 0.5 && c.shore > 40
    let any = false
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const s = sample(this.x0 + i * STEP, this.z0 + j * STEP, !far)
        const k = j * N + i
        this.water[k] = s ? s.water : 0
        this.depth[k] = s ? (far && s.water >= 0.5 ? c.depth : s.depth) : 0
        if (s && s.water >= 0.5) any = true
      }
    }
    this.any = any
    this.valid = true
  }

  /** Sin rejilla (lejos del agua o sin escenario). */
  clear(): void {
    this.valid = false
    this.any = false
  }

  /** Re-centrado del mundo: la rejilla se mueve con él (hasta que se rehaga en el fotograma siguiente). */
  applyMatrix(m: Matrix4): void {
    const e = m.elements
    const x = this.x0
    const z = this.z0
    this.x0 = e[0] * x + e[8] * z + e[12]
    this.z0 = e[2] * x + e[10] * z + e[14]
  }

  /** Profundidad del agua en (x, z) (m); 0 en tierra o fuera de la rejilla. */
  depthAt(x: number, z: number): number {
    if (!this.any) return 0
    const fx = (x - this.x0) / STEP
    const fz = (z - this.z0) / STEP
    if (!(fx >= 0 && fz >= 0 && fx <= N - 1 && fz <= N - 1)) return 0
    const i = Math.min(N - 2, Math.floor(fx))
    const j = Math.min(N - 2, Math.floor(fz))
    const a = fx - i
    const b = fz - j
    const k = j * N + i
    const w = (this.water[k] * (1 - a) + this.water[k + 1] * a) * (1 - b) + (this.water[k + N] * (1 - a) + this.water[k + N + 1] * a) * b
    if (w < 0.5) return 0
    const d = (this.depth[k] * (1 - a) + this.depth[k + 1] * a) * (1 - b) + (this.depth[k + N] * (1 - a) + this.depth[k + N + 1] * a) * b
    return Math.max(0.05, d)
  }
}
