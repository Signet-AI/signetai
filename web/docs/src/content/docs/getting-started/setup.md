---
title: "Set up Signet"
description: "Use the setup wizard to configure a workspace and its connections."
---

## Start the wizard

```bash
signet setup
```

Setup creates or opens a workspace, initializes its database, reaches or starts the configured daemon, and opens dashboard onboarding. Run it again to resume or revisit setup; use `signet configure` or `signet config` for the same settings flow.

## Complete onboarding

1. Choose or confirm the workspace.
2. Select an agent harness to connect, or continue without one.
3. Configure an optional model connection.
4. Add optional context sources, such as an Obsidian vault or imported files.
5. Save a first memory and confirm that it can be recalled.
6. Start a new conversation in the connected harness, if you configured one.

The wizard reports the checks that completed. Model processing begins after you explicitly enable a tested connection. You can finish the workspace setup first and configure connections later.

## Identity and configuration

Identity management controls Signet-owned prompt files. Choose a preset in the wizard when you want Signet to manage them:

- **Off** leaves harness-native instructions authoritative.
- **Minimal** provides the small default startup context.
- **Hermes** adds the Hermes identity files.
- **OpenClaw** provides the OpenClaw identity stack.
- **Custom** lets you select startup files.

The selected mode and preset determine which files Signet creates. Setup also writes the agent configuration and memory database. See [identity and configuration](/cli/getting-started/) for the full contract.

## Automated setup

Use non-interactive flags or a validated JSON plan for unattended systems:

```bash
signet setup --non-interactive --help
```

Use `--remote-url` when the workspace should use an existing remote daemon. Remote setup does not start a local daemon. The [CLI setup reference](/cli/getting-started/) documents the plan schema and all supported options.

## Check the result

```bash
signet status
```

If the dashboard does not open automatically, use the URL printed by setup or run `signet dashboard`. For daemon lifecycle and recovery, see [Operate your installation](/getting-started/operate/).
