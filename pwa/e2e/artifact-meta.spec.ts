/** artifact meta v1 — the ai sidecar end to end, seeded (no model in the
 *  loop): chips + notes render, the ask flow lands in the source session
 *  with the reference line, and the composer law holds (mic beside send). */
import { expect, test } from '@playwright/test';
import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import path from 'path';

const DIR = path.join(process.cwd(), '..', 'artifacts');
const NAME = `e2e-meta-${Date.now().toString(36)}.md`;
const META = path.join(DIR, '.meta.json');

let sessionId = '';
let metaBackup: string | null = null;

test.beforeAll(async ({ request }) => {
  await mkdir(DIR, { recursive: true });
  try {
    metaBackup = await readFile(META, 'utf8');
  } catch {
    metaBackup = null;
  }
  // a real session to attribute to — the ask flow must land in it
  const r = await request.post('/api/session', {
    data: { name: `e2e-meta-src-${Date.now().toString(36)}` },
  });
  const s = await r.json();
  sessionId = s.id;
  const file = path.join(DIR, NAME);
  await writeFile(file, '# seeded sample\n\nmeta spec fixture\n');
  const { mtimeMs } = await stat(file);
  const meta = metaBackup ? JSON.parse(metaBackup) : { cats: [], items: {} };
  meta.cats = [...new Set([...(meta.cats || []), 'report'])];
  meta.items[NAME] = { cat: 'report', note: 'seeded note line', ses: sessionId, mtime: mtimeMs, at: Date.now() };
  await writeFile(META, JSON.stringify(meta));
});

test.afterAll(async ({ request }) => {
  await rm(path.join(DIR, NAME), { force: true });
  if (metaBackup === null) await rm(META, { force: true });
  else await writeFile(META, metaBackup);
  if (sessionId) await request.delete(`/api/session/${sessionId}`);
});

test('chips + note render; ask lands in the source session with the reference', async ({ page }) => {
  await page.goto('/artifacts');
  await page.getByRole('button', { name: 'all', exact: true }).first().click();
  // category chips show the sidecar's set
  await expect(page.getByRole('group', { name: 'category' }).getByRole('button', { name: 'report' })).toBeVisible();
  // the list row carries cat + note
  await expect(page.getByTestId('artifact-list')).toContainText('report · seeded note line');
  // open it → origin strip + ask key
  await page.getByRole('button', { name: NAME }).click();
  const ask = page.getByRole('button', { name: 'ask about this artifact' });
  await expect(ask).toBeVisible();
  await expect(page.getByRole('link', { name: 'open source session' })).toBeVisible();
  // ask → the source session, reference line already sent
  await ask.click();
  await expect(page).toHaveURL(new RegExp(`/session/.+id=${sessionId}`));
  await expect(page.getByText(`artifact: ${NAME.replace('.md', '')}`).first()).toBeVisible({
    timeout: 20_000,
  });
});

test('composer law: mic stays while send appears', async ({ page }) => {
  await page.goto(`/session/e2e-meta-src?id=${sessionId}`);
  await page.getByPlaceholder('message…').fill('hello');
  await expect(page.getByRole('button', { name: 'send', exact: true })).toBeVisible();
  await expect(page.getByTestId('composer-mic')).toBeVisible();
});
