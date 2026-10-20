# Tipoff

**The odds move before the headlines do.**

Tipoff watches live prediction markets (Polymarket and Kalshi) and tells you the
moment something is happening, whatever you care about. When the crowd's
probability for an outcome jumps from 42% to 61% in four minutes, something just
happened: a go-ahead drive, a debate gaffe, a leak out of the Fed. Tipoff catches
that move and pings you, usually before the news alert, the box score or the
timeline catches up.

**Live demo:** https://bryanzhao08.github.io/oddshot/. GitHub Pages can't run the
Node server, so the demo runs the same detector and ML model in your browser
(`public/standalone.js`). It covers Polymarket only, because Kalshi blocks browser
requests, and it keeps your alerts in browser storage. Run `npm start` for the full
version with Kalshi, server-side webhooks and persistent alerts. To point the
static page at a deployed server, add `?api=https://your-tipoff-server`.

## Why

It started with photographers. A concert or sports shooter can't watch the game,
the crowd and their camera at once, and the shot that matters (the walk-off, the
upset, the encore surprise) happens in seconds. Prediction markets react to those
moments in real time, because thousands of people with money on the line are
watching. So: turn sudden market moves into a tap on the shoulder.

That turned out to be useful for far more than photographers. Traders want to know
when volatility hits. Journalists want the tip before the wire. Fans want to tune in
when the game gets interesting. Anyone who doesn't want to miss the moment can
point Tipoff at the topics they care about and get alerted on their phone, in
Discord or Slack, or in the browser.

## How it works

1. **Data sources.** Every `POLL_MS` (default 20s) the server pulls the top markets by
   24h volume from the public Polymarket (Gamma) and Kalshi APIs and normalizes them
   into one shape: title, tracked outcome, probability, volume, category, tags,
   link, a best guess at whether the underlying event is live right now, its scheduled
   `startTime`, and an `eventKey` that groups sibling markets of the same event.
2. **Backfill.** Right after the first poll the server fetches about 6h of 1-minute
   price history for the top 80 Polymarket markets (CLOB `prices-history`) and the top 30
   Kalshi markets (candlesticks), 4 requests at a time, and seeds the detector with it. That
   way forecasts, shots and insights work within a minute of startup, not an hour later.
   Backfilled points are never used as the "before" side of a spike.
3. **Spike detection.** Each market's price history is kept for ~6h. A *price spike* fires
   when a probability moves a meaningful absolute amount within a short window, and/or when
   the latest move is large relative to that market's own recent volatility (z-score). A
   *volatility spike* (`kind: "volatility"`) fires when the last 5 minutes of realized
   volatility reach 3× or more of the market's own 1h–6h baseline, even if the price hasn't
   picked a direction yet. Spikes are graded `info` / `notable` / `major`, and a per-market
   cooldown stops one move from firing repeatedly.
4. **Moment forecast.** For every market, `server/ml/forecaster.js` estimates `pMove30`, the
   chance of a 5+ point swing in the next 30 minutes. It uses a trained XGBoost model when one
   is present and a calibrated heuristic otherwise (recent volatility, distance from 50%,
   live status, time to start/end).
5. **Shot List.** Each tick the recommender (`server/insights/shots.js`) reads every market's
   recent fluctuation pattern and classifies it: **tension** (near 50/50 and getting jumpier),
   **turning-point** (just crossed 50%), **decisive** (favorite at 85%+ and still climbing),
   **closing** (resolves within the hour), **upcoming** (starts within 3h, balanced line) or
   **momentum** (steady one-way drift). Markets that fit none of these, including dead 0.1%
   markets, don't make the list. The rest are ranked by a *drama score*: forecast × uncertainty
   (closeness to 50%) × liveness/imminence × interest (log volume). Every shot comes with a
   plain-English headline, the reason, a "be there" time window and a one-line tip for each
   persona (photographer, trader, fan, journalist, general).
