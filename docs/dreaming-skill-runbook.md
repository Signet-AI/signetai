# Dreaming Skill Runbook

This is the first runnable proposal-first dreaming path for ontology
maintenance. It uses existing daemon-backed CLI surfaces and the built-in
`dreaming` skill instructions.

## Proposal-First Path

Inspect the current graph write gates:

```bash
signet ontology pipeline explain --json
```

Collect graph hygiene and proposal context:

```bash
signet knowledge hygiene --json > dreaming-hygiene.json
signet ontology proposals --status pending --json > dreaming-pending.json
signet ontology proposals --status applied --limit 50 --json > dreaming-applied-recent.json
signet ontology proposals --status rejected --limit 50 --json > dreaming-rejected-recent.json
signet dream status > dreaming-status.txt
```

Extract candidate proposals from a specific evidence artifact or transcript:

```bash
signet ontology extract --from transcript:<session-key> --json > dreaming-extract.json
```

Consolidate pending proposal candidates without mutation:

```bash
signet ontology consolidate --proposals pending --json > dreaming-consolidate.json
```

Convert accepted candidates into operation JSONL, keeping one object per line:

```json
{"operation":"set_claim_value","payload":{"entity":"Signet","aspect":"architecture","group_key":"ontology","claim_key":"mutation_policy","value":"Generated ontology maintenance emits proposals before graph mutation."},"reason":"Consolidated from cited transcript evidence.","evidence":[{"source_kind":"transcript","source_id":"<session-key>","quote":"..."}]}
```

Validate without writing:

```bash
signet ontology stream apply proposals.jsonl --dry-run --json
```

Write pending proposals for review:

```bash
signet ontology stream apply proposals.jsonl --propose --json
signet ontology proposals --status pending --json
```

After human/operator review, apply or reject proposals explicitly:

```bash
signet ontology apply <proposal-id> --actor operator --json
signet ontology reject <proposal-id> --reason "weak evidence" --actor operator --json
```

Inspect versioned claim evidence:

```bash
signet ontology claim versions <entity> <aspect> <group> <claim> --json
signet ontology claim show <entity> <aspect> <group> <claim> --version 1 --json
signet ontology claim-evidence <entity> <aspect> <group> <claim> --status all --json
```

## Rules

- LLM-generated dreaming output uses `--dry-run` or `--propose` by default.
- Raw memories, transcripts, and source artifacts are evidence only; do not
  rewrite them when graph claims change.
- Direct apply is reserved for exact operator-authored operations.
- Every successful mutation must pass through `ontology_proposals`.
