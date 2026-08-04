Vision
======

This document describes what Signet is, what it isn't, and where it's going. This is written for two audiences. People evaluating Signet today, and people who want to know what we are actually building toward. 

Project overview and developer docs: [`README.md`](README.md)
Near-term priorities: [`ROADMAP.md`](ROADMAP.md)
Architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

---

## What Signet is today

Signet is a local-first memory and context layer built for AI agents. It preserves the raw artifacts of a person's work, transcripts, notes, documents, decisions, source clippings, all as ground truth. Then builds a semantic layer on top of that with provenance chains back to those artifacts.

Memory, system-prompts, skills, and secrets travel with the user across machines, models, and harnesses, instead of being trapped inside any one of them. 

The product is not intelligence, it's portability and durability. LLMs continue to get smarter on their own, but what they cannot do for themselves is carry a person's context forward without flattening it. A context compacted session that drops a durable preference, a research note whose source date is lost, or a delegated action whose rationale cannot be recovered. Signet is the boring infrastructure that makes that possible. 

Three layers. Everything else is maintenance.

- **Artifacts** are ground truth. Transcripts, source notes, saved memories, imported documents. Immutable, episodic, source-backed.
- **Semantics** are cheap shortcuts derived from artifacts with provenance chains back to the artifact that justifies them. Old claims get superseded, the semantic layer is constantly being rebuilt. 
- **Query** is just the interface. Recall search, graph navigation, hooks. Nothing in the query layer is fundamentally better than reading the artifact directly. It exists to make retrieval cheap through compression. 

Maintenance runs in a dreaming loop. A pass that reads from a queue of recent artifacts and extracts what matters, mutating and extending the semantic layer, superseding what's stale and proposing small evidence-backed changes to identity/system-prompt files and skills. 

And one capability is already further along than the rest: Signet secrets. Signet gives agents measured access to credentials without ever exposing their raw values. The daemon holds them, injects them at execution time, and redacts them from everything downstream. This is the shape that the rest of this document generalizes. 

### What we ship in 2026

- a desktop app and a dashboard a non-developer can use. Alongside the headless install developers already have. 
- One memory engine: A single ingest queue with customizable interfaces for dreaming.
- Temporal claims that age gracefully, and recall that reads the full ontology.
- Benchmarks and evals as a receipt, not just a pitch. Recall quality is verified on shared eval harnesses from Supermemory with our testing methodology attached. Signet does not advertise self-invented numbers. 

## The long arc

AI is becoming the interface to a person's life. Frontier products already show what that looks like. You can connect your calendar, your files, your email, your health data, your finances, and the assistant gets dramatically more useful. Every one of those connections moves custody out of the data to the provider. So while the usefulness is real, so is the trade. 

We don't think the trade is necessary.

Signet's endgame is to become a secure personal database that sits between a person and every AI they use with the plumbing to grant measured, revocable, provenance-backed access to the data in it. Role-based access control for AI over your life, operated by you. The secret system is the proof of concept, an agent can use a credential without ever seeing it. Apply that same shape to health records, finances, private writing, relationships, the whole memory ontology and a person can get the real benefits of an AI that knows them without handing custody of their data to anyone. 

That is the direction memory points once it's solved. An agent that remembers everything about you is only acceptable if the memory is yours. Stored where you can read it, delete it, and take it elsewhere. Signet builds the memory layer first because it's the hard technical core and because every harness needs it today. The vault is what the memory layer becomes. 

What this implies, concretely, over time:

- **Measured access beyond secrets.** Scope, expire, and revoke what any agent or harness can read. Down to the claim level, the same way secrets already work for credentials. 
- **Authority artifacts for delegated action.** Intent → evidence → approval → result, reconstructable. When an agent acts for you, the record of what it was allowed to do, and why, is part of the substrate.
- **The source layer as the wedge.** One source artifact contract for vault's, repos, docs, email transcripts, and future providers. The harder version is sources as triggers, not just recall inputs. 
- **Portability as the moat.** file over app. Your context outlives every model, every harness, and every company, including this one. 

---

*Written by Nicholai and Ant. revised in August 2026 to state the endgame: measured user custody access to personal data for AI, alongside the shipped product, which remains local first memory secrets and portability. This replaces the June 2026 draft, which described the continuity layer without naming where it led. 
