# Benchmarking progress log

This is a development progress log, not a publishable benchmark claim. Run artifacts and reports remain ignored under `memorybench/data/runs/`; this document only records selected local tuning summaries so regressions can be understood later.

### 2026-04-18: structured evidence recall pass

This is a development progress log, not a publishable benchmark claim. The runs
below used small six-question LongMemEval samples while tuning the Signet
provider and daemon recall behavior.

The important change was adding structured evidence shaping to daemon recall.
Instead of collapsing every signal into one early score, recall now keeps
lexical, semantic, prospective hint, and traversal evidence separate before
reranking and dampening. Traversal-only candidates are capped below directly
anchored evidence, and hint matches can rescue class-to-instance questions such
as "music streaming service" matching a memory that says "Spotify."

| Run                                   | Setup                                                                                                    |   Accuracy | Hit@K |   MRR |  NDCG | Mean search |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------: | ----: | ----: | ----: | ----------: |
| `lme-openrouter-six-20260418T194618Z` | OpenRouter ingestion, pre-SEC recall                                                                     | 5/6, 83.3% |  100% | 0.625 | 0.734 |      761 ms |
| `lme-sec-six-20260419T0339Z`          | OpenRouter ingestion, SEC recall, warmed dev workspace                                                   |  6/6, 100% |  100% | 0.917 | 0.930 |      848 ms |
| `lme-dev-six-20260419T0818Z`          | Mercury-2 ingestion via OpenRouter, structured remember graph, Gemma 4 26B Q5 answer/judge via llama.cpp |  6/6, 100% |  100% | 0.889 | 0.873 |     1427 ms |
| `lme-secpath-six-20260419T090700Z`    | Same warmed workspace, structured path evidence added as a SEC recall channel                            |  6/6, 100% |  100% | 0.833 | 0.857 |     1042 ms |

The direct comparison is encouraging because the hit rate was already high, but
the ranking was weak. SEC improved the order of the evidence, not just whether
the answer appeared somewhere in the pile. That matters more than the one extra
correct answer: a higher MRR means the right memory is closer to the top, which
reduces how much context the answer model has to search through.

The `lme-dev-six-20260419T0818Z` run is the first small pass after separating
graph reads from background extraction graph writes and routing benchmark graph
structure through structured remember. Its graph hygiene report was clean:
0 suspicious entities, 0 duplicate canonical groups, and 0 active attributes
missing `group_key`, `claim_key`, or source memory. It did surface 8 safe
known-entity mention candidates, which is normal repair/normalization work, not
background graph authorship.

The structured graph run preserved 100% accuracy and 100% Hit@K, and it
massively improved ranking over the earlier currentness-only run (`MRR 0.889`
vs `0.458`, `NDCG 0.873` vs `0.482`). It was slightly behind the SEC-only
six-question run on aggregate ranking (`MRR 0.889` vs `0.917`, `NDCG 0.873` vs
`0.930`) because the single-session-preference question ranked the right
evidence third (`MRR 0.33`) even though the answer was judged correct. That was
the retrieval wrinkle targeted by the follow-up patch below.

The follow-up patch added structured path evidence as a SEC recall channel.
Recall now scores candidate memories against active structured graph rows using
aspect, group key, claim key, attribute kind, and attribute content, while still
requiring concrete query overlap before preference/advice boosts apply. This
fixed the first regression target: in `lme-secpath-six-20260419T090700Z`, the
single-session-preference question ranked the virtual coffee-break memory first
instead of third (`MRR 1.00`, `NDCG 1.00`).

The aggregate MRR moved from `0.889` to `0.833` in that rerun because the local
Gemma relevance pass marked the first relevant hit later for the multi-session
and single-session-user questions, even though the benchmark answer/judge score
remained 6/6. The retrieval wrinkle we targeted is fixed, but the next larger
run should watch whether this is judge noise or a real ranking tradeoff outside
the preference/advice path. The important durable TODO is that every recall
surface should eventually use the same structured-path SEC evidence, not just
the MemoryBench-facing daemon recall path.

The latency tradeoff is improving but still visible. Mean search increased from
761 ms in the pre-SEC run to 848 ms with SEC, then 1427 ms in the first
structured graph run. After the structured-path patch, the same warmed workspace
searched in 1042 ms mean with `SIGNET_BENCH_EMBEDDING_PROVIDER=ollama` set
explicitly, so the path is moving the right direction without dropping accuracy.

