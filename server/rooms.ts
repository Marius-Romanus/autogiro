// Servidor de salas del multijugador: WebSocket en /mp, salas con código de 4 caracteres.
//
// No simula nada: cada cliente es dueño de su autogiro y el servidor solo reparte
// los mensajes dentro de la sala (estado, chat, condiciones del anfitrión).
// Se engancha a cualquier servidor HTTP: el de Vite (vite.config.ts) o server/index.ts.

import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, WebSocket } from 'ws'
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  MAX_PLAYERS,
  MP_PATH,
  cleanName,
  cleanText,
  isValidCode,
  normalizeCode,
  type PeerInfo,
  type RoomConditions,
  type ServerMsg,
} from '../src/net/protocol.ts'

interface Client {
  ws: WebSocket
  id: number
  name: string
  aircraft: string
  passenger: boolean
  slot: number
  room: Room | null
  alive: boolean
  /** cubo de fichas para limitar mensajes por segundo */
  tokens: number
  lastRefill: number
}

interface Room {
  code: string
  clients: Map<number, Client>
  hostId: number
  cond: RoomConditions | null
  condAt: number
}

const MAX_ROOMS = 2000
const RATE = 40 // mensajes/s sostenidos por cliente (estado a 15 Hz + chat)
const BURST = 80

export interface MultiplayerServer {
  readonly rooms: Map<string, Room>
  close(): void
}

