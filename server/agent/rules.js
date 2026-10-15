// Deterministic, role-specific recommendations (CONTRACT.md v3 "Recommendation").
// Browser-safe: pure ES module, no node: imports, no SDK. Always available; the Claude
// recommender (claude.js) upgrades these when credentials exist.
//
//   recommendRules(target, { market, role, history, context, forecast, related }) → Recommendation
//   recommendAllRoles(target, ctx) → { photographer, trader, fan, journalist, general }
//
// `target` is a Spike (kind 'price' | 'volatility'), a Shot, or an Insight.

export const ROLES = ['photographer', 'trader', 'fan', 'journalist', 'general'];
export const TRADER_DISCLAIMER = 'Signal, not financial advice.';

const SHOT_KINDS = new Set(['tension', 'turning-point', 'decisive', 'closing', 'upcoming', 'momentum']);
const INSIGHT_TYPES = new Set(['lead-change', 'upset-brewing', 'lock-in', 'calm-before-storm', 'belief-shift', 'story', 'divergence']);
const MIN = 60e3;

// ---------- small helpers ----------

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const pct = (p) => `${Math.round(clamp(p, 0, 1) * 100)}%`;
const ptsN = (d) => Math.round(Math.abs(d) * 100);
const signed = (d) => `${d >= 0 ? '+' : '−'}${ptsN(d)} ${ptsN(d) === 1 ? 'pt' : 'pts'}`;
const signedPct = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`;
function truncate(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length <= n ? s : `${s.slice(0, n - 1).replace(/[\s,;:—-]+$/, '')}…`;
}
function dur(ms) {
  if (!isNum(ms) || ms <= 0) return null;
  if (ms < 90e3) return `${Math.max(1, Math.round(ms / 1000))} s`;
  const m = Math.round(ms / MIN);
  if (m < 90) return `${m} min`;
  const h = Math.round(m / 60);
  return `${h} h`;
}
function hash(s) {
  let h = 2166136261;
  for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}
const pick = (arr, key) => arr[hash(key) % arr.length];
function toMs(x) {
  if (isNum(x)) return x;
  const t = Date.parse(x);
  return Number.isFinite(t) ? t : null;
}
const money = (x) => (x >= 1000 ? `$${Math.round(x).toLocaleString('en-US')}` : `$${x.toFixed(x >= 10 ? 2 : 4)}`);

// ---------- market labels ----------

const MATCHUP_RE = /^(.+?)\s+(?:vs\.?|v\.?|@|at)\s+(.+?)(?:\s*[:(\-–—]|\s+-\s|$)/i;
function cleanSide(s) {
  return String(s || '')
    .replace(/\b(FC|AFC|SC|CF)\b\.?/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function refersTo(a, b) {
  const x = cleanSide(a).toLowerCase();
  const y = cleanSide(b).toLowerCase();
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x) || x.split(' ').some((w) => w.length > 3 && y.split(' ').includes(w));
}

/** { name, yes, no|null, twoSided, matchup, sub } — names the side(s) of a market. */
export function sides(market = {}) {
  const title = String(market.title || market.id || 'This market');
  const outcome = String(market.outcome || 'Yes');
  const isYes = /^(yes|no)$/i.test(outcome);
  const mm = title.match(MATCHUP_RE);
  const sub = /\b(o\/u|over\/under|spread|handicap|total|first \d+ innings|1st half|draw|tie)\b/i.test(title);
  let a = mm ? cleanSide(mm[1]) : null;
  let b = mm ? cleanSide(mm[2]) : null;
  if (a && a.split(' ').length > 5) a = b = null; // not really a matchup
  const name = a && b ? `${a} vs ${b}` : title.replace(/\?$/, '').replace(/^Will (the )?/i, (m0, the) => (the ? 'The ' : ''));
  if (a && b && !isYes && !sub) {
    if (refersTo(outcome, a)) return { name, yes: a, no: b, twoSided: true, matchup: true, sub: false };
    if (refersTo(outcome, b)) return { name, yes: b, no: a, twoSided: true, matchup: true, sub: false };
  }
  if (!isYes) return { name: truncate(name, 60), yes: truncate(cleanSide(outcome), 32), no: null, twoSided: false, matchup: Boolean(a), sub };
  return { name: truncate(name, 60), yes: null, no: null, twoSided: false, matchup: Boolean(a), sub };
}

/** How to refer to the market in copy: "Chiefs vs Bills", "Fed hold", or the quoted question. */
function displayName(market, S, context) {
  if (S.matchup || S.twoSided) return S.name;
  const special = shortMarketName(market, S, context);
  if (special) return special;
  const q = String(market.title || 'this market').trim();
  return `“${truncate(q, 54)}”`;
}

function subjectOf(market, S) {
  // Short noun phrase for "X odds".
  if (S.yes) return S.yes;
  return truncate(S.name, 44);
}

/** The side a probability favors. */
function leaderOf(S, p, market) {
  if (S.twoSided) return p >= 0.5 ? { name: S.yes, prob: p } : { name: S.no, prob: 1 - p };
  if (S.yes) return p >= 0.5 ? { name: S.yes, prob: p } : { name: `not ${S.yes}`, prob: 1 - p };
  return p >= 0.5 ? { name: 'Yes', prob: p } : { name: 'No', prob: 1 - p };
}

// ---------- crypto/finance detection ----------

const CRYPTO_RE = /\b(bitcoin|btc|ethereum|eth|solana|sol|xrp|ripple|doge|dogecoin|crypto|cardano|ada|bnb|litecoin|ltc)\b/i;
const FIN_RE = /\b(fed|fomc|rate[s]?|cpi|inflation|s&p|spx|nasdaq|dow|treasury|yield|gdp|jobs report|unemployment|recession|oil|gold|stock|ipo|earnings)\b/i;
export function isMarketsy(market = {}) {
  const t = `${market.title || ''} ${(market.tags || []).join(' ')}`;
  return market.category === 'crypto' || market.category === 'economics' || CRYPTO_RE.test(t) || FIN_RE.test(t);
}
const CRYPTO_SYM = [
  [/\b(bitcoin|btc)\b/i, 'BTC'],
  [/\b(ethereum|eth)\b/i, 'ETH'],
  [/\b(solana|sol)\b/i, 'SOL'],
  [/\b(xrp|ripple)\b/i, 'XRP'],
  [/\b(doge|dogecoin)\b/i, 'DOGE'],
];
function threshold(title) {
  const m = String(title || '').match(/\$\s?([\d,]+(?:\.\d+)?)([kmb])?(?![a-z])/i);
  if (!m) return null;
  if (m[2]) return `$${m[1]}${m[2].toLowerCase()}`;
  const n = Number(m[1].replace(/,/g, ''));
  if (n >= 1000 && n % 1000 === 0) return `$${n / 1000}k`;
  if (n >= 1000 && n % 100 === 0) return `$${(n / 1000).toFixed(1)}k`;
  return `$${m[1]}`;
}
function shortMarketName(market, S, context) {
  const title = String(market.title || '');
  let sym = context?.kind === 'asset' ? context.symbol : null;
  if (!sym) for (const [re, s] of CRYPTO_SYM) if (re.test(title)) { sym = s; break; }
  const thr = threshold(title);
  if (sym && thr) {
    const dir = /\b(below|under|dip|fall|less than|drop)\b/i.test(title) ? '<' : '>';
    return `${sym} ${dir} ${thr}`;
  }
  if (/\bfed\b|fomc/i.test(title)) {
    if (/no change|hold|pause|unchanged/i.test(title)) return 'Fed hold';
    if (/cut/i.test(title)) return 'Fed cut';
    if (/hike|raise|increase/i.test(title)) return 'Fed hike';
  }
  return null;
}

// ---------- live context ----------

function gameBits(context) {
  if (!context || context.kind !== 'game') return null;
  const live = context.status === 'in';
  const s = context.score || {};
  const score =
    isNum(Number(s.home)) && isNum(Number(s.away)) && (s.homeTeam || s.awayTeam) && s.home !== undefined && s.away !== undefined
      ? `${s.awayTeam || 'Away'} ${s.away}–${s.home} ${s.homeTeam || 'Home'}`
      : null;
  let when = null;
  const lg = String(context.league || '').toLowerCase();
  if (context.period != null || context.clock) {
    const per = context.period;
    if (/nfl|college-football|ncaaf|cfb|nba|wnba|basketball|football/.test(lg) && per != null) when = `Q${per}${context.clock ? ` ${context.clock}` : ''}`;
    else if (/nhl|hockey/.test(lg) && per != null) when = `P${per}${context.clock ? ` ${context.clock}` : ''}`;
    else if (/mlb|baseball/.test(lg) && per != null) when = `inning ${per}`;
    else if (context.clock) when = String(context.clock);
  }
  const imm = context.imminent && context.imminent.type ? context.imminent : null;
  return { live, score, when, situation: context.situation || null, imminent: imm, lastPlay: context.lastPlay || null, league: lg };
}

function assetBits(context) {
  if (!context || context.kind !== 'asset' || !isNum(context.price)) return null;
  return { symbol: context.symbol, price: context.price, change5m: context.change5m, change1h: context.change1h };
}

const IMMINENT_SHOT = {
  touchdown: 'get the end-zone shot',
  score: 'frame the scoring end',
  goal: 'frame the goalmouth',
  run: 'cover home plate for the slide',
  'break-point': 'watch the serve-return exchange',
  shot: 'stay locked on the shooter',
};
const IMMINENT_VERB = {
  touchdown: 'touchdown likely',
  score: 'score likely',
  goal: 'goal threat',
  run: 'run likely',
  'break-point': 'break chance',
  shot: 'shot coming',
};

// ---------- facts extracted from any target ----------

function targetType(t = {}) {
  if (t.kind === 'volatility') return 'volatility';
  if (isNum(t.dramaScore) || (SHOT_KINDS.has(t.kind) && t.headline)) return 'shot';
  if (INSIGHT_TYPES.has(t.type) || (t.type && t.body !== undefined)) return 'insight';
  return 'price';
}

function historyMove(history, now, windowMs) {
  if (!Array.isArray(history) || history.length < 2) return null;
  const last = history[history.length - 1];
  const t0 = (isNum(last.t) ? last.t : now) - windowMs;
  let first = history.find((q) => q.t >= t0) || history[0];
  if (first === last) first = history[history.length - 2];
  if (!isNum(first.p) || !isNum(last.p)) return null;
  return { from: first.p, to: last.p, delta: last.p - first.p, windowMs: Math.max(MIN, last.t - first.t) };
}

function facts(target, ctx) {
  const type = targetType(target);
  const market = ctx.market || target.market || {};
  const now = isNum(ctx.now) ? ctx.now : Date.now();
  const p = isNum(target.to) ? target.to : isNum(market.probability) ? market.probability : 0.5;
  let move = null;
  if (isNum(target.from) && isNum(target.to)) move = { from: target.from, to: target.to, delta: isNum(target.delta) ? target.delta : target.to - target.from, windowMs: target.windowMs };
  else if (type === 'insight' && target.data && isNum(target.data.from) && isNum(target.data.to)) {
    const hours = isNum(target.data.hours) ? target.data.hours : null;
    move = { from: target.data.from, to: target.data.to, delta: target.data.to - target.data.from, windowMs: hours ? hours * 3600e3 : null };
  } else {
    move = historyMove(ctx.history, now, 30 * MIN);
    if ((!move || Math.abs(move.delta) < 0.01) && isNum(market.change1h) && Math.abs(market.change1h) >= 0.01)
      move = { from: clamp(p - market.change1h, 0, 1), to: p, delta: market.change1h, windowMs: 60 * MIN };
  }
  if (move && !(Math.abs(move.delta) >= 0.005)) move = null;
  const S = sides(market);
  const lead = leaderOf(S, p, market);
  const fc = ctx.forecast || target.forecast || null;
  const pMove = isNum(fc?.pMove30) ? fc.pMove30 : null;
  const crossed = move && (move.from - 0.5) * (move.to - 0.5) < 0;
  const sports = market.category === 'sports' || S.matchup || ctx.context?.kind === 'game';
  const startMs = toMs(market.startTime);
  const endMs = toMs(market.endDate);
  return {
    type,
    market,
    now,
    p,
    move,
    S,
    lead,
    fc,
    pMove,
    crossed,
    sports,
    live: Boolean(market.live || target.live || ctx.context?.status === 'in'),
    toStart: isNum(startMs) ? (startMs - now) / MIN : null,
    toEnd: isNum(endMs) ? (endMs - now) / MIN : null,
    game: gameBits(ctx.context),
    asset: assetBits(ctx.context),
    marketsy: isMarketsy(market),
    shortName: shortMarketName(market, S, ctx.context) || subjectOf(market, S),
    display: displayName(market, S, ctx.context),
    binary: !S.twoSided, // Yes/No question, or a named non-side outcome (Tie, Over 2.5, a candidate…)
    key: `${target.id || market.id || ''}:${ctx.role}`,
    severity: target.severity || null,
    zScore: isNum(target.zScore) ? target.zScore : null,
    volRatio: isNum(target.volRatio) ? target.volRatio : null,
    pReal: isNum(target.ml?.pReal) ? target.ml.pReal : null,
    related: Array.isArray(ctx.related) ? ctx.related : [],
  };
}

/** The side a move favored and its new probability. */
function gainer(F) {
  const { move, S, p } = F;
  if (!move) return null;
  const up = move.delta > 0;
  if (S.twoSided) return up ? { name: S.yes, prob: p } : { name: S.no, prob: 1 - p };
  if (S.yes) return up ? { name: S.yes, prob: p } : { name: `not ${S.yes}`, prob: 1 - p };
  return up ? { name: 'Yes', prob: p, side: 'Yes' } : { name: 'No', prob: 1 - p, side: 'No' };
}

/** "Chiefs 61%" or "“Will X?” 58% Yes" / "Fed hold 58% Yes". */
function stateText(F, g = F.lead) {
  if (F.binary && F.S.yes) return `${F.display}: ${F.S.yes} ${pct(F.p)}`;
  if (F.binary) return `${F.display} ${pct(g.prob)} ${g.name}`;
  return `${g.name} ${pct(g.prob)}`;
}

/** "+19 pts in 4 min". Gainer-relative (always +) unless `outcomeSigned` (relative to the market's outcome). */
function moveText(F, { outcomeSigned = false } = {}) {
  if (!F.move) return null;
  const w = dur(F.move.windowMs);
  const os = outcomeSigned || (F.binary && F.S.yes);
  return `${signed(os ? F.move.delta : Math.abs(F.move.delta))}${w ? ` in ${w}` : ''}`;
}

/** "Chiefs vs Bills: Chiefs 61%" or "Fed hold at 72% Yes". */
function headState(F) {
  if (F.binary) return F.S.yes ? stateText(F) : `${F.display} at ${pct(F.p)} Yes`;
  return `${F.display}: ${F.lead.name} ${pct(F.lead.prob)}`;
}

function confidenceOf(F, role) {
  let s = 0;
  if (F.severity === 'major') s += 2;
  else if (F.severity === 'notable') s += 1;
  if (F.type === 'shot') {
    const d = Number(F.target?.dramaScore);
    if (d >= 70) s += 2;
    else if (d >= 40) s += 1;
  }
  if (F.zScore !== null && F.zScore >= 4) s += 1;
  if (F.volRatio !== null && F.volRatio >= 5) s += 1;
  if (F.pReal !== null) s += F.pReal >= 0.7 ? 1 : F.pReal < 0.4 ? -1 : 0;
  if (F.game?.imminent && isNum(F.game.imminent.confidence) && F.game.imminent.confidence >= 0.6 && (role === 'photographer' || role === 'fan')) s += 1;
  if (F.lead.prob >= 0.9 && F.sports) s += 1;
  if (role === 'trader') s = Math.min(s, 2); // never "high" certainty for trading copy
  return s >= 3 ? 'high' : s >= 1 ? 'medium' : 'low';
}

function reasoning(F) {
  const out = [];
  const { move, S } = F;
  if (move) {
    const g = gainer(F);
    const flip = move.delta < 0 && !(F.binary && S.yes);
    const fromSide = flip ? 1 - move.from : move.from;
    const toSide = flip ? 1 - move.to : move.to;
    const w = dur(move.windowMs);
    const who = F.binary ? (S.yes ? `${S.yes} (${F.display})` : `${g.name} on ${F.display}`) : g.name;
    out.push(`${who} ${pct(fromSide)} → ${pct(toSide)}${w ? ` in ${w}` : ''} (${signed(flip || !(F.binary && S.yes) ? Math.abs(move.delta) : move.delta)})`);
  } else {
    out.push(headState(F));
  }
  if (F.type === 'volatility' && F.volRatio !== null) out.push(`Short-window volatility ${F.volRatio.toFixed(1)}× its own baseline`);
  else if (F.zScore !== null && F.zScore >= 2) out.push(`Move is ${F.zScore.toFixed(1)}σ vs this market's normal swings`);
  if (F.game && (F.game.situation || F.game.score)) {
    out.push(`${F.game.live ? 'Live' : 'Game'}: ${[F.game.situation, F.game.when, F.game.score].filter(Boolean).join(', ')}`);
  } else if (F.asset) {
    const ch = isNum(F.asset.change1h) ? ` (${signedPct(F.asset.change1h)} 1h)` : isNum(F.asset.change5m) ? ` (${signedPct(F.asset.change5m)} 5m)` : '';
    out.push(`${F.asset.symbol} spot ${money(F.asset.price)}${ch}`);
  } else if (F.pMove !== null && F.pMove >= 0.15) {
    out.push(`${Math.round(F.pMove * 100)}% chance of another 5-pt swing in 30 min`);
  } else if (F.target?.why) {
    out.push(truncate(F.target.why, 100));
  } else if (F.type === 'insight' && F.target?.body) {
    out.push(truncate(F.target.body, 100));
  }
  return out.slice(0, 3).map((s) => truncate(s, 120));
}

