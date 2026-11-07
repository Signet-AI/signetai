#!/usr/bin/env python3
"""Smoke test through the usage proxy: answer correctness, thinking budget, tool call,
and that per-request cached-token counts come back (needs --enable-prompt-tokens-details)."""
import json, os, sys, time, urllib.request

PORT = os.environ.get("PORT_SIGNET_QA", "8092")
MODEL = os.environ.get("SERVED_NAME", "qwen3.8-27b")
URL = f"http://127.0.0.1:{PORT}/v1/chat/completions"
ok = True


def call(body):
    t = time.time()
    req = urllib.request.Request(URL, data=json.dumps({"model": MODEL, **body}).encode(), headers={"Content-Type": "application/json"})
    d = json.load(urllib.request.urlopen(req, timeout=900))
    return time.time() - t, d["choices"][0]["message"], d["usage"], d["choices"][0]["finish_reason"]


def check(label, cond, detail):
    global ok
    ok &= bool(cond)
    print(f"[{'ok' if cond else 'FAIL'}] {label}: {detail}")


think = {"chat_template_kwargs": {"enable_thinking": True, "preserve_thinking": False}}
q = "A train leaves at 3:40pm and the trip takes 2h 35m. When does it arrive? Answer in one line."
dt, m, u, fr = call({"messages": [{"role": "user", "content": q}], "max_tokens": 6000, "thinking_token_budget": 1000, **think})
reasoning = (u.get("completion_tokens_details") or {}).get("reasoning_tokens")
check("answer", "6:15" in (m.get("content") or ""), f"{dt:.1f}s finish={fr} content={m.get('content')!r}")
check("thinking budget", fr == "stop" and (reasoning is None or reasoning <= 1100), f"reasoning_tokens={reasoning}")

prefix = "Background notes, repeated to exercise the prefix cache.\n" + ("The user owns a beagle named Rufus. " * 400)
for i in range(2):
    dt, m, u, fr = call({"messages": [{"role": "system", "content": prefix}, {"role": "user", "content": f"Name the dog. Reply with one word. ({i})"}], "max_tokens": 2000, "thinking_token_budget": 200, **think})
details = u.get("prompt_tokens_details")
check("cached-token reporting", details is not None and (details.get("cached_tokens") or 0) > 0, f"prompt={u['prompt_tokens']} details={details}")

tools = [{"type": "function", "function": {"name": "remember_fact", "description": "Store a fact about the user",
          "parameters": {"type": "object", "properties": {"entity": {"type": "string"}, "fact": {"type": "string"}}, "required": ["entity", "fact"]}}}]
dt, m, u, fr = call({"messages": [{"role": "user", "content": "Transcript: user says 'I adopted a beagle named Rufus last March.' Store every durable fact with the tool."}],
                     "tools": tools, "max_tokens": 6000, "thinking_token_budget": 1000, **think})
check("tool call", bool(m.get("tool_calls")), f"finish={fr} calls={json.dumps(m.get('tool_calls'))[:200]}")

stats = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/_proxy_stats", timeout=10))
check("proxy logged usage", stats["usage"].get("with_usage", 0) >= 4, json.dumps(stats["usage"]))
print("SMOKE_OK" if ok else "SMOKE_FAILED")
sys.exit(0 if ok else 1)
