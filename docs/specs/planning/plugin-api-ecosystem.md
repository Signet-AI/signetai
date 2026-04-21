---
title: "Plugin SDK, Core Capability Plugins, and Secrets Provider Architecture"
id: plugin-api-ecosystem
status: planning
informed_by:
  - "docs/research/technical/RESEARCH-PLUGIN-SDK-SECRETS.md"
section: "Platform"
depends_on:
  - "signet-runtime"
success_criteria:
  - "Plugin SDK supports first-party TypeScript plugins and managed Rust sidecar plugins through one manifest and capability model"
  - "Plugins can declare daemon, CLI, MCP, dashboard, SDK, connector, and prompt-lifecycle contributions from one host-mediated contract"
  - "Signet Secrets can run as a privileged core plugin while preserving existing local encrypted secrets without re-encryption or user action"
  - "Secret providers can register modular backends such as local, 1Password, Bitwarden, Vault, cloud secret managers, and environment resolvers"
  - "Plugin manifests are marketplace-ready without requiring full marketplace install support in the first implementation"
scope_boundary: "Plugin host, SDK contracts, manifests, language runtime model, cross-surface contributions, prompt contributions, and the Signet Secrets core plugin/provider model. Includes marketplace-ready metadata but not public marketplace install/review/payment flows. Includes provider contracts but not full implementation of every provider."
draft_quality: "user-shaped planning draft; not approved for implementation"
---

# Plugin SDK, Core Capability Plugins, and Secrets Provider Architecture

*A cross-surface plugin architecture for Signet capabilities, using Secrets as
the reference privileged core plugin.*

---

## Problem Statement

Signet's capabilities currently grow through first-party daemon routes, CLI
commands, MCP tools, dashboard panels, connector behavior, prompt assembly, and
SDK helpers. Each surface is wired by hand. That works while the surface area is
small, but it does not scale to a marketplace, Rust plugins, third-party
providers, or capability modules that should appear consistently across the
daemon, CLI, MCP, dashboard, connectors, and SDK.

Secrets is the forcing function. Signet already has a local encrypted secret
store, 1Password support, MCP tools, CLI commands, dashboard UI, daemon routes,
and SDK helpers. The clean architecture is to make Secrets a privileged core
plugin and make individual vault backends modular providers under that plugin.

The plugin system must therefore solve more than external memory sync. It must
define how Signet capabilities are installed, enabled, disabled, authorized,
surfaced, audited, and composed into prompts.

---

## Design Thesis

Plugins declare capabilities and surface contributions. The Signet host decides
where those contributions appear, how they are authorized, and how they compose
with user-owned context.

Secrets is the reference plugin because it exercises the hardest constraints:

- privileged data
- provider modularity
- backward-compatible user data
- prompt contributions
- CLI/MCP/dashboard parity
- connector-visible tool availability
- TypeScript and Rust plugin support
- marketplace-ready metadata
- audit and redaction

---

## Goals

1. Define a host-mediated plugin contract that can contribute to daemon, CLI,
   MCP, dashboard, SDK, connector, and prompt lifecycle surfaces.
2. Support both TypeScript and Rust plugins without making native dynamic
   loading the daemon ABI.
3. Keep marketplace installation out of v1 implementation while making plugin
   identity, manifests, signatures/checksums, compatibility, and dependencies
   marketplace-ready.
4. Make prompt contributions declarative, bounded, visible, and reversible when
   a plugin is disabled.
5. Convert Signet Secrets into a privileged core plugin without changing the
   existing local encrypted store.
6. Define a modular secret-provider contract for local, 1Password, Bitwarden,
   Vault, cloud secret managers, environment resolvers, and future providers.
7. Preserve existing `/api/secrets/*`, CLI, MCP, dashboard, and SDK behavior
   through compatibility surfaces during migration.

## Non-Goals

- Public marketplace browsing, review, payment, ranking, or hosted
  distribution in the first implementation.
- Running arbitrary marketplace code in-process by default.
- A new memory system.
- A new secrets encryption format.
- A GraphQL plugin API.
- Allowing plugins to silently rewrite user prompts.
- Allowing agents or ordinary plugin tokens to read raw secret values.

---

## Terminology

