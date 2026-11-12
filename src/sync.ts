// Cliente de las cuentas y de la partida en la nube (ver functions/api y server/lib.ts).

// ---------- Sesión ----------

export interface Session {
  token: string;
  username: string;
  /** La cuenta administradora: la única que sube ROMs a la biblioteca. */
  admin: boolean;
}

const SESSION = 'wabgba.session';

export function getSession(): Session | null {
  try {
    return JSON.parse(localStorage.getItem(SESSION) ?? 'null') as Session | null;
  } catch {
    return null;
  }
}

export const clearSession = () => localStorage.removeItem(SESSION);

// ---------- Errores ----------

export type SyncErrorKind =
  | 'offline'
  | 'auth'
  | 'not-configured'
  | 'server'
  | 'bad-credentials'
  | 'taken'
  | 'bad-invite'
  | 'invalid'
  | 'forbidden'
  | 'too-big'
  | 'bad-webhook'
  | 'no-room'
  | 'bad-room'
  | 'code-taken'
  | 'bad-leader'
  | 'rom-elsewhere';

export class SyncError extends Error {
  constructor(public kind: SyncErrorKind) {
    super(kind);
  }
}

export function describe(e: unknown): string {
  const kind = e instanceof SyncError ? e.kind : 'server';
  return {
    offline: 'Sin conexión: se sigue con la partida de este dispositivo.',
    auth: 'Tu sesión venció. Volvé a entrar.',
    'not-configured': 'Este sitio no tiene las cuentas configuradas.',
    server: 'El servidor respondió con un error.',
    'bad-credentials': 'Usuario o contraseña incorrectos.',
    taken: 'Ese nombre de usuario ya existe.',
    'bad-invite': 'El código de invitación no es correcto.',
    invalid: 'Usuario de 3 a 20 letras o números, y contraseña de 6 o más.',
    forbidden: 'Sólo la cuenta administradora puede hacer eso.',
    'too-big': 'El archivo es demasiado grande.',
    'bad-webhook': 'Eso no parece un webhook de Discord.',
    'no-room': 'No estás en esa sala.',
    'bad-room': 'La sala necesita un nombre y un código de 3 a 30 letras, números o guiones.',
    'code-taken': 'Ya hay otra sala con ese código.',
    'bad-leader': 'El líder tiene que ser alguien que ya esté en la sala.',
    'rom-elsewhere': 'Esa ROM ya está en otra sala. Una ROM vive en una sola sala.',
  }[kind];
}

// ---------- Llamadas ----------

const isJson = (res: Response) => (res.headers.get('Content-Type') ?? '').includes('application/json');

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const session = getSession();
  let res: Response;
  try {
    res = await fetch(`/api/${path}`, {
      ...init,
      cache: 'no-store',
      headers: { ...init.headers, ...(session ? { Authorization: `Bearer ${session.token}` } : {}) },
    });
  } catch {
    throw new SyncError('offline');
  }
  if (res.status === 501) throw new SyncError('not-configured');
  if (res.status >= 500) throw new SyncError('server');
  return res;
}

/**
 * Cómo está la cuenta en este dispositivo:
 * - `in`: sesión válida. - `out`: hay que entrar.
 * - `none`: el sitio no tiene servidor de cuentas (por ejemplo `npm run dev`).
 * - `offline`: no se pudo preguntar.
 */
export async function check(): Promise<'in' | 'out' | 'none' | 'offline'> {
  let res: Response;
  try {
    res = await call('me');
  } catch (e) {
    return e instanceof SyncError && e.kind === 'offline' ? 'offline' : 'none';
  }
  // Sin la API detrás responde el HTML de la página.
  if (!isJson(res)) return 'none';
  if (res.ok) {
    const session = getSession();
    const body = (await res.json()) as { admin?: boolean };
    if (session) localStorage.setItem(SESSION, JSON.stringify({ ...session, admin: !!body.admin }));
    return 'in';
  }
  clearSession();
  return 'out';
}

export async function signIn(
  mode: 'login' | 'register',
  username: string,
  password: string,
  invite: string,
): Promise<Session> {
  const res = await call(mode, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, invite }),
  });
  if (!isJson(res)) throw new SyncError('not-configured');
  const body = (await res.json()) as Partial<Session> & { error?: SyncErrorKind };
  if (!res.ok || !body.token || !body.username) throw new SyncError(body.error ?? 'server');
  const session = { token: body.token, username: body.username, admin: !!body.admin };
  localStorage.setItem(SESSION, JSON.stringify(session));
  return session;
}

