// Idiomas de la interfaz: español (principal) e inglés.
//
// - Idioma inicial: el guardado en este navegador; si no hay, el del navegador
//   (español y lenguas de España → es; cualquier otro → en).
// - Textos del código: t('clave', { var }) con {var} como hueco.
// - Textos de index.html: atributo data-i18n="clave" (sustituye el innerHTML) y
//   data-i18n-attr="placeholder:clave;aria-label:clave". El español es el propio
//   HTML (se guarda la primera vez), así que en el diccionario `es` solo hacen falta
//   las claves que se usan desde código o en HTML creado por código.
// - Se puede importar desde node (herramientas de prueba): no toca el DOM al cargar.

export type Lang = 'es' | 'en'
export const LANGS: Lang[] = ['es', 'en']
const STORE = 'autogiro.lang'

type Dict = Record<string, string>

const es: Dict = {
  // guía de pilotaje lateral (src/hud/Guide.ts): en tierra, en vuelo y tras aterrizar.
  // Las claves guide.cierva.* sustituyen a las generales con el Cierva C.30A.
  'guide.label': 'Guía',
  'guide.title': 'Guía de pilotaje (J)',
  'guide.foot': '<kbd>J</kbd> oculta o muestra esta guía · <kbd>H</kbd> todos los mandos',
  'toast.guideOn': 'Guía de pilotaje: VISIBLE',
  'toast.guideOff': 'Guía de pilotaje: OCULTA (J para volver a verla)',
  'guide.ground.title': 'Despegue en autogiro',
  'guide.ground.steps': `
        <li>Freno de rotor quitado (<kbd>B</kbd>) y freno de parking puesto (<kbd>L</kbd>).</li>
        <li>Palanca <b>adelante</b> (mantén <kbd>W</kbd>) y gas a ~40 % (<kbd>R</kbd>/<kbd>F</kbd>, unas 3000 rpm de motor).</li>
        <li>Mantén el <b>prerrotador</b> (<kbd>P</kbd>) hasta 200-220 rpm de rotor.</li>
        <li>Suelta a la vez <kbd>P</kbd> y el parking (<kbd>L</kbd>), palanca <b>toda atrás</b> (mantén <kbd>S</kbd>) y gas <b>a fondo</b>.</li>
        <li>Se va al aire solo a ~75 km/h tras unos 110 m (155 con pasajero). Entonces <b>cede palanca</b> (toques de <kbd>W</kbd>) para acelerar a 90-100 km/h y subir.</li>`,
  'guide.ground.note':
    'La palanca <b>se queda donde la dejas</b> (mírala en el recuadro de la derecha): su posición fija la velocidad y el gas, la altura. Toques cortos = ajuste fino. <kbd>Inicio</kbd> la centra.',
  'guide.ground.warn':
    'Cuidado: correr con pocas RPM de rotor provoca <b>batimiento de palas</b>, y empujar la palanca bruscamente descarga el rotor.',
  'guide.flight.title': 'En vuelo',
  'guide.flight.tips': `
        <li><b>Velocidad con la palanca</b>: adelante (<kbd>W</kbd>) acelera, atrás (<kbd>S</kbd>) frena. Sube a 90-100 km/h y no bajes de 60 km/h.</li>
        <li><b>Altura con el gas</b> (<kbd>R</kbd>/<kbd>F</kbd>): más gas sube, menos gas baja.</li>
        <li><b>Virajes</b>: palanca hacia el lado (<kbd>A</kbd>/<kbd>D</kbd>) con un poco de pedal hacia el mismo lado (<kbd>Q</kbd>/<kbd>E</kbd>) para centrar la bola.</li>
        <li><b>Nunca empujes la palanca de golpe</b>: descarga el rotor, pierde vueltas y puedes perder el control.</li>
        <li><b>Sin motor</b> planea a ~100 km/h bajando unos 6 m/s.</li>`,
  'guide.flight.landTitle': 'Para aterrizar',
  'guide.flight.land': `
        <li>Alinéate con la pista desde lejos y reduce gas (<kbd>F</kbd>; <kbd>1</kbd> = ralentí).</li>
        <li>Mantén ~100 km/h con la palanca hasta cerca del suelo.</li>
        <li>A 6-8 m del suelo (20-25 ft) haz la <b>recogida</b>: mantén <kbd>S</kbd> hasta posarte, con el gas cortado.</li>`,
  'guide.landing.title': 'En tierra: ¿parar o volver a despegar?',
  'guide.landing.choose': 'Lo decide el gas: <b>ralentí</b> para parar, <b>a fondo</b> para una toma y despegue. Se resalta lo que estás haciendo.',
  'guide.landing.stopTitle': 'Para parar',
  'guide.landing.stop': `
        <li>Gas a ralentí (<kbd>1</kbd>) y <b>palanca toda atrás</b> (<kbd>S</kbd>): el disco frena como un paracaídas.</li>
        <li>Recto con los pedales (<kbd>Q</kbd>/<kbd>E</kbd>); frena (<kbd>Espacio</kbd>) cuando apoye la rueda de morro.</li>
        <li>Parado: parking (<kbd>L</kbd>), palanca al centro (<kbd>Inicio</kbd>) y freno de rotor (<kbd>B</kbd>).</li>`,
  'guide.landing.goTitle': 'Para volver a despegar',
  'guide.landing.go': `
        <li>Palanca <b>toda atrás</b> (<kbd>S</kbd>) y gas <b>a fondo</b> (<kbd>0</kbd>), sin frenos.</li>
        <li>El rotor ya gira: vuelve al aire a ~75 km/h. Luego <b>cede palanca</b> (toques de <kbd>W</kbd>) hasta 90-100 km/h.</li>
        <li>Si el rotor ha bajado de ~200 rpm, mejor para y prerrota (<kbd>P</kbd>): con pocas vueltas las palas baten.</li>`,
  'guide.cierva.ground.title': "Despegue en el Cierva C.30A",
  'guide.cierva.ground.steps': `
        <li>Freno de rotor quitado (<kbd>B</kbd>) y freno de parking puesto (<kbd>L</kbd>).</li>
        <li>Palanca <b>adelante</b> (mantén <kbd>W</kbd>) y gas a ~40 % (<kbd>R</kbd>/<kbd>F</kbd>, unas 1200 rpm de motor).</li>
        <li>Mantén el <b>prerrotador</b> (<kbd>P</kbd>): el embrague lleva el rotor hasta unas 180 rpm.</li>
        <li>Suelta <kbd>P</kbd> y el parking (<kbd>L</kbd>) —en el C.30 una sola palanca soltaba a la vez frenos y embrague— y gas <b>a fondo</b>, con la palanca aún <b>adelante</b>: el disco frena lo mínimo y acelera, aunque el rotor pierda vueltas.</li>
        <li>Hacia 60 km/h tira de la palanca <b>despacio pero a fondo</b> (mantén <kbd>S</kbd>): el rotor se embala y se va al aire a ~65-70 km/h tras unos 125 m (165 con pasajero). Sube a unos 85 km/h (unos 3 m/s solo, la mitad con pasajero).</li>`,
  'guide.cierva.ground.note': "<b>Mando directo</b>: la palanca cuelga de la cabeza del rotor y la inclina entera (por eso se ve moverse al revés que tu mano). <b>No hay timón</b>: los pedales solo giran la rueda de cola en tierra; en el aire se vira inclinando el disco.",
  'guide.cierva.ground.warn': "Es <b>algo inestable en alabeo</b>, como anotaron los pilotos de pruebas de la RAE: corrige con la palanca. Al cortar gas tiende a irse a la izquierda y al darlo, a la derecha.",
  'guide.cierva.flight.tips': `
        <li><b>Velocidad con la palanca</b>: adelante (<kbd>W</kbd>) acelera, atrás (<kbd>S</kbd>) frena. Sube a unos 85 km/h.</li>
        <li><b>Altura con el gas</b> (<kbd>R</kbd>/<kbd>F</kbd>): más gas sube, menos gas baja.</li>
        <li><b>Virajes solo con la palanca</b> (<kbd>A</kbd>/<kbd>D</kbd>): inclina el disco entero; no hay timón.</li>
        <li>Es <b>algo inestable en alabeo</b>: corrige con la palanca. Al cortar gas tiende a irse a la izquierda y al darlo, a la derecha.</li>
        <li><b>Sin motor</b> planea a ~100 km/h bajando unos 6 m/s.</li>`,
  'guide.cierva.flight.land': `
        <li>Alinéate con la pista desde lejos y reduce gas (<kbd>F</kbd>; <kbd>1</kbd> = ralentí).</li>
        <li>Mantén ~100 km/h con la palanca hasta cerca del suelo.</li>
        <li>Recogida a unos 6-8 m del suelo (mantén <kbd>S</kbd>): se posa a 45-50 km/h casi sin carrera.</li>`,
  'guide.cierva.landing.stop': `
        <li>Gas a ralentí (<kbd>1</kbd>) y palanca <b>toda atrás</b> (<kbd>S</kbd>): con tan poca carrera, casi se para solo.</li>
        <li>Recto con los pedales (<kbd>Q</kbd>/<kbd>E</kbd>, rueda de cola) y frenos (<kbd>Espacio</kbd>).</li>
        <li>Parado: parking (<kbd>L</kbd>), palanca al centro (<kbd>Inicio</kbd>) y freno de rotor (<kbd>B</kbd>).</li>`,
  'guide.cierva.landing.go': `
        <li>Gas <b>a fondo</b> (<kbd>0</kbd>) con la palanca <b>adelante</b> (<kbd>W</kbd>), sin frenos.</li>
        <li>Hacia 60 km/h tira <b>despacio pero a fondo</b> (<kbd>S</kbd>): se va al aire a ~65-70 km/h.</li>
        <li>Si el rotor ha perdido muchas vueltas, mejor para y vuelve a prerrotar (<kbd>P</kbd>).</li>`,
  'doc.title': 'Autogiro · Simulador sobre el mundo real',
  'lang.label': 'Idioma',
  'common.close': 'Cerrar',

  // menú
  'menu.fly': 'Volar',
  'menu.continue': 'Continuar',
  'menu.customCoords': 'Coordenadas personalizadas…',
  'loc.custom': 'Coordenadas',
  'locgroup.airfield': 'Aeródromos y aeropuertos',
  'locgroup.scenic': 'Paisajes (en vuelo)',
  // sitios emblemáticos por comunidad autónoma (Region en config.ts)
  'locgroup.and': 'Andalucía',
  'locgroup.ara': 'Aragón',
  'locgroup.ast': 'Asturias',
  'locgroup.bal': 'Islas Baleares',
  'locgroup.can': 'Canarias',
  'locgroup.cnt': 'Cantabria',
  'locgroup.clm': 'Castilla-La Mancha',
  'locgroup.cyl': 'Castilla y León',
  'locgroup.cat': 'Cataluña',
  'locgroup.cym': 'Ceuta y Melilla',
  'locgroup.mad': 'Comunidad de Madrid',
  'locgroup.val': 'Comunitat Valenciana',
  'locgroup.ext': 'Extremadura',
  'locgroup.gal': 'Galicia',
  'locgroup.rio': 'La Rioja',
  'locgroup.mur': 'Región de Murcia',
  'locgroup.nav': 'Navarra',
  'locgroup.pv': 'País Vasco',
  'loc.inFlight': 'salida en vuelo a {m} m sobre el suelo',
  'pad.none': '· no detectado',
  'gpu.integrated': '⚠ Gráfica integrada ({name}). Irá lento.',
  'gpu.howto': 'Cómo usar la gráfica dedicada (NVIDIA / AMD)',
  'alert.googleKey': 'Para el escenario fotorrealista necesitas una clave de Google. Mientras tanto, usa «Ortofoto + relieve».',

  // carga
  'load.loading': 'Cargando escenario…',
  'load.refining': 'Afinando el terreno…',
  'load.error': 'Error cargando el escenario: {msg}',

  // avisos breves
  'toast.camera': 'Cámara: {name}',
  'toast.rotorBrakeOn': 'Freno de rotor: PUESTO',
  'toast.rotorBrakeOff': 'Freno de rotor: QUITADO',
  'toast.engineOn': 'Motor: en marcha',
  'toast.engineOff': 'Motor: parado',
  'toast.parkOn': 'Freno de parking: PUESTO',
  'toast.parkOff': 'Freno de parking: QUITADO',
  'toast.lightsOn': 'Luces: ENCENDIDAS',
  'toast.lightsOff': 'Luces: APAGADAS',
  'toast.mouseStickOn': 'Ratón como palanca: SÍ',
  'toast.mouseStickOff': 'Ratón como palanca: NO',
  'toast.wheelThrottle': 'Rueda del ratón: GAS',
  'toast.wheelZoom': 'Rueda del ratón: ZOOM',
  'toast.roomLocation': 'La sala vuela en {name}',

  // indicaciones de pilotaje
  'hint.flare': 'RECOGIDA: mantén S (palanca atrás)',
  'hint.lowRotor': 'Pocas vueltas de rotor: quita gas y prerrota (P)',
  'hint.backside': 'Detrás de la curva de potencia: cede palanca (W) para acelerar',

  // cámaras
  'cam.chase': 'Persecución',
  'cam.cockpit': 'Cabina',
  'cam.orbit': 'Exterior libre',
  'cam.tower': 'Desde tierra',

  // HUD
  'hud.airspeed': 'VELOCIDAD',
  'hud.altitude': 'ALTITUD',
  'hud.vsi': 'VARIÓMETRO',
  'hud.rotor': 'ROTOR',
  'hud.engine': 'MOTOR',
  'hud.throttle': 'GAS',
  'hud.trim': 'TRIM',
  'hud.wind': 'VIENTO',
  'hud.west': 'O',
  'hud.prerot': 'PRERROTADOR',
  'hud.rotorBrake': 'FRENO ROTOR',
  'hud.parkBrake': 'FRENO PARKING',
  'hud.mouseStick': 'RATÓN = PALANCA',
  'hud.wheelThrottle': 'RUEDA = GAS',
  'hud.camera': 'Cámara: {name}',

  // cabina 3D
  'ck.prerot': 'PRERROT',
  'ck.rotBrake': 'FRENO ROT',
  'ck.brake': 'FRENO',
  'ck.rotor': 'ROTOR',
  'ck.engine': 'MOTOR',
  'ck.placard': 'NO ACROBACIAS · NO VUELO EN HIELO',
  'ck.sw.master': 'MASTER',
  'ck.sw.avionics': 'AVIÓNICA',
  'ck.sw.pump1': 'BOMBA 1',
  'ck.sw.pump2': 'BOMBA 2',
  'ck.sw.light': 'LUCES',
  'ck.sw.strobe': 'ESTROBO',
  'ck.sw.rbrake': 'FR. ROTOR',
  'ck.keyBoth': 'AMBOS',
  'ck.keyStart': 'ARRANQUE',
  'ck.fuel': 'COMBUST.',
  'ck.pneu': 'NEUMÁT.',

  // alarmas
  'warn.lowRotor': 'RPM ROTOR BAJAS',
  'warn.teeter': '¡TOPES DE BALANCÍN!',
  'warn.lowG': 'BAJA CARGA (G)',
  'warn.flapping': '¡RIESGO DE FLAPPING!',
  'warn.attitude': 'ACTITUD ANORMAL',

  // accidentes
  'obj.tree': 'un árbol',
  'obj.building': 'un edificio',
  'crash.obstacle.title': 'Colisión con un obstáculo',
  'crash.obstacle.google': 'El aparato ha chocado contra un edificio, árbol o elevación del terreno a {kmh} km/h.',
  'crash.obstacle.hit': 'El aparato ha chocado contra {what} a {kmh} km/h.',
  'crash.collisionWith': 'Colisión con {what}',
  'crash.bladesHit': 'Las palas han golpeado {what}',
  'crash.bladesHit.detail': 'El disco del rotor ha tocado {what} a {kmh} km/h. Una pala que golpea algo girando se parte y desequilibra el rotor.',
  'crash.bladesObstacle': 'Las palas han golpeado un obstáculo',
  'crash.bladesObstacle.detail': 'El disco del rotor ha tocado un edificio, un árbol o el terreno a {kmh} km/h.',
  'crash.flapping.title': 'Batimiento excesivo de palas (flapping)',
  'crash.flapping.ground':
    'Las palas golpearon repetidamente los topes del balancín durante la carrera. Con pocas RPM de rotor y demasiada velocidad, la pala que avanza bate hacia arriba sin control. Prerrota bien, acelera progresivamente con la palanca atrás y deja que el rotor gane vueltas antes de correr.',
  'crash.flapping.air':
    'El disco del rotor se salió de su rango de balanceo y golpeó los topes. Suele ocurrir tras empujar la palanca bruscamente (baja carga), con RPM de rotor muy bajas o en maniobras violentas.',
  'crash.rpm.title': 'Pérdida de RPM del rotor',
  'crash.rpm.detail':
    'El rotor ha perdido sus vueltas y ya no puede sustentar el aparato. En un autogiro las RPM dependen de la carga: si descargas el rotor (palanca adelante brusca, gravedad cero) las vueltas caen. Mantén siempre carga positiva en el rotor.',
  'crash.part.title': 'Impacto en {part}',
  'crash.part.detail': '{Part} ha golpeado el terreno a {kmh} km/h.',
  'crash.mast.detail':
    'El aparato ha volcado. En tierra, con el rotor girando, un autogiro puede volcar si se deja derivar lateralmente o si el disco se inclina demasiado con viento.',
  'crash.gear.title': 'Aterrizaje duro: tren roto',
  'crash.gear.detail':
    'Contacto con {fpm} ft/min de velocidad vertical ({ms} m/s). Recuerda: aproximación estable, recogida (flare) a 3-5 m y toma sobre las ruedas principales casi sin velocidad.',
  'crash.tail.title': 'Golpe de cola',
  'crash.tail.detail': 'La cola ha golpeado el suelo con fuerza: demasiado ángulo de morro arriba en la toma o en la rotación del despegue.',
  'crash.rotor.title': 'Las palas del rotor han golpeado el suelo',
  'crash.rotor.detail':
    'El disco del rotor se ha inclinado tanto que una pala ha tocado el terreno (vuelco dinámico o toma con mucho alabeo). Mantén las alas del disco niveladas cerca del suelo.',
  'crash.prop.title': 'La hélice ha tocado el suelo',
  'crash.prop.detail': 'Demasiado ángulo de morro arriba con la hélice girando (rotación excesiva en el despegue o toma con la cola muy baja).',
  'crash.damage': 'Daños: {list}.',
  'crash.damage.none': 'Daños: estructura aparentemente entera.',
  'crash.seat': 'Deceleración máxima en el asiento: {g} g (promedio de 50 ms) — {verdict}.',
  'crash.fire': 'El depósito de combustible reventó con el impacto y los restos se incendiaron.',
  'crash.verdict.0': 'sin lesiones probables',
  'crash.verdict.1': 'posibles lesiones leves o moderadas',
  'crash.verdict.2': 'lesiones graves probables',
  'crash.verdict.3': 'impacto muy probablemente mortal',
  'crash.slowmo': 'CÁMARA LENTA ×{s} · J: tiempo real · C: cámara',
  'crash.hint': 'J: cámara lenta · C: cámara · ratón: mirar',
  'crash.blades.1': '1 rotura en las palas del rotor',
  'crash.blades.n': '{n} roturas en las palas del rotor',
  'crash.props.1': '1 pala de la hélice',
  'crash.props.n': '{n} palas de la hélice',

  // multijugador
  'mp.defaultName': 'Piloto {n}',
  'mp.title': 'Multijugador',
  'mp.intro': 'Vuela con amigos: crea una sala y pásales el código, o únete con el suyo.',
  'mp.onlineBtn': '¿Amigos en su casa? <b>Jugar por Internet (Cloudflare)</b>',
  'mp.yourName': 'Tu nombre',
  'mp.create': 'Crear sala',
  'mp.or': 'o',
  'mp.codePh': 'CÓDIGO',
  'mp.codeAria': 'Código de sala',
  'mp.join': 'Unirse',
  'mp.room': 'Sala',
  'mp.copyCodeTitle': 'Copiar el código',
  'mp.copyLinkTitle': 'Copiar un enlace que entra directamente en la sala',
  'mp.copyLink': 'Copiar enlace',
  'mp.leave': 'Salir de la sala',
  'mp.collisions': 'Choques entre aparatos',
  'mp.server': 'Servidor de salas',
  'mp.serverPh': 'El de esta página',
  'mp.serverNote': 'Déjalo vacío salvo que las salas estén en otro servidor (p. ej. <code>192.168.1.20:8080</code>).',
  'mp.condNote': 'Las fija el anfitrión de la sala.',
  'mp.chatHint': '<kbd>Intro</kbd> chat',
  'mp.chatPh': 'Mensaje para la sala · Intro envía · Esc cancela',
  'mp.badServer': 'La dirección del servidor no es válida.',
  'mp.connecting': 'Conectando…',
  'mp.reconnecting': 'Conexión perdida. Reconectando ({n})…',
  'mp.lostToast': 'Se ha perdido la conexión con la sala',
  'mp.lostServer': 'Se ha perdido la conexión con el servidor de salas.',
  'mp.cantConnect': 'No se pudo conectar con el servidor de salas ({url}).',
  'mp.badCode': 'El código son {n} letras o números (sin I, O, 0 ni 1).',
  'mp.leftStatus': 'Has salido de la sala {code}.',
  'mp.leftToast': 'Has salido de la sala',
  'mp.roomGone': 'La sala {code} ya no existe',
  'mp.joined': '{name} se ha unido a la sala',
  'mp.left': '{name} ha salido de la sala',
  'mp.nowHostToast': 'Ahora eres el anfitrión de la sala',
  'mp.nowHost': 'Ahora eres el anfitrión: el lugar, la hora y el tiempo los decides tú',
  'mp.newHost': '{name} es ahora el anfitrión',
  'mp.reconnected': 'Reconectado a la sala',
  'mp.createdToast': 'Sala {code} creada: pasa el código a tus amigos',
  'mp.joinedToast': 'Te has unido a la sala {code}',
  'mp.createdSys': 'Sala {code} creada. Eres el anfitrión.',
  'mp.joinedSys': 'Sala {code} · {n} pilotos',
  'mp.hostLocked': 'Lo decide el anfitrión de la sala',
  'mp.midairBoth': 'Choque con otro autogiro',
  'mp.midair': 'Colisión en vuelo',
  'mp.midair.detail': 'Te has chocado con el autogiro de {name} a {kmh} km/h de velocidad relativa.',
  'mp.whereLocal': 'Estás en localhost: el enlace de la sala solo funciona en este ordenador. ',
  'mp.howOnline': 'Cómo jugar por Internet',
  'mp.whereTunnel': 'Compartiendo por Cloudflare: «Copiar enlace» ya sirve para tus amigos.',
  'mp.whereLan': 'Dirección de tu red local: el enlace vale para amigos en la misma wifi.',
  'mp.you': 'tú',
  'mp.host': 'anfitrión',
  'mp.count': '{n}/{max} pilotos',
  'mp.loading': 'cargando…',
  'mp.noSignal': 'sin señal',
  'mp.inMenu': 'en el menú',
  'mp.crashed': 'accidentado',
  'mp.waiting': 'Esperando a otros pilotos…',
  'mp.codeCopied': 'Código copiado',
  'mp.linkCopied': 'Enlace copiado',
  'mp.linkCopiedLocal': 'Enlace copiado, pero solo vale en este ordenador: mira «Jugar por Internet»',
  'mp.cmdCopied': 'Orden copiada',
  'mp.copy': 'Copiar',
  'mp.tags.label': 'Amigos',
  'mp.tags.title': 'Etiquetas de los demás pilotos y flechas hacia los que están fuera de pantalla (Tab)',
  'mp.tags.on': 'Etiquetas de pilotos: VISIBLES',
  'mp.tags.off': 'Etiquetas de pilotos: OCULTAS',
  // edificios del Catastro (src/world/catastro/catastroMenu.ts)
  'catastro.downloading': 'descargando',
  'catastro.processing': 'procesando',
  'catastro.queued': 'en cola',
  'catastro.error': 'falló, se reintentará',
  'catastro.parts': 'partes de edificio',
  'catastro.delete': 'Borrar',
  'catastro.deleteOne': 'Borrar este municipio de este ordenador',
  'catastro.deleteAll': 'Borrar todo',
  'catastro.total': '{n} municipios · {size}',
  'catastro.empty': 'Todavía no hay nada descargado.',
  'catastro.note':
    'Se descargan solos los municipios de alrededor y los que tienes por delante, y se guardan en este ordenador. Lo que borres no se vuelve a bajar hasta la próxima partida.',
}

