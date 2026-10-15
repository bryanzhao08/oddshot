import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadModel, featuresFor, predictFeatures, scoreSpike } from './scorer.js';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'));
const model = loadModel();

test('model loads and matches fixtures version', () => {
  assert.ok(model, 'model.json loads');
  assert.equal(model.model, fixtures.model);
  assert.ok(model.trees.length > 0);
  assert.ok(fixtures.rows.length >= 30, `need held-out fixture rows, got ${fixtures.rows.length}`);
});

test('featuresFor matches Python features (1e-9)', () => {
  for (const [i, r] of fixtures.rows.entries()) {
    const x = featuresFor(r.spike, r.market, r.history, model);
    assert.ok(x, `row ${i}: features computed`);
    r.features.forEach((v, j) => {
      const name = model.features[j];
      if (v === null) assert.ok(Number.isNaN(x[j]), `row ${i} ${name}: expected NaN, got ${x[j]}`);
      else assert.ok(Math.abs(x[j] - v) <= 1e-9, `row ${i} ${name}: js ${x[j]} vs py ${v}`);
    });
  }
});

test('predictions match Python (margin, raw, calibrated pReal, contributions) to 1e-4', () => {
  for (const [i, r] of fixtures.rows.entries()) {
    const x = r.features.map((v) => (v === null ? NaN : v)); // Python features -> isolates the tree walk
    const p = predictFeatures(x, model);
    assert.ok(Math.abs(p.margin - r.margin) < 1e-4, `row ${i} margin ${p.margin} vs ${r.margin}`);
    assert.ok(Math.abs(p.raw - r.raw) < 1e-4, `row ${i} raw ${p.raw} vs ${r.raw}`);
    assert.ok(Math.abs(p.pReal - r.pReal) < 1e-4, `row ${i} pReal ${p.pReal} vs ${r.pReal}`);
    p.contrib.forEach((c, j) => assert.ok(Math.abs(c - r.contribs[j]) < 1e-4, `row ${i} contrib ${model.features[j]} ${c} vs ${r.contribs[j]}`));
  }
});

test('scoreSpike end-to-end matches Python pReal and returns the API shape', () => {
  for (const [i, r] of fixtures.rows.entries()) {
    const s = scoreSpike(r.spike, r.market, r.history);
    assert.ok(s, `row ${i} scored`);
    assert.ok(Math.abs(s.pReal - r.pReal) < 1e-4, `row ${i} pReal ${s.pReal} vs ${r.pReal}`);
    assert.ok(['event', 'likely', 'noise'].includes(s.label));
    assert.ok(Array.isArray(s.drivers) && s.drivers.length <= 3);
    for (const d of s.drivers) assert.ok(model.features.includes(d.feature) && Number.isFinite(d.impact));
    assert.match(s.model, /^xgboost@\d{4}-\d{2}-\d{2}$/);
  }
});

test('never throws on garbage input', () => {
  assert.equal(scoreSpike(null, null, null), null);
  assert.equal(scoreSpike({}, {}, []), null);
  assert.equal(scoreSpike({ from: 'x', to: 0.5, windowMs: 60000 }, {}, 'nope'), null);
  // minimal but valid spike with no history: still scores (features become missing)
  const s = scoreSpike({ from: 0.4, to: 0.5, windowMs: 120000, detectedAt: new Date().toISOString() }, { source: 'polymarket', category: 'sports' }, []);
  assert.ok(s && s.pReal >= 0 && s.pReal <= 1);
  assert.equal(s.historyMinutes, 0);
});
