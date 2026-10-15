// StoryEngine: clusters of markets that repriced together ("co-movement").
// Pure ES module (browser-safe).

import { MIN, HOUR, clamp, isNum, round, toMs, hash, historyGetter, priceAt, pct, signedPts, minutesText, keywords, labels, truncate } from './util.js';

const WINDOW = 15 * MIN;
const MIN_MOVE = 0.03;
const ACTIVE_MS = 2 * HOUR;

// Tags too broad to say two markets are about the same thing.
const GENERIC_TAGS = new Set(['sports', 'politics', 'crypto', 'economics', 'economy', 'finance', 'business', 'world', 'elections', 'entertainment', 'pop-culture', 'tech', 'science', 'weather', 'other', 'games', 'soccer', 'basketball', 'football', 'tennis', 'esports', 'us-politics', 'geopolitics', 'trump']);

/** Short label for one market inside a story ("25 bps decrease", "Fernandez"). */
function shortLabel(m) {
  if (m.groupTitle && m.groupTitle !== m.title) return truncate(m.groupTitle, 32);
  const L = labels(m);
  if (L.twoSided && !L.sub) return L.yes;
  return truncate(L.yes !== 'Yes' ? L.yes : L.name, 40);
}

function eventTitleOf(ms) {
  const withEv = ms.find((m) => m.eventTitle);
  if (withEv) return withEv.eventTitle;
  // Common leading words of the titles.
  const words = ms.map((m) => String(m.title || '').split(/\s+/));
  const common = [];
  for (let i = 0; i < words[0].length; i++) {
    const w = words[0][i];
    if (words.every((ws) => ws[i] === w)) common.push(w);
    else break;
  }
  if (common.length >= 3) return common.join(' ').replace(/[:,-]+$/, '');
  return labels(ms[0]).name;
}

class DSU {
  constructor(n) {
    this.p = Array.from({ length: n }, (_, i) => i);
  }
  find(x) {
    while (this.p[x] !== x) x = this.p[x] = this.p[this.p[x]];
    return x;
  }
  union(a, b) {
    this.p[this.find(a)] = this.find(b);
  }
}

export class StoryEngine {
  constructor(opts = {}) {
    this.opts = { window: WINDOW, minMove: MIN_MOVE, activeMs: ACTIVE_MS, ...opts };
    this.stories = new Map(); // id -> Story
  }

  /** Active stories (updated in the last 2h), strongest first. */
  list(now = Date.now()) {
    for (const [id, s] of this.stories) if (now - toMs(s.updatedAt) > this.opts.activeMs) this.stories.delete(id);
    return [...this.stories.values()].sort((a, b) => b.strength - a.strength || toMs(b.updatedAt) - toMs(a.updatedAt));
  }

