// El historial de una sala.
//
//   GET  /api/events?room=<id>  -> { events: [{ id, username, type, at, data, image, appeal }], lives }
//   POST /api/events            -> anota una muerte: { game, mon, enemy, poisoned, badges, image }
//                                  (la sala sale de la ROM, no de lo que diga el cliente)
import {
  EVENT_IN_ROOM,
  addEvent,
  announce,
  canEnter,
  currentUser,
  database,
  json,
  readBody,
  requestedRoom,
  roomOfGame,
  type Context,
} from '../../../server/lib';
import { deathCard } from '../../../server/discord';

interface Row {
  id: number;
  username: string | null;
  type: string;
  created_at: number;
  data: string;
  has_image: number;
  appeal_status: string | null;
  appeal_reason: string | null;
}

const MAX_IMAGE = 200 * 1024;

function decodeBase64(text: string): ArrayBuffer | null {
  try {
    const bin = atob(text);
    if (bin.length === 0 || bin.length > MAX_IMAGE) return null;
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    // Sólo PNG.
    return bytes[0] === 0x89 && bytes[1] === 0x50 ? bytes.buffer : null;
  } catch {
    return null;
  }
}

const int = (value: unknown, min: number, max: number) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};

export async function onRequest({ request, env }: Context): Promise<Response> {
  const db = await database(env);
  if (!db) return json({ error: 'not-configured' }, 501);
  const user = await currentUser(request, db);
  if (!user) return json({ error: 'unauthorized' }, 401);

  if (request.method === 'GET') {
    const room = await requestedRoom(db, request, user);
    if (!room) return json({ error: 'no-room' }, 404);
    const { results } = await db
      .prepare(
        'SELECT e.id AS id, u.username AS username, e.type AS type, e.created_at AS created_at, e.data AS data, ' +
          '(e.image IS NOT NULL) AS has_image, a.status AS appeal_status, a.reason AS appeal_reason ' +
          'FROM events e LEFT JOIN users u ON u.id = e.user_id LEFT JOIN appeals a ON a.event_id = e.id ' +
          `WHERE ${EVENT_IN_ROOM} ORDER BY e.id DESC LIMIT 150`,
      )
      .bind(room.id)
      .all<Row>();
    const events = results.map((r) => {
      let data: unknown = {};
      try {
        data = JSON.parse(r.data);
      } catch {
        /* dato ilegible */
      }
      return {
        id: r.id,
        username: r.username,
        type: r.type,
        at: r.created_at,
        data,
        image: !!r.has_image,
        appeal: r.appeal_status ? { status: r.appeal_status, reason: r.appeal_reason ?? '' } : null,
      };
    });
    return json({ events, lives: room.lives });
  }

  if (request.method === 'POST') {
    const body = await readBody(request);
    const mon = (body.mon ?? {}) as Record<string, unknown>;
    const enemy = (body.enemy ?? null) as Record<string, unknown> | null;
    const game = String(body.game ?? '');
    const key = String(mon.key ?? '');
    const species = int(mon.species, 1, 411);
    const level = int(mon.level, 1, 100);
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(game) || !/^[0-9a-f]{16}$/.test(key) || !species || !level) {
      return json({ error: 'invalid' }, 400);
    }
    // Las bajas sólo cuentan en juegos de una sala en la que esté la cuenta.
    const room = await roomOfGame(db, game);
    if (!room || !(await canEnter(db, user, room))) return json({ error: 'no-room' }, 404);

    const data = {
      game,
      species,
      level,
      nickname: String(mon.nickname ?? '').slice(0, 12),
      enemy:
        enemy && int(enemy.species, 1, 411) && int(enemy.level, 1, 100)
          ? { species: int(enemy.species, 1, 411), level: int(enemy.level, 1, 100), wild: !!enemy.wild }
          : null,
      poisoned: !!body.poisoned,
      badges: int(body.badges, 0, 8) ?? 0,
    };
    const image = typeof body.image === 'string' ? decodeBase64(body.image) : null;
    const added = await addEvent(db, user.id, 'death', `${game}:death:${key}`, data, image);
    if (!added) return json({ ok: true, duplicate: true });

    const deaths = await db
      .prepare(`SELECT COUNT(*) AS n FROM events e WHERE e.user_id = ? AND e.type = 'death' AND ${EVENT_IN_ROOM}`)
      .bind(user.id, room.id)
      .first<{ n: number }>();
    const left = room.lives - (deaths?.n ?? 0);

    await announce(
      db,
      room,
      deathCard({ username: user.username, species, level, nickname: data.nickname, enemy: data.enemy, poisoned: data.poisoned, left, lives: room.lives }),
      image,
    );
    return json({ ok: true, left });
  }

  return json({ error: 'method' }, 405);
}
