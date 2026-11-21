// Ajustes, ubicaciones predefinidas y persistencia.

import { has, t } from './i18n.ts'

export type SceneryMode = 'google' | 'terrain'
export type ImagerySource = 'auto' | 'pnoa' | 'esri'
/** relieve sin clave: MDT de 5 m del IGN en España, o el global de ~30 m */
export type ElevationSource = 'auto' | 'global'
export type StartMode = 'runway' | 'air'
export type CloudPreset = 'clear' | 'fair' | 'scattered' | 'overcast'
export type Quality = 'low' | 'medium' | 'high' | 'ultra'

export interface Location {
  id: string
  name: string
  lat: number
  lon: number
  /** rumbo verdadero de salida (grados) */
  heading: number
  /** ondulación del geoide (m), para convertir alturas elipsoidales a QNH */
  geoid: number
  /** si es pista: el aparato se coloca en el suelo con start=runway */
  runway?: boolean
  /** altura sobre el terreno si se empieza en vuelo */
  airAGL?: number
  note?: string
  /** grupo del desplegable del menú (por defecto, 'scenic') */
  group?: LocationGroup
  /** comunidad autónoma de los sitios emblemáticos: con ella se agrupan en el menú */
  region?: Region
}

export type LocationGroup = 'airfield' | 'scenic'
/** claves de i18n `locgroup.<region>` */
export type Region =
  | 'and' | 'ara' | 'ast' | 'bal' | 'can' | 'cnt' | 'clm' | 'cyl' | 'cat'
  | 'cym' | 'mad' | 'val' | 'ext' | 'gal' | 'rio' | 'mur' | 'nav' | 'pv'

