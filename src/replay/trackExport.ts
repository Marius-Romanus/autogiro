// Traza del vuelo grabado (FlightRecorder) en GPX 1.1 (hora, altitud y velocidad) y en KML (línea
// extruida hasta el suelo, para Google Earth), y su descarga.
//
// Alturas: sobre el nivel del mar. En el modo sin clave el mundo ya va en altitudes del MDT (IGN o
// Terrarium: nivel del mar), así que la altura «elipsoidal» que sale del ECEF es la altitud; con las
// teselas de Google el mundo es elipsoidal y se resta el geoide del sitio (`datumShift`, lo mismo que
// el altímetro y el multijugador). Como el altímetro, se da la de las ruedas: CG − 1,05 m, que en
// tierra es la del campo.

import { Vector3 } from 'three'
import { Ellipsoid, Geodetic } from '@takram/three-geospatial'
import { C, D, type FlightRecorder, type RecEvent } from './FlightRecorder.ts'

const DEG = 180 / Math.PI
/** de la altura del CG a la de las ruedas (como el altímetro, main.ts) */
const WHEELS = 1.05

export interface TrackPoint {
  /** s de grabación */
  t: number
  time: Date
  lat: number
  lon: number
  /** altitud (m sobre el nivel del mar) */
  ele: number
  /** velocidad respecto al suelo (m/s) y rumbo de la trayectoria (°) */
  speed: number
  course: number
}

export interface TrackInfo {
  /** nombre del vuelo (lugar, aparato) */
  name: string
  desc: string
  /** nombre de cada suceso en el idioma de la interfaz */
  eventName: (e: RecEvent) => string
  eventDesc: (e: RecEvent) => string
}

const _p = new Vector3()
const _v = new Vector3()
const _e = new Vector3()
const _n = new Vector3()
const _u = new Vector3()
const _g = new Geodetic()

/** Punto de la traza en la muestra `i` de la grabación (fecha: la del principio + el tiempo transcurrido). */
function pointAt(rec: FlightRecorder, i: number, simStart: number, tStart: number): TrackPoint {
  const [d, o] = rec.drow(i)
  const [f, fo] = rec.row(i)
  _p.set(d[o + D.px], d[o + D.py], d[o + D.pz])
  _g.setFromECEF(_p)
  Ellipsoid.WGS84.getEastNorthUpVectors(_p, _e, _n, _u)
  _v.set(f[fo + C.vx], f[fo + C.vy], f[fo + C.vz])
  const ve = _v.dot(_e)
  const vn = _v.dot(_n)
  const t = d[o + D.t]
  return {
    t,
    time: new Date(simStart + (t - tStart) * 1000),
    lat: _g.latitude * DEG,
    lon: _g.longitude * DEG,
    ele: _g.height - rec.datumShift - WHEELS,
    speed: Math.hypot(ve, vn),
    course: (((Math.atan2(ve, vn) * DEG) % 360) + 360) % 360,
  }
}

/** Traza cada `step` s (como un registrador GPS: 1 s), más el último punto. */
export function trackPoints(rec: FlightRecorder, step = 1): TrackPoint[] {
  const out: TrackPoint[] = []
  if (rec.count < 2) return out
  const [d0, o0] = rec.drow(rec.start)
  const tStart = d0[o0 + D.t]
  const simStart = d0[o0 + D.sim]
  let next = tStart
  for (let i = rec.start; i < rec.end; i++) {
    const t = rec.time(i)
    if (t + 1e-6 < next && i !== rec.end - 1) continue
    out.push(pointAt(rec, i, simStart, tStart))
    next = t + step
  }
  return out
}

/** Punto de la traza en el instante de un suceso. */
export function eventPoint(rec: FlightRecorder, e: RecEvent): TrackPoint {
  const [d0, o0] = rec.drow(rec.start)
  return pointAt(rec, rec.find(e.t), d0[o0 + D.sim], d0[o0 + D.t])
}

const esc = (s: string): string => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!)
/** hora UTC sin milésimas */
const iso = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z')
const f7 = (v: number): string => v.toFixed(7)

