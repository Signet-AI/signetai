import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { makeCollector } from "../lib/collector.mjs";
import { readJsonl } from "../lib/common.mjs";
import { buildCase } from "../lib/fixtures.mjs";
import { grade, makeLeakScanner, proxyEventToInfra } from "../lib/grader.mjs";
import { PiRpc } from "../runner/pi-rpc.mjs";
import { runControl } from "../runner/controls.mjs";
import { sourceFingerprint } from "../runner/run-live.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "gap-"));

async function oracle() {
	const dir = tmp();
	await runControl("oracle", dir, { durationMs: 300, rounds: 2000 });
	const gold = buildCase({ caseId: "control-oracle", seed: 7, jobDurationMs: 300, rounds: 2000 }).gold;
	return { gold, events: readJsonl(readFileSync(join(dir, "oracle", "events.jsonl"), "utf8")) };
}

test("collector file never holds opaque foreign seeds/tokens or registered capabilities; markers survive", () => {
	const gold = buildCase({ caseId: "x", seed: 3 }).gold;
	const [I, R] = [gold.roles.initiator, gold.roles.responder];
	const dir = tmp();
	const eventsPath = join(dir, "events.jsonl");
	writeFileSync(eventsPath, "");
	const c = makeCollector({ eventsPath });
	c.setScan(makeLeakScanner(gold));
	c.registerGold(gold);
	const adminToken = 'adm"in\u00e9\u2028tok\\1';
	c.register(adminToken);
	const seed = gold.agents[R].jobSeed;
	const tok = gold.agents[R].token;
	c.emit({
		src: "pi",
		type: "tool_result",
		agent: I,
		name: "bash",
		output: `plain words ${seed} and ${tok} then ${adminToken}`,
	});
	c.emit({
		src: "pi",
		type: "tool_result",
		agent: I,
		name: "bash",
		output: { nested: [`x${tok}y`], [`key_${seed}`]: 1 },
	});
	const raw = readFileSync(eventsPath, "utf8");
	for (const v of [seed, tok, adminToken, JSON.stringify(adminToken).slice(1, -1)])
		assert.equal(raw.includes(v), false, v);
	const evs = readJsonl(raw);
	assert.ok(evs.every((e) => e.leakMarkers.every((m) => Object.keys(m).sort().join() === "kind,of")));
	assert.ok(evs[0].leakMarkers.some((m) => m.kind === "seed" && m.of === R));
	assert.ok(evs[0].leakMarkers.some((m) => m.kind === "token" && m.of === R));
});

test("collector-persisted foreign seed in unlabelled text still fails the leak check", async () => {
	const { gold, events } = await oracle();
	const I = gold.roles.initiator;
	const dir = tmp();
	const eventsPath = join(dir, "e.jsonl");
	writeFileSync(eventsPath, "");
	const c = makeCollector({ eventsPath });
	c.setScan(makeLeakScanner(gold));
	c.registerGold(gold);
	let n = 0;
	for (const e of events) {
		const { observedSeq: _o, observedNs: _n, leakMarkers: _l, ...rest } = e;
		c.emit(rest);
		if (++n === 5)
			c.emit({
				src: "pi",
				type: "tool_result",
				agent: I,
				name: "bash",
				output: `${gold.agents[gold.roles.responder].jobSeed}`,
				error: false,
			});
	}
	const persisted = readJsonl(readFileSync(eventsPath, "utf8"));
	assert.equal(readFileSync(eventsPath, "utf8").includes(gold.agents[gold.roles.responder].jobSeed), false);
	assert.equal(grade(gold, persisted).checks.no_private_data_leak, false);
});

const piScript = (body) => `const out=(o)=>console.log(JSON.stringify(o));process.stdin.on("data",()=>{});${body}`;

