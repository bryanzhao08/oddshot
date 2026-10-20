// Shared helpers for the Tipoff recommender (shots, insights, stories, briefing).
// Pure ES module: no node: imports, so it runs in the browser too (public/standalone.js).

export const MIN = 60_000;
export const HOUR = 60 * MIN;

export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
export const round = (x, k = 3) => (isNum(x) ? Math.round(x * 10 ** k) / 10 ** k : x);
export const toMs = (v) => (v == null ? NaN : typeof v === 'number' ? v : Date.parse(v));
export const uid = () =>
  globalThis.crypto?.randomUUID?.() || `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** Deterministic small hash, so copy variants stay stable for a market across ticks. */
export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
export const pick = (arr, key) => arr[hash(String(key)) % arr.length];
/** pick(), avoiding "Name: ..." templates when the name already contains a colon. */
export function pickFor(arr, key, name) {
  const ok = String(name).includes(':') ? arr.filter((x) => !x.startsWith(`${name}:`)) : arr;
  return pick(ok.length ? ok : arr, key);
}

/**
 * When the market actually resolves (ms or NaN). Polymarket game markets often carry
 * endDate == kickoff; the outcome is only known ~3h later, so use start + game length.
 */
export function effectiveEndMs(market) {
  const end = toMs(market?.endDate);
  const start = toMs(market?.startTime);
  if (market?.category === 'sports' && isNum(start) && (!isNum(end) || end - start < HOUR)) return start + 3 * HOUR;
  return end;
}

/** Accept history as a function, Map, or plain object. Always returns [{t, p}] sorted by t. */
export function historyGetter(history) {
  if (typeof history === 'function') return (id) => history(id) || [];
  if (history instanceof Map) return (id) => history.get(id) || [];
  if (history && typeof history === 'object') return (id) => history[id] || [];
  return () => [];
}

/** Price at or before time t (closest earlier point); falls back to the first point. */
export function priceAt(points, t) {
  if (!points?.length) return NaN;
  let lo = 0;
  let hi = points.length - 1;
  if (points[0].t > t) return NaN;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (points[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return points[lo].p;
}

/** Change of the latest price vs the price `ms` ago. null if history doesn't reach back far enough (≥ 60%). */
export function changeOver(points, ms, now, current) {
  if (!points?.length) return null;
  const p = isNum(current) ? current : points[points.length - 1].p;
  const t = now - ms;
  if (points[0].t > t) {
    const covered = now - points[0].t;
    if (covered < ms * 0.6) return null;
    return p - points[0].p;
  }
  return p - priceAt(points, t);
}

/** Min/max of p over [now - ms, now]. */
export function rangeOver(points, ms, now) {
  let lo = Infinity;
  let hi = -Infinity;
  let loT = null;
  let hiT = null;
  for (let i = points.length - 1; i >= 0; i--) {
    const q = points[i];
    if (q.t < now - ms) break;
    if (q.p < lo) [lo, loT] = [q.p, q.t];
    if (q.p > hi) [hi, hiT] = [q.p, q.t];
  }
  return { lo, hi, loT, hiT };
}

/** Resample to a fixed grid (step ms) over [now - ms, now], forward-filling. */
export function resample(points, ms, now, step = MIN) {
  const out = [];
  if (!points?.length) return out;
  let j = -1;
  const start = now - ms;
  for (let g = start; g <= now + 1; g += step) {
    while (j + 1 < points.length && points[j + 1].t <= g) j++;
    if (j >= 0) out.push(points[j].p);
  }
  return out;
}

/** Per-minute stdev of 1-min returns over a window. NaN when too little data. */
export function volPerMin(points, ms, now) {
  const xs = resample(points, ms, now, MIN);
  if (xs.length < 6) return NaN;
  const r = [];
  for (let i = 1; i < xs.length; i++) r.push(xs[i] - xs[i - 1]);
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / r.length);
}

/** Minutes of history available. */
export const historyMinutes = (points, now) => (points?.length ? Math.max(0, (now - points[0].t) / MIN) : 0);

/** Count 50% crossings within a window (with a 1.5-pt hysteresis so noise at 50.0 doesn't count). */
export function crossings50(points, ms, now) {
  let side = 0;
  let n = 0;
  let lastT = null;
  for (const q of points) {
    if (q.t < now - ms) continue;
    const s = q.p >= 0.515 ? 1 : q.p <= 0.485 ? -1 : 0;
    if (!s) continue;
    if (side && s !== side) {
      n++;
      lastT = q.t;
    }
    side = s;
  }
  return { n, lastT };
}

/** Efficiency ratio: |net move| / total path length, 0..1 (1 = straight line). */
export function efficiency(points, ms, now) {
  const xs = resample(points, ms, now, MIN);
  if (xs.length < 5) return 0;
  let path = 0;
  for (let i = 1; i < xs.length; i++) path += Math.abs(xs[i] - xs[i - 1]);
  return path > 0 ? Math.abs(xs[xs.length - 1] - xs[0]) / path : 0;
}

// ---------- text ----------

export const pct = (p) => {
  const v = p * 100;
  if (v > 0 && v < 1) return '<1%';
  if (v < 100 && v > 99) return '>99%';
  return `${Math.round(v)}%`;
};
export const pts = (d) => {
  const v = Math.round(Math.abs(d) * 100);
  return `${v} pt${v === 1 ? '' : 's'}`;
};
export const signedPts = (d) => `${d >= 0 ? '+' : '−'}${pts(d)}`;

export function minutesText(m) {
  m = Math.max(0, Math.round(m));
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h >= 48) return `${Math.round(h / 24)} days`;
  return r && h < 6 ? `${h}h ${r}m` : `${h}h`;
}

export function truncate(s, n) {
  s = String(s || '').trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:–-]+$/, '')}…`;
}

