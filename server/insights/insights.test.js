import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildShots, analyze, classify, InsightEngine, StoryEngine, storyInsight, buildBriefing, heuristicForecast } from './index.js';
import { labels, parseMatchup, shortSide } from './util.js';

const MIN = 60_000;
const NOW = Date.parse('2026-10-15T20:00:00Z');

function mkt(id, p, extra = {}) {
  return {
    id, source: 'polymarket', title: `Market ${id}?`, outcome: 'Yes', probability: p, volume24h: 250_000, liquidity: 1000,
    category: 'sports', tags: [], url: 'https://polymarket.com/event/x', endDate: null, live: false, startTime: null, eventKey: null, ...extra,
  };
}
const game = (id, p, extra = {}) => mkt(id, p, { title: 'Wuhan Open: Leylah Fernandez vs Jelena Ostapenko', outcome: 'Leylah Fernandez', otherOutcome: 'Jelena Ostapenko', live: true, ...extra });

/** Synthetic 1-min history: fn(minutesAgo) → p, from `mins` ago until now. */
function series(mins, fn, now = NOW) {
  const out = [];
  for (let k = mins; k >= 0; k--) out.push({ t: now - k * MIN, p: Math.min(0.999, Math.max(0.001, fn(k))) });
  return out;
}
const wiggle = (k, amp) => amp * Math.sin(k * 1.7) * Math.cos(k * 0.6);

test('labels: matchups, O/U, Yes/No questions', () => {
  assert.deepEqual(parseMatchup('Wuhan Open: Leylah Fernandez vs Jelena Ostapenko'), { a: 'Leylah Fernandez', b: 'Jelena Ostapenko', matchup: 'Leylah Fernandez vs Jelena Ostapenko' });
  const L = labels(game('g', 0.5));
  assert.equal(L.name, 'Fernandez vs Ostapenko');
  assert.equal(L.yes, 'Fernandez');
  assert.equal(L.no, 'Ostapenko');
  assert.equal(shortSide('AS Monaco FC'), 'Monaco');
  const ou = labels(mkt('o', 0.5, { title: 'Tampa Bay Rays vs. Cleveland Guardians: O/U 6.5', outcome: 'Over', otherOutcome: 'Under' }));
  assert.equal(ou.sub, true);
  assert.equal(ou.yes, 'Over');
  assert.match(ou.name, /Rays vs Guardians: O\/U 6\.5/);
  const q = labels(mkt('q', 0.3, { title: 'Will the Fed cut rates in October?' }));
  assert.equal(q.binary, true);
  assert.equal(q.name, 'The Fed cut rates in October');
});

test('classify: tension, turning-point, decisive, closing, upcoming, momentum', () => {
  // tension: live, ~50%, getting jumpier.
  let m = game('t', 0.51);
  let h = series(90, (k) => 0.5 + (k < 15 ? wiggle(k, 0.04) : wiggle(k, 0.005)));
  assert.equal(classify(m, analyze(m, h, NOW)), 'tension');

  // turning-point: 40% → 58% across the last 15 min.
  m = game('tp', 0.58);
  h = series(90, (k) => (k > 15 ? 0.4 : 0.58 - (k / 15) * 0.18));
  assert.equal(classify(m, analyze(m, h, NOW)), 'turning-point');

  // decisive: 80% → 92%, live.
  m = game('d', 0.92);
  h = series(90, (k) => (k > 30 ? 0.8 : 0.92 - (k / 30) * 0.12));
  assert.equal(classify(m, analyze(m, h, NOW)), 'decisive');

  // closing: resolves in 40 min, not settled.
  m = mkt('c', 0.35, { endDate: new Date(NOW + 40 * MIN).toISOString(), category: 'economics' });
  h = series(90, () => 0.35);
  assert.equal(classify(m, analyze(m, h, NOW)), 'closing');

  // upcoming: starts in 90 min, balanced, not live.
  m = game('u', 0.47, { live: false, startTime: new Date(NOW + 90 * MIN).toISOString() });
  h = series(90, () => 0.47);
  assert.equal(classify(m, analyze(m, h, NOW)), 'upcoming');

  // momentum: steady drift 30% → 45% over an hour.
  m = mkt('mo', 0.45, { category: 'politics' });
  h = series(90, (k) => (k > 60 ? 0.3 : 0.45 - (k / 60) * 0.15));
  assert.equal(classify(m, analyze(m, h, NOW)), 'momentum');

  // dead market: never a shot.
  m = mkt('dead', 0.001);
  assert.equal(classify(m, analyze(m, series(90, () => 0.001), NOW)), null);
  // flat long-dated market: not a shot either.
  m = mkt('flat', 0.4, { category: 'politics', endDate: '2028-11-07T00:00:00Z' });
  assert.equal(classify(m, analyze(m, series(90, () => 0.4), NOW)), null);
});

