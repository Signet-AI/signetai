# Rust quality baseline

The Rust daemon uses the pinned toolchain in `rust-toolchain.toml`. `rustfmt` and
Clippy are installed with that toolchain.

Run the local quality gate from the repository root:

```sh
bun run rust:quality
bun run rust:deny
```

`workspace.lints.rust.warnings = "deny"` makes compiler warnings fail builds.
Each workspace crate opts into the shared lint policy. The explicit Clippy
exceptions in the workspace manifest document pre-existing, broad refactors;
all other default Clippy diagnostics are errors. New exceptions require a
separate, scoped justification rather than weakening the baseline.

`deny.toml` defines the dependency policy used by `cargo-deny`. CI enforcement
is intentionally introduced by the follow-up quality-gates pull request.
