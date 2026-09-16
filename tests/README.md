# Tests

## Discovery and scopes

A bare root `bun test` uses Bun's normal default discovery; `bunfig.toml` does not define repository test roots. The repository's root `test` script is the deliberate workspace wrapper: `bun run test` builds, runs `scripts` and `tests` through `scripts/run-hermetic-tests.ts`, runs the package roots listed in `test:workspace`, and then runs the Codex plugin package tests.

Use an explicit path or directory when you need a focused scope, for example:

```bash
bun test platform/daemon/src/pipeline/worker.test.ts
bun test ./tests/integration/pipeline-llm.test.ts
bun test ./tests/integration
bun test integrations
bun test scripts
```

The workspace wrapper names maintained package roots explicitly, including `integrations/`; it also covers `scripts/` and the explicit `tests/` root through the hermetic runner. Run package, integration, and reference suites explicitly when you need them:

```bash
bun test integrations
bun test ./tests/integration
bun test ./references/<harness-or-fixture-suite>
```

The `tests/` and untracked `references/` directories are not included by the workspace package list; explicit paths are required for these integration, reproduction, and harness-reference suites. The integration suites may require Ollama, a real daemon, a generated database, or other external services. Their individual runbooks below document prerequisites and expected behavior. Keep the default hermetic/workspace run for routine changes, and select explicit suites when the changed boundary requires them.

## LLM Pipeline Tests

`tests/integration/pipeline-llm.test.ts`

Validates that local LLM prompts (targeting qwen3:4b via Ollama) produce
structurally valid and semantically reasonable output across every pipeline
stage: extraction, decision, summary, and contradiction detection.

### Requirements

- Ollama running locally on port 11434
- qwen3:4b model pulled (`ollama pull qwen3:4b`)

### Running

```bash
bun test ./tests/integration/pipeline-llm.test.ts
```

Note: these tests are not included in the default workspace test script. Run them with an explicit `./` path prefix.

## Issue Reproductions

Issue-specific integration reproductions live under `tests/integration/repros/`.
The #1059 sustained-ingestion reproduction can be evaluated with:

```bash
bun test ./tests/integration/repros/1059/repro-1059-eval.test.ts
bun run ./tests/integration/repros/1059/repro-1059-harness.ts
```

### Design

- **Non-deterministic**: Each LLM prompt runs 3 times with statistical
  assertions (at least 2/3 must produce valid output).
- **Graceful skip**: If Ollama is unavailable, the suite skips with a
  message instead of failing.
- **Performance tracking**: Response times are logged for each test.
- **Schema compliance tests**: Parsing and validation logic is also
  tested without LLM calls (pure unit tests).

### Key Insight: JSON Mode

The tests use Ollama's `format: "json"` and `think: false` options.
Without these, qwen3:4b generates massive chain-of-thought preambles
(100+ seconds per call). With them, responses drop to 0.5-9 seconds.

The production pipeline does NOT use `format: "json"` -- it strips
`<think>` blocks and uses balanced-brace extraction post-hoc. This
means a prompt regression that breaks JSON output could pass these
tests but fail in production. Future work: add a test mode that
exercises the production path (no JSON mode, with think block stripping).

### Fixtures

`tests/integration/fixtures/transcripts.ts` contains realistic sample
conversation transcripts at varying sizes (small, medium, large) plus
edge cases (unicode-heavy, minimal).

### Typical Performance (qwen3:4b, JSON mode, desktop hardware)

| Stage | Avg Response Time |
|-------|------------------|
| Extraction (small) | ~3s |
| Extraction (medium/large) | ~8s |
| Decision | ~0.6s |
| Summary | ~3-8s |
| Contradiction | ~0.6s |

## Phase D Stability Acceptance (#1543)

`tests/integration/acceptance/` boots the real daemon from source against a
deterministic production-shaped database (~106k memories, ~11k transcript
jobs, telemetry, source index — full scale) and judges daemon stability:

- an event-loop occupancy probe is preloaded INTO the daemon process
  (`bun --preload tests/integration/acceptance/loop-probe.ts`) and samples
  per-second max event-loop delay via `perf_hooks.monitorEventLoopDelay`;
- the embedding provider is intentionally dead (refused connections) while a
  synthetic source root keeps source sync walking — the #1671 trigger shape;
- concurrent pollers hit `/health/live` (250ms), `/api/status` (2s), and
  `/api/diagnostics` (5s) while a foreground write load flows through the
  normal remember path;
- acceptance criteria (#1543): zero event-loop blocks >= 2000ms,
  `/health/live` p95 < 500ms, `/api/status` p95 < 1000ms.

The harness is a judge, not a fixer: if it fails on current main, that is the
harness working — the numbers are the baseline.

### Running

```bash
bun tests/integration/acceptance/run.ts --scale full   # full deployment profile
bun tests/integration/acceptance/run.ts --scale smoke  # smaller db, 90s run
bun tests/integration/acceptance/run.ts --scale smoke --keep  # keep workspace for inspection
```

Output: a human summary on stderr plus a machine-readable JSON artifact
(`phase-d-acceptance-<scale>.json`) with per-metric percentiles, failures,
probe samples, and the daemon log path. CI runs the smoke variant on
PRs/main (`.github/workflows/phase-d-acceptance.yml`) and the full variant
nightly.

## Boot Wedge Safety Gate

`tests/integration/boot-wedge/run.ts` is the short L1 safety check for the
source-run daemon boundary. It uses a fresh isolated workspace, waits for the
real `/health/live` endpoint, then samples liveness and Linux `/proc` CPU usage
for 30 seconds. The gate fails if startup takes more than 60 seconds, any
liveness sample fails or exceeds 2 seconds, CPU sampling produces fewer than
five samples, or the daemon process tree reaches 95% of one CPU during the idle
observation.

```bash
bun tests/integration/boot-wedge/run.ts
bun tests/integration/boot-wedge/run.ts --out /path/to/artifacts
```

The CI workflow (`.github/workflows/boot-wedge.yml`) runs this source boundary
on daemon/core changes and uploads `boot-wedge.json` even when the gate fails.
