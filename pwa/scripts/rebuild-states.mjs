// Voice-state evidence on the real app (local :3311 server, never :8080):
// per world — keyboard, held mic (heard), slide-to-delete (drop),
// hands-free listening, working, replied, speaking deck. Creates and deletes
// its own session. Usage: node scripts/rebuild-states.mjs [baseURL]
import { chromium } from '@playwright/test';
import path from 'node:path';

const base = process.argv[2] || 'http://127.0.0.1:3311';
const out = path.join(process.cwd(), '..', 'artifacts', 'rebuild');
const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

for (const theme of ['aether', 'terminus', 'drift']) {
  const name = `rebuild-states-${theme}-${Date.now().toString(36)}`;
  const s = await (await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })).json();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await ctx.addInitScript((t) => localStorage.setItem('theme', t), theme);
  const page = await ctx.newPage();
  const shot = (n) => page.screenshot({ path: path.join(out, `state-${theme}-${n}.png`) });
  try {
    await page.goto(`${base}/session/${name}?id=${s.id}`, { waitUntil: 'networkidle' });
    await page.getByPlaceholder('message…').fill('Reply with exactly: pong');
    await shot('1-keyboard');

    // send → working (green rail glides, phase ● working on it)
    await page.getByRole('button', { name: 'send', exact: true }).click();
    await page.getByText(/working… \d+s/).waitFor();
    await page.waitForTimeout(1200);
    await shot('2-working');
    await page.getByText('pong').last().waitFor({ timeout: 90_000 });
    await page.getByText(/working… \d+s/).waitFor({ state: 'detached', timeout: 90_000 });
    await shot('3-replied');

    // held mic → heard (amber rail, glowing mic, amber bars)
    const mic = page.getByRole('button', { name: 'push to talk' });
    const mb = await mic.boundingBox();
    // press near the right edge so the slide-left below stays inside the
    // key (a mouse has no implicit capture; a finger does)
    await page.mouse.move(mb.x + mb.width - 3, mb.y + mb.height / 2);
    await page.mouse.down();
    await page.getByRole('status', { name: 'listening' }).waitFor({ timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(900);
    await shot('4-heard-ptt');
    // slide left → drop armed (red), release discards the hold
    await page.mouse.move(mb.x + 4, mb.y + mb.height / 2, { steps: 6 });
    await page.waitForTimeout(400);
    await shot('5-drop-armed');
    await page.mouse.up();
    await page.waitForTimeout(800);

    // tap → hands-free listening
    await mic.click();
    await page.getByTestId('free-phase').waitFor();
    await page.waitForFunction(
      () => !/connecting/.test(document.querySelector('[data-testid=free-phase]')?.textContent || ''),
      null,
      { timeout: 30_000 }
    ).catch(() => {});
    await page.waitForTimeout(900);
    await shot('6-handsfree');
    await page.getByRole('button', { name: 'leave hands-free' }).click();
    await page.waitForTimeout(500);

    // listen → the deck (synthesizing, then speaking if the speech box answers)
    await page.getByRole('button', { name: 'listen' }).click();
    await page.waitForTimeout(400);
    await shot('7-synth');
    await page.getByRole('status', { name: 'speaking' }).waitFor({ timeout: 25_000 }).then(
      async () => {
        await page.waitForTimeout(700);
        await shot('8-speaking');
      },
      () => console.log(theme, 'speech never started (speech box unreachable?)')
    );
    await page.getByRole('button', { name: /^stop/ }).click().catch(() => {});
  } finally {
    await ctx.close();
    await fetch(`${base}/api/session/${s.id}`, { method: 'DELETE' });
  }
  console.log('states →', theme);
}
await browser.close();
