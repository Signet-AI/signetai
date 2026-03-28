---
title: "OpenClaw Workspace Protection Plan"
id: openclaw-workspace-protection-plan
status: planning
informed_by:
  - docs/research/technical/RESEARCH-OPENCLAW-WORKSPACE-PROTECTION.md
section: "OpenClaw"
depends_on:
  - "openclaw-hardening"
success_criteria:
  - "Setup blocks silent completion when OpenClaw points at the Signet workspace and no remote backup is configured"
  - "Users can satisfy setup protection by configuring git origin or creating an out-of-workspace local snapshot"
  - "Status and doctor surfaces flag unprotected OpenClaw-linked workspaces with remediation commands"
scope_boundary: "CLI setup/status/doctor guardrails only; no OpenClaw uninstall behavior changes in upstream OpenClaw runtime"
draft_quality: "incident-driven planning stub"
---

# OpenClaw Workspace Protection Plan

Spec metadata:
- ID: `openclaw-workspace-protection-plan`
- Status: `planning`
- Hard depends on: `openclaw-hardening`
- Registry: `docs/specs/INDEX.md`

## Problem

When OpenClaw workspace is set to the Signet workspace, uninstalling OpenClaw
can delete user memory and identity state. Current setup flow does not enforce
backup posture before finishing.

## Goals

1. Prevent silent unprotected setups in this risk state.
2. Keep automation usable with explicit escape hatches.
3. Add durable diagnostics so risk remains visible after setup.

## Proposed guardrails

1. Setup soft gate with explicit critical warning text.
2. Protection satisfied by git `origin` remote or immediate local snapshot.
3. Non-interactive setup requires explicit backup or bypass flags.
4. `signet status` and `signet doctor` report the risk condition.
5. OpenClaw workspace patch prompt explicitly describes uninstall risk.
