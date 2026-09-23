# Fresh Rust Signet core owner

`signet-core-native` is a fresh owner-bound persistence library for the current Signet workspace. It opens SQLite only from its dedicated owner thread, applies additive migrations for existing databases, scopes all memory operations by agent, records durable mutation history, and exposes typed operations to the daemon.

The owner uses a bounded synchronous admission queue and explicit durable queue release. SQLite work never runs in the daemon request executor; the daemon uses `spawn_blocking` at the boundary.

The crate is intentionally independent of the archived Rust daemon. No archived modules, schema implementation, protocol, subprocess, or fallback path are used.
