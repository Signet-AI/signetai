# Working in Signet

Signet is a local-first memory and context layer for AI agents.

This file is the only repository-wide policy written for coding agents. It is not a repository map, runbook, changelog, migration ledger, or substitute for the owning code and public contracts.

A rule belongs here only when all of the following are true:

- it applies across the repository;
- violating it can materially damage correctness, authority, security, data, compatibility, or the honesty of completion;
- it is costly or unsafe to rediscover from the owning source;
- it is expected to survive ordinary file, package, class, and transport changes;
- two reviewers can determine whether a change obeys it.

Otherwise, keep the truth in its owning code, schema, manifest, generated-file header, public documentation, test, or `CONTRIBUTING.md`.

## Authority and evidence

Determine intended behavior from, in order:

1. the explicit current task or accepted product decision;
2. the repository invariants and active architecture contracts in this file;
3. a documented public contract or explicitly designated authoritative source;
4. a deliberate compatibility commitment;
5. the owning implementation, tests, incidents, issues, plans, and comments as evidence of current behavior and prior intent.

An explicit task may replace a repository invariant or active architecture contract only through **Changing this contract** below.

Existing behavior does not become intended behavior merely because code and tests agree. A reproduction proves what the program does; it does not by itself prove what the program should do.

When authoritative sources disagree, keep the disagreement visible. Do not silently select one interpretation in code, rewrite a test around it, or present the resulting behavior as settled product intent.

## Changing this contract

This file constrains ordinary implementation work; it is not an excuse to preserve an architecture that the task explicitly replaces.

A change may amend a repository invariant or active architecture contract only when it does all of the following in the same coherent change:

- names the contract being replaced;
- defines the replacement authority and execution path;
- migrates affected callers and durable state where necessary;
- removes or closes the superseded path;
- updates this file;
- proves the replacement across its real runtime boundary.

Do not preserve the old contract in prose while bypassing it in code. Do not treat an incidental implementation change as an architectural amendment.

## Repository invariants

### Evidence remains attributable

Source artifacts, transcripts, and explicit user-authored state are evidence.

Signet may index, summarize, rank, relate, and interpret that evidence. Derived memories, claims, relationships, embeddings, and projections must not silently replace their sources, erase their origin, or become the only surviving copy of user-owned truth.

Any derived state that can influence recall, reasoning, or action must remain attributable, inspectable, correctable, and purgeable through its source lifecycle.

### Identity and scope remain explicit

Every read, write, derivation, deletion, import, export, token operation, and background job runs under a resolved identity and scope.

Identity and scope must survive every layer of the operation. Missing, ambiguous, expired, or unauthorized identity fails closed; it must not silently become `"default"` or broaden to another agent, session, source, or visibility scope.

Cross-agent reads, writes, links, mutations, and token use require explicit authorization.

### Every transition has one authority

Every durable state transition has one canonical authority and one canonical implementation path.

Multiple interfaces may request the transition. They may authenticate, validate, normalize, transport, observe, cache, or project it. They may not independently implement or reinterpret it.

Compatibility code may translate an old input into the canonical operation. It must not preserve a second reader, writer, executor, state owner, or semantic interpretation.

A change is not complete while the displaced path can still execute. Moving, wrapping, renaming, or redistributing code is not simplification unless it reduces authorities, executable paths, mutable owners, or required knowledge.

### Authoritative and derived state remain distinguishable

Indexes, caches, embeddings, graphs, summaries, rankings, materialized views, and generated projections are derived state.

Derived state must be rebuildable from authoritative state. When a change depends on rebuildability, prove it through the relevant rebuild, deletion, export, purge, or recovery path.

If a representation contains information that cannot be rebuilt, it is authoritative state and must have an explicit owner and lifecycle. Performance infrastructure must not become the source of truth by accident.

### Work is bounded and completion is honest

Every background or scale-dependent operation has an identifiable owner, an admission rule, a bounded unit of work, a termination condition or deadline, cancellation behavior, cleanup obligations, and an observable outcome.

Work whose cost grows with the workspace, source corpus, database, or graph must not monopolize the request-serving runtime.

Asynchrony is an execution property, not a function name. Returning a Promise around synchronous work does not move the work across an execution boundary.

Signet must not report success while required work remains detached, resources remain owned, durable state is indeterminate, or cleanup has not reached its declared boundary.

Partial, stale, blocked, degraded, cancelled, and failed states must be represented honestly. Retries are bounded. A fallback may be used only when it preserves the declared contract or makes the resulting degradation explicit; it must not silently change identity, authority, durability, or semantics merely to produce a successful-looking response.

## Active architecture contracts

These are deliberate architectural constraints, not descriptions of incidental file layout. Replacing one requires an explicit amendment under the rule above.

