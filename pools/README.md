# Tipoff Moment Pools

Auto-timed live prediction pools for streamers and Discord communities. The in-game models notice a
moment coming, the pool opens just before it ("Packers drive: touchdown, field goal, or no points?"),
chat votes for a short window, and the pool settles itself from what actually happens. Points go to a
leaderboard. Play-money only.

```sh
node pools/server.js --replay nfl --bots 10      # demo: replays Cardinals 38 at Packers 42, with demo voters
node pools/server.js --replay soccer             # Man United 2-1 Chelsea
node pools/server.js --live nfl,nba,epl,ucl      # real live games from ESPN
```

- **Stream overlay:** http://localhost:4320/overlay. Add it as an OBS browser source at 1280×760, and add
  `?transparent` for no background.
- **Phone voting:** http://localhost:4320/vote
- **Twitch chat:** `--twitch <channel>`. Viewers type `!1`, `!2` or `!3`. Reading chat needs no token. To have the bot
  post pools and results, set `TWITCH_OAUTH=oauth:...` and `TWITCH_BOT_USER=<name>`.
- **Discord:** `--discord <channelId>` with `DISCORD_BOT_TOKEN`. The bot posts each pool with 1️⃣ 2️⃣ 3️⃣ reactions,
  counts reactions when voting locks, and replies with the result. It uses the REST API only, so there's no gateway and no
  dependencies. It needs the Send Messages, Add Reactions and Read Message History permissions.
- **Other options:** `--window 45` sets the vote window in seconds, `--speed 4` sets the replay rate in snapshots per second, and `--port 4320` sets the port.
  Replays pause while a pool is open so people have time to vote.

## Pools

| Sport | Opens when | Settles |
|---|---|---|
| NFL / CFB | The drive model gives ≥ 42% touchdown chance inside the opponent's 40. Without the model: at the 30. | Touchdown (+6), field goal (+3), or no points (turnover, punt, defensive score) |
| Soccer | The goal model gives a team ≥ 22% chance of scoring in 10 min (usual rate 15%). Without the model: 3+ shots or corners in 5 min. | Which team scores first within 10 match minutes, or no goal |
| NBA / WNBA | The lead-change model is ≥ 50%. Without the model: within 3 points in the 4th quarter. | Whether the lead changes or the game is tied within 3 game minutes |

Scoring: a correct call is worth 100 points × (1 + the share of voters who got it wrong). A streak of 3 or more adds +50.

## Files

| File | What it does |
|---|---|
| `engine.js` | Pool lifecycle (open → vote → lock → settle) and the leaderboard. Adapters call `vote()` and listen for `open`, `vote`, `lock`, `settle` and `void`. |
| `triggers.js` | When each pool opens and how it settles |
| `feeds.js` | Live ESPN snapshots, and replays of finished games from ESPN summaries |
| `models.js` | The ml/sports XGBoost models in JavaScript. Exact parity with Python and Swift on 120 fixtures. |
| `adapters/` | Twitch chat (`twitch.js`) and Discord (`discord.js`) |
| `overlay/` | Stream overlay and phone voting page (`index.html`, `vote.html`) |
| `server.js` | HTTP, a server-sent events stream (`/api/stream`), `/api/state` and `POST /api/vote` |

Tests: `npm test` (or `node --test pools/*.test.js`) replays NFL, soccer and NBA games and checks that every pool settles to what really happened.
