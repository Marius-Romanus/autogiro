// Guía dentro del juego: jugar por Internet con amigos mediante un túnel de Cloudflare.
// Se abre desde la banda Multijugador del menú y adapta el texto a la dirección actual
// (localhost, red local, túnel trycloudflare.com u otra). Español e inglés (src/i18n.ts).

import { gpuHelpHtml } from '../hud/gpuHelp.ts'
import { getLang, onLangChange, t } from '../i18n.ts'
import { appCardHtml, appWhereText, desktopApp } from './appHelp.ts'

export type HostKind = 'local' | 'lan' | 'tunnel' | 'public'

/** ¿Desde dónde se está jugando? Decide si el enlace de la sala les sirve a otros. */
export function hostKind(h = location.hostname): HostKind {
  if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.localhost')) return 'local'
  if (h.endsWith('.trycloudflare.com')) return 'tunnel'
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(h) || h.endsWith('.local')) return 'lan'
  return 'public'
}

/** Puerto del servidor de partidas (npm run server) al que debe apuntar el túnel. */
function serverPort(): string {
  // si esta página ya la sirve el servidor de partidas, su puerto; si es Vite (desarrollo), el de por defecto
  return !import.meta.env.DEV && location.port ? location.port : '8080'
}

function whereText(kind: HostKind): { cls: string; html: string } {
  const en = getLang() === 'en'
  const host = location.host.replace(/[<>&"]/g, '')
  switch (kind) {
    case 'local':
      return import.meta.env.DEV
        ? {
            cls: 'warn',
            html: en
              ? 'You are on <b>localhost</b> with the development server: your friends cannot open this address. Follow the steps below.'
              : 'Ahora estás en <b>localhost</b> con el servidor de desarrollo: tus amigos no pueden abrir esta dirección. Sigue los pasos de abajo.',
          }
        : {
            cls: 'warn',
            html: en
              ? `The <b>game server</b> is already running (port ${serverPort()}), but <b>localhost</b> only exists on your computer. Steps 4 and 5 are still missing.`
              : `Ya tienes el <b>servidor de partidas</b> en marcha (puerto ${serverPort()}), pero <b>localhost</b> solo existe en tu ordenador. Te faltan los pasos 4 y 5.`,
          }
    case 'tunnel':
      return {
        cls: 'ok',
        html: en
          ? 'You are playing <b>through a Cloudflare tunnel</b>. Create a room and press <b>Copy link</b>: that link already works for your friends.'
          : 'Estás jugando <b>a través de un túnel de Cloudflare</b>. Crea una sala y pulsa <b>Copiar enlace</b>: ese enlace ya les vale a tus amigos.',
      }
    case 'lan':
      return {
        cls: 'info',
        html: en
          ? 'You are on a <b>local network</b> address: it works for friends on the same wifi. For friends at home, use the tunnel.'
          : 'Estás en una dirección de tu <b>red local</b>: vale para amigos conectados a la misma wifi. Para amigos en su casa, usa el túnel.',
      }
    default:
      return {
        cls: 'info',
        html: en
          ? `You are on <b>${host}</b>. If your friends can open this address, just create a room and send them the link.`
          : `Estás en <b>${host}</b>. Si tus amigos pueden abrir esta dirección, solo tienes que crear una sala y pasarles el enlace.`,
      }
  }
}

function cmd(text: string): string {
  return `<div class="mp-cmd"><code>${text}</code><button type="button" data-copy="${text}">${t('mp.copy')}</button></div>`
}

function cardHtml(port: string): string {
  if (getLang() === 'en')
    return `
    <div class="card mp-online">
      <button type="button" class="close" aria-label="${t('common.close')}">×</button>
      <div class="eyebrow">Multiplayer</div>
      <h2 id="mp-online-title">Play over the Internet with friends</h2>
      <p class="mp-where"></p>
      <p>For friends to join from their homes, your computer has to be reachable from the Internet.
      The easiest way is a <b>Cloudflare tunnel</b>: free, no account and no router changes.
      Only the person sharing does this; everyone else just needs the link.</p>
      <ol class="mp-steps">
        <li><b>Install cloudflared</b> (first time only). In PowerShell:${cmd('winget install --id Cloudflare.cloudflared')}
          <small>Close and reopen PowerShell after installing it.</small></li>
        <li><b>Build the game</b> in the project folder:${cmd('npm run build')}</li>
        <li><b>Start the game server</b> and leave that window open:${cmd('npm run server')}
          <small>It serves the game and the rooms at <code>http://localhost:8080</code>.</small></li>
        <li><b>Open the tunnel</b> in another PowerShell window:${cmd(`cloudflared tunnel --url http://localhost:${port}`)}
          <small>After a few seconds it shows, inside a box, an address like
          <code>https://…trycloudflare.com</code>.</small></li>
        <li><b>Open that address</b> in your browser (you too), create a room and press
          <b>Copy link</b>. Send it to your friends: it takes them straight into your room.</li>
      </ol>
      <h3>Good to know</h3>
      <ul class="mp-notes">
        <li>The tunnel address <b>changes every time</b> you open it. Your computer has to stay on
          with both windows open; to finish, press <kbd>Ctrl</kbd>+<kbd>C</kbd> in each one.</li>
        <li>Your friends <b>install nothing</b>: Chrome or Edge on a computer with decent graphics.
          On a laptop with two GPUs the browser often starts on the integrated one (Intel) and stutters:
          the game menu warns them and explains how to switch.
          <details><summary>${t('gpu.howto')}</summary>${gpuHelpHtml()}</details></li>
        <li><b>Google key:</b> everyone enters their own in the menu and it is stored only in their browser. If
          you restricted yours to localhost, add <code>https://*.trycloudflare.com/*</code> to the allowed
          sites, or fly with “Orthophoto + terrain”, which needs no key.</li>
        <li>Don't put your key in <code>.env.local</code> to share it: that key is only used with
          <code>npm run dev</code> and is never included in the built game.</li>
        <li>It uses little bandwidth: your friends download the game once (a few MB) and in flight it is about
          4 KB/s per pilot. Everyone downloads the scenery directly from IGN or Google.</li>
        <li>Don't use <code>npm run dev</code> with the tunnel: Vite rejects outside addresses and would
          expose the source code.</li>
        <li>On the <b>same wifi</b> you don't need a tunnel: start with <code>npm run dev:lan</code> and send them
          the network address Vite prints.</li>
      </ul>
      <div class="row"><button type="button" class="primary mp-online-ok">Got it</button></div>
    </div>`
  return `
    <div class="card mp-online">
      <button type="button" class="close" aria-label="${t('common.close')}">×</button>
      <div class="eyebrow">Multijugador</div>
      <h2 id="mp-online-title">Jugar por Internet con amigos</h2>
      <p class="mp-where"></p>
      <p>Para que tus amigos entren desde su casa, tu ordenador tiene que verse desde Internet.
      Lo más fácil es un <b>túnel de Cloudflare</b>: gratis, sin cuenta y sin tocar el router.
      Lo hace solo quien comparte; los demás solo necesitan el enlace.</p>
      <ol class="mp-steps">
        <li><b>Instala cloudflared</b> (solo la primera vez). En PowerShell:${cmd('winget install --id Cloudflare.cloudflared')}
          <small>Cierra y vuelve a abrir PowerShell después de instalarlo.</small></li>
        <li><b>Compila el juego</b> en la carpeta del proyecto:${cmd('npm run build')}</li>
        <li><b>Arranca el servidor de partidas</b> y deja esa ventana abierta:${cmd('npm run server')}
          <small>Sirve el juego y las salas en <code>http://localhost:8080</code>.</small></li>
        <li><b>Abre el túnel</b> en otra ventana de PowerShell:${cmd(`cloudflared tunnel --url http://localhost:${port}`)}
          <small>A los pocos segundos muestra, dentro de un recuadro, una dirección
          <code>https://…trycloudflare.com</code>.</small></li>
        <li><b>Abre esa dirección</b> en tu navegador (tú también), crea una sala y pulsa
          <b>Copiar enlace</b>. Pásaselo a tus amigos: entran directamente en tu sala.</li>
      </ol>
      <h3>Conviene saber</h3>
      <ul class="mp-notes">
        <li>La dirección del túnel <b>cambia cada vez</b> que lo abres. Tu ordenador tiene que seguir
          encendido con las dos ventanas abiertas; para terminar, <kbd>Ctrl</kbd>+<kbd>C</kbd> en cada una.</li>
        <li>Tus amigos <b>no instalan nada</b>: Chrome o Edge en un ordenador con una gráfica decente.
          Si tienen un portátil con dos gráficas, el navegador suele arrancar con la integrada (Intel) y va
          a tirones: el menú del juego les avisa y les explica cómo cambiarlo.
          <details><summary>${t('gpu.howto')}</summary>${gpuHelpHtml()}</details></li>
        <li><b>Clave de Google:</b> cada uno pone la suya en el menú y se guarda solo en su navegador. Si
          restringiste la tuya a localhost, añade <code>https://*.trycloudflare.com/*</code> a los sitios
          permitidos, o volad en «Ortofoto + relieve», que no necesita clave.</li>
        <li>No pongas tu clave en <code>.env.local</code> para compartir: esa clave solo se usa con
          <code>npm run dev</code> y nunca se incluye en el juego compilado.</li>
        <li>Gasta poco: tus amigos descargan el juego una vez (unos MB) y en vuelo son unos 4 KB/s por
          piloto. El paisaje lo descarga cada uno directamente del IGN o de Google.</li>
        <li>No uses <code>npm run dev</code> con el túnel: Vite rechaza las direcciones de fuera y dejaría
          ver el código fuente.</li>
        <li>En la <b>misma wifi</b> no hace falta túnel: arranca con <code>npm run dev:lan</code> y pásales
          la dirección de red que muestra Vite.</li>
      </ul>
      <div class="row"><button type="button" class="primary mp-online-ok">Entendido</button></div>
    </div>`
}

export interface OnlineHelp {
  open(): void
  close(): void
  readonly isOpen: boolean
}

/** Crea la ventana de ayuda. `copy` copia al portapapeles y avisa. */
export function createOnlineHelp(copy: (text: string, ok: string) => void): OnlineHelp {
  const port = serverPort()
  const overlay = document.createElement('div')
  overlay.id = 'mp-online'
  overlay.className = 'overlay mp-online-overlay hidden'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-labelledby', 'mp-online-title')
  document.body.appendChild(overlay)

  const close = () => overlay.classList.add('hidden')
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close()
  })

  /** (Re)dibuja la tarjeta en el idioma actual. */
  const render = () => {
    const app = desktopApp() // dentro de la app de escritorio: guía sin npm
    overlay.innerHTML = app ? appCardHtml(app) : cardHtml(port)
    overlay.querySelector('.close')!.addEventListener('click', close)
    overlay.querySelector('.mp-online-ok')!.addEventListener('click', close)
    for (const b of overlay.querySelectorAll<HTMLButtonElement>('[data-copy]'))
      b.addEventListener('click', () => copy(b.dataset.copy!, t('mp.cmdCopied')))
    const where = overlay.querySelector<HTMLElement>('.mp-where')!
    const w = app ? appWhereText(app) : whereText(hostKind())
    where.className = `mp-where ${w.cls}`
    where.innerHTML = w.html
  }
  render()
  onLangChange(render)

  // Esc cierra solo esta ventana (sin cerrar el menú que hay debajo)
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || overlay.classList.contains('hidden')) return
      e.preventDefault()
      e.stopImmediatePropagation()
      close()
    },
    true,
  )

  return {
    open() {
      render()
      overlay.classList.remove('hidden')
      overlay.scrollTop = 0
      overlay.querySelector<HTMLButtonElement>('.close')!.focus({ preventScroll: true })
    },
    close,
    get isOpen() {
      return !overlay.classList.contains('hidden')
    },
  }
}