// ---------- role copy ----------

function decisiveFor(F) {
  return F.lead.prob >= 0.9 && F.lead.prob < 0.995 && (F.live || F.sports || (F.toEnd !== null && F.toEnd > 0 && F.toEnd < 240));
}
const nearEven = (p) => Math.abs(p - 0.5) <= 0.12;

function imminentWhat(game, lead) {
  const im = game.imminent;
  const team = im.team || lead.name;
  if (im.type === 'break-point') return game.situation && /break point/i.test(game.situation) ? game.situation : `Break point ${team}`;
  if (game.situation) return `${team} ${game.situation.replace(/^1st & goal/i, '1st & goal')}`;
  return im.text ? `${team}: ${im.text}` : `${team} pressing`;
}

function photographer(F) {
  const { game, lead, key, display } = F;
  if (game?.imminent) {
    const im = game.imminent;
    const shot = IMMINENT_SHOT[im.type] || 'stay on the play';
    return {
      headline: `${imminentWhat(game, lead)} — ${shot}`,
      action: `${cap(shot)} now; ${IMMINENT_VERB[im.type] || 'something is building'}${isNum(im.confidence) ? ` (~${Math.round(im.confidence * 100)}% by game state)` : ''}.`,
    };
  }
  if (F.type === 'volatility') {
    return {
      headline: `${truncate(display, 36)} just started thrashing — something is developing`,
      action: F.sports ? 'Stay on the field and keep both benches in frame; the market is reacting to something live.' : 'Keep a camera on the room; the crowd is reacting to something that has not hit the wires yet.',
    };
  }
  if (decisiveFor(F) && !F.binary) {
    return {
      headline: `${lead.name} ~${pct(lead.prob)} decided — set up for the celebration`,
      action: F.sports ? `Move to ${poss(lead.name)} side for the final whistle and the reaction.` : `Line up the winner's reaction shot; ${lead.name} is ~${pct(lead.prob)}.`,
    };
  }
  if (decisiveFor(F)) return { headline: truncate(`${stateText(F)} — set up for the ${F.sports ? 'final whistle' : 'reaction'}`, 80), action: 'Line up reaction shots; the outcome is close to settled.' };
  if (F.type === 'shot') {
    const k = F.target.kind;
    if (k === 'upcoming' && F.toStart !== null && F.toStart > 0)
      return {
        headline: `${truncate(display, 40)} starts in ${dur(F.toStart * MIN)} — get in position`,
        action: nearEven(F.p) ? `Arrive early and scout angles; at ${pct(F.p)} it could swing early.` : `Arrive early; ${F.binary ? stateText(F) : `${F.lead.name} ${pct(F.lead.prob)}`} going in.`,
      };
    if (k === 'tension')
      return { headline: `${truncate(display, 40)} on a knife-edge (${pct(F.p)}) — long lens up`, action: pick(['Keep the long lens up and both benches in reach; one play decides it.', "Don't step away; at near 50/50 the deciding moment could come any minute."], key) };
    if (k === 'closing' && F.toEnd !== null) return { headline: `Final stretch: ${truncate(display, 44)} — be at the finish`, action: `Position for the finish; it settles in about ${dur(Math.max(1, F.toEnd) * MIN)}.` };
  }
  const g = gainer(F);
  if (g && F.move) {
    const mt = moveText(F);
    if (F.binary && F.sports) return { headline: truncate(`${stateText(F, g)} (${mt}) — shoot the reaction`, 80), action: 'Something just happened on the field; get the reaction, then stay on the play.' };
    if (!F.sports) return { headline: truncate(`Mood shift: ${F.binary ? stateText(F, g) : `${display} ${g.name} ${pct(g.prob)}`} (${mt})`, 80), action: 'Get reaction shots from both camps now; the crowd just changed its mind.' };
    if (F.crossed) return { headline: `Momentum flip to ${g.name} (${mt}) — shoot both benches`, action: `Get ${poss(g.name)} celebration and the other side's reaction; the lead just changed hands.` };
    return { headline: `Momentum swing to ${g.name} (${mt}) — shoot the reaction`, action: `Shoot the reaction now, then stay on ${g.name}; ${pct(g.prob)} and moving.` };
  }
  return { headline: truncate(`${headState(F)} — stay ready`, 80), action: 'Hold position; no decisive moment yet, but keep the camera up.' };
}

