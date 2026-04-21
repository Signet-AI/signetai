---
title: "Plugin SDK Core V1 and Secrets Local Provider Extraction"
id: plugin-sdk-core-v1
status: complete
informed_by:
  - "docs/research/technical/RESEARCH-PLUGIN-SDK-SECRETS.md"
  - "docs/specs/planning/plugin-api-ecosystem.md"
section: "Platform"
depends_on:
  - "signet-runtime"
success_criteria:
  - "Bundled TypeScript core plugins can register a manifest, lifecycle state, capabilities, surface metadata, health, and prompt contributions through a daemon-owned plugin host"
  - "Plugin status and diagnostics expose enabled, disabled, blocked, active, and degraded states without crashing the daemon on plugin failure"
  - "Prompt contributions are append-only/context-only, provenance-tagged, token-bounded, and removed when a plugin is disabled"
  - "Signet Secrets is represented as a privileged bundled core plugin while existing /api/secrets routes, CLI, MCP, dashboard, and SDK behavior remain backward compatible"
  - "The local Secrets provider adopts existing $SIGNET_WORKSPACE/.secrets/secrets.enc files in place without re-encryption, relocation, or user action"
  - "The V1 manifest and registry store marketplace-ready metadata and future Rust sidecar compatibility fields without implementing marketplace install or Rust sidecar execution"
scope_boundary: "V1 implementation contract only: bundled TypeScript plugin host skeleton, manifest validation, registry/status storage, prompt contribution registry, surface metadata registry, capability declarations/grants for bundled plugins, and Signet Secrets local-provider extraction. Excludes marketplace install, third-party plugin execution, Rust sidecar execution, WASI, dynamic dashboard panel rendering, dynamic CLI command loading, Bitwarden/Vault/cloud providers, and secret store format upgrades."
draft_quality: "approval-ready implementation slice carved from plugin-api-ecosystem planning epic"
---

# Plugin SDK Core V1 and Secrets Local Provider Extraction

## Problem

The broader Plugin SDK planning epic defines the destination: Signet plugins as
cross-surface capability modules that can extend daemon, CLI, MCP, dashboard,
SDK, connectors, and prompt lifecycle surfaces.

That full destination is intentionally larger than a first implementation. If
we try to implement TypeScript plugins, Rust sidecars, marketplace install,
dynamic UI mounting, prompt composition, and every secret provider at once, the
PR becomes an everything-bagel and the trust boundary gets blurry.

V1 should prove the architecture with the smallest useful slice:

1. a daemon-owned plugin host for bundled TypeScript core plugins,
2. a manifest and registry model that will survive marketplace support later,
3. prompt contribution plumbing with visibility and disable behavior,
4. surface metadata plumbing for CLI/MCP/dashboard/connectors without requiring
   dynamic loading everywhere yet,
5. `signet.secrets` represented as a privileged core plugin,
6. the current local encrypted secrets implementation extracted behind a local
   provider interface without changing existing user data.

## Goals

1. Add a plugin host skeleton owned by the daemon.
2. Support bundled TypeScript core plugin manifests.
3. Persist plugin registry and lifecycle state.
4. Expose plugin status and diagnostics through daemon API.
5. Support append/context prompt contributions with provenance, token budgets,
   ordering, and disable behavior.
6. Add a surface metadata registry for daemon, CLI, MCP, dashboard, SDK, and
   connector contributions.
7. Represent Signet Secrets as the first privileged bundled core plugin.
8. Extract local secret storage behind a provider interface while preserving
   `secrets.enc` byte-for-byte unless a user writes a new/updated secret.
9. Keep existing `/api/secrets/*`, CLI, MCP, dashboard, and SDK behavior working.
10. Store marketplace-ready manifest metadata without implementing marketplace
    install.

## Non-Goals

- No marketplace install, review, ranking, payments, or public discovery.
- No third-party plugin execution.
- No Rust sidecar execution in V1.
- No WASI runtime.
- No native dynamic-library plugin loading.
- No dynamic dashboard panel rendering from arbitrary plugin code.
- No dynamic CLI command loading from arbitrary plugin code.
- No Bitwarden, Vault, AWS, GCP, Azure, pass/gopass, or env provider
  implementation.
- No secret store format migration.
- No raw secret read endpoint.
- No plugin-authored mutation of user prompts beyond append/context
  contributions.
