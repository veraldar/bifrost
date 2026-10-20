/** The model a session with no explicit model runs on — the brain's own
 *  default, read from the brain, never assumed. opencode: GET /config →
 *  `model` ("provider/model", its configured global default — the
 *  /config/providers `default` map is a per-provider "best model" list, not
 *  the one a turn uses). yggdrasil has no /config: its /config/providers
 *  `default` holds exactly one entry, the upstream model it relays every
 *  turn to. Anything else (several entries, no /config model) → null:
 *  unknown, said as such by the caller, never guessed. Server-only: /config
 *  carries provider credentials — only `model` leaves this function. */
import { OC } from './oc';

export type BrainModel = { providerID: string; modelID: string };

export async function brainDefault(): Promise<BrainModel | null> {
  try {
    const r = await fetch(`${OC}/config`, { cache: 'no-store' });
    const m = r.ok ? ((await r.json()) as { model?: unknown }).model : null;
    if (typeof m === 'string' && m.indexOf('/') > 0) {
      const i = m.indexOf('/');
      return { providerID: m.slice(0, i), modelID: m.slice(i + 1) };
    }
  } catch {
    /* no /config (yggdrasil) — the providers map below */
  }
  try {
    const r = await fetch(`${OC}/config/providers`, { cache: 'no-store' });
    if (!r.ok) return null;
    const d = (await r.json()) as { default?: Record<string, string> };
    const entries = Object.entries(d.default || {});
    if (entries.length === 1) return { providerID: entries[0][0], modelID: entries[0][1] };
  } catch {
    /* brain unreachable — unknown */
  }
  return null;
}
