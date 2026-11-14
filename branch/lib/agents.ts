/** Agents (root-coord 11-13): the brain's GET/PUT /agent/:name shape, shared
 *  by /agents, /agents/[name] and the session settings' "what changes".
 *  The word on screen is AGENT. An agent runs on the root (lots to customize)
 *  or on a harness — Claude Code, opencode, Codex, Antigravity — which brings its own tools. */

export type Rule = { permission: string; pattern: string; action: string };

export type AgentDetail = {
  name: string;
  description: string;
  builtin: boolean;
  harness: string; // root | claude | opencode | codex | antigravity
  model: string | null;
  variant: string | null; // high | low | off | null (model default)
  prompt: string | null;
  prompt_lite?: string | null; // what lite models read instead (null = the prompt)
  steps: number | null;
  sessions: boolean; // manages sessions (session_* tools)
  tools: Record<string, boolean>;
  rules: Rule[] | null; // custom pattern rules — toggling a tool replaces them
  locked: string[];
  customizable: string[];
  models: string[]; // the models this root serves
  /** everything the model reads before the conversation (per tier when this root serves a lite model) */
  system?: { tier: string; models: string[]; text: string }[];
};

/** one row of GET /api/agents */
export type AgentRow = {
  name: string;
  description: string;
  harness?: string | null; // null = runs on the root
  model?: string | null;
};

export const HARNESSES = ['root', 'claude', 'opencode', 'codex', 'antigravity'] as const;
const LABEL: Record<string, string> = {
  root: 'root',
  claude: 'Claude Code',
  opencode: 'opencode',
  codex: 'Codex',
  antigravity: 'Antigravity', // Google's Antigravity CLI (agy) — it replaced Gemini CLI (11-14)
};
export const harnessLabel = (h?: string | null) => LABEL[h || 'root'] || String(h);

/** what each harness lets you set — the brain answers `customizable` for an
 *  existing agent; a new one has no answer yet */
export const CUSTOMIZABLE: Record<string, string[]> = {
  root: ['description', 'model', 'variant', 'prompt', 'tools', 'steps', 'sessions'],
  claude: ['description', 'model', 'prompt'],
  opencode: ['description', 'model'],
  codex: ['description', 'model'],
  antigravity: ['description', 'model'],
};

export const TOOLS = ['read', 'glob', 'grep', 'bash', 'write', 'edit', 'webfetch', 'todowrite'];

/** a model hint per harness (free text there — the harness knows its own) */
export const MODEL_HINT: Record<string, string> = {
  claude: 'opus · sonnet · haiku',
  opencode: 'provider/model — empty = its default',
  codex: 'empty = its default',
  antigravity: 'empty = its own pick',
};

const firstLine = (s: string | null) => {
  const l = (s || '').trim().split('\n')[0] || '';
  return l.length > 60 ? `${l.slice(0, 59)}…` : l;
};

/** What a session taking agent `to` changes, as [what, how] rows — shown
 *  before the switch. `cur` = the agent it runs now (null: none pinned);
 *  `run` = the session's model now. Rows only for what really differs. */
export function agentDiff(
  cur: AgentDetail | null,
  to: AgentDetail,
  run: { modelID: string; variant: string | null } | null
): [string, string][] {
  const rows: [string, string][] = [];
  const pair = (k: string, a: string, b: string) => a !== b && rows.push([k, `${a} → ${b}`]);
  pair('runs on', harnessLabel(cur?.harness), harnessLabel(to.harness));
  pair('model', run?.modelID || cur?.model || 'default', to.model || 'default');
  if (to.harness === 'root') {
    pair('thinking', run?.variant || 'default', to.variant || 'default');
    const on = (d: AgentDetail | null) =>
      TOOLS.filter((t) => d?.harness === 'root' && d.tools?.[t]);
    const was = on(cur);
    const now = on(to);
    const moves = [
      ...now.filter((t) => !was.includes(t)).map((t) => `+${t}`),
      ...was.filter((t) => !now.includes(t)).map((t) => `−${t}`),
    ];
    if (moves.length) rows.push(['tools', moves.join(' ')]);
  } else rows.push(['tools', `${harnessLabel(to.harness)}'s own`]);
  if ((cur?.prompt || '') !== (to.prompt || ''))
    rows.push(['instructions', `${firstLine(to.prompt) || 'none'} — changed`]);
  pair('sessions', cur?.sessions ? 'manages' : 'no', to.sessions ? 'manages' : 'no');
  return rows;
}

/** the agent's three-letter tag in the session list: AGI, BUI(ld), FIX, LEA(d)… */
export const agentTag = (agent: string) =>
  agent
    .replace(/[^a-z0-9]/gi, '')
    .slice(0, 3)
    .toUpperCase();
