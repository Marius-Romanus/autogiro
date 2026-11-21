// Worker del Catastro: edificios de la Dirección General del Catastro (datos INSPIRE, un
// fichero por municipio) descargados por delante del aparato y guardados en este navegador.
//
// - Índice: el «atom» nacional (un recuadro por gerencia territorial) y el de cada gerencia
//   (un recuadro y un zip por municipio). Se guardan una semana.
// - Descarga: por el servidor del propio juego (/catastro/…: los ficheros del Catastro no se
//   pueden pedir directamente desde una página web), de uno en uno, el más urgente primero.
// - El zip se descomprime y se lee a la vez que llega (el de Madrid son 117 MB y más de
//   2 GB de GML), y cada parte de edificio va a la tesela z14 de su centro.
// - Todo en IndexedDB: municipios (para el listado del menú) y teselas (lo que pide Buildings).
//
// Nada de esto toca el hilo principal: allí solo llegan los datos de cada tesela, ya
// empaquetados en arrays que se transfieren sin copiar.

import { Unzip, UnzipInflate } from 'fflate'
import { PartParser, type CatastroPart } from './gml.ts'
import type { CatTile, Circle, FromWorker, MuniInfo, MuniStatus, ToWorker } from './types.ts'

const Z = 14
const N = 2 ** Z
const FEED_TTL = 7 * 24 * 3600 * 1000
/** versión de lo guardado de los índices (se suben al cambiar el formato o la validación) */
const FEED_V = 2
const NATIONAL = 'buildings/ES.SDGC.BU.atom.xml'
/** reintento de un municipio que falló */
const RETRY_MS = 90_000

interface BBox {
  s: number
  w: number
  n: number
  e: number
}

interface FeedEntry {
  /** ruta bajo https://www.catastro.hacienda.gob.es/INSPIRE/ */
  path: string
  bbox: BBox
  /** municipio: código y nombre ("28089", "MORALEJA DE ENMEDIO") */
  code?: string
  name?: string
}

interface MuniRecord extends MuniInfo {
  tiles: string[]
}

const post = (m: FromWorker, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer)

// ---------------------------------------------------------------------------
// IndexedDB
// ---------------------------------------------------------------------------

