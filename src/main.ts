import mGBA, { type mGBAEmulator } from '@thenick775/mgba-wasm';
import { ACHIEVEMENTS, evaluate, loadUnlocked, type Achievement } from './achievements';
import { readSave } from './save';
import * as sync from './sync';

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
    const synced = await syncUpload(false);
    toast(synced ? '☁ Partida guardada y sincronizada' : 'Partida guardada');
    checkAchievements(false);
  }, 600);
}

// ---------- Sincronización en la nube ----------
// La partida se identifica por el código del juego en la cabecera de la ROM (BPRS, BPRE…),
// así no importa cómo se llame el archivo en cada dispositivo.

const syncPanel = $('sync');
const syncStatus = $('sync-status');
const syncKeyInput = $<HTMLInputElement>('sync-key');
const syncProfileInput = $<HTMLInputElement>('sync-profile');
let gameCode = '';

function romCode(path: string, fallback: string): string {
  try {
    const stream = emu.FS.open(path, 'r');
    const buf = new Uint8Array(4);
    emu.FS.read(stream, buf, 0, 4, 0xac);
    emu.FS.close(stream);
    const code = String.fromCharCode(...buf);
    if (/^[A-Z0-9]{4}$/.test(code)) return code;
  } catch {
    /* ROM ilegible: usar el nombre */
  }
  return fallback.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 19) || 'juego';
}

/** Dónde vive el .sav de una ROM para el perfil activo. */
function savePathFor(romName: string): string {
  const profile = sync.getProfile();
  return `${emu.filePaths().savePath}/${stem(romName)}${profile ? '.' + profile : ''}.sav`;
}

/** Un .sav recién creado viene lleno de 0xFF: eso no cuenta como partida. */
const isRealSave = (data: Uint8Array | null | undefined) => !!data && data.some((b) => b !== 0xff && b !== 0);

function readFileIfAny(path: string): Uint8Array | null {
  try {
    return emu.FS.readFile(path);
  } catch {
    return null;
  }
}

function dropFile(path: string) {
  try {
    emu.FS.unlink(path);
  } catch {
    /* no existía */
  }
}

/** Antes de arrancar el juego: si la nube tiene una partida más nueva, traerla. */
async function syncBeforeLoad(romName: string): Promise<{ forceUpload: boolean }> {
  if (!sync.getKey()) return { forceUpload: false };
  const paths = emu.filePaths();
  const savePath = savePathFor(romName);
  const st = sync.getState(gameCode);
  try {
    const remote = await sync.remoteVersion(gameCode);
    if (remote === null || remote === st.base) return { forceUpload: false };

    const localChanged = isRealSave(readFileIfAny(savePath)) && (st.dirty || st.base === null);
    if (
      localChanged &&
      !confirm(
        'La nube tiene una partida distinta a la de este dispositivo, y acá hay progreso sin subir.\n\n' +
          'Aceptar: usar la de la nube (se pierde lo de este dispositivo).\n' +
          'Cancelar: quedarse con la de este dispositivo y subirla.',
      )
    ) {
      return { forceUpload: true };
    }

    const got = await sync.download(gameCode);
    if (!got) return { forceUpload: false };
    emu.FS.writeFile(savePath, got.data);
    // El estado automático trae la partida vieja adentro: descartarlo.
    dropFile(`${paths.autosave}/${stem(romName)}_auto.ss`);
    sync.setState(gameCode, { base: got.savedAt, dirty: false });
    await persist();
    toast('☁ Partida traída de la nube');
  } catch (e) {
    toast(sync.describe(e));
  }
  return { forceUpload: false };
}

/** Sube la partida actual. Devuelve true si quedó sincronizada. */
async function syncUpload(force: boolean): Promise<boolean> {
  if (!sync.getKey() || !running) return false;
  const data = emu.getSave();
  if (!isRealSave(data)) return false;
  const code = gameCode;
  const st = sync.getState(code);
  sync.setState(code, { ...st, dirty: true });
  try {
    const res = await sync.upload(code, data!, st.base, force);
    if (res.ok) {
      sync.setState(code, { base: res.savedAt, dirty: false });
      return true;
    }
    toast('⚠ La nube tiene otra partida. Abrí ☁ para elegir cuál conservar.');
  } catch (e) {
    toast(sync.describe(e));
  } finally {
    if (!syncPanel.hidden) renderSync();
  }
  return false;
}

