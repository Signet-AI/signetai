# Benchmarking

Signet memory benchmarks run through `memorybench/`. The benchmark harness owns
the datasets, checkpointing, answer generation, judging, retrieval metrics, and
reports. Signet is only a MemoryBench provider.

## Default developer run

```bash
bun run bench
```

This command:

1. Builds the workspace with `bun run build`.
2. Creates a temporary isolated Signet workspace under `/tmp`.
3. Starts a Signet daemon bound to `127.0.0.1` on a free port.
4. Runs MemoryBench against LongMemEval using the `signet` provider.
5. Shuts the daemon down and removes the temporary workspace.

The default run uses a small LongMemEval sample, one question per question type,
so developers can run it while iterating. The command prints the exact
MemoryBench command and run id before executing.

MemoryBench reports scores by question type in `report.json`, so the default
run gives a clean per-type breakdown without extra commands. Benchmark reports
and run artifacts stay under ignored paths and should not be committed until the
team explicitly decides to publish a score.

## Larger runs

Run the full LongMemEval benchmark:

```bash
bun run bench -- --full
```

Run a fixed-size sample:

```bash
bun run bench -- --limit 20
bun run bench -- --sample 3
```

`--limit` and `--sample` select questions, not individual sessions. A small
LongMemEval question set can still ingest many sessions because each question
has its own haystack.

Run one LongMemEval question type:

```bash
bun run bench -- --type temporal-reasoning --limit 20
bun run bench -- --type knowledge-update --sample 5
```

Valid LongMemEval types include:

```text
single-session-user
single-session-assistant
single-session-preference
multi-session
temporal-reasoning
knowledge-update
```

Skip the workspace build when you already built locally:

```bash
bun run bench -- --no-build --limit 10
```

Keep the isolated workspace for inspection:

```bash
bun run bench -- --keep-workspace --limit 5
```

Preview the command without building, starting the daemon, or running the
benchmark:

```bash
bun run bench -- --dry-run
```

## Two-stage local model workflow

For local tuning, keep extraction cheap and reserve the stronger model for the
parts that affect reasoning quality:

1. Run ingest/indexing with a small fast model.
2. Continue the same checkpoint from search with the larger answer/judge model.

This avoids spending hours re-ingesting LongMemEval sessions through a 26B model
while still testing answer quality with the model we care about.

Example split run:

```bash
export RUN_ID="lme-rules-split-$(date -u +%Y%m%dT%H%M%SZ)"
export WORKSPACE=".bench/workspaces/longmemeval-structured"
```

Start a fast OpenAI-compatible extraction server, for example Gemma E4B via
vLLM, then ingest. On a single-GPU workstation this can use the same port as
the later answer server because the phases run sequentially:

```bash
OPENAI_API_KEY=dummy \
OPENAI_BASE_URL=http://127.0.0.1:8000/v1 \
MEMORYBENCH_EXTRACTION_MODEL=google/gemma-4-E4B-it \
MEMORYBENCH_EXTRACTION_MAX_TOKENS=1200 \
MEMORYBENCH_STRUCTURED_EXTRACTION_MAX_TOKENS=1800 \
SIGNET_BENCH_EMBEDDING_PROVIDER=ollama \
SIGNET_BENCH_EMBEDDING_MODEL=nomic-embed-text \
SIGNET_BENCH_RUN_ID="$RUN_ID" \
bun run bench:ingest -- --no-build --workspace "$WORKSPACE" --limit 6 --concurrency-ingest 1
```

For impatient local iteration, ingestion can use OpenRouter while answer/judge
still use a local model later. Store the key in Signet as
`OPENROUTER_API_KEY`, inject it into the command environment as
`OPENROUTER_API_KEY`, and pass `--ingest-openrouter`:

```bash
signet secret put OPENROUTER_API_KEY
```

```bash
SIGNET_BENCH_RUN_ID="$RUN_ID" \
MEMORYBENCH_SESSION_CONCURRENCY=4 \
bun run bench:ingest -- --ingest-openrouter --no-build --workspace "$WORKSPACE" --limit 6 --concurrency-ingest 2
```

