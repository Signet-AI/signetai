# Vision

Signet is a local-first memory and context layer for AI agents. This document separates the product we are building now from the longer-term direction it enables.

- [README.md](README.md) — product and installation
- [ROADMAP.md](ROADMAP.md) — current priorities and planned direction
- [Architecture documentation](web/docs/src/content/docs/architecture.md)

## Current product

Signet preserves transcripts, notes, documents, decisions, and other source artifacts as user-owned ground truth. It builds a semantic layer over those artifacts with provenance chains back to the source.

Memory, system prompts, skills, and secrets can travel across machines, models, and harnesses. The product focuses on portability, durability, inspectability, and measured access rather than replacing model intelligence.

Its core layers are:

- **Artifacts:** source-backed records of a person's work.
- **Semantics:** derived claims and relationships that remain tied to their sources.
- **Query:** recall, graph navigation, and hooks that make context inexpensive to retrieve.

Dreaming processes recent artifacts and maintains the semantic layer. Signet Secrets provides measured credential access: the daemon holds credentials, injects them at execution time, and redacts raw values from downstream output.

The current product includes headless installation, a dashboard and desktop app, one memory engine with configurable dreaming interfaces, temporal claims, ontology-wide recall, and reproducible retrieval evaluations.

## Long-term direction

Signet is moving toward a secure personal database between people and the AI systems they use. It should let a person grant measured, revocable, provenance-backed access to personal data while keeping custody local and portable.

Over time, that direction implies:

- **Measured access beyond secrets:** Scope, expire, and revoke what an agent or harness can read, down to individual claims where practical.
- **Authority artifacts for delegated action:** Preserve intent, evidence, approval, and result so agent actions remain reconstructable.
- **A durable source layer:** Use one source-artifact contract across vaults, repositories, documents, email transcripts, and future providers.
- **Portability:** Keep context readable, deletable, and transferable beyond any model, harness, or company.

The memory layer is the technical foundation. The broader goal is user custody of the context and data that make AI useful.
