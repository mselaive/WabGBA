// Reglas de una sala. Las lee cualquiera de la sala; las cambia su líder o quien administra el sitio.
//
//   GET /api/settings?room=<id>                      -> { lives, discord, webhook? }
//   PUT /api/settings?room=<id> { lives, webhook }   -> guarda
import {
  announce,
  canModerate,
  currentUser,
  database,
  isDiscordWebhook,
  json,
  readBody,
  requestedRoom,
  type Context,
} from '../../server/lib';

export async function onRequest({ request, env }: Context): Promise<Response> {
  const db = await database(env);
  if (!db) return json({ error: 'not-configured' }, 501);
  const user = await currentUser(request, db);
  if (!user) return json({ error: 'unauthorized' }, 401);
  const room = await requestedRoom(db, request, user);
  if (!room) return json({ error: 'no-room' }, 404);

  if (request.method === 'GET') {
    // La dirección del webhook permite publicar en el canal: sólo la ve quien decide las reglas.
    return json({ lives: room.lives, discord: !!room.discord, ...(canModerate(user, room) ? { webhook: room.discord } : {}) });
  }

  if (request.method === 'PUT') {
    if (!canModerate(user, room)) return json({ error: 'forbidden' }, 403);
    const body = await readBody(request);
    const lives = Number(body.lives);
    const webhook = String(body.webhook ?? '').trim();
    if (!Number.isInteger(lives) || lives < 1 || lives > 99) return json({ error: 'invalid' }, 400);
    if (webhook && !isDiscordWebhook(webhook)) return json({ error: 'bad-webhook' }, 400);

    await db.prepare('UPDATE rooms SET lives = ?, discord = ? WHERE id = ?').bind(lives, webhook, room.id).run();
    if (webhook && webhook !== room.discord) {
      await announce(
        db,
        { ...room, discord: webhook },
        `🎮 WabGBA quedó conectado a este canal para la sala **${room.name}**. Acá van a caer las muertes, las medallas y los torneos.`,
      );
    }
    return json({ ok: true });
  }

  return json({ error: 'method' }, 405);
}