6. **Insights and stories.** `server/insights/insights.js` writes narrative cards when it spots
   a **lead change** (crossing 50%), an **upset brewing** (a 65%+ favorite sliding 8+ pts in
   30 min), a **lock-in** (crossing 90% / 10%), the **calm before the storm** (a balanced,
   unusually quiet market that starts within 2h), a **belief shift** (15+ pts over ~6h), or a
   **divergence** (the same question priced 5+ pts apart on Polymarket and Kalshi; matching is
   deliberately conservative). Cards are deduped per market and type for at least 30 minutes.
   `stories.js` groups markets that repriced together within 15 minutes (same `eventKey`, the
   same matchup, or strongly overlapping keywords) into one story, and `briefing.js` writes a
   digest of the biggest belief changes of the last 24h.
7. **Live context and recommendations.** For sports and crypto markets the server attaches
   live context when the optional `server/context/` module is present (ESPN game state, crypto
   spot price). `server/agent/` then writes a recommendation for each role. Rules-based copy is
   always there; when Anthropic credentials are available, Claude upgrades notable alerts and
   the result is pushed over SSE as a `recommendation` event.
8. **Volatility Index.** A 0–100 gauge, overall and per category, computed as the volume-weighted
   realized volatility of recent price changes, smoothed so it reads like a stable "VIX for events".
9. **Alerts.** Each spike, and each notable+ insight, is matched against your subscriptions
   (keywords, categories, sources, specific markets, minimum move, minimum severity, live events
   only). Matches go out to webhooks (ntfy, Discord, Slack, or generic JSON) worded for the
   subscription's persona, and to every open browser over Server-Sent Events. The last 500
   spikes and 300 insights are kept on disk.

No database and no npm dependencies: plain Node.js built-ins, JSON files in `data/`,
and a vanilla JS front end in `public/`. The recommender modules (`server/insights/`,
`server/agent/rules.js`, the forecaster) are browser-safe, so the GitHub Pages demo runs the
same Shot List, insights, stories and briefing in your browser, backfilling the top 30
Polymarket markets on load.

## Quickstart

Requires Node.js 20+.

```sh
npm start
# open http://localhost:4317
```

The first poll gives the detector its baseline, so real spikes appear only after a
few ticks. Markets can be quiet; press **Simulate spike** in the UI (or
`curl -X POST localhost:4317/api/demo/spike`) to push a synthetic spike, built on a
real market, through the whole pipeline: matching, webhooks, live feed and history.

Run the tests:

```sh
node --test 'server/**/*.test.js'
```

## Deploying to GitHub Pages

`.github/workflows/pages.yml` runs on every push to `main`. It runs the tests, builds
`_site/` with `npm run build:pages`, and deploys it. The build puts the web app at the
site root and copies in the browser-safe server modules and ML models. It also checks
that every module the browser imports is included, and cache-busts the entry files.

- **One-time setup:** in the repo, go to Settings → Pages → Build and deployment and set
  Source to **GitHub Actions**.
- **Preview locally:** run `npm run preview:pages`, then open
  http://localhost:4318/?standalone.

## Configuration

| Variable   | Default   | Description                                    |
|------------|-----------|------------------------------------------------|
| `PORT`     | `4317`    | HTTP port                                      |
| `HOST`     | all       | Interface to bind (e.g. `127.0.0.1`)           |
| `POLL_MS`  | `20000`   | Market poll interval in milliseconds           |
| `DATA_DIR` | `./data`  | Where `subscriptions.json`, `alerts.json` and `insights.json` live |
| `BACKFILL` | on        | Set to `0` to skip the startup history backfill |
| `OD_AGENT` | auto      | `rules` forces rules-only recommendations; Claude is used when credentials exist |

## API

All endpoints return JSON and send permissive CORS headers. Market ids contain a colon
(`polymarket:123`, `kalshi:TICKER`), so URL-encode them in paths.

