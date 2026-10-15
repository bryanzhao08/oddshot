import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Detector, makeSpike, classifySeverity, CATEGORIES } from './detector.js';

const T0 = Date.parse('2026-10-15T12:00:00Z');
const TICK = 20_000;

function mkt(id, p, extra = {}) {
  return {
    id,
    source: 'polymarket',
    title: `Market ${id}`,
    outcome: 'Yes',
    probability: p,
    volume24h: 100_000,
    liquidity: 1000,
    category: 'sports',
    tags: ['nfl'],
    url: 'https://polymarket.com/event/x',
    endDate: null,
    live: true,
    ...extra,
  };
}

// Feed a series of probabilities for one market; returns all spikes per tick.
function feed(d, id, probs, start = T0, extra = {}) {
  return probs.map((p, i) => d.ingest([mkt(id, p, extra)], start + i * TICK));
}

test('cold start: first tick produces no spikes', () => {
  const d = new Detector();
  const spikes = d.ingest([mkt('a', 0.2), mkt('b', 0.9), mkt('c', 0.5)], T0);
  assert.deepEqual(spikes, []);
  assert.equal(d.history('a').length, 1);
});

test('no spike below minPoints even on a large jump', () => {
  const d = new Detector({ minPoints: 3 });
  const res = feed(d, 'a', [0.3, 0.6]);
  assert.equal(res.flat().length, 0);
});

test('abrupt jump fires a contract-shaped spike', () => {
  const d = new Detector();
  const res = feed(d, 'a', [0.42, 0.42, 0.43, 0.42, 0.61]);
  const spikes = res.flat();
  assert.equal(spikes.length, 1);
  const s = spikes[0];
  assert.equal(s.marketId, 'a');
  assert.equal(s.from, 0.42);
  assert.equal(s.to, 0.61);
  assert.ok(Math.abs(s.delta - 0.19) < 1e-9);
  assert.ok(s.windowMs > 0 && s.windowMs <= 10 * 60_000);
  assert.equal(s.severity, 'major');
  assert.equal(s.live, true);
  assert.ok(typeof s.id === 'string' && s.id.length > 10);
  assert.ok(!Number.isNaN(Date.parse(s.detectedAt)));
  for (const k of ['title', 'source', 'category', 'tags', 'url', 'outcome', 'zScore']) assert.ok(k in s, k);
  assert.ok(s.zScore > 3);
});

test('gradual drift within window still fires on cumulative move', () => {
  const d = new Detector();
  const res = feed(d, 'a', [0.5, 0.5, 0.52, 0.54, 0.56]);
  const spikes = res.flat();
  assert.equal(spikes.length, 1);
  assert.equal(spikes[0].from, 0.5);
  assert.equal(spikes[0].to, 0.56);
});

test('small moves do not fire', () => {
  const d = new Detector();
  const res = feed(d, 'a', [0.5, 0.51, 0.5, 0.52, 0.51, 0.53, 0.52]);
  assert.equal(res.flat().length, 0);
});

test('slow moves outside spike window do not fire', () => {
  const d = new Detector({ spikeWindowMs: 60_000 });
  // +1pt per 20s tick: never 5pts within 60s; steady returns mean low z.
  const probs = Array.from({ length: 20 }, (_, i) => 0.3 + i * 0.01);
  assert.equal(feed(d, 'a', probs).flat().length, 0);
});

test('cooldown suppresses repeat spikes, then expires', () => {
  const d = new Detector({ cooldownMs: 10 * 60_000 });
  let t = T0;
  const step = (p) => d.ingest([mkt('a', p)], (t += TICK));
  for (const p of [0.4, 0.4, 0.4]) step(p);
  const first = step(0.46);
  assert.equal(first.length, 1); // first spike
  assert.equal(first[0].severity, 'info');
  assert.equal(step(0.47).length, 0); // continued move, same severity tier -> cooled down
  // jump past cooldown
  t += 11 * 60_000;
  for (const p of [0.47, 0.47]) step(p);
  assert.equal(step(0.53).length, 1);
});

test('higher-severity escalation breaks through cooldown', () => {
  const d = new Detector();
  let t = T0;
  const step = (p) => d.ingest([mkt('a', p)], (t += TICK));
  for (const p of [0.4, 0.4, 0.4]) step(p);
  const first = step(0.45);
  assert.equal(first.length, 1);
  assert.equal(first[0].severity, 'info');
  const second = step(0.62);
  assert.equal(second.length, 1);
  assert.equal(second[0].severity, 'major');
});

test('z-score criterion fires on an outlier return below the absolute threshold', () => {
  const d = new Detector({ minDelta: 0.1 });
  // Quiet market with tiny jitter, then a 3pt jump: below minDelta, but huge vs its own vol.
  const quiet = Array.from({ length: 30 }, (_, i) => 0.5 + (i % 2 ? 0.001 : -0.001));
  const res = feed(d, 'a', [...quiet, 0.531]);
  const spikes = res.flat();
  assert.equal(spikes.length, 1);
  assert.ok(Math.abs(spikes[0].zScore) >= 4, `z=${spikes[0].zScore}`);
  assert.ok(Math.abs(spikes[0].delta) < 0.1);
});

