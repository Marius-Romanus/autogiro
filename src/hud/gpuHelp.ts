// Pasos para que el navegador use la gráfica dedicada (NVIDIA o AMD) en vez de la integrada.
// Se muestran en el menú (Gráficos y mandos) y en la guía de «Jugar por Internet», porque
// quien entra por un enlace no tiene el README.

import { getLang } from '../i18n.ts'

export const GPU_HELP_HTML = `
  <ol class="gpu-steps">
    <li><b>Enchufa el portátil</b> a la corriente: con batería muchos se quedan en la integrada.</li>
    <li><b>Windows 11:</b> <i>Configuración → Sistema → Pantalla → Gráficos</i>. Busca Chrome (o Edge) en
      la lista (si no está: <i>Agregar aplicación de escritorio</i> → <code>chrome.exe</code>), ábrelo y en
      <i>Preferencia de GPU</i> elige <b>Alto rendimiento</b>.<br />
      <b>Windows 10:</b> <i>Configuración → Sistema → Pantalla → Configuración de gráficos</i> → Examinar →
      <code>C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe</code> → Opciones → <b>Alto rendimiento</b>.</li>
    <li>Si sigue igual, fuérzalo también en el programa de la tarjeta:
      <b>NVIDIA</b>: <i>Panel de control de NVIDIA → Administrar configuración 3D → Configuración de programa</i> →
      Chrome → <i>Procesador NVIDIA de alto rendimiento</i>.
      <b>AMD</b>: <i>AMD Software: Adrenalin → Sistema/Gráficos → Gráficos intercambiables</i> → Chrome →
      <i>Alto rendimiento</i>.</li>
    <li><b>Cierra el navegador del todo</b> (también el icono junto al reloj) y vuelve a abrirlo.
      En <code>chrome://settings/system</code> (Edge: <code>edge://settings/system</code>) tiene que estar
      activado <i>Usar aceleración gráfica cuando esté disponible</i>.</li>
    <li>Comprueba en <code>chrome://gpu</code> (Edge: <code>edge://gpu</code>), en <i>GL_RENDERER</i>, que aparece
      la NVIDIA o la AMD. Este menú también dice qué gráfica está usando el juego.</li>
  </ol>`

const GPU_HELP_HTML_EN = `
  <ol class="gpu-steps">
    <li><b>Plug the laptop in</b>: on battery many of them stay on the integrated GPU.</li>
    <li><b>Windows 11:</b> <i>Settings → System → Display → Graphics</i>. Find Chrome (or Edge) in the
      list (if it isn't there: <i>Add desktop app</i> → <code>chrome.exe</code>), open it and under
      <i>GPU preference</i> choose <b>High performance</b>.<br />
      <b>Windows 10:</b> <i>Settings → System → Display → Graphics settings</i> → Browse →
      <code>C:\Program Files\Google\Chrome\Application\chrome.exe</code> → Options → <b>High performance</b>.</li>
    <li>If nothing changes, force it in the graphics card software too:
      <b>NVIDIA</b>: <i>NVIDIA Control Panel → Manage 3D settings → Program settings</i> →
      Chrome → <i>High-performance NVIDIA processor</i>.
      <b>AMD</b>: <i>AMD Software: Adrenalin → System/Graphics → Switchable Graphics</i> → Chrome →
      <i>High performance</i>.</li>
    <li><b>Close the browser completely</b> (including the icon next to the clock) and open it again.
      In <code>chrome://settings/system</code> (Edge: <code>edge://settings/system</code>)
      <i>Use graphics acceleration when available</i> must be on.</li>
    <li>Check in <code>chrome://gpu</code> (Edge: <code>edge://gpu</code>), under <i>GL_RENDERER</i>, that the
      NVIDIA or AMD card is listed. This menu also tells you which GPU the game is using.</li>
  </ol>`

/** Los pasos en el idioma de la interfaz. */
export function gpuHelpHtml(): string {
  return getLang() === 'en' ? GPU_HELP_HTML_EN : GPU_HELP_HTML
}
