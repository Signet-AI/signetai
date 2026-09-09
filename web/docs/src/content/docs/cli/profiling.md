---
title: Profile the daemon
description: Compare the compiled and Bun JavaScript daemon runtimes with CPU and heap profiles.
---

Use the daemon's Bun inspector when a daemon is alive but its event loop is
blocked, CPU-bound, or otherwise needs a JavaScript CPU profile. Start from a
stopped daemon and run this single profile-enabled headless launch:

```bash
profile_dir=$(mktemp -d)
BUN_OPTIONS="--cpu-prof --cpu-prof-dir=$profile_dir" \
  SIGNET_INSPECTOR_PUBLIC=127.0.0.1:9229/json \
  signet daemon restart --no-sync --runtime=bun-js
```

`SIGNET_INSPECTOR_PUBLIC` keeps `127.0.0.1:9229` as the public inspector
endpoint, then gives the daemon a private Bun inspector endpoint and runs a
local discovery proxy. The proxy is what makes this work across the daemon's
systemd-run boundary and across the daemon's detached launch. It also supplies
the discovery routes that are missing from the Bun inspector in the current
runtime. `restart --no-sync` makes the profile-enabled invocation replace any
stale daemon without running an unrelated workspace sync.

`--runtime=bun-js` selects the production JavaScript bundle. It does not use
`src/daemon.ts` or watch mode, and it fails before launch if the bundle, worker
bundles, dashboard, skills, or external runtime dependencies are missing. Omit
`--runtime` (or pass `--runtime=compiled`) to profile the compiled daemon.

To produce source maps for the JavaScript comparison, build the daemon bundle
explicitly:

```bash
cd platform/daemon
bun run build:profile
cd ../..
bun run build:daemon-js-assets
```

The profile build emits `.map` files beside the daemon and worker bundles. Keep the
compiled and `bun-js` runs comparable: use the same commit, workspace,
configuration, model, workload, Bun version, and warm-up period.

| Metric | Measure | Keep comparable |
| --- | --- | --- |
| Startup time | Time from launch to the first successful `/health/live` response. | Use a cold process and the same workspace/configuration for each runtime. |
| RSS | Record the daemon process resident set size after the same warm-up period. | Sample at the same interval and exclude the CLI parent and inspector proxy. |
| Event-loop latency | Run the same health or dedicated latency probe while the workload is active. | Use the same request rate, timeout, and workload phase. |
| Route latency | Measure p50, p95, and p99 latency for the same API route and payload. | Reuse the same client, concurrency, database, and warm-up period. |
| CPU profile | Stop cleanly after the workload and compare the emitted `.cpuprofile` files. | Use the same profile duration and workload; compare hot stacks by symbol. |
| Heap profile | Enable Bun heap profiling and compare the emitted heap snapshots after the same workload. | Use the same allocation phase and capture point; compare retained objects, not file size alone. |

Record the raw measurements and profile filenames alongside the runtime name. A
source/watch run is a development diagnostic, not a third runtime to compare
against the production modes.

Keep the `/json` suffix. It is the endpoint form expected by Bun's inspector
protocol and by the discovery proxy.

## Verify the launch

The daemon and public inspector become ready independently. Poll the daemon's
health endpoint first, then poll all public inspector discovery endpoints. Do
not continue to the attach step until both checks succeed:

```bash
ready=0
for attempt in $(seq 1 180); do
  if curl -fsS --max-time 2 http://127.0.0.1:3850/health/live >/dev/null; then
    if curl -fsS --max-time 2 http://127.0.0.1:9229/json/version >/dev/null && \
       curl -fsS --max-time 2 http://127.0.0.1:9229/json >/dev/null && \
       curl -fsS --max-time 2 http://127.0.0.1:9229/json/list >/dev/null && \
       curl -fsS --max-time 2 http://127.0.0.1:9229/json/protocol >/dev/null; then
      ready=1
      break
    fi
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "daemon and inspector did not become ready within 180 seconds" >&2
  exit 1
fi
```

The daemon and inspector are independent endpoints:

```bash
curl -fsS http://127.0.0.1:3850/health/live
curl -fsS http://127.0.0.1:9229/json/version
curl -fsS http://127.0.0.1:9229/json
curl -fsS http://127.0.0.1:9229/json/list
curl -fsS http://127.0.0.1:9229/json/protocol
```

The expected inspector responses are HTTP 200. `/json` returns one target with
a `webSocketDebuggerUrl` on the public inspector port. Use that URL for the
WebSocket connection. The proxy returns `/json`, `/json/list`, and
`/json/protocol`; the target Bun inspector itself may return 404 for those
routes on this runtime and only expose `/json/version`.

## Capture a CPU profile

The current Bun runtime exposes the inspector WebSocket for runtime attachment,
but it does not expose the CDP `Profiler` domain. The profile-enabled launch
above uses Bun's built-in sampling profiler. `BUN_OPTIONS` is forwarded through
the Linux transient `systemd-run --user` service boundary to the daemon child
and writes a Chrome-compatible `.cpuprofile` when the daemon exits.

After the readiness and discovery checks succeed, exercise the workload, then
stop the daemon cleanly so Bun can flush the profile. The parent handoff and
discovery proxy may also write small profiles; the daemon profile is the largest
file because it contains the workload:

```bash
signet daemon stop
profile=$(find "$profile_dir" -maxdepth 1 -type f -name '*.cpuprofile' -printf '%s %p\n' \
  | sort -nr | head -1 | cut -d' ' -f2-)
test -n "$profile"
printf 'CPU profile: %s\n' "$profile"
```

If the daemon is wedged and the CLI cannot stop it, send a graceful `SIGTERM`
to the daemon PID from `.daemon/pid`. Do not use `SIGKILL` if you need Bun to
write the profile. The resulting file can be opened in Chromium-based DevTools
under the Performance panel, or imported into another CDP-compatible CPU
profile viewer. Verify that the daemon exited after the profile was flushed:

```bash
if curl -fsS --max-time 2 http://127.0.0.1:3850/health/live; then
  echo "daemon is still running"
  exit 1
fi
echo "daemon stopped and profile flushed"
```

## Why the environment and service manager matter

Bun binds `BUN_INSPECT` before application code runs. A Bun CLI process cannot
also bind a public discovery proxy on that same port. The compiled CLI's outer
process can therefore exit during the inspector handoff before `daemon start`
has a chance to report a useful error. Set the public endpoint with
`SIGNET_INSPECTOR_PUBLIC` instead. The daemon runtime then reserves a private
inspector port and starts the public discovery proxy without relying on that
outer handoff.

On Linux, the daemon is started in a transient `systemd-run --user` unit. The
CLI forwards the private inspector endpoint as `BUN_INSPECT` through that unit
and keeps the public proxy outside the unit. This is why setting
`systemctl --user set-environment BUN_INSPECT=...` is not the canonical launch:
that manager environment is not the source environment of the daemon runtime,
and service-manager delegation can drop or replace it. Put
`SIGNET_INSPECTOR_PUBLIC` on the `signet daemon restart --no-sync` command
itself.

The same public/private split avoids the parent-child `EADDRINUSE` failure.
The daemon owns the private Bun inspector, while the proxy owns the public
endpoint and exposes the stable discovery handshake.

## Related investigations

- [#1607](https://github.com/Signet-AI/signetai/issues/1607): reproducible daemon profiling.
- [#1534](https://github.com/Signet-AI/signetai/issues/1534): Bun inspector handshake and discovery failures.
- [#1513](https://github.com/Signet-AI/signetai/issues/1513): the startup integrity wedge that motivated the current profiling work.
