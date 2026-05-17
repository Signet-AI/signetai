# Dreaming Skill Runbook

This is the runnable dreaming path for promoting source-backed evidence into
the ontology. Raw memories, transcripts, and source artifacts remain immutable
evidence. Dreaming promotes only explicit, high-confidence statements into
current attribute slots.

## Attribute Promotion Path

Inspect the current graph write gates:

```bash
signet ontology pipeline explain --json
```

Preview promotions from all source evidence:

```bash
signet dream promote --from all --json
```

Preview a narrower source:

```bash
signet dream promote --from memories:recent --json
signet dream promote --from memory:<id> --json
signet dream promote --from artifact:<id> --json
signet dream promote --from transcript:<session-key> --json
```

Apply accepted explicit promotions:

```bash
signet dream promote --from all --apply --json
```

The promotion endpoint emits direct `set_claim_value` operations. That
operation updates the current value for a stable `(entity, aspect, group,
claim, kind)` slot and supersedes the older active value in place.

Low-confidence or ambiguous evidence is skipped or returned as a question. It
is not stored as a pending proposal by default.

Inspect versioned claim evidence:

```bash
signet ontology claim versions <entity> <aspect> <group> <claim> --json
signet ontology claim show <entity> <aspect> <group> <claim> --version 1 --json
signet ontology claim-evidence <entity> <aspect> <group> <claim> --status all --json
```

## Reviewable Proposal Path

Use the ontology proposal loop when a human wants a durable pending review
queue instead of direct promotion:

```bash
signet ontology extract --from transcript:<session-key> --json
signet ontology consolidate --proposals pending --json
signet ontology stream apply proposals.jsonl --propose --json
signet ontology apply <proposal-id> --actor operator --json
signet ontology reject <proposal-id> --reason "weak evidence" --actor operator --json
```

## Rules

- Dreaming promotion never rewrites raw memories, transcripts, or source
  artifacts.
- The default `signet dream promote` mode is a preview.
- `--apply` uses audited ontology operation handlers, not Pipeline V2.
- Ambiguous generated output is skipped or surfaced as a question.
- Pending proposals are optional review artifacts, not the default dreaming
  promotion path.
