---
title: "OpenClaw Workspace Protection"
id: openclaw-workspace-protection
status: approved
informed_by:
  - docs/research/technical/RESEARCH-OPENCLAW-WORKSPACE-PROTECTION.md
  - docs/specs/planning/openclaw-workspace-protection-plan.md
section: "OpenClaw"
depends_on:
  - "openclaw-hardening"
  - "openclaw-workspace-protection-plan"
success_criteria:
  - "Setup refuses to complete silently for OpenClaw-linked workspaces without backup posture"
  - "Interactive setup requires explicit user action: set origin, create snapshot, or explicit bypass acknowledgement"
  - "Non-interactive setup errors unless origin exists or explicit backup/bypass flags are provided"
  - "Status and doctor report OpenClaw-linked unprotected workspace risk"
scope_boundary: "Signet CLI guardrails only; upstream OpenClaw uninstall behavior remains unchanged"
---

# OpenClaw Workspace Protection

Spec metadata:
- ID: `openclaw-workspace-protection`
- Status: `approved`
- Hard depends on: `openclaw-hardening`, `openclaw-workspace-protection-plan`
- Registry: `docs/specs/INDEX.md`

## Contract

### Setup contract

1. Detect when OpenClaw workspace resolves to the active Signet workspace.
2. Detect backup posture through git `origin` remote presence.
3. If linked + unprotected:
   - show critical warning
   - require one protection action before completion:
     - set origin remote, or
     - create local snapshot outside workspace, or
     - explicit bypass acknowledgement (soft gate)

### Non-interactive contract

If linked + unprotected, non-interactive setup must fail unless caller passes
an explicit protection flag:

- backup action flag (create local snapshot), or
- explicit bypass flag.

### Operational visibility contract

`signet status` and `signet doctor` must surface this risk condition with
actionable remediation guidance.

## Validation requirements

1. Regression tests for non-interactive failure path, backup path, and bypass
   path.
2. Tests that status reporting marks unprotected linked workspaces correctly.
