'use client';

import { useTheme } from 'next-themes';
import { VERSION } from '@/lib/version';
import Link from 'next/link';
import { PixelIcon } from '@/components/pixel-icon';

const THEMES = [
  { id: 'aether', desc: 'deep-space terminal', bg: '/yggdrasil_final.svg' },
  { id: 'terminus', desc: 'ash & ember', bg: '/backdrops/terminus.svg' },
  { id: 'drift', desc: 'moonlit light', bg: '/backdrops/drift.svg' },
];

export default function ThemePage() {
  const { theme, setTheme } = useTheme();

  return (
    <>
      <div aria-hidden="true" className="oz-ygg-bg" />
      <main className="relative z-[1] mx-auto flex min-h-dvh max-w-md flex-col px-3 pb-6">
      <header className="mt-4 mb-4 flex items-center gap-2">
        <Link href="/" className="oz-row flex items-center gap-2 rounded-md border border-[var(--oz-border)] px-3 py-1.5 text-xs text-[var(--oz-dim)]">
          <PixelIcon name="arrow-left" size={14} /> back
        </Link>
        <span className="text-sm">settings</span>
      </header>

      <div className="card rounded-lg border border-[var(--oz-border)] bg-[var(--oz-surface)] px-4 py-3 mb-4">
        <div className="text-base font-bold tracking-[0.1em] uppercase">Settings</div>
        <div className="text-[10px] text-[var(--oz-dim)] mt-0.5">
          bifrost {VERSION} · theme: veraldar-charté · aether / terminus / drift
        </div>
        <div className="text-xs mt-2">
          current: <span className="text-[var(--oz-info)]">{theme}</span>
        </div>
      </div>

      <div className="slider flex gap-3 overflow-x-auto pb-4" style={{ scrollSnapType: 'x mandatory' }}>
        {THEMES.map((t) => {
          const cur = theme === t.id;
          return (
            <div
              key={t.id}
              className={`flex-none w-[82%] rounded-lg border bg-[var(--oz-surface)] p-4 ${cur ? 'border-[var(--oz-info)]' : 'border-[var(--oz-border)]'}`}
              style={{ scrollSnapAlign: 'center' }}
            >
              <div className="flex justify-between text-sm">
                <span>{t.id}</span>
                {cur && <span className="text-[10px] text-[var(--oz-dim)]">current</span>}
              </div>
              <div className="text-[10px] text-[var(--oz-dim)] mb-3">{t.desc}</div>
              <div
                className="h-24 mb-3 rounded border border-[var(--oz-border)] bg-[var(--oz-bg)] cursor-pointer"
                style={{
                  backgroundImage: `url(${t.bg})`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                }}
                onClick={() => setTheme(t.id)}
                role="button"
                aria-label={`apply ${t.id} theme`}
                title="tap to apply"
              />
              <div className="grid grid-cols-5 gap-1 mb-3">
                {(['bg', 'surface', 'surface-hover', 'text', 'dim', 'success', 'active', 'danger', 'info', 'border'] as const).map((r) => (
                  <i key={r} className="h-4 border border-[var(--oz-border)]" style={{ background: `var(--oz-${r})` }} />
                ))}
              </div>
              <button
                onClick={() => setTheme(t.id)}
                className={`w-full rounded-md border px-3 py-2 text-xs ${
                  cur
                    ? 'border-[var(--oz-info)] text-[var(--oz-info)]'
                    : 'border-[var(--oz-border)] text-[var(--oz-text)]'
                }`}
              >
                {cur ? '✓ current' : 'use this'}
              </button>
            </div>
          );
        })}
      </div>
      <p className="text-center text-[10px] text-[var(--oz-dim)]">slide → tap a card to apply live</p>
      </main>
    </>
  );
}
