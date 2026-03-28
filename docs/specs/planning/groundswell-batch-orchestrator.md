# Groundswell Batch Orchestrator Spec

> **Status**: Implementation-ready design document  
> **Author**: buba (AI) for Nicholai  
> **Date**: 2026-03-28  
> **Integration target**: `@signet/daemon` pipeline (hooks.ts → significance-gate → summary-worker)

---

## Table of Contents

1. [Pushshift Data Format](#1-pushshift-data-format)
2. [Input Adapter: Reddit → Pseudo-Session](#2-input-adapter-reddit--pseudo-session)
3. [Chunking Strategy](#3-chunking-strategy)
4. [Batch Orchestrator](#4-batch-orchestrator)
5. [Significance Gate Adaptation](#5-significance-gate-adaptation)
6. [Integration Points](#6-integration-points)
7. [Scalability](#7-scalability)

---

## 1. Pushshift Data Format

### 1.1 Archive Structure

Data is distributed as **Zstandard-compressed newline-delimited JSON** (`.zst` files). The top-40k subreddit archive (Academic Torrents) organizes files per-subreddit:

```
subreddits24/
  wallstreetbets_submissions.zst     # all submissions (posts)
  wallstreetbets_comments.zst        # all comments
  localllama_submissions.zst
  localllama_comments.zst
  ...
```

**Torrent**: https://academictorrents.com/details/1614740ac8c94505e4ecb9d88be8bed7b6afddd4  
**Coverage**: 2005-06 through 2024-12  
**Maintainer**: u/Watchful1 (packaging), u/raiderbdev / Arctic Shift (post-April 2023 collection), Pushshift/stuck_in_the_matrix (pre-April 2023)  
**Format**: Zstandard compressed NDJSON — one JSON object per line, no trailing comma or wrapping array.

### 1.2 Submission (Post) Schema

Each line in `*_submissions.zst` is a JSON object. Key fields:

```typescript
/** Raw Pushshift submission record (NDJSON line) */
interface PushshiftSubmission {
  // === Identity ===
  id: string;                    // Reddit base-36 ID, e.g. "kol20h"
  name: string;                  // Fullname with prefix, e.g. "t3_kol20h"
  author: string;                // Username, "[deleted]" if removed
  author_fullname?: string;      // e.g. "t2_abc123" (may be absent)

  // === Content ===
  title: string;                 // Post title
  selftext: string;              // Body text ("" for link posts, "[removed]"/"[deleted]" if mod-removed)
  url: string;                   // Self-post URL or external link
  is_self: boolean;              // true = text post, false = link post
  domain: string;                // e.g. "self.wallstreetbets" or "imgur.com"

  // === Location ===
  subreddit: string;             // Subreddit name without r/, e.g. "wallstreetbets"
  subreddit_id: string;          // e.g. "t5_2th52"
  permalink: string;             // e.g. "/r/wallstreetbets/comments/kol20h/title_slug/"

  // === Engagement ===
  score: number;                 // Net upvotes (upvotes - downvotes)
  upvote_ratio?: number;         // 0.0 to 1.0 (may be absent in older data)
  num_comments: number;          // Total comment count at capture time
  num_crossposts?: number;

  // === Timestamps ===
  created_utc: number;           // Unix epoch seconds (integer)
  retrieved_on?: number;         // When Pushshift captured this record

  // === Metadata ===
  over_18: boolean;              // NSFW flag
  spoiler?: boolean;
  stickied: boolean;
  locked?: boolean;
  distinguished?: string | null; // "moderator", "admin", or null
  link_flair_text?: string | null;
  author_flair_text?: string | null;

  // === Media (often present, variable) ===
  thumbnail?: string;
  media?: object | null;
  is_video?: boolean;

  // === Removal indicators ===
  removed_by_category?: string;  // e.g. "moderator", "deleted", "automod_filtered"
}
```

### 1.3 Comment Schema

Each line in `*_comments.zst` is a JSON object:

```typescript
/** Raw Pushshift comment record (NDJSON line) */
interface PushshiftComment {
  // === Identity ===
  id: string;                    // Reddit base-36 ID, e.g. "dbumnq8"
  name?: string;                 // Fullname "t1_dbumnq8"
  author: string;                // Username or "[deleted]"
  author_fullname?: string;

  // === Content ===
  body: string;                  // Comment text ("[removed]"/"[deleted]" if gone)

  // === Threading ===
  link_id: string;               // Parent submission fullname, e.g. "t3_kol20h"
  parent_id: string;             // Parent comment or submission fullname
                                 //   "t3_*" = top-level comment (parent is submission)
                                 //   "t1_*" = reply to another comment

  // === Location ===
  subreddit: string;
  subreddit_id: string;
  permalink?: string;            // Present in newer data

  // === Engagement ===
  score: number;                 // Net upvotes
  controversiality?: number;     // 0 or 1

  // === Timestamps ===
  created_utc: number;           // Unix epoch seconds
  retrieved_on?: number;

  // === Metadata ===
  stickied: boolean;
  distinguished?: string | null;
  author_flair_text?: string | null;
  is_submitter?: boolean;        // true if comment author == submission author

  // === Removal ===
  removed_by_category?: string;
}
```

### 1.4 Reading Zstandard NDJSON in Node.js/Bun

```typescript
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';

// Using @napi-rs/zstd or node-zstandard for decompression
import { ZstdDecompressStream } from '@napi-rs/zstd';

async function* readZstNdjson<T>(filePath: string): AsyncGenerator<T> {
  const fileStream = createReadStream(filePath);
  const decompressor = new ZstdDecompressStream();
  const decompressed = fileStream.pipe(decompressor);

  const rl = createInterface({
    input: decompressed,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (line.trim()) {
      yield JSON.parse(line) as T;
    }
  }
}
```

**Alternative for Bun** (native zstd via shell):
```typescript
// Bun can shell out to zstd for decompression with streaming
const proc = Bun.spawn(['zstd', '-d', '--stdout', filePath], {
  stdout: 'pipe',
});
```

### 1.5 Data Quality Notes

- **Scores are capture-time snapshots**: Pushshift captures scores at ingestion time, not final scores. Scores for recent posts may be volatile.
- **Deleted/removed content**: `author === "[deleted]"` and `body === "[removed]"` or `selftext === "[removed]"` should be filtered out.
- **Schema drift**: Older records (pre-2017) may lack fields like `upvote_ratio`, `retrieved_on`, `author_fullname`. Always use optional access.
- **Encoding**: Some records have Unicode issues. The Watchful1 scripts use chunked decode with fallback.

---

## 2. Input Adapter: Reddit → Pseudo-Session

### 2.1 Design Philosophy

The existing Signet pipeline processes **conversational sessions** (user↔assistant turns). Reddit threads are **multi-party discussions**. The adapter converts a Reddit thread into a **pseudo-session transcript** that the existing `summary-worker` can process without modification.

The key insight: a Reddit thread IS a conversation — just between community members rather than user↔assistant. We reformat it into a transcript-like structure.

### 2.2 Core Types

```typescript
// packages/groundswell/src/types.ts

/** A fully assembled Reddit thread ready for pipeline processing */
export interface RedditThread {
  readonly submissionId: string;
  readonly subreddit: string;
  readonly title: string;
  readonly author: string;
  readonly selftext: string;
  readonly score: number;
  readonly numComments: number;
  readonly createdUtc: number;
  readonly permalink: string;
  readonly upvoteRatio: number | null;
  readonly flairText: string | null;
  readonly comments: ReadonlyArray<RedditThreadComment>;
}

export interface RedditThreadComment {
  readonly id: string;
  readonly author: string;
  readonly body: string;
  readonly score: number;
  readonly parentId: string;      // "t3_*" or "t1_*"
  readonly createdUtc: number;
  readonly isSubmitter: boolean;
  readonly distinguished: string | null;
  readonly depth: number;         // computed during tree assembly
}

/** What we hand to the existing pipeline (mimics session transcript) */
export interface PseudoSession {
  readonly sessionKey: string;    // "groundswell:{subreddit}:{submissionId}"
  readonly harness: string;       // "groundswell"
  readonly project: string;       // "r/{subreddit}"
  readonly agentId: string;       // "groundswell-{subreddit}"
  readonly transcript: string;    // formatted pseudo-transcript
  readonly metadata: ThreadMetadata;
}

export interface ThreadMetadata {
  readonly subreddit: string;
  readonly submissionId: string;
  readonly title: string;
  readonly author: string;
  readonly score: number;
  readonly numComments: number;
  readonly commentCount: number;  // actual comments processed (after filtering)
  readonly topCommentScore: number;
  readonly createdUtc: number;
  readonly permalink: string;
  readonly upvoteRatio: number | null;
  readonly flairText: string | null;
  readonly threadDepth: number;   // max comment nesting depth
  readonly uniqueAuthors: number;
}

/** Engagement signals for significance gating */
export interface EngagementSignals {
  readonly score: number;
  readonly numComments: number;
  readonly uniqueAuthors: number;
  readonly topCommentScore: number;
  readonly upvoteRatio: number | null;
  readonly avgCommentScore: number;
  readonly threadDepth: number;
  readonly opParticipation: number;  // count of OP comments in thread
}
```

### 2.3 Thread Assembly

```typescript
// packages/groundswell/src/thread-assembler.ts

import type { PushshiftSubmission, PushshiftComment, RedditThread, RedditThreadComment } from './types';

/** Index: submissionId → comments[] (built from streaming comments file) */
export type CommentIndex = Map<string, PushshiftComment[]>;

/**
 * Build a comment index from streaming comments.
 * Memory-efficient: only retains comments for submissions in the target set.
 */
export function buildCommentIndex(
  comments: AsyncIterable<PushshiftComment>,
  targetSubmissionIds: ReadonlySet<string>,
): Promise<CommentIndex>;

/**
 * Assemble a full thread from a submission + its indexed comments.
 * Builds the comment tree, computes depths, filters [deleted]/[removed].
 */
export function assembleThread(
  submission: PushshiftSubmission,
  comments: PushshiftComment[],
): RedditThread {
  // Filter deleted/removed
  const validComments = comments.filter(c =>
    c.author !== '[deleted]' &&
    c.body !== '[removed]' &&
    c.body !== '[deleted]' &&
    c.body.trim().length > 0
  );

  // Build parent→children map for tree structure
  const childrenOf = new Map<string, PushshiftComment[]>();
  for (const c of validComments) {
    const parentKey = c.parent_id;
    if (!childrenOf.has(parentKey)) childrenOf.set(parentKey, []);
    childrenOf.get(parentKey)!.push(c);
  }

  // DFS to assign depths
  const submissionFullname = `t3_${submission.id}`;
  const threaded: RedditThreadComment[] = [];

  function walk(parentId: string, depth: number): void {
    const children = childrenOf.get(parentId) ?? [];
    // Sort by score descending within each level
    children.sort((a, b) => b.score - a.score);
    for (const child of children) {
      threaded.push({
        id: child.id,
        author: child.author,
        body: child.body,
        score: child.score,
        parentId: child.parent_id,
        createdUtc: child.created_utc,
        isSubmitter: child.author === submission.author,
        distinguished: child.distinguished ?? null,
        depth,
      });
      walk(`t1_${child.id}`, depth + 1);
    }
  }

  walk(submissionFullname, 0);

  return {
    submissionId: submission.id,
    subreddit: submission.subreddit,
    title: submission.title,
    author: submission.author,
    selftext: submission.selftext ?? '',
    score: submission.score,
    numComments: submission.num_comments,
    createdUtc: submission.created_utc,
    permalink: submission.permalink,
    upvoteRatio: submission.upvote_ratio ?? null,
    flairText: submission.link_flair_text ?? null,
    comments: threaded,
  };
}
```

### 2.4 Transcript Formatting

```typescript
// packages/groundswell/src/transcript-formatter.ts

import type { RedditThread, PseudoSession, ThreadMetadata, EngagementSignals } from './types';

const INDENT_CHARS = '  ';

/**
 * Format a Reddit thread as a pseudo-session transcript.
 *
 * Output format:
 *   [Thread: r/localllama | "Why I switched from GPT-4 to local models" | score: 1842 | 234 comments]
 *   [OP: u/model_enjoyer | 2024-03-15]
 *
 *   I've been running GPT-4 API calls for my startup and the costs were...
 *
 *   ---
 *
 *   u/llama_fan (score: 456):
 *   Have you tried quantized models? GGUF Q4_K_M gives great quality...
 *
 *     u/model_enjoyer [OP] (score: 123):
 *     Yeah I actually benchmarked a few...
 *
 *       u/quant_wizard (score: 89):
 *       Try Q5_K_S, it's worth the extra VRAM...
 */
export function formatThreadAsTranscript(thread: RedditThread): string {
  const date = new Date(thread.createdUtc * 1000).toISOString().slice(0, 10);
  const lines: string[] = [];

  // Header block
  lines.push(`[Thread: r/${thread.subreddit} | "${truncate(thread.title, 100)}" | score: ${thread.score} | ${thread.numComments} comments]`);
  lines.push(`[OP: u/${thread.author} | ${date}]`);
  if (thread.flairText) {
    lines.push(`[Flair: ${thread.flairText}]`);
  }
  lines.push('');

  // Submission body
  if (thread.selftext && thread.selftext !== '[removed]' && thread.selftext !== '[deleted]') {
    lines.push(thread.selftext);
  } else {
    lines.push(`[Link post: ${thread.permalink}]`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // Comments
  for (const comment of thread.comments) {
    const indent = INDENT_CHARS.repeat(comment.depth);
    const opTag = comment.isSubmitter ? ' [OP]' : '';
    const modTag = comment.distinguished === 'moderator' ? ' [MOD]' : '';
    lines.push(`${indent}u/${comment.author}${opTag}${modTag} (score: ${comment.score}):`);
    // Indent body lines to match
    const bodyLines = comment.body.split('\n');
    for (const bl of bodyLines) {
      lines.push(`${indent}${bl}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Build the full PseudoSession from a thread.
 */
export function threadToPseudoSession(thread: RedditThread): PseudoSession {
  const transcript = formatThreadAsTranscript(thread);
  const uniqueAuthors = new Set(
    [thread.author, ...thread.comments.map(c => c.author)]
  ).size;
  const maxDepth = thread.comments.reduce((max, c) => Math.max(max, c.depth), 0);
  const topCommentScore = thread.comments.reduce((max, c) => Math.max(max, c.score), 0);
  const opParticipation = thread.comments.filter(c => c.isSubmitter).length;
  const avgScore = thread.comments.length > 0
    ? thread.comments.reduce((sum, c) => sum + c.score, 0) / thread.comments.length
    : 0;

  return {
    sessionKey: `groundswell:${thread.subreddit}:${thread.submissionId}`,
    harness: 'groundswell',
    project: `r/${thread.subreddit}`,
    agentId: `groundswell-${thread.subreddit}`,
    transcript,
    metadata: {
      subreddit: thread.subreddit,
      submissionId: thread.submissionId,
      title: thread.title,
      author: thread.author,
      score: thread.score,
      numComments: thread.numComments,
      commentCount: thread.comments.length,
      topCommentScore,
      createdUtc: thread.createdUtc,
      permalink: thread.permalink,
      upvoteRatio: thread.upvoteRatio,
      flairText: thread.flairText,
      threadDepth: maxDepth,
      uniqueAuthors,
    },
  };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
```

---

## 3. Chunking Strategy

### 3.1 The Problem

The existing pipeline has `MAX_INPUT_CHARS` constraints (~12K chars for a single LLM call, ~20K `CHUNK_TARGET_CHARS` in summary-worker). A popular Reddit thread with hundreds of comments can produce a transcript of 50K–500K chars.

### 3.2 Strategy: Top-N by Score with Split

```
┌─────────────────────────────────────────┐
│            Full Thread                   │
│  (e.g., 300 comments, 120K chars)       │
└───────────┬─────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────┐
│  Phase 1: Top-N Comment Selection       │
│  Keep top N comments by score that fit  │
│  within 3× MAX_INPUT_CHARS budget.      │
│  Preserve thread structure (include     │
│  parent chain for context).             │
└───────────┬─────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────┐
│  Phase 2: Chunk if still over limit     │
│  Split at top-level comment boundaries  │
│  Each chunk gets shared context header  │
└───────────┬────────────┬────────────────┘
            │            │
            ▼            ▼
     ┌──────────┐  ┌──────────┐
     │ Chunk 1  │  │ Chunk 2  │  ...
     │ + Header │  │ + Header │
     └──────────┘  └──────────┘
```

### 3.3 Implementation

```typescript
// packages/groundswell/src/chunking.ts

/** Character limits matching existing pipeline constraints */
const MAX_INPUT_CHARS = 12_000;      // significance gate / single-pass limit
const CHUNK_TARGET_CHARS = 20_000;   // summary-worker chunk target
const CONTEXT_HEADER_BUDGET = 500;   // chars reserved for shared header
const MAX_COMMENTS_PER_THREAD = 200; // hard cap on comment count

export interface ChunkResult {
  readonly chunks: ReadonlyArray<string>;
  readonly totalChars: number;
  readonly commentsIncluded: number;
  readonly commentsDropped: number;
  readonly strategy: 'single' | 'top-n-single' | 'top-n-chunked';
}

/**
 * Build a shared context header that's prepended to every chunk.
 * Gives the LLM enough context to understand what it's summarizing.
 */
function buildContextHeader(thread: RedditThread, chunkIndex: number, totalChunks: number): string {
  const date = new Date(thread.createdUtc * 1000).toISOString().slice(0, 10);
  const lines = [
    `[Thread: r/${thread.subreddit} | "${truncate(thread.title, 80)}" | score: ${thread.score} | ${thread.numComments} comments]`,
    `[OP: u/${thread.author} | ${date}]`,
  ];
  if (totalChunks > 1) {
    lines.push(`[Chunk ${chunkIndex + 1} of ${totalChunks}]`);
  }
  // Include OP body preview if it's a text post (truncated)
  if (thread.selftext && thread.selftext !== '[removed]') {
    lines.push('');
    lines.push(`[OP body preview: ${truncate(thread.selftext, 200)}]`);
  }
  return lines.join('\n');
}

/**
 * Select top-N comments by score while preserving parent chains.
 *
 * Algorithm:
 * 1. Sort all comments by score descending.
 * 2. Greedily select comments that fit in the budget.
 * 3. For each selected comment, ensure its parent chain (up to submission)
 *    is also included for context.
 * 4. Return in tree-order (DFS by original thread structure).
 */
export function selectTopComments(
  thread: RedditThread,
  charBudget: number,
): RedditThreadComment[] {
  const commentsById = new Map(thread.comments.map(c => [c.id, c]));
  const selectedIds = new Set<string>();
  let usedChars = 0;

  // Sort by score descending
  const sorted = [...thread.comments].sort((a, b) => b.score - a.score);

  for (const comment of sorted) {
    if (selectedIds.size >= MAX_COMMENTS_PER_THREAD) break;
    if (usedChars >= charBudget) break;

    // Estimate this comment's char cost
    const commentChars = comment.body.length + comment.author.length + 40; // overhead
    if (usedChars + commentChars > charBudget && selectedIds.size > 0) continue;

    selectedIds.add(comment.id);
    usedChars += commentChars;

    // Walk parent chain to include context
    let parentId = comment.parentId;
    while (parentId.startsWith('t1_')) {
      const parentCommentId = parentId.slice(3);
      if (selectedIds.has(parentCommentId)) break;
      const parent = commentsById.get(parentCommentId);
      if (!parent) break;
      selectedIds.add(parentCommentId);
      usedChars += parent.body.length + parent.author.length + 40;
      parentId = parent.parentId;
    }
  }

  // Return in original tree-order (preserves DFS structure from assembleThread)
  return thread.comments.filter(c => selectedIds.has(c.id));
}

/**
 * Chunk a thread transcript for pipeline processing.
 */
export function chunkThread(thread: RedditThread): ChunkResult {
  // Phase 0: Small thread fits in single pass
  const fullTranscript = formatThreadAsTranscript(thread);
  if (fullTranscript.length <= MAX_INPUT_CHARS) {
    return {
      chunks: [fullTranscript],
      totalChars: fullTranscript.length,
      commentsIncluded: thread.comments.length,
      commentsDropped: 0,
      strategy: 'single',
    };
  }

  // Phase 1: Select top comments by score
  const charBudget = CHUNK_TARGET_CHARS * 3; // allow up to 3 chunks worth
  const topComments = selectTopComments(thread, charBudget);
  const trimmedThread = { ...thread, comments: topComments };
  const trimmedTranscript = formatThreadAsTranscript(trimmedThread);

  if (trimmedTranscript.length <= CHUNK_TARGET_CHARS) {
    return {
      chunks: [trimmedTranscript],
      totalChars: trimmedTranscript.length,
      commentsIncluded: topComments.length,
      commentsDropped: thread.comments.length - topComments.length,
      strategy: 'top-n-single',
    };
  }

  // Phase 2: Split into chunks at top-level comment boundaries
  const chunks: string[] = [];
  let currentChunkComments: RedditThreadComment[] = [];
  let currentChunkChars = 0;

  for (const comment of topComments) {
    const commentChars = comment.body.length + comment.author.length + 40;

    // Split at top-level comment boundaries when over budget
    if (comment.depth === 0 && currentChunkChars + commentChars > CHUNK_TARGET_CHARS - CONTEXT_HEADER_BUDGET && currentChunkComments.length > 0) {
      chunks.push(formatChunk(trimmedThread, currentChunkComments, chunks.length, -1)); // totalChunks unknown yet
      currentChunkComments = [];
      currentChunkChars = 0;
    }

    currentChunkComments.push(comment);
    currentChunkChars += commentChars;
  }

  // Flush final chunk
  if (currentChunkComments.length > 0) {
    chunks.push(formatChunk(trimmedThread, currentChunkComments, chunks.length, -1));
  }

  // Rewrite headers with correct total
  const finalChunks = chunks.map((_, i) =>
    formatChunk(trimmedThread,
      getCommentsForChunk(topComments, chunks.length, i),
      i, chunks.length)
  );

  return {
    chunks: finalChunks.length > 0 ? finalChunks : [trimmedTranscript],
    totalChars: finalChunks.reduce((sum, c) => sum + c.length, 0),
    commentsIncluded: topComments.length,
    commentsDropped: thread.comments.length - topComments.length,
    strategy: 'top-n-chunked',
  };
}
```

---

## 4. Batch Orchestrator

### 4.1 Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Batch Orchestrator                        │
│                                                             │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │ Subreddit   │  │   Job Queue  │  │  Checkpoint Store │  │
│  │ Registry    │  │  (SQLite)    │  │  (SQLite)         │  │
│  └──────┬──────┘  └──────┬───────┘  └────────┬──────────┘  │
│         │                │                    │             │
│  ┌──────▼────────────────▼────────────────────▼──────────┐  │
│  │              Per-Subreddit Workers                     │  │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐      │  │
│  │  │ r/localllama│  │r/machineL │  │  r/compsci │ ...  │  │
│  │  │  Worker    │  │  Worker    │  │  Worker    │      │  │
│  │  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘      │  │
│  │        │               │               │              │  │
│  │        ▼               ▼               ▼              │  │
│  │  ┌──────────────────────────────────────────────────┐ │  │
│  │  │            Rate Limiter (token bucket)            │ │  │
│  │  └──────────────────────┬───────────────────────────┘ │  │
│  └─────────────────────────┼─────────────────────────────┘  │
│                            │                                │
│                            ▼                                │
│  ┌─────────────────────────────────────────────────────────┐│
│  │  Existing Signet Pipeline                               ││
│  │  enqueueSummaryJob() → summary_jobs → summary-worker    ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

### 4.2 Database Schema (SQLite)

```sql
-- packages/groundswell/migrations/001_batch_orchestrator.sql

-- Subreddits being processed
CREATE TABLE IF NOT EXISTS groundswell_subreddits (
  subreddit         TEXT PRIMARY KEY,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'active', 'paused', 'completed', 'error')),
  submissions_file  TEXT,              -- path to .zst file
  comments_file     TEXT,              -- path to .zst file
  total_submissions INTEGER DEFAULT 0,
  processed_count   INTEGER DEFAULT 0,
  skipped_count     INTEGER DEFAULT 0, -- below significance threshold
  error_count       INTEGER DEFAULT 0,
  last_processed_utc INTEGER DEFAULT 0, -- chronological cursor (unix epoch)
  last_checkpoint_at TEXT,
  priority          INTEGER DEFAULT 0, -- higher = processed first
  config_json       TEXT,              -- per-subreddit overrides (JSON)
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Individual thread processing jobs
CREATE TABLE IF NOT EXISTS groundswell_jobs (
  id                TEXT PRIMARY KEY,
  subreddit         TEXT NOT NULL,
  submission_id     TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'processing', 'completed', 'skipped', 'failed', 'dead')),
  created_utc       INTEGER NOT NULL,  -- submission timestamp for ordering
  score             INTEGER NOT NULL DEFAULT 0,
  num_comments      INTEGER NOT NULL DEFAULT 0,
  transcript_chars  INTEGER,
  chunk_count       INTEGER,
  strategy          TEXT,              -- 'single', 'top-n-single', 'top-n-chunked'
  significance_json TEXT,              -- engagement scores that passed gate
  summary_job_id    TEXT,              -- FK to summary_jobs.id (nullable)
  error             TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 3,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at      TEXT,

  UNIQUE(subreddit, submission_id)
);

CREATE INDEX IF NOT EXISTS idx_groundswell_jobs_status
  ON groundswell_jobs(subreddit, status, created_utc ASC);

CREATE INDEX IF NOT EXISTS idx_groundswell_jobs_cursor
  ON groundswell_jobs(subreddit, created_utc ASC);

-- Checkpoint for streaming resume
CREATE TABLE IF NOT EXISTS groundswell_checkpoints (
  subreddit         TEXT NOT NULL,
  file_type         TEXT NOT NULL CHECK (file_type IN ('submissions', 'comments')),
  byte_offset       INTEGER NOT NULL DEFAULT 0,
  records_read      INTEGER NOT NULL DEFAULT 0,
  last_created_utc  INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),

  PRIMARY KEY (subreddit, file_type)
);

-- Rate limiting state
CREATE TABLE IF NOT EXISTS groundswell_rate_state (
  key               TEXT PRIMARY KEY,   -- e.g. 'llm_calls' or 'subreddit:localllama'
  tokens            REAL NOT NULL DEFAULT 0,
  last_refill_at    TEXT NOT NULL DEFAULT (datetime('now')),
  max_tokens        REAL NOT NULL DEFAULT 10,
  refill_rate       REAL NOT NULL DEFAULT 1.0  -- tokens per second
);
```

### 4.3 Core Interfaces

```typescript
// packages/groundswell/src/orchestrator.ts

export interface OrchestratorConfig {
  /** Max concurrent subreddit workers */
  readonly maxConcurrentSubreddits: number;     // default: 3
  /** Max LLM calls per minute across all workers */
  readonly globalRateLimitPerMinute: number;     // default: 30
  /** Per-subreddit rate limit (LLM calls/min) */
  readonly perSubredditRateLimitPerMinute: number; // default: 10
  /** Min score for a submission to be considered */
  readonly minSubmissionScore: number;            // default: 5
  /** Min comments for a submission to be considered */
  readonly minCommentCount: number;               // default: 3
  /** Poll interval for job queue (ms) */
  readonly pollIntervalMs: number;                // default: 2000
  /** Path to data directory with .zst files */
  readonly dataDir: string;
  /** Database path */
  readonly dbPath: string;
  /** Significance gate config */
  readonly significance: CommunitySignificanceConfig;
}

export interface SubredditWorkerHandle {
  readonly subreddit: string;
  readonly status: 'running' | 'paused' | 'stopped';
  stop(): void;
  pause(): void;
  resume(): void;
}

export interface OrchestratorHandle {
  /** Start processing registered subreddits */
  start(): void;
  /** Graceful shutdown — finish current jobs, checkpoint, stop */
  stop(): Promise<void>;
  /** Register a new subreddit for processing */
  addSubreddit(subreddit: string, submissionsFile: string, commentsFile: string, priority?: number): void;
  /** Get processing status for all subreddits */
  status(): SubredditStatus[];
  /** Get overall statistics */
  stats(): OrchestratorStats;
}

export interface SubredditStatus {
  readonly subreddit: string;
  readonly status: string;
  readonly totalSubmissions: number;
  readonly processedCount: number;
  readonly skippedCount: number;
  readonly errorCount: number;
  readonly lastProcessedUtc: number;
  readonly percentComplete: number;
}

export interface OrchestratorStats {
  readonly activeWorkers: number;
  readonly totalJobsPending: number;
  readonly totalJobsCompleted: number;
  readonly totalJobsSkipped: number;
  readonly totalJobsFailed: number;
  readonly llmCallsThisMinute: number;
  readonly avgProcessingTimeMs: number;
}
```

### 4.4 Orchestrator Implementation

```typescript
// packages/groundswell/src/orchestrator.ts

import { Database } from 'bun:sqlite';

export function createOrchestrator(config: OrchestratorConfig): OrchestratorHandle {
  const db = new Database(config.dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');

  // Run migrations
  initSchema(db);

  const workers = new Map<string, SubredditWorkerHandle>();
  let stopped = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  const rateLimiter = createTokenBucketLimiter({
    maxTokens: config.globalRateLimitPerMinute,
    refillRate: config.globalRateLimitPerMinute / 60, // per second
  });

  async function scheduleWorkers(): Promise<void> {
    if (stopped) return;

    // Get subreddits needing work, ordered by priority
    const pending = db.prepare(`
      SELECT subreddit, submissions_file, comments_file, priority
      FROM groundswell_subreddits
      WHERE status IN ('pending', 'active')
      ORDER BY priority DESC, created_at ASC
    `).all() as SubredditRow[];

    // Start workers up to concurrency limit
    for (const row of pending) {
      if (workers.size >= config.maxConcurrentSubreddits) break;
      if (workers.has(row.subreddit)) continue;

      const worker = startSubredditWorker(db, row, config, rateLimiter);
      workers.set(row.subreddit, worker);

      // Mark active
      db.prepare(`UPDATE groundswell_subreddits SET status = 'active' WHERE subreddit = ?`)
        .run(row.subreddit);
    }

    // Clean up completed workers
    for (const [sub, worker] of workers) {
      if (worker.status === 'stopped') {
        workers.delete(sub);
      }
    }

    pollTimer = setTimeout(() => scheduleWorkers(), config.pollIntervalMs);
  }

  return {
    start() { scheduleWorkers(); },
    async stop() {
      stopped = true;
      if (pollTimer) clearTimeout(pollTimer);
      // Graceful shutdown: let workers finish current job
      await Promise.all(
        Array.from(workers.values()).map(w => {
          w.stop();
          return new Promise<void>(resolve => {
            const check = setInterval(() => {
              if (w.status === 'stopped') { clearInterval(check); resolve(); }
            }, 500);
          });
        })
      );
      db.close();
    },
    addSubreddit(subreddit, submissionsFile, commentsFile, priority = 0) {
      db.prepare(`
        INSERT OR IGNORE INTO groundswell_subreddits
          (subreddit, submissions_file, comments_file, priority)
        VALUES (?, ?, ?, ?)
      `).run(subreddit, submissionsFile, commentsFile, priority);
    },
    status() { /* query groundswell_subreddits */ },
    stats() { /* aggregate from groundswell_jobs + rate_state */ },
  };
}
```

### 4.5 Per-Subreddit Worker

```typescript
// packages/groundswell/src/subreddit-worker.ts

/**
 * Worker lifecycle:
 * 1. SCAN: Stream submissions .zst chronologically, filter by score/comments thresholds
 * 2. INDEX: For qualifying submissions, load their comments from the comments .zst
 * 3. ASSEMBLE: Build thread trees, format as pseudo-sessions
 * 4. GATE: Run community significance gate
 * 5. ENQUEUE: If significant, enqueue as a summary_job in the existing pipeline
 * 6. CHECKPOINT: Periodically save byte offset + last_created_utc for resume
 */

export function startSubredditWorker(
  db: Database,
  config: SubredditWorkerConfig,
  rateLimiter: TokenBucketLimiter,
): SubredditWorkerHandle {
  let status: 'running' | 'paused' | 'stopped' = 'running';
  let currentAbort = new AbortController();

  async function run(): Promise<void> {
    // Load checkpoint for resume
    const checkpoint = loadCheckpoint(db, config.subreddit);

    // Phase 1: Scan submissions chronologically
    const submissions: QualifyingSubmission[] = [];
    let scanned = 0;
    let byteOffset = checkpoint?.byteOffset ?? 0;

    for await (const submission of readZstNdjson<PushshiftSubmission>(
      config.submissionsFile,
      byteOffset,
    )) {
      if (currentAbort.signal.aborted) break;

      scanned++;

      // Skip already-processed (chronological guarantee)
      if (submission.created_utc <= (checkpoint?.lastCreatedUtc ?? 0)) continue;

      // Pre-filter: basic engagement thresholds
      if (submission.score < config.minSubmissionScore) continue;
      if (submission.num_comments < config.minCommentCount) continue;
      if (submission.author === '[deleted]') continue;
      if (submission.selftext === '[removed]') continue;

      submissions.push({
        submission,
        status: 'pending',
      });

      // Batch: process every 100 qualifying submissions
      if (submissions.length >= 100) {
        await processBatch(submissions);
        submissions.length = 0;

        // Checkpoint
        saveCheckpoint(db, config.subreddit, 'submissions', {
          byteOffset: scanned, // approximate
          recordsRead: scanned,
          lastCreatedUtc: submission.created_utc,
        });
      }
    }

    // Flush remaining
    if (submissions.length > 0) {
      await processBatch(submissions);
    }

    status = 'stopped';
  }

  async function processBatch(submissions: QualifyingSubmission[]): Promise<void> {
    // Collect submission IDs for this batch
    const targetIds = new Set(submissions.map(s => s.submission.id));

    // Stream comments file to build index for just these submissions
    const commentIndex = await buildCommentIndex(
      readZstNdjson<PushshiftComment>(config.commentsFile),
      targetIds,
    );

    for (const { submission } of submissions) {
      if (currentAbort.signal.aborted) break;
      if (status === 'paused') {
        await waitForResume();
      }

      try {
        // Assemble thread
        const comments = commentIndex.get(submission.id) ?? [];
        const thread = assembleThread(submission, comments);
        const pseudoSession = threadToPseudoSession(thread);

        // Significance gate
        const engagement = computeEngagement(thread);
        if (!passesCommunitySigGate(engagement, config.significance)) {
          recordSkipped(db, config.subreddit, submission.id, engagement);
          continue;
        }

        // Rate limit: wait for token
        await rateLimiter.acquire();

        // Chunk if needed
        const chunkResult = chunkThread(thread);

        // Enqueue into existing pipeline
        for (const chunk of chunkResult.chunks) {
          const jobId = enqueueSummaryJob(accessor, {
            harness: 'groundswell',
            transcript: chunk,
            sessionKey: pseudoSession.sessionKey,
            project: pseudoSession.project,
            agentId: pseudoSession.agentId,
          });
        }

        recordCompleted(db, config.subreddit, submission.id, chunkResult);
      } catch (error) {
        recordError(db, config.subreddit, submission.id, error);
      }
    }
  }

  // Start the worker
  run().catch(err => {
    console.error(`Worker ${config.subreddit} crashed:`, err);
    status = 'stopped';
  });

  return {
    subreddit: config.subreddit,
    get status() { return status; },
    stop() { currentAbort.abort(); status = 'stopped'; },
    pause() { status = 'paused'; },
    resume() { status = 'running'; },
  };
}
```

### 4.6 Chronological Ordering Guarantee

Submissions within each `.zst` file are **already ordered by `created_utc` ascending** (as produced by Pushshift). The worker processes them in file order, maintaining the chronological cursor in `groundswell_checkpoints.last_created_utc`. On resume, it skips all submissions with `created_utc <= last_processed_utc`.

Cross-subreddit ordering is not required — each subreddit's knowledge graph is independent. Within a subreddit, strict chronological order ensures the LLM builds knowledge cumulatively (later threads can reference entities from earlier ones).

### 4.7 Rate Limiter

```typescript
// packages/groundswell/src/rate-limiter.ts

export interface TokenBucketLimiter {
  acquire(tokens?: number): Promise<void>;
  tryAcquire(tokens?: number): boolean;
  readonly available: number;
}

export function createTokenBucketLimiter(config: {
  maxTokens: number;
  refillRate: number; // tokens per second
}): TokenBucketLimiter {
  let tokens = config.maxTokens;
  let lastRefill = Date.now();
  const waiters: Array<{ resolve: () => void; tokens: number }> = [];

  function refill(): void {
    const now = Date.now();
    const elapsed = (now - lastRefill) / 1000;
    tokens = Math.min(config.maxTokens, tokens + elapsed * config.refillRate);
    lastRefill = now;
  }

  function tryDrain(): void {
    refill();
    while (waiters.length > 0 && tokens >= waiters[0].tokens) {
      const waiter = waiters.shift()!;
      tokens -= waiter.tokens;
      waiter.resolve();
    }
  }

  // Periodic drain check
  setInterval(tryDrain, 100);

  return {
    async acquire(count = 1) {
      refill();
      if (tokens >= count) {
        tokens -= count;
        return;
      }
      return new Promise<void>(resolve => {
        waiters.push({ resolve, tokens: count });
      });
    },
    tryAcquire(count = 1) {
      refill();
      if (tokens >= count) { tokens -= count; return true; }
      return false;
    },
    get available() { refill(); return tokens; },
  };
}
```

### 4.8 Karma Feedback Scheduling

Higher-signal threads should be processed first within each batch. The worker implements **score-weighted priority scheduling**:

```typescript
/** Sort submissions within a batch window by expected information value */
function prioritizeSubmissions(
  submissions: QualifyingSubmission[],
): QualifyingSubmission[] {
  return submissions.sort((a, b) => {
    // Composite score: weighted sum of normalized engagement signals
    const scoreA = computePriorityScore(a.submission);
    const scoreB = computePriorityScore(b.submission);
    return scoreB - scoreA;
  });
}

function computePriorityScore(s: PushshiftSubmission): number {
  const logScore = Math.log1p(Math.max(0, s.score));
  const logComments = Math.log1p(s.num_comments);
  const ratioBoost = (s.upvote_ratio ?? 0.5) > 0.8 ? 1.2 : 1.0;
  const isText = s.is_self ? 1.5 : 1.0; // text posts have more extractable content

  return (logScore * 0.4 + logComments * 0.4) * ratioBoost * isText;
}
```

---

## 5. Significance Gate Adaptation

### 5.1 Current Gate (Session Mode)

The existing `assessSignificance()` uses three signals:
1. **Turn count** — substantive user↔assistant turn pairs (>20 char user, >50 char assistant)
2. **Entity overlap** — references to known high-mention entities
3. **Content novelty** — unique tokens vs recent session summaries

All three must fail for a session to be gated out.

### 5.2 Community Mode Branch

Reddit threads don't have user↔assistant turns. We need a parallel branch that evaluates **engagement metadata** instead.

```typescript
// packages/groundswell/src/community-significance-gate.ts

export interface CommunitySignificanceConfig {
  readonly enabled: boolean;
  /** Min submission score to pass */
  readonly minScore: number;              // default: 10
  /** Min total comments */
  readonly minComments: number;           // default: 5
  /** Min unique participants */
  readonly minUniqueAuthors: number;      // default: 3
  /** Min score of top comment */
  readonly minTopCommentScore: number;    // default: 5
  /** Min average comment score */
  readonly minAvgCommentScore: number;    // default: 2
  /** Novelty threshold (0-1, reuses existing tokenize/novelty logic) */
  readonly noveltyThreshold: number;      // default: 0.15
  /** Min OP participation (comments by OP in own thread) */
  readonly minOpParticipation: number;    // default: 0 (no requirement)
}

export interface CommunitySignificanceResult {
  readonly significant: boolean;
  readonly scores: {
    readonly submissionScore: number;
    readonly commentCount: number;
    readonly uniqueAuthors: number;
    readonly topCommentScore: number;
    readonly avgCommentScore: number;
    readonly novelty: number;
    readonly opParticipation: number;
  };
  readonly reason: string;
}

/**
 * Community-mode significance gate.
 *
 * Philosophy: Reddit's voting system already performs significance filtering.
 * High-score threads with many participants contain community-validated knowledge.
 * We trust the community's signal and supplement with novelty checking.
 *
 * Gate logic (ANY of these must pass):
 *   1. Engagement: score >= min AND comments >= min AND uniqueAuthors >= min
 *   2. Top comment quality: topCommentScore >= min
 *   3. Content novelty: novel content not seen in recent processed threads
 */
export function assessCommunitySignificance(
  engagement: EngagementSignals,
  novelty: number,
  config: CommunitySignificanceConfig,
): CommunitySignificanceResult {
  if (!config.enabled) {
    return { significant: true, scores: buildScores(engagement, novelty), reason: 'gate disabled' };
  }

  const engagementPasses =
    engagement.score >= config.minScore &&
    engagement.numComments >= config.minComments &&
    engagement.uniqueAuthors >= config.minUniqueAuthors;

  const topCommentPasses = engagement.topCommentScore >= config.minTopCommentScore;
  const noveltyPasses = novelty >= config.noveltyThreshold;
  const opPasses = config.minOpParticipation <= 0 || engagement.opParticipation >= config.minOpParticipation;

  // Pass if engagement OR (topComment AND novelty)
  const significant = (engagementPasses && opPasses) || (topCommentPasses && noveltyPasses);

  const reasons: string[] = [];
  if (!engagementPasses) reasons.push(`engagement: score=${engagement.score}, comments=${engagement.numComments}, authors=${engagement.uniqueAuthors}`);
  if (!topCommentPasses) reasons.push(`topComment=${engagement.topCommentScore}<${config.minTopCommentScore}`);
  if (!noveltyPasses) reasons.push(`novelty=${novelty.toFixed(2)}<${config.noveltyThreshold}`);
  if (!opPasses) reasons.push(`opParticipation=${engagement.opParticipation}<${config.minOpParticipation}`);

  return {
    significant,
    scores: buildScores(engagement, novelty),
    reason: significant ? 'passed' : `below threshold: ${reasons.join(', ')}`,
  };
}

/**
 * Adapter: compute novelty using the existing tokenize/sampleTranscript logic.
 * Reuses computeNovelty from significance-gate.ts but against processed
 * groundswell threads instead of session summaries.
 */
export function computeCommunityNovelty(
  transcript: string,
  db: ReadDb,
  agentId: string,
): number {
  // Reuse existing novelty computation but query groundswell-specific summaries
  // Query last 10 completed groundswell jobs for this subreddit
  let recentTranscripts: Array<{ transcript: string }>;
  try {
    recentTranscripts = db.prepare(`
      SELECT sj.transcript
      FROM summary_jobs sj
      JOIN groundswell_jobs gj ON gj.summary_job_id = sj.id
      WHERE sj.status = 'completed'
        AND sj.agent_id = ?
      ORDER BY sj.completed_at DESC
      LIMIT 10
    `).all(agentId) as Array<{ transcript: string }>;
  } catch {
    return 1.0; // Novel by default if table missing
  }

  if (recentTranscripts.length === 0) return 1.0;

  // Reuse existing tokenize + novelty ratio logic
  const currentTokens = tokenize(sampleTranscript(transcript));
  if (currentTokens.size === 0) return 1.0;

  const recentTokens = new Set<string>();
  for (const row of recentTranscripts) {
    for (const tok of tokenize(sampleTranscript(row.transcript))) {
      recentTokens.add(tok);
    }
  }

  let unique = 0;
  for (const tok of currentTokens) {
    if (!recentTokens.has(tok)) unique++;
  }

  const ratio = unique / currentTokens.size;
  if (ratio >= 0.3) return 1.0;
  if (ratio <= 0.1) return 0.0;
  return (ratio - 0.1) / 0.2;
}
```

### 5.3 Integration with Existing Gate

The existing `assessSignificance()` in `significance-gate.ts` doesn't need modification. Instead, the batch orchestrator calls the community gate BEFORE enqueueing into `summary_jobs`. The summary-worker's existing significance gate will see the `groundswell` harness and should be configured to pass through (since we already gated):

```typescript
// In memory-config or per-session config, set significance gate to pass for groundswell:
// Alternatively, the significance gate could check the harness:
//   if (job.harness === 'groundswell') return true; // already pre-gated
```

---

## 6. Integration Points

### 6.1 Entry Point: Where the Orchestrator Hooks In

The orchestrator **does not modify any existing pipeline files**. It integrates at a single point:

```
┌────────────────────────────────┐
│  Existing Pipeline Entry       │
│                                │
│  hooks.ts handleSessionEnd()   │
│       │                        │
│       ▼                        │
│  enqueueSummaryJob()           │ ◄── Groundswell orchestrator also calls this
│       │                        │
│       ▼                        │
│  summary_jobs table            │
│       │                        │
│       ▼                        │
│  summary-worker tick()         │
│       │                        │
│       ▼                        │
│  processJob()                  │
│       │                        │
│       ├── passesSignificanceGate()  ← skip for groundswell (pre-gated)
│       ├── processSingle/Chunked()   ← works as-is on pseudo-transcripts
│       ├── writeSummaryToDAG()       ← writes to session_summaries
│       └── insertSummaryFacts()      ← inserts into memories table
│                                │
└────────────────────────────────┘
```

### 6.2 Exact Function Call Sequence

```typescript
// packages/groundswell/src/pipeline-bridge.ts

import { getDbAccessor } from '@signet/daemon/db-accessor';
import { enqueueSummaryJob } from '@signet/daemon/pipeline/summary-worker';

/**
 * Bridge function: enqueue a Reddit thread into the existing pipeline.
 *
 * Call sequence:
 * 1. chunkThread(thread)            → split into processable chunks
 * 2. For each chunk:
 *    a. enqueueSummaryJob(accessor, params) → inserts into summary_jobs
 *    b. summary-worker picks up job via tick() polling
 *    c. processJob() runs:
 *       - passesSignificanceGate() → configured to skip for harness=groundswell
 *       - provider.generate(buildPrompt(transcript)) → LLM summarization
 *       - insertSummaryFacts() → atomic facts → memories table
 *       - writeSummaryToDAG() → session_summaries table
 *       - scoreContinuity() → skipped (no injected memories for batch)
 */
export async function enqueueThreadForProcessing(
  thread: RedditThread,
  config: OrchestratorConfig,
): Promise<{ jobIds: string[]; chunkCount: number }> {
  const accessor = getDbAccessor();
  const pseudoSession = threadToPseudoSession(thread);
  const chunkResult = chunkThread(thread);
  const jobIds: string[] = [];

  for (let i = 0; i < chunkResult.chunks.length; i++) {
    const sessionKey = chunkResult.chunks.length > 1
      ? `${pseudoSession.sessionKey}:chunk:${i + 1}`
      : pseudoSession.sessionKey;

    const jobId = enqueueSummaryJob(accessor, {
      harness: 'groundswell',
      transcript: chunkResult.chunks[i],
      sessionKey,
      project: pseudoSession.project,
      agentId: pseudoSession.agentId,
    });

    jobIds.push(jobId);
  }

  return { jobIds, chunkCount: chunkResult.chunks.length };
}
```

### 6.3 Configuration: Telling the Pipeline About Groundswell

Add to `agent.yaml`:

```yaml
memory:
  pipelineV2:
    # Existing config...
    groundswell:
      enabled: true
      dataDir: "~/.agents/groundswell/data"
      dbPath: "~/.agents/groundswell/orchestrator.db"
      maxConcurrentSubreddits: 3
      globalRateLimitPerMinute: 30
      perSubredditRateLimitPerMinute: 10
      minSubmissionScore: 10
      minCommentCount: 5
      significance:
        enabled: true
        minScore: 10
        minComments: 5
        minUniqueAuthors: 3
        minTopCommentScore: 5
        minAvgCommentScore: 2
        noveltyThreshold: 0.15

    # Override significance gate for groundswell harness
    significance:
      groundswellBypass: true  # skip turn-counting gate for pre-gated batch jobs
```

### 6.4 Agent ID Convention

Each subreddit gets its own agent ID: `groundswell-{subreddit}`. This means:

- Memories are scoped per-subreddit in the `memories` table
- Knowledge graph entities are per-subreddit
- Session summaries are isolated per-community
- Later, cross-community queries can use `readPolicy: "shared"` or group-based policies

---

## 7. Scalability

### 7.1 Pilot: 100 Communities (SQLite)

For the pilot with ~100 communities, SQLite is sufficient:

```
Storage estimate (100 communities):
- groundswell_subreddits: 100 rows (~10 KB)
- groundswell_jobs: ~500K rows (avg 5K submissions/community × 100)
  → ~200 MB with transcript_chars, significance_json
- groundswell_checkpoints: 200 rows (2 per community)
- Existing tables growth:
  - summary_jobs: +500K rows
  - memories: +1.5M facts (avg 3 facts per thread)
  - session_summaries: +500K rows

Total additional SQLite: ~2 GB
```

**Optimization for pilot**:
- WAL mode (already set)
- `PRAGMA busy_timeout = 5000` (concurrent read/write tolerance)
- `PRAGMA cache_size = -64000` (64MB page cache)
- Batch inserts in transactions (100 rows per tx)

### 7.2 Growth: 1,000 Communities

At 1,000 communities, SQLite remains viable with careful management:

- Shard the `groundswell_jobs` table by subreddit into separate databases
- Keep `groundswell_subreddits` and `groundswell_checkpoints` in a central DB
- Use connection pooling (max 1 writer per shard)

```typescript
interface ShardedDbManager {
  /** Get or create a shard DB for a subreddit */
  getShard(subreddit: string): Database;
  /** Close all shard connections */
  closeAll(): void;
}

// Sharding by first 2 chars of subreddit name
function getShardKey(subreddit: string): string {
  return subreddit.slice(0, 2).toLowerCase();
}
```

### 7.3 Scale: 10,000 Communities (Postgres Migration)

At 10,000 communities, migrate to Postgres:

**Migration path**:

1. **Abstract the DB layer now** — use the existing `DbAccessor` pattern:

```typescript
// packages/groundswell/src/db.ts

export interface GroundswellDb {
  // Job management
  createJob(params: CreateJobParams): string;
  getNextPendingJob(subreddit: string): GroundswellJob | null;
  completeJob(jobId: string, result: JobResult): void;
  failJob(jobId: string, error: string): void;
  skipJob(jobId: string, reason: string): void;

  // Checkpoints
  loadCheckpoint(subreddit: string, fileType: string): Checkpoint | null;
  saveCheckpoint(subreddit: string, fileType: string, checkpoint: Checkpoint): void;

  // Subreddit management
  registerSubreddit(params: RegisterParams): void;
  getActiveSubreddits(): SubredditRow[];
  updateSubredditStatus(subreddit: string, status: string): void;

  // Stats
  getStats(): OrchestratorStats;
}

// SQLite implementation (pilot)
export function createSqliteGroundswellDb(path: string): GroundswellDb;

// Postgres implementation (scale)
export function createPgGroundswellDb(connectionString: string): GroundswellDb;
```

2. **Postgres schema additions for scale**:

```sql
-- Partitioned by subreddit for 10K+ communities
CREATE TABLE groundswell_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subreddit       TEXT NOT NULL,
  submission_id   TEXT NOT NULL,
  -- ... same fields as SQLite ...
  UNIQUE(subreddit, submission_id)
) PARTITION BY HASH (subreddit);

-- Create 64 partitions
CREATE TABLE groundswell_jobs_p00 PARTITION OF groundswell_jobs FOR VALUES WITH (MODULUS 64, REMAINDER 0);
-- ... through p63 ...

-- Connection pooling via PgBouncer
-- Async job processing via SKIP LOCKED:
SELECT * FROM groundswell_jobs
WHERE status = 'pending' AND subreddit = $1
ORDER BY created_utc ASC
LIMIT 1
FOR UPDATE SKIP LOCKED;
```

3. **Horizontal scaling** (10K+ communities):

```
┌─────────────────────────────────────────────┐
│  Orchestrator Coordinator (single process)  │
│  - Assigns subreddits to worker processes   │
│  - Monitors health/progress                 │
│  - Manages global rate limit                │
└──────────────┬──────────────────────────────┘
               │
    ┌──────────┼──────────┐
    ▼          ▼          ▼
┌────────┐ ┌────────┐ ┌────────┐
│Worker 1│ │Worker 2│ │Worker 3│  (N processes, each handles M subreddits)
│ Sub A  │ │ Sub D  │ │ Sub G  │
│ Sub B  │ │ Sub E  │ │ Sub H  │
│ Sub C  │ │ Sub F  │ │ Sub I  │
└───┬────┘ └───┬────┘ └───┬────┘
    │          │          │
    ▼          ▼          ▼
┌─────────────────────────────────────────────┐
│          Postgres (shared state)            │
│  + Redis (distributed rate limiting)        │
└─────────────────────────────────────────────┘
```

### 7.4 Resource Estimates

| Scale | Communities | Submissions | LLM Calls* | Wall Time** | Storage |
|-------|------------|-------------|------------|-------------|---------|
| Pilot | 100 | ~500K | ~200K | ~5 days | ~2 GB |
| Mid | 1,000 | ~5M | ~2M | ~50 days | ~20 GB |
| Full | 10,000 | ~50M | ~20M | ~500 days*** | ~200 GB |

\* After significance gating (~40% pass rate)  
\** At 30 LLM calls/minute (single process)  
\*** Requires horizontal scaling (10 workers → ~50 days)

### 7.5 Cost Optimization

1. **Tiered LLM usage**: Use cheap models (Haiku, GPT-4o-mini) for batch processing, reserve expensive models for interactive sessions
2. **Aggressive significance gating**: Tune thresholds per-subreddit based on community characteristics
3. **Incremental processing**: Only process new threads since last run (chronological cursor)
4. **Ollama fallback**: For pilot, run summarization locally to avoid API costs entirely

---

## Appendix A: File Layout

```
packages/
  groundswell/
    src/
      types.ts                    # PushshiftSubmission, PushshiftComment, RedditThread, etc.
      zst-reader.ts              # Streaming .zst NDJSON reader
      thread-assembler.ts        # Comment tree building, thread assembly
      transcript-formatter.ts    # Reddit thread → pseudo-session transcript
      chunking.ts                # Top-N selection, chunk splitting
      community-significance-gate.ts  # Engagement-based gating
      rate-limiter.ts            # Token bucket rate limiter
      subreddit-worker.ts        # Per-subreddit processing worker
      orchestrator.ts            # Batch orchestrator coordinator
      pipeline-bridge.ts         # Integration with existing enqueueSummaryJob
      db.ts                      # Database abstraction (SQLite/Postgres)
    migrations/
      001_batch_orchestrator.sql # Schema
    tests/
      thread-assembler.test.ts
      chunking.test.ts
      community-significance-gate.test.ts
      rate-limiter.test.ts
    package.json
```

## Appendix B: Data Download Instructions

```bash
# 1. Install qBittorrent
brew install qbittorrent  # macOS

# 2. Download the torrent file from Academic Torrents
# https://academictorrents.com/details/1614740ac8c94505e4ecb9d88be8bed7b6afddd4

# 3. In qBittorrent, add the torrent and select only the subreddits you want:
#    subreddits24/localllama_submissions.zst
#    subreddits24/localllama_comments.zst
#    subreddits24/MachineLearning_submissions.zst
#    subreddits24/MachineLearning_comments.zst
#    ... etc

# 4. Register subreddits with the orchestrator
bun run packages/groundswell/src/cli.ts add \
  --subreddit localllama \
  --submissions ./data/subreddits24/localllama_submissions.zst \
  --comments ./data/subreddits24/localllama_comments.zst \
  --priority 10

# 5. Start processing
bun run packages/groundswell/src/cli.ts start
```
