import { join } from 'node:path';
import { test, expect, devices } from '@playwright/test';

/** REAL model, end to end: a picture with text is attached on MAIN the way a person does it
 *  (the paperclip's file input), the person asks what it says, and the reply quotes the text.
 *  The image rides to the model as an image block; the door's own model cannot see, so the root
 *  runs that turn on its vision model (YGG_VISION_MODELS). Needs E2E_OC_URL = that root. */
const IMG = join(__dirname, 'fixtures/sign-roots-4812.png'); // "ROOTS 4812" / "the trunk carries"
test.use({ ...devices['Pixel 7'] });
test.setTimeout(150_000);
type M = { info: { role: string; time: { completed?: number } }; parts: { type: string; text?: string }[] };

test('a picture with text: MAIN reads it back', async ({ page, request }) => {
  const oc = process.env.E2E_OC_URL || 'http://127.0.0.1:4101';
  const MAIN = ((await (await request.get(`${oc}/session`)).json()) as { id: string; title: string }[]).find(
    (x) => x.title === '[MAIN]'
  )!.id;
  const before = ((await (await request.get(`${oc}/session/${MAIN}/message`)).json()) as M[]).length;
  await page.goto(`/session/main?id=${MAIN}`);
  await expect(page.getByPlaceholder('message…')).toBeVisible({ timeout: 20_000 });
  await page.locator('input[type="file"][accept="image/*"]').setInputFiles(IMG);
  await page.getByPlaceholder('message…').fill('what does this picture say?');
  await page.getByRole('button', { name: 'send', exact: true }).tap();
  // the reply quotes the picture's text — in the brain, and on the screen
  const reply = async () =>
    ((await (await request.get(`${oc}/session/${MAIN}/message`)).json()) as M[])
      .slice(before)
      .filter((m) => m.info.role === 'assistant' && m.info.time.completed)
      .map((m) => m.parts.map((p) => p.text || '').join(' '))
      .join(' ');
  await expect.poll(reply, { timeout: 120_000, intervals: [3000] }).toMatch(/4812/);
  expect(await reply()).toMatch(/roots/i);
  await expect(page.getByText(/4812/).last()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('img[src^="data:image"]').last()).toBeVisible(); // the picture is in the chat
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/root-coord-image-read.png` });
});
