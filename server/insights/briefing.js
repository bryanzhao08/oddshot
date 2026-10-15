// Briefing: a plain-English digest of the biggest belief changes over the last 24h.
// Pure ES module (browser-safe).

import { HOUR, isNum, round, toMs, historyGetter, priceAt, pct, pts, labels, moveVerb, money, truncate } from './util.js';

const MIN_VOLUME = 10_000;

/** Best estimate of a market's 24h change: venue-reported change24h, else our own history (≤ 6h). */
function shiftOf(m, h, now) {
  if (isNum(m.change24h)) return { delta: m.change24h, span: '24h' };
  if (h.length && now - h[0].t >= HOUR) {
    const ref = priceAt(h, now - 24 * HOUR);
    const from = isNum(ref) ? ref : h[0].p;
    return { delta: m.probability - from, span: `${Math.max(1, Math.round((now - h[0].t) / HOUR))}h` };
  }
  if (isNum(m.change1h)) return { delta: m.change1h, span: '1h' };
  return null;
}

function phrase(s) {
  const m = s.market;
  const L = labels(m);
  const v = moveVerb(s.delta);
  if (L.twoSided && !L.sub) return `${L.yes} ${v} from ${pct(s.from)} to ${pct(s.to)} against ${L.no}`;
  if (L.yes !== 'Yes') return `${L.name}: ${L.yes} ${v} from ${pct(s.from)} to ${pct(s.to)}`;
  return `“${truncate(m.title, 80)}” ${v} from ${pct(s.from)} to ${pct(s.to)}`;
}

/**
 * buildBriefing(markets, { history, spikes, insights, stories, now }) → Briefing
 * { generatedAt, headline, bullets: string[], biggestShifts: [{marketId, title, from, to, delta}] }
 */
export function buildBriefing(markets, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const getHist = historyGetter(ctx.history);
  const shifts = [];
  const seenEvent = new Map();
  for (const m of markets || []) {
    if (!m?.id || !(m.probability >= 0 && m.probability <= 1)) continue;
    if ((m.volume24h || 0) < MIN_VOLUME) continue;
    const s = shiftOf(m, getHist(m.id), now);
    if (!s || Math.abs(s.delta) < 0.03) continue;
    const from = Math.min(1, Math.max(0, m.probability - s.delta));
    // Moves that just ride to 0/1 on a settled market aren't news.
    // Settled markets (riding to 0/1 as an event ends) aren't belief changes.
    if (m.probability < 0.03 || m.probability > 0.97 || from < 0.02 || from > 0.98) continue;
    // Weighted by size of move and (log) volume, so a $5M market's 10-pt move beats a $10k market's 12.
    const score = Math.abs(s.delta) * (1 + Math.log10(1 + (m.volume24h || 0)) / 7);
    const item = { market: m, from, to: m.probability, delta: s.delta, span: s.span, score };
    // Keep one market per event so a multi-outcome event doesn't flood the list.
    const k = m.eventKey ? `${m.source}:${m.eventKey}` : m.id;
    const prev = seenEvent.get(k);
    if (prev && prev.score >= score) continue;
    seenEvent.set(k, item);
  }
  shifts.push(...seenEvent.values());
  shifts.sort((a, b) => b.score - a.score);
  const top = shifts.slice(0, 8);

  const spikes = (ctx.spikes || []).filter((s) => now - toMs(s.detectedAt) <= 24 * HOUR && !s.demo);
  const insights = (ctx.insights || []).filter((i) => now - toMs(i.createdAt) <= 24 * HOUR);
  const stories = ctx.stories || [];
  const count = (t) => insights.filter((i) => i.type === t).length;

  let headline;
  if (top.length) {
    const s = top[0];
    const L = labels(s.market);
    const mm = /^(.+?) vs (.+?)(?::|$)/.exec(L.name);
    const opp = L.twoSided && !L.sub ? L.no : mm && L.yes === mm[1] ? mm[2] : mm && L.yes === mm[2] ? mm[1] : null;
    const tail = `${moveVerb(s.delta)} ${pts(s.delta)} to ${pct(s.to)}`;
    headline = opp
      ? `Biggest shift: ${L.yes} ${tail} against ${opp}`
      : L.yes !== 'Yes' ? `Biggest shift: ${L.name}: ${L.yes} ${tail}` : `Biggest shift: “${truncate(s.market.title, 70)}” ${tail}`;
    headline = truncate(headline, 110);
  } else {
    headline = 'A quiet stretch: no market has moved more than 3 pts';
  }

  const bullets = top.slice(0, 5).map((s) => `${phrase(s)} (${s.span}, ${money(s.market.volume24h)} traded).`);
  const lc = count('lead-change');
  const up = count('upset-brewing');
  const li = count('lock-in');
  const pieces = [];
  if (lc) pieces.push(`${lc} lead change${lc > 1 ? 's' : ''}`);
  if (up) pieces.push(`${up} upset alert${up > 1 ? 's' : ''}`);
  if (li) pieces.push(`${li} outcome${li > 1 ? 's' : ''} locked in`);
  if (pieces.length) bullets.push(`Today so far: ${pieces.join(', ')}.`);
  const majors = spikes.filter((s) => s.severity === 'major').length;
  if (spikes.length) bullets.push(`${spikes.length} sudden move${spikes.length > 1 ? 's' : ''} detected${majors ? `, ${majors} of them major` : ''}.`);
  if (stories[0]) bullets.push(`Developing: ${stories[0].title}.`);
  const div = insights.find((i) => i.type === 'divergence');
  if (div) bullets.push(`${div.title}: ${div.body.split('. ')[0]}.`);

  return {
    generatedAt: new Date(now).toISOString(),
    headline,
    bullets,
    biggestShifts: top.map((s) => ({ marketId: s.market.id, title: s.market.title, from: round(s.from, 4), to: round(s.to, 4), delta: round(s.delta, 4), span: s.span })),
  };
}
