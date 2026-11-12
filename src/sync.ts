// Cliente de las cuentas y de la partida en la nube (ver functions/api y server/lib.ts).

// ---------- Sesión ----------

export interface Session {
  token: string;
  username: string;
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
  | 'invalid';

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
  if (res.ok) return 'in';
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
  const session = { token: body.token, username: body.username };
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
