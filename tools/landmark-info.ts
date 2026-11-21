// Punto de salida en vuelo hacia un sitio emblemático, para las ubicaciones de src/config.ts:
// a `dist` metros del sitio con rumbo hacia él, a la altura que deja `altura` m sobre el sitio
// y al menos 150 m sobre el relieve del trayecto (±200 m a los lados, hasta 600 m más allá).
// Relieve de Terrarium (AWS Terrain Tiles, z13): suaviza los peñones y los tajos estrechos, así
// que en esos casos conviene subir la altitud a mano. Geoide EGM2008 de GeographicLib.
//
//   node --experimental-strip-types tools/landmark-info.ts <lat> <lon> <rumbo> [dist=2000] [altura=200]

import { inflateSync } from 'node:zlib'

const DEG = Math.PI / 180
const M_LAT = 111132
const Z = 13
const CLEAR = 150
const SIDE = 200
const BEYOND = 600

const [lat, lon, hdg] = process.argv.slice(2, 5).map(Number)
const dist = Number(process.argv[5] ?? 2000)
const above = Number(process.argv[6] ?? 200)
if (![lat, lon, hdg, dist, above].every(isFinite)) {
  console.error('uso: landmark-info.ts <lat> <lon> <rumbo> [dist=2000] [altura=200]')
  process.exit(1)
}

type Img = { w: number; bpp: number; px: Uint8Array }

/** PNG de 8 bits RGB/RGBA sin entrelazar (lo que sirve Terrarium) */
function decodePng(buf: Uint8Array): Img {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let p = 8
  let w = 0
  let h = 0
  let bpp = 3
  const idat: Uint8Array[] = []
  while (p < buf.length) {
    const len = dv.getUint32(p)
    const type = String.fromCharCode(...buf.subarray(p + 4, p + 8))
    const data = buf.subarray(p + 8, p + 8 + len)
    if (type === 'IHDR') {
      w = dv.getUint32(p + 8)
      h = dv.getUint32(p + 12)
      bpp = data[9] === 6 ? 4 : 3
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    p += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = w * bpp
  const px = new Uint8Array(h * stride)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const row = y * stride
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? px[row + i - bpp] : 0
      const b = y > 0 ? px[row - stride + i] : 0
      const c = y > 0 && i >= bpp ? px[row - stride + i - bpp] : 0
      let v = raw[src + i]
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) {
        const q = a + b - c
        const pa = Math.abs(q - a)
        const pb = Math.abs(q - b)
        const pc = Math.abs(q - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      px[row + i] = v & 255
    }
  }
  return { w, bpp, px }
}

const tiles = new Map<string, Promise<Img>>()
function tile(x: number, y: number): Promise<Img> {
  const k = `${x}/${y}`
  let t = tiles.get(k)
  if (!t) {
    t = fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${k}.png`).then(async (r) => {
      if (!r.ok) throw new Error(`Terrarium ${k}: ${r.status}`)
      return decodePng(new Uint8Array(await r.arrayBuffer()))
    })
    tiles.set(k, t)
  }
  return t
}

async function elev(la: number, lo: number): Promise<number> {
  const n = 2 ** Z
  const fx = ((lo + 180) / 360) * n
  const r = la * DEG
  const fy = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n
  const tx = Math.floor(fx)
  const ty = Math.floor(fy)
  const t = await tile(tx, ty)
  const i = Math.min(255, Math.floor((fx - tx) * 256))
  const j = Math.min(255, Math.floor((fy - ty) * 256))
  const o = (j * t.w + i) * t.bpp
  return Math.max(0, t.px[o] * 256 + t.px[o + 1] + t.px[o + 2] / 256 - 32768)
}

const offset = (la: number, lo: number, h: number, d: number): [number, number] => [
  la + (Math.cos(h * DEG) * d) / M_LAT,
  lo + (Math.sin(h * DEG) * d) / (M_LAT * Math.cos(la * DEG)),
]

const [sLat, sLon] = offset(lat, lon, hdg + 180, dist)
const g0 = await elev(sLat, sLon)
const gT = await elev(lat, lon)
let maxP = 0
let maxAt = 0
for (let x = 0; x <= dist + BEYOND; x += 50) {
  const [la, lo] = offset(sLat, sLon, hdg, x)
  for (let y = -SIDE; y <= SIDE; y += 50) {
    const [pl, pn] = offset(la, lo, hdg + 90, y)
    const e = await elev(pl, pn)
    if (e > maxP) {
      maxP = e
      maxAt = x
    }
  }
}
const msl = Math.max(gT + above, maxP + CLEAR)
const airAGL = Math.ceil((msl - g0) / 10) * 10

const html = await (await fetch(`https://geographiclib.sourceforge.io/cgi-bin/GeoidEval?input=${sLat.toFixed(5)}+${sLon.toFixed(5)}`)).text()
const geoid = Number(html.replace(/<[^>]*>/g, '').match(/EGM2008\s*=\s*([-\d.]+)/)?.[1])

console.log(`salida ${sLat.toFixed(4)}, ${sLon.toFixed(4)} · suelo ${g0.toFixed(0)} m · sitio ${gT.toFixed(0)} m`)
console.log(`relieve máximo del trayecto ${maxP.toFixed(0)} m a ${maxAt} m de la salida → ${Math.round(g0 + airAGL)} m de altitud`)
console.log(`lat: ${sLat.toFixed(4)}, lon: ${sLon.toFixed(4)}, heading: ${hdg}, geoid: ${geoid.toFixed(1)}, airAGL: ${airAGL}`)
