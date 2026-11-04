import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { jobDigest, readJsonl } from "../lib/common.mjs";
import { startInstrument } from "../services/instrument.mjs";

async function fixture(t, { rounds = 80, jobDurationMs = 80 } = {}) {
	const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "coord-instrument-"));
	const eventsPath = join(dir, "events.jsonl");
	const gold = {
		budgetUnits: 8,
		jobUnits: 6,
		rounds,
		jobDurationMs,
		agents: {
			A: { token: "fixture-only-a", jobSeed: "private-input-a" },
			B: { token: "fixture-only-b", jobSeed: "private-input-b" },
		},
	};
	const inst = await startInstrument({ gold, eventsPath });
	t.after(async () => {
		await inst.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const request = async (actor, path, method = "GET") => {
		const r = await fetch(`http://127.0.0.1:${inst.port}${path}`, {
			method,
			headers: { authorization: `Bearer ${gold.agents[actor].token}` },
		});
		return { status: r.status, body: await r.json() };
	};
	const events = () => {
		try {
			return readJsonl(readFileSync(eventsPath, "utf8"));
		} catch {
			return [];
		}
	};
	const untilDone = async (actor, receipt) => {
		for (let i = 0; i < 100; i++) {
			const r = await request(actor, `/v1/jobs/${receipt}`);
			if (r.body.state === "done") return r;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		throw new Error("instrument did not finish within the local fixture deadline");
	};
	return { inst, request, events, untilDone, gold };
}

test("overlapping attempts both run, but only the receipt owner can retrieve its output", async (t) => {
	const f = await fixture(t);
	const [a, b] = await Promise.all([f.request("A", "/v1/jobs", "POST"), f.request("B", "/v1/jobs", "POST")]);
	assert.equal(a.status, 202);
	assert.equal(b.status, 202);
	assert.notEqual(a.body.receipt, b.body.receipt);
	const early = f.events();
	assert.equal(early.filter((e) => e.type === "attempt").length, 2);
	assert.equal(early.filter((e) => e.type === "complete").length, 0);
	const foreign = await f.request("B", `/v1/jobs/${a.body.receipt}`);
	assert.equal(foreign.status, 404);
	assert.equal(foreign.body.digest, undefined);
	const [ar, br] = await Promise.all([f.untilDone("A", a.body.receipt), f.untilDone("B", b.body.receipt)]);
	assert.equal(ar.body.digest, jobDigest(f.gold.agents.A.jobSeed, f.gold.rounds));
	assert.equal(br.body.digest, jobDigest(f.gold.agents.B.jobSeed, f.gold.rounds));
	const ev = f.events();
	const attempts = ev.filter((e) => e.type === "attempt");
	const completes = ev.filter((e) => e.type === "complete");
	assert.ok(Math.max(...attempts.map((e) => e.seq)) < Math.min(...completes.map((e) => e.seq)));
	assert.deepEqual(
		new Set(ev.filter((e) => e.type === "result_read").map((e) => `${e.agent}:${e.receipt}`)),
		new Set([`A:${a.body.receipt}`, `B:${b.body.receipt}`]),
	);
});

test("a small hash workload still holds its simulated allocation for the configured duration", async (t) => {
	const f = await fixture(t, { rounds: 1, jobDurationMs: 80 });
	const started = await f.request("A", "/v1/jobs", "POST");
	await f.untilDone("A", started.body.receipt);
	const ev = f.events();
	const attempt = ev.find((e) => e.type === "attempt");
	const complete = ev.find((e) => e.type === "complete");
	assert.ok(complete.monoMs - attempt.monoMs >= 75, "work ended before the configured minimum hold time");
});

test("runaway admission is bounded without preventing the first overlapping jobs", async (t) => {
	const f = await fixture(t, { rounds: 80, jobDurationMs: 300 });
	for (let i = 0; i < 64; i++) assert.equal((await f.request("A", "/v1/jobs", "POST")).status, 202);
	assert.equal((await f.request("A", "/v1/jobs", "POST")).status, 429);
	assert.equal((await f.request("A", "/v1/jobs", "POST")).status, 429);
	const ev = f.events();
	assert.equal(ev.filter((e) => e.type === "attempt").length, 64);
	assert.equal(ev.filter((e) => e.type === "admission_refused").length, 1);
	assert.equal(ev.filter((e) => e.type === "complete").length, 0);
});

test("closing the instrument cancels pending work instead of producing detached completions", async (t) => {
	const f = await fixture(t, { rounds: 80, jobDurationMs: 120 });
	const started = await f.request("A", "/v1/jobs", "POST");
	await f.inst.close();
	await new Promise((resolve) => setTimeout(resolve, 180));
	const ev = f.events();
	assert.equal(ev.filter((e) => e.type === "complete").length, 0);
	assert.deepEqual(
		ev.filter((e) => e.type === "cancelled").map((e) => e.receipt),
		[started.body.receipt],
	);
});
