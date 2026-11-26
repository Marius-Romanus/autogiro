// Prueba del servidor de salas sin navegador:  npm run mp-test
// Crea una sala, une a dos pilotos más, reenvía estado/chat/condiciones,
// comprueba los errores (código inexistente, sala llena) y el traspaso de anfitrión,
// y la voz de la radio (mensajes binarios: solo a la sala y a quien tiene la radio, límites).

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { attachMultiplayer } from '../server/rooms.ts'
import { BIN_VOICE, MAX_PLAYERS, VOICE_BURST, VOICE_MAX } from '../src/net/protocol.ts'

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
  /** mensajes binarios (voz) recibidos */
  bins: Uint8Array[] = []
  private waiters: { pred: (m: any) => boolean; res: (m: any) => void }[] = []
  constructor() {
    this.ws = new WebSocket(url)
    this.ws.binaryType = 'arraybuffer'
    this.ws.onmessage = (e) => {
      if (typeof e.data !== 'string') {
        this.bins.push(new Uint8Array(e.data as ArrayBuffer))
        return
      }
      const m = JSON.parse(e.data)
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

  // aire del día: sin él (anfitriones anteriores), atmósfera estándar; con él, llega acotado
  check(wb.c?.isa === true && wb.c.oatC === 15 && wb.c.qnh === 1013.25, 'sin aire del día → atmósfera estándar')
  // viento del terreno: sin él (anfitriones anteriores), viento uniforme
  check(wb.c?.terrainWind === false, 'sin viento del terreno → viento uniforme')
  a.send({
    t: 'cond',
    c: { locationId: 'lemt26', hour: 14, dayOfYear: 220, windFrom: 250, windSpeed: 6, turbulence: 0.2, clouds: 'fair', simTime: 1.7e12, collisions: true, isa: false, oatC: 38, qnh: 1009.4, dewPointC: 9, visibility: 999999, precip: 1.5, weatherCode: 61, windGustKt: 18, terrainWind: true },
  })
  const cw = (await b.next('cond')).c
  check(
    cw.isa === false && cw.oatC === 38 && cw.qnh === 1009.4 && cw.dewPointC === 9 && cw.visibility === 100000 && cw.precip === 1.5 && cw.weatherCode === 61 && cw.windGustKt === 18,
    'temperatura, QNH y datos del tiempo real llegan a los invitados (acotados)',
  )
  check(cw.terrainWind === true, 'el viento del terreno llega a los invitados')

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

  // --- radio de voz ---
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const voice = (body: number[] | Uint8Array, kind = BIN_VOICE) => Uint8Array.from([kind, ...body])
  const va = new Bot()
  const vb = new Bot()
  const vc = new Bot()
  const vd = new Bot()
  await Promise.all([va.open(), vb.open(), vc.open(), vd.open()])
  va.send({ t: 'create', ...profile('Radio A'), radio: 3 })
  const wva = await va.next('welcome')
  vb.send({ t: 'join', code: wva.code, ...profile('Radio B'), radio: 1 })
  const wvb = await vb.next('welcome')
  check(wvb.peers[0]?.radio === 3, 'la radio va en el perfil (bits 1 = escucha, 2 = Opus)')
  vc.send({ t: 'join', code: wva.code, ...profile('Sin radio'), radio: 7 }) // valor raro: radio apagada
  await vc.next('welcome')
  let jc = await va.next('join')
  if (jc.peer.name !== 'Sin radio') jc = await va.next('join') // (antes llega la de Radio B)
  check(jc.peer.name === 'Sin radio' && jc.peer.radio === 0, 'un valor de radio no válido cuenta como apagada')
  vd.send({ t: 'create', ...profile('Otra sala'), radio: 1 })
  await vd.next('welcome')
  await sleep(100)

  va.ws.send(voice([0, 1, 0, 7, 0xaa, 0xbb]))
  await sleep(300)
  const got = vb.bins[0]
  const idBytes = [(wva.id >>> 24) & 255, (wva.id >>> 16) & 255, (wva.id >>> 8) & 255, wva.id & 255]
  check(
    vb.bins.length === 1 && got !== undefined && [...got].join() === [BIN_VOICE, ...idBytes, 0, 1, 0, 7, 0xaa, 0xbb].join(),
    'la voz llega a la sala con el id del emisor delante',
  )
  check(va.bins.length === 0 && vc.bins.length === 0 && vd.bins.length === 0, 'ni al emisor, ni a quien no tiene la radio, ni a otra sala')

  vb.bins.length = 0
  vc.ws.send(voice([0, 1, 0, 1, 1, 2]))
  va.ws.send(voice([0, 1, 0]))
  va.ws.send(voice(new Uint8Array(VOICE_MAX + 1)))
  va.ws.send(voice([0, 1, 0, 7, 1], 2))
  await sleep(300)
  check(vb.bins.length === 0 && va.bins.length === 0, 'sin radio no se emite; tamaño o tipo malos se tiran')
  va.ws.send(voice(new Uint8Array(VOICE_MAX)))
  await sleep(200)
  check(vb.bins.length === 1 && vb.bins[0].length === 1 + 4 + VOICE_MAX, `un paquete del tamaño máximo (${VOICE_MAX} bytes) pasa y la conexión sigue`)

  // el oyente sin radio la enciende: ya le llega
  vc.send({ t: 'profile', ...profile('Sin radio'), radio: 1 })
  const pc = await va.next('profile')
  check(pc.radio === 1, 'el cambio de radio se avisa a la sala')
  vb.bins.length = 0
  va.ws.send(voice([0, 0, 0, 8, 9]))
  await sleep(300)
  check(vc.bins.length === 1 && vb.bins.length === 1, 'al encenderla, le llega la voz')

  // ritmo: una ráfaga de 150 paquetes de 40 ms en μ-law (325 bytes) → pasan como mucho los de la ráfaga
  vb.bins.length = 0
  await sleep(2100) // (cubos llenos otra vez)
  const frame = voice(new Uint8Array(324))
  for (let i = 0; i < 150; i++) va.ws.send(frame)
  await sleep(500)
  const passed = vb.bins.length
  check(passed >= VOICE_BURST - 5 && passed <= VOICE_BURST + 5, `límite de ritmo de la voz: de 150 seguidos pasan ${passed} (ráfaga ${VOICE_BURST})`)
  // y el JSON del mismo cliente sigue pasando (cubos aparte)
  va.send({ t: 'chat', text: 'radio y chat' })
  check((await vb.next('chat')).text === 'radio y chat', 'el chat sigue pasando tras la ráfaga de voz')

  for (const bot of [va, vb, vc, vd]) bot.ws.close()
  await sleep(200)
} catch (err) {
  failures++
  console.error('✘', err)
}

mp.close()
server.close()
console.log(failures ? `\n${failures} fallo(s)` : '\nTodo correcto')
process.exit(failures ? 1 : 0)
