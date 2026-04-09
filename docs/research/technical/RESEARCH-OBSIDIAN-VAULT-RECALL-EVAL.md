---
title: RESEARCH-OBSIDIAN-VAULT-RECALL-EVAL
question: How does Signet's current retrieval stack compare to a lexical-first search lane, and what additional value comes from prospective hint FTS and semantic hint retrieval on a real personal vault corpus?
date: 2026-04-08
---

# RESEARCH-OBSIDIAN-VAULT-RECALL-EVAL

## Abstract

This memo reports a fast retrieval-only comparison over 385 eligible
notes from a private Obsidian vault. The goal was to answer a narrow
but important question: on a messy real-world corpus, what actually
improves recall quality, a lexical-first search posture, plain hybrid
RAG, chunked hybrid RAG, prospective hint FTS, or semantic retrieval
over prospective hints?

The result is clear enough to act on. Signet's note-level hybrid
retrieval materially outperformed the lexical-first lane. A stricter
chunked hybrid RAG control also failed to beat the current note-level
hybrid surface. Prospective hint FTS improved ranking further, and
semantic hint retrieval produced the strongest overall result. The
remaining misses cluster around vague, repetitive, diary-like notes,
which suggests the next ceiling is not "better chunking" so much as
better substrate quality. The evidence points toward a combined
direction: keep the semantic machinery, keep prospective hints, and
invest in a more curated memory surface rather than retreating to a
simpler retrieval stack.

## Trigger

We wanted a fast, isolated retrieval-quality test without dragging in the
full benchmark framework. The goal was not end-to-end answer grading. The
goal was a 1:1 retrieval-method comparison on a real corpus:

1. a lexical-first lane,
2. Signet's current hybrid content retrieval,
3. Signet's current hybrid retrieval plus prospective hint FTS,
4. the same stack plus semantic retrieval over prospective hints.

The test corpus was drawn read-only from a private Obsidian vault. The
vault was not modified.

## Scope and setup

### Corpus

- Source vault: private local Obsidian workspace
- Total markdown files discovered: 513
- Eligible notes used in full-vault run: 385
- Excluded:
  - attachments / agent instruction files
  - extremely small notes
  - extremely large notes

This is a retrieval-method comparison over a raw personal vault corpus,
not a curated context-tree corpus.

### Eval harness

- Script: `scripts/obsidian_quick_recall_eval.py`
- Output artifacts:
  - `.tmp/obsidian-recall-eval/full-vault-results.json`
  - `.tmp/obsidian-recall-eval/full-vault-results-with-chunked.json`
- Cached intermediates:
  - `.tmp/obsidian-recall-eval/generated_queries.json`
  - `.tmp/obsidian-recall-eval/embeddings.json`

### Models

- Held-out query / hint generation: `gemma4:e2b`
- Embeddings: `nomic-embed-text:latest`
- Inference served through local Ollama

### Query generation

For each note, the harness generated:

- `index_hints`: two short hypothetical retrieval cues
- `eval_query`: one held-out natural-language query the note should answer

The same held-out queries were used across all retrieval lanes.

### Baseline framing

The current `signet_content_hybrid` lane should be read as the plain
"regular embeddings + FTS RAG" baseline for this experiment, but at the
note level rather than the chunk level:

- lexical search over note content
- embeddings over note content
- hybrid score fusion
- no prospective hints

That makes the current ladder:

1. lexical-first retrieval
2. plain note-level hybrid RAG
3. plain chunked hybrid RAG
4. note-level hybrid RAG plus hint FTS
5. note-level hybrid RAG plus hint FTS plus semantic hint retrieval

The chunked baseline is included because it is the cleanest "regular
embeddings + FTS RAG" control people usually expect. That lets us test
whether the current note-level retrieval surface is already doing
something meaningfully better than a more standard chunked setup.

## Retrieval lanes

### 1. `lexical_first_search`

An approximation of a lexical-first retrieval posture:

- stop-word filtering
- AND-first search, then OR fallback
- title/path boosting
- prefix matching
- light fuzzy token expansion
- lexical scoring only, no embeddings

