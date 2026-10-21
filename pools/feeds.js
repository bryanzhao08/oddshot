// Game feeds that produce engine snapshots: live ESPN polling, and replays of finished games
// (ESPN summary JSON) so the demo works when nothing is on.

import { soccerTimeline, basketballTimeline, basketballElapsed } from './models.js';

const BASE = 'https://site.web.api.espn.com/apis/site/v2/sports';
export const LEAGUES = {
  nfl: ['football', 'nfl'], cfb: ['football', 'college-football'], nba: ['basketball', 'nba'], wnba: ['basketball', 'wnba'],
  epl: ['soccer', 'eng.1'], laliga: ['soccer', 'esp.1'], seriea: ['soccer', 'ita.1'], bundesliga: ['soccer', 'ger.1'],
  ligue1: ['soccer', 'fra.1'], mls: ['soccer', 'usa.1'], ucl: ['soccer', 'uefa.champions'],
};

const clockSecs = (s) => {
  if (!s) return null;
  const p = String(s).split(':').map(Number);
  return p.length === 2 ? p[0] * 60 + p[1] : Number.isFinite(p[0]) ? p[0] : null;
};

function teamsFrom(comps) {
  const sorted = [...comps].sort((a, b) => (a.homeAway === 'home' ? -1 : 1) - (b.homeAway === 'home' ? -1 : 1));
  return sorted.map((c) => ({ id: String(c.team?.id ?? c.id), abbr: c.team?.abbreviation, name: c.team?.shortDisplayName || c.team?.displayName || c.team?.name }));
}

// ---------------------------------------------------------------- live

export class LiveFeed {
  constructor(leagueKeys) {
    this.leagues = leagueKeys.map((k) => [k, ...(LEAGUES[k] || [])]).filter((x) => x[1]);
    this.drives = new Map(); // gameId -> {offense, n}
  }

