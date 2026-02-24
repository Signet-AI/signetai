# Audit Report: CLI & Tray App — Signet Web3 Fork

**Branch:** `web3-identity`  
**Auditor:** Senior Code Auditor (subagent)  
**Date:** 2025-07-09  
**Scope:** `packages/cli/src/cli.ts`, `packages/tray/`

---

## Summary

| Severity | Count |
|----------|-------|
| 🔴 Critical | 4 |
| 🟠 High | 10 |
| 🟡 Medium | 18 |
| 🔵 Low | 14 |
| ⚪ Info | 6 |
| **Total** | **52** |

---

## 🔴 Critical Issues

### C-1: Duplicate `export` and `import` Commands — Commander Collision

**File:** `packages/cli/src/cli.ts`  
**Lines:** 4586, 6865, 7140, 7561 (`export`); 4651, 7202 (`import`)  
**Severity:** 🔴 Critical

Commander registers the **last** `.command()` with a given name. The file defines `program.command("export")` at lines 4586 (original portable export) AND line 7202 (Phase 4B signed bundle export), and similarly `program.command("import")` at lines 4651 and 7202. The second registration **silently shadows** the first, meaning the original `signet export` and `signet import` commands from the portable bundle feature are completely dead code. Users who depended on the non-signed export will get the Phase 4B version instead, with different options/behavior.

**Fix:** Namespace the Phase 4B commands under a subcommand group (e.g., `signet bundle export`, `signet bundle import`) or unify the two export paths into a single command with an `--format` flag to select behavior.

---

### C-2: `levelColors` Type Mismatch — Chalk Functions Stored as Strings

**File:** `packages/cli/src/cli.ts`  
**Line:** ~2551  
**Severity:** 🔴 Critical

```typescript
const levelColors: Record<string, string> = {
    debug: chalk.gray,
    info: chalk.cyan,
    warn: chalk.yellow,
    error: chalk.red,
};
const colorFn = levelColors[entry.level] || chalk.white;
```

`chalk.gray`, `chalk.cyan`, etc. are **functions** (type `ChalkInstance`), not strings. The type annotation `Record<string, string>` is wrong. At runtime under Bun/Node this might still "work" because the values are assigned as functions regardless of the annotation (TS type-level only), but `colorFn` is typed as `string`, so any subsequent call like `colorFn(level)` would be a type error at compile time and IDEs won't provide autocomplete. If the build uses strict type-checking or if anyone tries to use `colorFn(...)` as a function, it will fail.

**Fix:** Change the type to `Record<string, (text: string) => string>` or `Record<string, ChalkInstance>`, and type `colorFn` properly.

---

### C-3: `EventSource` Used in Node.js CLI — Not Available

**File:** `packages/cli/src/cli.ts`  
**Line:** ~2620  
**Severity:** 🔴 Critical