let dbP: Promise<IDBDatabase> | null = null
function db(): Promise<IDBDatabase> {
  if (!dbP) {
    dbP = new Promise((resolve, reject) => {
      const req = indexedDB.open('autogiro-catastro', 1)
      req.onupgradeneeded = () => {
        const d = req.result
        d.createObjectStore('feeds', { keyPath: 'path' })
        d.createObjectStore('munis', { keyPath: 'code' })
        const tiles = d.createObjectStore('tiles', { keyPath: 'key' })
        tiles.createIndex('byTile', 'tile')
        tiles.createIndex('byCode', 'code')
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return dbP
}

function reqP<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

// ---------------------------------------------------------------------------
// Índice de municipios
// ---------------------------------------------------------------------------

const feeds = new Map<string, Promise<FeedEntry[]>>()

function catastroUrl(path: string): string {
  // el servidor del juego reenvía /catastro/<ruta> a https://www.catastro.hacienda.gob.es/INSPIRE/<ruta>
  return '/catastro/' + path.split('/').map(encodeURIComponent).join('/')
}

function feed(path: string): Promise<FeedEntry[]> {
  let p = feeds.get(path)
  if (!p) {
    p = (async () => {
      const d = await db()
      const cached = (await reqP(d.transaction('feeds').objectStore('feeds').get(path))) as { path: string; time: number; v?: number; entries: FeedEntry[] } | undefined
      const valid = cached?.v === FEED_V ? cached : undefined
      if (valid && Date.now() - valid.time < FEED_TTL) return valid.entries
      try {
        const res = await fetch(catastroUrl(path))
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        // el índice nacional viene en UTF-8 y los de las gerencias en ISO-8859-1: lo que diga su cabecera
        const raw = new Uint8Array(await res.arrayBuffer())
        const enc = /encoding="([^"]+)"/i.exec(new TextDecoder('latin1').decode(raw.subarray(0, 120)))?.[1] ?? 'utf-8'
        let dec: TextDecoder
        try {
          dec = new TextDecoder(enc)
        } catch {
          dec = new TextDecoder('utf-8')
        }
        const xml = dec.decode(raw)
        // uno cortado (conexión caída, servidor reiniciado) no se guarda: se quedaría una semana
        if (!xml.trimEnd().endsWith('</feed>')) throw new Error('índice incompleto')
        const entries = parseFeed(xml)
        if (entries.length === 0) throw new Error('índice vacío')
        const tx = d.transaction('feeds', 'readwrite')
        tx.objectStore('feeds').put({ path, time: Date.now(), v: FEED_V, entries })
        await txDone(tx)
        return entries
      } catch (e) {
        feeds.delete(path) // se reintenta en la próxima petición
        if (valid) return valid.entries // caducado pero mejor que nada
        throw e
      }
    })()
    feeds.set(path, p)
  }
  return p
}

function parseFeed(xml: string): FeedEntry[] {
  const out: FeedEntry[] = []
  for (const part of xml.split('<entry>').slice(1)) {
    const href = /<link[^>]*rel="enclosure"[^>]*href="([^"]+)"/.exec(part)?.[1] ?? /<link[^>]*href="([^"]+)"[^>]*rel="enclosure"/.exec(part)?.[1]
    const poly = /<georss:polygon>([^<]+)<\/georss:polygon>/.exec(part)?.[1]
    if (!href || !poly) continue
    const m = /\/INSPIRE\/(.+)$/i.exec(href)
    if (!m) continue
    const nums = poly.trim().split(/\s+/).map(Number)
    const bbox: BBox = { s: Infinity, w: Infinity, n: -Infinity, e: -Infinity }
    for (let i = 0; i + 1 < nums.length; i += 2) {
      bbox.s = Math.min(bbox.s, nums[i])
      bbox.n = Math.max(bbox.n, nums[i])
      bbox.w = Math.min(bbox.w, nums[i + 1])
      bbox.e = Math.max(bbox.e, nums[i + 1])
    }
    if (!Number.isFinite(bbox.s)) continue
    const e: FeedEntry = { path: m[1], bbox }
    const title = /<title>\s*(\d{5})-([^<]*?)\s+buildings\s*<\/title>/.exec(part)
    if (title) {
      e.code = title[1]
      e.name = title[2].trim()
    }
    out.push(e)
  }
  return out
}

function overlaps(a: BBox, b: BBox): boolean {
  return a.s <= b.n && a.n >= b.s && a.w <= b.e && a.e >= b.w
}

/** Municipios cuyo recuadro toca `box`. */
async function munisIn(box: BBox): Promise<FeedEntry[]> {
  const offices = (await feed(NATIONAL)).filter((o) => overlaps(o.bbox, box))
  const lists = await Promise.all(offices.map((o) => feed(o.path).catch(() => [] as FeedEntry[])))
  return lists.flat().filter((m) => m.code && overlaps(m.bbox, box))
}

/**
 * Municipio de recuadro enorme (Madrid capital: 0,12 grados², 117 MB). Que el borde de su recuadro
 * roce la zona no quiere decir que haya edificios cerca: solo se baja si se está bien dentro, y al
 * aparecer no se le espera.
 */
function huge(b: BBox): boolean {
  return (b.n - b.s) * (b.e - b.w) > 0.04
}

function circleBox(c: Circle): BBox {
  const dLat = c.r / 111320
  const dLon = c.r / (111320 * Math.cos((c.lat * Math.PI) / 180))
  return { s: c.lat - dLat, n: c.lat + dLat, w: c.lon - dLon, e: c.lon + dLon }
}

function distToBox(c: Circle, b: BBox): number {
  const kx = 111320 * Math.cos((c.lat * Math.PI) / 180)
  const dx = Math.max(b.w - c.lon, 0, c.lon - b.e) * kx
  const dy = Math.max(b.s - c.lat, 0, c.lat - b.n) * 111320
  return Math.hypot(dx, dy)
}

function tileBox(x: number, y: number): BBox {
  return { n: yToLat(y), s: yToLat(y + 1), w: (x / N) * 360 - 180, e: ((x + 1) / N) * 360 - 180 }
}

function yToLat(y: number): number {
  const k = Math.PI - (2 * Math.PI * y) / N
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(k) - Math.exp(-k)))
}

