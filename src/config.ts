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
  /** país (ISO 3166-1 alfa-2) de los sitios de fuera de España: se agrupan por país en el menú */
  country?: string
}

/** País de un lugar (los que no lo dicen están en España). */
export function locationCountry(l: Location): string {
  return l.country ?? 'ES'
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

  // Sitios emblemáticos del resto del mundo, agrupados en el menú por país (`country`); siempre en
  // vuelo. Datos y salidas de `node --experimental-strip-types tools/world-sites.ts spawns`.
  { id: 'belem', name: 'Lisboa · Torre de Belém', lat: 38.6757, lon: -9.2364, heading: 45, geoid: 53.7, airAGL: 210, country: 'PT',
    note: 'Desde el Tajo, la torre y los Jerónimos con la ciudad detrás' },
  { id: 'pena', name: 'Sintra · Palacio da Pena', lat: 38.8011, lon: -9.4206, heading: 120, geoid: 54.2, airAGL: 660, country: 'PT',
    note: 'Desde la costa, el palacio de colores en lo alto de la sierra' },
  { id: 'porto', name: 'Oporto · la Ribeira y el Duero', lat: 41.1406, lon: -8.6528, heading: 90, geoid: 55.5, airAGL: 250, country: 'PT',
    note: 'Río arriba desde la desembocadura hasta el puente Dom Luís I' },
  { id: 'setecidades', name: 'Azores · Sete Cidades', lat: 37.8461, lon: -25.7541, heading: 290, geoid: 57.2, airAGL: 240, country: 'PT',
    note: 'São Miguel · por encima del borde del cráter y sus dos lagunas' },
  { id: 'msm', name: 'Mont-Saint-Michel', lat: 48.6552, lon: -1.5404, heading: 135, geoid: 48.6, airAGL: 240, country: 'FR',
    note: 'Desde la bahía, la abadía sobre el islote' },
  { id: 'verdon', name: 'Gargantas del Verdon', lat: 43.7579, lon: 6.2865, heading: 105, geoid: 51.4, airAGL: 260, country: 'FR',
    note: 'Desde el lago de Sainte-Croix, cañón adentro' },
  { id: 'chamonix', name: 'Chamonix · Mont Blanc', lat: 45.9651, lon: 6.9193, heading: 220, geoid: 53.3, airAGL: 430, country: 'FR',
    note: 'Valle abajo desde Argentière, con el macizo del Mont Blanc a la izquierda' },
  { id: 'etretat', name: 'Étretat · acantilados y la Aguja', lat: 49.7013, lon: 0.1582, heading: 75, geoid: 45.2, airAGL: 210, country: 'FR',
    note: 'Normandía · desde el mar hacia los arcos de roca blanca' },
  { id: 'carcassonne', name: 'Carcasona · la Cité', lat: 43.2063, lon: 2.3328, heading: 90, geoid: 49.7, airAGL: 240, country: 'FR',
    note: 'La ciudad amurallada con sus 52 torres' },
  { id: 'coliseo', name: 'Roma · Coliseo y Foro', lat: 41.8994, lon: 12.4581, heading: 110, geoid: 48.4, airAGL: 240, country: 'IT',
    note: 'Sobre el centro histórico hacia el Coliseo' },
  { id: 'venecia', name: 'Venecia · San Marcos', lat: 45.4181, lon: 12.3161, heading: 45, geoid: 44, airAGL: 220, country: 'IT',
    note: 'Por el canal de la Giudecca hacia la plaza y el campanile' },
  { id: 'positano', name: 'Costa Amalfitana · Positano', lat: 40.607, lon: 14.4748, heading: 20, geoid: 47.5, airAGL: 490, country: 'IT',
    note: 'Desde el mar, el pueblo colgado de la ladera' },
  { id: 'cinqueterre', name: 'Cinque Terre · Manarola', lat: 44.0872, lon: 9.7443, heading: 330, geoid: 45.9, airAGL: 370, country: 'IT',
    note: 'Costa arriba, de pueblo en pueblo entre viñedos' },
  { id: 'trecime', name: 'Dolomitas · Tre Cime di Lavaredo', lat: 46.5824, lon: 12.2863, heading: 10, geoid: 51.6, airAGL: 470, country: 'IT',
    note: 'Desde el lago de Misurina hacia las tres torres de roca' },
  { id: 'vesubio', name: 'Vesubio y golfo de Nápoles', lat: 40.8214, lon: 14.3784, heading: 90, geoid: 47.6, airAGL: 1160, country: 'IT',
    note: 'Desde el golfo hacia el cráter, con Pompeya al sur' },
  { id: 'florencia', name: 'Florencia · Duomo', lat: 43.7619, lon: 11.229, heading: 60, geoid: 45.7, airAGL: 170, country: 'IT',
    note: 'Por el Arno y el Ponte Vecchio hacia la cúpula de Brunelleschi' },
  { id: 'cervino', name: 'Zermatt · el Cervino', lat: 46.0545, lon: 7.7668, heading: 200, geoid: 54.5, airAGL: 710, country: 'CH',
    note: 'Valle arriba hacia Zermatt con el Cervino de frente' },
  { id: 'lauterbrunnen', name: 'Valle de Lauterbrunnen', lat: 46.6196, lon: 7.8988, heading: 165, geoid: 51.6, airAGL: 250, country: 'CH',
    note: 'Entre paredes y cascadas, con la Jungfrau al fondo' },
  { id: 'chillon', name: 'Lago Lemán · castillo de Chillon', lat: 46.4234, lon: 6.8907, heading: 110, geoid: 50.9, airAGL: 530, country: 'CH',
    note: 'Sobre el lago hacia el castillo, con los Alpes detrás' },
  { id: 'hallstatt', name: 'Hallstatt', lat: 47.5876, lon: 13.663, heading: 200, geoid: 47.6, airAGL: 320, country: 'AT',
    note: 'Sobre el lago hacia el pueblo al pie de la montaña' },
  { id: 'neuschwanstein', name: 'Castillo de Neuschwanstein', lat: 47.583, lon: 10.7361, heading: 160, geoid: 48.3, airAGL: 460, country: 'DE',
    note: 'Baviera · desde los lagos hacia el castillo y los Alpes' },
  { id: 'londres', name: 'Londres · el Támesis y la City', lat: 51.5081, lon: -0.1337, heading: 90, geoid: 46.1, airAGL: 250, country: 'GB',
    note: 'Río abajo desde Westminster hacia la Torre de Londres' },
  { id: 'edimburgo', name: 'Edimburgo · castillo', lat: 55.9439, lon: -3.2474, heading: 80, geoid: 53.1, airAGL: 250, country: 'GB',
    note: 'Escocia · el castillo sobre su roca y Arthur’s Seat detrás' },
  { id: 'storr', name: 'Isla de Skye · Old Man of Storr', lat: 57.507, lon: -6.1243, heading: 270, geoid: 56.3, airAGL: 850, country: 'GB',
    note: 'Escocia · desde el mar hacia los pináculos de roca' },
  { id: 'calzada', name: 'Calzada del Gigante', lat: 55.2633, lon: -6.5116, heading: 180, geoid: 56.6, airAGL: 240, country: 'GB',
    note: 'Irlanda del Norte · desde el mar hacia las columnas de basalto' },
  { id: 'moher', name: 'Acantilados de Moher', lat: 52.9668, lon: -9.475, heading: 80, geoid: 58.3, airAGL: 330, country: 'IE',
    note: 'Desde el Atlántico hacia los acantilados de 200 m' },
  { id: 'geiranger', name: 'Fiordo de Geiranger', lat: 62.1196, lon: 7.1188, heading: 115, geoid: 46.1, airAGL: 700, country: 'NO',
    note: 'Fiordo adentro, de las Siete Hermanas hasta Geiranger' },
  { id: 'preikestolen', name: 'Preikestolen', lat: 58.9817, lon: 6.139, heading: 80, geoid: 44.4, airAGL: 580, country: 'NO',
    note: 'Sobre el Lysefjord hacia el púlpito de roca de 604 m' },
  { id: 'reine', name: 'Lofoten · Reine', lat: 67.9584, lon: 13.1126, heading: 200, geoid: 39.6, airAGL: 430, country: 'NO',
    note: 'Por encima del círculo polar, picos sobre el mar' },
  { id: 'kirkjufell', name: 'Kirkjufell', lat: 64.9415, lon: -23.2423, heading: 270, geoid: 65.8, airAGL: 680, country: 'IS',
    note: 'La montaña de la iglesia junto a Grundarfjörður' },
  { id: 'jokulsarlon', name: 'Jökulsárlón', lat: 64.023, lon: -16.158, heading: 340, geoid: 65.8, airAGL: 620, country: 'IS',
    note: 'Desde la playa de los diamantes hacia la laguna de icebergs y el glaciar' },
  { id: 'santorini', name: 'Santorini · Oía y la caldera', lat: 36.4384, lon: 25.3585, heading: 30, geoid: 34.9, airAGL: 330, country: 'GR',
    note: 'Dentro de la caldera hacia el pueblo blanco en lo alto' },
  { id: 'meteora', name: 'Meteora', lat: 39.6947, lon: 21.6306, heading: 0, geoid: 35.7, airAGL: 540, country: 'GR',
    note: 'Desde Kalambaka hacia los monasterios sobre las rocas' },
  { id: 'acropolis', name: 'Atenas · Acrópolis', lat: 37.9481, lon: 23.7086, heading: 30, geoid: 38.5, airAGL: 340, country: 'GR',
    note: 'Sobre la ciudad hacia la roca del Partenón' },
  { id: 'dubrovnik', name: 'Dubrovnik', lat: 42.6215, lon: 18.0947, heading: 30, geoid: 41.4, airAGL: 370, country: 'HR',
    note: 'Desde el Adriático hacia la ciudad amurallada' },
  { id: 'bled', name: 'Lago de Bled', lat: 46.3702, lon: 14.1246, heading: 250, geoid: 48.1, airAGL: 180, country: 'SI',
    note: 'La iglesia en la isla y el castillo sobre el lago' },
  { id: 'praga', name: 'Praga · castillo y puente de Carlos', lat: 50.0611, lon: 14.4258, heading: 340, geoid: 45, airAGL: 160, country: 'CZ',
    note: 'Por el Moldava hacia el puente y el castillo' },
  { id: 'capadocia', name: 'Capadocia · Göreme', lat: 38.6431, lon: 34.7943, heading: 90, geoid: 35, airAGL: 170, country: 'TR',
    note: 'Sobre las chimeneas de hadas, como los globos al amanecer' },
  { id: 'estambul', name: 'Estambul · Santa Sofía y el Bósforo', lat: 41.0086, lon: 29.016, heading: 270, geoid: 37.3, airAGL: 210, country: 'TR',
    note: 'Desde el Bósforo hacia Santa Sofía y la Mezquita Azul' },
  { id: 'gibraltar', name: 'Peñón de Gibraltar', lat: 36.1552, lon: -5.3502, heading: 170, geoid: 43.4, airAGL: 600, country: 'GI',
    note: 'Desde la bahía hacia el peñón, con África al fondo' },
  { id: 'aitbenhaddou', name: 'Aït Ben Haddou', lat: 31.047, lon: -7.1027, heading: 270, geoid: 53.7, airAGL: 210, country: 'MA',
    note: 'La kasba de adobe junto al río, al pie del Atlas' },
  { id: 'giza', name: 'Pirámides de Guiza', lat: 29.9927, lon: 31.1612, heading: 240, geoid: 15.3, airAGL: 280, country: 'EG',
    note: 'Desde El Cairo hacia Keops, Kefrén y Micerinos' },
  { id: 'victoria', name: 'Cataratas Victoria', lat: -17.9375, lon: 25.8274, heading: 60, geoid: 8.4, airAGL: 160, country: 'ZW',
    note: 'El Zambeze cae por la grieta de 1,7 km' },
  { id: 'tablemountain', name: 'Ciudad del Cabo · Montaña de la Mesa', lat: -33.9141, lon: 18.4039, heading: 180, geoid: 31.1, airAGL: 1010, country: 'ZA',
    note: 'Desde el puerto hacia la meseta de 1085 m' },
  { id: 'sossusvlei', name: 'Namib · Sossusvlei', lat: -24.763, lon: 15.3241, heading: 270, geoid: 31.8, airAGL: 250, country: 'NA',
    note: 'Dunas rojas de más de 300 m y Deadvlei' },
  { id: 'petra', name: 'Petra', lat: 30.3476, lon: 35.4626, heading: 200, geoid: 19.4, airAGL: 240, country: 'JO',
    note: 'Sobre los cañones de arenisca de la ciudad nabatea' },
  { id: 'burjkhalifa', name: 'Dubái · Burj Khalifa', lat: 25.2206, lon: 55.2595, heading: 150, geoid: -34.1, airAGL: 300, country: 'AE',
    note: 'Entre rascacielos hacia la torre de 828 m' },
  { id: 'tajmahal', name: 'Agra · Taj Mahal', lat: 27.1526, lon: 78.0421, heading: 0, geoid: -57.2, airAGL: 200, country: 'IN',
    note: 'Por los jardines hacia el mausoleo, con el Yamuna detrás' },
  { id: 'muralla', name: 'Gran Muralla · Mutianyu', lat: 40.4111, lon: 116.5783, heading: 330, geoid: -8.4, airAGL: 350, country: 'CN',
    note: 'La muralla por las crestas al norte de Pekín' },
  { id: 'guilin', name: 'Guilin · río Li', lat: 24.947, lon: 110.52, heading: 180, geoid: -19.5, airAGL: 180, country: 'CN',
    note: 'Río abajo entre los picos kársticos de Xingping' },
  { id: 'hongkong', name: 'Hong Kong · bahía Victoria', lat: 22.2827, lon: 114.1277, heading: 80, geoid: -2.5, airAGL: 270, country: 'HK',
    note: 'Sobre el puerto entre los rascacielos de Kowloon y la isla' },
  { id: 'fuji', name: 'Monte Fuji desde Kawaguchiko', lat: 35.5219, lon: 138.8132, heading: 204, geoid: 42.4, airAGL: 390, country: 'JP',
    note: 'Sobre la pagoda Chureito, con el Fuji de frente' },
  { id: 'miyajima', name: 'Miyajima · torii de Itsukushima', lat: 34.317, lon: 132.3291, heading: 200, geoid: 32.7, airAGL: 290, country: 'JP',
    note: 'Desde el mar hacia la gran puerta roja y el santuario' },
  { id: 'halong', name: 'Bahía de Ha Long', lat: 20.8984, lon: 107.0706, heading: 150, geoid: -24.2, airAGL: 200, country: 'VN',
    note: 'Entre miles de islotes de caliza' },
  { id: 'phangnga', name: 'Bahía de Phang Nga', lat: 8.251, lon: 98.4874, heading: 30, geoid: -26.1, airAGL: 200, country: 'TH',
    note: 'Hacia la isla de James Bond entre torres de roca' },
  { id: 'angkor', name: 'Angkor Wat', lat: 13.4125, lon: 103.8439, heading: 90, geoid: -20.8, airAGL: 230, country: 'KH',
    note: 'Por la calzada del oeste hacia las cinco torres' },
  { id: 'bromo', name: 'Java · volcán Bromo', lat: -7.9113, lon: 112.9712, heading: 210, geoid: 32.6, airAGL: 300, country: 'ID',
    note: 'Sobre el mar de arena hacia el cráter humeante' },
  { id: 'marinabay', name: 'Singapur · Marina Bay', lat: 1.2699, lon: 103.8841, heading: 300, geoid: 8.3, airAGL: 270, country: 'SG',
    note: 'Desde el estrecho hacia el hotel de las tres torres' },
  { id: 'sidney', name: 'Sídney · la Ópera', lat: -33.8568, lon: 151.2532, heading: 270, geoid: 22.4, airAGL: 230, country: 'AU',
    note: 'Bahía adentro desde los cabos hacia la Ópera' },
  { id: 'uluru', name: 'Uluru', lat: -25.3444, lon: 131.0767, heading: 270, geoid: 2.2, airAGL: 510, country: 'AU',
    note: 'El monolito rojo de 348 m en mitad del desierto' },
  { id: 'apostoles', name: 'Los Doce Apóstoles', lat: -38.6738, lon: 143.1233, heading: 300, geoid: -1.1, airAGL: 200, country: 'AU',
    note: 'Agujas de caliza frente a la Great Ocean Road' },
  { id: 'milford', name: 'Milford Sound', lat: -44.6396, lon: 167.9102, heading: 305, geoid: 6, airAGL: 250, country: 'NZ',
    note: 'Fiordo abajo junto al Mitre Peak hacia el mar' },
  { id: 'borabora', name: 'Bora Bora', lat: -16.5079, lon: -151.6963, heading: 280, geoid: 8.6, airAGL: 720, country: 'PF',
    note: 'Sobre la laguna turquesa hacia el monte Otemanu' },
  { id: 'nuevayork', name: 'Nueva York · Manhattan y la Estatua de la Libertad', lat: 40.6658, lon: -74.0623, heading: 30, geoid: -32.9, airAGL: 210, country: 'US',
    note: 'Desde la bahía, la estatua y los rascacielos detrás' },
  { id: 'grancanon', name: 'Gran Cañón', lat: 36.106, lon: -112.1174, heading: 170, geoid: -23.4, airAGL: 1360, country: 'US',
    note: 'Sobre el cañón del Colorado hacia Mather Point' },
  { id: 'monumentvalley', name: 'Monument Valley', lat: 36.985, lon: -110.1441, heading: 90, geoid: -21.1, airAGL: 230, country: 'US',
    note: 'Entre las mesas y los Mittens de las películas del Oeste' },
  { id: 'yosemite', name: 'Yosemite · El Capitan', lat: 37.7147, lon: -119.6908, heading: 80, geoid: -25.9, airAGL: 220, country: 'US',
    note: 'Valle arriba entre El Capitan y la cascada Bridalveil' },
  { id: 'kalalau', name: 'Kauai · costa de Nā Pali', lat: 22.1969, lon: -159.6869, heading: 130, geoid: 15.7, airAGL: 610, country: 'US',
    note: 'Hawái · desde el mar hacia el valle de Kalalau' },
  { id: 'niagara', name: 'Cataratas del Niágara', lat: 43.1043, lon: -79.0752, heading: 180, geoid: -36.4, airAGL: 170, country: 'CA',
    note: 'Por el cañón del río hacia la Herradura' },
  { id: 'moraine', name: 'Lago Moraine', lat: 51.3451, lon: -116.1644, heading: 210, geoid: -12.1, airAGL: 480, country: 'CA',
    note: 'Rocosas · el lago turquesa y el valle de los Diez Picos' },
  { id: 'chichenitza', name: 'Chichén Itzá', lat: 20.6618, lon: -88.5678, heading: 0, geoid: -11.3, airAGL: 220, country: 'MX',
    note: 'Sobre la selva hacia la pirámide de Kukulkán' },
  { id: 'tulum', name: 'Tulum', lat: 20.2358, lon: -87.4208, heading: 200, geoid: -10.2, airAGL: 170, country: 'MX',
    note: 'La ciudad maya sobre el acantilado del Caribe' },
  { id: 'teotihuacan', name: 'Teotihuacán', lat: 19.6664, lon: -98.8512, heading: 15, geoid: -5.1, airAGL: 270, country: 'MX',
    note: 'Por la Calzada de los Muertos hacia la pirámide del Sol' },
  { id: 'pitons', name: 'Santa Lucía · los Pitons', lat: 13.81, lon: -61.0928, heading: 90, geoid: -37.5, airAGL: 910, country: 'LC',
    note: 'Desde el Caribe hacia los dos picos volcánicos' },
  { id: 'rio', name: 'Río de Janeiro · Pan de Azúcar', lat: -22.9486, lon: -43.1273, heading: 270, geoid: -5.9, airAGL: 450, country: 'BR',
    note: 'Desde la entrada de la bahía, con el Cristo Redentor detrás' },
  { id: 'iguazu', name: 'Cataratas del Iguazú', lat: -25.7088, lon: -54.4626, heading: 60, geoid: 5.2, airAGL: 160, country: 'AR',
    note: 'Hacia la Garganta del Diablo entre Argentina y Brasil' },
  { id: 'peritomoreno', name: 'Glaciar Perito Moreno', lat: -50.4675, lon: -73.0202, heading: 235, geoid: 14.7, airAGL: 170, country: 'AR',
    note: 'Patagonia · sobre el lago hacia el frente de hielo' },
  { id: 'fitzroy', name: 'El Chaltén · Fitz Roy', lat: -49.3445, lon: -72.8501, heading: 300, geoid: 16.2, airAGL: 910, country: 'AR',
    note: 'Patagonia · sobre el pueblo con el Fitz Roy de frente' },
  { id: 'torresdelpaine', name: 'Torres del Paine', lat: -51.1021, lon: -73.0233, heading: 17, geoid: 13.5, airAGL: 440, country: 'CL',
    note: 'Patagonia · desde el Salto Grande hacia los Cuernos' },
  { id: 'rapanui', name: 'Rapa Nui · Ahu Tongariki', lat: -27.1219, lon: -109.3017, heading: 100, geoid: -3.8, airAGL: 210, country: 'CL',
    note: 'Los quince moáis frente al Pacífico' },
  { id: 'machupicchu', name: 'Machu Picchu', lat: -13.1865, lon: -72.5311, heading: 330, geoid: 43.5, airAGL: 1010, country: 'PE',
    note: 'La ciudadela inca con el Huayna Picchu detrás' },
  { id: 'saltoangel', name: 'Salto Ángel', lat: 5.9955, lon: -62.5269, heading: 200, geoid: -15.1, airAGL: 890, country: 'VE',
    note: 'La cascada más alta del mundo cae del Auyán-tepui' },
  // segunda tanda: más sitios populares
{ id: 'eiffel', name: 'París · Torre Eiffel', lat: 48.8743, lon: 2.2703, heading: 135, geoid: 44.6, airAGL: 190, country: 'FR',
    note: 'Desde el Trocadero, por encima del Sena, hacia la torre' },
  { id: 'versalles', name: 'Palacio de Versalles', lat: 48.8049, lon: 2.0794, heading: 90, geoid: 44.8, airAGL: 220, country: 'FR',
    note: 'Sobre los jardines y el Gran Canal hacia el palacio' },
  { id: 'monaco', name: 'Mónaco · Montecarlo', lat: 43.7093, lon: 7.4334, heading: 340, geoid: 49.2, airAGL: 290, country: 'MC',
    note: 'Desde el mar: el puerto, el casino y el Peñón' },
  { id: 'pisa', name: 'Pisa · Torre inclinada', lat: 43.7035, lon: 10.4122, heading: 330, geoid: 46.8, airAGL: 160, country: 'IT',
    note: 'Sobre la ciudad hacia la Plaza de los Milagros' },
  { id: 'vaticano', name: 'Vaticano · Basílica de San Pedro', lat: 41.9022, lon: 12.4841, heading: 270, geoid: 48.4, airAGL: 230, country: 'VA',
    note: 'Desde el castillo de Sant’Angelo por la Via della Conciliazione' },
  { id: 'amsterdam', name: 'Ámsterdam · los canales', lat: 52.3985, lon: 4.9073, heading: 200, geoid: 43.1, airAGL: 220, country: 'NL',
    note: 'Desde el IJ, sobre la estación central y el anillo de canales' },
  { id: 'berlin', name: 'Berlín · Puerta de Brandeburgo', lat: 52.5163, lon: 13.3333, heading: 90, geoid: 39.6, airAGL: 210, country: 'DE',
    note: 'Por el Tiergarten hacia la puerta y el Reichstag' },
  { id: 'bigben', name: 'Londres · Big Ben y el Parlamento', lat: 51.4773, lon: -0.1463, heading: 30, geoid: 46.1, airAGL: 210, country: 'GB',
    note: 'Por el Támesis desde Vauxhall hacia Westminster' },
  { id: 'dover', name: 'Acantilados blancos de Dover', lat: 51.1080, lon: 1.3650, heading: 0, geoid: 44.7, airAGL: 260, country: 'GB',
    note: 'Desde el canal de la Mancha hacia los acantilados de tiza' },
  { id: 'budapest', name: 'Budapest · Parlamento y el Danubio', lat: 47.4761, lon: 19.0537, heading: 350, geoid: 43.6, airAGL: 250, country: 'HU',
    note: 'Río arriba, bajo los puentes, hacia el Parlamento' },
  { id: 'moscu', name: 'Moscú · Plaza Roja y San Basilio', lat: 55.7366, lon: 37.6514, heading: 315, geoid: 14.4, airAGL: 220, country: 'RU',
    note: 'Desde el río Moscova hacia las cúpulas de San Basilio y el Kremlin' },
  { id: 'plitvice', name: 'Lagos de Plitvice', lat: 44.9070, lon: 15.6100, heading: 180, geoid: 46.1, airAGL: 340, country: 'HR',
    note: 'Sobre la cadena de lagos turquesa y sus cascadas' },
  { id: 'pamukkale', name: 'Pamukkale', lat: 37.9204, lon: 29.0927, heading: 90, geoid: 35.1, airAGL: 340, country: 'TR',
    note: 'Las terrazas blancas de travertino y Hierápolis' },
  { id: 'valeta', name: 'Malta · La Valeta', lat: 35.9243, lon: 14.5260, heading: 200, geoid: 38.0, airAGL: 220, country: 'MT',
    note: 'Desde el mar, la ciudad amurallada y el Gran Puerto' },
  { id: 'navagio', name: 'Zante · playa del Naufragio', lat: 37.8520, lon: 20.5979, heading: 70, geoid: 25.7, airAGL: 420, country: 'GR',
    note: 'La cala entre acantilados con el barco varado' },
  { id: 'merzouga', name: 'Sáhara · dunas de Merzouga', lat: 31.1382, lon: -4.0023, heading: 90, geoid: 48.6, airAGL: 240, country: 'MA',
    note: 'El Erg Chebbi: dunas de hasta 150 m' },
  { id: 'abusimbel', name: 'Abu Simbel', lat: 22.3372, lon: 31.6501, heading: 270, geoid: 10.2, airAGL: 190, country: 'EG',
    note: 'Desde el lago Nasser hacia los templos de Ramsés II' },
  { id: 'lemorne', name: 'Mauricio · Le Morne', lat: -20.4541, lon: 57.2925, heading: 90, geoid: -6.2, airAGL: 680, country: 'MU',
    note: 'La montaña sobre la laguna y su «cascada submarina»' },
  { id: 'sheikhzayed', name: 'Abu Dabi · Gran Mezquita', lat: 24.3903, lon: 54.4750, heading: 0, geoid: -33.2, airAGL: 230, country: 'AE',
    note: 'Las 82 cúpulas blancas de la mezquita Sheikh Zayed' },
  { id: 'palmjumeirah', name: 'Dubái · Palm Jumeirah', lat: 25.1511, lon: 55.1215, heading: 160, geoid: -34.0, airAGL: 300, country: 'AE',
    note: 'La isla con forma de palmera y el hotel Atlantis' },
  { id: 'wadirum', name: 'Wadi Rum', lat: 29.6000, lon: 35.4200, heading: 180, geoid: 18.9, airAGL: 240, country: 'JO',
    note: 'El desierto rojo entre montañas de arenisca' },
  { id: 'tokio', name: 'Tokio · Torre de Tokio', lat: 35.6316, lon: 139.7454, heading: 0, geoid: 36.2, airAGL: 240, country: 'JP',
    note: 'Desde la bahía hacia la torre roja y blanca' },
  { id: 'ciudadprohibida', name: 'Pekín · Ciudad Prohibida', lat: 39.8940, lon: 116.3908, heading: 0, geoid: -9.1, airAGL: 210, country: 'CN',
    note: 'Desde Tiananmén sobre los tejados de los palacios' },
  { id: 'shanghai', name: 'Shanghái · el Bund y Pudong', lat: 31.2419, lon: 121.4637, heading: 90, geoid: 11.7, airAGL: 270, country: 'CN',
    note: 'Por el río Huangpu hacia los rascacielos de Pudong' },
  { id: 'petronas', name: 'Kuala Lumpur · Torres Petronas', lat: 3.1309, lon: 101.7116, heading: 0, geoid: -2.9, airAGL: 290, country: 'MY',
    note: 'Las torres gemelas de 452 m' },
  { id: 'tanahlot', name: 'Bali · templo de Tanah Lot', lat: -8.6371, lon: 115.0707, heading: 45, geoid: 32.9, airAGL: 180, country: 'ID',
    note: 'El templo sobre la roca en el mar' },
  { id: 'mayabay', name: 'Phi Phi · Maya Bay', lat: 7.6556, lon: 98.7653, heading: 0, geoid: -23.6, airAGL: 250, country: 'TH',
    note: 'La bahía entre acantilados de «La Playa»' },
  { id: 'granpalacio', name: 'Bangkok · Gran Palacio', lat: 13.7500, lon: 100.4681, heading: 90, geoid: -31.6, airAGL: 210, country: 'TH',
    note: 'Desde el río Chao Phraya hacia los tejados dorados' },
  { id: 'maldivas', name: 'Maldivas · atolón de Malé', lat: 4.1395, lon: 73.5093, heading: 0, geoid: -96.9, airAGL: 260, country: 'MV',
    note: 'Atolones e islas de arena en el Índico' },
  { id: 'whitehaven', name: 'Whitsundays · Hill Inlet', lat: -20.2335, lon: 149.0208, heading: 180, geoid: 56.9, airAGL: 230, country: 'AU',
    note: 'Arena blanca y remolinos turquesa junto a la Gran Barrera' },
  { id: 'queenstown', name: 'Queenstown y los Remarkables', lat: -45.0518, lon: 168.6209, heading: 55, geoid: 7.5, airAGL: 310, country: 'NZ',
    note: 'Sobre el lago Wakatipu hacia la ciudad y las montañas' },
  { id: 'waikiki', name: 'Honolulu · Waikiki y Diamond Head', lat: 21.2721, lon: -157.8480, heading: 110, geoid: 15.5, airAGL: 470, country: 'US',
    note: 'Hawái · a lo largo de la playa de Waikiki hacia el cráter' },
  { id: 'lasvegas', name: 'Las Vegas · el Strip', lat: 36.0766, lon: -115.1767, heading: 0, geoid: -28.1, airAGL: 280, country: 'US',
    note: 'Los casinos de la avenida, de sur a norte' },
  { id: 'chicago', name: 'Chicago · rascacielos y lago Míchigan', lat: 41.8789, lon: -87.5876, heading: 270, geoid: -33.9, airAGL: 310, country: 'US',
    note: 'Desde el lago hacia la Willis Tower' },
  { id: 'miami', name: 'Miami Beach', lat: 25.7810, lon: -80.1000, heading: 270, geoid: -27.5, airAGL: 210, country: 'US',
    note: 'Playas y hoteles art déco con la bahía detrás' },
  { id: 'toronto', name: 'Toronto · CN Tower', lat: 43.6111, lon: -79.3871, heading: 0, geoid: -37.2, airAGL: 310, country: 'CA',
    note: 'Desde el lago Ontario hacia la torre de 553 m' },
  { id: 'habana', name: 'La Habana · el Malecón', lat: 23.1690, lon: -82.3700, heading: 180, geoid: -23.2, airAGL: 210, country: 'CU',
    note: 'Desde el mar: el castillo del Morro y el Malecón' },
  { id: 'cartagena', name: 'Cartagena de Indias', lat: 10.4101, lon: -75.5748, heading: 60, geoid: -5.9, airAGL: 220, country: 'CO',
    note: 'La ciudad amurallada junto al Caribe' },
]

/** Nombre del lugar en el idioma de la interfaz (los nombres de LOCATIONS están en español). */
export function locationName(l: Location): string {
  const k = `loc.${l.id}`
  // la salida elegida en el mapa del mundo lleva su propio nombre
  if (l.id === 'custom' && l.name) return l.name
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
  /** tendidos eléctricos en 3D (modo sin clave) */
  power: boolean
  locationId: string
  customLat: number
  customLon: number
  /** rumbo verdadero de salida en coordenadas personalizadas (grados) */
  customHeading: number
  /** nombre de la salida elegida en el mapa del mundo ('' = solo coordenadas) */
  customName: string
  /** última salida de cada modo del menú: del mapa ('custom' o un aeródromo) y lugar emblemático */
  mapLocationId: string
  placeLocationId: string
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
  power: true,
  locationId: 'lemt26',
  customLat: 40.2348,
  customLon: -4.027,
  customHeading: 0,
  customName: '',
  mapLocationId: 'lemt26',
  placeLocationId: 'alhambra',
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
