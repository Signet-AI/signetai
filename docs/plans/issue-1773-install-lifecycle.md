# Plan: Make OS marketplace installs bounded and idempotent (issue #1773)

> Closes https://github.com/Signet-AI/signetai/issues/1773.
> Branch: `fix/1773-os-marketplace-install-timeout-and-duplicate-probes`.

## Problem and baseline

`POST /api/os/install` currently has a direct-URL implementation in
`platform/daemon/src/routes/app-tray.ts` and delegates catalog installs to
`POST /api/marketplace/mcp/install` over loopback HTTP. The marketplace route
persists the server and starts a detached probe; the OS route then reads the
server and starts a second awaited probe. The loopback call has a 10-second
budget while catalog detail fetches can run for 20–25 seconds, so a visible
failure can be followed by a late mutation and a retry race.

The issue acceptance criteria require one application boundary below both
routes, one deadline/cancellation signal, one installed-state mutation path,
a single probe lifecycle, and retry-safe identity. The existing marketplace
server JSON file and app-tray/probe files remain the durable state surfaces;
this change does not introduce a second database or ambient route-to-route
transport.

## Phased implementation

### Phase 1 — Establish the canonical install service

1. Move shared marketplace server types, validation, catalog detail fetching,
   identity generation, installed-server read/write, and cache invalidation
   behind `mcp-install-service.ts`.
2. Define typed direct and catalog requests plus an explicit result containing
   `created`/`updated` semantics, an operation identifier, and completed vs
   accepted status.
3. Derive a stable idempotency key from the normalized target when the caller
   does not provide `Idempotency-Key`; persist the key and operation ID with
   the installed server so retries remain safe across route calls and daemon
   restarts.

### Phase 2 — Enforce deadline and cancellation ownership

1. Create one bounded install deadline and combine it with the incoming HTTP
   request signal.
2. Thread the remaining budget/signal through catalog detail fetches, the
   installed-state mutation fence, and the one awaited probe.
3. Reject before mutation when the deadline/caller signal expires. Once the
   synchronous mutation boundary is crossed, return `202 Accepted` semantics
   with the operation ID if probing cannot finish; never detach a write that
   was not reported as accepted.

### Phase 3 — Migrate both routes

1. Make `/api/os/install` call the service for both direct and catalog inputs;
   retain only URL-shape parsing and OS-specific auto-placement in the route.
2. Make `/api/marketplace/mcp/install` call the same service and preserve its
   existing response fields for compatibility.
3. Remove the loopback `fetchInternal` install call, duplicate direct installer,
   and route-owned install probes. Keep manual registration and explicit
   re-probe behavior on their existing paths.

### Phase 4 — Regression coverage

Add only the acceptance-critical service tests:

- deadline/cancellation before mutation leaves installed state unchanged;
- cancellation after mutation returns an operation ID and does not perform a
  late probe-result write;
- concurrent/retried requests with one stable key produce one mutation and one
  probe;
- direct and catalog requests use the same canonical mutation/probe boundary.

Use injected service dependencies for deterministic timing and retain the
existing marketplace route tests for unrelated catalog/tool behavior.

### Phase 5 — Validation and delivery

1. Run focused daemon tests, daemon typecheck/build, lint/format checks, and
   the complete repository test suite.
2. Inspect the final diff for route-to-route HTTP calls, duplicate persistence
   or probe paths, deadline leaks, and unsafe input handling.
3. Commit with a conventional fix subject, push the issue branch, and open a
   PR whose body includes the issue-closing keyword, phased summary, test
   evidence, and repository readiness checklist. Apply only relevant existing
   labels and comment on #1773 with the completed fix and verification.
