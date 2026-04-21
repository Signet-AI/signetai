---
title: "Plugin SDK and Secrets Capability Architecture"
question: "How should Signet design a plugin SDK that supports TypeScript and Rust plugins, future marketplace installation, cross-surface integration, prompt contributions, and backward-compatible secrets?"
informed_by:
  - "docs/specs/approved/signet-runtime.md"
  - "docs/specs/planning/plugin-api-ecosystem.md"
  - "docs/specs/planning/git-marketplace-monorepo.md"
  - "packages/daemon/src/secrets.ts"
  - "packages/daemon/src/routes/secrets-routes.ts"
relevance:
  - plugin-api-ecosystem
  - signet-runtime
  - git-marketplace-monorepo
---

# Plugin SDK and Secrets Capability Architecture

This research note records the design constraints behind turning Signet
Secrets into a first-party plugin and using that work to define the broader
plugin SDK architecture.

The question is not only "can Signet load plugins?" The real question is:
can Signet host capability modules that participate in the daemon, CLI, MCP,
dashboard, connectors, SDKs, and prompt lifecycle without weakening Signet's
local-first trust model?

## Existing State

Signet already exposes daemon routes, CLI commands, MCP tools, dashboard
panels, harness connectors, and SDK helpers. These surfaces are implemented as
first-party code paths rather than plugin contributions.

Secrets are currently daemon-owned:

- storage and encryption live in `packages/daemon/src/secrets.ts`
- HTTP routes live in `packages/daemon/src/routes/secrets-routes.ts`
- values are encrypted at rest in `$SIGNET_WORKSPACE/.secrets/secrets.enc`
- the local store uses libsodium `secretbox`
- the key is derived from a machine-specific identifier using BLAKE2b
- the daemon injects resolved values into subprocess environments
- command output is redacted before being returned

The existing encrypted store is user data. Any plugin migration must preserve
that file format and key derivation unless the user explicitly opts into a
future migration.

## Findings

### 1. Plugins must be cross-surface capability modules

A route-only plugin system would immediately drift. A useful Signet plugin
must be able to declare all of the surfaces it contributes to:

- daemon routes
- auth and capability policy
- CLI commands
- MCP tools
- dashboard panels and settings
- SDK typed clients
- connector-visible capabilities
- prompt lifecycle contributions
- health checks and status cards

The plugin should declare contributions in one manifest. The Signet host
should decide where those contributions appear and how they are authorized.

### 2. Rust and TypeScript require a protocol boundary

TypeScript plugins can run as trusted in-process modules when bundled with
Signet, but Rust plugins should not require native dynamic-library loading into
the daemon. A stable protocol boundary is safer and better aligned with future
marketplace installation.

The durable shape is:

- TypeScript module plugins for trusted first-party code
- managed sidecar plugins for Rust and third-party code
- a versioned Signet plugin RPC protocol shared by both SDKs
- future WASI support if sandboxing becomes necessary

This avoids making the daemon's process ABI the plugin ABI.

### 3. Marketplace readiness belongs in v1 manifests

The first implementation does not need full public marketplace installation,
review, payments, or discovery. It does need enough manifest structure that
future marketplace support does not require replacing the plugin model.

The v1 manifest should therefore include:

- stable plugin ID
- publisher identity
- version
- runtime language and protocol version
- compatible Signet version range
- declared capabilities
- declared surface contributions
- extension points
- checksums/signature placeholders
- license, repository, homepage, and category metadata

Marketplace installation can remain a later spec, but marketplace-compatible
identity and metadata should be part of the plugin contract now.

### 4. Prompt modification must be declarative and auditable

Plugins should be able to append context to the system prompt and
user-prompt-submit lifecycle. Secrets is the motivating example: when the
Secrets plugin is enabled, Signet should remind agents to store credentials in
Signet Secrets; when the plugin is disabled, that reminder should disappear.

The safe pattern is not arbitrary prompt mutation. Plugins should register
named prompt contributions with:

- target lifecycle
- priority
- token budget
- conditions
- content
- plugin provenance

The dashboard and diagnostics surfaces should show active prompt contributors
so users can understand what is being injected.

### 5. Secrets should be a core capability plugin with provider extensions

The Secrets plugin should own the security contract: references, redaction,
audit logging, CLI/MCP/dashboard behavior, and exec-with-secrets. Specific
vaults should be provider plugins under that capability.

Provider examples:

- local encrypted Signet store
- 1Password
- Bitwarden
- HashiCorp Vault
- AWS Secrets Manager
- GCP Secret Manager
- Azure Key Vault
- environment variable resolver
- pass/gopass

Provider plugins should not each define their own user-facing secrets model.
They should register with `signet.secrets` and implement a provider interface.

### 6. Existing secrets must be adopted in place

Existing users may already have secrets stored in
`$SIGNET_WORKSPACE/.secrets/secrets.enc`. The migration to a plugin-backed
Secrets architecture must not require:

- decrypting and rewriting the store
- re-entering secrets
- changing key derivation
- changing ciphertext format
- moving the file

The local provider should adopt the current file as its backing store. Future
store versions may be introduced later only with explicit backup, opt-in, and
rollback behavior.

## Resulting Design Direction

Signet should introduce a plugin host and SDK around this principle:

> Plugins declare capabilities and surface contributions. The Signet host
> decides where those contributions appear, how they are authorized, and how
> they compose with user-owned context.

Secrets should become the reference core plugin because it forces the design
to handle the hardest boundaries first: privileged data, provider modularity,
prompt contributions, CLI/MCP/dashboard parity, connector availability,
marketplace metadata, and backward-compatible migration.

