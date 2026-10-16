# Oddshot — build contract

Product name: **Oddshot** — "The odds move before the headlines do." (formerly EventPulse)

Shared interface spec for everyone building this. Zero runtime npm dependencies:
Node >= 20 built-ins only (`node:http`, global `fetch`, `node:fs`, `node:test`). ES modules.

## Idea
Prediction-market prices are live crowd probabilities. When a probability jumps
suddenly (a team gets into scoring position, a debate gaffe, a Fed leak), something
is *happening right now*. EventPulse polls real markets (Polymarket + Kalshi), detects
spikes, computes a volatility index per category (a "VIX for events"), and alerts
subscribers — photographers at a game, traders, fans, journalists — so they don't
miss the moment.

## Layout
```
server/
  index.js              # HTTP server, static files, REST, SSE, wires everything (agent B)
  store.js              # JSON-file persistence for subscriptions/watchlist/alerts (agent B)
  notify.js             # webhook delivery: generic JSON, Discord, Slack, ntfy.sh (agent B)
  sources/polymarket.js # agent A
  sources/kalshi.js     # agent A
  sources/index.js      # agent A: fetchAllMarkets()
  engine/detector.js    # agent A: price history, spike detection, volatility index
  engine/*.test.js      # agent A: node:test tests
public/
  index.html, app.js, styles.css   # agent C, vanilla JS, no build step
data/                   # runtime JSON (gitignored)
```

## Normalized market (output of sources)
```js
{
  id: "polymarket:2589812" | "kalshi:TICKER",   // globally unique, prefixed
  source: "polymarket" | "kalshi",
  title: "Will there be no change in Fed rates after Oct 2026 meeting?",
  outcome: "Yes",            // the outcome whose probability we track
  probability: 0.715,        // 0..1
  volume24h: 2664513.76,     // USD, number (0 if unknown)
  liquidity: 12345,          // number (0 if unknown)
  category: "sports" | "politics" | "crypto" | "economics" | "entertainment" | "weather" | "tech" | "other",
  tags: ["nfl", "fed"],      // lowercase strings, may be empty
  url: "https://polymarket.com/event/<event-slug>" | "https://kalshi.com/markets/<event_ticker>",
  endDate: "2026-10-29T03:59:00Z" | null,
  live: true|false           // best guess that the underlying event is in progress now (e.g. game started, endDate within ~6h)
}
```
`sources/index.js` exports `async function fetchAllMarkets({ limit = 300 } = {})` → `Market[]`.
It must never throw; a failing source logs a warning and contributes `[]`.
Each source fetches the top markets by 24h volume (active, open) with pagination as
needed, timeout ~10s via `AbortSignal.timeout`.

Polymarket: `GET https://gamma-api.polymarket.com/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=N`
(fields `outcomes` and `outcomePrices` are JSON-encoded strings; `events[0].slug` for URL; `events[0].tags`/category may help).
Kalshi: `GET https://api.elections.kalshi.com/trade-api/v2/markets?status=open&limit=N` (+cursor);
prices are in `*_dollars` string fields (e.g. `last_price_dollars`, `yes_bid_dollars`, `yes_ask_dollars`), use bid/ask midpoint
when both present else last price; `volume_24h_fp`. Kalshi `/events` or `series` may provide categories. Skip multivariate (`mve_*`) combo markets.

