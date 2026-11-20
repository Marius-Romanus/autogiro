// Publica una versión nueva en GitHub con una sola orden:
//
//   npm run release -- "Nuevo aparato: Magni M16" "Arreglado el escalón de la pista en LEMT"
//   npm run release -- --minor "…"        (0.3.7 → 0.4.0; --major → 1.0.0; por defecto 0.3.7 → 0.3.8)
//   npm run release -- --version 1.2.0 "…"
//
// Cada texto es una línea de las novedades (salen en la página de la release y en el aviso de
// actualización de la app). Comprueba que el proyecto compila, sube la versión en package.json y
// en src-tauri, hace el commit con todo lo pendiente, crea la etiqueta vX.Y.Z y la sube a GitHub.
// Desde ahí .github/workflows/release.yml compila el instalador y publica la release (~10-15 min).

import { execFileSync, execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
let bump = 'patch'
let explicit = null
const lines = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--minor' || a === '--major' || a === '--patch') bump = a.slice(2)
  else if (a === '--version') explicit = args[++i]
  else lines.push(a.trim())
}

const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim()
const run = (cmd) => execSync(cmd, { stdio: 'inherit' })

// --- comprobaciones previas -------------------------------------------------
const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
const remote = git('remote', 'get-url', 'origin')
const repo = remote.replace(/^.*github\.com[/:]/, '').replace(/\.git$/, '')

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const [ma, mi, pa] = pkg.version.split('.').map(Number)
const next =
  explicit ?? (bump === 'major' ? `${ma + 1}.0.0` : bump === 'minor' ? `${ma}.${mi + 1}.0` : `${ma}.${mi}.${pa + 1}`)
if (!/^\d+\.\d+\.\d+$/.test(next)) throw new Error(`Versión no válida: ${next}`)
const tag = `v${next}`
if (git('tag', '-l', tag)) throw new Error(`La etiqueta ${tag} ya existe`)

console.log(`\n→ Autogiro ${pkg.version} → ${next}  (${repo}, rama ${branch})\n`)
run('npm run typecheck')
run('npm run mp-test')

// --- versión ---------------------------------------------------------------
pkg.version = next
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
lock.version = next
if (lock.packages?.['']) lock.packages[''].version = next
writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + '\n')

const cargo = readFileSync('src-tauri/Cargo.toml', 'utf8')
writeFileSync('src-tauri/Cargo.toml', cargo.replace(/^version = "[^"]*"/m, `version = "${next}"`))
const cargoLock = readFileSync('src-tauri/Cargo.lock', 'utf8')
writeFileSync(
  'src-tauri/Cargo.lock',
  cargoLock.replace(/(name = "autogiro"\r?\nversion = )"[^"]*"/, `$1"${next}"`),
)

// --- commit, etiqueta y subida --------------------------------------------------
const notes = (lines.length ? lines : ['Mejoras y correcciones.']).map((l) => (/^[-*] /.test(l) ? l : `- ${l}`)).join('\n')
git('add', '-A')
git('commit', '-m', `Autogiro ${next}\n\n${notes}`)
git('tag', '-a', tag, '-m', notes)
run(`git push origin ${branch} ${tag}`)

console.log(`
✔ Subida la versión ${next}. GitHub está compilando el instalador (unos 10-15 min):
  https://github.com/${repo}/actions
  Cuando acabe estará aquí: https://github.com/${repo}/releases/tag/${tag}
`)