// ---------------------------------------------------------------------------
// Estado: guardados, cola y fallos
// ---------------------------------------------------------------------------

const stored = new Map<string, MuniRecord>()
const storedReady: Promise<void> = (async () => {
  try {
    const d = await db()
    const all = (await reqP(d.transaction('munis').objectStore('munis').getAll())) as MuniRecord[]
    for (const m of all) stored.set(m.code, m)
  } catch (e) {
    console.warn('[catastro] no se pudo abrir la base de datos local', e)
  }
})()

/** cola: lo que se quiere ahora, por orden de urgencia */
let queue: Array<{ entry: FeedEntry; prio: number }> = []
let current: MuniStatus | null = null
const failedAt = new Map<string, number>()
/** borrados a mano en esta sesión: no se vuelven a bajar solos hasta reiniciar */
const deletedNow = new Set<string>()
let wantSeq = 0

function blocked(code: string): boolean {
  if (deletedNow.has(code)) return true
  const f = failedAt.get(code)
  return f !== undefined && Date.now() - f < RETRY_MS
}

async function want(circles: Circle[]): Promise<void> {
  const my = ++wantSeq
  await storedReady
  const best = new Map<string, { entry: FeedEntry; prio: number }>()
  for (let i = 0; i < circles.length; i++) {
    const c = circles[i]
    let list: FeedEntry[]
    try {
      list = await munisIn(circleBox(c))
    } catch {
      continue // sin índice (sin conexión): se reintenta en la próxima petición
    }
    for (const m of list) {
      const code = m.code!
      if (stored.has(code) || blocked(code) || current?.code === code) continue
      const d = distToBox(c, m.bbox)
      if (huge(m.bbox) && d > c.r * 0.4) continue
      // primero lo de alrededor, luego lo que viene por delante (los círculos van en ese orden)
      const prio = i * 100_000 + d
      const old = best.get(code)
      if (!old || prio < old.prio) best.set(code, { entry: m, prio })
    }
  }
  if (my !== wantSeq) return // ya hay una petición más nueva
  queue = [...best.values()].sort((a, b) => a.prio - b.prio)
  sendStatus()
  void pump()
}

let pumping = false
async function pump(): Promise<void> {
  if (pumping) return
  pumping = true
  try {
    while (queue.length > 0) {
      const { entry } = queue.shift()!
      const code = entry.code!
      if (stored.has(code) || blocked(code)) continue
      try {
        await download(entry)
      } catch (e) {
        console.warn('[catastro] falló', code, entry.name, e)
        failedAt.set(code, Date.now())
        current = { code, name: entry.name ?? code, state: 'error' }
        sendStatus()
        // las teselas que lo esperaban dejan de esperar (se reintentará más tarde)
        post({ t: 'ready', code, tiles: [], bbox: entry.bbox })
      }
      current = null
      sendStatus()
    }
  } finally {
    pumping = false
  }
}

let lastStatus = 0
function sendStatus(force = true): void {
  const now = Date.now()
  if (!force && now - lastStatus < 250) return
  lastStatus = now
  const q: MuniStatus[] = []
  if (current) q.push({ ...current })
  for (const it of queue.slice(0, 8)) q.push({ code: it.entry.code!, name: it.entry.name ?? it.entry.code!, state: 'queued' })
  post({ t: 'status', queue: q })
}

// ---------------------------------------------------------------------------
// Descarga y conversión de un municipio
// ---------------------------------------------------------------------------

