import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePolymarket } from './polymarket.js';
import { normalizeKalshi, kalshiStartTime } from './kalshi.js';
import { fetchPolymarketHistory, fetchKalshiHistory, backfillHistory, mapLimit } from './history.js';

test('polymarket: startTime, eventKey, eventTitle, groupTitle, otherOutcome, change24h', () => {
  const m = normalizePolymarket({
    id: '1', question: 'Wuhan: A vs B', outcomes: '["A","B"]', outcomePrices: '["0.4","0.6"]', clobTokenIds: '["t1","t2"]',
    gameStartTime: '2026-10-15 06:30:00+00', oneDayPriceChange: 0.1, groupItemTitle: 'Match Winner',
    events: [{ slug: 'wta-a-b', title: 'Wuhan: A vs B', startTime: '2026-10-15T06:00:00Z' }],
  }, Date.parse('2026-10-15T07:00:00Z'));
  assert.equal(m.startTime, '2026-10-15T06:30:00.000Z');
  assert.equal(m.eventKey, 'wta-a-b');
  assert.equal(m.eventTitle, 'Wuhan: A vs B');
  assert.equal(m.otherOutcome, 'B');
  assert.equal(m.change24h, 0.1);
  assert.equal(m.tokenId, 't1');
  const n = normalizePolymarket({ id: '2', question: 'Q?', outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]', events: [{ slug: 's' }] });
  assert.equal(n.startTime, null);
});

test('kalshi: eventKey and startTime from the event ticker', () => {
  assert.equal(kalshiStartTime({ event_ticker: 'KXMLBGAME-26OCT151800TBCLE' }), '2026-10-15T22:00:00.000Z'); // 18:00 EDT
  assert.equal(kalshiStartTime({ event_ticker: 'KXNFLGAME-26DEC201300SEADEN' }), '2026-12-20T18:00:00.000Z'); // 13:00 EST
  assert.equal(kalshiStartTime({ event_ticker: 'KXATPMATCH-26OCT15GEADAV', expected_expiration_time: '2026-10-15T07:00:00Z' }, { series_ticker: 'KXATPMATCH' }), '2026-10-15T04:00:00.000Z');
  assert.equal(kalshiStartTime({ event_ticker: 'KXFEDDECISION-26OCT' }), null);
  const m = normalizeKalshi({ ticker: 'KXMLBGAME-26OCT151800TBCLE-TB', event_ticker: 'KXMLBGAME-26OCT151800TBCLE', title: 'Tampa Bay wins', yes_sub_title: 'Tampa Bay', yes_bid_dollars: '0.45', yes_ask_dollars: '0.46', volume_24h_fp: '100', status: 'active', market_type: 'binary' },
    { title: 'Game 3: Tampa Bay vs Cleveland', category: 'Sports', series_ticker: 'KXMLBGAME' });
  assert.equal(m.eventKey, 'KXMLBGAME-26OCT151800TBCLE');
  assert.equal(m.startTime, '2026-10-15T22:00:00.000Z');
  assert.equal(m.eventTitle, 'Game 3: Tampa Bay vs Cleveland');
});

test('history fetchers parse responses and never throw', async () => {
  const ok = (body) => async () => ({ ok: true, json: async () => body });
  const poly = await fetchPolymarketHistory('tok', { fetchImpl: ok({ history: [{ t: 100, p: 0.5 }, { t: 160, p: 2 }] }) });
  assert.deepEqual(poly, [{ t: 100000, p: 0.5 }]);
  const kal = await fetchKalshiHistory('T-1', 'T', { fetchImpl: ok({ candlesticks: [
    { end_period_ts: 100, yes_bid: { close_dollars: '0.40' }, yes_ask: { close_dollars: '0.44' }, price: { close_dollars: '0.5' } },
    { end_period_ts: 160, yes_bid: { close_dollars: '0' }, yes_ask: { close_dollars: '1' }, price: { close_dollars: '0.3' } },
  ] }) });
  assert.deepEqual(kal, [{ t: 100000, p: 0.42 }, { t: 160000, p: 0.3 }]);
  assert.deepEqual(await fetchPolymarketHistory('tok', { fetchImpl: async () => { throw new Error('x'); } }), []);
  assert.deepEqual(await fetchPolymarketHistory(null), []);
});

test('backfillHistory respects concurrency and seeds the detector', async () => {
  let inflight = 0;
  let peak = 0;
  const fetchImpl = async () => {
    inflight++;
    peak = Math.max(peak, inflight);
    await new Promise((r) => setTimeout(r, 5));
    inflight--;
    return { ok: true, json: async () => ({ history: [{ t: 1, p: 0.5 }] }) };
  };
  const markets = Array.from({ length: 12 }, (_, i) => ({ id: `polymarket:${i}`, source: 'polymarket', tokenId: `t${i}`, volume24h: i }));
  const seeded = [];
  const stats = await backfillHistory(markets, { seedHistory: (id, pts) => seeded.push([id, pts.length]) }, { polymarket: 10, kalshi: 0, concurrency: 4, fetchImpl });
  assert.ok(peak <= 4);
  assert.equal(stats.polymarket, 10);
  assert.equal(seeded.length, 10);
  assert.equal(seeded.some(([id]) => id === 'polymarket:0'), false, 'lowest-volume markets skipped');
  assert.deepEqual(await mapLimit([], 4, async () => 1), []);
});
