# Theory Tests

This directory contains **theory-based behavioral tests** -- tests that
validate the design contracts from specs, not the implementation details.

## Philosophy

These tests encode "what must be true" according to the spec. They are
the rewrite contract: a correct reimplementation in Rust, Go, or any
other language must satisfy the same behavioral assertions.

Rules:

- Test the contract, not the implementation
- No mocking of internal functions -- mock only at boundaries
- Deterministic: no randomness, no LLM calls, no network I/O
- Each test cites the spec section it validates
- Tests should survive a language rewrite unchanged in logic

## Running

```bash
# Run all theory tests
bun test ./tests/theory/

# Run a specific test file
bun test ./tests/theory/predictor-theory.test.ts
```

Note: the `bunfig.toml` root is scoped to `packages/`, so you must
use the `./` path prefix when running tests from the `tests/` directory.

## Test Suites

### predictor-theory.test.ts

Validates the predictive memory scorer design from
`docs/specs/approved/predictive-memory-scorer.md`.

Sections covered:

- **RRF Fusion** -- Reciprocal Rank Fusion formula, alpha extremes,
  monotonicity, tie preservation, fallback ranks
- **Cold Start** -- alpha locked at 1.0 until exit, one-way door
- **Alpha Ramp** -- early active phase floors (0.8, 0.6, 0) by session count
- **Topic Diversity** -- cosine threshold, exponential decay, floor,
  unaffected dissimilar candidates
- **Exploration Sampling** -- rank disagreement selection, lowest-slot
  replacement, disabled during cold start
- **NDCG Comparison** -- log2-discounted gains, perfect vs degraded
  rankings, zero relevance, boundedness
- **EMA Success Rate** -- formula correctness, convergence, boundedness
- **Confidence Gating** -- 0.6 threshold contract
- **Alpha Computation** -- comprehensive bounds checking
- **Fail-Open Design** -- baseline-only fallback, graceful empty inputs
- **Mathematical Invariants** -- positivity, symmetry, non-negativity
