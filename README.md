# WabGBA

Emulador de Game Boy Advance en el navegador, de uso personal. Corre sobre
[mGBA](https://mgba.io) compilado a WebAssembly
([@thenick775/mgba-wasm](https://www.npmjs.com/package/@thenick775/mgba-wasm)).

- **Tu ROM, tu navegador.** La ROM se elige desde el disco y queda guardada sólo en el
  navegador (IndexedDB). El sitio desplegado no incluye ni sube ningún juego.
- **Se guarda como en la consola.** Lo único que cuenta es guardar dentro del juego: no hay
  estados, ni rebobinado, ni forma de cargar una partida vieja. Pensado para un randomlocke.
- **Seguís donde lo dejaste.** Al cerrar la pestaña queda un punto de reanudación en ese
  dispositivo; no se puede elegir ni volver atrás.
- **Cuentas.** Entrás con usuario y contraseña y tu partida viaja sola: se sube al guardar
  dentro del juego y se baja al abrirlo en otro dispositivo. Cada cuenta tiene su propia
  partida, aunque todos usen la misma ROM. Si dos dispositivos cambiaron, pregunta cuál
  conservar.
- **Logros** para Pokémon Rojo Fuego / Verde Hoja: medallas, Liga, Pokédex, equipo y más.
  Se leen del `.sav` cada vez que guardás dentro del juego (`src/save.ts`). Para sumar uno
  nuevo, agregalo en `src/achievements.ts`.
- **Teclado y táctil.** Cruceta y botones en pantalla para el teléfono.

La partida en la nube se identifica por el archivo de la ROM (código del juego más una
huella del archivo). Para seguir la misma partida en dos dispositivos hay que cargar
**exactamente la misma ROM** en los dos: dos randomizaciones distintas son partidas distintas.

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

Abre en `http://localhost:5175`. Así no hay cuentas: se juega sin login y la partida queda
sólo en el navegador.

Para probar con cuentas y partida en la nube, todo en local:

```bash
npm run build
npm run pages
```

Abre en `http://localhost:8790`, con una base D1 local y el código de invitación
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

Sin `INVITE_CODE` nadie puede registrarse. Las contraseñas se guardan con hash (PBKDF2),
nunca en texto.

## Pendiente

- Instalable como app (PWA).
