import { type ChildProcess, execFileSync, spawn } from 'child_process';
import { appendFileSync, existsSync, openSync, readFileSync, writeFileSync } from 'fs';
import http from 'node:http';
import { join, resolve } from 'path';
import { type BrowserContext, type Page, devices, expect, test } from '@playwright/test';

/**
 * THE WHOLE TREE, END TO END, WITH A SIMULATED PHONE — run by sim/trunk-full-e2e.sh, which
 * builds the world in private namespaces: an access point on the "internet" (ap.tree.test,
 * TLS, a self-signed test cert), the hub box (brain "home" on the mock model, the bridge
 * dialing OUT to the ap with root-link + switchboard, the app in devices mode behind it), and
 * room for a new machine. Deterministic: root/mock/mock_upstream.py answers scripted prompts.
 *
 * The phone (Chromium, Pixel 7) ONLY ever talks to https://ap.tree.test — asserted at the end
 * from every request and websocket it made.
 *
 *   1 the box console shows the pairing QR → decoded (zbarimg) → the phone opens it through
 *     the ap → paired (device cookie, pinned box key)
 *   2 the phone talks to MAIN: "Reply with exactly: HELLO-PHONE" → the reply on its screen
 *   3 join: the new machine (sim/trunk-full-joiner.py, its own address) POSTs /api/roots/join
 *     through the ap and shows the approve QR (qrencode) → the phone scans it (zbarimg), sees
 *     the same code, taps "Add to my tree" → the machine's poll gets 20 link tokens, its root
 *     id and the hub brain's name ("home") → its brain (peer "home") + root-dial.py dial
 *     wss://ap.tree.test/rootlink → the hub's bridge shows the root LINKED and reaches its brain
 *     over the switchboard
 *   4 the hub brain learns the joined root by itself (YGG_PEERS_FROM → the bridge's /_roots; no
 *     restart, nothing written by hand) → MAIN delegates over the trunk: the phone's message
 *     makes MAIN run session_start with
 *     root = the joined root → the session runs on that root's brain → its report comes home
 *     → the phone sees MAIN come back and the tree row on that root done with MAC-DONE
 *   5 the phone names the joined root itself: POST /branch {root} through the ap (its own
 *     device token, its own region) → answered by the joined root's brain
 *   6 the box console revokes the phone → its next calls through the ap are refused
 *
 * Every step lands in $PW_STATE/steps.tsv (the PASS/FAIL table the script prints).
 */

const AP = process.env.PW_AP_URL || '';
const AP_IP = process.env.PW_AP_IP || '';
const BASE = process.env.PW_BASE_URL || '';
const STATE = process.env.PW_STATE || '';
const BRIDGE = process.env.PW_BRIDGE || '';
const HOME = process.env.PW_HOME || '';
const MOCK = process.env.PW_MOCK || '';
const CAFILE = process.env.PW_CAFILE || '';
const FAR = process.env.PW_FAR || '';
const YGG_BIN = process.env.PW_YGG_BIN || '';
const MAC_PORT = process.env.PW_MAC_PORT || '';
const PEER_PORT = process.env.PW_PEER_PORT || '';
const MAC = `http://127.0.0.1:${MAC_PORT}`;
const MACST = join(STATE, 'mac');
const JOINER = resolve(__dirname, '../../sim/trunk-full-joiner.py');

test.skip(!AP || !STATE || !BASE, 'run by sim/trunk-full-e2e.sh (the namespaced world)');
test.use({
  launchOptions: {
    // /etc/hosts names the ap inside the run; this is the belt to that brace
    args: AP_IP
      ? [`--host-resolver-rules=MAP ${new URL(AP || 'https://x').hostname} ${AP_IP}`]
      : [],
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
  appendFileSync(
    join(STATE, 'steps.tsv'),
    `${n}\t${ok ? 'PASS' : 'FAIL'}\t${what}\t${clean(detail).slice(0, 400)}\n`
  );
}

/** one row of the table: runs, records PASS/FAIL, never stops the walk */
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

/** the harness reads the box's own processes (never the phone) — plain node:http: the
 *  switchboard refuses anything browser-shaped (fetch() sends sec-fetch-mode) */
function brain(base: string, path: string): Promise<{ status: number; body: J & J[] }> {
  return new Promise((done, fail) => {
    const req = http.request(`${base}${path}`, { method: 'GET', timeout: 30_000 }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let body: unknown = text;
        try {
          body = JSON.parse(text);
        } catch {
          /* text */
        }
        done({ status: res.statusCode || 0, body: body as J & J[] });
      });
    });
    req.on('error', fail);
    req.on('timeout', () => req.destroy(new Error(`timeout: ${base}${path}`)));
    req.end();
  });
}
const treeOf = async (base: string) =>
  Object.fromEntries(
    ((await brain(base, '/tree')).body as unknown as Array<J & { title: string }>).map((x) => [
      x.title,
      x,
    ])
  ) as Record<string, J & { id: string; card?: J | null }>;

