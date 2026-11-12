import '@fontsource/press-start-2p';
import '@fontsource/pixelify-sans/400.css';
import '@fontsource/pixelify-sans/600.css';
import '@fontsource/pixelify-sans/700.css';
import mGBA, { type mGBAEmulator } from '@thenick775/mgba-wasm';
import {
  ACHIEVEMENTS,
  BADGES,
  CHAINS,
  evaluate,
  loadUnlocked,
  pointsFor,
  rankFor,
  type Achievement,
} from './achievements';
import { readSave, type Progress, type SaveResult } from './save';
import { setSfx, sfx } from './sfx';
import * as sync from './sync';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Crea un elemento con clase y texto. */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

const canvas = $<HTMLCanvasElement>('canvas');
const hub = $('hub');
const romList = $('roms');
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

const baseName = (path: string) => path.split('/').pop() ?? path;
const stem = (name: string) => name.replace(/\.[^.]+$/, '');

// ---------- Avisos ----------

let toastTimer = 0;
function toast(msg: string) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 2200);
}

/** Escribe un texto letra por letra en la caja de abajo del menú. */
let sayTimer = 0;
function say(text: string) {
  const target = $('textbox-text');
  clearInterval(sayTimer);
  let i = 0;
  target.textContent = '';
  sayTimer = window.setInterval(() => {
    i += 2;
    target.textContent = text.slice(0, i);
    if (i >= text.length) clearInterval(sayTimer);
  }, 16);
}

function fail(msg: string) {
  sfx('error');
  say(msg);
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
    playersCache = null;
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
  $('login-invite-row').hidden = !on;
  loginSubmit.textContent = on ? '▶ CREAR CUENTA' : '▶ ENTRAR';
  $('login-sub').textContent = on ? 'Nueva ficha de entrenador' : '¡Hola, entrenador!';
  $('login-switch').textContent = on ? 'Ya tengo cuenta' : 'Crear una cuenta';
  loginPass.autocomplete = on ? 'new-password' : 'current-password';
  loginError.textContent = '';
}

function loginFail(message: string) {
  loginError.textContent = message;
  loginError.classList.remove('shake');
  void loginError.offsetWidth; // reinicia la animación
  loginError.classList.add('shake');
  sfx('error');
}

function showLogin(message = '') {
  setRegisterMode(false);
  loginError.textContent = message;
  loginPanel.hidden = false;
  // Que el emulador no se coma las teclas mientras se escribe.
  emu.toggleInput(false);
  loginUser.focus();
}

function hideLogin() {
  loginPanel.hidden = true;
  emu.toggleInput(hub.hidden);
  renderHub();
}

/** Cierra el juego en curso dejando todo guardado en el dispositivo. */
async function stopGame() {
  if (!running) return;
  emu.forceAutoSaveState();
  emu.quitGame();
  running = false;
  await persist();
  document.title = 'WabGBA';
  setHub(true);
}

async function submitLogin() {
  if (loginSubmit.disabled) return;
  if (!loginUser.value.trim() || !loginPass.value) {
    loginFail('Escribí tu usuario y tu contraseña.');
    return;
  }
  loginSubmit.disabled = true;
  loginError.textContent = '';
  try {
    const mode = registerMode ? 'register' : 'login';
    const session = await sync.signIn(mode, loginUser.value.trim(), loginPass.value, loginInvite.value);
    loginPass.value = '';
    loginInvite.value = '';
    // Cada cuenta tiene su propia partida: lo que estuviera abierto se cierra.
    await stopGame();
    playersCache = null;
    catalogLoaded = false;
    sfx('ok');
    hideLogin();
    toast(`¡Hola, ${session.username}!`);
  } catch (e) {
    loginFail(sync.describe(e));
  } finally {
    loginSubmit.disabled = false;
  }
}

async function logout() {
  await stopGame();
  await sync.signOut();
  playersCache = null;
  catalogLoaded = false;
  renderHub();
  showLogin();
}

function renderAccount() {
  const session = sync.getSession();
  $('account').hidden = !cloud;
  $('account-name').textContent = session ? session.username : '';
  $('btn-account').textContent = session ? 'SALIR' : 'ENTRAR';
}