Important: this is meant to approximate a lexical-first retrieval method,
not a full curated product surface. It does **not** recreate a curated
context-tree corpus with symbolic structure and human-authored
frontmatter.

### 2. `signet_content_hybrid`

- content FTS
- content embeddings
- hybrid score fusion

### 3. `plain_chunked_rag_hybrid`

- chunk FTS
- chunk embeddings
- hybrid score fusion
- chunk scores aggregated back to the note level

This is the stricter classic chunked-RAG control lane.

### 4. `signet_current_plus_hint_fts`

- content FTS
- content embeddings
- prospective hint FTS

This approximates Signet's current prospective-hint direction.

### 5. `signet_plus_hint_hybrid`

- content FTS
- content embeddings
- prospective hint FTS
- semantic retrieval over prospective hints

This is the experimental lane testing whether embedded hints add real
value beyond hint FTS.

## Results

Full-vault results over 385 notes:

| Strategy | Hit@1 | Hit@3 | Hit@5 | MRR |
|---|---:|---:|---:|---:|
| `lexical_first_search` | 0.6494 | 0.8052 | 0.8260 | 0.7336 |
| `signet_content_hybrid` | 0.7740 | 0.9065 | 0.9247 | 0.8425 |
| `plain_chunked_rag_hybrid` | 0.7584 | 0.8987 | 0.9143 | 0.8331 |
| `signet_current_plus_hint_fts` | 0.7818 | 0.9117 | 0.9351 | 0.8518 |
| `signet_plus_hint_hybrid` | 0.8078 | 0.9221 | 0.9429 | 0.8689 |

## Findings

### 1. Signet's hybrid retrieval clearly outperformed the lexical-first lane on this raw vault corpus

The jump from `lexical_first_search` to `signet_content_hybrid` is not
small:

- Hit@1 improves from 64.9% to 77.4%
- Hit@3 improves from 80.5% to 90.7%
- Hit@5 improves from 82.6% to 92.5%
- MRR improves from 0.7336 to 0.8425

This means semantic content retrieval is doing real work on raw personal
notes. On this corpus, lexical retrieval alone leaves too many misses on
the table.

### 2. The note-level hybrid baseline outperformed the chunked plain RAG baseline

Comparing `plain_chunked_rag_hybrid` to `signet_content_hybrid`:

- Hit@1: 0.7584 -> 0.7740
- Hit@3: 0.8987 -> 0.9065
- Hit@5: 0.9143 -> 0.9247
- MRR: 0.8331 -> 0.8425

That matters because chunking is often treated like the obvious default
RAG baseline. On this corpus, it was not enough to beat the current
note-level hybrid surface. Chunking helped over lexical-only retrieval,
but it did not outperform the existing note-level setup.

### 3. Prospective hint FTS adds real value beyond content hybrid

Comparing `signet_content_hybrid` to `signet_current_plus_hint_fts`:

- Hit@1: 0.7740 -> 0.7818
- Hit@3: 0.9065 -> 0.9117
- Hit@5: 0.9247 -> 0.9351
- MRR: 0.8425 -> 0.8518

The gain is modest but consistent. Prospective hint search improves
ranking and closes some misses that content-only hybrid retrieval does
not recover.

### 4. Semantic retrieval over hints finally showed measurable value at full-vault scale

On small samples, hint embeddings did not separate from hint FTS. On the
full-vault run, they did:

- Hit@1: 0.7818 -> 0.8078
- Hit@3: 0.9117 -> 0.9221
- Hit@5: 0.9351 -> 0.9429
- MRR: 0.8518 -> 0.8689

This is the strongest evidence from the experiment. The larger and messier
corpus finally exposed the value of semantic retrieval over hypothetical
future cues.

### 5. The remaining misses still point at substrate quality problems

The hardest failures cluster around:

- fleeting notes
- day-note style entries
- generic planning / recap language
- repetitive note semantics
- weak or broad note titles

Even the strongest lane still struggles when the underlying note surface
is vague, repetitive, or under-distilled.

That supports a two-part conclusion:

1. retrieval math matters,
2. memory substrate quality still matters.

The eval argues **for** keeping Signet's semantic machinery. It does not
argue **against** future curation work.

