// Historical price backfill (browser-safe: global fetch only).
//   Polymarket: CLOB prices-history, 1-min fidelity.
//   Kalshi: per-market 1-min candlesticks.
// Both return [{t (ms), p}] oriented to the market's tracked outcome, or [] on any failure.

const TIMEOUT_MS = 10_000;

/** ~`hours` of 1-min Polymarket history for a CLOB token id. */
export async function fetchPolymarketHistory(tokenId, { hours = 6, fetchImpl = fetch } = {}) {
  if (!tokenId) return [];
  try {
    const end = Math.floor(Date.now() / 1000);
    const start = end - Math.round(hours * 3600);
    const url = `https://clob.polymarket.com/prices-history?market=${encodeURIComponent(tokenId)}&startTs=${start}&endTs=${end}&fidelity=1`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.history || [])
      .map((x) => ({ t: Number(x.t) * 1000, p: Number(x.p) }))
      .filter((q) => Number.isFinite(q.t) && q.p >= 0 && q.p <= 1);
  } catch {
    return [];
  }
}

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : NaN;
};

/** ~`hours` of 1-min Kalshi candles for a market ticker (series derived from the event ticker). */
export async function fetchKalshiHistory(ticker, eventTicker, { hours = 6, fetchImpl = fetch } = {}) {
  if (!ticker) return [];
  try {
    const series = String(eventTicker || ticker).split('-')[0];
    const end = Math.floor(Date.now() / 1000);
    const start = end - Math.round(hours * 3600);
    const url = `https://api.elections.kalshi.com/trade-api/v2/series/${encodeURIComponent(series)}/markets/${encodeURIComponent(ticker)}/candlesticks?start_ts=${start}&end_ts=${end}&period_interval=1`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
    if (!res.ok) return [];
    const data = await res.json();
    const out = [];
    for (const c of data?.candlesticks || []) {
      const bid = num(c.yes_bid?.close_dollars);
      const ask = num(c.yes_ask?.close_dollars);
      const last = num(c.price?.close_dollars);
      // Same rule as the live normalizer: midpoint of a sane two-sided book, else last trade.
      let p = NaN;
      if (bid > 0 && ask < 1 && ask >= bid && ask - bid <= 0.2) p = Math.round(((bid + ask) / 2) * 10000) / 10000;
      else if (last > 0) p = last;
      if (p >= 0 && p <= 1) out.push({ t: Number(c.end_period_ts) * 1000, p });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Run `fn` over items with bounded concurrency. Never rejects.
 * onProgress(done, total) is called after each item.
 */
export async function mapLimit(items, limit, fn, onProgress) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch {
        results[i] = undefined;
      }
      done++;
      onProgress?.(done, items.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Backfill a detector from venue history.
 * markets: normalized Market[]; detector: has seedHistory(id, points).
 * opts: { polymarket = 80, kalshi = 30, hours = 6, concurrency = 4, log, fetchImpl }
 * → { polymarket: n, kalshi: n, points: n, ms }
 */
export async function backfillHistory(markets, detector, opts = {}) {
  const { polymarket = 80, kalshi = 30, hours = 6, concurrency = 4, log = () => {}, fetchImpl = fetch } = opts;
  const t0 = Date.now();
  const byVol = (a, b) => (b.volume24h || 0) - (a.volume24h || 0);
  const poly = markets.filter((m) => m.source === 'polymarket' && m.tokenId).sort(byVol).slice(0, polymarket);
  const kal = markets.filter((m) => m.source === 'kalshi').sort(byVol).slice(0, kalshi);
  const jobs = [...poly.map((m) => ['polymarket', m]), ...kal.map((m) => ['kalshi', m])];
  const stats = { polymarket: 0, kalshi: 0, points: 0, ms: 0 };
  let lastLog = 0;
  await mapLimit(
    jobs,
    concurrency,
    async ([src, m]) => {
      const pts = src === 'polymarket'
        ? await fetchPolymarketHistory(m.tokenId, { hours, fetchImpl })
        : await fetchKalshiHistory(m.id.replace(/^kalshi:/, ''), m.eventKey, { hours, fetchImpl });
      if (pts.length) {
        detector.seedHistory(m.id, pts);
        stats[src]++;
        stats.points += pts.length;
      }
    },
    (done, total) => {
      if (done === total || done - lastLog >= 20) {
        lastLog = done;
        log(`[backfill] ${done}/${total} markets fetched (${stats.points} points so far)`);
      }
    },
  );
  stats.ms = Date.now() - t0;
  return stats;
}
