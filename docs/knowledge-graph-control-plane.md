# Knowledge Graph Control Plane Inventory

This is an implementation inventory for the current ontology and knowledge
graph control plane. It is not a speculative product spec.

## Tables And Migrations

| Surface | Migration | Exposure | Mutation model | Notes |
|---|---:|---|---|---|
| `entities` | 002, 005, 019, 022, 027, 037, 064, 070 | CLI/API | apply-first audited operations; proposal review for large refactors | Agent-scoped after 019. 070 adds `status`, archive metadata, and proposal provenance. Name/canonical selectors must resolve to one same-agent active row. |
| `relations` | 002, 005 | hidden/internal | internal graph legacy | Kept for legacy entity relation compatibility. New control-plane links use `entity_dependencies`. |
| `memory_entity_mentions` | 002, 005 | hidden/internal | internal write-time linker | Links memories to entities; source memories remain immutable provenance. |
| `entity_aspects` | 019, 070 | CLI/API | apply-first audited operations; proposal review for large refactors | 070 adds archive metadata and proposal provenance. Default reads should treat archived aspects as hidden. |
| `entity_attributes` | 019, 059, 060, 064, 067, 070 | CLI/API | apply-first audited operations; pipeline/supersession helpers also write | Claim slots use `group_key` + `claim_key`. 070 adds first-class versions: `version`, `version_root_id`, `previous_attribute_id`. Default reads show active rows; history reads can inspect all versions. |
| `entity_dependencies` | 019, 031, 036, 039, 050, 064, 067, 070 | CLI/API | apply-first audited operations; structural workers also write | Link operations create/update/archive rows here. Reason/confidence/proposal/source provenance are preserved. |
| `entity_dependency_history` | 050 | hidden/internal | audit trigger | Trigger-backed history for dependency insert/update/delete. |
| `task_meta` | 019, 054 | hidden/internal | task/procedural helpers | Agent-scoped task metadata, not part of this control-plane CLI slice. |
| `ontology_proposals` | 067 | CLI/API | refactor proposal queue and applied operation ledger | Pending proposals are for broad graph refactors or explicit review. Direct operations create applied rows inside the same transaction as graph mutation so provenance remains queryable. |
| `epistemic_assertions` | 071 | CLI/API | source-attributed assertion ledger | Records who claimed, believed, observed, decided, preferred, denied, or questioned something, with confidence, evidence, source provenance, status, and optional link to an applied claim attribute. Assertions do not by themselves make the statement current ontology truth. |
| `dreaming_state`, `dreaming_passes` | 055 | CLI/API via dream status/trigger | dreaming worker | Existing dreaming pass records/status. Dream promotion is apply-first with provenance; generated or ambiguous candidates remain preview/questions until explicitly applied. |
| `memory_artifacts` | 051, 061, 062 | API/internal | immutable source artifact records | Source-backed evidence for proposals and applied graph rows. Ontology updates must not rewrite these rows. |
| `session_transcripts` | 040, 045, 047 | API/internal | immutable transcript/index records | Proposal extraction can cite transcripts; graph mutation must preserve transcript provenance. |

## Daemon Routes

