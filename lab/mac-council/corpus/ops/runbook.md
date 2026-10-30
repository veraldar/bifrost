# Incident runbook
- Symptom: latency spikes with rising dirty counts → flush is behind.
  First action: check the flusher heartbeat file `run/state/flusher.hb`.
- **Escalation contact: D. Okafor** (primary), M. Lindqvist (secondary).
- Symptom: WAL replay slow at boot → run `kvxctl compact` in the window.
- Never run `kvxctl compact` outside Tuesday 03:00 without the on-call sign-off.
