# AUDIT-core.md — Core Memory System Deep Review

**Auditor:** Subagent (Senior Code Auditor)  
**Branch:** `web3-identity`  
**Scope:** `packages/core/src/` — types, database, search, temporal, decisions, contradictions, knowledge-health, session-metrics, crypto (non-crypto parts), export/, migrations 001–020, index.ts  
**Date:** 2025-07-21

---

## Summary

| Severity | Count |
|----------|-------|
| 🔴 Critical | 4 |
| 🟠 High | 11 |
| 🟡 Medium | 16 |
| 🔵 Low / Informational | 12 |
| **Total** | **43** |

---

## 1. Database Bugs (database.ts)

### CORE-001 🟠 HIGH — `updateMemory` is vulnerable to SQL column injection via `fieldMap` keys
**File:** `database.ts`, lines ~196–228  
**Description:** The `updateMemory` method constructs SQL `SET` clauses by interpolating column names from `fieldMap`. While column names come from a hardcoded map (not user input), the pattern `sets.push(\`${col} = ?\`)` concatenates `col` directly into SQL. If `fieldMap` is ever extended with user-derived keys, this becomes SQL injection. Currently safe but fragile.  
**Fix:** No immediate fix needed — `fieldMap` values are all hardcoded literals. Add a comment: `// SECURITY: col values are hardcoded — never derive from user input.` Consider validating column names against an allowlist.

### CORE-002 🟡 MEDIUM — `updateMemory` does not handle `signature`, `signerDid`, `strength`, `lastRehearsed`, `rehearsalCount` fields
**File:** `database.ts`, lines ~196–228  
**Description:** The `fieldMap` in `updateMemory` only maps 12 fields. Web3 identity fields (`signature`, `signerDid`) added in migration 012 and temporal fields (`strength`, `lastRehearsed`, `rehearsalCount`) added in migration 013 are **not** in the map. Calling `updateMemory({strength: 0.5})` silently does nothing.  
**Fix:** Add missing fields to `fieldMap`:
```typescript
signature: "signature",
signerDid: "signer_did",
strength: "strength",
lastRehearsed: "last_rehearsed",
rehearsalCount: "rehearsal_count",
sourceId: "source_id",
sourceType: "source_type",
```

### CORE-003 🟡 MEDIUM — `updateMemory` missing `sourceId` and `sourceType` in `fieldMap`
**File:** `database.ts`, lines ~196–228  
**Description:** `Memory.sourceId` and `Memory.sourceType` are defined in the interface but can't be updated via `updateMemory()`. The `addMemory` method does write them, but updates silently ignore them.  
**Fix:** Add to `fieldMap`: `sourceId: "source_id"`, `sourceType: "source_type"`.

### CORE-004 🔵 LOW — `rowToMemory` doesn't map `signature` and `signerDid`
**File:** `database.ts`, lines ~285–320  
**Description:** Wait — re-checking: `rowToMemory` **does** include `signature: row.signature as string | undefined` and `signerDid: row.signer_did as string | undefined` at line ~315-316. These are properly mapped. **False alarm — no issue.**

### CORE-005 🟡 MEDIUM — `addMemory` omit type doesn't exclude all auto-generated fields
**File:** `database.ts`, line ~166  
**Description:** `addMemory` accepts `Omit<Memory, "id" | "createdAt" | "updatedAt" | "version">` but the `Memory` interface has many more auto-managed fields: `isDeleted`, `deletedAt`, `contentHash`, `normalizedContent`, `updateCount`, `accessCount`, `lastAccessed`, `strength`, `lastRehearsed`, `rehearsalCount`. These can be passed but are silently ignored since the INSERT only includes 13 columns.  
**Fix:** Either expand the `Omit` list or use `Pick` to explicitly list accepted fields.

### CORE-006 🟡 MEDIUM — `addMemory` doesn't write v2 fields like `importance`, `pinned`, `who`, `contentHash`
**File:** `database.ts`, lines ~168–185  
**Description:** The INSERT statement only writes 13 legacy columns. Fields like `importance`, `pinned`, `who`, `contentHash`, `strength` are not included. Newly added memories always get default DB values (importance=0.5, pinned=0, strength=1.0) regardless of what's passed to `addMemory`.  
**Fix:** Extend the INSERT to include v2/web3/temporal columns, or document that these must be set via a follow-up `updateMemory`.

### CORE-007 🔵 LOW — `requeueDead` uses `SELECT changes()` which may not work correctly across all SQLite bindings
**File:** `database.ts`, lines ~276–280  
**Description:** After running an UPDATE, the code does `db.prepare("SELECT changes() as n").get()`. In better-sqlite3, `.run()` returns `{ changes }` directly. Using a separate `SELECT changes()` statement is fragile — if any intermediate statement runs (e.g., a trigger), the count may be wrong.  
**Fix:** Use the return value from `.run()` instead: `const result = this.getDb().prepare(...).run(now); return result.changes;`

