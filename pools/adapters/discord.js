// Discord adapter over the REST API only (no gateway, no dependencies).
// The bot posts each pool with number reactions; when voting locks it reads who reacted.
// Needs DISCORD_BOT_TOKEN and a channel id (bot needs Send Messages, Add Reactions, Read Message History).

const API = 'https://discord.com/api/v10';
const EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];

export function connectDiscord(engine, channelId, { token = process.env.DISCORD_BOT_TOKEN, log = console.log } = {}) {
  if (!token) throw new Error('DISCORD_BOT_TOKEN is not set');
  const headers = { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' };
  const call = async (method, path, body) => {
    const r = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 429) { const j = await r.json(); await new Promise((s) => setTimeout(s, (j.retry_after || 1) * 1000)); return call(method, path, body); }
    if (!r.ok) throw new Error(`discord ${method} ${path}: ${r.status} ${await r.text()}`);
    return r.status === 204 ? null : r.json();
  };
  const messages = new Map(); // poolId -> messageId

  engine.on('open', async (p) => {
    try {
      const msg = await call('POST', `/channels/${channelId}/messages`, { embeds: [{
        title: `🔮 ${p.question}`, description: `${p.why ? `${p.why}\n\n` : ''}${p.options.map((o, i) => `${EMOJI[i]}  ${o}`).join('\n')}`,
        footer: { text: `${p.gameName} · react to vote · locks in ${Math.round((p.locksAt - p.opened) / 1000)}s` }, color: 0xff6a3d }] });
      messages.set(p.id, msg.id);
      for (let i = 0; i < p.options.length; i++) await call('PUT', `/channels/${channelId}/messages/${msg.id}/reactions/${encodeURIComponent(EMOJI[i])}/@me`);
    } catch (e) { log(`discord: ${e.message}`); }
  });

  // Just before the window closes, pull reactions in as votes.
  const collect = async (p) => {
    const mid = messages.get(p.id);
    if (!mid) return;
    for (let i = 0; i < p.options.length; i++) {
      try {
        const users = await call('GET', `/channels/${channelId}/messages/${mid}/reactions/${encodeURIComponent(EMOJI[i])}?limit=100`);
        for (const u of users) if (!u.bot) engine.vote(`discord:${u.id}`, i + 1, { poolId: p.id, name: u.global_name || u.username, source: 'discord' });
      } catch (e) { log(`discord: ${e.message}`); }
    }
  };
  const timer = setInterval(() => {
    for (const p of engine.openPools()) if (p.locksAt - engine.now() < 3000 && !p._discordCollected) { p._discordCollected = true; collect(p); }
  }, 1000);

  engine.on('settle', async (p) => {
    const mid = messages.get(p.id);
    const text = `✅ **${p.outcomeLabel}**: ${p.winners.length} of ${p.total} called it (+${p.award} each)` +
      (p.winners.length ? `\n🏆 ${p.winners.slice(0, 5).map((w) => w.name).join(', ')}` : '');
    try { await call('POST', `/channels/${channelId}/messages`, { content: text, message_reference: mid ? { message_id: mid } : undefined }); }
    catch (e) { log(`discord: ${e.message}`); }
  });
  log(`discord: posting to channel ${channelId}`);
  return { close() { clearInterval(timer); } };
}
