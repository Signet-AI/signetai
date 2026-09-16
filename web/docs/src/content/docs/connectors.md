---
title: "Connectors"
description: "Connect external document providers to Signet."
---

Connectors import documents from provider resources into Signet's document
pipeline. They are different from harness integrations, which connect an agent
runtime to Signet, and from Dashboard [Sources](/sources/), which is the
user-facing workflow for adding supported sources.

## Supported providers

The daemon currently accepts these provider names:

- `filesystem` — files under an absolute local directory.
- `github-docs` — GitHub documentation resources.
- `gdrive` — Google Drive resources.

Provider availability and settings depend on the running daemon. Experimental
or internal providers must not be presented as supported public providers.

## Register a connector

Connector writes require daemon admin permission. Register a provider through
the local API:

```bash
curl -X POST http://localhost:3850/api/connectors \
  -H 'content-type: application/json' \
  -d '{"provider":"filesystem","displayName":"My docs","settings":{"rootPath":"/path/to/docs","patterns":["**/*.md","**/*.txt"]}}'
```

The response contains the connector `id`. Keep it for sync and health calls.
The filesystem provider requires an absolute `rootPath`; it defaults to Markdown
and text files and ignores common `.git`, `node_modules`, and `.DS_Store` paths.

## Sync and verify

```bash
curl -X POST http://localhost:3850/api/connectors/<id>/sync
curl http://localhost:3850/api/connectors/<id>/health
```

Sync runs in the background. Health reports the connector status, last sync,
last error, and current document count. A full resync is explicit and may
reprocess every matching resource:

```bash
curl -X POST 'http://localhost:3850/api/connectors/<id>/sync/full?confirm=true'
```

To inspect registered connectors, use `GET /api/connectors`. These API rows
are daemon connector records; they are not a shared CLI or dashboard status
claim for every platform integration.

## Troubleshooting

- `400 provider must be ...`: use one of the supported provider names above.
- `error` health status: read `lastError`, fix the provider settings, then run
  another incremental sync.
- No documents: verify the path, patterns, permissions, and file size limits.
- No access: use an API key or daemon credentials with the required admin
  permission for write endpoints.

Unregister a connector with `DELETE /api/connectors/<id>`. Add
`?cascade=true` only when associated document rows should also be removed.
