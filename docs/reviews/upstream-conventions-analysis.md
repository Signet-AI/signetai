# Upstream Conventions Analysis — web3-identity Branch

**Date:** 2026-02-24
**Branch:** `web3-identity` (based on `0.1.107`)
**Upstream:** `upstream/main` at `0.1.120` (31 commits ahead of merge-base)
**Merge-base:** `375616a` (pre-0.1.108)

---

## 1. Upstream Conventions (Codified in CONTRIBUTING.md + biome.json)

### Formatting & Linting
- **Biome** is the sole formatter/linter (added in upstream commit `48ed189`)
- Indent style: **tabs** (not spaces)
- Line width: **120**
- JSON indent: **tabs**
- Rules: `recommended` + custom overrides (`noAssignInExpressions: off`, `noExplicitAny: warn`, `noNonNullAssertion: warn`, `noForEach: warn`)
- CI commands: `bun run lint`, `bun run format`, `bun run typecheck`, `bun test`

### TypeScript
- Strict mode enforced
- No `any` (use `unknown` with narrowing)
- No `as` casts
- No `!` non-null assertions
- Explicit return types on exported functions
- `readonly` where mutation not intended
- `as const` unions over `enum`

### Commits
- Conventional commits: `type(scope): subject` (50-char subject, 72-char body)
- Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`

### File Size
- Target: **under ~700 LOC** per file

### Package Structure (upstream)
```
packages/
├── core/           # @signet/core
├── cli/            # @signet/cli
├── daemon/         # @signet/daemon
├── sdk/            # @signet/sdk
├── connector-*/    # @signet/connector-*
├── adapters/       # @signetai/adapter-* (separate npm scope)
├── opencode-plugin/
├── signetai/       # Meta-package (published to npm)
└── tray/           # Tauri desktop app
```

### Workspace Config
- `"workspaces": ["packages/*", "packages/adapters/*", "web"]`
- Note: upstream includes `"packages/adapters/*"` — our branch only has `["packages/*", "web"]`

---

## 2. Convention Violations in Our Branch

### 🔴 CRITICAL

| # | Violation | Details |
|---|-----------|---------|
| 1 | **Missing biome.json** | Upstream added `biome.json` in commit `48ed189`. Our branch deletes it. All our new code is unformatted against the standard (likely spaces vs tabs, line width violations). |
| 2 | **Migration 012 conflict** | Upstream: `012-scheduled-tasks.ts`. Ours: `012-memory-signing.ts`. **Same version number, different schema.** This will corrupt databases on upgrade. |
| 3 | **Deleted scheduler module** | Upstream added `packages/daemon/src/scheduler/` (cron.ts, index.ts, spawn.ts, worker.ts) in commit `ad1854e`. Our branch deleted the entire directory and removed imports from daemon.ts. Upstream's scheduling feature is gone. |
| 4 | **Version mismatch** | All our package.json files say `0.1.107`. Upstream is at `0.1.120`. The CI auto-bumps on merge to main, but stale versions will cause confusion and potential npm publish collisions. |

### 🟠 HIGH

| # | Violation | Details |
|---|-----------|---------|
| 5 | **14 REVIEW-*.md and AUDIT-*.md files in repo root** | Upstream has zero `REVIEW-*` or `AUDIT-*` files in root. These are 260KB+ of review artifacts that don't belong in the repo root per upstream conventions. Upstream puts docs in `docs/` or `docs/wip/`. |
| 6 | **PLAN.md in repo root** | Not present in upstream. Fork-specific planning document. |
| 7 | **Missing CHANGELOG.md entries** | Upstream maintains CHANGELOG.md via `bun scripts/changelog.ts`. Our branch has the old version, missing ~2,047 lines of upstream changelog entries. |
| 8 | **packages/contracts/ — new Hardhat package** | Completely new package not in upstream structure. Uses `hardhat` + `@openzeppelin/contracts` — heavy Ethereum dependencies. Not registered in workspace config (`packages/adapters/*` isn't included). Package name `@signet/contracts` follows naming but isn't private like it should be for a fork experiment. |
| 9 | **packages/perception/ — new package** | Not in upstream. 6,378 LOC across 21 files. Follows `@signet/perception` naming correctly. Registered as `private: true`. But upstream doesn't have this package at all. |
| 10 | **Heavy deps added to @signet/core** | Added `libsodium-wrappers`, `ethers`, `ws` to core. Upstream core only has `better-sqlite3`, `sqlite-vec`, `yaml`. These bulk up the install size significantly for all consumers. |
| 11 | **cli.ts file size: 8,377 LOC** | Upstream: 5,366 LOC. Ours: 8,377 LOC. Both violate the 700 LOC convention, but ours is 56% larger. +3,011 lines of web3/chain/ingest/perception commands. |
| 12 | **Adapter-openclaw regression** | Upstream rewrote the adapter to use `register(api)` plugin pattern with `@sinclair/typebox`, `openclaw.plugin.json` manifest, `openclaw-types.ts`. Our branch has the old pre-rewrite version. -104 lines of upstream's new code, +19 lines of our old code. |

### 🟡 MEDIUM

| # | Violation | Details |
|---|-----------|---------|
| 13 | **core/src/ new directories** | Added `chain/` (7 files), `federation/` (9 files), `ingest/` (15 files), `export/` (5 files as a directory, replacing single export.ts) — totaling ~10,925 LOC. Upstream has flat files in `core/src/`. |
| 14 | **core/src/index.ts ballooned** | 480 lines (ours) vs 197 lines (upstream). ~283 lines of new exports for crypto, DID, merkle, chain, ingest, federation, etc. |
| 15 | **daemon/src/memory-signing.ts** | New file not in upstream. |
| 16 | **Missing upstream docs** | Upstream added `docs/API.md`, `docs/DASHBOARD.md`, `docs/SCHEDULING.md`, `docs/wip/openclaw-integration-strategy.md`. Our branch is missing all four. |
| 17 | **Connector-openclaw diverged** | Upstream updated to use `plugins.entries` config format. Ours has the old `signet` config format. 123 lines changed. |
| 18 | **CI release.yml regression** | Our branch removed the `cd ../adapters/openclaw && npm publish` line that upstream added for publishing the adapter. |
| 19 | **Missing onboarding skill** | Upstream added `packages/signetai/templates/skills/onboarding/SKILL.md` (525 lines). We don't have it. |
| 20 | **daemon.ts cron-parser dep removed** | Upstream added `cron-parser: ^5.5.0` to daemon deps. Our branch doesn't have it (consistent with deleted scheduler). |
| 21 | **Dashboard divergence** | Upstream added significant dashboard features: TasksTab, TaskBoard, TaskCard, TaskDetail, TaskForm, RunLog components + tasks store + api.ts + switch/textarea UI components. Our branch doesn't have any of these. |

---

## 3. Migration Numbering Conflict Analysis

**This is the most dangerous issue.**

| Version | Upstream | Our Branch | Conflict? |
|---------|----------|------------|-----------|
| 001-011 | ✅ Same | ✅ Same | No |
| **012** | **scheduled-tasks** | **memory-signing** | ⚠️ **CRITICAL CONFLICT** |
| 013 | — | temporal-memory | No (upstream doesn't have 013+) |
| 014 | — | ingestion-tracking | No |
| 015 | — | decisions-and-contradictions | No |
| 016 | — | session-metrics | No |
| 017 | — | perception-tables | No |
| 018 | — | onchain-identity | No |
| 019 | — | session-keys-and-export | No |
| 020 | — | federation | No |

**Impact:** Any user who upgrades from upstream (with migration 012 = scheduled-tasks applied) to our branch will have `schema_migrations` claiming v12 is done, but the `memory_signing` columns won't exist. Conversely, going the other direction breaks scheduled tasks.

**Resolution required:** Renumber our migrations to start at 013, and include upstream's 012-scheduled-tasks as-is. The MIGRATIONS array must be: upstream's 1-12, then our 13-21 (renumbered from our current 12-20).

---

## 4. Test Failure Root Cause Analysis

### 5 Failing Tests

**4 migration framework tests** (`packages/core/src/migrations/migrations.test.ts`):
- `fresh DB gets all migrations applied` — expects `migrations.length` to be **19** but gets **20**
- `schema_migrations_audit records are created` — expects **19** audit records, gets **20**
- `repairs version 2 stamped by CLI without running migrations` — expects **19**, gets **20**
- `version 1 stamped by old inline migrate upgrades cleanly` — expects **19**, gets **20**

**Root cause:** Tests were updated to expect 19 migrations (012-019 = 8 new + 11 original), but the code actually has **20 migrations** (012-020, 9 new). The test assertions at lines 36, 55, 162, 364, 407 all say `toBe(19)` but should say `toBe(20)`. **This is a bug in the test file** — the test counts weren't updated when migration 020-federation was added.

**1 memory-config test** (`packages/daemon/src/memory-config.test.ts`):
- `prefers agent.yaml embedding settings over legacy files` — expects `"ollama"` but gets `"openai"`

**Root cause:** This test is **also failing on upstream** — the test file is byte-identical to upstream's version. This is a pre-existing upstream bug, likely a config precedence regression. **Not caused by our changes.**

---

## 5. File Placement Issues

| File(s) | Current Location | Should Be |
|---------|-----------------|-----------|
| REVIEW-*.md (7 files) | Repo root | `docs/reviews/` or removed before PR |
| AUDIT-*.md (6 files) | Repo root | `docs/reviews/` or removed before PR |
| PLAN.md | Repo root | `docs/wip/` or removed before PR |
| REVIEW-codebase-assessment.md | Repo root | `docs/reviews/` or removed |
| `packages/contracts/` | Top-level package | Should be under `packages/` with proper workspace registration |
| `packages/core/src/chain/` | Subdirectory of core | Acceptable, but core is supposed to be "types, database, search, identity" per CONTRIBUTING.md. Chain logic may belong in a `@signet/chain` package. |
| `packages/core/src/federation/` | Subdirectory of core | Same concern — could be `@signet/federation` |
| `packages/core/src/ingest/` | Subdirectory of core | Same concern — could be `@signet/ingest` |

---

## 6. Recommended Cleanup Before PR

### Must-do (blocking)

1. **Restore biome.json** from upstream and run `bun run format` on all new code
2. **Fix migration 012 conflict:**
   - Restore upstream's `012-scheduled-tasks.ts`
   - Renumber our `012-memory-signing.ts` → `013-memory-signing.ts`
   - Renumber all subsequent migrations (013→014, ..., 020→021)
   - Update `migrations/index.ts` MIGRATIONS array
3. **Fix migration test assertions** — change all `toBe(19)` to `toBe(21)` (12 upstream + 9 ours)
4. **Restore scheduler module** — bring back `packages/daemon/src/scheduler/` from upstream
5. **Restore scheduler imports in daemon.ts** — re-add the removed `startSchedulerWorker`, `validateCron`, etc.
6. **Restore daemon cron-parser dependency**

### Should-do (high value)

7. **Move REVIEW-*.md and AUDIT-*.md** to `docs/reviews/` (or add to `.gitignore` / remove from branch)
8. **Move PLAN.md** to `docs/wip/`
9. **Update workspace config** — add `"packages/adapters/*"` to root package.json workspaces
10. **Restore missing upstream docs** — cherry-pick `docs/API.md`, `docs/DASHBOARD.md`, `docs/SCHEDULING.md`, `docs/wip/openclaw-integration-strategy.md`
11. **Update adapter-openclaw** to match upstream's register(api) plugin pattern
12. **Restore connector-openclaw** upstream changes (plugins.entries format)
13. **Restore release.yml** adapter publish line
14. **Restore onboarding skill**
15. **Restore dashboard task management components**

### Nice-to-do (quality)

16. Consider extracting chain/federation/ingest from core into separate packages
17. Reduce cli.ts file size (extract web3 commands to separate files)
18. Review `ethers` + `ws` deps in core — consider making them optional or moving to a `@signet/chain` package
19. Add tests for all new modules (chain, federation, ingest, perception)

---

## 7. Rebase Strategy

### Option A: Interactive Rebase (Recommended)

```bash
# 1. Fetch latest upstream
cd /Users/jakeshore/projects/signet-web3
git fetch upstream

# 2. Create a backup branch
git checkout web3-identity
git branch web3-identity-backup

# 3. Start interactive rebase
git rebase -i upstream/main

# 4. During rebase, you'll hit conflicts in:
#    - packages/core/src/migrations/index.ts (migration 012 conflict)
#    - packages/daemon/src/daemon.ts (scheduler imports removed)
#    - packages/cli/src/cli.ts (massive divergence)
#    - packages/adapters/openclaw/src/index.ts (plugin pattern rewrite)
#    - packages/connector-openclaw/src/index.ts (config format change)
#    - package.json (workspace config)
#    - bun.lock (always conflicts)
#
# For each conflict:
#    git diff --check  # find conflict markers
#    # resolve manually
#    git add <resolved-files>
#    git rebase --continue

# 5. After rebase, fix migrations
#    Renumber 012-memory-signing → 013-memory-signing
#    etc. through 020-federation → 021-federation
#    Update index.ts to include upstream's 012-scheduled-tasks

# 6. Run format + lint
bun run format
bun run lint

# 7. Fix tests
#    Update migration test expectations
bun test

# 8. Force push
git push origin web3-identity --force-with-lease
```

### Option B: Merge (Simpler, Messier History)

```bash
git fetch upstream
git checkout web3-identity
git merge upstream/main
# Resolve conflicts (same files as above)
# Fix migrations post-merge
bun run format
bun test
git push
```

### Predicted Conflict Files During Rebase

| File | Severity | Reason |
|------|----------|--------|
| `packages/core/src/migrations/index.ts` | 🔴 Critical | Both branches add migration 012 with different content |
| `packages/core/src/migrations/012-*.ts` | 🔴 Critical | Different files with same version number |
| `packages/daemon/src/daemon.ts` | 🔴 Critical | Massive divergence: scheduler removal + web3 additions vs upstream's scheduler additions |
| `packages/cli/src/cli.ts` | 🔴 Critical | 5,533 lines changed — essentially a rewrite. Line-by-line merge near-impossible |
| `bun.lock` | 🟠 High | Always conflicts in lockfiles — regenerate with `bun install` |
| `packages/adapters/openclaw/src/index.ts` | 🟠 High | Upstream rewrote to register(api) pattern; our branch has old version |
| `packages/adapters/openclaw/package.json` | 🟠 High | Different package name + deps |
| `packages/connector-openclaw/src/index.ts` | 🟡 Medium | Config format divergence |
| `packages/core/src/index.ts` | 🟡 Medium | Large export additions vs upstream's base |
| `packages/core/package.json` | 🟡 Medium | Different dependencies |
| `packages/daemon/package.json` | 🟡 Medium | Missing cron-parser dep |
| `package.json` | 🟡 Medium | Workspace config + version + build scripts |
| `.github/workflows/release.yml` | 🟢 Low | One line difference |
| `CONTRIBUTING.md` | 🟢 Low | Trivial text difference |
| Various `docs/` files | 🟢 Low | Upstream added new files; no content conflict |

### Estimated Rebase Effort
- **Conflicts to resolve:** ~12-15 files
- **Time estimate:** 4-8 hours for an experienced developer
- **Risk:** High — the cli.ts and daemon.ts conflicts require careful manual resolution to preserve both upstream features (scheduler, dashboard tasks, openclaw plugin) and our web3 additions
- **Alternative:** Consider splitting the PR into smaller pieces (crypto/DID first, then chain, then federation, then ingest, then perception)

---

## 8. Summary

The web3-identity branch introduces ~32,870 lines of new code across 176 changed files. It's a massive feature branch that has diverged significantly from upstream over 31 commits. The key risks are:

1. **Migration 012 conflict** — will corrupt user databases if not resolved
2. **Deleted upstream features** — scheduler, dashboard tasks, openclaw plugin rewrite are all gone
3. **Missing biome.json** — all new code fails lint/format
4. **Massive file changes** — cli.ts and daemon.ts are essentially rewrites, making clean merge extremely difficult

The recommended approach is to rebase onto upstream/main, restore deleted upstream features, fix migration numbering, and run the full lint/format/test suite. Budget 4-8 hours for a careful rebase.
