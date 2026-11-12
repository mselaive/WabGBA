// GET /api/me -> { username } | 401
import { currentUser, database, json, type Context } from '../../server/lib';

export async function onRequestGet({ request, env }: Context): Promise<Response> {
  const db = await database(env);
  if (!db) return json({ error: 'not-configured' }, 501);
  const user = await currentUser(request, db);
  return user ? json({ username: user.username, admin: user.admin }) : json({ error: 'unauthorized' }, 401);
}
