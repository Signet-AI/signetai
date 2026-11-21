# Dreaming writes

## Batches are ordered, not atomic

The daemon validates every input, evidence citation, and resolvable target before it writes anything. It then applies operations in input order through bounded, yielding write transactions, each operation under its own savepoint. An operation that fails is reported without blocking later operations.

The request as a whole is not one transaction. If writer admission fails after earlier chunks committed, the response returns the committed items with `retryable` and `retryFrom`.

Trap: callers resume from `retryFrom` with only the uncommitted suffix. Replaying the full request duplicates semantic writes.

Why: one all-or-nothing transaction would hold the writer for the whole batch. Bounding each hold by operation count and elapsed time lets unrelated daemon work run between chunks.

Owner: `platform/daemon/src/dreaming/operations/operations.ts`, `surfaces/cli/src/commands/dream.ts`.

## The daemon owns the head fence

`memory_head_commit` is the only Dreaming tool that publishes the memory head. A content pass snapshots its agent's head revision when it starts, and publication requires the head to still be at that revision. Callers never submit a base revision or hash, and reading a newer head cannot make an older pass eligible to publish.

Why: a caller-supplied fence can be refreshed past the work it is meant to protect.

Owner: `platform/daemon/src/dreaming/head/owner.ts`.
