# Agent messaging and board: verification summary

This summarizes the verification evidence gathered for PR #2181 against implementation commit `fd288111060baf636aa064d3d201f33b1120ddb5`. The full evidence package (solver queries and derivations, runtime runner and report, Dreaming probe output, focused test logs, CI snapshot) is kept out of the main tree on branch `hermes/pr2181-verification-evidence`, under `docs/proofs/agent-message-board/` and `scripts/verification/`.

It supports specific protocol and runtime claims. It does not certify the whole feature.

## Abstract transition checks

19 Z3-checked obligations over small hand-built transition models: claim insert-if-absent and owner-matched release, batch disjointness on release, quota and capacity accounting, identity resolution for enforced agent-scoped tokens, post sequence uniqueness, read cursors, and session-end delivery counting. 17 have a mutation control that produces a countermodel for a specific modeled defect.

Limits: the model-to-source mapping is manual. Source fingerprints detect drift; they do not link model and code. Several obligations are conditional on stated hypotheses (guarded transitions, exclusive claims, serialized delivery, client cursor guards) that were checked by reading source, not by the solver. Nothing here proves whole-program correctness, exactly-once host execution, liveness, or protection in non-enforced auth modes.

## Isolated daemon experiments

A runner against disposable daemons on loopback ports, with no inference, exercised direct-message long-poll delivery, claim, release and acknowledgement, quota and refund, board posts not waking anyone, snapshot reads, authorization, visibility, moderation, persistence across restart, and deliberately broken copies of selected paths. A successful daemon response is not proof that a real host executed an injected turn.

## Dreaming characterization

Board posts enter Dreaming as per-participant `board_post` artifacts. Findings that remain open:

- A fact in both a board post and rendered transcript text is offered as two evidence sources; source-identity idempotence does not dedupe the overlap.
- Copies that appear only in tool arguments or results are omitted from rendered transcript evidence.
- Exact scripted claim filing dedupes one identical claim, but the surviving claim's evidence resolver omitted the second citation (still stored in the second applied proposal).
- Deleting a thread removes its board artifacts, but an already-derived claim stays active.

## Live usefulness eval

Separate from the above, `evals/agent-coordination` runs two real Pi agents on a split coding task, with and without messaging. Results are in `evals/agent-coordination/ledger/coding-pilot.json`.
