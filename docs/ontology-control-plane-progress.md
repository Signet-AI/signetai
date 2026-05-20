# Ontology Control Plane Progress

## Inventory Checkpoint

- Changed: added `docs/knowledge-graph-control-plane.md` with schema,
  migration, route, CLI, Pipeline V2 graph knob, proposal, dream, and test
  inventory.
- Verified: `bun scripts/spec-deps-check.ts` passed with 87 specs indexed.
- Commands run:
  - `bun scripts/spec-deps-check.ts`
- Failures encountered: none.
- Remaining risk: route-level auth coverage is thinner than function-level
  operation coverage.
- Next checkpoint: operations API and operation handlers.

## Operations API Checkpoint

- Changed: added `/api/ontology/operations/apply` and
  `/api/ontology/operations/batch`.
- Changed: implemented direct operation execution through the existing
  ontology proposal engine. Apply-first operations create an applied
  `ontology_proposals` row inside the same transaction as graph mutation.
- Changed: `--dry-run` executes validation and preview inside a rolled-back
  transaction; `--propose` creates a pending proposal without graph mutation.
- Verified: focused ontology proposal tests cover apply, dry-run, propose,
  atomic batch rollback, dry-run per-line batch errors, evidence preservation,
  and agent scoping.
- Commands run:
  - `bun run build:core`
  - `bun test platform/daemon/src/ontology-proposals.test.ts surfaces/cli/src/commands/ontology.test.ts platform/core/src/migrations/migrations.test.ts`
- Failures encountered: daemon tests initially loaded stale `@signet/core/dist`
  without migration 070; rebuilding core fixed it.
- Remaining risk: API auth middleware is wired through existing route patterns
  but not separately route-tested.
- Next checkpoint: entity/aspect/link handlers.

## Entity/Aspect/Link Checkpoint

- Changed: added handlers for entity create/rename/archive/merge,
  aspect create/rename/archive, and link create/update/archive.
- Changed: selectors now reject ambiguous same-agent active entity/aspect
  matches and require ids when needed.
- Verified: tests cover direct create, ambiguous selector rejection, merge,
  link creation, link evidence, and batch rollback.
- Commands run:
  - `bun test platform/daemon/src/ontology-proposals.test.ts surfaces/cli/src/commands/ontology.test.ts platform/core/src/migrations/migrations.test.ts`
- Failures encountered: none after core rebuild.
- Remaining risk: merge still removes source entities after moving rows; archive
  should be used when source-row history must remain visible.
- Next checkpoint: claim/version handlers.

## Claim/Version Checkpoint

- Changed: migration 070 adds `version`, `version_root_id`, and
  `previous_attribute_id` to `entity_attributes` and backfills existing rows to
  v1/root=id.
- Changed: `set_claim_value` creates v1/vN chains, supersedes previous active
  versions, and leaves old versions queryable.
- Changed: `archive_claim_value` hides a value from active reads while
  preserving version history; `restore_claim_version` makes a chosen version
  active and supersedes the previous active version.
- Verified: tests cover v1/v2/v3 chains, version reads, restore, archive, and
  default active visibility.
- Commands run:
  - `bun test platform/daemon/src/ontology-proposals.test.ts surfaces/cli/src/commands/ontology.test.ts platform/core/src/migrations/migrations.test.ts`
- Failures encountered: none.
- Remaining risk: merge still removes source rows after moving graph state;
  archive should be preferred when source-row history matters.
- Next checkpoint: CLI.

## CLI Checkpoint

- Changed: added `signet ontology entity`, `claim`, `aspect`, `link`, and
  `stream apply` commands.
- Changed: command options include `--dry-run`, `--propose`, `--json`,
  `--agent`, `--actor`, `--reason`, and `--evidence-file` where practical.
- Changed: JSONL stream apply supports file paths and `-` for stdin.
- Verified: CLI tests cover entity create, claim set, claim versions/show,
  claim archive/restore, aspect operations, link operations, stream apply, and
  pipeline explain status calls.
