import { type Page, devices, expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/** Continue a Claude Code session from the phone (11-13), driven like a person on a Pixel 7
 *  against the preview (PW_BASE_URL = :8447, E2E_OC_URL = its brain :4101): a conversation
 *  typed in a terminal is listed, one tap opens it as an [AGI] session, it remembers what the
 *  terminal said, the terminal's transcript is never written, the second turn resumes the fork.
 *  Real Claude Code turns (the AGI agent's model). */
const OC = process.env.E2E_OC_URL || 'http://127.0.0.1:4101';
test.use({ ...devices['Pixel 7'] });

const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');
const lines = (f: string) => readFileSync(f, 'utf8').split('\n').filter(Boolean).length;
/** where Claude Code files a folder's sessions: every non-alphanumeric char → '-' */
const projectDir = (cwd: string) =>
  join(homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));

async function send(page: Page, text: string) {
  const box = page.getByPlaceholder('message…');
  await box.tap();
  await box.fill(text);
  await page.getByRole('button', { name: 'send', exact: true }).tap();
}

/** an agent message matching `re` shows up on screen — polls, never a reload */
async function replyShows(page: Page, re: RegExp, timeout = 240_000) {
  await expect(page.locator('[data-mi]', { hasText: '(agent' }).filter({ hasText: re })).toBeVisible({
    timeout,
  });
}

type Harness = { kind: string; id: string; attached?: boolean; forked?: boolean; origin?: string };

test('continue a Claude Code session: listed, one tap, it remembers; the terminal transcript is untouched; turn 2 resumes the fork', async ({
  page,
  request,
}) => {
  test.setTimeout(10 * 60_000);
  // the terminal: a scratch Claude Code conversation in a fresh folder
  const cwd = mkdtempSync(join(tmpdir(), 'cc-attach-'));
  const id = randomUUID();
  execFileSync('claude', ['-p', '--model', 'haiku', '--session-id', id, 'remember the word walrus; reply ok'], {
    cwd,
    timeout: 180_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const dir = projectDir(cwd);
  const transcript = join(dir, `${id}.jsonl`);
  const before = sha(transcript);
  let sid = '';
  try {
    // the phone: + new session → continue a Claude Code session → tap it
    await page.goto('/');
    await page.getByRole('button', { name: 'new session' }).tap();
    await page.getByRole('button', { name: /continue a Claude Code session/ }).tap();
    const row = page.locator(`[data-cc="${id}"]`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText('remember the word walrus');
    await expect(row).toContainText(cwd);
    await row.tap();
    await page.waitForURL(/\/session\/[^?]+\?id=ses_/, { timeout: 30_000 });
    sid = new URL(page.url()).searchParams.get('id')!;
    const info = await (await request.get(`${OC}/session/${sid}`)).json();
    expect(info.agent).toBe('AGI');
    expect(info.harness).toEqual({ kind: 'claude', id, attached: true });
    expect(info.cwd).toBe(cwd);

    // turn 1: the terminal's context is there
    await send(page, 'what word did I ask you to remember?');
    await replyShows(page, /walrus/i);
    const h1 = (await (await request.get(`${OC}/session/${sid}`)).json()).harness as Harness;
    expect(h1.forked, 'the first turn forked the conversation').toBe(true);
    expect(h1.origin).toBe(id);
    expect(h1.id).not.toBe(id);
    expect(sha(transcript), "the terminal's transcript is unchanged").toBe(before);
    const fork = join(dir, `${h1.id}.jsonl`);
    const forkLines = lines(fork);

    // turn 2: resumes the fork (same id, the fork grows, no second fork)
    await send(page, 'Now write that word followed by -42, like word-42. Only that.');
    await replyShows(page, /walrus-42/i);
    const h2 = (await (await request.get(`${OC}/session/${sid}`)).json()).harness as Harness;
    expect(h2.id, 'turn 2 resumed the fork').toBe(h1.id);
    expect(lines(fork)).toBeGreaterThan(forkLines);
    expect(readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()).toEqual(
      [`${id}.jsonl`, `${h1.id}.jsonl`].sort()
    );
    expect(sha(transcript), "still unchanged after turn 2").toBe(before);

    // the list says which agent runs it
    await page.goto('/');
    await expect(page.getByText(/^\[AGI\]\s*remember the word walrus/).first()).toBeVisible({
      timeout: 20_000,
    });
  } finally {
    if (sid) await request.delete(`/api/session/${sid}`).catch(() => {});
  }
});

test('continue a Claude Code session: a refusal is said plainly on the phone', async ({ page }) => {
  // a session whose folder this root cannot see: the brain refuses, the phone shows why
  await page.route('**/api/harness/claude/sessions', (route) =>
    route.fulfill({
      json: [
        {
          id: '0f1e2d3c-4b5a-4968-8776-655443322110',
          cwd: '/nowhere/at/all',
          modified: Date.now(),
          title: 'a session from another box',
        },
      ],
    })
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'new session' }).tap();
  await page.getByRole('button', { name: /continue a Claude Code session/ }).tap();
  await page.locator('[data-cc="0f1e2d3c-4b5a-4968-8776-655443322110"]').tap();
  await expect(page.getByTestId('continue-claude').getByRole('alert')).toContainText(
    'does not exist on this root',
    { timeout: 20_000 }
  );
  expect(new URL(page.url()).pathname).toBe('/');
});
