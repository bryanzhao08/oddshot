import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  loadForecaster,
  setForecaster,
  forecastMove,
  featureVector,
  predictForecast,
  forecastFeatures,
  heuristicInputs,
  predictHeuristic,
} from './forecaster.js';

const fixtures = JSON.parse(readFileSync(new URL('./forecaster_fixtures.json', import.meta.url), 'utf8'));
const model = loadForecaster();
const MIN = 60000;

test('forecaster loads and matches fixtures version', () => {
  assert.ok(model, 'forecaster.json loads');
  assert.equal(model.model, fixtures.model);
  assert.match(model.model, /^xgboost-forecast@\d{4}-\d{2}-\d{2}$/);
  assert.ok(model.classifier.trees.length > 0 && model.regressor.trees.length > 0);
  assert.ok(fixtures.rows.length >= 30, `need held-out fixture rows, got ${fixtures.rows.length}`);
});

test('features match Python (1e-9)', () => {
  for (const [i, r] of fixtures.rows.entries()) {
    const x = featureVector(r.market, r.history, r.now, model);
    assert.ok(x, `row ${i}: features computed`);
    r.features.forEach((v, j) => {
      const name = model.features[j];
      if (v === null) assert.ok(Number.isNaN(x[j]), `row ${i} ${name}: expected NaN, got ${x[j]}`);
      else assert.ok(Math.abs(x[j] - v) <= 1e-9, `row ${i} ${name}: js ${x[j]} vs py ${v}`);
    });
  }
});

test('tree predictions match Python to 1e-4 (classifier margin/raw/calibrated, regressor, contributions)', () => {
  for (const [i, r] of fixtures.rows.entries()) {
    const x = r.features.map((v) => (v === null ? NaN : v));
    const p = predictForecast(x, model);
    assert.ok(Math.abs(p.margin - r.margin) < 1e-4, `row ${i} margin ${p.margin} vs ${r.margin}`);
    assert.ok(Math.abs(p.raw - r.raw) < 1e-4, `row ${i} raw`);
    assert.ok(Math.abs(p.pMove30 - r.pMove30) < 1e-4, `row ${i} pMove30 ${p.pMove30} vs ${r.pMove30}`);
    assert.ok(Math.abs(p.regMargin - r.regMargin) < 1e-4, `row ${i} reg ${p.regMargin} vs ${r.regMargin}`);
    p.contrib.forEach((c, j) => assert.ok(Math.abs(c - r.contribs[j]) < 1e-4, `row ${i} contrib ${model.features[j]}`));
  }
});

test('forecastMove end-to-end matches Python and returns the contract shape', () => {
  for (const [i, r] of fixtures.rows.entries()) {
    const f = forecastMove(r.market, r.history, r.now);
    assert.ok(f, `row ${i} forecast`);
    assert.deepEqual(Object.keys(f).sort(), ['drivers', 'expectedMovePts', 'historyMinutes', 'model', 'pMove30']);
    if (f.model === 'heuristic') {
      assert.ok(f.historyMinutes < 30, `row ${i}: heuristic only for short history`);
      assert.ok(Math.abs(f.pMove30 - r.heuristic.pMove30) < 1e-4, `row ${i} heuristic p`);
      continue;
    }
    assert.equal(f.model, model.model);
    assert.ok(Math.abs(f.pMove30 - r.pMove30) < 1e-4, `row ${i} pMove30 ${f.pMove30} vs ${r.pMove30}`);
    assert.ok(Math.abs(f.expectedMovePts - r.expectedMovePts) < 0.01, `row ${i} expectedMovePts`);
    assert.ok(Array.isArray(f.drivers) && f.drivers.length <= 3);
    for (const d of f.drivers) assert.ok(model.features.includes(d.feature) && Number.isFinite(d.impact));
    assert.ok(f.historyMinutes >= 30 && f.historyMinutes <= 360);
  }
});

