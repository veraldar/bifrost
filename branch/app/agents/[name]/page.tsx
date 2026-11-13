'use client';

/** /agents/[name] — one agent, edited. Only what the brain says is
 *  `customizable` shows; a `locked` field shows disabled with the reason.
 *  Root agents: description, model + thinking, instructions, tools, steps,
 *  manages sessions. Harness agents (Claude Code / opencode / Codex): less —
 *  the harness brings its own tools. Save = PUT (creates a new one); the
 *  brain's refusal is said inline. A custom agent deletes in two taps. */
import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { LineIcon } from '@/components/line-icon';
import { type AgentDetail, CUSTOMIZABLE, HARNESSES, TOOLS, harnessLabel } from '@/lib/agents';

type Draft = Pick<
  AgentDetail,
  'description' | 'harness' | 'model' | 'variant' | 'prompt' | 'steps' | 'sessions' | 'tools'
>;
const FIELDS = ['description', 'model', 'variant', 'prompt', 'tools', 'steps', 'sessions'] as const;

const draftOf = (d: AgentDetail): Draft => ({
  description: d.description || '',
  harness: d.harness || 'root',
  model: d.model,
  variant: d.variant,
  prompt: d.prompt || '',
  steps: d.steps,
  sessions: d.sessions,
  tools: { ...d.tools },
});

