# Integration guidance

This subtree connects Signet to external agent harnesses. Read the matching
integration package, `web/docs/src/content/docs/hooks.md`, and the harness's own source before
changing its contract.

## Verify the real harness

- Matching harness repositories live under the untracked `references/`
  directory. Directory names are not always identical to integration names;
  locate the actual owner before drawing conclusions.
- Verify protocol, lifecycle, packaging, and error behavior against the
  sibling harness's current source, types, or tests. Signet wrappers, PR prose,
  generated schemas, and memory are useful leads but not contract proof.
- Exercise changed behavior end to end in the real harness. If the sibling
  repository or runnable harness is unavailable, report that limitation and
  avoid claiming full integration proof.

## Keep integration paths distinct

- Connector installation and daemon runtime handling are different surfaces.
  Trace both sides of a contract instead of assuming one proves the other.
- Connectors identify the runtime path with
  `x-signet-runtime-path: plugin|legacy`. A session can have only one active
  path; conflicting claims return `409`. Check installed configuration when
  duplicate hooks, duplicate recall, or excess token use is reported.
- Preserve agent identity and session binding through hook payloads, headers,
  daemon calls, transcripts, and cleanup. Do not silently move scoped data to
  the default agent.
- Validate external payloads at the boundary and return diagnosable failures;
  do not silently downgrade to a legacy or duplicate path.

## Prove the shipped artifact

- Run the focused package tests and build for the integration you changed.
  When behavior depends on a bundle, manifest, install script, or published
  package, inspect and exercise that generated artifact rather than only its
  TypeScript source.
- Keep harness-facing documentation current when lifecycle, headers, setup,
  or supported behavior changes.
