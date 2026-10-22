// POST /api/waitlist {email, plan, uid}: saves an early-access sign-up (one entry per email).
import { redis, day, readJson, connected } from './_store.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  const { email, plan, uid } = await readJson(req);
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]{1,64}@[^\s@]{1,255}\.[a-z]{2,}$/i.test(e)) return res.status(400).json({ ok: false, error: 'Please enter a valid email.' });
  const p = plan === 'monthly' ? 'monthly' : 'yearly';
  const entry = JSON.stringify({ email: e, plan: p, at: new Date().toISOString(), uid: /^[a-z0-9]{6,24}$/.test(String(uid || '')) ? uid : null });
  try {
    const [isNew] = await redis(['HSETNX', 'waitlist', e, entry]);
    if (isNew === 1) await redis(['INCR', `count:waitlist_plan:${p}`], ['INCR', `count:waitlist_signups:${day()}`]);
  } catch {
    return res.status(503).json({ ok: false, error: 'Could not save right now. Please try again.' });
  }
  res.status(200).json({ ok: true, stored: connected });
}
