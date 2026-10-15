// Read-only collector for three resolved sports examples used in validation.
// Price histories come directly from Polymarket CLOB and Kalshi public APIs.
import { writeFile } from 'node:fs/promises';

const histories = [
  {
    key: 'chiefs_broncos',
    venue: 'polymarket',
    market: {
      id: 'polymarket:3335127',
      source: 'polymarket',
      title: 'Broncos vs. Chiefs',
      outcome: 'Broncos',
      probability: null,
      category: 'sports',
      tags: ['nfl', 'football'],
      url: 'https://polymarket.com/event/nfl-den-kc-2026-09-15',
    },
    moment: '2026-09-15T01:58:00Z',
    momentPrecision: 'approximate UTC; play-by-play clock is authoritative for the play, while UTC is aligned to the market reprice',
    momentDescription: 'Kenneth Walker III ran 60 yards for a Chiefs touchdown at 12:43 of the third quarter; the Broncos-win token repriced sharply down.',
    momentSource: 'https://www.pro-football-reference.com/boxscores/202609140kan.htm',
    otherMomentSource: 'https://www.chiefs.com/news/chiefs-defeat-broncos-in-dominant-fashion-31-10-to-kick-off-26-season',
    resolution: { resolved: true, winningOutcome: 'Chiefs', score: 'Chiefs 31, Broncos 10', source: 'https://www.chiefs.com/news/chiefs-defeat-broncos-in-dominant-fashion-31-10-to-kick-off-26-season' },
    historySource: 'https://clob.polymarket.com/prices-history?market=31653956477830165372337334687889690366058437085864298395551634809453963934221&startTs=1789426680&endTs=1789448280&fidelity=1',
    token: '31653956477830165372337334687889690366058437085864298395551634809453963934221',
    startTs: 1789426680,
    endTs: 1789448280,
    priceMethod: 'Polymarket CLOB token probability from fidelity=1 prices-history; token is Broncos outcome.',
  },
  {
    key: 'panthers_browns',
    venue: 'polymarket',
    market: {
      id: 'polymarket:3664753',
      source: 'polymarket',
      title: 'Panthers vs. Browns',
      outcome: 'Panthers',
      probability: null,
      category: 'sports',
      tags: ['nfl', 'football'],
      url: 'https://polymarket.com/event/nfl-car-cle-2026-09-27',
    },
    moment: '2026-09-27T20:18:00Z',
    momentPrecision: 'approximate UTC from minute-level repricing; CBS records the touchdown at 1:48 remaining in the fourth quarter.',
    momentDescription: 'Deshaun Watson threw the go-ahead touchdown to Harold Fannin Jr. and completed the two-point conversion, giving Cleveland the late lead.',
    momentSource: 'https://www.cbssports.com/nfl/gametracker/recap/NFL_20260927_CAR@CLE/',
    resolution: { resolved: true, winningOutcome: 'Browns', score: 'Browns 21, Panthers 18', source: 'https://www.cbssports.com/nfl/gametracker/recap/NFL_20260927_CAR@CLE/' },
    historySource: 'https://clob.polymarket.com/prices-history?market=70493452390244631834059715485536010493300977334464088654305169174172146700337&startTs=1790539200&endTs=1790560800&fidelity=1',
    token: '70493452390244631834059715485536010493300977334464088654305169174172146700337',
    startTs: 1790539200,
    endTs: 1790560800,
    priceMethod: 'Polymarket CLOB token probability from fidelity=1 prices-history; token is Panthers outcome.',
  },
  {
    key: 'orix_seibu',
    venue: 'kalshi',
    market: {
      id: 'kalshi:KXNPBGAME-26SEP110500SAIORI-SAI',
      source: 'kalshi',
      title: 'Saitama Seibu Lions wins',
      outcome: 'Yes',
      probability: null,
      category: 'sports',
      tags: ['baseball', 'npb'],
      url: 'https://kalshi.com/markets/kxnpbgame/KXNPBGAME-26SEP110500SAIORI-SAI',
    },
    moment: '2026-09-11T10:15:00Z',
    momentPrecision: 'approximate UTC; official game records establish the fifth-inning scoring sequence but publish no play clock, so the minute is estimated from the inning and market repricing.',
    momentDescription: 'Seibu took the lead in the fifth inning on back-to-back home runs by Tyler Nevin and Seiya Watanabe (from 1–2 to 4–2). Orix later won 5–4.',
    momentSource: 'https://pacificleague.com/news/amp/86164',
    otherMomentSource: 'https://npb.jp/bis/eng/2026/games/s2026091101947.html',
    resolution: { resolved: true, winningOutcome: 'Orix Buffaloes', score: 'Orix 5, Seibu 4', source: 'https://npb.jp/bis/eng/2026/games/s2026091101947.html' },
    historySource: 'https://api.elections.kalshi.com/trade-api/v2/markets/candlesticks?market_tickers=KXNPBGAME-26SEP110500SAIORI-SAI&start_ts=1789111800&end_ts=1789133400&period_interval=1',
    ticker: 'KXNPBGAME-26SEP110500SAIORI-SAI',
    startTs: 1789111800,
    endTs: 1789133400,
    priceMethod: 'Kalshi 1-minute candlesticks; Yes probability is midpoint of yes_bid.close_dollars and yes_ask.close_dollars when both are valid, otherwise price.close_dollars. Missing candles are not forward-filled.',
  },
];

async function fetchPolymarket(item) {
  const res = await fetch(item.historySource);
  if (!res.ok) throw new Error(`${item.key}: Polymarket history HTTP ${res.status}`);
  const body = await res.json();
  return (body.history || []).map(({ t, p }) => ({ t: new Date(t * 1000).toISOString(), p: Number(p) }));
}

async function fetchKalshi(item) {
  const res = await fetch(item.historySource);
  if (!res.ok) throw new Error(`${item.key}: Kalshi history HTTP ${res.status}`);
  const body = await res.json();
  const candles = body.markets?.[0]?.candlesticks || [];
  return candles.map((c) => {
    const bid = Number(c.yes_bid?.close_dollars);
    const ask = Number(c.yes_ask?.close_dollars);
    const last = Number(c.price?.close_dollars);
    const p = Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask >= bid
      ? (bid + ask) / 2
      : last;
    return { t: new Date(Number(c.end_period_ts) * 1000).toISOString(), p };
  }).filter((p) => Number.isFinite(p.p));
}

const events = [];
for (const item of histories) {
  const points = item.venue === 'polymarket' ? await fetchPolymarket(item) : await fetchKalshi(item);
  const { key, venue, token, ticker, startTs, endTs, ...event } = item;
  event.market.probability = points.at(-1)?.p ?? null;
  events.push({ ...event, points, coverage: { requestedStart: new Date(startTs * 1000).toISOString(), requestedEnd: new Date(endTs * 1000).toISOString(), points: points.length } });
}

const out = {
  collectedAt: new Date().toISOString(),
  collectionNotes: [
    'All histories were fetched read-only from public venue APIs using one-minute fidelity/period requests.',
    'Polymarket returns trade-derived observations at approximately minute cadence, not guaranteed clock-minute candles; no interpolation was applied.',
    'Kalshi returns minute candles; the captured Yes price uses bid/ask midpoint when available and otherwise last price. Sparse or missing candles remain absent.',
    'Moment UTC is approximate where the cited game source only provides game-clock or inning timing; precision notes state the limitation.',
  ],
  events,
};

await writeFile(new URL('../data/sports_mlb.json', import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
console.log(`Wrote ${events.length} events to validation/data/sports_mlb.json (${events.map((e) => e.points.length).join(', ')} price observations).`);
