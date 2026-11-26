// Configuración de npm-check-updates (ncu).
module.exports = {
  // straight-skeleton se queda en la 1.x (TypeScript puro, MIT): la 2.x/3.x envuelve CGAL en
  // WebAssembly, y CGAL es GPL, incompatible con la licencia del juego. Además es 7–17 veces
  // más lenta por planta y pesa 1 MB.
  reject: ['straight-skeleton'],
}