test('buildShots ranks live close games above quiet/dead markets, with copy and tips', () => {
  const hist = new Map();
  const live = game('live', 0.5);
  hist.set('live', series(120, (k) => 0.5 + wiggle(k, k < 15 ? 0.05 : 0.01)));
  const quiet = mkt('quiet', 0.45, { category: 'politics', title: 'Will X happen by 2027?', endDate: new Date(NOW + 30 * MIN).toISOString(), volume24h: 3000 });
  hist.set('quiet', series(120, () => 0.45));
  const dead = mkt('dead', 0.002, { live: true });
  hist.set('dead', series(120, () => 0.002));
  const shots = buildShots([dead, quiet, live], { history: hist, now: NOW });
  assert.ok(shots.length >= 1);
  assert.equal(shots[0].marketId, 'live');
  assert.ok(!shots.some((s) => s.marketId === 'dead'));
  const s = shots[0];
  assert.equal(s.rank, 1);
  assert.ok(s.headline.length <= 70, s.headline);
  assert.match(s.headline, /Fernandez vs Ostapenko/);
  assert.match(s.why, /\d/);
  for (const k of ['photographer', 'trader', 'fan', 'journalist', 'general']) assert.ok(s.tips[k] && s.tips[k].length > 10, k);
  assert.ok(s.dramaScore > 0 && s.dramaScore <= 100);
  assert.ok(s.forecast.pMove30 >= 0 && s.forecast.pMove30 <= 1);
  assert.ok(s.window.startsAt && s.window.endsAt);
  // persona + category filters
  assert.equal(buildShots([dead, quiet, live], { history: hist, now: NOW, category: 'politics' }).every((x) => x.market.category === 'politics'), true);
  const j = buildShots([quiet, live], { history: hist, now: NOW, persona: 'journalist' });
  assert.ok(j.length >= 1);
  // a custom forecaster is used when provided
  const f = buildShots([live], { history: hist, now: NOW, forecast: () => ({ pMove30: 0.11, expectedMovePts: 2, model: 'test' }) });
  assert.equal(f[0].forecast.model, 'test');
});

test('decisive photographer tip reads like a celebration call', () => {
  const m = game('d', 0.92);
  const h = series(90, (k) => (k > 30 ? 0.8 : 0.92 - (k / 30) * 0.12));
  const [s] = buildShots([m], { history: { d: h }, now: NOW });
  assert.equal(s.kind, 'decisive');
  assert.match(s.tips.photographer, /Celebration shot incoming: Fernandez ~92% decided/);
});

test('heuristic forecast: live coin flip > quiet long-shot', () => {
  const a = heuristicForecast(game('a', 0.5), series(60, (k) => 0.5 + wiggle(k, 0.03)), NOW);
  const b = heuristicForecast(mkt('b', 0.04, { category: 'politics' }), series(60, () => 0.04), NOW);
  assert.equal(a.model, 'heuristic');
  assert.ok(a.pMove30 > b.pMove30);
  assert.equal(heuristicForecast({ probability: 'x' }), null);
});

