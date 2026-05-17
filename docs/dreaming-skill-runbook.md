# Dreaming Skill Runbook

This is the runnable dreaming path for promoting source-backed evidence into
the ontology. Raw memories, transcripts, and source artifacts remain immutable
evidence. Dreaming promotes only explicit, high-confidence statements into
current attribute slots through apply-first audited operations. In the default
non-provider path, plain
natural-language preference extraction is limited to confidence-bearing memory
rows. Memory artifacts and transcripts are still readable evidence sources, but
embedded `set_claim_value` or `claim_values` JSON is preview-only because raw
source JSON cannot self-attest confidence for direct apply. Plain prose in
artifacts or transcripts needs `--use-provider`, an explicit assertion import,
or a refactor proposal when the change is too broad to apply directly.

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

## Epistemic Assertion Path

Use epistemic assertions when the source records who claimed, believed,
observed, decided, preferred, denied, or questioned something. Assertions keep
attribution and provenance without making the assertion current ontology truth.

```bash
signet ontology assertion create \
  --entity "Signet" \
  --predicate claims \
  --speaker "Nicholai" \
  --content "Signet should preserve attributed claims separately from current truth." \
  --confidence 0.91 \
  --source-kind transcript \
  --source-id session-key
```

For batches, write `{ "assertions": [...] }` JSON and run:

```bash
signet ontology assertion import --file assertions.json --json
```

Inspect versioned claim evidence:

```bash
signet ontology claim versions <entity> <aspect> <group> <claim> --json
signet ontology claim show <entity> <aspect> <group> <claim> --version 1 --json
signet ontology claim-evidence <entity> <aspect> <group> <claim> --status all --json
```

## Entity Merge Path

Use direct audited merges for clear duplicate cleanup:

```bash
signet ontology entity merge "Canonical Entity" "Duplicate Entity" \
  --reason "Same source-backed entity after canonicalization" \
  --evidence-file evidence.json \
  --json
```

Use merge planning to inspect impact or to prepare a broad graph-refactor
proposal:

```bash
signet ontology entity merge-plan "Canonical Entity" "Duplicate Entity" --json
signet ontology entity merge-plan "Canonical Entity" "Duplicate Entity" --propose --json
```

## Refactor Proposal Path

Use pending proposals when a human wants a durable review queue for massive
knowledge-graph refactors, risky/destructive changes, or broad merge campaigns:

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
- Pending proposals are for broad graph refactors and explicit review queues,
  not the default dreaming promotion path.
- Use epistemic assertions for attributed statements that should not become
  current truth yet.
