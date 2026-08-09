---
title: "Integrations and security commands"
description: "Manage sync, secrets, skills, Git, API keys, connectors, and hooks."
---

## `signet sync`

Sync hooks, extensions, built-in template files, and skills to your `$SIGNET_WORKSPACE/` directory,
and re-register hooks for the active harnesses listed in `agent.yaml`. Run this after an
upgrade if built-in skills appear stale or hooks need updating. If OpenClaw is still configured on
the legacy Signet hook path, `signet sync` now migrates it to the plugin
runtime path automatically so full lifecycle capture resumes.
The command may report installed harnesses it detects on disk, but inactive
harnesses are not modified.

```bash
signet sync
```

---

## `signet secret`

Manage encrypted [Secrets](/secrets/) stored via the daemon, including 1Password
service-account integration.

```bash
signet secret put OPENAI_API_KEY
signet secret put GITHUB_TOKEN ghp_...   # value inline
signet secret list
signet secret delete GITHUB_TOKEN
signet secret has OPENAI_API_KEY

# 1Password integration
signet secret onepassword connect
signet secret onepassword status
signet secret onepassword vaults
signet secret onepassword import --vault Engineering --prefix OP
signet secret onepassword disconnect
```

Subcommands:

| Command | Description |
|---------|-------------|
| `signet secret put <name> [value]` | Store a secret; prompts if value omitted |
| `signet secret list` | List all secret names (never values) |
| `signet secret delete <name>` | Delete a secret (prompts for confirmation) |
| `signet secret has <name>` | Check existence; exits 0 if found, 1 if not |
| `signet secret onepassword connect [token]` | Save/validate a 1Password service account token |
| `signet secret onepassword status` | Show 1Password connection and vault access status |
| `signet secret onepassword vaults` | List accessible 1Password vaults |
| `signet secret onepassword import` | Import password-like fields from 1Password into Signet secrets |
| `signet secret onepassword disconnect` | Remove stored 1Password service account token |

A `GITHUB_TOKEN` secret is used by `signet git` to authenticate pushes to
a remote repository.

---

## `signet skill`

Manage agent [Skills](/skills/) from the GitHub-based registry. Skills are installed
to `$SIGNET_WORKSPACE/skills/` and symlinked into [harness](/harnesses/) config directories.

```bash
signet skill list
signet skill install browser-use
signet skill uninstall weather
signet skill search github
signet skill show <name>
```

Subcommands:

| Command | Description |
|---------|-------------|
| `signet skill list` | List installed skills |
| `signet skill install <name>` | Install a skill from the registry |
| `signet skill uninstall <name>` | Remove an installed skill |
| `signet skill search <query>` | Search the GitHub skills registry |
| `signet skill show <name>` | Show skill details |

Registry search queries GitHub for repositories tagged `agent-skill` or
containing a `SKILL.md` file. Unauthenticated searches are limited to
10 requests per minute.

---

## `signet git`

Git sync management for the `$SIGNET_WORKSPACE` directory. A `GITHUB_TOKEN`
secret must be set for push operations.

```bash
signet git status
signet git sync
signet git pull
signet git push
signet git enable
signet git enable --interval 600
signet git disable
```

Subcommands:

| Command | Description |
|---------|-------------|
| `signet git status` | Show git status, sync state, and token presence |
| `signet git sync` | Pull remote changes then push |
| `signet git pull` | Pull changes from remote |
| `signet git push` | Push commits to remote |
| `signet git enable` | Enable daemon auto-sync |
| `signet git disable` | Disable daemon auto-sync |

`signet git enable` options:

| Option | Description |
|--------|-------------|
| `-i, --interval <seconds>` | Sync interval in seconds (default: 300) |

---

## `signet api-key`

Create named API keys for remote connectors and other daemon clients. See
[Remote Harness Connectors](/remote-connectors/) for the full remote setup flow.

```bash
signet api-key create --name "work laptop pi" --connector pi --agent-id pi-work-laptop
signet api-key list
signet api-key revoke <id-or-prefix>
```

The raw `sig_sk_...` key is printed once. Store it on the remote machine as
`SIGNET_API_KEY`. `--agent-id` creates an auth-enforced agent scope: a key
created with `--agent-id <agent-name>` defaults requests to that agent and rejects requests
for other agents.

---

## `signet connector`

Install portable harness connectors. Use `signet connect <harness>` as a short
alias for `signet connector install <harness>`. For a start-to-finish remote
machine setup, see [Remote Harness Connectors](/remote-connectors/).

```bash
signet connector install pi
signet connector install pi --url https://signet-home.tailnet:3850 --api-key sig_sk_... --agent-id pi-work-laptop
signet connect codex --url https://signet-home.tailnet:3850 --api-key sig_sk_...
# For a Codex client scoped to one agent:
signet api-key create --name "codex tailnet" --connector codex --agent-id <agent-name>
signet connect codex --url https://signet-home.tailnet:3850 --api-key sig_sk_...
```

Connector installers are also published as individual npm packages for machines
where you only want to configure one harness:

```bash
npx -y @signetai/connector-pi install --url https://signet-home.tailnet:3850 --api-key sig_sk_... --agent-id pi-work-laptop
npx -y @signetai/connector-opencode install --url https://signet-home.tailnet:3850 --api-key sig_sk_... --agent-id opencode-work-laptop
npx -y @signetai/connector-codex install --url https://signet-home.tailnet:3850 --api-key sig_sk_...
```

For Codex, `@signetai/codex-plugin` is the native-plugin-oriented installer name.
It writes the same generated Codex plugin marketplace bundle and compatibility
hook/MCP config as `signet connect codex`:

```bash
npx -y @signetai/codex-plugin install --url https://signet-home.tailnet:3850 --api-key sig_sk_...
# Use a key created with --agent-id <agent-name> to scope this Codex install to that agent.
```

---

## `signet hook`

Lifecycle hook commands for harness integration. These are called by
connector packages automatically; you rarely need to invoke them directly.

```bash
signet hook session-start --harness claude-code
signet hook user-prompt-submit --harness claude-code
signet hook session-end --harness claude-code
signet hook pre-compaction --harness claude-code
signet hook compaction-complete --harness claude-code --summary "..."
signet hook synthesis
signet hook synthesis-complete --content "..."
```

Subcommands:

| Command | Description |
|---------|-------------|
| `signet hook session-start` | Initialize session, inject context |
| `signet hook user-prompt-submit` | Inject relevant memories for a prompt |
| `signet hook session-end` | Extract and save memories from transcript |
| `signet hook pre-compaction` | Get summary instructions before compaction |
| `signet hook compaction-complete` | Save session summary after compaction |
| `signet hook synthesis` | Get the MEMORY.md synthesis prompt |
| `signet hook synthesis-complete` | Save synthesized MEMORY.md content |

Most subcommands require `-H, --harness <harness>` identifying the calling
platform (e.g. `claude-code`, `opencode`, `openclaw`). If the daemon is

When hook payloads are provided over stdin, the CLI now prefers canonical
`session_key` / `sessionKey` fields before legacy `session_id` aliases.
`signet hook user-prompt-submit` forwards preferred `userMessage` when it is
provided, while still carrying legacy `userPrompt` compatibility fields.
`signet hook session-end` forwards both stdin `transcript_path` /
`transcriptPath` and inline `transcript` content for lossless capture.
`signet hook compaction-complete` also forwards stdin `cwd` as the fallback
`project` scope when transcript persistence has not landed yet.
not running, hooks exit cleanly with code 0 so the harness is not blocked.

---
