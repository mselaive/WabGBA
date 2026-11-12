// Partidas en la nube, una por usuario y por juego.
//
//   GET  /api/save/<juego>?meta=1  -> { savedAt } | 404
//   GET  /api/save/<juego>         -> bytes del .sav (cabecera X-Saved-At) | 404
//   PUT  /api/save/<juego>         -> { savedAt } | 409 { savedAt } si la nube cambió
//
// El PUT manda en `X-Base` la versión de la nube sobre la que se jugó; si la nube ya tiene
// otra, responde 409 salvo `X-Force: 1`.
import { currentUser, database, json, type Context } from '../../../server/lib';
import { readSave } from '../../../src/save';

const MAX_BYTES = 1024 * 1024;

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
      .prepare('SELECT saved_at FROM game_saves WHERE user_id = ? AND name = ?')
      .bind(user.id, name)
      .first<{ saved_at: number }>();
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
    return json({ savedAt });
  }

  return json({ error: 'method' }, 405);
}
