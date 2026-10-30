/** Session tool profiles (yggdrasil 885122c, contract D6 in
 *  docs/reviews/tool-scope-plan.md): `GET /profile` lists them in the
 *  `GET /agent` element shape plus `default: bool`. The list is 404 on a
 *  root without the feature — `profilesFor` swallows exactly that (the
 *  PWA then runs default-only, byte-identical UI to before); any OTHER
 *  failure surfaces (a stripped root answers 401, a gone root throws and
 *  the route 500s — never a silent invention of an empty list). */

import { ocFetch } from './oc';

/** One profile as the root serves it (GET /profile element). */
export type Profile = {
  name: string;
  description?: string;
  mode?: string;
  permission?: Array<{ action: string; pattern: string; permission: string }>;
  override?: Record<string, unknown>;
  /** the profile a session gets when none was asked for */
  default: boolean;
};

/** An entry that carries the feature's absence as data: the list, or null
 *  for a brain without profiles (GET /profile 404). */
export type Profiles = Profile[] | null;

/** Module cache: the picker's server-side default-name. The profile SET is
 *  fixed at boot (D8), so a per-process memo is correct — and a picker open
 *  never costs more than one brain call per process. */
let defaultNameCache: string | null = null;

/** The brain's default profile name, resolved server-side and memoized per
 *  process: profilesFor() → its `default: true` entry → fallback 'build'.
 *  The picker label derives from this, so the default option reads the
 *  brain's actual default (never a UI-hardcoded 'build' that could drift
 *  from a YGG_PROFILES default_agent change). */
export async function defaultProfile(): Promise<string> {
  if (defaultNameCache) return defaultNameCache;
  const list = await profilesFor();
  defaultNameCache = defaultProfileName(list);
  return defaultNameCache;
}

/** The profiles list — null when the brain has no profile feature
 *  (GET /profile 404). Only the feature-absence 404 is swallowed; a 401 /
 *  500 keeps its error (the route turns it into a loud 500). */
export async function profilesFor(): Promise<Profiles> {
  try {
    const list = (await ocFetch('/profile')) as Profile[];
    return Array.isArray(list) ? list : null;
  } catch (e) {
    if (is404(e)) return null; // the brain predates profiles — not an error
    throw e;
  }
}

/** The name of the root's default profile — 'build' unless the brain says
 *  otherwise (or `list` is null: default-only UI shows 'build'). */
export function defaultProfileName(list: Profiles): string {
  const d = (list || []).find((p) => p.default);
  return d?.name || 'build';
}

/** The feature is present AND at least one selectable profile exists
 *  (never render an empty picker on a present-but-broken feature). */
export function profilesUsable(list: Profiles): boolean {
  return !!list && list.length > 0;
}

function is404(e: unknown): boolean {
  return /opencode 404 on \/profile/.test(String(e));
}
