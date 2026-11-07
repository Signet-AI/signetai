#!/usr/bin/env python3
"""Token, cache and cost report for one run, split per system.

Sources (all on the pod):
  /workspace/usage/<tag>.jsonl        per-request usage from usage_proxy.py (exact, per system)
  /workspace/runs/<run>-ws/.../signet.db  Signet's own per-pass accounting (dreaming_passes)
  /workspace/telemetry/telemetry.jsonl vLLM global counters (whole GPU, all systems)
  memorybench report.json              answer/judge usage

usage: tokens.py <run> [--json] [--project 500] [--pods N]
"""
import glob, json, os, sqlite3, sys, time

run = sys.argv[1]
as_json = "--json" in sys.argv
proj_n = int(sys.argv[sys.argv.index("--project") + 1]) if "--project" in sys.argv else 500
pods = int(sys.argv[sys.argv.index("--pods") + 1]) if "--pods" in sys.argv else 1
base = os.environ.get("RUN_BASE", "/workspace")
meta_lines = [json.loads(l) for l in open(f"{base}/runs/{run}.meta") if l.strip()]
meta = meta_lines[0]
exit_f = f"{base}/runs/{run}.exit"
final_end = os.stat(exit_f).st_mtime if os.path.exists(exit_f) else time.time()
segments, open_start = [], None
for m in meta_lines:
    if "start" in m and "event" not in m:
        if open_start is not None:
            segments.append((open_start, m["start"]))
        open_start = m["start"]
    elif m.get("event") == "exit" and open_start is not None:
        segments.append((open_start, m["t"])); open_start = None
if open_start is not None:
    segments.append((open_start, max(open_start, final_end)))
start, end = segments[0][0], segments[-1][1]
in_window = lambda t: any(a <= t <= b for a, b in segments)
cost_hr = float([m for m in meta_lines if "start" in m][-1].get("cost_per_hr") or 0)
system = meta.get("system", "signet-dreaming")
own = {"signet-dreaming": ["signet-dream", "signet-qa"], "supermemory": ["supermemory-extract", "supermemory-qa"]}.get(system, [])
hours = sum(b - a for a, b in segments) / 3600
out = {"run": run, "system": system, "window_start": start, "window_end": end, "segments": len(segments), "hours": hours, "cost_per_hr": cost_hr}

usage_dir = os.environ.get("USAGE_DIR", f"{base}/usage")
tags = {}
for f in sorted(glob.glob(f"{usage_dir}/*.jsonl")):
    tag = os.path.basename(f)[:-6]
    agg = {"requests": 0, "with_usage": 0, "prompt": 0, "cached": 0, "completion": 0, "reasoning": 0, "errors": 0}
    for line in open(f):
        try:
            r = json.loads(line)
        except Exception:
            continue
        if not in_window(r["t"]):
            continue
        agg["requests"] += 1
        agg["with_usage"] += r["has_usage"]
        agg["errors"] += r["status"] >= 400
        for k in ("prompt", "cached", "completion", "reasoning"):
            agg[k] += r[k]
    if agg["requests"]:
        agg["uncached"] = agg["prompt"] - agg["cached"]
        agg["cache_hit_pct"] = round(100 * agg["cached"] / agg["prompt"], 1) if agg["prompt"] else None
        tags[tag] = agg
out["per_system"] = tags

db = glob.glob(f"{os.environ.get('WS_ROOT', base + '/runs')}/{run}-ws/agents/data/signet.db") or glob.glob(f"{base}/evidence/{run}/db_snapshot.db")
if db:
    c = sqlite3.connect(f"file:{db[0]}?mode=ro", uri=True, timeout=30)
    cols = {r[1] for r in c.execute("pragma table_info(dreaming_passes)")}
    cr = "sum(tokens_cache_read)" if "tokens_cache_read" in cols else "0"
    out["signet_passes"] = {s: {"passes": n, "input": i or 0, "output": o or 0, "cache_read": k or 0}
                            for s, n, i, o, k in c.execute(f"select status,count(*),sum(tokens_input),sum(tokens_output),{cr} from dreaming_passes group by status")}

tel = f"{base}/telemetry/telemetry.jsonl"
if os.path.exists(tel):
    keys = ["vllm:prompt_tokens_total", "vllm:prompt_tokens_cached_total", "vllm:generation_tokens_total", "vllm:num_preemptions_total"]
    tot = dict.fromkeys(keys, 0.0); prev = None; peak = {}
    for line in open(tel):
        try:
            r = json.loads(line)
        except Exception:
            continue
        if not in_window(r["t"]) or "error" in r.get("vllm", {}):
            prev = None if not in_window(r["t"]) else prev
            continue
        v = r["vllm"]
        if prev:
            for k in keys:
                d = v.get(k, 0) - prev.get(k, 0)
                tot[k] += d if d >= 0 else v.get(k, 0)
        prev = v
        for k, x in (r.get("ram") or {}).get("rss_gb", {}).items():
            peak[k] = max(peak.get(k, 0), x)
        if r.get("ram"):
            peak["anon_total"] = max(peak.get("anon_total", 0), r["ram"].get("anon_gb", 0))
    p = tot["vllm:prompt_tokens_total"]
    out["vllm_global"] = {"prompt": int(p), "cached": int(tot["vllm:prompt_tokens_cached_total"]), "generated": int(tot["vllm:generation_tokens_total"]),
                          "preemptions": int(tot["vllm:num_preemptions_total"]),
                          "cache_hit_pct": round(100 * tot["vllm:prompt_tokens_cached_total"] / p, 1) if p else None}
    out["peak_ram_gb"] = {k: round(v, 2) for k, v in peak.items()}

