# Endpoints
- `GET /kv/<key>` — read; 404 if absent.
- `PUT /kv/<key>` — write; requires the `writer` role.
- `POST /flush` — manual flush; overrides the 9000 dirty-entry threshold.
- `GET /stats` — shard stats including dirty counts.