const waitFile = (p: string, timeout = 60_000) =>
  expect.poll(() => existsSync(p) || existsSync(join(MACST, 'error')), { timeout }).toBe(true);
const joinerError = () =>
  existsSync(join(MACST, 'error')) ? readFileSync(join(MACST, 'error'), 'utf8') : '';

/** the mock's scripted tool call: one step of [[name, args], …] (sim/tree-e2e.py's tool()) */
const tool = (calls: Array<[string, J]>) => `tool:${JSON.stringify([calls])}`;

/** type into the composer and tap send — the way a thumb does it (root-coord-ui.spec.ts) */
async function send(page: Page, text: string) {
  const box = page.getByPlaceholder('message…');
  await box.tap();
  await box.fill(text);
  await page.getByRole('button', { name: 'send', exact: true }).tap();
}
/** an agent message holding `text` shows on the phone's screen (polls, never a reload) */
const agentSays = (page: Page, text: string | RegExp) =>
  page.locator('[data-mi]', { hasText: '(agent' }).filter({ hasText: text });

/** the phone's own fetch, from its page (its cookies, its network path: the ap) */
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

test('trunk full: phone ↔ ap ↔ hub ↔ joined root — pair, talk, join, delegate, name a root, revoke', async ({
  browser,
}) => {
  test.setTimeout(15 * 60_000);
  writeFileSync(join(STATE, 'steps.tsv'), '');
  const desk = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const box = await desk.newPage();
  // a returning phone (the door walked, its first voice turn done) — the suite's own default
  const phoneCtx: BrowserContext = await browser.newContext({
    ...devices['Pixel 7'],
    ignoreHTTPSErrors: true,
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
  // every address the phone ever reached
  const reached = new Set<string>();
  const offAp: string[] = [];
  const see = (u: string) => {
    if (!/^(https?|wss?):/.test(u)) return;
    reached.add(new URL(u).origin);
    if (!(u.startsWith(`${AP}/`) || u.startsWith(`${AP.replace(/^https/, 'wss')}/`))) offAp.push(u);
  };
  phoneCtx.on('request', (r) => see(r.url()));
  const watch = (p: Page) => p.on('websocket', (ws) => see(ws.url()));
  phoneCtx.on('page', watch);
  const phone = await phoneCtx.newPage();

  let mainId = '';
  let deviceId = '';
  let rootId = '';
  let joiner: ChildProcess | null = null;
  let accessToken = '';

  try {
    // ---------------------------------------------------------------- 1 pair
    await step(
      '1',
      'box console QR → phone pairs through the ap (device cookie, box key pinned)',
      async () => {
        await box.goto(`${BASE}/pair`);
        const qr = box.getByTestId('pair-qr');
        await expect(qr.locator('svg')).toBeVisible();
        const png = join(STATE, 'pair-qr.png');
        writeFileSync(png, await qr.screenshot());
        const qrUrl = execFileSync('zbarimg', ['--raw', '-q', png]).toString().trim();
        expect(qrUrl.startsWith(`${AP}/pair#`), qrUrl).toBe(true);
        const frag = new URLSearchParams(qrUrl.split('#')[1]);
        expect(frag.get('code')).toMatch(/^bfnp-/);
        await phone.goto(qrUrl);
        await phone.waitForURL(/\/session\/main\?id=ses_/, { timeout: 30_000 });
        expect(phone.url().startsWith(`${AP}/`)).toBe(true);
        mainId = new URL(phone.url()).searchParams.get('id') || '';
        const cookie = (await phoneCtx.cookies(AP)).find((c) => c.name === 'bifrost_device');
        expect(cookie?.value).toMatch(/^bfnd-/);
        expect(cookie?.httpOnly && cookie?.secure).toBe(true);
        const pin = await phone.evaluate(() =>
          JSON.parse(localStorage.getItem('bifrost.pin') || 'null')
        );
        expect(pin?.fp).toBe(frag.get('fp'));
        deviceId = pin?.deviceId;
        expect(deviceId).toMatch(/^dev_/);
        expect((await phoneFetch(phone, '/api/ping')).status).toBe(200);
        // the region the box bound the token to is the phone's real address (as the ap saw it)
        const reg = JSON.parse(readFileSync(join(STATE, 'devices.json'), 'utf8'));
        const me = reg.devices.find((d: J) => d.id === deviceId);
        expect(me?.region, JSON.stringify(me)).toMatch(/^net:198\.51\./);
      }
    );

    // ---------------------------------------------------------------- 2 MAIN answers
    await step(
      '2',
      'phone → MAIN (through the ap): "Reply with exactly: HELLO-PHONE" shows on screen',
      async () => {
        expect(mainId, 'needs step 1').toMatch(/^ses_/);
        await send(phone, 'Reply with exactly: HELLO-PHONE');
        await expect(agentSays(phone, 'HELLO-PHONE').first()).toBeVisible({ timeout: 60_000 });
        const msgs = (await brain(HOME, `/session/${mainId}/message`)).body as unknown as J[];
        expect(JSON.stringify(msgs)).toContain('HELLO-PHONE');
      }
    );

    // ---------------------------------------------------------------- 3 join
    let J1: J = {};
    await step(
      '3a',
      'new machine POSTs /api/roots/join through the ap; its approve QR decodes',
      async () => {
        const out = openSync(join(STATE, 'joiner.log'), 'a');
        joiner = spawn(
          'python3',
          [
            JOINER,
            '--state',
            MACST,
            '--hub',
            AP,
            '--cafile',
            CAFILE,
            '--from',
            FAR,
            '--name',
            'mac',
            '--os',
            'macos',
            '--host',
            'mac-studio.local',
            '--brain-bin',
            YGG_BIN,
            '--mock-url',
            MOCK,
            '--brain-port',
            MAC_PORT,
            '--peer-port',
            PEER_PORT,
          ],
          { stdio: ['ignore', out, out] }
        );
        await waitFile(join(MACST, 'join.json'), 30_000);
        expect(joinerError()).toBe('');
        J1 = JSON.parse(readFileSync(join(MACST, 'join.json'), 'utf8'));
        const scanned = execFileSync('zbarimg', ['--raw', '-q', join(MACST, 'approve-qr.png')])
          .toString()
          .trim();
        expect(scanned).toBe(J1.approve_url);
        expect(scanned.startsWith(`${AP}/join?r=`), scanned).toBe(true);
      }
    );

    await step('3b', 'phone scans it, sees the same code, taps "Add to my tree"', async () => {
      expect(J1.approve_url, 'needs 3a').toBeTruthy();
      await phone.goto(String(J1.approve_url));
      await expect(phone.getByTestId('join-code')).toHaveText(String(J1.code));
      await expect(phone.getByTestId('join-name')).toHaveText('mac');
      const add = phone.getByTestId('join-approve');
      await expect(add).toHaveText(/Add to my tree/);
      await add.tap();
      await expect(phone.getByTestId('join-status')).toContainText('mac', { timeout: 20_000 });
    });

    await step(
      '3c',
      'the machine polls: root id + 20 link tokens (once); the phone may reach it',
      async () => {
        await waitFile(join(MACST, 'root.json'), 30_000);
        expect(joinerError()).toBe('');
        const root = JSON.parse(readFileSync(join(MACST, 'root.json'), 'utf8'));
        rootId = root.root_id;
        expect(rootId).toBe('mac');
        expect(root.tokens).toBe(20);
        expect(root.rootlink_url).toBe(`${AP.replace(/^https/, 'wss')}/rootlink`);
        expect(root.peer_token).toBe(process.env.PW_PEER_TOKEN);
        // the hub brain's own root name (asked of the brain by the app): its way home
        expect(root.hub).toBe('home');
        await expect(phone.getByTestId('join-status')).toContainText(rootId);
        const reg = JSON.parse(readFileSync(join(STATE, 'devices.json'), 'utf8'));
        expect(reg.devices.find((d: J) => d.id === deviceId)?.roots).toEqual([rootId]);
        const listed = await phoneFetch(phone, '/api/roots');
        expect(listed.status).toBe(200);
        expect((listed.body.roots as J[]).map((r) => r.id)).toContain(rootId);
      }
    );

    await step(
      '3d',
      'its root-dial links through wss://ap/rootlink; the hub bridge shows it LINKED',
      async () => {
        expect(rootId, 'needs 3c').toBeTruthy();
        await waitFile(join(MACST, 'linked'), 30_000);
        expect(joinerError()).toBe('');
        const blog = readFileSync(join(STATE, 'bridge.log'), 'utf8');
        expect(blog).toContain(`root-link: root '${rootId}' LINKED`);
        // the hub reaches the joined root's brain over the switchboard
        const r = await brain(BRIDGE, `/_root/${rootId}/root`);
        expect(r.status).toBe(200);
        expect(r.body.name).toBe(rootId);
        // …whose one peer is the hub brain, by the name the join answered
        expect(r.body.peers).toEqual(['home']);
      }
    );

    // ---------------------------------------------------------------- 4 MAIN delegates
    await step(
      '4a',
      'the hub brain learns the joined root by itself (YGG_PEERS_FROM → /_roots; no restart)',
      async () => {
        expect(rootId, 'needs 3c').toBeTruthy();
        const pid = readFileSync(join(STATE, 'home.pid'), 'utf8').trim();
        // the bridge lists it (loopback only) …
        const listed = await brain(BRIDGE, '/_roots');
        expect(listed.status).toBe(200);
        expect((listed.body as unknown as J[]).map((r) => r.id)).toEqual([rootId]);
        // … and the brain, which was never told, adds it as a peer and reads its /root
        await expect
          .poll(async () => ((await brain(HOME, '/root')).body.peers as string[]) || [], {
            timeout: 20_000,
          })
          .toEqual([rootId]);
        expect(readFileSync(join(STATE, 'home.log'), 'utf8')).toContain(
          `peers: learned root ${rootId} = ${BRIDGE}/_root/${rootId}`
        );
        // the same brain process all along: nothing restarted it
        expect(readFileSync(join(STATE, 'home.pid'), 'utf8').trim()).toBe(pid);
        expect(() => process.kill(Number(pid), 0)).not.toThrow();
      }
    );

    let proxyId = '';
    await step(
      '4b',
      `phone → MAIN: session_start on root mac; it runs on the mac brain`,
      async () => {
        expect(rootId, 'needs 3c').toBeTruthy();
        await phone.goto(`${AP}/session/main?id=${mainId}`);
        await send(
          phone,
          tool([
            [
              'session_start',
              {
                title: 'on mac',
                agent: 'build',
                brief: 'Reply with exactly: MAC-DONE',
                root: rootId,
              },
            ],
          ])
        );
        // MAIN's own turn ends with the tool's answer (the mock's TOOL-FINAL echoes it)
        await expect(agentSays(phone, `on root ${rootId}`).first()).toBeVisible({
          timeout: 60_000,
        });
        const t = await treeOf(HOME);
        expect(t['on mac']?.card?.root, JSON.stringify(t['on mac'])).toBe(rootId);
        proxyId = t['on mac'].id;
        expect(Object.keys(await treeOf(MAC))).toContain('on mac');
      }
    );

    await step(
      '4c',
      'its report comes home: MAIN speaks again, the tree shows it done (MAC-DONE)',
      async () => {
        expect(proxyId, 'needs 4b').toBeTruthy();
        await expect
          .poll(async () => (await treeOf(HOME))['on mac']?.card?.status, { timeout: 60_000 })
          .toBe('done');
        expect(String((await treeOf(HOME))['on mac'].card?.headline)).toContain('MAC-DONE');
        const inbox = (await brain(HOME, `/session/${mainId}/inbox`)).body as unknown as J[];
        expect(
          inbox.some((e) => e.from === proxyId),
          JSON.stringify(inbox)
        ).toBe(true);
        // the phone: MAIN came back on its own (the report woke it) — on screen, no reload
        await expect(agentSays(phone, 'MAC-DONE').last()).toBeVisible({ timeout: 60_000 });
        // …and the tree on the phone: the session on root mac, done, with the mac brain's result
        await phone.goto(`${AP}/`);
        const row = phone
          .locator('.oz-row')
          .filter({ has: phone.locator('.t', { hasText: /(^|\])on mac$/ }) });
        await expect(row).toBeVisible({ timeout: 30_000 });
        await expect(row.locator('.oz-st')).toHaveText('done');
        await expect(row.locator('.oz-r2')).toContainText('MAC-DONE');
      }
    );

    // ---------------------------------------------------------------- 5 phone names the root
    await step(
      '5',
      'phone names root mac itself: POST /branch through the ap → the mac brain answers',
      async () => {
        expect(rootId, 'needs 3c').toBeTruthy();
        await phone.goto(`${AP}/session/main?id=${mainId}`);
        const fresh = await phoneFetch(phone, '/api/pair/refresh', { method: 'POST' });
        expect(fresh.status).toBe(200);
        accessToken = String(fresh.body.accessToken);
        const turn = {
          op: 'prompt',
          id: 'phone',
          root: rootId,
          text: 'Reply with exactly: PHONE-ON-MAC',
        };
        const r = await phoneFetch(phone, '/branch', {
          method: 'POST',
          body: turn,
          bearer: accessToken,
        });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body).toMatchObject({ ok: true, root: rootId, text: 'PHONE-ON-MAC' });
        // answered on the mac brain, in this device's own session there
        const macSessions = (await brain(MAC, '/session')).body as unknown as Array<J>;
        const mine = macSessions.filter((s) => s.title === `trunk · ${deviceId}`);
        expect(mine.map((s) => s.id)).toEqual([r.body.session]);
        expect(
          JSON.stringify((await brain(MAC, `/session/${r.body.session}/message`)).body)
        ).toContain('PHONE-ON-MAC');
        // the edge does not make the token anyone's: none, or a root it may not name, is refused
        expect((await phoneFetch(phone, '/branch', { method: 'POST', body: turn })).status).toBe(
          401
        );
        const other = await phoneFetch(phone, '/branch', {
          method: 'POST',
          body: { ...turn, root: 'not-mine' },
          bearer: accessToken,
        });
        expect(other.status).toBe(403);
      }
    );

    // ---------------------------------------------------------------- 6 revoke
    await step(
      '6',
      'box console revokes the phone → its next calls through the ap are refused',
      async () => {
        expect(deviceId, 'needs step 1').toBeTruthy();
        await box.goto(`${BASE}/devices`);
        await box.getByTestId(`revoke-${deviceId}`).click();
        await expect(box.getByTestId(`revoked-${deviceId}`)).toBeVisible();
        // the phone opens MAIN again: its first /api call is refused at the edge and the app
        // sends it back to pairing (components/device-auth.tsx) — on its screen
        await phone.goto(`${AP}/session/main?id=${mainId}`);
        await phone.waitForURL(/\/pair\?unpaired=1/, { timeout: 30_000 });
        // on /pair the app does not redirect: the refusals themselves, call by call
        const ping = await phoneFetch(phone, '/api/ping');
        expect(ping.status).toBe(401);
        expect(ping.body.why).toBe('revoked');
        const sessions = await phoneFetch(phone, '/api/session');
        expect(sessions.status).toBe(401);
        const turn = {
          op: 'prompt',
          id: 'phone',
          root: rootId,
          text: 'Reply with exactly: TOO-LATE',
        };
        const r = await phoneFetch(phone, '/branch', {
          method: 'POST',
          body: turn,
          bearer: accessToken,
        });
        expect(r.status).toBe(401);
        const again = await phoneFetch(phone, '/api/pair/refresh', { method: 'POST' });
        expect(again.status).toBe(401);
      }
    );
  } finally {
    await step('∀', `the phone only ever talked to ${AP}`, async () => {
      expect(reached.size).toBeGreaterThan(0);
      expect(offAp, [...reached].join(' ')).toEqual([]);
    });
    if (joiner) (joiner as ChildProcess).kill('SIGTERM');
    await Promise.all([desk.close(), phoneCtx.close()]);
  }
  expect(failed, `failed steps: ${failed.join(' ')}`).toEqual([]);
});
