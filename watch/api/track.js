// POST /api/track {event, uid}: anonymous usage counting. No personal data: uid is a random
// id kept in the visitor's browser. Counts per day plus unique visitors (HyperLogLog).
import { redis, day, readJson } from './_store.js';

export const EVENTS = ['visit', 'app_open', 'setup_done', 'watch_click', 'checkup_view', 'waitlist'];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  const { event, uid } = await readJson(req);
  if (!EVENTS.includes(event) || !/^[a-z0-9]{6,24}$/.test(String(uid || ''))) return res.status(400).json({ ok: false });
  const d = day();
  try {
    await redis(
      ['INCR', `count:${event}:${d}`],
      ['INCR', `count:${event}:all`],
      ['PFADD', `uniq:${event}:${d}`, uid],
      ['PFADD', `uniq:${event}:all`, uid],
      ['EXPIRE', `count:${event}:${d}`, 60 * 60 * 24 * 120],
      ['EXPIRE', `uniq:${event}:${d}`, 60 * 60 * 24 * 120],
    );
  } catch { /* counting must never break the site */ }
  res.status(200).json({ ok: true });
}
