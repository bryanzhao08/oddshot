// InsightEngine: narrative cards about what the crowd is thinking, emitted when detected.
// Pure ES module (browser-safe).

import {
  MIN, HOUR, isNum, round, toMs, uid, historyGetter, priceAt, volPerMin, historyMinutes,
  rangeOver, pct, pts, signedPts, minutesText, labels, leader, moveVerb, keywords, jaccard, parseMatchup, poss,
} from './util.js';

export const INSIGHT_TYPES = ['lead-change', 'upset-brewing', 'lock-in', 'calm-before-storm', 'belief-shift', 'story', 'divergence'];

// Per-type dedupe TTL (per market + type). Contract minimum is 30 min; slow-moving
// conditions (a quiet pre-game market, a 6h shift) would otherwise repeat every 30 min.
const TTL = {
  'lead-change': 30 * MIN,
  'upset-brewing': 30 * MIN,
  'lock-in': 30 * MIN,
  'calm-before-storm': 3 * HOUR,
  'belief-shift': 3 * HOUR,
  divergence: HOUR,
  story: 30 * MIN,
};
const MIN_VOLUME = 2_000; // ignore thin markets entirely
const MAX_BUFFER = 300;

const iso = (ms) => new Date(ms).toISOString();

export class InsightEngine {
  constructor(opts = {}) {
    this.opts = { bufferSize: MAX_BUFFER, minVolume: MIN_VOLUME, ...opts };
    this.recent = []; // newest first, ring buffer
    this.lastFired = new Map(); // `${marketKey}|${type}` -> ms
    this.lastP = new Map(); // id -> previous tick probability
    this.pairs = null; // cached divergence matches
    this.pairsAt = 0;
    this.pairsSig = '';
  }

  /** Restore dedupe state (and the buffer) from persisted insights, newest first. */
  restore(insights = []) {
    for (const ins of insights.slice(0, this.opts.bufferSize)) {
      this.recent.push(ins);
      const t = toMs(ins.createdAt);
      const k = `${(ins.marketIds || []).join(',')}|${ins.type}`;
      if (isNum(t) && !(this.lastFired.get(k) > t)) this.lastFired.set(k, t);
    }
  }

  list(limit = 50) {
    return this.recent.slice(0, Math.max(0, limit));
  }

  _push(ins, now) {
    const k = `${ins.marketIds.join(',')}|${ins.type}`;
    const prev = this.lastFired.get(k);
    if (isNum(prev) && now - prev < (TTL[ins.type] || 30 * MIN)) return null;
    this.lastFired.set(k, now);
    this.recent.unshift(ins);
    if (this.recent.length > this.opts.bufferSize) this.recent.length = this.opts.bufferSize;
    return ins;
  }

  _make(type, market, fields, now) {
    return {
      id: uid(),
      type,
      title: fields.title,
      body: fields.body,
      marketIds: fields.marketIds || [market.id],
      category: market.category || 'other',
      severity: fields.severity || 'info',
      createdAt: iso(now),
      data: {
        source: market.source,
        url: market.url,
        live: Boolean(market.live),
        probability: market.probability,
        ...fields.data,
      },
    };
  }

  /** Add an externally-built insight (e.g. a story) through dedupe + buffer. */
  add(ins, now = Date.now()) {
    return this._push(ins, now);
  }

  /**
   * Process one tick. Returns Insight[] newly emitted.
   * ctx: { history: fn|Map|object, spikes: Spike[], now }
   */
  update(markets, ctx = {}) {
    const now = ctx.now ?? Date.now();
    const getHist = historyGetter(ctx.history);
    const out = [];
    const emit = (ins) => {
      const r = ins && this._push(ins, now);
      if (r) out.push(r);
    };
    const spikeBy = new Map((ctx.spikes || []).map((s) => [s.marketId, s]));

    for (const m of markets || []) {
      if (!m?.id || !(m.probability >= 0 && m.probability <= 1)) continue;
      const prevTick = this.lastP.get(m.id);
      this.lastP.set(m.id, m.probability);
      if ((m.volume24h || 0) < this.opts.minVolume) continue;
      const h = getHist(m.id);
      if (!h.length) continue;
      try {
        // One card per market per tick: the most specific story wins
        // (an upset beats a plain lead change, which beats a lock-in, ...).
        const before = out.length;
        for (const fn of [
          () => this._upset(m, h, now),
          () => this._leadChange(m, h, now, prevTick, spikeBy.get(m.id)),
          () => this._lockIn(m, h, now, prevTick),
          () => this._beliefShift(m, h, now),
          () => this._calm(m, h, now),
        ]) {
          emit(fn());
          if (out.length > before) break;
        }
      } catch {
        /* one bad market never breaks the tick */
      }
    }
    try {
      for (const ins of this._divergence(markets || [], now)) emit(ins);
    } catch {}
    return out;
  }