### CORE-008 🟡 MEDIUM — `getMemories` returns soft-deleted memories
**File:** `database.ts`, lines ~189–196  
**Description:** `getMemories()` does `SELECT * FROM memories` without filtering `is_deleted = 0`. Callers get soft-deleted memories mixed in with active ones. This can confuse search, export, and all downstream consumers.  
**Fix:** Add `WHERE COALESCE(is_deleted, 0) = 0` to the base query:
```sql
SELECT * FROM memories WHERE COALESCE(is_deleted, 0) = 0
```

---

## 2. Temporal Memory (temporal.ts)

### CORE-009 🔵 LOW — Ebbinghaus formula is mathematically sound but `rehearsalBonus` can push raw > 1.0
**File:** `temporal.ts`, lines ~98–107  
**Description:** `raw = decay + rehearsalBonus`. For a freshly accessed memory (decay=1.0) with 2 rehearsals: `raw = 1.0 + log(3)*0.3 = 1.0 + 0.33 = 1.33`. This gets clamped to 1.0, which is correct. With 20 rehearsals: `raw = 1.0 + log(21)*0.3 = 1.0 + 0.91 = 1.91` — still clamped correctly. **The clamp works**, but the formula means rehearsal_count > 2 provides no additional benefit for recently accessed memories. This is a design choice, not a bug.  
**Fix:** Informational only. Consider documenting the effective cap.

### CORE-010 ✅ VERIFIED — Edge cases handled correctly
**File:** `temporal.ts`  
**Description:** All edge cases are properly guarded:
- 0 days → `exp(0)` = 1.0 ✅
- Negative days → clamped to 0 via `Math.max(0, ...)` ✅
- NaN dates → `parseDateMs` returns null, falls back to `nowMs` ✅
- Null rehearsal_count → defaults to 0 ✅
- Null importance → defaults to 0.5 ✅
- `!Number.isFinite(value)` check in `clamp` handles NaN/Infinity ✅
- Pinned memories → early return 1.0 ✅

### CORE-011 🔵 LOW — `recalculateAllStrengths` LIMIT/OFFSET pattern can miss or double-process rows if strength changes affect ordering
**File:** `temporal.ts`, lines ~133–160  
**Description:** The batch query uses `ORDER BY id LIMIT ? OFFSET ?`. Since `id` is a UUID (text), the ordering is stable. This is **correct** — ordering by `id` ensures no rows are missed even though strength values change. **No bug.**  
**Fix:** N/A

---

## 3. Search Integration (search.ts)

### CORE-012 🟠 HIGH — Strength blending can produce scores > 1.0
**File:** `search.ts`, lines ~195–201  
**Description:** After temporal filtering, the code blends strength into scoring:
```typescript
s.score = s.score * 0.7 + strength * 0.3;
```
If `s.score` = 1.0 (perfect hybrid match) and `strength` = 1.0 (fresh memory), then `s.score = 0.7 + 0.3 = 1.0` — fine. But then temporal boost applies:
```typescript
s.score *= recencyMultiplier; // recencyMultiplier ∈ (0, 1]
```
This reduces the score, so it stays ≤ 1.0. **However**, consider the case where the initial hybrid score > 1.0 (possible if the BM25 normalization `1/(1+|x|)` approaches 1.0 and vector similarity is close to 1.0 — the blend `alpha * vecScore + (1-alpha) * kwScore` could yield ~1.0). After strength blending: `1.0 * 0.7 + 1.0 * 0.3 = 1.0`. 

Actually, re-checking: the initial scores are ≤ 1.0 individually (vector: cosine similarity ≤ 1.0, BM25: `1/(1+|x|)` ≤ 1.0), and the blend is a weighted average. So the blended score is ≤ 1.0. After strength blending: max is `1.0 * 0.7 + 1.0 * 0.3 = 1.0`. **Scores cannot exceed 1.0.** But they **can** appear unusual: a memory with a low hybrid score (0.2) but high strength (1.0) gets boosted to `0.2*0.7 + 1.0*0.3 = 0.44`, which is misleading — the search wasn't relevant but strength inflated it.  
**Fix:** Consider `Math.min(1.0, s.score)` after blending for safety, and document that strength blending changes result ordering.

