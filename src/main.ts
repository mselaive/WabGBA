import '@fontsource/press-start-2p';
import '@fontsource/pixelify-sans/400.css';
import '@fontsource/pixelify-sans/600.css';
import '@fontsource/pixelify-sans/700.css';
import mGBA, { type mGBAEmulator } from '@thenick775/mgba-wasm';
import {
  ACHIEVEMENTS,
  BADGES,
  GROUPS,
  evaluate,
  loadUnlocked,
  pointsFor,
  rankFor,
  type Death,
  type Run,
} from './achievements';
import * as controls from './controls';
import { findParty, readEnemies, readParty, readState, type Mon } from './party';
import { placeName } from './places';
import { readSave, readSavedMons, type Progress, type SaveResult } from './save';
import { setSfx, sfx } from './sfx';
import { speciesName } from './species';
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
    await noteSavedCatches();
    // Guardar puede haber anotado una medalla o un torneo.
    void loadFeed();
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
  releaseAll();
  loginUser.focus();
}

function hideLogin() {
  loginPanel.hidden = true;
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
    feedLoaded = false;
    void loadAccountData();
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
  applyRooms([]);
  renderHub();
  showLogin();
}

function renderAccount() {
  const session = sync.getSession();
  $('account-name').textContent = session ? session.username : '';
  $('btn-account').hidden = !cloud;
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

// ---------- Historial ----------
// Lo que va pasando en las partidas: bajas, medallas, torneos. Con cuentas vive en el
// servidor y lo ven todos; sin cuentas queda en este navegador.

type FeedItem = sync.GameEvent & {
  /** Captura guardada acá mismo (modo sin cuentas). */
  shot?: string;
};

let feed: sync.GameEvent[] = [];
let feedLoaded = false;
/** Vidas por participante; las define la cuenta administradora. */
let lives = 10;

const localEvents = () => loadJson<FeedItem[]>('wabgba.events', []);

/** El historial, de lo más nuevo a lo más viejo. */
const feedItems = (): FeedItem[] => (shared() ? feed : localEvents());

function deathsOf(user: string): Death[] {
  return feedItems()
    .filter((e) => e.type === 'death' && (e.username ?? '') === user)
    .map((e) => ({ at: e.at, badges: Number((e.data as { badges?: number }).badges ?? 0) }));
}

const myDeaths = () => deathsOf(username());

/** La partida activa más sus bajas: con esto se calculan logros y experiencia. */
function myRun(): Run | null {
  const save = mySave();
  return save.ok ? { p: save.progress, deaths: myDeaths() } : null;
}

interface EventText {
  icon: string;
  title: string;
  sub: string;
}

function describeEvent(e: FeedItem): EventText {
  const who = e.username || myName(null);
  if (e.type === 'death') {
    const d = e.data as unknown as sync.DeathData;
    const name = speciesName(d.species);
    const called = d.nickname && d.nickname.toLowerCase() !== name.toLowerCase() ? `${d.nickname} (${name})` : name;
    const versus = d.enemy
      ? ` · contra un ${speciesName(d.enemy.species)}${d.enemy.wild ? ' salvaje' : ''} nv ${d.enemy.level}`
      : '';
    const origin = placeName(d.met);
    return {
      icon: '💀',
      title: `${who} perdió a ${called}`,
      sub: `Nivel ${d.level}${versus}${d.poisoned ? ' · estaba envenenado' : ''}${origin ? ` · venía de ${origin}` : ''}`,
    };
  }
  if (e.type === 'catch') {
    const c = e.data as unknown as sync.CatchData;
    const name = speciesName(c.species);
    const called = c.nickname && c.nickname.toLowerCase() !== name.toLowerCase() ? `a ${c.nickname} (${name})` : `un ${name}`;
    const place = placeName(c.met);
    return {
      icon: '🔴',
      title: `${who} ${c.silent ? 'ya tenía' : 'atrapó'} ${called}`,
      sub: `Nivel ${c.level}${place ? ` · ${place}` : ''}${c.boxed ? ' · al PC' : ''}`,
    };
  }
  if (e.type === 'badge') {
    const n = Number((e.data as { n?: number }).n ?? 1);
    return { icon: '🏅', title: `${who} consiguió la Medalla ${BADGES[n - 1] ?? '?'}`, sub: `Va ${n} de 8.` };
  }
  if (e.type === 'champion') return { icon: '👑', title: `${who} venció a la Liga`, sub: '¡Campeón!' };
  const n = Number((e.data as { n?: number }).n ?? 0);
  return {
    icon: '⚔️',
    title: `¡Torneo de las ${n} medallas!`,
    sub: 'Ya llegaron todos. A pelear entre ustedes (por ahora, en Pokémon Showdown).',
  };
}

/** Reintenta las bajas que no llegaron al servidor (por ejemplo, sin conexión). */
async function flushPending() {
  const key = `wabgba.pending.${username()}`;
  const pending = loadJson<Parameters<typeof sync.reportDeath>[0][]>(key, []);
  if (!pending.length) return;
  const left: typeof pending = [];
  for (const death of pending) {
    try {
      await sync.reportDeath({ ...death, image: death.image ? new Uint8Array(Object.values(death.image)) : null });
    } catch {
      left.push(death);
    }
  }
  localStorage.setItem(key, JSON.stringify(left));
}

async function loadFeed() {
  if (!shared() || sync.getRoom() === null) return;
  try {
    await flushPending();
    const res = await sync.events();
    feed = res.events;
    lives = res.lives;
    feedLoaded = true;
    announceNew();
    announceAppeals();
    if (!hub.hidden && tab !== 'play') renderHub();
  } catch (e) {
    feedLoaded = true;
    if (e instanceof sync.SyncError && e.kind === 'auth') onCloudError(e);
  }
}

/** A quien administra: avisa una vez por cada pedido de anulación nuevo. */
function announceAppeals() {
  if (!canModerate()) return;
  const key = `wabgba.appeals.${username()}.${sync.getRoom()}`;
  const known = loadJson<number[]>(key, []);
  const waiting = feed.filter((e) => e.appeal?.status === 'pending');
  const fresh = waiting.filter((e) => !known.includes(e.id));
  localStorage.setItem(key, JSON.stringify(waiting.map((e) => e.id)));
  for (const e of fresh) {
    pop({
      icon: '🙋',
      label: 'PEDIDO DE ANULACIÓN',
      title: `${e.username} quiere anular una baja. Mirá el Historial.`,
      sound: 'ok',
    });
  }
}

/** Avisa de lo que pasó desde la última vez que se miró (lo de los demás). */
function announceNew() {
  const key = `wabgba.seen.${username()}.${sync.getRoom()}`;
  const seen = localStorage.getItem(key);
  const newest = feed.reduce((n, e) => Math.max(n, e.id), 0);
  localStorage.setItem(key, String(newest));
  if (seen === null) return; // primera vez: no repasar todo el pasado
  const fresh = feed
    .filter((e) => e.id > Number(seen) && e.username !== username() && !(e.data as { silent?: boolean }).silent)
    .reverse();
  for (const e of fresh.slice(-4)) {
    const text = describeEvent(e);
    pop({
      icon: text.icon,
      label: e.type === 'death' ? '¡BAJA!' : e.type === 'tournament' ? '¡TORNEO!' : e.type === 'catch' ? '¡CAPTURA!' : 'NOVEDAD',
      title: text.title,
      death: e.type === 'death',
      sound: e.type === 'death' ? 'error' : 'unlock',
    });
  }
}

// ---------- Avisos grandes ----------

interface Pop {
  icon: string;
  label: string;
  title: string;
  death?: boolean;
  /** Dirección de una captura para mostrar al lado. */
  shot?: string;
  sound: 'unlock' | 'error' | 'ok';
}

const popEl = $('achv-pop');
const popQueue: Pop[] = [];
let popBusy = false;

function showNextPop() {
  const next = popQueue.shift();
  if (!next) {
    popBusy = false;
    return;
  }
  popBusy = true;
  popEl.querySelector('.icon')!.textContent = next.icon;
  popEl.querySelector('small')!.textContent = next.label;
  popEl.querySelector('b')!.textContent = next.title;
  const shot = popEl.querySelector<HTMLImageElement>('.shot')!;
  shot.hidden = !next.shot;
  if (next.shot) shot.src = next.shot;
  popEl.classList.toggle('death', !!next.death);
  popEl.classList.add('show');
  sfx(next.sound);
  setTimeout(
    () => {
      popEl.classList.remove('show');
      setTimeout(showNextPop, 450);
    },
    next.death ? 5000 : 3500,
  );
}

function pop(item: Pop) {
  popQueue.push(item);
  if (!popBusy) showNextPop();
}

/** Lee la partida y desbloquea lo que corresponda. `quiet`: sin desfile de avisos. */
function checkAchievements(quiet: boolean) {
  const run = myRun();
  const key = myGameKey();
  if (!run || !key) return;
  const fresh = evaluate(key, run);
  if (!fresh.length || quiet) return;
  if (fresh.length > 3) {
    toast(`🏆 ${fresh.length} logros desbloqueados`);
    sfx('unlock');
    return;
  }
  for (const a of fresh) {
    pop({
      icon: a.icon,
      label: '¡LOGRO DESBLOQUEADO!',
      title: a.points ? `${a.title}  +${a.points} XP` : a.title,
      sound: 'unlock',
    });
  }
}

// ---------- Detector de bajas ----------
// Cada pocos segundos se le pide al emulador una foto de la consola y se mira el equipo:
// si un Pokémon que tenía vida pasa a 0 PS, es una baja. Sólo cuentan los cambios vistos
// en vivo, así un Pokémon que ya venía debilitado de antes no se anota de golpe.

const WATCH_EVERY = 3000;
let partyBase: number | null = null;
const lastHp = new Map<string, number>();
let watching = false;
let lastPersist = 0;
/** Si sacar la foto sale caro en este dispositivo, se espacia. */
let watchSkip = 0;

const deadKey = () => `wabgba.dead.${username()}.${gameCode}`;
/** Los Pokémon que ya se sabe que esta cuenta tiene en este juego. */
const caughtKey = () => `wabgba.caught.${username()}.${gameCode}`;

function resetWatch() {
  partyBase = null;
  lastHp.clear();
}

function watchTick() {
  if (!running || paused || !hub.hidden || document.visibilityState !== 'visible') return;
  if (watchSkip > 0) {
    watchSkip--;
    return;
  }
  const t0 = performance.now();
  if (!emu.forceAutoSaveState()) return;
  const cost = performance.now() - t0;
  if (cost > 30) watchSkip = cost > 60 ? 3 : 1;
  void inspectState();
}

/** Mira la última foto de la consola en busca de bajas. */
async function inspectState() {
  // La foto es también el punto de reanudación: se vuelca al navegador cada tanto.
  if (Date.now() - lastPersist > 30_000) {
    lastPersist = Date.now();
    void persist();
  }
  if (!running || watching) return;
  watching = true;
  try {
    const state = emu.getAutoSaveState();
    const snap = state ? await readState(state.data) : null;
    if (!snap) return;
    const found = findParty(snap.ram, partyBase);
    // Si el equipo aparece en otro lugar, lo anotado antes ya no sirve para comparar.
    if (found !== partyBase) lastHp.clear();
    partyBase = found;
    if (partyBase === null) {
      lastHp.clear();
      return;
    }
    const dead = loadJson<string[]>(deadKey(), []);
    const party = readParty(snap.ram, partyBase);
    await noteCatches(party, false, snap.image);
    for (const mon of party) {
      const before = lastHp.get(mon.key);
      lastHp.set(mon.key, mon.hp);
      if (mon.hp > 0 || !before || dead.includes(mon.key)) continue;
      dead.push(mon.key);
      localStorage.setItem(deadKey(), JSON.stringify(dead));
      await onDeath(mon, readEnemies(snap.ram, partyBase), snap.image);
    }
  } catch (e) {
    console.error('No se pudo revisar el equipo', e);
  } finally {
    watching = false;
  }
}

// ---------- Capturas ----------
// Un Pokémon que aparece en el equipo y no estaba anotado es una captura (o un regalo, o un
// intercambio). Los que van directo al PC se ven recién al guardar, leyendo las cajas.

let notingCatches = false;

async function noteCatches(mons: Mon[], boxed: boolean, image: Uint8Array | null) {
  if (!shared() || !gameCode || notingCatches) return;
  const known = loadJson<string[] | null>(caughtKey(), null);
  const fresh = mons.filter((m) => !m.egg && !known?.includes(m.key));
  if (!fresh.length) {
    if (known === null && mons.length) localStorage.setItem(caughtKey(), '[]');
    return;
  }
  // La primera vez en este dispositivo se anota lo que ya había sin anunciarlo, salvo que
  // sea el inicial recién elegido.
  const starter = !boxed && mons.length === 1 && mons[0].level <= 5;
  const silent = known === null && !starter;
  notingCatches = true;
  try {
    const list = known ?? [];
    // Al anotar por primera vez, también lo que ya estaba guardado en el PC.
    const stored = silent && !boxed ? (readSavedMons(emu.getSave())?.boxed ?? []).filter((m) => !m.egg) : [];
    for (const mon of stored) {
      if (list.includes(mon.key)) continue;
      await sync.reportCatch({
        game: gameCode,
        mon: { key: mon.key, species: mon.species, level: mon.metLevel || 1, nickname: mon.nickname, met: mon.met },
        boxed: true,
        silent: true,
        image: null,
      });
      list.push(mon.key);
    }
    for (const mon of fresh) {
      const isNew = await sync.reportCatch({
        game: gameCode,
        mon: { key: mon.key, species: mon.species, level: mon.level || mon.metLevel || 1, nickname: mon.nickname, met: mon.met },
        boxed,
        silent,
        image: silent ? null : image,
      });
      list.push(mon.key);
      localStorage.setItem(caughtKey(), JSON.stringify(list));
      if (isNew && !silent) {
        const name = speciesName(mon.species);
        const place = placeName(mon.met);
        pop({
          icon: '🔴',
          label: boxed ? '¡CAPTURA! (AL PC)' : '¡CAPTURA!',
          title: `${name}${place ? ` · ${place}` : ''}`,
          shot: image ? URL.createObjectURL(new Blob([image.slice()], { type: 'image/png' })) : undefined,
          sound: 'unlock',
        });
      }
    }
    void loadFeed();
  } catch {
    /* sin conexión: quedan sin anotar y se reintenta en la próxima revisión */
  } finally {
    notingCatches = false;
  }
}

/** Al guardar: repasa el equipo y las cajas del PC de la partida guardada. */
async function noteSavedCatches() {
  const saved = running ? readSavedMons(emu.getSave()) : null;
  if (!saved) return;
  // Si nunca se anotó nada acá, primero el equipo: así el resto entra como "ya lo tenía".
  await noteCatches(saved.party, false, null);
  await noteCatches(saved.boxed, true, null);
}

async function onDeath(mon: Mon, enemies: Mon[], image: Uint8Array) {
  const foe = enemies.find((e) => e.hp > 0) ?? enemies[0] ?? null;
  // Los salvajes llevan el mismo "entrenador original" que el jugador; los de entrenador, no.
  const enemy = foe ? { species: foe.species, level: foe.level, wild: foe.otId === mon.otId } : null;
  const save = mySave();
  const death = {
    game: gameCode,
    mon: { key: mon.key, species: mon.species, level: mon.level, nickname: mon.nickname, met: mon.met },
    enemy,
    poisoned: mon.poisoned,
    badges: save.ok ? save.progress.badgeCount : 0,
    image,
  };
  const shot = URL.createObjectURL(new Blob([image.slice()], { type: 'image/png' }));
  const name = speciesName(mon.species);
  pop({
    icon: '💀',
    label: '¡BAJA!',
    title: `${mon.nickname || name} cayó${enemy ? ` contra un ${speciesName(enemy.species)}` : ''}`,
    death: true,
    shot,
    sound: 'error',
  });

  if (shared()) {
    try {
      await sync.reportDeath(death);
    } catch {
      // Sin conexión: queda en cola y se manda cuando vuelva.
      const key = `wabgba.pending.${username()}`;
      localStorage.setItem(key, JSON.stringify([...loadJson<unknown[]>(key, []), { ...death, image: [...image] }]));
    }
    playersCache = null;
    await loadFeed();
  } else {
    const data: sync.DeathData = {
      game: death.game,
      species: mon.species,
      level: mon.level,
      nickname: mon.nickname,
      enemy,
      poisoned: mon.poisoned,
      badges: death.badges,
      met: mon.met,
    };
    const item: FeedItem = {
      id: Date.now(),
      username: null,
      type: 'death',
      at: Date.now(),
      data: data as unknown as Record<string, unknown>,
      image: false,
      shot: await blobToDataUrl(new Blob([image.slice()], { type: 'image/png' })),
    };
    localStorage.setItem('wabgba.events', JSON.stringify([item, ...localEvents()].slice(0, 60)));
  }
  checkAchievements(false);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

// ---------- Menú ----------

type Tab = 'play' | 'feed' | 'trophies' | 'players';
const TABS: Tab[] = ['play', 'feed', 'trophies', 'players'];
let tab: Tab = 'play';

function setHub(open: boolean) {
  hub.hidden = !open;
  if (running) {
    if (open) emu.pauseGame();
    else if (!paused) emu.resumeGame();
  }
  if (open) releaseAll();
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
  else if (tab === 'feed') renderFeed();
  else if (tab === 'trophies') renderTrophies();
  else renderPlayers();
}

// ----- Jugar -----

// La biblioteca del sitio: las ROMs que subió la cuenta administradora. Los demás sólo
// las descargan. Sin servidor de cuentas (`npm run dev`) cada uno carga las suyas.

let catalog: sync.RomInfo[] = [];
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
const canAdd = () => !cloud || (isAdmin() && sync.getRoom() !== null);

// ----- Salas -----
// Cada sala es un grupo aparte: sus ROMs, su historial, sus vidas y su líder. Quien
// administra el sitio las crea y está en todas; el resto entra con el código de la suya.

let rooms: sync.RoomInfo[] = [];
let roomsLoaded = false;

const roomKey = () => `wabgba.room.${username()}`;
const catalogKey = () => `wabgba.catalog.${sync.getRoom() ?? 0}`;
const currentRoom = () => rooms.find((r) => r.id === sync.getRoom()) ?? null;
/** Esta cuenta decide las reglas y las anulaciones de la sala actual (líder o administración). */
const canModerate = () => shared() && !!currentRoom()?.moderator;

/** Guarda la lista de salas y se para en una: la pedida, la de la última vez o la primera. */
function applyRooms(list: sync.RoomInfo[], prefer?: number | null) {
  rooms = list;
  const stored = Number(localStorage.getItem(roomKey()));
  const pick = rooms.find((r) => r.id === prefer) ?? rooms.find((r) => r.id === stored) ?? rooms[0] ?? null;
  sync.setRoom(pick?.id ?? null);
  if (pick) {
    localStorage.setItem(roomKey(), String(pick.id));
    lives = pick.lives;
  }
  // Todo lo que se muestra depende de la sala: se vuelve a pedir.
  catalog = pick ? loadJson<sync.RomInfo[]>(catalogKey(), []) : [];
  catalogLoaded = false;
  feed = [];
  feedLoaded = false;
  playersCache = null;
  renderRoomSelect();
}

async function loadRooms(prefer?: number | null) {
  if (!shared()) return;
  try {
    applyRooms(await sync.listRooms(), prefer);
    roomsLoaded = true;
  } catch (e) {
    if (e instanceof sync.SyncError && e.kind === 'auth') onCloudError(e);
  }
}

async function switchRoom(id: number) {
  if (id === sync.getRoom()) return;
  // El juego abierto es de la sala anterior.
  await stopGame();
  applyRooms(rooms, id);
  sfx('ok');
  toast(`Sala: ${currentRoom()?.name ?? ''}`);
  renderHub();
  void loadFeed();
}

function renderRoomSelect() {
  const select = $<HTMLSelectElement>('room-select');
  select.hidden = !shared() || rooms.length < 2;
  select.replaceChildren(
    ...rooms.map((room) => {
      const option = el('option', '', room.name);
      option.value = String(room.id);
      return option;
    }),
  );
  select.value = String(sync.getRoom() ?? '');
}

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
  if (!shared() || sync.getRoom() === null) return;
  try {
    catalog = await sync.listRoms();
    localStorage.setItem(catalogKey(), JSON.stringify(catalog));
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
    localStorage.setItem(catalogKey(), JSON.stringify(catalog));
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
  $('btn-reset').hidden = !last || (cloud && !username());

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
            localStorage.setItem(catalogKey(), JSON.stringify(catalog));
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
      ? `Sos quien administra: las ROMs que subas van a la sala «${currentRoom()?.name ?? '…'}» y las ven sus participantes.`
      : 'Los juegos los elige quien administra el sitio. La partida se guarda cuando guardás dentro del juego y viaja con tu cuenta.';

  if (busy) return;
  say(
    running
      ? 'El juego está en pausa. Volvé cuando quieras.'
      : cloud && !username()
        ? 'Entrá con tu cuenta para ver los juegos.'
        : shared() && roomsLoaded && !rooms.length
          ? 'No estás en ninguna sala. Pedí un código y unite desde ⚙.'
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

/** Las vidas que le quedan a alguien que ya perdió `deaths` Pokémon. */
function hearts(deaths: number): HTMLElement {
  const left = lives - deaths;
  if (left <= 0) return el('span', 'lives out', '☠ SIN VIDAS');
  const row = el('span', 'lives');
  if (lives <= 12) for (let i = 0; i < lives; i++) row.append(el('i', i < left ? '' : 'lost', '♥'));
  else row.append(el('i', '', '♥'), ` ${left}/${lives}`);
  row.title = `${left} de ${lives} vidas`;
  return row;
}

const playTime = (p: Progress) => `${p.hours}:${String(p.minutes).padStart(2, '0')} h`;

function trainerCard(name: string, run: Run | null, deaths: number, emptyText: string): HTMLElement {
  const card = el('div', 'box trainer');
  const rank = rankFor(pointsFor(run));
  const who = el('div', 'who');
  who.append(el('b', '', name), el('span', 'rank', `NV ${rank.level} · ${rank.name.toUpperCase()}`));
  const xp = el('div', 'xp');
  xp.append(
    bar(rank.points - rank.floor, (rank.next ?? rank.points) - rank.floor || 1, 'gold'),
    el('span', '', rank.next ? `${rank.points} / ${rank.next} XP` : `${rank.points} XP`),
  );
  card.append(avatar(name), who, xp);
  const stats = el('div', 'stats');
  if (run) {
    const p = run.p;
    stats.append(gems(p.badges), el('span', '', `📕 ${p.owned}`), el('span', '', `⏱ ${playTime(p)}`), el('span', '', `💪 Nv ${p.maxLevel}`));
  } else {
    stats.append(el('span', '', emptyText));
  }
  stats.append(hearts(deaths));
  card.append(stats);
  return card;
}

function myName(p: Progress | null): string {
  return username() || p?.name || 'Entrenador';
}

function emptyReason(save: SaveResult): string {
  if (save.ok) return '';
  return save.reason === 'unsupported'
    ? 'Por ahora los logros sólo funcionan con Pokémon Rojo Fuego y Verde Hoja.'
    : 'Todavía no hay partida guardada. Guardá dentro del juego para empezar a sumar.';
}

function timeAgo(ms: number): string {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 2) return 'recién';
  if (min < 60) return `hace ${min} min`;
  if (min < 60 * 24) return `hace ${Math.round(min / 60)} h`;
  return `hace ${Math.round(min / 60 / 24)} d`;
}

// ----- Historial -----

/** Capturas ya bajadas del servidor, por id de evento. */
const shots = new Map<number, string>();

function eventCard(e: FeedItem): HTMLElement {
  const text = describeEvent(e);
  const card = el('article', `box event ${e.type}`);
  card.append(el('span', 'icon', text.icon), el('b', '', text.title), el('span', 'when', timeAgo(e.at)), el('small', '', text.sub));

  const act = (label: string, run: () => Promise<void>, ask?: string) => {
    const button = el('button', 'link dark', label);
    button.onclick = async () => {
      if (ask && !confirm(ask)) return;
      try {
        await run();
        playersCache = null;
        await loadFeed();
        renderHub();
      } catch (err) {
        onCloudError(err);
      }
    };
    return button;
  };
  const actions = el('div', 'undo');
  const pending = e.appeal?.status === 'pending';

  if (!shared()) {
    // Sin cuentas no hay a quién pedirle permiso: se anula directo.
    actions.append(
      act(
        'Anular',
        async () => localStorage.setItem('wabgba.events', JSON.stringify(localEvents().filter((x) => x.id !== e.id))),
        `¿Anular "${text.title}"?`,
      ),
    );
  } else if (canModerate()) {
    // El líder de la sala decide: aprueba o rechaza un pedido, o anula por su cuenta.
    if (pending) {
      actions.append(
        act('✔ Aprobar', () => sync.deleteEvent(e.id), `¿Aprobar el pedido y anular "${text.title}"?`),
        act('✖ Rechazar', () => sync.rejectAppeal(e.id)),
      );
    } else {
      actions.append(
        act('Anular', () => sync.deleteEvent(e.id), `¿Anular "${text.title}"? Deja de contar para las vidas y los logros.`),
      );
    }
  } else if (e.username === username() && e.type === 'death' && !e.appeal) {
    // El resto sólo puede pedirlo, y sólo por sus propias bajas.
    const ask = el('button', 'link dark', 'Pedir anulación');
    ask.onclick = async () => {
      const reason = prompt('¿Por qué habría que anularla? Lo va a leer quien administra.');
      if (reason === null) return;
      try {
        await sync.appealEvent(e.id, reason);
        toast('Pedido enviado. Queda en revisión.');
        await loadFeed();
        renderHub();
      } catch (err) {
        onCloudError(err);
      }
    };
    actions.append(ask);
  }
  if (actions.childElementCount) card.append(actions);

  if (e.appeal) {
    const reason = e.appeal.reason ? `: «${e.appeal.reason}»` : '';
    card.append(
      el(
        'p',
        'appeal ' + e.appeal.status,
        pending ? `🙋 Anulación pedida${reason} · en revisión` : '🚫 Se pidió anularla y fue rechazada.',
      ),
    );
  }

  if (e.shot || e.image) {
    const img = el('img', 'shot');
    img.alt = 'El momento';
    if (e.shot) img.src = e.shot;
    else if (shots.has(e.id)) img.src = shots.get(e.id)!;
    else {
      void sync.eventImage(e.id).then((url) => {
        if (!url) return;
        shots.set(e.id, url);
        img.src = url;
      });
    }
    card.append(img);
  }
  return card;
}

function renderFeed() {
  const root = $('tab-feed');
  if (shared() && !feedLoaded) {
    root.replaceChildren(el('p', 'note', 'Buscando novedades…'));
    void loadFeed();
    return;
  }
  // Lo que ya se tenía de antes queda anotado, pero no se lista.
  const items = feedItems().filter((e) => !(e.data as { silent?: boolean }).silent);
  const deaths = myDeaths().length;
  const mine = el('div', 'box');
  const head = el('div', 'who');
  head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap';
  head.append(el('h3', 'px-title', 'Tus vidas'), hearts(deaths));
  mine.append(head);

  root.replaceChildren(
    mine,
    ...(items.length
      ? items.map(eventCard)
      : [el('p', 'note', 'Todavía no pasó nada. Acá van a aparecer las capturas, las bajas, las medallas y los torneos.')]),
  );
  say(
    deaths
      ? `Llevás ${deaths} ${deaths === 1 ? 'baja' : 'bajas'}. Que no se repita.`
      : 'Sin bajas por ahora. Las que haya van a quedar acá, con foto.',
  );
}

// ----- Logros -----

function renderTrophies() {
  const save = mySave();
  const run = myRun();
  const unlocked = loadUnlocked(myGameKey());
  const root = $('tab-trophies');
  const count = ACHIEVEMENTS.filter((a) => unlocked[a.id]).length;

  const nodes: HTMLElement[] = [
    trainerCard(myName(run?.p ?? null), run, myDeaths().length, emptyReason(save)),
    gems(run?.p.badges ?? [], true),
  ];
  for (const group of GROUPS) {
    const tiles = el('div', 'tiles');
    for (const a of ACHIEVEMENTS.filter((x) => x.group === group.id)) {
      const when = unlocked[a.id];
      const tile = el('button', 'tile' + (when ? ' done' : ''));
      tile.append(el('span', 'icon', a.icon), el('small', '', a.title));
      tile.onclick = () => {
        sfx('move');
        root.querySelector('.sel')?.classList.remove('sel');
        tile.classList.add('sel');
        let status = 'Todavía no lo tenés.';
        if (when) status = `¡Conseguido el ${new Date(when).toLocaleDateString()}!`;
        else if (a.progress && run) {
          const [cur, goal] = a.progress(run);
          status = `Vas ${Math.min(cur, goal).toLocaleString()} de ${goal.toLocaleString()}.`;
        }
        say(`${a.title}${a.points ? ` (+${a.points} XP)` : ''}. ${a.desc} ${status}`);
      };
      tiles.append(tile);
    }
    nodes.push(el('h2', 'px-title', group.title), tiles);
  }
  root.replaceChildren(...nodes);
  say(run ? `Tenés ${count} de ${ACHIEVEMENTS.length} logros. Tocá uno para ver de qué se trata.` : emptyReason(save));
}

// ----- Participantes -----

let playersCache: sync.Player[] | null = null;
let playersError = '';
let playersLoading = false;

async function loadPlayers() {
  if (playersLoading || sync.getRoom() === null) return;
  playersLoading = true;
  try {
    const res = await sync.players();
    playersCache = res.players;
    lives = res.lives;
    playersError = '';
  } catch (e) {
    playersError = sync.describe(e);
  } finally {
    playersLoading = false;
  }
  if (tab === 'players' && !hub.hidden) renderPlayers();
}

/** La partida de un participante con sus bajas, para calcularle la experiencia. */
const runOf = (pl: sync.Player): Run | null => (pl.progress ? { p: pl.progress, deaths: deathsOf(pl.username) } : null);

function playerRow(player: sync.Player, pos: number, isMe: boolean): HTMLElement {
  const p = player.progress;
  const rank = rankFor(pointsFor(runOf(player)));
  const row = el('button', 'box player' + (isMe ? ' me' : ''));
  const name = el('div', 'name');
  name.append(el('b', '', player.username));
  if (isMe) name.append(el('span', 'you', 'VOS'));
  const sub = el('div', 'sub');
  if (p) sub.append(gems(p.badges), el('span', '', `📕 ${p.owned}`), el('span', '', `⏱ ${playTime(p)}`));
  else sub.append(el('span', '', 'Sin partida todavía'));
  sub.append(hearts(player.deaths));
  const pts = el('div', 'pts', `${rank.points} XP`);
  pts.append(el('small', '', rank.name.toUpperCase()));
  row.append(el('span', 'pos', `${pos}º`), avatar(player.username, true), name, pts, sub);
  row.onclick = () => {
    sfx('move');
    const left = lives - player.deaths;
    const fate = left > 0 ? `Le quedan ${left} de ${lives} vidas.` : 'Se quedó sin vidas.';
    say(
      p
        ? `${player.username}, ${rank.name}. Juega como ${p.name || '???'}: ${p.badgeCount} ` +
            `${p.badgeCount === 1 ? 'medalla' : 'medallas'}, ${p.owned} en la Pokédex y su mejor Pokémon es nivel ` +
            `${p.maxLevel}. ${fate}` +
            (player.savedAt ? ` Guardó ${timeAgo(player.savedAt)}.` : '')
        : `${player.username} todavía no guardó ninguna partida.`,
    );
  };
  return row;
}

function renderPlayers() {
  const root = $('tab-players');
  const run = myRun();
  const mine: sync.Player = {
    username: myName(run?.p ?? null),
    savedAt: null,
    progress: run?.p ?? null,
    deaths: myDeaths().length,
  };

  if (!shared()) {
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
  if (!feedLoaded) void loadFeed();

  // Mi fila sale de la partida de este dispositivo, que es la más fresca.
  const list = playersCache
    .map((pl) => (pl.username === username() && mine.progress ? { ...pl, progress: mine.progress } : pl))
    .sort((a, b) => pointsFor(runOf(b)) - pointsFor(runOf(a)) || a.username.localeCompare(b.username));

  const head = el('div', 'who');
  const refresh = el('button', 'px-btn small ghost', '↻ ACTUALIZAR');
  refresh.onclick = () => {
    sfx('ok');
    playersCache = null;
    void loadFeed();
    renderPlayers();
  };
  head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px';
  head.append(el('h2', 'px-title', `${list.length} ${list.length === 1 ? 'participante' : 'participantes'}`), refresh);

  root.replaceChildren(head, ...list.map((pl, i) => playerRow(pl, i + 1, pl.username === username())));
  say('El ranking se arma con la experiencia de cada partida. Tocá a alguien para ver cómo va.');
}

// ---------- Ajustes ----------

const settingsPanel = $('settings');
let bindings = controls.load();
/** La acción que está esperando que se apriete una tecla. */
let listening: controls.Action | null = null;

function renderBindings() {
  $('bindings').replaceChildren(
    ...controls.ACTIONS.map((action) => {
      const row = el('button', 'binding' + (listening === action ? ' listening' : ''));
      row.type = 'button';
      row.append(
        el('span', '', controls.LABELS[action]),
        el('kbd', '', listening === action ? '…' : controls.keyLabel(bindings[action])),
      );
      row.onclick = () => {
        sfx('move');
        listening = listening === action ? null : action;
        renderBindings();
        row.blur();
      };
      return row;
    }),
  );
}

function saveBindings() {
  controls.store(bindings);
  // Con cuenta, los controles viajan a los otros dispositivos.
  if (shared()) void sync.savePrefs({ controls: bindings }).catch(() => undefined);
}

function setBinding(action: controls.Action, code: string) {
  // Si la tecla ya estaba en otra acción, se intercambian.
  for (const other of controls.ACTIONS) {
    if (other !== action && bindings[other] === code) bindings[other] = bindings[action];
  }
  bindings[action] = code;
  listening = null;
  saveBindings();
  sfx('ok');
  renderBindings();
}

/** Estado del bloque de salas en Ajustes. */
function roomsStatus(text: string, bad = false) {
  $('rooms-status').textContent = text;
  if (text) sfx(bad ? 'error' : 'ok');
}

function renderRooms() {
  $('rooms-list').replaceChildren(
    ...rooms.map((room) => {
      const current = room.id === sync.getRoom();
      const row = el('div', 'room-row' + (current ? ' on' : ''));
      const name = el('button', 'room-name', room.name + (current ? '  ·  ACTUAL' : ''));
      name.type = 'button';
      name.title = 'Pasar a esta sala';
      name.onclick = async () => {
        await switchRoom(room.id);
        renderRooms();
        void showRules();
      };
      const facts = [`Líder: ${room.leader ?? 'sin líder'}`, `${room.lives} vidas`];
      if (room.code) facts.unshift(`Código: ${room.code}`);
      row.append(name, el('small', '', facts.join('  ·  ')));

      // Sólo quien administra el sitio nombra al líder.
      if (isAdmin()) {
        const line = el('div', 'row');
        const input = el('input');
        input.placeholder = 'Usuario del líder (vacío: sin líder)';
        input.value = room.leader ?? '';
        input.autocapitalize = 'none';
        input.spellcheck = false;
        const set = el('button', 'px-btn small', 'NOMBRAR LÍDER');
        set.type = 'button';
        set.onclick = async () => {
          try {
            applyRooms(await sync.updateRoom(room.id, { leader: input.value }), sync.getRoom());
            renderRooms();
            roomsStatus(input.value.trim() ? `${input.value.trim()} ahora lidera ${room.name}.` : `${room.name} quedó sin líder.`);
          } catch (e) {
            roomsStatus(sync.describe(e), true);
          }
        };
        line.append(input, set);

        // Puede administrar la sala sin jugar en ella: así no figura entre los participantes.
        const part = el('div', 'row');
        const toggle = el('button', 'px-btn small', room.member ? 'DEJAR DE PARTICIPAR' : 'PARTICIPAR YO TAMBIÉN');
        toggle.type = 'button';
        toggle.onclick = async () => {
          try {
            applyRooms(await sync.updateRoom(room.id, { member: !room.member }), sync.getRoom());
            renderRooms();
            roomsStatus(
              room.member
                ? `Ya no figurás como participante de ${room.name}. La seguís administrando.`
                : `Ahora participás en ${room.name}.`,
            );
          } catch (e) {
            roomsStatus(sync.describe(e), true);
          }
        };
        part.append(el('small', '', room.member ? 'Participás en esta sala.' : 'No participás: sólo la administrás.'), toggle);
        row.append(line, part);
      }
      return row;
    }),
  );
}

async function joinRoomByCode() {
  const input = $<HTMLInputElement>('join-code');
  if (!input.value.trim()) return;
  try {
    const res = await sync.joinRoom(input.value);
    await stopGame();
    applyRooms(res.rooms, res.joined);
    roomsLoaded = true;
    input.value = '';
    renderRooms();
    void showRules();
    void loadFeed();
    roomsStatus(`¡Listo! Estás en ${currentRoom()?.name ?? 'la sala'}.`);
  } catch (e) {
    roomsStatus(sync.describe(e), true);
  }
}

async function createRoom() {
  const name = $<HTMLInputElement>('new-room-name');
  const code = $<HTMLInputElement>('new-room-code');
  try {
    const res = await sync.createRoom(name.value, code.value);
    await stopGame();
    applyRooms(res.rooms, res.created);
    name.value = '';
    code.value = '';
    renderRooms();
    void showRules();
    roomsStatus(
      `Sala creada. Ya estás parado en ${currentRoom()?.name ?? 'ella'}: subile su ROM desde JUGAR. No figurás como participante salvo que lo pidas.`,
    );
  } catch (e) {
    roomsStatus(sync.describe(e), true);
  }
}

/** Muestra las reglas de la sala actual a quien puede cambiarlas. */
async function showRules() {
  const room = currentRoom();
  const allowed = canModerate() && !!room;
  $('admin').hidden = !allowed;
  $('set-status').textContent = '';
  if (!allowed) return;
  $('admin-title').textContent = `Reglas de ${room.name}`;
  try {
    const rules = await sync.getSettings();
    lives = rules.lives;
    $<HTMLInputElement>('set-lives').value = String(rules.lives);
    $<HTMLInputElement>('set-webhook').value = rules.webhook ?? '';
  } catch (e) {
    $('set-status').textContent = sync.describe(e);
  }
}

async function openSettings() {
  sfx('ok');
  listening = null;
  renderBindings();
  $('rooms-box').hidden = !shared();
  $('room-create').hidden = !isAdmin();
  $('rooms-status').textContent = '';
  renderRooms();
  settingsPanel.hidden = false;
  await showRules();
}

function closeSettings() {
  sfx('back');
  listening = null;
  settingsPanel.hidden = true;
  if (!hub.hidden) renderHub();
}

async function saveRules() {
  const status = $('set-status');
  const value = Number($<HTMLInputElement>('set-lives').value);
  const webhook = $<HTMLInputElement>('set-webhook').value.trim();
  if (!Number.isInteger(value) || value < 1 || value > 99) {
    status.textContent = 'Las vidas tienen que ser un número entre 1 y 99.';
    sfx('error');
    return;
  }
  status.textContent = 'Guardando…';
  try {
    await sync.saveSettings(value, webhook);
    lives = value;
    playersCache = null;
    const room = currentRoom();
    if (room) room.lives = value;
    renderRooms();
    status.textContent = webhook ? '¡Guardado! Si el webhook es nuevo, ya debería haber llegado un mensaje al canal.' : '¡Guardado!';
    sfx('ok');
  } catch (e) {
    status.textContent = sync.describe(e);
    sfx('error');
  }
}

/** Trae lo que depende de la cuenta: controles guardados e historial. */
async function loadAccountData() {
  if (!shared()) return;
  await loadRooms();
  if (!hub.hidden) renderHub();
  try {
    const prefs = await sync.getPrefs();
    if (prefs.controls) {
      bindings = controls.normalize(prefs.controls);
      controls.store(bindings);
    }
  } catch {
    /* sin conexión: quedan los controles de este dispositivo */
  }
  await loadFeed();
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
  resetWatch();
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

/** Empezar de cero: borra la partida (acá y en la cuenta), sus bajas y sus logros, y arranca el juego. */
async function resetRun() {
  const rom = activeRom();
  if (!rom || busy) return;
  const title = titleOf(rom);
  if (
    !confirm(
      `¿Reiniciar tu partida de "${title}" desde cero?

` +
        'Se borran la partida guardada, tus bajas y tus logros de este juego. No se puede deshacer.',
    )
  ) {
    return;
  }
  busy = true;
  try {
    const paths = emu.filePaths();
    const logrosKey = myGameKey();
    await stopGame();
    gameCode = await romId(`${paths.gamePath}/${rom}`, stem(rom));
    say('Borrando la partida…');
    // Primero la cuenta: si falla, acá no se toca nada.
    if (shared()) await sync.resetRun(gameCode);

    dropFile(savePathFor(rom));
    dropFile(`${paths.autosave}/${stem(rom)}_auto.ss`);
    localStorage.removeItem(`wabgba.logros.${logrosKey}`);
    localStorage.removeItem(deadKey());
    localStorage.removeItem(caughtKey());
    sync.clearState(gameCode);
    if (!shared()) {
      const kept = localEvents().filter((e) => (e.data as { game?: string }).game !== gameCode);
      localStorage.setItem('wabgba.events', JSON.stringify(kept));
    }
    await persist();
    playersCache = null;
    await loadFeed();
    busy = false;
    toast('Partida reiniciada. ¡Suerte esta vez!');
    await startGame(rom);
  } catch (e) {
    onCloudError(e);
  } finally {
    busy = false;
  }
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
// Las teclas las maneja la página (no el emulador), para que cada uno las configure.

const held = new Set<string>();

function actionFor(code: string): controls.Action | null {
  for (const action of controls.ACTIONS) if (bindings[action] === code) return action;
  return null;
}

/** Suelta todo lo que estuviera apretado (al abrir un menú o perder el foco). */
function releaseAll() {
  for (const button of held) emu.buttonUnpress(button);
  held.clear();
  if (holdingFast) {
    holdingFast = false;
    if (running) applySpeed();
  }
}

function setupKeyboard() {
  window.addEventListener('keydown', (e) => {
    if (!loginPanel.hidden) return;

    if (!settingsPanel.hidden) {
      if (listening) {
        e.preventDefault();
        if (e.code === 'Escape') {
          listening = null;
          renderBindings();
        } else setBinding(listening, e.code);
      } else if (e.code === 'Escape') closeSettings();
      return;
    }

    // En el menú: izquierda y derecha cambian de pestaña, Escape vuelve al juego.
    if (!hub.hidden) {
      if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        const step = e.code === 'ArrowRight' ? 1 : -1;
        setTab(TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length]);
      } else if (e.code === 'Escape') closeHub();
      return;
    }

    if (!running) return;
    const action = actionFor(e.code);
    if (action) {
      e.preventDefault();
      if (e.repeat) return;
      if (action === 'Fast') {
        holdingFast = true;
        applySpeed();
      } else {
        held.add(action);
        emu.buttonPress(action);
      }
      return;
    }
    if (e.repeat) return;
    if (e.code === 'KeyP') setPaused(!paused);
    else if (e.code === 'KeyM') {
      muted = !muted;
      applyVolume();
    } else if (e.code === 'Escape') void openHub();
  });

  window.addEventListener('keyup', (e) => {
    const action = actionFor(e.code);
    if (action === 'Fast') {
      if (holdingFast) {
        holdingFast = false;
        if (running) applySpeed();
      }
    } else if (action && held.delete(action)) emu.buttonUnpress(action);
  });
  window.addEventListener('blur', releaseAll);
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
  $('btn-settings').onclick = () => void openSettings();
  $('btn-settings-close').onclick = closeSettings;
  $('btn-controls-reset').onclick = () => {
    bindings = { ...controls.DEFAULTS };
    listening = null;
    saveBindings();
    sfx('ok');
    renderBindings();
  };
  $('btn-set-save').onclick = () => void saveRules();
  $('btn-join').onclick = () => void joinRoomByCode();
  $('btn-room-create').onclick = () => void createRoom();
  $<HTMLSelectElement>('room-select').onchange = (e) => void switchRoom(Number((e.target as HTMLSelectElement).value));
  $('btn-export').onclick = exportSave;
  $('btn-reset').onclick = () => void resetRun();
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
    autoSaveStateCapturedCallback: () => void inspectState(),
    coreCrashedCallback: () => toast('El juego se colgó. Recargá la página.'),
  });
  // Sin rebobinar: lo único que cuenta es el guardado del juego.
  emu.setCoreSettings({ rewindEnable: false });
  // El teclado lo maneja la página, con los controles de cada uno.
  emu.toggleInput(false);

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
  void loadAccountData();
  setInterval(watchTick, WATCH_EVERY);
  // Novedades de los demás, mientras la página esté a la vista.
  setInterval(() => {
    if (document.visibilityState === 'visible') void loadFeed();
  }, 30_000);
  if (account === 'out' || (account === 'offline' && !sync.getSession())) showLogin();
  console.log(`${emu.version.projectName} ${emu.version.projectVersion}`);
}

main().catch((e) => {
  console.error(e);
  fail('No se pudo iniciar el emulador: ' + (e instanceof Error ? e.message : String(e)));
});
