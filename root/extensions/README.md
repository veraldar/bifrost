# Extensions — capabilities outside the core

The root (yggdrasil) stays small: sessions, the agent loop, the tree, agents, roots. Anything
heavier or more specialised — memory, search indexes, device control, a calendar, a camera — is an
**extension**: its own process, any language, started, upgraded and restarted on its own. The core
only knows the interface below (`root/src/ext.rs`).

## Plug one in

```
YGG_EXTENSIONS=librarian=http://127.0.0.1:4310,bench=http://10.0.0.7:4320   # name=url, comma list
YGG_EXT_TOKEN=<secret>        # optional: sent as x-ygg-ext on every call; check it in the extension
```

The root reads every manifest at start, every 3 s until each answered once, then every 60 s — an
extension that starts later, or is upgraded, shows up without restarting the root. One that stops
answering disappears from the agents' tools until it is back. `GET /extensions` on the root lists
them, whether they are up, and their tools.

## The interface (HTTP, JSON)

**`GET /manifest`**

```json
{
  "name": "librarian",
  "description": "one line: what it is",
  "prompt": "optional, one or two sentences every agent should know: when to reach for it",
  "tools": [
    { "name": "search", "scope": "self",
      "description": "what the tool does, for the model",
      "parameters": { "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"] } }
  ]
}
```

**`POST /call/<tool>`** with `{"input": {…}, "session": "<caller session id>", "root": "<root name>"}`
→ `{"output": "text the model reads"}` or `{"error": "what went wrong"}`. Answer errors this way
rather than with an HTTP error: the agent reads them and can adapt.

## What agents see

- Tools are namespaced: `<extension>_<tool>` (`librarian_search`). The description is prefixed
  `[<extension> extension]`.
- **`scope: "self"`** — the tool only reads or writes the extension's own data (an index, its notes):
  every agent may use it, MAIN and the read-only review agent included.
- **`scope: "world"`** (or no scope) — it changes things outside (files, devices, services): only
  agents whose rules allow it — a blanket allow (build, lead, fix) or the tool's name in the agent's
  rules. MAIN and review do not get it.
- A lite model's lean tool set has no extension tools.
- `prompt`, when present, joins the shared prompt every agent reads first (stored once), as an
  `[extensions]` block, while the extension is up.

## Reading the root

An extension reads the root through its normal HTTP API — `GET /session`, `GET
/session/<id>/message?internal=1`, `GET /tree`, `GET /root` — so it never needs the core's internals.
Give it the root's URL when you start it.

## Write a new one

Copy `librarian/` (standard-library Python, one file): a manifest, a `/call/<tool>` dispatcher, your
logic. Test it against a fake root (`librarian/test_librarian.py` shows how), then end to end with
the brain on the mock model (`sim/tree-e2e.py` starts the librarian next to a root and
calls it through MAIN). A systemd unit next to the root's (`librarian/librarian.service`) keeps it
running.

## Extensions here

- **librarian** — the root's memory. A loop indexes every session's messages, cards and the
  artifacts folder into SQLite full-text search with each session's keywords; agents keep facts per
  topic. Tools: `search`, `recent`, `remember`, `recall` (all scope self).
