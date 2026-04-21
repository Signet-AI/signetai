---
title: "Secrets"
description: "Encrypted storage for API keys and sensitive values."
order: 7
section: "Core Concepts"
---

# Secrets Management

Encrypted storage for API keys and sensitive values. Agents can *use*
secrets without being able to read or expose them. The capability is owned by
the bundled `signet.secrets` core plugin.

---

## How It Works

The core problem with AI agents and secrets: if an agent can read `OPENAI_API_KEY` from the environment, a prompt injection attack or a careless response could leak it.

Signet's solution: secrets are encrypted at rest, and agents never receive
decrypted values. When a secret is needed (for embeddings, tool calls, etc.),
the [[daemon]] resolves it internally, either by using the value directly in
API calls or by injecting it into a subprocess environment that the agent
cannot inspect.

`signet.secrets` is the privileged core plugin for the capability. In V1 it
registers plugin diagnostics, surface metadata, and a local provider that
adopts the existing encrypted store in place. Secret operations emit
structured daemon diagnostics such as `secret.listed`, `secret.stored`,
`secret.deleted`, `secret.resolved_for_exec`, `secret.exec_started`, and
`secret.exec_completed`; payloads include names or counts where current API
policy already exposes them, but never raw values. Plugin lifecycle,
capability-denial, and secret-provider events are also appended to
`$SIGNET_WORKSPACE/.daemon/plugins/audit-v1.ndjson` with sensitive fields
redacted before storage.

Secrets API routes are guarded by the plugin registry. If `signet.secrets`
is disabled, blocked, or missing the required grant for a route, the daemon
returns a structured plugin-capability error. Stored secret files are left
in place.

### Setup defaults

Existing installs default to Signet Secrets enabled, even if they do not yet
have a plugin registry file. New interactive installs include a **Core
plugins** step that explains what Signet Secrets stores, how it connects to
Signet's encrypted local store and compatible 1Password references, which
value-safe surfaces it enables, and why that is safer than putting credentials
in prompts, shell history, logs, or source files.

For non-interactive setup, Signet Secrets is enabled by default. Use
`signet setup --disable-signet-secrets` to leave the bundled plugin installed
but disabled. Disabling the plugin blocks secret API routes and tool surfaces
without deleting existing encrypted secret files.

---

## Storage

```
$SIGNET_WORKSPACE/
└── .secrets/
    └── secrets.enc     # Encrypted secret store (JSON, mode 0600)
```

The `secrets.enc` file is JSON, but every value is encrypted individually. It's readable by humans as a list of names and metadata, but the actual values are ciphertext.

The local provider keeps this file format unchanged. Existing
`$SIGNET_WORKSPACE/.secrets/secrets.enc` files remain valid without
migration, re-encryption, relocation, or user action. Bare secret names are
compatibility aliases for local references:

```text
OPENAI_API_KEY == local://OPENAI_API_KEY
```

### Encryption

- **Algorithm:** XSalsa20-Poly1305 via libsodium (`crypto_secretbox_easy`)
- **Key derivation:** BLAKE2b hash of `signet:secrets:<machine-id>` stretched to 32 bytes
- **Machine ID:** reads `/etc/machine-id` (Linux) or `IOPlatformUUID` (macOS); falls back to `hostname-username`
- **Nonces:** random, prepended to each ciphertext
- **File permissions:** `0600` (owner read/write only)

The master key is bound to the machine, so the encrypted file cannot be decrypted on another computer without the same machine ID.

---

## [[cli|CLI]] Commands

### Add a secret

```bash
signet secret put OPENAI_API_KEY
# Prompts: Enter value: ••••••••
# ✓ Secret OPENAI_API_KEY saved
```

The value is never echoed. Prompt input is hidden.

### List secrets

```bash
signet secret list
# OPENAI_API_KEY
# ANTHROPIC_API_KEY
# GITHUB_TOKEN
```

Only names are shown — never values.

### Check if a secret exists

```bash
signet secret has OPENAI_API_KEY
# true
```

### Delete a secret

```bash
signet secret delete GITHUB_TOKEN
# ✓ Secret GITHUB_TOKEN deleted
```

### 1Password integration

```bash
# Connect using a service account token (prompted if omitted)
signet secret onepassword connect

# Check status and list vaults
signet secret onepassword status
signet secret onepassword vaults

# Import password-like fields from selected vaults
signet secret onepassword import --vault Engineering --prefix OP

# Disconnect and remove stored service account token
signet secret onepassword disconnect
```

