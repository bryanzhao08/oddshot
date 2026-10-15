import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './index.js';
import { Store } from './store.js';

const markets = [
  { id: 'polymarket:1', source: 'polymarket', title: 'Lakers vs Celtics', outcome: 'Lakers', probability: 0.42, volume24h: 1000, liquidity: 0, category: 'sports', tags: ['nba'], url: 'https://polymarket.com/event/x', endDate: null, live: true },
  { id: 'polymarket:2', source: 'polymarket', title: 'Fed cut in October?', outcome: 'Yes', probability: 0.2, volume24h: 500, liquidity: 0, category: 'economics', tags: ['fed'], url: 'https://polymarket.com/event/y', endDate: null, live: false },
];

class FakeDetector {
  ingest(ms) { this.ms = ms; return []; }
  history(id) { return id === 'polymarket:1' ? [{ t: 1, p: 0.4 }] : []; }
  volatilityIndex() { return { overall: 42, byCategory: { sports: 50 }, updatedAt: new Date().toISOString() }; }
  topMovers(n) { return (this.ms || []).slice(0, n).map((m) => ({ market: m, change1h: 0.05, change5m: 0, vol: 1 })); }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'oddshot-app-'));
  const pub = join(root, 'public');
  await mkdir(pub);
  await writeFile(join(pub, 'index.html'), '<h1>hi</h1>');
  await writeFile(join(pub, 'app.js'), 'x');
  await writeFile(join(root, 'secret.txt'), 'nope');
  const app = createApp({
    fetchAllMarkets: async () => markets,
    Detector: FakeDetector,
    store: new Store({ dir: join(root, 'data') }),
    pollMs: 60_000,
    publicDir: pub,
    logger: { log() {}, warn() {}, error() {} },
  });
  const { port } = await app.start(0, '127.0.0.1');
  await app.pollOnce();
  const base = `http://127.0.0.1:${port}`;
  return { app, base, root, port };
}

const j = async (r) => ({ status: r.status, body: await r.json() });

