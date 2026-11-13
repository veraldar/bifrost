import { expect, test } from '@playwright/test';
import { diag } from './mainframe-c-lib';
import { micArgs, synthSelf, vetoLines, sendUserTurn, userMsgCount, waitForAssistant, W_SELF, ECHO_PHRASE } from './seam-lib';

/** SELF-VOICE echo-veto (fidelity-gap-ledger 11-09 19:56Z + 20:05Z, repeated x2):
 *  our own LAST reply returns through the mic AFTER playback ended. Must be vetoed
 *  PRE-commit: agent answers 'echo', no run starts, no turn lands. Window = last reply
 *  text + audio tail. Needs the agent-side veto + a scratch agent (hf-sim-r1.md TODO-1/2). */
const S22 = { width: 360, height: 780 };
test.use({ viewport: S22, hasTouch: true, launchOptions: { args: micArgs(W_SELF, false) } });
synthSelf(`${ECHO_PHRASE}, ${ECHO_PHRASE}`);

test('self-voice: own last reply back through the mic after playback is vetoed pre-commit', async ({ page }) => {
  test.setTimeout(420_000);
  const name = `e2e-self-${Date.now().toString(36)}`;
  const r0 = await page.request.post('/api/session', { data: { name } });
  expect(r0.ok()).toBe(true);
  const sessionId = ((await r0.json()) as { id?: string }).id || name;
  await sendUserTurn(page, name, `Say exactly this and nothing else: ${ECHO_PHRASE}, ${ECHO_PHRASE}`);
  await waitForAssistant(page, sessionId);
  const before = vetoLines(6);
  const msgsBefore = await userMsgCount(page, sessionId);
  await page.goto(`/session/${name}?id=${sessionId}`);
  await page.getByTestId('composer-mic').tap();
  await expect(page.getByTestId('free-phase')).toBeVisible({ timeout: 10_000 });
  // playback of the arrival finishes first (WAV has 12 s lead silence), THEN the self-voice lands
  await expect.poll(async () => vetoLines(6), { timeout: 90_000 }).toBeGreaterThan(before);
  await expect.poll(async () => userMsgCount(page, sessionId), { timeout: 20_000 }).toBe(msgsBefore);
  // negative control: no run was started by the veto'd window
  expect((await diag(page)).join('\n')).not.toContain('commit_turn: accepted');
});