const en: Dict = {
  'doc.title': 'Autogiro · Gyrocopter simulator over the real world',
  'lang.label': 'Language',
  'common.close': 'Close',

  // ----- index.html -----
  'guide.label': 'Guide',
  'guide.title': 'Flying guide (J)',
  'guide.foot': '<kbd>J</kbd> hides or shows this guide · <kbd>H</kbd> all controls',
  'toast.guideOn': 'Flying guide: SHOWN',
  'toast.guideOff': 'Flying guide: HIDDEN (J to bring it back)',
  'guide.ground.title': 'Gyrocopter takeoff',
  'guide.ground.steps': `
        <li>Rotor brake off (<kbd>B</kbd>) and parking brake on (<kbd>L</kbd>).</li>
        <li>Stick <b>forward</b> (hold <kbd>W</kbd>) and throttle at ~40 % (<kbd>R</kbd>/<kbd>F</kbd>, about 3000 engine rpm).</li>
        <li>Hold the <b>prerotator</b> (<kbd>P</kbd>) up to 200–220 rotor rpm.</li>
        <li>Release <kbd>P</kbd> and the parking brake (<kbd>L</kbd>) together, stick <b>fully back</b> (hold <kbd>S</kbd>) and <b>full throttle</b>.</li>
        <li>It lifts off by itself at ~75 km/h after about 110 m (155 m with a passenger). Then <b>ease the stick forward</b> (taps of <kbd>W</kbd>) to accelerate to 90–100 km/h and climb.</li>`,
  'guide.ground.note':
    'The stick <b>stays where you leave it</b> (watch it in the box on the right): its position sets the airspeed and the throttle sets the height. Short taps = fine adjustment. <kbd>Home</kbd> centres it.',
  'guide.ground.warn':
    'Careful: rolling fast with low rotor rpm causes <b>blade flapping</b>, and pushing the stick forward abruptly unloads the rotor.',
  'guide.flight.title': 'In flight',
  'guide.flight.tips': `
        <li><b>Airspeed with the stick</b>: forward (<kbd>W</kbd>) speeds up, back (<kbd>S</kbd>) slows down. Climb at 90–100 km/h and never go below 60 km/h.</li>
        <li><b>Height with the throttle</b> (<kbd>R</kbd>/<kbd>F</kbd>): more throttle climbs, less throttle descends.</li>
        <li><b>Turns</b>: stick to the side (<kbd>A</kbd>/<kbd>D</kbd>) with a little pedal the same way (<kbd>Q</kbd>/<kbd>E</kbd>) to centre the ball.</li>
        <li><b>Never push the stick forward abruptly</b>: it unloads the rotor, which loses rpm, and you can lose control.</li>
        <li><b>Engine off</b> it glides at ~100 km/h, sinking about 6 m/s.</li>`,
  'guide.flight.landTitle': 'To land',
  'guide.flight.land': `
        <li>Line up with the runway from far out and reduce throttle (<kbd>F</kbd>; <kbd>1</kbd> = idle).</li>
        <li>Hold ~100 km/h with the stick until close to the ground.</li>
        <li>At 6–8 m above the ground (20–25 ft) <b>flare</b>: hold <kbd>S</kbd> until you touch down, throttle closed.</li>`,
  'guide.landing.title': 'On the ground: stop or take off again?',
  'guide.landing.choose': 'The throttle decides: <b>idle</b> to stop, <b>full</b> for a touch-and-go. Whatever you are doing is highlighted.',
  'guide.landing.stopTitle': 'To stop',
  'guide.landing.stop': `
        <li>Throttle to idle (<kbd>1</kbd>) and <b>stick fully back</b> (<kbd>S</kbd>): the disc brakes like a parachute.</li>
        <li>Keep straight with the pedals (<kbd>Q</kbd>/<kbd>E</kbd>); brake (<kbd>Space</kbd>) once the nose wheel is down.</li>
        <li>Stopped: parking brake (<kbd>L</kbd>), stick centred (<kbd>Home</kbd>) and rotor brake (<kbd>B</kbd>).</li>`,
  'guide.landing.goTitle': 'To take off again',
  'guide.landing.go': `
        <li>Stick <b>fully back</b> (<kbd>S</kbd>) and <b>full throttle</b> (<kbd>0</kbd>), no brakes.</li>
        <li>The rotor is already turning: it lifts off again at ~75 km/h. Then <b>ease the stick forward</b> (taps of <kbd>W</kbd>) to 90–100 km/h.</li>
        <li>If rotor rpm has dropped below ~200, better stop and prerotate (<kbd>P</kbd>): with low rpm the blades flap.</li>`,
  'guide.cierva.ground.title': "Cierva C.30A takeoff",
  'guide.cierva.ground.steps': `
        <li>Rotor brake off (<kbd>B</kbd>) and parking brake on (<kbd>L</kbd>).</li>
        <li>Stick <b>forward</b> (hold <kbd>W</kbd>) and throttle at ~40 % (<kbd>R</kbd>/<kbd>F</kbd>, about 1200 engine rpm).</li>
        <li>Hold the <b>prerotator</b> (<kbd>P</kbd>): its clutch spins the rotor up to about 180 rpm.</li>
        <li>Release <kbd>P</kbd> and the parking brake (<kbd>L</kbd>) — on the C.30 a single lever freed the brakes and the clutch together — and open to <b>full throttle</b> with the stick still <b>forward</b>: the disc drags as little as possible and the aircraft accelerates, even though the rotor loses rpm.</li>
        <li>At about 60 km/h pull the stick back <b>slowly but fully</b> (hold <kbd>S</kbd>): the rotor speeds up and it lifts off at ~65–70 km/h after about 125 m (165 m with a passenger). Climb at about 85 km/h (some 3 m/s solo, half that with a passenger).</li>`,
  'guide.cierva.ground.note': "<b>Direct control</b>: the stick hangs from the rotor head and tilts the whole head (which is why it moves the opposite way to your hand). <b>There is no rudder</b>: the pedals only steer the tail wheel on the ground; in the air you turn by tilting the disc.",
  'guide.cierva.ground.warn': "It is <b>slightly unstable in roll</b>, as the RAE test pilots noted: correct with the stick. Closing the throttle swings it left and opening it swings it right.",
  'guide.cierva.flight.tips': `
        <li><b>Airspeed with the stick</b>: forward (<kbd>W</kbd>) speeds up, back (<kbd>S</kbd>) slows down. Climb at about 85 km/h.</li>
        <li><b>Height with the throttle</b> (<kbd>R</kbd>/<kbd>F</kbd>): more throttle climbs, less throttle descends.</li>
        <li><b>Turn with the stick only</b> (<kbd>A</kbd>/<kbd>D</kbd>): it tilts the whole disc; there is no rudder.</li>
        <li>It is <b>slightly unstable in roll</b>: correct with the stick. Closing the throttle swings it left and opening it swings it right.</li>
        <li><b>Engine off</b> it glides at ~100 km/h, sinking about 6 m/s.</li>`,
  'guide.cierva.flight.land': `
        <li>Line up with the runway from far out and reduce throttle (<kbd>F</kbd>; <kbd>1</kbd> = idle).</li>
        <li>Hold ~100 km/h with the stick until close to the ground.</li>
        <li>Flare at about 6–8 m above the ground (hold <kbd>S</kbd>): it settles at 45–50 km/h with almost no ground roll.</li>`,
  'guide.cierva.landing.stop': `
        <li>Throttle to idle (<kbd>1</kbd>) and stick <b>fully back</b> (<kbd>S</kbd>): with so little ground roll it nearly stops by itself.</li>
        <li>Keep straight with the pedals (<kbd>Q</kbd>/<kbd>E</kbd>, tail wheel) and brakes (<kbd>Space</kbd>).</li>
        <li>Stopped: parking brake (<kbd>L</kbd>), stick centred (<kbd>Home</kbd>) and rotor brake (<kbd>B</kbd>).</li>`,
  'guide.cierva.landing.go': `
        <li><b>Full throttle</b> (<kbd>0</kbd>) with the stick <b>forward</b> (<kbd>W</kbd>), no brakes.</li>
        <li>At about 60 km/h pull back <b>slowly but fully</b> (<kbd>S</kbd>): it lifts off at ~65–70 km/h.</li>
        <li>If the rotor has lost a lot of rpm, better stop and prerotate again (<kbd>P</kbd>).</li>`,
  'help.title': 'Controls',
  'help.keys': `
        <div><kbd>W</kbd><kbd>S</kbd> / <kbd>↑</kbd><kbd>↓</kbd></div><div>Stick forward / back (holds its position; <kbd>Home</kbd> centres it)</div>
        <div><kbd>A</kbd><kbd>D</kbd> / <kbd>←</kbd><kbd>→</kbd></div><div>Stick left / right</div>
        <div><kbd>Q</kbd><kbd>E</kbd> (<kbd>Z</kbd><kbd>X</kbd>)</div><div>Pedals (rudder and nose wheel)</div>
        <div><kbd>R</kbd><kbd>F</kbd> · <kbd>1</kbd>…<kbd>0</kbd></div><div>Throttle (− / +) · fixed settings</div>
        <div><kbd>T</kbd><kbd>G</kbd></div><div>Trim (nose down / up)</div>
        <div><kbd>P</kbd> (hold)</div><div>Prerotator</div>
        <div><kbd>B</kbd></div><div>Rotor brake</div>
        <div><kbd>Space</kbd> · <kbd>L</kbd></div><div>Wheel brakes · parking brake</div>
        <div><kbd>M</kbd></div><div>Engine on / off</div>
        <div><kbd>O</kbd></div><div>Exterior lights (navigation, strobes and landing)</div>
        <div><kbd>Tab</kbd></div><div>Labels and arrows for the other pilots (multiplayer)</div>
        <div><kbd>C</kbd> · <kbd>V</kbd></div><div>Change camera · look back</div>
        <div>Mouse (drag) · wheel</div><div>Look around · zoom</div>
        <div><kbd>K</kbd> · middle button</div><div>Mouse as stick · in that mode, wheel = zoom / throttle</div>
        <div><kbd>J</kbd></div><div>Side flying guide (takeoff, flight and landing)</div>
        <div><kbd>I</kbd> · <kbd>H</kbd></div><div>Hide instruments · this help</div>
        <div><kbd>Backspace</kbd> · <kbd>Esc</kbd></div><div>Restart · menu</div>`,
  'help.pad':
    'Xbox-style gamepad: left stick = stick, right stick = pedals, triggers = throttle, A = prerotator, B = brakes, LB/RB = trim. Joystick: axes configurable in the menu.',
  'crash.eyebrow': 'Crash',
  'crash.retry': 'Retry',
  'crash.menu': 'Menu',
  'menu.tagline': 'Fly a gyrocopter over the real world',
  'menu.credit':
    'Made with ❤️ by <a href="https://creativecode.es/" target="_blank" rel="noopener noreferrer"><strong>Mario</strong></a> · <a href="https://ko-fi.com/mario_creativecode" target="_blank" rel="noopener noreferrer">☕ Buy me a coffee</a>',
  'menu.scenery': 'Scenery',
  'menu.google':
    '<b>Google Photorealistic 3D</b><small>Real buildings, trees and terrain in 3D. Needs a Google Maps Platform key.</small>',
  'menu.terrain':
    '<b>Orthophoto + terrain</b><small>No key needed. PNOA orthophoto over the IGN 5 m terrain model, with OpenStreetMap buildings in 3D (outside Spain: Esri imagery and global terrain).</small>',
  'menu.googleKey': 'Google API key (Map Tiles API)',
  'menu.keyHow': 'How do I get a key?',
  'menu.keySteps': `
                  <li>Go to <a href="https://console.cloud.google.com/" target="_blank" rel="noopener">console.cloud.google.com</a> and create a project.</li>
                  <li>Enable billing (there is a free monthly quota).</li>
                  <li>In “APIs &amp; Services”, enable the <b>Map Tiles API</b>.</li>
                  <li>In “Credentials”, create an <b>API key</b>; restrict it to the Map Tiles API and, if you like, to <code>http://localhost:5173</code>.</li>
                  <li>Paste it here. It is only stored in this browser.</li>`,
  'menu.imagery': 'Orthophoto (no-key mode)',
  'menu.imagery.auto': 'Automatic (PNOA in Spain)',
  'menu.imagery.pnoa': 'PNOA · IGN (Spain)',
  'menu.elevation': 'Terrain (no-key mode)',
  'menu.elevation.auto': 'Automatic (IGN 5 m DTM in Spain)',
  'menu.elevation.global': 'Global ~30 m (Mapzen/AWS)',
  'menu.buildings': 'OpenStreetMap 3D buildings (no-key mode)',
  'menu.trees': '3D trees detected in the orthophoto (no-key mode)',
  'menu.catastro': 'Add the Spanish Land Registry (Catastro) buildings (Spain, downloaded by municipality)',
  'menu.catastroData': 'Downloaded Catastro data',
  'catastro.downloading': 'downloading',
  'catastro.processing': 'processing',
  'catastro.queued': 'queued',
  'catastro.error': 'failed, will retry',
  'catastro.parts': 'building parts',
  'catastro.delete': 'Delete',
  'catastro.deleteOne': 'Delete this municipality from this computer',
  'catastro.deleteAll': 'Delete all',
  'catastro.total': '{n} municipalities · {size}',
  'catastro.empty': 'Nothing downloaded yet.',
  'catastro.note':
    'Municipalities around you and ahead of you are downloaded automatically and kept on this computer. Anything you delete is not downloaded again until your next session.',
  'menu.start': 'Start',
  'menu.aircraft': 'Aircraft',
  'menu.location': 'Location',
  'menu.lat': 'Latitude',
  'menu.lon': 'Longitude',
  'menu.onRunway': 'On the runway',
  'menu.inFlight': 'In flight',
  'menu.passenger': 'With passenger (MTOW)',
  'menu.conditions': 'Conditions',
  'menu.hour': 'Time',
  'menu.date': 'Date',
  'menu.windFrom': 'Wind from',
  'menu.windSpeed': 'Wind speed',
  'menu.turbulence': 'Turbulence',
  'menu.clouds': 'Clouds',
  'menu.clouds.clear': 'Clear',
  'menu.clouds.fair': 'Fair-weather cumulus',
  'menu.clouds.scattered': 'Scattered clouds',
  'menu.clouds.overcast': 'Overcast',
  'menu.gfx': 'Graphics & controls',
  'menu.quality': 'Quality',
  'menu.quality.auto': 'Automatic (based on your GPU)',
  'menu.quality.low': 'Low (integrated graphics)',
  'menu.quality.medium': 'Medium',
  'menu.quality.high': 'High',
  'menu.quality.ultra': 'Ultra (powerful GPU)',
  'menu.exposure': 'Exposure',
  'menu.volume': 'Volume',
  'menu.assist': 'Flying assist (damps the phugoid, levels the wings, coordinates the pedals and moderates the flare)',
  'menu.invertPitch': 'Invert pitch',
  'menu.mouseStick': 'Mouse as stick (<kbd>K</kbd>)',
  'menu.axisPitch': 'Pitch axis',
  'menu.axisRoll': 'Roll axis',
  'menu.axisYaw': 'Pedal axis',
  'menu.axisThrottle': 'Throttle axis',
  'menu.invertThrottle': 'Invert throttle axis',
  'menu.footer': '<kbd>H</kbd> controls · <kbd>Esc</kbd> this menu · <kbd>C</kbd> cameras',
  'menu.blog': 'More projects at <b>creativecode.es</b> <span aria-hidden="true">↗</span>',
  'menu.viewControls': 'View controls',

  // ----- código -----
  'menu.fly': 'Fly',
  'menu.continue': 'Continue',
  'menu.customCoords': 'Custom coordinates…',
  'loc.custom': 'Coordinates',
  'locgroup.airfield': 'Airfields and airports',
  'locgroup.scenic': 'Scenery (in flight)',
  'locgroup.and': 'Andalusia',
  'locgroup.ara': 'Aragon',
  'locgroup.ast': 'Asturias',
  'locgroup.bal': 'Balearic Islands',
  'locgroup.can': 'Canary Islands',
  'locgroup.cnt': 'Cantabria',
  'locgroup.clm': 'Castilla-La Mancha',
  'locgroup.cyl': 'Castile and León',
  'locgroup.cat': 'Catalonia',
  'locgroup.cym': 'Ceuta and Melilla',
  'locgroup.mad': 'Madrid region',
  'locgroup.val': 'Valencian Community',
  'locgroup.ext': 'Extremadura',
  'locgroup.gal': 'Galicia',
  'locgroup.rio': 'La Rioja',
  'locgroup.mur': 'Murcia',
  'locgroup.nav': 'Navarre',
  'locgroup.pv': 'Basque Country',
  'loc.inFlight': 'starts in flight, {m} m above the ground',
  'pad.none': '· not detected',
  'gpu.integrated': '⚠ Integrated graphics ({name}). It will run slowly.',
  'gpu.howto': 'How to use the dedicated GPU (NVIDIA / AMD)',
  'alert.googleKey': 'The photorealistic scenery needs a Google key. In the meantime, use “Orthophoto + terrain”.',

  'load.loading': 'Loading scenery…',
  'load.refining': 'Refining the terrain…',
  'load.error': 'Error loading the scenery: {msg}',

  'toast.camera': 'Camera: {name}',
  'toast.rotorBrakeOn': 'Rotor brake: ON',
  'toast.rotorBrakeOff': 'Rotor brake: OFF',
  'toast.engineOn': 'Engine: running',
  'toast.engineOff': 'Engine: stopped',
  'toast.parkOn': 'Parking brake: ON',
  'toast.parkOff': 'Parking brake: OFF',
  'toast.lightsOn': 'Lights: ON',
  'toast.lightsOff': 'Lights: OFF',
  'lights.label': 'Lights',
  'lights.title': 'Exterior lights (O)',
  'toast.mouseStickOn': 'Mouse as stick: ON',
  'toast.mouseStickOff': 'Mouse as stick: OFF',
  'toast.wheelThrottle': 'Mouse wheel: THROTTLE',
  'toast.wheelZoom': 'Mouse wheel: ZOOM',
  'toast.roomLocation': 'The room is flying at {name}',

  'hint.flare': 'FLARE: hold S (stick back)',
  'hint.lowRotor': 'Low rotor rpm: cut the throttle and prerotate (P)',
  'hint.backside': 'Behind the power curve: ease the stick forward (W) to accelerate',

  'cam.chase': 'Chase',
  'cam.cockpit': 'Cockpit',
  'cam.orbit': 'Free orbit',
  'cam.tower': 'From the ground',

  'hud.airspeed': 'AIRSPEED',
  'hud.altitude': 'ALTITUDE',
  'hud.vsi': 'VERT SPEED',
  'hud.rotor': 'ROTOR',
  'hud.engine': 'ENGINE',
  'hud.throttle': 'THR',
  'hud.trim': 'TRIM',
  'hud.wind': 'WIND',
  'hud.west': 'W',
  'hud.prerot': 'PREROTATOR',
  'hud.rotorBrake': 'ROTOR BRAKE',
  'hud.parkBrake': 'PARKING BRAKE',
  'hud.mouseStick': 'MOUSE = STICK',
  'hud.wheelThrottle': 'WHEEL = THROTTLE',
  'hud.camera': 'Camera: {name}',

  'ck.prerot': 'PREROT',
  'ck.rotBrake': 'ROT BRK',
  'ck.brake': 'BRAKE',
  'ck.rotor': 'ROTOR',
  'ck.engine': 'ENGINE',
  'ck.placard': 'NO AEROBATICS · NO FLIGHT INTO ICING',
  'ck.sw.master': 'MASTER',
  'ck.sw.avionics': 'AVIONICS',
  'ck.sw.pump1': 'PUMP 1',
  'ck.sw.pump2': 'PUMP 2',
  'ck.sw.light': 'LIGHTS',
  'ck.sw.strobe': 'STROBE',
  'ck.sw.rbrake': 'ROT BRK',
  'ck.keyBoth': 'BOTH',
  'ck.keyStart': 'START',
  'ck.fuel': 'FUEL',
  'ck.pneu': 'PNEU',

  'warn.lowRotor': 'LOW ROTOR RPM',
  'warn.teeter': 'TEETER STOP STRIKE!',
  'warn.lowG': 'LOW G',
  'warn.flapping': 'BLADE FLAPPING RISK!',
  'warn.attitude': 'UNUSUAL ATTITUDE',

  'obj.tree': 'a tree',
  'obj.building': 'a building',
  'crash.obstacle.title': 'Collision with an obstacle',
  'crash.obstacle.google': 'The aircraft hit a building, a tree or rising ground at {kmh} km/h.',
  'crash.obstacle.hit': 'The aircraft hit {what} at {kmh} km/h.',
  'crash.collisionWith': 'Collision with {what}',
  'crash.bladesHit': 'The blades hit {what}',
  'crash.bladesHit.detail': 'The rotor disc touched {what} at {kmh} km/h. A spinning blade that hits something breaks and throws the rotor out of balance.',
  'crash.bladesObstacle': 'The blades hit an obstacle',
  'crash.bladesObstacle.detail': 'The rotor disc touched a building, a tree or the ground at {kmh} km/h.',
  'crash.flapping.title': 'Excessive blade flapping',
  'crash.flapping.ground':
    'The blades repeatedly struck the teeter stops during the takeoff run. With low rotor rpm and too much speed, the advancing blade flaps up out of control. Prerotate properly, accelerate progressively with the stick back and let the rotor build up rpm before running fast.',
  'crash.flapping.air':
    'The rotor disc went beyond its teeter range and hit the stops. This usually follows an abrupt forward push on the stick (low g), very low rotor rpm or violent manoeuvres.',
  'crash.rpm.title': 'Loss of rotor rpm',
  'crash.rpm.detail':
    'The rotor has lost its rpm and can no longer hold the aircraft up. In a gyrocopter rotor rpm depends on load: if you unload the rotor (abrupt forward stick, zero g) the rpm decays. Always keep positive load on the rotor.',
  'crash.part.title': 'Impact on {part}',
  'crash.part.detail': '{Part} hit the ground at {kmh} km/h.',
  'crash.mast.detail':
    'The aircraft has rolled over. On the ground, with the rotor turning, a gyrocopter can roll over if it is allowed to drift sideways or if the disc tilts too far in the wind.',
  'crash.gear.title': 'Hard landing: landing gear broken',
  'crash.gear.detail':
    'Touchdown at {fpm} ft/min vertical speed ({ms} m/s). Remember: stable approach, flare at 3–5 m and touch down on the main wheels with almost no speed.',
  'crash.tail.title': 'Tail strike',
  'crash.tail.detail': 'The tail hit the ground hard: too much nose-up attitude on landing or when rotating for takeoff.',
  'crash.rotor.title': 'The rotor blades struck the ground',
  'crash.rotor.detail':
    'The rotor disc tilted so far that a blade touched the ground (dynamic rollover or landing with a lot of bank). Keep the disc level close to the ground.',
  'crash.prop.title': 'Propeller strike',
  'crash.prop.detail': 'Too much nose-up attitude with the propeller turning (over-rotation on takeoff or landing with the tail very low).',
  'crash.damage': 'Damage: {list}.',
  'crash.damage.none': 'Damage: structure apparently intact.',
  'crash.seat': 'Peak seat deceleration: {g} g (50 ms average) — {verdict}.',
  'crash.fire': 'The fuel tank ruptured on impact and the wreckage caught fire.',
  'crash.verdict.0': 'injuries unlikely',
  'crash.verdict.1': 'possible minor or moderate injuries',
  'crash.verdict.2': 'serious injuries likely',
  'crash.verdict.3': 'very probably a fatal impact',
  'crash.slowmo': 'SLOW MOTION ×{s} · J: real time · C: camera',
  'crash.hint': 'J: slow motion · C: camera · mouse: look around',
  'crash.blades.1': '1 break in the rotor blades',
  'crash.blades.n': '{n} breaks in the rotor blades',
  'crash.props.1': '1 propeller blade',
  'crash.props.n': '{n} propeller blades',

  'mp.defaultName': 'Pilot {n}',
  'mp.title': 'Multiplayer',
  'mp.intro': 'Fly with friends: create a room and send them the code, or join with theirs.',
  'mp.onlineBtn': 'Friends at home? <b>Play over the Internet (Cloudflare)</b>',
  'mp.yourName': 'Your name',
  'mp.create': 'Create room',
  'mp.or': 'or',
  'mp.codePh': 'CODE',
  'mp.codeAria': 'Room code',
  'mp.join': 'Join',
  'mp.room': 'Room',
  'mp.copyCodeTitle': 'Copy the code',
  'mp.copyLinkTitle': 'Copy a link that goes straight into the room',
  'mp.copyLink': 'Copy link',
  'mp.leave': 'Leave room',
  'mp.collisions': 'Collisions between aircraft',
  'mp.server': 'Room server',
  'mp.serverPh': 'This page’s server',
  'mp.serverNote': 'Leave it empty unless the rooms are on another server (e.g. <code>192.168.1.20:8080</code>).',
  'mp.condNote': 'Set by the room host.',
  'mp.chatHint': '<kbd>Enter</kbd> chat',
  'mp.chatPh': 'Message to the room · Enter sends · Esc cancels',
  'mp.badServer': 'The server address is not valid.',
  'mp.connecting': 'Connecting…',
  'mp.reconnecting': 'Connection lost. Reconnecting ({n})…',
  'mp.lostToast': 'Lost the connection to the room',
  'mp.lostServer': 'Lost the connection to the room server.',
  'mp.cantConnect': 'Could not connect to the room server ({url}).',
  'mp.badCode': 'The code is {n} letters or digits (no I, O, 0 or 1).',
  'mp.leftStatus': 'You left room {code}.',
  'mp.leftToast': 'You left the room',
  'mp.roomGone': 'Room {code} no longer exists',
  'mp.joined': '{name} joined the room',
  'mp.left': '{name} left the room',
  'mp.nowHostToast': 'You are now the room host',
  'mp.nowHost': 'You are now the host: you choose the location, time and weather',
  'mp.newHost': '{name} is now the host',
  'mp.reconnected': 'Reconnected to the room',
  'mp.createdToast': 'Room {code} created: share the code with your friends',
  'mp.joinedToast': 'You joined room {code}',
  'mp.createdSys': 'Room {code} created. You are the host.',
  'mp.joinedSys': 'Room {code} · {n} pilots',
  'mp.hostLocked': 'Set by the room host',
  'mp.midairBoth': 'Collision with another gyrocopter',
  'mp.midair': 'Mid-air collision',
  'mp.midair.detail': 'You collided with {name}’s gyrocopter at a relative speed of {kmh} km/h.',
  'mp.whereLocal': 'You are on localhost: the room link only works on this computer. ',
  'mp.howOnline': 'How to play over the Internet',
  'mp.whereTunnel': 'Sharing through Cloudflare: “Copy link” already works for your friends.',
  'mp.whereLan': 'Local network address: the link works for friends on the same wifi.',
  'mp.you': 'you',
  'mp.host': 'host',
  'mp.count': '{n}/{max} pilots',
  'mp.loading': 'loading…',
  'mp.noSignal': 'no signal',
  'mp.inMenu': 'in the menu',
  'mp.crashed': 'crashed',
  'mp.waiting': 'Waiting for other pilots…',
  'mp.codeCopied': 'Code copied',
  'mp.linkCopied': 'Link copied',
  'mp.linkCopiedLocal': 'Link copied, but it only works on this computer: see “Play over the Internet”',
  'mp.cmdCopied': 'Command copied',
  'mp.copy': 'Copy',
  'mp.tags.label': 'Friends',
  'mp.tags.title': 'Labels on the other pilots and arrows to those off screen (Tab)',
  'mp.tags.on': 'Pilot labels: ON',
  'mp.tags.off': 'Pilot labels: OFF',
  'mp.err.noroom': 'That room does not exist',
  'mp.err.full': 'The room or the server is full, try again later',
  'mp.err.badcode': 'Invalid room code',
  'mp.err.proto': 'Version mismatch with the room server',

  // lugares (config.ts) y aparatos (catalog.ts)
  'loc.lemt08': 'Casarrubios (LEMT) · runway 08 threshold',
  'loc.lemt26': 'Casarrubios (LEMT) · runway 26 threshold',
  'loc.lemt-air': 'Casarrubios circuit (in flight)',
  'loc.lecu27': 'Madrid-Cuatro Vientos (LECU) · runway 27 threshold',
  'loc.lecu09': 'Madrid-Cuatro Vientos (LECU) · runway 09 threshold',
  'loc.lemd36l': 'Madrid-Barajas (LEMD) · runway 36L threshold',
  'loc.lemd-final32l': 'Madrid-Barajas (LEMD) · final 32L (in flight)',
  'loc.lebl24l': 'Barcelona-El Prat (LEBL) · runway 24L threshold',
  'loc.lepa24l': 'Palma de Mallorca (LEPA) · runway 24L threshold',
  'loc.lemg13': 'Málaga-Costa del Sol (LEMG) · runway 13 threshold',
  'loc.lezl27': 'Seville-San Pablo (LEZL) · runway 27 threshold',
  'loc.levc12': 'Valencia-Manises (LEVC) · runway 12 threshold',
  'loc.lebb30': 'Bilbao (LEBB) · runway 30 threshold',
  'loc.gcxo30': 'Tenerife North-Los Rodeos (GCXO) · runway 30 threshold',
  'loc.gclp03l': 'Gran Canaria (GCLP) · runway 03L threshold',
  'loc.lemt08.note': 'Runway 08/26 · 948 m · asphalt',
  'loc.lemt26.note': 'Runway 08/26 · 948 m · asphalt',
  'loc.lemt-air.note': 'Downwind leg, 1000 ft above the field',
  'loc.lecu27.note': 'Runway 09/27 · 1500 m · asphalt · the oldest airfield in Spain (1911)',
  'loc.lecu09.note': 'Runway 09/27 · 1500 m · asphalt',
  'loc.lemd36l.note': 'Runway 18R/36L · 4350 m · north-flow departures',
  'loc.lemd-final32l.note': 'Final approach to 32L, 3 NM, 1000 ft',
  'loc.lebl24l.note': 'Runway 06R/24L · 2660 m · next to the beach',
  'loc.lepa24l.note': 'Runway 06R/24L · 3000 m',
  'loc.lemg13.note': 'Runway 13/31 · 3200 m · departing towards the sea',
  'loc.lezl27.note': 'Runway 09/27 · 3360 m',
  'loc.levc12.note': 'Runway 12/30 · 3200 m · towards the city and the sea',
  'loc.lebb30.note': 'Runway 12/30 · 2600 m · between hills',
  'loc.gcxo30.note': 'Runway 12/30 · 3400 m · 630 m elevation, with Teide in the background',
  'loc.gclp03l.note': 'Runway 03L/21R · 3100 m · by the sea',
  // sitios emblemáticos (los nombres sin entrada se quedan como en español)
  'loc.cabogata': 'Cabo de Gata · lighthouse and Sirens Reef',
  'loc.cabogata.note': 'Almería · over the salt pans towards the lighthouse and the volcanic reefs',
  'loc.cadiz': 'Cádiz · cathedral and seafront',
  'loc.cadiz.note': 'Cádiz · coming in from the sea towards the golden dome',
  'loc.mezquita': 'Córdoba · Mosque-Cathedral',
  'loc.mezquita.note': 'Córdoba · crossing the Guadalquivir over the Roman bridge',
  'loc.alhambra': 'Granada · The Alhambra',
  'loc.alhambra.note': 'Granada · from the Albaicín, with Sierra Nevada behind',
  'loc.rocio': 'Doñana · El Rocío and the marshes',
  'loc.rocio.note': 'Huelva · the shrine and, beyond it, the Doñana marshes',
  'loc.jaen': 'Jaén · cathedral and Santa Catalina castle',
  'loc.jaen.note': 'Jaén · over the cathedral towards the hilltop castle',
  'loc.ronda': 'Ronda · gorge and Puente Nuevo',
  'loc.ronda.note': 'Málaga · from the valley, facing the bridge over the gorge',
  'loc.giralda': 'Seville · cathedral and Giralda',
  'loc.giralda.note': 'Seville · past the Torre del Oro towards the cathedral',
  'loc.ordesa': 'Ordesa Valley',
  'loc.ordesa.note': 'Huesca · up the canyon from the Pradera towards the Soaso cirque and Monte Perdido',
  'loc.albarracin.note': 'Teruel · the village in the river bend and its walls up the hill',
  'loc.pilar': 'Zaragoza · Basilica del Pilar',
  'loc.pilar.note': 'Zaragoza · crossing the Ebro towards the towers and domes',
  'loc.covadonga': 'Covadonga · basilica and lakes',
  'loc.covadonga.note': 'Asturias · the basilica and, up the valley, the lakes and the Picos de Europa',
  'loc.timanfaya.note': 'Las Palmas · Fire Mountains and lava fields',
  'loc.roquenublo.note': 'Las Palmas · the monolith on the summit, with Teide on the horizon',
  'loc.teide': 'Tenerife · Mount Teide and Las Cañadas',
  'loc.teide.note': 'Santa Cruz de Tenerife · across Las Cañadas, with Teide on your right',
  'loc.cabarceno': 'Cabárceno · nature park',
  'loc.cabarceno.note': 'Cantabria · the karst of the old mine where the animals live',
  'loc.alcalajucar.note': 'Albacete · along the Júcar gorge to the cliffside village',
  'loc.criptana': 'Campo de Criptana · windmills',
  'loc.criptana.note': 'Ciudad Real · the windmills on the ridge, over La Mancha',
  'loc.cuenca': 'Cuenca · Hanging Houses',
  'loc.cuenca.note': 'Cuenca · over the Huécar gorge towards the old town',
  'loc.siguenza': 'Sigüenza · castle and cathedral',
  'loc.siguenza.note': 'Guadalajara · the castle on top and the cathedral below',
  'loc.toledo': 'Toledo · old town',
  'loc.toledo.note': 'Toledo · the city in the Tagus bend, with the Alcázar and the cathedral',
  'loc.avila': 'Ávila · city walls',
  'loc.avila.note': 'Ávila · from the Cuatro Postes, the whole walled town',
  'loc.gredos': 'Sierra de Gredos · Almanzor peak',
  'loc.gredos.note': 'Ávila · the glacial cirque and Laguna Grande',
  'loc.burgos': 'Burgos · cathedral',
  'loc.burgos.note': 'Burgos · over the Arlanzón towards the Gothic spires',
  'loc.medulas.note': 'León · the Roman gold mine, from the Orellán viewpoint',
  'loc.otero': 'Palencia · cathedral and Cristo del Otero',
  'loc.otero.note': 'Palencia · over the cathedral towards the hilltop Christ',
  'loc.salamanca': 'Salamanca · cathedrals and Roman bridge',
  'loc.salamanca.note': 'Salamanca · crossing the Tormes towards the two cathedrals',
  'loc.segovia': 'Segovia · Aqueduct and Alcázar',
  'loc.segovia.note': 'Segovia · the Roman aqueduct and the Alcázar above the Eresma',
  'loc.riolobos': 'Río Lobos Canyon',
  'loc.riolobos.note': 'Soria · up the canyon to the Templar chapel of San Bartolomé',
  'loc.penafiel': 'Peñafiel · castle',
  'loc.penafiel.note': 'Valladolid · the ship-shaped castle over the Ribera del Duero',
  'loc.sanabria': 'Lake Sanabria',
  'loc.sanabria.note': 'Zamora · the largest glacial lake in Iberia',
  'loc.sagrada': 'Barcelona · Sagrada Família',
  'loc.sagrada.note': 'Barcelona · from the sea over the Eixample; the towers reach 172 m',
  'loc.montserrat.note': 'Barcelona · up the Llobregat, with the monastery and the rock pinnacles on your left',
  'loc.creus': 'Cap de Creus and Cadaqués',
  'loc.creus.note': 'Girona · the easternmost point of the peninsula',
  'loc.montrebei': 'Mont-rebei Gorge',
  'loc.montrebei.note': 'Lleida · into the Montsec cut, with 500 m walls on both sides',
  'loc.tarragona': 'Tarragona · Roman amphitheatre',
  'loc.tarragona.note': 'Tarragona · from the sea, with the old town and cathedral behind',
  'loc.ceuta.note': 'Ceuta · the Almina peninsula, with Gibraltar to the north',
  'loc.melilla': 'Melilla · old town',
  'loc.melilla.note': 'Melilla · the walled citadel above the sea',
  'loc.madrid': 'Madrid · Royal Palace',
  'loc.madrid.note': 'Madrid · the palace, Almudena cathedral and the Campo del Moro',
  'loc.escorial.note': 'Madrid · the monastery at the foot of Mount Abantos',
  'loc.ifach': 'Calp · Rock of Ifach',
  'loc.ifach.note': 'Alicante · the 332 m rock rising from the sea',
  'loc.peniscola': 'Peñíscola · Papa Luna castle',
  'loc.peniscola.note': 'Castellón · the walled town on its rocky headland',
  'loc.cac': 'Valencia · City of Arts and Sciences',
  'loc.cac.note': 'Valencia · along the old Turia riverbed from the port',
  'loc.merida': 'Mérida · Roman theatre and bridge',
  'loc.merida.note': 'Badajoz · over the Roman bridge on the Guadiana towards the theatre',
  'loc.monfrague': 'Monfragüe · castle and Tagus',
  'loc.monfrague.note': 'Cáceres · the deep Tagus and the castle on the ridge',
  'loc.santiago': 'Santiago de Compostela · cathedral',
  'loc.santiago.note': 'A Coruña · facing the Obradoiro façade',
  'loc.catedrales': 'Cathedrals Beach',
  'loc.catedrales.note': 'Lugo · the rock arches on the Ribadeo coast',
  'loc.sil': 'Sil Canyon · Ribeira Sacra',
  'loc.sil.note': 'Ourense · down the canyon, with Santo Estevo on the slope',
  'loc.cies': 'Cíes Islands',
  'loc.cies.note': 'Pontevedra · from the Vigo estuary towards Rodas beach',
  'loc.esvedra.note': 'Ibiza · the 382 m islet off Cala d’Hort',
  'loc.formentor': 'Mallorca · Cap de Formentor',
  'loc.formentor.note': 'Mallorca · along the peninsula to the lighthouse',
  'loc.sanmillan': 'San Millán de la Cogolla · Yuso and Suso',
  'loc.sanmillan.note': 'La Rioja · the monasteries where Spanish was first written',
  'loc.bardenas.note': 'Navarre · the badlands of gullies and buttes',
  'loc.zugarramurdi': 'Zugarramurdi · witches’ cave',
  'loc.zugarramurdi.note': 'Navarre · meadows and the coven cave, by the French border',
  'loc.anana': 'Añana Salt Valley',
  'loc.anana.note': 'Álava · the terraced salt pans in the valley',
  'loc.gaztelugatxe.note': 'Biscay · the hermitage on the islet and its stone stairway',
  'loc.concha': 'San Sebastián · La Concha Bay',
  'loc.concha.note': 'Gipuzkoa · from Igueldo, the bay and Santa Clara island',
  'loc.lamanga.note': 'Murcia · from Cabo de Palos, the sea on the right and the Mar Menor on the left',
  'ac.generic': 'Generic open tandem',
  'ac.generic.note': 'Open two-seater, MTOsport style',
  'ac.ela07.note': 'ELA Aviación (Córdoba, Spain) · open tandem · Rotax 914',
  'ac.ela10.note': 'ELA Aviación (Córdoba, Spain) · enclosed tandem cabin, high tail · Rotax 914',
  'ac.cierva.note': 'A tribute to Juan de la Cierva, inventor of the autogiro · three-blade direct-control rotor, radial engine, no rudder · Museo del Aire replica',

  // piezas (puntos de choque de sim/airframes.ts y contactos de sim/autogyro.ts, por su nombre)
  'pt.mástil': 'the mast',
  'pt.morro': 'the nose',
  'pt.panza': 'the belly',
  'pt.estabilizador': 'the stabiliser',
  'pt.deriva': 'the fin',
  'pt.deriva lateral': 'the side fin',
  'pt.carenado derecho': 'the right wheel fairing',
  'pt.carenado izquierdo': 'the left wheel fairing',
  'pt.costado derecho': 'the right side',
  'pt.costado izquierdo': 'the left side',
  'pt.rueda de morro': 'the nose wheel',
  'pt.rueda principal izquierda': 'the left main wheel',
  'pt.rueda principal derecha': 'the right main wheel',
  'pt.patín de cola': 'the tail skid',
  'pt.rueda de cola': 'the tail wheel',
  'pt.motor': 'the engine',
  'pt.pata izquierda': 'the left landing-gear leg',
  'pt.pata derecha': 'the right landing-gear leg',
  'pt.pilón': 'the rotor pylon',
  'pt.deriva ventral': 'the ventral fin',

  // piezas y uniones del despiece (sim/wreck/parts.ts, por id)
  'part.pod': 'the pod',
  'part.mast': 'the mast',
  'part.tail': 'the tail',
  'part.gearL': 'the left landing-gear leg',
  'part.gearR': 'the right landing-gear leg',
  'part.noseFork': 'the nose-wheel fork',
  'part.wheelL': 'the left wheel',
  'part.wheelR': 'the right wheel',
  'part.wheelN': 'the nose wheel',
  'part.rotorHub': 'the rotor hub',
  'part.propHub': 'the propeller hub',
  'joint.rotor': 'the rotor head',
  'joint.prop': 'the propeller shaft',
  'joint.axleL': 'the left wheel axle',
  'joint.axleR': 'the right wheel axle',
  'joint.axleN': 'the nose-wheel axle',
  // despiece del Cierva C.30A (por su nombre en español)
  'wreck.el fuselaje': 'the fuselage',
  'wreck.el pilón del rotor': 'the rotor pylon',
  'wreck.la rueda de cola': 'the tail wheel',
  'wreck.la horquilla de la rueda de cola': 'the tail-wheel fork',
  'wreck.el eje de la rueda de cola': 'the tail-wheel axle',
}

