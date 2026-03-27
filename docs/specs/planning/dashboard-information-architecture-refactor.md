---
title: "Dashboard IA Refactor"
id: dashboard-information-architecture-refactor
status: planning
informed_by: []
section: "Dashboard"
depends_on:
  - "signet-runtime"
success_criteria:
  - "Settings become standalone page and dashboard navigation is consolidated with breadcrumb-driven interaction"
scope_boundary: "Covers navigation structure, settings page layout, and identity panel extraction; does not change daemon API surface or settings schema"
draft_quality: "auto-generated, needs user validation before implementation"
---

# Dashboard IA Refactor

Spec metadata:
- ID: `dashboard-information-architecture-refactor`
- Status: `planning`
- Hard depends on: `signet-runtime`
- Registry: `docs/specs/INDEX.md`

Related docs:
- `packages/cli/dashboard/src/routes/+page.svelte`
- `packages/cli/dashboard/src/lib/stores/navigation.svelte.ts`
- `docs/DASHBOARD.md`

---

## 1) Problem

The dashboard uses a flat tab bar with 18 tab IDs in `navigation.svelte.ts`.
Settings, memory views, knowledge, pipeline, secrets, skills, tasks, and
connectors all compete for top-level space. At 18 tabs, the flat structure
creates navigation overload (no grouping) and settings sprawl (agent config,
embeddings, memory, pipeline, trust, and auth intermixed in one form).
Identity files require leaving settings entirely.

## 2) Goals

1. Group tabs into navigational sections with two-level hierarchy.
2. Extract Settings into standalone page with horizontal section navigator
   and collapsible Advanced panels.
3. Add integrated identity file editor panel within Settings.
4. Breadcrumb navigation for section > subsection context.
5. Unified dirty-state tracking across settings form and identity files.

## 3) Proposed capability set

### A) Navigation hierarchy

Replace flat tab list with sidebar groups:

- **Engine**: Home, Pipeline, Predictor, Logs
- **Memory**: Memories, Timeline, Constellation, Knowledge
- **Configuration**: Settings, Connectors, Secrets, Skills
- **System**: Tasks, Changelog, OS

`SidebarGroup` + `SidebarGroupLabel` for section headers. Breadcrumbs at
content top: `Engine > Pipeline`. Clicking a segment navigates to that level.

### B) Settings standalone page

Horizontal section navigator with seven sections:

| Section | Contents |
|---|---|
| Agent | Name, description, model, harness config (Advanced) |
| Embeddings | Provider, model, auto dimensions |
| Memory | Retention, decay, paths (Advanced) |
| Search | Limits, hybrid weights (Advanced), rehearsal toggle |
| Pipeline | Mode toggles, extraction model, predictor controls |
| Trust | Shadow mode, mutations frozen, autonomous |
| Auth | Tokens, rate limits |

Each section has a collapsible Advanced panel (`AdvancedSection.svelte`
using shadcn `Collapsible`).

### C) Identity panel

Resizable side panel (`IdentityPanel.svelte`) on settings page right edge.
File selector dropdown (AGENTS.md, SOUL.md, IDENTITY.md, USER.md, MEMORY.md,
HEARTBEAT.md). CodeMirror 6 editor (reuse `CodeEditor.svelte`). Character
budget bar. Collapse toggle. Drag-to-resize divider. Visible by default on
viewports >= 1280px.

### D) Unified dirty-state tracking

Extend `unsaved-changes.svelte` with `identityDirty` signal alongside
`settingsDirty`. Save bar appears on any change. Ctrl+S saves both settings
PATCH and identity PUT in parallel.

### E) Section reorganization

- Agent absorbs Harnesses (delete `HarnessesSection.svelte`).
- Memory absorbs Paths (delete `PathsSection.svelte`).
- Search: most knobs to Advanced, rehearsal stays visible.
- Pipeline: largest section with predictor enable/disable, feedback toggle,
  telemetry toggle. Advanced: timeout, batch size, classify knobs.

### F) Hash routing

Two-level hashes: `#settings/pipeline`, `#memory/constellation`. Replace
`VALID_TABS` with `VALID_ROUTES` map. Single-level hashes redirect to
default sub-route for backwards compatibility.

## 4) Non-goals

- No new daemon API endpoints.
- No mobile-responsive layout (desktop targets only).
- No changes to settings data schema or `agent.yaml`.
- No removal of Cortex tabs (parallel experiment).

## 5) Integration contracts

**IA <-> Constellation Viewer**: `constellation` tab under Memory group.
Falls back to `embeddings`/`knowledge` if viewer not yet implemented.

**IA <-> Settings Store**: `settings.svelte.ts` API unchanged. New predictor
fields added to store interface.

**IA <-> Unsaved Changes**: `hasUnsavedChanges` is union of `settingsDirty`
and `identityDirty`.

## 6) Rollout phases

### Phase 1: Navigation hierarchy
Sidebar groups, breadcrumbs, two-level hash routing. Backwards-compatible
redirects for existing bookmarks.

### Phase 2: Settings page
Standalone settings with section navigator, Advanced collapsibles,
IdentityPanel, section reorganization.

### Phase 3: Polish
Unified dirty-state save bar, keyboard shortcuts (Ctrl+S, Ctrl+J, Escape),
drag-to-resize, transition animations.

## 7) Validation and tests

- All grouped tabs render and route correctly.
- `#settings/pipeline` resolves; `#settings` redirects to `#settings/agent`.
- Identity panel loads correct file, edits tracked as dirty.
- Ctrl+S saves, Ctrl+J focuses search, Escape closes panel.
- Breadcrumb clicks navigate to correct level.

## 8) Success metrics

- Sidebar fits all tabs without scrolling at 900px viewport height.
- Settings page loads all sections within 200ms.
- Identity editing without leaving settings context.
- No regression in existing tab routing for bookmarked URLs.

## 9) Open decisions

1. Whether Cortex tabs merge into new hierarchy or stay separate.
2. Whether identity panel supports split-view editing of two files.
3. Final placement of OS and Changelog (System group vs footer utility).

## 10) Implementation notes for planning validation (2026-03-26)

Implementation notes observed during planning validation:

- Sidebar now surfaces direct top-level destinations for `Memory`, `Tasks`,
  `Audit`, and `Settings` (with `Cortex` renamed to `Memory` and `Engine`
  renamed to `Settings`).
- `Audit` is the new home for diagnostics and log viewing, combining
  troubleshooter workflows with daemon logs.
- `Pipeline`, `Predictor`, `Connectors`, `Logs`, and `Cortex Apps` were
  switched off from primary navigation, not deleted.
- Legacy hashes for switched-off destinations now redirect to active tabs
  (`settings`, `tasks`, `audit`, or `cortex-memory`) for bookmark
  compatibility.
