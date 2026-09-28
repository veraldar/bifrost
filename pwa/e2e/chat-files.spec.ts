import { mkdir, rm, writeFile } from 'fs/promises';
import path from 'path';
import { expect, test } from '@playwright/test';

/** Files arrive through the chat, never as paths: every artifact type the
 *  agent links renders inline (md formatted, text/code pre, pdf tap-card,
 *  audio player, html frame, image). Transcripts are mocked; the fixture
 *  files are real so /api/artifact serves them (incl. the new text exts). */
const PFX = 'e2e-cf';

const fixtures: Record<string, string | Buffer> = {
  [`${PFX}-report.md`]: '## CF Heading\n\nrendered **bold** md body\n',
  [`${PFX}-util.py`]: 'def cf_util():\n    return "cf-py-body"\n',
  [`${PFX}-spec.pdf`]: '%PDF-1.4\n',
  [`${PFX}-page.html`]:
    '<html><body style="background:#fff"><h1>CF Iframe Page</h1></body></html>',
  [`${PFX}-shot.png`]: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  ),
};

const reply = [
  `Report: [report](/api/artifact/${PFX}-report.md)`,
  `Code: [code](/api/artifact/${PFX}-util.py)`,
  `PDF: [spec](/api/artifact/${PFX}-spec.pdf)`,
  `Audio: [tone](/api/artifact/${PFX}-tone.wav)`,
  `Image: ![shot](/api/artifact/${PFX}-shot.png)`,
  `Page: [page](/api/artifact/${PFX}-page.html)`,
].join('\n');

const SLUG = `${PFX}-session-${Date.now().toString(36)}`;
const HEADERS = {
  'X-Total-Count': '2',
  'X-Run-State': 'none|1|assistant',
  'X-Run-Live': '0',
  'X-Run-Live-Since': '0',
  'X-Run-Ended': String(Date.now()),
  'Cache-Control': 'no-store',
};

test.beforeAll(async () => {
  await mkdir('../artifacts', { recursive: true });
  for (const [name, body] of Object.entries(fixtures)) {
    await writeFile(path.join('../artifacts', name), body);
  }
});

test.afterAll(async () => {
  await Promise.all(
    Object.keys(fixtures)
      .concat([`${PFX}-tone.wav`])
      .map((name) => rm(path.join('../artifacts', name), { force: true }))
  );
});

test('artifact links render inline viewers in the chat', async ({ page }) => {
  await page.route(`**/api/session/*/messages*`, (route) =>
    route.fulfill({
      headers: HEADERS,
      contentType: 'application/json',
      body: JSON.stringify([
        { role: 'user', text: 'show me the files', images: [], time: Date.now() - 60_000 },
        { role: 'assistant', text: reply, images: [], time: Date.now() - 30_000, done: true },
      ]),
    })
  );
  await page.goto(`/session/${SLUG}?id=mock-${SLUG}`);

  // md → fetched and rendered as markdown, not a link
  await expect(page.getByRole('heading', { name: 'CF Heading' })).toBeVisible();
  await expect(page.getByText('rendered', { exact: false })).toBeVisible();
  // text/code → fetched into a pre
  await expect(page.getByText('cf-py-body')).toBeVisible();
  // pdf → tap-to-view card pointing at the artifact
  const pdf = page.getByRole('link', { name: /e2e-cf-spec\.pdf/ });
  await expect(pdf).toBeVisible();
  await expect(pdf).toHaveAttribute('href', `/api/artifact/${PFX}-spec.pdf`);
  // audio → inline player; image → inline picture; html → sandboxed frame
  await expect(page.locator(`audio[src*="${PFX}-tone.wav"]`)).toHaveCount(1);
  await expect(page.locator(`img[src*="${PFX}-shot.png"]`)).toBeVisible();
  const frame = page.locator(`iframe[src*="${PFX}-page.html"]`);
  await expect(frame).toBeVisible();
  await expect(frame.contentFrame().getByRole('heading', { name: 'CF Iframe Page' })).toBeVisible();

  await page.screenshot({ path: '../artifacts/e2e-chat-files.png' });
});
