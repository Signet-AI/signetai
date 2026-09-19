# Fresh session/hook/event boundary

Exact registration snippets (intentionally not applied to `main.rs` or existing route modules):

```rust
// routes/mod.rs
pub(crate) mod session_hook_boundary;
// router()
.merge(session_hook_boundary::router())
```

`GET /api/boundary/poll` returns `mode: "snapshot"` and a cursor. `/events` emits one SSE snapshot plus keep-alives; it does not claim a live stream. All writes go through `WorkspaceOwner::submit_async`; handlers do not access SQL. Agent identity, workspace, recipient scoping, and bounded payloads are enforced before owner submission.
