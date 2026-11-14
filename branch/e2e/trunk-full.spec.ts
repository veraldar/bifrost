import { type ChildProcess, execFileSync, spawn } from 'child_process';
import { appendFileSync, existsSync, openSync, readFileSync, writeFileSync } from 'fs';
import http from 'node:http';
import { join, resolve } from 'path';
import {
  type BrowserContext,
  type Locator,
  type Page,
  devices,
  expect,
  test,
} from '@playwright/test';

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
 *     the ap → paired (device cookie, pinned box key) → it lands on home: this phone walked the
 *     door already, so the session list (never straight into MAIN)
 *  1d a FRESH phone pairs the same way → home is the door → it walks it → MAIN's first turn is
 *     typed (voice cannot ride the trunk yet: the voice ways are skipped) → "you are in" → list
 *  1v voice over the trunk is a state, not an error: holding the roots, tapping and holding the
 *     mic → one calm line, no error box, no "fix this", one /api/token call per page load (503
 *     voice-unavailable, JSON)
 *   2 the phone talks to MAIN: "Reply with exactly: HELLO-PHONE" → the reply on its screen
 *   3 join: the new machine (sim/trunk-full-joiner.py, its own address) makes its WireGuard
 *     key, POSTs /api/roots/join {…, wg_pub} through the ap and shows the approve QR (qrencode)
 *     → the phone scans it (zbarimg), sees the same code AND the same tunnel-key fingerprint,
 *     taps "Add to my tree" (that pins the key in roots.json) → the machine's poll gets 20 link
 *     tokens, its root id, the hub brain's name ("home") and the hub's key + tunnel addresses →
 *     its WireGuard node, its brain (peer "home" inside the tunnel) + root-dial.py dial
 *     wss://ap.tree.test/rootlink → the hub's bridge shows the root LINKED; the hub reaches its
 *     brain INSIDE WireGuard; the plaintext switchboard is refused
 *   4 the hub brain learns the joined root by itself (YGG_PEERS_FROM → its node's /_wg; no
 *     restart, nothing written by hand) → MAIN delegates over the tunnel: the phone's message
 *     makes MAIN run session_start with
 *     root = the joined root → the session runs on that root's brain → its report comes home
 *     → the phone sees MAIN come back and the tree row on that root done with MAC-DONE
 *  4e a third machine (lab, its own address) joins the same way: QR, the phone sees the code and
 *     its tunnel key, approves → it links
 *  4f mac and lab learn each other from the hub's directory (inside their tunnels) — their
 *     brains too (YGG_PEERS_FROM = their node's list), no restart
 *  4g mac ↔ lab call each other through the hub's relay: MAIN on mac runs a session on lab and
 *     lab's report comes back to mac
 *  4h a tap where the ap hands the root links to the hub's bridge: the frames between mac and
 *     lab are WireGuard, nothing of the brief or the report is readable
 *   5 the phone names the joined root itself: POST /branch {root} through the ap (its own
 *     device token, its own region) → answered by the joined root's brain
 *   6 the box console revokes the phone → its next calls through the ap are refused, and the
 *     root it approved loses its tunnel (both ways)
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
/** the hub's WireGuard node (front door), the joiner's node and its ports, the trunk binary */
const HUBWG = process.env.PW_HUBWG || '';
const NET_BIN = process.env.PW_NET_BIN || '';
const MAC_WG = process.env.PW_MAC_WG || '';
const MACWG = `http://127.0.0.1:${MAC_WG}`;
/** the third root (lab) and the tap on the root links */
const LAB = `http://127.0.0.1:${process.env.PW_LAB_PORT || ''}`;
const LABWG = `http://127.0.0.1:${process.env.PW_LAB_WG || ''}`;
const LABST = join(STATE, 'lab');
const TAPDIR = process.env.PW_TAP || '';
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
/** the screens a failed step photographs (STATE/fail-<step>-<name>.png) */
const screens: Array<[string, Page]> = [];
const VOICE_NA = /Voice isn't available over the trunk yet — type instead/;
/** the app's error box (components/app/error-box.tsx) — inside the page's <main>; Next's own
 *  route announcer (role=alert too, outside <main>) is not it */
const errorBox = (page: Page) => page.locator('main [role="alert"]');

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
    for (const [name, p] of screens) {
      await p.screenshot({ path: join(STATE, `fail-${n}-${name}.png`) }).catch(() => {});
    }
    return false;
  }
}