`--ingest-openrouter` only affects `bench:ingest`. It maps the injected
`OPENROUTER_API_KEY` to `OPENAI_API_KEY` for the MemoryBench extraction client,
sets `OPENAI_BASE_URL=https://openrouter.ai/api/v1`, and defaults
`MEMORYBENCH_EXTRACTION_MODEL=inception/mercury-2`. It does not change local
answering or judging in a later `bench:evaluate` step. For local dev speed, use
modest question concurrency plus `MEMORYBENCH_SESSION_CONCURRENCY`; this only
changes how many sessions are ingested at once, not what data is written or how
answers are scored.

Then stop the extraction server, start the larger OpenAI-compatible answer/judge
server, for example Gemma 26B Q5 via llama.cpp, and continue the same run:

```bash
OPENAI_API_KEY=dummy \
OPENAI_BASE_URL=http://127.0.0.1:8000/v1 \
SIGNET_BENCH_ANSWERING_MODEL=google_gemma-4-26B-A4B-it-Q5_K_M.gguf \
SIGNET_BENCH_JUDGE=google_gemma-4-26B-A4B-it-Q5_K_M.gguf \
SIGNET_BENCH_EMBEDDING_PROVIDER=ollama \
SIGNET_BENCH_EMBEDDING_MODEL=nomic-embed-text \
SIGNET_BENCH_RUN_ID="$RUN_ID" \
bun run bench:evaluate -- --no-build --workspace "$WORKSPACE"
```

The `--resume` flag is a wrapper guardrail. It prevents `bun run bench` from
adding `--force` when continuing a checkpoint. Use it whenever the run already
has ingested data that should be preserved.

## Benchmark profiles

The wrapper supports two explicit Signet profiles:

```bash
bun run bench -- --profile rules
bun run bench -- --profile supermemory-parity
```

`rules` is the default. It uses the `signet` provider and follows the common
MemoryBench phase contract:

- ingest extracted structured memories through `/api/memory/remember`
- search with the orchestrator's requested limit, currently `10`
- answer from bounded recall results only
- do not append raw transcripts or hidden source context to the answer prompt

`supermemory-parity` uses the `signet-supermemory-parity` provider. It is not a
publishable fair-score profile. It intentionally mirrors the upstream
Supermemory adapter shape, which does **not** match the common provider shape
required for fair testing. Use it only to diagnose whether a low Signet score is
caused by Signet itself or by comparing against Supermemory's non-conforming,
more permissive adapter:

- ingest each session as the same date header plus stringified raw JSON
  conversation that the Supermemory adapter stores
- search with a limit of `30`, matching the Supermemory adapter's current
  hardcoded limit
- answer from raw session-shaped memory content instead of extracted memory
  summaries

Keep results from these profiles separate. A `supermemory-parity` result answers
"how does Signet perform when given Supermemory's adapter advantage?" A `rules`
result answers "how does Signet perform under the harness contract we intend to
publish?"

## Supermemory adapter contract violation

For a fair MemoryBench run, a provider should treat the orchestrator's
`SearchOptions` as the required test contract. The common search phase calls
every provider with:

```text
limit: 10
threshold: 0.3
```

The imported Supermemory provider currently violates that provider contract. It
does not honor the required `limit: 10` shape passed by the harness. Instead, it
hardcodes `limit: 30`, asks Supermemory to return both summaries and chunks, and
uses a provider-specific answer prompt that tells the model to prioritize those
chunks as raw source material.

This is not just a harmless implementation detail. It means the upstream
Supermemory provider is not being tested under the same required adapter shape
as strict providers. It can provide more retrieved items and richer raw session
context to the answer model than a conforming provider receives from the common
harness contract. This can especially affect incidental-fact questions, where a
raw chunk may still contain a fact that an extraction-based provider dropped.

For fair reporting, use the `rules` profile and document the exact provider
contract used. Treat `supermemory-parity` as a diagnostic profile only. It
exists to measure the advantage created by Supermemory's current non-conforming
adapter shape, not to produce a publishable score.

## Isolation rules

Benchmarks must never read from or write to `~/.agents/memory/memories.db`.
The wrapper sets `SIGNET_PATH` and `HOME` to temporary benchmark directories
before starting the daemon. This prevents production memory, Claude project
memory, and user identity files from being mounted into benchmark runs.

The MemoryBench Signet provider scopes every write and search with:

```text
agentId: memorybench
project: memorybench
scope: <question-id>-<data-source-run-id>
sourceType: memorybench-session
```

That scope is per question, matching MemoryBench's provider isolation model.

## Persistent tuning workspaces

