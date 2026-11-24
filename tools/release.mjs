// Publica una versión nueva en GitHub.
//
// Con preguntas (lo más fácil; es lo que hace el acceso directo «Publicar-version.cmd»):
//   npm run release
//
// Sin preguntas:
//   npm run release -- "Nuevo aparato: Magni M16" "Arreglado el escalón de la pista en LEMT"
//   npm run release -- --minor "…"        (0.3.7 → 0.4.0; --major → 1.0.0; por defecto 0.3.7 → 0.3.8)
//   npm run release -- --version 1.2.0 "…"
//   --dry-run: hace las preguntas y las comprobaciones, pero no cambia ni sube nada
//   --ask: hace las preguntas aunque no sea una consola (pruebas: node tools/release.mjs --ask --dry-run < respuestas.txt)
//
// Cada texto es una línea de las novedades (salen en la página de la release y en el aviso de
// actualización de la app). Comprueba que el proyecto compila, sube la versión en package.json y
// en src-tauri, hace el commit con todo lo pendiente, crea la etiqueta vX.Y.Z y la sube a GitHub.
// Desde ahí .github/workflows/release.yml compila el instalador de Windows y los paquetes de Linux
// y publica la release (~10-15 min).

import { execFileSync, execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'

const args = process.argv.slice(2)
let bump = null
let explicit = null
let dryRun = false
const lines = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--minor' || a === '--major' || a === '--patch') bump = a.slice(2)
  else if (a === '--version') explicit = args[++i]
  else if (a === '--dry-run') dryRun = true
  else if (a !== '--ask' && a.trim()) lines.push(a.trim())
}
// --ask: preguntar aunque la entrada no sea una consola (para probarlo)
const interactive = args.includes('--ask') || (!bump && !explicit && lines.length === 0 && process.stdin.isTTY)

/** Preguntas por consola: `ask(texto)` devuelve la respuesta (vale también con la entrada redirigida). */
function prompter() {
  const tty = Boolean(process.stdin.isTTY)
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: tty })
  const queue = []
  const waiting = []
  let closed = false
  rl.on('line', (l) => (waiting.length ? waiting.shift()(l) : queue.push(l)))
  rl.on('close', () => {
    closed = true
    while (waiting.length) waiting.shift()('')
  })
  const ask = (q) => {
    rl.setPrompt(q)
    rl.prompt()
    if (queue.length) {
      const l = queue.shift()
      if (!tty) process.stdout.write(`${l}\n`)
      return Promise.resolve(l.trim())
    }
    if (closed) return Promise.resolve('')
    return new Promise((r) => waiting.push((l) => r(l.trim())))
  }
  return { ask, close: () => rl.close() }
}

const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim()
const run = (cmd) => execSync(cmd, { stdio: 'inherit' })
const fail = (msg) => {
  console.error(`\n✘ ${msg}\n\nNo se ha publicado nada.`)
  process.exit(1)
}
// sin consola y sin decir nada no se publica a ciegas
if (!interactive && !bump && !explicit && lines.length === 0)
  fail('Sin consola hay que indicar las novedades o el tipo de versión (npm run release -- "novedad").')

