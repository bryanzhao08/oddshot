# Oddshot

**The odds move before the headlines do.**

Oddshot watches live prediction markets (Polymarket and Kalshi) and tells you the
moment something is happening, whatever you care about. When the crowd's
probability for an outcome jumps from 42% to 61% in four minutes, something just
happened: a go-ahead drive, a debate gaffe, a leak out of the Fed. Oddshot catches
that move and pings you, usually before the news alert, the box score or the
timeline catches up.

## Why

It started with photographers. A concert or sports shooter can't watch the game,
the crowd and their camera at once, and the shot that matters (the walk-off, the
upset, the encore surprise) happens in seconds. Prediction markets react to those
moments in real time, because thousands of people with money on the line are
watching. So: turn sudden market moves into a tap on the shoulder.

That turned out to be useful for far more than photographers. Traders want to know
when volatility hits. Journalists want the tip before the wire. Fans want to tune in
when the game gets interesting. Anyone who doesn't want to miss the moment can
point Oddshot at the topics they care about and get alerted on their phone, in
Discord or Slack, or in the browser.

## How it works

1. **Data sources.** Every `POLL_MS` (default 20s) the server pulls the top markets by
   24h volume from the public Polymarket (Gamma) and Kalshi APIs and normalizes them
   into one shape: title, tracked outcome, probability, volume, category, tags,
   link, and a best guess at whether the underlying event is live right now.
2. **Spike detection.** Each market's price history is kept for ~6h. A spike fires when
   a probability moves by a meaningful absolute amount within a short window, and/or
   when the latest move is large relative to that market's own recent volatility
   (z-score). Spikes are graded `info` / `notable` / `major`, and a per-market
   cooldown stops one move from firing repeatedly.
3. **Event Volatility Index.** A 0–100 gauge, overall and per category (sports,
   politics, crypto, economics, ...). It is the volume-weighted realized volatility
   of recent price changes, smoothed so it reads like a stable "VIX for events".
   A rising index means the world is getting interesting.
4. **Alerts.** Each spike is matched against your subscriptions (keywords, categories,
   sources, specific markets, minimum move, minimum severity, live events only).
   Matches are pushed to webhooks (ntfy, Discord, Slack, or generic JSON) and to every
   open browser over Server-Sent Events. The last 500 spikes are kept on disk.

No database and no npm dependencies: plain Node.js built-ins, JSON files in `data/`,
and a vanilla JS front end in `public/`.

## Quickstart

Requires Node.js 20+.

```sh
npm start
# open http://localhost:8787
```

The first poll gives the detector its baseline, so real spikes appear only after a
few ticks. Markets can be quiet; press **Simulate spike** in the UI (or
`curl -X POST localhost:8787/api/demo/spike`) to push a synthetic spike, built on a
real market, through the whole pipeline: matching, webhooks, live feed and history.

Run the tests:

```sh
node --test 'server/**/*.test.js'
```

## Configuration

| Variable   | Default   | Description                                    |
|------------|-----------|------------------------------------------------|
| `PORT`     | `8787`    | HTTP port                                      |
| `HOST`     | all       | Interface to bind (e.g. `127.0.0.1`)           |
| `POLL_MS`  | `20000`   | Market poll interval in milliseconds           |
| `DATA_DIR` | `./data`  | Where `subscriptions.json` and `alerts.json` live |

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
| GET    | `/api/stream` | Server-Sent Events: `spike`, `vix`, `tick`, plus a `: ping` comment every 20s |

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
  "id": "…", "marketId": "polymarket:123", "title": "Lakers vs Celtics", "outcome": "Lakers",
  "source": "polymarket", "category": "sports", "tags": ["nba"], "url": "https://polymarket.com/event/…",
  "from": 0.42, "to": 0.61, "delta": 0.19, "windowMs": 240000, "zScore": 4.2,
  "severity": "major", "live": true, "detectedAt": "2026-10-14T23:59:00.000Z",
  "matchedSubscriptions": ["…"]
}
```

## Webhooks

Alerts read like this:

> 🚨 Lakers vs Celtics: Lakers win 42% → 61% (+19 pts in 4m) — something just happened
> https://polymarket.com/event/…

Deliveries time out after 8 seconds. Failures are logged and never interrupt polling.
Use **Send test** in the UI (or `POST /api/subscriptions/:id/test`) to check a webhook.

### ntfy.sh (easiest: phone push in a minute)

1. Install the ntfy app (iOS/Android) and subscribe to a hard-to-guess topic, e.g.
   `oddshot-7f3k2q`.
2. Create a subscription with webhook `{"type": "ntfy", "url": "https://ntfy.sh/oddshot-7f3k2q"}`.

Oddshot sets ntfy's `Title`, `Priority` (major = urgent), `Tags`, and `Click`, so tapping the
notification opens the market.

```sh
curl -X POST localhost:8787/api/subscriptions -H 'content-type: application/json' -d '{
  "name": "Anything big", "persona": "general", "minSeverity": "major",
  "webhook": {"type": "ntfy", "url": "https://ntfy.sh/oddshot-7f3k2q"}
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
{ "type": "oddshot.spike", "text": "🚨 … \nhttps://…", "spike": { … }, "subscription": { "id": "…", "name": "…" } }
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
