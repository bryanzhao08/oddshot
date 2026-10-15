// Kalshi source (trade-api v2, public, no auth).
//
// The plain /markets listing is not sortable by volume and is dominated by
// multivariate (MVE) combo markets, so we use a two-phase approach:
//   1. Discovery (slow, ~70 pages, ~15-20s): page through ALL open events with
//      nested markets, keep the top single markets by 24h volume together with
//      their event metadata (category, series, title). Cached; refreshed in the
//      background every DISCOVERY_TTL_MS. Only the very first call awaits it.
//   2. Refresh (fast, every poll): GET /markets?tickers=... in chunks of 100 to
//      get fresh prices for the cached candidate tickers.

const BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const TIMEOUT_MS = 10_000;
const DISCOVERY_TTL_MS = 10 * 60_000;
const DISCOVERY_BUDGET_MS = 45_000;
const DISCOVERY_MAX_PAGES = 150;
const TICKER_CHUNK = 100;

const CATEGORY_MAP = {
  sports: 'sports',
  elections: 'politics',
  politics: 'politics',
  world: 'politics',
  economics: 'economics',
  financials: 'economics',
  commodities: 'economics',
  companies: 'economics',
  crypto: 'crypto',
  'climate and weather': 'weather',
  weather: 'weather',
  'science and technology': 'tech',
  tech: 'tech',
  entertainment: 'entertainment',
  mentions: 'entertainment',
  social: 'entertainment',
};

const SPORT_TAGS = [
  'nfl', 'nba', 'mlb', 'nhl', 'wnba', 'ncaaf', 'ncaab', 'atp', 'wta', 'itf', 'ufc', 'pga', 'f1',
  'nascar', 'epl', 'ucl', 'uecl', 'uel', 'mls', 'laliga', 'seriea', 'bundesliga', 'ligue1', 'esoccer',
  'lol', 'csgo', 'cs2', 'dota', 'valorant', 'soccer', 'tennis', 'golf', 'boxing', 'cricket',
];

const state = {
  candidates: new Map(), // ticker -> { market (raw), event (meta) }
  discoveredAt: 0,
  discovering: null, // Promise while discovery in flight
  lastLimit: 300,
};

function num(v, dflt = 0) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : dflt;
}

async function getJson(path) {
  const res = await fetch(BASE + path, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`kalshi HTTP ${res.status} ${path.slice(0, 60)}`);
  return res.json();
}

function isCombo(m, ev) {
  return Boolean(
    m.mve_collection_ticker ||
      m.mve_selected_legs ||
      /^KXMVE/i.test(m.ticker || '') ||
      /^KXMVE/i.test(m.event_ticker || '') ||
      /^KXMVE/i.test(ev?.series_ticker || ''),
  );
}

export function kalshiProbability(m) {
  const bid = num(m.yes_bid_dollars, NaN);
  const ask = num(m.yes_ask_dollars, NaN);
  const last = num(m.last_price_dollars, NaN);
  // Bid of 0 / ask of 1 means an empty side of the book.
  if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask < 1 && ask >= bid && ask - bid <= 0.2) {
    return (bid + ask) / 2;
  }
  if (Number.isFinite(last) && last > 0) return last;
  if (Number.isFinite(bid) && Number.isFinite(ask) && ask > 0) return (bid + ask) / 2;
  return NaN;
}

function deriveTags(ev, categoryRaw) {
  const tags = new Set();
  const series = String(ev?.series_ticker || '').toLowerCase().replace(/^kx/, '');
  if (series) tags.add(series);
  for (const s of SPORT_TAGS) if (series.startsWith(s)) tags.add(s);
  const comp = ev?.product_metadata?.competition;
  if (comp) tags.add(String(comp).toLowerCase());
  if (/^(fed|fomc)/.test(series)) tags.add('fed');
  if (/^(btc|eth|sol|xrp|doge)/.test(series)) tags.add(series.match(/^(btc|eth|sol|xrp|doge)/)[1]);
  if (categoryRaw) tags.add(String(categoryRaw).toLowerCase());
  return [...tags].slice(0, 8);
}

function buildTitle(m, ev) {
  const mt = String(m.title || '').trim();
  const et = String(ev?.title || '').trim();
  if (!et) return mt || m.ticker;
  // Market titles like "Seattle wins" lack context; questions are self-contained.
  if (mt.endsWith('?') && mt.length > 30) return mt;
  if (!mt) return et;
  return `${et}: ${mt}`;
}

