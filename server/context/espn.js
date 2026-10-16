// Browser-compatible ESPN public scoreboard reader. No credentials or dependencies.

// site.web.api.espn.com serves the same JSON and, unlike site.api.espn.com, works from browsers (GitHub Pages mode).
export const ESPN_BASE_URL = 'https://site.web.api.espn.com/apis/site/v2/sports';

export const SUPPORTED_LEAGUES = Object.freeze([
  { sport: 'football', league: 'nfl' },
  { sport: 'football', league: 'college-football' },
  { sport: 'basketball', league: 'nba' },
  { sport: 'basketball', league: 'wnba' },
  { sport: 'baseball', league: 'mlb' },
  { sport: 'hockey', league: 'nhl' },
  { sport: 'soccer', league: 'eng.1' },
  { sport: 'soccer', league: 'usa.1' },
  { sport: 'soccer', league: 'esp.1' },
  { sport: 'soccer', league: 'uefa.champions' },
  { sport: 'soccer', league: 'ita.1' },
  { sport: 'soccer', league: 'ger.1' },
  { sport: 'soccer', league: 'fra.1' },
  { sport: 'tennis', league: 'atp' },
  { sport: 'tennis', league: 'wta' },
]);

const CACHE_MS = 15_000;
const scoreboardCache = new Map();
const fetchIds = new WeakMap();
let nextFetchId = 1;

function fetchIdentity(fetchImpl) {
  if (!fetchIds.has(fetchImpl)) fetchIds.set(fetchImpl, nextFetchId++);
  return fetchIds.get(fetchImpl);
}

const text = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const firstText = (...values) => values.map(text).find(Boolean) || null;
const ordinal = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  const mod100 = v % 100;
  return `${v}${mod100 >= 11 && mod100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[v % 10] || 'th')}`;
};
const numberOrNull = (v) => v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v);

function normalizedTeam(competitor) {
  const team = competitor?.team || competitor || {};
  return {
    id: team.id || competitor?.id || null,
    name: firstText(team.name, team.shortDisplayName, team.displayName),
    displayName: firstText(team.displayName, team.name, team.shortDisplayName),
    abbreviation: firstText(team.abbreviation, team.shortDisplayName),
    city: firstText(team.location, team.shortName),
  };
}

function findSide(competitors, side) {
  return competitors.find((item) => item?.homeAway === side) || null;
}