export async function signOut() {
  try {
    await call('logout', { method: 'POST' });
  } catch {
    /* sin conexión: igual se cierra acá */
  }
  clearSession();
}

// ---------- Biblioteca de ROMs ----------

export interface RomInfo {
  id: string;
  title: string;
  size: number;
  chunks: number;
}

export const CHUNK_BYTES = 1024 * 1024;

/** Errores que el servidor nombra tal cual y que tienen su propio mensaje. */
const NAMED: SyncErrorKind[] = [
  'forbidden',
  'taken',
  'bad-invite',
  'invalid',
  'bad-webhook',
  'no-room',
  'bad-room',
  'code-taken',
  'bad-leader',
  'rom-elsewhere',
];

async function okJson(res: Response): Promise<Response> {
  if (!isJson(res)) throw new SyncError('not-configured');
  if (res.ok) return res;
  if (res.status === 401) throw new SyncError('auth');
  if (res.status === 413) throw new SyncError('too-big');
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  const named = NAMED.find((kind) => kind === body.error);
  throw new SyncError(named ?? (res.status === 403 ? 'forbidden' : 'server'));
}

// ---------- Salas ----------

export interface RoomInfo {
  id: number;
  name: string;
  lives: number;
  /** Nombre de usuario del líder, si tiene. */
  leader: string | null;
  /** Esta cuenta decide las reglas y las anulaciones de la sala. */
  moderator: boolean;
  /** Esta cuenta juega en la sala (quien administra el sitio puede entrar sin jugar). */
  member: boolean;
  /** El código de invitación; sólo le llega a quien puede invitar. */
  code?: string;
}

/** La sala en la que se está: va en todos los pedidos que dependen de una sala. */
let roomId: number | null = null;

export const getRoom = () => roomId;
export function setRoom(id: number | null) {
  roomId = id;
}

const inRoom = () => `?room=${roomId ?? 0}`;

export async function listRooms(): Promise<RoomInfo[]> {
  const res = await okJson(await call('rooms'));
  return ((await res.json()) as { rooms: RoomInfo[] }).rooms;
}

const postJson = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** Crea una sala (sólo quien administra el sitio). Devuelve las salas y el id de la nueva. */
export async function createRoom(name: string, code: string): Promise<{ rooms: RoomInfo[]; created: number | null }> {
  const res = await okJson(await call('rooms', postJson({ name, code })));
  return (await res.json()) as { rooms: RoomInfo[]; created: number | null };
}

/** Suma esta cuenta a otra sala con su código. */
export async function joinRoom(code: string): Promise<{ rooms: RoomInfo[]; joined: number }> {
  const res = await okJson(await call('rooms/join', postJson({ code })));
  return (await res.json()) as { rooms: RoomInfo[]; joined: number };
}

/** Cambia nombre, código o líder de una sala (sólo quien administra el sitio). */
export async function updateRoom(
  id: number,
  changes: { name?: string; code?: string; leader?: string; member?: boolean },
): Promise<RoomInfo[]> {
  const res = await okJson(await call(`rooms/${id}`, postJson(changes, 'PUT')));
  return ((await res.json()) as { rooms: RoomInfo[] }).rooms;
}

export async function listRoms(): Promise<RomInfo[]> {
  const res = await okJson(await call('roms' + inRoom()));
  return ((await res.json()) as { roms: RomInfo[] }).roms;
}

/** Baja una ROM de la biblioteca, trozo por trozo. */
export async function downloadRom(rom: RomInfo, onProgress: (done: number, total: number) => void): Promise<Uint8Array> {
  const data = new Uint8Array(rom.size);
  let offset = 0;
  for (let n = 0; n < rom.chunks; n++) {
    const res = await call(`roms/${encodeURIComponent(rom.id)}/${n}`);
    if (res.status === 401) throw new SyncError('auth');
    if (!res.ok || isJson(res)) throw new SyncError('server');
    const chunk = new Uint8Array(await res.arrayBuffer());
    if (offset + chunk.length > rom.size) throw new SyncError('server');
    data.set(chunk, offset);
    offset += chunk.length;
    onProgress(n + 1, rom.chunks);
  }
  if (offset !== rom.size) throw new SyncError('server');
  return data;
}

