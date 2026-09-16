---
title: "Security and lifecycle"
description: "Configure authentication, retention, hooks, and bounded lifecycle behavior."
---

Security settings live under `auth`, retention, and lifecycle sections of `agent.yaml`. Authentication modes are `local`, `team`, and `hybrid`; choose the mode that matches the network boundary and follow [Authentication](/auth/) for credentials.

## Authentication

Use `local` for a trusted local daemon. Use `team` for authenticated clients and `hybrid` when local access remains trusted while remote requests require credentials. Set plaintext bootstrap values through a secret-safe service environment or the secret store, not YAML. API keys are issued and revoked with `signet api-key`; see [Authentication](/auth/).

The SSO and SAML settings and `/api/auth/sso/*` and `/api/auth/saml/*` routes are reserved compatibility surfaces. They are not configured login providers today.

## Lifecycle controls

Configure retention and hook behavior only in their current owning sections. Runtime workers use a configuration snapshot; apply operational changes with the restart and readiness rule on [Configuration](/configuration/). Rate limits and in-memory counters describe the current daemon lifetime.

Keep auth material, runtime state, logs, and secret storage private. Use scoped keys for remote connectors and revoke them when a client is retired. Do not expose a local-mode daemon on a shared network.

## Environment variables

Environment variables are surface-specific inputs, not a blanket override for every YAML value. Use the owning command or service documentation for variables such as `SIGNET_API_KEY`, `SIGNET_DAEMON_URL`, `SIGNET_PATH`, and `SIGNET_TELEMETRY_OPTOUT`; do not infer precedence for unrelated settings.

See [Secrets](/secrets/) for encrypted values, [Self-hosting](/self-hosting/) for deployment boundaries, and [Diagnostics](/diagnostics/) for evidence after lifecycle changes.
