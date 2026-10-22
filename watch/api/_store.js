// Tiny Redis client over the Upstash REST API (no dependencies). Works with the Upstash
// integration on Vercel, which sets KV_REST_API_URL/TOKEN (or UPSTASH_REDIS_REST_URL/TOKEN).
// Without those env vars, calls are no-ops so the site still works.

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
export const connected = Boolean(URL_ && TOKEN);

/** Run several Redis commands in one round trip. Returns their results (or nulls if not connected). */
export async function redis(...commands) {
  if (!connected) return commands.map(() => null);
  const r = await fetch(`${URL_}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!r.ok) throw new Error(`redis ${r.status}`);
  return (await r.json()).map((x) => x.result);
}

export const day = (d = new Date()) => d.toISOString().slice(0, 10);

export async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = '';
  for await (const c of req) raw += c;
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}
