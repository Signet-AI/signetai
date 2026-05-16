---
name: dreaming
description: "Maintain Signet's living ontology and memory substrate from transcripts, memory artifacts, source artifacts, notes, summaries, and imported records."
version: 1.0.0
---

# Dreaming

Use this skill when an agent should wake up, read accumulated source evidence,
and turn it into Signet ontology structure. The job is flexible bulk ingestion:
transcripts, memory artifacts, source artifacts, notes, summaries, and imported
records go in; the knowledge graph, scoped memories, and maintenance trail get
better.

Dreaming maintains the graph by turning source and memory artifacts into
entities, aspects, claim attributes, and links. Memory artifacts are evidence
for attributes; the ontology control plane is the audited path that applies
those attributes to the graph.

Dreaming may save memories when the evidence supports durable recall, but not by
calling the API `remember` endpoint. Save explicit source-backed memory artifacts
or use the configured source/import machinery so provenance remains inspectable.
Do not rewrite raw transcript/source artifacts or edit SQLite directly.

## Inputs

Gather enough source evidence and graph context to infer useful ontology
structure. Prefer recent transcript and memory-artifact windows first, then
expand to bulk source sets when requested.

- recent session summaries
- raw transcripts and transcript artifacts
- recently saved memory artifacts
- source artifacts
- imported notes, documents, literature, or other indexed source records
- pending ontology proposals
- applied, rejected, and failed proposal history
- existing entities, aspects, groups, claims, attributes, and links
- knowledge graph hygiene reports
- retrieval failures or feedback when available
- recent dreaming pass logs when available

Useful commands:

```bash
signet ontology pipeline explain --json
signet knowledge objects --json
signet ontology proposals --status pending --json
signet ontology proposals --status applied --limit 50 --json
signet ontology proposals --status rejected --limit 50 --json
signet knowledge hygiene --json
signet dream status
```

## Outputs

Produce the artifacts needed to complete the maintenance pass:

- applied ontology operations, pending ontology proposals, or an operation
  stream for the daemon control plane
- source-backed memory artifacts for durable recall when the evidence warrants
  saving memory
- a dreaming log artifact with sources examined, changes made or proposed,
  rejected candidates, and questions
- a short summary of high-confidence graph and memory changes
- rejected candidates with reasons
- explicit questions where evidence is weak
- optional AGENTS.md, identity-file, or skill patch proposals as written
  artifacts, never as silent edits

Ontology operation line shape when batching is useful:

```json
{"operation":"set_claim_value","payload":{"entity":"Signet","aspect":"architecture","group_key":"ontology","claim_key":"mutation_policy","value":"Generated ontology maintenance emits proposals before graph mutation."},"reason":"Consolidated from cited transcript evidence.","evidence":[{"source_kind":"transcript","source_id":"session-key","quote":"..."}]}
```

Use one JSON object per line. Good operation streams usually contain a mix of:

- `create_entity` for concrete people, organizations, projects, tools,
  documents, products, places, and events that do not already exist
- `create_aspect` for new coherent rooms of knowledge under an entity
- `set_claim_value` for attributes and constraints, preserving `group_key` and
  `claim_key` as stable slots
- `create_link` for typed relationships between concrete entities
- `archive_*` or `restore_claim_version` only when evidence is strong and the
  operator asked for maintenance, not just ingestion

For large ingests, split work into coherent batches. Prefer fewer,
high-confidence changes with direct evidence quotes over broad speculative
coverage.

## Routing Rules

- Source-backed graph facts -> ontology operations through the control plane.
- Entity, aspect, group, claim, attribute, and link updates -> ontology
  operations.
- Durable recall lessons -> source-backed memory artifacts, not the API
  `remember` endpoint.
- Behavioral lessons -> AGENTS.md or identity-file patch proposals.
- Repeated procedures -> skill patch proposals.
- Source-backed concepts -> source/literature note proposals when that source
  workflow exists.
- Permissions and authority changes -> policy/authority proposals when that
  surface exists.

Do not collapse every observation into a memory. If the source teaches stable
structure about the world, a project, a person, a system, a document, or a
relationship, route it to the ontology. If it teaches a behavioral preference
or operating rule, route it to identity/AGENTS/skill patch proposals instead.

## Ingestion Workflow

1. Inspect graph mutation state and existing ontology shape.
2. Read the requested transcript/artifact/source window.
3. Extract concrete semantic objects and stable facts.
4. Reconcile against existing entities, aspects, groups, claims, and pending
   proposals.
5. Apply straightforward, authorized maintenance through the control plane, or
   write pending proposals when review is requested or confidence is not high
   enough for direct mutation.
6. Save source-backed memory artifacts for durable recall when the pass learns
   something useful that is not already represented in the graph.
7. Keep a dreaming log with source ranges, changes, rejected candidates, and
   open questions.

When source volume is large, process in chunks and keep a dreaming log that
records source ranges, skipped inputs, rejected candidates, and open questions.

## Control-Plane Commands

Apply exact, authorized operations:

```bash
signet ontology stream apply ops.jsonl --json
```

Write proposals when review is desired:

```bash
signet ontology stream apply proposals.jsonl --propose --json
signet ontology proposals --status pending --json
```

Use dry-run only when the operator asks for validation first, or when a risky or
destructive maintenance batch needs a cheap selector check:

```bash
signet ontology stream apply ops.jsonl --dry-run --json
```

## Hard Constraints

- Do not edit SQLite directly.
- Do not instruct an agent to silently mutate ontology state from LLM output.
- Do not call `/api/memory/remember`, `/memory/remember`, or equivalent
  remember endpoints from this skill.
- Preserve evidence for every graph mutation or memory artifact.
- Produce an evidence-backed mutation diff, not a vibe summary.
- Treat source memories, source artifacts, transcripts, and raw records as
  immutable provenance.
- Do not rewrite raw artifacts when ontology attributes change.
- Do not invent entities or attributes just to fill a schema. Weak evidence
  belongs in rejected candidates or open questions.
- Do not bypass `ontology_proposals` for successful graph mutations.
- Do not treat bulk ingestion as permission to apply low-confidence, ambiguous,
  destructive, or authority-changing mutations without review.

## Review Standard

Reject a candidate instead of proposing it when:

- evidence is missing or only paraphrased
- the selector is ambiguous and no stable id is available
- the mutation would archive or replace a protected entity, aspect, group, or
  constraint without explicit operator force
- the candidate creates a generic scaffolding entity instead of a concrete
  semantic object
- it duplicates an existing pending proposal

The final dreaming log should make rejected candidates and open questions as
visible as accepted proposals.
