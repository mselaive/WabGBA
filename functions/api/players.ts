// GET /api/players -> { players: [{ username, savedAt, progress, deaths }], lives }
// Todos los que tienen cuenta, con el progreso de su partida guardada más reciente.
import { currentUser, database, getLives, json, type Context } from '../../server/lib';

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
  const deathRows = await db
    .prepare("SELECT u.username AS username, COUNT(*) AS n FROM events e JOIN users u ON u.id = e.user_id WHERE e.type = 'death' GROUP BY u.username")
    .all<{ username: string; n: number }>();
  const deaths = new Map(deathRows.results.map((r) => [r.username, r.n]));

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
  return json({
    players: [...players.values()].map((p) => ({ ...p, deaths: deaths.get(p.username) ?? 0 })),
    lives: await getLives(db),
  });
}
