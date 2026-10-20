import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, atomicWriteJSON } from './store.js';

async function tmp() {
  return mkdtemp(join(tmpdir(), 'tipoff-store-'));
}

test('creates data dir and persists subscriptions CRUD', async () => {
  const root = await tmp();
  const dir = join(root, 'nested', 'data');
  try {
    const s = await new Store({ dir }).load();
    const a = await s.createSubscription({ name: 'A', match: {} });
    assert.ok(a.id && a.createdAt);
    await s.createSubscription({ name: 'B' });
    await s.updateSubscription(a.id, { name: 'A2' });
    assert.equal(await s.updateSubscription('nope', {}), null);

    const s2 = await new Store({ dir }).load();
    assert.deepEqual(s2.listSubscriptions().map((x) => x.name), ['A2', 'B']);
    assert.equal(s2.getSubscription(a.id).createdAt, a.createdAt);

    assert.equal(await s2.deleteSubscription(a.id), true);
    assert.equal(await s2.deleteSubscription(a.id), false);
    const s3 = await new Store({ dir }).load();
    assert.equal(s3.listSubscriptions().length, 1);
    assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith('.tmp')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('alerts ring buffer caps, newest first, persists on close', async () => {
  const dir = await tmp();
  try {
    const s = await new Store({ dir, maxAlerts: 5, alertFlushMs: 10_000 }).load();
    for (let i = 0; i < 8; i++) s.addAlert({ id: String(i) });
    assert.deepEqual(s.listAlerts(3).map((a) => a.id), ['7', '6', '5']);
    assert.equal(s.listAlerts(100).length, 5);
    await s.close();
    const saved = JSON.parse(await readFile(join(dir, 'alerts.json'), 'utf8'));
    assert.deepEqual(saved.map((a) => a.id), ['7', '6', '5', '4', '3']);
    const s2 = await new Store({ dir, maxAlerts: 5 }).load();
    assert.equal(s2.listAlerts().length, 5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('corrupt file falls back to empty', async () => {
  const dir = await tmp();
  try {
    await writeFile(join(dir, 'subscriptions.json'), '{not json');
    const orig = console.warn;
    console.warn = () => {};
    const s = await new Store({ dir }).load();
    console.warn = orig;
    assert.deepEqual(s.listSubscriptions(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('concurrent writes are serialized and file stays valid JSON', async () => {
  const dir = await tmp();
  try {
    const s = await new Store({ dir }).load();
    await Promise.all(Array.from({ length: 20 }, (_, i) => s.createSubscription({ name: `s${i}` })));
    const saved = JSON.parse(await readFile(join(dir, 'subscriptions.json'), 'utf8'));
    assert.equal(saved.length, 20);
    await atomicWriteJSON(join(dir, 'x.json'), { a: 1 });
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'x.json'), 'utf8')), { a: 1 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