class Grow<T extends Float32Array | Uint32Array | Uint8Array> {
  a: T
  n = 0
  constructor(a: T) {
    this.a = a
  }
  push(v: number): void {
    if (this.n === this.a.length) {
      const b = new (this.a.constructor as new (n: number) => T)(this.a.length * 2)
      b.set(this.a)
      this.a = b
    }
    this.a[this.n++] = v
  }
  done(): T {
    return this.a.slice(0, this.n) as T
  }
}

interface Bucket {
  coords: Grow<Float32Array>
  ringStart: Grow<Uint32Array>
  partRing: Grow<Uint32Array>
  floors: Grow<Uint8Array>
}

async function download(entry: FeedEntry): Promise<void> {
  const code = entry.code!
  const name = entry.name ?? code
  current = { code, name, state: 'downloading', loaded: 0 }
  sendStatus()
  const res = await fetch(catastroUrl(entry.path))
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length')) || undefined
  current.total = total

  const buckets = new Map<string, Bucket>()
  let parts = 0
  const addPart = (p: CatastroPart) => {
    if (p.floors <= 0) return
    // tesela del centro del exterior
    const r0 = p.rings[0]
    let la = 0
    let lo = 0
    const n0 = r0.length / 2
    for (let i = 0; i < r0.length; i += 2) {
      la += r0[i]
      lo += r0[i + 1]
    }
    const cx = lonToX(lo / n0)
    const cy = latToY(la / n0)
    const tx = Math.floor(cx)
    const ty = Math.floor(cy)
    const key = `${tx}/${ty}`
    let b = buckets.get(key)
    if (!b) {
      b = { coords: new Grow(new Float32Array(4096)), ringStart: new Grow(new Uint32Array(256)), partRing: new Grow(new Uint32Array(128)), floors: new Grow(new Uint8Array(128)) }
      buckets.set(key, b)
    }
    b.partRing.push(b.ringStart.n)
    b.floors.push(Math.min(255, p.floors))
    for (const r of p.rings) {
      b.ringStart.push(b.coords.n / 2)
      for (let i = 0; i < r.length; i += 2) {
        b.coords.push(lonToX(r[i + 1]) - tx)
        b.coords.push(latToY(r[i]) - ty)
      }
    }
    parts++
  }
  const parser = new PartParser(addPart)
  const dec = new TextDecoder('latin1')
  let unzipError: unknown = null
  let partsDone = false
  const uz = new Unzip((file) => {
    if (!/buildingpart\.gml$/i.test(file.name)) return
    file.ondata = (err, chunk, final) => {
      if (err) {
        unzipError = err
        return
      }
      try {
        parser.push(dec.decode(chunk, { stream: !final }))
        if (final) partsDone = true
      } catch (e) {
        unzipError = e
      }
    }
    file.start()
  })
  uz.register(UnzipInflate)

  const reader = res.body.getReader()
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    loaded += value.length
    uz.push(value, false)
    if (unzipError) throw unzipError
    current.loaded = loaded
    sendStatus(false)
  }
  uz.push(new Uint8Array(0), true)
  if (unzipError) throw unzipError
  // cortado a medias: no se guarda (se reintentará)
  if ((total && loaded !== total) || !partsDone) throw new Error(`descarga incompleta (${loaded} de ${total ?? '?'} bytes)`)
  if (parser.count === 0) throw new Error('el zip no trae buildingpart.gml')

  current = { code, name, state: 'processing', loaded, total }
  sendStatus()
  const tiles: string[] = []
  let bytes = 0
  const d = await db()
  const tx = d.transaction(['tiles', 'munis'], 'readwrite')
  const ts = tx.objectStore('tiles')
  for (const [tile, b] of buckets) {
    b.ringStart.push(b.coords.n / 2)
    b.partRing.push(b.ringStart.n)
    const rec: CatTile & { key: string } = {
      key: `${code}|${tile}`,
      code,
      tile,
      coords: b.coords.done(),
      ringStart: b.ringStart.done(),
      partRing: b.partRing.done(),
      floors: b.floors.done(),
    }
    bytes += rec.coords.byteLength + rec.ringStart.byteLength + rec.partRing.byteLength + rec.floors.byteLength
    ts.put(rec)
    tiles.push(tile)
  }
  const muni: MuniRecord = { code, name: prettyName(name), bytes, parts, fetched: Date.now(), tiles }
  tx.objectStore('munis').put(muni)
  await txDone(tx)
  stored.set(code, muni)
  failedAt.delete(code)
  console.log(`[catastro] ${muni.name}: ${parts} partes en ${tiles.length} teselas (${(bytes / 1048576).toFixed(1)} MB)`)
  post({ t: 'ready', code, tiles, bbox: entry.bbox })
}

