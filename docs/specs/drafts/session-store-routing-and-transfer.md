---
title: "Session Store Routing and Transfer"
id: session-store-routing-and-transfer
status: draft
section: "Connectors and Memory Lifecycle"
informed_by:
  - "https://github.com/Signet-AI/signetai/issues/2177"
  - "https://github.com/Signet-AI/signetai/issues/2061"
  - "docs/specs/approved/explicit-recall-surface-alignment.md"
  - "docs/specs/approved/jsonl-transcript-source-of-truth.md"
success_criteria:
  - "Every connector operation uses one frozen, authorized session store binding."
  - "A resumable daemon-owned transfer verifies target evidence before source cleanup."
  - "Optional personal-side recall labels origins without persisting personal results in a team store."
scope_boundary: "Routing, evidence transfer, and optional read-through recall; not organization identity, project-list presentation, or a second deletion implementation."
---

# Session Store Routing and Transfer

## Decision and scope

Address the remaining parts of [#2177](https://github.com/Signet-AI/signetai/issues/2177)
with three independently gated capabilities:

1. A shared connector-base resolver freezes one store and agent per session.
2. A destination-daemon transfer job imports evidence, verifies it, and requests
   source-owned cleanup. The CLI transports data and observes jobs, not transitions.
3. Opt-in read-through recall runs only on the personal daemon, last.

Project attribution on list rows and `DELETE /api/sessions/:key/transcript`
(including administrator hard purge) are separate deliveries. Transfer consumes
those contracts; it must not use compaction hooks as deletion. No code is approved
by this draft, and no repository invariant is replaced.

### Verified starting point

Source inspection at `e6c65b750b1693bbdea4e5c3e65650213f868697`:

| Surface | Current seam |
|---|---|
| `libs/connector-base/src/index.ts`, `resolveSignetDaemonUrl`, `resolveSignetAgentId`, `buildManagedExtensionEnvBootstrap` | One URL/agent is resolved or embedded in process environment; agent omission currently becomes `default`. |
| `platform/core/src/daemon-url.ts`, `resolveSignetDaemonUrl` | URL precedence is `SIGNET_DAEMON_URL`, configured `daemon.url`, then host/port. |
| `integrations/pi/extension/src/index.ts`, `SignetPiExtension` | Construction captures URL/agent for hooks, explicit tools, peers, and wake delivery, despite later session switches. |
| `platform/daemon/src/routes/memory-routes.ts`, remember/delete registrations | Remember accepts project, temporal fields, tags, importance, pinned state, provenance, scope, and visibility. Delete calls `txForgetMemory`; it is not hard purge. |
| `platform/daemon/src/transactions.ts`, `txForgetMemory` | Forget tombstones, cancels extraction, invalidates derived memories, and retains content in history. |
| `platform/daemon/src/routes/transcript-import-routes.ts`, transcript export registration | HTTP export exists; it is not an immutable transfer manifest or deletion receipt. |
| `surfaces/cli/src/commands/portable.ts`, `registerPortableCommands` | Portable bundles open SQLite directly. Do not extend this path for transfer. |

These are code-reading findings, not a reproduction of the reporter's deployment.
The issue's November 11, 2026 comment also notes that the cleanup workaround now
requires `remember`; a connector credential is not permission to purge.

## A. Per-session store routing

### Configuration and matching

Use a trusted, user-managed `agent.yaml`, never routing or credential overrides
from a repository being opened. `routing` is opt-in; it does not change the CLI's
ordinary organization/local target selection.

```yaml
routing:
  version: 1
  stores:
    personal:
      daemonUrl: http://127.0.0.1:3850
      agentId: me
      credentialRef: keychain:signet/personal/connector
    team:
      daemonUrl: http://127.0.0.1:3860
      agentId: developer
      credentialRef: file:~/.config/signet/credentials/team
  rules:
    - id: personal-repositories
      match:
        path: ["~/personal/**"]
        gitRemote: ["github.com/example-person/*"]
        harness: ["pi"]
      store: personal
    - id: other-personal-projects
      match:
        path: ["~/lab/**"]
      store: personal
  default:
    store: team
```

- Validate the whole block before use: unique store/rule names, known harness
  identifiers and store references, nonempty match lists, and exactly one
  explicit `default`. Reject unknown keys and empty matches. Limit to 32 stores,
  128 rules, and 32 patterns per field, each at most 1,024 characters.
- Rules run in file order; first match wins. Fields within a match are AND;
  entries within a field are OR. The first rule above requires all three fields.
  Path-or-remote means two rules. No inferred specificity or rule merging.
- `path` matches the absolute physical Git worktree root, or physical launch cwd
  outside Git. Expand only leading `~/` using the connector user's home. Resolve
  symlinks once, normalize separators to `/`, preserve case, and require absolute
  patterns after expansion. `*` matches within a path segment, `**` across
  segments, and `?` one non-separator character; no brace, negation, or regex
  syntax. A trailing `/**` includes the root itself. Do not walk the filesystem.
- `gitRemote` matches any configured fetch remote, read locally without network
  access. Normalize SSH/scp and HTTPS remotes to `host[:port]/owner/repository`:
  lowercase host, remove credentials, trailing slash, and terminal `.git`, retain
  path case. Use the same glob grammar. Local/file remotes do not match. Worktrees
  use their own root and shared remote configuration, not the parent cwd.
- `harness` is an exact supported connector identifier, not a user/agent name.
  Missing Git metadata outside Git is an absent field, not an error. A failed or
  timed-out Git/path inspection is a routing error, not permission to select the
  default. Bound discovery to two seconds and 64 KiB of remote metadata; do not
  invoke a shell or arbitrary credential helpers.

`credentialRef` refers to the existing credential facility's keychain entry or
owner-only file (0600 on Unix, equivalent user ACL elsewhere). No inline secrets,
commands, or URL credentials are accepted. Each reference is registered against
one normalized origin and authorized principal/agent. It cannot be sent to another
origin, including on redirects. Local unauthenticated access requires an explicit
`credentialRef: local` and a daemon that actually admits that local identity;
a loopback tunnel is not evidence of local trust.

### One resolver, one binding

`connector-base` owns routing normalization, discovery, selection, and binding
persistence. Reuse core's canonical URL normalization/legacy URL resolver rather
than copying its precedence. All connectors consume this resolver at runtime,
including native extensions and process-per-hook adapters. Foreign-runtime
adapters invoke a packaged connector-base binding bridge; they do not implement
a second matcher. The SDK transport proposed in #2099 owns HTTP/auth mechanics,
not another routing policy.

For a **new** session, selection is:

1. An explicit connector launch store selection, if provided.
2. A user-supplied `SIGNET_DAEMON_URL`: select the configured store with that
   exact normalized origin. If several match, require explicit store selection;
   an unregistered origin is an error while routing is enabled.
3. First matching routing rule, then the explicit default.
4. Only with no `routing` block: existing URL precedence and connected-agent
   configuration, normalized through the compatibility path below.

`SIGNET_AGENT_ID` explicitly overrides the selected store's agent for a new
session, subject to the daemon's authorization. `SIGNET_API_KEY` (then legacy
`SIGNET_TOKEN`) is an ephemeral credential reference only when accompanied by an
explicit URL selecting that same origin; otherwise reject it with routing enabled.
Never combine a routed URL with an ambient key from another origin. `SIGNET_HOST`
and `SIGNET_PORT` affect only legacy resolution, not named stores.

