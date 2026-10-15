// Subscription matching + validation. Pure functions, no I/O.

export const SEVERITIES = ['info', 'notable', 'major'];
export const PERSONAS = ['photographer', 'trader', 'fan', 'journalist', 'general'];
export const WEBHOOK_TYPES = ['generic', 'discord', 'slack', 'ntfy'];
export const CATEGORIES = ['sports', 'politics', 'crypto', 'economics', 'entertainment', 'weather', 'tech', 'other'];
export const SOURCES = ['polymarket', 'kalshi'];

export function severityRank(s) {
  const i = SEVERITIES.indexOf(s);
  return i === -1 ? 0 : i;
}

const lc = (s) => String(s ?? '').toLowerCase();
const nonEmpty = (a) => Array.isArray(a) && a.length > 0;

/** Does a spike satisfy a subscription? Empty lists mean "any". */
export function matchesSubscription(spike, sub) {
  if (!spike || !sub) return false;
  const m = sub.match || {};

  if (nonEmpty(m.marketIds) && !m.marketIds.includes(spike.marketId)) return false;
  if (nonEmpty(m.sources) && !m.sources.map(lc).includes(lc(spike.source))) return false;
  if (nonEmpty(m.categories) && !m.categories.map(lc).includes(lc(spike.category))) return false;

  if (nonEmpty(m.keywords)) {
    const title = lc(spike.title);
    const tags = (spike.tags || []).map(lc);
    const hit = m.keywords.some((kw) => {
      const k = lc(kw).trim();
      if (!k) return false;
      return title.includes(k) || tags.some((t) => t.includes(k));
    });
    if (!hit) return false;
  }

  const minDelta = Number(sub.minDelta) || 0;
  if (Math.abs(Number(spike.delta) || 0) < minDelta) return false;

  if (severityRank(spike.severity) < severityRank(sub.minSeverity || 'info')) return false;

  if (sub.liveOnly && !spike.live) return false;

  return true;
}

/**
 * Does an Insight satisfy a subscription? Same semantics as spikes:
 * marketIds/sources/categories/keywords/minSeverity/liveOnly. minDelta applies only when
 * the insight carries a numeric move (data.delta); calm-before-storm etc. have none.
 */
export function matchesInsight(insight, sub, marketsById = null) {
  if (!insight || !sub) return false;
  const m = sub.match || {};
  const ids = insight.marketIds || [];
  const mkts = marketsById ? ids.map((id) => marketsById.get?.(id)).filter(Boolean) : [];
  if (nonEmpty(m.marketIds) && !ids.some((id) => m.marketIds.includes(id))) return false;
  if (nonEmpty(m.sources)) {
    const srcs = [insight.data?.source, ...mkts.map((x) => x.source)].filter(Boolean).map(lc);
    if (!m.sources.map(lc).some((s) => srcs.includes(s))) return false;
  }
  if (nonEmpty(m.categories) && !m.categories.map(lc).includes(lc(insight.category))) return false;
  if (nonEmpty(m.keywords)) {
    const text = lc([insight.title, insight.body, ...mkts.map((x) => x.title)].join(' '));
    const tags = mkts.flatMap((x) => x.tags || []).map(lc);
    const hit = m.keywords.some((kw) => {
      const k = lc(kw).trim();
      return k && (text.includes(k) || tags.some((t) => t.includes(k)));
    });
    if (!hit) return false;
  }
  const d = Number(insight.data?.delta);
  if (Number.isFinite(d) && Math.abs(d) < (Number(sub.minDelta) || 0)) return false;
  if (severityRank(insight.severity) < severityRank(sub.minSeverity || 'info')) return false;
  const live = insight.data?.live ?? mkts.some((x) => x.live);
  if (sub.liveOnly && !live) return false;
  return true;
}

export function matchInsightSubscriptions(insight, subs, marketsById = null) {
  return (subs || []).filter((s) => matchesInsight(insight, s, marketsById)).map((s) => s.id);
}

