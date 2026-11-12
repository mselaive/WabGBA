// POST /api/register { username, password, invite } -> { token, username, admin }
// El código de invitación es el de una sala: la cuenta nueva entra directo a esa sala.
import {
  createSession,
  database,
  hashPassword,
  isAdmin,
  joinRoom,
  json,
  randomHex,
  readBody,
  roomByCode,
  type Context,
} from '../../server/lib';

export async function onRequestPost({ request, env }: Context): Promise<Response> {
  const db = await database(env);
  if (!db) return json({ error: 'not-configured' }, 501);
  // Sin ninguna sala no hay código que sirva: falta configurar INVITE_CODE.
  if (!(await db.prepare('SELECT id FROM rooms LIMIT 1').first<{ id: number }>())) {
    return json({ error: 'not-configured' }, 501);
  }

  const body = await readBody(request);
  const username = String(body.username ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');

  const room = await roomByCode(db, String(body.invite ?? ''));
  if (!room) return json({ error: 'bad-invite' }, 403);
  if (!/^[a-z0-9_-]{3,20}$/.test(username) || password.length < 6 || password.length > 200) {
    return json({ error: 'invalid' }, 400);
  }

  const taken = await db.prepare('SELECT id FROM users WHERE username = ?').bind(username).first<{ id: number }>();
  if (taken) return json({ error: 'taken' }, 409);

  const salt = randomHex(16);
  await db
    .prepare('INSERT INTO users (username, pass_hash, salt, created_at) VALUES (?, ?, ?, ?)')
    .bind(username, await hashPassword(password, salt), salt, Date.now())
    .run();
  const user = await db.prepare('SELECT id FROM users WHERE username = ?').bind(username).first<{ id: number }>();
  if (!user) return json({ error: 'server' }, 500);
  await joinRoom(db, room.id, user.id);

  return json({ token: await createSession(db, user.id), username, admin: await isAdmin(db, user.id) });
}