| Method | Path | Description |
|--------|------|-------------|
| GET    | `/api/health` | `{ok, lastPollAt, marketCount, sources: {polymarket: {ok, count, error}, kalshi: {...}}}` |
| GET    | `/api/markets?q=&category=&source=&limit=50` | Current markets by 24h volume, with `change1h` when known |
| GET    | `/api/markets/:id/history` | `{marketId, points: [{t, p}]}` for sparklines |
| GET    | `/api/movers?limit=20` | Biggest movers: `[{market, change1h, change5m, vol}]` |
| GET    | `/api/vix` | Volatility index `{overall, byCategory, updatedAt, history: [{t, overall}]}` (about 6h of history) |
| GET    | `/api/alerts?limit=100` | Recent spikes, newest first (max 500) |
| GET    | `/api/subscriptions` | List subscriptions |
| POST   | `/api/subscriptions` | Create a subscription (validated; 400 with `errors[]` if invalid) |
| GET    | `/api/subscriptions/:id` | Get one subscription |
| PUT    | `/api/subscriptions/:id` | Update a subscription (partial fields are merged) |
| DELETE | `/api/subscriptions/:id` | Delete a subscription |
| POST   | `/api/subscriptions/:id/test` | Send a sample alert to the subscription's webhook: `{ok, error?}` |
| POST   | `/api/demo/spike` | Inject a synthetic spike (`demo: true`). Optional body `{marketId}` |
| GET    | `/api/shots?persona=&category=&limit=20` | Shot List: ranked `Shot[]` (see below) |
| GET    | `/api/insights?limit=50&type=&severity=` | Insight cards, newest first (ring buffer of 300) |
| GET    | `/api/stories` | Active co-movement stories (updated in the last 2h), strongest first |
| GET    | `/api/briefing` | `{generatedAt, headline, bullets[], biggestShifts[]}`: digest of the last 24h |
| GET    | `/api/markets/:id/forecast` | `{marketId, pMove30, expectedMovePts, drivers, model, historyMinutes}` |
| GET    | `/api/markets/:id/context` | `{marketId, context}`: live game state / spot price, or `null` |
| GET    | `/api/markets/:id/recommendation?role=` | `{marketId, targetId, role, recommendation, context}` (may call Claude) |
| GET    | `/api/stream` | Server-Sent Events: `spike`, `insight`, `shots` (top 20 after each tick), `recommendation`, `vix`, `tick`, plus a `: ping` comment every 20s |

Anything outside `/api/` is served from `public/`.

### Subscription shape

```json
{
  "name": "Lakers game shooters",
  "persona": "photographer",
  "match": { "keywords": ["lakers"], "categories": ["sports"], "marketIds": [], "sources": [] },
  "minDelta": 0.05,
  "minSeverity": "notable",
  "liveOnly": true,
  "webhook": { "type": "ntfy", "url": "https://ntfy.sh/my-secret-topic" }
}
```

Empty lists mean "any". `keywords` are case-insensitive substrings of the market
title or tags. `minDelta` is the minimum absolute probability move (0.05 = 5 points).
`minSeverity` is one of `info` < `notable` < `major`. `persona` is one of
`photographer`, `trader`, `fan`, `journalist`, `general`.

### Spike shape (SSE `spike` event, `/api/alerts`)

```json
{
  "id": "…", "kind": "price", "marketId": "polymarket:123", "title": "Lakers vs Celtics", "outcome": "Lakers",
  "source": "polymarket", "category": "sports", "tags": ["nba"], "url": "https://polymarket.com/event/…",
  "from": 0.42, "to": 0.61, "delta": 0.19, "windowMs": 240000, "zScore": 4.2,
  "severity": "major", "live": true, "detectedAt": "2026-10-14T23:59:00.000Z",
  "matchedSubscriptions": ["…"],
  "context": null, "recommendations": { "photographer": { "headline": "…", "action": "…" }, "…": "…" }
}
```

Volatility spikes have `"kind": "volatility"` plus `volRatio` (short vs baseline), `volShort` and
`volBase` (per-√minute realized vol); `from`/`to`/`delta` still describe the net move.

### Shot shape (`/api/shots`, SSE `shots`)