function prettyName(s: string): string {
  // "MORALEJA DE ENMEDIO" → "Moraleja de Enmedio"
  const small = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y', 'e', 'i', 'en'])
  return s
    .toLowerCase()
    .split(/(\s+|-|\/)/)
    .map((w, i) => (i > 0 && small.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join('')
}

function lonToX(lon: number): number {
  return ((lon + 180) / 360) * N
}

function latToY(lat: number): number {
  const r = (lat * Math.PI) / 180
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * N
}

// ---------------------------------------------------------------------------
// Peticiones del juego
// ---------------------------------------------------------------------------

/** ¿Falta algún municipio cuyo recuadro toca la tesela? */
async function isPending(x: number, y: number): Promise<boolean> {
  await storedReady
  try {
    const munis = await munisIn(tileBox(x, y))
    return munis.some((m) => !stored.has(m.code!) && !blocked(m.code!) && !huge(m.bbox))
  } catch {
    return false // sin índice: lo que haya guardado
  }
}

async function tile(id: number, x: number, y: number): Promise<void> {
  const pending = await isPending(x, y)
  let data: CatTile[] = []
  try {
    const d = await db()
    data = (await reqP(d.transaction('tiles').objectStore('tiles').index('byTile').getAll(`${x}/${y}`))) as CatTile[]
  } catch (e) {
    console.warn('[catastro] lectura', e)
  }
  const transfer: Transferable[] = []
  for (const r of data) transfer.push(r.coords.buffer, r.ringStart.buffer, r.partRing.buffer, r.floors.buffer)
  post({ t: 'tile', id, pending, data }, transfer)
}

async function list(id: number): Promise<void> {
  await storedReady
  const munis: MuniInfo[] = [...stored.values()]
    .map(({ code, name, bytes, parts, fetched }) => ({ code, name, bytes, parts, fetched }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'))
  post({ t: 'list', id, munis })
}

async function remove(id: number, code: string | null): Promise<void> {
  await storedReady
  const codes = code === null ? [...stored.keys()] : [code]
  const tiles = new Set<string>()
  const d = await db()
  const tx = d.transaction(['tiles', 'munis'], 'readwrite')
  for (const c of codes) {
    const m = stored.get(c)
    if (!m) continue
    for (const t of m.tiles) {
      tiles.add(t)
      tx.objectStore('tiles').delete(`${c}|${t}`)
    }
    tx.objectStore('munis').delete(c)
    stored.delete(c)
    deletedNow.add(c)
  }
  await txDone(tx)
  queue = queue.filter((q) => !deletedNow.has(q.entry.code!))
  sendStatus()
  post({ t: 'deleted', id, tiles: [...tiles] })
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data
  const fail = (err: unknown) => console.warn('[catastro]', m.t, err)
  switch (m.t) {
    case 'want':
      want(m.circles).catch(fail)
      break
    case 'tile':
      tile(m.id, m.x, m.y).catch((err) => {
        fail(err)
        post({ t: 'tile', id: m.id, pending: false, data: [] })
      })
      break
    case 'pending':
      isPending(m.x, m.y)
        .then((pending) => post({ t: 'pending', id: m.id, pending }))
        .catch(() => post({ t: 'pending', id: m.id, pending: false }))
      break
    case 'list':
      list(m.id).catch(fail)
      break
    case 'delete':
      remove(m.id, m.code).catch((err) => {
        fail(err)
        post({ t: 'deleted', id: m.id, tiles: [] })
      })
      break
  }
}
