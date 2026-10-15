// Polymarket source (gamma API, public, no auth).
// Fetches the top active markets by 24h volume and normalizes them to the
// contract's Market shape. Never throws (returns [] on failure via index.js).

const BASE = 'https://gamma-api.polymarket.com';
const PAGE = 100; // gamma caps `limit` at 100
const TIMEOUT_MS = 10_000;

// Tag slugs that carry no useful meaning for subscribers.
const JUNK_TAG = /^(earn-\d+|recurring|hide-from-new|rewards-.*|parent-for-derivative|games|weekly|monthly|yearly|daily|multi-strikes|hit-price|main-election|props|featured|all)$/;

// Category rules, checked in priority order: first match wins.
const CATEGORY_RULES = [
  ['sports', /^(sports|nfl|nba|mlb|nhl|wnba|soccer|football|basketball|baseball|hockey|tennis|golf|ufc|mma|boxing|f1|formula-1|cricket|esports|cfb|ncaab|cbb|epl|ucl|la-liga|champions-league|olympics|nascar|league-of-legends|counter-strike-2|dota-2|valorant|chess)$/],
  ['crypto', /^(crypto|bitcoin|ethereum|solana|xrp|crypto-prices|dogecoin|stablecoins|airdrops|memecoins)$/],
  ['weather', /^(weather|climate|hurricanes?|temperature|global-temp|natural-disasters|earthquakes?|snow|rain)$/],
  ['tech', /^(tech|ai|science|openai|anthropic|spacex|space|ai-rankings|big-tech|apple|google|nvidia|gpt-releases|compute)$/],
  ['economics', /^(economy|economics|fed|fed-rates|fomc|finance|business|macro-indicators|inflation|cpi|us-cpi|gdp|stocks|commodities|interest-rates|recession|tariffs|economic-policy|jobs|ipo|ipos|earnings|equities|corporate-financials|global-rates)$/],
  ['entertainment', /^(pop-culture|culture|entertainment|movies|music|awards|oscars|grammys|emmys|tv|celebrities|tweets-markets|youtube|twitter|elon-musk|mentions|box-office|gaming|video-games)$/],
  ['politics', /^(politics|elections|geopolitics|world|us-presidential-election|midterms|global-elections|world-elections|trump|congress|senate|foreign-policy|middle-east|ukraine|israel|iran|china)$/],
];

const KEYWORD_RULES = [
  ['sports', /\b(vs\.?|win on \d{4}|nfl|nba|mlb|nhl|super bowl|world series|champions league|premier league|grand slam|o\/u|spread:|game \d winner|bo3|bo5)\b/i],
  ['crypto', /\b(bitcoin|btc|ethereum|eth|solana|crypto|xrp|dogecoin)\b/i],
  ['weather', /\b(hurricane|temperature|weather|rainfall|snowfall|tornado|heat)\b/i],
  ['economics', /\b(fed|interest rates?|inflation|cpi|gdp|recession|s&p|nasdaq|unemployment|tariff|ipo)\b/i],
  ['tech', /\b(ai|openai|anthropic|gpt|gemini|spacex|apple|google|nvidia|tesla)\b/i],
  ['entertainment', /\b(tweets?|oscars?|grammys?|album|movie|box office|taylor swift|mrbeast|netflix)\b/i],
  ['politics', /\b(election|president|senate|house|governor|minister|trump|ceasefire|invade|war|parliament|nominee|mayor)\b/i],
];

export function categorizeTags(tags, text = '') {
  for (const [cat, re] of CATEGORY_RULES) if (tags.some((t) => re.test(t))) return cat;
  for (const [cat, re] of KEYWORD_RULES) if (re.test(text)) return cat;
  return 'other';
}

function parseJsonArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string') return [];
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

function num(v, dflt = 0) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : dflt;
}

function parseTime(v) {
  if (!v) return NaN;
  // gamma sometimes uses "2026-10-15 05:30:00+00"
  const s = String(v).replace(' ', 'T').replace(/\+00$/, 'Z');
  return Date.parse(s);
}

const GAME_LEN_MS = 4 * 3600_000;
const LIVE_HORIZON_MS = 6 * 3600_000;

