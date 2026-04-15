## 2026-04-15

- `reindexMemoryArtifacts()` can avoid full-directory rescans by caching `mtimeMs` per canonical artifact path and only re-reading files whose mtimes changed.
- When applying incremental indexing under agent scoping, caching non-matching scoped files prevents repeated parse work on every scoped run.
- Propagating changed manifest paths into `syncManifestRefs()` avoids touching all manifest files during projection rendering.