- No removal of legacy secrets compatibility routes.

## Architecture

```text
Daemon
+-- plugin host
|   +-- manifest validator
|   +-- registry store
|   +-- lifecycle state
|   +-- capability grants
|   +-- surface metadata registry
|   +-- prompt contribution registry
|   +-- health/status diagnostics
|
+-- bundled core plugins
|   +-- signet.secrets
|
+-- existing API/CLI/MCP/dashboard/connectors
    +-- continue calling existing compatibility surfaces
    +-- can read plugin status/metadata where useful
```

V1 does not make every Signet surface dynamically plugin-rendered. Instead, it
creates the host and metadata contract those surfaces will later consume.
Existing first-party surfaces remain hand-wired where necessary, but they are
associated with the plugin that owns them.

## Plugin Manifest Contract

V1 manifests are data contracts, not arbitrary execution permissions.

Required fields:

```ts
interface PluginManifestV1 {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly publisher: string;
  readonly description: string;
  readonly runtime: PluginRuntimeV1;
  readonly compatibility: PluginCompatibilityV1;
  readonly trustTier: PluginTrustTier;
  readonly capabilities: readonly string[];
  readonly surfaces: PluginSurfaceDeclarationsV1;
  readonly marketplace?: PluginMarketplaceMetadataV1;
  readonly docs: PluginDocsMetadataV1;
}
```

Runtime in V1:

```ts
interface PluginRuntimeV1 {
  readonly language: "typescript" | "rust";
  readonly kind: "bundled-module" | "sidecar" | "wasi";
  readonly entry?: string;
  readonly protocol?: string;
}
```

V1 only executes:

```text
language=typescript
kind=bundled-module
trustTier=core
```

Rust, sidecar, and WASI manifest fields are accepted for forward-compatible
metadata and status reporting, but those plugins enter `blocked` with an
unsupported-runtime reason until later specs implement execution.

Validation rules:

1. `id` is stable and globally unique.
2. `version` is SemVer.
3. `publisher` is required.
4. `compatibility.signet` and `compatibility.pluginApi` are required.
5. Every declared surface must map to at least one declared capability.
6. Every declared capability must have docs metadata.
7. Only Signet-owned bundled metadata can mark a plugin as `trustTier=core`.
8. Unsupported runtimes are recorded but not started.

## Registry and Persistence Contract

The daemon persists plugin state. The implementation may use SQLite or a JSON
file in V1, but it must expose the same logical fields.

Logical record:

```ts
interface PluginRegistryRecordV1 {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly publisher: string;
  readonly source: "bundled" | "local" | "marketplace";
  readonly trustTier: "core" | "verified" | "community" | "local-dev";
  readonly enabled: boolean;
  readonly state: "installed" | "blocked" | "active" | "degraded" | "disabled";
  readonly stateReason?: string;
  readonly grantedCapabilities: readonly string[];
  readonly pendingCapabilities: readonly string[];
  readonly surfaces: PluginSurfaceSummaryV1;
  readonly health?: PluginHealthV1;
  readonly installedAt: string;
  readonly updatedAt: string;
}
```

Persistence rules:

1. Bundled core plugins are discovered on daemon startup.
2. Discovery is idempotent.
3. Removing a bundled plugin from the binary marks it unavailable; it does not
   delete plugin-owned user data.
4. Disabled plugins do not contribute prompts or active surface metadata.
5. Blocked plugins expose a clear `stateReason`.
6. Degraded plugins remain registered and visible in diagnostics.

## Lifecycle Contract

V1 states:

```text
installed -> blocked | disabled | active -> degraded
```

Rules:

1. Unsupported runtime means `blocked`.
2. Missing dependency means `blocked`.
3. Health failure means `degraded`.
4. User/admin disable means `disabled`.
5. `disabled` removes prompt contributions and active surface metadata.
6. `degraded` does not crash the daemon.
7. Core plugins may be non-removable but can still report degraded/disabled
   where safe.

## Capability and Grant Contract

Capabilities are declared by a manifest and granted by host policy.

For V1:

- bundled core plugins may receive bundled grants,
- unsupported plugins receive no grants,
- marketplace/local installs are metadata-only and cannot execute,
- capability checks are enforced for plugin-owned daemon routes where the host
  mounts them,
