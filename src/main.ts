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
const toastEl = $('toast');
const btnPause = $('btn-pause');
const btnSpeed = $('btn-speed');
const btnMute = $('btn-mute');

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

// ---------- Cuenta ----------

const loginPanel = $('login');
const loginError = $('login-error');
const loginUser = $<HTMLInputElement>('login-user');
const loginPass = $<HTMLInputElement>('login-pass');
const loginInvite = $<HTMLInputElement>('login-invite');
const loginSubmit = $<HTMLButtonElement>('login-submit');
/** El sitio tiene servidor de cuentas (en `npm run dev` no). */
let cloud = false;
let registerMode = false;

const username = () => sync.getSession()?.username ?? '';

function setRegisterMode(on: boolean) {
  registerMode = on;
  loginInvite.hidden = !on;
  loginSubmit.textContent = on ? 'Crear cuenta' : 'Entrar';
  $('login-switch').textContent = on ? 'Ya tengo cuenta' : 'Crear una cuenta';
  loginPass.autocomplete = on ? 'new-password' : 'current-password';
}

function showLogin(message = '') {
  loginError.textContent = message;
  setRegisterMode(false);
  loginPanel.hidden = false;
  // Que el emulador no se coma las teclas mientras se escribe.
  emu.toggleInput(false);
}

function hideLogin() {
  loginPanel.hidden = true;
  emu.toggleInput(true);
  renderLibrary();
}

/** Cierra el juego en curso dejando todo guardado en el dispositivo. */
async function stopGame() {
  if (!running) return;
  emu.forceAutoSaveState();
  emu.quitGame();
  running = false;
  await persist();
  library.hidden = false;
}

async function submitLogin() {
  loginSubmit.disabled = true;
  loginError.textContent = '';
  try {
    const mode = registerMode ? 'register' : 'login';
    const session = await sync.signIn(mode, loginUser.value.trim(), loginPass.value, loginInvite.value);
    loginPass.value = '';
    loginInvite.value = '';
    // Cada cuenta tiene su propia partida: lo que estuviera abierto se cierra.
    await stopGame();
    hideLogin();
    toast(`Hola, ${session.username}`);
  } catch (e) {
    loginError.textContent = sync.describe(e);
  } finally {
    loginSubmit.disabled = false;
  }
}

async function logout() {
  await stopGame();
  await sync.signOut();
  renderLibrary();
  showLogin();
}

function renderAccount() {
  const session = sync.getSession();
  $('account').hidden = !cloud;
  $('account-name').textContent = session ? `👤 ${session.username}` : 'Sin cuenta: la partida queda sólo acá';
  $('btn-account').textContent = session ? 'Salir' : 'Entrar';
}

// ---------- Partida en la nube ----------
// La partida se identifica por el código del juego más una huella del archivo de la ROM:
// no importa cómo se llame el archivo en cada dispositivo, pero tiene que ser la misma ROM
// (dos randomizaciones distintas son juegos distintos).

let gameCode = '';

