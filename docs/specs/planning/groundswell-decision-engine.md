# Signet Decision Engine: SUPERSEDE/CONFLICT Extension Spec

**Status:** Draft  
**Author:** buba (subagent)  
**Reviewer:** Nicholai  
**Date:** 2026-03-28  
**Context:** Groundswell community memory — extending the single-agent decision engine to support multi-author knowledge with disagreement modeling.

---

## Table of Contents

1. [Current State](#1-current-state)
2. [Proposed Changes](#2-proposed-changes)
3. [Type Changes](#3-type-changes-typests)
4. [Decision.ts Changes](#4-decisionts-changes)
5. [Contradiction.ts Changes](#5-contradictionts-changes)
6. [Supersession.ts Changes](#6-supersessionts-changes)
7. [Migration](#7-database-migration)
8. [Backwards Compatibility](#8-backwards-compatibility)

---

## 1. Current State

### 1.1 DECISION_ACTIONS (types.ts)

```typescript
export const DECISION_ACTIONS = ["add", "update", "delete", "none"] as const;
export type DecisionAction = (typeof DECISION_ACTIONS)[number];
```

### 1.2 Decision-Related Types (types.ts)

```typescript
export interface DecisionProposal {
  readonly action: DecisionAction;
  readonly targetMemoryId?: string;
  readonly confidence: number;
  readonly reason: string;
}

export interface DecisionResult {
  readonly proposals: readonly DecisionProposal[];
  readonly warnings: readonly string[];
}

// Knowledge Architecture attribute statuses
export const ATTRIBUTE_STATUSES = ["active", "superseded", "deleted"] as const;
export type AttributeStatus = (typeof ATTRIBUTE_STATUSES)[number];

// Dependency types already include these primitives:
export const DEPENDENCY_TYPES = [
  // ...
  "contradicts",
  "supersedes",
  // ...
] as const;
```

### 1.3 Decision Engine (decision.ts)

**Key function signatures:**

```typescript
// Main entry point
export async function runShadowDecisions(
  facts: readonly ExtractedFact[],
  accessor: DbAccessor,
  provider: LlmProvider,
  cfg: DecisionConfig,
): Promise<FactDecisionResult>;

// Internal types
export interface FactDecisionProposal {
  readonly action: DecisionAction;
  readonly targetMemoryId?: string;
  readonly confidence: number;
  readonly reason: string;
  readonly fact: ExtractedFact;
  readonly targetContent?: string;
}

export interface FactDecisionResult {
  readonly proposals: readonly FactDecisionProposal[];
  readonly warnings: readonly string[];
}
```

**Decision flow today:**

1. For each extracted fact, `findCandidates()` retrieves top-5 similar memories via hybrid BM25+vector search
2. If no candidates → immediate `add` proposal
3. If candidates exist → build prompt with 4 actions (`add | update | delete | none`), send to LLM
4. Parse and validate JSON response; `update`/`delete` must reference a valid candidate ID
5. All proposals collected into `FactDecisionResult`

**The LLM prompt (verbatim):**

```
Actions:
- "add": New fact has no good match, should be stored as new memory
- "update": New fact supersedes or refines an existing candidate (specify targetId). Ensure the merged result is self-contained
- "delete": New fact contradicts/invalidates a candidate (specify targetId)
- "none": Fact is already covered by existing memories, skip
```

### 1.4 Contradiction Detection (contradiction.ts)

```typescript
export interface SemanticContradictionResult {
  readonly detected: boolean;
  readonly confidence: number;
  readonly reasoning: string;
}

export async function detectSemanticContradiction(
  factContent: string,
  targetContent: string,
  provider: LlmProvider,
  timeoutMs?: number,
): Promise<SemanticContradictionResult>;
```

Returns a binary `detected: boolean`. No classification of contradiction *type*.

### 1.5 Supersession (supersession.ts)

Operates at the **entity attribute** level (not raw memories):

```typescript
export interface SupersessionCandidate {
  readonly oldAttribute: EntityAttribute;
  readonly newAttribute: EntityAttribute;
  readonly method: "heuristic" | "semantic";
  readonly confidence: number;
  readonly reasoning: string;
}

export async function checkAndSupersedeForAttributes(
  accessor: DbAccessor,
  attributeIds: readonly string[],
  agentId: string,
  cfg: PipelineV2Config,
  provider?: LlmProvider,
): Promise<SupersessionResult>;
```

Uses `detectAttributeContradiction()` with 4 heuristic signals (negation polarity, antonym pairs, value conflicts, temporal markers), then optional semantic fallback via `detectSemanticContradiction()`.

**Key assumption today:** Supersession always means "newer replaces older." There is no concept of "two authors legitimately disagree" — contradictions are always resolved by marking the old one `superseded`.

### 1.6 Worker Integration (worker.ts)

The worker calls `runShadowDecisions()` on extracted facts and then either:
- **Shadow mode:** logs proposals to `memory_history`
- **Controlled-write mode:** applies ADD, UPDATE, DELETE with safety gates (confidence thresholds, semantic contradiction blocking, dedup)

The worker has **no concept of author identity** in the decision path. `agentId` is hardcoded to `"default"` in graph persistence.

### 1.7 Multi-Agent Schema (migration 043)

The `agents` table and `memories.agent_id` column exist. Each memory has an `agent_id` (defaults to `"default"`) and a `visibility` flag (`global | private | archived`). Entity attributes also carry `agent_id`.

---

## 2. Proposed Changes

### 2.1 Design Goals

In a community memory system (Groundswell), multiple agents ingest knowledge from different authors/sources. When two sources disagree about an entity attribute:

- **Single-author context** (existing behavior): Newer supersedes older. Binary.
- **Multi-author context** (new): Disagreement may be legitimate. "Artist X is hip-hop" vs "Artist X is R&B" from two different community members are both valid perspectives, not a correction.

We need to distinguish:

| Scenario | Example | Action |
|----------|---------|--------|
| **Temporal supersession** | "Lives in NYC" → (same author, later) "Lives in LA" | `SUPERSEDE` — newer replaces older |
| **Correction** | "Founded in 2020" → (authoritative source) "Founded in 2019" | `SUPERSEDE` — correction replaces error |
| **Community disagreement** | Agent A: "Genre is hip-hop" / Agent B: "Genre is R&B" | `CONFLICT` — both kept as parallel attributes with provenance |
| **Complementary info** | "Uses PostgreSQL" + "API returns JSON" | `none` — not contradictory |

### 2.2 New Decision Actions

Add `"supersede"` and `"conflict"` to `DECISION_ACTIONS`.

- **`supersede`**: Like `update`, but explicitly marks the target memory/attribute as superseded rather than overwriting its content. The target gets `status: 'superseded'` and `superseded_by` is set. The new fact is stored as a new memory. This makes the intent explicit and preserves audit trail.
- **`conflict`**: The new fact contradicts an existing one, but neither should be discarded. Both are kept as active attributes on the same aspect with full provenance. A `contradicts` dependency is created between them.

### 2.3 Author-Scoped Decision Matching

Currently `findCandidates()` searches all memories regardless of author. For multi-agent:

1. **Candidate retrieval remains global** — you need to find potential conflicts across all agents.
2. **Decision prompt receives author metadata** — the LLM sees who authored each candidate and the incoming fact.
3. **Author-scoping rules in `parseDecision()`:**
   - `supersede` is only valid when `fact.agentId === target.agentId` (same author) OR when the fact is from an authoritative/correction source.
   - `conflict` is only valid when `fact.agentId !== target.agentId` (different authors). Same-author contradictions should be `supersede` or `update`.
4. **Fallback:** If the LLM returns `conflict` for same-author, downgrade to `supersede`. If it returns `supersede` for cross-author without correction signal, escalate to `conflict`.

### 2.4 CONFLICT Path — Parallel Attributes with Provenance

When a `conflict` decision is accepted:

1. **New memory is created** (as with `add`) — the fact content is stored.
2. **No supersession** — the target memory/attribute stays `active`.
3. **A `contradicts` dependency** is created between the two entity attributes (or memories if pre-structural).
4. **Both attributes carry `agent_id`** — already supported by schema.
5. **A `conflict_group_id`** links the conflicting attributes so they can be presented together ("Community says X, but also Y").
6. **Recall surfaces conflicts** — when recalling an entity, conflicting attributes are presented as "disputed" with author provenance.

---

## 3. Type Changes (types.ts)

### 3.1 DECISION_ACTIONS

```diff
-export const DECISION_ACTIONS = ["add", "update", "delete", "none"] as const;
+export const DECISION_ACTIONS = ["add", "update", "delete", "none", "supersede", "conflict"] as const;
 export type DecisionAction = (typeof DECISION_ACTIONS)[number];
```

### 3.2 DecisionProposal — extended

```diff
 export interface DecisionProposal {
   readonly action: DecisionAction;
   readonly targetMemoryId?: string;
   readonly confidence: number;
   readonly reason: string;
+  readonly contradictionType?: ContradictionType;
+  readonly sourceAgentId?: string;
+  readonly targetAgentId?: string;
 }
```

### 3.3 New: ContradictionType

```typescript
/**
 * Classification of a contradiction between two statements.
 * Used by the decision engine to route supersede vs conflict.
 */
export const CONTRADICTION_TYPES = [
  "temporal_supersession",  // Same author, newer info replaces older
  "correction",             // Authoritative correction of factual error
  "disagreement",           // Different authors, legitimate difference of perspective
  "complementary",          // Not actually contradictory (false positive)
] as const;
export type ContradictionType = (typeof CONTRADICTION_TYPES)[number];
```

### 3.4 ATTRIBUTE_STATUSES — extended

```diff
-export const ATTRIBUTE_STATUSES = ["active", "superseded", "deleted"] as const;
+export const ATTRIBUTE_STATUSES = ["active", "superseded", "deleted", "disputed"] as const;
 export type AttributeStatus = (typeof ATTRIBUTE_STATUSES)[number];
```

`"disputed"` marks an attribute that has at least one `contradicts` dependency with another active attribute. Both sides of a dispute are `"disputed"`, not `"superseded"`.

### 3.5 EntityAttribute — extended

```diff
 export interface EntityAttribute {
   readonly id: string;
   readonly aspectId: string;
   readonly agentId: string;
   readonly memoryId: string | null;
   readonly kind: AttributeKind;
   readonly content: string;
   readonly normalizedContent: string;
   readonly confidence: number;
   readonly importance: number;
   readonly status: AttributeStatus;
   readonly supersededBy: string | null;
+  readonly conflictGroupId: string | null;
   readonly createdAt: string;
   readonly updatedAt: string;
 }
```

### 3.6 New: ConflictGroup (optional — may live only in DB)

```typescript
/**
 * Groups attributes that represent the same question with different answers
 * from different authors. E.g., "What genre is Artist X?" might have
 * conflicting answers from different community members.
 */
export interface ConflictGroup {
  readonly id: string;
  readonly aspectId: string;
  readonly description: string | null;
  readonly createdAt: string;
}
```

---

## 4. Decision.ts Changes

### 4.1 DecisionConfig — add author awareness

```diff
 export interface DecisionConfig {
   readonly embedding: EmbeddingConfig;
   readonly search: MemorySearchConfig;
   readonly timeoutMs?: number;
   readonly fetchEmbedding: (
     text: string,
     cfg: EmbeddingConfig,
   ) => Promise<number[] | null>;
+  /** When set, enables author-scoped decision logic. */
+  readonly multiAuthor?: boolean;
 }
```

### 4.2 FactDecisionProposal — extended

```diff
 export interface FactDecisionProposal {
   readonly action: DecisionAction;
   readonly targetMemoryId?: string;
   readonly confidence: number;
   readonly reason: string;
   readonly fact: ExtractedFact;
   readonly targetContent?: string;
+  readonly contradictionType?: ContradictionType;
+  readonly conflictGroupId?: string;
 }
```

### 4.3 CandidateMemory — add agent_id

```diff
 interface CandidateMemory {
   readonly id: string;
   readonly content: string;
   readonly type: string;
   readonly importance: number;
+  readonly agentId: string;
 }
```

### 4.4 fetchMemoryRows — include agent_id

```diff
 function fetchMemoryRows(
   accessor: DbAccessor,
   ids: readonly string[],
 ): CandidateMemory[] {
   if (ids.length === 0) return [];
   const placeholders = ids.map(() => "?").join(", ");
   return accessor.withReadDb(
     (db) =>
       db
         .prepare(
-          `SELECT id, content, type, importance
+          `SELECT id, content, type, importance, agent_id AS agentId
            FROM memories
            WHERE id IN (${placeholders}) AND is_deleted = 0`,
         )
         .all(...ids) as CandidateMemory[],
   );
 }
```

### 4.5 buildDecisionPrompt — author-aware variant

When `multiAuthor` is enabled, the prompt changes:

```typescript
function buildDecisionPrompt(
  fact: ExtractedFact,
  candidates: readonly CandidateMemory[],
  multiAuthor: boolean,
  factAgentId?: string,
): string {
  const candidateBlock = candidates
    .map((c, i) => {
      const authorLine = multiAuthor ? `\n    Author: ${c.agentId}` : "";
      return `[${i + 1}] ID: ${c.id}\n    Type: ${c.type}${authorLine}\n    Content: ${c.content}`;
    })
    .join("\n\n");

  const factAuthorLine = multiAuthor && factAgentId
    ? `\nFact author: ${factAgentId}`
    : "";

  const actionsBlock = multiAuthor
    ? `Actions:
- "add": New fact has no good match, should be stored as new memory
- "update": New fact refines an existing candidate without contradiction (specify targetId)
- "supersede": New fact replaces outdated info FROM THE SAME AUTHOR or is an authoritative correction (specify targetId). Use when the newer statement makes the older one obsolete.
- "conflict": New fact contradicts a candidate FROM A DIFFERENT AUTHOR. Both perspectives are valid and should be preserved with provenance. Do NOT use conflict for same-author temporal updates.
- "delete": New fact explicitly invalidates a candidate (specify targetId). Rare — prefer supersede.
- "none": Fact is already covered by existing memories, skip

Important rules:
- "supersede" is for same-author updates or authoritative corrections
- "conflict" is for cross-author disagreements where both views have merit
- If authors differ and statements contradict, prefer "conflict" over "supersede"`
    : `Actions:
- "add": New fact has no good match, should be stored as new memory
- "update": New fact supersedes or refines an existing candidate (specify targetId). Ensure the merged result is self-contained
- "delete": New fact contradicts/invalidates a candidate (specify targetId)
- "none": Fact is already covered by existing memories, skip`;

  const returnFormat = multiAuthor
    ? `{"action": "add|update|supersede|conflict|delete|none", "targetId": "candidate-id-if-applicable", "confidence": 0.0-1.0, "reason": "brief explanation", "contradictionType": "temporal_supersession|correction|disagreement|complementary"}`
    : `{"action": "add|update|delete|none", "targetId": "candidate-id-if-applicable", "confidence": 0.0-1.0, "reason": "brief explanation"}`;

  return `You are a memory management system. Given a new fact and existing memory candidates, decide the best action.

New fact (type: ${fact.type}, confidence: ${fact.confidence}):
"${fact.content}"${factAuthorLine}

Existing candidates:
${candidateBlock}

${actionsBlock}

Return a JSON object:
${returnFormat}

Return ONLY the JSON, no other text.`;
}
```

### 4.6 parseDecision — validate new actions + author-scope rules

```diff
-const VALID_ACTIONS = new Set<string>(DECISION_ACTIONS);
+const VALID_ACTIONS = new Set<string>(DECISION_ACTIONS);
+// Single-author mode only accepts the original 4 actions
+const SINGLE_AUTHOR_ACTIONS = new Set<string>(["add", "update", "delete", "none"]);

 function parseDecision(
   raw: string,
   candidateIds: ReadonlySet<string>,
   warnings: string[],
+  multiAuthor: boolean,
+  factAgentId?: string,
+  candidateAgentIds?: ReadonlyMap<string, string>,
 ): Omit<FactDecisionProposal, "fact" | "targetContent"> | null {
   // ... existing JSON parsing ...

   const action = typeof obj.action === "string" ? obj.action : "";
-  if (!VALID_ACTIONS.has(action)) {
+  const validSet = multiAuthor ? VALID_ACTIONS : SINGLE_AUTHOR_ACTIONS;
+  if (!validSet.has(action)) {
     warnings.push(`Invalid action: "${action}"`);
     return null;
   }

   const targetId = typeof obj.targetId === "string" ? obj.targetId : undefined;

-  // update/delete MUST reference a valid candidate
-  if (action === "update" || action === "delete") {
+  // update/delete/supersede/conflict MUST reference a valid candidate
+  if (action === "update" || action === "delete" || action === "supersede" || action === "conflict") {
     if (!targetId) {
       warnings.push(`${action} decision missing targetId`);
       return null;
     }
     if (!candidateIds.has(targetId)) {
       warnings.push(`Decision references non-candidate ID: "${targetId}"`);
       return null;
     }
   }

+  // Author-scope enforcement
+  let effectiveAction = action as DecisionAction;
+  if (multiAuthor && targetId && factAgentId && candidateAgentIds) {
+    const targetAgentId = candidateAgentIds.get(targetId);
+    const sameAuthor = factAgentId === targetAgentId;
+
+    if (effectiveAction === "conflict" && sameAuthor) {
+      // Same-author conflict → downgrade to supersede
+      effectiveAction = "supersede";
+      warnings.push(`Downgraded conflict→supersede: same author "${factAgentId}"`);
+    }
+
+    if (effectiveAction === "supersede" && !sameAuthor) {
+      // Cross-author supersede without correction signal → escalate to conflict
+      const contradictionType = typeof obj.contradictionType === "string"
+        ? obj.contradictionType : undefined;
+      if (contradictionType !== "correction") {
+        effectiveAction = "conflict";
+        warnings.push(`Escalated supersede→conflict: cross-author without correction`);
+      }
+    }
+  }

+  // Parse contradictionType for multi-author
+  const contradictionType = multiAuthor && typeof obj.contradictionType === "string"
+    ? obj.contradictionType as ContradictionType
+    : undefined;

   const reason = typeof obj.reason === "string" ? obj.reason.trim() : "";
   // ... rest unchanged ...

   return {
-    action: action as DecisionAction,
+    action: effectiveAction,
     targetMemoryId: targetId,
     confidence,
     reason,
+    contradictionType,
   };
 }
```

### 4.7 runShadowDecisions — thread through author context

```diff
 export async function runShadowDecisions(
   facts: readonly ExtractedFact[],
   accessor: DbAccessor,
   provider: LlmProvider,
   cfg: DecisionConfig,
+  factAgentId?: string,
 ): Promise<FactDecisionResult> {
   const proposals: FactDecisionProposal[] = [];
   const warnings: string[] = [];
+  const multiAuthor = cfg.multiAuthor === true;

   for (const fact of facts) {
     const candidates = await findCandidates(accessor, fact.content, cfg);

     if (candidates.length === 0) {
       proposals.push({
         action: "add",
         confidence: fact.confidence,
         reason: "No existing memories match this fact",
         fact,
       });
       continue;
     }

     const candidateIds = new Set(candidates.map((c) => c.id));
-    const prompt = buildDecisionPrompt(fact, candidates);
+    const candidateAgentIds = new Map(candidates.map((c) => [c.id, c.agentId]));
+    const prompt = buildDecisionPrompt(fact, candidates, multiAuthor, factAgentId);

     try {
       const output = await provider.generate(prompt, { timeoutMs: cfg.timeoutMs });
-      const proposal = parseDecision(output, candidateIds, warnings);
+      const proposal = parseDecision(
+        output, candidateIds, warnings,
+        multiAuthor, factAgentId, candidateAgentIds,
+      );
       if (proposal) {
         const targetContent = /* ... unchanged ... */;
         proposals.push({ ...proposal, fact, targetContent });
       }
     } catch (e) { /* ... unchanged ... */ }
   }

   return { proposals, warnings };
 }
```

---

## 5. Contradiction.ts Changes

### 5.1 Evolve return type from boolean to typed

The current `SemanticContradictionResult` returns `detected: boolean`. We extend it to classify the *type* of contradiction:

```diff
 export interface SemanticContradictionResult {
   readonly detected: boolean;
   readonly confidence: number;
   readonly reasoning: string;
+  readonly contradictionType?: ContradictionType;
 }
```

### 5.2 New prompt — classify contradiction type

```typescript
function buildTypedPrompt(
  factContent: string,
  targetContent: string,
  factAgentId?: string,
  targetAgentId?: string,
): string {
  const authorContext = factAgentId && targetAgentId
    ? `\nStatement A author: ${factAgentId}\nStatement B author: ${targetAgentId}`
    : "";

  return `Do these two statements contradict each other? If so, classify the type of contradiction.

Statement A: ${factContent}
Statement B: ${targetContent}${authorContext}

Return ONLY a JSON object (no markdown fences, no other text):
{"contradicts": true/false, "confidence": 0.0-1.0, "reasoning": "brief explanation", "type": "temporal_supersession|correction|disagreement|complementary"}

Contradiction types:
- "temporal_supersession": Statement A updates/replaces B because of a change over time (same source)
- "correction": Statement A fixes a factual error in B (authoritative correction)
- "disagreement": Both statements are valid perspectives from different sources — legitimate difference of opinion
- "complementary": Statements are NOT contradictory (different aspects of the same topic)

Examples:
- "Lives in NYC" vs "Lives in LA" (same author) → temporal_supersession
- "Founded in 2020" vs "Founded in 2019" (authoritative source) → correction
- "Genre is hip-hop" vs "Genre is R&B" (different community members) → disagreement
- "Uses PostgreSQL" vs "API returns JSON" → complementary (NOT a contradiction)`;
}
```

### 5.3 New function: detectTypedContradiction

```typescript
export async function detectTypedContradiction(
  factContent: string,
  targetContent: string,
  provider: LlmProvider,
  factAgentId?: string,
  targetAgentId?: string,
  timeoutMs = 120000,
): Promise<SemanticContradictionResult> {
  const noContradiction: SemanticContradictionResult = {
    detected: false,
    confidence: 0,
    reasoning: "",
  };

  try {
    const prompt = buildTypedPrompt(factContent, targetContent, factAgentId, targetAgentId);
    const raw = await provider.generate(prompt, { timeoutMs });

    // ... same JSON parsing as existing detectSemanticContradiction ...

    const detected = parsed.contradicts === true;
    const confidence = /* ... same ... */;
    const reasoning = /* ... same ... */;
    const contradictionType = typeof parsed.type === "string"
      ? parsed.type as ContradictionType
      : undefined;

    return { detected, confidence, reasoning, contradictionType };
  } catch (e) {
    // ... same error handling ...
    return noContradiction;
  }
}
```

### 5.4 Backwards compatibility

The existing `detectSemanticContradiction()` function is **unchanged**. The new `detectTypedContradiction()` is an additive function. Callers that need typed results use the new function; the old one continues to work for the existing pipeline.

---

## 6. Supersession.ts Changes

### 6.1 ContradictionResult — add type

```diff
 interface ContradictionResult {
   readonly detected: boolean;
   readonly confidence: number;
   readonly reasoning: string;
   readonly method: "heuristic" | "semantic";
+  readonly contradictionType?: ContradictionType;
 }
```

### 6.2 detectAttributeContradiction — infer type from heuristic

No changes to the detection logic itself. Add `contradictionType` to return values based on which signal fired:

```diff
   // Signal 1: Negation polarity
   if (newNeg !== oldNeg) {
     return {
       detected: true,
       confidence: 0.85,
       reasoning: "negation polarity conflict",
       method: "heuristic",
+      contradictionType: sameAuthor ? "temporal_supersession" : "disagreement",
     };
   }
```

However, the heuristic function doesn't currently receive author information. Two options:

**Option A (Recommended):** Keep heuristic author-unaware. Let `checkAndSupersedeForAttributes` handle author-based routing *after* detection. The heuristic tells you *that* a contradiction exists; the caller decides *what kind*.

**Option B:** Pass author IDs into the heuristic. Adds complexity for minimal gain since the heuristic can't reliably distinguish correction from disagreement.

### 6.3 checkAndSupersedeForAttributes — multi-author routing

```diff
 export async function checkAndSupersedeForAttributes(
   accessor: DbAccessor,
   attributeIds: readonly string[],
   agentId: string,
   cfg: PipelineV2Config,
   provider?: LlmProvider,
 ): Promise<SupersessionResult> {
```

After detecting a contradiction between `attr` and `sibling`:

```typescript
// Existing: always supersede
// New: check if same author
const sameAuthor = attr.agentId === sibling.agentId;

if (sameAuthor) {
  // Same author → supersede as before (temporal update)
  candidates.push({
    oldAttribute: sibling,
    newAttribute: attr,
    method: result.method,
    confidence: result.confidence,
    reasoning: result.reasoning,
  });
} else {
  // Different authors → create conflict, don't supersede
  conflicts.push({
    attributeA: sibling,
    attributeB: attr,
    method: result.method,
    confidence: result.confidence,
    reasoning: result.reasoning,
  });
}
```

### 6.4 New: SupersessionResult — extended

```diff
 export interface SupersessionResult {
   readonly superseded: number;
   readonly skipped: number;
   readonly candidates: readonly SupersessionCandidate[];
+  readonly conflicts: readonly ConflictCandidate[];
 }

+export interface ConflictCandidate {
+  readonly attributeA: EntityAttribute;
+  readonly attributeB: EntityAttribute;
+  readonly method: "heuristic" | "semantic";
+  readonly confidence: number;
+  readonly reasoning: string;
+}
```

### 6.5 New: applyConflict function

```typescript
function applyConflict(
  accessor: DbAccessor,
  conflict: ConflictCandidate,
  agentId: string,
  shadow: boolean,
): void {
  const event = shadow ? "conflict_proposal" : "attribute_conflict";
  const meta = JSON.stringify({
    attribute_a_id: conflict.attributeA.id,
    attribute_b_id: conflict.attributeB.id,
    method: conflict.method,
    confidence: conflict.confidence,
    reasoning: conflict.reasoning,
  });

  accessor.withWriteTx((db) => {
    if (!shadow) {
      const groupId = crypto.randomUUID();
      const ts = new Date().toISOString();

      // Mark both attributes as disputed and link to conflict group
      db.prepare(
        `UPDATE entity_attributes
         SET status = 'disputed', conflict_group_id = ?, updated_at = ?
         WHERE id = ? AND agent_id = ?`,
      ).run(groupId, ts, conflict.attributeA.id, conflict.attributeA.agentId);

      db.prepare(
        `UPDATE entity_attributes
         SET status = 'disputed', conflict_group_id = ?, updated_at = ?
         WHERE id = ? AND agent_id = ?`,
      ).run(groupId, ts, conflict.attributeB.id, conflict.attributeB.agentId);

      // Create contradicts dependency
      const depId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO entity_dependencies
         (id, source_entity_id, target_entity_id, agent_id, aspect_id,
          dependency_type, strength, confidence, reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'contradicts', ?, ?, ?, ?, ?)`,
      ).run(
        depId,
        /* source entity from attributeA */, /* target entity from attributeB */,
        agentId, conflict.attributeA.aspectId,
        conflict.confidence, conflict.confidence, conflict.reasoning,
        ts, ts,
      );

      // Create conflict_group record
      db.prepare(
        `INSERT INTO conflict_groups (id, aspect_id, description, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run(groupId, conflict.attributeA.aspectId, conflict.reasoning, ts);
    }

    insertHistoryEvent(db, {
      memoryId: conflict.attributeA.memoryId ?? conflict.attributeA.id,
      event,
      oldContent: conflict.attributeA.content,
      newContent: conflict.attributeB.content,
      changedBy: "pipeline:conflict",
      reason: conflict.reasoning,
      metadata: meta,
      createdAt: new Date().toISOString(),
    });
  });
}
```

---

## 7. Database Migration

### 7.1 New migration: 050-conflict-groups.ts

```typescript
import type { MigrationDb } from "./index";

function addColumnIfMissing(
  db: MigrationDb,
  table: string,
  column: string,
  definition: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<
    Record<string, unknown>
  >;
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/**
 * Migration 050: Conflict groups for community disagreement modeling
 *
 * 1. Adds `conflict_group_id` to entity_attributes — links disputed attributes
 * 2. Creates `conflict_groups` table — metadata for each dispute
 * 3. Updates ATTRIBUTE_STATUSES to include 'disputed' (application-level, no DDL)
 */
export function up(db: MigrationDb): void {
  // 1. conflict_group_id on entity_attributes
  addColumnIfMissing(
    db,
    "entity_attributes",
    "conflict_group_id",
    "TEXT DEFAULT NULL",
  );

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_entity_attributes_conflict_group
     ON entity_attributes(conflict_group_id) WHERE conflict_group_id IS NOT NULL`,
  );

  // 2. conflict_groups table
  db.exec(`
    CREATE TABLE IF NOT EXISTS conflict_groups (
      id          TEXT PRIMARY KEY,
      aspect_id   TEXT NOT NULL REFERENCES entity_aspects(id) ON DELETE CASCADE,
      description TEXT,
      resolved_at TEXT,
      resolution  TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_conflict_groups_aspect
      ON conflict_groups(aspect_id);
    CREATE INDEX IF NOT EXISTS idx_conflict_groups_unresolved
      ON conflict_groups(resolved_at) WHERE resolved_at IS NULL;
  `);
}
```

### 7.2 Schema additions summary

| Table | Column/Change | Purpose |
|-------|---------------|---------|
| `entity_attributes` | `conflict_group_id TEXT` | Links to conflict_groups |
| `conflict_groups` | New table | Metadata for disputes: aspect, description, resolution |
| `conflict_groups` | `resolved_at`, `resolution` | Allow future resolution workflow |

### 7.3 No changes to existing tables

- `memories` — no schema changes. `agent_id` already exists.
- `memory_history` — no schema changes. The `event` column is free-text; new events (`conflict_proposal`, `attribute_conflict`) require no DDL.
- `entity_dependencies` — no schema changes. `contradicts` is already a valid `dependency_type`.

---

## 8. Backwards Compatibility

### 8.1 Single-agent pipeline — ZERO changes

The existing pipeline is unaffected when `multiAuthor` is not set (defaults to `false`/`undefined`):

| Component | Behavior |
|-----------|----------|
| `DECISION_ACTIONS` | Array grows, but `VALID_ACTIONS` set expands — existing `"add" | "update" | "delete" | "none"` all still valid |
| `DecisionAction` type | Union grows — existing code that checks `=== "add"` etc. still works |
| `parseDecision()` | When `multiAuthor=false`, uses `SINGLE_AUTHOR_ACTIONS` set — new actions rejected as invalid |
| `buildDecisionPrompt()` | When `multiAuthor=false`, prompt is unchanged (original 4-action version) |
| `runShadowDecisions()` | New `factAgentId` parameter is optional, defaults to `undefined` |
| `detectSemanticContradiction()` | Unchanged — existing callers unaffected |
| `detectTypedContradiction()` | New function — additive, no existing callers |
| `checkAndSupersedeForAttributes()` | When all attributes have same `agentId` (typical for single-agent), `sameAuthor` is always true → always supersedes (existing behavior) |
| Worker | `agentId` is `"default"` for all memories → `sameAuthor` always true → no conflicts generated |
| Database | New column `conflict_group_id` is `DEFAULT NULL` — never populated in single-agent mode. New table `conflict_groups` exists but empty. Zero query impact. |

### 8.2 Type-level safety

All new fields on interfaces are **optional** (`?`). No existing code will break at compile time:

- `DecisionProposal.contradictionType?` — optional
- `DecisionProposal.sourceAgentId?` — optional
- `DecisionProposal.targetAgentId?` — optional
- `FactDecisionProposal.contradictionType?` — optional
- `FactDecisionProposal.conflictGroupId?` — optional
- `SemanticContradictionResult.contradictionType?` — optional
- `EntityAttribute.conflictGroupId` — nullable (`string | null`)
- `SupersessionResult.conflicts` — new required field. **One breaking change** for direct consumers of `SupersessionResult`. Mitigated by defaulting to `[]`.

### 8.3 Worker.ts changes needed

The worker must route `supersede` and `conflict` proposals through `applyPhaseCWrites`. Summary of changes:

```typescript
// In applyPhaseCWrites, add cases:
if (proposal.action === "supersede") {
  // Archive target to cold tier, create new memory, mark target as superseded.
  // Similar to existing "update" path but:
  //   1. Does NOT overwrite target content
  //   2. Creates a NEW memory for the fact
  //   3. Marks target status='superseded', superseded_by=newMemoryId
  // ... implementation follows existing update + add patterns ...
}

if (proposal.action === "conflict") {
  // Create new memory for the fact (like "add")
  // Do NOT modify the target memory
  // Create entity_dependency of type "contradicts"
  // Create or join conflict_group
  // Mark both attributes as "disputed"
  // ... implementation follows existing add path + conflict bookkeeping ...
}
```

### 8.4 Migration path

1. Apply migration 050 (additive — safe to run on any existing DB)
2. Deploy new types.ts (backwards compatible)
3. Deploy new contradiction.ts (additive function only)
4. Deploy new decision.ts (new params are optional, defaults preserve existing behavior)
5. Deploy new supersession.ts (`conflicts: []` default preserves existing behavior)
6. Deploy worker.ts changes (new action routing, only triggered when `multiAuthor=true`)
7. Enable `multiAuthor` on Groundswell agents via `DecisionConfig`

### 8.5 Rollback

If `multiAuthor` is disabled:
- New actions are never returned by the LLM (prompt doesn't offer them)
- `parseDecision` rejects them via `SINGLE_AUTHOR_ACTIONS` check
- `conflict_groups` table and `conflict_group_id` column remain but are unused
- Any existing `disputed` attributes would need manual cleanup (set back to `active`)

---

## Appendix A: Decision Flow Diagram (Multi-Author)

```
Extracted Fact (with agentId)
         │
         ▼
  findCandidates()  ──── global search (all agents' memories)
         │
         ▼
  buildDecisionPrompt()  ──── includes author metadata
         │
         ▼
  LLM returns action + contradictionType
         │
         ▼
  parseDecision()  ──── validates + enforces author-scope rules
         │
         ├── add ───────────────▶ Create new memory
         ├── update ────────────▶ Merge into target (same as today)
         ├── none ──────────────▶ Skip
         ├── delete ────────────▶ Soft-delete target (rare)
         ├── supersede ─────────▶ Archive target + create new memory + mark superseded
         └── conflict ──────────▶ Create new memory + create contradicts dep + conflict group
                                  Both attributes → status: "disputed"
```

## Appendix B: Recall Behavior for Disputed Attributes

When recalling an entity with disputed attributes, the traversal system should:

1. Group disputed attributes by `conflict_group_id`
2. Present them with author provenance: "According to [Agent A]: X. According to [Agent B]: Y."
3. Order by confidence/importance within each dispute group
4. Optionally surface resolution status if the dispute was resolved

This is a **recall-side concern** and does not require changes to the decision engine. It belongs in `graph-traversal.ts` and the recall formatter.