Installer-generated environment is configuration, not an explicit user override.
On connector sync, replace baked URL/agent/key bootstraps with the resolver entry
and credential references. Migrate recognized managed values; block routing
activation if an old managed bootstrap or unsupported connector can still bypass
it. Do not change process-global environment when switching sessions.

Before any evidence upload, recall, presence advertisement, or notification wait,
atomically persist a binding keyed by connector installation and harness session
identity. It contains:

- binding version/id, harness and session identity;
- store name, normalized origin, daemon-issued stable `storeId`, and agent;
- authenticated principal reference, credential reference, and allowed scope;
- original project root/remotes, selected rule or override, and config digest.

The daemon handshake must expose an owner-persisted opaque store identity and
verify agent/scope authorization. A URL is a network location, not store identity.
Credentials may rotate only within the same origin, principal, and authorized
scope. Reconnect verifies the pinned `storeId`; a changed store behind the same
port blocks delivery. Cloning a workspace into a distinct store must mint a new
identity; backup restoration of the same store preserves it.

Every operation receives the binding, not raw environment: hooks, transcript
snapshots/backfill, explicit remember/recall, MCP/native tools, presence,
notifications, acknowledgments, wake waiters, compaction, and shutdown. A
process-shared MCP endpoint must receive a session binding through an authenticated
session channel; absence or conflict fails closed, never selects the last session.
The bridge transports routing state only; the daemon still owns every durable
memory/session transition and validates identity independently.

