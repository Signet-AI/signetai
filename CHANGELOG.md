# Changelog

All notable changes to Signet are documented here.

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
