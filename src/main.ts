import mGBA, { type mGBAEmulator } from '@thenick775/mgba-wasm';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>('canvas');
const library = $('library');
const statusEl = $('status');
const romList = $('roms');
const btnAdd = $<HTMLButtonElement>('btn-add');
const fileRom = $<HTMLInputElement>('file-rom');
const fileSav = $<HTMLInputElement>('file-sav');
const toastEl = $('toast');
const btnPause = $('btn-pause');
const btnSpeed = $('btn-speed');
const btnMute = $('btn-mute');
const slotSel = $<HTMLSelectElement>('slot');

let emu: mGBAEmulator;
let running = false;
let paused = false;
let muted = false;
let speed = 1;
let holdingFast = false;

// ---------- Avisos ----------

let toastTimer = 0;
function toast(msg: string) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 1800);
}

function fail(msg: string) {
  statusEl.textContent = msg;
  statusEl.classList.add('error');
}

// ---------- Persistencia ----------
// El emulador escribe en un disco virtual; FSSync lo vuelca a IndexedDB.

let syncing: Promise<void> | null = null;
let syncAgain = false;
function persist(): Promise<void> {
  if (syncing) {
    syncAgain = true;
    return syncing;
  }
  syncing = emu
    .FSSync()
    .catch((e) => console.error('No se pudo guardar en el navegador', e))
    .finally(() => {
      syncing = null;
      if (syncAgain) {
        syncAgain = false;
        void persist();
      }
    });
  return syncing;
}

let saveTimer = 0;
function onGameSaved() {
  // El juego escribe la partida en varias tandas: esperar a que termine.
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    await persist();
    toast('Partida guardada');
  }, 600);
}

// ---------- Biblioteca ----------

const baseName = (path: string) => path.split('/').pop() ?? path;
const stem = (name: string) => name.replace(/\.[^.]+$/, '');

function renderLibrary() {
  const roms = emu.listRoms().filter((n) => n !== '.' && n !== '..');
  romList.replaceChildren(
    ...roms.map((name) => {
      const li = document.createElement('li');
      const play = document.createElement('button');
      play.className = 'play';
      play.textContent = '▶  ' + stem(name);
      play.onclick = () => startGame(name);
      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = '✕';
      del.title = 'Quitar la ROM (la partida se conserva)';
      del.onclick = async () => {
        if (!confirm(`¿Quitar "${name}" de este navegador? La partida guardada se conserva.`)) return;
        emu.FS.unlink(`${emu.filePaths().gamePath}/${name}`);
        await persist();
        renderLibrary();
      };
      li.append(play, del);
      return li;
    }),
  );
  statusEl.classList.remove('error');
  statusEl.textContent = roms.length ? 'Elegí un juego para seguir tu partida.' : 'Agregá tu ROM para empezar.';
}

function addRom(file: File) {
  statusEl.textContent = 'Guardando la ROM en el navegador…';
  emu.uploadRom(file, async () => {
    await persist();
    // Pedirle al navegador que no borre estos datos si falta espacio.
    void navigator.storage?.persist?.();
    renderLibrary();
    startGame(file.name);
  });
}

function startGame(name: string) {
  if (running) emu.quitGame();
  const ok = emu.loadGame(`${emu.filePaths().gamePath}/${name}`);
  if (!ok) {
    fail(`No se pudo abrir "${name}". ¿Es una ROM válida?`);
    return;
  }
  running = true;
  setPaused(false);
  applySpeed();
  applyVolume();
  library.hidden = true;
  document.title = `${stem(name)} · WabGBA`;
  canvas.focus();
}

async function openLibrary() {
  if (running) {
    emu.forceAutoSaveState();
    await persist();
    emu.pauseGame();
  }
  renderLibrary();
  library.hidden = false;
}

function closeLibraryIfRunning() {
  if (!running) return;
  library.hidden = true;
  if (!paused) emu.resumeGame();
}

// ---------- Controles del emulador ----------