```json
{
  "id": "polymarket:5691073:tension", "marketId": "polymarket:5691073", "market": { "…": "…" },
  "kind": "tension",
  "headline": "Rays vs Guardians is on a knife-edge",
  "why": "Rays barely ahead at 54%, swinging across a 10 pts range in 15 min",
  "forecast": { "pMove30": 0.72, "expectedMovePts": 6.1, "model": "xgboost-forecast@2026-10-15" },
  "dramaScore": 74.3,
  "window": { "startsAt": "…", "endsAt": "…" },
  "tips": { "photographer": "…", "trader": "…", "fan": "…", "journalist": "Draft both versions: …", "general": "…" },
  "rank": 1,
  "context": { "kind": "game", "…": "…" },
  "recommendations": { "photographer": { "headline": "…", "action": "…", "confidence": "high", "reasoning": [], "source": "rules" } }
}
```

`persona` re-weights the ranking (photographers and fans lean to live sports and
entertainment, journalists to politics and economics, traders to the highest forecast move).

### Insight shape (`/api/insights`, SSE `insight`)

```json
{ "id": "…", "type": "upset-brewing", "title": "Upset brewing in Ruzic vs Andreescu",
  "body": "Andreescu came in at 78% but has slid 18 pts to 61% in the last 30 min. Ruzic is gaining.",
  "marketIds": ["polymarket:…"], "category": "sports", "severity": "major", "createdAt": "…",
  "data": { "favorite": "Andreescu", "from": 0.78, "to": 0.61, "delta": -0.18, "live": true, "url": "…" } }
```

## Webhooks

Alerts read like this:

> 🚨 Lakers vs Celtics: Lakers win 42% → 61% (+19 pts in 4m) — something just happened
> https://polymarket.com/event/…

Deliveries time out after 8 seconds. Failures are logged and never interrupt polling.
Use **Send test** in the UI (or `POST /api/subscriptions/:id/test`) to check a webhook.

### ntfy.sh (easiest: phone push in a minute)

1. Install the ntfy app (iOS/Android) and subscribe to a hard-to-guess topic, e.g.
   `tipoff-7f3k2q`.
2. Create a subscription with webhook `{"type": "ntfy", "url": "https://ntfy.sh/tipoff-7f3k2q"}`.

Tipoff sets ntfy's `Title`, `Priority` (major = urgent), `Tags`, and `Click`, so tapping the
notification opens the market.

```sh
curl -X POST localhost:4317/api/subscriptions -H 'content-type: application/json' -d '{
  "name": "Anything big", "persona": "general", "minSeverity": "major",
  "webhook": {"type": "ntfy", "url": "https://ntfy.sh/tipoff-7f3k2q"}
}'
```

### Discord

Server Settings → Integrations → Webhooks → New Webhook → copy URL, then use
`{"type": "discord", "url": "https://discord.com/api/webhooks/…"}`. Alerts arrive as a
message plus a color-coded embed.

### Slack

Create an app with Incoming Webhooks enabled, add it to a channel, then use
`{"type": "slack", "url": "https://hooks.slack.com/services/…"}`.

### Generic JSON

Any other URL with `"type": "generic"` receives a POST like:

```json
{ "type": "tipoff.spike", "text": "🚨 … \nhttps://…", "spike": { … }, "subscription": { "id": "…", "name": "…" } }
```

Good for Zapier, n8n, Home Assistant, IFTTT, or your own code.

## Project layout

```
server/
  index.js        HTTP server, REST, SSE, static files, poll loop
  store.js        JSON persistence (atomic writes) for subscriptions + alert history
  match.js        subscription matching + validation
  notify.js       webhook delivery (generic, Discord, Slack, ntfy)
  sources/        Polymarket + Kalshi fetchers, normalized markets
  engine/         price history, spike detection, volatility index
public/           single-page dashboard (vanilla JS, no build step)
data/             runtime JSON (gitignored)
```

## Roadmap ideas

- More sources: Manifold, PredictIt, sportsbook odds, exchange order-book depth.
- Explain the move: attach the top news or social posts from the minutes around a spike.
- Smarter "live" detection from schedules (game start times, debate times, FOMC calendar).
- Quiet hours, digests, and per-subscription rate limits.
- Native push (Web Push / APNs) without a third-party relay.
- Event-specific personas: a venue mode for photographers that follows one game or show
  and escalates as the moment approaches.
- Backtesting: replay historical prices to tune thresholds per category.
- Multi-user accounts and shareable public alert channels.
