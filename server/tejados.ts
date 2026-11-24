// /tejados/<fichero> → adjunto de la versión «datos-tejados» de GitHub, por rangos.
//
// Los tejados de OpenStreetMap de todo el mundo (src/world/worldRoofs.ts) son un fichero de ~150 MB
// del que el juego pide solo trozos (el índice y la zona por donde vuela). GitHub sirve los adjuntos
// con rangos pero sin cabeceras CORS, así que la página no los puede pedir directamente: este
// servidor (el de desarrollo de Vite y el de `npm run server`) hace de intermediario.
// La app de escritorio tiene lo mismo en Rust (src-tauri/src/tejados.rs): mantener iguales.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'

const UPSTREAM = 'https://github.com/Marius-Romanus/autogiro/releases/download/datos-tejados/'
const FILE = /^tejados-mundo-\d{8}\.bin$/
/** un solo rango «bytes=a-b», de 32 MB como mucho (el índice o una zona; nunca el fichero entero) */
const RANGE = /^bytes=(\d{1,12})-(\d{1,12})$/
const MAX = 32 << 20

/** Atiende la petición si es de los tejados (devuelve true) o la deja pasar (false). */
export function tejadosProxy(req: IncomingMessage, res: ServerResponse): boolean {
  const url = req.url ?? ''
  if (!url.startsWith('/tejados/')) return false
  const file = new URL(url, 'http://localhost').pathname.slice('/tejados/'.length)
  const m = RANGE.exec(String(req.headers.range ?? ''))
  if (req.method !== 'GET' || !FILE.test(file) || !m || Number(m[2]) < Number(m[1]) || Number(m[2]) - Number(m[1]) >= MAX) {
    res.writeHead(FILE.test(file) ? 416 : 404).end()
    return true
  }
  const ctrl = new AbortController()
  res.on('close', () => ctrl.abort())
  fetch(UPSTREAM + file, { signal: ctrl.signal, headers: { Range: `bytes=${m[1]}-${m[2]}`, 'User-Agent': 'Autogiro (simulador de vuelo)' } })
    .then((up) => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/octet-stream',
        // el nombre lleva la fecha de los datos: no cambia nunca
        'Cache-Control': 'public, max-age=604800, immutable',
      }
      const len = up.headers.get('content-length')
      if (len && !up.headers.get('content-encoding')) headers['Content-Length'] = len
      const cr = up.headers.get('content-range')
      if (cr) headers['Content-Range'] = cr
      res.writeHead(up.status, headers)
      if (!up.body) return void res.end()
      Readable.fromWeb(up.body as any)
        .on('error', () => res.destroy())
        .pipe(res)
    })
    .catch((e) => {
      if (ctrl.signal.aborted) return
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`Tejados: ${e?.message ?? e}`)
    })
  return true
}
