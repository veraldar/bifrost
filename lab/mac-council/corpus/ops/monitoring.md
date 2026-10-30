# Monitoring
- `kvx_dirty_total` — gauge; alert at 8000 (warning) since flush fires at 9000.
- `kvx_cache_hit_ratio` — alert below 0.7.
- The cache alert threshold changed in v2.3.0; the old 0.6 threshold is stale.
