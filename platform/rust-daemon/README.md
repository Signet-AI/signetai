# Fresh Rust Signet daemon

This crate is the native runtime for the current Signet daemon. It owns the HTTP service and delegates every workspace database operation to `signet-core-native::WorkspaceOwner`; request handlers never open SQLite or execute SQL.

Build and run from the repository root:

    cargo build --manifest-path platform/rust-daemon/Cargo.toml --release
    SIGNET_PATH=/path/to/workspace SIGNET_PORT=3850 target/release/signet-daemon

The TypeScript/Bun contract test starts the compiled executable as a separate process and verifies readiness, agent scoping, durable restart behavior, mutation history, recovery, and missing-identity rejection.

This implementation was authored from the current TypeScript contracts and workspace schema. It does not depend on, link to, wrap, launch, or copy any archived Rust daemon or historical implementation.
