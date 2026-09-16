---
title: "Install"
description: "Install the Signet CLI and choose an onboarding route."
---

## Prerequisites

Signet provides native binaries for macOS and Linux. The direct Windows installer supports Windows x64. The direct installers do not require Bun or another runtime.

For non-server deployments, the Signet desktop app is the recommended install path. Use the CLI binary for servers, terminals, and automation.

## Installation channels

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

The macOS binaries are currently unsigned. If Gatekeeper blocks a trusted download, use Finder's **Open** action or **System Settings > Privacy & Security > Open Anyway**. See [updates and installation](/getting-started/operate/) for release and checksum guidance.

## Choose an onboarding route

For an interactive local workspace, continue with [Set up Signet](/getting-started/setup/) and run:

```bash
signet setup
```

For automation or a remote daemon, use the validated flags or a JSON setup plan. Read the installed version's help before scripting a new release:

```bash
signet setup --help
```

The complete setup-plan schema and CLI options are documented in [Install and configure](/cli/getting-started/).
