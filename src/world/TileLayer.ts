// Capa de objetos por teselas z14 alrededor de la cámara (edificios, árboles):
// decide qué teselas cargar (las más cercanas primero, pocas a la vez), las
// descarga al alejarse y cuelga sus mallas de un grupo en marco ECEF.

import { Group, Vector3 } from 'three'
import { GeoFrame } from './GeoFrame.ts'
import { latToY, lonToX, xToLon, yToLat, Z } from './mapTiles.ts'

export interface LayerTile {
  key: string
  x: number
  y: number
  state: 'loading' | 'ready' | 'empty' | 'failed'
  abort: AbortController
  /** marco local de la tesela (X este, Y arriba, Z sur, origen en su centro a altura 0) */
  frame: GeoFrame
  /** distancia de la cámara a la tesela, en teselas (0 = la cámara está encima) */
  dist: number
  /** cuándo falló (performance.now), para reintentarla */
  failedAt?: number
}

export abstract class TileLayer<T extends LayerTile> {
  /** Grupo en marco ECEF: World le pone la matriz ecef→mundo. */
  readonly group = new Group()
  radius = 3000
  enabled = true
  protected readonly tiles = new Map<string, T>()
  protected readonly worldFrame: GeoFrame
  protected disposed = false
  protected maxConcurrent = 2
  private loading = 0
  /** fallos seguidos de cada tesela (se reintenta 3 veces, cada 10 s) */
  private readonly failCount = new Map<string, number>()
  private timer = 0
  private readonly label: string

  constructor(worldFrame: GeoFrame, label: string) {
    this.worldFrame = worldFrame
    this.label = label
    this.group.matrixAutoUpdate = false
    this.group.name = label
    // edificios y árboles proyectan sombra del sol (render/SunShadows.ts)
    this.group.userData.worldShadowCaster = true
  }

  /** Crea la tesela (sin cargar nada). */
  protected abstract createTile(base: LayerTile): T
  /** Descarga y construye su contenido; al terminar pone state = 'ready' o 'empty'. */
  protected abstract loadTile(t: T): Promise<void>
  /** Libera lo que haya añadido al grupo. */
  protected abstract disposeTile(t: T): void
  /** Tras cada revisión (cada 0,4 s), con las distancias ya actualizadas. */
  protected afterUpdate(): void {}

  /** Gestiona qué teselas hay cargadas alrededor de la cámara (llamar cada fotograma). */
  update(dt: number, cameraWorld: Vector3): void {
    if (this.disposed) return
    this.group.visible = this.enabled
    this.timer -= dt
    if (this.timer > 0) return
    this.timer = 0.4
    if (!this.enabled) return
    const g = this.worldFrame.worldToGeo(cameraWorld)
    const n = 2 ** Z
    const cx = lonToX(g.lon, n)
    const cy = latToY(g.lat, n)
    // tamaño de una tesela en metros a esta latitud
    const tileM = (40075016.7 * Math.cos((g.lat * Math.PI) / 180)) / n
    const r = this.radius / tileM
    const distTo = (x: number, y: number) => Math.hypot(Math.max(x - cx, 0, cx - (x + 1)), Math.max(y - cy, 0, cy - (y + 1)))
    const wanted: Array<{ x: number; y: number; d: number }> = []
    for (let y = Math.floor(cy - r); y <= Math.floor(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.floor(cx + r); x++) {
        const d = distTo(x, y)
        if (d <= r) wanted.push({ x, y, d })
      }
    }
    wanted.sort((a, b) => a.d - b.d)
    for (const w of wanted) {
      if (this.loading >= this.maxConcurrent) break
      if (this.tiles.has(`${w.x}/${w.y}`)) continue
      this.startTile(w.x, w.y)
    }
    const now = performance.now()
    for (const [key, t] of this.tiles) {
      t.dist = distTo(t.x, t.y)
      if (t.dist > r * 1.35 + 0.5) {
        this.removeTile(key)
        this.failCount.delete(key)
      } else if (t.state === 'failed' && now - (t.failedAt ?? 0) > 10000 && (this.failCount.get(key) ?? 0) <= 3) {
        // un corte de red al pedirla: fuera, y la próxima revisión la vuelve a cargar
        this.removeTile(key)
      } else if (t.state === 'ready' || t.state === 'empty') this.failCount.delete(key)
    }
    this.afterUpdate()
  }

  /** Re-centrado del mundo: el grupo cuelga del marco ECEF. */
  syncFrame(): void {
    this.group.matrix.copy(this.worldFrame.ecefToWorld)
    this.group.updateMatrixWorld(true)
  }

  /** Tesela lista que contiene el punto (mundo) y el punto en su marco local. */
  protected tileAt(p: Vector3, out: Vector3): T | null {
    const g = this.worldFrame.worldToGeo(p)
    const n = 2 ** Z
    const t = this.tiles.get(`${Math.floor(lonToX(g.lon, n))}/${Math.floor(latToY(g.lat, n))}`)
    if (!t || t.state !== 'ready') return null
    t.frame.geoToWorld(g.lat, g.lon, g.h, out)
    return t
  }

  dispose(): void {
    this.disposed = true
    for (const key of [...this.tiles.keys()]) this.removeTile(key)
  }

  private removeTile(key: string): void {
    const t = this.tiles.get(key)
    if (!t) return
    t.abort.abort()
    this.disposeTile(t)
    this.tiles.delete(key)
  }

  private startTile(x: number, y: number): void {
    const n = 2 ** Z
    const frame = new GeoFrame()
    frame.setOrigin(yToLat(y + 0.5, n), xToLon(x + 0.5, n), 0)
    const t = this.createTile({ key: `${x}/${y}`, x, y, state: 'loading', abort: new AbortController(), frame, dist: 0 })
    this.tiles.set(t.key, t)
    this.loading++
    this.loadTile(t)
      .catch((e) => {
        if (t.abort.signal.aborted) return
        console.warn(`${this.label}: error en la tesela`, t.key, e)
        t.state = 'failed'
        t.failedAt = performance.now()
        this.failCount.set(t.key, (this.failCount.get(t.key) ?? 0) + 1)
      })
      .finally(() => this.loading--)
  }
}

/** Cede el hilo principal si el trozo de trabajo actual ya pasa de `ms` (para no dar tirones). */
export class Slicer {
  private t = performance.now()
  private readonly ms: number
  constructor(ms = 6) {
    this.ms = ms
  }
  async yield(signal: AbortSignal): Promise<boolean> {
    if (performance.now() - this.t < this.ms) return !signal.aborted
    await new Promise((r) => setTimeout(r, 0))
    this.t = performance.now()
    return !signal.aborted
  }
}
