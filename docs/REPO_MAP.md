# Repository Map

Signet is organized by developer intent rather than by one generic `packages/`
bucket.

```text
platform/      engine/runtime code: core, daemon, daemon-rs, predictor, native
surfaces/      human-facing ways to operate Signet: CLI, dashboard, desktop, tray, extension
integrations/  external harness integrations grouped by tool
plugins/       Signet-native plugins loaded by Signet
libs/          reusable developer libraries
dist/          assembled shipping artifacts
web/           marketing site and Cloudflare workers
memorybench/   benchmark harness, datasets, providers, reports, and UI
```

Placement rule of thumb:

- If it powers Signet underneath, it belongs in `platform/`.
- If a human runs or looks at it, it belongs in `surfaces/`.
- If another tool uses it to connect to Signet, it belongs in `integrations/<tool>/`.
- If Signet itself loads it as a plugin, it belongs in `plugins/`.
- If it is a reusable developer library, it belongs in `libs/`.
- If it assembles or ships the product, it belongs in `dist/`.
- If it is a benchmark harness or benchmark UI, it belongs in `memorybench/`.

External integrations are grouped by tool first. For example, OpenCode support
lives under `integrations/opencode/`, with `connector/` for install-time Signet
setup and `plugin/` for the runtime plugin loaded by OpenCode.

## Common package locations

| Package or area | Location |
|---|---|
| `@signetai/core` | `platform/core/` |
| `@signet/daemon` | `platform/daemon/` |
| `platform/daemon-rs` | `platform/daemon-rs/` |
| `@signet/native` | `platform/native/` |
| `@signet/cli` | `surfaces/cli/` |
| `signet-dashboard` | `surfaces/dashboard/` |
| `@signet/desktop` | `surfaces/desktop/` |
| `@signet/tray` | `surfaces/tray/` |
| `@signet/extension` | `surfaces/browser-extension/` |
| `@signet/sdk` | `libs/sdk/` |
| `@signetai/connector-base` | `libs/connector-base/` |
| `@signet/connector-*` | `integrations/<tool>/connector/` |
| external runtime plugins | `integrations/<tool>/plugin/` |
| Signet-native plugins | `plugins/<scope>/<name>/` |
| `signetai` | `dist/signetai/` npm/Bun wrapper for the compiled Signet binary |
| marketing site | `web/marketing/` |
| Cloudflare workers | `web/workers/<worker>/` |
| MemoryBench | `memorybench/` |

## Rules for agents

Do not recreate `packages/`. New work should fit one of the top-level
intent folders above. If a doc references `packages/*`, treat it as stale
unless it appears in historical research, an archived spec, or a test fixture
that intentionally preserves old text.

For a new harness integration, create `integrations/<tool>/connector/`. If
that tool also loads a runtime plugin, put the external-tool plugin beside the
connector under `integrations/<tool>/plugin/` or another tool-specific role
name. Reserve `plugins/` for plugins loaded by Signet itself.

`repo.map.yaml` is the machine-readable companion to this document.
