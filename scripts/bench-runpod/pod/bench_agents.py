#!/usr/bin/env python3
"""Multi-turn agent load that mimics Dreaming against a vLLM server.

Each agent owns a distinct growing history (LongMemEval sessions). Every turn appends
~EVIDENCE_TOKENS of new evidence plus the previous reply, generates with thinking on and a
thinking budget, and restarts from a fresh history once it passes MAX_CONTEXT tokens.
Reports useful throughput (new evidence tokens absorbed per second), vLLM prompt / cached /
generation rates, preemptions, and turn latency.

usage: bench_agents.py <tag> <agents> <seconds> [base_min_tok] [base_max_tok] [max_ctx_tok]
"""
import asyncio, json, random, re, sys, time, urllib.request
import aiohttp

URL = "http://127.0.0.1:8000"
TAG, AGENTS, SECONDS = sys.argv[1], int(sys.argv[2]), float(sys.argv[3])
BASE_MIN = int(sys.argv[4]) if len(sys.argv) > 4 else 30_000
BASE_MAX = int(sys.argv[5]) if len(sys.argv) > 5 else 80_000
MAX_CTX = int(sys.argv[6]) if len(sys.argv) > 6 else 110_000
EVIDENCE_TOKENS = 2_500
CHARS_PER_TOKEN = 3.6

random.seed(hash(TAG) & 0xFFFF)
data = json.load(open("/workspace/signetai/memorybench/data/benchmarks/longmemeval/datasets/longmemeval_s_cleaned.json"))
sessions = ["\n".join(f"{m['role']}: {m['content']}" for m in s) for q in data for s in q["haystack_sessions"]]
random.shuffle(sessions)
cursor = 0


def take_chars(n: int) -> str:
    global cursor
    out, got = [], 0
    while got < n:
        s = sessions[cursor % len(sessions)]
        cursor += 1
        out.append(s)
        got += len(s)
    return "\n\n---\n\n".join(out)[:n]


SYSTEM = ("You are a memory curator. For each new transcript excerpt, extract durable facts about the user "
          "(preferences, dated events, possessions, relationships, plans). Resolve relative dates. "
          "Reply with one fact per line and nothing else.")


def metrics() -> dict:
    txt = urllib.request.urlopen(f"{URL}/metrics", timeout=10).read().decode()
    want = {"vllm:prompt_tokens_total", "vllm:prompt_tokens_cached_total", "vllm:generation_tokens_total",
            "vllm:num_preemptions_total", "vllm:kv_cache_usage_perc", "vllm:num_requests_running",
            "vllm:num_requests_waiting"}
    vals = {}
    for line in txt.splitlines():
        m = re.match(r"^([a-zA-Z_:]+)(\{[^}]*\})?\s+([0-9.eE+-]+)$", line)
        if m and m.group(1) in want:
            vals[m.group(1)] = vals.get(m.group(1), 0.0) + float(m.group(3))
    return vals


stats = {"turns": 0, "evidence_tokens": 0, "latencies": [], "errors": 0, "resets": 0, "finish_length": 0}
deadline = float("inf")
measure_from = float("inf")
warmed: set[int] = set()
all_warm = asyncio.Event()


