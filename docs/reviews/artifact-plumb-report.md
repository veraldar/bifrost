# ARTIFACT-PLUMB — every AGI-made artifact reachable at :8443

Session ARTIFACT-PLUMB, 2026-10-26, tree `~/Work/bifrost-sandbox` (lab/sandbox).
Served build `QS2Acuuc6HqMieFVU3dKC` on :8090 → :8443. Live :8080 untouched.

## The rule (one source of truth)

**What the user can see = what the app reads at request time from three dirs. Nothing is copied.**

| source | dir | gallery tag |
|---|---|---|
| `builtin` | `pwa/artifacts-builtin/` (in git: the door's films) | `built-in` |
| `local` | this checkout's `artifacts/` (`ARTIFACTS_DIR`) | none |
| `main` | the main checkout's `artifacts/` (`~/Work/bifrost/artifacts`), only when served from a git worktree | `main` |

- The `main` dir is **derived from the worktree's `.git` file**, so there is no config to lose. On the main checkout itself it collapses into `local`. `ARTIFACTS_MAIN_DIR` overrides it (`''` turns it off). An explicit `ARTIFACTS_DIR`, as the sim stack sets, means no implicit main read.
- **Which file a name means:** built-in names are reserved, so an agent can't swap the door's film. Otherwise the newest write wins, wherever it landed. A tie goes to `local`. The list endpoint and the serving route share this one function, so the gallery never lists a file the route won't serve.
- **Why not a sync step:** a sync can silently miss a run, and a stale copy then shadows the newer original. Reading every source has no copy step, so nothing can drift. Newest-wins means a hand copy can never hide a later rewrite.
- **The bell:** first-run "mark as seen" now works per source. A phone that already used the gallery meets the main tree's backlog of about 520 files once, and those are marked seen. Only files that land after that point make the bell ring.
- Every served file carries an `X-Artifact-Source` header. Each `/api/artifact` entry carries `source`.

Commit: `ad1c4f8`.

## The 415 (`/api/artifact/the-tree-film`)

Content negotiation was not the problem. The route takes the type **from the extension alone** and refused before looking at disk. `the-tree-film` has no extension, and that name never existed. The tree film is the built-in `door-tree.html`, and the far vision is `far-vision.html`; both always returned 200.

**Fix:** a name without an extension now gets a 404 whose message names the real files. Unknown extensions (e.g. `.exe`) still get 415. I added no alias: the 10-22 prompts use "the tree film" for both films, so an alias would guess. Commit: `1b605eb`.

**Built-ins in the gallery: yes, deliberately.** The user went looking for the film by URL, and the gallery is where you find things by sight. Two cards, tagged `built-in`.

## Backfill — no copies needed

Before the fix, the gallery listed only the sandbox's own dir: 50 files, of which 3 were html (2 before the 10-26 hand copy). After the fix: **582 entries** (main 522 · local 58 · builtin 2), **93 html**. Each design file is listed once and served 200:

| artifact | served from |
|---|---|
| mainframe-proposals.html | local (the hand copy, kept; byte-identical to main, sha 22412004; a later rewrite in main wins on its own) |
| door-v3-tree-film.html · onboarding-flow-v07.html | main |
| yggdrasil-ux-near/mid/far.html · world-tree-pertinence.html | main |
| door-tree.html · far-vision.html | builtin |

**Stray dir found:** `pwa/artifacts/` held 8 repro outputs (`repro-*.png/json`, `peek-x*.png`) that no gallery reads. The untracked `pwa/e2e/door-repro.spec.ts`, another session's file, writes `artifacts/…` relative to `pwa/`. I moved the 8 files into `artifacts/` (no name collisions) and they now show. I left that spec alone. **Fix for its owner:** use `../artifacts/`.

## e2e — `pwa/e2e/artifact-plumb.spec.ts` (commit `06ead11`)

1. A file written to the main tree's `artifacts/` appears in the open `/artifacts` gallery through the page's own 8 s poll: no copy, no reload. It shows as unseen, tagged `main`, and opens.
2. One row per name, and the newest write wins in both directions. The list and the route agree.
3. Built-ins are listed and tagged, and a newer local `door-tree.html` doesn't replace the film. `the-tree-film` → 404 with the real names; `.exe` → 415.

Results against :8090: artifact-plumb **3/3 ×2**, the existing artifacts.spec **5/5**, and the film specs (tree-first config: tree-first back/forward + film, voice-wait film ×2) **4/4**. Over the real :8443 tailnet URL: `/api/artifact` 574 items, `door-v3-tree-film.html` 200, `the-tree-film` 404.

## Residuals

- **Live :8080 is unchanged.** It ships when lab/sandbox merges. On the main checkout the union is just local + builtin, so the films join that gallery too.
- **e2e screenshots share names across trees** (`e2e-home.png` …). Under newest-wins, the gallery shows whichever tree ran its suite last. Same name, latest version — the same as a rewrite in one dir.
- **Spec test 1 writes a file into the live main dir** for about 10 s, so it can flash on :8080's gallery. That's the same as `artifacts.spec` does today. It cleans up after itself.
