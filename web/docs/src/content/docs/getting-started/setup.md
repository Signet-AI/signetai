---
title: "Set up Signet"
description: "Use the setup wizard to configure a workspace and its connections."
---

## Start the wizard

```bash
signet setup
```

Setup creates or opens a workspace, initializes its database, starts the configured daemon, and opens dashboard onboarding. Run it again to revisit setup. Use `signet configure` or `signet config` to open connection settings later.

## Complete onboarding

1. Choose or confirm the workspace.
2. Select an agent harness to connect, or continue without one.
3. Configure an optional model connection.
4. Add optional context sources, such as an Obsidian vault or imported files.
5. Save a first memory and confirm that it can be recalled.
6. Start a new conversation in the connected harness, if you configured one.

You can finish workspace setup first and configure connections later.

## Automated setup

Use non-interactive flags or a validated JSON plan for unattended systems:

```bash
signet setup --non-interactive --help
```

Use `--remote-url` when the workspace should use an existing remote daemon. Remote setup does not start a local daemon. The [CLI setup reference](/cli/getting-started/) documents the plan schema and supported options.

## Check the result

```bash
signet status
```

If the dashboard does not open automatically, run `signet dashboard`. For daemon lifecycle, see [Operate your installation](/getting-started/operate/).
