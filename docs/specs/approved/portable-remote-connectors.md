---
title: "Portable Remote Connectors"
id: portable-remote-connectors
status: approved
section: "Connectors"
depends_on:
  - "signet-runtime"
  - "native-harness-memory-bridge"
success_criteria:
  - "A user can run one Signet daemon on a trusted machine and point harness connectors on other machines at it"
  - "Each harness connector is distributed as its own npm package and can be installed directly or through the Signet CLI"
  - "The CLI can create named, revocable API keys for connector use"
  - "Connectors authenticate with a simple bearer API key and include harness, agent, session, machine, and project context on requests"
  - "Local and remote connector modes use the same daemon API surface; switching hosts is primarily a URL and API-key change"
scope_boundary: "Defines the public connector/auth direction for remote harness use; does not specify Signet Cloud relay, enterprise SSO, or hosted daemon implementation details"
---

# Portable Remote Connectors

Signet should support one trusted Signet instance serving every harness the user
runs, even when those harnesses run on other machines. The product shape is:

> Run Signet once. Point every connector at it with `SIGNET_DAEMON_URL` and
> `SIGNET_API_KEY`.

The daemon remains the authority boundary: source truth, memory policy,
identity, provenance, session ingestion, search, and background maintenance live
there. Harness connectors should be small edge adapters that install into a
harness, forward session events, expose Signet tools, and call the daemon over a
stable API.

## Distribution model

Each harness connector should be its own npm package, for example:

- `@signet/connector-pi`
- `@signet/connector-codex`
- `@signet/connector-opencode`
- `@signet/connector-claude-code`

Connector packages must remain directly installable for portable use:

```bash
npx @signet/connector-pi install \
  --url https://signet-home.tailnet:3850 \
  --api-key sig_sk_...
```

The Signet CLI may wrap these packages for the local/common path:

```bash
signet connector install pi
signet connector install pi --url https://signet-home.tailnet:3850 --api-key sig_sk_...
```

Shared behavior belongs in `@signet/connector-base`: config loading, daemon
client defaults, API-key handling, request envelopes, timeouts, retries, health
checks, and common Signet tool contracts. Harness-specific packages should own
only installation and runtime glue required by that harness.

## Auth model

The default auth primitive is a simple API key. This is intentionally boring:
remote connector setup should not require OAuth, a cloud account, or a pairing
protocol for V1.

The CLI must be able to generate connector API keys:

```bash
signet api-key create --name "work laptop pi" --connector pi
signet api-key list
signet api-key revoke <id-or-prefix>
signet api-key rotate <id-or-prefix>
```

The daemon prints the raw key once and stores only a hash:

```text
API key created:

  name:      work laptop pi
  id:        key_...
  key:       sig_sk_...
  scopes:    connector:pi, recall, remember, source_search, session_search, session_events
  daemon:    https://signet-home.tailnet:3850

Save this now. It will not be shown again.
```

Connector requests authenticate with bearer auth:

```http
Authorization: Bearer sig_sk_...
X-Signet-Harness: pi
X-Signet-Connector-Version: 0.140.0
```

Internally, API keys should be named, scoped, revocable records:

```ts
type ApiKeyRecord = {
  id: string;
  prefix: string;
  hash: string;
  name: string;
  scopes: string[];
  connector?: string;
  harness?: string;
  agentId?: string;
  allowedProjects?: string[];
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
  expiresAt?: string;
};
```

The user-facing model is still just a URL and key. Scopes are the safety rail,
not the main setup ceremony.

## Request context

Every remote connector request should carry enough context for the daemon to
scope data, attribute events, and preserve provenance:

```json
{
  "harness": "pi",
  "connectorId": "conn_...",
  "agentId": "nicholai/pi",
  "machineId": "work-laptop",
  "sessionKey": "...",
  "project": {
    "cwd": "/Users/nicholai/signetai",
    "gitRemote": "git@github.com:Signet-AI/signetai.git",
    "gitRoot": "..."
  }
}
```

Remote filesystem paths are evidence, not portable identity. Where possible,
project identity should prefer repository metadata such as git remote, root
fingerprint, and declared workspace name over raw `cwd` strings.

## Transport

V1 should use HTTP APIs. WebSocket support can be added later for live context
pushes, revocation, status streaming, or long-running connector sessions.

The same connector should work against:

```text
http://127.0.0.1:3850
https://signet-home.tailnet:3850
https://future-relay.signet.ai/...
```

Cloud relay and hosted Signet Cloud are not required for the first remote
connector milestone. Tailnet/LAN/self-hosted HTTPS is enough to prove the model.

## Design principle

Connectors are disposable stateless edge adapters. The Signet daemon is the
policy engine, authority boundary, source index, memory substrate, and session
continuity layer.
