// Tipoff Moment Pools engine: watches game snapshots, opens a pool right before a moment,
// takes votes for a short window, locks, and settles from what actually happens.
// Platform-agnostic: adapters (Twitch chat, Discord, web overlay) call vote() and listen to events.
//
// Snapshot shape (live ESPN feed and replays produce the same thing):
//   { id, sport: 'football'|'soccer'|'basketball', league, name, status: 'pre'|'in'|'post',
//     teams: [{id, abbr, name}, {id, abbr, name}]   // home first
//     scores: [home, away], period, clockSeconds, minute (soccer), elapsed (basketball game seconds),
//     drive: { offense: 0|1, yardsToEndzone, down, distance, text } | null   (football)
//     soccer: { timeline: [{min, team, kind}] }   basketball: { timeline: [{sec, home, away}] }
//     t: ms }

import { EventEmitter } from 'node:events';
import { triggers, resolvers } from './triggers.js';

const DEFAULTS = {
  voteWindowMs: 45_000,      // how long chat can vote after a pool opens
  maxOpenPerGame: 1,         // one pool at a time per game keeps chat focused
  basePoints: 100,
};

export class PoolEngine extends EventEmitter {
  constructor({ models = null, now = () => Date.now(), ...opts } = {}) {
    super();
    this.opts = { ...DEFAULTS, ...opts };
    this.models = models;            // optional { soccer, football, basketball } from models.js
    this.now = now;
    this.pools = new Map();          // id -> pool
    this.history = new Map();        // gameId -> last snapshots (for triggers)
    this.cooldown = new Map();       // gameId:kind -> ts
    this.players = new Map();        // user -> { name, points, correct, played, streak, best }
    this.games = new Map();          // gameId -> latest snapshot
  }

  /** Feed a game snapshot. Opens and settles pools as needed. */
  ingest(snap) {
    const prev = this.games.get(snap.id);
    this.games.set(snap.id, snap);
    const hist = this.history.get(snap.id) || [];
    hist.push(snap);
    if (hist.length > 400) hist.shift();
    this.history.set(snap.id, hist);

    // Settle open or locked pools for this game first.
    for (const pool of this.pools.values()) {
      if (pool.gameId !== snap.id || pool.status === 'settled' || pool.status === 'void') continue;
      const outcome = resolvers[pool.kind](pool, snap, prev);
      if (outcome !== undefined) this.#settle(pool, outcome);
    }

    if (snap.status !== 'in') return;
    const active = [...this.pools.values()].filter((p) => p.gameId === snap.id && (p.status === 'open' || p.status === 'locked'));
    if (active.length >= this.opts.maxOpenPerGame) return;

    for (const trig of triggers[snap.sport] || []) {
      const proposal = trig(snap, hist, this.models);
      if (!proposal) continue;
      const key = `${snap.id}:${proposal.key}`;
      if (this.cooldown.has(key)) continue;
      this.cooldown.set(key, this.now());
      this.#open(snap, proposal);
      break;
    }
  }

