// Tipoff Watch: pick your teams and the services you pay for; see every upcoming game with
// exactly how you can watch it, what you're paying for but not using, and get a nudge when
// a game gets close. Runs entirely in the browser on ESPN's public data.

import { SERVICES, serviceById, howToWatch } from './services.js';

const ESPN = 'https://site.web.api.espn.com/apis/site/v2/sports';
const LEAGUES = [
  { key: 'nfl', sport: 'football', league: 'nfl', name: 'NFL' },
  { key: 'cfb', sport: 'football', league: 'college-football', name: 'College football' },
  { key: 'nba', sport: 'basketball', league: 'nba', name: 'NBA' },
  { key: 'wnba', sport: 'basketball', league: 'wnba', name: 'WNBA' },
  { key: 'mlb', sport: 'baseball', league: 'mlb', name: 'MLB' },
  { key: 'nhl', sport: 'hockey', league: 'nhl', name: 'NHL' },
  { key: 'mls', sport: 'soccer', league: 'usa.1', name: 'MLS' },
  { key: 'epl', sport: 'soccer', league: 'eng.1', name: 'Premier League' },
];
const leagueByKey = Object.fromEntries(LEAGUES.map((l) => [l.key, l]));

// ---------------------------------------------------------------- state

const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(`tw.${k}`)) ?? d; } catch { return d; } },
  set: (k, v) => localStorage.setItem(`tw.${k}`, JSON.stringify(v)),
};
let teams = store.get('teams', []);           // [{league, id, name, abbr, logo}]
let services = store.get('services', []);     // [serviceId]
let alerts = store.get('alerts', { reminders: true, close: true });
let games = [];                               // upcoming + live games for my teams
let allTeams = null;                          // lazy team directory
const notified = new Set(store.get('notified', []));

const $main = document.getElementById('main');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const json = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });

// ---------------------------------------------------------------- data

async function loadTeamDirectory() {
  if (allTeams) return allTeams;
  const lists = await Promise.all(LEAGUES.map(async (l) => {
    try {
      const d = await json(`${ESPN}/${l.sport}/${l.league}/teams?limit=1000`);
      return (d.sports?.[0]?.leagues?.[0]?.teams || []).map(({ team: t }) => ({
        league: l.key, id: String(t.id), name: t.displayName, abbr: t.abbreviation, logo: t.logos?.[0]?.href || '',
      }));
    } catch { return []; }
  }));
  allTeams = lists.flat();
  return allTeams;
}

function parseEvent(e, l, myTeam) {
  const c = e.competitions?.[0] || {};
  const comps = (c.competitors || []).sort((a) => (a.homeAway === 'home' ? 1 : -1)); // away first, then home
  const status = c.status?.type || e.status?.type || {};
  const broadcasts = [];
  for (const b of c.geoBroadcasts || []) broadcasts.push({ name: b.media?.shortName, type: b.type?.shortName, market: b.market?.type });
  for (const b of c.broadcasts || []) {
    for (const n of b.names || [b.media?.shortName]) if (n && !broadcasts.some((x) => x.name === n)) broadcasts.push({ name: n, market: b.market });
  }
  return {
    id: String(e.id), league: l.key, leagueName: l.name, date: new Date(e.date), myTeam,
    teams: comps.map((x) => ({ id: String(x.team?.id ?? x.id), name: x.team?.shortDisplayName || x.team?.displayName, logo: x.team?.logos?.[0]?.href || x.team?.logo || '',
      score: x.score?.displayValue ?? x.score ?? null, home: x.homeAway === 'home' })),
    state: status.state, detail: status.shortDetail || status.detail || '', period: c.status?.period ?? 0,
    clock: c.status?.displayClock || '', broadcasts,
  };
}

