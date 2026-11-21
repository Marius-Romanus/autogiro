// Menú → Escenario → «Datos del Catastro descargados»: municipios guardados en este
// navegador (lo que ocupa cada uno) con un botón para borrarlos, y lo que se está bajando.

import { getLang, onLangChange, t } from '../../i18n.ts'
import { catastro, type MuniInfo, type MuniStatus } from './Catastro.ts'
import './catastro.css'

let munis: MuniInfo[] = []
let status: MuniStatus[] = []
let box: HTMLElement | null = null

export function setupCatastroMenu(): void {
  box = document.getElementById('catastro-list')
  const details = document.getElementById('catastro-data') as HTMLDetailsElement | null
  if (!box || !details) return
  // solo se consulta al abrirlo (o cuando cambia algo con él abierto)
  details.addEventListener('toggle', () => details.open && void refresh())
  catastro.onStored(() => details.open && void refresh())
  catastro.onStatus((q) => {
    status = q
    if (details.open) render()
  })
  onLangChange(() => details.open && render())
}

async function refresh(): Promise<void> {
  try {
    munis = await catastro.list()
  } catch {
    munis = []
  }
  render()
}

function render(): void {
  if (!box) return
  const esc = (s: string) => s.replace(/[<>&"]/g, '')
  const rows: string[] = []
  for (const s of status) {
    const pct = s.total ? ` ${Math.round(((s.loaded ?? 0) / s.total) * 100)} %` : ''
    const what = s.state === 'downloading' ? t('catastro.downloading') + pct : s.state === 'processing' ? t('catastro.processing') : s.state === 'error' ? t('catastro.error') : t('catastro.queued')
    rows.push(`<div class="cat-row busy"><span class="cat-name">${esc(s.name)}</span><span class="cat-size muted">${what}</span></div>`)
  }
  for (const m of munis) {
    rows.push(
      `<div class="cat-row"><span class="cat-name" title="${esc(m.code)} · ${m.parts.toLocaleString(getLang())} ${t('catastro.parts')}">${esc(m.name)}</span>` +
        `<span class="cat-size muted">${fmtBytes(m.bytes)}</span>` +
        `<button type="button" data-code="${esc(m.code)}" title="${t('catastro.deleteOne')}">${t('catastro.delete')}</button></div>`,
    )
  }
  if (rows.length === 0) rows.push(`<div class="cat-empty muted">${t('catastro.empty')}</div>`)
  const total = munis.reduce((a, m) => a + m.bytes, 0)
  if (munis.length > 0) {
    rows.push(
      `<div class="cat-foot"><span class="muted">${t('catastro.total', { n: munis.length, size: fmtBytes(total) })}</span>` +
        `<button type="button" data-code="*">${t('catastro.deleteAll')}</button></div>`,
    )
  }
  rows.push(`<small class="muted">${t('catastro.note')}</small>`)
  box.innerHTML = rows.join('')
  for (const b of box.querySelectorAll<HTMLButtonElement>('button[data-code]')) {
    b.addEventListener('click', async () => {
      const code = b.dataset.code === '*' ? null : b.dataset.code!
      b.disabled = true
      await catastro.remove(code)
      await refresh()
    })
  }
}

function fmtBytes(n: number): string {
  const loc = getLang()
  if (n >= 1048576) return `${(n / 1048576).toLocaleString(loc, { maximumFractionDigits: 1 })} MB`
  return `${Math.max(1, Math.round(n / 1024)).toLocaleString(loc)} kB`
}
