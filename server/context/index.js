import { getAssetContext, detectAssetSymbol } from './assets.js';

const LEAGUE_HINTS = [
  { keys: ['nfl', 'national football league'], league: 'football/nfl' },
  { keys: ['cfb', 'ncaa football', 'college football'], league: 'football/college-football' },
  { keys: ['nba'], league: 'basketball/nba' },
  { keys: ['wnba'], league: 'basketball/wnba' },
  { keys: ['mlb'], league: 'baseball/mlb' },
  { keys: ['nhl'], league: 'hockey/nhl' },
  { keys: ['uefa champions', 'champions league'], league: 'soccer/uefa.champions' },
  { keys: ['premier league', 'epl'], league: 'soccer/eng.1' },
  { keys: ['la liga', 'laliga'], league: 'soccer/esp.1' },
  { keys: ['serie a'], league: 'soccer/ita.1' },
  { keys: ['bundesliga'], league: 'soccer/ger.1' },
  { keys: ['ligue 1'], league: 'soccer/fra.1' },
  { keys: ['mls', 'major league soccer'], league: 'soccer/usa.1' },
  { keys: ['atp', 'tennis men'], league: 'tennis/atp' },
  { keys: ['wta', 'tennis women'], league: 'tennis/wta' },
];

function asText(value) {
  return typeof value === 'string' ? value : '';
}

function marketText(market) {
  const values = [market?.title, market?.question, market?.category];
  if (Array.isArray(market?.tags)) values.push(...market.tags);
  else if (typeof market?.tags === 'string') values.push(market.tags);
  return values.filter((value) => typeof value === 'string').join(' ').toLowerCase();
}

function boundedContains(text, value) {
  const candidate = asText(value).trim().toLowerCase();
  if (!candidate || candidate.length < 2) return false;
  const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'i').test(text);
}

function teamAliases(team) {
  if (!team || typeof team !== 'object') return [];
  const aliases = [team.name, team.displayName, team.shortName, team.abbreviation, team.city, team.location];
  return [...new Set(aliases.map((item) => asText(item).trim()).filter(Boolean))];
}

function meaningfulTeamMention(text, team) {
  const aliases = teamAliases(team);
  return aliases.some((alias) => {
    if (!boundedContains(text, alias)) return false;
    // City-only hits are often ambiguous (e.g. New York); require a longer
    // identity unless the full team's name or abbreviation is in the market.
    if (alias === team.city || alias === team.location) return alias.length >= 5;
    return true;
  });
}

function gameTeams(game) {
  const home = game?.teams?.home || game?.homeTeam || game?.home || null;
  const away = game?.teams?.away || game?.awayTeam || game?.away || null;
  return { home, away };
}

function startMillis(value) {
  const parsed = typeof value === 'number' ? value : Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function sameUtcDay(a, b) {
  return new Date(a).toISOString().slice(0, 10) === new Date(b).toISOString().slice(0, 10);
}

function marketHasStartTime(market, game) {
  const marketStart = startMillis(market?.startTime || market?.eventStartTime || market?.gameStartTime);
  const gameStart = startMillis(game?.startTime || game?.date || game?.eventStartTime);
  return marketStart !== null && gameStart !== null && sameUtcDay(marketStart, gameStart);
}

/**
 * Conservatively associate a market with one of the supplied scoreboard games.
 * Both teams must be named, or one team and an explicit same-UTC-day start time
 * must identify a unique game. Ambiguous matches intentionally return null.
 */
export function matchGame(market, games) {
  try {
    if (!market || !Array.isArray(games) || games.length === 0) return null;
    const text = marketText(market);
    if (!text) return null;
    const matches = [];
    for (const game of games) {
      const { home, away } = gameTeams(game);
      if (!home || !away) continue;
      const homeMentioned = meaningfulTeamMention(text, home);
      const awayMentioned = meaningfulTeamMention(text, away);
      if (homeMentioned && awayMentioned) matches.push(game);
      else if ((homeMentioned || awayMentioned) && marketHasStartTime(market, game)) matches.push(game);
    }
    return matches.length === 1 ? matches[0] : null;
  } catch {
    return null;
  }
}

function selectLeagues(market) {
  const text = marketText(market);
  const hints = LEAGUE_HINTS.filter(({ keys }) => keys.some((key) => boundedContains(text, key)));
  if (hints.length === 1) {
    const [sport, league] = hints[0].league.split('/');
    return [{ sport, league }];
  }
  // Most sports markets include their league in tags. If the title only names
  // teams, query the aggregate fetcher; it benefits from the ESPN cache.
  return undefined;
}

function contextFromGame(game) {
  const teams = game?.teams || {};
  const homeTeam = game?.score?.homeTeam || teams.home?.displayName || teams.home?.name || game?.homeTeam?.displayName || game?.homeTeam?.name || null;
  const awayTeam = game?.score?.awayTeam || teams.away?.displayName || teams.away?.name || game?.awayTeam?.displayName || game?.awayTeam?.name || null;
  const score = game?.score || {};
  return {
    kind: 'game',
    league: game?.league || game?.leagueName || game?.sport || null,
    status: ['pre', 'in', 'post'].includes(game?.status) ? game.status : 'pre',
    clock: game?.clock ?? null,
    period: game?.period ?? null,
    score: {
      home: score.home ?? game?.homeScore ?? null,
      away: score.away ?? game?.awayScore ?? null,
      homeTeam,
      awayTeam,
    },
    situation: game?.situation || null,
    imminent: game?.imminent || null,
    lastPlay: game?.lastPlay || null,
    source: game?.source || 'espn',
    fetchedAt: game?.fetchedAt || null,
  };
}

async function fetchGamesForMarket(market, options) {
  try {
    const espn = await import('./espn.js');
    if (typeof espn.fetchGames === 'function') {
      return await espn.fetchGames({ ...options, leagues: selectLeagues(market) });
    }
    if (typeof espn.fetchEspnGames === 'function') {
      return await espn.fetchEspnGames({ ...options, leagues: selectLeagues(market) });
    }
    if (typeof espn.fetchScoreboard === 'function') {
      const leagues = selectLeagues(market);
      if (!leagues?.length) return [];
      const games = await Promise.all(leagues.map(({ sport, league }) =>
        espn.fetchScoreboard(sport, league, options)));
      return games.flat();
    }
  } catch {
    return [];
  }
  return [];
}

/**
 * Return current scoreboard or crypto spot context for a normalized market.
 * All network and parsing failures degrade to null so this can be called from
 * the polling path without taking down the server.
 */
export async function getLiveContext(market, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  try {
    const category = asText(market?.category).toLowerCase();
    const isCrypto = category === 'crypto' || Boolean(detectAssetSymbol(market));
    if (isCrypto) return await getAssetContext(market, { fetchImpl, now });

    const isSports = category === 'sports' || category === 'sport' || Boolean(selectLeagues(market));
    if (!isSports || typeof fetchImpl !== 'function') return null;
    const games = await fetchGamesForMarket(market, { fetchImpl, now });
    const game = matchGame(market, games);
    if (!game) return null;
    const context = contextFromGame(game);
    if (!context.fetchedAt) {
      const timestamp = now instanceof Date ? now.getTime() : Number(now);
      context.fetchedAt = new Date(Number.isFinite(timestamp) ? timestamp : Date.now()).toISOString();
    }
    return context;
  } catch {
    return null;
  }
}