| Route | Exposure | Mutation model | Tests / risk |
|---|---|---|---|
| `GET /api/ontology/proposals` | CLI/API | read-only | Covered by ontology proposal tests. |
| `GET /api/ontology/proposals/:id` | CLI/API | read-only | Covered by CLI/proposal tests. |
| `POST /api/ontology/proposals` | CLI/API | creates pending proposal | Covered by proposal import/create tests. |
| `POST /api/ontology/proposals/batch` | CLI/API | creates pending proposals atomically | Covered by batch proposal tests. |
| `POST /api/ontology/proposals/:id/apply` | CLI/API | applies pending proposal | Covered by proposal apply tests. |
| `POST /api/ontology/proposals/:id/reject` | CLI/API | rejects pending proposal | Covered by reject tests. |
| `GET /api/ontology/proposals/:id/evidence` | CLI/API | read-only | Covered by evidence tests. |
| `GET /api/ontology/proposals/conflicts` | CLI/API | read-only | Covered by conflict tests. |
| `POST /api/ontology/proposals/repair/duplicates` | CLI/API | dry-run candidates or large-refactor proposals | Covered by duplicate repair tests. Clear single merges should use direct `entity merge`. |
| `GET /api/ontology/assertions` | CLI/API | read-only | Lists source-attributed assertions by entity, predicate, speaker, source, status, or text query. Covered by assertion tests. |
| `GET /api/ontology/assertions/:id` | CLI/API | read-only | Reads one same-agent assertion. Covered by assertion tests. |
| `POST /api/ontology/assertions` | CLI/API | creates source-attributed assertion | Requires evidence or source provenance. Covered by assertion tests. |
| `POST /api/ontology/assertions/:id/link-claim` | CLI/API | links assertion to applied claim value | Rejects cross-agent and cross-entity links. Covered by assertion tests. |
| `POST /api/ontology/assertions/:id/archive` | CLI/API | archives assertion | Preserves assertion evidence. Covered by assertion tests. |
| `POST /api/ontology/assertions/:id/supersede` | CLI/API | creates replacement assertion and supersedes old row | Omitting predicate preserves old predicate. Covered by assertion route tests. |
| `POST /api/ontology/extract` | CLI/API | dry-run, pending refactor proposals, and/or assertions | Extraction writes assertions for attributed claims and pending proposals only when explicitly requested. Covered by extraction tests. |
| `POST /api/ontology/consolidate` | CLI/API | dry-run or pending refactor proposals | Consolidates review queues; not the default dreaming maintenance path. Covered by consolidation tests. |
| `POST /api/ontology/operations/apply` | CLI/API | dry-run, pending refactor proposal, or applied operation + graph mutation | Direct operation endpoint. Requires `modify`. Covered through operation engine and CLI tests. |
| `POST /api/ontology/operations/batch` | CLI/API | atomic batch dry-run/propose/apply | Requires `modify`; rolls back on invalid operation. Covered by operation batch tests. |
| `GET /api/ontology/claims/evidence` | CLI/API | read-only | Covered by claim evidence tests. |
| `GET /api/ontology/claims/versions` | CLI/API | read-only | Covered by version chain tests. |
| `GET /api/ontology/claims/version` | CLI/API | read-only | Covered by version show tests. |
| `GET /api/ontology/links/:id/evidence` | CLI/API | read-only | Covered by link evidence tests. |
| `GET /api/knowledge/navigation/*` | CLI/API | read-only | Existing knowledge navigation tests cover entity/aspect/group/claim browsing. |
| `GET /api/pipeline/status`, `GET /api/status` | CLI/API | read-only | `ontology pipeline *` uses these to explain graph mutation state. |
| `GET /api/dream/status`, `POST /api/dream/trigger` | CLI/API | dreaming worker | Existing dream CLI/daemon surface. Ontology dreaming skill uses apply-first operations with provenance by default. |

## CLI Commands