function trader(F) {
  const { shortName, asset } = F;
  const mt = moveText(F, { outcomeSigned: true });
  const spotCh = asset ? (isNum(asset.change5m) && Math.abs(asset.change5m) >= 0.001 ? asset.change5m : isNum(asset.change1h) ? asset.change1h : null) : null;
  const spot = spotCh !== null ? `spot ${signedPct(spotCh)}` : null;
  const odds = F.binary && !shortMarketName(F.market, F.S, null) && !F.asset ? `${F.display} odds` : `${shortName} odds`;
  if (F.type === 'volatility') {
    const vr = F.volRatio !== null ? `${F.volRatio.toFixed(1)}× normal volatility` : 'volatility spiking';
    return {
      headline: `${truncate(shortName, 36)}: ${vr}${F.move ? `, net ${signed(F.move.delta)}` : ''} — regime change`,
      action: 'Expect wider spreads and fast repricing; consider reducing size and using limit orders.',
    };
  }
  if (F.move) {
    const up = F.move.delta > 0;
    const confirm = spotCh !== null ? (Math.sign(spotCh) === Math.sign(F.move.delta) ? 'spot confirms' : 'spot not confirming yet') : null;
    const tone = up ? 'bullish momentum' : 'bearish momentum';
    const headline = `${odds} ${mt}${spot ? `, ${spot}` : ''} — ${F.marketsy ? tone : F.crossed ? 'favorite flipped' : 'momentum'}`;
    let action;
    if (F.marketsy) action = `Consider reviewing a position${confirm ? ` (${confirm})` : ''}; check liquidity and spread first.`;
    else if (F.crossed) action = 'Fresh break through 50%; watch for follow-through vs a snap back before reviewing exposure.';
    else action = 'Review exposure; the book may keep repricing. Prefer limit orders.';
    return { headline, action };
  }
  if (F.pMove !== null) {
    return {
      headline: `${truncate(shortName, 36)} at ${pct(F.p)}: ${Math.round(F.pMove * 100)}% odds of a 5-pt move in 30 min`,
      action: F.pMove >= 0.4 ? 'Volatility likely; consider limit orders and smaller size.' : 'Quiet for now; worth watching rather than acting.',
    };
  }
  return { headline: `${truncate(shortName, 50)} steady at ${pct(F.p)}`, action: 'No strong signal; keep it on the watchlist.' };
}

