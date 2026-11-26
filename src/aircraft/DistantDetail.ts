// Piezas de un aparato lejano que no llegan a un píxel.
//
// Cada autogiro del tráfico aéreo (y cada piloto de una sala) es un modelo entero: unas 120
// llamadas de dibujo, casi cada pieza con su material. Aparcado a 600 m ocupa 30 píxeles, y cinco
// de ellos eran 630 dibujos y 4,8 ms de CPU por fotograma en Casarrubios (un 36 % del fotograma,
// medido con la telemetría). No hay forma de juntar esos dibujos sin tocar números: ninguna pieza
// comparte a la vez material y transformación con otra.
//
// A esa distancia dos de cada tres piezas (tornillos, interruptores, las gafas del piloto) miden
// menos de un píxel en pantalla: la esfera que las envuelve, que es lo que se mide aquí, no llega
// a cubrir uno. No aportan ningún detalle que se pueda ver; como mucho deciden a suertes el color de
// un píxel suelto. Este módulo deja de dibujarlas mientras midan menos de `minPx` y las devuelve
// según se acerca el aparato (de cerca no quita nada). Una pieza larga y fina (una varilla, una
// antena) no entra: su esfera es tan grande como su largo.
//
// No es idéntico píxel a píxel a dibujarlo todo: cambia algún píxel suelto dentro del aparato (entre
// 0 y 19 en todo el fotograma con cinco aparatos, medido). Mario lo vio comparado y lo aprobó el
// 26-11-2026; queda el interruptor (`distantDetail.enabled`) para medir o para volver atrás.

import { Sphere, type Mesh, type Object3D } from 'three'
import { LIGHT_LAYER } from '../render/Graphics.ts'
import { pixelScale } from '../world/powerMaterial.ts'
import type { AircraftView } from './AircraftView.ts'

/** `minPx`: diámetro en pantalla (píxeles) por debajo del cual una pieza no se dibuja. */
export const distantDetail = { enabled: true, minPx: 1 }

/** Capa que no mira ninguna cámara: ahí esperan las piezas que no se dibujan. */
const HIDDEN_LAYER = 20
const LIT = 1 << LIGHT_LAYER
const HIDDEN = 1 << HIDDEN_LAYER
/** más cerca de esto (m) no se quita nada, mida lo que mida */
const NEAR = 40
/** el aparato mide hasta esto del centro a la punta de una pala: la pieza más cercana a la cámara */
const REACH = 8

const _sphere = new Sphere()

export class DistantDetail {
  /** piezas opacas del modelo, de la más pequeña a la más grande (radio en metros) */
  private parts: { o: Object3D; r: number }[] = []
  /** las `hidden` primeras están sin dibujar */
  private hidden = 0
  private scene: Object3D | null = null
  private readonly view: AircraftView

  constructor(view: AircraftView) {
    this.view = view
  }

  /** Cada fotograma, con la distancia (m) de la cámara al aparato. */
  update(distance: number): void {
    const v = this.view
    if (!v.loaded) return
    const scene = v.model.children[0] ?? null
    if (scene !== this.scene) this.collect(scene)
    const parts = this.parts
    const on = distantDetail.enabled && distance > NEAR
    // radio de una pieza que mide `minPx` a esa distancia (pixelScale: radianes por píxel)
    const rMin = on ? (distantDetail.minPx * Math.max(0, distance - REACH) * pixelScale.value) / 2 : 0
    let k = this.hidden
    while (k < parts.length && parts[k].r < rMin) parts[k++].o.layers.mask = HIDDEN
    // (un 5 % de holgura al volver: que una pieza justo en el límite no entre y salga)
    while (k > 0 && parts[k - 1].r >= rMin * 1.05) parts[--k].o.layers.mask = LIT
    this.hidden = k
  }

  /** Piezas sin dibujar ahora mismo y cuántas hay (para medir). */
  get stats(): { hidden: number; parts: number } {
    return { hidden: this.hidden, parts: this.parts.length }
  }

  private collect(scene: Object3D | null): void {
    // (las de antes vuelven a su capa: el modelo ha cambiado)
    for (let i = 0; i < this.hidden; i++) this.parts[i].o.layers.mask = LIT
    this.hidden = 0
    this.parts = []
    this.scene = scene
    if (!scene) return
    const v = this.view
    v.root.updateMatrixWorld(true)
    // todo lo opaco del modelo (y lo que la cabina le cuelga); vidrios, discos y luces no se tocan
    v.model.traverse((o) => {
      const m = o as Mesh
      if (!m.isMesh || m.layers.mask !== LIT) return
      const g = m.geometry
      if (!g.boundingSphere) g.computeBoundingSphere()
      _sphere.copy(g.boundingSphere!).applyMatrix4(m.matrixWorld)
      if (Number.isFinite(_sphere.radius)) this.parts.push({ o: m, r: _sphere.radius })
    })
    this.parts.sort((a, b) => a.r - b.r)
  }
}
