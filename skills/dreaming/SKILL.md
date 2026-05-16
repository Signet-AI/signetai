---
name: dreaming
description: "Ingest memory, transcript, and source artifacts into Signet's living ontology by producing evidence-backed proposal JSON/JSONL through the audited ontology control plane."
version: 1.0.0
---

# Dreaming

Use this skill when an agent should wake up, read accumulated source evidence,
and turn it into Signet ontology structure. The job is flexible bulk ingestion:
transcripts, memory artifacts, source artifacts, notes, summaries, and imported
records go in; evidence-backed ontology operations come out.

The ontology control plane is the only write path. Generated work should fill
in entities, aspects, groups, claims, attributes, and links by producing
operation JSON/JSONL for the daemon-backed CLI/API. It must not silently save
ordinary memories, rewrite source artifacts, or edit SQLite directly.

Default mode is proposal-first. Start with `--dry-run`, then write pending
proposals with `--propose` unless the operator explicitly asks for exact
operations to be applied.

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

## Output Artifacts

Produce these artifacts for the operator or harness:

- proposal JSON or JSONL using the ontology operation line shape
- a dreaming log artifact with sources examined, candidate count, rejects, and
  questions
- a short summary of high-confidence changes
- rejected candidates with reasons
- explicit questions where evidence is weak
- optional AGENTS.md, identity-file, or skill patch proposals as written
  artifacts, never as silent edits

JSONL operation line shape:

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

For large ingests, split output into reviewable batches. Prefer fewer,
high-confidence operations with direct evidence quotes over broad speculative
coverage.

## Routing Rules

- Source-backed graph facts -> ontology operation JSON/JSONL.
- Entity, aspect, group, claim, attribute, and link updates -> ontology
  operations.
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
5. Emit operation JSONL with direct evidence for each proposed mutation.
6. Dry-run the full stream and fix selector or validation errors.
7. Write pending proposals for review, or apply only if explicitly authorized.

When source volume is large, process in chunks and keep a dreaming log that
records source ranges, skipped inputs, rejected candidates, and open questions.

## Control-Plane Commands

Validate proposal JSON before asking the operator to apply it:

```bash
signet ontology stream apply proposals.jsonl --dry-run --json
```

Write proposals for review by default:

```bash
signet ontology stream apply proposals.jsonl --propose --json
signet ontology proposals --status pending --json
```

Only apply exact operator-authored operations directly when explicitly asked:

```bash
signet ontology stream apply approved-ops.jsonl --json
```

## Hard Constraints

- Do not edit SQLite directly.
- Do not instruct an agent to silently mutate ontology state from LLM output.
- Use `--dry-run` or `--propose` by default.
- Preserve evidence for every proposed mutation.
- Produce an evidence-backed mutation diff, not a vibe summary.
- Treat source memories, source artifacts, transcripts, and raw records as
  immutable provenance.
- Do not rewrite raw artifacts when ontology attributes change.
- Do not invent entities or attributes just to fill a schema. Weak evidence
  belongs in rejected candidates or open questions.
- Do not bypass `ontology_proposals` for successful graph mutations.
- Do not treat bulk ingestion as permission to apply generated changes without
  review.

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
