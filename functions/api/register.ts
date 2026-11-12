// POST /api/register { username, password, invite } -> { token, username }
import { createSession, database, hashPassword, json, randomHex, readBody, safeEqual, sha256, type Context } from '../../server/lib';

export async function onRequestPost({ request, env }: Context): Promise<Response> {
  const db = await database(env);
  if (!db || !env.INVITE_CODE) return json({ error: 'not-configured' }, 501);

  const body = await readBody(request);
  const username = String(body.username ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  const invite = String(body.invite ?? '').trim();

  if (!safeEqual(await sha256(invite), await sha256(env.INVITE_CODE))) return json({ error: 'bad-invite' }, 403);
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

  return json({ token: await createSession(db, user.id), username });
}