Imported values are stored as regular Signet secrets with generated names,
and `secret_exec` can also reference 1Password secrets directly via
`op://vault/item/field` when connected.

### Export / import (planned)

```bash
signet secret export > secrets.enc.backup
signet secret import < secrets.enc.backup
```

---

## Dashboard UI

The [[dashboard]]'s **Settings -> Secrets** panel lets you:

- View all secret names (values always masked as `•••••`)
- Add new secrets via an input form
- Delete secrets
- Connect/disconnect a 1Password service account token
- Select vaults and import password-like fields into Signet secrets

There is intentionally no "reveal" button — the UI never has access to secret values.

---

## Using Secrets in Config

Reference a stored secret in `agent.yaml` with the `$secret:NAME` syntax:

```yaml
embedding:
  provider: openai
  model: text-embedding-3-small
  api_key: $secret:OPENAI_API_KEY
```

The daemon resolves `$secret:NAME` references internally when making API calls. The actual value never appears in the config file or the agent's context.

---

## Executing Commands with Secrets

The daemon can spawn a subprocess with secrets injected into its environment. The agent provides references (names), not values.

**HTTP API:**

```http
POST /api/secrets/exec
Content-Type: application/json

{
  "command": "curl https://api.openai.com/v1/models",
  "secrets": {
    "OPENAI_API_KEY": "OPENAI_API_KEY",
    "DB_PASSWORD": "op://Engineering/Prod DB/password"
  }
}
```

The map is `{ env_var_name: secret_reference }` where a reference can be a
stored Signet secret name or a 1Password `op://...` reference. The daemon:
1. Resolves each secret reference to its value
2. Spawns the subprocess with the resolved values in the environment
3. Returns stdout/stderr with any secret values redacted from the output

**Response:**

```json
{
  "stdout": "...",
  "stderr": "",
  "code": 0
}
```

If a secret value appears anywhere in stdout or stderr, it is replaced with `[REDACTED]`.

Provider-qualified local refs are accepted wherever secret references are
accepted:

```json
{
  "OPENAI_API_KEY": "local://OPENAI_API_KEY"
}
```

---

## Security Model

**What the daemon does:**
- Reads the machine ID from `/etc/machine-id` or equivalent
- Derives a 32-byte master key using BLAKE2b
- Encrypts each secret value with a random nonce
- Stores ciphertext in `$SIGNET_WORKSPACE/.secrets/secrets.enc` at `0600`

**What agents can't do:**
- Read secret values from config files or environment
- Inspect subprocess environments
- Enumerate secret values through the API (only names)
- Access the `GET /api/secrets/:name` route (there is none — only `POST`, `DELETE`, and `GET /api/secrets` for names)
- Retrieve raw values through SDK, MCP, dashboard, connector, or plugin
  diagnostics responses

**What you should know:**
- The master key is machine-bound, not passphrase-protected by default. If someone has shell access as your user, they can derive the key.
- Passphrase-protected keys are planned for a future version.
- Don't commit `$SIGNET_WORKSPACE/.secrets/` to version control. Add it to `.gitignore`.
- Secrets are zeroed from memory (best-effort in JavaScript) after use.

---

## API Reference

The full secrets API is documented in [API.md](./API.md#secrets-api). Summary:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/secrets` | GET | List secret names |
| `/api/secrets/:name` | POST | Store a secret |
| `/api/secrets/:name` | DELETE | Delete a secret |
| `/api/secrets/exec` | POST | Execute command with one or more secrets injected |
| `/api/secrets/:name/exec` | POST | Legacy single-secret exec |
| `/api/secrets/1password/status` | GET | 1Password integration status |
| `/api/secrets/1password/connect` | POST | Connect/save service account token |
| `/api/secrets/1password/connect` | DELETE | Disconnect/remove stored token |
| `/api/secrets/1password/vaults` | GET | List accessible 1Password vaults |
| `/api/secrets/1password/import` | POST | Import vault secrets into Signet |
| `/api/plugins` | GET | List plugin registry records, including `signet.secrets` |
| `/api/plugins/audit` | GET | List redacted durable plugin audit events |
| `/api/plugins/signet.secrets/diagnostics` | GET | Inspect Secrets plugin diagnostics and surface metadata |

---

## Planned Improvements

- **Passphrase protection** — optional user passphrase added to key derivation (Argon2)
- **OS keychain backend** — macOS Keychain, GNOME Keyring, Windows Credential Manager
- **Export/import** — encrypted backup bundles for moving between machines
- **Team secrets** — shared encrypted secrets via asymmetric encryption
- **Audit log** — log of secret usage (not values)
