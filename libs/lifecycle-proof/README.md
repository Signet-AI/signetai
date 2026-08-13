# `@signet/lifecycle-proof`

This package is a cross-harness proof contract for lifecycle owners. It is not
a runtime, queue, timer, provider, or session manager. Each harness and the
daemon record observations from their existing owners, then call
`assertLifecycleInvariants()` in focused tests or diagnostics.

The contract covers:

- startup before lifecycle work;
- serialized completed turns per session;
- interrupted turns never becoming durable semantic input;
- session end before session switch;
- branch, resume, compression, and rewind invalidating stale context;
- queued work resolving after restart as completed, replayable, or abandoned;
- bounded shutdown with exact pending/completed/abandoned accounting;
- prompt handling remaining independent of a slow provider; and
- source-session attribution for deferred work.

`LIFECYCLE_INVARIANTS` is the canonical list. Keep adapters observational and
reuse the existing lifecycle owners. Do not add a second queue or recovery
runtime to satisfy this contract.
