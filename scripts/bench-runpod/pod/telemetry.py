#!/usr/bin/env python3
"""Sample vLLM /metrics, GPU, RAM (cgroup + per-process RSS) and Signet Dreaming status into JSONL.
usage: telemetry.py <out.jsonl> [interval_s] [daemon_url_file]"""
import json, os, re, subprocess, sys, time, urllib.request

out = sys.argv[1]
interval = float(sys.argv[2]) if len(sys.argv) > 2 else 15
daemon_file = sys.argv[3] if len(sys.argv) > 3 else None
WANT = {
    "vllm:prompt_tokens_total", "vllm:generation_tokens_total", "vllm:num_requests_running",
    "vllm:num_requests_waiting", "vllm:kv_cache_usage_perc", "vllm:gpu_cache_usage_perc",
    "vllm:spec_decode_num_accepted_tokens_total", "vllm:spec_decode_num_draft_tokens_total",
    "vllm:prefix_cache_hits_total", "vllm:prefix_cache_queries_total", "vllm:request_success_total",
    "vllm:num_preemptions_total", "vllm:prompt_tokens_cached_total",
}
PROCS = {
    "signet_daemon": r"platform/daemon/src/daemon\.ts",
    "memorybench": r"src/index\.ts run",
    "bench_launcher": r"scripts/bench-memory\.ts",
    "vllm": r"vllm serve|EngineCore|VLLM",
}


def scrape():
    try:
        txt = urllib.request.urlopen("http://127.0.0.1:8000/metrics", timeout=5).read().decode()
    except Exception as e:
        return {"error": str(e)}
    vals = {}
    for line in txt.splitlines():
        if line.startswith("#"):
            continue
        m = re.match(r"^([a-zA-Z_:]+)(\{[^}]*\})?\s+([0-9.eE+-]+)$", line)
        if m and m.group(1) in WANT:
            vals[m.group(1)] = vals.get(m.group(1), 0.0) + float(m.group(3))
    return vals


def gpu():
    try:
        o = subprocess.run(["nvidia-smi", "--query-gpu=utilization.gpu,memory.used,power.draw,temperature.gpu", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=10).stdout.strip()
        u, m, p, t = [x.strip() for x in o.split(",")]
        return {"util": float(u), "mem_mib": float(m), "power_w": float(p), "temp_c": float(t)}
    except Exception as e:
        return {"error": str(e)}


def read_int(path):
    try:
        return int(open(path).read().split()[0])
    except Exception:
        return None


def ram():
    rec = {
        "cgroup_current_gb": (read_int("/sys/fs/cgroup/memory.current") or 0) / 1e9,
        "cgroup_peak_gb": (read_int("/sys/fs/cgroup/memory.peak") or 0) / 1e9,
        "cgroup_max_gb": (read_int("/sys/fs/cgroup/memory.max") or 0) / 1e9,
    }
    v1 = "/sys/fs/cgroup/memory"
    if not rec["cgroup_current_gb"] and os.path.exists(f"{v1}/memory.usage_in_bytes"):
        rec = {"cgroup_current_gb": (read_int(f"{v1}/memory.usage_in_bytes") or 0) / 1e9,
               "cgroup_peak_gb": (read_int(f"{v1}/memory.max_usage_in_bytes") or 0) / 1e9,
               "cgroup_max_gb": (read_int(f"{v1}/memory.limit_in_bytes") or 0) / 1e9, "cgroup": "v1"}
        try:
            stat = dict(l.split()[:2] for l in open(f"{v1}/memory.stat"))
            rec["anon_gb"] = int(stat.get("total_rss", stat.get("rss", 0))) / 1e9
            rec["file_cache_gb"] = int(stat.get("total_cache", stat.get("cache", 0))) / 1e9
        except Exception:
            pass
    else:
        try:
            stat = dict(l.split()[:2] for l in open("/sys/fs/cgroup/memory.stat"))
            rec["anon_gb"] = int(stat.get("anon", 0)) / 1e9
            rec["file_cache_gb"] = int(stat.get("file", 0)) / 1e9
        except Exception:
            pass
    rss = {k: 0.0 for k in PROCS}
    counts = {k: 0 for k in PROCS}
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            cmd = open(f"/proc/{pid}/cmdline", "rb").read().replace(b"\0", b" ").decode(errors="ignore")
            if not cmd:
                continue
            for label, rx in PROCS.items():
                if re.search(rx, cmd):
                    for line in open(f"/proc/{pid}/status"):
                        if line.startswith("VmRSS:"):
                            rss[label] += int(line.split()[1]) / 1e6
                            counts[label] += 1
                    break
        except Exception:
            continue
    rec["rss_gb"] = {k: round(v, 3) for k, v in rss.items()}
    rec["proc_count"] = counts
    return rec


def daemon():
    if not daemon_file:
        return None
    try:
        url = open(daemon_file).read().strip()
        d = json.load(urllib.request.urlopen(f"{url}/api/dream/status?agentId=memorybench", timeout=10))
        w = d.get("worker") or {}
        passes = d.get("passes") or []
        return {"active": len(w.get("activePasses") or []), "running": w.get("running"),
                "completed_recent": sum(1 for p in passes if p.get("status") == "completed"),
                "failed_recent": sum(1 for p in passes if p.get("status") not in ("completed", "running"))}
    except Exception as e:
        return {"error": str(e)[:200]}


while True:
    rec = {"t": time.time(), "vllm": scrape(), "gpu": gpu(), "ram": ram(), "daemon": daemon()}
    with open(out, "a") as f:
        f.write(json.dumps(rec) + "\n")
    time.sleep(interval)