The same tuning pass also raised ingest concurrency for local development. With
OpenRouter Mercury extraction, question-level ingest concurrency `3` plus
per-question session concurrency `6` ingested 283 LongMemEval sessions across
six questions in about 7 minutes wall time. The extraction/remember side averaged
about 65 seconds per question. The remaining long pole was indexing wait on a
couple of questions, not extraction.

The first local-only 12-question loop used Gemma 4 E4B through vLLM for
structured ingestion and Gemma 4 26B Q5 through llama.cpp for answering and
judging. It ingested 575 LongMemEval sessions in about 31 minutes with
question-level ingest concurrency `3` and session concurrency `8`. One session
hit the local vLLM 8192-token context limit by a single token, so future local
runs should either pre-truncate extraction input or raise the local context
budget before treating larger samples as production numbers.

That first 12-question run, `lme-local-vllm12-20260419T091740Z`, scored 11/12
with `MRR 0.639`, `NDCG 0.679`, `Hit@K 83.3%`, `F1 0.418`, mean search `969 ms`,
and `2328` average answer-context tokens. The miss was not an ingestion failure:
the turbinado-sugar memory existed, but the cookie-advice query did not rank it
high enough for Gemma to use it correctly.

The follow-up local run added three narrow harness/recall corrections rather
than a memory-system rewrite. First, daemon recall now applies a small mechanical
keyword expansion for explicit baking/recipe queries, e.g. cookies can bridge to
sugar, flavor, texture, ingredients, recipes, and desserts. Second, gravity
dampening now applies to SEC/structured sources too, so structurally shaped
results without surface support do not get a free pass. Third, the Signet
MemoryBench answer prompt now tells the answering model to use remembered
preferences to give concrete personalized advice, not merely repeat the known
preference back to the user.

With those changes, `lme-local-vllm12-answerprompt-20260419T102313Z` scored
12/12 with `MRR 0.792`, `NDCG 0.816`, `Hit@K 91.7%`, `F1 0.479`, mean search
`1026 ms`, and `2246` average answer-context tokens. The cookie-advice target
moved from rank 6 to rank 1, but the answer/judge path was still too fragile:
one judge pass accepted an answer that mostly repeated the turbinado-sugar
preference instead of building on it.

The next patch fixed two harness issues exposed by that run. First,
LongMemEval already marks the answer-bearing session with
`answer_session_ids`/`has_answer`, so MemoryBench now uses those labels for
retrieval metrics when they are available instead of asking the local judge to
guess relevance from retrieved text. This is not extra context for answering;
it only makes retrieval scoring less noisy. That corrected the colleague /
virtual-coffee case: the relevant memory was already at rank 2, but the local
relevance judge had marked it as irrelevant. Second, the Signet answer prompt
now says that advice questions should treat remembered preferences as the
starting point and recommend a next step, pairing, variation, or technique that
builds on them.

The resulting run, `lme-local-vllm12-answer-refine-20260419T104059Z`, scored
12/12 with `Hit@K 100%`, `MRR 0.833`, `NDCG 0.889`, `F1 0.548`, mean search
`1026 ms`, and `2246` average answer-context tokens on the same warmed local
workspace. The local-only comparison now looks like this:

| Run                                               | Setup                                                             |     Accuracy |  Hit@K |   F1 |  MRR | NDCG | Mean search | Avg context |
| ------------------------------------------------- | ----------------------------------------------------------------- | -----------: | -----: | ---: | ---: | ---: | ----------: | ----------: |
| `lme-local-vllm12-20260419T091740Z`               | Local vLLM E4B ingest, 26B Q5 answer/judge, pre-baking/advice fix | 11/12, 91.7% |  83.3% | .418 | .639 | .679 |      969 ms |    2328 tok |
| `lme-local-vllm12-answerprompt-20260419T102313Z`  | Baking/advice recall shaping plus initial advice prompt           |  12/12, 100% |  91.7% | .479 | .792 | .816 |     1026 ms |    2246 tok |
| `lme-local-vllm12-answer-refine-20260419T104059Z` | Exact LongMemEval retrieval labels plus refined advice prompt     |  12/12, 100% | 100.0% | .548 | .833 | .889 |     1026 ms |    2246 tok |

There is still a useful caveat here: this is a warmed local development
workspace, not a publishable score. It is exactly the right fixture for tuning
recall and answer behavior without re-ingesting 575 sessions every time, but a
public number should be regenerated from a fresh isolated workspace with the
final production model choices.

