---
title: "Quickstart"
description: "Install Signet, create a workspace, and use memory in your first session."
---

This tutorial takes a local installation from zero to a working memory command. It uses the interactive setup route; use the reference pages when you need a managed or remote deployment.

## 1. Install Signet

On macOS or Linux, install the native binary:

```bash
curl -fsSL https://signetai.sh/install.sh | bash
signet --help
```

On Windows x64, use the PowerShell installer:

```powershell
iwr -useb https://signetai.sh/install.ps1 | iex
```

See [Install](/getting-started/install/) for package-manager alternatives and non-interactive setup.

## 2. Create a workspace

```bash
signet setup
```

Setup prepares a minimal local workspace and opens guided dashboard onboarding: connect the agents and model you choose, optionally bring an Obsidian vault, transcript exports, or files, then test and save a first memory. The default interactive path does not preselect providers or harnesses, create identity files, install skills, or initialize Git. Provider processing starts only after your explicit connection test and enable action. See [Set up Signet](/getting-started/setup/) for the flow and recovery steps.

Fresh interactive setup leaves identity management off and creates no identity files. Configure an identity preset later if you want Signet-managed prompt files; scripted CLI setup still supports `--identity-mode` and `--identity-preset`.

The CLI creates the protected workspace and database bootstrap, starts a local daemon unless the workspace targets a remote one, and opens the dashboard directly to onboarding.

## 3. Check the installation

```bash
signet status
signet dashboard
```

`signet dashboard` opens the local dashboard and starts the local daemon when necessary. If setup points the workspace at a remote daemon, the CLI uses that configured daemon URL instead.

## 4. Save and recall a memory

```bash
signet remember "Use Bun for this project" --tags project,tooling
signet recall "Which package manager should this project use?"
```

Use `--critical` with `signet remember` to pin a memory. Recall combines the available keyword and embedding search paths; setup can run without embeddings if you prefer.

## Next steps

- [Set up Signet](/getting-started/setup/): identity presets, hosting, harnesses, and setup plans.
- [Your first session](/getting-started/first-session/): memory, secrets, skills, and daemon commands.
- [Operate your installation](/getting-started/operate/): updates, logs, workspace changes, and troubleshooting.
- [Authentication](/auth/): team and remote-daemon authentication.
- [CLI reference](/cli/): command reference and automation environment contracts.