- The daemon owns Signet's core application behavior and durable transitions. The CLI, dashboard, desktop application, SDK packages, and harness integrations are clients or adapters; they do not implement independent versions of core transitions.
- Exactly one owner process has direct access to a workspace database. Request-serving processes do not open it, receive database handles, execute SQL against it, or import the synchronous database implementation.
- Database operations cross one bounded asynchronous owner protocol. If the owner becomes unavailable, pending work fails explicitly. No local, legacy, emergency, or compatibility fallback executes the operation elsewhere.
- Evidence is durably recorded before semantic interpretation derived from that evidence is committed.
- Dreaming is the sole automatic writer of semantic truth. Ingestion, retention, indexing, embeddings, projections, source synchronization, and maintenance may preserve, transport, or derive supporting state; they do not independently create or rewrite semantic claims.
- Configuration and workspace selection are normalized once at their owning boundary. Runtime consumers receive canonical values; they do not interpret legacy forms, reproduce environment precedence, or add fallback readers.
- Compatibility may translate supported legacy input into a canonical operation. Unsupported and retired inputs fail explicitly and must never reactivate retired executors.
- Authoritative and derived state remain distinguishable through rebuild, deletion, export, source purge, and failure recovery.

## Loading local context

Begin at the affected user-visible surface and follow the actual execution path to its state owner. Read the nearest nested `AGENTS.md` only after the task enters that subtree.

A nested `AGENTS.md` is a local index, not another policy layer. It may identify:

- entry points and actual owners;
- generated files and their source;
- focused commands;
- local external dependencies;
- non-obvious lifecycle or integration hazards.

It may not define repository-wide architecture, product behavior, compatibility policy, testing philosophy, or sources of truth. It may not restate this file.

Existing nested guidance may not yet follow this rule. Use concrete local facts, but ignore duplicated or conflicting repository-wide policy.

For local mechanical facts, executable source, manifests, schemas, and generated-file headers outrank stale prose. For intended product behavior, existing implementation remains evidence rather than automatic authority.

Do not recursively preload unrelated nested instructions. For repository structure, consult current manifests, imports, exports, and `repo.map.yaml` rather than a directory inventory copied into prose.

## Working method

### Before changing code

- Inspect the checkout and preserve unrelated work.
- Trace the affected operation through its real path:

  ```text
  entry point
  → identity and authorization
  → orchestration
  → state owner
  → durable transition
  → derived work
  → observable result
  → cancellation and cleanup
  ```

- Identify duplicate implementations, fallbacks, compatibility routes, and retired paths that can perform the same operation.
- Reproduce the reported behavior when a practical reproduction exists.
- Establish expected behavior from an authoritative basis before changing implementation or tests.
- When behavior depends on an external package, harness, protocol, or API, verify its current source, types, generated artifact, or official contract rather than relying on memory.

### While changing code

Make the smallest coherent change, not merely the smallest diff.

Delete code directly displaced by the change. Do not add another wrapper, service, adapter, cache, retry loop, or fallback to compensate for an unclear owner.

File size alone is not an architectural defect. An extraction is justified only when it reduces caller knowledge, gives mutable state a clearer owner, removes duplicated behavior, isolates a real independently testable boundary, reduces the files required to trace the operation, or allows an old path to be deleted.

Validate and bound untrusted input at the external boundary. Authentication, authorization, source access, mutation gates, publishing, and installation integrity fail closed.

Do not expose secrets in source, logs, tests, fixtures, generated files, screenshots, or reports.

### Before reporting completion

Proof must exercise the boundary at which the behavior matters and must be capable of failing against the known-broken implementation.

Use:

- tests for deterministic behavior and invariants;
- evaluations with fixed inputs and measurable criteria for probabilistic or subjective behavior;
- real runtime-surface proof for process ownership, lifecycle, cancellation, packaging, generated assets, database isolation, and cleanup.

Run the narrowest meaningful checks first, then broaden according to the affected surface and risk. Use commands declared by the owning package rather than commands copied into this file.

Report:

- the observable behavior changed;
- the canonical owner and path that now implement it;
- the displaced path removed, or the explicit reason it remains;
- the exact checks and runtime surfaces exercised;
- any proof that remains unavailable.

Do not create a separate report file merely to satisfy this list.

## Documentation and generated files

Update the owning public contract when user-visible behavior, APIs, schemas, configuration, or lifecycle changes.

Do not create a parallel explanation when an authoritative reference already exists. Do not hand-edit generated output; follow its source header or owning package script.

## Code conventions

- Match surrounding syntax and organization without inheriting unnecessary abstraction.
- TypeScript remains strict.
- Keep public APIs narrow.
- Prefer deletion and directness over speculative extensibility.
- Use **Signet** for the product and prose.
- Use `signet` for CLI, package, path, and configuration names.
- Write American English.
- Follow `CONTRIBUTING.md` for contribution and Git mechanics.
