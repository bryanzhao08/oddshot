// Shot List: rank markets by "what to watch next" from their recent fluctuation pattern
// plus a forward-looking forecast of a move in the next 30 minutes.
// Pure ES module (browser-safe).

import {
  MIN, HOUR, clamp, isNum, round, toMs, pick, pickFor, historyGetter, changeOver, rangeOver, volPerMin, historyMinutes,
  crossings50, efficiency, effectiveEndMs, pct, pts, signedPts, minutesText, truncate, labels, leader, interest, priceAt, poss,
} from './util.js';
import { heuristicForecast } from './forecast.js';

export const KINDS = ['tension', 'turning-point', 'decisive', 'closing', 'upcoming', 'momentum'];
export const PERSONAS = ['photographer', 'trader', 'fan', 'journalist', 'general'];

const KIND_BOOST = { 'turning-point': 1.1, tension: 1, decisive: 0.95, closing: 1, upcoming: 0.9, momentum: 0.8 };

/** Fluctuation features for one market. */
export function analyze(market, points, now = Date.now()) {
  const p = Number(market.probability);
  const P = Array.isArray(points) ? points : [];
  const start = toMs(market.startTime);
  const end = effectiveEndMs(market);
  const toStart = isNum(start) ? (start - now) / MIN : null;
  const toEnd = isNum(end) ? (end - now) / MIN : null;
  const startedSports = market.category === 'sports' && toStart !== null && toStart <= 0 && toStart > -240;
  const live = Boolean(market.live) || startedSports;
  const v15 = volPerMin(P, 15 * MIN, now);
  // Baseline: the hour before the last 15 minutes.
  const base = P.filter((q) => q.t <= now - 15 * MIN);
  const vBase = volPerMin(base, HOUR, now - 15 * MIN);
  const volRatio = isNum(v15) && isNum(vBase) ? v15 / Math.max(vBase, 0.0015) : NaN;
  const seed1h = isNum(market.change1h) ? market.change1h : null;
  const ch60 = changeOver(P, HOUR, now, p);
  return {
    p,
    live,
    toStart,
    toEnd,
    hm: historyMinutes(P, now),
    ch5: changeOver(P, 5 * MIN, now, p),
    ch15: changeOver(P, 15 * MIN, now, p),
    ch30: changeOver(P, 30 * MIN, now, p),
    ch60: ch60 ?? seed1h,
    v15,
    vBase,
    volRatio,
    range15: (() => {
      const r = rangeOver(P, 15 * MIN, now);
      return isNum(r.hi - r.lo) ? r.hi - r.lo : 0;
    })(),
    range30: rangeOver(P, 30 * MIN, now),
    cross60: crossings50(P, HOUR, now),
    cross20: crossings50(P, 20 * MIN, now),
    eff60: efficiency(P, HOUR, now),
    p30: priceAt(P, now - 30 * MIN),
    p60: priceAt(P, now - HOUR),
  };
}

