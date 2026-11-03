# Agent messaging and board: verification evidence

Implementation under examination: `fd288111060baf636aa064d3d201f33b1120ddb5` on PR #2181.

## Outcome

This package supports specific protocol and runtime claims. It does not establish whole-feature correctness, and it exposes downstream counterexamples that prevent such a certification.

The most important findings are:

- Board content really enters Dreaming through per-participant `board_post` artifacts. It is not merely a dashboard view over session transcripts.
- When a board body's fact also occurs in rendered user/assistant transcript text, Dreaming's evidence search offers both sources. Source-identity idempotence does not dedupe this overlap.
- A copy occurring only in tool arguments/results is not equivalent: those blocks are omitted from the rendered transcript evidence. This experiment therefore does not show that every board post is automatically covered by transcript ingestion.
- Exact scripted claim filing dedupes one identical entity/aspect/key/value pair, but does not prove semantic deduplication of differently phrased model outputs. In that experiment the surviving claim's evidence resolver did not surface the second source citation. The citation remains stored in the second applied proposal; this is a resolver gap, not demonstrated data loss.
- Deleting a thread removes its board artifacts, but the already-derived claim exercised by the probe remains active. This does not satisfy a claim of complete source-lifecycle cleanup.

No production policy was changed to make these findings disappear. No merge is authorized by this evidence.

## Three different kinds of evidence

### 1. Checked mathematical abstraction

[FORMAL.md](FORMAL.md) defines the modeled state, transitions, source mapping, assumptions, and limitations. [formal/results.json](formal/results.json) records solver results, source fingerprints, and countermodels. The [SMT-LIB queries and solver derivations](formal/smt/) are retained for replay.

These are hand-built algebraic/protocol obligations. They are not automatically extracted from TypeScript, are not a compiler-checked refinement proof, and do not prove all production executions correct. Solver proof terms are not independently kernel-checked. Elementary algebra, abstract induction, model mutations, and actual program mutations must not be conflated.

### 2. Real isolated daemon experiments

[runtime/README.md](runtime/README.md) explains the reproducible runner and its isolation. [runtime/report.json](runtime/report.json) records its HTTP assertions, observations, negative controls, process lifecycle checks, and explicitly unverified surfaces.

The runner exercises direct-message long-poll delivery, claim/release/ack behavior, quota and refund, board non-wake behavior, snapshot reads, authorization, visibility, moderation, persistence through restart, and deliberately broken copies of selected implementation paths. A successful daemon response is not proof that a real host accepted and executed an injected turn.

The runner is `scripts/verification/agent-message-board-runtime.ts`. It uses disposable workspaces, loopback-only dynamic ports, and no inference. It must not contact the installed daemon or open its database.

### 3. Downstream production-code characterization

[dreaming/README.md](dreaming/README.md) traces the actual board-to-artifact-to-Dreaming path and explains each positive observation and counterexample. [dreaming/raw-observations.json](dreaming/raw-observations.json) retains structured production tool results with source/probe fingerprints. [dreaming/execution.txt](dreaming/execution.txt) retains the runner output with local path prefixes replaced by placeholders.

The manual probe is `scripts/verification/agent-message-board-dreaming.probe.ts`. It invokes real Dreaming tools with a scripted executor. It is not a real-model evaluation. Its assertions characterize the pinned behavior, including gaps; a passing characterization is not acceptance of those gaps as desired product behavior.

## Focused regression suite

[tests/focused.json](tests/focused.json) and [tests/focused.txt](tests/focused.txt) retain a separate run of 308 existing feature tests across 11 files: migration, wake/board routes, session discovery, protocol tools, adapters, and SDK. They passed with zero failures under disposable home/config/workspace roots and without inherited credential variables. Adapter/tool tests are not substitutes for a real host executing an injected turn. This was a selected suite, not the complete CI baseline.

## CI is separate evidence

[ci/feature-head-checks.json](ci/feature-head-checks.json) is a timestamped snapshot of GitHub checks for the implementation commit. At that observation the full baseline had a failing embedding-provider test. Do not interpret focused local tests, solver results, or a later test-only repair as proof that this recorded baseline was green.

Any new head's CI applies to that exact head. The historical snapshot remains historical even if a subsequent run passes. A queued or in-progress run is not a passing result.

## Reproduction and interpretation

Run the commands in each subdirectory's README and in FORMAL.md. The verifiers require the pinned production inputs; documentation, evidence, and test-only commits do not turn an old source fingerprint into proof of changed production code. Generated JSON is normalized with the repository formatter for review; formatting does not add observations. Synthetic identities and per-run IDs are not real session or user data.

This package deliberately keeps four questions separate:

1. Is a formula valid under its stated assumptions?
2. Does the implementation match the formula's transitions and preconditions?
3. Do the exercised runtime cases behave as expected, including failure and cleanup?
4. Does the resulting memory behavior satisfy the intended product and source-lifecycle guarantees?

The mathematical checks answer bounded parts of the first question. Source mapping and runtime experiments provide evidence for parts of the second and third. The downstream counterexamples show why the fourth cannot currently be answered with an unqualified yes.