  #open(snap, p) {
    const id = `${snap.id}-${p.kind}-${this.pools.size + 1}`;
    const pool = {
      id, gameId: snap.id, gameName: snap.name, sport: snap.sport, kind: p.kind,
      question: p.question, why: p.why || null, options: p.options, chance: p.chance ?? null,
      opened: this.now(), locksAt: this.now() + this.opts.voteWindowMs,
      status: 'open', votes: new Map(), outcome: null, state: p.state || {},
    };
    this.pools.set(id, pool);
    this.emit('open', this.view(pool));
  }

  /** Cast or change a vote. option is a 1-based index or an option label. */
  vote(user, option, { poolId = null, name = user, source = 'web' } = {}) {
    const pool = poolId ? this.pools.get(poolId) : this.openPools()[0];
    if (!pool || pool.status !== 'open') return { ok: false, error: 'no open pool' };
    if (this.now() >= pool.locksAt) { this.#lock(pool); return { ok: false, error: 'voting closed' }; }
    let idx = typeof option === 'number' ? option - 1 : NaN;
    if (Number.isNaN(idx)) {
      const s = String(option).trim().toLowerCase();
      idx = /^\d+$/.test(s) ? Number(s) - 1 : pool.options.findIndex((o) => o.toLowerCase().startsWith(s));
    }
    if (!(idx >= 0 && idx < pool.options.length)) return { ok: false, error: 'unknown option' };
    pool.votes.set(user, idx);
    if (!this.players.has(user)) this.players.set(user, { name, points: 0, correct: 0, played: 0, streak: 0, best: 0, source });
    this.emit('vote', this.view(pool));
    return { ok: true, poolId: pool.id, option: pool.options[idx] };
  }

  /** Call regularly: locks pools whose voting window has passed. */
  tick() {
    for (const pool of this.pools.values()) if (pool.status === 'open' && this.now() >= pool.locksAt) this.#lock(pool);
  }

  #lock(pool) {
    if (pool.status !== 'open') return;
    pool.status = pool.votes.size ? 'locked' : 'void';
    this.emit(pool.status === 'void' ? 'void' : 'lock', this.view(pool));
  }

  #settle(pool, outcomeIdx) {
    if (pool.status === 'open') pool.status = 'locked';
    if (pool.status === 'void') return;
    if (outcomeIdx === null) { pool.status = 'void'; this.emit('void', this.view(pool)); return; }
    pool.status = 'settled';
    pool.outcome = outcomeIdx;
    const total = pool.votes.size;
    const right = [...pool.votes.values()].filter((v) => v === outcomeIdx).length;
    // Underdog bonus: the fewer people got it right, the more it's worth.
    const award = Math.round(this.opts.basePoints * (1 + (total ? 1 - right / total : 0)));
    const winners = [];
    for (const [user, choice] of pool.votes) {
      const pl = this.players.get(user);
      pl.played++;
      if (choice === outcomeIdx) {
        pl.streak++;
        pl.best = Math.max(pl.best, pl.streak);
        const pts = award + (pl.streak >= 3 ? 50 : 0);
        pl.points += pts; pl.correct++;
        winners.push({ user, name: pl.name, points: pts, streak: pl.streak });
      } else pl.streak = 0;
    }
    pool.award = award;
    this.emit('settle', { ...this.view(pool), winners });
  }

  openPools() { return [...this.pools.values()].filter((p) => p.status === 'open'); }

  view(pool) {
    const counts = pool.options.map((_, i) => [...pool.votes.values()].filter((v) => v === i).length);
    return {
      id: pool.id, gameId: pool.gameId, gameName: pool.gameName, sport: pool.sport, kind: pool.kind,
      question: pool.question, why: pool.why, options: pool.options, chance: pool.chance,
      status: pool.status, opened: pool.opened, locksAt: pool.locksAt, counts, total: pool.votes.size,
      outcome: pool.outcome, outcomeLabel: pool.outcome == null ? null : pool.options[pool.outcome], award: pool.award ?? null,
    };
  }

  leaderboard(n = 10) {
    return [...this.players.entries()].map(([user, p]) => ({ user, ...p })).filter((p) => p.played > 0)
      .sort((a, b) => b.points - a.points || b.correct - a.correct).slice(0, n);
  }

  state() {
    const pools = [...this.pools.values()].map((p) => this.view(p));
    return {
      now: this.now(),
      games: [...this.games.values()].map((g) => ({ id: g.id, name: g.name, sport: g.sport, status: g.status, scores: g.scores,
        teams: g.teams.map((t) => t.abbr || t.name), clock: g.clockLabel || null })),
      open: pools.filter((p) => p.status === 'open' || p.status === 'locked'),
      recent: pools.filter((p) => p.status === 'settled' || p.status === 'void').slice(-8).reverse(),
      leaderboard: this.leaderboard(),
    };
  }
}
