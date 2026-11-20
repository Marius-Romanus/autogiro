// Prueba del servidor de salas sin navegador:  npm run mp-test
// Crea una sala, une a dos pilotos más, reenvía estado/chat/condiciones,
// comprueba los errores (código inexistente, sala llena) y el traspaso de anfitrión.

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { attachMultiplayer } from '../server/rooms.ts'
import { MAX_PLAYERS } from '../src/net/protocol.ts'

const server = createServer()
const mp = attachMultiplayer(server)
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
// MP_URL=ws://127.0.0.1:47800/mp prueba otro servidor (p. ej. el de la app de escritorio, src-tauri/src/rooms.rs)
const url = process.env.MP_URL || `ws://127.0.0.1:${(server.address() as AddressInfo).port}/mp`

let failures = 0
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? '✔' : '✘'} ${what}`)
  if (!ok) failures++
}

class Bot {
  ws: WebSocket
  inbox: any[] = []
  private waiters: { pred: (m: any) => boolean; res: (m: any) => void }[] = []
  constructor() {
    this.ws = new WebSocket(url)
    this.ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data))
      const w = this.waiters.findIndex((x) => x.pred(m))
      if (w >= 0) this.waiters.splice(w, 1)[0].res(m)
      else this.inbox.push(m)
    }
  }
  open(): Promise<void> {
    return new Promise((r, j) => {
      this.ws.onopen = () => r()
      this.ws.onerror = (e) => j(e)
    })
  }
  send(m: object) {
    this.ws.send(JSON.stringify(m))
  }
  next(t: string, timeout = 1500): Promise<any> {
    const i = this.inbox.findIndex((m) => m.t === t)
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0])
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`timeout esperando «${t}»`)), timeout)
      this.waiters.push({ pred: (m) => m.t === t, res: (m) => (clearTimeout(timer), res(m)) })
    })
  }
}

const profile = (name: string) => ({ name, aircraft: 'ela07', passenger: false })

try {
  const a = new Bot()
  await a.open()
  a.send({ t: 'create', ...profile('Ana') })
  const wa = await a.next('welcome')
  check(/^[A-Z2-9]{4}$/.test(wa.code) && wa.hostId === wa.id && wa.slot === 0, `crear sala → código ${wa.code}, anfitrión, puesto 0`)

  a.send({ t: 'cond', c: { locationId: 'lemt26', hour: 11, dayOfYear: 140, windFrom: 250, windSpeed: 6, turbulence: 0.2, clouds: 'fair', simTime: 1.7e12, collisions: true } })

  const b = new Bot()
  await b.open()
  b.send({ t: 'join', code: wa.code.toLowerCase(), ...profile('<b>Bea</b>') })
  const wb = await b.next('welcome')
  check(wb.peers.length === 1 && wb.peers[0].name === 'Ana' && wb.slot === 1, 'unirse (código en minúsculas) → ve a Ana, puesto 1')
  check(wb.c?.locationId === 'lemt26' && wb.c.simTime === 1.7e12 && wb.age >= 0, 'recibe las condiciones del anfitrión')
  const ja = await a.next('join')
  check(ja.peer.name === 'bBea/b', `el nombre se limpia de etiquetas («${ja.peer.name}»)`)

  b.send({ t: 's', ts: 1, sq: 0, st: 1, p: [1, 2, 3], q: [0, 0, 0, 1], v: [0, 0, 0], n: [0, 1, 0], hb: [0, 1.7, 0], rr: 300, er: 5000, hp: 0, hr: 0, rd: 0, ns: 0, sp: 0, sr: 0, g: 0 })
  const sa = await a.next('s')
  check(sa.id === wb.id && sa.rr === 300, 'el estado se reenvía con el id del emisor')

  b.send({ t: 'chat', text: 'en final 26' })
  const ca = await a.next('chat')
  const cb = await b.next('chat')
  check(ca.text === 'en final 26' && cb.id === wb.id, 'chat a toda la sala (también al emisor)')

  b.send({ t: 'cond', c: { locationId: 'madrid', simTime: 1 } })
  let stolen = false
  try {
    await a.next('cond', 300)
    stolen = true
  } catch {}
  check(!stolen, 'un invitado no puede cambiar las condiciones')

  const x = new Bot()
  await x.open()
  x.send({ t: 'join', code: 'ZZZZ', ...profile('X') })
  const ex = await x.next('error')
  check(ex.code === 'noroom' || wa.code === 'ZZZZ', 'código inexistente → error «noroom»')
  x.send({ t: 'join', code: 'AB', ...profile('X') })
  check((await x.next('error')).code === 'badcode', 'código corto → error «badcode»')

  // llenar la sala
  const extra: Bot[] = []
  for (let i = 2; i < MAX_PLAYERS; i++) {
    const e = new Bot()
    await e.open()
    e.send({ t: 'join', code: wa.code, ...profile(`P${i}`) })
    await e.next('welcome')
    extra.push(e)
  }
  x.send({ t: 'join', code: wa.code, ...profile('X') })
  check((await x.next('error')).code === 'full', `sala llena con ${MAX_PLAYERS} → error «full»`)

  // el anfitrión se va → pasa a Bea
  a.ws.close()
  const lb = await b.next('leave')
  const hb = await b.next('host')
  check(lb.id === wa.id && hb.id === wb.id, 'si el anfitrión se va, el siguiente pasa a serlo')

  // ahora hay hueco: el nuevo ocupa el puesto 0 que dejó Ana
  x.send({ t: 'join', code: wa.code, ...profile('X') })
  const wx = await x.next('welcome')
  check(wx.slot === 0, 'el que entra ocupa el puesto libre más bajo')

  for (const bot of [b, x, ...extra]) bot.ws.close()
  await new Promise((r) => setTimeout(r, 200))
  if (process.env.MP_URL) {
    const y = new Bot()
    await y.open()
    y.send({ t: 'join', code: wa.code, ...profile('Y') })
    check((await y.next('error')).code === 'noroom', 'la sala se borra al quedarse vacía')
    y.ws.close()
  } else check(mp.rooms.size === 0, 'la sala se borra al quedarse vacía')
} catch (err) {
  failures++
  console.error('✘', err)
}

mp.close()
server.close()
console.log(failures ? `\n${failures} fallo(s)` : '\nTodo correcto')
process.exit(failures ? 1 : 0)