async function romId(path: string, fallback: string): Promise<string> {
  let code = fallback.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 19) || 'juego';
  try {
    const rom = emu.FS.readFile(path).slice();
    const header = String.fromCharCode(...rom.subarray(0xac, 0xb0));
    if (/^[A-Z0-9]{4}$/.test(header)) code = header;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', rom));
    const print = [...digest.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${code}-${print}`;
  } catch {
    return code;
  }
}

/** Dónde vive el .sav de una ROM para la cuenta activa. */
function savePathFor(romName: string): string {
  const user = username();
  return `${emu.filePaths().savePath}/${stem(romName)}${user ? '.' + user : ''}.sav`;
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
  if (!username()) return { forceUpload: false };
  const savePath = savePathFor(romName);
  const st = sync.getState(gameCode);
  try {
    const remote = await sync.remoteVersion(gameCode);
    if (remote === null || remote === st.base) return { forceUpload: false };

    const localChanged = isRealSave(readFileIfAny(savePath)) && (st.dirty || st.base === null);
    if (
      localChanged &&
      !confirm(
        'Tu cuenta tiene una partida distinta a la de este dispositivo, y acá hay progreso sin subir.\n\n' +
          'Aceptar: usar la de tu cuenta (se pierde lo de este dispositivo).\n' +
          'Cancelar: quedarse con la de este dispositivo y subirla.',
      )
    ) {
      return { forceUpload: true };
    }

    const got = await sync.download(gameCode);
    if (!got) return { forceUpload: false };
    emu.FS.writeFile(savePath, got.data);
    // El punto de reanudación trae la partida vieja adentro: descartarlo.
    dropFile(`${emu.filePaths().autosave}/${stem(romName)}_auto.ss`);
    sync.setState(gameCode, { base: got.savedAt, dirty: false });
    await persist();
    toast('☁ Partida traída de tu cuenta');
  } catch (e) {
    if (e instanceof sync.SyncError && e.kind === 'auth') throw e;
    toast(sync.describe(e));
  }
  return { forceUpload: false };
}

/** Sube la partida actual. Devuelve true si quedó sincronizada. */
async function syncUpload(force: boolean): Promise<boolean> {
  if (!username() || !running) return false;
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
    toast('⚠ Tu cuenta tiene otra partida de este juego. Al volver a abrirlo vas a elegir cuál queda.');
  } catch (e) {
    toast(sync.describe(e));
  }
  return false;
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
  renderAccount();
  $('btn-export').hidden = !running;
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
  } catch (e) {
    // La sesión venció: hay que volver a entrar antes de tocar la partida.
    if (e instanceof sync.SyncError && e.kind === 'auth') {
      sync.clearSession();
      showLogin(sync.describe(e));
    } else throw e;
  } finally {
    starting = false;
  }
}

async function startGameInner(name: string) {
  if (running) emu.quitGame();
  running = false;
  const paths = emu.filePaths();
  const romPath = `${paths.gamePath}/${name}`;
  const user = username();
  gameCode = await romId(romPath, stem(name));

  // La partida que había antes de tener cuenta pasa a ser de la primera cuenta que entra.
  const adoptedKey = `wabgba.adopted.${stem(name)}`;
  if (user && !localStorage.getItem(adoptedKey)) {
    const plain = readFileIfAny(`${paths.savePath}/${stem(name)}.sav`);
    if (isRealSave(plain) && !readFileIfAny(savePathFor(name))) emu.FS.writeFile(savePathFor(name), plain!);
    localStorage.setItem(adoptedKey, user);
  }

  // El punto de reanudación es uno por ROM: si la última vez jugó otra cuenta, no sirve.
  const lastKey = `wabgba.lastUser.${stem(name)}`;
  if ((localStorage.getItem(lastKey) ?? '') !== user) {
    dropFile(`${paths.autosave}/${stem(name)}_auto.ss`);
    localStorage.setItem(lastKey, user);
  }

  if (user) statusEl.textContent = 'Revisando la partida de tu cuenta…';
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
    if (!running || !library.hidden || !loginPanel.hidden) return;
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
  $('btn-export').onclick = exportSave;
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

  $('btn-account').onclick = () => (sync.getSession() ? void logout() : showLogin());
  $('login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    void submitLogin();
  });
  $('login-switch').onclick = () => setRegisterMode(!registerMode);
  $('login-skip').onclick = hideLogin;

  btnAdd.onclick = () => fileRom.click();
  fileRom.onchange = () => {
    const f = fileRom.files?.[0];
    fileRom.value = '';
    if (f) addRom(f);
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

  // Sin rebobinar: lo único que cuenta es el guardado del juego.
  emu.setCoreSettings({ rewindEnable: false });

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
  const account = await sync.check();
  cloud = account !== 'none';
  renderLibrary();
  if (account === 'out' || (account === 'offline' && !sync.getSession())) showLogin();
  console.log(`${emu.version.projectName} ${emu.version.projectVersion}`);
}

main().catch((e) => {
  console.error(e);
  fail('No se pudo iniciar el emulador: ' + (e instanceof Error ? e.message : String(e)));
});
