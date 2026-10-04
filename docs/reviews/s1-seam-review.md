# S1 seam review — per-device tokens (pre-merge, 10-04)

Scope: `pwa/lib/devices.ts`, `lib/admin.ts`, `middleware.ts`, `app/api/pair/**`,
`app/api/token`, `session`, `diag`, `run-events`, client token usage. Checked against
roadmap review Part 3 S1 and Part 15 §a.1.

## 1. VERDICT: MERGE-WITH-FIXES (safe to merge only while `BIFROST_AUTH=tailnet`; NOT-READY to flip to `devices`)

In tailnet mode the middleware does nothing, so merging has no effect on live traffic.
Flipping to `devices` today would break voice and the main app, and would leave the Part 15 requirements unmet:

- **F1** `app/api/token/route.ts:30`: the insecure-route guard throws unless `BIFROST_AUTH==='tailnet'`, so in `devices` mode every LiveKit mint returns 500. Accept `devices` as well. The throw also sits outside `try`; return 500 JSON from inside it instead.
- **F2** Client: the token lives in `localStorage` (`app/pair/page.tsx:23`), but the middleware reads the Authorization header or the `bifrost_device` **cookie**, and nothing sets that cookie. Only `app/bridge/page.tsx` sends the header. Add one fetch wrapper that sets the header, and set the `bifrost_device` cookie (`HttpOnly; Secure; SameSite=Strict`) at pairing so `EventSource` works.
- **F3** `lib/devices.ts`: the registry is read-modify-write with no lock and a non-atomic `writeFile`. A concurrent mint and revoke can **lose the revoke**. A torn read returns `{devices:[]}`, so the next mint overwrites every device. Serialize writes (in-process mutex), write to a tmp file and `rename`, and open with `mode: 0o600` (currently chmod runs after the file is created).
- **F4** There's no TTL or refresh, and no named deviation. Either add `expires` + refresh, or record "long-lived device tokens, revoke-only" as a named S1 deviation in plan.md.
- **F5** There's no kill-switch. Add `DELETE /api/pair/devices {all:true}` (admin only), which marks every device revoked.

## 2. Findings

**HIGH**
- **Token lifecycle**: the token is 192-bit random with a `bfnd-` prefix, returned once, and only the hash is stored. There's no `expires`, refresh, rotation or `lastSeen`. Part 15 requires short-lived tokens + refresh **or** a named deviation, and neither exists (F4).
- **Revocation race / registry wipe** (F3). One corrupt or torn read makes `validateToken` fail closed for everyone (acceptable), but `mintDevice` then persists an empty registry plus the new device (not acceptable).
- **The flip breaks the product** (F1, F2). The `/api/run-events` `EventSource` can't send headers, so it depends on a cookie that nothing sets.
- **Any device can revoke any device**, including the owner's (`pair/devices/route.ts`). A stolen phone can lock out the legitimate one and list every device. Restrict revoke-others and list to admin; let a device revoke only itself.

**MED**
- **Fail-closed pairing is correct in `devices` mode.** With no admin token, `adminOk` returns false, so POST gives 403 and GET without credentials gives 401. A garbage bearer never upgrades to network trust (good). **In `tailnet` mode, anyone who can reach the port can mint.** `adminOk` never looks at the remote address. Behind `tailscale serve`, every caller looks like `127.0.0.1` anyway, so an address check couldn't help. The gate is effectively "any tailnet peer or any local process". The registry shows this: **57 devices, 52 still live**, almost all `e2e-phone`, `e2e-device` or `fail-closed-probe`. The e2e and probe runs mint live tokens and never revoke them. Purge them, and have the suite revoke in teardown.
- **`/pair` UI can't pair a public deploy.** `app/pair/page.tsx` POSTs without the admin header, so with `BIFROST_ADMIN_TOKEN` set it always gets 403. It also stores the token on the *minting* browser, not the phone.
- **No rate limits** on any route, `/api/pair` included. The admin-token compare isn't constant-time (`===`); use `timingSafeEqual`.
- **No region binding or re-auth on region change** (Part 15). Not even a `lastSeen` or `lastIp` field to build it on.
- **The cookie path adds CSRF exposure** once F2 lands. Use `SameSite=Strict` and require the header for state-changing methods.

**LOW**
- **Per-route coverage**: no route handler checks auth itself. `session`, `diag`, `token`, `run-events`, `artifact`, `push`, `tts` and the rest all rely only on the middleware. This is correct by design (one middleware, Part 3 fix), since the matcher `/api/:path*` covers all 19 routes. **In `devices` mode, no route is unguarded except `/api/pair*`.** The risk is a single point of failure: a matcher or runtime regression silently opens everything. Add an e2e test that loops every route and expects 401 without a token.
- `path.startsWith('/api/pair')` also exempts any future `/api/pairing…` route. Match `/api/pair` or `/api/pair/` exactly.
- The registry path is relative to cwd (`.devices.json`) and shared with the bridge. Make it absolute.
- **Storage**: SHA-256 of a high-entropy token is fine (no KDF needed). The file is mode 600 on disk and listed in `pwa/.gitignore:48`. `IS_VERCEL_PREVIEW=true` is still in `.env.local` (S3 leftover, now dead code); remove it.
- The `/pair` QR carries only the raw token, without the box fingerprint or one-time code (Part 15 §a.3). That's acceptable for this seam but has to be done before remote pairing.

## 3. Questions the code can't answer

**(a) Does the client send the token on every call?** No. About 10 client files call `/api/*` with bare `fetch`, and there is no wrapper. Only the bridge page sends `Authorization`. The merge must decide: a header wrapper plus a cookie for SSE, or cookie-only (which needs CSRF hardening).

**(b) What happens to SSE connections opened before revocation?** The middleware runs once, at connect. `/api/run-events` then streams indefinitely with a 25 s heartbeat and never re-checks the token. A revoked device keeps receiving run-completion and error events until it disconnects. The same applies to a LiveKit JWT already minted (15-minute TTL): revocation doesn't kick it from the room. Ordinary fetches do fail on the very next call (the registry is re-read per request). Decide whether to re-validate in the heartbeat and close on failure, and whether revocation should call `RoomService.removeParticipant`.

## Fix list
1. `token/route.ts`: accept `BIFROST_AUTH=devices`; move the guard inside `try`.
2. Client: one `apiFetch` wrapper that sends Bearer, plus an `HttpOnly; SameSite=Strict` cookie set at pairing for `EventSource`; re-validate the token on each SSE heartbeat.
3. `devices.ts`: mutex + atomic tmp→rename + `mode: 0o600`; fail the write (don't overwrite) if the registry fails to parse.
4. `pair/devices`: admin-only revoke-others and list, plus a `revoke all` kill-switch; purge the 52 live e2e/probe tokens and revoke in test teardown.
5. Named deviation in plan.md for TTL, refresh, region binding and rate limits (or implement `expires` + `lastSeen` now), plus an e2e test that expects 401 on every `/api/*` route without a token.
