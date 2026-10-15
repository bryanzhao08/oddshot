import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesSubscription, matchSubscriptions, validateSubscription } from './match.js';

const spike = {
  id: 's1', marketId: 'polymarket:1', title: 'Lakers vs Celtics', outcome: 'Lakers',
  source: 'polymarket', category: 'sports', tags: ['nba', 'basketball'],
  from: 0.42, to: 0.61, delta: 0.19, windowMs: 240000, severity: 'notable', live: true,
};
const sub = (o = {}) => ({ id: 'x', name: 't', match: { keywords: [], categories: [], marketIds: [], sources: [] }, minDelta: 0, minSeverity: 'info', liveOnly: false, ...o });

test('empty subscription matches everything', () => {
  assert.equal(matchesSubscription(spike, sub()), true);
  assert.equal(matchesSubscription(spike, { id: 'y' }), true);
});

test('keywords: case-insensitive substring on title or tag', () => {
  assert.equal(matchesSubscription(spike, sub({ match: { keywords: ['LAKERS'] } })), true);
  assert.equal(matchesSubscription(spike, sub({ match: { keywords: ['basket'] } })), true);
  assert.equal(matchesSubscription(spike, sub({ match: { keywords: ['knicks', 'nba'] } })), true);
  assert.equal(matchesSubscription(spike, sub({ match: { keywords: ['knicks'] } })), false);
});

test('categories, sources, marketIds', () => {
  assert.equal(matchesSubscription(spike, sub({ match: { categories: ['sports'] } })), true);
  assert.equal(matchesSubscription(spike, sub({ match: { categories: ['politics'] } })), false);
  assert.equal(matchesSubscription(spike, sub({ match: { sources: ['kalshi'] } })), false);
  assert.equal(matchesSubscription(spike, sub({ match: { sources: ['polymarket'] } })), true);
  assert.equal(matchesSubscription(spike, sub({ match: { marketIds: ['polymarket:1'] } })), true);
  assert.equal(matchesSubscription(spike, sub({ match: { marketIds: ['polymarket:2'] } })), false);
});

test('minDelta uses absolute delta', () => {
  assert.equal(matchesSubscription(spike, sub({ minDelta: 0.2 })), false);
  assert.equal(matchesSubscription(spike, sub({ minDelta: 0.1 })), true);
  assert.equal(matchesSubscription({ ...spike, delta: -0.19 }, sub({ minDelta: 0.1 })), true);
});

test('severity ordering info < notable < major', () => {
  assert.equal(matchesSubscription(spike, sub({ minSeverity: 'info' })), true);
  assert.equal(matchesSubscription(spike, sub({ minSeverity: 'notable' })), true);
  assert.equal(matchesSubscription(spike, sub({ minSeverity: 'major' })), false);
});

test('liveOnly', () => {
  assert.equal(matchesSubscription(spike, sub({ liveOnly: true })), true);
  assert.equal(matchesSubscription({ ...spike, live: false }, sub({ liveOnly: true })), false);
});

test('matchSubscriptions returns ids', () => {
  const ids = matchSubscriptions(spike, [sub({ id: 'a' }), sub({ id: 'b', minSeverity: 'major' }), sub({ id: 'c', match: { keywords: ['celtics'] } })]);
  assert.deepEqual(ids, ['a', 'c']);
});

test('validateSubscription normalizes and defaults', () => {
  const v = validateSubscription({ name: ' Shooters ', persona: 'photographer', match: { keywords: ['Lakers', ''], categories: ['Sports'] }, webhook: { type: 'ntfy', url: 'https://ntfy.sh/x' } });
  assert.equal(v.ok, true, v.errors?.join());
  assert.equal(v.value.name, 'Shooters');
  assert.deepEqual(v.value.match, { keywords: ['Lakers'], categories: ['sports'], marketIds: [], sources: [] });
  assert.equal(v.value.minDelta, 0.05);
  assert.equal(v.value.minSeverity, 'info');
  assert.equal(v.value.liveOnly, false);
  assert.deepEqual(v.value.webhook, { type: 'ntfy', url: 'https://ntfy.sh/x' });
});

test('validateSubscription rejects bad input', () => {
  assert.equal(validateSubscription(null).ok, false);
  assert.equal(validateSubscription([]).ok, false);
  const v = validateSubscription({ name: '', persona: 'wizard', minDelta: 2, minSeverity: 'huge', liveOnly: 'yes', match: { categories: ['cooking'] }, webhook: { type: 'pager', url: 'ftp://x' } });
  assert.equal(v.ok, false);
  assert.ok(v.errors.length >= 6, v.errors.join('\n'));
});

test('validateSubscription empty webhook url -> null; PUT merges', () => {
  const v = validateSubscription({ name: 'a', webhook: { type: 'generic', url: '' } });
  assert.equal(v.value.webhook, null);
  const existing = { id: 'id1', createdAt: 'x', ...v.value };
  const u = validateSubscription({ minSeverity: 'major' }, existing);
  assert.equal(u.ok, true);
  assert.equal(u.value.name, 'a');
  assert.equal(u.value.minSeverity, 'major');
  assert.equal(u.value.id, 'id1');
});
