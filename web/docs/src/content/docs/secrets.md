---
title: "Secrets"
description: "Store and use sensitive values without writing them into configuration or prompts."
---

Signet secrets use a shared encrypted store in `@signet/core`. Local read, put, list, has, and delete commands can access that store directly when the daemon is not running. The CLI and API deliberately expose names and status, not raw stored values.

## Basic commands

```bash
# Prompt for a value without echoing it
signet secret put OPENAI_API_KEY

# Names only
signet secret list
signet secret has OPENAI_API_KEY

# Confirmation is required
signet secret delete OPENAI_API_KEY
```

Use a stored value from `agent.yaml` by reference:

```yaml
embedding:
  api_key: $secret:OPENAI_API_KEY
```

Do not place provider keys directly in YAML, shell history, screenshots, task prompts, or source control.

## Use a secret in a command

`signet secret exec` injects selected secrets into the child environment. When the daemon and native keyring are available, it keeps the existing asynchronous queue and returns a job id. When the daemon or the native keyring is unavailable, local commands use the same encrypted store directly, execute synchronously in-process, and return the command result. This fallback is intended for headless cron and systemd sessions and does not bypass locked, corrupt, or permission-denied keyrings. The command must name each injected secret before the command token:

```bash
signet secret exec --secret OPENAI_API_KEY \
  curl https://api.openai.com/v1/models
```

With the daemon running, the CLI returns a job id. Inspect it with:

```bash
signet secret exec-status <job-id>
```

The command line is constructed so shell-level secret expansion is not used. Treat the child process, its output, and its working directory as sensitive anyway: a process that can read an injected environment variable can disclose it.

1Password, Bitwarden, and daemon queue-status commands still require a running Signet daemon. If the daemon is unavailable, the CLI reports that requirement instead of silently changing provider behavior.

## External providers

The current CLI supports 1Password and Bitwarden integrations in addition to the local encrypted provider.

```bash
# 1Password service-account flow
signet secret onepassword connect
signet secret onepassword status
signet secret onepassword vaults

# Bitwarden session flow
bw unlock --raw | signet secret bitwarden connect --session-stdin
signet secret bitwarden status
signet secret bitwarden use local
signet secret bitwarden use bitwarden
```

Use an integration only when its access boundary matches the deployment. Keep its service token or session token out of process arguments and committed files.

## Storage and recovery

Local secret state is kept under `$SIGNET_WORKSPACE/.secrets/`. Keep this directory private and out of source control. Secret values are intentionally not available through a `get` command; `signet secret get NAME` explains how to use an existing reference instead.

New stores are keyring-first. Signet generates a random 256-bit master key and stores it as a generic credential named `ai.signet.secrets` in the current user account. The encrypted payload remains in `secrets.enc`, but the machine identifier is no longer used to protect new stores.

The native adapter uses the platform user credential store:

- macOS: Keychain Services.
- Windows: user-scoped Credential Manager. Signet does not use a machine-wide DPAPI scope.
- Linux: Secret Service through the user D-Bus session, such as GNOME Keyring or KWallet. Signet does not silently switch to the kernel keyring.

The daemon never prompts for an unlock. A locked keyring is reported as a retryable `keyring-locked` condition and is not treated as missing credentials. An unavailable headless Linux keyring is distinct from an empty keyring. Existing local-first deployments can continue in the documented degraded compatibility mode when no native keyring is available. In that mode the current machine-id-derived encryption is used, a one-time warning is emitted, a persistent degraded health marker is written, and the store is not portable across machines. A locked or permission-denied keyring never triggers this fallback.

On macOS, the isolated secrets helper disables Keychain Services user interaction before reading or writing credentials. Access that requires consent fails closed instead of opening a password dialog. Unlock the login keychain or authorize the executable that runs the secrets helper for the `ai.signet.secrets` item in Keychain Access, then retry. The compiled CLI uses the installed Signet executable; the desktop daemon uses its bundled Bun runtime. A Node-based macOS caller uses the Bun executable resolved from its `PATH`. These executables have separate Keychain application identities, so authorizing Signet does not authorize Bun; sharing a workspace across runtimes may require authorizing each helper executable. Do not delete the item: it contains the key needed to decrypt existing secrets. The compiled Signet executable includes the helper runtime; Node-based macOS installations need Bun on `PATH` to run this noninteractive helper. If Bun is unavailable, secret access fails explicitly.

Secret lookups check the encrypted store for the requested name before accessing the keyring. Concurrent reads for the same workspace share one helper request. Provider health reports the last observed keyring access and master-key validation outcome without retaining the key, launching a helper, or reading a password. Before the first access, it reports degraded status because access has not been checked. A malformed master key reports unhealthy status and secret reads fail closed. A successful observation is not a guarantee that a subsequent read will succeed: actual reads check keyring access again.

Existing version-1 `secrets.enc` files migrate on first read or write after the native keyring becomes available. Signet validates the complete old store, writes or reuses the keyring master key, re-encrypts every entry into version 2, and atomically replaces the file. The keyring write happens before the file replacement, so an interrupted migration can be retried. Repeated access is idempotent. A version-2 file fails closed if its keyring item is missing or inaccessible; Signet never derives a replacement key for it.

Moving a workspace to a different machine or restoring it from backup is a security-sensitive operation. Restoring only `secrets.enc` is not sufficient after migration. Restore the platform keychain or use an explicit recovery export/import flow when available. Verify the recovered secret provider state before restarting automation. Do not hand-copy ciphertext or reset secret files to troubleshoot a provider issue.

## API boundary

The daemon exposes list, store, delete, execution, and external-provider status routes under `/api/secrets`. These routes are permission-protected in authenticated deployments. Use the CLI for ordinary operation and the [HTTP API](/api/) when building a controlled integration.

Related: [Authentication](/auth/), [Self-Hosting](/self-hosting/), [Remote Harness Connectors](/remote-connectors/).
