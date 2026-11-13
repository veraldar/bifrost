import { type Page, expect, test } from '@playwright/test';
import { diag } from './mainframe-c-lib';
import { synthAll, micArgs, flushLines, vetoLines, freshRoom, sendUserTurn, userMsgCount, waitForAssistant, W_ECHO, ECHO_PHRASE } from './seam-lib';

const S22 = { width: 360, height: 780 };
test.use({ viewport: S22, hasTouch: true, launchOptions: { args: micArgs(W_ECHO, false) } });
synthAll();


test('T2 veto: phone-echo barge is refused pre-run (playback resumes)', async ({ page }) => {
    test.setTimeout(420_000);
    const name = `e2e-seam-${Date.now().toString(36)}`;
    const r0 = await page.request.post('/api/session', { data: { name } });
    expect(r0.ok()).toBe(true);
    const j0 = (await r0.json()) as { id?: string };
    const sessionId = j0?.id || name;
    // the reply must EXIST before the browser (and its one-shot WAV) join —
    // otherwise the WAV plays out during the brain run and never overlaps
    await sendUserTurn(page, name, `Say exactly this and nothing else, twice in a row: ${ECHO_PHRASE}`);
    await waitForAssistant(page, sessionId);
    await page.goto(`/session/${name}?id=${sessionId}`);
    await page.getByTestId('composer-mic').tap();
    await expect(page.getByTestId('free-phase')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('free-strip')).not.toContainText('connecting', {
      timeout: 30_000,
    });
    const deck = page.locator('.oz-deck');
    await expect(deck, 'the arrival must speak').toContainText('speaking', { timeout: 60_000 });
    const before = vetoLines(6);
    const msgsBefore = await userMsgCount(page, sessionId);
    // the WAV speaks THE REPLY'S WORDS into the mic: barge pauses the deck,
    // the echo tail rides the commit — the agent vetoes BEFORE any run
    await expect(deck).toContainText('paused', { timeout: 30_000 });
    await expect.poll(async () => vetoLines(6), { timeout: 40_000 }).toBeGreaterThan(before);
    // the barge undoes itself — playback resumes, no new turn anywhere
    await page.waitForTimeout(24_000);
    await expect(deck, 'echo veto resumes playback').toContainText('speaking', {
      timeout: 30_000,
    });
    await expect
      .poll(async () => userMsgCount(page, sessionId), { timeout: 20_000 })
      .toBe(msgsBefore);
    const d = (await diag(page)).join('\n');
    expect(d).toContain('echo veto: commit refused pre-run');
  });