  async #json(url) {
    const r = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!r.ok) throw new Error(`ESPN ${r.status}`);
    return r.json();
  }

  /** One poll: snapshots for every in-progress game in the configured leagues. */
  async poll() {
    const out = [];
    await Promise.all(this.leagues.map(async ([, sport, league]) => {
      let board;
      try { board = await this.#json(`${BASE}/${sport}/${league}/scoreboard`); } catch { return; }
      for (const ev of board.events || []) {
        const c = ev.competitions?.[0];
        const state = c?.status?.type?.state;
        if (state !== 'in') continue;
        try { out.push(await this.#snapshot(sport, league, ev, c)); } catch { /* skip one bad game */ }
      }
    }));
    return out;
  }

  async #snapshot(sport, league, ev, c) {
    const teams = teamsFrom(c.competitors || []);
    const homeFirst = [...c.competitors].sort((a, b) => (a.homeAway === 'home' ? -1 : 1) - (b.homeAway === 'home' ? -1 : 1));
    const scores = homeFirst.map((x) => Number(x.score) || 0);
    const period = c.status?.period ?? 0, clock = c.status?.displayClock;
    const snap = { id: String(ev.id), sport, league, name: ev.shortName || ev.name, status: 'in', teams, scores, period,
      clockSeconds: clockSecs(clock), clockLabel: c.status?.type?.shortDetail || clock, t: Date.now() };
    if (sport === 'football') {
      const s = c.situation || {};
      const off = teams.findIndex((t) => t.id === String(s.possession));
      if (off >= 0 && s.down >= 1) {
        let yte = null;
        const m = /^(\S+)\s+(\d+)$/.exec(s.possessionText || '');
        if (m) yte = m[1] === teams[off].abbr ? 100 - Number(m[2]) : Number(m[2]);
        else if (/50/.test(s.possessionText || '')) yte = 50;
        const d = this.drives.get(snap.id);
        const n = !d ? 0 : d.offense === off ? d.n : d.n + 1;
        this.drives.set(snap.id, { offense: off, n });
        snap.drive = { id: `${snap.id}:${n}`, offense: off, down: s.down, distance: s.distance, yardsToEndzone: yte,
          goalToGo: /goal/i.test(s.downDistanceText || ''), text: s.downDistanceText, timeouts: [s.homeTimeouts, s.awayTimeouts] };
      } else snap.drive = null;
    } else if (sport === 'soccer') {
      const sum = await this.#json(`${BASE}/${sport}/${league}/summary?event=${ev.id}`);
      const mins = String(clock || '').replace(/'/g, '').split('+').map(Number).filter(Number.isFinite);
      snap.minute = mins.reduce((a, b) => a + b, 0);
      snap.soccer = { timeline: soccerTimeline(sum) };
    } else if (sport === 'basketball') {
      const sum = await this.#json(`${BASE}/${sport}/${league}/summary?event=${ev.id}`);
      snap.elapsed = basketballElapsed(period, clock);
      snap.basketball = { timeline: basketballTimeline(sum) };
    }
    return snap;
  }
}

// ---------------------------------------------------------------- replay

/** Turn a finished game's ESPN summary into an ordered list of snapshots. */
export function replaySnapshots(sport, summary) {
  const comp = summary.header?.competitions?.[0] || {};
  const teams = teamsFrom(comp.competitors || []);
  const id = String(summary.header?.id || comp.id || 'replay');
  const nameStr = `${teams[1]?.abbr || teams[1]?.name} @ ${teams[0]?.abbr || teams[0]?.name}`;
  const base = { id: `replay-${id}`, sport, league: 'replay', name: nameStr, teams, status: 'in' };
  const out = [];
  if (sport === 'football') {
    let scores = [0, 0];
    const drives = summary.drives?.previous || [];
    for (const dr of drives) {
      for (const pl of dr.plays || []) {
        const st = pl.start || {};
        const off = teams.findIndex((t) => t.id === String(st.team?.id ?? dr.team?.id));
        const period = pl.period?.number ?? 1;
        const clock = pl.clock?.displayValue;
        out.push({ ...base, scores: [...scores], period, clockSeconds: clockSecs(clock), clockLabel: `Q${period} ${clock}`,
          drive: off >= 0 && st.down >= 1 ? { id: String(dr.id), offense: off, down: st.down, distance: st.distance,
            yardsToEndzone: st.yardsToEndzone, goalToGo: /goal/i.test(st.downDistanceText || ''), text: st.downDistanceText } : null,
          play: pl.text });
        scores = [Number(pl.homeScore) || scores[0], Number(pl.awayScore) || scores[1]];
      }
    }
    out.push({ ...base, status: 'post', scores, period: 4, clockSeconds: 0, clockLabel: 'Final', drive: null });
  } else if (sport === 'soccer') {
    const tl = soccerTimeline(summary);
    const end = Math.max(90, ...tl.map((e) => Math.ceil(e.min)));
    for (let m = 0; m <= end; m++) {
      const past = tl.filter((e) => e.min <= m);
      const g = (side) => past.filter((e) => e.kind === 'goal' && e.team === side).length;
      out.push({ ...base, scores: [g('home'), g('away')], period: m > 45 ? 2 : 1, minute: m, clockLabel: `${m}'`, soccer: { timeline: past } });
    }
    out.push({ ...out[out.length - 1], status: 'post', clockLabel: 'Full time' });
  } else if (sport === 'basketball') {
    const tl = basketballTimeline(summary);
    const end = Math.max(2880, ...tl.map((e) => e.sec));
    for (let t = 0; t <= end; t += 15) {
      const past = tl.filter((e) => e.sec <= t);
      const last = past[past.length - 1] || { home: 0, away: 0 };
      const period = t < 2880 ? Math.floor(t / 720) + 1 : 5 + Math.floor((t - 2880) / 300);
      const left = t < 2880 ? 720 - (t % 720) : 300 - ((t - 2880) % 300);
      out.push({ ...base, scores: [last.home, last.away], period, elapsed: t, clockSeconds: left,
        clockLabel: `Q${period} ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`, basketball: { timeline: past } });
    }
    out.push({ ...out[out.length - 1], status: 'post', clockLabel: 'Final' });
  }
  return out.map((s, i) => ({ ...s, t: i }));
}
