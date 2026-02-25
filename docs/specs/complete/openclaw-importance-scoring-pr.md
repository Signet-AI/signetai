---
title: "OpenClaw Upstream PR: Importance-Aware Score Blending"
---

# OpenClaw Upstream PR: Importance-Aware Score Blending

## Context

OpenClaw's `memory-lancedb` plugin stores an `importance` field (0-1,
default 0.7) on every memory entry, but `MemoryDB.search()` ignores it
entirely — results are ranked purely by L2 vector distance. This is a
clear gap: the field is stored but never used.

This is PR 2 from our Wave 1 campaign in
`docs/wip/openclaw-integration-strategy.md`. ~25 lines of logic, zero
new dependencies, no migration, backward compatible.

## Workflow

1. Open a GitHub Discussion (requires Nicholai to post — external action)
2. Simultaneously prepare the code on a local branch in `/mnt/work/dev/clawdbot/`
3. `git fetch && git pull` the clone first to get latest upstream
4. Submit PR once Discussion gets green light

## Implementation

### Step 1: Update the clone

```bash
cd /mnt/work/dev/clawdbot && git fetch origin && git pull origin main
git checkout -b feat/importance-scoring
```

### Step 2: Add helper + constant to `extensions/memory-lancedb/index.ts`

Place above `MemoryDB` class, after the Types section:

```ts
const IMPORTANCE_BLEND = 0.5;

export function blendImportance(
  vectorScore: number,
  importance: number | undefined,
): number {
  const clamped = Math.max(0, Math.min(1, importance ?? 0.7));
  return vectorScore * (IMPORTANCE_BLEND + IMPORTANCE_BLEND * clamped);
}
```

Export the function so tests can import it directly.

Formula behavior:
- importance=1.0 -> multiplier=1.0 (full score)
- importance=0.7 -> multiplier=0.85 (default, slight discount)
- importance=0.0 -> multiplier=0.5 (halved)

### Step 3: Modify `MemoryDB.search()`

```ts
async search(vector: number[], limit = 5, minScore = 0.5): Promise<MemorySearchResult[]> {
    await this.ensureInitialized();

    // Over-fetch so importance re-ranking can surface entries
    // beyond the top-N by pure vector distance
    const candidateLimit = Math.min(limit * 3, 50);
    const results = await this.table!.vectorSearch(vector).limit(candidateLimit).toArray();

    const mapped = results.map((row) => {
        const distance = row._distance ?? 0;
        const vectorScore = 1 / (1 + distance);
        const score = blendImportance(vectorScore, row.importance as number);
        return {
            entry: {
                id: row.id as string,
                text: row.text as string,
                vector: row.vector as number[],
                importance: row.importance as number,
                category: row.category as MemoryEntry["category"],
                createdAt: row.createdAt as number,
            },
            score,
        };
    });

    return mapped
        .filter((r) => r.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
}
```

### Step 4: Write tests

Locate existing test file pattern in the OpenClaw repo. Write:

- **Unit tests** for `blendImportance()`:
  - importance=0.0 -> score halved
  - importance=0.7 -> score * 0.85
  - importance=1.0 -> score unchanged
  - undefined -> defaults to 0.7 behavior
  - out-of-range (1.5, -0.3) -> clamped to [0,1]

- **Integration test** (if test infra supports LanceDB):
  - Store two memories: A (low importance 0.1) and B (high importance 0.95)
  - Search with vector closer to A
  - Verify B ranks above A in results due to importance boost

- **Behavioral tests**:
  - `minScore` filter applies to composite score
  - Result count respects `limit` after re-sort
  - Results are sorted descending by composite score

### Step 5: Run validation

```bash
pnpm build && pnpm check && pnpm test
```

## Files to Modify

| File | Change |
|------|--------|
| `extensions/memory-lancedb/index.ts` | Add `IMPORTANCE_BLEND`, `blendImportance()`, modify `search()` |
| Test file (TBD — match existing pattern) | Add unit + integration tests |

## PR Details

**Title:** `feat(memory-lancedb): importance-aware score blending in search`

**Key points for PR description:**
- importance field exists but is unused in search ranking
- formula: `score = vectorScore * (0.5 + 0.5 * importance)`
- 3x over-fetch with cap at 50 for re-ranking headroom
- backward compat: default importance 0.7 gives 0.85 multiplier
- no new deps, no migration, no schema change
- AI-assisted, fully tested

**Security impact:** None — read-path only, in-memory computation.

**Rollback:** Single `git revert`. No persistent state changes.

## Discussion Draft

**Title:** `memory-lancedb: wire importance into search scoring`

**Body:**
The `importance` field is stored on every memory entry but `MemoryDB.search()`
doesn't use it — results are ranked purely by L2 vector distance. Proposing a
small change (~25 lines) to blend importance into the final score:

`score = vectorScore * (0.5 + 0.5 * importance)`

This keeps vector similarity as the dominant signal while letting importance
break ties and surface high-priority memories. Default importance (0.7) gives
a multiplier of 0.85, so existing behavior shifts minimally.

No new dependencies, no migration, backward compatible. Happy to submit a PR
if this direction looks good.

## Verification

1. `git fetch && git pull` the clone
2. Branch, implement, test locally
3. `pnpm build && pnpm check && pnpm test` must pass
4. Manual test: store memories with importance 0.1 and 0.9, verify
   high-importance surfaces first at similar vector distances
