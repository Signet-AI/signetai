---
title: "Kimi Harness and Provider Support"
---

# Kimi Harness and Provider Support

Phase 1 adds Kimi CLI as an integration surface without adding a second Kimi-specific inference runtime. The CLI connector manages Kimi lifecycle hooks and MCP registration, setup detects current and legacy Kimi homes, and the canonical ACPX route exposes the `kimi` agent.

## Scope

- Connector configuration in Kimi `config.toml` and `mcp.json`.
- Core setup detection for `~/.kimi` and legacy `~/.kimi-code`.
- CLI setup and hook configuration.
- Dashboard and daemon ACPX agent catalogs.
- No Rust runtime, provider-safety legacy path, or separate direct Kimi provider.

## Runtime gate

ACPX 0.12.1 recognizes the `kimi` agent and starts Kimi Code CLI 1.2. A live prompt reaches Kimi's ACP session, which currently returns `Authentication required` when Kimi is not authenticated. This is an external Kimi authentication prerequisite, not a Signet connector failure. Phase 1 therefore exposes the route and reports the authentication error without fabricating a successful generation.

## Configuration contract

The connector writes only the allowed Kimi hook fields: `event`, `command`, and `timeout`. Managed hook blocks are identified by their Signet hook command and removed before regeneration. Unrelated TOML tables, user hooks, and MCP servers remain unchanged. Repeated installation is idempotent.
