// Hielo en el carburador: probabilidad según la temperatura y el punto de rocío del aire.
//
// Bandas del gráfico de la hoja de seguridad 14 de la CAA británica («Piston engine icing», y la
// GA5 de la EGAST): con aire húmedo el hielo se forma hasta con 25-30 °C, porque la gasolina al
// evaporarse y la caída de presión en el venturi enfrían el aire hasta 30-35 °C. Las fronteras del
// gráfico no vienen en texto: aquí van aproximadas por humedad relativa y temperatura.
//   4: hielo grave a cualquier potencia      (HR ≥ 80 %, −8…25 °C)
//   3: moderado en crucero, grave en descenso (HR ≥ 55 %, −10…30 °C)
//   2: grave en descenso, leve en crucero     (HR ≥ 35 %, hasta 35 °C)
//   1: leve                                   (HR ≥ 25 %, −15…38 °C)
// Con el gas reducido (descenso, planeo) es peor: la mariposa casi cerrada enfría más.

/** Temperatura ISA (°C) a la altitud `h` (m). */
export function isaTempC(h: number): number {
  return 15 - 0.0065 * Math.max(-500, Math.min(11000, h))
}

/** Humedad relativa (0..1) con la fórmula de Magnus. */
export function relHumidity(oatC: number, dewC: number): number {
  const es = (t: number) => Math.exp((17.625 * t) / (243.04 + t))
  return Math.min(1, es(Math.min(dewC, oatC)) / es(oatC))
}

/** Banda del gráfico de hielo en el carburador (0: ninguna … 4: grave a cualquier potencia). */
export function icingBand(oatC: number, dewC: number): 0 | 1 | 2 | 3 | 4 {
  const rh = relHumidity(oatC, dewC)
  if (oatC < -15 || oatC > 38 || rh < 0.25) return 0
  if (rh >= 0.8 && oatC >= -8 && oatC <= 25) return 4
  if (rh >= 0.55 && oatC >= -10 && oatC <= 30) return 3
  if (rh >= 0.35 && oatC <= 35) return 2
  return 1
}

/**
 * Hielo que se forma (fracción de la toma por minuto) en cada banda, [gas reducido, crucero], para
 * un Rotax 912 (cada motor lo multiplica por su `iceRisk`): en la banda grave, a crucero, unos
 * 20-25 min hasta notar mucho; en descenso a ralentí, pocos minutos.
 */
export const ICE_RATES: Record<number, [number, number]> = {
  0: [0, 0],
  1: [1 / 60, 1 / 300],
  2: [1 / 15, 1 / 200],
  3: [1 / 12, 1 / 60],
  4: [1 / 8, 1 / 25],
}
