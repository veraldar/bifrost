# Design notes (working)
- Why CLOCK over LRU: no linked list, single bit per slot; hit ratios within 2%.
- Sharding: fixed 16 shards, key hash mod 16. Re-sharding is out of scope.
- The old single-threaded flusher was replaced in v2.3.0 by a background one.
- Open question: per-shard flush thresholds (considered, rejected for v2.3).