test('InsightEngine: lead-change, dedupe, ring buffer', () => {
  const e = new InsightEngine();
  const m = game('lc', 0.56);
  const h = series(30, (k) => (k > 5 ? 0.44 : 0.56));
  const out = e.update([m], { history: { lc: h }, now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'lead-change');
  assert.match(out[0].title, /Fernandez/);
  assert.deepEqual(out[0].marketIds, ['lc']);
  // same condition 1 min later: deduped
  assert.equal(e.update([m], { history: { lc: h }, now: NOW + MIN }).length, 0);
  assert.equal(e.list().length, 1);
  // ring buffer cap
  const small = new InsightEngine({ bufferSize: 3 });
  for (let i = 0; i < 5; i++) small.add({ id: String(i), type: 'story', marketIds: [`m${i}`], createdAt: new Date(NOW).toISOString() }, NOW);
  assert.equal(small.list(10).length, 3);
  assert.equal(small.list(10)[0].id, '4');
});

test('InsightEngine: upset-brewing (favorite slides ≥ 8 pts in 30 min)', () => {
  const e = new InsightEngine();
  const m = game('up', 0.62, { startTime: new Date(NOW - 60 * MIN).toISOString() });
  const h = series(60, (k) => (k > 25 ? 0.74 : 0.62 + (k / 25) * 0.12));
  const out = e.update([m], { history: { up: h }, now: NOW });
  assert.equal(out[0]?.type, 'upset-brewing');
  assert.match(out[0].body, /Fernandez came in at 74%/);
});

test('InsightEngine: lock-in crossing 90%', () => {
  const e = new InsightEngine();
  const m = game('li', 0.92, { title: 'Will the bill pass?', outcome: 'Yes', otherOutcome: 'No', category: 'politics', live: false });
  const h = series(30, (k) => (k > 3 ? 0.84 : 0.92));
  e.update([{ ...m, probability: 0.86 }], { history: { li: h.slice(0, -3) }, now: NOW - 3 * MIN });
  const out = e.update([m], { history: { li: h }, now: NOW });
  assert.equal(out[0]?.type, 'lock-in');
});

test('InsightEngine: calm-before-storm (quiet, balanced, starts within 2h)', () => {
  const e = new InsightEngine();
  const m = game('calm', 0.52, { live: false, startTime: new Date(NOW + 70 * MIN).toISOString() });
  const out = e.update([m], { history: { calm: series(90, () => 0.52) }, now: NOW });
  assert.equal(out[0]?.type, 'calm-before-storm');
  assert.match(out[0].body, /Starts in 1h 10m/);
});

test('InsightEngine: belief-shift over ~6h (non-live)', () => {
  const e = new InsightEngine();
  const m = mkt('bs', 0.62, { category: 'politics', title: 'Will the ceasefire hold through October?' });
  const out = e.update([m], { history: { bs: series(360, (k) => 0.4 + ((360 - k) / 360) * 0.22) }, now: NOW });
  assert.equal(out[0]?.type, 'belief-shift');
  assert.match(out[0].title, /40% → 62% in 6h/);
});

test('InsightEngine: divergence across venues, conservative matching', () => {
  const e = new InsightEngine();
  const poly = game('polymarket:1', 0.55, { live: true });
  const kal = { ...game('kalshi:K1', 0.45), source: 'kalshi', title: 'Fernandez vs Ostapenko: Leylah Fernandez wins', outcome: 'Leylah Fernandez', otherOutcome: null };
  const unrelated = { ...mkt('kalshi:K2', 0.2), source: 'kalshi', title: 'Will Ostapenko win Wimbledon?' };
  const out = e.update([poly, kal, unrelated], { history: {}, now: NOW });
  const d = out.find((x) => x.type === 'divergence');
  assert.ok(d, 'divergence emitted');
  assert.deepEqual(d.marketIds, ['polymarket:1', 'kalshi:K1']);
  assert.equal(d.data.gap, 0.1);
  // orientation flip: Kalshi tracks the other player → no false gap
  const e2 = new InsightEngine();
  const flipped = { ...kal, title: 'Fernandez vs Ostapenko: Jelena Ostapenko wins', outcome: 'Jelena Ostapenko', probability: 0.45 };
  assert.equal(e2.update([poly, flipped], { history: {}, now: NOW }).filter((x) => x.type === 'divergence').length, 0);
  // different questions with similar words never match
  const e3 = new InsightEngine();
  const qa = mkt('polymarket:q', 0.5, { category: 'economics', title: 'Will the Fed cut rates by 25 bps in October?' });
  const qb = { ...mkt('kalshi:q', 0.2, { category: 'economics', title: 'Will the Fed cut rates by 50 bps in October?' }), source: 'kalshi' };
  assert.equal(e3.update([qa, qb], { history: {}, now: NOW }).length, 0);
});

test('StoryEngine clusters co-moving markets by eventKey', () => {
  const se = new StoryEngine();
  const mk = (id, p, from, group) => mkt(id, p, { eventKey: 'fed-oct', eventTitle: 'Fed decision in October', groupTitle: group, category: 'economics' });
  const markets = [mk('a', 0.61, 0.5, '25 bps cut'), mk('b', 0.3, 0.42, 'No change'), mk('c', 0.09, 0.08, '50+ bps cut'), mkt('z', 0.7, { category: 'economics' })];
  const hist = {
    a: series(30, (k) => (k > 8 ? 0.5 : 0.61)),
    b: series(30, (k) => (k > 4 ? 0.42 : 0.3)),
    c: series(30, () => 0.09),
    z: series(30, (k) => (k > 5 ? 0.6 : 0.7)),
  };
  const { created } = se.update(markets, { history: hist, now: NOW });
  assert.equal(created.length, 1);
  const st = created[0];
  assert.equal(st.eventKey, 'fed-oct');
  assert.equal(st.markets.length, 2);
  assert.equal(st.direction, 'mixed');
  assert.match(st.title, /^Fed decision in October: 2 markets repriced within 4 min/);
  assert.match(st.summary, /25 bps cut now 61% \(\+11 pts\)/);
  assert.ok(st.strength > 0 && st.strength <= 1);
  assert.equal(se.list(NOW).length, 1);
  assert.equal(se.list(NOW + 3 * 3600_000).length, 0); // expires after 2h
  assert.equal(storyInsight(st, NOW).type, 'story');
  // keyword overlap in same category (no eventKey) also clusters; different matchups never do
  const se2 = new StoryEngine();
  const g1 = game('g1', 0.6, { title: 'Lakers vs Celtics', outcome: 'Lakers', otherOutcome: 'Celtics' });
  const g2 = game('g2', 0.6, { title: 'Lakers vs Knicks', outcome: 'Lakers', otherOutcome: 'Knicks' });
  const r = se2.update([g1, g2], { history: { g1: series(20, (k) => (k > 5 ? 0.5 : 0.6)), g2: series(20, (k) => (k > 5 ? 0.5 : 0.6)) }, now: NOW });
  assert.equal(r.created.length, 0);
});

test('buildBriefing: headline + bullets from 24h changes, ignoring settled/thin markets', () => {
  const markets = [
    mkt('big', 0.62, { title: 'Will the ceasefire hold through October?', category: 'politics', change24h: 0.2, volume24h: 2e6 }),
    mkt('small', 0.3, { title: 'Will Y happen?', change24h: 0.05, volume24h: 50_000 }),
    mkt('settled', 0.995, { change24h: 0.5, volume24h: 5e6 }),
    mkt('thin', 0.5, { change24h: 0.4, volume24h: 100 }),
  ];
  const b = buildBriefing(markets, {
    now: NOW,
    spikes: [{ detectedAt: new Date(NOW - 3600_000).toISOString(), severity: 'major' }],
    insights: [{ type: 'lead-change', createdAt: new Date(NOW).toISOString(), title: 'x', body: 'y' }],
  });
  assert.equal(b.biggestShifts[0].marketId, 'big');
  assert.ok(!b.biggestShifts.some((s) => s.marketId === 'settled' || s.marketId === 'thin'));
  assert.match(b.headline, /Biggest shift: “Will the ceasefire hold through October\?” surged 20 pts to 62%/);
  assert.match(b.bullets[0], /from 42% to 62%/);
  assert.ok(b.bullets.some((x) => /1 lead change/.test(x)));
  assert.ok(b.bullets.some((x) => /1 sudden move detected, 1 of them major/.test(x)));
  assert.equal(buildBriefing([], { now: NOW }).biggestShifts.length, 0);
});

test('sports market whose endDate is the kickoff is "upcoming", not "closing"', () => {
  const t = new Date(NOW + 5 * MIN).toISOString();
  const m = mkt('ko', 0.44, { title: 'Will Juventus FC win on 2026-10-15?', startTime: t, endDate: t });
  assert.equal(classify(m, analyze(m, series(90, () => 0.44), NOW)), 'upcoming');
});
