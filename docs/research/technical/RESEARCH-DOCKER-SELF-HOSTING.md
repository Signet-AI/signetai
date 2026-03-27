---
title: "Docker Self-Hosting for Signet Daemon"
id: RESEARCH-DOCKER-SELF-HOSTING
status: reference
question: "What deployment contract lets operators run Signet reliably in Docker without losing workspace persistence, auth safety, or upgrade clarity?"
updated: 2026-03-27
---

# Docker Self-Hosting for Signet Daemon

## Context

Signet has strong self-hosting guidance for systemd and launchd, but no
first-class Docker deployment artifacts. Teams running VM/container
infrastructure currently hand-roll container images, reverse proxy config,
and auth bootstrapping.

## Findings

1. Signet daemon already supports container-friendly network variables
   (`SIGNET_BIND`, `SIGNET_PORT`, `SIGNET_PATH`) and health checks (`/health`).
2. Team-mode auth is safer for exposed deployments, but bootstrap requires
   an initial admin token path.
3. Persistent workspace storage is mandatory because Signet state spans
   SQLite, config files, and auth secret material.
4. Reverse proxy termination is already documented for nginx/Caddy and can be
   standardized in Compose.
5. Multi-arch image publishing (amd64/arm64) is needed for cloud VMs plus
   Apple Silicon hosts.

## Implications

A complete Docker baseline should include:

- canonical image build contract
- Compose stack with proxy and named persistent volumes
- explicit token bootstrap flow for team mode
- upgrade + backup runbook
- CI guardrails (image build + runtime smoke)

