---
title: "Runtime extensions API"
description: "Connectors, harnesses, skills, plugins, and secrets."
---

[Back to HTTP API](/api/).

## Connectors and harnesses

| Route family | Status | Permission |
|---|---|---|
| `/api/connectors` | canonical | connectors |
| `/api/connectors/resync` | canonical | connectors |
| `/api/harnesses` | canonical | connectors; connect is admin |
| `/api/harnesses/:id/connect` | canonical | admin |

Harness connect accepts the registered harness IDs only and installs through the
daemon workspace. It accepts no arbitrary filesystem path. Installation is
bounded and serialized; partial failures are reported explicitly.

## Skills, plugins, and secrets

| Route family | Status | Permission |
|---|---|---|
| `/api/skills`, `/api/skills/:name`, `/api/skills/search`, `/api/skills/install` | canonical | skills |
| `/api/skills/browse` | canonical | skills read |
| `/api/skills/analytics` | canonical | analytics |
| `/api/plugins`, `/api/plugins/:id` | canonical | admin |
| `/api/secrets` | canonical | secrets; admin for mutation |

Route-specific guards and response types define the exact fields. A plugin or
skill endpoint is an extension surface; it does not create an alternate daemon
configuration or memory owner.
