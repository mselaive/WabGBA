// Un trozo de una ROM de la biblioteca.
//
//   GET /api/roms/<id>/<n>  -> bytes (cuentas de la sala de esa ROM)
//   PUT /api/roms/<id>/<n>  -> lo guarda (sólo quien administra el sitio)
import { canEnter, currentUser, database, json, roomOfGame, type Context } from '../../../../server/lib';

const CHUNK_BYTES = 1024 * 1024;

export async function onRequest({ request, env, params }: Context): Promise<Response> {
  const db = await database(env);
  if (!db) return json({ error: 'not-configured' }, 501);
  const user = await currentUser(request, db);
  if (!user) return json({ error: 'unauthorized' }, 401);

  const id = String(params.id);
  const n = Number(params.n);
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || !Number.isInteger(n) || n < 0) return json({ error: 'bad-name' }, 400);

  if (request.method === 'GET') {
    // Sólo descargan la ROM quienes están en su sala.
    const room = await roomOfGame(db, id);
    if (!room || !(await canEnter(db, user, room))) return json({ error: 'not-found' }, 404);
    const row = await db
      .prepare(
        'SELECT c.data AS data FROM rom_chunks c JOIN roms r ON r.id = c.rom_id ' +
          'WHERE c.rom_id = ? AND c.n = ? AND r.ready = 1',
      )
      .bind(id, n)
      .first<{ data: ArrayBuffer | number[] }>();
    if (!row) return json({ error: 'not-found' }, 404);
    return new Response(new Uint8Array(row.data), {
      // El trozo no cambia nunca para ese id: el navegador puede guardarlo.
      headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, max-age=31536000' },
    });
  }

  if (request.method === 'PUT') {
    if (!user.admin) return json({ error: 'forbidden' }, 403);
    const rom = await db.prepare('SELECT chunks FROM roms WHERE id = ?').bind(id).first<{ chunks: number }>();
    if (!rom) return json({ error: 'not-found' }, 404);
    const body = await request.arrayBuffer();
    if (n >= rom.chunks || body.byteLength === 0 || body.byteLength > CHUNK_BYTES) {
      return json({ error: 'bad-size' }, 413);
    }
    await db
      .prepare(
        'INSERT INTO rom_chunks (rom_id, n, data) VALUES (?1, ?2, ?3) ' +
          'ON CONFLICT(rom_id, n) DO UPDATE SET data = ?3',
      )
      .bind(id, n, body)
      .run();
    return json({ ok: true });
  }

  return json({ error: 'method' }, 405);
}
