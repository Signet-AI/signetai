---
title: "Secrets"
description: "Store, reference, execute with, and recover sensitive values."
---

Signet stores secret values in its encrypted secret store and exposes names and status rather than raw values.

## Store and reference

```bash
signet secret put OPENAI_API_KEY
signet secret list
signet secret has OPENAI_API_KEY
signet secret delete OPENAI_API_KEY
```

Deletion requires confirmation. Reference a value from configuration without embedding it:

```yaml
embedding:
  api_key: $secret:OPENAI_API_KEY
```

The local store is under `$SIGNET_WORKSPACE/.secrets/`; keep it private and out of source control.

## Execute with a secret

Name each injected secret before the command:

```bash
signet secret exec --secret OPENAI_API_KEY \
  curl https://api.openai.com/v1/models
```

With the daemon, execution is queued and returns a job id. Check it with `signet secret exec-status <job-id>`. Without the daemon, local secret execution is synchronous when the native keyring is available. Locked, corrupt, or permission-denied keyrings remain errors.

Treat the child process, output, and working directory as sensitive. A child that can read an injected environment variable can disclose it.

## External providers

The current CLI supports 1Password and Bitwarden integrations:

```bash
signet secret onepassword connect
signet secret onepassword status
bw unlock --raw | signet secret bitwarden connect --session-stdin
signet secret bitwarden status
```

These integrations and daemon queue-status operations require a running daemon. Their tokens must stay out of process arguments and source control.

## Storage compatibility and recovery

New stores use a platform user keyring and an encrypted `secrets.enc` payload. Existing version-1 stores migrate to version 2 when a native keyring is available. Version-2 stores fail closed if their keyring item is unavailable. A documented degraded compatibility mode may serve older local-first deployments without a native keyring; such stores are machine-bound and not portable.

When moving or restoring a workspace, restore the platform keychain with the workspace. Restoring only `secrets.enc` is insufficient after migration. Verify secret-provider state before restarting automation.

The daemon exposes protected secret routes under `/api/secrets` for list, store, delete, execution, and external-provider status. Use the CLI for routine operation.
