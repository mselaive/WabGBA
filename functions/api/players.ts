// GET /api/players?room=<id> -> { players: [{ username, savedAt, progress, deaths }], lives, leader }
// Los integrantes de una sala, con el progreso de su partida más reciente en las ROMs de esa sala.
import { EVENT_IN_ROOM, currentUser, database, json, requestedRoom, type Context } from '../../server/lib';

interface Row {
  username: string;
  saved_at: number | null;
  progress: string | null;
}

export async function onRequestGet({ request, env }: Context): Promise<Response> {
  const db = await database(env);
  if (!db) return json({ error: 'not-configured' }, 501);
  const user = await currentUser(request, db);
  if (!user) return json({ error: 'unauthorized' }, 401);
  const room = await requestedRoom(db, request, user);
  if (!room) return json({ error: 'no-room' }, 404);

  const { results } = await db
    .prepare(
      'SELECT u.id AS id, u.username AS username, s.saved_at AS saved_at, s.progress AS progress ' +
        'FROM room_members m JOIN users u ON u.id = m.user_id ' +
        'LEFT JOIN game_saves s ON s.user_id = u.id AND s.name IN (SELECT rom_id FROM room_roms WHERE room_id = ?1) ' +
        'WHERE m.room_id = ?1 ORDER BY s.saved_at DESC',
    )
    .bind(room.id)
    .all<Row & { id: number }>();

  const deathRows = await db
    .prepare(
      `SELECT u.username AS username, COUNT(*) AS n FROM events e JOIN users u ON u.id = e.user_id ` +
        `WHERE e.type = 'death' AND ${EVENT_IN_ROOM} GROUP BY u.username`,
    )
    .bind(room.id)
    .all<{ username: string; n: number }>();
  const deaths = new Map(deathRows.results.map((r) => [r.username, r.n]));

  // Una fila por cuenta: la primera que aparece es la más reciente con progreso legible.
  const players = new Map<string, { username: string; savedAt: number | null; progress: unknown }>();
  let leader: string | null = null;
  for (const row of results) {
    if (row.id === room.leader_id) leader = row.username;
    const known = players.get(row.username);
    if (known?.progress) continue;
    let progress: unknown = null;
    try {
      progress = row.progress ? JSON.parse(row.progress) : null;
    } catch {
      /* resumen ilegible: se muestra sin progreso */
    }
    if (!known || progress) players.set(row.username, { username: row.username, savedAt: row.saved_at, progress });
  }
  return json({
    players: [...players.values()].map((p) => ({ ...p, deaths: deaths.get(p.username) ?? 0 })),
    lives: room.lives,
    leader,
  });
}
