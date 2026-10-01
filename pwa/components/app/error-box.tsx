'use client';

/** The one error surface, used by every page (user req: same mechanism
 *  everywhere): the message, "fix this" and "dismiss". "fix this" packages
 *  error + page + parent-session identity + diagnostics into a fresh opencode
 *  fix session started with the same agent/model/think level as the session
 *  that hit the error. The commit verdict is agent-to-agent (user req 10-01:
 *  the user pressed "fix this" and moved on — they can't rule on a diff): the
 *  fix session asks the PARENT session once, via a blocking opencode API
 *  call, and only an explicit APPROVE commits or pushes. Loop-guards keep
 *  that from becoming a spawn/validate token spiral (user req 10-01): one
 *  ask max, anything-but-APPROVE leaves the patch uncommitted, and a fix
 *  session never validates another fix session. */

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { slugify } from '@/lib/slug';
import { diagDump } from '@/lib/diag';

type FixCfg = {
  id?: string;
  title?: string;
  agent?: string | null;
  model?: { providerID: string; modelID: string; variant: string | null } | null;
};

export function ErrorBox({
  error,
  onDismiss,
  slug,
}: {
  error: string;
  onDismiss: () => void;
  slug?: string;
}) {
  const router = useRouter();
  const reportingRef = useRef(false);
  const [phase, setPhase] = useState<'idle' | 'sending' | Error>('idle');

  async function fixWithSession() {
    if (reportingRef.current) return;
    reportingRef.current = true;
    setPhase('sending');
    try {
      // carry over the errored session's harness (agent) + model + think
      // level, so the fix runs under the same setup that produced the bug
      const cfg: FixCfg | null = slug
        ? await fetch(`/api/session/${slug}`, { cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null)
        : null;
      const report = [
        'A frontend error occurred in the voice PWA — context below. You are in',
        'charge of this fix session; the workflow after the context is a suggestion,',
        'adapt it if your judgment says otherwise.',
        '',
        `error: ${error}`,
        `page: ${location.pathname}${location.search}`,
        ...(slug
          ? [
              `parent session (the one the error happened in): slug ${slug}, title`,
              `"${cfg?.title || slug}"${cfg?.id ? `, opencode id ${cfg.id}` : ''}.`,
              'It knows what it was doing when the error hit — it rules on your fix.',
            ]
          : []),
        `time: ${new Date().toISOString()}`,
        `ua: ${navigator.userAgent}`,
        '',
        'recent diagnostics (last events):',
        diagDump().split('\n').slice(-12).join('\n'),
        '',
        ...(cfg?.agent || cfg?.model
          ? [
              'This fix session was started with the same agent/model/think level as',
              'the session that hit the error — keeping them is suggested.',
              '',
            ]
          : []),
        'Suggested flow: find the root cause in ~/Work/bifrost/pwa, fix it, and',
        'verify with `cd pwa && npx playwright test`. Then get the commit decision',
        'from the PARENT session, agent to agent. The user is NOT part of this:',
        "they pressed 'fix this' and moved on — never wait on them, never ask",
        'them to review a diff.',
        ...(cfg?.id
          ? [
              '',
              'Ask the parent with ONE blocking call — it returns the parent\'s reply:',
              `  curl -s --max-time 600 -X POST http://127.0.0.1:4096/session/${cfg.id}/message \\`,
              "    -H 'Content-Type: application/json' \\",
              '    -d \'{"parts":[{"type":"text","text":"<root cause + summary of the',
              '    diff + test evidence +: Reply APPROVE or REJECT with a one-line',
              "    reason. Do not edit code, do not spawn fix sessions.'\">}]}'",
            ]
          : []),
        '',
        'Hard loop-guards — breaking these burns tokens in a spawn/validate spiral:',
        '- Ask the parent AT MOST ONCE. One message in, one verdict out.',
        '- Only an explicit APPROVE commits or pushes. REJECT, a vague reply, a',
        '  timeout or an error all mean the same thing: do NOT commit, do NOT',
        '  re-ask, do NOT spawn anything — leave the patch uncommitted (git diff',
        '  is the record) and write up root cause + patch + evidence here.',
        ...(cfg?.title
          ? [
              `- If the parent's title starts with 'fix' it is itself a spawned fix`,
              '  session: never ask it to validate — stop at the uncommitted patch',
              '  and report.',
            ]
          : []),
        ...(cfg?.id
          ? []
          : [
              '- No parent session is known: leave the fix uncommitted and report',
              '  it here — never commit without a ruling.',
            ]),
        '- On APPROVE: stage only the files you changed (parallel sessions may',
        '  hold unrelated dirty files — docs/claims.md + git status tell you),',
        '  commit with a req-linked message, push to GitHub. If push fails,',
        '  propose the fix as a GitHub issue (`gh issue create` in',
        '~/Work/bifrost) with the error, root cause, patch and test evidence,',
        'so the dev team can land it.',
      ].join('\n');
      const name = `fix ${slug || location.pathname} ${new Date().toLocaleTimeString()}`;
      const cr = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const s = await cr.json();
      if (!s.id) throw new Error(s.error || 'session create failed');
      const patchBody: Record<string, unknown> = {};
      if (cfg?.agent) patchBody.agent = cfg.agent;
      if (cfg?.model?.providerID && cfg?.model?.modelID)
        patchBody.model = {
          providerID: cfg.model.providerID,
          modelID: cfg.model.modelID,
          variant: cfg.model.variant || undefined,
        };
      if (Object.keys(patchBody).length) {
        await fetch(`/api/session/${slugify(s.title)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patchBody),
        });
      }
      const pr = await fetch(`/api/session/${slugify(s.title)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: report, async: true }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!pr.ok) throw new Error(`prompt failed (${pr.status})`);
      router.push(`/session/${slugify(s.title)}?id=${s.id}`);
    } catch (e) {
      setPhase(e instanceof Error ? e : new Error(String(e)));
    } finally {
      reportingRef.current = false;
    }
  }

  return (
    <div className="mb-2 rounded border border-[var(--oz-danger)]/60 px-3 py-2 text-xs text-[var(--oz-danger)]">
      {phase === 'sending'
        ? 'sending bug report…'
        : phase instanceof Error
          ? `bug report failed: ${phase.message} — `
          : ''}
      {phase !== 'sending' && (
        <>
          {error}{' '}
          <button onClick={() => void fixWithSession()} className="underline">
            fix this
          </button>{' '}
          <button onClick={onDismiss} className="underline">
            dismiss
          </button>
        </>
      )}
    </div>
  );
}
