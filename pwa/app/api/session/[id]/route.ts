import { NextResponse } from 'next/server';
import { OC, ocFetch, resolveId } from '@/lib/oc';
import { slugify } from '@/lib/slug';
import { MAIN_SLUG } from '@/lib/tree-first';
import { bustCache } from '@/lib/oc-cache';

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

function normalize(s: any, variants: string[]) {
  const raw = s.model ? s.model.id || s.model.modelID : null;
  const { base, level } = raw ? splitThink(raw) : { base: null, level: null };
  return {
    id: s.id,
    title: s.title || s.id,
    agent: s.agent || null,
    model: raw
      ? {
          providerID: s.model.providerID,
          modelID: base,
          variant: level || null, // null = model default
          variants,
        }
      : null,
  };
}

/** Session summary — title + run config (agent / model / think level) that
 *  subsequent turns use, with the levels available for the model resolved. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const sid = await resolveId(id);
    const s = await ocFetch(`/session/${sid}`);
    const raw = s.model ? s.model.id || s.model.modelID : null;
    const { base } = raw ? splitThink(raw) : { base: null };
    const variants = base ? await thinkLevels(s.model!.providerID, base) : [];
    return NextResponse.json(normalize(s, variants));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
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
      await ocFetch(`/session/${sid}`, { method: 'PATCH', body: JSON.stringify({ title: t }) });
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
      await ocFetch(`/api/session/${sid}/model`, {
        method: 'POST',
        body: JSON.stringify({ model: { id: target, providerID: m.providerID } }),
      });
    }

    if (body.agent !== undefined) {
      if (!body.agent) return NextResponse.json({ error: 'empty agent' }, { status: 400 });
      await ocFetch(`/api/session/${sid}/agent`, {
        method: 'POST',
        body: JSON.stringify({ agent: String(body.agent) }),
      });
    }

    bustCache(); // home list reflects a rename on its next poll
    const s = await ocFetch(`/session/${sid}`);
    const raw = s.model ? s.model.id || s.model.modelID : null;
    const { base } = raw ? splitThink(raw) : { base: null };
    const variants = base ? await thinkLevels(s.model.providerID, base) : [];
    return NextResponse.json(normalize(s, variants));
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
    const r = await ocFetch(`/session/${sid}`, { method: 'DELETE' });
    bustCache(); // next list poll rebuilds instead of showing the deleted row
    return NextResponse.json(r ?? { ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
