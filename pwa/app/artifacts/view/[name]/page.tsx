'use client';

/** Full-screen artifact page — what an html thumbnail opens into: the page
 *  edge to edge in a sandboxed iframe (chat's no-scripts rule holds even
 *  full-screen), with a floating back chip. Browser back works too. */

import { useParams, useRouter } from 'next/navigation';
import { PixelIcon } from '@/components/pixel-icon';

export default function ArtifactViewPage() {
  const raw = useParams<{ name: string }>().name;
  const router = useRouter();
  const name = decodeURIComponent(Array.isArray(raw) ? raw[0] : (raw ?? ''));
  // same guard as the serving route — this page only ever shows one file
  const ok = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);

  return (
    <div className="relative h-[100dvh] w-full bg-black">
      {ok && (
        <iframe
          sandbox=""
          src={`/api/artifact/${encodeURIComponent(name)}`}
          title={name}
          className="h-full w-full border-0 bg-white"
        />
      )}
      <button
        onClick={() => router.push('/artifacts')}
        aria-label="back to artifacts"
        className="absolute left-2 top-2 z-10 flex max-w-[62%] items-center gap-1.5 rounded border border-[var(--oz-border)] bg-[var(--oz-surface)]/90 px-2.5 py-1.5 text-xs text-[var(--oz-text)]"
      >
        <PixelIcon name="arrow-left" size={10} />
        <span className="truncate">{ok ? name : 'bad name'}</span>
      </button>
    </div>
  );
}
