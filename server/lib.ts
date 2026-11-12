// Código compartido por las Pages Functions de /api (cuentas y partidas, sobre D1).

export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface D1 {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<unknown>;
}
export interface Env {
  DB?: D1;
  /** Código que hay que saber para crear una cuenta. */
  INVITE_CODE?: string;
}
export interface Context {
  request: Request;
  env: Env;
  params: Record<string, string | string[]>;
}
export interface User {
  id: number;
  username: string;
  /** La primera cuenta creada administra el sitio: es la única que sube ROMs. */
  admin: boolean;
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

let ready = false;

/** La base, con las tablas creadas. null si el sitio no la tiene conectada. */
export async function database(env: Env): Promise<D1 | null> {
  if (!env.DB) return null;
  if (!ready) {
    await env.DB.batch([
      env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, ' +
          'pass_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER NOT NULL)',
      ),
      env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL)',
      ),
      env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS game_saves (user_id INTEGER NOT NULL, name TEXT NOT NULL, saved_at INTEGER NOT NULL, ' +
          'data BLOB NOT NULL, progress TEXT, PRIMARY KEY (user_id, name))',
      ),
      env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS roms (id TEXT PRIMARY KEY, title TEXT NOT NULL, size INTEGER NOT NULL, ' +
          'chunks INTEGER NOT NULL, ready INTEGER NOT NULL, created_at INTEGER NOT NULL)',
      ),
      // Lo que pasa en las partidas: muertes, medallas, torneos. `key` evita repetidos.
      env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, ' +
          'type TEXT NOT NULL, key TEXT NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL, image BLOB, ' +
          'UNIQUE (user_id, key))',
      ),
      // Pedidos de anulación de un evento, a la espera de lo que decida quien administra.
      env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS appeals (event_id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, ' +
          'reason TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL)',
      ),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS prefs (user_id INTEGER PRIMARY KEY, data TEXT NOT NULL)'),
      // D1 no guarda valores de más de 2 MB: la ROM va partida en trozos.
      env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS rom_chunks (rom_id TEXT NOT NULL, n INTEGER NOT NULL, data BLOB NOT NULL, ' +
          'PRIMARY KEY (rom_id, n))',
      ),
    ]);
    ready = true;
  }
  return env.DB;
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export function randomHex(bytes: number): string {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)).buffer);
}

export async function sha256(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

export async function hashPassword(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 100_000 },
    key,
    256,
  );
  return hex(bits);
}

/** Compara dos textos sin cortar en la primera diferencia. */
export function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length && i < b.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function createSession(db: D1, userId: number): Promise<string> {
  const token = randomHex(32);
  await db
    .prepare('INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)')
    .bind(await sha256(token), userId, Date.now())
    .run();
  return token;
}

export function bearer(request: Request): string {
  const auth = request.headers.get('Authorization') ?? '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : '';
}

export async function currentUser(request: Request, db: D1): Promise<User | null> {
  const token = bearer(request);
  if (!token) return null;
  const row = await db
    .prepare(
      'SELECT users.id AS id, users.username AS username, ' +
        '(users.id = (SELECT MIN(id) FROM users)) AS admin FROM sessions ' +
        'JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ?',
    )
    .bind(await sha256(token))
    .first<{ id: number; username: string; admin: number }>();
  return row ? { id: row.id, username: row.username, admin: !!row.admin } : null;
}

export async function isAdmin(db: D1, userId: number): Promise<boolean> {
  const first = await db.prepare('SELECT MIN(id) AS id FROM users').first<{ id: number }>();
  return first?.id === userId;
}

export async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ---------- Ajustes del sitio (los cambia la cuenta administradora) ----------

export const DEFAULT_LIVES = 10;

export async function getSetting(db: D1, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(db: D1, key: string, value: string): Promise<void> {
  await db
    .prepare('INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2')
    .bind(key, value)
    .run();
}

export async function getLives(db: D1): Promise<number> {
  const lives = Number(await getSetting(db, 'lives'));
  return Number.isInteger(lives) && lives > 0 ? lives : DEFAULT_LIVES;
}

/** Sólo se aceptan webhooks de Discord: el servidor no llama a direcciones arbitrarias. */
export const isDiscordWebhook = (url: string) =>
  /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(url);

/** Publica un aviso en el canal de Discord configurado. Nunca hace fallar al que llama. */
export async function announce(db: D1, text: string, image?: ArrayBuffer | null): Promise<void> {
  try {
    const url = await getSetting(db, 'discord');
    if (!url || !isDiscordWebhook(url)) return;
    const payload = { username: 'WabGBA', content: text.slice(0, 1900) };
    if (image) {
      const form = new FormData();
      form.append('payload_json', JSON.stringify(payload));
      form.append('files[0]', new Blob([image], { type: 'image/png' }), 'momento.png');
      await fetch(url, { method: 'POST', body: form });
    } else {
      await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    }
  } catch {
    /* Discord caído o webhook borrado: el evento queda igual en el sitio */
  }
}

/** Anota un evento. Devuelve false si ya estaba (misma cuenta y misma clave). */
export async function addEvent(
  db: D1,
  userId: number,
  type: string,
  key: string,
  data: unknown,
  image: ArrayBuffer | null = null,
): Promise<boolean> {
  const known = await db
    .prepare('SELECT id FROM events WHERE user_id = ? AND key = ?')
    .bind(userId, key)
    .first<{ id: number }>();
  if (known) return false;
  await db
    .prepare('INSERT INTO events (user_id, type, key, created_at, data, image) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(userId, type, key, Date.now(), JSON.stringify(data), image)
    .run();
  return true;
}