/** what the phone's browser saw go wrong: failed requests, HTTP errors, console errors */
function netLog(ctx: BrowserContext, who: string) {
  const log = (line: string) => appendFileSync(join(STATE, 'phone-net.log'), `${who} ${line}\n`);
  ctx.on('requestfailed', (r) => log(`FAILED ${r.method()} ${r.url()} ${r.failure()?.errorText}`));
  ctx.on('response', (r) => {
    if (r.status() >= 400) log(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`);
  });
  ctx.on('page', (p) =>
    p.on('console', (m) => {
      if (m.type() === 'error') log(`console ${m.text().slice(0, 300)}`);
    })
  );
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

/** the box console's QR, as the phone's camera reads it (zbarimg on a screenshot) */
async function scanQr(box: Page, name: string): Promise<string> {
  await box.goto(`${BASE}/pair`);
  const qr = box.getByTestId('pair-qr');
  await expect(qr.locator('svg')).toBeVisible();
  const png = join(STATE, `${name}.png`);
  writeFileSync(png, await qr.screenshot());
  return execFileSync('zbarimg', ['--raw', '-q', png]).toString().trim();
}

/** a finger held on an element (real touch events — the phone's own gesture) */
async function touchHold(page: Page, sel: Locator, ms: number) {
  const b = (await sel.boundingBox())!;
  const at = { x: b.x + b.width * 0.4, y: b.y + b.height * 0.55 };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
  await page.waitForTimeout(ms);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

/** React has hydrated this element: its handlers are attached (a touch before that is a plain
 *  link tap — the server HTML is on screen first) */
const hydrated = (page: Page, testId: string) =>
  page.waitForFunction(
    (id) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps'));
    },
    testId,
    { timeout: 30_000 }
  );

/** home after pairing, for a phone that walked the door: the list, the roots — no door */
async function onTheList(page: Page) {
  await expect(page.getByRole('heading', { name: 'BIFROST' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('roots')).toBeVisible();
  await expect(page.getByTestId('tree-first')).toHaveCount(0);
}

/** every /api/token answer a page got: status + the body as text */
function tokenTap(ctx: BrowserContext) {
  const seen: Array<{ status: number; body: string }> = [];
  ctx.on('response', (r) => {
    if (!r.url().endsWith('/api/token')) return;
    const at = seen.push({ status: r.status(), body: '' }) - 1;
    void r
      .text()
      .then((t) => (seen[at].body = t))
      .catch(() => {});
  });
  return seen;
}

/** type into the composer and tap send — the way a thumb does it (root-coord-ui.spec.ts) */
async function send(page: Page, text: string) {
  const box = page.getByPlaceholder('message…');
  await box.tap({ timeout: 30_000 });
  await box.fill(text, { timeout: 30_000 });
  await page.getByRole('button', { name: 'send', exact: true }).tap({ timeout: 30_000 });
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
    permissions: ['microphone'], // it talked before (tailnet): the mic is allowed
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
  const phoneTokens = tokenTap(phoneCtx);
  netLog(phoneCtx, 'phone');
  netLog(desk, 'box');
  screens.push(['phone', phone], ['box', box]);
  // a fresh phone: nothing on it yet — the door is its first screen, the mic never asked (1d)
  const freshCtx: BrowserContext = await browser.newContext({
    ...devices['Pixel 7'],
    ignoreHTTPSErrors: true,
  });
  freshCtx.on('request', (r) => see(r.url()));
  freshCtx.on('page', watch);
  const freshTokens = tokenTap(freshCtx);
  netLog(freshCtx, 'fresh');

  let mainId = '';
  let deviceId = '';
  let rootId = '';
  let joiner: ChildProcess | null = null;
  let joiner2: ChildProcess | null = null;
  let accessToken = '';

  try {
    // ---------------------------------------------------------------- 1 pair
    await step(
      '1',
      'box console QR → phone pairs through the ap (cookie, key pinned) → home: the list',
      async () => {
        const qrUrl = await scanQr(box, 'pair-qr');
        expect(qrUrl.startsWith(`${AP}/pair#`), qrUrl).toBe(true);
        const frag = new URLSearchParams(qrUrl.split('#')[1]);
        expect(frag.get('code')).toMatch(/^bfnp-/);
        await phone.goto(qrUrl);
        // home decides (11-14): this phone walked the door → the list, never straight into MAIN
        await phone.waitForURL(`${AP}/`, { timeout: 30_000 });
        await onTheList(phone);
        mainId = String((await phoneFetch(phone, '/api/session/main')).body.id || '');
        expect(mainId).toMatch(/^ses_/);
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

    // ---------------------------------------------------------------- 1d a fresh phone: the door
    await step(
      '1d',
      'a fresh phone pairs through the ap → the door → typed first turn (no voice) → in → list',
      async () => {
        const fresh = await freshCtx.newPage();
        screens.push(['fresh', fresh]);
        await fresh.goto(await scanQr(box, 'pair-qr-fresh'));
        await fresh.waitForURL(`${AP}/`, { timeout: 30_000 });
        // never walked the door on this phone: home IS the door
        const tree = fresh.getByTestId('tree-first');
        await expect(tree).toBeVisible();
        await expect(fresh.getByText('hold the tree to begin')).toBeVisible();
        const door = fresh.getByTestId('door');
        await hydrated(fresh, 'tree-first');
        await tree.tap();
        await expect(door).toHaveAttribute('data-step', 'lang');
        await fresh.getByTestId('door-lang-en').tap();
        await expect(door).toHaveAttribute('data-step', 'style');
        await fresh.getByTestId('door-style-short').tap();
        await expect(door).toHaveAttribute('data-step', 'brain');
        await expect(fresh.getByTestId('door-enter')).toBeEnabled({ timeout: 20_000 });
        await fresh.getByTestId('door-enter').tap();
        // the door's destination stays MAIN, its last step the first turn there
        await fresh.waitForURL(/\/session\/main\?id=ses_[^&]+&first=1/, { timeout: 30_000 });
        const card = fresh.getByTestId('first-turn');
        await expect(card).toHaveAttribute('data-way', 'type');
        // voice cannot ride the trunk yet: the card says so once, its voice ways are struck
        await expect(fresh.getByTestId('first-voice-na')).toHaveText(VOICE_NA, { timeout: 20_000 });
        await expect(card.locator('li[data-way="hold"]')).toHaveAttribute('data-s', 'skip');
        await expect(card.locator('li[data-way="free"]')).toHaveAttribute('data-s', 'skip');
        await fresh.getByTestId('first-type').tap();
        const input = fresh.getByPlaceholder('message…');
        await expect(input).toBeFocused();
        await input.fill('Reply with exactly: DOOR-TYPED');
        await fresh.getByRole('button', { name: 'send', exact: true }).tap();
        await expect(agentSays(fresh, 'DOOR-TYPED').first()).toBeVisible({ timeout: 60_000 });
        // the typed turn was the walk's turn: straight on to "you are in"
        await expect(card).toHaveAttribute('data-state', 'in', { timeout: 60_000 });
        await expect(fresh.getByTestId('first-in')).toBeVisible();
        await expect(errorBox(fresh)).toHaveCount(0); // no error box on the way
        await expect(fresh.getByRole('button', { name: 'fix this' })).toHaveCount(0);
        await fresh.getByTestId('first-ok').tap();
        await expect(card).toHaveCount(0);
        const ls = await fresh.evaluate(() => ({
          door: localStorage.getItem('bifrost-door'),
          first: localStorage.getItem('bifrost-first-turn'),
          mode: localStorage.getItem('oz-mode'),
        }));
        expect(ls.door).toBe('v2');
        expect(ls.first).toBeTruthy();
        expect(ls.mode).toBe('text');
        // one ask for the whole walk (MAIN's page load), answered as a state, as JSON
        expect(freshTokens.length, JSON.stringify(freshTokens)).toBe(1);
        // home now: the list; holding the roots (the mic never allowed here) says the line
        // without a mic prompt — asked first (GET, mints nothing), once for this page
        await fresh.goto(`${AP}/`);
        await onTheList(fresh);
        await hydrated(fresh, 'roots-hit');
        // the first visit after the door, the roots grow up from the bottom edge once
        await expect(fresh.getByTestId('roots')).not.toHaveClass(/grow/, { timeout: 10_000 });
        for (let i = 0; i < 2; i++) {
          await touchHold(fresh, fresh.getByTestId('roots-hit'), 1_000);
          await expect(fresh.getByTestId('roots-say')).toHaveText(VOICE_NA, { timeout: 10_000 });
          await expect(fresh.getByTestId('roots')).not.toHaveAttribute('data-armed', 'prompt');
        }
        expect(freshTokens.length, JSON.stringify(freshTokens)).toBe(2);
        for (const t of freshTokens) {
          expect(t.status).toBe(503);
          await expect.poll(() => t.body).toContain('"error":"voice-unavailable"');
        }
      }
    );

    // ---------------------------------------------------------------- 1v voice: a state
    await step(
      '1v',
      'voice over the trunk: roots hold, mic tap + hold → one calm line, no error box, no storm',
      async () => {
        expect(mainId, 'needs step 1').toMatch(/^ses_/);
        if (!/\/$/.test(phone.url())) await phone.goto(`${AP}/`);
        await onTheList(phone);
        await hydrated(phone, 'roots-hit');
        const roots = phone.getByTestId('roots-hit');
        // the roots: hold = talk to MAIN right here → the line, and the roots stay roots
        await touchHold(phone, roots, 1_200);
        await expect(phone.getByTestId('roots-say')).toHaveText(VOICE_NA, { timeout: 10_000 });
        await expect(phone.getByTestId('roots')).toHaveAttribute('data-phase', 'off');
        await touchHold(phone, roots, 1_200); // again: known now, nothing is asked
        await expect(phone.getByTestId('roots-say')).toHaveText(VOICE_NA);
        // a tap opens MAIN
        await roots.tap();
        await phone.waitForURL(/\/session\/main/, { timeout: 20_000 });
        const mic = phone.getByTestId('composer-mic');
        await expect(mic).toHaveAttribute('data-voice', 'unavailable', { timeout: 20_000 });
        const calm = async () => {
          await expect(phone.getByTestId('voice-unavailable')).toHaveText(VOICE_NA);
          await expect(errorBox(phone)).toHaveCount(0); // the error box
          await expect(phone.getByRole('button', { name: 'fix this' })).toHaveCount(0);
          await expect(phone.getByTestId('free-strip')).toHaveCount(0); // no hands-free
        };
        await mic.tap(); // a tap = the hands-free toggle
        await calm();
        await touchHold(phone, mic, 1_000); // a hold = push to talk
        await calm();
        // a reload is a new page: it asks once more, then never again
        await phone.reload();
        await expect(mic).toHaveAttribute('data-voice', 'unavailable', { timeout: 20_000 });
        for (let i = 0; i < 3; i++) {
          await mic.tap();
          await touchHold(phone, mic, 700);
        }
        await calm();
        await phone.waitForTimeout(3_000); // no retry timer fires behind it
        expect(phoneTokens.length, JSON.stringify(phoneTokens)).toBe(2);
        for (const t of phoneTokens) {
          expect(t.status).toBe(503);
          expect(JSON.parse(t.body)).toMatchObject({ error: 'voice-unavailable' });
          expect(String(JSON.parse(t.body).why)).not.toBe('');
        }
        expect(await phone.evaluate(() => localStorage.getItem('oz-mode'))).toBe('text');
        const diag = await phone.evaluate(() => localStorage.getItem('oz-diag') || '');
        expect(diag).not.toContain('voice connect failed');
        expect(diag).not.toContain('Unexpected end of JSON input');
      }
    );

    // ---------------------------------------------------------------- 2 MAIN answers
    await step(
      '2',
      'phone → MAIN (through the ap): "Reply with exactly: HELLO-PHONE" shows on screen',
      async () => {
        expect(mainId, 'needs step 1').toMatch(/^ses_/);
        if (!/\/session\/main/.test(phone.url()))
          await phone.goto(`${AP}/session/main?id=${mainId}`);
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
            '--net-bin',
            NET_BIN,
            '--wg-port',
            MAC_WG,
            '--wg-udp',
            process.env.PW_MAC_WG_UDP || '',
            '--wg-pipe',
            process.env.PW_MAC_PIPE || '',
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

    await step(
      '3b',
      'phone scans it, sees the same code and tunnel key, taps "Add to my tree"',
      async () => {
        expect(J1.approve_url, 'needs 3a').toBeTruthy();
        await phone.goto(String(J1.approve_url));
        await expect(phone.getByTestId('join-code')).toHaveText(String(J1.code));
        // the fingerprint of the key the machine sent — what approving pins
        expect(String(J1.wg_fp)).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
        await expect(phone.getByTestId('join-wg-fp')).toHaveText(String(J1.wg_fp));
        await expect(phone.getByTestId('join-name')).toHaveText('mac');
        const add = phone.getByTestId('join-approve');
        await expect(add).toHaveText(/Add to my tree/);
        await add.tap();
        await expect(phone.getByTestId('join-status')).toContainText('mac', { timeout: 20_000 });
      }
    );

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
        // the tunnel: the hub's public key (never its private half) and this root's address
        const hubPub = readFileSync(join(STATE, 'hub-wg.key.pub'), 'utf8').trim();
        expect(root.wg?.public_key).toBe(hubPub);
        expect(root.wg?.ip).toMatch(/^10\.\d+\.\d+\.\d+$/);
        expect(root.wg?.hub_ip).toBe(root.wg.ip.replace(/\.\d+$/, '.1'));
        // the hub pinned the key the phone saw: roots.json (mode 600, no private key in it)
        const reg0 = JSON.parse(readFileSync(join(STATE, 'roots.json'), 'utf8'));
        const rec = reg0.roots.find((r: J) => r.id === rootId);
        expect(rec?.wg_pub).toBe(J1.wg_pub);
        expect(rec?.wg_ip).toBe(root.wg.ip);
        expect(reg0.wg?.net).toBe(root.wg.net);
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
      'its root-dial links through wss://ap/rootlink; the hub reaches its brain inside WireGuard',
      async () => {
        expect(rootId, 'needs 3c').toBeTruthy();
        await waitFile(join(MACST, 'linked'), 30_000);
        expect(joinerError()).toBe('');
        const blog = readFileSync(join(STATE, 'bridge.log'), 'utf8');
        expect(blog).toContain(`root-link: root '${rootId}' LINKED`);
        // the hub's node pinned exactly the key the phone saw
        await expect
          .poll(async () =>
            ((await brain(HUBWG, '/_wg')).body as unknown as J[]).map((p) => p.fingerprint)
          )
          .toEqual([J1.wg_fp]);
        // the hub reaches the joined root's brain through the tunnel
        const r = await brain(HUBWG, `/_wg/${rootId}/root`);
        expect(r.status).toBe(200);
        expect(r.body.name).toBe(rootId);
        // …whose one peer is the hub brain, by the name the join answered
        expect(r.body.peers).toEqual(['home']);
        // …and the joined root reaches the hub brain the same way
        const back = await brain(MACWG, '/_wg/local/root');
        expect(back.status).toBe(200);
        expect(back.body.name).toBe('home');
        // the old plaintext switchboard is refused at the bridge
        const plain = await brain(BRIDGE, `/_root/${rootId}/root`);
        expect(plain.status).toBe(403);
      }
    );

    // ---------------------------------------------------------------- 4 MAIN delegates
    await step(
      '4a',
      'the hub brain learns the joined root by itself (YGG_PEERS_FROM → its node; no restart)',
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
          `peers: learned root ${rootId} = ${HUBWG}/_wg/${rootId}`
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

    await step(
      '4d',
      "the hub's bridge relayed WireGuard only: the tunnel is up, no plaintext brain call crossed",
      async () => {
        const peers = (await brain(HUBWG, '/_wg')).body as unknown as J[];
        expect(peers[0]).toMatchObject({ id: rootId, up: true });
        expect(Number(peers[0].handshakes)).toBeGreaterThanOrEqual(1);
        const node = (await brain(HUBWG, '/_wg/_node')).body;
        expect(Number((node.frames as J).rx)).toBeGreaterThan(10);
        expect(node.dropped).toMatchObject({
          unknown_key: 0,
          wrong_link: 0,
          replay: 0,
          auth_fail: 0,
        });
        // the bridge never performed a switchboard call (it logs every one it relays or refuses)
        expect(readFileSync(join(STATE, 'bridge.log'), 'utf8')).not.toMatch(/switch: root/);
      }
    );

    // ---------------------------------------------------------------- 4e-4h a third root
    let J2: J = {};
    await step(
      '4e',
      'a third machine (lab) joins: the phone sees its code + tunnel key, approves; it links',
      async () => {
        const out = openSync(join(STATE, 'joiner-lab.log'), 'a');
        joiner2 = spawn(
          'python3',
          [
            JOINER,
            '--state',
            LABST,
            '--hub',
            AP,
            '--cafile',
            CAFILE,
            '--from',
            process.env.PW_FAR2 || '',
            '--name',
            'lab',
            '--os',
            'linux',
            '--host',
            'lab.local',
            '--brain-bin',
            YGG_BIN,
            '--mock-url',
            MOCK,
            '--brain-port',
            process.env.PW_LAB_PORT || '',
            '--peer-port',
            process.env.PW_LAB_PEER || '',
            '--net-bin',
            NET_BIN,
            '--wg-port',
            process.env.PW_LAB_WG || '',
            '--wg-udp',
            process.env.PW_LAB_WG_UDP || '',
            '--wg-pipe',
            process.env.PW_LAB_PIPE || '',
          ],
          { stdio: ['ignore', out, out] }
        );
        await expect
          .poll(() => existsSync(join(LABST, 'join.json')), { timeout: 30_000 })
          .toBe(true);
        J2 = JSON.parse(readFileSync(join(LABST, 'join.json'), 'utf8'));
        await phone.goto(String(J2.approve_url));
        await expect(phone.getByTestId('join-code')).toHaveText(String(J2.code));
        await expect(phone.getByTestId('join-wg-fp')).toHaveText(String(J2.wg_fp));
        await phone.getByTestId('join-approve').tap();
        await expect(phone.getByTestId('join-status')).toContainText('lab', { timeout: 20_000 });
        await expect.poll(() => existsSync(join(LABST, 'linked')), { timeout: 40_000 }).toBe(true);
        expect(existsSync(join(LABST, 'error'))).toBe(false);
        const reg = JSON.parse(readFileSync(join(STATE, 'roots.json'), 'utf8'));
        expect(reg.roots.find((r: J) => r.id === 'lab')?.wg_pub).toBe(J2.wg_pub);
      }
    );

    await step(
      '4f',
      'mac and lab learn each other from the hub directory, and so do their brains',
      async () => {
        const ids = async (base: string) =>
          ((await brain(base, '/_wg/_roots')).body as unknown as J[]).map((p) => p.id);
        await expect.poll(() => ids(MACWG), { timeout: 30_000 }).toEqual(['lab']);
        await expect.poll(() => ids(LABWG), { timeout: 30_000 }).toEqual([rootId]);
        // their brains learn the other root from their node (YGG_PEERS_FROM), no restart
        await expect
          .poll(async () => ((await brain(MAC, '/root')).body.peers as string[]) || [], {
            timeout: 30_000,
          })
          .toContain('lab');
        await expect
          .poll(async () => ((await brain(LAB, '/root')).body.peers as string[]) || [], {
            timeout: 30_000,
          })
          .toContain(rootId);
        // the hub brain learned it too (two roots now)
        await expect
          .poll(async () => ((await brain(HOME, '/root')).body.peers as string[]) || [], {
            timeout: 20_000,
          })
          .toEqual([rootId, 'lab']);
      }
    );

    await step(
      '4g',
      'mac and lab call each other through the hub relay: a session on lab reports to mac',
      async () => {
        const there = await brain(MACWG, '/_wg/lab/root');
        expect(there.status).toBe(200);
        expect(there.body.name).toBe('lab');
        const back = await brain(LABWG, `/_wg/${rootId}/root`);
        expect(back.status).toBe(200);
        expect(back.body.name).toBe(rootId);
        // MAIN on mac starts a session on lab; lab's report comes home to mac
        const post = (base: string, path: string, body: unknown) =>
          new Promise<J>((done, fail) => {
            const data = JSON.stringify(body);
            const req = http.request(
              `${base}${path}`,
              { method: 'POST', headers: { 'content-type': 'application/json' }, timeout: 90_000 },
              (res) => {
                let text = '';
                res.setEncoding('utf8');
                res.on('data', (c) => (text += c));
                res.on('end', () => done(JSON.parse(text || '{}') as J));
              }
            );
            req.on('error', fail);
            req.end(data);
          });
        const main = await post(MAC, '/session', { title: '[MAIN]' });
        await post(MAC, `/session/${main.id}/message`, {
          parts: [
            {
              type: 'text',
              text: tool([
                [
                  'session_start',
                  {
                    title: 'on lab',
                    agent: 'build',
                    brief: 'Reply with exactly: LAB-DONE',
                    root: 'lab',
                  },
                ],
              ]),
            },
          ],
        });
        await expect
          .poll(async () => (await treeOf(MAC))['on lab']?.card?.status, { timeout: 60_000 })
          .toBe('done');
        expect(String((await treeOf(MAC))['on lab'].card?.headline)).toContain('LAB-DONE');
        expect(Object.keys(await treeOf(LAB))).toContain('on lab');
      }
    );

    await step(
      '4h',
      "the hub's bridge saw only WireGuard between mac and lab (a tap where the ap hands it over)",
      async () => {
        const frames = readFileSync(join(TAPDIR, 'frames.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as J);
        const pair = frames.filter(
          (f) =>
            [rootId, 'lab'].includes(String(f.root)) &&
            f.op === 2 &&
            [rootId, 'lab'].includes(String(f.addr))
        );
        expect(pair.length).toBeGreaterThan(20);
        expect(pair.filter((f) => f.kind === null)).toEqual([]);
        expect(pair.filter((f) => f.kind === 'data').length).toBeGreaterThan(10);
        // no plaintext brain op on either root's link, and nothing of the brief or the report readable
        const ops = frames.filter((f) => [rootId, 'lab'].includes(String(f.root)) && f.op === 1);
        expect(ops.filter((f) => f.text_op === 'http' || f.text_op === 'http.reply')).toEqual([]);
        const seen = readFileSync(join(TAPDIR, 'payload.bin'));
        for (const needle of ['LAB-DONE', 'Reply with exactly: LAB-DONE', 'on lab', 'MAC-DONE'])
          expect(seen.includes(Buffer.from(needle)), needle).toBe(false);
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
      'box console revokes the phone → its calls are refused; the root it approved loses its tunnel',
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
        // the hub's node drops the root whose approver is gone: the tunnel is cut both ways
        await expect
          .poll(async () => (await brain(HUBWG, '/_wg')).body, { timeout: 10_000 })
          .toEqual([]);
        expect((await brain(HUBWG, `/_wg/${rootId}/root`)).status).toBe(502);
        expect((await brain(MACWG, '/_wg/local/root')).status).toBe(504);
        expect(readFileSync(join(STATE, 'wg-hub.log'), 'utf8')).toContain(
          `peer '${rootId}' REMOVED`
        );
        // the phone approved lab too: mac and lab lose each other once the hub stops vouching
        // (their copy of the directory goes stale: 20 s)
        await expect
          .poll(async () => (await brain(MACWG, '/_wg/_roots')).body, { timeout: 40_000 })
          .toEqual([]);
        expect((await brain(MACWG, '/_wg/lab/root')).status).toBe(502);
      }
    );
  } finally {
    await step('∀', `the phone only ever talked to ${AP}`, async () => {
      expect(reached.size).toBeGreaterThan(0);
      expect(offAp, [...reached].join(' ')).toEqual([]);
    });
    if (joiner) (joiner as ChildProcess).kill('SIGTERM');
    if (joiner2) (joiner2 as ChildProcess).kill('SIGTERM');
    await Promise.all([desk.close(), phoneCtx.close(), freshCtx.close()]);
  }
  expect(failed, `failed steps: ${failed.join(' ')}`).toEqual([]);
});
