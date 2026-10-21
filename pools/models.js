// In-game sport models (soccer / football / basketball), a JavaScript port of
// ios/Tipoff/Engine/SportModels.swift (which mirrors ml/sports/*_data.py).
// Plain ESM, zero dependencies, browser-safe: pass in already-parsed JSON.

// ---------------------------------------------------------------------------
// Tree ensembles + calibration (matches Forecaster.swift TreeEnsemble / Calibration)

function buildEnsemble(raw, nFeatures) {
  const trees = raw && raw.trees;
  if (!Array.isArray(trees) || trees.length === 0) throw new Error('ensemble has no trees');
  let total = 0;
  for (const t of trees) total += t.f.length;
  const roots = new Int32Array(trees.length);
  const feat = new Int32Array(total), yes = new Int32Array(total), no = new Int32Array(total), miss = new Int32Array(total);
  const thr = new Float64Array(total), value = new Float64Array(total);
  let off = 0;
  trees.forEach((t, ti) => {
    const c = t.f.length;
    if (!(c > 0 && t.t.length === c && t.y.length === c && t.n.length === c && t.m.length === c && t.v.length === c)) {
      throw new Error(`tree ${ti}: ragged arrays`);
    }
    roots[ti] = off;
    for (let i = 0; i < c; i++) {
      const f = t.f[i];
      if (f >= 0) {
        // Children must be in range and strictly after the parent (guarantees termination).
        if (!(f < nFeatures && t.y[i] > i && t.y[i] < c && t.n[i] > i && t.n[i] < c && t.m[i] > i && t.m[i] < c)) {
          throw new Error(`tree ${ti} node ${i}: bad split`);
        }
      }
      const k = off + i;
      feat[k] = f;
      thr[k] = t.t[i];
      yes[k] = off + Math.max(t.y[i], 0);
      no[k] = off + Math.max(t.n[i], 0);
      miss[k] = off + Math.max(t.m[i], 0);
      value[k] = t.v[i];
    }
    off += c;
  });
  const baseMargin = raw.base_margin;
  return function margin(x) {
    let m = baseMargin;
    for (let r = 0; r < roots.length; r++) {
      let i = roots[r];
      while (feat[i] >= 0) {
        const v = x[feat[i]];
        if (Number.isNaN(v)) i = miss[i];
        else i = Math.fround(v) < thr[i] ? yes[i] : no[i];
      }
      m += value[i];
    }
    return m;
  };
}

function buildCalibration(r) {
  if (!r) return (p) => p;
  if (r.type === 'platt' && typeof r.a === 'number' && typeof r.b === 'number') {
    const { a, b } = r;
    return (raw) => {
      const p = Math.min(Math.max(raw, 1e-7), 1 - 1e-7);
      return 1 / (1 + Math.exp(a * Math.log(p / (1 - p)) + b));
    };
  }
  if (r.type === 'isotonic' && Array.isArray(r.x) && Array.isArray(r.y) && r.x.length > 0 && r.x.length === r.y.length) {
    const x = r.x, y = r.y;
    return (raw) => {
      if (raw <= x[0]) return y[0];
      if (raw >= x[x.length - 1]) return y[y.length - 1];
      let lo = 0, hi = x.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (x[mid] <= raw) lo = mid; else hi = mid;
      }
      const span = x[hi] - x[lo];
      return span > 0 ? y[lo] + ((raw - x[lo]) * (y[hi] - y[lo])) / span : y[lo];
    };
  }
  return (p) => p;
}

const num = (v) => (typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : undefined);