function setPaused(p: boolean) {
  paused = p;
  if (p) emu.pauseGame();
  else emu.resumeGame();
  btnPause.textContent = p ? '▶ Seguir' : '⏸ Pausa';
  btnPause.classList.toggle('on', p);
}

function applySpeed() {
  const s = holdingFast ? Math.max(speed, 3) : speed;
  emu.setFastForwardMultiplier(s);
  btnSpeed.textContent = `x${speed}`;
  btnSpeed.classList.toggle('on', speed > 1);
}

function applyVolume() {
  emu.setVolume(muted ? 0 : 1);
  btnMute.textContent = muted ? '🔇' : '🔊';
  btnMute.classList.toggle('on', muted);
}

async function saveState() {
  const slot = Number(slotSel.value);
  if (emu.saveState(slot)) {
    await persist();
    toast(`Estado guardado en la ranura ${slot}`);
  } else toast('No se pudo guardar el estado');
}

function loadState() {
  const slot = Number(slotSel.value);
  toast(emu.loadState(slot) ? `Estado de la ranura ${slot} cargado` : `La ranura ${slot} está vacía`);
}

function exportSave() {
  const data = emu.getSave();
  if (!data?.length || !emu.saveName) {
    toast('Todavía no hay partida guardada');
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data.slice()], { type: 'application/octet-stream' }));
  a.download = baseName(emu.saveName);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function importSave(file: File) {
  if (!emu.saveName) return;
  if (!confirm('Esto reemplaza la partida actual por la del archivo. ¿Seguir?')) return;
  // El .sav tiene que llamarse igual que el de la ROM en uso.
  const renamed = new File([file], baseName(emu.saveName));
  emu.uploadSaveOrSaveState(renamed, async () => {
    // El estado automático trae la partida vieja adentro: descartarlo.
    try {
      if (emu.autoSaveStateName) emu.FS.unlink(emu.autoSaveStateName);
    } catch {
      /* no había */
    }
    await persist();
    emu.quickReload();
    setPaused(false);
    toast('Partida importada');
  });
}

// ---------- Teclado ----------

const KEYS: [sdlKey: string, gba: string][] = [
  ['X', 'A'],
  ['Z', 'B'],
  ['A', 'L'],
  ['S', 'R'],
  ['Return', 'Start'],
  ['Backspace', 'Select'],
  ['Up', 'Up'],
  ['Down', 'Down'],
  ['Left', 'Left'],
  ['Right', 'Right'],
];

function setupKeyboard() {
  for (const [key, gba] of KEYS) emu.bindKey(key, gba);

  window.addEventListener('keydown', (e) => {
    if (!running || !library.hidden) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (!holdingFast) {
        holdingFast = true;
        applySpeed();
      }
    } else if (e.repeat) {
      return;
    } else if (e.code === 'KeyP') setPaused(!paused);
    else if (e.code === 'KeyM') {
      muted = !muted;
      applyVolume();
    } else if (e.code === 'F2') {
      e.preventDefault();
      void saveState();
    } else if (e.code === 'F4') {
      e.preventDefault();
      loadState();
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && holdingFast) {
      holdingFast = false;
      if (running) applySpeed();
    }
  });
}

// ---------- Controles táctiles ----------

