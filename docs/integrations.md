# Integration and packaging traps

## Older OpenClaw fires two prompt hooks per turn

Without the `messages` field, older OpenClaw fires both `before_prompt_build` and `before_agent_start` on the same turn. The memory adapter keeps generation counters per hook so only one of the pair advances the turn counter.

Trap: a `Set` of seen turns looks equivalent but leaves a stale flag when `before_agent_start` misses a turn.

Owner: `integrations/openclaw/memory-adapter/src/index.ts`.

## macOS Gatekeeper is checked after notarization

Electron-builder's pre-notarization Gatekeeper assessment stays disabled. The release verifier checks the signed bundle with `codesign`, validates the stapled ticket with `xcrun stapler`, and runs a quarantined copy through `spctl` before upload. That post-notarization check is the authoritative one.

Owner: `surfaces/desktop/scripts/verify-macos-release.mjs`, `surfaces/desktop/package.json`.
