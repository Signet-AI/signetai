---
title: "Recall Confidence Gate"
id: recall-confidence-gate
status: complete
informed_by: []
section: "Memory"
depends_on:
  - "memory-pipeline-v2"
success_criteria:
  - "hybridRecall preserves reranker-calibrated scores instead of synthesizing from rank position"
  - "userPromptSubmit injects only memories with top score >= hooks.userPromptSubmit.minScore (default 0.8)"
  - "daemon-rs mirrors gate via term-coverage proxy (matched_terms/total_terms) until full hybrid scoring lands"
scope_boundary: "Completed targeted bug fix and config surface from PR #396. This record exists to keep the spec registry and dependency validator consistent; it does not reopen the implementation."
draft_quality: "completed bug-fix record"
---

# Recall Confidence Gate

## Summary

PR #396 fixed the prompt-submit recall confidence path so Signet no longer
synthesizes recall scores from rank position after reranking. The TypeScript
recall path preserves reranker-calibrated scores, and prompt-submit injection is
controlled by `hooks.userPromptSubmit.minScore`, defaulting to `0.8`.

The Rust daemon parity path mirrors the gate with a term-coverage proxy using
`matched_terms / total_terms` until full hybrid scoring parity lands.

## Completed Behavior

1. `hybridRecall` preserves calibrated scores from reranking instead of replacing
   them with rank-position placeholders.
2. `userPromptSubmit` injects memories only when the top score is greater than or
   equal to `hooks.userPromptSubmit.minScore`.
3. The default prompt-submit minimum score is `0.8`.
4. `daemon-rs` keeps comparable gating behavior through a term-coverage proxy.

## Follow-Up Boundary

Full Rust hybrid scoring parity is not part of this completed fix. It remains a
future parity improvement and should be tracked separately if needed.