const lastName = (s) => {
  const w = String(s).trim().split(/\s+/);
  return w[w.length - 1];
};

/**
 * Split a head-to-head title into its two sides. Handles
 *   "Wuhan Tennis Open: Leylah Fernandez vs Jelena Ostapenko"
 *   "Gea vs Davidovich Fokina: Arthur Gea wins"
 *   "Counter-Strike: Aurora Gaming vs NIP (BO3) - Thunderpick"
 * → { a, b, matchup } or null.
 */
export function parseMatchup(title) {
  const t = String(title || '');
  const re = /([^:]*?)\s+vs\.?\s+([^:?]*)/i;
  // Prefer the segment that actually contains "vs".
  const seg = t.split(/:\s+/).find((x) => /\svs\.?\s/i.test(x));
  if (!seg) return null;
  const mm = re.exec(seg);
  if (!mm) return null;
  const clean = (x) => x.replace(/^will\s+/i, '').replace(/\s+(end in a draw|to advance|to qualify).*$/i, '').replace(/\(.*?\)/g, '').replace(/\s+-\s+.*$/, '').replace(/\s+(wins?|to win)$/i, '').replace(/^(game \d+|match \d+)\s*/i, '').trim();
  const a = clean(mm[1]);
  const b = clean(mm[2]);
  if (!a || !b || a.length > 40 || b.length > 40) return null;
  return { a, b, matchup: `${a} vs ${b}` };
}

/** Does the tracked outcome refer to side x? (token overlap, case-insensitive) */
function refersTo(outcome, side) {
  const o = String(outcome || '').toLowerCase();
  const s = String(side || '').toLowerCase();
  if (!o || !s) return false;
  if (o.includes(s) || s.includes(o)) return true;
  const ot = o.split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  return s.split(/[^a-z0-9]+/).some((w) => w.length > 2 && ot.includes(w));
}