Clean benchmark runs use a fresh temporary Signet database. For development
tuning, you can preserve and reuse a benchmark workspace explicitly:

```bash
SIGNET_BENCH_EMBEDDING_PROVIDER=ollama bun run bench -- --workspace .bench/workspaces/longmemeval-structured --sample 1
```

A persistent workspace keeps the Signet database under `.bench/`, which is
ignored by Git. Use this only for tuning and clearly label any results as
warmed or reused. Public/comparable benchmark numbers should still use a fresh
isolated workspace.

## Cached ingestion for local iteration

It is acceptable to do one expensive bulk ingestion into a temporary benchmark
workspace, then reuse that workspace while tuning retrieval, ranking, context
packing, answering, or judging. Treat this as a development fixture, not a
publishable benchmark score.

The safe pattern is:

```bash
export RUN_ID="lme-dev-cache-$(date -u +%Y%m%dT%H%M%SZ)"
export WORKSPACE=".bench/workspaces/lme-dev-cache"

# One-time extraction + remember + indexing pass.
SIGNET_BENCH_RUN_ID="$RUN_ID" \
MEMORYBENCH_SESSION_CONCURRENCY=4 \
bun run bench:ingest -- --no-build --workspace "$WORKSPACE" --limit 60 --concurrency-ingest 2

# Repeatable search/answer/judge passes against the same isolated DB.
SIGNET_BENCH_RUN_ID="$RUN_ID" \
bun run bench:evaluate -- --no-build --workspace "$WORKSPACE"
```

Invalidate the cached workspace and ingest again whenever the thing being tuned
changes what gets written to Signet:

- extraction prompt or extraction model
- structured entity/aspect/hint schema
- `/api/memory/remember` request shape
- daemon graph persistence
- embedding provider, model, dimensions, or indexing behavior
- dataset selection or question sampling

Do not invalidate it for changes that only affect recall behavior after ingest,
such as search thresholds, traversal, reranking, context packing, answer model,
or judge model. That is the whole point of the cache: isolate ingest cost from
the parts we are actively tuning.

When reporting results from a cached workspace, say so plainly. The phrase we
use internally is "warmed dev workspace." A production/comparable score must use
a fresh isolated workspace and the intended production model configuration.

## Progress log

### 2026-04-18: structured evidence recall pass

This is a development progress log, not a publishable benchmark claim. The runs
below used small six-question LongMemEval samples while tuning the Signet
provider and daemon recall behavior.

The important change was adding structured evidence shaping to daemon recall.
Instead of collapsing every signal into one early score, recall now keeps
lexical, semantic, prospective hint, and traversal evidence separate before
reranking and dampening. Traversal-only candidates are capped below directly
anchored evidence, and hint matches can rescue class-to-instance questions such
as "music streaming service" matching a memory that says "Spotify."

| Run                                   | Setup                                                                                                    |   Accuracy | Hit@K |   MRR |  NDCG | Mean search |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------: | ----: | ----: | ----: | ----------: |
| `lme-openrouter-six-20260418T194618Z` | OpenRouter ingestion, pre-SEC recall                                                                     | 5/6, 83.3% |  100% | 0.625 | 0.734 |      761 ms |
| `lme-sec-six-20260419T0339Z`          | OpenRouter ingestion, SEC recall, warmed dev workspace                                                   |  6/6, 100% |  100% | 0.917 | 0.930 |      848 ms |
| `lme-dev-six-20260419T0818Z`          | Mercury-2 ingestion via OpenRouter, structured remember graph, Gemma 4 26B Q5 answer/judge via llama.cpp |  6/6, 100% |  100% | 0.889 | 0.873 |     1427 ms |
| `lme-secpath-six-20260419T090700Z`    | Same warmed workspace, structured path evidence added as a SEC recall channel                           |  6/6, 100% |  100% | 0.833 | 0.857 |     1042 ms |

The direct comparison is encouraging because the hit rate was already high, but
the ranking was weak. SEC improved the order of the evidence, not just whether
the answer appeared somewhere in the pile. That matters more than the one extra
correct answer: a higher MRR means the right memory is closer to the top, which
reduces how much context the answer model has to search through.

The `lme-dev-six-20260419T0818Z` run is the first small pass after separating
graph reads from background extraction graph writes and routing benchmark graph
structure through structured remember. Its graph hygiene report was clean:
0 suspicious entities, 0 duplicate canonical groups, and 0 active attributes
missing `group_key`, `claim_key`, or source memory. It did surface 8 safe
known-entity mention candidates, which is normal repair/normalization work, not
background graph authorship.

