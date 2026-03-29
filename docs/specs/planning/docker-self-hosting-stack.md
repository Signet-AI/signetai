---
title: "Docker Self-Hosting Stack"
id: docker-self-hosting-stack
status: planning
informed_by:
  - docs/research/technical/RESEARCH-DOCKER-SELF-HOSTING.md
section: "Infrastructure"
depends_on:
  - signet-runtime
success_criteria:
  - "Signet ships a first-party Docker image and Compose stack that boots daemon + reverse proxy with persistent workspace storage"
  - "Default Docker bootstrap path enforces team auth posture and provides an explicit initial admin-token creation path"
  - "Official image publishing supports linux/amd64 and linux/arm64 with stable tags"
  - "Self-hosting docs include Docker quickstart, backup/restore, and in-place upgrade flow"
scope_boundary: "Daemon/container deployment only. No changes to memory retrieval logic, ontology, or scoring models."
draft_quality: "reviewed in planning session"
---

# Docker Self-Hosting Stack

## Problem

Signet is self-hostable, but operators do not have an official container
contract. This increases deployment drift and onboarding time across teams
that standardize on Docker-based infra.

## Goals

1. Provide a stable first-party Docker image for daemon runtime.
2. Ship Compose defaults that are safe enough for real deployments.
3. Make auth bootstrapping explicit under `auth.mode: team`.
4. Document the operational lifecycle (start, verify, backup, upgrade).

## Non-goals

- Kubernetes manifests in v1.
- Bundling Ollama in the default stack.
- Changing daemon APIs.

## Proposed approach

1. Add `deploy/docker/` with Dockerfile, Compose file, Caddy config,
   env template, and token-bootstrap helper script.
2. Container entrypoint creates `agent.yaml` with `auth.mode: team`
   if missing, then starts daemon.
3. Publish `ghcr.io/signet-ai/signet` on release tags for amd64/arm64.
4. Add CI smoke validation that builds the image and confirms `/health`
   through proxy.
5. Extend self-hosting docs with Docker runbook.

## Validation criteria

- `docker compose up -d --build` starts healthy stack with persisted
  workspace volume.
- Initial admin token can be minted without downgrading auth mode.
- Tagged release publishes multi-arch image to GHCR.
- Docs provide complete operator flow without external assumptions.

## Open decisions

- Should a hardened production profile (non-root UID, read-only rootfs)
  be included in v1 or v2?