- Commands run:
  - `bun test platform/daemon/src/ontology-proposals.test.ts surfaces/cli/src/commands/ontology.test.ts platform/core/src/migrations/migrations.test.ts`
- Failures encountered: none.
- Remaining risk: no spawned real daemon CLI smoke test yet.
- Next checkpoint: Pipeline status/config.

## Pipeline Status/Config Checkpoint

- Changed: added `signet ontology pipeline status`, `config`, and `explain`
  commands that inspect Pipeline V2 graph mutation state.
- Changed: added `signet ontology config show`, `validate`, and `explain`
  commands that confirm audited operation tools are usable immediately and
  that no separate `ontology/graph.yaml` policy gate is active in this slice.
- Verified: CLI test covers `pipeline explain` reading `/api/status`.
- Commands run:
  - `bun test surfaces/cli/src/commands/ontology.test.ts`
- Failures encountered: none.
- Remaining risk: a future active graph policy file needs fail-closed parser
  tests before it can control generated maintenance.
- Next checkpoint: dreaming skill.

## Dreaming Skill Checkpoint

- Changed: added built-in `skills/dreaming/SKILL.md` with proposal-first
  ontology maintenance rules, expected inputs, JSONL operation output, and
  hard constraints against hidden direct SQLite mutation.
- Changed: added `docs/dreaming-skill-runbook.md` as the first runnable path
  from hygiene/proposal context to dry-run, propose, review, apply/reject, and
  version/evidence inspection.
- Verified: `platform/daemon/src/dreaming-skill.test.ts` asserts the built-in
  skill exists and preserves proposal-first/default-dry-run language.
- Commands run:
  - `bun test platform/daemon/src/dreaming-skill.test.ts`
- Failures encountered: none.
- Remaining risk: this slice documents and tests the built-in skill and CLI
  path; it does not add a new autonomous dream scheduler.
- Next checkpoint: default-read archive filtering and end-to-end validation.

## Archive/Default-Read Checkpoint

- Changed: default knowledge navigation, entity detail, dependency, and stats
  reads now filter archived entities, archived aspects, and archived
  dependencies out of active graph views.
- Changed: claim history/version reads remain available for deleted and
  superseded claim rows.
- Verified: `knowledge-graph-list.test.ts` covers archived rows being excluded
  from list counts, dependency counts, stats, and coverage.
- Commands run:
  - `bun test platform/daemon/src/knowledge-graph-list.test.ts`
- Failures encountered: the first regression run showed dependency counts still
  included links to archived entities; the query now joins source/target
  entities and filters both active.
- Remaining risk: specialized future graph readers should copy the same
  active-row default unless they are explicitly history/audit surfaces.
- Next checkpoint: final validation.

## Final Validation Checkpoint

- Verified: in-process end-to-end fixture covers dry-run, apply, propose,
  reject, evidence lookup, and raw memory artifact immutability.
- Verified: focused tests pass across ontology proposals, built-in dreaming
  skill, graph list/stats, CLI commands, and migration framework.
- Verified: core build and targeted Biome checks pass.
- Commands run:
  - `bun scripts/spec-deps-check.ts`
  - `bun run build:core`
  - `bunx biome check --write platform/daemon/src/knowledge-graph.ts platform/daemon/src/knowledge-graph-list.test.ts platform/daemon/src/ontology-proposals.test.ts`
  - `bun test platform/core/src/migrations/migrations.test.ts surfaces/cli/src/commands/ontology.test.ts platform/daemon/src/ontology-proposals.test.ts platform/daemon/src/dreaming-skill.test.ts platform/daemon/src/knowledge-graph-list.test.ts`
- Failures encountered: none in the final focused validation pass.
- Remaining risk: root `bun run typecheck` still depends on the unrelated
  desktop `electron-updater` dependency state; record that separately when
  running full workspace validation.