export function buildGpx(rec: FlightRecorder, info: TrackInfo): string {
  const pts = trackPoints(rec)
  const L: string[] = []
  L.push('<?xml version="1.0" encoding="UTF-8"?>')
  L.push(
    '<gpx version="1.1" creator="Autogiro (simulador de autogiro)" xmlns="http://www.topografix.com/GPX/1/1"' +
      ' xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v2"' +
      ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"' +
      ' xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd' +
      ' http://www.garmin.com/xmlschemas/TrackPointExtension/v2 https://www8.garmin.com/xmlschemas/TrackPointExtensionv2.xsd">',
  )
  L.push(`  <metadata><name>${esc(info.name)}</name><desc>${esc(info.desc)}</desc>${pts.length ? `<time>${iso(pts[0].time)}</time>` : ''}</metadata>`)
  for (const e of rec.events) {
    const p = eventPoint(rec, e)
    L.push(
      `  <wpt lat="${f7(p.lat)}" lon="${f7(p.lon)}"><ele>${p.ele.toFixed(1)}</ele><time>${iso(p.time)}</time>` +
        `<name>${esc(info.eventName(e))}</name><desc>${esc(info.eventDesc(e))}</desc><type>${e.kind}</type></wpt>`,
    )
  }
  L.push(`  <trk><name>${esc(info.name)}</name><type>autogiro</type><trkseg>`)
  for (const p of pts)
    L.push(
      `    <trkpt lat="${f7(p.lat)}" lon="${f7(p.lon)}"><ele>${p.ele.toFixed(1)}</ele><time>${iso(p.time)}</time>` +
        `<extensions><gpxtpx:TrackPointExtension><gpxtpx:speed>${p.speed.toFixed(2)}</gpxtpx:speed>` +
        `<gpxtpx:course>${p.course.toFixed(1)}</gpxtpx:course></gpxtpx:TrackPointExtension></extensions></trkpt>`,
    )
  L.push('  </trkseg></trk>')
  L.push('</gpx>')
  return L.join('\n') + '\n'
}

export function buildKml(rec: FlightRecorder, info: TrackInfo, labels: { track: string; timed: string; events: string }): string {
  const pts = trackPoints(rec)
  const coord = (p: TrackPoint) => `${f7(p.lon)},${f7(p.lat)},${p.ele.toFixed(1)}`
  const L: string[] = []
  L.push('<?xml version="1.0" encoding="UTF-8"?>')
  L.push('<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">')
  L.push('<Document>')
  L.push(`  <name>${esc(info.name)}</name>`)
  L.push(`  <description>${esc(info.desc)}</description>`)
  // amarillo de cartel (#f6c400; KML va en aabbggrr) y la cortina hasta el suelo, translúcida
  L.push('  <Style id="traza"><LineStyle><color>ff00c4f6</color><width>3</width></LineStyle><PolyStyle><color>5900c4f6</color><outline>0</outline></PolyStyle></Style>')
  L.push('  <Style id="hora"><IconStyle><scale>0.8</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/airports.png</href></Icon></IconStyle><LineStyle><color>ff00c4f6</color><width>3</width></LineStyle></Style>')
  L.push('  <Style id="suceso"><IconStyle><color>ff00c4f6</color><Icon><href>http://maps.google.com/mapfiles/kml/paddle/wht-blank.png</href></Icon></IconStyle></Style>')
  L.push('  <Style id="accidente"><IconStyle><color>ff2b26d8</color><Icon><href>http://maps.google.com/mapfiles/kml/paddle/wht-blank.png</href></Icon></IconStyle></Style>')
  L.push(`  <Placemark><name>${esc(labels.track)}</name><styleUrl>#traza</styleUrl>`)
  L.push('    <LineString><extrude>1</extrude><tessellate>0</tessellate><altitudeMode>absolute</altitudeMode><coordinates>')
  for (let i = 0; i < pts.length; i += 4) L.push('      ' + pts.slice(i, i + 4).map(coord).join(' '))
  L.push('    </coordinates></LineString>')
  L.push('  </Placemark>')
  // la misma traza con hora (la barra de tiempo de Google Earth la recorre); oculta al abrir
  L.push(`  <Placemark><name>${esc(labels.timed)}</name><visibility>0</visibility><styleUrl>#hora</styleUrl>`)
  L.push('    <gx:Track><altitudeMode>absolute</altitudeMode>')
  for (const p of pts) L.push(`      <when>${iso(p.time)}</when>`)
  for (const p of pts) L.push(`      <gx:coord>${f7(p.lon)} ${f7(p.lat)} ${p.ele.toFixed(1)}</gx:coord>`)
  L.push('    </gx:Track>')
  L.push('  </Placemark>')
  if (rec.events.length) {
    L.push(`  <Folder><name>${esc(labels.events)}</name>`)
    for (const e of rec.events) {
      const p = eventPoint(rec, e)
      L.push(
        `    <Placemark><name>${esc(info.eventName(e))}</name><description>${esc(info.eventDesc(e))}</description>` +
          `<TimeStamp><when>${iso(p.time)}</when></TimeStamp><styleUrl>#${e.kind === 'crash' ? 'accidente' : 'suceso'}</styleUrl>` +
          `<Point><altitudeMode>absolute</altitudeMode><coordinates>${coord(p)}</coordinates></Point></Placemark>`,
      )
    }
    L.push('  </Folder>')
  }
  L.push('</Document>')
  L.push('</kml>')
  return L.join('\n') + '\n'
}

/**
 * Descarga un archivo de texto. En el navegador y en la app de escritorio (WebView2 descarga solo los
 * enlaces `download` a la carpeta de descargas: en src-tauri/src/main.rs `blob:` cuenta como del juego).
 */
export function saveTextFile(name: string, mime: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // (el enlace tiene que seguir vivo hasta que empiece la descarga)
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}
