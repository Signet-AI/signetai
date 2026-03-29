---
title: "Setup Deployment Awareness"
id: setup-deployment-awareness
status: planning
informed_by: []
section: "CLI/Setup"
depends_on:
  - "signet-runtime"
success_criteria:
  - "Interactive setup asks deployment context before provider prompts and shows deployment-specific extraction guidance"
  - "Non-interactive setup accepts --deployment-type and infers provider defaults when provider flags are omitted"
  - "With --deployment-type vps and omitted extraction provider, setup avoids inferring ollama, prefers selected non-local harness tooling when available locally, then other detected non-local tooling, and falls back to none"
  - "README/QUICKSTART/CLI docs consistently present built-in native embeddings as recommended"
scope_boundary: "CLI setup and docs only; no daemon config schema, provider resolution internals, or memory pipeline behavior changes"
draft_quality: "implementation-aligned planning spec"
---

# Setup Deployment Awareness

Spec metadata:
- ID: `setup-deployment-awareness`
- Status: `planning`
- Hard depends on: `signet-runtime`
- Registry: `docs/specs/INDEX.md`

Related issues:
- `https://github.com/Signet-AI/signetai/issues/323`
- `https://github.com/Signet-AI/signetai/issues/325`

---

## 1) Problem

Setup lacked deployment context during provider selection. Users on constrained VPS hosts could pick local Ollama extraction and hit CPU saturation. Documentation also diverged across README and setup flows around embedding recommendations, causing avoidable misconfiguration.

## 2) Goals

1. Ask deployment context early in interactive `signet setup`.
2. Show deployment-aware recommendation text before extraction provider selection.
3. Add `--deployment-type <local|vps|server>` to non-interactive setup.
4. Allow non-interactive inferred defaults when provider flags are omitted.
5. Keep docs aligned with runtime defaults (native embeddings recommended).

## 3) Contracts and decisions

- Interactive flow is guidance-oriented (recommendations, not forced provider selection).
- Non-interactive explicit provider flags override inferred defaults.
- Existing configured extraction providers are preserved during existing-identity migration unless `--extraction-provider` is explicitly provided.
- VPS inference rule: if `--extraction-provider` is omitted and `--deployment-type vps` is passed, do not infer `ollama`; prefer selected non-local harness tooling (`claude-code`, `codex`, `opencode`) when those tools are available locally, then other detected non-local tooling, and fall back to `none`.
- No changes to daemon schema or pipeline defaults are required for this scope.

## 4) Proposed capability set

### A) CLI option and typed deployment context

- Add `--deployment-type` option to setup command.
- Add deployment type enum/shared constants (`local`, `vps`, `server`).

### B) Interactive setup flow update

- Insert deployment question before embedding/extraction prompts.
- Print deployment guidance immediately before extraction provider prompt.

### C) Non-interactive inference

- Remove hard requirement that embedding/extraction provider flags must always be provided.
- Infer defaults from deployment context and detected local tooling.
- Keep validation for unknown provider/deployment values.

### D) Documentation parity

Update user-facing docs and setup skill template so requirements/examples match actual behavior:
- built-in native embeddings are a first-class recommended option
- non-interactive `--deployment-type` behavior is documented

## 5) Non-goals

- No new extraction providers.
- No daemon `memory-config` schema changes.
- No pipeline extraction logic changes.
- No cost-control policy changes beyond setup copy/guidance.

## 6) Validation

- CLI tests cover deployment defaults and guidance helpers.
- Setup still builds and existing tests pass.
- Spec metadata remains synchronized (`INDEX.md` and `dependencies.yaml`).

## 7) Implementation status snapshot

Initial implementation for this planning scope has been completed in code/docs and validated with CLI tests/build. Any follow-up should use this spec as the behavior contract baseline.
