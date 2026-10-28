/** PROVIDER-WAVE (10-28): why the brain stopped answering, in one shape.
 *
 *  10-28 the root (yggdrasil :4100) answered every turn with z.ai's 429 code
 *  1310 ("Weekly/Monthly Limit Exhausted … reset at 2026-10-29 03:44:03") and
 *  the session page showed NOTHING: the error lived on `info.error` of an
 *  assistant message whose only text part was empty, and the transcript
 *  filter drops empty messages. This module reads both root generations:
 *  - the provider-wave root: `info.error = {name: APIError|ProviderAuthError,
 *    data: {kind, statusCode, code, resetsAt, providerID, modelID, message}}`;
 *  - the frozen v0.7.0 root (and opencode): `{name: UnknownError|APIError,
 *    data: {message: "upstream 429 Too Many Requests: {…json…}"}}` — the kind
 *    and the reset are recovered from the provider's own body.
 *  Isomorphic: the messages route maps errors with it, the banner renders it. */

export type AlertKind =
  | 'quota'
  | 'rate_limit'
  | 'auth'
  | 'overloaded'
  | 'server'
  | 'network'
  | 'unavailable'
  | 'request'
  | 'stream'
  | 'error';

export type ProviderAlert = {
  kind: AlertKind;
  /** the provider's own words (cleaned) or the root's message */
  message: string;
  /** epoch ms the provider said the limit resets */
  resetsAt?: number;
  providerID?: string;
  modelID?: string;
  code?: string;
  statusCode?: number;
};

const QUOTA_CODES = ['1113', '1304', '1308', '1309', '1310', 'insufficient_quota'];
const QUOTA_WORDS = /limit exhausted|quota|insufficient balance|billing|credit balance|usage limit|recharge|package expired|exceeded your current/i;

/** `YYYY-MM-DD HH:MM:SS` printed without a zone; z.ai (codes 1xxx, bracket
 *  envelope) prints Beijing time. */
function parseReset(text: string, offsetMin: number): number | undefined {
  const m = /reset(?:s)? (?:at|on) (\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/i.exec(text);
  if (!m) {
    const d = /try again in (\d+(?:\.\d+)?)\s*(ms|s|m|h)\b/i.exec(text);
    if (!d) return undefined;
    const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[d[2].toLowerCase() as 'ms' | 's' | 'm' | 'h'];
    return Date.now() + Number(d[1]) * mult;
  }
  const [y, mo, da, h, mi, s] = m.slice(1).map(Number);
  return Date.UTC(y, mo - 1, da, h, mi, s) - offsetMin * 60_000;
}

function clean(msg: string): string {
  const t = msg.trim();
  if (!t.startsWith('[')) return t;
  return t
    .split(/[[\]]/)
    .map((s) => s.trim())
    .reduce((a, b) => (b.length > a.length ? b : a), '');
}

const NO_ALERT = new Set(['MessageAbortedError']);

/** `info.error` of a stored message → an alert, or null (an abort is the
 *  user's own stop, not a provider problem). */
export function alertFromError(err: unknown): ProviderAlert | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { name?: string; data?: Record<string, unknown> };
  if (e.name && NO_ALERT.has(e.name)) return null;
  const d = (e.data || {}) as Record<string, unknown>;
  const message = String(d.message || e.name || 'the run failed');
  if (typeof d.kind === 'string') {
    // the provider-wave root: already classified
    return {
      kind: d.kind as AlertKind,
      message,
      resetsAt: typeof d.resetsAt === 'number' ? d.resetsAt : undefined,
      providerID: d.providerID ? String(d.providerID) : undefined,
      modelID: d.modelID ? String(d.modelID) : undefined,
      code: d.code ? String(d.code) : undefined,
      statusCode: typeof d.statusCode === 'number' ? d.statusCode : undefined,
    };
  }
  // the frozen root / opencode: "upstream 429 Too Many Requests: {json}"
  const sm = /upstream (\d{3})[^:]*:\s*([\s\S]*)$/.exec(message);
  const status = sm ? Number(sm[1]) : typeof d.statusCode === 'number' ? d.statusCode : undefined;
  let body: any = null;
  try {
    body = JSON.parse(sm ? sm[2] : String(d.responseBody || ''));
  } catch {
    /* not json */
  }
  const be = body && typeof body.error === 'object' ? body.error : body || {};
  const code = be?.code != null ? String(be.code) : undefined;
  const raw = String(be?.message || (sm ? sm[2] : message));
  const etype = String(be?.type || '');
  const zai = /^\[\d{4}\]/.test(raw) || (!!code && /^1\d{3}$/.test(code));
  let kind: AlertKind = 'error';
  if (status === 401 || status === 403 || etype === 'authentication_error') kind = 'auth';
  else if (status === 402 || (code && QUOTA_CODES.includes(code)) || QUOTA_WORDS.test(raw)) kind = 'quota';
  else if (status === 429 || etype === 'rate_limit_error') kind = 'rate_limit';
  else if (status === 529 || status === 503 || etype === 'overloaded_error') kind = 'overloaded';
  else if (/request failed|connection refused|error sending request/i.test(message)) kind = 'network';
  else if (/mid-reply|stream ended/i.test(message)) kind = 'stream';
  else if (status && status >= 500) kind = 'server';
  else if (status && status >= 400) kind = 'request';
  return {
    kind,
    message: sm ? clean(raw) : message,
    resetsAt: parseReset(raw, zai ? 480 : 0),
    code,
    statusCode: status,
  };
}

