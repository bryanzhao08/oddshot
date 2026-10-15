import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { Detector } from '../../server/engine/detector.js';
import { scoreSpike, loadModel } from '../../server/ml/scorer.js';

const dataDir = resolve('validation/data');
const outputPath = resolve(dataDir, 'replay_results.json');
const asMs = (t) => typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : Date.parse(t);
const marketFrom = (e, file, index) => {
  const m = e.market || e;
  const snapshot = m.gamma_market_snapshot || {};
  const eventSnapshot = m.gamma_event_snapshot || {};
  const venue = m.source || m.venue || m.platform || 'Polymarket';
  const source = String(venue).toLowerCase().includes('kalshi') ? 'kalshi' : 'polymarket';
  const title = m.title || m.question || snapshot.question || m.market_question || m.eventTitle || e.market_question || e.title || e.event_title || e.description || `${file} event ${index + 1}`;
  const fileCategory = /^sports_/.test(file) ? 'sports' : /election/.test(file) ? 'politics' : /fed|cpi|court/.test(file) ? 'economics' : /non_sports_tech/.test(file) ? 'tech' : 'other';
  return {
    id: m.id || (source === 'kalshi' ? `kalshi:${m.ticker || m.market_ticker || index}` : `polymarket:${m.conditionId || m.condition_id || m.tokenId || m.token_id || m.yes_token || m.market_id || index}`),
    source, title, outcome: m.outcome || m.selectedOutcome || m.selected_outcome || m.tracked_outcome || m.outcomeName || 'Yes',
    probability: Number((e.points || e.price_history?.raw_history || e.history || [])[0]?.p ?? 0.5),
    volume24h: Number(m.volume24h || m.volume_24h || 0), liquidity: Number(m.liquidity || 0),
    category: m.category || e.category || fileCategory, tags: m.tags || [],
    url: m.url || m.market_url || m.marketUrl || e.market_url || e.event_url || m.eventUrl || '', endDate: m.endDate || m.end_date || eventSnapshot.endDate || snapshot.endDate || null,
    live: Boolean(m.live),
  };
};

function extractEvents(json) {
  const out = [];
  for (const k of ['events', 'markets', 'records']) if (Array.isArray(json?.[k])) out.push(...json[k]);
  if (!out.length && Array.isArray(json)) out.push(...json);
  return out;
}

const files = (await readdir(dataDir)).filter((f) => f.endsWith('.json') && f !== 'replay_results.json' && f !== 'non_sports_courts.json' && !f.startsWith('api_') && f !== 'live_poll.json' && f !== 'false_positives.json' && f !== 'spot_check.json' && f !== 'local_webhook_check.json');
const eventResults = [];
const allSpikes = [];
const skipped = [];
const model = loadModel();

for (const file of files) {
  const json = JSON.parse(await readFile(resolve(dataDir, file), 'utf8'));
  const events = extractEvents(json);
  for (let ei = 0; ei < events.length; ei++) {
    const e = events[ei];
    const rawPoints = e.points || e.prices || e.price_history?.raw_history || e.token_history?.raw_response?.history || e.token_history?.history || e.history?.points || e.history || e.raw_history;
    const momentValue = e.moment || e.news_event_utc || e.news_moment_utc || e.known_news_moment?.timestamp_utc;
    if (!Array.isArray(rawPoints) || rawPoints.length < 3 || !momentValue) {
      skipped.push({ file, index: ei, reason: 'Missing >=3 raw points or event moment', title: e.market?.question || e.market?.title || e.description || null });
      continue;
    }
    const market = marketFrom(e, basename(file), ei);
    const points = rawPoints.map((q) => ({ t: asMs(q.t ?? q.timestamp ?? q.time), p: Number(q.p ?? q.price ?? q.probability) })).filter((q) => Number.isFinite(q.t) && Number.isFinite(q.p) && q.p >= 0 && q.p <= 1).sort((a,b)=>a.t-b.t);
    if (points.length < 3) { skipped.push({ file, index: ei, reason: 'Invalid price points' }); continue; }
    const detector = new Detector();
    const spikes = [];
    for (const q of points) {
      market.probability = q.p;
      for (const s of detector.ingest([market], q.t)) {
        const snapshot = detector.history(market.id);
        const score = scoreSpike(s, market, snapshot);
        const record = { ...s, pReal: score?.pReal ?? null, pRealLabel: score?.label ?? null, historyMinutes: score?.historyMinutes ?? null };
        spikes.push(record);
        allSpikes.push({ file, index: ei, ...record });
      }
    }
    const moment = asMs(momentValue);
    const candidates = spikes.map((s) => ({ spike: s, offsetMin: (Date.parse(s.detectedAt) - moment) / 60000 })).filter((x) => Math.abs(x.offsetMin) <= 90).sort((a,b)=>Math.abs(a.offsetMin)-Math.abs(b.offsetMin));
    const nearest = candidates[0] || null;
    eventResults.push({
      file, title: market.title, marketId: market.id, marketUrl: market.url,
      moment: new Date(moment).toISOString(), momentSource: e.momentSource || e.news_url || e.resolution_source_url || e.news_source_url || e.known_news_moment?.source_links || e.news_sources?.map((s) => s.url) || null,
      historySource: e.historySource || e.history_api_url || e.price_history?.endpoint || e.token_history?.query_url || e.historyRequest?.endpoint || null,
      pointCount: points.length, historyStart: new Date(points[0].t).toISOString(), historyEnd: new Date(points.at(-1).t).toISOString(),
      spikesInHistory: spikes.length,
      firedNearMoment: Boolean(nearest),
      leadLagMinutes: nearest ? Math.round(nearest.offsetMin * 10) / 10 : null,
      severity: nearest?.spike.severity || null,
      pReal: nearest?.spike.pReal ?? null,
      pRealLabel: nearest?.spike.pRealLabel || null,
      selectedSpike: nearest?.spike || null,
      allSpikes: spikes,
      momentDescription: e.momentDescription || e.moment_description || e.description || null,
    });
  }
}

const result = {
  generatedAt: new Date().toISOString(),
  detectorDefaults: Detector ? 'server/engine/detector.js defaults' : null,
  scorerModel: model?.model || null,
  pRealLikelyThreshold: model?.thresholds?.likely ?? 0.593,
  eventWindowMinutes: 90,
  eventCount: eventResults.length,
  detectedCount: eventResults.filter((e) => e.firedNearMoment).length,
  eventResults,
  allSpikes,
  skipped,
};
await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ outputPath, eventCount: result.eventCount, detectedCount: result.detectedCount, spikeCount: allSpikes.length, skipped: skipped.length }));