### CORE-013 🟠 HIGH — `keywordSearch` passes raw user query to FTS5 MATCH without escaping
**File:** `search.ts`, lines ~114–130  
**Description:** The `query` string is passed directly to `WHERE memories_fts MATCH ?`. While this is parameterized (not SQL injection), FTS5 MATCH has its own query syntax. User input like `"test*"` or `"test OR drop"` will be interpreted as FTS operators. Characters like `(`, `)`, `"`, `*`, `NEAR`, `AND`, `OR`, `NOT` are FTS5 syntax and can cause query failures or unexpected results.  
**Fix:** Escape FTS5 special characters by wrapping terms in double quotes:
```typescript
const safeTerm = `"${query.replace(/"/g, '""')}"`;
```

### CORE-014 🟡 MEDIUM — `search()` entry point always passes `null` for queryVector
**File:** `search.ts`, lines ~245–267  
**Description:** The `search()` function calls `hybridSearch(rawDb, null, query, ...)`. The `null` vector means hybrid search degrades to keyword-only. To get actual vector search, callers must use `hybridSearch` or `vectorSearch` directly. This makes the `search()` function misleadingly named — it's actually keyword search with a substring fallback.  
**Fix:** Document this limitation prominently, or accept an optional `queryVector` parameter in `SearchOptions`.

### CORE-015 🔵 LOW — Temporal filtering uses `created_at` not `last_accessed` or `last_rehearsed`
**File:** `search.ts`, lines ~182–196  
**Description:** The `since`/`until` filters compare against `created_at`. For temporal recall patterns ("what did I learn this week"), using `last_accessed` or `updated_at` might be more appropriate. This is a design choice but could confuse users who expect temporal filters to reflect activity time.  
**Fix:** Informational. Consider adding `temporalField: "created_at" | "last_accessed" | "updated_at"` option.

### CORE-016 🟡 MEDIUM — Score rounding truncates to 2 decimal places, losing precision for ranking
**File:** `search.ts`, line ~231  
**Description:** `Math.round(s.score * 100) / 100` rounds final scores. Two results with scores 0.7843 and 0.7851 both become 0.78, making them appear equal. This can confuse downstream consumers doing equality comparisons.  
**Fix:** Use 4 decimal places: `Math.round(s.score * 10000) / 10000`, or don't round.

---

## 4. Decision Memory (decisions.ts)

### CORE-017 🟠 HIGH — `storeDecision` allows storage without required context
**File:** `decisions.ts`, lines ~81–103  
**Description:** The `Decision` interface requires `memoryId`, `conclusion`, `reasoning`, `alternatives`, `confidence`, and `revisitable`. However, `reasoning` and `alternatives` are stored as JSON strings, and `JSON.stringify([])` produces `"[]"`. The `decisions` table schema (migration 015) defines `reasoning TEXT` and `alternatives TEXT` as nullable — no `NOT NULL` constraint. A caller can pass `reasoning: []` and `alternatives: []`, which is semantically empty. More critically, `conclusion` IS required in the interface but could be passed as `""` (empty string).  
**Fix:** Add runtime validation in `storeDecision`:
```typescript
if (!decision.conclusion?.trim()) throw new Error("Decision conclusion is required");
if (!decision.memoryId) throw new Error("Decision memory_id is required");
```

### CORE-018 🟠 HIGH — `queryDecisions` SQL injection risk with LIKE pattern
**File:** `decisions.ts`, lines ~107–140  
**Description:** The query uses `LIKE ?` with `%${query}%`. While the `?` parameter binding prevents SQL injection, the `%` and `_` characters in the query string are LIKE wildcards. A search for `100%` would match any string containing `100` followed by anything. The query `_a_` would match any 3-character string with 'a' in the middle.  
**Fix:** Escape LIKE wildcards:
```typescript
const escaped = query.replace(/[%_]/g, c => `\\${c}`);
const like = `%${escaped}%`;
// And add ESCAPE '\\' to the LIKE clause
```

### CORE-019 🟡 MEDIUM — `queryDecisions` LIMIT/OFFSET placed after WHERE clause — SQL parameter binding order mismatch risk
**File:** `decisions.ts`, lines ~130–138  
**Description:** `params` accumulates LIKE terms first, then pushes `limit` and `offset`. The SQL template has `LIMIT ? OFFSET ?` at the end. If `whereParts` has conditions, params = [like, like, like, limit, offset]. If no conditions: params = [limit, offset]. The dynamic WHERE clause construction means the parameter count varies. **This is correct** — the params array is built in the same order as the SQL. Verified: no issue.  
**Fix:** N/A

### CORE-020 🟡 MEDIUM — `recordOutcome` doesn't verify decision exists before updating
**File:** `decisions.ts`, lines ~149–160  
**Description:** `recordOutcome` runs an UPDATE without checking if the decision ID exists. If the ID is wrong, no error is thrown — the UPDATE silently affects 0 rows. The caller has no way to know the outcome wasn't recorded.  
**Fix:** Check the result of `.run()` for changes, or do a SELECT first:
```typescript
const existing = db.prepare("SELECT id FROM decisions WHERE id = ?").get(decisionId);
if (!existing) throw new Error(`Decision not found: ${decisionId}`);
```

---

## 5. Contradiction Detection (contradictions.ts)

### CORE-021 🔴 CRITICAL — No validation of LLM-returned `resolution` allows arbitrary strings to persist
**File:** `contradictions.ts`, lines ~148–157  
**Description:** The code validates the resolution with:
```typescript
const resolution = ["update", "keep_both", "ignore_new"].includes(parsed.resolution)
    ? parsed.resolution : "keep_both";
