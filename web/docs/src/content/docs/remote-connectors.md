---
title: "Remote Harness Connectors"
description: "Sign in once and connect each harness without putting credentials in its configuration."
---

A harness connects to one Signet daemon. Its target and credential live in the
Signet connector registry, not in hook commands, MCP configuration, or harness
environment assignments. A remote connection never silently switches to the
local daemon when the remote daemon is unavailable.

At harness runtime, the registry target takes precedence over
`SIGNET_DAEMON_URL`, then `SIGNET_HOST`/`SIGNET_PORT`, then the loopback default.
An explicit CLI URL flag remains a manual override. Credentials associated with
one origin are not borrowed for an override to another origin. Hermes freezes
these inputs when its client starts; later environment changes do not retarget it.

## Sign in and connect

Your administrator supplies the URL of a reachable team daemon and authorizes
your account. Explicit HTTP targets are allowed from a URL flag, connector
registry or configuration, or `SIGNET_DAEMON_URL`, including LAN and tailnet
addresses. **HTTP sends API keys and session tokens in clear text.** Use HTTPS
or an encrypted private tunnel whenever possible. A non-loopback HTTP target
prints one warning per process to stderr, including in the CLI; the warning
never includes a credential.

An environment key never follows an explicit `--url` override to another origin
unless `SIGNET_DAEMON_URL` names that origin. Requests refuse implicit redirects
and never forward Authorization across origins.

Install the Signet CLI and your harness on the client machine, then run:

```bash
signet login --url https://signet.example.com
signet whoami
signet connect codex --agent alice
signet connector list --json
```

`login` prints a user code and opens the approval page in your browser. On a
headless machine, add `--device-code` and open the printed URL on another device.
Signet saves the refresh credential through its login store; it never prints it.
Approval links must use the same origin as the selected daemon. Signet rejects
codes outside the bounded uppercase-letter, digit, and hyphen format before
printing them or opening a browser.

`connect` uses your signed-in session to request a separate device-bound key for
the harness. The key goes in an owner-only key file. The registry records its
path, URL, agent, and key/device identifiers, never the key itself. Unix private
directories use `0700` and credential files use `0600`; Windows uses private ACLs.
Restart the harness to load its integration. No second daemon or local copy of
the remote workspace is needed.

Supported IDs: `claude-code`, `codex`, `forge`, `gemini`, `hermes-agent` (alias
`hermes`), `kimi`, `muse-code`, `opencode`, `openclaw`, `oh-my-pi`, and `pi`.
The default local daemon still works without a login:

A loopback URL without a credential remains local, including an explicitly
configured URL or registry entry. Local capture passes the transcript path to
the daemon rather than uploading its contents. Claude session-end dispatch is
detached: a stalled daemon does not keep the harness process alive. Dispatch
acceptance reports `status: "dispatched"`, not confirmation that the daemon has stored the evidence.

```bash
signet connect claude-code
```

## Rotate or disconnect

```bash
signet connector rotate codex
signet disconnect codex
```

Reconnecting or rotating refreshes the managed integration and removes legacy
inline Signet credentials. Rotation issues a replacement, installs the integration,
swaps the protected key file and registry entry, and only then revokes the old key.
A failed installation restores the saved configuration and previous credential;
an unused newly issued key is revoked or recorded for cleanup.

Disconnect uninstalls the integration, removes its registry entry and key file,
and revokes the server-side key last. If revocation fails, local cleanup stays
complete and a protected pending-revocation record survives. The command reports
the pending revocation and exits nonzero; `connector doctor` retries it after you
restore connectivity or sign in again. Already-revoked keys do not prevent cleanup.

Session evidence is kept by default. To explicitly delete this harness target's
pending and quarantined outbox entries, run `signet disconnect codex --purge-outbox`.
Other harnesses' outboxes are untouched. If already disconnected, also provide the
original `--url` to select the retained outbox.

Never pass a key in argv or save it in a harness config. Automation that already
holds a connector key can pipe it through `signet connect codex --api-key-stdin`.
Signet first asks the daemon to confirm that it is a connector key bound to Codex;
personal keys, user-session tokens, unbound keys, and other-harness keys are
rejected without writing a key file. Ordinary `connect` provisions a new key using
your signed-in user session.

## Hermes profiles

```bash
signet connect hermes-agent --profile work --agent alice
signet connector rotate hermes-agent --profile work
signet disconnect hermes-agent --profile work
```

Hermes supplies the active profile's `HERMES_HOME` to its plugin. Each non-default
home has a separate registry partition, key file, and durable outbox. Switching
profiles does not retarget an existing client. Profile entries appear as
`hermes-agent.<profile-home-hash>` in listings. A profile name is not a substitute
for the Signet agent authorized by the daemon.

## Inspect and recover

```bash
signet connector list --json
signet connector doctor --json
signet auth devices
signet auth sessions
signet auth devices revoke <device-id>
signet auth sessions revoke <session-id>
signet logout
signet logout --all
```

`list` reports each target, agent, validity or availability, expiry, and last-use
metadata when your session can read it. Unavailable metadata is marked rather
than presented as a verified last-use time.

