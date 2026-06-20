# Phase 5 Auth Middleware Result

Option chosen: Option A — global Rust auth middleware.

Why: the TypeScript daemon mounts auth globally in `platform/daemon/src/middleware.ts:61-68`, with open-path/dashboard exceptions implemented in `platform/daemon/src/auth/middleware.ts:30-45`. Mounting the Rust middleware globally closes the `/api/os/*` gap and any future route-level omissions by default. `routes/search.rs` was also tightened so recall authenticates unconditionally before its optional LLM rate-limit branch.

TS allowlist verified:
- `platform/daemon/src/auth/middleware.ts:30-35`: `/health`, `/api/auth/login`, `/api/auth/methods`, `/api/auth/whoami`, `/api/auth/sso/*`, `/api/auth/saml/*`.
- `platform/daemon/src/auth/middleware.ts:37-45`: dashboard GET/HEAD requests outside `/api/`, `/memory/`, `/mcp`, and `/v1/`.
- `/api/status`, `/api/changelog`, `/api/readme`, `/api/roadmap`, `/api/features`, and `/api/update/check` are not in the TS auth open-path allowlist.

Validation:
- `cd platform/daemon-rs && cargo build -p signet-daemon` — passed.
- `cd platform/daemon-rs && cargo test -p signet-daemon --test contract_replay -- --ignored` — passed, 122 passed.
- `cd platform/daemon-rs && cargo test -p signet-daemon --test contract_replay -- --ignored 2>&1 | grep 'test result' | head -1` — `test result: ok. 122 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 20.96s`.

Changed files:
- `platform/daemon-rs/crates/signet-daemon/src/auth/middleware.rs`
- `platform/daemon-rs/crates/signet-daemon/src/main.rs`
- `platform/daemon-rs/crates/signet-daemon/src/routes/search.rs`
- `platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs`
- `platform/daemon-rs/parity/phase5-auth-middleware-result.md`
