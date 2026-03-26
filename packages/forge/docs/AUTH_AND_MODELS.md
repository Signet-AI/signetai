# Auth and Models

Forge treats auth and model availability as part of the Signet pipeline, not as a separate manual setup problem.

## Connectivity sources

Forge determines whether a provider is usable from these sources:

1. environment variables
2. Forge local credentials
3. Signet secrets
4. authenticated CLI login state
5. local provider availability such as Ollama

## Forge local credentials

Forge stores local credentials in the platform config directory.

Typical paths:

- macOS: `~/Library/Application Support/forge/credentials.json`
- Linux: `~/.config/forge/credentials.json`

These credentials are used for API providers and, where needed, for pasted CLI auth material.

## Signet secret sync

When Forge connects to the Signet daemon, it can import supported provider API keys from Signet secrets into Forge local credentials.

That means a key stored once in Signet can automatically make the provider available in Forge.

The general flow is:

1. Forge connects to Signet
2. Forge checks available Signet secrets
3. matching provider keys are imported if Forge does not already have a local value
4. Forge requests a model-registry refresh

## CLI provider auth detection

Forge does not treat a CLI provider as connected just because the binary exists.

It treats supported CLI providers as connected when they are actually authenticated, including persisted login state that already exists on disk.

### Supported CLI detection

- `claude-cli`
  - checked through Claude auth status
- `codex-cli`
  - checked through Codex login status
  - can also trust persisted Codex auth state on disk
- `gemini-cli`
  - checked through persisted or configured auth state

This is important because a provider should not show up in `/model` just because the executable is installed.

## Auth flow

Forge’s auth flow supports both API-style auth and CLI-style auth.

### API providers

For API providers, Forge expects a real API key.

### CLI providers

For CLI providers, Forge supports the native login flow and persisted login detection.

Depending on the provider, Forge can also support token or auth-state import paths where that matches how the CLI really works.

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

The intended result is simple: if a provider is connected, its models should appear without forcing unnecessary re-auth.
