#!/usr/bin/env node
// phone-shot.mjs — LOOK at the phone before answering (S6, v07-reflection-and-plan F5).
// Pixel-class device (412x915 @2.625, touch, mobile UA) → one png per state in artifacts/.
//   door      a fresh device: nothing in localStorage, the tree alone
//   front     a returning device (door walked, first voice turn done): the roots / front page
//   main      /session/main as that returning device
//   settings  /settings
//
// Usage: node scripts/phone-shot.mjs [--url http://127.0.0.1:8090] [--states door,front,main,settings]
//                                    [--out artifacts] [--tag name] [--wait ms]
//   --url   any running build; default $PHONE_SHOT_URL or http://127.0.0.1:8090 (the sandbox).
//           Point it at a scratch build's own port — it only reads, never touches live.
//   --tag   filename infix → artifacts/phone-<tag>-<state>.png (default: the build's BUILD_ID)
// Prints one `![state](/api/artifact/…png)` line per shot — paste straight into the reply.
// Needs @playwright/test from pwa/node_modules. Jitless boxes: PW_JITLESS=1.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium, devices } = createRequire(join(ROOT, 'pwa', 'package.json'))('@playwright/test');

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i];
  if (!k.startsWith('--') || process.argv[i + 1] === undefined) {
    console.error(`phone-shot: bad arg ${k}\nusage: see header of scripts/phone-shot.mjs`);
    process.exit(2);
  }
  args.set(k.slice(2), process.argv[i + 1]);
}
const base = (args.get('url') ?? process.env.PHONE_SHOT_URL ?? 'http://127.0.0.1:8090').replace(/\/$/, '');
if (/:(8080|4096)(\/|$)/.test(base)) {
  console.error('phone-shot: refusing :8080/:4096 — that is live; shoot a scratch or sandbox build');
  process.exit(2);
}
const out = resolve(ROOT, args.get('out') ?? 'artifacts');
const settle = Number(args.get('wait') ?? 1500);
const ALL = ['door', 'front', 'main', 'settings'];
const states = (args.get('states') ?? ALL.join(',')).split(',').filter(Boolean);
for (const s of states) if (!ALL.includes(s)) {
  console.error(`phone-shot: unknown state ${s} (have ${ALL.join(', ')})`);
  process.exit(2);
}

// Pixel 7 class; devices[] has no Pixel 7 in every playwright version, so spell it out
const pixel = {
  ...(devices['Pixel 7'] ?? devices['Pixel 5'] ?? {}),
  viewport: { width: 412, height: 915 },
  deviceScaleFactor: 2.625,
  isMobile: true,
  hasTouch: true,
};

// what a device that walked the door carries (lib/tree-first.ts keys)
const RETURNING = {
  'bifrost-door': 'v2',
  'bifrost-first-turn': '1',
  'oz-read-init': '1',
  'bifrost-roots-held': '1',
};

let buildId = args.get('tag');
if (!buildId) {
  try {
    const html = await (await fetch(base + '/')).text();
    buildId = html.match(/<!--([A-Za-z0-9_-]{15,25})-->/)?.[1]?.slice(0, 8);
  } catch {
    /* unreachable — the launch below reports it */
  }
}
const tag = buildId ?? 'build';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  args: process.env.PW_JITLESS ? ['--js-flags=--jitless'] : [],
});
let failed = 0;
for (const state of states) {
  const ctx = await browser.newContext({ ...pixel, baseURL: base });
  try {
    if (state !== 'door') {
      await ctx.addInitScript((kv) => {
        for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v);
      }, RETURNING);
    }
    const page = await ctx.newPage();
    const path = { door: '/', front: '/', main: '/session/main', settings: '/settings' }[state];
    await page.goto(path, { waitUntil: 'load', timeout: 30_000 });
    await page.waitForTimeout(settle);
    const name = `phone-${tag}-${state}.png`;
    await page.screenshot({ path: join(out, name) });
    console.log(`![${state}](/api/artifact/${name})`);
  } catch (e) {
    failed++;
    console.error(`phone-shot: ${state} FAILED — ${String(e.message).split('\n')[0]}`);
  } finally {
    await ctx.close();
  }
}
await browser.close();
process.exit(failed ? 1 : 0);
