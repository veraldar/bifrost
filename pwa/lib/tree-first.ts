/** Tree-first first run: the fullscreen tree → a hands-free onboarding
 *  conversation with the brain → THE MAIN session → the tree as the corner
 *  door. Shared by the home page, the session view and the /api proxy, so
 *  no browser APIs at module level. */

/** localStorage flag: set once onboarding produced MAIN; absent = first run. */
export const TF_DONE_KEY = 'tree-first-done';
/** sessionStorage one-shot: home plays the tree's shrink-to-corner once. */
export const TF_SHRINK_KEY = 'tree-first-shrink';
/** localStorage: oz-mode as it was before onboarding armed hands-free. */
export const TF_PREV_MODE_KEY = 'tree-first-prev-mode';
/** localStorage: the answers, as the brain confirmed them. */
export const TF_PREFS_KEY = 'bifrost-onboard';

/** The reserved session: slug `main`, caps-tagged title (slugify('[MAIN]') = 'main'). */
export const MAIN_SLUG = 'main';
export const MAIN_TITLE = '[MAIN]';
export const ONBOARD_PREFIX = 'onboarding';

export function isMainSlug(slug: string): boolean {
  return slug === MAIN_SLUG;
}

export function isOnboardingSlug(slug: string): boolean {
  return slug === ONBOARD_PREFIX || slug.startsWith(`${ONBOARD_PREFIX}-`);
}

export type OnboardPrefs = {
  voice: 'woman' | 'man' | null;
  style: 'short' | 'detailed';
  brain: 'local' | 'openrouter' | 'plan';
};

/** First line of the priming message — how the transcript recognises (and
 *  hides) it. yggdrasil sessions carry no system prompt, so the onboarding
 *  instructions ride as the session's first message. */
export const ONBOARD_HEAD = '[bifrost onboarding';

export const ONBOARDING_PROMPT = `${ONBOARD_HEAD} — setup instructions for you, the assistant. The person does not see this message.]

You are the voice of bifrost, meeting your person for the first time. This is a spoken setup conversation: everything you write is read aloud by text-to-speech, and the person answers by voice, hands-free.

How to talk:
- Plain spoken sentences only. No markdown, lists, headings, emoji or code. Two or three short sentences per turn.
- One question per turn, then wait for the answer. Never use tools.
- Reply in the language the person speaks.

Your first message: greet them in one warm sentence, tell them that when they finish speaking they say "over" so you know it is your turn, then ask question 1.

Ask these three, in order:
1. Voice: should I sound like a woman or a man?
2. Replies: short and fast, or more explanation?
3. The brain, the model that thinks for them. Offer three options, each with one plain sentence about where their words go:
   - local and free: it runs on this machine, so nothing they say leaves it.
   - OpenRouter, pay per use: many models to pick from, and each provider handles their data under its own rules.
   - a coding plan: the cheapest for heavy use, but the vendor sees what they send.
   Prefer local and free when its quality is good enough for what they want; say honestly when a paid brain would do noticeably better.

After each answer, confirm it back in a few words ("A woman's voice, got it.") and ask the next question. If an answer is unclear, ask again briefly. If they give several answers at once, take them all and skip ahead. If they ask something else, answer in one sentence and come back to the setup.

When all three are confirmed: say the three choices back in one sentence, then close with: "Want me shorter, faster, or more detailed? Just ask." Then put this marker alone on the very last line (it is never read aloud):
[[bifrost:onboarded voice=<woman|man> style=<short|detailed> brain=<local|openrouter|plan>]]
Write the marker only in that final message, and only once all three answers are confirmed.`;

export function isOnboardPrompt(text: string): boolean {
  return text.trimStart().startsWith(ONBOARD_HEAD);
}

const MARKER_RE = /\[\[\s*bifrost:onboarded\b([^\]]*)\]\]/i;

/** The brain's closing marker → the confirmed answers; null while onboarding runs. */
export function parseOnboarded(text: string): OnboardPrefs | null {
  const m = MARKER_RE.exec(text);
  if (!m) return null;
  const kv = m[1].toLowerCase();
  const pick = (key: string) => new RegExp(`${key}\\s*=\\s*<?([a-z-]+)`).exec(kv)?.[1] || '';
  const voice = pick('voice');
  const style = pick('style');
  const brain = pick('brain');
  return {
    voice: voice === 'woman' || voice === 'man' ? voice : null,
    style: style === 'detailed' ? 'detailed' : 'short',
    brain: brain === 'openrouter' ? 'openrouter' : brain === 'plan' ? 'plan' : 'local',
  };
}

/** Markers are for the PWA, never for eyes or ears. */
export function stripMarkers(text: string): string {
  return text.replace(/\[\[\s*bifrost:[^\]]*\]\]/gi, '').trimEnd();
}

const BRAIN_WORDS: Record<OnboardPrefs['brain'], string> = {
  local: 'local and free (stays on this machine)',
  openrouter: 'OpenRouter, pay per use (each provider handles data its own way)',
  plan: 'a coding plan (cheapest, the vendor sees what I send)',
};

/** MAIN's first message: the standing preferences, so the brain keeps them. */
export function mainPreamble(p: OnboardPrefs): string {
  return [
    '[bifrost · standing preferences from onboarding]',
    `voice: ${p.voice ?? 'no preference'} · replies: ${
      p.style === 'detailed' ? 'more explanation' : 'short and fast'
    } · brain: ${BRAIN_WORDS[p.brain]}.`,
    'Keep to these unless I ask otherwise. Acknowledge in one short sentence.',
  ].join('\n');
}
