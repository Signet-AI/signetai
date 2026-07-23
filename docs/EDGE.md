# Edge installation

Signet's edge profile supports constrained 64-bit ARM Linux devices, with the Raspberry Pi 3B+ as the minimum target. It uses the Bun/source daemon so self-contained native-binary assets are not mapped into the idle process.

## Install

Use a 64-bit Raspberry Pi OS image, install Git and Bun, then:

```bash
git clone https://github.com/Signet-AI/signetai.git
cd signetai
bun install --frozen-lockfile
bun run --filter '@signet/core' build
bun surfaces/cli/src/cli.ts setup
```

Add the profile to `~/.agents/agent.yaml`:

```yaml
runtime:
  profile: edge

embedding:
  provider: native
  model: Xenova/all-MiniLM-L6-v2
  dimensions: 384
```

Start the source runtime:

```bash
bun surfaces/cli/src/cli.ts daemon start
```

Do not replace that command with the globally installed self-contained `signet` binary on the constrained path. The standard binary prioritizes portability and offline assets; the source edge path prioritizes idle RSS. `SIGNET_RUNTIME_PROFILE=edge` is available as a temporary override.

## What the profile changes

- Uses a fixed-file 30-second poller instead of Chokidar/recursive watches.
- Leaves the native embedding model unloaded until first use.
- Runs native embeddings in a child process and terminates it after 30 seconds
  idle, allowing the OS to reclaim model and ONNX Runtime RSS completely.
- Loads the cl100k tokenizer and inference/OAuth catalogs only when a request
  needs them.
- Loads UMAP and Louvain only when their endpoints are called.
- Avoids pre-spawning the synthesis renderer and threaded extraction helper while idle.
- Uses the configured native model/dimensions; the default is the 384-dimensional MiniLM ONNX model.

The full memory pipeline remains available. Disable optional pipeline features in `agent.yaml` only if your workload does not need them; the edge profile does not silently change memory semantics.

## Verify the Pi target

After startup, wait 60 seconds without opening the embeddings status page, then find the daemon PID:

```bash
cat ~/.agents/.daemon/pid
```

Read RSS:

```bash
bun scripts/check-edge-runtime.ts
```

The idle result must report `idleRssPass: true`. Then run the embedding gate
with a warm model cache:

```bash
bun scripts/check-edge-runtime.ts --with-embedding
```

The Pi 3B+ gate is under five seconds. The command exits non-zero when either
the 100 MB idle limit or five-second embedding limit is missed. Record the
Signet version, OS image, architecture, Bun version, cache state, idle RSS,
and elapsed time when reporting results.

After 30 seconds without another embedding request, re-check `VmRSS`; it must return below 102400 kB.

## Compatibility

Existing installs on the old built-in native default migrate to `Xenova/all-MiniLM-L6-v2`/384d once. Custom native models and external embedding providers are untouched. Stored source memories remain intact; dimension/model mismatches are re-embedded by the existing tracker.
