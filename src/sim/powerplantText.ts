// Textos del combustible y de los fallos del motor (sim/powerplant.ts, la guía, el HUD y el menú).
// Van aquí, con addStrings, para no engordar i18n.ts.

import { addStrings } from '../i18n.ts'

addStrings('es', {
  // avisos que salen al pasar algo
  'pp.drillStart': 'Simulacro: el instructor te ha quitado el gas. Planea y busca campo (F2 termina el ejercicio)',
  'pp.drillEnd': 'Fin del simulacro: el gas vuelve a ser tuyo',
  'pp.drillLanded': 'Simulacro terminado en tierra',
  'pp.drillAir': 'El simulacro de fallo de motor se hace en vuelo, con el motor en marcha',
  'pp.already': 'Ya tienes un fallo de motor',
  'pp.stop': '¡Fallo de motor! Se ha parado',
  'pp.seize': '¡Gripaje! El motor se ha parado de golpe',
  'pp.partial': 'El motor pierde potencia',
  'pp.rough': 'El motor falla y va a tirones',
  'pp.oil': 'Presión de aceite baja: reduce potencia y toma tierra cuanto antes',
  'pp.oilSeize': 'El motor se ha gripado por falta de aceite',
  'pp.iceStop': 'El motor se ha parado: hielo en el carburador',
  'pp.fuelOut': 'Sin combustible: el motor se ha parado',
  'pp.reserve': 'Reserva de combustible: {l} l, unos {min} min de vuelo',
  'pp.noStart.fuel': 'El motor no arranca: no queda combustible',
  'pp.noStart.seized': 'El motor no gira: está gripado',
  'pp.noStart.failed': 'El motor no arranca',
  'pp.noStart.ice': 'El motor no arranca: el carburador sigue helado (espera a que se funda)',
  // HUD: avisos (rojo) y precauciones (ámbar)
  'pp.w.oil': 'PRESIÓN DE ACEITE',
  'pp.w.engine': 'FALLO DE MOTOR',
  'pp.c.drill': 'SIMULACRO · GAS A RALENTÍ',
  'pp.c.fuel': 'RESERVA DE COMBUSTIBLE',
  'pp.c.fuelOut': 'SIN COMBUSTIBLE',
  'pp.c.power': 'PÉRDIDA DE POTENCIA',
  'hud.fuel': 'COMB',
  'hud.tagFuel': 'RESERVA',
  'hud.tagOil': 'ACEITE',
  'hud.tagDrill': 'SIMULACRO',
  'ck.fuelLow': 'COMB',
  'ck.oil': 'ACEITE',
  // menú
  'menu.fuelT': 'Combustible al salir',
  'menu.fuelD': '{l} l de {cap} · {kg} kg · unas {h} de vuelo',
  'menu.fuelOver': '{l} l de {cap} · al despegue {mass} kg: {over} kg por encima del máximo ({mtow} kg)',
  'menu.fuelNone': 'Impulsor de ficción: no gasta combustible',
  'menu.failT': 'Fallos de motor',
  'menu.fail.none': 'Ninguno',
  'menu.fail.drill': 'Simulacro',
  'menu.fail.real': 'Reales',
  'menu.failD.none': 'Con <kbd>F2</kbd>, un simulacro cuando quieras: el instructor te quita el gas',
  'menu.failD.drill': 'El instructor te quita el gas a ralentí y lo sujeta: el motor sigue en marcha. <kbd>F2</kbd> lo empieza o lo termina',
  'menu.failD.real': 'Paradas, pérdidas de potencia, presión de aceite y hielo en el carburador, según el motor y el aire del día. <kbd>F2</kbd> provoca uno',
  'menu.failRandomT': 'Cuando menos te lo esperes',
  'menu.failRandomD': 'Llegan solos en algún momento del vuelo',
  'plan.fuel': '{l} l de combustible',
  'plan.fail.drill': 'simulacros',
  'plan.fail.real': 'fallos reales',
  'plan.failRandom': 'al azar',
  // guía: emergencia (sim/powerplant.ts → hud/Guide.ts)
  'guide.em.drill.title': 'Simulacro de fallo de motor',
  'guide.em.out.title': 'Fallo de motor',
  'guide.em.power.title': 'Pérdida de potencia',
  'guide.em.oil.title': 'Presión de aceite baja',
  'guide.em.fuel.title': 'Reserva de combustible',
  'guide.em.glide': `
        <li><b>Palanca para {best} km/h</b>, la velocidad de mejor planeo: con ella llegas más lejos (unos {km} km por cada 300 m de altura). Sin tirones: nunca empujes de golpe.</li>
        <li><b>Elige campo cara al viento</b>, sin cables ni obstáculos y al alcance del planeo. Un autogiro toma en muy poco: bastan unas decenas de metros.</li>`,
  'guide.em.restart': `
        <li>Con altura de sobra (más de 300 m): comprueba combustible y llave e intenta arrancar (<kbd>M</kbd>). Si no arranca, olvídate del motor y vuela el avión.</li>`,
  'guide.em.turns': `
        <li><b>Virajes suaves y nunca lentos</b>: a poca velocidad el descenso se dispara y el rotor pierde vueltas. Para perder altura de más, palanca atrás (hasta {minsink} km/h, el mínimo descenso), y vuelve a {best} km/h antes de los 50 m.</li>
        <li>Final cara al viento a {best} km/h. <b>Recogida a unos {flare} m ({flareFt} ft)</b>: tira de la palanca (<kbd>S</kbd>) y mantenla hasta posarte.</li>`,
  'guide.em.drillEnd': `
        <li>Si el campo no vale o no es una pista: a unos 60 m (200 ft) del suelo, <kbd>F2</kbd> (fin del simulacro), gas a fondo (<kbd>0</kbd>) y <b>motor y al aire</b> a {best} km/h.</li>
        <li>O toma tierra: el ejercicio termina al posarte.</li>`,
  'guide.em.power': `
        <li><b>No te fíes del motor</b>: puede pararse del todo. Ten siempre un campo al alcance del planeo y vuela hacia el más cercano o al aeródromo.</li>
        <li>Mantén altura si puedes con el gas que tenga; si no sube, planea a {best} km/h.</li>
        <li>Con aire húmedo y gas reducido, puede ser <b>hielo en el carburador</b>: estos motores no llevan calefacción del carburador y el hielo no se va solo; toma tierra.</li>
        <li><b>Toma de precaución</b> cara al viento; recogida a unos {flare} m ({flareFt} ft).</li>`,
  'guide.em.oil': `
        <li><b>Reduce potencia</b> a la mínima que te mantenga en el aire: con poco aceite, cuanto más gas, antes se gripa.</li>
        <li>Ve al campo o aeródromo más cercano y <b>toma tierra cuanto antes</b>.</li>
        <li>Prepárate para que se pare: elige campo cara al viento, {best} km/h de mejor planeo, recogida a unos {flare} m.</li>`,
  'guide.em.fuel': `
        <li>Te quedan unos <b>{min} min</b> de vuelo. Ve a tomar tierra ya: al aeródromo si llegas de sobra o a un campo.</li>
        <li>Nada de maniobras bruscas ni derrapes: con el depósito casi vacío la toma puede quedarse al descubierto y el motor fallar a tirones.</li>
        <li>Si se para: {best} km/h de mejor planeo, campo cara al viento, recogida a unos {flare} m.</li>`,
})

