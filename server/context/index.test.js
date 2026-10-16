import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getLiveContext, matchGame } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const nfl = JSON.parse(readFileSync(join(here, 'fixtures/nfl.json'), 'utf8'));
const mlb = JSON.parse(readFileSync(join(here, 'fixtures/mlb.json'), 'utf8'));
const fixtureFetch = (payload) => async (url) => {
  assert.match(url, /^https:\/\/site\.web\.api\.espn\.com\/apis\/site\/v2\/sports\//);
  return { ok: true, json: async () => payload };
};

const nflMarket = { title: 'Buffalo Bills vs Kansas City Chiefs: who wins?', category: 'sports', tags: ['NFL'], startTime: '2026-10-15T20:15:00Z' };
const mlbMarket = { title: 'Seattle Mariners at Houston Astros', category: 'sports', tags: ['MLB'], startTime: '2026-10-15T19:10:00Z' };

test('matchGame requires both teams or one team plus same-day timing', () => {
  const games = [{
    id: 'game-1', league: 'nfl', date: '2026-10-15T20:15:00Z',
    homeTeam: { name: 'Chiefs', displayName: 'Kansas City Chiefs', abbreviation: 'KC', city: 'Kansas City' },
    awayTeam: { name: 'Bills', displayName: 'Buffalo Bills', abbreviation: 'BUF', city: 'Buffalo' },
    score: { home: 14, away: 10, homeTeam: 'Kansas City Chiefs', awayTeam: 'Buffalo Bills' }
  }];
  assert.ok(matchGame({ title: 'Bills vs Chiefs' }, games));
  assert.ok(matchGame({ title: 'Will Kansas City win?', startTime: '2026-10-15T09:00:00Z' }, games));
  assert.equal(matchGame({ title: 'Will Kansas City win?', startTime: '2026-10-16T09:00:00Z' }, games), null);
  assert.equal(matchGame({ title: 'Will Kansas City win?' }, games), null);
  assert.equal(matchGame({ title: 'Will Boston win?' }, games), null);
});

test('getLiveContext normalizes an ESPN NFL scoreboard and describes goal-to-go imminence', async () => {
  const context = await getLiveContext(nflMarket, { fetchImpl: fixtureFetch(nfl), now: Date.UTC(2026, 9, 15, 20, 30) });
  assert.equal(context.kind, 'game');
  assert.equal(context.league, 'nfl');
  assert.equal(context.status, 'in');
  assert.equal(context.clock, '4:32');
  assert.equal(context.period, 2);
  assert.deepEqual(context.score, {
    home: 14, away: 10, homeTeam: 'Kansas City Chiefs', awayTeam: 'Buffalo Bills'
  });
  assert.match(context.situation, /1st\s*&\s*Goal/i);
  assert.doesNotMatch(context.situation, /at KC 4.*at KC 4/i);
  assert.equal(context.imminent.type, 'touchdown');
  assert.ok(context.imminent.confidence >= 0 && context.imminent.confidence <= 1);
  assert.match(context.lastPlay, /Pacheco/);
  assert.equal(context.source, 'espn');
  assert.ok(Number.isFinite(Date.parse(context.fetchedAt)));
});

test('getLiveContext describes MLB runners in scoring position and likely run', async () => {
  const context = await getLiveContext(mlbMarket, { fetchImpl: fixtureFetch(mlb), now: Date.UTC(2026, 9, 15, 21, 30) });
  assert.equal(context.kind, 'game');
  assert.equal(context.league, 'mlb');
  assert.equal(context.period, 7);
  assert.match(context.situation, /2nd.*3rd.*1 out/i);
  assert.equal(context.imminent.type, 'run');
  assert.match(context.lastPlay, /Rodriguez/);
});

test('getLiveContext is conservative when the market does not identify a scoreboard game', async () => {
  const unmatched = await getLiveContext({ title: 'Will Boston score today?', category: 'sports' }, {
    fetchImpl: fixtureFetch(nfl), now: Date.UTC(2026, 9, 15, 20, 30)
  });
  assert.equal(unmatched, null);
});


test('getLiveContext routes crypto markets to Coinbase spot context', async () => {
  const context = await getLiveContext({ title: 'Bitcoin above $100,000?', category: 'crypto' }, {
    fetchImpl: async (url) => {
      assert.equal(url, 'https://api.coinbase.com/v2/prices/BTC-USD/spot');
      return { ok: true, json: async () => ({ data: { amount: '67250.50' } }) };
    },
    now: Date.UTC(2026, 9, 15, 22, 0)
  });
  assert.equal(context.kind, 'asset');
  assert.equal(context.symbol, 'BTC');
  assert.equal(context.price, 67250.5);
  assert.equal(context.source, 'coinbase');
});
