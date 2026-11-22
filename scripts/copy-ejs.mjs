// Copia a public/ejs lo que el emulador de Nintendo DS (EmulatorJS) necesita para correr
// desde el propio sitio. Esos archivos no van al repositorio: salen de node_modules.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const data = join(root, 'node_modules/@emulatorjs/emulatorjs/data');
const core = join(root, 'node_modules/@emulatorjs/core-desmume2015');
const out = join(root, 'public/ejs');

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'cores/reports'), { recursive: true });
mkdirSync(join(out, 'localization'), { recursive: true });

for (const file of ['loader.js', 'emulator.css', 'version.json']) cpSync(join(data, file), join(out, file));
for (const dir of ['src', 'compression']) cpSync(join(data, dir), join(out, dir), { recursive: true });
for (const file of ['es-ES.json', 'en-US.json', 'retroarch.json']) {
  cpSync(join(data, 'localization', file), join(out, 'localization', file));
}
// Sólo el núcleo sin hilos: no exige nada especial del navegador. El "legacy" es para los
// que no tienen WebGL 2.
for (const file of ['desmume2015-wasm.data', 'desmume2015-legacy-wasm.data']) cpSync(join(core, file), join(out, 'cores', file));
cpSync(join(core, 'reports/desmume2015.json'), join(out, 'cores/reports/desmume2015.json'));
console.log('EmulatorJS copiado a public/ejs');
