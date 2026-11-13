/** root-coord: the card the brain keeps on every session it manages (the
 *  coordinator's children and theirs) — shared by the home tree and the
 *  session page. Sessions without one (MAIN, a hand-made session, opencode)
 *  read exactly as before. */
export type Card = {
  topic?: string;
  brief?: string;
  status?: string; // working | done | blocked | failed | archived | aborted
  headline?: string;
  summary?: string;
  needs?: string; // a question for the user ('' = none)
  updated?: number;
};

/** one row of the brain's GET /tree (via /api/tree) */
export type TreeRow = {
  id: string;
  title: string;
  parentID?: string | null;
  agent?: string;
  model?: { id?: string } | null;
  card?: Card | null;
  archived?: boolean;
  busy?: boolean;
  depth?: number;
};

/** card.status → its color and word. Working is the state law's green
 *  breath (no word on a row); blocked is amber and asks for you; stalled
 *  (said it would go on, stopped) is amber too; failed is red; done /
 *  stopped / closed are calm (dim) */
export const CARD_ST: Record<string, { c: string; w: string; dot?: boolean }> = {
  working: { c: 'var(--oz-success)', w: '' },
  blocked: { c: 'var(--oz-active)', w: 'needs you', dot: true },
  stalled: { c: 'var(--oz-active)', w: 'stalled', dot: true },
  failed: { c: 'var(--oz-danger)', w: 'failed', dot: true },
  done: { c: 'var(--oz-dim)', w: 'done' },
  aborted: { c: 'var(--oz-dim)', w: 'stopped' },
  archived: { c: 'var(--oz-dim)', w: 'closed' },
};
