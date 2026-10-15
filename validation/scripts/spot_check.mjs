import { writeFile } from 'node:fs/promises';
const base = 'http://localhost:8787';
const serverAt = new Date().toISOString();
const marketsRes = await fetch(`${base}/api/markets?limit=20`);
if (!marketsRes.ok) throw new Error(`Oddshot markets returned HTTP ${marketsRes.status}`);
const markets = await marketsRes.json();
const toNum = (v) => { const n = typeof v === 'number' ? v : Number.parseFloat(v); return Number.isFinite(n) ? n : null; };
const results = [];
for (const market of markets.slice(0, 10)) {
  const rec = { marketId: market.id, title: market.title, source: market.source, oddshotProbability: market.probability, oddshotCapturedAt: serverAt, publicApiUrl: null, publicApiProbability: null, differencePoints: null, withinOnePoint: false };
  try {
    if (market.source === 'polymarket') {
      rec.publicApiUrl = `https://gamma-api.polymarket.com/markets/${encodeURIComponent(market.id.slice('polymarket:'.length))}`;
      const res = await fetch(rec.publicApiUrl, { signal: AbortSignal.timeout(10000) });
      rec.publicApiStatus = res.status;
      if (!res.ok) throw new Error(`Gamma returned HTTP ${res.status}`);
      const raw = await res.json();
      const outcomes = Array.isArray(raw.outcomes) ? raw.outcomes : JSON.parse(raw.outcomes || '[]');
      const prices = Array.isArray(raw.outcomePrices) ? raw.outcomePrices : JSON.parse(raw.outcomePrices || '[]');
      const idx = Math.max(0, outcomes.findIndex((o) => String(o).toLowerCase() === 'yes'));
      rec.publicApiProbability = toNum(prices[idx]);
      rec.publicApiRaw = { outcomes, outcomePrices: prices };
    } else if (market.source === 'kalshi') {
      const ticker = market.id.slice('kalshi:'.length);
      rec.publicApiUrl = `https://api.elections.kalshi.com/trade-api/v2/markets/${encodeURIComponent(ticker)}`;
      const res = await fetch(rec.publicApiUrl, { signal: AbortSignal.timeout(10000) });
      rec.publicApiStatus = res.status;
      if (!res.ok) throw new Error(`Kalshi returned HTTP ${res.status}`);
      const body = await res.json();
      const raw = body.market || body;
      const bid = toNum(raw.yes_bid_dollars), ask = toNum(raw.yes_ask_dollars), last = toNum(raw.last_price_dollars);
      let p = null;
      if (bid != null && ask != null && bid > 0 && ask < 1 && ask >= bid && ask - bid <= 0.2) p = (bid + ask) / 2;
      else if (last != null && last > 0) p = last;
      else if (bid != null && ask != null && ask > 0) p = (bid + ask) / 2;
      rec.publicApiProbability = p;
      rec.publicApiRaw = { yes_bid_dollars: raw.yes_bid_dollars, yes_ask_dollars: raw.yes_ask_dollars, last_price_dollars: raw.last_price_dollars };
    }
    if (rec.publicApiProbability != null) {
      rec.differencePoints = Math.round(Math.abs(market.probability - rec.publicApiProbability) * 10000) / 100;
      rec.withinOnePoint = rec.differencePoints <= 1;
    }
  } catch (err) { rec.error = String(err.message || err); }
  results.push(rec);
}
const output = { checkedAt: new Date().toISOString(), oddshotServerCaptureAt: serverAt, checkedCount: results.length, withinOnePointCount: results.filter((r) => r.withinOnePoint).length, results };
await writeFile('validation/data/spot_check.json', JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify({ checkedCount: output.checkedCount, withinOnePointCount: output.withinOnePointCount, errors: results.filter((r)=>r.error).length, results: results.map(({marketId,source,differencePoints,error})=>({marketId,source,differencePoints,error})) }));
