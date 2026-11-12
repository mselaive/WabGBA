// Reglas del sitio. Las lee cualquiera con cuenta; las cambia la cuenta administradora.
//
//   GET /api/settings                      -> { lives, discord, webhook? }
//   PUT /api/settings { lives, webhook }   -> guarda
import {
  announce,
  currentUser,
  database,
  getLives,
  getSetting,
  isDiscordWebhook,
  json,
  readBody,
  setSetting,
  type Context,
} from '../../server/lib';

export async function onRequest({ request, env }: Context): Promise<Response> {
  const db = await database(env);
  if (!db) return json({ error: 'not-configured' }, 501);
  const user = await currentUser(request, db);
  if (!user) return json({ error: 'unauthorized' }, 401);

  if (request.method === 'GET') {
    const webhook = (await getSetting(db, 'discord')) ?? '';
    // La dirección del webhook permite publicar en el canal: sólo la ve quien administra.
    return json({ lives: await getLives(db), discord: !!webhook, ...(user.admin ? { webhook } : {}) });
  }

  if (request.method === 'PUT') {
    if (!user.admin) return json({ error: 'forbidden' }, 403);
    const body = await readBody(request);
    const lives = Number(body.lives);
    const webhook = String(body.webhook ?? '').trim();
    if (!Number.isInteger(lives) || lives < 1 || lives > 99) return json({ error: 'invalid' }, 400);
    if (webhook && !isDiscordWebhook(webhook)) return json({ error: 'bad-webhook' }, 400);

    const before = (await getSetting(db, 'discord')) ?? '';
    await setSetting(db, 'lives', String(lives));
    await setSetting(db, 'discord', webhook);
    if (webhook && webhook !== before) {
      await announce(db, '🎮 WabGBA quedó conectado a este canal. Acá van a caer las muertes, las medallas y los torneos.');
    }
    return json({ ok: true });
  }

  return json({ error: 'method' }, 405);
}
