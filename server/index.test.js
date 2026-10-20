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
  const root = await mkdtemp(join(tmpdir(), 'tipoff-app-'));
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

test('v2 endpoints: shots, insights, stories, briefing, forecast, SSE shots/insight, insight webhooks, backfill', async () => {
  const { Detector } = await import('./engine/detector.js');
  const root = await mkdtemp(join(tmpdir(), 'tipoff-v2-'));
  const pub = join(root, 'public');
  await mkdir(pub);
  await writeFile(join(pub, 'index.html'), 'x');
  // Local webhook receiver
  const hooks = [];
  const hookSrv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c)).on('end', () => {
      hooks.push(JSON.parse(b));
      res.end('ok');
    });
  });
  await new Promise((r) => hookSrv.listen(0, '127.0.0.1', r));
  const hookUrl = `http://127.0.0.1:${hookSrv.address().port}/hook`;

  const now = Date.now();
  const game = { id: 'polymarket:g', source: 'polymarket', title: 'Wuhan Open: Leylah Fernandez vs Jelena Ostapenko', outcome: 'Leylah Fernandez', otherOutcome: 'Jelena Ostapenko', probability: 0.56, volume24h: 500_000, liquidity: 0, category: 'sports', tags: ['tennis'], url: 'https://polymarket.com/event/g', endDate: null, live: true, startTime: new Date(now - 3600_000).toISOString(), eventKey: 'g', tokenId: 't' };
  const dead = { ...game, id: 'polymarket:dead', title: 'Will aliens land by Friday?', outcome: 'Yes', otherOutcome: 'No', probability: 0.001, volume24h: 900_000, live: false, startTime: null, eventKey: 'd', tags: [] };
  let backfilled = 0;
  const app = createApp({
    fetchAllMarkets: async () => [game, dead],
    Detector,
    store: new Store({ dir: join(root, 'data'), alertFlushMs: 10 }),
    pollMs: 60_000,
    publicDir: pub,
    logger: { log() {}, warn() {}, error() {} },
    // Backfill: 40 min at ~42%, the last 4 min at 56% → a lead change at the first tick.
    backfill: async (markets, detector) => {
      const pts = [];
      for (let k = 40; k >= 1; k--) pts.push({ t: now - k * 60_000, p: k > 4 ? 0.42 : 0.56 });
      detector.seedHistory('polymarket:g', pts);
      backfilled++;
      return { polymarket: 1, kalshi: 0, points: pts.length, ms: 1 };
    },
  });
  await app.store.load();
  await app.store.createSubscription({ name: 'Tennis', persona: 'photographer', match: { keywords: ['fernandez'], categories: [], marketIds: [], sources: [] }, minDelta: 0.05, minSeverity: 'info', liveOnly: false, webhook: { type: 'generic', url: hookUrl } });
  const { port } = await app.start(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  try {
    // wait for first poll + backfill
    for (let i = 0; i < 50 && app.state.backfill.status !== 'done'; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(backfilled, 1);
    let r = await j(await fetch(`${base}/api/health`));
    assert.equal(r.body.backfill.status, 'done');

    // SSE: collect events while we poll again
    const events = [];
    const sseReq = http.get(`http://127.0.0.1:${port}/api/stream`);
    const sseRes = await new Promise((res) => sseReq.on('response', res));
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
    await new Promise((r) => setTimeout(r, 30));
    await app.pollOnce();
    await new Promise((r) => setTimeout(r, 100));

    r = await j(await fetch(`${base}/api/shots`));
    assert.equal(r.status, 200);
    assert.ok(r.body.length >= 1);
    assert.equal(r.body[0].marketId, 'polymarket:g');
    assert.ok(!r.body.some((s) => s.marketId === 'polymarket:dead'));
    for (const k of ['id', 'marketId', 'market', 'kind', 'headline', 'why', 'forecast', 'dramaScore', 'window', 'tips', 'rank']) assert.ok(k in r.body[0], k);
    r = await j(await fetch(`${base}/api/shots?persona=journalist&category=politics&limit=5`));
    assert.deepEqual(r.body, []);

    r = await j(await fetch(`${base}/api/insights`));
    const lc = r.body.find((i) => i.type === 'lead-change');
    assert.ok(lc, JSON.stringify(r.body.map((i) => i.type)));
    assert.deepEqual(lc.marketIds, ['polymarket:g']);
    r = await j(await fetch(`${base}/api/insights?type=story`));
    assert.ok(Array.isArray(r.body));

    r = await j(await fetch(`${base}/api/stories`));
    assert.ok(Array.isArray(r.body));

    r = await j(await fetch(`${base}/api/briefing`));
    assert.ok(r.body.generatedAt && r.body.headline && Array.isArray(r.body.bullets) && Array.isArray(r.body.biggestShifts));

    r = await j(await fetch(`${base}/api/markets/${encodeURIComponent('polymarket:g')}/forecast`));
    assert.equal(r.body.marketId, 'polymarket:g');
    assert.ok(r.body.pMove30 >= 0 && r.body.pMove30 <= 1);
    assert.equal(r.body.model, 'heuristic');
    assert.equal((await fetch(`${base}/api/markets/nope/forecast`)).status, 404);

    const names = events.map((e) => e.ev);
    assert.ok(names.includes('shots'), names.join());
    // the lead change fired on the first poll (before SSE connected); the webhook got it
    for (let i = 0; i < 50 && !hooks.length; i++) await new Promise((r2) => setTimeout(r2, 20));
    assert.ok(hooks.some((h) => h.type === 'tipoff.insight' && h.insight.type === 'lead-change'), JSON.stringify(hooks).slice(0, 300));

    // insights persist in the store
    await app.store.flushInsights();
    const st2 = new Store({ dir: join(root, 'data') });
    await st2.load();
    assert.ok(st2.listInsights().some((i) => i.type === 'lead-change'));
    sseReq.destroy();
  } finally {
    await app.stop();
    await new Promise((r) => hookSrv.close(r));
    await rm(root, { recursive: true, force: true });
  }
});

