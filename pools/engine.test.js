// End-to-end: replay finished games through the engine, vote on every pool, and check each pool
// settles to what really happened.  node --test pools/engine.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PoolEngine } from './engine.js';
import { replaySnapshots } from './feeds.js';
import { loadSportModel } from './models.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (p) => JSON.parse(readFileSync(join(HERE, p), 'utf8'));
const models = Object.fromEntries(['soccer', 'football', 'basketball'].map((s) => [s, loadSportModel(load(`../server/ml/sports/${s}.json`))]));

function run(sport, summary) {
  let vt = 0;
  const engine = new PoolEngine({ models, now: () => vt, voteWindowMs: 30_000 });
  const settled = [];
  engine.on('open', (p) => { engine.vote('alice', 1, { poolId: p.id }); engine.vote('bob', p.options.length, { poolId: p.id }); });
  engine.on('settle', (p) => settled.push(p));
  for (const s of replaySnapshots(sport, summary)) {
    engine.ingest({ ...s, t: vt });
    vt += 31_000; // every snapshot is past the previous pool's voting window
    engine.tick();
  }
  return { engine, settled, pools: [...engine.pools.values()] };
}

test('NFL replay: drive pools settle to the real drive result', () => {
  const summary = load('samples/nfl.json');
  const { settled, engine } = run('football', summary);
  assert.ok(settled.length >= 4, `expected several drive pools, got ${settled.length}`);
  const byDrive = Object.fromEntries(summary.drives.previous.map((d) => [String(d.id), d.result]));
  for (const p of settled) {
    const pool = engine.pools.get(p.id);
    const truth = byDrive[pool.state.driveId] || '';
    const expected = /^TD|TOUCHDOWN/i.test(truth) ? 'Touchdown' : /^FG$|FIELD GOAL/i.test(truth) && !/MISSED|BLOCKED/i.test(truth) ? 'Field goal' : 'No points';
    assert.equal(p.outcomeLabel, expected, `${p.question} (${truth})`);
  }
  const lb = engine.leaderboard();
  assert.equal(lb.length, 2);
  console.log(`NFL: ${settled.length} pools, outcomes ${JSON.stringify(settled.map((p) => p.outcomeLabel))}, leaderboard ${lb.map((x) => `${x.user} ${x.points}`).join(', ')}`);
});

test('Soccer replay: goal-in-10 pools settle from the scoreline', async () => {
  const { soccerTimeline } = await import('./models.js');
  const summary = load('samples/soccer.json');
  const { settled, engine } = run('soccer', summary);
  assert.ok(settled.length >= 3, `expected several pools, got ${settled.length}`);
  const goals = soccerTimeline(summary).filter((e) => e.kind === 'goal');
  for (const p of settled) {
    const s = engine.pools.get(p.id).state;
    const g = goals.filter((x) => x.min > s.minute && x.min <= s.minute + 10.999);
    assert.equal(p.outcome, g.length ? (g[0].team === 'home' ? 0 : 1) : 2, `${p.question} at ${s.minute}'`);
  }
  console.log(`Soccer: ${settled.length} pools, outcomes ${JSON.stringify(settled.map((p) => p.outcomeLabel))}`);
});

test('NBA replay: lead-change pools settle from the score timeline', () => {
  const raw = load('../server/ml/sports/samples/basketball_401584689.json');
  const { settled, engine } = run('basketball', raw.raw_summary);
  const tl = raw.expected_timeline;
  for (const p of settled) {
    const s = engine.pools.get(p.id).state;
    const flipped = tl.some((e) => e.sec > s.elapsed && e.sec <= s.elapsed + 180 + 15 && (e.home === e.away ? -1 : e.home > e.away ? 0 : 1) !== s.leader);
    assert.equal(p.outcome === 0, flipped, `${p.question} at ${s.elapsed}s`);
  }
  console.log(`NBA: ${settled.length} pools, outcomes ${JSON.stringify(settled.map((p) => p.outcomeLabel))}`);
});

test('votes: change vote, unknown option, closed window, underdog bonus', () => {
  let vt = 0;
  const e = new PoolEngine({ now: () => vt, voteWindowMs: 10_000 });
  const snap = { id: 'g', sport: 'football', name: 'A @ B', status: 'in', teams: [{ abbr: 'B' }, { abbr: 'A' }], scores: [0, 0], period: 1, clockSeconds: 600,
    drive: { id: 'd1', offense: 1, down: 1, distance: 10, yardsToEndzone: 20, text: '1st & 10 at B 20' } };
  e.ingest(snap);
  const pool = e.openPools()[0];
  assert.ok(pool, 'pool opens at the 20 without a model');
  assert.equal(e.vote('u1', 1).ok, true);
  assert.equal(e.vote('u1', 2).ok, true); // changed mind
  assert.equal(e.vote('u2', 'touch').ok, true);
  assert.equal(e.vote('u3', 2).ok, true);
  assert.equal(e.vote('u4', 9).ok, false);
  vt = 11_000; e.tick();
  assert.equal(e.vote('u5', 1).ok, false);
  e.ingest({ ...snap, scores: [0, 7] });
  const p = e.view(pool);
  assert.equal(p.outcomeLabel, 'Touchdown');
  assert.equal(e.players.get('u2').points, 167); // 1 of 3 right → 100 × (1 + 2/3)
  assert.equal(e.players.get('u1').points, 0);
});