/** Engancha el servidor de salas al `upgrade` de un servidor HTTP existente. */
export function attachMultiplayer(server: Server, log: (msg: string) => void = () => {}): MultiplayerServer {
  const rooms = new Map<string, Room>()
  const clients = new Map<WebSocket, Client>()
  const wss =new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false })
  let nextId = 1

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let path = ''
    try {
      path = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      return
    }
    if (path !== MP_PATH) return // el resto (p. ej. el HMR de Vite) no es nuestro
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  }
  server.on('upgrade', onUpgrade)

  const send = (c: Client, m: ServerMsg | string) => {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(typeof m === 'string' ? m : JSON.stringify(m))
  }
  const broadcast = (room: Room, m: ServerMsg, except?: Client) => {
    const data = JSON.stringify(m)
    for (const c of room.clients.values()) if (c !== except) send(c, data)
  }
  const info = (c: Client): PeerInfo => ({ id: c.id, name: c.name, aircraft: c.aircraft, passenger: c.passenger, slot: c.slot })

  const newCode = (): string => {
    for (;;) {
      let code = ''
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
      if (!rooms.has(code)) return code
    }
  }

  const freeSlot = (room: Room): number => {
    const used = new Set([...room.clients.values()].map((c) => c.slot))
    let s = 0
    while (used.has(s)) s++
    return s
  }

  const enter = (c: Client, room: Room) => {
    c.slot = freeSlot(room)
    c.room = room
    room.clients.set(c.id, c)
    send(c, {
      t: 'welcome',
      code: room.code,
      id: c.id,
      hostId: room.hostId,
      slot: c.slot,
      peers: [...room.clients.values()].filter((p) => p !== c).map(info),
      c: room.cond,
      age: room.cond ? Date.now() - room.condAt : 0,
    })
    broadcast(room, { t: 'join', peer: info(c) }, c)
  }

  const leave = (c: Client) => {
    const room = c.room
    if (!room) return
    c.room = null
    room.clients.delete(c.id)
    if (room.clients.size === 0) {
      rooms.delete(room.code)
      log(`sala ${room.code} cerrada`)
      return
    }
    broadcast(room, { t: 'leave', id: c.id })
    if (room.hostId === c.id) {
      // el anfitrión pasa al que lleva más tiempo dentro
      room.hostId = room.clients.keys().next().value!
      broadcast(room, { t: 'host', id: room.hostId })
    }
  }

  const profile = (c: Client, m: any) => {
    c.name = cleanName(m.name)
    c.aircraft = cleanText(m.aircraft, 32) || 'generic'
    c.passenger = Boolean(m.passenger)
  }

  wss.on('connection', (ws: WebSocket) => {
    const c: Client = {
      ws,
      id: nextId++,
      name: 'Piloto',
      aircraft: 'generic',
      passenger: false,
      slot: 0,
      room: null,
      alive: true,
      tokens: BURST,
      lastRefill: Date.now(),
    }
    clients.set(ws, c)
    ws.on('pong', () => (c.alive = true))
    ws.on('close', () => {
      clients.delete(ws)
      leave(c)
    })
    ws.on('error', () => leave(c))
    ws.on('message', (data, isBinary) => {
      if (isBinary) return
      // límite de ritmo
      const now = Date.now()
      c.tokens = Math.min(BURST, c.tokens + ((now - c.lastRefill) / 1000) * RATE)
      c.lastRefill = now
      if (c.tokens < 1) return
      c.tokens -= 1

      let m: any
      try {
        m = JSON.parse(String(data))
      } catch {
        return
      }
      if (!m || typeof m !== 'object' || typeof m.t !== 'string') return
      const room = c.room

      switch (m.t) {
        case 's': // estado de vuelo: se reenvía tal cual con el id del emisor
          if (!room) return
          m.id = c.id
          broadcast(room, m, c)
          return
        case 'create': {
          leave(c)
          if (rooms.size >= MAX_ROOMS) {
            send(c, { t: 'error', code: 'full', msg: 'El servidor está lleno, inténtalo más tarde' })
            return
          }
          profile(c, m)
          const r: Room = { code: newCode(), clients: new Map(), hostId: c.id, cond: null, condAt: 0 }
          rooms.set(r.code, r)
          log(`sala ${r.code} creada por ${c.name}`)
          enter(c, r)
          return
        }
        case 'join': {
          const code = normalizeCode(String(m.code ?? ''))
          if (!isValidCode(code)) {
            send(c, { t: 'error', code: 'badcode', msg: `El código tiene ${CODE_LENGTH} letras o números` })
            return
          }
          const r = rooms.get(code)
          if (!r) {
            send(c, { t: 'error', code: 'noroom', msg: `No hay ninguna sala ${code}` })
            return
          }
          if (r === room) return
          if (r.clients.size >= MAX_PLAYERS) {
            send(c, { t: 'error', code: 'full', msg: `La sala ${code} está llena (${MAX_PLAYERS} pilotos)` })
            return
          }
          leave(c)
          profile(c, m)
          log(`${c.name} entra en ${code}`)
          enter(c, r)
          return
        }
        case 'leave':
          leave(c)
          return
        case 'profile':
          profile(c, m)
          if (room) broadcast(room, { t: 'profile', id: c.id, name: c.name, aircraft: c.aircraft, passenger: c.passenger }, c)
          return
        case 'cond': {
          if (!room || room.hostId !== c.id || !m.c || typeof m.c !== 'object') return
          const cond = sanitizeConditions(m.c)
          if (!cond) return
          room.cond = cond
          room.condAt = Date.now()
          broadcast(room, { t: 'cond', c: cond }, c)
          return
        }
        case 'chat': {
          const text = cleanText(m.text)
          if (!room || !text) return
          broadcast(room, { t: 'chat', id: c.id, text })
          return
        }
        case 'ev':
          if (!room || m.k !== 'crash') return
          broadcast(room, { t: 'ev', id: c.id, k: 'crash', text: cleanText(m.text, 120) }, c)
          return
      }
    })
  })

  // conexiones muertas (portátil suspendido, red caída…)
  const heartbeat = setInterval(() => {
    for (const c of clients.values()) {
      if (!c.alive) {
        c.ws.terminate()
        continue
      }
      c.alive = false
      c.ws.ping()
    }
  }, 15000)
  heartbeat.unref?.()

  return {
    rooms,
    close() {
      clearInterval(heartbeat)
      server.off('upgrade', onUpgrade)
      for (const ws of wss.clients) ws.terminate()
      wss.close()
    },
  }
}

function num(v: unknown, min: number, max: number, def: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def
}

function sanitizeConditions(c: any): RoomConditions | null {
  const locationId = cleanText(c.locationId, 32)
  if (!locationId) return null
  return {
    locationId,
    customLat: num(c.customLat, -90, 90, 40),
    customLon: num(c.customLon, -180, 180, -4),
    customHeading: num(c.customHeading, 0, 360, 0),
    customName: cleanText(c.customName, 64),
    hour: num(c.hour, 0, 24, 12),
    dayOfYear: num(c.dayOfYear, 1, 366, 140),
    windFrom: num(c.windFrom, 0, 360, 0),
    windSpeed: num(c.windSpeed, 0, 60, 0),
    turbulence: num(c.turbulence, 0, 1, 0),
    clouds: cleanText(c.clouds, 16) || 'clear',
    simTime: num(c.simTime, 0, 4e12, Date.now()),
    collisions: c.collisions !== false,
  }
}
