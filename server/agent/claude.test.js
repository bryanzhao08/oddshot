import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeRecommender, detectCredentials, normalizeRecommendation, TOOL_DEFS, FALLBACK_BETA } from './claude.js';
import { createRecommender, isEligible } from './index.js';

const market = { id: 'polymarket:1', title: 'Chiefs vs. Bills', outcome: 'Chiefs', probability: 0.61, category: 'sports', live: true };
const spike = { id: 's1', marketId: market.id, kind: 'price', from: 0.42, to: 0.61, delta: 0.19, windowMs: 240000, zScore: 4.2, severity: 'major' };
const REC = { headline: 'Chiefs 1st & goal at the 4 — get the end-zone shot', action: 'Set up behind the end line now.', confidence: 'high', reasoning: ['Chiefs 42% → 61% in 4 min', '1st & Goal at BUF 4'], disclaimer: '' };
const silent = () => {};

const usage = (i = 100, o = 50) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: 0 });
const final = (obj = REC, extra = {}) => ({ model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: JSON.stringify(obj) }], usage: usage(), ...extra });

/** Fake SDK client: scripted responses for client.beta.messages.create(body, opts). */
function fakeClient(script) {
  const calls = [];
  let i = 0;
  const client = {
    beta: {
      messages: {
        create: async (body, opts) => {
          calls.push({ body: structuredClone(body), opts });
          const step = typeof script === 'function' ? script(i, body, opts) : script[Math.min(i, script.length - 1)];
          i++;
          if (step instanceof Error) throw step;
          return typeof step === 'function' ? step(body, opts) : step;
        },
      },
    },
  };
  return { client, calls };
}

test('tool loop: executes tools, echoes assistant content, returns structured rec', async () => {
  const toolTurn = {
    model: 'claude-opus-5-5',
    stop_reason: 'tool_use',
    usage: usage(800, 120),
    content: [
      { type: 'thinking', thinking: '', signature: 'abc' },
      { type: 'tool_use', id: 'tu1', name: 'get_live_context', input: { market_id: market.id } },
      { type: 'tool_use', id: 'tu2', name: 'get_market_history', input: { market_id: market.id, minutes: 30 } },
    ],
  };
  const { client, calls } = fakeClient([toolTurn, final()]);
  const seen = {};
  const rec = createClaudeRecommender({
    client,
    log: silent,
    tools: {
      getLiveContext: async (m) => ((seen.ctx = m.id), { kind: 'game', situation: '1st & Goal at BUF 4' }),
      getMarketHistory: async (id, { minutes }) => ((seen.hist = [id, minutes]), [{ t: Date.now() - 300e3, p: 0.42 }, { t: Date.now(), p: 0.61 }]),
    },
  });
  assert.equal(rec.available, true);
  const out = await rec.recommend(spike, { market, role: 'photographer' });
  assert.equal(out.source, 'claude');
  assert.equal(out.model, 'claude-opus-5-5');
  assert.equal(out.role, 'photographer');
  assert.equal(out.headline, REC.headline);
  assert.equal(out.disclaimer, undefined);
  assert.deepEqual(seen, { ctx: market.id, hist: [market.id, 30] });
  assert.equal(calls.length, 2);

  const b = calls[0].body;
  assert.equal(b.model, 'claude-opus-5-5');
  assert.deepEqual(b.betas, [FALLBACK_BETA]);
  assert.equal(b.fallbacks, 'default');
  assert.deepEqual(b.tool_choice, { type: 'auto' });
  assert.equal(b.output_config.effort, 'low');
  assert.equal(b.output_config.format.type, 'json_schema');
  assert.equal(b.thinking, undefined);
  assert.ok(b.tools.every((t) => t.strict === true && t.input_schema.additionalProperties === false));
  assert.deepEqual(b.tools.map((t) => t.name), ['get_market_history', 'get_live_context', 'get_related_markets', 'get_forecast']);
  assert.ok(calls[0].opts.signal instanceof AbortSignal);

  const m2 = calls[1].body.messages;
  assert.equal(m2.length, 3);
  assert.deepEqual(m2[1], { role: 'assistant', content: toolTurn.content });
  const results = m2[2].content;
  assert.deepEqual(results.map((r) => [r.type, r.tool_use_id]), [['tool_result', 'tu1'], ['tool_result', 'tu2']]);
  assert.match(results[0].content, /1st & Goal/);
  assert.match(results[1].content, /minutesAgo/);
});