// --- dónde estamos ----------------------------------------------------------
let branch, repo
try {
  branch = git('rev-parse', '--abbrev-ref', 'HEAD')
  repo = git('remote', 'get-url', 'origin').replace(/^.*github\.com[/:]/, '').replace(/\.git$/, '')
} catch {
  fail('Esta carpeta no está conectada a GitHub (git o el remoto «origin» no están).')
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const current = pkg.version
const [ma, mi, pa] = current.split('.').map(Number)
const options = { patch: `${ma}.${mi}.${pa + 1}`, minor: `${ma}.${mi + 1}.0`, major: `${ma + 1}.0.0` }
const lastTag = git('tag', '-l', 'v*', '--sort=-v:refname').split('\n')[0] || ''

// --- preguntas ----------------------------------------------------------------
if (interactive) {
  const rl = prompter()
  const ask = rl.ask

  console.log('\n  ✈  Publicar una versión nueva de Autogiro\n')
  const lastDate = lastTag ? git('log', '-1', '--format=%cd', '--date=format:%d/%m/%Y', lastTag) : ''
  console.log(`  Versión actual: ${current}${lastDate ? `  (publicada el ${lastDate})` : ''}`)

  const pending = git('status', '--porcelain').split('\n').filter(Boolean).length
  const commits = lastTag ? Number(git('rev-list', '--count', `${lastTag}..HEAD`)) : 1
  if (!pending && !commits) {
    console.log(`\n  ⚠  No hay ningún cambio desde la versión ${current}.`)
    if (!/^s/i.test(await ask('  ¿Publicar igualmente? (s/n): '))) {
      rl.close()
      fail('Cancelado.')
    }
  } else {
    console.log(`  Cambios desde entonces: ${pending} archivo(s) sin guardar en git y ${commits} commit(s).`)
  }

  console.log(`
  ¿Qué tipo de versión es?
    1) Arreglo o mejora pequeña .......... ${current} → ${options.patch}   (lo normal)
    2) Novedades (aparato, lugar, modo…) .. ${current} → ${options.minor}
    3) Versión grande ..................... ${current} → ${options.major}
`)
  for (;;) {
    const c = (await ask('  Elige 1, 2 o 3 y pulsa Intro [1]: ')) || '1'
    bump = { 1: 'patch', 2: 'minor', 3: 'major' }[c]
    if (bump) break
    console.log('  Escribe solo 1, 2 o 3.')
  }

  console.log(`
  Escribe las novedades para los jugadores, una por línea (salen en GitHub y en el
  aviso de actualización). Cuando acabes, pulsa Intro en una línea vacía.
`)
  for (;;) {
    const l = await ask('   - ')
    if (!l) break
    lines.push(l)
  }

  const shown = lines.length ? lines : ['Mejoras y correcciones.']
  console.log(`\n  Resumen: versión ${options[bump]}\n${shown.map((l) => `     - ${l.replace(/^[-*] /, '')}`).join('\n')}\n`)
  const ok = /^s/i.test(await ask(`  ¿Publicar ahora${dryRun ? ' (prueba, no se sube nada)' : ''}? (s/n): `))
  rl.close()
  if (!ok) fail('Cancelado.')
}

const next = explicit ?? options[bump ?? 'patch']
if (!/^\d+\.\d+\.\d+$/.test(next)) fail(`Versión no válida: ${next}`)
const tag = `v${next}`
if (git('tag', '-l', tag)) fail(`La versión ${next} ya existe.`)

// --- comprobaciones (antes de tocar nada) -----------------------------------------
console.log(`\n→ Autogiro ${current} → ${next}  (${repo}, rama ${branch})`)
console.log('→ Comprobando que todo compila…\n')
try {
  run('npm run typecheck')
  run('npm run mp-test')
} catch {
  fail('Algo no compila o no pasa las pruebas (el error está justo encima). Pásaselo a Claude.')
}
if (dryRun) {
  console.log(`\n✔ Prueba terminada: todo compila y se publicaría la versión ${next}. No se ha cambiado nada.\n`)
  process.exit(0)
}

// --- versión ---------------------------------------------------------------
const files = ['package.json', 'package-lock.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']
const before = Object.fromEntries(files.map((f) => [f, readFileSync(f, 'utf8')]))

pkg.version = next
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')
const lock = JSON.parse(before['package-lock.json'])
lock.version = next
if (lock.packages?.['']) lock.packages[''].version = next
writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + '\n')
writeFileSync('src-tauri/Cargo.toml', before['src-tauri/Cargo.toml'].replace(/^version = "[^"]*"/m, `version = "${next}"`))
writeFileSync(
  'src-tauri/Cargo.lock',
  before['src-tauri/Cargo.lock'].replace(/(name = "autogiro"\r?\nversion = )"[^"]*"/, `$1"${next}"`),
)

// --- commit, etiqueta y subida --------------------------------------------------
const notes = (lines.length ? lines : ['Mejoras y correcciones.']).map((l) => (/^[-*] /.test(l) ? l : `- ${l}`)).join('\n')
let committed = false
try {
  git('add', '-A')
  if (git('status', '--porcelain')) {
    git('commit', '-m', `Autogiro ${next}\n\n${notes}`)
    committed = true
  }
  git('tag', '-a', tag, '-m', notes)
  console.log('\n→ Subiendo a GitHub…\n')
  run(`git push origin ${branch} ${tag}`)
} catch {
  // deshacer: que se pueda volver a intentar tal cual
  try {
    git('tag', '-d', tag)
  } catch {}
  if (committed) git('reset', '--soft', 'HEAD~1')
  for (const f of files) writeFileSync(f, before[f])
  fail('No se pudo subir a GitHub. ¿Hay Internet? Si sigue fallando, puede que haya caducado la sesión de GitHub: mira «Si algo sale mal» en COMO-PUBLICAR.md.')
}

const actions = `https://github.com/${repo}/actions`
console.log(`
✔ ¡Versión ${next} enviada! GitHub está preparando los instaladores de Windows y Linux (unos 15 minutos).
    Cómo va:            ${actions}
    Cuando esté lista:  https://github.com/${repo}/releases/tag/${tag}
  Los que ya lo tengan instalado verán el aviso de actualización la próxima vez que abran el juego.
`)
if (interactive) {
  const rl = prompter()
  const open = !/^n/i.test(await rl.ask('  ¿Abrir en el navegador la página para ver cómo va? (s/n) [s]: '))
  rl.close()
  if (open) execFileSync('cmd', ['/c', 'start', '', actions])
}
