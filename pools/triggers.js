// When to open a pool, and how it settles. One trigger + one resolver per pool kind.
// Triggers use the in-game XGBoost models when loaded (ml/sports, thresholds from REPORT.md)
// and fall back to simple game-situation rules otherwise.

import { soccerFeatures, basketballFeatures } from './models.js';

const pct = (p) => `${Math.round(p * 100)}%`;
const name = (snap, i) => snap.teams[i].abbr || snap.teams[i].name;

// ---------------------------------------------------------------- football

function footballFeatures(snap) {
  const d = snap.drive;
  if (!d || !(d.down >= 1 && d.down <= 4) || !(d.yardsToEndzone > 0)) return null;
  const q = Math.min(snap.period, 5), clock = snap.clockSeconds ?? 0;
  const half = q <= 4 ? clock + (q === 1 || q === 3 ? 900 : 0) : clock;
  const game = q <= 4 ? clock + (4 - q) * 900 : clock;
  const off = d.offense;
  return {
    yardline_100: d.yardsToEndzone, down: d.down, ydstogo: d.distance ?? NaN,
    goal_to_go: d.goalToGo || d.distance >= d.yardsToEndzone ? 1 : 0, qtr: q,
    half_seconds_remaining: half, game_seconds_remaining: game,
    score_differential: snap.scores[off] - snap.scores[1 - off],
    posteam_timeouts_remaining: d.timeouts?.[off] ?? NaN, defteam_timeouts_remaining: d.timeouts?.[1 - off] ?? NaN,
  };
}

const footballDrive = (snap, hist, models) => {
  const d = snap.drive;
  // Needs a real field position (kickoffs and some plays come without one).
  if (!d || !Number.isFinite(d.yardsToEndzone) || d.yardsToEndzone <= 0 || d.yardsToEndzone > 40) return null;
  const f = footballFeatures(snap);
  const p = f && models?.football ? models.football.predict(f) : null;
  const td = p?.td_drive;
  // Open when the model likes a touchdown, or (no model) once they reach the 30.
  if (td != null ? td < 0.42 : d.yardsToEndzone > 30) return null;
  const team = name(snap, d.offense);
  return {
    kind: 'football_drive', key: `drive:${d.id ?? `${d.offense}:${snap.period}`}`,
    question: `${team} drive: touchdown, field goal, or no points?`,
    options: ['Touchdown', 'Field goal', 'No points'],
    chance: td ?? null,
    why: `${d.text || `${d.down} & ${d.distance}, ${d.yardsToEndzone} yards out`}${td != null ? `. Model: ${pct(td)} touchdown` : ''}`,
    state: { offense: d.offense, driveId: d.id ?? null, scores: [...snap.scores] },
  };
};

function settleFootballDrive(pool, snap) {
  const s = pool.state, off = s.offense;
  const dOff = snap.scores[off] - s.scores[off], dDef = snap.scores[1 - off] - s.scores[1 - off];
  if (dOff >= 6) return 0;
  if (dOff >= 3) return 1;
  if (dDef > 0) return 2;
  const changed = !snap.drive || snap.drive.offense !== off || (s.driveId != null && snap.drive.id != null && snap.drive.id !== s.driveId);
  if (changed || snap.status === 'post') return 2;
  return undefined;
}

// ---------------------------------------------------------------- soccer

const soccerGoal10 = (snap, hist, models) => {
  const m = snap.minute;
  if (!(m >= 5 && m <= 80)) return null;
  const tl = snap.soccer?.timeline || [];
  let best = null;
  if (models?.soccer) {
    for (const [i, side] of [[0, 'home'], [1, 'away']]) {
      const p = models.soccer.predict(soccerFeatures(tl, side, m)).goal_next_10m;
      if (!best || p > best.p) best = { i, p };
    }
    if (best.p < 0.22) return null;
  } else {
    // Fallback: a team with 3+ shots or corners in the last 5 minutes.
    for (const [i, side] of [[0, 'home'], [1, 'away']]) {
      const n = tl.filter((e) => e.team === side && e.min > m - 5 && e.min <= m && e.kind !== 'red').length;
      if (n >= 3 && (!best || n > best.n)) best = { i, n, p: null };
    }
    if (!best) return null;
  }
  const team = name(snap, best.i);
  return {
    kind: 'soccer_goal10', key: `goal10:${Math.floor(m / 12)}`,
    question: 'Goal in the next 10 minutes?',
    options: [`Yes, ${name(snap, 0)}`, `Yes, ${name(snap, 1)}`, 'No goal'],
    chance: best.p,
    why: best.p != null ? `${team} pressing: ${pct(best.p)} chance they score (usually 15%)` : `${team} pressing`,
    state: { minute: m, scores: [...snap.scores] },
  };
};

function settleSoccerGoal10(pool, snap) {
  const s = pool.state;
  const dh = snap.scores[0] - s.scores[0], da = snap.scores[1] - s.scores[1];
  if (dh > 0 && da === 0) return 0;
  if (da > 0 && dh === 0) return 1;
  if (dh > 0 && da > 0) return 0; // both in one update: credit the earlier side unknown → home
  if (snap.minute > s.minute + 10 || snap.status === 'post') return 2;
  return undefined;
}

// ---------------------------------------------------------------- basketball

const basketballLeadChange = (snap, hist, models) => {
  const [h, a] = snap.scores, t = snap.elapsed;
  if (h === a || !(t >= 600) || t > 2880 - 120) return null;
  const tl = snap.basketball?.timeline || [];
  let p = null;
  if (models?.basketball) {
    const f = basketballFeatures(tl, Math.floor(t));
    if (!f) return null;
    p = models.basketball.predict(f).lead_change_3m;
    if (p < 0.5) return null;
  } else if (Math.abs(h - a) > 3 || snap.period < 4) return null;
  const trailer = h > a ? 1 : 0;
  return {
    kind: 'basketball_lead', key: `lead:${Math.floor(t / 240)}`,
    question: `${name(snap, trailer)} ties it or takes the lead in the next 3 minutes?`,
    options: ['Yes', 'No'], chance: p,
    why: `${name(snap, 0)} ${h}, ${name(snap, 1)} ${a}${p != null ? `. Model: ${pct(p)}` : ''}`,
    state: { elapsed: t, leader: h > a ? 0 : 1 },
  };
};

function settleBasketballLead(pool, snap) {
  const s = pool.state, [h, a] = snap.scores;
  const leader = h === a ? -1 : h > a ? 0 : 1;
  if (leader !== s.leader && snap.elapsed <= s.elapsed + 180) return 0;
  if (snap.elapsed > s.elapsed + 180 || snap.status === 'post') return 1;
  return undefined;
}

export const triggers = {
  football: [footballDrive],
  soccer: [soccerGoal10],
  basketball: [basketballLeadChange],
};

export const resolvers = {
  football_drive: settleFootballDrive,
  soccer_goal10: settleSoccerGoal10,
  basketball_lead: settleBasketballLead,
};

export const _internal = { footballFeatures };
