# Integration Tests

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

Note: these tests are NOT discovered by the default `bun test` command
because `bunfig.toml` scopes test discovery to `packages/`. Run them
with an explicit `./` path prefix.

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
