# Capacity rules
- **Flush threshold: 9000 dirty entries** per shard before an automatic flush.
- Cache capacity (512) is soft; the store degrades, never refuses writes.
- Max key length is 128 bytes; max value size 1 MiB.
- The maintenance window runs **Tuesdays 03:00** (was Wednesdays before v2.1).