| Term | Meaning |
|---|---|
| Plugin host | Daemon-owned registry, lifecycle manager, capability enforcer, and surface composer. |
| Plugin SDK | TypeScript package and Rust crate for declaring plugins and implementing the plugin RPC protocol. |
| Core plugin | Privileged first-party plugin shipped with Signet and allowed to run in-process when appropriate. |
| Marketplace plugin | Future installable plugin, out-of-process by default, governed by manifest capabilities and signatures. |
| Capability plugin | Plugin that owns a Signet capability such as secrets, skills, document ingest, or memory import. |
| Provider plugin | Plugin that extends a capability plugin with a backend, for example Bitwarden as a provider for Secrets. |
| Surface contribution | A daemon route, CLI command, MCP tool, dashboard panel, SDK helper, connector capability, or prompt contribution declared by a plugin. |
| Prompt contribution | Declarative, bounded, provenance-tagged text contributed to a prompt lifecycle target. |

---

## Architecture Overview

```text
Signet Plugin Host
  registry
  lifecycle
  capability policy
  event bus
  prompt contribution composer
  surface contribution registry
  health/status reporting
  plugin storage
  marketplace-ready manifest validation

Core Capability Plugins
  signet.secrets
  signet.skills
  future signet.documents
  future signet.memory-import

Provider Plugins
  signet.secret-provider.local
  signet.secret-provider.onepassword
  signet.secret-provider.bitwarden
  signet.secret-provider.vault
```

The daemon remains the trust boundary. Plugins do not independently decide how
their contributions are exposed to agents or users. They declare contributions;
the host mounts and mediates them.

---

## Plugin Manifest

Every plugin has a manifest. TypeScript plugins may export this through
`definePlugin()`. Rust plugins expose the same manifest through the plugin RPC
handshake.

```ts
export default definePlugin({
  id: "signet.secret-provider.bitwarden",
  name: "Bitwarden Secret Provider",
  version: "0.1.0",
  publisher: "signetai",
  description: "Registers Bitwarden as a provider for Signet Secrets.",

  runtime: {
    language: "rust",
    kind: "sidecar",
    command: "signet-secret-provider-bitwarden",
    protocol: "signet-plugin-rpc@1",
  },

  compatibility: {
    signet: ">=0.100.0 <1.0.0",
    pluginApi: "1.x",
  },

  marketplace: {
    categories: ["secrets", "security"],
    license: "Apache-2.0",
    repository: "https://github.com/signetai/signetai",
    homepage: "https://signet.sh",
    checksum: null,
    signature: null,
  },

  extends: ["signet.secrets/providers"],

  capabilities: [
    "secrets:providers:register",
    "secrets:list",
    "secrets:resolve",
  ],

  surfaces: {
    daemon: true,
    cli: true,
    mcp: false,
    dashboard: true,
    prompt: false,
    sdk: false,
    connectors: true,
  },
});
```

Manifest validation rules:

1. `id` is globally stable and reverse-DNS-like or `signet.*`.
2. `version` is SemVer.
3. `runtime.protocol` is required for sidecar plugins.
4. Marketplace fields are allowed before marketplace installation exists.
5. Capabilities must be declared before any surface can request them.
6. Provider plugins must declare `extends`.
7. Core plugins may be marked privileged only by Signet-owned package metadata,
   not by self-declaration alone.

---

## Runtime Model

### TypeScript Plugins

TypeScript plugins can run in two modes:

1. **module**: trusted first-party plugin loaded in-process.
2. **sidecar**: plugin process managed by the daemon using the same plugin RPC
   protocol as Rust plugins.

In-process module loading is reserved for bundled core plugins or explicitly
trusted local development.

### Rust Plugins

Rust plugins run as managed sidecars in v1. The daemon starts the plugin
process, performs a handshake, validates the manifest, then communicates over a
versioned JSON-RPC protocol.

Rust plugins should not be loaded into the daemon as native dynamic libraries in
v1. Dynamic loading makes the process ABI the plugin ABI and weakens failure
isolation.

### Future WASI Support

The manifest leaves room for:

```json
{ "runtime": { "language": "rust", "kind": "wasi" } }
```

WASI is not required for v1, but the protocol should not preclude it.

---

## Plugin Lifecycle

The plugin host owns lifecycle state:

```text
discovered -> installed -> blocked -> enabled -> active -> degraded -> disabled -> removed
```

Lifecycle hooks:

```ts
interface SignetPlugin {
  manifest(): PluginManifest;
  install?(ctx: InstallContext): Promise<PluginInstallResult>;
  enable?(ctx: EnableContext): Promise<void>;
  disable?(ctx: DisableContext): Promise<void>;
  uninstall?(ctx: UninstallContext): Promise<void>;
  health?(ctx: HealthContext): Promise<PluginHealth>;
}
```

Rules:

