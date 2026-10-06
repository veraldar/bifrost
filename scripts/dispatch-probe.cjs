const { AgentDispatchClient } = require('livekit-server-sdk');
const fs = require('node:fs');
const env = Object.fromEntries(
  fs.readFileSync('/home/dweeb_xyz/Work/lane2-merge/pwa/.env.local', 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
);
(async () => {
  const c = new AgentDispatchClient(env.LIVEKIT_API_URL || 'http://127.0.0.1:7880', env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
  const d = await c.createDispatch('main', env.AGENT_DISPATCH_NAME || 'bifrost-ygg');
  console.log('dispatch created:', JSON.stringify(d).slice(0, 120));
  setTimeout(() => process.exit(0), 3000);
})().catch((e) => { console.error('DISPATCH FAIL:', String(e).slice(0, 200)); process.exit(1); });
