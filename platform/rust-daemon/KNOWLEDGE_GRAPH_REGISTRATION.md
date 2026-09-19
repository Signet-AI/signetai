# Knowledge graph route registration

The existing daemon route registry must remain untouched in this slice. Merge this module at the route-registration boundary:

```rust
pub(crate) mod knowledge_graph;
// in router():
.merge(knowledge_graph::router())
```

The module is intentionally additive and uses `WorkspaceOwner` through `execute`; it does not expose SQL or bypass the owner thread.