async function loadGames() {
  const horizon = Date.now() + 21 * 86400e3;
  const seen = new Map();
  await Promise.all(teams.map(async (t) => {
    const l = leagueByKey[t.league];
    try {
      const d = await json(`${ESPN}/${l.sport}/${l.league}/teams/${t.id}/schedule`);
      for (const e of d.events || []) {
        const g = parseEvent(e, l, t);
        const recent = g.state === 'in' || (g.state === 'pre' && g.date.getTime() < horizon);
        if (recent && !seen.has(g.id)) seen.set(g.id, g);
      }
    } catch { /* one team failing shouldn't hide the rest */ }
  }));
  // Live scores and broadcasts come from today's scoreboard (schedules can be stale mid-game).
  const leagues = [...new Set(teams.map((t) => t.league))];
  await Promise.all(leagues.map(async (k) => {
    const l = leagueByKey[k];
    try {
      const d = await json(`${ESPN}/${l.sport}/${l.league}/scoreboard`);
      for (const e of d.events || []) {
        if (!seen.has(String(e.id))) continue;
        const old = seen.get(String(e.id));
        const fresh = parseEvent(e, l, old.myTeam);
        if (!fresh.broadcasts.length) fresh.broadcasts = old.broadcasts;
        seen.set(fresh.id, fresh);
      }
    } catch { /* keep schedule data */ }
  }));
  games = [...seen.values()].sort((a, b) => (a.state === 'in' ? -1 : 0) - (b.state === 'in' ? -1 : 0) || a.date - b.date);
}

// ---------------------------------------------------------------- close-game logic

function isClose(g) {
  if (g.state !== 'in') return false;
  const [a, b] = g.teams.map((t) => Number(t.score) || 0);
  const diff = Math.abs(a - b);
  const sec = (() => { const p = String(g.clock).split(':').map(Number); return p.length === 2 ? p[0] * 60 + p[1] : 9999; })();
  switch (g.league) {
    case 'nfl': case 'cfb': return g.period >= 4 && sec <= 600 && diff <= 8;
    case 'nba': case 'wnba': return g.period >= 4 && sec <= 360 && diff <= 6;
    case 'nhl': return g.period >= 3 && diff <= 1;
    case 'mlb': return g.period >= 7 && diff <= 2;
    default: return /^\d+/.test(g.clock) && parseInt(g.clock, 10) >= 70 && diff <= 1; // soccer minute
  }
}

function notify(key, title, body) {
  if (notified.has(key) || !('Notification' in window) || Notification.permission !== 'granted') return;
  notified.add(key);
  store.set('notified', [...notified].slice(-200));
  new Notification(title, { body, icon: 'icon.svg' });
}

function checkAlerts() {
  const now = Date.now();
  for (const g of games) {
    const how = howToWatch(g.broadcasts, services);
    const where = how.network ? ` on ${how.network.label}` : '';
    const title = `${g.teams[0]?.name} at ${g.teams[1]?.name}`;
    if (alerts.reminders && g.state === 'pre' && g.date - now < 30 * 60e3 && g.date - now > 0) notify(`soon:${g.id}`, `Starts in ${Math.round((g.date - now) / 60e3)} min${where}`, title);
    if (alerts.close && isClose(g)) notify(`close:${g.id}`, `Close game${where}!`, `${title}: ${g.teams[0]?.score}-${g.teams[1]?.score}, ${g.detail}`);
  }
}

// ---------------------------------------------------------------- views

function setView(v) {
  for (const b of document.querySelectorAll('nav button')) b.setAttribute('aria-current', b.dataset.view === v ? 'page' : 'false');
  ({ games: viewGames, subs: viewSubs, setup: viewSetup })[v]();
  $main.focus({ preventScroll: true });
}
document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

function fmtDay(d) {
  const today = new Date(); const tmr = new Date(Date.now() + 86400e3);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === tmr.toDateString()) return 'Tomorrow';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
const fmtTime = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

