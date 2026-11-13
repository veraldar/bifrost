/**
 * The door (v2, scripted — no brain before MAIN):
 *   GET  /api/onboard                     → BoxInfo: the brain this computer runs
 *        (model + cloud/local + who runs it — shown at the door, never asked:
 *        nothing on the phone can change it) and the address a phone opens
 *        (the pair QR)
 *   POST /api/onboard {step:'main', prefs?} → {id, title, slug:'main', created}
 *        THE MAIN session (created once, reused after). With prefs, MAIN gets
 *        them as its standing instruction — only when they differ from the
 *        last one it holds (read back from MAIN itself, so a restart or a
 *        second device never seeds twice). The door sends this at the style
 *        pick, so the brain's one-line ack is done before the first voice turn.
 */
import { NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import presets from '@/lib/brain-presets.json';
import { ocFetch } from '@/lib/oc';
import { bustCache } from '@/lib/oc-cache';
import { forward } from '@/lib/oc-forward';
import { bustTranscript } from '@/lib/oc-transcript';
import { ensureWatchdog } from '@/lib/oc-watchdog';
import { slugify } from '@/lib/slug';
import {
  type BoxInfo,
  type BrainClass,
  type DoorPrefs,
  MAIN_SLUG,
  MAIN_TITLE,
  PREFS_HEAD,
  mainPreamble,
} from '@/lib/tree-first';

export const dynamic = 'force-dynamic';

/** v1 debris: the LLM onboarding left an `onboarding-*` session per attempt
 *  (22 in one day). v2 creates none; the old ones older than an hour go. MAIN
 *  is never touched (the brain refuses deletes for it anyway). */
async function sweepStaleOnboardings(): Promise<void> {
  try {
    const sessions = (await ocFetch('/session')) as {
      id: string;
      title?: string;
      time?: { created?: number };
    }[];
    const cutoff = Date.now() - 3_600_000;
    for (const s of sessions) {
      if (!(s.title || '').startsWith('onboarding-') || (s.time?.created || 0) >= cutoff) continue;
      await ocFetch(`/session/${s.id}`, { method: 'DELETE' } as RequestInit).catch(() => {});
    }
  } catch {
    /* best-effort */
  }
}

type Sess = { id: string; title?: string };

// one MAIN, ever: concurrent calls (two tabs, a double tap) share one create
const g = globalThis as typeof globalThis & {
  __tfMain?: Promise<Sess & { created: boolean }> | null;
};

function ensureMain(): Promise<Sess & { created: boolean }> {
  return (g.__tfMain ??= (async () => {
    const list = (await ocFetch('/session')) as Sess[];
    const hit = list.find((s) => slugify(s.title || '') === MAIN_SLUG);
    if (hit) return { ...hit, created: false };
    const s = (await ocFetch('/session', {
      method: 'POST',
      body: JSON.stringify({ title: MAIN_TITLE }),
    })) as Sess;
    bustCache();
    return { ...s, created: true };
  })().finally(() => {
    g.__tfMain = null;
  }));
}

/** the standing preferences MAIN holds now (its last preamble), '' if none */
async function heldPreamble(id: string): Promise<string> {
  try {
    const msgs = (await ocFetch(`/session/${id}/message`)) as {
      info?: { role?: string };
      parts?: { type: string; text?: string }[];
    }[];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.info?.role !== 'user') continue;
      const text = (m.parts || [])
        .filter((p) => p.type === 'text')
        .map((p) => p.text || '')
        .join('\n')
        .trim();
      if (text.startsWith(PREFS_HEAD)) return text;
    }
  } catch {
    /* unknown → seed (a duplicate ack beats a lost preference) */
  }
  return '';
}

/** the address yggdrasil thinks through (YGG_UPSTREAM_BASE_URL): told
 *  (BIFROST_BRAIN_URL), else read from yggdrasil's own env file — only that
 *  line is kept; the key in the same file never leaves this function */
function upstreamUrl(): string {
  if (process.env.BIFROST_BRAIN_URL) return process.env.BIFROST_BRAIN_URL;
  const file = process.env.YGG_ENV_FILE || path.join(homedir(), '.config/yggdrasil/yggdrasil.env');
  try {
    const m = /^YGG_UPSTREAM_BASE_URL=(.*)$/m.exec(readFileSync(file, 'utf8'));
    return (m?.[1] || '').trim().replace(/^["']|["']$/g, '');
  } catch {
    return '';
  }
}

/** your own machines: loopback, the LAN, the tailnet (100.64/10, *.ts.net) */
const LOCAL_HOST =
  /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|\[?::1\]?$|.*\.(local|ts\.net)$)/;

/** cloud unless the computer says otherwise: the honest default never claims
 *  "nothing leaves your home" for a brain it can't see */
function brainOf(model: string): { class: BrainClass; provider: string } {
  let host = '';
  try {
    host = new URL(upstreamUrl()).hostname;
  } catch {
    /* not known here */
  }
  const set = process.env.BIFROST_BRAIN_CLASS; // v2 values plan/router = a cloud
  const local =
    set === 'local' ||
    (!set && host !== '' && LOCAL_HOST.test(host)) ||
    (!set && /^(ollama|lmstudio|llama\.cpp|local)\b/i.test(model));
  const known = presets.presets.find((p) => (p.hosts as string[]).includes(host));
  const provider =
    process.env.BIFROST_BRAIN_PROVIDER ||
    (local
      ? 'your computer'
      : known?.name || host || (/openrouter/i.test(model) ? 'openrouter' : ''));
  return { class: local ? 'local' : 'cloud', provider };
}

export async function GET() {
  let model = '';
  try {
    const d = (await ocFetch('/config/providers')) as {
      default?: Record<string, string>;
      providers?: { id: string }[];
    };
    const [prov, id] = Object.entries(d.default || {})[0] || [];
    model = id ? (prov && prov !== 'yggdrasil' ? `${prov}/${id}` : id) : '';
  } catch {
    return NextResponse.json({ error: 'brain unreachable' }, { status: 502 });
  }
  const info: BoxInfo = {
    brain: {
      model: model || 'unknown',
      ...brainOf(model),
      where: process.env.BIFROST_BRAIN_WHERE || 'set on your computer',
    },
    publicUrl: process.env.BIFROST_PUBLIC_URL || '',
  };
  return NextResponse.json(info, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: Request) {
  try {
    ensureWatchdog();
    const body = (await req.json().catch(() => ({}))) as { step?: string; prefs?: DoorPrefs };
    if (body.step !== 'main') {
      return NextResponse.json({ error: 'step must be main' }, { status: 400 });
    }
    const main = await ensureMain();
    void sweepStaleOnboardings();
    const p = body.prefs;
    let seeded = false;
    if (
      p &&
      (p.lang === 'en' || p.lang === 'fr') &&
      (p.style === 'short' || p.style === 'detail')
    ) {
      const text = mainPreamble({ lang: p.lang, style: p.style });
      if ((await heldPreamble(main.id)) !== text) {
        forward(main.id, MAIN_SLUG, { text });
        bustTranscript(main.id);
        seeded = true;
      }
    }
    bustCache();
    return NextResponse.json({
      id: main.id,
      title: main.title || MAIN_TITLE,
      slug: MAIN_SLUG,
      created: main.created,
      seeded,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