/** Pick a kind (or null = not worth a shot). Order = priority. */
export function classify(market, f) {
  const { p } = f;
  if (!(p > 0.02 && p < 0.98)) return null;
  // Stale: well past its end and not known to be live.
  if (f.toEnd !== null && f.toEnd < -120 && !f.live) return null;
  const dist = Math.abs(p - 0.5);
  const lead = Math.max(p, 1 - p);
  const near = f.live || (f.toEnd !== null && f.toEnd > 0 && f.toEnd <= 180);

  // turning-point: crossed 50% in the last 20 min on a real move (not noise around 50.0).
  const r30 = f.range30;
  if (f.cross20.n >= 1 && dist >= 0.015 && isNum(r30.hi - r30.lo) && r30.hi - r30.lo >= 0.04) return 'turning-point';

  // decisive: favorite ≥ 85% and still climbing, while it's live / about to resolve.
  const leaderCh30 = isNum(f.ch30) ? (p >= 0.5 ? f.ch30 : -f.ch30) : null;
  if (lead >= 0.85 && lead <= 0.98 && near && leaderCh30 !== null && leaderCh30 >= 0.03) return 'decisive';

  // closing: resolves within the hour and isn't settled yet.
  if (f.toEnd !== null && f.toEnd > 0 && f.toEnd <= 60 && p >= 0.08 && p <= 0.92) return 'closing';

  // tension: near 50/50 and either live or visibly getting jumpier.
  const jumpy = (isNum(f.volRatio) && f.volRatio >= 1.3 && f.v15 >= 0.003) || f.range15 >= 0.05 || f.v15 >= 0.006;
  if (dist <= 0.12 && ((f.live && dist <= 0.1) || (near && jumpy) || (f.live && jumpy))) return 'tension';

  // upcoming: starts within 3h and the pre-game line is balanced.
  if (f.toStart !== null && f.toStart > 0 && f.toStart <= 180 && dist <= 0.2) return 'upcoming';

  // momentum: sustained one-way drift.
  if (isNum(f.ch60) && Math.abs(f.ch60) >= 0.06 && p >= 0.04 && p <= 0.96) {
    const sameWay = !isNum(f.ch15) || Math.abs(f.ch15) < 0.01 || Math.sign(f.ch15) === Math.sign(f.ch60);
    const steady = f.hm < 30 ? Math.abs(f.ch60) >= 0.08 : f.eff60 >= 0.4;
    if (sameWay && steady) return 'momentum';
  }
  return null;
}

function liveness(f) {
  if (f.live) return 1;
  if (f.toStart !== null && f.toStart > 0 && f.toStart <= 180) return 0.55 + 0.4 * (1 - f.toStart / 180);
  if (f.toEnd !== null && f.toEnd > 0) {
    if (f.toEnd <= 60) return 0.95;
    if (f.toEnd <= 360) return 0.6;
    if (f.toEnd <= 7 * 24 * 60) return 0.4;
  }
  return 0.25;
}

/** dramaScore 0..100 = forecast × uncertainty × liveness × interest (× small kind boost). */
export function dramaScore(market, f, kind, forecast) {
  const pMove = clamp(Number(forecast?.pMove30) || 0, 0, 1);
  let u = clamp(4 * f.p * (1 - f.p), 0, 1);
  if (kind === 'decisive') u = Math.max(u, 0.6); // the drama is the finish, not the doubt
  // Side markets (O/U, spreads, draws) are less of a "moment" than who wins.
  const sub = labels(market).sub ? 0.75 : 1;
  const s = sub * 100 * (0.25 + 0.75 * pMove ** 0.7) * (0.3 + 0.7 * u) * liveness(f) * interest(market.volume24h) * (KIND_BOOST[kind] || 1);
  return round(clamp(s, 0, 100), 1);
}

const PERSONA_WEIGHT = {
  photographer: (m, f) => ({ sports: 1.25, entertainment: 1.2, politics: 1 }[m.category] || 0.45) * (f.live || (f.toStart !== null && f.toStart > 0 && f.toStart < 180) ? 1 : 0.6),
  fan: (m, f) => ({ sports: 1.3, entertainment: 1.2 }[m.category] || 0.6) * (f.live ? 1.1 : 1),
  journalist: (m) => ({ politics: 1.3, economics: 1.3, tech: 1.15, weather: 1.1, sports: 0.8 }[m.category] || 0.9),
  trader: (m, f, fc) => 0.6 + 0.8 * clamp(Number(fc?.pMove30) || 0, 0, 1),
  general: () => 1,
};

// ---------- copy ----------

const split = (p) => {
  const a = Math.round(p * 100);
  return `${a}/${100 - a}`;
};

