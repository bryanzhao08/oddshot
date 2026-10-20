# Tipoff for iPhone

Push notifications that tell you what to keep an eye on. Pick what you're up to, and Tipoff
watches live Polymarket odds on your phone and buzzes you when something is about to happen
(👀 heads-up) or just happened (⚡). No server, no account, no API keys.

<img src="screenshots/onboarding.png" width="240"> <img src="screenshots/home.png" width="240"> <img src="screenshots/picker.png" width="240">

| Mode | For | Alerts about |
| --- | --- | --- |
| 🏟️ Watching sports | couch or stadium | live games heating up |
| 🍻 Out & about | bar, party, bathroom line | only live games about to swing |
| 📈 Markets & crypto | traders | crypto, Fed, economy |
| 🗞️ News junkie | politics, tech, culture | something brewing before the headline |
| 📸 Shooting or covering | photographers, streamers, journalists | when to be ready |
| 🌐 A bit of everything | anyone | only the biggest moments |

## What the alerts say

Every match gets a plain-words line about what's going on, from ESPN's live scoreboard (no key needed),
then X posts if connected, then the odds themselves:

| Sport | Examples |
| --- | --- |
| 🎾 Tennis | Tiebreak in set 2 · Ann Li is a game from winning the set / match · Deciding set, all square at 4-4 |
| 🏈 Football | In the red zone. Touchdown chance · Final two minutes, one-score game |
| 🏀 Basketball | At the free-throw line · Clutch time: Lakers up 2, 1:12 left · Overtime |
| ⚾ Baseball | Runners in scoring position, 1 out · 9th inning, one-run game |
| 🏒 Hockey | Power play. Goal chance · Overtime. Next goal wins |
| ⚽ Soccer | Corner kick · Penalty! · Level with 6' left |
| Any market | Lead change: Ann Li now favored · Ann Li surging (42% → 60% in 12 min) · Neck and neck |

Tiebreaks, match point, overtime and other endings are marked **Must-see** and get their own alert.
Jumps read like "Ann Li jumped from 42% to 60% in 3 min", and the big number on each card is how far the
odds could jump in the next 30 minutes.

## Follow your matches

Tap ☆ on any match, or the ☆ button at the top to search everything that's live. Followed matches sit
at the top, get alerts first (with a lower bar), and keep updating even if they drop out of the top markets.
Settings has **Only matches I follow** if you want nothing else.

## Live posts from X (optional)

Paste an X API bearer token (developer.x.com; reading posts needs a paid X API plan) in Settings.
Tipoff then shows recent posts about your live followed match (or the top pick), and sends a heads-up
when posting about it suddenly jumps (2.5× the normal rate). It also picks up phrases like "match point", "tiebreak", "overtime" or "buzzer beater" and marks those matches Must-see. The token stays in the iPhone Keychain and
is only sent to api.x.com.

## Run it on your iPhone

1. Plug in your iPhone (first time: unlock it and tap **Trust**; turn on **Settings → Privacy & Security → Developer Mode**).
2. Open `ios/Tipoff.xcodeproj` in Xcode.
3. Pick your iPhone at the top of the window and press **Run** (⌘R).
4. First launch only, on the phone: **Settings → General → VPN & Device Management →** trust your developer certificate.

If your iPhone runs a newer iOS than your Xcode supports (Run fails with "developer disk image could not be mounted"),
install from the command line instead:

```sh
xcodebuild -project ios/Tipoff.xcodeproj -scheme Tipoff -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath ios/build -allowProvisioningUpdates build
xcrun devicectl list devices      # find your phone's identifier
xcrun devicectl device install app --device <id> ios/build/Build/Products/Release-iphoneos/Tipoff.app
```

It's set to sign with team `38LHN9PGZP`. If that isn't yours, choose your team under
**Tipoff target → Signing & Capabilities** (a free Apple ID works). If the bundle ID is taken, change it there too.

## Look

iOS 26 Liquid Glass panels float over a slow gradient that warms from dusk blue to ember as the
biggest expected swing grows. On iOS 17–25 the glass falls back to blur material.

## How it works

- Every 20 s it pulls the top 300 Polymarket markets (plus anything you follow) and keeps 6 h of price history (backfilled on launch).
- `Engine/Forecaster.swift` runs the same XGBoost model as the web app (`server/ml/forecaster.json`,
  bundled at build time) to estimate each market's swing over the next 30 minutes.
- **⚡ It's happening:** a 10-minute move bigger than that market normally makes.
- **👀 Heads-up:** the chance of a big swing jumped compared with 15 minutes ago.
- At most one alert per game every 20 minutes and one alert overall every 3 minutes.

**When the app is closed:** iOS only lets apps check in now and then (about every 15 minutes at best),
so alerts are instant only while Tipoff is open. Instant alerts with the app closed would need
Apple's push service (paid developer account) plus a server.

## Files

```
Tipoff/App/      TipoffApp (lifecycle, background refresh), Notifier (local notifications)
Tipoff/Engine/   Market (Polymarket client), Mode (who you are + alert wording), Forecaster, GameContext (ESPN live situations), XFeed, Watcher (the loop)
Tipoff/Views/    Onboarding, Home (incl. Following + match picker), Settings, Theme (Liquid Glass + heat sky)
TipoffUITests/   first-run walkthrough with screenshots
project.yml       xcodegen spec: run `xcodegen generate` after adding files
```