### Lifecycle and failures

- Resume reuses the persisted binding even when rules, cwd, remotes, or environment
  changed. Recheck credential authorization, not route selection. A missing or
  corrupt binding for an already captured session blocks automatic capture until
  the operator explicitly adopts its known previous store or starts a new session.
- Changing cwd does not reroute or relabel the original project. Warn when a new
  project would select a different store and require a new session for that work.
  A fork is a new session: resolve its route, but do not replay inherited transcript
  bytes to a different store without an explicit transfer.
- On a harness switch, finish/queue shutdown against the old binding, stop its
  waiters and clear its context before activating the new binding. Late callbacks
  retain their captured binding; they cannot use the current session's client.
- Unreachable, 401, 403, store mismatch, or disabled configuration never falls back
  to another store. Explicit tools return the real failure. A bounded local outbox
  retains delivery data and its binding, not a new route decision. Default caps:
  100 MiB per installation, seven-day retry horizon, three attempts per delivery
  run. At capacity stop admitting new capture and report the gap; never discard
  old evidence silently. Expiry stops retries but requires explicit export/discard
  before retained data is removed. No transcript bodies or secrets in diagnostics.
- Existing sessions cannot be rebound by editing config. An explicit new-session
  action changes future routing; historical correction uses transfer.

### Compatibility and acceptance

Without `routing`, existing single-URL installations keep their configured target,
agent, and auth behavior. Translate their managed setup into one canonical binding;
do not require re-login just for the upgrade. Where legacy setup used `default`,
resolve that existing configured roster identity at the compatibility boundary and
record it explicitly. This does not authorize missing/ambiguous scope on new routed
or organization credentials. Do not guess a legacy session's previous destination.

Acceptance requires a resolver table suite for AND/OR/order/default, globs,
worktrees/symlinks, remote normalization, absent versus failed discovery, all
precedence cases, origin-bound secrets, and invalid config. Run two real isolated
daemons with distinct keys/store IDs and drive every shipped connector through
personal/team sessions, including explicit tools and process-per-hook/MCP paths.
Verify exact records and transcripts on the selected daemon and their absence on
the other. Include same-process switching, resume after config/env changes, cwd
change, forks, late shutdown, queued delivery after restart, revocation, full
outbox, and swapped ports. Demonstrate an unavailable team daemon causes zero
personal writes. Snapshot legacy connector output and prove unchanged single-store
behavior through the packaged connector, not only resolver mocks.

## B. Daemon-owned evidence transfer

### Ownership and user surface

The **destination daemon** owns a durable transfer job and target ingest. The
**source daemon** alone owns selection, export authorization, and source cleanup.
The CLI is a bounded streaming courier between their authenticated APIs. This
works through laptop-side tunnels without either remote daemon reaching the
laptop's loopback. Closing the CLI pauses transport, not state ownership. There is
no remember/delete loop, direct SQLite access, or portable-bundle extension.

