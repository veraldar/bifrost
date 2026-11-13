import { test, expect, type Page } from '@playwright/test';

/**
 * THE PHONE-CLASS REPRO — user law 10-19: no fix without a demonstrated repro.
 * Simulates the phone: mobile UA, 360×780 touch viewport, 4× CPU throttle,
 * cold context (empty cache/storage — a first open). Runs the exact user
 * steps: load → tap the tree → the greeting → talk. One flow, four verdicts,
 * each with a fixed budget; the JSON verdict table lands in artifacts/.
 *
 * Flow-aware: it drives whichever onboarding the SERVED build ships (v1 LLM
 * onboarding / v2 scripted door), so the same harness is RED before the fix
 * and GREEN after. Budgets never move between phases.
 */

const BUDGETS = {
  loadMs: 2_000, // verdict 1: tree visible after cold open
  feedbackMs: 150, // verdict 2a: the tree answers the finger (amber/wake)
  tapToNavMs: 1_500, // verdict 2b: tap → the view changes
  greetingMs: 300, // verdict 3: the greeting VOICE starts (user's bar)
  heardMs: 15_000, // verdict 4b: talk → transcript lands (STT alive)
};

type Verdict = { name: string; budget: string; actual: string; pass: boolean };
const verdicts: Verdict[] = [];
function judge(name: string, budgetMs: number | null, actualMs: number | null, note = '') {
  // budget null = observed state, not a timing race: pass when the state was
  // seen (actual non-null), fail when it never appeared
  const pass =
    budgetMs === null ? actualMs !== null : actualMs !== null && actualMs <= budgetMs;
  verdicts.push({
    name,
    budget: budgetMs === null ? note : `≤ ${budgetMs} ms`,
    actual: actualMs === null ? `FAIL — ${note}` : `${Math.round(actualMs)} ms${note ? ` (${note})` : ''}`,
    pass,
  });
}

const INIT = `
  window.__audio = [];
  const play = HTMLAudioElement.prototype.play;
  HTMLAudioElement.prototype.play = function (...a) {
    const src = this.currentSrc || this.src || '(blob)';
    const rec = { t: performance.now(), src: String(src).slice(0, 120), playing: null };
    window.__audio.push(rec);
    this.addEventListener('playing', () => { rec.playing = performance.now(); }, { once: true });
    return play.apply(this, a);
  };
`;

async function firstAudioAfter(page: Page, since: number, capMs = 3_000): Promise<number | null> {
  // poll: first 'playing' at/after `since`, or null when the cap passes —
  // a one-shot snapshot cannot tell "not yet" from "never"
  const t0 = Date.now();
  for (;;) {
    const hit = await page.evaluate((s) => {
      const hits = (window.__audio as { t: number; playing: number | null }[]).filter(
        (a) => a.playing !== null && a.playing >= s
      );
      return hits.length ? hits[0].playing! - s : null;
    }, since);
    if (hit !== null) return hit;
    if (Date.now() - t0 > capMs) return null;
    await page.waitForTimeout(16);
  }
}

/** press-and-hold with REAL pointer events (a dispatched synthetic event has
 *  no pointerId — setPointerCapture throws and the handler dies silently) */