`doctor` flags leftover inline keys, unsafe key-file permissions, credential
failures, and pending or quarantined outbox entries. It reports whether it could
inspect unassigned legacy keys. Its configuration scan is bounded and reports
incomplete scans; unavailable inspection is not proof that nothing is wrong.
Doctor scans each declared configuration file and its bounded directory tree, without following symbolic links or walking the entire home directory.
Each connector declares its configuration paths, including Claude’s global
`~/.claude.json` MCP configuration. Pending revocations are reported and retried;
an active registry credential is never revoked by that retry.

A `401` prints "Signet session expired, run `signet login`". Rejected session-end
evidence stays in that harness's durable outbox. Sign in to the same instance
and reconnect or run doctor to trigger replay. Permission denials never trigger a retry under another agent. Outbox status
reports quarantine and permanent-rejection counters separately.

Remote file capture is recorded in the outbox before the client reads the
transcript. The Node SDK and Hermes Python transport send files above the
4 MiB inline limit through a resumable upload, then hand its reference to the
normal session-end handler. A process exit or lost acknowledgement does not
restart the transfer: replay reads the daemon's durable offset and continues
from there without rereading the earlier client-file bytes.

Keep the original transcript file until handoff is acknowledged. A changed
file is rejected and its outbox reference stays pending; replacement contents
are not silently sent as the original evidence. Unconsumed server uploads expire
after 24 hours without progress. If a saved upload ID returns `404` or `410`,
replay clears that checkpoint, re-hashes the original file, and declares a new
upload. A process exit after clearing the ID does not skip that re-hash on the
next replay. A checksum rejection (`422`) gets one re-hash and redeclaration attempt.
Changed files are never substituted, and a repeated rejection leaves the
original reference pending for inspection rather than discarding evidence.
Capture failures exit `1` and include a reason with `--json`. A queued capture
receipt means accepted work, not completed processing. See the hook-upload
protocol in the API reference for transfer bounds and receipt polling.

`logout` revokes your current login session; `logout --all` revokes your sessions
on other devices too. Use disconnect to remove an installed integration and its
connector key.

Logout is idempotent: an absent or already-expired session exits `0`. A `401` during logout does not ask you to sign in again. This does not confirm revocation of other devices; `revocationConfirmed` remains `false`.

If the daemon cannot be reached, logout still clears the local login credential.
It exits nonzero and reports that server revocation was not confirmed;
`--json` includes `authenticated: false` and `revocationConfirmed: false`.
For `--all`, sessions on other devices might still be active until revocation
can be completed from an authenticated client.

## Troubleshooting

- **Unavailable:** check the registered URL, server, TLS, firewall, and private
  network. Do not start a replacement local daemon.
- **401:** sign in again. CLI authentication failures exit with code `3`.
- **403:** inspect the JSON reason and ask an administrator to check your agent
  assignment or permissions. CLI permission failures exit with code `4`.
- **No tools:** restart the harness and inspect its managed hooks, plugin, or
  `signet connector mcp <harness>` launcher. Keys do not belong in that config.
- **Exposed key:** have it revoked, reconnect, and run doctor. Removing a string
  from a local file does not revoke the server credential.

## Dashboard connector status and recovery

The local dashboard reads the normalized `connectors` array from:

```text
GET /api/harnesses
```

The daemon derives this array from its registered harness connector loaders.
Each entry reports its `id`, display name, `detected`, `installed`,
`configured`, and `relevant` state, plus the last health result and supported
recovery capabilities. `icon` is the connector-provided filename for a
bundled local brand asset under the dashboard's `/logos/` directory; clients
fall back to a generic mark when it is absent or unavailable. The dashboard only shows entries marked `relevant`,
so merely supporting a harness does not add an unused row to the home page.
The legacy `harnesses` and `configuredHarnesses` fields remain available to
setup flows.

Installation markers alone do not prove runtime health: the shared default
inspection reports Not verified with an explicit unverified-health diagnostic. A
connector-specific probe may report Healthy, Degraded, or Needs auth when it can
validate the corresponding runtime condition; registry-derived states such as a
detected but unconfigured harness remain Degraded. Inspection runs outside
the HTTP process in a child process, with a five-second deadline per connector. A timed
out or failed inspection stays visible without suppressing other connectors.
Requests cancel their child processes on disconnect; daemon shutdown waits for cleanup.
The child also enforces its own lifetime if the daemon exits abruptly.
Only one inspection per connector can run at a time; overlapping checks report
that the connector is busy and can be retried.

Refresh one connector without reloading the dashboard:

```text
GET /api/harnesses/<id>/health
```

Recovery actions are worker-isolated and require the `admin` permission:

```text
POST /api/harnesses/<id>/repair
POST /api/harnesses/<id>/reinitialize
```

When the connector advertises that reinitialization can change its owned
configuration, the request must include `{ "confirm": true }`. Reinitialize
then runs the connector's canonical initialization path; both actions return
their result or the actionable failure message, and clients should run the
health endpoint immediately afterward.

## Related docs

- [Authentication](/auth/)
- [Harnesses](/harnesses/)
- [CLI integrations and security](/cli/integrations-security/)
- [Self-Hosting](/self-hosting/)