function ctxFor(market, f, kind, fc) {
  const L = labels(market);
  const lead = leader(market, f.p);
  const sports = market.category === 'sports' || (market.category === 'entertainment' && L.matchup);
  const pm = Math.round((Number(fc?.pMove30) || 0) * 100);
  const key = `${market.id}:${kind}`;
  // A "side" is a team/player we can point a camera at (head-to-head winner markets only).
  const sides = L.twoSided && !L.sub;
  const other = L.twoSided ? (lead.isYes ? L.no : L.yes) : null;
  // "Rays 64%", "Over 50%", "Sunderland AFC 45%", "Yes 72%"
  const state = L.twoSided ? `${lead.name} ${pct(lead.prob)}` : `${L.yes} ${pct(f.p)}`;
  return { L, lead, sports, pm, key, sides, other, state, name: L.name };
}

function joinWhy(parts) {
  let out = parts[0] || '';
  for (let i = 1; i < parts.length; i++) out += (/^(and|with) /.test(parts[i]) ? ' ' : ', ') + parts[i];
  return out;
}

function copy(market, f, kind, fc) {
  const c = ctxFor(market, f, kind, fc);
  const { L, lead, name, key, pm, other, sides, state } = c;
  const lp = pct(lead.prob);
  let headline;
  const why = [];
  const swing = pm >= 20 ? `${pm}% chance of a 5-pt swing in the next 30 min` : null;

  if (kind === 'tension') {
    headline = pickFor(
      sides
        ? [`${name} is on a knife-edge`, `${name}: too close to call`, `${name} could go either way`, `Nobody can call ${name}`]
        : [`${name}: the crowd can't decide`, `${name} is a coin flip`, `${name} is on a knife-edge`],
      key,
      name,
    );
    why.push(Math.abs(f.p - 0.5) <= 0.03 ? `Dead even at ${split(f.p)}` : L.twoSided ? `${lead.name} barely ahead at ${lp}` : `${L.yes} at ${pct(f.p)}`);
    if (isNum(f.volRatio) && f.volRatio >= 1.5) why.push(`volatility ${f.volRatio.toFixed(1)}× the previous hour`);
    else if (f.range15 >= 0.05) why.push(`swinging across a ${pts(f.range15)} range in 15 min`);
    else if (f.live) why.push(`and it's live`);
    if (swing) why.push(swing);
  } else if (kind === 'turning-point') {
    // Where it was on the other side of 50% before the flip.
    const from = f.p >= 0.5 ? (isNum(f.range30.lo) ? f.range30.lo : f.p30) : isNum(f.range30.hi) ? f.range30.hi : f.p30;
    if (sides) headline = pick([`${lead.name} just took the lead over ${other}`, `Lead change: ${lead.name} now favored`, `${name} flips: ${lead.name} in front`], key);
    else if (L.twoSided) headline = pickFor([`${name}: ${lead.name} now favored`, `${name} flips to ${lead.name}`], key, name);
    else headline = lead.isYes ? `${name}: ${L.yes === 'Yes' ? 'Yes' : L.yes} now favored` : `${name}: ${L.yes === 'Yes' ? 'odds flip to No' : `${L.yes} no longer favored`}`;
    const fromSide = L.twoSided ? (lead.isYes ? from : 1 - from) : from;
    const nowSide = L.twoSided ? lead.prob : f.p;
    why.push(`${L.twoSided ? lead.name : L.yes} ${pct(fromSide)} → ${pct(nowSide)} in 30 min`);
    if (f.cross60.n >= 2) why.push(`the lead has changed hands ${f.cross60.n} times in an hour`);
    else if (swing) why.push(swing);
  } else if (kind === 'decisive') {
    if (sides) headline = pick([`${lead.name} is closing it out (${lp})`, `Celebration shot incoming: ${lead.name}`, `${lead.name} pulling away in ${name}`], key);
    else if (L.twoSided) headline = `${name}: ${lead.name} all but certain (${lp})`;
    else headline = lead.isYes ? `${name}: ${L.yes === 'Yes' ? 'Yes' : L.yes} all but certain (${lp})` : `${name}: ${L.yes === 'Yes' ? 'No' : `${L.yes} fading`} (${pct(f.p)})`;
    const ch = Math.abs(f.ch30 || 0);
    why.push(L.twoSided || lead.isYes ? `${L.twoSided ? lead.name : L.yes} up ${pts(ch)} to ${L.twoSided ? lp : pct(f.p)} in 30 min` : `${L.yes} down ${pts(ch)} to ${pct(f.p)} in 30 min`);
    if (f.toEnd !== null && f.toEnd > 0 && f.toEnd < 240) why.push(`resolves in about ${minutesText(f.toEnd)}`);
    else if (f.live) why.push('still live');
  } else if (kind === 'closing') {
    headline = pickFor([`${name} settles in ${minutesText(f.toEnd)}`, `Final stretch: ${name}`, `Last call on ${name}`], key, name);
    why.push(`${state} with about ${minutesText(f.toEnd)} to go`);
    if (isNum(f.ch15) && Math.abs(f.ch15) >= 0.03) why.push(`moved ${signedPts(f.ch15)} in 15 min`);
    else if (swing) why.push(swing);
  } else if (kind === 'upcoming') {
    headline = pick(
      [`${name} starts in ${minutesText(f.toStart)}`, `Coming up: ${name}, priced near even`, `Circle it: ${name} in ${minutesText(f.toStart)}`],
      key,
    );
    why.push(`Pre-${c.sports ? 'game' : 'event'} line ${split(f.p)} (${L.twoSided ? `${L.yes} ${pct(f.p)}` : state})`);
    if (isNum(f.v15) && f.v15 < 0.0015 && f.hm >= 30) why.push('and the market is unusually quiet');
    else if (c.sports) why.push('and balanced games tend to swing early');
  } else {
    const d = f.ch60 || 0;
    const up = d > 0;
    const who = L.twoSided || L.yes !== 'Yes' ? L.yes : name;
    headline = pickFor(
      [`${who} keeps ${up ? 'climbing' : 'sliding'}: ${signedPts(d)} in an hour`, `Steady ${up ? 'rise' : 'slide'} in ${name}`, `${name}: one-way traffic ${up ? 'up' : 'down'}`],
      key,
      name,
    );
    const from = isNum(f.p60) ? f.p60 : f.p - d;
    why.push(`${L.yes} ${pct(from)} → ${pct(f.p)} over the hour`);
    if (f.eff60 >= 0.7) why.push('with barely a pullback');
    else if (f.eff60 >= 0.4) why.push(`${Math.round(f.eff60 * 100)}% of the movement one way`);
  }
  return { headline: truncate(headline, 70), why: truncate(joinWhy(why), 140), ctx: c };
}

