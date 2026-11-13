import { afterAll, expect, test } from '@playwright/test';
import { execFileSync } from 'child_process';
import { readFile, unlink, utimes, writeFile } from 'fs/promises';
import path from 'path';

// ARTIFACT-PLUMB (10-26): delegations drop files into the MAIN checkout's
// artifacts/ (~/Work/bifrost/artifacts), but a worktree-served gallery (the
// sandbox, :8443) only read its own dir — new mockups never showed until
// someone copied them by hand. The gallery + route now read every source;
// these pin "no manual step" and the one name → file rule.
// Run the spec from the same tree the server under test is served from.
const ROOT = path.join(process.cwd(), '..');
const LOCAL_DIR = path.join(ROOT, 'artifacts');
const MAIN_DIR = path.join(
  path.dirname(
    execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ROOT })
      .toString()
      .trim()
  ),
  'artifacts'
);
// on the main checkout the two are one dir — the union has nothing to add
const IS_WORKTREE = path.resolve(MAIN_DIR) !== path.resolve(LOCAL_DIR);
const BUILTIN_DIR = path.join(process.cwd(), 'artifacts-builtin');

const made: string[] = [];
afterAll(async () => {
  for (const f of made) await unlink(f).catch(() => {});
});

async function drop(dir: string, name: string, body: string, mtimeSec?: number): Promise<void> {
  const f = path.join(dir, name);
  made.push(f);
  await writeFile(f, body);
  if (mtimeSec) await utimes(f, mtimeSec, mtimeSec);
}

type Entry = { name: string; mtime: number; source: string };
async function list(request: import('@playwright/test').APIRequestContext): Promise<Entry[]> {
  const r = await request.get('/api/artifact');
  expect(r.ok()).toBeTruthy();
  return (await r.json()) as Entry[];
}

test('a file dropped in the main tree shows in the open gallery — no copy, no reload', async ({ page }) => {
  await page.goto('/artifacts');
  // first-visit mercy marks every source's backlog seen (one sync write)
  await page.waitForFunction(() => localStorage.getItem('oz-artifact-init') === '1', null, {
    timeout: 15_000,
  });
  const name = `e2e-plumb-${Date.now().toString(36)}.html`;
  await drop(MAIN_DIR, name, '<h1>plumb payload</h1>');
  // the gallery's own 8 s poll picks it up — nobody touches the page
  const card = page.getByRole('button', { name: new RegExp(`^${name}$`) });
  await expect(card).toBeVisible({ timeout: 20_000 });
  // it landed after the mercy run → it rings (unseen dot on the card)
  await expect(card.getByLabel('unseen')).toBeVisible();
  if (IS_WORKTREE) await expect(card.getByTestId('artifact-source')).toHaveText('main');
  await card.click();
  await expect(page).toHaveURL(new RegExp(`/api/artifact/${name}$`));
  await expect(page.getByText('plumb payload')).toBeVisible();
});

test('one row per name: the newest write wins, a stale copy never shadows it', async ({ request }) => {
  test.skip(!IS_WORKTREE, 'main checkout: one dir, nothing to shadow');
  const name = `e2e-plumb-dup-${Date.now().toString(36)}.html`;
  const now = Math.floor(Date.now() / 1000);
  // the hand-copy case: a local copy, then the original is rewritten
  await drop(LOCAL_DIR, name, 'stale local copy', now - 60);
  await drop(MAIN_DIR, name, 'fresh main original', now);
  let rows = (await list(request)).filter((e) => e.name === name);
  expect(rows).toHaveLength(1);
  expect(rows[0].source).toBe('main');
  let r = await request.get(`/api/artifact/${name}`);
  expect(r.headers()['x-artifact-source']).toBe('main');
  expect(await r.text()).toBe('fresh main original');
  // and back: a newer local write wins the same way — gallery and route agree
  await utimes(path.join(LOCAL_DIR, name), now + 60, now + 60);
  rows = (await list(request)).filter((e) => e.name === name);
  expect(rows).toHaveLength(1);
  expect(rows[0].source).toBe('local');
  r = await request.get(`/api/artifact/${name}`);
  expect(await r.text()).toBe('stale local copy');
});

test('built-ins: listed + tagged, reserved names, no-extension is 404 not 415', async ({ page, request }) => {
  const film = (await list(request)).find((e) => e.name === 'door-tree.html');
  expect(film?.source).toBe('builtin');
  // an agent dropping a newer same-named file can't swap the door's film
  await drop(LOCAL_DIR, 'door-tree.html', 'not the film', Math.floor(Date.now() / 1000) + 3600);
  const r = await request.get('/api/artifact/door-tree.html');
  expect(r.status()).toBe(200);
  expect(r.headers()['x-artifact-source']).toBe('builtin');
  expect(await r.text()).toBe(await readFile(path.join(BUILTIN_DIR, 'door-tree.html'), 'utf8'));
  // 10-24: /api/artifact/the-tree-film answered 415 — the name has no
  // extension and never existed; that is a not-found, with the real names
  const miss = await request.get('/api/artifact/the-tree-film');
  expect(miss.status()).toBe(404);
  expect((await miss.json()).error).toContain('door-tree.html');
  expect((await request.get('/api/artifact/x.exe')).status()).toBe(415);
  // the gallery shows the films with their tag
  await page.goto('/artifacts');
  const card = page.getByRole('button', { name: /^door-tree\.html$/ });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.getByTestId('artifact-source')).toHaveText('built-in');
});
