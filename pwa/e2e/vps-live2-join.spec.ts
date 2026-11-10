import { expect, test } from '@playwright/test';
import * as fs from 'fs';
test('off-LAN join: pair-token → bridge data channel → RTT', async ({ page }) => {
  const token = fs.readFileSync('/tmp/dtok.txt', 'utf8').trim();
  await page.goto(`/bridge?t=${token}&b=https://179-237-67-146.nip.io`);
  const t0 = Date.now();
  await page.getByTestId('bridge-connect').click();
  await expect(page.getByTestId('bridge-state')).toContainText('connected', { timeout: 60_000 });
  const ms = Date.now() - t0;
  const log = await page.getByTestId('bridge-log').innerText().catch(() => '');
  const rtt = log.match(/RTT ~(\d+)ms/)?.[1] ?? 'n/a';
  console.log(`JOIN-OK connect_ms=${ms} rtt_ms=${rtt}`);
  fs.writeFileSync('/tmp/join-result.txt', `connect_ms=${ms} rtt_ms=${rtt}\n`);
});
