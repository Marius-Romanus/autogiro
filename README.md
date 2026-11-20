# Autogiro · simulador sobre el mundo real

Hecho con ❤️ por [Mario](https://creativecode.es/) · más proyectos en **[creativecode.es](https://creativecode.es/)** · ☕ [Invítame a un café en Ko-fi](https://ko-fi.com/mario_creativecode)

### [⬇️ Descargar Autogiro para Windows](https://github.com/Marius-Romanus/autogiro/releases/latest/download/Autogiro-Setup.exe)

Instalador para Windows 10 y 11 (sin Node ni nada más; se actualiza solo) ·
[novedades y versiones anteriores](https://github.com/Marius-Romanus/autogiro/releases)

Simulador de autogiro en el navegador (Three.js + WebGL2) con escenario real del planeta,
atmósfera física, nubes volumétricas y una física específica de autogiro: rotor libre en
autorrotación, prerrotador, batimiento de palas, RPM de rotor que dependen de la carga, hélice
propulsora y cola en el soplado.

Salida por defecto: **Casarrubios del Monte (LEMT)**, pista 08/26. En el menú, *Lugar*, hay además
aeropuertos y aeródromos históricos de España con salida en cabecera: Madrid-Cuatro Vientos (27 y 09),
Madrid-Barajas (36L, y una final a la 32L en vuelo), Barcelona-El Prat (24L), Palma (24L), Málaga (13),
Sevilla (27), Valencia (12), Bilbao (30), Tenerife Norte-Los Rodeos (30) y Gran Canaria (03L).
Para añadir otro: `node --experimental-strip-types tools/runway-info.ts <lat> <lon>` da, con el mismo eje de
OpenStreetMap que se alisa en el juego, la posición y el rumbo de salida de cada cabecera.

## Arrancar

Requisitos: Node.js 20 o superior (ya lo tienes: v24).

```powershell
npm install
```

```powershell
npm run dev
```

Abre <http://localhost:5173> en **Chrome o Edge**.

### Usa la gráfica dedicada, no la integrada

En portátiles con dos GPU (Intel + NVIDIA o AMD), el navegador suele arrancar con la Intel y el
juego va a tirones. Los mismos pasos salen en el juego (menú → *Gráficos y mandos*, cuando detecta la
integrada, y en *Multijugador → Jugar por Internet*), para que los vean también tus amigos:

1. **Enchufa el portátil**: con batería muchos se quedan en la integrada.
2. **Windows 11:** *Configuración → Sistema → Pantalla → Gráficos* → Chrome (o Edge; si no aparece,
   *Agregar aplicación de escritorio* → `chrome.exe`) → *Preferencia de GPU* → **Alto rendimiento**.
   **Windows 10:** *Configuración → Sistema → Pantalla → Configuración de gráficos* → Examinar →
   `C:\Program Files\Google\Chrome\Application\chrome.exe` → Opciones → **Alto rendimiento**.
3. Si sigue igual, fuérzalo también en el programa de la tarjeta:
   - **NVIDIA:** *Panel de control de NVIDIA → Administrar configuración 3D → Configuración de programa*
     → Chrome → *Procesador NVIDIA de alto rendimiento*.
   - **AMD:** *AMD Software: Adrenalin → Sistema/Gráficos → Gráficos intercambiables* → Chrome → *Alto rendimiento*.
4. **Cierra el navegador del todo** (también el icono junto al reloj) y ábrelo de nuevo. En
   `chrome://settings/system` (`edge://settings/system`) debe estar activada la aceleración gráfica.
5. Comprueba en `chrome://gpu` (`edge://gpu`), en *GL_RENDERER*, que aparece la NVIDIA o la AMD.

El menú muestra qué GPU está usando el juego. Con **Calidad: Automática** elige «Baja» si detecta
la integrada (unos 45–55 fps a resolución reducida, sin resplandor ni suavizado) y «Alta» con una
dedicada; con la 4090 puedes poner **Ultra**. El panel de navegador de la app de Claude usa siempre
la Intel: para verlo bien, ábrelo en Chrome o Edge.

## App de escritorio (instalador para Windows)

Para quien no sabe nada de Node: un instalador `.exe` normal hecho con Tauri. Instala sin permisos de
administrador, crea el acceso directo y abre el juego en su propia ventana, siempre con la gráfica
dedicada. **F11** o **Alt+Intro** ponen la pantalla completa. Necesita Internet igual que la web: el
paisaje se descarga del IGN, OpenFreeMap, Esri o Google.

Para generarlo hacen falta, además de Node, Rust (`rustup`) y Visual Studio Build Tools con C++ (ya los tienes):

```powershell
npm run app:build
```

Compila el juego (`npm run build`) y deja el instalador en
`src-tauri/target/release/bundle/nsis/Autogiro_<versión>_x64-setup.exe`. La versión es la de `package.json`.

Cómo funciona: la app (`src-tauri/`) lleva dentro un servidor que hace lo mismo que `npm run server`
(el juego y las salas en `http://localhost:47800`, o 47801… si está ocupado, y también en la red
local) y lo abre con WebView2, el motor de Edge que ya trae Windows 10/11 (si falta, el instalador lo
descarga). Así quien lo instala ya tiene servidor de partidas para sus amigos; la guía *Jugar por
Internet* del juego cambia sola a los pasos de la app (`src/net/appHelp.ts`). Las salas están
reescritas en Rust (`src-tauri/src/rooms.rs`) para no tener que llevar Node: si cambias
`server/rooms.ts` o el protocolo, cambia también ese archivo y pruébalo con la app abierta:

```powershell
$env:MP_URL='ws://127.0.0.1:47800/mp'; npm run mp-test; Remove-Item Env:MP_URL
```

- El instalador no está firmado, así que SmartScreen avisa la primera vez («Windows protegió su PC»):
  *Más información → Ejecutar de todas formas*.
- Al abrir la app por primera vez Windows pregunta por el firewall: permitirlo en redes privadas deja
  entrar a los amigos de la misma wifi.
- Lo que guarda el juego (idioma, clave de Google, ajustes) va en
  `%LOCALAPPDATA%\es.creativecode.autogiro`, aparte de lo del navegador.
- Icono: `src-tauri/icons/app-icon.svg`; tras cambiarlo, `npx tauri icon src-tauri/icons/app-icon.svg -o src-tauri/icons`.
- Para depurar la app instalada: `$env:AUTOGIRO_DEVTOOLS_PORT=9339` antes de abrirla desde esa misma
  PowerShell y luego `edge://inspect` → *Configure* → `localhost:9339`.

### Publicar una versión nueva

Una sola orden; cada texto entre comillas es una línea de las novedades:

```powershell
npm run release -- "Nuevo aparato: Magni M16" "Arreglado el escalón de la pista en LEMT"
```

`tools/release.mjs` comprueba que compila (`typecheck` y `mp-test`), sube la versión (0.1.0 → 0.1.1;
`--minor` o `--major` para saltos mayores) en `package.json` y `src-tauri`, hace el commit con todo
lo pendiente, crea la etiqueta `vX.Y.Z` y la sube. Con eso GitHub Actions
(`.github/workflows/release.yml`, gratis en un repo público) compila el instalador en unos
10–15 minutos y publica la release con:

- **`Autogiro-Setup.exe`**: siempre el mismo nombre, así que
  `https://github.com/Marius-Romanus/autogiro/releases/latest/download/Autogiro-Setup.exe` descarga siempre la
  última versión (es el botón del principio de este README).
- **`latest.json`**: lo consultan las apps instaladas al abrirse (`src-tauri/src/updates.rs`). Si hay
  una versión más nueva, preguntan; si se acepta, se descarga, se instala con una barra de progreso y el
  juego se vuelve a abrir.

Las actualizaciones van firmadas para que nadie pueda colar un instalador falso. La clave privada está en
`%USERPROFILE%\.tauri\autogiro-updater.key` y en el secreto `TAURI_SIGNING_PRIVATE_KEY` del repo; la
pública, en `plugins.updater.pubkey` de `src-tauri/tauri.conf.json`. **Guarda una copia de
`autogiro-updater.key`** (en un USB o en la nube): si se pierde, las apps ya instaladas no aceptarán
versiones nuevas y habría que reinstalar a mano.

## Multijugador (salas con código)

En el menú, banda **Multijugador**: escribe tu nombre y pulsa **Crear sala**. Te da un código de
4 caracteres (p. ej. `K7QX`, sin I, O, 0 ni 1 para que se pueda dictar). Tus amigos lo escriben y
pulsan **Unirse**, o abren el enlace de **Copiar enlace** (`…/?sala=K7QX`), que entra directamente.
Hasta 8 pilotos por sala.

- **El anfitrión** (quien crea la sala) fija el lugar, la hora, el viento, la turbulencia y las nubes
  para todos; a los demás se les bloquean esos ajustes. Si se va, pasa a serlo el siguiente.
- Cada uno elige su aparato, si lleva pasajero y el escenario (Google o sin clave: cada cual el suyo;
  las alturas se ajustan para que en la pista todos estén sobre el suelo).
- **Salida:** en pista, cada piloto aparece en su puesto, uno detrás de otro (22 m) a lo largo de la
  pista; en vuelo, en formación abierta.
- **Choques entre aparatos** (rotor contra rotor o fuselaje, fuselaje contra fuselaje): activados por
  defecto; el anfitrión puede quitarlos.
- `Intro` abre el **chat**. Arriba a la derecha está la lista de pilotos con distancia y rumbo; sobre
  cada aparato, su nombre, distancia y altitud. Quien está en el menú aparece «en el menú» (su aparato
  queda congelado y no choca).

Cada ordenador simula su propio autogiro (la física no cambia) y envía su estado 15 veces por segundo;
los demás lo interpolan con ~0,1 s de retardo. El servidor (`server/rooms.ts`) solo reparte mensajes.

### Jugar con amigos

`npm run dev` ya incluye el servidor de salas, pero solo escucha en tu ordenador.

**Misma red (casa, campo de vuelo):** arranca con `npm run dev:lan` y pásales la dirección
`http://<tu-IP-local>:5173` (Vite la muestra al arrancar).

**Por Internet, con un túnel de Cloudflare** (gratis, sin cuenta y sin tocar el router). La misma
guía está dentro del juego: *Menú → Multijugador → Jugar por Internet (Cloudflare)*, con botones
para copiar cada orden. Solo lo hace quien comparte; los demás solo necesitan el enlace.

1. Instala `cloudflared` (solo la primera vez) y vuelve a abrir PowerShell:

   ```powershell
   winget install --id Cloudflare.cloudflared
   ```

2. Compila el juego:

   ```powershell
   npm run build
   ```

3. Arranca el servidor de partidas y deja la ventana abierta. Sirve el juego y las salas en un único
   puerto (8080; otro con la variable `PORT`):

   ```powershell
   npm run server
   ```

4. En otra ventana, abre el túnel. A los pocos segundos muestra una dirección
   `https://…trycloudflare.com`:

   ```powershell
   cloudflared tunnel --url http://localhost:8080
   ```

5. Abre esa dirección en tu navegador (tú también), crea una sala y pulsa **Copiar enlace**: es el que
   les pasas a tus amigos y entran directamente en tu sala.

Conviene saber:

- La dirección del túnel cambia cada vez que lo abres; tu ordenador tiene que seguir encendido con las
  dos ventanas abiertas (`Ctrl+C` en cada una para terminar).
- Las salas van por `wss://` a través del túnel sin configurar nada.
- No uses `npm run dev` con el túnel: Vite rechaza las direcciones de fuera y dejaría ver el código fuente.
- **Clave de Google:** es de cada uno y se pone en el menú (se guarda solo en su navegador). Si
  restringiste la tuya a localhost, añade `https://*.trycloudflare.com/*` a los sitios permitidos.
  Quien no tenga clave puede volar en «Ortofoto + relieve». La clave de `.env.local` solo se usa con
  `npm run dev`: el juego compilado nunca la lleva dentro, así que no se filtra al compartirlo.
- Otras formas de publicar el puerto 8080: redirección en el router o una VPN tipo Tailscale. Si el
  juego y las salas están en sitios distintos, indica el servidor en *Multijugador → Servidor de salas*.

### Probar sin un segundo ordenador

```powershell
npm run mp-bot
```

crea una sala con un piloto de prueba que da vueltas sobre Casarrubios a 500 ft y te dice el código.
`npm run mp-bot -- K7QX` lo mete en tu sala y `npm run mp-bot -- K7QX suelo` lo deja parado en la
cabecera 26; contesta al chat. `npm run mp-test` comprueba el servidor de salas sin navegador.

## Escenario

| Modo | Qué ves | Necesita |
|---|---|---|
| **Fotorrealista 3D de Google** | Edificios, árboles y relieve en 3D (el mismo tipo de datos que usan Google Earth y los simuladores tipo Glider Sim). | Clave de Google Maps Platform con **Map Tiles API** |
| **Ortofoto + relieve** | Ortofoto **PNOA del IGN** (25–50 cm) sobre el **MDT de 5 m del IGN**, con **edificios 3D de OpenStreetMap** y **árboles 3D** sacados de la ortofoto. Fuera de España: Esri y relieve global de ~30 m. | Nada |

### Modo sin clave: relieve, edificios y árboles

- **Relieve**: en España se usa el MDT05 del IGN (modelo del terreno de paso 5 m, a partir de LiDAR), que el
  CNIG publica como terreno *quantized-mesh* (`qm-mdt.idee.es`). Se notan los cortados, vaguadas, riberas y
  taludes que el relieve global de ~30 m (Mapzen/AWS) suaviza; en el menú, *Relieve → Global* vuelve al anterior.
  La física del suelo lee la misma malla que se dibuja (`src/world/HeightSource.ts`), así que el aparato rueda
  sobre lo que ves. En calidad Alta y Ultra el relieve se ilumina además con sus normales.
- **Pistas**: el MDT05 tiene costuras de algunos decímetros entre bloques de datos (en Casarrubios, un escalón
  de ~0,4 m cruzaba la pista a 40 m de la cabecera 08). Con el trazado de las pistas de OpenStreetMap se calcula
  un perfil suave de cada una, ajustado al propio MDT (respeta su pendiente y sus cambios de rasante), y se
  aplica a la física y al dibujo: las teselas finas que tocan una pista se vuelven a mallar con una rejilla de
  ~2 m, con 20 m de transición a cada lado (`src/world/Runways.ts`). Funciona en cualquier aeródromo de España
  que esté en OpenStreetMap.
- **Edificios**: huellas reales de OpenStreetMap (en España casi todas del Catastro) con su altura
  (`height` / `building:levels`), servidas por [OpenFreeMap](https://openfreemap.org) en teselas vectoriales y
  extruidas en 3D sobre el relieve (`src/world/Buildings.ts`). El tejado toma el color de la ortofoto en ese
  punto, las fachadas llevan ventanas por planta y se cargan unos 2–7 km a la redonda según la calidad.
  Dentro de un aeródromo se dibujan como naves (hangares), salvo los de más de 16 m (torres, terminales). Chocar con uno es accidente. Son volúmenes con tejado
  plano: para tejados y detalle reales hace falta el modo fotorrealista de Google.
- **Árboles**: OpenStreetMap casi no tiene árboles sueltos, pero la ortofoto sí. Por cada tesela se busca en el PNOA
  (a ~1,8 m/píxel) cada copa: mancha oscura y verdosa, un árbol por máximo local, con el tamaño de la mancha y
  el color de la foto (`src/world/Trees.ts`). Salen así los olivares en sus filas, las dehesas, los pinares, los
  sotos de ribera y el arbolado urbano donde están. Se descartan agua, edificios, carreteras, vías y pistas
  (capas de OpenFreeMap). Tres formas (frondosa, pino y ciprés), dos niveles de detalle, unos 0,9–2,8 km a la
  redonda según la calidad. La copa es obstáculo (el tronco no). Los umbrales del detector están en
  `TREE_DETECT`; matorral denso muy oscuro o sombras sobre césped pueden dar algún árbol de más.

### Clave de Google

1. Entra en <https://console.cloud.google.com/> y crea un proyecto.
2. Activa la facturación (hay una cuota gratuita mensual generosa).
3. *APIs y servicios → Biblioteca* → habilita **Map Tiles API**.
4. *Credenciales* → *Crear credenciales → Clave de API*. Restríngela a Map Tiles API y,
   si quieres, al referente `http://localhost:5173/*`.
5. Pégala en el menú del juego (se guarda solo en tu navegador), o crea un archivo
   `.env.local` con `VITE_GOOGLE_MAPS_API_KEY=tu_clave` (ver `.env.example`).

## Mandos

| Tecla | Acción |
|---|---|
| `W` `S` / `↑` `↓` | Palanca adelante / atrás. **Se queda donde la dejas** (toque corto = ajuste fino, mantener = recorrido rápido); `Inicio` la centra |
| `A` `D` / `←` `→` | Palanca izquierda / derecha |
| `Q` `E` (`Z` `X`) | Pedales: timón (en el soplado de la hélice) y rueda de morro |
| `R` `F`, `1`…`0` | Gas |
| `T` `G` | Compensador de cabeceo |
| `P` (mantener) | Prerrotador |
| `B` | Freno de rotor |
| `Espacio` / `L` | Frenos de ruedas / freno de parking |
| `M` | Motor |
| `C` / `V` | Cambiar cámara (persecución, cabina, exterior, desde tierra) / mirar atrás |
| Ratón arrastrando, rueda | Mirar, zoom |
| `K` | Ratón como palanca |
| Botón central (con ratón como palanca) | La rueda pasa de zoom a gas (5 % por muesca) y viceversa |
| `Mayús dcha.` + palanca | Recorrido fino de palanca |
| `I` / `H` / `Esc` / `Retroceso` | Instrumentos / ayuda / menú / reiniciar |
| `J` (tras un accidente) | Cámara lenta ×0,2 / tiempo real |

Mando tipo Xbox: stick izquierdo = palanca, stick derecho = pedales, gatillos = gas, A = prerrotador,
B = frenos, LB/RB = compensador. Joystick o HOTAS: ejes configurables en el menú (se ven en vivo).

La opción **Ayuda al pilotaje** (activada por defecto, `src/sim/assist.ts`) hace lo que el piloto
hace con la mano sin pensarlo; no cambia la física, solo mueve los mandos dentro de un margen:

- amortigua el **fugoide** (con la palanca fija, un autogiro intercambia velocidad y altura en ciclos
  de 10–15 s muy poco amortiguados; con teclado no se puede corregir a mano),
- nivela las alas y compensa el par motor cuando no hay mando lateral, y coordina con pedales,
- modera la **recogida**: cerca del suelo, con poco gas y la palanca atrás, cede palanca si el
  aparato deja de bajar, para que se pose en vez de quedarse colgado a un metro y desplomarse.

Con joystick o mando solo amortigua ligeramente el cabeceo. Desactívala para un vuelo 100 % manual.

## Cómo se vuela (y por qué es distinto)

- **Palanca = velocidad, gas = altura.** La palanca inclina el disco del rotor; el gas sube o baja.
- **Despegue:** freno de rotor fuera, palanca adelante, gas ~40 % y prerrotador hasta 200–220 rpm;
  luego, a la vez, suelta frenos y prerrotador, palanca toda atrás y gas a fondo (el despegue «de
  prestaciones» de la guía de la CAA británica para autogiros). Las vueltas del rotor caen un poco y
  suben con la velocidad; se va al aire a 70–80 km/h tras 95–110 m (135–155 m con pasajero). Entonces
  cede palanca para acelerar en efecto suelo hasta 90–100 km/h y sube. El Cierva C.30A se despega de
  otra manera (ver su sección).
- **Fallo de motor:** con la palanca donde estaba planea a ~100 km/h bajando ~6 m/s (fineza ~4,5);
  el mínimo descenso (~4,4 m/s) está a 50–60 km/h. Con la palanca toda atrás baja casi en vertical
  a 9–10 m/s: estable, pero demasiado rápido para tomar sin velocidad con la que recoger.
- **Batimiento de palas (flapping):** correr deprisa con pocas RPM de rotor hace que la pala que
  avanza bata contra los topes del balancín → accidente.
- **Baja carga:** empujar la palanca bruscamente descarga el rotor, las RPM caen y puedes perder el
  control (*power push-over*). Mantén siempre carga positiva.
- **Toma:** aproximación a 80–90 km/h; a 6–8 m del suelo (20–25 ft AGL) tira de palanca y mantenla
  (aparece el aviso «RECOGIDA»). Recoger demasiado tarde rompe el tren; demasiado alto, sin la ayuda,
  te deja sin velocidad a un metro del suelo.
- Mira el **tacómetro del rotor** (amarillo = prerrotación, verde = vuelo) y, en cabina, el **hilo
  de guiñada** del parabrisas.

## Física

`src/sim/rotor.ts` integra el rotor por elementos de pala (16 azimuts × 9 estaciones, 240 Hz):
empuje, fuerza en el plano, par aerodinámico (autorrotación) y momentos de batimiento. El plano de
puntas es **libre** (rotor basculante bipala): su normal precesa con los momentos aerodinámicos, así
salen solos el *blowback* con la velocidad, el retraso del disco respecto a la palanca y el
batimiento excesivo. Flujo inducido de Glauert / estado de molinete con efecto suelo (Cheeseman y
Bennett), que se desvanece con la velocidad: pleno en estacionario y casi nulo a las velocidades de
carrera y de recogida, cuando la estela ya se va hacia atrás antes de llegar al suelo.

`src/sim/autogyro.ts`: sólido rígido de 6 grados de libertad; motor (`engines.ts`: Rotax 912 ULS o
914 turbo, según el aparato) con hélice de paso fijo
(curvas de empuje y par en función del avance: las RPM del motor salen del equilibrio motor-hélice,
suben con la velocidad y al ralentí en planeo la hélice gira arrastrada); par motor; estabilizador
y deriva en el soplado con un modelo de placa válido a cualquier ángulo (es lo que hace que la cola
busque el viento y baje el morro cuando falta velocidad); tren triciclo con amortiguadores y
fricción; y detección de accidentes (tren, palas, hélice, vuelco, colisiones).

### Validación

```powershell
npm run fdm-test
```

Ejecuta dos bancos de pruebas sin navegador:

- `tools/fdm-validate.ts` compara el modelo con teoría de rotores y con cifras de un biplaza de
  100 CV tipo MTOsport (16 comprobaciones con su rango esperado); con `af=ela07` o `af=ela10` usa
  las prestaciones publicadas de ese aparato.
- `tools/fdm-scenarios.ts` vuela escenarios completos con un «piloto de teclado» simulado que usa el
  mismo código de ayuda que el juego: corte de gas y de motor (manos fuera, palanca media y toda
  atrás), despegue solo y con pasajero, toma sin motor con recogida a distintas alturas, baja carga
  y flapping.

Cifras actuales del genérico (650 m de altitud, 395 kg solo / 478 kg con pasajero):

| Magnitud | Simulador | Referencia |
|---|---|---|
| RPM de rotor en crucero | 352 solo / 388 con pasajero | 330–400 |
| RPM en viraje de 45° respecto a vuelo recto | ×1,20 | √1,41 = 1,19 (teoría) |
| Descenso vertical (motor parado) | 10,3 m/s = 1,87·v_h | 1,6–2,0·v_h (teoría y ensayos NACA) |
| Mejor fineza de planeo | 4,7 a 84 km/h | 3,5–4,8 |
| Descenso mínimo en planeo | 4,4 m/s a 52 km/h | 4–6,5 m/s |
| Velocidad máxima / mínima en vuelo nivelado | 157 / 43 km/h | 145–185 / 30–55 |
| Crucero a 106 km/h (palanca neutra) | 62 % de gas, 4430 rpm de motor | — |
| Ascenso a pleno gas | 4,9 m/s solo / 2,9 con pasajero | 4–6,5 / 2,3–4,5 |
| Carrera de despegue (prerrotando a 210 rpm; hasta que las ruedas dejan el suelo) | 108 m solo / 154 m con pasajero, a ~73 km/h | ~100–150 m |

Los rangos de referencia son aproximados (manuales de vuelo y literatura de autogiros); si alguna
cifra no cuadra con el aparato que conoces, los parámetros están en `DEFAULT_ROTOR` (`rotor.ts`) y
en `tune` (`autogyro.ts`) y el validador acepta sobrescribirlos, p. ej.
`node --experimental-strip-types tools/fdm-validate.ts pitch=4.0 cdA=0.7`.

### Geometría por aparato

Cada aparato del catálogo vuela con su propia geometría (`src/sim/airframes.ts`): dónde apoyan las
ruedas, dónde está la hélice, el punto más bajo de la cola, el centro y la superficie del
estabilizador y de las derivas, y los puntos de la célula que no deben tocar el suelo. Se miden en el
propio GLB con `node tools/model-geom.mjs public/models/<aparato>.glb`. Cada ficha lleva también su
peso en vacío, la resistencia de su célula, su motor con el paso de la hélice y el diámetro y la
cuerda de su rotor. Solo el buje, el centro de gravedad y el perfil y el paso de pala son comunes:

| | Genérico | ELA 07 Cougar | ELA 10 Eclipse |
|---|---|---|---|
| Batalla (rueda de morro – principales) | 1,87 m | 1,92 m | 2,23 m |
| Peso sobre la rueda de morro, parado | 21 % | 40 % | 24 % |
| Brazo de cola (CG – estabilizador) | 3,50 m | 2,38 m | 2,61 m |
| Estabilizador / superficie vertical | 0,70 / 0,82 m² | 0,88 / 0,84 m² | 0,74 / 1,15 m² |
| Placas o derivas en las puntas del estabilizador | 0,31 m | 0,56 m | 0,72 m |
| Rotor: diámetro / cuerda | 8,40 m / 20 cm | 8,23 m / 22 cm | 8,50 m / 22 cm |
| RPM de rotor en crucero, solo / con pasajero | 352 / 388 | 338 / 375 | 339 / 372 |
| Cabeza del rotor: palanca centrada / tope trasero | 7,2° / 16,0° | 7,2° / 15,2° | 7,2° / 15,0° |
| Golpe de cola al rotar sobre las principales | 9,0° | 13,0° | 9,8° |
| Motor | Rotax 912 ULS, 100 CV | Rotax 914 turbo, 115 CV | Rotax 914 turbo, 115 CV |
| Paso de la hélice (respecto al genérico) | ×1 | ×1,05 | ×1,10 |
| Peso en vacío / máximo al despegue | 260 / 500 kg | 250 / 450 kg | 275 / 530 kg |
| Peso en vuelo: solo / con pasajero | 395 / 478 kg | 365 / 448 kg | 410 / 493 kg |
| Resistencia de la célula (CdA) | 0,60 m² | 0,60 m² | 0,40 m² |
| Velocidad máxima en vuelo nivelado | 157 km/h | 171 km/h | 186 km/h |
| Velocidad al 75 % de gas | 131 km/h | 147 km/h | 160 km/h |
| Ascenso a pleno gas: solo / con pasajero | 4,9 / 2,9 m/s | 7,8 / 5,1 m/s | 6,8 / 4,5 m/s |
| Mejor fineza de planeo | 4,7 | 4,8 | 5,2 |
| Carrera de despegue solo / con pasajero | 108 / 154 m | 94 / 136 m | 110 / 154 m |
| Velocidad al despegar (solo) | 73 km/h | 81 km/h | 79 km/h |

Pesos, motor y prestaciones de los ELA salen de lo publicado (fabricante y directorios de aviación
ligera; todo a 650 m, donde el 912 atmosférico ya ha perdido un 6 % de potencia y el 914 turbo no):

- **ELA 07 Cougar**: 250 kg en vacío y 450 kg de máximo, así que con dos a bordo solo caben 42 de
  los 75 l del depósito. Publicado: crucero 140 km/h, VNE 175 km/h y ascenso de 5 a 7 m/s; el
  simulador da 140 km/h al 70 % de gas, 172 km/h de máxima y 7,7 / 5,1 m/s.
- **ELA 10 Eclipse**: 275 kg en vacío y 530 kg de máximo. Su resistencia de célula está ajustada
  para dar el crucero y la máxima publicados (160 y 190 km/h): el simulador da 158 km/h al 75 % de
  gas y 186 km/h de máxima. Con un tercio menos de resistencia que los abiertos, planea algo mejor.
- La hélice de los ELA lleva más paso para que el 914 no se pase de vueltas (`propPitch`); el banco
  `node --experimental-strip-types tools/fdm-engine.ts af=ela10` muestra régimen, potencia y empuje.

El estabilizador de cada ficha es el dibujado: superficie en planta, centro aerodinámico al 25 % de la
cuerda media y la altura de las placas o derivas de sus puntas, que aumentan su alargamiento efectivo
(`stabCoeffs` saca de ahí la pendiente de sustentación y la fuerza con el aire de través). Las colas
cortas de los ELA frenan menos el aire que viene de abajo, así que su cabeza tiene el tope trasero
algo más bajo: con los 16° del genérico, a fondo atrás y sin motor se irían de cola. A cambio, a fondo
atrás sin motor bajan casi en vertical avanzando 10–15 km/h en vez de 3. La superficie vertical del
Cougar suma la deriva central con el timón (0,56 m²) y las dos derivas pequeñas de las puntas del
estabilizador.

```powershell
npm run fdm-test:all
```

pasa las 16 comprobaciones y los 13 escenarios con cada aparato (`fdm-test:ela07`, `fdm-test:ela10`
para uno solo), y `node --experimental-strip-types tools/fdm-ground.ts` comprueba el asiento en tierra
y la rotación. El centro de gravedad del ELA 07 no está medido: se ha dejado el común, y por eso
carga tanto la rueda de morro. Tampoco hay datos publicados fiables de la resistencia del Cougar ni
de la fineza de ninguno de los dos: son valores coherentes con el resto, no medidos.

### Cierva C.30A (homenaje a Juan de la Cierva)

El autogiro más fabricado de Juan de la Cierva (1934; Avro 671 Rota), con su ficha propia en
`airframes.ts` (`cierva`). Es muy distinto de los actuales y el modelo de vuelo lo trata como tal:

- **Hélice tractora delante** (Fairey Reed bipala metálica de 2,13 m, con curvas propias `propCoef`) y
  **radial Armstrong Siddeley Genet Major IA** de 7 cilindros y toma directa (`GENET_MAJOR` en
  `engines.ts`: 140 CV a 2200 rpm; ralentí ~600 rpm; cuentavueltas en centenas).
- **Rueda de cola** (`tailWheel`): se asienta con 10° de cola apoyada, que carga el 26 % del peso;
  dirigible con los pedales (`tailWheelSteer`).
- **Rotor tripala articulado de 11,28 m** (cuerda 0,279 m, paso 2,66°, 530 kg·m²) que gira a ~0,64 de
  las vueltas de los actuales (`rpmScale`): avisos, relojes, desenfoque y prerrotador se escalan con él.
- **Mando directo y sin timón** (`rudder: false`): la palanca cuelga de la cabeza (`hangingStick`); los
  pedales solo mueven la rueda de cola. Cabeza de 2,5° adelante a 7,5° atrás.
- **Par y remolino de la hélice al revés** que en los Rotax (`torqueRoll`, `swirlYaw`); el estabilizador
  con curvatura contraria a cada lado deja un poco de alabeo a la derecha con potencia.

Pesos, CG, rotor, hélice y resistencia salen de los ensayos de la RAE (ARC R&M 1859 y 1727) y de
Flight / NACA Aircraft Circular 196 (1934). A 650 m:

| | Simulador | Medido (RAE, a nivel del mar) |
|---|---|---|
| Peso solo / con pasajero | 728 / 811 kg | 1700 lb (771 kg) / 1900 lb (862 kg) en los ensayos |
| Velocidad máxima | 155 km/h | 97 mph (156 km/h) con 1700 lb |
| Velocidad mínima nivelada | 52 km/h | 28 mph (45 km/h) con 1700 lb |
| Ascenso, solo / con pasajero | 2,9 / 1,8 m/s | 2,7 m/s (1700 lb) / 1,8 m/s (1900 lb) |
| RPM de rotor en crucero | 231 (solo) / 244 (con pasajero) | 200–240; 227 a 90 mph |
| Descenso con palanca atrás, sin motor | 9,3 m/s a ~27 km/h | sostiene el control hasta ~22 mph |
| Prerrotación | ~180 rpm | ~185 rpm (se soltaba entre 170 y 210) |
| Carrera de despegue solo / con pasajero | 124 / 163 m, a 66–68 km/h (a nivel del mar y con los pesos de la RAE: 119 / 161 m) | 93 m (1700 lb, 82–104) / 135 m (1900 lb, 107–146), a 59–75 km/h |

El **despegue** se hace como en las notas del piloto de la RAE (R&M 1859, apéndice I, §11.5): con
los frenos puestos se prerrota a 170–210 rpm; frenos y embrague se sueltan a la vez (una sola
palanca) con todo el gas y se acelera con la palanca **adelante**, el disco a la mínima incidencia: el
rotor pierde vueltas, pero frena lo mínimo. Con velocidad para autorrotar (~60 km/h) se tira de la
palanca «despacio pero a fondo», el rotor se embala y el autogiro se va al aire. La carrera se mide
hasta que las ruedas dejan el suelo, como en la tabla 5 del informe (corregida a viento nulo). Como
anotó la RAE, soltar el embrague a 170 o a 210 rpm apenas cambia la carrera. Con la palanca toda
atrás desde el principio el disco frena tanto que solo despega tras ~155 m, y con pasajero no llega
a irse al aire: se queda corriendo a ~53 km/h. En vuelo sin manos es algo inestable en
alabeo, como anotaron los pilotos de la RAE, y al cortar gas tiende a la izquierda.

```powershell
npm run fdm-test:cierva
```

### Accidentes

Cuando el modelo de vuelo detecta un fallo (toma dura, golpe de palas o de hélice, vuelco, flapping,
pérdida de vueltas, choque con un edificio, árbol o tesela 3D) el aparato no se congela: pasa a una
simulación de sólidos rígidos con [Rapier](https://rapier.rs) (`src/sim/wreck/`, a 480 Hz):

- **Despiece**: góndola, mástil, cola, patas del tren y horquilla forman un sólido compuesto; rotor
  (buje + 2 palas de 3 tramos), hélice (buje + 3 palas) y las 3 ruedas giran sobre su eje con el
  momento angular que traían. Las formas de choque son cascos convexos sacados de la malla real del
  modelo (`src/aircraft/WreckModel.ts`), que se trocea triángulo a triángulo en esas piezas.
- **Roturas por carga**: en cada unión se calcula la fuerza y el momento flector que transmite (2.ª
  ley de Newton sobre lo que cuelga de ella: inercia, contactos y ejes), filtrados con el tiempo de
  respuesta de la estructura, y se rompe al superar su resistencia (`src/sim/wreck/parts.ts`: pala
  ~3 kN·m en la raíz, mástil ~10 kN·m, tren ~17 kN…). El fallo que detectó el modelo de vuelo llega
  ya roto (p. ej. la pata que tocó a 4 m/s); lo demás sale solo: una pala que muerde el suelo
  girando se parte, el rotor desequilibrado arranca la cabeza o dobla el mástil, la cola se va en un
  impacto fuerte…
- **Rotor**: mientras está entero y girando sigue haciendo de disco en autorrotación (empuje según
  el flujo que lo atraviesa; en vertical cae a ~10 m/s como en el modelo de vuelo) y frena por
  resistencia de perfil en cuanto pierde una pala. El motor sigue tirando medio segundo y se cala.
- **Lo que se golpea**: el suelo es un campo de alturas del relieve real; edificios (OpenStreetMap)
  y teselas 3D de Google entran como malla de triángulos, así que se choca con su forma exacta; las
  copas de los árboles frenan lo que las atraviesa y siegan las palas. Salen polvo, terrones,
  hojas, chispas (metal contra superficies duras), surcos en la tierra, desconchones y cascotes y
  cristales con física propia (con el color de la fachada), y el fuselaje y las palas se abollan y
  doblan donde reciben los golpes.
- **Resultado**: al pararse todo aparece el resumen con las piezas rotas y la deceleración máxima en
  el asiento (promedio de 50 ms). Con `J` se ve a cámara lenta.

```powershell
npm run crash-test
```

`tools/crash-test.ts` lanza el despiece contra un suelo plano, una pared y una copa de árbol y
comprueba que nada se rompe en reposo ni en una toma de 2,5 m/s, que el tren cede a 7 m/s, que las
palas se parten al tocar el suelo girando, que el disco entero cae a ~10 m/s en vertical y que la
energía nunca crece (ni en total ni en un paso). `tools/crash-test-3blade.ts` hace lo mismo con el rotor
tripala y la hélice bipala del Cierva (el despiece toma palas, radio e inercia de la ficha de cada aparato).

## Modelo 3D (Blender)

`blender/build_autogiro.py` genera el autogiro (tándem abierto tipo MTOsport/ELA-07), guarda
`blender/autogiro.blend` y exporta `public/models/autogiro.glb`:

```powershell
& "C:\Program Files\Blender Foundation\Blender 5.3\blender.exe" -b -P blender/build_autogiro.py -- --previews
```

### Aparatos ELA (Córdoba)

`blender/build_ela.py` reutiliza rotor, cabeza, hélice, motor y ruedas del generador anterior y modela
fuselaje, cabina, mástil, cola y colores calcando fotos laterales de ELA (perfiles medidos con cuadrícula y
anclados en el buje del rotor). Hay dos variantes, se eligen en el menú (*Salida → Aparato*):

| Variante | Aparato |
|---|---|
| `ela07` | **ELA 07 Cougar**: bañera abierta en tándem con concha trasera alta, arco tras el asiento delantero con el parabrisas trasero, cabina delantera larga y baja, capó con parabrisas y morro corto en punta con carenado sobre la rueda delantera; baquets, mástil y quilla pintados, Rotax pegado a la bañera con piezas rojas, ruedas grandes sin carenar, quilla recta que sube a una cola corta: deriva central alta con timón grande, estabilizador en flecha y algo caído a su pie y dos derivas pequeñas en sus puntas. Amarillo. |
| `ela10` | **ELA 10 Eclipse**: huso estilizado con cúpula baja y lisa, morro en ojiva, faldones laterales redondeados, capó del motor ancho y romo junto a la hélice, pilón fino con toma de aire frontal, botalón bajo y recto que sube con una curva cerrada hasta la deriva ventral; estabilizador encima con placas hacia arriba y abajo. Azul metalizado. |

`blender/pilot.py` crea piloto y pasajero sentados (mono de vuelo, casco abierto de piloto con auriculares,
micro y visera ahumada subida, cara con gafas de aviador, guantes en la palanca y el gas, botas, arnés de
4 puntos y bandera en el hombro) y los coloca en cada asiento con cinemática inversa hacia palanca, gas y
pedales. Lo usan los tres aparatos, también el genérico (`build_crew()` en `build_autogiro.py`). Las
piernas del pasajero van casi juntas (en el Eclipse, abiertas a los lados del respaldo delantero) para
que no atraviesen la bañera: si se cambia un casco o un asiento, comprueba que ningún vértice de
`pilot_front`/`pilot_rear` quede fuera del fuselaje (en las vistas previas el pasajero se oculta; con
`--show-rear` sale).

```powershell
& "C:\Program Files\Blender Foundation\Blender 5.3\blender.exe" -b -P blender/build_ela.py -- --variant ela10 --previews
```

Genera `public/models/<variante>.glb`, `blender/<variante>.blend` y `blender/previews/<variante>/`.
Los aparatos se dan de alta en `src/aircraft/catalog.ts` y su geometría de vuelo en
`src/sim/airframes.ts` (misma `id`); ver «Geometría por aparato» en la sección de física. Si se redibuja
un modelo y cambian ruedas, hélice o cola, hay que volver a medirlo y actualizar su ficha.

### Cierva C.30A

`blender/build_cierva.py` construye el autogiro de Juan de la Cierva calcado del plano de tres vistas
publicado por Flight y la NACA en 1934 (fuselaje de tubo entelado con dos cabinas abiertas, pilón de
cuatro patas con su carenado cónico, rotor tripala con articulaciones de batimiento y arrastre, palanca
que cuelga de la cabeza, radial de 7 cilindros con su anillo colector, hélice Fairey Reed, tren ancho de
amortiguadores largos, rueda de cola, estabilizador con las puntas levantadas y gran deriva redondeada).
Lleva la decoración de la réplica del Museo del Aire de Madrid (XVU.1-1): gris aluminio, escarapela
rojo-gualda-rojo y cruz de San Andrés en la deriva. Tripulación con casco de cuero y gafas
(`helmet='leather'` en `blender/pilot.py`).

```powershell
& "C:\Program Files\Blender Foundation\Blender 5.3\blender.exe" -b -P blender/build_cierva.py -- --previews
```

Genera `public/models/cierva_c30a.glb` y `blender/previews/cierva/`, incluida `level_side.png`, la vista
lateral a la misma escala que el plano para superponerlos.

### Modelos externos

Para añadir otro modelo (por ejemplo uno de Sketchfab o TurboSquid), expórtalo como GLB a
`public/models/` y añádelo al catálogo, respetando: metros, morro hacia +X de Blender, arriba +Z, origen en
el centro de gravedad y estos nodos hijos directos de la raíz, con el origen en su pivote:
`rotor` (buje), `rotor_head`, `prop`, `rudder`, `nose_wheel`, `wheel_L`, `wheel_R`, `stick`,
`pilot_front`, `pilot_rear` y el vacío `eye_front` (ojo del piloto).

## Créditos

Creado por **Mario** · blog y otros proyectos en [creativecode.es](https://creativecode.es/) · si te gusta, [invítame a un café en Ko-fi](https://ko-fi.com/mario_creativecode) ☕

- [3d-tiles-renderer](https://github.com/NASA-AMMOS/3DTilesRendererJS) (NASA-AMMOS) para tiles 3D y relieve.
- [@takram/three-atmosphere y three-clouds](https://github.com/takram-design-engineering/three-geospatial) para cielo, atmósfera y nubes.
- Ortofoto PNOA y MDT05 © Instituto Geográfico Nacional (scne.es), CC BY 4.0 · Imágenes Esri World Imagery ·
  Relieve global: Mapzen / AWS Terrain Tiles · Google Photorealistic 3D Tiles © Google.
- Edificios © colaboradores de OpenStreetMap (ODbL), teselas de [OpenFreeMap](https://openfreemap.org) / OpenMapTiles.
- Cierva C.30A: plano de tres vistas y despiece de *Flight* (agosto de 1934) reproducidos en la
  [NACA Aircraft Circular 196](https://ntrs.nasa.gov/citations/19930090361) (dominio público); datos de
  vuelo de los ensayos de la RAE, ARC R&M 1859 y 1727; decoración de la réplica del Museo del Aire.
