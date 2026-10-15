import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendRules, recommendAllRoles, ROLES, TRADER_DISCLAIMER, sides } from './rules.js';

const NOW = Date.parse('2026-10-15T18:00:00Z');
const nfl = { id: 'polymarket:1', source: 'polymarket', title: 'Chiefs vs. Bills', outcome: 'Chiefs', probability: 0.61, category: 'sports', live: true, tags: ['nfl'] };
const nflCtx = {
  kind: 'game', league: 'nfl', status: 'in', clock: '2:31', period: 4,
  score: { home: 21, away: 24, homeTeam: 'BUF', awayTeam: 'KC' },
  situation: '1st & Goal at BUF 4',
  imminent: { type: 'touchdown', team: 'Chiefs', confidence: 0.7, text: 'Goal to go' },
};
const btc = { id: 'polymarket:2', title: 'Will Bitcoin reach $80,000 by October 31?', outcome: 'Yes', probability: 0.55, category: 'crypto' };
const btcCtx = { kind: 'asset', symbol: 'BTC', price: 79210.5, change5m: 0.012, change1h: 0.02 };
const tennis = { id: 'kalshi:T1', title: 'Gea vs Fokina: Fokina wins', outcome: 'Alejandro Davidovich Fokina', probability: 0.51, category: 'sports', live: true };

const TARGETS = {
  price: { target: { id: 's1', marketId: nfl.id, kind: 'price', from: 0.42, to: 0.61, delta: 0.19, windowMs: 240000, zScore: 4.2, severity: 'major', live: true }, market: nfl },
  volatility: { target: { id: 's2', marketId: tennis.id, kind: 'volatility', from: 0.5, to: 0.51, delta: 0.01, windowMs: 300000, volRatio: 3.4, volShort: 0.02, volBase: 0.006, severity: 'notable' }, market: tennis },
  shot: {
    target: { id: 'sh1', marketId: 'p:3', kind: 'decisive', headline: 'Lakers pulling away', why: 'Lakers up 12 pts to 92% in 30 min', dramaScore: 72, rank: 1, forecast: { pMove30: 0.3, expectedMovePts: 6, model: 'heuristic' } },
    market: { id: 'p:3', title: 'Lakers vs. Celtics', outcome: 'Lakers', probability: 0.92, category: 'sports', live: true, change1h: 0.12 },
  },
  insight: {
    target: { id: 'i1', type: 'lead-change', title: 'Smith takes the lead', body: 'Smith now favored at 58%', severity: 'notable', marketIds: ['p:4'], data: { from: 0.45, to: 0.58, delta: 0.13, leader: 'Yes' } },
    market: { id: 'p:4', title: 'Will Smith win the Senate race?', outcome: 'Yes', probability: 0.58, category: 'politics' },
  },
};

function checkShape(rec, role) {
  assert.equal(rec.role, role);
  assert.equal(rec.source, 'rules');
  assert.ok(rec.headline && rec.headline.length <= 80, `headline ≤ 80: ${rec.headline}`);
  assert.ok(rec.action && rec.action.length > 5);
  assert.ok(['low', 'medium', 'high'].includes(rec.confidence));
  assert.ok(Array.isArray(rec.reasoning) && rec.reasoning.length >= 1 && rec.reasoning.length <= 3);
  assert.ok(/\d/.test(`${rec.headline} ${rec.reasoning.join(' ')}`), `mentions numbers: ${rec.headline}`);
  if (role === 'trader') assert.equal(rec.disclaimer, TRADER_DISCLAIMER);
  else assert.equal(rec.disclaimer, undefined);
  assert.ok(!/guarantee|will definitely|bet \$/i.test(`${rec.headline} ${rec.action}`));
}

for (const [type, { target, market }] of Object.entries(TARGETS)) {
  for (const role of ROLES) {
    test(`rules: ${role} × ${type}`, () => {
      checkShape(recommendRules(target, { market, role, now: NOW }), role);
    });
  }
}

test('recommendAllRoles returns every role', () => {
  const all = recommendAllRoles(TARGETS.price.target, { market: nfl, now: NOW });
  assert.deepEqual(Object.keys(all).sort(), [...ROLES].sort());
  for (const r of ROLES) checkShape(all[r], r);
});

test('photographer uses the live game situation', () => {
  const rec = recommendRules(TARGETS.price.target, { market: nfl, role: 'photographer', context: nflCtx, now: NOW });
  assert.match(rec.headline, /Chiefs 1st & goal at BUF 4/i);
  assert.match(rec.headline, /end-zone shot/);
  assert.ok(rec.reasoning.some((r) => /1st & Goal at BUF 4/.test(r) && /KC 24–21 BUF/.test(r)));
  assert.equal(rec.confidence, 'high');
});