/** Load a "tipoff-sport-v1" model from parsed JSON. Throws on malformed trees. */
export function loadSportModel(json) {
  if (!json || !Array.isArray(json.features) || !json.models) throw new Error('not a sport model');
  const features = json.features.slice();
  const n = features.length;
  const names = Object.keys(json.models);
  const ens = names.map((name) => {
    const r = json.models[name];
    return { name, margin: buildEnsemble(r, n), cal: buildCalibration(r.calibration) };
  });
  const metrics = json.metrics || {};
  const baseRate = {};
  for (const name of names) {
    const nested = metrics[name] && typeof metrics[name] === 'object' ? num(metrics[name].base_rate) : undefined;
    const v = num(metrics[`base_rate_${name}`]) ?? num(metrics.base_rate) ?? nested;
    if (v !== undefined) baseRate[name] = v;
  }
  const x = new Float64Array(n);
  return {
    sport: json.sport,
    features,
    baseRate,
    /** Calibrated probability per model from a feature object (missing / null / NaN -> missing). */
    predict(f) {
      for (let i = 0; i < n; i++) {
        const v = f ? f[features[i]] : undefined;
        x[i] = typeof v === 'number' ? v : NaN;
      }
      const out = {};
      for (const e of ens) out[e.name] = e.cal(1 / (1 + Math.exp(-e.margin(x))));
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Small helpers mirroring Swift/Foundation behavior

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const obj = (v) => (isObj(v) ? v : undefined);
const str = (v) => (typeof v === 'string' ? v : undefined);
// Swift String(n) / NSNumber.stringValue for an id.
const idString = (v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined);
// Swift Double(String): strict, no surrounding whitespace.
function parseDouble(s) {
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return Number(s);
  if (/^[+-]?(inf|infinity)$/i.test(s)) return s.startsWith('-') ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(s)) return NaN;
  return undefined;
}
// Swift split(separator:) drops empty pieces.
const splitNonEmpty = (s, sep) => s.split(sep).filter((p) => p.length > 0);

// ---------------------------------------------------------------------------
// Soccer (mirrors ml/sports/soccer_data.py)

const normName = (s) => s.split(/\s+/u).filter(Boolean).join(' ').toLowerCase();

function firstMatch(re, s) {
  const m = re.exec(s);
  return m && m[1] !== undefined ? m[1] : undefined;
}

function parens(s) {
  const out = [];
  for (const m of s.matchAll(/\(([^)]+)\)/g)) out.push(m[1]);
  return out;
}

export function shotZone(text) {
  const t = text.toLowerCase();
  if (t.includes('very close range') || t.includes('six yard box')) return 'close';
  if (t.includes('centre of the box') || t.includes('side of the box')) return 'box';
  return 'out';
}

function stableSortBy(arr, key) {
  return arr.map((e, i) => [e, i]).sort((a, b) => key(a[0]) - key(b[0]) || a[1] - b[1]).map((p) => p[0]);
}

/** ESPN soccer summary -> normalized timeline [{min, team, kind, zone?}]. */
export function soccerTimeline(summary) {
  const comps = obj(summary?.header)?.competitions;
  const first = Array.isArray(comps) ? obj(comps[0]) : undefined;
  const competitors = Array.isArray(first?.competitors) ? first.competitors : [];
  const names = new Map(); // normalized name -> side
  for (const c of competitors) {
    if (!isObj(c)) continue;
    const side = str(c.homeAway);
    const n = str(obj(c.team)?.displayName);
    if (side && (side === 'home' || side === 'away') && n !== undefined) names.set(normName(n), side);
  }
  if (names.size !== 2) return [];
  const match = (n) => (n === undefined ? undefined : names.get(normName(n)));
  const firstParen = (body) => {
    for (const p of parens(body)) { const s = match(p); if (s) return s; }
    return undefined;
  };
  const out = [];
  const seen = new Set();
  const commentary = Array.isArray(summary.commentary) ? summary.commentary : [];
  for (const item of commentary) {
    if (!isObj(item)) continue;
    const play = obj(item.play) || {};
    const typ = (str(obj(play.type)?.text) ?? '').replace(/^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu, '').toLowerCase();
    let kind, own = false;
    if (typ.startsWith('own goal')) { kind = 'goal'; own = true; }
    else if (typ.startsWith('goal') || typ.startsWith('penalty - scored')) kind = 'goal';
    else if (typ.startsWith('shot on target') || typ.startsWith('saved')) kind = 'shot_on_target';
    else if (typ.startsWith('shot')) kind = 'shot';
    else if (typ.startsWith('corner awarded')) kind = 'corner';
    else if (typ.includes('red card')) kind = 'red';
    else continue;
    const secs = num(obj(item.time)?.value);
    if (secs === undefined || !(secs >= 0)) continue;
    const minute = secs / 60;
    const playId = idString(play.id);
    if (playId !== undefined && seen.has(playId)) continue;
    const body = str(item.text) ?? str(play.text) ?? '';
    const playTeam = str(obj(play.team)?.displayName);
    let side;
    if (kind === 'corner') {
      // play.team on corners is the side that conceded it; the text names who won it.
      side = match(firstMatch(/\bCorner,\s*(.+?)\s*\./i, body));
      if (side === undefined) continue;
    }
    if (own) {
      side = match(playTeam);
      if (side === undefined) {
        const conceder = match(firstMatch(/Own Goal by .+?,\s*(.+?)\./i, body));
        if (conceder !== undefined) side = conceder === 'home' ? 'away' : 'home';
      }
    }
    if (side === undefined && kind === 'goal' && !own) side = firstParen(body);
    if (side === undefined) side = match(playTeam);
    if (side === undefined) side = firstParen(body);
    if (side === undefined) continue;
    if (playId !== undefined) seen.add(playId);
    const isShot = (kind === 'shot' || kind === 'shot_on_target' || kind === 'goal') && !own;
    const ev = { min: minute, team: side, kind };
    if (isShot) ev.zone = shotZone(body);
    out.push(ev);
  }
  return stableSortBy(out, (e) => e.min);
}

/** Feature object for `team` ('home'|'away') at minute `t` (soccer_data.features). */
export function soccerFeatures(tl, us, t) {
  const them = us === 'home' ? 'away' : 'home';
  const past = tl.filter((e) => e.min <= t);
  const count = (side, kind, window) => past.filter((e) =>
    e.team === side
    && (e.kind === kind || (kind === 'shot' && (e.kind === 'shot_on_target' || e.kind === 'goal')) || (kind === 'shot_on_target' && e.kind === 'goal'))
    && (window === undefined || e.min > t - window)).length;
  const zones = (side, z, window) => past.filter((e) =>
    e.team === side && e.zone !== undefined && e.zone !== null && z.includes(e.zone)
    && (window === undefined || e.min > t - window)).length;
  const goals = past.filter((e) => e.kind === 'goal').map((e) => e.min);
  const ourShots = past.filter((e) => e.team === us && (e.kind === 'shot' || e.kind === 'shot_on_target' || e.kind === 'goal')).map((e) => e.min);
  const gu = count(us, 'goal'), gt = count(them, 'goal');
  return {
    minute: t, is_home: us === 'home' ? 1 : 0, goal_diff: gu - gt, goals_us: gu, goals_them: gt,
    red_us: count(us, 'red'), red_them: count(them, 'red'),
    shots_us: count(us, 'shot'), shots_them: count(them, 'shot'),
    sot_us: count(us, 'shot_on_target'), sot_them: count(them, 'shot_on_target'),
    corners_us: count(us, 'corner'), corners_them: count(them, 'corner'),
    shots_us_10: count(us, 'shot', 10), shots_them_10: count(them, 'shot', 10),
    sot_us_10: count(us, 'shot_on_target', 10), sot_them_10: count(them, 'shot_on_target', 10),
    corners_us_10: count(us, 'corner', 10), corners_them_10: count(them, 'corner', 10),
    shots_us_5: count(us, 'shot', 5), sot_us_5: count(us, 'shot_on_target', 5),
    corners_us_5: count(us, 'corner', 5),
    mins_since_goal: goals.length ? t - Math.max(...goals) : t,
    mins_since_our_shot: ourShots.length ? t - Math.max(...ourShots) : t,
    second_half: t > 45 ? 1 : 0,
    box_shots_us_10: zones(us, ['box', 'close'], 10), box_shots_them_10: zones(them, ['box', 'close'], 10),
    close_shots_us_10: zones(us, ['close'], 10),
    box_shots_us: zones(us, ['box', 'close']), box_shots_them: zones(them, ['box', 'close']),
  };
}

// ---------------------------------------------------------------------------
// Football

function clockFeatures(period, clockSeconds) {
  const q = period;
  const clock = clockSeconds ?? 0;
  const half = q <= 4 ? clock + ((q === 1 || q === 3) ? 900 : 0) : clock;
  const game = q <= 4 ? clock + (4 - q) * 900 : clock;
  return { qtr: Math.min(q, 5), half_seconds_remaining: half, game_seconds_remaining: game };
}

const numOrNaN = (v) => num(v) ?? NaN;

/**
 * From ESPN's scoreboard situation. Returns null when there's no possession (kickoffs, breaks).
 * game: { teamIds:[home,away], abbrs:[home,away], period, clockSeconds, scores:[home,away] }
 */
export function footballFeatures(s, game) {
  if (!isObj(s)) return null;
  const posId = idString(s.possession);
  if (posId === undefined) return null;
  const off = (game.teamIds || []).findIndex((id) => String(id) === posId);
  if (off < 0) return null;
  const down = num(s.down);
  if (down === undefined || !(down >= 1 && down <= 4)) return null;
  const dist = numOrNaN(s.distance);
  // "KC 35": own side -> 100 - 35 to go, opponent side -> 35 to go.
  let yl100 = NaN;
  const pt = str(s.possessionText);
  if (pt !== undefined) {
    const parts = splitNonEmpty(pt, ' ');
    const n = parts.length === 2 ? parseDouble(parts[1]) : undefined;
    if (n !== undefined) yl100 = parts[0] === game.abbrs[off] ? 100 - n : n;
    else if (pt.includes('50')) yl100 = 50;
  }
  if (Number.isNaN(yl100)) return null;
  const goal = (str(s.downDistanceText) ?? '').toLowerCase().includes('goal') || dist >= yl100;
  const scores = game.scores || [];
  const a = scores[off], b = scores[1 - off];
  const diff = typeof a === 'number' && typeof b === 'number' ? a - b : NaN;
  const to = [numOrNaN(s.homeTimeouts), numOrNaN(s.awayTimeouts)];
  return {
    features: {
      yardline_100: yl100, down, ydstogo: dist, goal_to_go: goal ? 1 : 0,
      ...clockFeatures(game.period, game.clockSeconds),
      score_differential: diff,
      posteam_timeouts_remaining: to[off], defteam_timeouts_remaining: to[1 - off],
    },
    offense: off,
  };
}

/**
 * Features from an ESPN summary play.start ({down, distance, yardsToEndzone, downDistanceText}),
 * for replaying drives. ctx: {period, clockSeconds, offenseIsHome, scoreOffense, scoreDefense,
 * timeoutsOffense, timeoutsDefense}. Returns null when down/field position are unusable.
 */
export function footballFeaturesFromPlayStart(start, ctx) {
  if (!isObj(start)) return null;
  const down = num(start.down);
  if (down === undefined || !(down >= 1 && down <= 4)) return null;
  const yl100 = num(start.yardsToEndzone);
  if (yl100 === undefined || Number.isNaN(yl100)) return null;
  const dist = numOrNaN(start.distance);
  const goal = (str(start.downDistanceText) ?? '').toLowerCase().includes('goal') || dist >= yl100;
  const so = ctx.scoreOffense, sd = ctx.scoreDefense;
  return {
    yardline_100: yl100, down, ydstogo: dist, goal_to_go: goal ? 1 : 0,
    ...clockFeatures(ctx.period, ctx.clockSeconds),
    score_differential: typeof so === 'number' && typeof sd === 'number' ? so - sd : NaN,
    posteam_timeouts_remaining: numOrNaN(ctx.timeoutsOffense),
    defteam_timeouts_remaining: numOrNaN(ctx.timeoutsDefense),
  };
}

// ---------------------------------------------------------------------------
// Basketball (mirrors ml/sports/basketball_data.py)

/** Game seconds elapsed for a period and "MM:SS" / "SS.s" clock; null when invalid. */
export function basketballElapsed(period, clock) {
  const p = splitNonEmpty(String(clock), ':').map(parseDouble).filter((v) => v !== undefined);
  const left = p.length === 2 ? p[0] * 60 + p[1] : p[0];
  if (left === undefined) return null;
  const length = period <= 4 ? 720 : 300;
  if (!(period >= 1 && left >= 0 && left <= length)) return null;
  return (period <= 4 ? (period - 1) * 720 : 2880 + (period - 5) * 300) + (length - left);
}

const intOf = (v) => {
  if (typeof v === 'number') return Math.trunc(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && /^[+-]?\d+$/.test(v)) return parseInt(v, 10);
  return undefined;
};

/** ESPN summary plays -> score-changing timeline [{sec, home, away}]. */
export function basketballTimeline(summary) {
  const out = [];
  let ph = 0, pa = 0;
  const plays = Array.isArray(summary?.plays) ? summary.plays : [];
  for (const p of plays) {
    if (!isObj(p)) continue;
    if (!(p.scoringPlay === true || p.scoringPlay === 1)) continue;
    const pn = num(obj(p.period)?.number);   // NSNumber.intValue (no string parsing)
    const per = pn === undefined ? undefined : Math.trunc(pn);
    if (per === undefined) continue;
    const clock = str(obj(p.clock)?.displayValue);
    if (clock === undefined) continue;
    const sec = basketballElapsed(per, clock);
    if (sec === null) continue;
    const h = intOf(p.homeScore), a = intOf(p.awayScore);
    if (h === undefined || a === undefined) continue;
    if ((h === ph && a === pa) || h < ph || a < pa) continue;
    out.push({ sec: Math.round(sec * 100) / 100, home: h, away: a });
    ph = h; pa = a;
  }
  return stableSortBy(out, (e) => e.sec);
}

function scoresAt(tl, at) {
  let h = 0, a = 0;
  for (const e of tl) { if (e.sec > at) break; h = e.home; a = e.away; }
  return [h, a];
}

/** Leader-perspective features at game second `at` (basketball_data.features_at). Null when tied. */
export function basketballFeatures(tl, at) {
  const [home, away] = scoresAt(tl, at);
  if (home === away) return null;
  const lh = home > away;
  const p2 = scoresAt(tl, at - 120), p5 = scoresAt(tl, at - 300);
  const [l2, t2] = lh ? [home - p2[0], away - p2[1]] : [away - p2[1], home - p2[0]];
  const [l5, t5] = lh ? [home - p5[0], away - p5[1]] : [away - p5[1], home - p5[0]];
  let run = 0, ph = 0, pa = 0;
  for (const e of tl) {
    if (e.sec > at) break;
    const dl = lh ? e.home - ph : e.away - pa, dt = lh ? e.away - pa : e.home - ph;
    if (dl !== 0) run = 0;
    run += dt;
    ph = e.home; pa = e.away;
  }
  const a = Math.trunc(at);
  const period = a < 2880 ? Math.trunc(a / 720) + 1 : 5 + Math.trunc((a - 2880) / 300);
  const left = a < 2880 ? 720 - (a % 720) : 300 - ((a - 2880) % 300);
  return {
    period, sec_left_regulation: 2880 - at, sec_left_period: left,
    lead: Math.abs(home - away), pts_leader_2m: l2, pts_trailer_2m: t2,
    pts_leader_5m: l5, pts_trailer_5m: t5, run_trailer: run,
    total_points: home + away,
  };
}
