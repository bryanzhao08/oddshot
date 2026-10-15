// Reproducible local API contract sweep. Uses only localhost and never configures
// a webhook URL. A temporary subscription is deleted in a finally block.
const base = process.env.ODDSHOT_URL || 'http://localhost:8787';
const evidence = {
  checkedAt: new Date().toISOString(),
  base,
  policy: 'localhost only; no webhook configured; temporary subscription deleted',
  checks: [],
  sse: { status: null, contentType: null, events: [], receivedSpike: false },
};

async function request(path, { method = 'GET', body, expectedStatus = 200 } = {}) {
  const res = await fetch(new URL(path, base), {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  let data = raw;
  try { data = JSON.parse(raw); } catch {}
  const check = { method, path, status: res.status, expectedStatus, pass: res.status === expectedStatus };
  if (res.headers.get('content-type')) check.contentType = res.headers.get('content-type');
  if (typeof data === 'string') check.bodyPreview = data.slice(0, 180);
  else check.response = data;
  evidence.checks.push(check);
  return { res, data, check };
}

let createdId = null;
let streamAbort = null;
try {
  const root = await request('/');
  const health = await request('/api/health');
  const marketsResult = await request('/api/markets?limit=5');
  const markets = Array.isArray(marketsResult.data) ? marketsResult.data : [];
  if (markets.length) {
    const marketId = markets[0].id;
    await request(`/api/markets/${encodeURIComponent(marketId)}/history`);
    evidence.marketSample = { id: marketId, title: markets[0].title };
  }
  await request('/api/movers?limit=5');
  await request('/api/vix');
  await request('/api/alerts?limit=5');
  await request('/api/subscriptions');

  const created = await request('/api/subscriptions', {
    method: 'POST', expectedStatus: 201,
    body: {
      name: 'Codex API validation temporary', persona: 'general',
      match: { keywords: [], categories: [], marketIds: [], sources: [] },
      minDelta: 0.99, minSeverity: 'info', liveOnly: false, webhook: null,
    },
  });
  createdId = created.data?.id || null;
  if (createdId) {
    await request(`/api/subscriptions/${encodeURIComponent(createdId)}`);
    await request(`/api/subscriptions/${encodeURIComponent(createdId)}`, {
      method: 'PUT', body: { name: 'Codex API validation updated', minDelta: 1 },
    });
    await request(`/api/subscriptions/${encodeURIComponent(createdId)}/test`, {
      method: 'POST', expectedStatus: 400,
    });
  } else {
    evidence.checks.push({ method: 'GET', path: '/api/subscriptions/:id', pass: false, issue: 'create did not return id' });
  }

  // Subscribe before injection so the stream can report the full pipeline event.
  streamAbort = new AbortController();
  const streamResponsePromise = fetch(new URL('/api/stream', base), { signal: streamAbort.signal });
  const streamRes = await streamResponsePromise;
  evidence.sse.status = streamRes.status;
  evidence.sse.contentType = streamRes.headers.get('content-type');
  const reader = streamRes.body.getReader();
  let buffer = '';
  const streamPump = (async () => {
    const decoder = new TextDecoder();
    while (true) {
      const next = await reader.read();
      if (next.done) return;
      buffer += decoder.decode(next.value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() || '';
      for (const block of blocks) {
        if (!block.startsWith('event:')) continue;
        const event = block.match(/^event:\s*([^\n]+)/m)?.[1];
        if (!event) continue;
        evidence.sse.events.push(event);
        if (event === 'spike') evidence.sse.receivedSpike = true;
      }
    }
  })().catch((error) => { evidence.sse.readError = String(error); });
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (createdId) {
    await request(`/api/subscriptions/${encodeURIComponent(createdId)}`, { method: 'DELETE' });
    createdId = null;
  }
  const demo = await request('/api/demo/spike', { method: 'POST', expectedStatus: 201, body: {} });
  evidence.demo = {
    id: demo.data?.id,
    demo: demo.data?.demo,
    delta: demo.data?.delta,
    marketId: demo.data?.marketId,
  };
  for (let n = 0; n < 10 && !evidence.sse.receivedSpike; n++) await new Promise((resolve) => setTimeout(resolve, 100));
  await reader.cancel().catch(() => {});
  await streamPump;
  streamAbort.abort();
  streamAbort = null;
} catch (error) {
  evidence.error = String(error?.stack || error);
} finally {
  streamAbort?.abort();
  if (createdId) {
    try {
      await request(`/api/subscriptions/${encodeURIComponent(createdId)}`, { method: 'DELETE' });
      createdId = null;
    } catch (error) {
      evidence.cleanupError = String(error);
    }
  }
  try {
    const after = await request('/api/subscriptions');
    evidence.remainingSubscriptions = Array.isArray(after.data) ? after.data.length : null;
  } catch (error) {
    evidence.finalSubscriptionReadError = String(error);
  }
  evidence.completedAt = new Date().toISOString();
  evidence.allExpectedStatuses = evidence.checks.every((x) => x.pass !== false);
  evidence.sse.ok = evidence.sse.status === 200 && evidence.sse.contentType?.includes('text/event-stream')
    && evidence.sse.events.includes('tick') && evidence.sse.events.includes('vix') && evidence.sse.receivedSpike;
  console.log(JSON.stringify(evidence, null, 2));
}
