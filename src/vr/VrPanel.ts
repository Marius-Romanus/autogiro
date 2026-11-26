// Tablilla de avisos de la realidad virtual. En el visor no se ve nada del HTML (avisos, guía de
// pilotaje, ficha de la escuela, tarjeta del accidente), así que lo imprescindible se pinta en un
// lienzo y se cuelga en la cabina, abajo a la izquierda, como una tablilla de rodilla: se lee con
// un vistazo y no tapa ni el frente ni los relojes. Los instrumentos son los de la cabina 3D.
//
// Es una malla opaca que escribe alfa 0 ("ya iluminada", como las luces del aparato: la atmósfera
// no la vuelve a iluminar) y profundidad (a medio metro no le cae bruma ni nubes encima), con el
// brillo en unidades ya expuestas. Se dibuja siempre, aunque el fuselaje la cruce en alguna cabina
// cerrada: más vale verla entera que cortada.

import {
  AlwaysDepth,
  CanvasTexture,
  Color,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Vector3,
  type Matrix4,
  type Object3D,
} from 'three'
import { OVERLAY_LAYER } from '../render/Graphics.ts'

/** Lo que enseña la tablilla, de arriba abajo. */
export interface PanelContent {
  /** alarmas (rojo) y precauciones (ámbar) del aparato */
  warnings: string[]
  cautions: string[]
  /** indicación breve para el piloto */
  hint: string
  /** radio: quién habla o que se está emitiendo ('' = silencio) */
  radio: string
  /** aviso de texto pasajero */
  toast: string
  /** bloques con título: accidente, ficha de la escuela, guía de pilotaje */
  blocks: { title: string; lines: string[] }[]
  /** pie fijo (teclas útiles con el visor puesto) */
  foot: string
}

const W = 768
const H = 1024
/** tamaño real de la tablilla (m) */
const WIDTH = 0.27
const HEIGHT = (WIDTH * H) / W
const FONT = '"Barlow Condensed", Barlow, system-ui, sans-serif'
const INK = '#f2f1ec'
const DIM = '#a9adb3'
const YELLOW = '#f6c400'
const RED = '#e5484d'
const BG = '#14171c'

const _p = new Vector3()
const _eye = new Vector3()
const _up = new Vector3()

export class VrPanel {
  readonly mesh: Mesh
  /** encendida (tecla I con el visor puesto) */
  enabled = true
  private readonly canvas = document.createElement('canvas')
  private readonly ctx: CanvasRenderingContext2D
  private readonly tex: CanvasTexture
  private readonly mat: MeshBasicMaterial
  private key = ''
  private used = 0
  private readonly tint = new Color()