/** Sube una ROM a la biblioteca (sólo la cuenta administradora). */
export async function uploadRom(
  id: string,
  title: string,
  data: Uint8Array,
  onProgress: (done: number, total: number) => void,
): Promise<void> {
  const chunks = Math.ceil(data.length / CHUNK_BYTES);
  const path = `roms/${encodeURIComponent(id)}`;
  await okJson(
    await call(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, size: data.length, chunks, room: roomId }),
    }),
  );
  for (let n = 0; n < chunks; n++) {
    await okJson(
      await call(`${path}/${n}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: data.slice(n * CHUNK_BYTES, (n + 1) * CHUNK_BYTES),
      }),
    );
    onProgress(n + 1, chunks);
  }
  await okJson(await call(path, { method: 'POST' }));
}

export async function deleteRom(id: string): Promise<void> {
  await okJson(await call(`roms/${encodeURIComponent(id)}`, { method: 'DELETE' }));
}

// ---------- Participantes ----------

export interface Player {
  username: string;
  savedAt: number | null;
  progress: import('./save').Progress | null;
  /** Pokémon perdidos en total. */
  deaths: number;
}

export async function players(): Promise<{ players: Player[]; lives: number; leader: string | null }> {
  const res = await okJson(await call('players' + inRoom()));
  return (await res.json()) as { players: Player[]; lives: number; leader: string | null };
}

// ---------- Historial ----------

export interface DeathData {
  game: string;
  species: number;
  level: number;
  nickname: string;
  enemy: { species: number; level: number; wild: boolean } | null;
  poisoned: boolean;
  /** Medallas que tenía al momento de la baja. */
  badges: number;
  /** Dónde lo había encontrado (número de lugar del juego). */
  met?: number | null;
}

export interface CatchData {
  game: string;
  species: number;
  level: number;
  nickname: string;
  met: number | null;
  /** Fue directo al PC. */
  boxed: boolean;
  /** Ya lo tenía de antes de que existieran estos avisos. */
  silent: boolean;
}

export interface GameEvent {
  id: number;
  /** null: lo anota el sitio (por ejemplo, un torneo). */
  username: string | null;
  type: 'death' | 'catch' | 'badge' | 'champion' | 'tournament';
  at: number;
  data: Record<string, unknown>;
  image: boolean;
  /** Pedido de anulación del dueño: en revisión o ya rechazado. */
  appeal?: { status: 'pending' | 'rejected'; reason: string } | null;
}

export async function events(): Promise<{ events: GameEvent[]; lives: number }> {
  const res = await okJson(await call('events' + inRoom()));
  return (await res.json()) as { events: GameEvent[]; lives: number };
}

/** Anota una baja. `image`: PNG de la pantalla en ese momento. */
export async function reportDeath(death: {
  game: string;
  mon: { key: string; species: number; level: number; nickname: string; met?: number };
  enemy: DeathData['enemy'];
  poisoned: boolean;
  badges: number;
  image: Uint8Array | null;
}): Promise<void> {
  let image: string | null = null;
  if (death.image) {
    let bin = '';
    for (const b of death.image) bin += String.fromCharCode(b);
    image = btoa(bin);
  }
  await okJson(
    await call('events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...death, image }),
    }),
  );
}

const base64 = (bytes: Uint8Array) => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

/** Anota una captura. Devuelve si era nueva para el servidor. */
export async function reportCatch(c: {
  game: string;
  mon: { key: string; species: number; level: number; nickname: string; met: number };
  boxed: boolean;
  silent: boolean;
  image: Uint8Array | null;
}): Promise<boolean> {
  const res = await okJson(
    await call('events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...c, type: 'catch', image: c.image ? base64(c.image) : null }),
    }),
  );
  return !((await res.json()) as { duplicate?: boolean }).duplicate;
}

/** La captura de un evento, como dirección que se puede poner en un <img>. */
export async function eventImage(id: number): Promise<string | null> {
  const res = await call(`events/${id}`);
  if (!res.ok || isJson(res)) return null;
  return URL.createObjectURL(await res.blob());
}

/** El dueño de un evento pide que se anule; lo decide quien administra. */
export async function appealEvent(id: number, reason: string): Promise<void> {
  await okJson(
    await call(`events/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    }),
  );
}

