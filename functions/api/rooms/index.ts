// Salas.
//
//   GET  /api/rooms                 -> { rooms } (las de esta cuenta; todas si administra el sitio)
//   POST /api/rooms { name, code }  -> crea una sala (sólo quien administra el sitio)
import {
  DEFAULT_LIVES,
  currentUser,
  database,
  json,
  normalizeCode,
  readBody,
  roomByCode,
  roomsFor,
  type Context,
} from '../../../server/lib';

export async function onRequest({ request, env }: Context): Promise<Response> {
  const db = await database(env);
  if (!db) return json({ error: 'not-configured' }, 501);
  const user = await currentUser(request, db);
  if (!user) return json({ error: 'unauthorized' }, 401);

  if (request.method === 'GET') return json({ rooms: await roomsFor(db, user) });

  if (request.method === 'POST') {
    if (!user.admin) return json({ error: 'forbidden' }, 403);
    const body = await readBody(request);
    const name = String(body.name ?? '').trim().slice(0, 30);
    const code = normalizeCode(String(body.code ?? ''));
    if (!name || !/^[a-z0-9_-]{3,30}$/.test(code)) return json({ error: 'bad-room' }, 400);
    if (await roomByCode(db, code)) return json({ error: 'code-taken' }, 409);

    await db
      .prepare("INSERT INTO rooms (name, code, leader_id, lives, discord, created_at) VALUES (?, ?, NULL, ?, '', ?)")
      .bind(name, code, DEFAULT_LIVES, Date.now())
      .run();
    // Quien la crea no queda como participante: puede ser la sala de otra gente.
    // Si quiere jugar en ella, se suma después.
    const room = await roomByCode(db, code);
    return json({ rooms: await roomsFor(db, user), created: room?.id ?? null });
  }

  return json({ error: 'method' }, 405);
}