// Casarrubios del Monte (LEMT): pista 08/26, 948 × 26 m, rumbo verdadero 077,97°.
// Eje según OpenStreetMap (coincide con la ortofoto PNOA): extremos 40.2339443, −4.0324438
// y 40.2357257, −4.0215379; centro 40.23484 N, −4.02699 E. Las salidas, 15 m dentro de cada extremo.
export const LOCATIONS: Location[] = [
  {
    id: 'lemt08',
    name: 'Casarrubios (LEMT) · cabecera 08',
    lat: 40.233972,
    lon: -4.032271,
    heading: 77.97,
    geoid: 51.6,
    group: 'airfield',
    runway: true,
    note: 'Pista 08/26 · 948 m · asfalto',
  },
  {
    id: 'lemt26',
    name: 'Casarrubios (LEMT) · cabecera 26',
    lat: 40.235698,
    lon: -4.02171,
    heading: 257.97,
    geoid: 51.6,
    group: 'airfield',
    runway: true,
    note: 'Pista 08/26 · 948 m · asfalto',
  },
  {
    id: 'lemt-air',
    name: 'Circuito de Casarrubios (en vuelo)',
    lat: 40.2205,
    lon: -4.045,
    heading: 81,
    geoid: 51.6,
    group: 'airfield',
    airAGL: 300,
    note: 'Tramo de viento en cola, 1000 ft sobre el campo',
  },

  // Aeropuertos y aeródromos históricos. Ejes de pista de OpenStreetMap (los mismos que alisa
  // src/world/Runways.ts), salida 15 m dentro del extremo: `node --experimental-strip-types
  // tools/runway-info.ts <lat> <lon>`. Geoide EGM2008 (GeographicLib GeoidEval).
  {
    id: 'lecu27',
    name: 'Madrid-Cuatro Vientos (LECU) · cabecera 27',
    lat: 40.370213,
    lon: -3.775831,
    heading: 273.75,
    geoid: 51.7,
    group: 'airfield',
    runway: true,
    note: 'Pista 09/27 · 1500 m · asfalto · el aeródromo más antiguo de España (1911)',
  },
  {
    id: 'lecu09',
    name: 'Madrid-Cuatro Vientos (LECU) · cabecera 09',
    lat: 40.371143,
    lon: -3.794462,
    heading: 93.75,
    geoid: 51.7,
    group: 'airfield',
    runway: true,
    note: 'Pista 09/27 · 1500 m · asfalto',
  },
  {
    id: 'lemd36l',
    name: 'Madrid-Barajas (LEMD) · cabecera 36L',
    lat: 40.492695,
    lon: -3.574613,
    heading: 359.73,
    geoid: 51.7,
    group: 'airfield',
    runway: true,
    note: 'Pista 18R/36L · 4350 m · despegues en configuración norte',
  },
  {
    // final de la 32L a 3 NM (5,5 km antes de la cabecera, rumbo 322,3°), ~1000 ft
    id: 'lemd-final32l',
    name: 'Madrid-Barajas (LEMD) · final 32L (en vuelo)',
    lat: 40.4239,
    lon: -3.5141,
    heading: 322.3,
    geoid: 51.7,
    group: 'airfield',
    airAGL: 300,
    note: 'Aproximación final a la 32L, 3 NM, 1000 ft',
  },
  {
    id: 'lebl24l',
    name: 'Barcelona-El Prat (LEBL) · cabecera 24L',
    lat: 41.292169,
    lon: 2.103134,
    heading: 245.47,
    geoid: 49.6,
    group: 'airfield',
    runway: true,
    note: 'Pista 06R/24L · 2660 m · junto a la playa',
  },
  {
    id: 'lepa24l',
    name: 'Palma de Mallorca (LEPA) · cabecera 24L',
    lat: 39.555276,
    lon: 2.761378,
    heading: 238.47,
    geoid: 49.4,
    group: 'airfield',
    runway: true,
    note: 'Pista 06R/24L · 3000 m',
  },
  {
    id: 'lemg13',
    name: 'Málaga-Costa del Sol (LEMG) · cabecera 13',
    lat: 36.68445,
    lon: -4.512476,
    heading: 131.7,
    geoid: 48.3,
    group: 'airfield',
    runway: true,
    note: 'Pista 13/31 · 3200 m · despegue hacia el mar',
  },
  {
    id: 'lezl27',
    name: 'Sevilla-San Pablo (LEZL) · cabecera 27',
    lat: 37.418005,
    lon: -5.874336,
    heading: 269.75,
    geoid: 50.4,
    group: 'airfield',
    runway: true,
    note: 'Pista 09/27 · 3360 m',
  },
  {
    id: 'levc12',
    name: 'Valencia-Manises (LEVC) · cabecera 12',
    lat: 39.496307,
    lon: -0.499973,
    heading: 116.28,
    geoid: 50.8,
    group: 'airfield',
    runway: true,
    note: 'Pista 12/30 · 3200 m · hacia la ciudad y el mar',
  },
  {
    id: 'lebb30',
    name: 'Bilbao (LEBB) · cabecera 30',
    lat: 43.295904,
    lon: -2.896453,
    heading: 296.61,
    geoid: 50.2,
    group: 'airfield',
    runway: true,
    note: 'Pista 12/30 · 2600 m · entre montes',
  },
  {
    id: 'gcxo30',
    name: 'Tenerife Norte-Los Rodeos (GCXO) · cabecera 30',
    lat: 28.477312,
    lon: -16.32542,
    heading: 290.67,
    geoid: 45.1,
    group: 'airfield',
    runway: true,
    note: 'Pista 12/30 · 3400 m · 630 m de altitud, con el Teide al fondo',
  },
  {
    id: 'gclp03l',
    name: 'Gran Canaria (GCLP) · cabecera 03L',
    lat: 27.918997,
    lon: -15.392289,
    heading: 21.32,
    geoid: 44.1,
    group: 'airfield',
    runway: true,
    note: 'Pista 03L/21R · 3100 m · junto al mar',
  },

  // Sitios emblemáticos (al menos uno por provincia), agrupados en el menú por comunidad
  // autónoma; siempre se sale en vuelo. La salida está a 1,5–3 km del sitio con rumbo hacia
  // él, y la altura deja al menos 150 m sobre el relieve del trayecto (±200 m a los lados)
  // según `node --experimental-strip-types tools/landmark-info.ts <lat> <lon> <rumbo> [dist] [altura]`.
  // En los peñones (Es Vedrà, Ifach, Roque Nublo), el Teide y Mont-rebei la altitud se fijó a mano.
  // Andalucía
  { id: 'cabogata', name: 'Cabo de Gata · faro y Arrecife de las Sirenas', lat: 36.7411, lon: -2.2069, heading: 150, geoid: 49.7, airAGL: 390, region: 'and',
    note: 'Almería · sobre las salinas hacia el faro y los arrecifes volcánicos' },
  { id: 'cadiz', name: 'Cádiz · catedral y Campo del Sur', lat: 36.5155, lon: -6.2953, heading: 0, geoid: 45.4, airAGL: 220, region: 'and',
    note: 'Cádiz · llegando desde el mar a la cúpula dorada' },
  { id: 'mezquita', name: 'Córdoba · Mezquita-Catedral', lat: 37.8657, lon: -4.7765, heading: 350, geoid: 50.8, airAGL: 220, region: 'and',
    note: 'Córdoba · cruzando el Guadalquivir por el puente romano' },
  { id: 'alhambra', name: 'Granada · La Alhambra', lat: 37.1875, lon: -3.6025, heading: 135, geoid: 49.5, airAGL: 280, region: 'and',
    note: 'Granada · desde el Albaicín, con Sierra Nevada al fondo' },
  { id: 'rocio', name: 'Doñana · El Rocío y las marismas', lat: 37.1434, lon: -6.4789, heading: 200, geoid: 50.1, airAGL: 160, region: 'and',
    note: 'Huelva · la ermita y, detrás, las marismas de Doñana' },
  { id: 'jaen', name: 'Jaén · catedral y castillo de Santa Catalina', lat: 37.7614, lon: -3.7742, heading: 287, geoid: 50.1, airAGL: 510, region: 'and',
    note: 'Jaén · sobre la catedral hacia el castillo del cerro' },
  { id: 'ronda', name: 'Ronda · Tajo y Puente Nuevo', lat: 36.7407, lon: -5.1861, heading: 90, geoid: 47.6, airAGL: 380, region: 'and',
    note: 'Málaga · desde el valle, de frente al puente sobre el Tajo' },
  { id: 'giralda', name: 'Sevilla · catedral y Giralda', lat: 37.3767, lon: -6.0046, heading: 45, geoid: 50.4, airAGL: 210, region: 'and',
    note: 'Sevilla · por la Torre del Oro hacia la catedral' },
  // Aragón
  { id: 'ordesa', name: 'Valle de Ordesa', lat: 42.6543, lon: -0.0767, heading: 112, geoid: 54.0, airAGL: 660, region: 'ara',
    note: 'Huesca · cañón arriba desde la Pradera hacia el circo de Soaso y Monte Perdido' },
  { id: 'albarracin', name: 'Albarracín', lat: 40.414, lon: -1.4289, heading: 240, geoid: 53.0, airAGL: 250, region: 'ara',
    note: 'Teruel · el pueblo en el meandro y la muralla por la ladera' },
  { id: 'pilar', name: 'Zaragoza · Basílica del Pilar', lat: 41.6695, lon: -0.8847, heading: 160, geoid: 50.5, airAGL: 210, region: 'ara',
    note: 'Zaragoza · cruzando el Ebro hacia las torres y cúpulas' },
  // Asturias
  { id: 'covadonga', name: 'Covadonga · basílica y lagos', lat: 43.3179, lon: -5.0749, heading: 120, geoid: 54.2, airAGL: 290, region: 'ast',
    note: 'Asturias · la basílica y, valle arriba, los lagos y los Picos de Europa' },
  // Canarias
  { id: 'timanfaya', name: 'Lanzarote · Timanfaya', lat: 28.9901, lon: -13.7713, heading: 45, geoid: 45.0, airAGL: 370, region: 'can',
    note: 'Las Palmas · Montañas del Fuego y campos de lava' },
  { id: 'roquenublo', name: 'Gran Canaria · Roque Nublo', lat: 27.9539, lon: -15.6196, heading: 20, geoid: 46.2, airAGL: 720, region: 'can',
    note: 'Las Palmas · el monolito sobre la cumbre, con el Teide en el horizonte' },
  { id: 'teide', name: 'Tenerife · el Teide y Las Cañadas', lat: 28.301, lon: -16.57, heading: 210, geoid: 48.1, airAGL: 510, region: 'can',
    note: 'Santa Cruz de Tenerife · por Las Cañadas, con el Teide a la derecha' },
  // Cantabria
  { id: 'cabarceno', name: 'Cabárceno · parque de la naturaleza', lat: 43.3465, lon: -3.8628, heading: 60, geoid: 51.4, airAGL: 330, region: 'cnt',
    note: 'Cantabria · el karst de la antigua mina donde viven los animales' },
  // Castilla-La Mancha
  { id: 'alcalajucar', name: 'Alcalá del Júcar', lat: 39.1929, lon: -1.4522, heading: 90, geoid: 52.4, airAGL: 290, region: 'clm',
    note: 'Albacete · por la hoz del Júcar hasta el pueblo colgado' },
  { id: 'criptana', name: 'Campo de Criptana · molinos', lat: 39.3961, lon: -3.1228, heading: 0, geoid: 52.7, airAGL: 240, region: 'clm',
    note: 'Ciudad Real · los molinos de la Sierra, sobre La Mancha' },
  { id: 'cuenca', name: 'Cuenca · Casas Colgadas', lat: 40.0778, lon: -2.1107, heading: 270, geoid: 52.8, airAGL: 180, region: 'clm',
    note: 'Cuenca · sobre la hoz del Huécar hacia el casco antiguo' },
  { id: 'siguenza', name: 'Sigüenza · castillo y catedral', lat: 41.0499, lon: -2.6517, heading: 30, geoid: 53.8, airAGL: 160, region: 'clm',
    note: 'Guadalajara · el castillo en lo alto y la catedral debajo' },
  { id: 'toledo', name: 'Toledo · casco histórico', lat: 39.8505, lon: -4.0425, heading: 20, geoid: 51.3, airAGL: 250, region: 'clm',
    note: 'Toledo · la ciudad en el meandro del Tajo, con el Alcázar y la catedral' },
  // Castilla y León
  { id: 'avila', name: 'Ávila · murallas', lat: 40.6588, lon: -4.7225, heading: 100, geoid: 55.0, airAGL: 200, region: 'cyl',
    note: 'Ávila · desde los Cuatro Postes, el recinto amurallado entero' },
  { id: 'gredos', name: 'Sierra de Gredos · Almanzor', lat: 40.2205, lon: -5.2802, heading: 200, geoid: 52.0, airAGL: 500, region: 'cyl',
    note: 'Ávila · el circo glaciar y la Laguna Grande' },
  { id: 'burgos', name: 'Burgos · catedral', lat: 42.334, lon: -3.7204, heading: 60, geoid: 54.1, airAGL: 230, region: 'cyl',
    note: 'Burgos · sobre el Arlanzón hacia las agujas góticas' },
  { id: 'medulas', name: 'Las Médulas', lat: 42.4612, lon: -6.7377, heading: 250, geoid: 57.6, airAGL: 340, region: 'cyl',
    note: 'León · la mina de oro romana, desde el mirador de Orellán' },
  { id: 'otero', name: 'Palencia · catedral y Cristo del Otero', lat: 42.0054, lon: -4.536, heading: 12, geoid: 54.1, airAGL: 240, region: 'cyl',
    note: 'Palencia · sobre la catedral hacia el Cristo del cerro' },
  { id: 'salamanca', name: 'Salamanca · catedrales y puente romano', lat: 40.9471, lon: -5.666, heading: 0, geoid: 55.9, airAGL: 220, region: 'cyl',
    note: 'Salamanca · cruzando el Tormes hacia las dos catedrales' },
  { id: 'segovia', name: 'Segovia · Acueducto y Alcázar', lat: 40.952, lon: -4.1295, heading: 290, geoid: 52.5, airAGL: 250, region: 'cyl',
    note: 'Segovia · el acueducto romano y el Alcázar sobre el Eresma' },
  { id: 'riolobos', name: 'Cañón del Río Lobos', lat: 41.732, lon: -3.0537, heading: 331, geoid: 54.3, airAGL: 170, region: 'cyl',
    note: 'Soria · cañón arriba hasta la ermita templaria de San Bartolomé' },
  { id: 'penafiel', name: 'Peñafiel · castillo', lat: 41.5832, lon: -4.1143, heading: 0, geoid: 53.5, airAGL: 160, region: 'cyl',
    note: 'Valladolid · el castillo-barco sobre la Ribera del Duero' },
  { id: 'sanabria', name: 'Lago de Sanabria', lat: 42.1217, lon: -6.6858, heading: 270, geoid: 58.4, airAGL: 250, region: 'cyl',
    note: 'Zamora · el mayor lago glaciar de la península' },
  // Cataluña
  { id: 'sagrada', name: 'Barcelona · Sagrada Familia', lat: 41.392, lon: 2.1897, heading: 315, geoid: 49.7, airAGL: 310, region: 'cat',
    note: 'Barcelona · desde el mar por el Eixample; las torres llegan a 172 m' },
  { id: 'montserrat', name: 'Montserrat', lat: 41.5723, lon: 1.8562, heading: 340, geoid: 50.1, airAGL: 830, region: 'cat',
    note: 'Barcelona · Llobregat arriba, con el monasterio y las agujas a la izquierda' },
  { id: 'creus', name: 'Cap de Creus y Cadaqués', lat: 42.2988, lon: 3.2915, heading: 42, geoid: 49.9, airAGL: 230, region: 'cat',
    note: 'Girona · el extremo oriental de la península' },
  { id: 'montrebei', name: 'Congost de Mont-rebei', lat: 42.1, lon: 0.6935, heading: 204, geoid: 51.2, airAGL: 510, region: 'cat',
    note: 'Lleida · hacia el tajo del Montsec: paredes de 500 m a los lados' },
  { id: 'tarragona', name: 'Tarragona · anfiteatro romano', lat: 41.1028, lon: 1.2678, heading: 330, geoid: 49.7, airAGL: 230, region: 'cat',
    note: 'Tarragona · desde el mar, con la Part Alta y la catedral detrás' },
  // Ceuta y Melilla
  { id: 'ceuta', name: 'Ceuta · Monte Hacho', lat: 35.893, lon: -5.3141, heading: 80, geoid: 42.5, airAGL: 330, region: 'cym',
    note: 'Ceuta · la península de la Almina, con Gibraltar al norte' },
  { id: 'melilla', name: 'Melilla la Vieja', lat: 35.294, lon: -2.9171, heading: 270, geoid: 49.5, airAGL: 180, region: 'cym',
    note: 'Melilla · la ciudadela amurallada sobre el mar' },
  // Comunidad de Madrid
  { id: 'madrid', name: 'Madrid · Palacio Real', lat: 40.4153, lon: -3.7244, heading: 60, geoid: 51.9, airAGL: 350, region: 'mad',
    note: 'Madrid · el palacio, la Almudena y el Campo del Moro' },
  { id: 'escorial', name: 'San Lorenzo de El Escorial', lat: 40.5772, lon: -4.1428, heading: 340, geoid: 52.2, airAGL: 300, region: 'mad',
    note: 'Madrid · el monasterio al pie del monte Abantos' },
  // Comunitat Valenciana
  { id: 'ifach', name: 'Calp · Peñón de Ifach', lat: 38.6237, lon: 0.0495, heading: 60, geoid: 50.1, airAGL: 470, region: 'val',
    note: 'Alicante · el peñón de 332 m sobre el mar' },
  { id: 'peniscola', name: 'Peñíscola · castillo del Papa Luna', lat: 40.3454, lon: 0.4076, heading: 0, geoid: 50.5, airAGL: 180, region: 'val',
    note: 'Castellón · la ciudad amurallada sobre su peñón' },
  { id: 'cac', name: 'Valencia · Ciudad de las Artes y las Ciencias', lat: 39.4477, lon: -0.3344, heading: 300, geoid: 50.5, airAGL: 210, region: 'val',
    note: 'Valencia · por el antiguo cauce del Turia desde el puerto' },
  // Extremadura
  { id: 'merida', name: 'Mérida · teatro romano y puente', lat: 38.9076, lon: -6.3655, heading: 70, geoid: 54.5, airAGL: 160, region: 'ext',
    note: 'Badajoz · sobre el puente romano del Guadiana hacia el teatro' },
  { id: 'monfrague', name: 'Monfragüe · castillo y Tajo', lat: 39.8125, lon: -6.0398, heading: 330, geoid: 54.5, airAGL: 320, region: 'ext',
    note: 'Cáceres · el Tajo encajado y el castillo sobre la sierra' },
  // Galicia
  { id: 'santiago', name: 'Santiago de Compostela · catedral', lat: 42.8804, lon: -8.563, heading: 90, geoid: 56.3, airAGL: 260, region: 'gal',
    note: 'A Coruña · de frente a la fachada del Obradoiro' },
  { id: 'catedrales', name: 'Playa de las Catedrales', lat: 43.5639, lon: -7.1442, heading: 225, geoid: 54.1, airAGL: 180, region: 'gal',
    note: 'Lugo · los arcos de roca de la costa de Ribadeo' },
  { id: 'sil', name: 'Cañón del Sil · Ribeira Sacra', lat: 42.4092, lon: -7.6483, heading: 300, geoid: 56.7, airAGL: 360, region: 'gal',
    note: 'Ourense · cañón abajo, con Santo Estevo colgado de la ladera' },
  { id: 'cies', name: 'Islas Cíes', lat: 42.2225, lon: -8.8721, heading: 270, geoid: 55.8, airAGL: 260, region: 'gal',
    note: 'Pontevedra · desde la ría de Vigo hacia la playa de Rodas' },
  // Islas Baleares
  { id: 'esvedra', name: 'Ibiza · Es Vedrà', lat: 38.8744, lon: 1.2251, heading: 250, geoid: 49.5, airAGL: 500, region: 'bal',
    note: 'Ibiza · el islote de 382 m frente a Cala d’Hort' },
  { id: 'formentor', name: 'Mallorca · cabo de Formentor', lat: 39.9459, lon: 3.1834, heading: 55, geoid: 49.0, airAGL: 300, region: 'bal',
    note: 'Mallorca · a lo largo de la península hasta el faro' },
  // La Rioja
  { id: 'sanmillan', name: 'San Millán de la Cogolla · Yuso y Suso', lat: 42.3399, lon: -2.8547, heading: 210, geoid: 53.5, airAGL: 230, region: 'rio',
    note: 'La Rioja · los monasterios de la cuna del castellano' },
  // Navarra
  { id: 'bardenas', name: 'Bardenas Reales · Castildetierra', lat: 42.1946, lon: -1.5279, heading: 30, geoid: 50.4, airAGL: 180, region: 'nav',
    note: 'Navarra · el desierto de barrancos y cabezos' },
  { id: 'zugarramurdi', name: 'Zugarramurdi · cueva de las brujas', lat: 43.2684, lon: -1.5703, heading: 90, geoid: 50.4, airAGL: 210, region: 'nav',
    note: 'Navarra · prados y la cueva del akelarre, junto a Francia' },
  // País Vasco
  { id: 'anana', name: 'Valle Salado de Añana', lat: 42.7858, lon: -2.9842, heading: 0, geoid: 51.9, airAGL: 190, region: 'pv',
    note: 'Álava · las eras de sal escalonadas en el valle' },
  { id: 'gaztelugatxe', name: 'San Juan de Gaztelugatxe', lat: 43.4341, lon: -2.7881, heading: 10, geoid: 49.2, airAGL: 220, region: 'pv',
    note: 'Bizkaia · la ermita en el islote y su escalera de piedra' },
  { id: 'concha', name: 'Donostia · bahía de La Concha', lat: 43.3255, lon: -2.0295, heading: 100, geoid: 49.2, airAGL: 310, region: 'pv',
    note: 'Gipuzkoa · desde Igueldo, la bahía y la isla de Santa Clara' },
  // Región de Murcia
  { id: 'lamanga', name: 'La Manga del Mar Menor', lat: 37.622, lon: -0.6844, heading: 340, geoid: 49.8, airAGL: 170, region: 'mur',
    note: 'Murcia · desde Cabo de Palos, el mar a la derecha y el Mar Menor a la izquierda' },
]

