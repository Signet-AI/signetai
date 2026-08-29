---
title: "Kimi Code (Kimi CLI)"
description: "Connect Signet to Kimi Code through ACPX, MCP, and lifecycle hooks."
---

Signet can configure Kimi Code as an ACPX harness and install lifecycle hooks for session continuity.

## Setup

Select Kimi Code in the interactive wizard, or run:

```bash
signet setup --harness kimi
```

The connector writes Signet-managed entries to the Kimi `config.toml` hook array, merges the Signet MCP server into `mcp.json`, and links the workspace skills directory into the selected Kimi home. It preserves unrelated TOML sections, user hooks, and other MCP servers. Re-running setup refreshes only Signet-owned entries.

Kimi Code normally uses `~/.kimi`. Signet also recognizes the legacy `~/.kimi-code` home. `KIMI_SHARE_DIR` and `KIMI_CODE_HOME` can select an explicit home for setup and detection.

## ACPX authentication

Signet routes background inference through ACPX with `executor: acpx` and `acpx.agent: kimi`. Kimi's ACP service still requires its own authentication. If ACPX reports `Authentication required`, authenticate Kimi first and retry the route.

The Kimi connector does not write API keys into `config.toml`, hook commands, or `mcp.json`. Remote daemon values are passed through the existing Signet hook environment contract.

## Hook behavior

Signet installs three Kimi lifecycle events:

- `SessionStart`: fetches the scoped Signet context and emits Kimi-compatible JSON output.
- `UserPromptSubmit`: appends the current prompt context through the existing hook command.
- `SessionEnd`: records the end event without injecting visible context.

Kimi hook commands receive their payload on standard input. Manage identity and memory in the Signet workspace, not by editing the generated hook entries.

## Remove the integration

Run setup again without Kimi selected, or use the connector uninstall command exposed by the connector tooling. Uninstall removes only Signet-owned hooks, the Signet MCP entry, and the Signet skills link. Kimi is supported for setup, hooks, MCP, and ACPX inference.