## Representative failure patterns

### Lexical-first miss: generic technical phrasing

Query:

- `What hardware and software are needed for the project?`

Target:

- a fleeting project meeting note

Result:

- The lexical-first lane ranked it effectively as a miss.
- The top lexical matches drifted toward unrelated technical notes.
- Content hybrid partially recovered it.
- Hint-based lanes recovered it much more effectively.

This is a clean example of the cue-trigger gap that prospective hints are
supposed to close.

### Fleeting-note ambiguity remained hard even for strong lanes

Examples such as:

- `What projects and tasks were discussed on this date?`
- `What were the main activities and thoughts recorded in the note?`
- `What were my priorities and accomplishments for yesterday?`

still produced poor ranking on some fleeting notes because the notes
share highly repetitive language and weakly discriminative titles.

This is not just a scoring problem. It is also a representation problem.

## What this does and does not prove

### What it does support

- Signet's hybrid retrieval is stronger than a lexical-first
  lane on a raw personal vault corpus.
- The current note-level hybrid surface is stronger than a plain chunked
  hybrid RAG baseline on this corpus.
- Prospective hint FTS is worthwhile.
- Semantic retrieval over prospective hints is worthwhile at larger
  corpus scale.

### What it does not prove

- That Signet is categorically better than another retrieval product.
- That a curated lexical memory substrate is inferior.
- That a full curated context-tree system would underperform on its own
  preferred substrate.

This was a retrieval-method bakeoff on a raw vault, not a full
product-architecture bakeoff on a curated context tree.

## Conclusion

The strongest conclusion from this experiment is:

> On a real raw-note corpus, Signet's current retrieval structure beats a
> lexical-first search lane, and embedded prospective hints
> improve retrieval further beyond current hint FTS.

One more conclusion is now justified too:

> A plain chunked hybrid RAG baseline did not beat the current
> note-level hybrid surface on this corpus.

A second conclusion matters just as much:

> The remaining misses still look like substrate problems, not just
> scoring problems.

In plainer language: retrieval math is saving us from a lot of mess, but
it is still dragging messy notes uphill. The right next step is not to
throw away embeddings. The right next step is to combine the stronger
retrieval stack with a more curated or distilled memory surface.

The practical takeaway is sharper than that. We do not need to guess
which direction to move. The eval already ruled out two tempting but
weaker simplifications:

- lexical-first retrieval alone is not enough for this corpus
- a plain chunked hybrid RAG baseline is not enough either

What won was not simplicity for its own sake. What won was a retrieval
stack that could bridge cue mismatch in more than one way: semantic
content retrieval, prospective hints, and semantic retrieval over those
hints. That matters because it tells us where the next architectural
shift should happen. If we want recall to feel dependable, the answer is
not to strip the system back to a smaller search method and hope cleaner
query syntax saves us. The answer is to keep the stronger retrieval
stack and give it better material to search.

So the recommendation coming out of this memo is straightforward:

1. keep hybrid retrieval,
2. keep prospective hint indexing,
3. treat semantic hint retrieval as justified, not speculative,
4. move the next round of experimentation toward curation and substrate
   quality.

That is the path most likely to produce recall that feels both sharp and
durable, not just clever on a benchmark.

## Recommended next experiments

1. **Curated-surface eval**
   - Compare raw-note retrieval against retrieval over distilled note
     summaries or curated memory artifacts.
   - Keep the same retrieval lanes so substrate quality is isolated from
     retrieval math.

2. **Bucketed analysis by note class**
   - Run separate metrics for:
     - fleeting / day-note style notes
     - people notes
     - permanent notes
     - technical / raw docs
   - This will make it easier to see where lexical retrieval collapses
     and where semantic hints pay for themselves.

3. **Harder paraphrase stress test**
   - Generate more indirect held-out queries with lower lexical overlap
     to pressure-test the hint-vector lane further.

4. **Curated + raw hybrid surface**
   - Give curated artifacts first-class ranking weight while preserving
     raw-note fallback.
   - This is the architecture most likely to combine curated-substrate
     durability with Signet's retrieval strength.
