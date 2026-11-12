# WabGBA

Emulador de Game Boy Advance en el navegador, de uso personal. Corre sobre
[mGBA](https://mgba.io) compilado a WebAssembly
([@thenick775/mgba-wasm](https://www.npmjs.com/package/@thenick775/mgba-wasm)).

- **Biblioteca del sitio.** Sólo la cuenta administradora (la primera que se crea) sube
  ROMs; los demás participantes ven esos cartuchos y los descargan a su navegador, sin poder
  cargar otros. Así todos juegan exactamente la misma ROM. El repo no incluye ningún juego.
- **Se guarda como en la consola.** Lo único que cuenta es guardar dentro del juego: no hay
  estados, ni rebobinado, ni forma de cargar una partida vieja. Pensado para un randomlocke.
- **Seguís donde lo dejaste.** Al cerrar la pestaña queda un punto de reanudación en ese
  dispositivo; no se puede elegir ni volver atrás.
- **Cuentas.** Entrás con usuario y contraseña y tu partida viaja sola: se sube al guardar
  dentro del juego y se baja al abrirlo en otro dispositivo. Cada cuenta tiene su propia
  partida, aunque todos usen la misma ROM. Si dos dispositivos cambiaron, pregunta cuál
  conservar.
- **Misiones y logros** para Pokémon Rojo Fuego / Verde Hoja: medallas, Liga, Pokédex,
  equipo y más. Se leen del `.sav` cada vez que guardás dentro del juego (`src/save.ts`).
  Cada uno da experiencia, que sube el rango de entrenador. Las misiones son los mismos
  logros agrupados en cadenas; para sumar uno nuevo, agregalo en `src/achievements.ts`.
- **Participantes:** ranking de todas las cuentas con sus medallas, Pokédex y experiencia.
  El servidor lo arma leyendo la partida que cada uno sube, no lo que diga el navegador.
- **Estética de consola:** todo dibujado con CSS y fuentes pixel (Press Start 2P y Pixelify
  Sans, incluidas en el build), sin imágenes ni assets de ningún juego.
- **Teclado y táctil.** Cruceta y botones en pantalla para el teléfono.

La partida en la nube se identifica por el archivo de la ROM (código del juego más una
huella del archivo): dos randomizaciones distintas son juegos y partidas distintas. Las ROMs
se guardan en D1 partidas en trozos de 1 MB (`functions/api/roms`).

## Controles

| Tecla               | GBA              |
| ------------------- | ---------------- |
| Flechas             | Cruceta          |
| X / Z               | A / B            |
| A / S               | L / R            |
| Enter / Retroceso   | Start / Select   |
| Espacio (mantener)  | Acelerar         |
| P · M               | Pausa · Silencio |

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
   código a nadie.
7. Con esa cuenta: **+ AGREGAR ROM**. Se sube a la biblioteca y la ven todos.

Sin `INVITE_CODE` nadie puede registrarse. Las contraseñas se guardan con hash (PBKDF2),
nunca en texto.

## Pendiente

- Instalable como app (PWA).
