import { defineConfig, type Plugin } from 'vite'
import type { Server } from 'node:http'
import { attachMultiplayer } from './server/rooms.ts'
import { catastroProxy } from './server/catastro.ts'

/** Edificios del Catastro (/catastro/…, ver server/catastro.ts) en el servidor de Vite. */
function catastro(): Plugin {
  return {
    name: 'autogiro-catastro',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!catastroProxy(req, res)) next()
      })
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!catastroProxy(req, res)) next()
      })
    },
  }
}

/** Salas multijugador (WebSocket en /mp) dentro del propio servidor de Vite. */
function multiplayer(): Plugin {
  return {
    name: 'autogiro-multiplayer',
    configureServer(server) {
      if (server.httpServer) attachMultiplayer(server.httpServer as Server, (m) => server.config.logger.info(`[salas] ${m}`))
    },
    configurePreviewServer(server) {
      attachMultiplayer(server.httpServer as Server, (m) => server.config.logger.info(`[salas] ${m}`))
    },
  }
}

export default defineConfig({
  plugins: [multiplayer(), catastro()],
  server: { port: 5173, host: 'localhost' },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  // los workers (tejados, Catastro) los importan: así no se descubren a mitad de partida
  optimizeDeps: { esbuildOptions: { target: 'es2022' }, include: ['straight-skeleton', 'fflate'] },
  worker: { format: 'es' },
})
