// flip-automation (req 10-03): the flip script's voice to the phone.
// Mirrors lib/push.ts pushRunDone exactly — same VAPID keys, same
// .push-subs.json registry, same dead-sub pruning — but callable from a
// shell: node pwa/scripts/flip-notify.mjs <pwaDir> "body".
// The phone shows it even when Chrome froze the tab (that is the point:
// the proxy is DOWN or swapping while this fires).
import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import webpush from 'web-push';

const pwaDir = process.argv[2];
const body = process.argv[3];
if (!pwaDir || !body) {
  console.error('usage: node flip-notify.mjs <pwaDir> "body"');
  process.exit(2);
}

async function envKey(name) {
  try {
    const line = (await readFile(path.join(pwaDir, '.env.local'), 'utf8'))
      .split('\n')
      .find((l) => l.startsWith(`${name}=`));
    return line ? line.slice(name.length + 1).trim() : '';
  } catch {
    return '';
  }
}

const PUB = await envKey('VAPID_PUBLIC_KEY');
const PRIV = await envKey('VAPID_PRIVATE_KEY');
if (!PUB || !PRIV) {
  console.error('[flip-notify] VAPID keys missing — push disabled');
  process.exit(0); // not a flip failure; notifications are best-effort
}
webpush.setVapidDetails('mailto:dweeb@dweeb.xyz', PUB, PRIV);

const SUBS_FILE = path.join(pwaDir, '.push-subs.json');
let subs = [];
try {
  subs = JSON.parse(await readFile(SUBS_FILE, 'utf8'));
} catch {
  console.error('[flip-notify] no subscriptions — nothing to wake');
  process.exit(0);
}

const payload = JSON.stringify({ slug: '', body, tag: 'oz-flip' });
const alive = [];
await Promise.all(
  subs.map(async (s) => {
    try {
      await webpush.sendNotification(s, payload, { TTL: 3600 });
      alive.push(s);
    } catch (e) {
      // 404/410 = subscription expired — prune, same as pushRunDone
      if (e?.statusCode !== 404 && e?.statusCode !== 410) alive.push(s);
    }
  })
);
if (alive.length !== subs.length) {
  await writeFile(SUBS_FILE, JSON.stringify(alive, null, 1));
}
console.log(`[flip-notify] pushed to ${alive.length}/${subs.length} device(s): ${body}`);
