# Groundswell: Community Extraction Profile System

**Status:** Draft — Implementation-Ready Spec  
**Author:** buba (for Nicholai)  
**Date:** 2026-03-28  
**Depends on:** `extraction.ts`, `aspect-feedback.ts`, `dampening.ts`, `graph-traversal.ts`, `prospective-index.ts`, `summary-condensation.ts`, `desire-paths-epic.md`

---

## Table of Contents

1. [Current Extraction](#1-current-extraction)
2. [Profile System Design](#2-profile-system-design)
3. [Community Extraction Profile](#3-community-extraction-profile)
4. [Behavioral Feedback Adaptation](#4-behavioral-feedback-adaptation)
5. [Dampening Adaptations](#5-dampening-adaptations)
6. [Prospective Indexing](#6-prospective-indexing)
7. [Summarization Hierarchy](#7-summarization-hierarchy)

---

## 1. Current Extraction

### 1.1 Limits

From `packages/daemon/src/pipeline/extraction.ts`:

```typescript
const MAX_FACTS = 20;
const MAX_ENTITIES = 15;
const MAX_FACT_LENGTH = 2000;
const MIN_FACT_LENGTH = 20;
const MAX_INPUT_CHARS = 12000;
```

### 1.2 Extraction Prompt (Verbatim)

```
Extract key facts and entity relationships from this text.

Return JSON with two arrays: "facts" and "entities".

Each fact: {"content": "...", "type": "fact|preference|decision|rationale|procedural|semantic", "confidence": 0.0-1.0}
Each entity: {"source": "...", "source_type": "person|project|system|tool|concept|skill|task|unknown", "relationship": "...", "target": "...", "target_type": "person|project|system|tool|concept|skill|task|unknown", "confidence": 0.0-1.0}

IMPORTANT — Atomic facts:
Each fact must be fully understandable WITHOUT the original conversation. Include the specific subject (package name, file path, component, tool) and enough context that a reader seeing only this fact knows exactly what it refers to.

BAD: "install() writes bundled plugin"
GOOD: "The @signet/connector-opencode install() function writes pre-bundled signet.mjs to ~/.config/opencode/plugins/"

BAD: "Uses PostgreSQL instead of MongoDB"
GOOD: "The auth service uses PostgreSQL instead of MongoDB for better relational query support"

Types: fact (objective info), preference (user likes/dislikes), decision (choices made), rationale (WHY a decision was made — reasoning, alternatives considered, tradeoffs), procedural (how-to knowledge), semantic (concepts/definitions).

When you see a decision with reasoning, extract BOTH a decision fact AND a rationale fact. The rationale should capture the WHY, including alternatives considered and tradeoffs.

[... examples ...]

Only extract durable, reusable knowledge. Skip ephemeral details.
Return ONLY the JSON object, no other text.
```

### 1.3 JSON Parsing Pipeline

The output passes through a multi-stage recovery pipeline:

1. **`stripFences()`** — removes `<think>` blocks (qwen3/deepseek CoT), extracts content from ` ```json ``` ` fences, falls back to `extractBalancedJsonArray()` for bare arrays
2. **`parseExtractionOutput()`** — tries `extractBalancedJsonObject()` on raw output first (handles bare JSON), then falls back to stripped candidates
3. **`tryParseJson()`** — attempts parse, strips trailing commas, handles double-encoded strings
4. **Validation** — `validateFact()` enforces MIN_FACT_LENGTH (20), MAX_FACT_LENGTH (2000), valid type enum, confidence clamp [0,1]. `validateEntity()` requires non-empty source, target, relationship.
5. **`parseRawExtractionOutput()`** — public entry point, returns `ExtractionResult { facts, entities, warnings }` with truncation at MAX_FACTS/MAX_ENTITIES

### 1.4 What This Means for Profiles

The current extraction is hardcoded for a **personal agent** context:
- Types are individual-centric (preference, decision, rationale)
- Entity types are project/tool/person-focused
- Examples model 1:1 user↔agent conversations
- Limits are tuned for single-session developer conversations (~12k chars)

Community extraction has fundamentally different concerns: multi-author content, social signals, consensus patterns, temporal drift, and domain expertise. The profile system enables this without breaking existing behavior.

---

## 2. Profile System Design

### 2.1 Architecture

Extraction profiles are selected per-agent based on `agentId` prefix convention. Each profile defines its own limits, prompt template, fact types, entity types, and post-processing behavior.

```typescript
// packages/daemon/src/pipeline/extraction-profiles.ts

// ---------------------------------------------------------------------------
// Profile Registry
// ---------------------------------------------------------------------------

export interface ExtractionProfile {
  /** Unique profile identifier */
  readonly id: string;
  /** Human description */
  readonly description: string;

  /** Extraction limits — override defaults per profile */
  readonly limits: ExtractionLimits;

  /** Valid fact types for this profile (superset of base types) */
  readonly factTypes: ReadonlySet<string>;

  /** Valid entity types for this profile */
  readonly entityTypes: ReadonlySet<string>;

  /** Build the extraction prompt for this profile */
  buildPrompt(content: string, context?: ProfileContext): string;

  /** Optional post-extraction transform (e.g., karma weighting) */
  postProcess?(result: ExtractionResult, context?: ProfileContext): ExtractionResult;
}

export interface ExtractionLimits {
  readonly maxFacts: number;
  readonly maxEntities: number;
  readonly maxFactLength: number;
  readonly minFactLength: number;
  readonly maxInputChars: number;
}

export interface ProfileContext {
  /** Source platform (reddit, discord, slack, etc.) */
  readonly platform?: string;
  /** Community/subreddit identifier */
  readonly community?: string;
  /** Author metadata (karma, account age, flair) */
  readonly authorMeta?: AuthorMeta;
  /** Thread context (parent post, comment depth) */
  readonly threadMeta?: ThreadMeta;
  /** Timestamp of the content */
  readonly contentTimestamp?: string;
}

export interface AuthorMeta {
  readonly username: string;
  readonly karma?: number;
  readonly accountAgeDays?: number;
  readonly flair?: string;
  readonly isMod?: boolean;
}

export interface ThreadMeta {
  readonly subreddit: string;
  readonly postTitle: string;
  readonly postScore: number;
  readonly commentScore?: number;
  readonly commentDepth?: number;
  readonly totalComments?: number;
}
```

### 2.2 Profile Selection

Profile selection is determined by `agentId` prefix. This is a convention — no new schema needed.

```typescript
// ---------------------------------------------------------------------------
// Profile Selection
// ---------------------------------------------------------------------------

const PROFILE_REGISTRY = new Map<string, ExtractionProfile>();

/** Prefix → profile mapping. Longest prefix match wins. */
const PREFIX_RULES: Array<{ prefix: string; profileId: string }> = [
  { prefix: "community:", profileId: "community" },
  { prefix: "reddit:",    profileId: "community" },
  { prefix: "discord:",   profileId: "community" },
  // Default falls through to "personal"
];

export function registerProfile(profile: ExtractionProfile): void {
  PROFILE_REGISTRY.set(profile.id, profile);
}

export function resolveProfile(agentId: string): ExtractionProfile {
  // Sort by prefix length DESC for longest-match-first
  const sorted = [...PREFIX_RULES].sort(
    (a, b) => b.prefix.length - a.prefix.length,
  );
  for (const rule of sorted) {
    if (agentId.startsWith(rule.prefix)) {
      const profile = PROFILE_REGISTRY.get(rule.profileId);
      if (profile) return profile;
    }
  }
  return PROFILE_REGISTRY.get("personal")!;
}
```

### 2.3 Personal Profile (Default — Current Behavior)

```typescript
// ---------------------------------------------------------------------------
// Personal Profile (preserves existing behavior exactly)
// ---------------------------------------------------------------------------

import { MEMORY_TYPES } from "@signet/core";

const PERSONAL_FACT_TYPES = new Set<string>(MEMORY_TYPES);
const PERSONAL_ENTITY_TYPES = new Set([
  "person", "project", "system", "tool", "concept", "skill", "task", "unknown",
]);

const personalProfile: ExtractionProfile = {
  id: "personal",
  description: "Default personal agent extraction — 1:1 user/agent conversations",
  limits: {
    maxFacts: 20,
    maxEntities: 15,
    maxFactLength: 2000,
    minFactLength: 20,
    maxInputChars: 12000,
  },
  factTypes: PERSONAL_FACT_TYPES,
  entityTypes: PERSONAL_ENTITY_TYPES,
  buildPrompt: buildExtractionPrompt, // existing function, unchanged
};

registerProfile(personalProfile);
```

### 2.4 Integration with `extractFactsAndEntities()`

Minimal change to the existing function signature — add optional `agentId`:

```typescript
// In extraction.ts — updated function signature
export async function extractFactsAndEntities(
  input: string,
  provider: LlmProvider,
  opts?: {
    timeoutMs?: number;
    maxTokens?: number;
    agentId?: string;        // NEW — selects profile
    profileContext?: ProfileContext;  // NEW — metadata for community profiles
  },
): Promise<ExtractionResult> {
  const profile = opts?.agentId
    ? resolveProfile(opts.agentId)
    : PROFILE_REGISTRY.get("personal")!;

  const limits = profile.limits;

  const trimmed = input.trim().replace(/\s+/g, " ");
  if (trimmed.length < limits.minFactLength) {
    return { facts: [], entities: [], warnings: ["Input too short"] };
  }

  const truncated = trimmed.length > limits.maxInputChars
    ? `${trimmed.slice(0, limits.maxInputChars)}\n[truncated]`
    : trimmed;

  const prompt = profile.buildPrompt(truncated, opts?.profileContext);

  let rawOutput: string;
  try {
    rawOutput = await provider.generate(prompt, {
      timeoutMs: opts?.timeoutMs,
      maxTokens: opts?.maxTokens,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`LLM extraction failed: ${msg}`);
  }

  // Parse with profile-aware limits
  let result = parseRawExtractionOutput(rawOutput, {
    maxFacts: limits.maxFacts,
    maxEntities: limits.maxEntities,
    maxFactLength: limits.maxFactLength,
    minFactLength: limits.minFactLength,
    validTypes: profile.factTypes,
  });

  // Profile-specific post-processing
  if (profile.postProcess) {
    result = profile.postProcess(result, opts?.profileContext);
  }

  return result;
}
```

### 2.5 Config Extension

```typescript
// In PipelineV2Config (packages/core/src/types.ts)

export interface PipelineExtractionConfig {
  // ... existing fields ...

  /** Override extraction profile (default: auto-detect from agentId) */
  readonly profile?: string;

  /** Community-specific extraction settings */
  readonly community?: CommunityExtractionConfig;
}

export interface CommunityExtractionConfig {
  /** Minimum karma for full-weight extraction (below = confidence discount) */
  readonly minKarmaFullWeight: number;     // default: 100
  /** Karma below which content is skipped entirely */
  readonly minKarmaThreshold: number;      // default: -5
  /** Maximum comment depth to extract from (deeper = less signal) */
  readonly maxCommentDepth: number;         // default: 8
  /** Subreddit-specific stop-entity lists */
  readonly stopEntities?: Record<string, string[]>;
}
```

---

## 3. Community Extraction Profile

### 3.1 Design Principles

Reddit content differs from personal agent conversations in several structural ways:

| Dimension | Personal Agent | Community (Reddit) |
|-----------|---------------|-------------------|
| Authors | 1 user | Many authors, varying expertise |
| Signal quality | All high (user's own words) | Mixed (experts, novices, trolls) |
| Temporality | Session-scoped | Thread-scoped, with temporal decay |
| Consensus | N/A | Karma as noisy proxy for agreement |
| Fact types | Preference, decision | Norm, expertise, disagreement, FAQ |
| Entity types | Project, tool | Community, topic, user, stance |

### 3.2 Extended Type Systems

```typescript
// Community fact types — extends MEMORY_TYPES
const COMMUNITY_FACT_TYPES = new Set<string>([
  // Standard types
  "fact", "preference", "decision", "rationale", "procedural", "semantic",
  // Community-specific types
  "community_norm",       // "r/rust discourages unsafe{} in library code"
  "expert_consensus",     // "Senior devs agree: use Arc<Mutex<T>> for shared state"
  "disagreement",         // "Community split on whether to use ORM vs raw SQL"
  "expertise_signal",     // "u/dtolnay consistently provides authoritative Rust answers"
  "temporal_observation", // "As of March 2026, the borrow checker handles NLL correctly"
  "faq_pattern",          // "Users frequently ask about lifetime elision rules"
]);

// Community entity types — extends base set
const COMMUNITY_ENTITY_TYPES = new Set([
  "person", "project", "system", "tool", "concept", "skill", "task", "unknown",
  // Community-specific
  "community",     // r/rust, r/programming
  "topic",         // "async runtime debate", "error handling patterns"
  "stance",        // A position held by a community faction
  "user",          // Reddit user (distinguished from owner "person")
  "organization",  // Companies, foundations referenced
]);
```

### 3.3 Community Extraction Prompt (Full Template)

```typescript
function buildCommunityExtractionPrompt(
  content: string,
  context?: ProfileContext,
): string {
  const subreddit = context?.threadMeta?.subreddit ?? "unknown";
  const postTitle = context?.threadMeta?.postTitle ?? "";
  const postScore = context?.threadMeta?.postScore ?? 0;
  const commentScore = context?.threadMeta?.commentScore;
  const authorKarma = context?.authorMeta?.karma;
  const authorFlair = context?.authorMeta?.flair ?? "";
  const isMod = context?.authorMeta?.isMod ?? false;
  const timestamp = context?.contentTimestamp ?? "";

  const metaBlock = [
    `Subreddit: r/${subreddit}`,
    postTitle ? `Post title: "${postTitle}"` : null,
    `Post score: ${postScore}`,
    commentScore !== undefined ? `Comment score: ${commentScore}` : null,
    authorKarma !== undefined ? `Author karma: ${authorKarma}` : null,
    authorFlair ? `Author flair: ${authorFlair}` : null,
    isMod ? `Author is moderator: yes` : null,
    timestamp ? `Posted: ${timestamp}` : null,
  ].filter(Boolean).join("\n");

  return `Extract community knowledge from this Reddit content. You are building a knowledge graph about what communities know, believe, and care about.

CONTEXT:
${metaBlock}

Return JSON with two arrays: "facts" and "entities".

Each fact: {"content": "...", "type": "<type>", "confidence": 0.0-1.0, "scope": "community|global|user"}
Each entity: {"source": "...", "source_type": "<type>", "relationship": "...", "target": "...", "target_type": "<type>", "confidence": 0.0-1.0}

FACT TYPES:
- fact: Objective technical or domain information
- community_norm: Shared practice or convention in this community ("r/rust discourages unsafe{} in library code")
- expert_consensus: Agreement among knowledgeable contributors, especially high-karma or flaired users
- disagreement: Active debate or split opinion on a topic — extract BOTH sides
- expertise_signal: Evidence that a specific user has deep knowledge in an area
- temporal_observation: Time-bounded fact — include the date/version. ("As of Rust 1.76, async closures are unstable")
- faq_pattern: Question that appears repeatedly — indicates common confusion or knowledge gap
- procedural: How-to knowledge or step-by-step process
- rationale: WHY something is recommended — reasoning, tradeoffs, alternatives rejected

ENTITY TYPES (for source_type and target_type):
person, user, community, project, system, tool, concept, topic, stance, skill, organization, unknown

SCOPE:
- "community": applies specifically to r/${subreddit}
- "global": general domain knowledge, not community-specific
- "user": specific to the author (their preference or experience)

EXTRACTION PRIORITIES:
1. EXPERTISE SIGNALS: When someone demonstrates deep knowledge (detailed explanations, code examples, corrections of misconceptions), extract an expertise_signal fact AND an entity relationship (user -> expert_in -> topic).
2. COMMUNITY NORMS: Implicit rules, recommended practices, common conventions. "We use X here" / "The community prefers Y" / heavily upvoted guidance.
3. DISAGREEMENTS: When replies contradict or debate, extract BOTH positions as a disagreement fact. Don't pick sides — capture the tension.
4. TEMPORAL MARKERS: Version numbers, dates, "as of", "since", "recently", "used to be". ALWAYS include temporal context in the fact content.
5. KARMA AS SIGNAL: High-score content (${postScore > 50 ? "this post is highly upvoted" : postScore < 0 ? "this post is controversial/downvoted" : "moderate engagement"}). Adjust confidence:
   - Score > 100 or author karma > 10k: confidence += 0.1
   - Score < 0: confidence -= 0.15
   - Author is moderator: confidence += 0.05 for norm-type facts
6. FAQ PATTERNS: "How do I...?" / "Why does...?" / "Is it possible to...?" that appear to be common questions. Extract as faq_pattern.

WHAT TO SKIP:
- Jokes, memes, off-topic tangents (unless they reveal a community norm about humor/culture)
- "This" / "Same" / agreement-only comments with no new information
- Deleted/removed content indicators
- Bot responses (AutoModerator, etc.) unless they encode community rules
- Personal anecdotes without generalizable knowledge (unless they're expertise signals)

ATOMIC FACTS — each must be self-contained:
BAD: "They recommend using Arc"
GOOD: "r/rust community consensus recommends Arc<Mutex<T>> for thread-safe shared mutable state, over alternatives like RefCell or global statics"

BAD: "This is a common question"
GOOD: "Users in r/rust frequently ask about lifetime elision rules, particularly when function signatures have multiple reference parameters"

Return ONLY the JSON object, no other text.

Text:
${content}`;
}
```

### 3.4 Community Profile Definition

```typescript
const communityProfile: ExtractionProfile = {
  id: "community",
  description: "Community intelligence extraction — Reddit, Discord, forums",

  limits: {
    maxFacts: 30,          // Community threads are denser
    maxEntities: 25,       // More relationship types
    maxFactLength: 2000,   // Same — atomic facts shouldn't be longer
    minFactLength: 25,     // Slightly higher — skip very short fragments
    maxInputChars: 20000,  // Threads can be longer than 1:1 conversations
  },

  factTypes: COMMUNITY_FACT_TYPES,
  entityTypes: COMMUNITY_ENTITY_TYPES,

  buildPrompt: buildCommunityExtractionPrompt,

  postProcess(result: ExtractionResult, context?: ProfileContext): ExtractionResult {
    if (!context?.authorMeta) return result;

    const { karma, accountAgeDays } = context.authorMeta;

    // Karma-weighted confidence adjustment
    const karmaMultiplier = computeKarmaConfidenceMultiplier(karma, accountAgeDays);

    const adjustedFacts = result.facts.map((f) => ({
      ...f,
      confidence: Math.max(0, Math.min(1, f.confidence * karmaMultiplier)),
    }));

    const adjustedEntities = result.entities.map((e) => ({
      ...e,
      confidence: Math.max(0, Math.min(1, e.confidence * karmaMultiplier)),
    }));

    return {
      facts: adjustedFacts,
      entities: adjustedEntities,
      warnings: result.warnings,
    };
  },
};

registerProfile(communityProfile);

/**
 * Karma → confidence multiplier.
 *
 * Accounts with very low karma or very new accounts get a discount.
 * High-karma accounts get a mild boost. Moderates are neutral.
 *
 * Not a hard filter — even low-karma content can contain signal.
 * The confidence discount just makes it less likely to dominate
 * over high-signal content during recall.
 */
function computeKarmaConfidenceMultiplier(
  karma?: number,
  accountAgeDays?: number,
): number {
  let multiplier = 1.0;

  if (karma !== undefined) {
    if (karma < -5) {
      multiplier *= 0.5;     // Heavily downvoted history
    } else if (karma < 50) {
      multiplier *= 0.8;     // Low karma — new or low-engagement
    } else if (karma < 500) {
      multiplier *= 0.95;    // Moderate
    } else if (karma > 10000) {
      multiplier *= 1.1;     // High karma — established contributor
    } else if (karma > 50000) {
      multiplier *= 1.15;    // Very high karma
    }
    // 500-10000 = 1.0 (neutral)
  }

  if (accountAgeDays !== undefined) {
    if (accountAgeDays < 30) {
      multiplier *= 0.7;     // Brand new account
    } else if (accountAgeDays < 90) {
      multiplier *= 0.85;    // Recent account
    }
  }

  return multiplier;
}
```

### 3.5 Extended Validation for Community Types

```typescript
// In extraction.ts — updated validateFact to accept profile-aware type set

function validateFact(
  raw: unknown,
  warnings: string[],
  validTypes?: ReadonlySet<string>,
): ExtractedFact | null {
  // ... existing validation ...

  const typeSet = validTypes ?? new Set<string>(MEMORY_TYPES);
  const typeStr = typeof obj.type === "string" ? obj.type : "fact";
  const type: string = typeSet.has(typeStr) ? typeStr : "fact";
  if (!typeSet.has(typeStr)) {
    warnings.push(`Invalid type "${typeStr}" for profile, defaulting to "fact"`);
  }

  // Community facts may include scope
  const scope = typeof obj.scope === "string" ? obj.scope : undefined;

  return {
    content: content.slice(0, maxFactLength),
    type: type as MemoryType,
    confidence,
    ...(scope && { scope }),
  };
}
```

### 3.6 ExtractedFact Type Extension

```typescript
// In packages/core/src/types.ts — extend ExtractedFact

export interface ExtractedFact {
  readonly content: string;
  readonly type: MemoryType;
  readonly confidence: number;
  /** Community scope — where this fact applies */
  readonly scope?: "community" | "global" | "user";
}

// Extend MemoryType union to include community types
export const MEMORY_TYPES = [
  "fact", "preference", "decision", "rationale", "procedural", "semantic",
  // Community types (only valid when community profile active)
  "community_norm", "expert_consensus", "disagreement",
  "expertise_signal", "temporal_observation", "faq_pattern",
] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];
```

---

## 4. Behavioral Feedback Adaptation

### 4.1 Problem: FTS Overlap Doesn't Apply to Community Content

The existing `applyFtsOverlapFeedback()` in `aspect-feedback.ts` works by tracking `fts_hit_count` in `session_memories` — memories that matched FTS queries get their aspect weights boosted. This is a proxy for "this memory was useful because someone searched for it."

For community extraction, the equivalent signal is **karma** (upvotes). Content that the community upvotes is being "retrieved" (seen, engaged with) by many users. High karma = high FTS overlap analog.

### 4.2 Karma → FTS Overlap Mapping

```typescript
// packages/daemon/src/pipeline/community-feedback.ts

export interface CommunityFeedbackConfig {
  /** Base delta for FTS overlap equivalent (same as aspect-feedback) */
  readonly delta: number;           // default: 0.05
  readonly maxWeight: number;       // default: 1.5
  readonly minWeight: number;       // default: 0.1
  /** Karma thresholds for scoring tiers */
  readonly karmaScoring: KarmaScoring;
}

export interface KarmaScoring {
  /** Score below which content gets negative feedback */
  readonly negativeTreshold: number;  // default: -2
  /** Score above which content gets mild positive */
  readonly mildPositive: number;      // default: 5
  /** Score above which content gets strong positive */
  readonly strongPositive: number;    // default: 50
  /** Score above which content gets exceptional signal */
  readonly exceptional: number;       // default: 200
}

/**
 * Convert karma score to synthetic FTS hit count.
 *
 * The FTS overlap feedback system uses integer hit counts to compute
 * aspect weight deltas. We map karma to equivalent hits:
 *
 * Karma < -2         → -1 hits (negative feedback — weakens aspect)
 * Karma -2 to 5      →  0 hits (no signal)
 * Karma 5 to 50      →  1 hit  (mild confirmation)
 * Karma 50 to 200    →  2 hits (strong confirmation)
 * Karma > 200        →  3 hits (exceptional — capped to prevent runaway)
 *
 * The cap at 3 is intentional. Viral content isn't 100x more correct
 * than merely popular content — it's just more visible. Diminishing
 * returns prevent popularity bias from distorting the knowledge graph.
 */
export function karmaToFtsHits(
  score: number,
  config: KarmaScoring,
): number {
  if (score < config.negativeTreshold) return -1;
  if (score < config.mildPositive) return 0;
  if (score < config.strongPositive) return 1;
  if (score < config.exceptional) return 2;
  return 3;
}
```

### 4.3 Wiring Into `aspect-feedback.ts`

The existing `applyFtsOverlapFeedback()` reads from `session_memories.fts_hit_count`. For community agents, we write synthetic hit counts at extraction time instead of waiting for runtime FTS overlap.

```typescript
// New function in aspect-feedback.ts

/**
 * Apply karma-derived feedback for community extraction results.
 *
 * Called after extraction writes memories + entity_attributes.
 * Instead of waiting for FTS overlap at recall time, we use karma
 * as a pre-computed signal.
 *
 * This reuses the EXACT same aspect weight update logic as
 * applyFtsOverlapFeedback — same delta, same clamp, same telemetry.
 * The only difference is the signal source.
 */
export function applyCommunityKarmaFeedback(
  accessor: DbAccessor,
  agentId: string,
  memoryKarmaMap: ReadonlyMap<string, number>,  // memory_id → karma score
  config: {
    readonly delta: number;
    readonly maxWeight: number;
    readonly minWeight: number;
    readonly karmaScoring: KarmaScoring;
  },
): AspectFeedbackResult {
  return accessor.withWriteTx((db) => {
    const aspectConfirmations = new Map<string, number>();
    let totalConfirmations = 0;

    const aspectLookup = db.prepare(
      `SELECT aspect_id
       FROM entity_attributes
       WHERE memory_id = ?
         AND agent_id = ?
         AND status = 'active'
       LIMIT 1`,
    );

    for (const [memoryId, karma] of memoryKarmaMap) {
      const hits = karmaToFtsHits(karma, config.karmaScoring);
      if (hits === 0) continue;

      const aspect = aspectLookup.get(memoryId, agentId) as
        Record<string, unknown> | undefined;
      if (typeof aspect?.aspect_id !== "string") continue;

      aspectConfirmations.set(
        aspect.aspect_id,
        (aspectConfirmations.get(aspect.aspect_id) ?? 0) + hits,
      );
      totalConfirmations += Math.abs(hits);
    }

    if (aspectConfirmations.size === 0) {
      return { aspectsUpdated: 0, totalFtsConfirmations: 0 };
    }

    // Reuse exact same update pattern from applyFtsOverlapFeedback
    const lookupAspect = db.prepare(
      "SELECT weight FROM entity_aspects WHERE id = ? AND agent_id = ?",
    );
    const updateAspect = db.prepare(
      `UPDATE entity_aspects
       SET weight = ?, updated_at = ?
       WHERE id = ? AND agent_id = ?`,
    );
    const ts = new Date().toISOString();
    let aspectsUpdated = 0;

    for (const [aspectId, confirmations] of aspectConfirmations) {
      const row = lookupAspect.get(aspectId, agentId) as
        Record<string, unknown> | undefined;
      const currentWeight = Number(row?.weight ?? NaN);
      if (!Number.isFinite(currentWeight)) continue;

      const newWeight = Math.max(
        config.minWeight,
        Math.min(
          config.maxWeight,
          currentWeight + config.delta * confirmations,
        ),
      );
      updateAspect.run(newWeight, ts, aspectId, agentId);
      aspectsUpdated++;
    }

    return { aspectsUpdated, totalFtsConfirmations: totalConfirmations };
  });
}
```

### 4.4 Temporal Feedback Decay for Community Content

Community signals decay differently than personal agent signals. A personal decision stays relevant indefinitely. Community consensus shifts over time.

```typescript
// Extended decay config for community profiles

export interface CommunityDecayConfig {
  /** Standard aspect weight decay rate (same as personal) */
  readonly decayRate: number;        // default: 0.02
  readonly minWeight: number;        // default: 0.1

  /**
   * Community-specific decay acceleration.
   * Facts older than this get faster decay.
   * Community norms from 2 years ago may no longer apply.
   */
  readonly acceleratedDecayAfterDays: number;  // default: 180
  readonly acceleratedDecayRate: number;        // default: 0.05

  /** Temporal observations get even faster decay */
  readonly temporalObservationDecayRate: number; // default: 0.08
  readonly temporalObservationStaleDays: number; // default: 60
}
```

### 4.5 Scoring Rules Summary

| Signal | FTS Hit Equivalent | Aspect Weight Delta | Notes |
|--------|-------------------|-------------------|-------|
| Karma < -2 | -1 | -0.05 | Weakens — community rejected |
| Karma -2 to 5 | 0 | 0 | No signal — too noisy |
| Karma 5-50 | +1 | +0.05 | Mild confirmation |
| Karma 50-200 | +2 | +0.10 | Strong signal |
| Karma > 200 | +3 | +0.15 | Capped — prevents popularity bias |
| Author is mod (norm facts) | +1 bonus | +0.05 | Mod-stated norms are authoritative |
| Author karma > 10k (expertise facts) | +1 bonus | +0.05 | Established contributor signal |

---

## 5. Dampening Adaptations

### 5.1 Hub Dampening: Scope-Aware Thresholds

Current hub dampening uses a single P90 percentile threshold across all entities. Community graphs have structurally different entity scopes — a subreddit entity (r/rust) will always be high-degree, but that doesn't mean it's noise.

```typescript
// packages/daemon/src/pipeline/dampening.ts — extended

// ---------------------------------------------------------------------------
// Scope-Aware Hub Dampening
// ---------------------------------------------------------------------------

/**
 * Entity scope classification.
 *
 * Different scope types have different "natural" degree distributions.
 * A community entity with 500 edges is normal.
 * A concept entity with 500 edges is a hub.
 */
export type EntityScopeType = "global" | "community" | "user" | "concept";

export interface ScopeAwareHubConfig {
  readonly enabled: boolean;
  /** Per-scope percentile thresholds and penalties */
  readonly scopes: Record<EntityScopeType, ScopeHubParams>;
  /** Fallback for entities with unknown scope */
  readonly fallback: ScopeHubParams;
}

export interface ScopeHubParams {
  /** Percentile threshold — entities above this are hubs */
  readonly percentile: number;
  /** Score multiplier when all linked entities are hubs */
  readonly penalty: number;
  /** Absolute degree floor — never penalize below this count */
  readonly minDegreeForPenalty: number;
}

export const DEFAULT_SCOPE_HUB_CONFIG: ScopeAwareHubConfig = {
  enabled: true,
  scopes: {
    global: {
      percentile: 0.85,       // More aggressive — global entities are noisy
      penalty: 0.6,
      minDegreeForPenalty: 20,
    },
    community: {
      percentile: 0.95,       // Very lenient — community entities SHOULD be high-degree
      penalty: 0.85,
      minDegreeForPenalty: 100,
    },
    user: {
      percentile: 0.90,       // Moderate — prolific users exist but shouldn't dominate
      penalty: 0.7,
      minDegreeForPenalty: 30,
    },
    concept: {
      percentile: 0.90,       // Standard — matches current behavior
      penalty: 0.7,
      minDegreeForPenalty: 15,
    },
  },
  fallback: {
    percentile: 0.90,
    penalty: 0.7,
    minDegreeForPenalty: 15,
  },
};

/**
 * Classify an entity into a scope type based on entity_type.
 */
function classifyEntityScope(entityType: string): EntityScopeType {
  switch (entityType) {
    case "community": return "community";
    case "person":
    case "user": return "user";
    case "concept":
    case "topic":
    case "skill":
    case "stance": return "concept";
    default: return "global";
  }
}

/**
 * Scope-aware hub dampening.
 *
 * Instead of a single P90 threshold, each entity scope type has its
 * own percentile and penalty. This prevents community entities from
 * being treated as noise hubs while still penalizing genuinely
 * overconnected entities within their scope.
 */
function scopeAwareHub(
  rows: readonly ScoredRow[],
  entities: ReadonlyMap<string, ReadonlySet<string>>,
  degrees: ReadonlyMap<string, number>,
  entityTypes: ReadonlyMap<string, string>,   // entity_id → entity_type
  config: ScopeAwareHubConfig,
): void {
  // Partition degrees by scope type
  const scopeDegrees = new Map<EntityScopeType, number[]>();
  for (const [entityId, degree] of degrees) {
    const entityType = entityTypes.get(entityId) ?? "unknown";
    const scope = classifyEntityScope(entityType);
    if (!scopeDegrees.has(scope)) scopeDegrees.set(scope, []);
    scopeDegrees.get(scope)!.push(degree);
  }

  // Compute per-scope thresholds
  const scopeThresholds = new Map<EntityScopeType, number>();
  for (const [scope, degs] of scopeDegrees) {
    const params = config.scopes[scope] ?? config.fallback;
    const sorted = [...degs].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * params.percentile);
    const threshold = Math.max(
      params.minDegreeForPenalty,
      sorted[Math.min(idx, sorted.length - 1)],
    );
    scopeThresholds.set(scope, threshold);
  }

  // Apply penalties
  for (const row of rows) {
    const linked = entities.get(row.id);
    if (!linked || linked.size === 0) continue;

    let allHubs = true;
    let worstPenalty = 1.0;

    for (const eid of linked) {
      const entityType = entityTypes.get(eid) ?? "unknown";
      const scope = classifyEntityScope(entityType);
      const threshold = scopeThresholds.get(scope) ?? Infinity;
      const deg = degrees.get(eid) ?? 0;
      const params = config.scopes[scope] ?? config.fallback;

      if (deg < threshold) {
        allHubs = false;
        break;
      }
      worstPenalty = Math.min(worstPenalty, params.penalty);
    }

    if (allHubs) {
      row.score *= worstPenalty;
    }
  }
}
```

### 5.2 Gravity Dampening: Per-Community Stop-Word Lists

The current gravity dampening tokenizes content and checks for query-term overlap against `FTS_STOP`. Community-specific content has domain stop words (terms so ubiquitous in a subreddit that they have zero discriminating power).

```typescript
// packages/daemon/src/pipeline/community-stop-words.ts

/**
 * Per-community stop-word management.
 *
 * Each subreddit accumulates its own stop-word list from high-TF
 * (term frequency) tokens. Words that appear in >40% of a
 * community's memories are stop words for that community.
 */

export interface CommunityStopWordConfig {
  /** TF threshold — terms appearing in this fraction of community docs are stop words */
  readonly tfThreshold: number;           // default: 0.40
  /** Minimum document count before auto-generation triggers */
  readonly minDocsForGeneration: number;  // default: 100
  /** Maximum stop words per community */
  readonly maxStopWords: number;          // default: 50
  /** How often to regenerate (ms) */
  readonly regenerateIntervalMs: number;  // default: 86400000 (24h)
}

export const DEFAULT_COMMUNITY_STOP_CONFIG: CommunityStopWordConfig = {
  tfThreshold: 0.40,
  minDocsForGeneration: 100,
  maxStopWords: 50,
  regenerateIntervalMs: 86_400_000,
};

/** In-memory cache: community → stop word set */
const communityStopCache = new Map<string, ReadonlySet<string>>();
const cacheTimestamps = new Map<string, number>();

/**
 * Get stop words for a community, auto-generating from high-TF terms
 * if the cache is stale or missing.
 */
export function getCommunityStopWords(
  community: string,
  accessor: DbAccessor,
  agentId: string,
  config: CommunityStopWordConfig = DEFAULT_COMMUNITY_STOP_CONFIG,
): ReadonlySet<string> {
  const now = Date.now();
  const cached = communityStopCache.get(community);
  const ts = cacheTimestamps.get(community) ?? 0;

  if (cached && (now - ts) < config.regenerateIntervalMs) {
    return cached;
  }

  const generated = generateCommunityStopWords(community, accessor, agentId, config);
  communityStopCache.set(community, generated);
  cacheTimestamps.set(community, now);
  return generated;
}

/**
 * Generate stop words from high-TF terms in community memories.
 *
 * Algorithm:
 * 1. Fetch all memory content for this community (scope = community name)
 * 2. Tokenize each memory
 * 3. Count document frequency (how many memories contain each token)
 * 4. Terms with DF/totalDocs > tfThreshold become stop words
 */
function generateCommunityStopWords(
  community: string,
  accessor: DbAccessor,
  agentId: string,
  config: CommunityStopWordConfig,
): ReadonlySet<string> {
  const rows = accessor.withReadDb((db) => {
    return db
      .prepare(
        `SELECT content FROM memories
         WHERE agent_id = ?
           AND scope = ?
           AND is_deleted = 0
         LIMIT 10000`,  // Safety cap
      )
      .all(agentId, community) as Array<{ content: string }>;
  });

  if (rows.length < config.minDocsForGeneration) {
    return FTS_STOP; // Fall back to global stop words
  }

  const docFrequency = new Map<string, number>();
  const totalDocs = rows.length;
  const PUNCT = /[^a-z0-9\s]/g;

  for (const row of rows) {
    const tokens = new Set(
      row.content.toLowerCase().replace(PUNCT, " ").split(/\s+/)
        .filter((t) => t.length >= 2),
    );
    for (const token of tokens) {
      docFrequency.set(token, (docFrequency.get(token) ?? 0) + 1);
    }
  }

  // Sort by DF descending, take tokens above threshold
  const stopWords = new Set<string>(FTS_STOP); // Start with global stops
  const candidates = [...docFrequency.entries()]
    .filter(([_, df]) => df / totalDocs > config.tfThreshold)
    .sort((a, b) => b[1] - a[1])
    .slice(0, config.maxStopWords);

  for (const [token] of candidates) {
    stopWords.add(token);
  }

  return stopWords;
}

/**
 * Invalidate cache for a community (e.g., after bulk extraction).
 */
export function invalidateCommunityStopCache(community?: string): void {
  if (community) {
    communityStopCache.delete(community);
    cacheTimestamps.delete(community);
  } else {
    communityStopCache.clear();
    cacheTimestamps.clear();
  }
}
```

**Integration with gravity dampening:**

```typescript
// In dampening.ts — updated gravity function signature

function gravity(
  rows: readonly ScoredRow[],
  query: ReadonlySet<string>,
  penalty: number,
  contentStopWords?: ReadonlySet<string>,  // NEW — per-community stops
): void {
  for (const row of rows) {
    if (!VECTOR_SOURCES.has(row.source)) continue;
    if (row.score <= 0.3) continue;

    // Tokenize with community stop words if available
    const stops = contentStopWords ?? FTS_STOP;
    const content = tokenizeWith(row.content, stops);
    let overlap = false;
    for (const qt of query) {
      if (content.has(qt)) {
        overlap = true;
        break;
      }
    }
    if (!overlap) {
      row.score *= penalty;
    }
  }
}

function tokenizeWith(text: string, stops: ReadonlySet<string>): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().replace(PUNCT, " ").split(/\s+/)) {
    if (raw.length < 2) continue;
    if (stops.has(raw)) continue;
    tokens.add(raw);
  }
  return tokens;
}
```

### 5.3 Resolution Boost: Community Type Multipliers

The current resolution boost targets `constraint` and `decision` types. Community extraction introduces `community_norm` and `expert_consensus` — both are high-value, actionable types that deserve boosting.

```typescript
// In dampening.ts — extended resolution boost

export interface ResolutionBoostConfig {
  readonly enabled: boolean;
  readonly boost: number;                  // default: 1.2
  /** Per-type multiplier overrides */
  readonly typeMultipliers: Readonly<Record<string, number>>;
}

export const DEFAULT_RESOLUTION_BOOST: ResolutionBoostConfig = {
  enabled: true,
  boost: 1.2,
  typeMultipliers: {
    // Existing types
    constraint: 1.25,
    decision: 1.2,
    // Community types — norms and consensus are high-value
    community_norm: 1.3,       // Norms are the most actionable community knowledge
    expert_consensus: 1.25,    // Expert agreement is strong signal
    // Disagreements get a mild boost — capturing tension is valuable
    disagreement: 1.1,
    // FAQ patterns get moderate boost — they indicate knowledge gaps
    faq_pattern: 1.15,
    // Temporal observations: no boost (they decay fast, boosting fights decay)
    temporal_observation: 1.0,
    // Expertise signals: mild boost
    expertise_signal: 1.1,
  },
};

/**
 * Enhanced resolution boost with per-type multipliers.
 */
function resolutionV2(
  rows: readonly ScoredRow[],
  config: ResolutionBoostConfig,
): void {
  for (const row of rows) {
    const typeMultiplier = config.typeMultipliers[row.type];
    if (typeMultiplier !== undefined && typeMultiplier !== 1.0) {
      row.score *= typeMultiplier;
      continue;
    }

    // Fallback: existing temporal anchor boost for untyped content
    if (row.content.length < 50) continue;
    if (DATE_PATTERN.test(row.content) || MONTH_PATTERN.test(row.content)) {
      row.score *= 1 + (config.boost - 1) * 0.5;
    }
  }
}
```

### 5.4 Updated `applyDampening()` Signature

```typescript
export function applyDampening(
  rows: readonly ScoredRow[],
  query: string,
  config: DampeningConfig = DEFAULT_DAMPENING,
  entities?: ReadonlyMap<string, ReadonlySet<string>>,
  degrees?: ReadonlyMap<string, number>,
  // NEW: community-aware parameters
  opts?: {
    entityTypes?: ReadonlyMap<string, string>;          // for scope-aware hub
    communityStopWords?: ReadonlySet<string>;           // for gravity
    resolutionConfig?: ResolutionBoostConfig;            // for type multipliers
    scopeAwareHubConfig?: ScopeAwareHubConfig;          // for scope-aware hub
  },
): ScoredRow[] {
  if (rows.length === 0) return [];

  const out: ScoredRow[] = rows.map((r) => ({ ...r }));
  const tokens = tokenize(query);

  if (config.gravityEnabled && tokens.size > 0) {
    gravity(out, tokens, config.gravityPenalty, opts?.communityStopWords);
  }

  if (config.hubEnabled && entities && degrees && degrees.size > 0) {
    if (opts?.scopeAwareHubConfig?.enabled && opts.entityTypes) {
      scopeAwareHub(out, entities, degrees, opts.entityTypes, opts.scopeAwareHubConfig);
    } else {
      hub(out, entities, degrees, config.hubPenalty, config.hubPercentile);
    }
  }

  if (config.resolutionEnabled) {
    if (opts?.resolutionConfig) {
      resolutionV2(out, opts.resolutionConfig);
    } else {
      resolution(out, config.resolutionBoost);
    }
  }

  out.sort((a, b) => b.score - a.score);
  return out;
}
```

---

## 6. Prospective Indexing: Community FAQ Framing

### 6.1 Current Hint Generation

The existing `prospective-index.ts` generates hints with this prompt:

```
Given this fact stored in a personal memory system:
"${content}"

Generate ${max} diverse questions or cues a user might use in the future when this fact would be helpful. Include:
- Direct questions ("Where does X live?")
- Temporal questions ("When did X happen?")
- Relational questions ("Who is X's partner?")
- Indirect/conversational cues ("Tell me about X's move")

Return ONLY the questions, one per line. No numbering, no bullets.
```

### 6.2 Community FAQ Hint Prompt

For community content, hints should be framed as FAQ-style queries that community members would actually ask:

```typescript
// In prospective-index.ts — profile-aware prompt builder

function buildCommunityHintPrompt(
  content: string,
  max: number,
  context?: ProfileContext,
): string {
  const subreddit = context?.threadMeta?.subreddit ?? "this community";
  const factType = guessFactType(content); // heuristic from extraction type

  return [
    `This fact was extracted from r/${subreddit} community discussions:`,
    `"${content}"`,
    ``,
    `Generate ${max} questions that community members might ask when this knowledge would help them. Consider:`,
    ``,
    `- BEGINNER QUESTIONS: "How do I...?" / "What is the recommended way to...?"`,
    `- COMPARISON QUESTIONS: "X vs Y?" / "Should I use X or Y for...?"`,
    `- DEBUGGING QUESTIONS: "Why does X happen when I...?" / "X not working after..."`,
    `- BEST PRACTICE QUESTIONS: "What's the community consensus on...?" / "Is it considered bad practice to...?"`,
    `- TEMPORAL QUESTIONS: "Is X still relevant?" / "Has the recommendation on X changed?"`,
    `- EXPERT QUESTIONS: "Who in r/${subreddit} knows about...?" / "What do experienced users think about...?"`,
    ``,
    factType === "disagreement"
      ? `This fact captures a DISAGREEMENT — generate questions from BOTH sides of the debate.`
      : factType === "faq_pattern"
        ? `This fact IS a FAQ pattern — generate the original question AND related follow-ups.`
        : factType === "community_norm"
          ? `This is a COMMUNITY NORM — generate questions that would lead someone to discover this rule/convention.`
          : ``,
    ``,
    `Return ONLY the questions, one per line. No numbering, no bullets.`,
  ].filter(Boolean).join("\n");
}

function guessFactType(content: string): string {
  if (/community.*split|debate|disagree|controversial/i.test(content)) return "disagreement";
  if (/frequently.*ask|common.*question|FAQ/i.test(content)) return "faq_pattern";
  if (/convention|norm|practice|discourage|recommend/i.test(content)) return "community_norm";
  return "fact";
}
```

### 6.3 Profile-Aware Hint Worker

```typescript
// In prospective-index.ts — updated generateHints with profile awareness

export async function generateHints(
  provider: LlmProvider,
  content: string,
  cfg: PipelineHintsConfig,
  profileContext?: ProfileContext,  // NEW
): Promise<readonly string[]> {
  const isCommunity = profileContext?.platform === "reddit"
    || profileContext?.community != null;

  const prompt = isCommunity
    ? buildCommunityHintPrompt(content, cfg.max, profileContext)
    : buildPrompt(content, cfg.max);

  const raw = await provider.generate(prompt, {
    timeoutMs: cfg.timeout,
    maxTokens: Math.max(cfg.maxTokens, 1024),
  });

  const stripped = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const lines = stripped
    .split("\n")
    .map((l) => l.replace(/^\d+[.)]\s*/, "").replace(/^[-*]\s*/, "").trim())
    .filter((l) => l.length > 10 && l.length < 300 && isHintLine(l));

  return lines;
}
```

### 6.4 Hint Job Payload Extension

```typescript
// Extended HintPayload for community context

interface HintPayload {
  readonly memoryId: string;
  readonly content: string;
  /** Optional community context for profile-aware hint generation */
  readonly profileContext?: ProfileContext;
}

// Updated enqueueHintsJob
export function enqueueHintsJob(
  db: WriteDb,
  memoryId: string,
  content: string,
  profileContext?: ProfileContext,  // NEW
): void {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const payload = JSON.stringify({
    memoryId,
    content,
    ...(profileContext && { profileContext }),
  } satisfies HintPayload);
  db.prepare(
    `INSERT INTO memory_jobs
     (id, memory_id, job_type, status, payload, attempts, max_attempts, created_at, updated_at)
     VALUES (?, ?, 'prospective_index', 'pending', ?, 0, 3, ?, ?)`,
  ).run(id, memoryId, payload, now, now);
}
```

---

## 7. Summarization Hierarchy

### 7.1 Current System

The existing `summary-condensation.ts` implements a three-level DAG:

| Level | Kind | Depth | Threshold | Condenses |
|-------|------|-------|-----------|-----------|
| 0 | `session` | 0 | N/A | Raw session transcript |
| 1 | `arc` | 1 | 8 sessions | Sessions → arc |
| 2 | `epoch` | 2 | 4 arcs | Arcs → epoch |

This is designed for personal agent sessions (one user, one conversation at a time). Community content needs a fundamentally different temporal hierarchy.

### 7.2 Community Summarization Hierarchy

Reddit community content follows a different temporal structure:

```
Thread    → contains comments, debate, resolution
Daily     → threads from one day, emergent topics
Weekly    → patterns across days, trending discussions
Monthly   → community evolution, shifted norms
Yearly    → long-term community identity and drift
```

```typescript
// packages/daemon/src/pipeline/community-summarization.ts

export type CommunitySummaryKind =
  | "thread"    // depth 0 — single Reddit thread
  | "daily"     // depth 1 — one day's threads
  | "weekly"    // depth 2 — one week's dailies
  | "monthly"   // depth 3 — one month's weeklies
  | "yearly";   // depth 4 — one year's monthlies

export interface CommunitySummaryConfig {
  /** Minimum threads per day to trigger daily summary */
  readonly dailyMinThreads: number;        // default: 3
  /** Minimum days per week to trigger weekly summary */
  readonly weeklyMinDays: number;          // default: 3
  /** Minimum weeks per month to trigger monthly summary */
  readonly monthlyMinWeeks: number;        // default: 2
  /** Minimum months per year to trigger yearly summary */
  readonly yearlyMinMonths: number;        // default: 3
  /** LLM timeout for summarization calls */
  readonly timeoutMs: number;              // default: 120000
}

export const DEFAULT_COMMUNITY_SUMMARY_CONFIG: CommunitySummaryConfig = {
  dailyMinThreads: 3,
  weeklyMinDays: 3,
  monthlyMinWeeks: 2,
  yearlyMinMonths: 3,
  timeoutMs: 120_000,
};
```

### 7.3 Thread Summary Prompt

```typescript
function buildThreadSummaryPrompt(
  threadTitle: string,
  subreddit: string,
  comments: readonly string[],
): string {
  return `Summarize this Reddit thread from r/${subreddit}.

Thread title: "${threadTitle}"

Focus on:
1. MAIN QUESTION/TOPIC: What was asked or discussed?
2. KEY ANSWERS: What solutions, recommendations, or explanations emerged?
3. CONSENSUS vs DISAGREEMENT: Did the community agree? Where did they split?
4. EXPERTISE: Did anyone demonstrate notable expertise? What did they contribute?
5. COMMUNITY NORMS: Were any unwritten rules or conventions referenced?
6. TEMPORAL CONTEXT: Are any claims version-specific or time-bounded?
7. RESOLUTION: Was the thread resolved? What was the outcome?

Do NOT include individual usernames unless they are referenced as known experts.
Do NOT repeat comments verbatim — synthesize.

Return the summary as plain markdown. No JSON, no fences.

Thread content:
${comments.join("\n\n---\n\n")}`;
}
```

### 7.4 Daily Summary Prompt

```typescript
function buildDailySummaryPrompt(
  subreddit: string,
  date: string,
  threadSummaries: readonly string[],
): string {
  return `Summarize the day's activity in r/${subreddit} on ${date}.

You have ${threadSummaries.length} thread summaries from this day.

Produce a daily digest covering:
1. TOP TOPICS: What were the main themes discussed today?
2. NOTABLE THREADS: Highlight threads with strong consensus, important decisions, or active debate.
3. NEW INFORMATION: Any new facts, releases, or announcements?
4. COMMUNITY MOOD: Was the community generally helpful, frustrated, excited, or divided?
5. RECURRING PATTERNS: Did any previously-seen questions come up again?

Keep it concise — this will be consumed by higher-level summaries.

Return as plain markdown.

Thread summaries:
${threadSummaries.map((s, i) => `--- Thread ${i + 1} ---\n${s}`).join("\n\n")}`;
}
```

### 7.5 Weekly Summary Prompt

```typescript
function buildWeeklySummaryPrompt(
  subreddit: string,
  weekRange: string,
  dailySummaries: readonly string[],
): string {
  return `Summarize the week's activity in r/${subreddit} (${weekRange}).

You have ${dailySummaries.length} daily summaries.

Produce a weekly digest covering:
1. DOMINANT TOPICS: What themes dominated this week?
2. COMMUNITY EVOLUTION: Did any norms shift? Any new consensus form?
3. NOTABLE EVENTS: Releases, drama, announcements, mod actions?
4. EXPERTISE MAP: Which domains saw the most expert activity?
5. UNRESOLVED QUESTIONS: What questions didn't get good answers?
6. TREND DIRECTION: Is the community growing/shrinking in focus on any topic?

Preserve decisions and consensus. Drop individual thread details unless they drove community-wide change.

Return as plain markdown.

Daily summaries:
${dailySummaries.map((s, i) => `--- Day ${i + 1} ---\n${s}`).join("\n\n")}`;
}
```

### 7.6 Monthly Summary Prompt

```typescript
function buildMonthlySummaryPrompt(
  subreddit: string,
  month: string,
  weeklySummaries: readonly string[],
): string {
  return `Summarize the month of ${month} in r/${subreddit}.

You have ${weeklySummaries.length} weekly summaries.

Produce a monthly report covering:
1. COMMUNITY STATE: What is the community focused on? What defines it right now?
2. NORM CHANGES: Did any community practices or recommendations change this month?
3. CONSENSUS SHIFTS: Were there any reversals of previous community consensus?
4. KEY DECISIONS: Major technical or organizational decisions made?
5. EXPERTISE EVOLUTION: Are new experts emerging? Are existing experts shifting focus?
6. KNOWLEDGE GAPS: What does the community still not know or disagree about?
7. TEMPORAL MARKERS: What facts from this month are likely to expire or change?

This summary will be used to track community evolution over time. Prioritize changes and trends over static facts.

Return as plain markdown.

Weekly summaries:
${weeklySummaries.map((s, i) => `--- Week ${i + 1} ---\n${s}`).join("\n\n")}`;
}
```

### 7.7 Yearly Summary Prompt

```typescript
function buildYearlySummaryPrompt(
  subreddit: string,
  year: string,
  monthlySummaries: readonly string[],
): string {
  return `Summarize the year ${year} in r/${subreddit}.

You have ${monthlySummaries.length} monthly summaries.

Produce a yearly retrospective covering:
1. COMMUNITY IDENTITY: How would you describe this community to a newcomer based on this year's activity?
2. MAJOR SHIFTS: What changed between the start and end of the year?
3. LASTING DECISIONS: What architectural/technical/organizational decisions from this year are still relevant?
4. COMMUNITY NORMS: What are the current community conventions and best practices?
5. KNOWLEDGE BASE: What does this community collectively know that's hard to learn elsewhere?
6. OPEN QUESTIONS: What big questions remain unresolved?

Preserve only facts that remain relevant. This is the compression layer — ephemeral details should be fully absorbed into patterns.

Return as plain markdown.

Monthly summaries:
${monthlySummaries.map((s, i) => `--- ${month(i)} ---\n${s}`).join("\n\n")}`;
}
```

### 7.8 Condensation Engine

```typescript
// packages/daemon/src/pipeline/community-summarization.ts

export async function checkAndCondenseCommunity(
  accessor: DbAccessor,
  provider: LlmProvider,
  subreddit: string,
  agentId: string,
  config: CommunitySummaryConfig = DEFAULT_COMMUNITY_SUMMARY_CONFIG,
): Promise<void> {
  // Thread → Daily
  await condenseThreadsToDaily(accessor, provider, subreddit, agentId, config);

  // Daily → Weekly
  await condenseDailyToWeekly(accessor, provider, subreddit, agentId, config);

  // Weekly → Monthly
  await condenseWeeklyToMonthly(accessor, provider, subreddit, agentId, config);

  // Monthly → Yearly
  await condenseMonthlyToYearly(accessor, provider, subreddit, agentId, config);
}

/**
 * Schema: Reuses `session_summaries` table with extended kinds.
 *
 * Migration adds community-specific kind values to the kind column
 * (it's a TEXT column, no enum constraint). The `project` column
 * stores the subreddit name. `source_type` = 'community_condensation'.
 *
 * Depth mapping:
 *   thread = 0, daily = 1, weekly = 2, monthly = 3, yearly = 4
 *
 * The `session_summary_children` junction table links parent↔child
 * at every level, preserving full provenance.
 */

async function condenseThreadsToDaily(
  accessor: DbAccessor,
  provider: LlmProvider,
  subreddit: string,
  agentId: string,
  config: CommunitySummaryConfig,
): Promise<void> {
  // Find uncondensed thread summaries grouped by date
  const threadsByDate = accessor.withReadDb((db) => {
    return db
      .prepare(
        `SELECT id, content, project,
                DATE(earliest_at) as thread_date,
                earliest_at, latest_at
         FROM session_summaries
         WHERE project = ? AND agent_id = ? AND kind = 'thread' AND depth = 0
           AND source_type = 'community_condensation'
           AND id NOT IN (SELECT child_id FROM session_summary_children)
         ORDER BY earliest_at ASC`,
      )
      .all(subreddit, agentId) as Array<SummaryRow & { thread_date: string }>;
  });

  // Group by date
  const grouped = new Map<string, Array<SummaryRow & { thread_date: string }>>();
  for (const row of threadsByDate) {
    const existing = grouped.get(row.thread_date) ?? [];
    existing.push(row);
    grouped.set(row.thread_date, existing);
  }

  // Condense dates that meet threshold
  for (const [date, threads] of grouped) {
    if (threads.length < config.dailyMinThreads) continue;

    const summaryTexts = threads.map((t) => t.content);
    const prompt = buildDailySummaryPrompt(subreddit, date, summaryTexts);

    const condensed = await provider.generate(prompt, {
      timeoutMs: config.timeoutMs,
    });

    const dailyId = crypto.randomUUID();
    const now = new Date().toISOString();

    accessor.withWriteTx((db) => {
      db.prepare(
        `INSERT INTO session_summaries (
          id, project, depth, kind, content, token_count,
          earliest_at, latest_at, session_key, harness,
          agent_id, source_type, source_ref, meta_json, created_at
        ) VALUES (?, ?, 1, 'daily', ?, ?, ?, ?, NULL, NULL, ?, 'community_condensation', NULL, ?, ?)`,
      ).run(
        dailyId, subreddit, condensed, Math.ceil(condensed.length / 4),
        threads[0].earliest_at,
        threads[threads.length - 1].latest_at,
        agentId,
        JSON.stringify({ date, threadCount: threads.length }),
        now,
      );

      const childStmt = db.prepare(
        `INSERT OR IGNORE INTO session_summary_children (parent_id, child_id, ordinal)
         VALUES (?, ?, ?)`,
      );
      for (let i = 0; i < threads.length; i++) {
        childStmt.run(dailyId, threads[i].id, i);
      }
    });
  }
}

// condenseDailyToWeekly, condenseWeeklyToMonthly, condenseMonthlyToYearly
// follow the same pattern — query uncondensed rows at depth N,
// group by time window, condense with appropriate prompt, write at depth N+1.
// Implementation is identical to condenseThreadsToDaily with different:
// - Source kind/depth
// - Target kind/depth
// - Grouping logic (ISO week, month, year)
// - Prompt builder
// Omitted for brevity — the pattern is mechanically identical.
```

### 7.9 Depth and Kind Mapping (Complete)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Personal Agent Path          │ Community Agent Path                      │
├──────────────────────────────┼───────────────────────────────────────────┤
│ depth=0  kind=session        │ depth=0  kind=thread                     │
│ depth=1  kind=arc            │ depth=1  kind=daily                      │
│ depth=2  kind=epoch          │ depth=2  kind=weekly                     │
│                              │ depth=3  kind=monthly                    │
│                              │ depth=4  kind=yearly                     │
├──────────────────────────────┼───────────────────────────────────────────┤
│ source_type=summary          │ source_type=community_condensation       │
│ source_type=condensation     │                                          │
└──────────────────────────────┴───────────────────────────────────────────┘
```

### 7.10 Schema Notes

No migration needed. The `session_summaries` table already uses TEXT columns for `kind` and `source_type`. The community hierarchy reuses the existing table structure with different kind values and an additional two depth levels (3 and 4).

The `session_summary_children` junction table provides full DAG provenance at every level. Querying "show me the weekly summary that contains this thread" is a recursive CTE walk.

---

## Appendix A: File Inventory

| New File | Purpose |
|----------|---------|
| `packages/daemon/src/pipeline/extraction-profiles.ts` | Profile registry, selection, interfaces |
| `packages/daemon/src/pipeline/community-feedback.ts` | Karma → FTS mapping, community feedback |
| `packages/daemon/src/pipeline/community-stop-words.ts` | Per-community stop-word generation |
| `packages/daemon/src/pipeline/community-summarization.ts` | Thread→daily→weekly→monthly→yearly hierarchy |

| Modified File | Changes |
|---------------|---------|
| `packages/daemon/src/pipeline/extraction.ts` | Profile-aware extraction, parameterized limits |
| `packages/daemon/src/pipeline/aspect-feedback.ts` | Add `applyCommunityKarmaFeedback()` |
| `packages/daemon/src/pipeline/dampening.ts` | Scope-aware hub, community stops, type multipliers |
| `packages/daemon/src/pipeline/prospective-index.ts` | Community FAQ hint prompts |
| `packages/core/src/types.ts` | Extended MemoryType, CommunityExtractionConfig, ExtractedFact.scope |

## Appendix B: Migration Checklist

1. Extend `MemoryType` union with community types (non-breaking — TEXT column)
2. Add `scope` column to `ExtractedFact` interface (optional field)
3. No schema migrations required — all new types fit existing TEXT columns
4. Community stop-word cache is in-memory only (no persistence needed)
5. Summary hierarchy reuses `session_summaries` table as-is

## Appendix C: Test Plan

| Area | Test |
|------|------|
| Profile selection | `resolveProfile("community:reddit:rust")` → community profile |
| Profile selection | `resolveProfile("default")` → personal profile |
| Karma mapping | `karmaToFtsHits(-10, cfg)` → -1 |
| Karma mapping | `karmaToFtsHits(300, cfg)` → 3 |
| Confidence adjustment | Author karma 100 → multiplier ~1.0 |
| Confidence adjustment | Author karma -10 → multiplier 0.5 |
| Community stops | r/rust with 500 memories → "rust", "code", etc. in stop list |
| Scope-aware hub | Community entity with 200 edges → NOT penalized |
| Scope-aware hub | Concept entity with 200 edges → penalized |
| Resolution boost | `community_norm` fact → 1.3x score |
| Thread summary | 5 comments → coherent thread summary |
| Daily condensation | 3+ threads same day → daily summary created |
| Hint generation | Community content → FAQ-style hints |
