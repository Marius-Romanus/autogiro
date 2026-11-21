// Servidor para jugar con amigos: sirve el juego compilado (dist/) y las salas
// multijugador en el mismo puerto.
//
//   npm run build
//   npm run server            (puerto 8080; otro con PORT=9000)
//
// Para jugar por Internet, publica ese puerto (redirección en el router, Tailscale,
// un túnel tipo cloudflared…) y pasa la dirección a tus amigos.

import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { networkInterfaces } from 'node:os'
import { attachMultiplayer } from './rooms.ts'
import { catastroProxy } from './catastro.ts'

const ROOT = resolve(process.env.DIST || join(import.meta.dirname, '..', 'dist'))
const PORT = Number(process.env.PORT) || 8080
const HOST = process.env.HOST || '0.0.0.0'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

if (!existsSync(join(ROOT, 'index.html'))) {
  console.error('No encuentro dist/index.html. Compila antes el juego con:  npm run build')
  process.exit(1)
}

const server = createServer((req, res) => {
  // edificios del Catastro (los zips no se pueden pedir desde la página)
  if (catastroProxy(req, res)) return
  let path = '/'
  try {
    path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
  } catch {
    res.writeHead(400).end()
    return
  }
  let file = normalize(join(ROOT, path))
  if (file !== ROOT && !file.startsWith(ROOT + sep)) {
    res.writeHead(403).end()
    return
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(ROOT, 'index.html')
  const ext = extname(file).toLowerCase()
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  createReadStream(file).pipe(res)
})

const mp = attachMultiplayer(server, (m) => console.log(`[salas] ${m}`))

server.listen(PORT, HOST, () => {
  console.log(`Autogiro multijugador en http://localhost:${PORT}`)
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) console.log(`  en tu red local: http://${a.address}:${PORT}`)
})

process.on('SIGINT', () => {
  mp.close()
  server.close()
  process.exit(0)
})
