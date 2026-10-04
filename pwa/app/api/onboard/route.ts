/**
 * Tree-first onboarding (sandbox):
 *   POST /api/onboard {step:'start'}               → {id, title, slug} — a fresh
 *        onboarding session; the onboarding prompt rides as its first message
 *        (yggdrasil sessions carry no system prompt), fired async so the
 *        brain's greeting lands while the phone joins the voice room
 *   POST /api/onboard {step:'done', from, prefs}   → {id, title, slug:'main'} —
 *        THE MAIN session (created once, reused after), seeded with the
 *        confirmed preferences
 */
import { NextResponse } from 'next/server';
import { ocFetch } from '@/lib/oc';
import { bustCache } from '@/lib/oc-cache';
import { forward } from '@/lib/oc-forward';
import { bustTranscript } from '@/lib/oc-transcript';
import { ensureWatchdog } from '@/lib/oc-watchdog';
import { slugify } from '@/lib/slug';
import {
  MAIN_SLUG,
  MAIN_TITLE,
  ONBOARDING_PROMPT,
  ONBOARD_PREFIX,
  type OnboardPrefs,
  isOnboardingSlug,
  mainPreamble,
} from '@/lib/tree-first';

export const dynamic = 'force-dynamic';

type Sess = { id: string; title?: string };

// one MAIN, ever: concurrent completions (two tabs, a double poll) share the
// same in-flight create; finished onboardings never seed MAIN twice
const g = globalThis as typeof globalThis & {
  __tfMain?: Promise<Sess> | null;
  __tfSeeded?: Set<string>;
};
const seeded = (g.__tfSeeded ??= new Set());

async function findMain(): Promise<Sess | undefined> {
  const list = (await ocFetch('/session')) as Sess[];
  return list.find((s) => slugify(s.title || '') === MAIN_SLUG);
}

function ensureMain(): Promise<Sess & { created: boolean }> {
  const p = (g.__tfMain ??= (async () => {
    const hit = await findMain();
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
  return p as Promise<Sess & { created: boolean }>;
}

export async function POST(req: Request) {
  try {
    ensureWatchdog();
    const body = (await req.json().catch(() => ({}))) as {
      step?: string;
      from?: string;
      prefs?: OnboardPrefs;
    };

    if (body.step === 'start') {
      const title = `${ONBOARD_PREFIX}-${Date.now().toString(36)}`;
      const s = (await ocFetch('/session', {
        method: 'POST',
        body: JSON.stringify({ title }),
      })) as Sess;
      forward(s.id, slugify(title), { text: ONBOARDING_PROMPT });
      bustCache();
      bustTranscript(s.id);
      return NextResponse.json({ id: s.id, title, slug: slugify(title) });
    }

    if (body.step === 'done') {
      const from = String(body.from || '');
      if (!isOnboardingSlug(from)) {
        return NextResponse.json({ error: 'not an onboarding session' }, { status: 400 });
      }
      const main = await ensureMain();
      if (body.prefs && !seeded.has(from)) {
        seeded.add(from);
        forward(main.id, MAIN_SLUG, { text: mainPreamble(body.prefs) });
        bustTranscript(main.id);
      }
      bustCache();
      return NextResponse.json({
        id: main.id,
        title: main.title || MAIN_TITLE,
        slug: MAIN_SLUG,
        created: main.created,
      });
    }

    return NextResponse.json({ error: 'step must be start | done' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
