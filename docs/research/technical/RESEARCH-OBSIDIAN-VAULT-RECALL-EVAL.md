---
title: RESEARCH-OBSIDIAN-VAULT-RECALL-EVAL
question: How does Signet's current retrieval stack compare to lexical-first and chunked baselines on a curated personal vault corpus, and do those results hold across curated, dirty, and mixed corpora?
date: 2026-04-08
---

# RESEARCH-OBSIDIAN-VAULT-RECALL-EVAL

## Abstract

This memo reports two related retrieval-only comparisons over a private
Obsidian vault and a follow-up mixed-corpus robustness lane. The first
question was narrow but important: on a real personal note corpus, what
actually improves recall quality, a lexical-first search posture, plain
hybrid RAG, chunked hybrid RAG, prospective hint FTS, or semantic
retrieval over prospective hints? The second question came after live
database testing exposed how much junk can distort recall tuning: does
that answer still hold when curated notes are evaluated separately from
dirty transcript-heavy memory, and when both are mixed together?

The result is clear enough to act on. On the curated vault, Signet's
note-level hybrid retrieval materially outperformed the lexical-first
lane. A stricter chunked hybrid RAG control also failed to beat the
current note-level hybrid surface. Prospective hint FTS improved
ranking further, and semantic hint retrieval produced the strongest
overall result. In the balanced follow-up, the same hint-hybrid lane
remained best on the curated, dirty, and mixed corpora. Dirty data
still drags every strategy down, but it does not overturn the core
retrieval result. The remaining misses cluster around vague,
repetitive, diary-like notes and reflective human-memory prompts, which
suggests the next ceiling is not "better chunking" so much as better
substrate quality. The evidence points toward a combined direction:
keep the semantic machinery, keep prospective hints, and invest in a
more curated memory surface rather than retreating to a simpler
retrieval stack.

## Trigger

We wanted a fast, isolated retrieval-quality test without dragging in the
full benchmark framework. The goal was not end-to-end answer grading. The
first pass was a 1:1 retrieval-method comparison on a real curated corpus:

1. a lexical-first lane,
2. Signet's current hybrid content retrieval,
3. Signet's current hybrid retrieval plus prospective hint FTS,
4. the same stack plus semantic retrieval over prospective hints.

The test corpus was drawn read-only from a private Obsidian vault. The
vault was not modified.

A second pass became necessary after live-database testing showed how
quickly junk-heavy transcript memory can distort qualitative judgment.
That follow-up balanced curated notes against a dirty robustness lane
and a mixed lane, so we could answer the more practical product
question: what still wins when the substrate is good, bad, and partly
contaminated?

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
  - `.tmp/obsidian-recall-eval/balanced-full.json`
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

## Follow-up: balanced corpus evaluation

After the first vault-only pass, we ran a second eval to separate three
questions that were getting mixed together in live testing:

1. how strong is retrieval when the substrate is actually curated,
2. how badly does junk-heavy transcript memory degrade it,
3. which strategy still holds up when both are mixed together.

### Balanced setup

The same retrieval lanes were rerun across three corpora:

- `curated`: 391 eligible notes from the private Obsidian vault
- `dirty`: 100 sampled live-database memories biased toward transcript,
  chunk, and memory-log sludge
- `mixed`: 160 total items, 120 curated and 40 dirty

The same generated held-out queries were used for the factual retrieval
metrics. We also added two exploratory buckets for qualitative top-3
inspection:

- `soft_human`
  - `thank you`
  - `i appreciate you`
  - `im sorry`
  - `im proud of you`
- `reflective`
  - `what did we celebrate`
  - `what were we worried about`
  - `what was stressing me out`
  - `what was i excited about`

### Balanced results

#### Curated corpus

| Strategy | Hit@1 | Hit@3 | Hit@5 | MRR |
|---|---:|---:|---:|---:|
| `lexical_first_search` | 0.683 | 0.826 | 0.859 | 0.763 |
| `signet_content_hybrid` | 0.785 | 0.908 | 0.931 | 0.851 |
| `plain_chunked_rag_hybrid` | 0.775 | 0.900 | 0.926 | 0.843 |
| `signet_current_plus_hint_fts` | 0.780 | 0.910 | 0.939 | 0.853 |
| `signet_plus_hint_hybrid` | 0.808 | 0.931 | 0.946 | 0.873 |

#### Dirty corpus

