// Último paso de .github/workflows/release.yml (corre en GitHub, no en local):
// sube el instalador recién compilado a la release de la etiqueta, con nombre fijo
// (Autogiro-Setup.exe, para que .../releases/latest/download/Autogiro-Setup.exe sea un enlace
// permanente a la última versión), y el latest.json firmado que leen las apps instaladas
// (src-tauri/src/updates.rs).
//
// Variables: TAG (vX.Y.Z), GITHUB_REPOSITORY (dueño/repo), GH_TOKEN. Notas en release-notes.md.

import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const tag = process.env.TAG
const repo = process.env.GITHUB_REPOSITORY
if (tag !== `v${version}`) throw new Error(`La etiqueta ${tag} no coincide con la versión de package.json (${version})`)

const dir = 'src-tauri/target/release/bundle/nsis'
const built = `${dir}/Autogiro_${version}_x64-setup.exe`
if (!existsSync(built) || !existsSync(`${built}.sig`)) throw new Error(`No encuentro ${built} y su .sig`)

const exe = 'Autogiro-Setup.exe'
copyFileSync(built, exe)
const mb = (statSync(exe).size / 2 ** 20).toFixed(0)
const download = (name) => `https://github.com/${repo}/releases/download/${tag}/${name}`

const notes = existsSync('release-notes.md') ? readFileSync('release-notes.md', 'utf8').trim() : ''

writeFileSync(
  'latest.json',
  JSON.stringify(
    {
      version,
      notes,
      pub_date: new Date().toISOString(),
      platforms: { 'windows-x86_64': { signature: readFileSync(`${built}.sig`, 'utf8').trim(), url: download(exe) } },
    },
    null,
    2,
  ),
)

const body = `${notes || 'Mejoras y correcciones.'}

## Descargar · Download

### [⬇️ Autogiro para Windows · for Windows](${download(exe)})

Instalador de ${mb} MB para Windows 10 y 11, sin permisos de administrador. El juego está en español e inglés. Necesita Internet (el paisaje se descarga en directo) y va mejor con una tarjeta gráfica dedicada.

- **¿Ya lo tienes instalado?** Al abrir el juego te ofrecerá actualizarse solo.
- **La primera vez** Windows puede avisar con «Windows protegió su PC» porque el instalador no está firmado: pulsa *Más información → Ejecutar de todas formas*.
- **F11** pone la pantalla completa.

<details>
<summary><b>English</b></summary>

${mb} MB installer for Windows 10 and 11, no administrator rights needed. The game is in English and Spanish (the release notes above are in Spanish). It needs an Internet connection (the scenery is downloaded as you fly) and works best with a dedicated graphics card.

- **Already installed?** The game will offer to update itself when you open it.
- **The first time** Windows may show “Windows protected your PC” because the installer isn't signed: click *More info → Run anyway*.
- **F11** toggles full screen.

</details>

<sub>Hecho con ❤️ por [Mario](https://creativecode.es/) · [☕ Invítame a un café](https://ko-fi.com/mario_creativecode)</sub>
`
writeFileSync('release-body.md', body)

const gh = (...args) => execFileSync('gh', args, { stdio: 'inherit' })
let exists = true
try {
  execFileSync('gh', ['release', 'view', tag], { stdio: 'ignore' })
} catch {
  exists = false
}
if (exists) {
  // volver a lanzar el flujo sobre la misma etiqueta: se reemplazan los archivos
  gh('release', 'edit', tag, '--title', `Autogiro ${version}`, '--notes-file', 'release-body.md', '--latest')
  gh('release', 'upload', tag, exe, 'latest.json', '--clobber')
} else {
  gh('release', 'create', tag, exe, 'latest.json', '--title', `Autogiro ${version}`, '--notes-file', 'release-body.md', '--latest', '--verify-tag')
}
console.log(`Publicada: https://github.com/${repo}/releases/tag/${tag}`)
