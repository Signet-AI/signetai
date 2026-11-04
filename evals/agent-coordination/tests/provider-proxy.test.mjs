import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { REAL_UPSTREAM, startProxy } from "../services/provider-proxy.mjs";

const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pp-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let seq = 0;
const KEY = "sk-FAKE-provider-key-123456";
const H = { authorization: "Bearer t", "content-type": "application/json" };
const json = (o, status = 200) =>
	new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const sseResp = (parts) => {
	const enc = new TextEncoder();
	return new Response(
		new ReadableStream({
			start(c) {
				for (const p of parts) c.enqueue(enc.encode(p));
				c.close();
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
};

async function boot(fake, opts = {}) {
	const eventsPath = join(dir, `e${seq++}.jsonl`);
	writeFileSync(eventsPath, "");
	const p = await startProxy({
		tokens: { t: "A" },
		eventsPath,
		key: KEY,
		host: "127.0.0.1",
		upstream: "http://fake-provider",
		fetchImpl: fake,
		...opts,
	});
	const call = (b, init = {}) =>
		fetch(`http://127.0.0.1:${p.port}/chat/completions`, {
			method: "POST",
			headers: H,
			body: typeof b === "string" ? b : JSON.stringify(b),
			...init,
		});
	const events = () =>
		readFileSync(eventsPath, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	return { p, call, events, raw: () => readFileSync(eventsPath, "utf8") };
}
const capture = () => {
	const sent = [];
	return {
		sent,
		fake: async (_u, o) => (
			sent.push(JSON.parse(o.body)),
			json({ model: "glm-5.3-flash", choices: [{ finish_reason: "stop" }], usage: { completion_tokens: 1 } })
		),
	};
};

test("malicious max_tokens are rejected before reaching the provider", async () => {
	const { sent, fake } = capture();
	const { p, call } = await boot(fake);
	for (const bad of ["abc", "100", null, -1, 0, 1.5, Number.POSITIVE_INFINITY, NaN, [], {}, true]) {
		const body =
			bad === Number.POSITIVE_INFINITY || Number.isNaN(bad)
				? `{"max_tokens":${bad === Number.POSITIVE_INFINITY ? "1e999" : "NaN"}}`
				: { max_tokens: bad };
		assert.equal((await call(body)).status, 400, String(bad));
	}
	assert.equal(sent.length, 0);
	assert.equal(p.count(), 0, "rejected bodies do not consume request slots");
	assert.equal((await call({ max_tokens: 99999 })).status, 200);
	assert.equal(sent[0].max_tokens, 4000);
	assert.equal((await call({})).status, 200);
	assert.equal(sent[1].max_tokens, 4000);
	assert.equal((await call({ max_tokens: 50 })).status, 200);
	assert.equal(sent[2].max_tokens, 50);
	await p.close();
});

test("n>1, wrong model, bad thinking rejected; unknown fields stripped; protocol fields preserved", async () => {
	const { sent, fake } = capture();
	const { p, call, events } = await boot(fake);
	for (const b of [{ n: 1000 }, { n: 2 }, { n: "1" }, { model: "glm-4.5-air" }, { thinking: { type: "disabled" } }, []])
		assert.equal((await call(b)).status, 400, JSON.stringify(b));
	assert.equal(sent.length, 0);
	const msgs = [
		{
			role: "assistant",
			content: null,
			reasoning_content: "think",
			tool_calls: [{ id: "1", type: "function", function: { name: "f", arguments: "{}" } }],
		},
	];
	const tools = [{ type: "function", function: { name: "f", parameters: {} } }];
	assert.equal(
		(
			await call({
				model: "glm-5.3-flash",
				n: 1,
				messages: msgs,
				tools,
				max_completion_tokens: 99999,
				reasoning_effort: "high",
				best_of: 50,
				thinking: { type: "enabled", clear_thinking: false },
			})
		).status,
		200,
	);
	const s = sent[0];
	assert.deepEqual(s.messages, msgs);
	assert.deepEqual(s.tools, tools);
	assert.equal(s.n, 1);
	assert.equal(s.model, "glm-5.3-flash");
	assert.deepEqual(s.thinking, { type: "enabled", clear_thinking: false });
	assert.equal(s.reasoning_effort, "high");
	for (const k of ["max_completion_tokens", "best_of"]) assert.equal(s[k], undefined, k);
	const ev = events().find((e) => e.type === "request");
	assert.equal(ev.requestedEffort, "high");
	assert.equal(ev.effectiveEffort, "high");
	assert.equal(ev.clearThinking, false);
	await p.close();
});

test("oversized body gets 413 and never reaches the provider", async () => {
	const { sent, fake } = capture();
	const { p, call } = await boot(fake);
	const r = await call(JSON.stringify({ messages: [{ role: "user", content: "x".repeat(1024 * 1024 + 10) }] }));
	assert.equal(r.status, 413);
	assert.equal(sent.length, 0);
	await p.close();
});

test("24-request cap is atomic under concurrency", async () => {
	let upstreamCalls = 0;
	const fake = async () => (
		upstreamCalls++,
		await new Promise((r) => setTimeout(r, 20)),
		json({ model: "glm-5.3-flash", usage: { completion_tokens: 1 } })
	);
	const { p, call, events } = await boot(fake);
	const rs = await Promise.all(Array.from({ length: 60 }, () => call({})));
	const codes = rs.map((r) => r.status);
	assert.equal(codes.filter((c) => c === 200).length, 24);
	assert.equal(codes.filter((c) => c === 429).length, 36);
	assert.equal(upstreamCalls, 24);
	assert.equal(p.count(), 24);
	assert.equal(p.stats().refused, 36);
	assert.deepEqual(
		[
			...new Set(
				events()
					.filter((e) => e.type === "request")
					.map((e) => e.requestId),
			),
		].length,
		24,
	);
	assert.ok(
		events()
			.filter((e) => e.type === "refused")
			.every((e) => e.reason === "request_cap"),
	);
	await p.close();
});

test("missing key refuses locally with 503 and zero upstream calls", async () => {
	const { sent, fake } = capture();
	const { p, call, events } = await boot(fake, { key: () => undefined });
	assert.equal((await call({})).status, 503);
	assert.equal(sent.length, 0);
	assert.equal(events()[0].reason, "no_provider_key");
	await p.close();
});

test("SSE: nested usage split across chunk boundaries, model only in first chunk, bytes forwarded unchanged", async () => {
	const first = `data: ${JSON.stringify({ model: "glm-5.3-flash", choices: [{ delta: { reasoning_content: "hm" } }] })}\n\n`;
	const filler = `data: ${JSON.stringify({ choices: [{ delta: { content: "y".repeat(2000) } }] })}\n\n`;
	const fin = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}\n\n`;
	const usage = JSON.stringify({
		choices: [],
		usage: {
			prompt_tokens: 10,
			completion_tokens: 4000,
			prompt_tokens_details: { cached_tokens: 7 },
			completion_tokens_details: { reasoning_tokens: 3000 },
		},
	});
	const tail = `data: ${usage}\n\ndata: [DONE]\n\n`;
	const mid = Math.floor(tail.length / 2);
	const parts = [first, ...Array(5).fill(filler), fin, tail.slice(0, mid), tail.slice(mid)];
	const { p, call, events } = await boot(async () => sseResp(parts));
	const r = await call({ stream: true });
	assert.equal(await r.text(), parts.join(""));
	const e = events().find((x) => x.type === "request");
	assert.equal(e.servedModel, "glm-5.3-flash");
	assert.deepEqual(e.finishReasons, ["length"]);
	assert.equal(e.truncated, true);
	assert.equal(e.usage.prompt_tokens_details.cached_tokens, 7);
	assert.equal(e.usage.completion_tokens_details.reasoning_tokens, 3000);
	assert.equal(e.usageStatus, "reported");
	assert.equal(e.complete, true);
	await p.close();
});

test("SSE: served models after the first chunk are all recorded; request sets stream_options.include_usage", async () => {
	let sent;
	const parts = [
		`data: ${JSON.stringify({ model: "glm-5.3-flash", choices: [] })}\n\n`,
		`data: ${JSON.stringify({ model: "glm-4.5-air", choices: [] })}\n\n`,
		"data: [DONE]\n\n",
	];
	const { p, call, events } = await boot(async (_u, o) => ((sent = JSON.parse(o.body)), sseResp(parts)));
	await (await call({ stream: true, stream_options: { include_usage: false, x: 1 } })).text();
	assert.deepEqual(sent.stream_options, { include_usage: true });
	const e = events().find((x) => x.type === "request");
	assert.deepEqual(e.servedModels, ["glm-5.3-flash", "glm-4.5-air"]);
	assert.equal(e.usage, null);
	assert.equal(e.usageStatus, "unknown");
	await p.close();
});

test("malformed nested usage marks unknown, stream survives", async () => {
	const parts = [
		`data: ${JSON.stringify({ model: "glm-5.3-flash", choices: [{ finish_reason: "stop" }] })}\n\n`,
		'data: {"usage":{"prompt_tokens_details":{"cached_tokens":\n\n',
		"data: [DONE]\n\n",
	];
	const { p, call, events } = await boot(async () => sseResp(parts));
	assert.equal(await (await call({ stream: true })).text(), parts.join(""));
	const e = events().find((x) => x.type === "request");
	assert.equal(e.usage, null);
	assert.equal(e.usageStatus, "unknown");
	assert.equal(e.parseError, true);
	assert.equal(e.servedModel, "glm-5.3-flash");
	await p.close();
});

test("non-stream response with nested usage past 6000 bytes is parsed fully", async () => {
	const big = {
		model: "glm-5.3-flash",
		choices: [{ message: { content: "z".repeat(20000) }, finish_reason: "stop" }],
		usage: { prompt_tokens: 1, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens: 2 },
	};
	const { p, call, events } = await boot(async () => json(big));
	await (await call({})).text();
	const e = events().find((x) => x.type === "request");
	assert.equal(e.usage.prompt_tokens_details.cached_tokens, 0);
	assert.equal(e.servedModel, "glm-5.3-flash");
	await p.close();
});

test("upstream 429/401 are recorded as provider classes; local cap is request_cap refusal", async () => {
	const codes = [429, 401, 500];
	const { p, call, events } = await boot(async () => json({ error: { message: `bad key ${KEY}` } }, codes.shift()), {
		maxRequests: 3,
	});
	for (const c of [429, 401, 500]) assert.equal((await call({})).status, c);
	const ev = events().filter((e) => e.type === "request");
	assert.deepEqual(
		ev.map((e) => e.class),
		["provider_rate_limit", "auth", "provider"],
	);
	assert.equal(ev.length, 3, "every forwarded attempt is recorded, including non-200");
	assert.equal((await call({})).status, 429);
	const last = events().at(-1);
	assert.equal(last.type, "refused");
	assert.equal(last.reason, "request_cap");
	await p.close();
});

test("key never appears in events, even when a network error echoes it", async () => {
	const { p, call, raw, events } = await boot(async () => {
		throw new Error(`connect failed for Bearer ${KEY}`);
	});
	assert.equal((await call({ messages: [{ role: "user", content: "hello-secret-prompt" }] })).status, 502);
	assert.ok(!raw().includes(KEY));
	assert.ok(!raw().includes("hello-secret-prompt"));
	assert.equal(events().find((e) => e.type === "upstream_error").class, "network");
	await p.close();
});

test("wall deadline aborts an in-flight upstream fetch and refuses later requests", async () => {
	let aborted = false;
	const fake = (_u, o) =>
		new Promise((_, rej) => o.signal.addEventListener("abort", () => ((aborted = true), rej(new Error("aborted")))));
	const { p, call, events } = await boot(fake);
	p.setLimits({ wallMs: 150 });
	const t0 = Date.now();
	const r = await call({});
	assert.equal(r.status, 504);
	assert.ok(Date.now() - t0 < 2000);
	assert.ok(aborted);
	const types = events().map((e) => e.type);
	assert.ok(types.includes("budget_exhausted"));
	const req = events().find((e) => e.type === "request");
	assert.equal(req.class, "budget_exhausted");
	assert.ok(!events().some((e) => e.type === "upstream_error"), "local deadline is not a provider error");
	assert.equal((await call({})).status, 429);
	assert.equal(events().at(-1).reason, "wall_limit");
	await p.close();
});

test("mid-stream deadline aborts streaming and is classified budget_exhausted", async () => {
	const enc = new TextEncoder();
	const fake = async (_u, o) =>
		new Response(
			new ReadableStream({
				start(c) {
					c.enqueue(enc.encode(`data: ${JSON.stringify({ model: "glm-5.3-flash" })}\n\n`));
					o.signal.addEventListener("abort", () => c.error(new Error("aborted")));
				},
			}),
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);
	const { p, call, events } = await boot(fake);
	p.setLimits({ wallMs: 150 });
	const r = await call({ stream: true });
	await r.text().catch(() => {});
	assert.equal(events().find((e) => e.type === "request").class, "budget_exhausted");
	await p.close();
});

test("client disconnect aborts the upstream fetch; completed bodies do not", async () => {
	let upSignal;
	const fake = (_u, o) => (
		(upSignal = o.signal), new Promise((_, rej) => o.signal.addEventListener("abort", () => rej(new Error("aborted"))))
	);
	const { p, events } = await boot(fake);
	const ac = new AbortController();
	const pending = fetch(`http://127.0.0.1:${p.port}/chat/completions`, {
		method: "POST",
		headers: H,
		body: "{}",
		signal: ac.signal,
	}).catch(() => {});
	while (!upSignal) await new Promise((r) => setTimeout(r, 10));
	assert.equal(upSignal.aborted, false, "request body completion alone must not abort");
	ac.abort();
	await pending;
	for (let i = 0; i < 100 && !upSignal.aborted; i++) await new Promise((r) => setTimeout(r, 10));
	assert.equal(upSignal.aborted, true);
	for (let i = 0; i < 100 && !events().some((e) => e.class === "client_disconnect"); i++)
		await new Promise((r) => setTimeout(r, 10));
	assert.ok(events().some((e) => e.class === "client_disconnect"));
	await p.close();
});

test("close() aborts active fetches and tears down connections", async () => {
	let upSignal;
	const fake = (_u, o) => (
		(upSignal = o.signal), new Promise((_, rej) => o.signal.addEventListener("abort", () => rej(new Error("aborted"))))
	);
	const { p } = await boot(fake);
	const pending = fetch(`http://127.0.0.1:${p.port}/chat/completions`, { method: "POST", headers: H, body: "{}" }).then(
		(r) => r.status,
		() => "closed",
	);
	while (!upSignal) await new Promise((r) => setTimeout(r, 10));
	await p.close();
	assert.equal(upSignal.aborted, true);
	assert.ok(["closed", 502].includes(await pending));
});

test("real fetch is only allowed against the pinned z.ai origin; redirects error", async () => {
	assert.throws(
		() =>
			startProxy({
				tokens: {},
				eventsPath: join(dir, "x"),
				key: KEY,
				host: "127.0.0.1",
				upstream: "https://evil.example/v1",
			}),
		/real fetch only allowed/,
	);
	let init;
	const { p, call } = await boot(async (_u, o) => ((init = o), json({})), { upstream: REAL_UPSTREAM });
	await call({});
	assert.equal(init.redirect, "error");
	await p.close();
});

test("inherited/prototype/empty/non-string token keys never authenticate and never reach upstream", async () => {
	const { fake, sent } = capture();
	const { p, events } = await boot(fake, { tokens: { t: "A", empty: "", obj: { x: 1 } } });
	for (const tok of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "nope", "empty", "obj"]) {
		const r = await fetch(`http://127.0.0.1:${p.port}/chat/completions`, {
			method: "POST",
			headers: { ...H, authorization: `Bearer ${tok}` },
			body: JSON.stringify({ model: "m", messages: [] }),
		});
		assert.equal(r.status, 401, tok);
	}
	assert.equal(sent.length, 0);
	assert.equal(events().filter((e) => e.type === "admitted" || e.type === "forwarded").length, 0);
	await p.close();
});
