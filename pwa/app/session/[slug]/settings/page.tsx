'use client';

/** Session settings — name / model / think / agent blocks (shared theme
 *  CSS: .oz-blk + oz tokens). Instant-apply:
 *  no save button, every control commits on tap/blur, like the header mode
 *  toggle. All writes go through PATCH /api/session/[id], which routes title
 *  to the session update and model/agent to opencode's v2 switch endpoints —
 *  server-side per-session state, so text AND voice turns both use it. The
 *  current think level is whatever the session records; 'default' means no
 *  explicit level set. DELETE at the bottom removes the session (opencode
 *  cascades sub-sessions) and returns to the list. Reaching this page: tap
 *  the session name in the chat header; leaving: system back gesture. */

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
  const [loaded, setLoaded] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');
  const [live, setLive] = useState(false);
  // two-tap confirm: first tap arms, second deletes — no modal on mobile
  const [armed, setArmed] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const title = info?.title || slug;

  // fresh state per slug (rename swaps the slug → refetch follows)
  useEffect(() => {
    setInfo(null);
    setNameInput(slug);
    setPickOpen(false);
    setLoaded(false);
  }, [slug]);

  const load = useCallback(async () => {
    if (!slug) return;
    // independent settles, not Promise.all: one flaky fetch (phone on
    // tailnet, opencode busy with concurrent runs — 2026-09-29 net-fail
    // storm) must not blank the MODEL tile into 'tap to choose' when the
    // session record itself is fine
    const [sr, mr, ar] = await Promise.allSettled([
      fetch(`/api/session/${slug}`, { cache: 'no-store' }),
      fetch('/api/models'),
      fetch('/api/agents'),
    ]);
    if (sr.status === 'fulfilled' && sr.value.ok) {
      const s = await sr.value.json();
      setInfo(s);
      // fill the name field only while it's still pristine — the fetch
      // must never clobber a value the user already started typing
      setNameInput((prev) => (prev === slug ? s.title || slug : prev));
    }
    if (mr.status === 'fulfilled' && mr.value.ok) setProviders(await mr.value.json());
    if (ar.status === 'fulfilled' && ar.value.ok)
      setAgents((await ar.value.json()).map((a: { name: string }) => a.name));
    setLoaded(true);
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  // a failed first load self-heals: keep retrying until data landed
  useEffect(() => {
    if (loaded) return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [loaded, load]);

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

  async function deleteSession() {
    setDeleting(true);
    try {
      const r = await fetch(`/api/session/${slug}`, { method: 'DELETE' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `delete failed (${r.status})`);
      try {
        localStorage.removeItem('oz-draft:' + slug);
      } catch {
        /* private mode */
      }
      // prune the deleted family from the list seed so the home page renders
      // clean on arrival instead of flashing the dead row until its poll
      try {
        const arr = JSON.parse(sessionStorage.getItem('oz-sessions') || '[]');
        const doomed = new Set<string>(info?.id ? [info.id] : []);
        let grew = true;
        while (grew) {
          grew = false;
          for (const s of arr) {
            if (s.parentId && doomed.has(s.parentId) && !doomed.has(s.id)) {
              doomed.add(s.id);
              grew = true;
            }
          }
        }
        sessionStorage.setItem(
          'oz-sessions',
          JSON.stringify(arr.filter((s: { id: string }) => !doomed.has(s.id)))
        );
      } catch {
        /* no seed — the list fetches fresh anyway */
      }
      router.push('/');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDeleting(false);
      setArmed(false);
    }
  }

  return (
    <main className="mx-auto h-dvh max-w-md overflow-y-auto px-3">
      {/* header — same shape as the chat header; no back chrome */}
      <header className="oz-head justify-start text-[13px]">
        <span className="truncate">{title}</span>
        {live && (
          <span className="oz-breathe text-[11px] text-[var(--oz-success)]" aria-label="working">
            ●
          </span>
        )}
      </header>

      {error && <ErrorBox error={error} onDismiss={() => setError('')} slug={slug} />}

      <section className="oz-blk">
        <h2>name</h2>
        <div>
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
            className="oz-field"
          />
        </div>
        <p className="note">url + voice room follow the name</p>
      </section>

      <section className="oz-blk">
        <h2>model</h2>
        <div>
          <button
            aria-expanded={pickOpen}
            onClick={() => {
              setPickOpen((o) => !o);
              setFilter('');
            }}
            className="oz-pick"
          >
            <span className="truncate">
              {model ? modelKey(model) : loaded ? 'tap to choose' : 'loading…'}
            </span>
            <span>{pickOpen ? '▲' : '›'}</span>
          </button>
        </div>
        {pickOpen && (
          <div className="pt-0">
            <input
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="/ filter…"
              aria-label="filter models"
              className="oz-field h-9 text-xs"
            />
            <ul className="oz-mlist mt-1.5 max-h-64 overflow-y-auto">
              {modelList.map((m) => {
                const active = !!model && modelKey(model) === `${m.providerID}/${m.id}`;
                return (
                  <li key={`${m.providerID}/${m.id}`}>
                    <button
                      aria-pressed={active}
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
                    >
                      <span className="truncate">
                        {m.providerID}/{m.id}
                      </span>
                    </button>
                  </li>
                );
              })}
              {!modelList.length && (
                <li className="px-0.5 py-2 text-[11px] text-[var(--oz-dim)]">no models</li>
              )}
            </ul>
          </div>
        )}
      </section>

      {/* THINK — the selected model's real levels; the session's current one
          is highlighted, tapping it again falls back to the model default */}
      <section className="oz-blk">
        <h2>think</h2>
        {model && model.variants.length ? (
          <>
            <div className="oz-chips">
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
                >
                  {v}
                </button>
              ))}
            </div>
            <p className="note">current — {shownVariant || 'model default'}</p>
          </>
        ) : (
          <p className="note pt-3!">
            {model
              ? 'no think levels configured for this model'
              : 'pick a model to see its thinking levels'}
          </p>
        )}
      </section>

      <section className="oz-blk">
        <h2>agent</h2>
        <div className="oz-chips">
          {(agents.length ? agents : ['build', 'plan']).map((a) => (
            <button key={a} aria-pressed={agent === a} onClick={() => void patch({ agent: a })}>
              {a}
            </button>
          ))}
        </div>
      </section>

      <p className="px-0.5 pb-2.5 text-[10.5px] leading-relaxed text-[var(--oz-dim)]">
        changes apply from the next message in this session
      </p>

      {/* DELETE — two taps; sub-sessions cascade server-side, then back to
          the list (which no longer shows the deleted row) */}
      <section className="oz-blk danger mb-6">
        <h2>session</h2>
        <div>
          <button
            disabled={deleting}
            onClick={() => (armed ? void deleteSession() : setArmed(true))}
            className={`oz-del ${armed ? 'armed' : ''}`}
          >
            {deleting ? 'deleting…' : armed ? 'tap again to delete' : 'delete session'}
          </button>
        </div>
        <p className="note">
          {armed ? 'this cannot be undone — sub-sessions go too' : 'removes the session and its sub-sessions'}
        </p>
      </section>
    </main>
  );
}