  // Probability ~10 min ago (or previous tick), for crossing checks.
  _ref(h, now, prevTick, ms = 10 * MIN) {
    const r = priceAt(h, now - ms);
    if (isNum(r)) return r;
    if (h.length >= 2 && now - h[0].t >= 2 * MIN) return h[0].p;
    return isNum(prevTick) ? prevTick : NaN;
  }

  _leadChange(m, h, now, prevTick, spike) {
    const p = m.probability;
    const ref = this._ref(h, now, prevTick);
    if (!isNum(ref)) return null;
    // Need a decisive cross: from ≤ 48% to ≥ 52% (or vice versa).
    const crossedUp = ref <= 0.48 && p >= 0.52;
    const crossedDown = ref >= 0.52 && p <= 0.48;
    if (!crossedUp && !crossedDown) return null;
    const L = labels(m);
    const lead = leader(m, p);
    const before = leader(m, ref);
    const d = p - ref;
    const mins = Math.round((now - Math.max(h[0].t, now - 10 * MIN)) / MIN) || 10;
    const severity = Math.abs(d) >= 0.12 || (m.live && Math.abs(d) >= 0.08) ? 'major' : m.live || spike ? 'notable' : 'info';
    const sides = L.twoSided && !L.sub;
    const title = sides
      ? `Lead change: ${lead.name} now ahead in ${L.name}`
      : L.twoSided ? `${L.name} flips to ${lead.name}` : `${L.name}: ${L.yes === 'Yes' ? (lead.isYes ? 'Yes' : 'No') + ' now favored' : `${L.yes} ${lead.isYes ? 'now favored' : 'no longer favored'}`}`;
    const body = L.twoSided
      ? `${before.name} went from favorite to underdog in about ${minutesText(mins)}: ${lead.name} now ${pct(lead.prob)}, up from ${pct(1 - before.prob)} (${pts(d)} swing).${m.live ? ' It is live.' : ''}`
      : `${L.yes} ${pct(ref)} → ${pct(p)} in about ${minutesText(mins)}, crossing 50% (${signedPts(d)}).${m.live ? ' It is live.' : ''}`;
    return this._make('lead-change', m, { title, body, severity, data: { from: ref, to: p, delta: round(d, 4), leader: lead.name } }, now);
  }

  _upset(m, h, now) {
    const start = toMs(m.startTime);
    const started = m.live || (isNum(start) && start <= now);
    if (!started) return null;
    // Favorite at the start of the 30-min window (or at kickoff if that's within it).
    const ref = priceAt(h, isNum(start) && start > now - 30 * MIN ? start : now - 30 * MIN);
    if (!isNum(ref)) return null;
    const favYes = ref >= 0.5;
    const favRef = favYes ? ref : 1 - ref;
    const favNow = favYes ? m.probability : 1 - m.probability;
    const slide = favRef - favNow;
    if (favRef < 0.65 || slide < 0.08) return null;
    const L = labels(m);
    if (L.sub) return null; // O/U and spreads drifting isn't an "upset"
    if (!L.twoSided && (!favYes || L.yes === 'Yes')) return null; // need a named favorite
    const fav = favYes ? L.yes : L.no;
    const dog = L.twoSided ? (favYes ? L.no : L.yes) : null;
    const severity = favNow < 0.5 ? 'major' : slide >= 0.15 ? 'major' : 'notable';
    const title = favNow < 0.05
      ? `Upset: ${fav} collapsed from ${pct(favRef)} to ${pct(favNow)} in ${L.name}`
      : favNow < 0.5
        ? dog ? `Upset in progress: ${dog} now leads ${L.name}` : `Upset in progress: ${fav} no longer favored in ${L.name}`
        : `Upset brewing in ${L.name}`;
    const body = `${fav} came in at ${pct(favRef)} but has slid ${pts(slide)} to ${pct(favNow)} in the last 30 min.${dog ? ` ${dog} is gaining.` : ''}`;
    return this._make('upset-brewing', m, { title, body, severity, data: { favorite: fav, from: favRef, to: favNow, delta: round(-slide, 4) } }, now);
  }

