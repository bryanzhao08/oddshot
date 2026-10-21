// Tipoff Moment Pools: auto-timed live prediction pools for streamers and Discord communities.
//
//   node pools/server.js --replay nfl            # replay a finished game (no live game needed)
//   node pools/server.js --live nfl,nba,epl      # watch live ESPN games
//   options: --port 4320  --speed 4 (replay snapshots/sec)  --twitch <channel>  --discord <channelId>
//            --bots 12 (simulated voters for demos, clearly labelled)  --window 45 (vote seconds)
//
// Open http://localhost:4320/overlay as an OBS browser source and http://localhost:4320/vote on a phone.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PoolEngine } from './engine.js';
import { LiveFeed, replaySnapshots } from './feeds.js';
import { loadSportModel } from './models.js';
import { connectTwitch } from './adapters/twitch.js';
import { connectDiscord } from './adapters/discord.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

function args() {
  const a = { port: 4320, speed: 4, window: 45, bots: 0 };
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) {
    const k = v[i].replace(/^--/, '');
    const next = v[i + 1] && !v[i + 1].startsWith('--') ? v[++i] : true;
    a[k] = ['port', 'speed', 'window', 'bots'].includes(k) ? Number(next) : next;
  }
  if (!a.replay && !a.live) a.replay = 'nfl';
  return a;
}

async function loadModels() {
  const out = {};
  for (const s of ['soccer', 'football', 'basketball']) {
    try { out[s] = loadSportModel(JSON.parse(await readFile(join(ROOT, 'server/ml/sports', `${s}.json`), 'utf8'))); }
    catch (e) { console.warn(`model ${s} not loaded: ${e.message}`); }
  }
  return out;
}

const REPLAYS = {
  nfl: ['football', 'samples/nfl.json'],
  soccer: ['soccer', 'samples/soccer.json'],
  nba: ['basketball', '../server/ml/sports/samples/basketball_401584689.json'],
};

async function main() {
  const opt = args();
  const engine = new PoolEngine({ models: await loadModels(), voteWindowMs: opt.window * 1000 });
  const clients = new Set();
  const push = (type, data) => { for (const res of clients) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
  for (const ev of ['open', 'vote', 'lock', 'settle', 'void']) engine.on(ev, (p) => { push(ev, p); push('state', engine.state()); });
  engine.on('open', (p) => console.log(`OPEN   ${p.question}  [${p.why ?? ''}]`));
  engine.on('settle', (p) => console.log(`SETTLE ${p.question} → ${p.outcomeLabel} (${p.winners.length}/${p.total} right)`));
  engine.on('void', (p) => console.log(`VOID   ${p.question} (no votes)`));
  setInterval(() => engine.tick(), 500);

  // Simulated voters for demos (named bot_*, never mixed with real users silently).
  if (opt.bots > 0) {
    engine.on('open', (p) => {
      for (let i = 0; i < opt.bots; i++) {
        setTimeout(() => {
          // Vote roughly in line with the model: option 1 at its chance, the rest split evenly.
          const n = p.options.length, c = p.chance ?? 1 / n;
          const w = p.options.map((_, k) => (k === 0 ? c : (1 - c) / (n - 1)));
          let r = Math.random(), pick = 0;
          while (pick < n - 1 && (r -= w[pick]) > 0) pick++;
          engine.vote(`bot:${i}`, pick + 1, { poolId: p.id, name: `bot_${i + 1}`, source: 'bot' });
        }, Math.random() * Math.min(opt.window * 800, 20_000));
      }
    });
  }

  if (opt.twitch) connectTwitch(engine, opt.twitch);
  if (opt.discord) connectDiscord(engine, opt.discord);

  // ---- feed loop
  if (opt.replay) {
    const [sport, file] = REPLAYS[opt.replay] || REPLAYS.nfl;
    const raw = JSON.parse(await readFile(join(HERE, file), 'utf8'));
    const snaps = replaySnapshots(sport, raw.raw_summary || raw);
    console.log(`replay ${opt.replay}: ${snaps.length} snapshots at ${opt.speed}/s (pauses while chat votes)`);
    let i = 0;
    const step = () => {
      // Hold the replay while a pool is open so people have time to vote.
      if (engine.openPools().length) return setTimeout(step, 500);
      if (i >= snaps.length) { console.log('replay finished; restarting in 15s'); i = 0; return setTimeout(step, 15_000); }
      engine.ingest({ ...snaps[i++], t: Date.now() });
      push('game', engine.state().games);
      setTimeout(step, 1000 / opt.speed);
    };
    step();
  } else {
    const feed = new LiveFeed(String(opt.live).split(','));
    const poll = async () => {
      try { for (const s of await feed.poll()) engine.ingest(s); push('game', engine.state().games); }
      catch (e) { console.warn(`poll: ${e.message}`); }
      setTimeout(poll, 15_000);
    };
    poll();
    console.log(`live: watching ${opt.live}`);
  }

  // ---- http
  const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
  createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/state') return send(res, 200, JSON.stringify(engine.state()));
    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`event: state\ndata: ${JSON.stringify(engine.state())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/api/vote' && req.method === 'POST') {
      let body = '';
      for await (const c of req) body += c;
      try {
        const { user, name, option } = JSON.parse(body || '{}');
        if (!user) return send(res, 400, JSON.stringify({ ok: false, error: 'user required' }));
        return send(res, 200, JSON.stringify(engine.vote(`web:${String(user).slice(0, 40)}`, option, { name: String(name || user).slice(0, 24), source: 'web' })));
      } catch { return send(res, 400, JSON.stringify({ ok: false, error: 'bad json' })); }
    }
    const page = { '/': 'overlay/index.html', '/overlay': 'overlay/index.html', '/vote': 'overlay/vote.html' }[url.pathname];
    if (page) return send(res, 200, await readFile(join(HERE, page)), 'text/html; charset=utf-8');
    send(res, 404, 'not found', 'text/plain');
  }).listen(opt.port, () => {
    console.log(`Moment Pools on http://localhost:${opt.port}  overlay: /overlay  vote: /vote`);
  });
}

main();
