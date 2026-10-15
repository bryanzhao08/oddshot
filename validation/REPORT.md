# Oddshot validation report

**Run date:** 2026-10-15 (UTC)  
**Scope:** public read-only Polymarket/Kalshi data and the local Oddshot server at `localhost:8787`. No trades or credentials were used. Raw captures and reproducible scripts are in [`data/`](data/) and [`scripts/`](scripts/).

## Executive summary

- **Historical known-event replay:** Oddshot fired within 90 minutes of the timestamped turning point for **22/27 events (81%)**: **17/17 sports** and **5/10 non-sports**. The median offset among those 22 detections was **+0.35 minutes** (positive means after the event; negative means before it). Five events had no qualifying spike in that window. This is a deliberately selected event set, not a representative estimate of production recall.
- **ML score:** the median `pReal` for those 22 event-associated spikes was **0.734**; all 22 were at or above the model’s `likely` cutoff of **0.593**. Six of those scores had less than 60 minutes of pre-detection history, so treat them as weak evidence. The threshold retained every selected known-event detection; this set cannot estimate alert reduction.
- **False-positive sample:** the manual, strict “time-plausible public catalyst found” rate was **4/24 (16.7%)** without a filter and **2/12 (16.7%)** among sampled spikes with `pReal ≥ 0.593`. The tiny, sports-heavy sample and news-search definition are not the model’s training label. The held-out ML report instead measures 30-minute price retention: 63.3% for the plain rule and 65% above the `likely` threshold, with about 10.1% fewer alerts.
- **Live feed:** over **15 minutes**, 20 snapshots were taken at 45-second intervals. Three new non-demo alert IDs appeared during that interval; **two were mixed/contextual** (a rain-delayed tennis fixture and a tennis match with a later first-set update that could not be time-aligned to the alert) and **one had no verified in-window catalyst** (an upcoming soccer fixture). The broader rolling buffer contained 22 unique non-demo alerts; individual assessments are in [`data/live_poll.json`](data/live_poll.json).
- **Live market accuracy:** **10/10** probability spot checks matched the corresponding venue’s public API within one percentage point; all ten matched exactly at capture precision. Health was OK in **18/20** poll checks. Both venues timed out in two checks; the final check recovered with 597 markets (297 Polymarket, 300 Kalshi).
- **API checks:** documented endpoints responded as expected. Subscription create/read/update/delete passed, a local mock webhook test succeeded, the no-webhook test returned the expected 400, demo injection and SSE delivery passed. No reproducible API bug was found. The required demo spike remains in the server’s rolling alert buffer because the API has no alert-delete route; the temporary subscriptions were deleted.

## Method

The replay script ingests the captured venue price points in timestamp order into a fresh instance of `server/engine/detector.js` for each market and scores each emitted spike with `server/ml/scorer.js` using history available at that detection time. For each known real-world moment, it reports the closest detector spike within **±90 minutes**. This wide matching window is intentional for comparison but can associate a nearby unrelated movement; inspect the listed event and history links before treating an offset as causal. Positive offsets mean the detector lagged the reported moment.

Polymarket histories are public CLOB price samples requested at `fidelity=1`; they are not guaranteed complete one-minute candles or executable quotes. Kalshi series use one-minute candles and the collected YES quote midpoint/last price. Several sports turning points are mapped from game-clock/period-clock descriptions to approximate UTC. News publication times are explicitly marked as proxies where no separate decision timestamp was available. The short-window economics/tech captures also leave several classifier scores below the recommended 60-minute history minimum.

## Historical event replay