- compatibility routes may continue using existing auth while recording their
  owning plugin in diagnostics.

Required `signet.secrets` capabilities:

```text
secrets:list
secrets:write
secrets:delete
secrets:exec
secrets:providers:list
secrets:providers:configure
prompt:contribute:user-prompt-submit
mcp:tool
cli:command
dashboard:panel
sdk:client
connector:capability
```

The grant model must distinguish:

```text
declaredCapabilities != grantedCapabilities
```

Even for bundled plugins, diagnostics should show both.

## Surface Metadata Registry

V1 stores and exposes surface metadata. It does not require every consumer to be
fully dynamic yet.

Surface metadata includes:

```ts
interface PluginSurfaceSummaryV1 {
  readonly daemonRoutes: readonly PluginRouteSummaryV1[];
  readonly cliCommands: readonly PluginCommandSummaryV1[];
  readonly mcpTools: readonly PluginToolSummaryV1[];
  readonly dashboardPanels: readonly PluginDashboardSummaryV1[];
  readonly sdkClients: readonly PluginSdkSummaryV1[];
  readonly connectorCapabilities: readonly PluginConnectorSummaryV1[];
  readonly promptContributions: readonly PluginPromptSummaryV1[];
}
```

Rules:

1. Disabled plugins have no active surface metadata.
2. Blocked plugins can show planned surfaces but not active surfaces.
3. Existing first-party CLI/MCP/dashboard surfaces may remain hand-wired but
   should be represented in metadata under `signet.secrets`.
4. Surface metadata includes docs/help text.
5. Surface metadata never includes secret values or provider tokens.

## Prompt Contribution Contract

V1 supports static prompt contributions from bundled core plugins.

Contribution shape:

```ts
interface PromptContributionV1 {
  readonly id: string;
  readonly pluginId: string;
  readonly target: "system" | "session-start" | "user-prompt-submit";
  readonly mode: "append" | "context";
  readonly priority: number;
  readonly maxTokens: number;
  readonly content: string;
}
```

Ordering bands:

| Priority band | Owner |
|---|---|
| 0-99 | Signet core invariants |
| 100-199 | user identity |
| 200-299 | runtime/connectors |
| 300-399 | memory |
| 400-499 | plugin advisory context |

Rules:

1. V1 plugin contributions default to `400-499`.
2. Contributions are append/context only.
3. Contributions cannot suppress or replace user identity files.
4. Contributions are clipped to `maxTokens` before global prompt clipping.
5. Prompt diagnostics list included and excluded contributions.
6. Disabling the owning plugin removes the contribution without daemon restart
   if the prompt registry is re-read at request time, or after daemon restart if
   V1 implementation chooses startup-only registry loading. The chosen behavior
   must be documented.

Required Secrets contribution:

```text
When the user provides credentials or a task requires reusable credentials,
prefer storing them in Signet Secrets rather than chat, memory, logs, or source
files. Use secret_exec or provider-backed secret references when commands need
credentials.
```

## Plugin Diagnostics API

V1 adds daemon diagnostics endpoints. Exact paths may be adjusted to match route
organization, but the response contracts must be stable.

Required endpoints:

```text
GET /api/plugins
GET /api/plugins/:id
GET /api/plugins/:id/diagnostics
GET /api/plugins/prompt-contributions
```

`GET /api/plugins` response:

```ts
interface PluginListResponseV1 {
  readonly plugins: readonly PluginRegistryRecordV1[];
}
```

`GET /api/plugins/prompt-contributions` response:

```ts
interface PromptContributionListResponseV1 {
  readonly contributions: readonly PromptContributionV1[];
  readonly activeCount: number;
}
```

Rules:

1. Diagnostics never include raw secret values.
2. Diagnostics identify disabled/blocked/degraded reasons.
3. Diagnostics identify active prompt contributors by plugin ID.
4. Diagnostics identify compatibility routes owned by plugins.

## Secrets Plugin V1

`signet.secrets` is a bundled privileged core plugin.

It owns metadata for:

- `/api/secrets/*` routes,
- `signet secret` CLI commands,
- Signet MCP secret tools,
- dashboard Secrets settings panel,
- SDK secret helpers,
- connector-visible secret capabilities,
- Secrets prompt contribution.