1. Install must be idempotent.
2. Enable must not mutate user data irreversibly.
3. Disable removes prompt, CLI, MCP, dashboard, connector, and SDK
   contributions from active registries.
4. Uninstall must not delete user data without explicit user confirmation.
5. Missing dependencies or disabled extension parents put a plugin in `blocked`.
6. Health failures put a plugin in `degraded` rather than crashing the daemon.
7. Core plugins can be non-removable but still disabled where safe.

---

## Capability Policy

Capabilities are strings with hierarchical semantics:

```text
secrets:list
secrets:write
secrets:delete
secrets:exec
secrets:providers:list
secrets:providers:configure
memory:read
memory:write
events:subscribe
prompt:contribute:system
prompt:contribute:user-prompt-submit
dashboard:panel
cli:command
mcp:tool
```

The auth middleware enforces capabilities before dispatch. A plugin token may
not call routes, tools, or commands outside its declared and granted
capabilities.

Rules:

1. Declaring a capability is not the same as being granted it.
2. User/admin policy grants capabilities per plugin and per agent scope.
3. Cross-agent access requires explicit cross-agent capability.
4. Plugin tokens cannot grant themselves new capabilities.
5. Core plugins can receive privileged grants only from bundled Signet policy.

---

## Cross-Surface Contributions

A plugin may contribute to multiple surfaces from one manifest.

### Daemon

Plugins may declare HTTP routes or RPC handlers. The host mounts routes under a
plugin-aware policy boundary.

```ts
daemon: {
  routes: createRoutes,
  migrations: migrations,
  health: checkHealth,
  policy: policy,
}
```

### CLI

Plugins may declare commands. The CLI renders help text from registered command
metadata. Command execution still goes through daemon policy unless the command
is purely local and explicitly marked as such.

```ts
cli: {
  commands: [
    {
      path: ["secret", "provider", "list"],
      summary: "List configured secret providers",
      capability: "secrets:providers:list",
    },
  ],
}
```

### MCP

Plugins may expose MCP tools. Tool schemas and permission descriptions are
generated from plugin metadata.

Secrets tools remain value-safe:

- `secret_list`
- `secret_exec`
- provider status tools

No ordinary MCP tool returns raw secret values.

### Dashboard

Plugins may contribute panels, settings pages, status cards, and provider forms.
The dashboard should render plugin surfaces from daemon-provided metadata.

Secrets should appear as:

```text
Settings
  Secrets
    Providers
      Local
      1Password
      Bitwarden
```

Provider plugins should extend the Secrets UI rather than appearing as
unrelated top-level settings.

### SDK

Plugins may expose typed SDK helpers generated from plugin metadata. The stable
boundary is still daemon API and plugin RPC, not direct imports of arbitrary
plugin internals.

### Connectors

Connectors can query daemon capability state to decide which tools and prompt
fragments to expose to a harness. If Secrets is disabled, connectors should not
advertise secret tools or secret-specific prompt guidance.

---

## Prompt Contribution Contract

Plugins may append bounded, auditable context to prompt lifecycle targets.
They may not invisibly rewrite the user's prompt.

Targets:

```text
system
session-start
user-prompt-submit
pre-compaction
compaction-complete
session-end
```

Contribution shape:

```ts
interface PromptContribution {
  readonly id: string;
  readonly pluginId: string;
  readonly target: PromptTarget;
  readonly mode: "append" | "context";
  readonly priority: number;
  readonly maxTokens: number;
  readonly enabledWhen?: PromptCondition;
  readonly content: string;
}
```

Rules:

1. Contributions are append-only or context-block additions.
2. The daemon owns ordering and token clipping.
3. Each contribution is provenance-tagged.
4. Dashboard and diagnostics surfaces list active prompt contributors.
5. Disabling a plugin removes its contributions immediately.
6. Plugin prompt contributions are scoped by agent and connector where
   applicable.

Secrets plugin example:

```text
When credentials, API keys, tokens, or private configuration are needed,
store them in Signet Secrets. Do not paste secrets into memory, source files,
logs, or chat. Use secret_exec or provider-backed secret references when
running commands that require credentials.
```

If the Secrets plugin is disabled, this contribution is not injected.

---

## Marketplace-Ready Constraints

Full marketplace installation is a later milestone, but v1 plugins must be
designed as installable artifacts.

The manifest must include:

- stable ID
- publisher
- version
- runtime language
- runtime protocol
- Signet compatibility range
- capability declarations
- extension points
- dependency list
- license
- repository/homepage metadata
- checksum/signature placeholders

The first implementation may install only bundled/local plugins. It should not
invent a second manifest later for marketplace packages.