export default function AgentEditor() {
  const router = useRouter();
  const name = useParams<{ name: string }>()?.name || '';
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [models, setModels] = useState<string[]>([]);
  // every harness's own model list (the brain reads them: claude's aliases, `opencode models`…)
  const [byHarness, setByHarness] = useState<Record<string, string[]>>({});
  const [labels, setLabels] = useState<Record<string, Record<string, string>>>({});
  const [isNew, setIsNew] = useState(false);
  const [err, setErr] = useState('');
  const [refused, setRefused] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!name) return;
    let stop = false;
    (async () => {
      const r = await fetch(`/api/agents/${name}`, { cache: 'no-store' }).catch(() => null);
      const d = await r?.json().catch(() => null);
      if (stop) return;
      if (r?.ok && d) {
        setDetail(d);
        setDraft(draftOf(d));
        setModels(d.models || []);
        setByHarness(d.models_by_harness || {});
        setLabels(d.model_labels || {});
        return;
      }
      // a name no agent has yet, opened from '+ new agent': an empty root agent
      if (new URLSearchParams(location.search).get('new') === '1') {
        const b = await fetch('/api/agents/build', { cache: 'no-store' })
          .then((x) => (x.ok ? x.json() : null))
          .catch(() => null);
        if (stop) return;
        const served: string[] = b?.models || [];
        setModels(served);
        setByHarness(b?.models_by_harness || {});
        setLabels(b?.model_labels || {});
        setIsNew(true);
        setDraft({
          description: '',
          harness: 'root',
          model: served[0] || null,
          variant: null,
          prompt: '',
          steps: null,
          sessions: false,
          tools: Object.fromEntries(TOOLS.map((t) => [t, t === 'read'])),
        });
      } else setErr(d?.error || `couldn't load ${name}`);
    })();
    return () => {
      stop = true;
    };
  }, [name]);

  const h = draft?.harness || 'root';
  const custom = detail && !isNew ? detail.customizable : CUSTOMIZABLE[h] || [];
  const locked = detail?.locked || [];
  const shows = (f: string) => custom.includes(f) || locked.includes(f);
  const can = (f: string) => custom.includes(f) && !locked.includes(f);
  const lockNote = (f: string) => (
    <p className="note" data-testid={`locked-${f}`}>
      locked — {name === 'coordinator' ? "MAIN's coordinator keeps its" : 'this agent keeps its'}{' '}
      {f === 'sessions' ? 'session management' : f}
    </p>
  );
  const set = (p: Partial<Draft>) => {
    setDraft((d) => (d ? { ...d, ...p } : d));
    setSaved(false);
    setRefused('');
  };

  async function save() {
    if (!draft) return;
    const body: Record<string, unknown> = isNew ? { harness: draft.harness } : {};
    for (const f of FIELDS) {
      if (!can(f)) continue;
      const v = draft[f];
      if (f === 'steps' && v === null) continue;
      if (isNew || JSON.stringify(v) !== JSON.stringify(detail ? draftOf(detail)[f] : undefined))
        body[f] = v;
    }
    setSaving(true);
    try {
      const r = await fetch(`/api/agents/${name}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setRefused(d.error || `save failed (${r.status})`);
        return;
      }
      setDetail(d);
      setDraft(draftOf(d));
      setModels(d.models || models);
      setSaved(true);
      if (isNew) {
        setIsNew(false);
        router.replace(`/agents/${name}`);
      }
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    const r = await fetch(`/api/agents/${name}`, { method: 'DELETE' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      setRefused(d.error || `delete failed (${r.status})`);
      setArmed(false);
      return;
    }
    router.push('/agents');
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-3 pb-6">
      <header className="oz-head justify-start gap-2.5">
        <button onClick={() => router.back()} className="oz-k sm">
          <LineIcon name="back" size={13} /> back
        </button>
        <span className="truncate text-[13px]">{name}</span>
        {isNew && <span className="text-[11px] text-[var(--oz-dim)]">new</span>}
      </header>

      {!draft ? (
        <p className="pt-6 text-center text-xs text-[var(--oz-dim)]">{err || 'loading…'}</p>
      ) : (
        <>
          <section className="oz-blk">
            <h2>runs on</h2>
            <div className="oz-chips">
              {HARNESSES.map((x) => (
                <button
                  key={x}
                  aria-pressed={h === x}
                  disabled={!isNew}
                  onClick={() =>
                    set({
                      harness: x,
                      model: (x === 'root' ? models : byHarness[x] || [])[0] || null,
                    })
                  }
                  className="disabled:opacity-60"
                >
                  {harnessLabel(x)}
                </button>
              ))}
            </div>
            {locked.includes('harness') ? (
              lockNote('harness')
            ) : (
              <p className="note">
                {isNew
                  ? 'the root: yours to shape. a harness brings its own tools — less to set here'
                  : `set when the agent was made${detail?.builtin ? ' · built in' : ''}`}
              </p>
            )}
          </section>

          {shows('description') && (
            <section className="oz-blk">
              <h2>description</h2>
              <div>
                <input
                  value={draft.description}
                  disabled={!can('description')}
                  onChange={(e) => set({ description: e.target.value })}
                  aria-label="description"
                  placeholder="what this agent is for"
                  className="oz-field"
                />
              </div>
            </section>
          )}

          {shows('model') && (
            <section className="oz-blk">
              <h2>model</h2>
              {(() => {
                // a picker, never free text: the models this harness actually offers
                const list = h === 'root' ? models : byHarness[h] || models;
                const cur = draft.model || 'default';
                return list.length <= 8 ? (
                  <div className="oz-chips">
                    {list.map((m) => (
                      <button
                        key={m}
                        aria-pressed={cur === m}
                        disabled={!can('model')}
                        onClick={() => set({ model: m === 'default' ? null : m })}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div>
                    <select
                      value={list.includes(cur) ? cur : ''}
                      disabled={!can('model')}
                      onChange={(e) =>
                        set({ model: e.target.value === 'default' ? null : e.target.value || null })
                      }
                      aria-label="model"
                      className="oz-field"
                    >
                      {!list.includes(cur) && <option value="">{cur}</option>}
                      {/* opencode ids are provider/model: grouped by provider */}
                      {Object.entries(
                        list.reduce<Record<string, string[]>>((g, m) => {
                          const k = m.includes('/') ? m.split('/')[0] : '';
                          (g[k] ||= []).push(m);
                          return g;
                        }, {})
                      ).map(([g, ms]) => {
                        const opts = ms.map((m) => (
                          <option key={m} value={m}>
                            {g ? m.slice(g.length + 1) : m}
                            {labels[h]?.[m] ? ` — ${labels[h][m]}` : ''}
                          </option>
                        ));
                        return g ? (
                          <optgroup key={g} label={g}>
                            {opts}
                          </optgroup>
                        ) : (
                          opts
                        );
                      })}
                    </select>
                  </div>
                );
              })()}
              {shows('variant') && (
                <>
                  <div className="oz-chips pt-0">
                    {['high', 'low', 'off'].map((v) => (
                      <button
                        key={v}
                        aria-pressed={draft.variant === v}
                        disabled={!can('variant')}
                        onClick={() => set({ variant: draft.variant === v ? null : v })}
                      >
                        think {v}
                      </button>
                    ))}
                  </div>
                  <p className="note">thinking — {draft.variant || 'model default'}</p>
                </>
              )}
              {h !== 'root' && (
                <p className="note">
                  {labels[h]?.[draft.model || ''] ||
                    `the models ${harnessLabel(h)} offers on this root`}
                  {h === 'codex' &&
                    (byHarness.codex || []).length <= 1 &&
                    ' · run `codex login` to list its models'}
                </p>
              )}
            </section>
          )}

          {shows('prompt') && (
            <section className="oz-blk">
              <h2>{h === 'claude' ? 'extra instructions' : 'system prompt'}</h2>
              <div>
                <textarea
                  value={draft.prompt || ''}
                  disabled={!can('prompt')}
                  onChange={(e) => set({ prompt: e.target.value })}
                  aria-label={h === 'claude' ? 'extra instructions' : 'system prompt'}
                  rows={6}
                  className="oz-field h-auto py-2 text-[12px] leading-relaxed"
                />
              </div>
              <p className="note">
                every agent first reads the shared prompt (agents page) — all of it below
              </p>
              {(() => {
                // everything the model reads, as saved: the entry for this agent's own model
                const sys = detail?.system || [];
                const reads = sys.find((t) => t.models.includes(draft.model || '')) || sys[0];
                return (
                  reads && (
                    <details className="px-3 pb-2">
                      <summary className="cursor-pointer text-[11px] text-[var(--oz-dim)]">
                        everything the model reads — as saved
                      </summary>
                      <pre
                        data-testid="system-full"
                        className="mt-2 max-h-[60vh] overflow-auto text-[11px] leading-relaxed whitespace-pre-wrap"
                      >
                        {reads.text}
                      </pre>
                    </details>
                  )
                );
              })()}
            </section>
          )}

          {shows('tools') && (
            <section className="oz-blk">
              <h2>tools</h2>
              <div className="oz-chips">
                {TOOLS.map((t) => (
                  <button
                    key={t}
                    aria-pressed={!!draft.tools[t]}
                    disabled={!can('tools')}
                    onClick={() => set({ tools: { ...draft.tools, [t]: !draft.tools[t] } })}
                  >
                    {t}
                  </button>
                ))}
              </div>
              {locked.includes('tools') && lockNote('tools')}
              {detail?.rules && (
                <details className="note">
                  <summary>
                    custom rules ({detail.rules.length}) — toggling a tool replaces them
                  </summary>
                  <ul className="mt-1">
                    {detail.rules.map((r, i) => (
                      <li key={i}>
                        {r.action} {r.permission} {r.pattern}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {shows('sessions') && (
                <div className="oz-chips pt-0">
                  <button
                    aria-pressed={draft.sessions}
                    disabled={!can('sessions')}
                    onClick={() => set({ sessions: !draft.sessions })}
                  >
                    manages sessions
                  </button>
                </div>
              )}
              {locked.includes('sessions') && lockNote('sessions')}
              {shows('steps') && (
                <div className="flex items-center gap-2 pt-0">
                  <input
                    type="number"
                    min={1}
                    value={draft.steps ?? ''}
                    disabled={!can('steps')}
                    onChange={(e) => set({ steps: e.target.value ? Number(e.target.value) : null })}
                    aria-label="steps"
                    placeholder="default"
                    className="oz-field w-28"
                  />
                  <span className="text-[11px] text-[var(--oz-dim)]">steps per turn</span>
                </div>
              )}
            </section>
          )}

          <div className="mb-2.5 flex flex-col gap-1.5">
            <button onClick={() => void save()} disabled={saving} className="oz-k ok h-10 w-full">
              {saving ? 'saving…' : isNew ? 'create agent' : 'save'}
            </button>
            {refused && (
              <p role="alert" className="text-[11px] text-[var(--oz-danger)]">
                {refused}
              </p>
            )}
            {saved && <p className="text-[11px] text-[var(--oz-success)]">saved</p>}
          </div>

          {detail && !detail.builtin && !isNew && (
            <section className="oz-blk danger">
              <h2>agent</h2>
              <div>
                <button
                  onClick={() => (armed ? void remove() : setArmed(true))}
                  className={`oz-del ${armed ? 'armed' : ''}`}
                >
                  {armed ? 'tap again to delete' : 'delete agent'}
                </button>
              </div>
              <p className="note">
                {armed ? 'this cannot be undone' : 'removes this agent from the root'}
              </p>
            </section>
          )}
        </>
      )}
    </main>
  );
}