test('ctx values are used before injected tools; tool errors become is_error results', async () => {
  const { client, calls } = fakeClient([
    { stop_reason: 'tool_use', usage: usage(), content: [{ type: 'tool_use', id: 'a', name: 'get_forecast', input: { market_id: market.id } }, { type: 'tool_use', id: 'b', name: 'get_related_markets', input: { market_id: market.id } }] },
    final(),
  ]);
  const rec = createClaudeRecommender({ client, log: silent, tools: { getForecast: () => assert.fail('should use ctx.forecast'), getRelatedMarkets: () => { throw new Error('boom'); } } });
  const out = await rec.recommend(spike, { market, role: 'fan', forecast: { pMove30: 0.44 } });
  assert.ok(out);
  const res = calls[1].body.messages[2].content;
  assert.match(res[0].content, /0\.44/);
  assert.equal(res[1].is_error, true);
});

test('trader always gets the disclaimer', async () => {
  const { client } = fakeClient([final({ ...REC, disclaimer: '' })]);
  const out = await createClaudeRecommender({ client, log: silent }).recommend(spike, { market, role: 'trader' });
  assert.equal(out.disclaimer, 'Signal, not financial advice.');
});

test('refusal → null (falls back to rules)', async () => {
  const { client } = fakeClient([{ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [], usage: usage(10, 0) }]);
  assert.equal(await createClaudeRecommender({ client, log: silent }).recommend(spike, { market, role: 'fan' }), null);
});

test('max_tokens and junk output → null', async () => {
  const a = fakeClient([{ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"headline": "Chi' }], usage: usage() }]);
  assert.equal(await createClaudeRecommender({ client: a.client, log: silent }).recommend(spike, { market, role: 'fan' }), null);
  const b = fakeClient([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }], usage: usage() }]);
  assert.equal(await createClaudeRecommender({ client: b.client, log: silent }).recommend(spike, { market, role: 'fan' }), null);
});

test('overclaiming output is rejected', () => {
  assert.equal(normalizeRecommendation({ ...REC, action: 'Guaranteed win, bet $500' }, 'trader', 'm'), null);
});

test('timeout → null and the request is aborted', async () => {
  let aborted = false;
  const { client } = fakeClient(() => (body, opts) =>
    new Promise((_, reject) => opts.signal.addEventListener('abort', () => ((aborted = true), reject(new Error('aborted'))))),
  );
  const t0 = Date.now();
  const out = await createClaudeRecommender({ client, log: silent, timeoutMs: 50 }).recommend(spike, { market, role: 'fan' });
  assert.equal(out, null);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(aborted, true);
});

test('API error → null', async () => {
  const { client } = fakeClient([Object.assign(new Error('overloaded'), { status: 529 })]);
  assert.equal(await createClaudeRecommender({ client, log: silent }).recommend(spike, { market, role: 'fan' }), null);
});

test('rate limit: global calls/hour budget', async () => {
  let now = 1e12;
  const { client, calls } = fakeClient([final()]);
  const rec = createClaudeRecommender({ client, log: silent, maxCallsPerHour: 2, now: () => now });
  assert.ok(await rec.recommend(spike, { market, role: 'fan' }));
  assert.ok(await rec.recommend(spike, { market, role: 'trader' }));
  assert.equal(await rec.recommend(spike, { market, role: 'journalist' }), null);
  assert.equal(calls.length, 2);
  assert.equal(rec.stats().rateLimited, 1);
  now += 3601e3;
  assert.ok(await rec.recommend(spike, { market, role: 'journalist' }));
  assert.equal(calls.length, 3);
});

