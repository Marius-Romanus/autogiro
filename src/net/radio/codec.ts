// Radio de voz: paquetes y códecs.
//
// La voz se captura a 8 kHz (la banda de una radio de avión es 300–3000 Hz: no hace falta más)
// en tramas de 40 ms. Dos códecs:
//   - μ-law (G.711): 1 byte por muestra, 320 bytes por trama (64 kbit/s). Lo entiende cualquiera.
//   - Opus (WebCodecs, opus.ts): ~45 bytes por trama (~9 kbit/s). Solo si quien emite sabe codificarlo
//     y TODOS los de la sala con la radio encendida saben descodificarlo (bit RADIO_OPUS del perfil).
// (Este archivo no usa nada del navegador: lo importa también tools/mp-bot.ts.)
//
// Cuerpo de un paquete (lo que va detrás del byte BIN_VOICE; el relé no lo mira):
//   [códec][marcas][nº de paquete, u16 big-endian][datos]

import { BIN_VOICE } from '../protocol.ts'

/** frecuencia de muestreo de la voz (Hz) y muestras por trama (40 ms) */
export const RATE = 8000
export const FRAME = 320
export const FRAME_US = 40000
export const CODEC_ULAW = 0
export const CODEC_OPUS = 1
/** marcas: primer paquete de una emisión (se abre el silenciador) y último (se cierra) */
export const F_START = 1
export const F_END = 2

export interface VoicePacket {
  /** id del emisor (lo pone el relé) */
  id: number
  codec: number
  flags: number
  seq: number
  data: Uint8Array
}

/** Mensaje binario listo para el WebSocket: [BIN_VOICE][códec][marcas][nº][datos]. */
export function packVoice(codec: number, flags: number, seq: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(5 + payload.length)
  out[0] = BIN_VOICE
  out[1] = codec
  out[2] = flags
  out[3] = (seq >> 8) & 255
  out[4] = seq & 255
  out.set(payload, 5)
  return out
}

/** Mensaje del relé: [BIN_VOICE][id u32][códec][marcas][nº][datos]; null si no es voz. */
export function unpackVoice(buf: ArrayBuffer): VoicePacket | null {
  const b = new Uint8Array(buf)
  if (b.length < 9 || b[0] !== BIN_VOICE) return null
  return {
    id: ((b[1] << 24) >>> 0) + (b[2] << 16) + (b[3] << 8) + b[4],
    codec: b[5],
    flags: b[6],
    seq: (b[7] << 8) | b[8],
    data: b.subarray(9),
  }
}

// --- μ-law (G.711) ------------------------------------------------------------

const BIAS = 0x84
const CLIP = 32635
const ULAW_DEC = new Float32Array(256)
for (let u = 0; u < 256; u++) {
  const v = ~u & 0xff
  const exp = (v >> 4) & 7
  const s = (((v & 0x0f) << 3) + BIAS) << exp
  ULAW_DEC[u] = ((v & 0x80 ? BIAS - s : s - BIAS) / 32768)
}

export function ulawEncode(x: Float32Array): Uint8Array {
  const out = new Uint8Array(x.length)
  for (let i = 0; i < x.length; i++) {
    let s = Math.round(Math.max(-1, Math.min(1, x[i])) * 32767)
    const sign = s < 0 ? 0x80 : 0
    if (sign) s = -s
    if (s > CLIP) s = CLIP
    s += BIAS
    let exp = 7
    for (let mask = 0x4000; (s & mask) === 0 && exp > 0; mask >>= 1) exp--
    out[i] = ~(sign | (exp << 4) | ((s >> (exp + 3)) & 0x0f)) & 0xff
  }
  return out
}

export function ulawDecode(b: Uint8Array): Float32Array {
  const out = new Float32Array(b.length)
  for (let i = 0; i < b.length; i++) out[i] = ULAW_DEC[b[i]]
  return out
}
