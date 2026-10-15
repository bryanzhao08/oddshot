import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { formatMessage, buildRequest, deliver, sampleSpike } from './notify.js';

const spike = { ...sampleSpike(), demo: false, live: false, title: 'Lakers vs Celtics', outcome: 'Lakers win', url: 'https://x.test/m' };

test('human message format', () => {
  assert.equal(formatMessage(spike), '🚨 Lakers vs Celtics: Lakers win 42% → 61% (+19 pts in 4m) — something just happened');
  assert.match(formatMessage({ ...spike, outcome: 'Yes', delta: -0.1, from: 0.5, to: 0.4, severity: 'notable' }), /^⚡ Lakers vs Celtics 50% → 40% \(−10 pts in 4m\)/);
});

test('payload shapes per webhook type', () => {
  const d = JSON.parse(buildRequest({ type: 'discord' }, spike).body);
  assert.ok(d.content.includes('https://x.test/m'));
  assert.equal(d.embeds[0].url, 'https://x.test/m');
  assert.equal(d.embeds[0].author.name, 'Oddshot');
  const s = JSON.parse(buildRequest({ type: 'slack' }, spike).body);
  assert.ok(s.text && Array.isArray(s.blocks));
  const g = JSON.parse(buildRequest({ type: 'generic' }, spike).body);
  assert.equal(g.spike.id, spike.id);
  const n = buildRequest({ type: 'ntfy' }, spike);
  assert.equal(typeof n.body, 'string');
  assert.equal(n.headers.Click, 'https://x.test/m');
  assert.equal(n.headers.Priority, '5');
  assert.equal(n.headers.Title, 'Oddshot: Lakers vs Celtics: Lakers win');
  const n2 = buildRequest({ type: 'ntfy' }, { ...spike, title: 'Señor → win' });
  assert.match(n2.headers.Title, /^=\?UTF-8\?B\?/);
});

test('deliver posts, reports errors, never throws', async () => {
  let got;
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      got = { url: req.url, headers: req.headers, body: b };
      res.statusCode = req.url === '/fail' ? 500 : 200;
      res.end('ok');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const ok = await deliver({ type: 'ntfy', url: `${base}/topic` }, spike);
    assert.equal(ok.ok, true);
    assert.equal(got.headers.priority, '5');
    assert.ok(got.body.includes('Lakers'));
    const bad = await deliver({ type: 'generic', url: `${base}/fail` }, spike);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /500/);
    const refused = await deliver({ type: 'generic', url: 'http://127.0.0.1:1/' }, spike);
    assert.equal(refused.ok, false);
    assert.equal((await deliver(null, spike)).ok, false);
    const slow = await deliver({ type: 'generic', url: base }, spike, null, {
      timeoutMs: 50,
      fetchImpl: (u, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(o.signal.reason))),
    });
    assert.match(slow.error, /timed out/);
  } finally {
    srv.close();
  }
});

test('insight payloads per webhook type', async () => {
  const { buildRequest, formatInsight, isInsight } = await import('./notify.js');
  const ins = { id: 'i', type: 'upset-brewing', title: 'Upset brewing in Rays vs Guardians', body: 'Guardians came in at 69%.', marketIds: ['m'], category: 'sports', severity: 'major', createdAt: new Date().toISOString(), data: { url: 'https://x' } };
  assert.equal(isInsight(ins), true);
  assert.match(formatInsight(ins), /Upset brewing in Rays vs Guardians: Guardians came in at 69%/);
  assert.equal(JSON.parse(buildRequest({ type: 'generic', url: 'u' }, ins).body).type, 'oddshot.insight');
  assert.match(JSON.parse(buildRequest({ type: 'discord', url: 'u' }, ins).body).embeds[0].title, /Upset brewing/);
  assert.match(JSON.parse(buildRequest({ type: 'slack', url: 'u' }, ins).body).text, /Rays vs Guardians/);
  const n = buildRequest({ type: 'ntfy', url: 'u' }, ins);
  assert.equal(n.headers.Priority, '5');
  assert.equal(n.headers.Click, 'https://x');
});

test('webhooks use the subscriber persona recommendation', async () => {
  const { buildRequest, recommendationLine } = await import('./notify.js');
  const spike = {
    ...sampleSpike(),
    recommendations: {
      photographer: { role: 'photographer', headline: 'Chiefs 1st & goal at the 4', action: 'Get the end-zone shot.', confidence: 'high', reasoning: [], source: 'rules' },
      trader: { role: 'trader', headline: 'Chiefs odds +19 pts in 4 min', action: 'Momentum is with KC; review your position.', disclaimer: 'Signal, not financial advice.', confidence: 'medium', reasoning: [], source: 'rules' },
      general: { role: 'general', headline: 'Something big just happened in Lakers vs Celtics', action: 'Tune in.', confidence: 'medium', reasoning: [], source: 'rules' },
    },
  };
  assert.equal(recommendationLine(spike, { persona: 'photographer' }), '📸 Chiefs 1st & goal at the 4 — Get the end-zone shot.');
  assert.match(recommendationLine(spike, { persona: 'trader' }), /^📈 .*\(Signal, not financial advice\)$/);
  assert.match(recommendationLine(spike, { persona: 'fan' }), /^🔔 Something big/); // falls back to general
  const g = JSON.parse(buildRequest({ type: 'generic', url: 'u' }, spike, { id: 's', name: 'n', persona: 'photographer' }).body);
  assert.match(g.text, /^📸 Chiefs 1st & goal at the 4/);
  assert.equal(g.recommendation.role, 'photographer');
  const n = buildRequest({ type: 'ntfy', url: 'u' }, spike, { persona: 'trader' });
  assert.match(n.body, /not financial advice/);
  assert.equal(recommendationLine(sampleSpike(), { persona: 'trader' }), null);
});
