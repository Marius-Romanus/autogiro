// Aviso cuando algo corta los datos del mapa (src/net/netWatch.ts).
//
// El juego tira de varios servicios públicos: OpenFreeMap (edificios, agua, árboles, puentes),
// Esri y el PNOA (la foto del terreno), el MDT del IGN y el relieve mundial de AWS, OpenInfraMap
// (tendidos)… En el navegador, un bloqueador de anuncios o de rastreo puede cortar alguno sin que
// el jugador lo sepa: el 2026-11-24 la lista EasyPrivacy (Adblock Plus, AdBlock, uBlock Origin…)
// añadió `||tiles.openfreemap.org/planet`, un falso positivo, y el juego se quedó sin edificios,
// con el mar como tierra firme y árboles en el agua (easylist/easylist#26522).
//
// Se envuelve `fetch` (todas las descargas del hilo principal, también las de 3d-tiles-renderer)
// y se mira cada servicio por separado. Una petición que corta una extensión falla al instante,
// sin salir a la red; un corte de red de verdad tarda en fallar. Si un servicio acumula varios
// fallos así seguidos sin ninguna descarga buena, se avisa con un panel fijo que dice qué no
// carga y qué se pierde. En cuanto vuelve a cargar algo de ese servicio, sale de la lista.
//
// La app de escritorio no tiene extensiones; ahí el mismo aviso habla de la conexión, el
// cortafuegos, el antivirus o un filtro de DNS.

import { onLangChange, t } from '../i18n.ts'
import { desktopApp } from './appHelp.ts'
import './netWatch.css'

/** Servicio de cada servidor vigilado (lo demás, incluido el propio servidor del juego, no se mira). */
const HOSTS: Record<string, string> = {
  'tiles.openfreemap.org': 'ofm',
  'server.arcgisonline.com': 'esri',
  'www.ign.es': 'pnoa',
  'qm-mdt.idee.es': 'mdt',
  's3.amazonaws.com': 'terrarium',
  'openinframap.org': 'power',
  'api.open-meteo.com': 'meteo',
  'nominatim.openstreetmap.org': 'search',
  'tile.googleapis.com': 'google',
}

/** Un fallo antes de esto (ms) no ha llegado a la red: lo ha cortado el propio navegador. */
const INSTANT_MS = 300
/** Fallos instantáneos seguidos (sin ninguna descarga buena entre medias) para avisar. */
const STRIKES = 3

interface Watch {
  strikes: number
  reported: boolean
}

const watch = new Map<string, Watch>()
let panel: HTMLElement | null = null
/** servicios que había al cerrar el aviso: no vuelve a salir hasta que se sume otro */
let dismissed = new Set<string>()

function serviceOf(input: RequestInfo | URL): string | null {
  try {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.startsWith('http')) return null
    return HOSTS[new URL(url).hostname] ?? null
  } catch {
    return null
  }
}

function stateOf(svc: string): Watch {
  let w = watch.get(svc)
  if (!w) watch.set(svc, (w = { strikes: 0, reported: false }))
  return w
}

function succeeded(svc: string): void {
  const w = stateOf(svc)
  w.strikes = 0
  if (w.reported) {
    w.reported = false
    render()
  }
}

function failed(svc: string, ms: number): void {
  const w = stateOf(svc)
  if (ms > INSTANT_MS || (typeof navigator !== 'undefined' && navigator.onLine === false)) return
  w.strikes++
  if (w.strikes < STRIKES || w.reported) return
  w.reported = true
  console.warn(`netWatch: el navegador corta las descargas de «${svc}» (¿un bloqueador de anuncios?)`)
  render()
}

/** Servicios que ahora mismo no cargan. */
export function blockedServices(): string[] {
  return [...watch].filter(([, w]) => w.reported).map(([k]) => k)
}

function render(): void {
  const list = blockedServices()
  if (list.length === 0) dismissed = new Set()
  if (!list.some((s) => !dismissed.has(s))) {
    panel?.classList.remove('show')
    return
  }
  if (!panel) {
    panel = document.createElement('div')
    panel.id = 'net-warning'
    panel.setAttribute('role', 'alert')
    document.body.appendChild(panel)
    panel.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('[data-close]')) return
      dismissed = new Set(blockedServices())
      panel!.classList.remove('show')
    })
  }
  const app = desktopApp() !== null
  const items = list.map((s) => `<li>${t(`net.svc.${s}`)}</li>`).join('')
  panel.innerHTML =
    `<div class="nw-head"><strong>${t(app ? 'net.title.app' : 'net.title.web')}</strong>` +
    `<button type="button" data-close aria-label="${t('net.close')}">×</button></div>` +
    `<p>${t('net.missing')}</p><ul>${items}</ul>` +
    `<p>${t(app ? 'net.fix.app' : 'net.fix.web')}</p>`
  panel.classList.add('show')
}

// --- envoltura de fetch (una vez, al importar el módulo: antes de que el mundo pida nada)
const g = globalThis as typeof globalThis & { __netWatch?: boolean }
if (!g.__netWatch && typeof fetch === 'function') {
  g.__netWatch = true
  const realFetch = fetch.bind(globalThis)
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const svc = serviceOf(input)
    if (!svc) return realFetch(input, init)
    const t0 = performance.now()
    return realFetch(input, init).then(
      (r) => {
        // (cualquier respuesta, también un 404 o una opaca: el servidor contestó)
        succeeded(svc)
        return r
      },
      (e: unknown) => {
        const aborted = (e as { name?: string })?.name === 'AbortError' || init?.signal?.aborted || (input instanceof Request && input.signal.aborted)
        if (!aborted) failed(svc, performance.now() - t0)
        throw e
      },
    )
  }
  onLangChange(() => {
    if (panel?.classList.contains('show')) render()
  })
}