/** A kind that means "the brain's provider is out", not "this request was bad". */
export function isProviderOut(a: ProviderAlert): boolean {
  return ['quota', 'rate_limit', 'auth', 'overloaded', 'server', 'network', 'unavailable'].includes(a.kind);
}

const WHAT: Record<AlertKind, string> = {
  quota: 'provider limit exhausted',
  rate_limit: 'provider rate-limited',
  auth: 'provider refused the key',
  overloaded: 'provider overloaded',
  server: 'provider error',
  network: 'provider unreachable',
  unavailable: 'provider has no such model',
  request: 'provider rejected the request',
  stream: 'provider dropped the reply',
  error: 'the run failed',
};

/** `20:44`, or `Thu 03:44` when the reset is not today — the phone's clock. */
export function resetClock(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const hm = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date(now).toDateString()
    ? hm
    : `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${hm}`;
}

/** The banner line: "provider limit exhausted, resets 20:44". */
export function alertHeadline(a: ProviderAlert, now = Date.now()): string {
  const what = WHAT[a.kind] || WHAT.error;
  if (a.resetsAt && a.resetsAt > now) return `${what}, resets ${resetClock(a.resetsAt, now)}`;
  return what;
}

/** The provider's own "Your limit will reset at 2026-10-29 03:44:03" is in
 *  ITS zone (z.ai: UTC+8) — beside the headline's local clock it reads as a
 *  contradiction. Dropped once the reset is parsed into `resetsAt`. */
function dropResetClause(words: string): string {
  return words.replace(/\s*[^.]*\breset(?:s)? (?:at|on) \d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}\]?\.?/i, '').trim();
}

/** The second line: who said it, in their words. */
export function alertDetail(a: ProviderAlert): string {
  const clean = (w: string) => (a.resetsAt ? dropResetClause(w) : w);
  // the provider-wave root's message is "headline — provider/model (429, code 1310): words"
  if (a.message.includes(' — ')) return clean(a.message.split(' — ').slice(1).join(' — ')).slice(0, 260);
  const who = a.providerID ? `${a.providerID}${a.modelID ? `/${a.modelID}` : ''}` : '';
  const tag = [a.statusCode, a.code ? `code ${a.code}` : ''].filter(Boolean).join(' · ');
  return [who, tag, clean(a.message)].filter(Boolean).join(' · ').slice(0, 260);
}

/** Still in force? A reset in the past ends it; no reset = until a reply lands. */
export function alertLive(a: ProviderAlert, now = Date.now()): boolean {
  return !a.resetsAt || a.resetsAt > now;
}