  _lockIn(m, h, now, prevTick) {
    const p = m.probability;
    const ref = isNum(prevTick) ? prevTick : this._ref(h, now, prevTick, 5 * MIN);
    if (!isNum(ref)) return null;
    const up = ref < 0.9 && p >= 0.9;
    const down = ref > 0.1 && p <= 0.1;
    if (!up && !down) return null;
    // Ignore markets that just hover around the line: it must have been clearly below within 30 min.
    const r = rangeOver(h, 30 * MIN, now);
    if (up && !(r.lo <= 0.87)) return null;
    if (down && !(r.hi >= 0.13)) return null;
    const L = labels(m);
    const lead = leader(m, p);
    const was = up ? r.lo : 1 - r.hi;
    const sides = L.twoSided && !L.sub;
    const stateNow = L.twoSided ? `${lead.name} ${pct(lead.prob)}` : `${L.yes} ${pct(p)}`;
    const title = sides ? `${lead.name} is closing it out in ${L.name}` : `${L.name}: ${stateNow}, all but settled`;
    const body = L.twoSided || up
      ? `The crowd now gives ${L.twoSided ? lead.name : L.yes} ${pct(L.twoSided ? lead.prob : p)}, up from ${pct(was)} within 30 min. It looks decided unless something dramatic happens.`
      : `${L.yes} is down to ${pct(p)}, from ${pct(r.hi)} within 30 min. The crowd has all but ruled it out.`;
    return this._make('lock-in', m, { title, body, severity: m.live ? 'notable' : 'info', data: { from: ref, to: p, delta: round(p - ref, 4), leader: lead.name } }, now);
  }

  _calm(m, h, now) {
    const start = toMs(m.startTime);
    if (!isNum(start)) return null;
    const toStart = (start - now) / MIN;
    if (toStart <= 0 || toStart > 120) return null;
    if (Math.abs(m.probability - 0.5) > 0.15) return null;
    if (historyMinutes(h, now) < 45) return null;
    const v = volPerMin(h, HOUR, now);
    const r = rangeOver(h, HOUR, now);
    if (!isNum(v) || v > 0.0012 || r.hi - r.lo > 0.025) return null;
    const L = labels(m);
    const title = `Calm before the storm: ${L.name}`;
    const body = `Starts in ${minutesText(toStart)} and the line has barely moved (${pct(r.lo)}–${pct(r.hi)} over the past hour) at a near-even ${pct(m.probability)}. Balanced, quiet markets tend to reprice fast once it begins.`;
    return this._make('calm-before-storm', m, { title, body, severity: 'info', data: { startsAt: m.startTime, rangeLo: r.lo, rangeHi: r.hi, volPerMin: round(v, 5) } }, now);
  }

  _beliefShift(m, h, now) {
    const span = now - h[0].t;
    if (span < 3 * HOUR) return null;
    const ms = Math.min(6 * HOUR, span);
    const ref = priceAt(h, now - ms) ?? h[0].p;
    if (!isNum(ref)) return null;
    const d = m.probability - ref;
    if (Math.abs(d) < 0.15) return null;
    // Riding to 0/1 is usually just the event finishing; lock-in covers that moment.
    if (m.probability < 0.03 || m.probability > 0.97) return null;
    // For a game in progress the 6h shift *is* the game; lead-change/upset tell that story.
    const start = toMs(m.startTime);
    if (m.category === 'sports' && (m.live || (isNum(start) && start <= now))) return null;
    const L = labels(m);
    const hours = Math.round(ms / HOUR);
    const severity = Math.abs(d) >= 0.3 ? 'major' : 'notable';
    const subj = L.twoSided && !L.sub
      ? `${poss(L.yes)} chances against ${L.no}`
      : L.yes !== 'Yes' ? (L.matchup ? `${poss(L.yes)} chances in ${L.name}` : `${L.yes} (${L.name})`) : `“${m.title}”`;
    const title = `${L.name}: ${L.yes !== 'Yes' && !(L.twoSided && !L.sub) ? `${L.yes} ` : ''}${pct(ref)} → ${pct(m.probability)} in ${hours}h`;
    const body = `${subj} ${moveVerb(d)} ${pts(d)} over ${hours} hours, from ${pct(ref)} to ${pct(m.probability)}. That's a real change of mind, not a blip.`;
    return this._make('belief-shift', m, { title, body, severity, data: { from: ref, to: m.probability, delta: round(d, 4), hours } }, now);
  }

  // ---------- cross-venue divergence ----------

