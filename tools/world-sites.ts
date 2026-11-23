// Sitios emblemáticos fuera de España (salidas en vuelo de src/config.ts, agrupadas por país).
//
//   node --experimental-strip-types tools/world-sites.ts check    coordenadas frente a Nominatim (1 petición/s)
//   node --experimental-strip-types tools/world-sites.ts spawns [id…]  salidas (tools/landmark-info.ts) como entradas de
//                                                               LOCATIONS y textos en inglés para i18n.ts
//   node --experimental-strip-types tools/world-sites.ts roofs    tejados de OSM de los monumentos → public/osm-roofs.bin
//
// `lat/lon` es el sitio en sí; la salida queda a `dist` m con rumbo `hdg` hacia él y la altura
// que deja `above` m sobre el sitio y 150 m sobre el relieve del trayecto. `q` es la búsqueda de comprobación.
// `roofs`: hay edificios o monumentos con la forma del tejado mapeada (cúpulas, pirámides…).
// `roofs` hay que volver a pasarlo después de regenerar los tejados de España con tools/osm-roofs.ts.

export interface Site {
  id: string
  cc: string
  es: string
  en: string
  lat: number
  lon: number
  hdg: number
  dist: number
  above: number
  noteEs: string
  noteEn: string
  q: string
  roofs?: boolean
  /** probar rumbos hasta ±search grados y quedarse con la salida más baja (valles, fiordos) */
  search?: number
}

