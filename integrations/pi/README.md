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
npx -y @signet/connector-pi install --url http://signet-home.tailnet:3850 --api-key sig_sk_...
```

## Uninstallation

The connector package exposes programmatic cleanup that removes the extension file and clears workspace configuration. Your memories are preserved in the Signet daemon.

## Package

| Field | Value |
|-------|-------|
| Package | `@signet/connector-pi` |
| License | Apache-2.0 |

## Architecture

```
<pi-extensions>/signet-pi.js   <-- managed extension
<pi-config>/config.json        <-- agent dir configured here
~/.agents/                     <-- agent workspace
```

The connector extends `BaseConnector` from `@signet/connector-base` and implements `install()` / `uninstall()` for reversible setup.
