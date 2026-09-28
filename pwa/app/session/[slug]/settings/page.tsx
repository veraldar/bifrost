'use client';

/** Session settings — NAME / MODEL / THINK / AGENT tiles over the yggdrasil
 *  backdrop (shared theme CSS: .oz + .oz-ygg-bg + oz tokens). Instant-apply:
 *  no save button, every control commits on tap/blur, like the header mode
 *  toggle. All writes go through PATCH /api/session/[id], which routes title
 *  to the session update and model/agent to opencode's v2 switch endpoints —
 *  server-side per-session state, so text AND voice turns both use it. The
 *  current think level is whatever the session records; 'default' means no
 *  explicit level set. Reaching this page: tap the session name in the chat
 *  header; leaving: system back gesture. */

import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { slugify } from '@/lib/slug';
import { ErrorBox } from '@/components/app/error-box';

type ModelRef = {
  providerID: string;
  modelID: string;
  variant: string | null;
  variants: string[];
};
type SessionInfo = { id: string; title: string; agent: string | null; model: ModelRef | null };
type ProviderRow = {
  id: string;
  name: string;
  models: { id: string; name: string; variants: string[] }[];
};

export default function SessionSettingsView() {
  const router = useRouter();
  const params = useParams<{ slug: string }>();
  const slug = params?.slug || '';
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [nameInput, setNameInput] = useState(slug);
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [agents, setAgents] = useState<string[]>([]);
  const [pickOpen, setPickOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');
  const [live, setLive] = useState(false);

  const title = info?.title || slug;

  // fresh state per slug (rename swaps the slug → refetch follows)
  useEffect(() => {
    setInfo(null);
    setNameInput(slug);
    setPickOpen(false);
  }, [slug]);

  const load = useCallback(async () => {
    if (!slug) return;
    try {
      const [sr, mr, ar] = await Promise.all([
        fetch(`/api/session/${slug}`, { cache: 'no-store' }),
        fetch('/api/models'),
        fetch('/api/agents'),
      ]);
      if (sr.ok) {
        const s = await sr.json();
        setInfo(s);
        // fill the name field only while it's still pristine — the fetch
        // must never clobber a value the user already started typing
        setNameInput((prev) => (prev === slug ? s.title || slug : prev));
      }
      if (mr.ok) setProviders(await mr.json());
      if (ar.ok) setAgents((await ar.json()).map((a: { name: string }) => a.name));
    } catch {
      /* transient — tiles render with what they have */
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  // busy dot — same live-run flag the chat header uses
  useEffect(() => {
    if (!slug) return;
    let stop = false;
    const poll = async () => {
      if (document.hidden) return;
      try {
        const r = await fetch(`/api/session/${slug}/messages?limit=1`, { cache: 'no-store' });
        if (r.ok && !stop) setLive(r.headers.get('X-Run-Live') === '1');
      } catch {
        /* transient */
      }
    };
    poll();
    const t = setInterval(poll, 2500);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [slug]);

  const model = info?.model ?? null;
  const agent = info?.agent ?? '';
  const modelKey = (m: ModelRef) => `${m.providerID}/${m.modelID}`;

  const shownVariant = model?.variant && model.variant !== 'default' ? model.variant : '';

  const modelList = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return providers
      .flatMap((p) => p.models.map((m) => ({ ...m, providerID: p.id })))
      .filter(
        (m) => !q || `${m.providerID}/${m.id} ${m.name}`.toLowerCase().includes(q)
      );
  }, [providers, filter]);

  const patch = useCallback(
    async (body: Record<string, unknown>) => {
      try {
        const r = await fetch(`/api/session/${slug}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        // the body can come back empty (proxy hiccup / service restart mid-
        // request) — parse defensively instead of dying on 'Unexpected end
        // of JSON input' (user hit this picking a model)
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `save failed (${r.status})`);
        if (!d.id) throw new Error(`save failed (${r.status}, empty response)`);
        setInfo(d);
        return d;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        void load();
        return null;
      }
    },
    [slug, load]
  );

  async function commitName() {
    const t = nameInput.trim();
    if (!t || t === title) {
      setNameInput(title);
      return;
    }
    const d = await patch({ title: t });
    if (d?.title) {
      setNameInput(d.title);
      // the URL IS the slug — follow the rename so sends/rooms keep matching
      router.replace(`/session/${slugify(d.title)}/settings`);
    }
  }

  return (
    <main className="oz">
      <div className="oz-ygg-bg" />
      <div className="relative z-10 mx-auto h-dvh max-w-md overflow-y-auto px-2.5">
        {/* header — same shape as the chat header; no back chrome */}
        <div className="flex items-center gap-2 py-3.5 text-sm">
          <span className="truncate">{title}</span>
          {live && <span className="oz-busy text-[11px] text-[var(--oz-active)]">●</span>}
        </div>

        {error && <ErrorBox error={error} onDismiss={() => setError('')} slug={slug} />}

        {/* NAME */}
        <section className="mb-3 rounded-2xl border border-[var(--oz-border)]/70 bg-[var(--oz-surface)] p-3.5">
          <h2 className="border-b border-[var(--oz-border)]/40 pb-2.5 px-0.5 text-[10.5px] font-bold uppercase tracking-[0.18em] text-[var(--oz-text)]">
            name
          </h2>
          <input
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
            aria-label="session name"
            className="mt-3 w-full rounded-lg border border-[var(--oz-border)] bg-[var(--oz-bg)] px-3 py-2 font-mono text-[13px] text-[var(--oz-success)] outline-none placeholder:text-[var(--oz-dim)]"
            style={{ caretColor: 'var(--oz-active)' }}
          />
          <p className="mt-2 text-[10.5px] leading-relaxed text-[var(--oz-dim)]">
            url + voice room follow the name
          </p>
        </section>

        {/* MODEL */}
        <section className="mb-3 rounded-2xl border border-[var(--oz-border)]/70 bg-[var(--oz-surface)] p-3.5">
          <h2 className="border-b border-[var(--oz-border)]/40 pb-2.5 px-0.5 text-[10.5px] font-bold uppercase tracking-[0.18em] text-[var(--oz-text)]">
            model
          </h2>
          <button
            aria-expanded={pickOpen}
            onClick={() => {
              setPickOpen((o) => !o);
              setFilter('');
            }}
            className="mt-3 flex w-full items-center justify-between gap-2 text-left"
          >
            <span className="truncate font-mono text-[13px] text-[var(--oz-success)]">
              {model ? modelKey(model) : 'tap to choose'}
            </span>
            <span className="text-xs text-[var(--oz-dim)]">{pickOpen ? '▲' : '›'}</span>
          </button>
          {pickOpen && (
            <div className="mt-2.5">
              <input
                autoFocus
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="/ filter…"
                aria-label="filter models"
                className="w-full rounded-lg border border-[var(--oz-border)] bg-[var(--oz-bg)] px-3 py-2 font-mono text-xs text-[var(--oz-success)] outline-none placeholder:text-[var(--oz-dim)]"
                style={{ caretColor: 'var(--oz-active)' }}
              />
              <ul className="mt-1.5 max-h-64 overflow-y-auto">
                {modelList.map((m) => {
                  const active = model && modelKey(model) === `${m.providerID}/${m.id}`;
                  return (
                    <li key={`${m.providerID}/${m.id}`}>
                      <button
                        onClick={() => {
                          // keep the chosen think level only if the new model
                          // has it too; otherwise fall to the model default
                          const keep = model?.variant && m.variants.includes(model.variant);
                          void patch({
                            model: {
                              providerID: m.providerID,
                              modelID: m.id,
                              variant: keep ? model!.variant : undefined,
                            },
                          });
                          setPickOpen(false);
                        }}
                        className={`flex w-full items-center gap-2 border-b border-[var(--oz-border)]/25 px-1 py-2 text-left font-mono text-xs last:border-b-0 ${
                          active ? 'text-[var(--oz-success)]' : 'text-[var(--oz-dim)]'
                        }`}
                      >
                        <span className="truncate">
                          {m.providerID}/{m.id}
                        </span>
                        {active && <span className="ml-auto text-[var(--oz-active)]">●</span>}
                      </button>
                    </li>
                  );
                })}
                {!modelList.length && (
                  <li className="px-1 py-2 text-[11px] text-[var(--oz-dim)]">no models</li>
                )}
              </ul>
            </div>
          )}
        </section>

        {/* THINK — the selected model's real levels; the session's current one
            is highlighted, tapping it again falls back to the model default */}
        <section className="mb-3 rounded-2xl border border-[var(--oz-border)]/70 bg-[var(--oz-surface)] p-3.5">
          <h2 className="border-b border-[var(--oz-border)]/40 pb-2.5 px-0.5 text-[10.5px] font-bold uppercase tracking-[0.18em] text-[var(--oz-text)]">
            think
          </h2>
          {model && model.variants.length ? (
            <>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {model.variants.map((v) => (
                  <button
                    key={v}
                    aria-pressed={shownVariant === v}
                    onClick={() =>
                      void patch({
                        model: {
                          providerID: model.providerID,
                          modelID: model.modelID,
                          variant: shownVariant === v ? undefined : v,
                        },
                      })
                    }
                    className={`rounded-md border px-2.5 py-1.5 font-mono text-[11px] tracking-wide ${
                      shownVariant === v
                        ? 'border-[var(--oz-success)]/45 text-[var(--oz-success)]'
                        : 'border-[var(--oz-border)] text-[var(--oz-dim)]'
                    }`}
                    style={
                      shownVariant === v
                        ? {
                            background:
                              'color-mix(in srgb, var(--oz-success) 12%, var(--oz-surface))',
                          }
                        : undefined
                    }
                  >
                    {v}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[10.5px] text-[var(--oz-dim)]">
                current — {shownVariant || 'model default'}
              </p>
            </>
          ) : (
            <p className="mt-3 text-[10.5px] leading-relaxed text-[var(--oz-dim)]">
              {model
                ? 'no think levels configured for this model'
                : 'pick a model to see its thinking levels'}
            </p>
          )}
        </section>

        {/* AGENT */}
        <section className="mb-3 rounded-2xl border border-[var(--oz-border)]/70 bg-[var(--oz-surface)] p-3.5">
          <h2 className="border-b border-[var(--oz-border)]/40 pb-2.5 px-0.5 text-[10.5px] font-bold uppercase tracking-[0.18em] text-[var(--oz-text)]">
            agent
          </h2>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {(agents.length ? agents : ['build', 'plan']).map((a) => (
              <button
                key={a}
                aria-pressed={agent === a}
                onClick={() => void patch({ agent: a })}
                className={`rounded-md border px-2.5 py-1.5 font-mono text-[11px] tracking-wide ${
                  agent === a
                    ? 'border-[var(--oz-success)]/45 text-[var(--oz-success)]'
                    : 'border-[var(--oz-border)] text-[var(--oz-dim)]'
                }`}
                style={
                  agent === a
                    ? { background: 'color-mix(in srgb, var(--oz-success) 12%, var(--oz-surface))' }
                    : undefined
                }
              >
                {a}
              </button>
            ))}
          </div>
        </section>

        <p className="px-1 pb-6 text-[10.5px] leading-relaxed text-[var(--oz-dim)]">
          changes apply from the next message in this session
        </p>
      </div>
    </main>
  );
}
