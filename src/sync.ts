// Cliente de la sincronización en la nube (ver functions/api/save/[name].ts).

const KEY = 'wabgba.sync.key';

export const getKey = () => localStorage.getItem(KEY) ?? '';
export function setKey(key: string) {
  if (key) localStorage.setItem(KEY, key);
  else localStorage.removeItem(KEY);
}

// Perfil: quién juega en este dispositivo. Cada perfil tiene su propia partida, acá y en la nube.
const PROFILE = 'wabgba.profile';

export const getProfile = () => localStorage.getItem(PROFILE) ?? '';
export function setProfile(name: string): string {
  const clean = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 20);
  if (clean) localStorage.setItem(PROFILE, clean);
  else localStorage.removeItem(PROFILE);
  return clean;
}

/** Lo que este dispositivo sabe de la nube para un juego. */
export interface SyncState {
  /** Versión de la nube sobre la que está parada la partida local (null: nunca sincronizó). */
  base: number | null;
  /** Hay un guardado local que todavía no subió. */
  dirty: boolean;
}

const stateKey = (game: string) => `wabgba.sync.${game}`;

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

export type SyncErrorKind = 'offline' | 'auth' | 'not-configured' | 'server';

export class SyncError extends Error {
  constructor(public kind: SyncErrorKind) {
    super(kind);
  }
}

export function describe(e: unknown): string {
  const kind = e instanceof SyncError ? e.kind : 'server';
  return {
    offline: 'Sin conexión: se sigue con la partida de este dispositivo.',
    auth: 'La clave de sincronización no coincide.',
    'not-configured': 'Este sitio no tiene la sincronización configurada.',
    server: 'La nube respondió con un error.',
  }[kind];
}

async function call(game: string, query: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`/api/save/${encodeURIComponent(game)}${query}`, {
      ...init,
      cache: 'no-store',
      headers: { ...init.headers, Authorization: `Bearer ${getKey()}` },
    });
  } catch {
    throw new SyncError('offline');
  }
  if (res.status === 401) throw new SyncError('auth');
  if (res.status === 501) throw new SyncError('not-configured');
  if (res.status >= 500) throw new SyncError('server');
  return res;
}

const isJson = (res: Response) => (res.headers.get('Content-Type') ?? '').includes('application/json');

/** Versión que hay en la nube, o null si todavía no hay ninguna. */
export async function remoteVersion(game: string): Promise<number | null> {
  const res = await call(game, '?meta=1');
  // Sin la API detrás (por ejemplo en `npm run dev`) responde el HTML de la página.
  if (!isJson(res)) throw new SyncError('not-configured');
  if (res.status === 404) return null;
  if (!res.ok) throw new SyncError('server');
  return ((await res.json()) as { savedAt: number }).savedAt;
}

export async function download(game: string): Promise<{ data: Uint8Array; savedAt: number } | null> {
  const res = await call(game, '');
  if (res.status === 404) return null;
  const savedAt = Number(res.headers.get('X-Saved-At'));
  if (!res.ok || !savedAt) throw new SyncError(isJson(res) ? 'server' : 'not-configured');
  return { data: new Uint8Array(await res.arrayBuffer()), savedAt };
}

/** Sube la partida. `conflict`: la nube cambió desde `base` y no se pisó. */
export async function upload(
  game: string,
  data: Uint8Array,
  base: number | null,
  force: boolean,
): Promise<{ ok: true; savedAt: number } | { ok: false }> {
  const res = await call(game, '', {
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