test('REST endpoints, static, SSE, demo spike', async () => {
  const { app, base, root, port } = await setup();
  try {
    let r = await j(await fetch(`${base}/api/health`));
    assert.equal(r.body.marketCount, 2);
    assert.equal(r.body.sources.polymarket.ok, true);
    assert.equal(r.body.sources.kalshi.ok, false);

    r = await j(await fetch(`${base}/api/markets?q=lakers`));
    assert.equal(r.body.length, 1);
    assert.equal(r.body[0].change1h, 0.05);
    r = await j(await fetch(`${base}/api/markets?category=economics`));
    assert.equal(r.body[0].id, 'polymarket:2');

    r = await j(await fetch(`${base}/api/markets/${encodeURIComponent('polymarket:1')}/history`));
    assert.deepEqual(r.body, { marketId: 'polymarket:1', points: [{ t: 1, p: 0.4 }] });
    assert.equal((await fetch(`${base}/api/markets/nope%3A1/history`)).status, 404);

    r = await j(await fetch(`${base}/api/vix`));
    assert.equal(r.body.overall, 42);
    assert.ok(r.body.history.length >= 1);
    r = await j(await fetch(`${base}/api/movers?limit=1`));
    assert.equal(r.body.length, 1);

    // subscriptions
    r = await j(await fetch(`${base}/api/subscriptions`, { method: 'POST', body: '{bad' }));
    assert.equal(r.status, 400);
    r = await j(await fetch(`${base}/api/subscriptions`, { method: 'POST', body: JSON.stringify({ name: '', minSeverity: 'x' }) }));
    assert.equal(r.status, 400);
    assert.ok(r.body.errors.length >= 2);
    r = await j(await fetch(`${base}/api/subscriptions`, { method: 'POST', body: JSON.stringify({ name: 'Shooters', match: { marketIds: ['polymarket:1'] }, minDelta: 0.01 }) }));
    assert.equal(r.status, 201);
    const subId = r.body.id;
    r = await j(await fetch(`${base}/api/subscriptions/${subId}`, { method: 'PUT', body: JSON.stringify({ liveOnly: true }) }));
    assert.equal(r.body.liveOnly, true);
    assert.equal(r.body.name, 'Shooters');
    r = await j(await fetch(`${base}/api/subscriptions/${subId}/test`, { method: 'POST' }));
    assert.equal(r.status, 400);
    assert.equal((await fetch(`${base}/api/subscriptions/nope`, { method: 'PUT', body: '{}' })).status, 404);
    r = await j(await fetch(`${base}/api/subscriptions`, { method: 'POST', body: 'x'.repeat(70 * 1024) }));
    assert.equal(r.status, 413);

    // SSE
    const events = [];
    const sseReq = http.get(`http://127.0.0.1:${port}/api/stream`);
    const sseRes = await new Promise((res) => sseReq.on('response', res));
    assert.match(sseRes.headers['content-type'], /text\/event-stream/);
    assert.equal(sseRes.headers['access-control-allow-origin'], '*');
    let buf = '';
    sseRes.setEncoding('utf8');
    sseRes.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /event: (.*)/.exec(block)?.[1];
        const data = /data: (.*)/.exec(block)?.[1];
        if (ev) events.push({ ev, data: JSON.parse(data) });
      }
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(app.clients.size, 1);

    // demo spike targeted at market 1 → matches subscription
    r = await j(await fetch(`${base}/api/demo/spike`, { method: 'POST', body: JSON.stringify({ marketId: 'polymarket:1' }) }));
    assert.equal(r.status, 201);
    assert.equal(r.body.demo, true);
    assert.equal(r.body.marketId, 'polymarket:1');
    assert.deepEqual(r.body.matchedSubscriptions, [subId]);
    r = await j(await fetch(`${base}/api/demo/spike`, { method: 'POST' }));
    assert.equal(r.status, 201);
    assert.equal((await fetch(`${base}/api/demo/spike`, { method: 'POST', body: '{"marketId":"zzz"}' })).status, 404);

    await app.pollOnce();
    await new Promise((r) => setTimeout(r, 50));
    const names = events.map((e) => e.ev);
    assert.ok(names.includes('spike') && names.includes('tick') && names.includes('vix'), names.join());

    r = await j(await fetch(`${base}/api/alerts?limit=1`));
    assert.equal(r.body.length, 1);
    r = await j(await fetch(`${base}/api/alerts`));
    assert.equal(r.body.length, 2);

    sseReq.destroy();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(app.clients.size, 0);

    assert.equal((await fetch(`${base}/api/subscriptions/${subId}`, { method: 'DELETE' })).status, 200);
    assert.equal((await fetch(`${base}/api/subscriptions/${subId}`, { method: 'DELETE' })).status, 404);

    // static + errors
    let s = await fetch(`${base}/`);
    assert.equal(s.status, 200);
    assert.match(s.headers.get('content-type'), /text\/html/);
    s = await fetch(`${base}/app.js`);
    assert.match(s.headers.get('content-type'), /javascript/);
    assert.equal((await fetch(`${base}/missing.css`)).status, 404);
    assert.equal((await fetch(`${base}/api/nope`)).status, 404);
    // path traversal (raw request so the client doesn't normalize ..)
    const trav = await new Promise((res) => http.get({ host: '127.0.0.1', port, path: '/..%2fsecret.txt' }, res));
    assert.ok([403, 404].includes(trav.statusCode), String(trav.statusCode));
    trav.resume();
    const trav2 = await new Promise((res) => http.get({ host: '127.0.0.1', port, path: '/../secret.txt' }, res));
    assert.ok([403, 404].includes(trav2.statusCode));
    trav2.resume();
    const opt = await fetch(`${base}/api/subscriptions`, { method: 'OPTIONS' });
    assert.equal(opt.status, 204);
  } finally {
    await app.stop();
    await rm(root, { recursive: true, force: true });
  }
});
