# Pi Integration

Signet connector for Pi.

## What It Does

Integrates Signet's memory system with Pi via its extension mechanism.

- Installs a managed Signet extension into the Pi extensions directory
- Configures the agent workspace path in Pi's config
- Detects and resolves multiple candidate agent directories
- Ships a bundled extension that is written to disk on install
- Exposes Signet-specific tools: `signet_recall`, `signet_source_search`, `signet_session_search`, and `signet_remember`

## Installation

```bash
signet setup --harness pi
signet connect pi --url http://signet-home.tailnet:3850 --api-key sig_sk_...
```

Interactive setup can also detect Pi and offer to configure it. On a machine
where you only want to install the Pi integration, use the standalone npm
installer:

```bash
npx -y @signetai/connector-pi install --url http://signet-home.tailnet:3850 --api-key sig_sk_...
```

## Uninstallation

The connector package exposes programmatic cleanup that removes the extension file and clears workspace configuration. Your memories are preserved in the Signet daemon.

## Package

| Field | Value |
|-------|-------|
| Package | `@signetai/connector-pi` |
| License | Apache-2.0 |

## Compatibility

The extension works with both **pi** (`@earendil-works/pi-coding-agent`) and
**pi-mono** (`@mariozechner/pi-coding-agent`, the older monorepo fork, e.g.
v0.66.x). Both resolve the agent dir the same way (`~/.pi/agent`, overridable
via `PI_CODING_AGENT_DIR`), so the connector writes the managed extension to the
same location either variant scans.

The only difference is the session-lifecycle event vocabulary: current pi emits
both the cancellable `session_before_fork` / `session_before_switch` events and
the post-action `session_fork` / `session_switch` events, while pi-mono only
emits the `before` variants. The extension ends the previous session on the
`before` events (fires exactly once per action under either variant) and
refreshes the new session on the post events — falling back to `session_start`
under pi-mono. See [#887](https://github.com/Signet-AI/signetai/issues/887).

## Architecture

```
<pi-extensions>/signet-pi.js   <-- managed extension
<pi-config>/config.json        <-- agent dir configured here
~/.agents/                     <-- agent workspace
```

The connector extends `BaseConnector` from `@signet/connector-base` and implements `install()` / `uninstall()` for reversible setup.