function tips(market, f, kind, fc, c) {
  const { lead, name, pm, other, key, sports, sides, state, L } = c;
  const lp = pct(lead.prob);
  const m = (x) => minutesText(x);
  const t = {};
  switch (kind) {
    case 'tension':
      t.photographer = sports
        ? pick([`Stay on it: a game this tight usually turns on one play. Keep the long lens up and both benches in reach.`, `Don't step away. It's even, and the deciding moment could come any minute.`, `Hold your spot near the action; at ${split(f.p)} the next big play decides it.`], key)
        : `Keep a camera on the room; this could break either way in the next half hour.`;
      t.trader = isNum(f.volRatio) && f.volRatio >= 1.3
        ? `Vol is ${f.volRatio.toFixed(1)}× the prior hour right at 50%, where prices move most per unit of news. Use limits, size down.`
        : `${pm}% odds of a 5-pt move in 30 min at ${split(f.p)}. Expect the book to jump; work limit orders.`;
      t.fan = pick([`Tune in now: it's ${f.live ? 'live and ' : ''}dead even.`, `Drop what you're doing, this one is close.`, `Good time to watch: neither side is pulling away.`], key);
      t.journalist = `Draft both versions: ${split(f.p)} with ${pm}% odds of a big swing in the next 30 min.`;
      t.general = `Worth watching now: a coin flip with a ${pm}% chance of a 5-pt swing within 30 min.`;
      break;
    case 'turning-point':
      t.photographer = sports && sides
        ? `Momentum just switched to ${lead.name}. Shoot their bench and crowd now; ${poss(other)} reaction makes the pair.`
        : sports ? `The game just turned (${state}). Watch the bench reactions.` : `The mood is turning. Get reaction shots from both camps.`;
      t.trader = f.cross60.n >= 2
        ? `Whipsaw: ${f.cross60.n} lead changes in an hour. Follow-through is a coin toss; keep size small.`
        : `Fresh break through 50%. Watch for follow-through vs a snap back in the next few minutes.`;
      t.fan = sides ? `${lead.name} just took over. Great time to tune in.` : `The game just turned. Great time to tune in.`;
      t.journalist = `The favorite changed (${state}). Update your framing before the wires do.`;
      t.general = `The odds just flipped: ${state}.`;
      break;
    case 'decisive':
      t.photographer = sports && sides
        ? `Celebration shot incoming: ${lead.name} ~${lp} decided. Get on their side for the final whistle and the reaction.`
        : sports ? `It's nearly settled (${state}). Set up for the final moments and the reactions.` : `Outcome looks ~${lp} settled. Set up for the announcement and the reactions.`;
      t.trader = `${lp} with ~${pts(1 - lead.prob)} left on the table. Late entries carry tail risk if it reverses.`;
      t.fan = sides ? `${lead.name} is about to seal it. Catch the finish.` : `This one is nearly decided. Catch the finish.`;
      t.journalist = `Prep the story now (market says ${state}), but keep the upset draft handy.`;
      t.general = `Nearly certain now: ${state}.`;
      break;
    case 'closing':
      t.photographer = `Resolves in ~${m(f.toEnd)}. Be in position for the final moment, not after it.`;
      t.trader = `Settles in ~${m(f.toEnd)} at ${split(f.p)}. Liquidity thins near the close; mind the spread.`;
      t.fan = `Last ${m(f.toEnd)} to watch this play out.`;
      t.journalist = `Resolution in ~${m(f.toEnd)}. Have the headline ready for both outcomes.`;
      t.general = `Decided within ${m(f.toEnd)}; right now ${state}.`;
      break;
    case 'upcoming':
      t.photographer = sports
        ? `Starts in ${m(f.toStart)}. Get to your spot early: an even matchup means the first big moment can come fast.`
        : `Starts in ${m(f.toStart)}. Get in position before it begins.`;
      t.trader = `Pre-${sports ? 'game' : 'event'} at ${pct(f.p)}. The opening minutes usually reprice the most.`;
      t.fan = `Set a reminder: starts in ${m(f.toStart)} and it's close.`;
      t.journalist = `Line up sources before it starts in ${m(f.toStart)}; the market sees it near even.`;
      t.general = `Starts in ${m(f.toStart)} and the market can't pick a side.`;
      break;
    default: {
      const d = f.ch60 || 0;
      t.photographer = sports && sides
        ? `${d > 0 ? L.yes : L.no} is building pressure; frame the side that's pushing.`
        : `Sentiment is drifting steadily; worth a reaction shoot before it lands.`;
      t.trader = `Trend: ${signedPts(d)} over 60 min, ${Math.round(f.eff60 * 100)}% directional. Watch for exhaustion before chasing.`;
      t.fan = `Things are moving ${d > 0 ? 'toward' : 'away from'} ${L.yes}. Worth checking in.`;
      t.journalist = `The crowd moved ${signedPts(d)} in an hour without reversing. Find out what changed.`;
      t.general = `${L.yes} ${d > 0 ? 'gaining' : 'losing'} steadily: ${signedPts(d)} in the last hour.`;
    }
  }
  for (const k of Object.keys(t)) t[k] = t[k].replace(/\s+/g, ' ').trim();
  return t;
}

