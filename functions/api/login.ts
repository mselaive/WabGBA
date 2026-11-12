// POST /api/login { username, password } -> { token, username }
import { createSession, database, hashPassword, isAdmin, json, readBody, safeEqual, type Context } from '../../server/lib';

export async function onRequestPost({ request, env }: Context): Promise<Response> {
  const db = await database(env);
  if (!db) return json({ error: 'not-configured' }, 501);

  const body = await readBody(request);
  const username = String(body.username ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');

  const user = await db
    .prepare('SELECT id, pass_hash, salt FROM users WHERE username = ?')
    .bind(username)
    .first<{ id: number; pass_hash: string; salt: string }>();
  // Calcular el hash aunque el usuario no exista, para no delatarlo por el tiempo de respuesta.
  const hash = await hashPassword(password, user?.salt ?? 'sin-usuario');
  if (!user || !safeEqual(hash, user.pass_hash)) return json({ error: 'bad-credentials' }, 401);

  return json({ token: await createSession(db, user.id), username, admin: await isAdmin(db, user.id) });
}
