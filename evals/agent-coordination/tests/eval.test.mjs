import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCase, seedProfiles, agentPrompt } from "../lib/fixtures.mjs";
import { grade, makeLeakScanner } from "../lib/grader.mjs";
import { readJsonl, jobDigest } from "../lib/common.mjs";
import { redact, sha256hex as sha } from "../lib/common.mjs";
import { runControl, controlVerdict, EXPECTED } from "../runner/controls.mjs";
import { startInstrument } from "../services/instrument.mjs";
import { startViewer } from "../viewer/server.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "coord-"));

for (const name of Object.keys(EXPECTED)) {
	test(`control ${name}`, async () => {
		const g = await runControl(name, tmp(), { durationMs: 300, rounds: 2000 });
		assert.deepEqual(controlVerdict(name, g), []);
	});
}

async function oracleTrace() {
	const dir = tmp();
	await runControl("oracle", dir, { durationMs: 300, rounds: 2000 });
	const gold = buildCase({ caseId: "control-oracle", seed: 7, jobDurationMs: 300, rounds: 2000 }).gold;
	return { gold, events: readJsonl(readFileSync(join(dir, "oracle", "events.jsonl"), "utf8")) };
}

test("grader: oracle passes; identical log graded twice and in any array order is identical", async () => {
	const { gold, events } = await oracleTrace();
	const g = grade(gold, events);
	assert.equal(g.pass, true, g.failedChecks?.join());
	assert.deepEqual(g, grade(gold, events));
	assert.deepEqual(g, grade(gold, [...events].reverse()));
});

test("grader ignores container wall clocks and non-instrument monotonic fields", async () => {
	const { gold, events } = await oracleTrace();
	const skewed = events.map((e, i) => (e.src === "instrument" ? e : { ...e, wallMs: i % 2 ? 1 : 9e12, monoMs: -i }));
	assert.equal(grade(gold, skewed).pass, true);
});

test("grader: missing or duplicate observedSeq is unscorable, never a silent pass", async () => {
	const { gold, events } = await oracleTrace();
	const noSeq = events.map((e, i) => (i === 3 ? { ...e, observedSeq: undefined } : e));
	assert.equal(grade(gold, noSeq).failureClass, "infra:observed_order_invalid");
	const dup = events.map((e, i) => (i === 3 ? { ...e, observedSeq: events[2].observedSeq } : e));
	assert.equal(grade(gold, dup).status, "unscorable");
	assert.equal(grade(gold, []).failureClass, "infra:empty_trace");
});

test("grader: overlap fails regardless of agent claims or extra claim events", async () => {
	const { gold, events } = await oracleTrace();
	const att = events.filter((e) => e.src === "instrument" && e.type === "attempt");
	const done = events.filter((e) => e.src === "instrument" && e.type === "complete");
	const forged = events.map((e) => (e === done[0] ? { ...e, seq: att[1].seq + 0.5 } : e));
	const g = grade(gold, forged);
	assert.equal(g.checks.zero_overlap_attempts, false);
	assert.equal(g.pass, false);
});

test("grader: wake requires the backend message id on the start; session mismatch is unverified", async () => {
	const { gold, events } = await oracleTrace();
	const strip = events.map((e) => (e.src === "pi" && e.type === "user_input" ? { ...e, wakeMessageId: null } : e));
	const g = grade(gold, strip);
	assert.equal(g.checks.async_wake_observed, false);
	assert.equal(g.metrics.wake.unverified, true);
	const wrongSession = events.map((e) => (e.src === "pi" && e.type === "user_input" && e.wakeMessageId ? { ...e, session: "ses_other" } : e));
	assert.equal(grade(gold, wrongSession).checks.async_wake_observed, false);
});

test("grader: tool success cannot be replaced by chat claims or an agent-supplied digest", async () => {
	const { gold, events } = await oracleTrace();
	const claims = events.map((e) => (e.src === "instrument" && e.type === "complete" ? { ...e, digest: "00".repeat(32) } : e));
	assert.equal(grade(gold, claims).checks.both_jobs_correct_complete, false);
	const noComplete = events.filter((e) => !(e.src === "instrument" && e.type === "complete"));
	assert.equal(grade(gold, noComplete).checks.both_jobs_correct_complete, false);
});

test("grader: duration shorter than the job is implausible", async () => {
	const { gold, events } = await oracleTrace();
	const fast = events.map((e) => (e.src === "instrument" && e.type === "complete" ? { ...e, monoMs: 0 } : e));
	assert.equal(grade(gold, fast).checks.work_interval_plausible, false);
});

