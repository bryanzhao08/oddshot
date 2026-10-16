// Browser-safe crypto spot context. History is intentionally process-local: the
// server's normal polling cadence fills it in over time, while a cold start
// still returns the current Coinbase price with null changes.

const SYMBOLS = [
  { symbol: 'BTC', names: ['bitcoin', 'btc'] },
  { symbol: 'ETH', names: ['ethereum', 'ether', 'eth'] },
  { symbol: 'SOL', names: ['solana', 'sol'] },
  { symbol: 'XRP', names: ['xrp', 'ripple'] },
  { symbol: 'DOGE', names: ['dogecoin', 'doge'] },
  { symbol: 'ADA', names: ['cardano', 'ada'] },
  { symbol: 'AVAX', names: ['avalanche', 'avax'] },
  { symbol: 'LINK', names: ['chainlink', 'link'] },
  { symbol: 'DOT', names: ['polkadot', 'dot'] },
  { symbol: 'LTC', names: ['litecoin', 'ltc'] },
  { symbol: 'BCH', names: ['bitcoin cash', 'bch'] },
  { symbol: 'SHIB', names: ['shiba inu', 'shib'] },
  { symbol: 'TON', names: ['toncoin', 'ton'] },
  { symbol: 'SUI', names: ['sui'] },
  { symbol: 'HBAR', names: ['hedera', 'hbar'] },
];

const historyBySymbol = new Map();
const MAX_HISTORY_MS = 2 * 60 * 60 * 1000;
const MAX_HISTORY_POINTS = 500;

function marketText(market) {
  const values = [market?.title, market?.question, market?.category];
  if (Array.isArray(market?.tags)) values.push(...market.tags);
  else if (typeof market?.tags === 'string') values.push(market.tags);
  return values.filter((value) => typeof value === 'string').join(' ').toLowerCase();
}

function hasToken(text, token) {
  // Names containing spaces (for example "bitcoin cash") should match as a
  // phrase. Tickers and single-word aliases must be bounded to avoid matching
  // ordinary words such as "dot" inside "today".
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'i').test(text);
}

export function detectAssetSymbol(market) {
  const text = marketText(market);
  if (!text) return null;
  for (const asset of SYMBOLS) {
    if (asset.names.some((name) => hasToken(text, name))) return asset.symbol;
  }
  return null;
}

function normalizeNow(now) {
  const value = now instanceof Date ? now.getTime() : Number(now);
  return Number.isFinite(value) ? value : Date.now();
}

function percentageChange(history, current, now, windowMs) {
  const target = now - windowMs;
  let closest = null;
  let closestDistance = Infinity;
  for (const point of history) {
    if (point.t > now) continue;
    const distance = Math.abs(point.t - target);
    if (distance < closestDistance) {
      closest = point;
      closestDistance = distance;
    }
  }
  // Don't label a much shorter or longer interval as a 5m/1h change. The
  // tolerance also accommodates the usual 20-second polling jitter.
  if (!closest || closestDistance > windowMs * 0.35 || closest.price <= 0) return null;
  return current / closest.price - 1;
}

function addHistory(symbol, price, now) {
  const history = historyBySymbol.get(symbol) || [];
  history.push({ t: now, price });
  const cutoff = now - MAX_HISTORY_MS;
  const retained = history.filter((point) => point.t >= cutoff).slice(-MAX_HISTORY_POINTS);
  historyBySymbol.set(symbol, retained);
  return retained;
}

/**
 * Get Coinbase spot context for a crypto market.
 *
 * change5m and change1h are fractional price changes (0.01 means +1%). They
 * remain null until in-memory samples cover approximately the requested
 * lookback. This function is safe to call in Node or a browser and never throws.
 */
export async function getAssetContext(market, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  try {
    const symbol = detectAssetSymbol(market);
    if (!symbol || typeof fetchImpl !== 'function') return null;

    const response = await fetchImpl(`https://api.coinbase.com/v2/prices/${symbol}-USD/spot`);
    if (!response?.ok) return null;
    const payload = await response.json();
    const data = payload?.data;
    const price = Number(data?.amount);
    if (!Number.isFinite(price) || price <= 0) return null;

    const timestamp = normalizeNow(now);
    const previous = historyBySymbol.get(symbol) || [];
    const change5m = percentageChange(previous, price, timestamp, 5 * 60 * 1000);
    const change1h = percentageChange(previous, price, timestamp, 60 * 60 * 1000);
    addHistory(symbol, price, timestamp);

    return {
      kind: 'asset',
      symbol,
      price,
      change5m,
      change1h,
      source: 'coinbase',
      fetchedAt: new Date(timestamp).toISOString(),
    };
  } catch {
    return null;
  }
}