function computeLive(m, ev, category, now) {
  if (ev?.ended === true || m.closed) return false;
  if (ev?.live === true) return true;
  const start = parseTime(m.gameStartTime || m.eventStartTime || ev?.startTime);
  if (Number.isFinite(start) && (m.gameStartTime || m.sportsMarketType || category === 'sports')) {
    return now >= start && now <= start + GAME_LEN_MS;
  }
  if (category === 'sports') {
    const end = parseTime(m.endDate);
    return Number.isFinite(end) && end > now && end - now <= LIVE_HORIZON_MS;
  }
  return false;
}

export function normalizePolymarket(m, now = Date.now()) {
  const outcomes = parseJsonArray(m.outcomes);
  const prices = parseJsonArray(m.outcomePrices).map((x) => num(x, NaN));
  if (!outcomes.length || !Number.isFinite(prices[0])) return null;
  const yesIdx = outcomes.findIndex((o) => String(o).toLowerCase() === 'yes');
  const idx = yesIdx >= 0 ? yesIdx : 0;
  const probability = prices[idx];
  if (!(probability >= 0 && probability <= 1)) return null;

  const ev = Array.isArray(m.events) ? m.events[0] : null;
  const rawTags = (m.tags || ev?.tags || [])
    .map((t) => String(t?.slug || t?.label || t || '').toLowerCase())
    .filter(Boolean);
  const tags = [...new Set(rawTags.filter((t) => !JUNK_TAG.test(t)))].slice(0, 10);
  const text = `${m.question || ''} ${ev?.title || ''}`;
  const category = categorizeTags(rawTags, text);

  const slug = ev?.slug || m.slug;
  const change1h = num(m.oneHourPriceChange, NaN);
  const change24h = num(m.oneDayPriceChange, NaN);
  const startMs = parseTime(m.gameStartTime || m.eventStartTime || ev?.startTime);
  const market = {
    id: `polymarket:${m.id}`,
    source: 'polymarket',
    title: m.question || ev?.title || m.slug,
    outcome: String(outcomes[idx]),
    otherOutcome: outcomes.length === 2 ? String(outcomes[1 - idx]) : null, // "Under" for an O/U market, "No" for Yes/No
    probability,
    volume24h: num(m.volume24hr ?? m.volume24hrClob),
    liquidity: num(m.liquidityNum ?? m.liquidity),
    category,
    tags,
    url: `https://polymarket.com/event/${slug}`,
    endDate: m.endDate || null,
    live: computeLive(m, ev, category, now),
    startTime: Number.isFinite(startMs) ? new Date(startMs).toISOString() : null,
    eventKey: ev?.slug || null,
    eventTitle: ev?.title || null, // parent event title ("Fed decision in October")
    groupTitle: m.groupItemTitle || null, // short label inside a multi-market event ("25 bps decrease")
    tokenId: parseJsonArray(m.clobTokenIds)[idx] || null, // CLOB token, for price-history lookups
  };
  // oneHourPriceChange is in price units of the first outcome (Yes).
  if (Number.isFinite(change1h)) market.change1h = idx === 0 ? change1h : -change1h;
  if (Number.isFinite(change24h)) market.change24h = idx === 0 ? change24h : -change24h;
  return market;
}

async function fetchPage(offset, limit) {
  const url = `${BASE}/markets?active=true&closed=false&order=volume24hr&ascending=false&include_tag=true&limit=${limit}&offset=${offset}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`polymarket HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('polymarket: unexpected response shape');
  return data;
}

/** Fetch top `limit` Polymarket markets by 24h volume. Throws on total failure. */
export async function fetchPolymarket({ limit = 300 } = {}) {
  const now = Date.now();
  const offsets = [];
  for (let o = 0; o < limit; o += PAGE) offsets.push(o);
  const pages = await Promise.allSettled(offsets.map((o) => fetchPage(o, Math.min(PAGE, limit - o))));
  const ok = pages.filter((p) => p.status === 'fulfilled');
  if (!ok.length) throw pages[0]?.reason || new Error('polymarket: no data');
  const seen = new Set();
  const out = [];
  for (const p of ok) {
    for (const raw of p.value) {
      const m = normalizePolymarket(raw, now);
      if (!m || seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
    }
  }
  out.sort((a, b) => b.volume24h - a.volume24h);
  return out.slice(0, limit);
}