```text
signet move --from team --to personal --source-agent developer --target-agent me --project example --preview
signet move --from team --to personal --plan <id> --confirm <digest> --wait
signet move --to personal --resume <transfer-id> --wait
```

The names reuse configured store/credential references, not #2061's global target
flags. Omit `--preview` and the command still previews by default. `--copy` preserves
the source; normal move forgets/tombstones it; `--purge-source` requests hard purge
and needs separate explicit confirmation and source administrator authority.
Reject copy plus purge. Pin/unpin is not implicit: preview lists pinned records
and requires explicit consent to force their source deletion while preserving the
target pin. Ambient session routing never selects transfer endpoints.

### Manifest and evidence contract

A source-owned plan freezes an authorized selection by explicit IDs/session keys,
tag, project, or query. Require source agent and at least one selector; combining
selector types intersects them, and IDs within a list union. A query only selects
its displayed frozen results; it never reruns during commit. Materialize selection
in owner-backed pages, with a durable cutoff and per-record revision; concurrent
change makes the affected group stale, not silently part of the move.

The manifest binds both store IDs, principals, source/target agents, project/scope
and visibility/classification mapping, mode, exact object revisions, byte lengths,
content/metadata digests, and dependency groups. Preview pages show authorized
counts/bytes, immutable digest, skipped/unsupported objects, required permissions,
cleanup impact, and retained-copy warnings. Plans expire after 24 hours before
confirmation. No success or deletable plan while enumeration is incomplete.

Transfer authoritative evidence and explicit user state: original transcript bytes
and ordering, explicit memories (including complete long-content/chunk groups),
content, `created_at`, other explicit temporal values, tags, pinned, importance,
project, scope, visibility, and source lineage. New target IDs are normal. Preserve
origin store, original object/session IDs, original agent, project, author and
source references as immutable lineage; record importing actor/time separately.
Never impersonate an origin author as a local authenticated user. Remap internal
references through the durable original-to-target map, including every chunk ID.
Do not deduplicate unrelated originals merely because their content matches.

Derived memories/claims selected by query are expanded to their attributable
source evidence; show this expansion before confirmation. If evidence is missing,
shared with unselected material, or not exportable, mark the group blocked; do not
promote a generated claim into an explicit user memory. Summaries, semantic claims,
relationships, embeddings, search rows, and projections are not imported as truth.
Target indexing owners rebuild supporting state; Dreaming alone re-derives semantic
claims after evidence commit. Report this work separately from evidence transfer.

A transcript group is the complete scoped session, not selected turns. Partial
history/version migration and external source-connector installation are out of
scope. Detect and block evidence that needs those rather than dropping it.
Preserve security restrictions exactly unless the preview contains an explicit,
authorized mapping. Unknown classification semantics block transfer; they do not
become public or private by approximation.

### Protocol and commit boundary

Proposed `/api/transfers` operations use the same canonical daemon services as
ordinary ingest and deletion. All persisted state crosses the bounded database
owner protocol. Endpoint names below are new contracts, not claims of existing API.

| Step | Owner and contract |
|---|---|
| Prepare | Source `POST /api/transfers/exports` creates the paged manifest. Destination `POST /api/transfers/imports` validates it and creates a job. Both return their authenticated store identity and protocol capabilities. |
| Confirm | Source and destination admit the exact plan digest, agent/security mapping, destination receipt-verification key, and mode under separately authenticated user approvals. A job is not a bearer credential. |
| Transport | Source `GET /api/transfers/exports/:id/pages/:cursor` emits manifest-bound, signed evidence pages; CLI streams them to destination `POST /api/transfers/imports/:id/pages`. The destination drives the next cursor/action in its job status. |
| Ingest | Destination validates source signature, revisions/digests and authorization, then commits evidence plus an idempotency receipt atomically through canonical ingest operations. Staging is not recallable and does not trigger Dreaming. Publish a complete dependency group only. |
| Verify | Destination reads committed evidence back through its canonical owner-backed read path, hashes bytes and explicit metadata, and verifies the complete ID/chunk mapping. It records and signs a durable verified receipt for that group. A 2xx ingest response alone is insufficient. |
| Cleanup | CLI carries the verified receipt to source `POST /api/transfers/exports/:id/cleanup`. Source validates its pinned destination key, plan/group digest, exact target mapping, current authority, and unchanged source revision, then requests canonical deletion. The CLI cannot authorize cleanup by asserting that a copy succeeded. |
| Finalize | Source returns a durable signed cleanup outcome; destination records it before declaring the group moved. Copy completes after verification without requesting cleanup. Restart reads existing receipts/outcomes before taking another action. |

