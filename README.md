# WabGBA

Emulador de Game Boy Advance en el navegador, de uso personal. Corre sobre
[mGBA](https://mgba.io) compilado a WebAssembly
([@thenick775/mgba-wasm](https://www.npmjs.com/package/@thenick775/mgba-wasm)).

- **Tu ROM, tu navegador.** La ROM se elige desde el disco y queda guardada sólo en el
  navegador (IndexedDB). El sitio desplegado no incluye ni sube ningún juego.
- **La partida se guarda sola.** Cada vez que guardás dentro del juego, el `.sav` se
  persiste en el navegador. Además hay un estado automático: al volver, el juego sigue
  donde lo dejaste.
- **Estados** en tres ranuras, **exportar / importar** el `.sav` como respaldo o para
  pasarlo entre dispositivos, acelerar, pausa, silencio y pantalla completa.
- **Teclado y táctil.** Cruceta y botones en pantalla para el teléfono.
- **Logros** para Pokémon Rojo Fuego / Verde Hoja: medallas, Liga, Pokédex, equipo y más.
  Se leen del `.sav` cada vez que guardás dentro del juego (`src/save.ts`) y quedan
  anotados en el navegador. Para sumar uno nuevo, agregalo en `src/achievements.ts`.

- **Sincronización entre dispositivos** (opcional): con la misma clave en la PC y el
  teléfono, la partida se sube al guardar dentro del juego y se baja al abrirlo en el otro.
  Si las dos cambiaron, pregunta cuál conservar.
- **Perfiles:** cada persona pone su nombre y tiene su propia partida con la misma ROM, en
  el dispositivo y en la nube. La ROM no se comparte: cada uno la agrega en su dispositivo.

## Controles

| Tecla               | GBA                     |
| ------------------- | ----------------------- |
| Flechas             | Cruceta                 |
| X / Z               | A / B                   |
| A / S               | L / R                   |
| Enter / Retroceso   | Start / Select          |
| Espacio (mantener)  | Acelerar                |
| P · M               | Pausa · Silencio        |
| F2 · F4             | Guardar · cargar estado |

## Desarrollo

```bash
npm install
npm run dev
```

Abre en `http://localhost:5175`.

## Deployment gratis

El emulador usa hilos, así que la página tiene que servirse con estas cabeceras:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Ya están configuradas en `public/_headers` (Cloudflare Pages) y `vercel.json` (Vercel).
GitHub Pages no sirve tal cual, porque no deja configurar cabeceras.

La sincronización sólo funciona en **Cloudflare Pages**, porque usa una Pages Function
(`functions/api/save/[name].ts`) y una base D1. Todo entra en el plan gratis.

### Cloudflare Pages, paso a paso

1. En [dash.cloudflare.com](https://dash.cloudflare.com): **Workers & Pages → Create →
   Pages → Connect to Git** y elegir este repo. Framework `Vite`, comando `npm run build`,
   carpeta de salida `dist`.
2. **Storage & Databases → D1 SQL Database → Create**, con cualquier nombre (por ejemplo
   `wabgba`). No hay que crear tablas: se crean solas.
3. En el proyecto de Pages: **Settings → Bindings → Add → D1 database**. Nombre de la
   variable: `DB`. Base: la del paso 2.
4. En **Settings → Variables and Secrets → Add**: tipo *Secret*, nombre `SYNC_KEY`, y como
   valor la clave que quieras usar (larga, que no uses en otro lado).
5. **Deployments → Retry deployment**, para que tome los cambios.
6. En el sitio: **☁ → clave → Guardar**, en cada dispositivo.

Quien tenga la clave puede leer y pisar todas las partidas del sitio: compartila sólo con
quien vaya a jugar.

### Probar la sincronización en local

```bash
npm run build
npm run pages
```

Abre en `http://localhost:8790` con una base D1 local y la clave `clave-local`.

## Pendiente

- Instalable como app (PWA).
