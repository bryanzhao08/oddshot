import test from 'node:test';
import assert from 'node:assert/strict';
import { detectAssetSymbol, getAssetContext } from './assets.js';

function coinbase(price) {
  return async (url) => {
    assert.match(url, /api\.coinbase\.com\/v2\/prices\/[A-Z]+-USD\/spot$/);
    return { ok: true, json: async () => ({ data: { amount: String(price), currency: 'USD' } }) };
  };
}

test('crypto market title detection is bounded and supports common names and tickers', () => {
  assert.equal(detectAssetSymbol({ title: 'Will Bitcoin reach $100,000?' }), 'BTC');
  assert.equal(detectAssetSymbol({ title: 'Ethereum above $4k by Friday' }), 'ETH');
  assert.equal(detectAssetSymbol({ title: 'Solana price target' }), 'SOL');
  assert.equal(detectAssetSymbol({ title: 'Will XRP rise?' }), 'XRP');
  assert.equal(detectAssetSymbol({ title: 'What will happen today?' }), null);
});

test('asset context returns Coinbase spot and null changes on a cold history', async () => {
  const context = await getAssetContext({ title: 'Will Dogecoin be above $1?' }, {
    fetchImpl: coinbase(0.25), now: Date.UTC(2026, 0, 1, 0, 0)
  });
  assert.deepEqual(context, {
    kind: 'asset', symbol: 'DOGE', price: 0.25, change5m: null, change1h: null,
    source: 'coinbase', fetchedAt: '2026-01-01T00:00:00.000Z'
  });
});

test('asset context computes fractional 5m and 1h changes from history', async () => {
  const market = { title: 'Will SUI be above $5?' };
  const start = Date.UTC(2026, 2, 1, 0, 0);
  await getAssetContext(market, { fetchImpl: coinbase(100), now: start });
  await getAssetContext(market, { fetchImpl: coinbase(110), now: start + 55 * 60_000 });
  const context = await getAssetContext(market, { fetchImpl: coinbase(121), now: start + 60 * 60_000 });
  assert.equal(context.symbol, 'SUI');
  assert.equal(context.price, 121);
  assert.ok(Math.abs(context.change5m - 0.1) < 1e-9);
  assert.ok(Math.abs(context.change1h - 0.21) < 1e-9);
});

test('unknown assets and Coinbase failures safely return null', async () => {
  assert.equal(await getAssetContext({ title: 'Rain in Seattle?' }, { fetchImpl: coinbase(1) }), null);
  assert.equal(await getAssetContext({ title: 'Bitcoin today?' }, {
    fetchImpl: async () => ({ ok: false }), now: Date.UTC(2026, 3, 1)
  }), null);
  assert.equal(await getAssetContext({ title: 'Bitcoin today?' }, {
    fetchImpl: async () => { throw new Error('offline'); }, now: Date.UTC(2026, 3, 1)
  }), null);
});