```typescript
const eventSource = new EventSource(
    `http://localhost:${DEFAULT_PORT}/api/logs/stream`,
);
```

`EventSource` is a **browser API**. It does not exist in Node.js or Bun's global scope (as of current LTS). The `signet logs --follow` command will crash with `ReferenceError: EventSource is not defined` when the daemon is running and follow mode is requested.

**Fix:** Use `fetch()` with a streaming body, or install a polyfill like `eventsource` npm package and import it conditionally for the follow mode.

---

### C-4: Tray Channel Toggles Always Send `enabled: true` — Cannot Disable

**File:** `packages/tray/src-tauri/src/tray.rs`  
**Lines:** ~143–172 (perception-ch-* handlers)  
**Severity:** 🔴 Critical

Every channel toggle menu handler hardcodes `true`:

```rust
"perception-ch-screen" => {
    tauri::async_runtime::spawn(async move {
        let _ = commands::perception_toggle_channel(
            "screen".to_string(),
            true,  // ← always true!
        ).await;
    });
}
```

The comment says "Toggle: we don't know current state from here" — but the result is that clicking "Screen Capture: ON" sends `enabled: true` instead of toggling it off. **Users can never disable individual channels from the tray menu.**

**Fix:** The tray TypeScript poller should track current channel state and pass it into the menu rebuild. Alternatively, the Rust handler should query current state and flip it, or use a dedicated `/api/perception/channel/toggle` endpoint.

---

## 🟠 High Severity Issues

### H-1: `remember` and `recall` Commands Use `ensureDaemonForSecrets()` — Misleading Function Name and Error

**File:** `packages/cli/src/cli.ts`  
**Lines:** 3704, 3756  
**Severity:** 🟠 High

`ensureDaemonForSecrets()` prints "Daemon is not running. Start it with: signet start" — this is correct but the function name is confusing since `remember` and `recall` are memory operations, not secret operations. More importantly, if the daemon check fails, the command silently returns without `process.exit(1)`, which means scripts relying on exit codes will think it succeeded.

**Fix:** Rename to `ensureDaemon()` or `requireRunningDaemon()`. Add `process.exit(1)` after the error message (or return a consistent exit code).

---

### H-2: `remember` / `recall` Use `secretApiCall` — Auth Headers Sent for Memory APIs

**File:** `packages/cli/src/cli.ts`  
**Lines:** ~3710–3730, ~3760–3780  
**Severity:** 🟠 High

`secretApiCall()` injects `X-Local-Token` headers. While these headers shouldn't break the memory endpoints, coupling memory operations to the secret API helper is architecturally wrong — if the local token file doesn't exist or is corrupt, memory operations may fail unexpectedly. The function is also named misleadingly.

**Fix:** Use a generic `daemonApiCall()` function that always injects auth headers, and rename `secretApiCall` to that. Or create a dedicated `memoryApiCall()`.

---

### H-3: `new Database()` vs `Database()` — Inconsistent Constructor Calls

**File:** `packages/cli/src/cli.ts`  
**Lines:** Multiple (4102, 4312, 4608, 5883, 5974, 6049, etc.)  
**Severity:** 🟠 High

The file inconsistently uses `new Database(...)` and `Database(...)` (without `new`). The import is `import Database from "./sqlite.js"` — depending on whether `sqlite.js` exports a class or a factory function, one form may be incorrect. For `better-sqlite3`, the default export is a class that **requires** `new`. The calls without `new` (lines ~1031, 1223, 5641, etc.) may work due to Bun/bundler magic but are technically incorrect and fragile.

At line ~4102: `const db = new Database(dbPath, { readonly: true })` — this uses `new`.  
At line ~1031: `const db = Database(dbPath)` — this does NOT use `new`.

The `./sqlite.js` wrapper likely smooths this over, but mixing both patterns is a latent bug.

**Fix:** Audit `sqlite.js` to confirm it handles both call styles. Pick one pattern and use it consistently everywhere. If it's a class, always use `new`.

---

### H-4: No Auth Headers on Tray Daemon API Calls

**File:** `packages/tray/src-tauri/src/commands.rs`  
**Lines:** All `reqwest` calls (quick_capture, search_memories, perception_*, etc.)  
**Severity:** 🟠 High

The CLI reads a local token from `~/.agents/.daemon/local.token` and sends it as `X-Local-Token` header. The tray Rust commands make direct HTTP calls to the daemon **without any auth headers**. If the daemon enforces token authentication (which it should for security), all tray API calls will fail with 401/403.

**Fix:** Read `~/.agents/.daemon/local.token` in the Rust code and attach it to all reqwest requests. Create a shared helper function.

---

### H-5: Tray TypeScript Pollers Have No Auth Headers Either

**File:** `packages/tray/src-ts/state.ts`  
**Lines:** All `fetch()` calls (fetchHealth, fetchMemories, fetchDiagnostics, fetchEmbeddings, fetchPerception)  
**Severity:** 🟠 High

Same issue as H-4 but for the TypeScript polling layer. All `fetch()` calls go to `http://localhost:3850/...` without any authentication headers.

**Fix:** Read the local token from disk (or pass it via Tauri state/config) and include it in all fetch headers.

---

### H-6: `migrateWizard` Is a No-Op — Import Never Actually Happens

