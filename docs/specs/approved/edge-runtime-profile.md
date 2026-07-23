---
title: "Constrained ARM Edge Runtime Profile"
id: edge-runtime-profile
status: approved
informed_by:
  - "https://github.com/Signet-AI/signetai/issues/921"
section: "Runtime"
depends_on:
  - "signet-runtime"
success_criteria:
  - "A Raspberry Pi 3B+ edge installation settles below 100 MB RSS before the lazily loaded embedding model is used."
  - "The built-in embedding provider honors the configured model and dimensions and defaults new and legacy-default installs to Xenova/all-MiniLM-L6-v2 at 384 dimensions."
  - "One query embedding completes in low single-digit seconds on a Raspberry Pi 3B+ using the native ONNX Runtime ARM64 backend."
  - "The edge profile avoids recursive native file watchers, eagerly loaded visualization libraries, and startup embedding inference."
  - "The edge install and measurement procedure is documented and repeatable."
scope_boundary: "Defines the supported source-runtime edge profile for 64-bit Linux ARM. The self-contained compiled binary remains the standard install and may retain embedded release assets."
draft_quality: "implementation contract"
---

# Constrained ARM Edge Runtime Profile

The minimum edge target is a Raspberry Pi 3B+ running a 64-bit Linux userspace. The `edge` profile is an explicit resource contract, not an automatic hardware guess. Operators select it with `runtime.profile: edge` in `agent.yaml` or the `SIGNET_RUNTIME_PROFILE=edge` environment variable.

The edge distribution runs the daemon from the source/Bun runtime tree. It does not use the self-contained compiled executable because that artifact intentionally embeds dashboard, connector, template, skill, worker, and WebAssembly release assets. Keeping the standard binary self-contained and keeping those bytes out of the constrained process are separate packaging contracts.

## Runtime behavior

- Native embeddings default to `Xenova/all-MiniLM-L6-v2` with 384 dimensions. The daemon passes the configured model and dimensions to the embedding worker instead of using hidden constants.
- Existing configs using the exact old native default migrate once to MiniLM. Custom models, non-native providers, and custom dimensions are preserved. Existing source memories are not deleted; the embedding tracker re-embeds model/dimension mismatches.
- Source-mode Transformers.js selects `onnxruntime-node`; its published package includes Linux ARM64 native bindings. Inference remains isolated in the existing worker thread.
- The edge daemon does not probe or load the native model during startup. First embedding use loads it in a process-isolated worker host. Thirty seconds after the last native embedding request, that process is terminated so the operating system reclaims its model/runtime memory.
- The cl100k tokenizer vocabulary and inference/OAuth provider catalogs initialize on first use rather than during daemon module evaluation.
- Workspace change detection polls the fixed canonical configuration/identity files every 30 seconds. It does not instantiate Chokidar or recursively watch the agent tree.
- UMAP and Louvain modules load only when their visualization/repair endpoints are invoked.
- Idle synthesis and extraction helper threads are not pre-spawned; the edge profile uses the existing in-process/on-demand paths while preserving pipeline semantics.

The standard profile retains Chokidar, the startup provider probe, and a five-minute native embedding idle window.

## Acceptance measurement

The supported procedure in `docs/EDGE.md` is the release gate:

1. Use a Raspberry Pi 3B+ with a 64-bit Linux userspace and no swap activity.
2. Start the source runtime with the edge profile and wait 60 seconds without calling an embedding endpoint.
3. Record daemon RSS from `/proc/<pid>/status`; it must be below 100 MB.
4. Run one warm query embedding and record wall time; it must complete in fewer than five seconds.
5. Wait for the 30-second unload window and verify RSS returns below 100 MB.

Measurements must name the Signet version, OS image, architecture, Bun version, and whether the model cache was warm. Results from another machine may inform development but do not substitute for the Pi 3B+ release gate.