  /**
   * One tick. Returns { created: Story[], updated: Story[] }.
   * ctx: { history: fn|Map|object, now }
   */
  update(markets, ctx = {}) {
    const now = ctx.now ?? Date.now();
    const getHist = historyGetter(ctx.history);
    const movers = [];
    for (const m of markets || []) {
      if (!m?.id || !(m.probability >= 0 && m.probability <= 1)) continue;
      const h = getHist(m.id);
      if (!h.length || now - h[0].t < this.opts.window * 0.6) continue;
      const from = priceAt(h, now - this.opts.window) ?? h[0].p;
      const ref = isNum(from) ? from : h[0].p;
      const delta = m.probability - ref;
      if (Math.abs(delta) < this.opts.minMove) continue;
      // When did the move happen? First point that's already ≥ half of the move away from ref.
      let movedAt = now;
      for (const q of h) {
        if (q.t < now - this.opts.window) continue;
        if (Math.abs(q.p - ref) >= Math.abs(delta) / 2) {
          movedAt = q.t;
          break;
        }
      }
      const tags = (m.tags || []).filter((t) => !GENERIC_TAGS.has(t));
      movers.push({ m, from: ref, to: m.probability, delta, movedAt, kw: keywords(`${m.eventTitle || ''} ${m.title}`), tags });
    }
    if (movers.length < 2) return { created: [], updated: [] };

    const dsu = new DSU(movers.length);
    for (let i = 0; i < movers.length; i++) {
      for (let j = i + 1; j < movers.length; j++) {
        const a = movers[i];
        const b = movers[j];
        if (a.m.eventKey && a.m.eventKey === b.m.eventKey && a.m.source === b.m.source) {
          dsu.union(i, j);
          continue;
        }
        if (a.m.category !== b.m.category) continue;
        // Stories stay within one venue (cross-venue gaps are "divergence" insights).
        if (a.m.source !== b.m.source) continue;
        const la = labels(a.m).key;
        if (la && la === labels(b.m).key) {
          dsu.union(i, j);
          continue;
        }
        // Different head-to-heads are different stories, however similar their titles.
        if (la || labels(b.m).key) continue;
        const sharedKw = a.kw.filter((w) => b.kw.includes(w));
        const sharedTag = a.tags.some((t) => b.tags.includes(t));
        // Strong overlap only: 3+ distinctive keywords, or a specific tag plus 2 keywords.
        if (sharedKw.length >= 3 || (sharedTag && sharedKw.length >= 2)) dsu.union(i, j);
      }
    }
    const groups = new Map();
    movers.forEach((x, i) => {
      const r = dsu.find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(x);
    });

    const created = [];
    const updated = [];
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      // Two sides of one head-to-head mirror each other by construction; that's one move, not a story.
      if (g.length === 2 && Math.sign(g[0].delta) !== Math.sign(g[1].delta) && Math.abs(g[0].to + g[1].to - 1) < 0.04) continue;
      g.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
      const ms = g.map((x) => x.m);
      const keys = new Set(ms.map((m) => m.eventKey).filter(Boolean));
      const eventKey = keys.size === 1 ? [...keys][0] : null;
      const id = `story:${eventKey || hash(ms.map((m) => m.id).sort().join(',')).toString(36)}`;
      const ups = g.filter((x) => x.delta > 0).length;
      const direction = ups === g.length ? 'up' : ups === 0 ? 'down' : 'mixed';
      const avg = g.reduce((s, x) => s + Math.abs(x.delta), 0) / g.length;
      const strength = round(clamp(0.6 * clamp(avg / 0.12, 0, 1) + 0.4 * clamp((g.length - 1) / 5, 0, 1), 0, 1), 2);
      const span = Math.max(...g.map((x) => x.movedAt)) - Math.min(...g.map((x) => x.movedAt));
      const spanMin = Math.max(1, Math.round(span / MIN));
      const evTitle = truncate(eventTitleOf(ms), 60);
      const lead = g[0];
      const title = `${evTitle}: ${g.length} markets repriced within ${minutesText(spanMin)}`;
      const parts = g.slice(0, 3).map((x) => `${shortLabel(x.m)} now ${pct(x.to)} (${signedPts(x.delta)})`);
      const more = g.length > 3 ? `, plus ${g.length - 3} more` : '';
      const verb = direction === 'mixed' ? 'The crowd is reshuffling' : direction === 'up' ? 'Everything is moving up together' : 'Everything is sliding together';
      const summary = `${verb}: ${parts.join('; ')}${more}.`;
      const prev = this.stories.get(id);
      const story = {
        id,
        title,
        summary,
        eventKey,
        category: lead.m.category || 'other',
        direction,
        markets: g.map((x) => ({ id: x.m.id, title: x.m.title, label: shortLabel(x.m), from: round(x.from, 4), to: round(x.to, 4), delta: round(x.delta, 4) })),
        strength,
        startedAt: prev?.startedAt || new Date(Math.min(...g.map((x) => x.movedAt))).toISOString(),
        updatedAt: new Date(now).toISOString(),
      };
      this.stories.set(id, story);
      (prev ? updated : created).push(story);
    }
    return { created, updated };
  }
}

/** Convert a newly formed story into an Insight (type 'story'). */
export function storyInsight(story, now = Date.now()) {
  return {
    id: globalThis.crypto?.randomUUID?.() || `story-${now}`,
    type: 'story',
    title: story.title,
    body: story.summary,
    marketIds: story.markets.map((m) => m.id),
    category: story.category,
    severity: story.strength >= 0.7 ? 'major' : story.strength >= 0.45 ? 'notable' : 'info',
    createdAt: new Date(now).toISOString(),
    data: { storyId: story.id, eventKey: story.eventKey, direction: story.direction, strength: story.strength, delta: story.markets[0]?.delta ?? 0 },
  };
}