test('cache per market+role+kind with TTL, and in-flight dedupe', async () => {
  let now = 1e12;
  const { client, calls } = fakeClient([final()]);
  const rec = createClaudeRecommender({ client, log: silent, cacheMs: 600e3, now: () => now });
  const [a, b] = await Promise.all([rec.recommend(spike, { market, role: 'fan' }), rec.recommend(spike, { market, role: 'fan' })]);
  assert.equal(a, b);
  assert.equal(calls.length, 1);
  await rec.recommend(spike, { market, role: 'fan' });
  assert.equal(calls.length, 1);
  await rec.recommend({ ...spike, kind: 'volatility', volRatio: 4 }, { market, role: 'fan' });
  assert.equal(calls.length, 2);
  now += 601e3;
  await rec.recommend(spike, { market, role: 'fan' });
  assert.equal(calls.length, 3);
  assert.equal(rec.stats().cacheHits, 1);
});

test('credentials: unavailable without creds, available with env key, OD_AGENT=rules disables', async () => {
  const none = detectCredentials({ env: {}, exec: () => { throw new Error('ENOENT'); }, fsExists: () => false });
  assert.deepEqual(none, { ok: false, source: null });
  assert.equal(detectCredentials({ env: { ANTHROPIC_API_KEY: 'x' } }).ok, true);
  assert.equal(detectCredentials({ env: { ANTHROPIC_AUTH_TOKEN: 'x' } }).source, 'env:ANTHROPIC_AUTH_TOKEN');
  assert.equal(detectCredentials({ env: {}, exec: () => 'Not logged in', fsExists: () => false }).ok, false);
  const off = createClaudeRecommender({ credentials: false, log: silent });
  assert.equal(off.available, false);
  assert.equal(await off.recommend(spike, { market, role: 'fan' }), null);
  assert.equal(createClaudeRecommender({ credentials: true, env: { OD_AGENT: 'rules' }, log: silent }).available, false);
});

test('tool defs are strict JSON schema with all properties required', () => {
  for (const t of TOOL_DEFS) {
    assert.equal(t.strict, true);
    assert.deepEqual(Object.keys(t.input_schema.properties).sort(), [...t.input_schema.required].sort());
  }
});

// ---------- index.js facade ----------

test('createRecommender: rules now, Claude upgrade via onUpgrade for eligible targets only', async () => {
  const { client, calls } = fakeClient([final()]);
  const r = createRecommender({ client, log: silent });
  const now = r.recommendNow(spike, { market });
  assert.equal(Object.keys(now).length, 5);
  assert.ok(Object.values(now).every((x) => x.source === 'rules'));

  const upgrades = [];
  const got = await r.recommendSmart(spike, { market }, 'photographer', (rec) => upgrades.push(rec));
  assert.equal(got.source, 'claude');
  assert.equal(upgrades.length, 1);
  assert.match(calls[0].body.messages[0].content, /rulesDraft/);

  const info = { ...spike, id: 's9', severity: 'info', marketId: 'x' };
  assert.equal(await r.recommendSmart(info, { market: { ...market, id: 'x' } }, 'fan', () => assert.fail()), null);
  assert.equal(calls.length, 1);
});

test('createRecommender.recommend falls back to rules on Claude failure; rules-only when disabled', async () => {
  const { client } = fakeClient([{ stop_reason: 'refusal', content: [], usage: usage() }]);
  const r = createRecommender({ client, log: silent });
  const rec = await r.recommend(spike, { market, role: 'trader' });
  assert.equal(rec.source, 'rules');
  assert.equal(rec.disclaimer, 'Signal, not financial advice.');
  const off = createRecommender({ claude: false });
  assert.equal(off.available, false);
  assert.equal((await off.recommend(spike, { market, role: 'fan' })).source, 'rules');
  assert.equal(await off.recommendSmart(spike, { market }, 'fan', () => {}), null);
});

test('isEligible: notable+, big vol spikes, top-3 shots', () => {
  assert.equal(isEligible({ severity: 'info' }), false);
  assert.equal(isEligible({ severity: 'notable' }), true);
  assert.equal(isEligible({ kind: 'volatility', volRatio: 5, severity: 'info' }), true);
  assert.equal(isEligible({ kind: 'tension', rank: 2, dramaScore: 40 }), true);
  assert.equal(isEligible({ kind: 'tension', rank: 9, dramaScore: 40 }), false);
});
