// GET /api/roms?room=<id> -> { roms: [{ id, title, size, chunks }] }
// La biblioteca de una sala: las ROMs que le subió quien administra el sitio.
import { currentUser, database, json, requestedRoom, type Context } from '../../../server/lib';

export async function onRequestGet({ request, env }: Context): Promise<Response> {
  const db = await database(env);
  if (!db) return json({ error: 'not-configured' }, 501);
  const user = await currentUser(request, db);
  if (!user) return json({ error: 'unauthorized' }, 401);
  const room = await requestedRoom(db, request, user);
  if (!room) return json({ error: 'no-room' }, 404);

  const { results } = await db
    .prepare(
      'SELECT r.id AS id, r.title AS title, r.size AS size, r.chunks AS chunks FROM roms r ' +
        'JOIN room_roms rr ON rr.rom_id = r.id WHERE rr.room_id = ? AND r.ready = 1 ORDER BY r.created_at',
    )
    .bind(room.id)
    .all<{ id: string; title: string; size: number; chunks: number }>();
  return json({ roms: results });
}