const HOUR = 3600_000;

function computeLive(category, endMs, now) {
  if (!Number.isFinite(endMs)) return false;
  if (category === 'sports') {
    // expected_expiration_time for games is ~ shortly after the expected end.
    return endMs >= now - HOUR && endMs - now <= 4 * HOUR;
  }
  // Short-dated non-sports markets (e.g. 15-min crypto, data releases) resolving within the hour.
  return endMs > now && endMs - now <= HOUR;
}

const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

/** UTC offset (minutes) of America/New_York at a given instant. Falls back to a US-DST approximation. */
function nyOffsetMin(ms) {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' })
      .formatToParts(new Date(ms))
      .find((x) => x.type === 'timeZoneName')?.value; // "GMT-4"
    const mm = /GMT([+-]\d+)(?::(\d+))?/.exec(name || '');
    if (mm) return Number(mm[1]) * 60 + (mm[1].startsWith('-') ? -1 : 1) * Number(mm[2] || 0);
  } catch {}
  const mo = new Date(ms).getUTCMonth();
  return mo >= 2 && mo <= 10 ? -240 : -300;
}

const GAME_SERIES = /(GAME|MATCH|FIGHT|BOUT)$/;
const GAME_LEN_MS = 3 * HOUR;

/**
 * Best-effort scheduled start for a Kalshi event. Kalshi has no start-time field, but
 * game event tickers embed the date and often the ET start time, e.g.
 * KXMLBGAME-26OCT151800TBCLE = 2026-10-15 18:00 ET. For single-game series without a
 * time in the ticker, the start is estimated as expected expiration minus ~3h.
 * Returns ISO string or null.
 */
export function kalshiStartTime(m, ev) {
  const eventTicker = String(m?.event_ticker || ev?.event_ticker || '');
  const mm = /-(\d{2})([A-Z]{3})(\d{2})(\d{4})?(?=[A-Z]|$)/.exec(eventTicker);
  if (!mm || !(mm[2] in MONTHS)) return null;
  const [, yy, mon, dd, hhmm] = mm;
  const y = 2000 + Number(yy);
  if (hhmm) {
    const h = Number(hhmm.slice(0, 2));
    const mi = Number(hhmm.slice(2));
    if (h > 23 || mi > 59) return null;
    const naive = Date.UTC(y, MONTHS[mon], Number(dd), h, mi);
    return new Date(naive - nyOffsetMin(naive) * 60_000).toISOString();
  }
  const series = String(ev?.series_ticker || eventTicker.split('-')[0]);
  const exp = Date.parse(m?.occurrence_datetime || m?.expected_expiration_time || '');
  if (GAME_SERIES.test(series) && Number.isFinite(exp)) return new Date(exp - GAME_LEN_MS).toISOString();
  return null;
}

export function normalizeKalshi(m, ev, now = Date.now()) {
  if (!m || isCombo(m, ev)) return null;
  if (m.market_type && m.market_type !== 'binary') return null;
  if (m.status && !['active', 'open'].includes(m.status)) return null;
  const probability = kalshiProbability(m);
  if (!(probability >= 0 && probability <= 1)) return null;
  const categoryRaw = ev?.category || '';
  const category = CATEGORY_MAP[String(categoryRaw).toLowerCase()] || 'other';
  const endDate = m.expected_expiration_time || m.close_time || null;
  const endMs = endDate ? Date.parse(endDate) : NaN;
  const prev = num(m.previous_price_dollars, NaN);
  const market = {
    id: `kalshi:${m.ticker}`,
    source: 'kalshi',
    title: buildTitle(m, ev),
    outcome: m.yes_sub_title && !String(m.title || '').endsWith('?') ? String(m.yes_sub_title) : 'Yes',
    probability,
    // Contracts have $1 notional, so contract volume ~= notional USD volume.
    volume24h: num(m.volume_24h_fp ?? m.volume_24h),
    // No public liquidity field; open interest (contracts) is the closest proxy.
    liquidity: num(m.liquidity_dollars ?? m.open_interest_fp),
    category,
    tags: deriveTags(ev, categoryRaw),
    url: `https://kalshi.com/markets/${String(m.event_ticker || ev?.event_ticker || '').toLowerCase()}`,
    endDate,
    live: computeLive(category, endMs, now),
    startTime: kalshiStartTime(m, ev),
    eventKey: m.event_ticker || ev?.event_ticker || null,
    eventTitle: ev?.title || null,
    groupTitle: m.yes_sub_title || null,
  };
  if (Number.isFinite(prev) && prev > 0) market.change24h = +(probability - prev).toFixed(4);
  return market;
}

