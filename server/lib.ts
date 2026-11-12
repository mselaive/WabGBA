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
  return db
    .prepare(
      'SELECT users.id AS id, users.username AS username FROM sessions ' +
        'JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ?',
    )
    .bind(await sha256(token))
    .first<User>();
}

export async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
