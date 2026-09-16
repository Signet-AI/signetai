---
title: "Install"
description: "Install the Signet CLI and choose an onboarding route."
---

## Installation channels

Signet provides native binaries for macOS and Linux and a direct installer for Windows x64. The installers do not require Bun or another runtime.

On macOS or Linux, use the native installer:

```bash
curl -fsSL https://signetai.sh/install.sh | bash
```

On Windows x64, use PowerShell:

```powershell
iwr -useb https://signetai.sh/install.ps1 | iex
```

You can also install the compiled binary through npm or Bun:

```bash
npm install -g signetai
# or
bun add -g signetai
```

Choose one method per machine, then open a new shell if your PATH changed:

```bash
signet --help
```

## Choose an onboarding route

For an interactive local workspace, continue with [Set up Signet](/getting-started/setup/) and run:

```bash
signet setup
```

For automation or a remote daemon, read the installed version's setup options:

```bash
signet setup --help
```

The setup-plan schema and CLI options are documented in [Install and configure](/cli/getting-started/).