function windowFor(market, f, kind, now) {
  const iso = (ms) => new Date(ms).toISOString();
  const end = effectiveEndMs(market);
  const start = toMs(market.startTime);
  if (kind === 'upcoming' && isNum(start)) {
    const fallbackEnd = start + (market.category === 'sports' ? 3 * HOUR : 2 * HOUR);
    return { startsAt: iso(start - 10 * MIN), endsAt: iso(isNum(end) && end > start ? Math.min(end, fallbackEnd) : fallbackEnd) };
  }
  if (kind === 'closing' && isNum(end)) return { startsAt: iso(now), endsAt: iso(end) };
  const horizon = kind === 'momentum' ? HOUR : 30 * MIN;
  const e = isNum(end) && end > now ? Math.min(end, now + horizon) : now + horizon;
  return { startsAt: iso(now), endsAt: iso(e) };
}

/** Matchup identity across sources ("fernandez|ostapenko"), used to avoid duplicate shots. */
function dedupeKey(market) {
  const L = labels(market);
  if (L.key) return `mu:${L.key}`;
  return market.eventKey ? `ev:${market.source}:${market.eventKey}` : `id:${market.id}`;
}

/**
 * Build the ranked Shot List.
 * opts: { history: fn|Map|object, forecast: (market, history, now) => forecast|null,
 *         now, persona = 'general', category, limit = 20 }
 */
