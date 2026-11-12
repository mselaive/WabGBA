// Preferencias de cada cuenta (por ahora, los controles), para que viajen entre dispositivos.
//
//   GET /api/prefs  -> { prefs }
//   PUT /api/prefs  -> guarda el JSON que llegue
import { currentUser, database, json, type Context } from '../../server/lib';

export async function onRequest({ request, env }: Context): Promise<Response> {
  const db = await database(env);
  if (!db) return json({ error: 'not-configured' }, 501);
  const user = await currentUser(request, db);
  if (!user) return json({ error: 'unauthorized' }, 401);

  if (request.method === 'GET') {
    const row = await db.prepare('SELECT data FROM prefs WHERE user_id = ?').bind(user.id).first<{ data: string }>();
    let prefs: unknown = {};
    try {
      prefs = row ? JSON.parse(row.data) : {};
    } catch {
      /* preferencias ilegibles: se devuelven vacías */
    }
    return json({ prefs });
  }

  if (request.method === 'PUT') {
    const text = await request.text();
    if (text.length > 4000) return json({ error: 'bad-size' }, 413);
    try {
      JSON.parse(text);
    } catch {
      return json({ error: 'invalid' }, 400);
    }
    await db
      .prepare('INSERT INTO prefs (user_id, data) VALUES (?1, ?2) ON CONFLICT(user_id) DO UPDATE SET data = ?2')
      .bind(user.id, text)
      .run();
    return json({ ok: true });
  }

  return json({ error: 'method' }, 405);
}