/** Artículo español de los puntos de choque (el nombre es también su identificador). */
const ES_PART_ARTICLE: Record<string, string> = {
  panza: 'la',
  deriva: 'la',
  'deriva lateral': 'la',
  'rueda de morro': 'la',
  'rueda principal izquierda': 'la',
  'rueda principal derecha': 'la',
  'rueda de cola': 'la',
  'pata izquierda': 'la',
  'pata derecha': 'la',
  'deriva ventral': 'la',
}

const DICTS: Record<Lang, Dict> = { es, en }

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** Idioma del navegador: español (o catalán, gallego, euskera) → es; el resto → en. */
export function detectLang(): Lang {
  if (typeof navigator === 'undefined') return 'es'
  const list = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const l of list) {
    const base = (l || '').toLowerCase().split('-')[0]
    if (['es', 'ca', 'gl', 'eu'].includes(base)) return 'es'
    if (base) return 'en'
  }
  return 'es'
}

function initialLang(): Lang {
  try {
    const v = storage()?.getItem(STORE)
    if (v === 'es' || v === 'en') return v
  } catch {
    /* sin almacenamiento */
  }
  return detectLang()
}

let current: Lang = initialLang()
const listeners = new Set<(l: Lang) => void>()

export function getLang(): Lang {
  return current
}

