---
name: dreaming
description: "Maintain Signet's living ontology and memory substrate from transcripts, memory artifacts, source artifacts, notes, summaries, and imported records."
version: 1.0.0
builtin: true
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

Apply first with provenance is the blanket rule for dreaming and ordinary graph
maintenance. High-confidence, authorized maintenance should use audited
operation handlers that apply directly and preserve evidence, source pointers,
actor, confidence, and version history. Pending proposals are only for massive
knowledge-graph refactors, risky/destructive changes, or cases where the
operator explicitly asks for review before mutation.

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
- source-attributed epistemic assertions
- applied operation, version, merge, and proposal history
- existing entities, aspects, groups, claims, attributes, and links
- knowledge graph hygiene reports
- retrieval failures or feedback when available
- recent dreaming pass logs when available

Useful commands:

```bash
signet ontology pipeline explain --json
signet knowledge objects --json
signet ontology assertions --limit 50 --json
signet ontology proposals --status pending --json
signet ontology proposals --status applied --limit 50 --json
signet ontology proposals --status rejected --limit 50 --json
signet knowledge hygiene --json
signet dream status
```

## Outputs

Produce the artifacts needed to complete the maintenance pass:

- applied ontology operations or an operation stream for the daemon control
  plane
- epistemic assertions for source-attributed claims that should not be
  collapsed into current truth
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
{"operation":"set_claim_value","payload":{"entity":"Signet","aspect":"architecture","group_key":"ontology","claim_key":"mutation_policy","value":"Dreaming and normal graph maintenance apply first through audited operations with provenance."},"reason":"Consolidated from cited transcript evidence.","evidence":[{"source_kind":"transcript","source_id":"session-key","quote":"..."}]}
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

Use epistemic assertions when the source says who claimed, believed, observed,
decided, preferred, denied, or questioned something. Assertions preserve
attribution; they do not automatically make the asserted content current truth.

```bash
signet ontology assertion create \
  --entity "Signet" \
  --predicate claims \
  --speaker "Nicholai" \
  --asserted-at "2026-05-16T19:36:00.000Z" \
  --content "Signet should model who believes what over time." \
  --confidence 0.91 \
  --source-kind transcript \
  --source-id session-key
```

When bulk importing, use `signet ontology assertion import --file assertions.json`
with this shape:

```json
{
  "assertions": [
    {
      "entity": "Signet",
      "predicate": "believes",
      "content": "Signet should model who believes what over time.",
      "speaker": "Nicholai",
      "asserted_at": "2026-05-16T19:36:00.000Z",
      "confidence": 0.91,
      "evidence": [{ "source_kind": "transcript", "source_id": "session-key", "quote": "who believes what" }]
    }
  ]
}
```

Use audited entity merges for clear duplicate cleanup:

```bash
signet ontology entity merge "Canonical Entity" "Duplicate Entity" \
  --reason "Same source-backed entity after canonicalization" \
  --evidence-file evidence.json \
  --json
```

Use `merge-plan` to inspect impact or prepare a large graph refactor proposal:

```bash
signet ontology entity merge-plan "Canonical Entity" "Duplicate Entity" --json
signet ontology entity merge-plan "Canonical Entity" "Duplicate Entity" --propose --json
```

For large ingests, split work into coherent batches. Prefer fewer,
high-confidence changes with direct evidence quotes over broad speculative
coverage.

## Routing Rules

- Source-backed graph facts -> ontology operations through the control plane.
- Attributed claims, beliefs, observations, decisions, preferences, denials,
  and questions -> epistemic assertions through `signet ontology assertion`.
- Entity, aspect, group, claim, attribute, and link updates -> ontology
  operations.
- Clear duplicate entity cleanup -> audited `signet ontology entity merge`.
- Massive graph refactors or risky merge campaigns -> `merge-plan --propose` or
  explicit proposal imports.
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
relationship, route it to the ontology. If the source says that a named actor
believed, claimed, decided, denied, or questioned something, preserve that as an
epistemic assertion first; only promote it to an ontology claim when the
evidence supports treating it as current truth. If it teaches a behavioral
preference or operating rule, route it to identity/AGENTS/skill patch proposals
instead.

## Ingestion Workflow

1. Inspect graph mutation state and existing ontology shape.
2. Read the requested transcript/artifact/source window.
3. Extract concrete semantic objects and stable facts.
4. Reconcile against existing entities, aspects, groups, claims, and pending
   proposals.
5. Capture attributed claims and beliefs as epistemic assertions before
   deciding whether they should become current ontology claims.
6. Apply straightforward, authorized maintenance through the control plane with
   evidence and actor provenance.
7. Use dry-run for selector validation or risky/destructive operations; use
   pending proposals only for massive graph refactors or when review is
   explicitly requested.
8. Save source-backed memory artifacts for durable recall when the pass learns
   something useful that is not already represented in the graph.
9. Keep a dreaming log with source ranges, changes, rejected candidates, and
   open questions.

When source volume is large, process in chunks and keep a dreaming log that
records source ranges, skipped inputs, rejected candidates, and open questions.

## Control-Plane Commands

Apply exact, authorized operations:

```bash
signet ontology stream apply ops.jsonl --json
```

Write proposals only for massive graph refactors or explicit review queues:

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
- Do not treat bulk ingestion as permission to apply low-confidence, ambiguous,
  destructive, or authority-changing mutations without review.
- Do not flatten "X said/believes/denies Y" into "Y is true"; use an epistemic
  assertion unless current-truth evidence is explicit.
- Do not create pending proposals for normal dreaming or graph maintenance when
  an audited apply-first operation is available.

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
visible as applied operations.