/** Reemplaza la partida en uso por la de la nube. */
async function syncPull() {
  if (!running || !emu.saveName) return;
  try {
    const got = await sync.download(gameCode);
    if (!got) {
      toast('Todavía no hay partida en la nube');
      return;
    }
    emu.FS.writeFile(emu.saveName, got.data);
    if (emu.autoSaveStateName) dropFile(emu.autoSaveStateName);
    sync.setState(gameCode, { base: got.savedAt, dirty: false });
    await persist();
    emu.quickReload();
    setPaused(false);
    toast('☁ Partida traída de la nube');
    setTimeout(() => checkAchievements(true), 1500);
  } catch (e) {
    toast(sync.describe(e));
  }
  renderSync();
}

function renderSync(message?: string) {
  const hasKey = !!sync.getKey();
  $<HTMLButtonElement>('btn-sync-push').disabled = !hasKey || !running;
  $<HTMLButtonElement>('btn-sync-pull').disabled = !hasKey || !running;
  if (message) syncStatus.textContent = message;
  else if (!hasKey) syncStatus.textContent = 'Desactivada. Poné tu clave para activarla en este dispositivo.';
  else if (!running) syncStatus.textContent = 'Clave guardada. Abrí un juego para sincronizar su partida.';
  else {
    const st = sync.getState(gameCode);
    const when = st.base ? new Date(st.base).toLocaleString() : 'nunca';
    syncStatus.textContent =
      `Juego ${gameCode} · última sincronización: ${when}` + (st.dirty ? ' · hay cambios sin subir' : '');
  }
}

async function saveSyncKey() {
  sync.setKey(syncKeyInput.value.trim());
  const before = sync.getProfile();
  const profile = sync.setProfile(syncProfileInput.value);
  syncProfileInput.value = profile;
  if (profile !== before && running) {
    // Otro perfil es otra partida: hay que volver a abrir el juego.
    emu.forceAutoSaveState();
    emu.quitGame();
    running = false;
    await persist();
    toggleSync(false);
    renderLibrary();
    library.hidden = false;
    toast(profile ? `Perfil "${profile}": abrí el juego para seguir su partida` : 'Perfil quitado');
    return;
  }
  if (!sync.getKey()) {
    renderSync();
    return;
  }
  renderSync('Probando la clave…');
  try {
    await sync.remoteVersion(gameCode || 'prueba');
    renderSync();
    toast('☁ Sincronización activada');
    if (running) void syncUpload(false);
  } catch (e) {
    renderSync(sync.describe(e));
  }
}

function toggleSync(open: boolean) {
  if (open) {
    syncKeyInput.value = sync.getKey();
    syncProfileInput.value = sync.getProfile();
    renderSync();
  }
  syncPanel.hidden = !open;
  // Que el emulador no se coma las teclas mientras se escribe la clave.
  emu.toggleInput(!open);
}

// ---------- Logros ----------

const achvPanel = $('achievements');
const achvPop = $('achv-pop');
const popQueue: Achievement[] = [];
let popBusy = false;

const gameKey = () => (emu.saveName ? stem(baseName(emu.saveName)) : '');

function showNextPop() {
  const a = popQueue.shift();
  if (!a) {
    popBusy = false;
    return;
  }
  popBusy = true;
  achvPop.querySelector('.icon')!.textContent = a.icon;
  achvPop.querySelector('b')!.textContent = a.title;
  achvPop.classList.add('show');
  setTimeout(() => {
    achvPop.classList.remove('show');
    setTimeout(showNextPop, 450);
  }, 3500);
}

/** Lee la partida y desbloquea lo que corresponda. `quiet`: al abrir el juego, sin desfile de avisos. */
function checkAchievements(quiet: boolean) {
  if (!running) return;
  const save = readSave(emu.getSave());
  if (!save.ok) return;
  const fresh = evaluate(gameKey(), save.progress);
  if (!fresh.length) return;
  if (quiet || fresh.length > 3) {
    toast(fresh.length === 1 ? `🏆 ${fresh[0].title}` : `🏆 ${fresh.length} logros desbloqueados`);
  } else {
    popQueue.push(...fresh);
    if (!popBusy) showNextPop();
  }
  if (!achvPanel.hidden) renderAchievements();
}

