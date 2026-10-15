// Oddshot webhook delivery: generic JSON, Discord, Slack, ntfy.sh.
// deliver() never throws; it resolves to {ok, status?, error?}.

const TIMEOUT_MS = 8000;

const SEVERITY_ICON = { major: '🚨', notable: '⚡', info: '📈' };
const SEVERITY_COLOR = { major: 0xff3b30, notable: 0xffb020, info: 0x3a8dff };
const NTFY_PRIORITY = { major: '5', notable: '4', info: '3' };
const NTFY_TAG = { major: 'rotating_light', notable: 'zap', info: 'chart_with_upwards_trend' };

const pct = (p) => `${Math.round((Number(p) || 0) * 100)}%`;

export function formatDuration(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h${rm}m` : `${h}h`;
}

/** "Lakers vs Celtics: Lakers win" — omit the outcome when it's a plain Yes. */
export function headline(spike) {
  const title = String(spike.title || spike.marketId || 'Market').trim();
  const outcome = String(spike.outcome || '').trim();
  if (!outcome || /^yes$/i.test(outcome) || title.toLowerCase().includes(outcome.toLowerCase())) return title;
  return `${title}: ${outcome}`;
}

export function moveText(spike) {
  const delta = Number(spike.delta ?? (spike.to - spike.from)) || 0;
  const pts = Math.round(delta * 100);
  const sign = pts >= 0 ? '+' : '−';
  return `${pct(spike.from)} → ${pct(spike.to)} (${sign}${Math.abs(pts)} pts in ${formatDuration(spike.windowMs)})`;
}

/** Human one-liner (no link). */
export function formatMessage(spike) {
  const icon = SEVERITY_ICON[spike.severity] || SEVERITY_ICON.info;
  const live = spike.live ? ' [LIVE]' : '';
  const demo = spike.demo ? ' [demo]' : '';
  return `${icon} ${headline(spike)} ${moveText(spike)} — something just happened${live}${demo}`;
}

export function formatText(spike) {
  return spike.url ? `${formatMessage(spike)}\n${spike.url}` : formatMessage(spike);
}

// RFC 2047 encode a header value if it is not plain ASCII (ntfy supports this).
function headerSafe(v) {
  const s = String(v ?? '');
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

export function buildRequest(webhook, spike, subscription = null) {
  const type = webhook.type || 'generic';
  const text = formatText(spike);
  const msg = formatMessage(spike);

  if (type === 'discord') {
    return {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'Oddshot',
        content: text.slice(0, 2000),
        embeds: [
          {
            author: { name: 'Oddshot' },
            title: headline(spike).slice(0, 256),
            url: spike.url || undefined,
            description: `${moveText(spike)}${spike.live ? ' · LIVE' : ''}`,
            color: SEVERITY_COLOR[spike.severity] ?? SEVERITY_COLOR.info,
            fields: [
              { name: 'Severity', value: String(spike.severity || 'info'), inline: true },
              { name: 'Source', value: String(spike.source || '?'), inline: true },
              { name: 'Category', value: String(spike.category || 'other'), inline: true },
            ],
            footer: { text: subscription ? `Oddshot · ${subscription.name}` : 'Oddshot' },
            timestamp: spike.detectedAt || new Date().toISOString(),
          },
        ],
      }),
    };
  }

  if (type === 'slack') {
    const link = spike.url ? ` <${spike.url}|Open market>` : '';
    return {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `*${msg}*${link}` } },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `${spike.severity || 'info'} · ${spike.source || '?'} · ${spike.category || 'other'}${
                  subscription ? ` · ${subscription.name}` : ''
                }`,
              },
            ],
          },
        ],
      }),
    };
  }

  if (type === 'ntfy') {
    const headers = {
      'content-type': 'text/plain; charset=utf-8',
      Title: headerSafe(`Oddshot: ${spike.live ? 'LIVE ' : ''}${headline(spike)}`.slice(0, 200)),
      Priority: NTFY_PRIORITY[spike.severity] || '3',
      Tags: [NTFY_TAG[spike.severity] || NTFY_TAG.info, spike.category].filter(Boolean).join(','),
    };
    if (spike.url) headers.Click = spike.url;
    return { headers, body: `${msg}${spike.url ? `\n${spike.url}` : ''}` };
  }

  // generic
  return {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'oddshot.spike',
      text,
      spike,
      subscription: subscription ? { id: subscription.id, name: subscription.name } : null,
    }),
  };
}

/** Deliver a spike to one webhook. Never throws. */
export async function deliver(webhook, spike, subscription = null, { timeoutMs = TIMEOUT_MS, fetchImpl = fetch } = {}) {
  if (!webhook || !webhook.url) return { ok: false, error: 'no webhook configured' };
  try {
    const { headers, body } = buildRequest(webhook, spike, subscription);
    const res = await fetchImpl(webhook.url, {
      method: 'POST',
      headers: { 'user-agent': 'Oddshot/0.1', ...headers },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 200);
      } catch {}
      return { ok: false, status: res.status, error: `HTTP ${res.status}${detail ? `: ${detail}` : ''}` };
    }
    // drain body
    try {
      await res.arrayBuffer();
    } catch {}
    return { ok: true, status: res.status };
  } catch (err) {
    const error = err?.name === 'TimeoutError' ? `timed out after ${timeoutMs}ms` : err?.message || String(err);
    return { ok: false, error };
  }
}

/** Fire-and-forget fan-out for a spike to the matched subscriptions. */
export function notifySubscriptions(spike, subs) {
  for (const sub of subs) {
    if (!sub.webhook?.url) continue;
    deliver(sub.webhook, spike, sub)
      .then((r) => {
        if (!r.ok) console.warn(`[notify] ${sub.webhook.type} webhook for "${sub.name}" failed: ${r.error}`);
      })
      .catch(() => {});
  }
}

export function sampleSpike() {
  return {
    id: 'test-' + Date.now(),
    marketId: 'demo:lakers-celtics',
    title: 'Lakers vs Celtics',
    outcome: 'Lakers win',
    source: 'polymarket',
    category: 'sports',
    tags: ['nba'],
    url: 'https://polymarket.com',
    from: 0.42,
    to: 0.61,
    delta: 0.19,
    windowMs: 240000,
    zScore: 4.2,
    severity: 'major',
    live: true,
    detectedAt: new Date().toISOString(),
    demo: true,
    test: true,
  };
}
