/** Tree-first first run — THE DOOR (v2, 10-19): the fullscreen tree → hold →
 *  a scripted door in the app's own pre-recorded voice (no brain before MAIN)
 *  → THE MAIN session → one real voice turn → "you are in" → the tree as the
 *  corner door. Shared by the home page, the session view, the layout's boot
 *  script and the /api proxy, so no browser APIs at module level. */
import script from './onboard-script.json';

/** localStorage: set when this device walked the door (value = door version).
 *  Absent = the door. Read before first paint by app/layout.tsx. */
export const DOOR_KEY = 'bifrost-door';
export const DOOR_VERSION = 'v2';
/** localStorage: the first voice turn in MAIN came through (STT proven on this
 *  device) — until then MAIN opens with the first-turn card. */
export const FIRST_TURN_KEY = 'bifrost-first-turn';
/** sessionStorage one-shot: home plays the tree's shrink-to-corner once. */
export const TF_SHRINK_KEY = 'tree-first-shrink';
/** localStorage: the answers, as the door took them. */
export const TF_PREFS_KEY = 'bifrost-onboard';
/** v1 (LLM onboarding) done-flag — read only to retire it. */
export const TF_DONE_KEY = 'tree-first-done';

/** The reserved session: slug `main`, caps-tagged title (slugify('[MAIN]') = 'main'). */
export const MAIN_SLUG = 'main';
export const MAIN_TITLE = '[MAIN]';
export const ONBOARD_PREFIX = 'onboarding';

export function isMainSlug(slug: string): boolean {
  return slug === MAIN_SLUG;
}

/** v1 left `onboarding-*` sessions in the store (swept after an hour). */
export function isOnboardingSlug(slug: string): boolean {
  return slug === ONBOARD_PREFIX || slug.startsWith(`${ONBOARD_PREFIX}-`);
}

export type Lang = 'en' | 'fr';
export type Style = 'short' | 'detail';
export type BrainClass = 'plan' | 'router' | 'local';
export type DoorPrefs = { lang: Lang; style: Style };

/** What the box says about itself (GET /api/onboard): the brain is shown, not
 *  asked — nothing on the phone can change it (it lives in the box's env). */
export type BoxInfo = {
  brain: { model: string; class: BrainClass; where: string };
  /** the address a phone opens (tailnet) — the pair QR encodes it */
  publicUrl: string;
};

// ── the script (lib/onboard-script.json, rendered by scripts/onboard-voice.mjs)
type Line = { id: string; on: string[]; en: string; fr: string };
const LINES: Record<string, Line> = Object.fromEntries(
  (script.lines as Line[]).map((l) => [l.id, l])
);
export function line(id: string, lang: Lang): string {
  return LINES[id]?.[lang] ?? '';
}
/** the pre-recorded file for a line (public/onboarding/<lang>/<id>.mp3) */
export function lineSrc(id: string, lang: Lang): string {
  return `/onboarding/${lang}/${id}.mp3`;
}

/** Answers carried from veraldar.org's door: `#door=v1.<lang>.<style>` in the
 *  link/QR the site hands over. A fragment never reaches any server log. */
export function parseDoorHash(hash: string): Partial<DoorPrefs> | null {
  const m = /(?:^#|&)door=v1\.(en|fr)(?:\.(short|detail|terse|warm))?/.exec(hash);
  if (!m) return null;
  const style = m[2] === 'detail' || m[2] === 'warm' ? 'detail' : m[2] ? 'short' : undefined;
  return { lang: m[1] as Lang, ...(style ? { style } : {}) };
}
export function doorHash(p: DoorPrefs): string {
  return `#door=v1.${p.lang}.${p.style}`;
}

/** First line of a priming message — how the transcript recognises (and the
 *  session list hides) it. v1 primed onboarding sessions with it; v2 opens
 *  MAIN's standing preferences with the same head. */
export const ONBOARD_HEAD = '[bifrost onboarding';
export const PREFS_HEAD = '[bifrost · standing preferences';

export function isOnboardPrompt(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith(ONBOARD_HEAD) || t.startsWith(PREFS_HEAD);
}

/** Markers are for the PWA, never for eyes or ears (v1 sessions carry them). */
export function stripMarkers(text: string): string {
  return text.replace(/\[\[\s*bifrost:[^\]]*\]\]/gi, '').trimEnd();
}

/** MAIN gets the door's answers as a standing instruction — yggdrasil sessions
 *  carry no system prompt, so they ride as a message. The brain's one-line
 *  acknowledgement is the visible proof the answers did something. */
export function mainPreamble(p: DoorPrefs): string {
  const lang = p.lang === 'fr' ? 'French' : 'English';
  const style =
    p.style === 'detail'
      ? 'more detail: full sentences, explain when it helps'
      : 'short: signal only, a sentence or two';
  return [
    `${PREFS_HEAD} from the door]`,
    `language: ${lang} · replies: ${style}.`,
    `Keep to these unless I ask otherwise. Acknowledge in one short sentence, in ${lang}.`,
  ].join('\n');
}
