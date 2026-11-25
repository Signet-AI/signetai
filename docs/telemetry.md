# Telemetry

## Count populations separately

`install.ping` is sent by the npm installer before consent. `install.activated` comes from the daemon after opt-in. They measure different populations: report them side by side and never add them together.

Trap: every automated daemon boot with an opted-in config counts as an install. CI shows up as `daemon.started` with no matching `install.ping`. Workflows set `SIGNET_TELEMETRY_OPTOUT=1`, and operator-owned development checkouts set `SIGNET_TELEMETRY_ENV=dev`.

Owner: `dist/signetai/scripts/install-native.js`, `platform/daemon/src/telemetry/usage/telemetry.ts`.

## Turns and session ends are different events

`session.turn` counts persisted turns. `session.end` fires only when a session really terminates, and its token and cost totals cover the matching usage events.

Owner: `platform/daemon/src/http/hooks/hooks.ts`.

## Sent does not mean ingested

Delivery is best-effort and at least once. A successful HTTP response marks the claimed batch sent, but PostHog can drop individual invalid events and still return `200 OK`. A crash after PostHog accepts a batch but before the sent marker is written resends the batch once the ten-minute claim recovery window passes.

Owner: `surfaces/cli/src/features/telemetry.ts`, `platform/core/src/migrations/014-telemetry.ts`.