| Dataset | Event / market | Detector offset | Severity | `pReal` | Moment source · market |
|---|---|---:|---|---:|---|
| non-sports election | Will Ed Markey be the Democratic nominee for Senate in Massachusetts? | miss | — | — | [AP](https://apnews.com/article/massachusetts-senate-primary-election-markey-moulton-7968135279320c758b0fd4750d864db9) · [market](https://polymarket.com/event/massachusetts-democratic-senate-primary-winner?marketSlug=will-ed-markey-be-the-democratic-nominee-for-senate-in-massachusetts) |
| non-sports election | Will Chris Pappas be the Democratic nominee for Senate in New Hampshire? | miss | — | — | [AP](https://apnews.com/article/133cf52dd8c065515ebca1675cf51682) · [market](https://polymarket.com/event/new-hampshire-democratic-senate-primary-winner?marketSlug=will-chris-pappas-be-the-democratic-nominee-for-senate-in-new-hampshire) |
| non-sports Fed/CPI | Will the Fed increase interest rates by 25 bps after the September 2026 meeting? | +0.2 min | notable | 77.1% | [Federal Reserve](https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm) · [market](https://polymarket.com/event/fed-decision-in-september-762) |
| non-sports Fed/CPI | Will monthly inflation increase by 0.6% in September? | +0.4 min | notable | 68.6% | [BLS](https://www.bls.gov/news.release/archives/cpi_10142026.htm) · [market](https://polymarket.com/event/september-inflation-us-monthly?marketSlug=will-monthly-inflation-increase-by-0pt6-in-september-2026&outcomeIndex=1) |
| non-sports tech | Will OpenAI’s Astra model be released on September 4, 2026? | +29.3 min | info | 65.9% | [The New Stack](https://thenewstack.io/gpt6-astra-developer-access-delayed/) · [market](https://polymarket.com/event/openais-astra-released-onptptpt-20260901080122046) |
| non-sports tech | Will the next Google Gemini Flash model be released on September 2, 2026? | miss | — | — | [Google](https://blog.google/innovation-and-ai/models-and-research/gemini-models/3-8-flash-and-3-8-flash-cyber/) · [market](https://polymarket.com/event/next-gemini-flash-model-3pt8-released-onptptpt-20260831193056503) |
| non-sports tech | Apple announces foldable iPhone at “Surprise and Shine” event? | +2.2 min | major | 81.2% | [MacRumors](https://www.macrumors.com/2026/09/09/apple-announces-foldable-iphone-duo/) · [market](https://polymarket.com/event/apple-announces-foldable-iphone-at-surprise-and-shine-event) |
| non-sports tech | Will NVIDIA Q2 data-center revenue be above $85B? | +2.2 min | major | 81.3% | [NVIDIA results](https://nvidianews.nvidia.com/news/nvidia-announces-financial-results-for-second-quarter-fiscal-2027) · [market](https://polymarket.com/event/will-nvidia-nvda-q2-data-center-revenue-be-above-20260803225408174) |
| non-sports other | Will Kuala Lumpur’s highest temperature be 33°C on September 30? | miss | — | — | [NOAA station data](https://www.weather.gov/wrh/timeseries?site=wmkk) · [market](https://polymarket.com/event/highest-temperature-in-kuala-lumpur-on-september-30-2026/highest-temperature-in-kuala-lumpur-on-september-30-2026-33c) |
| non-sports other | Will “Avengers: Endgame Encore” be #1 box office this weekend? | miss | — | — | [AP](https://apnews.com/article/5fedc5f84142d1a36fe28ae22f738c47) · [market](https://polymarket.com/event/1-box-office-this-weekend/will-avengers-endgame-encore-be-1-box-office-this-weekend) |
| sports | Broncos vs. Chiefs | +0.4 min | major | 73.5% | [PFR game log](https://www.pro-football-reference.com/boxscores/202609140kan.htm) · [market](https://polymarket.com/event/nfl-den-kc-2026-09-15) |
| sports | Panthers vs. Browns | −3.7 min | major | 74.4% | [CBS recap](https://www.cbssports.com/nfl/gametracker/recap/NFL_20260927_CAR@CLE/) · [market](https://polymarket.com/event/nfl-car-cle-2026-09-27) |
| sports | Saitama Seibu Lions wins | +2 min | notable | 67.8% | [Pacific League](https://pacificleague.com/news/amp/86164) · [market](https://kalshi.com/markets/kxnpbgame/KXNPBGAME-26SEP110500SAIORI-SAI) |
| sports | Milwaukee Bucks vs Oklahoma City Thunder | +0.6 min | major | 84.7% | [ESPN play-by-play](https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=401908620) · [market](https://kalshi.com/markets/kxnbagame/nba-game/kxnbagame-26oct07milokc) |
| sports | Minnesota Timberwolves vs Miami Heat | −4.4 min | major | 74.0% | [ESPN play-by-play](https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=401898397) · [market](https://kalshi.com/markets/kxnbagame/nba-game/kxnbagame-26oct10minmia) |
| sports | Indiana Pacers vs Oklahoma City Thunder | −3.2 min | major | 76.5% | [ESPN play-by-play](https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=401908621) · [market](https://kalshi.com/markets/kxnbagame/nba-game/kxnbagame-26oct13indokc) |
| sports | New England vs Seattle, Seattle wins | 0 min | major | 82.9% | [AP](https://apnews.com/article/patriots-seahawks-score-9f41059f1e5fa19f70eb94929b401d54) · [Kalshi market](https://external-api.kalshi.com/trade-api/v2/markets/KXNFLGAME-26SEP09NESEA-SEA) |
| sports | Green Bay vs Minnesota, Minnesota wins | +2 min | major | 70.0% | [Packers updates](https://www.packers.com/news/in-game-updates-week-1-vikings-2026) · [Kalshi market](https://external-api.kalshi.com/trade-api/v2/markets/KXNFLGAME-26SEP13GBMIN-MIN) |
| sports | New Orleans vs Detroit, Detroit wins | −7 min | major | 71.7% | [Lions recap](https://www.detroitlions.com/news/recap-lions-vs-saints-goff-stbrown-barnes) · [Kalshi market](https://external-api.kalshi.com/trade-api/v2/markets/KXNFLGAME-26SEP13NODET-DET) |
| sports | Predators vs Canadiens | +0.4 min | major | 81.0% | [NHL play-by-play](https://api-web.nhle.com/v1/gamecenter/2026020058/play-by-play) · [market](https://polymarket.com/event/nhl-nsh-mon-2026-10-08) |
| sports | Predators vs Maple Leafs | +2.3 min | major | 71.4% | [NHL play-by-play](https://api-web.nhle.com/v1/gamecenter/2026020044/play-by-play) · [market](https://polymarket.com/event/nhl-nsh-tor-2026-10-06) |
| sports | Chelsea FC vs Hull City AFC, draw | +0.2 min | major | 71.0% | [Chelsea report](https://www.chelseafc.com/en/news/article/match-report-chelsea-2-2-hull) · [market](https://polymarket.com/event/epl-che-hul-2026-09-12) |
| sports | Brighton vs Arsenal | +0.3 min | major | 73.3% | [Brighton report](https://www.brightonandhovealbion.com/media-article/mft-match-report-pl-bhaars) · [market](https://polymarket.com/event/epl-bri-ars-2026-09-19) |
| sports | Liverpool vs Manchester City | +0.3 min | major | 69.8% | [Manchester City report](https://www.mancity.com/news/mens/liverpool-v-city-premier-league-match-report-october-2026-63927325) · [market](https://polymarket.com/event/epl-liv-mac-2026-10-11) |
| sports | Tatiana Prozorova vs Alexandra Eala | −4.6 min | major | 70.1% | [WTA report](https://www.wtatennis.com/news/4581250/prozorova-stuns-eala-in-marathon-singapore-comeback-for-first-top-20-win) · [market](https://polymarket.com/event/wta-prozoro-eala-2026-09-22) |
| sports | Hanyu Guo vs Sorana Cirstea | +0.3 min | major | 75.6% | [WTA report](https://www.wtatennis.com/news/4591364/hanyu-guo-upset-carries-deeper-meaning-liudmila-samsonova-yulia-putintseva-win-thrillers-in-wuhan) · [market](https://polymarket.com/event/wta-guo-cirstea-2026-10-11) |
| sports | Aryna Sabalenka vs Ann Li | +0.4 min | major | 72.2% | [WTA score page](https://www.wtatennis.com/tournaments/1075/wuhan/2026/scores/LS016) · [market](https://polymarket.com/event/wta-sabalen-annli-2026-10-14) |

The five misses were the two election markets, Google Gemini, the daily weather market, and the box-office market. In both election markets, prices were already near 1.00 before the call/report timestamp, so the market had little remaining probability to move. The weather and box-office outcomes also resolved from a daily observation/result window rather than a sharply timed in-game moment.

## False-positive audit

The sample contains 24 one-per-event-group candidate spikes from `ml/data/spikes.parquet`, split evenly into 12 above and 12 below `pReal=0.593` (seeded, deterministic sample). A spike counted as “precision” only when a targeted search found a specific public, time-plausible catalyst; absence of a result is not proof of no cause.

| Sample | Identified catalysts | News-found rate |
|---|---:|---:|
| Plain candidate rule | 4/24 | 16.7% |
| `pReal ≥ 0.593` | 2/12 | 16.7% |
| `pReal < 0.593` | 2/12 | 16.7% |

This sample did not show a news-discovery precision lift from the cutoff. It is small, sports-heavy, and measures public-news discoverability rather than whether a move holds. The held-out result in [`ml/REPORT.md`](../ml/REPORT.md) uses a different label: `y30` is positive when at least half the move remains after 30 minutes. That benchmark reports 63.3% real for the plain threshold rule and 65% for `pReal ≥ 0.593`, with about a 10.1% alert reduction.

## Current events and service health

The 15-minute poll ran from **07:24:26 to 07:39:26 UTC**, collecting 20 snapshots of `/api/alerts`, `/api/movers`, `/api/vix`, and `/api/health`. The alert buffer showed 22 unique non-demo alert IDs; 19 were already present at the first snapshot and **3 new IDs arrived during the poll**. The per-alert classifications and source URLs are in [`data/live_poll.json`](data/live_poll.json).

- **Confirmed match catalysts in the alert buffer:** Arthur Gea retired against Alejandro Davidovich Fokina after treatment for a psoas injury, trailing 1–4; [El País reported the retirement at 07:09 UTC](https://elpais.com/deportes/tenis/2026-10-15/davidovich-alcanza-las-semifinales-del-masters-de-shanghai-sin-apenas-jugar.html). This is a strong match for the Shanghai match-winner and handicap alerts.
- **Mixed/contextual matches:** Wuhan’s Jovic–Chwalinska and Pohankova–Sakkari matches were delayed amid heavy rain and court changes ([WP SportoweFakty](https://sportowefakty.wp.pl/tenis/1279284/deszcz-w-wuhan-jest-decyzja-ws-meczu-chwalinskiej); [WTA status](https://www.wtatennis.com/tournaments/1075/wuhan/2026/scores/LS022)). Those sources explain schedule uncertainty, not a verified score change. Bitcoin was down roughly 3.6% to $80,764 in the Asian session ([The Block](https://www.theblock.co/news/markets/2026-10-15-bitcoin-drops-asian-equities-tumble-418623)), a plausible common driver for the crypto-market alerts. The Tesla–SpaceX alert coincided with a Barclays analyst note that a merger announcement was possible before the December 6 AGM ([Bloomberg Law](https://news.bloomberglaw.com/business-and-practice/tesla-spacex-deal-news-possible-this-year-barclays-analyst-says)); this was speculation, not company confirmation.
- **New alerts with weak/no precise match:** Jovic–Chwalinska’s new drop coincided with the rain/court-change context. Pavlovic–Bellucci was a real in-play fixture and a later [365Scores snapshot](https://www.365scores.com/en-us/tennis/team/mattia-bellucci-70926) showed Pavlovic had taken the first set, but the score update could not be aligned to the alert timestamp. The Gangwon FC win-market alert fired before the club’s match against Phnom Penh was scheduled to start at 10:00 UTC ([official Gangwon FC schedule](https://gangwon-fc.com/)). None of these three new alerts has a precise, timestamp-matched catalyst.
- **Health:** 18/20 checks were healthy. Both sources timed out at 07:30:47 and 07:32:52 UTC; one snapshot showed the count fall from 600 to 500. The final check recovered with Polymarket 297 and Kalshi 300. This was a short-lived collection/availability issue, not a confirmed persistent data corruption.
- **Spot checks:** the ten markets in [`data/spot_check.json`](data/spot_check.json) were fetched from their direct public venue APIs and compared with the server’s captured probability. All ten differences were 0.00 percentage points at the recorded precision.

## API and app checks

The script [`scripts/api_checks.mjs`](scripts/api_checks.mjs) exercised `/`, every documented GET endpoint, market history, subscription create/get/update/test/delete, `/api/demo/spike`, and `/api/stream`. The stream delivered initial `tick` and `vix` events and the injected `spike`. Subscription CRUD passed; the test endpoint returned 400 with `no webhook configured` when used without a webhook, as expected. [`scripts/local_webhook_check.mjs`](scripts/local_webhook_check.mjs) then tested the success path against a temporary `127.0.0.1` sink: POST test returned 200, the sink received the sample JSON, and the subscription was deleted. No external webhook was contacted.

`POST /api/demo/spike` returned 201 with `demo: true`. It remains in the server’s persisted recent-alert buffer because no alert-delete endpoint is defined. The subscriptions created by these checks were deleted; the server reported zero subscriptions at the end of both the API sweep and the 15-minute poll. A later read-only recheck at 07:40 UTC found two subscriptions created after those checks (`Notable moves · everything` and a Shanghai match subscription). Their owner/purpose could not be established, so they were left unchanged.

## Bugs and issues, ranked

1. **P2 — transient source timeouts reduce live coverage.** Both upstream feeds timed out in two of 20 health checks; the returned market count briefly dropped to 500, then recovered to 597. Reproduction: poll `GET /api/health` at 07:30:47 or 07:32:52 UTC in the captured run; details are in `data/live_poll.json`. Add retry/backoff or stale-last-good data retention and alert on sustained source degradation.
2. **P3 — current-feed alerts can be hard to interpret without event timing.** Some alerts corresponded to postponed matches or markets whose fixture had not started. This was not an API failure, and the exact `live` flag was false for identified future events, but the feed does not explain whether a move came from play, schedule change, or a stale market. Add a schedule-aware `live` signal and show source timestamp/market-data age.
3. **No reproducible API contract bug found.** The no-webhook 400 was expected; local webhook delivery, subscription cleanup, demo injection, and SSE all passed.

## Recommendations

1. **Keep `pReal` as a ranking hint, not a hard filter.** The held-out lift is modest and the manual sample found equal catalyst rates above and below 0.593. Keep the `likely` label, but avoid suppressing a spike solely from this score.
2. **Gate model labels on history sufficiency.** Six of 22 event-associated replay scores had under 60 minutes of history; live examples had only 2–15 minutes. Show `insufficient history` or a lower-confidence state below 60 minutes, and don’t interpret a cold-start `pReal` as calibrated.
3. **Run a controlled threshold sweep against unselected histories.** The turning-point replay is positively selected and cannot tune precision. Capture full price paths and news labels prospectively, then compare `minDelta=0.05` with 0.06/0.08 and `zMinDelta=0.02` with 0.03, stratified by sport and venue. Keep cooldown behavior fixed during that experiment.
4. **Improve live/event-state features.** Persist scheduled start times and postponement/status changes; distinguish in-play prices from pregame repricing, and mark stale or ended markets. This addresses rain-delay noise and helps prevent “live” interpretations of future props.
5. **Preserve last-good source snapshots through short timeouts.** Return current source health separately from the last usable market set, with the age of that snapshot visible to clients.

## Evidence files

- Historical raw event samples: `data/sports_*.json`, `data/non_sports_*.json` (duplicate Fed/CPI alternatives are retained in `data/non_sports_courts.json`).
- Replay detections and scores: [`data/replay_results.json`](data/replay_results.json); runner: [`scripts/replay.mjs`](scripts/replay.mjs).
- False-positive sample and weighting: [`data/false_positives.json`](data/false_positives.json).
- Live snapshots and per-alert source assessments: [`data/live_poll.json`](data/live_poll.json).
- Probability spot check: [`data/spot_check.json`](data/spot_check.json); API sweep: [`data/api_checks.json`](data/api_checks.json); local webhook test: [`data/local_webhook_check.json`](data/local_webhook_check.json).