The daemon store identity includes a receipt-signing public key. Confirmation pins
both peers' keys obtained over the independently authenticated connections; a
payload cannot nominate its own trusted key. Receipts bind transfer, plan, group,
source revision, target IDs/digest, and mode, so they cannot authorize other deletes.
Receipt replay is idempotent; key rotation retains verification of outstanding
jobs. CLI courier code executes daemon-issued page actions, applies transport caps,
and reports status; it never selects records, computes deletion eligibility, or
implements retry/recovery semantics for domain transitions.

Idempotency is durable on `(sourceStoreId, transferId, groupId, sourceRevision,
targetAgentId)`, including the payload fingerprint. Exact retries return the same
IDs/receipt; a different payload under that key is a conflict. Receipt lookup
survives a lost reply. A changed source requires a new preview, not mutation of a
confirmed manifest. Target records awaiting source outcome are protected from
ordinary mutation/deletion; explicit cancellation releases them only after source
reconciliation proves cleanup was not authorized or has finished. Holds are durable
metadata, not a worker or lock held across network I/O.

### Deletion, failure, and bounds

For move, the source installs a scoped ingestion fence before exporting a
confirmed transcript group, drains admitted writes, and revalidates its revision.
Live/unquiesced sessions block the group. The canonical transcript lifecycle must
retain a tombstone that rejects delayed hook snapshots, outbox replay, backfill,
imports, and compaction re-uploads. No bypass-plus-summary workaround.

After verification, call the service underlying
`DELETE /api/sessions/:key/transcript` and canonical memory forget, with expected
revisions and the transfer reason. Hard purge uses those lifecycle owners' explicit
purge mode, including content-bearing history, canonical JSONL/markdown artifacts,
retained import originals, indexes, vectors, source-derived claims, caches, and
pending jobs. If per-memory hard purge is not available, add it at the canonical
memory lifecycle owner before enabling `--purge-source`; do not duplicate an
agent-wide purge inside transfer. Cleanup of shared derived claims invalidates the
claim rather than keeping leaked text after removing a citation; Dreaming may
rebuild from remaining evidence.

Normal move retains recoverable source history and says so. Hard purge reports
completion only after daemon-owned live copies and derived invalidation finish;
backup archives, upstream/native harness logs, filesystem remnants, and external
replicas are outside that claim and listed explicitly. Purge leaves only minimal
content-free receipt/audit/tombstone metadata, not payloads in job logs or staging.
Export scratch payloads are deleted at finalize/cancel; expired jobs lose payloads
but retain compact reconciliation receipts. Purging one store never silently
purges another store's independent copy.

State is visible per group: `planned`, `copying`, `verified`, `cleanup_pending`,
`complete`, `blocked`, `cancelled`, or `failed`; top-level status includes confirmed,
verified, cleaned, and remaining counts. Lost ingest reply resumes by receipt
lookup; failed verification leaves source untouched; failed cleanup leaves a
verified target and `cleanup_pending`. Restart after source deletion but before its
reply recovers the source outcome. Never roll back by deleting a good target after
source deletion might have committed. Cancellation stops new groups, reconciles
in-flight owner work, retains verified target copies, and reports any completed
source cleanup; it is not an atomic undo. Releasing a fence after cancellation
requires a known source outcome. Uncertain cleanup remains blocked and visible.