async function holdTree(page: Page, holdMs: number) {
  const box = (await page.getByTestId('tree-first').boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(holdMs);
  await page.mouse.up();
}

test('phone-class repro: load → tap tree → greeting → talk', async ({ page }, testInfo) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  // phone-class link: the tailnet tunnel — ~4 Mbps down, 100 ms RTT
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 100,
    downloadThroughput: (4 * 1024 * 1024) / 8,
    uploadThroughput: (1.5 * 1024 * 1024) / 8,
  });
  await page.addInitScript(INIT);

  // ── verdict 1: LOAD — cold open, tree on screen ─────────────────────────
  const t0 = Date.now();
  const resp = await page.goto('/', { waitUntil: 'commit' });
  const tree = page.getByTestId('tree-first');
  let loadMs: number | null = null;
  try {
    // judge against the budget; wait longer so the rest of the flow
    // still gets measured even when the load alone blows it
    await tree.waitFor({ state: 'visible', timeout: 20_000 });
    loadMs = Date.now() - t0;
  } catch {
    /* stays null → FAIL */
  }
  judge('1 load: tree visible (cold, cpu×4)', BUDGETS.loadMs, loadMs,
    loadMs === null ? 'tree never appeared in budget' : '');
  const ttfb = await resp?.request().timing?.() ?? null;
  testInfo.attach('load.json', {
    body: JSON.stringify({ loadMs, ttfb, url: resp?.url() }, null, 2),
    contentType: 'application/json',
  });
  if (loadMs === null) {
    await page.screenshot({ path: 'artifacts/repro-load-fail.png', fullPage: true });
    throw new Error('verdict 1 RED: the tree did not load in budget — stopping the flow');
  }

  // ── verdict 2: TAP — the tree answers the finger, then the view moves ───
  // settle first: the tree is server-rendered (paints before JS), but a tap
  // that lands before hydration has no handler — the v1-class dead first tap.
  // Wait for the app to be interactive, then hold; one retry if a hold goes
  // unanswered (a fresh tap, judged on its own).
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 160)));
  await page
    .waitForFunction(() => document.readyState === 'complete', undefined, { timeout: 15_000 })
    .catch(() => {});
  await page.waitForTimeout(800);
  const tTap = Date.now();
  const treeBox = (await tree.boundingBox())!;
  const tx = treeBox.x + treeBox.width / 2;
  const ty = treeBox.y + treeBox.height / 2;
  let answered = false;
  let attempt = 0;
  while (!answered && attempt < 2) {
    attempt++;
    await page.mouse.move(tx, ty);
    await page.mouse.down();
    const fbMs = await page
      .evaluate(() => {
        const el = document.querySelector('[data-testid="tree-first"]');
        const t = Date.now();
        return new Promise<number | null>((res) => {
          const iv = setInterval(() => {
            if (el && /heard|wake/.test(el.className)) {
              clearInterval(iv);
              res(Date.now() - t);
            } else if (Date.now() - t > 2000) {
              clearInterval(iv);
              res(null);
            }
          }, 16);
        });
      })
      .catch(() => null);
    if (attempt === 1)
      judge('2a tap: tree answers the finger', BUDGETS.feedbackMs, fbMs,
        fbMs === null ? 'no visual feedback within 2s' : '');
    await page.waitForTimeout(120);
    await page.mouse.up();
    answered =
      (await page
        .getByTestId('door')
        .waitFor({ state: 'visible', timeout: 3_000 })
        .then(() => true)
        .catch(() => false)) ||
      page.url().includes('/session/');
    if (!answered) {
      console.log(`[repro] hold ${attempt} unanswered (handlers not live yet) — tapping again`);
      await page.waitForTimeout(1_000);
    }
  }
  // the audio log runs on performance.now() — read the release in ITS epoch
  const tRelease = await page.evaluate(() => performance.now());

  // which flow is the served build?
  let v2 = false;
  const doorOrNav = await Promise.race([
    page
      .getByTestId('door')
      .waitFor({ state: 'visible', timeout: 4_000 })
      .then(() => 'door' as const)
      .catch(() => null),
    page
      .waitForURL(/\/session\//, { timeout: 10_000 })
      .then(() => 'nav' as const)
      .catch(() => null),
  ]);
  if (doorOrNav === 'door') {
    v2 = true;
  } else {
    const navMs = doorOrNav === 'nav' ? Date.now() - tTap : null;
    judge('2b tap: the view changes', BUDGETS.tapToNavMs, navMs,
      navMs === null ? 'no navigation within 10s of the tap' : '');
  }

  // ── verdict 3: GREETING — the voice starts ───────────────────────────────
  let greetMs: number | null = null;
  let greetHow = '';
  if (v2) {
    await page.getByTestId('door-say').waitFor({ state: 'visible', timeout: 5_000 });
    greetMs = await firstAudioAfter(page, tRelease);
    greetHow = greetMs !== null ? 'prerecorded file' : 'no audio in 3s of release';
    judge('3 greeting: voice starts', BUDGETS.greetingMs, greetMs, greetHow);
    // walk the door; the last tap is the navigation (verdict 2b, v2 form)
    await page.getByTestId('door-lang-en').click();
    await page.getByTestId('door-style-short').click();
    await page.getByTestId('door-brain').waitFor({ state: 'visible', timeout: 10_000 });
    const tEnter = Date.now();
    await page.getByTestId('door-enter').click();
    const entered = await page
      .waitForURL(/\/session\/main/, { timeout: 15_000 })
      .then(() => Date.now() - tEnter)
      .catch(() => null);
    judge('2b tap: the view changes (door → MAIN)', BUDGETS.tapToNavMs, entered,
      entered === null ? 'MAIN never opened' : '');
  } else {
    // v1: the brain's greeting lands in the transcript of the onboarding
    // session; the VOICE starts after join+LLM+TTS. Either is late.
    const tGreet = Date.now();
    const got = await Promise.race([
      page
        .locator('[data-testid="free-phase"][data-cycle="speaking"]')
        .waitFor({ timeout: 25_000 })
        .then(() => 'voice' as const)
        .catch(() => null),
      page
        .getByText(/hello|hi |i'?m bifrost/i)
        .first()
        .waitFor({ state: 'visible', timeout: 25_000 })
        .then(() => 'text' as const)
        .catch(() => null),
    ]);
    greetMs = got ? Date.now() - tGreet : null;
    greetHow = got ?? 'neither voice nor greeting text within 25s';
    judge('3 greeting: voice starts', BUDGETS.greetingMs, greetMs, greetHow);
  }
  await page.screenshot({ path: 'artifacts/repro-greeting.png', fullPage: true });

  // ── verdict 4: FLOW — a clean landing in MAIN, ready for voice ──────────
  if (!v2) {
    // v1 only completes when the brain emits its marker; simulate the
    // completed conversation the way its own e2e did, then watch what the
    // user actually gets in MAIN
    await page.route(/\/messages/, async (route) => {
      const r = await route.fetch();
      try {
        const j = (await r.json()) as {
          messages?: { role: string; text: string; time?: number }[];
        };
        if (Array.isArray(j.messages) && !j.__did) {
          j.messages.push({
            role: 'assistant',
            text: 'All set. [[bifrost:onboarded voice=woman style=short brain=plan]]',
            time: Date.now(),
          });
          (j as { __did?: boolean }).__did = true;
          await route.fulfill({ json: j });
          return;
        }
      } catch {
        /* not json — pass through */
      }
      await route.fulfill({ response: r });
    });
    await page.waitForURL(/\/session\/main/, { timeout: 30_000 }).catch(() => {});
  }
  const onMain = /\/session\/main/.test(page.url());
  const ready = onMain
    ? await page
        .getByTestId('first-turn')
        .waitFor({ state: 'visible', timeout: 5_000 })
        .then(() => true)
        .catch(() => false)
    : false;
  judge(
    '4 flow: MAIN ready-for-voice state',
    null,
    onMain && ready ? 0 : null,
    onMain
      ? ready
        ? 'first-turn card up'
        : 'landed in MAIN with NO ready-for-voice state (user stranded)'
      : 'never landed in MAIN'
  );
  await page.screenshot({ path: 'artifacts/repro-main.png', fullPage: true });

  // ── the talk leg (v2): hold → release → transcript → reply → "you are in"
  // It runs in a PRIVATE first-turn session (?first=1 works on any slug — the
  // page's own mechanism): the door walk stays on MAIN exactly as the user
  // does it, but two repro suites testing at once churn MAIN's room and kill
  // the other's connection mid-hold (seen live: 5 agent jobs in 3s, our room
  // dropped 500ms into the hold). A lone user has no such contention.
  if (v2 && ready) {
    await page.goto(`/session/repro-talk-${Date.now().toString(36)}?first=1`);
    const card = page.getByTestId('first-turn');
    await card.waitFor({ state: 'visible', timeout: 10_000 });
    // let the card's own room-warm settle before the hold (a reader's pace)
    await page.waitForTimeout(2_500);
    const allow = page.getByTestId('first-allow-mic');
    if (await allow.isVisible().catch(() => false)) await allow.click();
    const mic = page.getByTestId('composer-mic');
    await mic.waitFor({ state: 'visible', timeout: 10_000 });
    const mbox = (await mic.boundingBox())!;
    const tTalk = Date.now();
    await page.mouse.move(mbox.x + mbox.width / 2, mbox.y + mbox.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(900);
    await page.mouse.up();
    const heard = await page
      .getByTestId('first-heard')
      .waitFor({ state: 'visible', timeout: BUDGETS.heardMs })
      .then(() => Date.now() - tTalk)
      .catch(() => null);
    judge('4b talk: transcript lands (STT alive)', BUDGETS.heardMs, heard,
      heard === null ? 'nothing transcribed in 15s' : '');
    const said = heard
      ? await page
          .getByTestId('first-in')
          .waitFor({ state: 'visible', timeout: 50_000 })
          .then(() => Date.now() - tTalk)
          .catch(() => null)
      : null;
    judge('4c reply: the brain answers, spoken', 60_000, said,
      said === null ? 'no spoken reply (or not within 50s)' : '');
    await page.screenshot({ path: 'artifacts/repro-in.png', fullPage: true });
    // the door afterwards: home is the list + the corner tree, not the tree
    await page.goto('/');
    const corner = page.getByTestId('tree-door');
    const again = page.getByTestId('tree-first');
    const cornerOk = await corner
      .waitFor({ state: 'visible', timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    const againOk = await again.isVisible().catch(() => false);
    verdicts.push({
      name: '4d return: home = list + corner door (no re-onboarding)',
      budget: 'corner yes · fullscreen no',
      actual: cornerOk && !againOk ? 'ok' : `corner=${cornerOk} fullscreen-again=${againOk}`,
      pass: cornerOk && !againOk,
    });
  }

  const red = verdicts.filter((v) => !v.pass);
  const out = {
    phase: v2 ? 'v2-door' : 'v1-llm',
    url: testInfo.config.projects[0]?.use?.baseURL,
    budgets: BUDGETS,
    verdicts,
    red: red.length,
    pageErrors,
  };
  const { writeFileSync } = await import('fs');
  writeFileSync('artifacts/repro-verdicts.json', JSON.stringify(out, null, 2));
  console.log('\n=== REPRO VERDICTS (' + out.phase + ') ===');
  for (const v of verdicts)
    console.log(`${v.pass ? 'PASS' : 'RED '}  ${v.name}  — ${v.actual}  (budget ${v.budget})`);
  testInfo.attach('verdicts.json', { body: JSON.stringify(out, null, 2), contentType: 'application/json' });
  expect(red.length, `verdicts RED: ${red.map((v) => v.name).join(' · ')}`).toBe(0);
});