V1 implementation may keep route/controller code in its current package layout
if the plugin host records `signet.secrets` as the owner. The important V1
change is the capability boundary and local provider extraction, not a cosmetic
file move.

## Local Secrets Provider Extraction

The current local encrypted store becomes a provider implementation under
`signet.secrets`.

Provider interface:

```ts
interface LocalSecretProviderV1 {
  readonly id: "local";
  list(ctx: SecretContextV1): Promise<readonly SecretDescriptorV1[]>;
  put(name: string, value: string, ctx: SecretContextV1): Promise<void>;
  delete(name: string, ctx: SecretContextV1): Promise<boolean>;
  resolve(ref: SecretRefV1, ctx: SecretContextV1): Promise<ResolvedSecretV1>;
  health(ctx: SecretContextV1): Promise<SecretProviderHealthV1>;
}
```

Compatibility invariant:

```text
Existing $SIGNET_WORKSPACE/.secrets/secrets.enc files remain valid without
migration, re-encryption, relocation, or user action.
```

V1 must preserve:

```text
file:   $SIGNET_WORKSPACE/.secrets/secrets.enc
format: version 1 JSON wrapper with per-secret ciphertext
crypto: libsodium secretbox
key:    BLAKE2b-256 of signet:secrets:{machine-id}
```

Rules:

1. Startup must not rewrite `secrets.enc`.
2. Listing secrets must not decrypt every value unless necessary.
3. Resolve happens only inside the daemon/plugin/provider boundary.
4. Command execution redacts resolved values from stdout/stderr.
5. Corrupt or machine-mismatched stores fail clearly and are never overwritten
   automatically.
6. Writes may update `secrets.enc` using the existing format.
7. Existing bare names keep working as local references.

## Secrets Compatibility Routes

Existing routes remain available:

```text
GET    /api/secrets
POST   /api/secrets/:name
DELETE /api/secrets/:name
POST   /api/secrets/exec
POST   /api/secrets/:name/exec
GET    /api/secrets/1password/status
POST   /api/secrets/1password/connect
DELETE /api/secrets/1password/connect
GET    /api/secrets/1password/vaults
POST   /api/secrets/1password/import
```

V1 does not need to convert 1Password into a provider, but it must not regress
1Password behavior. If 1Password remains on the current implementation path, the
plugin diagnostics should mark it as compatibility-owned by `signet.secrets` and
future-provider pending.

## Secret Reference and Alias V1

V1 must support:

```text
OPENAI_API_KEY == local://OPENAI_API_KEY
```

Provider-qualified syntax for future providers may be accepted in parsers, but
only `local://` is required to resolve in V1.

Resolution order in V1:

1. `local://NAME`
2. bare `NAME` as local compatibility lookup

User-defined aliases may be deferred. If implemented in V1, they must follow the
broader planning spec rules: provider-qualified target, audit event, and loop
rejection.

## Audit Events V1

V1 must emit audit or structured diagnostic events for:

```text
plugin.discovered
plugin.enabled
plugin.disabled
plugin.blocked
plugin.degraded
plugin.health_failed
prompt.contribution_added
prompt.contribution_removed
secret.listed
secret.stored
secret.deleted
secret.resolved_for_exec
secret.exec_started
secret.exec_completed
```

Rules:

1. Secret values are never logged.
2. Command stdout/stderr are not audit payloads.
3. Event payloads include plugin ID, timestamp, result, and agent scope where
   available.
4. Secret names may be included only where current API behavior already exposes
   them or policy allows them.

## Rollback and Degraded Mode

V1 rollback depends on not rewriting user data.

Rules:

1. The plugin host migration does not rewrite `secrets.enc`.
2. If plugin registry loading fails, the daemon should still be able to mount
   existing secrets routes through the local provider compatibility path.
3. If `signet.secrets` is degraded, diagnostics must say whether local secrets
   are available, unavailable, or blocked by key mismatch/corruption.
4. If prompt contribution loading fails, prompt-submit continues without plugin
   contributions and records degraded diagnostics.
5. Disabling `signet.secrets` removes prompt guidance and connector/MCP
   advertising, but must not delete stored secrets.

## Implementation Phases

### Phase 1: Host and Registry

- Add manifest types and validation.
- Add plugin registry persistence.
- Discover bundled core plugins at startup.
- Add `/api/plugins` diagnostics.
- Add lifecycle states and health status.

