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
  /** Código de la primera sala. Las demás salas y sus códigos viven en la base. */
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
  /** La primera cuenta creada administra el sitio: crea salas, nombra líderes y sube ROMs. */
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
      // Salas: cada una es un grupo con su código de invitación, sus ROMs, sus reglas y su líder.
      env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, ' +
          "code TEXT NOT NULL UNIQUE, leader_id INTEGER, lives INTEGER NOT NULL, discord TEXT NOT NULL DEFAULT '', " +
          'created_at INTEGER NOT NULL)',
      ),
      env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS room_members (room_id INTEGER NOT NULL, user_id INTEGER NOT NULL, ' +
          'joined_at INTEGER NOT NULL, PRIMARY KEY (room_id, user_id))',
      ),
      // Una ROM pertenece a una sola sala; de ahí sale a qué sala va cada evento.
      env.DB.prepare('CREATE TABLE IF NOT EXISTS room_roms (rom_id TEXT PRIMARY KEY, room_id INTEGER NOT NULL)'),
    ]);
    await seedFirstRoom(env.DB, env.INVITE_CODE);
    ready = true;
  }
  return env.DB;
}

/**
 * Si todavía no hay salas, arma la primera con lo que el sitio ya tenía: el código de
 * invitación original, todas las cuentas, todas las ROMs y las reglas vigentes.
 */
async function seedFirstRoom(db: D1, inviteCode: string | undefined) {
  const any = await db.prepare('SELECT id FROM rooms LIMIT 1').first<{ id: number }>();
  const code = normalizeCode(inviteCode ?? '');
  if (any || !code) return;
  const lives = Number((await db.prepare("SELECT value FROM settings WHERE key = 'lives'").first<{ value: string }>())?.value);
  const discord = (await db.prepare("SELECT value FROM settings WHERE key = 'discord'").first<{ value: string }>())?.value ?? '';
  await db
    .prepare('INSERT OR IGNORE INTO rooms (name, code, leader_id, lives, discord, created_at) VALUES (?, ?, NULL, ?, ?, ?)')
    .bind('Sala principal', code, Number.isInteger(lives) && lives > 0 ? lives : DEFAULT_LIVES, discord, Date.now())
    .run();
  const room = await db.prepare('SELECT id FROM rooms WHERE code = ?').bind(code).first<{ id: number }>();
  if (!room) return;
  await db.batch([
    db.prepare('INSERT OR IGNORE INTO room_members (room_id, user_id, joined_at) SELECT ?1, id, ?2 FROM users').bind(room.id, Date.now()),
    db.prepare('INSERT OR IGNORE INTO room_roms (rom_id, room_id) SELECT id, ?1 FROM roms').bind(room.id),
  ]);
}

/** Los códigos de sala no distinguen mayúsculas ni espacios alrededor. */
export const normalizeCode = (code: string) => code.trim().toLowerCase();

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

// ---------- Salas ----------

export const DEFAULT_LIVES = 10;

export interface Room {
  id: number;
  name: string;
  code: string;
  leader_id: number | null;
  lives: number;
  discord: string;
}

const ROOM_COLUMNS = 'id, name, code, leader_id, lives, discord';

export async function roomById(db: D1, id: number): Promise<Room | null> {
  if (!Number.isInteger(id) || id < 1) return null;
  return db.prepare(`SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = ?`).bind(id).first<Room>();
}

export async function roomByCode(db: D1, code: string): Promise<Room | null> {
  const clean = normalizeCode(code);
  if (!clean) return null;
  return db.prepare(`SELECT ${ROOM_COLUMNS} FROM rooms WHERE code = ?`).bind(clean).first<Room>();
}

/** La sala a la que pertenece una ROM (y, por lo tanto, sus partidas y eventos). */
export async function roomOfGame(db: D1, game: string): Promise<Room | null> {
  return db
    .prepare(
      'SELECT r.id AS id, r.name AS name, r.code AS code, r.leader_id AS leader_id, r.lives AS lives, r.discord AS discord ' +
        'FROM room_roms rr JOIN rooms r ON r.id = rr.room_id WHERE rr.rom_id = ?',
    )
    .bind(game)
    .first<Room>();
}

export async function isMember(db: D1, roomId: number, userId: number): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS yes FROM room_members WHERE room_id = ? AND user_id = ?')
    .bind(roomId, userId)
    .first<{ yes: number }>();
  return !!row;
}

export async function joinRoom(db: D1, roomId: number, userId: number): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)')
    .bind(roomId, userId, Date.now())
    .run();
}

/** Quien administra el sitio entra a todas las salas; el resto, sólo a las suyas. */
export async function canEnter(db: D1, user: User, room: Room): Promise<boolean> {
  return user.admin || (await isMember(db, room.id, user.id));
}

/** Las reglas y las anulaciones de una sala las decide su líder (o quien administra el sitio). */
export const canModerate = (user: User, room: Room) => user.admin || room.leader_id === user.id;

/** La sala que pide la solicitud (`?room=<id>`), si existe y la cuenta puede entrar. */
export async function requestedRoom(db: D1, request: Request, user: User): Promise<Room | null> {
  const room = await roomById(db, Number(new URL(request.url).searchParams.get('room')));
  return room && (await canEnter(db, user, room)) ? room : null;
}

/** Las salas de una cuenta, como las ve ella. El código sólo lo ve quien puede invitar. */
export async function roomsFor(db: D1, user: User) {
  const sql =
    'SELECT r.id AS id, r.name AS name, r.code AS code, r.leader_id AS leader_id, r.lives AS lives, ' +
    'u.username AS leader, ' +
    '(SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id AND m.user_id = ?1) AS member ' +
    'FROM rooms r LEFT JOIN users u ON u.id = r.leader_id ';
  // Quien administra el sitio ve todas, participe o no.
  const { results } = await db
    .prepare(
      sql +
        (user.admin ? '' : 'WHERE r.id IN (SELECT room_id FROM room_members WHERE user_id = ?1) ') +
        'ORDER BY r.id',
    )
    .bind(user.id)
    .all<Room & { leader: string | null; member: number }>();
  return results.map((r) => {
    const moderator = user.admin || r.leader_id === user.id;
    return {
      id: r.id,
      name: r.name,
      lives: r.lives,
      leader: r.leader,
      /** Esta cuenta decide las reglas y las anulaciones de la sala. */
      moderator,
      /** Esta cuenta juega en la sala (quien administra el sitio puede entrar sin jugar). */
      member: r.member > 0,
      ...(moderator ? { code: r.code } : {}),
    };
  });
}

/** Sólo se aceptan webhooks de Discord: el servidor no llama a direcciones arbitrarias. */
export const isDiscordWebhook = (url: string) =>
  /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(url);

/** Publica un aviso en el canal de Discord de la sala. Nunca hace fallar al que llama. */
export async function announce(db: D1, room: Room | null, text: string, image?: ArrayBuffer | null): Promise<void> {
  try {
    const url = room?.discord;
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

/** Parte de una consulta que deja sólo los eventos de una sala (por la ROM de su clave). */
export const EVENT_IN_ROOM =
  "substr(e.key, 1, instr(e.key, ':') - 1) IN (SELECT rom_id FROM room_roms WHERE room_id = ?)";

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