The fixed 12-question canary created for autoresearch is a separate fixture, so
do not compare it directly against the random/warmed runs above. Its purpose is
to keep the same known failure cases in front of us while changing one piece at
a time. On that fixed set, the first local-only run exposed four concrete
failures: compressed recommendation details, missing count-update arithmetic,
weak temporal/currentness use, and low-confidence transcript fallbacks
outranking stronger structured evidence. The follow-up kept transcript fallback
as a bounded recall feature but capped transcript-only hits below real memory
evidence and prepended short transcript excerpts to retrieved memory rows when
`expand: true` is requested.

That pass also fixed a harness bug: LongMemEval `question_date` was loaded from
the dataset but not written into the run checkpoint, so temporal answer prompts
were saying `Question Date: Not specified` on resumed runs. That was the real
reason the Ibotta question could retrieve the right 16 April 2023 memory and
still fail to answer "3 weeks ago." The checkpoint now stores question dates on
new runs and backfills them when resuming older checkpoints.

| Fixed canary run                                         | Setup                                                                      |     Accuracy |  Hit@K |   F1 |   MRR | NDCG | Mean search | Avg context |
| -------------------------------------------------------- | -------------------------------------------------------------------------- | -----------: | -----: | ---: | ----: | ---: | ----------: | ----------: |
| `lme-canary12-vibes-20260419T163939Z`                    | Fixed 12Q local ingest, pre-transcript/date fixes                          |  8/12, 66.7% |  91.7% | .607 |  .819 | .842 |     1790 ms |    1841 tok |
| `lme-canary12-vibes-20260419T163939Z-transcript-lite`    | Bounded transcript fallback, before score cap                              | 10/12, 83.3% | 100.0% | .434 |  .579 | .670 |     1894 ms |    2450 tok |
| `lme-canary12-vibes-20260419T163939Z-transcript-capped`  | Transcript fallback capped below real memory evidence                      | 11/12, 91.7% | 100.0% | .434 |  .903 | .947 |     1924 ms |    2792 tok |
| `lme-canary12-vibes-20260419T163939Z-transcript-datefix` | Transcript cap plus checkpoint `question_date` preservation                |  12/12, 100% | 100.0% | .434 |  .903 | .947 |     1866 ms |    2792 tok |
| `lme-canary12-fresh-9503efd5-20260419T175605Z`           | Fresh local E4B ingest, 26B Q5 answer/judge, SEC path rank + metric fixes  |  12/12, 100% | 100.0% | .420 | 1.000 | .982 |     1329 ms |    2815 tok |
| `lme-canary12-summary-hydration-20260420T043330Z`        | Same warmed canary after transcript fallback hydrates same-session summary |  12/12, 100% | 100.0% | .371 |  .847 | .866 |     1162 ms |    4298 tok |

The F1 drop in the fixed canary is expected from adding supplemental recall
evidence. It means more non-answer evidence is visible, not that the answer
path got worse. The important ranking metrics recovered after transcript hits
were capped: `MRR` returned from `0.579` to `0.903`, and `NDCG` from `0.670` to
`0.947`, while accuracy reached 12/12 once the missing question-date metadata
was repaired.

The fresh local canary was regenerated from an isolated workspace using Gemma 4
E4B via vLLM for ingestion and Gemma 4 26B Q5 via llama.cpp for answering and
judging. It kept 12/12 accuracy, moved every answer-bearing session to rank 1,
and lowered mean search latency by about half a second against the date-fix
canary. The last ranking wrinkle was the colleague / virtual coffee-break
question: moderate structured path evidence now has enough weight to beat
generic "thinking/suggestions" lexical noise from unrelated recommendation
sessions.

That run also exposed and fixed a retrieval-metric bug. When LongMemEval
provides `answer_session_ids`, duplicate chunks from the same answer-bearing
session must not count as multiple ideal relevant documents. Without that cap,
NDCG could exceed `1.0`, which is mathematically invalid. Retrieval scoring now
counts each labeled relevant session once, so duplicate evidence is useful for
answering but does not inflate NDCG.

The summary-hydration run reused the warmed canary workspace after a post-rebase
safety run regressed to 11/12. The miss was not a ranking miss: both relevant
sessions were retrieved, but the transcript fallback excerpt for the Wednesday
yoga session started too late and omitted the exact schedule fact. The daemon
now hydrates transcript-only fallback hits with the same-session structured
memory summary when one exists. That let the answerer combine
Tuesday/Thursday Zumba, Wednesday yoga, and Saturday weightlifting into the
correct four-day answer without changing the underlying ingested data.

## Merge story and surface parity plan

