#!/usr/bin/env node
// Trusted host-side provider proxy. The provider key exists ONLY in this process's environment
// (ZAI_CODING_CN_API_KEY, injected by the parent via secret exec). Agent containers receive a per-run opaque
// token that is useless elsewhere. Enforces request/output/wall-time limits and records the provider's
// own served model, stop reasons and raw usage. It never invents values: unknown stays null.
//
// Effective model params (per docs.z.ai glm-5.3-flash): model glm-5.3-flash, thinking {type:enabled,
// clear_thinking:false}, reasoning_effort "max", n=1, max_tokens <= cap. The agent's requested
// reasoning_effort is NOT honoured; it is recorded as requestedEffort next to effectiveEffort "max".
// Limits: 24 forwarded attempts, 4000 output tokens each, 1 MiB request body. There is NO input-token
// or dollar ceiling: 24 x 1 MiB of input is the worst case, and cost is not bounded by this proxy.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { redact } from "../lib/common.mjs";

export const REAL_UPSTREAM = "https://open.bigmodel.cn/api/coding/paas/v4";
export const EFFECTIVE_PARAMS = Object.freeze({ model: "glm-5.3-flash", n: 1 });
const MODEL = EFFECTIVE_PARAMS.model;
const MAX_BODY = 1024 * 1024;
const MAX_RESPONSE = 8 * 1024 * 1024;
const MAX_LINE = 1024 * 1024;
const ALLOWED = new Set(["model", "messages", "tools", "tool_choice", "tool_stream", "stream", "stream_options", "temperature", "top_p", "stop", "max_tokens", "thinking", "reasoning_effort", "response_format", "seed", "parallel_tool_calls"]);

class Reject extends Error {
	constructor(status, msg) {
		super(msg);
		this.status = status;
	}
}

function validateBody(raw, maxOutput) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Reject(400, "body must be a JSON object");
	if (raw.model !== undefined && raw.model !== MODEL) throw new Reject(400, `model must be ${MODEL}`);
	if (raw.n !== undefined && raw.n !== 1) throw new Reject(400, "n must be 1");
	let maxTokens = maxOutput;
	if (raw.max_tokens !== undefined) {
		const v = raw.max_tokens;
		if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) throw new Reject(400, "max_tokens must be a positive integer");
		maxTokens = Math.min(v, maxOutput);
	}
	if (raw.thinking !== undefined && (!raw.thinking || typeof raw.thinking !== "object" || (raw.thinking.type !== undefined && raw.thinking.type !== "enabled"))) throw new Reject(400, "thinking.type must be enabled");
	const out = {};
	const stripped = [];
	for (const [k, v] of Object.entries(raw)) (ALLOWED.has(k) ? Object.assign(out, { [k]: v }) : stripped.push(k));
	out.model = MODEL;
	out.n = 1;
	out.max_tokens = maxTokens;


	if (out.stream) out.stream_options = { include_usage: true };
	else delete out.stream_options;
	return { body: out, stripped: stripped.filter((k) => k !== "n" && k !== "reasoning_effort"), requestedEffort: typeof raw.reasoning_effort === "string" ? raw.reasoning_effort : null };
}

/** Incremental, bounded parser for the provider's response. Never throws; failures become `unknown`. */
function makeParser(sse) {
	const st = { models: [], finish: [], usage: null, malformed: false, done: false };
	let buf = "";
	let total = 0;
	let overflow = false;
	const take = (j) => {
		if (!j || typeof j !== "object") return;
		if (typeof j.model === "string" && !st.models.includes(j.model)) st.models.push(j.model);
		for (const c of Array.isArray(j.choices) ? j.choices : []) if (c && typeof c.finish_reason === "string") st.finish.push(c.finish_reason);
		if (j.usage && typeof j.usage === "object") st.usage = j.usage;
	};
	const line = (l) => {
		if (!l.startsWith("data:")) return;
		const d = l.slice(5).trim();
		if (d === "[DONE]") return void (st.done = true);
		try {
			take(JSON.parse(d));
		} catch {
			st.malformed = true;
		}
	};
	return {
		push(chunk) {
			if (overflow) return;
			const s = Buffer.from(chunk).toString("utf8");
			total += s.length;
			buf += s;
			if (!sse) {
				if (total > MAX_RESPONSE) ((overflow = true), (st.malformed = true), (buf = ""));
				return;
			}
			let i = buf.indexOf("\n");
			while (i >= 0) {
				line(buf.slice(0, i).replace(/\r$/, ""));
				buf = buf.slice(i + 1);
				i = buf.indexOf("\n");
			}
			if (buf.length > MAX_LINE) ((st.malformed = true), (buf = ""));
		},
		end() {
			if (overflow) return st;
			if (sse) {
				if (buf) line(buf.replace(/\r$/, ""));
			} else if (buf) {
				try {
					take(JSON.parse(buf));
				} catch {
					st.malformed = true;
				}
			}
			return st;
		},
	};
}

