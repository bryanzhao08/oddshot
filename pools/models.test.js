// Run: node --test pools/models.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  loadSportModel, soccerTimeline, soccerFeatures, footballFeatures, footballFeaturesFromPlayStart,
  basketballElapsed, basketballTimeline, basketballFeatures,
} from './models.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sportsDir = join(root, 'server/ml/sports');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

const build = {
  soccer: (fx) => soccerFeatures(fx.timeline, fx.team, fx.at),
  basketball: (fx) => basketballFeatures(fx.timeline, fx.at),
  football: (fx) => ({ ...fx.state }),
};

for (const sport of ['soccer', 'football', 'basketball']) {
  test(`${sport}: fixtures rebuild features and match probabilities`, () => {
    const json = readJson(join(sportsDir, `${sport}.json`));
    const model = loadSportModel(json);
    assert.equal(model.sport, sport);
    for (const name of Object.keys(json.models)) assert.equal(typeof model.baseRate[name], 'number', `baseRate ${name}`);
    assert.ok(json.fixtures.length > 0);
    let maxP = 0, maxX = 0, nPred = 0, predNs = 0n;
    json.fixtures.forEach((fx, k) => {
      const f = build[sport](fx);
      assert.ok(f, `fixture ${k}: features null`);
      const x = model.features.map((n) => f[n]);
      assert.equal(x.length, fx.x.length);
      x.forEach((v, i) => {
        const want = fx.x[i];
        if (want === null) assert.ok(v === undefined || v === null || Number.isNaN(v), `fixture ${k} ${model.features[i]}: want NaN got ${v}`);
        else {
          assert.equal(v, want, `fixture ${k} ${model.features[i]}`);
          maxX = Math.max(maxX, Math.abs(v - want));
        }
      });
      const t0 = process.hrtime.bigint();
      const p = model.predict(f);
      predNs += process.hrtime.bigint() - t0; nPred++;
      for (const [name, want] of Object.entries(fx.p)) {
        const err = Math.abs(p[name] - want);
        maxP = Math.max(maxP, err);
        assert.ok(err <= 1e-6, `fixture ${k} ${name}: ${p[name]} vs ${want}`);
      }
    });
    // Timing over many repetitions for a stable per-prediction figure.
    const feats = json.fixtures.map((fx) => build[sport](fx));
    const reps = 200;
    const t0 = process.hrtime.bigint();
    for (let r = 0; r < reps; r++) for (const f of feats) model.predict(f);
    const usPer = Number(process.hrtime.bigint() - t0) / 1e3 / (reps * feats.length);
    console.log(`[${sport}] fixtures=${nPred} max|dx|=${maxX} max|dp|=${maxP.toExponential(3)} ` +
      `predict=${usPer.toFixed(2)}us/call (cold avg ${(Number(predNs) / 1e3 / nPred).toFixed(2)}us)`);
  });
}

test('samples: raw summaries parse to expected timelines', () => {
  const dir = join(sportsDir, 'samples');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length > 0);
  for (const f of files) {
    const s = readJson(join(dir, f));
    const tl = f.startsWith('soccer') ? soccerTimeline(s.raw_summary) : basketballTimeline(s.raw_summary);
    assert.deepStrictEqual(tl, s.expected_timeline, f);
    console.log(`[sample] ${f}: ${tl.length} events match`);
  }
});

test('football situation + play.start helpers', () => {
  const game = { teamIds: ['12', '34'], abbrs: ['KC', 'BUF'], period: 2, clockSeconds: 300, scores: [14, 10] };
  const r = footballFeatures({ possession: '12', down: 2, distance: 7, possessionText: 'KC 35', homeTimeouts: 3, awayTimeouts: 1 }, game);
  assert.equal(r.offense, 0);
  assert.deepStrictEqual(r.features, {
    yardline_100: 65, down: 2, ydstogo: 7, goal_to_go: 0, qtr: 2, half_seconds_remaining: 300,
    game_seconds_remaining: 2100, score_differential: 4, posteam_timeouts_remaining: 3, defteam_timeouts_remaining: 1,
  });
  const r2 = footballFeatures({ possession: 34, down: 1, distance: 5, possessionText: 'KC 5', downDistanceText: '1st & Goal at KC 5' }, game);
  assert.equal(r2.offense, 1);
  assert.equal(r2.features.yardline_100, 5);
  assert.equal(r2.features.goal_to_go, 1);
  assert.equal(r2.features.score_differential, -4);
  assert.ok(Number.isNaN(r2.features.posteam_timeouts_remaining));
  assert.equal(footballFeatures({ possession: '12', down: 1, distance: 10, possessionText: '50' }, game).features.yardline_100, 50);
  assert.equal(footballFeatures({ down: 1 }, game), null);
  assert.equal(footballFeatures({ possession: '12', down: 0, possessionText: 'KC 20' }, game), null);

  const f = footballFeaturesFromPlayStart({ down: 3, distance: 4, yardsToEndzone: 4 },
    { period: 3, clockSeconds: 120, offenseIsHome: true, scoreOffense: 7, scoreDefense: 3, timeoutsOffense: 2, timeoutsDefense: 3 });
  assert.deepStrictEqual(f, {
    yardline_100: 4, down: 3, ydstogo: 4, goal_to_go: 1, qtr: 3, half_seconds_remaining: 1020,
    game_seconds_remaining: 1020, score_differential: 4, posteam_timeouts_remaining: 2, defteam_timeouts_remaining: 3,
  });
  const model = loadSportModel(readJson(join(sportsDir, 'football.json')));
  const p = model.predict(f);
  assert.ok(p.td_drive > 0 && p.td_drive < 1 && p.score_drive >= p.td_drive - 0.2);
});

test('basketballElapsed edge cases', () => {
  assert.equal(basketballElapsed(1, '12:00'), 0);
  assert.equal(basketballElapsed(4, '0:00'), 2880);
  assert.equal(basketballElapsed(2, '45.3'), 720 + 720 - 45.3);
  assert.equal(basketballElapsed(5, '5:00'), 2880);
  assert.equal(basketballElapsed(5, '6:00'), null);
  assert.equal(basketballElapsed(0, '1:00'), null);
  assert.equal(basketballElapsed(1, 'abc'), null);
});