| Command | Exposure | Mutation model | Notes |
|---|---|---|---|
| `signet ontology proposals` | CLI | read-only | Existing proposal list. |
| `signet ontology proposal <id>` | CLI | read-only | Existing proposal show. |
| `signet ontology evidence <id>` | CLI | read-only | Existing proposal evidence. |
| `signet ontology apply <id>` | CLI | applies pending proposal | Preserves proposal history and agent scope. |
| `signet ontology reject <id>` | CLI | rejects pending proposal | Preserves rejected proposal history. |
| `signet ontology conflicts` | CLI | read-only | Lists pending claim conflicts. |
| `signet ontology assertions` | CLI | read-only | Lists source-attributed assertions with filters for entity, predicate, speaker, source, status, query, and agent. |
| `signet ontology assertion show/create/link-claim/archive/supersede/import` | CLI | assertion ledger writes | Creates and maintains attributed assertion rows. `supersede` preserves the old predicate when `--predicate` is omitted. `import` accepts a JSON array or `{ "assertions": [...] }`. |
| `signet ontology entity create/rename/merge/archive` | CLI | direct operation endpoint | Applies by default with audit/provenance. Supports `--dry-run`, `--propose`, `--json`, `--agent`, `--actor`, `--reason`, `--evidence-file`; reserve `--propose` for broad refactors or explicit review. |
| `signet ontology claim set/versions/show/archive/restore` | CLI | operation endpoint for writes, read endpoints for versions | `set` creates version chains; `restore` only required for claim versions in this slice. |
| `signet ontology aspect create/rename/archive` | CLI | direct operation endpoint | Uses same audited operation path. |
| `signet ontology link create/update/archive` | CLI | direct operation endpoint | Uses `entity_dependencies`. |
| `signet ontology stream apply <path|- >` | CLI | atomic JSONL operation batch | Supports file and stdin, `--dry-run`, `--propose`, `--json`, `--agent`, `--actor`. |
| `signet ontology pipeline status/config/explain` | CLI | graph-state inspection | Explains Pipeline V2 graph flags and write gates. |
| `signet ontology config show/validate/explain` | CLI | control-plane inspection | Confirms audited operation tools are usable and no external `graph.yaml` policy gate is active in this slice. |
| `signet ontology extract` | CLI | dry-run/refactor proposals/assertions | `--write-proposals` persists pending proposal rows only when review is requested; `--write-assertions` persists source-attributed assertion rows. |
| `signet ontology consolidate` | CLI | dry-run/refactor proposals | Consolidates existing review queues; normal graph maintenance should use direct operation apply. |
| `signet dream status/trigger` | CLI | existing dream worker | Existing pass status and trigger behavior. |

## Pipeline V2 Graph Knobs

Current graph-affecting configuration is loaded from `memory.pipelineV2` in
`agent.yaml` and surfaced through `signet ontology pipeline *`:

- `enabled`
- `paused`
- `shadowMode`
- `mutationsFrozen`
- `graph.enabled`
- `graph.extractionWritesEnabled`
- traversal mode and bounds (`traversal.enabled`, `primary`, hop/branch/path limits, confidence, timeout, boost)
- dampening settings
- autonomous maintenance (`autonomous.enabled`, `frozen`, `allowUpdateDelete`, mode/polling)
- extraction provider/workload settings
- write gates such as `minFactConfidenceForWrite`
- queue/worker health through `/api/pipeline/status`
- dreaming state through `/api/dream/status`

Unsafe or ambiguous behavior to keep watching:

- Legacy graph workers still have internal write paths. Generated LLM changes
  must remain explicit, audited, and provenance-backed when they target ontology
  maintenance; pending proposals are for large refactors or explicit review.
- `relations` remains a legacy graph table; new audited control-plane links use
  `entity_dependencies`.
- `merge_entities` still moves graph rows and removes the source entity. Use
  `entity merge-plan` for impact inspection and reserve `--propose` for broad
  merge campaigns or risky refactors. Use entity archive operations when
  lineage inspection of the source row matters.
- A separate `$SIGNET_WORKSPACE/ontology/graph.yaml` policy is not active yet;
  adding one should fail closed and must not introduce hidden mutation paths.

## Tests

Existing and new coverage:

- `platform/core/src/migrations/migrations.test.ts`
- `platform/daemon/src/ontology-proposals.test.ts`
- `platform/daemon/src/knowledge-navigation.test.ts`
- `platform/daemon/src/knowledge-graph-list.test.ts`
- `platform/daemon/src/knowledge-expand-api.test.ts`
- `platform/daemon/src/knowledge-graph-hygiene.test.ts`
- `platform/daemon/src/pipeline/graph-transactions.test.ts`
- `platform/daemon/src/pipeline/dreaming.test.ts`
- `platform/daemon/src/dreaming-skill.test.ts`
- `surfaces/cli/src/commands/ontology.test.ts`
- `surfaces/cli/src/commands/knowledge.test.ts`
- `surfaces/cli/src/commands/dream.ts` coverage through existing command behavior

New control-plane coverage includes direct operation apply/propose/dry-run,
atomic batch rollback, claim version restore/archive, ambiguous selector
rejection, default hiding for archived graph rows, and an in-process
end-to-end fixture that verifies dry-run, apply, propose, reject, evidence
lookup, and raw source artifact immutability.

Remaining thin coverage:

- Full end-to-end daemon + CLI process fixture using a real running daemon.
- `graph.yaml` policy validation, because no active policy file is implemented
  in this slice.
