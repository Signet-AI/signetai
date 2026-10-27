#!/usr/bin/env python3
"""Live status for a run: phase progress, Dreaming passes, windowed vLLM rates, per-system usage, RAM, watchdog.
usage: status.py <run> [--window-min 10] [--backlog]"""
import json, os, re, sqlite3, sys, time, urllib.request

run = sys.argv[1]
win = float(sys.argv[sys.argv.index("--window-min") + 1]) if "--window-min" in sys.argv else 10
log = f"/workspace/runs/{run}.log"
txt = open(log, errors="ignore").read() if os.path.exists(log) else ""
state = "active" if os.path.exists(f"/workspace/runs/{run}.active") else (f"exited ({open(f'/workspace/runs/{run}.exit').read().strip()})" if os.path.exists(f"/workspace/runs/{run}.exit") else "unknown")
last = [l for l in txt.splitlines() if "Z] " in l][-1:]
print(f"run {run}: {state}; ingested haystacks={len(re.findall(r'Ingested \S+ for \d+ question', txt))} failed={txt.count('Failed to ingest')} write-pressure-503s={txt.count('deferred by write pressure')}")
print("last log:", last[0][:220] if last else None)

db = f"{os.environ.get('WS_ROOT', '/workspace/runs')}/{run}-ws/agents/data/signet.db"
if os.path.exists(db):
    c = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=20)
    rows = c.execute("select status,count(*),round(avg((julianday(coalesce(completed_at,datetime('now')))-julianday(started_at))*86400)) from dreaming_passes group by status").fetchall()
    print("dreaming passes (status, n, avg s):", rows)
    print("memories:", c.execute("select count(*),count(distinct agent_id) from memories where coalesce(is_deleted,0)=0").fetchone())
    if "--backlog" in sys.argv and os.path.exists(f"/workspace/runs/{run}.url"):
        url = open(f"/workspace/runs/{run}.url").read().strip()
        agents = [r[0] for r in c.execute("select distinct agent_id from session_transcripts where agent_id like 'memorybench-%'")]
        pend, n0 = 0, 0
        for a in agents:
            try:
                p = json.load(urllib.request.urlopen(f"{url}/api/dream/status?agentId={a}&measure=1", timeout=60)).get("episodicTokensPending")
                pend += p or 0; n0 += (p == 0)
            except Exception:
                pass
        orig = c.execute("select sum(length(content))/3.6 from session_transcripts where agent_id like 'memorybench-%'").fetchone()[0] or 0
        print(f"backlog: {pend:,.0f} evidence tokens pending of ~{orig:,.0f} ({100 * (1 - pend / max(orig, 1)):.0f}% consumed); agents drained {n0}/{len(agents)}")

for port, tag in ((8091, "signet-dream"), (8092, "signet-qa"), (8093, "supermemory-extract"), (8094, "supermemory-qa")):
    try:
        u = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/_proxy_stats", timeout=5))["usage"]
        if u.get("requests"):
            print(f"usage {tag:20s} req {u['requests']:>7,d} prompt {u['prompt']/1e6:8.2f}M cached {u.get('cache_hit_pct')}% completion {u['completion']/1e6:6.2f}M (since proxy start)")
    except Exception:
        pass

tel = "/workspace/telemetry/telemetry.jsonl"
if os.path.exists(tel):
    L = [json.loads(l) for l in open(tel).readlines()[-int(win * 6 + 10):]]
    W = [r for r in L if r["t"] >= time.time() - win * 60 and "error" not in r["vllm"]]
    if len(W) > 1:
        a, b = W[0], W[-1]; dt = b["t"] - a["t"]
        g = lambda k: b["vllm"].get(k, 0) - a["vllm"].get(k, 0)
        p, cch, gen = g("vllm:prompt_tokens_total"), g("vllm:prompt_tokens_cached_total"), g("vllm:generation_tokens_total")
        acc, dr = g("vllm:spec_decode_num_accepted_tokens_total"), g("vllm:spec_decode_num_draft_tokens_total")
        run_ = [r["vllm"].get("vllm:num_requests_running", 0) for r in W]
        print(f"vLLM last {dt/60:.0f}m: prompt {p/dt:,.0f}/s (cached {cch/max(p,1)*100:.0f}%, fresh {(p-cch)/dt:,.0f}/s) gen {gen/dt:,.0f}/s MTP acc {acc/max(dr,1)*100:.0f}% running avg {sum(run_)/len(run_):.1f} preempt {g('vllm:num_preemptions_total'):.0f} kv {b['vllm'].get('vllm:kv_cache_usage_perc',0):.2f}")
    r = L[-1].get("ram") or {}
    if r:
        print(f"RAM anon {r.get('anon_gb',0):.1f} GB, cgroup {r['cgroup_current_gb']:.1f}/{r['cgroup_max_gb']:.0f} GB; rss {r['rss_gb']}")
w = "/workspace/kit/state/watchdog.json"
if os.path.exists(w):
    d = json.load(open(w)); print(f"watchdog: {d} ({time.time() - d['t']:.0f}s ago)")
