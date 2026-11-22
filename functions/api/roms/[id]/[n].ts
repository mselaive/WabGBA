// Un trozo de una ROM de la biblioteca.
//
//   GET /api/roms/<id>/<n>  -> bytes (cuentas de la sala de esa ROM)
//   PUT /api/roms/<id>/<n>  -> lo guarda (sólo quien administra el sitio)
//
// Los trozos de las ROMs de DS viajan y se guardan como texto (base64). Pasarle bytes a la
// base le cuesta al servidor mucho tiempo de cómputo, y con cientos de trozos seguidos el
// plan gratuito corta con un 503; un texto pasa casi gratis. El navegador hace la conversión.
import { canEnter, chunkStore, currentUser, database, json, roomOfGame, type Context } from '../../../../server/lib';

const CHUNK_BYTES = 1024 * 1024;
/** Tope de un trozo de DS ya convertido a texto (512 KB en base64, con margen). */
const NDS_TEXT_MAX = 720 * 1024;

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
    const rom = await db
      .prepare('SELECT console FROM roms WHERE id = ? AND ready = 1')
      .bind(id)
      .first<{ console: string }>();
    if (!rom) return json({ error: 'not-found' }, 404);
    const row = await (await chunkStore(env, rom.console))
      .prepare('SELECT data FROM rom_chunks WHERE rom_id = ? AND n = ?')
      .bind(id, n)
      .first<{ data: ArrayBuffer | number[] | string }>();
    if (!row) return json({ error: 'not-found' }, 404);
    if (typeof row.data === 'string') {
      return new Response(row.data, {
        headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'private, max-age=31536000' },
      });
    }
    return new Response(new Uint8Array(row.data), {
      // El trozo no cambia nunca para ese id: el navegador puede guardarlo.
      headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, max-age=31536000' },
    });
  }

  if (request.method === 'PUT') {
    if (!user.admin) return json({ error: 'forbidden' }, 403);
    const rom = await db
      .prepare('SELECT chunks, console FROM roms WHERE id = ?')
      .bind(id)
      .first<{ chunks: number; console: string }>();
    if (!rom) return json({ error: 'not-found' }, 404);
    let body: ArrayBuffer | string;
    if (rom.console === 'nds') {
      body = await request.text();
      if (n >= rom.chunks || body.length === 0 || body.length > NDS_TEXT_MAX) return json({ error: 'bad-size' }, 413);
    } else {
      body = await request.arrayBuffer();
      if (n >= rom.chunks || body.byteLength === 0 || body.byteLength > CHUNK_BYTES) {
        return json({ error: 'bad-size' }, 413);
      }
    }
    await (await chunkStore(env, rom.console))
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