addStrings('en', {
  'pp.drillStart': 'Practice engine failure: the instructor has closed the throttle. Glide and pick a field (F2 ends the exercise)',
  'pp.drillEnd': 'End of the exercise: the throttle is yours again',
  'pp.drillLanded': 'Practice engine failure ended on the ground',
  'pp.drillAir': 'A practice engine failure is flown in the air, with the engine running',
  'pp.already': 'You already have an engine failure',
  'pp.stop': 'Engine failure! It has stopped',
  'pp.seize': 'Seizure! The engine has stopped dead',
  'pp.partial': 'The engine is losing power',
  'pp.rough': 'The engine is running rough',
  'pp.oil': 'Low oil pressure: reduce power and land as soon as possible',
  'pp.oilSeize': 'The engine has seized for lack of oil',
  'pp.iceStop': 'The engine has stopped: carburettor ice',
  'pp.fuelOut': 'Out of fuel: the engine has stopped',
  'pp.reserve': 'Fuel reserve: {l} l, about {min} min of flight',
  'pp.noStart.fuel': 'The engine will not start: no fuel left',
  'pp.noStart.seized': 'The engine will not turn: it has seized',
  'pp.noStart.failed': 'The engine will not start',
  'pp.noStart.ice': 'The engine will not start: the carburettor is still iced (wait for it to melt)',
  'pp.w.oil': 'OIL PRESSURE',
  'pp.w.engine': 'ENGINE FAILURE',
  'pp.c.drill': 'PRACTICE · THROTTLE AT IDLE',
  'pp.c.fuel': 'LOW FUEL',
  'pp.c.fuelOut': 'NO FUEL',
  'pp.c.power': 'POWER LOSS',
  'hud.fuel': 'FUEL',
  'hud.tagFuel': 'LOW FUEL',
  'hud.tagOil': 'OIL',
  'hud.tagDrill': 'PRACTICE',
  'ck.fuelLow': 'FUEL',
  'ck.oil': 'OIL',
  'menu.fuelT': 'Fuel on departure',
  'menu.fuelD': '{l} l of {cap} · {kg} kg · about {h} of flight',
  'menu.fuelOver': '{l} l of {cap} · take-off weight {mass} kg: {over} kg over the maximum ({mtow} kg)',
  'menu.fuelNone': 'Fictional thruster: burns no fuel',
  'menu.failT': 'Engine failures',
  'menu.fail.none': 'None',
  'menu.fail.drill': 'Practice',
  'menu.fail.real': 'Real',
  'menu.failD.none': 'With <kbd>F2</kbd>, a practice failure whenever you like: the instructor closes the throttle',
  'menu.failD.drill': 'The instructor closes the throttle to idle and holds it there: the engine keeps running. <kbd>F2</kbd> starts or ends it',
  'menu.failD.real': 'Stoppages, partial power loss, oil pressure and carburettor ice, depending on the engine and the day’s air. <kbd>F2</kbd> causes one',
  'menu.failRandomT': 'When you least expect it',
  'menu.failRandomD': 'They come by themselves at some point in the flight',
  'plan.fuel': '{l} l of fuel',
  'plan.fail.drill': 'practice failures',
  'plan.fail.real': 'real failures',
  'plan.failRandom': 'at random',
  'guide.em.drill.title': 'Practice engine failure',
  'guide.em.out.title': 'Engine failure',
  'guide.em.power.title': 'Power loss',
  'guide.em.oil.title': 'Low oil pressure',
  'guide.em.fuel.title': 'Low fuel',
  'guide.em.glide': `
        <li><b>Stick for {best} km/h</b>, the best-glide speed: it takes you furthest (about {km} km for every 300 m of height). No jerks: never push the stick abruptly.</li>
        <li><b>Pick a field into wind</b>, free of wires and obstacles and within gliding range. A gyroplane lands very short: a few tens of metres are enough.</li>`,
  'guide.em.restart': `
        <li>With plenty of height (over 300 m): check fuel and key and try a restart (<kbd>M</kbd>). If it does not start, forget the engine and fly the aircraft.</li>`,
  'guide.em.turns': `
        <li><b>Gentle turns, never slow</b>: at low speed the sink rate soars and the rotor loses rpm. To lose extra height, stick back (down to {minsink} km/h, minimum sink), and be back at {best} km/h before 50 m.</li>
        <li>Final approach into wind at {best} km/h. <b>Flare at about {flare} m ({flareFt} ft)</b>: pull the stick back (<kbd>S</kbd>) and hold it until you touch down.</li>`,
  'guide.em.drillEnd': `
        <li>If the field is no good or not a runway: at about 60 m (200 ft) above the ground, <kbd>F2</kbd> (end of exercise), full throttle (<kbd>0</kbd>) and <b>go around</b> at {best} km/h.</li>
        <li>Or land: the exercise ends when you touch down.</li>`,
  'guide.em.power': `
        <li><b>Do not trust the engine</b>: it may stop altogether. Always keep a field within gliding range and head for the nearest one or the airfield.</li>
        <li>Hold height with whatever power it gives; if it will not climb, glide at {best} km/h.</li>
        <li>In humid air with reduced power it may be <b>carburettor ice</b>: these engines have no carburettor heat and the ice will not go away by itself; land.</li>
        <li><b>Precautionary landing</b> into wind; flare at about {flare} m ({flareFt} ft).</li>`,
  'guide.em.oil': `
        <li><b>Reduce power</b> to the minimum that keeps you flying: with little oil, the more throttle, the sooner it seizes.</li>
        <li>Head for the nearest field or airfield and <b>land as soon as possible</b>.</li>
        <li>Be ready for it to stop: pick a field into wind, {best} km/h best glide, flare at about {flare} m.</li>`,
  'guide.em.fuel': `
        <li>About <b>{min} min</b> of flight left. Go and land now: at the airfield if you reach it with margin, or in a field.</li>
        <li>No abrupt manoeuvres or sideslips: with the tank nearly empty the pick-up can unport and the engine stutter.</li>
        <li>If it stops: {best} km/h best glide, field into wind, flare at about {flare} m.</li>`,
})