  constructor() {
    this.canvas.width = W
    this.canvas.height = H
    this.ctx = this.canvas.getContext('2d')!
    this.tex = new CanvasTexture(this.canvas)
    this.tex.colorSpace = SRGBColorSpace
    this.tex.minFilter = LinearMipmapLinearFilter
    this.tex.magFilter = LinearFilter
    this.tex.anisotropy = 8
    this.mat = new MeshBasicMaterial({ map: this.tex, toneMapped: false, fog: false })
    // alfa 0: máscara de iluminación (Graphics.ts)
    this.mat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace('#include <dithering_fragment>', '#include <dithering_fragment>\n\tgl_FragColor.a = 0.0;')
    }
    this.mat.customProgramCacheKey = () => 'vr-panel-alpha0'
    // siempre a la vista y con su profundidad (ver arriba)
    this.mat.depthFunc = AlwaysDepth
    const geo = new PlaneGeometry(WIDTH, HEIGHT)
    // (anclada por arriba: crece hacia abajo según lo que haya que decir)
    geo.translate(0, -HEIGHT / 2, 0)
    this.mesh = new Mesh(geo, this.mat)
    this.mesh.layers.set(OVERLAY_LAYER)
    this.mesh.renderOrder = 40
    this.mesh.frustumCulled = false
    this.mesh.visible = false
    this.mesh.matrixAutoUpdate = true
  }

  attach(parent: Object3D): void {
    parent.add(this.mesh)
  }

  detach(): void {
    this.mesh.removeFromParent()
    this.mesh.visible = false
  }

  /**
   * Coloca la tablilla en la cabina (`frame`: asiento → mundo, con los ejes de una cámara) y la
   * repinta si cambió el texto. `exposure`: exposición del render, para que brille siempre igual.
   */
  update(frame: Matrix4, content: PanelContent | null, exposure: number): void {
    const show = this.enabled && content !== null && this.draw(content)
    this.mesh.visible = show
    if (!show) return
    // abajo a la izquierda, a medio metro, mirando a los ojos
    _eye.set(0, 0, 0).applyMatrix4(frame)
    _p.set(-0.33, -0.1, -0.46).applyMatrix4(frame)
    _up.set(0, 1, 0).transformDirection(frame)
    this.mesh.position.copy(_p)
    this.mesh.up.copy(_up)
    this.mesh.lookAt(_eye)
    // recortada a lo escrito
    const f = this.used / H
    this.mesh.scale.set(1, f, 1)
    this.tex.repeat.set(1, f)
    this.tex.offset.set(0, 1 - f)
    // unidades ya expuestas (como las luces del aparato): el tono no depende de la hora
    this.mat.color.copy(this.tint.setScalar(0.62 / Math.max(exposure, 1e-3)))
  }

  /** Pinta el contenido; false si no hay nada que enseñar. */
  private draw(c: PanelContent): boolean {
    const key = JSON.stringify(c)
    if (key === this.key) return this.used > 0
    this.key = key
    const any = c.warnings.length || c.cautions.length || c.hint || c.radio || c.toast || c.blocks.length
    if (!any) {
      this.used = 0
      return false
    }
    const g = this.ctx
    g.fillStyle = BG
    g.fillRect(0, 0, W, H)
    const pad = 28
    let y = 0
    const room = (h: number): boolean => y + h <= H - 46
    const bar = (text: string, bg: string, ink: string): void => {
      if (!room(58)) return
      g.fillStyle = bg
      g.fillRect(0, y, W, 54)
      g.fillStyle = ink
      g.font = `700 36px ${FONT}`
      g.textBaseline = 'middle'
      g.fillText(fit(g, text.toUpperCase(), W - 2 * pad), pad, y + 28)
      y += 58
    }
    for (const w of c.warnings) bar(w, RED, '#fff')
    for (const w of c.cautions) bar(w, YELLOW, '#14171c')
    y += y ? 10 : 22
    g.textBaseline = 'alphabetic'
    const text = (s: string, size: number, weight: number, color: string, indent = 0): void => {
      g.font = `${weight} ${size}px ${FONT}`
      g.fillStyle = color
      const lh = Math.round(size * 1.22)
      for (const line of wrap(g, s, W - 2 * pad - indent)) {
        if (!room(lh)) return
        y += lh
        g.fillText(line, pad + indent, y - Math.round(size * 0.28))
      }
    }
    if (c.radio) {
      text(c.radio, 34, 700, YELLOW)
      y += 10
    }
    if (c.hint) {
      text(c.hint, 34, 600, INK)
      y += 10
    }
    if (c.toast) {
      text(c.toast, 34, 600, INK)
      y += 10
    }
    for (const b of c.blocks) {
      if (!room(80)) break
      if (y > 30) {
        g.fillStyle = '#3a3f47'
        g.fillRect(pad, y + 4, W - 2 * pad, 2)
        y += 16
      }
      if (b.title) {
        text(b.title.toUpperCase(), 32, 700, YELLOW)
        y += 4
      }
      for (const l of b.lines) {
        text(l, 29, 500, INK)
        y += 6
      }
    }
    if (c.foot && y + 40 <= H) {
      y += 8
      g.font = `500 24px ${FONT}`
      g.fillStyle = DIM
      y += 30
      g.fillText(fit(g, c.foot, W - 2 * pad), pad, y - 8)
    }
    this.used = Math.min(H, y + 18)
    this.tex.needsUpdate = true
    return true
  }

  dispose(): void {
    this.detach()
    this.tex.dispose()
    this.mat.dispose()
    this.mesh.geometry.dispose()
  }
}

/** Parte un texto en renglones que quepan en `max` píxeles. */
function wrap(g: CanvasRenderingContext2D, s: string, max: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of s.split(/\s+/)) {
    if (!word) continue
    const next = line ? `${line} ${word}` : word
    if (line && g.measureText(next).width > max) {
      out.push(line)
      line = word
    } else line = next
  }
  if (line) out.push(line)
  return out
}

function fit(g: CanvasRenderingContext2D, s: string, max: number): string {
  if (g.measureText(s).width <= max) return s
  let t = s
  while (t.length > 1 && g.measureText(`${t}…`).width > max) t = t.slice(0, -1)
  return `${t}…`
}

/**
 * Texto de un elemento de la página, por bloques: el primer título (h1–h4) y un renglón por
 * párrafo, elemento de lista o fila. Sin botones. Vacío si el elemento no se está viendo.
 */
export function domBlock(el: HTMLElement | null, maxLines = 9): { title: string; lines: string[] } | null {
  if (!el || el.classList.contains('hidden') || el.getClientRects().length === 0) return null
  let title = ''
  const lines: string[] = []
  let cur = ''
  const flush = (): void => {
    const s = cur.replace(/\s+/g, ' ').trim()
    cur = ''
    if (s) lines.push(s)
  }
  const walk = (n: Node): void => {
    if (n.nodeType === Node.TEXT_NODE) {
      cur += n.textContent ?? ''
      return
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return
    const e = n as HTMLElement
    const tag = e.tagName
    if (tag === 'BUTTON' || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'SVG' || tag === 'CANVAS' || e.classList.contains('hidden')) return
    if (/^H[1-4]$/.test(tag)) {
      flush()
      const s = (e.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (!title) title = s
      else if (s) lines.push(s)
      return
    }
    const block = tag === 'P' || tag === 'LI' || tag === 'DIV' || tag === 'TR' || tag === 'OL' || tag === 'UL' || tag === 'BR' || tag === 'SMALL'
    if (block) flush()
    for (const c of e.childNodes) walk(c)
    if (tag === 'TD' || tag === 'TH') cur += '  '
    if (block) flush()
  }
  walk(el)
  flush()
  if (!title && !lines.length) return null
  if (lines.length > maxLines) lines.length = maxLines
  return { title, lines }
}
