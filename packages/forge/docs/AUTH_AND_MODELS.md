# Auth and Models

Forge treats provider availability as part of the Signet runtime, not as a separate setup checklist.

## Connectivity sources

Forge determines whether a provider is usable from these sources:

1. environment variables
2. Forge local credentials
3. Signet secrets
4. supported local CLI auth state
5. local provider availability such as Ollama

## Forge local credentials

Forge stores local credentials in the platform config directory.

Typical paths:

- macOS: `~/Library/Application Support/forge/credentials.json`
- Linux: `~/.config/forge/credentials.json`

These credentials are used for API providers and for any supported locally stored CLI auth material.

## Signet secret sync

When Forge connects to the Signet daemon, it can import supported provider API keys from Signet secrets into Forge local credentials.

That means a key stored once in Signet can automatically make the provider available in Forge.

Forge only imports supported provider credentials. It does not treat every secret in Signet as Forge auth state.

## CLI provider detection

Forge does not treat a CLI provider as connected just because the binary exists.

A CLI provider only counts as available when Forge can confirm both:

- the provider CLI is present
- supported local auth state already exists for that CLI

This keeps `/model` focused on providers that are actually usable.

## Auth behavior

### API providers

API providers use provider-issued API keys.

### CLI providers

For CLI providers, Forge can reuse supported local CLI auth state that already exists on disk.

Provider-specific authentication policies still apply. Forge documentation does not supersede the upstream provider's terms, SDK requirements, or branding restrictions. For Claude integrations in particular, use Anthropic-approved authentication methods rather than assuming a claude.ai login flow is available through Forge.

## Signet daemon auth

Forge supports authenticated Signet daemon access.

When configured, Forge sends:

- `Authorization: Bearer <token>`
- `x-signet-actor`
- `x-signet-actor-type: agent`

This matters when Signet is running in authenticated team or hybrid modes.

## Model discovery

Forge only wants to show models that are actually usable.

That means the model picker is built from connected providers, not from a static master list of every possible provider.

### Sources of model lists

Forge can use:

- Signet registry-backed models
- curated CLI model coverage for supported CLI families
- provider-specific fallback coverage where needed

### Registry preference

When Signet has registry coverage for a connected provider family, Forge prefers those registry models so newer versions can surface automatically.

### CLI family mapping

Forge maps registry families into the terminal-facing provider names where needed, for example:

- `claude-code` registry entries shown under `claude-cli`
- `codex` registry entries shown under `codex-cli`

## Refresh behavior

Model availability should update when provider connectivity changes.

Important cases include:

- opening the model picker after auth changes
- connecting to Signet and importing secrets
- detecting an already-authenticated CLI provider

The intended result is simple: if a provider is connected, its models should appear without unnecessary re-auth or stale placeholder entries.
