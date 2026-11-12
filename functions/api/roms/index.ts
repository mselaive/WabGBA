// GET /api/roms -> { roms: [{ id, title, size, chunks }] }
// La biblioteca del sitio: las ROMs que subió la cuenta administradora.
import { currentUser, database, json, type Context } from '../../../server/lib';

export async function onRequestGet({ request, env }: Context): Promise<Response> {
  const db = await database(env);
  if (!db) return json({ error: 'not-configured' }, 501);
  if (!(await currentUser(request, db))) return json({ error: 'unauthorized' }, 401);

  const { results } = await db
    .prepare('SELECT id, title, size, chunks FROM roms WHERE ready = 1 ORDER BY created_at')
    .all<{ id: string; title: string; size: number; chunks: number }>();
  return json({ roms: results });
}