The merge story for this PR is intentionally narrow: land the MemoryBench
integration, isolated benchmark daemon workflow, structured remember path,
currentness/supersession fixes, SEC recall shaping, transcript fallback, and
benchmark documentation as one coherent benchmark foundation. Do not turn this
branch into the PR where every harness learns every new memory behavior. The
daemon is the source of truth for recall semantics; harnesses should be plumbing
and presentation, not separate recall engines.

The follow-up should be a smaller recall-surface parity PR. Its contract should
be simple: `/api/memory/recall` is the canonical recall engine,
`/api/hooks/user-prompt-submit` uses the same engine with a tighter auto-inject
budget, `/api/memory/remember` is the canonical structured remember entrypoint,
and knowledge graph navigation is exposed through explicit daemon/CLI/MCP tools
instead of hidden benchmark-only behavior. The parity PR should include a small
contract test proving CLI, MCP, SDK, hook recall, and harness recall all consume
the daemon recall path rather than reimplementing structured evidence, SEC
ranking, currentness annotations, or transcript fallback locally.

For the CLI and MCP surfaces, the graph should be navigable in the same mental
model agents and humans use when browsing a filesystem or rooms in a house:
entity, aspect, group, claim, attribute. `knowledge_expand` can stay as the
"whole card" view, but agents also need narrow list/get tools so they can scan
large graphs without requesting a giant blob. The target shape is:

```text
entity.list()
entity.get("Nicholai")
entity.aspects("Nicholai")
entity.groups("Nicholai", "food")
entity.claims("Nicholai", "food", "restaurants")
entity.attributes("Nicholai", "food", "restaurants", "favorite_restaurant")
```

For harnesses, the audit is mostly about preserving daemon output faithfully.
OpenClaw, OpenCode, Pi/Oh-My-Pi, Hermes, the browser extension, and SDK clients
should preserve enough metadata to debug recall: result source, source session,
supplementary status, structured/SEC/transcript origin, currentness annotations,
and expanded sources when requested. They should not decide their own ranking or
graph traversal rules. Explicit recall and benchmarks can opt into
`expand: true`; automatic prompt injection should stay tighter and use transcript
evidence as bounded rescue when structured recall is empty or anchor terms are
missing. That keeps prompts useful without turning every turn into transcript
soup.

After this PR merges, run one fresh clean benchmark from an isolated workspace
with the final production model choices before publishing any score. Warmed
workspace runs are for development ratcheting; fresh isolated runs are the only
credible public numbers.

The first unattended autoresearch loop after that canary reused a fresh local
12-question workspace, then copied the checkpoint from search forward to test
recall-side changes without re-ingesting. The first report looked better than
it really was: two temporal questions produced empty local-model answers and
were omitted from the denominator, leaving a misleading `9/10`. The harness now
records an explicit `I don't know.` when the answer model returns empty output,
so every selected question remains in the score denominator.

The same run exposed two recall-side issues. First, transcript excerpts were
choosing the first weak lexical hit, such as an assistant later saying "ask Mark
and Sarah", instead of the densest window containing the user’s actual temporal
fact, "I met Mark and Sarah on a beach trip about a month ago." Second, relative
temporal search questions such as "four weeks ago" were sent to recall without
the provided LongMemEval question date, so recall could not mechanically search
for the resolved date. The fix was intentionally small: transcript fallback now
scores candidate windows by query-term density, quantity/temporal hints, and
simple verb variants like `meet`/`met`; the Signet provider now appends absolute
date hints for relative search phrases using the benchmark-provided question
date.

| Random local 12Q run                                                | Setup                                                                       |     Accuracy |  Hit@K |   F1 |  MRR | NDCG | Mean search | Avg context |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------- | -----------: | -----: | ---: | ---: | ---: | ----------: | ----------: |
| `lme-local-explore12-20260419T190341Z`                              | Fresh local E4B ingest, before denominator/transcript/date-hint fixes       |  9/10, 90.0% | 100.0% | .438 | .900 | .911 |     1236 ms |    2751 tok |
| `lme-local-explore12-20260419T190341Z-dense-transcript-20260419...` | Same data, dense transcript selection plus explicit empty-answer abstention | 10/12, 83.3% | 100.0% | .416 | .854 | .864 |      504 ms |    2780 tok |
| `lme-local-explore12-20260419T190341Z-temporal-search-20260419...`  | Same data, dense transcript selection plus relative-date search hints       |  12/12, 100% | 100.0% | .423 | .875 | .890 |      579 ms |    3046 tok |

