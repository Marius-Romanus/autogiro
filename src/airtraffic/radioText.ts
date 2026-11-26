// Lo que dice por radio cada piloto del tráfico: autoinformación de aeródromo sin control, como se
// oye en la frecuencia de un campo español («Casarrubios, EC-GK9, viento en cola izquierda pista
// 26 para toma y despegue»), y su equivalente en inglés.

import { addStrings, t } from '../i18n.ts'
import type { RadioMsg } from './sim.ts'

addStrings('es', {
  'atc.title': 'Radio',
  'atc.field': 'Tráfico',
  'atc.L': 'izquierda',
  'atc.R': 'derecha',
  'atc.taxi': '{field}, {cs}, en plataforma, rodando al punto de espera de la pista {rwy}',
  'atc.holding': '{field}, {cs}, en punto de espera de la pista {rwy}, mantengo',
  'atc.lineUp': '{field}, {cs}, entrando y alineando pista {rwy}',
  'atc.takeoff': '{field}, {cs}, despegando pista {rwy}, para circuitos',
  'atc.takeoffLeaving': '{field}, {cs}, despegando pista {rwy}, abandono la zona',
  'atc.downwindTG': '{field}, {cs}, viento en cola {side} pista {rwy}, para toma y despegue',
  'atc.downwindFull': '{field}, {cs}, viento en cola {side} pista {rwy}, para toma final',
  'atc.final': '{field}, {cs}, en final pista {rwy}',
  'atc.goAroundBusy': '{field}, {cs}, pista ocupada, frustrando',
  'atc.goAround': '{field}, {cs}, frustrando',
  'atc.vacated': '{field}, {cs}, pista {rwy} libre',
  'atc.inbound': '{field}, {cs}, autogiro a {nm} millas, para incorporarme a viento en cola {side} de la pista {rwy}',
})
addStrings('en', {
  'atc.title': 'Radio',
  'atc.field': 'Traffic',
  'atc.L': 'left',
  'atc.R': 'right',
  'atc.taxi': '{field} traffic, {cs}, on the apron, taxiing to holding point runway {rwy}',
  'atc.holding': '{field} traffic, {cs}, holding short runway {rwy}',
  'atc.lineUp': '{field} traffic, {cs}, lining up runway {rwy}',
  'atc.takeoff': '{field} traffic, {cs}, taking off runway {rwy}, remaining in the circuit',
  'atc.takeoffLeaving': '{field} traffic, {cs}, taking off runway {rwy}, leaving the area',
  'atc.downwindTG': '{field} traffic, {cs}, {side} downwind runway {rwy}, touch and go',
  'atc.downwindFull': '{field} traffic, {cs}, {side} downwind runway {rwy}, full stop',
  'atc.final': '{field} traffic, {cs}, final runway {rwy}',
  'atc.goAroundBusy': '{field} traffic, {cs}, runway occupied, going around',
  'atc.goAround': '{field} traffic, {cs}, going around',
  'atc.vacated': '{field} traffic, {cs}, runway {rwy} vacated',
  'atc.inbound': '{field} traffic, {cs}, gyroplane {nm} miles out, joining {side} downwind runway {rwy}',
})

/** Texto de un mensaje de radio en el idioma del juego. */
export function radioText(m: RadioMsg): string {
  const field = String(m.vars.field || '') || t('atc.field')
  const side = m.vars.side ? t(`atc.${m.vars.side}`) : ''
  return t(`atc.${m.key}`, { ...m.vars, field, side, cs: m.callsign })
}
