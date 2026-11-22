// Nintendo DS. El juego corre con EmulatorJS (núcleo DeSmuME) dentro de un marco aparte
// (public/nds.html); acá están el almacén local de ROMs y partidas, y el manejo del marco.
//
// Las ROMs de DS pesan unos 128 MB: no pueden vivir en la memoria del emulador de GBA como
// las otras, así que van directo a IndexedDB.

const DB_NAME = 'wabgba-nds';
const ROMS = 'roms';
const SAVES = 'saves';

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore(ROMS);
      open.result.createObjectStore(SAVES);
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  return dbPromise;
}

async function run<T>(store: string, mode: IDBTransactionMode, work: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const base = await db();
  return new Promise((resolve, reject) => {
    const tx = base.transaction(store, mode);
    const request = work(tx.objectStore(store));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Ids de las ROMs de DS que ya están descargadas en este navegador. */
export const localRoms = async () => (await run(ROMS, 'readonly', (s) => s.getAllKeys())).map(String);
export const getRom = (id: string) => run<Blob | undefined>(ROMS, 'readonly', (s) => s.get(id));
export const putRom = (id: string, rom: Blob) => run(ROMS, 'readwrite', (s) => s.put(rom, id));
export const dropRom = (id: string) => run(ROMS, 'readwrite', (s) => s.delete(id));

const saveKey = (id: string, user: string) => `${id}:${user}`;
export const getSave = (id: string, user: string) =>
  run<Uint8Array | undefined>(SAVES, 'readonly', (s) => s.get(saveKey(id, user)));
export const putSave = (id: string, user: string, data: Uint8Array) =>
  run(SAVES, 'readwrite', (s) => s.put(data, saveKey(id, user)));
export const dropSave = (id: string, user: string) => run(SAVES, 'readwrite', (s) => s.delete(saveKey(id, user)));

export const isNdsFile = (name: string) => /\.nds$/i.test(name);

/** Identifica la ROM: código de la cabecera más una huella del contenido. */
export async function romIdOf(rom: Blob, fallback: string): Promise<string> {
  const bytes = new Uint8Array(await rom.arrayBuffer());
  let code = fallback.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 19) || 'juego';
  const header = String.fromCharCode(...bytes.subarray(0x0c, 0x10));
  if (/^[A-Z0-9]{4}$/.test(header)) code = header;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const print = [...digest.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${code}-${print}`;
}

/**
 * DeSmuME guarda la partida con un pie de 122 bytes detrás de los datos. Una partida sin
 * estrenar tiene los datos llenos de 0xFF.
 */
const FOOTER = 122;
export function isRealSave(data: Uint8Array | null | undefined): boolean {
  if (!data || data.length <= FOOTER) return false;
  const end = data.length - FOOTER;
  for (let i = 0; i < end; i++) if (data[i] !== 0xff && data[i] !== 0) return true;
  return false;
}

function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (!a || !b || a.length !== b.length) return a === b;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------- El marco del juego ----------

/** Lo mínimo que se usa de EmulatorJS desde afuera. */
interface Ejs {
  started?: boolean;
  paused?: boolean;
  pause(): void;
  play(): void;
  setVolume(volume: number): void;
  changeSettingOption(option: string, value: string): void;
  controlMenu?: HTMLElement;
  settings?: Record<string, string>;
  elements?: { parent?: HTMLElement };
  gameManager?: {
    getSaveFile(flush?: boolean): Uint8Array | null;
    setFastForwardRatio(ratio: number): void;
    toggleFastForward(active: number): void;
  };
}

export interface Session {
  id: string;
  /** Pone el juego en pausa o lo reanuda. */
  setPaused(paused: boolean): void;
  setMuted(muted: boolean): void;
  /** Velocidad del juego: 1 es la normal. */
  setSpeed(speed: number): void;
  /** Alterna entre pantallas lado a lado y una sobre otra. */
  toggleLayout(): void;
  /** Abre la configuración de teclas y mando del emulador. */
  openControls(): void;
  /** Devuelve el teclado al juego (después de tocar un botón de afuera). */
  focus(): void;
  /** La partida tal como está ahora en el cartucho (null si el juego todavía no arrancó). */
  save(): Uint8Array | null;
  /** Cierra el juego y devuelve la última partida. */
  stop(): Uint8Array | null;
}

export interface StartOptions {
  host: HTMLElement;
  id: string;
  rom: Blob;
  save: Uint8Array | null;
  muted: boolean;
  /** Avisa cuando el juego terminó de escribir una partida nueva. */
  onSave(data: Uint8Array): void;
  onStart(): void;
}

const CHECK_EVERY = 4000;

export function start(options: StartOptions): Session {
  // En pantallas anchas las dos pantallas van lado a lado; en el celular, una sobre otra.
  const wide = window.matchMedia('(min-width: 900px) and (orientation: landscape)').matches;
  const frame = document.createElement('iframe');
  frame.title = 'Nintendo DS';
  frame.allow = 'autoplay; fullscreen; gamepad';
  let ejs: Ejs | null = null;
  let layout = wide ? 'left/right' : 'top/bottom';
  let last: Uint8Array | null = options.save;
  let pending: Uint8Array | null = null;

  (window as unknown as { __ndsBoot: unknown }).__ndsBoot = {
    rom: options.rom,
    name: options.id,
    save: options.save,
    layout,
    muted: options.muted,
    onStart: () => {
      ejs = (frame.contentWindow as unknown as { EJS_emulator: Ejs }).EJS_emulator;
      options.onStart();
    },
  };

  const read = (flush: boolean): Uint8Array | null => {
    try {
      const data = ejs?.started ? ejs.gameManager?.getSaveFile(flush) : null;
      return data ? data.slice() : null;
    } catch {
      return null;
    }
  };

  // El juego escribe la partida de a poco: se da por terminada cuando dos lecturas
  // seguidas coinciden.
  const timer = window.setInterval(() => {
    if (!ejs?.started || ejs.paused) return;
    const now = read(true);
    if (!now || sameBytes(now, last)) return;
    if (pending && sameBytes(now, pending)) {
      last = now;
      pending = null;
      if (isRealSave(now)) options.onSave(now);
    } else pending = now;
  }, CHECK_EVERY);

  frame.src = '/nds.html';
  options.host.replaceChildren(frame);

  return {
    id: options.id,
    setPaused(paused) {
      if (!ejs?.started) return;
      if (paused) ejs.pause();
      else ejs.play();
    },
    setMuted(muted) {
      ejs?.setVolume(muted ? 0 : 0.7);
    },
    setSpeed(speed) {
      const gm = ejs?.started ? ejs.gameManager : null;
      if (!gm) return;
      if (speed > 1) gm.setFastForwardRatio(speed);
      gm.toggleFastForward(speed > 1 ? 1 : 0);
    },
    toggleLayout() {
      if (!ejs?.started) return;
      // El emulador recuerda la disposición de la última vez: se parte de la que tiene puesta.
      const current = ejs.settings?.desmume_screens_layout ?? layout;
      layout = current === 'left/right' ? 'top/bottom' : 'left/right';
      ejs.changeSettingOption('desmume_screens_layout', layout);
    },
    openControls() {
      if (ejs?.started && ejs.controlMenu) ejs.controlMenu.style.display = '';
    },
    focus() {
      frame.contentWindow?.focus();
      ejs?.elements?.parent?.focus();
    },
    save: () => read(true),
    stop() {
      clearInterval(timer);
      const final = read(true);
      frame.remove();
      delete (window as unknown as { __ndsBoot?: unknown }).__ndsBoot;
      return final;
    },
  };
}
