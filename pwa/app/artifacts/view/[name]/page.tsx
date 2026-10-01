'use client';

/** Full-screen artifact page — what an html thumbnail opens into: the page
 *  edge to edge in a sandboxed iframe (chat's no-scripts rule holds even
 *  full-screen). No back button — browser back (or closing the tab, when
 *  opened via the card's open-in-new-tab corner) is the way out. */

import { useParams } from 'next/navigation';

export default function ArtifactViewPage() {
  const raw = useParams<{ name: string }>().name;
  const name = decodeURIComponent(Array.isArray(raw) ? raw[0] : (raw ?? ''));
  // same guard as the serving route — this page only ever shows one file
  const ok = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);

  return (
    <div className="h-[100dvh] w-full bg-black">
      {ok && (
        <iframe
          sandbox=""
          src={`/api/artifact/${encodeURIComponent(name)}`}
          title={name}
          className="h-full w-full border-0 bg-white"
        />
      )}
    </div>
  );
}