/** Nombre del lugar en el idioma de la interfaz (los nombres de LOCATIONS están en español). */
export function locationName(l: Location): string {
  const k = `loc.${l.id}`
  return has(k) ? t(k) : l.name
}

/** Nota del lugar para el menú; en los que se sale en vuelo, con la altura de salida. */
export function locationNote(l: Location): string {
  const k = `loc.${l.id}.note`
  const note = has(k) ? t(k) : (l.note ?? '')
  if (l.runway || l.group === 'airfield') return note
  const fly = t('loc.inFlight', { m: l.airAGL ?? 300 })
  return note ? `${note} · ${fly}` : fly
}

export interface Settings {
  scenery: SceneryMode
  googleKey: string
  imagery: ImagerySource
  elevation: ElevationSource
  /** edificios 3D de OpenStreetMap en el modo sin clave */
  buildings: boolean
  /** completar los edificios con los del Catastro (España, se descargan por municipios) */
  catastro: boolean
  /** árboles 3D detectados en la ortofoto (modo sin clave) */
  trees: boolean
  locationId: string
  customLat: number
  customLon: number
  start: StartMode
  passenger: boolean
  /** id del modelo 3D en src/aircraft/catalog.ts */
  aircraft: string
  hour: number // hora local (decimal)
  dayOfYear: number
  windFrom: number
  windSpeed: number // nudos
  turbulence: number // 0..1
  clouds: CloudPreset
  /** 'auto' = según la GPU detectada */
  quality: Quality | 'auto'
  volume: number
  invertPitch: boolean
  mouseStick: boolean
  /** ayuda de pilotaje: nivelado de alas y coordinación con pedales */
  assist: boolean
  /** guía de pilotaje lateral (tecla J) */
  guide: boolean
  // mapeo de joystick
  axisPitch: number
  axisRoll: number
  axisYaw: number
  axisThrottle: number
  invertThrottle: boolean
  exposure: number
}

