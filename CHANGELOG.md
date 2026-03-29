# Changelog

All notable changes to Signet are documented here.

## [0.82.7] - 2026-03-29

### Features

- **dashboard**: ontology constellation view (#393)


## [0.82.6] - 2026-03-29

### Bug Fixes

- **ci**: replace mapfile for macOS-compatible release uploads (#392)


## [0.82.5] - 2026-03-29

### Bug Fixes

- **daemon**: prototype DP-19 adaptive write gate with scoped guards (#380)
- **tray**: unblock mac self-signed CI and prefer bundled linux daemon (#388)


## [0.82.4] - 2026-03-28

### Bug Fixes

- **tray**: resolve macOS bundled-daemon path compile regression (#387)


## [0.82.3] - 2026-03-28

### Bug Fixes

- **ci**: harden self-signed desktop signing on macOS and windows (#384)


## [0.82.2] - 2026-03-28

### Bug Fixes

- **ci**: add self-signed desktop signing and arch package validation (#383)


## [0.82.0] - 2026-03-28

### Bug Fixes

- **cli**: protect OpenClaw-linked workspaces from unprotected data loss (#378)


## [0.81.2] - 2026-03-28

### Features

- **setup**: deployment-aware setup defaults + native embedding docs alignment (#363)

### Bug Fixes

- **daemon**: batch watcher identity sync to keep health responsive (#375)

### Docs

- add Groundswell implementation specs + PRD + SSM synthesis (#381)
- **specs**: add Groundswell PRD and gap analyses for community knowledge graphs


## [0.81.1] - 2026-03-28

### Bug Fixes

- **daemon**: persist extraction fallback status with provider parity (replaces #367) (#373)

### Docs

- add alcar2364 to contributors


## [0.81.0] - 2026-03-28

### Bug Fixes

- **docker**: unblock post-merge smoke failures from #374 (#377)


## [0.80.0] - 2026-03-27

### Features

- **docker**: add first-party self-hosting stack (#374)


## [0.79.0] - 2026-03-27

### Features

- **pipeline**: add command extraction provider for summary worker control-plane path (#368)
- **docker**: add first-party self-hosting stack (Compose + Caddy + token bootstrap) and GHCR image workflows

### Docs

- add Docker self-hosting quickstart and operations runbook updates

## [0.78.4] - 2026-03-27

### Features

- **dashboard**: add configurable log ordering (#371)

### Docs

- add first-PR guide for new contributors
- **research**: add agent loop comparison across Forge, Codex, Hermes


## [0.78.3] - 2026-03-27

### Bug Fixes

- **openclaw**: type-safe hooks, mid-session extraction, clean recall (#369)

### Docs

- add ddasgupta4 to contributors


## [0.78.2] - 2026-03-27

### Bug Fixes

- **daemon**: stop workspace AGENTS.md sync watcher loop (#366)

### Refactoring

- **dashboard**: stabilize IA and gate experimental surfaces (#364)


## [0.78.1] - 2026-03-27

### Bug Fixes

- **update**: verify installed version after install (#365)


## [0.78.0] - 2026-03-27

### Bug Fixes

- **daemon**: add prompt-submit success telemetry on all success paths (#360)


## [0.77.7] - 2026-03-26

### Features

- **forge**: require explicit dev-warning acknowledgement on install and launch (#359)


## [0.77.5] - 2026-03-26

### Bug Fixes

- force event-driven MEMORY.md refresh after summary/compaction (#349)


## [0.77.4] - 2026-03-26

### Bug Fixes

- **memory**: close lossless working-memory runtime gaps (#344)


## [0.77.3] - 2026-03-26

### Bug Fixes

- **daemon**: broaden macOS SQLite runtime discovery for sqlite-vec (#338)
- **docs**: align Signet positioning around context selection (#342)


## [0.77.1] - 2026-03-25

### Bug Fixes

- **cli**: recover stale daemon processes on restart (#333)


## [0.77.0] - 2026-03-25

### Bug Fixes

- **daemon**: keep startup recovery responsive on large databases (#332)


## [0.76.6] - 2026-03-25

### Features

- **pipeline**: add live pause controls (#329)


## [0.76.5] - 2026-03-25

### Bug Fixes

- recover stuck processing summary_jobs on startup + fix embed backfill infinite cycle (#319)


## [0.76.2] - 2026-03-24

### Bug Fixes

- **memory**: raise contradiction timeout and guard embedding tracker null hashes


## [0.76.0] - 2026-03-24

### Bug Fixes

- wire agent_id and visibility through memory write and recall (#317)

### Docs

- spec and index for sub-agent context continuity (#315)


## [0.75.3] - 2026-03-24

### Features

- multi-agent support — scoped identity, memory, and OpenClaw routing (#316)


## [0.75.2] - 2026-03-24

### Bug Fixes

- session expiry, hooks config, dead-memory API, openclaw health (#295)


## [0.75.1] - 2026-03-24

### Bug Fixes

- **daemon**: graceful SIGTERM shutdown (#307)


## [0.75.0] - 2026-03-24

### Bug Fixes

- complete DP-9 path feedback propagation pipeline (#310)

### Docs

- competitive systems research — 3-repo analysis with integration contracts (#309)


## [0.74.1] - 2026-03-23

### Features

- **cli**: add configurable Signet workspace path + migration (#302)


## [0.74.0] - 2026-03-23

### Bug Fixes

- **dashboard**: remove review-queue tab; fix knowledge tab load performance (#305)


## [0.73.8] - 2026-03-23

### Features

- add reviews sync Cloudflare Worker (#296)

### Bug Fixes

- support provider: none for extraction and synthesis (#301)


## [0.73.7] - 2026-03-23

### Bug Fixes

- March 2026 codebase review (#294)


## [0.73.6] - 2026-03-23

### Bug Fixes

- wire marketplace reviews sync to production Worker endpoint (#293)


## [0.73.4] - 2026-03-23

### Bug Fixes

- 5 critical memory and injection stability fixes (#291)


## [0.73.3] - 2026-03-23

### Bug Fixes

- **daemon**: align embedding-tracker hash with normalizeAndHashContent (#286)


## [0.73.2] - 2026-03-23

### Bug Fixes

- normalize remember tags across daemon and openclaw (#285)


## [0.73.1] - 2026-03-22

### Bug Fixes

- **daemon**: normalize Claude Code transcript records (#284)


## [0.73.0] - 2026-03-22

### Bug Fixes

- task run output display — stdin close, chunk normalization, terminal rendering (#283)


## [0.72.8] - 2026-03-22

### Features

- desire paths retrieval + prospective indexing (#253)


## [0.72.7] - 2026-03-22

### Bug Fixes

- **dashboard**: replace @signet/core runtime import with local constant
- **openclaw**: dedupe marketplace proxy refresh (#281)


## [0.72.6] - 2026-03-22

### Bug Fixes

- security hardening — auth timing, SSRF, YAML injection, scope enforcement (#276)


## [0.72.5] - 2026-03-22

### Bug Fixes

- address 9 security and stability issues (#275)


## [0.72.4] - 2026-03-22

### Bug Fixes

- resolve daemon path in published bundle (#274)


## [0.72.2] - 2026-03-22

### Bug Fixes

- comprehensive security audit hardening (#271)


## [0.72.1] - 2026-03-22

### Bug Fixes

- harden error handling and resource cleanup (#272)
- codex MCP config uses string command, not array (#273)


## [0.71.6] - 2026-03-22

### Features

- **os**: Visual GUI Agent — Page-Agent Integration (#266)


## [0.71.5] - 2026-03-21

### Bug Fixes

- **troubleshooter**: handle daemon stop/restart lifecycle commands (#265)


## [0.71.4] - 2026-03-21

### Bug Fixes

- **tray**: add icon.ico for Windows build (#263)


## [0.71.3] - 2026-03-21

### Bug Fixes

- **tray**: cross-platform build script for Windows CI (#262)


## [0.71.2] - 2026-03-21

### Bug Fixes

- **tray**: restore npm tauri CLI + convert icons to RGBA (#261)


## [0.71.1] - 2026-03-21

### Bug Fixes

- pipeline worker stall after burst processing (#259)


## [0.71.0] - 2026-03-21

### Bug Fixes

- **tray**: revert to cargo tauri CLI, convert icons to RGBA (#260)


## [0.70.0] - 2026-03-21

### Features

- **connector-codex**: native hooks + MCP for full mid-session memory (#258)


## [0.69.5] - 2026-03-21

### Features

- **dashboard**: Cortex page — unified Memory, Apps, Tasks, Troubleshooter (#256)


## [0.69.3] - 2026-03-21

### Bug Fixes

- use npm tauri CLI instead of cargo plugin in tray scripts (#254)


## [0.69.2] - 2026-03-20

### Bug Fixes

- install tray deps explicitly in desktop build workflow


## [0.69.1] - 2026-03-20

### Bug Fixes

- use RELEASE_PAT in release workflow for branch protection bypass


## [0.69.0] - 2026-03-20

### Bug Fixes

- use local timezone for timeline Today boundaries (#252)


## [0.68.3] - 2026-03-20

### Features

- homepage spotlights, dynamic insights, and health consistency (#250)


## [0.68.2] - 2026-03-20

### Bug Fixes

- settings persist across refresh without daemon restart (#251)


## [0.68.1] - 2026-03-20

### Bug Fixes

- remove provider icon tinting and auto-sync pre-installed apps (#249)


## [0.68.0] - 2026-03-20

### Bug Fixes

- prevent CMD window flashing on Windows and fix workspace path matching (#247)


## [0.67.0] - 2026-03-20

### Features

- Signet OS v2 — sandboxed widget rendering, LLM auto-generation, MCP app dashboard


## [0.66.1] - 2026-03-19

### Features

- add scope column for memory isolation (#245)


## [0.66.0] - 2026-03-19

### Bug Fixes

- **openclaw**: harden plugin sync and patch plugins.allow (#246)


## [0.65.9] - 2026-03-19

### Features

- retroactive memory supersession (#244)


## [0.65.8] - 2026-03-19

### Bug Fixes

- MCP stdio server process leak on session end (#243)


## [0.65.7] - 2026-03-19

### Bug Fixes

- add missing --project option to pre-compaction hook (#242)


## [0.65.6] - 2026-03-19

### Bug Fixes

- prevent CMD window flashing and fix workspace path matching on Windows (#241)


## [0.65.5] - 2026-03-19

### Bug Fixes

- Windows compatibility across daemon, core, and connectors (#238)

### Docs

- add BusyBee3333, stephenwoska2-cpu, and PatchyToes to contributors (#240)


## [0.65.4] - 2026-03-19

### Bug Fixes

- use bash shell for cargo build steps on Windows runners (#239)


## [0.65.3] - 2026-03-19

### Bug Fixes

- move @signet/core to devDependencies in openclaw plugin (#237)


## [0.65.2] - 2026-03-19

### Bug Fixes

- predictor sidecar binary distribution for Windows (#236)


## [0.65.1] - 2026-03-19

### Bug Fixes

- support optional column artifacts for conditional migrations
- scope workspace version check to [package] section only
- add migration for missing embeddings.vector column on older DBs
- release pipeline — skip workspace-inherited Cargo versions and clobber duplicate assets


## [0.64.0] - 2026-03-19

### Features

- Signet OS — browser, MCP app dashboard, event bus, ambient awareness


## [0.63.3] - 2026-03-19

### Features

- deploy Signet logo across all surfaces

### Bug Fixes

- handle malformed timestamps in log formatter
- swap logo variants for correct theme visibility
- use white logo variant in README for dark mode visibility
- replace ASCII art with clean h1 header
- remove pre tag spacing, match image heights in table
- center ASCII art with pre tag, side-by-side poster images

### Docs

- add Discord badge and nav link to README
- refactor README and add Why Signet to quickstart
- add AI policy, PR template, and GitHub Discussions setup


## [0.63.2] - 2026-03-18

### Bug Fixes

- address PR review feedback for version-sync
- resolve three signet sync failures
- address review — document spawnHidden throw safety, clarify Bun.which calls
- resolve CLI binary paths on Windows for extraction/synthesis providers


## [0.63.1] - 2026-03-18

### Bug Fixes

- add sharp to optionalDependencies for Windows ARM64 support


## [0.63.0] - 2026-03-18

### Refactoring

- **docs**: organize docs into research-to-implementation pipeline


## [0.62.0] - 2026-03-18

### Features

- add Windows and ARM64 Windows support across the codebase

### Bug Fixes

- **sync**: add timeouts for predictor download fetches
- **sync**: harden runtime artifact sync and warmup
- **sync**: move runtime downloads from postinstall to signet sync


## [0.61.0] - 2026-03-18

### Features

- **shadow**: Rust daemon shadow proxy — auto-install, request tap, divergence logging
- **daemon-rs**: v0.59.0 parity — dep reason, 21 dep types, synthesis worker
- **daemon-rs**: Rust daemon rewrite — full implementation

### Bug Fixes

- **ci**: use openssl for sha256 — portable across linux/macos/windows runners
- **shadow**: address PR review feedback
- **daemon-rs**: address round-3 review feedback
- **daemon-rs**: address round-2 review feedback
- **daemon-rs**: address code review feedback


## [0.60.1] - 2026-03-18

### Features

- **memory**: add openrouter provider for extraction and synthesis

### Bug Fixes

- **memory**: address openrouter review feedback


## [0.60.0] - 2026-03-18

### Bug Fixes

- vec_embeddings backfill race — use direct LEFT JOIN instead of count comparison


## [0.59.0] - 2026-03-18

### Features

- website-dashboard visual convergence — tokens, textures, fonts, and copy
- add NemoClaw ecosystem positioning blog post, refine all existing content

### Bug Fixes

- eliminate budget duplication, fix CLI JSON shape (PR review)
- fall back to static identity files when daemon is unreachable (#219)


## [0.58.3] - 2026-03-17

### Features

- add dependency reason field and cross-entity synthesis worker
- expand knowledge graph dependency types from 5 to 18

### Bug Fixes

- drain in-flight tick on stop, use display names in existing targets, add dst.agent_id
- add agent_id to markSynthesized, only mark when upserts succeed
- use ISO timestamps in markSynthesized, add tick-in-progress guard
- use canonical_name in loadExistingTargets for consistent normalization
- two-pass string-aware extractBalancedJsonArray, document assumptions
- forward-scan extractBalancedJsonArray, document atomicity, relax test assertion
- add agent_id scoping and use config batch size in synthesis worker
- address pr-reviewer feedback on dependency extraction
- improve extraction resilience for flaky model output
- atomic upserts, retry on failure, type descriptions in prompt
- guard upsert pair with try/catch, cap aspect name length
- derive prompt types from DEPENDENCY_TYPES, thread aspectId


## [0.58.2] - 2026-03-16

### Bug Fixes

- address round-2 review — shared locale constant, anchored boundaries, regex docs
- address review — widen locale regex, use locale-prefixed detail URLs
- MCP catalog parser — third-party section boundary and mcpservers.org locale


## [0.58.1] - 2026-03-15

### Bug Fixes

- address review — clear stale notes, dev-mode catch log, DOMParser strip
- address review — early return on missing version, catch, stale guard
- upgrade banner persistence, changelog link, and mobile trigger overlap
- apply readCapped to catalog and reference fetchers
- cap README response size, fix third-party popularityRank
- lift catalog Map to store, anchor avatar URL regex
- refEnd boundary, SSRF hardening, documentation coverage
- mobile rail layout, O(n) catalog scan, explicit avatar source match
- tighten URL regex, strip markdown images, clear avatar errors
- use SvelteSet for reactive avatar error tracking, improve error msg
- add missing 'GitHub' label in secondary sort dropdown
- skip non-GitHub third-party entries, reset avatarFailed on URL change
- address review — github source filter, branch fallback, catalogId validation
- complete "github" source support for third-party MCP servers
- add "github" to MarketplaceMcpCatalogSource type system
- address round-2 review — third-party source, sidebar offset, avatar cleanup
- address PR review — ID collisions, section bounds, avatar namespaces
- marketplace UI refresh — card consistency, MCP catalog, GitHub avatars
- **dashboard**: restore sidebar closing speed after breakpoint regression

### Refactoring

- extract shared card utils, tighten github validation, add docs


## [0.58.0] - 2026-03-14

### Bug Fixes

- restore left border on mobile mix cards in 1-column layout
- remove mix-grid padding gap, add unstyled trigger prop
- merge duplicate .timeline-mix-grid selector into single block
- move mix-grid bottom border to container for robustness
- remove duplicate --mobile-header-inset from light theme block
- address review — timeline margin token, light theme inset, sidebar var
- extract mobile header padding into --mobile-header-inset token
- shrink mobile trigger, increase header padding to prevent tap overlap
- remove :has() layout-shift coupling, prevent WebKit overflow-x
- scope mobile-only styles to prevent Tauri regressions
- mobile mix-card double border, trigger reduced-motion guard
- restore banner desktop spacing, add mix-grid bottom border
- typed mobileOnly prop, symmetric banner padding, mobile mix-card layout
- hide mobile trigger in Tauri desktop mode via isMobile guard
- address remaining review regressions — trigger overlap, landscape, flex stretch
- remove rounded-lg on zero-gap mix cards, add reduced-motion guard
- address round-3 PR review feedback on timeline and trigger
- address round-2 PR review feedback on mobile trigger and timeline
- address PR review feedback on sheet width and timeline overflow
- dashboard UI improvements — mobile sidebar, banner spacing, and QOS


## [0.57.1] - 2026-03-14

### Features

- pipeline defaults everything ON by default
- dynamic model registry and extraction strength controls

### Bug Fixes

- **daemon**: add session_summaries table guard to backfillSkippedSessions
- resolve two CI build failures on main
- **daemon**: address round 4 review feedback
- **daemon**: address round 3 review feedback
- **daemon**: harden chunked summarization edge cases
- address pr-reviewer round-7 — effect cleanup, refresh throttle, dead export
- **daemon**: chunked map-reduce summarization for long transcripts
- add 3s timeout to execFileSync calls in detectGitBranch
- **daemon**: address review feedback on transcript sanitization
- use execFileSync to prevent shell injection in detectGitBranch
- address round 3 review feedback on config migration
- address round 2 review feedback
- **cli**: surface spawn errors in startup.log diagnostic output
- address code review feedback on pipeline defaults
- integer version comparison, correct label generation order
- reactive registry fetch, clarify strength token label
- skip Ollama discovery when provider is not Ollama
- apply markDeprecatedVersions to merged Ollama discovery results
- address round-6 review — seed deprecation, clear model on provider reset
- address round-5 review — epoch guard, deprecation on fallback paths
- address round-4 review — catch handler, strength priority, timeout floor
- address round-3 review — refresh serialization, lease safety, deprecation
- address round-2 review — registry key resolution, null guard, error logging
- address PR review feedback — maxTokens forwarding, Ollama URL, type safety
- auto-detect git sync branch instead of hardcoding "main"
- **daemon**: sanitize session transcripts and remove truncation


## [0.57.0] - 2026-03-14

### Bug Fixes

- address PR review feedback on migration 030
- make memory_jobs.memory_id nullable for document ingest jobs


## [0.56.2] - 2026-03-14

### Features

- tactile aluminum design system for dashboard

### Docs

- add dashboard and constellation screenshots to README
- refactor AGENTS.md into behavioral contract with backlinks


## [0.56.1] - 2026-03-14

### Bug Fixes

- **migrations**: complete artifact declarations for v22 and v24
- **migrations**: address round 9 Greptile feedback
- **migrations**: address round 8 review feedback
- **migrations**: replace hardcoded 26 with MIGRATIONS.length in all tests
- **migrations**: address round 6 review feedback
- **migrations**: address round 5 review feedback
- **migrations**: address round 4 review feedback
- **migrations**: address round 3 review feedback
- **migrations**: address round 2 review feedback
- **migrations**: address review feedback on PR #199
- **migrations**: self-heal phantom migrations with artifact verification


## [0.56.0] - 2026-03-14

### Bug Fixes

- **daemon**: harden ollama fallback max-context validation
- **daemon**: remove hardcoded qwen fallback model


## [0.55.0] - 2026-03-12

### Features

- custom window decorations and UI scaling for Tauri desktop app

### Bug Fixes

- inline wheel modifier check and guard old index-based localStorage values
- store scale value instead of index in localStorage for ui-scale
- address CodeRabbit/Greptile round-2 feedback on WindowTitlebar
- add aria-labels to zoom buttons and SSR guard localStorage writes
- address CodeRabbit review feedback on window-decorations PR

### Performance

- replace polling with onResized event listener in WindowTitlebar


## [0.54.2] - 2026-03-12

### Features

- dashboard UI polish — readout panel design language

### Bug Fixes

- add focus-visible styles to refresh and action buttons in SuggestedInsights
- address greptile/coderabbit CSS regression from class rename
- address greptile review feedback on SecretsTab
- address coderabbit review feedback on dashboard UI PR
- address greptile review feedback on dashboard UI PR

### Docs

- add desire paths epic with 15 stories across 5 phases
- update RESEARCH-LCM-ACP.md frontmatter
- add GitNexus pattern analysis and integrate into architecture docs


## [0.54.1] - 2026-03-11

### Bug Fixes

- document overlap >= 3 threshold and add config ref entry
- address review feedback on contradiction timeout PR
- make semantic contradiction timeout configurable


## [0.54.0] - 2026-03-11

### Bug Fixes

- enable positional options on secret command to prevent CLI crash


## [0.53.4] - 2026-03-11

### Features

- add `secret get` and `secret exec` CLI subcommands

### Bug Fixes

- log patchLoadPaths outcome at setup time
- remove double-logging of patchLoadPaths warnings at call site
- guard scalar plugins.load values, widen ECONNREFUSED detection
- distinguish timeout errors in secret exec with actionable message
- send secret-get not-found message to stderr
- filter load.paths entries, surface patchLoadPaths warnings, guard mkdirSync
- retry install on missing cached package, preserve non-symlink extensions
- validate secret names are valid POSIX env var identifiers
- guard patchLoadPaths against legacy array plugins, surface rmSync errors
- clarify --secret must precede command token in exec
- expand ~ in OPENCLAW_STATE_DIR env vars and honor OPENCLAW_STATE_HOME
- escape \$ in exec args to block command substitution injection
- warn when resolveGlobalPackagePath returns undefined after install
- switch to double-quoting for exec args to allow \$VAR expansion
- address second greptile/coderabbit round
- shell-escape exec args, use exitCode to avoid truncating output
- address greptile review — yarn berry, dedup resolve, load.paths dir
- passThroughOptions for exec, note streaming limitation
- openclaw plugin discovery — symlink + load.paths fallback
- variadic exec args, null exit code, document secrets map
- address review — add ok check in secret get, extend exec timeout


## [0.53.3] - 2026-03-10

### Bug Fixes

- **daemon**: redact provider URLs and harden fallback bases
- **daemon**: align opencode endpoint wiring and fallback handling
- **daemon**: harden loopback parsing and summary worker guards
- **daemon**: normalize loopback fallbacks for provider probes
- **daemon**: address PR review regressions and doc gaps
- **daemon**: harden VPS runtime config and pipeline behavior


## [0.53.2] - 2026-03-10

### Bug Fixes

- use date-versioned model IDs for sonnet/opus Anthropic aliases
- add HTTP 504 to retryable status set for Anthropic provider
- use SHA-256 fingerprint for provider cache key rotation detection
- address Greptile review items for 5/5 confidence
- use NonRetryableError for empty-response throw in callAnthropic
- improve deadline-expiry diagnostics and warn on unknown kill signal
- reset model to qwen3:4b on Ollama fallback in summary-worker
- guard SIGTERM calls in timeout callbacks against already-exited processes
- clear SIGKILL grace timer on process exit and clarify cache comment
- replace brittle substring matching with NonRetryableError sentinel
- tighten isRetryableStatus and add TTL to provider cache
- cache summary-worker provider and harden spawnHidden kill signal
- apply Promise.race timeout to codex provider
- recompute deadline inside semaphore to account for contention
- don't retry fatal 4xx Anthropic HTTP errors
- guard Anthropic provider construction against missing API key
- acquire semaphore per-attempt so backoff doesn't hold slots idle
- wrap anthropic in semaphore, gate synthesis key lookup, use /v1/models for available()
- address review feedback — model fallback, model IDs, available() auth, empty-response retry
- address reviewer feedback on Anthropic provider and subprocess handling
- replace node:child_process with Bun.spawn for reliable subprocess I/O


## [0.53.1] - 2026-03-10

### Bug Fixes

- honour extractionModel flat key when no provider is set
- eliminate double config load and cap requeue batch budget
- remove stale flat-model leak and merge requeue into single tx
- **pipeline**: pass memoryCfg to scoreContinuity, add maxTokens
- **pipeline**: add .catch() guards to callClaude stream reads
- **pipeline**: replace deleted LLM_TIMEOUT_MS with synthesis config
- **pipeline**: pass maxTokens and timeout to summary LLM calls
- **pipeline**: indent withSemaphore callback bodies
- **pipeline**: remove unused now variable in summary requeue
- **pipeline**: NaN deadlock guard, remove dead codex synthesis case
- **pipeline**: semaphore env var edge case, summary uses synthesis config
- **pipeline**: address bot review feedback on PR #180
- **pipeline**: global concurrency limiter and summary job requeue (#181)
- **pipeline**: address second round of PR #180 review comments
- **pipeline**: address PR #180 review comments
- **pipeline**: config resolution pairing, codex error capture, DAG upsert


## [0.53.0] - 2026-03-09

### Bug Fixes

- **sdk,daemon**: address CodeRabbit critical and nitpick findings
- **sdk**: strict typescript discipline - remove unsafe casts, add type guards, discriminated unions
- **sdk**: align sdk contracts with daemon responses


## [0.52.0] - 2026-03-09

### Features

- implement LCM foundation patterns for memory pipeline

### Bug Fixes

- **dag**: preserve row id on DAG write retry via ON CONFLICT DO UPDATE
- **retention**: address coderabbit pass-5 findings
- **lcm**: address coderabbit pass-4 findings
- **retention**: add original_row_json for truly lossless cold archival
- **lcm**: address greptile pass-2 findings
- address Greptile review findings


## [0.51.0] - 2026-03-09

### Features

- add user-prompt-submit hook to OpenCode plugin

### Bug Fixes

- address review feedback on prompt-submit hook
- cap pendingInject map to prevent unbounded growth


## [0.50.1] - 2026-03-09

### Features

- **tray**: embed dashboard via frontendDist, complete Phase 1
- **tray**: evolve system tray into full desktop application

### Bug Fixes

- **tray**: address PR #172 round 2 feedback
- **tray**: address PR #172 review feedback


## [0.50.0] - 2026-03-09

### Bug Fixes

- match toCanonicalName() whitespace collapse in migration 027
- resolve UNIQUE constraint crash in skill reconciler


## [0.49.0] - 2026-03-09

### Features

- **native**: add batch cosine similarity, KNN edges, axis normalization, and hybrid score merging

### Bug Fixes

- **native**: address Greptile review — epsilon parity and dead export TODO


## [0.48.2] - 2026-03-09

### Features

- inject date/time metadata on every user-prompt-submit hook


## [0.48.1] - 2026-03-09

### Bug Fixes

- **windows**: truncate embedding vectors before UMAP projection
- **windows**: replace Bun.spawn with Node spawn for windowsHide support
- **windows**: normalize path separators in memory file watcher

### Docs

- research docs, LCM patterns spec, ACP integration vision, README rewrite


## [0.48.0] - 2026-03-09

### Bug Fixes

- **dashboard**: center PageBanner title on pages without side slots (#170)


## [0.47.2] - 2026-03-09

### Features

- **dashboard**: pinterest-inspired theme refresh

### Bug Fixes

- **dashboard**: address remaining PR #168 review comments
- **dashboard**: Address third round of review findings
- **dashboard**: Address second round of review findings
- **dashboard**: Address Greptile and CodeRabbit review findings
- **dashboard**: address Greptile review feedback

### Docs

- add PR screenshots for theme refresh


## [0.47.1] - 2026-03-09

### Bug Fixes

- **openclaw**: resolve package.json merge conflict with main
- **openclaw-adapter**: assert before_prompt_build hook priority
- **openclaw**: address additional PR review feedback
- **openclaw**: address PR review edge cases
- **openclaw**: sync connector and adapter compatibility


## [0.47.0] - 2026-03-08

### Bug Fixes

- **mcp**: flatten agent_message_send schema and clarify agent_peers description


## [0.46.0] - 2026-03-08

### Features

- add per-session bypass toggle for hook suppression

### Bug Fixes

- resolve merge conflict and address final review notes
- error when --off used without session key
- address reviewer feedback from CodeRabbit and Greptile
- address PR feedback — TOCTOU guard and toast on toggle failure

### Docs

- add bypass toggle to API, CLI, hooks, MCP, and dashboard docs
- add bypass toggle to API endpoints, env vars, and CLI docs


## [0.45.2] - 2026-03-08

### Features

- **daemon**: add cross-agent messaging and ACP relay

### Bug Fixes

- **daemon**: scope cross-agent SSE presence by project
- **daemon**: harden cross-agent prompt and routing safety
- **daemon**: harden cross-agent auth and ACP relay


## [0.45.1] - 2026-03-08

### Bug Fixes

- **dashboard**: address PR review feedback on page shell decomposition

### Refactoring

- **dashboard**: decompose +page.svelte into focused layout components


## [0.45.0] - 2026-03-08

### Bug Fixes

- **release**: rebase before version bump, undraft before npm publish
- **predictor**: address PR review feedback before merge
- **predictor**: fix binary name, config fallback, and redirect guard
- **predictor**: distribute binary, enable by default, fix traversal cache bug

### Docs

- delete duplicates
- add frontmatter to docs missing metadata


## [0.44.0] - 2026-03-08

### Features

- **dashboard**: add Home tab as default landing page
- **dashboard**: add Updates tab for roadmap and changelog
- **dashboard**: add knowledge graph overlay to constellation view
- **mcp**: register memory_feedback tool in MCP server
- **predictor**: agent feedback, training telemetry, and theory tests
- knowledge architecture KA-2 — two-pass structural assignment pipeline
- knowledge architecture KA-1 — schema, types, and graph helpers
- procedural memory P1 — skill_meta, enrichment, graph nodes, reconciler

### Bug Fixes

- **runtime**: ignore generated memory artifacts and rebuild core on start
- **predictor**: harden sidecar status and dashboard hot paths
- **dashboard**: fix broken predictor tab — double-portal, fetch mutex, config persistence
- **dashboard**: rework project docs navigation
- **upgrade**: harden upgrade path for total-recall merge
- **embedding**: add warn logging for silent embedding failures
- **provider**: track timeout flag in claude-code provider
- **search**: sanitize FTS5 keyword queries to prevent syntax errors
- **reconciler**: handle entities.name UNIQUE constraint collision
- **config**: enforce minAspectWeight <= maxAspectWeight
- **predictor**: add drift detection corrective actions and RFC 4180 CSV export
- **predictor**: use 17-element feature vectors matching sidecar contract
- **dashboard**: resolve 4 constellation view bugs from dogfood report
- **dashboard**: budget hierarchy and dependency edges in constellation renderer
- **knowledge-graph**: address three bugs found in review
- **knowledge-graph**: prune entity bloat and fix hierarchy inversion
- **hooks**: cap assistant term budget and preserve hyphenated identifiers
- **hooks**: prevent recall query pollution from assistant messages and metadata
- **hooks**: deduplicate session-start and prompt-submit token injection
- **openclaw**: strip metadata JSON envelope from user messages
- **build**: use hoisted linker for workspace symlink resolution
- **pipeline**: decouple structural classification from new fact writes
- **harness**: stop generating ~/.claude/CLAUDE.md (redundant with hook injection)
- address PR #152 review comments — security, predictor, knowledge graph, diagnostics
- **reconciler**: remove dead buildFrontmatterFingerprint call
- **predictor**: wire agent feedback into training labels, guard EMA on predictor scores
- **predictor**: address PR #152 review feedback — 3 logic bugs, 2 auth gaps, 2 style fixes
- **predictor**: QA fixes — drift wiring, health penalties, error handling
- **predictor**: implement observability + dashboard tab (Sprint 4)
- **predictor**: implement session-end comparison + training trigger (Sprint 3)
- **predictor**: implement daemon scoring integration (Sprint 1 + Sprint 2)
- **knowledge**: implement ka-6 feedback loop
- **knowledge**: implement ka-5 continuity and dashboard
- **predictor**: record structural comparison signals
- **daemon**: implement KA-3 traversal retrieval wiring
- add missing agent_id scoping to knowledge-graph queries

### Refactoring

- **dashboard**: unify settings and config into single page

### Docs

- add Desire Paths concept spec for graph-native retrieval
- address review feedback on specs, dashboard, and vision
- add Figma MCP integration rules to AGENTS.md
- full overhaul for total-recall branch
- testing philosophy and research paper outline
- KA-3 through KA-6 sprint briefs and exploration philosophy
- KA-2 sprint brief with two-pass structural assignment architecture
- update KA spec for agent_id scoping, add KA-1 sprint brief
- add frontmatter to IDEAL-SIGNET.md


## [0.43.1] - 2026-03-08

### Features

- comprehensive keyboard navigation for dashboard

### Bug Fixes

- remove duplicate handleGlobalKey in MarketplaceTab, SecretsTab ArrowLeft sidebar return
- SettingsTab defaultPrevented guard + SecretsTab item ArrowUp sidebar return
- address remaining Greptile review findings
- address keyboard navigation review comments (wave 6)
- MarketplaceTab filter nav broken, dead focusout, MemoryTab no-op Escape
- ArrowLeft from any task in first column returns to sidebar
- sort 1Password focus targets by data-focus-index
- add missing Escape content→tabs transition for memory group
- address fourth wave of keyboard navigation review comments
- address third wave of keyboard navigation review comments
- use closest for doc-card detection and listitem role for secret rows
- address second wave of keyboard navigation review comments
- address all keyboard navigation review comments


## [0.43.0] - 2026-03-08

### Bug Fixes

- use %CD% instead of $(pwd) for Windows hook commands
- address review feedback on windows-spawn-hide PR
- **windows**: prevent console window flashing from spawn calls


## [0.42.3] - 2026-03-08

### Features

- **web**: add scroll-animated marketing lead capture page

### Bug Fixes

- **synthesis**: address Greptile follow-up feedback
- **synthesis**: close shutdown lock races
- **synthesis**: expose drain timeout status
- **synthesis**: tighten shutdown lock handling
- **synthesis**: harden shutdown and tests
- **synthesis**: serialize legacy writes and drain shutdown

### Docs

- **synthesis**: document drain() precondition on SynthesisWorkerHandle


## [0.42.2] - 2026-03-06

### Bug Fixes

- **codex**: address post-merge Greptile follow-ups (#153)


## [0.42.1] - 2026-03-06

### Bug Fixes

- **daemon**: re-export embedding helpers and getSecret after extraction
- **daemon**: guard legacy hook path from envelope pollution in snippets
- **daemon**: use hybrid recall for prompt submit
- **openclaw**: clean recall queries and refresh plugin runtime


## [0.42.0] - 2026-03-06

### Bug Fixes

- **synthesis**: use JSON.parse for content guard instead of startsWith
- **synthesis**: filter session files by mtime for incremental merges
- **synthesis**: read session summaries instead of raw DB facts


## [0.41.0] - 2026-03-06

### Features

- add native Rust vector operations with SIMD acceleration

### Bug Fixes

- document truncation behavior in cosine_similarity
- address greptile round 3 feedback
- address greptile round 2 feedback on vector ops
- address PR review feedback on vector operations

### Docs

- remediate P0/P1 drift from audit (2026-03)


## [0.40.0] - 2026-03-06

### Features

- **codex**: add codex harness and extraction support

### Bug Fixes

- **codex**: simplify timeout error handling, accept model in scheduler
- **codex**: deduplicate assistant lines, remove node dep, revert dev port
- **codex**: broaden transcript normalization
- **dashboard**: allow dev port fallback
- **daemon**: cache memory schema probe
- **codex**: report provider timeouts
- **connectors**: harden wrapper payload handling
- **codex**: address review feedback


## [0.39.0] - 2026-03-06

### Features

- add @signet/native Rust crate with napi-rs bindings
- session-activity-based synthesis with dedicated provider
- daemon-driven MEMORY.md synthesis on schedule

### Bug Fixes

- use command -v for cargo detection in build:native
- address greptile round 4 — gate provider init, tri-state result
- address greptile round 2 feedback
- align @signet/native version with workspace (0.39.0)
- address review feedback on native addon
- address greptile round 3 — duplicate import, enabled flag, cleanup
- address greptile round 2 — triggerNow retry, deleted MEMORY.md, log category
- prevent rapid retry on synthesis failure, export PipelineSynthesisConfig
- address greptile review — race guard and maxTokens in prompt


## [0.38.6] - 2026-03-06

### Features

- **timeline**: add signet evolution timeline recap view
- add doc drift detection script and agent prompt

### Bug Fixes

- **dashboard**: clear overlay when entering none mode
- **dashboard**: avoid persisting hidden overlay state
- **dashboard**: refine none-mode relation and overlay cues
- **dashboard**: split read-side hydration into independent try/catch blocks
- **doc-drift**: filter valid flags from unknown-flag error, guard commit failure
- **dashboard**: improve none-mode legend copy
- **doc-drift**: trailing whitespace in table rows, build dirs, safe commit message
- **dashboard**: clarify none-mode constellation legend
- **doc-drift**: distinguish absent vs stale migration range in summary
- **dashboard**: remove dead new-since hydration branch
- **doc-drift**: handle exit code 2 explicitly in agent prompt
- **dashboard**: align constellation source colors and session overlay state
- **doc-drift**: move dot-dir guard to top of scan loop
- **doc-drift**: apply private filter and dot-dir guard consistently
- **doc-drift**: circular symlink guard, private package filter, empty actualMax report
- **doc-drift**: accept empty route descriptions, clarify absent migration section
- **doc-drift**: fix ALL symmetry in extraInDocs, migration fallback, and sub-router note
- **doc-drift**: guard broken symlinks and expand ALL in docKeys
- **doc-drift**: guard statSync against broken symlinks in packages dir
- **doc-drift**: skip 4 header lines when embedding drift report in PR body
- **doc-drift**: dedup routes, fix key-file pattern, fix PR heading hierarchy
- **doc-drift**: move scan recursion inside for loop
- **doc-drift**: fix line offsets, nested package discovery, redundant runs
- **doc-drift**: address Greptile review comments
- **doc-drift**: reset regex lastIndex between files, fix indentation
- **timeline**: address second greptile review pass
- **timeline**: address greptile review comments
- **scripts**: harden package parsing and prompt messaging
- **timeline**: correct card windows and timestamp display
- **scripts**: harden doc drift section parsing
- **dashboard**: split storage writes by backend
- **dashboard**: harden timeline keyboard and tab semantics
- **scripts**: harden doc drift detector parsing
- **dashboard**: tighten overlay toggle and storage cleanup
- **timeline**: clamp avgImportance to [0,1] range
- **timeline**: use UTC timezone for footer 'As of' timestamp
- **timeline**: apply greptile review fixes
- **dashboard**: clean up constellation control regressions
- **dashboard**: restore overlays toggle in constellation
- **dashboard**: make constellation color mode session-scoped

### Performance

- hoist prepared statements and batch trackFtsHits


## [0.38.5] - 2026-03-05

### Bug Fixes

- **daemon**: harden SIGNET-ARCHITECTURE.md persistence (#137)


## [0.38.4] - 2026-03-05

### Bug Fixes

- initial scroll-to-bottom and stuck connecting state in LogsTab
- **logs**: close stream edge cases and recent-read gaps
- **logs**: ship refreshed UI with hardened stream behavior


## [0.38.3] - 2026-03-05

### Bug Fixes

- treat empty ollama base_url as missing
- handle ollama base_url nullish defaulting consistently
- default ollama embedding base_url to localhost:11434


## [0.38.2] - 2026-03-04

### Bug Fixes

- **daemon**: bump extraction timeout default from 45s to 90s


## [0.38.1] - 2026-03-04

### Bug Fixes

- **daemon**: replace `as Error` casts with proper narrowing in db-accessor


## [0.38.0] - 2026-03-04

### Bug Fixes

- **daemon**: replace self-fetch in search endpoint, add vec0 error logging


## [0.37.2] - 2026-03-04

### Features

- prompt to restart OpenClaw after daemon restart


## [0.37.1] - 2026-03-04

### Bug Fixes

- resolve vec_embeddings desync causing constellation crash

### Docs

- add OpenClaw migration guidance and self-healing checks
- the ideal signet
- reorganize specs, add integration contract and sprint brief


## [0.37.0] - 2026-03-04

### Bug Fixes

- replace type assertions with runtime narrowing in startConnectorSync
- **connectors**: add harness and connector resync actions


## [0.36.2] - 2026-03-04

### Features

- **marketplace**: unify app detail sheets and scoped reviews

### Bug Fixes

- **dashboard**: clear remaining svelte warnings
- **dashboard**: reduce marketplace warning noise

### Docs

- **web**: replace introducing signet blog post with architectural explainer
- **web**: add positioning blog post and update hero copy


## [0.36.0] - 2026-03-03

### Docs

- update documentation suite and add runtime spec


## [0.35.4] - 2026-03-03

### Features

- **web**: docs layout redesign, blog updates, and graph viewer
- **web**: blog layout polish, share buttons, and SEO fixes

### Bug Fixes

- **web**: widen docs and blog content columns

### Docs

- integrate addendum sections into knowledge architecture body


## [0.35.3] - 2026-03-03

### Bug Fixes

- **embedding**: log ollama fallback failures for observability
- **embedding**: resolve native embedding regression and restore ollama support


## [0.35.2] - 2026-03-03

### Bug Fixes

- resolve skills marketplace tab crash from duplicate each-block keys


## [0.35.1] - 2026-03-03

### Docs

- update Patchy's credit link to Substack


## [0.35.0] - 2026-03-03

### Docs

- add hyperlinks to author credits


## [0.34.1] - 2026-03-03

### Features

- **web**: add constraint confidence, bounded context, and set-and-forget sections to blog post

### Bug Fixes

- **docs**: repair attribution formatting in knowledge architecture doc

### Docs

- update Patchy's credit to full name — Micheal Luigi Pacitto
- credit Michael (PatchyToes) for entity/aspect/attribute framework contributions
- constraint confidence, bounded context, and set-and-forget principle


## [0.34.0] - 2026-03-03

### Bug Fixes

- externalize @huggingface/transformers from bundler


## [0.33.8] - 2026-03-03

### Features

- **dashboard**: consolidate navigation from 10 items to 6 with grouped sub-tabs


## [0.33.7] - 2026-03-03

### Bug Fixes

- **embedding**: harden native transformers bootstrap path


## [0.33.6] - 2026-03-03

### Bug Fixes

- **daemon**: harden native embedding init for transformers exports


## [0.33.5] - 2026-03-03

### Bug Fixes

- **daemon**: alias sharp to empty shim via Bun.build() API


## [0.33.4] - 2026-03-03

### Bug Fixes

- **daemon**: externalize sharp to prevent native binary path errors


## [0.33.3] - 2026-03-03

### Bug Fixes

- **daemon**: fix native embedding init by properly externalizing onnxruntime-node


## [0.33.2] - 2026-03-03

### Bug Fixes

- **daemon**: externalize onnxruntime-node and huggingface/transformers from bundle


## [0.33.1] - 2026-03-03

### Bug Fixes

- **daemon**: lazy-load @1password/sdk to prevent WASM ENOENT crash


## [0.33.0] - 2026-03-03

### Bug Fixes

- **embeddings**: harden repair flows and surface live progress


## [0.32.0] - 2026-03-03

### Features

- **daemon**: add built-in native embedding provider via transformers.js

### Bug Fixes

- **specs**: resolve package.json merge conflict cleanly
- **daemon**: reset modelCached flag on native provider shutdown


## [0.31.3] - 2026-03-03

### Features

- **dashboard**: add task presets and skill integration for scheduled tasks

### Bug Fixes

- **daemon**: validate skill name against path traversal in task routes


## [0.31.2] - 2026-03-03

### Bug Fixes

- **dashboard**: persist active tab in URL hash across page refreshes


## [0.31.1] - 2026-03-03

### Bug Fixes

- dashboard config persistence, version display, auto-update self-restart, and docs cleanup


## [0.31.0] - 2026-03-03

### Bug Fixes

- **daemon**: ignore SQLite journal files in file watcher


## [0.30.0] - 2026-03-03

### Features

- **extension**: add browser extension for Chrome and Firefox


## [0.29.0] - 2026-03-03

### Features

- **dashboard**: add intuitive 1password secrets flow
- **secrets**: add 1password sdk integration for secret refs and import

### Bug Fixes

- **embeddings**: wire repair actions and vec resync
- **secrets**: keep exec path non-blocking


## [0.28.0] - 2026-03-03

### Features

- **web**: update vision blog post - "It Learns Now"


## [0.27.1] - 2026-03-03

### Features

- **web**: add knowledge architecture blog og image
- **web**: knowledge architecture blog post

### Bug Fixes

- **dashboard**: auto-fit constellation camera on vertical viewports
- **dashboard**: restore feed follow behavior on latest main
- **repo**: resolve test and typecheck regressions

### Docs

- the database knows what you did last summer


## [0.27.0] - 2026-03-03

### Bug Fixes

- **daemon**: avoid marketplace MCP route shadowing


## [0.26.0] - 2026-03-03

### Features

- **mcp**: add scoped search-driven tool exposure


## [0.25.2] - 2026-03-03

### Features

- **dashboard**: add constellation newness heatmap

### Bug Fixes

- **dashboard**: tighten newness palette and source gating
- **dashboard**: update newness palette buckets
- **dashboard**: refine constellation newness color buckets
- **dashboard**: address all Greptile review feedback
- **dashboard**: address Greptile review feedback
- **dashboard**: consistent nav button position in ConfigTab
- **dashboard**: restore provider dropdown, fix indentation, add ConfigTab polish

### Refactoring

- **dashboard**: polish settings page with single-section view


## [0.25.1] - 2026-03-03

### Bug Fixes

- use directory junctions on Windows for skill symlinks


## [0.25.0] - 2026-03-03

### Bug Fixes

- use file:// URL for ESM dynamic import on Windows


## [0.24.0] - 2026-03-02

### Features

- **mcp**: live refresh marketplace proxy tools


## [0.23.0] - 2026-03-02

### Features

- **dashboard**: add sync button for document connectors


## [0.22.0] - 2026-03-02

### Features

- **dashboard**: add keyboard shortcuts for tasks tab
- **dashboard**: add minimap for large embedding graphs


## [0.21.0] - 2026-03-02

### Features

- **dashboard**: add section-level dirty indicators in settings

### Performance

- **dashboard**: lazy load EmbeddingCanvas3D and defer graph init


## [0.20.2] - 2026-03-02

### Features

- **marketplace**: add curated storefront and MCP server workflows


## [0.20.1] - 2026-03-02

### Refactoring

- **dashboard**: add loading indicator during search debounce


## [0.20.0] - 2026-03-02

### Bug Fixes

- **dashboard**: add keyboard navigation and delete confirmation for memory cards
- **hooks**: sanitize per-prompt recall query context


## [0.19.0] - 2026-03-02

### Features

- **web**: two-column blog layout with sticky TOC rail
- **web**: improve blog readability, navigation, and add hero images


## [0.18.0] - 2026-03-02

### Features

- **dashboard**: add edit and delete actions to memory cards

### Bug Fixes

- **dashboard**: close handleEdit brace and add error handling for edit failure
- **dashboard**: remove as cast, properly type updates object in MemoryForm


## [0.17.0] - 2026-03-02

### Features

- **web**: add ChatGPT to Claude migration tutorial blog post


## [0.16.0] - 2026-03-02

### Features

- **web**: add blog, architecture page, and expanded navigation

### Docs

- update AGENTS.md
- comprehensive audit and update for v0.14.5 codebase


## [0.15.1] - 2026-03-02

### Features

- **dashboard**: add Cmd/Ctrl+S keyboard shortcut to save settings
- **dashboard**: show total/filtered memory count above grid

### Performance

- **dashboard**: cache skills catalog in localStorage for instant repeat loads


## [0.15.0] - 2026-03-02

### Bug Fixes

- **daemon**: use Homebrew SQLite on macOS for extension loading


## [0.14.5] - 2026-03-01

### Features

- **web**: add SEO and AEO infrastructure


## [0.14.4] - 2026-03-01

### Bug Fixes

- **dashboard{logs**: preserve reconnect counter across retries for correct exponential backoff (#68)


## [0.14.3] - 2026-03-01

### Bug Fixes

- **embeddings**: stabilize large constellation layouts and add physics tuning


## [0.14.2] - 2026-03-01

### Bug Fixes

- **daemon**: prevent tracker inserts from violating embeddings schema


## [0.14.1] - 2026-03-01

### Bug Fixes

- resolve embedding tracker dimensions constraint and prompt recall query issues


## [0.14.0] - 2026-03-01

### Bug Fixes

- use PreCompact hook key instead of PreCompaction for Claude Code


## [0.13.0] - 2026-03-01

### Features

- add incremental embedding refresh tracker


## [0.12.3] - 2026-03-01

### Features

- pre-compaction capture + enriched passive checkpoints (Phase 2)
- session continuity protocol (Phase 1)


## [0.12.2] - 2026-03-01

### Bug Fixes

- **daemon**: reorder secrets routes so /exec isn't swallowed by /:name


## [0.12.1] - 2026-03-01

### Bug Fixes

- **openclaw**: harden workspace path validation and add connector health visibility


## [0.12.0] - 2026-03-01

### Bug Fixes

- **dashboard**: handle null editingId for new task creation
- **dashboard**: prevent task form from resetting on auto-refresh


## [0.11.2] - 2026-03-01

### Features

- **web**: redesign CoreFeatures into a modular blueprint layout
- **web**: add interactive dithered ASCII animation to hero section
- **web**: polish landing page design based on signet-design system
- **web**: redesign landing page, add MDX testimonials, mobile optimization
- **web**: add shadcn/ui component library with Tailwind v4


## [0.11.1] - 2026-02-28

### Bug Fixes

- **install**: harden agent setup instructions and add guard


## [0.11.0] - 2026-02-28

### Bug Fixes

- **cli**: make logs path-aware for custom workspaces
- **setup**: support existing OpenClaw workspace directories


## [0.10.4] - 2026-02-28

### Features

- **dashboard**: cross-page polish - microcopy, command palette, layout persistence
- **dashboard**: improve skills discovery trust and comparison

### Bug Fixes

- deep merge layout defaults for schema evolution
- persist embeddings layout changes to localStorage
- complete layout persistence and remove duplicate effect
- **dashboard**: improve config/settings save-state UX
- **pipeline**: harden OpenCode extraction recovery


## [0.10.3] - 2026-02-28

### Bug Fixes

- **dashboard**: remove sidebar and pipeline divider lines
- **dashboard**: make settings collapsible sections clickable


## [0.10.2] - 2026-02-28

### Bug Fixes

- **dashboard**: improve expanded pipeline log visibility


## [0.10.1] - 2026-02-28

### Refactoring

- **dashboard**: componentize settings tab and extract state


## [0.10.0] - 2026-02-28

### Bug Fixes

- **dashboard**: improve pipeline live feed usability
- **cli**: prevent CLI from hanging after daemon start/restart


## [0.9.0] - 2026-02-28

### Features

- **predictor**: implement phase 2 training pipeline

### Bug Fixes

- **ci**: harden release push step against temp files
- **ci**: clean bump-level temp file in release workflow
- **ci**: avoid dirty worktree in release publish steps
- restore typecheck and cross-platform config tests

### Refactoring

- **daemon**: extract skills routes into standalone module
- **dashboard**: replace PageHero with compact top bar headers


## [0.9.0] - 2026-02-28

### Features

- add OpenCode as extraction LLM provider

### Bug Fixes

- **config-ui**: box key config section titles


## [0.8.1] - 2026-02-27

### Refactoring

- **hooks**: add timestamps to memory injection context

### Docs

- clarify commit prefix guidance — reserve feat: for user-facing features


## [0.8.0] - 2026-02-27

### Bug Fixes

- **docs**: add missing frontmatter to daemon-rust-rewrite spec


## [0.7.0] - 2026-02-27

### Features

- **onboarding**: overhaul onboarding skill and fix remember/recall guidance

### Bug Fixes

- **predictor**: reject mismatched candidate_features instead of silent zero-fill


## [0.6.3] - 2026-02-27

### Features

- **predictor**: implement phase 1 scorer scaffold


## [0.6.2] - 2026-02-27

### Bug Fixes

- **defaults**: enable pipeline, graph, reranker, and autonomous by default


## [0.6.1] - 2026-02-27

### Bug Fixes

- **cli**: honor --skip-git and reject unknown --harness in non-interactive setup

### Performance

- **dashboard**: lazy-load tab content modules


## [0.6.0] - 2026-02-27

### Bug Fixes

- **scheduler**: strip CLAUDECODE env var when spawning tasks


## [0.5.3] - 2026-02-27

### Features

- **cli**: require explicit providers for non-interactive setup


## [0.5.2] - 2026-02-27

### Refactoring

- **cli**: restrict setup wizard to supported connectors


## [0.5.1] - 2026-02-27

### Bug Fixes

- add dashboard screenshots as jpg to public/
- **tasks**: streamline edit flow and detail run state
- **tasks**: stream live task runs and correct opencode execution


## [0.5.0] - 2026-02-27

### Bug Fixes

- **embeddings**: stop scope time-filter refresh loop


## [0.4.2] - 2026-02-27

### Features

- **embeddings**: add scoped projection filters and point window controls


## [0.4.1] - 2026-02-27

### Bug Fixes

- **connector-openclaw**: prevent temp workspace paths from leaking into config


## [0.4.0] - 2026-02-27

### Docs

- add secrets API endpoints and MCP tools to CLAUDE.md


## [0.3.0] - 2026-02-27

### Features

- **secrets**: expose secrets to agents via MCP tools and session context
- **dashboard**: enhance skills UI with monograms, trending row, and polish

### Bug Fixes

- **ci**: bump base version past deprecated 0.3.0 on npm
- **publish**: convert postinstall to CJS for reliable npm install


## [0.2.0] - 2026-02-26

### Bug Fixes

- **pipeline**: propagate LLM failures and improve observability


## [0.1.135] - 2026-02-25

### Features

- **telemetry**: add anonymous opt-in telemetry with token tracking
- **dashboard**: add interactive Pipeline visualization tab
- **pipeline**: backwards deduplication pass for memory pipeline
- **hooks**: make Signet legible to its own agents
- **dashboard**: full log payloads + config char budgets
- **core**: add document ingestion pipeline
- **skills**: add ClawHub provider and marketplace card grid UI
- **daemon**: add unified embedding health check endpoint and dashboard UI
- **daemon**: add memory content size guardrails
- **web**: add curl install script for signetai.sh/install
- **skills**: add /onboarding skill for interactive agent setup
- add scheduled agent tasks with cron-based execution
- **adapter-openclaw**: prepare package for npm publish
- memory system roadmap — 8 features + docs
- **daemon**: inject local date/time and timezone in session-start hook
- **daemon**: expose MCP server for native tool access from harnesses
- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **pipeline**: add per-job exponential backoff to prevent rapid retry cycling
- **pipeline**: respect enabled=false master switch in summary worker
- **hooks**: prevent recursive extraction loops in spawned agents
- **dashboard**: resolve settings from daemon's config priority
- **hooks**: prevent context overflow and filter deleted memories
- **daemon**: fix 6 runtime bugs across summary worker, API routes, and DB accessor
- **adapter**: add clawdbot compatibility to openclaw adapter
- **connector-openclaw**: claim memory slot and disable native memorySearch
- **openclaw**: rewrite adapter to OpenClaw register(api) plugin pattern
- **skills**: move onboarding skill to signetai/templates/skills
- **ci**: bump version to 0.1.116 to fix npm publish collision
- **dashboard**: use let for $state binding in FormSection
- **adapter-openclaw**: add openclaw.plugin.json manifest and use unscoped plugin id
- **adapter-openclaw**: rename package scope from @signet to @signetai for npm publish
- **dashboard**: move submit button back inside form element
- **adapter-openclaw**: use DOM lib instead of node types for CI compat
- **connector-openclaw**: use object format for plugins config
- **dashboard**: clean up bloated pipeline settings UI
- **cli**: remove duplicate embed command registration
- **cli**: rename duplicate embedCmd variable to fix build
- **core**: pass Float32Array instead of Buffer to vec0 MATCH query
- **connector-base**: add @types/node for node:fs and node:path imports
- include SOUL.md, IDENTITY.md, USER.md in all harness config generation
- **connector-claude-code**: register MCP server in ~/.claude.json, not settings.json
- **core**: use npm root -g to find sqlite-vec when running under bun
- **core**: search well-known npm global paths for sqlite-vec extension
- **signetai**: add signet-mcp bin entry and build step to meta-package
- **cli**: drop stale vec_embeddings before recreating with correct dimensions
- **embeddings**: read actual dimensions instead of hardcoding vec0 table size
- **cli**: load sqlite-vec extension before CREATE VIRTUAL TABLE in migrate-vectors
- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **ingest**: decouple extractors from Ollama, deduplicate shared utilities
- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- it learns now
- add memory loop pipeline diagrams
- teach agents they can't see their own infrastructure
- update AGENTS.md
- **skill.md**: move /onboarding details to skill, keep as suggestion in install
- **skill.md**: add /onboarding as Step 6 in installation flow
- **skill.md**: add full /onboarding section to install guide
- add contribution strategy
- require shadcn-svelte components for dashboard UI work
- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.134] - 2026-02-25

### Features

- **dashboard**: add interactive Pipeline visualization tab
- **pipeline**: backwards deduplication pass for memory pipeline
- **hooks**: make Signet legible to its own agents
- **dashboard**: full log payloads + config char budgets
- **core**: add document ingestion pipeline
- **skills**: add ClawHub provider and marketplace card grid UI
- **daemon**: add unified embedding health check endpoint and dashboard UI
- **daemon**: add memory content size guardrails
- **web**: add curl install script for signetai.sh/install
- **skills**: add /onboarding skill for interactive agent setup
- add scheduled agent tasks with cron-based execution
- **adapter-openclaw**: prepare package for npm publish
- memory system roadmap — 8 features + docs
- **daemon**: inject local date/time and timezone in session-start hook
- **daemon**: expose MCP server for native tool access from harnesses
- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **hooks**: prevent recursive extraction loops in spawned agents
- **dashboard**: resolve settings from daemon's config priority
- **hooks**: prevent context overflow and filter deleted memories
- **daemon**: fix 6 runtime bugs across summary worker, API routes, and DB accessor
- **adapter**: add clawdbot compatibility to openclaw adapter
- **connector-openclaw**: claim memory slot and disable native memorySearch
- **openclaw**: rewrite adapter to OpenClaw register(api) plugin pattern
- **skills**: move onboarding skill to signetai/templates/skills
- **ci**: bump version to 0.1.116 to fix npm publish collision
- **dashboard**: use let for $state binding in FormSection
- **adapter-openclaw**: add openclaw.plugin.json manifest and use unscoped plugin id
- **adapter-openclaw**: rename package scope from @signet to @signetai for npm publish
- **dashboard**: move submit button back inside form element
- **adapter-openclaw**: use DOM lib instead of node types for CI compat
- **connector-openclaw**: use object format for plugins config
- **dashboard**: clean up bloated pipeline settings UI
- **cli**: remove duplicate embed command registration
- **cli**: rename duplicate embedCmd variable to fix build
- **core**: pass Float32Array instead of Buffer to vec0 MATCH query
- **connector-base**: add @types/node for node:fs and node:path imports
- include SOUL.md, IDENTITY.md, USER.md in all harness config generation
- **connector-claude-code**: register MCP server in ~/.claude.json, not settings.json
- **core**: use npm root -g to find sqlite-vec when running under bun
- **core**: search well-known npm global paths for sqlite-vec extension
- **signetai**: add signet-mcp bin entry and build step to meta-package
- **cli**: drop stale vec_embeddings before recreating with correct dimensions
- **embeddings**: read actual dimensions instead of hardcoding vec0 table size
- **cli**: load sqlite-vec extension before CREATE VIRTUAL TABLE in migrate-vectors
- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **ingest**: decouple extractors from Ollama, deduplicate shared utilities
- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- it learns now
- add memory loop pipeline diagrams
- teach agents they can't see their own infrastructure
- update AGENTS.md
- **skill.md**: move /onboarding details to skill, keep as suggestion in install
- **skill.md**: add /onboarding as Step 6 in installation flow
- **skill.md**: add full /onboarding section to install guide
- add contribution strategy
- require shadcn-svelte components for dashboard UI work
- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.133] - 2026-02-25

### Features

- **dashboard**: add interactive Pipeline visualization tab
- **pipeline**: backwards deduplication pass for memory pipeline
- **hooks**: make Signet legible to its own agents
- **dashboard**: full log payloads + config char budgets
- **core**: add document ingestion pipeline
- **skills**: add ClawHub provider and marketplace card grid UI
- **daemon**: add unified embedding health check endpoint and dashboard UI
- **daemon**: add memory content size guardrails
- **web**: add curl install script for signetai.sh/install
- **skills**: add /onboarding skill for interactive agent setup
- add scheduled agent tasks with cron-based execution
- **adapter-openclaw**: prepare package for npm publish
- memory system roadmap — 8 features + docs
- **daemon**: inject local date/time and timezone in session-start hook
- **daemon**: expose MCP server for native tool access from harnesses
- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **hooks**: prevent recursive extraction loops in spawned agents
- **dashboard**: resolve settings from daemon's config priority
- **hooks**: prevent context overflow and filter deleted memories
- **daemon**: fix 6 runtime bugs across summary worker, API routes, and DB accessor
- **adapter**: add clawdbot compatibility to openclaw adapter
- **connector-openclaw**: claim memory slot and disable native memorySearch
- **openclaw**: rewrite adapter to OpenClaw register(api) plugin pattern
- **skills**: move onboarding skill to signetai/templates/skills
- **ci**: bump version to 0.1.116 to fix npm publish collision
- **dashboard**: use let for $state binding in FormSection
- **adapter-openclaw**: add openclaw.plugin.json manifest and use unscoped plugin id
- **adapter-openclaw**: rename package scope from @signet to @signetai for npm publish
- **dashboard**: move submit button back inside form element
- **adapter-openclaw**: use DOM lib instead of node types for CI compat
- **connector-openclaw**: use object format for plugins config
- **dashboard**: clean up bloated pipeline settings UI
- **cli**: remove duplicate embed command registration
- **cli**: rename duplicate embedCmd variable to fix build
- **core**: pass Float32Array instead of Buffer to vec0 MATCH query
- **connector-base**: add @types/node for node:fs and node:path imports
- include SOUL.md, IDENTITY.md, USER.md in all harness config generation
- **connector-claude-code**: register MCP server in ~/.claude.json, not settings.json
- **core**: use npm root -g to find sqlite-vec when running under bun
- **core**: search well-known npm global paths for sqlite-vec extension
- **signetai**: add signet-mcp bin entry and build step to meta-package
- **cli**: drop stale vec_embeddings before recreating with correct dimensions
- **embeddings**: read actual dimensions instead of hardcoding vec0 table size
- **cli**: load sqlite-vec extension before CREATE VIRTUAL TABLE in migrate-vectors
- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **ingest**: decouple extractors from Ollama, deduplicate shared utilities
- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- add memory loop pipeline diagrams
- teach agents they can't see their own infrastructure
- update AGENTS.md
- **skill.md**: move /onboarding details to skill, keep as suggestion in install
- **skill.md**: add /onboarding as Step 6 in installation flow
- **skill.md**: add full /onboarding section to install guide
- add contribution strategy
- require shadcn-svelte components for dashboard UI work
- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.132] - 2026-02-25

### Features

- **pipeline**: backwards deduplication pass for memory pipeline
- **hooks**: make Signet legible to its own agents
- **dashboard**: full log payloads + config char budgets
- **core**: add document ingestion pipeline
- **skills**: add ClawHub provider and marketplace card grid UI
- **daemon**: add unified embedding health check endpoint and dashboard UI
- **daemon**: add memory content size guardrails
- **web**: add curl install script for signetai.sh/install
- **skills**: add /onboarding skill for interactive agent setup
- add scheduled agent tasks with cron-based execution
- **adapter-openclaw**: prepare package for npm publish
- memory system roadmap — 8 features + docs
- **daemon**: inject local date/time and timezone in session-start hook
- **daemon**: expose MCP server for native tool access from harnesses
- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **dashboard**: resolve settings from daemon's config priority
- **hooks**: prevent context overflow and filter deleted memories
- **daemon**: fix 6 runtime bugs across summary worker, API routes, and DB accessor
- **adapter**: add clawdbot compatibility to openclaw adapter
- **connector-openclaw**: claim memory slot and disable native memorySearch
- **openclaw**: rewrite adapter to OpenClaw register(api) plugin pattern
- **skills**: move onboarding skill to signetai/templates/skills
- **ci**: bump version to 0.1.116 to fix npm publish collision
- **dashboard**: use let for $state binding in FormSection
- **adapter-openclaw**: add openclaw.plugin.json manifest and use unscoped plugin id
- **adapter-openclaw**: rename package scope from @signet to @signetai for npm publish
- **dashboard**: move submit button back inside form element
- **adapter-openclaw**: use DOM lib instead of node types for CI compat
- **connector-openclaw**: use object format for plugins config
- **dashboard**: clean up bloated pipeline settings UI
- **cli**: remove duplicate embed command registration
- **cli**: rename duplicate embedCmd variable to fix build
- **core**: pass Float32Array instead of Buffer to vec0 MATCH query
- **connector-base**: add @types/node for node:fs and node:path imports
- include SOUL.md, IDENTITY.md, USER.md in all harness config generation
- **connector-claude-code**: register MCP server in ~/.claude.json, not settings.json
- **core**: use npm root -g to find sqlite-vec when running under bun
- **core**: search well-known npm global paths for sqlite-vec extension
- **signetai**: add signet-mcp bin entry and build step to meta-package
- **cli**: drop stale vec_embeddings before recreating with correct dimensions
- **embeddings**: read actual dimensions instead of hardcoding vec0 table size
- **cli**: load sqlite-vec extension before CREATE VIRTUAL TABLE in migrate-vectors
- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **ingest**: decouple extractors from Ollama, deduplicate shared utilities
- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- add memory loop pipeline diagrams
- teach agents they can't see their own infrastructure
- update AGENTS.md
- **skill.md**: move /onboarding details to skill, keep as suggestion in install
- **skill.md**: add /onboarding as Step 6 in installation flow
- **skill.md**: add full /onboarding section to install guide
- add contribution strategy
- require shadcn-svelte components for dashboard UI work
- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.131] - 2026-02-25

### Features

- **pipeline**: backwards deduplication pass for memory pipeline
- **hooks**: make Signet legible to its own agents
- **dashboard**: full log payloads + config char budgets
- **core**: add document ingestion pipeline
- **skills**: add ClawHub provider and marketplace card grid UI
- **daemon**: add unified embedding health check endpoint and dashboard UI
- **daemon**: add memory content size guardrails
- **web**: add curl install script for signetai.sh/install
- **skills**: add /onboarding skill for interactive agent setup
- add scheduled agent tasks with cron-based execution
- **adapter-openclaw**: prepare package for npm publish
- memory system roadmap — 8 features + docs
- **daemon**: inject local date/time and timezone in session-start hook
- **daemon**: expose MCP server for native tool access from harnesses
- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **hooks**: prevent context overflow and filter deleted memories
- **daemon**: fix 6 runtime bugs across summary worker, API routes, and DB accessor
- **adapter**: add clawdbot compatibility to openclaw adapter
- **connector-openclaw**: claim memory slot and disable native memorySearch
- **openclaw**: rewrite adapter to OpenClaw register(api) plugin pattern
- **skills**: move onboarding skill to signetai/templates/skills
- **ci**: bump version to 0.1.116 to fix npm publish collision
- **dashboard**: use let for $state binding in FormSection
- **adapter-openclaw**: add openclaw.plugin.json manifest and use unscoped plugin id
- **adapter-openclaw**: rename package scope from @signet to @signetai for npm publish
- **dashboard**: move submit button back inside form element
- **adapter-openclaw**: use DOM lib instead of node types for CI compat
- **connector-openclaw**: use object format for plugins config
- **dashboard**: clean up bloated pipeline settings UI
- **cli**: remove duplicate embed command registration
- **cli**: rename duplicate embedCmd variable to fix build
- **core**: pass Float32Array instead of Buffer to vec0 MATCH query
- **connector-base**: add @types/node for node:fs and node:path imports
- include SOUL.md, IDENTITY.md, USER.md in all harness config generation
- **connector-claude-code**: register MCP server in ~/.claude.json, not settings.json
- **core**: use npm root -g to find sqlite-vec when running under bun
- **core**: search well-known npm global paths for sqlite-vec extension
- **signetai**: add signet-mcp bin entry and build step to meta-package
- **cli**: drop stale vec_embeddings before recreating with correct dimensions
- **embeddings**: read actual dimensions instead of hardcoding vec0 table size
- **cli**: load sqlite-vec extension before CREATE VIRTUAL TABLE in migrate-vectors
- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **ingest**: decouple extractors from Ollama, deduplicate shared utilities
- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- add memory loop pipeline diagrams
- teach agents they can't see their own infrastructure
- update AGENTS.md
- **skill.md**: move /onboarding details to skill, keep as suggestion in install
- **skill.md**: add /onboarding as Step 6 in installation flow
- **skill.md**: add full /onboarding section to install guide
- add contribution strategy
- require shadcn-svelte components for dashboard UI work
- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.130] - 2026-02-25

### Features

- **pipeline**: backwards deduplication pass for memory pipeline
- **hooks**: make Signet legible to its own agents
- **dashboard**: full log payloads + config char budgets
- **core**: add document ingestion pipeline
- **skills**: add ClawHub provider and marketplace card grid UI
- **daemon**: add unified embedding health check endpoint and dashboard UI
- **daemon**: add memory content size guardrails
- **web**: add curl install script for signetai.sh/install
- **skills**: add /onboarding skill for interactive agent setup
- add scheduled agent tasks with cron-based execution
- **adapter-openclaw**: prepare package for npm publish
- memory system roadmap — 8 features + docs
- **daemon**: inject local date/time and timezone in session-start hook
- **daemon**: expose MCP server for native tool access from harnesses
- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **adapter**: add clawdbot compatibility to openclaw adapter
- **connector-openclaw**: claim memory slot and disable native memorySearch
- **openclaw**: rewrite adapter to OpenClaw register(api) plugin pattern
- **skills**: move onboarding skill to signetai/templates/skills
- **ci**: bump version to 0.1.116 to fix npm publish collision
- **dashboard**: use let for $state binding in FormSection
- **adapter-openclaw**: add openclaw.plugin.json manifest and use unscoped plugin id
- **adapter-openclaw**: rename package scope from @signet to @signetai for npm publish
- **dashboard**: move submit button back inside form element
- **adapter-openclaw**: use DOM lib instead of node types for CI compat
- **connector-openclaw**: use object format for plugins config
- **dashboard**: clean up bloated pipeline settings UI
- **cli**: remove duplicate embed command registration
- **cli**: rename duplicate embedCmd variable to fix build
- **core**: pass Float32Array instead of Buffer to vec0 MATCH query
- **connector-base**: add @types/node for node:fs and node:path imports
- include SOUL.md, IDENTITY.md, USER.md in all harness config generation
- **connector-claude-code**: register MCP server in ~/.claude.json, not settings.json
- **core**: use npm root -g to find sqlite-vec when running under bun
- **core**: search well-known npm global paths for sqlite-vec extension
- **signetai**: add signet-mcp bin entry and build step to meta-package
- **cli**: drop stale vec_embeddings before recreating with correct dimensions
- **embeddings**: read actual dimensions instead of hardcoding vec0 table size
- **cli**: load sqlite-vec extension before CREATE VIRTUAL TABLE in migrate-vectors
- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **ingest**: decouple extractors from Ollama, deduplicate shared utilities
- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- add memory loop pipeline diagrams
- teach agents they can't see their own infrastructure
- update AGENTS.md
- **skill.md**: move /onboarding details to skill, keep as suggestion in install
- **skill.md**: add /onboarding as Step 6 in installation flow
- **skill.md**: add full /onboarding section to install guide
- add contribution strategy
- require shadcn-svelte components for dashboard UI work
- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.129] - 2026-02-25

### Features

- **hooks**: make Signet legible to its own agents
- **dashboard**: full log payloads + config char budgets
- **core**: add document ingestion pipeline
- **skills**: add ClawHub provider and marketplace card grid UI
- **daemon**: add unified embedding health check endpoint and dashboard UI
- **daemon**: add memory content size guardrails
- **web**: add curl install script for signetai.sh/install
- **skills**: add /onboarding skill for interactive agent setup
- add scheduled agent tasks with cron-based execution
- **adapter-openclaw**: prepare package for npm publish
- memory system roadmap — 8 features + docs
- **daemon**: inject local date/time and timezone in session-start hook
- **daemon**: expose MCP server for native tool access from harnesses
- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **adapter**: add clawdbot compatibility to openclaw adapter
- **connector-openclaw**: claim memory slot and disable native memorySearch
- **openclaw**: rewrite adapter to OpenClaw register(api) plugin pattern
- **skills**: move onboarding skill to signetai/templates/skills
- **ci**: bump version to 0.1.116 to fix npm publish collision
- **dashboard**: use let for $state binding in FormSection
- **adapter-openclaw**: add openclaw.plugin.json manifest and use unscoped plugin id
- **adapter-openclaw**: rename package scope from @signet to @signetai for npm publish
- **dashboard**: move submit button back inside form element
- **adapter-openclaw**: use DOM lib instead of node types for CI compat
- **connector-openclaw**: use object format for plugins config
- **dashboard**: clean up bloated pipeline settings UI
- **cli**: remove duplicate embed command registration
- **cli**: rename duplicate embedCmd variable to fix build
- **core**: pass Float32Array instead of Buffer to vec0 MATCH query
- **connector-base**: add @types/node for node:fs and node:path imports
- include SOUL.md, IDENTITY.md, USER.md in all harness config generation
- **connector-claude-code**: register MCP server in ~/.claude.json, not settings.json
- **core**: use npm root -g to find sqlite-vec when running under bun
- **core**: search well-known npm global paths for sqlite-vec extension
- **signetai**: add signet-mcp bin entry and build step to meta-package
- **cli**: drop stale vec_embeddings before recreating with correct dimensions
- **embeddings**: read actual dimensions instead of hardcoding vec0 table size
- **cli**: load sqlite-vec extension before CREATE VIRTUAL TABLE in migrate-vectors
- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **ingest**: decouple extractors from Ollama, deduplicate shared utilities
- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- add memory loop pipeline diagrams
- teach agents they can't see their own infrastructure
- update AGENTS.md
- **skill.md**: move /onboarding details to skill, keep as suggestion in install
- **skill.md**: add /onboarding as Step 6 in installation flow
- **skill.md**: add full /onboarding section to install guide
- add contribution strategy
- require shadcn-svelte components for dashboard UI work
- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.128] - 2026-02-25

### Features

- **dashboard**: full log payloads + config char budgets
- **core**: add document ingestion pipeline
- **skills**: add ClawHub provider and marketplace card grid UI
- **daemon**: add unified embedding health check endpoint and dashboard UI
- **daemon**: add memory content size guardrails
- **web**: add curl install script for signetai.sh/install
- **skills**: add /onboarding skill for interactive agent setup
- add scheduled agent tasks with cron-based execution
- **adapter-openclaw**: prepare package for npm publish
- memory system roadmap — 8 features + docs
- **daemon**: inject local date/time and timezone in session-start hook
- **daemon**: expose MCP server for native tool access from harnesses
- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **adapter**: add clawdbot compatibility to openclaw adapter
- **connector-openclaw**: claim memory slot and disable native memorySearch
- **openclaw**: rewrite adapter to OpenClaw register(api) plugin pattern
- **skills**: move onboarding skill to signetai/templates/skills
- **ci**: bump version to 0.1.116 to fix npm publish collision
- **dashboard**: use let for $state binding in FormSection
- **adapter-openclaw**: add openclaw.plugin.json manifest and use unscoped plugin id
- **adapter-openclaw**: rename package scope from @signet to @signetai for npm publish
- **dashboard**: move submit button back inside form element
- **adapter-openclaw**: use DOM lib instead of node types for CI compat
- **connector-openclaw**: use object format for plugins config
- **dashboard**: clean up bloated pipeline settings UI
- **cli**: remove duplicate embed command registration
- **cli**: rename duplicate embedCmd variable to fix build
- **core**: pass Float32Array instead of Buffer to vec0 MATCH query
- **connector-base**: add @types/node for node:fs and node:path imports
- include SOUL.md, IDENTITY.md, USER.md in all harness config generation
- **connector-claude-code**: register MCP server in ~/.claude.json, not settings.json
- **core**: use npm root -g to find sqlite-vec when running under bun
- **core**: search well-known npm global paths for sqlite-vec extension
- **signetai**: add signet-mcp bin entry and build step to meta-package
- **cli**: drop stale vec_embeddings before recreating with correct dimensions
- **embeddings**: read actual dimensions instead of hardcoding vec0 table size
- **cli**: load sqlite-vec extension before CREATE VIRTUAL TABLE in migrate-vectors
- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **ingest**: decouple extractors from Ollama, deduplicate shared utilities
- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- add memory loop pipeline diagrams
- teach agents they can't see their own infrastructure
- update AGENTS.md
- **skill.md**: move /onboarding details to skill, keep as suggestion in install
- **skill.md**: add /onboarding as Step 6 in installation flow
- **skill.md**: add full /onboarding section to install guide
- add contribution strategy
- require shadcn-svelte components for dashboard UI work
- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.127] - 2026-02-25

### Features

- **core**: add document ingestion pipeline
- **skills**: add ClawHub provider and marketplace card grid UI
- **daemon**: add unified embedding health check endpoint and dashboard UI
- **daemon**: add memory content size guardrails
- **web**: add curl install script for signetai.sh/install
- **skills**: add /onboarding skill for interactive agent setup
- add scheduled agent tasks with cron-based execution
- **adapter-openclaw**: prepare package for npm publish
- memory system roadmap — 8 features + docs
- **daemon**: inject local date/time and timezone in session-start hook
- **daemon**: expose MCP server for native tool access from harnesses
- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **adapter**: add clawdbot compatibility to openclaw adapter
- **connector-openclaw**: claim memory slot and disable native memorySearch
- **openclaw**: rewrite adapter to OpenClaw register(api) plugin pattern
- **skills**: move onboarding skill to signetai/templates/skills
- **ci**: bump version to 0.1.116 to fix npm publish collision
- **dashboard**: use let for $state binding in FormSection
- **adapter-openclaw**: add openclaw.plugin.json manifest and use unscoped plugin id
- **adapter-openclaw**: rename package scope from @signet to @signetai for npm publish
- **dashboard**: move submit button back inside form element
- **adapter-openclaw**: use DOM lib instead of node types for CI compat
- **connector-openclaw**: use object format for plugins config
- **dashboard**: clean up bloated pipeline settings UI
- **cli**: remove duplicate embed command registration
- **cli**: rename duplicate embedCmd variable to fix build
- **core**: pass Float32Array instead of Buffer to vec0 MATCH query
- **connector-base**: add @types/node for node:fs and node:path imports
- include SOUL.md, IDENTITY.md, USER.md in all harness config generation
- **connector-claude-code**: register MCP server in ~/.claude.json, not settings.json
- **core**: use npm root -g to find sqlite-vec when running under bun
- **core**: search well-known npm global paths for sqlite-vec extension
- **signetai**: add signet-mcp bin entry and build step to meta-package
- **cli**: drop stale vec_embeddings before recreating with correct dimensions
- **embeddings**: read actual dimensions instead of hardcoding vec0 table size
- **cli**: load sqlite-vec extension before CREATE VIRTUAL TABLE in migrate-vectors
- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **ingest**: decouple extractors from Ollama, deduplicate shared utilities
- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- teach agents they can't see their own infrastructure
- update AGENTS.md
- **skill.md**: move /onboarding details to skill, keep as suggestion in install
- **skill.md**: add /onboarding as Step 6 in installation flow
- **skill.md**: add full /onboarding section to install guide
- add contribution strategy
- require shadcn-svelte components for dashboard UI work
- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.126] - 2026-02-24

### Features

- **core**: add document ingestion pipeline
- **skills**: add ClawHub provider and marketplace card grid UI
- **daemon**: add unified embedding health check endpoint and dashboard UI
- **daemon**: add memory content size guardrails
- **web**: add curl install script for signetai.sh/install
- **skills**: add /onboarding skill for interactive agent setup
- add scheduled agent tasks with cron-based execution
- **adapter-openclaw**: prepare package for npm publish
- memory system roadmap — 8 features + docs
- **daemon**: inject local date/time and timezone in session-start hook
- **daemon**: expose MCP server for native tool access from harnesses
- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **connector-openclaw**: claim memory slot and disable native memorySearch
- **openclaw**: rewrite adapter to OpenClaw register(api) plugin pattern
- **skills**: move onboarding skill to signetai/templates/skills
- **ci**: bump version to 0.1.116 to fix npm publish collision
- **dashboard**: use let for $state binding in FormSection
- **adapter-openclaw**: add openclaw.plugin.json manifest and use unscoped plugin id
- **adapter-openclaw**: rename package scope from @signet to @signetai for npm publish
- **dashboard**: move submit button back inside form element
- **adapter-openclaw**: use DOM lib instead of node types for CI compat
- **connector-openclaw**: use object format for plugins config
- **dashboard**: clean up bloated pipeline settings UI
- **cli**: remove duplicate embed command registration
- **cli**: rename duplicate embedCmd variable to fix build
- **core**: pass Float32Array instead of Buffer to vec0 MATCH query
- **connector-base**: add @types/node for node:fs and node:path imports
- include SOUL.md, IDENTITY.md, USER.md in all harness config generation
- **connector-claude-code**: register MCP server in ~/.claude.json, not settings.json
- **core**: use npm root -g to find sqlite-vec when running under bun
- **core**: search well-known npm global paths for sqlite-vec extension
- **signetai**: add signet-mcp bin entry and build step to meta-package
- **cli**: drop stale vec_embeddings before recreating with correct dimensions
- **embeddings**: read actual dimensions instead of hardcoding vec0 table size
- **cli**: load sqlite-vec extension before CREATE VIRTUAL TABLE in migrate-vectors
- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **ingest**: decouple extractors from Ollama, deduplicate shared utilities
- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- teach agents they can't see their own infrastructure
- update AGENTS.md
- **skill.md**: move /onboarding details to skill, keep as suggestion in install
- **skill.md**: add /onboarding as Step 6 in installation flow
- **skill.md**: add full /onboarding section to install guide
- add contribution strategy
- require shadcn-svelte components for dashboard UI work
- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.125] - 2026-02-24

### Features

- **skills**: add ClawHub provider and marketplace card grid UI
- **daemon**: add unified embedding health check endpoint and dashboard UI
- **daemon**: add memory content size guardrails
- **web**: add curl install script for signetai.sh/install
- **skills**: add /onboarding skill for interactive agent setup
- add scheduled agent tasks with cron-based execution
- **adapter-openclaw**: prepare package for npm publish
- memory system roadmap — 8 features + docs
- **daemon**: inject local date/time and timezone in session-start hook
- **daemon**: expose MCP server for native tool access from harnesses
- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **connector-openclaw**: claim memory slot and disable native memorySearch
- **openclaw**: rewrite adapter to OpenClaw register(api) plugin pattern
- **skills**: move onboarding skill to signetai/templates/skills
- **ci**: bump version to 0.1.116 to fix npm publish collision
- **dashboard**: use let for $state binding in FormSection
- **adapter-openclaw**: add openclaw.plugin.json manifest and use unscoped plugin id
- **adapter-openclaw**: rename package scope from @signet to @signetai for npm publish
- **dashboard**: move submit button back inside form element
- **adapter-openclaw**: use DOM lib instead of node types for CI compat
- **connector-openclaw**: use object format for plugins config
- **dashboard**: clean up bloated pipeline settings UI
- **cli**: remove duplicate embed command registration
- **cli**: rename duplicate embedCmd variable to fix build
- **core**: pass Float32Array instead of Buffer to vec0 MATCH query
- **connector-base**: add @types/node for node:fs and node:path imports
- include SOUL.md, IDENTITY.md, USER.md in all harness config generation
- **connector-claude-code**: register MCP server in ~/.claude.json, not settings.json
- **core**: use npm root -g to find sqlite-vec when running under bun
- **core**: search well-known npm global paths for sqlite-vec extension
- **signetai**: add signet-mcp bin entry and build step to meta-package
- **cli**: drop stale vec_embeddings before recreating with correct dimensions
- **embeddings**: read actual dimensions instead of hardcoding vec0 table size
- **cli**: load sqlite-vec extension before CREATE VIRTUAL TABLE in migrate-vectors
- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- teach agents they can't see their own infrastructure
- update AGENTS.md
- **skill.md**: move /onboarding details to skill, keep as suggestion in install
- **skill.md**: add /onboarding as Step 6 in installation flow
- **skill.md**: add full /onboarding section to install guide
- add contribution strategy
- require shadcn-svelte components for dashboard UI work
- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.124] - 2026-02-24

### Features

- **skills**: add ClawHub provider and marketplace card grid UI
- **daemon**: add unified embedding health check endpoint and dashboard UI
- **daemon**: add memory content size guardrails
- **web**: add curl install script for signetai.sh/install
- **skills**: add /onboarding skill for interactive agent setup
- add scheduled agent tasks with cron-based execution
- **adapter-openclaw**: prepare package for npm publish
- memory system roadmap — 8 features + docs
- **daemon**: inject local date/time and timezone in session-start hook
- **daemon**: expose MCP server for native tool access from harnesses
- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **connector-openclaw**: claim memory slot and disable native memorySearch
- **openclaw**: rewrite adapter to OpenClaw register(api) plugin pattern
- **skills**: move onboarding skill to signetai/templates/skills
- **ci**: bump version to 0.1.116 to fix npm publish collision
- **dashboard**: use let for $state binding in FormSection
- **adapter-openclaw**: add openclaw.plugin.json manifest and use unscoped plugin id
- **adapter-openclaw**: rename package scope from @signet to @signetai for npm publish
- **dashboard**: move submit button back inside form element
- **adapter-openclaw**: use DOM lib instead of node types for CI compat
- **connector-openclaw**: use object format for plugins config
- **dashboard**: clean up bloated pipeline settings UI
- **cli**: remove duplicate embed command registration
- **cli**: rename duplicate embedCmd variable to fix build
- **core**: pass Float32Array instead of Buffer to vec0 MATCH query
- **connector-base**: add @types/node for node:fs and node:path imports
- include SOUL.md, IDENTITY.md, USER.md in all harness config generation
- **connector-claude-code**: register MCP server in ~/.claude.json, not settings.json
- **core**: use npm root -g to find sqlite-vec when running under bun
- **core**: search well-known npm global paths for sqlite-vec extension
- **signetai**: add signet-mcp bin entry and build step to meta-package
- **cli**: drop stale vec_embeddings before recreating with correct dimensions
- **embeddings**: read actual dimensions instead of hardcoding vec0 table size
- **cli**: load sqlite-vec extension before CREATE VIRTUAL TABLE in migrate-vectors
- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- teach agents they can't see their own infrastructure
- update AGENTS.md
- **skill.md**: move /onboarding details to skill, keep as suggestion in install
- **skill.md**: add /onboarding as Step 6 in installation flow
- **skill.md**: add full /onboarding section to install guide
- add contribution strategy
- require shadcn-svelte components for dashboard UI work
- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.123] - 2026-02-24

### Features

- **daemon**: add unified embedding health check endpoint and dashboard UI
- **daemon**: add memory content size guardrails
- **web**: add curl install script for signetai.sh/install
- **skills**: add /onboarding skill for interactive agent setup
- add scheduled agent tasks with cron-based execution
- **adapter-openclaw**: prepare package for npm publish
- memory system roadmap — 8 features + docs
- **daemon**: inject local date/time and timezone in session-start hook
- **daemon**: expose MCP server for native tool access from harnesses
- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **connector-openclaw**: claim memory slot and disable native memorySearch
- **openclaw**: rewrite adapter to OpenClaw register(api) plugin pattern
- **skills**: move onboarding skill to signetai/templates/skills
- **ci**: bump version to 0.1.116 to fix npm publish collision
- **dashboard**: use let for $state binding in FormSection
- **adapter-openclaw**: add openclaw.plugin.json manifest and use unscoped plugin id
- **adapter-openclaw**: rename package scope from @signet to @signetai for npm publish
- **dashboard**: move submit button back inside form element
- **adapter-openclaw**: use DOM lib instead of node types for CI compat
- **connector-openclaw**: use object format for plugins config
- **dashboard**: clean up bloated pipeline settings UI
- **cli**: remove duplicate embed command registration
- **cli**: rename duplicate embedCmd variable to fix build
- **core**: pass Float32Array instead of Buffer to vec0 MATCH query
- **connector-base**: add @types/node for node:fs and node:path imports
- include SOUL.md, IDENTITY.md, USER.md in all harness config generation
- **connector-claude-code**: register MCP server in ~/.claude.json, not settings.json
- **core**: use npm root -g to find sqlite-vec when running under bun
- **core**: search well-known npm global paths for sqlite-vec extension
- **signetai**: add signet-mcp bin entry and build step to meta-package
- **cli**: drop stale vec_embeddings before recreating with correct dimensions
- **embeddings**: read actual dimensions instead of hardcoding vec0 table size
- **cli**: load sqlite-vec extension before CREATE VIRTUAL TABLE in migrate-vectors
- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- teach agents they can't see their own infrastructure
- update AGENTS.md
- **skill.md**: move /onboarding details to skill, keep as suggestion in install
- **skill.md**: add /onboarding as Step 6 in installation flow
- **skill.md**: add full /onboarding section to install guide
- add contribution strategy
- require shadcn-svelte components for dashboard UI work
- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.122] - 2026-02-24

### Features

- **daemon**: add memory content size guardrails
- **web**: add curl install script for signetai.sh/install
- **skills**: add /onboarding skill for interactive agent setup
- add scheduled agent tasks with cron-based execution
- **adapter-openclaw**: prepare package for npm publish
- memory system roadmap — 8 features + docs
- **daemon**: inject local date/time and timezone in session-start hook
- **daemon**: expose MCP server for native tool access from harnesses
- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **connector-openclaw**: claim memory slot and disable native memorySearch
- **openclaw**: rewrite adapter to OpenClaw register(api) plugin pattern
- **skills**: move onboarding skill to signetai/templates/skills
- **ci**: bump version to 0.1.116 to fix npm publish collision
- **dashboard**: use let for $state binding in FormSection
- **adapter-openclaw**: add openclaw.plugin.json manifest and use unscoped plugin id
- **adapter-openclaw**: rename package scope from @signet to @signetai for npm publish
- **dashboard**: move submit button back inside form element
- **adapter-openclaw**: use DOM lib instead of node types for CI compat
- **connector-openclaw**: use object format for plugins config
- **dashboard**: clean up bloated pipeline settings UI
- **cli**: remove duplicate embed command registration
- **cli**: rename duplicate embedCmd variable to fix build
- **core**: pass Float32Array instead of Buffer to vec0 MATCH query
- **connector-base**: add @types/node for node:fs and node:path imports
- include SOUL.md, IDENTITY.md, USER.md in all harness config generation
- **connector-claude-code**: register MCP server in ~/.claude.json, not settings.json
- **core**: use npm root -g to find sqlite-vec when running under bun
- **core**: search well-known npm global paths for sqlite-vec extension
- **signetai**: add signet-mcp bin entry and build step to meta-package
- **cli**: drop stale vec_embeddings before recreating with correct dimensions
- **embeddings**: read actual dimensions instead of hardcoding vec0 table size
- **cli**: load sqlite-vec extension before CREATE VIRTUAL TABLE in migrate-vectors
- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- teach agents they can't see their own infrastructure
- update AGENTS.md
- **skill.md**: move /onboarding details to skill, keep as suggestion in install
- **skill.md**: add /onboarding as Step 6 in installation flow
- **skill.md**: add full /onboarding section to install guide
- add contribution strategy
- require shadcn-svelte components for dashboard UI work
- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.121] - 2026-02-24

### Features

- **web**: add curl install script for signetai.sh/install
- **skills**: add /onboarding skill for interactive agent setup
- add scheduled agent tasks with cron-based execution
- **adapter-openclaw**: prepare package for npm publish
- memory system roadmap — 8 features + docs
- **daemon**: inject local date/time and timezone in session-start hook
- **daemon**: expose MCP server for native tool access from harnesses
- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **openclaw**: rewrite adapter to OpenClaw register(api) plugin pattern
- **skills**: move onboarding skill to signetai/templates/skills
- **ci**: bump version to 0.1.116 to fix npm publish collision
- **dashboard**: use let for $state binding in FormSection
- **adapter-openclaw**: add openclaw.plugin.json manifest and use unscoped plugin id
- **adapter-openclaw**: rename package scope from @signet to @signetai for npm publish
- **dashboard**: move submit button back inside form element
- **adapter-openclaw**: use DOM lib instead of node types for CI compat
- **connector-openclaw**: use object format for plugins config
- **dashboard**: clean up bloated pipeline settings UI
- **cli**: remove duplicate embed command registration
- **cli**: rename duplicate embedCmd variable to fix build
- **core**: pass Float32Array instead of Buffer to vec0 MATCH query
- **connector-base**: add @types/node for node:fs and node:path imports
- include SOUL.md, IDENTITY.md, USER.md in all harness config generation
- **connector-claude-code**: register MCP server in ~/.claude.json, not settings.json
- **core**: use npm root -g to find sqlite-vec when running under bun
- **core**: search well-known npm global paths for sqlite-vec extension
- **signetai**: add signet-mcp bin entry and build step to meta-package
- **cli**: drop stale vec_embeddings before recreating with correct dimensions
- **embeddings**: read actual dimensions instead of hardcoding vec0 table size
- **cli**: load sqlite-vec extension before CREATE VIRTUAL TABLE in migrate-vectors
- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- teach agents they can't see their own infrastructure
- update AGENTS.md
- **skill.md**: move /onboarding details to skill, keep as suggestion in install
- **skill.md**: add /onboarding as Step 6 in installation flow
- **skill.md**: add full /onboarding section to install guide
- add contribution strategy
- require shadcn-svelte components for dashboard UI work
- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.120] - 2026-02-24

### Features

- **web**: add curl install script for signetai.sh/install
- **skills**: add /onboarding skill for interactive agent setup
- add scheduled agent tasks with cron-based execution
- **adapter-openclaw**: prepare package for npm publish
- memory system roadmap — 8 features + docs
- **daemon**: inject local date/time and timezone in session-start hook
- **daemon**: expose MCP server for native tool access from harnesses
- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **openclaw**: rewrite adapter to OpenClaw register(api) plugin pattern
- **skills**: move onboarding skill to signetai/templates/skills
- **ci**: bump version to 0.1.116 to fix npm publish collision
- **dashboard**: use let for $state binding in FormSection
- **adapter-openclaw**: add openclaw.plugin.json manifest and use unscoped plugin id
- **adapter-openclaw**: rename package scope from @signet to @signetai for npm publish
- **dashboard**: move submit button back inside form element
- **adapter-openclaw**: use DOM lib instead of node types for CI compat
- **connector-openclaw**: use object format for plugins config
- **dashboard**: clean up bloated pipeline settings UI
- **cli**: remove duplicate embed command registration
- **cli**: rename duplicate embedCmd variable to fix build
- **core**: pass Float32Array instead of Buffer to vec0 MATCH query
- **connector-base**: add @types/node for node:fs and node:path imports
- include SOUL.md, IDENTITY.md, USER.md in all harness config generation
- **connector-claude-code**: register MCP server in ~/.claude.json, not settings.json
- **core**: use npm root -g to find sqlite-vec when running under bun
- **core**: search well-known npm global paths for sqlite-vec extension
- **signetai**: add signet-mcp bin entry and build step to meta-package
- **cli**: drop stale vec_embeddings before recreating with correct dimensions
- **embeddings**: read actual dimensions instead of hardcoding vec0 table size
- **cli**: load sqlite-vec extension before CREATE VIRTUAL TABLE in migrate-vectors
- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- update AGENTS.md
- **skill.md**: move /onboarding details to skill, keep as suggestion in install
- **skill.md**: add /onboarding as Step 6 in installation flow
- **skill.md**: add full /onboarding section to install guide
- add contribution strategy
- require shadcn-svelte components for dashboard UI work
- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.119] - 2026-02-24

### Features

- **web**: add curl install script for signetai.sh/install
- **skills**: add /onboarding skill for interactive agent setup
- add scheduled agent tasks with cron-based execution
- **adapter-openclaw**: prepare package for npm publish
- memory system roadmap — 8 features + docs
- **daemon**: inject local date/time and timezone in session-start hook
- **daemon**: expose MCP server for native tool access from harnesses
- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **openclaw**: rewrite adapter to OpenClaw register(api) plugin pattern
- **skills**: move onboarding skill to signetai/templates/skills
- **ci**: bump version to 0.1.116 to fix npm publish collision
- **dashboard**: use let for $state binding in FormSection
- **adapter-openclaw**: add openclaw.plugin.json manifest and use unscoped plugin id
- **adapter-openclaw**: rename package scope from @signet to @signetai for npm publish
- **dashboard**: move submit button back inside form element
- **adapter-openclaw**: use DOM lib instead of node types for CI compat
- **connector-openclaw**: use object format for plugins config
- **dashboard**: clean up bloated pipeline settings UI
- **cli**: remove duplicate embed command registration
- **cli**: rename duplicate embedCmd variable to fix build
- **core**: pass Float32Array instead of Buffer to vec0 MATCH query
- **connector-base**: add @types/node for node:fs and node:path imports
- include SOUL.md, IDENTITY.md, USER.md in all harness config generation
- **connector-claude-code**: register MCP server in ~/.claude.json, not settings.json
- **core**: use npm root -g to find sqlite-vec when running under bun
- **core**: search well-known npm global paths for sqlite-vec extension
- **signetai**: add signet-mcp bin entry and build step to meta-package
- **cli**: drop stale vec_embeddings before recreating with correct dimensions
- **embeddings**: read actual dimensions instead of hardcoding vec0 table size
- **cli**: load sqlite-vec extension before CREATE VIRTUAL TABLE in migrate-vectors
- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- **skill.md**: move /onboarding details to skill, keep as suggestion in install
- **skill.md**: add /onboarding as Step 6 in installation flow
- **skill.md**: add full /onboarding section to install guide
- add contribution strategy
- require shadcn-svelte components for dashboard UI work
- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.118] - 2026-02-24

### Features

- **web**: add curl install script for signetai.sh/install
- **skills**: add /onboarding skill for interactive agent setup
- add scheduled agent tasks with cron-based execution
- **adapter-openclaw**: prepare package for npm publish
- memory system roadmap — 8 features + docs
- **daemon**: inject local date/time and timezone in session-start hook
- **daemon**: expose MCP server for native tool access from harnesses
- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **skills**: move onboarding skill to signetai/templates/skills
- **ci**: bump version to 0.1.116 to fix npm publish collision
- **dashboard**: use let for $state binding in FormSection
- **adapter-openclaw**: add openclaw.plugin.json manifest and use unscoped plugin id
- **adapter-openclaw**: rename package scope from @signet to @signetai for npm publish
- **dashboard**: move submit button back inside form element
- **adapter-openclaw**: use DOM lib instead of node types for CI compat
- **connector-openclaw**: use object format for plugins config
- **dashboard**: clean up bloated pipeline settings UI
- **cli**: remove duplicate embed command registration
- **cli**: rename duplicate embedCmd variable to fix build
- **core**: pass Float32Array instead of Buffer to vec0 MATCH query
- **connector-base**: add @types/node for node:fs and node:path imports
- include SOUL.md, IDENTITY.md, USER.md in all harness config generation
- **connector-claude-code**: register MCP server in ~/.claude.json, not settings.json
- **core**: use npm root -g to find sqlite-vec when running under bun
- **core**: search well-known npm global paths for sqlite-vec extension
- **signetai**: add signet-mcp bin entry and build step to meta-package
- **cli**: drop stale vec_embeddings before recreating with correct dimensions
- **embeddings**: read actual dimensions instead of hardcoding vec0 table size
- **cli**: load sqlite-vec extension before CREATE VIRTUAL TABLE in migrate-vectors
- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- **skill.md**: move /onboarding details to skill, keep as suggestion in install
- **skill.md**: add /onboarding as Step 6 in installation flow
- **skill.md**: add full /onboarding section to install guide
- add contribution strategy
- require shadcn-svelte components for dashboard UI work
- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.117] - 2026-02-24

### Features

- **web**: add curl install script for signetai.sh/install
- **skills**: add /onboarding skill for interactive agent setup
- add scheduled agent tasks with cron-based execution
- **adapter-openclaw**: prepare package for npm publish
- memory system roadmap — 8 features + docs
- **daemon**: inject local date/time and timezone in session-start hook
- **daemon**: expose MCP server for native tool access from harnesses
- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **ci**: bump version to 0.1.116 to fix npm publish collision
- **dashboard**: use let for $state binding in FormSection
- **adapter-openclaw**: add openclaw.plugin.json manifest and use unscoped plugin id
- **adapter-openclaw**: rename package scope from @signet to @signetai for npm publish
- **dashboard**: move submit button back inside form element
- **adapter-openclaw**: use DOM lib instead of node types for CI compat
- **connector-openclaw**: use object format for plugins config
- **dashboard**: clean up bloated pipeline settings UI
- **cli**: remove duplicate embed command registration
- **cli**: rename duplicate embedCmd variable to fix build
- **core**: pass Float32Array instead of Buffer to vec0 MATCH query
- **connector-base**: add @types/node for node:fs and node:path imports
- include SOUL.md, IDENTITY.md, USER.md in all harness config generation
- **connector-claude-code**: register MCP server in ~/.claude.json, not settings.json
- **core**: use npm root -g to find sqlite-vec when running under bun
- **core**: search well-known npm global paths for sqlite-vec extension
- **signetai**: add signet-mcp bin entry and build step to meta-package
- **cli**: drop stale vec_embeddings before recreating with correct dimensions
- **embeddings**: read actual dimensions instead of hardcoding vec0 table size
- **cli**: load sqlite-vec extension before CREATE VIRTUAL TABLE in migrate-vectors
- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- **skill.md**: move /onboarding details to skill, keep as suggestion in install
- **skill.md**: add /onboarding as Step 6 in installation flow
- **skill.md**: add full /onboarding section to install guide
- add contribution strategy
- require shadcn-svelte components for dashboard UI work
- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.114] - 2026-02-23

### Features

- add scheduled agent tasks with cron-based execution
- **adapter-openclaw**: prepare package for npm publish
- memory system roadmap — 8 features + docs
- **daemon**: inject local date/time and timezone in session-start hook
- **daemon**: expose MCP server for native tool access from harnesses
- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **dashboard**: use let for $state binding in FormSection
- **adapter-openclaw**: add openclaw.plugin.json manifest and use unscoped plugin id
- **adapter-openclaw**: rename package scope from @signet to @signetai for npm publish
- **dashboard**: move submit button back inside form element
- **adapter-openclaw**: use DOM lib instead of node types for CI compat
- **connector-openclaw**: use object format for plugins config
- **dashboard**: clean up bloated pipeline settings UI
- **cli**: remove duplicate embed command registration
- **cli**: rename duplicate embedCmd variable to fix build
- **core**: pass Float32Array instead of Buffer to vec0 MATCH query
- **connector-base**: add @types/node for node:fs and node:path imports
- include SOUL.md, IDENTITY.md, USER.md in all harness config generation
- **connector-claude-code**: register MCP server in ~/.claude.json, not settings.json
- **core**: use npm root -g to find sqlite-vec when running under bun
- **core**: search well-known npm global paths for sqlite-vec extension
- **signetai**: add signet-mcp bin entry and build step to meta-package
- **cli**: drop stale vec_embeddings before recreating with correct dimensions
- **embeddings**: read actual dimensions instead of hardcoding vec0 table size
- **cli**: load sqlite-vec extension before CREATE VIRTUAL TABLE in migrate-vectors
- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- add contribution strategy
- require shadcn-svelte components for dashboard UI work
- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.113] - 2026-02-23

### Features

- add scheduled agent tasks with cron-based execution
- **adapter-openclaw**: prepare package for npm publish
- memory system roadmap — 8 features + docs
- **daemon**: inject local date/time and timezone in session-start hook
- **daemon**: expose MCP server for native tool access from harnesses
- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **dashboard**: use let for $state binding in FormSection
- **adapter-openclaw**: add openclaw.plugin.json manifest and use unscoped plugin id
- **adapter-openclaw**: rename package scope from @signet to @signetai for npm publish
- **dashboard**: move submit button back inside form element
- **adapter-openclaw**: use DOM lib instead of node types for CI compat
- **connector-openclaw**: use object format for plugins config
- **dashboard**: clean up bloated pipeline settings UI
- **cli**: remove duplicate embed command registration
- **cli**: rename duplicate embedCmd variable to fix build
- **core**: pass Float32Array instead of Buffer to vec0 MATCH query
- **connector-base**: add @types/node for node:fs and node:path imports
- include SOUL.md, IDENTITY.md, USER.md in all harness config generation
- **connector-claude-code**: register MCP server in ~/.claude.json, not settings.json
- **core**: use npm root -g to find sqlite-vec when running under bun
- **core**: search well-known npm global paths for sqlite-vec extension
- **signetai**: add signet-mcp bin entry and build step to meta-package
- **cli**: drop stale vec_embeddings before recreating with correct dimensions
- **embeddings**: read actual dimensions instead of hardcoding vec0 table size
- **cli**: load sqlite-vec extension before CREATE VIRTUAL TABLE in migrate-vectors
- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- require shadcn-svelte components for dashboard UI work
- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.112] - 2026-02-23

### Features

- add scheduled agent tasks with cron-based execution
- **adapter-openclaw**: prepare package for npm publish
- memory system roadmap — 8 features + docs
- **daemon**: inject local date/time and timezone in session-start hook
- **daemon**: expose MCP server for native tool access from harnesses
- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **adapter-openclaw**: add openclaw.plugin.json manifest and use unscoped plugin id
- **adapter-openclaw**: rename package scope from @signet to @signetai for npm publish
- **dashboard**: move submit button back inside form element
- **adapter-openclaw**: use DOM lib instead of node types for CI compat
- **connector-openclaw**: use object format for plugins config
- **dashboard**: clean up bloated pipeline settings UI
- **cli**: remove duplicate embed command registration
- **cli**: rename duplicate embedCmd variable to fix build
- **core**: pass Float32Array instead of Buffer to vec0 MATCH query
- **connector-base**: add @types/node for node:fs and node:path imports
- include SOUL.md, IDENTITY.md, USER.md in all harness config generation
- **connector-claude-code**: register MCP server in ~/.claude.json, not settings.json
- **core**: use npm root -g to find sqlite-vec when running under bun
- **core**: search well-known npm global paths for sqlite-vec extension
- **signetai**: add signet-mcp bin entry and build step to meta-package
- **cli**: drop stale vec_embeddings before recreating with correct dimensions
- **embeddings**: read actual dimensions instead of hardcoding vec0 table size
- **cli**: load sqlite-vec extension before CREATE VIRTUAL TABLE in migrate-vectors
- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- require shadcn-svelte components for dashboard UI work
- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.111] - 2026-02-23

### Features

- add scheduled agent tasks with cron-based execution
- **adapter-openclaw**: prepare package for npm publish
- memory system roadmap — 8 features + docs
- **daemon**: inject local date/time and timezone in session-start hook
- **daemon**: expose MCP server for native tool access from harnesses
- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **adapter-openclaw**: rename package scope from @signet to @signetai for npm publish
- **dashboard**: move submit button back inside form element
- **adapter-openclaw**: use DOM lib instead of node types for CI compat
- **connector-openclaw**: use object format for plugins config
- **dashboard**: clean up bloated pipeline settings UI
- **cli**: remove duplicate embed command registration
- **cli**: rename duplicate embedCmd variable to fix build
- **core**: pass Float32Array instead of Buffer to vec0 MATCH query
- **connector-base**: add @types/node for node:fs and node:path imports
- include SOUL.md, IDENTITY.md, USER.md in all harness config generation
- **connector-claude-code**: register MCP server in ~/.claude.json, not settings.json
- **core**: use npm root -g to find sqlite-vec when running under bun
- **core**: search well-known npm global paths for sqlite-vec extension
- **signetai**: add signet-mcp bin entry and build step to meta-package
- **cli**: drop stale vec_embeddings before recreating with correct dimensions
- **embeddings**: read actual dimensions instead of hardcoding vec0 table size
- **cli**: load sqlite-vec extension before CREATE VIRTUAL TABLE in migrate-vectors
- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- require shadcn-svelte components for dashboard UI work
- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.110] - 2026-02-23

### Features

- **adapter-openclaw**: prepare package for npm publish
- memory system roadmap — 8 features + docs
- **daemon**: inject local date/time and timezone in session-start hook
- **daemon**: expose MCP server for native tool access from harnesses
- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **adapter-openclaw**: use DOM lib instead of node types for CI compat
- **connector-openclaw**: use object format for plugins config
- **dashboard**: clean up bloated pipeline settings UI
- **cli**: remove duplicate embed command registration
- **cli**: rename duplicate embedCmd variable to fix build
- **core**: pass Float32Array instead of Buffer to vec0 MATCH query
- **connector-base**: add @types/node for node:fs and node:path imports
- include SOUL.md, IDENTITY.md, USER.md in all harness config generation
- **connector-claude-code**: register MCP server in ~/.claude.json, not settings.json
- **core**: use npm root -g to find sqlite-vec when running under bun
- **core**: search well-known npm global paths for sqlite-vec extension
- **signetai**: add signet-mcp bin entry and build step to meta-package
- **cli**: drop stale vec_embeddings before recreating with correct dimensions
- **embeddings**: read actual dimensions instead of hardcoding vec0 table size
- **cli**: load sqlite-vec extension before CREATE VIRTUAL TABLE in migrate-vectors
- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- require shadcn-svelte components for dashboard UI work
- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.109] - 2026-02-23

### Features

- memory system roadmap — 8 features + docs
- **daemon**: inject local date/time and timezone in session-start hook
- **daemon**: expose MCP server for native tool access from harnesses
- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **connector-openclaw**: use object format for plugins config
- **dashboard**: clean up bloated pipeline settings UI
- **cli**: remove duplicate embed command registration
- **cli**: rename duplicate embedCmd variable to fix build
- **core**: pass Float32Array instead of Buffer to vec0 MATCH query
- **connector-base**: add @types/node for node:fs and node:path imports
- include SOUL.md, IDENTITY.md, USER.md in all harness config generation
- **connector-claude-code**: register MCP server in ~/.claude.json, not settings.json
- **core**: use npm root -g to find sqlite-vec when running under bun
- **core**: search well-known npm global paths for sqlite-vec extension
- **signetai**: add signet-mcp bin entry and build step to meta-package
- **cli**: drop stale vec_embeddings before recreating with correct dimensions
- **embeddings**: read actual dimensions instead of hardcoding vec0 table size
- **cli**: load sqlite-vec extension before CREATE VIRTUAL TABLE in migrate-vectors
- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- require shadcn-svelte components for dashboard UI work
- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.108] - 2026-02-23

### Features

- memory system roadmap — 8 features + docs
- **daemon**: inject local date/time and timezone in session-start hook
- **daemon**: expose MCP server for native tool access from harnesses
- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **dashboard**: clean up bloated pipeline settings UI
- **cli**: remove duplicate embed command registration
- **cli**: rename duplicate embedCmd variable to fix build
- **core**: pass Float32Array instead of Buffer to vec0 MATCH query
- **connector-base**: add @types/node for node:fs and node:path imports
- include SOUL.md, IDENTITY.md, USER.md in all harness config generation
- **connector-claude-code**: register MCP server in ~/.claude.json, not settings.json
- **core**: use npm root -g to find sqlite-vec when running under bun
- **core**: search well-known npm global paths for sqlite-vec extension
- **signetai**: add signet-mcp bin entry and build step to meta-package
- **cli**: drop stale vec_embeddings before recreating with correct dimensions
- **embeddings**: read actual dimensions instead of hardcoding vec0 table size
- **cli**: load sqlite-vec extension before CREATE VIRTUAL TABLE in migrate-vectors
- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- require shadcn-svelte components for dashboard UI work
- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.107] - 2026-02-23

### Features

- memory system roadmap — 8 features + docs
- **daemon**: inject local date/time and timezone in session-start hook
- **daemon**: expose MCP server for native tool access from harnesses
- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **cli**: remove duplicate embed command registration
- **cli**: rename duplicate embedCmd variable to fix build
- **core**: pass Float32Array instead of Buffer to vec0 MATCH query
- **connector-base**: add @types/node for node:fs and node:path imports
- include SOUL.md, IDENTITY.md, USER.md in all harness config generation
- **connector-claude-code**: register MCP server in ~/.claude.json, not settings.json
- **core**: use npm root -g to find sqlite-vec when running under bun
- **core**: search well-known npm global paths for sqlite-vec extension
- **signetai**: add signet-mcp bin entry and build step to meta-package
- **cli**: drop stale vec_embeddings before recreating with correct dimensions
- **embeddings**: read actual dimensions instead of hardcoding vec0 table size
- **cli**: load sqlite-vec extension before CREATE VIRTUAL TABLE in migrate-vectors
- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- require shadcn-svelte components for dashboard UI work
- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.106] - 2026-02-23

### Features

- memory system roadmap — 8 features + docs
- **daemon**: inject local date/time and timezone in session-start hook
- **daemon**: expose MCP server for native tool access from harnesses
- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **cli**: rename duplicate embedCmd variable to fix build
- **core**: pass Float32Array instead of Buffer to vec0 MATCH query
- **connector-base**: add @types/node for node:fs and node:path imports
- include SOUL.md, IDENTITY.md, USER.md in all harness config generation
- **connector-claude-code**: register MCP server in ~/.claude.json, not settings.json
- **core**: use npm root -g to find sqlite-vec when running under bun
- **core**: search well-known npm global paths for sqlite-vec extension
- **signetai**: add signet-mcp bin entry and build step to meta-package
- **cli**: drop stale vec_embeddings before recreating with correct dimensions
- **embeddings**: read actual dimensions instead of hardcoding vec0 table size
- **cli**: load sqlite-vec extension before CREATE VIRTUAL TABLE in migrate-vectors
- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- require shadcn-svelte components for dashboard UI work
- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.105] - 2026-02-23

### Features

- **daemon**: inject local date/time and timezone in session-start hook
- **daemon**: expose MCP server for native tool access from harnesses
- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **core**: pass Float32Array instead of Buffer to vec0 MATCH query
- **connector-base**: add @types/node for node:fs and node:path imports
- include SOUL.md, IDENTITY.md, USER.md in all harness config generation
- **connector-claude-code**: register MCP server in ~/.claude.json, not settings.json
- **core**: use npm root -g to find sqlite-vec when running under bun
- **core**: search well-known npm global paths for sqlite-vec extension
- **signetai**: add signet-mcp bin entry and build step to meta-package
- **cli**: drop stale vec_embeddings before recreating with correct dimensions
- **embeddings**: read actual dimensions instead of hardcoding vec0 table size
- **cli**: load sqlite-vec extension before CREATE VIRTUAL TABLE in migrate-vectors
- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- require shadcn-svelte components for dashboard UI work
- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.104] - 2026-02-23

### Features

- **daemon**: inject local date/time and timezone in session-start hook
- **daemon**: expose MCP server for native tool access from harnesses
- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **connector-base**: add @types/node for node:fs and node:path imports
- include SOUL.md, IDENTITY.md, USER.md in all harness config generation
- **connector-claude-code**: register MCP server in ~/.claude.json, not settings.json
- **core**: use npm root -g to find sqlite-vec when running under bun
- **core**: search well-known npm global paths for sqlite-vec extension
- **signetai**: add signet-mcp bin entry and build step to meta-package
- **cli**: drop stale vec_embeddings before recreating with correct dimensions
- **embeddings**: read actual dimensions instead of hardcoding vec0 table size
- **cli**: load sqlite-vec extension before CREATE VIRTUAL TABLE in migrate-vectors
- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- require shadcn-svelte components for dashboard UI work
- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.103] - 2026-02-23

### Features

- **daemon**: expose MCP server for native tool access from harnesses
- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **connector-base**: add @types/node for node:fs and node:path imports
- include SOUL.md, IDENTITY.md, USER.md in all harness config generation
- **connector-claude-code**: register MCP server in ~/.claude.json, not settings.json
- **core**: use npm root -g to find sqlite-vec when running under bun
- **core**: search well-known npm global paths for sqlite-vec extension
- **signetai**: add signet-mcp bin entry and build step to meta-package
- **cli**: drop stale vec_embeddings before recreating with correct dimensions
- **embeddings**: read actual dimensions instead of hardcoding vec0 table size
- **cli**: load sqlite-vec extension before CREATE VIRTUAL TABLE in migrate-vectors
- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- require shadcn-svelte components for dashboard UI work
- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.102] - 2026-02-23

### Features

- **daemon**: expose MCP server for native tool access from harnesses
- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **connector-claude-code**: register MCP server in ~/.claude.json, not settings.json
- **core**: use npm root -g to find sqlite-vec when running under bun
- **core**: search well-known npm global paths for sqlite-vec extension
- **signetai**: add signet-mcp bin entry and build step to meta-package
- **cli**: drop stale vec_embeddings before recreating with correct dimensions
- **embeddings**: read actual dimensions instead of hardcoding vec0 table size
- **cli**: load sqlite-vec extension before CREATE VIRTUAL TABLE in migrate-vectors
- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- require shadcn-svelte components for dashboard UI work
- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.101] - 2026-02-23

### Features

- **daemon**: expose MCP server for native tool access from harnesses
- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **core**: use npm root -g to find sqlite-vec when running under bun
- **core**: search well-known npm global paths for sqlite-vec extension
- **signetai**: add signet-mcp bin entry and build step to meta-package
- **cli**: drop stale vec_embeddings before recreating with correct dimensions
- **embeddings**: read actual dimensions instead of hardcoding vec0 table size
- **cli**: load sqlite-vec extension before CREATE VIRTUAL TABLE in migrate-vectors
- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- require shadcn-svelte components for dashboard UI work
- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.100] - 2026-02-23

### Features

- **daemon**: expose MCP server for native tool access from harnesses
- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **core**: search well-known npm global paths for sqlite-vec extension
- **signetai**: add signet-mcp bin entry and build step to meta-package
- **cli**: drop stale vec_embeddings before recreating with correct dimensions
- **embeddings**: read actual dimensions instead of hardcoding vec0 table size
- **cli**: load sqlite-vec extension before CREATE VIRTUAL TABLE in migrate-vectors
- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- require shadcn-svelte components for dashboard UI work
- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.99] - 2026-02-23

### Features

- **daemon**: expose MCP server for native tool access from harnesses
- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **signetai**: add signet-mcp bin entry and build step to meta-package
- **cli**: drop stale vec_embeddings before recreating with correct dimensions
- **embeddings**: read actual dimensions instead of hardcoding vec0 table size
- **cli**: load sqlite-vec extension before CREATE VIRTUAL TABLE in migrate-vectors
- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- require shadcn-svelte components for dashboard UI work
- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.98] - 2026-02-23

### Features

- **daemon**: expose MCP server for native tool access from harnesses
- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **cli**: drop stale vec_embeddings before recreating with correct dimensions
- **embeddings**: read actual dimensions instead of hardcoding vec0 table size
- **cli**: load sqlite-vec extension before CREATE VIRTUAL TABLE in migrate-vectors
- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- require shadcn-svelte components for dashboard UI work
- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.97] - 2026-02-23

### Features

- **daemon**: expose MCP server for native tool access from harnesses
- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **embeddings**: read actual dimensions instead of hardcoding vec0 table size
- **cli**: load sqlite-vec extension before CREATE VIRTUAL TABLE in migrate-vectors
- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- require shadcn-svelte components for dashboard UI work
- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.96] - 2026-02-23

### Features

- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **embeddings**: read actual dimensions instead of hardcoding vec0 table size
- **cli**: load sqlite-vec extension before CREATE VIRTUAL TABLE in migrate-vectors
- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- require shadcn-svelte components for dashboard UI work
- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.95] - 2026-02-23

### Features

- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **cli**: load sqlite-vec extension before CREATE VIRTUAL TABLE in migrate-vectors
- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- require shadcn-svelte components for dashboard UI work
- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.94] - 2026-02-23

### Features

- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **cli**: load sqlite-vec extension before CREATE VIRTUAL TABLE in migrate-vectors
- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.93] - 2026-02-23

### Features

- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **pipeline**: restructure PipelineV2Config into nested sub-objects
- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.92] - 2026-02-23

### Features

- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **core**: support sqlite-vec on macOS and other non-Linux platforms
- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.91] - 2026-02-23

### Features

- **pipeline**: wire update + delete mutations in pipeline worker
- **web**: add tabbed agent install prompt to hero and CTA
- **pipeline**: enforce atomic memory extraction via prompt rewriting
- **web**: add agent install skill at /skill.md
- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **recall**: fix signet recall returning no results
- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.90] - 2026-02-23

### Features

- **tray**: macOS menu bar app Phase 1 — rich stats, quick capture, search
- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.89] - 2026-02-23

### Features

- **opencode**: add runtime plugin with full tool surface
- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **dashboard**: fix embeddings effect cycle and perf
- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.88] - 2026-02-23

### Features

- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **dashboard**: fix hover card stuck at origin
- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.87] - 2026-02-23

### Features

- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: eliminate embeddings idle CPU burn
- **dashboard**: move UMAP projection server-side

### Refactoring

- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.86] - 2026-02-23

### Features

- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **dashboard**: stabilize embeddings graph performance
- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: move UMAP projection server-side

### Refactoring

- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.85] - 2026-02-23

### Features

- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **dashboard**: restore embeddings inspector selection
- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: move UMAP projection server-side

### Refactoring

- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.84] - 2026-02-23

### Features

- **dashboard**: add shift lock for embeddings hover preview
- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: move UMAP projection server-side

### Refactoring

- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- fill documentation gaps from audit
- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.83] - 2026-02-23

### Features

- **dashboard**: color code log levels in logs tab
- **dashboard**: add embedding filter presets and cluster lens
- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **cli**: force fresh update check on explicit commands
- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: move UMAP projection server-side

### Refactoring

- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.82] - 2026-02-23

### Features

- **skills**: add signet-design skill assets
- **tray**: add system tray app (Tauri v2)
- **web**: migrate to Astro, add /docs section
- **dashboard**: migrate selects and date filter to shadcn components
- **scripts**: add post-push release sync
- **dashboard**: surface hook outputs in logs
- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: move UMAP projection server-side

### Refactoring

- **daemon**: extract update system, add observability
- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- update AGENTS.md for recent changes
- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.81] - 2026-02-23

### Features

- add changelog + public roadmap
- **dashboard**: make session logs scrollable and inspectable
- **daemon**: add re-embed repair endpoint and CLI
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration
- refine session end hook
- **daemon**: add Claude Code headless LLM provider
- **daemon**: add analytics and timeline (Phase K)
- **daemon**: add auth module (Phase J)
- **sdk**: rewrite as HTTP client for daemon API
- **daemon**: phase H ingestion and connectors
- **openclaw**: add plugin path option to setup
- **daemon**: phase G plugin-first runtime
- **daemon**: phase F autonomous maintenance
- **daemon**: phase E graph + reranking
- **web**: update hero and add secrets section
- **daemon**: phase D2/D3 soft-delete and policy
- **daemon**: phase B shadow extraction pipeline
- **core,daemon**: phase A infrastructure hardening
- **web**: integrate marketing website into workspace
- **hooks**: migrate all hooks from memory.py to daemon API
- **cli**: sync built-in skills on setup/reconfigure
- **update**: add unattended auto-update installs
- **embeddings**: speed up graph loading
- **setup**: harden installer and setup flows
- **core,daemon**: migrate vector search to sqlite-vec
- **core,daemon**: add hierarchical chunking for memory ingestion
- **daemon**: use system git credentials for sync
- **cli**: add signet remember and signet recall commands
- **daemon**: add embedding provider status check
- **dashboard**: schematic monochrome graph aesthetic
- **connectors**: add @signet/connector-openclaw
- **connectors**: inject Signet system block into harness files
- **core**: add database schema migration system
- **core**: add runtime-detected SQLite and connector packages
- **cli**: auto-detect Python and offer alternatives for zvec
- sync existing Claude memories on daemon startup
- auto-sync Claude Code project memories to Signet
- add /api/hook/remember endpoint for Claude Code compatibility
- add signet skill to teach agents how to use signet
- add secrets to interactive menu, fix yaml parsing for existing config
- symlink skills to harness dirs, use --system-site-packages for venv
- **setup**: add 'Import from GitHub' option for fresh installs and existing
- **cli**: add 'signet sync' command to sync templates and fix venv
- **setup**: add .gitignore template (ignores .venv, .daemon, pycache)
- **setup**: create venv for Python deps, daemon uses venv Python
- **setup**: auto-install Python dependencies (PyYAML, zvec)
- **dashboard**: add memory filter UI and similar search
- initial monorepo scaffold

### Bug Fixes

- **dashboard**: break projection polling loop on error
- **daemon**: handle bun:sqlite Uint8Array blobs
- **core**: compute __dirname at runtime
- **docs**: correct license to Apache-2.0 in READMEs
- **daemon**: sync vec_embeddings on write
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
- **daemon**: repair vector search with sqlite-vec
- pre-release safety fixes
- **core**: repair v0.1.65 migration version collision
- **test**: exclude references from test discovery
- **cli**: accept value arg in secret put
- **opencode**: wire plugin and AGENTS-first inject
- **embeddings**: support legacy pagination paths
- **cli**: show agent.yaml in status checks
- **skills**: update templates to use signet recall/remember CLI
- **migration**: handle schema_migrations table without checksum column
- **build**: ensure connectors build before signetai meta-package
- **connectors**: add @types/node for CI builds
- **templates**: wrap Signet block in SIGNET:START/END delimiters
- **build**: use relative import for @signet/core in CLI
- **build**: ensure core builds before dependent packages
- **ci**: mark @signet/core as external in CLI build
- **ci**: use jq for version bump to avoid npm workspace issue
- add missing dependencies for CI build
- **ci**: remove frozen-lockfile for workspace compat
- update lockfile
- **cli**: use simple bin format for npm
- **cli**: add shebang to build output and fix repository url
- make zvec optional (requires Python 3.10-3.12)
- add zvec back to requirements.txt
- rename .gitignore to gitignore.template so npm includes it
- better browser open messages, remove zvec dep, improve postinstall
- **setup**: better venv/pip error messages with actual stderr output
- **cli**: clear screen between menu iterations, add pause after output
- **setup**: better venv error message with distro-specific install hints
- **setup**: robust pip install with fallbacks and warning on failure
- **setup**: load existing config values as defaults when reconfiguring
- **daemon**: auto-init memory schema, add remember/recall skills
- **cli**: replace emojis with text icons, handle Ctrl+C gracefully
- **bin**: use spawnSync instead of spawn.sync
- **cli**: daemon path resolution for published package

### Performance

- **dashboard**: move UMAP projection server-side

### Refactoring

- **daemon**: expose LlmProvider as singleton
- **dashboard**: migrate to shadcn-svelte
- **cli**: remove Python/zvec setup in favor of sqlite-vec
- **core,cli,daemon**: extract shared utilities and add connector-base

### Docs

- **wip**: add daemon.ts refactor plan
- **memory**: turn procedural memory plan into implementation spec
- update procedural memory plan
- update AGENTS.md with architecture gaps
- update CLAUDE.md with Phase G pipeline docs
- update frontmatter yaml on signet skill
- embed vision into signet skill template
- **daemon**: add procedural memory plan
- the future remembers everything
- the future remembers everything
- **readme**: add how memory works section
- **readme**: use HTML tables for layout
- **readme**: add memory loop blueprint diagram
- **readme**: add poster images
- **repo**: refresh README and AGENTS guidance
- update memory commands to use signet remember/recall CLI
- sync documentation with current implementation
- update documentation for schema migration system
- improve README with badges and clearer value prop


## [0.1.80] - 2026-02-22

### Features
- **dashboard**: make session logs scrollable and inspectable

## [0.1.79] - 2026-02-22

### Docs
- update AGENTS.md with architecture gaps

## [0.1.78] - 2026-02-21

### Bug Fixes
- **dashboard**: break projection polling loop on error

## [0.1.77] - 2026-02-21

### Bug Fixes
- **daemon**: handle bun:sqlite Uint8Array blobs

## [0.1.76] - 2026-02-21

### Performance
- **dashboard**: move UMAP projection server-side

### Features
- **daemon**: add re-embed repair endpoint and CLI

## [0.1.75] - 2026-02-20

### Refactoring
- **dashboard**: migrate to shadcn-svelte

### Features
- **dashboard**: unify settings tab form
- **dashboard**: redesign with shadcn sidebar and skills.sh integration

## [0.1.74] - 2026-02-19

### Features
- refine session end hook

### Bug Fixes
- **core**: compute __dirname at runtime

## [0.1.73] - 2026-02-19

### Features
- **daemon**: add Claude Code headless LLM provider

## [0.1.72] - 2026-02-18

### Bug Fixes
- **docs**: correct license to Apache-2.0 in READMEs

## [0.1.71] - 2026-02-18

### Bug Fixes
- **daemon**: sync vec_embeddings on write

## [0.1.70] - 2026-02-17

### Bug Fixes
- **core**: add unique index on embeddings.content_hash
- **daemon**: use Ollama HTTP API for extraction
