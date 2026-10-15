import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  server.received = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
  res.writeHead(204).end();
});
await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (err) => err ? reject(err) : resolve()));
const port = server.address().port;
const base = 'http://localhost:8787';
let subId = null;
let result;
try {
  const create = await fetch(`${base}/api/subscriptions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    name: 'Codex local webhook validation', persona: 'general', match: { keywords: [], categories: [], marketIds: [], sources: [] },
    minDelta: 0.05, minSeverity: 'info', liveOnly: false, webhook: { type: 'generic', url: `http://127.0.0.1:${port}/sink` },
  }) });
  const created = await create.json();
  if (!create.ok) throw new Error(`subscription create HTTP ${create.status}: ${JSON.stringify(created)}`);
  subId = created.id;
  const test = await fetch(`${base}/api/subscriptions/${encodeURIComponent(subId)}/test`, { method: 'POST' });
  const testBody = await test.json();
  await new Promise((resolve) => setTimeout(resolve, 50));
  result = { checkedAt: new Date().toISOString(), localOnly: true, createStatus: create.status, testStatus: test.status, testBody, received: server.received || null, passed: test.ok && testBody.ok === true && server.received?.method === 'POST' && server.received?.url === '/sink' };
} finally {
  if (subId) await fetch(`${base}/api/subscriptions/${encodeURIComponent(subId)}`, { method: 'DELETE' });
  await new Promise((resolve) => server.close(resolve));
}
await writeFile('validation/data/local_webhook_check.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ passed: result.passed, testStatus: result.testStatus, testBody: result.testBody, received: Boolean(result.received) }));
