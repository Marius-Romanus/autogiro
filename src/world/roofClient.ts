// Cliente del worker de tejados (roof.worker.ts): un lote por tesela, de uno en uno.
// Si el worker se atasca (planta patológica), se reinicia y ese lote queda con tejados planos.

import type { RoofJob, RoofReply } from './roof.worker.ts'

let worker: Worker | null = null
let seq = 0
let chain: Promise<unknown> = Promise.resolve()

function getWorker(): Worker {
  if (!worker) worker = new Worker(new URL('./roof.worker.ts', import.meta.url), { type: 'module', name: 'tejados' })
  return worker
}

/** Tejados de esqueleto recto para un lote de plantas (null = dejarlo plano). */
export function buildRoofs(jobs: RoofJob[], signal: AbortSignal): Promise<Array<Float32Array | null>> {
  if (jobs.length === 0) return Promise.resolve([])
  const run = () =>
    new Promise<Array<Float32Array | null>>((resolve) => {
      if (signal.aborted) return resolve(jobs.map(() => null))
      const w = getWorker()
      const id = ++seq
      // margen holgado: ~0,1 ms por planta de media, 16 ms en el peor caso medido
      const timer = setTimeout(() => {
        console.warn('tejados: el worker no responde; se reinicia y este lote queda plano')
        w.removeEventListener('message', onMsg)
        w.terminate()
        if (worker === w) worker = null
        resolve(jobs.map(() => null))
      }, 3000 + jobs.length * 4)
      const onMsg = (e: MessageEvent<RoofReply>) => {
        if (e.data.id !== id) return
        clearTimeout(timer)
        w.removeEventListener('message', onMsg)
        resolve(e.data.results)
      }
      w.addEventListener('message', onMsg)
      w.postMessage({ id, jobs })
    })
  const p = chain.then(run, run)
  chain = p
  return p
}
