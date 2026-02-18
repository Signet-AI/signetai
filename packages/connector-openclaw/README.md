# @signet/connector-openclaw

Signet connector for OpenClaw (and its earlier names: clawdbot, moltbot).

## Overview

Unlike other harnesses, OpenClaw reads `~/.agents/AGENTS.md` directly, so no
generated output file is needed. Instead, this connector patches the JSON
config to point OpenClaw at the Signet workspace and enables memory hooks.

## Installation

```bash
npm install @signet/connector-openclaw
# or
bun add @signet/connector-openclaw
```

## Usage

```typescript
import { OpenClawConnector } from '@signet/connector-openclaw';

const connector = new OpenClawConnector();
await connector.install('~/.agents');
```

## What It Does

- Patches JSON config files: `~/.openclaw/openclaw.json`,
  `~/.clawdbot/clawdbot.json`, `~/.moltbot/moltbot.json`
- Sets `agents.defaults.workspace` to point at `~/.agents`
- Enables the `signet-memory` internal hook entry
- Creates hook handler files in `~/.agents/hooks/agent-memory/` for
  `/remember`, `/recall`, and `/context` commands

## API

### `install(basePath: string): Promise<InstallResult>`

Install the connector. Patches all found OpenClaw config files and installs
hook handler files.

### `uninstall(basePath?: string): Promise<UninstallResult>`

Uninstall the connector. Disables the `signet-memory` hook in all configs
and removes hook handler files.

### `isInstalled(): boolean`

Check whether any OpenClaw config has signet-memory enabled.

## Idempotent

Safe to run multiple times. Re-running `install()` will update configs and
hook files to the current expected state without duplicating or corrupting
existing configuration.

## License

MIT
