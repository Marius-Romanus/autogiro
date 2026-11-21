// /catastro/<ruta> → https://www.catastro.hacienda.gob.es/INSPIRE/<ruta>
//
// Los índices y los zips de edificios del Catastro (INSPIRE, por municipios) no llevan
// cabeceras CORS: una página web no los puede pedir directamente. Este servidor (el de
// desarrollo de Vite y el de `npm run server`) hace de intermediario, solo para esas rutas.
// La app de escritorio tiene lo mismo en Rust (src-tauri/src/catastro.rs): mantener iguales.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'

const UPSTREAM = 'https://www.catastro.hacienda.gob.es/INSPIRE/'

/** índice nacional, índice de una gerencia y zip de un municipio */
const ALLOWED = [
  /^buildings\/ES\.SDGC\.BU\.atom\.xml$/,
  /^buildings\/\d{2}\/ES\.SDGC\.bu\.atom_\d{2}\.xml$/,
  /^Buildings\/\d{2}\/\d{5}-[^/]{1,80}\/A\.ES\.SDGC\.BU\.\d{5}\.zip$/,
]

/** Atiende la petición si es del Catastro (devuelve true) o la deja pasar (false). */
export function catastroProxy(req: IncomingMessage, res: ServerResponse): boolean {
  const url = req.url ?? ''
  if (!url.startsWith('/catastro/')) return false
  let path: string
  try {
    path = decodeURIComponent(new URL(url, 'http://localhost').pathname.slice('/catastro/'.length))
  } catch {
    res.writeHead(400).end()
    return true
  }
  if (req.method !== 'GET' || !ALLOWED.some((re) => re.test(path))) {
    res.writeHead(404).end()
    return true
  }
  const ctrl = new AbortController()
  res.on('close', () => ctrl.abort())
  const target = UPSTREAM + path.split('/').map(encodeURIComponent).join('/')
  fetch(target, { signal: ctrl.signal, headers: { 'User-Agent': 'Autogiro (simulador de vuelo)' } })
    .then((up) => {
      const headers: Record<string, string> = { 'Content-Type': up.headers.get('content-type') ?? 'application/octet-stream', 'Cache-Control': 'no-store' }
      // fetch descomprime el gzip por su cuenta: la longitud de arriba es la comprimida y cortaría
      // la respuesta (los índices XML llegan en gzip; los zips no, y de ellos sí hace falta para el progreso)
      const len = up.headers.get('content-length')
      if (len && !up.headers.get('content-encoding')) headers['Content-Length'] = len
      res.writeHead(up.status, headers)
      if (!up.body) return void res.end()
      Readable.fromWeb(up.body as any)
        .on('error', () => res.destroy())
        .pipe(res)
    })
    .catch((e) => {
      if (ctrl.signal.aborted) return
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`Catastro: ${e?.message ?? e}`)
    })
  return true
}