function fan(F) {
  const { game, display } = F;
  const g = gainer(F);
  if (game?.imminent && game.live) {
    const im = game.imminent;
    return {
      headline: truncate(`${imminentWhat(game, F.lead)} — tune in now`, 80),
      action: `Get to a screen; ${IMMINENT_VERB[im.type] || 'something is building'}${game.score ? ` (${game.score})` : ''}.`,
    };
  }
  if (F.type === 'volatility') return { headline: `${truncate(display, 40)} just got wild — something is happening`, action: 'Tune in now; the odds are swinging hard both ways.' };
  if (decisiveFor(F) && F.sports && !F.binary) return { headline: `${F.lead.name} ~${pct(F.lead.prob)} to win — closing it out`, action: `Catch the finish; ${F.lead.name} is almost there.` };
  if (g && F.move) {
    if (F.sports && !F.binary) {
      return {
        headline: `${g.name} ${F.crossed ? 'just took the lead' : 'just went up'} — ${pct(g.prob)} to win, ${moveText(F)}`,
        action: 'Tune in now; this is the moment.',
      };
    }
    return { headline: truncate(`Big swing: ${stateText(F, g)} (${moveText(F)})`, 80), action: 'Worth a look now; the crowd just changed its mind.' };
  }
  if (F.type === 'shot' && F.target.kind === 'upcoming' && F.toStart !== null && F.toStart > 0)
    return { headline: `${truncate(display, 44)} starts in ${dur(F.toStart * MIN)}${nearEven(F.p) ? ' — near even' : ''}`, action: F.sports ? 'Set a reminder; balanced games tend to swing early.' : 'Set a reminder.' };
  if (nearEven(F.p)) return { headline: truncate(`${display} is dead even (${pct(F.p)})`, 80), action: 'Good time to watch; neither side is pulling away.' };
  return { headline: truncate(headState(F), 80), action: 'Keep an eye on it.' };
}

