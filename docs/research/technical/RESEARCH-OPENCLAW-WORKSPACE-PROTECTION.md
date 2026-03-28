---
title: "OpenClaw Workspace Protection Research"
question: "How should Signet prevent data loss when OpenClaw uninstall deletes a workspace that points at .agents?"
---

# OpenClaw Workspace Protection Research

## Question

How should Signet prevent data loss when OpenClaw uninstall deletes a
workspace that points at `.agents`?

## Incident

Community reports confirmed a critical failure mode: uninstalling OpenClaw
can remove the configured workspace directory. When that workspace is also the
Signet agent directory, users can lose identity files, memory database
contents, and local git history in one action.

If no remote repository or external backup exists, recovery is effectively
impossible.

## Current state

- Signet setup can patch OpenClaw workspace to the Signet path.
- Setup encourages git initialization, but does not require or strongly nudge
  remote origin configuration.
- Status and doctor do not flag this specific backup risk.

## Risk model

High risk condition:

1. OpenClaw config workspace resolves to the Signet workspace path.
2. The workspace has no `origin` remote.
3. User uninstalls OpenClaw or otherwise deletes that workspace tree.

## Recommended guardrails

1. Add a setup soft gate when the high risk condition is detected.
2. Treat either of these as acceptable immediate protection:
   - configured git `origin` remote, or
   - freshly created local snapshot outside the workspace.
3. Add non-interactive flags so automation cannot silently proceed in an
   unprotected state.
4. Surface the condition in `signet status` and `signet doctor`.
5. Make OpenClaw workspace patch prompts explicitly mention uninstall risk.

## Practical requirement

This is an incident-driven reliability and data safety patch, not a UI polish
change. The prevention loop must include durable code guardrails plus explicit
operator messaging.