/** Locale para fechas y números. */
export function locale(): string {
  return current === 'es' ? 'es-ES' : 'en-GB'
}

/** Cambia el idioma, lo guarda y avisa a quien lo necesite (menú, HUD, multijugador…). */
export function setLang(l: Lang): void {
  if (l === current) return
  current = l
  try {
    storage()?.setItem(STORE, l)
  } catch {
    /* sin almacenamiento */
  }
  if (typeof document !== 'undefined') applyI18n()
  for (const fn of listeners) fn(l)
}

export function onLangChange(fn: (l: Lang) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** ¿Hay traducción para esta clave en el idioma actual (o en español)? */
export function has(key: string): boolean {
  return key in DICTS[current] || key in es
}

/** Texto traducido. `{var}` se sustituye por vars.var; `{Var}`, igual pero con mayúscula inicial. */
export function t(key: string, vars?: Record<string, string | number>): string {
  const s = DICTS[current][key] ?? es[key] ?? key
  return vars ? fill(s, vars) : s
}

function fill(s: string, vars: Record<string, string | number>): string {
  return s.replace(/\{(\w+)\}/g, (m, k: string) => {
    if (k in vars) return String(vars[k])
    const low = k[0].toLowerCase() + k.slice(1)
    if (low !== k && low in vars) return cap(String(vars[low]))
    return m
  })
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** Punto de choque del modelo de vuelo (nombre en español = identificador) con su artículo. */
export function partLabel(name: string): string {
  if (current === 'es') return `${ES_PART_ARTICLE[name] ?? 'el'} ${name}`
  return en[`pt.${name}`] ?? `the ${name}`
}

/** Pieza o unión del despiece: traducción por id o, si no hay, su nombre en español. */
export function wreckLabel(kind: 'part' | 'joint', id: string, esName: string): string {
  if (current === 'es') return esName
  return en[`wreck.${esName}`] ?? en[`${kind}.${id}`] ?? esName
}

// --- DOM -------------------------------------------------------------------

const original = new WeakMap<Element, string>()
const originalAttr = new WeakMap<Element, Record<string, string>>()

/** Traduce los elementos con data-i18n / data-i18n-attr dentro de `root`. */
export function applyI18n(root: ParentNode = document): void {
  if (typeof document === 'undefined') return
  if (root === document) {
    document.documentElement.lang = current
    document.title = t('doc.title')
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    if (!original.has(el)) original.set(el, el.innerHTML)
    const key = el.dataset.i18n!
    const v = DICTS[current][key] ?? es[key] ?? original.get(el)!
    if (el.innerHTML !== v) el.innerHTML = v
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-attr]')) {
    let orig = originalAttr.get(el)
    if (!orig) originalAttr.set(el, (orig = {}))
    for (const pair of el.dataset.i18nAttr!.split(';')) {
      const [attr, key] = pair.split(':').map((s) => s.trim())
      if (!attr || !key) continue
      if (!(attr in orig)) orig[attr] = el.getAttribute(attr) ?? ''
      el.setAttribute(attr, DICTS[current][key] ?? es[key] ?? orig[attr])
    }
  }
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name=lang]')) r.checked = r.value === current
}