function journalist(F) {
  const g = gainer(F);
  const { display } = F;
  if (F.type === 'volatility') {
    const vr = F.volRatio !== null ? ` (${F.volRatio.toFixed(1)}× normal volatility)` : '';
    return { headline: `${truncate(display, 36)} is thrashing${vr} — something is developing`, action: 'Start making calls and check the wires; markets often move before the headline.' };
  }
  if (F.crossed && g) {
    const text = F.binary ? (F.S.yes ? `Draft both versions; ${display}: ${F.S.yes} now ${pct(F.p)}` : `Draft both versions; ${display} flipped to ${pct(g.prob)} ${g.name}`) : `Draft both versions; the odds flipped to ${pct(g.prob)} for ${g.name}`;
    return { headline: truncate(text, 80), action: 'Update your framing before the wires do and line up a source for each outcome.' };
  }
  if (F.type === 'insight' && F.target.type === 'divergence') return { headline: truncate(`Venues disagree on ${display}`, 80), action: 'Note the gap between Polymarket and Kalshi; it often closes when news lands.' };
  if (decisiveFor(F)) return { headline: truncate(`${F.binary ? stateText(F) : `${F.lead.name} ~${pct(F.lead.prob)}`} — prep the result story`, 80), action: 'Have the lede and art ready; the outcome is close to settled.' };
  if (g && F.move) return { headline: truncate(`${F.binary ? (F.S.yes ? `${display}: ${F.S.yes}` : display) : g.name} odds ${moveText(F)} to ${pct(F.binary && F.S.yes ? F.p : g.prob)}${F.binary && !F.S.yes ? ` ${g.name}` : ''} — find the catalyst`, 80), action: 'Check wires, socials and officials for what moved it; the crowd may be ahead of the news.' };
  if (nearEven(F.p)) return { headline: truncate(`Draft both versions: ${display} is at ${pct(F.p)}`, 80), action: 'Keep both ledes ready; the market sees it as a toss-up.' };
  return { headline: truncate(headState(F), 80), action: 'Background only for now; no fresh shift.' };
}

