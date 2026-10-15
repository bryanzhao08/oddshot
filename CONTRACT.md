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

## HTTP API (agent B), all JSON, port `process.env.PORT || 8787`
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
