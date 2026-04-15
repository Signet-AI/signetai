## 2026-04-15

- Added module-level `artifactIndexCache` keyed by `agentId` (or `"*"`) and file path to preserve synchronous API shape while making indexing incremental.
- Introduced `lastChangedManifests` handoff from `reindexMemoryArtifacts()` to `renderMemoryProjection()` so `syncManifestRefs()` can run in scoped mode (`changedManifests`) without making render path async.
- Kept `syncManifestRefs()` backward compatible: `changedManifests === undefined` preserves full-manifest behavior; empty set short-circuits.