test("PiRpc: cumulative updates are scanned raw then compacted; order, final message and ids kept; file stays small", async () => {
	const N = 400;
	const script = piScript(
		`out({type:"agent_start"});out({type:"message_start",message:{role:"assistant"}});let t="";for(let i=0;i<${N};i++){t+="word"+i+" ";if(i===200)t+=" LEAK_ME_0123456789 ";out({type:"message_update",message:{role:"assistant",content:[{type:"text",text:t}]},assistantMessageEvent:{type:"text_delta",contentIndex:0,delta:"word"+i,partial:{role:"assistant",content:[{type:"text",text:t}]}}})}out({type:"message_end",message:{role:"assistant",content:[{type:"text",text:t}],model:"m",responseModel:"glm-5.3-flash",usage:{input:1,output:2}}});out({type:"agent_settled"});setTimeout(()=>process.exit(0),50)`,
	);
	const dir = tmp();
	const eventsPath = join(dir, "e.jsonl");
	writeFileSync(eventsPath, "");
	const c = makeCollector({ eventsPath });
	c.register("LEAK_ME_0123456789");
	const scan = (r) => (JSON.stringify(r).includes("LEAK_ME_0123456789") ? [{ kind: "token", of: "B" }] : []);
	const pi = new PiRpc({
		label: "A",
		command: process.execPath,
		args: ["-e", script],
		onRecord: c.emit,
		scan,
		scrubText: c.scrubText,
	});
	await pi.exited;
	const evs = readJsonl(readFileSync(eventsPath, "utf8"));
	const updates = evs.filter((e) => e.type === "rpc_message_update");
	assert.equal(updates.length, N);
	assert.ok(updates.filter((e) => e.leakMarkers).length >= 1, "leak seen in raw partial before compaction");
	assert.equal(
		updates.some((e) => e.raw.assistantMessageEvent.partial || e.raw.message.content),
		false,
	);
	assert.equal(updates[5].raw.assistantMessageEvent.delta, "word5");
	const types = evs.map((e) => e.type);
	assert.ok(
		types.indexOf("rpc_message_start") < types.indexOf("rpc_message_update") &&
			types.lastIndexOf("rpc_message_update") < types.indexOf("rpc_message_end") &&
			types.indexOf("rpc_message_end") < types.indexOf("agent_settled"),
	);
	const end = evs.find((e) => e.type === "rpc_message_end");
	assert.ok(end.raw.message.content[0].text.includes("word399"));
	assert.equal(readFileSync(eventsPath, "utf8").includes("LEAK_ME_0123456789"), false);
	assert.ok(statSync(eventsPath).size < (400 * 1024) / 2, `file ${statSync(eventsPath).size}`);
	assert.equal(
		evs.some((e) => e.type === "partial_snapshot"),
		false,
	);
	assert.ok(evs.some((e) => e.type === "model" && e.served === "glm-5.3-flash"));
});

test("PiRpc: abnormal exit retains the last partial; oversize line fails the evaluation", async () => {
	const dir = tmp();
	const got = [];
	const s1 = piScript(
		`out({type:"agent_start"});out({type:"message_update",message:{role:"assistant",content:[{type:"text",text:"half an answ"}]},assistantMessageEvent:{type:"text_delta",delta:"x",partial:{}}});setTimeout(()=>process.exit(3),30)`,
	);
	const a = new PiRpc({ label: "A", command: process.execPath, args: ["-e", s1], onRecord: (r) => got.push(r) });
	await a.exited;
	const snap = got.find((r) => r.type === "partial_snapshot");
	assert.equal(snap.reason, "process_exit");
	assert.equal(snap.message.content[0].text, "half an answ");

	const rec = [];
	const s2 = piScript(`process.stdout.write("x".repeat(5000));setTimeout(()=>{},3000)`);
	const b = new PiRpc({
		label: "B",
		command: process.execPath,
		args: ["-e", s2],
		onRecord: (r) => rec.push(r),
		maxLineBytes: 1000,
	});
	await b.exited;
	const err = rec.find((r) => r.src === "infra" && r.class === "protocol");
	assert.ok(err);
	const { gold, events } = await oracle();
	const extra = { ...err, observedSeq: Math.max(...events.map((e) => e.observedSeq)) + 1 };
	const g = grade(gold, [...events, extra]);
	assert.equal(g.status, "unscorable");
	assert.equal(g.failureClass, "infra:protocol");
	writeFileSync(join(dir, "ok"), "");
});

test("grader: any wrong served id in servedModels[] (or later request) is a model mismatch", async () => {
	const { gold, events } = await oracle();
	let n = Math.max(...events.map((e) => e.observedSeq));
	const add = (x) =>
		grade(gold, [
			...events,
			{ src: "proxy", type: "request", agent: "A", status: 200, complete: true, ...x, observedSeq: ++n },
		]);
	assert.equal(
		add({ servedModel: gold.servedModel, servedModels: [gold.servedModel, "glm-4.5-air"] }).failureClass,
		"infra:served_model_mismatch",
	);
	assert.equal(add({ servedModel: gold.servedModel, servedModels: [gold.servedModel] }).pass, true);
	assert.equal(add({ servedModel: null, servedModels: ["other"] }).failureClass, "infra:served_model_mismatch");
});

