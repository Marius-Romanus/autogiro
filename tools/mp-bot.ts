// Piloto de prueba para el multijugador: vuela círculos sobre Casarrubios (LEMT)
// o se queda parado en la pista, para probar las salas sin un segundo ordenador.
//
//   npm run mp-bot                 crea una sala (el bot es el anfitrión) y muestra el código
//   npm run mp-bot -- K7QX         se une a la sala K7QX
//   npm run mp-bot -- K7QX suelo   parado en la cabecera 26
//   npm run mp-bot -- K7QX luces   con las luces exteriores encendidas (se combina con suelo)
//   npm run mp-bot -- --server ws://192.168.1.20:8080/mp
//
// Por defecto se conecta al servidor de Vite (npm run dev, puerto 5173).

import { Matrix4, Quaternion, Vector3 } from 'three'
import type { RoomConditions, ServerMsg, StateMsg } from '../src/net/protocol.ts'

const args = process.argv.slice(2)
const serverIdx = args.indexOf('--server')
const server = serverIdx >= 0 ? args.splice(serverIdx, 2)[1] : 'ws://localhost:5173/mp'
const parked = args.includes('suelo')
const lights = args.includes('luces')
const code = args.find((a) => /^[a-z0-9]{4}$/i.test(a))?.toUpperCase()

const DEG = Math.PI / 180
// centro del campo y elevación (m sobre el nivel del mar ≈ datum común del protocolo)
const LEMT = { lat: 40.23483, lon: -4.02703, elev: 625 }
const RADIUS = 380
const SPEED = 29 // m/s (~105 km/h)
const AGL = 160
const CG_AGL_ON_GROUND = 1.15

// --- WGS84 ---
const A = 6378137
const F = 1 / 298.257223563
const E2 = F * (2 - F)
function ecef(latDeg: number, lonDeg: number, h: number): Vector3 {
  const la = latDeg * DEG
  const lo = lonDeg * DEG
  const n = A / Math.sqrt(1 - E2 * Math.sin(la) ** 2)
  return new Vector3((n + h) * Math.cos(la) * Math.cos(lo), (n + h) * Math.cos(la) * Math.sin(lo), (n * (1 - E2) + h) * Math.sin(la))
}
function enu(latDeg: number, lonDeg: number) {
  const la = latDeg * DEG
  const lo = lonDeg * DEG
  return {
    e: new Vector3(-Math.sin(lo), Math.cos(lo), 0),
    n: new Vector3(-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)),
    u: new Vector3(Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)),
  }
}
/** vector local (este, norte, arriba) → ECEF */
const toEcef = (b: ReturnType<typeof enu>, e: number, n: number, u: number) =>
  new Vector3().addScaledVector(b.e, e).addScaledVector(b.n, n).addScaledVector(b.u, u)

const t0 = performance.now()
let seq = 0

function state(): StateMsg {
  const now = performance.now()
  const t = (now - t0) / 1000
  let lat: number, lon: number, h: number, psi: number, bank: number, speed: number
  if (parked) {
    // en la pista 26, 60 m más adentro que la salida de esa cabecera (config.ts), rumbo 258°
    psi = 257.97 * DEG
    const d = 60
    lat = 40.235698 + (d * Math.cos(psi)) / 6371000 / DEG
    lon = -4.02171 + (d * Math.sin(psi)) / (6371000 * Math.cos(40.2357 * DEG)) / DEG
    h = LEMT.elev + CG_AGL_ON_GROUND
    bank = 0
    speed = 0
  } else {
    // círculo a derechas sobre el campo
    const th = (SPEED / RADIUS) * t
    const dE = RADIUS * Math.sin(th)
    const dN = RADIUS * Math.cos(th)
    lat = LEMT.lat + dN / 6371000 / DEG
    lon = LEMT.lon + dE / (6371000 * Math.cos(LEMT.lat * DEG)) / DEG
    h = LEMT.elev + AGL + 15 * Math.sin(t * 0.25)
    psi = th + Math.PI / 2
    bank = Math.atan((SPEED * SPEED) / (9.81 * RADIUS))
    speed = SPEED
  }
  const b = enu(lat, lon)
  const fwd = new Vector3(Math.sin(psi), Math.cos(psi), 0)
  const rightL = new Vector3(Math.cos(psi), -Math.sin(psi), 0)
  const upL = new Vector3(0, 0, 1)
  const up = upL.clone().multiplyScalar(Math.cos(bank)).addScaledVector(rightL, Math.sin(bank))
  const right = rightL.clone().multiplyScalar(Math.cos(bank)).addScaledVector(upL, -Math.sin(bank))
  const X = toEcef(b, fwd.x, fwd.y, fwd.z)
  const Y = toEcef(b, up.x, up.y, up.z)
  const Z = toEcef(b, right.x, right.y, right.z)
  const q = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(X, Y, Z))
  const tilt = parked ? 0 : 8 * DEG // disco inclinado hacia atrás
  const nrm = Y.clone().multiplyScalar(Math.cos(tilt)).addScaledVector(X, -Math.sin(tilt))
  const p = ecef(lat, lon, h)
  const v = X.clone().multiplyScalar(speed)
  const r = (x: number, k: number) => Math.round(x * k) / k
  return {
    t: 's',
    ts: Math.round(now),
    sq: seq,
    st: 1,
    p: [r(p.x, 100), r(p.y, 100), r(p.z, 100)],
    q: [r(q.x, 1e5), r(q.y, 1e5), r(q.z, 1e5), r(q.w, 1e5)],
    v: [r(v.x, 100), r(v.y, 100), r(v.z, 100)],
    n: [r(nrm.x, 1e4), r(nrm.y, 1e4), r(nrm.z, 1e4)],
    hb: [-0.33, 1.6, 0],
    rr: parked ? 0 : 365,
    er: parked ? 1400 : 5200,
    hp: parked ? 0 : 0.06,
    hr: 0,
    rd: 0,
    ns: 0,
    sp: parked ? 0 : 0.1,
    sr: parked ? 0 : 0.15,
    g: parked ? 1 : 0,
    ag: parked ? CG_AGL_ON_GROUND : AGL,
    li: lights ? 1 : 0,
  }
}

