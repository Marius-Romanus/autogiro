# Cómo colaborar

**Español** · [English](#contributing)

Gracias por querer echar una mano. Autogiro es un proyecto personal, pero cualquier aviso o idea
ayuda a que vuele mejor.

## Avisar de un fallo

Abre un issue con la plantilla [**Algo no funciona**](https://github.com/Marius-Romanus/autogiro/issues/new/choose).
Lo que más ayuda:

- La **versión** (abajo a la derecha del menú, tecla Esc).
- Las **coordenadas** de la barra de arriba, para ir justo a ese sitio.
- Una **captura o vídeo** con esa barra a la vista: ya lleva coordenadas, altitud y FPS.
- Los **pasos** para que vuelva a pasar.

## Proponer algo

Usa la plantilla [**Sugerencia**](https://github.com/Marius-Romanus/autogiro/issues/new/choose). Si es
sobre un autogiro o sobre la física, lo que más vale son datos reales: el manual del aparato, fichas
técnicas, fotos desde varios ángulos o vídeos de vuelo. Las prestaciones de cada aparato se contrastan
con datos reales, así que una idea con fuente llega antes.

## Cambiar el código

Antes de ponerte con algo grande, **abre un issue para hablarlo**: así no trabajas en algo que choque
con lo que ya está en marcha. Los arreglos pequeños puedes mandarlos directamente.

### Arrancarlo

Necesitas [Node.js](https://nodejs.org/) 24 o más nuevo.

```sh
npm install
npm run dev
```

Se abre en <http://localhost:5173>. El escenario gratis (ortofoto y relieve) funciona sin nada más.
Para probar el 3D de Google, crea un archivo `.env.local` con tu clave:

```sh
VITE_GOOGLE_MAPS_API_KEY=tu-clave
```

La aplicación de escritorio se compila con [Tauri](https://tauri.app/) (`npm run app:build`), que
necesita además Rust. Para probar cambios no hace falta: con el navegador basta.

### Antes de mandar el pull request

- `npm run typecheck` sin errores.
- Si tocas la **física** de un aparato: `npm run fdm-test:all`, y explica de dónde salen los datos nuevos.
- Si tocas los **accidentes**: `npm run crash-test`.
- Si tocas el **multijugador**: `npm run mp-test`.
- Los textos que ve el jugador van **en español y en inglés** (`src/i18n.ts`).
- El código y los comentarios van en español, como el resto del proyecto.
- Una captura o un vídeo si el cambio se ve.

### Licencia

El proyecto usa la licencia [PolyForm Noncommercial 1.0.0](../LICENSE). Al mandar un pull request
aceptas que tu aportación se publique con esa misma licencia.

---

# Contributing

Thanks for wanting to help! Bug reports and suggestions are welcome in English too: use the
[issue templates](https://github.com/Marius-Romanus/autogiro/issues/new/choose). The most useful details
are the game version (bottom right of the menu), the coordinates from the top bar, and a screenshot or video.

For code changes, please open an issue first for anything big. To run it you need Node.js 24+:
`npm install`, then `npm run dev` and open <http://localhost:5173>. Before a pull request, run
`npm run typecheck` (plus `npm run fdm-test:all` for flight physics, `npm run crash-test` for crashes and
`npm run mp-test` for multiplayer), and add any player-facing text in both Spanish and English
(`src/i18n.ts`). Code comments are in Spanish.

By submitting a pull request you agree that your contribution is published under the project's
[PolyForm Noncommercial 1.0.0](../LICENSE) license.