test('photographer: tennis break point', () => {
  const ctx = { kind: 'game', league: 'atp', status: 'in', situation: null, imminent: { type: 'break-point', team: 'Fokina', confidence: 0.5 } };
  const rec = recommendRules({ id: 'x', from: 0.5, to: 0.44, delta: -0.06, windowMs: 120000, severity: 'notable' }, { market: { ...tennis, probability: 0.44 }, role: 'photographer', context: ctx });
  assert.equal(rec.headline, 'Break point Fokina — watch the serve-return exchange');
});

test('photographer: decisive celebration at ≥ 90%', () => {
  const { target, market } = TARGETS.shot;
  const rec = recommendRules(target, { market, role: 'photographer', now: NOW });
  assert.equal(rec.headline, 'Lakers ~92% decided — set up for the celebration');
});

test('fan: team just went up with numbers', () => {
  const rec = recommendRules(TARGETS.price.target, { market: nfl, role: 'fan' });
  assert.match(rec.headline, /^Chiefs just (went up|took the lead) — 61% to win, \+19 pts in 4 min$/);
});

test('journalist: odds flipped → draft both versions', () => {
  const rec = recommendRules(TARGETS.price.target, { market: nfl, role: 'journalist' });
  assert.equal(rec.headline, 'Draft both versions; the odds flipped to 61% for Chiefs');
  const ins = recommendRules(TARGETS.insight.target, { market: TARGETS.insight.market, role: 'journalist' });
  assert.match(ins.headline, /^Draft both versions; .*58% Yes/);
});

test('trader on crypto cites odds move, spot and disclaimer', () => {
  const rec = recommendRules({ id: 'c1', from: 0.4, to: 0.55, delta: 0.15, windowMs: 600000, severity: 'notable' }, { market: btc, role: 'trader', context: btcCtx });
  assert.equal(rec.headline, 'BTC > $80k odds +15 pts in 10 min, spot +1.2% — bullish momentum');
  assert.match(rec.action, /consider reviewing a position/i);
  assert.equal(rec.disclaimer, 'Signal, not financial advice.');
  assert.notEqual(rec.confidence, 'high');
  assert.ok(rec.reasoning.some((r) => /BTC spot \$79,211/.test(r)));
});

test('volatility spike copy', () => {
  const { target, market } = TARGETS.volatility;
  const g = recommendRules(target, { market, role: 'general' });
  assert.equal(g.headline, 'Market just started thrashing (3.4× normal volatility) — something is developing');
  const t = recommendRules(target, { market, role: 'trader' });
  assert.match(t.headline, /3\.4× normal volatility/);
});

test('shot without a move uses forecast numbers', () => {
  const m = { id: 'p:5', title: 'Will there be no change in Fed rates after Oct 2026 meeting?', outcome: 'Yes', probability: 0.715, category: 'economics', startTime: new Date(NOW + 45 * 60e3).toISOString() };
  const rec = recommendRules({ id: 'sh2', kind: 'upcoming', headline: 'Fed decision soon', dramaScore: 30, forecast: { pMove30: 0.25 } }, { market: m, role: 'trader', now: NOW });
  assert.equal(rec.headline, 'Fed hold at 72%: 25% odds of a 5-pt move in 30 min');
  const p = recommendRules({ id: 'sh2', kind: 'upcoming', headline: 'x', dramaScore: 30 }, { market: m, role: 'photographer', now: NOW });
  assert.match(p.headline, /starts in 45 min/);
});

test('copy varies across markets/roles and never throws on junk', () => {
  const heads = new Set();
  for (const { target, market } of Object.values(TARGETS)) for (const r of ROLES) heads.add(recommendRules(target, { market, role: r }).headline);
  assert.ok(heads.size >= 15, `distinct headlines: ${heads.size}`);
  for (const junk of [undefined, null, {}, { from: 'x' }, { type: 'story' }]) {
    const rec = recommendRules(junk, { role: 'trader' });
    assert.equal(rec.source, 'rules');
    assert.equal(rec.disclaimer, TRADER_DISCLAIMER);
  }
  assert.equal(recommendRules({}, { role: 'nope' }).role, 'general');
});

test('sides() names matchup sides', () => {
  assert.deepEqual(
    [sides(nfl).yes, sides(nfl).no, sides(nfl).twoSided],
    ['Chiefs', 'Bills', true],
  );
  assert.equal(sides(btc).twoSided, false);
});
