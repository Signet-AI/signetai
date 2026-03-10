## 2026-03-10 - [Hot Path Optimization in session-memories.ts]
**Learning:** Significant overhead in high-throughput database operations (session candidate recording) was caused by redundant SQL compilation, filesystem syscalls, and GC pressure from small array allocations.
**Action:** Apply a holistic optimization pattern: 1) Cache prepared statements via `WeakMap<Db, Map<Sql, Stmt>>`, 2) Cache path resolutions and `existsSync` results, 3) Use deterministic IDs over `crypto.randomUUID()`, 4) Pre-allocate arrays for statement parameters, 5) Memoize repetitive SQL fragments (like `VALUES` clauses).

## 2026-03-10 - [Benchmark Execution in Restricted Environments]
**Learning:** Long-running benchmarks can time out in restricted CI/sandbox environments.
**Action:** Reduce `ITERS` constant in benchmarks (e.g., from 200 to 20-50) and use background execution with logging (`> log 2>&1 &`) if necessary to prevent timeout-induced failures while still verifying performance gains.