### Phase 2: Prompt and Surface Metadata

- Add prompt contribution registry.
- Add prompt contribution diagnostics.
- Add surface metadata registry.
- Represent existing Secrets CLI/MCP/dashboard/SDK/connectors in metadata.

### Phase 3: Secrets Plugin Metadata

- Register `signet.secrets` as bundled core plugin.
- Associate existing secrets routes and surfaces with `signet.secrets`.
- Add Secrets prompt contribution.
- Add enable/disable behavior for prompt and advertised surfaces.

### Phase 4: Local Provider Extraction

- Extract current local secret store behind provider interface.
- Preserve existing encryption and file format.
- Add compatibility fixtures for existing `secrets.enc`.
- Keep all existing secrets routes passing.

### Phase 5: Guardrails and Docs

- Add audit events.
- Add docs/help metadata.
- Add CLI setup selection for bundled core plugins. Existing installs default
  `signet.secrets` to enabled; new interactive installs explain Signet Secrets
  and ask whether to enable it.
- Add degraded-mode tests.
- Update `docs/API.md`, `docs/SECRETS.md`, `docs/SDK.md`, `docs/MCP.md`, and
  dashboard docs where behavior or ownership changed.

## Validation and Tests

Required tests:

- manifest validation rejects invalid IDs, versions, missing docs metadata, and
  unsupported active runtimes.
- bundled `signet.secrets` is discovered idempotently.
- `/api/plugins` lists `signet.secrets` with expected state, capabilities,
  grants, and surfaces.
- disabling `signet.secrets` removes its prompt contribution.
- prompt diagnostics list active contributions with plugin provenance.
- prompt contribution clipping respects `maxTokens`.
- plugin health failure reports degraded state without crashing daemon.
- unsupported Rust sidecar manifest enters blocked state in V1.
- v1 `secrets.enc` fixture remains readable by local provider.
- startup does not rewrite existing `secrets.enc`.
- storing a new local secret writes the existing format.
- corrupt `secrets.enc` fails clearly and is not overwritten.
- machine-mismatched `secrets.enc` fails clearly and is not overwritten.
- `/api/secrets/*` compatibility routes preserve existing behavior.
- `execWithSecrets` injects resolved local values and redacts stdout/stderr.
- ordinary API/MCP/dashboard/SDK responses do not include raw secret values.
- 1Password compatibility routes do not regress.
- setup registry tests prove new installs can persist `signet.secrets` enabled
  or disabled without disturbing unrelated plugin registry entries.

Required local commands before PR:

```bash
bun test packages/daemon/src/secrets*.test.ts
bun test packages/daemon/src/plugin*.test.ts
bun run typecheck
bun run lint
```

The exact test filenames may differ, but the PR must include regression tests
for the contracts above.

## Documentation Updates

When implemented, update:

- `docs/API.md` for plugin diagnostics routes and secrets ownership notes.
- `docs/SECRETS.md` for `signet.secrets`, local provider compatibility, and the
  no-raw-secret-read invariant.
- `docs/SDK.md` to remove or correct any implication that ordinary SDK callers
  can retrieve raw secret values.
- `docs/MCP.md` to state that secret tools use injection/listing only and are
  plugin-owned.
- `docs/DASHBOARD.md` to describe plugin-owned Secrets settings and provider
  status.
- `docs/specs/INDEX.md` and `docs/specs/dependencies.yaml` when status changes.

## Success Criteria

This spec is complete when:

1. `signet.secrets` appears as a bundled core plugin in daemon diagnostics.
2. Existing secrets routes, CLI, MCP, dashboard, and SDK behavior continue to
   work.
3. Existing local `secrets.enc` fixtures pass without migration.
4. Secrets prompt contribution appears only when `signet.secrets` is enabled.
5. Plugin registry and surface metadata are visible through diagnostics.
6. Unsupported Rust/sidecar plugin metadata is blocked cleanly rather than
   executed or ignored silently.
7. Tests prove secret values are not exposed through ordinary responses.
8. Docs describe the plugin-owned Secrets architecture and compatibility
   guarantees.
9. CLI setup enables `signet.secrets` by default for existing installs, prompts
   new interactive installs in a Core plugins section, and supports
   non-interactive opt-out without deleting stored secrets.
