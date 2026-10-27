#!/usr/bin/env python3
"""OpenAI-compatible pass-through proxy that logs token usage per request.

Every system that shares the GPU gets its own proxy port and tag, so prompt,
cached, completion and reasoning tokens can be split per system afterwards.

usage: usage_proxy.py --port 8091 --tag signet-dream [--upstream http://127.0.0.1:8000]
                      [--log-dir /workspace/usage] [--think-budget 2000] [--force-model qwen3.8-27b]

--think-budget / --force-model only fill fields the client did not set; use them for
clients that cannot send a thinking budget themselves (Supermemory).
Stats: GET /_proxy_stats -> per-path request counts plus usage totals.
"""
import argparse, collections, json, os, time
from aiohttp import web, ClientSession, ClientTimeout, TCPConnector

ap = argparse.ArgumentParser()
ap.add_argument("--port", type=int, required=True)
ap.add_argument("--tag", required=True)
ap.add_argument("--upstream", default="http://127.0.0.1:8000")
ap.add_argument("--log-dir", default="/workspace/usage")
ap.add_argument("--think-budget", type=int, default=0)
ap.add_argument("--force-model", default="")
ap.add_argument("--inject-stream-usage", action="store_true", default=True)
args = ap.parse_args()

os.makedirs(args.log_dir, exist_ok=True)
log = open(os.path.join(args.log_dir, f"{args.tag}.jsonl"), "a", buffering=1)
counts = collections.Counter()
totals = collections.Counter()
inflight = 0
session = None
USAGE_PATHS = ("/chat/completions", "/completions")


def record(path, model, stream, status, t0, usage, client_gone=False):
    u = usage or {}
    rec = {
        "t": round(t0, 3), "tag": args.tag, "path": path, "model": model, "stream": stream,
        "status": status, "client_closed_early": client_gone, "latency_s": round(time.time() - t0, 3), "has_usage": bool(usage),
        "prompt": u.get("prompt_tokens") or 0,
        "cached": ((u.get("prompt_tokens_details") or {}).get("cached_tokens")) or 0,
        "completion": u.get("completion_tokens") or 0,
        "reasoning": ((u.get("completion_tokens_details") or {}).get("reasoning_tokens")) or 0,
    }
    log.write(json.dumps(rec) + "\n")
    totals["requests"] += 1
    totals["with_usage"] += 1 if usage else 0
    for k in ("prompt", "cached", "completion", "reasoning"):
        totals[k] += rec[k]


def scan_sse(buf, last):
    """Consume complete SSE lines from buf; return (rest, last usage seen)."""
    while b"\n" in buf:
        line, buf = buf.split(b"\n", 1)
        line = line.strip()
        if line.startswith(b"data:") and b'"usage"' in line:
            try:
                d = json.loads(line[5:].strip())
                if d.get("usage"):
                    last = d["usage"]
            except Exception:
                pass
    return buf, last


def scrub_usage(data, keep_final_usage):
    """Forward complete SSE lines, removing usage the client did not ask for."""
    out = []
    while b"\n" in data:
        line, data = data.split(b"\n", 1)
        if line.startswith(b"data:") and b'"usage"' in line:
            try:
                d = json.loads(line[5:].strip())
            except Exception:
                out.append(line + b"\n")
                continue
            if d.get("choices"):
                d.pop("usage", None)
                line = b"data: " + json.dumps(d).encode()
            elif d.get("usage") is not None and not keep_final_usage:
                continue
        out.append(line + b"\n")
    return b"".join(out), data


async def handle(request):
    global session
    if session is None:
        session = ClientSession(timeout=ClientTimeout(total=4 * 3600), connector=TCPConnector(limit=0))
    body = await request.read()
    counts[request.path] += 1
    track = request.method == "POST" and request.path.endswith(USAGE_PATHS) and body
    model, stream = None, False
    keep_usage, keep_continuous = True, True
    if track:
        try:
            data = json.loads(body)
            if args.force_model:
                data["model"] = args.force_model
            if args.think_budget:
                data.setdefault("thinking_token_budget", args.think_budget)
                kw = dict(data.get("chat_template_kwargs") or {})
                kw.setdefault("enable_thinking", True)
                kw.setdefault("preserve_thinking", False)
                data["chat_template_kwargs"] = kw
            stream = bool(data.get("stream"))
            if stream and args.inject_stream_usage:
                so = dict(data.get("stream_options") or {})
                keep_usage = bool(so.get("include_usage"))
                keep_continuous = keep_usage and bool(so.get("continuous_usage_stats"))
                so.setdefault("include_usage", True)
                if so["include_usage"]:
                    so.setdefault("continuous_usage_stats", True)
                data["stream_options"] = so
            model = data.get("model")
            body = json.dumps(data).encode()
        except Exception:
            track = False
    t0 = time.time()
    headers = {k: v for k, v in request.headers.items() if k.lower() not in ("host", "content-length")}
    usage, status, client_gone = None, 599, False
    if request.transport is None or request.transport.is_closing():
        if track:
            record(request.path, model, stream, 499, t0, None, True)
        return web.Response(status=499)
    global inflight
    inflight += 1
    try:
        async with session.request(request.method, args.upstream + request.rel_url.path_qs, data=body, headers=headers) as up:
            status = up.status
            hop = ("content-length", "transfer-encoding", "content-encoding", "connection")
            resp = web.StreamResponse(status=up.status, headers={k: v for k, v in up.headers.items() if k.lower() not in hop})
            await resp.prepare(request)
            buf, whole, pending = b"", [], b""
            scrub = track and stream and not keep_continuous
            async for chunk in up.content.iter_any():
                if track:
                    if stream:
                        buf, usage = scan_sse(buf + chunk, usage)
                    else:
                        whole.append(chunk)
                if scrub:
                    out, pending = scrub_usage(pending + chunk, keep_usage)
                else:
                    out = chunk
                try:
                    if out:
                        await resp.write(out)
                except (ConnectionError, RuntimeError):
                    client_gone = True
                    break
            if scrub and pending and not client_gone:
                out, _ = scrub_usage(pending + b"\n", keep_usage)
                try:
                    await resp.write(out)
                except (ConnectionError, RuntimeError):
                    client_gone = True
            if track:
                if stream:
                    buf, usage = scan_sse(buf + b"\n", usage)
                elif not client_gone:
                    try:
                        usage = json.loads(b"".join(whole)).get("usage")
                    except Exception:
                        usage = None
            if not client_gone:
                try:
                    await resp.write_eof()
                except (ConnectionError, RuntimeError):
                    client_gone = True
            return resp
    except Exception as e:
        status = 599
        raise web.HTTPBadGateway(text=f"usage_proxy upstream error: {e}")
    finally:
        inflight -= 1
        if track:
            record(request.path, model, stream, status, t0, usage, client_gone)


async def stats(request):
    t = dict(totals)
    t["cache_hit_pct"] = round(100 * t.get("cached", 0) / t["prompt"], 2) if t.get("prompt") else None
    return web.json_response({"tag": args.tag, "paths": dict(counts), "inflight": inflight, "usage": t})


app = web.Application(client_max_size=256 * 1024 * 1024)
app.router.add_get("/_proxy_stats", stats)
app.router.add_route("*", "/{tail:.*}", handle)
web.run_app(app, host="127.0.0.1", port=args.port, print=None)