  _matchPairs(markets, now) {
    const sig = `${markets.length}:${markets[0]?.id}:${markets[markets.length - 1]?.id}`;
    if (this.pairs && now - this.pairsAt < 10 * MIN && sig === this.pairsSig) return this.pairs;
    const poly = [];
    const kal = [];
    for (const m of markets) {
      if ((m.volume24h || 0) < 5_000) continue;
      const info = divergenceKey(m);
      if (!info) continue;
      (m.source === 'polymarket' ? poly : m.source === 'kalshi' ? kal : []).push({ m, ...info });
    }
    const pairs = [];
    for (const a of poly) {
      let best = null;
      for (const b of kal) {
        if (a.m.category !== b.m.category || a.kind !== b.kind) continue;
        const ea = toMs(a.m.endDate);
        const eb = toMs(b.m.endDate);
        if (isNum(ea) && isNum(eb) && Math.abs(ea - eb) > 3 * 24 * HOUR) continue;
        let score;
        let flip = false;
        if (a.kind === 'matchup') {
          // Both sides must match (by surname token); orientation from the tracked outcome.
          const sameA = tokMatch(a.yes, b.yes) && tokMatch(a.no, b.no);
          const crossA = tokMatch(a.yes, b.no) && tokMatch(a.no, b.yes);
          if (!sameA && !crossA) continue;
          flip = crossA && !sameA;
          score = 1;
        } else {
          score = jaccard(a.kw, b.kw);
          if (score < 0.7) continue;
          // Numbers (strikes, dates, thresholds) must agree exactly.
          if (a.nums.join(',') !== b.nums.join(',')) continue;
        }
        if (!best || score > best.score) best = { a: a.m, b: b.m, flip, score };
      }
      if (best) pairs.push(best);
    }
    this.pairs = pairs;
    this.pairsAt = now;
    this.pairsSig = sig;
    return pairs;
  }

  _divergence(markets, now) {
    const byId = new Map(markets.map((m) => [m.id, m]));
    const out = [];
    for (const pr of this._matchPairs(markets, now)) {
      const a = byId.get(pr.a.id);
      const b = byId.get(pr.b.id);
      if (!a || !b) continue;
      const pa = a.probability;
      const pb = pr.flip ? 1 - b.probability : b.probability;
      if (pa < 0.03 || pa > 0.97 || pb < 0.03 || pb > 0.97) continue;
      const gap = pa - pb;
      // ≥ 5 pts is interesting; ≥ 30 pts almost certainly means we matched different questions.
      if (Math.abs(gap) < 0.05 || Math.abs(gap) > 0.3) continue;
      const L = labels(a);
      const hi = gap > 0 ? 'Polymarket' : 'Kalshi';
      const lo = gap > 0 ? 'Kalshi' : 'Polymarket';
      const title = `Venues disagree on ${L.name}`;
      const body = `Polymarket has ${L.yes} at ${pct(pa)}, Kalshi at ${pct(pb)}: a ${pts(gap)} gap. ${hi} traders are more bullish; one side is likely slow to react${a.live ? ' to the live action' : ''}.`;
      const severity = Math.abs(gap) >= 0.12 ? 'notable' : 'info';
      out.push({
        ...this._make('divergence', a, { title, body, severity, marketIds: [a.id, b.id], data: { polymarket: pa, kalshi: pb, gap: round(gap, 4), delta: round(gap, 4), higher: hi, lower: lo, kalshiUrl: b.url } }, now),
      });
    }
    return out;
  }
}

function tokMatch(x, y) {
  const tx = keywords(x);
  const ty = keywords(y);
  return tx.length > 0 && ty.length > 0 && tx.some((w) => ty.includes(w));
}

/** Normalized identity for cross-venue matching, or null if the market can't be matched safely. */
export function divergenceKey(m) {
  const mu = parseMatchup(m.title);
  if (mu) {
    const L = labels(m);
    if (!L.twoSided || L.sub) return null; // spreads/totals: too risky
    // Only straight "who wins" markets.
    if (/spread|over|under|total|handicap|map \d|set \d|game \d+ winner|first/i.test(m.title)) return null;
    return { kind: 'matchup', yes: L.yes, no: L.no };
  }
  if (!/^yes$/i.test(String(m.outcome || ''))) return null;
  const text = String(m.title || '').replace(/federal reserve/gi, 'fed');
  const kw = keywords(text).filter((w) => !/^\d/.test(w));
  const nums = (text.match(/\d+(?:[.,]\d+)?/g) || []).map((x) => x.replace(',', ''));
  if (kw.length < 3) return null;
  return { kind: 'question', kw, nums };
}

