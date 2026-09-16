---
title: "Your first session"
description: "Save and retrieve your first Signet memory."
---

After [setup](/getting-started/setup/), use the CLI to verify the workspace and exercise the core memory path.

## Check status

```bash
signet status
```

To inspect the workspace in the dashboard:

```bash
signet dashboard
```

## Save a memory

```bash
signet remember "Use Bun for this project"
```

Add tags with `--tags project,tooling`, or pin an important memory with `--critical`. See [memory and search commands](/cli/memory-search/) for the complete write options.

## Recall the memory

```bash
signet recall "What package manager does this project use?"
```

Recall searches the available keyword and vector indexes and applies the current agent and visibility scope. Use `--json` for machine-readable output.

## Continue

- [Connect sources](/getting-started/connect-sources/) to add documents or external knowledge.
- [Memory and search](/memory/) for retention, filters, and retrieval behavior.
- [Operate your installation](/getting-started/operate/) for daemon commands and troubleshooting.
- [CLI reference](/cli/) for automation.
