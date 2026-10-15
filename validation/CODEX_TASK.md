# Codex validation task for Oddshot

You are validating **Oddshot** (this repo). It watches Polymarket and Kalshi for sudden
probability spikes and alerts people so they don't miss real-world events.
- Read `README.md`, `CONTRACT.md` and `ml/REPORT.md` first.
- The server is already running at http://localhost:8787 (API in CONTRACT.md).
- Do NOT modify anything outside `validation/`. Don't trade, don't use any keys, and
  only call public read-only APIs.

**Use as many parallel subagents as you can (multi-agent). Spawn one per workstream
below, and split the big ones further (e.g. one subagent per sport or per event).**

## Workstreams

1. **Past events, sports.** Find 10+ resolved Polymarket/Kalshi sports markets from the
   last ~60 days that had a clear in-game turning point: a goal, touchdown, upset, break
   of serve or injury. Pull their 1-minute price history and timestamp the real-world
   moment from news, game logs or play-by-play.
   - Run Oddshot's detector logic (`server/engine/detector.js`, replayed via a small
     Node script in `validation/`) and the ML scorer (`server/ml/scorer.js`) over the
     history.
   - Record per event: did Oddshot fire, lead or lag vs the real-world moment (minutes),
     severity, and pReal.
2. **Past events, politics/economics/other.** The same, for 10+ resolved non-sports
   markets with a known news moment: Fed decision, CPI print, election call, court
   ruling, celebrity/tech announcement.
3. **False positives.** Sample spikes Oddshot would have fired on with no identifiable
   news. Estimate the precision of the plain rule versus filtering by ML `pReal` ≥ the
   `likely` threshold.
4. **Current events (live).**
   - Poll `/api/alerts`, `/api/movers` and `/api/vix` from the running server for ~15
     minutes.
   - For each real (non-demo) spike, try to find what happened in the world (search
     news / live scores) and record whether it matches.
   - Check `/api/health`, and spot-check 10 markets: the `probability` should match the
     venue's public API within 1 point.
5. **API and app checks.** Exercise every endpoint in CONTRACT.md: create, update, test
   and delete a subscription, `POST /api/demo/spike`, and the SSE stream. Report any
   bugs with repro steps. Do not leave test subscriptions behind.

## Output

- `validation/REPORT.md`:
  - executive summary with headline numbers (detection rate on known events, median
    lead/lag, precision with and without ML, live-data accuracy)
  - per-event table with sources/links
  - bugs found, ranked by severity
  - concrete recommendations to tune the detector thresholds and features
- `validation/data/*.json`: raw collected data.
- `validation/scripts/*`: the replay scripts you used.

Be honest. If something didn't work or Oddshot missed an event, say so.
