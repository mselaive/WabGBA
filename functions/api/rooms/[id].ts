// PUT /api/rooms/<id> { name?, code?, leader? } -> { rooms }
// Sólo quien administra el sitio: renombra la sala, cambia su código o nombra a su líder.
// `leader` es un nombre de usuario que ya esté en la sala, o vacío para dejarla sin líder.
import {
  currentUser,
  database,
  isMember,
  json,
  normalizeCode,
  readBody,
  roomByCode,
  roomById,
  roomsFor,
  type Context,
} from '../../../server/lib';

export async function onRequestPut({ request, env, params }: Context): Promise<Response> {
  const db = await database(env);
  if (!db) return json({ error: 'not-configured' }, 501);
  const user = await currentUser(request, db);
  if (!user) return json({ error: 'unauthorized' }, 401);
  if (!user.admin) return json({ error: 'forbidden' }, 403);

  const room = await roomById(db, Number(params.id));
  if (!room) return json({ error: 'not-found' }, 404);
  const body = await readBody(request);

  let name = room.name;
  if (typeof body.name === 'string') {
    name = body.name.trim().slice(0, 30);
    if (!name) return json({ error: 'bad-room' }, 400);
  }

  let code = room.code;
  if (typeof body.code === 'string') {
    code = normalizeCode(body.code);
    if (!/^[a-z0-9_-]{3,30}$/.test(code)) return json({ error: 'bad-room' }, 400);
    const other = await roomByCode(db, code);
    if (other && other.id !== room.id) return json({ error: 'code-taken' }, 409);
  }

  let leaderId = room.leader_id;
  if (typeof body.leader === 'string') {
    const username = body.leader.trim().toLowerCase();
    if (!username) leaderId = null;
    else {
      const leader = await db.prepare('SELECT id FROM users WHERE username = ?').bind(username).first<{ id: number }>();
      // Tiene que ser alguien de la sala.
      if (!leader || !(await isMember(db, room.id, leader.id))) return json({ error: 'bad-leader' }, 400);
      leaderId = leader.id;
    }
  }

  await db.prepare('UPDATE rooms SET name = ?, code = ?, leader_id = ? WHERE id = ?').bind(name, code, leaderId, room.id).run();
  return json({ rooms: await roomsFor(db, user) });
}
