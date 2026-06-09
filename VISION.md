Vision
======

This document describes what Signet is, what it is not, and where it is
heading.

Project overview and developer docs: [`README.md`](README.md)
Architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

---

Signet is a source-native continuity layer for AI agents. It preserves
the raw artifacts of a person's work — transcripts, notes, documents,
decisions, source clippings, code, runs — as ground truth, and builds a
semantic layer on top with provenance chains back to those artifacts.
Memory, identity, skills, and authority travel with the user across
machines, models, and harnesses instead of being trapped inside any one
of them.

The product is portability and durability, not intelligence. Models get
smarter on their own. What they cannot do for themselves is carry a
person's context forward without flattening it: a context-compacted
session that drops a durable preference, a research note whose source
date is lost, a delegated action whose rationale cannot be recovered.
Signet sells the boring infrastructure that makes that possible.

## The shape

Three layers. Everything else is maintenance.

- **Artifacts** are ground truth. Transcripts, source notes, saved
  memories, imported documents. Immutable, episodic, source-backed.
- **Semantics** are cheap shortcuts derived from artifacts, with
  provenance chains back to the artifact that justifies them. Old
  claims get superseded. The semantic layer is constantly being
  rebuilt.
- **Query** is just the interface. Recall, search, graph navigation,
  hooks. Nothing in the query layer is fundamentally better than
  reading the artifact directly; it exists to make retrieval cheap.

Maintenance runs as a dreaming loop: cron-style passes that read recent
artifacts, extract what matters, supersede what is stale, and propose
small evidence-backed changes to identity files, skills, and the
semantic layer. Continuity is not a feature that ships once. It is an
operating substrate that is maintained.

## Seams

- **Source contracts.** A single source-artifact contract for vaults,
  repos, docs, email, transcripts, and future providers. The pipeline
  upstream of the contract is the only place source-specific code lives.
- **Identity files.** `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`,
  skills, and the dreaming loop's review surface. These directly shape
  the next agent turn. Graph rows back them up; they do not replace
  them.
- **Skills.** Reviewed, portable procedural assets. They move across
  harnesses without a per-harness migration project.
- **Authority.** Permission and delegation boundaries travel with the
  agent. Actions, mutations, and identity-file patches carry provenance
  and a record of what the agent was allowed to do and why.

## Current focus

- Source-backed recall and source lifecycle.
- The dreaming loop: transcript review, identity-file proposals,
  semantic supersession, drift catches.
- Benchmarks as receipt, not pitch. Recall quality that holds up
  against LongMemEval and similar evals, with the source layer behind
  it.
- Portability across harnesses.
- Repairable memory: inspect, edit, supersede, scope, and delete bad
  context without losing provenance.

## Next directions

- Source layer as the wedge: one contract, many providers. The harder
  version is event-triggered agents — sources as triggers, not just
  recall inputs.
- Authority artifacts for delegated action: intent → evidence →
  approval → result, reconstructable.
- Converging on one recommended memory-plugin default per harness
  rather than shipping multiple parallel paths.
- Dogfooded proving grounds: founder/product OS, research/sensemaking,
  authority artifacts, team memory. Each is expressible as "use Signet
  in X to do Y, measured by Z."

## What Signet is not

This is the product-positioning list. Contribution policy — what
gets merged, how state is stored, what the daemon accepts as input —
lives in `AGENTS.md` and is not repeated here.

- Not a hosted memory API. The data lives where the user can read and
  delete it.
- Not a harness-specific plugin. The product is the layer underneath
  harnesses, not another one of them.
- Not a vector store. Vectors and graph state are derived projections.
  Artifacts are the source of truth.
- Not a summarizer. The semantic layer is a navigation aid with
  provenance. A summary that cannot lead back to the source it came
  from is a wrong answer waiting to happen.
- Not a training pipeline. Nothing leaves the user's machine. There is
  no shared base model, no federated learning, no shadow fine-tuning
  on user data. If a system claims to "learn what to remember" by
  training on your context, ask where those weights go.
- Not a vendor lock-in. Portability across tools, machines, and
  models is the product, not a feature.

This list is a charter, not a law of physics. Strong user demand and
strong technical rationale can change it.

---

*Written by Nicholai and Ant, June 2026. Replaces the February 21,
2026 draft, which framed Signet around EIP-8004 wallet identity and a
federated memory-relevance model. Both of those directions are off the
table; the current framing is local substrate, source provenance, and
harness portability.*
