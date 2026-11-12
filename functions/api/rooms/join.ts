// POST /api/rooms/join { code } -> { rooms, joined }
// Una cuenta que ya existe se suma a otra sala con su código.
import { currentUser, database, joinRoom, json, readBody, roomByCode, roomsFor, type Context } from '../../../server/lib';

export async function onRequestPost({ request, env }: Context): Promise<Response> {
  const db = await database(env);
  if (!db) return json({ error: 'not-configured' }, 501);
  const user = await currentUser(request, db);
  if (!user) return json({ error: 'unauthorized' }, 401);

  const room = await roomByCode(db, String((await readBody(request)).code ?? ''));
  if (!room) return json({ error: 'bad-invite' }, 403);
  await joinRoom(db, room.id, user.id);
  return json({ rooms: await roomsFor(db, user), joined: room.id });
}
