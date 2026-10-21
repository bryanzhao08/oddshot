// Which services carry which networks. Approximate as of Oct 2026: carriage deals and prices
// change, so keep everything editable here. Prices are typical US monthly list prices.

export const SERVICES = [
  // Live TV bundles
  { id: 'cable', name: 'Cable or satellite TV', group: 'TV', price: null, note: 'Spectrum, Xfinity, DirecTV, Dish…' },
  { id: 'antenna', name: 'TV antenna (free)', group: 'TV', price: 0 },
  { id: 'youtube_tv', name: 'YouTube TV', group: 'Live TV app', price: 83 },
  { id: 'hulu_live', name: 'Hulu + Live TV', group: 'Live TV app', price: 82 },
  { id: 'fubo', name: 'Fubo', group: 'Live TV app', price: 85 },
  { id: 'sling_orange', name: 'Sling Orange', group: 'Live TV app', price: 46 },
  { id: 'sling_blue', name: 'Sling Blue', group: 'Live TV app', price: 51 },
  { id: 'directv_stream', name: 'DirecTV Stream', group: 'Live TV app', price: 87 },
  // Streaming
  { id: 'prime', name: 'Amazon Prime Video', group: 'Streaming', price: 15 },
  { id: 'peacock', name: 'Peacock', group: 'Streaming', price: 11 },
  { id: 'paramount', name: 'Paramount+', group: 'Streaming', price: 13 },
  { id: 'espn_plus', name: 'ESPN+', group: 'Streaming', price: 12 },
  { id: 'espn_unlimited', name: 'ESPN (Unlimited)', group: 'Streaming', price: 30 },
  { id: 'max', name: 'HBO Max', group: 'Streaming', price: 17 },
  { id: 'netflix', name: 'Netflix', group: 'Streaming', price: 18 },
  { id: 'apple_tv', name: 'Apple TV', group: 'Streaming', price: 13 },
  { id: 'disney_plus', name: 'Disney+', group: 'Streaming', price: 16 },
  // League passes
  { id: 'nfl_plus', name: 'NFL+', group: 'League pass', price: 7 },
  { id: 'nba_league_pass', name: 'NBA League Pass', group: 'League pass', price: 17 },
  { id: 'mlb_tv', name: 'MLB.TV', group: 'League pass', price: 30 },
];

const BROADCAST = ['cable', 'antenna', 'youtube_tv', 'hulu_live', 'fubo', 'directv_stream'];
const CABLE_SPORTS = ['cable', 'youtube_tv', 'hulu_live', 'directv_stream'];

// Network (as ESPN names it) -> services that carry it.
export const NETWORKS = {
  ABC: [...BROADCAST, 'sling_orange', 'espn_unlimited'],
  CBS: [...BROADCAST, 'paramount'],
  NBC: [...BROADCAST, 'peacock', 'sling_blue'],
  FOX: [...BROADCAST, 'sling_blue'],
  ESPN: [...CABLE_SPORTS, 'fubo', 'sling_orange', 'espn_unlimited'],
  ESPN2: [...CABLE_SPORTS, 'fubo', 'sling_orange', 'espn_unlimited'],
  ESPNU: [...CABLE_SPORTS, 'espn_unlimited'],
  'ESPN+': ['espn_plus', 'espn_unlimited'],
  'DISNEY+': ['disney_plus', 'espn_unlimited'],
  FS1: [...CABLE_SPORTS, 'fubo', 'sling_blue'],
  FS2: ['cable', 'youtube_tv', 'fubo', 'directv_stream'],
  TNT: [...CABLE_SPORTS, 'sling_orange', 'max'],
  TBS: [...CABLE_SPORTS, 'sling_orange', 'max'],
  TRUTV: [...CABLE_SPORTS, 'max'],
  USA: [...CABLE_SPORTS, 'fubo', 'sling_blue'],
  'NFL NETWORK': [...CABLE_SPORTS, 'fubo', 'sling_blue'],
  'NBA TV': ['cable', 'youtube_tv', 'directv_stream', 'nba_league_pass'],
  'MLB NETWORK': ['cable', 'youtube_tv', 'fubo', 'directv_stream'],
  'NHL NETWORK': ['cable', 'fubo', 'directv_stream'],
  CBSSN: ['cable', 'youtube_tv', 'fubo', 'directv_stream', 'hulu_live'],
  BTN: [...CABLE_SPORTS, 'fubo'],
  SECN: [...CABLE_SPORTS, 'fubo', 'espn_unlimited'],
  ACCN: [...CABLE_SPORTS, 'fubo', 'espn_unlimited'],
  'PRIME VIDEO': ['prime'],
  PEACOCK: ['peacock'],
  'PARAMOUNT+': ['paramount'],
  NETFLIX: ['netflix'],
  'APPLE TV': ['apple_tv'],
  'NBA LEAGUE PASS': ['nba_league_pass'],
  'MLB.TV': ['mlb_tv'],
  'NFL+': ['nfl_plus'],
};

