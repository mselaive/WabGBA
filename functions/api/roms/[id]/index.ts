// Alta y baja de una ROM de la biblioteca. Sólo la cuenta administradora.
//
//   PUT    /api/roms/<id> { title, size, chunks }  -> empieza la subida (borra lo que hubiera)
//   POST   /api/roms/<id>                          -> la publica, si llegaron todos los trozos
//   DELETE /api/roms/<id>                          -> la quita
import { currentUser, database, json, readBody, type Context } from '../../../../server/lib';

/** Tope por ROM: un cartucho de GBA llega a 32 MB. */
const MAX_BYTES = 34 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;

export async function onRequest({ request, env, params }: Context): Promise<Response> {
  const db = await database(env);
  if (!db) return json({ error: 'not-configured' }, 501);
  const user = await currentUser(request, db);
  if (!user) return json({ error: 'unauthorized' }, 401);
  if (!user.admin) return json({ error: 'forbidden' }, 403);

  const id = String(params.id);
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return json({ error: 'bad-name' }, 400);

  if (request.method === 'PUT') {
    const body = await readBody(request);
    const title = String(body.title ?? '').trim().slice(0, 60);
    const size = Number(body.size);
    const chunks = Number(body.chunks);
    if (!title || !Number.isInteger(size) || size <= 0 || size > MAX_BYTES) return json({ error: 'bad-size' }, 413);
    if (chunks !== Math.ceil(size / CHUNK_BYTES)) return json({ error: 'invalid' }, 400);
    await db.batch([
      db.prepare('DELETE FROM rom_chunks WHERE rom_id = ?').bind(id),
      db
        .prepare(
          'INSERT INTO roms (id, title, size, chunks, ready, created_at) VALUES (?1, ?2, ?3, ?4, 0, ?5) ' +
            'ON CONFLICT(id) DO UPDATE SET title = ?2, size = ?3, chunks = ?4, ready = 0',
        )
        .bind(id, title, size, chunks, Date.now()),
    ]);
    return json({ ok: true });
  }

  if (request.method === 'POST') {
    const rom = await db.prepare('SELECT chunks FROM roms WHERE id = ?').bind(id).first<{ chunks: number }>();
    if (!rom) return json({ error: 'not-found' }, 404);
    const have = await db
      .prepare('SELECT COUNT(*) AS n FROM rom_chunks WHERE rom_id = ?')
      .bind(id)
      .first<{ n: number }>();
    if (have?.n !== rom.chunks) return json({ error: 'incomplete' }, 409);
    await db.prepare('UPDATE roms SET ready = 1 WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }

  if (request.method === 'DELETE') {
    await db.batch([
      db.prepare('DELETE FROM rom_chunks WHERE rom_id = ?').bind(id),
      db.prepare('DELETE FROM roms WHERE id = ?').bind(id),
    ]);
    return json({ ok: true });
  }

  return json({ error: 'method' }, 405);
}