The structured graph run preserved 100% accuracy and 100% Hit@K, and it
massively improved ranking over the earlier currentness-only run (`MRR 0.889`
vs `0.458`, `NDCG 0.873` vs `0.482`). It was slightly behind the SEC-only
six-question run on aggregate ranking (`MRR 0.889` vs `0.917`, `NDCG 0.873` vs
`0.930`) because the single-session-preference question ranked the right
evidence third (`MRR 0.33`) even though the answer was judged correct. That was
the retrieval wrinkle targeted by the follow-up patch below.

The follow-up patch added structured path evidence as a SEC recall channel.
Recall now scores candidate memories against active structured graph rows using
aspect, group key, claim key, attribute kind, and attribute content, while still
requiring concrete query overlap before preference/advice boosts apply. This
fixed the first regression target: in `lme-secpath-six-20260419T090700Z`, the
single-session-preference question ranked the virtual coffee-break memory first
instead of third (`MRR 1.00`, `NDCG 1.00`).

The aggregate MRR moved from `0.889` to `0.833` in that rerun because the local
Gemma relevance pass marked the first relevant hit later for the multi-session
and single-session-user questions, even though the benchmark answer/judge score
remained 6/6. The retrieval wrinkle we targeted is fixed, but the next larger
run should watch whether this is judge noise or a real ranking tradeoff outside
the preference/advice path. The important durable TODO is that every recall
surface should eventually use the same structured-path SEC evidence, not just
the MemoryBench-facing daemon recall path.

The latency tradeoff is improving but still visible. Mean search increased from
761 ms in the pre-SEC run to 848 ms with SEC, then 1427 ms in the first
structured graph run. After the structured-path patch, the same warmed workspace
searched in 1042 ms mean with `SIGNET_BENCH_EMBEDDING_PROVIDER=ollama` set
explicitly, so the path is moving the right direction without dropping accuracy.

The same tuning pass also raised ingest concurrency for local development. With
OpenRouter Mercury extraction, question-level ingest concurrency `3` plus
per-question session concurrency `6` ingested 283 LongMemEval sessions across
six questions in about 7 minutes wall time. The extraction/remember side averaged
about 65 seconds per question. The remaining long pole was indexing wait on a
couple of questions, not extraction.

Do not publish or commit these score artifacts as official benchmark numbers.
They are useful as a progress marker and regression target while the harness is
still being integrated.

## What is being measured

The default `signet` provider uses the public Signet daemon HTTP API:

- ingest: `POST /api/memory/remember`
- search: `POST /api/memory/recall` with `expand: false`
- health: `GET /health`

During ingest, the provider performs MemoryBench-side structured extraction
from each session, then calls the full remember endpoint with:

- extracted memory content
- structured entities
- structured aspects and attributes
- hint questions
- source metadata and per-question scope
- the lossless source transcript

The isolated daemon does not run background extraction or synthesis workers for
benchmark ingestion. Those stages stay disabled so the benchmark is not racing
async background work or depending on local daemon timing. Graph and traversal
are enabled only so recall can use the structured data that was explicitly sent
to `/api/memory/remember`; `graph.extractionWritesEnabled` stays `false` so the
async extractor cannot create benchmark graph structure. Prospective hint recall
stays enabled because those hints are part of the structured remember payload,
not a background extraction shortcut. Recall does not expand raw source
transcripts into the answering prompt by default.

The isolated daemon also disables structural backfill/classification. Benchmark
graph state must come from the explicit structured remember payload, not from
daemon repair jobs that infer entities after the fact.

## Structured remembering contract

Structured remembering is not "proper noun extraction." Proper nouns are an
easy case, but the graph contract is broader and simpler:

- entity: a durable referent that can be expanded
- aspect: a stable facet of that entity
- group key: a navigable subgroup inside an aspect
- claim key: the specific updateable claim slot within a group
- attribute: a sourced claim value attached to that claim slot

For benchmark memories, generic personal facts should not be dropped just
because they are not named products or places. They should be attached to a
scoped subject entity. For example:

