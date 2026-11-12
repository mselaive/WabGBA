// Un evento del historial.
//
//   GET    /api/events/<id>             -> la captura (PNG), si tiene
//   POST   /api/events/<id> { reason }  -> el dueño pide que se anule (queda en revisión)
//   PUT    /api/events/<id>             -> quien administra rechaza el pedido
//   DELETE /api/events/<id>             -> quien administra lo anula (con o sin pedido)
import { announce, currentUser, database, json, readBody, type Context } from '../../../server/lib';

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

  const event = await db
    .prepare('SELECT e.user_id AS user_id, u.username AS username FROM events e LEFT JOIN users u ON u.id = e.user_id WHERE e.id = ?')
    .bind(id)
    .first<{ user_id: number; username: string | null }>();
  if (!event) return json({ error: 'not-found' }, 404);

  if (request.method === 'POST') {
    // Sólo se puede reclamar lo propio, y una sola vez.
    if (event.user_id !== user.id) return json({ error: 'forbidden' }, 403);
    const known = await db.prepare('SELECT status FROM appeals WHERE event_id = ?').bind(id).first<{ status: string }>();
    if (known) return json({ error: 'taken' }, 409);
    const reason = String((await readBody(request)).reason ?? '').trim().slice(0, 200);
    await db
      .prepare("INSERT INTO appeals (event_id, user_id, reason, status, created_at) VALUES (?, ?, ?, 'pending', ?)")
      .bind(id, user.id, reason, Date.now())
      .run();
    await announce(db, `🙋 **${user.username}** pide anular un evento${reason ? `: “${reason}”` : ''}. Lo decide quien administra.`);
    return json({ ok: true });
  }

  if (!user.admin) return json({ error: 'forbidden' }, 403);

  if (request.method === 'PUT') {
    await db.prepare("UPDATE appeals SET status = 'rejected' WHERE event_id = ?").bind(id).run();
    await announce(db, `🚫 Pedido de anulación de **${event.username ?? '?'}** rechazado. La baja se queda.`);
    return json({ ok: true });
  }

  if (request.method === 'DELETE') {
    const appeal = await db.prepare('SELECT status FROM appeals WHERE event_id = ?').bind(id).first<{ status: string }>();
    await db.batch([
      db.prepare('DELETE FROM appeals WHERE event_id = ?').bind(id),
      db.prepare('DELETE FROM events WHERE id = ?').bind(id),
    ]);
    if (appeal) await announce(db, `✅ Pedido de anulación de **${event.username ?? '?'}** aprobado.`);
    return json({ ok: true });
  }

  return json({ error: 'method' }, 405);
}
