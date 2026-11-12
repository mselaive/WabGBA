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

Ya están configuradas para los dos hostings gratuitos que sirven:

- **Cloudflare Pages:** `public/_headers`. Comando de build `npm run build`, carpeta `dist`.
- **Vercel:** `vercel.json`. Detecta Vite solo.

GitHub Pages no sirve tal cual, porque no deja configurar cabeceras.

## Pendiente

- Sincronizar la partida entre dispositivos.
- Instalable como app (PWA).
