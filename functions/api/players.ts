// GET /api/players -> { players: [{ username, savedAt, progress }] }
// Todos los que tienen cuenta, con el progreso de su partida guardada más reciente.
import { currentUser, database, json, type Context } from '../../server/lib';

interface Row {
  username: string;
  saved_at: number | null;
  progress: string | null;
}

export async function onRequestGet({ request, env }: Context): Promise<Response> {
  const db = await database(env);
  if (!db) return json({ error: 'not-configured' }, 501);
  if (!(await currentUser(request, db))) return json({ error: 'unauthorized' }, 401);

  const { results } = await db
    .prepare(
      'SELECT users.username AS username, s.saved_at AS saved_at, s.progress AS progress ' +
        'FROM users LEFT JOIN game_saves s ON s.user_id = users.id ORDER BY s.saved_at DESC',
    )
    .all<Row>();

  // Una fila por usuario: la primera que aparece es la más reciente con progreso legible.
  const players = new Map<string, { username: string; savedAt: number | null; progress: unknown }>();
  for (const row of results) {
    const known = players.get(row.username);
    if (known?.progress) continue;
    let progress: unknown = null;
    try {
      progress = row.progress ? JSON.parse(row.progress) : null;
    } catch {
      /* resumen ilegible: se muestra sin progreso */
    }
    if (!known || progress) players.set(row.username, { username: row.username, savedAt: row.saved_at, progress });
  }
  return json({ players: [...players.values()] });
}