export function startProxy({ tokens, eventsPath, maxRequests = 24, maxOutput = 4000, upstream = REAL_UPSTREAM, key = process.env.ZAI_CODING_CN_API_KEY, host = "0.0.0.0", port = 0, fetchImpl }) {
	const injected = typeof fetchImpl === "function";
	if (!injected && upstream !== REAL_UPSTREAM) throw new Error(`real fetch only allowed against ${REAL_UPSTREAM}; inject fetchImpl (fake provider) for other upstreams`);
	const doFetch = injected ? fetchImpl : fetch;
	const lim = { maxRequests, maxOutput };
	let admitted = 0;
	let refused = 0;
	let deadline = null;
	let timer = null;
	let expired = false;
	const active = new Set();
	const scrub = (s) => {
		const k = typeof key === "function" ? key() : key;
		return k ? s.split(k).join("[REDACTED]") : s;
	};
	const ev = (type, d) => appendFileSync(eventsPath, `${scrub(JSON.stringify(redact({ src: "proxy", type, wallMs: Date.now(), ...d })))}\n`);
	const expire = () => {
		if (expired) return;
		expired = true;
		ev("budget_exhausted", { reason: "wall_limit", inFlight: active.size });
		for (const a of active) a.abort(new Error("wall_limit"));
	};
	const refuse = (res, status, agent, reason, text, extra = {}) => {
		refused++;
		ev("refused", { agent, reason, ...extra });
		res.writeHead(status).end(text);
	};
	const server = createServer(async (req, res) => {
		const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
		const agent = m && Object.hasOwn(tokens, m[1]) && typeof tokens[m[1]] === "string" && tokens[m[1]] !== "" ? tokens[m[1]] : undefined;
		if (!agent) return void res.writeHead(401).end("unauthorized");
		if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) return void res.writeHead(404).end("only chat/completions");
		const liveKey = typeof key === "function" ? key() : key;
		if (!liveKey) return refuse(res, 503, agent, "no_provider_key", "proxy has no provider key");
		if (expired || (deadline !== null && performance.now() >= deadline)) {
			expire();
			return refuse(res, 429, agent, "wall_limit", "run wall-clock limit reached");
		}
		if (Number(req.headers["content-length"]) > MAX_BODY) return void res.writeHead(413, { connection: "close" }).end("body too large");
		const chunks = [];
		let size = 0;
		try {
			for await (const c of req) {
				size += c.length;
				if (size > MAX_BODY) throw new Reject(413, "body too large");
				chunks.push(c);
			}
		} catch (e) {
			if (e instanceof Reject) {
				res.writeHead(e.status, { connection: "close" }).end(e.message);
				return void req.destroy();
			}
			return;
		}
		let prepared;
		try {
			let raw;
			try {
				raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch {
				throw new Reject(400, "bad json");
			}
			prepared = validateBody(raw, lim.maxOutput);
		} catch (e) {
			if (!(e instanceof Reject)) throw e;
			ev("rejected", { agent, reason: "invalid_request", detail: e.message });
			return void res.writeHead(e.status).end(e.message);
		}
		// Atomic slot reservation (no await between check and increment).
		if (admitted >= lim.maxRequests) return refuse(res, 429, agent, "request_cap", "run request cap reached", { cap: lim.maxRequests });
		const n = ++admitted;
		const ac = new AbortController();
		active.add(ac);
		let ended = false;
		res.on("close", () => {
			if (!res.writableEnded) ac.abort(new Error("client_disconnect"));
		});
		const t0 = Date.now();
		const base = { agent, n, requestId: `r${n}`, stripped: prepared.stripped, requestedEffort: prepared.requestedEffort, effectiveEffort: prepared.body.reasoning_effort ?? null, clearThinking: prepared.body.thinking?.clear_thinking ?? null, maxTokens: prepared.body.max_tokens };
		let up;
		try {
			up = await doFetch(`${upstream}/chat/completions`, { method: "POST", redirect: "error", signal: ac.signal, headers: { "content-type": "application/json", authorization: `Bearer ${liveKey}` }, body: JSON.stringify(prepared.body) });
			const sse = (up.headers.get("content-type") ?? "").includes("text/event-stream");
			const parser = makeParser(sse);
			res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json" });
			for await (const chunk of up.body) {
				parser.push(chunk);
				res.write(chunk);
			}
			ended = true;
			res.end();
			const st = parser.end();
			const cls = up.status === 401 || up.status === 403 ? "auth" : up.status === 429 ? "provider_rate_limit" : up.status >= 400 ? "provider" : null;
			const incomplete = up.status < 400 && sse && !st.done;
			ev("request", {
				...base,
				status: up.status,
				ms: Date.now() - t0,
				class: cls,
				servedModel: st.models[0] ?? null,
				servedModels: st.models,
				finishReason: st.finish[0] ?? null,
				finishReasons: st.finish,
				truncated: st.finish.includes("length"),
				usage: st.usage,
				usageStatus: st.usage ? "reported" : "unknown",
				parseError: st.malformed,
				complete: !incomplete,
			});
			if (incomplete) ev("upstream_error", { ...base, class: "incomplete_stream", message: "stream ended without [DONE]" });
		} catch (e) {
			const reason = ac.signal.reason?.message;
			const klass = expired || reason === "wall_limit" ? "budget_exhausted" : reason === "client_disconnect" ? "client_disconnect" : up ? "incomplete_stream" : "network";
			if (klass === "budget_exhausted") ev("request", { ...base, status: up?.status ?? null, ms: Date.now() - t0, class: klass, servedModel: null, usage: null, usageStatus: "unknown", complete: false });
			else ev("upstream_error", { ...base, class: klass, status: up?.status ?? null, message: scrub(String(e?.message ?? e)).slice(0, 200) });
			if (!res.headersSent && !res.destroyed) res.writeHead(klass === "budget_exhausted" ? 504 : 502);
			if (!ended) res.end();
		} finally {
			active.delete(ac);
		}
	});
	const close = () =>
		new Promise((r) => {
			if (timer) clearTimeout(timer);
			for (const a of active) a.abort(new Error("proxy_closed"));
			server.close(() => r());
			server.closeAllConnections();
		});
	return new Promise((r) =>
		server.listen(port, host, () =>
			r({
				server,
				port: server.address().port,
				count: () => admitted,
				stats: () => ({ admitted, forwarded: admitted, refused, active: active.size, expired }),
				close,
				setLimits: (l) => {
					if (l.requests !== undefined) lim.maxRequests = l.requests;
					if (l.output !== undefined) lim.maxOutput = l.output;
					if (Number.isFinite(l.wallMs) && deadline === null) {
						deadline = performance.now() + l.wallMs;
						timer = setTimeout(expire, l.wallMs);
						timer.unref();
					}
				},
			}),
		),
	);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const tokens = JSON.parse(process.env.EVAL_PROXY_TOKENS ?? "{}");
	const p = await startProxy({ tokens, eventsPath: process.env.EVAL_PROXY_EVENTS, port: Number(process.env.PORT ?? 8787) });
	console.log(JSON.stringify({ proxy: p.port, keyPresent: Boolean(process.env.ZAI_CODING_CN_API_KEY) }));
}
