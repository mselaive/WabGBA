// GET /api/me -> { username, admin, rooms } | 401
import { currentUser, database, json, roomsFor, type Context } from '../../server/lib';

export async function onRequestGet({ request, env }: Context): Promise<Response> {
  const db = await database(env);
  if (!db) return json({ error: 'not-configured' }, 501);
  const user = await currentUser(request, db);
  if (!user) return json({ error: 'unauthorized' }, 401);
  return json({ username: user.username, admin: user.admin, rooms: await roomsFor(db, user) });
}
