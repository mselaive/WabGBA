// Un evento del historial.
//
//   GET    /api/events/<id>  -> la captura (PNG), si tiene
//   DELETE /api/events/<id>  -> lo anula (sólo la cuenta administradora)
import { currentUser, database, json, type Context } from '../../../server/lib';

export async function onRequest({ request, env, params }: Context): Promise<Response> {
  const db = await database(env);
  if (!db) return json({ error: 'not-configured' }, 501);
  const user = await currentUser(request, db);
  if (!user) return json({ error: 'unauthorized' }, 401);

  const id = Number(params.id);
  if (!Number.isInteger(id) || id < 1) return json({ error: 'bad-name' }, 400);

  if (request.method === 'GET') {
    const row = await db.prepare('SELECT image FROM events WHERE id = ?').bind(id).first<{ image: ArrayBuffer | number[] | null }>();
    if (!row?.image) return json({ error: 'not-found' }, 404);
    return new Response(new Uint8Array(row.image), {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=31536000' },
    });
  }

  if (request.method === 'DELETE') {
    if (!user.admin) return json({ error: 'forbidden' }, 403);
    await db.prepare('DELETE FROM events WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }

  return json({ error: 'method' }, 405);
}
