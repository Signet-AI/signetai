# Forge v1.1.7

## Summary

This release fixes Forge's Signet daemon integration for authenticated daemon
modes.

Signet's daemon already supports bearer-token auth plus actor attribution
headers. Forge was still calling the daemon without those headers, which meant
it could fail against `team` mode daemons and some `hybrid` mode setups. Forge
now speaks the daemon auth contract correctly across its client and direct tool
paths.

## What's fixed

- Added bearer-token support for Forge's Signet daemon client
- Added actor attribution headers on daemon requests
- Patched direct Signet tool calls to include daemon auth headers
- Patched marketplace daemon calls to include daemon auth headers
- Documented the new Forge daemon auth options in the README

## New CLI options

- `--signet-token <token>` — pass a Signet daemon bearer token
- `--signet-actor <name>` — override the `x-signet-actor` header

## Supported environment variables

- `FORGE_SIGNET_TOKEN`
- `SIGNET_AUTH_TOKEN`
- `SIGNET_TOKEN`
- `FORGE_SIGNET_ACTOR`
- `SIGNET_ACTOR`

Forge now also sends:

- `Authorization: Bearer <token>` when configured
- `x-signet-actor`
- `x-signet-actor-type: agent`

## Validation

- `cargo check` passed after the changes
- Verified Forge still works against a local Signet daemon
- Verified Forge against a real temporary Signet daemon running in authenticated
  `team` mode with a signed token

## Notes

- Your existing local Signet setup may still work without any visible change if
  it runs in `local` mode. This release matters when Forge talks to an
  authenticated daemon.
- `cargo fmt` was not run because `rustfmt` was not installed in the active
  toolchain during packaging.