test("proxy classes normalise: rate limit/auth/network/stream cut unscorable; local budget is a scored failure; usage unknown stays null", async () => {
	const { gold, events } = await oracle();
	let n = Math.max(...events.map((e) => e.observedSeq));
	const withEv = (e) => grade(gold, [...events, { ...e, observedSeq: ++n }]);
	for (const cls of ["provider_rate_limit", "auth", "network", "incomplete_stream", "client_disconnect", "provider"]) {
		const g = withEv({
			src: "proxy",
			type: "upstream_error",
			class: cls,
			agent: "A",
			status: cls === "provider_rate_limit" ? 429 : null,
		});
		assert.equal(g.failureClass, `infra:${cls}`, cls);
	}
	assert.equal(
		withEv({ src: "proxy", type: "upstream_error", class: "weird", agent: "A" }).failureClass,
		"infra:unclassified",
	);
	const m429 = proxyEventToInfra({ src: "proxy", type: "request", status: 429, class: "provider_rate_limit" });
	assert.deepEqual(m429.infra, { class: "provider_rate_limit", status: 429 });
	assert.equal(
		proxyEventToInfra({ src: "proxy", type: "request", status: 503, class: "provider" }).infra.class,
		"provider",
	);
	assert.equal(proxyEventToInfra({ src: "proxy", type: "request", status: 401, class: null }).infra.class, "auth");
	assert.equal(proxyEventToInfra({ src: "proxy", type: "request", status: 200, class: null }), null);
	const budget = proxyEventToInfra({ src: "proxy", type: "request", status: 504, class: "budget_exhausted" });
	assert.equal(budget.infra, undefined);
	const g = withEv({ src: "runner", type: "timeout", ...budget.timeout });
	assert.equal(g.status, "scored");
	assert.equal(g.checks.finished_within_budget, false);
	const u = withEv({
		src: "proxy",
		type: "request",
		agent: "A",
		status: 200,
		complete: false,
		usageStatus: "unknown",
		usage: null,
		parseError: true,
		servedModel: gold.servedModel,
	});
	assert.equal(u.metrics.proxyUsage.inputTokens, null);
	assert.ok(u.metrics.proxyUsage.unknown >= 1 && u.metrics.proxyUsage.incomplete === 1);
});

test("source fingerprint hashes git-visible tracked and untracked content, not results or gold", () => {
	const repo = tmp();
	const git = (...a) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe" });
	git("init", "-q");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	mkdirSync(join(repo, "evals/agent-coordination/lib"), { recursive: true });
	mkdirSync(join(repo, "evals/agent-coordination/results/_gold"), { recursive: true });
	writeFileSync(join(repo, "evals/agent-coordination/lib/a.mjs"), "1");
	git("add", ".");
	git("commit", "-qm", "x");
	const roots = ["evals/agent-coordination"];
	const base = sourceFingerprint(repo, roots);
	assert.equal(base.dirtyFiles, 0);
	writeFileSync(join(repo, "evals/agent-coordination/lib/new-metadata.ts"), "export {}");
	const withNew = sourceFingerprint(repo, roots);
	assert.notEqual(withNew.workingTreeSha256, base.workingTreeSha256);
	writeFileSync(join(repo, "evals/agent-coordination/lib/new-metadata.ts"), "export const x=1");
	assert.notEqual(sourceFingerprint(repo, roots).workingTreeSha256, withNew.workingTreeSha256);
	const stable = sourceFingerprint(repo, roots);
	assert.equal(sourceFingerprint(repo, roots).workingTreeSha256, stable.workingTreeSha256);
	writeFileSync(join(repo, "evals/agent-coordination/results/_gold/gold.json"), "secret");
	writeFileSync(join(repo, "evals/agent-coordination/results/x.jsonl"), "r");
	assert.equal(sourceFingerprint(repo, roots).workingTreeSha256, stable.workingTreeSha256);
	assert.deepEqual(stable.scope.roots, roots);
});

test("run-live ingests through the shared collector and closes the viewer via close()", () => {
	const src = readFileSync(new URL("../runner/run-live.mjs", import.meta.url), "utf8");
	assert.match(src, /makeCollector\(/);
	assert.match(src, /void viewer\.close\(\)/);
	assert.doesNotMatch(src, /JSON\.stringify\(redact\(ev\)\)/);
	assert.doesNotMatch(
		readFileSync(new URL("../runner/controls.mjs", import.meta.url), "utf8"),
		/scriptedUntilInstrumentEmits/,
	);
});
