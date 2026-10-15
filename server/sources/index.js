import { fetchPolymarket } from './polymarket.js';
import { fetchKalshi } from './kalshi.js';

export { fetchPolymarket, fetchKalshi };

const SOURCES = { polymarket: fetchPolymarket, kalshi: fetchKalshi };

/** Status of each source from the most recent fetch: { polymarket: {ok, count, error, at, ms}, kalshi: {...} } */
export const sourceStatus = Object.fromEntries(
  Object.keys(SOURCES).map((k) => [k, { ok: false, count: 0, error: 'not fetched yet', at: null, ms: 0 }]),
);

/**
 * Like fetchAllMarkets but also returns per-source status. Never throws.
 * `limit` applies per source.
 * @returns {Promise<{markets: object[], sources: typeof sourceStatus}>}
 */
export async function fetchAllMarketsDetailed({ limit = 300 } = {}) {
  const names = Object.keys(SOURCES);
  const results = await Promise.allSettled(
    names.map(async (name) => {
      const t0 = Date.now();
      try {
        const markets = await SOURCES[name]({ limit });
        sourceStatus[name] = { ok: true, count: markets.length, error: null, at: new Date().toISOString(), ms: Date.now() - t0 };
        return markets;
      } catch (err) {
        const msg = err?.name === 'TimeoutError' ? 'timeout' : String(err?.message || err);
        console.warn(`[sources] ${name} failed: ${msg}`);
        sourceStatus[name] = { ok: false, count: 0, error: msg, at: new Date().toISOString(), ms: Date.now() - t0 };
        return [];
      }
    }),
  );
  const markets = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  return { markets, sources: structuredClone(sourceStatus) };
}

/** Fetch normalized markets from all sources (limit per source). Never throws. */
export async function fetchAllMarkets({ limit = 300 } = {}) {
  try {
    return (await fetchAllMarketsDetailed({ limit })).markets;
  } catch (err) {
    console.warn('[sources] fetchAllMarkets failed:', err?.message || err);
    return [];
  }
}