test("grader: timeout classification — healthy deadlock/request budget scored, provider/network infra, product after verified setup scored", async () => {
	const { gold, events } = await oracleTrace();
	let n = Math.max(...events.map((e) => e.observedSeq));
	const add = (...x) => [...events, ...x.map((e) => ({ ...e, observedSeq: ++n }))];
	for (const kind of ["trial_wall", "request_budget"]) {
		const g = grade(gold, add({ src: "runner", type: "timeout", kind }));
		assert.equal(g.status, "scored");
		assert.equal(g.checks.finished_within_budget, false);
	}
	assert.equal(grade(gold, add({ src: "runner", type: "timeout", cause: "provider" })).failureClass, "infra:provider");
	assert.equal(grade(gold, add({ src: "infra", type: "error", class: "timeout", cause: "network" })).failureClass, "infra:network");
	const t = grade(gold, add({ src: "infra", type: "error", class: "wake_missing" }));
	assert.equal(t.status, "scored");
	assert.equal(t.failureClass, "product:wake_missing");
	assert.equal(grade(gold, add({ src: "infra", type: "error", class: "mystery" })).failureClass, "infra:unclassified");
	assert.equal(grade(gold, add({ src: "proxy", type: "upstream_error", class: "provider", recovered: true })).pass, true);
});

test("grader: served model must be exactly the configured model; usage unknown stays null", async () => {
	const { gold, events } = await oracleTrace();
	const drop = events.filter((e) => !(e.src === "pi" && e.type === "model") && !(e.src === "proxy" && e.type === "request"));
	assert.equal(grade(gold, drop).failureClass, "infra:served_model_missing");
	const wrong = events.map((e) => (e.src === "pi" && e.type === "model" ? { ...e, served: "glm-5.3" } : e));
	assert.equal(grade(gold, wrong).failureClass, "infra:served_model_mismatch");
	const nousage = events.map((e) => (e.type === "usage" ? { ...e, input: undefined, output: null, truncated: undefined } : e));
	const g = grade(gold, nousage);
	assert.equal(g.metrics.usage.inputTokens, null);
	assert.equal(g.metrics.usage.outputTokens, null);
	assert.equal(g.metrics.usage.unknownTurns, 2);
	assert.equal(grade(gold, events).metrics.usage.outputTokens, 160);
});

test("grader: both outputs are derived from private seeds, not agent-provided expected values", () => {
	const c = buildCase({ caseId: "x", seed: 11 });
	assert.notEqual(c.gold.agents.A.jobSeed, c.gold.agents.B.jobSeed);
	assert.ok(!JSON.stringify(c.public).includes(c.gold.agents.A.jobSeed));
});

test("fixtures: no gold, role, kind or synthetic labels reach public data or prompts; 2 real + 10 synthetic uniform profiles", () => {
	const seen = new Set();
	for (const seed of [1, 2, 3, 4]) {
		const c = buildCase({ caseId: "x", seed, now: 0 });
		const blob = JSON.stringify(c.public) + agentPrompt(c, "A") + agentPrompt(c, "B");
		for (const l of ["A", "B"]) {
			assert.ok(!blob.includes(c.gold.agents[l].jobSeed) && !blob.includes(c.gold.agents[l].token));
		}
		assert.ok(!/synthetic|decoy|distractor|"kind"|real/i.test(JSON.stringify(c.public.profiles)));
		assert.equal(c.public.profiles.length, 9);
		const keys = new Set(c.public.profiles.map((p) => Object.keys(p).join() + Object.keys(p.context).join()));
		assert.equal(keys.size, 1);
		const rows = seedProfiles(c, { [c.gold.sessionTrap.ofLabel]: { agentId: "agt_real_peer" } });
		assert.equal(rows.length, 10);
		assert.equal(rows.filter((r) => r.agentId === "agt_real_peer").length, 1);
		assert.equal(new Set(rows.map((r) => Object.keys(r).join())).size, 1);
		assert.ok(rows.every((r) => r.context.modifiedFiles.length === 0));
		const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
		assert.ok(c.public.profiles.every((p) => UUID.test(p.agentId) && UUID.test(p.sessionKey)));
		assert.ok(UUID.test(c.gold.sessionTrap.sessionKey));
		assert.ok(!/stale|files you are editing/i.test(JSON.stringify(c.public) + agentPrompt(c, "A")));
		const trap = rows.find((r) => r.agentId === "agt_real_peer");
		assert.deepEqual(trap.context.resources, []);
		assert.match(trap.context.task, /retired|completed/);
		const gpuHosts = c.public.profiles.filter((p) => p.context.hostname === c.public.host && p.context.resources.length);
		assert.ok(gpuHosts.every((p) => /read-only/.test(p.context.task)));
		assert.ok(!agentPrompt(c, "A").includes(c.public.profiles[0].agentId));
		seen.add(c.gold.roles.initiator + c.public.profiles[0].agentId);
	}
	assert.equal(seen.size, 4);
});

