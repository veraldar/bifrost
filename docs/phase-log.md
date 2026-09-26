# Phase Log

## 09-26 — v0.1.0 release (phase "harden to v1.0", partial gate)
- Released with the phone e2e pass incomplete: PTT + scroll confirmed by user;
  hands-free human pass pending. **Waived explicitly by the user** ("create the
  first release… one-click Vercel… reinstall anywhere") — automated coverage:
  e2e suite 19/19 against the live stack.
- Evidence: clean node:24 container build + smoke; suite 19/19; queue-spec
  swallow fix verified 3/3 after ~50% failure rate; fresh-clone container smoke
  (see commit/journal).
- Open items carried: hands-free human check, agent tool-permission policy (OQ#1).
