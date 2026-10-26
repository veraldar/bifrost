import { type Page, type Request, expect, test } from '@playwright/test';

/** MAINFRAME-C · the roots, every interaction that needs no voice turn:
 *  one tree on the page · press = amber this frame · tap = MAIN · slid off
 *  = nothing · keyboard (Enter, Space) · the first-turn gate · a hold talks
 *  to MAIN's room (voice tests off) or voice-test's (on) · MAIN's state on
 *  the roots (working walks on the shared clock, the answer climbs).
 *  Voice tests are ON unless a test says otherwise: a tap lands in MAIN's
 *  test twin, so MAIN is never joined as a room. Nothing writes MAIN. */

const SHOTS = process.env.TF_SHOTS || '../artifacts';
const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${SHOTS}/mainframe-c-${name}.png` });

async function home(page: Page, { vt = true, firstTurn = true } = {}) {
  await page.addInitScript(
    ([vt, firstTurn]) => {
      if (sessionStorage.getItem('mfc-init')) return; // once per test: a reload keeps what the test set
      sessionStorage.setItem('mfc-init', '1');
      if (vt) localStorage.setItem('bifrost-voice-test', '1');
      else localStorage.removeItem('bifrost-voice-test');
      if (firstTurn) localStorage.setItem('bifrost-first-turn', '1');
      else localStorage.removeItem('bifrost-first-turn');
      localStorage.setItem('oz-mode', 'text');
    },
    [vt, firstTurn]
  );
  await page.goto('/');
  const roots = page.getByTestId('roots');
  await expect(roots).toBeVisible();
  return roots;
}

function tokenRooms(page: Page): string[] {
  const rooms: string[] = [];
  page.on('request', (r: Request) => {
    if (r.url().endsWith('/api/token') && r.method() === 'POST') {
      try {
        rooms.push(String(JSON.parse(r.postData() || '{}').room));
      } catch {
        rooms.push('?');
      }
    }
  });
  return rooms;
}

async function center(page: Page) {
  // the middle of the bar, clear of the key at its right end
  const b = (await page.getByTestId('roots-hit').boundingBox())!;
  return { x: b.x + b.width * 0.4, y: b.y + b.height * 0.55 };
}

test.beforeAll(async ({ request }) => {
  // the voice-test room must exist (settings creates it when switched on)
  if (!(await request.get('/api/session/voice-test/messages?limit=1')).ok()) {
    expect((await request.post('/api/session', { data: { name: 'voice-test' } })).ok()).toBe(true);
  }
});

test('one tree: the band on top, the roots at the bottom — no corner door, MAIN is not a row', async ({
  page,
}) => {
  const roots = await home(page, { vt: false });
  await expect(page.getByTestId('tree-door')).toHaveCount(0);
  // exactly two crops of the one drawing: the crown (band) and the roots
  await expect(page.locator('svg > g.base')).toHaveCount(2);
  await expect(page.locator('.oz-band svg > g.base')).toHaveCount(1);
  await expect(roots.locator('svg > g.base')).toHaveCount(1);
  // the roots are a NEW drawing (the trunk continued down), not the tree again
  expect(await roots.locator('svg:has(> g.base)').getAttribute('viewBox')).toBe('150 0 1108 226');
  // full width, on the ground
  const vp = page.viewportSize()!;
  const b = (await roots.boundingBox())!;
  expect(Math.round(b.x)).toBe(0);
  expect(Math.round(b.width)).toBe(Math.min(vp.width, 448));
  expect(Math.round(b.y + b.height)).toBe(vp.height);
  expect(Math.round(b.height)).toBeGreaterThanOrEqual(84);
  // MAIN is the roots, never a row
  await expect(page.locator('.oz-row', { hasText: '[MAIN]' })).toHaveCount(0);
  await expect(page.getByTestId('roots-name')).toHaveText('main');
  await expect(page.getByTestId('roots-hit')).toHaveAttribute('href', '/session/main');
  // the last row scrolls clear of the roots
  await page.mouse.wheel(0, 20_000);
  const last = page.locator('.oz-row').last();
  if (await last.count()) {
    await page.waitForTimeout(300);
    const lb = (await last.boundingBox())!;
    expect(lb.y + lb.height).toBeLessThanOrEqual(b.y + 1);
  }
  await page.mouse.wheel(0, -20_000);
  await shot(page, '1-idle');
});

test('the one hold phrase: a device that never held reads it on its first 3 visits, then MAIN’s line', async ({
  page,
}) => {
  const now = Date.now();
  // an idle MAIN (the real one may be working — that state outranks the hint)
  await page.route(
    (u) => u.pathname === '/api/session',
    (r) =>
      r.request().method() === 'GET'
        ? r.fulfill({
            json: [
              {
                id: 'ses_main',
                title: '[MAIN]',
                preview: 'you are in — say what to build next',
                updated: now,
                lastRole: 'assistant',
                lastAt: now - 99_999_999,
                msgs: 4,
              },
            ],
          })
        : r.continue()
  );
  await page.addInitScript(() => {
    if (sessionStorage.getItem('hint-init')) return;
    sessionStorage.setItem('hint-init', '1');
    localStorage.removeItem('bifrost-roots-held');
    localStorage.removeItem('bifrost-roots-hint');
  });
  for (let visit = 1; visit <= 4; visit++) {
    await page.goto('/');
    const say = page.getByTestId('roots-say');
    if (visit <= 3) await expect(say).toContainText('hold to talk · tap to open');
    else await expect(say).toContainText('you are in');
  }
  // a hold retires it at once (even inside the first visits)
  await page.evaluate(() => localStorage.setItem('bifrost-roots-hint', '0'));
  await page.goto('/');
  await expect(page.getByTestId('roots-say')).toContainText('hold to talk · tap to open');
  await page.evaluate(() => localStorage.setItem('bifrost-roots-held', '1'));
  await page.goto('/');
  await expect(page.getByTestId('roots-say')).toContainText('you are in');
});

test('press = amber in the same frame; let go inside 0.3 s = MAIN opens (no voice minted)', async ({
  page,
}) => {
  const rooms = tokenRooms(page);
  await home(page);
  // the class flips inside the pointerdown dispatch itself — no React round
  // trip, no frame between the finger and the amber
  const sameTask = await page.getByTestId('roots-hit').evaluate((el) => {
    const r = el.getBoundingClientRect();
    const o = {
      bubbles: true,
      cancelable: true,
      pointerId: 7,
      isPrimary: true,
      button: 0,
      clientX: r.x + 20,
      clientY: r.y + 40,
    };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...o, pointerType: 'touch' }));
    const amber = el.parentElement!.classList.contains('heard');
    el.dispatchEvent(new PointerEvent('pointercancel', { ...o, pointerType: 'touch' }));
    return amber;
  });
  expect(sameTask).toBe(true);
  await expect(page.getByTestId('roots')).not.toHaveClass(/heard/);

  const c = await center(page);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  expect(await page.getByTestId('roots').evaluate((el) => el.classList.contains('heard'))).toBe(
    true
  );
  await expect(page.getByTestId('roots-say')).toContainText('heard');
  await shot(page, '2-heard');
  await page.mouse.up(); // well inside 0.3 s
  // MAIN (its voice-test twin while voice tests are on)
  await expect(page).toHaveURL(/\/session\/(main|voice-test)/);
  expect(rooms.filter((r) => r === 'main')).toEqual([]); // the tap minted nothing for MAIN
  console.log(`tap: token rooms after the tap ${JSON.stringify(rooms)}`);
});

test('slid off inside the tap window = nothing happens', async ({ page }) => {
  const rooms = tokenRooms(page);
  await home(page);
  const c = await center(page);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x, c.y - 220, { steps: 4 }); // up, off the roots, fast
  await page.mouse.up();
  await page.waitForTimeout(600);
  expect(new URL(page.url()).pathname).toBe('/');
  await expect(page.getByTestId('roots')).not.toHaveClass(/heard/);
  await expect(page.getByTestId('roots')).toHaveAttribute('data-phase', 'off');
  expect(rooms).toEqual([]);
});

test('keyboard: the roots take focus; Enter = tap; a short Space = tap', async ({ page }) => {
  await home(page);
  const hit = page.getByTestId('roots-hit');
  // reachable by Tab from the page (not mouse-only)
  let reached = false;
  for (let i = 0; i < 40 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = await hit.evaluate((el) => el === document.activeElement);
  }
  expect(reached).toBe(true);
  await shot(page, '3-focus');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/session\/(main|voice-test)/);

  await page.goto('/');
  await hit.focus();
  await page.keyboard.down(' ');
  expect(await page.getByTestId('roots').evaluate((el) => el.classList.contains('heard'))).toBe(
    true
  );
  expect(await page.evaluate(() => window.scrollY)).toBe(0); // Space did not scroll
  await page.keyboard.up(' ');
  await expect(page).toHaveURL(/\/session\/(main|voice-test)/);
});

test('the first voice turn is not done here: a hold says so, let go opens MAIN (its card)', async ({
  page,
}) => {
  const rooms = tokenRooms(page);
  await home(page, { firstTurn: false });
  const c = await center(page);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await expect(page.getByTestId('roots-say')).toContainText('your first talk is inside main', {
    timeout: 3_000,
  });
  await shot(page, '4-first-turn-gate');
  await page.mouse.up();
  await expect(page).toHaveURL(/\/session\/(main|voice-test)/);
  expect(rooms.filter((r) => r !== 'voice-test')).toEqual([]);
});

test('voice tests OFF: a hold talks to MAIN’s room (token room = main) — intercepted, nothing written', async ({
  page,
  request,
}) => {
  const mainTotal = async () =>
    Number(
      (await request.get('/api/session/main/messages?limit=1')).headers()['x-total-count'] || 0
    );
  const before = await mainTotal();
  const asked: string[] = [];
  // the room the roots ask for — answered with a refusal, so no room opens
  await page.route('**/api/token', async (route) => {
    asked.push(String(JSON.parse(route.request().postData() || '{}').room));
    await route.fulfill({ status: 503, body: 'held for the test' });
  });
  await home(page, { vt: false });
  const c = await center(page);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await expect(page.getByTestId('roots')).toHaveAttribute('data-armed', 'hold', { timeout: 3_000 });
  await expect(page.getByTestId('roots-say')).toContainText('voice connect failed', {
    timeout: 10_000,
  });
  await page.mouse.up();
  expect(asked).toEqual(['main']);
  expect(new URL(page.url()).pathname).toBe('/');
  // the failed hold handed hands-free back: the keyboard mode stands
  expect(await page.evaluate(() => localStorage.getItem('oz-mode'))).toBe('text');
  expect(await mainTotal()).toBe(before);
});

test('MAIN’s state on the roots: working walks (shared clock with a branch), the answer climbs', async ({
  page,
}) => {
  const now = Date.now();
  const base = [
    {
      id: 'ses_main',
      title: '[MAIN]',
      preview: 'you are in — say what to build next',
      updated: now - 60_000,
      lastRole: 'assistant',
      lastAt: now - 60_000,
      msgs: 4,
    },
    {
      id: 'ses_sub',
      title: 'main helper',
      parentId: 'ses_main',
      preview: 'a sub of main',
      updated: now - 50_000,
      lastRole: 'assistant',
      lastAt: now - 50_000,
      msgs: 2,
    },
    {
      id: 'ses_b',
      title: 'v07 gate waves',
      preview: 'WAVE CONTINUATION received',
      updated: now - 30_000,
      lastRole: 'assistant',
      lastAt: now - 30_000,
      msgs: 9,
    },
  ];
  let list: Record<string, unknown>[] = base;
  await page.route(
    (u) => u.pathname === '/api/session',
    (route) =>
      route.request().method() === 'GET' ? route.fulfill({ json: list }) : route.continue()
  );
  await page.addInitScript(() => {
    localStorage.setItem('bifrost-roots-held', '1'); // past the hint: MAIN's own line
    // everything above counts as read until a reply lands
    localStorage.setItem('oz-read-init', '1');
    localStorage.setItem(
      'oz-read',
      JSON.stringify({ main: Date.now(), 'v07-gate-waves': Date.now() })
    );
  });
  const roots = await home(page, { vt: false });

  // idle: MAIN's last line on the roots; MAIN gone from the list, its sub surfaced
  await expect(roots).toHaveAttribute('data-s', 'idle');
  await expect(page.getByTestId('roots-say')).toContainText('you are in');
  await expect(page.locator('.oz-row', { hasText: '[MAIN]' })).toHaveCount(0);
  await expect(page.locator('.oz-row', { hasText: 'main helper' })).toHaveCount(1);

  // MAIN works alone: the roots walk, the crown stays still, "1 working"
  list = base.map((s) => (s.id === 'ses_main' ? { ...s, pending: true } : s));
  await page.getByRole('button', { name: 'refresh sessions' }).click();
  await expect(roots).toHaveAttribute('data-s', 'working');
  await expect(page.getByTestId('roots-say')).toHaveText(/awaiting answer/);
  await expect(page.locator('.oz-band')).toHaveClass(/live/);
  await expect(page.locator('.oz-band')).not.toHaveClass(/walk/);
  await expect(page.locator('.oz-band figcaption')).toHaveText('1 working');
  await shot(page, '5-working');

  // MAIN and a branch work: one clock — crown on 0 s / 4 s, roots on 2 s / 6 s
  list = base.map((s) => (s.id !== 'ses_sub' ? { ...s, pending: true } : s));
  await page.getByRole('button', { name: 'refresh sessions' }).click();
  await expect(page.locator('.oz-band')).toHaveClass(/walk/);
  await expect(page.locator('.oz-band')).toHaveAttribute('data-shared', '');
  await expect(roots).toHaveAttribute('data-shared', '');
  const anim = await page.evaluate(() => {
    const on = (sel: string) =>
      Array.from(document.querySelectorAll<SVGPathElement>(sel))
        .filter((p) => getComputedStyle(p).animationName === 'oz-turn')
        .map((p) => `${p.dataset.j}@${getComputedStyle(p).animationDelay}`);
    return { crown: on('.oz-band .sig.lo'), roots: on('.oz-roots .sig.w') };
  });
  console.log(`shared clock: ${JSON.stringify(anim)}`);
  expect(anim.crown.sort()).toEqual(['0@0s', '2@4s']);
  expect(anim.roots.sort()).toEqual(['1@2s', '3@6s']);
  await shot(page, '6-shared-clock');

  // the answer: unread on the roots, the pulse climbs the taproot once
  list = base.map((s) =>
    s.id === 'ses_main'
      ? {
          ...s,
          preview: 'green · 57/0 · the report is in artifacts',
          lastAt: Date.now() + 5_000,
          updated: Date.now() + 5_000,
          lastHasQ: false,
        }
      : s
  );
  await page.getByRole('button', { name: 'refresh sessions' }).click();
  await expect(roots).toHaveAttribute('data-s', 'replied');
  await expect(roots).toHaveAttribute('data-unread', '');
  await expect(page.getByTestId('roots-name')).toHaveText('●main');
  await expect(page.getByTestId('roots-say')).toContainText('green · 57/0');
  expect(await roots.locator('.sig.t').evaluate((p) => getComputedStyle(p).animationName)).toBe(
    'oz-pass'
  );
  await shot(page, '7-replied');
});