test('z-score criterion does not fire for a volatile market making a normal-sized move', () => {
  const d = new Detector({ minDelta: 0.1 });
  const noisy = Array.from({ length: 30 }, (_, i) => 0.5 + (i % 2 ? 0.03 : -0.03));
  const res = feed(d, 'a', [...noisy, noisy[noisy.length - 1] + 0.03]);
  assert.equal(res.flat().length, 0);
});

test('history is pruned to historyWindowMs', () => {
  const d = new Detector({ historyWindowMs: 60_000 });
  feed(d, 'a', [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]); // 8 ticks over 140s
  const h = d.history('a');
  assert.ok(h.length <= 4, `len=${h.length}`);
  assert.ok(h.every((q) => q.t >= T0 + 7 * TICK - 60_000));
});

test('volatility index stays within 0..100 and reacts to volatility', () => {
  const d = new Detector();
  const ids = ['a', 'b', 'c'];
  let t = T0;
  for (let i = 0; i < 20; i++) {
    t += TICK;
    d.ingest(ids.map((id) => mkt(id, 0.5)), t);
  }
  const calm = d.volatilityIndex();
  assert.equal(calm.overall, 0);
  for (const c of CATEGORIES) assert.ok(c in calm.byCategory);

  for (let i = 0; i < 40; i++) {
    t += TICK;
    d.ingest(ids.map((id, k) => mkt(id, i % 2 ? 0.05 : 0.95, { category: k ? 'crypto' : 'sports' })), t);
    const v = d.volatilityIndex();
    assert.ok(v.overall >= 0 && v.overall <= 100, `overall=${v.overall}`);
    for (const x of Object.values(v.byCategory)) assert.ok(x >= 0 && x <= 100);
  }
  const wild = d.volatilityIndex();
  assert.ok(wild.overall > 50, `overall=${wild.overall}`);
  assert.ok(wild.byCategory.crypto > 50);
  assert.ok(typeof wild.updatedAt === 'string');
});

test('volatility index is EMA-smoothed (no instant jump to max)', () => {
  const d = new Detector();
  let t = T0;
  for (let i = 0; i < 10; i++) d.ingest([mkt('a', 0.5)], (t += TICK));
  for (const p of [0.5, 0.9, 0.1]) d.ingest([mkt('a', p)], (t += TICK));
  const v = d.volatilityIndex().overall;
  assert.ok(v > 0 && v < 100, `v=${v}`);
});

test('topMovers seeds from change1h on cold start and does not fire spikes from it', () => {
  const d = new Detector();
  const spikes = d.ingest(
    [mkt('a', 0.5, { change1h: 0.02 }), mkt('b', 0.5, { change1h: -0.2 }), mkt('c', 0.5)],
    T0,
  );
  assert.equal(spikes.length, 0);
  const movers = d.topMovers(10);
  assert.equal(movers.length, 3);
  assert.equal(movers[0].market.id, 'b');
  assert.equal(movers[0].change1h, -0.2);
  assert.equal(movers[0].market.change1h, -0.2);
  assert.equal(movers[1].market.id, 'a');
  for (const m of movers) for (const k of ['change1h', 'change5m', 'vol']) assert.equal(typeof m[k], 'number');
  assert.ok(d.volatilityIndex().overall > 0, 'seeded vix should be non-zero');
});

test('topMovers uses observed history once available', () => {
  const d = new Detector();
  feed(d, 'a', [0.3, 0.3, 0.3, 0.38]);
  feed(d, 'b', [0.6, 0.6, 0.6, 0.61]);
  const movers = d.topMovers(2);
  assert.equal(movers[0].market.id, 'a');
  assert.ok(Math.abs(movers[0].change5m - 0.08) < 1e-9);
});

test('classifySeverity tiers', () => {
  assert.equal(classifySeverity(0.05, 1), 'info');
  assert.equal(classifySeverity(-0.09, 1), 'notable');
  assert.equal(classifySeverity(0.05, 5), 'notable');
  assert.equal(classifySeverity(0.2, 0), 'major');
  assert.equal(classifySeverity(-0.1, 7), 'major');
});

test('makeSpike builds a demo spike with extras', () => {
  const s = makeSpike(mkt('x', 0.7), 0.4, 0.7, 120_000, { demo: true, now: T0 });
  assert.equal(s.demo, true);
  assert.equal(s.marketId, 'x');
  assert.ok(Math.abs(s.delta - 0.3) < 1e-9);
  assert.equal(s.severity, 'major');
  assert.equal(s.detectedAt, new Date(T0).toISOString());
  assert.ok(!('now' in s));
});

test('ingest ignores invalid probabilities and never throws on junk', () => {
  const d = new Detector();
  assert.deepEqual(d.ingest([null, { id: 'z' }, mkt('q', NaN), mkt('r', 1.5)], T0), []);
  assert.deepEqual(d.ingest(undefined, T0), []);
  assert.deepEqual(d.history('q'), []);
});
