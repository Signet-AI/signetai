---
title: "Remote Harness Connectors"
description: "Sign in once and connect each harness without putting credentials in its configuration."
---

A harness connects to one Signet daemon. Its target and credential live in the
Signet connector registry, not in hook commands, MCP configuration, or harness
environment assignments. A remote connection never silently switches to the
local daemon when the remote daemon is unavailable.

## Sign in and connect

Your administrator supplies the URL of a reachable team daemon and authorizes
your account. Use HTTPS outside a trusted private network. Install the Signet
CLI and your harness on the client machine, then run:

```bash
signet login --url https://signet.example.com
signet whoami
signet connect codex --agent alice
signet connector list --json
```

`login` prints a user code and opens the approval page in your browser. On a
headless machine, add `--device-code` and open the printed URL on another device.
Signet saves the refresh credential through its login store; it never prints it.

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
the daemon rather than uploading its contents.

```bash
signet connect claude-code
```

## Rotate or disconnect

```bash
signet connector rotate codex
signet disconnect codex
```

Reconnecting or rotating refreshes the managed integration and removes legacy
inline Signet credentials. Rotation verifies revocation of the previous key
before replacing local state. If subsequent provisioning fails, the old key can
already be revoked: fix the reported error and reconnect.

Disconnect revokes the server-side key, uninstalls the integration, and removes
its registry entry and key file. Already-revoked keys do not prevent cleanup.
If the server is unavailable, Signet reports failure and retains local state for
a retry; it does not claim that disconnect completed.

Never pass a key in argv or save it in a harness config. Automation that already
holds an authorized user-session credential can pipe it through
`--api-key-stdin`. A connector or operator key cannot mint a new session-bound
connector key.

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

A `401` prints "Signet session expired, run `signet login`". Rejected session-end
evidence stays in that harness's durable outbox. Sign in to the same instance
and reconnect or run doctor to trigger replay. Permission-denied captures are
quarantined, not discarded or sent under another agent.

Remote file capture is recorded in the outbox before the client reads the
transcript. The current daemon has no chunked transcript-upload route, so files
above the 4 MiB inline limit remain pending as file references rather than being
discarded or loaded into an unbounded buffer. Keep the original transcript file;
doctor reports the pending capture, and replay retains it until delivery can
complete. Capture failures exit `1` and include a reason with `--json`.

`logout` revokes your current login session; `logout --all` revokes your sessions
on other devices too. Use disconnect to remove an installed integration and its
connector key.

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
