'use client';

/** /settings/profiles/[id] — one agent profile: its name, its description,
 *  and its allowed tools, exactly as the registry grants them. Read-only —
 *  the profiles are the brain's to define; this page renders, never edits
 *  (no buttons, no forms). Back: the profiles list. */

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { LineIcon } from '@/components/line-icon';

type ProfileDetail = {
  name: string;
  description: string;
  tools: string[];
  isDefault: boolean;
};

export default function ProfileDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id || '';
  const [profile, setProfile] = useState<ProfileDetail | null>(null);
  const [loadErr, setLoadErr] = useState('');

  // self-healing load, same law as the list page
  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/profiles/${encodeURIComponent(id)}`, { cache: 'no-store' });
      const d = await r.json().catch(() => null);
      if (!r.ok) return setLoadErr(d?.error || `HTTP ${r.status}`);
      setProfile(d);
      setLoadErr('');
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e));
    }
  }, [id]);

  const missing = !!id && !profile;
  useEffect(() => {
    if (!missing) return;
    let stop = false;
    const poll = () => {
      if (document.hidden || stop) return;
      void load();
    };
    poll();
    const t = setInterval(poll, 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [missing, load]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-3 pb-6">
      <header className="oz-head justify-start gap-2.5">
        <Link href="/settings/profiles" className="oz-k sm">
          <LineIcon name="back" size={13} /> back
        </Link>
        <span className="text-[13px] truncate">{profile?.name || id}</span>
      </header>

      <section className="oz-blk">
        <h2>profile</h2>
        <ul className="oz-kv">
          <li>
            <span>name</span>
            <span data-testid="profile-name">{profile?.name || '…'}</span>
            <span />
          </li>
          {profile?.isDefault && (
            <li>
              <span>role</span>
              <span>the registry&apos;s default — sessions without a pick run this</span>
              <span />
            </li>
          )}
        </ul>
        {profile?.description && <p className="note">{profile.description}</p>}
      </section>

      <section className="oz-blk">
        <h2>allowed tools</h2>
        {profile && profile.tools.length > 0 && (
          <div className="oz-chips" data-testid="profile-tools">
            {profile.tools.map((t) => (
              <span key={t} data-testid="profile-tool">
                {t === '*' ? '* all tools' : t}
              </span>
            ))}
          </div>
        )}
        {profile && !profile.tools.length && (
          <p className="note pt-3!">no tools granted — this profile answers with words alone</p>
        )}
        {!profile && (
          <p className="note pt-3!">
            {loadErr ? `couldn't load — ${loadErr} · retrying` : 'loading…'}
          </p>
        )}
        <p className="note">
          what this profile may reach when the root runs it — narrowed by the registry&apos;s deny
          lines, shown as the allowances.
        </p>
      </section>
    </main>
  );
}
