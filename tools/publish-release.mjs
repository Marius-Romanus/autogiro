// Último paso de .github/workflows/release.yml (corre en GitHub, no en local):
// sube a la release de la etiqueta lo que han compilado los trabajos de Windows y Linux, con
// nombres fijos (Autogiro-Setup.exe, Autogiro-Linux.AppImage/.deb/.rpm, para que
// .../releases/latest/download/<nombre> sea un enlace permanente a la última versión), y el
// latest.json firmado que leen las apps instaladas (src-tauri/src/updates.rs).
//
//   node tools/publish-release.mjs <carpeta>   (la de actions/download-artifact: windows/, linux/)
//
// Variables: TAG (vX.Y.Z), GITHUB_REPOSITORY (dueño/repo), GH_TOKEN. Notas en release-notes.md.
// Sin el instalador de Windows no publica nada; sin los paquetes de Linux publica solo Windows.

import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { execFileSync } from 'node:child_process'

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const tag = process.env.TAG
const repo = process.env.GITHUB_REPOSITORY
if (tag !== `v${version}`) throw new Error(`La etiqueta ${tag} no coincide con la versión de package.json (${version})`)

const root = process.argv[2] ?? 'bundles'
const files = existsSync(root) ? readdirSync(root, { recursive: true }).map((f) => join(root, String(f))) : []

/** El paquete compilado (nombre de Tauri con la versión) y su firma, o null si no está. */
function built(name) {
  const file = files.find((f) => basename(f) === name)
  return file && existsSync(`${file}.sig`) ? file : null
}

/** [plataformas de latest.json, archivo compilado, nombre fijo en la release] */
const packages = [
  [['windows-x86_64'], built(`Autogiro_${version}_x64-setup.exe`), 'Autogiro-Setup.exe'],
  // el AppImage también es lo que reciben las instalaciones de Linux sin tipo conocido
  [['linux-x86_64', 'linux-x86_64-appimage'], built(`Autogiro_${version}_amd64.AppImage`), 'Autogiro-Linux.AppImage'],
  [['linux-x86_64-deb'], built(`Autogiro_${version}_amd64.deb`), 'Autogiro-Linux.deb'],
  [['linux-x86_64-rpm'], built(`Autogiro-${version}-1.x86_64.rpm`), 'Autogiro-Linux.rpm'],
]
for (const [, file, name] of packages) {
  if (!file && name.endsWith('.exe')) throw new Error(`No encuentro el instalador de Windows ni su .sig en ${root}`)
  if (!file) console.log(`::warning::No está ${name} (¿falló la compilación de Linux?): la release sale sin él`)
}
const ready = packages.filter(([, file]) => file)

const download = (name) => `https://github.com/${repo}/releases/download/${tag}/${name}`
const mb = {}
for (const [, file, name] of ready) {
  copyFileSync(file, name)
  mb[name] = (statSync(name).size / 2 ** 20).toFixed(0)
}

const notes = existsSync('release-notes.md') ? readFileSync('release-notes.md', 'utf8').trim() : ''

const platforms = {}
for (const [keys, file, name] of ready) {
  const entry = { signature: readFileSync(`${file}.sig`, 'utf8').trim(), url: download(name) }
  for (const k of keys) platforms[k] = entry
}
writeFileSync('latest.json', JSON.stringify({ version, notes, pub_date: new Date().toISOString(), platforms }, null, 2))

const exe = 'Autogiro-Setup.exe'
const appimage = 'Autogiro-Linux.AppImage'
const deb = 'Autogiro-Linux.deb'
const rpm = 'Autogiro-Linux.rpm'
const has = (name) => name in mb
const others = (es) =>
  [has(deb) && `[.deb](${download(deb)}) (Ubuntu, Debian, Mint…)`, has(rpm) && `[.rpm](${download(rpm)}) (Fedora, openSUSE…)`]
    .filter(Boolean)
    .join(es ? ' y ' : ' and ')

const linuxEs = !has(appimage)
  ? ''
  : `
### [🐧 Autogiro para Linux · for Linux](${download(appimage)})

AppImage de ${mb[appimage]} MB para cualquier Linux de 64 bits reciente (Ubuntu 22.04, Debian 12, Fedora 36 o más nuevos): descárgalo, dale permiso de ejecución (*clic derecho → Propiedades → Permitir ejecutar como programa*, o \`chmod +x ${appimage}\`) y ábrelo con doble clic. Se actualiza solo.${others(true) ? `\nTambién en paquete ${others(true)}, que piden tu contraseña al instalarse y al actualizarse.` : ''}
`
const linuxEn = !has(appimage)
  ? ''
  : `
**Linux:** a ${mb[appimage]} MB [AppImage](${download(appimage)}) for any recent 64-bit Linux (Ubuntu 22.04, Debian 12, Fedora 36 or newer): download it, make it executable (*right click → Properties → Allow executing as program*, or \`chmod +x ${appimage}\`) and double-click it. It updates itself.${others(false) ? ` Also available as ${others(false)} packages, which ask for your password when installing and updating.` : ''}
`

const body = `${notes || 'Mejoras y correcciones.'}

## Descargar · Download

### [⬇️ Autogiro para Windows · for Windows](${download(exe)})

Instalador de ${mb[exe]} MB para Windows 10 y 11, sin permisos de administrador. El juego está en español e inglés. Necesita Internet (el paisaje se descarga en directo) y va mejor con una tarjeta gráfica dedicada.

- **¿Ya lo tienes instalado?** Al abrir el juego te ofrecerá actualizarse solo.
- **La primera vez** Windows puede avisar con «Windows protegió su PC» porque el instalador no está firmado: pulsa *Más información → Ejecutar de todas formas*.
- **F11** pone la pantalla completa.
${linuxEs}
<details>
<summary><b>English</b></summary>

${mb[exe]} MB installer for Windows 10 and 11, no administrator rights needed. The game is in English and Spanish (the release notes above are in Spanish). It needs an Internet connection (the scenery is downloaded as you fly) and works best with a dedicated graphics card.

- **Already installed?** The game will offer to update itself when you open it.
- **The first time** Windows may show “Windows protected your PC” because the installer isn't signed: click *More info → Run anyway*.
- **F11** toggles full screen.
${linuxEn}
</details>

<sub>Hecho con ❤️ por [Mario](https://creativecode.es/) · [☕ Invítame a un café](https://ko-fi.com/mario_creativecode)</sub>
`
writeFileSync('release-body.md', body)

const assets = [...ready.map(([, , name]) => name), 'latest.json']
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
  gh('release', 'upload', tag, ...assets, '--clobber')
} else {
  gh('release', 'create', tag, ...assets, '--title', `Autogiro ${version}`, '--notes-file', 'release-body.md', '--latest', '--verify-tag')
}
console.log(`Publicada: https://github.com/${repo}/releases/tag/${tag}`)