function eventMeta(ev) {
  return {
    event_ticker: ev.event_ticker,
    series_ticker: ev.series_ticker,
    title: ev.title,
    sub_title: ev.sub_title,
    category: ev.category,
    mutually_exclusive: ev.mutually_exclusive,
    product_metadata: ev.product_metadata,
  };
}

async function discover(limit) {
  const t0 = Date.now();
  const all = [];
  let cursor = '';
  let pages = 0;
  let lastErr = null;
  while (pages < DISCOVERY_MAX_PAGES && Date.now() - t0 < DISCOVERY_BUDGET_MS) {
    let data;
    try {
      data = await getJson(`/events?status=open&limit=200&with_nested_markets=true${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    } catch (err) {
      lastErr = err;
      break;
    }
    pages++;
    for (const ev of data.events || []) {
      if (/^KXMVE/i.test(ev.series_ticker || ev.event_ticker || '')) continue;
      const meta = eventMeta(ev);
      let mkts = (ev.markets || []).filter((m) => !isCombo(m, ev) && num(m.volume_24h_fp) > 0 && (m.status === 'active' || m.status === 'open'));
      // Two-sided head-to-head events ("A wins" / "B wins") are complements; keep the busier side.
      if (ev.mutually_exclusive && (ev.markets || []).length === 2 && mkts.length === 2) {
        mkts = [mkts.sort((a, b) => num(b.volume_24h_fp) - num(a.volume_24h_fp))[0]];
      }
      for (const m of mkts) all.push({ market: m, event: meta });
    }
    cursor = data.cursor;
    if (!cursor) break;
  }
  if (!all.length) throw lastErr || new Error('kalshi: discovery found no markets');
  all.sort((a, b) => num(b.market.volume_24h_fp) - num(a.market.volume_24h_fp));
  // Keep some headroom beyond `limit` so volume reshuffles between discoveries are tolerated.
  const keep = all.slice(0, Math.ceil(limit * 1.3));
  state.candidates = new Map(keep.map((c) => [c.market.ticker, c]));
  state.discoveredAt = Date.now();
  return state.candidates;
}

function ensureDiscovery(limit) {
  if (!state.discovering) {
    state.discovering = discover(limit).finally(() => {
      state.discovering = null;
    });
  }
  return state.discovering;
}

async function refreshPrices() {
  const tickers = [...state.candidates.keys()];
  const chunks = [];
  for (let i = 0; i < tickers.length; i += TICKER_CHUNK) chunks.push(tickers.slice(i, i + TICKER_CHUNK));
  const results = await Promise.allSettled(
    chunks.map((c) => getJson(`/markets?limit=${TICKER_CHUNK}&tickers=${c.map(encodeURIComponent).join(',')}`)),
  );
  let updated = 0;
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const m of r.value.markets || []) {
      const c = state.candidates.get(m.ticker);
      if (!c) continue;
      c.market = m;
      updated++;
    }
  }
  if (!updated && results.length) {
    const err = results.find((r) => r.status === 'rejected')?.reason;
    throw err || new Error('kalshi: price refresh returned nothing');
  }
  return updated;
}

/** Fetch top `limit` Kalshi single (non-combo) markets by 24h volume. Throws on total failure. */
export async function fetchKalshi({ limit = 300 } = {}) {
  const now = Date.now();
  state.lastLimit = limit;
  const stale = now - state.discoveredAt > DISCOVERY_TTL_MS || state.candidates.size < Math.min(limit, 50);
  if (!state.candidates.size) {
    await ensureDiscovery(limit); // cold start: must wait once
  } else {
    if (stale) ensureDiscovery(limit).catch((err) => console.warn('[kalshi] background discovery failed:', err.message));
    // Fresh prices for the known candidates (discovery data is used as-is if just refreshed).
    if (now - state.discoveredAt > 5_000) await refreshPrices();
  }
  const out = [];
  for (const { market, event } of state.candidates.values()) {
    const m = normalizeKalshi(market, event, now);
    if (m) out.push(m);
  }
  out.sort((a, b) => b.volume24h - a.volume24h);
  return out.slice(0, limit);
}

/** Test/debug helper. */
export function _kalshiState() {
  return state;
}
