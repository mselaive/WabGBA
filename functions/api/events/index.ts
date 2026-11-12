// El historial de las partidas.
//
//   GET  /api/events  -> { events: [{ id, username, type, at, data, image }], lives }
//   POST /api/events  -> anota una muerte: { game, mon, enemy, poisoned, badges, image }
import { addEvent, announce, currentUser, database, getLives, json, readBody, type Context } from '../../../server/lib';
import { speciesName } from '../../../src/species';

interface Row {
  id: number;
  username: string | null;
  type: string;
  created_at: number;
  data: string;
  has_image: number;
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
    const { results } = await db
      .prepare(
        'SELECT e.id AS id, u.username AS username, e.type AS type, e.created_at AS created_at, e.data AS data, ' +
          '(e.image IS NOT NULL) AS has_image FROM events e LEFT JOIN users u ON u.id = e.user_id ' +
          'ORDER BY e.id DESC LIMIT 150',
      )
      .all<Row>();
    const events = results.map((r) => {
      let data: unknown = {};
      try {
        data = JSON.parse(r.data);
      } catch {
        /* dato ilegible */
      }
      return { id: r.id, username: r.username, type: r.type, at: r.created_at, data, image: !!r.has_image };
    });
    return json({ events, lives: await getLives(db) });
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
      .prepare("SELECT COUNT(*) AS n FROM events WHERE user_id = ? AND type = 'death'")
      .bind(user.id)
      .first<{ n: number }>();
    const left = (await getLives(db)) - (deaths?.n ?? 0);

    const name = speciesName(species);
    const who =
      data.nickname && data.nickname.toLowerCase() !== name.toLowerCase()
        ? `**${data.nickname}** (${name}, nv ${level})`
        : `**${name}** (nv ${level})`;
    const versus = data.enemy
      ? ` contra un ${speciesName(data.enemy.species!)}${data.enemy.wild ? ' salvaje' : ''} nv ${data.enemy.level}`
      : '';
    const closing = left > 0 ? `Le quedan ${left} ${left === 1 ? 'vida' : 'vidas'}.` : '☠️ **Se quedó sin vidas.**';
    await announce(db, `💀 **${user.username}** perdió a ${who}${versus}. ${closing}`, image);
    return json({ ok: true, left });
  }

  return json({ error: 'method' }, 405);
}
