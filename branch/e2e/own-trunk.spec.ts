import { type ChildProcess, execFileSync, spawn } from 'child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { type BrowserContext, type Page, devices, expect, test } from '@playwright/test';

/**
 * YOUR OWN TRUNK, AS A LAY USER GETS IT — run by sim/own-trunk-e2e.sh, which builds the world in
 * docker: a fresh Debian "VPS" that ran trunk/install/trunk.sh, a fresh "home" computer that ran
 * root/install/install.sh --trunk '<the line trunk.sh printed>' (brain on the mock model), and a
 * third machine for join.sh. This file is the phone (Chromium, Pixel 7) plus the lay user's hands
 * on those machines (`docker exec` of the commands the guide tells them to type).
 *
 * The phone ONLY ever talks to the trunk's name (https://<trunk>), asserted at the end.
 *
 *   1 `install.sh pair phone` on the home computer prints the QR (+ PNG) → decoded → the phone
 *     opens it through the trunk → paired; the region the hub bound is the phone's real address;
 *     it lands on home — this phone walked the door, so the session list (never MAIN directly)
 *   2 the roots open MAIN; voice over the trunk is a state (one calm line, no error box, one
 *     /api/token ask, 503 voice-unavailable); the phone types to MAIN: "Reply with exactly:
 *     HELLO-<TRUNK>" → on its screen
 *   3 (full) the third machine runs join.sh --hub https://<trunk> → its QR → the phone approves →
 *     the root links home through wss://<trunk>/rootlink
 *   4 (full) the hub brain learns it without a restart → MAIN delegates a session to it → the report
 *     comes home → the phone sees it
 *   5 (full) the phone names the joined root itself (POST /branch through the trunk)
 *   6 `install.sh pair --revoke <id>` on the home computer → the phone's next calls are refused
 *
 * OT_SCOPE=short runs 1, 2 and 6 only (a second trunk: behind the :443 router). Every step lands in
 * $OT_STEPS (the table the script prints).
 */

const AP = process.env.OT_AP_URL || '';
const AP_IP = process.env.OT_AP_IP || '';
const STATE = process.env.OT_STATE || '';
const STEPS = process.env.OT_STEPS || join(STATE, 'steps.tsv');
const SCOPE = process.env.OT_SCOPE || 'full';
const HOME_C = process.env.OT_HOME || 'ot-home';
const MAC_C = process.env.OT_MAC || 'ot-mac';
const PHONE_IP = process.env.OT_PHONE_IP || '';
const HUB_NAME = process.env.OT_HUB_NAME || '';
const INSTALL = '/repo/root/install';

test.skip(!AP || !STATE, 'run by sim/own-trunk-e2e.sh (the docker world)');
test.use({
  launchOptions: {
    args: AP_IP ? [`--host-resolver-rules=MAP ${new URL(AP || 'https://x').hostname} ${AP_IP}`] : [],
  },
});

type J = Record<string, unknown>;
const failed: string[] = [];