function situationAndImminent({ sport, league, situation, event, competition, home, away }) {
  const s = situation || competition?.situation || {};
  const comp = competition || {};
  let value = null;
  let imminent = null;

  if (sport === 'football') {
    const down = numberOrNull(s.down);
    const distance = numberOrNull(s.distance ?? s.yardsToGo);
    const downText = firstText(s.downDistanceText, s.shortDownDistanceText, s.downDistance);
    const possessionId = s.possession?.id ?? s.possession;
    const possTeam = [home, away].find((team) => team.id && String(team.id) === String(possessionId));
    const possAbbr = firstText(s.possessionText, s.possessionTeam?.abbreviation, possTeam?.abbreviation);
    const yard = numberOrNull(s.yardLine ?? s.yardsToEndzone);
    const goal = /goal/i.test(downText || '') || s.isGoalToGo === true || s.goalToGo === true;
    if (downText) value = downText;
    else if (down != null) value = `${ordinal(down)} & ${goal ? 'Goal' : distance == null ? '—' : distance}`;
    if (value && yard != null && !/\bat\s+[A-Z]{2,4}\s+\d+\b/i.test(value)) {
      value += ` at ${possAbbr ? `${possAbbr} ` : ''}${yard}`;
    }
    if (s.isRedZone === true || s.redZone === true || (yard != null && yard <= 20)) {
      imminent = { type: 'touchdown', team: possAbbr, confidence: goal ? 0.68 : 0.55, text: goal ? 'Goal-to-go opportunity' : 'Red-zone possession' };
    }
  } else if (league === 'mlb' || sport === 'baseball') {
    const outs = numberOrNull(s.outs ?? comp.outs);
    const bases = [
      ['first', s.onFirst ?? s.onFirstBase ?? s.first],
      ['second', s.onSecond ?? s.onSecondBase ?? s.second],
      ['third', s.onThird ?? s.onThirdBase ?? s.third],
    ].filter(([, runner]) => runner === true || (runner != null && runner !== false && runner !== 0 && runner !== ''))
      .map(([base]) => base);
    const baseText = bases.length ? `Runner${bases.length > 1 ? 's' : ''} on ${bases.map((b) => ({ first: '1st', second: '2nd', third: '3rd' }[b])).join(' & ')}` : null;
    if (baseText || outs != null) value = [baseText, outs != null ? `${outs} out${outs === 1 ? '' : 's'}` : null].filter(Boolean).join(', ');
    if (bases.includes('second') || bases.includes('third')) {
      imminent = { type: 'run', team: firstText(s.battingTeam?.abbreviation, s.battingTeam?.shortDisplayName), confidence: bases.includes('third') ? 0.58 : 0.48, text: 'Runner in scoring position' };
    }
  } else if (sport === 'hockey') {
    const isPowerPlay = s.isPowerPlay === true || s.powerPlay === true || s.powerPlayTeam != null || s.advantage?.type === 'powerPlay';
    const ppTeam = firstText(s.powerPlayTeam?.abbreviation, s.powerPlayTeam?.shortDisplayName, s.team?.abbreviation, s.team?.shortDisplayName);
    if (isPowerPlay) {
      value = `Power play${ppTeam ? `, ${ppTeam}` : ''}`;
      imminent = { type: 'goal', team: ppTeam, confidence: 0.48, text: 'Power-play opportunity' };
    }
  } else if (sport === 'soccer') {
    const details = Array.isArray(comp.details) ? comp.details : (Array.isArray(event?.details) ? event.details : []);
    const recent = details.slice(-4).reverse().find((d) => /shot|corner/i.test(`${d?.type?.text || ''} ${d?.text || ''} ${d?.shortText || ''}`));
    if (recent) {
      const description = firstText(recent.text, recent.shortText, recent.type?.text, recent.type?.name);
      value = description;
      imminent = { type: /shot/i.test(`${recent?.type?.text || ''} ${description || ''}`) ? 'shot' : null, team: firstText(recent.team?.abbreviation, recent.team?.shortDisplayName), confidence: 0.35, text: description };
      if (!imminent.type) imminent = null;
    }
  } else if (sport === 'tennis') {
    const sets = (findSide(comp.competitors || [], 'home')?.linescores || []).map((x) => numberOrNull(x.value ?? x.displayValue));
    const awaySets = (findSide(comp.competitors || [], 'away')?.linescores || []).map((x) => numberOrNull(x.value ?? x.displayValue));
    const current = firstText(s.gameScore, s.score, s.point, s.pointScore);
    const scores = [home?.abbreviation || home?.name, sets.join('-'), away?.abbreviation || away?.name, awaySets.join('-')].filter(Boolean);
    value = [scores.join(' '), current].filter(Boolean).join(', ') || null;
    if (s.isBreakPoint === true || s.breakPoint === true) {
      const team = firstText(s.breakPointTeam?.abbreviation, s.breakPointTeam?.displayName);
      imminent = { type: 'break-point', team, confidence: 0.55, text: 'Break point' };
    }
  }
  return { situation: value, imminent };
}

function getLastPlay(event, competition) {
  const s = competition?.situation || {};
  const plays = Array.isArray(competition?.plays) ? competition.plays : (Array.isArray(event?.plays) ? event.plays : []);
  const latest = plays.length ? plays[plays.length - 1] : null;
  return firstText(
    s.lastPlay?.text, s.lastPlay, s.lastPlayText,
    competition?.lastPlay?.text, competition?.lastPlay,
    latest?.text, latest?.shortText,
    competition?.drives?.current?.description,
  );
}

