// The LiveKit agent name the PWA dispatches to — must equal the worker's
// AGENT_NAME (agent/agent.py). One default for every route: the LAB name.
// Live sets AGENT_NAME=bifrost-live in its release env (scripts/gate.py
// checks both sides match), so a lab PWA without env can never dispatch to
// the live worker. (Before v0.6.1 the token route defaulted to 'bifrost' and
// the dispatch route to 'bifrost-live' — only the env kept them aligned.)
export function agentName(): string {
  return process.env.AGENT_NAME || 'bifrost';
}