function record(n: string, ok: boolean, what: string, detail = '') {
  const clean = (s: string) =>
    s
      .replace(/\u001b\[[0-9;]*m/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  appendFileSync(STEPS, `${n}\t${ok ? 'PASS' : 'FAIL'}\t${what}\t${clean(detail).slice(0, 400)}\n`);
}

async function step(n: string, what: string, fn: () => Promise<void>): Promise<boolean> {
  try {
    await test.step(`${n} ${what}`, fn);
    record(n, true, what);
    return true;
  } catch (e) {
    failed.push(n);
    record(n, false, what, String(e instanceof Error ? e.message : e));
    return false;
  }
}

/** the lay user's hands on one of the machines: a shell line as that machine's user */
const on = (container: string, cmd: string, user = 'node') =>
  execFileSync('docker', ['exec', '-u', user, container, 'bash', '-c', cmd], {
    encoding: 'utf8',
    timeout: 180_000,
  });
const home = (cmd: string) => on(HOME_C, cmd);
const mac = (cmd: string) => on(MAC_C, cmd, 'ubuntu');
/** the hub's own processes, read on the hub (never the phone) */
const hubGet = (port: number, path: string): J & J[] =>
  JSON.parse(home(`curl -s -m 30 http://127.0.0.1:${port}${path}`)) as J & J[];
const brain = (path: string) => hubGet(4100, path);
const macBrain = (path: string): J & J[] =>
  JSON.parse(mac(`curl -s -m 30 http://127.0.0.1:4180${path}`)) as J & J[];
const treeOf = (get: (p: string) => J & J[]) =>
  Object.fromEntries(
    (get('/tree') as unknown as Array<J & { title: string }>).map((x) => [x.title, x])
  ) as Record<string, J & { id: string; card?: J | null }>;
const registry = () => JSON.parse(home('cat ~/.local/state/bifrost/devices.json')) as { devices: J[] };

/** lib/region.ts, for the address the trunk saw the phone come from */
function regionOf(ip: string): string {
  const o = ip.split('.').map(Number);
  if (o[0] === 127) return 'loopback';
  if (o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168))
    return `lan:${o[0]}.${o[1]}.${o[2]}.0/24`;
  return `net:${o[0]}.${o[1]}.0.0/16`;
}

const tool = (calls: Array<[string, J]>) => `tool:${JSON.stringify([calls])}`;
async function send(page: Page, text: string) {
  const box = page.getByPlaceholder('message…');
  await box.tap();
  await box.fill(text);
  await page.getByRole('button', { name: 'send', exact: true }).tap();
}
const agentSays = (page: Page, text: string | RegExp) =>
  page.locator('[data-mi]', { hasText: '(agent' }).filter({ hasText: text });
const phoneFetch = (
  page: Page,
  path: string,
  init: { method?: string; body?: J; bearer?: string } = {}
) =>
  page.evaluate(
    async ({ path, init }) => {
      const r = await fetch(path, {
        method: init.method || 'GET',
        headers: {
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
      });
      const text = await r.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* text */
      }
      return { status: r.status, body: body as Record<string, unknown> };
    },
    { path, init }
  );

test('own trunk: a lay user pairs a phone, talks to MAIN, joins a root, delegates, revokes', async ({
  browser,
}) => {
  test.setTimeout(15 * 60_000);
  const phoneCtx: BrowserContext = await browser.newContext({
    ...devices['Pixel 7'],
    ignoreHTTPSErrors: true, // the trunk's test certificate (self-signed, or Pebble's test CA)
    storageState: {
      cookies: [],
      origins: [
        {
          origin: AP,
          localStorage: [
            { name: 'bifrost-door', value: 'v2' },
            { name: 'bifrost-first-turn', value: '1' },
          ],
        },
      ],
    },
  });
  const reached = new Set<string>();
  const offAp: string[] = [];
  const see = (u: string) => {
    if (!/^(https?|wss?):/.test(u)) return;
    reached.add(new URL(u).origin);
    if (!(u.startsWith(`${AP}/`) || u.startsWith(`${AP.replace(/^https/, 'wss')}/`))) offAp.push(u);
  };
  phoneCtx.on('request', (r) => see(r.url()));
  phoneCtx.on('page', (p) => p.on('websocket', (ws) => see(ws.url())));
  const phone = await phoneCtx.newPage();

  let mainId = '';
  let deviceId = '';
  let rootId = '';
  let accessToken = '';
  let joinCode = '';
  let joiner: ChildProcess | null = null;
  const full = SCOPE === 'full';
  const qrPng = join(STATE, `pair-qr-${new URL(AP).hostname}.png`);

  try {
    // ---------------------------------------------------------------- 1 pair
    await step('1', '`install.sh pair phone` on the hub → QR → the phone pairs through the trunk', async () => {
      const out = home(`${INSTALL}/install.sh pair phone --png /sim/${qrPng.split('/').pop()}`);
      expect(out).toContain(`opens ${AP}/pair`);
      const qrUrl = execFileSync('zbarimg', ['--raw', '-q', qrPng]).toString().trim();
      expect(qrUrl.startsWith(`${AP}/pair#`), qrUrl).toBe(true);
      const frag = new URLSearchParams(qrUrl.split('#')[1]);
      expect(frag.get('code')).toMatch(/^bfnp-/);
      await phone.goto(qrUrl);
      // home decides (11-14): the door walked on this phone → the list, never straight into MAIN
      await phone.waitForURL(`${AP}/`, { timeout: 30_000 });
      await expect(phone.getByRole('heading', { name: 'BIFROST' })).toBeVisible();
      await expect(phone.getByTestId('roots')).toBeVisible();
      await expect(phone.getByTestId('tree-first')).toHaveCount(0);
      mainId = String((await phoneFetch(phone, '/api/session/main')).body.id || '');
      const cookie = (await phoneCtx.cookies(AP)).find((c) => c.name === 'bifrost_device');
      expect(cookie?.value).toMatch(/^bfnd-/);
      expect(cookie?.httpOnly && cookie?.secure).toBe(true);
      const pin = await phone.evaluate(() => JSON.parse(localStorage.getItem('bifrost.pin') || 'null'));
      expect(pin?.fp).toBe(frag.get('fp'));
      deviceId = pin?.deviceId;
      expect(deviceId).toMatch(/^dev_/);
      expect((await phoneFetch(phone, '/api/ping')).status).toBe(200);
      // the hub bound the token to the phone's REAL address as the trunk saw it (behind the :443
      // router: carried by the PROXY v1 line) — never the VPS's loopback, never the bridge's
      const me = registry().devices.find((d) => d.id === deviceId);
      expect(me?.region, JSON.stringify(me)).toBe(regionOf(PHONE_IP));
    });

    // ---------------------------------------------------------------- 2 MAIN answers
    // a word of its own per trunk: a second walk (another trunk, the same MAIN) must not pass on the first one's
    const hello = `HELLO-${new URL(AP).hostname.split('.')[0].toUpperCase()}`;
    await step('2', `roots → MAIN; voice is one calm line; "Reply with exactly: ${hello}" on its screen`, async () => {
      expect(mainId, 'needs step 1').toMatch(/^ses_/);
      const tokens: Array<{ status: number; body: string }> = [];
      phone.on('response', (r) => {
        if (!r.url().endsWith('/api/token')) return;
        const at = tokens.push({ status: r.status(), body: '' }) - 1;
        void r.text().then((t) => (tokens[at].body = t)).catch(() => {});
      });
      await phone.getByTestId('roots-hit').tap(); // a tap on the roots opens MAIN
      await phone.waitForURL(/\/session\/main/, { timeout: 20_000 });
      const mic = phone.getByTestId('composer-mic');
      await expect(mic).toHaveAttribute('data-voice', 'unavailable', { timeout: 20_000 });
      await mic.tap();
      await mic.tap();
      await expect(phone.getByTestId('voice-unavailable')).toHaveText(/Voice isn't available over the trunk yet — type instead/);
      await expect(phone.locator('main [role="alert"]')).toHaveCount(0); // no error box (Next's route announcer is outside <main>)
      await expect(phone.getByRole('button', { name: 'fix this' })).toHaveCount(0);
      await expect(phone.getByTestId('free-strip')).toHaveCount(0);
      expect(tokens.map((t) => t.status)).toEqual([503]); // asked once, never again
      await expect.poll(() => tokens[0].body).toContain('"error":"voice-unavailable"');
      await send(phone, `Reply with exactly: ${hello}`);
      await expect(agentSays(phone, hello).first()).toBeVisible({ timeout: 60_000 });
      expect(JSON.stringify(brain(`/session/${mainId}/message`))).toContain(hello);
    });

    if (full) {
      // -------------------------------------------------------------- 3 join
      await step('3a', 'a third machine: join.sh --hub https://<trunk> → its approve QR', async () => {
        mac('rm -f /sim/join-qr.png /sim/join.log');
        joiner = spawn(
          'docker',
          [
            'exec', '-u', 'ubuntu', MAC_C, 'bash', '-c',
            `cd ${INSTALL} && ./join.sh --hub ${AP} --cacert /sim/trunk-ca.pem --name mac ` +
              '--upstream-env /home/ubuntu/model.env --brain-bin /opt/bin/yggdrasil ' +
              '--supervisor nohup --qr-png /sim/join-qr.png >/sim/join.log 2>&1; echo "exit $?" >>/sim/join.log',
          ],
          { stdio: 'ignore' }
        );
        await expect.poll(() => existsSync(join(STATE, 'join-qr.png')), { timeout: 60_000 }).toBe(true);
        const codeOf = () =>
          readFileSync(join(STATE, 'join.log'), 'utf8').match(/matches the phone\):\s+([A-Z0-9]{4}-[A-Z0-9]{4})/)?.[1] || '';
        await expect.poll(codeOf, { timeout: 20_000 }).not.toBe('');
        joinCode = codeOf();
        const scanned = execFileSync('zbarimg', ['--raw', '-q', join(STATE, 'join-qr.png')]).toString().trim();
        expect(scanned.startsWith(`${AP}/join?r=`), scanned).toBe(true);
        writeFileSync(join(STATE, 'join-url.txt'), scanned);
      });

      await step('3b', 'the phone scans it, sees the same code, taps "Add to my tree"', async () => {
        const url = readFileSync(join(STATE, 'join-url.txt'), 'utf8');
        await phone.goto(url);
        await expect(phone.getByTestId('join-code')).toHaveText(joinCode);
        await expect(phone.getByTestId('join-name')).toHaveText('mac');
        await phone.getByTestId('join-approve').tap();
        await expect(phone.getByTestId('join-status')).toContainText('mac', { timeout: 20_000 });
      });

      await step('3c', 'join.sh finishes (exit 0): root mac, 20 link tokens, home is the hub brain', async () => {
        await expect.poll(() => readFileSync(join(STATE, 'join.log'), 'utf8'), { timeout: 90_000 }).toMatch(/exit \d+/);
        expect(readFileSync(join(STATE, 'join.log'), 'utf8')).toContain('exit 0');
        const root = JSON.parse(mac('cat ~/.local/share/yggdrasil-root/root.json'));
        rootId = root.root_id;
        expect(rootId).toBe('mac');
        expect(root.rootlink_url).toBe(`${AP.replace(/^https/, 'wss')}/rootlink`);
        expect(root.hub_name).toBe(HUB_NAME);
        const toks = mac('wc -l < ~/.local/share/yggdrasil-root/link-tokens').trim();
        expect(Number(toks)).toBeGreaterThanOrEqual(15);
        expect(registry().devices.find((d) => d.id === deviceId)?.roots).toEqual([rootId]);
      });

      await step('3d', 'its root-dial links through wss://<trunk>/rootlink; the hub reaches its brain', async () => {
        await expect
          .poll(() => home('cat ~/.local/state/bifrost/log/bifrost-bridge.service.log'), { timeout: 30_000 })
          .toContain(`root-link: root '${rootId}' LINKED`);
        const r = hubGet(7890, `/_root/${rootId}/root`);
        expect(r.name).toBe(rootId);
        expect(r.peers).toEqual([HUB_NAME]);
      });

      // -------------------------------------------------------------- 4 MAIN delegates
      await step('4a', 'the hub brain learns root mac by itself (YGG_PEERS_FROM; no restart)', async () => {
        const pid = home('cat ~/.local/state/bifrost/run/yggdrasil.service.pid').trim();
        await expect.poll(() => (brain('/root').peers as string[]) || [], { timeout: 30_000 }).toEqual([rootId]);
        expect(home('cat ~/.local/state/bifrost/log/yggdrasil.service.log')).toContain(`peers: learned root ${rootId}`);
        expect(home('cat ~/.local/state/bifrost/run/yggdrasil.service.pid').trim()).toBe(pid);
        home(`kill -0 ${pid}`);
      });

      let proxyId = '';
      await step('4b', 'phone → MAIN: session_start on root mac; it runs on the mac brain', async () => {
        await phone.goto(`${AP}/session/main?id=${mainId}`);
        await send(
          phone,
          tool([['session_start', { title: 'on mac', agent: 'build', brief: 'Reply with exactly: MAC-DONE', root: rootId }]])
        );
        await expect(agentSays(phone, `on root ${rootId}`).first()).toBeVisible({ timeout: 60_000 });
        const t = treeOf(brain);
        expect(t['on mac']?.card?.root, JSON.stringify(t['on mac'])).toBe(rootId);
        proxyId = t['on mac'].id;
        expect(Object.keys(treeOf(macBrain))).toContain('on mac');
      });

      await step('4c', 'its report comes home: the tree shows it done (MAC-DONE), the phone sees MAIN speak', async () => {
        expect(proxyId, 'needs 4b').toBeTruthy();
        await expect.poll(() => treeOf(brain)['on mac']?.card?.status, { timeout: 90_000 }).toBe('done');
        expect(String(treeOf(brain)['on mac'].card?.headline)).toContain('MAC-DONE');
        const inbox = brain(`/session/${mainId}/inbox`) as unknown as J[];
        expect(inbox.some((e) => e.from === proxyId), JSON.stringify(inbox)).toBe(true);
        await expect(agentSays(phone, 'MAC-DONE').last()).toBeVisible({ timeout: 60_000 });
      });

      // -------------------------------------------------------------- 5 the phone names the root
      await step('5', 'the phone names root mac itself: POST /branch through the trunk → mac answers', async () => {
        const fresh = await phoneFetch(phone, '/api/pair/refresh', { method: 'POST' });
        expect(fresh.status).toBe(200);
        accessToken = String(fresh.body.accessToken);
        const r = await phoneFetch(phone, '/branch', {
          method: 'POST',
          body: { op: 'prompt', id: 'phone', root: rootId, text: 'Reply with exactly: PHONE-ON-MAC' },
          bearer: accessToken,
        });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body).toMatchObject({ ok: true, root: rootId, text: 'PHONE-ON-MAC' });
      });
    }

    // ---------------------------------------------------------------- 6 revoke
    await step('6', '`install.sh pair --revoke <id>` on the hub → the phone is refused through the trunk', async () => {
      expect(deviceId, 'needs step 1').toBeTruthy();
      const listed = home(`${INSTALL}/install.sh pair --list`);
      expect(listed).toContain(deviceId);
      expect(home(`${INSTALL}/install.sh pair --revoke ${deviceId}`)).toContain(`revoked ${deviceId}`);
      await phone.goto(`${AP}/session/main?id=${mainId}`);
      await phone.waitForURL(/\/pair\?unpaired=1/, { timeout: 30_000 });
      const ping = await phoneFetch(phone, '/api/ping');
      expect(ping.status).toBe(401);
      expect(ping.body.why).toBe('revoked');
      expect((await phoneFetch(phone, '/api/session')).status).toBe(401);
      expect((await phoneFetch(phone, '/api/pair/refresh', { method: 'POST' })).status).toBe(401);
      if (full && accessToken) {
        const r = await phoneFetch(phone, '/branch', {
          method: 'POST',
          body: { op: 'prompt', id: 'phone', root: rootId, text: 'Reply with exactly: TOO-LATE' },
          bearer: accessToken,
        });
        expect(r.status).toBe(401);
      }
      expect(home(`${INSTALL}/install.sh pair --list`)).toMatch(new RegExp(`${deviceId}.*revoked`));
    });
  } finally {
    await step('∀', `the phone only ever talked to ${AP}`, async () => {
      expect(reached.size).toBeGreaterThan(0);
      expect(offAp, [...reached].join(' ')).toEqual([]);
    });
    if (joiner) (joiner as ChildProcess).kill('SIGTERM');
    await phoneCtx.close();
  }
  expect(failed, `failed steps: ${failed.join(' ')}`).toEqual([]);
});