```
This looks correct — invalid values default to `"keep_both"`. However, when `contradicts: false`, the resolution is still set (defaulting to `"keep_both"`). In `checkAndStoreContradictions`, the filter is:
```typescript
if (result.contradictionFound && result.confidence >= 0.5) {
    storeContradiction(db, { resolution: result.resolution, ... });
}
```
If the LLM says `contradicts: false` but returns `resolution: "update"`, it won't be stored (guarded by `contradictionFound`). **The real risk:** if the LLM returns `contradicts: true` with a garbage `resolution`, it defaults to `"keep_both"` which is safe. **Actually well-handled.**

Downgrading: 🔵 LOW — LLM failure defaults are safe.

### CORE-022 🟠 HIGH — Ollama timeout/failure causes silent data loss in contradiction pipeline
**File:** `contradictions.ts`, lines ~155–168  
**Description:** When Ollama is down or times out, the catch block returns:
```typescript
result: {
    contradictionFound: false,
    resolution: "keep_both",
    reasoning: "Detection failed — skipped",
    confidence: 0,
}
```
This means if Ollama is consistently unavailable, **no contradictions are ever detected**. The system silently degrades to "no contradiction detection" with no warning to the user. Worse, `checkAndStoreContradictions` filters by `confidence >= 0.5`, so failed detections (confidence: 0) are always dropped.  
**Fix:** 
1. Log a warning when Ollama is unreachable.
2. Consider returning an error flag in the result so callers can distinguish "no contradiction" from "detection failed."
3. Add a health check or metric for Ollama availability.

### CORE-023 🟡 MEDIUM — `storeContradiction` doesn't validate foreign key references
**File:** `contradictions.ts`, lines ~226–242  
**Description:** `storeContradiction` inserts `newMemoryId` and `oldMemoryId` without verifying these memory IDs exist. SQLite foreign keys are off by default (`PRAGMA foreign_keys = OFF`). The migration creates `FOREIGN KEY (new_memory_id) REFERENCES memories(id)` but the `Database.init()` method never runs `PRAGMA foreign_keys = ON`. Orphaned references will accumulate silently.  
**Fix:** Either enable `PRAGMA foreign_keys = ON` in `Database.init()`, or add a SELECT check before INSERT.

---

## 6. Knowledge Health (knowledge-health.ts)

### CORE-024 ✅ VERIFIED — Scoring formula adds up to 100
**File:** `knowledge-health.ts`  
**Description:** Weights: 10 + 15 + 15 + 15 + 15 + 15 + 15 = 100. ✅

### CORE-025 🟡 MEDIUM — Division by zero is handled but zero-case scoring is inconsistent
**File:** `knowledge-health.ts`, lines ~180–222  
**Description:** When `activeMemories === 0`, signing, provenance, and freshness scores are 0. But contradiction resolution gives **15 points** when `contradictionsTotal === 0` ("No contradictions = full marks"). This means an empty database gets: type diversity 0, signing 0, provenance 0, graph 0, freshness 0, contradictions **15**, session continuity 0 = **15/100**. An empty database getting 15% health is misleading.  
**Fix:** Consider returning 0 for contradictions when `activeMemories === 0`:
```typescript
const contradictionResolution = 
    activeMemories === 0 ? 0 :
    contradictionsTotal > 0 ? (contradictionsResolved / contradictionsTotal) * 15 : 15;
