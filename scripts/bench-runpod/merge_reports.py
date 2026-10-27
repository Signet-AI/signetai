#!/usr/bin/env python3
"""Merge pulled shard results into one LongMemEval score and one token/cost total.
usage: merge_reports.py <run-id>...   (looks in $LME_HOME/evidence/<run>/<run>/)"""
import collections, json, os, sys

HOME = os.environ.get("LME_HOME", os.path.expanduser("~/.local/share/signet-lme"))
runs = sys.argv[1:] or sys.exit(__doc__)
tot = cor = 0
by = collections.defaultdict(lambda: [0, 0])
seen = set()
cost = hours = 0.0
sys_tok = collections.defaultdict(collections.Counter)
for r in runs:
    d = os.path.join(HOME, "evidence", r, r)
    rep = json.load(open(os.path.join(d, "memorybench", "report.json")))
    for e in rep["evaluations"]:
        if e["questionId"] in seen:
            print(f"warning: {e['questionId']} appears in more than one shard; counted once")
            continue
        seen.add(e["questionId"])
        ok = e.get("score") == 1 or e.get("label") == "correct"
        tot += 1; cor += ok
        by[e["questionType"]][0] += ok; by[e["questionType"]][1] += 1
    t = json.load(open(os.path.join(d, "tokens.json")))
    hours += t["hours"]; cost += t["hours"] * (t.get("cost_per_hr") or 0)
    for tag, a in t["per_system"].items():
        for k in ("requests", "prompt", "cached", "uncached", "completion", "reasoning"):
            sys_tok[tag][k] += a.get(k, 0)
print(f"{len(runs)} shards, {tot} questions: {cor}/{tot} = {100 * cor / max(tot, 1):.1f}%")
for qt, (c, n) in sorted(by.items()):
    print(f"  {qt:28s} {c:>3d}/{n:<3d} {100 * c / n:5.1f}%")
print(f"GPU-hours {hours:.1f}, cost ${cost:,.2f}")
for tag, a in sys_tok.items():
    hit = 100 * a["cached"] / a["prompt"] if a["prompt"] else 0
    print(f"  {tag:22s} requests {a['requests']:>9,d} prompt {a['prompt'] / 1e9:7.3f}B cached {hit:4.1f}% uncached {a['uncached'] / 1e9:7.3f}B completion {a['completion'] / 1e6:8.1f}M")
if tot != 500:
    print(f"note: {500 - tot} of 500 questions missing")
