'use client';

/** /settings — about, world, yours. The world list is the theme switch:
 *  each world is drawn with its own tree in its own palette (the button
 *  carries data-theme, so tokens.css scopes the colors to it), the choice is
 *  seen before it is made. Tapping applies at once via next-themes — one
 *  data-theme attribute on <html>, transitions suppressed for the swap
 *  frame — and that world's tree answers with one pulse up the trunk. */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTheme } from 'next-themes';
import { LineIcon } from '@/components/line-icon';
import { YggTree } from '@/components/ygg';
import { VERSION } from '@/lib/version';
import { VOICE_TEST_SLUG, setVoiceTest, voiceTestOn } from '@/lib/voice-test';

const WORLDS = [
  { id: 'aether', desc: 'deep-space terminal · plain hairlines' },
  { id: 'terminus', desc: 'ash & ember · corner ticks' },
  { id: 'drift', desc: 'moonlit light · dotted rules' },
];
const SWATCHES = ['bg', 'text', 'success', 'active', 'danger', 'info'] as const;

type MicPerm = 'granted' | 'denied' | 'prompt' | 'unknown';

export default function SettingsPage() {
  const { theme, setTheme } = useTheme();
  // next-themes only knows the stored theme after mount — render no
  // "current" marker on the server pass instead of a wrong one
  const [mounted, setMounted] = useState(false);
  // the world whose tree answers right now (+ a counter so a re-tap replays)
  const [wake, setWake] = useState<{ id: string; n: number } | null>(null);
  const [mic, setMic] = useState<MicPerm>('unknown');
  // voice tests in their own room (lib/voice-test.ts) — device-local
  const [vt, setVt] = useState(false);
  const [vtBusy, setVtBusy] = useState(false);
  const [vtErr, setVtErr] = useState('');

  useEffect(() => {
    setMounted(true);
    setVt(voiceTestOn());
  }, []);

  async function toggleVoiceTest() {
    const on = !vt;
    setVtBusy(true);
    setVtErr('');
    try {
      await setVoiceTest(on);
      setVt(on);
    } catch (e) {
      setVtErr(e instanceof Error ? e.message : String(e));
    } finally {
      setVtBusy(false);
    }
  }

  useEffect(() => {
    if (!wake) return;
    const t = setTimeout(() => setWake(null), 2500);
    return () => clearTimeout(t);
  }, [wake]);

  // read-only: a page cannot revoke its own mic grant — the browser's site
  // settings can, and the copy says so
  useEffect(() => {
    let st: PermissionStatus | null = null;
    const sync = () => st && setMic(st.state as MicPerm);
    navigator.permissions
      ?.query({ name: 'microphone' as PermissionName })
      .then((s) => {
        st = s;
        sync();
        s.addEventListener('change', sync);
      })
      .catch(() => setMic('unknown'));
    return () => st?.removeEventListener('change', sync);
  }, []);

  const current = mounted ? theme : undefined;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-3 pb-6">
      <header className="oz-head justify-start gap-2.5">
        <Link href="/" className="oz-k sm">
          <LineIcon name="back" size={13} /> back
        </Link>
        <span className="text-[13px]">settings</span>
      </header>

      <section className="oz-blk">
        <h2>about</h2>
        <ul className="oz-kv">
          <li>
            <span>bifrost</span>
            <span>{VERSION} · a Veraldar product.</span>
            <span />
          </li>
          <li>
            <span>license</span>
            <span>AGPL-3.0</span>
            <span />
          </li>
        </ul>
        <p className="note">AGPL-3.0. Free for everyone. Your hardware, your words.</p>
      </section>

      <section className="oz-blk">
        <h2>world</h2>
        <div className="oz-worlds">
          {WORLDS.map((w) => (
            <button
              key={w.id}
              data-theme={w.id}
              aria-pressed={current === w.id}
              aria-label={`${w.id} — ${w.desc}`}
              onClick={() => {
                setTheme(w.id);
                setWake((p) => ({ id: w.id, n: (p?.n || 0) + 1 }));
              }}
              className="oz-world"
            >
              <span
                key={wake?.id === w.id ? wake.n : 0}
                className={`oz-ygg block ${wake?.id === w.id ? 'wake' : ''}`}
              >
                <YggTree />
              </span>
              <span>
                <b>{w.id}</b>
                <small>{w.desc}</small>
                <span className="sw6">
                  {SWATCHES.map((r) => (
                    <i key={r} style={{ background: `var(--oz-${r})` }} />
                  ))}
                </span>
                <span className="cur">current</span>
              </span>
            </button>
          ))}
        </div>
        <p className="note">tap a world. it applies at once; its tree answers with one pulse.</p>
      </section>

      {/* possession, named as copy */}
      <section className="oz-blk">
        <h2>yours</h2>
        <ul className="oz-kv">
          <li>
            <span>sessions</span>
            <span>on your box, in opencode&apos;s store</span>
            <span />
          </li>
          <li>
            <span>speech</span>
            <span>your models, on your network</span>
            <span />
          </li>
          <li>
            <span>audio</span>
            <span>stays on your network</span>
            <span />
          </li>
          <li>
            <span>mic</span>
            <span>
              {mic === 'granted'
                ? 'granted · this browser'
                : mic === 'denied'
                  ? 'denied · keyboard only'
                  : mic === 'prompt'
                    ? 'asked on first hold'
                    : 'unknown'}
            </span>
            <span />
          </li>
        </ul>
        <p className="note">mic access is the browser&apos;s to grant or revoke — site settings.</p>
      </section>

      {/* testing the voice must never write into MAIN */}
      <section className="oz-blk">
        <h2>voice tests</h2>
        <ul className="oz-kv">
          <li>
            <span>test room</span>
            <span data-testid="voice-test-state">
              {vt ? `on · MAIN opens ${VOICE_TEST_SLUG}` : 'off · voice lands where you are'}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={vt}
              aria-label="voice tests in their own room"
              data-testid="voice-test-toggle"
              disabled={vtBusy}
              onClick={() => void toggleVoiceTest()}
              className={`oz-k sm ${vt ? 'on' : ''}`}
            >
              {vt ? 'on' : 'off'}
            </button>
          </li>
        </ul>
        {vtErr && <p className="note text-[var(--oz-danger)]">{vtErr}</p>}
        <p className="note">
          on: the mic talks to its own session, {VOICE_TEST_SLUG} — MAIN opens it instead, so test
          turns never land in MAIN.{' '}
          {vt && <Link href={`/session/${VOICE_TEST_SLUG}`}>open {VOICE_TEST_SLUG} ›</Link>}
        </p>
      </section>
    </main>
  );
}