**File:** `packages/cli/src/cli.ts`  
**Lines:** ~2406–2432  
**Severity:** 🟠 High

The `migrateWizard` function collects a platform choice and file path from the user, then:

```typescript
await new Promise((r) => setTimeout(r, 1500));
spinner.succeed(chalk.green("Import complete!"));
console.log(chalk.dim("  Imported conversations with memories"));
```

It **fakes success** — it doesn't actually import anything. The user sees "Import complete!" but nothing happened. This is extremely misleading.

**Fix:** Either implement the actual import logic for each platform, or clearly state "Import is not yet implemented" and remove the fake success message.

---

### H-7: `perceive start` Blocks Forever — No Way to Background It

**File:** `packages/cli/src/cli.ts`  
**Lines:** ~7322–7340  
**Severity:** 🟠 High

```typescript
// Block — run until interrupted
await new Promise(() => {});
```

`signet perceive start` blocks the terminal forever. There is no `--daemon` or `--background` option. Users who expect perception to run as a background service (like the daemon) will be confused.

**Fix:** Add a `--daemon` flag that forks the process to the background, similar to how `startDaemon()` works. Or document that users should use `&` or a process manager.

---

### H-8: `perceive export` Uses Same Command Name as Top-Level `export`

**File:** `packages/cli/src/cli.ts`  
**Lines:** ~7561 (perceiveCmd.command("export"))  
**Severity:** 🟠 High