export const SITES: Site[] = [
  // Portugal
  { id: 'belem', cc: 'PT', es: 'Lisboa · Torre de Belém', en: 'Lisbon · Belém Tower', lat: 38.6916, lon: -9.216, hdg: 45, dist: 2500, above: 200,
    noteEs: 'Desde el Tajo, la torre y los Jerónimos con la ciudad detrás', noteEn: 'From the Tagus, the tower and the Jerónimos with the city behind', q: 'Torre de Belém, Lisboa', roofs: true },
  { id: 'pena', cc: 'PT', es: 'Sintra · Palacio da Pena', en: 'Sintra · Pena Palace', lat: 38.7876, lon: -9.3906, hdg: 120, dist: 3000, above: 250,
    noteEs: 'Desde la costa, el palacio de colores en lo alto de la sierra', noteEn: 'From the coast, the colourful palace atop the hills', q: 'Palácio da Pena', roofs: true },
  { id: 'porto', cc: 'PT', es: 'Oporto · la Ribeira y el Duero', en: 'Porto · the Ribeira and the Douro', lat: 41.1406, lon: -8.611, hdg: 90, dist: 3500, above: 200,
    noteEs: 'Río arriba desde la desembocadura hasta el puente Dom Luís I', noteEn: 'Upriver from the mouth to the Dom Luís I bridge', q: 'Ribeira, Porto', roofs: true },
  { id: 'setecidades', cc: 'PT', es: 'Azores · Sete Cidades', en: 'Azores · Sete Cidades', lat: 37.8553, lon: -25.7862, hdg: 290, dist: 3000, above: 400,
    noteEs: 'São Miguel · por encima del borde del cráter y sus dos lagunas', noteEn: 'São Miguel · over the crater rim and its twin lakes', q: 'Lagoa das Sete Cidades' },
  // Francia
  { id: 'msm', cc: 'FR', es: 'Mont-Saint-Michel', en: 'Mont-Saint-Michel', lat: 48.6361, lon: -1.5115, hdg: 135, dist: 3000, above: 200,
    noteEs: 'Desde la bahía, la abadía sobre el islote', noteEn: 'From the bay, the abbey on its tidal island', q: 'Mont-Saint-Michel', roofs: true },
  { id: 'verdon', cc: 'FR', es: 'Gargantas del Verdon', en: 'Verdon Gorge', lat: 43.7497, lon: 6.3286, hdg: 75, dist: 3500, above: 300, search: 30,
    noteEs: 'Desde el lago de Sainte-Croix, cañón adentro', noteEn: 'From Lake Sainte-Croix, into the canyon', q: 'Gorges du Verdon' },
  { id: 'chamonix', cc: 'FR', es: 'Chamonix · Mont Blanc', en: 'Chamonix · Mont Blanc', lat: 45.9237, lon: 6.8694, hdg: 225, dist: 6000, above: 800, search: 30,
    noteEs: 'Valle abajo desde Argentière, con el macizo del Mont Blanc a la izquierda', noteEn: 'Down the valley from Argentière, the Mont Blanc massif on your left', q: 'Chamonix-Mont-Blanc' },
  { id: 'etretat', cc: 'FR', es: 'Étretat · acantilados y la Aguja', en: 'Étretat · cliffs and the Needle', lat: 49.7071, lon: 0.1918, hdg: 75, dist: 2500, above: 150,
    noteEs: 'Normandía · desde el mar hacia los arcos de roca blanca', noteEn: 'Normandy · from the sea towards the white rock arches', q: "Falaise d'Aval, Étretat" },
  { id: 'carcassonne', cc: 'FR', es: 'Carcasona · la Cité', en: 'Carcassonne · La Cité', lat: 43.2063, lon: 2.3637, hdg: 90, dist: 2500, above: 200,
    noteEs: 'La ciudad amurallada con sus 52 torres', noteEn: 'The walled city and its 52 towers', q: 'Cité de Carcassonne', roofs: true },
  // Italia
  { id: 'coliseo', cc: 'IT', es: 'Roma · Coliseo y Foro', en: 'Rome · Colosseum and Forum', lat: 41.8902, lon: 12.4922, hdg: 110, dist: 3000, above: 250,
    noteEs: 'Sobre el centro histórico hacia el Coliseo', noteEn: 'Over the historic centre towards the Colosseum', q: 'Colosseo, Roma', roofs: true },
  { id: 'venecia', cc: 'IT', es: 'Venecia · San Marcos', en: 'Venice · St Mark’s', lat: 45.434, lon: 12.3388, hdg: 45, dist: 2500, above: 200,
    noteEs: 'Por el canal de la Giudecca hacia la plaza y el campanile', noteEn: 'Along the Giudecca canal to the square and the campanile', q: 'Piazza San Marco', roofs: true },
  { id: 'positano', cc: 'IT', es: 'Costa Amalfitana · Positano', en: 'Amalfi Coast · Positano', lat: 40.6281, lon: 14.4849, hdg: 20, dist: 2500, above: 200,
    noteEs: 'Desde el mar, el pueblo colgado de la ladera', noteEn: 'From the sea, the village clinging to the hillside', q: 'Positano', roofs: true },
  { id: 'cinqueterre', cc: 'IT', es: 'Cinque Terre · Manarola', en: 'Cinque Terre · Manarola', lat: 44.1067, lon: 9.7286, hdg: 330, dist: 2500, above: 150,
    noteEs: 'Costa arriba, de pueblo en pueblo entre viñedos', noteEn: 'Up the coast, village to village between vineyards', q: 'Manarola' },
  { id: 'trecime', cc: 'IT', es: 'Dolomitas · Tre Cime di Lavaredo', en: 'Dolomites · Tre Cime di Lavaredo', lat: 46.6178, lon: 12.2954, hdg: 10, dist: 4000, above: 100,
    noteEs: 'Desde el lago de Misurina hacia las tres torres de roca', noteEn: 'From Lake Misurina towards the three rock towers', q: 'Tre Cime di Lavaredo' },
  { id: 'vesubio', cc: 'IT', es: 'Vesubio y golfo de Nápoles', en: 'Vesuvius and the Bay of Naples', lat: 40.8214, lon: 14.426, hdg: 90, dist: 4000, above: 250,
    noteEs: 'Desde el golfo hacia el cráter, con Pompeya al sur', noteEn: 'From the bay to the crater, Pompeii to the south', q: 'Vesuvio' },
  { id: 'florencia', cc: 'IT', es: 'Florencia · Duomo', en: 'Florence · the Duomo', lat: 43.7731, lon: 11.256, hdg: 60, dist: 2500, above: 200,
    noteEs: 'Por el Arno y el Ponte Vecchio hacia la cúpula de Brunelleschi', noteEn: 'Over the Arno and Ponte Vecchio to Brunelleschi’s dome', q: 'Cattedrale di Santa Maria del Fiore', roofs: true },
  // Suiza
  { id: 'cervino', cc: 'CH', es: 'Zermatt · el Cervino', en: 'Zermatt · the Matterhorn', lat: 46.0207, lon: 7.7491, hdg: 200, dist: 4000, above: 700, search: 30,
    noteEs: 'Valle arriba hacia Zermatt con el Cervino de frente', noteEn: 'Up the valley to Zermatt with the Matterhorn ahead', q: 'Zermatt' },
  { id: 'lauterbrunnen', cc: 'CH', es: 'Valle de Lauterbrunnen', en: 'Lauterbrunnen Valley', lat: 46.5935, lon: 7.909, hdg: 170, dist: 3000, above: 400, search: 20,
    noteEs: 'Entre paredes y cascadas, con la Jungfrau al fondo', noteEn: 'Between cliffs and waterfalls, the Jungfrau ahead', q: 'Lauterbrunnen' },
  { id: 'chillon', cc: 'CH', es: 'Lago Lemán · castillo de Chillon', en: 'Lake Geneva · Chillon Castle', lat: 46.4142, lon: 6.9275, hdg: 110, dist: 3000, above: 200,
    noteEs: 'Sobre el lago hacia el castillo, con los Alpes detrás', noteEn: 'Across the lake to the castle, the Alps behind', q: 'Château de Chillon', roofs: true },
  // Austria
  { id: 'hallstatt', cc: 'AT', es: 'Hallstatt', en: 'Hallstatt', lat: 47.5622, lon: 13.6493, hdg: 210, dist: 3000, above: 250, search: 30,
    noteEs: 'Sobre el lago hacia el pueblo al pie de la montaña', noteEn: 'Over the lake to the village at the foot of the mountain', q: 'Hallstatt', roofs: true },
  // Alemania
  { id: 'neuschwanstein', cc: 'DE', es: 'Castillo de Neuschwanstein', en: 'Neuschwanstein Castle', lat: 47.5576, lon: 10.7498, hdg: 160, dist: 3000, above: 200,
    noteEs: 'Baviera · desde los lagos hacia el castillo y los Alpes', noteEn: 'Bavaria · from the lakes to the castle and the Alps', q: 'Schloss Neuschwanstein', roofs: true },
  // Reino Unido e Irlanda
  { id: 'londres', cc: 'GB', es: 'Londres · el Támesis y la City', en: 'London · the Thames and the City', lat: 51.5081, lon: -0.0759, hdg: 90, dist: 4000, above: 250,
    noteEs: 'Río abajo desde Westminster hacia la Torre de Londres', noteEn: 'Downriver from Westminster to the Tower of London', q: 'Tower of London', roofs: true },
  { id: 'edimburgo', cc: 'GB', es: 'Edimburgo · castillo', en: 'Edinburgh · the Castle', lat: 55.9486, lon: -3.1999, hdg: 80, dist: 3000, above: 200,
    noteEs: 'Escocia · el castillo sobre su roca y Arthur’s Seat detrás', noteEn: 'Scotland · the castle on its rock, Arthur’s Seat behind', q: 'Edinburgh Castle', roofs: true },
  { id: 'storr', cc: 'GB', es: 'Isla de Skye · Old Man of Storr', en: 'Isle of Skye · Old Man of Storr', lat: 57.507, lon: -6.1746, hdg: 270, dist: 3000, above: 200,
    noteEs: 'Escocia · desde el mar hacia los pináculos de roca', noteEn: 'Scotland · from the sea towards the rock pinnacles', q: 'Old Man of Storr' },
  { id: 'calzada', cc: 'GB', es: 'Calzada del Gigante', en: 'Giant’s Causeway', lat: 55.2408, lon: -6.5116, hdg: 180, dist: 2500, above: 150,
    noteEs: 'Irlanda del Norte · desde el mar hacia las columnas de basalto', noteEn: 'Northern Ireland · from the sea to the basalt columns', q: 'Giant’s Causeway' },
  { id: 'moher', cc: 'IE', es: 'Acantilados de Moher', en: 'Cliffs of Moher', lat: 52.9715, lon: -9.4309, hdg: 80, dist: 3000, above: 150,
    noteEs: 'Desde el Atlántico hacia los acantilados de 200 m', noteEn: 'From the Atlantic towards the 200 m cliffs', q: 'Cliffs of Moher' },
  // Países nórdicos
  { id: 'geiranger', cc: 'NO', es: 'Fiordo de Geiranger', en: 'Geirangerfjord', lat: 62.1006, lon: 7.2059, hdg: 95, dist: 5000, above: 300, search: 20,
    noteEs: 'Fiordo adentro, de las Siete Hermanas hasta Geiranger', noteEn: 'Up the fjord from the Seven Sisters to Geiranger', q: 'Geiranger' },
  { id: 'preikestolen', cc: 'NO', es: 'Preikestolen', en: 'Preikestolen (Pulpit Rock)', lat: 58.9864, lon: 6.1906, hdg: 80, dist: 3000, above: 150,
    noteEs: 'Sobre el Lysefjord hacia el púlpito de roca de 604 m', noteEn: 'Over the Lysefjord to the 604 m pulpit of rock', q: 'Preikestolen' },
  { id: 'reine', cc: 'NO', es: 'Lofoten · Reine', en: 'Lofoten · Reine', lat: 67.933, lon: 13.088, hdg: 200, dist: 3000, above: 300,
    noteEs: 'Por encima del círculo polar, picos sobre el mar', noteEn: 'Above the Arctic Circle, peaks rising from the sea', q: 'Reine, Moskenes' },
  { id: 'kirkjufell', cc: 'IS', es: 'Kirkjufell', en: 'Kirkjufell', lat: 64.9415, lon: -23.306, hdg: 270, dist: 3000, above: 200,
    noteEs: 'La montaña de la iglesia junto a Grundarfjörður', noteEn: 'The church mountain by Grundarfjörður', q: 'Kirkjufell' },
  { id: 'jokulsarlon', cc: 'IS', es: 'Jökulsárlón', en: 'Jökulsárlón', lat: 64.0484, lon: -16.1791, hdg: 340, dist: 3000, above: 200,
    noteEs: 'Desde la playa de los diamantes hacia la laguna de icebergs y el glaciar', noteEn: 'From Diamond Beach to the iceberg lagoon and the glacier', q: 'Jökulsárlón' },
  // Resto de Europa
  { id: 'santorini', cc: 'GR', es: 'Santorini · Oía y la caldera', en: 'Santorini · Oia and the caldera', lat: 36.4618, lon: 25.3753, hdg: 30, dist: 3000, above: 200,
    noteEs: 'Dentro de la caldera hacia el pueblo blanco en lo alto', noteEn: 'Inside the caldera towards the white village on the rim', q: 'Oia, Santorini' },
  { id: 'meteora', cc: 'GR', es: 'Meteora', en: 'Meteora', lat: 39.7217, lon: 21.6306, hdg: 0, dist: 3000, above: 200,
    noteEs: 'Desde Kalambaka hacia los monasterios sobre las rocas', noteEn: 'From Kalambaka to the monasteries on the rocks', q: 'Meteora' },
  { id: 'acropolis', cc: 'GR', es: 'Atenas · Acrópolis', en: 'Athens · the Acropolis', lat: 37.9715, lon: 23.7257, hdg: 30, dist: 3000, above: 250,
    noteEs: 'Sobre la ciudad hacia la roca del Partenón', noteEn: 'Over the city towards the rock of the Parthenon', q: 'Acropolis of Athens', roofs: true },
  { id: 'dubrovnik', cc: 'HR', es: 'Dubrovnik', en: 'Dubrovnik', lat: 42.641, lon: 18.11, hdg: 30, dist: 2500, above: 150,
    noteEs: 'Desde el Adriático hacia la ciudad amurallada', noteEn: 'From the Adriatic to the walled city', q: 'Dubrovnik', roofs: true },
  { id: 'bled', cc: 'SI', es: 'Lago de Bled', en: 'Lake Bled', lat: 46.3625, lon: 14.094, hdg: 250, dist: 2500, above: 200,
    noteEs: 'La iglesia en la isla y el castillo sobre el lago', noteEn: 'The island church and the castle above the lake', q: 'Blejski otok' },
  { id: 'praga', cc: 'CZ', es: 'Praga · castillo y puente de Carlos', en: 'Prague · Castle and Charles Bridge', lat: 50.0865, lon: 14.4114, hdg: 340, dist: 3000, above: 200,
    noteEs: 'Por el Moldava hacia el puente y el castillo', noteEn: 'Along the Vltava to the bridge and the castle', q: 'Karlův most', roofs: true },
  { id: 'capadocia', cc: 'TR', es: 'Capadocia · Göreme', en: 'Cappadocia · Göreme', lat: 38.6431, lon: 34.8289, hdg: 90, dist: 3000, above: 250,
    noteEs: 'Sobre las chimeneas de hadas, como los globos al amanecer', noteEn: 'Over the fairy chimneys, like the dawn balloons', q: 'Göreme' },
  { id: 'estambul', cc: 'TR', es: 'Estambul · Santa Sofía y el Bósforo', en: 'Istanbul · Hagia Sophia and the Bosphorus', lat: 41.0086, lon: 28.9802, hdg: 270, dist: 3000, above: 200,
    noteEs: 'Desde el Bósforo hacia Santa Sofía y la Mezquita Azul', noteEn: 'From the Bosphorus to Hagia Sophia and the Blue Mosque', q: 'Hagia Sophia, Istanbul', roofs: true },
  { id: 'gibraltar', cc: 'GI', es: 'Peñón de Gibraltar', en: 'Rock of Gibraltar', lat: 36.1286, lon: -5.3444, hdg: 170, dist: 3000, above: 200,
    noteEs: 'Desde la bahía hacia el peñón, con África al fondo', noteEn: 'From the bay to the Rock, Africa beyond', q: 'Rock of Gibraltar' },
  // África
  { id: 'aitbenhaddou', cc: 'MA', es: 'Aït Ben Haddou', en: 'Aït Benhaddou', lat: 31.047, lon: -7.129, hdg: 270, dist: 2500, above: 200,
    noteEs: 'La kasba de adobe junto al río, al pie del Atlas', noteEn: 'The mud-brick ksar by the river, below the Atlas', q: 'Aït Benhaddou' },
  { id: 'giza', cc: 'EG', es: 'Pirámides de Guiza', en: 'Pyramids of Giza', lat: 29.9792, lon: 31.1342, hdg: 240, dist: 3000, above: 200,
    noteEs: 'Desde El Cairo hacia Keops, Kefrén y Micerinos', noteEn: 'From Cairo towards Khufu, Khafre and Menkaure', q: 'Pyramid of Khufu', roofs: true },
  { id: 'victoria', cc: 'ZW', es: 'Cataratas Victoria', en: 'Victoria Falls', lat: -17.924, lon: 25.852, hdg: 60, dist: 3000, above: 200,
    noteEs: 'El Zambeze cae por la grieta de 1,7 km', noteEn: 'The Zambezi plunging into its 1.7 km chasm', q: 'Victoria Falls' },
  { id: 'tablemountain', cc: 'ZA', es: 'Ciudad del Cabo · Montaña de la Mesa', en: 'Cape Town · Table Mountain', lat: -33.9591, lon: 18.4039, hdg: 180, dist: 5000, above: 150,
    noteEs: 'Desde el puerto hacia la meseta de 1085 m', noteEn: 'From the harbour to the 1085 m plateau', q: 'Table Mountain' },
  { id: 'sossusvlei', cc: 'NA', es: 'Namib · Sossusvlei', en: 'Namib · Sossusvlei', lat: -24.763, lon: 15.2944, hdg: 270, dist: 3000, above: 200,
    noteEs: 'Dunas rojas de más de 300 m y Deadvlei', noteEn: 'Red dunes over 300 m high and Deadvlei', q: 'Deadvlei' },
  // Asia
  { id: 'petra', cc: 'JO', es: 'Petra', en: 'Petra', lat: 30.3222, lon: 35.4519, hdg: 200, dist: 3000, above: 250,
    noteEs: 'Sobre los cañones de arenisca de la ciudad nabatea', noteEn: 'Over the sandstone canyons of the Nabataean city', q: 'Al-Khazneh, Petra' },
  { id: 'burjkhalifa', cc: 'AE', es: 'Dubái · Burj Khalifa', en: 'Dubai · Burj Khalifa', lat: 25.1972, lon: 55.2744, hdg: 150, dist: 3000, above: 300,
    noteEs: 'Entre rascacielos hacia la torre de 828 m', noteEn: 'Between skyscrapers to the 828 m tower', q: 'Burj Khalifa', roofs: true },
  { id: 'tajmahal', cc: 'IN', es: 'Agra · Taj Mahal', en: 'Agra · Taj Mahal', lat: 27.1751, lon: 78.0421, hdg: 0, dist: 2500, above: 200,
    noteEs: 'Por los jardines hacia el mausoleo, con el Yamuna detrás', noteEn: 'Over the gardens to the mausoleum, the Yamuna behind', q: 'Taj Mahal', roofs: true },
  { id: 'muralla', cc: 'CN', es: 'Gran Muralla · Mutianyu', en: 'Great Wall · Mutianyu', lat: 40.4345, lon: 116.5606, hdg: 330, dist: 3000, above: 250,
    noteEs: 'La muralla por las crestas al norte de Pekín', noteEn: 'The wall along the ridges north of Beijing', q: 'Mutianyu Great Wall' },
  { id: 'guilin', cc: 'CN', es: 'Guilin · río Li', en: 'Guilin · Li River', lat: 24.92, lon: 110.52, hdg: 180, dist: 3000, above: 250,
    noteEs: 'Río abajo entre los picos kársticos de Xingping', noteEn: 'Downriver among the karst peaks of Xingping', q: 'Xingping, Yangshuo' },
  { id: 'hongkong', cc: 'HK', es: 'Hong Kong · bahía Victoria', en: 'Hong Kong · Victoria Harbour', lat: 22.289, lon: 114.166, hdg: 80, dist: 4000, above: 300,
    noteEs: 'Sobre el puerto entre los rascacielos de Kowloon y la isla', noteEn: 'Over the harbour between Kowloon and the island skyline', q: 'Avenue of Stars, Hong Kong', roofs: true },
  { id: 'fuji', cc: 'JP', es: 'Monte Fuji desde Kawaguchiko', en: 'Mount Fuji from Kawaguchiko', lat: 35.5013, lon: 138.802, hdg: 204, dist: 2500, above: 400,
    noteEs: 'Sobre la pagoda Chureito, con el Fuji de frente', noteEn: 'Over the Chureito pagoda with Fuji straight ahead', q: 'Chureito Pagoda' },
  { id: 'miyajima', cc: 'JP', es: 'Miyajima · torii de Itsukushima', en: 'Miyajima · Itsukushima torii', lat: 34.2959, lon: 132.3198, hdg: 200, dist: 2500, above: 150,
    noteEs: 'Desde el mar hacia la gran puerta roja y el santuario', noteEn: 'From the sea to the great red gate and the shrine', q: 'Itsukushima Shrine' },
  { id: 'halong', cc: 'VN', es: 'Bahía de Ha Long', en: 'Ha Long Bay', lat: 20.875, lon: 107.085, hdg: 150, dist: 3000, above: 200,
    noteEs: 'Entre miles de islotes de caliza', noteEn: 'Among thousands of limestone islets', q: 'Vịnh Hạ Long' },
  { id: 'phangnga', cc: 'TH', es: 'Bahía de Phang Nga', en: 'Phang Nga Bay', lat: 8.2744, lon: 98.501, hdg: 30, dist: 3000, above: 150,
    noteEs: 'Hacia la isla de James Bond entre torres de roca', noteEn: 'To James Bond Island between rock towers', q: 'Khao Phing Kan' },
  { id: 'angkor', cc: 'KH', es: 'Angkor Wat', en: 'Angkor Wat', lat: 13.4125, lon: 103.867, hdg: 90, dist: 2500, above: 200,
    noteEs: 'Por la calzada del oeste hacia las cinco torres', noteEn: 'Along the western causeway to the five towers', q: 'Angkor Wat', roofs: true },
  { id: 'bromo', cc: 'ID', es: 'Java · volcán Bromo', en: 'Java · Mount Bromo', lat: -7.9425, lon: 112.953, hdg: 210, dist: 4000, above: 250,
    noteEs: 'Sobre el mar de arena hacia el cráter humeante', noteEn: 'Over the sea of sand to the smoking crater', q: 'Gunung Bromo' },
  { id: 'marinabay', cc: 'SG', es: 'Singapur · Marina Bay', en: 'Singapore · Marina Bay', lat: 1.2834, lon: 103.8607, hdg: 300, dist: 3000, above: 250,
    noteEs: 'Desde el estrecho hacia el hotel de las tres torres', noteEn: 'From the strait to the three-tower hotel', q: 'Marina Bay Sands', roofs: true },
  // Oceanía
  { id: 'sidney', cc: 'AU', es: 'Sídney · la Ópera', en: 'Sydney · the Opera House', lat: -33.8568, lon: 151.2153, hdg: 270, dist: 3500, above: 200,
    noteEs: 'Bahía adentro desde los cabos hacia la Ópera', noteEn: 'Into the harbour from the Heads to the Opera House', q: 'Sydney Opera House', roofs: true },
  { id: 'uluru', cc: 'AU', es: 'Uluru', en: 'Uluru', lat: -25.3444, lon: 131.0369, hdg: 270, dist: 4000, above: 200,
    noteEs: 'El monolito rojo de 348 m en mitad del desierto', noteEn: 'The 348 m red monolith in the middle of the desert', q: 'Uluru' },
  { id: 'apostoles', cc: 'AU', es: 'Los Doce Apóstoles', en: 'The Twelve Apostles', lat: -38.6603, lon: 143.0934, hdg: 300, dist: 3000, above: 150,
    noteEs: 'Agujas de caliza frente a la Great Ocean Road', noteEn: 'Limestone stacks off the Great Ocean Road', q: 'Twelve Apostles, Victoria' },
  { id: 'milford', cc: 'NZ', es: 'Milford Sound', en: 'Milford Sound', lat: -44.619, lon: 167.8688, hdg: 315, dist: 4000, above: 250, search: 30,
    noteEs: 'Fiordo abajo junto al Mitre Peak hacia el mar', noteEn: 'Down the fjord past Mitre Peak to the sea', q: 'Milford Sound' },
  { id: 'borabora', cc: 'PF', es: 'Bora Bora', en: 'Bora Bora', lat: -16.5016, lon: -151.7333, hdg: 280, dist: 4000, above: 300,
    noteEs: 'Sobre la laguna turquesa hacia el monte Otemanu', noteEn: 'Over the turquoise lagoon to Mount Otemanu', q: 'Mont Otemanu' },
  // América del Norte
  { id: 'nuevayork', cc: 'US', es: 'Nueva York · Manhattan y la Estatua de la Libertad', en: 'New York · Manhattan and the Statue of Liberty', lat: 40.6892, lon: -74.0445, hdg: 30, dist: 3000, above: 200,
    noteEs: 'Desde la bahía, la estatua y los rascacielos detrás', noteEn: 'From the bay, the statue with the skyscrapers behind', q: 'Statue of Liberty', roofs: true },
  { id: 'grancanon', cc: 'US', es: 'Gran Cañón', en: 'Grand Canyon', lat: 36.0617, lon: -112.1077, hdg: 170, dist: 5000, above: 250,
    noteEs: 'Sobre el cañón del Colorado hacia Mather Point', noteEn: 'Over the Colorado canyon towards Mather Point', q: 'Mather Point' },
  { id: 'monumentvalley', cc: 'US', es: 'Monument Valley', en: 'Monument Valley', lat: 36.985, lon: -110.099, hdg: 90, dist: 4000, above: 200,
    noteEs: 'Entre las mesas y los Mittens de las películas del Oeste', noteEn: 'Among the buttes and Mittens of the westerns', q: 'Monument Valley Navajo Tribal Park' },
  { id: 'yosemite', cc: 'US', es: 'Yosemite · El Capitan', en: 'Yosemite · El Capitan', lat: 37.721, lon: -119.646, hdg: 60, dist: 4000, above: 600, search: 30,
    noteEs: 'Valle arriba entre El Capitan y la cascada Bridalveil', noteEn: 'Up the valley between El Capitan and Bridalveil Fall', q: 'Bridalveil Fall' },
  { id: 'kalalau', cc: 'US', es: 'Kauai · costa de Nā Pali', en: 'Kauai · Nā Pali Coast', lat: 22.1738, lon: -159.6571, hdg: 130, dist: 4000, above: 300,
    noteEs: 'Hawái · desde el mar hacia el valle de Kalalau', noteEn: 'Hawaii · from the sea into the Kalalau Valley', q: 'Kalalau Beach' },
  { id: 'niagara', cc: 'CA', es: 'Cataratas del Niágara', en: 'Niagara Falls', lat: 43.0773, lon: -79.0752, hdg: 180, dist: 3000, above: 200,
    noteEs: 'Por el cañón del río hacia la Herradura', noteEn: 'Up the river gorge to the Horseshoe Falls', q: 'Horseshoe Falls, Ontario' },
  { id: 'moraine', cc: 'CA', es: 'Lago Moraine', en: 'Moraine Lake', lat: 51.3217, lon: -116.186, hdg: 210, dist: 3000, above: 400, search: 60,
    noteEs: 'Rocosas · el lago turquesa y el valle de los Diez Picos', noteEn: 'Rockies · the turquoise lake and the Valley of the Ten Peaks', q: 'Moraine Lake' },
  { id: 'chichenitza', cc: 'MX', es: 'Chichén Itzá', en: 'Chichén Itzá', lat: 20.6843, lon: -88.5678, hdg: 0, dist: 2500, above: 200,
    noteEs: 'Sobre la selva hacia la pirámide de Kukulkán', noteEn: 'Over the jungle to the pyramid of Kukulcán', q: 'Chichén Itzá', roofs: true },
  { id: 'tulum', cc: 'MX', es: 'Tulum', en: 'Tulum', lat: 20.2147, lon: -87.429, hdg: 200, dist: 2500, above: 150,
    noteEs: 'La ciudad maya sobre el acantilado del Caribe', noteEn: 'The Maya city on its Caribbean clifftop', q: 'Zona Arqueológica de Tulum' },
  { id: 'teotihuacan', cc: 'MX', es: 'Teotihuacán', en: 'Teotihuacan', lat: 19.6925, lon: -98.8438, hdg: 15, dist: 3000, above: 200,
    noteEs: 'Por la Calzada de los Muertos hacia la pirámide del Sol', noteEn: 'Along the Avenue of the Dead to the Pyramid of the Sun', q: 'Pirámide del Sol', roofs: true },
  { id: 'pitons', cc: 'LC', es: 'Santa Lucía · los Pitons', en: 'Saint Lucia · the Pitons', lat: 13.81, lon: -61.065, hdg: 90, dist: 3000, above: 200,
    noteEs: 'Desde el Caribe hacia los dos picos volcánicos', noteEn: 'From the Caribbean to the twin volcanic spires', q: 'Gros Piton' },
  // América del Sur
  { id: 'rio', cc: 'BR', es: 'Río de Janeiro · Pan de Azúcar', en: 'Rio de Janeiro · Sugarloaf', lat: -22.9486, lon: -43.1566, hdg: 270, dist: 3000, above: 200,
    noteEs: 'Desde la entrada de la bahía, con el Cristo Redentor detrás', noteEn: 'From the bay entrance, Christ the Redeemer behind', q: 'Pão de Açúcar, Rio de Janeiro' },
  { id: 'iguazu', cc: 'AR', es: 'Cataratas del Iguazú', en: 'Iguazú Falls', lat: -25.6953, lon: -54.4367, hdg: 60, dist: 3000, above: 200,
    noteEs: 'Hacia la Garganta del Diablo entre Argentina y Brasil', noteEn: 'To the Devil’s Throat between Argentina and Brazil', q: 'Garganta del Diablo, Iguazú' },
  { id: 'peritomoreno', cc: 'AR', es: 'Glaciar Perito Moreno', en: 'Perito Moreno Glacier', lat: -50.483, lon: -73.055, hdg: 235, dist: 3000, above: 250,
    noteEs: 'Patagonia · sobre el lago hacia el frente de hielo', noteEn: 'Patagonia · over the lake to the ice front', q: 'Glaciar Perito Moreno' },
  { id: 'fitzroy', cc: 'AR', es: 'El Chaltén · Fitz Roy', en: 'El Chaltén · Fitz Roy', lat: -49.331, lon: -72.886, hdg: 300, dist: 3000, above: 900,
    noteEs: 'Patagonia · sobre el pueblo con el Fitz Roy de frente', noteEn: 'Patagonia · over the village with Fitz Roy ahead', q: 'El Chaltén' },
  { id: 'torresdelpaine', cc: 'CL', es: 'Torres del Paine', en: 'Torres del Paine', lat: -51.0677, lon: -73.0066, hdg: 17, dist: 4000, above: 500,
    noteEs: 'Patagonia · desde el Salto Grande hacia los Cuernos', noteEn: 'Patagonia · from Salto Grande towards the Horns', q: 'Salto Grande, Torres del Paine' },
  { id: 'rapanui', cc: 'CL', es: 'Rapa Nui · Ahu Tongariki', en: 'Easter Island · Ahu Tongariki', lat: -27.1258, lon: -109.2768, hdg: 100, dist: 2500, above: 150,
    noteEs: 'Los quince moáis frente al Pacífico', noteEn: 'The fifteen moai facing the Pacific', q: 'Ahu Tongariki, Isla de Pascua' },
  { id: 'machupicchu', cc: 'PE', es: 'Machu Picchu', en: 'Machu Picchu', lat: -13.1631, lon: -72.545, hdg: 330, dist: 3000, above: 300,
    noteEs: 'La ciudadela inca con el Huayna Picchu detrás', noteEn: 'The Inca citadel with Huayna Picchu behind', q: 'Machu Picchu' },
  { id: 'saltoangel', cc: 'VE', es: 'Salto Ángel', en: 'Angel Falls', lat: 5.9701, lon: -62.5362, hdg: 200, dist: 3000, above: 200,
    noteEs: 'La cascada más alta del mundo cae del Auyán-tepui', noteEn: 'The world’s highest waterfall pours off Auyán-tepui', q: 'Salto Ángel' },
  // Más sitios populares (segunda tanda)
  { id: 'eiffel', cc: 'FR', es: 'París · Torre Eiffel', en: 'Paris · Eiffel Tower', lat: 48.8584, lon: 2.2945, hdg: 135, dist: 2500, above: 150,
    noteEs: 'Desde el Trocadero, por encima del Sena, hacia la torre', noteEn: 'From the Trocadéro, over the Seine, to the tower', q: 'Tour Eiffel', roofs: true },
  { id: 'versalles', cc: 'FR', es: 'Palacio de Versalles', en: 'Palace of Versailles', lat: 48.8049, lon: 2.1204, hdg: 90, dist: 3000, above: 200,
    noteEs: 'Sobre los jardines y el Gran Canal hacia el palacio', noteEn: 'Over the gardens and the Grand Canal to the palace', q: 'Château de Versailles', roofs: true },
  { id: 'monaco', cc: 'MC', es: 'Mónaco · Montecarlo', en: 'Monaco · Monte Carlo', lat: 43.7347, lon: 7.4206, hdg: 340, dist: 3000, above: 200,
    noteEs: 'Desde el mar: el puerto, el casino y el Peñón', noteEn: 'From the sea: the harbour, the casino and the Rock', q: 'Port Hercule', roofs: true },
  { id: 'pisa', cc: 'IT', es: 'Pisa · Torre inclinada', en: 'Pisa · Leaning Tower', lat: 43.723, lon: 10.3966, hdg: 330, dist: 2500, above: 150,
    noteEs: 'Sobre la ciudad hacia la Plaza de los Milagros', noteEn: 'Over the city to the Square of Miracles', q: 'Torre di Pisa', roofs: true },
  { id: 'vaticano', cc: 'VA', es: 'Vaticano · Basílica de San Pedro', en: 'Vatican · St Peter’s Basilica', lat: 41.9022, lon: 12.4539, hdg: 270, dist: 2500, above: 200,
    noteEs: 'Desde el castillo de Sant’Angelo por la Via della Conciliazione', noteEn: 'From Castel Sant’Angelo along Via della Conciliazione', q: 'Basilica di San Pietro', roofs: true },
  { id: 'amsterdam', cc: 'NL', es: 'Ámsterdam · los canales', en: 'Amsterdam · the canals', lat: 52.3731, lon: 4.8922, hdg: 200, dist: 3000, above: 200,
    noteEs: 'Desde el IJ, sobre la estación central y el anillo de canales', noteEn: 'From the IJ over Central Station and the canal ring', q: 'Dam, Amsterdam', roofs: true },
  { id: 'berlin', cc: 'DE', es: 'Berlín · Puerta de Brandeburgo', en: 'Berlin · Brandenburg Gate', lat: 52.5163, lon: 13.3777, hdg: 90, dist: 3000, above: 200,
    noteEs: 'Por el Tiergarten hacia la puerta y el Reichstag', noteEn: 'Over the Tiergarten to the Gate and the Reichstag', q: 'Brandenburger Tor', roofs: true },
  { id: 'bigben', cc: 'GB', es: 'Londres · Big Ben y el Parlamento', en: 'London · Big Ben and Parliament', lat: 51.5007, lon: -0.1246, hdg: 30, dist: 3000, above: 200,
    noteEs: 'Por el Támesis desde Vauxhall hacia Westminster', noteEn: 'Along the Thames from Vauxhall to Westminster', q: 'Elizabeth Tower', roofs: true },
  { id: 'dover', cc: 'GB', es: 'Acantilados blancos de Dover', en: 'White Cliffs of Dover', lat: 51.135, lon: 1.365, hdg: 0, dist: 3000, above: 150,
    noteEs: 'Desde el canal de la Mancha hacia los acantilados de tiza', noteEn: 'From the Channel to the chalk cliffs', q: 'White Cliffs of Dover' },
  { id: 'budapest', cc: 'HU', es: 'Budapest · Parlamento y el Danubio', en: 'Budapest · Parliament and the Danube', lat: 47.5071, lon: 19.0456, hdg: 350, dist: 3500, above: 200,
    noteEs: 'Río arriba, bajo los puentes, hacia el Parlamento', noteEn: 'Upriver past the bridges to Parliament', q: 'Országház', roofs: true },
  { id: 'moscu', cc: 'RU', es: 'Moscú · Plaza Roja y San Basilio', en: 'Moscow · Red Square and St Basil’s', lat: 55.7525, lon: 37.6231, hdg: 315, dist: 2500, above: 200,
    noteEs: 'Desde el río Moscova hacia las cúpulas de San Basilio y el Kremlin', noteEn: 'From the Moskva river to St Basil’s domes and the Kremlin', q: 'Собор Василия Блаженного', roofs: true },
  { id: 'plitvice', cc: 'HR', es: 'Lagos de Plitvice', en: 'Plitvice Lakes', lat: 44.88, lon: 15.61, hdg: 180, dist: 3000, above: 200,
    noteEs: 'Sobre la cadena de lagos turquesa y sus cascadas', noteEn: 'Over the chain of turquoise lakes and waterfalls', q: 'Plitvička jezera' },
  { id: 'pamukkale', cc: 'TR', es: 'Pamukkale', en: 'Pamukkale', lat: 37.9204, lon: 29.1212, hdg: 90, dist: 2500, above: 200,
    noteEs: 'Las terrazas blancas de travertino y Hierápolis', noteEn: 'The white travertine terraces and Hierapolis', q: 'Pamukkale' },
  { id: 'valeta', cc: 'MT', es: 'Malta · La Valeta', en: 'Malta · Valletta', lat: 35.8989, lon: 14.5146, hdg: 200, dist: 3000, above: 150,
    noteEs: 'Desde el mar, la ciudad amurallada y el Gran Puerto', noteEn: 'From the sea: the walled city and the Grand Harbour', q: 'Valletta', roofs: true },
  { id: 'navagio', cc: 'GR', es: 'Zante · playa del Naufragio', en: 'Zakynthos · Shipwreck Beach', lat: 37.8597, lon: 20.6247, hdg: 70, dist: 2500, above: 200,
    noteEs: 'La cala entre acantilados con el barco varado', noteEn: 'The cove between cliffs with the stranded ship', q: 'Navagio Beach, Zakynthos' },
  { id: 'merzouga', cc: 'MA', es: 'Sáhara · dunas de Merzouga', en: 'Sahara · Merzouga dunes', lat: 31.1382, lon: -3.9708, hdg: 90, dist: 3000, above: 200,
    noteEs: 'El Erg Chebbi: dunas de hasta 150 m', noteEn: 'Erg Chebbi: dunes up to 150 m high', q: 'Erg Chebbi' },
  { id: 'abusimbel', cc: 'EG', es: 'Abu Simbel', en: 'Abu Simbel', lat: 22.3372, lon: 31.6258, hdg: 270, dist: 2500, above: 150,
    noteEs: 'Desde el lago Nasser hacia los templos de Ramsés II', noteEn: 'From Lake Nasser to the temples of Ramesses II', q: 'Abu Simbel temples' },
  { id: 'lemorne', cc: 'MU', es: 'Mauricio · Le Morne', en: 'Mauritius · Le Morne', lat: -20.4541, lon: 57.3213, hdg: 90, dist: 3000, above: 200,
    noteEs: 'La montaña sobre la laguna y su «cascada submarina»', noteEn: 'The mountain over the lagoon and its “underwater waterfall”', q: 'Le Morne Brabant' },
  { id: 'sheikhzayed', cc: 'AE', es: 'Abu Dabi · Gran Mezquita', en: 'Abu Dhabi · Grand Mosque', lat: 24.4128, lon: 54.475, hdg: 0, dist: 2500, above: 200,
    noteEs: 'Las 82 cúpulas blancas de la mezquita Sheikh Zayed', noteEn: 'The 82 white domes of the Sheikh Zayed Mosque', q: 'Sheikh Zayed Grand Mosque', roofs: true },
  { id: 'palmjumeirah', cc: 'AE', es: 'Dubái · Palm Jumeirah', en: 'Dubai · Palm Jumeirah', lat: 25.1173, lon: 55.1351, hdg: 160, dist: 4000, above: 300,
    noteEs: 'La isla con forma de palmera y el hotel Atlantis', noteEn: 'The palm-shaped island and the Atlantis hotel', q: 'Palm Jumeirah', roofs: true },
  { id: 'wadirum', cc: 'JO', es: 'Wadi Rum', en: 'Wadi Rum', lat: 29.573, lon: 35.42, hdg: 180, dist: 3000, above: 250,
    noteEs: 'El desierto rojo entre montañas de arenisca', noteEn: 'The red desert between sandstone mountains', q: 'Wadi Rum' },
  { id: 'tokio', cc: 'JP', es: 'Tokio · Torre de Tokio', en: 'Tokyo · Tokyo Tower', lat: 35.6586, lon: 139.7454, hdg: 0, dist: 3000, above: 200,
    noteEs: 'Desde la bahía hacia la torre roja y blanca', noteEn: 'From the bay to the red and white tower', q: 'Tokyo Tower', roofs: true },
  { id: 'ciudadprohibida', cc: 'CN', es: 'Pekín · Ciudad Prohibida', en: 'Beijing · Forbidden City', lat: 39.9165, lon: 116.3908, hdg: 0, dist: 2500, above: 200,
    noteEs: 'Desde Tiananmén sobre los tejados de los palacios', noteEn: 'From Tiananmen over the palace roofs', q: 'Forbidden City', roofs: true },
  { id: 'shanghai', cc: 'CN', es: 'Shanghái · el Bund y Pudong', en: 'Shanghai · the Bund and Pudong', lat: 31.2419, lon: 121.4953, hdg: 90, dist: 3000, above: 250,
    noteEs: 'Por el río Huangpu hacia los rascacielos de Pudong', noteEn: 'Along the Huangpu to the Pudong skyscrapers', q: 'Oriental Pearl Tower', roofs: true },
  { id: 'petronas', cc: 'MY', es: 'Kuala Lumpur · Torres Petronas', en: 'Kuala Lumpur · Petronas Towers', lat: 3.1579, lon: 101.7116, hdg: 0, dist: 3000, above: 300,
    noteEs: 'Las torres gemelas de 452 m', noteEn: 'The 452 m twin towers', q: 'Petronas Twin Towers', roofs: true },
  { id: 'tanahlot', cc: 'ID', es: 'Bali · templo de Tanah Lot', en: 'Bali · Tanah Lot temple', lat: -8.6212, lon: 115.0868, hdg: 45, dist: 2500, above: 150,
    noteEs: 'El templo sobre la roca en el mar', noteEn: 'The temple on its rock in the sea', q: 'Pura Tanah Lot' },
  { id: 'mayabay', cc: 'TH', es: 'Phi Phi · Maya Bay', en: 'Phi Phi · Maya Bay', lat: 7.6781, lon: 98.7653, hdg: 0, dist: 2500, above: 200,
    noteEs: 'La bahía entre acantilados de «La Playa»', noteEn: 'The cliff-ringed bay from “The Beach”', q: 'Maya Bay, Krabi' },
  { id: 'granpalacio', cc: 'TH', es: 'Bangkok · Gran Palacio', en: 'Bangkok · Grand Palace', lat: 13.75, lon: 100.4913, hdg: 90, dist: 2500, above: 200,
    noteEs: 'Desde el río Chao Phraya hacia los tejados dorados', noteEn: 'From the Chao Phraya to the golden roofs', q: 'Grand Palace, Bangkok', roofs: true },
  { id: 'maldivas', cc: 'MV', es: 'Maldivas · atolón de Malé', en: 'Maldives · Malé Atoll', lat: 4.1755, lon: 73.5093, hdg: 0, dist: 4000, above: 250,
    noteEs: 'Atolones e islas de arena en el Índico', noteEn: 'Atolls and sand islands in the Indian Ocean', q: 'Malé, Maldives' },
  { id: 'whitehaven', cc: 'AU', es: 'Whitsundays · Hill Inlet', en: 'Whitsundays · Hill Inlet', lat: -20.2605, lon: 149.0208, hdg: 180, dist: 3000, above: 200,
    noteEs: 'Arena blanca y remolinos turquesa junto a la Gran Barrera', noteEn: 'White sand and turquoise swirls by the Great Barrier Reef', q: 'Hill Inlet' },
  { id: 'queenstown', cc: 'NZ', es: 'Queenstown y los Remarkables', en: 'Queenstown and the Remarkables', lat: -45.0312, lon: 168.6626, hdg: 70, dist: 4000, above: 300, search: 45,
    noteEs: 'Sobre el lago Wakatipu hacia la ciudad y las montañas', noteEn: 'Over Lake Wakatipu to the town and the mountains', q: 'Queenstown, New Zealand' },
  { id: 'waikiki', cc: 'US', es: 'Honolulu · Waikiki y Diamond Head', en: 'Honolulu · Waikiki and Diamond Head', lat: 21.2598, lon: -157.8117, hdg: 110, dist: 4000, above: 250,
    noteEs: 'Hawái · a lo largo de la playa de Waikiki hacia el cráter', noteEn: 'Hawaii · along Waikiki beach to the crater', q: 'Diamond Head' },
  { id: 'lasvegas', cc: 'US', es: 'Las Vegas · el Strip', en: 'Las Vegas · the Strip', lat: 36.1126, lon: -115.1767, hdg: 0, dist: 4000, above: 300,
    noteEs: 'Los casinos de la avenida, de sur a norte', noteEn: 'The casinos along the Strip, south to north', q: 'Bellagio, Las Vegas', roofs: true },
  { id: 'chicago', cc: 'US', es: 'Chicago · rascacielos y lago Míchigan', en: 'Chicago · skyline and Lake Michigan', lat: 41.8789, lon: -87.6359, hdg: 270, dist: 4000, above: 300,
    noteEs: 'Desde el lago hacia la Willis Tower', noteEn: 'From the lake to the Willis Tower', q: 'Willis Tower', roofs: true },
  { id: 'miami', cc: 'US', es: 'Miami Beach', en: 'Miami Beach', lat: 25.781, lon: -80.13, hdg: 270, dist: 3000, above: 200,
    noteEs: 'Playas y hoteles art déco con la bahía detrás', noteEn: 'Beaches and Art Deco hotels with the bay behind', q: 'South Beach, Miami Beach', roofs: true },
  { id: 'toronto', cc: 'CA', es: 'Toronto · CN Tower', en: 'Toronto · CN Tower', lat: 43.6426, lon: -79.3871, hdg: 0, dist: 3500, above: 300,
    noteEs: 'Desde el lago Ontario hacia la torre de 553 m', noteEn: 'From Lake Ontario to the 553 m tower', q: 'CN Tower', roofs: true },
  { id: 'habana', cc: 'CU', es: 'La Habana · el Malecón', en: 'Havana · the Malecón', lat: 23.142, lon: -82.37, hdg: 180, dist: 3000, above: 200,
    noteEs: 'Desde el mar: el castillo del Morro y el Malecón', noteEn: 'From the sea: El Morro castle and the Malecón', q: 'Malecón, La Habana', roofs: true },
  { id: 'cartagena', cc: 'CO', es: 'Cartagena de Indias', en: 'Cartagena de Indias', lat: 10.4236, lon: -75.551, hdg: 60, dist: 3000, above: 200,
    noteEs: 'La ciudad amurallada junto al Caribe', noteEn: 'The walled city by the Caribbean', q: 'Ciudad Amurallada, Cartagena', roofs: true },
]

