/* Tipoff frontend: vanilla JS, no dependencies.
 * All API-derived text is inserted via textContent / attributes (never innerHTML). */
(() => {
  'use strict';

  // ------------------------------------------------------------------ constants
  const CATEGORIES = ['sports', 'politics', 'crypto', 'economics', 'entertainment', 'tech', 'weather', 'other'];
  const CAT_EMOJI = { sports: '🏟️', politics: '🏛️', crypto: '₿', economics: '📊', entertainment: '🎬', tech: '💻', weather: '🌦️', other: '✳️' };
  const SEV_RANK = { info: 0, notable: 1, major: 2 };
  const PERSONAS = {
    photographer: { emoji: '📷', label: 'Photographer', desc: 'Live sports & shows. Know when the big play is coming.',
      name: 'Photographer · live sports & shows', categories: ['sports', 'entertainment'], liveOnly: true, minDelta: 0.05, minSeverity: 'info' },
    trader: { emoji: '📈', label: 'Trader', desc: 'Every market, small moves. Front-run the headline.',
      name: 'Trader · all markets', categories: [], liveOnly: false, minDelta: 0.03, minSeverity: 'info' },
    fan: { emoji: '🏆', label: 'Fan', desc: 'Your games, the swings that matter.',
      name: 'Fan · sports swings', categories: ['sports'], liveOnly: false, minDelta: 0.05, minSeverity: 'info' },
    journalist: { emoji: '📰', label: 'Journalist', desc: 'Politics & economy. Catch the story before it breaks.',
      name: 'Journalist · politics & economy', categories: ['politics', 'economics'], liveOnly: false, minDelta: 0.05, minSeverity: 'info' },
    general: { emoji: '✨', label: 'Just curious', desc: 'Only the notable moves, across everything.',
      name: 'Notable moves · everything', categories: [], liveOnly: false, minDelta: 0.05, minSeverity: 'notable' },
  };
  const VIX_WINDOW_MS = 6 * 3600 * 1000;
  const MAX_ALERTS = 300;
  const LS = { onboarded: 'tipoff.onboarded', sound: 'tipoff.sound', cat: 'tipoff.cat', muted: 'tipoff.muted', noise: 'tipoff.hideNoise',
    persona: 'tipoff.persona', briefDismissed: 'tipoff.briefingDismissed', lastVisit: 'tipoff.lastVisit', wire: 'tipoff.wire' };
  // Persona switcher order (general = "Everyone").
  const PERSONA_ORDER = ['photographer', 'trader', 'fan', 'journalist', 'general'];
  const PERSONA_SHORT = { photographer: 'Photographer', trader: 'Trader', fan: 'Fan', journalist: 'Journalist', general: 'Everyone' };
  // Inline icon paths (24x24, stroked). Rendered with s(), never innerHTML.
  const ICONS = {
    scales: 'M12 4v16M8 20h8M5 7h14M5 7l-3 6a3 3 0 0 0 6 0zM19 7l-3 6a3 3 0 0 0 6 0z',
    swap: 'M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7',
    trophy: 'M8 4h8v5a4 4 0 0 1-8 0zM8 6H4a3 3 0 0 0 4 4M16 6h4a3 3 0 0 1-4 4M12 13v4M8 20h8M10 17h4v3h-4z',
    hourglass: 'M6 3h12M6 21h12M8 3v3l4 6-4 6v3M16 3v3l-4 6 4 6v3',
    calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4M12 13v3l2 1',
    trend: 'M3 17l6-6 4 4 8-8M15 7h6v6',
    flame: 'M12 3c1 4 5 5.5 5 10a5 5 0 0 1-10 0c0-2.5 1.5-3.5 2-5.5 1 1 1.7 2 1.7 3.2C12 9 12.6 6 12 3z',
    lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4M12 15v2',
    storm: 'M7 16a4 4 0 1 1 .9-7.9A5 5 0 0 1 17.6 9 3.5 3.5 0 0 1 17 16M12.5 12l-2 4h3l-2 4',
    compass: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM15.5 8.5l-2 5-5 2 2-5z',
    story: 'M3 7a2 2 0 1 0 4 0 2 2 0 1 0-4 0M17 5a2 2 0 1 0 4 0 2 2 0 1 0-4 0M10 18a2 2 0 1 0 4 0 2 2 0 1 0-4 0M7 6.6l10-1.2M6.2 8.6l4.9 7.8M17.9 7l-5 9.2',
    fork: 'M12 21v-7M12 14 5 4M12 14l7-10M5 4v4M5 4h4M19 4v4M19 4h-4',
    bolt: 'M13 2 4 14h7l-1 8 9-12h-7z',
    seismic: 'M2 12h3l2-6 3 13 3-16 3 14 2-8 1.5 3H22',
    eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  };
  const SHOT_KINDS = {
    tension: { label: 'Tension', color: '#ffd84d', icon: 'scales' },
    'turning-point': { label: 'Turning point', color: '#b794ff', icon: 'swap' },
    decisive: { label: 'Decisive', color: '#c6ff3d', icon: 'trophy' },
    closing: { label: 'Closing', color: '#ff5d7a', icon: 'hourglass' },
    upcoming: { label: 'Upcoming', color: '#6aa8ff', icon: 'calendar' },
    momentum: { label: 'Momentum', color: '#3ee0b5', icon: 'trend' },
  };
  const INSIGHT_TYPES = {
    'lead-change': { label: 'Lead change', color: '#b794ff', icon: 'swap' },
    'upset-brewing': { label: 'Upset brewing', color: '#ff8a3d', icon: 'flame' },
    'lock-in': { label: 'Lock-in', color: '#c6ff3d', icon: 'lock' },
    'calm-before-storm': { label: 'Calm before the storm', color: '#5ad1ff', icon: 'storm' },
    'belief-shift': { label: 'Belief shift', color: '#6aa8ff', icon: 'compass' },
    story: { label: 'Story', color: '#f0abfc', icon: 'story' },
    divergence: { label: 'Divergence', color: '#ffd84d', icon: 'fork' },
  };
  const kindMeta = (k) => SHOT_KINDS[k] || { label: cap(String(k || 'Shot').replace(/-/g, ' ')), color: '#c6ff3d', icon: 'eye' };
  const insMeta = (t) => INSIGHT_TYPES[t] || { label: cap(String(t || 'Insight').replace(/-/g, ' ')), color: '#8a97a8', icon: 'eye' };

  // ------------------------------------------------------------------ state
  const state = {
    alerts: [],                 // newest first
    alertIds: new Set(),
    subs: [],
    movers: [],
    vix: null,
    vixHistory: [],             // [{t, overall}]
    health: null,
    backendUp: null,
    connected: false,
    category: '',
    feedFilter: 'all',
    sound: false,
    markets: new Map(),         // id -> market (best known)
    histCache: new Map(),       // id -> {points, at}
    prevProb: new Map(),        // id -> last rendered prob (for tick flash)
    editingId: null,
    formMarketIds: [],
    drawerId: null,
    drawerRange: 6 * 3600e3,
    lastTick: null,
    hideNoise: false,
    muted: new Map(),           // marketId -> until (ms)
    unread: 0,
    // v2
    persona: 'general',
    shots: [],                  // current ranked list for persona+category
    shotsStatus: 'loading',     // loading | ok | empty | unavailable
    shotsAt: 0,
    shotsExpanded: false,
    shotsBaseline: null,        // Set of top-3 keys to diff against (null = do not notify yet)
    shotRanks: new Map(),       // key -> last rank (for rank-change chips)
    shotDrama: new Map(),       // key -> last drama (ring animation)
    insights: [],               // newest first
    insightIds: new Set(),
    insightsAvailable: null,
    stories: [],
    briefing: null,
    wire: 'all',                // all | spikes | insights
    forecasts: new Map(),       // marketId -> {fc, at} | {missing:true, at}
  };
  const THIN_LIQUIDITY = 10000;

  // ------------------------------------------------------------------ mute / snooze
  function loadMuted() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS.muted) || '{}');
      for (const [k, v] of Object.entries(raw)) if (Number(v) > Date.now()) state.muted.set(k, Number(v));
    } catch { /* ignore */ }
  }
  function saveMuted() { localStorage.setItem(LS.muted, JSON.stringify(Object.fromEntries(state.muted))); }
  function isMuted(id) {
    const until = state.muted.get(id);
    if (!until) return false;
    if (until <= Date.now()) { state.muted.delete(id); saveMuted(); return false; }
    return true;
  }
  function muteMarket(id, ms = 3600e3, title = '') {
    state.muted.set(id, Date.now() + ms);
    saveMuted();
    renderFeed();
    if (state.drawerId === id) renderDrawerMute();
    toast(`Muted "${truncate(title || id, 50)}" for 1h.`, 'ok', 5000, { label: 'Undo', fn: () => unmuteMarket(id) });
  }
  function unmuteMarket(id) {
    state.muted.delete(id);
    saveMuted();
    renderFeed();
    if (state.drawerId === id) renderDrawerMute();
  }
  function renderMutedInfo() {
    const el = $('#muted-info');
    const n = Array.from(state.muted.keys()).filter(isMuted).length;
    if (!n) { el.replaceChildren(); return; }
    el.replaceChildren(`${n} muted · `, h('button', { type: 'button', class: 'link-btn', text: 'Unmute all', onclick: () => { state.muted.clear(); saveMuted(); renderFeed(); if (state.drawerId) renderDrawerMute(); } }));
  }

  // ------------------------------------------------------------------ unread badge (tab title + favicon)
  const BASE_TITLE = document.title;
  let baseFavicon = null;
  function setUnread(n) {
    state.unread = n;
    document.title = n ? `(${n}) ${BASE_TITLE}` : BASE_TITLE;
    const link = document.querySelector('link[rel="icon"]');
    if (!link) return;
    if (baseFavicon == null) baseFavicon = link.getAttribute('href');
    if (!n) { link.setAttribute('href', baseFavicon); return; }
    const label = n > 99 ? '99+' : String(n);
    const fs = label.length > 2 ? 11 : label.length > 1 ? 14 : 17;
    const svgTxt = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#07090d"/><circle cx="16" cy="16" r="11" fill="none" stroke="#c6ff3d" stroke-width="2.2" opacity=".35"/><circle cx="16" cy="16" r="15" fill="#ff4d6a"/><text x="16" y="${16 + fs * 0.36}" font-family="Arial,Helvetica,sans-serif" font-weight="900" font-size="${fs}" fill="#fff" text-anchor="middle">${label}</text></svg>`;
    link.setAttribute('href', `data:image/svg+xml,${encodeURIComponent(svgTxt)}`);
  }

  // ------------------------------------------------------------------ copy helpers
  function windowLong(ms) {
    if (!isNum(ms) || ms <= 0) return '';
    const sec = Math.round(ms / 1000);
    if (sec < 60) return `in ${sec} sec`;
    const m = Math.round(sec / 60);
    if (m < 60) return `in ${m} min`;
    const hr = m / 60;
    return `in ${hr % 1 ? hr.toFixed(1) : hr} hr`;
  }
  /** Flighty-style plain-English line: "“Yes” odds jumped 38% → 61% in 12 min." */
  function headline(sp) {
    const up = (sp.delta || 0) >= 0;
    const major = sp.severity === 'major';
    const verb = up ? (major ? 'surged' : 'jumped') : (major ? 'plunged' : 'dropped');
    const o = String(sp.outcome || '').trim();
    const subj = !o || /^yes$/i.test(o) ? 'Odds' : `“${truncate(o, 40)}” odds`;
    return `${subj} ${verb} ${pct(sp.from)} → ${pct(sp.to)} ${windowLong(sp.windowMs)}`.trim() + '.';
  }
  function venueBadge(source) {
    if (!source) return null;
    const key = String(source).toLowerCase();
    return h('span', { class: `venue ${key === 'polymarket' || key === 'kalshi' ? key : ''}`, text: key === 'polymarket' ? 'Polymarket' : key === 'kalshi' ? 'Kalshi' : cap(source) });
  }
  function isThin(m) {
    return !!m && isNum(m.liquidity) && m.liquidity > 0 && m.liquidity < THIN_LIQUIDITY;
  }
  function thinBadge(m) {
    return isThin(m) ? h('span', { class: 'badge thin', title: `Thin market: ~$${Math.round(m.liquidity).toLocaleString()} liquidity, moves may be noisy`, text: 'Thin' }) : null;
  }
  const DRIVER_TEXT = {
    zScore: 'big move vs its usual volatility', zscore: 'big move vs its usual volatility', z_score: 'big move vs its usual volatility',
    liquidity: 'deep liquidity', volume24h: 'heavy 24h volume', volume: 'heavy volume', delta: 'large absolute move', absDelta: 'large absolute move',
    windowMs: 'happened fast', speed: 'happened fast', live: 'event is live', spread: 'tight spread', crossVenue: 'confirmed on other venue',
  };
  function driverText(d) {
    if (!d) return '';
    if (d.label || d.text) return String(d.label || d.text);
    const f = String(d.feature || '');
    const neg = isNum(d.impact) && d.impact < 0;
    if (DRIVER_TEXT[f]) {
      if (neg && f === 'liquidity') return 'thin liquidity';
      if (neg && /volume/i.test(f)) return 'low volume';
      return DRIVER_TEXT[f];
    }
    return f.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
  }
  function signalBlock(sp) {
    const ml = sp.ml;
    if (!ml || !isNum(ml.pReal)) return null;
    const p = clamp(ml.pReal, 0, 1);
    const label = ['event', 'likely', 'noise'].includes(ml.label) ? ml.label : p >= 0.7 ? 'event' : p >= 0.4 ? 'likely' : 'noise';
    const tagText = { event: 'Real event', likely: 'Likely real', noise: 'Likely noise' }[label];
    const drivers = (Array.isArray(ml.drivers) ? ml.drivers : []).filter((d) => d && (d.feature || d.label || d.text))
      .sort((a, b) => Math.abs(b.impact || 0) - Math.abs(a.impact || 0)).slice(0, 3);
    return [
      h('div', { class: `signal ${label}`, title: 'Signal model: probability this move reflects a real-world event rather than noise' },
        h('span', { class: 's-lbl' }, 'Signal: ', h('b', { text: `${Math.round(p * 100)}%` }), ' real'),
        h('span', { class: 'meter', attrs: { 'aria-hidden': 'true' } }, h('i', { style: `width:${(p * 100).toFixed(0)}%` })),
        h('span', { class: 's-tag', text: tagText })),
      drivers.length ? h('div', { class: 'drivers' }, drivers.map((d) => h('span', { class: `driver ${isNum(d.impact) && d.impact < 0 ? 'neg' : 'pos'}`, text: driverText(d) }))) : null,
    ];
  }
  const isNoise = (sp) => !!(sp.ml && (sp.ml.label === 'noise' || (!sp.ml.label && isNum(sp.ml.pReal) && sp.ml.pReal < 0.4)));

  // ------------------------------------------------------------------ DOM helpers
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const SVGNS = 'http://www.w3.org/2000/svg';

  /** Build an element. props: class, text, attrs, dataset, on*, style. children: nodes or strings (as text). */
  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    applyProps(node, props);
    appendChildren(node, children);
    return node;
  }
  function s(tag, attrs = {}, ...children) {
    const node = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'text') node.textContent = String(v);
      else if (k === 'class') node.setAttribute('class', v);
      else node.setAttribute(k, String(v));
    }
    appendChildren(node, children);
    return node;
  }
  function applyProps(node, props) {
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = String(v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k === 'attrs') for (const [a, av] of Object.entries(v)) { if (av != null && av !== false) node.setAttribute(a, String(av)); }
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'style') node.style.cssText = v;
      else node[k] = v;
    }
  }
  function appendChildren(node, children) {
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
  }
  /** Replace an element's children, skipping null/false (replaceChildren would stringify them). */
  function fill(node, ...children) { node.replaceChildren(); appendChildren(node, children); return node; }
  /** Only allow http(s) links from the API. */
  function safeUrl(u) {
    try { const url = new URL(String(u), location.href); return /^https?:$/.test(url.protocol) ? url.href : null; } catch { return null; }
  }

  // ------------------------------------------------------------------ formatting
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  function pct(p) {
    if (!isNum(p)) return '--';
    const v = p * 100;
    if (v > 0 && v < 1) return '<1%';
    if (v < 100 && v > 99) return '>99%';
    return `${Math.round(v)}%`;
  }
  function pct1(p) { return isNum(p) ? `${(p * 100).toFixed(1)}%` : '--'; }
  function pts(d, withArrow = false) {
    if (!isNum(d)) return '--';
    const v = d * 100;
    const sign = v > 0 ? '+' : v < 0 ? '−' : '±';
    const arrow = withArrow ? (v > 0 ? '▲ ' : v < 0 ? '▼ ' : '') : '';
    return `${arrow}${sign}${Math.abs(v).toFixed(1)} pts`;
  }
  function ptsShort(d) {
    if (!isNum(d)) return '—';
    const v = d * 100;
    if (Math.abs(v) < 0.05) return '0.0';
    return `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`;
  }
  const dir = (d) => (!isNum(d) || Math.abs(d) < 0.0005 ? 'flat' : d > 0 ? 'up' : 'down');
  function ago(ts) {
    const t = typeof ts === 'number' ? ts : Date.parse(ts);
    if (!isNum(t)) return '';
    const sec = Math.round((Date.now() - t) / 1000);
    if (sec < 5) return 'just now';
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return `${Math.floor(sec / 86400)}d ago`;
  }
  function windowText(ms) {
    if (!isNum(ms) || ms <= 0) return '';
    const sec = Math.round(ms / 1000);
    if (sec < 60) return `in ${sec}s`;
    const m = Math.round(sec / 60);
    if (m < 60) return `in ${m}m`;
    return `in ${(m / 60).toFixed(m % 60 ? 1 : 0)}h`;
  }
  function clock(t) {
    return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  function dayClock(t) {
    return new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }
  function vixLevel(v) {
    if (!isNum(v)) return { key: '', label: 'Waiting for data' };
    if (v < 25) return { key: 'calm', label: 'Calm' };
    if (v < 50) return { key: 'active', label: 'Active' };
    if (v < 75) return { key: 'heated', label: 'Heated' };
    return { key: 'chaotic', label: 'Chaotic' };
  }
  const cap = (x) => String(x || '').charAt(0).toUpperCase() + String(x || '').slice(1);

  // ------------------------------------------------------------------ API
  async function api(path, opts = {}) {
    const init = { method: opts.method || 'GET', headers: {}, signal: AbortSignal.timeout ? AbortSignal.timeout(opts.timeout || 12000) : undefined };
    if (opts.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
    const res = await fetch(path, init);
    let data = null;
    const text = await res.text();
    if (text) { try { data = JSON.parse(text); } catch { data = null; } }
    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || `${res.status} ${res.statusText}`;
      throw new Error(String(msg));
    }
    return data;
  }
  const histPath = (id) => `/api/markets/${encodeURIComponent(id)}/history`;

  // ------------------------------------------------------------------ toasts
  function toast(msg, kind = 'ok', ms = 3600, action = null) {
    const t = h('div', { class: `toast ${kind === 'ok' ? '' : kind}`, text: msg });
    if (action) {
      t.append(' ', h('button', { type: 'button', class: 'link-btn', style: 'color:var(--accent)', text: action.label,
        onclick: () => { action.fn(); t.remove(); } }));
    }
    $('#toasts').appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, ms);
  }

  // ------------------------------------------------------------------ market cache
  function rememberMarket(m) {
    if (!m || !m.id) return;
    const prev = state.markets.get(m.id) || {};
    state.markets.set(m.id, { ...prev, ...m });
  }
  function marketFromSpike(sp) {
    return { id: sp.marketId, title: sp.title, source: sp.source, category: sp.category, tags: sp.tags, url: sp.url, outcome: sp.outcome, probability: sp.to, live: sp.live };
  }

  // ------------------------------------------------------------------ number ticking
  function tickNumber(el, to, fmt, ms = 700) {
    const from = isNum(el._val) ? el._val : null;
    el._val = to;
    if (from == null || !isNum(to) || from === to || matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = fmt(to); return; }
    const start = performance.now();
    cancelAnimationFrame(el._raf);
    const step = (now) => {
      const k = clamp((now - start) / ms, 0, 1);
      const e = 1 - Math.pow(1 - k, 3);
      el.textContent = fmt(from + (to - from) * e);
      if (k < 1) el._raf = requestAnimationFrame(step);
    };
    el._raf = requestAnimationFrame(step);
  }
  function flash(el, up) {
    el.classList.remove('flash-up', 'flash-down');
    void el.offsetWidth;
    el.classList.add(up ? 'flash-up' : 'flash-down');
  }

  // ------------------------------------------------------------------ sound
  let audioCtx = null;
  function beep(kind = 'up') {
    if (!state.sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const now = audioCtx.currentTime;
      const notes = kind === 'major' ? [880, 1175, 1568] : kind === 'down' ? [740, 494] : [660, 990];
      notes.forEach((f, i) => {
        const osc = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = f;
        const t0 = now + i * 0.09;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.18, t0 + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
        osc.connect(g).connect(audioCtx.destination);
        osc.start(t0);
        osc.stop(t0 + 0.18);
      });
    } catch { /* audio unavailable */ }
  }
  function setSound(on) {
    state.sound = on;
    localStorage.setItem(LS.sound, on ? '1' : '0');
    const b = $('#btn-sound');
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    b.title = on ? 'Sound on (m)' : 'Sound off (m)';
    if (on) beep('up');
  }

  // ------------------------------------------------------------------ notifications
  function notifySupported() { return 'Notification' in window; }
  function renderNotifyBtn() {
    const b = $('#btn-notify');
    const lbl = $('.lbl', b);
    if (!notifySupported()) { lbl.textContent = 'No notifications'; b.disabled = true; return; }
    const p = Notification.permission;
    b.classList.toggle('on', p === 'granted');
    lbl.textContent = p === 'granted' ? 'Alerts on' : p === 'denied' ? 'Alerts blocked' : 'Enable alerts';
    b.title = p === 'denied' ? 'Notifications are blocked in your browser settings' : 'Browser notifications (n)';
  }
  async function enableNotifications() {
    if (!notifySupported()) { toast('This browser does not support notifications.', 'warn'); return; }
    if (Notification.permission === 'granted') {
      toast(state.subs.length ? 'Alerts are on for your subscriptions.' : 'Alerts are on for all notable spikes.');
      return;
    }
    if (Notification.permission === 'denied') { toast('Notifications are blocked. Allow them in your browser site settings.', 'warn', 5000); return; }
    try {
      const p = await Notification.requestPermission();
      renderNotifyBtn();
      if (p === 'granted') {
        toast('Alerts enabled. We\'ll ping you when the odds jump.');
        try { new Notification('Tipoff alerts are on', { body: 'The odds move before the headlines do.', icon: 'favicon.svg', tag: 'tipoff-hello' }); } catch { /* some browsers need SW */ }
      }
    } catch { toast('Could not request notification permission.', 'err'); }
  }
  function shouldNotify(sp) {
    if (isMuted(sp.marketId) || (state.hideNoise && isNoise(sp))) return false;
    if (Array.isArray(sp.matchedSubscriptions) && sp.matchedSubscriptions.length) return true;
    if (!state.subs.length) return SEV_RANK[sp.severity] >= SEV_RANK.notable;
    return state.subs.some((sub) => matchSub(sub, sp));
  }
  function systemNotify(sp) {
    if (!notifySupported() || Notification.permission !== 'granted') return;
    try {
      const fb = { title: `${isVol(sp) ? '〰 ' + volLabel(sp) + ' · ' : `${sp.delta >= 0 ? '▲' : '▼'} ${pct(sp.to)} `}${sp.title || 'Market spike'}`,
        body: `${sp.outcome ? sp.outcome + ': ' : ''}${pct(sp.from)} → ${pct(sp.to)} (${pts(sp.delta)}) ${windowText(sp.windowMs)}${sp.live ? ' · LIVE' : ''}` };
      const rn = roleNotice(sp, fb.title, fb.body);
      const n = new Notification(rn.title, {
        body: rn.title === fb.title ? fb.body : `${rn.body}${rn.body ? '\n' : ''}${truncate(sp.title, 80)} · ${pct(sp.from)} → ${pct(sp.to)}`,
        tag: sp.id,
        icon: 'favicon.svg',
        renotify: false,
      });
      n.onclick = () => { window.focus(); openDrawer(sp.marketId); n.close(); };
    } catch { /* ignore */ }
  }

  // ------------------------------------------------------------------ subscription matching (client mirror of server rule)
  function matchSub(sub, sp) {
    if (!sub || !sp) return false;
    const m = sub.match || {};
    const title = String(sp.title || '').toLowerCase();
    const tags = (sp.tags || []).map((t) => String(t).toLowerCase());
    if (m.keywords && m.keywords.length) {
      const ok = m.keywords.some((k) => { const kk = String(k).toLowerCase(); return kk && (title.includes(kk) || tags.some((t) => t.includes(kk))); });
      if (!ok) return false;
    }
    if (m.categories && m.categories.length && !m.categories.includes(sp.category)) return false;
    if (m.sources && m.sources.length && !m.sources.includes(sp.source)) return false;
    if (m.marketIds && m.marketIds.length && !m.marketIds.includes(sp.marketId)) return false;
    if (isNum(sub.minDelta) && Math.abs(sp.delta || 0) < sub.minDelta - 1e-9) return false;
    if (sub.minSeverity && (SEV_RANK[sp.severity] ?? 0) < (SEV_RANK[sub.minSeverity] ?? 0)) return false;
    if (sub.liveOnly && !sp.live) return false;
    return true;
  }
  function isMine(sp) {
    if (Array.isArray(sp.matchedSubscriptions) && sp.matchedSubscriptions.some((id) => state.subs.some((s2) => s2.id === id))) return true;
    return state.subs.some((sub) => matchSub(sub, sp));
  }

  // ------------------------------------------------------------------ category nav
  function renderCatNav() {
    const nav = $('#catnav');
    const by = (state.vix && state.vix.byCategory) || {};
    const pills = [{ key: '', label: 'All', emoji: '⚡' }, ...CATEGORIES.map((c) => ({ key: c, label: cap(c), emoji: CAT_EMOJI[c] }))];
    nav.replaceChildren(...pills.map((p, i) => {
      const v = p.key ? by[p.key] : state.vix && state.vix.overall;
      return h('button', {
        type: 'button', class: `cat-pill${state.category === p.key ? ' active' : ''}`,
        attrs: { 'aria-pressed': String(state.category === p.key), title: `${p.label} (${i})` },
        onclick: () => setCategory(p.key),
      }, h('span', { attrs: { 'aria-hidden': 'true' }, text: p.emoji }), p.label,
      isNum(v) ? h('span', { class: `heat num${v >= 50 ? ' hot' : ''}`, text: Math.round(v) }) : null);
    }));
  }
  function setCategory(cat) {
    state.category = cat;
    localStorage.setItem(LS.cat, cat);
    renderCatNav();
    renderRadar();
    renderFeed();
    renderMovers();
    runSearch();
    state.shotsBaseline = null;
    renderStories();
    loadShots(true);
  }

  // ------------------------------------------------------------------ line chart (shared by seismograph + drawer)
  function renderLineChart(svg, tip, pts0, opts) {
    const W = Math.max(120, Math.round(svg.clientWidth || 600));
    const H = Math.max(80, Math.round(svg.clientHeight || 160));
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    const pad = { l: 8, r: opts.padR ?? 40, t: 12, b: opts.padB ?? 18 };
    const pts1 = pts0.filter((p) => isNum(p.t) && isNum(p.v)).sort((a, b) => a.t - b.t);
    const kids = [];
    const gid = `${svg.id}-fill`;
    kids.push(s('defs', {}, s('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 },
      s('stop', { offset: '0%', 'stop-color': opts.color, 'stop-opacity': 0.32 }),
      s('stop', { offset: '100%', 'stop-color': opts.color, 'stop-opacity': 0 }))));

    let yMin = opts.yMin, yMax = opts.yMax;
    if (opts.auto && pts1.length) {
      const vs = pts1.map((p) => p.v).concat((opts.fires || []).map((f) => f.v).filter(isNum));
      let lo = Math.min(...vs), hi = Math.max(...vs);
      const minSpan = opts.minSpan || 0.1;
      if (hi - lo < minSpan) { const mid = (hi + lo) / 2; lo = mid - minSpan / 2; hi = mid + minSpan / 2; }
      const padv = (hi - lo) * 0.12;
      yMin = Math.max(opts.yMin, lo - padv); yMax = Math.min(opts.yMax, hi + padv);
    }
    const tMax = opts.tMax ?? (pts1.length ? pts1[pts1.length - 1].t : Date.now());
    const tMin = opts.tMin ?? (pts1.length ? pts1[0].t : tMax - 3600e3);
    const tSpan = Math.max(1, tMax - tMin);
    const X = (t) => pad.l + ((t - tMin) / tSpan) * (W - pad.l - pad.r);
    const Y = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - pad.t - pad.b);

    // grid + labels
    const g = s('g', { class: 'grid' });
    const ticks = opts.yTicks || 4;
    for (let i = 0; i <= ticks; i++) {
      const v = yMin + ((yMax - yMin) * i) / ticks;
      const y = Y(v);
      g.appendChild(s('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y }));
      g.appendChild(s('text', { x: W - pad.r + 6, y: y + 3, fill: '#566273', 'font-size': 10, 'font-family': 'ui-monospace, Menlo, monospace', text: opts.fmtAxis(v) }));
    }
    const vticks = opts.xTicks || 6;
    for (let i = 0; i <= vticks; i++) {
      const x = pad.l + (i / vticks) * (W - pad.l - pad.r);
      g.appendChild(s('line', { x1: x, x2: x, y1: pad.t, y2: H - pad.b }));
    }
    if (opts.padB !== 0 && pts1.length > 1) {
      g.appendChild(s('text', { x: pad.l, y: H - 4, fill: '#566273', 'font-size': 10, 'font-family': 'ui-monospace, Menlo, monospace', text: tSpan > 12 * 3600e3 ? dayClock(tMin) : clock(tMin) }));
      g.appendChild(s('text', { x: W - pad.r, y: H - 4, fill: '#566273', 'font-size': 10, 'font-family': 'ui-monospace, Menlo, monospace', 'text-anchor': 'end', text: tSpan > 12 * 3600e3 ? dayClock(tMax) : clock(tMax) }));
    }
    kids.push(g);

    (opts.windows || []).forEach((w) => {
      const a = clamp(w.t0, tMin, tMax), b = clamp(w.t1, tMin, tMax);
      if (b > a || (w.t1 >= tMin && w.t0 <= tMax)) kids.push(s('rect', { class: 'win', x: X(a), y: pad.t, width: Math.max(2, X(b) - X(a)), height: H - pad.t - pad.b }));
    });
    (opts.markers || []).forEach((t) => { if (t >= tMin && t <= tMax) kids.push(s('line', { class: 'spike-mark', x1: X(t), x2: X(t), y1: pad.t, y2: H - pad.b })); });

    if (pts1.length >= 2) {
      const d = pts1.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
      const last = pts1[pts1.length - 1];
      kids.push(s('path', { d: `${d}L${X(last.t).toFixed(1)},${H - pad.b}L${X(pts1[0].t).toFixed(1)},${H - pad.b}Z`, fill: `url(#${gid})` }));
      kids.push(s('path', { class: opts.lineClass || 'ln', d, stroke: opts.color }));
      (opts.fires || []).forEach((f) => {
        if (f.t >= tMin && f.t <= tMax && isNum(f.v)) kids.push(s('circle', { class: 'fire', cx: X(f.t), cy: Y(clamp(f.v, yMin, yMax)), r: 5 }, s('title', { text: f.label || 'Alert fired' })));
      });
      if (opts.pen) {
        kids.push(s('circle', { class: 'pen-ring', cx: X(last.t), cy: Y(last.v), r: 5 }));
        kids.push(s('circle', { class: 'pen', cx: X(last.t), cy: Y(last.v), r: 3.5 }));
      }
    } else {
      kids.push(s('text', { class: 'seismo-empty', x: W / 2, y: H / 2, 'text-anchor': 'middle', fill: '#566273', 'font-size': 12, text: opts.emptyText || 'Collecting data…' }));
    }
    const cross = s('line', { class: 'cross', x1: 0, x2: 0, y1: pad.t, y2: H - pad.b, visibility: 'hidden' });
    const dot = s('circle', { class: 'dot', r: 4.5, fill: opts.color, visibility: 'hidden' });
    kids.push(cross, dot);
    svg.replaceChildren(...kids);

    svg._chart = { pts: pts1, X, Y, cross, dot, tip, fmtTip: opts.fmtTip };
    if (!svg._bound) {
      svg._bound = true;
      const move = (ev) => {
        const c = svg._chart;
        if (!c || c.pts.length < 2) return;
        const r = svg.getBoundingClientRect();
        const vb = svg.viewBox.baseVal;
        const mx = ((ev.clientX - r.left) / r.width) * vb.width;
        let best = c.pts[0], bd = Infinity;
        for (const p of c.pts) { const dd = Math.abs(c.X(p.t) - mx); if (dd < bd) { bd = dd; best = p; } }
        const x = c.X(best.t), y = c.Y(best.v);
        c.cross.setAttribute('x1', x); c.cross.setAttribute('x2', x); c.cross.setAttribute('visibility', 'visible');
        c.dot.setAttribute('cx', x); c.dot.setAttribute('cy', y); c.dot.setAttribute('visibility', 'visible');
        if (c.tip) {
          c.tip.hidden = false;
          c.tip.replaceChildren(h('span', { text: c.fmtTip(best.v) }), ' ', h('span', { class: 'tt', text: clock(best.t) }));
          const pr = (c.tip.offsetParent || svg.parentElement).getBoundingClientRect();
          c.tip.style.left = `${r.left - pr.left + (x / vb.width) * r.width}px`;
          c.tip.style.top = `${r.top - pr.top + (y / vb.height) * r.height - 6}px`;
        }
      };
      const leave = () => {
        const c = svg._chart; if (!c) return;
        c.cross.setAttribute('visibility', 'hidden'); c.dot.setAttribute('visibility', 'hidden');
        if (c.tip) c.tip.hidden = true;
      };
      svg.addEventListener('pointermove', move);
      svg.addEventListener('pointerdown', move);
      svg.addEventListener('pointerleave', leave);
    }
  }

  // ------------------------------------------------------------------ VIX hero
  function renderVix() {
    const v = state.vix && isNum(state.vix.overall) ? clamp(state.vix.overall, 0, 100) : null;
    const valEl = $('#vix-value');
    if (v == null) valEl.textContent = '--';
    else tickNumber(valEl, v, (x) => String(Math.round(x)), 900);
    const lvl = vixLevel(v);
    const lab = $('#vix-label');
    lab.textContent = lvl.label;
    lab.dataset.level = lvl.key;
    valEl.style.color = { calm: 'var(--up)', active: '#ffd84d', heated: '#ff8a3d', chaotic: 'var(--down)' }[lvl.key] || '';
    $('#vix-meter-fill').style.width = `${100 - (v ?? 0)}%`;
    $('#vix-meter-pin').style.left = `${v ?? 0}%`;

    // delta vs ~1h ago
    const dEl = $('#vix-delta');
    const hist = state.vixHistory;
    if (v != null && hist.length > 1) {
      const target = Date.now() - 3600e3;
      let ref = hist[0];
      for (const p of hist) { if (p.t <= target) ref = p; else break; }
      const d = v - ref.overall;
      dEl.textContent = `${d >= 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(1)} vs 1h`;
      dEl.style.color = Math.abs(d) < 0.5 ? 'var(--dim)' : d > 0 ? 'var(--down)' : 'var(--up)';
    } else dEl.textContent = '';
    const upd = state.vix && state.vix.updatedAt;
    const updEl = $('#vix-updated');
    if (upd) { updEl.dataset.ts = upd; updEl.dataset.prefix = 'updated '; updEl.textContent = `updated ${ago(upd)}`; }
    renderSeismo();
    renderRadar();
    renderCatNav();
  }
  function renderSeismo() {
    const now = Date.now();
    const pts1 = state.vixHistory.filter((p) => p.t >= now - VIX_WINDOW_MS).map((p) => ({ t: p.t, v: p.overall }));
    renderLineChart($('#seismo'), $('#seismo-tip'), pts1, {
      yMin: 0, yMax: 100, yTicks: 4, xTicks: 12, color: '#c6ff3d', lineClass: 'trace', pen: true, padR: 30, padB: 0,
      tMin: now - VIX_WINDOW_MS, tMax: now,
      fmtAxis: (x) => String(Math.round(x)), fmtTip: (x) => `VIX ${x.toFixed(1)}`,
      emptyText: state.backendUp === false ? 'Waiting for the server…' : 'Recording the first tremors…',
    });
  }
  function renderRadar() {
    const svg = $('#radar');
    const by = (state.vix && state.vix.byCategory) || {};
    const cats = CATEGORIES;
    const cx = 110, cy = 110, R = 72;
    const ang = (i) => -Math.PI / 2 + (i / cats.length) * Math.PI * 2;
    const pt = (i, r) => [cx + Math.cos(ang(i)) * r, cy + Math.sin(ang(i)) * r];
    const kids = [s('defs', {}, s('radialGradient', { id: 'radarSweepGrad', cx: 0, cy: 0.5, r: 1 },
      s('stop', { offset: '0%', 'stop-color': '#c6ff3d', 'stop-opacity': 0.0 }),
      s('stop', { offset: '100%', 'stop-color': '#c6ff3d', 'stop-opacity': 0.0 })),
      s('linearGradient', { id: 'radarSweep', x1: 0, y1: 0, x2: 1, y2: 0 },
        s('stop', { offset: '0%', 'stop-color': '#c6ff3d', 'stop-opacity': 0 }),
        s('stop', { offset: '100%', 'stop-color': '#c6ff3d', 'stop-opacity': 0.22 })))];
    [0.25, 0.5, 0.75, 1].forEach((f) => kids.push(s('polygon', { class: 'ring', points: cats.map((_, i) => pt(i, R * f).join(',')).join(' ') })));
    cats.forEach((_, i) => { const [x, y] = pt(i, R); kids.push(s('line', { class: 'spoke', x1: cx, y1: cy, x2: x, y2: y })); });
    // sweep wedge
    const a0 = -Math.PI / 2, a1 = a0 + 0.6;
    kids.push(s('path', { class: 'sweep', d: `M${cx},${cy}L${cx + Math.cos(a0) * R},${cy + Math.sin(a0) * R}A${R},${R} 0 0 1 ${cx + Math.cos(a1) * R},${cy + Math.sin(a1) * R}Z` }));
    const vals = cats.map((c) => clamp(isNum(by[c]) ? by[c] : 0, 0, 100));
    const shapePts = vals.map((v, i) => pt(i, R * Math.max(0.04, v / 100)).join(',')).join(' ');
    kids.push(s('polygon', { class: 'shape', points: shapePts }));
    vals.forEach((v, i) => { const [x, y] = pt(i, R * Math.max(0.04, v / 100)); kids.push(s('circle', { class: 'vtx', cx: x, cy: y, r: 2.5 })); });
    cats.forEach((c, i) => {
      const [x, y] = pt(i, R + 18);
      const anchor = Math.abs(x - cx) < 6 ? 'middle' : x > cx ? 'start' : 'end';
      const g = s('g', { style: 'cursor:pointer', role: 'button', tabindex: 0, 'aria-label': `Filter ${c}` });
      g.appendChild(s('text', { class: `lbl${state.category === c ? ' active' : ''}`, x, y: y - 2, 'text-anchor': anchor, text: c.slice(0, 5) === 'enter' ? 'ENTERTAIN.' : c.toUpperCase() }));
      g.appendChild(s('text', { class: 'lv', x, y: y + 9, 'text-anchor': anchor, text: isNum(by[c]) ? Math.round(by[c]) : '–' }));
      g.addEventListener('click', () => setCategory(state.category === c ? '' : c));
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCategory(state.category === c ? '' : c); } });
      kids.push(g);
    });
    svg.replaceChildren(...kids);
  }

  // ------------------------------------------------------------------ alert feed
  function passesFeed(sp) {
    if (state.wire === 'insights') return false;
    if (isMuted(sp.marketId)) return false;
    if (state.hideNoise && isNoise(sp)) return false;
    if (state.category && sp.category !== state.category) return false;
    if (state.feedFilter === 'notable' && (SEV_RANK[sp.severity] ?? 0) < 1) return false;
    if (state.feedFilter === 'mine' && !isMine(sp)) return false;
    return true;
  }
  function spikeCard(sp, animate, more = 0) {
    const d = dir(sp.delta);
    const mine = isMine(sp);
    const url = safeUrl(sp.url);
    const from = clamp(Number(sp.from) || 0, 0, 1), to = clamp(Number(sp.to) || 0, 0, 1);
    const lo = Math.min(from, to), hi = Math.max(from, to);
    const mk = state.markets.get(sp.marketId);
    const startT = (Date.parse(sp.detectedAt) || Date.now()) - (Number(sp.windowMs) || 0);
    const li = h('li', {
      class: `spike ${d} sev-${sp.severity || 'info'}${isVol(sp) ? ' vol' : ''}${mine ? ' mine' : ''}${animate ? ' arrive' : ''}${isNoise(sp) ? ' is-noise' : ''}`,
      dataset: { id: sp.id || '', market: sp.marketId || '' },
      attrs: { tabindex: 0, 'aria-label': `${sp.title || 'Market'} moved ${pts(sp.delta)}` },
      onclick: (e) => { if (!e.target.closest('a')) openDrawer(sp.marketId, sp); },
      onkeydown: (e) => { if (e.key === 'Enter') openDrawer(sp.marketId, sp); },
    },
      sp.severity === 'major' ? h('span', { class: 'ring', attrs: { 'aria-hidden': 'true' } }) : null,
      h('div', { class: 'spike-meta' },
        isVol(sp) ? h('span', { class: 'badge thrash', attrs: { title: isNum(sp.volShort) && isNum(sp.volBase) ? `Short-window volatility ${(sp.volShort * 100).toFixed(2)} vs baseline ${(sp.volBase * 100).toFixed(2)}` : 'Volatility spike' } }, icon('seismic'), volLabel(sp)) : null,
        sp.severity && sp.severity !== 'info' ? h('span', { class: `badge sev-${sp.severity}`, text: sp.severity }) : null,
        sp.live ? h('span', { class: 'badge live', text: 'Live' }) : null,
        sp.demo ? h('span', { class: 'badge demo', text: 'Demo' }) : null,
        mine ? h('span', { class: 'badge mine', text: '★ Mine' }) : null,
        sp.category ? h('span', { class: 'cat-chip', text: sp.category }) : null,
        venueBadge(sp.source),
        thinBadge(mk),
        more > 0 ? h('span', { class: 'thread-pill', title: `${more} earlier spike${more === 1 ? '' : 's'} on this market`, text: `+${more} more` }) : null,
        h('span', { class: 'ago', dataset: { ts: sp.detectedAt || '' }, text: ago(sp.detectedAt) })),
      h('div', {},
        h('div', { class: 'spike-title', text: sp.title || 'Untitled market' }),
        sp.outcome ? h('div', { class: 'spike-outcome' }, 'Outcome: ', h('b', { text: sp.outcome })) : null),
      h('div', { class: 'spike-move' },
        h('div', { class: 'to num', text: pct(sp.to) }),
        h('div', { class: 'delta num', text: pts(sp.delta, true) })),
      h('div', { class: 'probbar', attrs: { 'aria-hidden': 'true' } },
        h('i', { class: 'from', style: `width:${(lo * 100).toFixed(1)}%` }),
        h('i', { class: 'span', style: `left:${(lo * 100).toFixed(1)}%;width:${Math.max(0.6, (hi - lo) * 100).toFixed(1)}%` })),
      h('div', { class: 'spike-headline', text: isVol(sp) ? `Market just started thrashing: volatility ${isNum(sp.volRatio) ? `×${Number(sp.volRatio).toFixed(1)} its usual` : 'well above its usual'}${isNum(sp.delta) && Math.abs(sp.delta) >= 0.005 ? `, net ${pts(sp.delta)}` : ', no direction yet'}.` : headline(sp) }),
      contextChips(sp.context),
      recBlock(recFor(sp), sp.id, { compact: true }),
      signalBlock(sp),
      h('div', { class: 'spike-foot' },
        h('span', { class: 'fromto', text: `from ${pct(sp.from)} at ${clock(startT)}` }),
        h('span', { class: 'foot-actions' },
          h('button', { type: 'button', class: 'link-btn', text: 'Mute 1h', attrs: { title: 'Hide spikes from this market for an hour' },
            onclick: (e) => { e.stopPropagation(); muteMarket(sp.marketId, 3600e3, sp.title); } }),
          url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: `${cap(sp.source) || 'Open'} ↗` }) : null)));
    return li;
  }
  /** Group visible alerts by market (newest spike leads the thread). */
  function feedThreads() {
    const out = [];
    const byMarket = new Map();
    for (const sp of state.alerts) {
      if (!passesFeed(sp)) continue;
      const key = sp.marketId || sp.id;
      const th = byMarket.get(key);
      if (th) th.more++;
      else { const t = { sp, more: 0 }; byMarket.set(key, t); out.push(t); }
    }
    return out;
  }
  function renderFeed() {
    const items = feedThreads().map((t) => ({ t: toT(t.sp.detectedAt) || 0, node: () => spikeCard(t.sp, false, t.more) }))
      .concat(state.insights.filter(passesInsight).map((ins) => ({ t: toT(ins.createdAt) || 0, node: () => insightCard(ins, false) })))
      .sort((a, b) => b.t - a.t).slice(0, 150);
    $('#feed').replaceChildren(...items.map((it) => it.node()));
    $('#feed-count').textContent = String(items.length);
    renderFeedEmpty(items.length);
    renderMutedInfo();
  }
  function renderFeedEmpty(n) {
    const empty = $('#feed-empty');
    empty.hidden = n > 0;
    if (n > 0) return;
    const title = $('#feed-empty-title');
    const count = (state.lastTick && state.lastTick.marketCount) || (state.health && state.health.marketCount);
    if (state.backendUp === false) title.textContent = 'Waiting for the Tipoff server…';
    else if (state.feedFilter === 'mine' && !state.subs.length) title.textContent = 'Set up an alert to see your matches here';
    else if (state.wire === 'insights') title.textContent = state.insightsAvailable === false ? 'Insights aren\'t available on this server yet' : 'No insights yet. They appear as the crowd changes its mind.';
    else if (state.alerts.length && (state.category || state.feedFilter !== 'all')) title.textContent = `No ${state.category ? state.category + ' ' : ''}${state.feedFilter === 'notable' ? 'notable ' : state.feedFilter === 'mine' ? 'matching ' : ''}spikes yet`;
    else if (count) title.textContent = `Watching ${count.toLocaleString()} markets. Quiet so far.`;
    else title.textContent = state.connected ? 'Watching the markets. Quiet so far.' : 'Connecting to the markets…';
  }
  function addSpike(sp, { live = false } = {}) {
    if (!sp || !sp.id || state.alertIds.has(sp.id)) return false;
    state.alertIds.add(sp.id);
    state.alerts.unshift(sp);
    if (state.alerts.length > MAX_ALERTS) { const gone = state.alerts.pop(); state.alertIds.delete(gone.id); }
    rememberMarket(marketFromSpike(sp));
    const visible = passesFeed(sp);
    if (visible) {
      const feed = $('#feed');
      // Collapse into the market's existing thread card instead of stacking duplicates.
      const prior = Array.from(feed.children).find((c) => c.dataset.market && c.dataset.market === sp.marketId);
      if (prior) prior.remove();
      const more = state.alerts.filter((a) => a.marketId === sp.marketId && a.id !== sp.id && passesFeed(a)).length;
      const card = spikeCard(sp, live, more);
      if (prior && live) { card.classList.remove('arrive'); card.classList.add('arrive', 'bump'); }
      feed.prepend(card);
      while (feed.children.length > 150) feed.lastElementChild.remove();
      $('#feed-count').textContent = String(feed.children.length);
      renderFeedEmpty(feed.children.length);
    }
    if (live && visible) {
      island(sp);
      const notify = shouldNotify(sp);
      if (notify || state.sound) beep(sp.severity === 'major' ? 'major' : sp.delta < 0 ? 'down' : 'up');
      if (notify && (document.visibilityState !== 'visible' || !document.hasFocus())) systemNotify(sp);
      if (document.visibilityState !== 'visible' || !document.hasFocus()) setUnread(state.unread + 1);
    }
    if (live) {
      renderSubs();
      if (state.drawerId === sp.marketId) renderDrawerSpikes();
    }
    return true;
  }

  // ------------------------------------------------------------------ Dynamic Island
  function island(sp) {
    const host = $('#island');
    const d = dir(sp.delta);
    const pill = h('div', {
      class: `pill ${d} sev-${sp.severity || 'info'}${isVol(sp) ? ' vol' : ''}`,
      attrs: { role: 'button', tabindex: 0 },
      onclick: () => { openDrawer(sp.marketId, sp); dismiss(); },
    },
      isVol(sp) ? h('div', { class: 'p-ico' }, icon('seismic')) : h('div', { class: 'p-ico', text: d === 'down' ? '▼' : '▲' }),
      h('div', { class: 'p-body' },
        h('div', { class: 'p-kicker', text: `${isVol(sp) ? volLabel(sp) : sp.severity === 'major' ? 'Major spike' : 'Spike'}${sp.live ? ' · Live' : ''}${sp.demo ? ' · Demo' : ''} · ${sp.category || ''}` }),
        h('div', { class: 'p-title', text: (recFor(sp) && recFor(sp).headline) || sp.title || 'Market moved' })),
      h('div', { class: 'p-num' },
        h('div', { class: 'p-to', text: pct(sp.to) }),
        h('div', { class: 'p-d', text: pts(sp.delta) })));
    host.prepend(pill);
    while (host.children.length > 2) host.lastElementChild.remove();
    let gone = false;
    function dismiss() {
      if (gone) return; gone = true;
      pill.classList.add('out');
      setTimeout(() => pill.remove(), 400);
    }
    setTimeout(dismiss, sp.severity === 'major' ? 7000 : 5000);
  }

  // ------------------------------------------------------------------ movers + ticker tape
  let sparkQueue = [];
  let sparkActive = 0;
  const sparkObserver = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) { sparkObserver.unobserve(e.target); queueSpark(e.target); }
    }
  }, { rootMargin: '120px' }) : null;

  function queueSpark(svg) { sparkQueue.push(svg); pumpSparks(); }
  function pumpSparks() {
    while (sparkActive < 4 && sparkQueue.length) {
      const svg = sparkQueue.shift();
      if (!svg.isConnected) continue;
      sparkActive++;
      getHistory(svg.dataset.id).then((pts1) => drawSpark(svg, pts1)).catch(() => drawSpark(svg, [])).finally(() => { sparkActive--; pumpSparks(); });
    }
  }
  async function getHistory(id, maxAge = 60000) {
    const c = state.histCache.get(id);
    if (c && Date.now() - c.at < maxAge) return c.points;
    const data = await api(histPath(id));
    const points = (data && Array.isArray(data.points) ? data.points : []).map((p) => ({ t: typeof p.t === 'number' ? p.t : Date.parse(p.t), v: Number(p.p) })).filter((p) => isNum(p.t) && isNum(p.v));
    state.histCache.set(id, { points, at: Date.now() });
    return points;
  }
  function drawSpark(svg, pts1) {
    svg.classList.remove('loading');
    if (!pts1 || pts1.length < 2) {
      svg.replaceChildren(s('path', { d: 'M0,14L88,14', 'stroke-dasharray': '2 3' }));
      svg.setAttribute('class', 'spark flat');
      return;
    }
    const vs = pts1.map((p) => p.v);
    let lo = Math.min(...vs), hi = Math.max(...vs);
    if (hi - lo < 0.01) { lo -= 0.005; hi += 0.005; }
    const t0 = pts1[0].t, t1 = pts1[pts1.length - 1].t || t0 + 1;
    const d = pts1.map((p, i) => `${i ? 'L' : 'M'}${(((p.t - t0) / (t1 - t0 || 1)) * 86 + 1).toFixed(1)},${(26 - ((p.v - lo) / (hi - lo)) * 24).toFixed(1)}`).join('');
    svg.setAttribute('class', `spark ${dir(pts1[pts1.length - 1].v - pts1[0].v)}`);
    svg.replaceChildren(s('path', { d }));
  }
  function moverRows() {
    return state.movers.filter((m) => m && m.market && (!state.category || m.market.category === state.category));
  }
  function renderMovers() {
    const rows = moverRows();
    const body = $('#movers-body');
    const nodes = rows.map((mv, i) => {
      const m = mv.market;
      const p = Number(m.probability);
      const prev = state.prevProb.get(m.id);
      const probSpan = h('span', { class: 'tick prob', text: pct(p) });
      if (isNum(prev) && isNum(p) && Math.abs(prev - p) >= 0.0005) requestAnimationFrame(() => flash(probSpan, p > prev));
      const c1 = mv.change1h, c5 = mv.change5m;
      const spark = s('svg', { class: 'spark loading', viewBox: '0 0 88 28', preserveAspectRatio: 'none', 'data-id': m.id, 'aria-hidden': 'true' }, s('path', { d: 'M0,14L88,14' }));
      return h('tr', {
        dataset: { id: m.id },
        onclick: (e) => { if (!e.target.closest('button,a')) openDrawer(m.id); },
      },
        h('td', {},
          h('div', { class: 'mtitle' }, h('span', { class: 'rank', text: String(i + 1).padStart(2, '0') }), m.title || m.id),
          h('div', { class: 'msub' },
            m.category ? h('span', { class: 'cat-chip', text: m.category }) : null,
            m.live ? h('span', { class: 'badge live', text: 'Live' }) : null,
            venueBadge(m.source),
            thinBadge(m),
            m.outcome ? h('span', { text: m.outcome }) : null)),
        h('td', { class: 'r' }, probSpan),
        h('td', { class: 'r' }, h('span', { class: `chg ${dir(c1)}`, text: ptsShort(c1) })),
        h('td', { class: 'r hide-sm' }, h('span', { class: `chg ${dir(c5)}`, text: ptsShort(c5) })),
        h('td', { class: 'hide-xs' }, spark),
        h('td', { class: 'r' }, watchButton(m, true)));
    });
    body.replaceChildren(...nodes);
    rows.forEach((mv) => state.prevProb.set(mv.market.id, Number(mv.market.probability)));
    $('#movers-empty').hidden = rows.length > 0;
    if (!rows.length) {
      $('#movers-empty p').textContent = state.backendUp === false ? 'Server unreachable. Retrying…'
        : state.category && state.movers.length ? `No ${state.category} movers right now.` : 'No movers yet. The board fills as prices update.';
    }
    $$('svg.spark', body).forEach((svg) => {
      const c = state.histCache.get(svg.dataset.id);
      if (c && Date.now() - c.at < 60000) drawSpark(svg, c.points);
      else if (sparkObserver) sparkObserver.observe(svg); else queueSpark(svg);
    });
    renderTape();
  }
  function renderTape() {
    const track = $('#tape-track');
    const rows = state.movers.filter((m) => m && m.market).slice(0, 20);
    if (!rows.length) {
      track.style.animation = 'none';
      track.replaceChildren(h('span', { class: 'tape-empty', text: state.backendUp === false ? 'Waiting for the server…' : 'Warming up the tape…' }));
      return;
    }
    const make = () => rows.map((mv) => {
      const m = mv.market;
      const c = isNum(mv.change1h) ? mv.change1h : mv.change5m;
      return h('button', { type: 'button', class: 'tape-item', onclick: () => openDrawer(m.id), attrs: { tabindex: -1 } },
        h('span', { class: 't', text: m.title || m.id }),
        h('span', { text: pct(m.probability) }),
        h('span', { class: `chg ${dir(c)}`, text: `${dir(c) === 'up' ? '▲' : dir(c) === 'down' ? '▼' : '■'} ${ptsShort(c)}` }));
    });
    track.style.animation = '';
    track.replaceChildren(...make(), ...make());
    requestAnimationFrame(() => {
      const w = track.scrollWidth / 2;
      track.style.setProperty('--tape-dur', `${Math.max(30, w / 55)}s`);
    });
  }
  let moversInflight = false, moversLast = 0;
  async function loadMovers(force = false) {
    if (moversInflight || (!force && Date.now() - moversLast < 5000)) return;
    moversInflight = true;
    try {
      const data = await api('/api/movers?limit=25');
      state.movers = Array.isArray(data) ? data : [];
      state.movers.forEach((mv) => mv && mv.market && rememberMarket({ ...mv.market, change1h: mv.change1h }));
      moversLast = Date.now();
      $('#movers-updated').dataset.ts = String(moversLast);
      $('#movers-updated').textContent = ago(moversLast);
      renderMovers();
      if (state.drawerId) refreshDrawerHeader();
    } catch {
      if (!state.movers.length) renderMovers();
    } finally { moversInflight = false; }
  }

  // ------------------------------------------------------------------ watch
  function watchingSub(id) {
    return state.subs.find((sub) => sub.match && Array.isArray(sub.match.marketIds) && sub.match.marketIds.includes(id));
  }
  function watchButton(m, compact = false) {
    const w = watchingSub(m.id);
    return h('button', {
      type: 'button', class: `btn btn-watch${w ? ' watching' : ''}${compact ? ' compact' : ''}`,
      text: compact ? (w ? '★' : '☆') : (w ? '★ Watching' : '☆ Watch'),
      attrs: { 'aria-pressed': String(!!w), title: w ? 'Click to stop watching' : 'Get alerts for this market' },
      onclick: (e) => { e.stopPropagation(); toggleWatch(m, e.currentTarget); },
    });
  }
  async function toggleWatch(m, btn) {
    if (btn) btn.disabled = true;
    try {
      const w = watchingSub(m.id);
      if (w) {
        const onlyThis = (w.match.marketIds || []).length === 1;
        if (onlyThis) { await api(`/api/subscriptions/${encodeURIComponent(w.id)}`, { method: 'DELETE' }); toast(`Stopped watching "${truncate(m.title, 60)}"`); }
        else toast('This market is part of a multi-market alert. Edit it in My alerts.', 'warn');
      } else {
        await api('/api/subscriptions', { method: 'POST', body: {
          name: truncate(m.title || m.id, 80), persona: 'general',
          match: { keywords: [], categories: [], marketIds: [m.id], sources: [] },
          minDelta: 0.03, minSeverity: 'info', liveOnly: false, webhook: null,
        } });
        toast(`Watching "${truncate(m.title, 60)}". You'll hear about 3+ pt moves.`);
      }
      await loadSubs();
    } catch (err) {
      toast(`Couldn't update watch: ${err.message}`, 'err');
    } finally { if (btn) btn.disabled = false; }
  }
  const truncate = (t, n) => { const x = String(t || ''); return x.length > n ? `${x.slice(0, n - 1)}…` : x; };
  function refreshWatchButtons() {
    renderMovers();
    if (state.shots.length) renderShots();
    runSearch(true);
    if (state.drawerId) renderDrawerWatch();
  }

  // ------------------------------------------------------------------ search
  let searchTimer = null, searchSeq = 0, lastSearchKey = '';
  function runSearch(rerenderOnly = false) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => doSearch(rerenderOnly), rerenderOnly ? 0 : 250);
  }
  let lastResults = [];
  async function doSearch(rerenderOnly) {
    const q = $('#search-q').value.trim();
    const key = `${q}|${state.category}`;
    if (rerenderOnly && key === lastSearchKey) { renderResults(lastResults, q); return; }
    lastSearchKey = key;
    const seq = ++searchSeq;
    const params = new URLSearchParams({ q, category: state.category, limit: q ? '30' : '8' });
    try {
      const data = await api(`/api/markets?${params}`);
      if (seq !== searchSeq) return;
      lastResults = Array.isArray(data) ? data : [];
      lastResults.forEach(rememberMarket);
      renderResults(lastResults, q);
    } catch (err) {
      if (seq !== searchSeq) return;
      lastResults = [];
      $('#search-results').replaceChildren();
      $('#search-empty').hidden = false;
      $('#search-empty-text').textContent = state.backendUp === false ? 'Search is available once the server is up.' : `Search failed: ${err.message}`;
    }
  }
  function renderResults(list, q) {
    const ul = $('#search-results');
    ul.replaceChildren(...list.map((m) => h('li', {
      onclick: (e) => { if (!e.target.closest('button,a')) openDrawer(m.id); },
    },
      h('div', { class: 'rbody' },
        h('div', { class: 'rtitle', text: m.title || m.id }),
        h('div', { class: 'rsub' },
          m.category ? h('span', { class: 'cat-chip', text: m.category }) : null,
          m.live ? h('span', { class: 'badge live', text: 'Live' }) : null,
          venueBadge(m.source),
          thinBadge(m),
          m.outcome ? h('span', { text: m.outcome }) : null,
          isNum(m.change1h) ? h('span', { class: `chg ${dir(m.change1h)}`, text: `${ptsShort(m.change1h)} 1h` }) : null)),
      h('div', { class: 'prob', text: pct(m.probability) }),
      watchButton(m))));
    const empty = $('#search-empty');
    empty.hidden = list.length > 0;
    if (!list.length) $('#search-empty-text').textContent = q ? `No markets match "${truncate(q, 40)}"${state.category ? ` in ${state.category}` : ''}.` : 'No markets loaded yet.';
  }

  // ------------------------------------------------------------------ subscriptions
  async function loadSubs() {
    try {
      const data = await api('/api/subscriptions');
      state.subs = Array.isArray(data) ? data : [];
      renderSubs();
      refreshWatchButtons();
      if (state.feedFilter === 'mine') renderFeed();
      return true;
    } catch {
      renderSubs();
      return false;
    }
  }
  function subSummary(sub) {
    const m = sub.match || {};
    const parts = [];
    if (m.marketIds && m.marketIds.length) parts.push(m.marketIds.length === 1 ? '1 market' : `${m.marketIds.length} markets`);
    if (m.categories && m.categories.length) parts.push(m.categories.join(' + '));
    if (m.keywords && m.keywords.length) parts.push(`"${m.keywords.join('", "')}"`);
    if (!parts.length) parts.push('All markets');
    parts.push(`≥${Math.round((sub.minDelta || 0) * 100)} pts`);
    if (sub.minSeverity && sub.minSeverity !== 'info') parts.push(`${sub.minSeverity}+`);
    if (sub.liveOnly) parts.push('live only');
    if (sub.webhook && sub.webhook.type && sub.webhook.url) parts.push(`→ ${sub.webhook.type}`);
    return parts.join(' · ');
  }
  function renderSubs() {
    const ul = $('#subs-list');
    ul.replaceChildren(...state.subs.map((sub) => {
      const hits = state.alerts.filter((sp) => matchSub(sub, sp) || (sp.matchedSubscriptions || []).includes(sub.id)).length;
      return h('li', {
        class: state.editingId === sub.id ? 'selected' : '',
        attrs: { tabindex: 0, role: 'button', 'aria-label': `Edit ${sub.name || 'alert'}` },
        onclick: () => editSub(sub.id),
        onkeydown: (e) => { if (e.key === 'Enter') editSub(sub.id); },
      },
        h('span', { class: 'sicon', attrs: { 'aria-hidden': 'true' }, text: (PERSONAS[sub.persona] || PERSONAS.general).emoji }),
        h('div', { class: 'sbody' },
          h('div', { class: 'sname', text: sub.name || 'Untitled alert' }),
          h('div', { class: 'sdesc', text: subSummary(sub) })),
        hits ? h('span', { class: 'shits', title: 'Recent matching spikes', text: `${hits} hit${hits === 1 ? '' : 's'}` } ) : null);
    }));
    $('#subs-empty').hidden = state.subs.length > 0;
  }
  function renderPersonaRow() {
    $('#persona-row').replaceChildren(...Object.entries(PERSONAS).map(([key, p]) => h('button', {
      type: 'button', class: 'chip', dataset: { persona: key },
      onclick: () => applyPreset(key), text: `${p.emoji} ${p.label}`,
    })));
    $('#cat-chips').replaceChildren(...CATEGORIES.map((c) => h('button', {
      type: 'button', class: 'chip', dataset: { cat: c }, attrs: { 'aria-pressed': 'false' },
      text: c, onclick: (e) => { const b = e.currentTarget; b.classList.toggle('active'); b.setAttribute('aria-pressed', String(b.classList.contains('active'))); },
    })));
  }
  function setPersonaActive(key) {
    $$('#persona-row .chip').forEach((b) => b.classList.toggle('active', b.dataset.persona === key));
    $('#sub-form').dataset.persona = key;
  }
  function applyPreset(key) {
    const p = PERSONAS[key];
    const f = $('#sub-form');
    setPersonaActive(key);
    if (!f.name.value.trim() || Object.values(PERSONAS).some((x) => x.name === f.name.value.trim())) f.name.value = p.name;
    $$('#cat-chips .chip').forEach((b) => { const on = p.categories.includes(b.dataset.cat); b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
    f.minDelta.value = String(Math.round(p.minDelta * 100));
    $('#mindelta-out').textContent = f.minDelta.value;
    f.minSeverity.value = p.minSeverity;
    f.liveOnly.checked = p.liveOnly;
  }
  function resetForm() {
    const f = $('#sub-form');
    f.reset();
    state.editingId = null;
    state.formMarketIds = [];
    setPersonaActive('general');
    $$('#cat-chips .chip').forEach((b) => { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); });
    $('#mindelta-out').textContent = f.minDelta.value;
    $('#sub-form-title').textContent = 'New alert';
    $('#sub-form-id').textContent = '';
    $('#btn-test-sub').disabled = true;
    $('#btn-del-sub').disabled = true;
    $('#sub-marketids').hidden = true;
    renderSubs();
  }
  function editSub(id) {
    const sub = state.subs.find((x) => x.id === id);
    if (!sub) return;
    const f = $('#sub-form');
    const m = sub.match || {};
    state.editingId = id;
    state.formMarketIds = Array.isArray(m.marketIds) ? m.marketIds.slice() : [];
    f.name.value = sub.name || '';
    setPersonaActive(sub.persona || 'general');
    f.keywords.value = (m.keywords || []).join(', ');
    $$('#cat-chips .chip').forEach((b) => { const on = (m.categories || []).includes(b.dataset.cat); b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
    f.minDelta.value = String(Math.round((sub.minDelta ?? 0.05) * 100) || 1);
    $('#mindelta-out').textContent = f.minDelta.value;
    f.minSeverity.value = sub.minSeverity || 'info';
    f.liveOnly.checked = !!sub.liveOnly;
    f.webhookType.value = (sub.webhook && sub.webhook.type) || '';
    f.webhookUrl.value = (sub.webhook && sub.webhook.url) || '';
    $('#sub-form-title').textContent = 'Edit alert';
    $('#sub-form-id').textContent = String(id).slice(0, 8);
    $('#btn-test-sub').disabled = false;
    $('#btn-del-sub').disabled = false;
    const mid = $('#sub-marketids');
    if (state.formMarketIds.length) {
      mid.hidden = false;
      const names = state.formMarketIds.map((x) => (state.markets.get(x) || {}).title || x);
      mid.textContent = `Tracking ${names.length === 1 ? 'market' : `${names.length} markets`}: ${names.map((n) => truncate(n, 50)).join('; ')}`;
    } else mid.hidden = true;
    renderSubs();
    f.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function readForm() {
    const f = $('#sub-form');
    const type = f.webhookType.value;
    const url = f.webhookUrl.value.trim();
    return {
      name: f.name.value.trim(),
      persona: f.dataset.persona || 'general',
      match: {
        keywords: f.keywords.value.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean),
        categories: $$('#cat-chips .chip.active').map((b) => b.dataset.cat),
        marketIds: state.formMarketIds.slice(),
        sources: [],
      },
      minDelta: Number(f.minDelta.value) / 100,
      minSeverity: f.minSeverity.value,
      liveOnly: f.liveOnly.checked,
      webhook: type && url ? { type, url } : null,
    };
  }
  async function saveSub(e) {
    e.preventDefault();
    const body = readForm();
    if (!body.name) { toast('Give your alert a name.', 'warn'); $('#sub-form').name.focus(); return; }
    const f = $('#sub-form');
    if (f.webhookType.value && body.webhook == null) { toast('Add a webhook URL or set the type to None.', 'warn'); return; }
    if (body.webhook && !safeUrl(body.webhook.url)) { toast('Webhook URL must start with http:// or https://', 'warn'); return; }
    try {
      let saved;
      if (state.editingId) saved = await api(`/api/subscriptions/${encodeURIComponent(state.editingId)}`, { method: 'PUT', body });
      else saved = await api('/api/subscriptions', { method: 'POST', body });
      toast(state.editingId ? 'Alert updated.' : 'Alert created. You\'re on watch.');
      await loadSubs();
      if (saved && saved.id) editSub(saved.id); else resetForm();
    } catch (err) { toast(`Save failed: ${err.message}`, 'err'); }
  }
  async function deleteSub() {
    if (!state.editingId) return;
    const sub = state.subs.find((x) => x.id === state.editingId);
    if (!confirm(`Delete "${sub ? sub.name : 'this alert'}"?`)) return;
    try {
      await api(`/api/subscriptions/${encodeURIComponent(state.editingId)}`, { method: 'DELETE' });
      toast('Alert deleted.');
      resetForm();
      await loadSubs();
    } catch (err) { toast(`Delete failed: ${err.message}`, 'err'); }
  }
  async function testSub() {
    if (!state.editingId) return;
    const btn = $('#btn-test-sub');
    btn.disabled = true;
    try {
      const r = await api(`/api/subscriptions/${encodeURIComponent(state.editingId)}/test`, { method: 'POST' });
      if (r && r.ok) toast('Test alert delivered.');
      else toast(`Test failed: ${(r && r.error) || 'unknown error'}`, 'err', 5000);
    } catch (err) { toast(`Test failed: ${err.message}`, 'err', 5000); }
    finally { btn.disabled = false; }
  }

  // ------------------------------------------------------------------ onboarding
  function renderOnboarding() {
    $('#onboard-cards').replaceChildren(...Object.entries(PERSONAS).map(([key, p]) => h('button', {
      type: 'button', class: 'persona-card', onclick: () => pickPersona(key),
    }, h('span', { class: 'pc-emoji', attrs: { 'aria-hidden': 'true' }, text: p.emoji }),
      h('span', { class: 'pc-name', text: p.label }),
      h('span', { class: 'pc-desc', text: p.desc }))));
  }
  async function pickPersona(key) {
    const p = PERSONAS[key];
    closeModal('onboard');
    setPersona(key, { quiet: true });
    localStorage.setItem(LS.onboarded, '1');
    // Ask for notifications while we still have the user gesture.
    if (notifySupported() && Notification.permission === 'default') enableNotifications();
    try {
      await api('/api/subscriptions', { method: 'POST', body: {
        name: p.name, persona: key,
        match: { keywords: [], categories: p.categories.slice(), marketIds: [], sources: [] },
        minDelta: p.minDelta, minSeverity: p.minSeverity, liveOnly: p.liveOnly, webhook: null,
      } });
      toast(`${p.emoji} ${p.label} alerts are set. Tweak them anytime in My alerts.`);
      if (p.categories.length === 1) setCategory(p.categories[0]);
      await loadSubs();
    } catch (err) { toast(`Couldn't create alert: ${err.message}`, 'err'); }
  }
  function openModal(id) { const m = $(`#${id}`); m.hidden = false; const f = $('button', m); if (f) f.focus(); }
  function closeModal(id) { $(`#${id}`).hidden = true; }

  // ------------------------------------------------------------------ drawer
  function marketFor(id, spikeHint) {
    let m = state.markets.get(id);
    if (!m && spikeHint) m = marketFromSpike(spikeHint);
    if (!m) { const sp = state.alerts.find((a) => a.marketId === id); if (sp) m = marketFromSpike(sp); }
    return m || { id, title: id };
  }
  async function openDrawer(id, spikeHint) {
    if (!id) return;
    state.drawerId = id;
    if (spikeHint) rememberMarket({ ...marketFromSpike(spikeHint), ...(state.markets.get(id) || {}) });
    const dr = $('#drawer');
    $('#drawer-scrim').hidden = false;
    dr.classList.add('open');
    dr.setAttribute('aria-hidden', 'false');
    refreshDrawerHeader();
    renderDrawerSpikes();
    renderDrawerWatch();
    renderDrawerMute();
    renderDrawerShot();
    renderDrawerInsights();
    $('#drawer-rec').hidden = true;
    $('#drawer-ctx').replaceChildren();
    renderDrawerContext();
    $('#drawer-fc').hidden = true;
    renderDrawerForecast();
    $('#drawer-traj').replaceChildren();
    const svg = $('#drawer-chart');
    svg.replaceChildren();
    $('#drawer-chart-empty').hidden = true;
    $('#drawer-close').focus({ preventScroll: true });
    try {
      const pts1 = await getHistory(id, 15000);
      if (state.drawerId !== id) return;
      drawDrawerChart(pts1);
    } catch {
      if (state.drawerId !== id) return;
      drawDrawerChart([]);
    }
  }
  function drawDrawerChart(pts1) {
    const id = state.drawerId;
    const m = marketFor(id);
    const now = Date.now();
    const tMin = now - state.drawerRange;
    let series = pts1.filter((p) => p.t >= tMin);
    // carry the last known point before the range in, so the line starts at the left edge
    const before = pts1.filter((p) => p.t < tMin);
    if (before.length) series.unshift({ t: tMin, v: before[before.length - 1].v });
    if (series.length && isNum(Number(m.probability)) && m.probability != null && series[series.length - 1].t < now - 1000) series.push({ t: now, v: Number(m.probability) });
    const up = series.length > 1 ? series[series.length - 1].v >= series[0].v : true;
    const emptyEl = $('#drawer-chart-empty');
    emptyEl.hidden = series.length >= 2;
    emptyEl.textContent = pts1.length >= 2 ? 'No price history in this range yet.' : 'Not enough history yet. Points accrue every poll.';
    const spikes = state.alerts.filter((a) => a.marketId === id);
    const windows = [], fires = [];
    for (const a of spikes) {
      const t = Date.parse(a.detectedAt);
      if (!isNum(t)) continue;
      windows.push({ t0: t - (Number(a.windowMs) || 0), t1: t });
      fires.push({ t, v: Number(a.to), label: headline(a) });
    }
    renderLineChart($('#drawer-chart'), $('#drawer-tip'), series, {
      yMin: 0, yMax: 1, auto: true, minSpan: 0.08, yTicks: 4, xTicks: 6,
      color: up ? '#1fd67b' : '#ff4d6a', padR: 44, padB: 18, windows, fires,
      tMin, tMax: now,
      fmtAxis: (v) => `${Math.round(v * 100)}%`, fmtTip: (v) => pct1(v), emptyText: ' ',
    });
    const traj = $('#drawer-traj');
    if (series.length >= 2) {
      const first = series[0], last = series[series.length - 1];
      traj.replaceChildren('Now ', h('b', { text: pct(last.v) }), ' · from ', h('b', { text: pct(first.v) }), ` at ${clock(first.t)} `,
        h('span', { class: `chg ${dir(last.v - first.v)}`, text: `(${pts(last.v - first.v)})` }));
      const m2 = state.markets.get(id) || {};
      if (!isNum(m2.change1h)) {
        const chg = $('#drawer-chg');
        chg.className = `chg num ${dir(last.v - first.v)}`;
        chg.textContent = `${pts(last.v - first.v, true)} since ${clock(first.t)}`;
      }
    } else traj.replaceChildren();
  }
  function renderDrawerMute() {
    const id = state.drawerId; if (!id) return;
    const b = $('#drawer-mute');
    const muted = isMuted(id);
    b.textContent = muted ? `Muted until ${clock(state.muted.get(id))} · Unmute` : 'Mute 1h';
    b.classList.toggle('on', muted);
  }
  function refreshDrawerHeader() {
    const id = state.drawerId;
    if (!id) return;
    const m = marketFor(id);
    const meta = $('#drawer-meta');
    fill(meta,
      m.live ? h('span', { class: 'badge live', text: 'Live' }) : null,
      m.category ? h('span', { class: 'cat-chip', text: m.category }) : null,
      venueBadge(m.source),
      thinBadge(m),
      m.endDate ? h('span', { class: 'muted small', text: `Ends ${new Date(m.endDate).toLocaleDateString([], { month: 'short', day: 'numeric' })}` }) : null,
      isNum(m.volume24h) && m.volume24h > 0 ? h('span', { class: 'muted small num', text: `$${Intl.NumberFormat([], { notation: 'compact', maximumFractionDigits: 1 }).format(m.volume24h)} 24h vol` }) : null);
    $('#drawer-title').textContent = m.title || id;
    $('#drawer-outcome').textContent = m.outcome ? `Tracking outcome: ${m.outcome}` : '';
    const probEl = $('#drawer-prob');
    if (isNum(Number(m.probability)) && m.probability != null) {
      const p = Number(m.probability) * 100;
      probEl.replaceChildren(document.createTextNode(String(Math.round(p))), h('small', { text: '% chance' }));
    } else probEl.textContent = '--';
    const chg = $('#drawer-chg');
    if (isNum(m.change1h)) { chg.className = `chg num ${dir(m.change1h)}`; chg.textContent = `${pts(m.change1h, true)} 1h`; }
    else { chg.className = 'chg num'; chg.textContent = ''; }
    const link = $('#drawer-link');
    const url = safeUrl(m.url);
    if (url) { link.href = url; link.hidden = false; link.textContent = `Open on ${cap(m.source) || 'source'} ↗`; }
    else link.hidden = true;
  }
  function renderDrawerWatch() {
    const id = state.drawerId; if (!id) return;
    const w = watchingSub(id);
    const b = $('#drawer-watch');
    b.textContent = w ? '★ Watching' : '☆ Watch this market';
    b.className = w ? 'btn btn-watch watching' : 'btn btn-accent';
    b.style.padding = '8px 14px';
  }
  function renderDrawerSpikes() {
    const id = state.drawerId;
    const list = state.alerts.filter((a) => a.marketId === id).slice(0, 12);
    const ol = $('#drawer-spikes');
    if (!list.length) { ol.replaceChildren(h('li', { class: 'empty-li', text: 'No spikes detected for this market yet.' })); return; }
    ol.replaceChildren(...list.map((sp) => h('li', { title: headline(sp) },
      h('span', {},
        sp.severity !== 'info' ? h('span', { class: `badge sev-${sp.severity}`, text: sp.severity }) : null, ' ',
        h('span', { class: 'mono', text: `${pct(sp.from)} → ${pct(sp.to)} ` }),
        h('span', { class: 'muted small', text: windowText(sp.windowMs) })),
      h('span', {},
        h('span', { class: `chg ${dir(sp.delta)}`, text: pts(sp.delta) }), ' ',
        h('span', { class: 'muted small', dataset: { ts: sp.detectedAt || '' }, text: ago(sp.detectedAt) })))));
  }
  function closeDrawer() {
    state.drawerId = null;
    const dr = $('#drawer');
    dr.classList.remove('open');
    dr.setAttribute('aria-hidden', 'true');
    $('#drawer-scrim').hidden = true;
  }

  // ================================================================== v2: icons + shared bits
  function icon(name, cls = 'ico') {
    const d = ICONS[name] || ICONS.eye;
    return s('svg', { class: cls, viewBox: '0 0 24 24', 'aria-hidden': 'true' },
      s('path', { d, fill: name === 'bolt' ? 'currentColor' : 'none', stroke: 'currentColor', 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  }
  function kindBadge(kind) {
    const k = kindMeta(kind);
    return h('span', { class: 'kind-badge', style: `--k:${k.color}` }, icon(k.icon), k.label);
  }
  function durShort(ms) {
    const sec = Math.max(0, Math.round(ms / 1000));
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    if (m < 60) return `${m}m ${String(sec % 60).padStart(2, '0')}s`;
    const hr = Math.floor(m / 60);
    return `${hr}h ${String(m % 60).padStart(2, '0')}m`;
  }
  const toT = (x) => (typeof x === 'number' ? x : Date.parse(x));
  /** Plain-English time window for a shot. */
  function windowInfo(w, now = Date.now()) {
    if (!w) return null;
    const st = toT(w.startsAt), en = w.endsAt ? toT(w.endsAt) : NaN;
    if (!isNum(st)) return null;
    const range = isNum(en) ? `${clock(st)}–${clock(en)}` : `from ${clock(st)}`;
    if (st > now) {
      if (st - now <= 3 * 3600e3) return { state: 'soon', until: st, main: `Starts in ${durShort(st - now)}`, sub: `Be there ${range}` };
      return { state: 'later', main: `Be there ${range}`, sub: new Date(st).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) };
    }
    if (!isNum(en) || en > now) {
      const progress = isNum(en) ? clamp((now - st) / Math.max(1, en - st), 0, 1) : null;
      return { state: 'now', main: 'Be there now', sub: isNum(en) ? `window closes ${clock(en)}` : `since ${clock(st)}`, progress };
    }
    return { state: 'past', main: `Window closed ${clock(en)}`, sub: range };
  }
  function tipFor(shot, persona = state.persona) {
    const t = shot && shot.tips;
    if (!t || typeof t !== 'object') return '';
    return String(t[persona] || t.general || Object.values(t).find(Boolean) || '');
  }
  const shotKey = (sh) => String(sh.marketId || sh.id || '');
  /** Rate limiter for recommendation notifications: per-key + per-channel spacing. */
  const gates = new Map();
  function gate(key, perKeyMs, channel, channelMs) {
    const now = Date.now();
    if (now - (gates.get(`k:${key}`) || 0) < perKeyMs) return false;
    if (now - (gates.get(`c:${channel}`) || 0) < channelMs) return false;
    gates.set(`k:${key}`, now); gates.set(`c:${channel}`, now);
    return true;
  }
  function pageHidden() { return document.visibilityState !== 'visible' || !document.hasFocus(); }
  function sysNotify(title, body, tag, onclick) {
    if (!notifySupported() || Notification.permission !== 'granted') return;
    try {
      const n = new Notification(title, { body, tag, icon: 'favicon.svg', renotify: false });
      n.onclick = () => { window.focus(); if (onclick) onclick(); n.close(); };
    } catch { /* ignore */ }
  }

  // ================================================================== v2: persona
  function renderPersonaSwitch() {
    const host = $('#persona-switch');
    host.replaceChildren(...PERSONA_ORDER.map((key) => {
      const on = state.persona === key;
      return h('button', {
        type: 'button', class: `ps-btn${on ? ' active' : ''}`, dataset: { persona: key },
        attrs: { role: 'radio', 'aria-checked': String(on), title: `Recommend for ${PERSONA_SHORT[key]} (p cycles)` },
        onclick: () => setPersona(key),
      }, h('span', { class: 'ps-emo', attrs: { 'aria-hidden': 'true' }, text: PERSONAS[key].emoji }), h('span', { class: 'ps-lbl', text: PERSONA_SHORT[key] }));
    }));
  }
  function setPersona(key, { quiet = false } = {}) {
    if (!PERSONAS[key]) return;
    const changed = state.persona !== key;
    state.persona = key;
    localStorage.setItem(LS.persona, key);
    renderPersonaSwitch();
    if (!changed) return;
    state.shotsBaseline = null; // don't notify for re-ranks caused by switching
    renderShots(); // re-word every card immediately from recommendations[role]
    renderFeed();
    if (state.drawerId) { renderDrawerShot(); renderDrawerSpikes(); renderDrawerContext(); }
    loadShots(true);
    if (!quiet) toast(`${PERSONAS[key].emoji} Recommending for ${PERSONA_SHORT[key] === 'Everyone' ? 'everyone' : PERSONA_SHORT[key].toLowerCase() + 's'}.`, 'ok', 2200);
  }
  function cyclePersona() {
    const i = PERSONA_ORDER.indexOf(state.persona);
    setPersona(PERSONA_ORDER[(i + 1) % PERSONA_ORDER.length]);
  }

  // ================================================================== v2: shot list
  let shotsInflight = false, shotsQueued = false, shotsLastFetch = 0, shotsTimer = null;
  async function loadShots(force = false) {
    if (shotsInflight) { shotsQueued = true; return; }
    if (!force && Date.now() - shotsLastFetch < 3000) {
      if (!shotsTimer) shotsTimer = setTimeout(() => { shotsTimer = null; loadShots(true); }, 3200 - (Date.now() - shotsLastFetch));
      return;
    }
    shotsInflight = true; shotsLastFetch = Date.now();
    const persona = state.persona, cat = state.category;
    try {
      const params = new URLSearchParams({ persona, limit: '20' });
      if (cat) params.set('category', cat);
      const data = await api(`/api/shots?${params}`);
      if (persona !== state.persona || cat !== state.category) { shotsQueued = true; return; }
      applyShots(Array.isArray(data) ? data : []);
    } catch (err) {
      if (!state.shots.length) { state.shotsStatus = /404|no route|not found/i.test(err.message) ? 'unavailable' : state.backendUp === false ? 'unavailable' : 'empty'; renderShots(); }
    } finally {
      shotsInflight = false;
      if (shotsQueued) { shotsQueued = false; loadShots(true); }
    }
  }
  function validShot(sh) { return sh && (sh.marketId || sh.id) && (sh.headline || (sh.market && sh.market.title)); }
  function applyShots(list) {
    const clean = list.filter(validShot)
      .filter((sh) => !state.category || !sh.market || !sh.market.category || sh.market.category === state.category)
      .sort((a, b) => (isNum(a.rank) && isNum(b.rank) ? a.rank - b.rank : (b.dramaScore || 0) - (a.dramaScore || 0)))
      .slice(0, 20);
    clean.forEach((sh) => { if (sh.market) rememberMarket({ ...sh.market, id: sh.market.id || sh.marketId }); });
    state.shotRanks = new Map(state.shots.map((sh, i) => [shotKey(sh), i + 1]));
    state.shots = clean;
    state.shotsStatus = clean.length ? 'ok' : 'empty';
    state.shotsAt = Date.now();
    const upd = $('#shots-updated');
    upd.dataset.ts = String(state.shotsAt); upd.dataset.prefix = '· '; upd.textContent = `· ${ago(state.shotsAt)}`;
    renderShots();
    checkTopThree();
    if (state.drawerId) renderDrawerShot();
  }
  function onShotsEvent(list) {
    if (!Array.isArray(list)) return;
    // The stream carries the default ranking; persona-specific ranking comes from the REST route.
    if (state.persona === 'general' && !state.category) applyShots(list);
    else loadShots();
  }
  function checkTopThree() {
    const top = state.shots.slice(0, 3);
    const keys = new Set(top.map(shotKey));
    const base = state.shotsBaseline;
    state.shotsBaseline = keys;
    if (!base) return; // first load / persona switch: establish baseline silently
    for (const sh of top) {
      const k = shotKey(sh);
      if (base.has(k) || isMuted(sh.marketId)) continue;
      if (!gate(`shot:${k}`, 20 * 60e3, 'shot', 90e3)) continue;
      const km = kindMeta(sh.kind);
      const tip = tipFor(sh);
      islandShow({ tone: 'shot', color: km.color, iconName: km.icon, kicker: `New top-3 shot · ${km.label}`, title: (recFor(sh) && recFor(sh).headline) || sh.headline || (sh.market && sh.market.title) || 'New shot',
        big: isNum(sh.dramaScore) ? String(Math.round(sh.dramaScore)) : '', small: 'drama', onclick: () => openDrawer(sh.marketId), ms: 7000 });
      beep('up');
      if (pageHidden()) {
        const rn = roleNotice(sh, `🎯 ${sh.headline || 'New shot'}`, `${km.label}${sh.forecast && isNum(sh.forecast.pMove30) ? ` · ${pct(sh.forecast.pMove30)} chance of a 5+ pt swing` : ''}${tip ? ` · ${tip}` : ''}`);
        sysNotify(rn.title, rn.body, `shot-${k}`, () => openDrawer(sh.marketId));
        setUnread(state.unread + 1);
      }
      break; // at most one per update
    }
  }
  function visibleShots() {
    const list = state.shots.filter((sh) => !isMuted(sh.marketId));
    const small = matchMedia('(max-width: 820px)').matches;
    const n = state.shotsExpanded ? list.length : small ? 5 : 8;
    return { list: list.slice(0, n), total: list.length };
  }
  function dramaRing(score, key) {
    const v = clamp(Number(score) || 0, 0, 100);
    const C = 2 * Math.PI * 21;
    const prev = state.shotDrama.has(key) ? state.shotDrama.get(key) : 0;
    state.shotDrama.set(key, v);
    const arc = s('circle', { class: 'ring-val', cx: 26, cy: 26, r: 21, 'stroke-dasharray': `${(C * prev / 100).toFixed(1)} ${C.toFixed(1)}` });
    requestAnimationFrame(() => requestAnimationFrame(() => arc.setAttribute('stroke-dasharray', `${(C * v / 100).toFixed(1)} ${C.toFixed(1)}`)));
    return h('div', { class: 'drama', attrs: { title: `Drama score ${Math.round(v)}/100: forecast × uncertainty × liveness × interest` } },
      s('svg', { viewBox: '0 0 52 52', 'aria-hidden': 'true' },
        s('circle', { class: 'ring-bg', cx: 26, cy: 26, r: 21 }), arc),
      h('div', { class: 'drama-num num', text: String(Math.round(v)) }),
      h('div', { class: 'drama-lbl', text: 'drama' }));
  }
  function forecastMeter(p, segs = 20) {
    const on = Math.round(clamp(p, 0, 1) * segs);
    return h('div', { class: 'fmeter', attrs: { 'aria-hidden': 'true' } }, Array.from({ length: segs }, (_, i) => h('i', { class: i < on ? 'on' : '' })));
  }
  function shotCard(sh, idx) {
    const key = shotKey(sh);
    const m = { ...(state.markets.get(sh.marketId) || {}), ...(sh.market || {}) };
    const km = kindMeta(sh.kind);
    const rank = idx + 1;
    const prevRank = state.shotRanks.get(key);
    const fc = sh.forecast || {};
    const win = windowInfo(sh.window);
    const tip = tipFor(sh);
    const url = safeUrl(m.url);
    const lead = idx === 0;
    const pMove = isNum(fc.pMove30) ? clamp(fc.pMove30, 0, 1) : null;
    const spark = s('svg', { class: 'spark loading', viewBox: '0 0 88 28', preserveAspectRatio: 'none', 'data-id': sh.marketId, 'aria-hidden': 'true' }, s('path', { d: 'M0,14L88,14' }));
    const li = h('li', {
      class: `shot${lead ? ' lead' : ''}${win && win.state === 'now' ? ' on-air' : ''}`,
      style: `--k:${km.color}`,
      dataset: { key, rank: String(rank) },
      attrs: { tabindex: 0, 'aria-label': `Rank ${rank}: ${sh.headline || m.title || 'shot'}` },
      onclick: (e) => { if (!e.target.closest('button,a')) openDrawer(sh.marketId); },
      onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) openDrawer(sh.marketId); },
    },
      lead ? h('span', { class: 'vf', attrs: { 'aria-hidden': 'true' } }, h('i'), h('i'), h('i'), h('i')) : null,
      h('div', { class: 'shot-top' },
        h('span', { class: 'shot-rank num', text: String(rank).padStart(2, '0') }),
        isNum(prevRank) && prevRank !== rank ? h('span', { class: `rank-chg ${prevRank > rank ? 'up' : 'down'}`, text: `${prevRank > rank ? '▲' : '▼'}${Math.abs(prevRank - rank)}`, attrs: { title: `Was #${prevRank}` } })
          : !isNum(prevRank) && state.shotRanks.size ? h('span', { class: 'rank-chg new', text: 'NEW' }) : null,
        kindBadge(sh.kind),
        m.live ? h('span', { class: 'badge live', text: 'Live' }) : null,
        h('span', { class: 'shot-tags' }, m.category ? h('span', { class: 'cat-chip', text: m.category }) : null, venueBadge(m.source)),
        dramaRing(sh.dramaScore, key)),
      contextChips(sh.context),
      ...leadCols(lead, [
      h('h3', { class: 'shot-headline', text: sh.headline || m.title || 'Untitled' }),
      sh.why ? h('p', { class: 'shot-why', text: sh.why }) : null,
      h('div', { class: 'shot-mkt' },
        h('div', { class: 'shot-spark' }, spark),
        h('div', { class: 'shot-prob' },
          h('span', { class: 'num p', text: pct(m.probability) }),
          isNum(m.change1h) ? h('span', { class: `chg ${dir(m.change1h)}`, text: `${ptsShort(m.change1h)} 1h` }) : null),
        h('div', { class: 'shot-mtitle', attrs: { title: m.title || '' }, text: `${m.title || ''}${m.outcome && !/^yes$/i.test(m.outcome) ? ` · ${m.outcome}` : ''}` })),
      pMove != null ? h('div', { class: 'shot-fc', attrs: { title: `Forecast model: ${fc.model || 'unknown'}` } },
        forecastMeter(pMove),
        h('div', { class: 'fc-text' }, h('b', { class: 'num', text: pct(pMove) }), ' chance of a 5+ pt swing in 30 min',
          isNum(fc.expectedMovePts) ? h('span', { class: 'muted' }, ' · expect ', h('b', { class: 'num', text: `±${Number(fc.expectedMovePts).toFixed(1)}` }), ' pts') : null)) : null], [
      win ? h('div', { class: `shot-win ${win.state}` },
        h('span', { class: 'win-dot', attrs: { 'aria-hidden': 'true' } }),
        h('span', { class: 'win-main num', dataset: win.until ? { until: String(win.until) } : {}, text: win.main }),
        win.sub ? h('span', { class: 'win-sub', text: win.sub }) : null,
        win.state === 'now' && isNum(win.progress) ? h('span', { class: 'win-prog', attrs: { 'aria-hidden': 'true' } }, h('i', { style: `width:${(win.progress * 100).toFixed(0)}%` })) : null) : null,
      recBlock(recFor(sh), sh.id || sh.marketId, { fallbackTip: tip })]),
      h('div', { class: 'shot-actions' },
        watchButton({ ...m, id: sh.marketId }),
        h('button', { type: 'button', class: 'btn btn-small btn-ghost', text: 'Details', onclick: (e) => { e.stopPropagation(); openDrawer(sh.marketId); } }),
        url ? h('a', { class: 'btn btn-small btn-ghost', href: url, target: '_blank', rel: 'noopener noreferrer', text: `${m.source === 'kalshi' ? 'Kalshi' : m.source === 'polymarket' ? 'Polymarket' : 'Venue'} ↗` }) : null));
    return li;
  }
  /** Lead card splits into story (left) and action (right) columns; others stay a single stack. */
  function leadCols(lead, left, right) {
    if (!lead) return [...left, ...right];
    return [h('div', { class: 'lead-cols' }, h('div', { class: 'lead-l' }, left), h('div', { class: 'lead-r' }, right))];
  }
  function renderShots() {
    const host = $('#shots');
    const { list, total } = visibleShots();
    // FLIP: First
    const first = new Map();
    for (const el of host.children) if (el.dataset.key) first.set(el.dataset.key, el.getBoundingClientRect());
    const nodes = list.map((sh, i) => shotCard(sh, i));
    host.replaceChildren(...nodes);
    // Last + Invert + Play
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    nodes.forEach((el, i) => {
      const was = first.get(el.dataset.key);
      if (reduce || !el.animate) return;
      if (was) {
        const now = el.getBoundingClientRect();
        const dx = was.left - now.left, dy = was.top - now.top;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 650, easing: 'cubic-bezier(.2,.9,.25,1)' });
      } else if (first.size) {
        el.animate([{ opacity: 0, transform: 'translateY(14px) scale(.98)' }, { opacity: 1, transform: 'none' }], { duration: 500, delay: i * 25, easing: 'cubic-bezier(.34,1.56,.64,1)', fill: 'backwards' });
      }
    });
    $$('svg.spark', host).forEach((svg) => {
      const c = state.histCache.get(svg.dataset.id);
      if (c && Date.now() - c.at < 60000) drawSpark(svg, c.points);
      else if (sparkObserver) sparkObserver.observe(svg); else queueSpark(svg);
    });
    const more = $('#shots-more');
    more.hidden = total <= list.length && !state.shotsExpanded;
    more.textContent = state.shotsExpanded ? 'Show fewer' : `Show all ${total} shots`;
    const empty = $('#shots-empty');
    empty.hidden = list.length > 0;
    if (!list.length) {
      const t = $('#shots-empty-title'), x = $('#shots-empty-text');
      if (state.backendUp === false) { t.textContent = 'Waiting for the Tipoff server…'; x.textContent = 'The shot list comes back the moment we reconnect.'; }
      else if (state.shotsStatus === 'loading') { t.textContent = 'Lining up the first shots…'; x.textContent = 'Reading the markets for what is about to move.'; }
      else if (state.shotsStatus === 'unavailable') { t.textContent = 'The shot list is warming up'; x.textContent = 'This server doesn\'t serve recommendations yet. Spikes, movers and alerts below work as usual.'; }
      else if (state.category) { t.textContent = `Nothing worth framing in ${state.category} right now`; x.textContent = 'Try All categories, or check back as events go live.'; }
      else { t.textContent = 'Quiet on set'; x.textContent = 'No market looks ready to move yet. Shots appear as events approach and odds start to wobble.'; }
    }
  }

  // ================================================================== v2: insights (Live wire)
  async function loadInsights() {
    try {
      const data = await api('/api/insights?limit=50');
      state.insightsAvailable = true;
      (Array.isArray(data) ? data : []).slice().reverse().forEach((ins) => addInsight(ins, { live: false, render: false }));
      state.insights.sort((a, b) => (toT(b.createdAt) || 0) - (toT(a.createdAt) || 0));
    } catch { state.insightsAvailable = false; }
    renderFeed();
  }
  function insightMarkets(ins) { return (Array.isArray(ins.marketIds) ? ins.marketIds : []).filter(Boolean); }
  function isMineInsight(ins) {
    return insightMarkets(ins).some((id) => {
      const m = state.markets.get(id) || {};
      const sp = { marketId: id, title: m.title || ins.title, category: ins.category || m.category, tags: m.tags || [], source: m.source, delta: 1, severity: ins.severity || 'info', live: !!m.live };
      return state.subs.some((sub) => matchSub(sub, sp));
    });
  }
  function passesInsight(ins) {
    if (state.wire === 'spikes') return false;
    const ids = insightMarkets(ins);
    if (ids.length && ids.every(isMuted)) return false;
    if (state.category && ins.category && ins.category !== state.category) return false;
    if (state.feedFilter === 'notable' && (SEV_RANK[ins.severity] ?? 0) < 1) return false;
    if (state.feedFilter === 'mine' && !isMineInsight(ins)) return false;
    return true;
  }
  function insightCard(ins, animate) {
    const im = insMeta(ins.type);
    const ids = insightMarkets(ins);
    return h('li', {
      class: `insight sev-${ins.severity || 'info'}${animate ? ' arrive' : ''}`, style: `--k:${im.color}`,
      dataset: { ins: ins.id || '' },
      attrs: { tabindex: 0, 'aria-label': `${im.label}: ${ins.title || ''}` },
      onclick: (e) => { if (!e.target.closest('button,a') && ids[0]) openDrawer(ids[0]); },
      onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget && ids[0]) openDrawer(ids[0]); },
    },
      h('div', { class: 'ins-glyph' }, icon(im.icon)),
      h('div', { class: 'ins-body' },
        h('div', { class: 'ins-kicker' },
          h('span', { class: 'ins-type', text: im.label }),
          ins.severity && ins.severity !== 'info' ? h('span', { class: `badge sev-${ins.severity}`, text: ins.severity }) : null,
          ins.category ? h('span', { class: 'cat-chip', text: ins.category }) : null,
          h('span', { class: 'ago', dataset: { ts: ins.createdAt || '' }, text: ago(ins.createdAt) })),
        h('div', { class: 'ins-title', text: ins.title || im.label }),
        ins.body ? h('p', { class: 'ins-text', text: ins.body }) : null,
        contextChips(ins.context),
        recBlock(recFor(ins), ins.id, { compact: true }),
        ids.length ? h('div', { class: 'ins-mkts' }, ids.slice(0, 4).map((id) => {
          const m = state.markets.get(id);
          return h('button', { type: 'button', class: 'ins-mkt', onclick: (e) => { e.stopPropagation(); openDrawer(id); } },
            h('span', { class: 't', text: m && m.title ? truncate(m.title, 46) : 'Open related market' }), m && isNum(m.probability) ? h('b', { class: 'num', text: pct(m.probability) }) : null);
        })) : null));
  }
  function addInsight(ins, { live = false, render = true } = {}) {
    if (!ins || !ins.id || state.insightIds.has(ins.id)) return;
    state.insightIds.add(ins.id);
    state.insights.unshift(ins);
    if (state.insights.length > 200) { const gone = state.insights.pop(); state.insightIds.delete(gone.id); }
    if (!render) return;
    state.insightsAvailable = true;
    const visible = passesInsight(ins);
    if (visible) {
      const feed = $('#feed');
      feed.prepend(insightCard(ins, live));
      while (feed.children.length > 150) feed.lastElementChild.remove();
      $('#feed-count').textContent = String(feed.children.length);
      renderFeedEmpty(feed.children.length);
    }
    if (live && (SEV_RANK[ins.severity] ?? 0) >= 1 && !insightMarkets(ins).some(isMuted)) {
      const im = insMeta(ins.type);
      const ch = insightMarkets(ins)[0];
      if (gate(`ins:${ins.type}:${ch || ins.id}`, 10 * 60e3, 'insight', ins.severity === 'major' ? 15e3 : 45e3)) {
        islandShow({ tone: 'insight', color: im.color, iconName: im.icon, kicker: `${im.label}${ins.severity === 'major' ? ' · Major' : ''}`, title: ins.title || im.label, onclick: () => ch && openDrawer(ch), ms: ins.severity === 'major' ? 7000 : 5000 });
        if (pageHidden()) { const rn = roleNotice(ins, `${im.label}: ${ins.title || ''}`, ins.body || ''); sysNotify(rn.title, rn.body, `ins-${ins.id}`, () => ch && openDrawer(ch)); setUnread(state.unread + 1); }
      }
    }
    if (live && state.drawerId && insightMarkets(ins).includes(state.drawerId)) renderDrawerInsights();
  }

  // ================================================================== v2: stories
  let storiesLast = 0;
  async function loadStories(force = false) {
    if (!force && Date.now() - storiesLast < 15000) return;
    storiesLast = Date.now();
    try {
      const data = await api('/api/stories');
      state.stories = Array.isArray(data) ? data.filter((st) => st && Array.isArray(st.markets) && st.markets.length) : [];
    } catch { state.stories = []; }
    renderStories();
  }
  function renderStories() {
    const list = state.stories.filter((st) => !state.category || !st.category || st.category === state.category).slice(0, 12);
    $('#stories-card').hidden = !list.length;
    $('#stories-count').textContent = String(list.length);
    $('#stories').replaceChildren(...list.map((st) => {
      const d = st.direction === 'up' ? 'up' : st.direction === 'down' ? 'down' : 'mixed';
      const strength = isNum(st.strength) ? clamp(st.strength, 0, 1) : null;
      return h('article', { class: `story ${d}` },
        h('div', { class: 'story-head' },
          h('span', { class: 'story-ico' }, icon('story')),
          h('span', { class: 'story-dir', text: d === 'up' ? '▲ Moving up together' : d === 'down' ? '▼ Falling together' : '⇅ Pulling apart' }),
          st.category ? h('span', { class: 'cat-chip', text: st.category }) : null),
        h('h3', { class: 'story-title', text: st.title || 'Markets moving together' }),
        st.summary ? h('p', { class: 'story-sum', text: st.summary }) : null,
        h('ul', { class: 'story-mkts' }, st.markets.slice(0, 5).map((mk) => {
          const from = clamp(Number(mk.from) || 0, 0, 1), to = clamp(Number(mk.to) || 0, 0, 1);
          const lo = Math.min(from, to), hi = Math.max(from, to);
          const delta = isNum(mk.delta) ? mk.delta : to - from;
          return h('li', { class: dir(delta), attrs: { tabindex: 0, role: 'button' }, onclick: () => openDrawer(mk.id), onkeydown: (e) => { if (e.key === 'Enter') openDrawer(mk.id); } },
            h('div', { class: 'sm-row' }, h('span', { class: 'sm-title', text: mk.title || mk.id }), h('span', { class: `chg ${dir(delta)}`, text: ptsShort(delta) })),
            h('div', { class: 'sm-bar', attrs: { 'aria-hidden': 'true' } },
              h('i', { class: 'base', style: `width:${(lo * 100).toFixed(1)}%` }),
              h('i', { class: 'span', style: `left:${(lo * 100).toFixed(1)}%;width:${Math.max(0.8, (hi - lo) * 100).toFixed(1)}%` }),
              h('b', { style: `left:${(to * 100).toFixed(1)}%` })),
            h('div', { class: 'sm-ft num', text: `${pct(from)} → ${pct(to)}` }));
        })),
        h('div', { class: 'story-foot' },
          strength != null ? h('span', { class: 'story-str', attrs: { title: 'How tightly these markets moved together' } }, 'Strength', h('span', { class: 'meter' }, h('i', { style: `width:${(strength * 100).toFixed(0)}%` }))) : null,
          h('span', { class: 'muted small', dataset: { ts: st.updatedAt || st.startedAt || '' }, text: ago(st.updatedAt || st.startedAt) })));
    }));
  }

  // ================================================================== v2: briefing
  const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
  async function loadBriefing() {
    try {
      const b = await api('/api/briefing');
      state.briefing = b && (b.headline || (Array.isArray(b.bullets) && b.bullets.length)) ? b : null;
    } catch { state.briefing = null; }
    $('#btn-brief').hidden = !state.briefing;
    if (state.briefing && localStorage.getItem(LS.briefDismissed) !== todayKey()) renderBriefing(true);
  }
  function briefingMasthead() {
    const hr = new Date().getHours();
    const last = Number(localStorage.getItem(LS.lastVisit) || 0);
    if (last && Date.now() - last > 4 * 3600e3 && hr >= 11) return 'While you were away';
    if (hr < 12) return 'The Morning Line';
    if (hr < 18) return 'The Afternoon Line';
    return 'The Evening Line';
  }
  function renderBriefing(show) {
    const el = $('#briefing');
    const b = state.briefing;
    if (!b || !show) { el.hidden = true; return; }
    const bullets = (Array.isArray(b.bullets) ? b.bullets : []).filter(Boolean).slice(0, 6);
    const shifts = (Array.isArray(b.biggestShifts) ? b.biggestShifts : []).filter((x) => x && x.marketId).slice(0, 4);
    const gen = toT(b.generatedAt);
    fill(el,
      h('div', { class: 'brief-mast' },
        h('span', { class: 'brief-name', text: briefingMasthead() }),
        h('span', { class: 'brief-date', text: `${new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}${isNum(gen) ? ` · as of ${clock(gen)}` : ''}` }),
        h('button', { type: 'button', class: 'icon-btn brief-x', attrs: { 'aria-label': 'Dismiss briefing for today', title: 'Dismiss for today' }, text: '✕', onclick: dismissBriefing })),
      h('div', { class: 'brief-grid' },
        h('div', { class: 'brief-story' },
          h('h2', { id: 'brief-h', class: 'brief-headline', text: b.headline || 'Your briefing' }),
          bullets.length ? h('ul', { class: 'brief-bullets' }, bullets.map((t) => h('li', { text: String(t) }))) : null),
        shifts.length ? h('div', { class: 'brief-shifts' },
          h('div', { class: 'eyebrow', text: 'Biggest shifts · 24h' }),
          shifts.map((x) => {
            const delta = isNum(x.delta) ? x.delta : (Number(x.to) || 0) - (Number(x.from) || 0);
            return h('button', { type: 'button', class: `shift ${dir(delta)}`, onclick: () => openDrawer(x.marketId) },
              h('span', { class: 'shift-t', text: x.title || x.marketId }),
              h('span', { class: 'shift-n num' }, `${pct(x.from)} → `, h('b', { text: pct(x.to) })),
              h('span', { class: `chg ${dir(delta)}`, text: pts(delta, true) }));
          })) : null),
      h('div', { class: 'brief-actions' }, h('button', { type: 'button', class: 'btn btn-small', text: 'Got it, show me the shots', onclick: () => { dismissBriefing(); $('.shots-card').scrollIntoView({ behavior: 'smooth', block: 'start' }); } })));
    el.hidden = false;
  }
  function dismissBriefing() {
    localStorage.setItem(LS.briefDismissed, todayKey());
    const el = $('#briefing');
    if (el.hidden) return;
    if (el.animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-8px)' }], { duration: 220, easing: 'ease-in' }).onfinish = () => { el.hidden = true; };
    } else el.hidden = true;
  }
  function toggleBriefing() {
    if (!state.briefing) { toast('No briefing yet. Check back after the markets have moved.', 'warn'); return; }
    const el = $('#briefing');
    if (el.hidden) { renderBriefing(true); el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } else dismissBriefing();
  }

  // ================================================================== v2: drawer additions
  const FC_DRIVERS = [
    [/realized|vol|stdev|sigma/i, 'prices have been jumpy lately', 'prices have been unusually steady'],
    [/dist.*50|uncert|entropy|near.?50|balance|coin/i, 'odds are close to 50/50, so there\'s room to swing', 'odds are lopsided, so there\'s less room to swing'],
    [/live|in.?play/i, 'the event is live right now', 'the event isn\'t live'],
    [/start|kick|tip.?off|until.?start/i, 'the event starts soon', 'the start is still a while away'],
    [/end|resol|expir|close|remaining/i, 'resolution is close', 'resolution is far off'],
    [/volume/i, 'trading is heavy', 'trading is light'],
    [/liquid|depth|spread/i, 'the order book is thin, so prices move easily', 'the order book is deep'],
    [/momentum|trend|drift|slope/i, 'a steady one-way drift is building', 'no trend is building'],
    [/spike|recent.?move|jump|change/i, 'it has moved sharply in the last hour', 'it has barely moved recently'],
    [/hour|time.?of.?day|weekday/i, 'this is a busy time of day for it', 'this is a quiet time of day'],
  ];
  function fcDriverText(d) {
    if (d.label || d.text) return String(d.label || d.text);
    const f = String(d.feature || '');
    const neg = isNum(d.impact) && d.impact < 0;
    for (const [re, pos, negTxt] of FC_DRIVERS) if (re.test(f)) return neg ? negTxt : pos;
    return driverText(d);
  }
  async function getForecast(id) {
    const c = state.forecasts.get(id);
    if (c && Date.now() - c.at < 30000) return c.fc;
    try {
      const fc = await api(`/api/markets/${encodeURIComponent(id)}/forecast`, { timeout: 8000 });
      const ok = fc && isNum(fc.pMove30) ? fc : null;
      state.forecasts.set(id, { fc: ok, at: Date.now() });
      return ok;
    } catch { state.forecasts.set(id, { fc: null, at: Date.now() }); return null; }
  }
  async function renderDrawerForecast() {
    const id = state.drawerId;
    const box = $('#drawer-fc');
    const sh = state.shots.find((x) => x.marketId === id);
    let fc = await getForecast(id);
    if (state.drawerId !== id) return;
    if (!fc && sh && sh.forecast && isNum(sh.forecast.pMove30)) fc = sh.forecast;
    if (!fc) { box.hidden = true; return; }
    box.hidden = false;
    const p = clamp(fc.pMove30, 0, 1);
    $('#fc-p').textContent = pct(p);
    fill($('#fc-line'), 'chance of a ', h('b', { text: '5+ point swing' }), ' in the next 30 min',
      isNum(fc.expectedMovePts) ? h('span', { class: 'muted' }, ' · expected move ', h('b', { class: 'num', text: `±${Number(fc.expectedMovePts).toFixed(1)} pts` })) : null);
    fill($('#fc-meter'), forecastMeter(p, 30));
    const model = String(fc.model || '');
    const mEl = $('#fc-model');
    mEl.textContent = /heuristic/i.test(model) ? 'rule of thumb' : model ? 'ML model' : '';
    mEl.title = model ? `${model}${isNum(fc.historyMinutes) ? ` · ${Math.round(fc.historyMinutes)} min of history` : ''}` : '';
    const drivers = (Array.isArray(fc.drivers) ? fc.drivers : []).filter((d) => d && (d.feature || d.label || d.text)).slice(0, 3);
    fill($('#fc-drivers'), drivers.length ? h('li', { class: 'fc-why', text: 'Why:' }) : null, drivers.map((d) => {
      const neg = isNum(d.impact) && d.impact < 0;
      return h('li', { class: neg ? 'neg' : 'pos', attrs: { title: `${d.feature || ''}${isNum(d.value) ? ` = ${Number(d.value).toFixed(3)}` : ''}` } },
        h('span', { class: 'fd-arrow', attrs: { 'aria-hidden': 'true' }, text: neg ? '↓' : '↑' }), cap(fcDriverText(d)));
    }));
  }
  function renderDrawerShot() {
    const id = state.drawerId; if (!id) return;
    const el = $('#drawer-shot');
    const i = state.shots.findIndex((x) => x.marketId === id);
    if (i < 0) { el.hidden = true; return; }
    const sh = state.shots[i];
    const km = kindMeta(sh.kind);
    const win = windowInfo(sh.window);
    const tip = tipFor(sh);
    el.style.setProperty('--k', km.color);
    fill(el,
      h('div', { class: 'ds-top' }, h('span', { class: 'ds-rank num', text: `#${i + 1} on your shot list` }), kindBadge(sh.kind)),
      h('div', { class: 'ds-head', text: sh.headline || '' }),
      sh.why ? h('div', { class: 'ds-why', text: sh.why }) : null,
      win ? h('div', { class: `shot-win ${win.state}` }, h('span', { class: 'win-dot' }), h('span', { class: 'win-main num', dataset: win.until ? { until: String(win.until) } : {}, text: win.main }), win.sub ? h('span', { class: 'win-sub', text: win.sub }) : null) : null,
      contextChips(sh.context),
      recBlock(recFor(sh), sh.id || sh.marketId, { fallbackTip: tip }));
    el.hidden = false;
  }
  function renderDrawerInsights() {
    const id = state.drawerId; if (!id) return;
    const list = state.insights.filter((ins) => insightMarkets(ins).includes(id)).slice(0, 8);
    $('#drawer-ins-wrap').hidden = !list.length;
    $('#drawer-insights').replaceChildren(...list.map((ins) => {
      const im = insMeta(ins.type);
      return h('li', { style: `--k:${im.color}` },
        h('span', { class: 'ins-glyph sm' }, icon(im.icon)),
        h('div', {}, h('div', { class: 'im-title' }, h('b', { text: ins.title || im.label }), ' ', h('span', { class: 'muted small', dataset: { ts: ins.createdAt || '' }, text: ago(ins.createdAt) })),
          ins.body ? h('div', { class: 'muted small', text: ins.body }) : null));
    }));
  }

  // ================================================================== v3: role recommendations + live context
  const ROLE_EMOJI = { photographer: '📸', trader: '📈', fan: '🏟️', journalist: '📰', general: '✨' };
  function recFor(item, role = state.persona) {
    const r = item && item.recommendations;
    if (!r || typeof r !== 'object') return null;
    const rec = r[role] || r.general || null;
    return rec && (rec.headline || rec.action) ? rec : null;
  }
  /** Prominent recommendation block. data-rec-for lets SSE `recommendation` events swap it in place. */
  function recBlock(rec, targetId, { compact = false, fallbackTip = '' } = {}) {
    const role = state.persona;
    const who = h('span', { class: 'tip-who' }, h('span', { attrs: { 'aria-hidden': 'true' }, text: ROLE_EMOJI[role] || '✨' }), role === 'general' ? 'The move' : `For ${PERSONA_SHORT[role].toLowerCase()}s`);
    if (!rec) {
      if (!fallbackTip) return null;
      return h('div', { class: 'shot-tip rec', dataset: { recFor: targetId || '' } }, who, h('span', { class: 'tip-text', text: fallbackTip }));
    }
    const src = rec.source === 'claude' ? 'claude' : 'rules';
    const conf = ['low', 'medium', 'high'].includes(rec.confidence) ? rec.confidence : null;
    const reasons = (Array.isArray(rec.reasoning) ? rec.reasoning : []).filter(Boolean).slice(0, 3);
    const disclaimer = rec.disclaimer || (role === 'trader' ? 'Signal, not financial advice.' : '');
    return h('div', { class: `shot-tip rec src-${src}${compact ? ' compact' : ''}`, dataset: { recFor: targetId || '' } },
      h('div', { class: 'rec-top' }, who,
        conf ? h('span', { class: `conf conf-${conf}`, attrs: { title: 'Recommendation confidence' } }, h('i'), h('i'), h('i'), `${cap(conf)}`) : null,
        h('span', { class: `src-badge ${src}`, attrs: { title: src === 'claude' ? `Written by Claude${rec.model ? ` (${rec.model})` : ''} from live data` : 'Deterministic rules from live numbers' }, text: src === 'claude' ? '✦ Claude' : 'Rules' })),
      rec.headline ? h('div', { class: 'rec-head', text: rec.headline }) : null,
      rec.action ? h('div', { class: 'rec-action' }, h('span', { class: 'rec-arrow', attrs: { 'aria-hidden': 'true' }, text: '→' }), h('span', { text: rec.action })) : null,
      reasons.length ? h('details', { class: 'rec-why', onclick: (e) => e.stopPropagation() },
        h('summary', { text: `Why${reasons.length > 1 ? ` · ${reasons.length} reasons` : ''}` }),
        h('ul', {}, reasons.map((r) => h('li', { text: String(r) })))) : null,
      disclaimer && role === 'trader' ? h('div', { class: 'rec-disc', text: disclaimer }) : null);
  }
  function fmtMoney(v) {
    if (!isNum(v)) return '';
    return v >= 1000 ? `$${Math.round(v).toLocaleString()}` : `$${v.toLocaleString(undefined, { maximumFractionDigits: v < 10 ? 4 : 2 })}`;
  }
  /** Live context chips: game scoreboard / situation / imminent, or asset spot price. */
  function contextChips(ctx) {
    if (!ctx || typeof ctx !== 'object') return null;
    const kids = [];
    if (ctx.kind === 'game') {
      const sc = ctx.score || {};
      const st = ctx.status === 'in' ? 'in' : ctx.status === 'post' ? 'post' : 'pre';
      if (sc.homeTeam || sc.awayTeam) {
        kids.push(h('span', { class: `ctx-chip score ${st}` },
          st === 'in' ? h('i', { class: 'ctx-live', attrs: { 'aria-hidden': 'true' } }) : null,
          h('b', { text: String(sc.awayTeam || 'Away') }), h('span', { class: 'num', text: ` ${sc.away ?? '–'}` }), h('span', { class: 'ctx-sep', text: ' – ' }),
          h('span', { class: 'num', text: `${sc.home ?? '–'} ` }), h('b', { text: String(sc.homeTeam || 'Home') }),
          st === 'post' ? h('span', { class: 'ctx-clock', text: 'Final' })
            : (ctx.period || ctx.clock) ? h('span', { class: 'ctx-clock num', text: [ctx.period != null ? (/^\d+$/.test(String(ctx.period)) ? `P${ctx.period}` : String(ctx.period)) : '', ctx.clock || ''].filter(Boolean).join(' ') }) : null));
      }
      if (ctx.situation) kids.push(h('span', { class: 'ctx-chip sit', text: String(ctx.situation) }));
      const im = ctx.imminent;
      if (im && (im.type || im.text)) {
        kids.push(h('span', { class: 'ctx-chip imminent', attrs: { title: `${im.text || ''}${isNum(im.confidence) ? ` (${Math.round(im.confidence * 100)}% confidence)` : ''}` } },
          h('i', { attrs: { 'aria-hidden': 'true' } }), `Imminent: ${im.type || 'play'}${im.team ? ` · ${im.team}` : ''}`));
      }
      if (ctx.lastPlay) kids.push(h('span', { class: 'ctx-chip last', attrs: { title: String(ctx.lastPlay) }, text: `Last: ${truncate(ctx.lastPlay, 60)}` }));
    } else if (ctx.kind === 'asset' && ctx.symbol) {
      const c = isNum(ctx.change1h) ? ctx.change1h : ctx.change5m;
      const lbl = isNum(ctx.change1h) ? '1h' : '5m';
      // asset changes may be fractions (0.012) or percents (1.2); treat |x| < 1 as a fraction
      const pctv = isNum(c) ? (Math.abs(c) < 1 ? c * 100 : c) : null;
      kids.push(h('span', { class: 'ctx-chip asset' }, h('b', { text: String(ctx.symbol).toUpperCase() }), ' ', h('span', { class: 'num', text: fmtMoney(Number(ctx.price)) }),
        pctv != null ? h('span', { class: `chg ${dir(pctv)}`, text: ` ${pctv >= 0 ? '▲' : '▼'}${Math.abs(pctv).toFixed(1)}% ${lbl}` }) : null));
    }
    return kids.length ? h('div', { class: 'ctx-row' }, kids) : null;
  }
  const isVol = (sp) => sp && sp.kind === 'volatility';
  function volLabel(sp) { return isNum(sp.volRatio) ? `Thrashing ×${Number(sp.volRatio).toFixed(1)}` : 'Thrashing'; }
  function findRecTarget(id) {
    return state.alerts.find((x) => x.id === id) || state.shots.find((x) => x.id === id || x.marketId === id) || state.insights.find((x) => x.id === id) || null;
  }
  function onRecommendation(d) {
    if (!d || !d.targetId || !d.role || !d.recommendation) return;
    const item = findRecTarget(d.targetId);
    if (item) item.recommendations = { ...(item.recommendations || {}), [d.role]: d.recommendation };
    if (d.role !== state.persona && !(state.persona !== 'general' && d.role === 'general' && item && !(item.recommendations || {})[state.persona])) return;
    const rec = item ? recFor(item) : d.recommendation;
    $$('[data-rec-for]').filter((el) => el.dataset.recFor === String(d.targetId)).forEach((el) => {
      const nb = recBlock(rec, d.targetId, { compact: el.classList.contains('compact') });
      if (!nb) return;
      nb.classList.add('shimmer');
      el.replaceWith(nb);
    });
  }
  /** Notification copy for the active role: "📸 Chiefs 1st & goal at the 4 — get the end-zone shot". */
  function roleNotice(item, fallbackTitle, fallbackBody) {
    const rec = recFor(item);
    if (!rec) return { title: fallbackTitle, body: fallbackBody };
    const em = ROLE_EMOJI[state.persona] || '✨';
    const body = [rec.action && rec.action !== rec.headline ? rec.action : '', state.persona === 'trader' ? (rec.disclaimer || 'Signal, not financial advice.') : ''].filter(Boolean).join(' · ');
    return { title: `${em} ${rec.headline || rec.action}`, body: body || fallbackBody };
  }

  // ---------- drawer: live context + role recommendation (REST fallbacks, 404-safe)
  const ctxCache = new Map(), recCache = new Map();
  async function cachedGet(cache, key, path, ttl) {
    const c = cache.get(key);
    if (c && Date.now() - c.at < ttl) return c.v;
    let v = null;
    try { v = await api(path, { timeout: 25000 }); } catch { v = null; }
    cache.set(key, { v, at: Date.now() });
    return v;
  }
  function drawerItems(id) {
    return [state.shots.find((x) => x.marketId === id), state.alerts.find((x) => x.marketId === id), state.insights.find((x) => insightMarkets(x).includes(id))].filter(Boolean);
  }
  async function renderDrawerContext() {
    const id = state.drawerId; if (!id) return;
    const items = drawerItems(id);
    const role = state.persona;
    const ctxEl = $('#drawer-ctx'), recEl = $('#drawer-rec');
    let ctx = (items.find((x) => x.context) || {}).context || null;
    fill(ctxEl, contextChips(ctx));
    const shotHasRec = state.shots.some((x) => x.marketId === id && recFor(x));
    let recItem = items.find((x) => recFor(x));
    const paint = (rec) => {
      if (state.drawerId !== id || state.persona !== role) return;
      // the shot section already shows the shot's recommendation
      if (!rec || shotHasRec) { recEl.hidden = true; return; }
      fill(recEl, recBlock(rec, recItem ? (recItem.id || id) : `market:${id}`));
      recEl.hidden = false;
    };
    paint(recItem ? recFor(recItem) : null);
    if (!ctx) {
      const c = await cachedGet(ctxCache, id, `/api/markets/${encodeURIComponent(id)}/context`, 15000);
      if (state.drawerId === id && c && c.kind) fill(ctxEl, contextChips(c));
    }
    if (!recItem && !shotHasRec) {
      const r = await cachedGet(recCache, `${id}|${role}`, `/api/markets/${encodeURIComponent(id)}/recommendation?role=${encodeURIComponent(role)}`, 120000);
      const rec = r && (r.headline || r.action) ? r : r && r.recommendation && (r.recommendation.headline || r.recommendation.action) ? r.recommendation : null;
      paint(rec);
    }
  }

  // ================================================================== generic island
  function islandShow({ tone = 'shot', color = '#c6ff3d', iconName = 'eye', kicker = '', title = '', big = '', small = '', onclick = null, ms = 5000 }) {
    const host = $('#island');
    const pill = h('div', { class: `pill pill-${tone}`, style: `--k:${color}`, attrs: { role: 'button', tabindex: 0 },
      onclick: () => { if (onclick) onclick(); dismiss(); } },
      h('div', { class: 'p-ico' }, icon(iconName)),
      h('div', { class: 'p-body' }, h('div', { class: 'p-kicker', text: kicker }), h('div', { class: 'p-title', text: title })),
      big ? h('div', { class: 'p-num' }, h('div', { class: 'p-to', text: big }), small ? h('div', { class: 'p-d', text: small }) : null) : h('div'));
    host.prepend(pill);
    while (host.children.length > 2) host.lastElementChild.remove();
    let gone = false;
    function dismiss() { if (gone) return; gone = true; pill.classList.add('out'); setTimeout(() => pill.remove(), 400); }
    setTimeout(dismiss, ms);
  }

  // ------------------------------------------------------------------ health
  async function loadHealth() {
    try {
      const hd = await api('/api/health', { timeout: 6000 });
      state.health = hd;
      setBackend(true);
    } catch {
      setBackend(false);
    }
    renderHealth();
  }
  function setBackend(up) {
    const was = state.backendUp;
    state.backendUp = up;
    const b = $('#banner');
    if (!up) { b.hidden = false; b.textContent = 'Can\'t reach the Tipoff server. Retrying automatically…'; }
    else b.hidden = true;
    if (was === false && up) { toast('Back online.'); bootData(); }
    if (was !== up) { renderFeedEmpty($('#feed').children.length); renderSeismo(); if (!state.movers.length) renderMovers(); if (!state.shots.length) renderShots(); }
  }
  function renderHealth() {
    const el = $('#health');
    const hd = state.health;
    if (!hd || state.backendUp === false) {
      el.replaceChildren(h('span', { class: 'src bad' }, h('i'), 'Server offline'));
      return;
    }
    const last = (state.lastTick && state.lastTick.at) || hd.lastPollAt;
    const count = (state.lastTick && state.lastTick.marketCount) ?? hd.marketCount;
    const srcs = Object.entries(hd.sources || {});
    fill(el,
      h('span', { class: `src ${hd.ok === false ? 'bad' : 'ok'}` }, h('i'), hd.ok === false ? 'Degraded' : 'Operational'),
      isNum(count) ? h('span', { class: 'num', text: `${count.toLocaleString()} markets` }) : null,
      last ? h('span', { class: 'num', dataset: { ts: last, prefix: 'last poll ' }, text: `last poll ${ago(last)}` }) : h('span', { class: 'muted', text: 'first poll pending' }),
      ...srcs.map(([name, st]) => h('span', {
        class: `src ${st && st.ok ? 'ok' : 'bad'}`,
        title: st && st.error ? String(st.error) : '',
      }, h('i'), `${name}${st && isNum(st.count) ? ` · ${st.count}` : ''}${st && !st.ok && st.error ? ` · ${truncate(st.error, 40)}` : ''}`)));
  }

  // ------------------------------------------------------------------ VIX load
  async function loadVix() {
    try {
      const d = await api('/api/vix');
      if (!d) return;
      state.vix = { overall: d.overall, byCategory: d.byCategory || {}, updatedAt: d.updatedAt };
      if (Array.isArray(d.history)) {
        state.vixHistory = d.history.map((p) => ({ t: typeof p.t === 'number' ? p.t : Date.parse(p.t), overall: Number(p.overall) })).filter((p) => isNum(p.t) && isNum(p.overall)).sort((a, b) => a.t - b.t);
      }
      renderVix();
    } catch { /* keep previous */ }
  }
  function onVixEvent(d) {
    if (!d || !isNum(d.overall)) return;
    state.vix = { overall: d.overall, byCategory: d.byCategory || {}, updatedAt: d.updatedAt };
    const t = Date.parse(d.updatedAt) || Date.now();
    const last = state.vixHistory[state.vixHistory.length - 1];
    if (!last || t > last.t) state.vixHistory.push({ t, overall: d.overall });
    const cutoff = Date.now() - VIX_WINDOW_MS;
    while (state.vixHistory.length && state.vixHistory[0].t < cutoff) state.vixHistory.shift();
    renderVix();
  }

  // ------------------------------------------------------------------ alerts load
  async function loadAlerts() {
    try {
      const data = await api('/api/alerts?limit=100');
      const list = Array.isArray(data) ? data : [];
      let added = 0;
      // backlog is newest first; insert oldest first so final order is newest first
      for (const sp of list.slice().reverse()) {
        if (!sp || !sp.id || state.alertIds.has(sp.id)) continue;
        state.alertIds.add(sp.id);
        state.alerts.push(sp);
        rememberMarket(marketFromSpike(sp));
        added++;
      }
      if (added) {
        state.alerts.sort((a, b) => (Date.parse(b.detectedAt) || 0) - (Date.parse(a.detectedAt) || 0));
        state.alerts.splice(MAX_ALERTS).forEach((x) => state.alertIds.delete(x.id));
      }
      renderFeed();
      renderSubs();
    } catch { renderFeed(); }
  }

  // ------------------------------------------------------------------ SSE
  let es = null, esRetry = 0, esTimer = null;
  function setConn(st) {
    const c = $('#conn');
    c.dataset.state = st;
    $('.conn-label', c).textContent = { connected: 'Live', reconnecting: 'Reconnecting', connecting: 'Connecting', offline: 'Offline' }[st] || st;
    state.connected = st === 'connected';
  }
  function parse(e) { try { return JSON.parse(e.data); } catch { return null; } }
  function connectStream() {
    clearTimeout(esTimer);
    if (es) { try { es.close(); } catch { /* */ } }
    if (!('EventSource' in window)) { setConn('offline'); return; }
    setConn(esRetry ? 'reconnecting' : 'connecting');
    es = new EventSource('/api/stream');
    es.onopen = () => {
      const wasRetry = esRetry > 0;
      esRetry = 0;
      setConn('connected');
      setBackend(true);
      if (wasRetry) { loadAlerts(); loadVix(); loadMovers(true); loadHealth(); loadShots(true); loadInsights(); loadStories(true); }
      renderFeedEmpty($('#feed').children.length);
    };
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        esRetry++;
        setConn('reconnecting');
        const delay = Math.min(30000, 1000 * Math.pow(1.7, esRetry));
        esTimer = setTimeout(connectStream, delay);
      } else {
        esRetry = Math.max(1, esRetry);
        setConn('reconnecting');
      }
    };
    es.addEventListener('spike', (e) => { const sp = parse(e); if (sp) addSpike(sp, { live: true }); });
    es.addEventListener('vix', (e) => onVixEvent(parse(e)));
    es.addEventListener('insight', (e) => { const ins = parse(e); if (ins) addInsight(ins, { live: true }); });
    es.addEventListener('shots', (e) => onShotsEvent(parse(e)));
    es.addEventListener('recommendation', (e) => onRecommendation(parse(e)));
    es.addEventListener('tick', (e) => {
      const d = parse(e);
      if (d) { state.lastTick = d; renderHealth(); renderFeedEmpty($('#feed').children.length); }
      loadMovers();
      loadStories();
    });
  }

  // ------------------------------------------------------------------ simulate
  async function simulate() {
    const b = $('#btn-simulate');
    b.disabled = true;
    try {
      const r = await api('/api/demo/spike', { method: 'POST' });
      const sp = r && (r.spike || (r.id ? r : null));
      if (sp && sp.id) setTimeout(() => addSpike(sp, { live: true }), 600); // SSE usually wins; dedupe by id
      else toast('Demo spike injected.');
    } catch (err) { toast(`Simulate failed: ${err.message}`, 'err'); }
    finally { setTimeout(() => { b.disabled = false; }, 600); }
  }

  // ------------------------------------------------------------------ relative timestamps
  function tickClocks() {
    $$('[data-ts]').forEach((el) => {
      const ts = el.dataset.ts;
      if (!ts) return;
      const t = /^\d+$/.test(ts) ? Number(ts) : ts;
      el.textContent = `${el.dataset.prefix || ''}${ago(t)}`;
    });
    const now = Date.now();
    let expired = false;
    $$('[data-until]').forEach((el) => {
      const u = Number(el.dataset.until);
      if (!isNum(u)) return;
      if (u <= now) { expired = true; delete el.dataset.until; el.textContent = 'Starting now'; return; }
      el.textContent = `Starts in ${durShort(u - now)}`;
    });
    if (expired) setTimeout(() => { renderShots(); renderDrawerShot(); }, 1500);
  }

  // ------------------------------------------------------------------ keyboard
  function onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target && e.target.tagName) || '';
    const typing = /INPUT|TEXTAREA|SELECT/.test(tag) || (e.target && e.target.isContentEditable);
    if (e.key === 'Escape') {
      if (!$('#help').hidden) closeModal('help');
      else if (!$('#onboard').hidden) { closeModal('onboard'); localStorage.setItem(LS.onboarded, '1'); }
      else if (state.drawerId) closeDrawer();
      else if (typing) e.target.blur();
      return;
    }
    if (typing) return;
    if (!$('#onboard').hidden) return;
    const k = e.key;
    if (k === '/') { e.preventDefault(); const q = $('#search-q'); q.focus(); q.select(); q.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    else if (k === 's' || k === 'S') simulate();
    else if (k === 'n' || k === 'N') enableNotifications();
    else if (k === 'm' || k === 'M') setSound(!state.sound);
    else if (k === 'p' || k === 'P') cyclePersona();
    else if (k === 'b' || k === 'B') toggleBriefing();
    else if (k === '?') { if ($('#help').hidden) openModal('help'); else closeModal('help'); }
    else if (/^[0-9]$/.test(k)) { const i = Number(k); setCategory(i === 0 ? '' : CATEGORIES[i - 1] || state.category); }
  }

  // ------------------------------------------------------------------ boot
  async function bootData() {
    await Promise.all([loadVix(), loadAlerts(), loadMovers(true), loadSubs(), loadHealth(), loadShots(true), loadStories(true)]);
    await loadInsights();
    runSearch(true);
  }
  function wire() {
    $('#btn-simulate').addEventListener('click', simulate);
    $('#btn-notify').addEventListener('click', enableNotifications);
    $('#btn-sound').addEventListener('click', () => setSound(!state.sound));
    $('#btn-help').addEventListener('click', () => openModal('help'));
    $$('[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(b.dataset.close)));
    $$('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) { closeModal(m.id); if (m.id === 'onboard') localStorage.setItem(LS.onboarded, '1'); } }));
    $('#onboard-skip').addEventListener('click', () => { closeModal('onboard'); localStorage.setItem(LS.onboarded, '1'); });
    $$('#filter-seg .seg-btn').forEach((b) => b.addEventListener('click', () => {
      $$('#filter-seg .seg-btn').forEach((x) => x.classList.toggle('active', x === b));
      state.feedFilter = b.dataset.filter;
      renderFeed();
    }));
    $$('#wire-seg .seg-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.wire === state.wire);
      b.addEventListener('click', () => {
        $$('#wire-seg .seg-btn').forEach((x) => x.classList.toggle('active', x === b));
        state.wire = b.dataset.wire;
        localStorage.setItem(LS.wire, state.wire);
        renderFeed();
      });
    });
    $('#shots-more').addEventListener('click', () => { state.shotsExpanded = !state.shotsExpanded; renderShots(); });
    $('#btn-brief').addEventListener('click', toggleBriefing);
    window.addEventListener('pagehide', () => localStorage.setItem(LS.lastVisit, String(Date.now())));
    $('#search-q').addEventListener('input', () => runSearch());
    $('#sub-form').addEventListener('submit', saveSub);
    $('#sub-form').minDelta.addEventListener('input', (e) => { $('#mindelta-out').textContent = e.target.value; });
    $('#btn-del-sub').addEventListener('click', deleteSub);
    $('#btn-test-sub').addEventListener('click', testSub);
    $('#btn-reset-sub').addEventListener('click', resetForm);
    $('#btn-new-sub').addEventListener('click', () => { resetForm(); const f = $('#sub-form'); f.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); f.name.focus({ preventScroll: true }); });
    $('#drawer-close').addEventListener('click', closeDrawer);
    $('#drawer-scrim').addEventListener('click', closeDrawer);
    $('#drawer-mute').addEventListener('click', () => {
      const id = state.drawerId; if (!id) return;
      if (isMuted(id)) unmuteMarket(id); else muteMarket(id, 3600e3, marketFor(id).title);
    });
    $$('#range-seg .seg-btn').forEach((b) => b.addEventListener('click', () => {
      $$('#range-seg .seg-btn').forEach((x) => x.classList.toggle('active', x === b));
      state.drawerRange = Number(b.dataset.range);
      const c = state.drawerId && state.histCache.get(state.drawerId);
      if (c) drawDrawerChart(c.points);
    }));
    const noise = $('#hide-noise');
    noise.checked = state.hideNoise;
    noise.addEventListener('change', () => { state.hideNoise = noise.checked; localStorage.setItem(LS.noise, noise.checked ? '1' : '0'); renderFeed(); });
    const clearUnread = () => { if (state.unread && document.visibilityState === 'visible') setUnread(0); };
    window.addEventListener('focus', clearUnread);
    document.addEventListener('visibilitychange', clearUnread);
    $('#drawer-watch').addEventListener('click', () => { if (state.drawerId) toggleWatch(marketFor(state.drawerId), $('#drawer-watch')); });
    document.addEventListener('keydown', onKey);
    const tb = $('.topbar');
    const setTb = () => document.documentElement.style.setProperty('--tb', `${tb.offsetHeight}px`);
    setTb();
    if ('ResizeObserver' in window) new ResizeObserver(setTb).observe(tb);
    let rz = null;
    let lastSmall = matchMedia('(max-width: 820px)').matches;
    window.addEventListener('resize', () => {
      clearTimeout(rz);
      rz = setTimeout(() => {
        renderSeismo();
        const small = matchMedia('(max-width: 820px)').matches;
        if (small !== lastSmall) { lastSmall = small; renderShots(); }
        if (state.drawerId) { const c = state.histCache.get(state.drawerId); if (c) drawDrawerChart(c.points); }
      }, 150);
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { tickClocks(); loadMovers(); } });
  }

  function init() {
    loadMuted();
    state.hideNoise = localStorage.getItem(LS.noise) === '1';
    const savedCat = localStorage.getItem(LS.cat) || '';
    state.category = CATEGORIES.includes(savedCat) ? savedCat : '';
    const savedPersona = localStorage.getItem(LS.persona);
    state.persona = PERSONAS[savedPersona] ? savedPersona : 'general';
    const savedWire = localStorage.getItem(LS.wire);
    state.wire = ['all', 'spikes', 'insights'].includes(savedWire) ? savedWire : 'all';
    renderPersonaSwitch();
    renderShots();
    renderPersonaRow();
    renderOnboarding();
    resetForm();
    renderCatNav();
    renderVix();
    renderTape();
    renderNotifyBtn();
    setSound(false); // audio needs a user gesture, so always start muted
    wire();
    connectStream();
    bootData().then(() => {
      if (!localStorage.getItem(LS.onboarded) && state.backendUp && !state.subs.length) openModal('onboard');
      loadBriefing();
    });
    setInterval(() => loadShots(true), 60000);
    setInterval(() => loadStories(true), 60000);
    setInterval(tickClocks, 1000);
    setInterval(() => loadMovers(true), 30000);
    setInterval(loadHealth, 30000);
    setInterval(() => { if (state.vixHistory.length) renderSeismo(); }, 60000);
    // While the backend is down, probe faster so the page comes alive quickly.
    setInterval(() => { if (state.backendUp === false) loadHealth(); }, 5000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
