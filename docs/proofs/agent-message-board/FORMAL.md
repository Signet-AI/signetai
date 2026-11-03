# Abstract transition checks and their limits

Implementation examined: `fd288111060baf636aa064d3d201f33b1120ddb5`.

This package contains 19 Z3-checked obligations about small abstract transition models. It is **not** a whole-program proof, **not** an automatic code-to-model refinement, and **not** a certification of the feature. The model-to-source mapping is manual inspection. Source fingerprints (SHA-256 of 14 named files, compared byte-for-byte with the pinned commit) detect drift of those files; they are not a link between model and code. A guard in the runner fails if any mapped implementation path is not fingerprinted.

Z3 derivations are exported as `.derivation.sexpr` but are not independently kernel-checked. Reproducing with the pinned solver is reproducibility, not an independent check.

## Obligations by kind

| Kind | Count | Meaning |
|---|---|---|
| base | 1 | The empty initial state satisfies the claim, quota, capacity, post and batch-disjointness invariants, the same definitions used in the steps. |
| inductive-step | 14 | Invariant (or stated property) holds before the transition, hence after. Includes one conditional on a refinement hypothesis. |
| elementary-lemma | 3 | Local arithmetic or array lemmas: elapsed-clock expiry, read-cursor `max`, same-identity upsert. They add little beyond documenting intent. |
| algebraic | 1 | Identity resolution order. |

For each obligation the runner records (a) satisfiable premises, (b) premises plus negated property unsatisfiable, and for 17 of the 19 (c) a mutation control. A control re-builds the same transition with a specific defect and asks the **same** property; the countermodel values are in `formal/results.json` (`control_countermodel`). Controls show the property distinguishes the modelled defect. They do not show that the TypeScript was mutated or that tests catch the defect. Two obligations have no control: the base case and post deletion (a frame lemma with no defective variant modelled). `unknown` or timeout fails.

Controls by obligation: omitted identity falls back to the daemon default; guard omits session-owner check; claim written without absence check; release ignores owner; quota test off by one; capacity ignores pending reservations; claim inserts an already-live ID (H-exclusive violated); release removes an ID from only one batch; release drops a whole batch on partial return; retention measured on a wall clock stepped backwards; session-end boundary not advanced; new post gets the current head sequence (the control checks the uniqueness clause at a witness pair, because the quantified form returned `unknown`); cursor set to live head rather than the returned post; cursor overwritten rather than `max`; client marks read on offset pages; notice cursor set to live head; upsert uses a changed identity.

## Scope of each claim

### Claims and release
Invariant per message: `owner = none iff count = 0`, `0 <= count <= 1`. Insert-if-absent and owner-matched release preserve it; a non-owner release changes nothing. This is the claim-row model keyed by the table's primary key, not a proof about SQLite.

### Batches and refunds
The source removes released IDs from **all** live batches. The model has three transitions over membership `mem(batch, id)`: claim, release (remove returned IDs everywhere), and whole-batch expiry. Pairwise disjointness of live batches is preserved **conditional on H-exclusive**: a newly claimed ID occurs in no live batch. Relating that condition to absence of a claim row requires a separate SQL/history lifecycle argument; the primary key alone does not establish it. The control that violates H-exclusive shows the hypothesis is necessary; it is not a mutated implementation. Expiry is modelled only as deleting a charge. Whether expiry also resets claim rows is not modelled, so nothing here states that an expired message can or cannot be re-claimed. Separate obligations show a returned ID is absent from every batch and that an unreleased member keeps its batch charged.

### Quota and capacity
Quota safety (`used <= limit`) is a single transition: charge only after a completed claim and only when `used < limit`. It relies on serialized logical delivery, one live waiter per (agent, session key), and no interleaved charge for the same key (H-serial). There is no general concurrency proof. Capacity is a separate obligation: stored histories plus pending reservations stay within capacity; pending reservation is a distinct state component. Here `pending` counts distinct newly reserved history keys, not the implementation's per-history `pendingClaims` request counter. The source map already counts reserved keys; a concrete refinement must map the sum to map cardinality, not add the raw request count to it.

### Identity
Protection applies only to **enforced, non-admin, agent-scoped tokens**. In `local` mode, hybrid without claims, admin tokens, and project-only tokens, `shouldEnforceScope` or `checkScope` does not constrain the agent and this package makes no protection claim for them. The requested identity folds the request field and the `agent:<id>:...` session-key inference (`requestedAgentId`) into one value; the resolution obligation covers the case where both are absent. The guarded-transition obligation is conditional on **H-guard**: acceptance implies `effective = token agent` and, for an active session, `owner = effective`. It does not prove the source satisfies H-guard; that requires reading `resolveScopedAgent`, `checkScope` and `validateSessionAgentBinding`. `validateSessionAgentBinding` with `requireExisting: false` accepts a session with no presence row, which the `active` flag models.

### Posts, cursors, session end
The post invariant is `head >= 0`, every live sequence is `0` (absent) or in `1..head`, and live sequences are unique; append (`head + 1`) and deletion with the prior upper bound preserve it. The deletion check does not model a reduction of the actual SQL `MAX` after deleting a maximal post, nor prove composition through that reduction. The implementation can reuse a sequence after deleting a whole thread; this check does not certify that lifecycle. A first-page read marking the returned ID leaves a later post unread; offset pages leave the cursor unchanged given H-client (all three clients apply the guard); raw HTTP mark-to-head is a separate operation. A notice records the scanned sequence. Session end counts a delivery once because the boundary advances to the global sequence.

### Evidence
`evidence.same-identity-upsert-idempotent` is a lemma about existence under an unchanged identity; real rows also update hash and metadata. `formal/smt/evidence.cross-source-illustration.smt2` is an **illustration**: a constructed witness that two source identities can carry equal payloads. It is not evidence about the running system. The real-data evidence is the Dreaming probe in `docs/proofs/agent-message-board/dreaming/`.

## Remaining refinement assumptions

- H-guard, H-exclusive, H-serial, H-client as above (source-reading, not solver-derived).
- `performance.now` is monotonic in-process.
- SQLite atomicity and uniqueness; JS/SQLite integer representation is exact (SMT integers are unbounded).
- Expiry/eviction effects on claim rows are not modelled.
- Z3 and its bindings are correct.

## Not proved

Whole-program correctness; exactly-once host execution; liveness or fairness; semantic deduplication of board events repeated in transcripts; retraction of derived claims after thread deletion; protection in non-enforced auth modes. This package must not be cited as certifying the whole feature.

## Reproduce

    uv venv .verification-env
    uv pip install --python .verification-env/bin/python --require-hashes -r scripts/verification/agent-message-board-requirements.txt
    .verification-env/bin/python scripts/verification/agent-message-board-proof.py --implementation-sha fd288111060baf636aa064d3d201f33b1120ddb5 --output docs/proofs/agent-message-board/formal
    .verification-env/bin/python scripts/verification/agent-message-board-proof-replay.py

The replay command checks all exported property queries in fresh solver instances and verifies that changing a disposable copy of a named production file is rejected by the fingerprint guard. It first checks the model runner hash and source manifest against the recorded results. This remains a same-solver replay, not an independent proof kernel.

The runner deletes obsolete `*.smt2` and `*.sexpr` files in `formal/smt` before regenerating them, and exits nonzero on an unsatisfiable premise, a non-`unsat` proof, a control that is not `sat` (including `unknown`), source drift, or an unfingerprinted mapped path.
