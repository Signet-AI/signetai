
## 2026-03-09 - [Optimizing Session Memory Recording Hot Path]
**Learning:** Redundant `existsSync` calls and repeated `db.prepare()` in batch loops contribute significant overhead in SQLite hot paths, particularly when using Bun's SQLite bridge. `crypto.randomUUID()` is also noticeably slower than deterministic string concatenation for row IDs when global uniqueness isn't required (already covered by a composite UNIQUE constraint).
**Action:** Always cache DB existence checks in long-running daemon processes and use a `WeakMap` statement cache keyed by the database instance. Prefer deterministic identifiers (`prefix:key`) over UUIDs for local tracking tables to reduce CPU cycles.
