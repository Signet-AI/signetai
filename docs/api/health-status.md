---
title: "Health and status API"
description: "Health, status, and runtime feature endpoints."
order: 11
section: "Reference"
---

# Health and status API

Health, status, and runtime feature endpoints.

[Back to HTTP API overview](../API.md).

## Health & Status

### GET /health

No authentication required. Lightweight liveness check.

**Response**

```json
{
  "status": "healthy",
  "uptime": 3600.5,
  "pid": 12345,
  "version": "0.124.5",
  "port": 3850,
  "agentsDir": "/home/user/.agents",
  "db": true,
  "shuttingDown": false,
  "updateAvailable": false,
  "pendingRestart": false,
  "pipeline": {
    "extractionRunning": true,
    "extractionStalled": false,
    "extractionPending": 0,
    "extractionBackoffMs": 0
  },
  "resources": { "...": "..." }
}
```

### GET /api/status

Full daemon status including pipeline config, embedding provider, and a
composite health score derived from diagnostics. Extraction provider
runtime resolution persists startup degradation so operators can detect
silent fallback or hard-blocked extraction after boot.

**Response**

```json
{
  "status": "running",
  "version": "0.124.5",
  "pid": 12345,
  "uptime": 3600.5,
  "startedAt": "2026-02-21T10:00:00.000Z",
  "port": 3850,
  "host": "127.0.0.1",
  "bindHost": "127.0.0.1",
  "networkMode": "localhost",
  "agentId": "default",
  "agentsDir": "/home/user/.agents",
  "memoryDb": true,
  "pipelineV2": {
    "enabled": true,
    "paused": false,
    "shadowMode": false,
    "mutationsFrozen": false,
    "graph": {
      "enabled": true,
      "extractionWritesEnabled": true
    },
    "autonomous": {
      "enabled": true,
      "allowUpdateDelete": true
    },
    "extraction": {
      "provider": "llama-cpp",
      "model": "qwen3:4b"
    }
  },
  "pipeline": {
    "extraction": {
      "running": true,
      "overloaded": false,
      "loadPerCpu": 0.42,
      "maxLoadPerCpu": 0.8,
      "overloadBackoffMs": 30000,
      "overloadSince": null,
      "nextTickInMs": 1200
    }
  },
  "providerResolution": {
    "extraction": {
      "configured": "llama-cpp",
      "resolved": "llama-cpp",
      "effective": "llama-cpp",
      "fallbackProvider": "llama-cpp",
      "status": "active",
      "degraded": false,
      "fallbackApplied": false,
      "reason": null,
      "since": null
    }
  },
  "logging": {
    "logDir": "/home/user/.agents/.daemon/logs",
    "logFile": "/home/user/.agents/.daemon/logs/signet-2026-04-29.log"
  },
  "activeSessions": 1,
  "bypassedSessions": 1,
  "agentCreatedAt": "2026-02-21T10:00:00.000Z",
  "health": { "score": 0.97, "status": "healthy" },
  "update": {
    "currentVersion": "0.124.5",
    "latestVersion": null,
    "updateAvailable": false,
    "pendingRestart": null,
    "autoInstall": false,
    "checkInterval": 21600,
    "lastCheckAt": null,
    "lastError": null,
    "timerActive": true
  },
  "embedding": {
    "provider": "ollama",
    "model": "nomic-embed-text",
    "available": true
  }
}
```

The `bypassedSessions` field reports how many active sessions currently have
bypass enabled (see [Sessions and hooks API](./sessions-hooks.md#sessions)).
Monitor `providerResolution.extraction.status` for `degraded` or `blocked`
states when the configured extraction provider is unavailable or routed to a
fallback target.
When `pipeline.extraction.overloaded` is `true`, the extraction worker is
intentionally backing off for `overloadBackoffMs` between polls.
Use `GET /api/inference/status` for the shared inference control plane status.


### GET /api/features

Returns all runtime feature flags.

**Response**

```json
{
  "featureName": true,
  "anotherFeature": false
}
```