function watchBox(g) {
  const h = howToWatch(g.broadcasts, services);
  if (h.status === 'yes') {
    const via = h.via[0];
    const how = via.id === h.network.key.toLowerCase() || via.group === 'Streaming' || via.group === 'League pass' ? `in the ${via.name} app` : `with your ${via.name}`;
    return `<div class="watch yes"><strong>✅ Watch on ${esc(h.network.label)}</strong>You have it ${esc(how)}.</div>`;
  }
  if (h.status === 'local') return `<div class="watch local"><strong>📍 Local TV: ${esc(h.network.label)}</strong>Usually through cable or the team's own app.${h.outOfMarket ? ` Live outside the team's area? It's on ${esc(h.outOfMarket)}.` : ''}</div>`;
  if (h.status === 'no') {
    const opts = h.options.map((o) => `${esc(o.name)}${o.price != null ? ` ($${o.price}/mo)` : ''}`).join(', ');
    return `<div class="watch no"><strong>⚠️ On ${esc(h.network.label)}, which you don't have</strong>${opts ? `Cheapest ways to get it: ${opts}.` : ''}</div>`;
  }
  return `<div class="watch unknown"><strong>Channel not announced yet</strong>Check back closer to game day.</div>`;
}

function viewGames() {
  if (!teams.length) return viewSetup();
  const list = games.length ? games.map((g) => {
    const live = g.state === 'in';
    const score = live ? ` <span class="muted">${esc(g.teams[0]?.score)}–${esc(g.teams[1]?.score)}</span>` : '';
    return `<article class="card game">
      <div class="when">${live ? `<span class="live">Live</span><div class="time">${esc(g.detail)}</div>`
        : `<div class="day">${fmtDay(g.date)}</div><div class="time">${fmtTime(g.date)}</div>`}<div class="note">${esc(g.leagueName)}</div></div>
      <div>
        <div class="matchup">${g.teams.map((t, i) => `<span class="team">${t.logo ? `<img src="${esc(t.logo)}" alt="">` : ''}${esc(t.name)}</span>${i === 0 ? '<span class="muted">at</span>' : ''}`).join('')}${score}
          ${isClose(g) ? '<span class="close">Close game</span>' : ''}</div>
        ${watchBox(g)}
      </div></article>`;
  }).join('') : `<div class="card empty">No games in the next three weeks for your teams.</div>`;
  const covered = games.filter((g) => howToWatch(g.broadcasts, services).status === 'yes').length;
  $main.innerHTML = `
    <h1>Your next games</h1>
    <p class="lede">${games.length ? `You can watch <b>${covered} of ${games.length}</b> with what you already pay for.` : ''} Times are in your time zone.</p>
    ${list}
    <div class="card"><h2 style="margin-top:0">Alerts</h2>
      <div class="row"><label><input type="checkbox" id="a-rem" ${alerts.reminders ? 'checked' : ''}> Remind me 30 minutes before</label></div>
      <div class="row"><label><input type="checkbox" id="a-close" ${alerts.close ? 'checked' : ''}> Tell me when a game gets close</label></div>
      <p class="note">Alerts show on this device while Tipoff Watch is open. Text-message alerts are coming with membership.</p>
      ${'Notification' in window && Notification.permission !== 'granted' ? '<button class="btn secondary" id="perm">Turn on alerts</button>' : ''}
    </div>`;
  document.getElementById('a-rem').onchange = (e) => { alerts.reminders = e.target.checked; store.set('alerts', alerts); };
  document.getElementById('a-close').onchange = (e) => { alerts.close = e.target.checked; store.set('alerts', alerts); };
  const p = document.getElementById('perm');
  if (p) p.onclick = async () => { await Notification.requestPermission(); viewGames(); };
}