export function buildShots(markets, opts = {}) {
  const now = opts.now ?? Date.now();
  const persona = PERSONAS.includes(opts.persona) ? opts.persona : 'general';
  const limit = clamp(Number(opts.limit) || 20, 1, 200);
  const getHist = historyGetter(opts.history);
  const forecastFn = typeof opts.forecast === 'function' ? opts.forecast : heuristicForecast;
  const category = opts.category ? String(opts.category).toLowerCase() : '';
  const weight = PERSONA_WEIGHT[persona];

  const cands = [];
  for (const m of markets || []) {
    if (!m || !m.id || !(m.probability >= 0 && m.probability <= 1)) continue;
    if (category && m.category !== category) continue;
    const points = getHist(m.id);
    const f = analyze(m, points, now);
    const kind = classify(m, f);
    if (!kind) continue;
    let fc = null;
    try {
      fc = forecastFn(m, points, now);
    } catch {
      fc = null;
    }
    if (!fc) fc = heuristicForecast(m, points, now);
    const base = dramaScore(m, f, kind, fc);
    const score = round(clamp(base * weight(m, f, fc), 0, 100), 1);
    cands.push({ m, f, kind, fc, score });
  }
  cands.sort((a, b) => b.score - a.score || (b.m.volume24h || 0) - (a.m.volume24h || 0));

  // At most 2 shots per game/event: the best one, plus one side market (O/U, spread...)
  // from the same venue. The same game on the other venue doesn't get a second slot.
  const seen = new Map(); // key -> [{source, sub}]
  const out = [];
  for (const c of cands) {
    const k = dedupeKey(c.m);
    const prev = seen.get(k) || [];
    const sub = labels(c.m).sub;
    if (prev.length >= 2) continue;
    if (prev.length === 1 && !(sub !== prev[0].sub && c.m.source === prev[0].source)) continue;
    seen.set(k, [...prev, { source: c.m.source, sub }]);
    const { headline, why, ctx } = copy(c.m, c.f, c.kind, c.fc);
    out.push({
      id: `${c.m.id}:${c.kind}`,
      marketId: c.m.id,
      market: c.m,
      kind: c.kind,
      headline,
      why,
      forecast: { pMove30: c.fc.pMove30, expectedMovePts: c.fc.expectedMovePts, model: c.fc.model },
      dramaScore: c.score,
      window: windowFor(c.m, c.f, c.kind, now),
      tips: tips(c.m, c.f, c.kind, c.fc, ctx),
      rank: out.length + 1,
    });
    if (out.length >= limit) break;
  }
  return out;
}