rep = glob.glob(f"{base}/signetai/memorybench/data/runs/{run}/report.json") or glob.glob(f"{base}/evidence/{run}/memorybench/report.json")
ck = glob.glob(f"{base}/signetai/memorybench/data/runs/{run}/checkpoint.json") or glob.glob(f"{base}/evidence/{run}/memorybench/checkpoint.json")
nq = None
if ck:
    nq = len(json.load(open(ck[0])).get("questions", {}))
if rep:
    r = json.load(open(rep[0]))
    out["score"] = r.get("summary")
    out["answer_judge_usage"] = r.get("usage")
    out["retrieved_context_tokens_per_q"] = (r.get("tokens") or {}).get("avgContextTokens")
    nq = (r.get("summary") or {}).get("totalQuestions") or nq
out["questions"] = nq

others = [t for t in tags if t not in own and tags[t]["prompt"]]
if nq and "score" in out:
    hpq = out["hours"] / nq
    out["projection"] = {"questions": proj_n, "pods": pods, "gpu_hours": round(hpq * proj_n, 1), "wall_hours": round(hpq * proj_n / pods, 1),
                         "cost": round(hpq * proj_n * cost_hr, 2) if cost_hr else None,
                         "caveat": f"GPU shared with {others} during this window; projection is an upper bound" if others else None}

if as_json:
    print(json.dumps(out, indent=1)); sys.exit()
M = lambda x: f"{x / 1e6:,.2f}M"
print(f"run {run} ({system}) {out['hours']:.2f} h in {len(segments)} segment(s), {nq} questions, ${cost_hr}/h -> ${out['hours'] * cost_hr:,.2f}")
print("\nper system (usage proxy, exact):")
print(f"  {'tag':22s} {'requests':>9s} {'prompt':>10s} {'cached':>10s} {'hit%':>6s} {'uncached':>10s} {'completion':>11s} {'reasoning':>10s}")
for t, a in tags.items():
    mark = "*" if t in own else " "
    print(f" {mark}{t:22s} {a['requests']:>9,d} {M(a['prompt']):>10s} {M(a['cached']):>10s} {str(a['cache_hit_pct']):>6s} {M(a['uncached']):>10s} {M(a['completion']):>11s} {M(a['reasoning']):>10s}" + (f"  ({a['requests'] - a['with_usage']} without usage)" if a['requests'] != a['with_usage'] else ""))
if "signet_passes" in out:
    print("\nSignet dreaming_passes (own accounting; failed passes record nothing):")
    for s, a in out["signet_passes"].items():
        print(f"  {s:10s} {a['passes']:>5d} passes  input {M(a['input'])}  output {M(a['output'])}  cache_read {M(a['cache_read'])}")
if "vllm_global" in out:
    g = out["vllm_global"]
    print(f"\nvLLM whole GPU: prompt {M(g['prompt'])} cached {g['cache_hit_pct']}% generated {M(g['generated'])} preemptions {g['preemptions']}")
    if g["prompt"]:
        cov = 100 * sum(a["prompt"] for a in tags.values()) / g["prompt"]
        out["proxy_coverage_pct"] = round(cov, 1)
        warn = "" if 95 <= cov <= 105 else "  WARNING: proxies and vLLM disagree; per-system numbers are incomplete (requests that bypass a proxy, or lost usage)"
        print(f"proxy coverage: per-system prompt tokens sum to {cov:.1f}% of vLLM's count{warn}")
    print(f"peak RAM GB: {out['peak_ram_gb']}")
if "score" in out:
    print(f"\nscore {out['score']}  retrieved context/q {out['retrieved_context_tokens_per_q']} tok")
    print(f"answer/judge usage {json.dumps(out['answer_judge_usage'])}")
if "projection" in out:
    p = out["projection"]
    print(f"\nprojection for {p['questions']} questions: {p['gpu_hours']} GPU-h, {p['wall_hours']} h wall on {p['pods']} pod(s)" + (f", ~${p['cost']:,}" if p['cost'] else "") + (f"\n  NOTE {p['caveat']}" if p['caveat'] else ""))
else:
    print("\nno projection: the run has not finished all phases (an unfinished Dreaming backlog makes hours/question look too small)")
