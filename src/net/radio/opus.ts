// Radio de voz: Opus por WebCodecs (Chrome y WebView2 lo tienen; WebKitGTK según versión).
// Aparte de codec.ts porque usa tipos del navegador (codec.ts también lo usa tools/mp-bot.ts en Node).

import { FRAME_US, RATE } from './codec.ts'

export const OPUS_ENC = {
  codec: 'opus',
  sampleRate: RATE,
  numberOfChannels: 1,
  bitrate: 16000,
  opus: { frameDuration: FRAME_US, application: 'voip' },
} as AudioEncoderConfig
export const OPUS_DEC: AudioDecoderConfig = { codec: 'opus', sampleRate: RATE, numberOfChannels: 1 }

/** ¿Sabe este navegador codificar / descodificar Opus? (Chrome y WebView2 sí; WebKitGTK, según versión) */
export async function opusSupport(): Promise<{ enc: boolean; dec: boolean }> {
  const out = { enc: false, dec: false }
  try {
    if (typeof AudioEncoder !== 'undefined') out.enc = (await AudioEncoder.isConfigSupported(OPUS_ENC)).supported === true
  } catch {
    /* sin WebCodecs */
  }
  try {
    if (typeof AudioDecoder !== 'undefined') out.dec = (await AudioDecoder.isConfigSupported(OPUS_DEC)).supported === true
  } catch {
    /* sin WebCodecs */
  }
  return out
}