test("fixtures: the prompt hash the grader enforces matches the prompt the runner renders", () => {
	const c = buildCase({ caseId: "x", seed: 9 });
	for (const l of ["A", "B"]) assert.equal(c.gold.promptSha256[l], sha(agentPrompt(c, l)));
});

test("fixtures: seeded determinism; ids permute across seeds", () => {
	const a = buildCase({ caseId: "x", seed: 5, now: 0 });
	assert.deepEqual(a, buildCase({ caseId: "x", seed: 5, now: 0 }));
	const d = buildCase({ caseId: "x", seed: 6, now: 0 });
	assert.notDeepEqual(a.public.profiles.map((x) => x.agentId), d.public.profiles.map((x) => x.agentId));
});

test("instrument records but never enforces; receipts are owner-bound", async () => {
	const c = buildCase({ caseId: "i", seed: 1, jobDurationMs: 200, rounds: 500 });
	const p = join(tmp(), "e.jsonl");
	writeFileSync(p, "");
	const inst = await startInstrument({ gold: c.gold, eventsPath: p });
	const call = (l, m, path) => fetch(`http://127.0.0.1:${inst.port}${path}`, { method: m, headers: { authorization: `Bearer ${c.gold.agents[l].token}` } });
	const r1 = await (await call("A", "POST", "/v1/jobs")).json();
	const r2 = await (await call("B", "POST", "/v1/jobs")).json();
	assert.equal((await call("B", "GET", `/v1/jobs/${r1.receipt}`)).status, 404);
	assert.equal((await fetch(`http://127.0.0.1:${inst.port}/v1/jobs`, { method: "POST" })).status, 401);
	assert.ok(r2.receipt);
	await inst.close();
	const lines = readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	const att = lines.filter((e) => e.type === "attempt");
	assert.equal(att.length, 2);
	assert.ok(att[1].seq > att[0].seq);
});

