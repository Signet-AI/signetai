---
name: provider-sdk-upgrades
description: "Upgrade provider SDKs and refresh bundled model presets; NOT for unrelated provider architecture."
---

# Provider SDK Upgrades

Use this workflow when upgrading a provider SDK that supplies runtime model metadata or when refreshing Signet's static presets to match an SDK catalog. Treat SDK metadata, application presets, lockfile resolution, and user-facing defaults as one compatibility surface.

## When to Use

- Upgrade a provider or agent SDK used by Signet's inference path.
- Refresh curated model presets, provider model IDs, or defaults from an SDK catalog.

## Prerequisites

- Work in the assigned Signet worktree and read root `AGENTS.md`, relevant package guidance, manifests, implementation, and tests.
- Trace production callers of the SDK and catalog before editing.
- Check the current package registry and upstream release source; don't trust remembered versions or model IDs.

## How to Run

1. Establish the latest published SDK versions from the configured registry, including dist-tags and package metadata. Inspect the corresponding upstream release/tag for contract changes.
2. Inspect the repository's package manifests, lockfile, static catalog, defaults, model registry, and provider tests. Determine which model IDs are SDK-backed, harness-provided, or external-provider IDs; don't conflate those namespaces.
3. Upgrade only the packages and workspaces that actually consume the changed API. Update the lockfile with the repository's package manager and verify a frozen install.
4. Refresh static presets only from verified provider/model metadata. Preserve intentional aliases and defaults; remove an old preset only when the supported replacement is clear. Keep tests independent of catalog ordering.
5. Assert SDK-backed presets against the registry resolved from the real consuming workspace, not root/global `node_modules` or a separately installed version. Check production imports against installed package exports and declarations.
6. Run focused catalog, model-registry, provider, OAuth/setup, and route tests. Then run affected workspace typechecks and builds, root lint/format checks, and `git diff --check`.
7. For failures, capture full output and compare the same command on a clean base worktree before classifying it as pre-existing. A fallback build with special flags is supplemental evidence, not a replacement for an unexplained standard-build failure. Compare security audit results on base and head; never treat a shared nonzero audit exit as proof there is no new advisory.
8. Request an independent, read-only adversarial review of the exact commit. Require exact SHA/worktree reporting and have it verify registry IDs, exports/types, lockfile scope, defaults, and real workspace resolution.
9. Classify a dependency/model-list refresh as `chore`, not `feat`, unless it adds a user-facing capability beyond updating available provider choices.
10. For implementation delivery, follow the repository PR gate: use its exact template, disclose actual test limitations, publish ready for review, and verify the remote PR title/body/head/check state. Do not claim checks complete while required CI remains pending.

## Quick Reference

```text
npm view <package> dist-tags --json
npm view <package>@<version> version dist.tarball --json
bun install --frozen-lockfile
bun test <focused test paths>
bun run typecheck
bun run lint
bun run format:check
git diff --check
```

## Pitfalls

- Registry `latest` is time-sensitive; resolve it live and record the exact version.
- A TypeScript pass may not prove production package exports or runtime resolution. Probe imports from the actual consumer workspace.
- Model catalogs may contain API-specific IDs, aliases, harness names, and routed third-party names. Validate each against its real owner rather than applying one SDK registry check to all.
- Sorting or SDK catalog order can change; select by stable identifiers/API fields, not array position.
- A green focused test set does not override a failing required CI gate or full suite.
- Preserve exact logs and exit statuses for base/head comparisons. Don't infer an audit delta or pre-existing failure from two nonzero exit codes alone.

## Verification

Before reporting completion, record the exact commit and worktree, focused test results, typecheck/lint/format/build outcomes, base-versus-head classifications for failures, independent review verdict, and live PR check state. Leave unresolved failures and queued/in-progress checks explicit.