function viewSubs() {
  if (!teams.length) return viewSetup();
  const usable = games.filter((g) => g.broadcasts.length);
  const mine = services.map((id) => serviceById[id]).filter(Boolean);
  const rows = mine.map((s) => {
    const canShow = usable.filter((g) => howToWatch(g.broadcasts, [s.id]).status === 'yes');
    const onlyHere = canShow.filter((g) => howToWatch(g.broadcasts, services.filter((x) => x !== s.id)).status !== 'yes');
    return { s, canShow: canShow.length, onlyHere: onlyHere.length };
  });
  const cancel = rows.filter((r) => r.canShow === 0 && r.s.price > 0);
  const saving = cancel.reduce((a, r) => a + r.s.price, 0);
  const missed = usable.filter((g) => howToWatch(g.broadcasts, services).status === 'no');
  // The one service that would unlock the most missed games, by price.
  const add = new Map();
  for (const g of missed) for (const o of howToWatch(g.broadcasts, services).options || []) add.set(o.id, (add.get(o.id) || 0) + 1);
  // Best value first (games per dollar), then the one that covers the most.
  const cands = [...add.entries()].map(([id, n]) => ({ s: serviceById[id], n })).filter((c) => c.s && c.s.price);
  const bestAdd = [...cands].sort((a, b) => b.n / b.s.price - a.n / a.s.price || b.n - a.n)[0];
  const mostAdd = [...cands].sort((a, b) => b.n - a.n || a.s.price - b.s.price)[0];
  $main.innerHTML = `
    <h1>Your subscriptions</h1>
    <p class="lede">Based on your teams' next ${usable.length} games with a channel announced.</p>
    ${saving > 0 ? `<div class="card"><div class="stat">$${saving}/mo</div><p style="margin:6px 0 0">None of your teams' upcoming games are on ${cancel.map((r) => `<b>${esc(r.s.name)}</b>`).join(' or ')}. If you keep ${cancel.length > 1 ? 'them' : 'it'} only for sports, cancelling would save this much.</p></div>` : ''}
    ${missed.length ? `<div class="card"><p style="margin:0"><b>You'd miss ${missed.length} game${missed.length > 1 ? 's' : ''}</b> with what you have now.${bestAdd ? ` Best value: <b>${esc(bestAdd.s.name)}</b> ($${bestAdd.s.price}/mo) would cover ${bestAdd.n} of them.` : ''}${mostAdd && bestAdd && mostAdd.s.id !== bestAdd.s.id ? ` For the most coverage, <b>${esc(mostAdd.s.name)}</b> ($${mostAdd.s.price}/mo) would cover ${mostAdd.n}.` : ''}</p></div>` : ''}
    <div class="card">${rows.length ? rows.map((r) => `<div class="svc">
        <div><b>${esc(r.s.name)}</b>${r.s.price != null ? ` <span class="muted">· about $${r.s.price}/mo</span>` : ''}<div class="muted">Shows ${r.canShow} of your games${r.onlyHere ? `, and ${r.onlyHere} only here` : ''}</div></div>
        <div class="verdict ${r.canShow === 0 && r.s.price > 0 ? 'cancel' : 'keep'}">${r.canShow === 0 && r.s.price > 0 ? 'Not used' : r.onlyHere ? 'Keep' : 'Backup'}</div>
      </div>`).join('') : '<p class="muted" style="margin:0">Add the services you pay for in Settings.</p>'}</div>
    <p class="note">Channel lineups and prices change. These are estimates; check your provider before cancelling.</p>`;
}

async function viewSetup() {
  const groups = [...new Set(SERVICES.map((s) => s.group))];
  $main.innerHTML = `
    <h1>${teams.length ? 'Settings' : 'Never hunt for the channel again'}</h1>
    <p class="lede">Pick your teams and the TV services you already pay for. We'll show every game and exactly how you can watch it.</p>
    <h2>1. Your teams</h2>
    <div class="chips" id="chips"></div>
    <label for="q" class="note">Search any NFL, college football, NBA, WNBA, MLB, NHL, MLS or Premier League team</label>
    <input type="search" id="q" placeholder="e.g. Chiefs, Lakers, Red Sox" autocomplete="off">
    <div class="results" id="results"></div>
    <h2>2. What you pay for</h2>
    ${groups.map((g) => `<div class="group-title">${esc(g)}</div><div class="services">${SERVICES.filter((s) => s.group === g).map((s) =>
      `<label><input type="checkbox" value="${s.id}" ${services.includes(s.id) ? 'checked' : ''}><span>${esc(s.name)}${s.note ? `<br><span class="note">${esc(s.note)}</span>` : ''}</span></label>`).join('')}</div>`).join('')}
    <div class="row" style="margin-top:24px"><button class="btn" id="done">Show my games</button></div>`;
  const chips = () => {
    document.getElementById('chips').innerHTML = teams.length ? teams.map((t, i) => `<span class="chip">${t.logo ? `<img src="${esc(t.logo)}" alt="">` : ''}${esc(t.name)}<button aria-label="Remove ${esc(t.name)}" data-i="${i}">✕</button></span>`).join('')
      : '<span class="muted">No teams yet</span>';
    document.querySelectorAll('#chips button').forEach((b) => b.onclick = () => { teams.splice(Number(b.dataset.i), 1); store.set('teams', teams); chips(); });
  };
  chips();
  for (const cb of document.querySelectorAll('.services input')) cb.onchange = () => {
    services = [...document.querySelectorAll('.services input:checked')].map((x) => x.value);
    store.set('services', services);
  };
  const q = document.getElementById('q'), res = document.getElementById('results');
  q.oninput = async () => {
    const term = q.value.trim().toLowerCase();
    if (term.length < 2) { res.innerHTML = ''; return; }
    res.innerHTML = '<span class="muted">Searching…</span>';
    const dir = await loadTeamDirectory();
    const hits = dir.filter((t) => t.name.toLowerCase().includes(term) || t.abbr?.toLowerCase() === term).slice(0, 12);
    res.innerHTML = hits.map((t, i) => `<button data-i="${i}">${t.logo ? `<img src="${esc(t.logo)}" alt="" width="32" height="32">` : ''}${esc(t.name)}<small>${esc(leagueByKey[t.league].name)}</small></button>`).join('') || '<span class="muted">No match</span>';
    res.querySelectorAll('button').forEach((b) => b.onclick = () => {
      const t = hits[Number(b.dataset.i)];
      if (!teams.some((x) => x.id === t.id && x.league === t.league)) teams.push(t);
      store.set('teams', teams); chips(); q.value = ''; res.innerHTML = ''; q.focus();
    });
  };
  document.getElementById('done').onclick = async () => {
    $main.innerHTML = '<p class="muted">Finding your games…</p>';
    await loadGames(); setView('games');
  };
}

// ---------------------------------------------------------------- start

(async () => {
  // ?demo preloads a sample fan so people can see it working before setting up.
  if (new URLSearchParams(location.search).has('demo') && !teams.length) {
    teams = [
      { league: 'nfl', id: '12', name: 'Kansas City Chiefs', abbr: 'KC', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/kc.png' },
      { league: 'nfl', id: '17', name: 'New England Patriots', abbr: 'NE', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/ne.png' },
      { league: 'nba', id: '15', name: 'Milwaukee Bucks', abbr: 'MIL', logo: 'https://a.espncdn.com/i/teamlogos/nba/500/mil.png' },
      { league: 'nhl', id: '1', name: 'Boston Bruins', abbr: 'BOS', logo: 'https://a.espncdn.com/i/teamlogos/nhl/500/bos.png' },
    ];
    services = ['youtube_tv', 'paramount', 'netflix', 'disney_plus'];
  }
  if (!teams.length) { setView('setup'); return; }
  await loadGames();
  setView(new URLSearchParams(location.search).get('view') || 'games');
  checkAlerts();
  setInterval(async () => {
    await loadGames();
    checkAlerts();
    const cur = document.querySelector('nav button[aria-current="page"]')?.dataset.view;
    if (cur === 'games') viewGames();
  }, 60_000);
})();