function general(F) {
  const g = gainer(F);
  const { display } = F;
  if (F.type === 'volatility') {
    const vr = F.volRatio !== null ? ` (${F.volRatio.toFixed(1)}× normal volatility)` : '';
    return { headline: `Market just started thrashing${vr} — something is developing`, action: `Keep an eye on ${truncate(display, 50)}; the crowd is reacting to something.` };
  }
  if (F.game?.situation && F.game.live) return { headline: truncate(`${display}: ${F.game.situation}`, 80), action: `${F.lead.name} ${pct(F.lead.prob)}; worth watching now.` };
  if (g && F.move) return { headline: truncate(`${stateText(F, g)} (${moveText(F)}) — something just happened`, 80), action: F.crossed ? 'The favorite just changed; worth a look.' : 'Worth a look; the odds moved fast.' };
  if (F.type === 'shot' && F.target.headline) return { headline: truncate(F.target.headline, 80), action: F.target.tips?.general || 'Worth watching now.' };
  if (F.type === 'insight' && F.target.title) return { headline: truncate(F.target.title, 80), action: truncate(F.target.body || 'Worth a look.', 120) };
  return { headline: truncate(headState(F), 80), action: 'Worth keeping an eye on.' };
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const poss = (s) => (/s$/i.test(s) ? `${s}'` : `${s}'s`);
const BY_ROLE = { photographer, trader, fan, journalist, general };

/** Deterministic recommendation for one role. Never throws. */
export function recommendRules(target = {}, ctx = {}) {
  const role = ROLES.includes(ctx.role) ? ctx.role : 'general';
  let F;
  try {
    F = facts(target || {}, { ...ctx, role });
    F.target = target || {};
    const { headline, action } = BY_ROLE[role](F);
    const rec = {
      role,
      headline: truncate(headline, 80),
      action: truncate(action, 160),
      confidence: confidenceOf(F, role),
      reasoning: reasoning(F),
      source: 'rules',
    };
    if (role === 'trader') rec.disclaimer = TRADER_DISCLAIMER;
    return rec;
  } catch (e) {
    const rec = {
      role,
      headline: truncate(target?.title || target?.headline || ctx.market?.title || 'Market moving', 80),
      action: 'Worth a look.',
      confidence: 'low',
      reasoning: [],
      source: 'rules',
    };
    if (role === 'trader') rec.disclaimer = TRADER_DISCLAIMER;
    return rec;
  }
}

/** Rules recommendation for every role: {[role]: Recommendation}. */
export function recommendAllRoles(target, ctx = {}) {
  const out = {};
  for (const role of ROLES) out[role] = recommendRules(target, { ...ctx, role });
  return out;
}
