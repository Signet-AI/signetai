## 2026-03-11 - [Session Memory Recording Optimization]
**Learning:** SQLite statement preparation and filesystem existence checks are significant bottlenecks on high-frequency paths like session start. Multi-row inserts with memoized SQL strings and statement caching via `WeakMap` dramatically reduce overhead. Caching `existsSync` results must be done carefully; caching only the positive result ensures functionality isn't broken for lazily initialized resources.
**Action:** Use `WeakMap` for statement caching and memoize repetitive SQL fragments in any high-throughput DB operations.