function renderAchievements() {
  const save = readSave(emu.getSave());
  const unlocked = loadUnlocked(gameKey());
  const count = ACHIEVEMENTS.filter((a) => unlocked[a.id]).length;
  $('achv-count').textContent = `${count} / ${ACHIEVEMENTS.length}`;

  const summary = $('achv-summary');
  if (save.ok) {
    const p = save.progress;
    summary.textContent =
      `${p.name || 'Entrenador'} · ${p.hours}:${String(p.minutes).padStart(2, '0')} h · ` +
      `${p.badgeCount} ${p.badgeCount === 1 ? 'medalla' : 'medallas'} · Pokédex ${p.owned}`;
  } else if (save.reason === 'unsupported') {
    summary.textContent = 'Por ahora los logros sólo funcionan con Pokémon Rojo Fuego y Verde Hoja.';
  } else {
    summary.textContent = 'Todavía no hay partida guardada. Guardá dentro del juego para empezar a sumar logros.';
  }

  $('achv-list').replaceChildren(
    ...ACHIEVEMENTS.map((a) => {
      const when = unlocked[a.id];
      const li = document.createElement('li');
      li.classList.toggle('done', !!when);
      const icon = document.createElement('span');
      icon.className = 'icon';
      icon.textContent = a.icon;
      const body = document.createElement('div');
      body.className = 'body';
      const title = document.createElement('b');
      title.textContent = a.title;
      const desc = document.createElement('small');
      desc.textContent = a.desc;
      body.append(title, desc);
      const side = document.createElement('span');
      side.className = 'side';
      if (when) side.textContent = new Date(when).toLocaleDateString();
      else if (a.progress && save.ok) {
        const [cur, goal] = a.progress(save.progress);
        side.textContent = `${Math.min(cur, goal).toLocaleString()} / ${goal.toLocaleString()}`;
      }
      li.append(icon, body, side);
      return li;
    }),
  );
}

function toggleAchievements(open: boolean) {
  if (open) {
    checkAchievements(true);
    renderAchievements();
  }
  achvPanel.hidden = !open;
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

let starting = false;
async function startGame(name: string) {
  if (starting) return;
  starting = true;
  try {
    await startGameInner(name);
  } finally {
    starting = false;
  }
}

async function startGameInner(name: string) {
  if (running) emu.quitGame();
  running = false;
  const romPath = `${emu.filePaths().gamePath}/${name}`;
  const profile = sync.getProfile();
  gameCode = (profile ? profile + '-' : '') + romCode(romPath, stem(name));

  // El estado automático es uno por ROM: si la última vez jugó otro perfil, no sirve.
  const lastKey = `wabgba.lastProfile.${stem(name)}`;
  if ((localStorage.getItem(lastKey) ?? '') !== profile) {
    dropFile(`${emu.filePaths().autosave}/${stem(name)}_auto.ss`);
    localStorage.setItem(lastKey, profile);
  }

  if (sync.getKey()) statusEl.textContent = 'Revisando la partida en la nube…';
  const { forceUpload } = await syncBeforeLoad(name);

  const ok = emu.loadGame(romPath, savePathFor(name));
  if (!ok) {
    fail(`No se pudo abrir "${name}". ¿Es una ROM válida?`);
    return;
  }
  running = true;
  // Subir lo que este dispositivo tenga pendiente.
  const st = sync.getState(gameCode);
  if (forceUpload || st.dirty || st.base === null) setTimeout(() => void syncUpload(forceUpload), 1000);
  setPaused(false);
  applySpeed();
  applyVolume();
  library.hidden = true;
  document.title = `${stem(name)} · WabGBA`;
  canvas.focus();
  // Ponerse al día con lo que la partida ya tenía hecho.
  setTimeout(() => checkAchievements(true), 1500);
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
    // Una partida importada a mano reemplaza también la de la nube.
    setTimeout(() => void syncUpload(true), 1500);
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
    if (!running || !library.hidden || !syncPanel.hidden) return;
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

  $('btn-achievements').onclick = () => toggleAchievements(true);
  $('btn-achv-close').onclick = () => toggleAchievements(false);
  achvPanel.addEventListener('click', (e) => {
    if (e.target === achvPanel) toggleAchievements(false);
  });

  $('btn-sync').onclick = () => toggleSync(true);
  $('btn-sync-library').onclick = () => toggleSync(true);
  $('btn-sync-close').onclick = () => toggleSync(false);
  $('btn-sync-save').onclick = () => void saveSyncKey();
  $('btn-sync-push').onclick = async () => {
    if (!confirm('Esto reemplaza la partida de la nube por la de este dispositivo. ¿Seguir?')) return;
    if (await syncUpload(true)) toast('☁ Partida subida');
    renderSync();
  };
  $('btn-sync-pull').onclick = () => {
    if (!confirm('Esto reemplaza la partida de este dispositivo por la de la nube. ¿Seguir?')) return;
    void syncPull();
  };
  syncPanel.addEventListener('click', (e) => {
    if (e.target === syncPanel) toggleSync(false);
  });

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
  // A mano para depurar desde la consola del navegador.
  Object.assign(window, { emu });

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
