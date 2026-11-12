// API de partidas en la nube (Cloudflare Pages Function + D1).
//
//   GET  /api/save/<juego>?meta=1  -> { savedAt } | 404
//   GET  /api/save/<juego>         -> bytes del .sav (cabecera X-Saved-At) | 404
//   PUT  /api/save/<juego>         -> { savedAt } | 409 { savedAt } si la nube cambió
//
// Todo pide `Authorization: Bearer <SYNC_KEY>`. El PUT manda en `X-Base` la versión de la
// nube sobre la que se jugó; si la nube ya tiene otra, responde 409 salvo `X-Force: 1`.

interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
}
interface Env {
  DB?: { prepare(sql: string): D1Statement };
  SYNC_KEY?: string;
}
interface Context {
  request: Request;
  env: Env;
  params: Record<string, string | string[]>;
}

const MAX_BYTES = 1024 * 1024;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

async function sameKey(a: string, b: string): Promise<boolean> {
  // Comparar los hashes evita filtrar la clave por tiempos de respuesta.
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export async function onRequest({ request, env, params }: Context): Promise<Response> {
  if (!env.DB || !env.SYNC_KEY) return json({ error: 'not-configured' }, 501);

  const auth = request.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ') || !(await sameKey(auth.slice(7), env.SYNC_KEY))) {
    return json({ error: 'unauthorized' }, 401);
  }

  const name = String(params.name);
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) return json({ error: 'bad-name' }, 400);

  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS saves (name TEXT PRIMARY KEY, saved_at INTEGER NOT NULL, data BLOB NOT NULL)',
  ).run();

  if (request.method === 'GET') {
    if (new URL(request.url).searchParams.has('meta')) {
      const row = await env.DB.prepare('SELECT saved_at FROM saves WHERE name = ?')
        .bind(name)
        .first<{ saved_at: number }>();
      return row ? json({ savedAt: row.saved_at }) : json({ error: 'not-found' }, 404);
    }
    const row = await env.DB.prepare('SELECT saved_at, data FROM saves WHERE name = ?')
      .bind(name)
      .first<{ saved_at: number; data: ArrayBuffer | number[] }>();
    if (!row) return json({ error: 'not-found' }, 404);
    return new Response(new Uint8Array(row.data), {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Saved-At': String(row.saved_at),
      },
    });
  }

  if (request.method === 'PUT') {
    const body = await request.arrayBuffer();
    if (body.byteLength === 0 || body.byteLength > MAX_BYTES) return json({ error: 'bad-size' }, 413);

    const current = await env.DB.prepare('SELECT saved_at FROM saves WHERE name = ?')
      .bind(name)
      .first<{ saved_at: number }>();
    const force = request.headers.get('X-Force') === '1';
    if (current && !force && String(current.saved_at) !== request.headers.get('X-Base')) {
      return json({ error: 'conflict', savedAt: current.saved_at }, 409);
    }

    const savedAt = Date.now();
    await env.DB.prepare(
      'INSERT INTO saves (name, saved_at, data) VALUES (?1, ?2, ?3) ' +
        'ON CONFLICT(name) DO UPDATE SET saved_at = ?2, data = ?3',
    )
      .bind(name, savedAt, body)
      .run();
    return json({ savedAt });
  }

  return json({ error: 'method' }, 405);
}