Default admission limits: two active transfers per daemon; at most 10,000 objects
or 1 GiB per plan; pages of at most 100 metadata records and 1 MiB of streamed
payload; 16 MiB per evidence object (larger objects explicitly blocked); at most
two pages in flight. Owners hash/read large objects incrementally off the request
thread. Each transport attempt has a 30-second deadline and three bounded retries;
an execution run lasts at most 15 minutes before pausing for explicit resume.
Reserve staging capacity before ingest. Worker cancellation releases buffers and
leases before reporting paused/cancelled. Reconciliation metadata and protected
target records survive restarts; they consume admitted job quota until resolved.

### Authorization, compatibility, and acceptance

Authenticate independently at each origin using its credential reference. Source
requires authorized export/recall plus `forget` for move and administrator purge
for hard cleanup; destination requires authorized `remember` and the explicit
target agent/security mapping. Recheck revocation and mutation gates on every
page/commit; no admin scope bypass or trust from client actor headers. Short-lived
job grants can narrow these permissions but never widen them. No credential,
transcript payload, or bearer job grant in arguments, diagnostics, or receipts.

Both daemons must advertise transfer protocol v1 and the required canonical
lifecycle capabilities. Unsupported peers fail before export or mutation, with no
fallback to legacy remember/delete or offline SQLite. A single-store setup is
unchanged. Same-store transfers are rejected; agent reassignment is a separate
operation. Different daemons using the same signing identity are a configuration
error, not two stores.

Acceptance runs two real daemon/owner processes, with strict scoped credentials:

- Preview leaves evidence unchanged, excludes unauthorized rows/counts, freezes
  query results, and blocks unresolved lineage, classifications, or active sessions.
- Copy and move preserve exact bytes, temporal fields, tags, pinned/importance,
  project/security metadata and lineage, including long chunk groups and colliding
  original IDs in different stores. Replaying pages never creates duplicates.
- Kill CLI and either daemon before/after every durable boundary, including target
  commit before receipt reply and source cleanup before outcome reply. Resume after
  restart; changed payloads, source edits, revoked keys, forged/replayed receipts,
  wrong agents, and changed store keys fail closed without collateral deletion.
- Normal move is absent from active source reads but recoverable in history. Purge
  removes source evidence/history/artifacts and derived leaks through all read
  surfaces, including after delayed hook/backfill replay and restart. Unrelated
  sessions, agents, and independently sourced claims remain intact.
- Target claims do not appear via import. Rebuild supporting indexes and run an
  authorized Dreaming pass to prove resulting claims cite transferred evidence.
- Exercise more than one page, quota/disk refusal, oversized objects, deadline,
  cancellation, no transport, and slow owners while health remains responsive.
  Inspect process database handles: only each workspace's owner opens its database.

## C. Optional read-through recall

Implement only after A and B are usable. The **personal daemon** federates an
explicit recall request to its own canonical recall operation and one opted-in
team origin. Never install personal credentials on the team daemon. The personal
daemon's trusted config maps its authenticated caller to an origin-bound,
read-only team credential reference with that person's allowed agent scope; no
shared organization-wide service credential or arbitrary request URL. Session
bindings declare whether this personal-side feature is available.

Disabled by default, explicit recall only. Enable it per caller/store pair; do not
add it automatically to session-start, prompt-submit, notifications, or Dreaming.
Show that the query itself is sent to the team origin; forward only the requested
query/filters, not personal hits, transcript context, or local identity files.
Team-bound sessions cannot request personal read-through. Personal-side opt-in is
not permission to export organization data beyond the team credential's policy.

