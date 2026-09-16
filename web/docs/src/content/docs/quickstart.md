---
title: "Quickstart"
description: "Install Signet, create a workspace, and use memory in your first session."
---

This is the shortest path from an installed CLI to a working local memory workspace.

## 1. Install

On macOS or Linux:

```bash
curl -fsSL https://signetai.sh/install.sh | bash
```

On Windows x64, run the PowerShell installer:

```powershell
iwr -useb https://signetai.sh/install.ps1 | iex
```

Check the installed CLI:

```bash
signet --help
```

See [Install](/getting-started/install/) for package-manager options and platform notes.

## 2. Set up a workspace

```bash
signet setup
```

Follow the dashboard wizard to choose a workspace and configure optional connections. Setup initializes the database and starts the configured local daemon. See [Set up Signet](/getting-started/setup/) for wizard details.

## 3. Check status

```bash
signet status
```

The status command reports the installed CLI, workspace, daemon, and memory state.

## 4. Save a memory

```bash
signet remember "Use Bun for this project" --tags project,tooling
```

## 5. Recall it

```bash
signet recall "Which package manager should this project use?"
```

Signet uses hybrid keyword and vector search. Embeddings are configured during setup and are optional for explicit memory storage.

## Next steps

- [Your first session](/getting-started/first-session/) for the core memory workflow.
- [Connect sources](/getting-started/connect-sources/) to add files or external knowledge.
- [Memory and search commands](/cli/memory-search/) for filters and automation.
- [Operate your installation](/getting-started/operate/) for updates and logs.
- [CLI reference](/cli/) for the complete command surface.