| Strategy | Hit@1 | Hit@3 | Hit@5 | MRR |
|---|---:|---:|---:|---:|
| `lexical_first_search` | 0.440 | 0.520 | 0.600 | 0.516 |
| `signet_content_hybrid` | 0.450 | 0.490 | 0.580 | 0.515 |
| `plain_chunked_rag_hybrid` | 0.440 | 0.510 | 0.550 | 0.495 |
| `signet_current_plus_hint_fts` | 0.490 | 0.550 | 0.630 | 0.564 |
| `signet_plus_hint_hybrid` | 0.490 | 0.550 | 0.640 | 0.565 |

#### Mixed corpus

| Strategy | Hit@1 | Hit@3 | Hit@5 | MRR |
|---|---:|---:|---:|---:|
| `lexical_first_search` | 0.613 | 0.731 | 0.762 | 0.686 |
| `signet_content_hybrid` | 0.662 | 0.794 | 0.844 | 0.743 |
| `plain_chunked_rag_hybrid` | 0.662 | 0.750 | 0.831 | 0.733 |
| `signet_current_plus_hint_fts` | 0.662 | 0.794 | 0.869 | 0.751 |
| `signet_plus_hint_hybrid` | 0.706 | 0.812 | 0.875 | 0.781 |

### Balanced findings

#### 1. The strongest lane stayed the same across all three corpora

`signet_plus_hint_hybrid` remained the best-performing strategy on the
curated, dirty, and mixed corpora. That matters because it tells us the
first vault-only result was not a fluke of a clean dataset. Dirty data
does hurt everything, but it does not change which retrieval structure
works best.

#### 2. Curated data is still the right primary tuning surface

The curated lane is where the system shows its real headroom. All
strategies look much better there, and the relative gaps are the most
informative. The dirty lane is useful as a robustness check, but it is
not a good primary target for tuning. Optimizing mainly for the junk
corpus would risk teaching the system to survive sludge while getting
worse on the notes we actually want to recall well.

#### 3. Mixed-corpus results support balance, not overfitting

The mixed corpus is the closest approximation of real use. There, the
strongest lane still wins, and the overall ranking order remains close
to the curated lane. That means the retrieval stack is not only good on
clean notes. It still holds up when some dirty memory is mixed in. This
is the strongest evidence that the right design target is balanced:
optimize for curated recall quality first, and use dirty memory only as
a guardrail against catastrophic regression.

#### 4. Chunking still is not the missing ingredient

The balanced pass reinforces the first experiment. Plain chunked hybrid
RAG still fails to beat the current note-level hybrid surface on the
curated and mixed corpora. Better chunk boundaries may help some future
use cases, but chunking by itself is not the thing that fixes recall.

## Exploratory bucket review

The exploratory buckets are not formal scored benchmarks. They exist to
show what the top of the ranking *feels* like for human-shaped queries
that matter in real use but are easy to average away in a bulk metric.

### Soft human queries

On the curated corpus, the `soft_human` bucket looked broadly sane.
Queries such as `thank you`, `i appreciate you`, `im sorry`, and
`im proud of you` pulled up letters, people notes, and fleeting notes
that at least fit the emotional shape of the prompt. They were not all
perfect, but they felt like human memory surfaces rather than tool
noise.

On the dirty corpus, the same bucket was almost entirely sludge. The top
hits were dominated by transcript fragments, PR instructions, build
commands, and generic memory-log debris. That confirms the live-database
feeling we saw manually: the issue there is not just retrieval quality,
it is substrate quality.

On the mixed corpus, the `soft_human` bucket largely stayed on the
curated side. That is an encouraging result. Queries like `thank you`
and `im proud of you` still surfaced letters and fleeting notes instead
of getting hijacked by dirty transcript rows. In other words, the mixed
lane shows contamination pressure, but not enough to erase the human
shape of the result set for these prompts.

### Reflective queries

The reflective bucket is where the next real weakness shows up. On the
curated corpus, prompts like `what did we celebrate` and `what were we
worried about` produced plausibly related notes, but they were often
broad people notes or thematic notes rather than obviously sharp direct
answers. That suggests a substrate/query-shaping problem more than a
search-stack problem. The model is surfacing the right neighborhood, but
not necessarily the best distilled entry.

On the dirty corpus, reflective queries collapsed into transcript noise
and unrelated procedural chunks. This corpus is simply not shaped well
for reflective recall.

On the mixed corpus, reflective prompts were the first place where dirty
contamination clearly reappeared. Most of the top results stayed
curated, but `what were we worried about` still pulled a dirty openclaw
chunk into the top three. That is a useful signal. It means the mixed
lane is healthy enough to preserve curated performance on soft-human
queries, but reflective/theme-based recall is still porous when dirty
memory slips in.

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