test("viewer binds loopback, rejects foreign Host, redacts secrets and hides gold fields", async () => {
	const dir = tmp();
	writeFileSync(join(dir, "events.jsonl"), JSON.stringify({ src: "pi", type: "x", jobSeed: "S", text: "Authorization: Bearer abcdefghijklmnop1234" }) + "\n");
	const v = await startViewer(dir);
	assert.match(v.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
	assert.equal(v.server.address().address, "127.0.0.1");
	const res = await fetch(v.url + "events");
	const reader = res.body.getReader();
	const { value } = await reader.read();
	const txt = new TextDecoder().decode(value);
	assert.ok(!txt.includes("abcdefghijklmnop1234") && !txt.includes('"jobSeed"'), txt);
	await reader.cancel();
	const bad = await new Promise((r) => import("node:http").then(({ get }) => get({ host: "127.0.0.1", port: v.server.address().port, headers: { host: "evil.example" } }, (x) => r(x.statusCode))));
	assert.equal(bad, 403);
	v.server.closeAllConnections();
	v.server.close();
});

test("grader: marker leak survives redaction; digest alone is not a secret", async () => {
	const { gold, events } = await oracleTrace();
	const foreign = gold.agents[gold.roles.responder].token;
	const idx = events.findIndex((e) => e.src === "pi" && e.agent === gold.roles.initiator && e.type === "tool_result");
	const marked = events.map((e, i) => (i === idx ? { ...e, agent: gold.roles.initiator, text: "[REDACTED]", leakMarkers: [{ kind: "token", of: gold.roles.responder }] } : e));
	const g = grade(gold, marked);
	assert.equal(g.checks.no_private_data_leak, false);
	assert.ok(!JSON.stringify(marked).includes(foreign));
	const own = events.map((e, i) => (i === idx ? { ...e, agent: gold.roles.initiator, leakMarkers: [{ kind: "token", of: gold.roles.initiator }] } : e));
	assert.equal(grade(gold, own).checks.no_private_data_leak, true);
	const digest = jobDigest(gold.agents[gold.roles.responder].jobSeed, gold.rounds);
	const withDigest = events.map((e, i) => (i === idx ? { ...e, agent: gold.roles.initiator, text: digest } : e));
	assert.equal(grade(gold, withDigest).checks.no_private_data_leak, true);
	const sc = makeLeakScanner(gold);
	assert.deepEqual(sc({ x: `a ${foreign} b` }), [{ kind: "token", of: gold.roles.responder }]);
});

test("grader: owner result_read is required for completion; admission refusal fails", async () => {
	const { gold, events } = await oracleTrace();
	const noReads = events.filter((e) => !(e.src === "instrument" && e.type === "result_read"));
	assert.equal(grade(gold, noReads).checks.both_jobs_correct_complete, false);
	const foreignRead = events.map((e) => (e.type === "result_read" ? { ...e, agent: e.agent === "A" ? "B" : "A" } : e));
	assert.equal(grade(gold, foreignRead).checks.both_jobs_correct_complete, false);
	let n = Math.max(...events.map((e) => e.observedSeq));
	const g = grade(gold, [...events, { src: "instrument", type: "admission_refused", agent: "A", reason: "runaway_attempt_limit", admittedLimit: 64, observedSeq: ++n }]);
	assert.equal(g.checks.no_attempt_admission_refused, false);
});

test("grader: wake needs first user input of the run, no prior activity, no prompt, matching backend id", async () => {
	const { gold, events } = await oracleTrace();
	const R = gold.roles.responder;
	const wakes = events.filter((e) => e.type === "user_input" && e.agent === R && e.wakeMessageId);
	assert.ok(wakes.length >= 2);
	const noId = events.map((e) => (e === wakes[0] ? { ...e, wakeMessageId: "m_other" } : e));
	assert.equal(grade(gold, noId).metrics.wake.unverified, true);
	const notFirst = events.map((e) => (e === wakes[0] ? { ...e, ordinal: 1 } : e));
	assert.notEqual(grade(gold, notFirst).metrics.wake.messageId, wakes[0].wakeMessageId);
	assert.equal(grade(gold, events).metrics.wake.daemonWakeEvent, false);
});

test("PiRpc: settled latch, leak scan on raw records before redaction, tool error flag", async () => {
	const { PiRpc } = await import("../runner/pi-rpc.mjs");
	const script = `process.stdin.on("data",d=>{for(const l of String(d).split("\\n").filter(Boolean)){const m=JSON.parse(l);if(m.type==="prompt"){console.log(JSON.stringify({type:"agent_start"}));console.log(JSON.stringify({type:"tool_execution_end",toolName:"x",isError:true,result:"token: SECRETTOKEN123456"}));console.log(JSON.stringify({type:"agent_settled"}));console.log(JSON.stringify({id:m.id,type:"response",success:true}))}else console.log(JSON.stringify({id:m.id,type:"response",success:true}))}})`;
	const got = [];
	const pi = new PiRpc({ label: "A", command: process.execPath, args: ["-e", script], onRecord: (r) => got.push(r), scan: (r) => (JSON.stringify(r).includes("SECRETTOKEN123456") ? [{ kind: "token", of: "B" }] : []) });
	const before = pi.settledCount;
	await pi.prompt("hi");
	await pi.waitSettled(500, before);
	const tr = got.find((r) => r.type === "tool_result");
	assert.equal(tr.error, true);
	assert.deepEqual(tr.leakMarkers, [{ kind: "token", of: "B" }]);
	assert.equal(JSON.stringify(redact(tr)).includes("SECRETTOKEN123456"), false);
	await pi.stop();
});

test("run-live lifecycle helpers: harness hash binds files, PID identity, stop file, prompt failure classes", async () => {
	const rl = await import("../runner/run-live.mjs");
	assert.equal(rl.harnessHash(), rl.harnessHash());
	const a = rl.procStart(process.pid);
	assert.ok(a);
	assert.equal(rl.ownedRunAlive({ pid: process.pid, pidStart: a }), true);
	assert.equal(rl.ownedRunAlive({ pid: process.pid, pidStart: `${a}0` }), false);
	assert.equal(rl.ownedRunAlive({ pid: 999999999, pidStart: a }), false);
	const d = tmp();
	assert.equal(rl.stopRequested(d, "r1"), false);
	rl.requestStop(d, "r1");
	assert.equal(rl.stopRequested(d, "r1"), true);
	assert.equal(rl.stopRequested(d, "other"), false);
	assert.equal(rl.classifyPromptFailure({ error: "401 unauthorized" }), "auth");
	assert.equal(rl.classifyPromptFailure({ error: "boom" }), "setup");
	assert.equal(rl.classifyPromptFailure({ error: "tool not registered" }), "tool_missing");
});

test("redact strips key-shaped values", () => {
	assert.equal(redact({ apiKey: "zzzzzzzzzz" }).apiKey, "[REDACTED]");
});