## Detector (`engine/detector.js`)
```js
export class Detector {
  constructor(opts = {})       // { historyWindowMs = 6h, minPoints = 3, ... }
  ingest(markets, now = Date.now()) // → Spike[] newly detected this tick
  history(marketId)            // → [{t, p}] for sparklines
  volatilityIndex()            // → { overall: number, byCategory: {sports: n, ...}, updatedAt }
  topMovers(n = 20)            // → [{market, change1h, change5m, vol}] sorted by |move|
}
```
Spike:
```js
{
  id: "uuid",                  // crypto.randomUUID()
  marketId, title, source, category, tags, url, outcome,
  from: 0.42, to: 0.61,        // probability before/after
  delta: 0.19,                 // to - from (signed)
  windowMs: 300000,            // window over which the move happened
  zScore: 4.2,                 // move relative to this market's own recent volatility
  severity: "info" | "notable" | "major",
  live: bool,
  detectedAt: ISO string
}
```
Detection = absolute move >= threshold within a short window (e.g. >= 5pts in <= 10 min)
AND/OR z-score of latest return vs rolling stdev of that market's returns. Cooldown per
market (e.g. 10 min) so one move doesn't fire repeatedly. Volatility index: 0–100 scale,
volume-weighted realized volatility of recent returns per category, smoothed (EMA) so
it's a stable gauge. Must work from a cold start (first tick produces no spikes).
Also use Polymarket's `oneHourPriceChange` if available as a seed so the board isn't empty
on cold start (expose it in topMovers; don't fire spikes from it).

## Persistence (`store.js`)
JSON files in `data/`. Subscription:
```js
{
  id, name,                       // "Lakers game shooters"
  persona: "photographer" | "trader" | "fan" | "journalist" | "general",
  match: { keywords: ["lakers"], categories: ["sports"], marketIds: [], sources: [] }, // empty = any
  minDelta: 0.05,                 // min |delta|
  minSeverity: "info" | "notable" | "major",
  liveOnly: false,
  webhook: { type: "generic" | "discord" | "slack" | "ntfy", url: "" } | null,
  createdAt
}
```
Recent alerts ring buffer (last 500 spikes) persisted too.

## HTTP API (agent B), all JSON, port `process.env.PORT || 4317`
- `GET  /api/health` → `{ok, lastPollAt, marketCount, sources: {polymarket: {ok, count, error}, kalshi: {...}}}`
- `GET  /api/markets?q=&category=&source=&limit=50` → `Market[]` (with `change1h` merged in if known)
- `GET  /api/markets/:id/history` → `{ marketId, points: [{t, p}] }` (id is URL-encoded, contains ':')
- `GET  /api/movers?limit=20` → topMovers
- `GET  /api/vix` → volatilityIndex() plus `history: [{t, overall}]` (last ~6h)
- `GET  /api/alerts?limit=100` → recent Spike[] newest first
- `GET  /api/subscriptions` / `POST /api/subscriptions` / `PUT /api/subscriptions/:id` / `DELETE /api/subscriptions/:id`
- `POST /api/subscriptions/:id/test` → sends a sample alert to its webhook, `{ok, error?}`
- `GET  /api/stream` → Server-Sent Events. Events: `spike` (data = Spike + `matchedSubscriptions: [ids]`),
  `vix` (data = volatilityIndex), `tick` (data = `{at, marketCount}`), plus `: ping` comment every 20s.
- `POST /api/demo/spike` → injects a synthetic spike through the full pipeline (for demos/testing). Marked `demo: true`.
- Static: everything else serves `public/` (index.html default).

Poll interval `process.env.POLL_MS || 20000`. Matching a spike to a subscription: keywords
(case-insensitive substring of title or tag), categories, sources, marketIds, minDelta, severity, liveOnly.
On match → webhook (fire-and-forget, errors logged) + SSE broadcast includes matched ids.

## Frontend (agent C)
Single page, dark "terminal/broadcast" aesthetic, responsive. Talks to the API above.
- Header: big Event Volatility Index gauge (0–100) + per-category mini gauges + sparkline of index history.
- Live alert feed (SSE): newest on top, severity colors, from→to with arrow, "LIVE" badge, link to market, flash/animate on arrival, optional sound.
- Browser notifications (Notification API) for spikes matching *the user's* subscriptions (or all if none) — ask permission via a button.
- Top movers table with sparklines (inline SVG, from `/api/markets/:id/history`).
- Market search + "Watch" button (creates a subscription with that marketId).
- Subscriptions panel: create/edit/delete, persona presets (Photographer: sports+entertainment, liveOnly, minDelta .05; Trader: all, minDelta .03; Fan; Journalist: politics+economics), webhook config + "Send test".
- "Simulate spike" button → `POST /api/demo/spike` so it's demoable when markets are quiet.
- Connection status indicator; reconnects SSE automatically.

---

# v2: Shot List & Insights (Oddshot is a recommender, not just a tracker)

Oddshot reads market *fluctuations* to recommend **what to watch next** ("shots") and to explain
what the crowd is thinking ("insights"). Reactive spike alerts remain, but the hero of the
product is now the forward-looking **Shot List**.

## Market additions
- `startTime: ISO|null`: scheduled start of the underlying event (Polymarket `gameStartTime` /
  `eventStartTime` / events[0].startTime; Kalshi: best available, else null).
- `eventKey: string|null`: groups sibling markets of the same event (Polymarket `events[0].slug`,
  Kalshi `event_ticker`). Used for Stories.

## Moment Forecaster (`server/ml/forecaster.js`, browser-compatible like scorer.js)
```js
loadForecaster(path?) → model|null          // Node: reads forecaster.json; browser: setForecaster(obj)
setForecaster(obj)
forecastMove(market, history, now = Date.now()) → {
  pMove30: 0..1,          // P(|Δp| ≥ 0.05 at some point in the next 30 min)
  expectedMovePts: number,// expected max |Δp| over next 30 min, in pts
  drivers: [{feature, impact, value}],   // top 3
  model: 'xgboost-forecast@<date>' | 'heuristic',
  historyMinutes: number
} | null
```
If the trained model is missing or history is < 30 min, return a calibrated **heuristic** (recent realized
vol, distance from 50%, live flag, time to start/end) with `model: 'heuristic'`. Never throws.

## Shot
```js
{
  id, marketId, market,                       // full Market (with change1h)
  kind: 'tension' | 'turning-point' | 'decisive' | 'closing' | 'upcoming' | 'momentum',
  headline: "Gea vs Fokina is on a knife-edge",        // plain English, ≤ 70 chars
  why: "50/50 with volatility rising 3× in the last 15 min",
  forecast: { pMove30, expectedMovePts, model },
  dramaScore: 0..100,                         // ranking score (forecast × uncertainty × liveness × interest)
  window: { startsAt: ISO, endsAt: ISO|null },// when to be there / watching
  tips: { photographer, trader, fan, journalist, general },   // one-line, persona-specific action
  rank: 1..N
}
```
Kinds:
- **tension**: near 50/50, rising volatility.
- **turning-point**: just crossed 50%, or the lead is changing.
- **decisive**: probability ≥ 0.85 and climbing ("celebration shot incoming").
- **closing**: resolves within 1h.
- **upcoming**: starts within 3h and is pre-game balanced.
- **momentum**: sustained one-way drift.

## Insight (narrative card, emitted when detected; deduped per market+type for 30 min)
```js
{ id, type: 'lead-change'|'upset-brewing'|'lock-in'|'calm-before-storm'|'belief-shift'|'story'|'divergence',
  title, body,                     // plain English
  marketIds: [], category, severity: 'info'|'notable'|'major', createdAt, data: {} }
```

## Story (co-movement cluster)
```js
{ id, title, summary, eventKey|null, category, direction: 'up'|'down'|'mixed',
  markets: [{id, title, from, to, delta}], strength: 0..1, startedAt, updatedAt }
```
Formed when ≥ 2 markets sharing an `eventKey` (or strongly overlapping tags/keywords in the same category)
move ≥ 3 pts within the same 15-min window.

## Briefing
`{ generatedAt, headline, bullets: [string], biggestShifts: [{marketId, title, from, to, delta}] }`.
A plain-English digest of the biggest belief changes over the last 24h (use change1h/ history/ spikes).

## API additions
- `GET /api/shots?persona=&category=&limit=20` → Shot[] ranked
- `GET /api/insights?limit=50` → Insight[] newest first
- `GET /api/stories` → Story[] active (updated in last 2h), strongest first
- `GET /api/briefing` → Briefing
- `GET /api/markets/:id/forecast` → forecast object
- SSE: `insight` (Insight), `shots` (top 20 Shot[] after each tick)

On startup the server **backfills** ~6h of 1-min history for the top ~80 Polymarket markets
(CLOB prices-history, concurrency ≤ 4) via `detector.seedHistory(marketId, points)` so shots,
forecasts and pReal work immediately rather than after an hour of polling.
`public/standalone.js` (GitHub Pages browser mode) must support all new routes, using the same
`server/insights/*` modules (keep them browser-compatible: no node: imports).

---

# v3: Volatility-spike alerts, live context, role-specific & agentic recommendations

## Roles
`role` = persona: `photographer | trader | fan | journalist | general`. The UI has a one-tap role switcher
(always visible); every alert, shot and recommendation is worded for the active role.

## Volatility spike (new Spike `kind`)
Spike gains `kind: 'price' | 'volatility'` (default 'price'). A **volatility spike** fires when a market's
short-window realized volatility (e.g. last 5 min) jumps ≥ 3× its own 1h–6h baseline with enough
points, even if the price hasn't committed to a direction yet ("this market just started thrashing").
Fields: `volRatio`, `volShort`, `volBase` added; `from/to/delta` still describe the net move.

## Live context (`server/context/`, pure ESM, fetch injectable, no node: imports)
```js
getLiveContext(market) → Promise<null | {
  kind: 'game' | 'asset',
  // game (ESPN public scoreboard JSON, site.api.espn.com/apis/site/v2/sports/{sport}/{league}/scoreboard):
  league, status: 'pre'|'in'|'post', clock, period, score: {home, away, homeTeam, awayTeam},
  situation: "1st & Goal at KC 4" | "Runners on 2nd & 3rd, 1 out" | "Power play, BOS" | null,
  imminent: { type: 'score'|'goal'|'touchdown'|'run'|'break-point'|'shot'|null, team, confidence: 0..1, text },
  lastPlay: string|null, source: 'espn', fetchedAt,
  // asset (crypto spot, Coinbase public API api.coinbase.com/v2/prices/{SYM}-USD/spot or exchange ticker):
  symbol, price, change5m, change1h, source: 'coinbase', fetchedAt
}>
```
Matches markets to games by team names/abbreviations in the market title (conservative). Cache per
league scoreboard ~15 s. Never throws.

## Recommendation (`server/agent/`)
```js
recommend(spikeOrShot, { market, role, history, context, forecast, related }) → Promise<{
  role, headline,          // ≤ 80 chars, concrete: "Chiefs 1st & goal at the 4 — get the end-zone shot"
  action,                  // one imperative line for this role
  confidence: 'low'|'medium'|'high',
  reasoning: [string],     // 1–3 short bullets citing the numbers / game situation
  disclaimer?: string,     // trader role: "Signal, not financial advice."
  source: 'claude' | 'rules', model?: 'claude-opus-5-5'
}>
```
- **rules** (`server/agent/rules.js`, browser-safe): deterministic per-role templates using context + numbers. Always available.
- **claude** (`server/agent/claude.js`, Node only, `@anthropic-ai/sdk`): used when an Anthropic credential is
  available and `OD_AGENT=claude` (default on if credentials exist). Agentic tool loop with tools
  `get_market_history`, `get_live_context`, `get_related_markets`, `get_forecast`; model `claude-opus-5-5`,
  low effort, short output, server-side refusal fallback. Only for notable+ spikes/top shots, cached per
  market+role 10 min, global budget (e.g. ≤ 60 calls/hour), timeout ~20 s → falls back to rules.

## API / SSE additions
- Spikes, insights and shots carry `context` (when matched) and `recommendations: {[role]: Recommendation}`
  (rules for all roles immediately; the claude version replaces the subscriber/active role's entry when ready,
  pushed via SSE `recommendation` event `{targetId, role, recommendation}`).
- `GET /api/markets/:id/context`, `GET /api/markets/:id/recommendation?role=` (may trigger Claude).
- Notifications/webhooks use the subscription's persona to pick the recommendation text, e.g. photographer:
  "📸 Chiefs 1st & goal at the 4 — touchdown likely, get the end-zone shot", trader: "📈 BTC >$80k odds
  +15 pts in 10 min, spot +1.2% — bullish momentum; consider reviewing (not financial advice)".