test('heuristic inputs and prediction match Python (1e-6)', () => {
  for (const [i, r] of fixtures.rows.entries()) {
    const { f, g } = forecastFeatures(r.market, r.history, r.now, model);
    const inp = heuristicInputs(g, f);
    r.heuristic.inputs.forEach((v, j) => {
      if (v === null) assert.ok(Number.isNaN(inp[j]), `row ${i} heur input ${j}`);
      else assert.ok(Math.abs(inp[j] - v) < 1e-9, `row ${i} heur input ${j}: ${inp[j]} vs ${v}`);
    });
    const h = predictHeuristic(model.heuristic, inp);
    assert.ok(Math.abs(h.pMove30 - r.heuristic.pMove30) < 1e-6, `row ${i} heur p`);
    assert.ok(Math.abs(h.expectedMovePts - r.heuristic.expectedMovePts) < 1e-4, `row ${i} heur move`);
  }
});

test('heuristic fallback for short history (< 30 min)', () => {
  const now = Date.UTC(2026, 9, 10, 20, 0);
  const calm = Array.from({ length: 20 }, (_, k) => ({ t: now - (19 - k) * MIN, p: 0.92 }));
  const wild = Array.from({ length: 20 }, (_, k) => ({ t: now - (19 - k) * MIN, p: 0.5 + (k % 2 ? 0.04 : -0.04) }));
  const sports = { source: 'polymarket', category: 'sports', startTime: new Date(now - HOURS(1)).toISOString(), endDate: null };
  const a = forecastMove({ source: 'polymarket', category: 'politics', endDate: '2027-01-01T00:00:00Z' }, calm, now);
  const b = forecastMove(sports, wild, now);
  for (const f of [a, b]) {
    assert.equal(f.model, 'heuristic');
    assert.ok(f.pMove30 >= 0 && f.pMove30 <= 1 && f.expectedMovePts >= 0);
    assert.ok(f.historyMinutes < 30);
    assert.ok(f.drivers.length <= 3);
  }
  assert.ok(b.pMove30 > a.pMove30 * 5, `volatile live 50/50 (${b.pMove30}) >> calm 92% (${a.pMove30})`);
  assert.ok(a.pMove30 < 0.02);
});

test('heuristic when the model is missing; never throws on garbage', () => {
  const now = Date.UTC(2026, 9, 10, 20, 0);
  const hist = Array.from({ length: 120 }, (_, k) => ({ t: now - (119 - k) * MIN, p: 0.5 + 0.01 * Math.sin(k) }));
  try {
    assert.equal(setForecaster(null), null);
    assert.equal(loadForecaster(), null);
    const f = forecastMove({ source: 'kalshi', category: 'economics', endDate: null }, hist, now);
    assert.ok(f && f.model === 'heuristic' && f.historyMinutes >= 30, 'built-in heuristic without forecaster.json');
    assert.ok(f.pMove30 > 0 && f.pMove30 < 1);
    assert.equal(setForecaster({ ...model, classifier: null }), null);
  } finally {
    setForecaster(model);
  }
  assert.equal(forecastMove(null, null), null);
  assert.equal(forecastMove({}, 'nope', 'x'), null);
  const one = forecastMove({ probability: 0.5, category: 'sports' }, [], now);
  assert.ok(one && one.model === 'heuristic' && one.historyMinutes === 0);
  const full = forecastMove({ source: 'kalshi', category: 'economics', endDate: null }, hist, now);
  assert.ok(full && full.model === model.model && full.historyMinutes >= 30);
  // ISO timestamps, unsorted, future points ignored
  const shuffled = [...hist].reverse().map((q) => ({ t: new Date(q.t).toISOString(), p: q.p }));
  shuffled.push({ t: now + 10 * MIN, p: 0.99 });
  const f2 = forecastMove({ source: 'kalshi', category: 'economics', endDate: null }, shuffled, now);
  assert.equal(f2.pMove30, full.pMove30);
});

test('fast enough for ~600 markets every 20s', () => {
  const r = fixtures.rows.find((q) => q.history.length > 300) || fixtures.rows[0];
  // 20s polling over 6h ~ 1080 points
  const hist = [];
  for (let t = r.now - 360 * MIN; t <= r.now; t += 20000) hist.push({ t, p: 0.5 + 0.05 * Math.sin(t / 7e5) });
  const t0 = performance.now();
  for (let i = 0; i < 600; i++) forecastMove(r.market, hist, r.now);
  const ms = performance.now() - t0;
  assert.ok(ms < 2000, `600 forecasts took ${ms.toFixed(0)}ms`);
});

function HOURS(h) {
  return h * 3600000;
}
