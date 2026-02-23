Roadmap
===

This is the public roadmap for Signet, updated manually as priorities
shift. It captures what we're actively building, what's committed next,
and what we're still thinking through. For a detailed history of what
has shipped, see CHANGELOG.md.

Status markers: `[done]` shipped, `[wip]` in progress, `[next]` planned,
`[idea]` exploring.


Current Focus (0.2.x)
---

- [wip] Procedural memory — skills as knowledge graph nodes, proactive
  skill injection into context
- [wip] Multi-agent support — multiple agent identities per daemon
  (Solvr deployment: Dot, Rose, Miles), shared skills pool, scoped memory
- [wip] Pipeline stability — memory pipeline v2 hardening, durable async
  processing, lock-safe transactions
- [wip] Daemon refactor — extract 7000 LOC daemon.ts into Hono
  sub-routers (~800 LOC coordinator)
- [wip] Server-side UMAP — dimensionality reduction moved from browser
  to daemon, pre-computed projections


Planned (0.3.x)
---

- [next] Wallet auth (ERC-8128) — blockchain-based agent identity
  verification
- [next] Codex connector — platform adapter for OpenAI Codex
- [next] Retention decay — time-based memory importance decay
- [next] Encrypted sync — end-to-end encrypted agent state
  synchronization
- [next] Agent branching — version-control-like identity branching
  and merging


Exploring
---

- [idea] Agent marketplace — discover and hire other Signet agents
- [idea] Compass connector — platform adapter for Compass IDE
- [idea] Collaborative memory — shared memory pools across agent teams
- [idea] Plugin system — extend daemon with custom pipeline stages
- [idea] Mobile companion — lightweight agent presence on mobile devices


Recently Shipped
---

- [done] 0.1.80 — Session logs scrollable and inspectable in dashboard
- [done] 0.1.77 — Handle bun:sqlite Uint8Array blobs correctly
- [done] 0.1.76 — Server-side UMAP projection, re-embed repair endpoint
- [done] 0.1.75 — Dashboard redesign with shadcn-svelte, skills.sh
  integration
- [done] 0.1.74 — Session end hook refinement
- [done] 0.1.73 — Claude Code headless LLM provider for daemon
- [done] 0.1.71 — Vec_embeddings sync on write
- [done] 0.1.70 — Unique index on embeddings.content_hash, Ollama HTTP
  API for extraction