/** Quien administra rechaza un pedido de anulación. */
export async function rejectAppeal(id: number): Promise<void> {
  await okJson(await call(`events/${id}`, { method: 'PUT' }));
}

/** Quien administra anula un evento (aprobando el pedido, si lo había). */
export async function deleteEvent(id: number): Promise<void> {
  await okJson(await call(`events/${id}`, { method: 'DELETE' }));
}

// ---------- Reglas del sitio y preferencias ----------

export interface SiteSettings {
  lives: number;
  discord: boolean;
  /** Sólo le llega a la cuenta administradora. */
  webhook?: string;
}

export async function getSettings(): Promise<SiteSettings> {
  const res = await okJson(await call('settings' + inRoom()));
  return (await res.json()) as SiteSettings;
}

export async function saveSettings(lives: number, webhook: string): Promise<void> {
  await okJson(await call('settings' + inRoom(), postJson({ lives, webhook }, 'PUT')));
}

export async function getPrefs(): Promise<Record<string, unknown>> {
  const res = await okJson(await call('prefs'));
  return ((await res.json()) as { prefs: Record<string, unknown> }).prefs ?? {};
}

export async function savePrefs(prefs: Record<string, unknown>): Promise<void> {
  await okJson(
    await call('prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(prefs) }),
  );
}

// ---------- Partida ----------

/** Lo que este dispositivo sabe de la nube para un juego. */
export interface SyncState {
  /** Versión de la nube sobre la que está parada la partida local (null: nunca sincronizó). */
  base: number | null;
  /** Hay un guardado local que todavía no subió. */
  dirty: boolean;
}

const stateKey = (game: string) => `wabgba.sync.${getSession()?.username ?? ''}.${game}`;

export function getState(game: string): SyncState {
  try {
    const s = JSON.parse(localStorage.getItem(stateKey(game)) ?? 'null') as SyncState | null;
    if (s) return s;
  } catch {
    /* estado corrupto: empezar de cero */
  }
  return { base: null, dirty: false };
}

export function setState(game: string, s: SyncState) {
  localStorage.setItem(stateKey(game), JSON.stringify(s));
}

async function saveCall(game: string, query: string, init: RequestInit = {}): Promise<Response> {
  const res = await call(`save/${encodeURIComponent(game)}${query}`, init);
  if (res.status === 401) throw new SyncError('auth');
  return res;
}

export function clearState(game: string) {
  localStorage.removeItem(stateKey(game));
}

/** Empezar de cero: borra de la cuenta la partida de ese juego, con sus bajas y medallas. */
export async function resetRun(game: string): Promise<void> {
  const res = await saveCall(game, '', { method: 'DELETE' });
  if (!res.ok || !isJson(res)) throw new SyncError(isJson(res) ? 'server' : 'not-configured');
}

/** Versión que hay en la nube, o null si todavía no hay ninguna. */
export async function remoteVersion(game: string): Promise<number | null> {
  const res = await saveCall(game, '?meta=1');
  if (!isJson(res)) throw new SyncError('not-configured');
  if (res.status === 404) return null;
  if (!res.ok) throw new SyncError('server');
  return ((await res.json()) as { savedAt: number }).savedAt;
}

export async function download(game: string): Promise<{ data: Uint8Array; savedAt: number } | null> {
  const res = await saveCall(game, '');
  if (res.status === 404) return null;
  const savedAt = Number(res.headers.get('X-Saved-At'));
  if (!res.ok || !savedAt) throw new SyncError(isJson(res) ? 'server' : 'not-configured');
  return { data: new Uint8Array(await res.arrayBuffer()), savedAt };
}

/** Sube la partida. `ok: false`: la nube cambió desde `base` y no se pisó. */
export async function upload(
  game: string,
  data: Uint8Array,
  base: number | null,
  force: boolean,
): Promise<{ ok: true; savedAt: number } | { ok: false }> {
  const res = await saveCall(game, '', {
    method: 'PUT',
    body: data.slice(),
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Base': String(base ?? ''),
      ...(force ? { 'X-Force': '1' } : {}),
    },
  });
  if (res.status === 409) return { ok: false };
  if (!res.ok || !isJson(res)) throw new SyncError(isJson(res) ? 'server' : 'not-configured');
  return { ok: true, savedAt: ((await res.json()) as { savedAt: number }).savedAt };
}