Integration with `git-marketplace-monorepo`:

- marketplace review can validate manifest schema
- marketplace review can reject undeclared capabilities
- marketplace review can attach checksums/signatures
- marketplace UI can present surfaces and permissions before install

---

## Signet Secrets Core Plugin

`signet.secrets` is a privileged core plugin. It owns:

- secret references
- provider registry
- local encrypted provider compatibility
- provider configuration
- redaction
- audit events
- exec-with-secrets
- CLI/MCP/dashboard/SDK/connector surfaces
- prompt contributions
- compatibility routes

It does not require every provider to live in the same package.

```text
@signet/plugin-secrets
  core capability

providers/
  local
  onepassword
  bitwarden
  vault
  aws-secrets-manager
  gcp-secret-manager
  azure-key-vault
  env
  pass
```

### Secret Provider Contract

```ts
interface SecretProvider {
  readonly id: string;
  readonly name: string;
  readonly capabilities: readonly SecretProviderCapability[];

  list(ctx: SecretContext): Promise<readonly SecretDescriptor[]>;

  put?(
    ref: SecretRef,
    value: SecretInput,
    ctx: SecretContext,
  ): Promise<SecretWriteResult>;

  delete?(
    ref: SecretRef,
    ctx: SecretContext,
  ): Promise<SecretDeleteResult>;

  resolve(
    ref: SecretRef,
    ctx: SecretContext,
  ): Promise<ResolvedSecret>;

  health?(ctx: SecretContext): Promise<SecretProviderHealth>;
}
```

Provider capabilities:

```text
list
resolve
write
delete
import
export
rotate
health
configure
```

Provider examples:

| Provider | Capabilities |
|---|---|
| local | list, resolve, write, delete, import, export, health |
| 1Password | list, resolve, import, health, configure |
| Bitwarden | list, resolve, import, health, configure |
| HashiCorp Vault | list, resolve, write, delete, rotate, health, configure |
| AWS Secrets Manager | list, resolve, write, delete, rotate, health, configure |
| environment | resolve, health |

### Secret References

Provider-qualified references:

```text
local://OPENAI_API_KEY
op://Private/API Keys/OpenAI
bw://vault/item/field
vault://kv/team/signet/openai
aws-sm://us-east-1/prod/openai
gcp-sm://project/secret/version
azure-kv://vault/secret/version
env://OPENAI_API_KEY
```

Compatibility rule:

```text
OPENAI_API_KEY == local://OPENAI_API_KEY
```

### Secret Value Rules

Secret values do not leave the plugin/provider boundary except through:

1. daemon-owned provider resolution for internal use,
2. exec-with-secrets injection,
3. explicitly human-initiated export with confirmation and audit logging.

Ordinary daemon responses, MCP tools, connectors, and plugin tokens never return
raw secret values.

### Existing Store Preservation

Hard invariant:

> Existing `$SIGNET_WORKSPACE/.secrets/secrets.enc` files remain valid without
> migration, re-encryption, relocation, or user action.

The local provider must adopt the current store in place:

```text
current file:   $SIGNET_WORKSPACE/.secrets/secrets.enc
current format: version 1 JSON wrapper with per-secret ciphertext
current crypto: libsodium secretbox
current key:    BLAKE2b-256 of signet:secrets:{machine-id}
```

The first plugin migration is structural, not cryptographic.

Future store upgrades require:

- explicit user opt-in
- backup before rewrite
- rollback support
- fixture tests for old and new formats

---

## Backward Compatibility

Existing surfaces remain available while internally routing through the plugin
host:

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

Compatibility surfaces should be marked as hosted by `signet.secrets` in
diagnostics. Users should not see a breaking change.

---

## Integration Contracts

### Signet Runtime

The runtime remains stateless at the capability boundary. The daemon owns
memory, hooks, secrets, session state, plugin registry, prompt composition, and
policy enforcement.

### Auth Middleware

Auth must support plugin tokens and capability grants. Plugin-originated
requests are evaluated by both token identity and declared capability.

### Multi-Agent Support

Plugin state, prompt contributions, and provider access are scoped by
`agent_id`. Cross-agent access requires an explicit cross-agent capability and
user/admin grant.

### Dashboard

Dashboard plugin panels are metadata-driven. Provider plugins can extend a
parent plugin's panel region instead of creating unrelated top-level pages.

### MCP

MCP tool availability reflects enabled plugins and granted capabilities. If a
plugin is disabled, its MCP tools disappear.

### Connectors

