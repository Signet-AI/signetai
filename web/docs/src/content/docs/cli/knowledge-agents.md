---
title: "Knowledge, agents, and context"
description: "Inspect Signet's structured knowledge, agent roster, Dreaming, and context artifacts from the CLI."
---

This page covers the CLI commands for structured knowledge, named agents, Dreaming, and compiled context artifacts. Run `signet <command> --help` for the complete option set in the installed build.

All commands operate in an agent scope. Use `--agent <name>` where the command supports it; the default scope is `default`. Use `--json` for machine-readable output on commands that expose it.

## Agents

`signet agent` manages the named-agent roster and its memory read policy.

| Command | Purpose |
| --- | --- |
| `signet agent list` | List the configured agents. |
| `signet agent add <name>` | Add an agent with `--memory isolated\|shared\|group` and an optional `--group`. |
| `signet agent info <name>` | Inspect one agent. |
| `signet agent show <name>` | Show the agent's identity and configuration. |
| `signet agent set <name>` | Update an agent's configuration. |
| `signet agent remove <name>` | Archive an agent while retaining its identity files. |
| `signet agent purge <name> --force` | Permanently remove an agent and its memories after confirmation. |

Agent names use lowercase letters, numbers, and hyphens. The `default` agent is reserved.

## Knowledge

`signet knowledge` reads the current structured knowledge graph.

| Command | Purpose |
| --- | --- |
| `signet knowledge tree <entity>` | Print the aspects, groups, and claims under an entity. |
| `signet knowledge entities` | List entities with counts of related records. |
| `signet knowledge entity <name>` | Resolve one entity by name. |
| `signet knowledge aspects <entity>` | List aspects under an entity. |
| `signet knowledge groups <entity> <aspect>` | List claim groups under an aspect. |
| `signet knowledge claims <entity> <aspect>` | List claims under an aspect. |
| `signet knowledge attributes <entity> <aspect>` | List attribute versions under an aspect. |
| `signet knowledge hygiene` | Inspect duplicate, suspicious, and incomplete knowledge records. |

These commands inspect current ontology state. Use the HTTP API or `signet ontology` for audited mutations.

## Ontology operations

`signet ontology` exposes inspected and audited ontology operations. The command has these groups:

| Group | Covers |
| --- | --- |
| `proposals`, `proposal`, `evidence` | List and inspect proposed operations and their supporting evidence. |
| `link-evidence`, `claim-evidence`, `explain-claim` | Connect or explain evidence for ontology claims. |
| `conflicts`, `contradictions`, `assertions` | Inspect competing values, contradictions, and epistemic assertions. |
| `assertion` | Create, link, archive, supersede, import, or inspect assertions. |
| `extract`, `consolidate` | Run explicit ontology extraction and consolidation operations. |
| `objects`, `object`, `links`, `claims` | Inspect ontology objects, relationships, and versioned claims. |
| `entity`, `aspect`, `claim`, `link` | Apply audited entity, aspect, claim, and relationship operations. |
| `stream` | Apply a JSONL operation stream. |
| `pipeline` | Inspect Pipeline V2 compatibility and mutation state. |
| `config` | Show, validate, explain, repair, propose, import, apply, or reject ontology configuration. |

Mutating ontology commands require the daemon and the permissions described by the command help. They write an auditable operation with its resolved agent scope.

## Dreaming

`signet dream` manages the daemon-owned semantic-maintenance path.

| Command | Purpose |
| --- | --- |
| `signet dream capabilities` | List available Dreaming capabilities. |
| `signet dream tool <capability> --input '<json>'` | Invoke one capability with a JSON object. Add `--agent` or `--pass-id` when required by the capability. |
| `signet dream status` | Show the worker, threshold, and recent passes. |
| `signet dream attach` | Follow an active pass in the terminal. |
| `signet dream trigger` | Request a bounded Dreaming pass and follow its result. |

Dreaming reads bounded, agent-scoped evidence and records semantic changes through the audited ontology path. Its status and pass result identify completed, failed, cancelled, or timed-out work.

## Context artifacts

`signet context compile` compiles selected identity and operating-policy files into a bounded context artifact.

```bash
signet context compile \
  --profile coding \
  --sources AGENTS.md,USER.md,IDENTITY.md,SOUL.md \
  --max-chars 2200
```

Use `--dry-run` to print the generated artifact without writing it. `--output <path>` selects a workspace-relative output path. `--agent`, `--policy`, `--target`, and `--timeout` select the inference scope and deadline.

The command rejects unsafe source and output paths, keeps the generated result within the workspace, and reports the character count and truncation state.

## Machine-readable output

Commands with `--json` return a JSON object or array on standard output. Keep diagnostics on standard error when composing commands in scripts, and check the process exit code before using the result.