const GENERIC_NAME = /^(fc|afc|sc|cf|ac|as|bc|sk|fk|pfk|kks|hnk|nk|ru|cd|ud|sv|vfb|tsg|rb|club|de|the|team|esports|gaming)$/i;
/** "Tampa Bay Rays" → "Rays", "AS Monaco FC" → "Monaco", "Sunderland AFC" → "Sunderland". */
export function shortSide(x, person = false) {
  return shortSideBase(x, person);
}
function shortSideBase(x, person = false) {
  const words = String(x || '').replace(/\([^)]*\)?/g, '').trim().split(/\s+/).filter(Boolean);
  const core = words.filter((w) => !GENERIC_NAME.test(w.replace(/\.$/, '')));
  const ws = core.length ? core : words;
  const s = ws.join(' ');
  const last = ws[ws.length - 1] || '';
  // Kalshi disambiguates shared cities with a letter ("Los Angeles D"); a lone "D" says nothing.
  if (last.length <= 2 && ws.length > 1) return s;
  return person || ws.length > 2 || s.length > 16 ? last : s;
}
const cleanEvent = (t) => String(t || '').replace(/\s*-\s*(more markets|total corners|player props)$/i, '').trim();
const SUB_RE = /\b(o\/u|over|under|spread|handicap|total|draw|both teams|first|props?)\b|\([+-]\d/i;
const GAME_RE = /\b(game|map|set|quarter|half|period|inning)\s*\d+\s*winner\b/i;

/**
 * Human labels for a market:
 *   name:     short subject ("Fernandez vs Ostapenko", "Rays vs Guardians: O/U 6.5", "Fed decision in October: 25 bps decrease")
 *   yes / no: the two sides when known ("Fernandez"/"Ostapenko", "Over"/"Under"); for Yes/No questions yes = subject||'Yes', no = null
 *   twoSided: true when yes/no are named sides (head-to-head or Over/Under)
 *   matchup:  true when the market belongs to a head-to-head
 *   binary:   true for Yes/No questions
 *   sub:      side market of a game (O/U, spread, draw...) rather than who wins
 *   key:      identity of the underlying matchup across venues ("guardians|rays") or null
 */
export function labels(market) {
  const title = String(market?.title || market?.id || 'This market');
  const outcome = String(market?.outcome || 'Yes');
  const other = market?.otherOutcome ? String(market.otherOutcome) : null;
  const group = market?.groupTitle && market.groupTitle !== title && !/^(match winner|moneyline|winner)$/i.test(market.groupTitle) ? String(market.groupTitle) : null;
  const ev = cleanEvent(market?.eventTitle);
  // Individual sports: players go by surname ("Fernandez vs Ostapenko").
  const person = (market?.tags || []).some((t) => /^(tennis|wta|atp|itf|ufc|mma|boxing|golf|pga|chess|table-tennis)/.test(String(t))) ||
    /tennis|\b(wta|atp|itf)\b|open:/i.test(`${title} ${ev}`);
  const shortSide = (x) => shortSideBase(x, person);
  const muT = parseMatchup(title);
  const mu = parseMatchup(ev) || muT;
  const muName = mu ? `${shortSide(mu.a)} vs ${shortSide(mu.b)}` : null;
  const key = mu ? [shortSide(mu.a), shortSide(mu.b)].map((x) => x.toLowerCase()).sort().join('|') : null;
  const sub = SUB_RE.test(`${title} ${group || ''}`);
  const isYes = /^yes$/i.test(outcome);
  const refersSide = (x) => mu && (refersTo(x, mu.a) || refersTo(x, mu.b));
  const suffix = group && !refersSide(group) ? group : GAME_RE.exec(title)?.[0] || null;
  const withSuffix = (n) => (suffix ? `${n}: ${suffix}` : n);

  if (mu && !isYes && !sub) {
    let yes = null;
    let no = null;
    for (const m of [muT, mu].filter(Boolean)) {
      if (refersTo(outcome, m.a)) [yes, no] = [m.a, m.b];
      else if (refersTo(outcome, m.b)) [yes, no] = [m.b, m.a];
      if (yes) break;
    }
    if (yes) return { name: truncate(withSuffix(muName), 60), yes: shortSide(yes), no: shortSide(no), twoSided: true, matchup: true, binary: false, sub: false, key };
  }
  if (!isYes && other && !/^no$/i.test(other)) {
    // Named two-outcome market such as Over/Under or a handicap.
    const tail = title.includes(': ') ? title.slice(title.lastIndexOf(': ') + 2) : '';
    const name = mu ? `${muName}: ${/\svs\.?\s/i.test(tail) || !tail ? group || tail : tail}` : title.replace(/\?$/, '');
    const side = (x) => (mu && refersSide(x) ? shortSide(x) : x);
    return { name: truncate(name.replace(/:\s*$/, ''), 60), yes: side(outcome), no: side(other), twoSided: true, matchup: Boolean(mu), binary: false, sub: true, key };
  }
  let name;
  if (mu) name = withSuffix(muName);
  else if (group && ev && ev !== title) name = `${ev}: ${group}`;
  else name = title.replace(/\?$/, '').replace(/^Will (the )?/i, (m0, the) => (the ? 'The ' : '')).replace(/^(\w)/, (c) => c.toUpperCase());
  let subject = group || (!isYes ? outcome : null);
  if (subject && /\(.*\svs\.?\s.*\)?/i.test(subject)) subject = subject.replace(/\s*\(.*$/, '').trim() || subject;
  if (subject && mu && refersSide(subject) && !sub) subject = shortSide(subject);
  if (subject && name.endsWith(`: ${subject}`)) name = name.slice(0, -(subject.length + 2));
  return { name: truncate(name, 60), yes: subject ? truncate(subject, 32) : 'Yes', no: null, twoSided: false, matchup: Boolean(mu), binary: true, sub, key, subject };
}

/** The side currently favored. For Yes/No questions the "No" side is described relative to the subject. */
export function leader(market, p = market.probability) {
  const L = labels(market);
  if (L.twoSided) return p >= 0.5 ? { name: L.yes, prob: p, isYes: true, labels: L } : { name: L.no, prob: 1 - p, isYes: false, labels: L };
  return p >= 0.5 ? { name: L.yes, prob: p, isYes: true, labels: L } : { name: L.subject ? `not ${L.yes}` : 'No', prob: 1 - p, isYes: false, labels: L };
}

/** "Rays'" / "Guardians'" / "Fernandez's" */
export const poss = (s) => (/s$/i.test(s) ? `${s}'` : `${s}'s`);

export function moveVerb(d) {
  const a = Math.abs(d);
  if (d > 0) return a >= 0.15 ? 'surged' : a >= 0.08 ? 'climbed' : 'edged up';
  return a >= 0.15 ? 'collapsed' : a >= 0.08 ? 'slid' : 'dipped';
}

const STOP = new Set(
  'will the a an of in on at to by for and or be is are was with after before than from this that who what which win wins winner won 2025 2026 2027 2028 yes no vs match game market markets price above below over under reach hit end more less there their into out up down any its it as not afc club united city real sporting fc sc'.split(' '),
);

/** Significant lowercase tokens of a title. */
export function keywords(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .split(/[^a-z0-9.%$]+/)
    .filter((w) => w.length > 2 && !STOP.has(w) && !/^\d{1,2}$/.test(w));
}

export function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Interest weight from 24h volume, 0.25..1 (log scale; ~$5M saturates). */
export function interest(volume24h) {
  const v = Math.max(0, Number(volume24h) || 0);
  return clamp(Math.log10(v + 1) / Math.log10(5e6), 0.25, 1);
}

export function money(v) {
  v = Number(v) || 0;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`;
  if (v >= 1e3) return `$${Math.round(v / 1e3)}k`;
  return `$${Math.round(v)}`;
}
