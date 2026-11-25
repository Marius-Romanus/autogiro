# Seguridad

**Español** · [English](#security-policy)

## Versiones con soporte

Solo la **última versión**. El juego se actualiza solo al abrirlo, así que los arreglos de seguridad
salen en una versión nueva y no se aplican a las anteriores.

## Cómo avisar de un fallo de seguridad

**No abras un issue público.** Avísalo en privado desde
[Security → Report a vulnerability](https://github.com/Marius-Romanus/autogiro/security/advisories/new).
Solo lo vemos tú y yo hasta que esté arreglado.

Cuenta qué has encontrado, cómo se reproduce, en qué versión y sistema, y qué podría hacer alguien
que lo aprovechara. Es un proyecto personal y no hay plazos fijos, pero los avisos de seguridad van
por delante de todo lo demás. Cuando esté arreglado saldrá en las novedades de la versión, con tu
nombre si quieres.

## Qué cuenta como fallo de seguridad

- Una forma de que el **actualizador automático** instale algo que no sea una versión oficial.
  Las actualizaciones van firmadas y el juego rechaza las que no llevan la firma.
- Una forma de **ejecutar código** o de leer o escribir archivos en el ordenador de un jugador, por
  ejemplo desde una sala o el chat del **multijugador**.
- Que la **clave de Google** que guardas en el juego pueda llegar a alguien que no sea Google.
- Un instalador, AppImage, .deb o .rpm de la página de versiones que no sea el que se publicó.

## Qué no

- Fallos del juego sin riesgo para nadie (se cae, algo se ve mal, la física no cuadra): para eso está
  la [plantilla de error](https://github.com/Marius-Romanus/autogiro/issues/new/choose).
- Problemas de los servicios de los que tira el juego (Google, OpenStreetMap, IGN/PNOA, Esri…):
  avisa a quien lo mantiene.
- Copias del juego descargadas de otro sitio. Descárgalo solo de
  [la página de versiones](https://github.com/Marius-Romanus/autogiro/releases).

---

# Security policy

**Supported versions:** only the latest release. The game updates itself on launch.

**Reporting:** please don't open a public issue. Report it privately through
[Security → Report a vulnerability](https://github.com/Marius-Romanus/autogiro/security/advisories/new),
with what you found, how to reproduce it, the version and OS, and the possible impact.
This is a personal project with no fixed response times, but security reports come first.

**In scope:** the auto-updater (updates are signed and unsigned ones are rejected), code execution or
file access on a player's computer (e.g. through multiplayer rooms or chat), leaking the Google API key
stored in the game, and tampered installers on the releases page.

**Out of scope:** regular bugs with no security impact (use the bug report template), issues in
third-party services the game uses, and copies downloaded from anywhere other than the releases page.