function setupTouch() {
  for (const el of document.querySelectorAll<HTMLElement>('.pad[data-btn]')) {
    const name = el.dataset.btn!;
    const up = () => {
      el.classList.remove('down');
      emu.buttonUnpress(name);
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.classList.add('down');
      emu.buttonPress(name);
    });
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // Cruceta: una sola zona, la dirección sale de dónde está el dedo.
  const dpad = $('dpad');
  let dir: string | null = null;
  const setDir = (d: string | null) => {
    if (d === dir) return;
    if (dir) emu.buttonUnpress(dir);
    dir = d;
    if (d) emu.buttonPress(d);
    if (d) dpad.dataset.dir = d;
    else delete dpad.dataset.dir;
  };
  const dirAt = (e: PointerEvent) => {
    const r = dpad.getBoundingClientRect();
    const x = e.clientX - (r.left + r.width / 2);
    const y = e.clientY - (r.top + r.height / 2);
    if (Math.hypot(x, y) < r.width * 0.1) return null;
    return Math.abs(x) > Math.abs(y) ? (x > 0 ? 'Right' : 'Left') : y > 0 ? 'Down' : 'Up';
  };
  dpad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    dpad.setPointerCapture(e.pointerId);
    setDir(dirAt(e));
  });
  dpad.addEventListener('pointermove', (e) => {
    if (dpad.hasPointerCapture(e.pointerId)) setDir(dirAt(e));
  });
  dpad.addEventListener('pointerup', () => setDir(null));
  dpad.addEventListener('pointercancel', () => setDir(null));

  const stored = localStorage.getItem('wabgba.touch');
  const on = stored ? stored === '1' : matchMedia('(pointer: coarse)').matches;
  document.body.classList.toggle('touch', on);
  $('btn-touch').onclick = () => {
    const now = document.body.classList.toggle('touch');
    localStorage.setItem('wabgba.touch', now ? '1' : '0');
  };
}

// ---------- Arranque ----------

function setupToolbar() {
  $('btn-library').onclick = () => void openLibrary();
  btnPause.onclick = () => setPaused(!paused);
  btnSpeed.onclick = () => {
    speed = speed === 1 ? 2 : speed === 2 ? 4 : 1;
    applySpeed();
  };
  $('btn-save-state').onclick = () => void saveState();
  $('btn-load-state').onclick = loadState;
  $('btn-export').onclick = exportSave;
  $('btn-import').onclick = () => fileSav.click();
  btnMute.onclick = () => {
    muted = !muted;
    applyVolume();
  };
  $('btn-full').onclick = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void $('player').requestFullscreen?.();
  };

  btnAdd.onclick = () => fileRom.click();
  fileRom.onchange = () => {
    const f = fileRom.files?.[0];
    fileRom.value = '';
    if (f) addRom(f);
  };
  fileSav.onchange = () => {
    const f = fileSav.files?.[0];
    fileSav.value = '';
    if (f) importSave(f);
  };

  // Clic fuera de la tarjeta: volver al juego.
  library.addEventListener('click', (e) => {
    if (e.target === library) closeLibraryIfRunning();
  });

  // Que los botones no se queden con el foco del teclado.
  for (const b of document.querySelectorAll('#toolbar button')) {
    b.addEventListener('click', () => (b as HTMLElement).blur());
  }
}

async function main() {
  if (!window.crossOriginIsolated) {
    fail('Esta página necesita las cabeceras COOP/COEP para correr el emulador (ver README).');
    return;
  }

  emu = await mGBA({ canvas });
  await emu.FSInit();
  if (import.meta.env.DEV) Object.assign(window, { emu });

  emu.addCoreCallbacks({
    saveDataUpdatedCallback: onGameSaved,
    autoSaveStateCapturedCallback: () => void persist(),
    coreCrashedCallback: () => toast('El juego se colgó. Recargá la página.'),
  });

  setupToolbar();
  setupKeyboard();
  setupTouch();

  // Al salir o cambiar de pestaña, dejar todo guardado.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && running) {
      emu.forceAutoSaveState();
      void persist();
    }
  });

  // El navegador sólo deja sonar el audio después de un gesto.
  const wakeAudio = () => void emu.SDL2?.audioContext?.resume?.();
  window.addEventListener('pointerdown', wakeAudio);
  window.addEventListener('keydown', wakeAudio);

  btnAdd.disabled = false;
  renderLibrary();
  console.log(`${emu.version.projectName} ${emu.version.projectVersion}`);
}

main().catch((e) => {
  console.error(e);
  fail('No se pudo iniciar el emulador: ' + (e instanceof Error ? e.message : String(e)));
});