// ---------- Partida en la nube ----------
// La partida se identifica por el código del juego más una huella del archivo de la ROM:
// no importa cómo se llame el archivo en cada dispositivo, pero tiene que ser la misma ROM
// (dos randomizaciones distintas son juegos distintos).

let gameCode = '';

async function romIdOf(rom: Uint8Array, fallback: string): Promise<string> {
  let code = fallback.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 19) || 'juego';
  const header = String.fromCharCode(...rom.subarray(0xac, 0xb0));
  if (/^[A-Z0-9]{4}$/.test(header)) code = header;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(rom)));
  const print = [...digest.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${code}-${print}`;
}

async function romId(path: string, fallback: string): Promise<string> {
  try {
    return await romIdOf(emu.FS.readFile(path).slice(), fallback);
  } catch {
    return fallback.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 19) || 'juego';
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

// ---------- Mi progreso ----------

const romNames = () => emu.listRoms().filter((n) => n !== '.' && n !== '..');

/** La ROM en juego o, si no hay ninguna abierta, la última que se jugó. */
function activeRom(): string | null {
  if (running && emu.gameName) return baseName(emu.gameName);
  const last = localStorage.getItem('wabgba.lastRom');
  return last && romNames().includes(last) ? last : null;
}

function mySave(): SaveResult {
  if (running) return readSave(emu.getSave());
  const rom = activeRom();
  return rom ? readSave(readFileIfAny(savePathFor(rom))) : { ok: false, reason: 'empty' };
}

/** Clave bajo la que se anotan los logros de la partida activa. */
function myGameKey(): string {
  const rom = activeRom();
  return rom ? stem(baseName(savePathFor(rom))) : '';
}

// ---------- Logros ----------

const achvPop = $('achv-pop');
const popQueue: Achievement[] = [];
let popBusy = false;

function showNextPop() {
  const a = popQueue.shift();
  if (!a) {
    popBusy = false;
    return;
  }
  popBusy = true;
  achvPop.querySelector('.icon')!.textContent = a.icon;
  achvPop.querySelector('b')!.textContent = `${a.title}  +${a.points} XP`;
  achvPop.classList.add('show');
  sfx('unlock');
  setTimeout(() => {
    achvPop.classList.remove('show');
    setTimeout(showNextPop, 450);
  }, 3500);
}

/** Lee la partida y desbloquea lo que corresponda. `quiet`: sin desfile de avisos. */
function checkAchievements(quiet: boolean) {
  const save = mySave();
  const key = myGameKey();
  if (!save.ok || !key) return;
  const fresh = evaluate(key, save.progress);
  if (!fresh.length || quiet) return;
  if (fresh.length > 3) {
    toast(`🏆 ${fresh.length} logros desbloqueados`);
    sfx('unlock');
  } else {
    popQueue.push(...fresh);
    if (!popBusy) showNextPop();
  }
}

// ---------- Menú ----------

type Tab = 'play' | 'missions' | 'trophies' | 'players';
const TABS: Tab[] = ['play', 'missions', 'trophies', 'players'];
let tab: Tab = 'play';

function setHub(open: boolean) {
  hub.hidden = !open;
  if (running) {
    if (open) emu.pauseGame();
    else if (!paused) emu.resumeGame();
  }
  emu.toggleInput(!open && loginPanel.hidden);
  if (open) renderHub();
}

async function openHub() {
  if (running) {
    emu.forceAutoSaveState();
    void persist();
  }
  sfx('ok');
  setHub(true);
}

function closeHub() {
  if (!running) return;
  sfx('back');
  setHub(false);
}

function setTab(next: Tab) {
  if (next !== tab) sfx('move');
  tab = next;
  renderHub();
}

function renderHub() {
  renderAccount();
  checkAchievements(true);
  for (const b of document.querySelectorAll<HTMLElement>('#tabs button')) {
    b.classList.toggle('on', b.dataset.tab === tab);
  }
  for (const t of TABS) $(`tab-${t}`).hidden = t !== tab;
  if (tab === 'play') renderPlay();
  else if (tab === 'missions') renderMissions();
  else if (tab === 'trophies') renderTrophies();
  else renderPlayers();
}

// ----- Jugar -----

// La biblioteca del sitio: las ROMs que subió la cuenta administradora. Los demás sólo
// las descargan. Sin servidor de cuentas (`npm run dev`) cada uno carga las suyas.

let catalog: sync.RomInfo[] = loadJson<sync.RomInfo[]>('wabgba.catalog', []);
let catalogLoaded = false;
let busy = false;

function loadJson<T>(key: string, fallback: T): T {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? 'null') as T | null) ?? fallback;
  } catch {
    return fallback;
  }
}

const isAdmin = () => !!sync.getSession()?.admin;
/** Hay biblioteca compartida: el sitio tiene cuentas y hay una sesión abierta. */
const shared = () => cloud && !!username();
/** Quién puede cargar ROMs: la cuenta administradora (o cualquiera si no hay cuentas). */
const canAdd = () => !cloud || isAdmin();

/** Con qué archivo de este navegador se corresponde cada ROM de la biblioteca. */
const fileMap = () => loadJson<Record<string, string>>('wabgba.files', {});

function linkFile(id: string, name: string) {
  localStorage.setItem('wabgba.files', JSON.stringify({ ...fileMap(), [id]: name }));
}

function fileFor(rom: sync.RomInfo): string | null {
  const names = romNames();
  const linked = fileMap()[rom.id];
  if (linked && names.includes(linked)) return linked;
  return names.includes(`${rom.id}.gba`) ? `${rom.id}.gba` : null;
}

/** Nombre para mostrar: el título de la biblioteca si la ROM viene de ahí. */
function titleOf(name: string): string {
  return catalog.find((r) => fileFor(r) === name)?.title ?? stem(name);
}

/** Un fallo hablando con el servidor: si venció la sesión, a entrar de nuevo. */
function onCloudError(e: unknown) {
  if (e instanceof sync.SyncError && e.kind === 'auth') {
    sync.clearSession();
    showLogin(sync.describe(e));
  } else fail(sync.describe(e));
}

async function loadCatalog() {
  if (!shared()) return;
  try {
    catalog = await sync.listRoms();
    localStorage.setItem('wabgba.catalog', JSON.stringify(catalog));
    catalogLoaded = true;
    if (tab === 'play' && !hub.hidden && !busy) renderPlay();
  } catch (e) {
    catalogLoaded = true;
    if (e instanceof sync.SyncError && e.kind === 'auth') onCloudError(e);
  }
}

/** Baja una ROM de la biblioteca a este navegador y la arranca. */
async function downloadAndStart(rom: sync.RomInfo) {
  if (busy) return;
  busy = true;
  try {
    say(`Descargando ${rom.title}…`);
    const data = await sync.downloadRom(rom, (done, total) => {
      $('textbox-text').textContent = `Descargando ${rom.title}… ${Math.round((done / total) * 100)}%`;
    });
    const name = `${rom.id}.gba`;
    emu.FS.writeFile(`${emu.filePaths().gamePath}/${name}`, data);
    linkFile(rom.id, name);
    await persist();
    // Pedirle al navegador que no borre estos datos si falta espacio.
    void navigator.storage?.persist?.();
    busy = false;
    await startGame(name);
  } catch (e) {
    onCloudError(e);
  } finally {
    busy = false;
  }
}

/** Sube a la biblioteca una ROM que ya está en este navegador (cuenta administradora). */
async function publishRom(name: string) {
  if (busy) return;
  busy = true;
  try {
    const data = emu.FS.readFile(`${emu.filePaths().gamePath}/${name}`).slice();
    const id = await romIdOf(data, stem(name));
    if (!catalog.some((r) => r.id === id)) {
      say(`Subiendo ${stem(name)} a la biblioteca…`);
      await sync.uploadRom(id, stem(name), data, (done, total) => {
        $('textbox-text').textContent = `Subiendo ${stem(name)} a la biblioteca… ${Math.round((done / total) * 100)}%`;
      });
    }
    linkFile(id, name);
    catalog = await sync.listRoms();
    localStorage.setItem('wabgba.catalog', JSON.stringify(catalog));
    sfx('ok');
    busy = false;
    renderPlay();
    say(`¡Listo! ${stem(name)} ya está en la biblioteca: lo ven todos los participantes.`);
  } catch (e) {
    onCloudError(e);
  } finally {
    busy = false;
  }
}

interface Cart {
  title: string;
  /** Archivo en este navegador, si ya está descargada. */
  file: string | null;
  /** Entrada de la biblioteca, si viene de ahí. */
  rom: sync.RomInfo | null;
}

function carts(): Cart[] {
  const names = romNames();
  if (!shared()) return cloud ? [] : names.map((file) => ({ title: stem(file), file, rom: null }));
  const list: Cart[] = catalog.map((rom) => ({ title: rom.title, file: fileFor(rom), rom }));
  // La cuenta administradora ve también lo que tiene cargado y todavía no subió.
  if (isAdmin()) {
    const used = new Set(list.map((c) => c.file));
    for (const file of names) if (!used.has(file)) list.push({ title: stem(file), file, rom: null });
  }
  return list;
}

function renderPlay() {
  if (shared() && !catalogLoaded) void loadCatalog();
  const list = carts();
  const current = running ? activeRom() : null;
  const last = activeRom();
  $('btn-resume').hidden = !running;
  $('btn-export').hidden = !running;

  const nodes = list.map((c) => {
    const li = el('li', 'cart-wrap');
    const playing = !!c.file && c.file === current;
    const cart = el('button', 'cart' + (playing ? ' playing' : '') + (c.file ? '' : ' remote'));
    cart.append(el('span', 'label', c.title));
    if (playing) cart.append(el('span', 'tag', 'JUGANDO'));
    else if (!c.file) cart.append(el('span', 'tag get', '⬇ DESCARGAR'));
    else if (shared() && !c.rom) cart.append(el('span', 'tag warn', 'SIN SUBIR'));
    else if (c.file === last) cart.append(el('span', 'tag', 'ÚLTIMO'));
    cart.onclick = () => {
      if (playing) closeHub();
      else if (c.file) void startGame(c.file);
      else if (c.rom) void downloadAndStart(c.rom);
    };
    li.append(cart);

    if (canAdd()) {
      const del = el('button', 'del', '✕');
      del.title = c.rom ? 'Quitar de la biblioteca (para todos)' : 'Quitar la ROM de este navegador';
      del.onclick = async () => {
        const where = c.rom ? 'de la biblioteca, para todos los participantes' : 'de este navegador';
        if (!confirm(`¿Quitar "${c.title}" ${where}? Las partidas guardadas se conservan.`)) return;
        try {
          if (c.rom) {
            await sync.deleteRom(c.rom.id);
            catalog = catalog.filter((r) => r.id !== c.rom!.id);
            localStorage.setItem('wabgba.catalog', JSON.stringify(catalog));
          }
          if (c.file) {
            if (playing) await stopGame();
            dropFile(`${emu.filePaths().gamePath}/${c.file}`);
            await persist();
          }
          renderHub();
        } catch (e) {
          onCloudError(e);
        }
      };
      li.append(del);
    }
    if (shared() && isAdmin() && c.file && !c.rom) {
      const up = el('button', 'del up', '⬆');
      up.title = 'Subir a la biblioteca para todos';
      up.onclick = () => void publishRom(c.file!);
      li.append(up);
    }
    return li;
  });

  if (canAdd()) {
    const li = el('li');
    const add = el('button', 'cart empty', '+ AGREGAR ROM');
    add.onclick = () => fileRom.click();
    li.append(add);
    nodes.push(li);
  }
  romList.replaceChildren(...nodes);
  $('play-note').textContent = !cloud
    ? 'La ROM queda sólo en este navegador. La partida se guarda cuando guardás dentro del juego.'
    : isAdmin()
      ? 'Sos quien administra: las ROMs que subas a la biblioteca las ven todos los participantes.'
      : 'Los juegos los elige quien administra el sitio. La partida se guarda cuando guardás dentro del juego y viaja con tu cuenta.';

  if (busy) return;
  say(
    running
      ? 'El juego está en pausa. Volvé cuando quieras.'
      : cloud && !username()
        ? 'Entrá con tu cuenta para ver los juegos.'
        : list.length
          ? 'Elegí un cartucho para seguir tu aventura.'
          : canAdd()
            ? 'Agregá una ROM para empezar.'
            : 'Todavía no hay juegos. Quien administra el sitio tiene que subir uno.',
  );
}

// ----- Ficha de entrenador -----

function avatar(name: string, small = false): HTMLElement {
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  const node = el('span', 'avatar' + (small ? ' small' : ''), (name[0] ?? '?').toUpperCase());
  node.style.background = `hsl(${hash % 360} 62% 56%)`;
  return node;
}

function bar(current: number, goal: number, className = ''): HTMLElement {
  const node = el('div', 'bar ' + className);
  const fill = el('i');
  fill.style.width = `${Math.max(0, Math.min(1, goal ? current / goal : 0)) * 100}%`;
  node.append(fill);
  return node;
}

function gems(badges: boolean[], big = false): HTMLElement {
  const row = el('div', 'gems' + (big ? ' big' : ''));
  BADGES.forEach((name, i) => {
    const gem = el(big ? 'button' : 'i', `gem g${i + 1}` + (badges[i] ? ' on' : ''));
    gem.title = `Medalla ${name}`;
    if (big) {
      gem.onclick = () => {
        sfx('move');
        say(`Medalla ${name}: ${badges[i] ? '¡conseguida!' : 'todavía no la tenés.'}`);
      };
    }
    row.append(gem);
  });
  return row;
}

const playTime = (p: Progress) => `${p.hours}:${String(p.minutes).padStart(2, '0')} h`;

function trainerCard(name: string, p: Progress | null, emptyText: string): HTMLElement {
  const card = el('div', 'box trainer');
  const rank = rankFor(pointsFor(p));
  const who = el('div', 'who');
  who.append(el('b', '', name), el('span', 'rank', `NV ${rank.level} · ${rank.name.toUpperCase()}`));
  const xp = el('div', 'xp');
  xp.append(
    bar(rank.points - rank.floor, (rank.next ?? rank.points) - rank.floor || 1, 'gold'),
    el('span', '', rank.next ? `${rank.points} / ${rank.next} XP` : `${rank.points} XP`),
  );
  card.append(avatar(name), who, xp);
  if (p) {
    const stats = el('div', 'stats');
    stats.append(
      gems(p.badges),
      el('span', '', `📕 ${p.owned}`),
      el('span', '', `⏱ ${playTime(p)}`),
      el('span', '', `💪 Nv ${p.maxLevel}`),
    );
    card.append(stats);
  } else {
    card.append(el('p', 'stats empty', emptyText));
  }
  return card;
}

function myName(p: Progress | null): string {
  return username() || p?.name || 'Entrenador';
}

function emptyReason(save: SaveResult): string {
  if (save.ok) return '';
  return save.reason === 'unsupported'
    ? 'Por ahora las misiones sólo funcionan con Pokémon Rojo Fuego y Verde Hoja.'
    : 'Todavía no hay partida guardada. Guardá dentro del juego para empezar a sumar.';
}

// ----- Misiones -----

function missionCard(a: Achievement, p: Progress | null, state: 'now' | 'done'): HTMLElement {
  const node = el('div', 'mission ' + state);
  node.append(
    el('span', 'icon', a.icon),
    el('b', '', a.title),
    el('span', 'reward', state === 'done' ? '✔ HECHA' : `+${a.points} XP`),
    el('small', '', a.desc),
  );
  if (state === 'now' && a.progress && p) {
    const [cur, goal] = a.progress(p);
    node.append(bar(cur, goal));
  }
  return node;
}

function renderMissions() {
  const save = mySave();
  const p = save.ok ? save.progress : null;
  const root = $('tab-missions');
  const nodes: HTMLElement[] = [trainerCard(myName(p), p, emptyReason(save))];

  for (const chain of CHAINS) {
    const list = ACHIEVEMENTS.filter((a) => a.chain === chain.id);
    const done = list.map((a) => !!p && a.done(p));
    const count = done.filter(Boolean).length;
    const next = list.find((_, i) => !done[i]);

    const box = el('article', 'box chain' + (next ? '' : ' complete'));
    const head = el('header');
    const pips = el('div', 'pips');
    done.forEach((d) => pips.append(el('i', d ? 'on' : '')));
    head.append(el('h3', 'px-title', `${chain.icon} ${chain.title}`), pips, el('span', 'count', `${count}/${list.length}`));
    box.append(head);
    box.append(next ? missionCard(next, p, 'now') : missionCard(list[list.length - 1], p, 'done'));

    const all = el('details');
    all.append(el('summary', '', 'Ver toda la cadena'));
    const ol = el('ol');
    list.forEach((a, i) => {
      const li = el('li', done[i] ? 'done' : '', a.title);
      li.append(el('span', '', `${a.points} XP`));
      ol.append(li);
    });
    all.append(ol);
    box.append(all);
    nodes.push(box);
  }
  root.replaceChildren(...nodes);
  say(
    p
      ? 'Estas son tus misiones. Se revisan cada vez que guardás dentro del juego.'
      : 'Las misiones se activan con tu primera partida guardada.',
  );
}

// ----- Logros -----

function renderTrophies() {
  const save = mySave();
  const p = save.ok ? save.progress : null;
  const unlocked = loadUnlocked(myGameKey());
  const root = $('tab-trophies');
  const count = ACHIEVEMENTS.filter((a) => unlocked[a.id]).length;

  const tiles = el('div', 'tiles');
  for (const a of ACHIEVEMENTS) {
    const when = unlocked[a.id];
    const tile = el('button', 'tile' + (when ? ' done' : ''));
    tile.append(el('span', 'icon', a.icon), el('small', '', a.title));
    tile.onclick = () => {
      sfx('move');
      tiles.querySelector('.sel')?.classList.remove('sel');
      tile.classList.add('sel');
      let status = 'Todavía no lo tenés.';
      if (when) status = `¡Conseguido el ${new Date(when).toLocaleDateString()}!`;
      else if (a.progress && p) {
        const [cur, goal] = a.progress(p);
        status = `Vas ${Math.min(cur, goal).toLocaleString()} de ${goal.toLocaleString()}.`;
      }
      say(`${a.title} (+${a.points} XP). ${a.desc} ${status}`);
    };
    tiles.append(tile);
  }

  root.replaceChildren(
    el('h2', 'px-title', `Estuche de medallas`),
    gems(p?.badges ?? [], true),
    el('h2', 'px-title', `Logros · ${count} / ${ACHIEVEMENTS.length}`),
    tiles,
  );
  say(p ? 'Tocá un logro o una medalla para ver de qué se trata.' : emptyReason(save));
}

// ----- Participantes -----

let playersCache: sync.Player[] | null = null;
let playersError = '';
let playersLoading = false;

async function loadPlayers() {
  if (playersLoading) return;
  playersLoading = true;
  try {
    playersCache = await sync.players();
    playersError = '';
  } catch (e) {
    playersError = sync.describe(e);
  } finally {
    playersLoading = false;
  }
  if (tab === 'players' && !hub.hidden) renderPlayers();
}

function timeAgo(ms: number): string {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 2) return 'recién';
  if (min < 60) return `hace ${min} min`;
  if (min < 60 * 24) return `hace ${Math.round(min / 60)} h`;
  return `hace ${Math.round(min / 60 / 24)} d`;
}

function playerRow(player: sync.Player, pos: number, isMe: boolean): HTMLElement {
  const p = player.progress;
  const rank = rankFor(pointsFor(p));
  const row = el('button', 'box player' + (isMe ? ' me' : ''));
  const name = el('div', 'name');
  name.append(el('b', '', player.username));
  if (isMe) name.append(el('span', 'you', 'VOS'));
  const sub = el('div', 'sub');
  if (p) sub.append(gems(p.badges), el('span', '', `📕 ${p.owned}`), el('span', '', `⏱ ${playTime(p)}`));
  else sub.append(el('span', '', 'Sin partida todavía'));
  const pts = el('div', 'pts', `${rank.points} XP`);
  pts.append(el('small', '', rank.name.toUpperCase()));
  row.append(el('span', 'pos', `${pos}º`), avatar(player.username, true), name, pts, sub);
  row.onclick = () => {
    sfx('move');
    say(
      p
        ? `${player.username}, ${rank.name}. Juega como ${p.name || '???'}: ${p.badgeCount} ` +
            `${p.badgeCount === 1 ? 'medalla' : 'medallas'}, ${p.owned} en la Pokédex y su mejor Pokémon es nivel ` +
            `${p.maxLevel}.` +
            (player.savedAt ? ` Guardó ${timeAgo(player.savedAt)}.` : '')
        : `${player.username} todavía no guardó ninguna partida.`,
    );
  };
  return row;
}

function renderPlayers() {
  const root = $('tab-players');
  const save = mySave();
  const mine: sync.Player = { username: myName(save.ok ? save.progress : null), savedAt: null, progress: save.ok ? save.progress : null };

  if (!cloud || !username()) {
    root.replaceChildren(
      playerRow(mine, 1, true),
      el('p', 'note', cloud ? 'Entrá con tu cuenta para ver a los demás participantes.' : 'En este sitio no hay cuentas: sólo estás vos.'),
    );
    say('Acá aparece el progreso de todos los que juegan.');
    return;
  }

  if (!playersCache) {
    root.replaceChildren(el('p', 'note', playersError || 'Buscando participantes…'));
    if (!playersError) void loadPlayers();
    else say(playersError);
    return;
  }

  // Mi fila sale de la partida de este dispositivo, que es la más fresca.
  const list = playersCache
    .map((pl) => (pl.username === username() && mine.progress ? { ...pl, progress: mine.progress } : pl))
    .sort((a, b) => pointsFor(b.progress) - pointsFor(a.progress) || a.username.localeCompare(b.username));

  const head = el('div', 'who');
  const refresh = el('button', 'px-btn small ghost', '↻ ACTUALIZAR');
  refresh.onclick = () => {
    sfx('ok');
    playersCache = null;
    renderPlayers();
  };
  head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px';
  head.append(el('h2', 'px-title', `${list.length} ${list.length === 1 ? 'participante' : 'participantes'}`), refresh);

  root.replaceChildren(head, ...list.map((pl, i) => playerRow(pl, i + 1, pl.username === username())));
  say('El ranking se arma con la experiencia de cada partida. Tocá a alguien para ver cómo va.');
}

// ---------- Juego ----------

function addRom(file: File) {
  if (!canAdd()) return;
  say('Guardando el cartucho en el navegador…');
  emu.uploadRom(file, async () => {
    await persist();
    // Pedirle al navegador que no borre estos datos si falta espacio.
    void navigator.storage?.persist?.();
    renderHub();
    // Con cuentas, lo que carga quien administra va a la biblioteca de todos.
    if (shared()) void publishRom(file.name);
    else void startGame(file.name);
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

  if (user) say('Revisando la partida de tu cuenta…');
  const { forceUpload } = await syncBeforeLoad(name);

  const ok = emu.loadGame(romPath, savePathFor(name));
  if (!ok) {
    fail(`No se pudo abrir "${titleOf(name)}". ¿Es una ROM válida?`);
    return;
  }
  running = true;
  localStorage.setItem('wabgba.lastRom', name);
  // Subir lo que este dispositivo tenga pendiente.
  const st = sync.getState(gameCode);
  if (forceUpload || st.dirty || st.base === null) setTimeout(() => void syncUpload(forceUpload), 1000);
  setPaused(false);
  applySpeed();
  applyVolume();
  sfx('ok');
  setHub(false);
  document.title = `${titleOf(name)} · WabGBA`;
  canvas.focus();
  // Ponerse al día con lo que la partida ya tenía hecho.
  setTimeout(() => checkAchievements(true), 1500);
}

function setPaused(p: boolean) {
  paused = p;
  if (p) emu.pauseGame();
  else emu.resumeGame();
  btnPause.textContent = p ? '▶' : '⏸';
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
  setSfx(!muted);
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
    if (!loginPanel.hidden) return;

    // En el menú: izquierda y derecha cambian de pestaña, Escape vuelve al juego.
    if (!hub.hidden) {
      if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        const step = e.code === 'ArrowRight' ? 1 : -1;
        setTab(TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length]);
      } else if (e.code === 'Escape') closeHub();
      return;
    }

    if (!running) return;
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
    } else if (e.code === 'Escape') void openHub();
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
  for (const pad of document.querySelectorAll<HTMLElement>('.pad[data-btn]')) {
    const name = pad.dataset.btn!;
    const up = () => {
      pad.classList.remove('down');
      emu.buttonUnpress(name);
    };
    pad.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      pad.setPointerCapture(e.pointerId);
      pad.classList.add('down');
      emu.buttonPress(name);
    });
    pad.addEventListener('pointerup', up);
    pad.addEventListener('pointercancel', up);
    pad.addEventListener('contextmenu', (e) => e.preventDefault());
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

function setupUi() {
  // Barra del juego
  $('btn-menu').onclick = () => void openHub();
  btnPause.onclick = () => setPaused(!paused);
  btnSpeed.onclick = () => {
    speed = speed === 1 ? 2 : speed === 2 ? 4 : 1;
    applySpeed();
  };
  btnMute.onclick = () => {
    muted = !muted;
    applyVolume();
  };
  $('btn-full').onclick = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void $('player').requestFullscreen?.();
  };
  // Que los botones no se queden con el foco del teclado.
  for (const b of document.querySelectorAll<HTMLElement>('#toolbar button')) {
    b.addEventListener('click', () => b.blur());
  }

  // Menú
  for (const b of document.querySelectorAll<HTMLElement>('#tabs button')) {
    b.onclick = () => setTab(b.dataset.tab as Tab);
  }
  $('btn-resume').onclick = closeHub;
  $('btn-export').onclick = exportSave;
  $('btn-account').onclick = () => (sync.getSession() ? void logout() : showLogin());
  fileRom.onchange = () => {
    const f = fileRom.files?.[0];
    fileRom.value = '';
    if (f) addRom(f);
  };

  // Entrada
  $('login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    void submitLogin();
  });
  $('login-switch').onclick = () => {
    sfx('move');
    setRegisterMode(!registerMode);
  };
  $('login-skip').onclick = () => {
    sfx('back');
    hideLogin();
  };
  // Los botones de la consola dibujada también funcionan.
  $('deco-a').onclick = () => void submitLogin();
  $('deco-b').onclick = () => {
    sfx('back');
    const focused = document.activeElement;
    const field = focused instanceof HTMLInputElement ? focused : loginPass;
    field.value = '';
    field.focus();
  };
  for (const b of document.querySelectorAll<HTMLElement>('#deco-dpad button')) {
    b.onclick = () => {
      const fields = [loginUser, loginPass, loginInvite].filter((f) => f.offsetParent !== null);
      const at = fields.indexOf(document.activeElement as HTMLInputElement);
      const step = b.dataset.dir === 'down' ? 1 : -1;
      fields[(Math.max(at, 0) + step + fields.length) % fields.length].focus();
      sfx('move');
    };
  }
}

async function main() {
  say('Encendiendo la consola…');
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

  setupUi();
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

  const account = await sync.check();
  cloud = account !== 'none';
  setHub(true);
  if (account === 'out' || (account === 'offline' && !sync.getSession())) showLogin();
  console.log(`${emu.version.projectName} ${emu.version.projectVersion}`);
}

main().catch((e) => {
  console.error(e);
  fail('No se pudo iniciar el emulador: ' + (e instanceof Error ? e.message : String(e)));
});
