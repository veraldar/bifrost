/** Which brain the e2e seeds/asserts against. The suite drives a SERVED app
 *  (PW_BASE_URL) — the brain it must talk to is the brain THAT app serves,
 *  never a hardcoded port:
 *    - E2E_OC_URL / OPENCODE_URL win explicitly (a runner pins the brain);
 *    - PW_BASE_URL=:8090 is the sandbox stack (bifrost-sandbox.service →
 *      lk-yggdrasil.service, brain :4100);
 *    - default is the live stack (opencode-serve :4096).
 *  Root cause fixed 10-23: three specs hardcoded the live brain (:4096) and
 *  seeded/asserted the WRONG store under the sandbox — sessions the proxy
 *  (:4100) could never see (context/wedge/subs RED under PW_BASE_URL=:8090,
 *  GREEN against :8080 — pure env drift, zero product surface). */

export const OC =
  process.env.E2E_OC_URL ||
  process.env.OPENCODE_URL ||
  (process.env.PW_BASE_URL?.includes(':8090')
    ? 'http://127.0.0.1:4100'
    : 'http://127.0.0.1:4096');