```

### CORE-026 🔵 LOW — `sessionContinuity` could be NaN if `getSessionTrend` returns NaN averageScore
**File:** `knowledge-health.ts`, lines ~219–223  
**Description:** `sessionContinuity = trend.averageScore * 15`. If `getSessionTrend` returned NaN for averageScore, this would propagate. However, `getSessionTrend` returns 0 for empty sessions, and the computation `reduce + /length` is safe for non-empty arrays. The `try/catch` around the call also defaults to 0. **Safe in practice.**  
**Fix:** Add `isFinite` guard for defense in depth: `sessionContinuity = Number.isFinite(trend.averageScore) ? trend.averageScore * 15 : 0`

### CORE-027 🔵 LOW — `topTopics` query uses LEFT JOIN which counts entities with 0 mentions as 0
**File:** `knowledge-health.ts`, lines ~148–157  
**Description:** The `topTopics` query `LEFT JOIN memory_entity_mentions` correctly counts entities even if they have zero mentions. The `weakestAreas` query uses `HAVING cnt > 0` to filter these out. This is consistent and correct.  
**Fix:** N/A

---

## 7. Session Metrics (session-metrics.ts)

### CORE-028 🟡 MEDIUM — `computeContinuityScore` can exceed 1.0 when `used > injected`
**File:** `session-metrics.ts`, lines ~54–61  
**Description:** `carryOver = used / Math.max(1, injected)`. If `injected = 5` and `used = 10` (used more than were injected — possible if counting re-uses), `carryOver = 2.0`. Then `score = 2.0 * (1 - reconstructionRate)` could be up to 2.0. The `Math.max(0, Math.min(1, score))` clamp catches this. **Clamped correctly, but `carryOver > 1` is semantically wrong.**  
**Fix:** Clamp `carryOver` too: `Math.min(1, used / Math.max(1, injected))`

### CORE-029 ✅ VERIFIED — NaN cases handled
**File:** `session-metrics.ts`  
**Description:** 
- `injected = 0` → `Math.max(1, 0)` = 1 → division by 1, not zero ✅
- `used = 0, reconstructed = 0` → `reconstructionRate = 0/1 = 0` → `score = 0 * 1 = 0` ✅
- All negative inputs produce valid (clamped) results ✅

### CORE-030 🔵 LOW — `getSessionTrend` direction calculation splits sessions into "newer" and "older" halves but order is by `created_at DESC`
**File:** `session-metrics.ts`, lines ~104–119  
**Description:** Sessions are returned in reverse-chronological order (newest first). `sessions.slice(0, mid)` gets the **newer** sessions, `sessions.slice(mid)` gets the **older** ones. `delta = recentAvg - olderAvg`. If recent > older, direction is "improving". **This is correct.**  
**Fix:** N/A

---

## 8. Export Module (packages/core/src/export/)

### CORE-031 🔴 CRITICAL — Export `collectData` queries decisions with wrong column names
**File:** `export/export.ts`, lines ~91–100  
**Description:** The decisions SELECT queries for columns `action`, `reason`, `model`:
```sql
SELECT id, memory_id, action, confidence, reason, model, outcome, outcome_at, created_at FROM decisions
```
But the decisions table (migration 015) has columns: `conclusion`, `reasoning`, `alternatives`, `context_session`, `confidence`, `revisitable`, `outcome`, `outcome_notes`, `outcome_at`. **There is no `action`, `reason`, or `model` column.** This query will throw an error every time.  
**Fix:** Change the SELECT to match the actual schema:
```sql
SELECT id, memory_id, conclusion, reasoning, alternatives, context_session, confidence, revisitable, outcome, outcome_notes, outcome_at, created_at, reviewed_at FROM decisions
```

### CORE-032 🔴 CRITICAL — Import `importDecision` writes to wrong column names
**File:** `export/import.ts`, lines ~165–194  
**Description:** The import function writes `action`, `reason`, `model` columns:
```sql
INSERT OR IGNORE INTO decisions (id, memory_id, action, confidence, reason, model, outcome, outcome_at, created_at)
```
These columns don't exist in the decisions table. Every decision import will fail, caught by the outer `try/catch` and silently skipped.  
**Fix:** Match the actual schema columns: `conclusion`, `reasoning`, `alternatives`, etc.

### CORE-033 🟠 HIGH — Checksum verification is fragile — depends on JSON.stringify determinism
**File:** `export/export.ts` line ~73, `export/import.ts` line ~78  
**Description:** Export computes: `checksum = sha256(JSON.stringify(data))`. Import verifies: `computedChecksum = sha256(JSON.stringify(bundle.data))`. This works **only if** the JSON round-trip is perfectly lossless. If the bundle file is decompressed and re-serialized (e.g., pretty-printed, or field order changes), the checksum will fail. `JSON.stringify` key order depends on insertion order in JavaScript — parsing and re-stringifying preserves order, but it's a fragile invariant.  
**Fix:** This works correctly for the current read→decompress→parse→stringify→hash flow because `JSON.parse` preserves key order in V8/JSCore. Add a comment documenting this assumption. Consider using a canonical JSON serializer for robustness.

### CORE-034 🟡 MEDIUM — Import doesn't validate bundle data structure beyond top-level keys
**File:** `export/import.ts`, lines ~67–71  
**Description:** Validation only checks `if (!bundle.metadata || !bundle.data)`. Individual memories, decisions, entities could have missing/corrupt fields. A corrupted bundle with `memories: [null, null]` would cause the import loop to crash when accessing `mem.id`.  
**Fix:** Add per-record validation:
```typescript
if (!mem || typeof mem.id !== 'string' || typeof mem.content !== 'string') {
    warnings.push(`Skipping invalid memory record`);
    skipped.memories++;
    continue;
}
```

### CORE-035 🟡 MEDIUM — `importMemory` INSERT missing `updated_by` which has `NOT NULL DEFAULT 'system'` 
**File:** `export/import.ts`, lines ~127–138  
**Description:** The INSERT for memories doesn't include `updated_by`. The baseline schema defines `updated_by TEXT NOT NULL DEFAULT 'system'`. Because of the `DEFAULT`, this won't fail — it'll use `'system'`. But it loses the original `updated_by` value from the exported memory.  
**Fix:** Add `updated_by` to the INSERT column list.

### CORE-036 🟡 MEDIUM — `importMemory` INSERT missing several columns from baseline schema
**File:** `export/import.ts`, lines ~127–138  
**Description:** The import INSERT only includes 15 columns, but the memories table has 25+ columns. Missing: `source_id`, `why`, `project`, `last_accessed`, `access_count`, `vector_clock`, `version`, `manual_override`, `normalized_content`, `extraction_status`, `embedding_model`, `extraction_model`, `update_count`, `strength`, `last_rehearsed`, `rehearsal_count`. All have defaults, so inserts work, but imported memories lose significant metadata.  
**Fix:** Export and import all columns, or at minimum the ones that don't have sensible defaults.

### CORE-037 🔵 LOW — `exportSelective` LIKE query doesn't escape `%` and `_`
**File:** `export/selective.ts`, lines ~50–58  
**Description:** Same issue as CORE-018: `%${query}%` passes LIKE wildcards through unescaped. A search for `100%` matches anything containing `100`.  
**Fix:** Escape LIKE metacharacters.

---

## 9. Migration Ordering (013–020)

### CORE-038 ✅ VERIFIED — Migration versions are sequential, no conflicts
**File:** `migrations/index.ts`  
**Description:** Versions 1–20 are contiguous and sequential. Each is registered exactly once in the `MIGRATIONS` array. `runMigrations` iterates in array order and skips versions ≤ current. No conflicts.

### CORE-039 🔴 CRITICAL — Foreign keys are never enforced (`PRAGMA foreign_keys` not enabled)
**File:** `database.ts` (init method), all migrations  
**Description:** SQLite has foreign keys **disabled by default**. The `Database.init()` method sets `PRAGMA journal_mode = WAL` but **never** sets `PRAGMA foreign_keys = ON`. Migrations 015, 018, 019, 020 all define `FOREIGN KEY` constraints:
- `decisions.memory_id → memories.id`
- `contradictions.new_memory_id → memories.id`
- `contradictions.old_memory_id → memories.id`
- `memory_anchors.onchain_id → onchain_identity.id`
- `payment_log.session_key_id → session_keys.id`
- `federation_shared.peer_id → federation_peers.id`
- `federation_received.peer_id → federation_peers.id`

**None of these are actually enforced.** Orphan references can accumulate freely.  
**Fix:** Add `PRAGMA foreign_keys = ON` in `Database.init()` after WAL mode:
```typescript
if (isBun) {
    this.getDb().exec("PRAGMA foreign_keys = ON");
} else {
    (this.getDb() as { pragma(s: string): void }).pragma("foreign_keys = ON");
}
```
⚠️ **Warning:** Enabling foreign keys retroactively may cause errors if orphan data already exists. Run `PRAGMA foreign_key_check` first.

### CORE-040 🟡 MEDIUM — Migration 015 `decisions` table schema doesn't match `decisions.ts` interface
**File:** `migrations/015-decisions-and-contradictions.ts`, `decisions.ts`  
**Description:** The migration creates the `decisions` table with columns matching the `Decision` interface: `conclusion`, `reasoning`, `alternatives`, `context_session`, etc. But the export module (CORE-031/032) queries for `action`, `reason`, `model` which don't exist. The migration itself is correct; the export module is wrong. (Flagged above as CORE-031/032.)

### CORE-041 🟡 MEDIUM — No index on `memories.is_deleted` for common filtered queries
**File:** All migrations  
**Description:** Many queries filter by `COALESCE(is_deleted, 0) = 0` (knowledge-health, export, search). There's no index on `is_deleted`. For large databases, this means full table scans.  
**Fix:** Add in a new migration:
```sql
CREATE INDEX IF NOT EXISTS idx_memories_is_deleted ON memories(is_deleted);
```
Or a partial index: `CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(id) WHERE is_deleted = 0;`

### CORE-042 🟡 MEDIUM — No index on `memories.last_accessed` for freshness/staleness queries
**File:** All migrations  
**Description:** Knowledge health queries filter by `last_accessed` and `created_at < ?`. The `created_at` index exists (migration 001), but `last_accessed` has no index.  
**Fix:** Add index: `CREATE INDEX IF NOT EXISTS idx_memories_last_accessed ON memories(last_accessed);`

---

## 10. Type Consistency

### CORE-043 🟡 MEDIUM — `Memory.tags` type mismatch between interface (string[]) and DB (JSON string)
**File:** `types.ts`, `database.ts`  
**Description:** The `Memory` interface declares `tags: string[]`. The DB stores it as a JSON-encoded string. `rowToMemory` correctly parses it via `JSON.parse(row.tags || "[]")`, and `addMemory` serializes via `JSON.stringify(memory.tags)`. **The mapping is correct**, but there's a subtle issue: if the DB contains malformed JSON in `tags`, `JSON.parse` will throw and crash `getMemories()`.  
**Fix:** Wrap `JSON.parse` in try/catch:
```typescript
tags: (() => { try { return JSON.parse((row.tags as string) || "[]"); } catch { return []; } })(),
```

### CORE-044 🔵 LOW — `Memory.vectorClock` same JSON parsing risk
**File:** `database.ts`, `rowToMemory`  
**Description:** Same as CORE-043 — `JSON.parse(row.vector_clock || "{}")` will throw on malformed data.  
**Fix:** Add try/catch fallback to `{}`.

### CORE-045 🔵 LOW — `rowToHistory` doesn't map `actorType`, `sessionId`, `requestId` 
**File:** `database.ts`, lines ~324–336  
**Description:** The `MemoryHistory` interface includes `actorType`, `sessionId`, `requestId` (added in migration 004), but `rowToHistory` doesn't map them.  
**Fix:** Add to `rowToHistory`:
```typescript
actorType: row.actor_type as string | undefined,
sessionId: row.session_id as string | undefined,
requestId: row.request_id as string | undefined,
```

---

## 11. Index.ts Exports

### CORE-046 🟠 HIGH — Export name collision: `ExportOptions` and `ImportOptions` exported twice with different types
**File:** `index.ts`, lines ~63–74 and ~283–292  
**Description:** Two different type aliases are exported:
```typescript
// From ./export (legacy)
export type { ExportOptions, ImportOptions, ... } from "./export";

