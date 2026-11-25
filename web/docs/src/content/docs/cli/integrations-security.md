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

Manage encrypted [Secrets](/secrets/). Local secret operations prefer the daemon
and native keyring when available, then use the shared encrypted store directly
when the daemon or keyring is unavailable. This keeps local exec usable in
headless cron and systemd sessions without bypassing locked or corrupt keyrings.
1Password, Bitwarden, and daemon queue-status operations require the daemon.

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
| `signet secret exec --secret <name> <command>` | Inject selected local secrets and run a command; synchronous without the daemon, queued with the daemon |
| `signet secret exec-status <job-id>` | Check an asynchronous daemon secret exec job; daemon required |
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

## Login and session management

```bash
signet login --url https://signet.example.com
signet login --url https://signet.example.com --device-code
signet whoami --json
signet auth devices
signet auth sessions
signet auth devices revoke <id>
signet auth sessions revoke <id>
signet logout
signet logout --all
```

Login opens a browser approval page and prints its user code. `--device-code`
prints the URL without opening a browser. The login store saves the refresh
credential privately; it is never printed. `whoami` reports identity, target URL,
and credential source, not credential contents. Local mode needs no login.

## `signet connect`, `signet disconnect`, and `signet connector`

```bash
signet connect codex --agent alice
signet connector install pi
signet connector list --json
signet connector rotate codex
signet connector doctor --json
signet disconnect codex
signet connect hermes-agent --profile work --agent alice
```

`connector install` is the compatibility spelling of `connect`. A team target
requires your signed-in user session. Connect provisions a harness key, stores
it in a private key file, and installs credential-free integration files.
Disconnect revokes that key before removing local integration and registry
state. An unreachable server leaves local state available for retry. Rotation
revokes the previous key before provisioning a replacement; reconnect if the
replacement could not be installed.

Connect, install, rotate, and disconnect accept `--url`, `--agent`, `--profile`
(for Hermes), and `--json`. `--agent-id` is a compatibility spelling of `--agent`.
When automation supplies a credential, use `--api-key-stdin` with piped input,
never an argv key. Team provisioning still requires a user session, not a
connector key.

List reports validity, expiry, and available last-used metadata. Doctor checks
inline credentials, private-file permissions, credential validity, outbox
pending/quarantine state, and unassigned legacy keys. Unknown or unavailable
checks stay visible. See [Remote Harness Connectors](/remote-connectors/) for
profile isolation, recovery, and the complete supported-harness list.

---

## `signet hook`

Lifecycle hook commands for harness integration. These are called by
connector packages automatically; you rarely need to invoke them directly.

```bash
signet hook session-start --harness claude-code
signet hook user-prompt-submit --harness claude-code
signet hook stop --harness claude-code
signet hook session-end --harness claude-code
signet hook pre-compaction --harness claude-code
signet hook compaction-complete --harness claude-code --summary "..."
signet hook synthesis

```

Subcommands:

| Command | Description |
|---------|-------------|
| `signet hook session-start` | Initialize session, inject context |
| `signet hook user-prompt-submit` | Inject relevant memories for a prompt |
| `signet hook stop` | Record the assistant reply that ends a turn |
| `signet hook session-end` | Extract and save memories from transcript |
| `signet hook pre-compaction` | Get summary instructions before compaction |
| `signet hook compaction-complete` | Save session summary after compaction |
| `signet hook synthesis` | Get the MEMORY.md synthesis prompt |

API/migration endpoint:

| Endpoint | Description |
|----------|-------------|
| `POST /api/synthesis/trigger` | Trigger Dreaming's manifest-gated MEMORY.md publication |

Most subcommands require `-H, --harness <harness>` identifying the calling
platform (e.g. `claude-code`, `opencode`, `openclaw`). If the daemon is

When hook payloads are provided over stdin, the CLI now prefers canonical
`session_key` / `sessionKey` fields before legacy `session_id` aliases.
`signet hook user-prompt-submit` forwards preferred `userMessage` when it is
provided, while still carrying legacy `userPrompt` compatibility fields.
`signet hook session-end` forwards both stdin `transcript_path` /
`transcriptPath` and inline `transcript` content for lossless capture.
`signet hook stop` writes no stdout, because Claude Code reads Stop hook output
as a decision. Failures are reported on stderr. It reads `last_assistant_message`
and `cwd` from stdin, skips the daemon call when the payload has no session or
no reply, and stops waiting
for the daemon after 10 seconds. On an HTTP 503 it tries again, up to 3 attempts
one second apart, within that limit. It does not retry timeouts or other errors.
`signet hook compaction-complete` also forwards stdin `cwd` as the fallback
`project` scope when transcript persistence has not landed yet.
not running, hooks exit cleanly with code 0 so the harness is not blocked.

---
