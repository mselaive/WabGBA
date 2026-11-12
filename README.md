# WabGBA

Emulador de Game Boy Advance en el navegador, de uso personal. Corre sobre
[mGBA](https://mgba.io) compilado a WebAssembly
([@thenick775/mgba-wasm](https://www.npmjs.com/package/@thenick775/mgba-wasm)).

- **Salas.** Cada sala es un grupo aparte: su código de invitación, sus ROMs, su historial,
  sus vidas, sus torneos y su canal de Discord. Quien administra el sitio (la primera cuenta
  que se crea) las crea, está en todas y nombra al líder de cada una; el líder decide las
  reglas y las anulaciones de su sala. Una cuenta puede estar en varias salas.
- **Biblioteca por sala.** Sólo quien administra el sitio sube ROMs, y cada ROM va a una sola
  sala; sus participantes la ven y la descargan a su navegador, sin poder cargar otras. Así
  todos juegan exactamente la misma ROM. El repo no incluye ningún juego.
- **Se guarda como en la consola.** Lo único que cuenta es guardar dentro del juego: no hay
  estados, ni rebobinado, ni forma de cargar una partida vieja. Pensado para un randomlocke.
- **Seguís donde lo dejaste.** Al cerrar la pestaña queda un punto de reanudación en ese
  dispositivo; no se puede elegir ni volver atrás.
- **Cuentas.** Entrás con usuario y contraseña y tu partida viaja sola: se sube al guardar
  dentro del juego y se baja al abrirlo en otro dispositivo. Cada cuenta tiene su propia
  partida, aunque todos usen la misma ROM. Si dos dispositivos cambiaron, pregunta cuál
  conservar.
- **Randomlocke.** El sitio mira el equipo en la memoria del juego cada pocos segundos
  (`src/party.ts`): cuando un Pokémon se queda sin PS anota la baja con una captura del
  momento, contra quién fue, y le descuenta una vida al entrenador. Las vidas las define la
  cuenta administradora en ⚙ Ajustes, que también puede anular una baja mal detectada.
- **Historial y avisos.** Bajas, medallas y torneos quedan en una pestaña para todos y saltan
  como aviso mientras jugás. Con un webhook de Discord (⚙ Ajustes) también van al canal.
- **Torneos.** Cuando todos los que juegan una ROM llegan a la 3ª, 6ª u 8ª medalla, el sitio
  lo anuncia. Los combates en sí todavía se hacen por fuera.
- **Logros** de randomlocke para Rojo Fuego / Verde Hoja (`src/achievements.ts`): medallas,
  Liga, llegar lejos sin bajas, y algunos de la vergüenza. Dan experiencia y rango.
- **Participantes:** ranking de todas las cuentas con medallas, Pokédex, vidas y experiencia.
  El servidor lo arma leyendo la partida que cada uno sube, no lo que diga el navegador.
- **Controles editables.** Cada uno reasigna sus teclas en ⚙ Ajustes; con cuenta, viajan
  entre dispositivos.
- **Estética de consola:** todo dibujado con CSS y fuentes pixel (Press Start 2P y Pixelify
  Sans, incluidas en el build), sin imágenes ni assets de ningún juego.
- **Teclado y táctil.** Cruceta y botones en pantalla para el teléfono.

La partida en la nube se identifica por el archivo de la ROM (código del juego más una
huella del archivo): dos randomizaciones distintas son juegos y partidas distintas. Las ROMs
se guardan en D1 partidas en trozos de 1 MB (`functions/api/roms`).

## Controles de fábrica

Flechas (cruceta), X / Z (A / B), A / S (L / R), Enter / Retroceso (Start / Select) y
Espacio para acelerar. Se cambian en ⚙ Ajustes. Fijas: P pausa, M silencia, Escape abre el menú.

## Desarrollo

```bash
npm install
npm run dev
```

Abre en `http://localhost:5175`. Así no hay cuentas ni biblioteca: se juega sin login,
cada uno carga su ROM y la partida queda sólo en el navegador.

Para probar con cuentas y partida en la nube, todo en local:

```bash
npm run build
npm run pages
```

Abre en `http://localhost:8790`, con una base D1 local (no toca la del sitio) y el código de invitación
`invitacion-local`.

## Deployment gratis (Cloudflare Pages)

El emulador usa hilos, así que la página tiene que servirse con las cabeceras
`Cross-Origin-Opener-Policy: same-origin` y `Cross-Origin-Embedder-Policy: require-corp`
(ya están en `public/_headers`). Las cuentas y las partidas usan Pages Functions
(`functions/api`) y una base D1. Todo entra en el plan gratis.

1. En [dash.cloudflare.com](https://dash.cloudflare.com): **Workers & Pages → Create →
   Pages → Connect to Git** y elegir este repo. Framework `Vite`, comando `npm run build`,
   carpeta de salida `dist`.
2. **Storage & Databases → D1 SQL Database → Create**, con cualquier nombre (por ejemplo
   `wabgba`). No hay que crear tablas: se crean solas.
3. En el proyecto de Pages: **Settings → Bindings → Add → D1 database**. Nombre de la
   variable: `DB`. Base: la del paso 2.
4. En **Settings → Variables and Secrets → Add**: tipo *Secret*, nombre `INVITE_CODE`, y
   como valor el código que le vas a pasar a quien quieras que pueda crearse una cuenta.
5. **Deployments → Retry deployment**, para que tome los cambios.
6. En el sitio: **Crear una cuenta**, con usuario, contraseña y el código de invitación.
   **La primera cuenta que se crea es la administradora**: creá la tuya antes de pasarle el
   código a nadie. Ese `INVITE_CODE` queda como código de la primera sala; las demás salas,
   con sus códigos, se crean desde ⚙ Ajustes.
7. Con esa cuenta: **+ AGREGAR ROM**. Se sube a la biblioteca y la ven todos.

Sin `INVITE_CODE` nadie puede registrarse. Las contraseñas se guardan con hash (PBKDF2),
nunca en texto.

## Pendiente

- Instalable como app (PWA).