// ---------------------------------------------------------------------------
// Órdenes
// ---------------------------------------------------------------------------

const UA = { 'User-Agent': 'autogiro-world-sites-tool' }
const DEG = Math.PI / 180
const dist = (a: number, b: number, c: number, d: number) =>
  Math.hypot((d - b) * 111320 * Math.cos(((a + c) / 2) * DEG), (c - a) * 110574)

async function check(): Promise<void> {
  const only = process.argv.slice(3)
  for (const s of SITES) {
    if (only.length && !only.includes(s.id)) continue
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(s.q)}`, { headers: UA })
    const j = (await r.json()) as Array<{ lat: string; lon: string; display_name: string }>
    const p = j[0]
    const d = p ? dist(s.lat, s.lon, Number(p.lat), Number(p.lon)) : NaN
    const flag = !p ? '¿?' : d > 1500 ? '!!' : d > 400 ? ' !' : '  '
    console.log(`${flag} ${s.id.padEnd(15)} ${Number.isFinite(d) ? `${Math.round(d)} m`.padStart(8) : '   —    '}  ${p ? `${Number(p.lat).toFixed(4)}, ${Number(p.lon).toFixed(4)}  ${p.display_name.slice(0, 70)}` : ''}`)
    await new Promise((res) => setTimeout(res, 1100))
  }
}

async function spawns(): Promise<void> {
  const { execFileSync } = await import('node:child_process')
  const only = process.argv.slice(3)
  for (const s of SITES) {
    if (only.length && !only.includes(s.id)) continue
    // en valles y fiordos se prueban rumbos cercanos y se queda el que va más bajo (por el fondo)
    let best: { out: string; msl: number; hdg: number } | null = null
    const span = s.search ?? 0
    for (let h = s.hdg - span; h <= s.hdg + span; h += 5) {
      const hdg = ((h % 360) + 360) % 360
      const out = execFileSync(
        process.execPath,
        ['--experimental-strip-types', 'tools/landmark-info.ts', String(s.lat), String(s.lon), String(hdg), String(s.dist), String(s.above)],
        { encoding: 'utf8' },
      )
      const msl = Number(/→ (-?\d+) m de altitud/.exec(out)?.[1] ?? Infinity)
      const better = !best || msl < best.msl - 20 || (msl < best.msl + 20 && Math.abs(h - s.hdg) < Math.abs(best.hdg - s.hdg))
      if (better) best = { out, msl, hdg: h }
    }
    const lines = best!.out.trim().split('\n')
    console.error(`${s.id.padEnd(15)} ${lines[0]} → ${best!.msl} m de altitud, rumbo ${best!.hdg}`)
    // entrada para LOCATIONS (src/config.ts) y textos en inglés (i18n.ts)
    const v = lines[lines.length - 1]
    cfg.push(`  { id: ${q(s.id)}, name: ${q(s.es)}, ${v}, country: ${q(s.cc)},\n    note: ${q(s.noteEs)} },`)
    en.push(`  'loc.${s.id}': ${q(s.en)},`, `  'loc.${s.id}.note': ${q(s.noteEn)},`)
  }
  console.log(`// src/config.ts (LOCATIONS)\n${cfg.join('\n')}\n\n// src/i18n.ts (en)\n${en.join('\n')}`)
}

const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
const cfg: string[] = []
const en: string[] = []

const cmd = process.argv[2]
if (cmd === 'check') await check()
else if (cmd === 'spawns') await spawns()
else if (cmd === 'roofs') {
  const only = process.argv.slice(3)
  await (await import('./world-roofs.ts')).worldRoofs(SITES.filter((s) => s.roofs && (!only.length || only.includes(s.id))))
}
else console.error('uso: world-sites.ts check | spawns | roofs')