This is a variant of C-1 but for the `perceive` subcommand. The `export` command under `perceive` is fine (it's scoped to `signet perceive export`), but there are **four** top-level `export` commands registered (see C-1). The perceive one is correctly scoped as a subcommand, but the naming collision at the top level is still problematic.

**Fix:** Part of the C-1 fix.

---

### H-9: `knowledge status` Opens Database as `new Database(readonly)` Then Tries Migrations

**File:** `packages/cli/src/cli.ts`  
**Lines:** ~4099–4118  
**Severity:** 🟠 High

```typescript
const db = new Database(dbPath, { readonly: true });
// ...later:
// Run migrations to ensure schema is up to date (read-only is fine for queries)
// We'll open a writable connection for migrations then reopen readonly
```

The comment acknowledges the problem but the code never actually opens a writable connection. If the schema needs migration, the readonly DB will silently fail or throw when migrations attempt writes.

**Fix:** Open writable, run migrations, close, then reopen as readonly. Or skip migrations for read-only status commands.

---

### H-10: `config` Command Regex YAML Editing Is Fragile

**File:** `packages/cli/src/cli.ts`  
**Lines:** ~3060–3160  
**Severity:** 🟠 High

The `config` command uses regex-based YAML editing:

```typescript
updatedYaml = updatedYaml.replace(/^(\s*name:)\s*.+$/m, `$1 "${name}"`);
```

This approach:
- Fails if `name:` appears in comments or nested contexts
- Doesn't handle multi-line values
- Can corrupt YAML if regex matches wrong line
- The harness replacement `updatedYaml.replace(/^harnesses:\n(  - .+\n)+/m, ...)` won't match if the list is empty

**Fix:** Use proper YAML parse → modify → serialize. The codebase already has `parseSimpleYaml` and `formatYaml` — use them.

---

## 🟡 Medium Severity Issues

### M-1: Tray Perception Dashboard `setChannelState` Uses Title-Case Lookup

**File:** `packages/tray/perception.html`  
**Lines:** JS ~line 80 in `setChannelState`  
**Severity:** 🟡 Medium

```javascript
const toggle = document.getElementById("ch" + name.charAt(0).toUpperCase() + name.slice(1));
```

For `name = "screen"`, this builds `"chScreen"`. The HTML has `id="chScreen"` which matches. But for a channel named `"files"`, it builds `"chFiles"` — also matching. This works for current channels but is fragile for future channel names with different casing (e.g., `"screenCapture"` → `"chScreenCapture"` which wouldn't match `"chScreencapture"`).

**Fix:** Use a simple mapping object instead of string manipulation.

---

### M-2: Tray Auto-Refresh Timer Not Cleared on Window Close

**File:** `packages/tray/perception.html`  
**Lines:** JS `startAutoRefresh()`  
**Severity:** 🟡 Medium

The `setInterval` timer is never cleaned up when the perception window is closed. While modern browsers/Tauri will GC the window, during the window's lifetime, the timer continues running even if the user navigates away or the window is hidden. This wastes CPU/network on invisible windows.

**Fix:** Add a `beforeunload` or `visibilitychange` handler to pause/clear the interval.

---

### M-3: `memoriesToday` Count Is Inaccurate

**File:** `packages/tray/src-ts/state.ts`  
**Lines:** ~135-145  
**Severity:** 🟡 Medium

```typescript
// (the API only returns limit=10, but stats.total is accurate)
// For memoriesToday we count from returned set - this is approximate
const memoriesToday = countMemoriesToday(memories);
```

The comment acknowledges this is approximate. With `limit=10`, if there are 50 memories today, `memoriesToday` will show at most 10. The tray menu bar will display wrong counts.

**Fix:** Add a `memoriesToday` field to the daemon's `/api/memories` response, computed server-side.

---

### M-4: `quick_capture` and `search_memories` Rust Commands Don't Send Auth

**File:** `packages/tray/src-tauri/src/commands.rs`  
**Lines:** ~180, ~210  
**Severity:** 🟡 Medium

(Subset of H-4 — called out separately because these are user-facing commands.) When a user types a quick capture or searches memories from the tray, it will silently fail if the daemon requires auth.

---

### M-5: `formatLogEntry` Uses `chalk.gray` Which Doesn't Exist — Should Be `chalk.grey`

**File:** `packages/cli/src/cli.ts`  
**Line:** ~2552  
**Severity:** 🟡 Medium

```typescript
debug: chalk.gray,
```

Chalk v5 uses `chalk.gray` (American spelling) — actually both `chalk.gray` and `chalk.grey` are aliases and both work. **This is NOT actually a bug**, but the type annotation issue (C-2) may cause tooling to flag it.

**Status:** False alarm — keeping for documentation but not a real bug.

---

### M-6: Tray `build_running_menu` Has Unused Parameters

**File:** `packages/tray/src-tauri/src/tray.rs`  
**Lines:** ~259 (`_critical_memories`, `_ingestion_rate`)  
**Severity:** 🟡 Medium

Parameters `_critical_memories` and `_ingestion_rate` are accepted but never used in the menu construction. These are passed from commands.rs but wasted.

**Fix:** Either use them in the menu (add a "Critical: N" display) or remove them from the function signature.

---

### M-7: `formatUptime` in CLI Doesn't Handle Negative or Zero

**File:** `packages/cli/src/cli.ts`  
**Line:** ~388  
**Severity:** 🟡 Medium

If `uptime` is `null`, `formatUptime(null || 0)` → `formatUptime(0)` → `"0s"`. This is fine. But if the daemon returns a negative uptime (clock skew), the function will show negative values like `"-5s"`.

**Fix:** Add `Math.max(0, seconds)`.

---

### M-8: Tray Perception Dashboard Doesn't Handle Daemon Restart Gracefully

**File:** `packages/tray/perception.html`  
**Severity:** 🟡 Medium

If the daemon restarts while the perception dashboard is open, the `invoke("perception_status")` calls will fail. The `renderOffline()` fallback handles this, but there's no visual indicator that the daemon restarted — the dashboard just shows "Stopped" until the next successful poll.

**Fix:** Show a "Reconnecting..." status when the daemon was previously running and now fails health checks.

---

### M-9: `database` Option on `--readonly` Status Commands May Fail if DB is Locked

**File:** `packages/cli/src/cli.ts`  
**Lines:** Multiple readonly opens  
**Severity:** 🟡 Medium

Opening with `{ readonly: true }` while the daemon has a write lock can cause `SQLITE_BUSY` on some operations. This is especially true on NFS/network filesystems.

**Fix:** Add error handling around readonly DB opens with a retry mechanism.

---

### M-10: `daemon status` Subcommand Actually Runs `showStatus` (Agent Status, Not Daemon Status)

**File:** `packages/cli/src/cli.ts`  
**Line:** ~2741  
**Severity:** 🟡 Medium

```typescript
daemonCmd
    .command("status")
    .description("Show daemon status")
    .action(showStatus);
```

`showStatus` shows the full agent status (files, memory counts, etc.), not just daemon status. The description says "Show daemon status" but it does much more. Meanwhile `signet status` at the top level does the same thing.

**Fix:** Either rename to match behavior, or create a lean `showDaemonStatus` that only shows PID, uptime, port, and version.

---

### M-11: Tray HTML Files Reference `window.__TAURI_INTERNALS__` Directly

**File:** `packages/tray/capture.html`, `search.html`, `perception.html`  
**Severity:** 🟡 Medium

All three HTML files use:
```javascript
function invoke(cmd, args) {
    return window.__TAURI_INTERNALS__.invoke(cmd, args);
}
```

This is an internal Tauri API that could change between Tauri versions. The `@tauri-apps/api` package (which is in dependencies) provides the stable `invoke()`.

**Fix:** Import from `@tauri-apps/api/core` instead, or at minimum add a version check.

---

### M-12: `signet hook pre-compaction` Missing `Content-Type` Header

**File:** `packages/cli/src/cli.ts`  
**Line:** ~3628  
**Severity:** 🟡 Medium

```typescript
const data = await fetchFromDaemon<...>("/api/hooks/pre-compaction", {
    method: "POST",
    body: JSON.stringify({...}),
});
```

Unlike `secretApiCall`, `fetchFromDaemon` doesn't automatically add `Content-Type: application/json`. The body is JSON-stringified but the header is missing, so the daemon may not parse the body.

**Fix:** Add `headers: { "Content-Type": "application/json" }` to all `fetchFromDaemon` POST calls that include a body. (Also affects `synthesis`, `synthesis-complete`, `compaction-complete` hooks.)

---

### M-13: `fetchFromDaemon` Doesn't Set `Content-Type` for POST Bodies

**File:** `packages/cli/src/cli.ts`  
**Lines:** ~3356–3375  
**Severity:** 🟡 Medium

The generic `fetchFromDaemon` helper injects auth headers but does NOT add `Content-Type: application/json` for requests with bodies. This affects every caller that passes `body: JSON.stringify(...)`.

**Fix:** Auto-detect body presence and add the header:
```typescript
if (fetchOpts.body) headers["Content-Type"] = "application/json";
```

---

### M-14: `configureHarnessHooks` — `cursor` and `windsurf` Silently Do Nothing

**File:** `packages/cli/src/cli.ts`  
**Lines:** ~274–296  
**Severity:** 🟡 Medium

The switch statement only handles `claude-code`, `opencode`, and `openclaw`. If the user selects `cursor` or `windsurf` in the setup wizard, the function silently returns without configuring anything. No warning is shown.

**Fix:** Add cases for cursor/windsurf (even if just "not yet supported"), or add a `default` case that warns the user.

---

### M-15: `signet config` Re-reads `existingYaml` But Never Updates It After Writes

**File:** `packages/cli/src/cli.ts`  
**Lines:** ~3030–3160  
**Severity:** 🟡 Medium

The `config` command reads `existingYaml` once at the top, then in the `while(true)` loop it edits and writes to file. But `existingYaml` is never re-read after a write, so if the user configures "agent" then "search", the second regex replacement operates on the **original** YAML, not the one modified by the first edit. Changes may overwrite each other.

**Fix:** Re-read `existingYaml` from disk at the start of each loop iteration.

---

### M-16: `perception_toggle_channel` in perception.html Doesn't Track Prior State

**File:** `packages/tray/perception.html`  
**Lines:** JS channel toggle handlers  
**Severity:** 🟡 Medium

The HTML toggle switches work correctly because `setChannelState` updates them from server state on each refresh. But between refreshes, if the toggle API call fails, the revert logic `e.target.checked = !enabled` races with the next poll refresh that may override it.

**Fix:** Disable toggles during API calls and re-enable after the next status fetch confirms the state.

---

### M-17: `ingestionRate` Calculation Uses Module-Level Mutable State

**File:** `packages/tray/src-ts/state.ts`  
**Lines:** ~93–100  
**Severity:** 🟡 Medium

```typescript
let lastMemoryCount: number | null = null;
let lastMemoryCountTime: number | null = null;
let currentIngestionRate: number | null = null;
```

Module-level mutable state shared across async pollers. While unlikely to cause issues in practice (single-threaded JS), the exponential moving average calculation doesn't account for the daemon being restarted (which would reset memory counts, causing a negative delta).

**Fix:** Reset ingestion rate tracking when daemon transitions from stopped → running.

---

### M-18: `session-stats` and `knowledge status` Use `new Database()` Without Import Path Context

**File:** `packages/cli/src/cli.ts`  
**Lines:** ~4310, ~4100  
**Severity:** 🟡 Medium

These commands use `new Database(...)` to open the DB, then call `loadSqliteVec(db)`. The `loadSqliteVec` function expects a specific type from `@signet/core`, and the `db` from `new Database()` (better-sqlite3) may not match. The `as unknown as Parameters<typeof loadSqliteVec>[0]>` casts at line ~3900 suggest this type mismatch is known and worked around.

**Fix:** Create a single `openMemoryDb()` helper that returns the correct type, loads extensions, and runs migrations — replacing the 20+ copies of this pattern.

---

## 🔵 Low Severity Issues

### L-1: `searchRegistry` GitHub Search Query Is Too Broad

**File:** `packages/cli/src/cli.ts`  
**Lines:** ~3386–3410  
**Severity:** 🔵 Low

The GitHub search query `${query} topic:agent-skill OR filename:SKILL.md in:path` will return many false positives. The 10 req/min unauthenticated rate limit means users will quickly hit 403s.

**Fix:** Use the `skills.sh` registry API (mentioned in help text) as primary, GitHub as fallback.

---

### L-2: `formatCount` Duplicated in Rust

**File:** `packages/tray/src-tauri/src/commands.rs` (line ~90) and `packages/tray/src-tauri/src/tray.rs` (line ~218)  
**Severity:** 🔵 Low

`format_count` in commands.rs and `format_number` in tray.rs are identical functions. DRY violation.

**Fix:** Move to a shared utility module.

---

### L-3: Tray Index HTML References `./index.js` But Build Outputs to `dist/`

**File:** `packages/tray/index.html`  
**Severity:** 🔵 Low

```html
<script type="module" src="./index.js"></script>
```

The build script copies `index.html` to `dist/` and builds `index.ts` to `dist/index.js`. This works because both end up in `dist/`. But in dev mode (`tauri dev`), the source `index.html` references `./index.js` which won't exist in the source root — only in `dist/`. The `beforeDevCommand: "bun run build:ts"` handles this, but if someone opens `index.html` directly it won't work.

**Fix:** This is fine for the current workflow but could be documented.

---

### L-4: `existingHarnesses` Parsing Only Handles String Type

**File:** `packages/cli/src/cli.ts`  
**Lines:** ~1680–1685  
**Severity:** 🔵 Low

```typescript
const existingHarnesses: string[] = existingConfig.harnesses
    ? typeof existingConfig.harnesses === "string"
        ? existingConfig.harnesses.split(",").map((s: string) => s.trim())
        : []
    : [];
```

If `existingConfig.harnesses` is an array (which it usually is in YAML), this returns `[]` instead of the array. The `parseSimpleYaml` likely returns arrays as arrays.

**Fix:** Add `Array.isArray(existingConfig.harnesses) ? existingConfig.harnesses : ...`.

---

### L-5: `describe` Tag in `agent.yaml` Is Wrong — Says "AGENT.yaml"

**File:** `packages/cli/src/cli.ts`  
**Line:** ~976  
**Severity:** 🔵 Low

During existing setup wizard:
```typescript
console.log(chalk.dim("    1. Create AGENT.yaml manifest pointing to your existing files"));
```

The file is called `agent.yaml` (lowercase), not `AGENT.yaml`.

**Fix:** Change to `agent.yaml`.

---

### L-6: `gitAutoCommit` Function Is Defined But Never Used

**File:** `packages/cli/src/cli.ts`  
**Lines:** ~230–236  
**Severity:** 🔵 Low

The `gitAutoCommit()` function is defined but never called anywhere in the file.

**Fix:** Remove the dead code or wire it up to file-change events.

---

### L-7: `process.stdin` Reading in Hook Commands Could Hang

**File:** `packages/cli/src/cli.ts`  
**Lines:** ~3579, ~3608 (user-prompt-submit, session-end)  
**Severity:** 🔵 Low

```typescript
for await (const chunk of process.stdin) {
    chunks.push(chunk);
}
```

If stdin is a TTY (user runs the command interactively without piping), this will hang waiting for input with no prompt or timeout. The user will see nothing and have to Ctrl+C.

**Fix:** Check if stdin is a TTY first (`process.stdin.isTTY`) and skip stdin reading if so.

---

### L-8: Tray `build_running_menu` Parameter Count Is Excessive

**File:** `packages/tray/src-tauri/src/tray.rs`  
**Line:** ~258  
**Severity:** 🔵 Low

`build_running_menu` takes 16 parameters. This is unwieldy and error-prone (easy to pass arguments in the wrong order).

**Fix:** Create a `RunningMenuState` struct and pass that instead.

---

### L-9: `getCliVersion` Doesn't Check the Monorepo Root

**File:** `packages/cli/src/cli.ts`  
**Lines:** ~475–485  
**Severity:** 🔵 Low

The version lookup checks three paths relative to `__dirname`. In the monorepo dev setup, none may resolve correctly if the build output directory structure changes. Fallback to `"0.0.0"` is not ideal.

**Fix:** Add the monorepo workspace root `package.json` as another candidate.

---

### L-10: Tray `time_ago` in Rust Tries Two Date Formats But May Miss Others

**File:** `packages/tray/src-tauri/src/tray.rs`  
**Lines:** ~225–240  
**Severity:** 🔵 Low

The `time_ago` function first tries `DateTime::parse_from_rfc3339`, then falls back to `NaiveDateTime::parse_from_str` with `%Y-%m-%dT%H:%M:%S%.f`. Timestamps from SQLite often use space-separated format (`2025-07-09 12:34:56`) which neither pattern handles.

**Fix:** Add a third fallback for `%Y-%m-%d %H:%M:%S`.

---

### L-11: `truncate` in Rust Operates on Bytes, Not Characters

**File:** `packages/tray/src-tauri/src/tray.rs`  
**Lines:** ~250–256  
**Severity:** 🔵 Low

```rust
fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
```

`s.len()` returns bytes, not characters. For UTF-8 text with multi-byte characters (emoji, CJK), this may truncate mid-character and panic or produce invalid output. The `s.chars().take(max - 3)` on the next line is correct, but the length check is wrong.

**Fix:** Use `s.chars().count()` for the length check.

---

### L-12: `openclawRuntimePath` Not Passed to `existingSetupWizard`

**File:** `packages/cli/src/cli.ts`  
**Lines:** ~980–990 (existingSetupWizard) vs ~2085 (setupWizard)  
**Severity:** 🔵 Low

In the fresh `setupWizard`, users choose between "plugin" and "legacy" for OpenClaw. In `existingSetupWizard`, `configureHarnessHooks` is called without the `openclawRuntimePath` option, defaulting to "legacy". Existing OpenClaw users migrating to Signet will always get legacy mode.

**Fix:** Add a prompt for runtime path in `existingSetupWizard`, or default to "plugin" (which the fresh wizard recommends).

---

### L-13: `perceive status` Hardcodes Adapter Names Including `comms`

**File:** `packages/cli/src/cli.ts`  
**Lines:** ~7380–7395  
**Severity:** 🔵 Low

The status display hardcodes `adapters.comms` but the tray menu and perception dashboard don't include a `comms` channel. This creates an inconsistency between CLI and tray perception displays.

**Fix:** Add comms to the tray dashboard or make the CLI dynamically enumerate adapters.

---

### L-14: `signet migrate` Ignores the `source` Argument

**File:** `packages/cli/src/cli.ts`  
**Lines:** ~2761–2768  
**Severity:** 🔵 Low

```typescript
program
    .command("migrate")
    .argument("[source]", "Source platform (chatgpt, claude, gemini)")
    .action(async (source) => {
        const basePath = AGENTS_DIR;
        await migrateWizard(basePath);  // source arg is ignored!
    });
```

The `source` argument is accepted but never passed to `migrateWizard`.

**Fix:** Pass `source` to `migrateWizard` and skip the selection prompt if provided.

---

## ⚪ Info / Suggestions

### I-1: No `--version` Check Before Running Long Commands

**Severity:** ⚪ Info

Commands like `signet setup`, `signet chain register`, `signet federation start` etc. don't check if the daemon version matches the CLI version. A version mismatch between CLI and daemon could cause subtle API incompatibilities.

**Suggestion:** Add a version compatibility check at the start of commands that talk to the daemon.

---

### I-2: Tray Polling Intervals Are Reasonable

**Severity:** ⚪ Info (Positive Finding)

The staggered polling intervals (health: 5s/2s, memories: 15s, diagnostics: 30s, embeddings: 60s, perception: 15s) are well-designed. The `setTimeout` approach (vs `setInterval`) prevents overlapping polls. The JSON diffing (`lastUpdateJson`) prevents unnecessary Rust→menu updates. Good design.

---

### I-3: Build Script Correctly Copies All HTML Files

**Severity:** ⚪ Info (Positive Finding)

The `build:ts` script in `package.json`:
```
cp index.html dist/index.html && cp capture.html dist/capture.html && cp search.html dist/search.html && cp perception.html dist/perception.html
```

All four HTML files are correctly copied. The `frontendDist: "../dist"` in `tauri.conf.json` points to the right directory.

---

### I-4: DB Handle Leak Risk in Several Commands

**Severity:** ⚪ Info

Many commands open a database with `new Database(dbPath)` and close with `db.close()` at the end. If an exception occurs between open and close, the handle leaks. Some commands use `try...finally` (good) but others don't.

**Suggestion:** Standardize all DB access to use `try...finally` or a RAII-style wrapper.

---

### I-5: `signet help` Output Could List Grouped Commands Better

**Severity:** ⚪ Info

With 30+ commands (many nested: daemon, secret, skill, hook, update, git, chain, wallet, session, memory, perceive, federation, peer, publish), the help output is likely very long and overwhelming.

**Suggestion:** Add `program.addHelpText('after', ...)` with a quick-reference of common workflows.

---

### I-6: Perception Dashboard Clipboard Export Uses Fallback for Older Browsers

**Severity:** ⚪ Info (Positive Finding)

Both `perception.html` (profile export) and `search.html` (copy memory) use `navigator.clipboard.writeText()` with fallback to `document.execCommand("copy")`. Good defensive coding.

---

## Recommendations Summary

### Must Fix Before Ship:
1. **C-1:** Duplicate export/import commands — one set is dead code
2. **C-3:** `EventSource` in Node.js — logs follow mode is broken  
3. **C-4:** Channel toggles always send `true` — can't disable channels from tray
4. **H-4/H-5:** Missing auth headers in tray — all tray features break if daemon enforces auth
5. **H-6:** Fake migrate wizard — users think imports happen but they don't

### Should Fix Soon:
6. **C-2:** Type annotation mismatch on levelColors
7. **H-3:** Inconsistent `new Database()` vs `Database()` calls
8. **H-10:** Regex-based YAML editing is fragile
9. **M-13:** `fetchFromDaemon` missing Content-Type headers for POST bodies
10. **M-15:** Config command doesn't re-read YAML between edits

### Architecture Improvements:
11. Create a single `openMemoryDb()` helper to replace 20+ duplicate patterns
12. Create a `daemonApiCall()` helper that handles auth + Content-Type for all daemon calls
13. Use proper YAML library for config edits
14. Add version compatibility checks between CLI and daemon
