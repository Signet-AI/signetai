---
title: Profile the daemon
description: Capture a Bun CPU profile from a running Signet daemon.
---

Use the daemon's Bun inspector when a daemon is alive but its event loop is
blocked, CPU-bound, or otherwise needs a JavaScript CPU profile. The command
below is the canonical headless launch:

```bash
BUN_INSPECT=127.0.0.1:9229/json signet daemon start
```

`signet daemon start` keeps `127.0.0.1:9229` as the public inspector endpoint,
then gives the daemon a private Bun inspector endpoint and runs a local
discovery proxy. The proxy is what makes this work across the daemon's
systemd-run boundary and across the daemon's detached launch. It also supplies
the discovery routes that are missing from the Bun inspector in the current
runtime.

Do not use `BUN_INSPECT=127.0.0.1:9229` without `/json`. The `/json` suffix is
the endpoint form expected by Bun's inspector protocol and by the discovery
proxy.

## Verify the launch

The daemon and inspector are independent endpoints:

```bash
curl -fsS http://127.0.0.1:3850/health/live
curl -fsS http://127.0.0.1:9229/json/version
curl -fsS http://127.0.0.1:9229/json
```

The expected inspector responses are HTTP 200. `/json` returns one target with
a `webSocketDebuggerUrl` on the public inspector port. Use that URL for the
WebSocket connection. The proxy returns `/json`, `/json/list`, and
`/json/protocol`; the target Bun inspector itself may return 404 for those
routes on this runtime and only expose `/json/version`.

## Capture a CPU profile

The current Bun runtime exposes the inspector WebSocket for runtime attachment,
but it does not expose the CDP `Profiler` domain. Use Bun's built-in sampling
profiler instead. `BUN_OPTIONS` is forwarded through the Linux transient
`systemd-run --user` service boundary to the daemon child and writes a
Chrome-compatible `.cpuprofile` when the daemon exits:

```bash
profile_dir=$(mktemp -d)
BUN_OPTIONS="--cpu-prof --cpu-prof-dir=$profile_dir" \
  BUN_INSPECT=127.0.0.1:9229/json \
  signet daemon start
```

Exercise the workload, then stop the daemon cleanly so Bun can flush the
profile. The parent handoff and discovery proxy may also write small profiles;
the daemon profile is the largest file because it contains the workload:

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
also bind a public discovery proxy on that same port, so the CLI re-execs once
with the automatic inspector released. The re-exec preserves the user command
arguments, including the compiled-binary argument layout, and records the
public endpoint in `SIGNET_INSPECTOR_PUBLIC`.

On Linux, the daemon is started in a transient `systemd-run --user` unit. The
CLI forwards the private inspector endpoint as `BUN_INSPECT` through that unit
and keeps the public proxy outside the unit. This is why setting
`systemctl --user set-environment BUN_INSPECT=...` is not the canonical launch:
that manager environment is not the source environment of the already-running
CLI handoff, and service-manager delegation can drop or replace it. Put
`BUN_INSPECT` on the `signet daemon start` command itself.

The same public/private split avoids the parent-child `EADDRINUSE` failure.
The daemon owns the private Bun inspector, while the proxy owns the public
endpoint and exposes the stable discovery handshake.

## Related investigations

- [#1607](https://github.com/Signet-AI/signetai/issues/1607): reproducible daemon profiling.
- [#1534](https://github.com/Signet-AI/signetai/issues/1534): Bun inspector handshake and discovery failures.
- [#1513](https://github.com/Signet-AI/signetai/issues/1513): the startup integrity wedge that motivated the current profiling work.
