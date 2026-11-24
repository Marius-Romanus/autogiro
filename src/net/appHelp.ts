// Guía «Jugar por Internet» cuando el juego corre dentro de la app de escritorio (src-tauri).
// La app ya lleva dentro el servidor de partidas (juego + salas en /mp) en un puerto local,
// así que sobran los pasos de `npm run build` / `npm run server` de onlineHelp.ts.
// Español e inglés, como el resto (src/i18n.ts).

import { gpuHelpHtml } from '../hud/gpuHelp.ts'
import { getLang, t } from '../i18n.ts'

/** Lo que inyecta la app (src-tauri/src/main.rs) antes de cargar la página. */
export interface DesktopApp {
  version: string
  /** puerto del servidor local (http://localhost:<port>) */
  port: number
  /** IP de este ordenador en la red local, si se sabe */
  lan: string | null
  /** sistema de la app: "windows" o "linux" (las versiones anteriores a Linux no lo mandan) */
  os?: string
}

/** Instalar cloudflared y abrir el túnel, en PowerShell (Windows) o en la terminal (Linux). */
function tunnelSteps(app: DesktopApp, en: boolean): { install: string; run: string; shell: string; window: string } {
  const url = `http://localhost:${app.port}`
  if (app.os === 'linux') {
    const bin = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64'
    return {
      install: `${en ? 'In a terminal' : 'En una terminal'}:${cmd(`curl -L -o cloudflared ${bin} && chmod +x cloudflared`)}
          <small>${en ? 'It downloads the program into the folder you are in.' : 'Descarga el programa en la carpeta en la que estés.'}</small>`,
      run: cmd(`./cloudflared tunnel --url ${url}`),
      shell: en ? 'the terminal' : 'la terminal',
      window: en ? 'the terminal window' : 'la ventana de la terminal',
    }
  }
  return {
    install: `${en ? 'In PowerShell' : 'En PowerShell'}:${cmd('winget install --id Cloudflare.cloudflared')}
          <small>${en ? 'Close and reopen PowerShell after installing it.' : 'Cierra y vuelve a abrir PowerShell después de instalarlo.'}</small>`,
    run: cmd(`cloudflared tunnel --url ${url}`),
    shell: 'PowerShell',
    window: en ? 'the PowerShell window' : 'la ventana de PowerShell',
  }
}

export function desktopApp(): DesktopApp | null {
  return (window as { __AUTOGIRO_APP__?: DesktopApp }).__AUTOGIRO_APP__ ?? null
}

function cmd(text: string): string {
  return `<div class="mp-cmd"><code>${text}</code><button type="button" data-copy="${text}">${t('mp.copy')}</button></div>`
}

export function appWhereText(app: DesktopApp): { cls: string; html: string } {
  return getLang() === 'en'
    ? {
        cls: 'info',
        html: `You are playing in the <b>Autogiro app</b>: it already runs the game server on your computer (port ${app.port}). Your friends only need one of the addresses below.`,
      }
    : {
        cls: 'info',
        html: `Estás jugando en la <b>app de Autogiro</b>: ya lleva en marcha el servidor de partidas en tu ordenador (puerto ${app.port}). Tus amigos solo necesitan una de las direcciones de abajo.`,
      }
}