/** → array of matching subscription ids */
export function matchSubscriptions(spike, subs) {
  return (subs || []).filter((s) => matchesSubscription(spike, s)).map((s) => s.id);
}

function strList(v, field, errors, { lower = false, allowed } = {}) {
  if (v == null) return [];
  if (typeof v === 'string') v = v.split(',');
  if (!Array.isArray(v)) {
    errors.push(`${field} must be an array of strings`);
    return [];
  }
  const out = [];
  for (const x of v) {
    if (typeof x !== 'string') {
      errors.push(`${field} must contain only strings`);
      return [];
    }
    let s = x.trim();
    if (lower) s = s.toLowerCase();
    if (!s) continue;
    if (allowed && !allowed.includes(s)) {
      errors.push(`${field}: unknown value "${s}" (allowed: ${allowed.join(', ')})`);
      continue;
    }
    if (!out.includes(s)) out.push(s);
  }
  if (out.length > 200) errors.push(`${field}: too many entries (max 200)`);
  return out;
}

/**
 * Validate + normalize subscription input.
 * @param input  raw request body
 * @param existing  existing subscription when updating (PUT merges onto it)
 * @returns {{ok: true, value} | {ok: false, errors: string[]}}
 */
export function validateSubscription(input, existing = null) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['body must be a JSON object'] };
  }
  const base = existing || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);
  const pick = (k, d) => (has(k) ? input[k] : base[k] ?? d);

  const name = pick('name', '');
  if (typeof name !== 'string' || !name.trim()) errors.push('name is required');
  else if (name.length > 120) errors.push('name must be <= 120 chars');

  const persona = pick('persona', 'general');
  if (!PERSONAS.includes(persona)) errors.push(`persona must be one of ${PERSONAS.join(', ')}`);

  const rawMatch = has('match') ? input.match : base.match || {};
  let match = { keywords: [], categories: [], marketIds: [], sources: [] };
  if (rawMatch != null && (typeof rawMatch !== 'object' || Array.isArray(rawMatch))) {
    errors.push('match must be an object');
  } else {
    const rm = rawMatch || {};
    match = {
      keywords: strList(rm.keywords, 'match.keywords', errors),
      categories: strList(rm.categories, 'match.categories', errors, { lower: true, allowed: CATEGORIES }),
      marketIds: strList(rm.marketIds, 'match.marketIds', errors),
      sources: strList(rm.sources, 'match.sources', errors, { lower: true, allowed: SOURCES }),
    };
  }

  let minDelta = pick('minDelta', 0.05);
  minDelta = Number(minDelta);
  if (!Number.isFinite(minDelta) || minDelta < 0 || minDelta > 1) errors.push('minDelta must be a number between 0 and 1');

  const minSeverity = pick('minSeverity', 'info');
  if (!SEVERITIES.includes(minSeverity)) errors.push(`minSeverity must be one of ${SEVERITIES.join(', ')}`);

  const liveOnly = pick('liveOnly', false);
  if (typeof liveOnly !== 'boolean') errors.push('liveOnly must be a boolean');

  let webhook = has('webhook') ? input.webhook : base.webhook ?? null;
  if (webhook != null) {
    if (typeof webhook !== 'object' || Array.isArray(webhook)) {
      errors.push('webhook must be an object or null');
    } else if (!webhook.url) {
      webhook = null; // empty url = no webhook
    } else {
      const type = webhook.type || 'generic';
      if (!WEBHOOK_TYPES.includes(type)) errors.push(`webhook.type must be one of ${WEBHOOK_TYPES.join(', ')}`);
      let u;
      try {
        u = new URL(String(webhook.url));
      } catch {
        errors.push('webhook.url must be a valid URL');
      }
      if (u && !['http:', 'https:'].includes(u.protocol)) errors.push('webhook.url must be http(s)');
      webhook = { type, url: String(webhook.url) };
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      ...(existing ? { id: existing.id, createdAt: existing.createdAt } : {}),
      name: name.trim(),
      persona,
      match,
      minDelta,
      minSeverity,
      liveOnly,
      webhook,
    },
  };
}
