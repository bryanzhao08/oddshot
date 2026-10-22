// GET /api/stats (header "Authorization: Bearer <STATS_TOKEN>"): private usage numbers.
import { redis, day, connected } from './_store.js';
import { EVENTS } from './track.js';

export default async function handler(req, res) {
  const token = process.env.STATS_TOKEN;
  const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token || given !== token) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!connected) return res.status(200).json({ ok: true, connected: false });
  const days = [...Array(14)].map((_, i) => day(new Date(Date.now() - i * 86400e3)));
  const cmds = [];
  for (const ev of EVENTS) {
    cmds.push(['GET', `count:${ev}:all`], ['PFCOUNT', `uniq:${ev}:all`], ['PFCOUNT', ...days.slice(0, 7).map((d) => `uniq:${ev}:${d}`)]);
    for (const d of days) cmds.push(['PFCOUNT', `uniq:${ev}:${d}`]);
  }
  cmds.push(['HLEN', 'waitlist'], ['GET', 'count:waitlist_plan:yearly'], ['GET', 'count:waitlist_plan:monthly'], ['HVALS', 'waitlist']);
  const out = await redis(...cmds);
  let i = 0;
  const events = {};
  for (const ev of EVENTS) {
    events[ev] = { total: Number(out[i++] || 0), unique: Number(out[i++] || 0), unique7d: Number(out[i++] || 0),
      daily: days.map((d) => ({ day: d, unique: Number(out[i++] || 0) })).reverse() };
  }
  const [count, yearly, monthly, vals] = out.slice(i);
  const recent = (vals || []).map((v) => JSON.parse(v)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50);
  res.status(200).json({ ok: true, connected: true, events, waitlist: { count: Number(count || 0), yearly: Number(yearly || 0), monthly: Number(monthly || 0), recent } });
}