const conditions = (): RoomConditions => ({
  locationId: 'lemt26',
  customLat: LEMT.lat,
  customLon: LEMT.lon,
  hour: 11,
  dayOfYear: 140,
  windFrom: 250,
  windSpeed: 6,
  turbulence: 0.25,
  clouds: 'fair',
  simTime: Date.UTC(2026, 4, 20, 9, 0, 0) + (performance.now() - t0),
  collisions: true,
})

let lastCond = ''
function logConditions(c: RoomConditions): void {
  const hhmm = new Date(c.simTime).toISOString().slice(11, 16)
  const txt = `Condiciones: ${c.locationId} · ${hhmm} UTC · viento ${c.windFrom}°/${c.windSpeed} kt · nubes ${c.clouds} · choques ${c.collisions ? 'sí' : 'no'}`
  if (txt !== lastCond) console.log(txt)
  lastCond = txt
}

const ws = new WebSocket(server)
const profile = { name: parked ? 'Bot (en pista)' : 'Bot', aircraft: 'ela10', passenger: false }
let host = false
let myId = 0
const names = new Map<number, string>()

ws.onopen = () => {
  ws.send(JSON.stringify(code ? { t: 'join', code, ...profile } : { t: 'create', ...profile }))
}
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data)) as ServerMsg
  switch (m.t) {
    case 'welcome':
      myId = m.id
      host = m.hostId === m.id
      for (const p of m.peers) names.set(p.id, p.name)
      console.log(`En la sala ${m.code}${host ? ' (anfitrión)' : ''} · ${m.peers.length + 1} pilotos · Ctrl+C para salir`)
      if (m.c) logConditions(m.c)
      if (host) ws.send(JSON.stringify({ t: 'cond', c: conditions() }))
      setInterval(() => ws.send(JSON.stringify(state())), 1000 / 15)
      if (host) setInterval(() => ws.send(JSON.stringify({ t: 'cond', c: conditions() })), 10000)
      break
    case 'error':
      console.error(`Error: ${m.msg}`)
      process.exit(1)
    case 'join':
      names.set(m.peer.id, m.peer.name)
      console.log(`+ ${m.peer.name}`)
      break
    case 'leave':
      console.log(`- ${names.get(m.id) ?? m.id}`)
      break
    case 'host':
      host = m.id === myId
      console.log(`Anfitrión: ${host ? 'el bot' : (names.get(m.id) ?? m.id)}`)
      break
    case 'cond':
      logConditions(m.c)
      break
    case 'chat': {
      if (m.id === myId) break
      const from = names.get(m.id) ?? String(m.id)
      console.log(`${from}: ${m.text}`)
      // solo contesta a personas (dos bots se contestarían sin fin)
      if (!from.startsWith('Bot'))
        ws.send(JSON.stringify({ t: 'chat', text: parked ? 'Recibido, sigo en la pista.' : 'Recibido, en el circuito a 500 ft.' }))
      break
    }
    case 'ev':
      console.log(`✖ ${names.get(m.id) ?? m.id}: ${m.text}`)
      break
  }
}
ws.onclose = () => {
  console.log('Conexión cerrada')
  process.exit(0)
}
ws.onerror = () => {
  console.error(`No se pudo conectar con ${server}. ¿Está arrancado «npm run dev»?`)
}