export const DEFAULT_SETTINGS: Settings = {
  scenery: 'terrain',
  googleKey: '',
  imagery: 'auto',
  elevation: 'auto',
  buildings: true,
  catastro: true,
  trees: true,
  locationId: 'lemt26',
  customLat: 40.2348,
  customLon: -4.027,
  start: 'runway',
  passenger: false,
  aircraft: 'ela07',
  hour: 11,
  dayOfYear: 140,
  windFrom: 250,
  windSpeed: 6,
  turbulence: 0.25,
  clouds: 'fair',
  quality: 'auto',
  volume: 0.8,
  invertPitch: false,
  mouseStick: false,
  assist: true,
  guide: true,
  axisPitch: 1,
  axisRoll: 0,
  axisYaw: 2,
  axisThrottle: 3,
  invertThrottle: true,
  exposure: 2.6,
}

const KEY = 'autogiro.settings.v4'

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch {
    /* almacenamiento no disponible */
  }
  const s = { ...DEFAULT_SETTINGS }
  // la clave de .env.local solo en desarrollo: el juego compilado (npm run server, que se
  // comparte por Internet) nunca la lleva dentro; ahí cada uno la pone en el menú
  const envKey = import.meta.env.DEV ? (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined) : undefined
  if (envKey) {
    s.googleKey = envKey
    s.scenery = 'google'
  }
  return s
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* ignorar */
  }
}

export function isInSpain(lat: number, lon: number): boolean {
  // península + Baleares (aprox.); Canarias tienen PNOA también
  const peninsula = lat > 35.9 && lat < 43.9 && lon > -9.5 && lon < 4.4
  const canarias = lat > 27.5 && lat < 29.5 && lon > -18.3 && lon < -13.3
  return peninsula || canarias
}