```text
Entity: MemoryBench User <question-scope>
Aspect: music preferences
Attribute: has been listening to Arctic Monkeys and The Neighbourhood on Spotify lately

Aspect: commute routine
Attribute: commute to work takes about 30 minutes

Aspect: morning routine
Attribute: getting ready takes about one hour

Aspect: dining history
Group key: restaurants
Claim key: korean_restaurants_tried_count
Attribute: tried three Korean restaurants recently on 2023-08-11
Attribute: tried four Korean restaurants so far on 2023-09-30
```

The remember endpoint accepts structured data directly. If an aspect references
an entity that was not present in the relation list, the daemon creates that
entity and attaches the aspect/attributes in the same transaction. This lets the
client be explicit about what is being saved and why, without relying on the
background pipeline to invent graph structure.

Temporal and update-sensitive attributes should preserve words like
`currently`, `recently`, `previously`, counts, dates, and before/after
relationships. The storage schema has active/superseded status fields, so
structured benchmark ingestion sends each session source timestamp into the
remember endpoint. Supersession requires the same scoped entity, the same
aspect, the same group key, and the same claim key. Attributes without a claim
key are saved as ordinary evidence and do not automatically supersede sibling
attributes. When a newer structured attribute conflicts with an older attribute
on the same grouped claim key, the daemon marks the older attribute as
superseded and records the replacement attribute id. Recall then dampens
memories whose structured facts are only stale and annotates returned context
with a `[Signet currentness]` note so the answer model can prefer the current
replacement instead of guessing from two conflicting memories.

MemoryBench still performs the answer and judge phases itself. This keeps the
benchmark comparable with the other providers and avoids benchmark-specific
changes to MemoryBench scoring logic.

## Environment knobs

```text
SIGNET_BENCH_FULL=1                 Run the full benchmark by default.
SIGNET_BENCH_SKIP_BUILD=1           Skip `bun run build`.
SIGNET_BENCH_KEEP_WORKSPACE=1       Keep the isolated workspace after the run.
SIGNET_BENCH_PROFILE=<profile>      rules or supermemory-parity, default rules.
SIGNET_BENCH_RUN_ID=<id>            Override the MemoryBench run id.
SIGNET_BENCH_JUDGE=<model>          Default judge model, default gpt-4o.
SIGNET_BENCH_ANSWERING_MODEL=<m>    Default answering model, default gpt-4o.
SIGNET_BENCH_SAMPLE_PER_TYPE=<n>    Default dev sample size, default 1.
SIGNET_BENCH_EMBEDDING_PROVIDER=<p> Generated daemon embedding provider, default native.
SIGNET_BENCH_EMBEDDING_MODEL=<m>    Generated daemon embedding model.
SIGNET_BENCH_EMBEDDING_DIMENSIONS=<n> Generated daemon embedding dimensions.
SIGNET_BENCH_AGENT_ID=<id>          Signet agent scope, default memorybench.
SIGNET_BENCH_PROJECT=<name>         Signet project scope, default memorybench.
SIGNET_BENCH_REQUEST_TIMEOUT_MS=<n> Daemon request timeout, default 60000.
SIGNET_BENCH_SESSION_CONCURRENCY=<n> Per-question session ingest concurrency, default 1, max 16.
SIGNET_BENCH_INGEST_OPENROUTER=1    Use OpenRouter defaults for bench:ingest.
SIGNET_BENCH_OPENROUTER_MODEL=<m>   OpenRouter extraction model, default inception/mercury-2.
SIGNET_BENCH_OPENROUTER_BASE_URL=<u> OpenRouter-compatible base URL override.
MEMORYBENCH_EXTRACTION_MODEL=<m>    Structured extraction model, default gpt-4o.
MEMORYBENCH_EXTRACTION_MAX_TOKENS=<n> Markdown extraction cap, default 1200.
MEMORYBENCH_STRUCTURED_EXTRACTION_MAX_TOKENS=<n> Structured JSON extraction cap, default 1800.
MEMORYBENCH_SESSION_CONCURRENCY=<n> Per-question session ingest concurrency, default 1, max 16.
OPENROUTER_API_KEY                  Preferred injected env var for OpenRouter ingestion.
OPENAI_BASE_URL                     OpenAI-compatible API base URL.
```

## Reports

MemoryBench writes checkpoints and reports under `memorybench/data/runs/`.
That directory is ignored by Git. Reports should be attached to PRs or release
notes only when benchmark numbers are being used to justify a memory-system
change.