Each origin applies its own caller authorization inside retrieval, including
#2061's classification predicate; no post-filtering of unauthorized hits. Mark
upstream requests local-only to prevent recursive federation. Allow at most two
origins total, ten hits per origin, twenty merged hits, 1 MiB aggregate response,
and a two-second overall deadline. Abort unfinished work on deadline/cancel;
merge successful hits deterministically by reciprocal rank, not uncalibrated
cross-store similarity scores. Do not use an external reranker on private hits.

Every hit and drill-down reference carries `storeId`, configured source label,
agent, original result ID, and provenance; key identity by that tuple, never bare
ID. Identical content from different stores retains both labels. Drill-down goes
through the same per-origin authorization. Return per-requested-origin status
(`ok`, `timeout`, `unauthorized`, `unavailable`, or `truncated`) and top-level
`complete: false` for any partial result. An unavailable origin is not empty;
if none succeeds, return failure, not successful empty recall. Status reveals
nothing about collections or audiences the caller cannot access.

Keep remote results request-local: no content cache, memory write, semantic merge,
feedback write, or team-side logging of personal hits. Personal results never go
to the team origin. The connector may inject labeled results only into a
personal-bound session; canonical transcript separation still applies. A user or
model can later quote a result manually; read-through cannot promise to prevent
that external disclosure. Do not claim organization agents provide this boundary.

Acceptance uses two stores with colliding IDs, distinct principals, forbidden
classifications, and overlapping content. Verify labels on tools/CLI/drill-down,
authorization before ranking/counts, revocation, recursion refusal, deadlines,
truncation and deterministic merge. Inspect both stores, captured outgoing requests,
and logs to prove recall creates no evidence/semantic records and sends no personal
hits to the team. Verify disabled and team-bound cases perform no personal lookup.

## Interaction with organization mode (#2061)

Separate instances are a trust boundary; an organization personal agent is not a
private personal store. Routing complements person principals and classifications,
not a substitute. Agent IDs organize data; credentials establish who may act.
No self-asserted author/header or connector rule grants access.

#2061 currently says each harness targets exactly one daemon. Refine that proposed
product rule to **each harness session targets exactly one daemon**, with an
unchanged single-target mode. #2061's stored login and global `--org`/`--local`
choice still do not move connected sessions. Connector provisioning issues distinct
keys per store and chosen agent. Signing in or rotating credentials never changes
a frozen session's destination. No organization visibility, onboarding migration,
or empty-scope compatibility decision is silently amended by this spec.

Routing can ship with today's explicit scoped keys; person-bound provisioning,
classification transfer, and per-person federation must integrate with #2061 as
those facilities land. Reject unsupported restrictions rather than weaken them.
The SDK transport from #2099 should carry bindings, origin-bound auth, distinct
401/403 outcomes, and bounded delivery without owning selection policy.

## Delivery order

1. Ship A: shared resolver/binding bridge, credential-reference migration, and all
   connector paths together. Do not claim routing support for a bypassing adapter.
2. Land the separate project-list and transcript-delete deliveries. Qualify the
   canonical transcript fence/purge and scoped memory purge before transfer cleanup.
3. Ship B copy/preview/receipt support first, then enable move and hard purge only
   after their deletion/recovery gates pass. One protocol; no temporary CLI executor.
4. Ship C as an explicit opt-in after origin labeling, per-person authorization,
   transcript separation, and no-write tests pass. It is not required to close the
   core routing/cleanup incident.

Implementation must update the owning config/API/CLI/connector contracts and
packaged harness proofs in each phase. Rollback disables new admission, not durable
bindings/receipts or the ability to reconcile in-flight jobs. Downgrade while new
bindings/transfers are active is unsupported and must be diagnosed before launch.

## Open product questions

1. **Should federation ship in the first release?** Recommend no: keep it opt-in
   and last; routing plus verified transfer resolves the incident without a new
   cross-store query disclosure path.
2. **Should hard source purge be the move default?** Recommend no: retain ordinary
   forget as the default, prominently warn that history remains, and require the
   separate administrator-confirmed purge option for confidential cleanup.
