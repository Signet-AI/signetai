# Oh My Pi Integration

Signet connector for Oh My Pi.

## What It Does

Integrates Signet's memory system with Oh My Pi via its extension mechanism.

- Installs a managed Signet extension into the Oh My Pi extensions directory
- Configures the agent workspace path in Oh My Pi's config
- Handles migration from legacy `.mjs` extension format to current `.js` format
- Detects and resolves multiple candidate agent directories

## Installation

```bash
signet setup --harness oh-my-pi
```

Interactive setup can also detect Oh My Pi and offer to configure it.

## Uninstallation

The connector package exposes programmatic cleanup that removes the extension file and clears workspace configuration. Your memories are preserved in the Signet daemon.

## Package

| Field | Value |
|-------|-------|
| Package | `@signetai/connector-oh-my-pi` |
| License | Apache-2.0 |

## Architecture

```
<oh-my-pi-extensions>/signet-oh-my-pi.js  <-- managed extension
<oh-my-pi-config>/config.json             <-- agent dir configured here
~/.agents/                                <-- agent workspace
```

The connector extends `BaseConnector` from `@signetai/connector-base` and ships a bundled extension that is written to disk on install.
