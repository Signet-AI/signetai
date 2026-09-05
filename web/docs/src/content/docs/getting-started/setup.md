---
title: "Set up Signet"
description: "Understand the current setup wizard, identity presets, and workspace boundaries."
---

## Run setup

```bash
signet setup
```

The wizard is interactive by default. If a workspace already exists, it detects and reconfigures that installation. For a new workspace, it can also offer a GitHub import instead of creating a fresh one.

## What the wizard asks

The exact branches depend on your answers, but a fresh interactive setup follows this order:

1. **Identity mode**: let Signet manage identity files or turn identity management off.
2. **Identity preset**: when managed identity is selected, choose Minimal, Hermes, OpenClaw, or Custom.
3. **Agent name** and then selected **harnesses**, including Kimi CLI when it is installed or selected explicitly. OpenClaw adds an opt-in workspace patch and a plugin-or-legacy integration choice when its configuration is detected.
4. **Description** and optional core plugins: Signet Secrets and GraphIQ.
5. **Daemon hosting**: local-only, local with Tailscale/network access, or a remote daemon URL. This is the interactive hosting question. `--deployment-type` is not prompted here.
6. **Embedding search**: built-in, Ollama, OpenAI, or no embeddings, followed by model/search choices when applicable.
7. **Background inference**, including provider connection or a choice to disable it. The wizard warns that remote APIs can incur usage costs. It can optionally use a distinct provider for aggregate recall.
8. Optional advanced search and memory settings, Dreaming, Git history, named-agent roster entries, and an Obsidian source.
9. A rendered plan and final confirmation before files are written.

For unattended systems, use [the non-interactive setup reference](/cli/getting-started/#signet-setup) rather than trying to feed answers to the wizard.

## Identity modes and presets

Identity management controls Signet-owned prompt files. It does not change the memory database or recall features.

- **Off**: Signet does not create, inject, or sync managed identity files. Your harness-native instructions remain authoritative.
- **Minimal**: normal startup loads `AGENTS.md`; `DREAMING.md` is available only to Dreaming sessions.
- **Hermes**: uses `SOUL.md` as primary identity alongside `AGENTS.md` project context.
- **OpenClaw**: uses the richer AGENTS, SOUL, IDENTITY, USER, and MEMORY identity stack plus special-session prompts.
- **Custom**: starts from Minimal and lets you choose startup files explicitly.

Do not copy a fixed workspace tree into a deployment guide. Setup creates `agent.yaml`, the memory database, and only the identity files selected by the chosen mode and preset. Selected harnesses may create or update their own integration files outside the workspace.

## What setup does after approval

For a local daemon, setup initializes `memory/memories.db`, configures the selected harnesses, starts the daemon, and can warm the built-in embedding model. It reports the files actually created and offers to open the dashboard. With `--remote-url`, it records the remote daemon endpoint instead of starting a local process.

If Git is enabled, setup initializes or uses the workspace repository and commits the initial state when it can. If OpenClaw is linked to the workspace, setup requires an origin remote, a new local snapshot, or an explicit non-interactive bypass before it completes.

## Check the result

```bash
signet status
signet dashboard
```

Use `signet setup` again to reconfigure an existing installation. Use [CLI environment and exit codes](/cli/environment/) before changing workspace variables or running the daemon under service tooling.

## Source checkouts

Setup and workspace migration do not clone the Signet repository. Saving and
recalling memories use the installed application. `signet sync` and application
updates maintain an existing workspace checkout but do not create one.

`signet desktop build` or `signet desktop install` explicitly creates the managed
checkout when needed for a source build. Contributors can also clone the repository
and pass `--repo` to the desktop command. Existing checkouts, local edits, and
branches are preserved; this change does not delete or relocate them. If a managed
desktop checkout was removed, rerun `signet desktop install` to restore its source
build path before the next automatic desktop update.
