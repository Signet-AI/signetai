# Board to Dreaming: reproducible observations and counterexamples

Implementation: `fd288111060baf636aa064d3d201f33b1120ddb5`.

This experiment does not certify downstream correctness. It reproduces both working mechanisms and gaps in the implementation. The seven passing characterization probes mean that these observations were reproduced, including the undesirable ones. They do not mean seven product requirements were satisfied.

The probe is deliberately outside automatic regression-test discovery: `scripts/verification/agent-message-board-dreaming.probe.ts`. Observed bugs must not become a permanent desired-behavior contract. It refuses to run if its named production inputs differ from the pin. `raw-observations.json` records their hashes, the probe hash, and the actual tool results. `execution.txt` records the command, exit code, and test runner output; local path prefixes are replaced by placeholders.

## Reproduce

From the repository root, with workspace dependencies and core build available:

    BOARD_PROOF_OUT=docs/proofs/agent-message-board/dreaming/raw-observations.json bun test ./scripts/verification/agent-message-board-dreaming.probe.ts

Only synthetic strings and disposable databases are used. The Dreaming executor is a scripted test double that calls the real `search_evidence`, `apply_ontology_ops`, and `review_evidence` tools. It does not run a model or show semantic extraction quality. Entity/aspect setup is a fixture, not evidence that an LLM discovered those entities.

The probe uses the asynchronous owner helpers for artifact queries and existing production accessor APIs for the Dreaming pass and episodic readers. Some of those APIs are synchronous at this pin. This is an isolated database characterization, not proof of the separate-process database architecture or a real daemon's background scheduler.

## Actual data path

Line references below refer to the pinned commit, not the evidence commit.

1. `board.ts:1060`, `projectBoardPost`, renders a post and calls `indexExternalMemoryArtifact` for participant agents. Participants are the thread author plus authors of posts with `created_at <= post.createdAt` (`:1066`). This is the source selection rule; the probe checks author/reply rows but does not exhaustively test later participants or same-timestamp participation.
2. `memory-lineage.ts:721` stores a `board_post` artifact with harness `signet-board`, `source_node_id='native-memory-bridge'`, a null configured `source_id`, and a hash of the rendered artifact. Rendering includes thread/post IDs, author, and timestamp (`board.ts:1041`).
3. The artifact key is `(agent_id, source_path)` (`memory-lineage.ts:558`), where the path is `signet-board://thread/<thread>/post/<post>`. Re-projecting that identity upserts. Stable row count and content hash are not byte-for-byte metadata idempotence: `updated_at` is written anew.
4. The Dreaming delivery queue's `selectEpisodicSourceRefs` (`episodic-sources.ts:821`) dedupes equal hashes within artifacts for the same agent and configured source (`:947`). Transcripts enter through a separate branch.
5. `ARTIFACT_IS_DREAMING_INPUT` (`episodic-sources.ts:113`) avoids a canonical transcript artifact duplicating its own transcript row. It does not exclude a board artifact whose body also occurs in a transcript.
6. `pipeline/dreaming-evidence.ts:324` keeps user/assistant text. Tool calls become `[tool call: name]` (`:137`); tool results and reasoning are omitted. Therefore a board body occurring only inside tool arguments/results is not enough to demonstrate duplicate visible evidence.
7. Claim dedupe (`ontology-proposals.ts:1165`) compares the resolved aspect, agent, kind, normalized value, group key, claim key, and active state. It does not establish that two independently phrased claims describe the same event.
8. `projectAfterWrite` (`board.ts:1146`) drains projections after a board write. Source inspection found no startup/timer caller for that drain. The probe does not exercise a scheduled retry or crash midway through projection.

## Results

| Mechanism | Observation | Probe |
|---|---|---|
| Repeated projection | Create and reply produced three artifact rows: the first post for its author, then the reply for both participants. Three further projections per post preserved those identities and hashes. | A |
| Direct-message storage | Creating a DM itself produced no matching artifact, transcript, or semantic memory. Promotion produced a board post and two participant artifacts. This does not say a host's later transcript cannot contain the DM. | B |
| Board/transcript overlap | When the same fact was placed in board text and completed transcript user/assistant text, the delivery queue offered both independent sources. One real Dreaming orchestration pass, using a scripted executor, retrieved both. | C, E |
| Tool-only negative control | A separate sentinel present only in tool input/results was absent from rendered candidates. | C |
| Artifact-only hash dedupe | Two artifacts with identical content produced one delivery-queue candidate. The older recent-source reader returned two. Two board threads with identical bodies still produced two candidates because the rendered headers differ. | D |
| Consumption tracking | Without `review_evidence`, both sources were delivered on passes 1, 2, and 3. After acknowledgement, pass 4 delivered neither. | G |
| Re-projection after consumption | After acknowledging both sources, explicitly projecting the unchanged board post three more times did not make the second pass deliver it again. | E |
| Exact claim dedupe | Filing the same scripted entity/aspect/claim key/value from each source resulted in one active claim and `deduped:true` for the second operation. Both source texts had still been retrieved. A real model might choose different keys or wording; that case is not proved safe. | E |
| Second citation | The surviving claim's evidence resolver contained the board artifact but did not surface the transcript citation from the deduped second operation. That citation is still stored in the second applied proposal, which points at the same attribute; it was not demonstrated lost. | E |
| Thread deletion | Deletion removed all board artifacts for the thread, but the derived claim stayed active with its board source path. | F |
| Explicit re-projection after soft deletion | Soft deletion set the artifact flag to 1; a direct `projectBoardPost` call reset it to 0. This demonstrates the operation's behavior, not that every ordinary board write re-projects every deleted artifact. | F |

The JSON includes measured observations beyond the explicit assertions. In particular, the older recent-reader count and the number of distinct board hashes in probe D are recorded observations, not separate asserted guarantees.

## Downstream guarantees not established

Cross-source semantic deduplication is not established. The observed overlap is conditional on visible transcript text; this experiment does not claim that every supported host actually records board bodies in that form. Tool-call/result-only copies are an important counterexample to the assumption that all board content is automatically covered by transcript ingestion.

Source-lifecycle cleanup is incomplete in the tested case. The repository invariant requires derived state to remain purgeable through its source lifecycle. Thread deletion removes board rows/artifacts, not the derived claim exercised here. The claim retains a useful per-post `source_path`; the problem is the missing cascade in the tested delete operation, not absence of all attribution. The shared `native-memory-bridge` source ID is not a thread-specific configured-source identity.

The probe did not test deleting a post between indexing and projection finalization, real host transcript capture, a real LLM, or model-dependent paraphrase deduplication. No policy or production behavior was changed to make these observations pass.
