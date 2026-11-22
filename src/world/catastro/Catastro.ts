// Edificios del Catastro desde el hilo principal: un solo worker (catastro.worker.ts) para
// toda la partida, compartido por el escenario (Buildings) y el listado del menú.

import type { CatTile, Circle, FromWorker, MuniInfo, MuniStatus, ToWorker } from './types.ts'

export type { CatTile, Circle, MuniInfo, MuniStatus }
export type BBox = { s: number; w: number; n: number; e: number }

class CatastroClient {
  private worker: Worker | null = null
  private seq = 0
  private readonly waiting = new Map<number, (m: FromWorker) => void>()
  private readonly tileListeners = new Set<(tiles: string[], bbox: BBox | null) => void>()
  private readonly statusListeners = new Set<(q: MuniStatus[]) => void>()
  private readonly storedListeners = new Set<() => void>()
  /** lo que se está bajando o espera turno (para el menú) */
  status: MuniStatus[] = []

  private get w(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./catastro.worker.ts', import.meta.url), { type: 'module', name: 'catastro' })
      this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.onMessage(e.data)
      this.worker.onerror = (e) => console.warn('[catastro] worker', e.message)
    }
    return this.worker
  }

  private send(m: ToWorker): void {
    this.w.postMessage(m)
  }

  private onMessage(m: FromWorker): void {
    if ('id' in m) {
      const fn = this.waiting.get(m.id)
      this.waiting.delete(m.id)
      fn?.(m)
    }
    if (m.t === 'ready' || m.t === 'deleted') {
      for (const fn of this.tileListeners) fn(m.tiles, m.t === 'ready' ? m.bbox : null)
      for (const fn of this.storedListeners) fn()
    } else if (m.t === 'status') {
      this.status = m.queue
      for (const fn of this.statusListeners) fn(m.queue)
    }
  }

  private request<T extends FromWorker>(make: (id: number) => ToWorker): Promise<T> {
    const id = ++this.seq
    return new Promise((resolve) => {
      this.waiting.set(id, (m) => resolve(m as T))
      this.send(make(id))
    })
  }

  /** Zonas que interesan ahora (alrededor y por delante): el worker ordena la cola con ellas. */
  want(circles: Circle[]): void {
    this.send({ t: 'want', circles })
  }

  /** Edificios guardados en la tesela z14 y si falta algún municipio que la toca. */
  async tile(x: number, y: number): Promise<{ pending: boolean; data: CatTile[] }> {
    // Los edificios de OpenStreetMap no esperan al Catastro: si el worker tarda (índice lento,
    // base de datos ocupada), la tesela se monta sin él y se rehace cuando conteste.
    let late = false
    let timer = 0
    const real = this.request<Extract<FromWorker, { t: 'tile' }>>((id) => ({ t: 'tile', id, x, y })).then((m) => {
      clearTimeout(timer)
      if (late && m.data.length > 0) for (const fn of this.tileListeners) fn([`${x}/${y}`], null)
      return { pending: m.pending, data: m.data }
    })
    const timeout = new Promise<{ pending: boolean; data: CatTile[] }>((resolve) => {
      timer = self.setTimeout(() => {
        late = true
        resolve({ pending: true, data: [] })
      }, 6000)
    })
    return Promise.race([real, timeout])
  }

  /** ¿Falta aún algún municipio que toca la tesela? (sin leer sus datos) */
  async pending(x: number, y: number): Promise<boolean> {
    return (await this.request<Extract<FromWorker, { t: 'pending' }>>((id) => ({ t: 'pending', id, x, y }))).pending
  }

  async list(): Promise<MuniInfo[]> {
    return (await this.request<Extract<FromWorker, { t: 'list' }>>((id) => ({ t: 'list', id }))).munis
  }

  /** Borra un municipio (o todos con null). No se vuelve a bajar solo hasta la próxima partida. */
  async remove(code: string | null): Promise<void> {
    await this.request((id) => ({ t: 'delete', id, code }))
  }

  /**
   * Teselas cuyo contenido del Catastro ha cambiado (municipio descargado o borrado) y, si es
   * una descarga (o un fallo), el recuadro del municipio: las teselas que lo esperaban sin tener
   * datos suyos dejan de esperar.
   */
  onTiles(fn: (tiles: string[], bbox: BBox | null) => void): () => void {
    this.tileListeners.add(fn)
    return () => this.tileListeners.delete(fn)
  }

  onStatus(fn: (q: MuniStatus[]) => void): () => void {
    this.statusListeners.add(fn)
    return () => this.statusListeners.delete(fn)
  }

  /** Cambia lo guardado (para refrescar el listado). */
  onStored(fn: () => void): () => void {
    this.storedListeners.add(fn)
    return () => this.storedListeners.delete(fn)
  }
}

export const catastro = new CatastroClient()
