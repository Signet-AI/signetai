# Changelog

All notable changes to Signet are documented here.

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
