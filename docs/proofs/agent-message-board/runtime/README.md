# PR 2181 runtime verification (messaging + board)

Reproduce (from the worktree at the pinned head, no network inference, no live daemon contact):

    bun scripts/verification/agent-message-board-runtime.ts

Flags: `--skip-mutation`, `--only-mutation <id>`, `--out <dir>`, `--keep-workspace`.
Exit code 0 only when every step check passes; non-zero on any failed check or watchdog expiry.

`report.json` is the redacted stdout JSON (sorted keys): step checks, observed source IDs, runtime versions,
pinned SHA, command and assumptions. Scratch HOME/SIGNET_PATH are deleted after the run.
Steps with status `not_verified` were not exercised. `MUT-*` steps run a mutated scratch copy of the daemon
source and pass only when the harness detects the injected defect.

## Source guard

The pin (`implementation_pin_sha`) is the implementation under test; `current_head_sha` is recorded separately.
Preflight requires the pin to be an ancestor of HEAD and every non-test file under `platform/`, `libs/`,
`integrations/`, `surfaces/` plus package/lock files to be byte-identical to the pin (tracked diff and untracked
files both checked). Documentation, evidence and test-only changes are allowed. Any other change fails P00 and skips daemon startup and mutation execution.

## SQL inspection method and limits

The harness never opens the running workspace database. Assertions use HTTP where possible. For independent SQL
state, each query: SIGSTOPs the daemon process group (daemon, descendants, group members), verifies stopped state
and that every `/proc` DB fd holder is in the frozen set, byte-copies db/-wal/-shm into a fresh scratch dir,
SIGCONTs in `finally`, queries only the copy (opened read-write so SQLite can recover the copied WAL; the copy
is discarded), then deletes the copy. Quota state is never reset. When the daemon is stopped, the file is copied
directly. Limits: brief freezes (see `sql_inspection.max_freeze_ms`) can delay in-flight requests; a failed freeze
or an fd holder outside the group aborts the query rather than falling back to the original DB.

## L02 disclaimer

L02 records `/proc` fd holders observed in the daemon tree at one instant. It does not prove exactly one DB
writer or a correct owner architecture, and does not claim any ownership problem is fixed.

## Latest run (this script version)

137 checks, 0 failed, across 28 steps (22 pass, 1 observation, 5 `not_verified`); 73 freeze snapshots, 0 unsafe,
the maximum freeze duration is recorded in `report.json`. Scope: HTTP routes of source daemons on scratch workspaces at the pinned implementation only;
this is not a production or whole-feature certificate and does not exercise real harnesses, MCP, dashboard, or Dreaming.

A mutation control passes only when every check named in its `expect` list fails, no `step completed without
exception` crash check fails, and no inner step is `not_verified`. Each anchor must match the source exactly once.
`Z00-cleanup` asserts no scratch directory or scratch-environment process remains. `script_sha256` in P00 matches the
committed script.
