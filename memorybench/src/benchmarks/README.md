# Benchmarks

Benchmark dataset adapters. Each benchmark implements the `Benchmark` interface.

## Interface

```typescript
interface Benchmark {
    name: string
    protocol?: BenchmarkProtocol
    load(config?: BenchmarkConfig): Promise<void>
    getQuestions(filter?: QuestionFilter): UnifiedQuestion[]
    getHaystackSessions(questionId: string): UnifiedSession[]
    getGroundTruth(questionId: string): string
    getQuestionTypes(): QuestionTypeRegistry
    getIngestionGroupId?(questionId: string): string
    getDatasetIdentity?(): Record<string, unknown> | undefined
}
```

Optional members:

- `getIngestionGroupId()` - questions returning the same group share one
  container and are ingested and indexed once (BEAM's 20 questions per chat).
- `protocol` - a benchmark that defines its own scoring owns the retrieval
  Top-K, answer prompt, per-question evaluation (score in [0, 1] plus usage),
  and aggregation into a primary metric. Without it, the harness uses the
  provider's answer prompt and the legacy correct/incorrect judge.
- `getDatasetIdentity()` - provenance recorded in the checkpoint and report; a
  resumed run fails if it changed.

## Adding a Benchmark

1. Create `src/benchmarks/mybenchmark/index.ts`
2. Implement `Benchmark` interface
3. Register in `src/benchmarks/index.ts`
4. Add to `BenchmarkName` type in `src/types/benchmark.ts`

**Required returns:**
- `load()` - Parse data, populate internal maps
- `getQuestions()` - Return `UnifiedQuestion[]` with filtering support
- `getHaystackSessions()` - Return `UnifiedSession[]` for a question
- `getGroundTruth()` - Return expected answer string
- `getQuestionTypes()` - Return `{ [id]: { id, alias, description } }`

## Existing Benchmarks

| Benchmark | Source | Description |
|-----------|--------|-------------|
| `locomo` | GitHub snap-research/locomo | Long context memory benchmark |
| `longmemeval` | HuggingFace xiaowu0162/longmemeval-cleaned | Long-term memory evaluation |
| `convomem` | HuggingFace Salesforce/ConvoMem | Conversational memory benchmark |
| `beam-1m` / `beam-10m` | Pinned Hugging Face BEAM revisions via `beam prepare` | Ten memory abilities over 1M / 10M token conversations |

## Question Types

### LoCoMo
| Type | Alias | Description |
|------|-------|-------------|
| `single-hop` | single | Single-hop fact recall |
| `multi-hop` | multi | Multi-hop reasoning |
| `temporal` | temporal | Temporal reasoning |
| `world-knowledge` | world | Commonsense knowledge |
| `adversarial` | adversarial | Unanswerable questions |

### LongMemEval
| Type | Alias | Description |
|------|-------|-------------|
| `single-session-user` | ss-user | Single-session user facts |
| `single-session-assistant` | ss-asst | Single-session assistant facts |
| `single-session-preference` | ss-pref | Single-session preferences |
| `multi-session` | multi | Multi-session reasoning |
| `temporal-reasoning` | temporal | Temporal reasoning |
| `knowledge-update` | update | Knowledge update tracking |

### ConvoMem
| Type | Alias | Description |
|------|-------|-------------|
| `user_evidence` | user | User-stated facts |
| `assistant_facts_evidence` | asst | Assistant-stated facts |
| `preference_evidence` | pref | User preferences |
| `changing_evidence` | change | Information updates |
| `implicit_connection_evidence` | implicit | Implicit reasoning |
| `abstention_evidence` | abstain | Unanswerable questions |

### BEAM
| Type | Alias | Description |
|------|-------|-------------|
| `abstention` | abstain | Withhold answers when evidence is missing |
| `contradiction_resolution` | contradict | Detect and reconcile inconsistent statements |
| `event_ordering` | order | Reconstruct event or information order |
| `information_extraction` | extract | Recall entities and factual details |
| `instruction_following` | instruction | Follow sustained user instructions |
| `knowledge_update` | update | Retain updated facts over stale facts |
| `multi_session_reasoning` | multi | Reason across non-adjacent dialogue segments |
| `preference_following` | preference | Adapt to evolving user preferences |
| `summarization` | summary | Summarize dialogue content |
| `temporal_reasoning` | temporal | Reason about explicit and implicit time relations |