Connectors query active capabilities and prompt contributions before exposing
tools to a harness. Connector output must not hardcode plugin-specific prompts
when the plugin is disabled.

### Marketplace

Marketplace support depends on this spec's manifest identity, runtime, and
capability model. This spec does not implement public marketplace install.

---


## Threat Model

The plugin system expands Signet's trust boundary. The first implementation must
name what it protects against and what remains out of scope.

| Actor or failure mode | v1 mitigation | Not guaranteed in v1 |
|---|---|---|
| Malicious marketplace plugin | Sidecar-first execution, declared capabilities, user/admin grants, no inherited secrets, plugin storage boundaries. | Full sandboxing or proof the plugin cannot read arbitrary local files. |
| Compromised provider plugin | Provider capability limits, audit events, no raw secret responses, health/degraded state. | Recovery of secrets already exfiltrated by a compromised process. |
| Prompt injection requesting secrets | Secret values are unavailable to ordinary prompts, MCP tools, connectors, and plugin tokens. Secret use happens through injection or daemon-owned resolution. | Detecting every social-engineering attempt in natural language. |
| Rogue connector or harness | Connector-visible tools are derived from active plugin capabilities; disabled plugins remove tools and prompt guidance. | Preventing a harness from misrepresenting user text outside Signet. |
| Confused deputy through MCP | MCP tools map to explicit plugin capabilities and never return raw secret values. | Preventing all misuse of non-secret tools by an already-authorized agent. |
| Plugin update requesting broader permissions | New grants require explicit approval before activation. | Automatic trust in future plugin versions. |
| Dashboard or CLI social engineering | Permission descriptions and docs/help metadata are generated from manifests and capabilities. | Preventing a user from approving a malicious plugin after warnings. |
| Local filesystem attacker | Existing local-first file permissions and encrypted local secrets store remain. | Protection against a fully compromised user account or root/admin attacker. |

Security invariants:

1. Secret values never appear in ordinary daemon, MCP, connector, dashboard, or
   SDK responses.
2. Plugin declarations are not grants.
3. Plugin updates cannot silently expand effective permissions.
4. Prompt contributions are visible, attributable, bounded, and removable.
5. User data is not deleted during disable/uninstall without explicit
   confirmation.

---

## Permission Changes and Plugin Updates

Plugin installation and update flow must distinguish declared capabilities from
granted capabilities.

```text
installed plugin v1 declares:
  secrets:list

plugin update v2 declares:
  secrets:list
  secrets:resolve
  prompt:contribute:system

host result:
  update is downloaded/recorded
  new grants are marked pending
  plugin remains on old grants, disabled, or blocked until approval
```

Rules:

1. New capabilities introduced by an update are pending until approved.
2. Removed capabilities are revoked immediately after update activation.
3. Changed prompt contributions are shown in diff form before activation when
   the plugin is not a bundled core plugin.
4. Marketplace plugins cannot auto-enable new privileged capabilities.
5. Core plugin updates may receive bundled policy grants, but diagnostics still
   record the change.
6. A plugin with pending grants reports `blocked` or `degraded-permissions`, not
   `active`.

---

## Sidecar Process and Storage Policy

Sidecar execution is the default for Rust plugins and future marketplace
plugins. Sidecars are safer than native dynamic loading, but they still need
explicit process rules.

Sidecar defaults:

- no inherited secrets
- explicit environment allowlist
- `cwd` set to the plugin storage directory
- stdout/stderr captured by the daemon
- stdout/stderr redacted before surfacing to users or agents
- startup timeout
- health-check timeout
- restart backoff
- maximum restart rate
- structured exit reason in diagnostics

Storage layout:

```text
$SIGNET_WORKSPACE/plugins/{plugin_id}/
├── manifest.json
├── grants.json
├── state/
├── cache/
├── logs/
└── data/
```

Storage rules:

1. A plugin can read/write only its assigned storage directory unless granted a
   separate file capability.
2. Provider credentials must be stored through `signet.secrets`, not plaintext
   plugin config.
3. Logs must pass through the same redaction layer used for secret execution.
4. Network access policy is declared in the manifest even if v1 only audits it.
5. Sidecar crashes cannot crash the daemon.

---

## Prompt Composition Policy

Prompt contributions are advisory context blocks. They do not override
user-owned identity files or core safety invariants.

Ordering bands:

