import { defineConfig, type Plugin } from 'vite'
import type { Server } from 'node:http'
import { attachMultiplayer } from './server/rooms.ts'

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
  plugins: [multiplayer()],
  server: { port: 5173, host: 'localhost' },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
})