The later `lme-local-explore12-20260419T202440Z` workspace is another random
12-question fixture, not a direct continuation of the `190341Z` fixture. It
looked like a regression because the previous random slice had recovered to
12/12, but the right comparison is within the same ingested data source. That
fixture exposed a different skeleton: the structured graph contained the answer
facts, but daemon recall was not surfacing those structured rows as first-class
candidates.

In the baseline run, both `single-session-user` questions missed retrieval
entirely. Direct database inspection showed the structured attributes were
there, for example a `music_preferences / listening_habits / recent_platform`
claim saying the user had been listening to songs on Spotify lately, and a
`personal_preferences / shampoo_preferences / preferred_shampoo_scent_and_source`
claim saying the user liked lavender shampoo from Trader Joe's. The failure was
not extraction. It was candidate shaping: traversal-primary recall could spend
the flat candidate budget before structured candidates ever reached SEC ranking.
That meant the thing we saved into the graph was visible to the database, but
not reliably visible to recall.

The first structured-candidate patch proved the diagnosis but did not fix the
path. It searched active structured attributes generically, but those candidates
were still reduced to a small additive boost behind unrelated vector neighbors.
It also briefly included a too-specific `spotify` query expansion while
debugging. That expansion did not improve the run, and it has been removed
because provider-side bridges may connect generic vocabulary, e.g. `music` to
`song` or `playlist`, but must not include answer-specific product names. The
fairness rule is simple: if the LongMemEval data were swapped out, the same
generic structure and query bridges should still make sense.

The follow-up patch makes structured rows a real recall surface. Daemon recall
now searches active `entity_attributes` through entity, aspect, group key, claim
key, attribute kind, and content; merges those memory ids into the SEC candidate
pool before flat candidate trimming; and lets strong structured path evidence
stand on its own instead of being only a tiny bonus on top of embedding score.
That recovered both `single-session-user` questions on the same warmed fixture
without hardcoded answer terms. The remaining miss had the answer-bearing
session in the retrieved set, so the next issue is answer/context handling, not
missing graph recall.

| Random local 12Q run, second fixture                             | Setup                                                                 |     Accuracy |  Hit@K |   F1 |  MRR | NDCG | Mean search | Avg context |
| ---------------------------------------------------------------- | --------------------------------------------------------------------- | -----------: | -----: | ---: | ---: | ---: | ----------: | ----------: |
| `lme-local-explore12-20260419T202440Z`                           | Fresh local E4B ingest, before structured candidates were surfaced    |  9/12, 75.0% |  83.3% | .330 | .708 | .727 |      451 ms |    3219 tok |
| `lme-local-explore12-20260419T202440Z-structured-candidates-...` | Same data, initial attribute search, candidates still lost before SEC | 10/12, 83.3% |  83.3% | .330 | .708 | .727 |      451 ms |    3182 tok |
| `lme-local-explore12-20260419T202440Z-structured-fused-...`      | Same data, structured rows merged into SEC pool, 16k local answer ctx | 11/12, 91.7% | 100.0% | .329 | .833 | .843 |      449 ms |    4449 tok |

This is the regression story in plain terms: the graph work was helping only
when the right memory also survived ordinary candidate selection. Once a random
slice asked for facts whose strongest evidence lived in `aspect/group/claim`
shape rather than obvious lexical text, recall dropped them. The fix is not to
make extraction more clever or add benchmark-specific names. The fix is to make
recall use the structure it was already being given. That raised Hit@K from
83.3% to 100% on the same fixture while keeping mean search basically flat. The
cost is context size: average answer context rose to 4449 tokens, so the next
tuning pass should reduce duplicate/noisy context now that the right structured
evidence is actually entering the pool. The remaining failed question was an
advice-style recommendation prompt where the relevant healthcare-AI publication
preference was retrieved at rank 2 (`MRR 0.50` for that question), but the answer
model also used unrelated retrieved context about nanotechnology and robotics.
That is now an answer/context shaping problem, not a missing structured recall
problem.

The `9/10` row should not be read as a better score than the `10/12` row. It is
the opposite: the denominator bug hid two temporal failures. Once every question
was counted, the remaining misses were exactly the kind of temporal recall
failures we wanted the loop to surface. The final row fixed both temporal
questions without changing ingestion or adding hidden answer context. The
retrieval metrics remain lower than the fixed canary because this random set has
harder temporal/noisy-neighbor cases, but answer accuracy recovered to 12/12 and
the run now reports all selected questions cleanly.
