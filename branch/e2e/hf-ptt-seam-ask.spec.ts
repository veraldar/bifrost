import { type Page, expect, test } from '@playwright/test';
import { diag } from './mainframe-c-lib';
import { synthAll, micArgs, flushLines, vetoLines, freshRoom, sendUserTurn, userMsgCount, waitForAssistant, W_ASK } from './seam-lib';

const S22 = { width: 360, height: 780 };
test.use({ viewport: S22, hasTouch: true, launchOptions: { args: micArgs(W_ASK, false) } });
synthAll();


test('T3 chain: real user barge -> one commit -> the answer SPEAKS', async ({ page }) => {
    test.setTimeout(420_000);
    const name = `e2e-seam-${Date.now().toString(36)}`;
    const r0 = await page.request.post('/api/session', { data: { name } });
    expect(r0.ok()).toBe(true);
    const j0 = (await r0.json()) as { id?: string };
    const sessionId = j0?.id || name;
    // turn 1 (no room): the brain writes a short reply so the deck has
    // something to speak BEFORE the one-shot question WAV can play out
    await sendUserTurn(page, name, 'Reply with one short sentence about the weather.');
    await waitForAssistant(page, sessionId);
    // NOW join: the browser mic IS the question WAV — it overlaps the reply
    await page.goto(`/session/${name}?id=${sessionId}`);
    await page.getByTestId('composer-mic').tap();
    await expect(page.getByTestId('free-phase')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('free-strip')).not.toContainText('connecting', {
      timeout: 30_000,
    });
    const deck = page.locator('.oz-deck');
    await expect(deck).toContainText('speaking', { timeout: 60_000 });
    const before = flushLines(8);
    // the question WAV barges: commit (echoTail = unplayed reply != the
    // question -> NO veto), the merged prompt lands as a user turn
    await expect(deck).toContainText('paused', { timeout: 30_000 });
    await expect.poll(async () => flushLines(8), { timeout: 40_000 }).toBeGreaterThan(before);
    await expect
      .poll(async () => userMsgCount(page, sessionId), { timeout: 60_000 })
      .toBeGreaterThanOrEqual(2);
    // the committed turn's reply must come back through the cycle (owner
    // chain: barge -> ONE commit -> reply spoken) — the cycle arms on commit
    await expect(deck, 'the committed turn answer must SPEAK').toContainText('speaking', {
      timeout: 240_000,
    });
  });