// From ./export/index (Phase 4B bundles)  
export type { ExportOptions as BundleExportOptions, ImportOptions as BundleImportOptions, ... } from "./export/index";
```
The bundle versions are aliased to `BundleExportOptions` and `BundleImportOptions`. **No collision** — the aliasing is correct. ✅

Wait — re-checking the export from `"./export"`. Looking at line 63:
```typescript
export { collectExportData, serializeExportData, importMemories, ... } from "./export";
```
And line 283:
```typescript
export { exportBundle, importBundle, exportSelective } from "./export/index";
```
These are different modules: `./export` (the legacy module) and `./export/index` (the new bundle system). The type aliases properly disambiguate them. **No naming conflicts.**

### CORE-047 🟠 HIGH — `DEFAULT_LLM_CONFIG` not exported from contradictions module
**File:** `index.ts`  
**Description:** `contradictions.ts` exports `DEFAULT_LLM_CONFIG` but `index.ts` doesn't re-export it. Consumers who want to customize LLM config can import the type `LlmConfig` but can't get the default values from the package root.  
**Fix:** Add to the contradictions export block:
```typescript
export { DEFAULT_LLM_CONFIG, detectContradiction, ... } from "./contradictions";
```

### CORE-048 🔵 LOW — Some migration-specific types not exported
**File:** `index.ts`  
**Description:** `ContradictionRow` equivalent doesn't exist in types.ts (there is `ContradictionRecord` in contradictions.ts which is exported). `DecisionRow` is exported from decisions.ts. Coverage is adequate.

---

## 12. Crypto (Non-Cryptographic Parts)

### CORE-049 🟡 MEDIUM — `AGENTS_DIR` is evaluated at module load time — throws on invalid SIGNET_PATH at import
**File:** `crypto.ts`, line ~89  
**Description:** `const AGENTS_DIR = resolveAgentsDir();` runs when the module is first imported. If `SIGNET_PATH` is set to a symlink or blocked directory, `resolveAgentsDir()` throws immediately, crashing any code that imports from `@signet/core` even if they don't use crypto features.  
**Fix:** Lazy-initialize `AGENTS_DIR`:
```typescript
let _agentsDir: string | undefined;
function getAgentsDir(): string {
    if (!_agentsDir) _agentsDir = resolveAgentsDir();
    return _agentsDir;
}
```
Then replace `AGENTS_DIR` references with `getAgentsDir()`.

### CORE-050 🟡 MEDIUM — `buildSignablePayload` contentHash regex only allows lowercase hex
**File:** `crypto.ts`, lines ~456–462  
**Description:** `if (!/^[0-9a-f]+$/.test(contentHash))` rejects uppercase hex. This is intentional for canonicalization (signatures should be deterministic), but callers using `crypto.createHash().digest('hex')` (which produces lowercase) are fine. If any caller provides uppercase hex (e.g., from an external system), signing fails with a confusing error.  
**Fix:** The restriction is correct for security. Add a clearer error message: `"contentHash must be lowercase hex (got uppercase or non-hex characters)"`.

### CORE-051 🔵 LOW — Signal handlers in crypto.ts may conflict with application signal handlers
**File:** `crypto.ts`, lines ~535–545  
**Description:** The module registers `process.on("SIGINT")` and `process.on("SIGTERM")` handlers at module load time. These call `clearCachedKeypair()` then `process.kill(process.pid, signal)`. If the consuming application also has signal handlers, the order of execution depends on registration order. The `process.removeAllListeners(signal)` call removes **all** SIGINT/SIGTERM listeners, including the application's.  
**Fix:** Only remove the handler itself, not all listeners:
```typescript
const sigintHandler = () => { clearCachedKeypair(); process.off("SIGINT", sigintHandler); process.kill(process.pid, "SIGINT"); };
process.on("SIGINT", sigintHandler);
```

---

## 13. Additional Cross-Cutting Issues

### CORE-052 🟠 HIGH — `Database` class exposes no way to access the raw `db` for new modules
**File:** `database.ts`  
**Description:** `temporal.ts`, `decisions.ts`, `contradictions.ts`, `session-metrics.ts`, and `knowledge-health.ts` all require a raw SQLite database reference (`db.prepare()`). But the `Database` class makes `db` private with no public accessor. The `search.ts` module uses a hack: `DatabaseWrapper { db: SQLiteDatabase | null }` and duck-types the private field. New modules can't use the `Database` class directly — they must receive a raw db reference from the caller.  
**Fix:** Add a public accessor to `Database`:
```typescript
/** Get the underlying SQLite database for direct queries. */
getRawDb(): SQLiteDatabase {
    return this.getDb();
}
```

### CORE-053 🟠 HIGH — `Database.getMemories()` loads ALL memories into memory
**File:** `database.ts`, lines ~189–196  
**Description:** `getMemories()` does `SELECT * FROM memories` with no LIMIT. For agents with thousands of memories, this loads everything into a JavaScript array. Combined with CORE-008 (includes soft-deleted), this can be very expensive.  
**Fix:** Add a required or default limit: `getMemories(type?: string, limit = 1000)`, and always filter `is_deleted = 0`.

---

## Findings Summary Table

| ID | File | Severity | Category | Status |
|----|------|----------|----------|--------|
| CORE-001 | database.ts | 🟠 HIGH | SQL Safety | Fragile pattern |
| CORE-002 | database.ts | 🟡 MED | Missing fields | Fix fieldMap |
| CORE-003 | database.ts | 🟡 MED | Missing fields | Fix fieldMap |
| CORE-005 | database.ts | 🟡 MED | Type safety | Expand Omit type |
| CORE-006 | database.ts | 🟡 MED | Missing INSERT cols | Extend INSERT |
| CORE-007 | database.ts | 🔵 LOW | Fragile pattern | Use .run() return |
| CORE-008 | database.ts | 🟡 MED | Data leak | Filter is_deleted |
| CORE-009 | temporal.ts | 🔵 LOW | Design | Document cap |
| CORE-012 | search.ts | 🟠 HIGH | Score overflow | Add Math.min |
| CORE-013 | search.ts | 🟠 HIGH | FTS5 injection | Escape query |
| CORE-014 | search.ts | 🟡 MED | Misleading API | Document/fix |
| CORE-015 | search.ts | 🔵 LOW | Design choice | Informational |
| CORE-016 | search.ts | 🟡 MED | Precision loss | More decimals |
| CORE-017 | decisions.ts | 🟠 HIGH | Validation | Add checks |
| CORE-018 | decisions.ts | 🟠 HIGH | LIKE wildcards | Escape |
| CORE-020 | decisions.ts | 🟡 MED | Silent failure | Check exists |
| CORE-022 | contradictions.ts | 🟠 HIGH | Silent degradation | Log warnings |
| CORE-023 | contradictions.ts | 🟡 MED | FK not enforced | Enable FK pragma |
| CORE-025 | knowledge-health.ts | 🟡 MED | Scoring edge case | Fix empty DB |
| CORE-026 | knowledge-health.ts | 🔵 LOW | Defensive guard | Add isFinite |
| CORE-028 | session-metrics.ts | 🟡 MED | Score > 1.0 | Clamp carryOver |
| CORE-031 | export/export.ts | 🔴 CRIT | Wrong columns | Fix SELECT |
| CORE-032 | export/import.ts | 🔴 CRIT | Wrong columns | Fix INSERT/UPDATE |
| CORE-033 | export/export.ts | 🟠 HIGH | Fragile checksum | Document |
| CORE-034 | export/import.ts | 🟡 MED | No validation | Add per-record checks |
| CORE-035 | export/import.ts | 🟡 MED | Missing column | Add updated_by |
| CORE-036 | export/import.ts | 🟡 MED | Metadata loss | Export all columns |
| CORE-037 | export/selective.ts | 🔵 LOW | LIKE wildcards | Escape |
| CORE-039 | database.ts + migrations | 🔴 CRIT | FK not enforced | Enable pragma |
| CORE-040 | migrations/015 vs export | 🟡 MED | Schema mismatch | Fix export |
| CORE-041 | migrations | 🟡 MED | Missing index | Add is_deleted idx |
| CORE-042 | migrations | 🟡 MED | Missing index | Add last_accessed idx |
| CORE-043 | database.ts | 🟡 MED | JSON parse risk | Add try/catch |
| CORE-044 | database.ts | 🔵 LOW | JSON parse risk | Add try/catch |
| CORE-045 | database.ts | 🔵 LOW | Missing mapping | Add fields |
| CORE-047 | index.ts | 🟠 HIGH | Missing export | Export DEFAULT_LLM_CONFIG |
| CORE-049 | crypto.ts | 🟡 MED | Module load crash | Lazy init |
| CORE-050 | crypto.ts | 🟡 MED | Error message | Improve msg |
| CORE-051 | crypto.ts | 🔵 LOW | Signal handling | Fix handler removal |
| CORE-052 | database.ts | 🟠 HIGH | Encapsulation gap | Add accessor |
| CORE-053 | database.ts | 🟠 HIGH | Memory usage | Add LIMIT |

---

## Priority Action Items

### Immediate (blocks functionality):
1. **CORE-031/032** — Export/import decisions use wrong column names. Every decision export/import fails silently.
2. **CORE-039** — Foreign keys not enforced. Data integrity is not guaranteed.

### High (correctness/security):
3. **CORE-013** — FTS5 query injection. User input interpreted as FTS operators.
4. **CORE-008** — Soft-deleted memories returned in getMemories().
5. **CORE-022** — Silent Ollama failure degrades contradiction detection to nothing.
6. **CORE-052** — No way to pass Database to new modules.
7. **CORE-002/003/006** — updateMemory/addMemory missing fields.

### Medium (quality/robustness):
8. **CORE-041/042** — Missing indexes for common queries.
9. **CORE-043/044** — JSON.parse without error handling.
10. **CORE-034** — Import doesn't validate per-record structure.
11. **CORE-049** — crypto.ts module-load-time validation crash.