// ESPN's spellings -> our keys.
const ALIASES = {
  'NFL NET': 'NFL NETWORK', 'USA NET': 'USA', 'MLB NET': 'MLB NETWORK', 'NHL NET': 'NHL NETWORK', 'APPLE TV+': 'APPLE TV',
  'AMAZON PRIME VIDEO': 'PRIME VIDEO', PRIME: 'PRIME VIDEO', 'ESPN UNLIMITED': 'ESPN', 'TRU TV': 'TRUTV', 'CBS SPORTS NETWORK': 'CBSSN',
  'BIG TEN NETWORK': 'BTN', 'SEC NETWORK': 'SECN', 'ACC NETWORK': 'ACCN', MAX: 'TNT',
};

export const serviceById = Object.fromEntries(SERVICES.map((s) => [s.id, s]));

/** Normalize one ESPN broadcast entry -> { label, key, services[], regional } */
export function network(name, { type = '', market = '' } = {}) {
  const label = String(name || '').trim();
  const up = label.toUpperCase();
  const key = ALIASES[up] || up;
  const services = NETWORKS[key];
  if (services) return { label, key, services, regional: false, streaming: /stream/i.test(type) };
  // Unknown TV channel shown for a home/away market = a regional sports network (Bally/FanDuel, MSG, team channels…).
  const regional = /home|away/i.test(market) || /app$/i.test(label) || /sports/i.test(label);
  return { label, key, services: regional ? ['cable', 'directv_stream'] : [], regional, streaming: /stream/i.test(type) };
}

/** For a game's broadcasts and the user's services: how they can watch, or what they'd need. */
export function howToWatch(broadcasts, mine) {
  const nets = broadcasts.map((b) => network(b.name, b));
  const have = new Set(mine);
  for (const n of nets) {
    const via = n.services.filter((s) => have.has(s));
    if (via.length) return { status: 'yes', network: n, via: via.map((id) => serviceById[id]) };
  }
  if (!nets.length) return { status: 'unknown' };
  // A regional sports channel means it's local TV in the team's area; league passes only work outside it.
  const regional = nets.find((n) => n.regional);
  const national = nets.filter((n) => !n.regional && !['NBA LEAGUE PASS', 'MLB.TV', 'NFL+'].includes(n.key));
  const passes = nets.filter((n) => ['NBA LEAGUE PASS', 'MLB.TV'].includes(n.key));
  if (!regional && !national.length && passes.length) {
    // Only a league pass listed: it's on the local sports channel in the team's area.
    return { status: 'local', network: { label: 'your local sports channel', key: 'LOCAL', services: [] }, outOfMarket: passes[0].label };
  }
  if (regional && !national.length) {
    const outOfMarket = nets.find((n) => ['NBA LEAGUE PASS', 'MLB.TV'].includes(n.key));
    return { status: 'local', network: regional, outOfMarket: outOfMarket ? outOfMarket.label : null };
  }
  // Cheapest single service that would cover it.
  const options = [...new Set(nets.flatMap((n) => n.services))].map((id) => serviceById[id]).filter(Boolean)
    .sort((a, b) => (a.price ?? 999) - (b.price ?? 999));
  return { status: 'no', network: nets.find((n) => n.services.length) || nets[0], options: options.slice(0, 3) };
}
