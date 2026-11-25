// Puentes de OpenStreetMap alrededor de unas coordenadas tal como los ve el juego
// (src/world/bridgeNet.ts + bridgeChains.ts): cadenas de tramos, altura del tablero deducida
// del terreno, luz libre, pilas, si el MDT del IGN lo lleva incrustado (se rebaja el terreno) y
// el relleno de los accesos donde el MDT redondea el terraplén contra el estribo.
//
//   node --experimental-strip-types tools/bridge-info.ts <lat> <lon> [radio en teselas z14 = 0] [todos]
//
// Solo España (usa el MDT05 del IGN, como el juego dentro de España). «todos» lista también
// los puentes que no se dibujan por no tener luz libre.

import { readFileSync } from 'node:fs'
import { QMHeightSource } from '../src/world/HeightSource.ts'
import { BridgeNet } from '../src/world/bridgeNet.ts'
import { ChainBuilder, type Chain } from '../src/world/bridgeChains.ts'
import { planStructure } from '../src/world/bridgeShapes.ts'
import { bridgeRecordsNear, setBridgeTable } from '../src/world/bridgeStructures.ts'

const lat = Number(process.argv[2])
const lon = Number(process.argv[3])
const radius = Number(process.argv[4] ?? 0) || 0
const all = process.argv.includes('todos')
if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
  console.error('uso: bridge-info.ts <lat> <lon> [radio en teselas] [todos]')
  process.exit(1)
}

const n = 2 ** 14
const cx = Math.floor(((lon + 180) / 360) * n)
const r = (lat * Math.PI) / 180
const cy = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)

setBridgeTable(new Uint8Array(readFileSync('public/bridges.bin')))
const net = new BridgeNet()
const heights = new QMHeightSource('https://qm-mdt.idee.es/1.0.0/terrain/', 16, 2000)
const builder = new ChainBuilder(net, heights, { carve: true, fill: true })
// «perfil=<largo mínimo>»: medidas del rebaje, estación a estación, de los puentes de al menos ese largo
const profArg = process.argv.find((a) => a.startsWith('perfil='))
if (profArg) {
  const min = Number(profArg.slice(7)) || 0
  builder.carveDebug = (c, rows) => {
    if (c.len < min) return
    console.log(`perfil de ${c.parts[0].piece.cls} ${Math.round(c.len)} m: s | calzada | terreno | izq. 8/12/24 m | der. 8/12/24 m | marca`)
    const step = Math.max(1, Math.round(rows.length / 60))
    const f = (v: number) => (Number.isNaN(v) ? '  -' : v.toFixed(0).padStart(3))
    rows.forEach((r, i) => {
      if (i % step === 0) console.log(`  ${r.s.toFixed(0).padStart(5)} | ${f(r.deck)} | ${f(r.top)} | ${r.left.map(f).join(' ')} | ${r.right.map(f).join(' ')} | ${r.flag ? 'X' : ''}`)
    })
  }
}

const seen = new Set<Chain>()
let pieces = 0
const t0 = performance.now()
for (let y = cy - radius; y <= cy + radius; y++) {
  for (let x = cx - radius; x <= cx + radius; x++) {
    await net.close(x, y)
    for (const p of net.piecesOf(x, y)) {
      pieces++
      const c = await builder.chain(p)
      if (c) seen.add(c)
    }
  }
}
const list = [...seen].sort((a, b) => b.len - a.len)
const drawn = list.filter((c) => c.draw)
console.log(
  `${pieces} tramos en ${(2 * radius + 1) ** 2} teselas → ${list.length} puentes, ${drawn.length} con luz libre ≥ 2 m ` +
    `(${net.tileCount} teselas de red cargadas, ${((performance.now() - t0) / 1000).toFixed(1)} s)`,
)
for (const c of all ? list : drawn) {
  const p = c.parts[0].piece
  let gMin = Infinity
  for (let i = 0; i < c.n; i++) gMin = Math.min(gMin, c.ground[i])
  const mid = c.n >> 1
  const ends = `${c.startTerminal ? 'suelo' : c.closed ? 'cruce' : 'sigue'}–${c.endTerminal ? 'suelo' : c.closed ? 'cruce' : 'sigue'}`
  console.log(
    `${p.cls.padEnd(10)} ${String(Math.round(c.len)).padStart(5)} m  ancho ${p.width.toFixed(1)}  ${ends.padEnd(11)} ` +
      `tablero ${c.deck[0].toFixed(1)} / ${c.deck[mid].toFixed(1)} / ${c.deck[c.n - 1].toFixed(1)}  suelo mín. ${gMin.toFixed(1)}  ` +
      `luz ${c.maxClear.toFixed(1)} m  pilas ${c.piers.length}  canto ${c.depth.toFixed(1)}` +
      (c.carve ? `  REBAJE ${c.carve.stations} est.` : '') +
      (c.fills.length ? `  RELLENO ${c.fills.map((f) => `${f.depth.toFixed(1)} m en ${f.reach} m`).join(' y ')}` : '') +
      (c.draw ? '' : '  (no se dibuja)') +
      `  @ ${c.lat[mid].toFixed(5)},${c.lon[mid].toFixed(5)}`,
  )
  if (!c.draw) continue
  const plan = await planStructure(c, await bridgeRecordsNear(c), net, builder)
  if (plan) {
    const own = plan.owner === c
    console.log(
      `             → ${plan.shape}${own ? '' : ' (va pegado al puente que la lleva)'}: puente ${Math.round(plan.a)}–${Math.round(plan.b)} m, vano ${Math.round(plan.span)} m en ${Math.round(plan.m0)}–${Math.round(plan.m1)}` +
        (plan.towers.length ? `, ${plan.towers.length} torres de ${Math.round(plan.towerH)} m sobre el tablero` : '') +
        (plan.bays.length ? `, ${plan.bays.filter((q) => q.ok).length}/${plan.bays.length} arcos de ${plan.bayLen.toFixed(1)} m` : '') +
        (plan.rise ? `, flecha ${plan.rise.toFixed(0)} m` : '') +
        `, ancho ${(plan.extL + plan.extR).toFixed(1)} m (registro: largo ${plan.rec.length}, vano ${plan.rec.span}, alto ${plan.rec.height})`,
    )
  }
}
heights.dispose()
net.dispose()