test('v3: context + recommendations on spikes/shots/insights, context & recommendation endpoints, persona webhooks', async () => {
  const { Detector } = await import('./engine/detector.js');
  const { createRecommender } = await import('./agent/index.js');
  const root = await mkdtemp(join(tmpdir(), 'tipoff-v3-'));
  const pub = join(root, 'public');
  await mkdir(pub);
  await writeFile(join(pub, 'index.html'), 'x');
  const hooks = [];
  const hookSrv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c)).on('end', () => {
      hooks.push(JSON.parse(b));
      res.end('ok');
    });
  });
  await new Promise((r) => hookSrv.listen(0, '127.0.0.1', r));
  const hookUrl = `http://127.0.0.1:${hookSrv.address().port}/h`;
  let p = 0.45;
  const game = { id: 'polymarket:kc', source: 'polymarket', title: 'Chiefs vs. Bills', outcome: 'Chiefs', otherOutcome: 'Bills', probability: p, volume24h: 2e6, liquidity: 0, category: 'sports', tags: ['nfl'], url: 'https://polymarket.com/event/kc', endDate: null, live: true, startTime: new Date(Date.now() - 3600_000).toISOString(), eventKey: 'kc' };
  const ctxCalls = [];
  const context = { kind: 'game', league: 'nfl', status: 'in', clock: '2:00', period: 4, score: { home: 20, away: 17, homeTeam: 'KC', awayTeam: 'BUF' }, situation: '1st & Goal at BUF 4', imminent: { type: 'touchdown', team: 'KC', confidence: 0.7, text: 'Chiefs in the red zone' }, lastPlay: null, source: 'espn', fetchedAt: new Date().toISOString() };
  const app = createApp({
    fetchAllMarkets: async () => [{ ...game, probability: p }],
    Detector,
    store: new Store({ dir: join(root, 'data'), alertFlushMs: 10 }),
    pollMs: 60_000,
    publicDir: pub,
    logger: { log() {}, warn() {}, error() {} },
    getLiveContext: async (m) => {
      ctxCalls.push(m.id);
      return context;
    },
    createRecommender: (opts) => createRecommender({ ...opts, claude: false, log() {} }),
  });
  await app.store.load();
  await app.store.createSubscription({ name: 'Shooter', persona: 'photographer', match: { keywords: ['chiefs'], categories: [], marketIds: [], sources: [] }, minDelta: 0.05, minSeverity: 'info', liveOnly: false, webhook: { type: 'generic', url: hookUrl } });
  const { port } = await app.start(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  try {
    await new Promise((r) => setTimeout(r, 50));
    for (const q of [0.45, 0.45, 0.62]) {
      p = q;
      await app.pollOnce();
    }
    let r = await j(await fetch(`${base}/api/alerts`));
    const spike = r.body.find((s) => s.marketId === 'polymarket:kc' && !s.demo);
    assert.ok(spike, 'price spike fired');
    assert.equal(spike.kind, 'price');
    assert.deepEqual(spike.context, context);
    for (const role of ['photographer', 'trader', 'fan', 'journalist', 'general']) assert.ok(spike.recommendations?.[role]?.headline, role);
    assert.equal(spike.recommendations.trader.disclaimer, 'Signal, not financial advice.');
    for (let i = 0; i < 50 && !hooks.length; i++) await new Promise((r2) => setTimeout(r2, 20));
    const hook = hooks.find((h) => h.type === 'tipoff.spike');
    assert.ok(hook, 'webhook delivered');
    assert.equal(hook.recommendation.role, 'photographer');
    assert.ok(hook.text.startsWith('📸 '), hook.text);

    r = await j(await fetch(`${base}/api/shots`));
    if (r.body.length) assert.ok(r.body[0].recommendations?.general, 'shots carry recommendations');

    r = await j(await fetch(`${base}/api/markets/${encodeURIComponent('polymarket:kc')}/context`));
    assert.deepEqual(r.body, { marketId: 'polymarket:kc', context });
    r = await j(await fetch(`${base}/api/markets/${encodeURIComponent('polymarket:kc')}/recommendation?role=trader`));
    assert.equal(r.body.role, 'trader');
    assert.equal(r.body.recommendation.role, 'trader');
    assert.equal(r.body.recommendation.source, 'rules');
    assert.equal(r.body.targetId, spike.id);
    assert.equal((await fetch(`${base}/api/markets/nope/context`)).status, 404);
    r = await j(await fetch(`${base}/api/health`));
    assert.equal(r.body.agent.available, false);
    assert.equal(r.body.context, true);
    assert.ok(ctxCalls.length >= 1);
  } finally {
    await app.stop();
    await new Promise((r) => hookSrv.close(r));
    await rm(root, { recursive: true, force: true });
  }
});
