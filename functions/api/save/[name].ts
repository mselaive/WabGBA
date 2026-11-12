// Partidas en la nube, una por usuario y por juego.
//
//   GET  /api/save/<juego>?meta=1  -> { savedAt } | 404
//   GET  /api/save/<juego>         -> bytes del .sav (cabecera X-Saved-At) | 404
//   PUT  /api/save/<juego>         -> { savedAt } | 409 { savedAt } si la nube cambió
//
// El PUT manda en `X-Base` la versión de la nube sobre la que se jugó; si la nube ya tiene
// otra, responde 409 salvo `X-Force: 1`.
import { addEvent, announce, currentUser, database, json, type Context, type D1, type User } from '../../../server/lib';
import { BADGES } from '../../../src/achievements';
import { readSave, type Progress } from '../../../src/save';

const MAX_BYTES = 1024 * 1024;
/** Medallas en las que toca torneo entre los participantes. */
const TOURNAMENT_AT = [3, 6, 8];

function parseProgress(text: string | null | undefined): Progress | null {
  try {
    return text ? (JSON.parse(text) as Progress) : null;
  } catch {
    return null;
  }
}

/** Compara la partida nueva con la anterior y anota lo que cambió: medallas, Liga, torneos. */
async function announceProgress(db: D1, user: User, game: string, before: Progress | null, now: Progress) {
  for (let i = 0; i < 8; i++) {
    if (!now.badges[i] || before?.badges[i]) continue;
    if (await addEvent(db, user.id, 'badge', `${game}:badge:${i + 1}`, { game, n: i + 1 })) {
      await announce(db, `🏅 **${user.username}** consiguió la Medalla ${BADGES[i]} (${now.badgeCount}/8).`);
    }
  }
  if (now.champion && !before?.champion) {
    if (await addEvent(db, user.id, 'champion', `${game}:champion`, { game })) {
      await announce(db, `👑 **${user.username}** venció a la Liga. ¡Campeón!`);
    }
  }

  // Torneo: cuando todos los que juegan esta ROM llegaron a la medalla 3, 6 u 8.
  if (now.badgeCount === (before?.badgeCount ?? 0)) return;
  const { results } = await db
    .prepare('SELECT u.username AS username, s.progress AS progress FROM game_saves s JOIN users u ON u.id = s.user_id WHERE s.name = ?')
    .bind(game)
    .all<{ username: string; progress: string | null }>();
  const players = results.map((r) => ({ username: r.username, progress: parseProgress(r.progress) })).filter((r) => r.progress);
  if (players.length < 2) return;
  for (const n of TOURNAMENT_AT) {
    if (now.badgeCount < n || !players.every((p) => p.progress!.badgeCount >= n)) continue;
    // Va a nombre del sitio (cuenta 0), así se anota una sola vez.
    const names = players.map((p) => p.username);
    if (await addEvent(db, 0, 'tournament', `${game}:tournament:${n}`, { game, n, players: names })) {
      await announce(db, `⚔️ **¡Torneo!** Todos llegaron a las ${n} medallas: ${names.join(', ')}. A pelear.`);
    }
  }
}

export async function onRequest({ request, env, params }: Context): Promise<Response> {
  const db = await database(env);
  if (!db) return json({ error: 'not-configured' }, 501);
  const user = await currentUser(request, db);
  if (!user) return json({ error: 'unauthorized' }, 401);

  const name = String(params.name);
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) return json({ error: 'bad-name' }, 400);

  if (request.method === 'GET') {
    if (new URL(request.url).searchParams.has('meta')) {
      const row = await db
        .prepare('SELECT saved_at FROM game_saves WHERE user_id = ? AND name = ?')
        .bind(user.id, name)
        .first<{ saved_at: number }>();
      return row ? json({ savedAt: row.saved_at }) : json({ error: 'not-found' }, 404);
    }
    const row = await db
      .prepare('SELECT saved_at, data FROM game_saves WHERE user_id = ? AND name = ?')
      .bind(user.id, name)
      .first<{ saved_at: number; data: ArrayBuffer | number[] }>();
    if (!row) return json({ error: 'not-found' }, 404);
    return new Response(new Uint8Array(row.data), {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Saved-At': String(row.saved_at),
      },
    });
  }

  if (request.method === 'PUT') {
    const body = await request.arrayBuffer();
    if (body.byteLength === 0 || body.byteLength > MAX_BYTES) return json({ error: 'bad-size' }, 413);

    const current = await db
      .prepare('SELECT saved_at, progress FROM game_saves WHERE user_id = ? AND name = ?')
      .bind(user.id, name)
      .first<{ saved_at: number; progress: string | null }>();
    const force = request.headers.get('X-Force') === '1';
    if (current && !force && String(current.saved_at) !== request.headers.get('X-Base')) {
      return json({ error: 'conflict', savedAt: current.saved_at }, 409);
    }

    // El resumen del progreso (medallas, Pokédex…) sale de la partida misma, no de lo que
    // diga el cliente, y es lo que ven los demás en Participantes.
    const parsed = readSave(new Uint8Array(body));
    const progress = parsed.ok ? JSON.stringify(parsed.progress) : null;

    const savedAt = Date.now();
    await db
      .prepare(
        'INSERT INTO game_saves (user_id, name, saved_at, data, progress) VALUES (?1, ?2, ?3, ?4, ?5) ' +
          'ON CONFLICT(user_id, name) DO UPDATE SET saved_at = ?3, data = ?4, progress = ?5',
      )
      .bind(user.id, name, savedAt, body, progress)
      .run();
    if (parsed.ok) await announceProgress(db, user, name, parseProgress(current?.progress), parsed.progress);
    return json({ savedAt });
  }

  return json({ error: 'method' }, 405);
}
