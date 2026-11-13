'use client';

/** /settings/profiles — the root's agent profiles, browsed. One block: the
 *  registry's list in its own order, each row a link to its own page
 *  (/settings/profiles/[id]) where its tools are shown. Read-only: the
 *  profiles are the brain's to define (AI-owned); the PWA renders them —
 *  no edit buttons, no forms. */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { LineIcon } from '@/components/line-icon';
import { ErrorBox } from '@/components/app/error-box';

type Profile = { id: string; description: string; tools: string[]; isDefault: boolean };

/** Same settle shape as the session settings page (grab): the body or the
 *  reason it didn't come — never a silent miss. */
async function grab(url: string): Promise<{ data: Profile[] } | { err: string }> {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    const d = await r.json().catch(() => null);
    if (!r.ok) return { err: d?.error || `HTTP ${r.status}` };
    return { data: d };
  } catch (e) {
    return { err: e instanceof Error ? e.message : String(e) };
  }
}

export default function ProfilesListPage() {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [loadErr, setLoadErr] = useState('');

  // self-healing load (session-settings' retry law): while the list lacks
  // its data, keep asking — a flaky fetch must not read as "no profiles"
  const missing = !profiles;
  useEffect(() => {
    if (!missing) return;
    let stop = false;
    const poll = () => {
      if (document.hidden || stop) return;
      grab('/api/profiles').then((r) => {
        if (stop) return;
        if ('data' in r) {
          setProfiles(r.data);
          setLoadErr('');
        } else setLoadErr(r.err);
      });
    };
    poll();
    const t = setInterval(poll, 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [missing]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-3 pb-6">
      <header className="oz-head justify-start gap-2.5">
        <Link href="/settings" className="oz-k sm">
          <LineIcon name="back" size={13} /> back
        </Link>
        <span className="text-[13px]">profiles</span>
      </header>

      {loadErr && !profiles && (
        <ErrorBox
          error={`couldn't load profiles — ${loadErr}`}
          onDismiss={() => setLoadErr('')}
        />
      )}

      <section className="oz-blk">
        <h2>agent profiles</h2>
        <ul className="oz-mlist">
          {(profiles || []).map((p) => (
            <li key={p.id}>
              <Link href={`/settings/profiles/${p.id}`} data-testid="profile-row">
                <span className="truncate">
                  {p.id}
                  {p.isDefault && ' · default'}
                </span>
                <span className="flex-none">
                  {p.tools.includes('*') ? 'all tools ›' : `${p.tools.length} tools ›`}
                </span>
              </Link>
            </li>
          ))}
          {!profiles && (
            <li className="px-0.5 py-2 text-[11px] text-[var(--oz-dim)]">
              {loadErr ? `couldn't load profiles — ${loadErr} · retrying` : 'loading profiles…'}
            </li>
          )}
          {profiles && !profiles.length && (
            <li className="px-0.5 py-2 text-[11px] text-[var(--oz-dim)]">
              the registry defines no profiles
            </li>
          )}
        </ul>
        <p className="note">
          how the root&apos;s agents are scoped — what each may do, set on the box. read-only: they
          are the brain&apos;s to define, not the app&apos;s to edit.
        </p>
      </section>
    </main>
  );
}