export function normalizeScoreboard(data, { sport, league, now = Date.now() } = {}) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.events)) return [];
  const games = [];
  for (const event of data.events) {
    const competition = event?.competitions?.[0] || {};
    const competitors = Array.isArray(competition.competitors) ? competition.competitors : [];
    const homeComp = findSide(competitors, 'home') || competitors[0];
    const awayComp = findSide(competitors, 'away') || competitors[1];
    const home = normalizedTeam(homeComp);
    const away = normalizedTeam(awayComp);
    const type = competition.status?.type || event.status?.type || {};
    const state = type.state;
    const status = state === 'in' ? 'in' : state === 'post' || type.completed ? 'post' : 'pre';
    const clock = firstText(competition.status?.displayClock, event.status?.displayClock);
    const period = numberOrNull(competition.status?.period ?? event.status?.period);
    const scoreHome = numberOrNull(homeComp?.score);
    const scoreAway = numberOrNull(awayComp?.score);
    const rawSituation = competition.situation || event.situation || {};
    const { situation, imminent } = situationAndImminent({ sport, league, situation: rawSituation, event, competition, home, away });
    games.push({
      id: String(event.id || competition.id || `${league}-${event.date || games.length}`),
      eventId: event.id || competition.id || null,
      sport: sport || null,
      league: league || data.leagues?.[0]?.slug || data.leagues?.[0]?.abbreviation || null,
      leagueName: data.leagues?.[0]?.name || null,
      name: firstText(event.name, event.shortName),
      startTime: firstText(competition.date, event.date),
      homeTeam: home,
      awayTeam: away,
      teams: { home, away },
      status,
      clock,
      period,
      score: {
        home: scoreHome,
        away: scoreAway,
        homeTeam: home.displayName,
        awayTeam: away.displayName,
      },
      situation,
      imminent,
      lastPlay: getLastPlay(event, competition),
      source: 'espn',
      fetchedAt: new Date(now).toISOString(),
    });
  }
  return games;
}

export async function fetchScoreboard(sportOrLeague, leagueOrOptions, maybeOptions = {}) {
  // Accept both fetchScoreboard(sport, league, options) and the simpler
  // fetchScoreboard(league, options) form used by integrations.
  let sport = sportOrLeague;
  let league = leagueOrOptions;
  let options = maybeOptions;
  if (typeof leagueOrOptions === 'object' || leagueOrOptions == null) {
    options = leagueOrOptions || {};
    league = sportOrLeague;
    sport = SUPPORTED_LEAGUES.find((item) => item.league === league)?.sport;
  }
  const { fetchImpl = globalThis.fetch, now = Date.now() } = options || {};
  if (typeof fetchImpl !== 'function' || !sport || !league) return [];
  const key = `${fetchIdentity(fetchImpl)}:${sport}/${league}`;
  const cached = scoreboardCache.get(key);
  if (cached && now - cached.at < CACHE_MS) return cached.promise;
  const promise = (async () => {
    try {
      const response = await fetchImpl(`${ESPN_BASE_URL}/${encodeURIComponent(sport)}/${encodeURIComponent(league)}/scoreboard`);
      if (!response?.ok) return [];
      const data = await response.json();
      return normalizeScoreboard(data, { sport, league, now });
    } catch {
      return [];
    }
  })();
  scoreboardCache.set(key, { at: now, promise });
  return promise;
}

export async function fetchGames({ fetchImpl = globalThis.fetch, now = Date.now(), leagues = SUPPORTED_LEAGUES } = {}) {
  try {
    const configured = leagues.map((entry) => typeof entry === 'string'
      ? SUPPORTED_LEAGUES.find((item) => item.league === entry)
      : entry).filter((entry) => entry?.sport && entry?.league);
    const results = await Promise.all(configured.map(({ sport, league }) => fetchScoreboard(sport, league, { fetchImpl, now })));
    return results.flat();
  } catch {
    return [];
  }
}

// Convenient alias for callers that prefer to make the provider explicit.
export const fetchEspnGames = fetchGames;