async def agent(session: aiohttp.ClientSession, idx: int) -> None:
    await asyncio.sleep(idx * 0.25)
    while time.time() < deadline:
        history = [{"role": "system", "content": SYSTEM},
                   {"role": "user", "content": take_chars(int(random.uniform(BASE_MIN, BASE_MAX) * CHARS_PER_TOKEN))}]
        ctx = 0
        while time.time() < deadline and ctx < MAX_CTX:
            history.append({"role": "user", "content": "New excerpt:\n" + take_chars(int(EVIDENCE_TOKENS * CHARS_PER_TOKEN))})
            body = {"model": "qwen3.8-27b", "messages": history, "max_tokens": 2_000,
                    "thinking_token_budget": 1_000,
                    "chat_template_kwargs": {"enable_thinking": True, "preserve_thinking": False}}
            t0 = time.time()
            try:
                async with session.post(f"{URL}/v1/chat/completions", json=body,
                                        timeout=aiohttp.ClientTimeout(total=1_800)) as r:
                    d = await r.json()
                msg = d["choices"][0]["message"]
                ctx = d["usage"]["prompt_tokens"] + d["usage"]["completion_tokens"]
                history.append({"role": "assistant", "content": msg.get("content") or ""})
                if idx not in warmed:
                    warmed.add(idx)
                    if len(warmed) == AGENTS:
                        all_warm.set()
                if t0 >= measure_from:
                    stats["turns"] += 1
                    stats["evidence_tokens"] += EVIDENCE_TOKENS
                    stats["latencies"].append(time.time() - t0)
                    if d["choices"][0].get("finish_reason") == "length":
                        stats["finish_length"] += 1
            except Exception as e:  # noqa: BLE001
                stats["errors"] += 1
                if stats["errors"] < 4:
                    print("error", repr(e)[:200], flush=True)
                await asyncio.sleep(2)
                break
        stats["resets"] += 1


async def main() -> None:
    global deadline, measure_from
    start = time.time()
    samples = []

    async def sampler():
        while time.time() < deadline:
            await asyncio.sleep(10)
            if time.time() >= measure_from:
                m = metrics()
                samples.append({k: m.get(k, 0) for k in ("vllm:kv_cache_usage_perc", "vllm:num_requests_running", "vllm:num_requests_waiting")})

    conn = aiohttp.TCPConnector(limit=0)
    async with aiohttp.ClientSession(connector=conn) as session:
        tasks = [asyncio.create_task(agent(session, i)) for i in range(AGENTS)]
        try:
            await asyncio.wait_for(all_warm.wait(), timeout=1_200)
        except asyncio.TimeoutError:
            print("warning: not every agent finished a first turn within 20 min", flush=True)
        warm_s = time.time() - start
        measure_from = time.time()
        deadline = measure_from + SECONDS
        m0, t0 = metrics(), time.time()
        smp = asyncio.create_task(sampler())
        await asyncio.sleep(max(0.0, deadline - time.time()))
        m1, t1 = metrics(), time.time()
        for t in tasks:
            t.cancel()
        smp.cancel()
    dt = t1 - t0
    g = lambda k: m1.get(k, 0) - m0.get(k, 0)
    lat = sorted(stats["latencies"]) or [0]
    p = lambda q: lat[min(len(lat) - 1, int(q * len(lat)))]
    prompt, cached = g("vllm:prompt_tokens_total"), g("vllm:prompt_tokens_cached_total")
    res = {
        "tag": TAG, "agents": AGENTS, "seconds": round(dt), "warmup_s": round(warm_s),
        "evidence_tok_s": round(stats["evidence_tokens"] / dt, 1),
        "turns": stats["turns"], "turn_p50_s": round(p(0.5), 1), "turn_p95_s": round(p(0.95), 1),
        "prompt_tok_s": round(prompt / dt), "cache_hit_pct": round(100 * cached / max(prompt, 1), 1),
        "fresh_prefill_tok_s": round((prompt - cached) / dt), "gen_tok_s": round(g("vllm:generation_tokens_total") / dt),
        "preemptions": int(g("vllm:num_preemptions_total")),
        "kv_avg": round(sum(s["vllm:kv_cache_usage_perc"] for s in samples) / max(len(samples), 1), 2),
        "running_avg": round(sum(s["vllm:num_requests_running"] for s in samples) / max(len(samples), 1), 1),
        "waiting_avg": round(sum(s["vllm:num_requests_waiting"] for s in samples) / max(len(samples), 1), 1),
        "errors": stats["errors"], "finish_length": stats["finish_length"],
    }
    print(json.dumps(res), flush=True)
    with open("/workspace/bench/agents_results.jsonl", "a") as f:
        f.write(json.dumps(res) + "\n")


asyncio.run(main())

