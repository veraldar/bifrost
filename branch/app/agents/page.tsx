'use client';

/** /agents — the root's agents: name, where it runs (the root, or a harness:
 *  Claude Code / opencode / Codex), its model, what it is for. A row opens
 *  its editor (/agents/[name]); '+ new agent' names one and opens it empty.
 *  Reached from MAIN's settings ('agents ›') and the app settings. */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LineIcon } from '@/components/line-icon';
import { type AgentRow, harnessLabel } from '@/lib/agents';

export default function AgentsPage() {
  const router = useRouter();
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [err, setErr] = useState('');
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');

  // retry until the list lands — a flaky fetch must not read as "no agents"
  useEffect(() => {
    if (agents) return;
    let stop = false;
    const load = () =>
      fetch('/api/agents', { cache: 'no-store' })
        .then(async (r) => {
          const d = await r.json().catch(() => null);
          if (stop) return;
          if (r.ok && Array.isArray(d)) setAgents(d);
          else setErr(d?.error || `HTTP ${r.status}`);
        })
        .catch((e) => !stop && setErr(String(e)));
    void load();
    const t = setInterval(() => !document.hidden && void load(), 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [agents]);

  const ok = /^[A-Za-z0-9_-]+$/.test(name.trim());
  const create = () => {
    const n = name.trim();
    if (!ok) return;
    if (agents?.some((a) => a.name === n)) router.push(`/agents/${n}`);
    else router.push(`/agents/${n}?new=1`);
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-3 pb-6">
      <header className="oz-head justify-start gap-2.5">
        <button onClick={() => router.back()} className="oz-k sm">
          <LineIcon name="back" size={13} /> back
        </button>
        <span className="text-[13px]">agents</span>
      </header>

      <section className="oz-blk">
        <h2>agents</h2>
        <ul className="oz-alist">
          {(agents || []).map((a) => (
            <li key={a.name}>
              <Link href={`/agents/${a.name}`} data-testid="agent-row">
                <span className="r1">
                  <span className="truncate">{a.name}</span>
                  <span className="tag">{harnessLabel(a.harness)}</span>
                  <span className="m">{a.model || 'default'} ›</span>
                </span>
                {a.description && <span className="r2">{a.description}</span>}
              </Link>
            </li>
          ))}
          {!agents && (
            <li className="py-2 text-[11px] text-[var(--oz-dim)]">
              {err ? `couldn't load agents — ${err} · retrying` : 'loading agents…'}
            </li>
          )}
        </ul>
        {naming ? (
          <div className="flex gap-1.5">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && create()}
              placeholder="name — letters, digits, - _"
              aria-label="new agent name"
              className="oz-field"
            />
            <button onClick={create} disabled={!ok} className="oz-k ok px-3 disabled:opacity-40">
              create
            </button>
          </div>
        ) : (
          <div>
            <button
              onClick={() => setNaming(true)}
              className="oz-k ok h-9 w-full justify-start px-3 text-[12px]"
            >
              <LineIcon name="plus" size={13} /> new agent
            </button>
          </div>
        )}
        <p className="note">
          on the root an agent is yours to shape — model, thinking, tools, instructions. on a
          harness (Claude Code, opencode, Codex) the harness brings its own tools.
        </p>
      </section>
      <SharedPrompt />
    </main>
  );
}

/** The system prompt every agent reads first — stored once in the brain, edited here once. */
function SharedPrompt() {
  const [got, setGot] = useState<{ prompt: string; default: string; custom: boolean } | null>(null);
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => {
    fetch('/api/shared-prompt', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setGot(d);
        setText(d.prompt);
      })
      .catch(() => {});
  }, []);
  const save = async (prompt: string) => {
    const r = await fetch('/api/shared-prompt', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return setNote(d.error || `save failed (${r.status})`);
    setGot(d);
    setText(d.prompt);
    setNote(
      prompt.trim() ? 'saved — every agent reads it from its next turn' : 'back to the default'
    );
  };
  if (!got) return null;
  return (
    <section className="oz-blk">
      <h2>shared by all agents</h2>
      <div>
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setNote('');
          }}
          aria-label="shared prompt"
          rows={8}
          className="oz-field h-auto py-2 text-[12px] leading-relaxed"
        />
      </div>
      <div className="oz-chips pt-0">
        <button disabled={text === got.prompt} onClick={() => void save(text)}>
          save
        </button>
        {got.custom && <button onClick={() => void save('')}>reset to default</button>}
      </div>
      <p className="note">
        {note || 'every agent reads this first, then its own prompt — stored once, not per agent'}
      </p>
    </section>
  );
}
