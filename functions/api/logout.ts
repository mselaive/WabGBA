// POST /api/logout -> cierra la sesión de este dispositivo
import { bearer, database, json, sha256, type Context } from '../../server/lib';

export async function onRequestPost({ request, env }: Context): Promise<Response> {
  const db = await database(env);
  if (!db) return json({ error: 'not-configured' }, 501);
  const token = bearer(request);
  if (token) await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  return json({ ok: true });
}
