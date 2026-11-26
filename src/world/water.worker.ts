// Worker de la máscara de agua: lee la tesela vectorial y la dibuja (waterRaster.ts) fuera del
// hilo principal. Recibe los bytes de la tesela y devuelve los texeles.

import { VectorTile } from '@mapbox/vector-tile'
import { PbfReader } from 'pbf'
import { rasterize } from './waterRaster.ts'

export interface WaterJob {
  id: number
  bytes: ArrayBuffer
  z: number
  mpp: number
  size: number
}

export interface WaterResult {
  id: number
  data?: Uint8Array | null
  fill?: [number, number]
  error?: string
}

const scope = self as unknown as { onmessage: ((e: MessageEvent<WaterJob>) => void) | null; postMessage(msg: WaterResult, transfer?: Transferable[]): void }

scope.onmessage = (e) => {
  const { id, bytes, z, mpp, size } = e.data
  try {
    const r = rasterize(new VectorTile(new PbfReader(new Uint8Array(bytes))), z, mpp, size)
    scope.postMessage({ id, data: r.data, fill: r.fill }, r.data ? [r.data.buffer] : [])
  } catch (err) {
    scope.postMessage({ id, error: String(err) })
  }
}
