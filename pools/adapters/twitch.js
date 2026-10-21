// Twitch chat adapter. Reads votes from chat anonymously (no token needed): viewers type !1, !2, !3.
// With TWITCH_OAUTH (oauth:...) and TWITCH_BOT_USER set it also announces pools and results in chat.

export function connectTwitch(engine, channel, { oauth = process.env.TWITCH_OAUTH, botUser = process.env.TWITCH_BOT_USER, log = console.log } = {}) {
  channel = channel.replace(/^#/, '').toLowerCase();
  let ws, closed = false;
  const canTalk = Boolean(oauth && botUser);
  const say = (msg) => { if (canTalk && ws?.readyState === 1) ws.send(`PRIVMSG #${channel} :${msg}`); };

  function open() {
    ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
    ws.onopen = () => {
      ws.send('CAP REQ :twitch.tv/tags');
      if (canTalk) { ws.send(`PASS ${oauth}`); ws.send(`NICK ${botUser.toLowerCase()}`); }
      else ws.send(`NICK justinfan${Math.floor(Math.random() * 1e6)}`);
      ws.send(`JOIN #${channel}`);
      log(`twitch: joined #${channel}${canTalk ? ' (can post)' : ' (read-only)'}`);
    };
    ws.onmessage = ({ data }) => {
      for (const line of String(data).split('\r\n')) {
        if (!line) continue;
        if (line.startsWith('PING')) { ws.send(line.replace('PING', 'PONG')); continue; }
        const m = /^(?:@(\S+) )?:(\w+)!\S+ PRIVMSG #\S+ :(.*)$/.exec(line);
        if (!m) continue;
        const [, tags = '', user, text] = m;
        const vote = /^!(\d)\b/.exec(text.trim());
        if (!vote) continue;
        const display = /display-name=([^;]*)/.exec(tags)?.[1] || user;
        engine.vote(`twitch:${user}`, Number(vote[1]), { name: display, source: 'twitch' });
      }
    };
    ws.onclose = () => { if (!closed) setTimeout(open, 3000); };
    ws.onerror = () => {};
  }
  open();

  engine.on('open', (p) => say(`🔮 ${p.question} ${p.options.map((o, i) => `!${i + 1} ${o}`).join(' · ')} (${Math.round((p.locksAt - p.opened) / 1000)}s to vote)`));
  engine.on('lock', (p) => say(`🔒 Votes locked: ${p.total} in. Waiting to see what happens…`));
  engine.on('settle', (p) => say(`✅ ${p.outcomeLabel}! ${p.winners.length} got it right (+${p.award}). ${p.winners.slice(0, 3).map((w) => w.name).join(', ')}`));
  return { close() { closed = true; ws?.close(); } };
}
