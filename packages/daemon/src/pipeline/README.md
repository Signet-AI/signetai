# Pipeline prompt testing

Live Ollama prompt checks for the two dependency prompts live here:

- `structural-dependency.test.ts`
- `dependency-synthesis.test.ts`

Model selection uses `SIGNET_OLLAMA_TEST_MODEL`.

Examples:

```bash
# Root script aliases
bun run test:prompt:structural
bun run test:prompt:synthesis

# Structural dependency prompt, default local baseline
SIGNET_OLLAMA_TEST_MODEL=qwen3:4b \
bun test packages/daemon/src/pipeline/structural-dependency.test.ts

# Structural dependency prompt, Nemotron
SIGNET_OLLAMA_TEST_MODEL=nemotron-3-nano:4b \
bun test packages/daemon/src/pipeline/structural-dependency.test.ts

# Cross-entity dependency synthesis prompt, default local baseline
SIGNET_OLLAMA_TEST_MODEL=qwen3:4b \
bun test packages/daemon/src/pipeline/dependency-synthesis.test.ts

# Cross-entity dependency synthesis prompt, Nemotron
SIGNET_OLLAMA_TEST_MODEL=nemotron-3-nano:4b \
bun test packages/daemon/src/pipeline/dependency-synthesis.test.ts
```

Notes:

- These are live model checks, not mocked unit tests.
- They require Ollama at `http://localhost:11434`.
- If the selected model is not pulled locally, the tests print a skip message.
