import { NextResponse } from 'next/server';
import { OC, ocFetch, resolveId } from '@/lib/oc';
import { slugify } from '@/lib/slug';
import { MAIN_SLUG } from '@/lib/tree-first';
import { bustCache } from '@/lib/oc-cache';
import { brainDefault } from '@/lib/brain-default';
import { purgeQueue } from '@/lib/oc-queue';

export const dynamic = 'force-dynamic';

/** THE MAIN session (slug `main`) is reserved: no delete, no rename. */
async function isMain(idOrSlug: string, sid: string): Promise<boolean> {
  if (idOrSlug === MAIN_SLUG) return true;
  const s = (await ocFetch(`/session/${sid}`)) as { title?: string };
  return slugify(s.title || '') === MAIN_SLUG;
}

type ModelRef = { providerID: string; modelID: string; variant: string | null };

/** Think levels ride a naming convention on model IDs defined in
 *  opencode.json: `<modelID>-think-<level>` (config model carries
 *  options.reasoningEffort). Validated on the wire against a recording
 *  provider: v1.18's prompt API drops `variant` (body, session record and
 *  v2 prompt all fail), but the modelID — and its options — reach the
 *  provider call. So a level IS a model here. */
const THINK_RE = /^(.+)-think-([a-z]+)$/;

function splitThink(modelID: string) {
  const m = THINK_RE.exec(modelID);
  return m ? { base: m[1], level: m[2] } : { base: modelID, level: null };
}

/** Levels actually available for a model = derived models that exist in the
 *  provider config. Resolved server-side so the client can't drift. */
async function thinkLevels(providerID: string, modelID: string): Promise<string[]> {
  try {
    const r = await fetch(`${OC}/config/providers`, { cache: 'no-store' });
    if (!r.ok) return [];
    const d = await r.json();
    const p = (d.providers || []).find((x: { id: string }) => x.id === providerID);
    if (!p) return [];
    return Object.keys(p.models || {})
      .map((id) => splitThink(id))
      .filter((s) => s.base === modelID && s.level)
      .map((s) => s.level!);
  } catch {
    return [];
  }
}

/** A raw provider/model id (maybe a derived think model) → the settings
 *  shape: base model + level + the levels configured for it. */
async function modelRef(providerID: string, raw: string) {
  const { base, level } = splitThink(raw);
  return {
    providerID,
    modelID: base,
    variant: level || null, // null = model default
    variants: await thinkLevels(providerID, base),
  };
}

/** Session summary — title + run config (agent / model / think level) that
 *  subsequent turns use, with the levels available for the model resolved.
 *  No explicit model (never set — e.g. MAIN before any voice seed) → the
 *  session runs on the brain's default: reported as `defaultModel`, apart
 *  from `model`, so the page shows it AS the default; null = the brain
 *  didn't say (shown as unknown, never guessed). */
async function summary(s: any) {
  const raw = s.model ? s.model.id || s.model.modelID : null;
  const model = raw ? await modelRef(s.model.providerID, raw) : null;
  const d = model ? null : await brainDefault();
  return {
    id: s.id,
    title: s.title || s.id,
    agent: s.agent || null,
    model,
    defaultModel: d ? await modelRef(d.providerID, d.modelID) : null,
  };
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const sid = await resolveId(id);
    return NextResponse.json(await summary(await ocFetch(`/session/${sid}`)));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

/** One settings write upstream. A refusal (4xx — unknown agent/model, gone
 *  session) is an answer, not a crash: its status + the brain's own reason
 *  come back as the response, so the page says why instead of a bare
 *  'opencode 400 on …' 500. null = written. */
async function ocWrite(path: string, method: string, body: unknown) {
  const r = await fetch(`${OC}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  console.log(`[oc] ${method} ${path} → ${r.status}`);
  if (r.ok) return null;
  const d = await r.json().catch(() => ({}));
  const why = d.error || d.data?.message || d.message || `brain ${r.status} on ${path}`;
  return NextResponse.json({ error: String(why) }, { status: r.status < 500 ? r.status : 502 });
}

/** Settings writes. title → session PATCH; model+think → v2 model switch
 *  onto the derived think model (the only variant carrier that survives
 *  v1.18 runs — see splitThink); agent → v2 agent switch. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const sid = await resolveId(id);
    const body = await req.json();

    if (body.title !== undefined) {
      const t = String(body.title || '').trim().slice(0, 80);
      if (!t) return NextResponse.json({ error: 'empty title' }, { status: 400 });
      // MAIN keeps its name (the door finds it by slug) and nothing else takes it
      if ((await isMain(id, sid)) || slugify(t) === MAIN_SLUG) {
        return NextResponse.json({ error: 'MAIN is reserved — it keeps its name' }, { status: 409 });
      }
      const no = await ocWrite(`/session/${sid}`, 'PATCH', { title: t });
      if (no) return no;
    }

    if (body.model !== undefined) {
      const m = body.model as { providerID: string; modelID: string; variant?: string | null };
      if (!m?.providerID || !m?.modelID)
        return NextResponse.json({ error: 'model needs providerID + modelID' }, { status: 400 });
      const level = m.variant && m.variant !== 'default' ? m.variant : null;
      const target = level ? `${m.modelID}-think-${level}` : m.modelID;
      // the target must exist — never switch a session onto a dead modelID
      const r = await fetch(`${OC}/config/providers`, { cache: 'no-store' });
      const d = r.ok ? await r.json() : { providers: [] };
      const p = (d.providers || []).find((x: { id: string }) => x.id === m.providerID);
      if (!p?.models?.[target])
        return NextResponse.json(
          { error: `unknown model ${m.providerID}/${target}` },
          { status: 400 }
        );
      const no = await ocWrite(`/api/session/${sid}/model`, 'POST', {
        model: { id: target, providerID: m.providerID },
      });
      if (no) return no;
    }

    if (body.agent !== undefined) {
      if (!body.agent) return NextResponse.json({ error: 'empty agent' }, { status: 400 });
      const no = await ocWrite(`/api/session/${sid}/agent`, 'POST', { agent: String(body.agent) });
      if (no) return no;
    }

    bustCache(); // home list reflects a rename on its next poll
    return NextResponse.json(await summary(await ocFetch(`/session/${sid}`)));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const sid = await resolveId(id); // accepts slug or session id
    // belt and suspenders: the list never offers MAIN's delete, and the
    // proxy — the phone's only way to the brain — refuses it too
    if (await isMain(id, sid)) {
      return NextResponse.json({ error: 'MAIN is reserved — it cannot be deleted' }, { status: 403 });
    }
    // identity-pinned waits (herdr §1.4): the queue dies with its session —
    // nothing queued under it may ever be forwarded
    purgeQueue(sid);
    const r = await ocFetch(`/session/${sid}`, { method: 'DELETE' });
    bustCache(); // next list poll rebuilds instead of showing the deleted row
    return NextResponse.json(r ?? { ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