| Priority band | Owner | Purpose |
|---|---|---|
| 0-99 | Signet core | Non-negotiable runtime and safety invariants. |
| 100-199 | User identity | `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, and user-owned context. |
| 200-299 | Runtime/connectors | Harness-specific formatting and runtime context. |
| 300-399 | Memory | Recalled memories, summaries, and continuity context. |
| 400-499 | Plugins | Advisory plugin context and capability reminders. |

Rules:

1. Plugin prompt contributions default to the `400-499` band.
2. Only bundled core plugins can request a lower priority band.
3. Plugin contributions cannot suppress or replace user identity files.
4. Contributions are clipped independently before global prompt clipping.
5. Diagnostics show final included/excluded prompt contributors.
6. Secrets guidance should be phrased as preference and safety guidance, not an
   unconditional command to save every credential-like string.

Preferred Secrets contribution:

```text
When the user provides credentials or a task requires reusable credentials,
prefer storing them in Signet Secrets rather than chat, memory, logs, or source
files. Use secret_exec or provider-backed secret references when commands need
credentials.
```

---

## Dependencies and Extension Points

Plugins can extend other plugins. Provider plugins are the motivating example:

```text
signet.secret-provider.bitwarden extends signet.secrets/providers
```

Extension-point rules:

1. A parent plugin declares named extension points.
2. A child plugin declares exactly which extension point it extends.
3. If the parent plugin is disabled or missing, the child enters `blocked`.
4. `blocked` means dependency/capability unavailable, not runtime failure.
5. Extension children cannot bypass the parent plugin's policy layer.
6. Parent plugins can reject child registration when the child lacks required
   provider capabilities or compatible protocol versions.

Example extension point:

```ts
extensionPoints: {
  "providers": {
    kind: "secret-provider",
    requiredCapabilities: ["secrets:providers:register"],
  },
}
```

---

## Configuration Schema Convention

Plugins declare configuration schemas so CLI, dashboard, and future marketplace
surfaces can render consistent setup flows.

```ts
config: {
  schema: {
    serverUrl: { type: "string", format: "uri", required: false },
    authMode: { type: "string", enum: ["cli", "token"] },
    token: { type: "secret", target: "signet.secrets" },
  },
}
```

Rules:

1. Secret config fields use `type: "secret"` and are stored through
   `signet.secrets`.
2. Plain plugin config must not contain provider tokens, API keys, passwords, or
   recovery material.
3. Config schema drives dashboard forms, CLI prompts, validation errors, and
   docs/help metadata.
4. Config changes are audited when they affect auth, network destinations, file
   access, prompt contributions, or secret providers.
5. Provider plugins should expose a `test` or `health` action after config.

---

## Audit Events

The plugin host emits structured audit events. Audit events never include raw
secret values. Secret names may be included only when policy allows them;
otherwise events use stable opaque identifiers or counts.

Core event vocabulary:

```text
plugin.discovered
plugin.installed
plugin.enabled
plugin.disabled
plugin.uninstalled
plugin.blocked
plugin.degraded
plugin.permission_requested
plugin.permission_granted
plugin.permission_denied
plugin.updated
plugin.health_failed
plugin.sidecar_started
plugin.sidecar_exited
prompt.contribution_added
prompt.contribution_removed
secret.provider_registered
secret.provider_degraded
secret.listed
secret.stored
secret.deleted
secret.resolved_for_exec
secret.exec_started
secret.exec_completed
secret.import_started
secret.import_completed
```

Rules:

1. Audit events include plugin ID, agent scope, actor, timestamp, and result.
2. Secret values are never logged.
3. Command stdout/stderr are not audit payloads.
4. Provider errors are summarized without embedding secrets or tokens.
5. Dashboard diagnostics and future marketplace trust signals can consume the
   same event stream.

---

## API and Protocol Versioning

The plugin manifest has separate version fields for the plugin package, Signet
compatibility, and plugin protocol compatibility.

```ts
compatibility: {
  signet: ">=0.100.0 <1.0.0",
  pluginApi: "1.x",
  rpcProtocol: "signet-plugin-rpc@1",
}
```

Version rules:

1. `pluginApi: 1.x` permits additive manifest fields and additive RPC methods.
2. Removing fields or changing RPC request/response shapes requires a new major
   plugin API or RPC protocol.
3. A plugin requiring a newer Signet version enters `blocked` with a clear
   message.
4. A plugin using an unknown protocol is not started.
5. A plugin using an older supported protocol may run through compatibility
   shims.
6. Compatibility failures are visible in CLI and dashboard plugin status.

---

## Marketplace Trust Tiers

Marketplace implementation is out of scope for v1, but trust tiers must be part
of the model now.

| Tier | Source | Runtime default | Policy |
|---|---|---|---|
| core | shipped by Signet | in-process or sidecar | privileged bundled grants allowed |
| verified | reviewed/signed marketplace plugin | sidecar | explicit user/admin grants |
| community | installable marketplace plugin | sidecar | stronger warnings and no privileged grants |
| local-dev | local path | sidecar unless developer mode permits module loading | explicit developer-mode warning |

Rules:

1. Marketplace plugins are sidecar-only by default.
2. Trust tier affects default grants, warning text, and update behavior.
3. Trust tier never bypasses capability checks.
4. Local development can be convenient, but must not set marketplace defaults.

---

## Secret Alias and Reference Collision Rules

Provider-qualified references are unambiguous. Bare names are compatibility
aliases for the local provider unless a user-created alias overrides them.

```text
OPENAI_API_KEY == local://OPENAI_API_KEY
op://Private/API Keys/OpenAI
bw://vault/item/field
```

Aliases allow stable names to point at provider-backed refs:

```text
OPENAI_API_KEY -> op://Private/API Keys/OpenAI
ANTHROPIC_API_KEY -> bw://work/Anthropic/API Key
```

Resolution order:

1. exact provider-qualified reference
2. user-defined alias
3. local provider bare-name compatibility lookup

Rules:

1. Provider-qualified references cannot collide.
2. Bare names must validate with the existing secret-name rules.
3. Alias targets must be provider-qualified references.
4. Alias changes are audited.
5. Alias loops are rejected.
6. Listing secrets should identify provider and alias status without exposing
   values.

---

## Rollback and Degraded Mode

The migration to plugin-hosted Secrets must be reversible at the user-data
level. Because the local provider adopts `secrets.enc` in place, rollback does
not require decrypting or rewriting secrets.

Rules:

1. The first migration does not rewrite `secrets.enc`.
2. If the plugin host fails, Signet should mount the local Secrets provider
   through a compatibility fallback for at least one release cycle.
3. If a provider plugin fails, the Secrets core plugin remains active with the
   failing provider marked degraded.
4. If `signet.secrets` is disabled, provider plugins enter `blocked` and
   connector/MCP/CLI prompt surfaces are removed.
5. Corrupt or machine-mismatched stores are never overwritten automatically.
6. Any future store upgrade requires backup, opt-in, and rollback instructions.

---

## Documentation and Help Metadata

Plugins provide docs/help metadata once and the host reuses it across CLI,
dashboard, MCP, SDK docs, diagnostics, and future marketplace listings.

```ts
docs: {
  summary: "Registers Bitwarden as a Signet Secrets provider.",
  permissions: {
    "secrets:list": "List secret names and metadata, never values.",
    "secrets:resolve": "Resolve values only inside the Secrets plugin boundary.",
  },
  commands: {
    "secret provider bitwarden connect": "Connect Bitwarden to Signet Secrets.",
  },
}
```

Rules:

1. Every capability has a human-readable permission description.
2. Every CLI command has summary/help text.
3. Every MCP tool has a description and safety note.
4. Dashboard permission prompts use the same metadata as CLI approval prompts.
5. Marketplace listing pages can be generated from the same manifest metadata.

---
## Rollout Plan

### Phase 1: Plugin Host Skeleton

- Add plugin manifest schema.
- Add plugin registry and lifecycle state.
- Add capability declaration/grant model.
- Support bundled TypeScript core plugins.
- Add diagnostics endpoint for loaded plugins and active surfaces.

### Phase 2: Cross-Surface Registries

- Add daemon route contribution registry.
- Add CLI command contribution metadata.
- Add MCP tool contribution metadata.
- Add dashboard contribution metadata.
- Add connector capability discovery.
- Add prompt contribution registry and diagnostics.

### Phase 3: Sidecar Runtime Protocol

- Define `signet-plugin-rpc@1`.
- Add TypeScript sidecar SDK support.
- Add Rust `signet-plugin-sdk` crate.
- Add managed process lifecycle and health checks.
- Add sample Rust plugin.

### Phase 4: Secrets Core Plugin Extraction

- Extract existing secrets implementation behind a provider interface.
- Mount existing `/api/secrets/*` routes through `signet.secrets`.
- Preserve local encrypted store in place.
- Register CLI/MCP/dashboard surfaces through plugin metadata.
- Add Secrets prompt contribution.
- Add compatibility diagnostics.

### Phase 5: Secret Providers

- Register local provider.
- Convert 1Password to provider.
- Add Bitwarden provider as the first non-existing provider target.
- Document provider reference syntax.
- Add provider health/status UI.

### Phase 6: Marketplace Readiness

- Validate marketplace metadata in manifests.
- Add local install from plugin package path.
- Add checksum/signature fields to install metadata.
- Defer public marketplace browsing/install to `git-marketplace-monorepo`.

---

## Validation and Tests

Plugin host:

- manifest schema rejects invalid IDs, versions, protocols, and capabilities.
- enabling a plugin activates its declared surfaces.
- disabling a plugin removes daemon, CLI, MCP, dashboard, connector, and prompt
  contributions.
- plugin health failure enters degraded mode without crashing daemon.
- plugin capability denial returns structured 403.

TypeScript/Rust:

- bundled TypeScript plugin loads and exposes a health check.
- TypeScript sidecar completes handshake over plugin RPC.
- Rust sidecar completes handshake over plugin RPC.
- incompatible plugin protocol fails with clear degraded status.

Prompt contributions:

- enabled plugin contribution appears in session-start or prompt-submit output.
- disabled plugin contribution disappears.
- contributions are clipped to token budget.
- diagnostics list active contributors with plugin provenance.

Secrets:

- v1 `secrets.enc` fixture remains readable by local provider.
- plugin-written local secret remains in the existing file format for v1.
- command execution injects secrets and redacts stdout/stderr.
- secret values never appear in ordinary API, MCP, dashboard, connector, or SDK
  responses.
- corrupt or machine-mismatched `secrets.enc` fails clearly and is never
  overwritten.
- 1Password provider preserves current behavior.
- Bitwarden provider can register and report health even before full feature
  parity.

Marketplace readiness:

- manifest includes publisher, license, repository, compatibility, checksum,
  signature, and category fields.
- marketplace metadata is optional for bundled development plugins but required
  for installable packages.

Security and permissions:

- plugin update requesting new capabilities enters pending/blocked state until
  approval.
- plugin declarations without grants cannot access protected routes, tools, or
  prompt targets.
- threat-model invariants are covered by regression tests for secret value
  exposure, permission escalation, and prompt contribution visibility.

Sidecar policy:

- sidecar process starts with no inherited secrets and an explicit env
  allowlist.
- sidecar `cwd` is the plugin storage directory.
- sidecar crash produces degraded status and does not crash the daemon.
- plugin logs pass through redaction before surfacing.

Dependencies and config:

- child plugin enters `blocked` when its parent extension point is disabled or
  missing.
- config schema rejects secret-looking values in plaintext config fields.
- `type: "secret"` config fields are routed through `signet.secrets`.

Audit, versioning, and docs:

- audit events are emitted for install, enable, disable, permission changes,
  prompt contribution changes, provider registration, and secret exec.
- incompatible plugin API or RPC protocol reports blocked/degraded status with
  a clear message.
- generated CLI, MCP, dashboard, and future marketplace help text uses plugin
  docs metadata.

Secret aliases and rollback:

- alias resolution follows provider-qualified ref, user alias, local bare-name
  compatibility order.
- alias loops are rejected.
- plugin-hosted Secrets can fall back to the local compatibility provider for
  at least one release cycle.

---

## Success Criteria

1. A bundled TypeScript plugin can declare daemon, CLI, MCP, dashboard,
   connector, SDK, and prompt surfaces from one manifest.
2. A Rust sidecar plugin can register through the same manifest and protocol
   model.
3. Disabling a plugin removes its prompt contribution and user-facing tools
   without daemon restart.
4. `signet.secrets` hosts existing secrets behavior without changing existing
   user data.
5. Existing `secrets.enc` files pass compatibility fixtures.
6. Secret providers can be added without changing the Secrets plugin's core
   trust model.
7. Plugin manifests contain enough metadata for future marketplace install and
   review.

---

## Open Decisions

1. Should bundled core plugins use the exact same manifest install records as
   marketplace plugins, or a separate built-in registry table?
2. Should marketplace plugins be sidecar-only initially, or should trusted local
   TypeScript module plugins be user-installable behind a warning?
3. Should plugin prompt contributions support only append/context, or also
   structured replacement of specific Signet-owned prompt blocks?
4. Should provider plugins be allowed to expose their own top-level dashboard
   panels, or only extend parent capability panels by default?
5. Should the first Rust sidecar protocol be JSON-RPC over stdio, HTTP on a
   loopback port, or Unix domain socket where available?
6. How should plugin dependencies be resolved when one plugin extends another
   disabled plugin?
7. Should human-initiated secret export exist in v1, or remain explicitly out of
   scope until team secrets and backup flows are designed?