export function appCardHtml(app: DesktopApp): string {
  const port = app.port
  const lanUrl = app.lan ? `http://${app.lan}:${port}` : ''
  const en = getLang() === 'en'
  const linux = app.os === 'linux'
  const tunnel = tunnelSteps(app, en)
  if (en)
    return `
    <div class="card mp-online">
      <button type="button" class="close" aria-label="${t('common.close')}">×</button>
      <div class="eyebrow">Multiplayer</div>
      <h2 id="mp-online-title">Play with friends</h2>
      <p class="mp-where"></p>
      <h3>Friends on the same wifi</h3>
      <p>No tunnel needed. Create a room and give them the code. They can join:</p>
      <ul class="mp-notes">
        <li><b>From Chrome or Edge</b>, installing nothing: ${lanUrl ? `they open ${cmd(lanUrl)}` : `they open <code>http://&lt;your-IP&gt;:${port}</code>`}</li>
        <li><b>From their own app</b>: in <i>Room server</i> they type ${lanUrl ? cmd(`${app.lan}:${port}`) : `<code>&lt;your-IP&gt;:${port}</code>`}</li>
      </ul>
      <p><small>${
        linux
          ? `If you have a firewall turned on (ufw, firewalld…), it has to let port ${port} in.`
          : 'If Windows asked about the firewall the first time you opened Autogiro, it has to be allowed on private networks.'
      }</small></p>
      <h3>Friends at their homes</h3>
      <p>Your computer has to be reachable from the Internet. The easiest way is a <b>Cloudflare tunnel</b>:
      free, no account and no router changes. Only you do this.</p>
      <ol class="mp-steps">
        <li><b>Install cloudflared</b> (first time only). ${tunnel.install}</li>
        <li><b>Open the tunnel</b> and leave that window open:${tunnel.run}
          <small>After a few seconds it shows, inside a box, an address like
          <code>https://…trycloudflare.com</code>.</small></li>
        <li><b>Create a room</b> here and send your friends that address with the code at the end:
          <code>https://…trycloudflare.com/?sala=CODE</code>. Opened in Chrome or Edge it takes them straight
          into your room. If they have the app, they paste the address in <i>Room server</i> and join with the code.</li>
      </ol>
      <h3>Good to know</h3>
      <ul class="mp-notes">
        <li>The tunnel address <b>changes every time</b> you open it. Keep the app and ${tunnel.window} open;
          to finish, press <kbd>Ctrl</kbd>+<kbd>C</kbd> in ${tunnel.shell}.</li>
        <li>Friends playing in the browser need a computer with decent graphics. On a laptop with two GPUs the
          browser often starts on the integrated one and stutters${linux ? '' : ' (the app always uses the dedicated one)'}.
          <details><summary>${t('gpu.howto')}</summary>${gpuHelpHtml()}</details></li>
        <li><b>Google key:</b> everyone enters their own in the menu. Or fly with “Orthophoto + terrain”, which needs no key.</li>
        <li>It uses little bandwidth: about 4 KB/s per pilot in flight. Everyone downloads the scenery directly from IGN or Google.</li>
      </ul>
      <div class="row"><button type="button" class="primary mp-online-ok">Got it</button></div>
    </div>`
  return `
    <div class="card mp-online">
      <button type="button" class="close" aria-label="${t('common.close')}">×</button>
      <div class="eyebrow">Multijugador</div>
      <h2 id="mp-online-title">Jugar con amigos</h2>
      <p class="mp-where"></p>
      <h3>Amigos en la misma wifi</h3>
      <p>No hace falta túnel. Crea una sala y pásales el código. Pueden entrar:</p>
      <ul class="mp-notes">
        <li><b>Desde Chrome o Edge</b>, sin instalar nada: abren ${lanUrl ? cmd(lanUrl) : `<code>http://&lt;tu-IP&gt;:${port}</code>`}</li>
        <li><b>Desde su propia app</b>: en <i>Servidor de salas</i> escriben ${lanUrl ? cmd(`${app.lan}:${port}`) : `<code>&lt;tu-IP&gt;:${port}</code>`}</li>
      </ul>
      <p><small>${
        linux
          ? `Si tienes el cortafuegos activado (ufw, firewalld…), tiene que dejar entrar el puerto ${port}.`
          : 'Si al abrir Autogiro la primera vez Windows preguntó por el firewall, tiene que estar permitido en redes privadas.'
      }</small></p>
      <h3>Amigos en su casa</h3>
      <p>Tu ordenador tiene que verse desde Internet. Lo más fácil es un <b>túnel de Cloudflare</b>: gratis,
      sin cuenta y sin tocar el router. Solo lo haces tú.</p>
      <ol class="mp-steps">
        <li><b>Instala cloudflared</b> (solo la primera vez). ${tunnel.install}</li>
        <li><b>Abre el túnel</b> y deja esa ventana abierta:${tunnel.run}
          <small>A los pocos segundos muestra, dentro de un recuadro, una dirección
          <code>https://…trycloudflare.com</code>.</small></li>
        <li><b>Crea una sala</b> aquí y pásales a tus amigos esa dirección con el código al final:
          <code>https://…trycloudflare.com/?sala=CÓDIGO</code>. Abierta en Chrome o Edge, entran directamente
          en tu sala. Si tienen la app, pegan la dirección en <i>Servidor de salas</i> y se unen con el código.</li>
      </ol>
      <h3>Conviene saber</h3>
      <ul class="mp-notes">
        <li>La dirección del túnel <b>cambia cada vez</b> que lo abres. Deja abiertas la app y
          ${tunnel.window}; para terminar, <kbd>Ctrl</kbd>+<kbd>C</kbd> en ${tunnel.shell}.</li>
        <li>Los que jueguen en el navegador necesitan un ordenador con una gráfica decente. En un portátil con dos
          gráficas el navegador suele arrancar con la integrada y va a tirones${linux ? '' : ' (la app usa siempre la dedicada)'}.
          <details><summary>${t('gpu.howto')}</summary>${gpuHelpHtml()}</details></li>
        <li><b>Clave de Google:</b> cada uno pone la suya en el menú. O volad en «Ortofoto + relieve», que no necesita clave.</li>
        <li>Gasta poco: unos 4 KB/s por piloto en vuelo. El paisaje lo descarga cada uno directamente del IGN o de Google.</li>
      </ul>
      <div class="row"><button type="button" class="primary mp-online-ok">Entendido</button></div>
    </div>`
}
