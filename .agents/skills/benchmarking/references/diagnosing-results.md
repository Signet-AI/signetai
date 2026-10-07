# Diagnosing results

When a score, retrieval metric, claim count, or run time moves unexpectedly, find which stage caused it before changing anything. A wrong answer has four possible causes. Rule them out in this order:

1. **Nothing was filed**: Dreaming never recorded the fact.
2. **It was filed badly**: the fact was merged, truncated, or filed without the detail the question needs.
3. **It was not recalled**: the fact exists but recall did not rank it into the top K.
4. **The answer or judge failed**: the fact was in context, but the answer model ignored it or the judge scored it wrong.

## Step 1: compare runs

```bash
bun .agents/skills/benchmarking/scripts/run-summary.ts <good-run>=<ws> <bad-run>=<ws>
```

A large drop in claims or entities points at Dreaming. Stable claims with lower Hit@K or MRR points at recall. Stable retrieval with a lower score points at answering or judging.

## Step 2: inspect Dreaming

```bash
bun .agents/skills/benchmarking/scripts/pass-inspect.ts <workspace> --logs 10
```

Look for:

- **Passes that apply nothing**: read their pass logs. "Not filed in this pass", "deferred", or "no entity exists" for facts the model identified means the prompt let it treat doable work as blocked.
- **Failed filings**: grouped errors show systematic problems, such as mistyped `sourceRef`s, quotes with speaker labels, placeholder ids (`PLACEHOLDER`, `TEMP`, `$0`) for aspects created in the same call, or entity names the quality gate rejects.
- **Exclusion reasons**: sources excluded as "generic" that contain self-disclosures mean the exclusion rule is applied too broadly.
- **Graph by scope**: a scope with one entity and few claims means the model filed only on the user and skipped people, projects, and places.

## Step 3: check the specific miss

For each wrongly answered question, read the run's evaluation in `memorybench/data/runs/<run>/report.json` (`evaluations[].hypothesis`, `groundTruth`, `searchResults`). Then check whether the fact exists in the workspace's active claims for that question's scope (`memorybench-<containerTag>`, from the checkpoint), and whether it carries the detail the question needs.

To separate a filing miss from a ranking miss without rerunning Dreaming:

```bash
bun .agents/skills/benchmarking/scripts/recall-eval.ts --run <run> --workspace <workspace>
```

It copies the workspace, starts a daemon on the copy with Dreaming disabled, and replays each question through recall with the harness's own query builder. A gold-session rank of 0 with the fact present in claims is a ranking miss. A rank of 1 with a wrong answer means the problem is downstream of recall: check whether the recalled claim holds the needed detail before blaming the answer model.

## Worked example

On a Luna run, the question "which model kit did I start first?" failed even though recall ranked the relevant claim first. The claim read "building a Ferrari 288 GTO and a Japanese Zero, started about a month before May 29". It merged two projects into one claim and lost the Ferrari's start date. The GLM run had filed each project as its own claim with its own date. The fix was a prompt rule (one fact per claim, keeping every date, amount, count, and name), not a recall change.

## Judge errors

Read every verdict on a small smoke. If the judge passed an answer that does not contain the ground truth, report both the judged score and the honest score. Do not tune the system against judge mistakes.
